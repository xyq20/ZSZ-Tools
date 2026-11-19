"""Continue this user's approved workbook after two successful real trials.

The scope is the fixed workbook snapshot and bound second shop. Completed
trial links are explicitly excluded; regular CLI write gates stay unchanged.
"""
import asyncio
import json
import time
from pathlib import Path

from .browser import TaobaoAdapter, parse_listing
from .engine import execute_run
from .errors import SessionError, UnsupportedItem
from .excel import load_workbook_targets, normalize_title
from .matching import match_item
from .report import write_reports
from .session import browser_session, load_shop_binding, run_lock
from .state import atomic_json

ROOT = Path(__file__).resolve().parent.parent
RUN_DIR = ROOT / 'output/full-sync-20261110'
SOURCE = ROOT / 'output/runs/20261110_161826/source.xlsx'
SHOP = {'name': '中古Remake商店', 'shop_id': '227180723'}
PRIOR_RUNS = {
    '1094642965827': 'output/yellow-correction-1094642965827-6150782793875',
    '1092634591638': 'output/second-link-trial-1092634591638',
}


class BatchAdapter(TaobaoAdapter):
    """Use the verified 'all' tab for one ID/title lookup across both states."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._request_generation = 0
        self._identity_proof = None

    async def _pace(self):
        await super()._pace()
        self._request_generation += 1

    async def verify_shop(self):
        # Coalesce only immediately adjacent identity checks: no intervening
        # platform request, no navigation, and less than one second old.
        # Reads/writes advance the generation, so proof never crosses a write.
        await self._session_check()
        proof = self._identity_proof
        if proof and proof['generation'] == self._request_generation and proof['url'] == self.page.url and time.monotonic() - proof['at'] <= 1:
            return dict(proof['shop'])
        shop = await super().verify_shop()
        self._identity_proof = dict(shop=dict(shop), generation=self._request_generation,
                                    url=self.page.url, at=time.monotonic())
        return shop

    async def _find_item(self, item_id):
        data = await self._table('all', item_id=str(item_id))
        rows = [r for r in data['table']['dataSource'] if str(r['itemId']) == str(item_id)]
        if len(rows) != 1:
            raise UnsupportedItem('商品 ID 在全部商品中不存在或不唯一')
        item = parse_listing(rows[0])
        self._actions[str(item_id)] = rows[0].get('operator_m', [])
        self._known_status[str(item_id)] = item['status']
        return item

    async def discover(self, source, run, save):
        found = {i['item_id']: i for i in run.get('lookup_items', [])}
        completed = set(run.get('lookup_completed', []))
        for index, product in enumerate(source['products'], 1):
            if product['normalized_title'] in completed:
                continue
            seen, total, current = set(), None, 1
            while True:
                data = await self._table('all', current, title=product['title'])
                pagination = data['pagination']
                if total is None:
                    total = int(pagination['total'])
                if int(pagination['total']) != total or int(pagination['current']) != current:
                    raise RuntimeError('商品标题查询分页发生变化，预览未完成')
                rows = data['table']['dataSource']
                for row in rows:
                    item = parse_listing(row)
                    if item['item_id'] in seen:
                        raise RuntimeError('商品标题查询出现重复 ID，预览未完成')
                    seen.add(item['item_id'])
                    if normalize_title(item['title']) == product['normalized_title']:
                        old = found.get(item['item_id'])
                        if old and old != item:
                            raise RuntimeError('读取期间商品身份或状态变化')
                        found[item['item_id']] = item
                if len(seen) == total:
                    break
                if not rows or len(seen) > total:
                    raise RuntimeError('商品标题查询结果不完整')
                current += 1
            completed.add(product['normalized_title'])
            run['lookup_completed'] = sorted(completed)
            run['lookup_items'] = list(found.values())
            save()
            print('查找 %d/%d：累计 %d 个链接' % (index, len(source['products']), len(found)), flush=True)
        return list(found.values())


def prior_results(source):
    prior = []
    by_title = {p['normalized_title']: p for p in source['products']}
    for item_id, relative in PRIOR_RUNS.items():
        path = ROOT / relative / 'state.json'
        old = json.loads(path.read_text(encoding='utf-8'))
        if old['shop'] != SHOP or old['source_sha256'] != source['source_sha256'] or old.get('rules_version') != source['rules_version']:
            raise ValueError('此前试写记录与本次店铺、文件或规则不一致')
        matching = [i for i in old['items'] if i['item_id'] == item_id]
        if len(matching) != 1:
            raise ValueError('此前试写记录的商品 ID 不唯一')
        item = matching[0]
        if item.get('result') != 'listed' or not item.get('relisting_verified_at'):
            raise ValueError('此前试写尚未完成，不能自动排除')
        targets = {s['code']: s['target'] for s in by_title[normalize_title(item['title'])]['skus']}
        if any(targets.get(s['code']) != s['target'] for s in item['latest_skus']):
            raise ValueError('此前完成链接与最新库存目标不一致')
        prior.append(dict(item_id=item_id, title=item['title'], source_run=str(path.parent),
                          sku_count=len(item['latest_skus']), verified_at=item['relisting_verified_at']))
    return prior


def save_reports(run):
    write_reports(RUN_DIR, run)
    from .summary_report import write_summary
    write_summary(RUN_DIR, run)


async def run_batch():
    source = load_workbook_targets(SOURCE)
    if source['product_count'] != 111 or source['sku_count'] != 1686 or source['rules_version'] != 'q-yellow-zero-v1':
        raise ValueError('源文件范围或黄色规则发生变化，未启动批量')
    previous = prior_results(source)
    with run_lock(ROOT):
        if load_shop_binding(ROOT) != SHOP:
            raise ValueError('当前绑定店铺不符')
        RUN_DIR.mkdir(parents=True, exist_ok=True)
        progress_file = RUN_DIR / 'preview-progress.json'
        if progress_file.exists():
            run = json.loads(progress_file.read_text(encoding='utf-8'))
            if run['shop'] != SHOP or run['source_sha256'] != source['source_sha256'] or run.get('rules_version') != source['rules_version']:
                raise ValueError('恢复时文件或规则版本变化')
        else:
            run = dict(source, shop=SHOP, phase='previewing', status='preview', items=[],
                       previous_completed=previous, lookup_items=[], lookup_completed=[], unmatched_products=[],
                       pilot_item_id='1092634591638', pilot_verified=True,
                       authorization='用户确认两个链接测试无误后，授权继续其余全部商品并生成简洁报告')
        def save():
            atomic_json(progress_file, run)
            save_reports(run)
        async with browser_session(ROOT) as page:
            adapter = BatchAdapter(page, SHOP, request_interval=3)
            await adapter.verify_shop()
            try:
                if run['phase'] != 'preview_ready':
                    run['status'] = 'preview'
                    run.pop('pause_reason', None)
                    save()
                    listing = await adapter.discover(source, run, save)
                    by_title = {p['normalized_title']: p for p in source['products']}
                    seen_titles = {normalize_title(i['title']) for i in listing}
                    run['unmatched_products'] = [p['title'] for p in source['products'] if p['normalized_title'] not in seen_titles]
                    excluded = {p['item_id'] for p in previous}
                    candidates = [i for i in listing if i['item_id'] not in excluded]
                    done = {i['item_id'] for i in run['items']}
                    for index, item in enumerate(candidates, 1):
                        if item['item_id'] in done:
                            continue
                        print('SKU 预览 %d/%d：%s' % (index, len(candidates), item['item_id']), flush=True)
                        product = by_title[normalize_title(item['title'])]
                        try:
                            raw = await adapter.read_item(item['item_id'], known_item=item)
                            result = match_item(product, raw)
                        except SessionError:
                            raise
                        except Exception as error:
                            reason = str(error) if isinstance(error, UnsupportedItem) else type(error).__name__
                            result = dict(item, skus=[], eligible=False, reason='读取未通过：' + reason, source_title=product['title'])
                        run['items'].append(result)
                        save()
                    run['phase'] = 'preview_ready'
                    save()
                    atomic_json(RUN_DIR / 'preview.json', run)
                eligible = [i for i in run['items'] if i.get('eligible')]
                excluded = set(PRIOR_RUNS)
                allowed = {i['item_id'] for i in eligible}
                if allowed & excluded or len({i['item_id'] for i in run['items']}) != len(run['items']):
                    raise ValueError('批量范围存在重复或包含此前完成链接')
                adapter.write_scope = frozenset(allowed)
                adapter.sku_write_scope = frozenset(s['sku_id'] for i in eligible for s in i['skus'])
                result = await execute_run(adapter, run, RUN_DIR, resume=(RUN_DIR / 'state.json').exists(),
                                           skip_global_preflight=True, coalesce_relist_read=True)
                save_reports(result)
                return 0 if result.get('status') == 'completed' else 2
            except SessionError:
                run['status'] = 'paused'
                run['pause_reason'] = '需要重新登录或人工验证，进度已保存；禁止自动重试写请求。'
                save()
                raise


if __name__ == '__main__':
    try:
        raise SystemExit(asyncio.run(run_batch()))
    except SessionError as error:
        print('已暂停：' + str(error), flush=True)
        raise SystemExit(2)
