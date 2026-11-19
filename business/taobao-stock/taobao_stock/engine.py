"""Serial, recoverable inventory updates with readback after every write.

Only the browser adapter performs mutations. The engine persists intent before
calling it and never retries a write using an old stock difference.
"""

import asyncio
from copy import deepcopy
from time import monotonic
from uuid import uuid4

from .errors import SessionError, ShopMismatch, UnsupportedItem
from .matching import match_item, normalize_title
from .state import StateStore, load_state, utc_now


TERMINAL_RESULTS = {"listed", "zero_stock", "skipped"}
RESULT_LABELS = {
    "listed": "已上架",
    "zero_stock": "全零留库",
    "skipped": "匹配失败，已跳过",
    "failed": "修改失败，待恢复",
    "pending": "待处理",
    "paused": "已暂停，待恢复",
}


class ItemFailure(RuntimeError):
    """Safe, engine-generated error text which may appear in local reports."""


def _error_text(error):
    if isinstance(error, (ItemFailure, UnsupportedItem)):
        return str(error)
    if isinstance(error, ShopMismatch):
        return "店铺身份不符，已暂停整个任务"
    if isinstance(error, SessionError):
        return "登录失效或需要验证，已暂停整个任务（%s）" % type(error).__name__
    # Playwright exceptions may include signed request URLs or page source.
    return "操作未确认成功（%s）；请检查页面并使用恢复命令重新读取实际状态" % type(error).__name__


def _progress(message):
    print(message, flush=True)


def _item_description(item):
    return "商品 %s %s" % (item["item_id"], str(item.get("title", ""))[:80])


def _sku_signature(skus):
    return sorted((str(s["sku_id"]), str(s["code"]), int(s["target"])) for s in skus)


def _product_map(run):
    result = {}
    for product in run["products"]:
        key = normalize_title(product["title"])
        if key in result:
            raise ValueError("源数据存在重复商品标题")
        result[key] = product
    return result


def _product_for(item, products):
    key = normalize_title(item.get("source_title") or item["title"])
    if key not in products:
        raise ItemFailure("该链接找不到已锁定的 Excel 来源商品")
    return products[key]


async def _verify_shop(adapter, expected):
    if not expected.get("name") or not expected.get("shop_id"):
        raise ShopMismatch("任务未绑定完整的店铺身份")
    actual = await adapter.verify_shop()
    if actual.get("name") != expected["name"] or str(actual.get("shop_id")) != str(expected["shop_id"]):
        raise ShopMismatch("店铺身份变化")


async def _read(adapter, item_id):
    """Retries reads only. Session failures never get automatic retries."""
    for attempt in range(3):
        try:
            data = await adapter.read_item(str(item_id))
            if str(data.get("item_id")) != str(item_id):
                raise ItemFailure("读取结果的商品 ID 与目标不符")
            return data
        except (SessionError, ItemFailure, UnsupportedItem):
            raise
        except Exception:
            if attempt == 2:
                raise
            await asyncio.sleep(0.4 * (attempt + 1))


def _refresh_match(product, item, raw):
    fresh = match_item(product, raw)
    if not fresh.get("eligible"):
        raise ItemFailure("重新核对未通过：" + str(fresh.get("reason", "SKU 无法确定")))
    if raw.get("status") not in {"on_sale", "in_stock"}:
        raise ItemFailure("商品状态不是出售中或仓库中")
    if _sku_signature(fresh["skus"]) != _sku_signature(item["skus"]):
        raise ItemFailure("商品的 SKU 身份或目标与预览不同，须重新预览")
    return fresh


def _remember_inventory(item, fresh):
    item["latest_skus"] = deepcopy(fresh["skus"])
    item["actual_status"] = fresh["status"]


def _targets_met(fresh):
    return all(s["current"] == s["target"] for s in fresh["skus"])


async def _listing(adapter, run, store, item, on_sale, before_submit=None):
    await _verify_shop(adapter, run["shop"])
    if before_submit is not None:
        # Include the identity query's elapsed time in any freshness decision.
        # This check cannot issue a write; it only validates/re-reads inventory.
        await before_submit()
    item["phase"] = "listing_intent" if on_sale else "delisting_intent"
    item["write_pending"] = "listing" if on_sale else "delisting"
    if on_sale:
        item["relisting_started_at"] = utc_now()
    store.save(run, item["phase"], item)
    write_error = None
    try:
        await adapter.set_listing(str(item["item_id"]), on_sale)
    except SessionError:
        raise
    except Exception as error:
        write_error = error
    # On an ambiguous response, the read below decides what really happened.
    raw = await _read(adapter, item["item_id"])
    expected_status = "on_sale" if on_sale else "in_stock"
    item["actual_status"] = raw.get("status")
    if raw.get("status") != expected_status:
        action = "上架" if on_sale else "下架"
        if write_error:
            if isinstance(write_error, UnsupportedItem):
                raise ItemFailure(action + "未完成：" + _error_text(write_error))
            raise ItemFailure(action + "提交结果不明，回读状态仍未达到目标；未重复提交")
        raise ItemFailure(action + "后回读状态未达到目标")
    item["write_pending"] = None
    item["phase"] = "listed_verified" if on_sale else "delisted_verified"
    if on_sale:
        item["relisting_verified_at"] = utc_now()
    store.save(run, item["phase"], item)
    return raw


async def _keep_down(adapter, run, store, item):
    """A failed, touched item must not remain live with unresolved inventory."""
    try:
        await _verify_shop(adapter, run["shop"])
        raw = await _read(adapter, item["item_id"])
        item["actual_status"] = raw.get("status")
        if raw.get("status") == "on_sale":
            await _listing(adapter, run, store, item, False)
        item["left_in_stock"] = item.get("actual_status") == "in_stock"
    except SessionError:
        raise
    except Exception:
        item["left_in_stock"] = False
        item["needs_manual_check"] = True


async def _process_item(adapter, run, store, item, product, resume, coalesce_relist_read=False):
    recovering_prior_write = bool(
        item.get("touched") or item.get("write_pending") or item.get("inventory_attempts")
        or item.get("inventory_verified_at") or item.get("relisting_started_at")
        or item.get("relisting_verified_at") or item.get("phase") in {
            "delisting_intent", "delisted_verified", "inventory_intent", "inventory_verified",
            "listing_intent", "listed_verified",
        }
    )
    await _verify_shop(adapter, run["shop"])
    raw = await _read(adapter, item["item_id"])
    fresh = _refresh_match(product, item, raw)
    _remember_inventory(item, fresh)

    # A crash after a verified inventory checkpoint and a successful relist
    # must not replenish units subsequently sold. Complete by state readback.
    if resume and item.get("inventory_verified_at") and (
        item.get("relisting_verified_at") or
        (item.get("relisting_started_at") and raw["status"] == "on_sale")
    ):
        item.update(result="listed", phase="complete", write_pending=None, error=None)
        item["recovered_listing"] = True
        store.save(run, "listing_recovered", item)
        return
    if resume and item.get("relisting_started_at") and not _targets_met(fresh):
        # A relist may have succeeded and then sold out before the interrupted
        # task resumed. With no confirmed relist response this is ambiguous;
        # increasing stock would risk replenishing units that were just sold.
        item["needs_manual_check"] = True
        raise ItemFailure("曾提交上架，当前已在仓库且库存发生变化；需核对销售情况后重新预览，未补回库存")

    item["original_status"] = item.get("original_status", raw["status"])
    item.setdefault("original_skus", deepcopy(fresh["skus"]))
    item["touched"] = True
    item["result"] = "pending"
    item["error"] = None
    if raw["status"] == "on_sale":
        raw = await _listing(adapter, run, store, item, False)
    # _listing already returns its post-delist readback. For a product already
    # in the warehouse, the initial read above is this attempt's fresh baseline.
    # No write has occurred since either snapshot; do not immediately read it
    # a second time. In particular, never use a preflight/previous-run snapshot.
    if raw["status"] != "in_stock":
        raise ItemFailure("修改前商品不在仓库中")
    fresh = _refresh_match(product, item, raw)
    _remember_inventory(item, fresh)
    adjustments = [deepcopy(s) for s in fresh["skus"] if s["delta"] != 0]
    saved_read_at = None
    if adjustments:
        await _verify_shop(adapter, run["shop"])
        item["phase"] = "inventory_intent"
        item["write_pending"] = "inventory"
        item["pending_adjustments"] = adjustments
        attempt = {"at": utc_now(), "adjustments": deepcopy(adjustments), "outcome": "pending"}
        item.setdefault("inventory_attempts", []).append(attempt)
        store.save(run, "inventory_intent", item)
        write_error = None
        try:
            await adapter.set_inventory(str(item["item_id"]), adjustments)
        except SessionError:
            raise
        except Exception as error:
            write_error = error
        raw = await _read(adapter, item["item_id"])
        readback_at = monotonic()
        fresh = _refresh_match(product, item, raw)
        _remember_inventory(item, fresh)
        attempt["readback_skus"] = deepcopy(fresh["skus"])
        attempt["outcome"] = "verified" if _targets_met(fresh) else "mismatch"
        if write_error:
            attempt["response_error_type"] = type(write_error).__name__
        if raw["status"] != "in_stock":
            raise ItemFailure("保存库存后商品意外变为出售中")
        if not _targets_met(fresh):
            if isinstance(write_error, UnsupportedItem):
                raise ItemFailure("库存修改未完成：" + _error_text(write_error) + "；商品保持下架")
            prefix = "库存提交结果不明" if write_error else "库存保存后核验不一致"
            raise ItemFailure(prefix + "，已保留下架状态；恢复时将重新计算差值")
        if write_error:
            item["recovered_inventory_timeout"] = True
        elif not recovering_prior_write:
            # This timestamp is from the actual successful post-save read,
            # never a persisted checkpoint, an initial read or a timeout path.
            saved_read_at = readback_at
    if not _targets_met(fresh):
        raise ItemFailure("上架前 SKU 库存与目标不一致")
    item["phase"] = "inventory_verified"
    item["inventory_verified_at"] = utc_now()
    item["write_pending"] = None
    item["pending_adjustments"] = []
    store.save(run, "inventory_verified", item)
    total = sum(s["target"] for s in fresh["skus"])
    if total > 0:
        if coalesce_relist_read:
            async def verify_before_submit():
                nonlocal raw, fresh
                age = None if saved_read_at is None else monotonic() - saved_read_at
                reuse_saved_read = (age is not None and 0 <= age <= 5
                                    and raw["status"] == "in_stock" and _targets_met(fresh))
                if not reuse_saved_read:
                    raw = await _read(adapter, item["item_id"])
                    fresh = _refresh_match(product, item, raw)
                    _remember_inventory(item, fresh)
                if raw["status"] != "in_stock" or not _targets_met(fresh):
                    raise ItemFailure("上架前最终检查未通过，商品保持下架")
            # Since the successful save readback, there have only been local
            # checkpoints and read-only identity checks. Reuse it for at most
            # five seconds; ambiguous writes/recovered old writes force a read.
            await _listing(adapter, run, store, item, True, before_submit=verify_before_submit)
        else:
            # Re-read immediately before the relist; don't rely on the save response.
            raw = await _read(adapter, item["item_id"])
            fresh = _refresh_match(product, item, raw)
            _remember_inventory(item, fresh)
            if raw["status"] != "in_stock" or not _targets_met(fresh):
                raise ItemFailure("上架前最终检查未通过，商品保持下架")
            await _listing(adapter, run, store, item, True)
        item["result"] = "listed"
    else:
        item["result"] = "zero_stock"
        item["left_in_stock"] = True
    item["phase"] = "complete"
    item["completed_at"] = utc_now()
    store.save(run, "item_complete", item)


def _summarize(run):
    counts = {}
    for item in run["items"]:
        result = item.get("result", "pending")
        item["result_label"] = RESULT_LABELS.get(result, result)
        counts[result] = counts.get(result, 0) + 1
    run["summary"] = counts


async def execute_run(adapter, run, run_dir, *, resume=False, skip_global_preflight=False,
                      coalesce_relist_read=False):
    """Execute a complete preview, or resume that same durable run.

    Returns the checkpoint, including failures/pauses. In particular, callers
    must inspect ``status`` instead of assuming a normal return means success.
    ``source_sha256`` and bound shop identity are immutable on resume.
    ``skip_global_preflight`` is only for a complete preview: it avoids a
    duplicate whole-batch read pass. Every link still performs its own fresh
    identity, status and SKU-signature checks before any mutation.
    ``coalesce_relist_read`` may use a successful save's verified readback for
    the final pre-listing check, only within five seconds and never while
    recovering an older write or after an ambiguous write. Untouched links in
    a resumed batch may coalesce their new save's readback as usual.
    Listing identity checks/readback remain.
    """
    if skip_global_preflight and run.get("phase") != "preview_ready":
        raise ValueError("只有完整预览可以省略整批重复预检")
    store = StateStore(run_dir)
    if resume:
        saved = load_state(run_dir)
        if saved.get("source_sha256") != run.get("source_sha256") or saved.get("shop") != run.get("shop"):
            raise ValueError("恢复任务的 Excel 指纹或店铺与原任务不一致")
        if saved.get('rules_version') != run.get('rules_version'):
            raise ValueError('库存规则版本已变化，不能沿用原执行目标')
        run = saved
    else:
        if store.path.exists():
            raise FileExistsError("该目录已有执行记录，请使用恢复命令或新的运行目录")
        run = deepcopy(run)
        run.setdefault("run_id", uuid4().hex)
        run["created_at"] = utc_now()
        for item in run["items"]:
            item.setdefault("phase", "preview")
            item["result"] = "pending" if item.get("eligible") else "skipped"
            if not item.get("eligible"):
                item["error"] = item.get("reason", "预览未通过")
    run["status"] = "running"
    run["pause_reason"] = None
    products = _product_map(run)
    store.save(run, "run_resumed" if resume else "run_started")
    active_item = None
    try:
        await _verify_shop(adapter, run["shop"])
        pending = [i for i in run["items"] if i.get("result") not in TERMINAL_RESULTS]
        ids = [str(i["item_id"]) for i in pending]
        if len(set(ids)) != len(ids):
            raise ValueError("预览存在重复商品 ID，不允许重复修改同一链接")
        # The optional full pass is useful for earlier callers without a full
        # preview. Either way, _process_item rechecks each link just before it.
        # A mismatch never delists a previously untouched product.
        if skip_global_preflight:
            # Resume attempts failed/paused unfinished links as well. Preserve
            # their phase/write intent for _process_item's recovery decisions.
            for item in pending:
                item["result"] = "pending"
        preflight_items = [] if skip_global_preflight else pending
        for position, item in enumerate(preflight_items, 1):
            active_item = item
            _progress("预检 %d/%d：%s" % (position, len(pending), _item_description(item)))
            try:
                await _verify_shop(adapter, run["shop"])
                product = _product_for(item, products)
                raw = await _read(adapter, item["item_id"])
                fresh = _refresh_match(product, item, raw)
                _remember_inventory(item, fresh)
                item["preflight_at"] = utc_now()
                item["error"] = None
                item["result"] = "pending"
                _progress("预检通过：%s，%d 个 SKU" % (_item_description(item), len(fresh["skus"])))
            except SessionError:
                raise
            except Exception as error:
                item["result"] = "failed" if item.get("touched") else "skipped"
                item["error"] = _error_text(error)
                if item.get("touched"):
                    await _keep_down(adapter, run, store, item)
                store.save(run, "preflight_failed", item)
                _progress("预检未通过：%s；%s" % (_item_description(item), item["error"]))
        active_item = None
        pending = [i for i in pending if i.get("result") == "pending"]
        pilot_id = run.get("pilot_item_id")
        if not pilot_id and pending:
            pilots = [i for i in pending if str(_product_for(i, products).get("main_code")) == "OY-361"]
            if not pilots:
                run["status"] = "paused"
                run["pause_reason"] = "没有通过核对的 OY-361 试运行链接，未开始批量修改"
                _summarize(run)
                store.save(run, "pilot_unavailable")
                return run
            pilot_id = str(pilots[0]["item_id"])
            run["pilot_item_id"] = pilot_id
        if pilot_id and not run.get("pilot_verified"):
            pilot = next((i for i in run["items"] if str(i["item_id"]) == str(pilot_id)), None)
            if pilot and pilot.get("result") in {"listed", "zero_stock"}:
                # The item checkpoint may have been saved just before a crash
                # prevented the separate pilot-complete checkpoint.
                run["pilot_verified"] = True
            elif not pilot or pilot.get("result") != "pending":
                run["status"] = "paused"
                run["pause_reason"] = "原 OY-361 试运行链接仍未通过核对，后续商品未修改"
                _summarize(run)
                store.save(run, "pilot_still_blocked")
                return run
        pending.sort(key=lambda i: (str(i["item_id"]) != str(pilot_id),))
        for position, item in enumerate(pending, 1):
            active_item = item
            _progress("执行 %d/%d：%s" % (position, len(pending), _item_description(item)))
            try:
                await _process_item(adapter, run, store, item, _product_for(item, products), resume,
                                    coalesce_relist_read=coalesce_relist_read)
            except SessionError:
                raise
            except Exception as error:
                item["result"] = "failed" if item.get("touched") else "skipped"
                item["error"] = _error_text(error)
                if item.get("touched"):
                    await _keep_down(adapter, run, store, item)
                item["phase"] = item["result"]
                store.save(run, "item_" + item["result"], item)
                _progress("%s：%s；%s" % ("执行失败" if item.get("touched") else "执行跳过",
                                            _item_description(item), item["error"]))
                if str(item["item_id"]) == str(pilot_id) and not run.get("pilot_verified"):
                    run["status"] = "paused"
                    run["pause_reason"] = "OY-361 试运行未完成，后续商品尚未修改；请排查后恢复"
                    break
            else:
                _progress("执行完成：%s；%s" % (_item_description(item), RESULT_LABELS[item["result"]]))
                if str(item["item_id"]) == str(pilot_id):
                    run["pilot_verified"] = True
                    store.save(run, "pilot_verified", item)
        else:
            run["status"] = "completed_with_exceptions" if run.get("unmatched_products") or any(
                i.get("result") in {"failed", "skipped"} for i in run["items"]
            ) else "completed"
    except SessionError as error:
        run["status"] = "paused"
        run["pause_reason"] = _error_text(error)
        if active_item is not None:
            active_item["result"] = "paused"
            active_item["error"] = run["pause_reason"]
        store.save(run, "session_paused", active_item)
    finally:
        _summarize(run)
        store.save(run, "run_checkpoint")
        if run["status"] == "paused":
            _progress("任务已暂停：" + str(run.get("pause_reason") or "请检查执行记录"))
        elif run["status"] in {"completed", "completed_with_exceptions"}:
            summary = run["summary"]
            unmatched_count = len(run.get("unmatched_products") or [])
            _progress("任务结束：已上架 %d，全零留库 %d，跳过 %d，失败 %d，未匹配商品 %d。%s" % (
                summary.get("listed", 0), summary.get("zero_stock", 0), summary.get("skipped", 0),
                summary.get("failed", 0), unmatched_count,
                "存在异常，请查看报告。" if run["status"] == "completed_with_exceptions" else "全部链接已完成。"))
    return run
