"""Each company's free float from Mubasher's ownership list (the stock's profile page): 100% minus the holders of 5%
or more, the same rule TradingView uses. A second source next to TradingView's free float (data/dividends.py): in
2026-10 TradingView had it for 146 of 234 trading stocks, Mubasher's lists 230; on the 145 both had, they agreed
within 5 points only 41% of the time (each wrong on some: TradingView said Sidi Kerir was 100% free, Mubasher's list
for Edita missed the founders), so the site shows one number when they agree and both when they don't (combined).

Mubasher's robots.txt asks for 5 seconds between pages: BUDGET stocks a run, each again after REFRESH_DAYS.
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from datetime import datetime, timedelta

from .news import MUBASHER, Fetcher

BUDGET = 12                  # stocks a run (a minute at Mubasher's 5 seconds a page)
REFRESH_DAYS = 30            # owners change rarely
BIG = 5.0                    # a holder of this % or more isn't free float
AGREE = 5.0                  # points apart that still count as the same free float


def parse(page: str) -> list[tuple[str, float]]:
    """The holders and their % from a profile page's Ownership list ([] when it has none)."""
    i = page.find(">Ownership<")
    if i < 0:
        return []
    part = page[i:page.find("Management", i)]
    txt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "|", part))
    return [(n.strip(" |"), float(p)) for n, p in re.findall(r"\|([^|()]{2,120}?)\|\s*\|?\s*\(\|?([\d.]+)%", txt)]


def free_float(holders: list[tuple[str, float]]) -> float | None:
    """100% minus the big holders, as a fraction; None without a list or when it adds up to more than 100%."""
    if not holders or sum(p for _, p in holders) > 100.5:
        return None
    return round(1 - sum(p for _, p in holders if p >= BIG) / 100, 4)


def update(conn: sqlite3.Connection, symbols: list[str], budget: int = BUDGET, f: Fetcher | None = None) -> int:
    """Read the ownership lists of up to `budget` of these stocks, never-read or oldest first. Returns how many."""
    since = (datetime.now() - timedelta(days=REFRESH_DAYS)).isoformat(timespec="seconds")
    seen = {r[0]: r[1] for r in conn.execute("SELECT symbol, updated FROM ownership")}
    due = sorted((s for s in symbols if seen.get(s, "") < since), key=lambda s: seen.get(s, ""))[:budget]
    f = f or Fetcher()
    f.last.setdefault(MUBASHER["en"].split("/")[2], time.monotonic())    # the news step may have just read it
    for sym in due:
        holders = parse(f.get(f"{MUBASHER['en']}/markets/EGX/stocks/{sym}/profile").text)
        conn.execute("INSERT OR REPLACE INTO ownership(symbol, holders, free_float, updated) VALUES (?,?,?,?)",
                     (sym, json.dumps(holders, ensure_ascii=False), free_float(holders),
                      datetime.now().isoformat(timespec="seconds")))
        conn.commit()
    return len(due)


def combined(tv: float | None, mub: float | None) -> dict | None:
    """What the site shows: {"value"} when one source has it or both agree (TradingView's then), else both."""
    if tv is None and mub is None:
        return None
    if tv is None or mub is None or abs(tv - mub) * 100 <= AGREE:
        return {"value": tv if tv is not None else mub, "tv": tv, "mub": mub}
    return {"value": None, "tv": tv, "mub": mub}
