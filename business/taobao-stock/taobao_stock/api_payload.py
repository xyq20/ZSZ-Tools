"""Pure inventory request construction from observed frontend v0.0.65.

Evidence: inventory-manage/0.0.65/js/main.js, SubmitFooter FRONT branch,
SkuQuantityTable reducer, and the observed ordinary-stock unifyRender response.
This is static contract validation, NOT evidence of a successful live commit.
No request is sent here, and no cookie or CSRF value is read or returned.
"""

from copy import deepcopy
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from .errors import UnsupportedItem


COMMIT_PATH = '/seller/inventory/editormanager/v2/unify/unifyCommit'
BATCH_FIELDS = (
    'deliveryTime', 'deliveryType', 'invType', 'adjustQuantity',
    'hasAdjustDeliveryTime', 'planInstanceId', 'sellableQuantity',
    'withholdingQuantity', 'bizOrderId', 'batchId',
)
MAX_QUANTITY = 2147483647  # Same bound as the observed frontend.


def _reject(message):
    raise UnsupportedItem(message)


def _integer(value, field, minimum=0):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= MAX_QUANTITY:
        _reject('%s 不是允许范围内的整数' % field)
    return value


def _single(render, kind):
    blocks = [block for block in render if isinstance(block, dict) and block.get('uiType') == kind]
    if len(blocks) != 1:
        _reject('库存渲染块 %s 缺失或不唯一' % kind)
    return blocks[0]


def _identity(value, field):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        _reject('%s 缺失或无效' % field)
    value = str(value)
    if not value.isascii() or not value.isdigit() or int(value) <= 0:
        _reject('%s 缺失或无效' % field)
    return value


def _commit_url(url, item_id):
    if not isinstance(url, str):
        _reject('缺少页面返回的库存提交地址')
    parsed = urlparse(url)
    if (parsed.scheme != 'https' or parsed.netloc != 'inventorymanage.taobao.com'
            or parsed.path != COMMIT_PATH or parsed.fragment):
        _reject('库存提交地址不是已观察到的目标接口')
    query = parse_qs(parsed.query, keep_blank_values=True)
    expected = {'displayTab': ['single'], 'itemId': [item_id], 'from': ['taobao-sellManage-edit']}
    if query != expected:
        _reject('库存提交地址的商品 ID 或模式不符')
    return url


def _initial_adjustment(batch):
    """Preserve untouched frontend fields, but disallow a latent adjustment."""
    if 'adjustQuantity' not in batch or batch['adjustQuantity'] is None:
        return
    adjustment = batch['adjustQuantity']
    if not isinstance(adjustment, dict):
        _reject('读取到未知的库存调整字段')
    # UI SubmitFooter converts this value with Number(). Empty/null become zero.
    raw = adjustment.get('operateQuantity')
    if raw not in (None, '', 0, '0') or isinstance(raw, bool):
        _reject('读取到非零的初始库存调整量，拒绝重复提交')
    adjustment['operateQuantity'] = 0
    direction = adjustment.get('adjustType')
    if direction is not None and (not isinstance(direction, dict)
                                  or direction.get('value') not in ('add', 'minus')):
        _reject('读取到未知的库存增减方向')


def build_inventory_request(render, quantity, item_id, adjustments):
    """Build {url, body} only for the observed ordinary single-batch mode.

    ``adjustments`` contains exact SKU ID/code/current/target/delta records from
    a fresh read. Returned body contains every SKU, including unchanged rows.
    The caller must verify shop + warehouse state, persist intent, send once,
    and read back. A new UUID is not permission to retry an ambiguous commit.
    """
    item_id = _identity(item_id, '商品 ID')
    if not isinstance(render, list) or not isinstance(quantity, list) or not quantity:
        _reject('渲染或库存快照不完整')
    if not isinstance(adjustments, list) or not adjustments:
        _reject('没有需要提交的库存差值')
    info = _single(render, 'itemInfo')
    params = _single(render, 'params')
    footer = _single(render, 'footer')
    table = _single(render, 'skuQuantityTable')
    if (_identity(info.get('itemId'), '渲染商品 ID') != item_id
            or info.get('invMode') != '普通商品库存' or info.get('templateId')):
        _reject('商品 ID 不符或不是已支持的普通库存')
    if params.get('displayTab') != 'single' or params.get('showTip'):
        _reject('库存模式变化或页面要求额外确认')
    if table.get('canSpotEdit') is not True:
        _reject('现货库存不可编辑')
    adjustment_columns = [column for column in table.get('columns', [])
                          if isinstance(column, dict) and column.get('uiType') == 'adjustQuantity']
    if len(adjustment_columns) != 1 or adjustment_columns[0].get('disabled'):
        _reject('库存增减权限配置缺失、不唯一或已禁用')
    direction_permissions = adjustment_columns[0].get('adjustTypeList')
    if not isinstance(direction_permissions, list):
        _reject('未读取到库存增减权限，拒绝绕过平台限制')
    if footer.get('needAppendOrderCheck') is not False or footer.get('autoRestockDialogText'):
        _reject('库存提交需要额外确认，不能自动调用')
    footer_value = footer.get('value')
    if (not isinstance(footer_value, dict) or set(footer_value) != {'shelfStatus'}
            or isinstance(footer_value['shelfStatus'], bool) or footer_value['shelfStatus'] != 1):
        _reject('提交配置不是“默认提交后不更改上架状态”')
    url = _commit_url(footer.get('submitUrl'), item_id)

    by_id = {}
    seen_codes = set()
    old_total = 0
    for row in quantity:
        if not isinstance(row, dict) or row.get('disabled'):
            _reject('SKU 行无效或不可编辑')
        sku = row.get('skuInfo')
        if not isinstance(sku, dict) or _identity(sku.get('itemId'), 'SKU 所属商品 ID') != item_id:
            _reject('SKU 所属商品不符')
        sku_id = _identity(sku.get('skuId'), 'SKU ID')
        code = sku.get('serialNumber')
        if not isinstance(code, str) or not code.strip() or code in seen_codes or sku_id in by_id:
            _reject('SKU 编码或 ID 缺失、重复')
        q = _integer(sku.get('totalQuantity'), 'SKU 当前库存')
        batches = row.get('quantityList')
        if not isinstance(batches, list) or len(batches) != 1 or not isinstance(batches[0], dict):
            _reject('仅支持每个 SKU 一个现货批次')
        batch = batches[0]
        if (batch.get('invType') != 'spot' or batch.get('isNew') or batch.get('disabled')
                or any(batch.get(key) is not None for key in ('planInstanceId', 'batchId', 'bizOrderId'))
                or row.get('deleteQuantityList')):
            _reject('不支持预售、特殊批次、新增或删除库存批次')
        if _integer(batch.get('sellableQuantity'), '批次可售库存') != q:
            _reject('SKU 总库存与现货可售库存不一致')
        if batch.get('deliveryTime') in (None, '', '0', 0, False):
            _reject('当前批次缺少有效发货时间')
        if 'withholdingQuantity' in batch:
            _integer(batch['withholdingQuantity'], '预扣库存')
        by_id[sku_id] = row
        seen_codes.add(code)
        old_total += q
    if _integer(info.get('totalQuantity'), '商品当前库存') != old_total:
        _reject('商品总库存与所有 SKU 合计不一致')

    targets = {}
    for adjustment in adjustments:
        if not isinstance(adjustment, dict):
            _reject('库存差值记录无效')
        sku_id = _identity(adjustment.get('sku_id'), '调整 SKU ID')
        if sku_id in targets or sku_id not in by_id:
            _reject('调整 SKU ID 重复或不在完整快照中')
        row = by_id[sku_id]
        sku = row['skuInfo']
        current = _integer(adjustment.get('current'), '调整前库存')
        target = _integer(adjustment.get('target'), '目标库存')
        delta = adjustment.get('delta')
        if isinstance(delta, bool) or not isinstance(delta, int) or delta != target - current:
            _reject('库存差值与当前量、目标量不一致')
        if sku['serialNumber'] != adjustment.get('code') or sku['totalQuantity'] != current:
            _reject('SKU 编码或库存已变化，需重新读取计算')
        if delta == 0:
            _reject('提交差值中包含无需修改的 SKU')
        direction = 'add' if delta > 0 else 'minus'
        permissions = [entry for entry in direction_permissions
                       if isinstance(entry, dict) and entry.get('value') == direction]
        if len(permissions) != 1 or permissions[0].get('disabled') is not False:
            _reject('平台未明确允许%s库存，拒绝提交' % ('增加' if delta > 0 else '减少'))
        batch = row['quantityList'][0]
        # Respect any per-batch limits in addition to the global integer bound.
        for key in ('adjustMin', 'adjustMax'):
            limit = batch.get(key)
            if limit is not None:
                if isinstance(limit, bool) or not isinstance(limit, int):
                    _reject('批次库存调整上下限未知')
                if (key == 'adjustMin' and delta < limit) or (key == 'adjustMax' and delta > limit):
                    _reject('库存差值超出该批次允许的调整范围')
        targets[sku_id] = adjustment

    values = []
    for original in quantity:
        sku = deepcopy(original['skuInfo'])
        source_batch = original['quantityList'][0]
        batch = {key: deepcopy(source_batch[key]) for key in BATCH_FIELDS if key in source_batch}
        batch['hasAdjustDeliveryTime'] = False
        _initial_adjustment(batch)
        adjustment = targets.get(str(sku['skuId']))
        if adjustment:
            # Matches the frontend's direct sellableQuantity edit branch.
            batch['adjustQuantity'] = {
                'adjustType': {'value': 'add' if adjustment['delta'] > 0 else 'minus'},
                'operateQuantity': abs(adjustment['delta']),
            }
            batch['sellableQuantity'] = adjustment['target']
            sku['totalQuantity'] = adjustment['target']
        value = {'skuInfo': sku, 'quantityList': [batch]}
        if 'deleteQuantityList' in original:
            value['deleteQuantityList'] = deepcopy(original['deleteQuantityList'])
        values.append(value)

    # JS undefined fields are omitted. Explicit null is preserved.
    delivery_columns = [column for column in table.get('columns', [])
                        if isinstance(column, dict) and column.get('uiType') == 'deliveryTime']
    if len(delivery_columns) > 1:
        _reject('发货时间字段不唯一')
    action = (delivery_columns[0].get('action') or {}) if delivery_columns else {}
    defaults = action.get('value') or {}
    if not isinstance(defaults, dict):
        _reject('发货时间初始配置未知')
    plan = {}
    if 'gmtCreateRange' in defaults:
        plan['saleTimeRange'] = deepcopy(defaults['gmtCreateRange'])
    body = dict(deepcopy(footer_value), itemInfo=deepcopy(info),
                planTemplateInfo=plan, needCleanOldPlan=False,
                value=values, UUID=str(uuid4()))
    if 'deliverTimeRadio' in defaults:
        body['currentDeliveryTimeType'] = deepcopy(defaults['deliverTimeRadio'])
    return {'url': url, 'body': body}
