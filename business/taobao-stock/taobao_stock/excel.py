"""Read the explicitly selected stock source without changing the workbook."""

import hashlib
import math
import re
import unicodedata
from decimal import Decimal, InvalidOperation
from pathlib import Path
from xml.etree import ElementTree

from openpyxl import load_workbook
from openpyxl.styles.colors import COLOR_INDEX


RULES_VERSION = "q-yellow-zero-v1"


class WorkbookError(ValueError):
    """The workbook is not an unambiguous, validated stock source."""


def normalize_title(value):
    if value is None:
        return ""
    return " ".join(unicodedata.normalize("NFKC", str(value)).split())


def normalize_code(value):
    """Do not rewrite SKU punctuation, case, or full-width characters."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return ""
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            return ""
        if value.is_integer():
            return str(int(value))
    return str(value).strip()


def integer(value, description):
    if value is None or isinstance(value, bool) or str(value).strip() == "":
        raise WorkbookError("{}缺失或不是整数".format(description))
    try:
        number = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        raise WorkbookError("{}不是整数：{!r}".format(description, value))
    if not number.is_finite() or number != number.to_integral_value():
        raise WorkbookError("{}不是有限整数：{!r}".format(description, value))
    return int(number)


def _sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _rgb(color, workbook):
    """Resolve exact RGB/indexed/theme colours; never guess a yellow shade."""
    if color.type == "rgb":
        value = color.rgb
    elif color.type == "indexed":
        palette = workbook._colors or COLOR_INDEX
        if not 0 <= color.indexed < len(palette):
            raise WorkbookError("库存总和底色使用未支持的系统颜色")
        value = palette[color.indexed]
    elif color.type == "theme":
        try:
            root = ElementTree.fromstring(workbook.loaded_theme)
            ns = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
            scheme = root.find(ns + "themeElements/" + ns + "clrScheme")
            entry = list(list(scheme)[color.theme])[0]
            value = entry.get("val") if entry.tag == ns + "srgbClr" else entry.get("lastClr")
        except (TypeError, ValueError, IndexError, ElementTree.ParseError):
            raise WorkbookError("库存总和底色的主题颜色无法解析") from None
    else:
        raise WorkbookError("库存总和底色使用未知颜色类型")
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{6}([0-9a-fA-F]{2})?", value):
        raise WorkbookError("库存总和底色 RGB 无法解析")
    value = value[-6:].upper()
    if color.tint:
        # Tint transforms channels; a tinted yellow isn't silently treated as
        # the exact yellow business mark. Reject rather than approximate HLS.
        raise WorkbookError("库存总和底色含 tint，不能确定是否为黄色业务标记")
    return value


def _fill_colour(fill, workbook, differential=False):
    if fill is None:
        return None
    if not hasattr(fill, "patternType"):
        raise WorkbookError("库存总和底色不是单色填充，不能确定黄色标记")
    if fill.patternType is None:
        return None
    if fill.patternType != "solid":
        raise WorkbookError("库存总和底色不是单色填充，不能确定黄色标记")
    colour = fill.fgColor
    # WPS serializes conditional solid fill with bgColor alone. openpyxl then
    # supplies an absent foreground as transparent 00000000. Direct cell fills
    # still use fgColor only; a yellow background behind a black solid is not
    # a yellow cell. This is the format actually present in the supplied file.
    if (differential and colour.type == "rgb" and colour.rgb == "00000000"
            and not (fill.bgColor.type == "rgb" and fill.bgColor.rgb == "00000000")):
        colour = fill.bgColor
    return _rgb(colour, workbook)


def _compile_colour_rules(sheet, workbook):
    compiled = []
    for region, rules in sheet.conditional_formatting._cf_rules.items():
        ranges = [r for r in region.sqref.ranges if r.min_col <= 17 <= r.max_col]
        if not ranges:
            continue
        for rule in rules:
            colour = _fill_colour(rule.dxf.fill, workbook, differential=True) if rule.dxf else None
            # A colour scale may itself yield yellow, and cannot be treated as
            # a simple yes/no mark. A stop rule may suppress a later fill rule.
            if rule.type == "colorScale":
                raise WorkbookError("库存总和含未知颜色渐变条件格式，请先明确黄色规则")
            if colour is None and not rule.stopIfTrue:
                continue
            counts = {"lessThan": 1, "lessThanOrEqual": 1, "greaterThan": 1,
                      "greaterThanOrEqual": 1, "equal": 1, "notEqual": 1,
                      "between": 2, "notBetween": 2}
            if rule.type != "cellIs" or rule.operator not in counts:
                raise WorkbookError("库存总和含未知黄色/底色条件格式表达式，拒绝猜测")
            formulas = rule.formula or []
            if len(formulas) != counts[rule.operator]:
                raise WorkbookError("库存总和条件格式的比较参数数量不符")
            thresholds = []
            for formula in formulas:
                literal = str(formula).strip()
                if not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", literal):
                    raise WorkbookError("库存总和黄色/底色条件格式不是常量比较，拒绝猜测")
                value = Decimal(literal)
                if not value.is_finite():
                    raise WorkbookError("库存总和条件格式比较值不是有限数")
                thresholds.append(value)
            compiled.append({"ranges": ranges, "priority": rule.priority,
                             "stop": bool(rule.stopIfTrue), "colour": colour,
                             "operator": rule.operator, "thresholds": thresholds,
                             "evidence": "条件格式 {} {} {}".format(region.sqref, rule.operator, ",".join(map(str, thresholds)))})
    return sorted(compiled, key=lambda item: item["priority"])


def _condition_matches(value, operator, limits):
    checks = {
        "lessThan": lambda: value < limits[0],
        "lessThanOrEqual": lambda: value <= limits[0],
        "greaterThan": lambda: value > limits[0],
        "greaterThanOrEqual": lambda: value >= limits[0],
        "equal": lambda: value == limits[0],
        "notEqual": lambda: value != limits[0],
        "between": lambda: limits[0] <= value <= limits[1],
        "notBetween": lambda: not limits[0] <= value <= limits[1],
    }
    return checks[operator]()


def _yellow_mark(sheet, workbook, row, total, rules):
    cell = sheet.cell(row, 17)
    base = _fill_colour(cell.fill, workbook)
    # Row/column defaults require a full style precedence evaluator. The input
    # has no such coloured defaults; fail closed if a future file introduces it.
    for style in (sheet.row_dimensions.get(row), sheet.column_dimensions.get("Q")):
        if style is not None and style.has_style and style.fill.patternType is not None:
            raise WorkbookError("库存总和含行/列底色，需先确认有效颜色")
    active = []
    for rule in rules:
        if not any(r.min_row <= row <= r.max_row for r in rule["ranges"]):
            continue
        if _condition_matches(Decimal(total), rule["operator"], rule["thresholds"]):
            if rule["colour"] is not None:
                active.append(rule)
            if rule["stop"]:
                break
    if len({rule["colour"] for rule in active}) > 1:
        raise WorkbookError("Q{} 存在冲突的底色条件格式，拒绝猜测".format(row))
    if active:
        return active[0]["colour"] == "FFFF00", [rule["evidence"] for rule in active]
    return base == "FFFF00", ["Q{} 直接黄色填充".format(row)] if base == "FFFF00" else []


def load_workbook_targets(path):
    path = Path(path).expanduser().resolve(strict=True)
    digest = _sha256(path)
    # Conditional formatting is unavailable on ReadOnlyWorksheet. Load the
    # formula/style workbook normally; the cached-value workbook stays streamed.
    formulas = load_workbook(path, read_only=False, data_only=False)
    cached = None
    try:
        cached = load_workbook(path, read_only=True, data_only=True)
        if "出售中商品" not in formulas.sheetnames:
            raise WorkbookError("缺少工作表“出售中商品”")
        sheet = formulas["出售中商品"]
        values = cached["出售中商品"]
        headers = next(sheet.iter_rows(min_row=1, max_row=1, max_col=17, values_only=True))
        expected = {8: "主商家编码", 10: "二店名称", 12: "规格商家编码",
                    14: "实际可用数", 15: "虚拟库存", 16: "库存总和"}
        for column, header in expected.items():
            if str(headers[column] or "").strip() != header:
                raise WorkbookError("{} 列必须为“{}”".format(chr(65 + column), header))
        colour_rules = _compile_colour_rules(sheet, formulas)
        products = {}
        sku_owners = {}
        main_owners = {}
        warnings = []
        yellow_count = 0
        yellow_positive_count = 0
        formula_rows = sheet.iter_rows(min_row=2, max_col=17, values_only=True)
        cache_rows = values.iter_rows(min_row=2, max_col=17, values_only=True)
        for row_number, (row, data) in enumerate(zip(formula_rows, cache_rows), start=2):
            # A/B are an independent catalogue, not joined to I:Q by row.
            if all(value is None or value == "" for value in row[8:17]):
                continue
            title = str(row[10]).strip() if row[10] is not None else ""
            title_key = normalize_title(title)
            code = normalize_code(row[12])
            main_code = normalize_code(row[8])
            if not title_key or not code or not main_code:
                raise WorkbookError("第 {} 行缺少二店名称、规格商家编码或主商家编码".format(row_number))
            if any(isinstance(row[index], str) and row[index].startswith("=")
                   for index in (8, 10, 12, 14, 15)):
                raise WorkbookError("第 {} 行的身份或库存来源字段不支持公式".format(row_number))
            actual = integer(data[14], "第 {} 行实际可用数".format(row_number))
            virtual = integer(data[15], "第 {} 行虚拟库存".format(row_number))
            q_cell = row[16]
            if isinstance(q_cell, str) and q_cell.startswith("="):
                compact = re.sub(r"[\s$]", "", q_cell).upper()
                if compact != "=O{0}+P{0}".format(row_number):
                    raise WorkbookError("第 {} 行库存总和公式不是本行 O+P".format(row_number))
            total = integer(data[16], "第 {} 行库存总和（公式须有缓存值）".format(row_number))
            if total != actual + virtual:
                raise WorkbookError("第 {} 行库存总和 {} 与 O+P={} 不一致".format(row_number, total, actual + virtual))
            if code in sku_owners:
                raise WorkbookError("第 {} 行规格商家编码 {} 重复，首次出现于第 {} 行".format(row_number, code, sku_owners[code]))
            if main_code in main_owners and main_owners[main_code] != title_key:
                raise WorkbookError("主商家编码 {} 对应多个二店名称".format(main_code))
            main_owners[main_code] = title_key
            if title_key in products:
                if products[title_key]["main_code"] != main_code:
                    raise WorkbookError("二店名称 {} 对应多个主商家编码".format(title))
            else:
                products[title_key] = {"title": title, "normalized_title": title_key,
                                       "main_code": main_code, "skus": []}
            yellow, evidence = _yellow_mark(sheet, formulas, row_number, total, colour_rules)
            yellow_count += int(yellow)
            yellow_positive_count += int(yellow and total > 0)
            target_reason = "库存总和黄色标记，按 0 处理" if yellow else (
                "负库存按 0 处理" if total < 0 else "库存总和数值")
            products[title_key]["skus"].append({"code": code, "target": 0 if yellow else max(total, 0),
                "raw_target": total, "row": row_number, "target_reason": target_reason,
                "yellow_marked": yellow, "yellow_evidence": evidence})
            sku_owners[code] = row_number
            if total < 0:
                warnings.append("第 {} 行 {}：库存总和 {}，目标按 0 处理".format(row_number, code, total))
            elif yellow and total > 0:
                warnings.append("第 {} 行 {}：库存总和 {}，黄色标记优先，目标按 0 处理".format(row_number, code, total))
        if not products:
            raise WorkbookError("主表没有可处理的 SKU")
    finally:
        formulas.close()
        if cached is not None:
            cached.close()
    if _sha256(path) != digest:
        raise WorkbookError("读取过程中 Excel 文件发生变化，请重新预览")
    return {"source_path": str(path), "source_sha256": digest,
            "product_count": len(products), "sku_count": len(sku_owners),
            "products": list(products.values()), "warnings": warnings,
            "rules_version": RULES_VERSION, "yellow_sku_count": yellow_count,
            "yellow_positive_zeroed_count": yellow_positive_count}
