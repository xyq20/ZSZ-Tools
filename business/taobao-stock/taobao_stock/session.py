"""A dedicated, persistent Chrome session; never borrow another shop's profile."""

import asyncio
import contextlib
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

from .errors import SessionError, ShopMismatch


SHOP_NAME = '中古Remake商店'
DEFAULT_PORT = 9235
START_URL = 'https://myseller.taobao.com/home.htm/SellManage/on_sale?current=1&pageSize=20'
CHROME_CANDIDATES = (
    Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    Path.home() / 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    Path('/Applications/Chromium.app/Contents/MacOS/Chromium'),
)


def _private_dir(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)
    return path


@contextlib.contextmanager
def run_lock(root):
    """Prevent two CLI runs from changing the same browser/shop concurrently."""
    runtime = _private_dir(Path(root).resolve() / '.runtime')
    fd = os.open(str(runtime / 'run.lock'), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        if os.name != 'nt':
            os.fchmod(fd, 0o600)
        try:
            if os.name == 'nt':
                import msvcrt
                os.lseek(fd, 0, os.SEEK_SET)
                if os.fstat(fd).st_size == 0:
                    os.write(fd, b'0')
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, OSError):
            raise SessionError('已有库存任务正在运行；请等待结束，勿同时执行。') from None
        try:
            yield
        finally:
            if os.name == 'nt':
                import msvcrt
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _clean_shop(shop):
    if not isinstance(shop, dict) or shop.get('name') != SHOP_NAME:
        raise ShopMismatch('店铺不是“中古Remake商店”，拒绝保存或使用登录绑定。')
    value = shop.get('shop_id')
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ShopMismatch('未读取到有效店铺 ID，不能绑定账号。')
    shop_id = str(value).strip()
    if not re.fullmatch(r'[1-9][0-9]*', shop_id):
        raise ShopMismatch('未读取到有效店铺 ID，不能绑定账号。')
    return {'name': SHOP_NAME, 'shop_id': shop_id}


def load_shop_binding(root):
    path = Path(root).resolve() / '.runtime' / 'shop.json'
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise ShopMismatch('店铺绑定文件损坏，请核对后修复，不能自动重绑。') from exc
    return _clean_shop(data)


def save_shop_binding(root, shop):
    """Persist only verified identity, never cookies or request credentials."""
    identity = _clean_shop(shop)
    runtime = _private_dir(Path(root).resolve() / '.runtime')
    path = runtime / 'shop.json'
    existing = load_shop_binding(root)
    if existing is not None and existing != identity:
        raise ShopMismatch('当前店铺 ID 与首次绑定不一致，已停止；不会自动替换绑定。')
    fd, temp_name = tempfile.mkstemp(prefix='.shop-', suffix='.tmp', dir=str(runtime))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            json.dump(identity, output, ensure_ascii=False, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, str(path))
        if os.name != 'nt':
            directory_fd = os.open(str(runtime), os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return identity


def _listener_pids(port):
    lsof = shutil.which('lsof') or '/usr/sbin/lsof'
    try:
        result = subprocess.run(
            [lsof, '-nP', '-iTCP:%d' % port, '-sTCP:LISTEN', '-Fp'],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise SessionError('无法检查专用 Chrome 调试端口的归属。') from exc
    if result.returncode not in (0, 1) or (result.returncode == 1 and result.stderr.strip()):
        raise SessionError('无法检查专用 Chrome 调试端口的归属。')
    return {int(line[1:]) for line in result.stdout.splitlines()
            if re.fullmatch(r'p[0-9]+', line)}


def _port_open(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.3):
            return True
    except OSError:
        return False


def _is_expected_command(command, profile, port):
    """ps prints unquoted arguments, so compare a complete flag with boundaries."""
    if not any(command.startswith(str(path) + ' ') for path in CHROME_CANDIDATES):
        return False
    if len(re.findall(r'(?:^|\s)--user-data-dir(?:=|\s)', command)) != 1:
        return False
    if len(re.findall(r'(?:^|\s)--remote-debugging-port(?:=|\s)', command)) != 1:
        return False
    profile_flag = r'(?:^|\s)--user-data-dir=' + re.escape(str(profile)) + r'(?=\s--|\shttps?://|\sabout:|$)'
    port_flag = r'(?:^|\s)--remote-debugging-port=' + str(port) + r'(?=\s|$)'
    return bool(re.search(profile_flag, command) and re.search(port_flag, command))


def _verify_listener(port, profile):
    pids = _listener_pids(port)
    if not pids:
        if _port_open(port):
            raise SessionError('调试端口已占用但无法确认归属，拒绝连接。')
        return False
    if len(pids) != 1:
        raise SessionError('调试端口有多个监听进程，拒绝连接。')
    try:
        result = subprocess.run(
            ['ps', '-ww', '-p', str(next(iter(pids))), '-o', 'command='],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise SessionError('无法确认 Chrome 用户目录，拒绝连接。') from exc
    if result.returncode != 0 or not _is_expected_command(result.stdout.strip(), profile, port):
        raise SessionError('调试端口不属于本项目的二店专用 Chrome，拒绝连接。')
    return True


def _ensure_browser(root, port):
    if isinstance(port, bool) or not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError('调试端口必须是 1024 至 65535 的整数。')
    if port == 9222:
        raise SessionError('9222 属于其他浏览器会话，禁止用于本项目。')
    root = Path(root).resolve()
    profile_parent = _private_dir(root / '.browser-profile')
    profile = _private_dir(profile_parent / 'er-dian')
    if _verify_listener(port, profile):
        return
    chrome = next((path for path in CHROME_CANDIDATES if path.is_file()), None)
    if chrome is None:
        raise SessionError('未找到 Google Chrome，请先安装 Chrome。')
    # A detached process deliberately survives Playwright disconnection and CLI exit.
    subprocess.Popen(
        [str(chrome), '--remote-debugging-port=%d' % port,
         '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + str(profile),
         '--no-first-run', '--no-default-browser-check', START_URL],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True, close_fds=True,
    )
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if _verify_listener(port, profile):
            return
        time.sleep(0.2)
    raise SessionError('专用 Chrome 启动超时；请检查是否已有该用户目录的 Chrome 占用。')


def _target_page(pages):
    for hostname in ('myseller.taobao.com', 'loginmyseller.taobao.com'):
        for page in reversed(pages):
            parsed = urlparse(page.url)
            if parsed.scheme == 'https' and parsed.hostname == hostname:
                return page
    return None


@contextlib.asynccontextmanager
async def browser_session(root, port=DEFAULT_PORT):
    """Yield the shop page, retaining the Chrome process and on-disk login state."""
    from playwright.async_api import async_playwright

    root = Path(root).resolve()
    await asyncio.to_thread(_ensure_browser, root, port)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.connect_over_cdp('http://127.0.0.1:%d' % port)
        if len(browser.contexts) != 1:
            raise SessionError('专用 Chrome 上下文异常，已停止。')
        context = browser.contexts[0]
        page = _target_page(context.pages)
        if page is None:
            page = await context.new_page()
            await page.goto(START_URL, wait_until='domcontentloaded')
        page.set_default_timeout(15000)
        page.set_default_navigation_timeout(45000)
        yield page
        # Do not browser.close(): this is an attached, persistent browser.
        # Exiting async_playwright disconnects our transport only.
