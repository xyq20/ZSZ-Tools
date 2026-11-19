"""Portable Chinese inventory reports; no credentials or source HTML."""

import html
import json
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path


LABELS = {
    "on_sale": "出售中", "in_stock": "仓库中", "preview": "待执行预览",
    "pending": "待执行", "relisted": "已上架", "listed": "已上架",
    "zero_stock": "全零留库", "zero_stock_kept": "全零留库",
    "kept_in_stock": "全零留库", "skipped": "匹配失败 / 已跳过",
    "failed": "修改失败", "error": "修改失败", "paused": "已暂停 / 待恢复",
    "verified": "库存已核验", "delisted": "已下架 / 待恢复",
    "updating": "修改中 / 待恢复", "completed": "已完成", "done": "已完成",
    "running": "执行中", "completed_with_exceptions": "已结束，存在异常",
    "complete": "已完成", "listing_intent": "正在上架 / 待核验", "listed_verified": "上架已核验",
    "delisting_intent": "正在下架 / 待核验", "delisted_verified": "下架已核验",
    "inventory_intent": "正在保存库存 / 待核验", "inventory_verified": "库存已核验",
    "previewing": "预览生成中（尚未完成）", "preview_ready": "预览已完成，待执行",
}


def _escape(value):
    return html.escape("" if value is None else str(value), quote=True)


def _label(value):
    return LABELS.get(str(value), str(value or "待处理"))


def _atomic_write(path, content):
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def _redact(value):
    # Reports may receive extra adapter metadata: never serialize login material.
    if isinstance(value, dict):
        blocked = ("cookie", "token", "password", "authorization", "headers", "post_data", "postdata", "request_body", "storage_state")
        return {str(key): _redact(item) for key, item in value.items()
                if not any(secret in str(key).lower() for secret in blocked)}
    if isinstance(value, (list, tuple)):
        return [_redact(item) for item in value]
    return value


def write_reports(run_dir, data):
    directory = Path(run_dir)
    directory.mkdir(parents=True, exist_ok=True)
    safe_data = _redact(data)
    items = safe_data.get("items", [])
    if isinstance(items, dict):
        items = list(items.values())
    lookup_completed = safe_data.get("lookup_completed", [])
    query_count = len(lookup_completed) if isinstance(lookup_completed, (list, tuple, dict)) else lookup_completed
    candidate_count = len(safe_data.get("lookup_items") or []) if "lookup_items" in safe_data else len(items)
    product_count = safe_data.get("product_count")
    if product_count is None and "products" in safe_data:
        product_count = len(safe_data["products"])
    safe_data["report_progress"] = {
        "title_queries_completed": query_count,
        "product_count": product_count,
        "candidate_item_count": candidate_count,
        "detail_completed_count": len(items),
        "phase": safe_data.get("phase"),
    }
    unmatched_products = safe_data.get("unmatched_products") or []
    input_warnings = safe_data.get("warnings") or []
    exception_items = sum(
        not item.get("eligible", True) or
        (item.get("result_status") or item.get("result") or item.get("phase") or item.get("status"))
        in {"failed", "error", "skipped", "paused"}
        for item in items
    )
    safe_data["report_summary"] = {
        "item_count": len(items),
        "exception_item_count": exception_items,
        "unmatched_product_count": len(unmatched_products),
        "exception_count": exception_items + len(unmatched_products),
        "warning_count": len(input_warnings),
    }
    report_status = safe_data.get("status") or safe_data.get("phase") or "preview"
    if report_status in {"completed", "done", "complete"} and safe_data["report_summary"]["exception_count"]:
        report_status = "completed_with_exceptions"
    safe_data["report_status"] = report_status
    _atomic_write(directory / "report.json", json.dumps(safe_data, ensure_ascii=False, indent=2, default=str) + "\n")
    rendered = []
    for item in items:
        status = item.get("result_status") or item.get("result") or item.get("phase") or item.get("stage") or item.get("status")
        reason = item.get("reason") or item.get("error") or item.get("message") or ""
        if not item.get("eligible", True) and not reason:
            reason = "链接未通过匹配校验"
        status_text = _label(status)
        if status == "pending" and item.get("phase") not in (None, "preview", "pending"):
            status_text += " · " + _label(item["phase"])
        latest = {str(sku.get("sku_id")): sku for sku in item.get("latest_skus", [])}
        details = []
        for sku in item.get("original_skus") or item.get("skus", []):
            delta = sku.get("delta")
            change = "增加 {}".format(delta) if isinstance(delta, int) and delta > 0 else (
                "减少 {}".format(-delta) if isinstance(delta, int) and delta < 0 else (
                    "不变" if delta == 0 else "待确定"))
            details.append("<tr>" + "".join("<td>{}</td>".format(_escape(value)) for value in (
                sku.get("sku_id"), sku.get("code"), sku.get("current", sku.get("quantity")),
                sku.get("target"), change, latest.get(str(sku.get("sku_id")), {}).get("current", sku.get("verified", sku.get("after", ""))))) + "</tr>")
        rendered.append(
            '<section><h2>{title}</h2><p>商品 ID：<code>{item_id}</code>　主编码：<code>{main}</code>'
            '　<span class="status">{status}</span></p><p class="reason">{reason}</p>'
            '<div class="scroll"><table><thead><tr><th>SKU ID</th><th>商家编码</th><th>预览 / 执行前库存</th>'
            '<th>目标库存</th><th>目标差值</th><th>最近回读库存</th></tr></thead><tbody>{rows}</tbody></table></div></section>'
            .format(title=_escape(item.get("title") or item.get("source_title")), item_id=_escape(item.get("item_id")),
                    main=_escape(item.get("main_code")), status=_escape(status_text), reason=_escape(reason), rows="".join(details)))
    warnings = "".join("<li>{}</li>".format(_escape(warning)) for warning in input_warnings)
    unmatched = "".join("<li>{}</li>".format(_escape(title)) for title in unmatched_products)
    stamp = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S 北京时间")
    summary = safe_data.get("summary")
    summary_text = "　".join("{}：{}".format(_label(key), value) for key, value in summary.items()) if isinstance(summary, dict) else str(summary or "")
    if safe_data.get("pause_reason"):
        summary_text += "\n暂停原因：" + str(safe_data["pause_reason"])
    progress_text = "已匹配候选链接：{} 条　详情已读取：{} 条".format(candidate_count, len(items))
    if "lookup_completed" in safe_data or safe_data.get("phase") in {"previewing", "preview_ready"}:
        progress_text = "标题查询进度：{} / {} 款　".format(query_count, product_count if product_count is not None else "未记录") + progress_text
    phase_text = "阶段：" + _label(safe_data["phase"]) if safe_data.get("phase") else ""
    document = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>淘宝二店库存同步报告</title><style>
body{{font:15px/1.7 system-ui,sans-serif;color:#18212f;background:#f3f5f7;margin:0;padding:24px}}main{{max-width:1200px;margin:auto}}
h1{{font-size:26px}}h2{{font-size:18px;margin-top:0}}section,header{{background:white;padding:20px;border-radius:10px;margin:16px 0}}
.scroll{{overflow:auto}}table{{width:100%;border-collapse:collapse;font-size:14px}}th,td{{padding:8px;text-align:left;border-bottom:1px solid #e5e9ef;white-space:nowrap}}
th{{background:#edf2f8}}.reason{{color:#8b3b00;white-space:pre-wrap}}.status{{font-weight:600}}code{{font-family:ui-monospace,monospace}}pre{{white-space:pre-wrap}}
</style><main><header><h1>淘宝二店库存同步报告</h1><p>目标店铺：中古Remake商店</p><p>{stamp}</p>
<p>状态：{status}　{phase}</p><p>{progress}</p><p>源文件：{source}</p><pre>{summary}</pre>
<p>异常链接：{exception_items} 条　未匹配商品：{unmatched_count} 款　输入提示：{warning_count} 条</p>
<p>数据来自千牛网页内部查询接口和页面；每条链接的结果独立记录，异常不计为成功。</p></header>
{unmatched}{warnings}{items}</main></html>'''.format(stamp=_escape(stamp), status=_escape(_label(report_status)),
        phase=_escape(phase_text), progress=_escape(progress_text), source=_escape(safe_data.get("source_path", "")), summary=_escape(summary_text),
        exception_items=exception_items, unmatched_count=len(unmatched_products), warning_count=len(input_warnings),
        unmatched=("<section><h2>未匹配商品（{} 款）</h2><p class=\"reason\">以下 Excel 二店名称没有找到标题完全匹配的商品链接，未修改库存，计入异常。</p><ul>{}</ul></section>".format(len(unmatched_products), unmatched) if unmatched else ""),
        warnings="<section><h2>输入提示（{} 条）</h2><ul>{}</ul></section>".format(len(input_warnings), warnings) if warnings else "",
        items="".join(rendered))
    _atomic_write(directory / "report.html", document)
    return {"json": str(directory / "report.json"), "html": str(directory / "report.html")}
