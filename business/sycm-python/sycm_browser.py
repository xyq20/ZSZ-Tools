#!/usr/bin/env python3
"""Open the project Chrome profile for API-only 生意参谋 collection.

This module deliberately contains no automated page-clicking, keyboard input,
popup dismissal, or slider handling. Login, when required, is completed by the
user in the dedicated Chrome window; the collector only observes login state.
"""
from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator
from sycm_time import beijing_now

from playwright.sync_api import BrowserContext, Page, Playwright, sync_playwright

ROOT = Path(os.environ.get("SYCM_DATA_DIR", Path(__file__).resolve().parent.parent)).resolve()
AUTH_DIR = Path(os.environ.get("SYCM_AUTH_DIR", ROOT / "auth"))
PROFILE_DIR = AUTH_DIR / "chrome_profile"
STATE_FILE = AUTH_DIR / "sycm_state.json"
SYCM_HOME = "https://sycm.taobao.com/"
SYCM_ITEM_RANK = "https://sycm.taobao.com/cc/item_rank?dateType=recent7"
CHROME_BIN = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
CDP_PORT = 9333
CHROME_LAUNCH_ARGS = [
    "--no-first-run",
    "--no-default-browser-check",
    "--no-restore-last-session",
    "--disable-session-crashed-bubble",
    "--disable-features=ChromeWhatsNewUI",
    "--lang=zh-CN",
    "--window-size=1512,945",
]

# Limit this to passive browser-fingerprint cleanup. It performs no interaction.
STEALTH_JS = """
(() => {
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch (e) {}
  try {
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) {
      window.chrome.runtime = { connect: function() {}, sendMessage: function() {} };
    }
  } catch (e) {}
  try {
    const langs = ['zh-CN', 'zh', 'en-US', 'en'];
    Object.defineProperty(Navigator.prototype, 'language', { get: () => 'zh-CN', configurable: true });
    Object.defineProperty(Navigator.prototype, 'languages', { get: () => langs, configurable: true });
  } catch (e) {}
  try {
    for (const key of Object.getOwnPropertyNames(window)) {
      if (/^(cdc_|__playwright|__pw_|__webdriver_)/.test(key)) {
        try { delete window[key]; } catch (e) {}
      }
    }
  } catch (e) {}
})();
"""

CAPTCHA_HINTS = (
    "请拖动下方滑块",
    "请按住滑块",
    "滑块验证",
    "拖动到最右边",
    "完成验证",
    "点击框体重试",
)

_CHROME_PROC: subprocess.Popen | None = None


def _clear_profile_locks() -> None:
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        lock = PROFILE_DIR / name
        if lock.exists() or lock.is_symlink():
            lock.unlink()


def chrome_spawn_args(*, remote_debug: bool = True) -> list[str]:
    if not CHROME_BIN.exists():
        raise FileNotFoundError(f"找不到本机 Chrome: {CHROME_BIN}")
    args = [str(CHROME_BIN), f"--user-data-dir={PROFILE_DIR}", *CHROME_LAUNCH_ARGS]
    if remote_debug:
        args.append(f"--remote-debugging-port={CDP_PORT}")
        args.append("--remote-debugging-address=127.0.0.1")
    return args


def _stop_profile_chrome() -> None:
    global _CHROME_PROC
    if _CHROME_PROC is not None and _CHROME_PROC.poll() is None:
        _CHROME_PROC.terminate()
        try:
            _CHROME_PROC.wait(timeout=5)
        except Exception:
            _CHROME_PROC.kill()
    _CHROME_PROC = None
    subprocess.run(
        ["pkill", "-f", f"--user-data-dir={PROFILE_DIR}"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(0.6)
    _clear_profile_locks()


def _wait_cdp(timeout_sec: float = 20.0) -> None:
    url = f"http://127.0.0.1:{CDP_PORT}/json/version"
    deadline = time.time() + timeout_sec
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as resp:
                if getattr(resp, "status", 200) == 200:
                    return
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
        time.sleep(0.25)
    raise RuntimeError(f"Chrome CDP 未就绪: {last}")


def is_logged_in(page: Page) -> bool:
    try:
        url = page.url or ""
    except Exception:
        return False
    if any(x in url for x in ("login.taobao.com", "login.tmall.com", "passport.taobao.com")):
        return False
    if "sycm.taobao.com" not in url:
        return False
    try:
        info = page.evaluate(
            """() => {
              const text = document.body ? document.body.innerText : '';
              return {
                hasLogout: text.includes('退出'),
                hasShop: /NEIGBORL|主店|商品排行|数据概览|生意参谋/.test(text),
                needLogin: /淘宝账号登录|免费登录/.test(text) && !text.includes('退出'),
              };
            }"""
        )
    except Exception:
        return False
    if info.get("needLogin"):
        return False
    return bool(info.get("hasLogout") and info.get("hasShop"))


def slider_visible(page: Page) -> bool:
    """Read-only slider detection. Never attempts to solve or dismiss it."""
    try:
        for frame in [page, *page.frames]:
            try:
                body = frame.locator("body")
                if not body.is_visible():
                    continue
                text = body.inner_text(timeout=300)
            except Exception:
                text = ""
            if any(hint in text for hint in CAPTCHA_HINTS):
                return True
            for selector in ("#nc_1_n1z", ".btn_slide", "[id$='_n1z']"):
                try:
                    loc = frame.locator(selector)
                    if loc.count() and loc.first.is_visible():
                        return True
                except Exception:
                    continue
    except Exception:
        return False
    return False


def wait_for_manual_slider(page: Page, timeout_sec: int | None = None) -> bool:
    """Wait for the user to solve a visible slider; never interacts with it."""
    if not slider_visible(page):
        return True
    print("检测到滑块，程序不点击、不拖动，等待你手动通过…")
    deadline = time.time() + timeout_sec if timeout_sec is not None else None
    while deadline is None or time.time() < deadline:
        try:
            if page.is_closed():
                return False
            page.wait_for_timeout(1000)
        except Exception:
            return False
        if not slider_visible(page):
            print("已检测到手动验证通过，继续纯接口抓取")
            return True
    print("等待手动滑块验证超时")
    return False


def save_login(context: BrowserContext) -> Path:
    AUTH_DIR.mkdir(parents=True, exist_ok=True)
    context.storage_state(path=str(STATE_FILE))
    meta = {
        "saved_at": beijing_now().isoformat(timespec='seconds'),
        "state_file": str(STATE_FILE),
        "profile_dir": str(PROFILE_DIR),
        "cookie_count": len(json.loads(STATE_FILE.read_text()).get("cookies") or []),
    }
    (AUTH_DIR / "login_meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return STATE_FILE


def _restore_cookies(context: BrowserContext) -> int:
    if not STATE_FILE.exists():
        return 0
    try:
        state = json.loads(STATE_FILE.read_text())
    except Exception:
        return 0
    cookies = state.get("cookies") or []
    added = 0
    for cookie in cookies:
        item = {
            "name": cookie.get("name"),
            "value": cookie.get("value"),
            "domain": cookie.get("domain") or "",
            "path": cookie.get("path") or "/",
        }
        if not item["name"] or item["value"] is None:
            continue
        if cookie.get("expires") not in (None, -1):
            item["expires"] = cookie["expires"]
        if cookie.get("httpOnly"):
            item["httpOnly"] = True
        if cookie.get("secure"):
            item["secure"] = True
        same_site = cookie.get("sameSite")
        if same_site in ("Strict", "Lax", "None"):
            item["sameSite"] = same_site
        try:
            context.add_cookies([item])
            added += 1
        except Exception:
            continue
    return added


def _enable_password_manager() -> None:
    prefs_path = PROFILE_DIR / "Default" / "Preferences"
    prefs_path.parent.mkdir(parents=True, exist_ok=True)
    prefs: dict = {}
    if prefs_path.exists():
        try:
            prefs = json.loads(prefs_path.read_text(encoding="utf-8"))
        except Exception:
            prefs = {}
    prefs.setdefault("credentials_enable_service", True)
    profile = prefs.setdefault("profile", {})
    profile["password_manager_enabled"] = True
    profile["password_manager_leak_detection"] = False
    prefs_path.write_text(json.dumps(prefs, ensure_ascii=False), encoding="utf-8")


def wait_for_login(page: Page, timeout_sec: int = 600) -> bool:
    deadline = time.time() + timeout_sec
    last_note = 0.0
    while time.time() < deadline:
        if is_logged_in(page):
            return True
        now = time.time()
        if now - last_note > 15:
            print("  还在等你在窗口里登录生意参谋…")
            last_note = now
        time.sleep(2)
    return False


def ensure_logged_in(page: Page, context: BrowserContext, timeout_sec: int = 600) -> bool:
    if is_logged_in(page):
        save_login(context)
        return True
    print("未登录。请在这个抓取窗口自己完成淘宝/生意参谋登录。")
    print("程序不点击页面、不填账号、不拖滑块；只等待你手动登录。")
    ok = wait_for_login(page, timeout_sec=timeout_sec)
    if ok:
        save_login(context)
    return ok


def launch_context(
    playwright: Playwright,
    *,
    remote_debug: bool = True,
    stealth: bool = True,
) -> BrowserContext:
    """Open real Google Chrome with the project profile, then attach over CDP."""
    global _CHROME_PROC
    if os.environ.get("SYCM_AUTH_DIR"):
        # Toolkit owns a separate persistent profile; Playwright owns its process.
        # Avoid the standalone script's fixed CDP port and profile-wide pkill.
        context = playwright.chromium.launch_persistent_context(
            str(PROFILE_DIR), executable_path=os.environ.get("SYCM_CHROME_BIN", str(CHROME_BIN)),
            headless=False, args=CHROME_LAUNCH_ARGS, no_viewport=True,
        )
        if stealth:
            context.add_init_script(STEALTH_JS)
        return context
    _stop_profile_chrome()
    _enable_password_manager()
    _CHROME_PROC = subprocess.Popen(
        chrome_spawn_args(remote_debug=remote_debug),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        _wait_cdp()
        browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP_PORT}")
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        if stealth:
            context.add_init_script(STEALTH_JS)
        restored = _restore_cookies(context)
        if restored:
            print(f"已从 sycm_state.json 恢复 {restored} 条 cookie")

        orig_close = context.close

        def _close() -> None:
            try:
                orig_close()
            except Exception:
                pass
            try:
                browser.close()
            except Exception:
                pass
            _stop_profile_chrome()

        context.close = _close  # type: ignore[method-assign]
        return context
    except Exception:
        _stop_profile_chrome()
        raise


@contextmanager
def open_sycm(start_url: str = SYCM_ITEM_RANK) -> Iterator[tuple[BrowserContext, Page]]:
    with sync_playwright() as playwright:
        context = launch_context(playwright, stealth=True)
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(start_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(1500)
        try:
            yield context, page
        finally:
            try:
                if is_logged_in(page):
                    save_login(context)
            except Exception:
                pass
            context.close()
