"""Local workbook bridge. Authentication and network requests stay in Electron."""
import hashlib
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
for stream in (sys.stdin, sys.stdout, sys.stderr):
    stream.reconfigure(encoding="utf-8")

import erp_excel_sync as core
from monthly_schedule import resolve_sync_cycle


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def emit(kind, value):
    print(json.dumps({"type": kind, "data": value}, ensure_ascii=False), flush=True)


def cycle_data(cycle):
    return {
        "runDate": cycle.run_date.isoformat(), "nodeDate": cycle.node_date.isoformat(),
        "nodeKind": cycle.kind, "actualWindow": cycle.actual_window.iso(),
        "returnWindow": cycle.return_window.iso(),
    }


def inspect_job(job):
    cycle = resolve_sync_cycle(date.fromisoformat(job["runDate"]))
    source, target = core.resolve_monthly_workbook(Path(job["workbook"]), cycle.actual_month)
    source, target = source.resolve(), target.resolve()
    if not source.is_file():
        raise ValueError("找不到所选总表，请重新选择文件")
    layout = core.validate_source_workbook_columns(source)
    actual_start, actual_end = cycle.actual_window.iso()
    return_start, return_end = cycle.return_window.iso()
    queries = [{"key": "actual", "label": "实发数量", "payload": core.build_payload(actual_start, actual_end)}]
    for profile, key, label in (
        (core.BEFORE_RETURN_PROFILE, "before", "发货前退货率"),
        (core.AFTER_RETURN_PROFILE, "after", "发货后退货率"),
        (core.OVERALL_RETURN_PROFILE, "overall", "总退货率"),
    ):
        queries.append({"key": key, "label": label,
                        "payload": core.build_payload(return_start, return_end, as_types=profile.as_types)})
    return {"workbook": str(source), "targetWorkbook": str(target), "sourceHash": digest(source),
            "cycle": cycle_data(cycle), "layout": layout, "queries": queries}


def verify_source(source, expected):
    if not source.is_file() or digest(source) != expected:
        raise ValueError("总表在选择或预览后已被修改，请重新选择并查询")
    if source.with_name("~$" + source.name).exists():
        raise ValueError("总表正在 Excel/WPS 中打开，请关闭文件后重试")


def prepare_job(job):
    source = Path(job["workbook"]).resolve()
    verify_source(source, job["sourceHash"])
    cycle = resolve_sync_cycle(date.fromisoformat(job["runDate"]))
    target = core.monthly_workbook_path(source, cycle.actual_month)
    if target != source and target.exists():
        raise ValueError("目标月份总表已经存在，请重新选择该月份总表后查询")
    documents = {key: core.load_json(Path(value)) for key, value in job["inputs"].items()}
    datasets = {key: core.api_rows(documents[key]) for key in ("actual", "before", "after", "overall")}
    for key, field in (("before", core.BEFORE_RETURN_FIELD), ("after", core.AFTER_RETURN_FIELD),
                       ("overall", core.OVERALL_RETURN_FIELD)):
        core.populate_calculated_return_rate(datasets[key], field)
    emit("progress", "正在匹配货号、计算三类退货率并更新月份公式…")
    prepared = core.prepare_monthly_update(
        source, cycle, datasets["actual"], datasets["before"], datasets["overall"],
        core.load_aliases(ROOT / "sku_aliases.json"), core.load_target_skus(ROOT / "target_skus.txt"),
        after_return_rows=datasets["after"],
    )
    directory = Path(job["directory"]).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    summary = {**cycle_data(cycle), "sourceWorkbook": str(source), "workbook": str(target),
               "rowCount": len(prepared.rows), "manualReviewRows": len(prepared.review),
               "criticalFailures": len(prepared.critical_failures), "insertedMonthColumn": prepared.inserted,
               "formulaCount": prepared.formula_count, "apiCounts": {k: len(v) for k, v in datasets.items()},
               "canSave": not prepared.critical_failures}
    result = {"summary": summary, "rows": prepared.rows, "review": prepared.review,
              "critical": prepared.critical_results, "reportDirectory": str(directory)}
    core.save_json(directory / "preview.json", result)
    candidate = None
    try:
        if summary["canSave"]:
            emit("progress", "正在生成预览文件并校验图片、行数、表头及公式…")
            candidate = core.create_same_directory_temp(source)
            core.fast_patch_zip(source, candidate, prepared.replacements)
            summary["validation"] = core.validate_workbook(source, candidate, cycle)
            verify_source(source, job["sourceHash"])
            receipt = {"workbook": str(source), "target": str(target), "sourceHash": job["sourceHash"],
                       "candidate": str(candidate), "candidateHash": digest(candidate), "runDate": job["runDate"]}
            core.save_json(directory / "receipt.json", receipt)
            result["receipt"] = str(directory / "receipt.json")
            result["candidate"] = str(candidate)
        core.save_json(directory / "preview.json", result)
        return result
    except BaseException:
        if candidate is not None:
            candidate.unlink(missing_ok=True)
        raise


def commit_job(job):
    receipt_path = Path(job["receipt"])
    receipt = core.load_json(receipt_path)
    source, candidate, target = (Path(receipt[key]) for key in ("workbook", "candidate", "target"))
    verify_source(source, receipt["sourceHash"])
    if not candidate.is_file() or digest(candidate) != receipt["candidateHash"]:
        raise ValueError("预览文件已变化，请重新查询后再更新总表")
    if target != source and target.exists():
        raise ValueError("目标月份总表已出现，请重新选择并查询，避免覆盖其他文件")
    cycle = resolve_sync_cycle(date.fromisoformat(receipt["runDate"]))
    validation = core.validate_workbook(source, candidate, cycle)
    verify_source(source, receipt["sourceHash"])
    backup = core.atomic_replace_master(source, candidate, target=target)
    result = {"workbook": str(target), "backup": str(backup), "validation": validation}
    core.save_json(receipt_path.with_name("saved.json"), result)
    receipt_path.unlink(missing_ok=True)
    return result


def main():
    job = json.load(sys.stdin)
    action = job.get("action")
    if action not in ("inspect", "prepare", "commit"):
        raise ValueError("未知总表操作")
    return {"inspect": inspect_job, "prepare": prepare_job, "commit": commit_job}[action](job)


if __name__ == "__main__":
    try:
        emit("result", {"ok": True, "value": main()})
    except Exception as exc:
        emit("result", {"ok": False, "error": str(exc)[:1500]})
        sys.exit(1)
