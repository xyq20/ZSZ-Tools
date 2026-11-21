"""Toolbox stdin/stdout adapter for the shared return-rate report."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from return_report import REPORT_STEPS, run_report


def send(kind, data):
    print(json.dumps({"type": kind, "data": data}, ensure_ascii=False), flush=True)


def progress(completed, message):
    send("progress", {"completed": completed, "total": REPORT_STEPS, "message": message})


if __name__ == "__main__":
    try:
        job = json.load(sys.stdin)
        result = run_report(
            job["month"], job["selectionGroup"], job["minimum"], job["officialConfig"],
            job["companyId"], Path(job["output"]), tuple(job["excludedCodes"]),
            profile=Path(job["profile"]), reuse_debug_port=False, progress=progress,
        )
        send("result", {"ok": True, "value": result})
    except Exception as error:
        send("result", {"ok": False, "error": str(error)})
        sys.exit(1)
