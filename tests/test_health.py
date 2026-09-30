"""Alarms for the owner (app/health.py) and the website's daily backup (app/backup.py)."""
import json
import sqlite3
from datetime import date, datetime, timedelta

import pytest

from app import backup, health
from egx_agent import config, db, scan
from tests.test_static_site import PASSWORD, FakeBot, _site_db

T0 = datetime(2026, 9, 29, 12, 0)


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr(scan, "expected_session_date", lambda now=None: date(2026, 9, 29))   # a Tuesday
    c = db.connect(tmp_path / "egx.db")
    db.set_meta(c, "scan_data_date", "2026-09-29")
    yield c
    c.close()


class Phone:
    def __init__(self, fail=False):
        self.got, self.fail = [], fail

    def __call__(self, text):
        if self.fail:
            raise RuntimeError("no network")
        self.got.append(text)


def test_a_source_is_a_problem_only_after_failing_for_a_whole_day(conn):
    names = ["Mubasher stock pages", "Reuters/Zawya"]
    health.note(conn, ["Mubasher stock pages"], names, now=T0)
    health.note(conn, ["Mubasher stock pages"], names, now=T0 + timedelta(hours=3))   # "since" stays the first
    assert health.problems(conn, now=T0 + timedelta(hours=23)) == {}
    later = health.problems(conn, now=T0 + timedelta(hours=25))
    assert list(later) == ["source:Mubasher stock pages"] and "Tue 29 Sep 12:00" in later["source:Mubasher stock pages"]
    health.note(conn, [], ["Reuters/Zawya"], now=T0 + timedelta(hours=26))              # not tried: unchanged
    assert list(health.problems(conn, now=T0 + timedelta(hours=27))) == ["source:Mubasher stock pages"]
    health.note(conn, [], names, now=T0 + timedelta(hours=28))                          # works again
    assert health.problems(conn, now=T0 + timedelta(hours=29)) == {}


def test_no_new_prices_for_two_sessions_is_a_problem_one_is_not(conn):
    assert health.sessions_behind("2026-09-24", date(2026, 9, 29)) == 3       # Thu → Sun, Mon, Tue
    assert health.sessions_behind("2026-09-24", date(2026, 9, 27)) == 1       # the weekend doesn't count
    assert health.sessions_behind("2026-09-29", date(2026, 9, 29)) == 0
    db.set_meta(conn, "scan_data_date", "2026-09-27")
    stale = health.problems(conn, now=T0)
    assert list(stale) == ["stale"] and "2 sessions" in stale["stale"] and "Sun 27 Sep" in stale["stale"]
    db.set_meta(conn, "scan_data_date", "2026-09-28")
    assert health.problems(conn, now=T0) == {}


def test_each_problem_is_sent_once_when_it_starts_and_once_when_it_is_fixed(conn):
    phone = Phone()
    stale = {"stale": "No new closing prices for 2 sessions."}
    res = health.notify(conn, stale, phone, "https://github.com/me/egx/actions/runs/1", " website")
    assert res == {"open": 1, "new": 1, "fixed": 0, "sent": True}
    assert "⚠️" in phone.got[0] and "No new closing prices" in phone.got[0] and "actions/runs/1" in phone.got[0]
    assert health.notify(conn, stale, phone)["sent"] is False and len(phone.got) == 1          # not again
    both = {**stale, "source:Kashif (Shariah data)": "Kashif hasn't worked since …"}
    health.notify(conn, both, phone)
    assert len(phone.got) == 2 and "Kashif" in phone.got[1] and "No new closing" not in phone.got[1]
    health.notify(conn, {"source:Kashif (Shariah data)": "…"}, phone)
    assert "✅" in phone.got[2] and "New closing prices are coming in again" in phone.got[2]
    health.notify(conn, {}, phone)
    assert "Kashif (Shariah data) works again" in phone.got[3] and len(phone.got) == 4


def test_nothing_is_marked_as_told_until_a_message_goes_out(conn):
    stale = {"stale": "No new closing prices."}
    assert health.notify(conn, stale, None) == {"open": 1, "new": 1, "fixed": 0, "sent": False}   # no owner yet
    assert health.notify(conn, stale, Phone(fail=True))["sent"] is False                        # Telegram down
    phone = Phone()
    assert health.notify(conn, stale, phone)["sent"] and len(phone.got) == 1                     # the next run


def test_a_crash_is_sent_once_and_cleared_by_the_next_run_that_gets_through(conn):
    phone = Phone()
    health.notify(conn, {"stale": "No new closing prices."}, phone)
    assert health.crashed(conn, "The scan failed: boom", phone, where=" on your Mac")
    assert "on your Mac" in phone.got[-1] and "boom" in phone.got[-1] and "✅" not in phone.got[-1]
    assert not health.crashed(conn, "The scan failed again", phone) and len(phone.got) == 2
    health.notify(conn, {"stale": "No new closing prices."}, phone)       # a run that got through
    assert phone.got[-1].count("•") == 1 and "The runs work again" in phone.got[-1]


def test_the_failed_run_step_needs_only_the_stored_owner(tmp_path, monkeypatch, conn):
    got = []
    monkeypatch.setattr(health, "telegram_sender", lambda token, chat: lambda text: got.append((token, chat, text)))
    path = str(tmp_path / "egx.db")
    monkeypatch.delenv("TELEGRAM_TOKEN", raising=False)
    assert health.main(["crashed", "--db", path]) == 0 and got == []            # no bot: GitHub's e-mail only
    monkeypatch.setenv("TELEGRAM_TOKEN", "123:abc")
    assert health.main(["crashed", "--db", path]) == 0 and got == []            # nobody to tell yet
    db.set_meta(conn, "site_owner", json.dumps({"who": "owner", "chat": "777"}))
    monkeypatch.setenv("GITHUB_REPOSITORY", "me/egx")
    monkeypatch.setenv("GITHUB_RUN_ID", "42")
    assert health.main(["crashed", "--db", path]) == 0
    assert [(t, c) for t, c, _ in got] == [("123:abc", "777")] and "actions/runs/42" in got[0][2]
    health.main(["crashed", "--db", path])
    assert len(got) == 1                                                        # once until a run gets through


class OwnerBot(FakeBot):
    usernames = {"111": "friend_one", "222": "The_Owner"}

    def call(self, token, method, **params):
        if method == "getChat":
            return {"id": params["chat_id"], "username": self.usernames.get(str(params["chat_id"]))}
        return super().call(token, method, **params)


def test_the_website_finds_the_owner_by_username_and_tells_only_them(tmp_path, monkeypatch):
    from app import alerts, jobs, site_daily, static_site
    from egx_agent.data import news
    src = _site_db(tmp_path / "state" / "egx.db")     # its last close is long ago: the prices look stuck
    strategy = tmp_path / "strategy.yaml"
    static_site.export_strategy(dict(config.DEFAULTS), strategy)
    monkeypatch.setattr(config, "CONFIG_PATH", strategy)
    monkeypatch.setattr(scan, "scan_is_stale", lambda conn, *_: False)
    monkeypatch.setattr(scan, "run_scan", lambda *a, **k: {"date": "x", "buys": 1, "watches": 0})
    monkeypatch.setattr(jobs, "train_job", lambda conn, say: None)
    monkeypatch.setattr(news, "update", lambda conn, **k: {"new": 0, "actions": 0, "stocks": 0,
                                                              "failed": ["Mubasher latest news"],
                                                              "tried": ["Mubasher latest news", "Reuters/Zawya"]})
    bot = OwnerBot()
    monkeypatch.setattr(alerts, "call", bot.call)
    monkeypatch.setattr(alerts, "send", bot.send)
    code = static_site.telegram_code(PASSWORD, "me/egx")
    bot.says(111, f"/start {code}")
    bot.says(222, f"/start {code}", name="Owner")

    first = site_daily.run(src, tmp_path / "site", PASSWORD, "me/egx", "123:abc", owner="@the_owner")
    alarms = [t for c, t in bot.sent if "something needs a look" in t]
    assert len(alarms) == 1 and [c for c, t in bot.sent if t in alarms] == ["222"]       # only the owner
    assert "No new closing prices" in alarms[0]
    assert first["alarms"] == "1 open, the owner was told"
    assert "the_owner" not in json.dumps(first).lower() and "222" not in json.dumps(first)
    assert any("No new closing prices" in w for w in first["warnings"])
    conn = db.connect(src)
    assert json.loads(db.get_meta(conn, "site_owner")) == {"who": "the_owner", "chat": "222"}
    assert "Mubasher latest news" in json.loads(db.get_meta(conn, "health_failing"))
    conn.close()

    n = len(bot.sent)
    second = site_daily.run(src, tmp_path / "site", PASSWORD, "me/egx", "123:abc", owner="@the_owner")
    assert len(bot.sent) == n and second["alarms"] == "1 open"                           # not again

    # Without the OWNER_TELEGRAM secret the problem is only in the run's summary.
    src2 = _site_db(tmp_path / "other" / "egx.db")
    third = site_daily.run(src2, tmp_path / "site2", PASSWORD, "me/egx", "123:abc")
    assert third["alarms"] == "1 open: add the OWNER_TELEGRAM secret to get these on Telegram"


def test_the_mac_tells_you_on_your_own_telegram(tmp_path, monkeypatch, conn):
    from app import accounts, alerts, jobs
    sent = []
    monkeypatch.setattr(alerts, "send", lambda token, chat, text: sent.append((chat, text)))
    cfg = {**config.DEFAULTS, "telegram_token": "123:abc", "telegram_chat_id": "999"}
    db.set_meta(conn, "scan_data_date", "2026-09-24")
    assert jobs.check_health(None, conn, cfg, {"checked": ["Kashif (Shariah data)"], "failed": []}) == "1 open"
    assert sent[0][0] == "999" and "on your Mac" in sent[0][1]
    assert jobs.owner_sender(accounts.Site(tmp_path / "m.db", multi_user=True), cfg) is None
    assert jobs.owner_sender(None, dict(config.DEFAULTS)) is None               # Telegram not set up


def test_the_scan_says_which_sources_it_tried_and_which_failed(tmp_path, monkeypatch):
    from egx_agent import predict
    from egx_agent.data import shariah
    monkeypatch.setattr(shariah, "needs_refresh", lambda conn: False)
    conn = db.connect(_site_db(tmp_path / "egx.db"))
    market = scan.run_scan(conn, dict(config.DEFAULTS), update_data=False)
    assert market["checked"] == ["Prediction model"] and market["failed"] == []

    def broken(*a, **k):
        raise RuntimeError("no model file")
    monkeypatch.setattr(predict, "predict_latest", broken)
    assert scan.run_scan(conn, dict(config.DEFAULTS), update_data=False)["failed"] == ["Prediction model"]
    conn.close()


# ------------------------------------------------------------------ the daily backup

def test_the_backup_opens_only_with_both_secrets_and_brings_everything_back(tmp_path):
    src = _site_db(tmp_path / "state" / "egx.db")
    secret = PASSWORD + "\n" + "123:abc"
    size = backup.make(src, tmp_path / "b" / "state.egxb", secret)
    box = (tmp_path / "b" / "state.egxb").read_bytes()
    assert size == len(box) and box.startswith(b"EGXB1") and b"MY PRIVATE NOTE" not in box and b"SQLite" not in box
    with pytest.raises(backup.BackupError, match="doesn't open"):
        backup.restore(tmp_path / "b" / "state.egxb", tmp_path / "x.db", PASSWORD + "\n")   # password alone
    assert not (tmp_path / "x.db").exists()
    backup.restore(tmp_path / "b" / "state.egxb", tmp_path / "back" / "egx.db", secret)
    a, b = sqlite3.connect(src), sqlite3.connect(tmp_path / "back" / "egx.db")
    for table in ("prices", "scans", "meta", "trades"):
        assert a.execute(f"SELECT * FROM {table} ORDER BY 1, 2").fetchall() == \
            b.execute(f"SELECT * FROM {table} ORDER BY 1, 2").fetchall()
    a.close()
    b.close()
    damaged = bytearray(box)
    damaged[-40] ^= 1
    (tmp_path / "bad.egxb").write_bytes(bytes(damaged))
    with pytest.raises(backup.BackupError):
        backup.restore(tmp_path / "bad.egxb", tmp_path / "back" / "egx.db", secret)
    (tmp_path / "junk.egxb").write_bytes(b"hello")
    with pytest.raises(backup.BackupError, match="not a backup"):
        backup.restore(tmp_path / "junk.egxb", tmp_path / "back" / "egx.db", secret)


def test_the_backup_is_made_about_once_a_day(tmp_path):
    src = _site_db(tmp_path / "state" / "egx.db")
    out = tmp_path / "_backup" / "state.egxb"
    assert backup.make_if_due(src, out, "s") > 0 and out.exists()
    out.unlink()
    assert backup.make_if_due(src, out, "s") is None and not out.exists()
    conn = sqlite3.connect(src)
    last = datetime.fromisoformat(conn.execute("SELECT value FROM meta WHERE key='backup_last'").fetchone()[0])
    assert not backup.due(conn, last + timedelta(hours=19)) and backup.due(conn, last + timedelta(hours=21))
    conn.close()
