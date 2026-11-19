"""Durable local checkpoints. Never store browser requests, cookies or tokens here."""

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        # Make the rename durable on supported local filesystems, too.
        if os.name != "nt":
            directory_fd = os.open(str(path.parent), os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_state(run_dir):
    with (Path(run_dir) / "state.json").open(encoding="utf-8") as stream:
        return json.load(stream)


class StateStore:
    def __init__(self, run_dir):
        self.directory = Path(run_dir)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.directory / "state.json"
        self.journal = self.directory / "events.jsonl"

    def save(self, run, event=None, item=None, detail=None):
        run["updated_at"] = utc_now()
        atomic_json(self.path, run)
        if event:
            entry = {"at": run["updated_at"], "event": event}
            if item is not None:
                entry["item_id"] = str(item["item_id"])
                entry["phase"] = item.get("phase")
            if detail is not None:
                entry["detail"] = detail
            descriptor = os.open(str(self.journal), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(descriptor, "a", encoding="utf-8") as stream:
                stream.write(json.dumps(entry, ensure_ascii=False, allow_nan=False) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
