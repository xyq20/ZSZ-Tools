"""Concise, credential-free reports built only from persisted run results."""
import html
import os
import re
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path


BEIJING = timezone(timedelta(hours=8))
RESULT_LABELS = {
    'listed': '已上架', 'zero_stock': '全零留库', 'skipped': '跳过',
    'failed': '失败', 'pending': '未完成', 'paused': '已暂停，未完成',
}
SUCCESS = {'listed', 'zero_stock'}
FINISHED = {'completed', 'completed_with_exceptions', 'complete', 'done'}


def _safe_text(value, limit=600):
    """Only allowlisted business fields are rendered; scrub errors defensively."""
    text = '' if value is None else str(value)
    text = re.sub(r'https?://[^\s<>"\']+', '[请求地址已隐藏]', text, flags=re.I)
    text = re.sub(
        r'\b(authorization|set-cookie|cookie|csrf(?:token)?|access[_-]?token|refresh[_-]?token|'
        r'token|password|passwd|secret|signature)\s*[:=]\s*[^\r\n;，]+',
        r'\1=[已隐藏]', text, flags=re.I)
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
    text = ' '.join(text.split())
    return text if len(text) <= limit else text[:limit] + '…'


def _h(value):
    return html.escape(_safe_text(value), quote=True)


def _brief_reason(value):
    text = _safe_text(value)
    parts = text.split('；')
    matches = [re.fullmatch(r'SKU (.+) 在 Excel 中没有完整编码匹配', part) for part in parts]
    if len(parts) > 2 and all(matches):
        codes = [match.group(1) for match in matches]
        return '%d 个 SKU 编码未在 Excel 中匹配（示例：%s）' % (len(codes), '、'.join(codes[:2]))
    return text


def _md(value):
    text = html.escape(_safe_text(value), quote=False)
    return re.sub(r'([\\`*_{}\[\]()#+!|])', r'\\\1', text)


def _number(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _records(values):
    if isinstance(values, dict):
        values = values.values()
    if not isinstance(values, (list, tuple)) and not hasattr(values, '__iter__'):
        return []
    result, seen = [], set()
    for row in values or []:
        if not isinstance(row, dict):
            continue
        item_id = str(row.get('item_id') or '')
        if item_id and item_id in seen:
            continue
        if item_id:
            seen.add(item_id)
        result.append(row)
    return result


def _result(item):
    value = item.get('result')
    if value in RESULT_LABELS:
        return value
    return 'skipped' if item.get('eligible') is False else 'pending'


def _unmatched_titles(values):
    if not isinstance(values, (list, tuple)):
        return []
    titles, seen = [], set()
    for value in values:
        title = value.get('title') if isinstance(value, dict) else value
        title = _safe_text(title)
        if title and title not in seen:
            titles.append(title)
            seen.add(title)
    return titles


def _verified_changed_skus(items):
    changed = set()
    for position, item in enumerate(items):
        item_id = str(item.get('item_id') or 'missing-item-%d' % position)
        for attempt in item.get('inventory_attempts') or []:
            if not isinstance(attempt, dict) or attempt.get('outcome') != 'verified':
                continue
            for adjustment in attempt.get('adjustments') or []:
                if not isinstance(adjustment, dict):
                    continue
                delta = adjustment.get('delta')
                sku_id = adjustment.get('sku_id')
                if sku_id is not None and isinstance(delta, int) and not isinstance(delta, bool) and delta != 0:
                    changed.add((item_id, str(sku_id)))
    return len(changed)


def _status(run, unfinished, exceptions):
    state = run.get('status') or run.get('phase') or 'preview'
    if state in {'paused', 'interrupted'}:
        return '已暂停，尚未完成'
    if state == 'failed':
        return '执行失败，尚未完成'
    if state == 'cancelled':
        return '已取消，尚未完成'
    if state in FINISHED:
        if unfinished:
            return '尚未完成（仍有待处理链接）'
        return '已结束，存在异常' if exceptions else '已完成'
    if state in {'preview', 'previewing', 'preview_ready'}:
        return '预览阶段，尚未完成执行'
    return '执行中，尚未完成'


def _stamp(value):
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo is not None:
                return parsed.astimezone(BEIJING).strftime('%Y-%m-%d %H:%M:%S 北京时间')
        except ValueError:
            pass
    return None


def _atomic_write(path, content):
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_summary(run_dir, run):
    """Write 简洁报告.md/html; do not mutate the run or export raw metadata.

    Completed trial links in ``previous_completed`` are counted separately and
    excluded from current-run totals, even if also present in ``items``.
    Only verified, nonzero inventory attempts count as newly adjusted SKUs;
    multiple attempts on the same item/SKU are counted once.
    """
    directory = Path(run_dir)
    directory.mkdir(parents=True, exist_ok=True)
    previous = _records(run.get('previous_completed') or [])
    previous_ids = {str(row.get('item_id')) for row in previous if row.get('item_id')}
    items = [row for row in _records(run.get('items') or [])
             if str(row.get('item_id') or '') not in previous_ids]
    counts = {key: 0 for key in RESULT_LABELS}
    for item in items:
        counts[_result(item)] += 1
    unmatched = _unmatched_titles(run.get('unmatched_products'))
    successful = counts['listed'] + counts['zero_stock']
    unfinished = counts['pending'] + counts['paused']
    exceptions = counts['skipped'] + counts['failed'] + len(unmatched)
    state = _status(run, unfinished, exceptions)
    title = '淘宝二店库存同步简洁报告'
    now = datetime.now(BEIJING).strftime('%Y-%m-%d %H:%M:%S 北京时间')
    as_of = _stamp(run.get('updated_at') or run.get('completed_at'))
    product_count, sku_count = _number(run.get('product_count')), _number(run.get('sku_count'))
    source_parts = []
    if product_count is not None:
        source_parts.append('%d 款商品' % product_count)
    if sku_count is not None:
        source_parts.append('%d 条 SKU' % sku_count)
    source = 'Excel 来源：' + '，'.join(source_parts) if source_parts else ''
    metrics = [
        ('本次候选链接', len(items)), ('本次成功完成', successful),
        ('已上架', counts['listed']), ('全零留库', counts['zero_stock']),
        ('跳过', counts['skipped']), ('失败', counts['failed']),
        ('未完成', unfinished), ('未匹配标题', len(unmatched)),
        ('此前已完成，免重复处理', len(previous)),
        ('本次已核验改动 SKU', _verified_changed_skus(items)),
    ]
    pause_reason = _safe_text(run.get('pause_reason') or run.get('job_error'))
    reason_label = ('失败原因' if run.get('status') == 'failed' else
                    '备注' if run.get('status') in FINISHED else '暂停原因')
    abnormal = [item for item in items if _result(item) not in SUCCESS]
    completed = [item for item in items if _result(item) in SUCCESS]

    markdown = ['# ' + title, '', '**状态：%s**' % _md(state), '', '生成时间：' + now]
    if as_of:
        markdown.append('数据截至：' + as_of)
    markdown.append('店铺：中古Remake商店')
    if source:
        markdown.append(source)
    markdown += ['', '| 项目 | 数量 |', '|---|---:|']
    markdown += ['| %s | %d |' % (label, count) for label, count in metrics]
    if pause_reason:
        markdown += ['', '**%s：** ' % reason_label + _md(pause_reason)]
    markdown += ['', '## 异常与待处理', '']
    if abnormal or unmatched:
        for item in abnormal:
            result = _result(item)
            reason = item.get('error') or item.get('reason') or (
                '尚未完成核验' if result in {'pending', 'paused'} else '请查看执行记录')
            markdown.append('- %s｜%s｜ID %s：%s' % (
                _md(RESULT_LABELS[result]), _md(item.get('title') or item.get('source_title') or '未记录标题'),
                _md(item.get('item_id') or '未记录'), _md(_brief_reason(reason))))
        markdown += ['- 未匹配标题：' + _md(value) for value in unmatched]
    elif state == '已完成':
        markdown.append('无。')
    else:
        markdown.append('目前没有已记录异常；报告尚未代表全量执行完成。')
    markdown += ['', '黄色库存按 0；全零商品留在仓库。此前已完成链接不重复同步。',
                 '改动 SKU 数仅统计已核验成功的非零调整，不包含预览、失败或结果不明的提交。',
                 '成功链接明细见同目录的简洁报告.html（折叠区）；逐 SKU 明细及执行记录见 report.html / state.json。', '']

    metric_rows = ''.join('<tr><td>%s</td><td>%d</td></tr>' % (_h(label), count) for label, count in metrics)
    exception_rows = []
    for item in abnormal:
        result = _result(item)
        reason = item.get('error') or item.get('reason') or (
            '尚未完成核验' if result in {'pending', 'paused'} else '请查看执行记录')
        exception_rows.append('<li><strong>%s</strong> · %s · ID <code>%s</code><br>%s</li>' % (
            _h(RESULT_LABELS[result]), _h(item.get('title') or item.get('source_title') or '未记录标题'),
            _h(item.get('item_id') or '未记录'), _h(_brief_reason(reason))))
    exception_rows += ['<li><strong>未匹配标题</strong> · %s</li>' % _h(value) for value in unmatched]
    if exception_rows:
        exception_html = '<ul class="exceptions">' + ''.join(exception_rows) + '</ul>'
    else:
        exception_html = '<p>' + ('无。' if state == '已完成' else '目前没有已记录异常；报告尚未代表全量执行完成。') + '</p>'

    def success_rows(rows, is_previous=False):
        result = []
        for item in rows:
            label = '此前已完成，未重复处理' if is_previous else RESULT_LABELS[_result(item)]
            latest = item.get('latest_skus') or []
            quantities = [r.get('current') for r in latest if isinstance(r, dict)]
            total = sum(quantities) if latest and len(quantities) == len(latest) and all(_number(q) is not None for q in quantities) else '—'
            result.append('<tr><td><code>%s</code></td><td>%s</td><td>%s</td><td>%s</td></tr>' % (
                _h(item.get('item_id')), _h(item.get('title') or item.get('source_title') or '未记录标题'),
                _h(label), _h(total)))
        return ''.join(result)

    detail_table = '<div class="scroll"><table><thead><tr><th>商品 ID</th><th>标题</th><th>结果</th><th>最近核验总库存</th></tr></thead><tbody>%s</tbody></table></div>'
    normal_details = ('<details><summary>查看本次成功链接（%d 条）</summary>%s</details>' % (
        len(completed), detail_table % success_rows(completed))) if completed else ''
    previous_details = ('<details><summary>查看此前已完成链接（%d 条，未重复处理）</summary>%s</details>' % (
        len(previous), detail_table % success_rows(previous, True))) if previous else ''
    document = '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title>
<style>body{{margin:0;background:#f5f6f8;color:#202733;font:15px/1.7 system-ui,sans-serif}}main{{max-width:940px;margin:auto;padding:26px}}
h1{{font-size:24px;margin:0 0 12px}}h2{{font-size:18px}}section,header,details{{background:#fff;border:1px solid #e4e8ed;border-radius:10px;padding:20px;margin-bottom:16px}}
p{{margin:6px 0}}.status{{font-size:18px;font-weight:700}}.meta,footer{{color:#566170;font-size:13px}}table{{border-collapse:collapse;width:100%}}th,td{{padding:7px 10px;border-bottom:1px solid #e9edf2;text-align:left;vertical-align:top}}
.metrics td:last-child{{text-align:right;font-variant-numeric:tabular-nums}}.exceptions{{padding-left:22px}}.exceptions li{{margin:12px 0}}.notice{{color:#8a4000}}summary{{cursor:pointer;font-weight:600}}.scroll{{overflow-x:auto}}code{{font-family:ui-monospace,monospace}}footer{{padding:0 4px}}@media(max-width:600px){{main{{padding:12px}}section,header,details{{padding:14px}}}}</style></head><body><main>
<header><h1>{title}</h1><p class="status">{state}</p><p>店铺：中古Remake商店</p>{source}<p class="meta">生成时间：{now}</p>{as_of}</header>
<section><table class="metrics"><thead><tr><th>项目</th><th>数量</th></tr></thead><tbody>{metrics}</tbody></table>{pause}</section>
<section><h2>异常与待处理</h2>{exceptions}</section>{normal}{previous}
<footer><p>黄色库存按 0；全零商品留在仓库。此前已完成链接不重复同步。</p><p>改动 SKU 数仅统计已核验成功的非零调整，不包含预览、失败或结果不明的提交。</p><p>最近核验库存是执行时的快照，后续销售可继续扣减。逐 SKU 明细及执行记录见 report.html / state.json。</p></footer>
</main></body></html>'''.format(
        title=title, state=_h(state), source='<p>%s</p>' % _h(source) if source else '', now=_h(now),
        as_of='<p class="meta">数据截至：%s</p>' % _h(as_of) if as_of else '', metrics=metric_rows,
        pause='<p class="notice">%s：%s</p>' % (_h(reason_label), _h(pause_reason)) if pause_reason else '',
        exceptions=exception_html, normal=normal_details, previous=previous_details)
    markdown_path, html_path = directory / '简洁报告.md', directory / '简洁报告.html'
    _atomic_write(markdown_path, '\n'.join(markdown))
    _atomic_write(html_path, document)
    return {'markdown': str(markdown_path), 'html': str(html_path)}
