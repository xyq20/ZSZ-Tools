from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unicodedata
from collections import Counter
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Error, TimeoutError, expect, sync_playwright


ROOT = Path(__file__).resolve().parent
ERP_HOSTS = {"erpa.superboss.cc", "erp.superboss.cc", "viperp.superboss.cc"}
RULES_ROUTE = "/index.html#/stock/new_rule/"
RULES_URL = "https://erpa.superboss.cc" + RULES_ROUTE
LIST_REQUEST = "/stock/upload/newRule/ruleList"
UPLOAD_REQUEST = "/stock/upload/newRule/manual"
UPLOAD_LIMIT_CODE = "20030013"
CAPACITY_RETRY_SECONDS = 180
CSV_PATH = ROOT / "output" / "全部上传规则.csv"
# These page cookies rotate when Chrome reopens while the authenticated ERP
# session remains the same. Chrome still sends them in its normal requests.
VOLATILE_PAGE_COOKIES = {(".superboss.cc", "_pdd_page_code"), (".superboss.cc", "tfstk")}


@dataclass(frozen=True)
class Rule:
    page_number: int
    name: str
    priority: str
    manual_status: str
    effective_status: str
    created_at: str

    @property
    def description(self):
        return f"{self.name}｜优先级 {self.priority}｜{self.created_at}"


def toolkit_profile(home):
    if sys.platform == "darwin":
        return home / "Library/Application Support/ERP Excel Sync/ChromeProfile"
    if sys.platform == "win32":
        local = Path(os.environ.get("LOCALAPPDATA") or home / "AppData/Local")
        return local / "ERP Excel Sync" / "ChromeProfile"
    return None


def toolkit_debug_browser(playwright, profile):
    # Check that the toolbox's own profile holds the debugging port.
    lock = profile / "SingletonLock"
    try:
        pid = lock.readlink().name.rsplit("-", 1)[-1]
        if not pid.isdecimal():
            return None
        command = subprocess.check_output(
            ["ps", "-p", pid, "-o", "command="], text=True, stderr=subprocess.DEVNULL
        )
        if str(profile) in command and "--remote-debugging-port=9229" in command:
            return playwright.chromium.connect_over_cdp("http://127.0.0.1:9229", timeout=3000)
    except (OSError, subprocess.CalledProcessError, Error):
        return None
    return None


@contextmanager
def open_browser(profile=None, announce=print):
    profile = profile or ROOT / ".runtime" / "chrome"
    announce("正在打开快麦独立 Chrome…")
    with sync_playwright() as playwright:
        browser = toolkit_debug_browser(playwright, profile)
        if browser:
            page = browser.contexts[0].new_page()
            try:
                yield page
            finally:
                if not page.is_closed():
                    page.close()
            return

        try:
            context = playwright.chromium.launch_persistent_context(
                profile,
                channel="chrome",
                headless=False,
                no_viewport=True,
                ignore_default_args=["--use-mock-keychain", "--password-store=basic"],
                args=["--start-maximized", "--restore-last-session"],
            )
        except Error as exc:
            raise RuntimeError("无法打开快麦专用 Chrome。请检查 Chrome 是否已安装，以及快麦专用窗口是否正被其他任务占用。") from exc
        page = next((tab for tab in context.pages if tab.url == "about:blank"), None)
        page = page or context.new_page()
        try:
            yield page
        finally:
            try:
                if not page.is_closed() and len(context.pages) > 1:
                    page.close()
            finally:
                context.close()


def matches_request(response, path):
    url = urlsplit(response.url)
    return (
        url.scheme == "https"
        and url.hostname in ERP_HOSTS
        and url.path == path
        and response.request.method == "POST"
    )


def reach_rules_page(page, announce=print, saved_cookies=(), *, allow_login=True):
    list_status = None

    def on_response(response):
        nonlocal list_status
        if matches_request(response, LIST_REQUEST):
            list_status = response.status

    panel = page.locator("#pane-1:visible")
    heading = panel.locator(".el-table__header th").filter(has_text=re.compile(r"^\s*规则名称\s*$"))
    login = page.locator("#login-btn")
    tried_cookies = False
    tried_saved_login = False
    announced_login = False
    deadline = time.monotonic() + 180
    page.on("response", on_response)
    try:
        page.goto(RULES_URL, wait_until="domcontentloaded", timeout=30_000)
        while time.monotonic() < deadline:
            parts = urlsplit(page.url)
            if parts.scheme == "https" and parts.hostname in ERP_HOSTS:
                if parts.fragment.startswith("/stock/new_rule/") and heading.is_visible() and list_status is not None:
                    if not 200 <= list_status < 300:
                        raise RuntimeError(f"快麦规则列表读取失败（HTTP {list_status}）。")
                    return panel
                if parts.path == "/login.html" and not allow_login:
                    raise RuntimeError("快麦会话已失效。请重新读取规则并确认当前账号。")
                if parts.path == "/login.html" and login.is_visible():
                    if saved_cookies and not tried_cookies:
                        tried_cookies = True
                        try:
                            page.context.add_cookies(saved_cookies)
                        except Error:
                            announce("工具箱登录记录无法复用，请在 Chrome 中完成登录。")
                        else:
                            page.goto(RULES_URL, wait_until="domcontentloaded", timeout=30_000)
                            continue
                    if not tried_saved_login:
                        fields = page.locator("#login-company,#login-account,#login-password")
                        if fields.evaluate_all("fields => fields.length === 3 && fields.every(e => e.value.trim())"):
                            tried_saved_login = True
                            if not page.locator("#reading").is_checked():
                                page.locator('label[for="reading"]').click()
                            login.click()
                            page.wait_for_timeout(1500)
                            continue
                    if not announced_login:
                        announce("请在快麦专用 Chrome 中完成登录或验证码。")
                        announced_login = True
                elif parts.path == "/index.html" and not parts.fragment.startswith("/stock/new_rule/"):
                    page.goto(f"https://{parts.hostname}{RULES_ROUTE}", wait_until="domcontentloaded")
            page.wait_for_timeout(500)
    finally:
        page.remove_listener("response", on_response)
    raise RuntimeError("等待登录或上传规则页面加载超时。请确认当前账号有库存上传规则权限。")


def read_page(panel, expected_page, previous_rows=None):
    rows_script = r"""pane => {
        const pager = pane.querySelector('.el-pagination');
        const table = pane.querySelector('.el-table');
        if (!pager || !table || table.querySelector('.el-loading-mask:not([style*="display: none"])')) return null;
        const columns = [...table.querySelectorAll('.el-table__header th')].map(el => el.innerText.trim());
        const rows = [...table.querySelectorAll('.el-table__body-wrapper tr.el-table__row')];
        return {
            count: pager.querySelector('.el-pagination__total')?.innerText.match(/共\s*(\d+)\s*条记录/)?.[1],
            size: pager.querySelector('.el-pagination__sizes input')?.value,
            page: pager.querySelector('.el-pager .number.active')?.innerText,
            columns,
            rows: rows.map(row => [...row.cells].map(cell => cell.innerText.trim())),
        };
    }"""
    deadline = time.monotonic() + 15
    previous_snapshot = None
    while time.monotonic() < deadline:
        data = panel.evaluate(rows_script, timeout=2500)
        if data and all(str(data.get(key, "")).isdigit() for key in ("count", "size", "page")):
            total, size, number = (int(data[key]) for key in ("count", "size", "page"))
            if number == expected_page and len(data["rows"]) == max(0, min(size, total - (number - 1) * size)):
                rows = data["rows"]
                if rows != previous_rows and data == previous_snapshot:
                    return total, size, data["columns"], rows
                previous_snapshot = data
        panel.page.wait_for_timeout(300)
    raise RuntimeError(f"第 {expected_page} 页规则未加载完整，请重新打开工具。")


def collect_rules(panel):
    rules = []
    previous_rows = None
    page_number = 1
    expected_total = None
    required = ("规则名称", "优先级", "手动上传状态", "生效", "创建时间", "操作")
    while True:
        total, size, columns, rows = read_page(panel, page_number, previous_rows)
        if any(columns.count(label) != 1 for label in required):
            raise RuntimeError("上传规则表的列已变化，无法准确读取。")
        if expected_total is None:
            expected_total = total
        if total != expected_total:
            raise RuntimeError("读取期间规则总数发生变化，请重新抓取。")
        for cells in rows:
            fields = [" ".join(cells[columns.index(label)].split()) for label in required[:-1]]
            if not fields[0]:
                raise RuntimeError(f"第 {page_number} 页有规则名称为空。")
            rules.append(Rule(page_number, *fields))
        next_page = panel.locator(".el-pagination button.btn-next")
        if next_page.is_disabled():
            if len(rules) != total:
                raise RuntimeError(f"页面显示 {total} 条，实际读取 {len(rules)} 条。")
            return rules, {label: columns.index(label) + 1 for label in required}, page_number
        if len(rules) != page_number * size or len(rules) >= total:
            raise RuntimeError("分页条数与规则总数不一致。")
        next_page.click()
        previous_rows = rows
        page_number += 1


def export_rules(rules, output=CSV_PATH):
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=output.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow(["选择编号", "规则名称", "优先级", "手动上传状态", "生效", "创建时间"])
            for number, rule in enumerate(rules, 1):
                values = (rule.name, rule.priority, rule.manual_status, rule.effective_status, rule.created_at)
                # Prevent rule names beginning with formula markers from becoming formulas in Excel.
                writer.writerow([number, *("'" + value if unicodedata.normalize("NFKC", value).lstrip().startswith(("=", "+", "-", "@")) else value for value in values)])
        os.replace(temp, output)
    finally:
        Path(temp).unlink(missing_ok=True)


def catalog_fingerprint(rules, url):
    payload = [urlsplit(url).hostname, [asdict(rule) for rule in rules]]
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def session_fingerprint(page):
    origin = urlsplit(page.url)
    url = f"{origin.scheme}://{origin.netloc}{LIST_REQUEST}"
    cookies = sorted(
        (item["domain"], item["path"], item["name"], item["value"])
        for item in page.context.cookies(url)
        if (item["domain"], item["name"]) not in VOLATILE_PAGE_COOKIES
    )
    return hashlib.sha256(json.dumps([origin.hostname, cookies], ensure_ascii=False).encode()).hexdigest()


def rule_identity(rule):
    return rule.name, rule.priority, rule.created_at


def parse_selection(value, count):
    tokens = re.split(r"[\s,，、]+", value.strip())
    if any(not re.fullmatch(r"[1-9][0-9]*", token) or int(token) > count for token in tokens):
        raise ValueError(f"请输入 1 到 {count} 的编号，多个编号使用逗号或空格隔开。")
    return list(dict.fromkeys(map(int, tokens)))


def go_to_page(panel, current, target):
    while current != target:
        _, _, _, before = read_page(panel, current)
        step = 1 if target > current else -1
        direction = "next" if step == 1 else "prev"
        panel.locator(f".el-pagination button.btn-{direction}").click()
        current += step
        read_page(panel, current, before)
    return current


def rule_dialog(panel, rule, columns):
    page = panel.page
    row = panel.locator(".el-table__body-wrapper tr.el-table__row:visible")
    for label, value in (("规则名称", rule.name), ("优先级", rule.priority), ("创建时间", rule.created_at)):
        cell = page.locator(f"td:nth-child({columns[label]})")
        row = row.filter(has=cell.get_by_text(value, exact=True))
    expect(row).to_have_count(1, timeout=4000)
    manual = row.locator(f'td:nth-child({columns["手动上传状态"]})')
    expect(manual).to_have_text("启用", timeout=2000)
    action = row.locator(f'td:nth-child({columns["操作"]}) a.el-link:not(.is-disabled)')
    action.filter(has_text=re.compile(r"^\s*上传库存\s*$")).click(timeout=4000)

    dialog = page.get_by_role("dialog", name="确认", exact=True)
    expect(dialog).to_be_visible(timeout=5000)
    message = dialog.locator(".el-message-box__message")
    name_pattern = r"\s+".join(re.escape(part) for part in rule.name.split())
    expect(message).to_have_text(re.compile(rf"^\s*确认按照规则\s+{name_pattern}\s+上传库存[？?]\s*$"))
    return dialog


def select_rules(rules, numbers):
    if not isinstance(numbers, list) or not numbers or any(
        type(number) is not int or not 1 <= number <= len(rules) for number in numbers
    ) or len(set(numbers)) != len(numbers):
        raise ValueError("规则选择无效，请重新选择要操作的编号。")
    selected = [(number, rules[number - 1]) for number in numbers]
    unavailable = [f"{n}. {rule.description}" for n, rule in selected if rule.manual_status != "启用"]
    if unavailable:
        raise RuntimeError("以下规则的手动上传未启用，本批未提交\n" + "\n".join(unavailable))
    identities = Counter(map(rule_identity, rules))
    ambiguous = [f"{n}. {rule.description}" for n, rule in selected if identities[rule_identity(rule)] != 1]
    if ambiguous:
        raise RuntimeError("以下规则的名称、优先级和创建时间完全相同，无法唯一定位，本批未提交\n" + "\n".join(ambiguous))
    return selected


def confirm_upload(page, dialog, success, capacity_alert):
    with page.expect_response(lambda response: matches_request(response, UPLOAD_REQUEST), timeout=20_000) as waiting:
        dialog.get_by_role("button", name="确定", exact=True).click(timeout=5000)
    response = waiting.value
    if response.ok:
        expect(success.or_(capacity_alert).first).to_be_visible(timeout=10_000)
    else:
        try:
            capacity_alert.wait_for(state="visible", timeout=2500)
        except TimeoutError:
            raise RuntimeError(f"快麦返回 HTTP {response.status}") from None
    if capacity_alert.is_visible():
        capacity_alert.get_by_role("button", name="确定", exact=True).click(timeout=5000)
        expect(capacity_alert).to_be_hidden()
        return False
    if not response.ok:
        raise RuntimeError(f"快麦返回 HTTP {response.status}")
    expect(success).to_be_visible(timeout=1000)
    return True


def remaining_rows(selected, start):
    return [{"number": number, "status": "未处理"} for number, _ in selected[start:]]


def run_batch(panel, selected, current_page, columns, preview, announce=print, *, expected_session=None):
    page = panel.page
    success = page.locator(".el-message--success:visible").get_by_text("操作成功", exact=True)
    capacity_alert = page.get_by_role("dialog").filter(has_text="已达到库存上传任务上限").filter(
        has_text=re.compile(rf"类型码\s*[：:]\s*{UPLOAD_LIMIT_CODE}\b")
    )
    results = []
    for index, (number, rule) in enumerate(selected):
        announce(f"正在处理 {index + 1}/{len(selected)} · {rule.description}")
        confirmation_started = False
        try:
            expect(success).to_have_count(0, timeout=8000)
            current_page = go_to_page(panel, current_page, rule.page_number)
            if expected_session is not None and session_fingerprint(page) != expected_session:
                raise RuntimeError("快麦会话已变化，请重新读取规则。")
            dialog = rule_dialog(panel, rule, columns)
            if preview:
                dialog.get_by_role("button", name="取消", exact=True).click()
                expect(dialog).to_be_hidden()
                status = "已核对并取消"
            else:
                if expected_session is not None and session_fingerprint(page) != expected_session:
                    raise RuntimeError("快麦会话已变化，请重新读取规则。")
                confirmation_started = True
                if not confirm_upload(page, dialog, success, capacity_alert):
                    return {
                        "complete": False,
                        "rows": [*results, {"number": number, "status": "等待重试"}, *remaining_rows(selected, index + 1)],
                        "retry": {"code": UPLOAD_LIMIT_CODE, "number": number, "seconds": CAPACITY_RETRY_SECONDS},
                    }
                status = "快麦已受理"
            results.append({"number": number, "status": status})
            announce(f"{number:2}. {rule.description} · {status}")
        except (Error, AssertionError, RuntimeError, KeyboardInterrupt) as exc:
            status = "结果待核实" if confirmation_started else "未提交"
            results.append({"number": number, "status": status})
            results.extend(remaining_rows(selected, index + 1))
            announce(f"{number:2}. {rule.description} · {status}")
            detail = str(exc).splitlines() or ["操作中断"]
            return {"complete": False, "rows": results, "error": detail[0]}
    return {"complete": True, "rows": results}


def main():
    parser = argparse.ArgumentParser(description="在快麦 ERP 专用 Chrome 中选择上传库存规则。")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--list", action="store_true", help="读取并导出所有上传规则")
    mode.add_argument("--preview", metavar="编号", help="逐条打开确认框并取消")
    args = parser.parse_args()

    try:
        saved_profile = toolkit_profile(Path.home())
        profile = saved_profile if saved_profile and saved_profile.is_dir() else None
        with open_browser(profile) as page:
            panel = reach_rules_page(page)
            rules, columns, last_page = collect_rules(panel)
            approved_session = session_fingerprint(page)
            approved_catalog = catalog_fingerprint(rules, page.url)
            export_rules(rules)
            print(f"共 {len(rules)} 条规则，清单已保存到 {CSV_PATH}", flush=True)
            for number, rule in enumerate(rules, 1):
                print(f"{number:2}. {rule.description}｜手动上传 {rule.manual_status}｜{rule.effective_status}")
            if args.list or not rules:
                return 0

            if args.preview is not None:
                numbers = parse_selection(args.preview, len(rules))
            else:
                while True:
                    value = input("\n请输入要上传的编号（逗号或空格隔开，回车执行，留空退出）：")
                    if not value.strip():
                        return 0
                    try:
                        numbers = parse_selection(value, len(rules))
                        break
                    except ValueError as exc:
                        print(exc)
            selected = select_rules(rules, numbers)
            while True:
                result = run_batch(panel, selected, last_page, columns, args.preview is not None,
                                   expected_session=approved_session)
                retry = result.get("retry")
                if retry is None:
                    break
                start = next(index for index, (number, _) in enumerate(selected) if number == retry["number"])
                selected = selected[start:]
                print(f"快麦已达到上传任务上限。等待 3 分钟后从第 {retry['number']} 条规则继续。", flush=True)
                time.sleep(retry["seconds"])
                page.goto("about:blank")
                panel = reach_rules_page(page, allow_login=False)
                current_rules, columns, last_page = collect_rules(panel)
                if approved_session != session_fingerprint(page) or approved_catalog != catalog_fingerprint(current_rules, page.url):
                    raise RuntimeError("等待期间快麦会话或规则清单已变化，请核对已受理规则后重新选择。")
            if not result["complete"]:
                print(f'本批停止。{result["error"]}')
                for item in result["rows"]:
                    if item["status"] == "未处理":
                        print(f'{item["number"]:2}. {rules[item["number"] - 1].description} · 未处理')
                return 1
            return 0
    except (EOFError, KeyboardInterrupt):
        print("\n已退出。")
        return 130
    except (Error, RuntimeError, ValueError, OSError) as exc:
        print(f"运行停止。{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
