"""Bonus shares, splits and cash dividends on your positions.

EGX companies often hand out bonus shares. When they do, TradingView divides all past prices by the ratio
(÷1.25 for 1 free share for every 4 held). A position logged at the old prices would then look like a big
loss and could trigger a false stop-loss EXIT, so it is flagged until you confirm your new share count.
Paper trades are updated by themselves.

A rights issue re-bases the prices too (by the right's value), but the shares don't follow by themselves: holders
subscribe to new shares at the issue price, or sell their rights. So the share count is yours to give, with what
each new share cost.
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


# A re-base within a week of a rights issue's ex-date (data/news.py's corporate actions) was that rights issue.
RIGHTS_SQL = """EXISTS (SELECT 1 FROM corp_actions a WHERE a.symbol = e.symbol AND a.kind = 'rights'
                        AND ABS(julianday(a.effective) - julianday(e.ex_date)) <= 7)"""


def what(factor: float, rights: bool) -> str:
    return f"a rights issue, past prices divided by {factor:.4g}" if rights else describe(factor)


def events(conn: sqlite3.Connection) -> list[dict]:
    """Every re-base of past prices, oldest first, as the website's browser reads them (local/engine.js pending)."""
    return [{"id": f"{r['symbol']}:{r['ex_date']}", "symbol": r["symbol"], "ex_date": r["ex_date"],
             "factor": r["factor"], "rights": bool(r["rights"])}
            for r in conn.execute(f"SELECT e.symbol, e.ex_date, e.factor, {RIGHTS_SQL} AS rights "
                                  "FROM price_events e ORDER BY e.ex_date, e.id")]


def pending(conn: sqlite3.Connection, account: str = "real") -> dict[int, dict]:
    """Open positions bought before their stock was re-based and not updated yet: {trade_id: event}."""
    rows = conn.execute(
        f"""SELECT t.id AS trade_id, e.id AS event_id, e.symbol, e.ex_date, e.factor, t.shares, {RIGHTS_SQL} AS rights
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
            rights = bool(r["rights"])
            out[r["trade_id"]] = {
                "event_id": r["event_id"], "symbol": r["symbol"], "ex_date": r["ex_date"], "factor": r["factor"],
                "rights": rights, "describe": what(r["factor"], rights), "shares_now": r["shares"],
                # how many new shares you subscribed to is yours to say
                "shares_expected": r["shares"] if rights else expected_shares(r["shares"], r["factor"]),
            }
    return out


def new_average(avg: float, old: int, new: int, factor: float, rights: bool, paid: float = 0.0) -> float:
    """The average price on the new prices. Bonus shares or a split: the same cost over more shares. A rights issue:
    the new shares add what they cost (paid each); kept the old count (sold the rights): the shares are worth
    ÷ factor and the rest came back as the rights' price, so the cost goes ÷ factor too."""
    # ponytail: subscribing to only part of your rights counts the sold rights' cost in, so the average is a bit high
    if rights and new == old:
        return avg / factor
    return (avg * old + max(new - old, 0) * paid) / new


def adjust_problem(shares_now: int, ev: dict, new: int, paid: float = 0.0) -> str | None:
    """Why a new share count can't be right, or None (local/api.js adjust says the same)."""
    if ev.get("rights"):
        if new < shares_now:
            return (f"You held {shares_now:,} before the rights issue: enter those plus the new shares you subscribed "
                    "to. Sold some? Log that sale first.")
        if new > shares_now and not paid > 0:
            return "Enter what each new share cost you (the subscription price)."
        return None
    if not 0.75 * shares_now * ev["factor"] <= new <= 1.25 * shares_now * ev["factor"]:
        return (f"{new:,} shares is far from the expected {ev['shares_expected']:,}. Check the number at your broker. "
                "If your shares didn't change, choose 'My shares didn't change'.")
    return None


def apply(conn: sqlite3.Connection, trade_id: int, event_id: int, new_shares: int, paid: float = 0.0) -> dict:
    """Update a position to its new share count; its levels move with the prices (÷ the event's factor)."""
    t = conn.execute("SELECT * FROM trades WHERE id=? AND status IN ('open', 'pending')", (trade_id,)).fetchone()
    e = conn.execute(f"SELECT e.*, {RIGHTS_SQL} AS rights FROM price_events e WHERE id=?", (event_id,)).fetchone()
    if t is None or e is None or e["symbol"] != t["symbol"]:
        raise ValueError("This position or event no longer exists. Refresh the page.")
    new_shares = int(new_shares)
    if new_shares < 1:
        raise ValueError("Enter how many shares you hold now.")
    old, f, rights = int(t["shares"]), float(e["factor"]), bool(e["rights"])
    ratio = new_shares / old
    avg = new_average(float(t["entry_price"]), old, new_shares, f, rights, paid) if t["entry_price"] else None
    conn.execute(
        """UPDATE trades SET shares=?, entry_price=?, initial_stop=initial_stop/?, stop=stop/?,
               target=target/?, highest_close=highest_close/?, entry_limit=entry_limit/? WHERE id=?""",
        (new_shares, avg, f, f, f, f, f, trade_id),
    )
    today = date.today().isoformat()
    if t["account"] == "real":
        note = (f"{describe(f)}: {old:,} → {new_shares:,} shares" if not rights
                else f"Rights issue: {new_shares - old:,} new shares at {paid:g}, {old:,} → {new_shares:,} shares"
                if new_shares > old else f"Rights issue: kept {old:,} shares, prices ÷ {f:.4g}")
        conn.execute(
            "INSERT INTO fills(trade_id, symbol, date, side, shares, price, fees, note) VALUES (?,?,?,?,?,?,?,?)",
            (trade_id, t["symbol"], e["ex_date"], "bonus", new_shares - old, paid if rights else 0.0, 0.0, note),
        )
    conn.execute(
        "INSERT OR REPLACE INTO position_adjustments(event_id, trade_id, action, ratio, date) VALUES (?,?,?,?,?)",
        (event_id, trade_id, "applied", ratio, today),
    )
    conn.commit()
    return {"symbol": t["symbol"], "old": old, "new": new_shares, "ratio": ratio, "avg": avg}


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
