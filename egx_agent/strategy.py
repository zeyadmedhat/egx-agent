"""Entry signals for 2–4 week swing trades.

signal_frame() is vectorised over a whole price history so the daily scan (last row) and the
backtest (every row) run exactly the same rules. The relative-strength part of the score needs the
whole market, so it is added separately with rs_rank() + score().
"""
from __future__ import annotations

import numpy as np
import pandas as pd

SETUP_LABELS = {"breakout": "Breakout", "pullback": "Pullback to 20-day avg", "macd": "Momentum turn (MACD)"}


def initial_stop(close, atr, cfg: dict):
    """Entry minus N×ATR, kept between stop_min_pct and stop_max_pct below entry."""
    pct = np.clip(cfg["atr_stop_mult"] * np.asarray(atr) / np.asarray(close), cfg["stop_min_pct"] / 100, cfg["stop_max_pct"] / 100)
    return np.asarray(close) * (1 - pct)


def signal_frame(ind: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    c = ind["close"]
    sf = pd.DataFrame(index=ind.index)
    sf["eligible"] = (
        (ind["bars"] >= cfg["min_history_bars"])
        & (ind["value_avg20"] >= cfg["min_avg_value_egp"])
        & (c >= cfg["min_price"])
        & ~ind["recent_jump"]
    )
    trend = (c > ind["ema50"]) & (ind["ema20"] > ind["ema50"])
    sf["trend_ok"] = trend
    sf["breakout"] = trend & (c > ind["high20_prev"]) & (ind["vol_ratio"] >= 1.5) & (ind["adx14"] > 20)
    sf["pullback"] = (
        trend
        & (ind["low3"] <= ind["ema20"] * 1.01)
        & (c > ind["ema20"])
        & ind["rsi14"].between(40, 55)
        & (ind["rsi14"] > ind["rsi14"].shift())
        & (c > ind["open"])
    )
    sf["macd"] = (
        trend
        & (ind["macd"] > ind["macd_signal"])
        & (ind["macd"].shift() <= ind["macd_signal"].shift())
        & (ind["rsi14"] < 70)
    )
    for name in SETUP_LABELS:
        if name not in cfg.get("setups", SETUP_LABELS):
            sf[name] = False
    n_setups = sf[["breakout", "pullback", "macd"]].sum(axis=1)
    sf["any_setup"] = n_setups > 0
    sf["setup"] = np.select(
        [sf["breakout"], sf["pullback"], sf["macd"]],
        [SETUP_LABELS["breakout"], SETUP_LABELS["pullback"], SETUP_LABELS["macd"]],
        default="",
    )

    sf["stop"] = initial_stop(c, ind["atr14"], cfg)
    risk = c - sf["stop"]
    sf["target"] = c + cfg["target_r"] * risk
    sf["entry_high"] = c + 0.25 * ind["atr14"]

    # Score parts (max 25 + 20 + 15 + 15 = 75 here; relative strength adds up to 25 later)
    sf["pts_trend"] = np.clip((ind["adx14"] - 15) / 20, 0, 1) * 15 + np.clip(ind["ema20_slope"] / 0.03, 0, 1) * 10
    sf["pts_volume"] = (
        np.clip((ind["vol_ratio"] - 0.8) / 1.0, 0, 1) * 10 + np.clip((ind["updown_vol"] - 0.8) / 0.8, 0, 1) * 10
    )
    setup_pts = np.select([sf["breakout"], sf["pullback"], sf["macd"]], [15, 12, 10], default=0)
    sf["pts_setup"] = np.minimum(setup_pts + np.where(n_setups >= 2, 3, 0), 15)
    room_r = (ind["high120_prev"] - c) / risk
    sf["room_r"] = room_r
    sf["pts_room"] = np.where(c >= ind["high120_prev"], 15, np.clip(room_r / 2, 0, 1) * 15)
    extended = (c / ind["ema20"] - 1 > 0.12) | (ind["rsi14"] > 75)
    sf["penalty"] = np.where(extended, 10, 0)
    sf["base_score"] = (sf["pts_trend"] + sf["pts_volume"] + sf["pts_setup"] + sf["pts_room"] - sf["penalty"]).fillna(0)
    return sf


def rs_rank(ret63: pd.Series) -> pd.Series:
    """Percentile rank (0–1) of 3-month return among the given stocks."""
    return ret63.rank(pct=True)


def score(base_score, rank_pct):
    return np.clip(np.asarray(base_score) + np.nan_to_num(np.asarray(rank_pct, dtype=float)) * 25, 0, 100)


def buy_threshold(cfg: dict, risk_off: bool) -> float:
    """Minimum score for a BUY. In risk-off markets it rises, or blocks new buys entirely."""
    if risk_off and cfg.get("riskoff_block_buys"):
        return float("inf")
    return cfg["buy_score"] + (cfg["riskoff_score_bonus"] if risk_off else 0)


def is_risk_off(index_ind_row: pd.Series) -> bool:
    return bool(index_ind_row["close"] < index_ind_row["ema50"])


def explain(ind_row: pd.Series, sf_row: pd.Series, rank_pct: float) -> list[str]:
    """Plain-English reasons for a signal."""
    c = ind_row["close"]
    out = []
    if sf_row["breakout"]:
        out.append(
            f"Closed at {c:.2f}, above its 20-day high of {ind_row['high20_prev']:.2f}, "
            f"on {ind_row['vol_ratio']:.1f}× normal volume"
        )
    if sf_row["pullback"]:
        out.append(f"Dipped to its 20-day average ({ind_row['ema20']:.2f}) and bounced; RSI turning up at {ind_row['rsi14']:.0f}")
    if sf_row["macd"]:
        out.append("MACD just crossed above its signal line: momentum is turning up")
    strength = "strong" if ind_row["adx14"] >= 25 else "moderate" if ind_row["adx14"] >= 20 else "weak"
    out.append(f"Uptrend: price above its 20- and 50-day averages; ADX {ind_row['adx14']:.0f} ({strength} trend)")
    if pd.notna(ind_row.get("ret63")):
        vs = ""
        if pd.notna(ind_row.get("index_ret63")):
            vs = f" vs EGX30 {ind_row['index_ret63']:+.0%}"
        out.append(f"3-month return {ind_row['ret63']:+.0%}{vs}; stronger than {rank_pct:.0%} of liquid EGX stocks")
    if pd.notna(ind_row.get("updown_vol")):
        if ind_row["updown_vol"] >= 1.2:
            out.append(f"Accumulation: {ind_row['updown_vol']:.1f}× more volume on up days than down days (20 days)")
        elif ind_row["updown_vol"] < 0.9:
            out.append(f"Caution: more volume on down days than up days ({ind_row['updown_vol']:.1f}×)")
    if c >= ind_row["high120_prev"]:
        out.append("At a 6-month high: no overhead resistance nearby")
    elif pd.notna(sf_row["room_r"]):
        out.append(f"Room to the 6-month high ({ind_row['high120_prev']:.2f}): {sf_row['room_r']:.1f}× the risk")
    if sf_row["penalty"]:
        ext = c / ind_row["ema20"] - 1
        out.append(f"Caution: stretched ({ext:+.0%} vs 20-day avg, RSI {ind_row['rsi14']:.0f}); a dip entry is safer")
    stop_pct = 1 - sf_row["stop"] / c
    tgt_pct = sf_row["target"] / c - 1
    out.append(f"Plan: stop {sf_row['stop']:.2f} ({stop_pct:.1%} below), target {sf_row['target']:.2f} (+{tgt_pct:.1%})")
    return out
