"""Export the 快麦 销售统计分析 按款 return-rate report."""
from __future__ import annotations

import argparse
from calendar import monthrange
from contextlib import contextmanager
from datetime import date, datetime, time as day_time, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from playwright.sync_api import Error as PlaywrightError, sync_playwright


ROOT = Path(__file__).resolve().parent
ERP = "https://erpa.superboss.cc"
REPORT = "/report/dynamic/?reportId=67949"
TZ = timezone(timedelta(hours=8))
SUPPORT = Path.home() / "Library" / "Application Support"
PROFILE = SUPPORT / "ERP Excel Sync" / "ChromeProfile"
OFFICIAL_CONFIG = Path.home() / "Desktop/电商自动化/6.库存监控台/.local/official.json"
ERP_CONFIG = Path.home() / "Desktop/电商自动化/1.快麦excel导入脚本/config.json"
TOTAL_TYPES = "1,2,5,7,8,10"
BEFORE_TYPES = "5"
AFTER_TYPES = "1,2,7,8,10"
SALES = "order_item_num"
BEFORE = "snapshot_return_item_count"
AFTER = "snapshot_actual_refund_item_count"
PAGE_SIZE = 100
CODE_BATCH = 50
TAOBAO_SOURCE = "tb"
REPORT_STEPS = 10


def shop_list(config):
    """Load the official shop directory, including its selection groups."""
    config = dict(config) if isinstance(config, dict) else json.loads(config.read_text())
    secret = config.pop("appSecret")
    shops = {}
    for page in range(1, 101):
        params = {
            **config,
            "method": "erp.shop.list.query",
            "timestamp": datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S"),
            "format": "json",
            "version": "1.0",
            "sign_method": "md5",
            "pageNo": str(page),
            "pageSize": "100",
        }
        signing_text = secret + "".join(k + str(params[k]) for k in sorted(params)) + secret
        params["sign"] = hashlib.md5(signing_text.encode()).hexdigest().upper()
        request = Request("https://gw.superboss.cc/router", data=urlencode(params).encode())
        with urlopen(request, timeout=30) as response:
            result = json.load(response)
        if not result.get("success") or not isinstance(result.get("list"), list):
            raise RuntimeError(f"官方店铺接口查询失败（{result.get('code', '无错误码')}）")
        batch = result["list"]
        for shop in batch:
            key = str(int(shop["userId"]))
            if key in shops or not shop.get("source"):
                raise RuntimeError("官方店铺列表出现重复编号或缺少平台")
            shops[key] = shop
        if len(batch) < 100:
            return shops
    raise RuntimeError("官方店铺列表超过可验证分页范围")


@contextmanager
def report_page(profile, *, reuse_debug_port=True, on_login=None):
    with sync_playwright() as pw:
        context = None
        page = None
        # This port belongs to the separate ERP Chrome profile on this Mac.
        browser = None
        if reuse_debug_port:
            try:
                browser = pw.chromium.connect_over_cdp("http://127.0.0.1:9229", timeout=2500)
            except PlaywrightError:
                pass
        try:
            if browser:
                context = browser.contexts[0]
                page = context.new_page()
            else:
                context = pw.chromium.launch_persistent_context(
                    str(profile), channel="chrome", headless=False,
                    ignore_default_args=["--use-mock-keychain", "--password-store=basic"],
                )
                page = context.pages[0] if context.pages else context.new_page()
            page.goto(f"{ERP}/index.html#{REPORT}", wait_until="domcontentloaded", timeout=30000)
            ready = page.get_by_role("button", name="计算数据", exact=True)
            login = page.locator("#login-btn")
            auto_attempted = False
            login_announced = False
            deadline = time.monotonic() + 180
            while not ready.is_visible():
                if time.monotonic() >= deadline:
                    raise RuntimeError("等待快麦登录或销售统计分析页面加载超时")
                if login.is_visible():
                    if not auto_attempted:
                        auto_attempted = True
                        fields = page.locator("#login-company,#login-account,#login-password")
                        autofilled = fields.evaluate_all(
                            "fields => fields.length === 3 && fields.every(e => e.value.trim())"
                        )
                        if autofilled:
                            if not page.locator("#reading").is_checked():
                                page.locator('label[for="reading"]').click(force=True)
                            if page.locator("#reading").is_checked():
                                login.click()
                    if not login_announced:
                        message = "请在独立 Chrome 窗口完成快麦登录（如出现验证码）。"
                        if on_login:
                            on_login(message)
                        else:
                            print(message, flush=True)
                        login_announced = True
                elif page.url.startswith(ERP + "/index.html") and "#" + REPORT not in page.url:
                    page.goto(f"{ERP}/index.html#{REPORT}", wait_until="domcontentloaded")
                page.wait_for_timeout(1000)
            yield page
        finally:
            if browser and page:
                page.close()
            elif context:
                context.close()


class SalesReport:
    def __init__(self, page, company_id, start, end):
        self.page = page
        self.company_id = company_id
        self.base = json.loads((ROOT / "report-query.json").read_text())
        self.base.update(
            startTime=int(datetime.combine(start, day_time.min, TZ).timestamp()) * 1000,
            endTime=int(datetime.combine(end + timedelta(days=1), day_time.min, TZ).timestamp()) * 1000 - 1,
        )
        self.last_request = 0.0

    def request(self, action, body):
        path = f"/kmrp/statistics/history/sale/follow/{action}"
        for attempt in range(5):
            self.page.wait_for_timeout(max(0, 2500 - (time.monotonic() - self.last_request) * 1000))
            self.last_request = time.monotonic()
            reply = self.page.evaluate(
                """async ({path, module, company, body}) => {
                    const response = await fetch(path, {
                        method: 'POST', credentials: 'include',
                        headers: {
                            'Content-Type': 'application/json',
                            'Companyid': company,
                            'Module-Path': module,
                            'Trackid': 'trackid' + Date.now() + '_return_report'
                        },
                        body: JSON.stringify(body),
                        signal: AbortSignal.timeout(45000)
                    });
                    return {status: response.status, result: await response.json().catch(() => null)};
                }""",
                {"path": path, "module": REPORT, "company": self.company_id,
                 "body": {**body, "api_name": "kmrp_statistics_history_sale_follow_" + action}},
            )
            result = reply["result"] or {}
            message = result.get("message") or result.get("errorMsg") or ""
            if reply["status"] == 429 or reply["status"] >= 500 or "频繁" in message:
                if attempt == 4:
                    raise RuntimeError(f"快麦报表限流或服务暂不可用（{action}）")
                self.page.wait_for_timeout(5000 * (attempt + 1))
                continue
            if result.get("result") != 1 or not isinstance(result.get("data"), dict):
                raise RuntimeError(f"快麦报表请求失败（{action}，HTTP {reply['status']}）{message}")
            return result["data"]

    def by_style(self, scope, work_types, codes=()):
        if not scope:
            return {}
        found = {}
        batches = [codes[i:i + CODE_BATCH] for i in range(0, len(codes), CODE_BATCH)] if codes else [()]
        for batch in batches:
            body = {
                **self.base,
                "userIdList": ",".join(scope),
                "workOrderTypeList": work_types,
                "systemOuterIdList": ",".join(batch),
                "pageSize": PAGE_SIZE,
            }
            read_count = 0
            seen_rows = set()
            for number in range(1, 101):
                data = self.request("page", dict(body, pageNo=number))
                page_info, rows = data.get("page"), data.get("list")
                if (
                    not isinstance(page_info, dict)
                    or not isinstance(rows, list)
                    or page_info.get("pageNo") != number
                ):
                    raise RuntimeError("快麦报表返回了无法验证的分页")
                read_count += len(rows)
                for row in rows:
                    if not isinstance(row, dict):
                        raise RuntimeError("快麦报表返回了无效的按款记录")
                    row_key = row.get("merge_item_uk")
                    if row_key:
                        identity = (row.get("merge_uk_type"), row_key)
                        if identity in seen_rows:
                            raise RuntimeError(f"快麦按款报表分页出现重复记录（第 {number} 页）")
                        seen_rows.add(identity)
                    if row.get("merge_uk_type") != "sys":
                        continue
                    code = (row.get("merge_item_outer_id") or "").strip()
                    if not code:
                        continue
                    if batch and code not in batch:
                        raise RuntimeError(f"精确商家编码查询返回了范围外的编码 {code!r}")
                    if code in found:
                        raise RuntimeError(f"快麦按款报表的商家编码重复 {code!r}")
                    found[code] = row
                if page_info.get("hasNext") is False:
                    break
                if page_info.get("hasNext") is not True or not rows:
                    raise RuntimeError("快麦报表分页未正常结束")
            else:
                raise RuntimeError("快麦报表超过可验证分页范围")
            summary = self.request("summary", dict(body, pageNo=1))
            if int(summary["total"]) != read_count:
                raise RuntimeError(f"快麦报表行数不一致（分页 {read_count}，汇总 {summary['total']}）")
        return found


def quantity(row, key):
    if row is None:
        return 0
    if key not in row:
        raise RuntimeError(f"快麦报表缺少数量字段 {key}")
    value = row[key]
    if value in (None, "", "-"):
        if key == SALES:
            raise RuntimeError("快麦按款记录的订单商品数为空")
        return 0
    return int(str(value).replace(",", ""))


def shop_name(shop):
    return shop.get("shortTitle") or shop.get("title") or shop.get("name") or ""


def collect_report_data(report, shops, selection_shop_ids, minimum, excluded_codes=(), progress=None):
    """Use the paid sales in the selection group to decide which codes to report."""
    if progress:
        progress(2, f"按付款时间查询选款销量（{len(selection_shop_ids)} 家店）")
    candidates = report.by_style(selection_shop_ids, TOTAL_TYPES)
    codes = sorted(
        (code for code, row in candidates.items() if code not in excluded_codes and quantity(row, SALES) >= minimum),
        key=lambda code: (-quantity(candidates[code], SALES), code),
    )
    # Once codes are selected, the split covers the full official shop directory.
    scopes = {
        "淘宝": tuple(k for k, shop in shops.items() if shop["source"] == TAOBAO_SOURCE),
        "除淘宝": tuple(k for k, shop in shops.items() if shop["source"] != TAOBAO_SOURCE),
        "合计": tuple(shops),
    }
    records = {}
    for index, (label, scope) in enumerate(scopes.items()):
        completed = 3 + index * 2
        detail = f"（{len(scope)} 家店，{len(codes)} 款）"
        if progress:
            progress(completed, f"{label} · 查询未发货仅退款{detail}")
        before = report.by_style(scope, BEFORE_TYPES, codes) if codes else {}
        if progress:
            progress(completed + 1, f"{label} · 查询退货退款{detail}")
        after = report.by_style(scope, AFTER_TYPES, codes) if codes else {}
        records[label] = {}
        for code in codes:
            sale = quantity(before.get(code), SALES)
            if sale != quantity(after.get(code), SALES):
                raise RuntimeError(f"{label} {code} 的两种售后筛选返回了不同的销量")
            records[label][code] = (
                sale,
                quantity(before.get(code), BEFORE),
                quantity(after.get(code), AFTER),
            )
    # The full-scope query independently checks that the split did not miss any quantity.
    for code in codes:
        split = tuple(a + b for a, b in zip(records["淘宝"][code], records["除淘宝"][code]))
        total = records["合计"][code]
        if total[0] == 0:
            raise RuntimeError(f"{code} 已通过选款销量门槛，但全店查询的销量为零")
        if split != total:
            raise RuntimeError(f"{code} 的分平台数据与全店汇总不一致")
    return codes, candidates, records


def export(output, month, group_name, minimum, shops, codes, candidates, records, excluded_codes=()):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "退货率"
    sheet.sheet_view.showGridLines = False
    headings = ("名称", "商家编码", "销量", "未发货仅退款数量", "退货退款数量",
                "总退款数量", "未发货仅退款率", "退货退款率", "总退款率")
    blue, navy, pale, band = ("4472C4", "193966", "E8F0FC", "F4F7FC")
    widths = (16, 17, 8, 12, 10, 10, 11, 10, 10)
    total = len(codes) + 3
    for group_index, (label, entries) in enumerate(records.items()):
        offset = 10 * group_index
        cols = [get_column_letter(offset + j) for j in range(1, 10)]
        _, _, sales_col, before_col, after_col, total_col, *_ = cols
        sheet.merge_cells(start_row=1, start_column=offset + 1, end_row=1, end_column=offset + 9)
        title = sheet.cell(1, offset + 1, f"{month} 退货数据（{label}）")
        title.fill = PatternFill("solid", fgColor=navy)
        title.font = Font(name="Arial", size=14, bold=True, color="FFFFFF")
        title.alignment = Alignment(horizontal="center", vertical="center")
        for j, (heading, width) in enumerate(zip(headings, widths), start=1):
            sheet.column_dimensions[cols[j - 1]].width = width
            cell = sheet.cell(2, offset + j, heading)
            cell.fill = PatternFill("solid", fgColor=blue)
            cell.font = Font(name="Arial", bold=True, color="FFFFFF")
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        if group_index < 2:
            sheet.column_dimensions[get_column_letter(offset + 10)].width = 1.5
        for row, code in enumerate(codes, start=3):
            title = candidates[code].get("merge_item_title") or code
            name = re.match(r"^【[^】]+】", title)
            sheet.cell(row, offset + 1, name[0] if name else title).data_type = "s"
            sheet.cell(row, offset + 2, code).data_type = "s"
            for col, val in enumerate(entries[code], start=3):
                sheet.cell(row, offset + col, val)
        sheet.cell(total, offset + 1, "合计")
        for j, col in enumerate((sales_col, before_col, after_col), start=3):
            sheet.cell(total, offset + j, f"=SUM({col}3:{col}{total - 1})" if codes else 0)
        for row in range(3, total + 1):
            sheet.cell(row, offset + 6, f"=SUM({before_col}{row}:{after_col}{row})")
            for j, numerator in enumerate((before_col, after_col, total_col), start=7):
                sheet.cell(row, offset + j, f'=IF({sales_col}{row}=0,"",{numerator}{row}/{sales_col}{row})')
            for j in range(1, 10):
                cell = sheet.cell(row, offset + j)
                cell.font = Font(name="Arial", size=10, bold=row == total, color=navy)
                cell.alignment = Alignment(horizontal="center", vertical="center", shrink_to_fit=True)
                if row == total or row % 2 == 0:
                    cell.fill = PatternFill("solid", fgColor=pale if row == total else band)
                if j >= 3:
                    cell.number_format = "#,##0" if j <= 6 else "0.00%"
    sheet.row_dimensions[1].height = 29
    sheet.row_dimensions[2].height = 31
    sheet.row_dimensions[total].height = 20

    notes = workbook.create_sheet("统计口径")
    notes.append(("统计月份", month))
    notes.append(("采集时间（北京时间）", datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S")))
    notes.append(("统计范围", f"全部 {len(shops)} 家店铺，淘宝为平台 tb，天猫计入除淘宝。"))
    notes.append(("选款", f"仅在「{group_name}」分组按订单商品数 ≥ {minimum} 筛选系统主商家编码。"))
    notes.append(("订单筛选", "按订单付款时间。排除未付款和作废订单，仅统计平台订单。"))
    notes.append(("售后状态", "未解决、解决中、已解决；仅过滤售后工单。"))
    notes.append(("未发货仅退款数量", "只勾选未发货仅退款，读取退货数量。"))
    notes.append(("退货退款数量", "已发货仅退款、退货、拒收退货、档口退货、档口换货，读取实退数量。"))
    notes.append(("退款率", "各类数量除以相应板块的销量；销量为零时留空。合计率按合计数量和销量计算。"))
    notes.append(("来源", "店铺来自快麦开放平台；数量来自销售统计分析的按款报表。"))
    notes.append(("核对", "各分页行数核对报表汇总；每款的淘宝与除淘宝逐项相加核对全店合计。"))
    if excluded_codes:
        notes.append(("排除编码", "、".join(excluded_codes)))
    notes.append(())
    notes.append(("店铺", "统计板块", "平台编码", "快麦店铺编号"))
    for key, shop in shops.items():
        notes.append((shop_name(shop), "淘宝" if shop["source"] == TAOBAO_SOURCE else "除淘宝", shop["source"], key))
    for col, width in {"A": 23, "B": 58, "C": 13, "D": 17}.items():
        notes.column_dimensions[col].width = width
    for row in notes:
        for cell in row:
            cell.font = Font(name="Arial", size=10, color=navy)
            cell.alignment = Alignment(horizontal="center", vertical="center", shrink_to_fit=True)
            if cell.data_type == "f":
                cell.data_type = "s"

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as tmp:
        staged = Path(tmp) / output.name
        workbook.save(staged)
        os.link(staged, output)


def month_window(month):
    if not isinstance(month, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}", month):
        raise ValueError("月份格式为 YYYY-MM")
    try:
        start = date.fromisoformat(month + "-01")
    except ValueError:
        raise ValueError("月份无效") from None
    end = start.replace(day=monthrange(start.year, start.month)[1])
    if end >= datetime.now(TZ).date():
        raise ValueError("请选择已经结束的月份")
    return start, end


def run_report(month, selection_group, minimum, official_config, company_id, output,
               excluded_codes=(), *, profile=PROFILE, reuse_debug_port=True, progress=None):
    """Collect the approved paid-month report, then publish its workbook."""
    start, end = month_window(month)
    if not isinstance(minimum, int) or minimum < 1:
        raise ValueError("销量门槛必须是正整数")
    if output.suffix.lower() != ".xlsx" or output.exists():
        raise ValueError("请提供尚未存在的 .xlsx 输出路径")

    def notify(completed, message):
        if progress:
            progress(completed, message)
        else:
            print(message, flush=True)

    notify(0, "读取快麦开放平台店铺")
    shops = shop_list(official_config)
    selection_shop_ids = tuple(key for key, shop in shops.items() if shop.get("groupName") == selection_group)
    if not selection_shop_ids:
        raise RuntimeError(f"官方店铺列表中找不到分组 {selection_group!r}")

    notify(1, "打开快麦独立 Chrome")
    with report_page(profile, reuse_debug_port=reuse_debug_port, on_login=lambda msg: notify(1, msg)) as page:
        report = SalesReport(page, str(company_id), start, end)
        codes, candidates, records = collect_report_data(
            report, shops, selection_shop_ids, minimum, excluded_codes, notify
        )
    notify(9, "已通过全店汇总核对，正在写入 Excel")
    export(output, month, selection_group, minimum, shops, codes, candidates, records, excluded_codes)
    sales, before, after = (
        sum(row[index] for row in records["合计"].values()) for index in range(3)
    )
    notify(REPORT_STEPS, f"已导出 {len(codes)} 款")
    return {
        "file": str(output.resolve()), "count": len(codes),
        "sales": sales, "before": before, "after": after,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("month", help="统计月份，例如 2026-10")
    parser.add_argument("--shop-group", default="钊叔制", help="仅用于筛选商家编码的店铺分组")
    parser.add_argument("--minimum-sales", type=int, default=100)
    parser.add_argument("--exclude-code", action="append", default=[], help="排除商家编码，可重复指定")
    parser.add_argument("--official-config", type=Path, default=OFFICIAL_CONFIG)
    parser.add_argument("--company-id", help="默认从本机现有快麦同步项目读取")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    company_id = args.company_id or json.loads(ERP_CONFIG.read_text())["company_id"]
    output = args.output or ROOT / "output" / f"{args.month}退货率_付款时间.xlsx"
    excluded_codes = tuple(dict.fromkeys(args.exclude_code))
    result = run_report(args.month, args.shop_group, args.minimum_sales,
                        args.official_config, company_id, output, excluded_codes)
    print(result["file"], flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, KeyError, PlaywrightError) as error:
        sys.exit(str(error))
