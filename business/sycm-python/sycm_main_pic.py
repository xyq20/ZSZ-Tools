#!/usr/bin/env python3
"""Render 生意参谋主图分析 API data as a stable local table image."""
from __future__ import annotations

import io
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from pathlib import Path
from typing import Any, Callable
from urllib.request import Request, urlopen

from PIL import Image, ImageDraw, ImageFont, ImageOps

CANVAS_WIDTH = 2048
ROW_HEIGHT = 94
TABLE_TOP = 144
HEADER_HEIGHT = 57
FONT_CANDIDATES = (
    str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "msyh.ttc"),
    str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "simhei.ttf"),
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)


def _font(size: int, bold: bool = False):
    candidates = list(FONT_CANDIDATES)
    if bold:
        candidates = [
            "/System/Library/Fonts/PingFang.ttc",
            "/System/Library/Fonts/STHeiti Medium.ttc",
        ] + candidates
    for path in candidates:
        if not Path(path).exists():
            continue
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def _value(record: dict[str, Any], key: str) -> Any:
    raw = record.get(key)
    return raw.get("value") if isinstance(raw, dict) else raw


def _cycle(record: dict[str, Any], key: str) -> float | None:
    raw = record.get(key)
    if not isinstance(raw, dict) or raw.get("cycleCrc") is None:
        return None
    try:
        return float(raw["cycleCrc"])
    except (TypeError, ValueError):
        return None


def _number(value: Any) -> str:
    if value is None or value == "":
        return "-"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if number.is_integer():
        return f"{int(number):,}"
    return f"{number:,.2f}"


def _percent(value: Any) -> str:
    if value is None or value == "":
        return "-"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if abs(number) <= 1:
        number *= 100
    return f"{number:.2f}%"


def _change(value: float | None) -> tuple[str, tuple[int, int, int]]:
    if value is None:
        return "-", (135, 141, 153)
    number = value * 100
    if abs(number) < 0.005:
        return "+0.00%", (135, 141, 153)
    color = (255, 54, 49) if number > 0 else (35, 157, 50)
    return f"{number:+.2f}%", color


def format_click_rate(record: dict[str, Any]) -> str:
    """Return 互动人数 / 曝光人数 as a two-decimal percentage."""
    try:
        exposure = float(_value(record, "itemExposeUv"))
        interaction = float(_value(record, "itemInteractUv"))
    except (TypeError, ValueError):
        return "-"
    if exposure <= 0 or interaction < 0:
        return "-"
    return f"{interaction / exposure * 100:.2f}%"


def _download_thumbnail(url: str) -> Image.Image | None:
    for attempt in range(3):
        try:
            return _download_thumbnail_once(url)
        except HTTPError as exc:
            if exc.code in (400, 403, 404, 410):
                print(f'  素材图片 HTTP {exc.code}，保留占位图', flush=True)
                return None
            if exc.code == 429:
                print('  素材图片限流，停止重试并保留占位图', flush=True)
                return None
        except Exception:
            pass
        if attempt < 2:
            time.sleep(.5 * (attempt + 1))
    print('  素材图片下载失败，保留占位图', flush=True)
    return None


def _download_thumbnail_once(url: str) -> Image.Image | None:
    if not url:
        return None
    try:
        request = Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
            },
        )
        with urlopen(request, timeout=12) as response:
            data = response.read(8 * 1024 * 1024)
        with Image.open(io.BytesIO(data)) as source:
            return source.convert("RGB")
    except Exception:
        raise


def _center_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    font,
    fill: tuple[int, int, int],
) -> None:
    draw.text(xy, text, font=font, fill=fill, anchor="mm")


def _thumbnail_tile(image: Image.Image | None, size: int = 64) -> Image.Image:
    tile = Image.new("RGB", (size, size), (239, 242, 246))
    if image is not None:
        fitted = ImageOps.fit(image.convert("RGB"), (size, size), method=Image.Resampling.LANCZOS)
        tile.paste(fitted, (0, 0))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=5, fill=255)
    rounded = Image.new("RGB", (size, size), (239, 242, 246))
    rounded.paste(tile, (0, 0), mask)
    return rounded


def render_main_pic_table(
    path: Path,
    records: list[dict[str, Any]],
    *,
    record_count: int | None = None,
    thumbnail_loader: Callable[[str], Image.Image | None] | None = None,
) -> str:
    """Render the first API page with the same columns and visual hierarchy as SYCM."""
    gallery_records = [
        row
        for row in records
        if isinstance(row, dict)
        and str(_value(row, "contentType") or "").lower() == "gallery"
    ]
    shown = gallery_records[:10]
    count = max(int(record_count or 0), len(shown))
    row_count = max(1, len(shown))
    footer_height = 53 if count > 10 else 23
    height = TABLE_TOP + HEADER_HEIGHT + row_count * ROW_HEIGHT + footer_height
    image = Image.new("RGB", (CANVAS_WIDTH, height), (244, 246, 250))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((7, 7, CANVAS_WIDTH - 7, height - 7), radius=18, fill=(255, 255, 255))

    title_font = _font(30, bold=True)
    link_font = _font(20)
    body_font = _font(20)
    value_font = _font(23)
    change_font = _font(17)
    header_font = _font(20)
    small_font = _font(18)
    text = (47, 52, 61)
    muted = (105, 111, 122)
    blue = (54, 91, 255)
    line = (226, 230, 236)

    draw.text((31, 28), "主图分析", font=title_font, fill=(26, 29, 35), anchor="lm")
    draw.text((160, 30), "素材管理  ›  素材测试  ›", font=link_font, fill=blue, anchor="lm")

    draw.rounded_rectangle((1480, 19, 1683, 60), radius=8, fill=(249, 250, 252), outline=(218, 223, 232))
    draw.text((1499, 40), "素材类型  图集", font=small_font, fill=muted, anchor="lm")
    draw.polygon(((1658, 36), (1668, 36), (1663, 43)), fill=(151, 157, 167))
    draw.rounded_rectangle((1700, 19, 1901, 60), radius=8, fill=(246, 247, 251))
    _center_text(draw, (1800, 40), "指标选择 (7/10)", small_font, text)
    draw.rounded_rectangle((1915, 19, 2017, 60), radius=8, fill=blue)
    _center_text(draw, (1966, 40), "下载", body_font, (255, 255, 255))

    draw.rounded_rectangle((30, 84, 2019, 132), radius=8, fill=(242, 245, 255))
    draw.ellipse((50, 98, 68, 116), fill=(72, 99, 240))
    _center_text(draw, (59, 107), "i", _font(14, bold=True), (255, 255, 255))
    draw.text((81, 108), "建议浏览，找到更高点击转化主图", font=small_font, fill=muted, anchor="lm")
    draw.rounded_rectangle((1915, 91, 2001, 126), radius=6, fill=blue)
    _center_text(draw, (1958, 109), "去创建", small_font, (255, 255, 255))

    draw.rectangle((30, TABLE_TOP, 2019, TABLE_TOP + HEADER_HEIGHT), fill=(250, 250, 251))
    centers = (75, 225, 460, 690, 900, 1110, 1320, 1530, 1750, 1970)
    headers = (
        "主图素材",
        "素材类型",
        "曝光人数",
        "互动人数",
        "点击率",
        "支付人数",
        "跳失人数",
        "跳失率",
        "支付转化率",
        "操作",
    )
    for x, label in zip(centers, headers):
        _center_text(draw, (x, TABLE_TOP + HEADER_HEIGHT // 2), label, header_font, text)

    loader = thumbnail_loader or _download_thumbnail
    urls = list(dict.fromkeys(str(_value(record, 'contentInfo') or '') for record in shown))
    if thumbnail_loader is None and urls:
        # Only public image downloads use threads. Business APIs stay serial.
        with ThreadPoolExecutor(max_workers=3) as pool:
            thumbnails = dict(zip(urls, pool.map(loader, urls)))
        loader = thumbnails.get
    if not shown:
        _center_text(draw, (CANVAS_WIDTH // 2, TABLE_TOP + HEADER_HEIGHT + ROW_HEIGHT // 2), "暂无主图素材数据", body_font, muted)
    for index, record in enumerate(shown):
        top = TABLE_TOP + HEADER_HEIGHT + index * ROW_HEIGHT
        middle = top + ROW_HEIGHT // 2
        if index:
            draw.line((30, top, 2019, top), fill=line, width=1)
        thumb_url = str(_value(record, "contentInfo") or "")
        thumb = _thumbnail_tile(loader(thumb_url))
        image.paste(thumb, (45, top + 15))
        _center_text(draw, (centers[1], middle), "图集", body_font, text)

        metrics = (
            (centers[2], "itemExposeUv", False),
            (centers[3], "itemInteractUv", False),
            (centers[5], "itemPayUv", False),
            (centers[6], "itemLossUv", False),
            (centers[7], "itemLossRate", True),
            (centers[8], "itemPayConvertRate", True),
        )
        for x, key, as_percent in metrics:
            raw = _value(record, key)
            rendered = _percent(raw) if as_percent else _number(raw)
            _center_text(draw, (x, middle - 12), rendered, value_font, text)
            delta, color = _change(_cycle(record, key))
            _center_text(draw, (x, middle + 20), delta, change_font, color)
        _center_text(draw, (centers[4], middle - 12), format_click_rate(record), value_font, text)
        _center_text(draw, (centers[4], middle + 20), "-", change_font, muted)
        _center_text(draw, (centers[9], middle), "优化图片", small_font, blue)

    if count > 10:
        pages = max(2, math.ceil(count / 10))
        footer_y = TABLE_TOP + HEADER_HEIGHT + row_count * ROW_HEIGHT + 26
        label = "‹ 上一页   1"
        if pages >= 2:
            label += "   2"
        if pages > 2:
            label += f"   …   {pages}"
        label += "   下一页 ›"
        _center_text(draw, (1740, footer_y), label, small_font, muted)
        draw.line((1801, footer_y + 17, 1823, footer_y + 17), fill=blue, width=3)

    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)
    return str(path)
