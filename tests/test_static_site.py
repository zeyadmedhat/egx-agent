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
def test_paper_account_catch_up_matches_the_daily_scan(tmp_path, cfg):
    """The browser replays missed scans one by one; the result must equal the Mac's scan doing them day by day."""
    ind = market()
    rng = np.random.default_rng(3)
    stocks = pd.DataFrame({"symbol": list(ind), "sector": ["A", "B", "A", "C", "B"], "kashif_status": "compliant",
                           "egx33": 1}).set_index("symbol", drop=False)
    days = []
    for ts in list(ind["S0"].index[200:]):
        buys = []
        for sym, frame in ind.items():
            r = frame.loc[ts]
            if r.close > r.ema50 and rng.random() < 0.25:
                stop = float(strategy.initial_stop(r.close, r.atr14, cfg))
                buys.append({"symbol": sym, "sector": stocks.loc[sym, "sector"], "score": float(rng.uniform(70, 95)),
                             "setup": "Breakout", "close": float(r.close), "entry_high": float(r.close + 0.25 * r.atr14),
                             "entry_limit": float(r.close + 0.25 * r.atr14), "stop": stop,
                             "target": float(r.close + 2 * (r.close - stop)), "avg_value": 5e7})
        buys.sort(key=lambda b: -b["score"])
        days.append({"date": str(ts.date()), "risk_off": bool(rng.random() < 0.15), "buys": buys})

    conn = db.connect(tmp_path / "paper.db")
    py_stats = []
    for day in days:
        ts = pd.Timestamp(day["date"])
        py_stats.append(scan.process_account(conn, cfg, {s: f.loc[:ts] for s, f in ind.items()}, ts, day["buys"],
                                             stocks, day["risk_off"]))
    py_trades = portfolio.trades_df(conn, "paper").to_dict("records")
    last = pd.Timestamp(days[-1]["date"])
    closes = {s: float(f.close.loc[:last].iloc[-1]) for s, f in ind.items()}
    py_summary = portfolio.account_summary(conn, "paper", cfg, closes)
    dates = ind["S0"].index[ind["S0"].index <= last]
    py_curve = portfolio.equity_curve(conn, "paper", cfg, {s: f.close for s, f in ind.items()}, dates)

    (js,) = run_js({"op": "paper", "args": {"cfg": cfg, "bars": {s: bars_of(f) for s, f in ind.items()}, "days": days,
                                            "stocks": {s: stocks.loc[s].to_dict() for s in stocks.index}}})
    assert len(py_trades) >= 5 and any(t["status"] == "closed" for t in py_trades)
    assert len(js["trades"]) == len(py_trades)
    for a, b in zip(py_trades, js["trades"]):
        assert_same(a, b, TRADE_KEYS)
    for a, b in zip(py_stats, js["stats"]):
        assert_same(a, b, ("filled", "cancelled", "closed", "new_orders", "date"))
    assert_same(py_summary, js["summary"], ("cash", "equity", "realized", "unrealized", "open_count", "open_risk"))
    assert len(py_curve) == len(js["curve"])
    for (t, v), (jt, jv) in zip(py_curve.items(), js["curve"]):
        assert str(t.date()) == jt and np.isclose(v, jv)


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
    assert core["scans"][-1]["buys"][0]["symbol"] == "AAA"
    assert all(s["scope"] == "personal" for s in core["sections"])
    assert "atr14" in files["stock/AAA.bin"]["series"]
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


def test_daily_job_posts_once_per_close_and_builds_the_site(tmp_path, monkeypatch):
    from app import alerts, jobs, site_daily
    src = _site_db(tmp_path / "state" / "egx.db")
    strategy = tmp_path / "strategy.yaml"
    static_site.export_strategy(dict(config.DEFAULTS), strategy)
    monkeypatch.setattr(config, "CONFIG_PATH", strategy)
    monkeypatch.setattr(scan, "scan_is_stale", lambda conn: False)          # no downloads in tests
    scans = []
    monkeypatch.setattr(scan, "run_scan", lambda conn, cfg, progress=None, update_data=True: scans.append(update_data)
                        or {"date": "x", "buys": 1, "watches": 0})
    monkeypatch.setattr(jobs, "train_job", lambda conn, say: None)
    sent = []
    monkeypatch.setattr(alerts, "send", lambda token, chat, text: sent.append((chat, text)))

    first = site_daily.run(src, tmp_path / "site", PASSWORD, "me/egx", "123:abc", "-100", "https://me.github.io/egx/")
    assert scans == [False]            # the strategy is new to this data: re-scored without downloading
    assert first["telegram"] == "sent" and first["backtest"] == "updated" and first["site"]
    chat, text = sent[0]
    assert chat == "-100" and "AAA" in text and "buy up to" in text and "https://me.github.io/egx/" in text
    assert "shares" not in text.lower() and "MY PRIVATE NOTE" not in text
    assert (tmp_path / "site" / "data" / "backtest.bin").exists()

    second = site_daily.run(src, tmp_path / "site", PASSWORD, "me/egx", "123:abc", "-100")
    assert len(sent) == 1 and "telegram" not in second and second["scan"] == "no new close yet"
    assert scans == [False]            # same strategy, same close: nothing to redo
