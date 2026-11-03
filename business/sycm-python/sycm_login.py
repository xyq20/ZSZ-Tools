#!/usr/bin/env python3
"""Manual 生意参谋 login. Do not auto-fill or drag the captcha.

Opens the project Chrome profile. After you log in yourself, cookies are
saved to auth/chrome_profile and auth/sycm_state.json.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout.reconfigure(line_buffering=True)

from sycm_browser import (  # noqa: E402
    SYCM_HOME,
    is_logged_in,
    launch_context,
    save_login,
    wait_for_login,
)
from playwright.sync_api import sync_playwright


def main() -> int:
    print("正在打开 Chrome。请你自己在窗口里登录生意参谋。")
    print("我不会自动填账号，也不会拖滑块。登录成功后我会保存登录态。")
    print("不要关掉这个窗口。")
    with sync_playwright() as playwright:
        context = launch_context(playwright, stealth=True)
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(SYCM_HOME, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(1500)
        if is_logged_in(page):
            path = save_login(context)
            print(f"已检测到登录态，已保存: {path}")
            context.close()
            return 0
        print("未登录。请在窗口完成淘宝/生意参谋登录，最多等待 15 分钟。")
        ok = wait_for_login(page, timeout_sec=900)
        if not ok:
            print("等待登录超时。请重新运行: python3 scripts/sycm_login.py")
            context.close()
            return 1
        path = save_login(context)
        print(f"登录已保存: {path}")
        print(f"Chrome 配置目录: {path.parent / 'chrome_profile'}")
        context.close()
        print("窗口已关闭。之后抓取会带上这次登录信息。")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
