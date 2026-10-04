"""Daily scan: refresh data → indicators → signals → sizing → save; then advance paper trading."""
from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, time, timedelta
from typing import Callable, Iterable
from zoneinfo import ZoneInfo

import pandas as pd

from . import corporate, db, levels, portfolio, predict, risk, strategy
from .data import dividends, macro, news, prices, shariah, universe
from .indicators import add_indicators

CAIRO = ZoneInfo("Africa/Cairo")
DATA_READY = time(15, 30)       # EGX closes ~14:30 Cairo; give data providers an hour
TRADING_WEEKDAYS = {6, 0, 1, 2, 3}  # Sunday–Thursday
PRICES_FAILING = 0.25           # the price download counts as broken when over a quarter of the stocks got nothing


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


SESSION = (time(10, 15), time(14, 45))   # EGX trades 10:00–14:30 Cairo; prices come about 15 minutes late


def session_scan_due(conn: sqlite3.Connection, now: datetime | None = None,
                     every: timedelta = timedelta(minutes=25)) -> bool:
    """During a session, a scan of the live prices every half hour (the site's runs ask about every 30 minutes). It
    isn't final (scan_is_final), so it's scanned again after the close and Telegram waits for that one."""
    now = now or datetime.now(CAIRO)
    if now.weekday() not in TRADING_WEEKDAYS or not SESSION[0] <= now.time() <= SESSION[1]:
        return False
    finished = json.loads(db.get_meta(conn, "market") or "{}").get("finished")
    return not finished or now - datetime.fromisoformat(finished).astimezone(CAIRO) >= every


def scan_is_stale(conn: sqlite3.Connection, retry: timedelta = timedelta(hours=2)) -> bool:
    """Is a newer close due than the last scan? A try that found no new close waits `retry` before the next one."""
    data_date = db.get_meta(conn, "scan_data_date")
    expected = expected_session_date().isoformat()
    if data_date and (data_date > expected or data_date == expected and scan_is_final(conn)):
        return False
    attempted = db.get_meta(conn, "scan_attempted")
    if attempted:
        tried = datetime.fromisoformat(attempted)
        # Only a try after this close's data was due counts: a scan during the session doesn't hold back the one after.
        due = datetime.combine(date.fromisoformat(expected), DATA_READY, CAIRO).astimezone().replace(tzinfo=None)
        if tried >= due and tried > datetime.now() - retry:
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
            frames[s]["div"] = dividends.per_share(conn, s, frames[s]["close"])   # paper trades are paid it
    return index_ind, frames


def _symbols_to_update(conn: sqlite3.Connection) -> list[str]:
    week_ago = (date.today() - timedelta(days=7)).isoformat()
    rows = conn.execute("SELECT symbol, price_missing_since FROM stocks ORDER BY symbol").fetchall()
    return [r["symbol"] for r in rows if not r["price_missing_since"] or r["price_missing_since"] < week_ago]


def history_step(conn: sqlite3.Connection, checked: list[str], budget_s: float = dividends.HISTORY_BUDGET_S) -> list[str]:
    """A few more stocks' dividend history (data/dividends.update_history). Returns the failed source, if it did."""
    name = "Dividend history (TradingView)"
    checked.append(name)
    try:
        res = dividends.update_history(conn, budget_s=budget_s)
    except Exception:
        return [name]
    return [name] if res["failed"] and not res["stocks"] else []


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
    checked, failed = [], []        # data sources tried and the ones that didn't work (app/health.py)

    say(0.02, "Checking Kashif Shariah data…")
    if shariah.needs_refresh(conn):
        checked.append("Kashif (Shariah data)")
        try:
            shariah.refresh_kashif(conn)
        except Exception as exc:
            warnings.append(f"Kashif refresh failed, using cached Shariah data ({exc})")
            failed.append(checked[-1])
    universe.ensure_seeded(conn)

    if update_data and universe.needs_tv_refresh(conn):     # weekly: the stocks Kashif doesn't list
        checked.append("TradingView stock list")
        try:
            universe.refresh_tradingview(conn)
        except Exception as exc:
            warnings.append(f"TradingView's stock list not read ({type(exc).__name__})")
            failed.append(checked[-1])

    if update_data:
        syms = _symbols_to_update(conn) + [prices.INDEX_SYMBOL]
        res = prices.update_prices(
            conn, syms, years=cfg["history_years"], aliases=cfg.get("symbol_aliases"),
            progress=lambda d, t, s: say(0.05 + 0.75 * d / t, f"Downloading prices {d}/{t} ({s})"),
        )
        if res["failed"]:
            warnings.append(f"No price data from TradingView for: {', '.join(res['failed'])}")
        checked.append("TradingView prices")
        if prices.INDEX_SYMBOL in res["failed"] or len(res["failed"]) > PRICES_FAILING * len(syms):
            failed.append(checked[-1])
        events = res.get("events", [])
        say(0.805, "Downloading hourly prices for the 1-hour and 4-hour charts…")
        checked.append("TradingView hourly prices")
        try:
            hourly = prices.update_intraday(conn, [s for s in syms if s != prices.INDEX_SYMBOL],
                                            aliases=cfg.get("symbol_aliases"))
            if hourly["failed"] and len(hourly["failed"]) > PRICES_FAILING * len(syms):
                failed.append(checked[-1])
        except Exception as exc:  # only the hourly charts need them: they show what was downloaded before
            warnings.append(f"Hourly prices not updated ({type(exc).__name__})")
            failed.append(checked[-1])
        say(0.81, "Downloading the dollar rate, interest rates and inflation…")
        try:
            missed = macro.update(conn)
        except Exception as exc:  # the prediction model uses the last values it has
            missed = [str(exc)]
        if missed:
            warnings.append(f"Egypt data not updated (the model uses the last values): {', '.join(missed)}")
        checked += ["Egypt data (TradingView)", "Dividends (TradingView)"]
        failed += ["Egypt data (TradingView)"] if missed else []
        try:
            dividends.update(conn)
        except Exception as exc:  # the dividend pages show what was downloaded before
            warnings.append(f"Dividend data not updated ({type(exc).__name__})")
            failed.append("Dividends (TradingView)")
        say(0.812, "Reading past dividends from TradingView…")
        failed += history_step(conn, checked)
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
            checked += got["tried"]
            failed += got["failed"]
        except Exception as exc:  # the news pages show what was downloaded before
            warnings.append(f"News not updated ({type(exc).__name__})")
            checked.append("News")
            failed.append("News")

    say(0.82, "Calculating indicators…")
    stocks = universe.stock_table(conn, cfg.get("egx33_extra"))
    index_ind, ind = load_indicators(conn, list(stocks.index))
    scan_ts = index_ind.index[-1]
    scan_date = str(scan_ts.date())
    idx_row = index_ind.iloc[-1]
    risk_off = strategy.is_risk_off(idx_row)
    threshold = strategy.buy_threshold(cfg, risk_off)

    # The prediction model first: its rank orders the BUYs and its best picks are BUYs too (config model_picks).
    say(0.85, "Updating the prediction model's numbers…")
    checked.append("Prediction model")
    try:
        predict.resolve(conn, cfg)          # what happened to earlier predictions
        predict.predict_latest(conn, cfg)   # nothing to do until you train the model on the Predict page
    except Exception as exc:
        warnings.append(f"Prediction model skipped this time ({exc})")
        failed.append("Prediction model")
    model = predict.ranks_for(conn, scan_date) if db.get_meta(conn, "prediction_date") == scan_date else {}
    model_health = predict.health(conn)["status"] if model else "none"

    say(0.88, "Scoring stocks…")
    rows, plans = {}, {}
    for sym, frame in ind.items():
        if frame.index[-1] != scan_ts:
            continue  # didn't trade on the scan date
        sf = levels.apply(frame, strategy.signal_frame(frame, cfg), cfg)   # the chart's stop and target
        rows[sym] = (frame.iloc[-1], sf.iloc[-1], prices.sanity_flags(frame, scan_ts))
        if cfg.get("levels_mode") == "chart" and sf.iloc[-1]["trend_ok"]:
            plans[sym] = levels.plan_at(frame, cfg)
    eligible_ret = pd.Series({s: r[0]["ret63"] for s, r in rows.items() if r[1]["eligible"] and not r[2]})
    ranks = strategy.rs_rank(eligible_ret)

    def signal(sym: str) -> dict:
        ir, sr, _ = rows[sym]
        rank_pct = float(ranks.get(sym, 0.0))
        m = model.get(sym)
        return {
            "symbol": sym, "sector": stocks.loc[sym].get("sector", "Other"),
            "score": round(float(strategy.score(sr["base_score"], rank_pct)), 1), "setup": sr["setup"] or "",
            "close": float(ir["close"]), "entry_high": float(sr["entry_high"]), "entry_limit": float(sr["entry_high"]),
            "stop": float(sr["stop"]), "target": float(sr["target"]), "atr": float(ir["atr14"]),
            "avg_value": float(ir["value_avg20"]), "reasons": strategy.explain(ir, sr, rank_pct) + levels.describe(plans.get(sym)),
            "priority": round(m["pct"], 4) if m else None, "source": "rules",
        }

    buys, watches = [], []
    for sym, (ir, sr, flags) in rows.items():
        if not sr["eligible"] or flags or not sr["trend_ok"]:
            continue
        item = signal(sym)
        if sr["any_setup"] and item["score"] >= threshold:
            buys.append({**item, "action": "BUY"})
        elif item["score"] >= cfg["watch_score"]:
            watches.append({**item, "action": "WATCH"})
    # The model's own BUYs: its best-ranked stocks that pass the same liquidity and uptrend checks, none while EGX30
    # is under its 50-day average, and none while its live results show no edge (predict.health).
    n_picks = int(cfg.get("model_picks", 0) or 0) if model_health != "bad" else 0
    added = 0
    if n_picks and not risk_off:
        have = {b["symbol"] for b in buys}
        for sym, m in sorted(model.items(), key=lambda kv: kv[1]["rank"])[:n_picks]:
            if sym in have or sym not in rows or rows[sym][2] or not rows[sym][1]["eligible"] \
                    or not rows[sym][1]["trend_ok"]:
                continue
            item = signal(sym)
            item.update(action="BUY", source="model", setup="Model pick",
                        reasons=[f"The prediction model's #{m['rank']} of {m['of']} stocks today (its top {n_picks} "
                                 "are BUYs when they pass the liquidity and uptrend checks)"] + item["reasons"])
            buys.append(item)
            watches = [w for w in watches if w["symbol"] != sym]
            added += 1
    order = lambda r: (-(r["priority"] if r["priority"] is not None else -1.0), -r["score"])   # noqa: E731
    buys.sort(key=order)       # who gets money first: the model's rank, then the rules' score
    watches.sort(key=lambda r: -r["score"])
    watches = watches[:25]

    for r in buys + watches:
        r.update(shares=0, amount=0.0, risk_egp=0.0, size_note="")   # sized for each person when they look
    db.save_scan(conn, scan_date, buys + watches)

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
        "model_picks": added,
        "model_health": model_health,
        "watches": len(watches),
        "scanned": len(rows),
        "eligible": int(len(eligible_ret)),
        "warnings": warnings,
        "checked": checked,
        "failed": failed,
        "accounts": n_accounts,
        "price_events": events,
        "finished": datetime.now().isoformat(timespec="seconds"),
    }
    db.set_meta(conn, "market", json.dumps(market))
    db.set_meta(conn, "scan_data_date", scan_date)
    say(1.0, "Done")
    return market
