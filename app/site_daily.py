"""The GitHub Pages site's daily job, run by GitHub Actions (.github/workflows/site.yml) after every EGX close:

    python -m app.site_daily --db state/egx.db --config site/strategy.yaml --out _site

1. Downloads the new closing prices and scans (the first run downloads 10 years of history, about 5 minutes).
2. Keeps the prediction model trained (the first time, then monthly) and re-runs the backtest weekly.
3. Posts the day's signals to the group's Telegram chat, once per close (if the Telegram secrets are set).
4. Builds the encrypted site into --out.

Secrets come from the environment: EGX_SITE_PASSWORD (required), TELEGRAM_TOKEN and TELEGRAM_CHAT_ID (optional).
The logs are public on a public repository, so they only ever show counts, never the signals.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import traceback
from datetime import datetime, timedelta
from pathlib import Path

from egx_agent import config, db, predict, scan
from egx_agent.data import prices

from . import alerts, jobs, static_site, views

BACKTEST_DAYS = 7


def log(msg: str) -> None:
    print(f"{datetime.now():%H:%M:%S}  {msg}", flush=True)


def _progress(label: str):
    last = {"step": -1}

    def say(p: float, _msg: str = "") -> None:   # the message can name stocks: only show how far along it is
        step = int(p * 10)
        if step != last["step"]:
            last["step"] = step
            log(f"{label}: {step * 10}%")
    return say


def run(db_path: Path, out: Path, password: str, site_id: str, token: str = "", chat: str = "",
        site_url: str = "", force_scan: bool = False) -> dict:
    cfg = config.load_config()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = db.connect(db_path)
    report: dict = {}
    try:
        fresh = conn.execute("SELECT COUNT(*) FROM prices").fetchone()[0] == 0
        strategy = hashlib.sha256(json.dumps(static_site.strategy_settings(cfg), sort_keys=True).encode()).hexdigest()
        changed = db.get_meta(conn, "site_strategy") != strategy

        # 1. prices and signals
        if fresh or force_scan or scan.scan_is_stale(conn):
            first = {**cfg, "history_years": prices.DEEP_YEARS} if fresh else cfg
            log("First run: downloading 10 years of prices for every stock." if fresh else "Downloading new prices.")
            market = scan.run_scan(conn, first, progress=_progress("Scan"))
            if fresh:
                db.set_meta(conn, "history_years_loaded", str(prices.DEEP_YEARS))
            report["scan"] = f"{market['date']}: {market['buys']} BUY, {market['watches']} watch"
            for w in market.get("warnings") or []:
                log("Warning: " + w.split(":")[0])     # the part before the list of symbols
        elif changed:
            market = scan.run_scan(conn, cfg, progress=_progress("Re-score"), update_data=False)
            report["scan"] = f"re-scored with the new strategy: {market['buys']} BUY"
        else:
            report["scan"] = "no new close yet"
        db.set_meta(conn, "site_strategy", strategy)

        # 2. the prediction model and the weekly backtest
        try:
            if predict.load_meta(predict.model_dir(conn)) is None:
                jobs.train_job(conn, _progress("Training the prediction model"))
                report["model"] = "trained"
            else:
                report["model"] = jobs.retrain_if_due(conn, cfg, _progress("Retraining")) or "up to date"
        except Exception as exc:  # the site still works without the model
            traceback.print_exc()
            report["model"] = f"failed ({type(exc).__name__})"
        backtest = db_path.parent / "last_backtest.json"
        old = not backtest.exists() or datetime.fromtimestamp(backtest.stat().st_mtime) < datetime.now() - timedelta(
            days=BACKTEST_DAYS)
        if old or changed:
            try:
                jobs.backtest_job(3, "all", backtest, {**cfg, **{k: config.DEFAULTS[k] for k in config.PERSONAL_KEYS}})(
                    conn, _progress("Backtest"))
                report["backtest"] = "updated"
            except Exception as exc:
                traceback.print_exc()
                report["backtest"] = f"failed ({type(exc).__name__})"

        # 3. the group chat, once per close
        data_date = db.get_meta(conn, "scan_data_date")
        if token and chat and data_date and db.get_meta(conn, "group_sent_for") != data_date:
            try:
                alerts.send(token, chat, alerts.build_group_message(views.Data(conn, cfg, views.Cache()), site_url))
                db.set_meta(conn, "group_sent_for", data_date)
                report["telegram"] = "sent"
            except alerts.TelegramError as exc:
                report["telegram"] = f"failed: {exc}"
        elif not (token and chat):
            report["telegram"] = "not set up"

        # 4. the site
        res = static_site.build(conn, cfg, out, password, site_id, backtest if backtest.exists() else None,
                                telegram_group=bool(token and chat))
        report["site"] = f"{res['files']} files, {res['bytes'] / 1e6:.1f} MB"
        return report
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="EGX Trading Agent: the GitHub Pages site's daily job")
    p.add_argument("--db", default="state/egx.db")
    p.add_argument("--config", default=str(static_site.STRATEGY_PATH))
    p.add_argument("--out", default="_site")
    a = p.parse_args(argv)
    config.CONFIG_PATH = Path(a.config)
    password = os.environ.get("EGX_SITE_PASSWORD", "")
    if len(password) < static_site.MIN_PASSWORD:
        print("The SITE_PASSWORD secret is missing or shorter than 10 characters. Add it in the repository's "
              "Settings → Secrets and variables → Actions.")
        return 1
    report = run(Path(a.db), Path(a.out), password, os.environ.get("GITHUB_REPOSITORY", "local"),
                 os.environ.get("TELEGRAM_TOKEN", "").strip(), os.environ.get("TELEGRAM_CHAT_ID", "").strip(),
                 os.environ.get("SITE_URL", ""), os.environ.get("FORCE_SCAN", "").lower() == "true")
    for k, v in report.items():
        log(f"{k.capitalize()}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
