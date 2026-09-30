import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from egx_agent.config import DEFAULTS  # noqa: E402


def make_ohlcv(closes, start="2024-01-07", spread=0.01, volume=1e6) -> pd.DataFrame:
    """Synthetic daily bars on the EGX Sunday–Thursday calendar."""
    idx = pd.bdate_range(start, periods=len(closes), freq="C", weekmask="Sun Mon Tue Wed Thu")
    c = pd.Series(closes, index=idx, dtype=float)
    o = c.shift(1).fillna(c.iloc[0])
    vol = volume if np.ndim(volume) else np.full(len(c), float(volume))
    return pd.DataFrame({
        "open": o, "high": np.maximum(o, c) * (1 + spread), "low": np.minimum(o, c) * (1 - spread),
        "close": c, "volume": vol,
    }, index=idx)


def bar(date, o, h, l, c, ema50=0.0, atr14=1.0) -> pd.Series:
    return pd.Series({"open": o, "high": h, "low": l, "close": c, "ema50": ema50, "atr14": atr14},
                     name=pd.Timestamp(date))


@pytest.fixture
def cfg():
    return dict(DEFAULTS)


@pytest.fixture(autouse=True)
def _no_news_downloads(monkeypatch):
    """Tests never reach Mubasher, TradingView's news or the RSS feeds (news tests pass their own fetcher)."""
    from egx_agent.data import news

    def offline(self, url, polite=True, **kw):
        raise ConnectionError("no downloads in tests")
    monkeypatch.setattr(news.Fetcher, "get", offline)


@pytest.fixture(autouse=True)
def _no_tradingview_lists(monkeypatch):
    """Nor TradingView's stock list, dividends, company numbers, hourly bars or the Egypt data and gold (tests pass
    their own rows or fetcher)."""
    from egx_agent.data import dividends, macro, prices, universe

    def offline(*a, **kw):
        raise ConnectionError("no downloads in tests")

    class NoTradingView:
        def fetch(self, *a, **kw):
            return None
    monkeypatch.setattr(macro, "TvProvider", NoTradingView)
    monkeypatch.setattr(universe, "fetch_tradingview", offline)
    monkeypatch.setattr(dividends, "_feed", offline)
    monkeypatch.setattr(dividends, "fetch", offline)
    monkeypatch.setattr(prices.TvProvider, "fetch_hourly", lambda self, symbol, n_bars: None)
