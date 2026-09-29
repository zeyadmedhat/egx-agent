"""Stop-loss and target from the chart (egx_agent/levels.py)."""
import numpy as np
import pandas as pd

from egx_agent import config, levels, strategy
from egx_agent.indicators import add_indicators
from egx_agent.portfolio import _levels

CFG = {**config.DEFAULTS, "levels_mode": "chart"}


def frame(closes, spread=0.01) -> pd.DataFrame:
    c = np.asarray(closes, dtype=float)
    idx = pd.bdate_range("2024-01-01", periods=len(c))
    return pd.DataFrame({"open": c, "high": c * (1 + spread), "low": c * (1 - spread), "close": c,
                         "volume": 1_000_000.0}, index=idx)


def walk(n=400, seed=1) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    return frame(100 * np.exp(np.cumsum(rng.normal(0.001, 0.02, n))), spread=0.015)


V_PATH = list(np.linspace(80, 120, 120)) + list(np.linspace(120, 100, 30)) + list(np.linspace(100, 110, 30))


def test_stop_sits_under_a_support_that_held():
    # Up to 120, back to a low of 100 (it held), and up again to 110: the low at 99 is the support.
    p = levels.plan_at(add_indicators(frame(V_PATH)), CFG)
    assert p["method"] in ("chart", "mixed")
    assert 99 * 0.97 < p["stop"] < 99, p
    assert any(s.startswith("swing low") for s in p["stop_why"])
    # The levels up to the old top (high 121.2) pay under 1.5× the risk: the target is past them, and the first
    # solid one is shown as a hurdle on the way.
    assert p["target"] - p["close"] >= CFG["target_min_r"] * (p["close"] - p["stop"]) - 1e-9
    assert p["target"] > 121.2 and p["close"] < p["hurdle"]["price"] < p["target"]


def test_stop_and_target_stay_in_bounds():
    ind = add_indicators(walk())
    for pos in range(120, len(ind), 17):
        p = levels.plan_at(ind.iloc[:pos + 1], CFG)
        assert CFG["stop_min_pct"] / 100 - 1e-9 <= p["stop_pct"] <= CFG["stop_max_pct"] / 100 + 1e-9
        risk = p["close"] - p["stop"]
        assert p["target"] > p["close"]
        if p["target_why"]:
            assert CFG["target_min_r"] * risk - 1e-9 <= p["target"] - p["close"] <= CFG["target_max_r"] * risk + 1e-9


def test_no_peeking_at_later_bars():
    ind = add_indicators(walk(seed=7))
    sf = strategy.signal_frame(ind, CFG)
    rows = np.zeros(len(ind), dtype=bool)
    rows[[150, 220, 310]] = True
    out = levels.apply(ind, sf, CFG, rows)
    for i in (150, 220, 310):
        p = levels.plan_at(ind.iloc[:i + 1], CFG)
        assert out["stop"].iloc[i] == p["stop"] and out["target"].iloc[i] == p["target"]
    assert (out["stop"][~rows] == sf["stop"][~rows]).all()          # other rows keep the ATR plan


def test_atr_mode_and_short_history_leave_the_atr_plan():
    ind = add_indicators(walk())
    sf = strategy.signal_frame(ind, CFG)
    assert levels.apply(ind, sf, {**CFG, "levels_mode": "atr"})["stop"].equals(sf["stop"])
    assert levels.plan_at(ind.head(40), CFG) is None


def test_a_logged_buy_takes_the_chart_levels_when_they_fit():
    chart = {"stop": 92.0, "target": 115.0}
    assert _levels(100.0, 3.0, CFG, None, chart) == (92.0, 115.0)
    assert _levels(100.0, 3.0, CFG, None, {"stop": 70.0, "target": 115.0}) == (94.0, 115.0)  # 30% away: ATR rule
    assert _levels(100.0, 3.0, CFG, None, {"stop": 95.0, "target": 101.0}) == (95.0, 100.0 + CFG["target_r"] * 5)
    assert _levels(100.0, 3.0, CFG, 90.0, chart) == (90.0, 115.0)                             # your own stop wins


def test_describe_explains_the_plan():
    lines = levels.describe(levels.plan_at(add_indicators(frame(V_PATH)), CFG))
    assert lines and lines[0].startswith("Stop sits just under support")
