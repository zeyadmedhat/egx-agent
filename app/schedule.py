"""The daily scan that runs by itself, even when the dashboard is closed (a macOS launch agent).

Turned on in Settings → Alerts. It writes ~/Library/LaunchAgents/com.egx-trading-agent.daily-scan.plist, which
runs `python -m app.daily` Sunday–Thursday at the TIMES below (Cairo time on this Mac). The later runs only do
work when prices were published late. If the Mac is asleep, macOS runs the job as soon as it wakes up.
"""
from __future__ import annotations

import os
import plistlib
import subprocess
import sys
from pathlib import Path

from egx_agent import config

LABEL = "com.egx-trading-agent.daily-scan"
TIMES = ((15, 45), (18, 0), (21, 0))   # more than 2 hours apart: a scan isn't retried sooner
WEEKDAYS = (0, 1, 2, 3, 4)             # launchd counts Sunday as 0
LOG_NAME = "daily.log"


def supported() -> bool:
    return sys.platform == "darwin"


def plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def log_path(root: Path = config.ROOT) -> Path:
    return root / "data" / LOG_NAME


def job(root: Path = config.ROOT) -> dict:
    log = str(log_path(root))
    return {
        "Label": LABEL,
        "ProgramArguments": [str(root / ".venv" / "bin" / "python"), "-m", "app.daily"],
        "WorkingDirectory": str(root),
        "StartCalendarInterval": [{"Weekday": w, "Hour": h, "Minute": m} for w in WEEKDAYS for h, m in TIMES],
        "StandardOutPath": log,
        "StandardErrorPath": log,
        "ProcessType": "Background",
    }


def _launchctl(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["launchctl", *args], capture_output=True, text=True, timeout=30)


def _target() -> str:
    return f"gui/{os.getuid()}/{LABEL}"


def install(run_now: bool = True) -> None:
    """Turn the daily scan on. run_now starts one run straight away, so any macOS permission prompt shows now."""
    if not supported():
        raise RuntimeError("The daily scan can only be set up on a Mac.")
    path = plist_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    _launchctl("bootout", _target())  # an older copy, if any
    with open(path, "wb") as f:
        plistlib.dump(job(), f)
    r = _launchctl("bootstrap", f"gui/{os.getuid()}", str(path))
    if r.returncode != 0:
        raise RuntimeError(f"macOS didn't accept the daily scan ({(r.stderr or r.stdout).strip() or r.returncode}).")
    if run_now:
        _launchctl("kickstart", _target())


def uninstall() -> None:
    if supported():
        _launchctl("bootout", _target())
    plist_path().unlink(missing_ok=True)


def status() -> dict:
    if not supported():
        return {"supported": False, "on": False}
    path = plist_path()
    installed = path.exists()
    loaded = installed and _launchctl("print", _target()).returncode == 0
    moved = False
    if installed:
        try:
            with open(path, "rb") as f:
                moved = plistlib.load(f).get("WorkingDirectory") != str(config.ROOT)
        except Exception:
            moved = True
    log = log_path()
    tail = log.read_text(encoding="utf-8", errors="replace").splitlines()[-8:] if log.exists() else []
    return {"supported": True, "on": bool(installed and loaded and not moved), "installed": installed,
            "loaded": loaded, "moved": moved, "times": [f"{h:02d}:{m:02d}" for h, m in TIMES], "log": tail}
