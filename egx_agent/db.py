"""SQLite storage: prices, stock info (Kashif + index membership), scans and trades.

On your Mac everything is in data/egx.db. On the website the shared market data is in data/market.db and
each person's own data in data/users/<id>.db (see connect_market and connect_person).
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path

import pandas as pd

from .config import DB_PATH

# Shared by everyone: prices, stock info, scans, bonus-share events, the prediction model's numbers.
MARKET_SCHEMA = """
CREATE TABLE IF NOT EXISTS prices (
    symbol TEXT NOT NULL,
    date   TEXT NOT NULL,            -- YYYY-MM-DD
    open REAL, high REAL, low REAL, close REAL, volume REAL,
    PRIMARY KEY (symbol, date)
);
CREATE TABLE IF NOT EXISTS stocks (
    symbol TEXT PRIMARY KEY,
    name_ar TEXT,
    sector_ar TEXT,
    kashif_status TEXT,             -- compliant | non_compliant | awaiting | blocked | NULL
    kashif_label TEXT,              -- Kashif's own label, e.g. "🟢 متوافق مع الشريعة"
    purity TEXT,
    purification_pct TEXT,
    statements_date TEXT,
    egx30 INTEGER DEFAULT 0,
    egx70 INTEGER DEFAULT 0,
    egx33 INTEGER DEFAULT 0,
    kashif_updated TEXT,
    price_missing_since TEXT,       -- set when no usable price history exists for the symbol
    price_note TEXT                 -- why: not found / never traded / suspended
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS scans (
    scan_date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    action TEXT NOT NULL,           -- BUY | WATCH
    score REAL,
    setup TEXT,
    close REAL, entry_high REAL, stop REAL, target REAL, atr REAL,
    avg_value REAL,
    shares INTEGER, amount REAL, risk_egp REAL, size_note TEXT,
    reasons TEXT,                   -- JSON list
    PRIMARY KEY (scan_date, symbol)
);
CREATE TABLE IF NOT EXISTS price_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    ex_date TEXT NOT NULL,          -- first session on the new price basis
    factor REAL NOT NULL,           -- old price ÷ new price: 1.25 = 1 free share for every 4 held
    detected TEXT NOT NULL,         -- when TradingView's re-based history was noticed
    UNIQUE (symbol, ex_date)
);
CREATE TABLE IF NOT EXISTS predictions (
    date TEXT NOT NULL,             -- the session the prediction was made after (its close)
    symbol TEXT NOT NULL,
    horizon INTEGER NOT NULL,       -- sessions allowed to reach the target (10 or 20)
    prob REAL NOT NULL,             -- the model's chance of target before stop (calibrated)
    raw REAL,                       -- the model's raw score, used to rank stocks on the same day
    close REAL,
    stop_pct REAL,                  -- stop and target as % from that close
    target_pct REAL,
    created TEXT,
    hit INTEGER,                    -- filled in later: 1 target first, 0 stop first or time ran out
    ret REAL,                       -- the trade's result after fees
    resolved TEXT,                  -- 'done' or 'cancelled' (opened below the stop, or couldn't be bought that day)
    PRIMARY KEY (date, symbol, horizon)
);
CREATE TABLE IF NOT EXISTS macro (
    series TEXT NOT NULL,           -- usdegp | interbank | inflation | egx70 (see data/macro.py)
    date   TEXT NOT NULL,           -- YYYY-MM-DD, as the source dates it
    value  REAL NOT NULL,
    PRIMARY KEY (series, date)
);
CREATE TABLE IF NOT EXISTS cash_dividends (
    symbol TEXT NOT NULL,           -- every company's cash dividends, from TradingView (data/dividends.py)
    ex_date TEXT NOT NULL,          -- buy before this day to get it
    pay_date TEXT,
    amount REAL,                    -- EGP per share
    first_seen TEXT,
    PRIMARY KEY (symbol, ex_date)
);
CREATE TABLE IF NOT EXISTS watch_alerts (
    chat_id TEXT NOT NULL,          -- a connected friend's Telegram chat (the website's bot, app/alerts.py)
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL,             -- buy (a BUY signal) | above | below (a close past the price)
    price REAL,
    created TEXT,
    fired TEXT,                     -- the close a buy alert was last sent for
    PRIMARY KEY (chat_id, symbol, kind)
);
CREATE TABLE IF NOT EXISTS news (
    id TEXT NOT NULL,               -- the source's own id (data/news.py)
    symbol TEXT NOT NULL DEFAULT '',-- the stock it's about ('' = market news)
    source TEXT NOT NULL,           -- mubasher | reuters | zawya | dow-jones | alborsa | dne
    lang TEXT,                      -- ar | en
    published TEXT NOT NULL,        -- YYYY-MM-DDTHH:MM, Cairo time
    title TEXT NOT NULL,
    url TEXT,
    tags TEXT,                      -- comma-separated topics (dividend, results, legal, …), from keyword rules
    tone INTEGER,                   -- 1 good, -1 bad, 0 neutral (keyword rules: a guide only)
    first_seen TEXT,
    PRIMARY KEY (id, symbol)
);
CREATE INDEX IF NOT EXISTS news_by_symbol ON news(symbol, published);
CREATE INDEX IF NOT EXISTS news_by_date ON news(published);
CREATE TABLE IF NOT EXISTS corp_actions (
    symbol TEXT NOT NULL,           -- Mubasher's corporate actions, from the exchange's filings (data/news.py)
    kind TEXT NOT NULL,             -- dividend | bonus | split | rights | placement | treasury_buy | … | other
    type TEXT NOT NULL,             -- Mubasher's own name for it
    announced TEXT NOT NULL,        -- YYYY-MM-DD, '' if unknown
    effective TEXT NOT NULL,        -- the ex-date (end of rights), '' if none yet
    note TEXT,
    first_seen TEXT,
    PRIMARY KEY (symbol, type, announced, effective)
);
CREATE TABLE IF NOT EXISTS dividend_history (
    symbol TEXT NOT NULL,           -- every past cash dividend, from TradingView's dividend-adjusted prices
    ex_date TEXT NOT NULL,          -- first session without it (data/dividends.py)
    yield REAL NOT NULL,            -- the dividend ÷ the close the session before (the price drop it explains)
    PRIMARY KEY (symbol, ex_date)
);
CREATE TABLE IF NOT EXISTS earnings (
    symbol TEXT PRIMARY KEY,        -- when each company's results come, from TradingView (data/dividends.py)
    next_date TEXT,                 -- TradingView's expected date for the next results ('' if none or unreliable)
    last_date TEXT,                 -- the last results TradingView has
    updated TEXT
);
CREATE TABLE IF NOT EXISTS dividend_yield (
    symbol TEXT PRIMARY KEY,
    yield_pct REAL,                 -- the last 12 months' cash dividends ÷ the price (%), TradingView's figure
    updated TEXT
);
"""

# One person's own data: their trades, paper account, dividends, orders checklist and settings.
PERSONAL_SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,          -- real | paper
    status TEXT NOT NULL,           -- pending | open | closed | cancelled
    symbol TEXT NOT NULL,
    sector TEXT,
    signal_date TEXT,               -- paper: scan date that created the order
    entry_date TEXT,
    entry_price REAL,
    shares INTEGER,
    initial_stop REAL,
    stop REAL,
    target REAL,
    entry_limit REAL,               -- paper: don't chase gaps above this
    highest_close REAL,
    days_held INTEGER DEFAULT 0,
    exit_next_open TEXT,            -- reason, when a close-based exit fires
    last_bar_date TEXT,             -- paper: last bar processed
    exit_date TEXT,
    exit_price REAL,
    exit_reason TEXT,
    fees REAL DEFAULT 0,
    notes TEXT
);
CREATE TABLE IF NOT EXISTS fills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id INTEGER NOT NULL,      -- the position (trades.id) this buy or sell belongs to
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,             -- YYYY-MM-DD
    side TEXT NOT NULL,             -- buy | sell
    shares INTEGER NOT NULL,
    price REAL NOT NULL,
    fees REAL DEFAULT 0,
    note TEXT
);
CREATE TABLE IF NOT EXISTS position_adjustments (
    event_id INTEGER NOT NULL,      -- price_events.id
    trade_id INTEGER NOT NULL,      -- trades.id
    action TEXT NOT NULL,           -- applied | ignored
    ratio REAL,                     -- new shares ÷ old shares
    date TEXT NOT NULL,
    PRIMARY KEY (event_id, trade_id)
);
CREATE TABLE IF NOT EXISTS dividends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id INTEGER NOT NULL,      -- the position that received it
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,
    shares INTEGER NOT NULL,        -- shares held at the time
    amount REAL NOT NULL,           -- EGP received, as your broker paid it
    note TEXT
);
CREATE TABLE IF NOT EXISTS checklist (
    session TEXT NOT NULL,          -- the trading day the orders are for
    item TEXT NOT NULL,             -- e.g. "buy:COMI"
    done_at TEXT NOT NULL,
    PRIMARY KEY (session, item)
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,           -- your own numbers on the shared website (capital, risk, Shariah filter…)
    value TEXT                      -- JSON
);
CREATE TABLE IF NOT EXISTS user_meta (
    key TEXT PRIMARY KEY,           -- your own status values, e.g. when Telegram last sent you a message
    value TEXT
);
"""
PERSONAL_TABLES = ("trades", "fills", "position_adjustments", "dividends", "checklist", "settings", "user_meta")

SCHEMA = MARKET_SCHEMA + PERSONAL_SCHEMA   # your Mac keeps everything in one file


def _open(path: Path | str) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _add_columns(conn: sqlite3.Connection, pairs) -> None:
    """Columns added after a table was first made: (table, column) is TEXT, (table, column, type) that type."""
    for table, column, *kind in pairs:
        cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if column not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind[0] if kind else 'TEXT'}")


# scans.priority: the model's rank that day (1 = its best), the order BUYs get money in; scans.source: why it's a
# BUY (rules | model); predictions.why: what pushed the model's score up or down; stocks.listed_by: where the stock
# came from (NULL = Kashif, tradingview = TradingView's EGX list, for stocks Kashif doesn't cover)
MARKET_COLUMNS = (("stocks", "price_note"), ("stocks", "listed_by"), ("scans", "priority", "REAL"),
                  ("scans", "source"), ("predictions", "why"))


def connect(path: Path | str = DB_PATH) -> sqlite3.Connection:
    """One file with everything: the market data and your own portfolio (the dashboard on your Mac)."""
    conn = _open(path)
    conn.executescript(SCHEMA)
    _add_columns(conn, (("trades", "sector"), *MARKET_COLUMNS))
    for key in ("telegram_sent_for", "telegram_last_sent", "telegram_error", "telegram_chat_name"):
        # these used to live in meta; now they're yours (user_meta), so bring over the old values once
        conn.execute("INSERT OR IGNORE INTO user_meta(key, value) SELECT key, value FROM meta WHERE key=?", (key,))
    conn.commit()
    return conn


def connect_market(path: Path | str) -> sqlite3.Connection:
    """The shared market file of the website (no personal tables in it)."""
    conn = _open(path)
    conn.executescript(MARKET_SCHEMA)
    _add_columns(conn, MARKET_COLUMNS)
    return conn


def connect_person(path: Path | str, market_path: Path | str) -> sqlite3.Connection:
    """One person's file on the website, with the shared market file attached.

    SQLite looks up a table name in the person's file first, then in the market file, so the same queries work
    as on your Mac. The person's file must never contain market tables: an empty copy would hide the real one.
    """
    conn = _open(path)
    conn.executescript(PERSONAL_SCHEMA)
    _add_columns(conn, (("trades", "sector"),))
    conn.execute("ATTACH DATABASE ? AS market", (str(market_path),))
    return conn


def get_meta(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, value))
    conn.commit()


def get_user_meta(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM user_meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_user_meta(conn: sqlite3.Connection, key: str, value: str | None) -> None:
    if value is None:
        conn.execute("DELETE FROM user_meta WHERE key=?", (key,))
    else:
        conn.execute("INSERT OR REPLACE INTO user_meta(key, value) VALUES (?, ?)", (key, value))
    conn.commit()


def personal_settings(conn: sqlite3.Connection) -> dict:
    return {r["key"]: json.loads(r["value"]) for r in conn.execute("SELECT key, value FROM settings")}


def save_personal_settings(conn: sqlite3.Connection, values: dict) -> None:
    conn.executemany("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)",
                     [(k, json.dumps(v)) for k, v in values.items()])
    conn.commit()


def add_price_event(conn: sqlite3.Connection, symbol: str, ex_date: str, factor: float) -> None:
    """Remember that a stock's history was re-based (bonus shares or a split) from ex_date on."""
    conn.execute(
        """INSERT INTO price_events(symbol, ex_date, factor, detected) VALUES (?,?,?,?)
           ON CONFLICT(symbol, ex_date) DO UPDATE SET factor=excluded.factor""",
        (symbol, ex_date, float(factor), datetime.now().isoformat(timespec="seconds")),
    )
    conn.commit()


def upsert_prices(conn: sqlite3.Connection, symbol: str, df: pd.DataFrame) -> int:
    rows = [
        (symbol, d, float(r.open), float(r.high), float(r.low), float(r.close), float(r.volume))
        for d, r in zip(df["date"], df.itertuples(index=False))
    ]
    conn.executemany(
        "INSERT OR REPLACE INTO prices(symbol, date, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?)",
        rows,
    )
    conn.commit()
    return len(rows)


def delete_prices(conn: sqlite3.Connection, symbol: str) -> None:
    conn.execute("DELETE FROM prices WHERE symbol=?", (symbol,))
    conn.commit()


def load_prices(conn: sqlite3.Connection, symbol: str) -> pd.DataFrame:
    df = pd.read_sql_query(
        "SELECT date, open, high, low, close, volume FROM prices WHERE symbol=? ORDER BY date",
        conn,
        params=(symbol,),
    )
    df["date"] = pd.to_datetime(df["date"])
    return df.set_index("date")


def last_price_date(conn: sqlite3.Connection, symbol: str) -> str | None:
    row = conn.execute("SELECT MAX(date) AS d FROM prices WHERE symbol=?", (symbol,)).fetchone()
    return row["d"] if row else None


def upsert_macro(conn: sqlite3.Connection, series: str, df: pd.DataFrame) -> int:
    """df: columns date (YYYY-MM-DD) and close."""
    rows = [(series, d, float(v)) for d, v in zip(df["date"], df["close"])]
    conn.executemany("INSERT OR REPLACE INTO macro(series, date, value) VALUES (?,?,?)", rows)
    conn.commit()
    return len(rows)


def load_macro(conn: sqlite3.Connection) -> pd.DataFrame:
    """Every Egypt series as a column, by date (empty when nothing was downloaded yet)."""
    df = pd.read_sql_query("SELECT series, date, value FROM macro", conn)
    if df.empty:
        return pd.DataFrame()
    wide = df.pivot(index="date", columns="series", values="value")
    wide.index = pd.to_datetime(wide.index)
    return wide.sort_index()


def stocks_df(conn: sqlite3.Connection) -> pd.DataFrame:
    return pd.read_sql_query("SELECT * FROM stocks ORDER BY symbol", conn).set_index("symbol", drop=False)


def save_scan(conn: sqlite3.Connection, scan_date: str, rows: list[dict]) -> None:
    conn.execute("DELETE FROM scans WHERE scan_date=?", (scan_date,))
    conn.executemany(
        """INSERT INTO scans(scan_date, symbol, action, score, setup, close, entry_high, stop, target, atr,
               avg_value, shares, amount, risk_egp, size_note, reasons, priority, source)
           VALUES (:scan_date, :symbol, :action, :score, :setup, :close, :entry_high, :stop, :target, :atr,
               :avg_value, :shares, :amount, :risk_egp, :size_note, :reasons, :priority, :source)""",
        [{"priority": None, "source": "rules", **r, "scan_date": scan_date,
          "reasons": json.dumps(r.get("reasons", []), ensure_ascii=False)} for r in rows],
    )
    conn.commit()


def latest_scan(conn: sqlite3.Connection) -> tuple[str | None, pd.DataFrame]:
    row = conn.execute("SELECT MAX(scan_date) AS d FROM scans").fetchone()
    scan_date = row["d"] if row else None
    if not scan_date:
        return None, pd.DataFrame()
    df = pd.read_sql_query("SELECT * FROM scans WHERE scan_date=? ORDER BY score DESC", conn, params=(scan_date,))
    df["reasons"] = df["reasons"].map(lambda s: json.loads(s) if s else [])
    return scan_date, df
