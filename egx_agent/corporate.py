"""Bonus shares, splits and cash dividends on your positions.

EGX companies often hand out bonus shares. When they do, TradingView divides all past prices by the ratio
(÷1.25 for 1 free share for every 4 held). A position logged at the old prices would then look like a big
loss and could trigger a false stop-loss EXIT, so it is flagged until you confirm your new share count.
Paper trades are updated by themselves.
"""
from __future__ import annotations

import math
import sqlite3
from datetime import date
from fractions import Fraction

import pandas as pd


def describe(factor: float) -> str:
    """Plain words for a price ratio: 1.25 → '1 free share for every 4 you hold'."""
    if factor >= 1:
        if factor >= 2 and abs(factor - round(factor)) < 1e-6:
            return f"{round(factor)} shares for each 1 you held (split or bonus)"
        frac = Fraction(factor - 1).limit_denominator(20)
        if frac and abs(float(frac) - (factor - 1)) < 1e-6:
            k, n = frac.numerator, frac.denominator
            return f"{k} free share{'s' if k > 1 else ''} for every {n} you hold"
        return f"prices divided by {factor:.4g}"
    inv = 1 / factor
    if abs(inv - round(inv)) < 1e-6:
        return f"every {round(inv)} shares combined into 1"
    return f"prices multiplied by {inv:.4g}"


def expected_shares(shares: int, factor: float) -> int:
    """Your share count after the event; fractions of a share are usually paid out in cash, so round down."""
    return max(1, math.floor(shares * factor + 1e-6))


def pending(conn: sqlite3.Connection, account: str = "real") -> dict[int, dict]:
    """Open positions bought before their stock was re-based and not updated yet: {trade_id: event}."""
    rows = conn.execute(
        """SELECT t.id AS trade_id, e.id AS event_id, e.symbol, e.ex_date, e.factor, t.shares
           FROM trades t JOIN price_events e ON e.symbol = t.symbol
           WHERE t.account = ? AND t.status IN ('open', 'pending')
             AND COALESCE(t.entry_date, t.signal_date) < e.ex_date
             AND NOT EXISTS (SELECT 1 FROM position_adjustments a WHERE a.event_id = e.id AND a.trade_id = t.id)
           ORDER BY e.ex_date""",
        (account,),
    ).fetchall()
    out: dict[int, dict] = {}
    for r in rows:
        if r["trade_id"] not in out:  # oldest first; a second event shows after the first is handled
            out[r["trade_id"]] = {
                "event_id": r["event_id"], "symbol": r["symbol"], "ex_date": r["ex_date"], "factor": r["factor"],
                "describe": describe(r["factor"]), "shares_now": r["shares"],
                "shares_expected": expected_shares(r["shares"], r["factor"]),
            }
    return out


def apply(conn: sqlite3.Connection, trade_id: int, event_id: int, new_shares: int) -> dict:
    """Update a position to its new share count; prices and levels move by the same ratio, so its cost is unchanged."""
    t = conn.execute("SELECT * FROM trades WHERE id=? AND status IN ('open', 'pending')", (trade_id,)).fetchone()
    e = conn.execute("SELECT * FROM price_events WHERE id=?", (event_id,)).fetchone()
    if t is None or e is None or e["symbol"] != t["symbol"]:
        raise ValueError("This position or event no longer exists. Refresh the page.")
    new_shares = int(new_shares)
    if new_shares < 1:
        raise ValueError("Enter how many shares you hold now.")
    old = int(t["shares"])
    ratio = new_shares / old
    conn.execute(
        """UPDATE trades SET shares=?, entry_price=entry_price/?, initial_stop=initial_stop/?, stop=stop/?,
               target=target/?, highest_close=highest_close/?, entry_limit=entry_limit/? WHERE id=?""",
        (new_shares, ratio, ratio, ratio, ratio, ratio, ratio, trade_id),
    )
    today = date.today().isoformat()
    if t["account"] == "real":
        conn.execute(
            "INSERT INTO fills(trade_id, symbol, date, side, shares, price, fees, note) VALUES (?,?,?,?,?,?,?,?)",
            (trade_id, t["symbol"], e["ex_date"], "bonus", new_shares - old, 0.0, 0.0,
             f"{describe(e['factor'])}: {old:,} → {new_shares:,} shares"),
        )
    conn.execute(
        "INSERT OR REPLACE INTO position_adjustments(event_id, trade_id, action, ratio, date) VALUES (?,?,?,?,?)",
        (event_id, trade_id, "applied", ratio, today),
    )
    conn.commit()
    return {"symbol": t["symbol"], "old": old, "new": new_shares, "ratio": ratio,
            "avg": float(t["entry_price"]) / ratio if t["entry_price"] else None}


def ignore(conn: sqlite3.Connection, trade_id: int, event_id: int) -> None:
    """Your shares didn't change (for example, the price move wasn't a bonus issue): keep the position as it is."""
    conn.execute(
        "INSERT OR REPLACE INTO position_adjustments(event_id, trade_id, action, ratio, date) VALUES (?,?,?,?,?)",
        (event_id, trade_id, "ignored", None, date.today().isoformat()),
    )
    conn.commit()


def apply_paper(conn: sqlite3.Connection) -> int:
    """Update open and pending paper trades for every new bonus issue or split. Returns how many changed."""
    n = 0
    for trade_id, ev in pending(conn, "paper").items():
        apply(conn, trade_id, ev["event_id"], ev["shares_expected"])
        n += 1
    return n


# ------------------------------------------------------------------ cash dividends

def add_dividend(conn: sqlite3.Connection, trade_id: int, day: str, amount: float, note: str = "") -> dict:
    t = conn.execute("SELECT * FROM trades WHERE id=? AND account='real'", (trade_id,)).fetchone()
    if t is None:
        raise ValueError("Position not found.")
    if not amount > 0:
        raise ValueError("Enter the amount you received.")
    conn.execute(
        "INSERT INTO dividends(trade_id, symbol, date, shares, amount, note) VALUES (?,?,?,?,?,?)",
        (trade_id, t["symbol"], day, int(t["shares"]), float(amount), note),
    )
    conn.commit()
    return {"symbol": t["symbol"], "per_share": float(amount) / int(t["shares"])}


def delete_dividend(conn: sqlite3.Connection, dividend_id: int) -> sqlite3.Row | None:
    row = conn.execute("SELECT * FROM dividends WHERE id=?", (dividend_id,)).fetchone()
    if row is not None:
        conn.execute("DELETE FROM dividends WHERE id=?", (dividend_id,))
        conn.commit()
    return row


def dividends_by_trade(conn: sqlite3.Connection, account: str = "real") -> dict[int, float]:
    rows = conn.execute(
        """SELECT d.trade_id, SUM(d.amount) AS amount FROM dividends d JOIN trades t ON t.id = d.trade_id
           WHERE t.account=? GROUP BY d.trade_id""",
        (account,),
    ).fetchall()
    return {int(r["trade_id"]): float(r["amount"]) for r in rows}


def dividends_df(conn: sqlite3.Connection, trade_id: int) -> pd.DataFrame:
    return pd.read_sql_query("SELECT * FROM dividends WHERE trade_id=? ORDER BY date, id", conn, params=(trade_id,))
