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
from egx_agent import config, corporate, db, holidays, levels, portfolio, risk, scan, strategy
from egx_agent.data import prices as prices_mod
from egx_agent.indicators import add_indicators
from tests.conftest import make_ohlcv

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
needs_node = pytest.mark.skipif(NODE is None, reason="Node.js isn't installed")
PASSWORD = "test group password"
TRADE_KEYS = ("symbol", "status", "signal_date", "entry_date", "entry_price", "shares", "initial_stop", "stop", "target",
              "highest_close", "days_held", "exit_next_open", "last_bar_date", "exit_date", "exit_price", "exit_reason",
              "fees")


def run_js(*cases, raw=False):
    res = subprocess.run([NODE, str(ROOT / "tests" / "js" / "parity.mjs")], input=json.dumps({"cases": list(cases)}),
                         capture_output=True, text=True, timeout=120, check=True)
    out = json.loads(res.stdout)
    if raw:                                    # [{ok, value | error}]: for cases that should fail
        return out
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
    """The bars the site's browser code gets, with the support stop the site build adds (levels.with_support)."""
    ind = levels.with_support(ind, config.DEFAULTS)
    num = lambda v: None if pd.isna(v) else float(v)  # noqa: E731
    return [{"date": str(t.date()), "open": float(r.open), "high": float(r.high), "low": float(r.low),
             "close": float(r.close), "atr14": num(r.atr14), "ema20": num(r.ema20), "ema50": num(r.ema50),
             "sup": num(r["sup"]) if "sup" in ind else None,
             "div": float(r["div"]) if "div" in ind and r["div"] > 0 else 0} for t, r in ind.iterrows()]


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
            for be in (0.0, 5.0):                              # the stop's floor after +1R: the entry, or entry +5%
                c = {**cfg, "breakeven_pct": be}
                day, price = frame.index[i], float(frame.close.iloc[i])
                stop = float(strategy.initial_stop(price, frame.atr14.iloc[i], c))
                row = pd.Series({"symbol": sym, "entry_date": str(day.date()), "entry_price": price, "shares": 100,
                                 "initial_stop": stop, "stop": stop, "target": price + 2 * (price - stop), "sector": "A"})
                expected.append(portfolio.real_status(row, frame, c))
                cases.append({"op": "realStatus", "args": {"trade": row.to_dict(), "bars": bars_of(frame), "cfg": c}})
    got = run_js(*cases)
    assert len({e["status"] for e in expected}) >= 2          # the cases cover more than one outcome
    assert any(a["stop"] != b["stop"] for a, b in zip(expected[::2], expected[1::2]))    # and the floor matters
    for py, js in zip(expected, got):
        assert_same(py, js, ("status", "reason", "stop", "days_held", "event_date", "prev_stop", "last_close"))


@needs_node
def test_an_old_buy_logged_today_under_its_stop_says_sell_and_a_big_loss_waits_for_a_bounce(cfg):
    """A buy dated after the last close (an old position logged today at its old price) has no day to replay: if
    the last close is under its stop the rules say sell, not hold (AMES: bought at 80, logged on 3 Oct, at 46.60).
    30%+ under its price, they say sell on the first close back above the 20-day average instead, within 20 sessions;
    once that close came, sell."""
    frame = market()["S0"]
    last = float(frame.close.iloc[-1])
    def case(entry, entry_date="2099-01-01", f=frame):
        row = pd.Series({"symbol": "S0", "entry_date": entry_date, "entry_price": entry, "shares": 100,
                         "initial_stop": entry * 0.88, "stop": entry * 0.88, "target": entry * 1.24, "sector": "A"})
        py = portfolio.real_status(row, f, cfg)
        js, = run_js({"op": "realStatus", "args": {"trade": row.to_dict(), "bars": bars_of(f), "cfg": cfg}})
        assert_same(py, js, ("status", "reason", "stop", "days_held", "event_date", "last_close", "bounce_by"))
        return py
    small = case(last * 1.15)
    assert small["status"] == "EXIT" and "under your stop" in small["reason"]
    under = frame.iloc[:int((frame.close < frame.ema20).to_numpy().nonzero()[0][-1]) + 1]   # ends under its 20-day average
    big = case(float(under.close.iloc[-1]) * 1.7, f=under)
    assert big["status"] == "BOUNCE" and big["bounce_level"] == pytest.approx(float(under.ema20.iloc[-1]))
    assert case(last * 1.7)["reason"].startswith("Big loss")       # ends above it: the bounce is here, sell
    # bought 30 sessions before the end far above the price: 20 sessions without a bounce, or the bounce came
    old = case(float(frame.close.iloc[-31]) * 2, str(frame.index[-31].date()))
    assert old["status"] == "EXIT" and old["reason"].startswith("Big loss")


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
def test_a_rights_issue_subscribed_or_not_matches(tmp_path, cfg):
    """KORA-like: 0.9 new share per share at 0.205 against a 6.50 price re-bases past prices ÷ 1.848. AAA subscribed
    (1,000 → 1,900 shares, paying 0.205 each), BBB sold its rights (kept 1,000). Python and the browser agree."""
    conn = db.connect(tmp_path / "real.db")
    t1 = portfolio.add_real_buy(conn, cfg, "AAA", "2026-01-05", 6.5, 1000, 0.3, "Energy")
    t2 = portfolio.add_real_buy(conn, cfg, "BBB", "2026-01-05", 6.5, 1000, 0.3, "Energy")
    for sym in ("AAA", "BBB"):
        conn.execute("INSERT INTO corp_actions(symbol, kind, type, announced, effective, note, first_seen) "
                     "VALUES (?, 'rights', 'Capital Increase - Rights Issue', '2026-01-10', '2026-01-20', '', 'x')", (sym,))
        conn.execute("INSERT INTO price_events(symbol, ex_date, factor, detected) VALUES (?, '2026-01-20', 1.848, 'x')",
                     (sym,))
    conn.commit()
    events = corporate.events(conn)
    pend = corporate.pending(conn, "real")
    assert all(e["rights"] for e in events) and pend[t1]["rights"] and pend[t1]["shares_expected"] == 1000
    assert corporate.adjust_problem(1000, pend[t1], 900) and corporate.adjust_problem(1000, pend[t1], 1900, 0)
    before = conn.execute("SELECT * FROM trades WHERE id=?", (t1,)).fetchone()
    a = corporate.apply(conn, t1, pend[t1]["event_id"], 1900, 0.205)
    b = corporate.apply(conn, t2, pend[t2]["event_id"], 1000)
    assert a["avg"] == pytest.approx((before["entry_price"] * 1000 + 900 * 0.205) / 1900)   # what you paid in all
    assert b["avg"] == pytest.approx(before["entry_price"] / 1.848)
    aaa = conn.execute("SELECT * FROM trades WHERE id=?", (t1,)).fetchone()
    assert aaa["stop"] == pytest.approx(before["stop"] / 1.848)                             # follows the prices
    closes = {"AAA": 3.6, "BBB": 3.6}
    summary = portfolio.account_summary(conn, "real", cfg, closes)
    trades = portfolio.trades_df(conn, "real").to_dict("records")
    fills = [dict(r) for r in conn.execute("SELECT * FROM fills ORDER BY id")]

    buy = {"op": "buy", "sector": "Energy", "stop": None, "notes": "", "date": "2026-01-05", "price": 6.5, "shares": 1000,
           "atr": 0.3}
    steps = [{**buy, "symbol": "AAA"}, {**buy, "symbol": "BBB"}, {"op": "pending"},
             {"op": "apply", "trade_id": 1, "event_id": "AAA:2026-01-20", "shares": 1900, "paid": 0.205, "today": "2026-01-21"},
             {"op": "apply", "trade_id": 3, "event_id": "BBB:2026-01-20", "shares": 1000, "today": "2026-01-21",
              "closes": closes}]
    (js,) = run_js({"op": "real", "args": {"cfg": cfg, "steps": steps, "events": events}})
    assert_same(pend[t1], js["out"][2]["1"], ("factor", "rights", "describe", "shares_now", "shares_expected"))
    assert_same(a, js["out"][3], ("old", "new", "ratio", "avg"))
    assert_same(b, js["out"][4], ("old", "new", "ratio", "avg"))
    for x, y in zip(trades, js["trades"]):
        assert_same(x, y, TRADE_KEYS)
    for x, y in zip(fills, js["fills"]):
        assert_same(x, y, ("symbol", "date", "side", "shares", "price", "fees", "note"))
    assert_same(summary, js["summary"], ("cash", "equity", "realized", "unrealized", "open_risk"))

    # Editing a transaction later rebuilds the position from them: the rights issue's cost stays in.
    (again,) = run_js({"op": "real", "args": {"cfg": cfg, "events": events, "steps": steps + [
        {"op": "edit", "fill": 0, "set": {"note": "edited"}, "atr": 0.3}]}})
    assert again["out"][-1] == "ok" and again["trades"][0]["entry_price"] == pytest.approx(a["avg"])


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
    holidays.HOLIDAYS.update({"2026-10-08": "x", "2026-10-11": "y"})      # the same with EGX's holidays
    try:
        pairs += [("2026-10-07", 1), ("2026-10-06", 3)]
        times += ["2026-10-08T18:00:00+03:00", "2026-10-11T16:00:00+03:00", "2026-10-12T09:00:00+03:00"]
        got = run_js({"op": "sessionsAfter", "args": {"pairs": pairs, "holidays": dict(holidays.HOLIDAYS)}},
                     {"op": "expected", "args": {"times": times, "holidays": dict(holidays.HOLIDAYS)}})
        assert got[0] == [views.sessions_after(d, n) for d, n in pairs] and got[0][-1] == "2026-10-13"
        assert got[1] == [scan.expected_session_date(datetime.fromisoformat(t).astimezone(scan.CAIRO)).isoformat()
                          for t in times] and got[1][-3:] == ["2026-10-07"] * 3
    finally:
        holidays.HOLIDAYS.clear()


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
    assert set(info) == {"v", "salt", "iter", "stamp", "built", "worker"} and info["iter"] >= 600_000
    assert info["worker"] is None                     # the bot's address, only when it has one
    assert res["stocks"] == 2 and (out / "data" / "stock" / "AAA.bin").exists()

    page = (out / "index.html").read_text()
    assert 'data-mode="static"' in page and "Content-Security-Policy" in page and "noindex" in page
    assert f'"./static/{static_site.code_version()}/vendor/preact.module.js"' in page and '"/static/' not in page
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
    assert core["personal_defaults"]["shariah_filter"] == "kashif"      # friends start with Kashif-compliant only
    assert "atr14" in files["stock/AAA.bin"]["series"]
    assert files["stock/AAA.bin"]["plan"]["stop"] < files["stock/AAA.bin"]["stats"]["close"]   # for the calculator
    assert {"dividends", "yield", "bonus"} <= set(files["stock/AAA.bin"]["corporate"])
    screen = files["screener.bin"]
    assert {r["symbol"] for r in screen["rows"]} == {"AAA", "BBB"} and "held" not in screen["rows"][0]   # yours: in the browser
    assert {"vs_ema50", "from_high", "rsi", "yield", "top10"} <= set(screen["rows"][0])
    assert files["history.bin"]["buys"] == [{"date": files["core.bin"]["scan_date"], "symbol": "AAA", "setup": "Breakout"}]
    assert {"dividends", "yields", "bonus"} <= set(files["dividends.bin"]) and "held" not in files["dividends.bin"]
    market = files["market.bin"]
    assert set(market["movers"]) == {"chg1", "ret5", "ret21"} and "AAA" in market["highs"]   # a steady climb
    assert "fills" not in files["history.bin"]                                           # yours stay in your browser
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

    def send(self, token, chat, text, buttons=None):
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
    monkeypatch.setattr(scan, "scan_is_stale", lambda conn, *_: False)          # no downloads in tests
    monkeypatch.setattr(scan, "session_scan_due", lambda conn, *_: False)
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
    assert "AAA" in daily and "Buy up to" in daily and "https://me.github.io/egx/" in daily and "/stop" in daily
    assert "shares" not in daily.lower() and "MY PRIVATE NOTE" not in daily
    # The link is only inside the encrypted data; nothing about who connected is published or logged.
    key = static_site.derive_key(PASSWORD, static_site.salt_for("me/egx"))
    core = static_site.unseal((site / "data" / "core.bin").read_bytes(), key)
    assert core["telegram"] == {"bot": "TestEGXBot", "link": f"https://t.me/TestEGXBot?start={code}", "worker": None}
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
    monkeypatch.setattr(scan, "scan_is_stale", lambda conn, *_: False)
    monkeypatch.setattr(scan, "session_scan_due", lambda conn, *_: False)
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




def test_editing_a_transaction_rebuilds_the_trade_as_if_logged_right():
    """My Portfolio's edit/delete buttons: logging a wrong price and fixing it gives the same trades as logging it
    right; deleting the sale of every share opens the position again; deleting its only buy deletes it."""
    cfg = {**config.DEFAULTS, "broker": "thndr"}
    buy = {"op": "buy", "symbol": "AAA", "sector": "Banks", "stop": None, "notes": "", "atr": 0.5}
    right = [{**buy, "date": "2026-01-04", "price": 10.0, "shares": 100}, {**buy, "date": "2026-01-06", "price": 11.0, "shares": 100},
             {"op": "sell", "trade_id": 1, "date": "2026-01-08", "price": 13.0, "shares": 50, "reason": "Target reached"}]
    wrong = [right[0], {**right[1], "price": 12.0}, right[2], {"op": "edit", "fill": 1, "set": {"price": 11.0}, "atr": 0.5}]
    closed = [right[0], {"op": "sell", "trade_id": 1, "date": "2026-01-08", "price": 12.0, "shares": 100, "reason": "Target reached"}]
    a, b, c, d = run_js(
        {"op": "real", "args": {"cfg": cfg, "steps": right, "events": []}},
        {"op": "real", "args": {"cfg": cfg, "steps": wrong, "events": []}},
        {"op": "real", "args": {"cfg": cfg, "steps": closed + [{"op": "delfill", "fill": 1, "atr": 0.5}], "events": []}},
        {"op": "real", "args": {"cfg": cfg, "steps": [right[0], {"op": "delfill", "fill": 0, "atr": 0.5}], "events": []}})
    strip = lambda ts: sorted(({k: v for k, v in x.items() if k != "id"} for x in ts), key=lambda x: x["status"])  # noqa: E731
    assert len(a["trades"]) == len(b["trades"]) == 2                     # the open rest and the partial sale
    for x, y in zip(strip(a["trades"]), strip(b["trades"])):
        assert x.keys() == y.keys()
        for k in x:
            assert x[k] == (pytest.approx(y[k]) if isinstance(y[k], float) else y[k]), k
    assert a["summary"]["cash"] == pytest.approx(b["summary"]["cash"])
    reopened = c["trades"]
    assert len(reopened) == 1 and reopened[0]["status"] == "open" and reopened[0]["shares"] == 100 and reopened[0]["exit_date"] is None
    assert d["out"][-1] == "deleted" and d["trades"] == []
    oversold, = run_js({"op": "real", "args": {"cfg": cfg, "events": [],
                        "steps": right + [{"op": "edit", "fill": 2, "set": {"shares": 500}, "atr": 0.5}]}}, raw=True)
    assert not oversold["ok"] and "you held 200" in oversold["error"]


def test_a_price_with_the_fees_in_it_adds_no_fees_and_keeps_that_when_edited():
    """Thndr's average cost has its fees in it: logged as such (the screenshot import does it), the site adds none,
    so the loss matches Thndr's (KORA: 12,299 at an exact average of 6.43298, now 6.18: Thndr says −3,111.38)."""
    cfg = {**config.DEFAULTS, "broker": "thndr_trader"}
    buy = {"op": "buy", "symbol": "AAA", "sector": "Banks", "stop": None, "notes": "", "atr": 0.3, "date": "2026-01-04",
           "shares": 12_299, "price": 6.43298, "fees_in": True}
    a, b = run_js({"op": "real", "args": {"cfg": cfg, "events": [], "steps": [{**buy, "closes": {"AAA": 6.18}}]}},
                  {"op": "real", "args": {"cfg": cfg, "events": [], "steps": [
                      buy, {"op": "edit", "fill": 0, "set": {"price": 6.43}, "atr": 0.3}]}})
    assert a["trades"][0]["fees"] == 0 and a["fills"][0]["fees_in"] is True
    assert b["trades"][0]["fees"] == 0 and b["trades"][0]["entry_price"] == 6.43       # edited: still no fees added
    assert a["summary"]["unrealized"] == pytest.approx(-3_111.38, abs=0.5)
    plain, = run_js({"op": "real", "args": {"cfg": cfg, "events": [], "steps": [{**buy, "fees_in": False}]}})
    assert plain["trades"][0]["fees"] == pytest.approx(config.order_fee(6.43298 * 12_299, cfg))


def test_thndr_fees_match_on_the_site_and_the_mac():
    from app import views
    thndr = {**config.DEFAULTS, "broker": "thndr"}
    assert config.order_fee(1_000, thndr) == pytest.approx(4.75)            # Thndr's own example: EGP 3 + 1.75
    assert config.order_fee(1_000, {**thndr, "broker": "thndr_trader"}) == pytest.approx(1.75)
    cfg = {k: thndr[k] for k in views.CALC_KEYS}
    plan, = run_js({"op": "plan", "args": dict(symbol="BBB", sector="Banks", entry=20.0, stop=18.6, equity=100_000.0,
                                               cash=60_000.0, avgValue=5e6, positions=[], cfg=cfg, riskOff=False)})
    assert plan["buy_fee"] == pytest.approx(config.order_fee(plan["amount"], cfg))

def _history_db(path: Path, apply_bonus: bool):
    conn = db.connect(path)
    conn.execute("INSERT INTO stocks(symbol, name_ar, sector_ar) VALUES ('AAA', 'أ', 'بنوك'), ('BBB', 'ب', 'عقاري')")
    for sym, base in (("AAA", 10.0), ("BBB", 20.0), (prices_mod.INDEX_SYMBOL, 1000.0)):
        df = make_ohlcv(np.linspace(base, base * 1.3, 120), volume=2e6).rename_axis("date").reset_index()
        df["date"] = df["date"].dt.strftime("%Y-%m-%d")
        db.upsert_prices(conn, sym, df)
    days = [r[0] for r in conn.execute("SELECT date FROM prices WHERE symbol='AAA' ORDER BY date")]
    c = dict(config.DEFAULTS)
    a = portfolio.add_real_buy(conn, c, "AAA", days[20], 10.6, 100, 0.3)
    b = portfolio.add_real_buy(conn, c, "BBB", days[30], 21.2, 50, 0.5)
    portfolio.sell_real(conn, c, a, days[60], 11.4, 100, "Target reached")
    corporate.add_dividend(conn, b, days[70], 25.0)
    # BBB gives 1 free share for every 4 on days[80]: its stored history is re-based
    conn.execute("UPDATE prices SET open=open/1.25, high=high/1.25, low=low/1.25, close=close/1.25 WHERE symbol='BBB'")
    db.add_price_event(conn, "BBB", days[80], 1.25)
    if apply_bonus:
        event = conn.execute("SELECT id FROM price_events").fetchone()[0]
        corporate.apply(conn, b, event, 62)
    conn.commit()
    return conn, c, days


@needs_node
@pytest.mark.parametrize("apply_bonus", [True, False])
def test_portfolio_health_and_journal_add_up_to_my_portfolio(tmp_path, apply_bonus):
    from app import views
    conn, c, days = _history_db(tmp_path / "egx.db", apply_bonus)
    d = views.Data(conn, c, views.Cache())
    h = views.portfolio_history(d)
    page = views.portfolio_view(d)
    curve, j = run_js({"op": "equity", "args": h}, {"op": "journal", "args": {"closed": page["closed"], "history": h}})
    assert curve["time"][0] == days[20] and len(curve["time"]) == 100
    assert curve["value"][-1] == pytest.approx(page["summary"]["equity"], rel=1e-9)   # the same as My Portfolio
    before, after = curve["time"].index(days[79]), curve["time"].index(days[80])
    assert curve["value"][after] / curve["value"][before] == pytest.approx(1, abs=0.01)   # no jump on the ex-date
    assert curve["index"][0] == pytest.approx(c["capital"])
    assert j["n"] == 1 and j["pnl"] == pytest.approx(page["closed"][0]["pnl"]) and j["win_rate"] == 1
    assert j["trades"][0]["source"] == "Your own idea" and not j["has_inflation"]


@needs_node
def test_journal_finds_the_signal_and_what_inflation_took():
    closed = [{"id": 1, "symbol": "AAA", "entry_date": "2026-03-10", "exit_date": "2026-04-09", "entry_price": 10.0,
               "shares": 100, "pnl": 50.0, "return_pct": 0.05, "exit_reason": "Target reached (2R)"},
              {"id": 2, "symbol": "BBB", "entry_date": "2026-03-01", "exit_date": "2026-03-15", "entry_price": 20.0,
               "shares": 50, "pnl": -40.0, "return_pct": -0.04, "exit_reason": "Stop-loss"}]
    history = {"buys": [{"date": "2026-03-08", "symbol": "AAA", "setup": "Breakout"},
                        {"date": "2026-01-02", "symbol": "BBB", "setup": "Pullback"}],        # too long before
               "inflation": [{"date": "2026-01-31", "value": 12.0}, {"date": "2026-02-28", "value": 13.0}]}
    j, = run_js({"op": "journal", "args": {"closed": closed, "history": history}})
    aaa = next(t for t in j["trades"] if t["symbol"] == "AAA")
    assert aaa["source"] == "Breakout" and aaa["days"] == 30
    assert aaa["inflation"] == pytest.approx(1.13 ** (30 / 365.25) - 1)
    assert aaa["real_pnl"] == pytest.approx(50 - 1000 * aaa["inflation"])
    assert next(t for t in j["trades"] if t["symbol"] == "BBB")["source"] == "Your own idea"
    assert j["win_rate"] == 0.5 and j["profit_factor"] == pytest.approx(50 / 40)
    assert {g["label"] for g in j["by_exit"]} == {"Target reached", "Stop-loss"}
    assert [g["label"] for g in j["by_month"]] == ["2026-04", "2026-03"]


def test_market_movers_leave_out_splits_the_prices_dont_show_yet(tmp_path, cfg):
    from app import views
    conn = db.connect(_site_db(tmp_path / "egx.db"))
    last = conn.execute("SELECT MAX(date) FROM prices").fetchone()[0]
    conn.execute("UPDATE prices SET close = close / 4 WHERE symbol='BBB' AND date=?", (last,))   # a 1:4 split
    conn.commit()
    m = views.movers(views.Data(conn, cfg, views.Cache()))
    week = m["movers"]["ret5"]
    assert [r["symbol"] for r in week["up"]] == ["AAA"] and [r["symbol"] for r in week["down"]] == ["AAA"]
    money = m["sector_money"]                    # where the money went: shares of the last session, biggest first
    assert money and sum(r["share"] for r in money) == pytest.approx(1)
    assert [r["value"] for r in money] == sorted((r["value"] for r in money), reverse=True)
    assert 0 < sum(r["usual"] for r in money) <= 1 + 1e-9


def test_friends_set_alerts_in_telegram_and_get_them_after_a_close(tmp_path, monkeypatch):
    from app import alerts
    conn = db.connect(_site_db(tmp_path / "egx.db"))
    bot = FakeBot()
    monkeypatch.setattr(alerts, "call", bot.call)
    monkeypatch.setattr(alerts, "send", bot.send)
    code = static_site.telegram_code(PASSWORD, "me/egx")
    last = conn.execute("SELECT MAX(date) FROM prices").fetchone()[0]
    close = conn.execute("SELECT close FROM prices WHERE symbol='BBB' AND date=?", (last,)).fetchone()[0]
    for text in (f"/start {code}", "/watch aaa", "/watch BBB 1000", "/watch BBB 1", "/watch ZZZ", "/list", "hello"):
        bot.says(111, text)
    bot.says(222, "/watch AAA")                                   # not connected: not listened to
    subs = alerts.sync_subscribers(conn, "123:abc", code)
    assert subs["connected"] == 1 and subs["commands"] == 5
    replies = [t for c, t in bot.sent if c == "111"][1:]           # after the welcome
    assert replies[0] == "OK: I'll tell you when AAA gets a BUY signal, after any close."
    assert replies[1].startswith("OK: I'll tell you when BBB closes above 1,000") and "last close" in replies[1]
    assert replies[2].startswith("OK: I'll tell you when BBB closes below 1.000")
    assert replies[3].startswith("I don't know ZZZ") and "a close above" in replies[4]
    assert not any(c == "222" for c, _ in bot.sent)

    bot.sent.clear()
    assert alerts.fire_watch_alerts(conn, "123:abc", last) == 1     # AAA is a BUY at this close
    assert "AAA</b> · BUY signal" in bot.sent[0][1]
    assert alerts.fire_watch_alerts(conn, "123:abc", last) == 0     # once per close
    conn.execute("UPDATE prices SET close=0.5 WHERE symbol='BBB' AND date=?", (last,))
    assert alerts.fire_watch_alerts(conn, "123:abc", last) == 1     # BBB closed below 1: sent, and done
    assert [r[0] for r in conn.execute("SELECT kind FROM watch_alerts WHERE symbol='BBB'")] == ["above"]
    assert close < 1000

    bot.says(111, "/unwatch bbb")
    bot.says(111, "/stop")
    alerts.sync_subscribers(conn, "123:abc", code)
    assert conn.execute("SELECT COUNT(*) FROM watch_alerts").fetchone()[0] == 0       # /stop forgets them all


def test_the_mac_watchlist_goes_to_the_site_with_the_portfolio_backup(tmp_path, cfg):
    conn = db.connect(_site_db(tmp_path / "egx.db"))
    db.set_user_meta(conn, "watchlist", json.dumps(["AAA", "BBB"]))
    assert static_site.portfolio_backup(conn, cfg)["book"]["watchlist"] == ["AAA", "BBB"]


def test_live_prices_come_only_from_tradingview_boxes():
    """The live charts and prices are TradingView iframes: the page allows frames from TradingView and nothing else,
    still runs no outside script, and the browser maps Kashif codes to TradingView's the same way the scan does."""
    import re as _re

    from app import server
    from egx_agent.data import prices as _prices
    for csp in (static_site._csp(static_site.index_html()), server._csp()):
        frames = _re.search(r"frame-src ([^;]+);", csp).group(1).split()
        assert frames == ["https://s.tradingview.com", "https://www.tradingview-widget.com"]
        assert _re.search(r"script-src 'self'( 'sha256-[^']+')*;", csp)
    ui = (static_site.STATIC / "js" / "ui.js").read_text(encoding="utf-8")
    js = dict(_re.findall(r"(\w+): '(\w+)'", _re.search(r"export const TV_ALIASES = \{([^}]*)\}", ui).group(1)))
    assert js == _prices.TV_ALIASES


def test_arabic_translations_keep_their_placeholders():
    """Every Arabic entry fills in the same {names} as its English key, keys aren't repeated, and every market term
    has both languages: a missing {date} would show an empty gap, an extra one a raw "{date}"."""
    import json
    import re
    src = (ROOT / "app" / "static" / "js" / "i18n.js").read_text(encoding="utf-8")
    body = src[src.index("export const AR = {"):]
    pairs = re.findall(r'^  ("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*"),$', body, re.M)
    assert len(pairs) > 400
    keys = [json.loads(k) for k, _ in pairs]
    assert len(keys) == len(set(keys))
    for k, v in pairs:
        en, ar = json.loads(k), json.loads(v)
        assert ar.strip() and sorted(re.findall(r"\{(\w+)\}", en)) == sorted(re.findall(r"\{(\w+)\}", ar)), en
    terms = re.findall(r"^  (\w+): \{\n    en: \[(.*)\],\n    ar: \[(.*)\],", src, re.M)
    assert len(terms) >= 15 and all(en and ar for _, en, ar in terms)


def test_nothing_hides_the_translator():
    """A local variable named t in a file that translates with t() makes that call crash the page (a DayBar did)."""
    import re
    clash = re.compile(r"(?:\b(?:const|let|var)\s+t\s*=|\(\s*t\s*\)\s*=>|[(,]\s*t\s*=>|\bt\s*=>|\(\s*t\s*,|:\s*t\s*[=,}])")
    for f in (ROOT / "app" / "static" / "js").rglob("*.js"):
        src = f.read_text(encoding="utf-8")
        if "vendor" in f.parts or not re.search(r"import \{[^}]*\bt\b(?!\s+as)[^}]*\} from '\.{1,2}/(?:\.\./)?i18n\.js'", src):
            continue
        bad = [m.group(0) for m in clash.finditer(src)]
        assert not bad, f"{f.name}: {bad}"


def test_the_page_may_send_only_to_the_bots_worker():
    assert "connect-src 'self';" in static_site.index_html()
    page = static_site.index_html("https://egx-bot.x.workers.dev/")
    assert "connect-src 'self' https://egx-bot.x.workers.dev;" in page
    assert "connect-src 'self';" in static_site.index_html("http://evil.example")      # https only


def test_each_code_version_is_published_under_its_own_address(tmp_path):
    ver = static_site.code_version()
    page = static_site.index_html(None, ver)
    assert f'"./static/{ver}/js/main.js"' in page and f'"./static/{ver}/vendor/preact.module.js"' in page


def test_every_reason_the_model_gives_has_arabic():
    """i18n.js WHY_AR translates the model's reasons (predict.WHY_TEXT) by their label: a new one needs Arabic too."""
    import re
    from egx_agent import predict
    src = (ROOT / "app" / "static" / "js" / "i18n.js").read_text(encoding="utf-8")
    body = src[src.index("export const WHY_AR = {"):src.index("const WHY_LABELS")]
    labels = {a or b for a, b in re.findall(r"""(?:'([^']+)'|"([^"]+)"): '""", body)}
    assert {label for label, _ in predict.WHY_TEXT.values()} <= labels


@needs_node
def test_your_stop_counts_from_the_day_you_set_it():
    """A stop you set (my_stop) is only ever higher, and a dip under it before the day you set it doesn't sell."""
    bar = lambda d, low, close: {"date": d, "open": close, "high": close + 0.1, "low": low, "close": close,  # noqa: E731
                                 "atr14": 0.5, "ema20": 9.0, "ema50": 8.0, "sup": None, "div": 0}
    bars = [bar("2026-01-04", 9.9, 10.0), bar("2026-01-05", 9.4, 9.8), bar("2026-01-06", 9.7, 10.0),
            bar("2026-01-07", 9.8, 10.1)]
    trade = {"symbol": "X", "entry_date": "2026-01-04", "entry_price": 10.0, "shares": 100, "initial_stop": 9.0,
             "stop": 9.0, "target": 13.0, "highest_close": 10.0, "my_stop": 9.5}
    case = lambda since: {"op": "realStatus", "args": {"trade": {**trade, "my_stop_from": since}, "bars": bars,  # noqa: E731
                                                       "cfg": config.DEFAULTS}}
    after_dip, on_dip, after_close = run_js(case("2026-01-06"), case("2026-01-05"), case("2026-01-08"))
    assert after_dip["status"] == "HOLD" and after_dip["stop"] == 9.5
    assert on_dip["status"] == "EXIT" and "2026-01-05" in on_dip["reason"]
    assert after_close["status"] == "HOLD" and after_close["stop"] == 9.5     # no "raise your stop" for your own stop


@needs_node
def test_your_stop_starts_at_the_next_session():
    """A stop set during a session counts from the next one (today's open came before it), before the open from today."""
    times = ["2026-10-04T06:30:00Z", "2026-10-04T09:00:00Z", "2026-10-08T14:00:00Z", "2026-10-09T09:00:00Z"]
    (got,) = run_js({"op": "stopFrom", "args": {"times": times}})   # Cairo: Sun 09:30, Sun 12:00, Thu 17:00, Fri
    assert got == ["2026-10-04", "2026-10-05", "2026-10-11", "2026-10-11"]


@needs_node
def test_stops_that_move_only_when_you_change_them(cfg):
    """stop_moves "mine": no rise to support nor after a 1× gain, in the browser and in Python alike."""
    ind, cases, expected = market(), [], []
    c = {**cfg, "stop_moves": "mine"}
    for sym, frame in ind.items():
        for i in (70, 150, 230):
            day, price = frame.index[i], float(frame.close.iloc[i])
            stop = float(strategy.initial_stop(price, frame.atr14.iloc[i], c))
            row = pd.Series({"symbol": sym, "entry_date": str(day.date()), "entry_price": price, "shares": 100,
                             "initial_stop": stop, "stop": stop, "target": price + 2 * (price - stop), "sector": "A"})
            expected.append(portfolio.real_status(row, frame, c))
            cases.append({"op": "realStatus", "args": {"trade": row.to_dict(), "bars": bars_of(frame), "cfg": c}})
            assert expected[-1]["stop"] == stop and expected[-1]["status"] != "TIGHTEN STOP"
    for py, js in zip(expected, run_js(*cases)):
        assert_same(py, js, ("status", "reason", "stop", "days_held", "event_date", "prev_stop", "last_close"))
    auto = [portfolio.real_status(pd.Series(x["args"]["trade"]), ind[x["args"]["trade"]["symbol"]], cfg) for x in cases]
    assert any(a["stop"] > e["stop"] for a, e in zip(auto, expected))      # the same trades' stops rise by themselves


@needs_node
@needs_node
def test_thndr_trader_gives_50_orders_a_plan_month_without_commission_and_renews_from_the_wallet():
    """The plan month starts on the day you subscribed (the 31st: a shorter month's last day); the first 50 buys and
    sales in it have no commission, the 51st has; renewals after you added the plan here come out of the wallet; and
    the Mac's fee rule is the same."""
    plan = {"since": "2026-03-25", "kind": "monthly", "price": 245, "added": "2026-10-08"}
    trade = {"id": 1, "account": "real", "status": "open", "symbol": "X"}
    fills = [{"id": 10 + i, "trade_id": 1, "symbol": "X", "date": "2026-09-25" if i < 30 else "2026-10-07",
              "side": "buy" if i % 2 else "sell", "shares": 1, "price": 10} for i in range(50)]
    book = {"next_id": 99, "trades": [trade], "fills": fills, "dividends": [], "adjustments": [], "cash": []}
    cfg = {**config.DEFAULTS, "broker": "thndr_trader"}
    days = ["2026-03-24", "2026-09-24", "2026-10-08", "2026-10-25"]
    js, short = run_js({"op": "thndrPlan", "args": {"plan": plan, "book": book, "days": days, "today": "2026-12-01",
                                                   "cfg": cfg, "value": 10_000}},
                       {"op": "thndrPlan", "args": {"plan": {**plan, "since": "2026-01-31", "paid_to": "2026-09-30"},
                                                   "book": book, "days": ["2026-02-28", "2026-03-01"],
                                                   "today": "2026-12-01", "cfg": cfg, "value": 10_000}})
    assert js["months"] == [None, ["2026-08-25", "2026-09-25"], ["2026-09-25", "2026-10-25"], ["2026-10-25", "2026-11-25"]]
    assert js["free"] == [False, True, False, True]           # before subscribing; 0 used; all 50 used; a new month
    assert js["due"] == ["2026-10-25", "2026-11-25"] and js["next"] == "2026-12-25"
    assert short["months"] == [["2026-02-28", "2026-03-31"], ["2026-02-28", "2026-03-31"]]
    assert short["due"] == ["2026-10-31", "2026-11-30"]
    free, paid, unknown = js["fees"]
    assert paid - free == pytest.approx(2 + 10)               # Thndr's commission: EGP 2 + 0.1%
    assert unknown == free                                    # no plan saved: every order free, as before
    for flag, fee in ((True, free), (False, paid), (None, unknown)):
        assert config.order_fee(10_000, {**cfg, **({} if flag is None else {"free_trade": flag})}) == pytest.approx(fee)


def test_wallet_counts_top_ups_withdrawals_fees_and_sales_still_settling():
    """Top-ups and withdrawals are money in and out, not profit; fees and money back are; a sale's money can't be
    withdrawn for 2 sessions; and on the account's chart taking money out isn't a fall."""
    sale = {"id": 1, "account": "real", "status": "closed", "symbol": "X", "entry_date": "2026-10-01",
            "entry_price": 10, "exit_date": "2026-10-06", "exit_price": 12, "shares": 100, "fees": 0}
    fills = [{"id": 2, "trade_id": 1, "symbol": "X", "date": "2026-10-01", "side": "buy", "shares": 100, "price": 10},
             {"id": 3, "trade_id": 1, "symbol": "X", "date": "2026-10-06", "side": "sell", "shares": 100, "price": 12}]
    cash = [{"id": 4, "date": "2026-10-07", "kind": "deposit", "amount": 1000, "fee": 10},
            {"id": 5, "date": "2026-10-07", "kind": "withdraw", "amount": 500, "fee": 2.5},
            {"id": 6, "date": "2026-10-07", "kind": "fee", "amount": 9.59},
            {"id": 7, "date": "2026-10-07", "kind": "refund", "amount": 20.06}]
    book = {"next_id": 8, "trades": [sale], "fills": fills, "dividends": [], "adjustments": [], "cash": cash}
    days = ["a", "b", "c"]
    curve = {"start": 1000, "fills": [{"date": "a", "symbol": "X", "side": "buy", "shares": 100, "price": 10}],
             "moves": [{"date": "b", "cash": 1000, "flow": 1000}, {"date": "c", "cash": -500, "flow": -500}],
             "series": {"X": {"time": days, "close": [10, 10, 10]}}, "index": {"time": days, "close": [100, 100, 110]}}
    early = {**book, "cash": [*cash, {"id": 8, "date": "2026-10-07", "kind": "settle", "amount": 700, "fee": 5}]}
    w, c, e = run_js({"op": "wallet", "args": {"book": book, "cfg": {"capital": 10_000}, "today": ["2026-10-07", "2026-10-08"]}},
                     {"op": "equity", "args": curve},
                     {"op": "wallet", "args": {"book": early, "cfg": {"capital": 10_000}, "today": ["2026-10-07", "2026-10-08"]}})
    s = w["summary"]
    assert s["added"] == 500 and s["start"] == 10_500                       # what you put in, net
    assert s["cash"] == pytest.approx(10_000 + 200 + 990 - 502.5 - 9.59 + 20.06)
    assert w["unsettled"] == [1200, 0]                     # sold Tuesday: settles Thursday
    assert e["unsettled"] == [500, 0] and e["summary"]["cash"] == pytest.approx(s["cash"] - 5)   # Settle now: 700 for 5
    assert c["value"] == [1000, 2000, 1500] and c["max_drawdown"] == 0 and c["ret"] == 0
    assert c["index_ret"] == pytest.approx((20 - 500 / 110) * 110 / 1500 - 1)  # what you put in bought EGX30 too
