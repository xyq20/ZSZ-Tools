#!/usr/bin/env python3
"""抓取生意参谋并写入当前目录的分级总表。不碰共享盘。"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.stdout.reconfigure(line_buffering=True)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from sycm_round import prepare_round, checkpoint
from sycm_lock import run_lock

from excel_patch import (  # noqa: E402
    NAME_COLORS,
    SELECTED_COLORS,
    apply_results,
    backup_book,
    bak_path,
    fallback_path,
    find_workbook,
    update_workbook_month,
    list_catalog,
    normalize_color,
    resolve_book,
    spreadsheet_lock_reason,
    _dbg,
)
from sycm_browser import ensure_logged_in, open_sycm, slider_visible, wait_for_manual_slider  # noqa: E402
from sycm_collect import (  # noqa: E402
    browser_closed,
    collect_product_parts,
    recent7_range,
    recent30_range,
)

ROOT = Path(os.environ.get("SYCM_DATA_DIR", Path(__file__).resolve().parent.parent)).resolve()
LAST_RUN = ROOT / "output" / "sycm" / "last_run.json"
LAST_RUN_PIC = LAST_RUN.with_name("last_run_main_pic.json")
LAST_RUN_FLOW = LAST_RUN.with_name("last_run_flow.json")
PROGRESS = LAST_RUN.with_name("progress.json")
ITEM_REQUEST_INTERVAL_MS = 2500

MODE_ALIASES = {
    "all": "all",
    "full": "all",
    "全部": "all",
    "完整": "all",
    "charts": "charts",
    "chart": "charts",
    "api": "charts",
    "曲线": "charts",
    "main-pic": "main-pic",
    "main_pic": "main-pic",
    "mainpic": "main-pic",
    "pic": "main-pic",
    "主图": "main-pic",
    "主图分析": "main-pic",
    "flow": "flow",
    "flows": "flow",
    "流量": "flow",
    "流量来源": "flow",
    "渠道": "flow",
}


def normalize_mode(value: str) -> str:
    raw = (value or "all").strip()
    mapped = MODE_ALIASES.get(raw.lower()) or MODE_ALIASES.get(raw)
    if mapped not in ("all", "charts", "main-pic", "flow"):
        raise ValueError(f"不认识的模式: {value}。可用: all, charts, main-pic, flow")
    return mapped


def last_run_path(mode: str) -> Path:
    if mode == "main-pic":
        return LAST_RUN_PIC
    if mode == "flow":
        return LAST_RUN_FLOW
    return LAST_RUN


def select_unfilled(
    catalog: list[dict],
    skip_filled: bool = True,
    filled_key: str = "filled",
) -> tuple[list[dict], list[dict]]:
    if not skip_filled:
        return list(catalog), []
    todo = [p for p in catalog if not p.get(filled_key)]
    skipped = [p for p in catalog if p.get(filled_key)]
    return todo, skipped


def select_products_for_mode(
    catalog: list[dict],
    mode: str,
    *,
    refill: bool = False,
) -> tuple[list[dict], list[dict]]:
    """Plan each independent section so existing partial flow rows are not re-requested."""
    todo: list[dict] = []
    skipped: list[dict] = []
    for original in catalog:
        item = dict(original)
        item["need_charts"] = mode in ("all", "charts") and (refill or not item.get("chart_filled"))
        item["need_flow"] = mode in ("all", "charts", "flow") and (refill or not item.get("flow_filled"))
        item["need_main_pic"] = mode in ("all", "main-pic") and (refill or not item.get("main_pic_filled"))
        if item["need_charts"] or item["need_flow"] or item["need_main_pic"]:
            todo.append(item)
        else:
            skipped.append(item)
    return todo, skipped


def filter_products_by_names(products: list[dict], names: list[str]) -> list[dict]:
    """Prefer exact product names; only use substring matching when no exact name exists."""
    selected_rows: set[int] = set()
    for query in names:
        exact = [item for item in products if query == item.get("name")]
        matches = exact or [item for item in products if query in str(item.get("name") or "")]
        selected_rows.update(int(item["row"]) for item in matches)
    return [item for item in products if int(item["row"]) in selected_rows]


def format_progress(
    index: int,
    total: int,
    *,
    row: int,
    name: str,
    status: str,
    error: str = "",
) -> str:
    reason = short_error(error, name)
    extra = f" {reason}" if reason else ""
    return f"{index}/{total} R{row} {name}  {status}{extra}"


def short_error(error: str, name: str = "") -> str:
    text = str(error or "").strip()
    if name:
        text = text.replace(f": {name}", "")
    return text.strip()


def format_failures(results: list[dict]) -> str:
    failed = [r for r in results if r.get("error")]
    if not failed:
        return ""
    lines = [f"失败 {len(failed)} 个:"]
    for item in failed:
        reason = short_error(str(item.get("error") or ""), str(item.get("name") or ""))
        lines.append(f"R{item.get('row')} {item.get('name')}  {reason}".rstrip())
    return "\n".join(lines)


def save_progress(payload: dict) -> None:
    PROGRESS.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def print_color_counts(catalog: list[dict]) -> None:
    parts = []
    for name, _rgb in NAME_COLORS:
        rows = [p for p in catalog if p.get("color") == name]
        if not rows:
            continue
        filled = sum(1 for p in rows if p.get("filled"))
        parts.append(f"{name}{len(rows)}待{len(rows) - filled}")
    print("底色", " ".join(parts), "勾选", "、".join(SELECTED_COLORS))


def list_products(
    colors: list[str] | None = None,
    *,
    mode: str = "all",
    refill: bool = False,
    xlsx: Path | None = None,
) -> tuple[list[dict], list[dict]]:
    src, _dest = resolve_book(xlsx)
    catalog = list_catalog(src)
    print_color_counts(catalog)
    if colors:
        wanted = set(colors)
        catalog = [p for p in catalog if p.get("color") in wanted]
        print("本次", "、".join(colors))
    todo, skipped = select_products_for_mode(catalog, mode, refill=refill)
    print(f"本轮待处理 {len(todo)}，旧数据不作为完成依据" if refill else f"待处理 {len(todo)}，已有数据跳过 {len(skipped)}")
    return todo, skipped


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="本次抓取商品数，0 表示抓完所有未填商品")
    parser.add_argument("--start", type=int, default=0, help="从待抓列表的第几个开始")
    parser.add_argument("--name", type=str, default="", help="只抓指定商品名称，多个用逗号")
    parser.add_argument(
        "--color",
        type=str,
        default=",".join(SELECTED_COLORS),
        help="按商品名称底色筛选，默认勾选的 粉,紫,黄,蓝；可选 粉/灰/紫/黄/绿/蓝，all 表示全部颜色",
    )
    parser.add_argument("--list-colors", action="store_true", help="只列出各颜色商品数量，不抓取")
    parser.add_argument("--refill", action="store_true", help="连已填过的商品也重新抓")
    parser.add_argument("--resume", action="store_true", help="继续同轮任务，只跳过已写入校验成功的商品")
    parser.add_argument(
        "--mode",
        type=str,
        default="all",
        help="all=曲线+流量+主图（默认）；charts=曲线+流量；flow=流量；main-pic=主图",
    )
    args = parser.parse_args()
    try:
        mode = normalize_mode(args.mode)
    except ValueError as exc:
        print(exc)
        return 1
    run_file = last_run_path(mode)
    if mode == "all":
        skip_label = "全部所需部分已有数据跳过"
    elif mode == "main-pic":
        skip_label = "已有主图跳过"
    elif mode == "flow":
        skip_label = "任一流量格已有数据跳过"
    else:
        skip_label = "曲线/流量已有数据分别跳过"

    try:
        work_xlsx = find_workbook()
    except (FileNotFoundError, ValueError) as exc:
        print(exc)
        return 1

    print(f"本次表格: {work_xlsx.name}")
    reason = spreadsheet_lock_reason(work_xlsx)
    if reason:
        print(f"请先在 WPS 里关掉「{work_xlsx.name}」（不用退出 WPS）。", reason)
        print(f"如果这张表仍被打开，结果会尝试改存为 {fallback_path(work_xlsx)}")

    color_names: list[str] | None
    if args.color.strip() in ("all", "全部"):
        color_names = [name for name, _ in NAME_COLORS]
    else:
        color_names = []
        for part in args.color.split(","):
            mapped = normalize_color(part)
            if not mapped or mapped == "all":
                print(f"不认识的颜色: {part}。可用: 粉 灰 紫 黄 绿 蓝 all")
                return 1
            color_names.append(mapped)

    if args.list_colors:
        src, _dest = resolve_book(work_xlsx)
        print_color_counts(list_catalog(src))
        return 0

    if not args.resume:
        try:
            renamed = update_workbook_month(work_xlsx)
        except (OSError, ValueError) as exc:
            print(f'月份更新失败: {exc}')
            return 1
        if renamed != work_xlsx:
            print(f'总表自动改名: {work_xlsx.name} → {renamed.name}（名称更新不代表数据已更新）')
            work_xlsx = renamed

    products, skipped_filled = list_products(
        colors=color_names,
        mode=mode,
        refill=True,
        xlsx=work_xlsx,
    )
    skipped_n = len(skipped_filled)
    if args.name:
        names = [n.strip() for n in args.name.split(",") if n.strip()]
        products = filter_products_by_names(products, names)
    end = None if args.limit == 0 else args.start + args.limit
    products = products[args.start : end]
    round_dates = [*recent7_range(), *recent30_range()]
    round_path = run_file.with_name('round_' + mode + '.json')
    try:
        source, write_dest = resolve_book(work_xlsx)
        round_state, remaining = prepare_round(
            round_path, work_xlsx, source, products, mode, round_dates, args.resume)
    except (OSError, ValueError, KeyError) as exc:
        print(f'不能继续任务: {exc}')
        return 1
    skipped_n = len(products) - len(remaining)
    products = remaining
    skip_label = '本轮写入校验成功跳过'
    if not products:
        if skipped_n:
            done_label = "本轮所需部分全部已写入校验"
            print(f"{done_label}，跳过 {skipped_n} 个，无需抓取")
            save_progress(
                {
                    "index": 0,
                    "total": 0,
                    "ok": 0,
                    "fail": 0,
                    "skipped": skipped_n,
                    "stage": "done",
                    "mode": mode,
                }
            )
            return 0
        print("没有要抓取的商品")
        return 1

    todo = list(products)
    print(f"实时接口抓取 {len(todo)}，不复用历史 JSON，{skip_label} {skipped_n}")
    # #region agent log
    _dbg(
        "E",
        "run.py:main",
        "remaining selected scrape plan",
        {
            "mode": mode,
            "cached": 0,
            "todo": len(todo),
            "skipped": skipped_n,
            "todo_rows": [p["row"] for p in todo[:40]],
            "todo_names": [p["name"] for p in todo[:40]],
            "todo_colors": list({p.get("color") for p in todo}),
        },
        run_id="remaining",
    )
    # #endregion

    results: list[dict] = []
    pending: list[dict] = []
    run_file.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    dest = write_dest
    backed_up = False
    ok_n = 0
    fail_n = 0

    def snapshot_unupdated() -> None:
        nonlocal backed_up
        if backed_up:
            return
        seen: set[Path] = set()
        for path in (work_xlsx, source, dest):
            if path in seen or not path.exists():
                continue
            seen.add(path)
            backup_book(path)
        backed_up = True

    def write_pending() -> None:
        nonlocal pending, written, dest, source
        if not pending:
            return
        snapshot_unupdated()
        dest = apply_results(source, pending, destination=dest)
        source = dest
        checkpoint(round_path, round_state, dest, pending)
        written += len(pending)
        print(f"已更新总表 {dest.name}，备份未更新状态 {bak_path(work_xlsx).name}")
        pending = []

    def emit_progress(index: int, item: dict, status: str, error: str = "") -> None:
        print(
            format_progress(
                index,
                len(todo),
                row=int(item["row"]),
                name=str(item["name"]),
                status=status,
                error=error,
            )
        )
        save_progress(
            {
                "index": index,
                "total": len(todo),
                "ok": ok_n,
                "fail": fail_n,
                "skipped": skipped_n,
                "written": written,
                "row": item.get("row"),
                "name": item.get("name"),
                "color": item.get("color"),
                "stage": status,
                "mode": mode,
                "error": short_error(error, str(item.get("name") or "")),
            }
        )

    def scrape_one(item: dict) -> dict:
        code = str(item.get("code") or "").replace("&#10;", "").replace("\n", "").strip()
        labels = []
        if item.get("need_charts"):
            labels.append("曲线")
        if item.get("need_flow"):
            labels.append("流量")
        if item.get("need_main_pic"):
            labels.append("主图")
        print("  本行补抓: " + "+".join(labels))
        return collect_product_parts(
            page,
            item["name"],
            row=item["row"],
            code=code,
            include_charts=bool(item.get("need_charts")),
            include_flow=bool(item.get("need_flow")),
            include_main_pic=bool(item.get("need_main_pic")),
        )

    if not todo:
        print(f"完成 成功{written} 失败0 {skip_label}{skipped_n}  总表 {dest.name}  备份 {bak_path(work_xlsx).name}")
        save_progress(
            {
                "index": 0,
                "total": 0,
                "ok": written,
                "fail": 0,
                "skipped": skipped_n,
                "stage": "done",
                "mode": mode,
            }
        )
        return 0

    with open_sycm() as (context, page):
        if not ensure_logged_in(page, context):
            print("等待登录超时")
            return 2
        print("开始纯接口抓取（不点击页面，不处理滑块）")
        for i, p in enumerate(todo, 1):
            if [*recent7_range(), *recent30_range()] != round_dates:
                print('统计日期已变化，停止本轮；请开始新一轮以保持统一口径')
                break
            if slider_visible(page):
                if not wait_for_manual_slider(page):
                    print("手动滑块验证未通过，停止后续抓取")
                    break
            try:
                data = scrape_one(p)
                data["code"] = p["code"]
                data['replace_flow'] = bool(p.get('need_flow'))
                results.append(data)
                pending.append(data)
                ok_n += 1
                emit_progress(i, p, "成功")
            except Exception as exc:
                if "滑块验证未通过" in str(exc):
                    fail_n += 1
                    results.append({"row": p["row"], "name": p["name"], "error": str(exc)})
                    emit_progress(i, p, "失败", str(exc))
                    print("滑块验证未通过，停止后续抓取")
                    run_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
                    break
                fail_n += 1
                results.append({"row": p["row"], "name": p["name"], "error": str(exc)})
                emit_progress(i, p, "失败", str(exc))
                if "滑块验证" in str(exc):
                    print("检测到滑块，程序不点击、不拖动，停止后续抓取")
                    run_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
                    break
                if browser_closed(exc):
                    print("浏览器已关闭，停止后续抓取")
                    break
            run_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
            if len(pending) >= 10:
                write_pending()
            # Pace API-only full runs to reduce verification challenges.
            page.wait_for_timeout(ITEM_REQUEST_INTERVAL_MS)

    write_pending()
    run_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    save_progress(
        {
            "index": ok_n + fail_n,
            "total": len(todo),
            "ok": ok_n,
            "fail": fail_n,
            "skipped": skipped_n,
            "written": written,
            "stage": "done" if len(round_state['completed']) == len(round_state['products']) else "incomplete",
            "mode": mode,
        }
    )
    print(
        f"本次结束 成功{ok_n} 失败{fail_n} {skip_label}{skipped_n}"
        + (f"  总表 {dest.name}  备份 {bak_path(work_xlsx).name}" if backed_up else "  未改表")
    )
    fails = format_failures(results)
    if fails:
        print(fails)
    return 0 if len(round_state['completed']) == len(round_state['products']) else 1


if __name__ == "__main__":
    try:
        with run_lock(PROGRESS.parent / 'run.lock'):
            raise SystemExit(main())
    except BlockingIOError:
        raise SystemExit('已有采集任务正在运行，请勿重复启动')
