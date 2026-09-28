"""The list of EGX stocks we scan, with English sector names and EGX33 overrides."""
from __future__ import annotations

import csv
import sqlite3
from pathlib import Path

import pandas as pd

from .. import db

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
