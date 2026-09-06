"""Coordinate AlphaEdge chain requests across bridge and collector processes.

This only covers processes using this module, not other apps on the account.
OS locks are released automatically on process exit, including crashes.
"""
import os
import threading
import time
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "paper"
_thread_lock = threading.Lock()


@contextmanager
def process_lock(name, timeout=45):
    ROOT.mkdir(parents=True, exist_ok=True)
    with open(ROOT / (name + ".lock"), "a+b") as handle:
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"AlphaEdge {name} is busy")
                time.sleep(0.1)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def paced_call(call, *args, **kwargs):
    with _thread_lock, process_lock("dhan-chain"):
        stamp = ROOT / "dhan-chain-last.txt"
        try:
            remaining = 3.5 - (time.time() - float(stamp.read_text()))
        except (OSError, ValueError):
            remaining = 0
        if remaining > 0:
            time.sleep(min(remaining, 3.5))
        try:
            return call(*args, **kwargs)
        finally:
            stamp.write_text(str(time.time()))
