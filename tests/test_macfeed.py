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
    mac.execute("INSERT INTO ownership VALUES ('AAA', '[]', 0.4, '2026-10-10T20:00:00')")
    site.execute("INSERT INTO ownership VALUES ('AAA', '[]', 0.3, '2026-09-01T20:00:00')")
    site.execute("INSERT INTO ownership VALUES ('BBB', '[]', 0.6, '2026-10-11T08:00:00')")
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
    assert macfeed.apply(site, sent[0], "123:abc") == "nothing newer from the Mac"
    assert macfeed.send(mac, {}).startswith("not sent")
