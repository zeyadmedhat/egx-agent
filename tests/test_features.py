"""Bonus shares and dividends, the next-session orders, market breadth, Telegram alerts and the daily scan."""
import json

import numpy as np
import pandas as pd
import pytest

from app import alerts, daily, schedule, views
from egx_agent import breadth, config, corporate, db, portfolio
from egx_agent.data import prices
from tests.conftest import make_ohlcv
from tests.test_api import H, client  # noqa: F401  (the dashboard test client fixture)
from tests.test_prices import FakeProvider


def _frame(closes, start="2026-01-04"):
    df = make_ohlcv(closes, start=start).rename_axis("date").reset_index()
    df["date"] = df["date"].dt.strftime("%Y-%m-%d")
    return df


# ------------------------------------------------------------------ bonus shares / splits

def test_rebased_history_is_detected_with_its_ratio_and_date(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    conn.execute("INSERT INTO stocks(symbol) VALUES ('BON')")
    old = _frame(np.linspace(10, 12, 40))
    db.upsert_prices(conn, "BON", old)
    # TradingView re-based everything before the 41st session by 1.25 (1 free share for every 4).
    fresh = _frame(np.r_[np.linspace(10, 12, 40) / 1.25, [9.7, 9.8]])
    res = prices.update_prices(conn, ["BON"], provider=FakeProvider({"BON": fresh}), workers=1)
    assert res["readjusted"] == ["BON"]
    ev = res["events"][0]
    assert ev["factor"] == 1.25 and ev["ex_date"] == fresh["date"].iloc[40]
    assert conn.execute("SELECT factor FROM price_events WHERE symbol='BON'").fetchone()[0] == 1.25
    assert prices.snap_factor(1.2493) == 1.25 and prices.snap_factor(4.98) == 5 and prices.snap_factor(1.0213) == 1.0213


def test_describe_bonus_ratios():
    assert corporate.describe(1.25) == "1 free share for every 4 you hold"
    assert corporate.describe(1.5) == "1 free share for every 2 you hold"
    assert corporate.describe(5).startswith("5 shares for each 1")
    assert corporate.describe(0.5) == "every 2 shares combined into 1"
    assert corporate.expected_shares(10_247, 1.25) == 12_808


def test_bonus_shares_flag_then_update_a_position(client):  # noqa: F811
    client.post("/api/portfolio/buy", headers=H, json={"symbol": "AAA", "date": "2025-02-02", "price": 12, "shares": 1000})
    conn = db.connect(client.app_db)
    db.add_price_event(conn, "AAA", "2025-03-02", 1.25)
    _scan(conn, "2025-03-05", [])
    pos = client.get("/api/portfolio").json()["positions"][0]
    assert pos["status"] == "ADJUST" and pos["adjust"]["shares_expected"] == 1250
    assert client.get("/api/status").json()["alerts"] == 1
    orders = client.get("/api/today").json()["orders"]
    assert orders["items"][0]["kind"] == "adjust"

    ev = pos["adjust"]["event_id"]
    assert client.post(f"/api/portfolio/{pos['id']}/adjust", headers=H, json={"event_id": ev, "shares": 5000}).status_code == 400
    r = client.post(f"/api/portfolio/{pos['id']}/adjust", headers=H, json={"event_id": ev, "shares": 1250})
    assert r.status_code == 200, r.text
    t = conn.execute("SELECT * FROM trades WHERE id=?", (pos["id"],)).fetchone()
    assert t["shares"] == 1250 and t["entry_price"] == pytest.approx(9.6)       # same cost: 12,000 EGP
    assert t["stop"] == pytest.approx(pos["initial_stop"] / 1.25)
    after = client.get("/api/portfolio").json()["positions"][0]
    assert after["status"] != "ADJUST" and any(f["side"] == "bonus" and f["shares"] == 250 for f in after["fills"])
    assert client.post(f"/api/portfolio/{pos['id']}/adjust", headers=H, json={"event_id": ev, "shares": 1250}).status_code == 409


def test_shares_unchanged_keeps_the_position(client):  # noqa: F811
    client.post("/api/portfolio/buy", headers=H, json={"symbol": "AAA", "date": "2025-02-02", "price": 12, "shares": 100})
    conn = db.connect(client.app_db)
    db.add_price_event(conn, "AAA", "2025-03-02", 1.05)
    pos = client.get("/api/portfolio").json()["positions"][0]
    client.post(f"/api/portfolio/{pos['id']}/adjust", headers=H, json={"event_id": pos["adjust"]["event_id"], "ignore": True})
    t = conn.execute("SELECT shares, entry_price FROM trades WHERE id=?", (pos["id"],)).fetchone()
    assert (t["shares"], t["entry_price"]) == (100, 12)
    assert client.get("/api/portfolio").json()["positions"][0]["status"] != "ADJUST"


def test_paper_trades_follow_bonus_shares_by_themselves(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    conn.execute("""INSERT INTO trades(account, status, symbol, entry_date, entry_price, shares, initial_stop, stop,
                    target, highest_close) VALUES ('paper', 'open', 'BON', '2026-01-10', 10, 400, 9, 9, 12, 10.5)""")
    conn.commit()
    db.add_price_event(conn, "BON", "2026-02-01", 1.25)
    assert corporate.apply_paper(conn) == 1
    t = conn.execute("SELECT * FROM trades").fetchone()
    assert (t["shares"], t["entry_price"], t["stop"], t["target"]) == (500, 8, 7.2, 9.6)
    assert corporate.apply_paper(conn) == 0      # only once


def test_open_pnl_is_counted_like_the_broker(client):  # noqa: F811
    """Like Thndr: market value minus what you paid with the buy fees, no selling fee until you sell. A price copied
    from the broker's average cost (fees_in) already has the fees in it, so none are added."""
    client.post("/api/portfolio/buy", headers=H, json={"symbol": "AAA", "date": "2025-02-02", "price": 12, "shares": 100})
    p = client.get("/api/portfolio").json()["positions"][0]
    assert p["fees"] > 0 and p["pnl"] == pytest.approx((p["last"] - 12) * 100 - p["fees"])
    assert p["pnl_pct"] == pytest.approx(p["pnl"] / (1200 + p["fees"]))
    client.post("/api/portfolio/buy", headers=H, json={"symbol": "BBB", "date": "2025-02-02", "price": 20, "shares": 50,
                                                      "fees_in": True})
    q = next(x for x in client.get("/api/portfolio").json()["positions"] if x["symbol"] == "BBB")
    assert q["fees"] == 0 and q["pnl"] == pytest.approx((q["last"] - 20) * 50)


# ------------------------------------------------------------------ dividends

def test_dividends_count_in_pnl_and_can_be_removed(client):  # noqa: F811
    client.post("/api/portfolio/buy", headers=H, json={"symbol": "AAA", "date": "2025-02-02", "price": 12, "shares": 100})
    before = client.get("/api/portfolio").json()
    tid = before["positions"][0]["id"]
    r = client.post(f"/api/portfolio/{tid}/dividend", headers=H, json={"date": "2025-02-20", "amount": 45})
    assert r.status_code == 200 and "0.450 per share" in r.json()["message"]
    after = client.get("/api/portfolio").json()
    assert after["summary"]["dividends"] == 45
    assert after["summary"]["cash"] == pytest.approx(before["summary"]["cash"] + 45)
    assert after["positions"][0]["pnl"] == pytest.approx(before["positions"][0]["pnl"] + 45)
    div = next(f for f in after["positions"][0]["fills"] if f["side"] == "dividend")
    assert client.delete(f"/api/dividends/{div['dividend_id']}", headers=H).status_code == 200
    assert client.get("/api/portfolio").json()["summary"]["dividends"] == 0


# ------------------------------------------------------------------ orders for the next session

def _scan(conn, day, rows):
    base = {"score": 80, "setup": "Breakout", "close": 10, "entry_high": 10.2, "stop": 9.3, "target": 11.4, "atr": 0.3,
            "avg_value": 1e7, "shares": 0, "amount": 0, "risk_egp": 0, "size_note": "", "reasons": []}
    db.save_scan(conn, day, [{**base, **r} for r in rows])
    db.set_meta(conn, "scan_data_date", day)


def test_orders_list_every_action_most_urgent_first(client):  # noqa: F811
    conn = db.connect(client.app_db)
    client.post("/api/portfolio/buy", headers=H, json={"symbol": "BBB", "date": "2026-09-20", "price": 20, "shares": 10})
    _scan(conn, "2026-09-24", [{"symbol": "AAA", "action": "BUY"}, {"symbol": "BBB", "action": "BUY"}])
    d = views.Data(conn, config.load_config(), views.Cache())
    info = d.info("BBB")
    positions = [
        {"id": 1, "symbol": "BBB", "status": "TIGHTEN STOP", "stop": 21.0, "prev_stop": 20.0, "shares": 10, "info": info},
        {"id": 2, "symbol": "CCC", "status": "EXIT", "reason": "Trend break", "shares": 30, "stop": 5, "info": info},
        {"id": 3, "symbol": "DDD", "status": "HOLD", "stop": 7, "target": 9, "day": 3, "shares": 5, "info": info},
    ]
    o = views.orders(d, positions)
    assert o["session"] == "2026-09-27"             # Thursday → Sunday
    assert [i["kind"] for i in o["items"]] == ["sell", "stop", "buy"]
    assert o["items"][0]["title"] == "Sell all 30 CCC at the open"
    assert o["items"][1]["title"] == "Move your BBB stop up to 21.00"
    # sized for this account when the page is opened: 1.5% of ~100k at risk, 0.70 EGP a share to the stop
    buy = o["items"][2]
    n = buy["shares"]
    assert 2100 < n < 2200 and buy["title"] == f"Buy {n:,} AAA, paying no more than 10.20"
    assert o["holds"][0]["symbol"] == "DDD" and o["skipped"] == [{"symbol": "BBB", "note": "already in your portfolio"}]

    body = {"session": "2026-09-27", "item": "buy:AAA", "done": True}
    assert client.put("/api/orders/check", headers=H, json=body).status_code == 200
    assert views.orders(d, positions)["items"][2]["done"] is True
    client.put("/api/orders/check", headers=H, json={**body, "done": False})
    assert views.orders(d, positions)["items"][2]["done"] is False


# ------------------------------------------------------------------ market breadth

def test_breadth_counts_stocks_above_their_averages():
    idx = pd.bdate_range("2025-01-05", periods=260, freq="C", weekmask="Sun Mon Tue Wed Thu")
    up, down = np.linspace(10, 20, 260), np.linspace(20, 10, 260)
    closes = pd.DataFrame({"UP1": up, "UP2": up * 2, "DN1": down}, index=idx)
    b = breadth.compute(closes, pd.Series(np.linspace(1000, 1500, 260), index=idx),
                        pd.Series({"UP1": "Banks", "UP2": "Banks", "DN1": "Real Estate"}))
    assert b["stocks"] == 3 and b["above50"] == pytest.approx(2 / 3)
    assert (b["advancers"], b["decliners"]) == (2, 1)
    assert [s["sector"] for s in b["sectors"]] == ["Banks", "Real Estate"]
    assert b["sectors"][0]["above50"] == 1.0 and len(b["history"]["time"]) == 250
    assert breadth.verdict(b, index_risk_off=False)["tone"] == "ok"


def test_market_page_loads(client):  # noqa: F811
    m = client.get("/api/market").json()
    assert m["breadth"]["stocks"] == 2 and m["verdict"]["text"]


# ------------------------------------------------------------------ Telegram

@pytest.fixture
def sent(monkeypatch):
    out = []
    monkeypatch.setattr(alerts, "send", lambda token, chat, text: out.append((chat, text)))
    return out


def test_telegram_summary_is_sent_once_per_close(client, sent):  # noqa: F811
    conn = db.connect(client.app_db)
    assert alerts.after_scan(conn, config.load_config()) == "off"
    alerts.save(telegram_token="123456:" + "A" * 35, telegram_chat_id="42")
    db.set_meta(conn, "market", json.dumps({"date": "2026-09-24", "egx30_close": 1300.0, "egx30_change": 0.01,
                                            "risk_off": False}))
    db.set_meta(conn, "scan_data_date", "2026-09-24")
    _scan(conn, "2026-09-24", [{"symbol": "AAA", "action": "BUY"}])
    cfg = config.load_config()
    assert alerts.after_scan(conn, cfg) == "sent"
    chat, text = sent[0]
    assert chat == "42" and "Orders for Sun 27 Sep" in text and "Buy 2,142 AAA" in text and "EGX33 ✓" in text
    assert alerts.after_scan(conn, cfg) == "already sent" and len(sent) == 1
    assert alerts.after_scan(conn, cfg, force=True) == "sent" and len(sent) == 2


def test_telegram_waits_for_the_scan_after_the_close(client, sent):  # noqa: F811
    conn = db.connect(client.app_db)
    alerts.save(telegram_token="123456:" + "A" * 35, telegram_chat_id="42")
    market = {"date": "2026-09-24", "egx30_close": 1300.0, "egx30_change": 0.01, "risk_off": False}
    db.set_meta(conn, "market", json.dumps({**market, "finished": "2026-09-24T12:10:00+03:00"}))  # during trading
    db.set_meta(conn, "scan_data_date", "2026-09-24")
    _scan(conn, "2026-09-24", [{"symbol": "AAA", "action": "BUY"}])
    assert alerts.after_scan(conn, config.load_config()) == "waiting for the close" and sent == []
    db.set_meta(conn, "market", json.dumps({**market, "finished": "2026-09-24T15:40:00+03:00"}))
    assert alerts.after_scan(conn, config.load_config()) == "sent" and len(sent) == 1


def test_quiet_mode_skips_days_with_nothing_to_do(client, sent):  # noqa: F811
    conn = db.connect(client.app_db)
    alerts.save(telegram_token="123456:" + "A" * 35, telegram_chat_id="42", telegram_only_action=True)
    db.set_meta(conn, "market", json.dumps({"date": "2026-09-24", "egx30_close": 1300.0, "egx30_change": 0.01,
                                            "risk_off": True}))
    db.set_meta(conn, "scan_data_date", "2026-09-24")
    _scan(conn, "2026-09-24", [])
    assert alerts.after_scan(conn, config.load_config()) == "nothing to do, so not sent" and sent == []


def test_telegram_errors_never_show_the_token(monkeypatch):
    import requests

    def boom(url, **kw):
        raise requests.ConnectionError(f"failed to reach {url}")
    monkeypatch.setattr(requests, "post", boom)
    token = "123456:" + "B" * 35
    with pytest.raises(alerts.TelegramError) as err:
        alerts.check_token(token)
    assert token not in str(err.value) and err.value.__cause__ is None
    with pytest.raises(alerts.TelegramError, match="doesn't look like a bot token"):
        alerts.check_token("hello")


def test_alert_settings_hide_the_token_and_survive_a_reset(client):  # noqa: F811
    alerts.save(telegram_token="123456:" + "C" * 35, telegram_chat_id="42")
    st = client.get("/api/alerts").json()["telegram"]
    assert st["connected"] and st["token_hint"] == "…CCCC"
    assert "C" * 35 not in client.get("/api/settings").text
    client.post("/api/settings/defaults", headers=H)
    assert config.load_config()["telegram_chat_id"] == "42"
    client.delete("/api/alerts/telegram", headers=H)
    assert config.load_config()["telegram_token"] == ""


# ------------------------------------------------------------------ the daily scan

def test_daily_scan_job_runs_sunday_to_thursday(tmp_path):
    job = schedule.job(tmp_path)
    days = {(x["Weekday"], x["Hour"], x["Minute"]) for x in job["StartCalendarInterval"]}
    assert {w for w, _, _ in days} == {0, 1, 2, 3, 4} and (0, 15, 45) in days and len(days) == 15
    assert job["ProgramArguments"][1:] == ["-m", "app.daily"] and job["WorkingDirectory"] == str(tmp_path)


def test_daily_scan_install_and_remove(tmp_path, monkeypatch):
    calls = []

    class Done:
        returncode, stdout, stderr = 0, "", ""
    monkeypatch.setattr(schedule, "plist_path", lambda: tmp_path / "agent.plist")
    monkeypatch.setattr(schedule, "_launchctl", lambda *a: calls.append(a) or Done())
    monkeypatch.setattr(schedule, "supported", lambda: True)
    schedule.install()
    assert (tmp_path / "agent.plist").exists() and [c[0] for c in calls] == ["bootout", "bootstrap", "kickstart"]
    assert schedule.status()["on"]
    schedule.uninstall()
    assert not (tmp_path / "agent.plist").exists()


def test_daily_scan_leaves_the_work_to_an_open_dashboard(tmp_path, monkeypatch):
    monkeypatch.setattr(daily, "dashboard_open", lambda url=None: True)
    ok, msg = daily.run(tmp_path / "t.db")
    assert ok and "dashboard is open" in msg
    monkeypatch.setattr(daily, "dashboard_open", lambda url=None: False)
    monkeypatch.setattr(daily.scan, "scan_is_stale", lambda conn, *_: False)
    monkeypatch.setattr(config, "CONFIG_PATH", tmp_path / "config.yaml")
    ok, msg = daily.run(tmp_path / "t.db")
    assert ok and msg == "Prices are up to date. Telegram: off."


def test_account_values_a_pending_bonus_position_fairly(tmp_path, cfg):
    conn = db.connect(tmp_path / "t.db")
    conn.execute("""INSERT INTO trades(account, status, symbol, entry_date, entry_price, shares, initial_stop, stop,
                    target, highest_close, fees) VALUES ('real', 'open', 'BON', '2026-01-10', 10, 400, 9, 9, 12, 10, 0)""")
    conn.commit()
    db.add_price_event(conn, "BON", "2026-02-01", 1.25)
    s = portfolio.account_summary(conn, "real", cfg, {"BON": 8.0})    # 8 after the bonus = 10 before it
    assert s["unrealized"] == pytest.approx(0)
