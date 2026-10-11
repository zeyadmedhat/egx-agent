"""Each company's free float from two owners lists: Mubasher's (the stock's profile page) and Arab Finance's ("major
shareholders, from the latest disclosure"), each 100% minus the big holders. TradingView's free float
(data/dividends.py) is the fallback.

Checked in 2026-10 against 25 companies' own disclosure forms (the ones where the sources disagreed): Arab Finance
was within 5 points on 16 of 23 (typically 0.9 off), Mubasher on 16 of 23 (1.7 off), TradingView on 2 of 22 (23 off;
it says 100% when it doesn't know: Sidi Kerir, Faisal Bank). The two lists go wrong on different companies, mostly by
missing an owner (Edita's 48.75% holder on Mubasher, Kora's 75% owner on both), which makes the float look bigger:
where they disagreed the lower one was closer 6 times in 8. So the site shows the lower of the two (combined), and
a list without a single big holder says nothing (it would make a company 100% free).

Neither groups family members or related companies that each hold under 5% (El Sewedy's family, about 78%), so a
few companies' real float is lower than shown.

Mubasher's robots.txt asks for 5 seconds between pages: BUDGET stocks a run, each again after REFRESH_DAYS.
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from datetime import datetime, timedelta

from .news import BROKEN, MUBASHER, Fetcher

ARAB_FINANCE = "https://www.arabfinance.com/en/home/companyprofileoverview"   # robots.txt allows it, no delay asked

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


def parse_af(page: str) -> list[tuple[str, float]]:
    """Arab Finance's major holders and their % ([] when it lists none). They're all big holders, or related groups."""
    i = page.find("كبار المساهمين")
    if i < 0:
        return []
    txt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "|", page[i:page.find("<script", i)]))
    return [(n.strip(" |"), float(p)) for n, p in
            re.findall(r"\|([^|]{2,150}?)\|[| ]*إجمالى عدد الأسهم[| ]*[\d,]+[| ]*النسبة[| ]*([\d.]+) ?%", txt)]


def free_float(holders: list[tuple[str, float]], big: float = BIG) -> float | None:
    """100% minus the holders of `big`% or more, as a fraction. None without a list, when it adds up to more than 100%,
    or when nobody in it holds that much: a list that misses the owners, far more often than a company without any."""
    if not holders or sum(p for _, p in holders) > 100.5:
        return None
    owned = sum(p for _, p in holders if p >= big)
    return round(1 - owned / 100, 4) if owned else None


def update(conn: sqlite3.Connection, symbols: list[str], budget: int = BUDGET, f: Fetcher | None = None) -> int:
    """Read the ownership lists of up to `budget` of these stocks, never-read or oldest first. Returns how many."""
    since = (datetime.now() - timedelta(days=REFRESH_DAYS)).isoformat(timespec="seconds")
    seen = {r[0]: r[1] for r in conn.execute("SELECT symbol, updated FROM ownership")}
    due = sorted((s for s in symbols if seen.get(s, "") < since), key=lambda s: seen.get(s, ""))[:budget]
    f = f or Fetcher()
    f.last.setdefault(MUBASHER["en"].split("/")[2], time.monotonic())    # the news step may have just read it
    for sym in due:
        r = f.get(f"{MUBASHER['en']}/markets/EGX/stocks/{sym}/profile")
        if r.status_code not in BROKEN:
            r.raise_for_status()        # refused or down: stop, and don't mark the rest as read
        holders = parse(r.text) if r.status_code == 200 else []      # a page Mubasher can't show: next month
        try:
            a = f.get(ARAB_FINANCE, params={"key": sym}, headers={"X-Requested-With": "XMLHttpRequest"})
            af = parse_af(a.text) if a.status_code == 200 else None
        except Exception:      # Mubasher's list still counts
            af = None
        conn.execute("INSERT OR REPLACE INTO ownership(symbol, holders, free_float, updated, af_holders, af_free_float) "
                     "VALUES (?,?,?,?,?,?)",
                     (sym, json.dumps(holders, ensure_ascii=False), free_float(holders),
                      datetime.now().isoformat(timespec="seconds"),
                      None if af is None else json.dumps(af, ensure_ascii=False), free_float(af, 0) if af else None))
        conn.commit()
    return len(due)


def combined(tv: float | None, mub: float | None, af: float | None = None) -> dict | None:
    """What the site shows: the lower of the two owners lists' free floats (see the top), or TradingView's when
    neither has one (not its 100%, which means it doesn't know). "differ": the two lists are over AGREE points apart."""
    tv = tv if tv is not None and tv < 0.995 else None
    lists = [v for v in (af, mub) if v is not None]
    value = min(lists) if lists else tv
    if value is None:
        return None
    return {"value": value, "af": af, "mub": mub, "tv": tv,
            "differ": len(lists) == 2 and abs(af - mub) * 100 > AGREE}
