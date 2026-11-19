"""Adapters for endpoints observed in the logged-in 千牛 web application.

Reads and explicitly scoped trial writes use HTTP/MTOP. Playwright only hosts
the login session. Write operations are disabled by default until validated.
No cookies, signatures, CSRF tokens or raw response headers are logged.
"""
import asyncio
import re
import time
import json
from urllib.parse import urlencode, urlparse, parse_qs

from .errors import LoginRequired, ShopMismatch, VerificationRequired, SessionError, UnsupportedItem, WriteNotValidated

SHOP_NAME = '中古Remake商店'
HOME = 'https://myseller.taobao.com/home.htm/SellManage/'
INV_ORIGIN = 'https://inventorymanage.taobao.com'
RENDER = '/seller/inventory/editormanager/v2/unify/unifyRender'
QUANTITY = '/seller/inventory/frontWithPlan/v2/editormanager/querySkuQuantity'
COMMIT = '/seller/inventory/editormanager/v2/unify/unifyCommit'


def listing_request_identity(request):
    """Inspect only the business payload, never headers/signatures/tokens."""
    values = parse_qs(urlparse(request.url).query)
    if request.post_data:
        posted = parse_qs(request.post_data)
        if posted.get('data'):
            values['data'] = posted['data']
    if not values.get('data'):
        return None
    try:
        envelope = json.loads(values['data'][0])
        path = envelope.get('url', '')
        if '/taobao/manager/fastEdit.htm?' not in path:
            return None
        operation = parse_qs(urlparse(path).query).get('optType', [None])[0]
        if operation not in ('upShelf', 'downShelf'):
            return None
        body = json.loads(envelope.get('jsonBody', '{}'))
        return path, str(body.get('itemId') or ''), set(body)
    except (TypeError, ValueError, AttributeError):
        return ('invalid', '', set())


class ListingOnceGuard:
    def __init__(self, path, item_id):
        self.path, self.item_id = path, str(item_id)
        self.sent = 0
        self.blocked = 0

    async def handle(self, route):
        identity = listing_request_identity(route.request)
        if identity is None:
            await route.continue_()
        elif identity == (self.path, self.item_id, {'itemId'}) and self.sent == 0:
            self.sent += 1
            await route.continue_()
        else:
            self.blocked += 1
            await route.abort('blockedbyclient')


def inventory_url(item_id):
    return INV_ORIGIN + '/qn/inventory/editInventory?' + urlencode(dict(
        hideHeader='5', hasDrawerHeader='true', title='编辑库存',
        **{'from': 'taobao-sellManage-edit'}, showChangeInvMode='false', itemId=item_id))


def parse_listing(row):
    desc = row['itemDesc']['desc']
    title = next(x['text'] for x in desc if x.get('uiType') == 'link')
    codes = [x['text'].strip()[3:] for x in desc if x.get('text', '').strip().startswith('编码:')]
    status_text = row['upShelfDate_m']['status']['text']
    status = {'出售中': 'on_sale', '仓库中': 'in_stock'}.get(status_text)
    if status is None:
        raise UnsupportedItem('非出售中/仓库中状态：' + str(status_text))
    return dict(item_id=str(row['itemId']), title=title, main_code=codes[0] if codes else '', status=status)


def parse_inventory(item, render, quantity):
    info = next(x for x in render if x.get('uiType') == 'itemInfo')
    table = next(x for x in render if x.get('uiType') == 'skuQuantityTable')
    reasons = []
    if str(info.get('itemId')) != item['item_id'] or info.get('itemTitle') != item['title']:
        reasons.append('库存返回商品 ID 或标题与列表不一致')
    if info.get('invMode') != '普通商品库存' or info.get('templateId'):
        reasons.append('非普通商品库存模式')
    if not table.get('canSpotEdit'):
        reasons.append('现货库存不可编辑')
    if not isinstance(quantity, list) or not quantity:
        raise UnsupportedItem('库存接口未返回完整 SKU 列表')
    skus = []
    for row in quantity:
        sku = row.get('skuInfo', {})
        batches = row.get('quantityList') or []
        if str(sku.get('itemId')) != item['item_id']:
            reasons.append('SKU 所属商品 ID 不一致')
        if row.get('disabled') or len(batches) != 1:
            reasons.append('含不可编辑 SKU 或多批次库存')
        for batch in batches:
            if batch.get('invType') != 'spot' or any(batch.get(k) is not None for k in ('planInstanceId', 'batchId', 'bizOrderId')):
                reasons.append('含预售或特殊批次库存')
        q = sku.get('totalQuantity')
        if isinstance(q, bool) or not isinstance(q, int) or q < 0:
            raise UnsupportedItem('当前 SKU 库存不是非负整数')
        if len(batches) == 1 and batches[0].get('sellableQuantity') != q:
            reasons.append('SKU 总量与可售库存不一致')
        skus.append(dict(sku_id=str(sku.get('skuId') or ''), code=sku.get('serialNumber') or '', quantity=q))
    if sum(s['quantity'] for s in skus) != info.get('totalQuantity'):
        reasons.append('商品总库存与 SKU 合计不一致，需要重新读取')
    return dict(item, skus=skus, supported=not reasons, unsupported_reason='；'.join(dict.fromkeys(reasons)))


class TaobaoAdapter:
    def __init__(self, page, binding=None, *, write_scope=None, sku_write_scope=None, request_interval=1.2):
        self.page = page
        self.binding = binding
        self.inventory_page = None
        self._last_request_at = 0.0
        self._known_status = {}
        self._actions = {}
        self.write_scope = frozenset(str(i) for i in (write_scope or ()))
        self.sku_write_scope = None if sku_write_scope is None else frozenset(str(i) for i in sku_write_scope)
        self.request_interval = max(1.2, float(request_interval))
        self.page.set_default_timeout(15000)

    async def _pace(self):
        await asyncio.sleep(max(0, self.request_interval - (time.monotonic() - self._last_request_at)))
        self._last_request_at = time.monotonic()

    async def _session_check(self, page=None):
        page = page or self.page
        host = urlparse(page.url).hostname or ''
        if 'login' in host or 'passport' in host:
            raise LoginRequired('登录已失效，请在专用 Chrome 重新登录二店。')
        # Do not classify explanatory text mentioning validation as a CAPTCHA.
        for selector in ('#nc_1_wrapper', '#baxia-dialog-content', 'iframe[src*="punish"]'):
            if await page.locator(selector).count() and await page.locator(selector).first.is_visible():
                raise VerificationRequired('页面需要人工验证，请在浏览器处理后恢复。')

    async def _mtop(self, api, data):
        await self._session_check()
        await self._pace()
        try:
            await self.page.wait_for_function('typeof window.lib?.mtop?.request === "function"', timeout=10000)
            response = await self.page.evaluate('''async ({api,data}) => {
                try { const r=await window.lib.mtop.request({api,v:'1.0',data,type:'POST',dataType:'json',timeout:15000});
                    return {ret:r.ret,data:r.data};
                } catch(e) {return {ret:e.ret || ['REQUEST_FAILED'],data:null};}
            }''', dict(api=api, data=data))
        except Exception:
            await self._session_check()
            raise RuntimeError('商品接口响应无法确认，需要回读实际状态。') from None
        ret = ' '.join(response.get('ret') or [])
        if any(x in ret for x in ('SESSION_EXPIRED', 'ILLEGAL_ACCESS', 'LOGIN')):
            raise LoginRequired('商品接口要求重新登录。')
        if any(x in ret for x in ('RGV', 'CAPTCHA', 'USER_VALIDATE', 'FLOOD')):
            raise VerificationRequired('商品接口要求人工验证或限流，已暂停。')
        if not ret.startswith('SUCCESS'):
            raise RuntimeError('商品查询失败（已隐藏敏感请求参数）。')
        return response['data']

    async def verify_shop(self):
        data = await self._mtop('mtop.taobao.jdy.resource.shop.info.get', {})
        result = data['result']
        shop = dict(name=result.get('shopName'), shop_id=str(result.get('shopId') or ''))
        if shop['name'] != SHOP_NAME or not shop['shop_id'].isdigit():
            raise ShopMismatch('当前不是目标店铺“中古Remake商店”，已停止。')
        if self.binding and (shop['name'] != self.binding['name'] or shop['shop_id'] != str(self.binding['shop_id'])):
            raise ShopMismatch('店铺 ID 与首次绑定不一致，已停止。')
        return shop

    async def _table(self, tab, current=1, item_id=None, title=None):
        import json
        filters = {'queryItemId': str(item_id)} if item_id else {}
        if title is not None:
            filters['queryTitle'] = title
        body = dict(tab=tab, pagination=dict(current=current, pageSize=20), filtertab='', filter=filters, table={})
        for attempt in range(3):
            try:
                data = await self._mtop('mtop.taobao.sell.pc.manage.async',
                    dict(url='/taobao/manager/table.htm', jsonBody=json.dumps(body, ensure_ascii=False)))
                result = json.loads(data['result'])
                if not result.get('success'):
                    raise RuntimeError('商品列表查询未成功')
                await asyncio.sleep(.2)
                return result['data']
            except SessionError:
                raise
            except Exception:
                if attempt == 2:
                    raise RuntimeError('商品列表连续三次查询失败') from None
                await asyncio.sleep(1 + attempt)

    async def list_items(self, products=None, checkpoint=None, progress=None):
        await self.verify_shop()
        if products is not None:
            return await self._list_by_titles(products, checkpoint, progress)
        items, seen = [], set()
        for tab in ('on_sale', 'in_stock'):
            current, expected, collected = 1, None, 0
            while True:
                data = await self._table(tab, current)
                pagination = data['pagination']
                if expected is None:
                    expected = int(pagination['total'])
                if int(pagination['current']) != current or int(pagination['total']) != expected:
                    raise RuntimeError('扫描中商品数量或分页发生变化，请重新预览。')
                rows = data['table']['dataSource']
                for row in rows:
                    item = parse_listing(row)
                    if item['item_id'] in seen or item['status'] != tab:
                        raise RuntimeError('商品分页出现重复或状态变化：%s 第%d页 ID=%s 状态=%s 重复=%s，请重新预览。' %
                                           (tab, current, item['item_id'], item['status'], item['item_id'] in seen))
                    items.append(item)
                    seen.add(item['item_id'])
                collected += len(rows)
                print('读取%s商品：%d/%d' % ('出售中' if tab == 'on_sale' else '仓库中', collected, expected), flush=True)
                if collected == expected:
                    break
                if not rows or collected > expected:
                    raise RuntimeError('商品分页不完整，禁止执行。')
                current += 1
        return items

    async def _list_by_titles(self, products, checkpoint=None, progress=None):
        # The full warehouse list has unstable ordering among equal timestamps.
        # Query each requested title instead; still exhaust and validate every
        # result page, then retain only exact normalized title matches.
        from .matching import normalize_title
        if checkpoint is None:
            checkpoint = {}
        result = {i['item_id']: i for i in checkpoint.get('lookup_items', [])}
        completed = set(checkpoint.get('lookup_completed', []))
        for index, product in enumerate(products, 1):
            if product['normalized_title'] in completed:
                continue
            for tab in ('on_sale', 'in_stock'):
                seen, total, current = set(), None, 1
                while True:
                    data = await self._table(tab, current, title=product['title'])
                    pagination = data['pagination']
                    if total is None:
                        total = int(pagination['total'])
                    if total != int(pagination['total']) or int(pagination['current']) != current:
                        raise RuntimeError('标题查询分页发生变化，预览未完成')
                    rows = data['table']['dataSource']
                    for row in rows:
                        item = parse_listing(row)
                        if item['item_id'] in seen or item['status'] != tab:
                            raise RuntimeError('标题查询出现重复或状态变化，预览未完成')
                        seen.add(item['item_id'])
                        if normalize_title(item['title']) == product['normalized_title']:
                            previous = result.get(item['item_id'])
                            if previous and previous != item:
                                raise RuntimeError('查询期间商品身份或状态发生变化')
                            result[item['item_id']] = item
                    if len(seen) == total:
                        break
                    if not rows or len(seen) > total:
                        raise RuntimeError('标题查询分页不完整')
                    current += 1
            print('按标题查找：%d/%d，累计 %d 个链接' % (index, len(products), len(result)), flush=True)
            completed.add(product['normalized_title'])
            checkpoint['lookup_items'] = list(result.values())
            checkpoint['lookup_completed'] = sorted(completed)
            if progress:
                progress()
        return list(result.values())

    async def _find_item(self, item_id):
        order = ['on_sale', 'in_stock']
        if self._known_status.get(str(item_id)) == 'in_stock':
            order.reverse()
        for tab in order:
            data = await self._table(tab, item_id=item_id)
            rows = data['table']['dataSource']
            matches = [r for r in rows if str(r['itemId']) == str(item_id)]
            if len(matches) == 1:
                item = parse_listing(matches[0])
                self._actions[str(item_id)] = matches[0].get('operator_m', [])
                self._known_status[str(item_id)] = item['status']
                return item
            if len(matches) > 1:
                raise RuntimeError('商品 ID 查询不唯一')
        raise UnsupportedItem('商品不在出售中或仓库中，或账号无权限')

    async def _inventory_context(self, item_id):
        if self.inventory_page is None or self.inventory_page.is_closed():
            self.inventory_page = await self.page.context.new_page()
            self.inventory_page.set_default_timeout(15000)
            await self.inventory_page.goto(inventory_url(item_id), wait_until='domcontentloaded')
            await self.inventory_page.locator('.sku-id').first.wait_for(timeout=20000)
        await self._session_check(self.inventory_page)
        return self.inventory_page

    async def _inventory_get(self, path, params, item_id):
        page = await self._inventory_context(item_id)
        for attempt in range(3):
            try:
                await self._pace()
                result = await page.evaluate('''async ({path,params}) => {
                    const r=await fetch(path+'?'+new URLSearchParams(params),{credentials:'include',cache:'no-store'});
                    const text=await r.text();
                    try {return {status:r.status,body:JSON.parse(text)};}
                    catch {return {status:r.status,body:null};}
                }''', dict(path=path, params=params))
                if result['status'] in (401, 403) or result['body'] is None:
                    raise LoginRequired('库存查询登录失效或需要验证。')
                body = result['body']
                if not body.get('success'):
                    raise RuntimeError('库存查询失败')
                return body['data']
            except SessionError:
                raise
            except Exception:
                if attempt == 2:
                    raise RuntimeError('库存连续三次查询失败') from None
                await asyncio.sleep(1 + attempt)

    async def read_item(self, item_id, known_item=None):
        await self.verify_shop()
        item = known_item or await self._find_item(str(item_id))
        self._known_status[str(item_id)] = item['status']
        render = await self._inventory_get(RENDER, dict(itemId=item_id, hideHeader='5', showChangeInvMode='false',
                                                       **{'from': 'taobao-sellManage-edit'}), item_id)
        quantity = await self._inventory_get(QUANTITY, dict(itemId=item_id, templateId='', **{'from': 'taobao-sellManage-edit'}), item_id)
        return parse_inventory(item, render, quantity)

    def _assert_write_scope(self, item_id):
        if str(item_id) not in self.write_scope:
            raise WriteNotValidated('写接口尚未通过真实验证，默认禁止下架、改库存和上架。')

    async def set_listing(self, item_id, on_sale):
        import json
        self._assert_write_scope(item_id)
        await self.verify_shop()
        item = await self._find_item(item_id)
        if item['status'] == ('on_sale' if on_sale else 'in_stock'):
            return
        action_name = 'upShelfAsync' if on_sale else 'downShelfAsync'
        actions = [a for a in self._actions.get(str(item_id), []) if a.get('name') == action_name]
        if len(actions) != 1 or actions[0].get('uiType') != 'async':
            raise UnsupportedItem('当前商品未提供经过核对的上下架接口')
        config = actions[0].get('async', {})
        expected = '/taobao/manager/fastEdit.htm?optType=' + ('upShelf' if on_sale else 'downShelf') + '&action=submit'
        if config.get('url') != expected or config.get('method', '').lower() != 'post' or config.get('params'):
            raise UnsupportedItem('上下架接口结构变化，拒绝发送')
        # Actual single-item React tableParams and client request wrapper were
        # inspected. This call is never retried; the engine reads state after it.
        guard = ListingOnceGuard(expected, item_id)
        pattern = '**/h5/mtop.taobao.sell.pc.manage.async/**'
        await self.page.route(pattern, guard.handle)
        try:
            data = await self._mtop('mtop.taobao.sell.pc.manage.async', dict(
                url=expected, jsonBody=json.dumps({'itemId': str(item_id)}, separators=(',', ':'))))
        finally:
            await self.page.unroute(pattern, guard.handle)
        result = json.loads(data['result'])
        if result.get('success') is not True:
            raise UnsupportedItem('平台未确认上下架成功，须回读状态；不会重复发送')

    async def prepare_inventory_request(self, item_id, adjustments):
        from .api_payload import build_inventory_request
        render = await self._inventory_get(RENDER, dict(itemId=item_id, hideHeader='5', showChangeInvMode='false',
                                                       **{'from': 'taobao-sellManage-edit'}), item_id)
        quantity = await self._inventory_get(QUANTITY, dict(itemId=item_id, templateId='', **{'from': 'taobao-sellManage-edit'}), item_id)
        return build_inventory_request(render, quantity, str(item_id), adjustments)

    async def set_inventory(self, item_id, adjustments):
        self._assert_write_scope(item_id)
        if self.sku_write_scope is not None and any(str(a.get('sku_id')) not in self.sku_write_scope for a in adjustments):
            raise UnsupportedItem('库存差值包含本次修正范围之外的 SKU，未提交')
        await self.verify_shop()
        if (await self._find_item(item_id))['status'] != 'in_stock':
            raise UnsupportedItem('商品尚未确认下架，禁止修改库存')
        request = await self.prepare_inventory_request(item_id, adjustments)
        page = await self._inventory_context(item_id)
        await self._session_check(page)
        await self.verify_shop()
        await self._pace()
        # The website's own CSRF object is read in browser memory only; it never
        # crosses into Python, local reports or the console.
        result = await page.evaluate("""async ({url,body}) => {
            const csrf=window.csrfToken;
            if (!csrf || !csrf.tokenName || !csrf.tokenValue) return {csrfMissing:true};
            const headers={'Content-Type':'application/json',[csrf.tokenName]:csrf.tokenValue};
            const r=await fetch(url,{method:'POST',credentials:'include',headers,body:JSON.stringify(body)});
            let data;try{data=await r.json();}catch{return {unknown:true,status:r.status};}
            return {status:r.status,success:data.success===true};
        }""", request)
        if result.get('csrfMissing'):
            raise UnsupportedItem('页面 CSRF 保护信息尚未就绪，未提交库存')
        if result.get('status') in (401, 403):
            raise LoginRequired('库存提交需要重新登录或验证；恢复前须回读库存')
        if result.get('success') is not True:
            raise UnsupportedItem('库存接口未确认成功，须回读实际库存；不会重复发送')
