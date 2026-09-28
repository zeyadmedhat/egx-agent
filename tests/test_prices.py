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
