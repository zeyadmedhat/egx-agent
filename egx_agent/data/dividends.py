"""Every EGX company's cash dividends, from TradingView's screener (one request for the whole market).

TradingView gives each stock's latest dividend, the next one once it's announced, and the yield. Each one seen is
kept, so the history grows from the first download on. Bonus shares and splits are found in the prices instead
(price_events, data/prices.py).
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import requests

URL = "https://scanner.tradingview.com/egypt/scan"
COLUMNS = ["name", "dividends_yield_current", "dividend_ex_date_recent", "dividend_amount_recent",
           "dividend_payment_date_recent", "dividend_ex_date_upcoming", "dividend_amount_upcoming",
           "dividend_payment_date_upcoming"]
CAIRO = ZoneInfo("Africa/Cairo")


def _day(ts) -> str | None:
    """TradingView's timestamps are mid-afternoon Cairo time on the day."""
    return None if ts is None else datetime.fromtimestamp(ts, timezone.utc).astimezone(CAIRO).date().isoformat()


def fetch(session: requests.Session | None = None, timeout: float = 30) -> list[dict]:
    body = {"filter": [{"left": "exchange", "operation": "equal", "right": "EGX"}], "columns": COLUMNS,
            "range": [0, 1000]}
    res = (session or requests).post(URL, json=body, timeout=timeout)
    res.raise_for_status()
    return [dict(zip(COLUMNS, r["d"])) for r in res.json().get("data", [])]


def save(conn: sqlite3.Connection, rows: list[dict]) -> int:
    """Store the dividends and yields. Returns how many dividends were new."""
    now = datetime.now().isoformat(timespec="seconds")
    before = conn.execute("SELECT COUNT(*) FROM cash_dividends").fetchone()[0]
    for r in rows:
        sym = r["name"]
        for when in ("recent", "upcoming"):
            ex = _day(r[f"dividend_ex_date_{when}"])
            amount = r[f"dividend_amount_{when}"]
            if ex and amount:
                conn.execute(
                    """INSERT INTO cash_dividends(symbol, ex_date, pay_date, amount, first_seen) VALUES (?,?,?,?,?)
                       ON CONFLICT(symbol, ex_date) DO UPDATE SET pay_date=excluded.pay_date, amount=excluded.amount""",
                    (sym, ex, _day(r[f"dividend_payment_date_{when}"]), round(float(amount), 6), now))
        conn.execute("INSERT OR REPLACE INTO dividend_yield(symbol, yield_pct, updated) VALUES (?,?,?)",
                     (sym, r["dividends_yield_current"], now))
    conn.commit()
    return conn.execute("SELECT COUNT(*) FROM cash_dividends").fetchone()[0] - before


def update(conn: sqlite3.Connection) -> int:
    return save(conn, fetch())
