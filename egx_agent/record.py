"""The agent's track record: every BUY it published (the scans table), replayed with the same rules the paper account
and the backtest use (engine.py), from the price after it was given; and what the backtest says signals like it did,
to set each one against.

A BUY isn't counted again while an earlier BUY of the same stock is still open (you'd already hold it), nor when the
next open went past its limits (the order is cancelled, as the paper account does).
"""
from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, timedelta
from typing import Callable

import pandas as pd

from . import backtest, db, engine, levels
from .data import prices, universe

ODDS_KEY = "signal_odds"
ODDS_YEARS = 10
ODDS_MAX_AGE = timedelta(days=7)
BANDS = ((70, 80), (80, 90), (90, 101))
MIN_LIVE = 30                # closed signals before the live record is compared with the test
COLD_GAP = 0.10              # this many fewer winners than the test: the warning (site and Telegram)


def replay(order: dict, ind: pd.DataFrame, cfg: dict) -> dict:
    """One BUY signal (scan_date, symbol, entry_limit, stop, target) through the bars after its scan date."""
    fee = cfg["fee_pct_per_side"] / 100
    bars = ind.loc[ind.index > pd.Timestamp(order["scan_date"])]
    if bars.empty:
        return {"status": "waiting"}
    pos, msg = engine.fill_order(order, bars.iloc[0])
    if pos is None:
        return {"status": "skipped", "reason": msg}
    ind = levels.with_support(ind, cfg, pos.entry_date)
    out = {"entry_date": pos.entry_date, "entry": pos.entry_price}
    for ts, bar in ind.loc[ind.index >= pd.Timestamp(pos.entry_date)].iterrows():
        res = engine.process_bar(pos, bar, cfg)
        if res:
            price, reason = res
            return {**out, "status": "closed", "exit_date": str(ts.date()), "exit": price, "reason": reason,
                    "return": price * (1 - fee) / (pos.entry_price * (1 + fee)) - 1, "days": pos.days_held}
    last = float(ind["close"].iloc[-1])
    return {**out, "status": "open", "last": last, "stop": pos.stop, "days": pos.days_held,
            "return": last * (1 - fee) / (pos.entry_price * (1 + fee)) - 1}


def _stats(returns: list[float]) -> dict:
    wins = [r for r in returns if r > 0]
    losses = [r for r in returns if r <= 0]
    n = len(returns)
    return {"n": n, "win_rate": len(wins) / n if n else None, "avg": sum(returns) / n if n else None,
            "avg_win": sum(wins) / len(wins) if wins else None, "avg_loss": sum(losses) / len(losses) if losses else None}


def signal_record(conn: sqlite3.Connection, cfg: dict, indicators: Callable[[str], pd.DataFrame]) -> dict:
    """Every BUY signal the agent published and how it went, newest first, with totals and how they compare with
    the test (stored_odds)."""
    rows = conn.execute("SELECT scan_date, symbol, entry_high, stop, target, score, setup, source FROM scans "
                        "WHERE action='BUY' ORDER BY scan_date, symbol").fetchall()
    busy_until: dict[str, str] = {}
    signals = []
    for r in rows:
        sym, day = r["symbol"], r["scan_date"]
        if day < busy_until.get(sym, ""):
            continue                      # still open from an earlier BUY: you'd already hold it
        ind = indicators(sym)
        if ind is None or ind.empty or None in (r["entry_high"], r["stop"], r["target"]):
            continue
        order = {"scan_date": day, "symbol": sym, "entry_limit": r["entry_high"], "stop": r["stop"],
                 "target": r["target"], "shares": 1}
        res = replay(order, ind, cfg)
        if res["status"] in ("open", "waiting"):
            busy_until[sym] = "9999"
        elif res["status"] == "closed":
            busy_until[sym] = res["exit_date"]
        signals.append({"date": day, "symbol": sym, "score": r["score"], "setup": r["setup"] or "",
                        "source": r["source"] or "rules", "stop": r["stop"], "target": r["target"], **res})
    closed = [s["return"] for s in signals if s["status"] == "closed"]
    summary = {**_stats(closed), "signals": len(signals),
               "open": sum(s["status"] == "open" for s in signals),
               "skipped": sum(s["status"] == "skipped" for s in signals),
               "since": signals[0]["date"] if signals else None}
    return {"summary": summary, "signals": signals[::-1], "health": health(summary, stored_odds(conn))}


def health(summary: dict, odds: dict | None) -> dict:
    """The live record against the test: early (under MIN_LIVE closed), ok, or cold (clearly worse: COLD_GAP or more
    fewer winners), when it's time to use smaller positions. Winning often is what the BUYs are judged on."""
    test = (odds or {}).get("all")
    if summary["n"] < MIN_LIVE or not test or test.get("win_rate") is None:
        return {"status": "early", "need": MIN_LIVE, "closed": summary["n"]}
    cold = summary["win_rate"] < test["win_rate"] - COLD_GAP
    return {"status": "cold" if cold else "ok", "closed": summary["n"], "win_rate": summary["win_rate"],
            "test_win_rate": test["win_rate"], "test_avg": test["avg"]}


# ------------------------------------------------------------------ what the backtest says signals like it did
def odds_from_trades(trades: pd.DataFrame) -> dict:
    """The backtest's trades by the score their signal had: how many won and the average result after fees."""
    if trades.empty:
        return {"all": _stats([]), "bands": []}
    rets = trades["return_pct"].astype(float)
    bands = []
    for lo, hi in BANDS:
        sel = rets[(trades["score"] >= lo) & (trades["score"] < hi)].tolist()
        bands.append({"from": lo, "to": min(hi, 100), **_stats(sel)})
    return {"all": _stats(rets.tolist()), "bands": bands}


def stored_odds(conn: sqlite3.Connection) -> dict | None:
    raw = db.get_meta(conn, ODDS_KEY)
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None


def _fingerprint(cfg: dict) -> str:
    keep = {k: v for k, v in cfg.items() if not k.startswith("telegram_") and k not in ("capital", "paper_capital")}
    return json.dumps(keep, sort_keys=True, default=str)


def refresh_odds(conn: sqlite3.Connection, cfg: dict, today: date | None = None) -> bool:
    """Run the BUY rules over the last ODDS_YEARS years (backtest.py) and keep the results by score band, once a week
    or when the strategy changed. Returns True when it ran."""
    old = stored_odds(conn)
    today = today or date.today()
    if old and old.get("settings") == _fingerprint(cfg) and \
            today - date.fromisoformat(old["built"][:10]) < ODDS_MAX_AGE:
        return False
    table = universe.stock_table(conn, cfg.get("egx33_extra"))
    index_df = db.load_prices(conn, prices.INDEX_SYMBOL)
    if index_df.empty:
        return False
    prep = backtest.prepare(prices.load_all(conn, list(table.index)), index_df, table, cfg, conn)
    end = prep.index_ind.index[-1]
    start = end - pd.DateOffset(years=ODDS_YEARS)
    res = backtest.run(prep, cfg, start)
    out = {**odds_from_trades(res["trades"]), "from": str(prep.index_ind.index[prep.index_ind.index >= start][0].date()),
           "to": str(end.date()), "built": datetime.now().isoformat(timespec="seconds"), "settings": _fingerprint(cfg),
           "cagr": res["metrics"]["cagr"], "max_drawdown": res["metrics"]["max_drawdown"]}
    db.set_meta(conn, ODDS_KEY, json.dumps(out))
    return True


def public_odds(odds: dict | None) -> dict | None:
    """What the pages show (no settings fingerprint)."""
    return {k: v for k, v in odds.items() if k != "settings"} if odds else None
