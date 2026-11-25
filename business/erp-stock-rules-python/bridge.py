"""Handle tools launched from the desktop via JSON lines."""

from dataclasses import asdict
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from upload_rules import (
    ACCOUNT_FINGERPRINT_PREFIX, catalog_fingerprint, collect_rules, export_rules, open_browser, reach_rules_page,
    run_batch, select_rules, session_fingerprint,
)


def send(kind, data):
    print(json.dumps({"type": kind, "data": data}, ensure_ascii=False), flush=True)


def announce(message):
    send("progress", {"message": message})


def report_row(message, row):
    send("progress", {"message": message, "row": row})


def execute(job):
    action = job["action"]
    if action not in {"list", "preview", "upload"}:
        raise ValueError("未知的库存规则操作。")
    if action != "list" and not job.get("session", "").startswith(ACCOUNT_FINGERPRINT_PREFIX):
        raise RuntimeError("旧版账号核对记录已过期。请重新读取规则，再确认要执行的操作。")
    with open_browser(Path(job["profile"]), announce) as page:
        panel = reach_rules_page(page, announce, job.get("cookies", ()), allow_login=action == "list")
        session = session_fingerprint(page)
        rules, columns, last_page = collect_rules(panel)
        if session != session_fingerprint(page):
            raise RuntimeError("读取期间快麦登录账号已变化，请重新读取规则。")
        fingerprint = catalog_fingerprint(rules, page.url)
        if action == "list":
            export_rules(rules, Path(job["output"]))
            return {
                "rules": [dict(asdict(rule), number=number) for number, rule in enumerate(rules, 1)],
                "fingerprint": fingerprint,
                "session": session,
            }
        if session != job["session"]:
            raise RuntimeError("快麦账号与上次核对记录不一致，本批未提交。请重新读取规则并确认当前账号。")
        if fingerprint != job["fingerprint"]:
            raise RuntimeError("快麦规则清单已变化，本批未提交。请刷新清单后重新选择。")
        selected = select_rules(rules, job["numbers"])
        return run_batch(panel, selected, last_page, columns, action == "preview", announce,
                         expected_session=session, on_row=report_row)


if __name__ == "__main__":
    try:
        send("result", {"ok": True, "value": execute(json.load(sys.stdin))})
    except Exception as error:
        send("result", {"ok": False, "error": str(error)})
        sys.exit(1)
