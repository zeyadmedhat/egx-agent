"""EGX's trading days: Sunday to Thursday, except the public holidays the exchange announces.

EGX announces each holiday a few days ahead (it often moves one to a Thursday or a Sunday), and the news repeats its
statement: "اعتبار يوم الخميس الموافق 8 أكتوبر 2026 إجازة رسمية ... استئناف العمل سيكون يوم الأحد الموافق 11 أكتوبر".
check() reads those from Amwal Al Ghad's feed (the one data/flows.py reads) a few times a day. The dates are kept in the
database (meta "holidays") and load() puts them here for everything that counts sessions.
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import date, datetime, timedelta
from functools import lru_cache

import pandas as pd
import requests

WEEKMASK = "Sun Mon Tue Wed Thu"
TRADING_WEEKDAYS = {6, 0, 1, 2, 3}
HOLIDAYS: dict[str, str] = {}         # "2026-10-08" → the announcement's title

FEED = "https://amwalalghad.com/wp-json/wp/v2/posts"
SEARCH = "البورصة إجازة"                # every word must be there; "رسمية" missed an Eid
EVERY = timedelta(hours=6)            # announcements come days ahead: a few looks a day is plenty
LONGEST = 10                          # days from a holiday to the session after it (the Eids are the longest)

_DAYS = {"الاحد": 6, "الاثنين": 0, "الثلاثاء": 1, "الاربعاء": 2, "الخميس": 3}
_MONTHS = {m: i + 1 for i, m in enumerate(("يناير", "فبراير", "مارس", "ابريل", "مايو", "يونيو", "يوليو", "اغسطس",
                                             "سبتمبر", "اكتوبر", "نوفمبر", "ديسمبر"))}
# a weekday followed by its date ("الخميس الموافق 8 أكتوبر 2026", "الأحد الموافق 30/06/2024"): the two must agree,
# which keeps out the dates in an occasion's name ("ذكرى ثورة 23 يوليو")
_WHEN = re.compile(r"(" + "|".join(_DAYS) + r")(?:\s+(?:يوم|المقبل|القادم|الموافق|الموفق))*\s+"
                   r"(?:(\d{1,2})\s+(?:من\s+)?(?:شهر\s+)?(" + "|".join(_MONTHS) + r")(?:\s+(\d{4}))?"
                   r"|(\d{1,2})[/-](\d{1,2})[/-](\d{4}))")
_RESUME = re.compile(r"(?:يستانف|تستانف|ستستانف|استئناف|استيناف|تعاود|ستعاود|يعاود|عوده|يعود)[^.]{0,150}$")
_UNTIL = re.compile(r"حتي|الي")
_HOLIDAY = re.compile(r"اجاز|عطل|عطيل")
_NOT = re.compile(r"تعمل|طبيعي|(?:بعد|قبل|عقب) (?:بدء )?الاجاز|تغلق|ختام|تراجع|ارتفاع|صعود|هبوط")   # market reports


def _normal(text: str) -> str:
    t = re.sub(r"<[^>]+>", " ", text).replace("&nbsp;", " ")
    t = t.translate(str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789"))
    t = re.sub("[ً-ْـ]", "", t)                     # short vowels, tatweel
    t = re.sub("[أإآ]", "ا", t).replace("ى", "ي").replace("ة", "ه")
    return re.sub(r"\s+", " ", t)


def _date(m: re.Match, posted: date) -> date | None:
    try:
        if m.group(5):
            d = date(int(m.group(7)), int(m.group(6)), int(m.group(5)))
        else:
            d = date(int(m.group(4) or posted.year), _MONTHS[m.group(3)], int(m.group(2)))
            if not m.group(4) and d < posted - timedelta(days=7):      # "1 يناير المقبل" posted in December
                d = date(d.year + 1, d.month, d.day)
    except ValueError:
        return None
    return d if d.weekday() == _DAYS[m.group(1)] else None


def parse(text: str, posted: date) -> set[str]:
    """The days an announcement closes the exchange. Each date must come right after its weekday; a date after a word
    like "يستأنف" is the session after. A closure from one date "حتى" another, or up to the day it resumes (a week or so
    later), counts every Sunday–Thursday in between."""
    t = _normal(text)
    found = []                                  # (day, resumes?, start, end), in order
    for m in _WHEN.finditer(t):
        d = _date(m, posted)
        if d and posted < d <= posted + timedelta(days=60):       # not the statement's own date
            found.append((d, bool(_RESUME.search(t[max(0, m.start() - 160):m.start()])), m.start(), m.end()))
    days: set[date] = set()
    shut = [f for f in found if not f[1]]
    for i, (d, _, _, end) in enumerate(shut):
        days.add(d)
        nxt = shut[i + 1] if i + 1 < len(shut) else None
        if nxt and _UNTIL.search(t[end:nxt[2]]):
            days |= {d + timedelta(k) for k in range((nxt[0] - d).days)}
        back = next((r for r in found if r[1] and r[2] > end and (not nxt or r[2] < nxt[2])), None)
        if back and 0 < (back[0] - d).days <= LONGEST:
            days |= {d + timedelta(k) for k in range((back[0] - d).days)}
    return {d.isoformat() for d in days if d.weekday() in TRADING_WEEKDAYS}


def fetch(session: requests.Session | None = None, today: date | None = None) -> dict[str, str]:
    """The holidays announced in the past 400 days and the ones coming, {date: title}."""
    from .data.flows import UA

    today = today or date.today()
    s = session or requests.Session()
    r = s.get(FEED, params={"search": SEARCH, "per_page": 100, "after": f"{today - timedelta(days=400)}T00:00:00",
                            "orderby": "date", "order": "desc", "_fields": "date,title,content"},
              headers={"User-Agent": UA}, timeout=60)
    r.raise_for_status()
    out: dict[str, str] = {}
    for p in r.json():
        raw = (p.get("title") or {}).get("rendered", "")
        title = _normal(raw)
        if "البورصه" not in title or not _HOLIDAY.search(title) or _NOT.search(title):
            continue
        body = (p.get("content") or {}).get("rendered", "")[:3000]
        for d in parse(raw + " . " + body, date.fromisoformat(p["date"][:10])):
            out.setdefault(d, re.sub(r"<[^>]+>|&[#\w]+;", "", raw).strip())
    return out


def load(conn: sqlite3.Connection) -> None:
    row = conn.execute("SELECT value FROM meta WHERE key='holidays'").fetchone()
    HOLIDAYS.clear()
    HOLIDAYS.update(json.loads(row[0]) if row and row[0] else {})


def check(conn: sqlite3.Connection, session: requests.Session | None = None, now: datetime | None = None) -> int | None:
    """Look for new announcements (at most every EVERY). A day the index has a close for wasn't a holiday after all.
    Returns how many holidays are known, or None if it wasn't time to look."""
    from .data.prices import INDEX_SYMBOL

    now = now or datetime.now()
    row = conn.execute("SELECT value FROM meta WHERE key='holidays_checked'").fetchone()
    if row and now - datetime.fromisoformat(row[0]) < EVERY:
        return None
    found = fetch(session, now.date())
    traded = {r[0] for r in conn.execute(
        f"SELECT date FROM prices WHERE symbol=? AND date IN ({','.join('?' * len(found))})", (INDEX_SYMBOL, *found))}
    keep = {d: found[d] for d in sorted(found) if d not in traded}
    conn.executemany("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                     [("holidays", json.dumps(keep, ensure_ascii=False)), ("holidays_checked", now.isoformat())])
    conn.commit()
    load(conn)
    return len(keep)


def is_session(day: date | str) -> bool:
    d = date.fromisoformat(day) if isinstance(day, str) else day
    return d.weekday() in TRADING_WEEKDAYS and d.isoformat() not in HOLIDAYS


@lru_cache(maxsize=8)
def _offset(days: tuple[str, ...]) -> pd.offsets.CustomBusinessDay:
    return pd.offsets.CustomBusinessDay(weekmask=WEEKMASK, holidays=list(days))


def session_day() -> pd.offsets.CustomBusinessDay:
    """One EGX session, as a pandas offset (Timestamp + n * session_day())."""
    return _offset(tuple(sorted(HOLIDAYS)))


def sessions_after(day: str, n: int) -> str:
    """Date n EGX sessions after `day`."""
    return str((pd.Timestamp(day) + n * session_day()).date())


def upcoming(today: date | None = None) -> list[dict]:
    """The holidays from today on, for the site and the bot."""
    today = (today or date.today()).isoformat()
    return [{"date": d, "title": t} for d, t in sorted(HOLIDAYS.items()) if d >= today]
