"""The 7 layers: a checklist from GrowthX's "مرآة السوق" video (Nov 2026), built here from standard public formulas.

Each layer asks one question of the chart; a stock scores how many pass (0–7). The video's rule is to trade only at
6/7 or more. Its timeframes are 15 minutes to 4 hours (day trading); the agent works on daily prices, so the bigger
timeframes here are the week and the month. Its "smart money" indicator is the course's own, so layer 7 uses market
structure instead (a break of the last swing high or low: BOS when it goes the trend's way, CHoCH when it turns it)
with the money flow (Chaikin's CMF).

  1 Trend        the price above its 50-day average, and the 20-day above the 50-day
  2 Momentum     RSI between 50 and 70 (rising, not overbought) and MACD above its signal line
  3 Volume       more shares traded on up days than on down days over the last 20
  4 Volatility   the daily swing (ATR) not among its wildest 20% of the year: a stop at 2× ATR still makes sense
  5 Squeeze      Bollinger bands inside the Keltner channel (coiled), or released upward in the last 5 sessions
  6 Timeframes   the last full week and month closed above their own averages (10 weeks, 10 months)
  7 Smart money  the last break of a swing level was upward, and money flowed in (CMF > 0) over 20 sessions

frame() works on every row from the bars up to it (no look-ahead), so the 10-year test (study) can use it.
"""
from __future__ import annotations

import sqlite3

import numpy as np
import pandas as pd

from .indicators import ema

LAYERS = ("trend", "momentum", "volume", "volatility", "squeeze", "timeframes", "smart_money")
SWING = 3            # a swing high or low: the highest / lowest of 3 bars on each side, known 3 bars later
PASS = 6             # the video's rule: trade only at 6/7 or more
HORIZON = 20         # sessions ahead the study measures (about a month)


def _bigger(close: pd.Series, rule: str, n: int, kind: str) -> pd.Series:
    """Whether the last *complete* week or month (rule) closed above its n-period average, on each day: a period
    counts only from the day after it ended, so nothing is seen early."""
    per = close.resample(rule).last().dropna()
    avg = ema(per, n) if kind == "ema" else per.rolling(n, min_periods=n).mean()
    up = (per > avg).astype(float).where(avg.notna())
    up.index = up.index + pd.Timedelta(days=1)
    return up.reindex(close.index.union(up.index)).ffill().reindex(close.index)


def _structure(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> tuple[np.ndarray, list]:
    """+1 after the close broke above the last swing high, −1 after it broke below the last swing low (0 before
    either), and the breaks: (row, "BOS" | "CHoCH", +1 | −1, level)."""
    n, k = len(close), SWING
    state, s = np.zeros(n), 0
    hi_lvl = lo_lvl = None
    events = []
    for i in range(n):
        j = i - k                                     # the bar that becomes a swing point once k bars follow it
        if j >= k:
            if high[j] == high[j - k:i + 1].max():
                hi_lvl = high[j]
            if low[j] == low[j - k:i + 1].min():
                lo_lvl = low[j]
        if hi_lvl is not None and close[i] > hi_lvl:
            events.append((i, "BOS" if s == 1 else "CHoCH", 1, float(hi_lvl)))
            s, hi_lvl = 1, None
        elif lo_lvl is not None and close[i] < lo_lvl:
            events.append((i, "BOS" if s == -1 else "CHoCH", -1, float(lo_lvl)))
            s, lo_lvl = -1, None
        state[i] = s
    return state, events


def frame(ind: pd.DataFrame) -> pd.DataFrame:
    """Each layer passed or not on every row, the score, and the numbers behind them. ind: indicators.add_indicators."""
    c, h, lo, v = ind["close"], ind["high"], ind["low"], ind["volume"]
    out = pd.DataFrame(index=ind.index)
    out["trend"] = (c > ind["ema50"]) & (ind["ema20"] > ind["ema50"])
    out["momentum"] = ind["rsi14"].between(50, 70) & (ind["macd_hist"] > 0)
    out["volume"] = ind["updown_vol"] > 1
    atr_pct = ind["atr14"] / c
    out["atr_rank"] = atr_pct.rolling(250, min_periods=60).rank(pct=True)
    out["volatility"] = out["atr_rank"] <= 0.8
    mid, sd = c.rolling(20).mean(), c.rolling(20).std()
    kc_mid, kc_w = ema(c, 20), 1.5 * ind["atr14"]
    out["squeeze_on"] = (mid + 2 * sd < kc_mid + kc_w) & (mid - 2 * sd > kc_mid - kc_w)
    was_on = out["squeeze_on"].shift(1).astype(float).rolling(5, min_periods=1).max() > 0
    out["released_up"] = was_on & ~out["squeeze_on"] & (c > mid)
    out["squeeze"] = out["squeeze_on"] | out["released_up"]
    out["week_up"] = _bigger(c, "W-THU", 10, "ema")             # EGX's week ends on Thursday
    out["month_up"] = _bigger(c, "ME", 10, "sma")
    out["timeframes"] = (out["week_up"] == 1) & (out["month_up"] == 1)
    rng = (h - lo).replace(0, np.nan)
    mfv = (((c - lo) - (h - c)) / rng).fillna(0) * v
    out["cmf"] = mfv.rolling(20).sum() / v.rolling(20).sum().replace(0, np.nan)
    state, _ = _structure(h.to_numpy(float), lo.to_numpy(float), c.to_numpy(float))
    out["structure"] = state
    out["smart_money"] = (out["structure"] > 0) & (out["cmf"] > 0)
    out["score"] = out[list(LAYERS)].astype(int).sum(axis=1)
    return out


def check(ind: pd.DataFrame) -> dict | None:
    """The 7 layers at the last close, for the stock page: {score, pass_at, items: [{key, ok, ...numbers}],
    last_break}. None with too little history."""
    if len(ind) < 120:
        return None
    f = frame(ind)
    last, row = ind.iloc[-1], f.iloc[-1]
    _, events = _structure(ind["high"].to_numpy(float), ind["low"].to_numpy(float), ind["close"].to_numpy(float))
    num = lambda x: None if x is None or not np.isfinite(x) else round(float(x), 4)  # noqa: E731
    flag = lambda x: None if pd.isna(x) else bool(x)  # noqa: E731
    values = {
        "trend": {"ema20": num(last.ema20), "ema50": num(last.ema50), "vs_ema50": num(last.close / last.ema50 - 1)},
        "momentum": {"rsi": num(last.rsi14), "macd_up": bool(last.macd_hist > 0)},
        "volume": {"updown": num(last.updown_vol), "vol_ratio": num(last.vol_ratio)},
        "volatility": {"atr_pct": num(last.atr14 / last.close), "rank": num(row.atr_rank)},
        "squeeze": {"on": bool(row.squeeze_on), "released_up": bool(row.released_up)},
        "timeframes": {"week_up": flag(row.week_up), "month_up": flag(row.month_up)},
        "smart_money": {"structure": int(row.structure), "cmf": num(row.cmf)},
    }
    brk = events[-1] if events else None
    return {"score": int(row.score), "pass_at": PASS,
            "items": [{"key": k, "ok": bool(row[k]), **values[k]} for k in LAYERS],
            "last_break": brk and {"date": str(ind.index[brk[0]].date()), "kind": brk[1], "up": brk[2] > 0,
                                   "level": brk[3]}}


# ------------------------------------------------------------------ did it work on EGX? (record.refresh_odds)

def study(prep, cfg: dict, start, res: dict, run) -> dict:
    """The 7 layers over the replay's years: every eligible stock-day by its score, what the price did over the next
    HORIZON sessions against EGX30 (before 2022 and after, to see it hold); and the BUY rules' replay as it is
    against the same rules taking only BUYs at PASS/7 or more. run: backtest.run (passed in: no import loop)."""
    start = pd.Timestamp(start)
    idx = prep.index_ind["close"]
    idx_fwd = idx.shift(-HORIZON) / idx - 1
    scores, rows = {}, []
    for sym, ind in prep.ind.items():
        if len(ind) < 120:
            continue
        sc = frame(ind)["score"]
        scores[sym] = sc
        fwd = ind["close"].shift(-HORIZON) / ind["close"] - 1
        ok = prep.sf[sym]["eligible"].reindex(ind.index).fillna(False).astype(bool) & (ind.index >= start) & fwd.notna()
        if ok.any():
            rows.append(pd.DataFrame({"score": sc[ok], "ret": fwd[ok],
                                      "excess": fwd[ok] - idx_fwd.reindex(ind.index[ok]).to_numpy(),
                                      "late": ind.index[ok] >= pd.Timestamp("2022-01-01")}))
    days = pd.concat(rows) if rows else pd.DataFrame(columns=["score", "ret", "excess", "late"])
    days = days[days["excess"].notna()]

    def stat(g: pd.DataFrame) -> dict | None:
        return {"n": int(len(g)), "up": float((g["ret"] > 0).mean()), "beat": float((g["excess"] > 0).mean()),
                "median": float(g["excess"].median())} if len(g) else None
    by_score = [{"score": s, **(stat(days[days["score"] == s]) or {"n": 0})} for s in range(8)]
    hi, lo = days["score"] >= PASS, days["score"] < PASS
    late = days["late"].astype(bool)
    periods = {k: {"pass": stat(days[hi & m]), "rest": stat(days[lo & m])}
               for k, m in (("before_2022", ~late), ("since_2022", late))}

    # the BUY rules as they are, and taking only BUYs whose stock had PASS/7 or more that day
    panel = pd.DataFrame(scores).reindex(index=prep.buy.index, columns=prep.buy.columns)
    strict = run(prep, cfg, start, buy=prep.buy & panel.ge(PASS).fillna(False))

    def replay(r: dict) -> dict:
        t, m = r["trades"], r["metrics"]
        return {"trades": int(len(t)), "wins": float((t["return_pct"] > 0).mean()) if len(t) else None,
                "avg": float(t["return_pct"].mean()) if len(t) else None, "cagr": m["cagr"],
                "max_drawdown": m["max_drawdown"]}
    # the rules' own BUYs split by the score their stock had the session before the fill
    t, split = res["trades"], {}
    if len(t):
        sc_at = [float(panel[s].asof(pd.Timestamp(d) - pd.Timedelta(days=1))) if s in panel else np.nan
                 for s, d in zip(t["symbol"], t["entry_date"])]
        t = t.assign(layers=sc_at)
        for k, m in (("pass", t["layers"] >= PASS), ("rest", t["layers"] < PASS)):
            g = t[m]
            split[k] = {"n": int(len(g)), "wins": float((g["return_pct"] > 0).mean()) if len(g) else None,
                        "avg": float(g["return_pct"].mean()) if len(g) else None}
    return {"from": str(start.date()), "horizon": HORIZON, "pass_at": PASS, "n": int(len(days)), "by_score": by_score,
            "periods": periods,
            "all": stat(days), "rules": replay(res), "strict": replay(strict), "buys_split": split}


# ------------------------------------------------------------------ the live record (Picks → 7 Layers)

def save_day(conn: sqlite3.Connection, day: str, picks: list[tuple[str, int, float]]) -> int:
    """Keep the day's stocks at PASS/7 or more: (symbol, score, close). Saving the same day again replaces it."""
    conn.execute("DELETE FROM layer_picks WHERE date=?", (day,))
    conn.executemany("INSERT INTO layer_picks(date, symbol, score, close) VALUES (?,?,?,?)",
                     [(day, s, int(sc), float(c)) for s, sc, c in picks if sc >= PASS])
    conn.commit()
    return sum(1 for _, sc, _ in picks if sc >= PASS)


def live_record(conn: sqlite3.Connection, close_of, index_close: pd.Series) -> dict:
    """How the kept picks did from their day's close: to the last close, and over HORIZON sessions once that has
    passed, each against EGX30 over the same days. close_of(symbol) → its closes (a Series by date)."""
    picks = [dict(r) for r in conn.execute("SELECT date, symbol, score, close FROM layer_picks ORDER BY date, symbol")]
    out = []
    for p in picks:
        c = close_of(p["symbol"])
        day = pd.Timestamp(p["date"])
        if c is None or not len(c) or day not in index_close.index:
            continue
        after, idx_after = c[c.index > day], index_close[index_close.index > day]
        i0 = float(index_close.loc[day])
        row = {**p, "now": float(c.iloc[-1]) / p["close"] - 1, "egx30_now": float(index_close.iloc[-1]) / i0 - 1,
               "sessions": int(len(after))}
        if len(after) >= HORIZON and len(idx_after) >= HORIZON:
            row["ret"] = float(after.iloc[HORIZON - 1]) / p["close"] - 1
            row["egx30"] = float(idx_after.iloc[HORIZON - 1]) / i0 - 1
        out.append(row)
    done = [r for r in out if "ret" in r]
    summary = lambda rs, a, b: {"n": len(rs), "beat": sum(r[a] > r[b] for r in rs) / len(rs),  # noqa: E731
                                "avg": sum(r[a] - r[b] for r in rs) / len(rs)} if rs else None
    return {"since": out[0]["date"] if out else None, "days": len({r["date"] for r in out}),
            "so_far": summary([r for r in out if r["sessions"]], "now", "egx30_now"), "month": summary(done, "ret", "egx30"),
            "recent": out[-40:][::-1]}
