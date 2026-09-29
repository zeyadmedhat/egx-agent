"""Long-running work (scans, Kashif refresh, backtests) on a background thread, one job at a time."""
from __future__ import annotations

import html
import itertools
import json
import threading
import traceback
from datetime import datetime
from pathlib import Path
from typing import Callable

import pandas as pd

from egx_agent import backtest, config, corporate, db, predict, scan
from egx_agent.data import macro, news, prices, shariah, universe

from . import accounts, alerts, health, views

Progress = Callable[[float, str], None]
AUTOSCAN_EVERY = 300  # seconds between "are new closing prices due?" checks


class Busy(Exception):
    pass


class JobRunner:
    def __init__(self, site: "accounts.Site | Path | str", on_finish: Callable[[], None] | None = None):
        self.site = site if isinstance(site, accounts.Site) else accounts.Site(site)
        self.on_finish = on_finish
        self._lock = threading.Lock()
        self._ids = itertools.count(1)
        self.job: dict | None = None

    @property
    def running(self) -> bool:
        return bool(self.job and self.job["state"] == "running")

    def start(self, kind: str, label: str, fn: Callable[[object, Progress], dict],
              summary: Callable[[dict], str] | None = None, owner: int | None = None) -> dict:
        """owner: the person a job belongs to (a backtest); None for work done for everyone (scans)."""
        with self._lock:
            if self.running:
                what = self.job["label"] if self.job.get("owner") in (None, owner) else "Someone else's backtest"
                raise Busy(f"{what} is still running. Wait for it to finish (usually under a minute).")
            job = {"id": next(self._ids), "kind": kind, "label": label, "state": "running", "progress": 0.0,
                   "message": "Starting…", "started": datetime.now().isoformat(timespec="seconds"),
                   "finished": None, "summary": None, "error": None, "owner": owner}
            self.job = job
        threading.Thread(target=self._run, args=(job, fn, summary), daemon=True, name=f"job-{kind}").start()
        return dict(job)

    def _run(self, job: dict, fn, summary) -> None:
        conn = self.site.market()

        def say(p: float, msg: str) -> None:
            job["progress"], job["message"] = max(0.0, min(float(p), 1.0)), msg

        try:
            result = fn(conn, say)
            job["summary"] = summary(result) if summary else f"{job['label']} finished."
            job["state"] = "done"
            job["progress"] = 1.0
        except Exception as exc:  # shown to you in the dashboard instead of a stack trace
            traceback.print_exc()
            job["state"], job["error"] = "error", str(exc) or exc.__class__.__name__
            if job["kind"] == "scan":
                try:
                    health.crashed(conn, f"The scan failed: {html.escape(job['error'][:300])}",
                                   owner_sender(self.site, config.load_config()), where=" on your Mac")
                except Exception:
                    traceback.print_exc()
        finally:
            job["finished"] = datetime.now().isoformat(timespec="seconds")
            conn.close()
            if self.on_finish:
                self.on_finish()

    def status(self, person: "accounts.Person | None" = None) -> dict | None:
        """The current job. Someone else's own job (a backtest) shows only as busy, without its details."""
        if not self.job:
            return None
        job = dict(self.job)
        if person is not None and job.get("owner") not in (None, person.id):
            job.update(kind="other", label="Someone else's backtest", message="", summary=None, error=None,
                       silent=True)
        job.pop("owner", None)
        return job

    def autoscan_loop(self, stop: threading.Event, first_delay: float = 3.0) -> None:
        """Scan by itself once new closing prices should be out (after 15:30 Cairo on trading days)."""
        delay = first_delay
        while not stop.wait(delay):
            delay = AUTOSCAN_EVERY
            try:
                conn = self.site.market()
                try:
                    stale = scan.scan_is_stale(conn)
                finally:
                    conn.close()
                if stale and not self.running:
                    self.start("scan", "Automatic scan", scan_job(True, self.site), scan_summary)
            except Busy:
                pass
            except Exception:
                traceback.print_exc()


# ------------------------------------------------------------------ the jobs

def scan_job(update_data: bool, site: "accounts.Site | None" = None):
    def fn(conn, say: Progress) -> dict:
        cfg = config.load_config()
        people = None
        if site is not None and site.multi_user:
            people = lambda: ((c, k) for _, c, k in site.each(conn))  # noqa: E731
        market = scan.run_scan(conn, cfg, progress=say, update_data=update_data, accounts=people)
        market["telegram"] = send_alerts(site, conn, cfg)
        market["model"] = retrain_if_due(conn, cfg, say)
        market["alarms"] = check_health(site, conn, cfg, market)
        return market
    return fn


def owner_sender(site: "accounts.Site | None", cfg: dict) -> health.Send | None:
    """Alarms go to your own Telegram on your Mac (the multi-user server has no single owner to tell)."""
    if site is not None and site.multi_user:
        return None
    token, chat = cfg.get("telegram_token"), cfg.get("telegram_chat_id")
    return (lambda text: alerts.send(token, chat, text)) if token and chat else None


def check_health(site: "accounts.Site | None", conn, cfg: dict, market: dict) -> str:
    """After a scan: note the sources that failed, then tell you about problems that started or ended."""
    try:
        health.note(conn, market.get("failed", []), market.get("checked", []))
        if market.get("model"):
            health.note(conn, ["Prediction model training"] if "failed" in market["model"] else [],
                        ["Prediction model training"])
        res = health.notify(conn, health.problems(conn), owner_sender(site, cfg), where=" on your Mac")
    except Exception:  # an alarm must never break the scan
        traceback.print_exc()
        return ""
    return f"{res['open']} open" if res["open"] else ""


def send_alerts(site: "accounts.Site | None", conn, cfg: dict) -> str:
    """Telegram after a scan: to you on your Mac, or to everyone who connected on the website."""
    if site is None or not site.multi_user:
        try:
            alerts.weekly_after_scan(conn, cfg)  # after Thursday's close, once a week
        except Exception:  # the daily message still goes
            traceback.print_exc()
        try:
            return alerts.after_scan(conn, cfg)  # once per closing-price date
        except alerts.TelegramError as exc:
            return f"failed: {exc}"
    sent = failed = 0
    for _person, pconn, pcfg in site.each(conn):
        try:
            sent += alerts.after_scan(pconn, pcfg) == "sent"
        except alerts.TelegramError:
            failed += 1
    parts = [f"sent to {sent} {'person' if sent == 1 else 'people'}"] if sent else []
    if failed:
        parts.append(f"failed for {failed}")
    return ", ".join(parts)


def _egypt_data(conn) -> None:
    """The model learns from the Egypt data and the dividend/bonus-share events. A scan downloads them, but
    training shouldn't go without them when no scan ran first (a run with no new close, or the first training)."""
    for ready, fetch in ((predict.egypt_data_ready, macro.update), (predict.events_data_ready, news.update_actions)):
        if ready(conn):
            continue
        try:
            fetch(conn)
        except Exception:  # the model still trains; it retrains by itself once the data is here
            traceback.print_exc()


def retrain_if_due(conn, cfg: dict, say: Progress) -> str:
    """Retrain the prediction model once a month, after you change the stop/target settings, or when its design
    changed or the Egypt data it lacked has arrived."""
    if predict.load_meta(predict.model_dir(conn)):
        _egypt_data(conn)
    if not predict.needs_training(conn, cfg):
        return ""
    try:
        predict.train(conn, cfg, progress=lambda p, m: say(p, f"Monthly prediction-model update: {m}"))
        return "retrained"
    except Exception as exc:
        traceback.print_exc()
        return f"retraining failed: {exc}"


def train_job(conn, say: Progress) -> dict:
    cfg = config.load_config()
    start = 0.0
    if int(db.get_meta(conn, "history_years_loaded") or 0) < prices.DEEP_YEARS:
        start = 0.45
        symbols = [r["symbol"] for r in conn.execute("SELECT DISTINCT symbol FROM prices")]
        say(0.01, f"Downloading {prices.DEEP_YEARS} years of prices (one time only, about 4 minutes)…")
        res = prices.extend_history(
            conn, symbols, aliases=cfg.get("symbol_aliases"),
            progress=lambda d, t, s: say(start * d / t, f"Downloading {prices.DEEP_YEARS} years of prices, "
                                                        f"one time only: {d}/{t} ({s})"))
        if res["events"]:
            corporate.apply_paper(conn)
    _egypt_data(conn)
    return predict.train(conn, cfg, progress=lambda p, m: say(start + (1 - start) * p, m))


def train_summary(meta: dict) -> str:
    r = meta["horizons"].get("10") or {}
    if not r.get("top"):
        return "Prediction model trained."
    return (f"Prediction model trained on {meta['stocks']} stocks ({meta['data_from'][:4]}–{meta['data_to'][:4]}). "
            f"Tested on years it hadn't seen, its top picks reached the target first {r['top']['hit']:.0%} of the time, "
            f"vs {r['all']['hit']:.0%} for the average stock (10 sessions).")


def scan_summary(market: dict) -> str:
    tg = market.get("telegram") or ""
    note = (" Sent to Telegram." if tg == "sent" else f" Telegram {tg}" if tg.startswith("failed")
            else f" Telegram: {tg}." if tg.startswith("sent to") else "")
    model = market.get("model") or ""
    note += " Prediction model retrained." if model == "retrained" else f" Prediction model {model}." if model else ""
    return (f"Scan finished for the {market['date']} close: {market['buys']} BUY signal"
            f"{'' if market['buys'] == 1 else 's'}, {market['watches']} on the watchlist.{note}")


def kashif_job(conn, say: Progress) -> dict:
    say(0.1, "Reading kasheif.com (about 30 seconds)…")
    res = shariah.refresh_kashif(conn)
    universe.export_fallback(conn)
    return res


def kashif_summary(res: dict) -> str:
    return f"Kashif updated: {res['stocks']} stocks, EGX33 list {res['egx33']} symbols."


_prepared: dict = {"key": None, "prep": None}
UNIVERSES = {"all": "All liquid EGX stocks", "egx30": "EGX30 members only", "egx33": "EGX33 Shariah members only"}


def backtest_job(years: int, which: str, results_path: Path, cfg: dict | None = None):
    def fn(conn, say: Progress) -> dict:
        cfg_ = cfg if cfg is not None else config.load_config()
        return _backtest(conn, say, years, which, results_path, cfg_)
    return fn


def _backtest(conn, say: Progress, years: int, which: str, results_path: Path, cfg: dict) -> dict:
    table = universe.stock_table(conn, cfg.get("egx33_extra"))
    key = (views.data_version(conn), json.dumps(cfg, sort_keys=True))
    if _prepared["key"] != key:
        say(0.05, "Loading price history…")
        data = prices.load_all(conn, list(table.index))
        say(0.35, "Calculating indicators and signals for every day…")
        _prepared["prep"] = backtest.prepare(data, db.load_prices(conn, prices.INDEX_SYMBOL), table, cfg, conn)
        _prepared["key"] = key
    prep = _prepared["prep"]
    symbols = None
    if which == "egx30":
        symbols = set(table[table.egx30 == 1].index)
    elif which == "egx33":
        symbols = set(table[table.egx33 == 1].index)
    say(0.8, "Replaying the market day by day…")
    start = prep.index_ind.index[-1] - pd.DateOffset(years=years)
    res = backtest.run(prep, cfg, start, symbols=symbols)
    payload = views.backtest_payload(res, f"{UNIVERSES[which]}, last {years} year{'s' if years > 1 else ''}")
    payload["params"] = {"years": years, "universe": which}
    results_path.parent.mkdir(parents=True, exist_ok=True)
    results_path.write_text(json.dumps(payload), encoding="utf-8")
    return payload


def backtest_summary(p: dict) -> str:
    m = p["metrics"]
    return f"Backtest finished: {m['total_return']:+.0%} vs EGX30 {m['egx30_return']:+.0%} ({m['trades']} trades)."
