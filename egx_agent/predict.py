"""Prediction model: the chance that a trade bought at the next open reaches its target before its stop.

The trade uses the agent's own plan: the stop is entry − 2×ATR (kept 4–12% below) and the target is +2R, both
set from the signal day's close, exactly like a BUY card. "Target before stop" must happen within 10 or 20
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

from . import config, db, strategy
from .data import macro, prices, universe
from .indicators import add_indicators, ema

HORIZONS = (10, 20)
MODEL_VERSION = 2             # 2: Egypt data for the 20-session model; untradeable entry days left out of results
MIN_TRAIN_YEARS = 3           # the first tested year needs at least this much history before it
RETRAIN_DAYS = 30
MODEL_DIR = config.ROOT / "data" / "models"
LEVEL_KEYS = ("atr_stop_mult", "stop_min_pct", "stop_max_pct", "target_r", "fee_pct_per_side", "min_avg_value_egp")
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
# Walk-forward in 2026-09: Egypt data lifted the 20-session model's top picks (and in more years); the 10-session
# model did no better with it, so it keeps the stock features only.
HORIZON_FEATURES = {10: FEATURES, 20: FEATURES + macro.FEATURES}
ALL_FEATURES = FEATURES + macro.FEATURES


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


def trade_outcomes(ind: pd.DataFrame, cfg: dict, horizon: int) -> pd.DataFrame:
    """For every day t: buy at t+1's open with the stop/target set at t's close; what happened within `horizon` sessions?

    hit = 1 if the target was reached before the stop, 0 if not (stop first, both on one day, or time ran out),
    NaN while the outcome isn't known yet or the order would have been cancelled (opened below the stop).
    ret = the trade's result after fees: exit at the target, the stop (or a worse gap), or the last close.
    """
    c = ind["close"].to_numpy(float)
    o, hi, lo = (ind[k].to_numpy(float) for k in ("open", "high", "low"))
    n = len(c)
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
                  macro_raw: pd.DataFrame | None = None) -> pd.DataFrame:
    """One row per stock per day with every feature (and the trade outcomes when labels=True).

    frames: OHLCV per symbol. Rows are marked `liquid` when the stock passed the liquidity/price/history rules
    that day: those are the only rows the model trains on or predicts for. macro_raw: db.load_macro (the Egypt
    features are empty without it).
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
        f["rule_stop"] = rules["stop"].to_numpy()
        f["rule_target"] = rules["target"].to_numpy()
        if labels:
            for hz in HORIZONS:
                out = trade_outcomes(ind, cfg, hz)
                f[f"hit{hz}"] = out["hit"]
                f[f"ret{hz}_trade"] = out["ret"]
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

    The 20-session model is LightGBM: the same kind of model, but it copes with a feature that is empty for a whole
    training period (EGX70 only starts in 2017), which scikit-learn's version can't."""
    leaf = int(np.clip(n_rows // 100, 200, 1500))
    if hz == 20:
        from lightgbm import LGBMClassifier
        return LGBMClassifier(learning_rate=0.03, n_estimators=300, num_leaves=15, min_child_samples=leaf,
                              reg_lambda=5.0, subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
                              random_state=7, verbose=-1)
    from sklearn.ensemble import HistGradientBoostingClassifier
    return HistGradientBoostingClassifier(learning_rate=0.03, max_iter=200, max_leaf_nodes=15,
                                          min_samples_leaf=leaf, l2_regularization=5.0, random_state=7)


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
        t = test[["date", "symbol", y_col, f"ret{hz}_trade", "rule_buy"]].copy()
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
    return [k for k in LEVEL_KEYS if k in used and float(used[k]) != float(cfg[k])]


def age_days(meta: dict | None, today: date | None = None) -> int | None:
    if not meta:
        return None
    return ((today or date.today()) - date.fromisoformat(meta["trained_at"][:10])).days


def needs_training(conn: sqlite3.Connection, cfg: dict, today: date | None = None) -> bool:
    """True when an existing model is a month old, the trade settings changed, or the model's design changed since
    (MODEL_VERSION). The first training is yours."""
    root = model_dir(conn)
    meta = load_meta(root)
    if not meta or not model_path(root).exists():
        return False
    return (age_days(meta, today) >= RETRAIN_DAYS or bool(settings_changed(meta, cfg))
            or meta.get("version", 1) != MODEL_VERSION)


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
                       macro_raw=db.load_macro(conn))
    if ds.empty or not ds["liquid"].any():
        raise RuntimeError("Not enough price history to train on. Run a scan first.")
    liquid = ds[ds["liquid"]]
    span = (liquid["date"].max() - liquid["date"].min()).days / 365.25
    if span < MIN_TRAIN_YEARS + 1:
        raise RuntimeError(f"Only {span:.1f} years of liquid price history; the model needs at least "
                           f"{MIN_TRAIN_YEARS + 1}.")
    results, models, calibrators = {}, {}, {}
    for j, hz in enumerate(HORIZONS):
        base = 0.15 + 0.41 * j
        oos, folds = walk_forward(ds, hz, lambda p, m: say(base + 0.35 * p, m))
        results[str(hz)] = {**evaluate(oos, hz), "folds": folds}
        calibrators[hz] = calibrator(oos, hz)
        say(base + 0.36, f"{hz}-session model: training the final version on all the history…")
        rows = liquid[liquid[f"hit{hz}"].notna()]
        models[hz] = new_model(len(rows), hz).fit(rows[HORIZON_FEATURES[hz]], rows[f"hit{hz}"])
        results[str(hz)].update(train_n=int(len(rows)), features=len(HORIZON_FEATURES[hz]))
    root.mkdir(parents=True, exist_ok=True)
    tmp = model_path(root).with_suffix(".tmp")
    joblib.dump({"models": models, "calibrators": calibrators, "features": dict(HORIZON_FEATURES),
                 "sklearn": sklearn.__version__}, tmp)
    tmp.replace(model_path(root))
    before = load_meta(root) or {}
    data_to = str(liquid["date"].max().date())
    meta = {
        "version": MODEL_VERSION,
        # the live track record counts predictions from this model design only, not an older one's
        "live_since": before.get("live_since", data_to) if before.get("version") == MODEL_VERSION else data_to,
        "trained_at": datetime.now().isoformat(timespec="seconds"),
        "data_from": str(liquid["date"].min().date()), "data_to": data_to,
        "stocks": int(liquid["symbol"].nunique()), "rows": int(len(liquid)), "sklearn": sklearn.__version__,
        "settings": {k: cfg[k] for k in LEVEL_KEYS}, "horizons": results,
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
        ds = build_dataset(frames, index_df, sectors, cfg, labels=False, macro_raw=db.load_macro(conn))
    if ds.empty:
        return 0
    day = ds["date"].max()
    rows = ds[(ds["date"] == day) & ds["liquid"]]
    if rows.empty:
        return 0
    raw, chance = {}, {}
    for hz, m in bundle["models"].items():
        feats = bundle["features"]
        feats = feats[hz] if isinstance(feats, dict) else feats   # models saved before version 2 had one list
        raw[hz] = m.predict_proba(rows[feats])[:, 1]
        cal = bundle.get("calibrators", {}).get(hz)
        chance[hz] = cal.predict(raw[hz]) if cal is not None else raw[hz]
    day_s = str(day.date())
    now = datetime.now().isoformat(timespec="seconds")
    recs = []
    for i, r in enumerate(rows.itertuples(index=False)):
        for hz in raw:
            recs.append((day_s, r.symbol, int(hz), float(chance[hz][i]), float(raw[hz][i]), float(r.close),
                         float(1 - r.rule_stop / r.close), float(r.rule_target / r.close - 1), now))
    conn.execute("DELETE FROM predictions WHERE date=? AND resolved IS NULL", (day_s,))
    conn.executemany(
        """INSERT OR REPLACE INTO predictions(date, symbol, horizon, prob, raw, close, stop_pct, target_pct, created)
           VALUES (?,?,?,?,?,?,?,?,?)""", recs)
    conn.commit()
    db.set_meta(conn, "prediction_date", day_s)
    db.set_meta(conn, "prediction_updated", now)
    return len(rows)


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
            if entry <= stop or first["high"] == first["low"] or first["volume"] <= 0:
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
    df = pd.read_sql_query("SELECT symbol, horizon, prob, raw, close, stop_pct, target_pct FROM predictions "
                           "WHERE date=?", conn, params=(day,))
    if df.empty:
        return df
    df["rank"] = df.groupby("horizon")["raw"].rank(ascending=False, method="min")
    wide = df.pivot_table(index="symbol", columns="horizon", values=["prob", "rank"])
    wide.columns = [f"{'p' if k == 'prob' else 'rank'}{hz}" for k, hz in wide.columns]
    out = df.drop_duplicates("symbol").set_index("symbol")[["close", "stop_pct", "target_pct"]].join(wide)
    out["date"] = day
    return out


def live_record(conn: sqlite3.Connection, top: float = 0.10, since: str | None = None) -> dict:
    """How predictions made since the model went live turned out (from `since`: this model design's first day).
    A day counts once all its trades are decided."""
    df = pd.read_sql_query("SELECT date, symbol, horizon, raw, hit, ret, resolved FROM predictions WHERE date >= ?",
                           conn, params=(since or "",))
    out = {}
    for hz in HORIZONS:
        g = df[df["horizon"] == hz]
        open_days = set(g.loc[g["resolved"].isna(), "date"])
        g = g[~g["date"].isin(open_days) & (g["resolved"] == "done")].copy()
        if g.empty:
            out[str(hz)] = {"n": 0, "pending_days": len(open_days)}
            continue
        g["day_rank"] = g.groupby("date")["raw"].rank(pct=True)
        t = g[g["day_rank"] > 1 - top]
        out[str(hz)] = {
            "n": int(len(g)), "days": int(g["date"].nunique()), "pending_days": len(open_days),
            "from": g["date"].min(), "to": g["date"].max(),
            "all": {"n": int(len(g)), "hit": float(g["hit"].mean()), "ret": float(g["ret"].mean())},
            "top": {"n": int(len(t)), "hit": float(t["hit"].mean()) if len(t) else None,
                    "ret": float(t["ret"].mean()) if len(t) else None},
        }
    return out
