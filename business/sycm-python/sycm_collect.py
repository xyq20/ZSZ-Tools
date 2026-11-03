#!/usr/bin/env python3
"""Collect 生意参谋 7-day product data with Playwright."""
from __future__ import annotations

import html
import json
import os
import re
import time
import unicodedata
import uuid
from datetime import date, timedelta
from sycm_time import beijing_today
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from playwright.sync_api import Page

from sycm_browser import slider_visible, wait_for_manual_slider
from sycm_chart import (
    format_metric_value,
    metric_caption,
    parse_overview_value,
    parse_trend_series,
    render_metric_chart,
)
from sycm_main_pic import render_main_pic_table

ROOT = Path(os.environ.get("SYCM_DATA_DIR", Path(__file__).resolve().parent.parent)).resolve()
OUT = ROOT / "output" / "sycm"
SHOTS = OUT / "shots"
JSON_DIR = OUT / "json"
DEBUG_LOG = ROOT / ".cursor" / "debug-04f3d7.log"


def _dbg(hypothesis_id: str, location: str, message: str, data: dict[str, Any], run_id: str = "post-fix") -> None:
    # #region agent log
    try:
        payload = {
            "sessionId": "04f3d7",
            "runId": run_id,
            "hypothesisId": hypothesis_id,
            "location": location,
            "message": message,
            "data": data,
            "timestamp": int(time.time() * 1000),
        }
        DEBUG_LOG.parent.mkdir(parents=True, exist_ok=True)
        with DEBUG_LOG.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:
        pass
    # #endregion

SOURCE_NAMES = ("手淘推荐", "手淘搜索", "效果广告", "内容广告")
SOURCE_ALIASES = {name: name for name in SOURCE_NAMES}
NEW_CHANNEL_NAMES = ("推荐", "搜索", "内容营销", "关键词推广")
CLOSED_ERRORS = ("has been closed", "Target closed", "Browser closed")


def recent7_range(today: date | None = None) -> tuple[str, str]:
    today = today or beijing_today()
    end = today - timedelta(days=1)
    start = end - timedelta(days=6)
    return start.isoformat(), end.isoformat()


def recent30_range(today: date | None = None) -> tuple[str, str]:
    today = today or beijing_today()
    end = today - timedelta(days=1)
    start = end - timedelta(days=29)
    return start.isoformat(), end.isoformat()


def _token(page: Page) -> str:
    try:
        for cookie in page.context.cookies("https://sycm.taobao.com"):
            if cookie.get("name") == "_tb_token_":
                return str(cookie.get("value") or "")
    except Exception:
        pass
    return ""


def _validation_url(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    ret = payload.get("ret") or []
    if isinstance(ret, str):
        ret = [ret]
    if not any("FAIL_SYS_USER_VALIDATE" in str(value) for value in ret):
        return ""
    data = payload.get("data") or {}
    return str(data.get("url") or "") if isinstance(data, dict) else ""


_validation_generation = 0


def _fetch_json(page: Page, url: str) -> Any:
    global _validation_generation
    while True:
        request_id = uuid.uuid4().hex
        try:
            page.evaluate(
                """({id, url}) => {
                  window.__sycmApiRequests = window.__sycmApiRequests || {};
                  const controller = new AbortController();
                  window.__sycmApiRequests[id] = {done: false, controller};
                  fetch(url, {
                    credentials: 'include',
                    cache: 'no-store',
                    signal: controller.signal,
                    headers: {'Cache-Control': 'no-cache', 'Pragma': 'no-cache'},
                  }).then(async (response) => {
                    const text = await response.text();
                    let data = null;
                    try { data = JSON.parse(text); } catch (e) {}
                    window.__sycmApiRequests[id] = {
                      done: true,
                      status: response.status,
                      data,
                    };
                  }).catch((error) => {
                    window.__sycmApiRequests[id] = {
                      done: true,
                      status: 0,
                      data: null,
                      error: String(error),
                    };
                  });
                }""",
                {"id": request_id, "url": url},
            )
        except Exception:
            return None

        deadline = time.monotonic() + 20
        retry_after_manual_validation = False
        while True:
            if slider_visible(page):
                if not wait_for_manual_slider(page):
                    return None
                retry_after_manual_validation = True
                break
            try:
                state = page.evaluate(
                    """(id) => {
                      const store = window.__sycmApiRequests || {};
                      const value = store[id];
                      if (!value || !value.done) return {done: false};
                      delete store[id];
                      return value;
                    }""",
                    request_id,
                )
            except Exception:
                return None
            if state and state.get("done"):
                payload = state.get("data")
                if _validation_url(payload):
                    try:
                        page.wait_for_timeout(500)
                    except Exception:
                        return None
                    if slider_visible(page):
                        if not wait_for_manual_slider(page):
                            return None
                        retry_after_manual_validation = True
                        break
                    return None
                return payload
            if time.monotonic() >= deadline:
                break
            try:
                page.wait_for_timeout(250)
            except Exception:
                return None

        try:
            page.evaluate(
                """(id) => {
                  const store = window.__sycmApiRequests || {};
                  const value = store[id];
                  if (value && value.controller) value.controller.abort();
                  delete store[id];
                }""",
                request_id,
            )
        except Exception:
            pass
        if retry_after_manual_validation:
            _validation_generation += 1
            print("手动验证已通过，重试原接口")
            continue
        return None


def _archives_url(item_id: str, active_key: str, date_type: str = "recent7") -> str:
    start, end = recent7_range() if date_type == "recent7" else recent30_range()
    return "https://sycm.taobao.com/cc/item_archives?" + urlencode(
        {
            "activeKey": active_key,
            "dateRange": f"{start}|{end}",
            "dateType": date_type,
            "itemId": item_id,
        }
    )


def browser_closed(exc: BaseException) -> bool:
    msg = str(exc)
    return any(token in msg for token in CLOSED_ERRORS)


def _safe_name(name: str) -> str:
    return re.sub(r"[\\/:*?\"<>|]+", "_", name).strip() or "item"


def _num(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, dict):
        return _num(value.get("value"))
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "").replace("%", "")
    if text in ("", "-", "--"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _png_size(path: Path) -> tuple[int, int] | None:
    try:
        header = path.read_bytes()[:24]
    except Exception:
        return None
    if header[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return int.from_bytes(header[16:20], "big"), int.from_bytes(header[20:24], "big")


def _shot_is_full_page(path: Path) -> bool:
    size = _png_size(path)
    return bool(size and size[0] >= 1000 and size[1] >= 600)


def _shot_is_metric_chart(path: Path) -> bool:
    size = _png_size(path)
    return bool(size and 240 <= size[0] <= 900 and 90 <= size[1] <= 420)


def _shot_is_main_pic_table(path: Path) -> bool:
    size = _png_size(path)
    if not size:
        return False
    width, height = size
    return 1200 <= width <= 2400 and 240 <= height <= 1800


def _item_id_from_page(page: Page) -> str:
    m = re.search(r"itemId=(\d+)", page.url or "")
    return m.group(1) if m else ""


def fetch_sale_trend(page: Page, item_id: str, index_code: str) -> list[tuple[str, float]]:
    if not item_id:
        return []
    start, end = recent30_range()
    url = "https://sycm.taobao.com/cc/item/sale/trend.json?" + urlencode(
        {
            "dateType": "recent30",
            "dateRange": f"{start}|{end}",
            "indexCode": index_code,
            "device": 0,
            "itemId": item_id,
            "token": _token(page),
        }
    )
    return parse_trend_series(_fetch_json(page, url), index_code)


def fetch_sale_overview_value(page: Page, item_id: str, index_code: str, *, response_cache=None) -> float | None:
    if not item_id:
        return None
    start, end = recent7_range()
    url = "https://sycm.taobao.com/cc/item/sale/overview.json?" + urlencode(
        {
            "dateType": "recent7",
            "dateRange": f"{start}|{end}",
            "device": 0,
            "itemId": item_id,
            "token": _token(page),
        }
    )
    cache_key = (url, _validation_generation)
    payload = response_cache.get(cache_key) if response_cache is not None else None
    if payload is None:
        payload = _fetch_json(page, url)
        # Only reuse a complete response within this product's chart operation.
        if response_cache is not None and all(
            parse_overview_value(payload, key) is not None for key in ('itmUv', 'payRate')
        ):
            response_cache[(url, _validation_generation)] = payload
    return parse_overview_value(payload, index_code)


def _collect_metric_chart(
    page: Page,
    stem: str,
    label: str,
    index_code: str,
    item_id: str,
    response_cache=None,
) -> tuple[str, str]:
    series = fetch_sale_trend(page, item_id, index_code)
    dates = [d for d, _v in series]
    values = [v for _d, v in series]
    if len(values) < 2:
        raise RuntimeError(f"没有抓到「{label}」曲线")
    overview = fetch_sale_overview_value(page, item_id, index_code, response_cache=response_cache)
    if overview is None and index_code == "itmUv":
        overview = sum(values)
    if overview is None:
        overview = values[-1]
    caption = metric_caption(label, format_metric_value(index_code, overview))
    path = SHOTS / f"{stem}_{label}.png"
    render_metric_chart(path, caption, values, dates=dates, index_code=index_code)
    return str(path), caption


def _listen_json(page: Page, bag: list[dict[str, Any]]) -> None:
    def on_response(resp: Response) -> None:
        url = resp.url
        if "sycm.taobao.com" not in url or ".json" not in url:
            return
        if resp.status != 200:
            return
        try:
            data = resp.json()
        except Exception:
            return
        bag.append({"url": url, "data": data})

    page.on("response", on_response)


def _debug_shot(page: Page, stem: str, tag: str) -> None:
    path = SHOTS / f"{stem}_{tag}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        page.screenshot(path=str(path), full_page=False, timeout=4000, animations="disabled")
    except Exception:
        pass


def _unwrap_id(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("value") or value.get("itemId") or value.get("id")
    return str(value or "").strip()


def _record_item_id(rec: dict[str, Any]) -> str:
    item = rec.get("item") if isinstance(rec.get("item"), dict) else {}
    return _unwrap_id(
        item.get("itemId")
        or item.get("id")
        or rec.get("itemId")
        or rec.get("id")
        or rec.get("mainProductId")
    )


def _record_title(rec: dict[str, Any]) -> str:
    item = rec.get("item") if isinstance(rec.get("item"), dict) else {}
    raw = (
        item.get("title")
        or item.get("itemName")
        or item.get("mainProductName")
        or item.get("itemTitle")
        or rec.get("itemName")
        or rec.get("mainProductName")
        or rec.get("itemTitle")
        or rec.get("productName")
        or rec.get("title")
    )
    if isinstance(raw, dict):
        raw = raw.get("value")
    return html.unescape(str(raw or "")).strip()


def _record_code(rec: dict[str, Any]) -> str:
    item = rec.get("item") if isinstance(rec.get("item"), dict) else {}
    for value in (
        item.get("itemNO"),
        item.get("itemNo"),
        item.get("outerId"),
        item.get("itemCode"),
        rec.get("itemNO"),
        rec.get("itemNo"),
        rec.get("outerId"),
        rec.get("itemCode"),
    ):
        if isinstance(value, dict):
            value = value.get("value")
        text = str(value or "").strip()
        if text:
            return text
    return ""


_SEARCH_NOTES = re.compile(r"[（(](?:旧链接|老链接|旧款)[)）]")


def _clean_search_name(value: str) -> str:
    return _SEARCH_NOTES.sub("", value or "").strip()


def _compact_name(value: str) -> str:
    return (value or "").replace(" ", "").replace("•", "").replace("·", "")


def _norm_match_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", html.unescape(str(value or "")))
    return "".join(
        char
        for char in text.casefold()
        if unicodedata.category(char)[:1] not in {"P", "S", "Z", "C"}
    )


def _norm_name(value: str) -> str:
    return _norm_match_text(_clean_search_name(value or ""))


def _norm_code(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("value")
    text = unicodedata.normalize("NFKC", html.unescape(str(value or "")))
    text = text.replace("&#10;", "").replace("\n", "").strip()
    text = re.sub(r"\s+", "", text)
    if re.fullmatch(r"\d+\.0", text):
        text = text[:-2]
    return _norm_match_text(text)


def _search_queries(name: str, code: str = "") -> list[str]:
    cleaned = _clean_search_name(name)
    queries: list[str] = []
    for query in (cleaned, _compact_name(cleaned), _norm_match_text(cleaned)):
        query = str(query or "").strip()
        if query and query not in queries:
            queries.append(query)
    code = str(code or "").replace("&#10;", "").replace("\n", "").strip()
    if code and code not in queries:
        queries.append(code)
    normalized_code = _norm_code(code)
    if normalized_code and normalized_code not in queries:
        queries.append(normalized_code)
    return queries


def _bracket_name(title: str) -> str:
    m = re.search(r"【([^】]+)】", title or "")
    return (m.group(1) if m else "").strip()


def _title_matches(title: str, keyword: str) -> bool:
    needle = _norm_name(keyword)
    if not needle:
        return False
    bracket = _norm_name(_bracket_name(title))
    if bracket:
        return bracket == needle
    return needle in _norm_name(title)


def _search_items_api(page: Page, keyword: str, date_type: str = "recent7") -> list[dict[str, Any]]:
    start, end = recent7_range() if date_type == "recent7" else recent30_range()
    token = _token(page)
    found: list[dict[str, Any]] = []
    seen: set[str] = set()
    for page_no in range(1, 4):
        qs = urlencode(
            {
                "dateRange": f"{start}|{end}",
                "dateType": date_type,
                "pageSize": 20,
                "page": page_no,
                "keyword": keyword,
                "token": token,
            }
        )
        data = _fetch_json(page, "https://sycm.taobao.com/cc/common/item/search.json?" + qs)
        records = (data or {}).get("data") or []
        if isinstance(records, dict):
            records = records.get("data") or []
        if not records:
            break
        for rec in records:
            if not isinstance(rec, dict):
                continue
            item_id = _record_item_id(rec)
            if not item_id or item_id in seen:
                continue
            seen.add(item_id)
            found.append(
                {
                    "itemId": item_id,
                    "title": _record_title(rec),
                    "item_code": _record_code(rec),
                }
            )
        if len(records) < 20:
            break
    return found


def _filter_search_hits(found: list[dict[str, Any]], keyword: str) -> list[dict[str, Any]]:
    exact = [item for item in found if _title_matches(item.get("title") or "", keyword)]
    if exact:
        return exact
    needle = _norm_name(keyword)
    return [item for item in found if needle and needle in _norm_name(item.get("title") or "")]


def _fetch_item_details(page: Page, item_ids: list[str]) -> dict[str, dict[str, Any]]:
    if not item_ids:
        return {}
    start, end = recent30_range()
    details: dict[str, dict[str, Any]] = {}
    token = _token(page)
    for item_id in item_ids[:20]:
        url = "https://sycm.taobao.com/cc/item/info.json?" + urlencode(
            {
                "itemId": item_id,
                "dateType": "recent30",
                "dateRange": f"{start}|{end}",
                "token": token,
            }
        )
        payload = _fetch_json(page, url)
        raw = (payload or {}).get("data") or {}
        details[str(item_id)] = {
            "shop_rank": _num(raw.get("rank")),
            "code": _record_code(raw),
            "title": _record_title(raw),
        }
    return details


def _fetch_shop_ranks(page: Page, item_ids: list[str]) -> dict[str, float | None]:
    return {
        item_id: details.get("shop_rank")
        for item_id, details in _fetch_item_details(page, item_ids).items()
    }


def _enrich_item_candidates(page: Page, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    details = _fetch_item_details(page, [str(item["itemId"]) for item in items[:20]])
    enriched: list[dict[str, Any]] = []
    for item in items[:20]:
        item_id = str(item["itemId"])
        detail = details.get(item_id) or {}
        enriched.append(
            {
                **item,
                "item_code": item.get("item_code") or detail.get("code") or "",
                "shop_rank": detail.get("shop_rank"),
                "title": item.get("title") or detail.get("title") or "",
            }
        )
    return enriched


def _pick_lowest_rank_item(page: Page, items: list[dict[str, Any]]) -> dict[str, Any]:
    missing = [
        str(item["itemId"])
        for item in items[:20]
        if item.get("shop_rank") is None
    ]
    ranks = _fetch_shop_ranks(page, missing)
    ranked: list[dict[str, Any]] = []
    for item in items[:20]:
        rank = item.get("shop_rank")
        if rank is None:
            rank = ranks.get(str(item["itemId"]))
        row = {**item, "shop_rank": rank}
        ranked.append(row)
    with_rank = [row for row in ranked if row.get("shop_rank") is not None]
    if with_rank:
        return min(with_rank, key=lambda row: float(row["shop_rank"]))
    return ranked[0]


def search_item(page: Page, keyword: str, code: str = "") -> dict[str, Any]:
    code = str(code or "").replace("&#10;", "").replace("\n", "").strip()
    if slider_visible(page) and not wait_for_manual_slider(page):
        raise RuntimeError("滑块验证未通过，程序未点击、未拖动")
    items: list[dict[str, Any]] = []
    used = "name-recent7"
    queries = _search_queries(keyword, code)
    for date_type in ("recent7", "recent30"):
        for query in queries:
            used = f"{query}-{date_type}"
            raw = _search_items_api(page, query, date_type)
            filtered = _filter_search_hits(raw, keyword)
            items = raw if (query == code and not filtered) else filtered
            if len(filtered) == 1:
                # A unique name match is authoritative even when the sheet's
                # code is stale or uses a supplier-side suffix.
                items = _enrich_item_candidates(page, filtered)
            elif items and code:
                items = _enrich_item_candidates(page, items)
                items = [item for item in items if _norm_code(item.get("item_code")) == _norm_code(code)]
            if items:
                break
        if items:
            break
    # #region agent log
    _dbg(
        "I",
        "sycm_collect.py:search_item",
        "search result",
        {
            "keyword": keyword,
            "code": code,
            "used": used,
            "n": len(items),
            "titles": [(item.get("title") or "")[:40] for item in items[:5]],
            "item_codes": [item.get("item_code") for item in items[:5]],
        },
    )
    # #endregion
    if not items:
        _debug_shot(page, _safe_name(keyword), "search_fail")
        suffix = f" 货号={code}" if code else ""
        raise RuntimeError(f"未找到商品: {keyword}{suffix}")
    picked = items[0] if len(items) == 1 else _pick_lowest_rank_item(page, items)
    print(
        f"  匹配 itemId={picked['itemId']} 货号={picked.get('item_code') or '-'} "
        f"排名={picked.get('shop_rank') if picked.get('shop_rank') is not None else '-'}"
    )
    return {
        "item_url": _archives_url(picked["itemId"], "sale", "recent7"),
        "keyword": keyword,
        "item_id": picked["itemId"],
        "shop_rank": picked.get("shop_rank"),
        "item_code": picked.get("item_code"),
        "title": picked.get("title"),
    }


def collect_sale_screens(page: Page, stem: str, item_id: str = "") -> dict[str, str]:
    item_id = item_id or _item_id_from_page(page)
    if not item_id:
        raise RuntimeError("没有 itemId，无法拉销售曲线")
    response_cache = {}
    uv_path, uv_caption = _collect_metric_chart(page, stem, "访客", "itmUv", item_id, response_cache)
    rate_path, rate_caption = _collect_metric_chart(page, stem, "支付转化率", "payRate", item_id, response_cache)
    if not _shot_is_metric_chart(Path(uv_path)) or not _shot_is_metric_chart(Path(rate_path)):
        raise RuntimeError(
            f"访客/支付转化率不是指标曲线图 uv={_png_size(Path(uv_path))} rate={_png_size(Path(rate_path))}"
        )
    _dbg(
        "A",
        "sycm_collect.py:collect_sale_screens",
        "指标曲线图",
        {
            "stem": stem,
            "uv": uv_caption,
            "rate": rate_caption,
            "uv_size": list(_png_size(Path(uv_path)) or []),
            "rate_size": list(_png_size(Path(rate_path)) or []),
        },
    )
    return {
        "访客截图": uv_path,
        "支付转化率截图": rate_path,
        "访客指标": uv_caption,
        "支付转化率指标": rate_caption,
    }


def _pick_sources(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    picked: dict[str, dict[str, Any]] = {}
    for row in rows:
        name = (
            row.get("pageName")
            or row.get("name")
            or row.get("sourceName")
            or row.get("pPageName")
            or ""
        )
        if isinstance(name, dict):
            name = name.get("value") or name.get("name") or ""
        name = str(name).strip()
        key = SOURCE_ALIASES.get(name)
        if not key:
            continue
        if key in picked and name not in SOURCE_NAMES:
            continue
        uv_raw = row.get("uv") or row.get("itmUv") or row.get("visitor") or row.get("pPageUv")
        rate_raw = row.get("payRate") or row.get("crtRate") or row.get("pPayRate")
        uv = _num(uv_raw)
        rate = _num(rate_raw)
        if rate is not None and rate > 1:
            rate = rate / 100
        uv_change = _change_text(
            (uv_raw.get("cycleCrc") if isinstance(uv_raw, dict) else None)
            or row.get("uvCycleCrc")
            or row.get("uvCrc")
            or row.get("uvChange")
        )
        rate_change = _change_text(
            (rate_raw.get("cycleCrc") if isinstance(rate_raw, dict) else None)
            or row.get("payRateCycleCrc")
            or row.get("payRateCrc")
            or row.get("pPayRateCycleCrc")
            or row.get("payRateChange")
        )
        uv_text = None
        if uv is not None:
            uv_text = str(int(uv) if float(uv).is_integer() else uv)
        picked[key] = {
            "访客": uv,
            "访客文本": _two_line(uv_text, uv_change),
            "访客涨跌文本": uv_change,
            "支付转化率": rate,
            "支付转化率文本": _two_line(_rate_text(rate), rate_change),
            "支付转化率涨跌文本": rate_change,
            "raw_name": name,
        }
    return picked


def _walk_rows(obj: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if isinstance(obj, dict):
        if any(k in obj for k in ("pageName", "sourceName", "pPageName", "name")) and any(
            k in obj for k in ("uv", "itmUv", "payRate", "pPayRate")
        ):
            found.append(obj)
        for v in obj.values():
            found.extend(_walk_rows(v))
    elif isinstance(obj, list):
        for v in obj:
            found.extend(_walk_rows(v))
    return found


def _rate_text(rate: float | None) -> str | None:
    if rate is None:
        return None
    if rate > 1:
        rate = rate / 100
    return f"{rate * 100:.2f}%"


def _change_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict):
        return _change_text(value.get("value") or value.get("cycleCrc"))
    text = str(value).strip().replace(",", "")
    if text in ("", "-", "--"):
        return None
    if "%" in text:
        if text[0] not in "+-" and re.match(r"\d", text):
            return f"+{text}" if not text.startswith("+") else text
        return text
    number = _num(text)
    if number is None:
        return None
    number *= 100
    if number > 5000:
        return ">5000.00%"
    if number < -5000:
        return "<-5000.00%"
    sign = "+" if number > 0 else ""
    return f"{sign}{number:.2f}%"


def _two_line(first: str | None, second: str | None) -> str | None:
    first = (first or "").strip()
    second = (second or "").strip()
    if not first:
        return None
    if second and second not in ("-", "--"):
        return f"{first}\n{second}"
    return first


def _merge_sources(base: dict[str, dict[str, Any]], extra: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    for key, src in extra.items():
        if key not in base:
            base[key] = src
            continue
        for field, value in src.items():
            if base[key].get(field) in (None, "") and value not in (None, ""):
                base[key][field] = value
    return base


def _sources_have_any_data(picked: dict[str, Any]) -> bool:
    for src in picked.values():
        if not isinstance(src, dict):
            continue
        if src.get("访客") is not None or src.get("支付转化率") is not None:
            return True
    return False


def _fetch_flow_api(page: Page, item_id: str) -> dict[str, Any]:
    if not item_id:
        return {}
    start, end = recent7_range()
    picked: dict[str, Any] = {}
    for page_no in range(1, 7):
        url = "https://sycm.taobao.com/flow/v6/item/crowdtype/source/v3.json?" + urlencode(
            {
                "belong": "all",
                "dateRange": f"{start}|{end}",
                "dateType": "recent7",
                "pageSize": 10,
                "page": page_no,
                "order": "desc",
                "orderBy": "uv",
                "itemId": item_id,
                "device": 2,
                "indexCode": "uv,cartByrCnt,payByrCnt",
                "token": _token(page),
            }
        )
        data = _fetch_json(page, url)
        if not data:
            break
        found = _pick_sources(_walk_rows(data))
        if found:
            _merge_sources(picked, found)
        # Missing channels are normal. Once the old-calibre API provides any
        # usable source, do not spend extra requests trying to fill empty cells.
        if _sources_have_any_data(picked):
            break
    return picked


def _flow_uses_new_channel_aliases(sources: Any) -> bool:
    if not isinstance(sources, dict):
        return False
    for src in sources.values():
        if not isinstance(src, dict):
            continue
        if str(src.get("raw_name") or "").strip() in NEW_CHANNEL_NAMES:
            return True
    return False


def collect_flow(page: Page, item_id: str) -> dict[str, Any]:
    if slider_visible(page) and not wait_for_manual_slider(page):
        raise RuntimeError("滑块验证未通过，程序未点击、未拖动")
    picked = _fetch_flow_api(page, item_id)
    if _sources_have_any_data(picked):
        return picked
    raise RuntimeError("纯接口没有返回任何旧口径流量数据；不会回退到页面点击")


def collect_flow_product(
    page: Page,
    name: str,
    row: int | None = None,
    *,
    use_cache: bool = False,
    code: str = "",
) -> dict[str, Any]:
    """Refresh 流量来源 only. Keep existing 访客/支付转化率 screenshots."""
    _ = use_cache  # Backwards-compatible argument; historical metrics are never reused.
    JSON_DIR.mkdir(parents=True, exist_ok=True)
    existing = _read_item_json(name, row) or {}
    found = search_item(page, name, code=code)
    item_id = str(found.get("item_id") or "")
    existing.update(
        {
            "url": found.get("item_url") or existing.get("url"),
            "item_id": item_id,
            "item_code": found.get("item_code"),
            "shop_rank": found.get("shop_rank"),
            "title": found.get("title"),
        }
    )
    print(f"  流量来源已按名称+货号重新匹配 itemId={item_id}")
    sources = collect_flow(page, item_id)
    existing["row"] = row
    existing["name"] = name
    existing["item_id"] = item_id
    existing["date_range"] = recent7_range()
    existing["流量来源"] = sources
    out = cached_result_path(name, row)
    payload = {k: v for k, v in existing.items() if k != "json"}
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "row": row,
        "name": name,
        "item_id": item_id,
        "流量来源": sources,
        "json": str(out),
    }


def fetch_main_pic_materials(page: Page, item_id: str) -> tuple[list[dict[str, Any]], int]:
    """Fetch current 30-day main-picture data without leaving the rank page."""
    if not item_id:
        raise RuntimeError("没有 itemId，无法抓取主图分析")
    start, end = recent30_range()
    url = "https://sycm.taobao.com/cc/item/detail/main/pic/analysis/material.json?" + urlencode(
        {
            "dateRange": f"{start}|{end}",
            "dateType": "recent30",
            "pageSize": 10,
            "page": 1,
            "order": "desc",
            "orderBy": "itemExposeUv",
            "byrType": "all",
            "itemId": item_id,
            "contentType": "gallery",
            "indexCode": (
                "itemExposeUv,itemInteractUv,itemPayUv,itemLossUv,"
                "itemLossRate,itemPayConvertRate"
            ),
            "token": _token(page),
        }
    )
    payload = _fetch_json(page, url)
    data = (payload or {}).get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise RuntimeError("主图分析接口没有返回数据")
    records = data.get("data") or []
    if not isinstance(records, list):
        raise RuntimeError("主图分析接口数据格式异常")
    raw_rows = [record for record in records if isinstance(record, dict)]

    def material_type(record: dict[str, Any]) -> str:
        raw = record.get("contentType")
        value = raw.get("value") if isinstance(raw, dict) else raw
        return str(value or "").lower()

    rows = [record for record in raw_rows if material_type(record) == "gallery"]
    try:
        record_count = int(data.get("recordCount") or len(rows))
    except (TypeError, ValueError):
        record_count = len(rows)
    # contentType=gallery should make the server count gallery-only. If the
    # endpoint ever leaks another type, do not propagate that row or its count
    # into the locally rendered main-picture table.
    if len(rows) != len(raw_rows):
        record_count = len(rows)
    return rows, max(record_count, len(rows))


def collect_main_pic(page: Page, stem: str, item_id: str) -> str:
    if slider_visible(page) and not wait_for_manual_slider(page):
        raise RuntimeError("滑块验证未通过，程序未点击、未拖动")
    before_url = str(getattr(page, "url", "") or "")
    records, record_count = fetch_main_pic_materials(page, item_id)
    path = SHOTS / f"{stem}_主图分析.png"
    render_main_pic_table(path, records, record_count=record_count)
    after_url = str(getattr(page, "url", "") or "")
    if before_url and after_url and before_url != after_url:
        raise RuntimeError("主图分析接口抓取意外改变了当前页面")
    if not _shot_is_main_pic_table(path):
        raise RuntimeError(f"主图分析本地绘图尺寸异常: {_png_size(path)}")
    print(f"  主图分析纯接口 {record_count} 条，本地绘图完成")
    return str(path)


def optional_main_pic(page: Page, stem: str, item_id: str) -> str:
    try:
        return collect_main_pic(page, stem, item_id)
    except Exception as exc:
        print(f"  主图分析失败，曲线仍写入: {exc}")
        return ""


def cached_result_path(name: str, row: int | None = None) -> Path:
    stem = _safe_name(f"r{row}_{name}" if row else name)
    return JSON_DIR / f"{stem}.json"


def _read_item_json(name: str, row: int | None = None) -> dict[str, Any] | None:
    path = cached_result_path(name, row)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if data.get("error"):
        return None
    return data


def load_cached_main_pic(name: str, row: int | None = None) -> dict[str, Any] | None:
    data = _read_item_json(name, row)
    if not data:
        return None
    shot = data.get("主图分析截图")
    if not shot or not Path(str(shot)).exists():
        return None
    if not _shot_is_main_pic_table(Path(str(shot))):
        print(f"  主图分析缓存是商品头图，将重截 {name}")
        return None
    return {
        "row": data.get("row") or row,
        "name": data.get("name") or name,
        "主图分析截图": str(shot),
        "item_id": data.get("item_id"),
        "json": str(cached_result_path(name, row)),
    }


def _flow_texts_look_like_pay_buyers(sources: Any) -> bool:
    if not isinstance(sources, dict):
        return False
    for src in sources.values():
        if not isinstance(src, dict):
            continue
        text = str(src.get("支付转化率文本") or "").strip()
        if not text:
            continue
        first = text.splitlines()[0].replace(",", "").replace(" ", "")
        if re.fullmatch(r"\d+", first):
            return True
    return False


def collect_main_pic_product(
    page: Page,
    name: str,
    row: int | None = None,
    *,
    use_cache: bool = True,
    code: str = "",
) -> dict[str, Any]:
    _ = use_cache  # Backwards-compatible argument; screenshots are never reused by a run.
    SHOTS.mkdir(parents=True, exist_ok=True)
    JSON_DIR.mkdir(parents=True, exist_ok=True)
    stem = _safe_name(f"r{row}_{name}" if row else name)
    existing = _read_item_json(name, row) or {}
    found = search_item(page, name, code=code)
    item_id = str(found.get("item_id") or "")
    existing.update(
        {
            "url": found.get("item_url") or existing.get("url"),
            "item_id": item_id,
            "item_code": found.get("item_code"),
            "shop_rank": found.get("shop_rank"),
            "title": found.get("title"),
        }
    )
    print(f"  主图分析已按名称+货号重新匹配 itemId={item_id}")
    shot = collect_main_pic(page, stem, item_id)
    existing["row"] = row
    existing["name"] = name
    existing["item_id"] = item_id
    existing["主图分析截图"] = shot
    out = cached_result_path(name, row)
    payload = {k: v for k, v in existing.items() if k != "json"}
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "row": row,
        "name": name,
        "主图分析截图": shot,
        "item_id": item_id,
        "json": str(out),
    }


def load_cached_result(name: str, row: int | None = None) -> dict[str, Any] | None:
    path = cached_result_path(name, row)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if data.get("error"):
        return None
    shots = [data.get("访客截图"), data.get("支付转化率截图")]
    if not all(shots) or not all(Path(str(s)).exists() for s in shots):
        return None
    uv_shot = Path(str(data.get("访客截图")))
    rate_shot = Path(str(data.get("支付转化率截图")))
    uv_size = _png_size(uv_shot)
    rate_size = _png_size(rate_shot)
    charted = _shot_is_metric_chart(uv_shot) and _shot_is_metric_chart(rate_shot)
    _dbg(
        "A",
        "sycm_collect.py:load_cached_result",
        "缓存截图尺寸",
        {
            "name": name,
            "row": row,
            "uv": list(uv_size or []),
            "rate": list(rate_size or []),
            "chart": charted,
            "uv_caption": data.get("访客指标"),
            "rate_caption": data.get("支付转化率指标"),
        },
    )
    if not data.get("访客指标") or not data.get("支付转化率指标"):
        return None
    if not charted:
        return None
    if not data.get("流量来源"):
        return None
    if _flow_texts_look_like_pay_buyers(data.get("流量来源")):
        return None
    if _flow_uses_new_channel_aliases(data.get("流量来源")):
        return None
    data["json"] = str(path)
    return data


def collect_product_parts(
    page: Page,
    name: str,
    row: int | None = None,
    *,
    code: str = "",
    include_charts: bool = True,
    include_flow: bool = True,
    include_main_pic: bool = False,
) -> dict[str, Any]:
    """Match once, then fetch only the still-missing workbook sections."""
    if not (include_charts or include_flow or include_main_pic):
        raise ValueError("没有需要抓取的数据部分")
    SHOTS.mkdir(parents=True, exist_ok=True)
    JSON_DIR.mkdir(parents=True, exist_ok=True)
    stem = _safe_name(f"r{row}_{name}" if row else name)
    found = search_item(page, name, code=code)
    item_id = str(found.get("item_id") or "")
    result = {
        "row": row,
        "name": name,
        "url": found.get("item_url") or page.url,
        "item_id": found.get("item_id"),
        "item_code": found.get("item_code"),
        "shop_rank": found.get("shop_rank"),
        "title": found.get("title"),
        "date_range": recent7_range(),
    }
    if include_charts:
        result.update(collect_sale_screens(page, stem, item_id=item_id))
    if include_flow:
        result["流量来源"] = collect_flow(page, item_id)
    if include_main_pic:
        result["主图分析截图"] = collect_main_pic(page, stem, item_id)
    out = JSON_DIR / f"{stem}.json"
    payload = _read_item_json(name, row) or {}
    payload.update(result)
    payload.pop("json", None)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    result["json"] = str(out)
    return result


def collect_product(
    page: Page,
    name: str,
    row: int | None = None,
    *,
    use_cache: bool = True,
    code: str = "",
    include_main_pic: bool = False,
) -> dict[str, Any]:
    _ = use_cache  # Backwards-compatible argument; every run fetches fresh API data.
    return collect_product_parts(
        page,
        name,
        row=row,
        code=code,
        include_charts=True,
        include_flow=True,
        include_main_pic=include_main_pic,
    )
