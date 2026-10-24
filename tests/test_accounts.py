"""The website: logins, invite links, each person's own data, admin-only actions and shared Telegram."""
import io
import json
import warnings
import zipfile

import numpy as np
import pandas as pd
import pytest

from app import accounts, alerts, auth, jobs
from app.server import create_app
from egx_agent import config, db, scan
from egx_agent.indicators import add_indicators
from tests.conftest import make_ohlcv
from tests.test_api import H

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

ADMIN_PW = "admin-pass-2026"
FRIEND_PW = "friend-pass-2026"


def _market(path):
    conn = db.connect_market(path)
    auth.ensure_schema(conn)
    conn.execute("INSERT INTO stocks(symbol, name_ar, sector_ar, kashif_status, egx33) VALUES ('AAA', 'أ', 'بنوك', 'compliant', 1)")
    conn.execute("INSERT INTO stocks(symbol, name_ar, sector_ar) VALUES ('BBB', 'ب', 'عقاري')")
    for sym, base in (("AAA", 10.0), ("BBB", 20.0), ("EGX30", 1000.0)):
        df = make_ohlcv(np.linspace(base, base * 1.3, 300), volume=2e6).rename_axis("date").reset_index()
        df["date"] = df["date"].dt.strftime("%Y-%m-%d")
        db.upsert_prices(conn, sym, df)
    conn.commit()
    return conn


@pytest.fixture
def site(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CONFIG_PATH", tmp_path / "config.yaml")
    conn = _market(tmp_path / "market.db")
    admin = auth.create_user(conn, "owner", "Owner", ADMIN_PW, is_admin=True)
    auth.accept_terms(conn, admin)
    conn.close()
    app = create_app(tmp_path / "market.db", autoscan=False, multi_user=True, secure_cookies=False)
    return app


def _client(app, username=None, password=None):
    c = TestClient(app)
    c.__enter__()
    if username:
        r = c.post("/api/auth/login", headers=H, json={"username": username, "password": password})
        assert r.status_code == 200, r.text
    return c


def _friend(app, admin_client, username="sara", accept=True):
    link = admin_client.post("/api/admin/invites", headers=H, json={"note": username}).json()["link"]
    code = link.split("code=")[1]
    c = _client(app)
    assert c.get(f"/api/auth/invite?code={code}").json()["kind"] == "invite"
    r = c.post("/api/auth/join", headers=H, json={"code": code, "username": username, "display_name": username.title(),
                                                 "password": FRIEND_PW})
    assert r.status_code == 200, r.text
    if accept:
        c.post("/api/auth/accept-terms", headers=H)
    return c, code


def test_everything_needs_a_login_and_security_headers(site):
    c = _client(site)
    assert c.get("/api/health").status_code == 200
    for path in ("/api/today", "/api/portfolio", "/api/me", "/api/admin", "/api/settings"):
        r = c.get(path)
        assert r.status_code == 401 and r.json()["detail"]["login"], path
    r = c.get("/")
    assert r.headers["X-Frame-Options"] == "DENY" and "frame-ancestors 'none'" in r.headers["Content-Security-Policy"]
    assert "sha256-" in r.headers["Content-Security-Policy"] and r.headers["X-Robots-Tag"].startswith("noindex")
    assert "Disallow: /" in c.get("/robots.txt").text
    assert c.post("/api/auth/login", json={"username": "owner", "password": ADMIN_PW}).status_code == 403  # no header


def test_invite_join_notice_and_logout(site):
    admin = _client(site, "owner", ADMIN_PW)
    friend, code = _friend(site, admin, accept=False)
    me = friend.get("/api/me").json()["user"]
    assert me["username"] == "sara" and not me["is_admin"] and not me["accepted_terms"]
    assert friend.get("/api/today").json()["detail"]["terms"]              # the notice comes first
    friend.post("/api/auth/accept-terms", headers=H)
    assert friend.get("/api/today").status_code == 200
    # an invite works once
    again = _client(site).post("/api/auth/join", headers=H, json={"code": code, "username": "other", "password": FRIEND_PW})
    assert again.status_code == 400 and "expired or was already used" in again.json()["detail"]["message"]
    friend.post("/api/auth/logout", headers=H)
    assert friend.get("/api/me").status_code == 401
    assert _client(site, "sara", FRIEND_PW).get("/api/me").status_code == 200


def test_wrong_passwords_lock_the_account_for_a_while(site):
    c = _client(site)
    for _ in range(5):
        r = c.post("/api/auth/login", headers=H, json={"username": "owner", "password": "wrong-password-1"})
        assert r.status_code == 401 and r.json()["detail"]["message"] == auth.WRONG
    r = c.post("/api/auth/login", headers=H, json={"username": "owner", "password": ADMIN_PW})
    assert r.status_code == 401 and "Too many wrong tries" in r.json()["detail"]["message"]
    unknown = c.post("/api/auth/login", headers=H, json={"username": "nobody", "password": "x"})
    assert unknown.status_code == 401


def test_people_never_see_or_touch_each_others_positions(site, tmp_path):
    admin = _client(site, "owner", ADMIN_PW)
    friend, _ = _friend(site, admin)
    tid = admin.post("/api/portfolio/buy", headers=H, json={"symbol": "AAA", "date": "2025-02-02", "price": 12,
                                                              "shares": 100}).json()["trade_id"]
    assert friend.get("/api/portfolio").json()["positions"] == []
    assert friend.post("/api/portfolio/sell", headers=H, json={"trade_id": tid, "date": "2025-02-10", "price": 13,
                                                               "shares": 10}).status_code == 404
    assert friend.delete(f"/api/portfolio/{tid}", headers=H).status_code == 404
    friend.post("/api/portfolio/buy", headers=H, json={"symbol": "BBB", "date": "2025-02-02", "price": 21, "shares": 5})
    assert [p["symbol"] for p in admin.get("/api/portfolio").json()["positions"]] == ["AAA"]
    assert [p["symbol"] for p in friend.get("/api/portfolio").json()["positions"]] == ["BBB"]
    # separate files: the market file has no trades at all
    users = {r["username"]: r["id"] for r in admin.get("/api/admin").json()["people"]}
    friend_file = db.connect(tmp_path / "users" / f"{users['sara']}.db")
    assert [r["symbol"] for r in friend_file.execute("SELECT symbol FROM trades")] == ["BBB"]
    market = db.connect_market(tmp_path / "market.db")
    assert market.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='trades'").fetchone()[0] == 0


def test_only_the_admin_changes_shared_things(site):
    admin = _client(site, "owner", ADMIN_PW)
    friend, _ = _friend(site, admin)
    for method, path, body in (("post", "/api/jobs/scan", {}), ("post", "/api/jobs/kashif", {}),
                               ("post", "/api/predict/train", {}), ("get", "/api/admin", None),
                               ("post", "/api/admin/invites", {}), ("get", "/api/admin/backup", None),
                               ("post", "/api/alerts/telegram", {"token": "1:x"})):
        r = getattr(friend, method)(path, headers=H, **({"json": body} if body is not None else {}))
        assert r.status_code == 403, path
    assert friend.put("/api/settings", headers=H, json={"buy_score": 50}).status_code == 403
    assert friend.put("/api/settings", headers=H, json={"capital": 50_000, "shariah_filter": "kashif"}).status_code == 200
    mine = friend.get("/api/settings").json()
    assert mine["values"]["capital"] == 50_000 and "buy_score" not in mine["values"]
    assert {s["scope"] for s in mine["sections"]} == {"personal"}
    theirs = admin.get("/api/settings").json()
    assert theirs["values"]["capital"] == config.DEFAULTS["capital"] and theirs["values"]["shariah_filter"] == "off"
    assert "strategy" in {s["scope"] for s in theirs["sections"]}
    assert admin.put("/api/settings", headers=H, json={"buy_score": 75}).status_code == 200
    assert config.load_config()["buy_score"] == 75 and config.load_config()["capital"] == config.DEFAULTS["capital"]


def _scan_rows(market_path):
    conn = db.connect_market(market_path)
    base = {"score": 80, "setup": "Breakout", "entry_high": 13.2, "target": 14.4, "atr": 0.3,
            "avg_value": 1e8, "shares": 0, "amount": 0, "risk_egp": 0, "size_note": "", "reasons": []}
    db.save_scan(conn, "2026-09-24", [{**base, "symbol": "AAA", "action": "BUY", "close": 13.0, "stop": 12.3},
                                      {**base, "symbol": "BBB", "action": "BUY", "close": 26.0, "stop": 24.6}])
    db.set_meta(conn, "scan_data_date", "2026-09-24")
    db.set_meta(conn, "market", json.dumps({"date": "2026-09-24", "egx30_close": 1300.0, "egx30_change": 0.0,
                                            "risk_off": False}))
    conn.close()


def test_signals_use_each_persons_shariah_filter_and_capital(site, tmp_path):
    admin = _client(site, "owner", ADMIN_PW)
    friend, _ = _friend(site, admin)
    _scan_rows(tmp_path / "market.db")
    friend.put("/api/settings", headers=H, json={"capital": 50_000, "shariah_filter": "kashif"})
    a = admin.get("/api/today").json()
    f = friend.get("/api/today").json()
    assert [b["symbol"] for b in a["buys"]] == ["AAA", "BBB"]
    assert [b["symbol"] for b in f["buys"]] == ["AAA"]                        # BBB isn't Kashif-compliant
    assert "BBB" not in [w["symbol"] for w in f["watch"]]                    # nor close to a BUY: the filter hides it
    assert f["buys"][0]["shares"] < a["buys"][0]["shares"]                   # half the capital, smaller size
    assert friend.get("/api/status").json()["market"]["buys"] == 1


def test_scan_updates_every_paper_account_with_its_own_settings(site, tmp_path):
    admin = _client(site, "owner", ADMIN_PW)
    _friend(site, admin)
    s: accounts.Site = site.state.site
    market = s.market()
    idx = db.load_prices(market, "EGX30")
    ind = {sym: add_indicators(db.load_prices(market, sym), idx["close"]) for sym in ("AAA", "BBB")}
    table = pd.DataFrame({"sector": ["Banks", "Real Estate"], "kashif_status": ["compliant", None], "egx33": [1, 0]},
                         index=["AAA", "BBB"])
    buys = [{"symbol": sym, "sector": table.at[sym, "sector"], "score": 80, "close": float(ind[sym]["close"].iloc[-1]),
             "stop": float(ind[sym]["close"].iloc[-1]) * 0.95, "target": float(ind[sym]["close"].iloc[-1]) * 1.1,
             "entry_limit": float(ind[sym]["close"].iloc[-1]) * 1.01, "avg_value": 1e8} for sym in ("AAA", "BBB")]
    for person, conn, _cfg in s.each(market):
        if person.username == "sara":
            db.save_personal_settings(conn, {"shariah_filter": "kashif"})
    got = {}
    for person, conn, cfg in s.each(market):   # settings are read when each person's file is opened
        scan.process_account(conn, cfg, ind, ind["AAA"].index[-1], buys, table, risk_off=False)
        got[person.username] = sorted(r["symbol"] for r in conn.execute("SELECT symbol FROM trades WHERE account='paper'"))
    assert got == {"owner": ["AAA", "BBB"], "sara": ["AAA"]}
    market.close()


def test_one_bot_each_person_connects_their_own_chat(site, tmp_path, monkeypatch):
    admin = _client(site, "owner", ADMIN_PW)
    friend, _ = _friend(site, admin)
    token = "123456:" + "T" * 35
    updates = []

    def fake_call(tok, method, **params):
        assert tok == token
        if method == "getMe":
            return {"username": "egx_friends_bot", "first_name": "EGX"}
        if method == "getUpdates":
            off = params.get("offset") or 0
            return [u for u in updates if u["update_id"] >= off]
        return {}
    sent = []
    monkeypatch.setattr(alerts, "call", fake_call)
    monkeypatch.setattr(alerts, "send", lambda tok, chat, text: sent.append((chat, text)))
    assert admin.post("/api/alerts/telegram", headers=H, json={"token": token}).status_code == 200
    st = friend.get("/api/alerts").json()["telegram"]
    assert st["token_set"] and st["token_hint"] == "" and not st["can_set_bot"] and token not in json.dumps(st)

    links = {}
    for name, c in (("sara", friend), ("owner", admin)):
        url = c.post("/api/alerts/telegram/link", headers=H).json()["url"]
        assert url.startswith("https://t.me/egx_friends_bot?start=")
        links[name] = url.split("start=")[1]
    assert friend.post("/api/alerts/telegram/connect", headers=H).status_code == 400   # hasn't pressed Start yet
    updates += [{"update_id": 10, "message": {"text": f"/start {links['sara']}",
                                              "chat": {"id": 111, "type": "private", "first_name": "Sara"}}},
                {"update_id": 11, "message": {"text": f"/start {links['owner']}",
                                              "chat": {"id": 222, "type": "private", "first_name": "Owner"}}}]
    assert friend.post("/api/alerts/telegram/connect", headers=H).status_code == 200
    assert admin.post("/api/alerts/telegram/connect", headers=H).status_code == 200   # its code was kept for later
    assert friend.get("/api/alerts").json()["telegram"]["chat_name"] == "Sara"

    _scan_rows(tmp_path / "market.db")
    s = site.state.site
    market = s.market()
    sent.clear()
    assert jobs.send_alerts(s, market, config.load_config()) == "sent to 2 people"
    assert sorted(chat for chat, _ in sent) == ["111", "222"]
    assert jobs.send_alerts(s, market, config.load_config()) == ""            # once per close, per person
    market.close()


def test_secrets_never_leave_the_server(site):
    admin = _client(site, "owner", ADMIN_PW)
    _friend(site, admin)
    config.save_config({**config.load_config(), "telegram_token": "123456:" + "S" * 35})
    for path in ("/api/admin", "/api/settings", "/api/alerts", "/api/me", "/api/status"):
        text = admin.get(path).text
        assert "S" * 35 not in text and "scrypt$" not in text, path
    z = zipfile.ZipFile(io.BytesIO(admin.get("/api/admin/backup").content))
    names = set(z.namelist())
    assert {"market.db", "config.yaml"} <= names and any(n.startswith("users/") for n in names)
    assert "S" * 35 not in z.read("config.yaml").decode()


def test_admin_account_is_claimed_through_a_link(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CONFIG_PATH", tmp_path / "config.yaml")
    _market(tmp_path / "market.db").close()
    link = accounts.admin_link(tmp_path / "market.db", "https://egx.example.org/")
    assert link.startswith("https://egx.example.org/#/join?code=")
    app = create_app(tmp_path / "market.db", autoscan=False, multi_user=True, secure_cookies=False)
    c = _client(app)
    info = c.get(f"/api/auth/invite?code={link.split('code=')[1]}").json()
    assert info["claim"] is True
    r = c.post("/api/auth/join", headers=H, json={"code": link.split("code=")[1], "username": "owner",
                                                 "password": ADMIN_PW})
    assert r.json()["user"] == {"id": 1, "username": "owner", "display_name": "owner", "is_admin": True,
                                "accepted_terms": False}
    assert "/#/reset?code=" in accounts.admin_link(tmp_path / "market.db", "https://egx.example.org")


def test_password_change_signs_out_other_devices_and_disable_works(site):
    admin = _client(site, "owner", ADMIN_PW)
    friend, _ = _friend(site, admin)
    phone = _client(site, "sara", FRIEND_PW)
    assert friend.post("/api/auth/password", headers=H, json={"old": "nope", "new": "x" * 12}).status_code == 400
    assert friend.post("/api/auth/password", headers=H, json={"old": FRIEND_PW, "new": "new-friend-pass"}).status_code == 200
    assert phone.get("/api/me").status_code == 401 and friend.get("/api/me").status_code == 200
    sara = next(p for p in admin.get("/api/admin").json()["people"] if p["username"] == "sara")
    admin.post(f"/api/admin/users/{sara['id']}/disable", headers=H, json={"disabled": True})
    assert friend.get("/api/me").status_code == 401
    assert _client(site).post("/api/auth/login", headers=H,
                              json={"username": "sara", "password": "new-friend-pass"}).status_code == 401
    link = admin.post(f"/api/admin/users/{sara['id']}/reset", headers=H).json()["link"]
    assert "/#/reset?code=" in link


def test_mac_data_splits_into_market_and_your_own_file(tmp_path, monkeypatch):
    import importlib.util
    script = config.ROOT / "deploy" / "split_db.py"
    if not script.exists():
        pytest.skip("deploy/ stays on the Mac")
    spec = importlib.util.spec_from_file_location("split_db", script)
    split_db = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(split_db)

    mac = tmp_path / "mac"
    mac.mkdir()
    monkeypatch.setattr(config, "CONFIG_PATH", mac / "config.yaml")
    conn = db.connect(mac / "egx.db")                         # the Mac's single file
    conn.execute("INSERT INTO stocks(symbol, name_ar, sector_ar, kashif_status, egx33) VALUES ('AAA', 'أ', 'بنوك', 'compliant', 1)")
    df = make_ohlcv(np.linspace(10, 13, 300), volume=2e6).rename_axis("date").reset_index()
    df["date"] = df["date"].dt.strftime("%Y-%m-%d")
    db.upsert_prices(conn, "AAA", df)
    db.upsert_prices(conn, "EGX30", df)
    conn.commit()
    conn.close()
    config.save_config({**config.DEFAULTS, "capital": 101_684.0, "shariah_filter": "either", "buy_score": 72,
                        "telegram_chat_id": "42", "telegram_token": "123456:" + "K" * 35})
    mac_app = create_app(mac / "egx.db", autoscan=False)
    with TestClient(mac_app) as c:
        c.post("/api/portfolio/buy", headers=H, json={"symbol": "AAA", "date": "2025-02-02", "price": 12, "shares": 100})
        tid = c.get("/api/portfolio").json()["positions"][0]["id"]
        c.post(f"/api/portfolio/{tid}/dividend", headers=H, json={"date": "2025-02-20", "amount": 45})
        mac_portfolio = c.get("/api/portfolio").json()

    out = tmp_path / "site" / "data"
    res = split_db.split(mac / "egx.db", out, mac / "config.yaml")
    assert res["rows"]["trades"] == 1 and res["rows"]["dividends"] == 1 and res["rows"]["fills"] == 1
    market = sqlite3_names(out / "market.db")
    assert "trades" not in market and "prices" in market
    import yaml
    strategy = yaml.safe_load((out / "config.yaml").read_text())
    assert strategy["buy_score"] == 72 and "capital" not in strategy and "telegram_chat_id" not in strategy
    assert "telegram_token" not in strategy

    # on the website, the admin claims user 1 and finds the same portfolio
    monkeypatch.setattr(config, "CONFIG_PATH", out / "config.yaml")
    link = accounts.admin_link(out / "market.db", "https://egx.example.org")
    app = create_app(out / "market.db", autoscan=False, multi_user=True, secure_cookies=False)
    c = _client(app)
    c.post("/api/auth/join", headers=H, json={"code": link.split("code=")[1], "username": "owner", "password": ADMIN_PW})
    c.post("/api/auth/accept-terms", headers=H)
    site_portfolio = c.get("/api/portfolio").json()
    assert site_portfolio["summary"] == mac_portfolio["summary"]          # same capital, cash, dividends, P&L
    assert [p["symbol"] for p in site_portfolio["positions"]] == ["AAA"]
    assert c.get("/api/settings").json()["values"]["shariah_filter"] == "either"


def sqlite3_names(path):
    import sqlite3
    conn = sqlite3.connect(path)
    try:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        conn.close()
