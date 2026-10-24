"""Daily portfolio backtest using the same signals, sizing and exit rules as the live agent.

Signals are computed on day t's close; orders fill at day t+1's open. Fees apply on both sides. Cash dividends are
paid on the ex-date to positions held the day before, and the stop and target move down by them that day (as the
live rules do, engine.ex_dividend).
Caveats: the universe is today's listed stocks (survivorship bias) and Shariah status is today's.
"""
from __future__ import annotations

import math
import sqlite3
from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import breadth, engine, levels, risk, strategy
from .data import dividends, shariah
from .indicators import add_indicators


@dataclass
class Prepared:
    ind: dict[str, pd.DataFrame]
    sf: dict[str, pd.DataFrame]
    index_ind: pd.DataFrame
    score: pd.DataFrame
    buy: pd.DataFrame
    risk_off: pd.Series
    sectors: dict[str, str]


def _panel(frames: dict[str, pd.Series], dates: pd.DatetimeIndex, fill=np.nan) -> pd.DataFrame:
    return pd.DataFrame({s: f.reindex(dates) for s, f in frames.items()}, index=dates).fillna(fill) if frames else pd.DataFrame(index=dates)


def prepare(price_data: dict[str, pd.DataFrame], index_df: pd.DataFrame, stocks: pd.DataFrame, cfg: dict,
            conn: sqlite3.Connection | None = None) -> Prepared:
    """conn: where the cash dividends are (data/dividends.py); without it, none are paid."""
    index_ind = add_indicators(index_df)
    ind = {s: add_indicators(df, index_df["close"]) for s, df in price_data.items() if len(df) > 60}
    if conn is not None:
        for s, f in ind.items():
            f["div"] = dividends.per_share(conn, s, f["close"])
    sf = {s: strategy.signal_frame(ind[s], cfg) for s in ind}
    # Stop and target from the chart (levels.py) on every day the stock could be bought: a setup, or a model pick.
    # With stop_follows_support, also the support under the close on every day a position could still be held (it
    # closed above its 50-day average), which an open position's stop rises to (engine.update_after_close).
    for s, f in sf.items():
        buyable = (f["any_setup"] | (f["eligible"] & f["trend_ok"])).to_numpy()
        held = (ind[s]["close"] >= ind[s]["ema50"]).to_numpy() if levels.follows_support(cfg) else False
        lv = levels.frame(ind[s], cfg, buyable | held) if cfg.get("levels_mode", "atr") == "chart" else None
        sf[s] = levels.apply(ind[s], f, cfg, buyable, lv)
        if levels.follows_support(cfg):
            ind[s]["sup"] = lv["sup"].to_numpy()
    dates = index_ind.index
    eligible = _panel({s: f["eligible"].astype(float) for s, f in sf.items()}, dates, 0.0).astype(bool)
    setup = _panel({s: f["any_setup"].astype(float) for s, f in sf.items()}, dates, 0.0).astype(bool)
    ret63 = _panel({s: ind[s]["ret63"] for s in ind}, dates)
    base = _panel({s: f["base_score"] for s, f in sf.items()}, dates, 0.0)
    rank = ret63.where(eligible).rank(axis=1, pct=True).fillna(0.0)
    score = (base + rank * 25).clip(0, 100)
    # a weak market, no new BUYs: EGX30 under its 50-day average, or too few stocks above theirs (breadth.switch)
    above50 = breadth.above50_daily(_panel({s: ind[s]["close"] for s in ind}, dates))
    risk_off = (index_ind["close"] < index_ind["ema50"]) | (above50 < breadth.SWITCH_OFF_BELOW)
    thr = pd.Series(np.where(risk_off, strategy.buy_threshold(cfg, True), strategy.buy_threshold(cfg, False)), index=dates)
    info = stocks.to_dict("index")
    allowed = pd.Series({s: shariah.passes_filter(info.get(s, {}), cfg["shariah_filter"]) for s in score.columns}, dtype=bool)
    buy = eligible & setup & score.ge(thr, axis=0) & allowed.reindex(score.columns).fillna(False).astype(bool)
    sectors = {s: info.get(s, {}).get("sector", "Other") for s in ind}
    return Prepared(ind, sf, index_ind, score, buy, risk_off, sectors)


def run(prep: Prepared, cfg: dict, start: str | pd.Timestamp, end: str | pd.Timestamp | None = None,
        symbols: set[str] | None = None, buy: pd.DataFrame | None = None, order: pd.DataFrame | None = None) -> dict:
    """buy: which stocks are BUYs each day (default: the rules', prep.buy). order: who gets money first each day,
    highest first (default: the rules' score). The prediction model's walk-forward test passes both
    (predict.combo_backtest)."""
    fee = cfg["fee_pct_per_side"] / 100
    capital = float(cfg["capital"])
    dates = prep.index_ind.index
    dates = dates[(dates >= pd.Timestamp(start)) & (dates <= pd.Timestamp(end or dates[-1]))]
    buy_mask = prep.buy if buy is None else buy
    priority = prep.score if order is None else order
    cash = capital
    positions: dict[str, engine.Position] = {}
    scores: dict[str, float] = {}             # each open position's signal score (record.odds_from_trades)
    paid: dict[str, float] = {}               # dividends each open position has been paid
    pending: list[dict] = []
    last_close: dict[str, float] = {}
    trades, equity, n_pos, cancelled = [], [], [], 0

    def close_position(sym: str, d: pd.Timestamp, price: float, reason: str) -> None:
        nonlocal cash
        pos = positions.pop(sym)
        got = paid.pop(sym, 0.0)
        proceeds = price * pos.shares * (1 - fee)
        cost = pos.entry_price * pos.shares * (1 + fee)
        cash += proceeds
        trades.append({
            "symbol": sym, "sector": pos.sector, "entry_date": pos.entry_date, "entry_price": pos.entry_price,
            "exit_date": str(d.date()), "exit_price": price, "shares": pos.shares, "days_held": pos.days_held,
            "pnl": proceeds + got - cost, "return_pct": (proceeds + got) / cost - 1, "reason": reason,
            "dividends": got, "score": scores.pop(sym, None),
        })

    for i, d in enumerate(dates):
        for sym, pos in positions.items():        # held at yesterday's close: today's ex-dividend is paid
            ind_s = prep.ind[sym]
            if d in ind_s.index and (div := engine.bar_dividend(ind_s.loc[d])):
                cash += div * pos.shares
                paid[sym] = paid.get(sym, 0.0) + div * pos.shares
        filled_today = set()
        for order_ in pending:
            ind_s = prep.ind[order_["symbol"]]
            if d not in ind_s.index:
                cancelled += 1
                continue
            bar = ind_s.loc[d]
            pos, _ = engine.fill_order(order_, bar)
            if pos is None:
                cancelled += 1
                continue
            max_affordable = math.floor(cash / (pos.entry_price * (1 + fee)))
            pos.shares = min(pos.shares, max_affordable)
            if pos.shares <= 0:
                cancelled += 1
                continue
            cash -= pos.entry_price * pos.shares * (1 + fee)
            positions[pos.symbol] = pos
            scores[pos.symbol] = order_.get("score")
            filled_today.add(pos.symbol)
            res = engine.process_bar(pos, bar, cfg)
            if res:
                close_position(pos.symbol, d, *res)
        pending = []

        for sym in list(positions):
            if sym in filled_today:
                continue
            ind_s = prep.ind[sym]
            if d not in ind_s.index:
                continue
            res = engine.process_bar(positions[sym], ind_s.loc[d], cfg)
            if res:
                close_position(sym, d, *res)

        for sym in positions:
            ind_s = prep.ind[sym]
            if d in ind_s.index:
                last_close[sym] = float(ind_s.at[d, "close"])
        eq = cash + sum(p.shares * last_close.get(s, p.entry_price) for s, p in positions.items())
        equity.append(eq)
        n_pos.append(len(positions))

        if i == len(dates) - 1:
            break
        row = buy_mask.loc[d]
        syms = [s for s in row.index[row.values] if symbols is None or s in symbols]
        if not syms:
            continue
        cands = []
        for s in sorted(syms, key=lambda s: -priority.at[d, s]):
            ind_row, sf_row = prep.ind[s].loc[d], prep.sf[s].loc[d]
            cands.append({
                "symbol": s, "sector": prep.sectors.get(s, "Other"), "close": float(ind_row["close"]),
                "stop": float(sf_row["stop"]), "target": float(sf_row["target"]),
                "entry_limit": float(sf_row["entry_high"]), "avg_value": float(ind_row["value_avg20"]),
                "score": float(prep.score.at[d, s]),
            })
        held = [{"symbol": s, "sector": p.sector, "entry_price": p.entry_price, "stop": p.stop, "shares": p.shares}
                for s, p in positions.items()]
        for a in risk.allocate(cands, eq, cash, held, cfg, bool(prep.risk_off.loc[d])):
            if a["shares"] > 0:
                pending.append(a)

    open_at_end = []
    for sym, p in positions.items():
        px = last_close.get(sym, p.entry_price)
        open_at_end.append({"symbol": sym, "entry_date": p.entry_date, "entry_price": p.entry_price,
                            "last_close": px, "shares": p.shares, "unrealized_pct": px / p.entry_price - 1})

    eq = pd.Series(equity, index=dates, name="equity")
    tdf = pd.DataFrame(trades)
    idx = prep.index_ind["close"].reindex(dates)
    return {
        "equity": eq,
        "index_equity": capital * idx / idx.iloc[0],
        "trades": tdf,
        "open_at_end": pd.DataFrame(open_at_end),
        "metrics": metrics(eq, tdf, n_pos, capital, idx, cancelled),
    }


def metrics(eq: pd.Series, trades: pd.DataFrame, n_pos: list[int], capital: float, idx: pd.Series,
            cancelled: int) -> dict:
    years = max((eq.index[-1] - eq.index[0]).days / 365.25, 1 / 365.25)
    final = float(eq.iloc[-1])
    dd = eq / eq.cummax() - 1
    m = {
        "final_equity": final,
        "total_return": final / capital - 1,
        "cagr": (final / capital) ** (1 / years) - 1 if final > 0 else -1.0,
        "max_drawdown": float(dd.min()),
        "egx30_return": float(idx.iloc[-1] / idx.iloc[0] - 1),
        "trades": int(len(trades)),
        "exposure": float(np.mean([n > 0 for n in n_pos])),
        "orders_cancelled": cancelled,
    }
    if len(trades):
        wins, losses = trades[trades.pnl > 0], trades[trades.pnl <= 0]
        m.update({
            "win_rate": len(wins) / len(trades),
            "avg_win": float(wins.return_pct.mean()) if len(wins) else 0.0,
            "avg_loss": float(losses.return_pct.mean()) if len(losses) else 0.0,
            "profit_factor": float(wins.pnl.sum() / -losses.pnl.sum()) if losses.pnl.sum() < 0 else float("inf"),
            "avg_days_held": float(trades.days_held.mean()),
            "dividends": float(trades.dividends.sum()),
        })
    return m
