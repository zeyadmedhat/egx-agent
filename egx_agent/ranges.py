"""How far each stock could move in the next 5 and 20 sessions (the stock page's "How far it could move"): the range
its close ended inside 8 times in 10, and the chance it trades at a given price on the way. Both come from the
stock's recent swings, calibrated each day on how far stocks like it really moved over the past year.

It says how far, not which way. Up or down is close to a coin flip on EGX (the AI card's and the ranking model's
tests), but the size of the moves is predictable: a stock that has been swinging hard keeps swinging hard for a while.
- swing: the stock's daily moves, the recent ones counting more (EWMA, λ 0.94), times √sessions;
- 9 groups of similar stocks that day: by how much they trade and how jumpy they've been (thirds of each);
- each day, each group's ranges that finished in the last CAL sessions give the multiples of the swing the close
  ended beyond, 1 time in 10 below and 1 in 10 above (split conformal prediction, calibrated per group), and how far
  the session highs and lows reached (the chance of trading at a price).

    python -m egx_agent.ranges --db data/egx.db          # the replay behind TESTED

Chosen in Oct 2026 by a walk-forward test, every stock, Jan 2018 – Sep 2026 (that session's scratchpad: range_test.py,
range2.py, touch_test.py, tsfm_cmp.py). Also tried: the same swing calibrated over every stock at once (the calm
stocks' ranges held 74%, the jumpy ones' 86%), the stock's own past moves (64–83% by year), a pooled HAR volatility
model and LightGBM quantile regression (both no better once calibrated, and more to run), and the three AI models'
own 10–90% bands. On the AI card's 34 test closes (7,300 ranges each) this one scored best: interval score 24.4 a
week and 49.0 a month, against 25.1–25.5 and 54.9–59.3 for Chronos-2, TimesFM 2.5 and TiRex (24.9–25.1 and 51.6–52.9
even after calibrating theirs the same way; lower is better).
"""
from __future__ import annotations

import argparse
import sqlite3

import numpy as np
import pandas as pd

from . import db, holidays
from .data.prices import INDEX_SYMBOL

STEPS = (5, 20)
CAL = 250              # sessions of finished ranges each day's calibration reads (about a year)
ALPHA = 0.2            # 1 time in 10 below the range, 1 in 10 above
DECAY = 0.06           # the newest day's weight in the swing (EWMA λ 0.94, as in RiskMetrics)
MIN_BARS = 60          # sessions a stock needs (as the AI card)
MIN_CAL = 500          # finished ranges a group needs before it's calibrated
SHOWN = 250            # sessions of past ranges graded on the page
WARM = 120             # sessions the swing and the 60-session jumpiness need before the first range
CHANCES = (0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1)    # the price ladder: the price it trades at with this chance
CAP = {5: 0.6, 20: 0.7}   # tested chances above these ran high (said 74%, happened 61% in a week): shown as "over"
# The replay (main(), 8 Oct 2026). cover: how often the close ended inside; groups and years: the lowest and highest of the 9
# groups and of the years.
TESTED = {"from": "2018-01", "to": "2026-10", "steps": {
    "5": {"n": 398256, "cover": 0.796, "groups": [0.793, 0.798], "years": [0.774, 0.808]},
    "20": {"n": 394526, "cover": 0.783, "groups": [0.779, 0.787], "years": [0.746, 0.811]}}}


def _wide(conn: sqlite3.Connection, sessions: int | None):
    """The last `sessions` EGX sessions (all when None) and each stock's high, low, close and volume on them."""
    q = "SELECT date FROM prices WHERE symbol=? ORDER BY date DESC" + (" LIMIT ?" if sessions else "")
    cal = [r[0] for r in conn.execute(q, (INDEX_SYMBOL, sessions) if sessions else (INDEX_SYMBOL,))][::-1]
    if not cal:
        return cal, None
    px = pd.read_sql_query("SELECT symbol, date, high, low, close, volume FROM prices WHERE date >= ? AND symbol != ? "
                           "AND close > 0", conn, params=(cal[0], INDEX_SYMBOL))
    return cal, {c: px.pivot(index="date", columns="symbol", values=c).reindex(cal) for c in ("high", "low", "close", "volume")}


def _rows(w: dict[str, pd.DataFrame]) -> tuple[pd.DataFrame, dict[int, pd.DataFrame]]:
    """One row per stock and session it traded with enough history: its group and daily swing; and per step, how far
    it went in the next sessions, in swings (z: the close; up, down: the furthest high and low; NaN until finished)."""
    C, V = w["close"], w["volume"]
    traded = C.notna() & (V.fillna(0) > 0)
    Cf = C.ffill(limit=10)
    lr = np.log(Cf).diff()
    swing = np.sqrt((lr ** 2).ewm(alpha=DECAY, min_periods=30).mean())
    jumpy = lr.rolling(60).std()
    value = (C * V).where(traded).rolling(20, min_periods=5).median()
    keep = traded & (traded.cumsum() >= MIN_BARS) & jumpy.notna() & swing.notna() & (value > 0)
    third = lambda x: np.floor(np.minimum(x.where(keep).rank(axis=1, pct=True) * 3, 2.99))   # noqa: E731
    group = third(value) * 3 + third(jumpy)
    hi = w["high"].where(traded & (w["high"] >= C)).fillna(Cf)
    lo = w["low"].where(traded & (w["low"] <= C) & (w["low"] > 0)).fillna(Cf)
    k = keep.to_numpy()
    sessions, stocks = np.nonzero(k)
    base = pd.DataFrame({"i": sessions, "symbol": C.columns.to_numpy()[stocks], "group": group.to_numpy()[k].astype(int),
                         "swing": swing.to_numpy()[k], "close": Cf.to_numpy()[k]})
    n, moves = len(C), {}
    for h in STEPS:
        s = swing.to_numpy() * np.sqrt(h)
        z = np.log(C.ffill(limit=5).shift(-h) / Cf).to_numpy() / s
        up = np.log(hi[::-1].rolling(h, min_periods=1).max()[::-1].shift(-1) / Cf).to_numpy() / s
        down = -np.log(lo[::-1].rolling(h, min_periods=1).min()[::-1].shift(-1) / Cf).to_numpy() / s
        up[n - h:], down[n - h:] = np.nan, np.nan                     # not finished yet
        moves[h] = pd.DataFrame({"z": z[k], "up": up[k], "down": down[k]})
    return base, moves


def _calibrate(base: pd.DataFrame, moves: pd.DataFrame, h: int, days) -> pd.DataFrame:
    """For each day in `days` and group: the 10th and 90th percentile of z over the group's finished ranges made CAL
    to h sessions before (columns i, group, ql, qh), when there are MIN_CAL of them."""
    out = []
    done = moves["z"].notna().to_numpy()
    for g in range(9):
        m = done & (base["group"].to_numpy() == g)
        order = np.argsort(base["i"].to_numpy()[m], kind="stable")
        made, z = base["i"].to_numpy()[m][order], moves["z"].to_numpy()[m][order]
        for day in days:
            a, b = np.searchsorted(made, day - h - CAL), np.searchsorted(made, day - h, side="right")
            if b - a >= MIN_CAL:
                out.append((day, g, *np.quantile(z[a:b], [ALPHA / 2, 1 - ALPHA / 2])))
    return pd.DataFrame(out, columns=["i", "group", "ql", "qh"])


def _bands(base: pd.DataFrame, q: pd.DataFrame, h: int, rows: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The low and high end (as log moves) of these rows' ranges; NaN where the group wasn't calibrated that day."""
    r = base.iloc[rows][["i", "group", "swing"]].merge(q, on=["i", "group"], how="left")
    s = r["swing"].to_numpy() * np.sqrt(h)
    return r["ql"].to_numpy(float) * s, r["qh"].to_numpy(float) * s


def _inside(base: pd.DataFrame, moves: pd.DataFrame, h: int, rows: np.ndarray):
    """For the finished, calibrated ones of these rows: whether the close ended inside the range, and the rows."""
    q = _calibrate(base, moves, h, np.unique(base["i"].to_numpy()[rows]))
    lo, hi = _bands(base, q, h, rows)
    z = moves["z"].to_numpy()[rows] * base["swing"].to_numpy()[rows] * np.sqrt(h)
    ok = ~np.isnan(z) & ~np.isnan(lo)
    return (z >= lo)[ok] & (z <= hi)[ok], rows[ok], q


def build(conn: sqlite3.Connection, shown: int = SHOWN) -> dict:
    """Every stock's ranges from its latest close (if it traded in the last 5 sessions), with how its ranges of the
    last `shown` sessions did, and how every stock's did: {"date", "stocks": {sym: ...}, "all": {"5": {n, inside}}}."""
    cal, w = _wide(conn, shown + CAL + max(STEPS) + WARM)
    if w is None:
        return {"date": None, "stocks": {}, "all": {}}
    base, moves = _rows(w)
    if base.empty:
        return {"date": cal[-1], "stocks": {}, "all": {}}
    last = len(cal) - 1
    latest = base[base["i"] >= last - 5].groupby("symbol")["i"].idxmax().to_numpy()
    recent = np.nonzero((base["i"] >= last - shown).to_numpy())[0]
    stocks: dict[str, dict] = {}
    every = {}
    for h in STEPS:
        mv = moves[h]
        inside, done, q = _inside(base, mv, h, recent)
        every[str(h)] = {"n": int(len(inside)), "inside": int(inside.sum())}
        rec = pd.Series(inside).groupby(base["symbol"].to_numpy()[done]).agg(["size", "sum"])
        lo, hi = _bands(base, q, h, latest)
        samples: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = {}
        for j, r in enumerate(latest):
            day, g, sym = int(base.at[r, "i"]), int(base.at[r, "group"]), base.at[r, "symbol"]
            if np.isnan(lo[j]):
                continue
            if (day, g) not in samples:            # how far the group's finished ranges reached up and down
                m = (mv["up"].notna() & (base["group"] == g) & base["i"].between(day - h - CAL, day - h)).to_numpy()
                samples[day, g] = (mv["up"].to_numpy()[m], mv["down"].to_numpy()[m])
            close, s = float(base.at[r, "close"]), float(base.at[r, "swing"]) * np.sqrt(h)
            ups, downs = samples[day, g]
            st = stocks.setdefault(sym, {"made": cal[day], "close": close, "steps": {}})
            st["steps"][str(h)] = {
                "target": holidays.sessions_after(cal[day], h),
                "lo": _r(close * np.exp(lo[j])), "hi": _r(close * np.exp(hi[j])),
                "up": _ladder(close, s, ups, 1), "down": _ladder(close, s, downs, -1), "cap": CAP[h],
                "record": {"n": int(rec["size"].get(sym, 0)), "inside": int(rec["sum"].get(sym, 0))}}
    return {"date": cal[last], "stocks": stocks, "all": every}


def _ladder(close: float, s: float, reach: np.ndarray, sign: int) -> list[list[float]]:
    """[[chance, price]]: the price the stock trades at (or beyond) with each chance in CHANCES, nearest first."""
    out = []
    for c in CHANCES:
        k = float(np.quantile(reach, 1 - c))
        if k > 0:                               # a "price" on the wrong side of the close isn't a move
            out.append([c, _r(close * np.exp(sign * k * s))])
    return out


def _r(v: float) -> float:
    return float(f"{v:.5g}")


def replay(conn: sqlite3.Connection, start: str = "2018-01-01") -> dict:
    """TESTED: every range from `start` on, on the whole price history, scored as the page would have shown it."""
    cal, w = _wide(conn, None)
    base, moves = _rows(w)
    first = next(i for i, d in enumerate(cal) if d >= start)
    out = {"from": start[:7], "to": cal[-1][:7], "steps": {}}
    for h in STEPS:
        inside, rows, _ = _inside(base, moves[h], h, np.nonzero((base["i"] >= first).to_numpy())[0])
        s = pd.Series(inside)
        groups = s.groupby(base["group"].to_numpy()[rows]).mean()
        years = s.groupby(np.array([cal[i][:4] for i in base["i"].to_numpy()[rows]])).mean()
        out["steps"][str(h)] = {"n": int(len(s)), "cover": round(float(s.mean()), 3),
                                "groups": [round(float(groups.min()), 3), round(float(groups.max()), 3)],
                                "years": [round(float(years.min()), 3), round(float(years.max()), 3)]}
    return out


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="Replay the price ranges (TESTED)")
    p.add_argument("--db", required=True)
    a = p.parse_args(argv)
    print(replay(db.connect(a.db)))


if __name__ == "__main__":
    main()
