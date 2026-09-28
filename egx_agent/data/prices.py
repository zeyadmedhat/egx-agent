"""Daily EGX prices.

TvProvider pulls from TradingView through the unofficial tvdatafeed library (free, no login). It is
flaky ("Connection to remote host was lost"), so every call retries. Other providers (EODHD, Twelve
Data) can be added later by implementing PriceProvider.fetch().
"""
from __future__ import annotations

import logging
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from typing import Callable, Protocol

import pandas as pd

from .. import db

INDEX_SYMBOL = "EGX30"
log = logging.getLogger(__name__)

# Kashif code → TradingView code, where they differ (renamed companies, or listings TradingView keys by ISIN).
TV_ALIASES = {
    "AIHC": "AIH",            # Arabia Investments Holding
    "ANFI": "TYCN",           # Tycoon Investments Holding (formerly Alexandria National Financial Investments)
    "FCMD": "EGS3I0S1C019",   # Future Care for Medical Industries
    "NAPR": "EGS370O1C013",   # National Printing
}
# Stocks known to have no current prices anywhere.
KNOWN_STATUS = {"SIMO": "trading suspended on EGX since Dec 2018"}
NOTE_NOT_FOUND = "not found on TradingView"
NOTE_NEVER_TRADED = "listed but never traded yet (only a par-value quote, zero volume)"


class PriceProvider(Protocol):
    def fetch(self, symbol: str, n_bars: int) -> pd.DataFrame | None:
        """Return columns date (YYYY-MM-DD str), open, high, low, close, volume; oldest first. None if unavailable."""


class TvProvider:
    def __init__(self, retries: int = 4, pause: float = 1.5, aliases: dict[str, str] | None = None):
        self.retries = retries
        self.pause = pause
        self.aliases = {**TV_ALIASES, **{k.upper(): v.upper() for k, v in (aliases or {}).items()}}
        self._local = threading.local()

    def _client(self):
        if not hasattr(self._local, "tv"):
            logging.getLogger("tvDatafeed.main").setLevel(logging.CRITICAL)
            from tvDatafeed import TvDatafeed

            self._local.tv = TvDatafeed()
        return self._local.tv

    def fetch(self, symbol: str, n_bars: int, exchange: str = "EGX") -> pd.DataFrame | None:
        from tvDatafeed import Interval

        tv_symbol = self.aliases.get(symbol, symbol) if exchange == "EGX" else symbol
        for attempt in range(self.retries):
            try:
                raw = self._client().get_hist(symbol=tv_symbol, exchange=exchange, interval=Interval.in_daily,
                                              n_bars=n_bars)
            except Exception as exc:  # network errors inside the library
                log.debug("fetch %s failed: %s", symbol, exc)
                raw = None
            if raw is not None and len(raw):
                df = raw.reset_index()[["datetime", "open", "high", "low", "close", "volume"]]
                df["date"] = pd.to_datetime(df["datetime"]).dt.strftime("%Y-%m-%d")
                df = df.drop(columns="datetime").drop_duplicates("date", keep="last")
                return df[["date", "open", "high", "low", "close", "volume"]].dropna()
            time.sleep(self.pause * (attempt + 1))
        return None


def _bars_needed(last: str | None, years: int) -> int:
    if last is None:
        return int(years * 250) + 60
    gap_days = (date.today() - date.fromisoformat(last)).days
    return max(15, int(gap_days * 5 / 7) + 10)


def _nice_factors() -> list[float]:
    bonus = {1 + k / n for n in range(1, 21) for k in range(1, min(n, 5) + 1)}   # k free shares for every n held
    splits = set(range(2, 21))
    ups = sorted(bonus | splits)
    return ups + [1 / f for f in ups]


NICE_FACTORS = _nice_factors()


def snap_factor(f: float) -> float:
    """Round a measured price ratio to the bonus or split ratio it almost certainly is (1.2497 → 1.25)."""
    best = min(NICE_FACTORS, key=lambda x: abs(x / f - 1))
    return round(best, 6) if abs(best / f - 1) < 0.005 else round(f, 4)


def rebase_info(conn: sqlite3.Connection, symbol: str, fresh: pd.DataFrame) -> dict | None:
    """How TradingView re-based a stock's past prices (bonus shares, split), or None if they still match.

    Returns {"factor": old price ÷ new price, "ex_date": first session on the new basis (None if unknown)}.
    """
    old = pd.read_sql_query(
        "SELECT date, close FROM prices WHERE symbol=? AND date >= ?", conn, params=(symbol, fresh["date"].min())
    )
    merged = old.merge(fresh[["date", "close"]], on="date", suffixes=("_old", "_new"))
    merged = merged[(merged["close_old"] > 0) & (merged["close_new"] > 0)].reset_index(drop=True)
    if len(merged) < 2:
        return None
    ratio = merged["close_old"] / merged["close_new"]
    # The latest stored bar may have been saved mid-session, so it can't prove a re-base on its own...
    moved = ((ratio - 1).abs() > 0.02) & (merged.index < len(merged) - 1)
    if moved.sum() < 2:
        return None
    # A re-base moves every earlier bar by the same ratio. A few odd bars are just a data correction.
    last_moved = moved[moved].index.max()
    if moved.loc[:last_moved].mean() < 0.9:
        return None
    factor = float(ratio[moved].median())
    # ...but it was re-based too if it moved by the same ratio.
    moved |= (ratio / factor - 1).abs() < 0.015
    later = fresh.loc[fresh["date"] > merged.loc[moved, "date"].max(), "date"]
    return {"factor": snap_factor(factor), "ex_date": later.min() if len(later) else None}


def update_prices(
    conn: sqlite3.Connection,
    symbols: list[str],
    provider: PriceProvider | None = None,
    years: int = 5,
    workers: int = 4,
    progress: Callable[[int, int, str], None] | None = None,
    aliases: dict[str, str] | None = None,
) -> dict:
    """Download new bars for every symbol. Returns counts of updated / failed / never-traded symbols."""
    provider = provider or TvProvider(aliases=aliases)
    plan = {s: db.last_price_date(conn, s) for s in symbols}
    lock = threading.Lock()
    done, updated, failed, readjusted, not_traded = 0, [], [], [], []
    rebased: dict[str, dict] = {}

    def work(sym: str):
        return sym, provider.fetch(sym, _bars_needed(plan[sym], years))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(work, s) for s in symbols]
        for fut in as_completed(futures):
            sym, df = fut.result()
            with lock:
                done += 1
                if df is None:
                    failed.append(sym)
                elif plan[sym] is None and float(df["volume"].sum()) == 0:
                    # A placeholder quote at par value with no volume: listed, but no trade has ever happened.
                    not_traded.append(sym)
                elif plan[sym] is not None and (info := rebase_info(conn, sym, df)):
                    # History was re-based; re-download the full series in the main thread below.
                    readjusted.append(sym)
                    rebased[sym] = info
                else:
                    db.upsert_prices(conn, sym, df)
                    updated.append(sym)
                if progress:
                    progress(done, len(symbols), sym)

    events = []
    full_years = max(years, int(db.get_meta(conn, "history_years_loaded") or 0))  # keep a deeper download deep
    for sym in readjusted:
        full = provider.fetch(sym, _bars_needed(None, full_years))
        if full is not None:
            db.delete_prices(conn, sym)
            db.upsert_prices(conn, sym, full)
            updated.append(sym)
            info = rebased[sym]
            ex_date = info["ex_date"] or full["date"].iloc[-1]
            db.add_price_event(conn, sym, ex_date, info["factor"])
            events.append({"symbol": sym, "ex_date": ex_date, "factor": info["factor"]})
        else:
            failed.append(sym)

    notes = {s: KNOWN_STATUS.get(s, NOTE_NOT_FOUND) for s in failed if plan[s] is None}
    notes.update({s: NOTE_NEVER_TRADED for s in not_traded})
    today = date.today().isoformat()
    for sym in symbols:
        note = notes.get(sym)
        conn.execute(
            "UPDATE stocks SET price_missing_since=?, price_note=? WHERE symbol=?",
            (today if note else None, note, sym),
        )
    conn.commit()
    return {"updated": len(updated), "failed": sorted(failed), "readjusted": sorted(readjusted),
            "not_traded": sorted(not_traded), "events": events}


DEEP_YEARS = 10  # the prediction model learns from this much history


def extend_history(
    conn: sqlite3.Connection,
    symbols: list[str],
    years: int = DEEP_YEARS,
    provider: PriceProvider | None = None,
    workers: int = 4,
    progress: Callable[[int, int, str], None] | None = None,
    aliases: dict[str, str] | None = None,
) -> dict:
    """One-time deeper download: add the older bars so each stock has up to `years` of history.

    Stored bars are left alone. If TradingView re-based the stock's history meanwhile (bonus shares, split), the
    whole series is replaced and the event recorded, exactly as update_prices does.
    """
    provider = provider or TvProvider(aliases=aliases)
    first = {s: conn.execute("SELECT MIN(date) AS d FROM prices WHERE symbol=?", (s,)).fetchone()["d"] for s in symbols}
    todo = [s for s in symbols if first[s]]
    added, failed, events, done = 0, [], [], 0

    def work(sym: str):
        return sym, provider.fetch(sym, _bars_needed(None, years))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(work, s) for s in todo]
        for fut in as_completed(futures):
            sym, df = fut.result()
            done += 1
            if df is None:
                failed.append(sym)
            elif info := rebase_info(conn, sym, df):
                db.delete_prices(conn, sym)
                db.upsert_prices(conn, sym, df)
                ex_date = info["ex_date"] or df["date"].iloc[-1]
                db.add_price_event(conn, sym, ex_date, info["factor"])
                events.append({"symbol": sym, "ex_date": ex_date, "factor": info["factor"]})
            else:
                added += int((df["date"] < first[sym]).sum())
                db.upsert_prices(conn, sym, df)   # also fixes any stored bar TradingView has since corrected
            if progress:
                progress(done, len(todo), sym)
    if len(failed) < max(1, len(todo) // 2):
        db.set_meta(conn, "history_years_loaded", str(years))
    return {"symbols": len(todo), "bars_added": added, "failed": sorted(failed), "events": events}


def load_all(conn: sqlite3.Connection, symbols: list[str]) -> dict[str, pd.DataFrame]:
    out = {}
    for s in symbols:
        df = db.load_prices(conn, s)
        if len(df):
            out[s] = df
    return out


def sanity_flags(df: pd.DataFrame, index_last: pd.Timestamp | None = None) -> list[str]:
    """Reasons to distrust a price series. Flagged stocks never get BUY signals."""
    flags = []
    if df.empty:
        return ["no data"]
    recent = df.tail(120)
    jumps = recent["close"].pct_change().abs()
    if (jumps > 0.30).any():
        when = jumps.idxmax().date()
        flags.append(f"unusual {jumps.max():.0%} one-day move on {when} (possible unadjusted split/bonus)")
    last60 = df.tail(60)
    if len(last60) and (last60["volume"] <= 0).mean() > 0.2:
        flags.append("frequent zero-volume days")
    if index_last is not None and df.index[-1] < index_last - timedelta(days=10):
        flags.append(f"stale data (last bar {df.index[-1].date()})")
    return flags
