"""Egypt-wide numbers for the prediction model: the dollar rate, interest rates, inflation and small caps (EGX70).

All four come from TradingView, like the prices. Each is only used from the day it was really known: the interbank
rate the day after, and monthly inflation about 25 days after the month it describes (CAPMAS publishes around the
10th). Tested walk-forward in 2026-09: they help the 20-session model and not the 10-session one.
"""
from __future__ import annotations

import sqlite3

import numpy as np
import pandas as pd

from .. import db
from ..indicators import ema
from .prices import TvProvider

# name: (TradingView symbol, exchange, days after its date that it's known)
SERIES = {
    "usdegp": ("USDEGP", "FX_IDC", 0),
    "interbank": ("EGINBR", "ECONOMICS", 1),
    "inflation": ("EGIRYY", "ECONOMICS", 25),
    "egx70": ("EGX70EWI", "EGX", 0),
}
# Downloaded with them but not the model's: gold in dollars an ounce, for your returns in gold and the zakat nisab.
EXTRA = {"gold": ("XAUUSD", "FX_IDC", 0)}
OUNCE_G = 31.1035
FULL_BARS = 5000     # the first download: all of it (the model learns from 2013 on)
UPDATE_BARS = 60

FEATURES = [
    "fx_ret21", "fx_ret63", "fx_ret252", "fx_jump63",           # the pound: recent moves and devaluation jumps
    "rate", "rate_chg63", "rate_chg252",                        # interbank interest rate and how it moved
    "infl", "infl_chg3m", "real_rate",                          # inflation, and the rate above inflation
    "e70_rel21", "e70_rel63",                                   # small caps (EGX70) vs EGX30
    "idx_ret63", "idx_dist_ema200", "idx_vol20",                # EGX30's longer trend and how jumpy it is
]


def update(conn: sqlite3.Connection, provider: TvProvider | None = None) -> list[str]:
    """Download new values for every series. Returns the names that failed (the old values stay)."""
    provider = provider or TvProvider()
    have = {r[0] for r in conn.execute("SELECT DISTINCT series FROM macro")}
    failed = []
    for name, (symbol, exchange, _lag) in {**SERIES, **EXTRA}.items():
        df = provider.fetch(symbol, UPDATE_BARS if name in have else FULL_BARS, exchange=exchange)
        if df is None or df.empty:
            failed.append(name)
            continue
        db.upsert_macro(conn, name, df)
    return failed


def features(raw: pd.DataFrame, index_close: pd.Series, days: pd.DatetimeIndex) -> pd.DataFrame:
    """The model's Egypt features on each trading day (NaN where a series is missing or starts later)."""
    def known(name: str) -> pd.Series:
        if raw.empty or name not in raw:
            return pd.Series(np.nan, index=days)
        s = raw[name].dropna()
        s.index = s.index + pd.Timedelta(days=SERIES[name][2])
        return s.reindex(s.index.union(days)).ffill().reindex(days)

    fx, rate, infl, e70 = known("usdegp"), known("interbank"), known("inflation"), known("egx70")
    e30 = index_close.reindex(index_close.index.union(days)).ffill().reindex(days)
    fxr = fx.pct_change(fill_method=None)
    ret = lambda s, n: s.pct_change(n, fill_method=None)  # noqa: E731
    return pd.DataFrame({
        "fx_ret21": ret(fx, 21), "fx_ret63": ret(fx, 63), "fx_ret252": ret(fx, 252), "fx_jump63": fxr.rolling(63).max(),
        "rate": rate, "rate_chg63": rate - rate.shift(63), "rate_chg252": rate - rate.shift(252),
        "infl": infl, "infl_chg3m": infl - infl.shift(63), "real_rate": rate - infl,
        "e70_rel21": ret(e70, 21) - ret(e30, 21), "e70_rel63": ret(e70, 63) - ret(e30, 63),
        "idx_ret63": ret(e30, 63), "idx_dist_ema200": e30 / ema(e30, 200) - 1,
        "idx_vol20": e30.pct_change(fill_method=None).rolling(20).std(),
    }, index=days).replace([np.inf, -np.inf], np.nan)
