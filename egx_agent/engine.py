"""Trade management rules shared by the backtest, paper trading and the real-portfolio tracker.

Day counting: the entry day is day 1. Close-based exits (trend break, time stop) are decided at the
close and executed at the next open. Stops and targets are intraday: if the open gaps past the level
the fill is the open, otherwise the level itself.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import pandas as pd


@dataclass
class Position:
    symbol: str
    entry_date: str
    entry_price: float
    shares: int
    initial_stop: float
    stop: float
    target: float
    highest_close: float
    days_held: int = 0
    exit_next_open: str | None = None
    sector: str = ""

    @property
    def r(self) -> float:
        return self.entry_price - self.initial_stop

    def to_dict(self) -> dict:
        return asdict(self)


def _stop_label(pos: Position) -> str:
    if pos.stop > pos.entry_price * 1.0005:
        return "Trailing stop"
    if pos.stop >= pos.entry_price * 0.9995:
        return "Breakeven stop"
    return "Stop-loss"


def fill_order(order: dict, bar: pd.Series) -> tuple[Position | None, str]:
    """Fill a next-day buy order at the open, unless the open already broke the plan."""
    o = float(bar["open"])
    if o <= order["stop"]:
        return None, f"cancelled: opened at {o:.2f}, below the stop {order['stop']:.2f}"
    if o > order["entry_limit"]:
        return None, f"cancelled: gapped up to {o:.2f}, above the entry limit {order['entry_limit']:.2f} (not chasing)"
    pos = Position(
        symbol=order["symbol"], entry_date=str(bar.name.date()), entry_price=o, shares=int(order["shares"]),
        initial_stop=float(order["stop"]), stop=float(order["stop"]), target=float(order["target"]),
        highest_close=o, sector=order.get("sector", ""),
    )
    return pos, "filled"


def ex_dividend(pos: Position, amount: float) -> None:
    """The stock goes ex-dividend today: its price drops by `amount` a share, which the holder gets in cash, so the
    stop, the target and the highest close so far move down by it too. Otherwise the drop alone could hit the stop.
    Tested on 2016–2026: dividends paid plus this took the rules from 13.6% to 14.8% a year."""
    pos.stop -= amount
    pos.target -= amount
    pos.highest_close -= amount


def bar_dividend(bar: pd.Series) -> float:
    """The cash dividend per share going ex on this bar (the `div` column: data/dividends.per_share), else 0."""
    div = bar.get("div", 0.0) if hasattr(bar, "get") else 0.0
    return float(div) if div == div and div and div > 0 else 0.0   # div == div: not NaN


def process_bar(pos: Position, bar: pd.Series, cfg: dict) -> tuple[float, str] | None:
    """Advance a position through one daily bar. Returns (exit_price, reason) when it exits."""
    if pos.exit_next_open:
        return float(bar["open"]), pos.exit_next_open
    pos.days_held += 1
    if pos.days_held >= 2 and (div := bar_dividend(bar)):   # held at the close before: the dividend is ours
        ex_dividend(pos, div)
    o, h, l, c = (float(bar[k]) for k in ("open", "high", "low", "close"))
    if o <= pos.stop:
        return o, f"{_stop_label(pos)} (gap down)"
    if l <= pos.stop:
        return pos.stop, _stop_label(pos)
    if o >= pos.target:
        return o, "Target reached (gap up)"
    if h >= pos.target:
        return pos.target, "Target reached"
    update_after_close(pos, bar, cfg)
    return None


def update_after_close(pos: Position, bar: pd.Series, cfg: dict) -> None:
    """End-of-day bookkeeping: raise the stop and flag close-based exits for the next open.

    With stop_follows_support, the stop also rises to just under the nearest solid support below the close, when the
    bar has one (`sup`, levels.with_support), and never goes down. Walk-forward 2016–2026 (the model's test years):
    the BUY rules made 20.4% a year against 13.4% with the stop fixed until the price gains 1× the risk (worst drop
    −18.7% against −20.3%); with the model's picks, as the site runs, 31.8% against 22.3% (worst drop −25.2% against
    −22.7%). Better in both halves. A plain daily 2×ATR trail made 16.4% (rules), so most of it is the supports.

    Once the trade has gained 1× its risk, the stop goes no lower than the entry plus breakeven_pct (config.py)."""
    c = float(bar["close"])
    pos.highest_close = max(pos.highest_close, c)
    if pos.highest_close >= pos.entry_price + pos.r:
        trail = pos.highest_close - cfg["atr_stop_mult"] * float(bar["atr14"])
        pos.stop = max(pos.stop, pos.entry_price * (1 + cfg.get("breakeven_pct", 0.0) / 100), trail)
    sup = bar.get("sup", float("nan")) if cfg.get("stop_follows_support") else float("nan")
    if sup == sup and sup > pos.stop:     # sup == sup: not NaN
        pos.stop = float(sup)
    if c < float(bar["ema50"]):
        pos.exit_next_open = "Trend break (closed below 50-day average)"
    elif pos.days_held >= cfg["max_hold_days"]:
        pos.exit_next_open = f"Max hold reached ({cfg['max_hold_days']} trading days)"


def replay_status(pos: Position, ind: pd.DataFrame, cfg: dict) -> dict:
    """Status for a real trade: replay every bar after the entry day and report what the rules say now.

    pos must be a fresh Position (days_held=0). ind is the stock's indicator frame.
    """
    entry_ts = pd.Timestamp(pos.entry_date)
    entry_bar = ind.loc[ind.index == entry_ts]
    pos.days_held = 1
    if len(entry_bar):
        update_after_close(pos, entry_bar.iloc[0], cfg)
    after = ind.loc[ind.index > entry_ts]
    prev_stop = pos.stop
    for ts, bar in after.iterrows():
        prev_stop = pos.stop
        if pos.exit_next_open:
            return {"status": "EXIT", "reason": f"{pos.exit_next_open}: sell at the open (flagged before {ts.date()})",
                    "stop": pos.stop, "days_held": pos.days_held, "event_date": str(ts.date())}
        res = process_bar(pos, bar, cfg)
        if res:
            price, reason = res
            return {"status": "EXIT", "reason": f"{reason} on {ts.date()} at {price:.2f}",
                    "stop": pos.stop, "days_held": pos.days_held, "event_date": str(ts.date())}
    last = ind.index[-1].date() if len(ind) else None
    if pos.exit_next_open:
        return {"status": "EXIT", "reason": f"{pos.exit_next_open}: sell at the next open",
                "stop": pos.stop, "days_held": pos.days_held, "event_date": str(last)}
    if pos.days_held >= cfg["review_day"] and pos.highest_close < pos.entry_price + pos.r:
        return {"status": "REVIEW",
                "reason": f"Day {pos.days_held}: no +1R move yet (needs {pos.entry_price + pos.r:.2f}). Consider exiting.",
                "stop": pos.stop, "days_held": pos.days_held, "event_date": str(last)}
    if pos.stop > prev_stop + 1e-9:
        return {"status": "TIGHTEN STOP", "reason": f"Raise your stop to {pos.stop:.2f}",
                "stop": pos.stop, "prev_stop": prev_stop, "days_held": pos.days_held, "event_date": str(last)}
    return {"status": "HOLD", "reason": f"Stop {pos.stop:.2f}, target {pos.target:.2f}",
            "stop": pos.stop, "days_held": pos.days_held, "event_date": str(last)}
