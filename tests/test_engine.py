import pandas as pd

from egx_agent import engine
from tests.conftest import bar


def pos(**kw):
    base = dict(symbol="X", entry_date="2026-01-04", entry_price=100.0, shares=10, initial_stop=90.0, stop=90.0,
                target=120.0, highest_close=100.0)
    base.update(kw)
    return engine.Position(**base)


def test_stop_hit_intraday_fills_at_stop(cfg):
    p = pos()
    assert engine.process_bar(p, bar("2026-01-05", 99, 101, 89, 95), cfg) == (90.0, "Stop-loss")


def test_gap_below_stop_fills_at_open(cfg):
    p = pos()
    price, reason = engine.process_bar(p, bar("2026-01-05", 85, 88, 84, 86), cfg)
    assert price == 85 and "gap down" in reason


def test_target_hit(cfg):
    p = pos()
    assert engine.process_bar(p, bar("2026-01-05", 110, 121, 109, 118), cfg) == (120.0, "Target reached")


def test_breakeven_after_one_r(cfg):
    p = pos()
    assert engine.process_bar(p, bar("2026-01-05", 105, 111, 104, 110, ema50=90, atr14=6), cfg) is None
    assert p.stop == 100.0                    # closed at +1R: stop moves to entry (trail 110 - 12 = 98 is lower)
    price, reason = engine.process_bar(p, bar("2026-01-06", 101, 102, 99, 100, ema50=90, atr14=6), cfg)
    assert price == 100.0 and reason == "Breakeven stop"


def test_trailing_stop_rises(cfg):
    p = pos()
    engine.process_bar(p, bar("2026-01-05", 110, 116, 109, 115, ema50=90, atr14=2), cfg)
    assert p.stop == 111.0                    # 115 - 2×2


def test_trend_break_exits_next_open(cfg):
    p = pos()
    assert engine.process_bar(p, bar("2026-01-05", 99, 100, 95, 96, ema50=97), cfg) is None
    assert p.exit_next_open
    price, reason = engine.process_bar(p, bar("2026-01-06", 95.5, 97, 95, 96), cfg)
    assert price == 95.5 and reason.startswith("Trend break")


def test_time_stop_after_max_hold(cfg):
    p = pos()
    for i in range(cfg["max_hold_days"]):
        assert engine.process_bar(p, bar(pd.Timestamp("2026-01-05") + pd.Timedelta(days=i), 100, 101, 99, 100), cfg) is None
    assert p.days_held == cfg["max_hold_days"] and "Max hold" in p.exit_next_open
    price, reason = engine.process_bar(p, bar("2026-02-10", 100.5, 101, 99, 100), cfg)
    assert price == 100.5 and "Max hold" in reason


def test_fill_order_skips_gaps(cfg):
    order = {"symbol": "X", "shares": 10, "stop": 90, "target": 120, "entry_limit": 102}
    assert engine.fill_order(order, bar("2026-01-05", 105, 106, 104, 105))[0] is None   # gapped above limit
    assert engine.fill_order(order, bar("2026-01-05", 89, 91, 88, 90))[0] is None       # opened below stop
    p, _ = engine.fill_order(order, bar("2026-01-05", 101, 103, 100, 102))
    assert p.entry_price == 101 and p.stop == 90


def test_replay_review_after_two_weeks(cfg):
    dates = pd.bdate_range("2026-01-04", periods=12, freq="C", weekmask="Sun Mon Tue Wed Thu")
    ind = pd.DataFrame({"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "ema50": 95.0, "atr14": 1.0},
                       index=dates)
    st = engine.replay_status(pos(entry_date=str(dates[0].date())), ind, cfg)
    assert st["status"] == "REVIEW" and st["days_held"] == 12
