"""Every company's cash dividends from TradingView's screener, kept as they're seen, and a stock's history."""
from datetime import date, datetime, timedelta

import pytest

from app import views
from egx_agent import db
from egx_agent.data import dividends


def _row(name, yield_pct, recent=None, upcoming=None):
    """recent/upcoming: (ex_ts, amount, pay_ts)."""
    r = {"name": name, "dividends_yield_current": yield_pct}
    for when, v in (("recent", recent), ("upcoming", upcoming)):
        ex, amount, pay = v or (None, None, None)
        r.update({f"dividend_ex_date_{when}": ex, f"dividend_amount_{when}": amount,
                  f"dividend_payment_date_{when}": pay})
    return r


def test_dividends_are_kept_as_they_are_seen(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    apr7, apr9 = 1775563140, 1775735940                    # 7 and 9 Apr 2026, 14:59 Cairo time
    oct1, oct5 = 1790855940, 1791201540                    # 1 and 5 Oct 2026
    assert dividends.save(conn, [_row("COMI", 4.68, (apr7, 6.0, apr9)), _row("NONE", None)]) == 1
    assert dividends.save(conn, [_row("COMI", 4.7, (apr7, 6.0, apr9), (oct1, 2.5, None))]) == 1
    assert dividends.save(conn, [_row("COMI", 4.7, (oct1, 2.5, oct5))]) == 0    # the announced one was paid
    rows = [tuple(r) for r in conn.execute("SELECT symbol, ex_date, pay_date, amount FROM cash_dividends ORDER BY ex_date")]
    assert rows == [("COMI", "2026-04-07", "2026-04-09", 6.0), ("COMI", "2026-10-01", "2026-10-05", 2.5)]
    assert conn.execute("SELECT yield_pct FROM dividend_yield WHERE symbol='COMI'").fetchone()[0] == pytest.approx(4.7)


def test_a_stocks_dividend_and_bonus_share_history(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    soon = (date.today() + timedelta(days=5)).isoformat()
    conn.execute("INSERT INTO cash_dividends(symbol, ex_date, pay_date, amount) VALUES ('ABC', '2025-04-01', "
                 "'2025-04-03', 1.5), ('ABC', ?, NULL, 2.0)", (soon,))
    conn.execute("INSERT INTO dividend_yield(symbol, yield_pct) VALUES ('ABC', 3.5)")
    db.add_price_event(conn, "ABC", "2024-06-02", 1.25)
    h = views.corporate_history(conn, "ABC", 50.0)
    assert [(r["ex_date"], r["upcoming"]) for r in h["dividends"]] == [(soon, True), ("2025-04-01", False)]
    assert h["dividends"][1]["pct"] == pytest.approx(0.03) and h["yield"] == pytest.approx(0.035)
    assert h["bonus"] == [{"ex_date": "2024-06-02", "factor": 1.25, "text": "1 free share for every 4 you hold"}]
    assert views.corporate_history(conn, "XYZ", 10.0) == {"dividends": [], "yield": None, "bonus": [], "actions": [],
                                                          "results": None}


def _ts(day: str) -> int:
    """TradingView's timestamp for a day: mid-afternoon Cairo time."""
    return int(datetime.fromisoformat(day + "T14:00:00+03:00").timestamp())


def test_results_dates_come_with_the_dividends(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    today = date.today()
    soon, recent = (today + timedelta(days=20)).isoformat(), (today - timedelta(days=70)).isoformat()
    stale = (today - timedelta(days=dividends.EARNINGS_STALE_DAYS + 30)).isoformat()
    rows = [{**_row("COMI", 4.7), "earnings_release_date": _ts(recent), "earnings_release_next_date": _ts(soon)},
            {**_row("OLDC", None), "earnings_release_date": _ts(stale), "earnings_release_next_date": _ts(soon)},
            {**_row("AIH", None), "earnings_release_date": _ts(recent), "earnings_release_next_date": _ts(soon)},
            _row("NONE", None)]                                   # no results fields: nothing stored
    dividends.save(conn, rows)
    got = {r["symbol"]: (r["next_date"], r["last_date"]) for r in conn.execute("SELECT * FROM earnings")}
    assert got == {"COMI": (soon, recent), "OLDC": ("", stale), "AIH": (soon, recent)}
    # a company that stopped reporting on TradingView gets no guess; TradingView's names map back to the agent's
    assert dividends.next_results(conn, today.isoformat()) == {"COMI": soon, "AIHC": soon}
    assert dividends.next_results(conn, soon) == {}
    h = views.corporate_history(conn, "COMI", 100.0)
    assert h["results"] == {"next": soon, "last": recent}
    assert views.corporate_history(conn, "AIHC", 10.0)["results"]["next"] == soon
