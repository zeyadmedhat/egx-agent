"""What Egyptian, Arab and foreign investors bought and sold on EGX each session (net, in million EGP), for the market
mood. From Amwal Al Ghad's closing report (its public WordPress feed), which repeats the exchange's daily statement:
"اتجه المستثمرون العرب والأجانب نحو البيع بصافي بلغ 65.41 مليون جنيه و142.7 مليون جنيه على التوالي، فيما اتجه المستثمرون
المصريون نحو الشراء بصافي تعاملات بلغ نحو 208.1 مليون جنيه". The three nets add up to about zero, which checks each
reading. The exchange's own page sits behind a bot challenge, so it isn't used.

Each group's split into individuals and institutions comes from Youm7's daily "أخبار البورصة اليوم", which repeats the
same statement's next sentence (see parse_split).
"""
from __future__ import annotations

import html
import os
import re
import sqlite3
import time
import urllib.parse
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd
import requests

from .. import db
from .prices import INDEX_SYMBOL

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
# a story about the government debt market (bonds, treasury bills), not shares: on 16 Nov 2026 one said "the Arabs and
# foreigners bought 29.38 billion" and was read as the share market's flows
_DEBT = re.compile(r"ادوات دين|ادوات الدين|الدين الحكومي|سندات|اذون|السوق الثانوية")
MAX_NET = 20_000.0     # million EGP: no group nets this much in shares in one session (11–13 billion foreign
                       # buying on three days of 2025–26 may be real deals, so they stay)
_KEY = {"عرب": "arabs", "اجانب": "foreigners", "مصري": "egyptians"}


def _normal(text: str) -> str:
    t = re.sub(r"<[^>]+>", " ", html.unescape(text))
    t = t.translate(str.maketrans("٠١٢٣٤٥٦٧٨٩٫", "0123456789.", "٬,")).replace("صافى", "صافي")
    t = re.sub("[أإآ]", "ا", t).replace("غير العرب", "")      # "الأجانب غير العرب" are the foreigners
    return re.sub(r"[ \t\r]+", " ", t)


def _amounts(text: str) -> list[float]:
    """The amounts in order, in million EGP (a unit left out is the one before it; 1e5 or more is in full pounds)."""
    nums, unit = [], "مليون"
    for v, u in _NUM.findall(text):
        unit = u or unit
        nums.append(float(v) / 1e6 if float(v) >= 1e5 else float(v) * _UNIT[unit])
    return nums


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
        nums = _amounts(tail)
        if not groups or len(nums) < len(groups):
            continue
        for g, v in zip(groups, nums):
            out.setdefault(g, -v if sell else v)
    total = sum(abs(v) for v in out.values())
    if len(out) == 2 and min(out.values()) < 0 < max(out.values()) and abs(sum(out.values())) <= max(1.0, 0.1 * total):
        out[next(k for k in SERIES if k not in out)] = -sum(out.values())
    if len(out) != 3 or max(abs(v) for v in out.values()) > MAX_NET:
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
            body = (p.get("content") or {}).get("rendered", "")
            if _DEBT.search(title):      # its title says so; a share report may mention bonds in passing
                continue
            got = parse(body)
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
    """Each group's net (two years the first time) and its split into individuals and institutions (a month the first
    time). One failing doesn't stop the other. Returns how many sessions of nets were saved."""
    saved, errors = 0, []
    for step in (update_totals, update_split):
        try:
            n = step(conn, session)
            saved = saved or n
        except Exception as exc:  # noqa: BLE001 - the other source still runs
            errors.append(exc)
    if errors:
        raise errors[0]
    return saved


def drop_impossible(conn: sqlite3.Connection) -> int:
    """Forget every flow of a day where one group's net is beyond MAX_NET: the debt market read as shares (16 Nov 2026
    from Amwal Al Ghad, 29 Oct 2026's 34 billion in a 7.6-billion session from Youm7). Returns how many days."""
    names = list(SERIES.values()) + list(SPLIT.values())
    marks = ",".join("?" * len(names))
    days = [r[0] for r in conn.execute(f"SELECT DISTINCT date FROM macro WHERE series IN ({marks}) AND ABS(value) > ?",
                                       (*names, MAX_NET))]
    for day in days:
        conn.execute(f"DELETE FROM macro WHERE series IN ({marks}) AND date = ?", (*names, day))
    conn.commit()
    return len(days)


def update_totals(conn: sqlite3.Connection, session: requests.Session | None = None) -> int:
    """Download the sessions since the last one saved (about two years the first time). Returns how many were saved."""
    drop_impossible(conn)
    last = conn.execute("SELECT MAX(date) FROM macro WHERE series = ?", (SERIES["foreigners"],)).fetchone()[0]
    if last and last >= date.today().isoformat():
        return 0
    since = (datetime.fromisoformat(last) + timedelta(days=1)).date().isoformat() if last \
        else (date.today() - timedelta(days=BACKFILL_DAYS)).isoformat()
    found = fetch(since, session)
    split = {r[0] for r in conn.execute("SELECT date FROM macro WHERE series = ?", (SPLIT[("foreigners", "institutions")],))}
    found = {d: v for d, v in found.items() if d not in split}     # Youm7's are the exchange's own words: keep them
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



# ------------------------------------------------------------------ individuals and institutions (Youm7)
# "ومالت صافي تعاملات الأفراد العرب والمؤسسات المصرية والعربية والأجنبية للبيع بقيمة 7.7 مليون جنيه، 275.4 مليون جنيه،
# 57.7 مليون جنيه، 148 مليون جنيه، على الترتيب، فيما مالت تعاملات الأفراد المصريين والأجانب للشراء بقيمة 483.5 مليون جنيه،
# 5.3 مليون جنيه، على الترتيب". "الأفراد والمؤسسات الأجنبية" is foreign individuals then foreign institutions.
SITEMAP = "https://www.youm7.com/Sitemap/{y}/{m}/{d}"     # every story of that day
ROUNDUP = "أخبار-البورصة-اليوم"                           # its daily market roundup's address
KINDS = ("individuals", "institutions")
SPLIT = {(g, k): f"{SERIES[g]}_{k[:3] if k == 'individuals' else k[:4]}" for g in SERIES for k in KINDS}
SPLIT_TRIES = 6              # the last sessions without a split are tried each run (a roundup can come late or not at all)
SPLIT_BACK_PER_RUN = 20      # older sessions filled in each run, newest first, until BACKFILL_DAYS are there
READY = "15:30"              # Cairo: the day's roundup isn't out before this
SPLIT_VERSION = "2"          # a newer reader: the last month's days with a group left out are read again, once
_WHO = re.compile(r"(?<!\w)[وبل]?(?:ال)?(افراد|مؤسسات|مصري\w*|محلي\w*|عرب\w*|اجانب|اجنبي\w*)(?!\w)")


def _who(word: str) -> tuple[str, str]:
    if word in ("افراد", "مؤسسات"):
        return "kind", "individuals" if word == "افراد" else "institutions"
    return "group", "egyptians" if word.startswith(("مصري", "محلي")) else "arabs" if word.startswith("عرب") else "foreigners"


def parse_split(text: str) -> dict[str, dict[str, float]] | None:
    """{group: {individuals, institutions}}: net million EGP, or None unless at least four of the six are named and
    they add up to about zero (one left out was about even)."""
    out: dict[tuple, float] = {}
    twice: list[tuple] = []         # a group named again with the other side: Youm7's slip for the one it left out
    for clause in _CLAUSE.split(_normal(text)):
        sell, buy = "للبيع" in clause, "للشراء" in clause
        head, _, tail = clause.partition("بقيمة")
        if "مالت" not in head or not tail or sell == buy:
            continue
        blocks: list[tuple[list, list]] = []          # ([kinds], [groups]): each kind with each group, kinds first
        for w in _WHO.findall(head):
            role, val = _who(w)
            if role == "kind":
                if not blocks or blocks[-1][1]:
                    blocks.append(([], []))
                blocks[-1][0].append(val)
            elif blocks:
                blocks[-1][1].append(val)
        cells = [(g, k) for kinds, groups in blocks for k in kinds for g in groups]
        nums = _amounts(tail)
        if not cells or len(nums) < len(cells):
            continue
        for cell, v in zip(cells, nums):
            if cell in out and (out[cell] < 0) != sell and (cell, -v if sell else v) not in twice:   # a repeat isn't one
                twice.append((cell, -v if sell else v))
            out.setdefault(cell, -v if sell else v)
    left = [(g, k) for g in SERIES for k in KINDS if (g, k) not in out]
    # 5 Nov 2026: "الأفراد المصريين" bought 2.7M, but Egyptian individuals had sold; the foreign ones were left out
    if len(twice) == 1 and len(left) == 1 and left[0][1] == twice[0][0][1]:
        out[left[0]] = twice[0][1]
    if len(out) < 4:
        return None
    if not _even(out):      # one amount in thousands instead of millions (or the like): the one fix that evens it
        fixed = [o for c in out for f in (1000.0, 0.001) if _even(o := {**out, c: out[c] * f})]
        if len(fixed) != 1:
            return None
        out = fixed[0]
    return {g: {k: out.get((g, k), 0.0) for k in KINDS} for g in SERIES}


def _even(o: dict) -> bool:
    return abs(sum(o.values())) <= max(1.0, 0.03 * sum(abs(v) for v in o.values()))


def fetch_split(day: date, s: requests.Session, backup: bool = False, delay: float = 2.0) -> dict | None:
    """That session's split, from Youm7's roundup of the day, else (backup) Hapi Journal's closing story; None if
    neither has it or it doesn't read well."""
    r = s.get(SITEMAP.format(y=day.year, m=day.month, d=day.day), timeout=60)
    if r.status_code == 200:
        # only the roundup has the sentence (the day's closing stories don't); some days have none (16 Nov 2026)
        for url in [u for u in re.findall(r"<loc>([^<]+)</loc>", r.text) if ROUNDUP in urllib.parse.unquote(u)][:2]:
            page = s.get(url, timeout=60)
            got = parse_split(page.text) if page.ok else None
            if got:
                return got
    return fetch_hapi(day, s, delay) if backup else None


# Hapi Journal's closing story repeats the exchange's statement one group a sentence: "وسيطر الاتجاه البيعي على تعاملات
# المستثمرين المصريين وسجلوا صافي بقيمة 194.585 مليون جنيه، بضغط من المؤسسات التي حققت صافي بيع بقيمة 289.595 مليون
# جنيه، مقابل 95.009 مليون جنيه صافي شراء من الافراد" / "…العرب نحو الشراء محققين صافي بقيمة 115.018 مليون جنيه، منها
# 84.042 مليون جنيه للمؤسسات، و30.976 مليون جنيه للافراد". Its robots.txt allows everything; its JSON feed is closed.
HAPI_DAY = "https://hapijournal.com/{y}/{m:02d}/{d:02d}/"
ON_GITHUB = os.environ.get("GITHUB_ACTIONS") == "true"   # Hapi turns GitHub's runs away: the Mac reads it (app/macfeed.py)
HAPI_PAGES = 6                 # the day's list, 20 stories a page, newest first
_SELL = re.compile(r"بيع|البيعي")
_BUY = re.compile(r"شراء|الشرائي")


def parse_hapi(text: str) -> dict[str, dict[str, float]] | None:
    out: dict[str, dict[str, float]] = {}
    for sent in re.split(r"(?<!\d)\.|\.(?!\d)|\n", _normal(text)):
        words = [_who(w) for w in _WHO.findall(sent)]
        groups = [v for r, v in words if r == "group"]
        kinds = list(dict.fromkeys(_who(w)[1] for w in re.findall(r"افراد|مؤسسات", sent)))   # للمؤسسات too
        nums = _amounts(sent.partition("بقيمة")[2] or sent)
        if not groups or sorted(kinds) != sorted(KINDS) or len(nums) < 3 or groups[0] in out:
            continue
        lead = sent[:sent.find("بقيمة")] if "بقيمة" in sent else sent
        sell, buy = bool(_SELL.search(lead)), bool(_BUY.search(lead))
        if sell == buy:
            continue
        total = -nums[0] if sell else nums[0]
        a, b = nums[1], nums[2]
        fits = [(x, y) for x in (a, -a) for y in (b, -b) if abs(x + y - total) <= max(0.01, 0.005 * abs(total))]
        if len(fits) != 1:
            continue
        out[groups[0]] = dict(zip(kinds, fits[0]))
    if len(out) != 3:
        return None
    flat = {(g, k): out[g][k] for g in out for k in KINDS}
    return {g: {k: out[g][k] for k in KINDS} for g in SERIES} if _even(flat) else None


def _after_close(page: str, day: date) -> bool:
    """Posted that day after the close (Cairo): a morning story repeats an earlier session's numbers (16 Nov 2026)."""
    m = re.search(r'article:published_time" content="([^"]+)"', page)
    if not m:
        return False
    at = datetime.fromisoformat(m.group(1)).astimezone(ZoneInfo("Africa/Cairo"))
    return at.date() == day and at.strftime("%H:%M") >= CLOSE


def fetch_hapi(day: date, s: requests.Session, delay: float = 2.0) -> dict | None:
    """Hapi's story for that day: its day pages list the stories; the market ones are read until one has the split."""
    base = HAPI_DAY.format(y=day.year, m=day.month, d=day.day)
    tried: set[str] = set()
    for n in range(1, HAPI_PAGES + 1):
        time.sleep(delay)
        r = s.get(base if n == 1 else f"{base}page/{n}/", timeout=60)
        if r.status_code != 200:
            return None
        links = [u for u in dict.fromkeys(re.findall(rf'href="({re.escape(base)}[^"/]+/)"', r.text))
                 if "البورصة" in urllib.parse.unquote(u) and u not in tried]
        for url in links:
            tried.add(url)
            time.sleep(delay)
            page = s.get(url, timeout=60)
            got = parse_hapi(page.text) if page.ok and _after_close(page.text, day) else None
            if got:
                return got
        if f"{base}page/{n + 1}/" not in r.text:
            return None
    return None


def update_split(conn: sqlite3.Connection, session: requests.Session | None = None, delay: float = 2.0,
                 now: datetime | None = None) -> int:
    """The new sessions' split, and SPLIT_BACK_PER_RUN older ones each run until about two years are there. Each
    group's net then comes from it too (Amwal Al Ghad's reports got the direction or the names wrong on about a third
    of the days they share with Youm7). Returns how many sessions were saved."""
    now = now or datetime.now(ZoneInfo("Africa/Cairo"))
    today = now.date().isoformat()
    key = SPLIT[("foreigners", "institutions")]
    newest = conn.execute("SELECT MAX(date) FROM macro WHERE series = ?", (key,)).fetchone()[0]
    sessions = [r[0] for r in conn.execute("SELECT date FROM prices WHERE symbol = ? AND date >= ? AND date <= ? "
                                           "ORDER BY date", (INDEX_SYMBOL, (now.date() - timedelta(days=BACKFILL_DAYS))
                                                              .isoformat(), today))]
    have = {r[0] for r in conn.execute("SELECT date FROM macro WHERE series = ? AND date >= ?",
                                       (key, sessions[-SPLIT_TRIES] if len(sessions) >= SPLIT_TRIES else ""))}
    new = [d for d in sessions[-SPLIT_TRIES:] if d not in have]     # a day both sources missed is tried again
    new = [d for d in new if d < today or now.strftime("%H:%M") >= READY]
    back = db.get_meta(conn, "flows_split_back") or (new[0] if new else newest or today)   # the oldest one tried
    older = [d for d in sessions if d < back][::-1][:SPLIT_BACK_PER_RUN]
    again = []
    if db.get_meta(conn, "flows_split_v") != SPLIT_VERSION:   # the days the card shows that have a group at exactly 0
        again = [r["date"] for r in recent_split(conn) if any(v == 0.0 for g in SERIES for v in r[g].values())]
        again = [d for d in again if d not in new]
    s = session or requests.Session()
    s.headers.update({"User-Agent": UA})
    saved = 0
    for i, day in enumerate(new + again + older):
        if i:
            time.sleep(delay)
        got = fetch_split(date.fromisoformat(day), s, backup=day in new and not ON_GITHUB, delay=delay)
        if got and max(abs(v) for g in got.values() for v in g.values()) > MAX_NET:
            got = None                         # the debt market, not shares (drop_impossible)
        if got:
            conn.executemany("INSERT OR REPLACE INTO macro(series, date, value) VALUES (?,?,?)",
                             [(SPLIT[(g, k)], day, got[g][k]) for g in SERIES for k in KINDS]
                             + [(SERIES[g], day, sum(got[g].values())) for g in SERIES])
            saved += 1
        if day in older:
            db.set_meta(conn, "flows_split_back", day)
        conn.commit()
    db.set_meta(conn, "flows_split_v", SPLIT_VERSION)
    conn.commit()
    return saved


def recent_split(conn: sqlite3.Connection, sessions: int = 25) -> list[dict]:
    """The last sessions' split, oldest first: [{date, egyptians: {individuals, institutions}, arabs: …}]."""
    names = {v: k for k, v in SPLIT.items()}
    rows = conn.execute(f"SELECT series, date, value FROM macro WHERE series IN ({','.join('?' * len(names))}) "
                        "AND date IN (SELECT DISTINCT date FROM macro WHERE series = ? ORDER BY date DESC LIMIT ?)",
                        (*names, SPLIT[("foreigners", "institutions")], sessions)).fetchall()
    by_day: dict[str, dict] = {}
    for series, day, value in rows:
        g, k = names[series]
        by_day.setdefault(day, {"date": day, **{x: {} for x in SERIES}})[g][k] = value
    return [by_day[d] for d in sorted(by_day)]
