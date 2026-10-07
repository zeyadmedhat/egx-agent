"""Market mood: an EGX fear & greed gauge from 0 (extreme fear) to 100 (extreme greed), built the way CNN builds its
Fear & Greed Index, from seven things the agent already downloads. Each one scores 0–100 by where today's value sits
among the last two years', and the gauge is their average.

Tested 2018–2026: the mood didn't tell where EGX30 went the next month (rank correlation about 0), so it is context
for you, like breadth. Nothing here changes the BUY rules.
"""
from __future__ import annotations

import sqlite3

import numpy as np
import pandas as pd

from .data import flows as investor_flows
from .data.prices import INDEX_SYMBOL

SINCE = "2012-01-01"     # two years to score against before the first gauge, from EGX70's start (2017) on
WINDOW = 500             # sessions: today's value is ranked among the last two years'
MIN_PARTS = 4            # a gauge needs at least this many of the seven
AHEAD = 20               # sessions: what EGX30 did after each mood (about a month)

# key: what it measures (CNN's version in brackets)
PARTS = {
    "momentum": "EGX30 against its 125-day average",                       # [S&P 500 vs its 125-day average]
    "strength": "Stocks at a 1-year high against those at a 1-year low",    # [NYSE 52-week highs vs lows]
    "breadth": "Money traded in rising stocks against falling ones, last 20 sessions",   # [up vs down volume]
    "calm": "How calm EGX30 is against its usual swings",                   # [VIX vs its average]
    "vs_gold": "Stocks against gold in pounds, last 20 sessions",           # [stocks vs bonds: safe-haven demand]
    "small_caps": "Small companies (EGX70) against EGX30, last 20 sessions",  # [junk bond demand: appetite for risk]
    "foreign": "Foreign and Arab investors' net buying, last 20 sessions",  # [not CNN's: EGX's daily statement]
}
BANDS = [(25, "Extreme fear"), (45, "Fear"), (56, "Neutral"), (76, "Greed"), (101, "Extreme greed")]


def label(score: float) -> str:
    return next(name for top, name in BANDS if score < top)


def load(conn: sqlite3.Connection, since: str = SINCE) -> dict:
    """Closes and volumes (sessions × stocks), EGX30, gold in pounds and EGX70 on EGX30's sessions, and what foreign
    and Arab investors bought net each session (million EGP; missing days stay empty)."""
    px = pd.read_sql_query("SELECT symbol, date, close, volume FROM prices WHERE date >= ?", conn, params=(since,))
    if px.empty:
        return {}
    px["date"] = pd.to_datetime(px["date"])
    close = px.pivot(index="date", columns="symbol", values="close")
    volume = px.pivot(index="date", columns="symbol", values="volume")
    if INDEX_SYMBOL not in close:
        return {}
    index = close.pop(INDEX_SYMBOL).dropna()
    volume = volume.drop(columns=INDEX_SYMBOL, errors="ignore")
    mac = pd.read_sql_query("SELECT series, date, value FROM macro WHERE series IN ('gold', 'usdegp', 'egx70')", conn)
    mac["date"] = pd.to_datetime(mac["date"])
    mac = mac.pivot(index="date", columns="series", values="value")

    table = investor_flows.load(conn)

    def on_sessions(name: str) -> pd.Series:
        if name not in mac:
            return pd.Series(np.nan, index=index.index)
        s = mac[name].dropna()
        return s.reindex(s.index.union(index.index)).ffill().reindex(index.index)

    return {"close": close.reindex(index.index), "volume": volume.reindex(index.index), "index": index,
            "gold": on_sessions("gold") * on_sessions("usdegp"), "egx70": on_sessions("egx70"),
            "flows": -table["egyptians"].reindex(index.index), "flows_table": table}   # foreign + Arab = −Egyptians


def parts(close: pd.DataFrame, volume: pd.DataFrame, index: pd.Series, gold: pd.Series, egx70: pd.Series,
          flows: pd.Series | None = None) -> pd.DataFrame:
    """The seven measures on every session (higher = greedier), before scoring."""
    c = close.ffill(limit=5)                       # a stock that skipped a few sessions keeps its last price
    traded = close.notna().rolling(10, min_periods=1).max().astype(bool)
    counted = traded & (close.notna().cumsum() >= 250) & c.notna()
    hi, lo = c.rolling(250, min_periods=200).max(), c.rolling(250, min_periods=200).min()
    net = ((c >= hi * 0.999) & counted).sum(axis=1) - ((c <= lo * 1.001) & counted).sum(axis=1)
    chg = close / c.shift(1) - 1
    value = (close * volume).where(counted)
    up = value.where(chg > 0.0005).sum(axis=1).rolling(20).sum()
    down = value.where(chg < -0.0005).sum(axis=1).rolling(20).sum()
    r = index.pct_change(fill_method=None)
    return pd.DataFrame({
        "momentum": index / index.rolling(125).mean() - 1,
        "strength": net / counted.sum(axis=1).replace(0, np.nan),
        "breadth": (up - down) / (up + down),
        "calm": -(r.rolling(20).std() / r.rolling(250).std()),
        "vs_gold": index.pct_change(20, fill_method=None) - gold.pct_change(20, fill_method=None),
        "small_caps": egx70.pct_change(20, fill_method=None) - index.pct_change(20, fill_method=None),
        # their average net buying on the sessions known in the last 20 (at least 10) ÷ the average traded value
        "foreign": (pd.Series(np.nan, index=index.index) if flows is None else
                    flows.rolling(20, min_periods=10).mean() * 1e6 / value.sum(axis=1).rolling(20).mean()),
    }, index=index.index).replace([np.inf, -np.inf], np.nan)


def compute(data: dict) -> dict | None:
    """Today's mood, each part's score and value, a week ago, and what EGX30 did in the next month after each mood."""
    if not data:
        return None
    raw = parts(data["close"], data["volume"], data["index"], data["gold"], data["egx70"], data.get("flows"))
    score = raw.rolling(WINDOW, min_periods=250).rank(pct=True) * 100
    mood = score.mean(axis=1).where(score.notna().sum(axis=1) >= MIN_PARTS).dropna()
    if mood.empty:
        return None
    day = mood.index[-1]
    index = data["index"]
    ahead = (index.shift(-AHEAD) / index - 1).reindex(mood.index).dropna()
    bands = pd.Series([label(v) for v in mood.reindex(ahead.index)], index=ahead.index)
    past = [{"label": name, "sessions": int((bands == name).sum()),
             "median": float(ahead[bands == name].median()), "up": float((ahead[bands == name] > 0).mean())}
            for _, name in BANDS if (bands == name).sum() >= 20]
    past.append({"label": "Any mood", "sessions": int(len(ahead)), "median": float(ahead.median()),
                 "up": float((ahead > 0).mean())})
    return {
        "date": str(day.date()), "score": float(mood.iloc[-1]), "label": label(mood.iloc[-1]),
        "week_ago": float(mood.iloc[-6]) if len(mood) > 5 else None,
        "parts": [{"key": k, "text": PARTS[k], "score": None if np.isnan(score.at[day, k]) else float(score.at[day, k]),
                   "value": None if np.isnan(raw.at[day, k]) else float(raw.at[day, k])} for k in PARTS],
        "past": past, "since": str(ahead.index[0].date()) if len(ahead) else None,
        "flows": _last_flows(data.get("flows_table")),
        # the last year, for the chart: the mood, and what foreign and Arab investors bought net each day (million EGP)
        "history": {"time": [str(t.date()) for t in mood.index[-250:]], "score": [round(float(v), 1) for v in mood.tail(250)],
                    "flows": [None if pd.isna(v) else round(float(v), 1) for v in
                              (data.get("flows") if data.get("flows") is not None else pd.Series(dtype=float))
                              .reindex(mood.index[-250:])]},
    }


def _last_flows(table: pd.DataFrame | None) -> dict | None:
    """The last session's net buying by Egyptians, Arabs and foreigners (million EGP), for the Market page."""
    if table is None or table.dropna().empty:
        return None
    row = table.dropna().iloc[-1]
    return {"date": str(row.name.date()), **{k: float(row[k]) for k in ("egyptians", "arabs", "foreigners")}}
