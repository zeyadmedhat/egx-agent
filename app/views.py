"""Data for each dashboard page as JSON-ready dicts. The browser does all the drawing."""
from __future__ import annotations

import json
import math
import sqlite3
import threading
from datetime import date, datetime

import numpy as np
import pandas as pd

from egx_agent import breadth, config, corporate, db, portfolio, predict, risk, scan, strategy
from egx_agent.data import dividends, news, prices, shariah, universe
from egx_agent.indicators import add_indicators

EGX_DAY = pd.offsets.CustomBusinessDay(weekmask="Sun Mon Tue Wed Thu")
STATUS_ORDER = {"ADJUST": 0, "EXIT": 1, "REVIEW": 2, "TIGHTEN STOP": 3, "HOLD": 4, "NO DATA": 5}
ACTION_STATUSES = ("ADJUST", "EXIT", "REVIEW", "TIGHTEN STOP")
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


def sessions_after(day: str, n: int) -> str:
    """Date n EGX sessions after `day` (Sunday–Thursday calendar; public holidays not included)."""
    return str((pd.Timestamp(day) + n * EGX_DAY).date())


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


def open_positions(d: Data, symbol: str | None = None) -> list[dict]:
    fee = d.cfg["fee_pct_per_side"] / 100
    pending = corporate.pending(d.conn, "real")
    dividends = corporate.dividends_by_trade(d.conn, "real")
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
                   "reason": f"Bonus shares or split from {nice_date(ev['ex_date'])}: {ev['describe']}. "
                             "Enter the shares you hold now so the stop and P&L stay right."}
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
            "pnl_pct": worth / float(r.entry_price) - 1,
            "pnl": (worth - r.entry_price) * r.shares - fees - worth * r.shares * fee + div,
            "stop": stt["stop"], "prev_stop": stt.get("prev_stop"), "initial_stop": float(r.initial_stop),
            "target": float(r.target), "day": int(stt["days_held"]),
            "sell_by": sessions_after(r.entry_date, d.cfg["max_hold_days"] - 1),
            "fees": fees, "dividends": div, "notes": r.notes or "", "fills": fills, "adjust": ev,
            "n_buys": sum(1 for f in fills if f["side"] == "buy") or 1,
        })
    out.sort(key=lambda p: (STATUS_ORDER.get(p["status"], 9), p["symbol"]))
    return clean(out)


def status(d: Data) -> dict:
    m = market_info(d.conn)
    positions = open_positions(d)
    _, sig = signals(d)
    mine = {"buys": sum(1 for r in sig if r["action"] == "BUY")}
    return {
        "version": d.version,
        "market": {**{k: m.get(k) for k in ("date", "egx30_close", "egx30_change", "egx30_ema50", "risk_off",
                                            "watches", "finished")}, **mine} if m else None,
        "alerts": sum(1 for p in positions if p["status"] in ACTION_STATUSES),
        "positions": len(positions),
    }


def today(d: Data) -> dict:
    cfg = d.cfg
    m = market_info(d.conn)
    scan_date, rows = signals(d)
    buys, watch = [], []
    preds = predictions(d)
    warn = cautions_map(d)
    for r in [dict(x) for x in rows]:
        r["info"] = d.info(r["symbol"])
        r["pred"] = preds["by_symbol"].get(r["symbol"])
        r["cautions"] = warn.get(r["symbol"], [])
        if r["action"] == "BUY":
            r["sell_by"] = sessions_after(scan_date, cfg["max_hold_days"])
            buys.append(r)
        else:
            px = d.prices(r["symbol"])
            trigger = float(px["high"].tail(20).max()) if len(px) else None
            r["trigger"] = trigger
            r["to_trigger"] = trigger / r["close"] - 1 if trigger and r["close"] else None
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
                    **breadth.verdict(b, m.get("risk_off") if m else None)} if b else None,
        "paper": {"equity": paper["equity"], "return_pct": paper["return_pct"], "open": paper["open_count"],
                  "last_scan": json.loads(paper_scan) if paper_scan else None},
        "model": {k: preds[k] for k in ("base", "count", "date")} if preds["by_symbol"] else None,
        "cfg": {k: cfg[k] for k in ("max_hold_days", "review_day", "riskoff_block_buys", "auto_paper", "buy_score",
                                    "shariah_filter")},
    })


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
    return {"dividends": cash, "yield": y["yield_pct"] / 100 if y and y["yield_pct"] is not None else None,
            "bonus": bonus, "actions": actions}


EVENT_KINDS = ("dividend", "bonus", "split", "rights", "placement", "treasury_buy", "consolidation", "reduction")
HOLD_CALENDAR_DAYS = 30       # about 20 sessions: the longest a trade is held


def cautions_map(d: Data) -> dict[str, list[dict]]:
    """For every stock with something a buyer or holder should know now (an ex-dividend date within a month, bonus
    shares or a rights issue coming, bad news this week): its cautions (data/news.py). The same for everyone."""
    def build():
        today = db.get_meta(d.conn, "scan_data_date") or date.today().isoformat()
        nxt = {r["symbol"]: {"ex_date": r["ex_date"], "amount": r["amount"]} for r in d.conn.execute(
            "SELECT symbol, MIN(ex_date) AS ex_date, amount FROM cash_dividends WHERE ex_date > ? GROUP BY symbol",
            (today,))}
        since = (date.fromisoformat(today) - pd.Timedelta(days=7)).isoformat()
        maybe = {r[0] for r in d.conn.execute(
            "SELECT symbol FROM corp_actions WHERE effective > ? UNION SELECT symbol FROM news "
            "WHERE symbol != '' AND tone < 0 AND published >= ?", (today, since))} | set(nxt)
        out = {}
        for sym in sorted(maybe & set(d.table.index)):
            c = news.cautions(d.conn, sym, today, HOLD_CALENDAR_DAYS, div=nxt.get(sym))
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
    sf = strategy.signal_frame(ind, cfg).iloc[-1]
    # the agent's usual plan if bought at the next open: what the size calculator starts from
    out["plan"] = {"stop": sf.stop, "target": sf.target, "atr": last.atr14}
    out["checklist"] = [   # shown when the stock has no signal today
        {"ok": sf.eligible, "text": f"Liquid & clean data (≥ {cfg['min_avg_value_egp'] / 1e6:g}M EGP/day, "
                                     f"≥ {cfg['min_history_bars']} days of history)"},
        {"ok": sf.trend_ok, "text": "Uptrend: price above its 20- and 50-day averages"},
        {"ok": last.close > last.high20_prev,
         "text": f"Breakout: close above the 20-day high ({last.high20_prev:.2f})"},
        {"ok": last.vol_ratio >= 1.5, "text": f"Volume ≥ 1.5× normal (last session {last.vol_ratio:.1f}×)"},
        {"ok": last.adx14 > 20, "text": f"Trend strength ADX > 20 (now {last.adx14:.0f})"},
    ]
    preds = predictions(d)
    if sym in preds["by_symbol"]:
        out["prediction"] = {**preds["by_symbol"][sym], **{k: preds.get(k) for k in ("base", "count", "date", "top_n")}}
    out["corporate"] = corporate_history(d.conn, sym, last.close)
    out["news"] = news.stock_news(d.conn, sym, 30)
    out["cautions"] = cautions_map(d).get(sym, [])
    shown = ind if tail is None else ind.tail(tail)
    out["series"] = {"time": [str(t.date()) for t in shown.index], **{c: column(shown[c]) for c in cols}}
    if "div" in shown:   # cash dividends by ex-date: the exit rules in the browser move the stop for them too
        paid = shown["div"][shown["div"] > 0]
        out["series"]["divs"] = {str(t.date()): round(float(v), 6) for t, v in paid.items()}
    return out


def screener(d: Data) -> dict:
    """Every stock's numbers for the screener, the same for everyone: the site publishes this, and your own marks
    (your Shariah filter's effect on signals, what you hold) are added where you look (screener_view)."""
    def build():
        preds = predictions(d)["by_symbol"]
        yields = {r["symbol"]: r["yield_pct"] for r in d.conn.execute("SELECT symbol, yield_pct FROM dividend_yield")}
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
                **{k: p.get(k) for k in ("p10", "p20", "top10", "top20")},
                "yield": y / 100 if y is not None else None, "action": action.get(sym),
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
        return clean({"today": today, "updated": updated, "min_value": d.cfg["min_avg_value_egp"], "dividends": cash,
                      "yields": yields, "bonus": bonus, "coming": sorted(coming, key=lambda a: a["effective"])})
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
             "max_pct_of_adv", "fee_pct_per_side", "target_r", "stop_min_pct", "stop_max_pct")


def calc_view(d: Data) -> dict:
    """The size calculator's side of things: your account, your limits and the market's state. The stock's own numbers
    come from its page (stock_detail), and the calculator sizes with the same rule as the BUY signals (risk.py)."""
    real = portfolio.account_summary(d.conn, "real", d.cfg, d.closes())
    m = market_info(d.conn)
    b = breadth_data(d)
    return clean({
        "equity": real["equity"], "cash": real["cash"],
        "positions": portfolio.positions_for_allocation(d.conn, "real", ("open",)),
        "cfg": {k: d.cfg[k] for k in CALC_KEYS},
        "risk_off": bool(m.get("risk_off")) if m else False,
        "switch": breadth.switch(b["above50"]) if b else None,
    })


def stock_detail(d: Data, symbol: str) -> dict:
    sym = symbol.upper()
    out = stock_public(d, sym)
    if not out["has_data"]:
        return clean(out)
    _, sig_rows = signals(d)
    row = [r for r in sig_rows if r["symbol"] == sym]
    levels = []
    if row:
        sig = row[0]
        out["signal"] = sig
        out.pop("checklist")
        if sig["action"] == "BUY":
            levels = [{"label": "Buy up to", "price": sig["entry_high"], "kind": "entry"},
                      {"label": "Stop", "price": sig["stop"], "kind": "stop"},
                      {"label": "Target", "price": sig["target"], "kind": "target"}]

    pos = open_positions(d, sym)
    if pos:
        out["position"] = pos[0]
        levels = [{"label": "Avg price", "price": pos[0]["avg_price"], "kind": "entry"},
                  {"label": "Stop", "price": pos[0]["stop"], "kind": "stop"},
                  {"label": "Target", "price": pos[0]["target"], "kind": "target"}]
    out["levels"] = levels
    out["fills"] = [dict(r) for r in d.conn.execute(
        """SELECT f.date, f.side, SUM(f.shares) AS shares, AVG(f.price) AS price FROM fills f
           JOIN trades t ON t.id = f.trade_id WHERE t.account='real' AND f.symbol=? AND f.side IN ('buy', 'sell')
           GROUP BY f.date, f.side""",
        (sym,))]
    return clean(out)


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
        "fee_pct": cfg["fee_pct_per_side"], "sell_reasons": SELL_REASONS, "max_hold_days": cfg["max_hold_days"],
        "review_day": cfg["review_day"], "max_open_risk_pct": cfg["max_open_risk_pct"],
    })


def history_data(d: Data) -> dict:
    """History that's the same for everyone, for the Journal: every past BUY signal (to tell which of your trades
    followed one) and Egypt's yearly inflation (to show what it took)."""
    def build():
        buys = [{"date": r["scan_date"], "symbol": r["symbol"], "setup": r["setup"]} for r in d.conn.execute(
            "SELECT scan_date, symbol, setup FROM scans WHERE action='BUY' ORDER BY scan_date, symbol")]
        inflation = [{"date": r["date"], "value": r["value"]} for r in d.conn.execute(
            "SELECT date, value FROM macro WHERE series='inflation' AND date >= '2015-01-01' ORDER BY date")]
        return {"buys": buys, "inflation": inflation}
    return d.cache.get(d.version, ("history",), build)


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
        value = (close * px.pivot(index="date", columns="symbol", values="volume").reindex_like(close)).tail(20).mean()
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
        return clean({"movers": out, "highs": sorted(highs), "lows": sorted(lows)})
    return d.cache.get(d.version, ("movers",), build)


def market_view(d: Data) -> dict:
    b = breadth_data(d)
    m = market_info(d.conn)
    if not b:
        return {"breadth": None, "market": m or None}
    return clean({"breadth": b, "verdict": breadth.verdict(b, m.get("risk_off") if m else None), "market": m or None,
                  **movers(d)})


def predictions(d: Data) -> dict:
    """The model's latest numbers per stock, and the average stock's chance to compare them with."""
    def build():
        lt = predict.latest(d.conn)
        meta = predict.load_meta(predict.model_dir(d.conn))
        if lt.empty or not meta:
            return {"by_symbol": {}, "base": None, "count": 0, "date": None}
        base = {hz: (meta["horizons"].get(str(hz), {}).get("all") or {}).get("hit") for hz in predict.HORIZONS}
        # its top 10% each day: the group its tested results are about, so the only chances worth showing
        cut = max(1, math.ceil(len(lt) * TOP_SHARE))
        why = {(r["symbol"], r["horizon"]): r["why"] for r in d.conn.execute(
            "SELECT symbol, horizon, why FROM predictions WHERE date=?", (lt["date"].iloc[0],))}
        by = {}
        for sym, r in lt.iterrows():
            by[sym] = {f"{k}{hz}": r.get(f"{k}{hz}") for hz in predict.HORIZONS for k in ("p", "rank")}
            by[sym].update({f"top{hz}": bool(r.get(f"rank{hz}", cut + 1) <= cut) for hz in predict.HORIZONS})
            # what pushed its score up or down (predict.explain): [{f, up, text}, …]
            by[sym].update({f"why{hz}": json.loads(why.get((sym, hz)) or "null") for hz in predict.HORIZONS})
        return {"by_symbol": clean(by), "base": clean(base), "count": int(len(lt)), "date": lt["date"].iloc[0],
                "top_n": cut}
    return d.cache.get(d.version, ("predictions", db.get_meta(d.conn, "prediction_date"),
                                   db.get_meta(d.conn, "prediction_updated")), build)


HORIZON_KEYS = ("all", "top", "rule", "rule_agree", "rule_disagree", "auc", "lift", "grade", "verdict", "years",
                "groups", "from", "to", "train_n", "good_years", "top_share", "features", "top_ret_cost", "portfolio",
                "portfolio_cost", "chances", "extra_cost", "hold")
TOP_SHARE = 0.10   # the model's top picks: its best 10% each day


def predict_public(d: Data) -> dict:
    """The Predict page without your own marks (which stocks are your signals or in your portfolio)."""
    root = predict.model_dir(d.conn)
    meta = predict.load_meta(root)
    deep = int(db.get_meta(d.conn, "history_years_loaded") or 0) >= prices.DEEP_YEARS
    out: dict = {"model": None, "rows": [], "deep": deep, "deep_years": prices.DEEP_YEARS,
                 "horizons": list(predict.HORIZONS), "retrain_days": predict.RETRAIN_DAYS,
                 "features": {str(hz): len(predict.HORIZON_FEATURES[hz]) for hz in predict.HORIZONS},
                 "levels": {k: d.cfg[k] for k in ("atr_stop_mult", "stop_min_pct", "stop_max_pct", "target_r")}}
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
    for sym, r in lt.iterrows():
        close = float(r["close"])
        out["rows"].append({
            "symbol": sym, "info": d.info(sym), "close": close, "stop": close * (1 - r["stop_pct"]),
            "target": close * (1 + r["target_pct"]), "target_pct": r["target_pct"], "stop_pct": r["stop_pct"],
            **preds["by_symbol"].get(sym, {}),
        })
    out["live"] = predict.live_record(d.conn, since=meta.get("live_since"))
    b = breadth_data(d)
    out["switch"] = breadth.switch(b["above50"]) if b else None
    # the BUY rules with and without it on its test years, whether it still works live, and the 5-day experiment
    out["combo"] = meta.get("combo")
    out["health"] = predict.health(d.conn, meta)
    out["model_picks"] = int(d.cfg.get("model_picks", 0) or 0)
    ex = str(predict.EXPERIMENT)
    if ex in meta["horizons"] and f"rank{ex}" in lt:
        top = lt.sort_values(f"rank{ex}").head(predict.PICKS)
        out["experiment"] = {
            "hz": predict.EXPERIMENT, "test": {k: meta["horizons"][ex].get(k) for k in HORIZON_KEYS},
            "live": out["live"].get(ex), "picks": [{"symbol": s, "info": d.info(s), "close": float(r["close"]),
                                                    "rank": int(r[f"rank{ex}"])} for s, r in top.iterrows()],
        }
    return out


def predict_view(d: Data) -> dict:
    out = predict_public(d)
    if out["model"]:
        _, sig_rows = signals(d)
        action = {r["symbol"]: r["action"] for r in sig_rows}
        held = {p["symbol"] for p in open_positions(d)}
        for row in out["rows"]:
            row.update(action=action.get(row["symbol"]), held=row["symbol"] in held)
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
        _f("fee_pct_per_side", "Fees per buy or sell", 0, 2, 0.01, "%",
           "Commission + EGX, clearing and regulator fees + taxes, for ONE side of a trade. "
           "Check your broker's fee sheet."),
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
    {"title": "Shariah", "fields": [
        {"key": "shariah_filter", "label": "Shariah filter for BUY signals", "kind": "select",
         "options": [{"value": k, "label": v} for k, v in config.SHARIAH_MODES.items()],
         "help": "The EGX33 and Kashif badges always show. This only decides which stocks can get BUY signals."},
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
        _f("atr_stop_mult", "Stop distance", 1, 5, 0.25, "× average daily range"),
        _f("stop_min_pct", "Tightest stop", 1, 20, 0.5, "% below entry"),
        _f("stop_max_pct", "Widest stop", 2, 30, 0.5, "% below entry"),
        _f("target_r", "Target", 1, 6, 0.25, "× the risk",
           "2 means the target is twice as far above entry as the stop is below it."),
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
            elif kind in ("toggle", "choice"):
                new[key] = bool(v)
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
