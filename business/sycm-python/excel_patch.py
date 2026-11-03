#!/usr/bin/env python3
"""Patch 目录下的分级总表，写入生意参谋截图和流量数字，保留 WPS 单元格图片。

只改当前目录的 Excel，绝不读写共享盘。
列号按表头自动识别，避免写到错误列。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
import uuid
import zipfile
from pathlib import Path
from datetime import date
from sycm_time import beijing_today
from xml.sax.saxutils import escape, unescape

from openpyxl.utils import column_index_from_string, get_column_letter
from PIL import Image

ROOT = Path(os.environ.get("SYCM_DATA_DIR", Path(__file__).resolve().parent.parent)).resolve()
DEBUG_LOG = ROOT / ".cursor" / "debug-04f3d7.log"


def find_workbook(directory: Path = ROOT) -> Path:
    """Find the workbook directly beside the launcher, regardless of its name."""
    candidates = sorted(
        path
        for path in directory.iterdir()
        if path.is_file()
        and path.suffix.lower() == ".xlsx"
        and not path.name.startswith((".", "~$"))
        and not re.search(r"(?:-已填|\.patched|\.cleared(?:-main-pic)?)$", path.stem, re.I)
    )
    if not candidates:
        raise FileNotFoundError(f"程序目录没有找到 .xlsx 表格，请把要更新的表格放在此处: {directory}")
    if len(candidates) > 1:
        names = "、".join(path.name for path in candidates)
        raise ValueError(f"程序目录有多个表格: {names}。请只保留本次要更新的表格，其他表格可移入子文件夹。")
    return candidates[0]


def update_workbook_month(xlsx: Path, today: date | None = None) -> Path:
    """Rename only a leading Chinese year/month; never infer a custom name."""
    today = today or beijing_today()
    match = re.match(r'^(\d{4}|\d{2})年(\d{1,2})月', xlsx.stem)
    if not match:
        return xlsx
    year = str(today.year) if len(match[1]) == 4 else f'{today.year % 100:02d}'
    target = xlsx.with_name(f'{year}年{today.month}月{xlsx.stem[match.end():]}{xlsx.suffix}')
    if target == xlsx:
        return xlsx
    if target.exists() or fallback_path(target).exists():
        raise ValueError(f'目标表格或已填副本已存在，不能自动改名: {target.name}')
    if fallback_path(xlsx).exists():
        raise ValueError(f'请先核对并合并旧的已填副本，再更新月份: {fallback_path(xlsx).name}')
    reason = spreadsheet_lock_reason(xlsx)
    if reason:
        raise ValueError(f'改名之前请关闭总表: {reason}')
    # Hard-link creation refuses an existing destination, unlike rename on POSIX.
    os.link(xlsx, target)
    try:
        xlsx.unlink()
    except OSError:
        # Windows may deny deletion if another application opens the file after
        # the lock check. Remove only the new link, preserving the source.
        target.unlink(missing_ok=True)
        raise
    return target


def fallback_path(xlsx: Path) -> Path:
    """Keep the lock fallback next to the selected workbook, using its name."""
    if xlsx.stem.endswith("-已填"):
        return xlsx
    return xlsx.with_name(f"{xlsx.stem}-已填{xlsx.suffix}")


def _dbg(hypothesis_id: str, location: str, message: str, data: dict, run_id: str = "post-fix") -> None:
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

IDENTITY_HEADERS = (
    "商品名称",
    "货号",
)

REQUIRED_HEADERS = (
    "访客",
    "支付转化率",
    "手淘推荐访客",
    "手淘推荐支付转化率",
    "手淘搜索访客",
    "手淘搜索支付转化率",
    "效果广告访客",
    "效果广告支付转化率",
    "内容广告访客",
    "内容广告支付转化率",
    "主图分析",
)

SHOT_HEADERS = ("访客", "支付转化率", "主图分析")
SOURCE_COLS = {
    "手淘推荐": ("手淘推荐访客", "手淘推荐支付转化率"),
    "手淘搜索": ("手淘搜索访客", "手淘搜索支付转化率"),
    "效果广告": ("效果广告访客", "效果广告支付转化率"),
    "内容广告": ("内容广告访客", "内容广告支付转化率"),
}
TEXT_HEADERS = tuple(name for pair in SOURCE_COLS.values() for name in pair)
CHART_FILL_HEADERS = ("访客", "支付转化率") + TEXT_HEADERS

# 商品名称列在 WPS「按单元格背景颜色筛选」里的底色，顺序与筛选面板一致。
NAME_COLORS = (
    ("粉", "FFFF8392"),
    ("灰", "FFF2F2F2"),
    ("紫", "FF7030A0"),
    ("黄", "FFFFFF00"),
    ("绿", "FF00B050"),
    ("蓝", "FFD9E1F2"),
)
# 截图里勾选的颜色：粉、紫、黄、浅蓝。灰和绿不抓。
SELECTED_COLORS = ("粉", "紫", "黄", "蓝")
COLOR_RGB = {name: rgb for name, rgb in NAME_COLORS}
RGB_COLOR = {rgb: name for name, rgb in NAME_COLORS}


def copy_from_share() -> Path:
    raise RuntimeError("已禁止从共享盘复制或改写。请只使用程序目录下的 .xlsx 表格")


def normalize_color(value: str) -> str | None:
    raw = (value or "").strip()
    if not raw:
        return None
    if raw in ("all", "全部"):
        return "all"
    aliases = {"浅红": "粉", "粉红": "粉", "浅蓝": "蓝", "蓝灰": "蓝"}
    raw = aliases.get(raw, raw)
    if raw in COLOR_RGB:
        return raw
    hexv = raw.upper().lstrip("#")
    if len(hexv) == 6:
        hexv = "FF" + hexv
    return RGB_COLOR.get(hexv)


def resolve_book(xlsx: Path | None = None) -> tuple[Path, Path]:
    """WPS 占用原表时改写副本，避免写入后又被覆盖。"""
    workbook = xlsx if xlsx is not None else find_workbook()
    locked = bool(spreadsheet_lock_reason(workbook))
    dest = fallback_path(workbook) if locked else workbook
    src = dest if dest.exists() else workbook
    return src, dest


def _shared_strings(z: zipfile.ZipFile) -> list[str]:
    xml = z.read("xl/sharedStrings.xml").decode("utf-8")
    out: list[str] = []
    for si in re.findall(r"<si>(.*?)</si>", xml, re.S):
        texts = re.findall(r"<t[^>]*>(.*?)</t>", si, re.S)
        out.append("".join(unescape(t) for t in texts))
    return out


def _xf_fill_rgb(z: zipfile.ZipFile) -> list[str | None]:
    styles = z.read("xl/styles.xml").decode("utf-8")
    fills_xml = re.search(r"<fills[^>]*>(.*?)</fills>", styles, re.S)
    xfs_xml = re.search(r"<cellXfs[^>]*>(.*?)</cellXfs>", styles, re.S)
    if not fills_xml or not xfs_xml:
        return []
    fills = re.findall(r"<fill>.*?</fill>|<fill/>", fills_xml.group(1), re.S)
    fill_rgb: list[str | None] = []
    for fill in fills:
        if 'patternType="none"' in fill or fill == "<fill/>":
            fill_rgb.append(None)
            continue
        rgb = re.search(r'<fgColor[^>]*rgb="([^"]+)"', fill)
        fill_rgb.append(rgb.group(1).upper() if rgb else None)
    xfs = re.findall(r"<xf\b[^>]*/>|<xf\b[^>]*>.*?</xf>", xfs_xml.group(1), re.S)
    out: list[str | None] = []
    for xf in xfs:
        m = re.search(r'fillId="(\d+)"', xf)
        fid = int(m.group(1)) if m else 0
        out.append(fill_rgb[fid] if fid < len(fill_rgb) else None)
    return out


def _norm_header(name: str) -> str:
    return re.sub(r"\s+", "", str(name or "").strip())


def _iter_cells(xml: str):
    for cm in re.finditer(
        r'<c r="([A-Z]+)(\d+)"([^>/]*)/>|<c r="([A-Z]+)(\d+)"([^>]*)>(.*?)</c>',
        xml,
        re.S,
    ):
        if cm.group(1):
            yield cm.group(1), int(cm.group(2)), cm.group(3), ""
        else:
            yield cm.group(4), int(cm.group(5)), cm.group(6), cm.group(7) or ""


def _parse_headers(row_xml: str, strings: list[str]) -> dict[str, str]:
    found: dict[str, str] = {}
    for col, _row, attrs, body in _iter_cells(row_xml):
        name = _norm_header(_cell_text(attrs, body, strings))
        if name and name not in found:
            found[name] = col
    return found


def _columns_from_sheet(sheet: str, strings: list[str]) -> dict[str, str]:
    m = _find_row(sheet, 1)
    if not m:
        raise RuntimeError("找不到表头行")
    headers = _parse_headers(m.group(0), strings)
    wanted = IDENTITY_HEADERS + REQUIRED_HEADERS
    found = {name: headers[name] for name in wanted if name in headers}
    missing = [name for name in ("商品名称",) + REQUIRED_HEADERS if name not in found]
    if missing:
        raise RuntimeError(f"目录表格缺少列: {missing}")
    return found


def _max_col_index(cols: dict[str, str]) -> int:
    return max(column_index_from_string(letter) for letter in cols.values())


def _cell_text(attrs: str, body: str, strings: list[str]) -> str:
    if 't="s"' in attrs:
        m = re.search(r"<v>(.*?)</v>", body)
        if not m:
            return ""
        idx = int(m.group(1))
        return strings[idx] if 0 <= idx < len(strings) else ""
    if 't="inlineStr"' in attrs:
        m = re.search(r"<t[^>]*>(.*?)</t>", body)
        return unescape(m.group(1)) if m else ""
    if "DISPIMG" in body:
        return "DISPIMG"
    m = re.search(r"<v>(.*?)</v>", body)
    return unescape(m.group(1)) if m else ""


def _cell_has_value(text: str) -> bool:
    return bool(str(text or "").strip())


def _any_named_field_filled(cells: dict[str, tuple[str, int | None]], cols: dict[str, str], headers: tuple[str, ...]) -> bool:
    for name in headers:
        col = cols.get(name)
        if not col:
            continue
        if _cell_has_value((cells.get(col) or ("", None))[0]):
            return True
    return False


def list_catalog(xlsx: Path | None = None) -> list[dict]:
    """读取分级总表：商品名称、货号、名称底色、该填字段是否已有任意一项。"""
    if xlsx is None:
        xlsx, _dest = resolve_book()
    with zipfile.ZipFile(xlsx) as z:
        strings = _shared_strings(z)
        xf_rgb = _xf_fill_rgb(z)
        sheet = z.read("xl/worksheets/sheet1.xml").decode("utf-8")
    cols = _columns_from_sheet(sheet, strings)
    name_col = cols["商品名称"]
    code_col = cols.get("货号")
    pic_col = cols.get("主图分析")
    items: list[dict] = []
    for mrow in re.finditer(r'<row[^>]* r="(\d+)"[^>]*>.*?</row>', sheet, re.S):
        row = int(mrow.group(1))
        if row == 1:
            continue
        xml = mrow.group(0)
        cells: dict[str, tuple[str, int | None]] = {}
        for col, _r, attrs, body in _iter_cells(xml):
            sm = re.search(r's="(\d+)"', attrs)
            sid = int(sm.group(1)) if sm else None
            cells[col] = (_cell_text(attrs, body, strings), sid)
        name = str((cells.get(name_col) or ("", None))[0]).strip()
        if not name or name.startswith("="):
            continue
        style_id = (cells.get(name_col) or ("", None))[1]
        rgb = xf_rgb[style_id] if style_id is not None and style_id < len(xf_rgb) else None
        pic = str((cells.get(pic_col) or ("", None))[0]).strip() if pic_col else ""
        chart_filled = _any_named_field_filled(cells, cols, ("访客", "支付转化率"))
        flow_filled = _any_named_field_filled(cells, cols, TEXT_HEADERS)
        items.append(
            {
                "row": row,
                "code": str((cells.get(code_col) or ("", None))[0]).strip() if code_col else "",
                "name": name,
                "color": RGB_COLOR.get(rgb or ""),
                "color_rgb": rgb,
                "filled": chart_filled or flow_filled,
                "chart_filled": chart_filled,
                "flow_filled": flow_filled,
                "main_pic_filled": bool(pic),
            }
        )
    return items


def detect_columns(xlsx: Path | None = None) -> dict[str, str]:
    if xlsx is None:
        xlsx, _dest = resolve_book()
    if not xlsx.exists():
        raise FileNotFoundError(f"找不到表格: {xlsx}")
    with zipfile.ZipFile(xlsx) as z:
        strings = _shared_strings(z)
        sheet = z.read("xl/worksheets/sheet1.xml").decode("utf-8")
    return _columns_from_sheet(sheet, strings)


def spreadsheet_lock_reason(path: Path) -> str | None:
    # A lock on the original workbook must not also lock its -已填 copy.
    lock = path.with_name("~$" + path.name)
    locks = [lock] if lock.exists() else []
    if locks:
        return "发现 Excel/WPS 锁文件: " + ", ".join(p.name for p in locks)
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        create = kernel.CreateFileW
        create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                           wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        create.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = create(str(path.resolve()), 0x80000000 | 0x40000000, 0, None, 3, 0x80, None)
        if handle == ctypes.c_void_p(-1).value:
            code = ctypes.get_last_error()
            return f'{path.name} 被占用或不可写（Windows 错误 {code}），请关闭 Excel/WPS 并检查权限'
        kernel.CloseHandle(handle)
        return None
    try:
        out = subprocess.check_output(
            ["lsof", "-nP", str(path)],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return None
    lines = [ln for ln in out.splitlines()[1:] if ln.strip()]
    if lines:
        procs = sorted({ln.split()[0] for ln in lines if ln.split()})
        return f"{path.name} 仍被打开: {', '.join(procs)}"
    return None


def bak_path(path: Path) -> Path:
    return path.with_name(path.name + ".bak")


def backup_book(path: Path) -> Path | None:
    """每次运行只留一份 .bak。新备份覆盖旧备份，新结果覆盖当前表。"""
    if not path.exists():
        return None
    dest = bak_path(path)
    shutil.copy2(path, dest)
    print(f"备份未更新 {path.name} -> {dest.name}")
    return dest


def _max_ids(z: zipfile.ZipFile) -> tuple[int, int, int]:
    rels = z.read("xl/_rels/cellimages.xml.rels").decode("utf-8")
    xml = z.read("xl/cellimages.xml").decode("utf-8")
    rids = [int(x) for x in re.findall(r'Id="rId(\d+)"', rels)]
    img_nums = []
    for name in z.namelist():
        m = re.search(r"xl/media/image(\d+)\.", name)
        if m:
            img_nums.append(int(m.group(1)))
    cids = [int(x) for x in re.findall(r'cNvPr id="(\d+)"', xml)]
    return max(rids or [0]) + 1, max(img_nums or [0]) + 1, max(cids or [0]) + 1


def _append_count_block(xml: str, tag: str, node: str) -> tuple[str, int]:
    m = re.search(rf'<{tag} count="(\d+)">', xml)
    if not m:
        raise RuntimeError(f"styles.xml 缺少 {tag}")
    count = int(m.group(1))
    close = f"</{tag}>"
    idx = xml.find(close, m.end())
    if idx < 0:
        raise RuntimeError(f"styles.xml 缺少 {tag} 结束标签")
    xml = (
        xml[: m.start()]
        + f'<{tag} count="{count + 1}">'
        + xml[m.end() : idx]
        + node
        + xml[idx:]
    )
    return xml, count


def _style_nodes(xml: str, tag: str) -> list[str]:
    block = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", xml, re.S)
    if not block:
        return []
    if tag == "fonts":
        return re.findall(r"<font\b[^>]*>.*?</font>|<font/>", block.group(1), re.S)
    if tag in ("cellXfs", "cellStyleXfs"):
        return re.findall(r"<xf\b[^>]*/>|<xf\b[^>]*>.*?</xf>", block.group(1), re.S)
    if tag == "borders":
        return re.findall(r"<border\b[^>]*>.*?</border>|<border/>", block.group(1), re.S)
    return []


def _replace_style_block(xml: str, tag: str, nodes: list[str]) -> str:
    m = re.search(rf"<{tag}[^>]*>.*?</{tag}>", xml, re.S)
    if not m:
        raise RuntimeError(f"styles.xml 缺少 {tag}")
    return xml[: m.start()] + f'<{tag} count="{len(nodes)}">' + "".join(nodes) + f"</{tag}>" + xml[m.end() :]


def _cellxfs(xml: str) -> list[str]:
    return _style_nodes(xml, "cellXfs")


def _pick_two_line_style(xml: str) -> int | None:
    xflist = _cellxfs(xml)
    fonts = _style_nodes(xml, "fonts")
    for idx, xf in enumerate(xflist):
        if 'wrapText="1"' not in xf or 'horizontal="center"' not in xf:
            continue
        if 'numFmtId="0"' not in xf or 'fillId="0"' not in xf:
            continue
        mfont = re.search(r'fontId="(\d+)"', xf)
        if not mfont:
            continue
        fid = int(mfont.group(1))
        font = fonts[fid] if fid < len(fonts) else ""
        if 'sz val="18"' not in font or 'rgb="FF000000"' not in font:
            continue
        mb = re.search(r'borderId="(\d+)"', xf)
        if not mb or mb.group(1) == "0":
            continue
        if 'applyBorder="1"' not in xf:
            continue
        return idx
    return None


def _sync_style_counts(xml: str) -> str:
    """Keep style count attributes in sync so WPS does not drop borders."""
    specs = (
        ("fonts", r"<font\b[^>]*>.*?</font>|<font/>"),
        ("fills", r"<fill\b[^>]*>.*?</fill>|<fill/>"),
        ("borders", r"<border\b[^>]*>.*?</border>|<border/>"),
        ("cellStyleXfs", r"<xf\b[^>]*/>|<xf\b[^>]*>.*?</xf>"),
        ("cellXfs", r"<xf\b[^>]*/>|<xf\b[^>]*>.*?</xf>"),
    )
    for tag, pat in specs:
        m = re.search(rf"<{tag}(\s[^>]*)?>(.*?)</{tag}>", xml, re.S)
        if not m:
            continue
        n = len(re.findall(pat, m.group(2), re.S))
        attrs = m.group(1) or ""
        if re.search(r'count="\d+"', attrs):
            attrs = re.sub(r'count="\d+"', f'count="{n}"', attrs, count=1)
        else:
            attrs = f' count="{n}"' + attrs
        xml = xml[: m.start()] + f"<{tag}{attrs}>" + m.group(2) + f"</{tag}>" + xml[m.end() :]
    return xml


def ensure_two_line_style(parts: dict[str, bytes]) -> int:
    xml = _sync_style_counts(parts["xl/styles.xml"].decode("utf-8"))
    picked = _pick_two_line_style(xml)
    created = False
    font_xml = ""
    if picked is None:
        font_xml = '<font><sz val="18"/><color rgb="FF000000"/><name val="微软雅黑"/><charset val="134"/></font>'
        xml, font_id = _append_count_block(xml, "fonts", font_xml)
        xf = (
            f'<xf numFmtId="0" fontId="{font_id}" fillId="0" borderId="1" xfId="0" '
            f'applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
            f'<alignment horizontal="center" vertical="center" wrapText="1"/>'
            f"</xf>"
        )
        xml, picked = _append_count_block(xml, "cellXfs", xf)
        created = True
    xml = _sync_style_counts(xml)
    parts["xl/styles.xml"] = xml.encode("utf-8")
    xflist = _cellxfs(xml)
    fonts = _style_nodes(xml, "fonts")
    xf_xml = xflist[picked] if picked < len(xflist) else ""
    mfont = re.search(r'fontId="(\d+)"', xf_xml)
    fid = int(mfont.group(1)) if mfont else -1
    font_xml = fonts[fid] if 0 <= fid < len(fonts) else font_xml
    _dbg(
        "C",
        "excel_patch.py:ensure_two_line_style",
        "流量文本样式",
        {
            "xf_id": picked,
            "created": created,
            "xf_count": len(xflist),
            "font_id": fid,
            "font": font_xml[:180],
            "xf": xf_xml[:280],
        },
    )
    return picked


def _image_emus(image_path: Path) -> tuple[int, int]:
    try:
        with Image.open(image_path) as im:
            width, height = im.size
        return max(width, 1) * 9525, max(height, 1) * 9525
    except Exception:
        return 14287500, 8920800


def _cell_dispimg(ref: str, image_id: str, style: str | None = None) -> str:
    s_attr = f' s="{style or "166"}"'
    return (
        f'<c r="{ref}"{s_attr} t="str">'
        f'<f>_xlfn.DISPIMG(&quot;{image_id}&quot;,1)</f>'
        f'<v>=DISPIMG(&quot;{image_id}&quot;,1)</v>'
        f"</c>"
    )


def _cell_style_id(row_xml: str, col: str, row: int, fallback: str = "166") -> str:
    xml = _cell_xml(row_xml, col, row) or ""
    m = re.search(r'\bs="(\d+)"', xml)
    return m.group(1) if m else fallback


def _append_shared_string(parts: dict[str, bytes], text: str) -> int:
    xml = parts["xl/sharedStrings.xml"].decode("utf-8")
    lines = [ln.strip() for ln in str(text).replace("\r", "").split("\n") if ln.strip()]
    body = "&#10;".join(escape(line) for line in lines)
    space = ' xml:space="preserve"' if len(lines) > 1 else ""
    node = f"<si><t{space}>{body}</t></si>"
    idx = len(re.findall(r"<si>", xml))
    m = re.search(r"<sst\b([^>]*)>", xml)
    if not m:
        raise RuntimeError("sharedStrings.xml 缺少 sst")
    attrs = m.group(1)
    if re.search(r'count="\d+"', attrs):
        attrs = re.sub(r'count="(\d+)"', lambda mm: f'count="{int(mm.group(1)) + 1}"', attrs, count=1)
    if re.search(r'uniqueCount="\d+"', attrs):
        attrs = re.sub(
            r'uniqueCount="(\d+)"',
            lambda mm: f'uniqueCount="{int(mm.group(1)) + 1}"',
            attrs,
            count=1,
        )
    xml = xml[: m.start()] + f"<sst{attrs}>" + xml[m.end() :]
    xml = xml.replace("</sst>", node + "</sst>")
    parts["xl/sharedStrings.xml"] = xml.encode("utf-8")
    return idx


def _cell_two_line(parts: dict[str, bytes], ref: str, text: str, style: int) -> str:
    lines = [ln.strip() for ln in str(text).replace("\r", "").split("\n") if ln.strip()]
    if not lines:
        return ""
    idx = _append_shared_string(parts, "\n".join(lines))
    return f'<c r="{ref}" s="{style}" t="s"><v>{idx}</v></c>'


def _find_row(sheet: str, row: int) -> re.Match[str] | None:
    return re.search(rf'<row[^>]* r="{row}"[^>]*>.*?</row>', sheet, re.S)


def _cell_pattern(ref: str) -> str:
    return rf'<c r="{ref}"[^>/]*(?:/>|>.*?</c>)'


def _source_cell_text(src: dict, kind: str) -> str | None:
    if kind == "uv":
        if src.get("访客文本"):
            return str(src["访客文本"])
        if src.get("访客") is None:
            return None
        value = src["访客"]
        first = str(int(value) if float(value).is_integer() else value)
        second = src.get("访客涨跌文本")
        return f"{first}\n{second}" if second else first
    if src.get("支付转化率文本"):
        return str(src["支付转化率文本"])
    if src.get("支付转化率") is None:
        return None
    first = f"{float(src['支付转化率']) * 100:.2f}%"
    second = src.get("支付转化率涨跌文本")
    return f"{first}\n{second}" if second else first


def _set_row_height(row_xml: str, height: float = 200) -> str:
    if re.search(r'(?<![A-Za-z])ht="', row_xml):
        row_xml = re.sub(r'(?<![A-Za-z])ht="[^"]*"', f' ht="{height}"', row_xml, count=1)
    else:
        row_xml = re.sub(r"<row\b", f'<row ht="{height}"', row_xml, count=1)
    if "customHeight=" not in row_xml:
        row_xml = re.sub(r"<row\b", '<row customHeight="1"', row_xml, count=1)
    return row_xml


def _col_attr(raw: str, name: str, default: str | None = None) -> str | None:
    m = re.search(rf'{name}="([^"]*)"', raw)
    return m.group(1) if m else default


def _merge_col_nodes(nodes: list[str]) -> list[str]:
    merged: list[str] = []
    for node in nodes:
        if not merged:
            merged.append(node)
            continue
        prev = merged[-1]
        prev_max = int(_col_attr(prev, "max") or "0")
        new_min = int(_col_attr(node, "min") or "0")
        new_max = int(_col_attr(node, "max") or "0")
        rest_prev = re.sub(r' (min|max)="\d+"', "", prev)
        rest_new = re.sub(r' (min|max)="\d+"', "", node)
        if rest_prev == rest_new and prev_max + 1 == new_min:
            merged[-1] = re.sub(r'max="\d+"', f'max="{new_max}"', prev, count=1)
        else:
            merged.append(node)
    return merged


def _shot_col_specs(cols: dict[str, str]) -> dict[int, tuple[str, str]]:
    specs: dict[int, tuple[str, str]] = {}
    for name in SHOT_HEADERS:
        letter = cols.get(name)
        if letter:
            specs[column_index_from_string(letter)] = ("52", "166")
    for name in TEXT_HEADERS:
        letter = cols.get(name)
        if letter:
            specs[column_index_from_string(letter)] = ("22", "167")
    return specs


def _widen_shot_columns(sheet: str, cols: dict[str, str]) -> str:
    m = re.search(r"(<cols>)(.*?)(</cols>)", sheet, re.S)
    if not m:
        return sheet
    specs = _shot_col_specs(cols)
    if not specs:
        return sheet
    lo, hi = min(specs), max(specs)
    out: list[str] = []
    covered: set[int] = set()
    for raw in re.findall(r"<col\b[^/]*/>", m.group(2)):
        mn = int(_col_attr(raw, "min") or "0")
        mx = int(_col_attr(raw, "max") or "0")
        if mx < lo or mn > hi:
            out.append(raw)
            continue
        for col in range(mn, mx + 1):
            covered.add(col)
            if col in specs:
                width, style = specs[col]
                hidden = _col_attr(raw, "hidden")
                hidden_attr = f' hidden="{hidden}"' if hidden else ""
                out.append(
                    f'<col min="{col}" max="{col}" width="{width}" style="{style}" '
                    f'customWidth="1"{hidden_attr}/>'
                )
            else:
                node = re.sub(r'min="\d+"', f'min="{col}"', raw, count=1)
                node = re.sub(r'max="\d+"', f'max="{col}"', node, count=1)
                out.append(node)
    for col, (width, style) in sorted(specs.items()):
        if col not in covered:
            out.append(
                f'<col min="{col}" max="{col}" width="{width}" style="{style}" customWidth="1"/>'
            )
    out.sort(key=lambda node: int(_col_attr(node, "min") or "0"))
    inner = "".join(_merge_col_nodes(out))
    return sheet[: m.start()] + m.group(1) + inner + m.group(3) + sheet[m.end() :]


def _ensure_header_cell(sheet: str, col: str, title: str, span_col: int | None = None) -> str:
    m = _find_row(sheet, 1)
    if not m or not col:
        return sheet
    row_xml = m.group(0)
    if re.search(rf'<c r="{col}1"', row_xml):
        return sheet
    cell = f'<c r="{col}1" s="184" t="inlineStr"><is><t>{escape(title)}</t></is></c>'
    row_xml = _upsert_cell(row_xml, col, 1, cell)
    last = span_col or column_index_from_string(col)
    row_xml = re.sub(r'spans="1:\d+"', f'spans="1:{last}"', row_xml, count=1)
    sheet = sheet[: m.start()] + row_xml + sheet[m.end() :]
    last_letter = get_column_letter(last)
    sheet = re.sub(r'<dimension ref="A1:[A-Z]+\d+"/>', f'<dimension ref="A1:{last_letter}13328"/>', sheet, count=1)
    return sheet


def _upsert_cell(row_xml: str, col: str, row: int, cell_xml: str) -> str:
    pattern = _cell_pattern(f"{col}{row}")
    if re.search(pattern, row_xml, re.S):
        return re.sub(pattern, cell_xml, row_xml, count=1, flags=re.S)
    target = column_index_from_string(col)
    for m in re.finditer(r'<c r="([A-Z]+)\d+"', row_xml):
        if column_index_from_string(m.group(1)) > target:
            return row_xml[: m.start()] + cell_xml + row_xml[m.start() :]
    return re.sub(r"</row>", cell_xml + "</row>", row_xml, count=1)


def add_cell_image(
    parts: dict[str, bytes], image_path: Path, rid: int, img_no: int, cid: int
) -> tuple[str, int, int, int]:
    image_id = "ID_" + uuid.uuid4().hex.upper()
    suffix = image_path.suffix.lower() or ".png"
    media_name = f"xl/media/image{img_no}{suffix}"
    parts[media_name] = image_path.read_bytes()
    cx, cy = _image_emus(image_path)
    rel_id = f"rId{rid}"
    rels = parts["xl/_rels/cellimages.xml.rels"].decode("utf-8")
    rel = (
        f'<Relationship Id="{rel_id}" '
        f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
        f'Target="media/image{img_no}{suffix}"/>'
    )
    rels = rels.replace("</Relationships>", rel + "</Relationships>")
    parts["xl/_rels/cellimages.xml.rels"] = rels.encode("utf-8")
    xml = parts["xl/cellimages.xml"].decode("utf-8")
    node = (
        f'<etc:cellImage><xdr:pic><xdr:nvPicPr>'
        f'<xdr:cNvPr id="{cid}" name="{image_id}"/>'
        f'<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
        f'<xdr:blipFill><a:blip r:embed="{rel_id}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'
        f'<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></xdr:spPr>'
        f"</xdr:pic></etc:cellImage>"
    )
    xml = xml.replace("</etc:cellImages>", node + "</etc:cellImages>")
    parts["xl/cellimages.xml"] = xml.encode("utf-8")
    ct = parts["[Content_Types].xml"].decode("utf-8")
    ext = suffix.lstrip(".")
    if ext == "jpg":
        ext = "jpeg"
    override = f'<Override PartName="/{media_name}" ContentType="image/{ext}"/>'
    if f'PartName="/{media_name}"' not in ct:
        ct = ct.replace("</Types>", override + "</Types>")
        parts["[Content_Types].xml"] = ct.encode("utf-8")
    return image_id, rid + 1, img_no + 1, cid + 1


def _patch_row(
    row_xml: str,
    row: int,
    item: dict,
    cols: dict[str, str],
    parts: dict[str, bytes],
    ids: list[int],
    text_style: int,
) -> str:
    rid, img_no, cid = ids
    uv_col = cols["访客"]
    rate_col = cols["支付转化率"]
    if item.get("访客截图") and Path(item["访客截图"]).exists():
        uv_shot = Path(item["访客截图"])
        image_id, rid, img_no, cid = add_cell_image(parts, uv_shot, rid, img_no, cid)
        uv_style = _cell_style_id(row_xml, uv_col, row)
        row_xml = _upsert_cell(row_xml, uv_col, row, _cell_dispimg(f"{uv_col}{row}", image_id, uv_style))
        try:
            with Image.open(uv_shot) as im:
                uv_size = list(im.size)
        except Exception:
            uv_size = []
        _dbg(
            "A",
            "excel_patch.py:_patch_row",
            "写入访客截图尺寸",
            {"row": row, "name": item.get("name"), "size": uv_size, "file": uv_shot.name},
        )
    if item.get("支付转化率截图") and Path(item["支付转化率截图"]).exists():
        image_id, rid, img_no, cid = add_cell_image(parts, Path(item["支付转化率截图"]), rid, img_no, cid)
        rate_style = _cell_style_id(row_xml, rate_col, row)
        row_xml = _upsert_cell(row_xml, rate_col, row, _cell_dispimg(f"{rate_col}{row}", image_id, rate_style))
    sources = item.get("流量来源") or {}
    written: list[str] = []
    skipped: list[str] = []
    for name, (uv_key, rate_key) in SOURCE_COLS.items():
        src = sources.get(name) or {}
        uv_letter, rate_letter = cols[uv_key], cols[rate_key]
        if item.get('replace_flow'):
            # A successful fresh flow response replaces the whole section.
            # Missing channels must not retain metrics from an older round.
            for letter in (uv_letter, rate_letter):
                style = _cell_style_id(row_xml, letter, row)
                style_attr = f' s="{style}"' if style is not None else ''
                row_xml = _upsert_cell(row_xml, letter, row, f'<c r="{letter}{row}"{style_attr}/>')
        uv_text = _source_cell_text(src, "uv")
        rate_text = _source_cell_text(src, "rate")
        if uv_text:
            row_xml = _upsert_cell(
                row_xml, uv_letter, row, _cell_two_line(parts, f"{uv_letter}{row}", uv_text, text_style)
            )
            written.append(f"{uv_letter}:{uv_text.splitlines()[0]}")
        else:
            skipped.append(uv_key)
        if rate_text:
            row_xml = _upsert_cell(
                row_xml, rate_letter, row, _cell_two_line(parts, f"{rate_letter}{row}", rate_text, text_style)
            )
            written.append(f"{rate_letter}:{rate_text.splitlines()[0]}")
        else:
            skipped.append(rate_key)
    _dbg(
        "B",
        "excel_patch.py:_patch_row",
        "流量列写入方式",
        {
            "row": row,
            "name": item.get("name"),
            "style": text_style,
            "cell_type": "sharedString",
            "source_keys": list(sources),
            "written": written,
            "skipped": skipped,
        },
    )
    pic_col = cols.get("主图分析")
    if pic_col and item.get("主图分析截图") and Path(item["主图分析截图"]).exists():
        image_id, rid, img_no, cid = add_cell_image(parts, Path(item["主图分析截图"]), rid, img_no, cid)
        pic_style = _cell_style_id(row_xml, pic_col, row)
        row_xml = _upsert_cell(row_xml, pic_col, row, _cell_dispimg(f"{pic_col}{row}", image_id, pic_style))
    ids[:] = [rid, img_no, cid]
    max_col = _max_col_index(cols)
    row_xml = re.sub(r'spans="1:\d+"', f'spans="1:{max_col}"', row_xml, count=1)
    return _set_row_height(row_xml)


def _replace_dest(tmp: Path, dest: Path) -> Path:
    try:
        shutil.move(str(tmp), str(dest))
        return dest
    except OSError as exc:
        fallback = fallback_path(dest)
        shutil.move(str(tmp), str(fallback))
        print(f"原表无法覆盖（{exc}），已改写到 {fallback}")
        return fallback


def _cell_xml(row_xml: str, col: str, row: int) -> str | None:
    m = re.search(_cell_pattern(f"{col}{row}"), row_xml, re.S)
    return m.group(0) if m else None


def _cell_display_text(cell_xml: str, strings: list[str]) -> str:
    if not cell_xml:
        return ""
    if "DISPIMG" in cell_xml:
        return "DISPIMG"
    if 't="inlineStr"' in cell_xml:
        m = re.search(r"<t[^>]*>(.*?)</t>", cell_xml, re.S)
        raw = unescape(m.group(1)) if m else ""
        return raw.replace("&#10;", "\n")
    if 't="s"' in cell_xml:
        m = re.search(r"<v>(.*?)</v>", cell_xml)
        if not m:
            return ""
        idx = int(m.group(1))
        return strings[idx] if 0 <= idx < len(strings) else ""
    m = re.search(r"<v>(.*?)</v>", cell_xml)
    return unescape(m.group(1)) if m else ""


def verify_results(xlsx: Path, results: list[dict], cols: dict[str, str]) -> None:
    with zipfile.ZipFile(xlsx) as z:
        sheet = z.read("xl/worksheets/sheet1.xml").decode("utf-8")
        strings = _shared_strings(z)
    for item in results:
        row = int(item["row"])
        m = _find_row(sheet, row)
        if not m:
            raise RuntimeError(f"写入后找不到第 {row} 行")
        row_xml = m.group(0)
        if item.get("访客截图") and "DISPIMG" not in (_cell_xml(row_xml, cols["访客"], row) or ""):
            raise RuntimeError(f"写入后 {cols['访客']}{row} 没有访客截图")
        if item.get("支付转化率截图") and "DISPIMG" not in (_cell_xml(row_xml, cols["支付转化率"], row) or ""):
            raise RuntimeError(f"写入后 {cols['支付转化率']}{row} 没有支付转化率截图")
        sources = item.get("流量来源") or {}
        rec = sources.get("手淘推荐") or {}
        if rec.get("访客") is not None or rec.get("访客文本"):
            uv_xml = _cell_xml(row_xml, cols["手淘推荐访客"], row) or ""
            cell_text = _cell_display_text(uv_xml, strings)
            needle = str(rec.get("访客文本") or rec.get("访客") or "").split("\n")[0].replace(",", "")
            if needle and needle not in cell_text.replace(",", "").replace("&#10;", "\n"):
                raise RuntimeError(f"写入后 {cols['手淘推荐访客']}{row} 没有手淘推荐访客")
            if rec.get("访客涨跌文本") and "\n" not in cell_text.replace("&#10;", "\n"):
                raise RuntimeError(f"写入后 {cols['手淘推荐访客']}{row} 缺少第二行涨跌")
            _dbg(
                "B",
                "excel_patch.py:verify_results",
                "手淘推荐访客单元格",
                {
                    "row": row,
                    "xml_prefix": uv_xml[:160],
                    "cell_text": cell_text[:80],
                    "uses_shared": 't="s"' in uv_xml,
                    "uses_inline": 't="inlineStr"' in uv_xml,
                },
            )
        if item.get("主图分析截图") and cols.get("主图分析"):
            if "DISPIMG" not in (_cell_xml(row_xml, cols["主图分析"], row) or ""):
                raise RuntimeError(f"写入后 {cols['主图分析']}{row} 没有主图分析截图")


def apply_results(xlsx: Path, results: list[dict], *, destination: Path | None = None) -> Path:
    if not results:
        return xlsx
    # A batch run supplies a pinned destination and the previous committed file.
    # Never reselect the original workbook when its WPS lock disappears.
    src, dest = resolve_book(xlsx) if destination is None else (xlsx, destination)
    if destination is not None:
        reason = spreadsheet_lock_reason(dest)
        if reason:
            raise PermissionError(f"本轮写入文件被占用，请关闭后继续：{dest}（{reason}）")
    if src != dest:
        print(f"原表被占用，从 {src.name} 写入 {dest.name}")
    cols = detect_columns(src)
    reason = spreadsheet_lock_reason(xlsx)
    if reason:
        print("警告:", reason)
    tmp = dest.with_name(dest.stem + ".patched.xlsx")
    with zipfile.ZipFile(src, "r") as zin:
        parts = {name: zin.read(name) for name in zin.namelist()}
        ids = list(_max_ids(zin))

    text_style = ensure_two_line_style(parts)
    sheet = parts["xl/worksheets/sheet1.xml"].decode("utf-8")
    pic_col = cols.get("主图分析")
    if pic_col:
        sheet = _ensure_header_cell(sheet, pic_col, "主图分析", span_col=_max_col_index(cols))
    sheet = _widen_shot_columns(sheet, cols)
    for item in results:
        row = int(item["row"])
        m = _find_row(sheet, row)
        if not m:
            print(f"  跳过：找不到第 {row} 行")
            continue
        row_xml = _patch_row(m.group(0), row, item, cols, parts, ids, text_style)
        sheet = sheet[: m.start()] + row_xml + sheet[m.end() :]
    parts["xl/worksheets/sheet1.xml"] = sheet.encode("utf-8")

    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        for name, data in parts.items():
            zout.writestr(name, data)
    if destination is None:
        written = _replace_dest(tmp, dest)
    else:
        reason = spreadsheet_lock_reason(dest)
        if reason:
            raise PermissionError(f"本轮写入文件被占用，请关闭后继续：{dest}（{reason}）")
        # Replacement failure must stop the round, not split it across files.
        tmp.replace(dest)
        written = dest
    _dbg(
        "D",
        "excel_patch.py:apply_results",
        "写入完成",
        {
            "written": written.name,
            "count": len(results),
            "rows": [int(r["row"]) for r in results if r.get("row")][:20],
        },
    )
    verify_results(written, [r for r in results if r.get("row") and not r.get("error")], cols)
    return written


def _empty_cell(ref: str, style: str | None) -> str:
    s_attr = f' s="{style}"' if style else ""
    return f'<c r="{ref}"{s_attr}/>'


def _prune_cell_images(parts: dict[str, bytes], image_ids: set[str]) -> tuple[int, int]:
    """Remove selected WPS cell-image definitions, relationships and media files."""
    if not image_ids or "xl/cellimages.xml" not in parts:
        return 0, 0
    xml = parts["xl/cellimages.xml"].decode("utf-8")
    removed_rel_ids: set[str] = set()
    removed_nodes = 0

    def keep_or_remove(match: re.Match[str]) -> str:
        nonlocal removed_nodes
        node = match.group(0)
        name = re.search(r'<xdr:cNvPr\b[^>]*\bname="([^"]+)"', node)
        if not name or name.group(1) not in image_ids:
            return node
        removed_nodes += 1
        removed_rel_ids.update(re.findall(r'\br:embed="([^"]+)"', node))
        return ""

    xml = re.sub(r"<etc:cellImage>.*?</etc:cellImage>", keep_or_remove, xml, flags=re.S)
    parts["xl/cellimages.xml"] = xml.encode("utf-8")
    if not removed_rel_ids or "xl/_rels/cellimages.xml.rels" not in parts:
        return removed_nodes, 0

    remaining_rel_ids = set(re.findall(r'\br:embed="([^"]+)"', xml))
    removable_rel_ids = removed_rel_ids - remaining_rel_ids
    rels = parts["xl/_rels/cellimages.xml.rels"].decode("utf-8")
    removed_media: set[str] = set()

    def keep_or_remove_rel(match: re.Match[str]) -> str:
        node = match.group(0)
        rel_id = re.search(r'\bId="([^"]+)"', node)
        if not rel_id or rel_id.group(1) not in removable_rel_ids:
            return node
        target = re.search(r'\bTarget="([^"]+)"', node)
        if target:
            removed_media.add("xl/" + target.group(1).lstrip("/"))
        return ""

    rels = re.sub(r"<Relationship\b[^>]*/>", keep_or_remove_rel, rels)
    parts["xl/_rels/cellimages.xml.rels"] = rels.encode("utf-8")
    for media_name in removed_media:
        parts.pop(media_name, None)
    if "[Content_Types].xml" in parts and removed_media:
        content_types = parts["[Content_Types].xml"].decode("utf-8")
        for media_name in removed_media:
            content_types = re.sub(
                rf'<Override\b[^>]*\bPartName="/{re.escape(media_name)}"[^>]*/>',
                "",
                content_types,
            )
        parts["[Content_Types].xml"] = content_types.encode("utf-8")
    return removed_nodes, len(removed_media)


def clear_main_pic_cells(xlsx: Path, rows: list[int]) -> Path:
    """Clear only the 主图分析 cells and delete their embedded WPS image payloads."""
    if not rows:
        return xlsx
    src, dest = resolve_book(xlsx)
    cols = detect_columns(src)
    pic_col = cols.get("主图分析")
    if not pic_col:
        raise RuntimeError("目录表格缺少主图分析列")
    tmp = dest.with_name(dest.stem + ".cleared-main-pic.xlsx")
    with zipfile.ZipFile(src, "r") as zin:
        parts = {name: zin.read(name) for name in zin.namelist()}
    sheet = parts["xl/worksheets/sheet1.xml"].decode("utf-8")
    image_ids: set[str] = set()
    cleared_rows = 0
    for row in sorted({int(row) for row in rows}):
        m = _find_row(sheet, row)
        if not m:
            continue
        row_xml = m.group(0)
        xml = _cell_xml(row_xml, pic_col, row)
        if not xml or "DISPIMG" not in xml:
            continue
        image_ids.update(re.findall(r'DISPIMG\(&quot;([^&]+)&quot;,1\)', xml))
        sm = re.search(r'\bs="(\d+)"', xml)
        style = sm.group(1) if sm else None
        row_xml = _upsert_cell(row_xml, pic_col, row, _empty_cell(f"{pic_col}{row}", style))
        sheet = sheet[: m.start()] + row_xml + sheet[m.end() :]
        cleared_rows += 1
    parts["xl/worksheets/sheet1.xml"] = sheet.encode("utf-8")
    removed_nodes, removed_media = _prune_cell_images(parts, image_ids)
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        for name, data in parts.items():
            zout.writestr(name, data)
    written = _replace_dest(tmp, dest)
    print(
        f"已清空主图分析 {cleared_rows} 行，删除嵌入图片 {removed_nodes} 个、媒体文件 {removed_media} 个"
        f" -> {written.name}"
    )
    return written


def clear_scrape_cells(xlsx: Path, rows: list[int]) -> Path:
    """Empty header-matched scrape columns for the given rows, keep name/product image and borders."""
    if not rows:
        return xlsx
    src, dest = resolve_book(xlsx)
    cols = detect_columns(src)
    tmp = dest.with_name(dest.stem + ".cleared.xlsx")
    with zipfile.ZipFile(src, "r") as zin:
        parts = {name: zin.read(name) for name in zin.namelist()}
    sheet = parts["xl/worksheets/sheet1.xml"].decode("utf-8")
    wanted = {int(row) for row in rows}
    for row in sorted(wanted):
        m = _find_row(sheet, row)
        if not m:
            continue
        row_xml = m.group(0)
        for name in REQUIRED_HEADERS:
            col = cols.get(name)
            if not col:
                continue
            xml = _cell_xml(row_xml, col, row)
            if not xml:
                continue
            sm = re.search(r'\bs="(\d+)"', xml)
            style = sm.group(1) if sm else None
            row_xml = _upsert_cell(row_xml, col, row, _empty_cell(f"{col}{row}", style))
        sheet = sheet[: m.start()] + row_xml + sheet[m.end() :]
    parts["xl/worksheets/sheet1.xml"] = sheet.encode("utf-8")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        for name, data in parts.items():
            zout.writestr(name, data)
    written = _replace_dest(tmp, dest)
    print(f"已清空 {len(wanted)} 行已填列 -> {written.name}")
    return written
