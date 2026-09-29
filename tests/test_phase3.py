"""Phase 3 (2026-09): the stocks Kashif misses, dividends in the exit rules, the model ordering and adding BUYs, and
the weekly summary."""
from datetime import date

import numpy as np
import pandas as pd
import pytest

from app import alerts, health, views
from egx_agent import backtest, config, db, engine, portfolio, predict, scan, strategy
from egx_agent.data import dividends, shariah, universe
from tests.conftest import make_ohlcv
from tests.test_static_site import FakeBot, _site_db, assert_same, bars_of, market, needs_node, run_js

SESSIONS = dict(freq="C", weekmask="Sun Mon Tue Wed Thu")


# ------------------------------------------------------------------ stocks Kashif doesn't list

def _tv_rows(extra=()):
    return [{"symbol": f"K{i:03d}", "name": f"K{i}", "sector": "Finance", "industry": "Regional Banks", "value": 5e6}
            for i in range(120)] + list(extra)


def test_liquid_stocks_kashif_misses_come_from_tradingview_and_stay(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "egx.db")
    for i in range(120):
        conn.execute("INSERT INTO stocks(symbol, name_ar, sector_ar) VALUES (?,?,?)", (f"K{i:03d}", "ك", "بنوك"))
    rows = _tv_rows([
        {"symbol": "HDBK", "name": "Housing & Development Bank", "sector": "Finance", "industry": "Regional Banks",
         "value": 5e7},
        {"symbol": "GRCA", "name": "Grand Investment Capital", "sector": "Finance",
         "industry": "Investment Banks/Brokers", "value": 4e7},
        {"symbol": "TINY", "name": "Tiny Co", "sector": "Other", "industry": "Other", "value": 2e5},       # too small
        {"symbol": "AIH", "name": "Arabia Investments", "sector": "Finance", "industry": "x", "value": 1e8},  # = AIHC
    ])
    assert universe.needs_tv_refresh(conn)
    assert universe.refresh_tradingview(conn, rows) == {"added": 2, "removed": 0, "from_tradingview": 2}
    assert not universe.needs_tv_refresh(conn)
    table = universe.stock_table(conn)
    assert table.loc["HDBK", "sector"] == "Banks" and table.loc["GRCA", "sector"] == "Non-bank Financials"
    assert table.loc["HDBK", "kashif_status"] is None
    assert not shariah.passes_filter(table.loc["HDBK"].to_dict(), "kashif")    # no Shariah status: filtered out
    with pytest.raises(RuntimeError):                                          # a broken list changes nothing
        universe.refresh_tradingview(conn, rows[:10])

    def kashif(session, params, delay):       # Kashif now lists only K000–K059
        if params.get("shariahStatus") != "Halal":
            return []
        return [{"symbol": f"K{i:03d}", "name_ar": "ك", "sector_ar": "بنوك", "kashif_label": "", "purity": None,
                 "purification_pct": None, "statements_date": None} for i in range(60)]
    monkeypatch.setattr(shariah, "_fetch_all_pages", kashif)
    shariah.refresh_kashif(conn, delay=0)
    left = {r[0] for r in conn.execute("SELECT symbol FROM stocks")}
    assert {"HDBK", "GRCA"} <= left and "K100" not in left and "K010" in left
    # a stock that leaves TradingView's list goes
    assert universe.refresh_tradingview(conn, _tv_rows())["removed"] == 2


# ------------------------------------------------------------------ dividends

def test_dividends_are_the_steps_between_the_two_charts():
    idx = pd.bdate_range("2024-01-07", periods=10, **SESSIONS)
    raw = pd.Series([10, 10.2, 10.1, 9.6, 9.7, 9.8, 9.9, 10, 10.1, 10.2], index=idx, dtype=float)
    adj = raw.copy()
    adj.iloc[:3] *= 1 - 0.5 / 10.1            # a 0.50 dividend, ex on the 4th session
    assert dividends.steps(raw, adj) == [(str(idx[3].date()), round(0.5 / 10.1, 6))]
    noisy = adj * (1 + np.r_[0, 1e-5, 0, 0, 0, 0, 0, 0, 0, 0])      # rounding isn't a dividend
    assert len(dividends.steps(raw, noisy)) == 1
    wrong = raw.copy()
    wrong.iloc[:3] *= 0.5                    # a "50% dividend" is a re-basing TradingView got wrong
    assert dividends.steps(raw, wrong) == []


def test_the_dividend_history_is_read_a_few_stocks_a_run(tmp_path):
    conn = db.connect(tmp_path / "egx.db")
    for s in ("AAA", "BBB", "CCC"):
        conn.execute("INSERT INTO stocks(symbol) VALUES (?)", (s,))
        conn.execute("INSERT INTO prices(symbol, date, close) VALUES (?, '2024-01-07', 10)", (s,))
    calls = []

    def fetch(sym):
        calls.append(sym)
        return None if sym == "CCC" else [("2024-01-10", 0.05), ("2025-01-12", 0.04)]
    assert dividends.update_history(conn, 60, fetch) == {"stocks": 2, "dividends": 4, "failed": 1, "left": 1}
    assert dividends.update_history(conn, 60, fetch)["stocks"] == 0 and calls == ["AAA", "BBB", "CCC", "CCC"]
    assert conn.execute("SELECT COUNT(*) FROM dividend_history").fetchone()[0] == 4


def test_the_dividend_per_share_in_todays_prices(tmp_path):
    conn = db.connect(tmp_path / "egx.db")
    days = pd.bdate_range("2024-01-07", periods=5, **SESSIONS)
    closes = pd.Series([10.0, 10.2, 9.7, 9.8, 9.9], index=days)
    d = [str(x.date()) for x in days]
    conn.execute("INSERT INTO dividend_history VALUES ('AAA', ?, 0.05)", (d[2],))
    conn.execute("INSERT INTO cash_dividends(symbol, ex_date, amount) VALUES ('AAA', ?, 0.3)", (d[4],))
    per = dividends.per_share(conn, "AAA", closes)
    assert per[days[2]] == pytest.approx(0.05 * 10.2) and per[days[4]] == 0.3 and per.sum() == pytest.approx(0.81)
    # bonus shares re-based the prices after TradingView's announced amount: only the history's yield is right then
    conn.execute("INSERT INTO price_events(symbol, ex_date, factor, detected) VALUES ('AAA', '2099-01-01', 2, 'x')")
    assert dividends.per_share(conn, "AAA", closes)[days[4]] == 0
    # the next one, under the agent's own name for the company
    conn.execute("INSERT INTO cash_dividends(symbol, ex_date, amount) VALUES ('AIH', '2099-02-01', 0.1)")
    assert dividends.coming(conn, "2099-01-15") == {"AIHC": {"ex_date": "2099-02-01", "amount": 0.1}}


def _pos():
    return engine.Position("S", "2024-01-07", 10.0, 100, 9.0, 9.0, 12.0, 10.0)


def _bar(day, o, h, l, c, div=0.0):
    return pd.Series({"open": o, "high": h, "low": l, "close": c, "atr14": 0.2, "ema50": 8.0, "div": div},
                     name=pd.Timestamp(day))


def test_the_stop_and_target_move_down_by_the_dividend(cfg):
    pos = _pos()
    assert engine.process_bar(pos, _bar("2024-01-07", 10, 10.3, 9.95, 10.2, div=0.5), cfg) is None
    assert pos.stop == 9.0 and pos.target == 12.0          # bought that morning, ex already: not ours
    ex = _bar("2024-01-08", 9.6, 9.8, 8.8, 9.7, div=0.5)   # opens lower by the dividend; the old stop would sell
    assert engine.process_bar(pos, ex, cfg) is None
    assert pos.stop == 8.5 and pos.target == 11.5
    plain = _pos()
    engine.process_bar(plain, _bar("2024-01-07", 10, 10.3, 9.95, 10.2), cfg)
    assert engine.process_bar(plain, _bar("2024-01-08", 9.6, 9.8, 8.8, 9.7), cfg) == (9.0, "Stop-loss")


@needs_node
def test_the_browser_moves_the_stop_for_dividends_too(cfg):
    ind = market()
    cases, expected, moved = [], [], 0
    for sym, frame in ind.items():
        frame = frame.copy()
        frame["div"] = 0.0
        for i in (73, 153, 233, 303):
            frame.iloc[i, frame.columns.get_loc("div")] = 0.03 * float(frame.close.iloc[i - 1])
        for i in (70, 150, 230, 300):
            day, price = frame.index[i], float(frame.close.iloc[i])
            stop = float(strategy.initial_stop(price, frame.atr14.iloc[i], cfg))
            row = pd.Series({"symbol": sym, "entry_date": str(day.date()), "entry_price": price, "shares": 100,
                             "initial_stop": stop, "stop": stop, "target": price + 2 * (price - stop), "sector": "A"})
            with_div = portfolio.real_status(row, frame, cfg)
            without = portfolio.real_status(row, frame.drop(columns="div"), cfg)
            moved += with_div != without
            expected.append(with_div)
            cases.append({"op": "realStatus", "args": {"trade": row.to_dict(), "bars": bars_of(frame), "cfg": cfg}})
    assert moved >= 3                     # the dividends changed what the rules say
    for py, js in zip(expected, run_js(*cases)):
        assert_same(py, js, ("status", "reason", "stop", "days_held", "event_date", "prev_stop", "last_close"))


def _one_stock(tmp_path, n=120):
    conn = db.connect(tmp_path / "egx.db")
    df = make_ohlcv(np.linspace(20, 23, n), start="2024-01-07", spread=0.004, volume=3e6)
    conn.execute("INSERT INTO stocks(symbol, name_ar, sector_ar) VALUES ('AAA', 'أ', 'بنوك')")
    return conn, df


def test_the_backtest_pays_the_dividend(tmp_path, cfg):
    conn, df = _one_stock(tmp_path)
    conn.execute("INSERT INTO dividend_history VALUES ('AAA', ?, 0.02)", (str(df.index[100].date()),))
    stocks = pd.DataFrame({"symbol": ["AAA"], "sector": ["Banks"]}).set_index("symbol", drop=False)
    runs = {}
    for name, c in (("paid", conn), ("not", None)):
        prep = backtest.prepare({"AAA": df}, df, stocks, cfg, c)
        buy = prep.buy & False
        buy.loc[df.index[97], "AAA"] = True
        runs[name] = backtest.run(prep, cfg, df.index[90], df.index[104], buy=buy)
    got = runs["paid"]["equity"].iloc[-1] - runs["not"]["equity"].iloc[-1]
    shares = runs["paid"]["open_at_end"]["shares"].iloc[0]
    assert got == pytest.approx(shares * 0.02 * float(df["close"].iloc[99]))


def test_paper_trades_are_paid_the_dividend(tmp_path, cfg):
    conn, df = _one_stock(tmp_path)
    frames = {"AAA": scan.add_indicators(df)}
    frames["AAA"]["div"] = 0.0
    ex = df.index[100]
    frames["AAA"].loc[ex, "div"] = 0.4
    close = float(df["close"].iloc[97])
    portfolio.create_paper_orders(conn, [{"symbol": "AAA", "shares": 100, "stop": close * 0.9, "target": close * 1.2,
                                          "entry_limit": close * 1.02}], str(df.index[97].date()))
    portfolio.process_paper(conn, cfg, frames, df.index[104])
    paid = conn.execute("SELECT date, shares, amount, note FROM dividends").fetchall()
    assert [tuple(r) for r in paid] == [(str(ex.date()), 100, pytest.approx(40.0), "paid automatically")]
    t = portfolio.trades_df(conn, "paper", ("open",)).iloc[0]
    assert t["target"] == pytest.approx(close * 1.2 - 0.4)          # saved lowered, for the next run
    assert portfolio.account_summary(conn, "paper", cfg, {})["dividends"] == pytest.approx(40.0)


def test_a_holder_is_told_to_lower_the_stop_the_evening_before(tmp_path, cfg):
    conn = db.connect(_site_db(tmp_path / "egx.db"))
    session = views.sessions_after(db.get_meta(conn, "scan_data_date"), 1)
    conn.execute("INSERT INTO cash_dividends(symbol, ex_date, amount) VALUES ('AAA', ?, 0.5)", (session,))
    conn.commit()
    d = views.Data(conn, cfg, views.Cache())
    pos = next(p for p in views.open_positions(d) if p["symbol"] == "AAA")
    item = next(it for it in views.orders(d)["items"] if it["key"] == "exdiv:AAA")
    assert item["kind"] == "stop" and item["to"] == pytest.approx(pos["stop"] - 0.5)
    assert "ex-dividend" in item["detail"] and "0.5 EGP" in item["detail"]
    caution = views.cautions_map(d)["AAA"][0]
    assert caution["kind"] == "ex_dividend" and caution["level"] == "info"


# ------------------------------------------------------------------ the model orders the BUYs and adds its own

@pytest.fixture
def scan_with_model(tmp_path, monkeypatch):
    conn = db.connect(_site_db(tmp_path / "egx.db"))
    day = db.get_meta(conn, "scan_data_date")
    state = {"health": "ok",
             "ranks": {"BBB": {"rank": 1, "of": 2, "pct": 1.0}, "AAA": {"rank": 2, "of": 2, "pct": 0.5}}}
    monkeypatch.setattr(shariah, "needs_refresh", lambda conn: False)
    monkeypatch.setattr(predict, "resolve", lambda conn, cfg: 0)
    monkeypatch.setattr(predict, "predict_latest", lambda conn, cfg: db.set_meta(conn, "prediction_date", day) or 2)
    monkeypatch.setattr(predict, "ranks_for", lambda conn, d: state["ranks"])
    monkeypatch.setattr(predict, "health", lambda conn, meta=None: {"status": state["health"]})
    return conn, state


def _rows(conn, action="BUY"):
    _, df = views.current_scan(conn)
    if df.empty:
        return df
    return df[df["action"] == action] if action else df


def test_the_models_best_picks_become_buys_in_its_order(scan_with_model):
    conn, state = scan_with_model
    cfg = {**config.DEFAULTS, "setups": []}                # no rule setups: only the model's picks can be BUYs
    market_ = scan.run_scan(conn, cfg, update_data=False)
    buys = _rows(conn)
    assert market_["model_picks"] == 2 and market_["model_health"] == "ok"
    assert list(buys.sort_values("priority", ascending=False)["symbol"]) == ["BBB", "AAA"]
    assert set(buys["source"]) == {"model"} and set(buys["setup"]) == {"Model pick"}
    assert "#1 of 2" in buys.set_index("symbol").loc["BBB", "reasons"][0]
    _, sig = views.signals(views.Data(conn, cfg, views.Cache()))    # everyone's view: money in the model's order
    assert [r["symbol"] for r in sig if r["action"] == "BUY"] == ["BBB", "AAA"]

    scan.run_scan(conn, {**cfg, "model_picks": 1}, update_data=False)
    assert list(_rows(conn)["symbol"]) == ["BBB"]
    scan.run_scan(conn, {**cfg, "model_picks": 0}, update_data=False)
    assert _rows(conn).empty
    state["health"] = "bad"                                # its live results show no edge: no picks of its own
    assert scan.run_scan(conn, cfg, update_data=False)["model_picks"] == 0 and _rows(conn).empty


def test_no_model_picks_while_egx30_is_under_its_50_day_average(scan_with_model, monkeypatch):
    conn, _ = scan_with_model
    monkeypatch.setattr(strategy, "is_risk_off", lambda row: True)
    scan.run_scan(conn, {**config.DEFAULTS, "setups": []}, update_data=False)
    assert _rows(conn).empty


def test_the_rules_signals_get_the_models_rank(scan_with_model):
    conn, state = scan_with_model
    state["ranks"] = {"AAA": {"rank": 1, "of": 1, "pct": 1.0}}
    scan.run_scan(conn, {**config.DEFAULTS, "model_picks": 0, "buy_score": 0, "watch_score": 0}, update_data=False)
    rows = _rows(conn, None).set_index("symbol")
    assert set(rows["source"]) == {"rules"} and rows.loc["AAA", "priority"] == 1.0
    assert pd.isna(rows.loc["BBB", "priority"]) and "Model pick" not in set(rows["setup"])


def test_the_alarm_when_the_model_stops_working(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "egx.db")
    monkeypatch.setattr(scan, "expected_session_date", lambda now=None: date(2026, 9, 29))
    db.set_meta(conn, "scan_data_date", "2026-09-29")
    monkeypatch.setattr(predict, "load_meta", lambda root: {"trained_at": date.today().isoformat(), "horizons": {}})
    monkeypatch.setattr(predict, "health", lambda conn, meta=None: {"status": "bad", "days": 60, "top": -0.004,
                                                                    "all": 0.001})
    out = health.problems(conn)
    assert list(out) == ["model_edge"] and "no better than the average stock" in out["model_edge"]
    assert "own BUYs again" in health._fixed_text("model_edge")


# ------------------------------------------------------------------ the weekly summary

def test_the_weekly_summary_goes_once_after_thursdays_close():
    thu, fri, sun = date(2026, 10, 1), date(2026, 10, 2), date(2026, 10, 4)
    assert alerts.week_of("2026-10-01") == alerts.week_of("2026-09-27") == "2026-09-27"
    assert alerts.weekly_due("2026-10-01", None, thu)                     # Thursday's close
    assert not alerts.weekly_due("2026-09-30", None, date(2026, 9, 30))   # Wednesday: not yet
    assert alerts.weekly_due("2026-09-30", None, fri)                     # Thursday was a holiday: Friday
    assert not alerts.weekly_due("2026-10-01", "2026-09-27", fri)         # sent already
    assert not alerts.weekly_due("2026-10-01", None, sun)                 # a new week began: too late
    assert not alerts.weekly_due(None, None, thu)


def test_friends_get_the_weekly_summary_unless_they_turn_it_off(tmp_path, monkeypatch, cfg):
    conn = db.connect(_site_db(tmp_path / "egx.db"))
    code = "c0de1234"
    bot = FakeBot()
    monkeypatch.setattr(alerts, "call", bot.call)
    monkeypatch.setattr(alerts, "send", bot.send)
    bot.says(111, f"/start {code}")
    bot.says(222, f"/start {code}", name="Mona")
    bot.says(222, "/weekly off")
    res = alerts.sync_subscribers(conn, "123:abc", code)
    assert res["commands"] == 1 and "no weekly summary" in bot.sent[-1][1]
    text = alerts.build_weekly(views.Data(conn, cfg, views.Cache()), "https://me.github.io/egx/", mine=False)
    assert "the week of" in text and "BUY signals this week" in text and "/weekly off" in text
    assert "MY PRIVATE NOTE" not in text and "Your" not in text               # nobody's own positions on the site
    n = len(bot.sent)
    assert alerts.send_weekly_to_subscribers(conn, "123:abc", text, "2026-09-27") == 1
    assert [c for c, _ in bot.sent[n:]] == ["111"]
    assert alerts.send_weekly_to_subscribers(conn, "123:abc", text, "2026-09-27") == 0     # once a week
    mac = alerts.build_weekly(views.Data(conn, cfg, views.Cache()))
    assert "Your 1 position" in mac and "AAA" in mac
