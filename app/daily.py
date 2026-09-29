"""The daily scan that macOS runs by itself (see app/schedule.py). By hand:  .venv/bin/python -m app.daily

If the dashboard is open it does nothing, because the dashboard scans and sends alerts by itself.
Otherwise it scans when new closing prices are due and sends the Telegram summary.
"""
from __future__ import annotations

import argparse
import html
import json
import sys
import traceback
from datetime import datetime
from pathlib import Path

import requests

from egx_agent import config, db, scan

from . import alerts, health, jobs, schedule

HEALTH = "http://127.0.0.1:8501/api/health"
MAX_LOG = 200_000  # bytes


def log(msg: str) -> None:
    print(f"{datetime.now():%Y-%m-%d %H:%M}  {msg}", flush=True)


def trim_log(path: Path) -> None:
    try:
        if path.exists() and path.stat().st_size > MAX_LOG:
            keep = path.read_bytes()[-MAX_LOG // 2:]
            path.write_bytes(keep[keep.find(b"\n") + 1:])
    except OSError:
        pass


def dashboard_open(url: str = HEALTH) -> bool:
    try:
        return requests.get(url, timeout=3).json().get("app") == "egx-trading-agent"
    except Exception:
        return False


def run(db_path: Path | str, health_url: str = HEALTH) -> tuple[bool, str]:
    if dashboard_open(health_url):
        return True, "The dashboard is open, so it scans and sends alerts by itself."
    conn = db.connect(db_path)
    try:
        cfg = config.load_config()
        parts = []
        market: dict = {}
        if scan.scan_is_stale(conn):
            market = scan.run_scan(conn, cfg)
            parts.append(jobs.scan_summary(market))
        else:
            parts.append("Prices are up to date.")
        try:
            parts.append(f"Telegram: {alerts.after_scan(conn, cfg)}.")
            ok = True
        except alerts.TelegramError as exc:
            parts.append(f"Telegram failed: {exc}")
            ok = False
        model = jobs.retrain_if_due(conn, cfg, lambda p, m: None)
        if model:
            parts.append(f"Prediction model {model}.")
        if alarms := jobs.check_health(None, conn, cfg, {**market, "model": model}):
            parts.append(f"Alarms: {alarms}.")
        return ok and not model.startswith("retraining failed"), " ".join(parts)
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="EGX Trading Agent: the daily scan")
    p.add_argument("--db", default=str(config.DB_PATH))
    p.add_argument("--config", help="settings file (default: config.yaml in the project folder)")
    a = p.parse_args(argv)
    if a.config:
        config.CONFIG_PATH = Path(a.config)
    trim_log(schedule.log_path())
    crash = None
    try:
        ok, msg = run(a.db)
    except Exception as exc:
        traceback.print_exc()
        ok, msg = False, f"Failed: {exc}"
        crash = str(exc) or exc.__class__.__name__
    log(msg)
    conn = db.connect(a.db)
    try:
        if crash:
            try:
                health.crashed(conn, f"The daily scan failed: {html.escape(crash[:300])}",
                               jobs.owner_sender(None, config.load_config()), where=" on your Mac")
            except Exception:
                traceback.print_exc()
        db.set_meta(conn, "daily_last_run", json.dumps(
            {"at": datetime.now().isoformat(timespec="seconds"), "ok": ok, "message": msg}))
    finally:
        conn.close()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
