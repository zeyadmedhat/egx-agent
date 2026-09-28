"""The GitHub Pages site: the browser's money rules give the same answers as the Python ones, and the published
files are encrypted and hold nothing private."""
import json
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from cryptography.exceptions import InvalidTag

from app import static_site
from egx_agent import config, corporate, db, portfolio, risk, scan, strategy
from egx_agent.indicators import add_indicators
from tests.conftest import make_ohlcv

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
needs_node = pytest.mark.skipif(NODE is None, reason="Node.js isn't installed")
PASSWORD = "test group password"
TRADE_KEYS = ("symbol", "status", "signal_date", "entry_date", "entry_price", "shares", "initial_stop", "stop", "target",
              "highest_close", "days_held", "exit_next_open", "last_bar_date", "exit_date", "exit_price", "exit_reason",
              "fees")


def run_js(*cases):
    res = subprocess.run([NODE, str(ROOT / "tests" / "js" / "parity.mjs")], input=json.dumps({"cases": list(cases)}),
                         capture_output=True, text=True, timeout=120, check=True)
    out = json.loads(res.stdout)
    for r in out:
        assert r["ok"], r.get("error")
    return [r["value"] for r in out]


def _none(v):
    return None if isinstance(v, float) and np.isnan(v) else v


def assert_same(py: dict, js: dict, keys):
    for k in keys:
        a, b = _none(py.get(k)), js.get(k)
        if isinstance(a, (int, float)) and not isinstance(a, bool) and isinstance(b, (int, float)):
            assert np.isclose(a, b, rtol=1e-9, atol=1e-7), f"{k}: Python {a!r} vs browser {b!r}"
        else:
            assert a == b, f"{k}: Python {a!r} vs browser {b!r}"


def bars_of(ind: pd.DataFrame) -> list[dict]:
    num = lambda v: None if pd.isna(v) else float(v)  # noqa: E731
    return [{"date": str(t.date()), "open": float(r.open), "high": float(r.high), "low": float(r.low),
             "close": float(r.close), "atr14": num(r.atr14), "ema50": num(r.ema50)} for t, r in ind.iterrows()]


def market(n=320, seed=11):
    rng = np.random.default_rng(seed)
    ind = {}
    for i in range(5):
        closes = 20 * np.exp(np.cumsum(rng.normal(0.0012 if i % 2 == 0 else 0.0002, 0.024, n)))
        df = make_ohlcv(closes, start="2025-01-05", spread=0.012, volume=rng.integers(1e6, 5e6, n))
        df["open"] = df["open"] * (1 + rng.normal(0, 0.006, n))       # some gaps at the open
        df["high"] = np.maximum(df["high"], df["open"])
        df["low"] = np.minimum(df["low"], df["open"])
        ind[f"S{i}"] = add_indicators(df)
    return ind


# ------------------------------------------------------------------ the browser's rules = the Python rules
@needs_node
def test_exit_rules_match(cfg):
    ind = market()
    cases, expected = [], []
    for sym, frame in ind.items():
        for i in (70, 150, 230, 300, 315):
            day, price = frame.index[i], float(frame.close.iloc[i])
            stop = float(strategy.initial_stop(price, frame.atr14.iloc[i], cfg))
            row = pd.Series({"symbol": sym, "entry_date": str(day.date()), "entry_price": price, "shares": 100,
                             "initial_stop": stop, "stop": stop, "target": price + 2 * (price - stop), "sector": "A"})
            expected.append(portfolio.real_status(row, frame, cfg))
            cases.append({"op": "realStatus", "args": {"trade": row.to_dict(), "bars": bars_of(frame), "cfg": cfg}})
    got = run_js(*cases)
    assert len({e["status"] for e in expected}) >= 2          # the cases cover more than one outcome
    for py, js in zip(expected, got):
        assert_same(py, js, ("status", "reason", "stop", "days_held", "event_date", "prev_stop", "last_close"))


@needs_node
def test_share_sizing_matches(cfg):
    rng = np.random.default_rng(5)
    cases, expected = [], []
    for k in range(40):
        c = {**cfg, "max_positions": int(rng.integers(1, 7)), "max_per_sector": int(rng.integers(1, 3)),
             "risk_per_trade_pct": float(rng.choice([0.5, 1.5, 3.0])), "max_open_risk_pct": float(rng.choice([2.0, 6.0]))}
        cands = []
        for j in range(int(rng.integers(1, 6))):
            close = float(rng.uniform(1, 150))
            cands.append({"symbol": f"C{j}", "sector": str(rng.choice(["A", "B", "Other"])), "close": close,
                          "stop": close * float(rng.uniform(0.85, 0.97)), "avg_value": float(rng.uniform(2e5, 5e7)),
                          "score": float(80 - j)})
        positions = [{"symbol": f"P{j}", "sector": [None, "A", "B"][int(rng.integers(0, 3))], "entry_price": 10.0,
                      "stop": float(rng.uniform(8, 11)), "shares": int(rng.integers(100, 3000))}
                     for j in range(int(rng.integers(0, 4)))]
        if k % 5 == 0 and positions:
            positions[0]["symbol"] = "C0"          # already held
        equity, cash, off = float(rng.uniform(2e4, 3e5)), float(rng.uniform(0, 2e5)), bool(k % 3 == 0)
        expected.append(risk.allocate(cands, equity, cash, positions, c, off))
        cases.append({"op": "allocate", "args": {"candidates": cands, "equity": equity, "cash": cash,
                                                 "positions": positions, "cfg": c, "risk_off": off}})
    notes = set()
    for py, js in zip(expected, run_js(*cases)):
        for a, b in zip(py, js):
            assert_same(a, b, ("symbol", "shares", "amount", "risk_egp", "size_note"))
            notes.add(a["size_note"].split(" ")[0])
    assert len(notes) >= 4          # several different limits were hit


@needs_node
def test_your_trades_bonus_shares_and_dividends_match(tmp_path, cfg):
    conn = db.connect(tmp_path / "real.db")
    t1 = portfolio.add_real_buy(conn, cfg, "AAA", "2026-01-05", 10.0, 100, 0.5, "Banks")
    portfolio.add_real_buy(conn, cfg, "AAA", "2026-01-07", 11.0, 50, 0.6, "Banks", notes="more")
    t2 = portfolio.add_real_buy(conn, cfg, "BBB", "2026-01-08", 20.0, 40, 0.9, "Real estate", stop=18.5)
    portfolio.sell_real(conn, cfg, t1, "2026-01-12", 12.0, 60, "Taking partial profit")
    per_share = corporate.add_dividend(conn, t2, "2026-01-15", 30.0)["per_share"]
    conn.execute("INSERT INTO price_events(symbol, ex_date, factor, detected) VALUES ('AAA', '2026-01-20', 1.25, 'x')")
    conn.commit()
    pend = corporate.pending(conn, "real")
    applied = corporate.apply(conn, t1, pend[t1]["event_id"], pend[t1]["shares_expected"])
    closes = {"AAA": 9.9, "BBB": 21.0}
    summary = portfolio.account_summary(conn, "real", cfg, closes)
    trades = portfolio.trades_df(conn, "real").to_dict("records")
    fills = [dict(r) for r in conn.execute("SELECT * FROM fills ORDER BY id")]

    # The browser numbers trades, fills and dividends from one counter: AAA is 1, BBB is 4.
    event = {"id": "AAA:2026-01-20", "symbol": "AAA", "ex_date": "2026-01-20", "factor": 1.25}
    buy = {"op": "buy", "sector": "Banks", "stop": None, "notes": ""}
    steps = [
        {**buy, "symbol": "AAA", "date": "2026-01-05", "price": 10.0, "shares": 100, "atr": 0.5},
        {**buy, "symbol": "AAA", "date": "2026-01-07", "price": 11.0, "shares": 50, "atr": 0.6, "notes": "more"},
        {**buy, "symbol": "BBB", "date": "2026-01-08", "price": 20.0, "shares": 40, "atr": 0.9, "sector": "Real estate",
         "stop": 18.5},
        {"op": "sell", "trade_id": 1, "date": "2026-01-12", "price": 12.0, "shares": 60, "reason": "Taking partial profit"},
        {"op": "dividend", "trade_id": 4, "date": "2026-01-15", "amount": 30.0, "note": ""},
        {"op": "pending"},
        {"op": "apply", "trade_id": 1, "event_id": event["id"], "shares": pend[t1]["shares_expected"],
         "today": "2026-01-21", "closes": closes},
    ]
    (js,) = run_js({"op": "real", "args": {"cfg": cfg, "steps": steps, "events": [event]}})
    assert js["out"][:3] == [1, 1, 4] and js["out"][3] == "partial" and np.isclose(js["out"][4], per_share)
    assert_same(pend[t1], js["out"][5]["1"], ("factor", "describe", "shares_now", "shares_expected", "ex_date"))
    assert_same(applied, js["out"][6], ("old", "new", "ratio", "avg"))
    assert len(js["trades"]) == len(trades)
    for a, b in zip(trades, js["trades"]):
        assert_same(a, b, TRADE_KEYS + ("notes",))
    assert [f["side"] for f in fills] == [f["side"] for f in js["fills"]]
    for a, b in zip(fills, js["fills"]):
        assert_same(a, b, ("symbol", "date", "side", "shares", "price", "fees", "note"))
    assert_same(summary, js["summary"], ("cash", "equity", "realized", "dividends", "unrealized", "open_risk"))


@needs_node
def test_mac_portfolio_backup_restores_on_the_site(tmp_path, cfg):
    """Your Mac portfolio, saved as a site backup: the site shows the same positions, cash and pending bonus shares."""
    conn = db.connect(tmp_path / "mac.db")
    conn.execute("INSERT INTO trades(account, status, symbol, entry_date, entry_price, shares, stop, target) "
                 "VALUES ('paper', 'open', 'ZZZ', '2026-01-02', 5, 10, 4, 6)")      # paper trades stay on the Mac
    t1 = portfolio.add_real_buy(conn, cfg, "AAA", "2026-01-05", 10.0, 100, 0.5, "Banks")
    portfolio.add_real_buy(conn, cfg, "AAA", "2026-01-07", 11.0, 50, 0.6, "Banks", notes="more")
    t2 = portfolio.add_real_buy(conn, cfg, "BBB", "2026-01-08", 20.0, 40, 0.9, "Real estate", stop=18.5)
    portfolio.sell_real(conn, cfg, t1, "2026-01-12", 12.0, 60, "Taking partial profit")
    corporate.add_dividend(conn, t2, "2026-01-15", 30.0)
    conn.execute("INSERT INTO price_events(symbol, ex_date, factor, detected) VALUES ('AAA', '2026-01-20', 1.25, 'x')")
    conn.execute("INSERT INTO price_events(symbol, ex_date, factor, detected) VALUES ('BBB', '2026-01-22', 2.0, 'x')")
    conn.commit()
    pend = corporate.pending(conn, "real")
    corporate.apply(conn, t1, pend[t1]["event_id"], pend[t1]["shares_expected"])      # AAA done, BBB still to do
    closes = {"AAA": 9.9, "BBB": 21.0}
    summary = portfolio.account_summary(conn, "real", cfg, closes)
    trades = portfolio.trades_df(conn, "real").to_dict("records")
    mine = {**cfg, "capital": 123456.0, "paper_capital": 5000.0, "telegram_token": "123:abc"}

    backup = static_site.portfolio_backup(conn, mine)
    text = json.dumps(backup)
    assert "ZZZ" not in text and "123:abc" not in text and "paper_capital" not in text
    events = [{"id": f"{r['symbol']}:{r['ex_date']}", "symbol": r["symbol"], "ex_date": r["ex_date"],
               "factor": r["factor"]} for r in conn.execute("SELECT * FROM price_events ORDER BY id")]
    (js,) = run_js({"op": "backup", "args": {"text": text, "cfg": cfg, "closes": closes, "events": events}})
    assert len(js["trades"]) == len(trades)
    for a, b in zip(trades, js["trades"]):
        assert_same(a, b, TRADE_KEYS + ("notes",))
    assert_same(summary, js["summary"], ("cash", "equity", "realized", "dividends", "unrealized", "open_risk"))
    assert list(js["pending"].values())[0]["symbol"] == "BBB" and len(js["pending"]) == 1
    assert len(js["fills"]) == conn.execute("SELECT COUNT(*) FROM fills").fetchone()[0]
    assert js["settings"]["capital"] == 123456.0 and js["next_id"] > max(t["id"] for t in js["trades"])
    conn.close()


@needs_node
def test_dates_and_words_match():
    from app import views
    pairs = [("2026-09-24", 1), ("2026-09-25", 1), ("2026-09-26", 3), ("2026-09-27", 20), ("2026-10-01", 0)]
    times = ["2026-09-27T12:00:00+03:00", "2026-09-27T15:31:00+03:00", "2026-09-25T18:00:00+03:00",
             "2026-09-26T09:00:00+03:00", "2026-01-04T15:29:00+02:00", "2026-01-04T23:59:00+02:00"]
    factors = [1.25, 1.1, 2.0, 1.5, 0.5, 4 / 3, 1.07, 3.0, 1.2345]
    values = [5.4321, 12.345, 1234.5, 0.5]
    got = run_js({"op": "sessionsAfter", "args": {"pairs": pairs}}, {"op": "expected", "args": {"times": times}},
                 {"op": "describe", "args": {"factors": factors}}, {"op": "px", "args": {"values": values}})
    assert got[0] == [views.sessions_after(d, n) for d, n in pairs]
    assert got[1] == [scan.expected_session_date(datetime.fromisoformat(t).astimezone(scan.CAIRO)).isoformat()
                      for t in times]
    assert got[2] == [corporate.describe(f) for f in factors]
    assert got[3] == [views.px(v) for v in values]


# ------------------------------------------------------------------ what gets published
def _site_db(path: Path) -> Path:
    conn = db.connect(path)
    conn.execute("INSERT INTO stocks(symbol, name_ar, sector_ar, kashif_status, egx33) VALUES ('AAA', 'أ', 'بنوك', 'compliant', 1)")
    conn.execute("INSERT INTO stocks(symbol, name_ar, sector_ar) VALUES ('BBB', 'ب', 'عقاري')")
    for sym, base in (("AAA", 10.0), ("BBB", 20.0), ("EGX30", 1000.0)):
        df = make_ohlcv(np.linspace(base, base * 1.3, 300), volume=2e6).rename_axis("date").reset_index()
        df["date"] = df["date"].dt.strftime("%Y-%m-%d")
        db.upsert_prices(conn, sym, df)
    last = conn.execute("SELECT MAX(date) FROM prices").fetchone()[0]
    row = {"symbol": "AAA", "action": "BUY", "score": 80, "setup": "Breakout", "close": 12.9, "entry_high": 13.0,
           "stop": 12.0, "target": 14.8, "atr": 0.3, "avg_value": 1e7, "shares": 0, "amount": 0, "risk_egp": 0,
           "size_note": "", "reasons": ["test"]}
    db.save_scan(conn, last, [row])
    db.set_meta(conn, "scan_data_date", last)
    db.set_meta(conn, "market", json.dumps({"date": last, "egx30_close": 1300, "egx30_change": 0.01, "risk_off": False}))
    # someone's own data in the same file must never be published
    portfolio.add_real_buy(conn, dict(config.DEFAULTS), "AAA", last, 12.9, 100, 0.3, notes="MY PRIVATE NOTE")
    conn.close()
    return path


def test_site_is_encrypted_and_holds_nothing_private(tmp_path, cfg):
    src = _site_db(tmp_path / "egx.db")
    cfg = {**cfg, "telegram_token": "123456789:AAE-secret-token-do-not-publish", "telegram_chat_id": "999"}
    conn = db.connect(src)
    res = static_site.build(conn, cfg, tmp_path / "site", PASSWORD, "me/egx")
    out = tmp_path / "site"
    info = json.loads((out / "data" / "site.json").read_text())
    assert set(info) == {"v", "salt", "iter", "stamp", "built"} and info["iter"] >= 600_000
    assert res["stocks"] == 2 and (out / "data" / "stock" / "AAA.bin").exists()

    page = (out / "index.html").read_text()
    assert 'data-mode="static"' in page and "Content-Security-Policy" in page and "noindex" in page
    assert '"./static/vendor/preact.module.js"' in page and '"/static/' not in page
    assert (out / "robots.txt").read_text().startswith("User-agent: *\nDisallow: /")

    # Every published byte: no token, no chat, no portfolio; the data only opens with the password.
    everything = b"".join(p.read_bytes() for p in out.rglob("*") if p.is_file())
    for secret in (b"secret-token", b"MY PRIVATE NOTE", PASSWORD.encode()):
        assert secret not in everything
    key = static_site.derive_key(PASSWORD, static_site.salt_for("me/egx"))
    files = {str(p.relative_to(out / "data")): static_site.unseal(p.read_bytes(), key)
             for p in (out / "data").rglob("*.bin")}
    text = json.dumps(files, ensure_ascii=False)
    assert "secret-token" not in text and "MY PRIVATE NOTE" not in text and '"999"' not in text
    core = files["core.bin"]
    assert not any(k.startswith("telegram") for k in core["strategy"])
    assert core["signals"][0]["symbol"] == "AAA" and core["signals"][0]["trigger"]
    assert {s["symbol"] for s in core["stocks"]} == {"AAA", "BBB"}
    assert all(s["scope"] == "personal" for s in core["sections"])
    # No paper trading or backtest on the site: those stay on the Mac.
    assert "scans" not in core and "backtest.bin" not in files
    fields = {f["key"] for s in core["sections"] for f in s["fields"]}
    assert "capital" in fields and not fields & {"paper_capital", "auto_paper"}
    assert not {"paper_capital", "auto_paper"} & set(core["personal_defaults"])
    assert "atr14" in files["stock/AAA.bin"]["series"]
    assert files["stock/AAA.bin"]["plan"]["stop"] < files["stock/AAA.bin"]["stats"]["close"]   # for the calculator
    assert {"dividends", "yield", "bonus"} <= set(files["stock/AAA.bin"]["corporate"])
    screen = files["screener.bin"]
    assert {r["symbol"] for r in screen["rows"]} == {"AAA", "BBB"} and "held" not in screen["rows"][0]   # yours: in the browser
    assert {"vs_ema50", "from_high", "rsi", "yield", "top10"} <= set(screen["rows"][0])
    with pytest.raises(InvalidTag):
        static_site.unseal((out / "data" / "core.bin").read_bytes(),
                           static_site.derive_key("not the password", static_site.salt_for("me/egx")))

    # The stamp only changes when the data does, so browsers don't reload for nothing.
    assert static_site.build(conn, cfg, tmp_path / "site2", PASSWORD, "me/egx")["stamp"] == res["stamp"]
    db.set_meta(conn, "market", json.dumps({"date": "x", "egx30_close": 1301, "risk_off": False}))
    assert static_site.build(conn, cfg, tmp_path / "site3", PASSWORD, "me/egx")["stamp"] != res["stamp"]
    conn.close()


def test_short_passwords_are_refused(tmp_path, cfg):
    conn = db.connect(_site_db(tmp_path / "egx.db"))
    with pytest.raises(SystemExit):
        static_site.build(conn, cfg, tmp_path / "site", "short", "me/egx")
    conn.close()


def test_strategy_file_has_no_personal_numbers(tmp_path, cfg):
    path = static_site.export_strategy({**cfg, "capital": 123456.0, "telegram_token": "123:abc", "buy_score": 75},
                                       tmp_path / "strategy.yaml")
    text = path.read_text()
    assert "buy_score: 75" in text and "123456" not in text and "telegram" not in text and "capital" not in text


class FakeBot:
    """Telegram's getMe, getUpdates and sendMessage, in memory. Messages are never confirmed, as in the real job."""

    def __init__(self):
        self.updates, self.sent, self.blocked = [], [], set()

    def says(self, chat_id: int, text: str, kind: str = "private", name: str = "Zarqa-Friend"):
        self.updates.append({"update_id": 500 + len(self.updates),
                             "message": {"chat": {"id": chat_id, "type": kind, "first_name": name}, "text": text}})

    def call(self, token, method, **params):
        if method == "getMe":
            return {"username": "TestEGXBot", "first_name": "EGX"}
        assert method == "getUpdates" and "offset" not in params
        return list(self.updates)

    def send(self, token, chat, text):
        from app import alerts
        if chat in self.blocked:
            raise alerts.TelegramError("Telegram: Forbidden: bot was blocked by the user", 403)
        self.sent.append((chat, text))


def test_daily_job_messages_each_friend_once_per_close(tmp_path, monkeypatch):
    from app import alerts, jobs, site_daily
    src = _site_db(tmp_path / "state" / "egx.db")
    site = tmp_path / "site"
    strategy = tmp_path / "strategy.yaml"
    static_site.export_strategy(dict(config.DEFAULTS), strategy)
    monkeypatch.setattr(config, "CONFIG_PATH", strategy)
    monkeypatch.setattr(scan, "scan_is_stale", lambda conn: False)          # no downloads in tests
    scans = []
    monkeypatch.setattr(scan, "run_scan", lambda conn, cfg, progress=None, update_data=True: scans.append(update_data)
                        or {"date": "x", "buys": 1, "watches": 0})
    monkeypatch.setattr(jobs, "train_job", lambda conn, say: None)
    bot = FakeBot()
    monkeypatch.setattr(alerts, "call", bot.call)
    monkeypatch.setattr(alerts, "send", bot.send)
    code = static_site.telegram_code(PASSWORD, "me/egx")
    bot.says(111, f"/start {code}")
    bot.says(222, "/start SomeOtherLink123")           # e.g. your Mac's own link: not for the site
    bot.says(-333, f"/start {code}", kind="group")     # only private chats
    bot.says(444, "hello")

    first = site_daily.run(src, site, PASSWORD, "me/egx", "123:abc", "https://me.github.io/egx/")
    assert scans == [False]            # the strategy is new to this data: re-scored without downloading
    assert first["telegram"] == "1 connected (1 new, 0 left), sent to 1" and "backtest" not in first
    assert [c for c, _ in bot.sent] == ["111", "111"]
    assert "Connected" in bot.sent[0][1]
    daily = bot.sent[1][1]
    assert "AAA" in daily and "buy up to" in daily and "https://me.github.io/egx/" in daily and "/stop" in daily
    assert "shares" not in daily.lower() and "MY PRIVATE NOTE" not in daily
    # The link is only inside the encrypted data; nothing about who connected is published or logged.
    key = static_site.derive_key(PASSWORD, static_site.salt_for("me/egx"))
    core = static_site.unseal((site / "data" / "core.bin").read_bytes(), key)
    assert core["telegram"] == {"bot": "TestEGXBot", "link": f"https://t.me/TestEGXBot?start={code}"}
    assert core["final"] is True
    # The owner's Run scan button opens the scan on GitHub; the site holds no GitHub key for it.
    assert core["scan_url"] == "https://github.com/me/egx/actions/workflows/site.yml"
    assert static_site.scan_page("local") is None and static_site.scan_page('a/b"><script>') is None
    everything = b"".join(p.read_bytes() for p in site.rglob("*") if p.is_file())
    assert code.encode() not in everything and b"Zarqa-Friend" not in everything
    assert "Zarqa-Friend" not in json.dumps(first) and "111" not in json.dumps(first)

    # The same messages come back next time: nobody is welcomed or sent the same close twice.
    second = site_daily.run(src, site, PASSWORD, "me/egx", "123:abc")
    assert len(bot.sent) == 2 and second["telegram"] == "1 connected (0 new, 0 left), sent to 0"
    assert second["scan"] == "no new close yet" and scans == [False]

    # A new friend gets the latest close at once; /stop disconnects.
    bot.says(555, f"/start {code}", name="Omar")
    bot.says(111, "/stop")
    third = site_daily.run(src, site, PASSWORD, "me/egx", "123:abc")
    assert third["telegram"] == "1 connected (1 new, 1 left), sent to 1"
    assert [c for c, _ in bot.sent[2:]] == ["555", "111", "555"] and "Stopped" in bot.sent[3][1]

    # A scan during the session isn't sent; the one after the close is. A friend who blocked the bot is removed.
    conn = db.connect(src)
    new_close = "2099-01-05"
    db.set_meta(conn, "scan_data_date", new_close)
    db.set_meta(conn, "market", json.dumps({"date": new_close, "egx30_close": 1300, "egx30_change": 0.01,
                                            "risk_off": False, "finished": f"{new_close}T11:30:00+02:00"}))
    conn.close()
    bot.says(666, f"/start {code}", name="Mona")
    fourth = site_daily.run(src, site, PASSWORD, "me/egx", "123:abc")
    assert fourth["telegram"] == "2 connected (1 new, 0 left), sent to 0" and "during the session" in fourth["data"]
    assert static_site.unseal((site / "data" / "core.bin").read_bytes(), key)["final"] is False
    conn = db.connect(src)
    db.set_meta(conn, "market", json.dumps({"date": new_close, "egx30_close": 1300, "egx30_change": 0.01,
                                            "risk_off": False, "finished": f"{new_close}T15:45:00+02:00"}))
    conn.close()
    bot.blocked.add("555")
    fifth = site_daily.run(src, site, PASSWORD, "me/egx", "123:abc")
    assert fifth["telegram"] == "1 connected (0 new, 1 left), sent to 1"
    assert bot.sent[-1][0] == "666" and "5 Jan close" in bot.sent[-1][1]

    # A new password disconnects everyone until they press the new link.
    sixth = site_daily.run(src, site, "a brand new password", "me/egx", "123:abc")
    assert sixth["telegram"] == "0 connected (0 new, 1 left), sent to 0"
    assert bot.sent[-1][0] == "666" and "password has changed" in bot.sent[-1][1]


def test_scheduled_runs_publish_only_when_something_changed(tmp_path, monkeypatch):
    from app import jobs, site_daily
    src = _site_db(tmp_path / "state" / "egx.db")
    strategy = tmp_path / "strategy.yaml"
    static_site.export_strategy(dict(config.DEFAULTS), strategy)
    monkeypatch.setattr(config, "CONFIG_PATH", strategy)
    monkeypatch.setattr(scan, "scan_is_stale", lambda conn: False)
    monkeypatch.setattr(scan, "run_scan", lambda *a, **k: {"date": "x", "buys": 1, "watches": 0})
    monkeypatch.setattr(jobs, "train_job", lambda conn, say: None)
    first = site_daily.run(src, tmp_path / "site", PASSWORD, "me/egx")
    assert first["publish"] and first["telegram"] == "not set up"
    live = json.loads((tmp_path / "site" / "data" / "site.json").read_text())["stamp"]
    monkeypatch.setattr(site_daily, "live_stamp", lambda url: live)
    assert not site_daily.run(src, tmp_path / "site", PASSWORD, "me/egx", always_publish=False)["publish"]
    monkeypatch.setattr(site_daily, "live_stamp", lambda url: "older")
    assert site_daily.run(src, tmp_path / "site", PASSWORD, "me/egx", always_publish=False)["publish"]


def test_a_scan_during_the_session_is_redone_after_the_close(tmp_path, monkeypatch):
    from datetime import date
    conn = db.connect(tmp_path / "egx.db")
    db.set_meta(conn, "scan_data_date", "2026-09-28")
    db.set_meta(conn, "market", json.dumps({"finished": "2026-09-28T11:55:00+03:00"}))
    assert not scan.scan_is_final(conn)
    monkeypatch.setattr(scan, "expected_session_date", lambda now=None: date(2026, 9, 27))    # still trading
    assert not scan.scan_is_stale(conn)
    monkeypatch.setattr(scan, "expected_session_date", lambda now=None: date(2026, 9, 28))    # after 15:30
    assert scan.scan_is_stale(conn)
    db.set_meta(conn, "market", json.dumps({"finished": "2026-09-28T15:45:00+03:00"}))
    assert scan.scan_is_final(conn) and not scan.scan_is_stale(conn)
    db.set_meta(conn, "market", json.dumps({"finished": "2026-09-29T09:00:00+03:00"}))      # the next morning
    assert scan.scan_is_final(conn)
    conn.close()


def test_a_scan_during_the_session_does_not_hold_back_the_one_after_the_close(tmp_path, monkeypatch):
    """The 2-hour pause after a try only counts tries made once the close's data was due (15:30 Cairo)."""
    from datetime import date, timedelta
    conn = db.connect(tmp_path / "egx.db")
    db.set_meta(conn, "scan_data_date", "2026-09-28")
    db.set_meta(conn, "market", json.dumps({"finished": "2026-09-28T15:00:00+03:00"}))
    monkeypatch.setattr(scan, "expected_session_date", lambda now=None: date(2026, 9, 28))
    due = datetime(2026, 9, 28, 15, 30, tzinfo=scan.CAIRO).astimezone().replace(tzinfo=None)

    class Clock(datetime):          # it's 15:50 Cairo
        @classmethod
        def now(cls, tz=None):
            return due + timedelta(minutes=20)

    monkeypatch.setattr(scan, "datetime", Clock)
    db.set_meta(conn, "scan_attempted", (due - timedelta(minutes=30)).isoformat())
    assert scan.scan_is_stale(conn)          # tried at 15:00, during the session: scan again now
    db.set_meta(conn, "scan_attempted", (due + timedelta(minutes=5)).isoformat())
    assert not scan.scan_is_stale(conn)      # tried at 15:35 with no new data yet: wait a while
    conn.close()


@needs_node
def test_size_calculator_uses_the_signals_own_sizing_rule():
    from app import views
    cfg = {k: config.DEFAULTS[k] for k in views.CALC_KEYS}
    held = [{"symbol": "AAA", "sector": "Banks", "entry_price": 50.0, "stop": 46.0, "shares": 300},
            {"symbol": "CCC", "sector": "Banks", "entry_price": 10.0, "stop": 9.2, "shares": 1000}]
    base = dict(symbol="BBB", sector="Real Estate", entry=20.0, stop=18.6, equity=100_000.0, cash=60_000.0,
                avgValue=5e6, positions=held, cfg=cfg, riskOff=False)
    full, half, banks, off, wide, bad_stop = run_js(
        {"op": "plan", "args": base}, {"op": "plan", "args": {**base, "half": True}},
        {"op": "plan", "args": {**base, "sector": "Banks"}}, {"op": "plan", "args": {**base, "riskOff": True, "positions": held * 2}},
        {"op": "plan", "args": {**base, "stop": 15.0}}, {"op": "plan", "args": {**base, "stop": 21.0}})
    want = risk.size_position(20.0, 18.6, 100_000.0, 60_000.0, 5e6, risk.open_risk(held), cfg)
    assert full["shares"] == want["shares"] > 0 and full["size_note"] == want["size_note"]
    assert full["amount"] == pytest.approx(want["amount"]) and full["target"] == pytest.approx(20 + 2 * 1.4)
    assert full["loss_at_stop"] == pytest.approx(want["risk_egp"] + want["amount"] * 0.0025 + want["shares"] * 18.6 * 0.0025)
    assert half["shares"] == want["shares"] // 2 and half["size_note"].startswith("half of")
    levels = lambda r: {c["level"] for c in r["checks"]}                           # noqa: E731
    assert levels(full) == {"ok"}
    assert any("2 positions in Banks" in c["text"] and c["level"] == "bad" for c in banks["checks"])
    assert off["max_positions"] == 2 and any("portfolio is full" in c["text"] for c in off["checks"])
    assert any(c["level"] == "warn" and "usual stop is 4–12%" in c["text"] for c in wide["checks"])
    assert bad_stop == {"ok": False, "error": "The stop must be below the entry price."}
