"""Position sizing and portfolio limits."""
from __future__ import annotations

import math
from collections import Counter


def size_position(entry: float, stop: float, equity: float, cash: float, avg_value20: float,
                  open_risk: float, cfg: dict) -> dict:
    """Shares so that hitting the stop loses at most risk_per_trade_pct of equity, then apply caps."""
    per_share = entry - stop
    if per_share <= 0 or entry <= 0:
        return {"shares": 0, "amount": 0.0, "risk_egp": 0.0, "size_note": "invalid stop"}
    budget = equity * cfg["risk_per_trade_pct"] / 100
    note = f"{cfg['risk_per_trade_pct']:g}% risk rule"
    heat_left = equity * cfg["max_open_risk_pct"] / 100 - open_risk
    if heat_left < budget:
        budget = max(0.0, heat_left)
        note = f"reduced: total open risk limit ({cfg['max_open_risk_pct']:g}%)"
    shares = math.floor(budget / per_share)
    fee = cfg["fee_pct_per_side"] / 100
    caps = {
        f"max {cfg['max_position_pct']:g}% of account per stock": equity * cfg["max_position_pct"] / 100 / entry,
        f"liquidity: {cfg['max_pct_of_adv']:g}% of daily traded value": avg_value20 * cfg["max_pct_of_adv"] / 100 / entry,
        "available cash": cash / (entry * (1 + fee)),
    }
    for name, cap in caps.items():
        if math.floor(cap) < shares:
            shares, note = math.floor(cap), f"capped by {name}"
    shares = max(0, int(shares))
    return {"shares": shares, "amount": shares * entry, "risk_egp": shares * per_share, "size_note": note}


def open_risk(positions: list[dict]) -> float:
    """Money lost if every open position hit its stop now (locked-in stops count as zero)."""
    return sum(max(0.0, p["entry_price"] - p["stop"]) * p["shares"] for p in positions)


def allocate(candidates: list[dict], equity: float, cash: float, positions: list[dict], cfg: dict,
             risk_off: bool) -> list[dict]:
    """Size candidates best-score-first while respecting slots, sector limits, total risk and cash.

    candidates: dicts with symbol, sector, close, stop, avg_value (sorted by score, best first).
    positions: open (and pending) positions with symbol, sector, entry_price, stop, shares.
    """
    max_pos = max(1, cfg["max_positions"] // 2) if risk_off else cfg["max_positions"]
    slots = max_pos - len(positions)
    sectors = Counter(p.get("sector") for p in positions)
    held = {p["symbol"] for p in positions}
    risk_now = open_risk(positions)
    fee = cfg["fee_pct_per_side"] / 100
    out = []
    for c in candidates:
        res = dict(c)
        if c["symbol"] in held:
            res.update(shares=0, amount=0.0, risk_egp=0.0, size_note="already in your portfolio")
        elif slots <= 0:
            res.update(shares=0, amount=0.0, risk_egp=0.0,
                       size_note=f"portfolio full ({max_pos} positions{' in risk-off mode' if risk_off else ''})")
        elif sectors[c.get("sector")] >= cfg["max_per_sector"]:
            res.update(shares=0, amount=0.0, risk_egp=0.0,
                       size_note=f"already {cfg['max_per_sector']} positions in {c.get('sector')}")
        else:
            res.update(size_position(c["close"], c["stop"], equity, cash, c["avg_value"], risk_now, cfg))
            if res["shares"] > 0:
                slots -= 1
                sectors[c.get("sector")] += 1
                cash -= res["amount"] * (1 + fee)
                risk_now += res["risk_egp"]
        out.append(res)
    return out
