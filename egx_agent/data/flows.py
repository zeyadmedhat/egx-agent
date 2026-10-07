"""What Egyptian, Arab and foreign investors bought and sold on EGX each session (net, in million EGP), for the market
mood. From Amwal Al Ghad's closing report (its public WordPress feed), which repeats the exchange's daily statement:
"اتجه المستثمرون العرب والأجانب نحو البيع بصافي بلغ 65.41 مليون جنيه و142.7 مليون جنيه على التوالي، فيما اتجه المستثمرون
المصريون نحو الشراء بصافي تعاملات بلغ نحو 208.1 مليون جنيه". The three nets add up to about zero, which checks each
reading. The exchange's own page sits behind a bot challenge, so it isn't used.
"""
from __future__ import annotations

import html
import re
import sqlite3
import time
from datetime import date, datetime, timedelta

import pandas as pd
import requests

from .. import db

FEED = "https://amwalalghad.com/wp-json/wp/v2/posts"
QUERY = "صافي الأجانب"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
SERIES = {"egyptians": "flow_egypt", "arabs": "flow_arab", "foreigners": "flow_foreign"}
BACKFILL_DAYS = 800      # the first download: enough for the mood's two-year window
CLOSE = "14:30"          # without a closing title, a report posted before this is a midday one
# a closing report's title ("تغلق", "بختام"…): in Ramadan the session ends at 13:30, so these come before 14:30
_CLOSING = re.compile(r"تغلق|تختتم|ختام|اغلاق|تنهي|نهاية تعاملات|نهاية الجلسة")

_GROUP = re.compile(r"(?<!\w)[وبل]?(?:ال)?(عرب|اجانب|مصري)(?:ي?(?:ون|ين)|ه|ة)?(?!\w)")    # والأجانب, للعرب
_NUM = re.compile(r"(\d+(?:\.\d+)?)\s*(مليار|مليون|الف)?")
_CLAUSE = re.compile(r"(?<!\d)\.|\.(?!\d)|فيما|بينما|في حين|في المقابل|\n"
                     r"|،\s*(?=و?(?:قصد|اتجه|اتجهت|توجه|توجهت|مال|مالت|سجل|سجلت)\s)")   # "…، قصد الأجانب الشراء…"
_UNIT = {"مليار": 1000.0, "مليون": 1.0, "الف": 0.001}
_KEY = {"عرب": "arabs", "اجانب": "foreigners", "مصري": "egyptians"}


def _normal(text: str) -> str:
    t = re.sub(r"<[^>]+>", " ", html.unescape(text))
    t = t.translate(str.maketrans("٠١٢٣٤٥٦٧٨٩٫", "0123456789.", "٬,")).replace("صافى", "صافي")
    t = re.sub("[أإآ]", "ا", t).replace("غير العرب", "")      # "الأجانب غير العرب" are the foreigners
    return re.sub(r"[ \t\r]+", " ", t)


def parse(text: str) -> dict[str, float] | None:
    """{egyptians, arabs, foreigners}: net million EGP (+ bought, − sold), or None unless they add up to about zero.
    A report that names only two (the third about even) gets the third from the other two."""
    out: dict[str, float] = {}
    for clause in _CLAUSE.split(_normal(text)):
        head, _, tail = clause.partition("صافي")
        sell, buy = "بيع" in clause, "شراء" in clause
        if not tail or sell == buy:
            continue
        groups = list(dict.fromkeys(_KEY[g] for g in _GROUP.findall(head)))
        nums, unit = [], "مليون"
        for v, u in _NUM.findall(tail):
            unit = u or unit
            nums.append(float(v) / 1e6 if float(v) >= 1e5 else float(v) * _UNIT[unit])   # written in full pounds
        if not groups or len(nums) < len(groups):
            continue
        for g, v in zip(groups, nums):
            out.setdefault(g, -v if sell else v)
    total = sum(abs(v) for v in out.values())
    if len(out) == 2 and min(out.values()) < 0 < max(out.values()) and abs(sum(out.values())) <= max(1.0, 0.1 * total):
        out[next(k for k in SERIES if k not in out)] = -sum(out.values())
    if len(out) != 3:
        return None
    even = lambda o: abs(sum(o.values())) <= max(1.0, 0.03 * sum(abs(v) for v in o.values()))   # noqa: E731
    if even(out):
        return out
    # a report that wrote one amount in millions instead of billions (or the other way): the one fix that evens it
    fixed = [o for k in out for f in (1000.0, 0.001) if even(o := {**out, k: out[k] * f})]
    return fixed[0] if len(fixed) == 1 else None


def fetch(since: str, session: requests.Session | None = None, delay: float = 2.0, per_page: int = 100) -> dict[str, dict]:
    """Each session's flows since `since` (YYYY-MM-DD): the first closing report of the day that reads well, else the
    first one posted after the close."""
    s = session or requests.Session()
    s.headers.update({"User-Agent": UA})
    found: dict[str, dict] = {}
    titled: set[str] = set()          # days whose flows came from a closing report
    page = 1
    while True:
        r = s.get(FEED, params={"search": QUERY, "per_page": per_page, "page": page, "after": f"{since}T00:00:00",
                                "orderby": "date", "order": "asc", "_fields": "date,title,content"}, timeout=60)
        if r.status_code == 400 and page > 1:      # past the last page
            break
        r.raise_for_status()
        posts = r.json()
        for p in posts:
            day, clock = p["date"][:10], p["date"][11:16]
            title = re.sub("[\u064b-\u0652]", "", _normal((p.get("title") or {}).get("rendered", "")))
            closing = bool(_CLOSING.search(title))
            if day in titled or date.fromisoformat(day).weekday() in (4, 5) or not (closing or clock >= CLOSE) \
                    or (day in found and not closing):
                continue
            got = parse((p.get("content") or {}).get("rendered", ""))
            if got:
                found[day] = got
                if closing:
                    titled.add(day)
        if len(posts) < per_page or page >= int(r.headers.get("X-WP-TotalPages", page)):
            break
        page += 1
        time.sleep(delay)
    return found


def update(conn: sqlite3.Connection, session: requests.Session | None = None) -> int:
    """Download the sessions since the last one saved (about two years the first time). Returns how many were saved."""
    last = conn.execute("SELECT MAX(date) FROM macro WHERE series = ?", (SERIES["foreigners"],)).fetchone()[0]
    if last and last >= date.today().isoformat():
        return 0
    since = (datetime.fromisoformat(last) + timedelta(days=1)).date().isoformat() if last \
        else (date.today() - timedelta(days=BACKFILL_DAYS)).isoformat()
    found = fetch(since, session)
    for key, series in SERIES.items():
        if found:
            db.upsert_macro(conn, series, pd.DataFrame({"date": list(found), "close": [v[key] for v in found.values()]}))
    return len(found)


def load(conn: sqlite3.Connection) -> pd.DataFrame:
    """Net flows by session (columns egyptians, arabs, foreigners; million EGP)."""
    df = pd.read_sql_query("SELECT series, date, value FROM macro WHERE series IN (?, ?, ?)", conn,
                           params=tuple(SERIES.values()))
    if df.empty:
        return pd.DataFrame(columns=list(SERIES))
    df["date"] = pd.to_datetime(df["date"])
    wide = df.pivot(index="date", columns="series", values="value")
    return wide.rename(columns={v: k for k, v in SERIES.items()}).reindex(columns=list(SERIES))
