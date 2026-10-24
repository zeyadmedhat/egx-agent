import time
import warnings

import numpy as np
import pytest

from app import views
from app.server import create_app
from egx_agent import config, db
from tests.conftest import make_ohlcv

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

H = {"X-EGX-Agent": "1"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CONFIG_PATH", tmp_path / "config.yaml")
    conn = db.connect(tmp_path / "egx.db")
    conn.execute("INSERT INTO stocks(symbol, name_ar, sector_ar, kashif_status, egx33) VALUES ('AAA', 'أ', 'بنوك', 'compliant', 1)")
    conn.execute("INSERT INTO stocks(symbol, name_ar, sector_ar) VALUES ('BBB', 'ب', 'عقاري')")
    for sym, base in (("AAA", 10.0), ("BBB", 20.0), ("EGX30", 1000.0)):
        df = make_ohlcv(np.linspace(base, base * 1.3, 300), volume=2e6).rename_axis("date").reset_index()
        df["date"] = df["date"].dt.strftime("%Y-%m-%d")
        db.upsert_prices(conn, sym, df)
    conn.commit()
    conn.close()
    with TestClient(create_app(tmp_path / "egx.db", autoscan=False)) as c:
        c.app_db = tmp_path / "egx.db"
        yield c


def test_every_page_loads(client):
    for path in ("/api/health", "/api/status", "/api/stocks", "/api/today", "/api/portfolio", "/api/paper",
                 "/api/settings", "/api/backtest", "/"):
        assert client.get(path).status_code == 200, path
    stock = client.get("/api/stock/AAA").json()
    assert stock["has_data"] and len(stock["series"]["time"]) == 300
    assert stock["info"]["kashif_status"] == "compliant" and stock["info"]["egx33"] == 1
    assert client.get("/api/stock/NOPE").json()["has_data"] is False


def test_changes_need_the_dashboard_header(client):
    assert client.post("/api/paper/reset").status_code == 403
    assert client.post("/api/paper/reset", headers=H).status_code == 200


def test_buy_merge_partial_sell_and_delete(client):
    r = client.post("/api/portfolio/buy", headers=H, json={"symbol": "aaa", "date": "2025-02-02", "price": 12, "shares": 100})
    assert r.status_code == 200 and r.json()["message"].startswith("Saved")
    r = client.post("/api/portfolio/buy", headers=H, json={"symbol": "AAA", "date": "2025-02-03", "price": 13, "shares": 100})
    assert "average of 12.500" in r.json()["message"]
    pos = client.get("/api/portfolio").json()["positions"]
    assert len(pos) == 1 and pos[0]["shares"] == 200 and pos[0]["n_buys"] == 2

    tid = pos[0]["id"]
    assert client.post("/api/portfolio/sell", headers=H, json={"trade_id": tid, "date": "2025-02-10", "price": 14,
                                                               "shares": 201}).status_code == 400
    r = client.post("/api/portfolio/sell", headers=H, json={"trade_id": tid, "date": "2025-02-10", "price": 14, "shares": 50})
    assert r.json()["result"] == "partial"
    page = client.get("/api/portfolio").json()
    assert page["positions"][0]["shares"] == 150 and page["closed_stats"]["count"] == 1

    assert client.delete(f"/api/portfolio/{tid}", headers=H).status_code == 200
    assert client.get("/api/portfolio").json()["positions"] == []


def test_buy_is_validated(client):
    bad = {"symbol": "AAA", "date": "2025-02-02", "price": 12, "shares": 10, "stop": 13}
    assert client.post("/api/portfolio/buy", headers=H, json=bad).status_code == 400
    assert client.post("/api/portfolio/buy", headers=H, json={**bad, "symbol": "ZZZ", "stop": None}).status_code == 400
    assert client.post("/api/portfolio/buy", headers=H, json={**bad, "shares": 0}).status_code == 422


def test_settings_are_validated_saved_and_reset(client):
    r = client.put("/api/settings", headers=H, json={"stop_min_pct": 15, "stop_max_pct": 12})
    assert r.status_code == 400 and "stop_min_pct" in r.json()["detail"]["errors"]
    r = client.put("/api/settings", headers=H, json={"capital": 150000, "min_avg_value_egp": 7e6,
                                                      "symbol_aliases": "aihc=aih", "egx33_extra": "abuk, mfpc"})
    assert r.status_code == 200
    saved = config.load_config()
    assert saved["capital"] == 150000 and saved["min_avg_value_egp"] == 7e6
    assert saved["symbol_aliases"] == {"AIHC": "AIH"} and saved["egx33_extra"] == ["ABUK", "MFPC"]
    assert client.put("/api/settings", headers=H, json={"symbol_aliases": "AIHC"}).status_code == 400

    client.put("/api/settings", headers=H, json={"buy_score": 80})
    client.post("/api/settings/defaults", headers=H)
    after = config.load_config()
    assert after["buy_score"] == config.DEFAULTS["buy_score"] and after["capital"] == 150000  # capital is kept


def test_backtest_runs_in_the_background(client):
    job = client.post("/api/backtest", headers=H, json={"years": 1, "universe": "all"}).json()["job"]
    assert job["state"] == "running"
    for _ in range(100):
        job = client.get("/api/jobs/current").json()["job"]
        if job["state"] != "running":
            break
        time.sleep(0.1)
    assert job["state"] == "done", job
    res = client.get("/api/backtest").json()
    assert res["params"] == {"years": 1, "universe": "all"} and len(res["equity"]) > 200


def test_json_cleaning():
    out = views.clean({"a": np.float64("nan"), "b": np.int64(3), "c": [float("inf"), np.bool_(True)]})
    assert out == {"a": None, "b": 3, "c": [None, True]}


def test_choice_settings_keep_their_value():
    """A two-way choice is saved as the option itself: "mine" or "chart" stay words, True/False stay booleans."""
    new, errors = views.parse_settings({"stop_moves": "mine", "levels_mode": "atr", "riskoff_block_buys": False},
                                       dict(config.DEFAULTS))
    assert not errors and new["stop_moves"] == "mine" and new["levels_mode"] == "atr" and new["riskoff_block_buys"] is False
    assert "stop_moves" in views.parse_settings({"stop_moves": True}, dict(config.DEFAULTS))[1]
