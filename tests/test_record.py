"""The stop that follows support (engine.py, levels.with_support) and the signals' track record (record.py)."""
import numpy as np
import pandas as pd

from egx_agent import db, engine, levels, record
from egx_agent.indicators import add_indicators
from tests.test_levels import CFG, V_PATH, frame


def _pos():
    return engine.Position(symbol="X", entry_date="2026-01-04", entry_price=10.0, shares=100, initial_stop=9.0,
                           stop=9.0, target=12.0, highest_close=10.0)


def test_the_stop_rises_to_support_and_never_falls(cfg):
    pos = _pos()
    for sup, want in ((9.5, 9.5), (9.2, 9.5), (np.nan, 9.5), (9.7, 9.7)):
        engine.update_after_close(pos, pd.Series({"close": 10.2, "atr14": 0.3, "ema50": 8.0, "sup": sup}), cfg)
        assert pos.stop == want
    off = _pos()
    engine.update_after_close(off, pd.Series({"close": 10.2, "atr14": 0.3, "ema50": 8.0, "sup": 9.8}),
                              {**cfg, "stop_follows_support": False})
    assert off.stop == 9.0


def test_support_stop_is_the_charts_stop_under_support():
    ind = add_indicators(frame(V_PATH))
    out = levels.with_support(ind, CFG, ind.index[-5])
    p = levels.plan_at(ind, CFG)
    assert p["method"] != "atr" and out["sup"].iloc[-1] == p["stop"]
    assert out["sup"].iloc[:-5].isna().all()                        # only from the date asked
    assert "sup" not in levels.with_support(ind, {**CFG, "stop_follows_support": False})


def _bars(opens, highs, lows, closes, start="2026-01-04"):
    idx = pd.bdate_range(start, periods=len(opens), freq="C", weekmask="Sun Mon Tue Wed Thu")
    return pd.DataFrame({"open": opens, "high": highs, "low": lows, "close": closes, "atr14": 0.3, "ema50": 8.0},
                        index=idx)


def test_a_signal_is_followed_from_the_next_open(cfg):
    ind = _bars([10.0, 10.1, 10.4, 11.0], [10.2, 10.5, 11.1, 12.3], [9.9, 10.0, 10.3, 10.9], [10.0, 10.4, 11.0, 12.0])
    order = {"scan_date": str(ind.index[0].date()), "symbol": "X", "entry_limit": 10.3, "stop": 9.4, "target": 12.2,
             "shares": 1}
    res = record.replay(order, ind, cfg)
    fee = cfg["fee_pct_per_side"] / 100
    assert res["status"] == "closed" and res["reason"] == "Target reached" and res["entry"] == 10.1
    assert np.isclose(res["return"], 12.2 * (1 - fee) / (10.1 * (1 + fee)) - 1)
    assert record.replay({**order, "entry_limit": 10.0}, ind, cfg)["status"] == "skipped"    # opened above the limit
    assert record.replay({**order, "scan_date": str(ind.index[-1].date())}, ind, cfg)["status"] == "waiting"


def test_the_record_counts_a_stock_once_while_it_is_open(tmp_path, cfg):
    conn = db.connect(tmp_path / "t.db")
    ind = _bars([10.0, 10.1, 10.2, 10.3], [10.2, 10.3, 10.4, 10.5], [9.9, 10.0, 10.1, 10.2], [10.0, 10.2, 10.3, 10.4])
    for day in ind.index[:2]:
        conn.execute("INSERT INTO scans(scan_date, symbol, action, score, setup, close, entry_high, stop, target, source) "
                     "VALUES (?, 'X', 'BUY', 75, 'Breakout', 10.0, 10.5, 9.0, 13.0, 'rules')", (str(day.date()),))
    conn.commit()
    rec = record.signal_record(conn, cfg, lambda s: ind)
    assert rec["summary"]["signals"] == 1 and rec["summary"]["open"] == 1
    assert rec["health"]["status"] == "early"


def test_health_compares_the_live_record_with_the_test():
    test = {"all": {"win_rate": 0.45, "avg": 0.025}}
    live = {"n": 30, "win_rate": 0.30, "avg": -0.01}
    assert record.health(live, test)["status"] == "cold"
    assert record.health({**live, "avg": 0.004}, test)["status"] == "cold"    # making money, but far fewer winners
    assert record.health({**live, "win_rate": 0.36}, test)["status"] == "ok"  # under 10 points fewer
    assert record.health({**live, "n": 29}, test)["status"] == "early"


def test_odds_are_the_backtests_trades_by_score():
    trades = pd.DataFrame({"score": [72, 75, 85, 95, 88], "return_pct": [0.10, -0.05, 0.02, -0.03, -0.04]})
    odds = record.odds_from_trades(trades)
    assert odds["all"]["n"] == 5 and np.isclose(odds["all"]["win_rate"], 0.4)
    low, mid, high = odds["bands"]
    assert (low["n"], mid["n"], high["n"]) == (2, 2, 1) and high["to"] == 100
    assert np.isclose(low["avg"], 0.025)


def test_telegram_warns_when_the_record_runs_cold(monkeypatch):
    from app import alerts, views
    h = {"status": "cold", "closed": 34, "win_rate": 0.30, "test_win_rate": 0.45}
    monkeypatch.setattr(views, "signal_record", lambda d: {"health": h})
    assert "won 30% against 45% in the tests" in alerts._cold_lines(None)[1]
    assert "ربحت 30% مقابل 45%" in alerts._cold_lines(None, "ar")[1]
    h["status"] = "ok"
    assert alerts._cold_lines(None) == []
