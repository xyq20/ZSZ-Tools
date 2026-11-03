#!/usr/bin/env python3
"""Render 生意参谋 trend curves with the current metric number on top."""
from __future__ import annotations

import math
import os
import re
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

CHART_SIZE = (640, 248)
LINE_COLOR = (27, 107, 255)
TITLE_COLOR = (32, 32, 32)
LABEL_COLOR = (64, 64, 64)
GRID_COLOR = (230, 230, 230)
BG_COLOR = (252, 252, 248)
AXIS_COLOR = (180, 180, 180)
PERCENT_CODES = ("payRate", "crtRate", "pPayRate")
FONT_CANDIDATES = (
    str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "msyh.ttc"),
    str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "simhei.ttf"),
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
)


def metric_caption(title: str, value: str) -> str:
    title = (title or "").strip()
    value = (value or "").strip()
    if not value:
        return title
    if title and value.startswith(title):
        return value
    return f"{title} {value}".strip()


def parse_metric_value(text: str, title: str) -> str | None:
    raw = (text or "").replace("\xa0", " ")
    lines = [ln.strip() for ln in re.split(r"[\n\r|]+", raw) if ln.strip()]
    want = re.sub(r"\s+", "", title or "")
    start = 0
    for i, line in enumerate(lines):
        compact = re.sub(r"\s+", "", line)
        if compact == want or compact.startswith(want):
            start = i
            extra = compact[len(want) :] if compact.startswith(want) else ""
            if extra and re.search(r"\d", extra):
                return extra
            break
    for line in lines[start + 1 :]:
        if "较前" in line or "较昨" in line:
            continue
        if re.search(r"\d", line):
            return line.replace(" ", "")
    compact = re.sub(r"\s+", "", raw)
    m = re.search(re.escape(want) + r"([0-9,]+\.?\d*%?)", compact)
    return m.group(1) if m else None


def format_metric_value(index_code: str, value: float) -> str:
    if index_code in PERCENT_CODES:
        pct = value * 100 if abs(value) <= 1 else value
        return f"{pct:.2f}%"
    if float(value).is_integer():
        return f"{int(value):,}"
    return f"{value:.2f}"


def format_axis_date(value: str) -> str:
    text = _as_date(value)
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", text)
    if m:
        return f"{m.group(2)}-{m.group(3)}"
    m = re.search(r"(\d{2})-(\d{2})$", text)
    return m.group(0) if m else text


def x_tick_labels(dates: list[str], max_labels: int = 8) -> list[tuple[int, str]]:
    n = len(dates)
    if n == 0:
        return []
    if n <= max_labels:
        idxs = list(range(n))
    else:
        idxs = sorted({round(i * (n - 1) / (max_labels - 1)) for i in range(max_labels)})
    return [(i, format_axis_date(dates[i])) for i in idxs]


def _nice_num(value: float, round_up: bool) -> float:
    if value <= 0:
        return 0.0
    exp = math.floor(math.log10(value))
    base = 10 ** exp
    frac = value / base
    if round_up:
        if frac <= 1:
            nice = 1
        elif frac <= 1.5:
            nice = 1.5
        elif frac <= 2:
            nice = 2
        elif frac <= 5:
            nice = 5
        else:
            nice = 10
    else:
        if frac < 1.5:
            nice = 1
        elif frac < 3:
            nice = 2
        elif frac < 7:
            nice = 5
        else:
            nice = 10
    return nice * base


def _nice_ticks(lo: float, hi: float, count: int = 5) -> list[float]:
    if hi < lo:
        lo, hi = hi, lo
    if math.isclose(hi, lo):
        hi = lo + 1
    if lo > 0 and lo < (hi - lo) * 0.2:
        lo = 0.0
    step = _nice_num((hi - lo) / max(count - 1, 1), True)
    if step <= 0:
        step = 1.0
    nice_lo = math.floor(lo / step) * step
    nice_hi = math.ceil(hi / step) * step
    ticks: list[float] = []
    x = nice_lo
    for _ in range(16):
        ticks.append(round(x, 10))
        if x >= nice_hi - step * 1e-9:
            break
        x += step
    return ticks


def y_tick_labels(values: list[float], index_code: str, count: int = 5) -> list[tuple[float, str]]:
    nums = [float(v) for v in values if v is not None]
    if not nums:
        return []
    percent = index_code in PERCENT_CODES
    hi = max(nums)
    lo = min(0.0, min(nums))
    if percent and abs(hi) <= 1:
        hi_disp = hi * 100 * 1.15 if hi > 0 else 1.0
        ticks_disp = _nice_ticks(lo * 100, hi_disp, count)
        return [(t / 100.0, f"{t:.2f}%") for t in ticks_disp]
    ticks = _nice_ticks(lo, hi, count)
    out: list[tuple[float, str]] = []
    for t in ticks:
        if abs(t - round(t)) < 1e-6:
            text = f"{int(round(t)):,}"
        else:
            text = f"{t:.2f}"
        out.append((t, text))
    return out


def _monotone_slopes(ys: list[float]) -> list[float]:
    n = len(ys)
    if n < 2:
        return [0.0] * n
    d = [ys[i + 1] - ys[i] for i in range(n - 1)]
    m = [0.0] * n
    m[0] = d[0]
    m[-1] = d[-1]
    for i in range(1, n - 1):
        if d[i - 1] * d[i] <= 0:
            m[i] = 0.0
        else:
            m[i] = (d[i - 1] + d[i]) / 2
    for i in range(n - 1):
        if d[i] == 0:
            m[i] = 0.0
            m[i + 1] = 0.0
            continue
        a = m[i] / d[i]
        b = m[i + 1] / d[i]
        s = a * a + b * b
        if s > 9:
            t = 3 / math.sqrt(s)
            m[i] = t * a * d[i]
            m[i + 1] = t * b * d[i]
    return m


def smooth_curve_points(pts: list[tuple[float, float]], steps: int = 16) -> list[tuple[float, float]]:
    if len(pts) < 3:
        return list(pts)
    ys = [p[1] for p in pts]
    m = _monotone_slopes(ys)
    out: list[tuple[float, float]] = []
    for i in range(len(pts) - 1):
        x0, y0 = pts[i]
        x1, y1 = pts[i + 1]
        for s in range(steps):
            t = s / steps
            t2 = t * t
            t3 = t2 * t
            h00 = 2 * t3 - 3 * t2 + 1
            h10 = t3 - 2 * t2 + t
            h01 = -2 * t3 + 3 * t2
            h11 = t3 - t2
            x = x0 + (x1 - x0) * t
            y = h00 * y0 + h10 * m[i] + h01 * y1 + h11 * m[i + 1]
            out.append((x, y))
    out.append(pts[-1])
    return out


def _as_date(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        return _as_date(value.get("value") or value.get("statDate"))
    text = str(value).strip()
    if re.fullmatch(r"\d{8}", text):
        return f"{text[:4]}-{text[4:6]}-{text[6:]}"
    return text


def _as_num(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, dict):
        return _as_num(value.get("value"))
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "").replace("%", "")
    if text in ("", "-", "--"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_trend_series(payload: Any, index_code: str) -> list[tuple[str, float]]:
    if payload is None:
        return []
    data = payload.get("data") if isinstance(payload, dict) else payload
    if data is None:
        return []
    if isinstance(data, dict) and "data" in data and index_code not in data:
        nested = parse_trend_series({"data": data.get("data")}, index_code)
        if nested:
            return nested
    if isinstance(data, dict):
        series = data.get(index_code)
        dates = data.get("statDate") or data.get("date") or data.get("dt")
        if isinstance(series, list) and series and isinstance(series[0], (int, float)):
            date_list = dates if isinstance(dates, list) else [""] * len(series)
            out: list[tuple[str, float]] = []
            for i, val in enumerate(series):
                num = _as_num(val)
                if num is None:
                    continue
                date = _as_date(date_list[i] if i < len(date_list) else "")
                out.append((date, num))
            return out
        if isinstance(series, list) and series and isinstance(series[0], dict):
            out = []
            for rec in series:
                num = _as_num(rec.get("value") if "value" in rec else rec.get(index_code))
                if num is None:
                    continue
                out.append((_as_date(rec.get("statDate") or rec.get("date")), num))
            return out
        if isinstance(series, dict):
            values = series.get("value") or series.get("values") or series.get("list")
            if isinstance(values, list):
                return parse_trend_series(
                    {"data": {index_code: values, "statDate": dates or series.get("statDate")}},
                    index_code,
                )
        for val in data.values():
            found = parse_trend_series(val, index_code)
            if len(found) >= 2:
                return found
    if isinstance(data, list) and data and isinstance(data[0], dict):
        out = []
        for rec in data:
            num = _as_num(rec.get(index_code) if index_code in rec else rec.get("value"))
            if num is None:
                continue
            out.append((_as_date(rec.get("statDate") or rec.get("date")), num))
        if out:
            return out
    return []


def parse_overview_value(payload: Any, index_code: str) -> float | None:
    data: Any = payload
    for _ in range(4):
        if not isinstance(data, dict):
            return None
        if index_code in data:
            return _as_num(data[index_code])
        nested = data.get("data")
        if nested is data or nested is None:
            return None
        data = nested
    return None


def parse_svg_path_points(d: str) -> list[tuple[float, float]]:
    tokens = re.findall(r"[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?", (d or "").replace(",", " "))
    items: list[tuple[str, list[float]]] = []
    current = ""
    nums: list[float] = []
    for token in tokens:
        if re.fullmatch(r"[A-Za-z]", token):
            if current:
                items.append((current, nums))
            current = token
            nums = []
        else:
            try:
                nums.append(float(token))
            except ValueError:
                continue
    if current:
        items.append((current, nums))
    points: list[tuple[float, float]] = []
    cx = cy = 0.0
    for cmd, arr in items:
        i = 0
        while i < len(arr):
            if cmd in ("M", "L"):
                if i + 1 >= len(arr):
                    break
                cx, cy = arr[i], arr[i + 1]
                points.append((cx, cy))
                i += 2
                if cmd == "M":
                    cmd = "L"
            elif cmd in ("m", "l"):
                if i + 1 >= len(arr):
                    break
                cx += arr[i]
                cy += arr[i + 1]
                points.append((cx, cy))
                i += 2
                if cmd == "m":
                    cmd = "l"
            elif cmd == "C":
                if i + 5 >= len(arr):
                    break
                cx, cy = arr[i + 4], arr[i + 5]
                points.append((cx, cy))
                i += 6
            elif cmd == "c":
                if i + 5 >= len(arr):
                    break
                cx += arr[i + 4]
                cy += arr[i + 5]
                points.append((cx, cy))
                i += 6
            elif cmd == "H":
                cx = arr[i]
                points.append((cx, cy))
                i += 1
            elif cmd == "h":
                cx += arr[i]
                points.append((cx, cy))
                i += 1
            elif cmd == "V":
                cy = arr[i]
                points.append((cx, cy))
                i += 1
            elif cmd == "v":
                cy += arr[i]
                points.append((cx, cy))
                i += 1
            else:
                i += 1
    return points


def extract_recharts_series(page: Any) -> list[float]:
    try:
        info = page.evaluate(
            """() => {
              const root = document.querySelector('.alife-one-design-sycm-indexes-trend-chart-container-trend')
                || document.querySelector('.recharts-wrapper');
              if (!root) return null;
              const dots = [...root.querySelectorAll('circle.recharts-dot, .recharts-line-dots circle')]
                .map(el => ({x: +el.getAttribute('cx'), y: +el.getAttribute('cy')}))
                .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
                .sort((a, b) => a.x - b.x);
              const path = root.querySelector('path.recharts-curve, path.recharts-line-curve, path.recharts-area-curve');
              return {dots, d: path ? (path.getAttribute('d') || '') : ''};
            }"""
        )
    except Exception:
        return []
    if not info:
        return []
    dots = info.get("dots") or []
    ys = [float(d["y"]) for d in dots if d.get("y") is not None]
    if len(ys) < 2:
        pts = parse_svg_path_points(str(info.get("d") or ""))
        ys = [p[1] for p in pts]
    if len(ys) < 2:
        return []
    top, bot = min(ys), max(ys)
    if bot - top < 1e-6:
        return [1.0] * len(ys)
    return [bot - y for y in ys]


def _font(size: int) -> ImageFont.ImageFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size=size, index=0)
            except Exception:
                continue
    return ImageFont.load_default()


def _text_size(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> tuple[int, int]:
    box = draw.textbbox((0, 0), text, font=font)
    return box[2] - box[0], box[3] - box[1]


def render_metric_chart(
    path: Path | str,
    caption: str,
    values: list[float],
    dates: list[str] | None = None,
    index_code: str = "",
) -> str:
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    width, height = CHART_SIZE
    img = Image.new("RGB", (width, height), BG_COLOR)
    draw = ImageDraw.Draw(img)
    title_font = _font(20)
    axis_font = _font(12)
    draw.text((16, 8), caption or "", fill=TITLE_COLOR, font=title_font)
    nums = [float(v) for v in values if v is not None]
    ticks = y_tick_labels(nums, index_code) if nums else []
    y_labels = [text for _val, text in ticks]
    label_w = max((_text_size(draw, text, axis_font)[0] for text in y_labels), default=24)
    left = 16 + label_w + 8
    right = width - 16
    top = 46
    bottom = height - 28
    if ticks:
        lo, hi = ticks[0][0], ticks[-1][0]
    elif nums:
        lo, hi = min(nums), max(nums)
    else:
        lo, hi = 0.0, 1.0
    if hi - lo < 1e-12:
        hi = lo + 1.0
    span = hi - lo
    for val, text in ticks:
        y = bottom - (val - lo) / span * (bottom - top)
        draw.line((left, y, right, y), fill=GRID_COLOR, width=1)
        tw, th = _text_size(draw, text, axis_font)
        draw.text((left - 6 - tw, y - th / 2), text, fill=LABEL_COLOR, font=axis_font)
    draw.line((left, bottom, right, bottom), fill=AXIS_COLOR, width=1)
    date_list = list(dates or [])
    if len(nums) >= 2:
        pts: list[tuple[float, float]] = []
        count = len(nums)
        for i, val in enumerate(nums):
            x = left + (right - left) * i / (count - 1)
            y = bottom - (val - lo) / span * (bottom - top)
            pts.append((x, y))
        curve = [(round(x, 2), round(y, 2)) for x, y in smooth_curve_points(pts)]
        draw.line(curve, fill=LINE_COLOR, width=3, joint="curve")
        for idx, text in x_tick_labels(date_list[:count] if date_list else []):
            if idx >= count:
                continue
            x = left + (right - left) * idx / (count - 1)
            tw, th = _text_size(draw, text, axis_font)
            draw.text((x - tw / 2, bottom + 4), text, fill=LABEL_COLOR, font=axis_font)
    elif date_list:
        for idx, text in x_tick_labels(date_list):
            tw, th = _text_size(draw, text, axis_font)
            x = left + (right - left) * idx / max(len(date_list) - 1, 1)
            draw.text((x - tw / 2, bottom + 4), text, fill=LABEL_COLOR, font=axis_font)
    img.save(dest, format="PNG")
    return str(dest)
