"""The prediction model: trade outcomes, no look-ahead in testing, training/saving/predicting, and the page."""
import json
import time
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from app import jobs
from egx_agent import config, db, predict
from egx_agent.data import prices
from tests.conftest import make_ohlcv
from tests.test_api import H
from tests.test_prices import FakeProvider

LEVELS = {"atr_stop_mult": 2.0, "stop_min_pct": 4.0, "stop_max_pct": 12.0, "target_r": 2.0, "fee_pct_per_side": 0.0}


def _bars(rows):
    """rows: (open, high, low, close); ATR fixed at 2.5 so the stop is 5% below the close and the target 10% above."""
    idx = pd.bdate_range("2025-01-05", periods=len(rows), freq="C", weekmask="Sun Mon Tue Wed Thu")
    df = pd.DataFrame(rows, columns=["open", "high", "low", "close"], index=idx, dtype=float)
    df["atr14"] = 2.5
    return df


def test_trade_outcomes_follow_the_plan():
    flat = (100, 100.5, 99.5, 100)
    win = _bars([flat, (100, 111, 99, 108), flat, flat])            # target 110 hit the next day
    out = predict.trade_outcomes(win, LEVELS, horizon=3)
    assert out["hit"].iloc[0] == 1 and out["ret"].iloc[0] == pytest.approx(0.10)

    both = _bars([flat, (100, 111, 94, 100), flat, flat])           # stop and target on the same day: a loss
    out = predict.trade_outcomes(both, LEVELS, horizon=3)
    assert out["hit"].iloc[0] == 0 and out["ret"].iloc[0] == pytest.approx(-0.05)

    timeout = _bars([flat, flat, flat, (100, 103, 99, 102)])       # neither level within 3 sessions
    out = predict.trade_outcomes(timeout, LEVELS, horizon=3)
    assert out["hit"].iloc[0] == 0 and out["ret"].iloc[0] == pytest.approx(0.02)

    gap = _bars([flat, (94, 96, 93, 95), flat, flat])               # opens below the stop: the order is cancelled
    assert np.isnan(predict.trade_outcomes(gap, LEVELS, horizon=3)["hit"].iloc[0])
    # the last rows don't have 3 sessions after them yet
    assert predict.trade_outcomes(win, LEVELS, horizon=3)["hit"].iloc[-2:].isna().all()


def test_liquidity_is_judged_in_the_money_of_its_time():
    days = pd.bdate_range("2018-01-01", periods=120).repeat(2)
    value = np.where(np.arange(240) < 120, 1e6, 10e6)              # the market traded 10× less in the early days
    ds = pd.DataFrame({"date": days, "symbol": ["A", "B"] * 120, "value_avg20": value, "bars": 300, "close": 5.0,
                       "recent_jump": False})
    rules = {"min_avg_value_egp": 5e6, "min_price": 1, "min_history_bars": 250}
    liquid = predict._liquid_then(ds, rules)
    assert liquid.iloc[:20].all()          # 1M then is like 10M today: above the 5M rule
    assert liquid.iloc[-20:].all()         # 10M today, above 5M
    ds["value_avg20"] = np.where(np.arange(240) < 120, 0.3e6, 3e6)
    liquid = predict._liquid_then(ds, rules)
    assert not liquid.iloc[:20].any() and not liquid.iloc[-20:].any()


def test_walk_forward_never_trains_on_the_future(monkeypatch):
    from sklearn.ensemble import HistGradientBoostingClassifier
    monkeypatch.setattr(predict, "new_model", lambda n=0: HistGradientBoostingClassifier(max_iter=5))
    rng = np.random.default_rng(1)
    days = pd.bdate_range("2015-01-01", "2020-12-31")
    ds = pd.DataFrame({"date": days.repeat(3), "symbol": ["A", "B", "C"] * len(days)})
    for f in predict.FEATURES:
        ds[f] = rng.normal(size=len(ds)).astype("float32")
    ds["liquid"] = True
    ds["hit10"] = (ds["ret5"] + rng.normal(size=len(ds)) > 1).astype(float)
    ds["ret10_trade"] = ds["hit10"] * 0.1 - 0.02
    ds["rule_buy"] = False
    oos, folds = predict.walk_forward(ds, 10)
    assert [f["year"] for f in folds] == [2018, 2019, 2020]
    for f in folds:
        first_test = oos[oos["date"].dt.year == f["year"]]["date"].min()
        between = len(pd.bdate_range(f["train_to"], first_test)) - 2   # sessions strictly between them
        assert between >= 10, f
    r = predict.evaluate(oos, 10)
    assert r["auc"] > 0.6 and r["top"]["hit"] > r["all"]["hit"] and len(r["groups"]) == 4


def _market(tmp_path, n=1300, stocks=10):
    """A small market with about 5 years of history."""
    conn = db.connect(tmp_path / "egx.db")
    rng = np.random.default_rng(7)
    start = "2021-01-03"
    for i in range(stocks):
        sym = f"S{i:02d}"
        conn.execute("INSERT INTO stocks(symbol, name_ar, sector_ar) VALUES (?, ?, ?)",
                     (sym, sym, "بنوك" if i % 2 else "عقاري"))
        closes = 20 * np.exp(np.cumsum(rng.normal(0.0004, 0.02, n)))
        df = make_ohlcv(closes, start=start, spread=0.012, volume=2e6).rename_axis("date").reset_index()
        df["date"] = df["date"].dt.strftime("%Y-%m-%d")
        db.upsert_prices(conn, sym, df)
    idx = make_ohlcv(1000 * np.exp(np.cumsum(rng.normal(0.0003, 0.01, n))), start=start).rename_axis("date").reset_index()
    idx["date"] = idx["date"].dt.strftime("%Y-%m-%d")
    db.upsert_prices(conn, prices.INDEX_SYMBOL, idx)
    db.set_meta(conn, "history_years_loaded", str(prices.DEEP_YEARS))   # no download in tests
    conn.commit()
    return conn


@pytest.fixture
def fast_model(monkeypatch):
    from sklearn.ensemble import HistGradientBoostingClassifier
    monkeypatch.setattr(predict, "new_model",
                        lambda n=0: HistGradientBoostingClassifier(max_iter=15, min_samples_leaf=40))


def test_train_saves_next_to_the_database_predicts_and_resolves(tmp_path, cfg, fast_model):
    conn = _market(tmp_path)
    meta = predict.train(conn, cfg)
    root = tmp_path / "models"
    assert predict.model_dir(conn) == root
    assert (root / "prediction.joblib").exists() and (root / "prediction.json").exists()
    assert meta["stocks"] == 10 and set(meta["horizons"]) == {"10", "20"}
    r = meta["horizons"]["10"]
    assert r["years"] and r["all"]["n"] > 1000 and r["grade"] in ("good", "weak", "none")

    lt = predict.latest(conn)
    assert len(lt) == 10 and lt["p10"].between(0, 1).all() and set(lt["rank10"]) <= set(range(1, 11))
    day = lt["date"].iloc[0]
    assert conn.execute("SELECT COUNT(*) FROM predictions WHERE resolved IS NULL").fetchone()[0] == 20

    # 25 sessions later every prediction has an outcome
    for sym in [f"S{i:02d}" for i in range(10)]:
        last = db.load_prices(conn, sym).iloc[-1]
        more = make_ohlcv(last["close"] * np.linspace(1, 2, 25), start=str(pd.Timestamp(day) + timedelta(days=1)))
        more = more.rename_axis("date").reset_index()
        more["date"] = more["date"].dt.strftime("%Y-%m-%d")
        db.upsert_prices(conn, sym, more)
    assert predict.resolve(conn, cfg) == 20
    live = predict.live_record(conn)
    assert live["10"]["n"] == 10 and live["10"]["all"]["hit"] == 1.0   # a steady doubling reaches every target


def test_retraining_is_due_after_a_month_or_a_settings_change(tmp_path, cfg, fast_model):
    conn = _market(tmp_path)
    assert not predict.needs_training(conn, cfg)          # the first training is started by you
    predict.train(conn, cfg)
    assert not predict.needs_training(conn, cfg)
    assert predict.needs_training(conn, cfg, today=date.today() + timedelta(days=31))
    assert predict.needs_training(conn, {**cfg, "target_r": 3.0})
    assert predict.settings_changed(predict.load_meta(tmp_path / "models"), {**cfg, "target_r": 3.0}) == ["target_r"]


def test_predict_page_before_and_after_training(tmp_path, monkeypatch, fast_model):
    import warnings
    from app.server import create_app
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        from fastapi.testclient import TestClient
    monkeypatch.setattr(config, "CONFIG_PATH", tmp_path / "config.yaml")
    _market(tmp_path).close()
    with TestClient(create_app(tmp_path / "egx.db", autoscan=False)) as c:
        page = c.get("/api/predict").json()
        assert page["model"] is None and page["deep"] is True and page["features"] == len(predict.FEATURES)
        assert c.post("/api/predict/train").status_code == 403           # only the dashboard can start it
        assert c.post("/api/predict/train", headers=H).status_code == 200
        for _ in range(600):
            job = c.get("/api/jobs/current").json()["job"]
            if job["state"] != "running":
                break
            time.sleep(0.1)
        assert job["state"] == "done", job
        assert "Tested on years it hadn't seen" in job["summary"]
        page = c.get("/api/predict").json()
        assert page["model"]["stocks"] == 10 and len(page["rows"]) == 10
        row = page["rows"][0]
        assert {"p10", "p20", "rank10", "rank20", "stop", "target", "info"} <= set(row)
        assert page["base"]["10"] is not None
        stock = c.get(f"/api/stock/{row['symbol']}").json()
        assert stock["prediction"]["count"] == 10 and stock["prediction"]["p10"] == row["p10"]
        assert c.get("/api/today").status_code == 200


def test_monthly_retrain_runs_after_a_scan_only_when_due(tmp_path, cfg, fast_model):
    conn = _market(tmp_path)
    assert jobs.retrain_if_due(conn, cfg, lambda p, m: None) == ""
    predict.train(conn, cfg)
    meta = predict.load_meta(tmp_path / "models")
    meta["trained_at"] = (date.today() - timedelta(days=40)).isoformat() + "T10:00:00"
    predict.meta_path(tmp_path / "models").write_text(json.dumps(meta))
    assert jobs.retrain_if_due(conn, cfg, lambda p, m: None) == "retrained"
    assert predict.age_days(predict.load_meta(tmp_path / "models")) == 0


def test_deeper_history_adds_older_bars_and_fixes_bad_ones(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    full = make_ohlcv(np.linspace(10, 20, 60), start="2025-01-05").rename_axis("date").reset_index()
    full["date"] = full["date"].dt.strftime("%Y-%m-%d")
    stored = full.iloc[30:].copy()
    stored.loc[stored.index[10], "close"] = 5.0            # one corrupted bar, like HBCO's on 24 Sep 2026
    db.upsert_prices(conn, "OLD", stored)
    res = prices.extend_history(conn, ["OLD"], years=10, provider=FakeProvider({"OLD": full}), workers=1)
    assert res["bars_added"] == 30 and res["events"] == []            # a bad bar is not a bonus-share event
    px = db.load_prices(conn, "OLD")
    assert len(px) == 60 and px["close"].iloc[40] == pytest.approx(full["close"].iloc[40])
    assert db.get_meta(conn, "history_years_loaded") == "10"
    assert prices.rebase_info(conn, "OLD", full) is None
