"""Market breadth: how many EGX stocks are rising along with the index, and which sectors lead.

EGX30 can rise on a handful of big names while most stocks fall. Breadth shows whether a move is broad
(healthier for new breakouts) or narrow. Nothing here changes the BUY rules; it is context for you.
"""
from __future__ import annotations

import sqlite3
from datetime import date, timedelta

import numpy as np
import pandas as pd

from .data.prices import INDEX_SYMBOL
from .indicators import ema

MIN_BARS = 50          # a stock needs this many sessions before it counts
ACTIVE_WITHIN = 10     # ... and must have traded in the last this-many sessions
SESSIONS = 460         # enough for a 200-day average plus a year of history


def load_closes(conn: sqlite3.Connection, sessions: int = SESSIONS) -> tuple[pd.DataFrame, pd.Series]:
    """Closes as a table (EGX sessions × stocks) and the EGX30 close, for the last `sessions` sessions."""
    since = (date.today() - timedelta(days=int(sessions * 7 / 5) + 40)).isoformat()
    rows = pd.read_sql_query("SELECT symbol, date, close FROM prices WHERE date >= ?", conn, params=(since,))
    if rows.empty:
        return pd.DataFrame(), pd.Series(dtype=float)
    wide = rows.pivot(index="date", columns="symbol", values="close")
    wide.index = pd.to_datetime(wide.index)
    index = wide.pop(INDEX_SYMBOL) if INDEX_SYMBOL in wide else pd.Series(dtype=float)
    if len(index.dropna()):
        wide = wide.reindex(index.dropna().index)  # the index's sessions are the trading calendar
    return wide.tail(sessions), index.dropna().tail(sessions)


def _pct_above(c: pd.DataFrame, n: int, counted: pd.DataFrame) -> pd.Series:
    ok = counted & (c.notna().cumsum() >= n)
    above = (c > ema(c, n)) & ok
    return above.sum(axis=1) / ok.sum(axis=1).replace(0, np.nan)


def compute(closes: pd.DataFrame, index_close: pd.Series, sectors: pd.Series, history: int = 250) -> dict | None:
    """Breadth today and over the last `history` sessions, plus a sector table.

    sectors: English sector name by symbol.
    """
    if closes.empty or len(closes) < 30:
        return None
    raw = closes
    c = raw.ffill(limit=5)           # a stock that skipped a few sessions keeps its last price
    traded = raw.notna().rolling(ACTIVE_WITHIN, min_periods=1).max().astype(bool)
    counted = traded & (raw.notna().cumsum() >= MIN_BARS) & c.notna()

    p20, p50, p200 = (_pct_above(c, n, counted) for n in (20, 50, 200))
    today = counted.iloc[-1]
    stocks = today[today].index
    last, prev = c.iloc[-1][stocks], c.iloc[-2][stocks]
    moved = raw.iloc[-1][stocks].notna()   # traded on the last session
    chg = (last / prev - 1)[moved]
    hi = c.rolling(250, min_periods=120).max().iloc[-1][stocks]
    lo = c.rolling(250, min_periods=120).min().iloc[-1][stocks]

    def ret(n: int) -> pd.Series:
        return c.iloc[-1][stocks] / c.iloc[-1 - n][stocks] - 1 if len(c) > n else pd.Series(np.nan, index=stocks)

    above50 = (c.iloc[-1] > ema(c, 50).iloc[-1])[stocks]
    table = pd.DataFrame({
        "sector": sectors.reindex(stocks).fillna("Other"), "above50": above50,
        "r5": ret(5), "r21": ret(21), "r63": ret(63),
    })
    sector_rows = []
    for name, g in table.groupby("sector"):
        leaders = g["r21"].dropna().sort_values(ascending=False).head(3)
        sector_rows.append({
            "sector": name, "stocks": len(g), "above50": float(g["above50"].mean()),
            "r5": float(g["r5"].median()), "r21": float(g["r21"].median()), "r63": float(g["r63"].median()),
            "leaders": [{"symbol": s, "r21": float(v)} for s, v in leaders.items()],
        })
    sector_rows.sort(key=lambda r: -np.nan_to_num(r["r21"], nan=-9))

    week_ago = float(p50.iloc[-6]) if len(p50) > 5 else None
    hist = pd.DataFrame({"p50": p50, "p20": p20, "index": index_close.reindex(p50.index)}).tail(history)
    return {
        "date": str(c.index[-1].date()),
        "stocks": int(len(stocks)),
        "above20": float(p20.iloc[-1]), "above50": float(p50.iloc[-1]), "above200": float(p200.iloc[-1]),
        "above50_week_ago": week_ago,
        "advancers": int((chg > 0.0005).sum()), "decliners": int((chg < -0.0005).sum()),
        "unchanged": int(len(chg) - (chg > 0.0005).sum() - (chg < -0.0005).sum()),
        "new_highs": int((last >= hi * 0.999).sum()), "new_lows": int((last <= lo * 1.001).sum()),
        "history": {"time": [str(t.date()) for t in hist.index], "above50": hist["p50"].tolist(),
                    "above20": hist["p20"].tolist(), "index": hist["index"].tolist()},
        "sectors": sector_rows,
    }


def verdict(b: dict, index_risk_off: bool | None) -> dict:
    """One-line reading of breadth, with a tone for the dashboard (ok / warn / bad)."""
    p = b["above50"]
    if p >= 0.6:
        tone, text = "ok", "Broad strength: most stocks are in uptrends."
    elif p >= 0.4:
        tone, text = "warn", "Mixed: only about half of stocks are above their 50-day average."
    else:
        tone, text = "bad", "Weak: most stocks are below their 50-day average."
    if index_risk_off is False and p < 0.4:
        text = "Narrow: EGX30 is above its average, but most stocks aren't. A few big names are carrying the index."
    elif index_risk_off is True and p >= 0.55:
        text = "Most stocks are holding up better than EGX30, which is below its 50-day average."
    change = None if b.get("above50_week_ago") is None else p - b["above50_week_ago"]
    return {"tone": tone, "text": text, "change_week": change}
