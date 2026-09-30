"""Prediction model: the chance that a trade bought at the next open reaches its target before its stop.

The trade uses the agent's own plan, set from the signal day's close exactly like a BUY card: with levels_mode
"chart" (the default) the stop and target from that day's support and resistance (levels.py), otherwise the stop
entry − 2×ATR (kept 4–12% below) and the target +2R. Walk-forward in 2026-09, training on the chart's trades
instead of the ATR ones lifted the rules-plus-its-picks backtest from 24.4% to 26.5% a year (Sharpe 1.44 → 1.48);
giving it the chart levels as inputs too made it worse (18.1%), so it doesn't see them. "Target before stop" must happen within 10 or 20
sessions (one model per horizon). If both levels are touched on the same day it counts as a loss.

One gradient-boosting model per horizon learns from every liquid EGX stock's history (price, volume, trend,
momentum, the stock's sector and the whole market's breadth); the 20-session one also sees Egypt-wide numbers
(the pound, interest rates, inflation: data/macro.py). It is tested walk-forward: every year is predicted by a
model trained only on the years before it, with a gap so no test trade overlaps a training trade. Those
out-of-sample results are what the dashboard shows, never results on data the model has seen. Trades whose entry
day couldn't really be traded (no volume, or locked at one price) are left out of them.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

from . import breadth, config, db, levels, strategy
from .data import macro, news, prices, universe
from .indicators import add_indicators, ema

HORIZONS = (10, 20)
EXPERIMENT = 5                # a 5-session model on paper only: bought at the next open, sold 5 sessions later
RANK_HORIZON = 10             # the model whose daily rank orders the BUYs and adds its own (config model_picks)
EXTRA_COST = 0.005            # a stress test: 0.25% more slippage on each side of every trade
PICKS = 5                     # the test portfolio: the day's top 5, bought equally every horizon
MODEL_VERSION = 5             # 2: Egypt data for the 20-session model, untradeable entry days left out of results;
                              # 3: the Egypt data is downloaded before training (2 could train without it);
                              # 4: dividend, bonus-share and rights-issue events (Mubasher, data/news.py);
                              # 5: trades use the chart's stop and target when levels_mode is chart (levels.py)
MIN_TRAIN_YEARS = 3           # the first tested year needs at least this much history before it
RETRAIN_DAYS = 30
MODEL_DIR = config.ROOT / "data" / "models"
LEVEL_KEYS = ("atr_stop_mult", "stop_min_pct", "stop_max_pct", "target_r", "fee_pct_per_side", "min_avg_value_egp",
              "levels_mode", "target_min_r", "target_max_r")
ALL_SETUPS = {**config.DEFAULTS, "setups": list(strategy.SETUP_LABELS)}

FEATURES = [
    # the stock's own momentum and trend
    "ret1", "ret5", "ret10", "ret21", "ret63", "ret126", "ret252",
    "dist_ema20", "dist_ema50", "dist_ema200", "ema20_slope", "ema50_slope",
    "rsi14", "rsi_chg5", "macd_hist", "adx14", "atr_pct", "stop_pct", "volat_ratio",
    "dist_high20", "dist_high252", "dist_low252", "range_pos", "gap",
    # volume
    "vol_ratio", "vol_5_50", "updown_vol", "zero_vol20",
    # the agent's own rules
    "breakout", "pullback", "macd_cross", "trend_ok", "base_score",
    # compared with the other stocks that day
    "rank_ret21", "rank_ret63", "rank_value", "rank_atr", "sector_rel21", "sector_breadth50",
    # the whole market
    "breadth20", "breadth50", "breadth200", "mkt_ret5", "mkt_ret21", "idx_ret5", "idx_ret21", "idx_dist_ema50",
]
# Walk-forward in 2026-09 (the same yearly tests, several random seeds): Egypt data lifted the 20-session model's top
# picks. Dividend/bonus-share/rights events (Mubasher) then lifted both: the 20-session top 10% from +1.21% to +1.41%
# a trade (better than the average stock in 10 of 11 years, from 8), and the 10-session one, now with the Egypt data
# and LightGBM too, from +0.90% to +1.04% (10 of 11 years, from 9).
LEVEL_FEATURES = ["lvl_stop_pct", "lvl_target_pct", "lvl_rr", "lvl_support", "lvl_resist", "lvl_support_str"]
ALL_HORIZONS = HORIZONS + (EXPERIMENT,)
HORIZON_FEATURES = {hz: FEATURES + macro.FEATURES + news.EVENT_FEATURES for hz in ALL_HORIZONS}
ALL_FEATURES = FEATURES + macro.FEATURES + news.EVENT_FEATURES

# "Why the model likes it": each measure in plain words and how to show its value. The same for every stock on a
# day (the whole market, Egypt-wide numbers) moves every score alike, so it isn't a reason for one stock.
MARKET_WIDE = {"breadth20", "breadth50", "breadth200", "mkt_ret5", "mkt_ret21", "idx_ret5", "idx_ret21",
               "idx_dist_ema50", *macro.FEATURES}
WHY_TEXT = {
    "ret1": ("Last session", "pct"), "ret5": ("1-week change", "pct"), "ret10": ("2-week change", "pct"),
    "ret21": ("1-month change", "pct"), "ret63": ("3-month change", "pct"), "ret126": ("6-month change", "pct"),
    "ret252": ("1-year change", "pct"), "dist_ema20": ("vs its 20-day average", "pct"),
    "dist_ema50": ("vs its 50-day average", "pct"), "dist_ema200": ("vs its 200-day average", "pct"),
    "ema20_slope": ("20-day average's slope", "pct"), "ema50_slope": ("50-day average's slope", "pct"),
    "rsi14": ("RSI", "num"), "rsi_chg5": ("RSI change this week", "signed"), "macd_hist": ("MACD momentum", None),
    "adx14": ("Trend strength (ADX)", "num"), "atr_pct": ("Daily range", "pct1"), "stop_pct": ("Stop distance", "pct1"),
    "volat_ratio": ("Jumpiness vs usual", "x"), "dist_high20": ("vs its 20-day high", "pct"),
    "dist_high252": ("vs its 1-year high", "pct"), "dist_low252": ("above its 1-year low", "pct"),
    "range_pos": ("Closed at this point of the day's range", "share"), "gap": ("Opening gap", "pct"),
    "vol_ratio": ("Volume vs usual", "x"), "vol_5_50": ("This week's volume vs usual", "x"),
    "updown_vol": ("Up-day vs down-day volume", "x"), "zero_vol20": ("Days without trades (last month)", "share"),
    "breakout": ("Breakout setup", "yes"), "pullback": ("Pullback setup", "yes"), "macd_cross": ("MACD cross", "yes"),
    "trend_ok": ("Uptrend check", "yes"), "base_score": ("Rules' score", "num"),
    "rank_ret21": ("1-month change vs other stocks", "rank"), "rank_ret63": ("3-month change vs other stocks", "rank"),
    "rank_value": ("Money traded vs other stocks", "rank"), "rank_atr": ("Daily range vs other stocks", "rank"),
    "sector_rel21": ("1-month change vs its sector", "pct"), "sector_breadth50": ("Its sector in uptrends", "share"),
    "div_ex_ahead": ("Next ex-dividend date", "days_ahead"), "div_since_ex": ("Last ex-dividend", "days_ago"),
    "div_since_ann": ("Last dividend announced", "days_ago"), "n_div_3y": ("Dividends in 3 years", "int"),
    "bonus_ex_ahead": ("Bonus shares coming", "days_ahead"), "bonus_since_ann": ("Bonus shares announced", "days_ago"),
    "rights_ex_ahead": ("Rights issue coming", "days_ahead"),
    "treasury_since_ann": ("Share buyback announced", "days_ago"),
}
WHY_UP, WHY_DOWN = 3, 2       # reasons shown: the strongest pushes up and down


# ------------------------------------------------------------------ features and labels

def stock_features(ind: pd.DataFrame) -> pd.DataFrame:
    """Per-day features of one stock from its indicator frame (add_indicators). Only uses data up to each row."""
    c, h, l, o, v = ind["close"], ind["high"], ind["low"], ind["open"], ind["volume"]
    sf = strategy.signal_frame(ind, ALL_SETUPS)
    f = pd.DataFrame(index=ind.index)
    for n in (1, 5, 10, 21, 63, 126, 252):
        f[f"ret{n}"] = c.pct_change(n, fill_method=None)
    f["dist_ema20"] = c / ind["ema20"] - 1
    f["dist_ema50"] = c / ind["ema50"] - 1
    f["dist_ema200"] = (c / ema(c, 200) - 1).where(pd.Series(np.arange(len(c)) >= 150, index=c.index))
    f["ema20_slope"] = ind["ema20_slope"]
    f["ema50_slope"] = ind["ema50"].pct_change(10, fill_method=None)
    f["rsi14"] = ind["rsi14"]
    f["rsi_chg5"] = ind["rsi14"].diff(5)
    f["macd_hist"] = ind["macd_hist"] / c
    f["adx14"] = ind["adx14"]
    f["atr_pct"] = ind["atr14"] / c
    f["stop_pct"] = 1 - sf["stop"] / c
    r = c.pct_change(fill_method=None)
    f["volat_ratio"] = r.rolling(20).std() / r.rolling(120, min_periods=60).std()
    f["dist_high20"] = c / ind["high20_prev"] - 1
    f["dist_high252"] = c / h.rolling(252, min_periods=120).max() - 1
    f["dist_low252"] = c / l.rolling(252, min_periods=120).min() - 1
    f["range_pos"] = ((c - l) / (h - l)).where(h > l)
    f["gap"] = o / c.shift() - 1
    f["vol_ratio"] = ind["vol_ratio"].clip(upper=20)
    f["vol_5_50"] = (v.rolling(5).mean() / v.rolling(50).mean()).clip(upper=20)
    f["updown_vol"] = ind["updown_vol"].clip(upper=10)
    f["zero_vol20"] = (v <= 0).astype(float).rolling(20).mean()
    f["breakout"] = sf["breakout"].astype(float)
    f["pullback"] = sf["pullback"].astype(float)
    f["macd_cross"] = sf["macd"].astype(float)
    f["trend_ok"] = sf["trend_ok"].astype(float)
    f["base_score"] = sf["base_score"]
    return f.replace([np.inf, -np.inf], np.nan)


def level_features(lv: pd.DataFrame, close: pd.Series) -> pd.DataFrame:
    """The chart plan as model inputs: its stop and target distance, reward/risk, the nearest support and
    resistance and how strong that support is."""
    stop_pct = 1 - lv["stop"] / close
    target_pct = lv["target"] / close - 1
    return pd.DataFrame({"lvl_stop_pct": stop_pct, "lvl_target_pct": target_pct,
                         "lvl_rr": (target_pct / stop_pct).where(stop_pct > 0), "lvl_support": lv["near_support"],
                         "lvl_resist": lv["near_resist"], "lvl_support_str": lv["support_strength"]},
                        index=lv.index).replace([np.inf, -np.inf], np.nan)


def trade_outcomes(ind: pd.DataFrame, cfg: dict, horizon: int, stop: np.ndarray | None = None,
                   target: np.ndarray | None = None) -> pd.DataFrame:
    """For every day t: buy at t+1's open with the stop/target set at t's close; what happened within `horizon` sessions?
    stop/target: each day's levels (default the ATR rule: entry − atr_stop_mult × ATR, target target_r × the risk).

    hit = 1 if the target was reached before the stop, 0 if not (stop first, both on one day, or time ran out),
    NaN while the outcome isn't known yet or the order would have been cancelled (opened below the stop).
    ret = the trade's result after fees: exit at the target, the stop (or a worse gap), or the last close.
    """
    c = ind["close"].to_numpy(float)
    o, hi, lo = (ind[k].to_numpy(float) for k in ("open", "high", "low"))
    n = len(c)
    if stop is None:
        stop = strategy.initial_stop(c, ind["atr14"].to_numpy(float), cfg)
        target = c + cfg["target_r"] * (c - stop)
    fee = cfg["fee_pct_per_side"] / 100

    def windows(a: np.ndarray) -> np.ndarray:  # row t holds days t+1 .. t+horizon
        return np.lib.stride_tricks.sliding_window_view(np.r_[a[1:], np.full(horizon, np.nan)], horizon)

    O, H, L, C = windows(o), windows(hi), windows(lo), windows(c)
    entry = O[:, 0]
    with np.errstate(invalid="ignore"):
        hit_stop = L <= stop[:, None]
        hit_tgt = H >= target[:, None]
        gap_win = entry >= target
    big = horizon + 1
    first_stop = np.where(hit_stop.any(1), hit_stop.argmax(1), big)
    first_tgt = np.where(hit_tgt.any(1), hit_tgt.argmax(1), big)
    win = gap_win | (first_tgt < first_stop)
    loss = ~win & (first_stop < big)
    rows = np.arange(n)
    i_stop = np.minimum(first_stop, horizon - 1)
    i_tgt = np.minimum(first_tgt, horizon - 1)
    exit_px = np.where(win, np.where(gap_win, entry, np.maximum(target, O[rows, i_tgt])),
                       np.where(loss, np.minimum(stop, O[rows, i_stop]), C[:, -1]))
    with np.errstate(invalid="ignore", divide="ignore"):
        ret = exit_px * (1 - fee) / (entry * (1 + fee)) - 1
        valid_entry = ~np.isnan(entry) & (entry > stop)
    complete = ~np.isnan(C[:, -1])
    known = valid_entry & (complete | win | loss)   # a trade still running only counts once it has hit a level
    return pd.DataFrame({"hit": np.where(known, win.astype(float), np.nan), "ret": np.where(known, ret, np.nan)},
                        index=ind.index)


def _liquid_then(ds: pd.DataFrame, cfg: dict) -> pd.Series:
    """Liquid for its time: the minimum traded value is scaled by how much the whole market traded back then.

    5M EGP a day in 2017 was a very liquid stock; today it is the minimum. On the latest day the scale is 1, so
    predictions use exactly the scan's rule.
    """
    typical = ds[ds["value_avg20"] > 0].groupby("date")["value_avg20"].median().sort_index()
    typical = typical.rolling(60, min_periods=10).median().bfill()
    scale = (typical / typical.iloc[-1]).reindex(ds["date"]).to_numpy() if len(typical) else 1.0
    return pd.Series(
        (ds["bars"] >= cfg["min_history_bars"]) & (ds["close"] >= cfg["min_price"]) & ~ds["recent_jump"].astype(bool)
        & (ds["value_avg20"] >= cfg["min_avg_value_egp"] * scale), index=ds.index)


def _cross_section(ds: pd.DataFrame, sectors: pd.Series) -> pd.DataFrame:
    """Features that compare each stock with the rest of the market on the same day."""
    day = ds["date"]
    liquid = ds["liquid"]
    for src, dst in (("ret21", "rank_ret21"), ("ret63", "rank_ret63"), ("value_avg20", "rank_value"),
                     ("atr_pct", "rank_atr")):
        ds[dst] = ds[src].where(liquid).groupby(day).rank(pct=True)
    for src, dst in (("dist_ema20", "breadth20"), ("dist_ema50", "breadth50"), ("dist_ema200", "breadth200")):
        up = (ds[src] > 0).astype(float).where(ds[src].notna())
        ds[dst] = up.groupby(day).transform("mean")
    ds["mkt_ret5"] = ds.groupby("date")["ret5"].transform("median")
    ds["mkt_ret21"] = ds.groupby("date")["ret21"].transform("median")
    ds["sector"] = ds["symbol"].map(sectors).fillna("Other")
    keys = [day, ds["sector"]]
    ds["sector_rel21"] = ds["ret21"] - ds["ret21"].groupby(keys).transform("median")
    up50 = (ds["dist_ema50"] > 0).astype(float).where(ds["dist_ema50"].notna())
    ds["sector_breadth50"] = up50.groupby(keys).transform("mean")
    return ds


def _index_features(index_df: pd.DataFrame) -> pd.DataFrame:
    c = index_df["close"]
    return pd.DataFrame({"idx_ret5": c.pct_change(5, fill_method=None), "idx_ret21": c.pct_change(21, fill_method=None),
                         "idx_dist_ema50": c / ema(c, 50) - 1, "idx_risk_off": (c < ema(c, 50)).astype(float)},
                        index=index_df.index)


def build_dataset(frames: dict[str, pd.DataFrame], index_df: pd.DataFrame, sectors: pd.Series, cfg: dict,
                  labels: bool = True, progress: Callable[[float, str], None] | None = None,
                  macro_raw: pd.DataFrame | None = None, events: pd.DataFrame | None = None) -> pd.DataFrame:
    """One row per stock per day with every feature (and the trade outcomes when labels=True).

    frames: OHLCV per symbol. Rows are marked `liquid` when the stock passed the liquidity/price/history rules
    that day: those are the only rows the model trains on or predicts for. macro_raw: db.load_macro (the Egypt
    features are empty without it). events: news.load_events (without it, every stock reads as having none).
    """
    say = progress or (lambda p, m: None)
    index_close = index_df["close"] if len(index_df) else None
    parts = []
    for i, (sym, df) in enumerate(frames.items()):
        if len(df) < 60:
            continue
        if i % 20 == 0:
            say(i / max(len(frames), 1), f"Preparing the price history ({i + 1}/{len(frames)} stocks)…")
        ind = add_indicators(df, index_close)
        f = stock_features(ind)
        rules = strategy.signal_frame(ind, cfg)
        f["symbol"] = sym
        f["close"] = ind["close"]
        f["value_avg20"] = ind["value_avg20"]
        f["rule_eligible"] = rules["eligible"].to_numpy()   # the scan's own rule, in today's EGP
        f["bars"] = ind["bars"]
        f["recent_jump"] = ind["recent_jump"].to_numpy()
        f["setup_on"] = rules["any_setup"].to_numpy()          # a setup the user's settings trade
        f["rule_base"] = rules["base_score"].to_numpy()
        # the chart's support/resistance plan on every day (levels.py), from the bars up to that day only
        lv = levels.frame(ind, cfg)
        f[LEVEL_FEATURES] = level_features(lv, ind["close"])
        chart = cfg.get("levels_mode") == "chart" and lv["stop"].notna()
        stop = np.where(chart, lv["stop"], rules["stop"])
        target = np.where(chart, lv["target"], rules["target"])
        f["rule_stop"], f["rule_target"] = stop, target
        if labels:
            for hz in ALL_HORIZONS:
                out = trade_outcomes(ind, cfg, hz, stop, target)
                f[f"hit{hz}"] = out["hit"]
                f[f"ret{hz}_trade"] = out["ret"]
            # the experiment's own result: bought at the next open, sold at the close EXPERIMENT sessions later
            fee = cfg["fee_pct_per_side"] / 100
            f[f"hold{EXPERIMENT}"] = (ind["close"].shift(-EXPERIMENT) * (1 - fee)
                                      / (ind["open"].shift(-1) * (1 + fee)) - 1).clip(-0.5, 1.0)
            # the entry day (the next session) had no volume or one price all day: an order couldn't have filled
            f["entry_locked"] = ((ind["high"] == ind["low"]) | (ind["volume"] <= 0)).shift(-1).astype(float)
        parts.append(f)
    if not parts:
        return pd.DataFrame()
    ds = pd.concat(parts).rename_axis("date").reset_index()
    ds["liquid"] = _liquid_then(ds, cfg)
    ds = _cross_section(ds, sectors)
    if len(index_df):
        ds = ds.join(_index_features(index_df), on="date")
    else:
        ds = ds.assign(idx_ret5=np.nan, idx_ret21=np.nan, idx_dist_ema50=np.nan, idx_risk_off=np.nan)
    days = pd.DatetimeIndex(np.sort(ds["date"].unique()))
    index_close = index_df["close"] if len(index_df) else pd.Series(dtype=float)
    raw = macro_raw if macro_raw is not None else pd.DataFrame()
    ds = ds.join(macro.features(raw, index_close, days), on="date")
    ds[news.EVENT_FEATURES] = news.event_features(ds, events)
    # the rules' own BUY decision on each day, to compare the model with
    ds["rule_rank"] = ds["ret63"].where(ds["liquid"]).groupby(ds["date"]).rank(pct=True).fillna(0)
    ds["rule_score"] = np.clip(ds["rule_base"] + ds["rule_rank"] * 25, 0, 100)
    risk_off = ds["idx_risk_off"].fillna(0).astype(bool)
    thr = np.where(risk_off, strategy.buy_threshold(cfg, True), strategy.buy_threshold(cfg, False))
    ds["rule_buy"] = ds["liquid"] & ds["rule_eligible"] & ds["setup_on"] & (ds["rule_score"] >= thr)
    ds[ALL_FEATURES] = ds[ALL_FEATURES].astype("float32")
    return ds


# ------------------------------------------------------------------ the model

RANK_GROUPS = ((0.9, 1.0, "Top 10%"), (0.7, 0.9, "Next 20%"), (0.5, 0.7, "Middle 20%"), (0.0, 0.5, "Bottom half"))
AGREE_RANK = 0.8   # "the model agrees" with a rule BUY when it ranks the stock in that day's top 20%


def new_model(n_rows: int = 200_000, hz: int = 10):
    """Cautious settings (small trees, big leaves, strong regularisation): market data is noisy, and a model that
    fits the past closely is over-confident about the future. Tested against looser settings walk-forward.

    Both are LightGBM: gradient-boosted trees like scikit-learn's, but it copes with a feature that is empty for a
    whole training period (EGX70 only starts in 2017), which scikit-learn's version can't."""
    from lightgbm import LGBMClassifier
    leaf = int(np.clip(n_rows // 100, 200, 1500))
    return LGBMClassifier(learning_rate=0.03, n_estimators=300, num_leaves=15, min_child_samples=leaf,
                          reg_lambda=5.0, subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
                          random_state=7, verbose=-1)


def _auc(y: np.ndarray, p: np.ndarray) -> float | None:
    from sklearn.metrics import roc_auc_score
    return float(roc_auc_score(y, p)) if len(np.unique(y)) == 2 else None


def _group(df: pd.DataFrame, hz: int) -> dict:
    n = int(len(df))
    return {"n": n, "hit": float(df[f"hit{hz}"].mean()) if n else None,
            "ret": float(df[f"ret{hz}_trade"].mean()) if n else None}


def walk_forward(ds: pd.DataFrame, hz: int,
                 progress: Callable[[float, str], None] | None = None) -> tuple[pd.DataFrame, list[dict]]:
    """Predict each year with a model trained only on the years before it. Returns the out-of-sample rows."""
    say = progress or (lambda p, m: None)
    y_col = f"hit{hz}"
    data = ds[ds["liquid"] & ds[y_col].notna()]
    days = np.sort(data["date"].unique())
    if not len(days):
        return pd.DataFrame(), []
    first = pd.Timestamp(days[0]) + pd.DateOffset(years=MIN_TRAIN_YEARS)
    test_years = [y for y in sorted(pd.DatetimeIndex(days).year.unique()) if y >= first.year]
    oos, folds = [], []
    for k, year in enumerate(test_years):
        start = max(pd.Timestamp(year=year, month=1, day=1), first)
        pos = int(np.searchsorted(days, np.datetime64(start)))
        if pos >= len(days):
            continue
        cutoff = days[max(pos - hz - 1, 0)]          # every training trade is over before testing starts
        train = data[data["date"] <= cutoff]
        test = data[(data["date"] >= days[pos]) & (data["date"].dt.year == year)]
        if "entry_locked" in test:
            test = test[test["entry_locked"] != 1]   # an order couldn't have filled: not a real trade to score
        if len(test) < 200 or train[y_col].nunique() < 2:
            continue
        say(k / len(test_years), f"{hz}-session model: testing {year} with a model trained on "
                                 f"{pd.Timestamp(days[0]).year}–{pd.Timestamp(cutoff).year} only…")
        feats = HORIZON_FEATURES[hz]
        m = new_model(len(train), hz).fit(train[feats], train[y_col])
        extra = [c for c in (f"hold{hz}", "breadth50") if c in test]    # the experiment's result; the switch
        t = test[["date", "symbol", y_col, f"ret{hz}_trade", "rule_buy", *extra]].copy()
        t["prob"] = m.predict_proba(test[feats])[:, 1]
        oos.append(t)
        folds.append({"year": int(year), "train_from": str(pd.Timestamp(days[0]).date()),
                      "train_to": str(pd.Timestamp(cutoff).date()), "train_n": int(len(train))})
    return (pd.concat(oos) if oos else pd.DataFrame()), folds


def evaluate(oos: pd.DataFrame, hz: int, top: float = 0.10) -> dict:
    """How the out-of-sample predictions did: overall, per year, by daily rank, and next to the rules' BUYs."""
    if oos.empty:
        return {}
    y = f"hit{hz}"
    oos = oos.copy()
    oos["day_rank"] = oos.groupby("date")["prob"].rank(pct=True)
    oos["year"] = oos["date"].dt.year

    def block(df: pd.DataFrame) -> dict:
        rule = df[df["rule_buy"]]
        return {"all": _group(df, hz), "top": _group(df[df["day_rank"] > 1 - top], hz), "rule": _group(rule, hz),
                "rule_agree": _group(rule[rule["day_rank"] > AGREE_RANK], hz),
                "rule_disagree": _group(rule[rule["day_rank"] <= AGREE_RANK], hz),
                "auc": _auc(df[y].to_numpy(), df["prob"].to_numpy())}

    years = [{"year": int(yr), **block(g)} for yr, g in oos.groupby("year") if len(g) >= 1000]
    groups = [{"label": label, **_group(oos[(oos["day_rank"] > lo) & (oos["day_rank"] <= hi)], hz)}
              for lo, hi, label in RANK_GROUPS]
    overall = block(oos)
    hold = f"hold{hz}"
    if hold in oos:                                   # the experiment: plain 5-session holds
        top_rows = oos[oos["day_rank"] > 1 - top]
        overall["hold"] = {"all": float(oos[hold].mean()), "top": float(top_rows[hold].mean())}
    ret_col = hold if hold in oos else f"ret{hz}_trade"
    overall.update(top_ret_cost=(overall["top"]["ret"] - EXTRA_COST) if overall["top"]["ret"] is not None else None,
                   portfolio=portfolio(oos, hz, ret_col), portfolio_cost=portfolio(oos, hz, ret_col, EXTRA_COST),
                   chances=chance_quality(oos, hz), extra_cost=EXTRA_COST)
    auc = overall["auc"] or 0.5
    base, top_hit = overall["all"]["hit"], overall["top"]["hit"]
    lift = top_hit / base if base else None
    good_years = sum(1 for yr in years if (yr["top"]["hit"] or 0) > (yr["all"]["hit"] or 0))
    if auc >= 0.58 and (lift or 0) >= 1.3 and good_years >= len(years) - 1:
        grade, text = "good", "Useful: its top picks beat the average stock clearly, and almost every year."
    elif auc >= 0.54 and (lift or 0) >= 1.1:
        grade, text = "weak", "A small edge: its top picks do better than average, but not by much or not every year."
    else:
        grade, text = "none", "No real edge: its picks don't do better than a random liquid stock. Treat it as noise."
    return {**overall, "years": years, "groups": groups, "top_share": top, "lift": lift, "good_years": good_years,
            "grade": grade, "verdict": text, "from": str(oos["date"].min().date()), "to": str(oos["date"].max().date())}


def portfolio(oos: pd.DataFrame, hz: int, col: str, cost: float = 0.0) -> dict:
    """The model's own test portfolio: every hz sessions its top PICKS stocks, bought equally, at the size the
    breadth market switch allows (none, half or full: breadth.switch), each trade's result in `col` minus `cost`.
    Averaged over the hz possible starting days. {cagr, max_drawdown, sharpe}, or {} without enough days."""
    if oos.empty:
        return {}
    o = oos.assign(r=oos.groupby("date")["prob"].rank(ascending=False, method="first"))
    picks = o[o["r"] <= PICKS].groupby("date")[col].mean() - cost
    size = (o.groupby("date")["breadth50"].first().map(lambda b: (breadth.switch(b) or {"size": 1.0})["size"])
            if "breadth50" in o else pd.Series(1.0, index=picks.index))
    days = np.sort(o["date"].unique())
    runs = []
    for off in range(hz):
        d = days[off::hz]
        if len(d) < 10:
            continue
        r = picks.reindex(d).fillna(0.0).to_numpy() * size.reindex(d).fillna(1.0).to_numpy()
        eq = np.cumprod(1 + r)
        years = (pd.Timestamp(d[-1]) - pd.Timestamp(d[0])).days / 365.25
        if years <= 0:
            continue
        sd = r.std()
        runs.append((eq[-1] ** (1 / years) - 1, float((eq / np.maximum.accumulate(eq) - 1).min()),
                     float(r.mean() / sd * np.sqrt(len(d) / years)) if sd > 0 else 0.0))
    if not runs:
        return {}
    cagr, dd, sharpe = np.mean(runs, axis=0)
    return {"cagr": float(cagr), "max_drawdown": float(dd), "sharpe": float(sharpe)}


def chance_quality(oos: pd.DataFrame, hz: int) -> dict:
    """Are its chances better than saying "every stock has last year's average chance"? Each test year is
    calibrated only on the years before it (as the live model is), then scored with the Brier score (the average
    squared miss; lower is better). useful = clearly better than the plain average."""
    from sklearn.isotonic import IsotonicRegression
    y = f"hit{hz}"
    years = sorted(oos["date"].dt.year.unique())
    said, base, got = [], [], []
    for i, yr in enumerate(years[1:], 1):
        past = oos[oos["date"].dt.year < yr]
        cur = oos[oos["date"].dt.year == yr]
        iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip").fit(past["prob"], past[y])
        said.append(iso.predict(cur["prob"]))
        base.append(np.full(len(cur), past[past["date"].dt.year == years[i - 1]][y].mean()))
        got.append(cur[y].to_numpy())
    if not said:
        return {}
    s, b, g = np.concatenate(said), np.concatenate(base), np.concatenate(got).astype(float)
    brier, brier_base = float(np.mean((s - g) ** 2)), float(np.mean((b - g) ** 2))
    skill = 1 - brier / brier_base if brier_base else 0.0
    return {"brier": brier, "brier_base": brier_base, "skill": skill, "useful": bool(skill >= 0.005)}


def model_picks_mask(rank: pd.DataFrame, eligible: pd.DataFrame, trend: pd.DataFrame, risk_off: pd.Series,
                     n: int) -> pd.DataFrame:
    """The model's own BUYs each day: its n best-ranked stocks that also pass the rules' liquidity and uptrend
    checks, and none while EGX30 is under its 50-day average (the rules' own market switch). The scan does the same
    for today (scan.run_scan)."""
    if n <= 0:
        return pd.DataFrame(False, index=rank.index, columns=rank.columns)
    top = rank.rank(axis=1, ascending=False, method="first") <= n
    return (top & (rank > 0) & eligible & trend).mul(~risk_off.reindex(rank.index).fillna(False), axis=0).astype(bool)


def combo_backtest(conn: sqlite3.Connection, cfg: dict, frames: dict, index_df: pd.DataFrame,
                   oos: pd.DataFrame) -> dict:
    """The agent's BUY rules replayed day by day (backtest.run) on the years the model was tested on, with its
    walk-forward scores only, so it never saw those days: the rules alone, the rules in the model's order, and
    the rules plus its own picks (config model_picks). Also each half of the period, to show it isn't one lucky run."""
    from . import backtest

    stocks = universe.stock_table(conn, cfg.get("egx33_extra"))
    prep = backtest.prepare({s: f for s, f in frames.items() if s in stocks.index}, index_df, stocks, cfg, conn)
    dates, cols = prep.buy.index, prep.buy.columns
    rank = (oos.assign(pct=oos.groupby("date")["prob"].rank(pct=True))
            .pivot_table(index="date", columns="symbol", values="pct").reindex(index=dates, columns=cols).fillna(0.0))
    eligible = pd.DataFrame({s: prep.sf[s]["eligible"].reindex(dates) for s in cols}).fillna(False).astype(bool)
    trend = pd.DataFrame({s: prep.sf[s]["trend_ok"].reindex(dates) for s in cols}).fillna(False).astype(bool)
    n = int(cfg.get("model_picks", 3))
    order = rank * 1000 + prep.score / 100          # the model's rank first, the rules' score between equals
    picks = model_picks_mask(rank, eligible, trend, prep.risk_off, n)
    start, end = oos["date"].min(), oos["date"].max()
    mid = start + (end - start) / 2
    out = {"from": str(start.date()), "to": str(end.date()), "split": str(mid.date()), "picks": n}
    for key, kw in (("rules", {}), ("ordered", {"order": order}), ("with_picks", {"order": order, "buy": prep.buy | picks})):
        res = {}
        for part, s, e in (("all", start, end), ("first", start, mid), ("second", mid, end)):
            r = backtest.run(prep, cfg, s, e, **kw)
            m, eq = r["metrics"], r["equity"]
            daily = eq.pct_change().dropna()
            res[part] = {"cagr": m["cagr"], "max_drawdown": m["max_drawdown"], "trades": m["trades"],
                         "win_rate": m.get("win_rate"), "sharpe": float(daily.mean() / daily.std() * np.sqrt(245))
                         if daily.std() > 0 else 0.0}
        out[key] = res
    return out


def ret_calibrator(oos: pd.DataFrame, hz: int):
    """The model's raw score → what trades it scored like that averaged in its tests (after fees): the Predict page's
    Expected. Walk-forward in 2026-09, also using each stock's stop and target width to re-rank did worse than its own
    score (top 10% +0.39% a trade against +0.76%), so the expected result follows the score only."""
    from sklearn.isotonic import IsotonicRegression
    col = f"ret{hz}_trade"
    if oos.empty or col not in oos:
        return None
    ok = oos[col].notna()
    return IsotonicRegression(out_of_bounds="clip").fit(oos.loc[ok, "prob"], oos.loc[ok, col])


def calibrator(oos: pd.DataFrame, hz: int):
    """Turns the model's raw score into an honest chance, learnt from how often each score really hit (out of sample)."""
    from sklearn.isotonic import IsotonicRegression
    if oos.empty:
        return None
    return IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip").fit(oos["prob"], oos[f"hit{hz}"])


# ------------------------------------------------------------------ training, saving, predicting

def model_dir(conn: sqlite3.Connection) -> Path:
    """Models live next to the database they were trained from (data/models for the real one)."""
    row = conn.execute("PRAGMA database_list").fetchone()
    return Path(row[2]).parent / "models" if row and row[2] else MODEL_DIR   # (seq, name, file)


def model_path(root: Path = MODEL_DIR) -> Path:
    return root / "prediction.joblib"


def meta_path(root: Path = MODEL_DIR) -> Path:
    return root / "prediction.json"


def load_meta(root: Path = MODEL_DIR) -> dict | None:
    p = meta_path(root)
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
    except (OSError, ValueError):
        return None


def load_models(root: Path = MODEL_DIR) -> dict | None:
    p = model_path(root)
    if not p.exists():
        return None
    import joblib
    try:
        return joblib.load(p)
    except Exception:  # an unreadable or incompatible file: the user retrains
        return None


def settings_changed(meta: dict | None, cfg: dict) -> list[str]:
    """Settings that change the stop/target (or which stocks count as liquid) since the model was trained."""
    if not meta:
        return []
    used = meta.get("settings", {})
    same = lambda a, b: str(a) == str(b) if isinstance(a, str) or isinstance(b, str) else float(a) == float(b)
    return [k for k in LEVEL_KEYS if k in used and k in cfg and not same(used[k], cfg[k])]


def age_days(meta: dict | None, today: date | None = None) -> int | None:
    if not meta:
        return None
    return ((today or date.today()) - date.fromisoformat(meta["trained_at"][:10])).days


def egypt_data_ready(conn: sqlite3.Connection) -> bool:
    """Every Egypt series has been downloaded (the scan does it; so does training when it's missing)."""
    names = list(macro.SERIES)
    return conn.execute(f"SELECT COUNT(DISTINCT series) FROM macro WHERE series IN ({','.join('?' * len(names))})",
                        names).fetchone()[0] >= len(names)


def events_data_ready(conn: sqlite3.Connection) -> bool:
    """Mubasher's dividend and bonus-share history has been downloaded (the scan does it)."""
    return conn.execute("SELECT COUNT(*) FROM corp_actions").fetchone()[0] > 0


def needs_training(conn: sqlite3.Connection, cfg: dict, today: date | None = None) -> bool:
    """True when an existing model is a month old, the trade settings changed, the model's design changed since
    (MODEL_VERSION), or it was trained without the Egypt data or the dividend events and they are here now. The first training is yours."""
    root = model_dir(conn)
    meta = load_meta(root)
    if not meta or not model_path(root).exists():
        return False
    return (age_days(meta, today) >= RETRAIN_DAYS or bool(settings_changed(meta, cfg))
            or meta.get("version", 1) != MODEL_VERSION
            # trained before the 5-session experiment and the rules-with-the-model replay were added (2026-09)
            or str(EXPERIMENT) not in meta.get("horizons", {}) or "combo" not in meta
            or (not meta.get("egypt_data", True) and egypt_data_ready(conn))
            or (not meta.get("events_data", True) and events_data_ready(conn)))


def load_frames(conn: sqlite3.Connection, cfg: dict) -> tuple[dict, pd.DataFrame, pd.Series]:
    table = universe.stock_table(conn, cfg.get("egx33_extra"))
    frames = prices.load_all(conn, list(table.index))
    return frames, db.load_prices(conn, prices.INDEX_SYMBOL), table["sector"]


def train(conn: sqlite3.Connection, cfg: dict, progress: Callable[[float, str], None] | None = None,
          root: Path | None = None) -> dict:
    """Test walk-forward, then fit the final models on all the history and save them."""
    import joblib
    import sklearn

    root = root or model_dir(conn)
    say = progress or (lambda p, m: None)
    say(0.01, "Loading price history…")
    frames, index_df, sectors = load_frames(conn, cfg)
    ds = build_dataset(frames, index_df, sectors, cfg, progress=lambda p, m: say(0.02 + 0.13 * p, m),
                       macro_raw=db.load_macro(conn), events=news.load_events(conn))
    if ds.empty or not ds["liquid"].any():
        raise RuntimeError("Not enough price history to train on. Run a scan first.")
    liquid = ds[ds["liquid"]]
    span = (liquid["date"].max() - liquid["date"].min()).days / 365.25
    if span < MIN_TRAIN_YEARS + 1:
        raise RuntimeError(f"Only {span:.1f} years of liquid price history; the model needs at least "
                           f"{MIN_TRAIN_YEARS + 1}.")
    results, models, calibrators, ret_cals, tested = {}, {}, {}, {}, {}
    for j, hz in enumerate(ALL_HORIZONS):
        base = 0.15 + 0.24 * j
        oos, folds = walk_forward(ds, hz, lambda p, m: say(base + 0.2 * p, m))
        tested[hz] = oos
        results[str(hz)] = {**evaluate(oos, hz), "folds": folds}
        calibrators[hz] = calibrator(oos, hz)
        ret_cals[hz] = ret_calibrator(oos, hz)
        say(base + 0.21, f"{hz}-session model: training the final version on all the history…")
        rows = liquid[liquid[f"hit{hz}"].notna()]
        models[hz] = new_model(len(rows), hz).fit(rows[HORIZON_FEATURES[hz]], rows[f"hit{hz}"])
        results[str(hz)].update(train_n=int(len(rows)), features=len(HORIZON_FEATURES[hz]))
    say(0.88, "Replaying the BUY rules with and without the model on its test years…")
    try:
        combo = combo_backtest(conn, cfg, frames, index_df, tested[RANK_HORIZON])
    except Exception as exc:  # the model still works; the Predict page just can't show this comparison
        combo = {"error": f"{type(exc).__name__}: {exc}"}
    root.mkdir(parents=True, exist_ok=True)
    tmp = model_path(root).with_suffix(".tmp")
    joblib.dump({"models": models, "calibrators": calibrators, "ret_calibrators": ret_cals,
                 "features": dict(HORIZON_FEATURES),
                 "sklearn": sklearn.__version__}, tmp)
    tmp.replace(model_path(root))
    before = load_meta(root) or {}
    data_to = str(liquid["date"].max().date())
    meta = {
        "version": MODEL_VERSION, "egypt_data": egypt_data_ready(conn), "events_data": events_data_ready(conn),
        # the live track record counts predictions from this model design only, not an older one's
        "live_since": before.get("live_since", data_to) if before.get("version") == MODEL_VERSION else data_to,
        "trained_at": datetime.now().isoformat(timespec="seconds"),
        "data_from": str(liquid["date"].min().date()), "data_to": data_to,
        "stocks": int(liquid["symbol"].nunique()), "rows": int(len(liquid)), "sklearn": sklearn.__version__,
        "settings": {k: cfg[k] for k in LEVEL_KEYS if k in cfg}, "horizons": results, "combo": combo,
    }
    meta_path(root).write_text(json.dumps(meta, default=float), encoding="utf-8")
    say(0.98, "Predicting the latest session…")
    predict_latest(conn, cfg, root=root, ds=ds)
    return meta


def predict_latest(conn: sqlite3.Connection, cfg: dict, root: Path | None = None,
                   ds: pd.DataFrame | None = None) -> int:
    """Score every liquid stock on the latest session and store it. Returns how many stocks were scored."""
    bundle = load_models(root or model_dir(conn))
    if not bundle:
        return 0
    if ds is None:
        frames, index_df, sectors = load_frames(conn, cfg)
        ds = build_dataset(frames, index_df, sectors, cfg, labels=False, macro_raw=db.load_macro(conn),
                           events=news.load_events(conn))
    if ds.empty:
        return 0
    day = ds["date"].max()
    rows = ds[(ds["date"] == day) & ds["liquid"]]
    if rows.empty:
        return 0
    raw, chance, why, exp = {}, {}, {}, {}
    for hz, m in bundle["models"].items():
        feats = bundle["features"]
        feats = feats[hz] if isinstance(feats, dict) else feats   # models saved before version 2 had one list
        raw[hz] = m.predict_proba(rows[feats])[:, 1]
        cal = bundle.get("calibrators", {}).get(hz)
        chance[hz] = cal.predict(raw[hz]) if cal is not None else raw[hz]
        rcal = bundle.get("ret_calibrators", {}).get(hz)     # models trained before 2026-09-30 have none
        exp[hz] = rcal.predict(raw[hz]) if rcal is not None else [None] * len(rows)
        try:
            why[hz] = explain(m, rows[feats])
        except Exception:  # an older model file: the chances still work
            why[hz] = [None] * len(rows)
    day_s = str(day.date())
    now = datetime.now().isoformat(timespec="seconds")
    recs = []
    for i, r in enumerate(rows.itertuples(index=False)):
        for hz in raw:
            recs.append((day_s, r.symbol, int(hz), float(chance[hz][i]), float(raw[hz][i]), float(r.close),
                         float(1 - r.rule_stop / r.close), float(r.rule_target / r.close - 1), now, why[hz][i],
                         None if exp[hz][i] is None else float(exp[hz][i])))
    conn.execute("DELETE FROM predictions WHERE date=? AND resolved IS NULL", (day_s,))
    conn.executemany(
        """INSERT OR REPLACE INTO predictions(date, symbol, horizon, prob, raw, close, stop_pct, target_pct, created, why,
           exp_ret) VALUES (?,?,?,?,?,?,?,?,?,?,?)""", recs)
    conn.commit()
    db.set_meta(conn, "prediction_date", day_s)
    db.set_meta(conn, "prediction_updated", now)
    return len(rows)


def why_text(name: str, v) -> str:
    """One measure and its value in plain words, e.g. "3-month change +24%"."""
    label, kind = WHY_TEXT[name]
    if kind is None or v is None or not np.isfinite(v):
        return label
    if kind in ("days_ahead", "days_ago") and v >= news.NONE_DAYS / 2:
        return f"{label}: none"
    return {
        "pct": lambda: f"{label} {v:+.0%}" if abs(v) >= 0.095 else f"{label} {v:+.1%}",
        "pct1": lambda: f"{label} {v:.1%}",
        "signed": lambda: f"{label} {v:+.0f}",
        "num": lambda: f"{label} {v:.0f}",
        "int": lambda: f"{label}: {v:.0f}",
        "x": lambda: f"{label} {v:.1f}×",
        "share": lambda: f"{label}: {v:.0%}",
        "rank": lambda: f"{label}: top {max(1, round((1 - v) * 100))}%" if v >= 0.5
        else f"{label}: bottom {max(1, round(v * 100))}%",
        "yes": lambda: f"{label}: {'yes' if v >= 0.5 else 'no'}",
        "days_ahead": lambda: f"{label}: in {v:.0f} days",
        "days_ago": lambda: f"{label}: {v:.0f} days ago",
    }[kind]()


def explain(model, X: pd.DataFrame) -> list[str]:
    """Why the model scored each stock as it did: the measures that pushed its score up most (WHY_UP) and down
    most (WHY_DOWN), from the trees themselves (LightGBM's per-measure contributions, the same idea as SHAP).
    Whole-market measures are left out: they move every stock alike. One JSON list per row."""
    contrib = model.predict(X, pred_contrib=True)          # one column per measure, then the starting value
    names = list(X.columns)
    keep = [i for i, n in enumerate(names) if n in WHY_TEXT]
    out = []
    for c, vals in zip(contrib, X.to_numpy(dtype=float)):
        ranked = sorted((c[i], i) for i in keep)
        ups = [(v, i) for v, i in reversed(ranked) if v > 0.01][:WHY_UP]
        downs = [(v, i) for v, i in ranked if v < -0.01][:WHY_DOWN]
        out.append(json.dumps([{"f": names[i], "up": bool(v > 0), "text": why_text(names[i], vals[i])}
                               for v, i in ups + downs], ensure_ascii=False))
    return out


def _replay(after: pd.DataFrame, entry: float, stop: float, target: float, horizon: int, fee: float):
    """The outcome of one stored prediction, or None while it is still running (same rules as trade_outcomes)."""
    for i, bar in enumerate(after.itertuples(index=False)):
        if i == 0 and bar.open >= target:
            return 1, bar.open
        if bar.low <= stop:
            return 0, min(stop, bar.open)
        if bar.high >= target:
            return 1, max(target, bar.open)
    if len(after) >= horizon:
        return 0, float(after["close"].iloc[-1])
    return None


def resolve(conn: sqlite3.Connection, cfg: dict) -> int:
    """Fill in what actually happened to past predictions once they're decided (the live track record)."""
    pending = pd.read_sql_query("SELECT date, symbol, horizon, stop_pct, target_pct FROM predictions "
                                "WHERE resolved IS NULL", conn)
    if pending.empty:
        return 0
    fee = cfg["fee_pct_per_side"] / 100
    done = 0
    for sym, group in pending.groupby("symbol"):
        px = db.load_prices(conn, sym)
        for r in group.itertuples(index=False):
            d = pd.Timestamp(r.date)
            if d not in px.index:
                continue
            base = float(px.at[d, "close"])     # today's prices, so a later bonus-share re-base doesn't break it
            after = px.loc[px.index > d].head(int(r.horizon))
            if after.empty:
                continue
            stop, target = base * (1 - r.stop_pct), base * (1 + r.target_pct)
            first = after.iloc[0]
            entry = float(first["open"])
            if int(r.horizon) == EXPERIMENT:        # the paper experiment: sold at the close 5 sessions later
                if first["high"] == first["low"] or first["volume"] <= 0:
                    hit, ret, status = None, None, "cancelled"
                elif len(after) < EXPERIMENT:
                    continue
                else:
                    ret = float(after["close"].iloc[EXPERIMENT - 1]) * (1 - fee) / (entry * (1 + fee)) - 1
                    hit, status = int(ret > 0), "done"
            elif entry <= stop or first["high"] == first["low"] or first["volume"] <= 0:
                # the order would not have been placed, or couldn't have filled (no trading, or locked all day)
                hit, ret, status = None, None, "cancelled"
            else:
                res = _replay(after, entry, stop, target, int(r.horizon), fee)
                if res is None:
                    continue
                hit, exit_px = res
                ret, status = exit_px * (1 - fee) / (entry * (1 + fee)) - 1, "done"
            conn.execute("UPDATE predictions SET hit=?, ret=?, resolved=? WHERE date=? AND symbol=? AND horizon=?",
                         (hit, ret, status, r.date, r.symbol, int(r.horizon)))
            done += 1
    conn.commit()
    return done


def latest(conn: sqlite3.Connection) -> pd.DataFrame:
    """The most recent stored predictions: one row per stock with p10/p20 (chance) and rank10/rank20 (1 = best)."""
    day = db.get_meta(conn, "prediction_date")
    if not day:
        return pd.DataFrame()
    df = pd.read_sql_query("SELECT symbol, horizon, prob, raw, close, stop_pct, target_pct, exp_ret FROM predictions "
                           "WHERE date=?", conn, params=(day,))
    if df.empty:
        return df
    df["rank"] = df.groupby("horizon")["raw"].rank(ascending=False, method="min")
    wide = df.pivot_table(index="symbol", columns="horizon", values=["prob", "rank", "exp_ret"], dropna=False)
    wide.columns = [f"{ {'prob': 'p', 'rank': 'rank', 'exp_ret': 'exp'}[k]}{hz}" for k, hz in wide.columns]
    out = df.drop_duplicates("symbol").set_index("symbol")[["close", "stop_pct", "target_pct"]].join(wide)
    out["date"] = day
    return out


def live_record(conn: sqlite3.Connection, top: float = 0.10, since: str | None = None) -> dict:
    """How predictions made since the model went live turned out (from `since`: this model design's first day).
    A day counts once all its trades are decided."""
    df = pd.read_sql_query("SELECT date, symbol, horizon, raw, hit, ret, resolved FROM predictions WHERE date >= ?",
                           conn, params=(since or "",))
    out = {}
    for hz in ALL_HORIZONS:
        g = df[df["horizon"] == hz]
        open_days = set(g.loc[g["resolved"].isna(), "date"])
        g = g[~g["date"].isin(open_days) & (g["resolved"] == "done")].copy()
        if g.empty:
            out[str(hz)] = {"n": 0, "pending_days": len(open_days)}
            continue
        g["day_rank"] = g.groupby("date")["raw"].rank(pct=True)
        t = g[g["day_rank"] > 1 - top]
        p = g[g.groupby("date")["raw"].rank(ascending=False, method="first") <= PICKS]
        out[str(hz)] = {
            "n": int(len(g)), "days": int(g["date"].nunique()), "pending_days": len(open_days),
            "from": g["date"].min(), "to": g["date"].max(),
            "all": {"n": int(len(g)), "hit": float(g["hit"].mean()), "ret": float(g["ret"].mean())},
            "top": {"n": int(len(t)), "hit": float(t["hit"].mean()) if len(t) else None,
                    "ret": float(t["ret"].mean()) if len(t) else None},
            "picks": {"n": int(len(p)), "hit": float(p["hit"].mean()) if len(p) else None,     # its top 5 a day
                      "ret": float(p["ret"].mean()) if len(p) else None},
        }
    return out


RECENT_DAYS = 30   # "lately": the last 30 decided sessions
RECENT_TOP = 10    # its daily top 10, the rows Today's chances opens with


def recent_record(conn: sqlite3.Connection, since: str | None = None, days: int = RECENT_DAYS,
                  top: int = RECENT_TOP) -> dict:
    """Its daily top `top` over the last `days` sessions whose trades are all decided, per horizon: how many reached
    the target first, how many didn't, the average result, and the same average for every scored stock."""
    df = pd.read_sql_query("SELECT date, horizon, raw, hit, ret, resolved FROM predictions WHERE date >= ?",
                           conn, params=(since or "",))
    out = {}
    for hz in HORIZONS:
        g = df[df["horizon"] == hz]
        open_days = set(g.loc[g["resolved"].isna(), "date"])
        g = g[~g["date"].isin(open_days) & (g["resolved"] == "done")]
        last = sorted(g["date"].unique())[-days:]
        g = g[g["date"].isin(last)]
        if g.empty:
            out[str(hz)] = {"n": 0}
            continue
        t = g[g.groupby("date")["raw"].rank(ascending=False, method="first") <= top]
        out[str(hz)] = {"n": int(len(t)), "days": len(last), "from": last[0], "to": last[-1], "top": top,
                        "hits": int(t["hit"].sum()), "misses": int(len(t) - t["hit"].sum()),
                        "ret": float(t["ret"].mean()), "all_ret": float(g["ret"].mean())}
    return out


def ranks_for(conn: sqlite3.Connection, day: str, hz: int = RANK_HORIZON) -> dict[str, dict]:
    """The model's rank of each scored stock on `day`: {symbol: {rank (1 = best), of, pct (1.0 = best)}}."""
    df = pd.read_sql_query("SELECT symbol, raw FROM predictions WHERE date=? AND horizon=?", conn, params=(day, hz))
    if df.empty:
        return {}
    df["pct"] = df["raw"].rank(pct=True)
    df["rank"] = df["raw"].rank(ascending=False, method="first").astype(int)
    return {r.symbol: {"rank": int(r.rank), "of": len(df), "pct": float(r.pct)} for r in df.itertuples(index=False)}


HEALTH_DAYS = 60        # the live check looks at the last 60 decided sessions…
HEALTH_MIN_DAYS = 30    # …once there are at least this many


def health(conn: sqlite3.Connection, meta: dict | None = None) -> dict:
    """Is the model still doing live what it did in its tests? Its top 10% against all scored stocks over the last
    HEALTH_DAYS decided sessions (the 10-session model, the one that picks BUYs), next to the same gap in its tests.

    status: early (not enough days yet) | ok (at least half the tested edge) | weak (some edge, less than half) |
    bad (no edge: its picks did no better than the average stock). While it's bad the scan adds no model picks."""
    meta = meta if meta is not None else load_meta(model_dir(conn))
    hz = RANK_HORIZON
    test = ((meta or {}).get("horizons") or {}).get(str(hz)) or {}
    if not test.get("top"):
        return {"status": "none"}
    t_edge = (test["top"]["ret"] or 0) - (test["all"]["ret"] or 0)
    df = pd.read_sql_query("SELECT date, raw, ret, resolved FROM predictions WHERE horizon=? AND date >= ?", conn,
                           params=(hz, meta.get("live_since") or ""))
    open_days = set(df.loc[df["resolved"].isna(), "date"])
    df = df[~df["date"].isin(open_days) & (df["resolved"] == "done")]
    days = sorted(df["date"].unique())[-HEALTH_DAYS:]
    out = {"days": len(days), "tested_edge": t_edge, "window": HEALTH_DAYS, "min_days": HEALTH_MIN_DAYS}
    if len(days) < HEALTH_MIN_DAYS:
        return {**out, "status": "early"}
    g = df[df["date"].isin(days)].copy()
    g["day_rank"] = g.groupby("date")["raw"].rank(pct=True)
    top, avg = float(g.loc[g["day_rank"] > 0.9, "ret"].mean()), float(g["ret"].mean())
    edge = top - avg
    status = "bad" if edge <= 0 else "ok" if edge >= t_edge / 2 else "weak"
    return {**out, "status": status, "edge": edge, "top": top, "all": avg, "from": days[0], "to": days[-1]}
