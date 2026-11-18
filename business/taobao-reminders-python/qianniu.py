"""Read the authenticated QianNiu My Products interface through Playwright."""

from datetime import datetime
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import parse_qs, urlencode, urlsplit

from playwright.sync_api import Error as PlaywrightError, TimeoutError, sync_playwright


LOCAL = Path(os.environ.get("TAOBAO_REMINDER_STATE_DIR") or
             Path.home() / "Library" / "Application Support" / "TaobaoProductReminders" / "state")
AUTH_STATE = LOCAL / "qianniu-auth.json"
SELLER = "NEIGBORL钊叔制"
LIST_URL = "https://qn.taobao.com/home.htm/SellManage/all"
API_HOST = "h5api.m.taobao.com"
API_PATH = "/h5/mtop.taobao.sell.pc.manage.async/1.0/"
TABLE_PATH = "/taobao/manager/table.htm"
CREATED_FIELD = "upShelfDate_m"
PAGE_SIZE = 20


def launch_browser(playwright, headless):
    executable = os.environ.get("TAOBAO_REMINDER_CHROME")
    browser = {"executable_path": executable} if executable else {"channel": "chrome"}
    return playwright.chromium.launch(headless=headless, **browser)


def first_page_url():
    params = {
        "current": 1,
        "pageSize": PAGE_SIZE,
        "queryTitle": "",
        f"tableSort.{CREATED_FIELD}": "desc",
    }
    return f"{LIST_URL}?{urlencode(params)}"


def is_table_response(response, page_number):
    url = urlsplit(response.url)
    request = response.request
    if url.hostname != API_HOST or url.path != API_PATH or request.method != "POST":
        return False
    try:
        envelope = json.loads(parse_qs(request.post_data or "")["data"][0])
        if urlsplit(envelope.get("url", "")).path != TABLE_PATH:
            return False
        params = json.loads(envelope["jsonBody"])
        return (
            int(params["pagination"]["current"]) == page_number
            and int(params["pagination"]["pageSize"]) == PAGE_SIZE
            and params["table"]["sort"][CREATED_FIELD] == "desc"
        )
    except (KeyError, IndexError, ValueError, TypeError):
        return False


def parse_item(row):
    description = [part["text"] for part in row["itemDesc"]["desc"] if isinstance(part.get("text"), str)]
    code = next(
        (re.sub(r"^编码\s*[:：]\s*", "", part.strip())
         for part in description if re.match(r"^\s*编码\s*[:：]", part)),
        "",
    )
    created_at = datetime.strptime(row[CREATED_FIELD]["value"], "%Y-%m-%d %H:%M")
    return {
        "item_id": row["itemId"],
        "title": description[0],
        "created_at": created_at.isoformat(),
        "code": code,
    }


def read_table(response, page_number, expected_total):
    if not response.ok:
        raise RuntimeError(f"千牛商品列表第 {page_number} 页请求失败（HTTP {response.status}）")
    try:
        outer = response.json()
        if not outer["ret"][0].startswith("SUCCESS::"):
            raise RuntimeError(f"千牛商品列表第 {page_number} 页未返回成功状态")
        result = json.loads(outer["data"]["result"])
        if result["success"] is not True:
            raise RuntimeError(f"千牛商品列表第 {page_number} 页业务响应失败")
        table = result["data"]["table"]
        pagination = result["data"]["pagination"]
        total = int(pagination["total"])
        if expected_total is not None and total != expected_total:
            raise RuntimeError("巡检期间千牛商品总数变化，请重跑本次巡检")
        if int(pagination["current"]) != page_number or int(pagination["pageSize"]) != PAGE_SIZE:
            raise RuntimeError(f"千牛商品列表第 {page_number} 页分页信息不符")
        if not any(col["name"] == CREATED_FIELD and col["label"] == "创建时间" for col in table["column"]):
            raise RuntimeError("千牛商品列表的创建时间字段已变更")
        rows = table["dataSource"]
        expected_rows = min(PAGE_SIZE, max(0, total - (page_number - 1) * PAGE_SIZE))
        if len(rows) != expected_rows:
            raise RuntimeError(f"千牛商品列表第 {page_number} 页返回行数不符")
        return [parse_item(row) for row in rows], total
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise RuntimeError(f"千牛商品列表第 {page_number} 页返回格式已变更") from error


def save_auth(context):
    fd, filename = tempfile.mkstemp(dir=LOCAL, prefix="auth-")
    os.close(fd)
    try:
        context.storage_state(path=filename)
        os.replace(filename, AUTH_STATE)
    finally:
        Path(filename).unlink(missing_ok=True)


def verify_seller(page, timeout=15_000):
    seller = page.locator('[class*="shopName--"]').first
    seller.wait_for(state="visible", timeout=timeout)
    if seller.inner_text().strip() != SELLER:
        raise RuntimeError(f"当前千牛店铺与 {SELLER} 不符")


def fetch_products(oldest):
    if not AUTH_STATE.is_file():
        raise RuntimeError("千牛尚未保存登录状态，请运行 python3 qianniu.py 登录")
    with sync_playwright() as playwright:
        page = None
        try:
            browser = launch_browser(playwright, headless=True)
        except PlaywrightError as error:
            raise RuntimeError("无法启动 Chrome 或 Edge，请检查浏览器安装") from error
        try:
            context = browser.new_context(storage_state=str(AUTH_STATE), timezone_id="Asia/Shanghai")
            page = context.new_page()
            page.set_default_timeout(15000)
            return read_products(page, oldest)
        except TimeoutError as error:
            if page is not None and urlsplit(page.url).hostname != "qn.taobao.com":
                raise RuntimeError("千牛登录已失效，请运行 python3 qianniu.py 重新扫码登录") from error
            raise RuntimeError("千牛页面或商品接口等待超时") from error
        except PlaywrightError as error:
            raise RuntimeError("Playwright 读取千牛页面失败") from error
        finally:
            browser.close()


def read_products(page, oldest):
    page_number = 1
    total = None
    products = []
    seen = set()
    previous = None
    while True:
        with page.expect_response(lambda response: is_table_response(response, page_number)) as pending:
            if page_number == 1:
                page.goto(first_page_url(), wait_until="domcontentloaded")
            else:
                page.get_by_role("button", name=f"下一页，当前第{page_number - 1}页").first.click()

        rows, total = read_table(pending.value, page_number, total)
        if page_number == 1:
            verify_seller(page)
        for row in rows:
            item_id = row["item_id"]
            created_at = row["created_at"]
            if item_id in seen or (previous is not None and created_at > previous):
                raise RuntimeError("千牛商品分页重复或创建时间排序异常，请重跑本次巡检")
            previous = created_at
            seen.add(item_id)

        products.extend(rows)
        if page_number * PAGE_SIZE >= total or (previous and previous[:10] < oldest.isoformat()):
            save_auth(page.context)
            print(f"千牛 {SELLER} · 全部 {total} 件 · 核验 {page_number} 页")
            return products
        page_number += 1


def login():
    LOCAL.mkdir(mode=0o700, parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = launch_browser(playwright, headless=False)
        try:
            context = browser.new_context(timezone_id="Asia/Shanghai")
            page = context.new_page()
            page.goto(first_page_url(), wait_until="domcontentloaded")
            print(f"请在 Chrome 里扫码登录 {SELLER}", flush=True)
            verify_seller(page, timeout=300_000)
            page.get_by_text("创建时间", exact=True).first.wait_for(state="visible")
            save_auth(context)
            print(f"已保存 {SELLER} 的千牛登录状态")
        finally:
            browser.close()


if __name__ == "__main__":
    try:
        login()
    except TimeoutError:
        sys.exit("千牛登录未在等待时间内完成")
    except PlaywrightError:
        sys.exit("无法打开千牛登录页，请检查 Chrome 或 Edge 以及网络")
    except (OSError, RuntimeError) as error:
        sys.exit(str(error))
