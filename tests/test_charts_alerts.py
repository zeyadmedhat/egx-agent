"""The 1-hour and 4-hour charts, support/resistance Telegram alerts, and the Predict page's recent record."""
import json

import numpy as np
import pandas as pd

from app import alerts, views
from egx_agent import config, db, predict
from egx_agent.data import prices
from egx_agent.indicators import add_indicators
from tests.conftest import make_ohlcv

CFG = {**config.DEFAULTS, "levels_mode": "chart"}


def hourly(days=40, start="2026-06-07"):
    """Five hourly bars a session (10:00 … 14:00), rising slowly."""
    ts = [pd.Timestamp(d) + pd.Timedelta(hours=h) for d in pd.bdate_range(start, periods=days, freq="C",
                                                                           weekmask="Sun Mon Tue Wed Thu")
          for h in (10, 11, 12, 13, 14)]
    c = np.linspace(10, 12, len(ts))
    return pd.DataFrame({"ts": [t.strftime("%Y-%m-%d %H:%M") for t in ts], "open": c, "high": c + 0.1,
                         "low": c - 0.1, "close": c, "volume": 1000.0})


def test_four_hour_bars_are_made_like_tradingviews():
    h = hourly(2).assign(ts=lambda d: pd.to_datetime(d["ts"])).set_index("ts")
    four = prices.four_hour(h)
    assert [t.strftime("%d %H:%M") for t in four.index] == ["07 10:00", "07 14:00", "08 10:00", "08 14:00"]
    first = h.iloc[:4]
    assert four.iloc[0].tolist() == [first["open"].iloc[0], first["high"].max(), first["low"].min(),
                                     first["close"].iloc[-1], 4000.0]
    assert four.iloc[1]["volume"] == 1000.0


def test_stock_intraday_gives_both_charts(tmp_path):
    conn = db.connect(tmp_path / "egx.db")
    db.replace_intraday(conn, "AAA", hourly())
    out = views.stock_intraday(views.Data(conn, CFG, views.Cache()), "aaa")
    assert len(out["1h"]["time"]) == 200 and len(out["4h"]["time"]) == 80
    assert out["1h"]["time"][0] == int(pd.Timestamp("2026-06-07 10:00", tz="UTC").timestamp())   # Cairo's clock
    assert set(views.SERIES_COLS) <= set(out["4h"])
    db.replace_intraday(conn, "AAA", hourly(3))         # replaced as a whole
    assert views.stock_intraday(views.Data(conn, CFG, views.Cache()), "AAA") == {}   # too few bars to chart


def _stock(conn, closes, sym="VVV"):
    conn.execute("INSERT OR IGNORE INTO stocks(symbol, name_ar) VALUES (?, 'v')", (sym,))
    df = make_ohlcv(closes).rename_axis("date").reset_index()
    df["date"] = df["date"].dt.strftime("%Y-%m-%d")
    db.upsert_prices(conn, sym, df)
    return df["date"].iloc[-1]


# Up to 120, back to a low of 99 that held, up to 110 and back down to 100.3: just above that support.
BACK_TO_SUPPORT = (list(np.linspace(80, 120, 120)) + list(np.linspace(120, 100, 30)) + list(np.linspace(100, 110, 30))
                   + list(np.linspace(110, 100.3, 12)))


def test_a_levels_alert_fires_near_support_once(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "egx.db")
    last = _stock(conn, BACK_TO_SUPPORT)
    hit = alerts.level_touch(views.Data(conn, CFG, views.Cache()), "VVV", last)
    assert hit and hit["key"].startswith("support") and "near support" in hit["text"]
    assert alerts.level_touch(views.Data(conn, CFG, views.Cache()), "VVV", "2020-01-01") is None   # not that close

    assert "near a strong support" in alerts.watch_command(conn, "111", "/watch vvv levels")
    assert "near support or resistance" in alerts.watch_command(conn, "111", "/list")
    db.set_meta(conn, "site_subscribers", json.dumps({"111": {}}))
    sent = []
    monkeypatch.setattr(alerts, "send", lambda token, chat, text: sent.append(text))
    assert alerts.fire_watch_alerts(conn, "123:abc", last, CFG) == 1 and "VVV</b> · near support\nClosed at" in sent[0]
    assert alerts.fire_watch_alerts(conn, "123:abc", last, CFG) == 0          # the same touch isn't sent twice
    assert conn.execute("SELECT kind FROM watch_alerts").fetchone()[0] == "levels"   # it stays


def test_trade_outcomes_take_any_stop_and_target():
    ind = add_indicators(make_ohlcv(np.linspace(100, 130, 80), spread=0.0))
    n = len(ind)
    wide = predict.trade_outcomes(ind, CFG, 10, np.full(n, 50.0), np.full(n, 1000.0))
    near = predict.trade_outcomes(ind, CFG, 10, ind["close"].to_numpy() * 0.9, ind["close"].to_numpy() * 1.01)
    assert wide["hit"].dropna().eq(0).all()          # a target nobody reaches: time runs out
    assert near["hit"].dropna().eq(1).all()          # a steady rise reaches a 1% target first


def test_recent_record_counts_its_daily_top_picks(tmp_path):
    conn = db.connect(tmp_path / "egx.db")
    rows = []
    for d in range(35):
        day = f"2026-07-{d + 1:02d}" if d < 31 else f"2026-08-{d - 30:02d}"
        for i in range(12):   # the best-scored ten reach the target, the other two don't
            rows.append((day, f"S{i}", 10, 0.5, 1 - i / 12, 10.0, 0.05, 0.1, "x", int(i < 10),
                         0.1 if i < 10 else -0.05, "done"))
    conn.executemany("INSERT INTO predictions(date, symbol, horizon, prob, raw, close, stop_pct, target_pct, created, "
                     "hit, ret, resolved) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    rec = predict.recent_record(conn)["10"]
    assert rec["days"] == 30 and rec["n"] == 300 and rec["hits"] == 300 and rec["misses"] == 0
    assert abs(rec["ret"] - 0.1) < 1e-9 and rec["all_ret"] < rec["ret"]
    assert predict.recent_record(conn)["20"] == {"n": 0}


class HourlyFeed:
    def __init__(self):
        self.asked = []

    def fetch_hourly(self, symbol, n_bars):
        self.asked.append(symbol)
        return hourly(60, "2026-06-07")


def test_hourly_bars_are_fetched_when_behind_the_last_close(tmp_path):
    conn = db.connect(tmp_path / "egx.db")
    _stock(conn, np.linspace(10, 12, 80))                      # daily bars, no hourly ones yet
    feed = HourlyFeed()
    assert prices.intraday_behind(conn, "VVV") and prices.intraday_behind(conn)
    assert prices.refresh_intraday(conn, "VVV", provider=feed) and feed.asked == ["VVV"]
    assert not prices.intraday_behind(conn, "VVV")             # they reach its last close: not fetched again
    assert not prices.refresh_intraday(conn, "VVV", provider=feed) and feed.asked == ["VVV"]
    conn.execute("INSERT INTO prices(symbol, date, open, high, low, close, volume) VALUES "
                 "('VVV', '2026-09-29', 12, 12, 12, 12, 1)")     # a newer close: behind again
    assert prices.refresh_intraday(conn, "VVV", provider=feed) and feed.asked == ["VVV", "VVV"]


def test_the_worker_hands_over_messages_it_already_answered(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "egx.db")
    _stock(conn, np.linspace(10, 12, 80))
    sent = []
    monkeypatch.setattr(alerts, "send", lambda token, chat, text: sent.append(text))
    msg = lambda i, text: {"update_id": i, "message": {"chat": {"id": 5, "type": "private"}, "text": text}}
    out = alerts.sync_subscribers(conn, "123:abc", "secretcode1",
                                  [msg(1, "/start secretcode1"), msg(2, "/watch vvv 20")], answered=True)
    assert out["joined"] == 1 and out["commands"] == 1 and sent == []        # the Worker replied already
    st = alerts.worker_state(conn, "secretcode1")
    assert st["seen"] == 2 and st["subs"] == {"5": {"weekly": True}} and abs(st["stocks"]["VVV"] - 12) < 1e-9
    assert st["alerts"] == {"5": [{"symbol": "VVV", "kind": "above", "price": 20.0}]}
    assert st["info"]["stocks"]["VVV"]["c"] == st["stocks"]["VVV"] and "p10" not in st["info"]["stocks"]["VVV"]
    alerts.watch_command(conn, "5", "/watch vvv")
    assert "Removed all your alerts (2)" in alerts.watch_command(conn, "5", "/unwatch all")
    assert alerts.worker_state(conn, "secretcode1")["alerts"] == {}
