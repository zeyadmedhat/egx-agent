import numpy as np
import pytest

from egx_agent import db, portfolio


@pytest.fixture
def conn(tmp_path):
    return db.connect(tmp_path / "t.db")


def open_rows(conn):
    return portfolio.trades_df(conn, "real", ("open",))


def test_second_buy_merges_at_average_price(conn, cfg):
    portfolio.add_real_buy(conn, cfg, "KORA", "2026-09-23", 6.55, 3500, atr=0.3)
    portfolio.add_real_buy(conn, cfg, "KORA", "2026-09-24", 6.28, 4025, atr=0.3)
    rows = open_rows(conn)
    assert len(rows) == 1
    pos = rows.iloc[0]
    assert pos.shares == 7525
    assert np.isclose(pos.entry_price, (6.55 * 3500 + 6.28 * 4025) / 7525)
    assert pos.entry_date == "2026-09-23"                      # the 1-month clock counts from the first buy
    assert np.isclose(pos.fees, (6.55 * 3500 + 6.28 * 4025) * cfg["fee_pct_per_side"] / 100)
    assert pos.stop < pos.entry_price < pos.target
    assert list(portfolio.fills_df(conn, int(pos.id)).side) == ["buy", "buy"]


def test_typed_stop_is_kept_when_adding(conn, cfg):
    portfolio.add_real_buy(conn, cfg, "X", "2026-09-01", 10.0, 100, atr=0.4)
    portfolio.add_real_buy(conn, cfg, "X", "2026-09-02", 11.0, 100, atr=0.4, stop=9.5)
    pos = open_rows(conn).iloc[0]
    assert pos.stop == 9.5 and np.isclose(pos.target, 10.5 + 2 * (10.5 - 9.5))


def test_partial_sell_keeps_rest_open_and_books_exact_pnl(conn, cfg):
    fee = cfg["fee_pct_per_side"] / 100
    tid = portfolio.add_real_buy(conn, cfg, "X", "2026-09-01", 10.0, 100, atr=0.4)
    assert portfolio.sell_real(conn, cfg, tid, "2026-09-05", 12.0, 40, "Taking partial profit") == "partial"

    pos = open_rows(conn).iloc[0]
    assert pos.shares == 60 and pos.entry_price == 10.0 and np.isclose(pos.fees, 10 * 60 * fee)
    closed = portfolio.trades_df(conn, "real", ("closed",)).iloc[0]
    assert closed.shares == 40 and closed.exit_price == 12.0
    realized = (12 - 10) * 40 - (10 * 40 * fee + 12 * 40 * fee)
    s = portfolio.account_summary(conn, "real", cfg, {"X": 12.0})
    assert np.isclose(s["realized"], realized)
    # cash = start − everything paid for the buy + what the sale brought in
    assert np.isclose(s["cash"], cfg["capital"] - 10 * 100 * (1 + fee) + 12 * 40 * (1 - fee))
    assert list(portfolio.fills_df(conn, tid).side) == ["buy", "sell"]


def test_selling_everything_closes_and_overselling_fails(conn, cfg):
    tid = portfolio.add_real_buy(conn, cfg, "X", "2026-09-01", 10.0, 100, atr=0.4)
    with pytest.raises(ValueError):
        portfolio.sell_real(conn, cfg, tid, "2026-09-05", 11.0, 101, "x")
    portfolio.sell_real(conn, cfg, tid, "2026-09-05", 11.0, 30, "x")
    assert portfolio.sell_real(conn, cfg, tid, "2026-09-06", 11.5, 70, "x") == "closed"
    assert open_rows(conn).empty
    assert portfolio.trades_df(conn, "real", ("closed",)).shares.sum() == 100


def test_buying_again_after_closing_starts_new_position(conn, cfg):
    tid = portfolio.add_real_buy(conn, cfg, "X", "2026-09-01", 10.0, 100, atr=0.4)
    portfolio.sell_real(conn, cfg, tid, "2026-09-05", 11.0, 100, "x")
    new_id = portfolio.add_real_buy(conn, cfg, "X", "2026-09-10", 12.0, 50, atr=0.4)
    assert new_id != tid and open_rows(conn).iloc[0].entry_date == "2026-09-10"


def test_migration_merges_old_duplicate_entries(conn, cfg):
    fee = cfg["fee_pct_per_side"] / 100
    for date, px, n, stop in (("2026-09-23", 6.55, 3500, 5.764), ("2026-09-24", 6.28, 4025, 5.5264),
                              ("2026-09-27", 6.59, 4722, 5.7992)):
        conn.execute(
            """INSERT INTO trades(account, status, symbol, entry_date, entry_price, shares, initial_stop, stop, target,
                   highest_close, fees) VALUES ('real', 'open', 'KORA', ?, ?, ?, ?, ?, ?, ?, ?)""",
            (date, px, n, stop, stop, px * 1.2, px, px * n * fee),
        )
    conn.commit()
    assert portfolio.migrate_real_positions(conn, cfg) == 2
    pos = open_rows(conn).iloc[0]
    assert len(open_rows(conn)) == 1 and pos.shares == 12247
    assert np.isclose(pos.entry_price, (6.55 * 3500 + 6.28 * 4025 + 6.59 * 4722) / 12247)
    assert pos.entry_date == "2026-09-23"
    assert 5.5264 < pos.stop < 5.7992                         # no price data here: stops blended by shares
    assert len(portfolio.fills_df(conn, int(pos.id))) == 3
    assert portfolio.migrate_real_positions(conn, cfg) == 0   # safe to run again
    assert len(portfolio.fills_df(conn, int(pos.id))) == 3
