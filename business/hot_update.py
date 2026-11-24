"""Extract a verified Windows payload or complete a prepared desktop update."""
import ctypes
import errno
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import time
import zipfile


def atomic_json(file, value):
    temporary = file.with_name(file.name + "." + str(os.getpid()) + ".tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
    finally:
        temporary.unlink(missing_ok=True)


def read_json(file):
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def extract(archive, destination):
    # The caller creates a private, new directory and verifies the release SHA-256.
    if destination.is_symlink() or any(destination.iterdir()):
        raise ValueError("更新暂存目录不是空目录")
    seen = set()
    with zipfile.ZipFile(archive) as package:
        entries = package.infolist()
        if sum(entry.file_size for entry in entries) > 8 * 1024**3:
            raise ValueError("更新包解压大小异常")
        for entry in entries:
            name = entry.filename.rstrip("/")
            parts = name.split("/")
            if (not name or any(not part or part in (".", "..") or part.endswith((" ", "."))
                                or re.search(r'[\\:<>"|?*\x00-\x1f]', part)
                                or re.fullmatch(r"(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?", part, re.I)
                                for part in parts)
                    or stat.S_ISLNK(entry.external_attr >> 16) or name.casefold() in seen):
                raise ValueError("更新包包含无效的 Windows 文件名")
            seen.add(name.casefold())
            target = destination.joinpath(*parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.open(entry) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)


def launch(executable, argument):
    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    return subprocess.Popen([str(executable), argument], cwd=executable.parent,
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            creationflags=flags, start_new_session=os.name != "nt")


def now_ms():
    return int(time.time() * 1000)


def await_parent(pid, ready):
    if os.name == "nt":
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            ready.touch(exist_ok=False)
            if kernel.WaitForSingleObject(wintypes.HANDLE(handle), 30000) == 0:
                return
        finally:
            kernel.CloseHandle(wintypes.HANDLE(handle))
    else:
        ready.touch(exist_ok=False)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.03)
    raise RuntimeError("旧版工具箱仍在运行")


def exchange_mac(target, candidate):
    # APFS exchanges the two names atomically, including across a power loss.
    swap = ctypes.CDLL(None, use_errno=True).renamex_np
    swap.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint)
    if swap(os.fsencode(target), os.fsencode(candidate), 2) == 0:  # RENAME_SWAP
        return
    code = ctypes.get_errno()
    if code not in (errno.ENOTSUP, errno.EINVAL, errno.ENOSYS):
        raise OSError(code, os.strerror(code))
    spare = candidate.with_suffix(".swap")
    os.rename(target, spare)
    try:
        os.rename(candidate, target)
    except OSError:
        os.rename(spare, target)
        raise
    try:
        os.rename(spare, candidate)
    except OSError:
        os.rename(target, candidate)
        os.rename(spare, target)
        raise


def wait_for_window(file, child, plan, executable):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        receipt = read_json(file)
        if child.poll() is not None:
            raise RuntimeError("新版在主窗口就绪之前退出")
        if receipt is not None:
            if (receipt.get("token") != plan["token"] or receipt.get("pid") != child.pid
                    or receipt.get("version") != plan["version"] or not receipt.get("visible")
                    or not receipt.get("interactive") or not os.path.samefile(receipt["executable"], executable)):
                raise RuntimeError("新版窗口回执与本次启动不匹配")
            return receipt
        time.sleep(0.03)
    raise RuntimeError("新版主窗口未在规定时间内就绪")


def switch(plan):
    directory = Path(plan["directory"])
    token = plan["token"]
    ready = directory / ("helper-" + token + ".ready")
    previous = Path(plan["executable"])
    staged = Path(plan["staged"])
    mac = sys.platform == "darwin"
    active = staged.parent / "active.json"
    child = None
    switched = False
    parent_exited = False
    log = directory / "install.log"

    def record(message):
        try:
            with log.open("a", encoding="utf-8") as stream:
                stream.write(time.strftime("%Y-%m-%d %H:%M:%S ") + message + "\n")
        except OSError:
            print(message, file=sys.stderr, flush=True)

    stages = {"helperAt": now_ms()}
    try:
        await_parent(plan["parentPid"], ready)
        parent_exited = True
        stages["parentExitedAt"] = now_ms()
        if mac:
            target = Path(plan["target"])
            exchange_mac(target, staged)
            switched = True
            candidate = previous
        else:
            if read_json(active) != plan["previousActive"]:
                raise RuntimeError("当前版本已发生变化，请重新检查更新")
            candidate = staged / previous.name
        child = launch(candidate, "--toolkit-update-token=" + token)
        stages["launchedAt"] = now_ms()
        record("启动新版 PID=" + str(child.pid))
        receipt = wait_for_window(directory / ("window-" + token + ".json"), child, plan, candidate)
        if not mac:
            if read_json(active) != plan["previousActive"]:
                raise RuntimeError("版本切换冲突，请重新检查更新")
            atomic_json(active, {"slot": staged.name})
        # The new version is committed. Cleanup failure must not roll it back.
    except Exception as error:
        record(str(error))
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(5)
        if switched:
            exchange_mac(Path(plan["target"]), staged)
        (directory / "healthy.failed").write_text(str(error), encoding="utf-8")
        if parent_exited:
            launch(previous, "--toolkit-rollback")
            shutil.rmtree(staged, ignore_errors=True)
        raise
    finally:
        ready.unlink(missing_ok=True)

    receipt["elapsedMs"] = receipt["readyAt"] - plan["clickedAt"]
    receipt["stages"] = stages
    atomic_json(directory / "healthy", receipt)
    pending = directory.parent / "pending.json"
    if (read_json(pending) or {}).get("token") == token:
        pending.unlink(missing_ok=True)
    record("新版主窗口已显示，可操作，用时 %d ms；前台=%s" % (receipt["elapsedMs"], receipt["focused"]))
    record("分段：点击到助手就绪 %d ms，等待旧版退出 %d ms，切换 %d ms，新版启动到窗口可操作 %d ms" % (
        stages["helperAt"] - plan["clickedAt"], stages["parentExitedAt"] - stages["helperAt"],
        stages["launchedAt"] - stages["parentExitedAt"], receipt["readyAt"] - stages["launchedAt"]))
    if mac:
        shutil.rmtree(staged, ignore_errors=True)
    elif previous.parent.parent == staged.parent and previous.parent != staged:
        # If old processes hold files, keep the previous slot intact.
        (previous.parent / ".toolkit-retired").touch()
        retired = previous.parent.with_name(previous.parent.name + ".retired-" + token)
        try:
            os.rename(previous.parent, retired)
        except OSError:
            return
        shutil.rmtree(retired, ignore_errors=True)


if __name__ == "__main__":
    if sys.argv[1] == "extract":
        extract(Path(sys.argv[2]), Path(sys.argv[3]))
    elif sys.argv[1] == "switch":
        switch(json.loads(sys.argv[2]))
    else:
        raise ValueError("未知的更新操作")
