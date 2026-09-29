"""The list of EGX stocks we scan, with English sector names and EGX33 overrides.

Kashif (data/shariah.py) gives most of the list with each stock's Shariah status. It leaves out some companies,
several of them big banks, so once a week the stocks on TradingView's EGX list that Kashif doesn't have are added
too (refresh_tradingview). They have no Shariah status, so a Shariah filter leaves them out.
"""
from __future__ import annotations

import csv
import re
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import requests

from .. import db
from . import prices

FALLBACK_CSV = Path(__file__).with_name("symbols.csv")

SECTOR_EN = {
    "اتصالات وتكنولوجيا رقمية": "Telecom & Tech",
    "استثمار زراعي": "Agriculture",
    "اعمال مصرفية غير بنكية": "Non-bank Financials",
    "اغذية ومشروبات": "Food & Beverages",
    "الأدوية و الرعاية الصحية": "Healthcare & Pharma",
    "التجارة والتوكيلات": "Trade & Distributors",
    "الطباعة": "Printing",
    "المعادن": "Metals",
    "بنوك": "Banks",
    "تعليم": "Education",
    "تمويل استهلاكي": "Consumer Finance",
    "خدمات و منتجات صناعية وسيارات": "Industrials & Autos",
    "سياحه": "Tourism",
    "صناعة البلاستيك": "Plastics",
    "طاقة - مرافق": "Energy & Utilities",
    "طاقة / خدمات مسانده": "Energy Services",
    "عقاري": "Real Estate",
    "مقاولات استشارات هدنسية": "Contracting & Engineering",
    "منسوجات وسلع معمرة": "Textiles & Durables",
    "مواد بناء": "Building Materials",
    "موارد اساسية": "Basic Resources",
    "وسائل نقل ومواصلات": "Transport",
}


def sector_en(sector_ar: str | None) -> str:
    if not sector_ar:
        return "Other"
    return SECTOR_EN.get(sector_ar, sector_ar)


def ensure_seeded(conn: sqlite3.Connection) -> None:
    """If Kashif has never been reachable, seed symbols from the bundled CSV so scans still work."""
    if conn.execute("SELECT COUNT(*) AS n FROM stocks").fetchone()["n"]:
        return
    with open(FALLBACK_CSV, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            conn.execute(
                "INSERT OR IGNORE INTO stocks(symbol, name_ar, sector_ar) VALUES (?,?,?)",
                (row["symbol"], row["name_ar"], row["sector_ar"]),
            )
    conn.commit()


def export_fallback(conn: sqlite3.Connection) -> None:
    rows = conn.execute("SELECT symbol, name_ar, sector_ar FROM stocks ORDER BY symbol").fetchall()
    with open(FALLBACK_CSV, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["symbol", "name_ar", "sector_ar"])
        w.writerows([tuple(r) for r in rows])


def stock_table(conn: sqlite3.Connection, egx33_extra: list[str] | None = None) -> pd.DataFrame:
    """All stocks with Shariah info. Symbols typed in Settings are added to EGX33 membership."""
    df = db.stocks_df(conn)
    if egx33_extra:
        extra = {s.strip().upper() for s in egx33_extra if s.strip()}
        df.loc[df["symbol"].isin(extra), "egx33"] = 1
    df["sector"] = df["sector_ar"].map(sector_en)
    return df


def scan_symbols(conn: sqlite3.Connection) -> list[str]:
    return [r["symbol"] for r in conn.execute("SELECT symbol FROM stocks ORDER BY symbol")]


# ------------------------------------------------------------------ stocks Kashif doesn't list

TV_SCANNER = "https://scanner.tradingview.com/egypt/scan"
TV_EVERY_DAYS = 7
TV_MIN_VALUE = 1_000_000      # EGP traded a day: anything less could never pass the scan's liquidity rule
TV_SECTORS = (                # TradingView's industry → Kashif's sector, where one clearly matches
    (re.compile(r"^(?!investment).*bank", re.I), "بنوك"),     # "Investment Banks/Brokers" are brokers
    (re.compile(r"real estate", re.I), "عقاري"),
    (re.compile(r"hotel|resort|casino|tour", re.I), "سياحه"),
    (re.compile(r"invest|broker|financ|leasing|insurance|trust", re.I), "اعمال مصرفية غير بنكية"),
    (re.compile(r"cement|construction materials", re.I), "مواد بناء"),
    (re.compile(r"food|beverage|agricultur", re.I), "اغذية ومشروبات"),
    (re.compile(r"pharma|medical|health", re.I), "الأدوية و الرعاية الصحية"),
    (re.compile(r"engineering|construction", re.I), "مقاولات استشارات هدنسية"),
)


def needs_tv_refresh(conn: sqlite3.Connection) -> bool:
    last = db.get_meta(conn, "tv_list_refreshed")
    return not last or datetime.fromisoformat(last) < datetime.now() - timedelta(days=TV_EVERY_DAYS)


def fetch_tradingview(session: requests.Session | None = None, timeout: float = 30) -> list[dict]:
    """Every common stock on TradingView's EGX list: symbol, English name, sector and EGP traded a day."""
    cols = ["name", "description", "close", "average_volume_30d_calc", "sector", "industry", "type", "typespecs"]
    body = {"filter": [{"left": "exchange", "operation": "equal", "right": "EGX"}], "columns": cols,
            "range": [0, 2000]}
    res = (session or requests).post(TV_SCANNER, json=body, timeout=timeout)
    res.raise_for_status()
    out = []
    for row in res.json().get("data", []):
        r = dict(zip(cols, row["d"]))
        if (r["type"] != "stock" or "common" not in (r["typespecs"] or [])
                or not re.fullmatch(r"[A-Z0-9]{2,14}", r["name"] or "")):
            continue
        out.append({"symbol": r["name"], "name": r["description"] or r["name"], "sector": r["sector"] or "",
                    "industry": r["industry"] or "",
                    "value": (r["close"] or 0) * (r["average_volume_30d_calc"] or 0)})
    return out


def _sector(row: dict) -> str:
    for pattern, sector in TV_SECTORS:
        if pattern.search(row["industry"]):
            return sector
    return row["sector"] or "Other"


def refresh_tradingview(conn: sqlite3.Connection, rows: list[dict] | None = None) -> dict:
    """Add the stocks on TradingView's EGX list that Kashif doesn't have and that trade at least TV_MIN_VALUE a
    day; drop the ones added this way that have left TradingView's list. Returns counts."""
    rows = fetch_tradingview() if rows is None else rows
    if len(rows) < 100:
        raise RuntimeError(f"TradingView listed only {len(rows)} EGX stocks; keeping the list as it is")
    listed = {r["symbol"] for r in rows}
    known = {r[0] for r in conn.execute("SELECT symbol FROM stocks")}
    aliased = set(prices.TV_ALIASES.values())       # already scanned under Kashif's code for the same company
    added = 0
    for r in rows:
        if r["symbol"] in known or r["symbol"] in aliased or r["value"] < TV_MIN_VALUE:
            continue
        conn.execute("INSERT INTO stocks(symbol, name_ar, sector_ar, listed_by) VALUES (?,?,?, 'tradingview')",
                     (r["symbol"], r["name"], _sector(r)))
        added += 1
    gone = [s for (s,) in conn.execute("SELECT symbol FROM stocks WHERE listed_by='tradingview'") if s not in listed]
    conn.executemany("DELETE FROM stocks WHERE symbol=?", [(s,) for s in gone])
    conn.commit()
    db.set_meta(conn, "tv_list_refreshed", datetime.now().isoformat(timespec="seconds"))
    total = conn.execute("SELECT COUNT(*) FROM stocks WHERE listed_by='tradingview'").fetchone()[0]
    return {"added": added, "removed": len(gone), "from_tradingview": total}
