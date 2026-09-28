"""The GitHub Pages site's daily job, run by GitHub Actions (.github/workflows/site.yml) after every EGX close:

    python -m app.site_daily --db state/egx.db --config site/strategy.yaml --out _site

1. Downloads the new closing prices and scans (the first run downloads 10 years of history, about 5 minutes).
2. Keeps the prediction model trained (the first time, then monthly).
3. Connects the friends who pressed "Connect Telegram" on the site (if the TELEGRAM_TOKEN secret is set).
4. Builds the encrypted site into --out, then sends each connected friend the day's signals, once per close.

It also runs every few hours on quiet days, only to connect new friends: the site is then published again only
if something changed (a scheduled run with the same data isn't republished).

Secrets come from the environment: EGX_SITE_PASSWORD (required) and TELEGRAM_TOKEN (optional).
The logs are public on a public repository, so they only ever show counts, never the signals or who connected.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import traceback
from datetime import datetime
from pathlib import Path

import requests

from egx_agent import config, db, predict, scan
from egx_agent.data import prices

from . import alerts, jobs, static_site, views


def log(msg: str) -> None:
    print(f"{datetime.now():%H:%M:%S}  {msg}", flush=True)


def annotate(level: str, title: str, text: str) -> None:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        text = text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::{level} title={title}::{text}", flush=True)


def _progress(label: str):
    last = {"step": -1}

    def say(p: float, _msg: str = "") -> None:   # the message can name stocks: only show how far along it is
        step = int(p * 10)
        if step != last["step"]:
            last["step"] = step
            log(f"{label}: {step * 10}%")
    return say


def _bot(conn, token: str) -> str | None:
    """The bot's @username, for the site's Connect Telegram link."""
    try:
        name = alerts.call(token, "getMe").get("username")
        db.set_meta(conn, "site_bot", name)
        return name
    except alerts.TelegramError:
        return db.get_meta(conn, "site_bot")


def live_stamp(site_url: str) -> str | None:
    """The stamp of the site people see now, or None if it can't be read (then the site is published)."""
    if not site_url:
        return None
    try:
        r = requests.get(site_url.rstrip("/") + "/data/site.json", params={"t": int(datetime.now().timestamp())},
                         timeout=15)
        return r.json().get("stamp") if r.ok else None
    except (requests.RequestException, ValueError):
        return None


def run(db_path: Path, out: Path, password: str, site_id: str, token: str = "", site_url: str = "",
        force_scan: bool = False, always_publish: bool = True) -> dict:
    cfg = config.load_config()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = db.connect(db_path)
    report: dict = {}
    warnings: list[str] = []
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
                warnings.append(w.split(":")[0])      # the part before the list of symbols
                log("Warning: " + warnings[-1])
        elif changed:
            market = scan.run_scan(conn, cfg, progress=_progress("Re-score"), update_data=False)
            report["scan"] = f"re-scored with the new strategy: {market['buys']} BUY"
        else:
            report["scan"] = "no new close yet"
        db.set_meta(conn, "site_strategy", strategy)
        data_date = db.get_meta(conn, "scan_data_date")
        final = scan.scan_is_final(conn)
        n_prices = conn.execute("SELECT COUNT(DISTINCT symbol) FROM prices").fetchone()[0]
        n_kashif = conn.execute("SELECT COUNT(*) FROM stocks WHERE kashif_status IS NOT NULL").fetchone()[0]
        report["data"] = (f"prices for {n_prices} symbols up to {data_date}"
                          + ("" if final else " (during the session: scanned again after the close)")
                          + f", Kashif status for {n_kashif} stocks")

        # 2. the prediction model
        try:
            if predict.load_meta(predict.model_dir(conn)) is None:
                jobs.train_job(conn, _progress("Training the prediction model"))
                report["model"] = "trained"
            else:
                report["model"] = jobs.retrain_if_due(conn, cfg, _progress("Retraining")) or "up to date"
            meta = predict.load_meta(predict.model_dir(conn))
            if meta:
                report["model"] += " (with Egypt data)" if meta.get("egypt_data") else " (without Egypt data yet)"
        except Exception as exc:  # the site still works without the model
            traceback.print_exc()
            report["model"] = f"failed ({type(exc).__name__})"

        # 3. Telegram: the friends who pressed Start (or /stop) since the last run
        telegram = subs = None
        if token:
            code = static_site.telegram_code(password, site_id)
            bot = _bot(conn, token)
            telegram = {"bot": bot, "link": f"https://t.me/{bot}?start={code}"} if bot else None
            try:
                subs = alerts.sync_subscribers(conn, token, code)
            except alerts.TelegramError as exc:
                report["telegram"] = f"failed: {exc}"

        # 4. the site, then this close's signals to each connected friend
        res = static_site.build(conn, cfg, out, password, site_id, telegram, static_site.scan_page(site_id))
        report["site"] = f"{res['files']} files, {res['bytes'] / 1e6:.1f} MB"
        report["publish"] = always_publish or live_stamp(site_url) != res["stamp"]
        if not report["publish"]:
            report["site"] += ", unchanged (not published again)"
        if subs is not None:
            sent = {"sent": 0, "failed": 0, "gone": 0}
            fired = 0
            if data_date and final and subs["connected"]:
                text = alerts.build_site_message(views.Data(conn, cfg, views.Cache()), site_url)
                sent = alerts.send_to_subscribers(conn, token, text, data_date)
                fired = alerts.fire_watch_alerts(conn, token, data_date)
            report["telegram"] = (f"{subs['connected'] - sent['gone']} connected ({subs['joined']} new, "
                                  f"{subs['left'] + sent['gone']} left), sent to {sent['sent']}"
                                  + (f", {sent['failed']} failed" if sent["failed"] else "")
                                  + (f", {subs['commands']} commands answered" if subs.get("commands") else "")
                                  + (f", {fired} alerts" if fired else ""))
        elif not token:
            report["telegram"] = "not set up"
        report["warnings"] = warnings
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
                 os.environ.get("TELEGRAM_TOKEN", "").strip(), os.environ.get("SITE_URL", ""),
                 os.environ.get("FORCE_SCAN", "").lower() == "true",
                 always_publish=os.environ.get("GITHUB_EVENT_NAME") != "schedule")
    publish, warnings = report.pop("publish"), report.pop("warnings")
    for k, v in report.items():
        log(f"{k.capitalize()}: {v}")
    # The run's page shows these without signing in to GitHub (the logs need a sign-in): counts only.
    annotate("notice", "Summary", " · ".join(f"{k.capitalize()}: {v}" for k, v in report.items()))
    for w in warnings:
        annotate("warning", "Scan", w)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as f:
            f.write(f"publish={'true' if publish else 'false'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
