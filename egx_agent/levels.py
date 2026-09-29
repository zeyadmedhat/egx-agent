"""Stop-loss and target from the chart: support and resistance, Fibonacci, pivots, averages and volume.

The old plan put the stop 2× the daily range below the price, capped at 12%, and the target 2× that above it, so on
most EGX stocks every plan read −12% / +24%. Here each tool marks prices where buyers or sellers showed up before:

- swing lows / highs: turning points of the last year (a low with 5 higher lows on each side, and the same for highs)
- Fibonacci: retracements (23.6–78.6%) of the latest big rise, and extensions (127.2%, 161.8%) above its top
- the 20- and 50-day averages, which trends often bounce off
- monthly pivot points (from the last 20 sessions' high, low and close)
- the price where the most shares traded in the last 6 months (volume profile)
- the 1-year high

Levels closer than a third of a day's range are one zone, and a zone is stronger the more tools agree on it. The stop
goes a little under the nearest solid support, the target a little under the first resistance that pays at least
`target_min_r` times the risk. When the chart gives nothing usable it falls back to the ATR rule.

chart_plan() only reads bars up to the row it's given, so the backtest can use it on every past day.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

LOOKBACK = 250        # bars of history the levels come from (~1 year)
LEG = 120             # the Fibonacci move is the rise into the highest high of the last ~6 months
SWING = 5             # a swing low needs this many higher lows on each side
FIB_RET = (0.236, 0.382, 0.5, 0.618, 0.786)
FIB_EXT = (1.272, 1.618)
STOP_BUFFER = 0.3     # × ATR under the support: a dip that only touches it doesn't stop you out
TARGET_BUFFER = 0.1   # × ATR under the resistance: sell before the crowd waiting there
SOLID = 2.5           # zone strength that counts as solid (about two tools agreeing)
COLS = ("high", "low", "close", "volume", "ema20", "ema50", "atr14")


def _swings(x: np.ndarray, k: int, low: bool) -> list[int]:
    """Confirmed swing lows (or highs): the extreme of the k bars on each side. The last k bars can't be confirmed
    yet, so they're never swings (no peeking at later bars)."""
    if len(x) < 2 * k + 1:
        return []
    win = np.lib.stride_tricks.sliding_window_view(x, 2 * k + 1)
    ext = win.min(axis=1) if low else win.max(axis=1)
    return list(np.flatnonzero(x[k:len(x) - k] == ext) + k)


def _candidates(o: dict) -> list[tuple[float, float, str]]:
    """(price, weight, what) for every level the tools mark."""
    hi, lo, cl, vol = o["high"], o["low"], o["close"], o["volume"]
    n = len(cl)
    out = []
    for j in _swings(lo, SWING, True):
        out.append((lo[j], 2.0, f"swing low {o['dates'][j]}"))
    for j in _swings(hi, SWING, False):
        out.append((hi[j], 2.0, f"swing high {o['dates'][j]}"))
    # Fibonacci on the latest big rise: the lowest low before the ~6-month top, up to that top.
    start = max(0, n - LEG)
    h_i = start + int(np.nanargmax(hi[start:]))
    l_i = start + int(np.nanargmin(lo[start:h_i + 1]))
    top, bottom = hi[h_i], lo[l_i]
    if top > bottom * 1.05:
        for r in FIB_RET:
            out.append((top - r * (top - bottom), 1.5 if r in (0.382, 0.5, 0.618) else 1.0, f"Fibonacci {r:.1%}"))
        for e in FIB_EXT:
            out.append((bottom + e * (top - bottom), 1.5, f"Fibonacci extension {e:.1%}"))
    for key, w, name in (("ema20", 1.0, "20-day average"), ("ema50", 1.5, "50-day average")):
        out.append((o[key][-1], w, name))
    m_hi, m_lo, m_cl = np.nanmax(hi[-20:]), np.nanmin(lo[-20:]), cl[-1]
    p = (m_hi + m_lo + m_cl) / 3
    for price, name in ((p, "monthly pivot"), (2 * p - m_hi, "pivot S1"), (p - (m_hi - m_lo), "pivot S2"),
                        (2 * p - m_lo, "pivot R1"), (p + (m_hi - m_lo), "pivot R2")):
        out.append((price, 1.0, name))
    w = slice(max(0, n - 120), n)
    typical = (hi[w] + lo[w] + cl[w]) / 3
    ok = np.isfinite(typical)
    if ok.sum() > 20 and np.nansum(vol[w]) > 0 and typical[ok].max() > typical[ok].min():
        counts, edges = np.histogram(typical[ok], bins=30, weights=np.nan_to_num(vol[w][ok]))
        b = int(np.argmax(counts))
        out.append(((edges[b] + edges[b + 1]) / 2, 2.0, "most-traded price (6 months)"))
    out.append((np.nanmax(hi), 2.0, "1-year high"))
    return [(float(pr), wt, what) for pr, wt, what in out if np.isfinite(pr) and pr > 0]


def _zones(cands: list[tuple[float, float, str]], width: float) -> list[dict]:
    """Merge levels closer than `width` into zones: price is the weighted middle, strength the summed weight."""
    groups: list[list] = []
    for item in sorted(cands):
        if groups and item[0] - groups[-1][-1][0] <= width:
            groups[-1].append(item)
        else:
            groups.append([item])
    out = []
    for g in groups:
        wsum = sum(w for _, w, _ in g)
        names, kinds = [], set()
        for _, _, what in sorted(g, key=lambda x: -x[1]):
            kind = what.split(" 20")[0]                      # "swing low 2026-03-02" → "swing low"
            if kind not in kinds:
                kinds.add(kind)
                names.append(what)
        out.append({"price": sum(p * w for p, w, _ in g) / wsum, "low": g[0][0], "high": g[-1][0],
                    "strength": wsum, "sources": names})
    return out


def chart_plan(o: dict, cfg: dict) -> dict | None:
    """Stop, target and the levels behind them for buying at today's close. o: numpy arrays (COLS) and dates, oldest
    first, ending at the day in question. None: too little history."""
    if len(o["close"]) < 60:
        return None
    c, atr = float(o["close"][-1]), float(o["atr14"][-1])
    if not (np.isfinite(c) and np.isfinite(atr) and atr > 0):
        return None
    zones = _zones(_candidates(o), max(atr / 3, c * 0.004))
    lo_pct, hi_pct = max(cfg["stop_min_pct"] / 100, atr / c), cfg["stop_max_pct"] / 100

    # Stop: under the nearest solid support that isn't inside a normal day's wiggle nor past stop_max_pct.
    supports = sorted([z for z in zones if z["high"] < c], key=lambda z: -z["price"])
    stop, stop_zone = None, None
    for need in (SOLID, 0):
        for z in supports:
            s = z["low"] - STOP_BUFFER * atr
            if z["strength"] >= need and lo_pct <= 1 - s / c <= hi_pct:
                stop, stop_zone = s, z
                break
        if stop:
            break
    method = "chart"
    if stop is None:                                       # nothing on the chart in range: the ATR rule
        method = "atr"
        stop = c * (1 - min(max(cfg["atr_stop_mult"] * atr / c, cfg["stop_min_pct"] / 100), hi_pct))
    risk = c - stop

    # Target: under the first real resistance that pays at least target_min_r × the risk (capped at target_max_r).
    # A solid level passed on the way is shown as a hurdle.
    min_r, max_r = cfg.get("target_min_r", 1.5), cfg.get("target_max_r", 4.0)
    resist = sorted([z for z in zones if z["low"] > c], key=lambda z: z["price"])
    target, target_zone, hurdle = None, None, None
    for z in resist:
        t = z["low"] - TARGET_BUFFER * atr
        if t - c >= min_r * risk and z["strength"] >= SOLID * 0.6:
            target, target_zone = min(t, c + max_r * risk), z
            break
        if z["strength"] >= SOLID and hurdle is None:
            hurdle = z
    if target is None:
        target = c + cfg["target_r"] * risk
        if method == "chart":
            method = "mixed"
    target2 = next((z["low"] - TARGET_BUFFER * atr for z in resist
                    if z["low"] - TARGET_BUFFER * atr > target * 1.02 and z["strength"] >= SOLID * 0.6), None)
    return {
        "method": method, "close": c, "stop": stop, "target": target, "target2": target2,
        "stop_pct": 1 - stop / c, "target_pct": target / c - 1, "rr": (target - c) / risk,
        "stop_why": stop_zone["sources"] if stop_zone else [],
        "target_why": target_zone["sources"] if target_zone else [],
        "hurdle": _public(hurdle) if hurdle else None,
        # every level down to the stop's and up to the target's (at least 3 each side), nearest first
        "supports": [_public(z) for i, z in enumerate(supports) if i < 3 or z["high"] >= stop][:8],
        "resistances": [_public(z) for i, z in enumerate(resist) if i < 3 or z["low"] <= target + atr][:8],
    }


def _public(z: dict) -> dict:
    return {"price": z["price"], "strength": round(z["strength"], 1), "sources": z["sources"][:4]}


def arrays(ind: pd.DataFrame) -> dict:
    o = {k: ind[k].to_numpy(float) for k in COLS}
    o["dates"] = [str(t.date()) for t in ind.index]
    return o


def plan_at(ind: pd.DataFrame, cfg: dict, day=None) -> dict | None:
    """chart_plan on the bars up to `day` (default: the last bar)."""
    if day is not None:
        ind = ind[ind.index <= pd.Timestamp(day)]
    return chart_plan(arrays(ind.tail(LOOKBACK)), cfg)


def apply(ind: pd.DataFrame, sf: pd.DataFrame, cfg: dict, rows: np.ndarray | None = None) -> pd.DataFrame:
    """Replace the ATR stop/target in a signal frame with the chart's on the given rows (a boolean mask; default the
    last row). Does nothing unless cfg['levels_mode'] is 'chart'."""
    if cfg.get("levels_mode", "atr") != "chart" or not len(ind):
        return sf
    if rows is None:
        rows = np.zeros(len(ind), dtype=bool)
        rows[-1] = True
    full = arrays(ind)
    stop, target = sf["stop"].to_numpy(float).copy(), sf["target"].to_numpy(float).copy()
    for i in np.flatnonzero(rows):
        a = max(0, i + 1 - LOOKBACK)
        p = chart_plan({k: v[a:i + 1] for k, v in full.items()}, cfg)
        if p:
            stop[i], target[i] = p["stop"], p["target"]
    sf = sf.copy()
    sf["stop"], sf["target"] = stop, target
    return sf


def describe(p: dict | None) -> list[str]:
    """Plain-English lines on where the stop and target come from, for a signal's reasons."""
    if not p:
        return []
    out = []
    if p["stop_why"]:
        out.append(f"Stop sits just under support: {', '.join(p['stop_why'][:3])}")
    if p["target_why"]:
        out.append(f"Target sits just under resistance: {', '.join(p['target_why'][:3])}")
    elif p["method"] != "atr":
        out.append(f"No resistance overhead within reach: the target is {p['rr']:.1f}× the risk")
    if p["hurdle"]:
        out.append(f"Caution: resistance at {p['hurdle']['price']:.2f} ({', '.join(p['hurdle']['sources'][:2])}) "
                   "comes before the target")
    return out
