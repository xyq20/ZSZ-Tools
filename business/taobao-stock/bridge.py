"""JSON-lines host bridge for embedding stock sync in the toolkit."""
import asyncio
import contextlib
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import Error as BrowserError, async_playwright

# Windows embedded Python's python312._pth omits the script directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from taobao_stock.batch import BatchAdapter
from taobao_stock.browser import SHOP_NAME
from taobao_stock.errors import SessionError, ShopMismatch
from taobao_stock.session import load_shop_binding, save_shop_binding
from taobao_stock.workflow import EXPECTED_SHOP, create_job, find_jobs, run_job

START_URL = 'https://myseller.taobao.com/home.htm/SellManage/on_sale?current=1&pageSize=20'
LOGIN_HOSTS = {'myseller.taobao.com', 'loginmyseller.taobao.com',
               'login.taobao.com', 'havanalogin.taobao.com'}
DATA_ROOT = Path(os.environ['STOCK_DATA_ROOT']).expanduser().resolve()
PROFILE = DATA_ROOT / '.browser-profile' / 'er-dian'
CHROME = os.environ['STOCK_BROWSER_BIN']
OUTPUT = sys.stdout


def emit(kind, **data):
    OUTPUT.write(json.dumps(dict(kind=kind, **data), ensure_ascii=False) + '\n')
    OUTPUT.flush()


class Worker:
    def __init__(self):
        self.playwright = None
        self.context = None
        self.page = None
        self.page_loaded = False

    async def open_browser(self):
        if self.page is not None and not self.page.is_closed():
            await self.page.bring_to_front()
            if not self.page_loaded or not self.at_login_entry():
                await self.load_login_entry()
            return
        if self.context is not None:
            await self.context.close()
            self.context = None
        if self.playwright is not None:
            await self.playwright.stop()
            self.playwright = None
        PROFILE.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.playwright = await async_playwright().start()
        try:
            self.context = await self.playwright.chromium.launch_persistent_context(
                str(PROFILE), executable_path=CHROME, headless=False, viewport=None,
                locale='zh-CN', accept_downloads=False, timeout=20000,
                args=['--no-first-run', '--no-default-browser-check'],
            )
        except BrowserError:
            raise SessionError('二店浏览器启动失败。请检查 Chrome 或 Edge 是否可打开，并关闭占用本工具登录档案的窗口后重试。') from None
        self.context.set_default_timeout(15000)
        self.page = self.context.pages[0] if self.context.pages else await self.context.new_page()
        await self.load_login_entry()

    def at_login_entry(self):
        url = urlsplit(self.page.url)
        return url.scheme == 'https' and url.hostname in LOGIN_HOSTS

    async def load_login_entry(self):
        self.page_loaded = False
        try:
            response = await self.page.goto(START_URL, wait_until='domcontentloaded', timeout=15000)
        except BrowserError:
            raise SessionError('二店页面未能加载。请检查网络后，再点“打开二店登录”重试。') from None
        if not self.at_login_entry() or (response is not None and response.status >= 400):
            raise SessionError('浏览器未到达千牛或淘宝登录页。请检查网络后重试。')
        self.page_loaded = True

    async def close(self):
        if self.context is not None:
            await self.context.close()
        if self.playwright is not None:
            await self.playwright.stop()

    async def handle(self, command):
        action = command.get('action')
        if action == 'login':
            await self.open_browser()
            return {'message': '已打开二店专用浏览器。请登录“%s”，完成验证后点“检查登录”。' % SHOP_NAME}
        if action == 'verify-login':
            await self.open_browser()
            adapter = BatchAdapter(self.page, EXPECTED_SHOP)
            shop = await adapter.verify_shop()
            existing = load_shop_binding(DATA_ROOT)
            if existing is not None and existing != shop:
                raise ShopMismatch('本机已绑定另一店铺，登录校验未通过。')
            save_shop_binding(DATA_ROOT, shop)
            return {'message': '登录有效，已确认店铺“%s”。' % shop['name']}
        if action == 'start':
            excel = Path(command.get('excel', '')).expanduser().resolve()
            job = create_job(DATA_ROOT, excel)
            emit('progress', message='已读取并校验库存表，开始查询商品。')
            return await self.run(job)
        if action == 'resume':
            job = Path(command.get('run_dir', '')).expanduser().resolve()
            return await self.run(job)
        if action == 'jobs':
            return {'jobs': find_jobs(DATA_ROOT)}
        if action == 'report':
            jobs = find_jobs(DATA_ROOT)
            if not jobs:
                raise ValueError('还没有库存同步报告。')
            return {'report_path': jobs[0]['report_path']}
        if action == 'shutdown':
            return {'shutdown': True}
        raise ValueError('未知库存同步操作。')

    async def run(self, job):
        await self.open_browser()
        binding = load_shop_binding(DATA_ROOT)
        adapter = BatchAdapter(self.page, binding)
        result = await run_job(DATA_ROOT, job, adapter=adapter,
                               on_event=lambda event, info: emit('progress',
                                   message=self.progress_message(event, info)))
        return {'status': result['status'], 'job_dir': result['run_dir'],
                'report_path': result['report_path'],
                'summary': self.summary(result), 'pause_reason': result.get('pause_reason')}

    @staticmethod
    def progress_message(event, info):
        if event == 'progress':
            looked_up = info.get('looked_up')
            if looked_up is not None:
                return '正在匹配商品 %s/%s' % (looked_up, info.get('product_count', '?'))
            return '正在读取并核验商品库存。'
        if event == 'execution_started':
            return '预览完成，开始逐个商品同步库存。'
        if event == 'finished':
            return '库存同步结束，正在打开简洁报告。'
        return '库存同步处理中。'

    @staticmethod
    def summary(result):
        labels = {'listed': '已上架', 'zero_stock': '全零留库', 'skipped': '跳过',
                  'failed': '失败', 'pending': '待处理'}
        counts = {value: 0 for value in labels}
        for item in result.get('items', []):
            key = item.get('result')
            if key in counts:
                counts[key] += 1
        counts['未匹配款'] = len(result.get('unmatched_products', []))
        return counts


async def serve():
    DATA_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    worker = Worker()
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            command = {}
            try:
                command = json.loads(line)
                with contextlib.redirect_stdout(sys.stderr):
                    result = await worker.handle(command)
                emit('result', request_id=command.get('request_id'), data=result)
                if result.get('shutdown'):
                    break
            except Exception as error:
                emit('error', request_id=command.get('request_id') if isinstance(command, dict) else None,
                     message=str(error) if isinstance(error, (ValueError, SessionError)) else
                     '库存同步任务中断（%s）。请查看简洁报告和运行环境。' % type(error).__name__)
    finally:
        await worker.close()


if __name__ == '__main__':
    asyncio.run(serve())
