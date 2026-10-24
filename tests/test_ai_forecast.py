"""The AI models' forecasts: saving them once a close, grading them against what happened and against "no change",
and the stock page's card."""
import json

import numpy as np
import pandas as pd

from app import views
from egx_agent import ai_forecast, config, db, holidays
from egx_agent.data import news
from egx_agent.data.prices import INDEX_SYMBOL


def _market(tmp_path):
    conn = db.connect(tmp_path / "egx.db")
    days = [str(d.date()) for d in pd.bdate_range("2026-01-04", periods=200, freq="C", weekmask="Sun Mon Tue Wed Thu")]
    for sym, base in [(INDEX_SYMBOL, 1000.0), ("AAA", 10.0), ("BBB", 50.0)]:
        close = base * (1 + 0.001 * np.arange(len(days)))                # a steady rise
        conn.executemany("INSERT INTO prices VALUES (?, ?, ?, ?, ?, ?, ?)",
                         [(sym, d, c, c, c, c, 1e5) for d, c in zip(days, close)])
    conn.commit()
    return conn, days


def _models(monkeypatch):
    def up(data, made):        # the truth: +0.1% of the first price a session
        return {s: g["close"].iloc[-1] * (1 + 0.001 * np.arange(1, 21) / (1 + 0.001 * (len(g) - 1)))
                for s, g in data.items()}

    def flat(data, made):
        return {s: np.full(20, g["close"].iloc[-1]) for s, g in data.items()}

    def broken(data, made):
        raise RuntimeError("no model")

    monkeypatch.setattr(ai_forecast, "RUNNERS", {"up": up, "flat": flat, "broken": broken})
    monkeypatch.setattr(ai_forecast, "MODELS", {"up": ("Up", "Lab A"), "flat": ("Flat", "Lab B"), "broken": ("X", "C")})


def test_each_stock_is_read_with_egx30_on_the_same_days(tmp_path):
    conn, days = _market(tmp_path)
    conn.execute("DELETE FROM prices WHERE symbol=? AND date=?", (INDEX_SYMBOL, days[100]))   # no index close that day
    idx = dict(conn.execute("SELECT date, close FROM prices WHERE symbol=?", (INDEX_SYMBOL,)).fetchall())
    data = ai_forecast.inputs(conn, days[150])
    g = data["AAA"].set_index("date")
    assert INDEX_SYMBOL not in data and g.index[-1] == days[150] and g["egx30"].notna().all()
    assert g.at[days[150], "egx30"] == idx[days[150]] and g.at[days[100], "egx30"] == idx[days[99]]   # carried on


def test_forecasts_are_saved_once_a_close_and_graded_against_no_change(tmp_path, monkeypatch):
    conn, days = _market(tmp_path)
    _models(monkeypatch)
    db.set_meta(conn, "scan_data_date", days[150])
    assert ai_forecast.due(conn) == days[150]
    report = ai_forecast.run(conn, days[150]) | ai_forecast.run(conn, days[130])   # a backfill after
    assert report["up"].startswith("2 stocks") and report["broken"].startswith("failed (RuntimeError")
    assert ai_forecast.due(conn) is None                      # done for that close
    monkeypatch.setattr(ai_forecast, "VERSION", ai_forecast.VERSION + 1)
    assert ai_forecast.due(conn) == days[150]                 # ... unless the code changed which stocks get one
    monkeypatch.undo()
    _models(monkeypatch)
    assert ai_forecast.backfill_days(conn, days[150]) == days[149:141:-1]   # the sessions before, newest first
    paths = conn.execute("SELECT DISTINCT made FROM ai_paths").fetchall()
    assert [r[0] for r in paths] == [days[150]]               # an older run doesn't replace the newest path

    rec = ai_forecast.record(conn)
    assert set(rec["made"]) == {days[130], days[150]} and set(rec["model"]) == {"up", "flat", "middle"}
    row = rec[(rec["made"] == days[130]) & (rec["symbol"] == "AAA") & (rec["model"] == "up") & (rec["step"] == 5)].iloc[0]
    assert row["target"] == days[135] and np.isclose(row["start"], 11.3) and np.isclose(row["actual"], 11.35)
    assert np.isclose(row["forecast"], row["actual"])
    assert len(rec[rec["made"] == days[150]].query("step == 20")) == 6      # 20 sessions on: finished too (day 170)
    grades = {m: ai_forecast.grade(g) for m, g in rec.groupby("model")}
    assert grades["up"]["direction"] == 1 and grades["up"]["closer"] == 1 and grades["up"]["error"] < 1e-6
    assert grades["flat"]["direction"] is None and grades["flat"]["closer"] == 0   # "no change" itself
    assert grades["middle"]["direction"] == 1 and grades["middle"]["closer"] == 1
    assert np.isclose(grades["flat"]["error"], grades["flat"]["naive_error"])


def test_the_stock_page_shows_each_model_their_middle_and_how_they_did(tmp_path, monkeypatch):
    conn, days = _market(tmp_path)
    _models(monkeypatch)
    for made in (days[130], days[190]):
        ai_forecast.run(conn, made)
    d = views.Data(conn, dict(config.DEFAULTS), views.Cache())
    close = d.indicators("AAA")["close"]
    ai = views.ai_view(d, "AAA", close)
    assert ai["made"] == ai["start_date"] == days[190] and ai["start"] == close.iloc[190] and [m["key"] for m in ai["models"]] == ["up", "flat"]
    s = ai["steps"]["5"]
    assert s["target"] == days[195] and s["up"] == 1 and s["down"] == 0 and np.isclose(s["lo"], ai["start"])
    assert s["score"] == 0                                    # one rises, one stays: they don't agree
    assert s["mid"] == np.median(list(s["values"].values())) and s["typical"] > 0
    assert [p["made"] for p in s["past"]] == [days[130]] and s["past"][0]["actual"] == close.iloc[135]
    assert s["record"]["n"] == 2 and s["all"]["middle"]["n"] == 4 and s["all"]["up"]["closer"] == 1   # both finished
    assert len(ai["closes"]["time"]) == 61 and ai["closes"]["time"][-1] == days[-1]
    assert views.ai_view(d, "BBB", d.indicators("BBB")["close"].iloc[195:]) is None   # no close by the forecast's
    assert views.ai_view(d, "ZZZ", close) is None                                         # no forecasts


def test_a_coming_reset_is_flagged_and_forecasts_move_to_the_new_prices_after_it(tmp_path, monkeypatch):
    conn, days = _market(tmp_path)
    _models(monkeypatch)
    ai_forecast.run(conn, days[190])
    ex = holidays.sessions_after(days[-1], 2)                 # after the last close, inside 20 sessions, not 5
    news.save_corporate_actions(conn, [{"symbol": "AAA", "kind": "rights", "type": "Capital Increase - Rights Issue",
                                        "announced": days[180], "effective": ex, "note": ""}])
    d = views.Data(conn, dict(config.DEFAULTS), views.Cache())
    ai = views.ai_view(d, "AAA", d.indicators("AAA")["close"])
    assert ai["steps"]["20"]["reset"] == {"kind": "rights", "date": ex} and ai["steps"]["5"]["reset"] is None
    p5 = lambda sym: conn.execute("SELECT p5 FROM ai_forecasts WHERE symbol=? AND model='up'", (sym,)).fetchone()[0]  # noqa: E731
    before, other = p5("AAA"), p5("BBB")
    db.add_price_event(conn, "AAA", days[195], 2.0)          # the history re-based: old prices ÷ 2
    db.add_price_event(conn, "AAA", days[195], 2.0)          # found again: no second change
    assert p5("AAA") == before / 2 and p5("BBB") == other    # only that stock's
    path = conn.execute("SELECT path FROM ai_paths WHERE symbol='AAA' AND model='up'").fetchone()[0]
    assert np.isclose(json.loads(path)[4], before / 2)


def test_the_egx_trained_model_never_forecasts_from_before_its_training_ended(tmp_path, monkeypatch):
    conn, days = _market(tmp_path)
    monkeypatch.setattr(ai_forecast, "RUNNERS", {"chronos2_egx": lambda data, made: {s: np.full(20, 9.0) for s in data}})
    monkeypatch.setattr(ai_forecast, "EGX_TRAINED_TO", days[150])
    assert ai_forecast.run(conn, days[149])["chronos2_egx"].startswith("skipped")
    assert ai_forecast.run(conn, days[150])["chronos2_egx"].startswith("2 stocks")
    assert [r[0] for r in conn.execute("SELECT DISTINCT made FROM ai_forecasts")] == [days[150]]
