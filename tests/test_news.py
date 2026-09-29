"""News and corporate actions: parsing each source, tags and tone, storage, cautions, the model's event features."""
import json
from datetime import date, datetime, timedelta

import pandas as pd
import pytest

from app import alerts, static_site, views
from egx_agent import db
from egx_agent.data import news

NOW = datetime(2026, 9, 28, 18, 0)


def test_mubasher_dates():
    p = lambda s: news.parse_date(s, NOW)
    assert p("25 March 01:26 PM") == datetime(2026, 3, 25, 13, 26)
    assert p("28 December 2025 03:23 PM") == datetime(2025, 12, 28, 15, 23)
    assert p("24 November 2025 00:07 PM") == datetime(2025, 11, 24, 12, 7)
    assert p("24 سبتمبر 11:25 ص") == datetime(2026, 9, 24, 11, 25)
    assert p("7 سبتمبر 04:26 م") == datetime(2026, 9, 7, 16, 26)
    assert p("15 December 09:00 AM") == datetime(2025, 12, 15, 9, 0)      # no year and later than today: last year
    assert p("13 May 2025") == datetime(2025, 5, 13)
    assert p("4 ساعات مضت") == NOW - timedelta(hours=4)
    assert p("11 دقائق مضت") == NOW - timedelta(minutes=11)
    assert p("3 hours ago") == NOW - timedelta(hours=3)
    assert p("") is None and p("soon") is None


@pytest.mark.parametrize("title, tags, tone", [
    ("CIB's consolidated profits leap to EGP 17.8bn in Q1-26", {"results"}, 1),
    ("Juhayna's net profit falls 20% in H1", {"results"}, -1),
    ("EFG Hermes narrows losses in 9M", {"results"}, 1),
    ("CIB unveils dividends for 2025, capital hike", {"dividend", "capital"}, 0),
    ("Egypt's FRA suspends trading on shares of XYZ", {"legal"}, -1),
    ("22 أكتوبر.. مساهمو القاهرة للأدوية يناقشون توزيع الأرباح", {"dividend", "meeting", "results"}, 0),
    ("ارتفاع أرباح البنك التجاري الدولي 7% في الربع الأول", {"results"}, 1),
    ("تراجع صافي ربح الشركة بنسبة 15%", {"results"}, -1),
    ("الشركة توزع أسهم مجانية بواقع سهم لكل سهمين", {"bonus"}, 0),
])
def test_headline_tags_and_tone(title, tags, tone):
    got_tags, got_tone = news.classify(title)
    assert tags <= set(got_tags) and got_tone == tone


MUBASHER_PAGE = """
<div class="mi-article-media-block__content"> <span class="mi-article-media-block__date">24 سبتمبر 11:25 ص</span>
 <a class="mi-article-media-block__title" href="/news/4676348/-CIB-%D9%8A%D9%85%D9%88%D9%84/">&quot;CIB&quot; يمول توسعات</a>
 <div class="mi-article-media-block__text">…</div></div>
<div class="mi-article-media-block__content"> <span class="mi-article-media-block__date">28 December 2025 03:23 PM</span>
 <a class="mi-article-media-block__title" href="/news/4541222/Egypt-closes-2025/">Egypt closes 2025 as best-performing market</a></div>
"""


def test_mubasher_page():
    rows = news.parse_mubasher(MUBASHER_PAGE, "ar", NOW)
    assert [(r["id"], r["published"], r["title"]) for r in rows] == [
        ("mubasher:4676348", "2026-09-24T11:25", '"CIB" يمول توسعات'),
        ("mubasher:4541222", "2025-12-28T15:23", "Egypt closes 2025 as best-performing market")]
    assert rows[0]["url"].startswith("https://www.mubasher.info/news/4676348/")


class Resp:
    def __init__(self, body, status=200):
        self.status_code, self.body = status, body
        self.text = body if isinstance(body, str) else json.dumps(body)
        self.content = self.text.encode()

    def json(self):
        return self.body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


class FakeFetcher:
    """Answers by URL (the first matching key); anything else fails like a site that's down."""

    def __init__(self, routes):
        self.routes, self.asked = routes, []

    def get(self, url, polite=True, params=None, **kw):
        self.asked.append((url, params))
        for key, body in self.routes.items():
            if key in url:
                return Resp(body(params) if callable(body) else body)
        raise ConnectionError(url)


def _tv(items):
    return {"items": items}


def _tv_item(i, title, syms, provider="zawya", ts=1790573914):
    return {"id": f"tag:{i}", "title": title, "provider": provider, "published": ts, "storyPath": f"/news/{i}/",
            "relatedSymbols": [{"symbol": s} for s in syms]}


def test_reuters_and_zawya_are_tagged_to_the_stock_and_roundups_are_market_news():
    f = FakeFetcher({"news-headlines": _tv([
        _tv_item(1, "ZAWYA: CIB extends $80mln financing", ["EGX:COMI"]),
        _tv_item(2, "Most Gulf markets gain", ["EGX:COMI", "EGX:TMGH", "TADAWUL:2222", "DFM:EMAAR"], "reuters"),
        _tv_item(3, "Crypto news", ["EGX:COMI"], "binance_news"),                  # not a source we keep
        _tv_item(4, "Saudi Aramco results", ["TADAWUL:2222"], "reuters"),          # not an EGX stock
    ])})
    rows = news.fetch_tv(f)
    assert [(r["title"], r["symbols"]) for r in rows] == [("CIB extends $80mln financing", ["COMI"]),
                                                         ("Most Gulf markets gain", [""])]
    assert rows[0]["published"] == "2026-09-28T08:38" and rows[0]["url"] == "https://www.tradingview.com/news/1/"


def _market(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    for sym in ("COMI", "MHOT", "ABUK"):
        conn.execute("INSERT INTO stocks(symbol, name_ar) VALUES (?, ?)", (sym, sym))
        conn.execute("INSERT INTO prices(symbol, date, open, high, low, close, volume) "
                     "VALUES (?, '2026-09-28', 1, 1, 1, 1, 1)", (sym,))
    conn.commit()
    return conn


def _ca(sym, typ, ann, eff):
    return {"name": sym, "url": f"/markets/EGX/stocks/{sym}", "type": typ, "announcedAt": ann, "effectiveFrom": eff,
            "description": "Cash Dividend"}


CA_ROWS = [
    _ca("MHOT", "Cash Dividends", "17 September 2026", "13 October 2026"),
    _ca("ABUK_r1", "Bonus Shares Distribution", "24 February 2026", "07 October 2026"),
    _ca("COMI", "Cash Dividends", "24 March 2025", "08 April 2025"),
    _ca("COMI", "Cash Dividends", "10 April 2024", "08 April 2024"),                 # dated after its ex-date
    _ca("COMI", "Change trading symnol", "01 March 2021", None),
]


def _load_actions(conn):
    f = FakeFetcher({"corporate-actions": {"rows": CA_ROWS, "numberOfPages": 1}})
    return news.save_corporate_actions(conn, news.fetch_corporate_actions(f, 1))


def test_update_reads_every_source_and_one_down_doesnt_stop_the_others(tmp_path):
    conn = _market(tmp_path)
    f = FakeFetcher({
        "corporate-actions": {"rows": CA_ROWS, "numberOfPages": 1},
        "news-headlines": lambda params: _tv([_tv_item(params.get("symbol", "market"),
                                                       "CIB posts 7% rise in Q1 net profit", ["EGX:COMI"])]),
        "english.mubasher.info/markets": "<html>no news</html>",
        "www.mubasher.info/markets": MUBASHER_PAGE,
        # the RSS feeds and Mubasher's latest-news pages are down
    })
    res = news.update(conn, first=["MHOT"], budget_s=60, fetcher=f)
    assert res["actions"] == 5 and res["stocks"] == 3
    assert set(res["failed"]) == {"Al Borsa News", "Daily News Egypt", "Mubasher latest news"}
    kinds = {(r["symbol"], r["kind"], r["announced"], r["effective"]) for r in news.actions(conn)}
    assert ("ABUK", "bonus", "2026-02-24", "2026-10-07") in kinds
    assert ("COMI", "dividend", "2024-04-08", "2024-04-08") in kinds              # never announced after its ex-date
    stock_pages = [u for u, _ in f.asked if "/markets/EGX/stocks/" in u]
    assert stock_pages[0].endswith("/MHOT/news")                                 # today's signals first
    assert {n["symbol"] for n in news.recent_news(conn, days=3650)} >= {"COMI", "MHOT", "ABUK"}
    checked = json.loads(db.get_meta(conn, "news_checked"))
    assert set(checked) == {"COMI", "MHOT", "ABUK"} and all("tv" in v and "mubasher" in v for v in checked.values())
    # the next run: the corporate actions again, but no second year of Reuters/Zawya per stock
    f.asked.clear()
    assert news.update(conn, budget_s=60, fetcher=f)["actions"] == 0
    assert not [p for u, p in f.asked if p and "symbol" in p]


def test_cautions_for_a_buyer(tmp_path):
    conn = _market(tmp_path)
    _load_actions(conn)
    today = "2026-09-28"
    c = news.cautions(conn, "MHOT", today, div={"ex_date": "2026-10-13", "amount": 1.25})
    assert len(c) == 1                                          # Mubasher's and TradingView's are the same dividend
    assert c[0]["kind"] == "ex_dividend" and c[0]["amount"] == 1.25 and "1.25 EGP" in c[0]["text"]
    assert news.cautions(conn, "MHOT", "2026-09-10") == []      # not announced yet on that day
    assert [x["kind"] for x in news.cautions(conn, "ABUK", today)] == ["bonus"]
    news.save_news(conn, [{"id": "x:1", "source": "reuters", "lang": "en", "published": "2026-09-27T10:00",
                           "title": "Egypt's FRA suspends trading on COMI shares", "url": "https://x/1"}], "COMI")
    bad = news.cautions(conn, "COMI", today)
    assert [x["kind"] for x in bad] == ["bad_news"] and bad[0]["source"] == "Reuters"
    assert news.cautions(conn, "COMI", "2026-10-10") == []      # more than 5 days later
    c = news.cautions(conn, "COMI", "2026-10-10", results="2026-10-25")
    assert [x["kind"] for x in c] == ["results"] and c[0]["date"] == "2026-10-25" and c[0]["level"] == "info"
    assert news.cautions(conn, "COMI", "2026-10-10", results="2026-12-25") == []   # after the longest hold
    assert news.cautions(conn, "COMI", "2026-10-10", results="2026-10-10") == []   # today: already out


def test_event_features_only_know_what_was_announced_before_the_day(tmp_path):
    conn = _market(tmp_path)
    _load_actions(conn)
    ds = pd.DataFrame({"symbol": ["MHOT", "MHOT", "MHOT", "COMI", "XYZ"],
                       "date": pd.to_datetime(["2026-09-17", "2026-09-18", "2026-10-14", "2026-09-28", "2026-09-28"])})
    f = news.event_features(ds, news.load_events(conn))
    none = news.NONE_DAYS
    assert list(f.columns) == news.EVENT_FEATURES
    assert f.loc[0, "div_ex_ahead"] == none                     # announced that day: maybe after the close
    assert f.loc[1, "div_ex_ahead"] == 25 and f.loc[1, "div_since_ann"] == 1
    assert f.loc[2, "div_ex_ahead"] == none and f.loc[2, "div_since_ex"] == 1 and f.loc[2, "n_div_3y"] == 1
    assert f.loc[3, "n_div_3y"] == 2 and f.loc[3, "div_since_ex"] == (date(2026, 9, 28) - date(2025, 4, 8)).days
    assert f.loc[4].tolist() == [none, none, none, 0, none, none, none, none]


def test_pages_messages_and_the_site_show_the_news(tmp_path, cfg):
    conn = _market(tmp_path)
    today = date.today()
    db.set_meta(conn, "scan_data_date", today.isoformat())
    day = lambda n: (today + timedelta(days=n)).strftime("%d %B %Y")
    rows = [_ca("MHOT", "Cash Dividends", day(-11), day(15)), _ca("ABUK", "Bonus Shares Distribution", day(-200), day(9))]
    news.save_corporate_actions(conn, news.fetch_corporate_actions(
        FakeFetcher({"corporate-actions": {"rows": rows, "numberOfPages": 1}}), 1))
    news.save_news(conn, news.parse_mubasher(MUBASHER_PAGE, "ar", datetime.now()), "COMI")
    news.save_news(conn, [{"id": "m:1", "source": "alborsa", "lang": "ar", "published": news._iso(datetime.now()),
                           "title": "البورصة تربح 10 مليارات جنيه", "url": "https://alborsa/1"}])
    d = views.Data(conn, cfg, views.Cache())
    warn = views.cautions_map(d)
    assert set(warn) == {"MHOT", "ABUK"} and warn["MHOT"][0]["kind"] == "ex_dividend"
    feed = views.news_feed(d)
    assert {n["symbol"] for n in feed["items"]} == {"COMI", ""}
    lines = alerts._caution_lines(warn["MHOT"])
    assert "Ex-dividend" in lines[0] and "lower the stop" in lines[0]
    files = static_site.public_data(conn, cfg)
    assert files["core"]["cautions"]["MHOT"][0]["kind"] == "ex_dividend"
    assert files["news"]["items"] and "held" not in files["news"]
    assert sorted(a["kind"] for a in files["dividends"]["coming"]) == ["bonus", "dividend"]
