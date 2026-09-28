"""Daily scan: refresh data → indicators → signals → sizing → save; then advance paper trading."""
from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, time, timedelta
from typing import Callable, Iterable
from zoneinfo import ZoneInfo

import pandas as pd

from . import corporate, db, portfolio, predict, risk, strategy
from .data import dividends, macro, news, prices, shariah, universe
from .indicators import add_indicators

CAIRO = ZoneInfo("Africa/Cairo")
DATA_READY = time(15, 30)       # EGX closes ~14:30 Cairo; give data providers an hour
TRADING_WEEKDAYS = {6, 0, 1, 2, 3}  # Sunday–Thursday


def expected_session_date(now: datetime | None = None) -> date:
    """Most recent EGX session whose closing data should be available by now (holidays ignored)."""
    now = now or datetime.now(CAIRO)
    d = now.date()
    if d.weekday() in TRADING_WEEKDAYS and now.time() >= DATA_READY:
        return d
    d -= timedelta(days=1)
    while d.weekday() not in TRADING_WEEKDAYS:
        d -= timedelta(days=1)
    return d


def scan_is_final(conn: sqlite3.Connection) -> bool:
    """False when the last scan ran during its own session, before the closing data was ready: it used an
    unfinished day, so it's scanned again after the close (and Telegram waits for that one)."""
    data_date = db.get_meta(conn, "scan_data_date")
    finished = json.loads(db.get_meta(conn, "market") or "{}").get("finished")
    if not (data_date and finished):
        return True
    t = datetime.fromisoformat(finished).astimezone(CAIRO)
    return not (t.date().isoformat() == data_date and t.time() < DATA_READY)


def scan_is_stale(conn: sqlite3.Connection) -> bool:
    data_date = db.get_meta(conn, "scan_data_date")
    expected = expected_session_date().isoformat()
    if data_date and (data_date > expected or data_date == expected and scan_is_final(conn)):
        return False
    attempted = db.get_meta(conn, "scan_attempted")
    if attempted:
        tried = datetime.fromisoformat(attempted)
        # Only a try after this close's data was due counts: a scan during the session doesn't hold back the one after.
        due = datetime.combine(date.fromisoformat(expected), DATA_READY, CAIRO).astimezone().replace(tzinfo=None)
        if tried >= due and tried > datetime.now() - timedelta(hours=2):
            return False  # tried recently; probably a holiday or data not published yet
    return True


def load_indicators(conn: sqlite3.Connection, symbols: list[str]) -> tuple[pd.DataFrame, dict[str, pd.DataFrame]]:
    """Indicator frames for the index and each symbol with data."""
    index_df = db.load_prices(conn, prices.INDEX_SYMBOL)
    index_ind = add_indicators(index_df)
    frames = {}
    for s in symbols:
        df = db.load_prices(conn, s)
        if len(df) > 60:
            frames[s] = add_indicators(df, index_df["close"])
    return index_ind, frames


def _symbols_to_update(conn: sqlite3.Connection) -> list[str]:
    week_ago = (date.today() - timedelta(days=7)).isoformat()
    rows = conn.execute("SELECT symbol, price_missing_since FROM stocks ORDER BY symbol").fetchall()
    return [r["symbol"] for r in rows if not r["price_missing_since"] or r["price_missing_since"] < week_ago]


def process_account(conn: sqlite3.Connection, cfg: dict, ind: dict[str, pd.DataFrame], scan_ts: pd.Timestamp,
                    buys: list[dict], stocks: pd.DataFrame, risk_off: bool) -> dict:
    """One person's paper account after a scan: bonus-share updates, fills and exits, then tomorrow's orders."""
    scan_date = str(scan_ts.date())
    corporate.apply_paper(conn)  # bonus shares / splits: paper trades follow the re-based prices by themselves
    stats = portfolio.process_paper(conn, cfg, ind, scan_ts)
    new_orders = 0
    mine = [b for b in buys if b["symbol"] in stocks.index
            and shariah.passes_filter(stocks.loc[b["symbol"]].to_dict(), cfg["shariah_filter"])]
    if cfg["auto_paper"] and mine:
        closes = {s: float(f["close"].iloc[-1]) for s, f in ind.items()}
        paper = portfolio.account_summary(conn, "paper", cfg, closes)
        sized = risk.allocate(mine, paper["equity"], paper["cash"], portfolio.positions_for_allocation(conn, "paper"),
                              cfg, risk_off)
        already = set(portfolio.trades_df(conn, "paper").query("signal_date == @scan_date").symbol)
        new_orders = portfolio.create_paper_orders(conn, [o for o in sized if o["symbol"] not in already], scan_date)
    stats = {**stats, "new_orders": new_orders, "date": scan_date}
    db.set_user_meta(conn, "paper_last_scan", json.dumps(stats))
    return stats


def run_scan(conn: sqlite3.Connection, cfg: dict, progress: Callable[[float, str], None] | None = None,
             update_data: bool = True,
             accounts: Callable[[], Iterable[tuple[sqlite3.Connection, dict]]] | None = None) -> dict:
    """Download prices, score every stock and save the signals (shared by everyone), then update each paper account.

    Signals are saved without share counts or the Shariah filter: each person's own settings apply when they look
    (views.signals) and to their paper account here. accounts yields (connection, settings) per person; by default
    it's just this connection, as on your Mac.
    """
    say = progress or (lambda p, msg: None)
    db.set_meta(conn, "scan_attempted", datetime.now().isoformat(timespec="seconds"))
    warnings = []
    events = []

    say(0.02, "Checking Kashif Shariah data…")
    if shariah.needs_refresh(conn):
        try:
            shariah.refresh_kashif(conn)
        except Exception as exc:
            warnings.append(f"Kashif refresh failed, using cached Shariah data ({exc})")
    universe.ensure_seeded(conn)

    if update_data:
        syms = _symbols_to_update(conn) + [prices.INDEX_SYMBOL]
        res = prices.update_prices(
            conn, syms, years=cfg["history_years"], aliases=cfg.get("symbol_aliases"),
            progress=lambda d, t, s: say(0.05 + 0.75 * d / t, f"Downloading prices {d}/{t} ({s})"),
        )
        if res["failed"]:
            warnings.append(f"No price data from TradingView for: {', '.join(res['failed'])}")
        events = res.get("events", [])
        say(0.81, "Downloading the dollar rate, interest rates and inflation…")
        try:
            missed = macro.update(conn)
        except Exception as exc:  # the prediction model uses the last values it has
            missed = [str(exc)]
        if missed:
            warnings.append(f"Egypt data not updated (the model uses the last values): {', '.join(missed)}")
        try:
            dividends.update(conn)
        except Exception as exc:  # the dividend pages show what was downloaded before
            warnings.append(f"Dividend data not updated ({type(exc).__name__})")
        say(0.815, "Downloading news, dividends and bonus shares…")
        try:
            first = list(db.latest_scan(conn)[1].get("symbol", []))
            try:        # on your Mac, the stocks you hold come first too
                first = [r[0] for r in conn.execute("SELECT symbol FROM trades WHERE status = 'open'")] + first
            except sqlite3.OperationalError:
                pass
            got = news.update(conn, first=first,
                              progress=lambda msg: say(0.815, msg))
            if got["failed"]:
                warnings.append(f"Some news sources didn't answer (the others were read): {', '.join(got['failed'])}")
        except Exception as exc:  # the news pages show what was downloaded before
            warnings.append(f"News not updated ({type(exc).__name__})")

    say(0.82, "Calculating indicators…")
    stocks = universe.stock_table(conn, cfg.get("egx33_extra"))
    index_ind, ind = load_indicators(conn, list(stocks.index))
    scan_ts = index_ind.index[-1]
    scan_date = str(scan_ts.date())
    idx_row = index_ind.iloc[-1]
    risk_off = strategy.is_risk_off(idx_row)
    threshold = strategy.buy_threshold(cfg, risk_off)

    say(0.88, "Scoring stocks…")
    rows = {}
    for sym, frame in ind.items():
        if frame.index[-1] != scan_ts:
            continue  # didn't trade on the scan date
        sf = strategy.signal_frame(frame, cfg)
        rows[sym] = (frame.iloc[-1], sf.iloc[-1], prices.sanity_flags(frame, scan_ts))
    eligible_ret = pd.Series({s: r[0]["ret63"] for s, r in rows.items() if r[1]["eligible"] and not r[2]})
    ranks = strategy.rs_rank(eligible_ret)

    buys, watches = [], []
    for sym, (ir, sr, flags) in rows.items():
        if not sr["eligible"] or flags or not sr["trend_ok"]:
            continue
        info = stocks.loc[sym].to_dict()
        rank_pct = float(ranks.get(sym, 0.0))
        sc = float(strategy.score(sr["base_score"], rank_pct))
        item = {
            "symbol": sym, "sector": info.get("sector", "Other"), "score": round(sc, 1), "setup": sr["setup"] or "",
            "close": float(ir["close"]), "entry_high": float(sr["entry_high"]), "entry_limit": float(sr["entry_high"]),
            "stop": float(sr["stop"]), "target": float(sr["target"]), "atr": float(ir["atr14"]),
            "avg_value": float(ir["value_avg20"]), "reasons": strategy.explain(ir, sr, rank_pct),
        }
        if sr["any_setup"] and sc >= threshold:
            buys.append({**item, "action": "BUY"})
        elif sc >= cfg["watch_score"]:
            watches.append({**item, "action": "WATCH"})
    buys.sort(key=lambda r: -r["score"])
    watches.sort(key=lambda r: -r["score"])
    watches = watches[:25]

    for r in buys + watches:
        r.update(shares=0, amount=0.0, risk_egp=0.0, size_note="")   # sized for each person when they look
    db.save_scan(conn, scan_date, buys + watches)

    say(0.94, "Updating the prediction model's numbers…")
    try:
        predict.resolve(conn, cfg)          # what happened to earlier predictions
        predict.predict_latest(conn, cfg)   # nothing to do until you train the model on the Predict page
    except Exception as exc:
        warnings.append(f"Prediction model skipped this time ({exc})")

    say(0.96, "Updating paper trading…")
    n_accounts = 0
    for acct_conn, acct_cfg in (accounts() if accounts else [(conn, cfg)]):
        try:
            process_account(acct_conn, acct_cfg, ind, scan_ts, buys, stocks, risk_off)
            n_accounts += 1
        except Exception as exc:  # one person's paper account must not stop everyone else's
            warnings.append(f"A paper account couldn't be updated ({exc})")

    market = {
        "date": scan_date,
        "egx30_close": float(idx_row["close"]),
        "egx30_change": float(index_ind["close"].pct_change().iloc[-1]),
        "egx30_ema50": float(idx_row["ema50"]),
        "risk_off": risk_off,
        "buy_threshold": threshold,
        "buys": len(buys),
        "watches": len(watches),
        "scanned": len(rows),
        "eligible": int(len(eligible_ret)),
        "warnings": warnings,
        "accounts": n_accounts,
        "price_events": events,
        "finished": datetime.now().isoformat(timespec="seconds"),
    }
    db.set_meta(conn, "market", json.dumps(market))
    db.set_meta(conn, "scan_data_date", scan_date)
    say(1.0, "Done")
    return market
