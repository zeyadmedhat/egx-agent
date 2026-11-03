"""The 7 layers (egx_agent/layers.py) and each level's 5 signs of strength (levels.test_zones)."""
import numpy as np

from egx_agent import layers, levels
from egx_agent.indicators import add_indicators
from tests.conftest import make_ohlcv


def _stock(n=400, seed=3):
    rng = np.random.default_rng(seed)
    closes = 10 * np.exp(np.cumsum(rng.normal(0.0008, 0.02, n)))
    vol = rng.uniform(5e5, 2e6, n)
    return add_indicators(make_ohlcv(closes, volume=vol))


def test_each_day_uses_only_the_bars_up_to_it():
    """The 10-year test scores every past day: a day's layers must be the same with or without the bars after it."""
    ind = _stock()
    full = layers.frame(ind)
    for n in (150, 260, 333):
        part = layers.frame(ind.iloc[:n])
        cols = list(layers.LAYERS) + ["score"]
        assert (part[cols].iloc[-1] == full[cols].iloc[n - 1]).all(), n
    assert full["score"].between(0, 7).all()


def test_market_structure_breaks():
    """A swing high broken from a downtrend is a change of character (CHoCH); the next one up is a break of structure."""
    up_down = [9, 9.5, 10, 11, 12, 11, 10, 9, 8, 9, 10, 11, 12.5, 12, 11, 11.5, 12, 13, 14]
    c = np.array(up_down, float)
    state, events = layers._structure(c + 0.1, c - 0.1, c)
    kinds = [(k, d) for _, k, d, _ in events]
    assert ("CHoCH", 1) in kinds and kinds[-1] == ("BOS", 1) and state[-1] == 1


def test_the_card_and_the_levels():
    ind = _stock()
    card = layers.check(ind)
    assert card["score"] == sum(x["ok"] for x in card["items"]) and [x["key"] for x in card["items"]] == list(layers.LAYERS)
    assert layers.check(ind.iloc[:100]) is None                       # too little history
    zones = [{"price": float(p), "low": float(p) * 0.995, "high": float(p) * 1.005, "strength": 2.0, "sources": []}
             for p in (ind["close"].min(), ind["close"].median(), ind["close"].max())]
    for z in levels.test_zones(ind, zones):
        k = z["test"]
        assert 0 <= k["score"] <= 5 and k["score"] == sum(k[f"is_{s}"] for s in ("touches", "volume", "weekly", "recent", "held"))
        assert k["flip"] in (None, "up", "down")
