import numpy as np
import pandas as pd

from egx_agent import indicators as ind
from egx_agent import strategy
from tests.conftest import make_ohlcv


def test_ema_of_constant_is_constant():
    s = pd.Series([5.0] * 50)
    assert np.allclose(ind.ema(s, 20), 5.0)


def test_rsi_extremes():
    up = pd.Series(np.arange(1, 60, dtype=float))
    down = up[::-1].reset_index(drop=True)
    assert ind.rsi(up).iloc[-1] == 100.0
    assert ind.rsi(down).iloc[-1] < 1.0


def test_atr_equals_constant_range():
    idx = pd.RangeIndex(40)
    df = pd.DataFrame({"open": 10.0, "high": 11.0, "low": 9.0, "close": 10.0}, index=idx)
    assert np.isclose(ind.atr(df).iloc[-1], 2.0)


def test_adx_high_in_steady_trend():
    df = make_ohlcv(np.linspace(10, 30, 120))
    assert ind.adx(df).iloc[-1] > 25


def test_indicators_have_no_lookahead():
    rng = np.random.default_rng(1)
    df = make_ohlcv(100 * np.exp(np.cumsum(rng.normal(0.001, 0.02, 400))),
                    volume=rng.integers(5e5, 2e6, 400))
    full = ind.add_indicators(df)
    cut = ind.add_indicators(df.iloc[:300])
    pd.testing.assert_frame_equal(full.iloc[:300], cut, check_exact=False, rtol=1e-9)


def test_signals_have_no_lookahead(cfg):
    rng = np.random.default_rng(2)
    df = make_ohlcv(100 * np.exp(np.cumsum(rng.normal(0.002, 0.02, 400))),
                    volume=rng.integers(5e5, 3e6, 400))
    full = strategy.signal_frame(ind.add_indicators(df), cfg)
    cut = strategy.signal_frame(ind.add_indicators(df.iloc[:320]), cfg)
    pd.testing.assert_frame_equal(full.iloc[:320], cut, check_exact=False, rtol=1e-9)


def test_breakout_detected(cfg):
    # 300 days of a gentle uptrend, then a high-volume jump above the 20-day high.
    closes = list(np.linspace(20, 30, 300)) + [32.0]
    vols = [1e6] * 300 + [4e6]
    df = ind.add_indicators(make_ohlcv(closes, volume=vols))
    sf = strategy.signal_frame(df, cfg).iloc[-1]
    assert sf.trend_ok and sf.breakout and sf.any_setup
    assert sf.stop < 32.0 < sf.target
