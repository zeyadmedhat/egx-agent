"""Data for each dashboard page as JSON-ready dicts. The browser does all the drawing."""
from __future__ import annotations

import json
import math
import sqlite3
import threading
from datetime import date, datetime

import numpy as np
import pandas as pd

from egx_agent import (ai_forecast, breadth, config, corporate, db, holidays, levels, mood, portfolio, predict, ranges,
                       record, risk, scan, strategy)
from egx_agent.data import dividends, flows, fundamentals, macro, news, prices, shariah, universe
from egx_agent.indicators import add_indicators

STATUS_ORDER = {"ADJUST": 0, "EXIT": 1, "BOUNCE": 2, "REVIEW": 3, "TIGHTEN STOP": 4, "HOLD": 5, "NO DATA": 6}
ACTION_STATUSES = ("ADJUST", "EXIT", "BOUNCE", "REVIEW", "TIGHTEN STOP")
SELL_REASONS = ["Stop-loss", "Target reached", "Time limit", "Trend break", "Taking partial profit",
                "Other / my decision"]
INFO_FIELDS = ("symbol", "name_ar", "sector", "egx30", "egx70", "egx33", "kashif_status", "kashif_label", "purity",
               "purification_pct", "statements_date", "kashif_updated", "price_note")
SERIES_COLS = ("open", "high", "low", "close", "volume", "ema20", "ema50", "rsi14", "macd", "macd_signal", "macd_hist")


# ------------------------------------------------------------------ JSON helpers

def clean(x):
    """Make pandas/numpy values JSON-safe: NaN/inf → null, numpy scalars → Python, dates → ISO strings."""
    if x is None or x is pd.NaT:
        return None
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple, set)):
        return [clean(v) for v in x]
    if isinstance(x, np.ndarray):
        return [clean(v) for v in x.tolist()]
    if isinstance(x, (bool, np.bool_)):
        return bool(x)
    if isinstance(x, np.integer):
        return int(x)
    if isinstance(x, (float, np.floating)):
        v = float(x)
        return v if math.isfinite(v) else None
    if isinstance(x, pd.Timestamp):
        return x.date().isoformat() if x == x.normalize() else x.isoformat()
    if isinstance(x, (datetime, date)):
        return x.isoformat()
    if x is pd.NA:
        return None
    return x


def records(df: pd.DataFrame, cols: list[str] | None = None) -> list[dict]:
    if df is None or df.empty:
        return []
    if cols:
        df = df[[c for c in cols if c in df.columns]]
    return clean(df.astype(object).where(df.notna(), None).to_dict("records"))


def column(s: pd.Series, digits: int = 4) -> list:
    return clean(s.round(digits).astype(object).where(s.notna(), None).tolist())


sessions_after = holidays.sessions_after     # date n EGX sessions after a day, the announced holidays skipped


def px(v) -> str:
    """A price the way the dashboard shows it: 3 decimals under 10 EGP, else 2."""
    if v is None or not math.isfinite(v):
        return "–"
    return f"{v:,.3f}" if abs(v) < 10 else f"{v:,.2f}"


def nice_date(day: str, weekday: bool = False) -> str:
    d = pd.Timestamp(day)
    return f"{d:%a} {d.day} {d:%b}" if weekday else f"{d.day} {d:%b}"


# ------------------------------------------------------------------ caching

class Cache:
    """Indicator frames and other heavy lookups, dropped whenever a scan or Kashif refresh changes the data."""

    def __init__(self):
        self._lock = threading.Lock()
        self._version: str | None = None
        self._store: dict = {}

    def get(self, version: str, key, build):
        with self._lock:
            if version != self._version:
                self._store, self._version = {}, version
            if key in self._store:
                return self._store[key]
        value = build()
        with self._lock:
            if version == self._version:
                self._store[key] = value
        return value

    def clear(self) -> None:
        with self._lock:
            self._store, self._version = {}, None


def market_info(conn: sqlite3.Connection) -> dict:
    raw = db.get_meta(conn, "market")
    return json.loads(raw) if raw else {}


def current_scan(conn: sqlite3.Connection) -> tuple[str | None, pd.DataFrame]:
    """The latest scan's signals. A scan that found nothing leaves no rows, so older rows must not count."""
    day = db.get_meta(conn, "scan_data_date")
    scan_date, df = db.latest_scan(conn)
    if day and scan_date != day:
        return day, df.iloc[0:0]
    return scan_date or day, df


def data_version(conn: sqlite3.Connection) -> str:
    finished = market_info(conn).get("finished")
    return f"{db.get_meta(conn, 'scan_data_date')}|{db.get_meta(conn, 'kashif_refreshed')}|{finished}"


class Data:
    """Everything one request needs: the connection, settings and the shared cache."""

    def __init__(self, conn: sqlite3.Connection, cfg: dict, cache: Cache, is_admin: bool = True,
                 multi_user: bool = False):
        self.conn, self.cfg, self.cache = conn, cfg, cache
        self.is_admin, self.multi_user = is_admin, multi_user
        self.version = data_version(conn)
        self._table: pd.DataFrame | None = None
        self._signals: tuple[str | None, list[dict]] | None = None

    @property
    def table(self) -> pd.DataFrame:
        if self._table is None:
            self._table = universe.stock_table(self.conn, self.cfg.get("egx33_extra"))
        return self._table

    def prices(self, symbol: str) -> pd.DataFrame:
        return self.cache.get(self.version, ("prices", symbol), lambda: db.load_prices(self.conn, symbol))

    def indicators(self, symbol: str) -> pd.DataFrame:
        def build():
            df = self.prices(symbol)
            if df.empty:
                return df
            if symbol == prices.INDEX_SYMBOL:
                return add_indicators(df)
            index_df = self.prices(prices.INDEX_SYMBOL)
            ind = add_indicators(df, index_df["close"] if len(index_df) else None)
            ind["div"] = dividends.per_share(self.conn, symbol, ind["close"])   # the exit rules move stops for it
            return ind
        return self.cache.get(self.version, ("ind", symbol), build)

    def last_two(self) -> dict[str, dict]:
        def build():
            rows = self.conn.execute(
                """SELECT symbol, date, close FROM (
                       SELECT symbol, date, close,
                              ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn FROM prices)
                   WHERE rn <= 2 ORDER BY symbol, date DESC"""
            ).fetchall()
            out: dict[str, dict] = {}
            for r in rows:
                d = out.setdefault(r["symbol"], {"close": float(r["close"]), "date": r["date"], "prev": None})
                if d["date"] != r["date"]:
                    d["prev"] = float(r["close"])
            return out
        return self.cache.get(self.version, "last_two", build)

    def closes(self) -> dict[str, float]:
        return {s: v["close"] for s, v in self.last_two().items()}

    def info(self, symbol: str) -> dict:
        extra = {s.strip().upper() for s in (self.cfg.get("egx33_extra") or [])}
        if symbol in self.table.index:
            row = self.table.loc[symbol]
            out = {k: row.get(k) for k in INFO_FIELDS}
        else:
            out = {"symbol": symbol}
        out["egx33_manual"] = symbol in extra
        out["kashif_url"] = shariah.stock_url(symbol)
        return clean(out)


# ------------------------------------------------------------------ pages

def stocks_list(d: Data) -> list[dict]:
    last = d.last_two()
    out = []
    for sym in d.table.index:
        info = d.info(sym)
        lt = last.get(sym)
        info["close"] = lt["close"] if lt else None
        info["change"] = lt["close"] / lt["prev"] - 1 if lt and lt["prev"] else None
        info["last_date"] = lt["date"] if lt else None
        out.append(info)
    return out


def signals(d: Data) -> tuple[str | None, list[dict]]:
    """The latest scan's signals for this person: their Shariah filter applied and BUYs sized for their account.

    The scan saves one set of signals for everyone. A BUY that doesn't pass your Shariah filter shows as WATCH.
    """
    if d._signals is not None:
        return d._signals
    scan_date, df = current_scan(d.conn)
    buys, other = [], []
    for r in records(df):
        info = d.table.loc[r["symbol"]].to_dict() if r["symbol"] in d.table.index else {}
        r["sector"] = info.get("sector") or "Other"
        if r["action"] == "BUY" and not shariah.passes_filter(info, d.cfg["shariah_filter"]):
            r.update(action="WATCH", size_note="doesn't pass your Shariah filter")
        if r["action"] == "BUY":
            buys.append(r)
        else:
            r.update(shares=0, amount=0.0, risk_egp=0.0,
                     size_note=r.get("size_note") or "watch only: no entry signal yet")
            other.append(r)
    if buys:
        real = portfolio.account_summary(d.conn, "real", d.cfg, d.closes())
        buys = risk.allocate(sorted(buys, key=signal_order), real["equity"], real["cash"],
                             portfolio.positions_for_allocation(d.conn, "real", ("open",)), d.cfg,
                             bool(market_info(d.conn).get("risk_off")))
    d._signals = scan_date, sorted(buys + other, key=lambda r: (r["action"] != "BUY", *signal_order(r)))
    return d._signals


def signal_order(r: dict) -> tuple:
    """Who gets money first: the prediction model's rank that day (scans.priority), then the rules' score.
    Tested: the same BUYs in the model's order made 20% a year against 15% (2016–2026, its test years only)."""
    p = r.get("priority")
    return -(p if p is not None else -1.0), -(r.get("score") or 0)


def adjust_reason(ev: dict) -> str:
    """Why a position waits for its new share count (local/api.js says the same)."""
    if ev.get("rights"):
        return (f"Rights issue from {nice_date(ev['ex_date'])}: past prices ÷ {ev['factor']:.4g}. Once you've "
                "subscribed or sold your rights, enter the shares you hold now so the stop and P&L stay right.")
    return (f"Bonus shares or split from {nice_date(ev['ex_date'])}: {ev['describe']}. "
            "Enter the shares you hold now so the stop and P&L stay right.")


def open_positions(d: Data, symbol: str | None = None) -> list[dict]:
    pending = corporate.pending(d.conn, "real")
    dividends = corporate.dividends_by_trade(d.conn, "real")
    # a big loss's averaging-down rule: only when the stock earns a buy on its own (a BUY signal or a top-10% rating)
    buys = {x["symbol"] for x in signals(d)[1] if x["action"] == "BUY"}
    preds = predictions(d)["by_symbol"]
    out = []
    for _, r in portfolio.trades_df(d.conn, "real", ("open",)).iterrows():
        if symbol and r.symbol != symbol:
            continue
        ind = d.indicators(r.symbol)
        ev = pending.get(int(r.id))
        factor = 1.0
        if ev:
            # Past prices were re-based after this buy, so the exit rules can't be checked until the share
            # count is updated. Value the old share count at the new price × the ratio meanwhile.
            factor = ev["factor"]
            last = float(ind["close"].iloc[-1]) if len(ind) else float(r.entry_price) / factor
            stt = {"status": "ADJUST", "stop": None, "days_held": int((ind.index >= pd.Timestamp(r.entry_date)).sum()),
                   "reason": adjust_reason(ev)}
        else:
            stt = portfolio.real_status(r, ind, d.cfg)
            last = stt.get("last_close") or float(r.entry_price)
        fees = float(r.fees or 0)
        div = dividends.get(int(r.id), 0.0)
        fills = records(portfolio.fills_df(d.conn, int(r.id)), ["id", "date", "side", "shares", "price", "fees", "note"])
        for x in records(corporate.dividends_df(d.conn, int(r.id))):
            fills.append({"id": None, "dividend_id": x["id"], "date": x["date"], "side": "dividend", "shares": x["shares"],
                          "price": x["amount"] / x["shares"] if x["shares"] else None, "fees": 0.0, "amount": x["amount"],
                          "note": x["note"] or ""})
        fills.sort(key=lambda f: (f["date"], f["side"] == "dividend"))
        worth = last * factor  # per old share
        out.append({
            "id": int(r.id), "symbol": r.symbol, "info": d.info(r.symbol), "status": stt["status"],
            "reason": stt["reason"], "first_buy": r.entry_date, "avg_price": float(r.entry_price),
            "shares": int(r.shares), "last": last, "value": worth * int(r.shares),
            # like your broker: against what you paid with the buy fees; selling fees count once you sell
            "pnl_pct": ((worth - r.entry_price) * r.shares - fees) / (r.entry_price * r.shares + fees),
            "pnl": (worth - r.entry_price) * r.shares - fees + div,
            "stop": stt["stop"], "prev_stop": stt.get("prev_stop"), "initial_stop": float(r.initial_stop),
            "bounce_level": stt.get("bounce_level"), "bounce_by": stt.get("bounce_by"),
            "buy_signal": r.symbol in buys, "top_pick": bool((preds.get(r.symbol) or {}).get("top10")),
            # how far under its 3-month high: after a 50%+ fall even the model's top ratings did worse (2026-10)
            "from_high": last / float(ind["close"].tail(60).max()) - 1 if len(ind) else None,
            "target": float(r.target), "day": int(stt["days_held"]), "stops_mine": d.cfg.get("stop_moves") == "mine",
            "sell_by": sessions_after(r.entry_date, d.cfg["max_hold_days"] - 1),
            "fees": fees, "dividends": div, "notes": r.notes or "", "fills": fills, "adjust": ev,
            "n_buys": sum(1 for f in fills if f["side"] == "buy") or 1,
        })
    out.sort(key=lambda p: (STATUS_ORDER.get(p["status"], 9), p["symbol"]))
    return clean(out)


def book_positions(d: Data, book: dict) -> list[dict]:
    """A website friend's open positions, from the record their browser keeps (synced through the Telegram bot), with
    what the exit rules say at the last close: what open_positions gives for yours, as the site works it out
    (app/static/js/local/api.js). Enough for orders(): the evening message tells them what to do."""
    done = {(a.get("event_id"), a.get("trade_id")) for a in book.get("adjustments") or [] if isinstance(a, dict)}
    events = corporate.events(d.conn)
    out = []
    for t in book.get("trades") or []:
        if not isinstance(t, dict) or t.get("account") != "real" or t.get("status") != "open":
            continue
        try:
            sym, shares, entry = str(t["symbol"]), int(t["shares"]), float(t["entry_price"])
            row = pd.Series({**t, "initial_stop": float(t["initial_stop"]), "target": float(t["target"])})
        except (KeyError, TypeError, ValueError):
            continue            # an incomplete record: the site shows it, the message skips it
        ind = d.indicators(sym)
        since = str(t.get("entry_date") or t.get("signal_date") or "")
        ev = next((e for e in events if e["symbol"] == sym and since < e["ex_date"] and (e["id"], t.get("id")) not in done),
                  None)
        if ev:
            ev = {**ev, "describe": corporate.what(ev["factor"], ev["rights"])}
            last = float(ind["close"].iloc[-1]) if len(ind) else entry / ev["factor"]
            stt = {"status": "ADJUST", "stop": None, "days_held": int((ind.index >= pd.Timestamp(since)).sum()),
                   "reason": adjust_reason(ev)}
        else:
            stt = portfolio.real_status(row, ind, d.cfg)
            last = stt.get("last_close") or entry
        out.append({"id": t.get("id"), "symbol": sym, "status": stt["status"], "reason": stt["reason"], "shares": shares,
                    "avg_price": entry, "last": last, "stop": stt["stop"], "prev_stop": stt.get("prev_stop"),
                    "target": float(row["target"]), "day": int(stt["days_held"]), "adjust": ev})
    out.sort(key=lambda p: (STATUS_ORDER.get(p["status"], 9), p["symbol"]))
    return clean(out)


def status(d: Data) -> dict:
    m = market_info(d.conn)
    positions = open_positions(d)
    _, sig = signals(d)
    mine = {"buys": sum(1 for r in sig if r["action"] == "BUY")}
    return {
        "version": d.version,
        "market": {**{k: m.get(k) for k in ("date", "egx30_close", "egx30_change", "egx30_ema50", "risk_off", "weak_breadth",
                                            "watches", "finished")}, **mine} if m else None,
        "alerts": sum(1 for p in positions if p["status"] in ACTION_STATUSES),
        "positions": len(positions),
        "holidays": {h["date"]: h["title"] for h in holidays.upcoming()},
    }


def best_entry(d: Data, sym: str) -> dict | None:
    """The best way in besides today's price (the stock page's Where to buy it): the dip or breakout (levels.entries)
    with the most reward for the risk, or None."""
    ind = d.indicators(sym)
    if len(ind) < 60:
        return None
    ents = levels.entries(ind, d.cfg, levels.plan_at(ind, d.cfg))
    return max(ents, key=lambda e: e["rr"]) if ents else None


def today(d: Data) -> dict:
    cfg = d.cfg
    m = market_info(d.conn)
    scan_date, rows = signals(d)
    buys, watch = [], []
    preds = predictions(d)
    warn = cautions_map(d)
    firms = company_brief(d)
    for r in [dict(x) for x in rows]:
        r["info"] = d.info(r["symbol"])
        r["pred"] = preds["by_symbol"].get(r["symbol"])
        r["cautions"] = warn.get(r["symbol"], [])
        r["co"] = firms.get(r["symbol"])
        if r["action"] == "BUY":
            r["sell_by"] = sessions_after(scan_date, cfg["max_hold_days"])
            r["range"] = range_view(d, r["symbol"])     # the chance its target and stop trade within a month
            buys.append(r)
        elif shariah.passes_filter(r["info"], cfg["shariah_filter"]):   # close to a BUY: only what your filter allows
            px = d.prices(r["symbol"])
            trigger = float(px["high"].tail(20).max()) if len(px) else None
            r["trigger"] = trigger
            r["to_trigger"] = trigger / r["close"] - 1 if trigger and r["close"] else None
            r["best_in"] = best_entry(d, r["symbol"])
            watch.append(r)
    idx = d.indicators(prices.INDEX_SYMBOL)
    spark = None
    if len(idx):
        tail = idx.tail(130)
        spark = {"time": [str(t.date()) for t in tail.index], "close": column(tail["close"], 2),
                 "ema50": column(tail["ema50"], 2)}
    paper = portfolio.account_summary(d.conn, "paper", cfg, d.closes())
    positions = [{**p, "cautions": warn.get(p["symbol"], [])} for p in open_positions(d)]
    b = breadth_data(d)
    paper_scan = db.get_user_meta(d.conn, "paper_last_scan")
    return clean({
        "market": {**m, "buys": len(buys)} if m else None, "scan_date": scan_date, "buys": buys, "watch": watch,
        "positions": positions, "spark": spark, "orders": orders(d, positions),
        "breadth": {**{k: b[k] for k in ("above50", "stocks", "advancers", "decliners")},
                    **breadth.verdict(b, m.get("egx30_off", m.get("risk_off")) if m else None)} if b else None,
        "mood": mood_brief(d),
        "paper": {"equity": paper["equity"], "return_pct": paper["return_pct"], "open": paper["open_count"],
                  "last_scan": json.loads(paper_scan) if paper_scan else None},
        "model": {k: preds[k] for k in ("base", "count", "date")} if preds["by_symbol"] else None,
        "cfg": {**{k: cfg[k] for k in ("max_hold_days", "review_day", "riskoff_block_buys", "auto_paper", "buy_score",
                                       "shariah_filter")}, "fee_pct_per_side": config.fee_pct(cfg)},
        "record": signal_record(d), "odds": record.public_odds(record.stored_odds(d.conn)),
    })


def signal_record(d: Data) -> dict:
    """Every BUY the agent published and how it went (egx_agent/record.py), the same for everyone."""
    return d.cache.get(d.version, ("record",), lambda: record.signal_record(d.conn, d.cfg, d.indicators))


def corporate_history(conn: sqlite3.Connection, sym: str, close: float) -> dict:
    """A stock's cash dividends (as far back as the agent has seen them), its yield, and its bonus shares/splits."""
    today = date.today().isoformat()
    cash = [{"ex_date": r["ex_date"], "pay_date": r["pay_date"], "amount": r["amount"],
             "pct": r["amount"] / close if close else None, "upcoming": r["ex_date"] >= today}
            for r in conn.execute("SELECT ex_date, pay_date, amount FROM cash_dividends WHERE symbol=? "
                                  "ORDER BY ex_date DESC", (sym,))]
    y = conn.execute("SELECT yield_pct FROM dividend_yield WHERE symbol=?", (sym,)).fetchone()
    bonus = [{"ex_date": r["ex_date"], "factor": r["factor"], "text": corporate.describe(r["factor"])}
             for r in conn.execute("SELECT ex_date, factor FROM price_events WHERE symbol=? ORDER BY ex_date DESC",
                                   (sym,))]
    five_years = (date.today() - pd.Timedelta(days=5 * 365)).isoformat()
    actions = [a for a in news.actions(conn, sym, since=five_years, kinds=EVENT_KINDS)]
    names = (sym, prices.TV_ALIASES.get(sym, sym))
    e = conn.execute("SELECT next_date, last_date FROM earnings WHERE symbol IN (?,?)", names).fetchone()
    results = {"next": e["next_date"] if e["next_date"] and e["next_date"] > today else None,
               "last": e["last_date"] or None} if e else None
    return {"dividends": cash, "yield": y["yield_pct"] / 100 if y and y["yield_pct"] is not None else None,
            "bonus": bonus, "actions": actions, "results": results}


EVENT_KINDS = ("dividend", "bonus", "split", "rights", "placement", "treasury_buy", "consolidation", "reduction")
HOLD_CALENDAR_DAYS = 30       # about 20 sessions: the longest a trade is held


def cautions_map(d: Data) -> dict[str, list[dict]]:
    """For every stock with something a buyer or holder should know now (an ex-dividend date or results within a
    month, bonus shares or a rights issue coming, bad news this week): its cautions (data/news.py). The same for
    everyone."""
    def build():
        today = db.get_meta(d.conn, "scan_data_date") or date.today().isoformat()
        nxt = {r["symbol"]: {"ex_date": r["ex_date"], "amount": r["amount"]} for r in d.conn.execute(
            "SELECT symbol, MIN(ex_date) AS ex_date, amount FROM cash_dividends WHERE ex_date > ? GROUP BY symbol",
            (today,))}
        results = dividends.next_results(d.conn, today)
        since = (date.fromisoformat(today) - pd.Timedelta(days=7)).isoformat()
        maybe = {r[0] for r in d.conn.execute(
            "SELECT symbol FROM corp_actions WHERE effective > ? UNION SELECT symbol FROM news "
            "WHERE symbol != '' AND tone < 0 AND published >= ?", (today, since))} | set(nxt) | set(results)
        out = {}
        for sym in sorted(maybe & set(d.table.index)):
            c = news.cautions(d.conn, sym, today, HOLD_CALENDAR_DAYS, div=nxt.get(sym), results=results.get(sym))
            if c:
                out[sym] = c
        return out
    return d.cache.get(d.version, ("cautions",), build)


def news_feed(d: Data) -> dict:
    """The News page, the same for everyone: the last month's headlines from every source, the dividends, bonus
    shares and rights issues coming, and the ones announced lately. Your own stocks are marked where you look."""
    def build():
        today = date.today().isoformat()
        month_ago = (date.today() - pd.Timedelta(days=30)).isoformat()
        known = set(d.table.index)
        coming = [a for a in news.actions(d.conn, since=today, kinds=EVENT_KINDS)
                  if a["symbol"] in known and a["effective"]]
        announced = [a for a in news.actions(d.conn, kinds=EVENT_KINDS)[:400]
                     if a["symbol"] in known and a["announced"] >= month_ago and not (a["effective"] >= today)]
        items = [n for n in news.recent_news(d.conn, days=30) if not n["symbol"] or n["symbol"] in known]
        return clean({"today": today, "updated": db.get_meta(d.conn, "news_updated"), "items": items,
                      "coming": sorted(coming, key=lambda a: a["effective"]), "announced": announced,
                      "sources": news.SOURCES, "tags": list(news.TAGS)})
    return d.cache.get(d.version, ("news",), build)


def news_view(d: Data) -> dict:
    return {**news_feed(d), "held": sorted({p["symbol"] for p in open_positions(d)}), "watchlist": watchlist(d)}


def ai_record(d: Data) -> pd.DataFrame:
    """Every finished AI forecast with what happened (ai_forecast.record), once a build."""
    return d.cache.get(d.version, ("ai_record",), lambda: ai_forecast.record(d.conn))


def ai_grades(d: Data) -> dict:
    """How each model and their middle did on every stock, by sessions ahead: {"5": {"middle": grade, ...}}."""
    def build():
        rec = ai_record(d)
        return {str(k): {m: ai_forecast.grade(g) for m, g in rec[rec["step"] == k].groupby("model")}
                for k in ai_forecast.STEPS}
    return d.cache.get(d.version, ("ai_grades",), build)


AI_RESETS = ("rights", "bonus", "split", "consolidation")


def ai_view(d: Data, sym: str, close: pd.Series) -> dict | None:
    """The stock page's "What the AI models forecast": each model's latest 20-session path from the close it ran
    after, by 1, 5 and 20 sessions ahead: the middle and the spread of the models, how many point each way, how big the
    move is for this stock (score: 100 when all agree and the middle moves at least a usual amount), and how the
    middle's earlier forecasts here and on every stock did against what happened and against "no change"."""
    rows = d.conn.execute("SELECT model, made, path FROM ai_paths WHERE symbol=?", (sym,)).fetchall()
    close = pd.Series(close.to_numpy(float), index=[str(t.date()) for t in close.index])
    made = max((r["made"] for r in rows), default=None)
    if made is None or not (close.index <= made).any():
        return None
    paths = {r["model"]: json.loads(r["path"]) for r in rows if r["made"] == made}
    start_date = close.index[close.index <= made][-1]            # its last close then (made, unless it didn't trade)
    start = float(close[start_date])
    rec = ai_record(d)
    mine = rec[(rec["symbol"] == sym) & (rec["model"] == "middle")]
    earlier = pd.read_sql_query("SELECT made, p1, p5, p20 FROM ai_forecasts WHERE symbol=? AND made<?", d.conn,
                                params=(sym, made)).groupby("made").median().tail(8)
    grades = ai_grades(d)
    # bonus shares, a split or a rights issue going ex after the last close: that day the price is reset for the new
    # shares, which the models can't know (afterwards their forecasts move to the new prices: db.add_price_event)
    last = close.index[-1]
    resets = sorted((a for a in news.actions(d.conn, sym, since=last, kinds=AI_RESETS) if a["effective"] > last),
                    key=lambda a: a["effective"])
    steps = {}
    for k in ai_forecast.STEPS:
        vals = {m: p[k - 1] for m, p in paths.items()}
        mid = float(np.median(list(vals.values())))
        up = sum(v > start * 1.0001 for v in vals.values())      # saved to 5 digits: a hair isn't a move
        down = sum(v < start * 0.9999 for v in vals.values())
        moves = (close / close.shift(k) - 1).abs().tail(250).dropna()
        typical = float(moves.median()) if len(moves) >= 40 else None
        agree = max(0.0, 2 * max(up, down) / len(vals) - 1)     # all one way: 1; split evenly: 0
        size = min(1.0, abs(mid / start - 1) / typical) if typical else 0.0
        done = mine[mine["step"] == k].set_index("made")
        past = []
        for m, v in earlier[f"p{k}"].dropna().items():
            target = done["target"].get(m) or holidays.sessions_after(m, k)
            past.append({"made": m, "target": target, "start": _num(close[close.index <= m].iloc[-1]), "value": float(v),
                         "actual": _num(done["actual"].get(m))})
        target = holidays.sessions_after(made, k)
        reset = next(({"kind": a["kind"], "date": a["effective"]} for a in resets if a["effective"] <= target), None)
        steps[str(k)] = {"target": target, "reset": reset, "values": vals, "mid": mid,
                         "lo": min(vals.values()), "hi": max(vals.values()), "up": up, "down": down,
                         "typical": typical, "score": round(100 * agree * size),
                         "record": ai_forecast.grade(done.reset_index()), "all": grades.get(str(k), {}), "past": past}
    shown = close.tail(61)                     # 40 sessions before the start and any since
    return {"made": made, "start": start, "start_date": start_date, "models": [{"key": m, "name": n, "lab": lab}
                                                       for m, (n, lab) in ai_forecast.MODELS.items() if m in paths],
            "paths": paths, "steps": steps, "closes": {"time": list(shown.index), "close": column(shown)},
            "tested": ai_forecast.TESTED}


def range_view(d: Data, sym: str) -> dict | None:
    """The stock page's "How far it could move" (egx_agent/ranges.py, every stock once a build): its 5- and
    20-session ranges and price ladders, how its and every stock's ranges of the last year did, and the replay."""
    r = d.cache.get(d.version, ("ranges",), lambda: ranges.build(d.conn))
    mine = r["stocks"].get(sym)
    if not mine:
        return None
    # a rights issue, bonus shares or a split going ex inside a window resets the price that day: the range is in
    # today's prices, so the page says so instead of showing it (as the AI card; such windows aren't in the record)
    resets = sorted((a for a in news.actions(d.conn, sym, since=mine["made"], kinds=AI_RESETS) if a["effective"] > mine["made"]),
                    key=lambda a: a["effective"])
    steps = {k: {**s, "reset": next(({"kind": a["kind"], "date": a["effective"]} for a in resets
                                     if a["effective"] <= s["target"]), None)} for k, s in mine["steps"].items()}
    return {**mine, "steps": steps, "all": r["all"], "tested": ranges.TESTED}


def _num(v) -> float | None:
    return None if v is None or not np.isfinite(v) else float(v)


def stock_public(d: Data, symbol: str, cols: tuple[str, ...] = SERIES_COLS, tail: int | None = None) -> dict:
    """The parts of a stock's page that are the same for everyone: facts, chart, rule checklist, the model.

    The GitHub Pages site publishes exactly this (app/static_site.py) and adds your own parts in the browser.
    """
    cfg = d.cfg
    sym = symbol.upper()
    out: dict = {"symbol": sym, "info": d.info(sym), "known": sym in d.table.index,
                 "hold": {"max": cfg["max_hold_days"], "review": cfg["review_day"]}}
    ind = d.indicators(sym)
    if ind.empty:
        out.update(has_data=False, message=out["info"].get("price_note") or "No price data for this symbol yet.")
        return out
    last = ind.iloc[-1]
    prev = ind.iloc[-2] if len(ind) > 1 else last
    year = ind.tail(250)
    out["has_data"] = True
    out["stats"] = {
        "close": last.close, "change": last.close / prev.close - 1, "value_avg20": last.value_avg20,
        "rsi14": last.rsi14, "adx14": last.adx14, "atr_pct": last.atr14 / last.close, "ret63": last.ret63,
        "index_ret63": last.index_ret63, "last_bar": str(ind.index[-1].date()),
        "high52": year["high"].max(), "low52": year["low"].min(), "volume": last.volume, "vol_ratio": last.vol_ratio,
    }
    sf = levels.apply(ind, strategy.signal_frame(ind, cfg), cfg).iloc[-1]
    # the agent's usual plan if bought at the next open: what the size calculator starts from
    out["plan"] = {"stop": sf.stop, "target": sf.target, "atr": last.atr14}
    # stop-loss and target from the chart's support and resistance, with the levels behind them (every stock)
    out["chart"] = levels.plan_at(ind, cfg)
    out["entries"] = levels.entries(ind, cfg, out["chart"])   # buying on a dip to support or on a breakout instead
    k = rule_checks(ind, cfg, sf)
    out["checklist"] = [   # shown when the stock has no signal today
        {"ok": k["liquid"], "text": f"Liquid & clean data (≥ {cfg['min_avg_value_egp'] / 1e6:g}M EGP/day, "
                                    f"≥ {cfg['min_history_bars']} days of history)"},
        {"ok": k["trend"], "text": "Uptrend: price above its 20- and 50-day averages"},
        {"ok": k["breakout"], "text": f"Breakout: close above the 20-day high ({k['high20']:.2f})"},
        {"ok": k["volume"], "text": f"Volume ≥ 1.5× normal (last session {k['vol_ratio']:.1f}×)"},
        {"ok": k["adx"], "text": f"Trend strength ADX > 20 (now {k['adx14']:.0f})"},
    ]
    preds = predictions(d)
    if sym in preds["by_symbol"]:
        out["prediction"] = {**preds["by_symbol"][sym],
                             **{k: preds.get(k) for k in ("base", "count", "date", "top_n", "bands")}}
    out["corporate"] = corporate_history(d.conn, sym, last.close)
    out["fundamentals"] = dividends.company_numbers(d.conn, sym, d.table["sector"])
    out["news"] = news.stock_news(d.conn, sym)
    out["cautions"] = cautions_map(d).get(sym, [])
    out["ai"] = ai_view(d, sym, ind["close"])
    out["range"] = range_view(d, sym)
    if {"sup", "ptgt"} & set(cols):
        # The site's browser needs the chart's levels on each recent day: `sup`, the stop under support (NaN when
        # there's none), which an open position's stop rises to, and `ptgt`, the target, for a buy logged that day.
        rows = np.zeros(len(ind), dtype=bool)
        rows[-PLAN_DAYS:] = True
        lv = levels.frame(ind, cfg, rows) if cfg.get("levels_mode") == "chart" else pd.DataFrame(index=ind.index)
        ind = ind.assign(sup=lv.get("sup", np.nan), ptgt=lv.get("target", np.nan))
    shown = ind if tail is None else ind.tail(tail)
    out["series"] = {"time": [str(t.date()) for t in shown.index], **{c: column(shown[c]) for c in cols}}
    if "div" in shown:   # cash dividends by ex-date: the exit rules in the browser move the stop for them too
        paid = shown["div"][shown["div"] > 0]
        out["series"]["divs"] = {str(t.date()): round(float(v), 6) for t, v in paid.items()}
    return out


def rule_checks(ind: pd.DataFrame, cfg: dict, sf: pd.Series | None = None) -> dict:
    """The breakout rule's checks at the last close, passed or not, with the numbers behind them: the stock page's
    checklist and the bot's /why."""
    last = ind.iloc[-1]
    sf = strategy.signal_frame(ind, cfg).iloc[-1] if sf is None else sf
    return {"liquid": bool(sf.eligible), "trend": bool(sf.trend_ok), "breakout": bool(last.close > last.high20_prev),
            "volume": bool(last.vol_ratio >= 1.5), "adx": bool(last.adx14 > 20), "high20": float(last.high20_prev),
            "vol_ratio": float(last.vol_ratio), "adx14": float(last.adx14)}


PLAN_DAYS = 250               # the site gets the chart's levels for about a year of days (stock_public)
INTRADAY_SHOWN = {"1h": 700, "4h": 400}     # bars per chart: about 5½ months of hours, 8 months of 4-hour bars


def stock_intraday(d: Data, symbol: str) -> dict:
    """The 1-hour and 4-hour charts: {"1h": series, "4h": series} like stock_public's, with `time` in seconds and
    Cairo's clock read as UTC (so the chart labels show the exchange's hours). Empty when there are no hourly bars."""
    hourly = db.load_intraday(d.conn, symbol.upper())
    out = {}
    for key, df in (("1h", hourly), ("4h", prices.four_hour(hourly))):
        if len(df) < 30:
            continue
        shown = add_indicators(df).tail(INTRADAY_SHOWN[key])
        out[key] = {"time": ((shown.index - pd.Timestamp(0)) // pd.Timedelta(seconds=1)).tolist(),
                    **{c: column(shown[c]) for c in SERIES_COLS}}
    return clean(out)


def screener(d: Data) -> dict:
    """Every stock's numbers for the screener, the same for everyone: the site publishes this, and your own marks
    (your Shariah filter's effect on signals, what you hold) are added where you look (screener_view)."""
    def build():
        preds = predictions(d)["by_symbol"]
        yields = {r["symbol"]: r["yield_pct"] for r in d.conn.execute("SELECT symbol, yield_pct FROM dividend_yield")}
        firms = company_values(d.conn)
        today = db.get_meta(d.conn, "scan_data_date") or date.today().isoformat()
        coming = dividends.coming(d.conn, today)
        _, df = current_scan(d.conn)
        action = {r["symbol"]: r["action"] for r in records(df)}
        rows = []
        for sym in d.table.index:
            ind = d.indicators(sym)
            if len(ind) < 30:
                continue
            last, c, year = ind.iloc[-1], ind["close"], ind.tail(250)
            ema200 = c.ewm(span=200, adjust=False).mean().iloc[-1] if len(c) >= 200 else np.nan
            p = preds.get(sym) or {}
            y = yields.get(sym)
            rows.append({
                "symbol": sym, "date": str(ind.index[-1].date()), "close": last.close,
                "chg1": c.iloc[-1] / c.iloc[-2] - 1, "ret5": c.iloc[-1] / c.iloc[-6] - 1 if len(c) > 5 else None,
                "ret21": c.iloc[-1] / c.iloc[-22] - 1 if len(c) > 21 else None,
                "ret63": last.ret63, "rsi": last.rsi14, "adx": last.adx14, "vol_ratio": last.vol_ratio,
                "value": last.value_avg20, "atr_pct": last.atr14 / last.close,
                "vs_ema20": last.close / last.ema20 - 1, "vs_ema50": last.close / last.ema50 - 1,
                "vs_ema200": last.close / ema200 - 1, "from_high": last.close / year["high"].max() - 1,
                "from_low": last.close / year["low"].min() - 1,
                **{k: p.get(k) for k in ("p10", "p20", "top10", "top20", "rating")},
                "yield": y / 100 if y is not None else None, "action": action.get(sym),
                "pe": (firms.get(sym) or {}).get("pe"), "exdiv": (coming.get(sym) or {}).get("ex_date"),
            })
        return clean({"date": str(d.indicators(prices.INDEX_SYMBOL).index[-1].date()) if rows else None,
                      "min_value": d.cfg["min_avg_value_egp"], "rows": rows})
    return d.cache.get(d.version, ("screener",), build)


def dividend_calendar(d: Data) -> dict:
    """Every company's cash dividends the agent has seen (TradingView: the latest and the next announced), each one's
    share of the price, the yields, and the bonus shares and splits of the last year. The same for everyone; what you
    hold is marked where you look (dividends_view)."""
    def build():
        last = d.last_two()
        today = date.today().isoformat()
        value = {r["symbol"]: r["v"] for r in d.conn.execute(      # average traded value, last 20 sessions
            """SELECT symbol, AVG(close * volume) AS v FROM (
                   SELECT symbol, close, volume, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
                   FROM prices) WHERE rn <= 20 GROUP BY symbol""")}
        cash = []
        for r in d.conn.execute("SELECT symbol, ex_date, pay_date, amount FROM cash_dividends ORDER BY ex_date DESC"):
            close = (last.get(r["symbol"]) or {}).get("close")
            cash.append({"symbol": r["symbol"], "ex_date": r["ex_date"], "pay_date": r["pay_date"], "amount": r["amount"],
                         "pct": r["amount"] / close if close else None, "upcoming": r["ex_date"] >= today})
        yields = [{"symbol": r["symbol"], "yield": r["yield_pct"] / 100, "value": value.get(r["symbol"])}
                  for r in d.conn.execute("SELECT symbol, yield_pct FROM dividend_yield WHERE yield_pct > 0 "
                                          "ORDER BY yield_pct DESC") if r["symbol"] in d.table.index]
        year_ago = (date.today() - pd.Timedelta(days=365)).isoformat()
        bonus = [{"symbol": r["symbol"], "ex_date": r["ex_date"], "factor": r["factor"],
                  "text": corporate.describe(r["factor"])}
                 for r in d.conn.execute("SELECT symbol, ex_date, factor FROM price_events WHERE ex_date >= ? "
                                         "ORDER BY ex_date DESC", (year_ago,))]
        updated = d.conn.execute("SELECT MAX(updated) FROM dividend_yield").fetchone()[0]
        have = {(r["symbol"], r["ex_date"]) for r in cash}
        coming = [a for a in news.actions(d.conn, since=today, kinds=("dividend", "bonus", "split", "rights"))
                  if a["symbol"] in d.table.index and a["effective"]
                  and not (a["kind"] == "dividend" and _near(have, a["symbol"], a["effective"]))]
        # rights issues announced in the last 6 months with no ex-date yet (none since, or it's an older one's row)
        last_ex = dict(d.conn.execute("SELECT symbol, MAX(effective) FROM corp_actions WHERE kind = 'rights' "
                                      "AND effective != '' GROUP BY symbol").fetchall())
        undated = {}
        for a in news.actions(d.conn, since=(date.today() - pd.Timedelta(days=183)).isoformat(), kinds=("rights",)):
            if not a["effective"] and a["symbol"] in d.table.index and (last_ex.get(a["symbol"]) or "") < a["announced"]:
                undated.setdefault(a["symbol"], a)
        return clean({"today": today, "updated": updated, "min_value": d.cfg["min_avg_value_egp"], "dividends": cash,
                      "yields": yields, "bonus": bonus,
                      "coming": sorted(coming, key=lambda a: a["effective"]) + list(undated.values()),
                      "rights_history": corporate.rights_history(d.conn, today)})
    return d.cache.get(d.version, ("dividends",), build)


def _near(have: set, sym: str, day: str, days: int = 3) -> bool:
    """TradingView already lists this dividend (its date can differ from Mubasher's by a day or two)."""
    d0 = date.fromisoformat(day)
    return any((sym, (d0 + pd.Timedelta(days=k)).isoformat()) in have for k in range(-days, days + 1))


def dividends_view(d: Data) -> dict:
    return {**dividend_calendar(d), "held": sorted({p["symbol"] for p in open_positions(d)})}


WATCH_MAX = 100


def watchlist(d: Data) -> list[str]:
    """The stocks you starred (your own list, kept with your portfolio)."""
    try:
        saved = json.loads(db.get_user_meta(d.conn, "watchlist") or "[]")
    except ValueError:
        saved = []
    return [s for s in saved if isinstance(s, str)]


def save_watchlist(d: Data, symbols: list[str]) -> dict:
    out: list[str] = []
    for s in symbols:
        s = str(s).strip().upper()
        if s in d.table.index and s not in out:
            out.append(s)
    db.set_user_meta(d.conn, "watchlist", json.dumps(out[:WATCH_MAX]))
    return {"symbols": out[:WATCH_MAX]}


def screener_view(d: Data) -> dict:
    out = dict(screener(d))
    _, sig_rows = signals(d)
    action = {r["symbol"]: r["action"] for r in sig_rows}
    held = {p["symbol"] for p in open_positions(d)}
    out["rows"] = [{**r, "action": action.get(r["symbol"]), "held": r["symbol"] in held} for r in out["rows"]]
    return out


CALC_KEYS = ("capital", "risk_per_trade_pct", "max_position_pct", "max_open_risk_pct", "max_positions", "max_per_sector",
             "max_pct_of_adv", "broker", "fee_pct_per_side", "target_r", "stop_min_pct", "stop_max_pct")


def calc_view(d: Data) -> dict:
    """The size calculator's side of things: your account, your limits and the market's state. The stock's own numbers
    come from its page (stock_detail), and the calculator sizes with the same rule as the BUY signals (risk.py)."""
    real = portfolio.account_summary(d.conn, "real", d.cfg, d.closes())
    m = market_info(d.conn)
    b = breadth_data(d)
    since = (pd.Timestamp.today() - pd.Timedelta(days=30)).strftime("%Y-%m-%d")
    n, value = d.conn.execute(
        "SELECT COUNT(*), COALESCE(SUM(f.shares * f.price), 0) FROM fills f JOIN trades t ON t.id = f.trade_id "
        "WHERE t.account = 'real' AND f.side IN ('buy', 'sell') AND f.date >= ?", (since,)).fetchone()
    return clean({
        "equity": real["equity"], "cash": real["cash"], "orders_30d": {"n": n, "value": value},
        "positions": portfolio.positions_for_allocation(d.conn, "real", ("open",)),
        "cfg": {k: d.cfg[k] for k in CALC_KEYS},
        "risk_off": bool(m.get("risk_off")) if m else False,
        "switch": breadth.switch(b["above50"]) if b else None,
        "money": money_rates(d.conn), "shares_value": real["equity"] - real["cash"],
    })


def stock_detail(d: Data, symbol: str) -> dict:
    sym = symbol.upper()
    out = stock_public(d, sym)
    if not out["has_data"]:
        return clean(out)
    _, sig_rows = signals(d)
    row = [r for r in sig_rows if r["symbol"] == sym]
    ch = out.get("chart")
    lines = [{"label": "Stop", "price": ch["stop"], "kind": "stop"},
              {"label": "Target", "price": ch["target"], "kind": "target"}] if ch else []
    if row:
        sig = row[0]
        out["signal"] = sig
        out.pop("checklist")
        if sig["action"] == "BUY":
            lines = [{"label": "Buy up to", "price": sig["entry_high"], "kind": "entry"},
                      {"label": "Stop", "price": sig["stop"], "kind": "stop"},
                      {"label": "Target", "price": sig["target"], "kind": "target"}]

    pos = open_positions(d, sym)
    if pos:
        out["position"], out["fee_pct"] = pos[0], config.fee_pct(d.cfg)
        lines = [{"label": "Avg price", "price": pos[0]["avg_price"], "kind": "entry"},
                  {"label": "Stop", "price": pos[0]["stop"], "kind": "stop"},
                  {"label": "Target", "price": pos[0]["target"], "kind": "target"}]
    out["levels"] = lines
    out["fills"] = [dict(r) for r in d.conn.execute(
        """SELECT f.date, f.side, SUM(f.shares) AS shares, AVG(f.price) AS price FROM fills f
           JOIN trades t ON t.id = f.trade_id WHERE t.account='real' AND f.symbol=? AND f.side IN ('buy', 'sell')
           GROUP BY f.date, f.side""",
        (sym,))]
    return clean(out)


LIMIT_KEYS = ("max_position_pct", "max_positions", "max_per_sector", "max_open_risk_pct")   # the Health tab's checkup


def portfolio_view(d: Data) -> dict:
    cfg = d.cfg
    s = portfolio.account_summary(d.conn, "real", cfg, d.closes())
    closed = portfolio.trades_df(d.conn, "real", ("closed",))
    rows, stats = [], {"count": 0}
    if len(closed):
        closed["dividends"] = closed.id.map(corporate.dividends_by_trade(d.conn, "real")).fillna(0.0)
        closed["pnl"] = (closed.exit_price - closed.entry_price) * closed.shares - closed.fees + closed.dividends
        closed["return_pct"] = closed.pnl / (closed.entry_price * closed.shares)
        closed = closed.sort_values(["exit_date", "id"], ascending=False)
        rows = records(closed, ["id", "symbol", "entry_date", "entry_price", "exit_date", "exit_price", "shares", "pnl",
                                "return_pct", "exit_reason", "notes"])
        stats = {"count": len(closed), "win_rate": float((closed.pnl > 0).mean()), "total": float(closed.pnl.sum())}
    _, sig_rows = signals(d)
    buy_signals = [{k: r[k] for k in ("symbol", "entry_high", "shares")} for r in sig_rows if r["action"] == "BUY"]
    return clean({
        "summary": s, "positions": open_positions(d), "closed": rows, "closed_stats": stats, "signals": buy_signals,
        "fee_pct": config.fee_pct(cfg), "fee_cfg": {k: cfg[k] for k in ("broker", "fee_pct_per_side")},
        "sell_reasons": SELL_REASONS, "max_hold_days": cfg["max_hold_days"],
        "review_day": cfg["review_day"], "max_open_risk_pct": cfg["max_open_risk_pct"],
        "limits": {k: cfg[k] for k in LIMIT_KEYS},
    })


def history_data(d: Data) -> dict:
    """History that's the same for everyone, for the Journal: every past BUY signal (to tell which of your trades
    followed one) and Egypt's yearly inflation (to show what it took)."""
    def build():
        buys = [{"date": r["scan_date"], "symbol": r["symbol"], "setup": r["setup"]} for r in d.conn.execute(
            "SELECT scan_date, symbol, setup FROM scans WHERE action='BUY' ORDER BY scan_date, symbol")]
        inflation = [{"date": r["date"], "value": r["value"]} for r in d.conn.execute(
            "SELECT date, value FROM macro WHERE series='inflation' AND date >= '2015-01-01' ORDER BY date")]
        money = {}
        for name in ("usdegp", "gold", "interbank"):
            rows = d.conn.execute("SELECT date, value FROM macro WHERE series=? AND date >= ? ORDER BY date",
                                  (name, MONEY_SINCE)).fetchall()
            money[name] = {"time": [r["date"] for r in rows], "value": [round(r["value"], 4) for r in rows]}
        return {"buys": buys, "inflation": inflation, "money": money}
    return d.cache.get(d.version, ("history",), build)


MONEY_SINCE = "2022-01-01"     # the dollar, gold and interest rate history the site publishes (history_data)


def money_rates(conn: sqlite3.Connection) -> dict | None:
    """The latest dollar rate, gold (EGP a gram of 24-carat), interbank rate and yearly inflation (%): for the zakat
    and certificate calculators. None before the Egypt data is downloaded."""
    last = {r["series"]: (r["date"], r["value"]) for r in conn.execute(
        "SELECT m.series, m.date, m.value FROM macro m JOIN (SELECT series, MAX(date) AS d FROM macro GROUP BY series) x "
        "ON x.series = m.series AND x.d = m.date")}
    if "usdegp" not in last:
        return None
    gold = last["gold"][1] * last["usdegp"][1] / macro.OUNCE_G if "gold" in last else None
    return {"date": last["usdegp"][0], "usdegp": last["usdegp"][1], "gold_gram": gold,
            "gold_date": last["gold"][0] if "gold" in last else None,
            "rate": last["interbank"][1] if "interbank" in last else None,
            "inflation": last["inflation"][1] if "inflation" in last else None}


def company_values(conn: sqlite3.Connection) -> dict[str, dict]:
    """Each company's numbers from TradingView (data/dividends.py FUNDAMENTALS): market_cap, pe, …, under the agent's
    own symbols (TradingView's names for a few companies differ)."""
    back = {v: k for k, v in prices.TV_ALIASES.items()}
    return {back.get(r["symbol"], r["symbol"]): json.loads(r["data"])
            for r in conn.execute("SELECT symbol, data FROM fundamentals")}


def company_brief(d: Data) -> dict[str, dict]:
    """Each company's latest results in brief, for the BUY cards, Close to a BUY and the bot's /why: its last 4
    reported quarters (or last year) against the 4 before (data/fundamentals.py; about 3 times as many companies as
    TradingView's own ratios): profit and sales growth (when the year before made a profit / had sales), the profit
    margin (below 0: it lost money), and its P/E (the last close ÷ a year of profit per share) next to the middle P/E
    of its sector (at least 3 companies). The same for everyone."""
    def build():
        rep = fundamentals.reports(d.conn)
        rep = rep[rep["ni"].notna()]
        if rep.empty:
            return {}
        # the newest numbers each company has published: its quarters when it has them, otherwise its years
        last = rep.assign(q=rep["kind"].eq("q")).sort_values(["q", "known"]).groupby("symbol").tail(1).set_index("symbol")
        closes = d.closes()
        sector = d.table["sector"].to_dict() if "sector" in d.table else {}
        grow = lambda now, before: now / before - 1 if before and before > 0 and np.isfinite(now) else None  # noqa: E731
        out, pes = {}, {}
        for sym, r in last.iterrows():
            c = closes.get(sym)
            pe = c / r["eps"] if c and r["ni"] > 0 and (r["eps"] or 0) > 0 else None
            b = {"growth": grow(r["ni"], r["ni_prev"]), "sales": grow(r["rev"], r["rev_prev"]),
                 "margin": r["ni"] / r["rev"] if (r["rev"] or 0) > 0 else None, "pe": pe}
            b = {k: round(float(v), 4) for k, v in b.items() if v is not None and np.isfinite(v)}
            if b:
                out[sym] = b
            if pe and sector.get(sym):
                pes.setdefault(sector[sym], []).append(pe)
        middle = {s: float(np.median(v)) for s, v in pes.items() if len(v) >= 3}
        for sym, b in out.items():
            if "pe" in b and sector.get(sym) in middle:
                b["sector_pe"] = round(middle[sector[sym]], 4)
        return out
    return d.cache.get(d.version, ("company_brief",), build)


def portfolio_history(d: Data) -> dict:
    """Your raw history for My Portfolio's Health and Journal tabs: fills, dividends, and the prices of every stock
    you've held from a few months before your first buy. insights.js does the sums; the site does the same with the
    portfolio in your browser (local/api.js historyView)."""
    rows = lambda sql: [dict(r) for r in d.conn.execute(sql)]  # noqa: E731
    fills = rows("SELECT f.date, f.symbol, f.side, f.shares, f.price, f.fees FROM fills f JOIN trades t "
                 "ON t.id = f.trade_id WHERE t.account = 'real' ORDER BY f.date, f.id")
    dividends = rows("SELECT v.date, v.amount FROM dividends v JOIN trades t ON t.id = v.trade_id "
                     "WHERE t.account = 'real' ORDER BY v.date")
    symbols = sorted({f["symbol"] for f in fills})
    since = pd.Timestamp(min(f["date"] for f in fills)) - pd.Timedelta(days=120) if fills else pd.Timestamp.max

    def closes(sym: str) -> dict:
        px = d.prices(sym)
        px = px[px.index >= since]
        return {"time": [str(t.date()) for t in px.index], "close": column(px["close"])}

    events = [{"symbol": r["symbol"], "ex_date": r["ex_date"], "factor": r["factor"]}
              for r in d.conn.execute("SELECT symbol, ex_date, factor FROM price_events") if r["symbol"] in symbols]
    start = portfolio.account_summary(d.conn, "real", d.cfg, d.closes())["start"]
    pending = [{k: e[k] for k in ("symbol", "ex_date", "factor")} for e in corporate.pending(d.conn, "real").values()]
    return clean({"start": start, "fills": fills, "dividends": dividends, "events": events, "pending": pending,
                  "series": {s: closes(s) for s in symbols}, "index": closes(prices.INDEX_SYMBOL) if fills else None,
                  **history_data(d)})


def paper_view(d: Data) -> dict:
    cfg = d.cfg
    closes = d.closes()
    s = portfolio.account_summary(d.conn, "paper", cfg, closes)
    closed = portfolio.trades_df(d.conn, "paper", ("closed",))
    closed_rows, win_rate = [], None
    if len(closed):
        closed["pnl"] = (closed.exit_price - closed.entry_price) * closed.shares - closed.fees
        closed["return_pct"] = closed.pnl / (closed.entry_price * closed.shares)
        win_rate = float((closed.pnl > 0).mean())
        closed_rows = records(closed.sort_values(["exit_date", "id"], ascending=False),
                              ["symbol", "entry_date", "entry_price", "exit_date", "exit_price", "shares", "days_held",
                               "pnl", "return_pct", "exit_reason"])
    open_ = portfolio.trades_df(d.conn, "paper", ("open",))
    if len(open_):
        open_["last"] = open_.symbol.map(closes)
        open_["pnl_pct"] = open_["last"] / open_.entry_price - 1
    pending = portfolio.trades_df(d.conn, "paper", ("pending",))
    cancelled = portfolio.trades_df(d.conn, "paper", ("cancelled",))

    curve, bench = [], []
    index_df = d.prices(prices.INDEX_SYMBOL)
    syms = set(portfolio.trades_df(d.conn, "paper", ("open", "closed")).symbol)
    frames = {x: d.prices(x)["close"] for x in syms if len(d.prices(x))}
    eq = portfolio.equity_curve(d.conn, "paper", cfg, frames, index_df.index)
    if len(eq) >= 2:
        idx = index_df["close"].reindex(eq.index)
        curve = [{"time": str(t.date()), "value": v} for t, v in eq.items()]
        bench = [{"time": str(t.date()), "value": cfg["paper_capital"] * v / idx.iloc[0]} for t, v in idx.items()]
    return clean({
        "summary": s, "win_rate": win_rate, "auto_paper": cfg["auto_paper"], "paper_capital": cfg["paper_capital"],
        "open": records(open_, ["symbol", "entry_date", "entry_price", "shares", "last", "pnl_pct", "stop", "target",
                                "days_held"]),
        "pending": records(pending, ["symbol", "signal_date", "shares", "entry_limit", "stop", "target"]),
        "closed": closed_rows,
        "cancelled": records(cancelled, ["symbol", "signal_date", "exit_reason"]),
        "curve": curve, "benchmark": bench,
    })


def orders(d: Data, positions: list[dict] | None = None) -> dict | None:
    """Everything to do at your broker in the next session, most urgent first. Also the Telegram message."""
    scan_date, sig_rows = signals(d)
    if not scan_date:
        return None
    m = market_info(d.conn)
    session = sessions_after(scan_date, 1)
    positions = open_positions(d) if positions is None else positions
    items, holds, skipped = [], [], []
    for p in positions:
        sym, st = p["symbol"], p["status"]
        base = {"symbol": sym, "trade_id": p["id"], "shares": p["shares"]}
        if st == "ADJUST":
            items.append({**base, "key": f"adjust:{sym}", "kind": "adjust",
                          "title": f"Update {sym} for its bonus shares",
                          "detail": f"{p['adjust']['describe'].capitalize()}, from {nice_date(p['adjust']['ex_date'])}. "
                                    "On My Portfolio, enter the shares you hold now. Its stop can't be checked until then."})
        elif st == "EXIT":
            items.append({**base, "key": f"sell:{sym}", "kind": "sell",
                          "title": f"Sell all {p['shares']:,} {sym} at the open", "detail": p["reason"]})
        elif st == "BOUNCE":      # a big loss: sold on the first bounce (portfolio.on_bounce)
            items.append({**base, "key": f"bounce:{sym}", "kind": "review", "level": p["bounce_level"],
                          "title": f"Sell {sym} on a bounce: at its first close above {px(p['bounce_level'])}",
                          "detail": p["reason"]})
        elif st == "TIGHTEN STOP":
            items.append({**base, "key": f"stop:{sym}", "kind": "stop", "from": p["prev_stop"], "to": p["stop"],
                          "title": f"Move your {sym} stop up to {px(p['stop'])}",
                          "detail": f"It was {px(p['prev_stop'])}. Sell if the price falls to {px(p['stop'])}."})
        elif st == "REVIEW":
            items.append({**base, "key": f"review:{sym}", "kind": "review",
                          "title": f"Decide on {sym}: day {p['day']} without progress", "detail": p["reason"]})
        elif st == "HOLD":
            holds.append({"symbol": sym, "stop": p["stop"], "target": p["target"], "day": p["day"]})
    coming = dividends.coming(d.conn, scan_date)
    for p in positions:
        div = coming.get(p["symbol"])
        if div and div["ex_date"] == session and div.get("amount") and p["status"] in ("HOLD", "TIGHTEN STOP", "REVIEW"):
            items.append(exdiv_item(p, div))
    for r in [x for x in sig_rows if x["action"] == "BUY"]:
        if r["shares"] and r["shares"] > 0:
            items.append({
                "symbol": r["symbol"], "key": f"buy:{r['symbol']}", "kind": "buy", "info": d.info(r["symbol"]),
                "shares": r["shares"], "limit": r["entry_high"], "stop": r["stop"], "target": r["target"],
                "amount": r["amount"], "risk_egp": r["risk_egp"], "source": r.get("source") or "rules",
                "title": f"Buy {r['shares']:,} {r['symbol']}, paying no more than {px(r['entry_high'])}",
                "detail": f"Use a limit order; skip it if it opens higher. Once filled: stop {px(r['stop'])}, "
                          f"target {px(r['target'])}, max loss {r['risk_egp']:,.0f} EGP.",
            })
        else:
            skipped.append({"symbol": r["symbol"], "note": r["size_note"]})
    rank = {"adjust": 0, "sell": 1, "stop": 2, "review": 3, "buy": 4}
    items.sort(key=lambda it: rank[it["kind"]])
    done = {r["item"] for r in d.conn.execute("SELECT item FROM checklist WHERE session=?", (session,))}
    for it in items:
        it["done"] = it["key"] in done
    return clean({
        "session": session, "scan_date": scan_date, "items": items, "holds": holds, "skipped": skipped,
        "blocked": bool(m.get("risk_off") and d.cfg.get("riskoff_block_buys")),
        "stale": session <= scan.expected_session_date().isoformat(),
    })


def exdiv_item(p: dict, div: dict) -> dict:
    """An open position whose stock goes ex-dividend at the next session: lower the stop by the dividend before the
    open, or the price drop alone (which the dividend makes up for) could sell it (engine.ex_dividend)."""
    sym, amount = p["symbol"], float(div["amount"])
    to = p["stop"] - amount
    return {"symbol": sym, "trade_id": p["id"], "shares": p["shares"], "key": f"exdiv:{sym}", "kind": "stop",
            "from": p["stop"], "to": to, "title": f"Lower your {sym} stop to {px(to)} before the open",
            "detail": f"{sym} goes ex-dividend: the price opens about {amount:g} EGP lower, and you get {amount:g} EGP "
                      f"a share ({amount * p['shares']:,.0f} EGP). The agent moves the stop and the target down by the "
                      f"same amount, so the drop alone doesn't sell."}


def breadth_data(d: Data) -> dict | None:
    def build():
        closes, index_close = breadth.load_closes(d.conn)
        return breadth.compute(closes, index_close, d.table["sector"])
    return d.cache.get(d.version, "breadth", build)


def mood_data(d: Data) -> dict | None:
    """The market mood gauge (egx_agent/mood.py): the Market page's card."""
    return d.cache.get(d.version, "mood", lambda: clean(mood.compute(mood.load(d.conn))))


def mood_brief(d: Data) -> dict | None:
    """Just the gauge, for Home, the evening message and the bot."""
    x = mood_data(d)
    return {k: x.get(k) for k in ("date", "score", "label", "week_ago", "flows")} if x else None


JUMP = 0.30   # a one-day move this big can't happen within EGX's daily price limits


def movers(d: Data) -> dict:
    """The liquid stocks that rose and fell most over a day, a week and a month, and the stocks at a 1-year closing
    high or low (the rule of the 52-week highs/lows count), at the last close. From one price table, so it's quick."""
    def build():
        latest = d.conn.execute("SELECT MAX(date) FROM prices").fetchone()[0]
        since = (pd.Timestamp(latest or date.today()) - pd.Timedelta(days=420)).strftime("%Y-%m-%d")
        px = pd.read_sql_query("SELECT symbol, date, close, volume FROM prices WHERE date >= ?", d.conn, params=(since,))
        px = px[px["symbol"].isin(d.table.index)]
        if px.empty:
            return {"movers": None, "highs": [], "lows": []}
        close = px.pivot(index="date", columns="symbol", values="close").sort_index()
        traded = close * px.pivot(index="date", columns="symbol", values="volume").reindex_like(close)
        value = traded.tail(20).mean()
        today = close.iloc[-1].dropna().index                      # traded at the last close
        c = close.ffill(limit=5)
        year = close.tail(250)
        enough = year.notna().sum() >= 120
        liquid = today[value.reindex(today) >= d.cfg["min_avg_value_egp"]]
        out = {}
        daily = c.pct_change(fill_method=None).abs()
        for key, n in (("chg1", 1), ("ret5", 5), ("ret21", 21)):
            # a one-day move beyond EGX's ±20% limit means a split or bonus shares not re-based yet: not a real move
            clean_ = daily.tail(n).max().reindex(liquid).fillna(0) <= JUMP
            ret = (c.iloc[-1] / c.iloc[-1 - n] - 1).reindex(liquid[clean_.to_numpy()]).dropna().sort_values()
            pick = lambda rs: [{"symbol": s, "ret": float(r), "close": float(close[s].iloc[-1])} for s, r in rs.items()]  # noqa: E731
            out[key] = {"up": pick(ret[::-1].head(6)), "down": pick(ret.head(6))}
        last = close.iloc[-1].reindex(today)
        highs = [s for s in today if enough[s] and last[s] >= year[s].max() * 0.999]
        lows = [s for s in today if enough[s] and last[s] <= year[s].min() * 1.001]
        # the heatmap: every stock that traded at the last close, by sector, with its moves (a split's jump left out)
        firms = company_values(d.conn)
        sectors = d.table["sector"]
        moves = {key: (c.iloc[-1] / c.iloc[-1 - n] - 1).where(daily.tail(n).max() <= JUMP)
                 for key, n in (("chg1", 1), ("ret5", 5), ("ret21", 21))}
        tiles = [{"symbol": s, "sector": sectors.get(s) or "Other", "cap": (firms.get(s) or {}).get("market_cap"),
                  "value": value.get(s), **{k: m.get(s) for k, m in moves.items()}}
                 for s in today if s in sectors.index]
        # money by sector: each sector's share of the money traded at the last close, and its usual share (the 20
        # sessions before), so you see where money is going now. One big deal day counts too.
        by = traded.T.groupby(sectors.reindex(traded.columns).fillna("Other")).sum().T
        last, usual = by.iloc[-1], by.iloc[-21:-1].sum()
        sector_money = sorted(({"sector": k, "value": float(last[k]), "share": float(last[k] / last.sum()),
                                "usual": float(usual[k] / usual.sum()) if usual.sum() else None}
                               for k in by.columns if last[k] > 0), key=lambda r: -r["value"]) if last.sum() else []
        return clean({"movers": out, "highs": sorted(highs), "lows": sorted(lows), "tiles": tiles,
                      "sector_money": sector_money})
    return d.cache.get(d.version, ("movers",), build)


RESULTS_AHEAD_DAYS = 45       # the Market page's "Results coming" list


def results_calendar(d: Data) -> list[dict]:
    """The liquid-enough stocks' expected results dates in the next few weeks (TradingView's estimates)."""
    today = db.get_meta(d.conn, "scan_data_date") or date.today().isoformat()
    until = (date.fromisoformat(today) + pd.Timedelta(days=RESULTS_AHEAD_DAYS)).isoformat()
    rows = [{"symbol": s, "date": day, "name": d.info(s).get("name_ar", "")}
            for s, day in dividends.next_results(d.conn, today, until).items() if s in d.table.index]
    return sorted(rows, key=lambda r: (r["date"], r["symbol"]))


def market_view(d: Data) -> dict:
    b = breadth_data(d)
    m = market_info(d.conn)
    if not b:
        return {"breadth": None, "market": m or None, "results": results_calendar(d), "mood": mood_data(d),
                "investors": flows.recent_split(d.conn)}
    return clean({"breadth": b, "verdict": breadth.verdict(b, m.get("egx30_off", m.get("risk_off")) if m else None), "market": m or None,
                  "results": results_calendar(d), "mood": mood_data(d), "investors": flows.recent_split(d.conn),
                  **movers(d)})


INDEX_PERIODS = (("1W", 5), ("1M", 21), ("3M", 63), ("6M", 126), ("1Y", 250), ("3Y", 750), ("5Y", 1250))


def index_view(d: Data) -> dict:
    """The EGX30 page: its chart with its averages, where it stands against them and its 1-year range, its returns
    over each period and each calendar year in pounds and in dollars (and EGX70's beside it), how jumpy it is, and
    the agent's own rule about it (no new BUYs while it is under its 50-day average)."""
    def build():
        df = db.load_prices(d.conn, prices.INDEX_SYMBOL)
        if len(df) < 60:
            return {"has_data": False}
        ind = add_indicators(df)
        c = ind["close"]
        ema200 = c.ewm(span=200, adjust=False).mean()
        last, year = ind.iloc[-1], ind.tail(250)
        daily = c.pct_change(fill_method=None).tail(250).dropna()
        raw = db.load_macro(d.conn)
        def on_days(name):     # a macro series on the index's days (the last value known each day), or None
            if raw.empty or name not in raw or raw[name].dropna().empty:
                return None
            v = raw[name].dropna()
            return v.reindex(v.index.union(c.index)).ffill().reindex(c.index)
        usd, e70 = on_days("usdegp"), on_days("egx70")
        in_usd = c / usd if usd is not None else None

        def ret(s, n):
            s = s.dropna() if s is not None else None
            return float(s.iloc[-1] / s.iloc[-1 - n] - 1) if s is not None and len(s) > n else None

        start = c[c.index.year < c.index[-1].year]    # this year so far: from last year's final close
        periods = [{"key": k, "egp": ret(c, n), "usd": ret(in_usd, n), "egx70": ret(e70, n)} for k, n in INDEX_PERIODS]
        if len(start):
            ytd = lambda s: float(s.iloc[-1] / s.loc[:start.index[-1]].dropna().iloc[-1] - 1) \
                if s is not None and s.loc[:start.index[-1]].notna().any() else None  # noqa: E731
            periods.insert(4, {"key": "YTD", "egp": ytd(c), "usd": ytd(in_usd), "egx70": ytd(e70)})
        years = []
        ends = c.groupby(c.index.year).tail(1)            # each year's last close
        for i in range(1, len(ends)):
            a, b = ends.index[i - 1], ends.index[i]
            yr = {"year": int(b.year), "egp": float(ends.iloc[i] / ends.iloc[i - 1] - 1), "partial": b == c.index[-1]}
            if in_usd is not None and pd.notna(in_usd.get(a)) and pd.notna(in_usd.get(b)):
                yr["usd"] = float(in_usd[b] / in_usd[a] - 1)
            years.append(yr)
        peak = c.cummax()
        m = market_info(d.conn)
        b = breadth_data(d)
        return {
            "has_data": True, "date": str(ind.index[-1].date()), "close": float(last.close),
            "change": float(last.close / ind["close"].iloc[-2] - 1), "ema20": float(last.ema20), "ema50": float(last.ema50),
            "ema200": float(ema200.iloc[-1]), "rsi14": float(last.rsi14), "high52": float(year["high"].max()),
            "low52": float(year["low"].min()), "ath": float(peak.iloc[-1]), "ath_date": str(c.idxmax().date()),
            "from_ath": float(c.iloc[-1] / peak.iloc[-1] - 1), "usd_close": float(in_usd.iloc[-1]) if in_usd is not None else None,
            "volatility": float(daily.std() * np.sqrt(245)), "up_days": float((daily > 0).mean()),
            "best_day": {"date": str(daily.idxmax().date()), "ret": float(daily.max())},
            "worst_day": {"date": str(daily.idxmin().date()), "ret": float(daily.min())},
            "drop_1y": float((year["close"] / year["close"].cummax() - 1).min()),
            "periods": periods, "years": years[-10:][::-1], "risk_off": bool(m.get("egx30_off", m.get("risk_off"))) if m else None,
            "above50": b["above50"] if b else None,
            "series": {"time": [str(t.date()) for t in ind.index], **{k: column(ind[k]) for k in SERIES_COLS}},
            # weekly points, counted back from the last close so the chart ends on it
            "usd_line": [{"time": str(t.date()), "value": round(float(v), 2)} for t, v in in_usd.dropna().iloc[::-5][::-1].items()]
            if in_usd is not None else [],
        }
    return clean(d.cache.get(d.version, "egx30", build))


def predictions(d: Data) -> dict:
    """The model's latest numbers per stock, and the average stock's chance to compare them with."""
    def build():
        lt = predict.latest(d.conn)
        meta = predict.load_meta(predict.model_dir(d.conn))
        if lt.empty or not meta:
            return {"by_symbol": {}, "base": None, "count": 0, "date": None, "bands": []}
        base = {hz: (meta["horizons"].get(str(hz), {}).get("all") or {}).get("hit") for hz in predict.HORIZONS}
        # its top 10% each day: the group its tested results are about, so the only chances worth showing
        cut = max(1, math.ceil(len(lt) * TOP_SHARE))
        why = {(r["symbol"], r["horizon"]): r["why"] for r in d.conn.execute(
            "SELECT symbol, horizon, why FROM predictions WHERE date=?", (lt["date"].iloc[0],))}
        by = {}
        for sym, r in lt.iterrows():
            by[sym] = {f"{k}{hz}": r.get(f"{k}{hz}") for hz in predict.HORIZONS for k in ("p", "rank", "exp")}
            by[sym]["rating"] = rating(r.get("rank10"), len(lt))
            by[sym].update({f"top{hz}": bool(r.get(f"rank{hz}", cut + 1) <= cut) for hz in predict.HORIZONS})
            # what pushed its score up or down (predict.explain): [{f, up, text}, …]
            by[sym].update({f"why{hz}": json.loads(why.get((sym, hz)) or "null") for hz in predict.HORIZONS})
        return {"by_symbol": clean(by), "base": clean(base), "count": int(len(lt)), "date": lt["date"].iloc[0],
                "top_n": cut, "bands": rating_bands(meta)}
    return d.cache.get(d.version, ("predictions", db.get_meta(d.conn, "prediction_date"),
                                   db.get_meta(d.conn, "prediction_updated")), build)


# The rating: where the model's 2-week score puts a stock among that day's liquid stocks, 1 (last) to 100 (first).
# Its bands are the model's tested groups (predict.RANK_GROUPS): 91–100 is its top 10%, and so on.
RATING_BANDS = {"Top 10%": (91, 100), "Next 20%": (71, 90), "Middle 20%": (51, 70), "Bottom half": (1, 50)}


def rating(rank, n: int) -> int | None:
    """1 = the model's best stock that day → 100; its worst → about 100/n."""
    if rank is None or not n or not math.isfinite(rank):
        return None
    return max(1, math.ceil(100 * (n - rank + 1) / n))


def rating_bands(meta: dict | None) -> list[dict]:
    """How stocks in each rating band did on the years the model never saw: how often the target came first, and
    the average trade after fees."""
    groups = ((meta or {}).get("horizons", {}).get("10") or {}).get("groups") or []
    return [{"from": RATING_BANDS[g["label"]][0], "to": RATING_BANDS[g["label"]][1], "hit": g.get("hit"),
             "ret": g.get("ret"), "n": g.get("n")} for g in groups if g.get("label") in RATING_BANDS]


HORIZON_KEYS = ("all", "top", "rule", "rule_agree", "rule_disagree", "auc", "lift", "grade", "verdict", "years",
                "groups", "from", "to", "train_n", "good_years", "top_share", "features", "top_ret_cost", "portfolio",
                "portfolio_cost", "chances", "extra_cost")
TOP_SHARE = 0.10   # the model's top picks: its best 10% each day


def predict_public(d: Data) -> dict:
    """The Predict page without your own marks (which stocks are your signals or in your portfolio)."""
    root = predict.model_dir(d.conn)
    meta = predict.load_meta(root)
    deep = int(db.get_meta(d.conn, "history_years_loaded") or 0) >= prices.DEEP_YEARS
    out: dict = {"model": None, "rows": [], "deep": deep, "deep_years": prices.DEEP_YEARS,
                 "horizons": list(predict.HORIZONS), "retrain_days": predict.RETRAIN_DAYS,
                 "features": {str(hz): len(predict.HORIZON_FEATURES[hz]) for hz in predict.HORIZONS},
                 "levels": {k: d.cfg.get(k) for k in ("atr_stop_mult", "stop_min_pct", "stop_max_pct", "target_r",
                                                      "levels_mode")}}
    if not meta or not predict.model_path(root).exists():
        return out
    out["model"] = {
        **{k: meta[k] for k in ("trained_at", "data_from", "data_to", "stocks", "rows")},
        "live_since": meta.get("live_since"),
        "age_days": predict.age_days(meta), "changed": predict.settings_changed(meta, d.cfg),
        "horizons": {hz: {k: r.get(k) for k in HORIZON_KEYS} for hz, r in meta["horizons"].items()},
    }
    preds = predictions(d)
    out.update(base=preds["base"], date=preds["date"], count=preds["count"], top_n=preds.get("top_n"))
    lt = predict.latest(d.conn)
    wk = predict.WEEK
    why_wk = {s: json.loads(w or "null") for s, w in d.conn.execute(
        "SELECT symbol, why FROM predictions WHERE date=? AND horizon=?", (preds["date"], wk))}
    for sym, r in lt.iterrows():
        close = float(r["close"])
        move = r.get(f"move{wk}")
        week = {} if move is None or not math.isfinite(move) else {   # the week: its chance, target and stop
            f"p{wk}": r.get(f"p{wk}"), f"rank{wk}": r.get(f"rank{wk}"), f"move{wk}": move, "level": r.get("level"),
            f"target{wk}": close * (1 + move), f"stop{wk}": close * (1 - move), f"why{wk}": why_wk.get(sym)}
        out["rows"].append({
            "symbol": sym, "info": d.info(sym), "close": close, "stop": close * (1 - r["stop_pct"]),
            "target": close * (1 + r["target_pct"]), "target_pct": r["target_pct"], "stop_pct": r["stop_pct"],
            **preds["by_symbol"].get(sym, {}), **week,
        })
    out["live"] = predict.live_record(d.conn, since=meta.get("live_since"))
    out["recent"] = predict.recent_record(d.conn, since=meta.get("live_since"))
    # each stock's rank at the close before, for the ▲▼ next to today's rank
    prev = d.conn.execute("SELECT MAX(date) FROM predictions WHERE date < ?", (preds["date"],)).fetchone()[0]
    if prev:
        before = {hz: predict.ranks_for(d.conn, prev, hz) for hz in predict.ALL_HORIZONS}
        for row in out["rows"]:
            for hz in predict.ALL_HORIZONS:
                row[f"prev_rank{hz}"] = (before[hz].get(row["symbol"]) or {}).get("rank")
        out["prev_date"] = prev
    b = breadth_data(d)
    out["switch"] = breadth.switch(b["above50"]) if b else None
    # the BUY rules with and without it on its test years, and whether it still works live
    out["combo"] = meta.get("combo")
    out["health"] = predict.health(d.conn, meta)
    out["model_picks"] = int(d.cfg.get("model_picks", 0) or 0)
    test = meta["horizons"].get(str(wk)) or {}
    if test.get("week") and "level" in lt:
        # the week: its tests and replay (predict.week_eval), how it did live, and today's market state
        out["week"] = {"hz": wk, "atr": predict.WEEK_ATR, "test": test["week"], "extra_cost": test.get("extra_cost"),
                       "live": out["live"].get(str(wk)), "weak": bool((lt["level"] == "weak").any())}
    return out


def predict_view(d: Data) -> dict:
    """The model's ranking, with only the stocks your Shariah filter allows (their rank stays the model's)."""
    out = predict_public(d)
    out["shariah_filter"] = d.cfg["shariah_filter"]
    if out["model"]:
        _, sig_rows = signals(d)
        action = {r["symbol"]: r["action"] for r in sig_rows}
        held = {p["symbol"] for p in open_positions(d)}
        out["rows"] = [{**row, "action": action.get(row["symbol"]), "held": row["symbol"] in held} for row in out["rows"]
                       if shariah.passes_filter(row.get("info") or d.info(row["symbol"]), d.cfg["shariah_filter"])]
    return clean(out)


def backtest_payload(res: dict, label: str) -> dict:
    eq, ix = res["equity"], res["index_equity"]
    dd = eq / eq.cummax() - 1
    trades = res["trades"]
    m = dict(res["metrics"])
    m["profit_factor_inf"] = m.get("profit_factor") == float("inf")
    exits, best, worst = [], [], []
    if len(trades):
        counts = trades.reason.str.replace(r" \(.*\)", "", regex=True).value_counts()
        exits = [{"reason": k, "trades": int(v)} for k, v in counts.items()]
        by = trades.groupby("symbol").agg(trades=("pnl", "size"), pnl=("pnl", "sum")).sort_values("pnl")
        best = [{"symbol": s, **r} for s, r in by.tail(5).iloc[::-1].to_dict("index").items()]
        worst = [{"symbol": s, **r} for s, r in by.head(5).to_dict("index").items()]
    line = lambda s: [{"time": str(t.date()), "value": v} for t, v in s.items()]  # noqa: E731
    return clean({
        "label": label, "ran_at": datetime.now().isoformat(timespec="seconds"), "metrics": m,
        "equity": line(eq), "index": line(ix), "drawdown": line(dd), "exits": exits, "best": best, "worst": worst,
        "trades": records(trades, ["symbol", "entry_date", "entry_price", "exit_date", "exit_price", "shares",
                                   "days_held", "pnl", "return_pct", "reason"]),
        "open_at_end": records(res["open_at_end"]),
    })


# ------------------------------------------------------------------ settings

def _f(key, label, lo, hi, step, unit="", help="", kind="float", scale=1.0):
    return {"key": key, "label": label, "min": lo, "max": hi, "step": step, "unit": unit, "help": help,
            "kind": kind, "scale": scale}


SETTINGS_SECTIONS = [
    {"title": "Money", "fields": [
        _f("capital", "Your trading capital", 1_000, 1e9, 5_000, "EGP",
           "Used for position sizing and the My Portfolio page. Include money you have added to the account."),
        _f("paper_capital", "Paper account", 1_000, 1e9, 5_000, "EGP", "Starting value of the virtual account."),
        {"key": "broker", "label": "Your broker", "kind": "select",
         "options": [{"value": k, "label": v} for k, v in config.BROKERS.items()],
         "help": "Thndr: its exact fees on every order (EGP 2 + 0.1%, plus the exchange's and government's fees). "
                 "Thndr Trader: the same without Thndr's commission. Compare the two in Calculator → Thndr fees."},
        _f("fee_pct_per_side", "Fees per buy or sell", 0, 2, 0.01, "%",
           "Only with another broker: commission + EGX, clearing and regulator fees + taxes, for ONE side of a "
           "trade. Check your broker's fee sheet."),
    ]},
    {"title": "Risk per trade", "fields": [
        _f("risk_per_trade_pct", "Max loss per trade", 0.25, 5, 0.25, "% of account",
           "If the stop-loss is hit you lose about this much. 1.5% of 100k = 1,500 EGP."),
        _f("max_position_pct", "Max size of one position", 5, 100, 5, "% of account"),
        _f("max_positions", "Max open positions", 1, 15, 1, kind="int"),
        _f("max_open_risk_pct", "Max total risk of open positions", 1, 20, 0.5, "%",
           "The sum of all possible stop-loss losses."),
        _f("max_per_sector", "Max positions in one sector", 1, 10, 1, kind="int"),
        _f("max_pct_of_adv", "Max position vs daily traded value", 0.5, 25, 0.5, "%",
           "Keeps you out of stocks too thin to exit quickly."),
    ]},
    {"title": "Your stops", "fields": [
        {"key": "stop_moves", "label": "Your positions' stops move", "kind": "choice",
         "options": [{"value": "auto", "label": "By themselves: up to each newer support, never down (tested better)"},
                     {"value": "mine", "label": "Only when I change them"}],
         "help": "By themselves: each evening the stop rises to just under the newest support, and once a position "
                 "has gained 1× its risk it goes no lower than your price + 1.5%; the to-do list says when to move "
                 "it at your broker. Tested 2016–2026: 31.8% a year with stops that follow support against 22.3% "
                 "without. Only when I change them: the stop stays where it was set when you bought, until you "
                 "change it (Sell or edit → Change the stop)."},
    ]},
    {"title": "Shariah", "fields": [
        {"key": "shariah_filter", "label": "Shariah filter for BUY signals", "kind": "select",
         "options": [{"value": k, "label": v} for k, v in config.SHARIAH_MODES.items()],
         "help": "The EGX33 and Kashif badges always show. This decides which stocks can get BUY signals, and "
                 "which show in Getting close and the model's ranking."},
    ]},
    {"title": "Paper trading", "fields": [
        {"key": "auto_paper", "label": "Place paper trades automatically after each scan", "kind": "toggle"},
    ]},
    {"title": "Which stocks", "fields": [
        _f("min_avg_value_egp", "Min average daily traded value", 0, 500, 0.5, "million EGP", scale=1e6),
        _f("min_price", "Min share price", 0, 100, 0.1, "EGP"),
        {"key": "egx33_extra", "label": "Extra EGX33 members", "kind": "list", "placeholder": "e.g. ABUK, MFPC",
         "help": "Kashif's EGX33 list has fewer than 33 stocks. If the official list has a symbol that is missing, "
                 "add it and its EGX33 badge turns green."},
        {"key": "symbol_aliases", "label": "TradingView code overrides", "kind": "map",
         "placeholder": "KASHIF=TRADINGVIEW, e.g. AIHC=AIH",
         "help": "For renamed companies whose TradingView code differs from Kashif's. Already built in: "
                 + ", ".join(f"{k}={v}" for k, v in prices.TV_ALIASES.items())},
    ]},
    {"title": "Entries", "fields": [
        {"key": "setups", "label": "Entry setups", "kind": "multi",
         "options": [{"value": k, "label": v} for k, v in strategy.SETUP_LABELS.items()],
         "help": "Backtest 2022–2026: breakouts made the profit; pullback and MACD entries lost money."},
        _f("buy_score", "Min score for BUY", 40, 95, 1, kind="int"),
        _f("watch_score", "Min score for the watchlist", 30, 95, 1, kind="int"),
        {"key": "riskoff_block_buys", "label": "When EGX30 is below its 50-day average (risk-off)", "kind": "choice",
         "options": [{"value": True, "label": "No new buys (tested better)"},
                     {"value": False, "label": "Stricter: higher score, half the positions"}]},
        _f("riskoff_score_bonus", "Risk-off score increase", 0, 30, 1, kind="int",
           help="Only used with the 'Stricter' option."),
        _f("model_picks", "Prediction model's own BUYs a day", 0, 5, 1, kind="int",
           help="Its best-ranked stocks that also pass the liquidity and uptrend checks, with the usual stop and "
                "target. Tested on years it never saw (2016–2026): the rules alone made 15% a year, plus its top 3 "
                "27%, with the same worst drop. 0 = none. Either way it decides which BUYs get money first."),
    ]},
    {"title": "Exits", "fields": [
        {"key": "levels_mode", "label": "Stop-loss and target from", "kind": "choice",
         "options": [{"value": "chart", "label": "The chart: support, resistance, Fibonacci"},
                     {"value": "atr", "label": "A fixed rule: 2× the daily range, target 2× the risk"}],
         "help": "Chart: the stop goes just under the nearest solid support and the target just under the first "
                 "resistance. Tested 2016–2026 on years the model never saw: steadier (13% vs 9% a year in the first "
                 "half, worst drop −22% vs −26%), but 24% vs 28% a year overall, because the fixed rule caught more "
                 "of the 2021–26 boom."},
        _f("target_min_r", "Chart target: at least", 1, 4, 0.25, "× the risk",
           "Resistance closer than this is passed; the target goes to the next one."),
        _f("target_max_r", "Chart target: at most", 1.5, 8, 0.25, "× the risk"),
        _f("atr_stop_mult", "Stop distance", 1, 5, 0.25, "× average daily range"),
        _f("stop_min_pct", "Tightest stop", 1, 20, 0.5, "% below entry"),
        _f("stop_max_pct", "Widest stop", 2, 30, 0.5, "% below entry"),
        _f("target_r", "Target", 1, 6, 0.25, "× the risk",
           "2 means the target is twice as far above entry as the stop is below it. With chart levels, used only "
           "when there's no resistance within reach."),
        _f("review_day", "Review if no progress by session", 3, 30, 1, kind="int"),
        _f("max_hold_days", "Hard exit after sessions", 5, 40, 1, kind="int",
           help="20 sessions ≈ 1 month (EGX trades Sunday–Thursday)."),
    ]},
]
for _sec in SETTINGS_SECTIONS:   # your own numbers, or the strategy everyone on the website shares
    _sec["scope"] = "personal" if all(f["key"] in config.PERSONAL_KEYS for f in _sec["fields"]) else "strategy"
FIELDS = {f["key"]: f for s in SETTINGS_SECTIONS for f in s["fields"]}


def settings_view(d: Data) -> dict:
    conn = d.conn
    missing = conn.execute(
        "SELECT symbol, COALESCE(price_note, 'no price data') AS note FROM stocks "
        "WHERE price_missing_since IS NOT NULL ORDER BY note, symbol"
    ).fetchall()
    groups: dict[str, list[str]] = {}
    for r in missing:
        groups.setdefault(r["note"], []).append(r["symbol"])
    n_priced = conn.execute("SELECT COUNT(DISTINCT symbol) FROM prices").fetchone()[0]
    sections = [sec for sec in SETTINGS_SECTIONS if d.is_admin or sec["scope"] == "personal"]
    keys = {f["key"] for sec in sections for f in sec["fields"]}
    return clean({
        "values": {k: v for k, v in d.cfg.items() if k in keys},  # never the Telegram token
        "defaults": {k: v for k, v in config.DEFAULTS.items() if k in keys},
        "sections": sections,
        "multi_user": d.multi_user, "is_admin": d.is_admin,
        "data": {
            "stocks": conn.execute("SELECT COUNT(*) FROM stocks").fetchone()[0],
            "priced": max(n_priced - 1, 0),
            "last_bar": conn.execute("SELECT MAX(date) FROM prices").fetchone()[0],
            "kashif_checked": db.get_meta(conn, "kashif_refreshed"),
            "missing": [{"note": k[0].upper() + k[1:], "symbols": v} for k, v in groups.items()],
        },
    })


def parse_settings(values: dict, current: dict) -> tuple[dict, dict[str, str]]:
    """Validate what the Settings page sent. Returns (new settings, errors by field)."""
    new, errors = dict(current), {}
    for key, f in FIELDS.items():
        if key not in values:
            continue
        v = values[key]
        kind = f["kind"]
        try:
            if kind in ("float", "int"):
                num = float(v) / f.get("scale", 1.0)
                if not math.isfinite(num) or not f["min"] <= num <= f["max"]:
                    errors[key] = f"Enter a number between {f['min']:g} and {f['max']:g}."
                    continue
                num *= f.get("scale", 1.0)
                new[key] = int(round(num)) if kind == "int" else float(num)
            elif kind == "select":
                if v not in {o["value"] for o in f["options"]}:
                    errors[key] = "Pick one of the options."
                else:
                    new[key] = v
            elif kind == "toggle":
                new[key] = bool(v)
            elif kind == "choice":           # one of the options as it is: True/False, or a word like "chart"
                match = [o["value"] for o in f["options"] if o["value"] == v and type(o["value"]) is type(v)]
                if not match:
                    errors[key] = "Pick one of the options."
                else:
                    new[key] = match[0]
            elif kind == "multi":
                allowed = {o["value"] for o in f["options"]}
                picked = [x for x in (v or []) if x in allowed]
                if not picked:
                    errors[key] = "Pick at least one entry setup."
                else:
                    new[key] = picked
            elif kind == "list":
                items = v if isinstance(v, list) else str(v or "").split(",")
                new[key] = [s.strip().upper() for s in items if str(s).strip()]
            elif kind == "map":
                if isinstance(v, dict):
                    new[key] = {str(k).strip().upper(): str(x).strip().upper() for k, x in v.items() if k and x}
                else:
                    pairs, bad = {}, []
                    for part in str(v or "").split(","):
                        if "=" in part:
                            k, x = (p.strip().upper() for p in part.split("=", 1))
                            if k and x:
                                pairs[k] = x
                        elif part.strip():
                            bad.append(part.strip())
                    if bad:
                        errors[key] = f"'{bad[0]}' should look like KASHIF=TRADINGVIEW, e.g. AIHC=AIH."
                    else:
                        new[key] = pairs
        except (TypeError, ValueError):
            errors[key] = "This value isn't valid."
    if "stop_min_pct" not in errors and "stop_max_pct" not in errors and new["stop_min_pct"] >= new["stop_max_pct"]:
        errors["stop_min_pct"] = "The tightest stop must be smaller than the widest stop."
    return new, errors
