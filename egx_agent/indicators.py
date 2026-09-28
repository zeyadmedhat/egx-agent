"""Technical indicators in plain pandas. Every column only uses data up to its own row (no lookahead)."""
from __future__ import annotations

import numpy as np
import pandas as pd


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def wilder(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(alpha=1 / n, adjust=False).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    delta = close.diff()
    gain = wilder(delta.clip(lower=0), n)
    loss = wilder(-delta.clip(upper=0), n)
    out = 100 - 100 / (1 + gain / loss)
    out = out.where(loss > 0, np.where(gain > 0, 100.0, 50.0))
    return out.where(delta.notna().cumsum() > 0)


def true_range(df: pd.DataFrame) -> pd.Series:
    prev = df["close"].shift()
    return pd.concat([df["high"] - df["low"], (df["high"] - prev).abs(), (df["low"] - prev).abs()], axis=1).max(axis=1)


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    return wilder(true_range(df), n)


def adx(df: pd.DataFrame, n: int = 14) -> pd.Series:
    up = df["high"].diff()
    down = -df["low"].diff()
    plus_dm = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=df.index)
    tr = wilder(true_range(df), n)
    plus_di = 100 * wilder(plus_dm, n) / tr
    minus_di = 100 * wilder(minus_dm, n) / tr
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return wilder(dx.fillna(0), n)


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9):
    line = ema(close, fast) - ema(close, slow)
    sig = ema(line, signal)
    return line, sig, line - sig


def add_indicators(df: pd.DataFrame, index_close: pd.Series | None = None) -> pd.DataFrame:
    """Return a copy of an OHLCV frame with every indicator the strategy uses."""
    out = df.copy()
    c, v = out["close"], out["volume"]
    out["ema20"] = ema(c, 20)
    out["ema50"] = ema(c, 50)
    out["rsi14"] = rsi(c)
    out["macd"], out["macd_signal"], out["macd_hist"] = macd(c)
    out["atr14"] = atr(out)
    out["adx14"] = adx(out)
    out["vol_avg20"] = v.rolling(20).mean()
    out["vol_ratio"] = v / out["vol_avg20"].shift(1)          # today's volume vs the previous 20 days
    up_vol = v.where(c.diff() > 0, 0).rolling(20).sum()
    down_vol = v.where(c.diff() < 0, 0).rolling(20).sum()
    out["updown_vol"] = up_vol / down_vol.replace(0, np.nan)  # accumulation: >1 means more volume on up days
    out["value"] = c * v
    out["value_avg20"] = out["value"].rolling(20).mean()
    out["high20_prev"] = out["high"].rolling(20).max().shift(1)
    out["high120_prev"] = out["high"].rolling(120, min_periods=20).max().shift(1)
    out["low3"] = out["low"].rolling(3).min()
    out["ret63"] = c.pct_change(63, fill_method=None)
    out["ema20_slope"] = out["ema20"].pct_change(5, fill_method=None)
    out["bars"] = np.arange(1, len(out) + 1)
    jump = c.pct_change(fill_method=None).abs() > 0.30
    out["recent_jump"] = jump.astype(float).rolling(120, min_periods=1).max() > 0
    if index_close is not None:
        idx_ret = index_close.pct_change(63, fill_method=None)
        out["index_ret63"] = idx_ret.reindex(out.index, method="ffill")
    else:
        out["index_ret63"] = np.nan
    return out
