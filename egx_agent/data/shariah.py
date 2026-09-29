"""Shariah data + stock universe from Kashif (kasheif.com).

Kashif's public search page is a GET form. With no filter it shows nothing, so the full list is the
union of its four status filters. Index membership comes from its index filter
(3 = EGX30, 4 = EGX70, 5 = EGX33 Shariah). robots.txt only disallows /admin/, /api/ and /error/.
We fetch ~25 pages about once a week, one request per second.
"""
from __future__ import annotations

import re
import sqlite3
import time
from datetime import datetime, timedelta

import requests
from bs4 import BeautifulSoup

from .. import db

BASE = "https://kasheif.com/"
HEADERS = {"User-Agent": "EGX-Trading-Agent/1.0 (personal decision-support tool; weekly refresh)"}
STATUS_FILTERS = {
    "Halal": "compliant",
    "MustPurify": "non_compliant",
    "AwaitingFinancialStatements": "awaiting",
    "StatusBlocked": "blocked",
}
INDEX_FILTERS = {3: "egx30", 4: "egx70", 5: "egx33"}
REFRESH_DAYS = 7
MAX_PAGES = 40


def stock_url(symbol: str) -> str:
    return f"{BASE}stocks/{symbol}"


def clean_symbol(raw: str) -> str:
    """Kashif sometimes wraps symbols in invisible right-to-left marks; keep only A–Z/0–9."""
    return re.sub(r"[^A-Z0-9]", "", raw.upper())


def parse_rows(html: str) -> list[dict]:
    """Parse one Kashif results page into row dicts."""
    soup = BeautifulSoup(html, "html.parser")
    rows = []
    for tr in soup.select("table tbody tr"):
        tds = [td.get_text(" ", strip=True) for td in tr.find_all("td")]
        if len(tds) < 7 or not clean_symbol(tds[0]):
            continue
        rows.append(
            {
                "symbol": clean_symbol(tds[0]),
                # Some names carry Kashif's "additional company details" link text; drop it.
                "name_ar": re.sub(r"\s*تفاصيل إضافية للشركة\s*$", "", tds[1]).strip(),
                "sector_ar": tds[2],
                "kashif_label": tds[3],
                "purity": tds[4] if tds[4] not in ("", "-") else None,
                "purification_pct": tds[5] if tds[5] not in ("", "-") else None,
                "statements_date": tds[6] if tds[6] not in ("", "-") else None,
            }
        )
    return rows


def _fetch_all_pages(session: requests.Session, params: dict, delay: float) -> list[dict]:
    out, seen = [], set()
    for page in range(1, MAX_PAGES + 1):
        r = session.get(BASE, params={**params, "page": page}, headers=HEADERS, timeout=30)
        r.raise_for_status()
        rows = parse_rows(r.text)
        new = [row for row in rows if row["symbol"] not in seen]
        if not new:
            break
        seen.update(row["symbol"] for row in new)
        out.extend(new)
        time.sleep(delay)
    return out


def needs_refresh(conn: sqlite3.Connection) -> bool:
    last = db.get_meta(conn, "kashif_refreshed")
    count = conn.execute("SELECT COUNT(*) AS n FROM stocks").fetchone()["n"]
    return count == 0 or not last or datetime.fromisoformat(last) < datetime.now() - timedelta(days=REFRESH_DAYS)


def refresh_kashif(conn: sqlite3.Connection, delay: float = 1.0) -> dict:
    """Refresh statuses and index membership. Keeps old data if Kashif looks broken."""
    session = requests.Session()
    by_symbol: dict[str, dict] = {}
    for param, status in STATUS_FILTERS.items():
        for row in _fetch_all_pages(session, {"search": "", "shariahStatus": param}, delay):
            by_symbol[row["symbol"]] = {**row, "kashif_status": status}
    if len(by_symbol) < 50:
        raise RuntimeError(f"Kashif returned only {len(by_symbol)} stocks; keeping cached data")

    members = {}
    for idx, col in INDEX_FILTERS.items():
        members[col] = {r["symbol"] for r in _fetch_all_pages(session, {"search": "", "indexIds": idx}, delay)}

    now = datetime.now().isoformat(timespec="seconds")
    # Drop symbols Kashif no longer lists (delisted / renamed); their price history stays in the db. Stocks the
    # agent took from TradingView's list because Kashif doesn't cover them stay (data/universe.py).
    placeholders = ",".join("?" * len(by_symbol))
    conn.execute(f"DELETE FROM stocks WHERE symbol NOT IN ({placeholders}) AND listed_by IS NULL", list(by_symbol))
    conn.execute("UPDATE stocks SET kashif_status=NULL, egx30=0, egx70=0, egx33=0")
    for sym, row in by_symbol.items():
        conn.execute(
            """INSERT INTO stocks(symbol, name_ar, sector_ar, kashif_status, kashif_label, purity, purification_pct,
                   statements_date, egx30, egx70, egx33, kashif_updated)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(symbol) DO UPDATE SET name_ar=excluded.name_ar, sector_ar=excluded.sector_ar,
                   kashif_status=excluded.kashif_status, kashif_label=excluded.kashif_label, purity=excluded.purity,
                   purification_pct=excluded.purification_pct, statements_date=excluded.statements_date,
                   egx30=excluded.egx30, egx70=excluded.egx70, egx33=excluded.egx33,
                   kashif_updated=excluded.kashif_updated, listed_by=NULL""",
            (
                sym, row["name_ar"], row["sector_ar"], row["kashif_status"], row["kashif_label"], row["purity"],
                row["purification_pct"], row["statements_date"],
                int(sym in members["egx30"]), int(sym in members["egx70"]), int(sym in members["egx33"]), now,
            ),
        )
    conn.commit()
    db.set_meta(conn, "kashif_refreshed", now)
    return {"stocks": len(by_symbol), **{k: len(v) for k, v in members.items()}}


def passes_filter(stock: dict, mode: str) -> bool:
    """Shariah filter from Settings. 'off' lets everything through."""
    kashif_ok = stock.get("kashif_status") == "compliant"
    egx33_ok = bool(stock.get("egx33"))
    return {
        "off": True,
        "kashif": kashif_ok,
        "egx33": egx33_ok,
        "either": kashif_ok or egx33_ok,
        "both": kashif_ok and egx33_ok,
    }.get(mode, True)
