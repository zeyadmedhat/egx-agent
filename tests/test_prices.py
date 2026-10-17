import pandas as pd

from egx_agent import db
from egx_agent.data import prices


class FakeProvider:
    """Returns canned frames per symbol instead of calling TradingView."""

    def __init__(self, frames):
        self.frames = frames

    def fetch(self, symbol, n_bars):
        return self.frames.get(symbol)


def _bars(n, volume=1000.0, price=10.0):
    dates = pd.bdate_range("2026-01-04", periods=n, freq="C", weekmask="Sun Mon Tue Wed Thu")
    return pd.DataFrame({"date": dates.strftime("%Y-%m-%d"), "open": price, "high": price, "low": price,
                         "close": price, "volume": volume})


def test_aliases_map_kashif_codes_to_tradingview():
    p = prices.TvProvider(aliases={"xxxx": "yyyy"})
    assert p.aliases["AIHC"] == "AIH" and p.aliases["NAPR"] == "EGS370O1C013"
    assert p.aliases["XXXX"] == "YYYY"          # user overrides are upper-cased and added


def test_update_prices_labels_missing_stocks(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    for s in ("GOOD", "PAR", "GONE", "SIMO"):
        conn.execute("INSERT INTO stocks(symbol) VALUES (?)", (s,))
    provider = FakeProvider({"GOOD": _bars(30), "PAR": _bars(1, volume=0.0)})
    res = prices.update_prices(conn, ["GOOD", "PAR", "GONE", "SIMO"], provider=provider, workers=1)

    assert res["updated"] == 1 and res["not_traded"] == ["PAR"] and res["failed"] == ["GONE", "SIMO"]
    notes = {r["symbol"]: (r["price_missing_since"], r["price_note"]) for r in conn.execute("SELECT * FROM stocks")}
    assert notes["GOOD"] == (None, None)
    assert notes["PAR"][1] == prices.NOTE_NEVER_TRADED
    assert notes["GONE"][1] == prices.NOTE_NOT_FOUND
    assert "suspended" in notes["SIMO"][1]
    assert conn.execute("SELECT COUNT(*) FROM prices WHERE symbol='PAR'").fetchone()[0] == 0   # placeholder not stored


def test_zero_volume_days_kept_for_stocks_with_history(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    conn.execute("INSERT INTO stocks(symbol) VALUES ('HALT')")
    db.upsert_prices(conn, "HALT", _bars(20))
    later = _bars(25, volume=0.0).tail(5)       # a trading halt: new bars exist but nothing traded
    res = prices.update_prices(conn, ["HALT"], provider=FakeProvider({"HALT": later}), workers=1)
    assert res["updated"] == 1 and res["not_traded"] == []


def test_sessions_divided_twice_before_an_ex_date_are_put_back(tmp_path):
    # KORA, rights issue ex 14 Oct 2026: TradingView had 7 Oct at 3.5577 (÷ 1.8333) but 11-13 Oct ÷ 1.8333 again
    conn = db.connect(tmp_path / "t.db")
    f = 1.833333
    bars = pd.DataFrame({"date": ["2026-10-06", "2026-10-07", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"],
                         "open": [3.5577, 3.3552, 1.9472, 1.8514, 1.7285, 2.53],
                         "close": [3.3552, 3.5577, 1.8514, 1.7285, 1.3840, 2.92], "volume": 1e6})
    bars["high"], bars["low"] = bars[["open", "close"]].max(axis=1), bars[["open", "close"]].min(axis=1)
    db.upsert_prices(conn, "KORA", bars)
    db.add_price_event(conn, "KORA", "2026-10-14", f)
    assert prices.fix_double_rebase(conn, {"KORA"}) == ["KORA"]
    close = dict(conn.execute("SELECT date, close FROM prices WHERE symbol='KORA'").fetchall())
    assert round(close["2026-10-13"], 3) == 2.537 and close["2026-10-14"] == 2.92 and close["2026-10-07"] == 3.5577
    assert prices.fix_double_rebase(conn, {"KORA"}) == []             # once only


def test_rights_prices_are_kept_for_their_trading_period(tmp_path):
    """KORA_r1 (TradingView's KORAR1) is saved day by day while it trades, only its trading days, since TradingView
    drops it once the issue is over."""
    class Rights:
        def fetch(self, symbol, n_bars):
            assert symbol == "KORAR1"
            return pd.DataFrame({"date": ["2026-10-15", "2026-10-18", "2026-10-19"], "open": [2.3, 2.4, 2.5],
                                 "high": [2.3, 2.5, 2.6], "low": [2.3, 2.3, 2.4], "close": [2.3, 2.45, 2.55],
                                 "volume": [0.0, 1e6, 2e6]})
    conn = db.connect(tmp_path / "r.db")
    assert prices.update_rights(conn, Rights(), today="2026-10-17") == 0            # before the rights trade
    assert prices.update_rights(conn, Rights(), today="2026-10-19") == 2
    assert [tuple(r) for r in conn.execute("SELECT date, close FROM rights_prices WHERE symbol='KORA_r1' ORDER BY date")] == [
        ("2026-10-18", 2.45), ("2026-10-19", 2.55)]
    assert prices.update_rights(conn, Rights(), today="2026-11-20") == 0            # long over
