import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile

worker = Path(__file__).resolve().parents[1] / "business" / "hot_update.py"
spec = importlib.util.spec_from_file_location("hot_update", worker)
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


class PreparedUpdateTest(unittest.TestCase):
    def test_invalid_zip_never_extracts_outside_stage(self):
        for name in ("../outside", "C:/outside", "resources/file:stream", "AUX.txt", "file."):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                stage = root / "stage"
                stage.mkdir()
                archive = root / "test.zip"
                with zipfile.ZipFile(archive, "w") as output:
                    output.writestr(name, b"sample")
                with self.assertRaises(ValueError):
                    helpers.extract(archive, stage)
                self.assertFalse((root / "outside").exists())

    @unittest.skipUnless(sys.platform in ("darwin", "win32"), "native desktop helper")
    def test_failed_window_restores_previous_version(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            token = "c" * 32
            logs = root / "updates" / "attempt"
            logs.mkdir(parents=True)
            target, staged = root / "old.app", root / "candidate.app"
            target.mkdir()
            staged.mkdir()
            plan = {"target": str(target), "token": token, "staged": str(staged),
                    "directory": str(logs), "clickedAt": 1, "version": "1.1.0", "previousActive": None}
            if os.name == "nt":
                binary = target / "whoami.exe"
                for directory in (target, staged):
                    shutil.copyfile(Path(os.environ["SystemRoot"]) / "System32" / binary.name, directory / binary.name)
            else:
                binary = target / "Contents/MacOS/app"
                candidate = staged / "Contents/MacOS/app"
                for exe in (binary, candidate):
                    exe.parent.mkdir(parents=True)
                binary.write_text("#!/bin/sh\nprintf '%s' \"$1\" > \"$ROLLBACK_PROOF\"\n")
                # Another PID's well-formed, visible receipt cannot confirm this candidate.
                mismatch = {"token": token, "version": "1.1.0", "pid": 1, "visible": True,
                            "interactive": True, "executable": str(binary)}
                (logs / ("window-" + token + ".json")).write_text(json.dumps(mismatch))
                candidate.write_text("#!/bin/sh\nexec /bin/sleep 10\n")
                for exe in (binary, candidate):
                    exe.chmod(0o700)
            plan["executable"] = str(binary)
            parent = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"])
            plan["parentPid"] = parent.pid
            proof = root / "rollback-proof"
            try:
                with subprocess.Popen([sys.executable, str(worker), "switch", json.dumps(plan)],
                                      env={**os.environ, "ROLLBACK_PROOF": str(proof)},
                                      stdout=subprocess.DEVNULL, stderr=subprocess.PIPE) as helper:
                    deadline = time.monotonic() + 10
                    while not (logs / ("helper-" + token + ".ready")).exists():
                        self.assertIsNone(helper.poll())
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(.02)
                    parent.terminate()
                    parent.wait(5)
                    self.assertNotEqual(helper.wait(timeout=10), 0)
            finally:
                if parent.poll() is None:
                    parent.kill()
                    parent.wait()
            self.assertTrue(binary.is_file())
            self.assertTrue((logs / "healthy.failed").is_file())
            self.assertFalse((logs / "healthy").exists())
            self.assertFalse((root / "active.json").exists())
            if os.name != "nt":
                deadline = time.monotonic() + 3
                while not proof.exists() and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertEqual(proof.read_text(), "--toolkit-rollback")

if __name__ == "__main__":
    unittest.main()
