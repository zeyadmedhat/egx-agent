"""The stock page's price ranges (egx_agent/ranges.py): calibrated on what similar stocks did, they hold the close 8
times in 10, and the price ladder runs the right way."""
import numpy as np
import pandas as pd

from app import views
from egx_agent import config, db, ranges
from egx_agent.data.prices import INDEX_SYMBOL


def _market(tmp_path, n_stocks=45, n_days=700):
    """Random walks with steady swings from calm (0.5% a day) to wild (4%), and one stock listed 30 sessions ago."""
    conn = db.connect(tmp_path / "egx.db")
    days = [str(d.date()) for d in pd.bdate_range("2023-01-01", periods=n_days, freq="C", weekmask="Sun Mon Tue Wed Thu")]
    rng = np.random.default_rng(7)
    rows = [(INDEX_SYMBOL, d, 1000.0, 1000.0, 1000.0, 1000.0, 1e8) for d in days]
    for j in range(n_stocks):
        vol = 0.005 + 0.035 * j / (n_stocks - 1)
        close = 10 * np.exp(np.cumsum(rng.normal(0, vol, n_days)))
        hi, lo = close * np.exp(abs(rng.normal(0, vol / 2, n_days))), close * np.exp(-abs(rng.normal(0, vol / 2, n_days)))
        volume = 1e5 * (1 + j % 5)
        rows += [(f"S{j:02d}", d, c, h, l, c, volume) for d, c, h, l in zip(days, close, hi, lo)]
    rows += [("NEW", d, 5.0, 5.1, 4.9, 5.0, 1e5) for d in days[-30:]]
    conn.executemany("INSERT INTO prices VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
    conn.commit()
    return conn, days


def test_ranges_hold_the_close_8_times_in_10_and_the_ladder_runs_outward(tmp_path):
    conn, days = _market(tmp_path)
    r = ranges.build(conn)
    assert r["date"] == days[-1] and "NEW" not in r["stocks"]           # 30 sessions: too little history
    for h in ("5", "20"):
        every = r["all"][h]
        assert every["n"] > 5000 and 0.74 < every["inside"] / every["n"] < 0.86
    calm, wild = r["stocks"]["S00"]["steps"]["5"], r["stocks"]["S44"]["steps"]["5"]
    close = r["stocks"]["S00"]["close"]
    assert calm["lo"] < close < calm["hi"] and calm["target"] > days[-1]
    assert wild["hi"] / wild["lo"] - 1 > 3 * (calm["hi"] / calm["lo"] - 1)    # the wild one's range is far wider
    for s in (calm, wild):
        ups, downs = [p for _, p in s["up"]], [p for _, p in s["down"]]
        assert [c for c, _ in s["up"]] == sorted((c for c, _ in s["up"]), reverse=True)
        assert ups == sorted(ups) and downs == sorted(downs, reverse=True)    # less likely = further away
        assert s["record"]["n"] > 200


def test_the_stock_page_carries_its_range(tmp_path):
    conn, _ = _market(tmp_path, n_stocks=27, n_days=650)
    d = views.Data(conn, dict(config.DEFAULTS), views.Cache())
    out = views.range_view(d, "S10")
    assert out["steps"]["20"]["cap"] == ranges.CAP[20] and out["tested"] is ranges.TESTED and out["all"]["5"]["n"] > 0
    assert views.range_view(d, "NEW") is None
