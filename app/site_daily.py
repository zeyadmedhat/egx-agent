"""The GitHub Pages site's daily job, run by GitHub Actions (.github/workflows/site.yml) after every EGX close:

    python -m app.site_daily --db state/egx.db --config site/strategy.yaml --out _site

1. Downloads the new closing prices and scans (the first run downloads 10 years of history, about 5 minutes).
2. Keeps the prediction model trained (the first time, then monthly).
3. Connects the friends who pressed "Connect Telegram" on the site (if the TELEGRAM_TOKEN secret is set).
4. Builds the encrypted site into --out, then sends each connected friend the day's signals, once per close.
5. Tells the owner on Telegram when something breaks, and when it's fixed (app/health.py; the OWNER_TELEGRAM secret
   says who the owner is), and backs up the data once a day (app/backup.py, with --backup).

The scan also reads the news, dividends and bonus shares (egx_agent/data/news.py); a run without a new close reads
them on its own, so the site's News page keeps moving on quiet days and weekends.

It also runs every few hours on quiet days, only to connect new friends: the site is then published again only
if something changed (a scheduled run with the same data isn't republished).

Secrets come from the environment: EGX_SITE_PASSWORD (required), TELEGRAM_TOKEN and OWNER_TELEGRAM (optional).
The logs are public on a public repository, so they only ever show counts, never the signals or who connected.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import os
import re
import sys
import traceback
from datetime import datetime, timedelta
from pathlib import Path

import requests

from egx_agent import config, db, predict, record, scan
from egx_agent.data import dividends, fundamentals, macro, news, prices

from . import alerts, backup, health, jobs, static_site, views


NEWS_BUDGET_S = 120   # runs without a new close read the news too, a little less of it
RETRY = timedelta(minutes=25)   # after a try that found no new close; the Telegram Worker asks for runs half-hourly


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


def owner_chat(conn, token: str, owner: str) -> str | None:
    """The owner's Telegram chat, from the OWNER_TELEGRAM secret: their @username (or chat number). They must have
    pressed Connect Telegram on the site, which lets the bot message them. Kept, so it's looked up only once."""
    who = owner.strip().lstrip("@").lower()
    if not who:
        return None
    known = json.loads(db.get_meta(conn, "site_owner") or "{}")
    if known.get("who") == who:
        return known.get("chat")
    chat = who if who.lstrip("-").isdigit() else None
    for cid in [] if chat else list(alerts._subscribers(conn))[:50]:
        try:
            if (alerts.call(token, "getChat", chat_id=cid).get("username") or "").lower() == who:
                chat = cid
                break
        except alerts.TelegramError:
            continue
    if chat:
        db.set_meta(conn, "site_owner", json.dumps({"who": who, "chat": chat}))
    return chat


def app_button(site_url: str, lang: str = "en") -> list | None:
    """A button under the evening message that opens the website inside Telegram (a mini app)."""
    if not site_url.startswith("https://"):
        return None
    return [[{"text": "📱 افتح التطبيق" if lang == "ar" else "📱 Open the app",
              "web_app": {"url": site_url.rstrip("/") + "/"}}]]


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


def catch_up(conn, cfg: dict) -> dict:
    """On a run with no new close: download what a newer agent shows but the last scan didn't fetch yet (the hourly
    bars for the 1-hour and 4-hour charts, the company numbers), so a new version is complete straight away."""
    out = {}
    if prices.intraday_behind(conn):
        syms = [r[0] for r in conn.execute("SELECT DISTINCT symbol FROM prices WHERE symbol != ?", (prices.INDEX_SYMBOL,))]
        try:
            res = prices.update_intraday(conn, syms, aliases=cfg.get("symbol_aliases"))
            out["hourly"] = f"{res['updated']} stocks" + (f", {len(res['failed'])} failed" if res["failed"] else "")
        except Exception as exc:  # only the hourly charts need them
            out["hourly"] = f"not updated ({type(exc).__name__})"
    if not conn.execute("SELECT COUNT(*) FROM fundamentals").fetchone()[0] or not fundamentals.ready(conn):
        try:
            dividends.update(conn)
            out["company numbers"] = "downloaded"
        except Exception as exc:
            out["company numbers"] = f"not updated ({type(exc).__name__})"
    if not conn.execute("SELECT 1 FROM macro WHERE series='gold' LIMIT 1").fetchone():   # your account in gold, zakat
        try:
            missed = macro.update(conn)
            out["gold price"] = "not updated" if "gold" in missed else "downloaded"
        except Exception as exc:
            out["gold price"] = f"not updated ({type(exc).__name__})"
    return out


def morning_texts(conn, cfg: dict, mine: dict[str, list], data_date: str) -> dict:
    """Each connected friend's reminder before the next session: their own orders (if their portfolio is linked) and
    the BUY signals. Friends with nothing to do that morning get none."""
    d = views.Data(conn, cfg, views.Cache())
    texts = {}
    for cid, s in alerts._subscribers(conn).items():
        if s.get("morning", True):
            try:
                text = alerts.morning_message(d, mine.get(cid, []), s.get("lang") or "en")
            except Exception:  # one odd record must not stop everyone's reminder
                traceback.print_exc()
                text = None
            if text:
                texts[cid] = text
    return {"day": views.sessions_after(data_date, 1), "texts": texts}


def run(db_path: Path, out: Path, password: str, site_id: str, token: str = "", site_url: str = "",
        force_scan: bool = False, always_publish: bool = True, owner: str = "") -> dict:
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
        if fresh or force_scan or scan.scan_is_stale(conn, RETRY) or scan.session_scan_due(conn):
            first = {**cfg, "history_years": prices.DEEP_YEARS} if fresh else cfg
            log("First run: downloading 10 years of prices for every stock." if fresh else "Downloading new prices.")
            market = scan.run_scan(conn, first, progress=_progress("Scan"))
            if fresh:
                db.set_meta(conn, "history_years_loaded", str(prices.DEEP_YEARS))
            report["scan"] = f"{market['date']}: {market['buys']} BUY, {market['watches']} watch"
            for w in market.get("warnings") or []:
                warnings.append(w.split(":")[0])      # the part before the list of symbols
                log("Warning: " + warnings[-1])
            health.note(conn, market.get("failed", []), market.get("checked", []))
        elif changed:
            market = scan.run_scan(conn, cfg, progress=_progress("Re-score"), update_data=False)
            report["scan"] = f"re-scored with the new strategy: {market['buys']} BUY"
        else:
            report["scan"] = "no new close yet"
        if not report["scan"][:4].isdigit():      # no download this run: the news still moves (weekends too)
            try:
                got = news.update(conn, first=list(db.latest_scan(conn)[1].get("symbol", [])),
                                  budget_s=NEWS_BUDGET_S)
                report["news"] = f"{got['new']} new headlines, {got['actions']} new dividends/bonus shares" + (
                    f" ({len(got['failed'])} sources didn't answer)" if got["failed"] else "")
                health.note(conn, got["failed"], got["tried"])
            except Exception as exc:  # the site still builds with the news it has
                report["news"] = f"not updated ({type(exc).__name__})"
                health.note(conn, ["News"], ["News"])
            tried: list[str] = []
            health.note(conn, scan.history_step(conn, tried, NEWS_BUDGET_S), tried)   # past dividends, a few stocks
            report.update(catch_up(conn, cfg))
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
        if report["model"].startswith(("trained", "retrain", "failed")):
            health.note(conn, ["Prediction model training"] if "failed" in report["model"] else [],
                        ["Prediction model training"])

        # 2b. what the rules' past signals did, by score (a 10-year replay, weekly): the odds on each BUY card
        try:
            if record.refresh_odds(conn, cfg):
                report["odds"] = "past signals replayed (weekly)"
        except Exception as exc:  # the site still works without them
            traceback.print_exc()
            report["odds"] = f"failed ({type(exc).__name__})"

        # 3. Telegram: the friends who pressed Start (or /stop) since the last run
        telegram = subs = None
        worker = ("", "")
        if token:
            code = static_site.telegram_code(password, site_id)
            bot = _bot(conn, token)
            worker = (os.environ.get("WORKER_URL", "").strip(), os.environ.get("WORKER_KEY", "").strip())
            telegram = {"bot": bot, "link": f"https://t.me/{bot}?start={code}",
                        "worker": worker[0] if all(worker) else None} if bot else None
            try:
                if all(worker):      # the Worker has the messages (and has answered them already)
                    try:
                        updates = alerts.worker_call(*worker, "/updates")["updates"]
                    except alerts.TelegramError as exc:
                        report["worker"] = str(exc)
                        updates = []
                    subs = alerts.sync_subscribers(conn, token, code, updates, answered=True)
                else:
                    subs = alerts.sync_subscribers(conn, token, code)
            except alerts.TelegramError as exc:
                report["telegram"] = f"failed: {exc}"

        # 4. the site, then this close's signals to each connected friend
        res = static_site.build(conn, cfg, out, password, site_id, telegram, static_site.scan_page(site_id))
        report["site"] = f"{res['files']} files, {res['bytes'] / 1e6:.1f} MB"
        report["publish"] = always_publish or live_stamp(site_url) != res["stamp"]
        if not report["publish"]:
            report["site"] += ", unchanged (not published again)"
        # The portfolios friends linked to the bot (their browsers keep them; the Worker holds a copy), checked with
        # the exit rules at this close: their own orders go into their evening message.
        mine: dict[str, list] = {}
        if subs is not None and all(worker) and data_date:
            try:
                books = alerts.worker_call(*worker, "/books")["books"]
            except (alerts.TelegramError, KeyError, TypeError) as exc:
                report["worker"] = str(exc)
                books = {}
            d = views.Data(conn, cfg, views.Cache())
            connected = alerts._subscribers(conn)
            for cid, book in books.items():
                if cid in connected and isinstance(book, dict):
                    try:
                        mine[cid] = views.book_positions(d, book)
                    except Exception:  # one odd record must not stop everyone's messages
                        traceback.print_exc()
        if subs is not None:
            sent = {"sent": 0, "failed": 0, "gone": 0}
            fired = 0
            weekly = 0
            if data_date and final and subs["connected"]:
                d = views.Data(conn, cfg, views.Cache())
                has_buys = any(r["action"] == "BUY" for r in views.records(views.current_scan(conn)[1]))

                def message(cid: str, s: dict) -> dict | None:
                    lang = s.get("lang") or "en"
                    part, todo = alerts.personal_part(d, mine[cid], lang) if cid in mine else ([], False)
                    if s.get("quiet") and not has_buys and not todo:
                        return None           # /quiet: nothing to do today
                    return {"text": alerts.build_site_message(d, site_url, lang, part if cid in mine else None),
                            "buttons": app_button(site_url, lang)}

                sent = alerts.send_to_subscribers(conn, token, message, data_date)
                fired = alerts.fire_watch_alerts(conn, token, data_date, cfg)
                week = alerts.week_of(data_date)
                if alerts.weekly_due(data_date, None) and any(     # each friend once a week (they can turn it off)
                        s.get("weekly", True) and s.get("weekly_for") != week for s in alerts._subscribers(conn).values()):
                    weekly = alerts.send_weekly_to_subscribers(conn, token, {
                        lang: alerts.build_weekly(views.Data(conn, cfg, views.Cache()), site_url, mine=False, lang=lang)
                        for lang in ("en", "ar")}, week)
            report["telegram"] = (f"{subs['connected'] - sent['gone']} connected ({subs['joined']} new, "
                                  f"{subs['left'] + sent['gone']} left), sent to {sent['sent']}"
                                  + (f", {sent['failed']} failed" if sent["failed"] else "")
                                  + (f", {subs['commands']} commands answered" if subs.get("commands") else "")
                                  + (f", {fired} alerts" if fired else "")
                                  + (f", {len(mine)} linked portfolios checked" if mine else "")
                                  + (f", weekly summary to {weekly}" if weekly else ""))
        elif not token:
            report["telegram"] = "not set up"
        if subs is not None and all(worker):      # after the alerts that fired: the Worker's copy of who's watching what
            key = static_site.derive_key(password, static_site.salt_for(site_id))
            extra = {"site": site_url, "mine": {cid: {"date": data_date, "positions": [
                        {k: p.get(k) for k in ("symbol", "last", "stop", "target", "status", "reason")} for p in ps]}
                        for cid, ps in mine.items()},
                     # the Worker sends each of these at 9:30 Cairo before that session (/morning off stops it)
                     "morning": morning_texts(conn, cfg, mine, data_date) if data_date and final else None,
                     # the mini app: Telegram vouches for a connected friend, so they needn't type the password there
                     "sitekey": {"salt": base64.b64encode(static_site.salt_for(site_id)).decode(),
                                 "iter": static_site.ITERATIONS, "key": base64.b64encode(key).decode()}}
            try:
                alerts.worker_call(*worker, "/state", alerts.worker_state(conn, code, cfg, extra))
                report.setdefault("worker", "up to date")
            except alerts.TelegramError as exc:
                report["worker"] = str(exc)

        # 5. alarms: tell the owner what broke since the last run, and what's fixed
        try:
            chat = owner_chat(conn, token, owner) if token and owner else None
            current = health.problems(conn)
            res = health.notify(conn, current, (lambda text: alerts.send(token, chat, text)) if chat else None,
                                health.run_link(), " website")
            hint = (", the owner was told" if res["sent"] else
                    ", but there's no Telegram bot to tell the owner" if not token else
                    ": add the OWNER_TELEGRAM secret to get these on Telegram" if not owner else
                    ": the OWNER_TELEGRAM person hasn't pressed Connect Telegram on the site yet" if not chat else
                    ", but Telegram didn't take the message (tried again next run)" if res["new"] or res["fixed"]
                    else "")
            report["alarms"] = (f"{res['open']} open" if res["open"] else "all fine") + (
                hint if res["open"] or res["sent"] else "")
            warnings += [html.unescape(re.sub(r"<[^>]+>", "", t)) for t in current.values()]
        except Exception as exc:  # an alarm must never stop the site
            traceback.print_exc()
            report["alarms"] = f"not checked ({type(exc).__name__})"
        report["warnings"] = warnings
        return report
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="EGX Trading Agent: the GitHub Pages site's daily job")
    p.add_argument("--db", default="state/egx.db")
    p.add_argument("--config", default=str(static_site.STRATEGY_PATH))
    p.add_argument("--out", default="_site")
    p.add_argument("--backup", default="", help="write the day's locked backup here (once a day)")
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
                 always_publish=os.environ.get("GITHUB_EVENT_NAME") != "schedule",
                 owner=os.environ.get("OWNER_TELEGRAM", ""))
    publish, warnings = report.pop("publish"), report.pop("warnings")
    if a.backup:
        try:
            size = backup.make_if_due(Path(a.db), Path(a.backup), backup.secret())
            report["backup"] = f"{size / 1e6:.1f} MB, kept {backup.BACKUP_DAYS} days" if size else "done today already"
        except Exception as exc:  # the site is still published; tried again next run
            report["backup"] = f"failed ({type(exc).__name__})"
            warnings.append("The daily backup failed")
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
