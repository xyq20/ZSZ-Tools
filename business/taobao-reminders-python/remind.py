#!/usr/bin/env python3
"""Report Taobao product-age patrol results to Feishu."""

import argparse
from dataclasses import dataclass
from datetime import date, datetime, timedelta
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from time import sleep
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zoneinfo import ZoneInfo


# Windows embedded Python's ._pth omits the entry script's directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))

LOCAL = Path(os.environ.get("TAOBAO_REMINDER_STATE_DIR") or
             Path.home() / "Library" / "Application Support" / "TaobaoProductReminders" / "state")
BEIJING = ZoneInfo("Asia/Shanghai")
MILESTONES = (7, 15)
MAX_PRODUCT_AGE_DAYS = 16


@dataclass(frozen=True)
class Product:
    item_id: str
    title: str
    created_at: datetime
    code: str = ""

    @classmethod
    def from_record(cls, row):
        item_id = str(row["item_id"])
        if not re.fullmatch(r"[0-9]+", item_id):
            raise ValueError("商品 ID 格式不正确")
        created_at = datetime.fromisoformat(row["created_at"])
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=BEIJING)
        return cls(item_id, str(row["title"]), created_at.astimezone(BEIJING),
                   str(row.get("code") or ""))


def due_groups(products, first_day, today, recorded):
    groups = {}
    for item in products:
        for age in MILESTONES:
            due = item.created_at.date() + timedelta(days=age)
            if first_day <= due <= today and (item.item_id, age) not in recorded:
                groups.setdefault((due, age), []).append(item)
    return sorted(groups.items())


def clean_text(value, limit):
    return " ".join(value.split()).translate(str.maketrans("<>", "＜＞"))[:limit]


def message(due, age, items, mention, part, parts):
    suffix = f"（{part}/{parts}）" if parts > 1 else ""
    lines = [f"【淘宝商品满 {age} 天提醒】{suffix}", f"{mention}，以下商品于 {due:%Y-%m-%d} 创建满 {age} 天。"]
    for item in items:
        details = [f"商品 ID {item.item_id}"]
        if item.code:
            details.append(f"商家编码 {clean_text(item.code, 80)}")
        details.append(f"创建于 {item.created_at:%Y-%m-%d %H:%M}")
        lines.extend((clean_text(item.title, 180) or "（无商品标题）", " · ".join(details)))
    return "\n".join(lines)


def empty_message(today, product_count, mention):
    return (
        f"【淘宝商品巡检】\n{mention}，{today:%Y-%m-%d} 已巡检 {product_count} 件近期创建的商品。\n"
        "本次没有需要发送的满 7 天或满 15 天提醒。"
    )


class WebhookRejected(RuntimeError):
    """Feishu explicitly rejected the request."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def send_webhook(webhook, text):
    data = json.dumps({
        "msg_type": "text",
        "content": {"text": text},
    }, ensure_ascii=False).encode()
    request = Request(webhook, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with build_opener(NoRedirect).open(request, timeout=20) as response:
            result = json.load(response)
    except (OSError, ValueError) as error:
        raise RuntimeError("飞书发送结果未知，已保留本批次记录，避免重复发送") from error
    if not isinstance(result, dict):
        raise RuntimeError("飞书返回格式未知，已保留本批次记录")
    code = result.get("code", result.get("StatusCode"))
    if type(code) is not int or code != 0:
        if type(code) is int and code > 0:
            raise WebhookRejected(f"飞书拒绝发送，错误码 {code}")
        raise RuntimeError("飞书返回状态未知，已保留本批次记录")


def open_ledger():
    db = sqlite3.connect(LOCAL / "reminders.sqlite3")
    db.execute("""
        CREATE TABLE IF NOT EXISTS delivery (
            item_id TEXT NOT NULL,
            age INTEGER NOT NULL,
            due DATE NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('sending', 'sent')),
            PRIMARY KEY (item_id, age)
        )
    """)
    db.execute("CREATE TABLE IF NOT EXISTS progress (checked_through DATE)")
    db.execute("CREATE TABLE IF NOT EXISTS empty_notice_pending (notice_day DATE PRIMARY KEY NOT NULL)")
    db.commit()
    return db


def send_empty_notice(db, webhook, today, content):
    day = today.isoformat()
    with db:
        inserted = db.execute("INSERT OR IGNORE INTO empty_notice_pending VALUES (?)", (day,))
    if inserted.rowcount == 0:
        raise RuntimeError("今天的无到期提醒通知发送结果待核实，请先核对飞书群消息")
    try:
        send_webhook(webhook, content)
    except WebhookRejected:
        with db:
            db.execute("DELETE FROM empty_notice_pending WHERE notice_day = ?", (day,))
        raise


def lock_run(lock):
    if sys.platform == "win32":
        import msvcrt
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)


def read_products(oldest, fixture=None):
    if fixture:
        rows = json.loads(fixture.read_text())
    else:
        from qianniu import fetch_products
        rows = fetch_products(oldest)

    products = {}
    for row in rows:
        item = Product.from_record(row)
        if item.created_at.date() < oldest:
            continue
        if item.item_id in products and item.created_at != products[item.item_id].created_at:
            raise ValueError(f"同一商品的创建时间不一致，商品 ID {item.item_id}")
        products[item.item_id] = item
    return products.values()


def run(db, args, today):
    progress = db.execute("SELECT checked_through FROM progress").fetchone()
    first_day = date.fromisoformat(progress[0]) + timedelta(days=1) if progress else today
    if args.fixture or ((args.dry_run or args.run_now) and first_day > today):
        first_day = today
    if first_day > today:
        print("今天的商品已巡检")
        return

    if not args.dry_run and db.execute("SELECT 1 FROM delivery WHERE state='sending'").fetchone():
        raise RuntimeError("有发送结果待核实的飞书提醒，请先核对群消息和本地发送记录")

    recipient_path = LOCAL / "recipient-id"
    recipient = args.settings.get("recipient")
    if recipient is None:
        recipient = recipient_path.read_text(encoding="utf-8").strip() if recipient_path.is_file() else ""
    if recipient and (recipient.lower() == "all" or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", recipient)):
        raise ValueError("小谭的飞书用户 ID 格式不正确")
    mention = "@小谭"
    if not args.dry_run:
        if not recipient:
            raise ValueError("请先配置小谭的飞书用户 ID")
        mention = f'<at user_id="{recipient}">小谭</at>'
        webhook = args.settings.get("webhook")
        if webhook is None:
            webhook = (LOCAL / "webhook").read_text(encoding="utf-8").strip()
        if not re.fullmatch(r"https://open\.feishu\.cn/open-apis/bot/v2/hook/[0-9a-f-]+", webhook):
            raise ValueError("飞书 Webhook 地址格式不正确")
        if not progress:
            with db:
                db.execute("INSERT INTO progress VALUES (?)", ((today - timedelta(days=1)).isoformat(),))

    products = read_products(today - timedelta(days=MAX_PRODUCT_AGE_DAYS), args.fixture)
    recorded = {(row[0], row[1]) for row in db.execute("SELECT item_id, age FROM delivery")}
    groups = due_groups(products, first_day, today, recorded)

    if not groups:
        content = empty_message(today, len(products), mention)
        if args.dry_run:
            print(content, end="\n\n")
        else:
            send_empty_notice(db, webhook, today, content)

    for (due, age), items in groups:
        batches = [items[i:i + 10] for i in range(0, len(items), 10)]
        for part, batch in enumerate(batches, 1):
            content = message(due, age, batch, mention, part, len(batches))
            if args.dry_run:
                print(content, end="\n\n")
                continue
            keys = [(item.item_id, age) for item in batch]
            with db:
                db.executemany(
                    "INSERT INTO delivery VALUES (?, ?, ?, 'sending')",
                    [(item_id, milestone, due.isoformat()) for item_id, milestone in keys],
                )
            try:
                send_webhook(webhook, content)
            except WebhookRejected:
                with db:
                    db.executemany("DELETE FROM delivery WHERE item_id=? AND age=?", keys)
                raise
            with db:
                db.executemany("UPDATE delivery SET state='sent' WHERE item_id=? AND age=?", keys)
            sleep(0.25)

    if not args.dry_run:
        with db:
            db.execute("DELETE FROM empty_notice_pending WHERE notice_day = ?", (today.isoformat(),))
            if not progress or progress[0] < today.isoformat():
                db.execute("DELETE FROM progress")
                db.execute("INSERT INTO progress VALUES (?)", (today.isoformat(),))
        print("已发送本次巡检结果到飞书")
    print(f"{first_day} 至 {today}，商品 {len(products)} 件，到期提醒 {sum(len(items) for _, items in groups)} 条")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="预览，跳过飞书发送和巡检进度更新")
    parser.add_argument("--run-now", action="store_true", help="手动巡检，即使今天已经巡检")
    parser.add_argument("--fixture", type=Path, help="从本地 JSON 验证提醒规则，只能用于预览")
    parser.add_argument("--date", type=date.fromisoformat, help="预览指定日期，仅接受测试数据")
    parser.add_argument("--settings-stdin", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if (args.fixture and not args.dry_run) or (args.date and not args.fixture):
        parser.error("指定测试数据时须启用 --dry-run，指定日期时须提供测试数据")

    LOCAL.mkdir(mode=0o700, parents=True, exist_ok=True)
    today = args.date or datetime.now(BEIJING).date()
    try:
        args.settings = json.load(sys.stdin) if args.settings_stdin else {}
        if not isinstance(args.settings, dict) or any(
            value is not None and not isinstance(value, str) for value in args.settings.values()
        ):
            raise ValueError("提醒配置格式不正确")
        with (LOCAL / "run.lock").open("a+b") as lock:
            try:
                lock_run(lock)
            except OSError as error:
                raise RuntimeError("已有淘宝巡检在运行，请稍后重试") from error
            db = open_ledger()
            try:
                run(db, args, today)
            finally:
                db.close()
    except (RuntimeError, ValueError, OSError, sqlite3.Error) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
