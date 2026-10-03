"""Real trades (logged by you) and paper trades (placed automatically by the agent)."""
from __future__ import annotations

import sqlite3

import pandas as pd

from . import config, corporate, db, engine, levels
from .indicators import add_indicators
from .strategy import initial_stop


TEXT_COLS = ("sector", "signal_date", "entry_date", "exit_next_open", "last_bar_date", "exit_date", "exit_reason", "notes")


def trades_df(conn: sqlite3.Connection, account: str, statuses: tuple[str, ...] | None = None) -> pd.DataFrame:
    q = "SELECT * FROM trades WHERE account=?"
    params: list = [account]
    if statuses:
        q += f" AND status IN ({','.join('?' * len(statuses))})"
        params += list(statuses)
    df = pd.read_sql_query(q + " ORDER BY id", conn, params=params)
    # pandas reads an empty text next to a filled one as NaN, and NaN counts as true: a paper trade would be sold
    # at the next open for no reason. Empty text stays None.
    for col in TEXT_COLS:
        df[col] = df[col].astype(object).where(df[col].notna(), None)
    return df


# ---------------------------------------------------------------- real account

def _levels(price: float, atr: float | None, cfg: dict, stop: float | None = None,
            chart: dict | None = None) -> tuple[float, float]:
    """Stop and target for an entry/average price. The stop is the one you typed, else the chart's support
    (levels.chart_plan on the buy date, when it's under a support and between stop_min_pct and stop_max_pct below the
    price), else the ATR rule. The target is the chart's resistance when it pays at least the risk, else target_r ×
    the risk."""
    if stop:
        stop = float(stop)
    elif (chart and chart.get("method") != "atr"
          and cfg["stop_min_pct"] / 100 <= 1 - chart["stop"] / price <= cfg["stop_max_pct"] / 100):
        stop = float(chart["stop"])
    else:
        stop = float(initial_stop(price, atr, cfg))
    risk = price - stop
    if chart and chart["target"] >= price + risk:
        return stop, float(chart["target"])
    return stop, price + cfg["target_r"] * risk


def _add_fill(conn: sqlite3.Connection, trade_id: int, symbol: str, date: str, side: str, shares: int,
              price: float, fees: float, note: str = "") -> None:
    conn.execute(
        "INSERT INTO fills(trade_id, symbol, date, side, shares, price, fees, note) VALUES (?,?,?,?,?,?,?,?)",
        (trade_id, symbol, date, side, int(shares), float(price), float(fees), note),
    )


def open_position(conn: sqlite3.Connection, account: str, symbol: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM trades WHERE account=? AND status='open' AND symbol=? ORDER BY entry_date, id LIMIT 1",
        (account, symbol),
    ).fetchone()


def fills_df(conn: sqlite3.Connection, trade_id: int) -> pd.DataFrame:
    return pd.read_sql_query("SELECT * FROM fills WHERE trade_id=? ORDER BY date, id", conn, params=(trade_id,))


def _merge_buy(conn: sqlite3.Connection, cfg: dict, pos: sqlite3.Row, date: str, price: float, shares: int,
               fee: float, atr: float | None, stop: float | None, notes: str, chart: dict | None = None) -> None:
    """Add shares to an open position at the share-weighted average price.

    The stop and target are recalculated from the new average (unless a stop is given). The position keeps its
    first buy date, so the 2-week review and 1-month limit still count from when you first bought.
    """
    total = int(pos["shares"]) + int(shares)
    avg = (pos["entry_price"] * pos["shares"] + price * shares) / total
    new_stop, target = _levels(avg, atr, cfg, stop, chart)
    note = "; ".join(x for x in (pos["notes"], notes) if x)
    conn.execute(
        """UPDATE trades SET entry_date=?, entry_price=?, shares=?, initial_stop=?, stop=?, target=?,
               highest_close=?, fees=?, notes=? WHERE id=?""",
        (min(pos["entry_date"], date), avg, total, new_stop, new_stop, target, avg, (pos["fees"] or 0) + fee,
         note, pos["id"]),
    )


def add_real_buy(conn: sqlite3.Connection, cfg: dict, symbol: str, date: str, price: float, shares: int,
                 atr: float, sector: str = "", stop: float | None = None, notes: str = "",
                 chart: dict | None = None, fees_in: bool = False) -> int:
    """Log a buy. If you already hold this stock, the shares join that position at the average price. chart: the
    stock's chart levels on the buy date (levels.plan_at), for the automatic stop and target. fees_in: the price is
    your broker's average cost, which already has the fees in it (Thndr's does), so none are added."""
    fee = 0.0 if fees_in else config.order_fee(price * shares, cfg)
    pos = open_position(conn, "real", symbol)
    if pos is None:
        new_stop, target = _levels(price, atr, cfg, stop, chart)
        cur = conn.execute(
            """INSERT INTO trades(account, status, symbol, sector, entry_date, entry_price, shares, initial_stop, stop,
                   target, highest_close, fees, notes)
               VALUES ('real', 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (symbol, sector, date, price, shares, new_stop, new_stop, target, price, fee, notes),
        )
        trade_id = int(cur.lastrowid)
    else:
        trade_id = int(pos["id"])
        _merge_buy(conn, cfg, pos, date, price, shares, fee, atr, stop, notes, chart)
    _add_fill(conn, trade_id, symbol, date, "buy", shares, price, fee, notes)
    conn.commit()
    return trade_id


def sell_real(conn: sqlite3.Connection, cfg: dict, trade_id: int, date: str, price: float, shares: int,
              reason: str) -> str:
    """Sell some or all shares of an open real position. Returns 'partial' or 'closed'.

    A partial sale becomes its own closed trade at the position's average price (with its share of the buy
    fees), so realized P&L is exact; the rest of the position stays open unchanged.
    """
    pos = conn.execute("SELECT * FROM trades WHERE id=? AND status='open'", (trade_id,)).fetchone()
    if pos is None:
        raise ValueError("This position is not open.")
    shares = int(shares)
    if not 0 < shares <= pos["shares"]:
        raise ValueError(f"You can sell between 1 and {pos['shares']:,} shares.")
    sell_fee = config.order_fee(price * shares, cfg)
    _add_fill(conn, trade_id, pos["symbol"], date, "sell", shares, price, sell_fee, reason)
    if shares == pos["shares"]:
        close_trade(conn, cfg, trade_id, date, price, reason)
        return "closed"
    buy_fee_part = (pos["fees"] or 0) * shares / pos["shares"]
    conn.execute(
        """INSERT INTO trades(account, status, symbol, sector, entry_date, entry_price, shares, initial_stop, stop,
               target, highest_close, exit_date, exit_price, exit_reason, fees, notes)
           VALUES ('real', 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (pos["symbol"], pos["sector"], pos["entry_date"], pos["entry_price"], shares, pos["initial_stop"],
         pos["stop"], pos["target"], pos["highest_close"], date, price, reason, buy_fee_part + sell_fee,
         f"partial sale from position #{trade_id}"),
    )
    conn.execute("UPDATE trades SET shares=?, fees=? WHERE id=?",
                 (pos["shares"] - shares, (pos["fees"] or 0) - buy_fee_part, trade_id))
    conn.commit()
    return "partial"


def _atr_on(conn: sqlite3.Connection, symbol: str, date: str) -> float | None:
    df = db.load_prices(conn, symbol)
    if len(df) < 15:
        return None
    atr = add_indicators(df)["atr14"].loc[:pd.Timestamp(date)].dropna()
    return float(atr.iloc[-1]) if len(atr) else None


def migrate_real_positions(conn: sqlite3.Connection, cfg: dict) -> int:
    """Upgrade older data. Safe to run on every start.

    1. Once: give every existing real trade a buy (and sell) entry in the transaction history.
    2. Merge several open positions in the same stock into one, at the average price.
    Returns how many entries were merged.
    """
    fee = cfg["fee_pct_per_side"] / 100
    if not db.get_meta(conn, "fills_backfilled"):
        for r in conn.execute("SELECT * FROM trades WHERE account='real' ORDER BY id").fetchall():
            _add_fill(conn, r["id"], r["symbol"], r["entry_date"], "buy", r["shares"], r["entry_price"],
                      r["entry_price"] * r["shares"] * fee, r["notes"] or "")
            if r["status"] == "closed":
                _add_fill(conn, r["id"], r["symbol"], r["exit_date"], "sell", r["shares"], r["exit_price"],
                          r["exit_price"] * r["shares"] * fee, r["exit_reason"] or "")
        db.set_meta(conn, "fills_backfilled", "1")

    merged = 0
    dupes = conn.execute(
        "SELECT symbol FROM trades WHERE account='real' AND status='open' GROUP BY symbol HAVING COUNT(*) > 1"
    ).fetchall()
    for (sym,) in dupes:
        rows = conn.execute(
            "SELECT * FROM trades WHERE account='real' AND status='open' AND symbol=? ORDER BY entry_date, id", (sym,)
        ).fetchall()
        keep_id = rows[0]["id"]
        for other in rows[1:]:
            keep = conn.execute("SELECT * FROM trades WHERE id=?", (keep_id,)).fetchone()
            atr = _atr_on(conn, sym, other["entry_date"])
            # Without price data, blend the two stops by shares instead of recalculating.
            stop = None if atr else (keep["initial_stop"] * keep["shares"] + other["initial_stop"] * other["shares"]) / (
                keep["shares"] + other["shares"])
            _merge_buy(conn, cfg, keep, other["entry_date"], other["entry_price"], other["shares"],
                       other["fees"] or 0, atr, stop, other["notes"] or "")
            conn.execute("UPDATE fills SET trade_id=? WHERE trade_id=?", (keep_id, other["id"]))
            conn.execute("DELETE FROM trades WHERE id=?", (other["id"],))
            merged += 1
    conn.commit()
    return merged


def close_trade(conn: sqlite3.Connection, cfg: dict, trade_id: int, date: str, price: float, reason: str) -> None:
    row = conn.execute("SELECT shares, fees FROM trades WHERE id=?", (trade_id,)).fetchone()
    fees = (row["fees"] or 0) + config.order_fee(price * row["shares"], cfg)
    conn.execute(
        "UPDATE trades SET status='closed', exit_date=?, exit_price=?, exit_reason=?, fees=? WHERE id=?",
        (date, price, reason, fees, trade_id),
    )
    conn.commit()


def delete_trade(conn: sqlite3.Connection, trade_id: int) -> None:
    """Remove a position logged by mistake, with its transaction history."""
    conn.execute("DELETE FROM fills WHERE trade_id=?", (trade_id,))
    conn.execute("DELETE FROM dividends WHERE trade_id=?", (trade_id,))
    conn.execute("DELETE FROM position_adjustments WHERE trade_id=?", (trade_id,))
    conn.execute("DELETE FROM trades WHERE id=?", (trade_id,))
    conn.commit()


def real_status(row: pd.Series, ind: pd.DataFrame | None, cfg: dict) -> dict:
    """What the exit rules say about one open real trade today."""
    if ind is None or ind.empty:
        return {"status": "NO DATA", "reason": "No price data for this symbol", "stop": row["stop"],
                "days_held": 0, "last_close": None}
    pos = engine.Position(
        symbol=row["symbol"], entry_date=row["entry_date"], entry_price=float(row["entry_price"]),
        shares=int(row["shares"]), initial_stop=float(row["initial_stop"]), stop=float(row["initial_stop"]),
        target=float(row["target"]), highest_close=float(row["entry_price"]), sector=row.get("sector") or "",
    )
    st = engine.replay_status(pos, levels.with_support(ind, cfg, row["entry_date"]), cfg)
    st["last_close"] = float(ind["close"].iloc[-1])
    return st


# ---------------------------------------------------------------- account maths

def account_summary(conn: sqlite3.Connection, account: str, cfg: dict, last_close: dict[str, float]) -> dict:
    start = float(cfg["capital"] if account == "real" else cfg["paper_capital"])
    closed = trades_df(conn, account, ("closed",))
    open_ = trades_df(conn, account, ("open",))
    dividends = sum(corporate.dividends_by_trade(conn, account).values())
    realized = float(((closed.exit_price - closed.entry_price) * closed.shares - closed.fees).sum()) if len(closed) else 0.0
    realized += dividends
    cost = float((open_.entry_price * open_.shares + open_.fees).sum()) if len(open_) else 0.0
    cash = start + realized - cost
    # A position still waiting for its bonus-share update holds the old share count at old prices.
    factor = {t: e["factor"] for t, e in corporate.pending(conn, account).items()}
    market = sum(last_close.get(r.symbol, r.entry_price) * r.shares * factor.get(r.id, 1.0) for r in open_.itertuples())
    equity = cash + market
    return {
        "start": start, "cash": cash, "equity": equity, "realized": realized, "dividends": dividends,
        "unrealized": market - cost, "open_count": len(open_),
        "open_risk": float(((open_.entry_price - open_.stop).clip(lower=0) * open_.shares).sum()) if len(open_) else 0.0,
        "return_pct": equity / start - 1,
    }


def positions_for_allocation(conn: sqlite3.Connection, account: str, statuses=("open", "pending")) -> list[dict]:
    df = trades_df(conn, account, statuses)
    out = []
    for r in df.itertuples():
        entry = r.entry_price if pd.notna(r.entry_price) else r.entry_limit
        out.append({"symbol": r.symbol, "sector": r.sector, "entry_price": float(entry), "stop": float(r.stop),
                    "shares": int(r.shares)})
    return out


# ---------------------------------------------------------------- paper trading

def create_paper_orders(conn: sqlite3.Connection, orders: list[dict], signal_date: str) -> int:
    n = 0
    for o in orders:
        if o["shares"] <= 0:
            continue
        conn.execute(
            """INSERT INTO trades(account, status, symbol, sector, signal_date, shares, initial_stop, stop, target,
                   entry_limit, notes)
               VALUES ('paper', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (o["symbol"], o.get("sector"), signal_date, int(o["shares"]), float(o["stop"]), float(o["stop"]),
             float(o["target"]), float(o["entry_limit"]), o.get("setup", "")),
        )
        n += 1
    conn.commit()
    return n


def _save_position(conn: sqlite3.Connection, trade_id: int, pos: engine.Position, last_bar: str) -> None:
    conn.execute(   # the target too: it moves down on an ex-dividend date (engine.ex_dividend)
        """UPDATE trades SET stop=?, target=?, highest_close=?, days_held=?, exit_next_open=?, last_bar_date=?
           WHERE id=?""",
        (pos.stop, pos.target, pos.highest_close, pos.days_held, pos.exit_next_open, last_bar, trade_id),
    )


def process_paper(conn: sqlite3.Connection, cfg: dict, ind: dict[str, pd.DataFrame], upto: pd.Timestamp) -> dict:
    """Fill pending paper orders at the next open and walk open paper trades through new bars."""
    fee = cfg["fee_pct_per_side"] / 100
    stats = {"filled": 0, "cancelled": 0, "closed": 0}

    for r in trades_df(conn, "paper", ("pending",)).itertuples():
        frame = ind.get(r.symbol)
        bars = frame.loc[(frame.index > pd.Timestamp(r.signal_date)) & (frame.index <= upto)] if frame is not None else None
        if bars is None or bars.empty:
            continue
        bar = bars.iloc[0]
        order = {"symbol": r.symbol, "shares": r.shares, "stop": r.stop, "target": r.target,
                 "entry_limit": r.entry_limit, "sector": r.sector}
        pos, msg = engine.fill_order(order, bar)
        if pos is None:
            conn.execute("UPDATE trades SET status='cancelled', exit_reason=?, exit_date=? WHERE id=?",
                         (msg, str(bar.name.date()), r.id))
            stats["cancelled"] += 1
            continue
        cash = account_summary(conn, "paper", cfg, {})["cash"]
        pos.shares = min(pos.shares, int(cash // (pos.entry_price * (1 + fee))))
        if pos.shares <= 0:
            conn.execute("UPDATE trades SET status='cancelled', exit_reason='not enough paper cash' WHERE id=?", (r.id,))
            stats["cancelled"] += 1
            continue
        conn.execute(
            """UPDATE trades SET status='open', entry_date=?, entry_price=?, shares=?, highest_close=?, fees=?,
                   last_bar_date=NULL, days_held=0 WHERE id=?""",
            (pos.entry_date, pos.entry_price, pos.shares, pos.entry_price, pos.entry_price * pos.shares * fee, r.id),
        )
        conn.commit()
        stats["filled"] += 1

    for r in trades_df(conn, "paper", ("open",)).itertuples():
        frame = ind.get(r.symbol)
        if frame is None:
            continue
        start = pd.Timestamp(r.last_bar_date) if r.last_bar_date else pd.Timestamp(r.entry_date) - pd.Timedelta(days=1)
        frame = levels.with_support(frame, cfg, start)
        bars = frame.loc[(frame.index > start) & (frame.index <= upto)]
        pos = engine.Position(
            symbol=r.symbol, entry_date=r.entry_date, entry_price=r.entry_price, shares=int(r.shares),
            initial_stop=r.initial_stop, stop=r.stop, target=r.target, highest_close=r.highest_close,
            days_held=int(r.days_held or 0), exit_next_open=r.exit_next_open, sector=r.sector or "",
        )
        last = r.last_bar_date
        for ts, bar in bars.iterrows():
            div = engine.bar_dividend(bar)
            if div and pos.days_held >= 1:     # held at the close before the ex-date: paid, like a real account
                conn.execute("INSERT INTO dividends(trade_id, symbol, date, shares, amount, note) VALUES (?,?,?,?,?,?)",
                             (r.id, r.symbol, str(ts.date()), pos.shares, div * pos.shares, "paid automatically"))
            res = engine.process_bar(pos, bar, cfg)
            last = str(ts.date())
            if res:
                price, reason = res
                _save_position(conn, r.id, pos, last)
                close_trade(conn, cfg, r.id, last, price, reason)
                stats["closed"] += 1
                break
        else:
            _save_position(conn, r.id, pos, last)
    conn.commit()
    return stats


def equity_curve(conn: sqlite3.Connection, account: str, cfg: dict, closes: dict[str, pd.Series],
                 dates: pd.DatetimeIndex) -> pd.Series:
    """Daily account value from the first trade onward (cash + holdings at each close)."""
    df = trades_df(conn, account, ("open", "closed"))
    start = float(cfg["capital"] if account == "real" else cfg["paper_capital"])
    if df.empty:
        return pd.Series(dtype=float)
    first = pd.Timestamp(df.entry_date.min())
    dates = dates[dates >= first]
    fee = cfg["fee_pct_per_side"] / 100
    values = []
    for d in dates:
        cash, held = start, 0.0
        for r in df.itertuples():
            ed = pd.Timestamp(r.entry_date)
            if ed > d:
                continue
            cash -= r.entry_price * r.shares * (1 + fee)
            if r.status == "closed" and pd.Timestamp(r.exit_date) <= d:
                cash += r.exit_price * r.shares * (1 - fee)
            else:
                s = closes.get(r.symbol)
                px = s.loc[:d].iloc[-1] if s is not None and len(s.loc[:d]) else r.entry_price
                held += px * r.shares
        values.append(cash + held)
    return pd.Series(values, index=dates)
