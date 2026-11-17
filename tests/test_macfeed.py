"""The Mac's Mubasher file (app/macfeed.py): locked with the bot token, added once on the website's run, and while it's
fresh the run leaves Mubasher's stock pages alone."""
from datetime import datetime, timedelta

import pytest

from app import macfeed
from egx_agent import db
from egx_agent.data import news


def test_the_macs_mubasher_file_reaches_the_website(tmp_path, monkeypatch):
    monkeypatch.setattr(macfeed, "FILE", tmp_path / "mubasher.egxm")
    mac, site = db.connect(tmp_path / "mac.db"), db.connect(tmp_path / "site.db")
    day = (datetime.now() - timedelta(days=2)).strftime("%Y-%m-%dT10:00")
    news.save_news(mac, [{"id": "m1", "source": "mubasher", "lang": "ar", "published": day, "title": "توزيع أرباح",
                          "url": "u"}], "AAA")
    cols = "INSERT INTO ownership(symbol, holders, free_float, updated, af_holders, af_free_float) VALUES "
    mac.execute(cols + "('AAA', '[[\"Q\", 60]]', 0.4, '2026-10-10T20:00:00', '[[\"Q\", 60]]', 0.4)")
    site.execute(cols + "('AAA', '[[\"Q\", 55]]', 0.45, '2026-09-01T20:00:00', '[[\"Q\", 55]]', 0.45)")
    site.execute(cols + "('BBB', '[]', 0.6, '2026-10-11T08:00:00', NULL, NULL)")
    sent = []
    assert macfeed.send(mac, {"telegram_token": "123:abc"}, up=sent.append).startswith("sent (1 headlines, 1 owners")
    assert macfeed.send(mac, {"telegram_token": "123:abc"}, up=sent.append) == "unchanged" and len(sent) == 1
    assert b"AAA" not in sent[0].read_bytes()                                       # locked

    with pytest.raises(ValueError):
        macfeed.apply(site, sent[0], "another bot")
    assert not news.mac_sends(site)
    assert macfeed.apply(site, sent[0], "123:abc").startswith("1 new headlines")
    assert news.mac_sends(site)
    assert [tuple(r) for r in site.execute("SELECT symbol, title FROM news")] == [("AAA", "توزيع أرباح")]
    assert {r[0]: r[1] for r in site.execute("SELECT symbol, free_float FROM ownership")} == {"AAA": 0.4, "BBB": 0.6}
    assert site.execute("SELECT af_free_float FROM ownership WHERE symbol='AAA'").fetchone()[0] == 0.4
    assert [tuple(r) for r in site.execute("SELECT symbol, holder, before, after FROM owner_changes")] == [
        ("AAA", "Q", 55, 60)]                                                       # the website notes the move too
    assert macfeed.apply(site, sent[0], "123:abc") == "nothing newer from the Mac"
    assert macfeed.send(mac, {}).startswith("not sent")


def test_the_macs_who_bought_days_fill_the_websites_gaps(tmp_path, monkeypatch):
    from egx_agent.data import flows
    monkeypatch.setattr(macfeed, "FILE", tmp_path / "mubasher.egxm")
    mac, site = db.connect(tmp_path / "mac.db"), db.connect(tmp_path / "site.db")
    day, kept = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d"), (datetime.now() - timedelta(days=2)).strftime("%Y-%m-%d")
    rows = [(s, d, 1.0) for d in (day, kept) for s in macfeed.FLOW_SERIES]
    mac.executemany("INSERT INTO macro(series, date, value) VALUES (?,?,?)", rows)
    mac.execute("INSERT INTO macro(series, date, value) VALUES ('flow_foreign', ?, 9.0)", ("2020-01-01",))   # too old
    site.executemany("INSERT INTO macro(series, date, value) VALUES (?,?,?)", [(s, kept, 2.0) for s in macfeed.FLOW_SERIES])
    site.execute("INSERT INTO macro(series, date, value) VALUES ('flow_foreign', ?, 999.0)", (day,))     # Amwal's total
    sent = []
    macfeed.send(mac, {"telegram_token": "123:abc"}, up=sent.append)
    assert "1 days of who bought" in macfeed.apply(site, sent[0], "123:abc")
    got = {(r[0], r[1]): r[2] for r in site.execute("SELECT series, date, value FROM macro")}
    assert got[("flow_foreign", day)] == 1.0 and got[(flows.SPLIT[("arabs", "individuals")], day)] == 1.0
    assert got[("flow_foreign", kept)] == 2.0            # a day the website already had the split of stays
