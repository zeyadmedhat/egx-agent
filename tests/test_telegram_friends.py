"""The website's friends on Telegram: their own positions in the evening message (from the portfolio their browser
linked to the bot), in their language, /quiet, the one-tap Connect link, and your Mac's Connect through the Worker."""
import json

from app import alerts, jobs, site_daily, static_site, views
from egx_agent import config, db, scan
from tests.test_static_site import PASSWORD, FakeBot, _site_db


def test_a_linked_friend_gets_their_own_orders_in_arabic(tmp_path, monkeypatch):
    src = _site_db(tmp_path / "state" / "egx.db")
    strategy = tmp_path / "strategy.yaml"
    static_site.export_strategy(dict(config.DEFAULTS), strategy)
    monkeypatch.setattr(config, "CONFIG_PATH", strategy)
    monkeypatch.setattr(scan, "scan_is_stale", lambda conn, *_: False)
    monkeypatch.setattr(scan, "session_scan_due", lambda conn, *_: False)
    monkeypatch.setattr(scan, "run_scan", lambda conn, cfg, progress=None, update_data=True: {"date": "x", "buys": 1,
                                                                                             "watches": 0})
    monkeypatch.setattr(jobs, "train_job", lambda conn, say: None)
    bot = FakeBot()
    sends = []
    monkeypatch.setattr(alerts, "call", bot.call)
    monkeypatch.setattr(alerts, "send", lambda token, chat, text, buttons=None: sends.append((chat, text, buttons)))

    conn = db.connect(src)
    dates = [r[0] for r in conn.execute("SELECT date FROM prices WHERE symbol='AAA' ORDER BY date")]
    conn.close()
    entry = dates[-30]                     # held 30 sessions: past the 20-session limit, so the rules say sell
    book = {"v": 1, "trades": [{"id": 1, "account": "real", "status": "open", "symbol": "AAA", "entry_date": entry,
                                "entry_price": 12.0, "shares": 50, "initial_stop": 11.0, "stop": 11.0, "target": 15.0}],
            "fills": [], "dividends": [], "adjustments": []}
    code = static_site.telegram_code(PASSWORD, "me/egx")
    ar = {"language_code": "ar"}
    updates = [{"update_id": 1, "message": {"chat": {"id": 777, "type": "private", "first_name": "Mona"}, "from": ar,
                                            "text": f"/start {code}{'a' * 32}"}},     # the one-tap link
               {"update_id": 2, "message": {"chat": {"id": 777, "type": "private"}, "from": ar, "text": "/quiet"}}]
    posted = {}

    def worker(url, key, path, body=None):
        if path == "/updates":
            return {"updates": updates}
        if path == "/books":
            return {"books": {"777": book, "999": book}}      # 999 isn't connected: skipped
        posted[path] = body
        return {"ok": True}

    monkeypatch.setattr(alerts, "worker_call", worker)
    monkeypatch.setenv("WORKER_URL", "https://w.example")
    monkeypatch.setenv("WORKER_KEY", "k" * 48)
    out = site_daily.run(src, tmp_path / "site", PASSWORD, "me/egx", "123:abc", "https://me.github.io/egx")
    assert "1 linked portfolios checked" in out["telegram"]
    chat, text, buttons = sends[-1]
    assert chat == "777" and "مراكزك" in text and "بع كل 50 من AAA عند الافتتاح" in text   # quiet, but a BUY today
    assert "انتهت مدة الاحتفاظ" in text and "اشترِ حتى" in text
    assert buttons[0][0]["web_app"]["url"] == "https://me.github.io/egx/"
    state = posted["/state"]
    assert state["subs"]["777"] == {"weekly": True, "lang": "ar", "quiet": True}
    assert state["mine"]["777"]["positions"][0]["status"] == "EXIT" and "999" not in state["mine"]
    assert state["info"]["site"] == "https://me.github.io/egx" and state["sitekey"]["iter"] == static_site.ITERATIONS
    assert state["info"]["final"] is True
    assert "Mona" not in json.dumps(out) and "777" not in json.dumps(out)       # the public log: counts only
    # the 9:30 reminder before the next session: their own order, then the BUYs, in their language
    morning = state["morning"]
    assert morning["day"] == views.sessions_after(dates[-1], 1)
    assert "قبل الافتتاح" in morning["texts"]["777"] and "بع كل 50 من AAA عند الافتتاح" in morning["texts"]["777"]
    assert "اشترِ حتى" in morning["texts"]["777"] and "/morning off" in morning["texts"]["777"]
    # /why answers from the same data: each stock's BUY checks
    assert set(state["info"]["stocks"]["AAA"]["k"]) <= {"0", "1"} and len(state["info"]["stocks"]["AAA"]["k"]) == 5


def test_morning_off_stops_the_reminder(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "egx.db")
    code = "c" * 24
    fp = alerts._fingerprint(code)
    db.set_meta(conn, "site_subscribers", json.dumps({"5": {"code": fp}, "6": {"code": fp}}))
    monkeypatch.setattr(alerts, "_reply", lambda *a: None)
    msg = lambda cid, uid, text: {"update_id": uid, "message": {"chat": {"id": cid, "type": "private"}, "text": text}}  # noqa: E731
    res = alerts.sync_subscribers(conn, "123:abc", code, [msg(5, 1, "/morning off"), msg(6, 2, "/morning")],
                                  answered=True)
    assert res["commands"] == 2
    subs = alerts._subscribers(conn)
    assert subs["5"]["morning"] is False and subs["6"]["morning"] is True
    state = alerts.worker_state(conn, code)
    assert state["subs"]["5"]["morning"] is False and "morning" not in state["subs"]["6"]
    texts = site_daily.morning_texts(conn, dict(config.DEFAULTS), {}, "2026-09-30")
    assert texts == {"day": "2026-10-01", "texts": {}}                  # no scan: nothing to remind anyone of


def test_quiet_friends_get_nothing_on_a_day_with_nothing_to_do(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "egx.db")
    db.set_meta(conn, "site_subscribers", json.dumps({"1": {"code": "x", "quiet": True}, "2": {"code": "x"}}))
    sent = []
    monkeypatch.setattr(alerts, "send", lambda token, chat, text, buttons=None: sent.append(chat))
    res = alerts.send_to_subscribers(conn, "123:abc", lambda cid, s: None if s.get("quiet") else {"text": "hi"},
                                     "2026-09-30")
    assert sent == ["2"] and res["sent"] == 1
    assert json.loads(db.get_meta(conn, "site_subscribers"))["1"]["sent_for"] == "2026-09-30"   # not sent later


def test_positions_waiting_for_bonus_shares_ask_for_the_new_count(tmp_path):
    src = _site_db(tmp_path / "egx.db")
    conn = db.connect(src)
    conn.execute("INSERT INTO price_events(symbol, ex_date, factor, detected) VALUES ('AAA', '2099-01-01', 1.25, 'x')")
    d = views.Data(conn, dict(config.DEFAULTS), views.Cache())
    trade = {"id": 3, "account": "real", "status": "open", "symbol": "AAA", "entry_date": "2020-01-01",
             "entry_price": 12.0, "shares": 80, "initial_stop": 11.0, "target": 15.0}
    [p] = views.book_positions(d, {"trades": [trade], "adjustments": []})
    assert p["status"] == "ADJUST" and p["adjust"]["factor"] == 1.25
    [p] = views.book_positions(d, {"trades": [trade], "adjustments": [{"event_id": "AAA:2099-01-01", "trade_id": 3}]})
    assert p["status"] != "ADJUST"
    assert views.book_positions(d, {"trades": [{**trade, "entry_price": None}]}) == []   # an incomplete record


def test_the_mac_connects_through_the_worker_once_telegram_hands_it_the_messages(tmp_path, monkeypatch):
    def call(token, method, **params):
        if method == "getUpdates":
            raise alerts.TelegramError("Telegram: Conflict: can't use getUpdates method while webhook is active", 409)
        return {"url": "https://w.example/telegram"}

    class Answer:
        ok = True

        def json(self):
            return {"found": True, "id": "42", "name": "Zeyad"}

    asked = []
    monkeypatch.setattr(alerts, "call", call)
    monkeypatch.setattr(alerts.requests, "post", lambda url, json, timeout: asked.append((url, json)) or Answer())
    got = alerts.find_chat_by_code(db.connect(tmp_path / "egx.db"), "123:abc", "macCode12345")
    assert got["id"] == "42" and asked == [("https://w.example/started", {"code": "macCode12345"})]
