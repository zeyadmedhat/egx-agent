"""News and corporate actions (dividends, bonus shares, rights issues) for every EGX stock, from reliable sources.

- Mubasher (mubasher.info): its corporate-actions list, taken from the exchange's filings, with the day each one
  was announced and its ex-date (every EGX company, back to 2005), plus each stock's own news page in Arabic and
  English and the latest Egypt market news. Mubasher asks robots to wait 5 seconds between pages, so each run
  reads only some stock pages: today's signals first, then the ones read longest ago.
- Reuters and Zawya, through TradingView's news feed: tagged to the exact stock.
- Al Borsa News (Arabic) and Daily News Egypt (English): general market and economy news, from their RSS feeds.

Only headlines, dates and links are kept (the articles belong to their publishers). Each headline gets topic tags
and a tone (good / bad / neutral) from keyword rules in Arabic and English: a quick guide, not a reading of the
article. Dividend and bonus-share events were tested walk-forward in 2026-09 (see predict.py); the news tone
isn't used by the model until there's enough history to test it.
"""
from __future__ import annotations

import html
import json
import re
import sqlite3
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Callable, Iterable
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import requests

from .. import db

CAIRO = ZoneInfo("Africa/Cairo")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/128.0 Safari/537.36")
MUBASHER = {"ar": "https://www.mubasher.info", "en": "https://english.mubasher.info"}
MUBASHER_DELAY = 5.0          # seconds between pages on each Mubasher site (their robots.txt Crawl-delay)
CA_PAGE = 500                 # corporate actions per request (the whole history is ~13 pages)
TV_NEWS = "https://news-headlines.tradingview.com/v2/headlines"
TV_PROVIDERS = {"reuters": "Reuters", "zawya": "Zawya", "dow-jones": "Dow Jones", "lse": "LSE filings"}
TV_MAX_SYMBOLS = 3         # a story tagged to more stocks than this is a market round-up, kept as market news
FEEDS = {                     # source: (url, language, the categories kept: None = all)
    "alborsa": ("https://www.alborsaanews.com/feed", "ar", {"البورصة", "البورصة والشركات"}),
    "dne": ("https://www.dailynewsegypt.com/category/business/feed/", "en", None),
}
SOURCES = {"mubasher": "Mubasher", "alborsa": "Al Borsa News", "dne": "Daily News Egypt", **TV_PROVIDERS}
BUDGET_S = 240                # time for Mubasher's stock pages per run (about 45 pages)
KEEP_DAYS = 730               # market news older than this is dropped; a stock's own news is kept

# Corporate actions: Mubasher's English type -> our kind (anything else is "other")
KINDS = {
    "Cash Dividends": "dividend", "Bonus Shares Distribution": "bonus", "Stock Split": "split",
    "Capital Increase - Rights Issue": "rights", "Capital Increase - Private Placement": "placement",
    "Buying Treasury Stocks": "treasury_buy", "Selling Treasury Stocks": "treasury_sell",
    "Capital Reduction - Cancellation Of Treasury Stock": "treasury_cancel", "Stock Consolidation": "consolidation",
    "Capital Reduction - Decreaseing Total Number Of Shares": "reduction",
    "Capital Reduction - Redusing Par Value": "reduction",
}
KIND_LABELS = {
    "dividend": "Cash dividend", "bonus": "Bonus shares", "split": "Stock split", "rights": "Rights issue",
    "placement": "Private placement", "treasury_buy": "Buying back shares", "treasury_sell": "Selling treasury shares",
    "treasury_cancel": "Cancelling treasury shares", "consolidation": "Share consolidation",
    "reduction": "Capital reduction", "other": "Other",
}

# ------------------------------------------------------------------ tags and tone (keyword rules)
TAGS = {                      # tag: (English pattern, Arabic pattern)
    "dividend": (r"dividend|coupon|cash distribution", r"كوبون|توزيع(ات)?\s+(ال)?أرباح|أرباح\s+نقدية|توزيعات\s+نقدية"),
    "bonus": (r"bonus share|free share|stock dividend", r"أسهم\s+(ال)?مجانية|أسهم\s+منحة|منحة\s+مجانية"),
    "results": (r"profit|net income|earnings|revenue|results|\bloss(es)?\b|\bQ[1-4]\b|\b[39]M\b|\bH[12]\b",
                r"أرباح|خسائر|صافي\s+(ال)?ربح|نتائج|إيرادات|مبيعات|الربع\s+(الأول|الثاني|الثالث|الرابع)"),
    "capital": (r"capital (increase|hike|rise)|rights issue", r"رأس\s*المال|رأسمال|اكتتاب"),
    "deal": (r"acqui|stake|merger|deal|contract|agreement|partnership|\bMoU\b",
             r"استحواذ|صفقة|اندماج|حصة|عقد|اتفاقي|تعاقد|شراكة|مذكرة\s+تفاهم"),
    "financing": (r"\bloan|financing|facility|bond|sukuk|securiti", r"تمويل|قرض|سندات|صكوك|توريق"),
    "legal": (r"lawsuit|suspen|halt|investigat|\bfine[ds]?\b|delist|court|penalt",
              r"دعوى|إيقاف|وقف\s+التداول|تعليق|شطب|غرامة|تحقيق|محكمة|مخالف"),
    "meeting": (r"general assembly|\bAGM\b|\bEGM\b|board", r"الجمعية|مجلس\s+(ال)?إدارة|مساهمو"),
    "buyback": (r"treasury|buy ?back", r"أسهم\s+(ال)?خزينة|شراء\s+أسهم"),
    "analysis": (r"technical|support|resistance|uptrend|downtrend|indicators", r"فني|الدعم|المقاومة|مؤشرات\s+فنية"),
}
GOOD = (r"\brise|\brises|\brose|jump|leap|surge|soar|higher|grow|growth|record|increase|\bup\b|beat|boost|gain|"
        r"skyrocket|double|approv|\bwins?\b|award|expan|narrow",
        r"ارتفاع|ترتفع|يرتفع|ارتفع|قفز|نمو|تنمو|ينمو|زياد|تزيد|يزيد|صعود|تصعد|يصعد|قياسي|تضاعف|يتضاعف|"
        r"توسع|تفوز|يفوز|فوز|موافق|تقلص\s+(ال)?خسائر")
BAD = (r"\bfall|\bfell|drop|decline|lower|\bloss|plunge|slump|\bdown\b|\bcut|suspen|lawsuit|halt|slide|shrink|"
       r"tumble|widen|default|\bfine[ds]?\b|delist|probe",
       r"تراجع|يتراجع|انخفاض|تنخفض|ينخفض|هبوط|تهبط|يهبط|خسائر|خسارة|إيقاف|تعليق|دعوى|غرامة|شطب|تقلص|يتقلص|"
       r"انكماش|ضعف|تعثر|ارتفاع\s+(ال)?خسائر")
_TAG_RE = {t: (re.compile(en, re.I), re.compile(ar)) for t, (en, ar) in TAGS.items()}
_GOOD = (re.compile(GOOD[0], re.I), re.compile(GOOD[1]))
_BAD = (re.compile(BAD[0], re.I), re.compile(BAD[1]))
_ARABIC = re.compile(r"[؀-ۿ]")


def classify(title: str) -> tuple[list[str], int]:
    """Topic tags and a tone (1 good, -1 bad, 0 neutral or mixed) for a headline, by keyword rules."""
    i = 1 if _ARABIC.search(title) else 0
    tags = [t for t, pats in _TAG_RE.items() if pats[i].search(title)]
    good, bad = len(_GOOD[i].findall(title)), len(_BAD[i].findall(title))
    if "legal" in tags:
        bad += 1
    if re.search(r"narrow|تقلص\s+(ال)?خسائر", title, re.I):      # a smaller loss is good news
        bad = max(bad - 2, 0)
    return tags, (good > bad) - (bad > good)


# ------------------------------------------------------------------ dates
EN_MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                          "september", "october", "november", "december"], 1)}
AR_MONTHS = {"يناير": 1, "فبراير": 2, "مارس": 3, "أبريل": 4, "إبريل": 4, "ابريل": 4, "مايو": 5, "يونيو": 6,
             "يوليو": 7, "أغسطس": 8, "اغسطس": 8, "سبتمبر": 9, "أكتوبر": 10, "اكتوبر": 10, "نوفمبر": 11, "ديسمبر": 12}
_DATE_RE = re.compile(r"^(\d{1,2})\s+(\S+)(?:\s+(\d{4}))?(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM|ص|م))?")
_AGO_RE = re.compile(r"(\d+)?\s*(minute|min|hour|day|دقيقة|دقائق|ساعة|ساعات|ساعتين|يوم|أيام|يومين)", re.I)


def _now() -> datetime:
    return datetime.now(CAIRO).replace(tzinfo=None)


def parse_date(text: str, now: datetime | None = None) -> datetime | None:
    """Mubasher's dates, in Cairo time: "25 March 01:26 PM", "28 December 2025 03:23 PM", "24 سبتمبر 11:25 ص",
    "13 May 2025", or "4 ساعات مضت" / "11 minutes ago". A date without a year is the latest one not in the future."""
    now = now or _now()
    text = html.unescape(text or "").strip()
    m = _DATE_RE.match(text)
    if m:
        day, month, year, hh, mm, ampm = m.groups()
        month_n = EN_MONTHS.get(month.lower()) or AR_MONTHS.get(month)
        if month_n:
            h = int(hh) % 12 + (12 if ampm in ("PM", "م") else 0) if hh else 0
            try:
                d = datetime(int(year or now.year), month_n, int(day), h, int(mm or 0))
            except ValueError:
                return None
            if not year and d > now + timedelta(days=1):
                d = d.replace(year=d.year - 1)
            return d
    m = _AGO_RE.search(text)
    if m and ("ago" in text.lower() or "مضت" in text or "منذ" in text):
        n = int(m.group(1) or (2 if m.group(2) in ("ساعتين", "يومين") else 1))
        unit = m.group(2).lower()
        if unit.startswith(("min", "دقي", "دقا")):
            return now - timedelta(minutes=n)
        if unit.startswith(("hour", "ساع")):
            return now - timedelta(hours=n)
        return now - timedelta(days=n)
    return None


def _iso(d: datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%M")


def _cairo(ts: float) -> datetime:
    return datetime.fromtimestamp(ts, timezone.utc).astimezone(CAIRO).replace(tzinfo=None)


# ------------------------------------------------------------------ fetching
class Fetcher:
    """One requests session that waits between pages on the same site (Mubasher: 5 seconds)."""

    def __init__(self, session: requests.Session | None = None, delay: float = MUBASHER_DELAY):
        self.s = session or requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept-Language": "ar,en;q=0.8"})
        self.delay = delay
        self.last: dict[str, float] = {}

    def get(self, url: str, polite: bool = True, **kw) -> requests.Response:
        host = url.split("/")[2]
        if polite:
            wait = self.last.get(host, 0) + self.delay - time.monotonic()
            if wait > 0:
                time.sleep(wait)
        try:
            return self.s.get(url, timeout=30, **kw)
        finally:
            self.last[host] = time.monotonic()


def _mubasher_symbol(url: str) -> str:
    return url.rstrip("/").rsplit("/", 1)[-1].split("_")[0]


def _ca_date(text: str | None) -> str | None:
    d = parse_date(text) if text else None
    return d.date().isoformat() if d else None


def fetch_corporate_actions(f: Fetcher, pages: int) -> list[dict]:
    rows = []
    for p in range(pages):
        r = f.get(f"{MUBASHER['en']}/api/1/corporate-actions",
                  params={"country": "eg", "start": p * CA_PAGE, "size": CA_PAGE})
        r.raise_for_status()
        data = r.json()
        for x in data.get("rows", []):
            ann, eff = _ca_date(x.get("announcedAt")), _ca_date(x.get("effectiveFrom"))
            if eff and ann and ann > eff:
                ann = eff          # a few are dated after the ex-date: it was public by then at the latest
            note = (x.get("description") or "").strip()
            rows.append({"symbol": _mubasher_symbol(x.get("url", "")), "type": x.get("type") or "",
                         "kind": KINDS.get(x.get("type"), "other"), "announced": ann or "", "effective": eff or "",
                         "note": note if len(note) > 30 else ""})
        if p + 1 >= int(data.get("numberOfPages") or 1):
            break
    return rows


_BLOCK_RE = re.compile(
    r'mi-article-media-block__date">([^<]*)</span>\s*<a class="mi-article-media-block__title" href="(/news/(\d+)[^"]*)"'
    r'>([^<]*)</a>', re.S)


def parse_mubasher(page: str, lang: str, now: datetime | None = None) -> list[dict]:
    out = []
    for date_s, path, nid, title in _BLOCK_RE.findall(page):
        d = parse_date(date_s, now)
        title = html.unescape(title).strip()
        if d and title:
            out.append({"id": f"mubasher:{nid}", "source": "mubasher", "lang": lang, "published": _iso(d),
                        "title": title, "url": MUBASHER[lang] + path})
    return out


def fetch_tv(f: Fetcher, symbol: str | None = None) -> list[dict]:
    """Reuters/Zawya headlines: one stock's (about a year), or the whole Egyptian market's latest (symbol None)."""
    params = {"client": "web", "lang": "en"}
    params.update({"symbol": f"EGX:{symbol}"} if symbol else {"category": "stock", "market_country": "EG"})
    r = f.get(TV_NEWS, polite=False, params=params)
    r.raise_for_status()
    out = []
    for x in r.json().get("items", []):
        if x.get("provider") not in TV_PROVIDERS or not x.get("published"):
            continue
        related = x.get("relatedSymbols") or []
        syms = [s["symbol"].split(":", 1)[1] for s in related if s.get("symbol", "").startswith("EGX:")]
        if not syms:
            continue
        if len(related) > TV_MAX_SYMBOLS:
            syms = [""]
        title = re.sub(r"^((ZAWYA|REUTERS)(-[A-Z]+)?|SNG|REG)\s*[:-]\s*", "", x.get("title", "")).strip()
        out.append({"id": f"tv:{x['id']}", "source": x["provider"], "lang": "en",
                    "published": _iso(_cairo(x["published"])), "title": title,
                    "url": "https://www.tradingview.com" + x.get("storyPath", ""), "symbols": syms})
    return out


def fetch_feed(f: Fetcher, source: str) -> list[dict]:
    url, lang, keep = FEEDS[source]
    r = f.get(url, polite=False)
    r.raise_for_status()
    out = []
    for item in ET.fromstring(r.content).iter("item"):
        cats = {(c.text or "").strip() for c in item.findall("category")}
        if keep and not cats & keep:
            continue
        try:
            d = parsedate_to_datetime(item.findtext("pubDate") or "").astimezone(CAIRO).replace(tzinfo=None)
        except (TypeError, ValueError):
            continue
        link = (item.findtext("link") or "").strip()
        title = html.unescape(item.findtext("title") or "").strip()
        if title and link:
            out.append({"id": f"{source}:{link}", "source": source, "lang": lang, "published": _iso(d),
                        "title": title, "url": link})
    return out


# ------------------------------------------------------------------ storage
def save_news(conn: sqlite3.Connection, items: Iterable[dict], symbol: str = "") -> int:
    """Store headlines (for one stock, or the market: ""). Returns how many were new."""
    now = datetime.now().isoformat(timespec="seconds")
    before = conn.total_changes
    for it in items:
        tags, tone = classify(it["title"])
        for sym in it.get("symbols") or [symbol]:
            conn.execute(
                """INSERT OR IGNORE INTO news(id, symbol, source, lang, published, title, url, tags, tone, first_seen)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (it["id"], sym, it["source"], it["lang"], it["published"], it["title"], it["url"], ",".join(tags),
                 tone, now))
    conn.commit()
    return conn.total_changes - before


def save_corporate_actions(conn: sqlite3.Connection, rows: list[dict]) -> int:
    """Store corporate actions. Returns how many were new."""
    now = datetime.now().isoformat(timespec="seconds")
    before = conn.execute("SELECT COUNT(*) FROM corp_actions").fetchone()[0]
    for r in rows:
        if not r["symbol"]:
            continue
        conn.execute(
            """INSERT INTO corp_actions(symbol, kind, type, announced, effective, note, first_seen)
               VALUES (?,?,?,?,?,?,?) ON CONFLICT(symbol, type, announced, effective) DO UPDATE SET note=excluded.note""",
            (r["symbol"], r["kind"], r["type"], r["announced"], r["effective"], r["note"], now))
    conn.commit()
    return conn.execute("SELECT COUNT(*) FROM corp_actions").fetchone()[0] - before


def update_actions(conn: sqlite3.Connection, fetcher: Fetcher | None = None) -> int:
    """Only the corporate actions (all of them the first time, about a minute): the prediction model needs them."""
    full = conn.execute("SELECT COUNT(*) FROM corp_actions").fetchone()[0] == 0
    return save_corporate_actions(conn, fetch_corporate_actions(fetcher or Fetcher(), 20 if full else 1))


def _checked(conn) -> dict:
    try:
        return json.loads(db.get_meta(conn, "news_checked") or "{}")
    except ValueError:
        return {}


def update(conn: sqlite3.Connection, first: Iterable[str] = (), budget_s: float = BUDGET_S,
           fetcher: Fetcher | None = None, progress: Callable[[str], None] | None = None) -> dict:
    """Download what's new from every source. first: stocks whose Mubasher pages are read before the others
    (today's signals). Returns counts, and the sources that failed (the others still update)."""
    f = fetcher or Fetcher()
    say = progress or (lambda msg: None)
    res = {"new": 0, "actions": 0, "stocks": 0, "failed": [], "tried": []}

    def attempt(name: str, fn):
        res["tried"].append(name)
        try:
            return fn()
        except Exception:            # one source down must not stop the others
            res["failed"].append(name)
            return None

    say("Dividends and bonus shares (Mubasher)…")
    res["actions"] = attempt("Mubasher corporate actions", lambda: update_actions(conn, f)) or 0

    say("Reuters and Zawya (TradingView)…")
    items = attempt("Reuters/Zawya", lambda: fetch_tv(f))
    if items:
        res["new"] += save_news(conn, items)
    for source in FEEDS:
        items = attempt(SOURCES[source], lambda: fetch_feed(f, source))
        if items:
            res["new"] += save_news(conn, items)
    for lang in ("ar", "en"):
        page = attempt("Mubasher latest news", lambda: f.get(f"{MUBASHER[lang]}/news/eg/now/latest").text)
        if page:
            res["new"] += save_news(conn, parse_mubasher(page, lang))

    # Each stock's own pages: today's signals first, then the ones read longest ago. The first time a stock is
    # read, its year of Reuters/Zawya news comes too (TradingView doesn't ask for a pause).
    symbols = [r[0] for r in conn.execute(
        "SELECT symbol FROM stocks WHERE price_missing_since IS NULL AND symbol IN (SELECT DISTINCT symbol FROM prices)")]
    checked = _checked(conn)
    first = [s for s in dict.fromkeys(first) if s in symbols]
    order = first + sorted((s for s in symbols if s not in first),
                           key=lambda s: checked.get(s, {}).get("mubasher", ""))
    start = time.monotonic()
    misses = 0
    for sym in order:
        if time.monotonic() - start > budget_s:
            break
        say(f"News for {sym}…")
        state = checked.setdefault(sym, {})
        if "tv" not in state:
            items = attempt("Reuters/Zawya", lambda: fetch_tv(f, sym))
            if items is not None:
                res["new"] += save_news(conn, items)
                state["tv"] = datetime.now().isoformat(timespec="seconds")
        ok = True
        for lang in ("ar", "en"):
            r = attempt("Mubasher stock pages", lambda: f.get(f"{MUBASHER[lang]}/markets/EGX/stocks/{sym}/news"))
            if r is None or r.status_code != 200:
                ok = False
                continue
            res["new"] += save_news(conn, parse_mubasher(r.text, lang), sym)
        if ok:
            state["mubasher"] = datetime.now().isoformat(timespec="seconds")
            res["stocks"] += 1
            misses = 0
        else:
            misses += 1
            if misses >= 3:            # the site isn't answering: try again next run
                res["failed"].append("Mubasher stock pages")
                break
    db.set_meta(conn, "news_checked", json.dumps(checked))
    conn.execute("DELETE FROM news WHERE symbol = '' AND published < ?",
                 (_iso(_now() - timedelta(days=KEEP_DAYS)),))
    conn.commit()
    res["failed"] = sorted(set(res["failed"]))
    res["tried"] = sorted(set(res["tried"]))
    db.set_meta(conn, "news_updated", datetime.now().isoformat(timespec="seconds"))
    return res


# ------------------------------------------------------------------ the prediction model's event features
EVENT_FEATURES = [
    "div_ex_ahead", "div_since_ex", "div_since_ann", "n_div_3y",   # cash dividends: next ex-date, the last one, how often
    "bonus_ex_ahead", "bonus_since_ann",                           # bonus shares
    "rights_ex_ahead", "treasury_since_ann",                       # a rights issue coming; a share buyback announced
]
NONE_DAYS = 9999.0            # "no such event": far away, so the model reads it as nothing near


def load_events(conn: sqlite3.Connection) -> pd.DataFrame:
    """Corporate actions as (symbol, kind, announced, effective) with dates (for event_features)."""
    df = pd.read_sql_query("SELECT symbol, kind, announced, effective FROM corp_actions WHERE announced != ''", conn)
    for c in ("announced", "effective"):
        df[c] = pd.to_datetime(df[c].replace("", None))
    return df


def event_features(ds: pd.DataFrame, events: pd.DataFrame) -> pd.DataFrame:
    """For each (symbol, date) row of ds: days to the next announced ex-date and since the last announcement or
    ex-date, per kind, using only events announced before that day (an announcement on the day itself may come
    after the close). Days are calendar days; NONE_DAYS when there's none."""
    out = pd.DataFrame(NONE_DAYS, index=ds.index, columns=EVENT_FEATURES, dtype="float64")
    out["n_div_3y"] = 0.0
    if events is None or events.empty:
        return out
    def days(x) -> np.ndarray:                                           # dates as float days (NaT -> nan)
        v = pd.to_datetime(pd.Series(x)).to_numpy(dtype="datetime64[D]").astype("float64")
        v[pd.isna(pd.Series(x)).to_numpy()] = np.nan
        return v

    by_sym = {s: g for s, g in events.groupby("symbol")}
    for sym, rows in ds.groupby("symbol").groups.items():
        e = by_sym.get(sym)
        if e is None:
            continue
        t = days(ds.loc[rows, "date"].to_numpy())[:, None]                # rows × 1
        for kind, pre in (("dividend", "div"), ("bonus", "bonus"), ("rights", "rights"), ("treasury_buy", "treasury")):
            k = e[e["kind"] == kind]
            if k.empty:
                continue
            ann, eff = days(k["announced"].to_numpy())[None, :], days(k["effective"].to_numpy())[None, :]
            known = ann < t                                               # rows × events
            if f"{pre}_since_ann" in out:
                last = np.where(known, ann, -np.inf).max(axis=1)
                out.loc[rows, f"{pre}_since_ann"] = np.where(np.isfinite(last), t[:, 0] - last, NONE_DAYS)
            if f"{pre}_ex_ahead" in out:
                nxt = np.where(known & (eff > t), eff, np.inf).min(axis=1)
                out.loc[rows, f"{pre}_ex_ahead"] = np.where(np.isfinite(nxt), nxt - t[:, 0], NONE_DAYS)
            if pre == "div":
                past = known & (eff <= t)
                last = np.where(past, eff, -np.inf).max(axis=1)
                out.loc[rows, "div_since_ex"] = np.where(np.isfinite(last), t[:, 0] - last, NONE_DAYS)
                out.loc[rows, "n_div_3y"] = (past & (eff > t - 1095)).sum(axis=1)
    return out


# ------------------------------------------------------------------ reading
def _rows(cur) -> list[dict]:
    cols = [c[0] for c in cur.description]
    out = []
    for r in cur.fetchall():
        d = dict(zip(cols, r))
        if "tags" in d:
            d["tags"] = [t for t in (d["tags"] or "").split(",") if t]
        out.append(d)
    return out


def stock_news(conn: sqlite3.Connection, symbol: str, limit: int = 30) -> list[dict]:
    """A stock's headlines, newest first."""
    return _rows(conn.execute(
        "SELECT id, source, lang, published, title, url, tags, tone FROM news WHERE symbol = ? "
        "ORDER BY published DESC LIMIT ?", (symbol, limit)))


def recent_news(conn: sqlite3.Connection, days: int = 30, limit: int = 1500) -> list[dict]:
    """Every headline of the last `days` days (market news has symbol "")."""
    return _rows(conn.execute(
        "SELECT id, symbol, source, lang, published, title, url, tags, tone FROM news WHERE published >= ? "
        "ORDER BY published DESC LIMIT ?", (_iso(_now() - timedelta(days=days)), limit)))


def actions(conn: sqlite3.Connection, symbol: str | None = None, since: str | None = None,
            kinds: Iterable[str] | None = None) -> list[dict]:
    """Corporate actions, newest first. since: only those with an ex-date on or after it (or announced since then,
    when there's no ex-date)."""
    sql = "SELECT symbol, kind, type, announced, effective, note FROM corp_actions WHERE 1=1"
    args: list = []
    if symbol:
        sql += " AND symbol = ?"
        args.append(symbol)
    if since:
        sql += " AND (effective >= ? OR (effective = '' AND announced >= ?))"
        args += [since, since]
    kinds = list(kinds or [])
    if kinds:
        sql += f" AND kind IN ({','.join('?' * len(kinds))})"
        args += kinds
    rows = _rows(conn.execute(sql + " ORDER BY CASE effective WHEN '' THEN announced ELSE effective END DESC", args))
    return [{**r, "label": KIND_LABELS.get(r["kind"], r["type"])} for r in rows]


def cautions(conn: sqlite3.Connection, symbol: str, today: str, hold_days: int = 30, news_days: int = 5,
             div: dict | None = None) -> list[dict]:
    """What a buyer of this stock should know now: an ex-dividend date within the next month (the price drops by
    the dividend that morning, which can hit a stop), bonus shares or a rights issue coming, or bad news this week.
    div: the stock's next cash dividend from TradingView ({ex_date, amount}), to name the amount."""
    out = []
    day = datetime.fromisoformat(today)
    end = (day + timedelta(days=hold_days)).date().isoformat()
    tomorrow = (day + timedelta(days=1)).date().isoformat()
    exes = {}
    for a in actions(conn, symbol, since=tomorrow, kinds=("dividend", "bonus", "rights", "split")):
        if not a["effective"] or a["effective"] > end or a["announced"] > today:
            continue
        if a["kind"] == "dividend":
            exes[a["effective"]] = None
        elif a["kind"] in ("bonus", "split"):
            out.append({"kind": a["kind"], "date": a["effective"], "level": "info",
                        "text": f"{a['label']} on {a['effective']}: the price is re-based that day and you get "
                                "more shares, so it isn't a loss."})
        else:
            out.append({"kind": "rights", "date": a["effective"], "level": "info",
                        "text": f"Rights issue, ex-date {a['effective']}: the price usually adjusts that day."})
    if div and div.get("ex_date") and tomorrow <= div["ex_date"] <= end:
        exes[div["ex_date"]] = div.get("amount")
    for ex, amount in sorted(exes.items()):
        # Not a reason to skip a BUY: counting the dividend, BUYs just before an ex-date did as well as the others
        # (2016–2026). What matters is that the drop doesn't sell by itself, so the stop moves down for it.
        out.insert(0, {"kind": "ex_dividend", "date": ex, "level": "info", "amount": amount,
                       "text": f"Goes ex-dividend on {ex}" + (f" ({amount:g} EGP a share)" if amount else "")
                               + ": the price drops by the dividend that morning and holders get it in cash. "
                                 "The agent lowers the stop and target by the same amount that day."})
    since = (day - timedelta(days=news_days)).strftime("%Y-%m-%dT00:00")
    for n in _rows(conn.execute(
            "SELECT source, published, title, url, tags, tone FROM news WHERE symbol = ? AND published >= ? "
            "AND tone < 0 ORDER BY published DESC LIMIT 2", (symbol, since))):
        out.append({"kind": "bad_news", "date": n["published"][:10], "level": "warn", "url": n["url"],
                    "title": n["title"], "source": SOURCES.get(n["source"], n["source"]),
                    "text": f"Bad news this week? “{n['title']}” ({SOURCES.get(n['source'], n['source'])})"})
    return out
