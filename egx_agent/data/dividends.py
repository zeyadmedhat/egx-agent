"""Every EGX company's cash dividends, and when its results come, from TradingView.

- The screener (one request for the whole market) gives each stock's latest dividend, the next one once it's
  announced, and the yield: cash_dividends. The same request brings the date of each company's last results and
  TradingView's expected date for the next ones: earnings.
- The whole history comes from TradingView's prices: the same chart "adjusted for dividends" and not. On each
  ex-date the two part by exactly that dividend, so every step in their ratio is one dividend, back to 2001
  (update_history → dividend_history). A few stocks a run, each again every month.

The exit rules use them (per_share): on the ex-date the price drops by the dividend, so an open position's stop and
target move down by it too, and the backtest and paper trades are paid it. Bonus shares and splits are found in the
prices instead (price_events, data/prices.py).
"""
from __future__ import annotations

import json
import logging
import sqlite3
import time
from datetime import date, datetime, timedelta, timezone
from typing import Callable
from zoneinfo import ZoneInfo

import pandas as pd
import requests

from .. import db
from . import prices

URL = "https://scanner.tradingview.com/egypt/scan"
COLUMNS = ["name", "dividends_yield_current", "dividend_ex_date_recent", "dividend_amount_recent",
           "dividend_payment_date_recent", "dividend_ex_date_upcoming", "dividend_amount_upcoming",
           "dividend_payment_date_upcoming", "earnings_release_date", "earnings_release_next_date"]
# The company's numbers from the same list (the Stock page's Company numbers card): TradingView column → ours, and
# what to multiply by (its growth, margin and return figures are percents). In 2026-09 TradingView had P/E and growth
# for about 80 EGX companies, price/book and debt for about 180, market value for about 240.
FUNDAMENTALS = {"market_cap_basic": ("market_cap", 1), "price_earnings_ttm": ("pe", 1), "price_book_fq": ("pb", 1),
                "earnings_per_share_diluted_yoy_growth_ttm": ("eps_growth", 0.01),
                "total_revenue_yoy_growth_ttm": ("revenue_growth", 0.01), "net_margin_ttm": ("net_margin", 0.01),
                "return_on_equity_fq": ("roe", 0.01), "debt_to_equity_fq": ("debt_equity", 1)}
COLUMNS = COLUMNS + list(FUNDAMENTALS)
EARNINGS_STALE_DAYS = 400     # a company whose last results on TradingView are older gets no expected date: it
                              # doesn't report there regularly, so the estimate would be a guess
CAIRO = ZoneInfo("Africa/Cairo")


def _day(ts) -> str | None:
    """TradingView's timestamps are mid-afternoon Cairo time on the day."""
    return None if ts is None else datetime.fromtimestamp(ts, timezone.utc).astimezone(CAIRO).date().isoformat()


def fetch(session: requests.Session | None = None, timeout: float = 30) -> list[dict]:
    body = {"filter": [{"left": "exchange", "operation": "equal", "right": "EGX"}], "columns": COLUMNS,
            "range": [0, 1000]}
    res = (session or requests).post(URL, json=body, timeout=timeout)
    res.raise_for_status()
    return [dict(zip(COLUMNS, r["d"])) for r in res.json().get("data", [])]


def save(conn: sqlite3.Connection, rows: list[dict]) -> int:
    """Store the dividends and yields. Returns how many dividends were new."""
    now = datetime.now().isoformat(timespec="seconds")
    before = conn.execute("SELECT COUNT(*) FROM cash_dividends").fetchone()[0]
    for r in rows:
        sym = r["name"]
        for when in ("recent", "upcoming"):
            ex = _day(r[f"dividend_ex_date_{when}"])
            amount = r[f"dividend_amount_{when}"]
            if ex and amount:
                conn.execute(
                    """INSERT INTO cash_dividends(symbol, ex_date, pay_date, amount, first_seen) VALUES (?,?,?,?,?)
                       ON CONFLICT(symbol, ex_date) DO UPDATE SET pay_date=excluded.pay_date, amount=excluded.amount""",
                    (sym, ex, _day(r[f"dividend_payment_date_{when}"]), round(float(amount), 6), now))
        conn.execute("INSERT OR REPLACE INTO dividend_yield(symbol, yield_pct, updated) VALUES (?,?,?)",
                     (sym, r["dividends_yield_current"], now))
        last, nxt = _day(r.get("earnings_release_date")), _day(r.get("earnings_release_next_date"))
        if last and (date.fromisoformat(now[:10]) - date.fromisoformat(last)).days > EARNINGS_STALE_DAYS:
            nxt = None
        if last or nxt:
            conn.execute("INSERT OR REPLACE INTO earnings(symbol, next_date, last_date, updated) VALUES (?,?,?,?)",
                         (sym, nxt or "", last or "", now))
        nums = {ours: float(r[col]) * k for col, (ours, k) in FUNDAMENTALS.items() if r.get(col) is not None}
        if nums:
            conn.execute("INSERT OR REPLACE INTO fundamentals(symbol, data, updated) VALUES (?,?,?)",
                         (sym, json.dumps(nums), now))
    conn.commit()
    return conn.execute("SELECT COUNT(*) FROM cash_dividends").fetchone()[0] - before


def update(conn: sqlite3.Connection) -> int:
    return save(conn, fetch())


def company_numbers(conn: sqlite3.Connection, symbol: str, sectors: pd.Series) -> dict | None:
    """A company's numbers (FUNDAMENTALS) and, for each, the middle value of the other companies in its sector that
    report it (at least 3). None when TradingView has nothing for it."""
    rows = {r["symbol"]: json.loads(r["data"]) for r in conn.execute("SELECT symbol, data FROM fundamentals")}
    mine = rows.get(symbol)
    if not mine:
        return None
    sector = sectors.get(symbol)
    peers = [v for s, v in rows.items() if s != symbol and sector and sectors.get(s) == sector]
    median = {}
    for key in mine:
        vals = [p[key] for p in peers if p.get(key) is not None]
        if len(vals) >= 3:
            median[key] = float(pd.Series(vals).median())
    updated = conn.execute("SELECT updated FROM fundamentals WHERE symbol=?", (symbol,)).fetchone()["updated"]
    return {"values": mine, "sector": sector, "sector_median": median, "peers": len(peers), "updated": updated}


# ------------------------------------------------------------------ the whole history, from the prices

HISTORY_EVERY_DAYS = 30
HISTORY_BUDGET_S = 120        # seconds a run spends on it: about 10 stocks, so the first full pass takes a few days
HISTORY_BARS = 5000           # all of it (EGX data on TradingView starts around 2001)
MAX_YIELD = 0.3               # a bigger "dividend" is a re-basing TradingView got wrong, not cash
STEP = 0.9995                 # a change under 0.05% in the ratio is rounding, not a dividend


def _feed(adjustment: str):
    """A TradingView client whose charts use this adjustment ("splits", the agent's usual, or "dividends")."""
    logging.getLogger("tvDatafeed.main").setLevel(logging.CRITICAL)
    from tvDatafeed import TvDatafeed

    class Feed(TvDatafeed):
        def _TvDatafeed__send_message(self, func, args):     # the library's own (private) sender
            if func == "resolve_symbol":
                args = [a.replace('"adjustment":"splits"', f'"adjustment":"{adjustment}"') if isinstance(a, str)
                        else a for a in args]
            return super()._TvDatafeed__send_message(func, args)
    return Feed()


def steps(raw: pd.Series, adjusted: pd.Series) -> list[tuple[str, float]]:
    """(ex_date, yield) for every dividend: where adjusted ÷ raw closes steps up from one session to the next."""
    j = pd.concat({"raw": raw, "adj": adjusted}, axis=1).dropna()
    j = j[(j["raw"] > 0) & (j["adj"] > 0)]
    if len(j) < 2:
        return []
    ratio = j["adj"] / j["raw"]
    step = (ratio / ratio.shift(-1)).iloc[:-1]
    out = []
    for i in (step < STEP).to_numpy().nonzero()[0]:
        y = 1 - float(step.iloc[i])
        if y <= MAX_YIELD:
            out.append((str(j.index[i + 1].date()), round(y, 6)))
    return out


def fetch_history(symbol: str, raw_feed, adj_feed, n_bars: int = HISTORY_BARS) -> list[tuple[str, float]] | None:
    from tvDatafeed import Interval

    tv = prices.TV_ALIASES.get(symbol, symbol)
    got = []
    for feed in (raw_feed, adj_feed):
        df = None
        for attempt in range(3):          # the connection drops now and then, as for the prices
            try:
                df = feed.get_hist(symbol=tv, exchange="EGX", interval=Interval.in_daily, n_bars=n_bars)
            except Exception:
                df = None
            if df is not None and not df.empty:
                break
            time.sleep(1.5 * (attempt + 1))
        if df is None or df.empty:
            return None
        s = df["close"].copy()
        s.index = pd.to_datetime(s.index).normalize()
        got.append(s[~s.index.duplicated(keep="last")])
    return steps(*got)


def update_history(conn: sqlite3.Connection, budget_s: float = HISTORY_BUDGET_S,
                   fetch_one: Callable[[str], list | None] | None = None) -> dict:
    """Read the dividend history of the stocks checked longest ago (never-checked ones first), for up to budget_s
    seconds. Each stock is read again every HISTORY_EVERY_DAYS. Returns counts (and how many are still to do)."""
    checked = json.loads(db.get_meta(conn, "div_history_checked") or "{}")
    due = (date.today() - timedelta(days=HISTORY_EVERY_DAYS)).isoformat()
    symbols = [r[0] for r in conn.execute(
        "SELECT symbol FROM stocks WHERE price_missing_since IS NULL AND symbol IN (SELECT DISTINCT symbol FROM prices)")]
    todo = sorted((s for s in symbols if checked.get(s, "") < due), key=lambda s: checked.get(s, ""))
    if fetch_one is None:
        raw_feed, adj_feed = _feed("splits"), _feed("dividends")
        fetch_one = lambda s: fetch_history(s, raw_feed, adj_feed)   # noqa: E731
    res = {"stocks": 0, "dividends": 0, "failed": 0, "left": len(todo)}
    start, misses = time.monotonic(), 0
    for sym in todo:
        if time.monotonic() - start > budget_s or misses >= 5:     # out of time, or TradingView isn't answering
            break
        try:
            rows = fetch_one(sym)
        except Exception:
            rows = None
        if rows is None:
            res["failed"] += 1
            misses += 1
            continue
        misses = 0
        before = conn.execute("SELECT COUNT(*) FROM dividend_history WHERE symbol=?", (sym,)).fetchone()[0]
        conn.execute("DELETE FROM dividend_history WHERE symbol=?", (sym,))
        conn.executemany("INSERT OR REPLACE INTO dividend_history(symbol, ex_date, yield) VALUES (?,?,?)",
                         [(sym, ex, y) for ex, y in rows])
        checked[sym] = date.today().isoformat()
        res["stocks"] += 1
        res["dividends"] += max(0, len(rows) - before)
        res["left"] -= 1
        conn.commit()
    db.set_meta(conn, "div_history_checked", json.dumps(checked))
    return res


def per_share(conn: sqlite3.Connection, symbol: str, closes: pd.Series) -> pd.Series:
    """The cash dividend per share on each ex-date, in the units of `closes` (a stock's closing prices, indexed by
    date): 0 on every other day. TradingView's announced amount when no bonus shares or split re-based the prices
    since; otherwise the history's yield × the close the session before, which is right either way."""
    out = pd.Series(0.0, index=closes.index)
    if closes.empty:
        return out
    pos = {d: i for i, d in enumerate(closes.index)}

    def prev_close(day: str) -> float | None:
        i = pos.get(pd.Timestamp(day))
        return float(closes.iloc[i - 1]) if i else None

    for ex, y in conn.execute("SELECT ex_date, yield FROM dividend_history WHERE symbol=?", (symbol,)):
        pc = prev_close(ex)
        if pc:
            out[pd.Timestamp(ex)] = y * pc
    last_rebase = conn.execute("SELECT MAX(ex_date) FROM price_events WHERE symbol=?", (symbol,)).fetchone()[0] or ""
    names = (symbol, prices.TV_ALIASES.get(symbol, symbol))
    for ex, amount in conn.execute("SELECT ex_date, amount FROM cash_dividends WHERE symbol IN (?,?)", names):
        pc = prev_close(ex)
        if pc and amount and ex >= last_rebase and amount / pc <= MAX_YIELD:
            out[pd.Timestamp(ex)] = float(amount)
    return out


def next_results(conn: sqlite3.Connection, after: str, before: str | None = None) -> dict[str, str]:
    """Each stock's expected results date after the day `after` (and up to `before`): {symbol: YYYY-MM-DD}."""
    sql, args = "SELECT symbol, next_date FROM earnings WHERE next_date > ?", [after]
    if before:
        sql += " AND next_date <= ?"
        args.append(before)
    back = {v: k for k, v in prices.TV_ALIASES.items()}
    return {back.get(sym, sym): day for sym, day in conn.execute(sql, args)}


def coming(conn: sqlite3.Connection, after: str) -> dict[str, dict]:
    """Each stock's next announced cash dividend after `after` (YYYY-MM-DD): {symbol: {ex_date, amount}}, with the
    agent's own symbols (TradingView's names for a few companies differ)."""
    back = {v: k for k, v in prices.TV_ALIASES.items()}
    out = {}
    for r in conn.execute("SELECT symbol, MIN(ex_date) AS ex_date, amount FROM cash_dividends WHERE ex_date > ? "
                          "GROUP BY symbol", (after,)):
        out[back.get(r[0], r[0])] = {"ex_date": r[1], "amount": r[2]}
    return out
