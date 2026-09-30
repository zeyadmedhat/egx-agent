"""Every company's cash dividends from TradingView's screener, kept as they're seen, and a stock's history."""
from datetime import date, datetime, timedelta

import pandas as pd
import pytest

from app import views
from egx_agent import config, db
from egx_agent.data import dividends, fundamentals


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


def test_company_numbers_next_to_their_sector(tmp_path):
    conn = db.connect(tmp_path / "egx.db")
    nums = {"COMI": (6.0, 28.0, 0.35), "BANK1": (4.0, 10.0, 0.5), "BANK2": (5.0, 12.0, 0.4), "BANK3": (7.0, 20.0, None),
            "TECH": (30.0, 50.0, 0.1)}
    dividends.save(conn, [{**_row(s, None), "price_earnings_ttm": pe, "earnings_per_share_diluted_yoy_growth_ttm": g,
                           "debt_to_equity_fq": de} for s, (pe, g, de) in nums.items()] + [_row("NONE", None)])
    sectors = pd.Series({"COMI": "Banks", "BANK1": "Banks", "BANK2": "Banks", "BANK3": "Banks", "TECH": "Tech"})
    f = dividends.company_numbers(conn, "COMI", sectors)
    assert f["values"] == {"pe": 6.0, "eps_growth": pytest.approx(0.28), "debt_equity": 0.35}   # percents → fractions
    assert f["sector"] == "Banks" and f["peers"] == 3
    assert f["sector_median"] == {"pe": 5.0, "eps_growth": pytest.approx(0.12)}   # debt: only 2 banks report it
    assert dividends.company_numbers(conn, "NONE", sectors) is None


def test_company_results_count_only_once_they_were_known(tmp_path):
    """The model sees a quarter's results only Q_LAG days after it ends (Y_LAG for the fiscal year's last quarter)."""
    conn = db.connect(tmp_path / "egx.db")
    ts = lambda day: int(pd.Timestamp(day, tz="UTC").timestamp())         # noqa: E731
    ni = [30, 20, 25, 20, 15, 10, 12, 10, 9, 8]                            # quarterly profit, newest (Q2 2026) first
    dividends.save(conn, [{**_row("AIH", None), "fiscal_period_end_fq": ts("2026-06-30"),
                           "fiscal_period_end_fy": ts("2025-12-31"), "total_shares_outstanding": 10,
                           "net_income_fq_h": ni, "earnings_per_share_diluted_fq_h": [v / 10 for v in ni],
                           "total_revenue_fq_h": [100] * 10, "total_assets_fq_h": [1000] * 10}, _row("NONE", None)])
    days = pd.to_datetime(["2026-06-30", "2026-10-27", "2026-10-28"])
    ds = pd.DataFrame({"date": days, "symbol": "AIHC", "close": 10.0, "liquid": True})    # the agent's own symbol
    f = fundamentals.features(ds, fundamentals.reports(conn))
    # 30 Jun: Q4 2025 (known 150 days after the year ended), 27 Oct: Q1 2026, 28 Oct: Q2 2026 (120 days after)
    assert f["f_ey"].tolist() == pytest.approx([0.70, 0.80, 0.95])        # the last 4 quarters' profit ÷ the price
    assert f["f_ni_growth"].iloc[2] == pytest.approx(95 / 47 - 1)          # against the 4 quarters a year before
    assert f["f_q_yoy"].iloc[2] == pytest.approx(30 / 15 - 1) and f["f_profit"].tolist() == [1, 1, 1]
    assert fundamentals.features(ds, None)["f_ey"].isna().all()           # no history downloaded: empty, not an error


def test_company_results_in_brief_for_the_signal_cards(tmp_path):
    conn = db.connect(tmp_path / "egx.db")
    ts = lambda day: int(pd.Timestamp(day, tz="UTC").timestamp())         # noqa: E731
    q = lambda ni, rev, eps: {"fiscal_period_end_fq": ts("2026-06-30"), "net_income_fq_h": ni,   # noqa: E731
                              "total_revenue_fq_h": rev, "earnings_per_share_diluted_fq_h": eps}
    dividends.save(conn, [
        {**_row("AIH", None), **q([30, 20, 25, 20, 15, 10, 12, 10], [100] * 4 + [80] * 4, [0.3, 0.2, 0.25, 0.2] * 2)},
        {**_row("LOSS", None), **q([-5, -5, -5, -5, 2, 2, 2, 2], [50] * 8, [-0.1] * 8)}])
    for sym, close in (("AIHC", 9.5), ("LOSS", 3.0)):
        conn.execute("INSERT INTO prices(symbol, date, open, high, low, close, volume) VALUES (?, '2026-09-30', ?, ?, ?, ?, 1e6)",
                     (sym, close, close, close, close))
    brief = views.company_brief(views.Data(conn, dict(config.DEFAULTS), views.Cache()))
    # the last 4 quarters against the 4 before: TradingView's AIH is the agent's AIHC; P/E = the close ÷ a year's
    # profit per share; a company losing money gets no P/E (the page says it lost money instead of its growth)
    assert brief["AIHC"] == {"growth": pytest.approx(95 / 47 - 1, abs=1e-4), "sales": 0.25, "margin": 0.2375,
                             "pe": pytest.approx(9.5 / 0.95, abs=1e-4)}
    assert brief["LOSS"] == {"growth": -3.5, "sales": 0.0, "margin": -0.1}      # -20 on 200 of sales
