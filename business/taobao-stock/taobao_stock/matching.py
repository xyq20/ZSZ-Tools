"""Conservative whole-link eligibility and per-SKU inventory targets."""

from .excel import WorkbookError, integer, normalize_code, normalize_title


def match_item(product, item):
    result = {"item_id": normalize_code(item.get("item_id")),
              "title": item.get("title", ""), "status": item.get("status"),
              "main_code": normalize_code(item.get("main_code")),
              "eligible": False, "reason": "", "skus": [],
              "source_title": product.get("title", "")}
    reasons = []
    if not result["item_id"]:
        reasons.append("缺少商品 ID")
    if normalize_title(item.get("title")) != normalize_title(product.get("title")):
        reasons.append("商品标题不完全匹配")
    if item.get("status") not in ("on_sale", "in_stock"):
        reasons.append("商品状态不支持")
    if item.get("supported") is not True:
        reasons.append(item.get("unsupported_reason") or "库存模式未确认或不支持")
    source_main = normalize_code(product.get("main_code"))
    if result["main_code"] and source_main and result["main_code"] != source_main:
        reasons.append("主商家编码与 Excel 冲突")
    targets = {}
    for source in product.get("skus", []):
        code = normalize_code(source.get("code"))
        if not code or code in targets:
            reasons.append("Excel SKU 编码缺失或重复")
        targets[code] = source.get("target")
    source_skus = item.get("skus") or []
    if not source_skus:
        reasons.append("未读取到完整 SKU")
    codes_seen = set()
    ids_seen = set()
    for sku in source_skus:
        code = normalize_code(sku.get("code"))
        sku_id = normalize_code(sku.get("sku_id"))
        current = None
        target = None
        if not code:
            reasons.append("淘宝 SKU 缺少商家编码")
        elif code in codes_seen:
            reasons.append("淘宝 SKU 编码重复：{}".format(code))
        if not sku_id:
            reasons.append("SKU {} 缺少 SKU ID".format(code))
        elif sku_id in ids_seen:
            reasons.append("淘宝 SKU ID 重复：{}".format(sku_id))
        if code not in targets:
            reasons.append("SKU {} 在 Excel 中没有完整编码匹配".format(code or "（空）"))
        else:
            try:
                target = integer(targets[code], "SKU {} 目标库存".format(code))
                if target < 0:
                    reasons.append("SKU {} 目标库存为负数".format(code))
            except WorkbookError as error:
                reasons.append(str(error))
        try:
            current = integer(sku.get("quantity"), "SKU {} 当前库存".format(code))
            if current < 0:
                reasons.append("SKU {} 当前库存为负数，需人工检查".format(code))
        except WorkbookError as error:
            reasons.append(str(error))
        result["skus"].append({"sku_id": sku_id, "code": code, "current": current,
                               "target": target,
                               "delta": target - current if target is not None and current is not None else None})
        codes_seen.add(code)
        ids_seen.add(sku_id)
    result["reason"] = "；".join(dict.fromkeys(reasons))
    result["eligible"] = not reasons
    return result
