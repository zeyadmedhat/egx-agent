import numpy as np
import pandas as pd

from egx_agent import backtest, db, portfolio
from egx_agent.indicators import add_indicators
from tests.conftest import make_ohlcv


def _market(n=500, seed=3):
    rng = np.random.default_rng(seed)
    data = {}
    for i in range(6):
        drift = 0.0015 if i % 2 == 0 else 0.0
        closes = 20 * np.exp(np.cumsum(rng.normal(drift, 0.022, n)))
        data[f"S{i}"] = make_ohlcv(closes, volume=rng.integers(1e6, 5e6, n))
    index = make_ohlcv(1000 * np.exp(np.cumsum(rng.normal(0.001, 0.01, n))))
    stocks = pd.DataFrame({"symbol": list(data), "sector": ["A", "B", "C", "A", "B", "C"],
                           "kashif_status": "compliant", "egx33": 1}).set_index("symbol", drop=False)
    return data, index, stocks


def test_backtest_accounting_is_consistent(cfg):
    cfg = {**cfg, "setups": ["breakout", "pullback", "macd"], "riskoff_block_buys": False}
    data, index, stocks = _market()
    prep = backtest.prepare(data, index, stocks, cfg)
    res = backtest.run(prep, cfg, index.index[260])
    trades, opened, fee = res["trades"], res["open_at_end"], cfg["fee_pct_per_side"] / 100
    assert len(trades) > 0
    unrealized = 0.0
    if len(opened):
        unrealized = float((opened.shares * opened.last_close - opened.shares * opened.entry_price * (1 + fee)).sum())
    expected = cfg["capital"] + trades.pnl.sum() + unrealized
    assert np.isclose(res["equity"].iloc[-1], expected)
    assert trades.days_held.max() <= cfg["max_hold_days"] + 1


def test_paper_order_fills_then_stops_out(tmp_path, cfg):
    conn = db.connect(tmp_path / "t.db")
    dates = pd.bdate_range("2026-01-04", periods=4, freq="C", weekmask="Sun Mon Tue Wed Thu")
    ind = pd.DataFrame({
        "open": [10.0, 10.1, 10.0, 9.2], "high": [10.2, 10.3, 10.1, 9.4], "low": [9.9, 10.0, 9.5, 9.0],
        "close": [10.0, 10.2, 9.6, 9.1], "ema50": 8.0, "atr14": 0.3,
    }, index=dates)
    portfolio.create_paper_orders(conn, [{"symbol": "X", "sector": "A", "shares": 1000, "stop": 9.4,
                                          "target": 11.2, "entry_limit": 10.2}], str(dates[0].date()))
    s1 = portfolio.process_paper(conn, cfg, {"X": ind}, dates[2])
    assert s1["filled"] == 1 and s1["closed"] == 0
    t = portfolio.trades_df(conn, "paper").iloc[0]
    assert t.status == "open" and t.entry_price == 10.1 and t.entry_date == str(dates[1].date())
    s2 = portfolio.process_paper(conn, cfg, {"X": ind}, dates[3])
    t = portfolio.trades_df(conn, "paper").iloc[0]
    assert s2["closed"] == 1 and t.status == "closed" and t.exit_price == 9.2   # gapped below the 9.4 stop
    summ = portfolio.account_summary(conn, "paper", cfg, {})
    fee = cfg["fee_pct_per_side"] / 100
    expected_pnl = (9.2 - 10.1) * 1000 - 10.1 * 1000 * fee - 9.2 * 1000 * fee
    assert np.isclose(summ["realized"], expected_pnl)
    assert np.isclose(summ["equity"], cfg["paper_capital"] + expected_pnl)


def test_real_trade_status_uses_rules(tmp_path, cfg):
    conn = db.connect(tmp_path / "t.db")
    df = add_indicators(make_ohlcv(np.linspace(10, 20, 300)))
    entry_day = df.index[-5]
    portfolio.add_real_buy(conn, cfg, "X", str(entry_day.date()), float(df.close.iloc[-5]), 100,
                           float(df.atr14.iloc[-5]))
    row = portfolio.trades_df(conn, "real", ("open",)).iloc[0]
    st = portfolio.real_status(row, df, cfg)
    assert st["status"] in {"HOLD", "TIGHTEN STOP"} and st["days_held"] == 5


def test_no_new_buys_while_most_stocks_are_under_their_50_day_average(cfg):
    _, _, stocks = _market()
    index = make_ohlcv(1000 * 1.002 ** np.arange(500))           # EGX30 above its 50-day average all along
    path = np.r_[20 * 1.002 ** np.arange(300), 20 * 1.002 ** 299 * 0.997 ** np.arange(1, 201)]   # up, then down
    prep = backtest.prepare({s: make_ohlcv(path) for s in stocks.index}, index, stocks, cfg)
    late = prep.risk_off.index[-50:]
    assert not (prep.index_ind["close"] < prep.index_ind["ema50"]).loc[late].any()
    assert prep.risk_off.loc[late].all() and not prep.buy.loc[late].to_numpy().any()
    assert not prep.risk_off.iloc[100:290].any()                # while they rose, buying was on
