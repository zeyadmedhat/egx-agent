"""The GitHub Pages site: the same dashboard with no server. The scan's results are published as encrypted files and
each person's portfolio stays in their own browser (app/static/js/local/).

    python -m app.static_site build --db data/egx.db --out _site     (group password from EGX_SITE_PASSWORD)
    python -m app.static_site strategy                                (site/strategy.yaml from your config.yaml)

Every file under data/ is gzip + AES-256-GCM with a key made from the group password (PBKDF2-SHA256), so only people
you gave the password can read the signals. Nothing personal goes in: no portfolio, no Telegram token.
"""
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sys
from datetime import datetime
from pathlib import Path

import yaml
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from egx_agent import breadth, config, db, scan
from egx_agent.data import prices, shariah

from . import views

STATIC = Path(__file__).resolve().parent / "static"
STRATEGY_PATH = config.ROOT / "site" / "strategy.yaml"
ITERATIONS = 600_000        # PBKDF2 rounds: each guess costs about a second on a phone, so passwords can't be tried fast
SERIES_TAIL = 750           # about 3 years of daily bars per stock page
PAPER_SESSIONS = 60         # the last 60 sessions of BUY signals, so paper accounts can catch up after a break
MIN_PASSWORD = 10
STOCK_COLS = views.SERIES_COLS + ("atr14",)   # the exit rules in the browser need the ATR too


# ------------------------------------------------------------------ encryption
def salt_for(site_id: str) -> bytes:
    """Stays the same for a site, so people's browsers keep working day after day with the same password."""
    return hashlib.sha256(f"egx-trading-agent|{site_id}".encode()).digest()[:16]


def derive_key(password: str, salt: bytes, iterations: int = ITERATIONS) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, 32)


def to_json(obj) -> bytes:
    return json.dumps(views.clean(obj), ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def seal(plain: bytes, key: bytes) -> bytes:
    iv = secrets.token_bytes(12)
    return iv + AESGCM(key).encrypt(iv, gzip.compress(plain, mtime=0), None)


def unseal(box: bytes, key: bytes):
    return json.loads(gzip.decompress(AESGCM(key).decrypt(box[:12], box[12:], None)))


def telegram_code(password: str, site_id: str) -> str:
    """The code in the site's "Connect Telegram" link (t.me/<bot>?start=<code>). It comes from the password, so only
    people who can open the site see it, and a new password makes a new code."""
    key = derive_key(password, salt_for(site_id))
    return base64.urlsafe_b64encode(hmac.new(key, b"telegram link", hashlib.sha256).digest()).decode()[:24]


# ------------------------------------------------------------------ what the site shows
def _scan_history(conn, index_ind, stocks, sessions: int = PAPER_SESSIONS) -> list[dict]:
    """Each recent session with that day's BUY signals and market mood, oldest first (paper trading replays it)."""
    tail = index_ind.tail(sessions)
    if tail.empty:
        return []
    rows = conn.execute(
        """SELECT scan_date, symbol, score, setup, close, entry_high, stop, target, avg_value FROM scans
           WHERE action='BUY' AND scan_date >= ? ORDER BY scan_date, score DESC""", (str(tail.index[0].date()),))
    buys: dict[str, list] = {}
    for r in rows:
        sector = stocks.loc[r["symbol"], "sector"] if r["symbol"] in stocks.index else None
        buys.setdefault(r["scan_date"], []).append({
            "symbol": r["symbol"], "sector": sector or "Other", "score": r["score"], "setup": r["setup"] or "",
            "close": r["close"], "entry_high": r["entry_high"], "entry_limit": r["entry_high"], "stop": r["stop"],
            "target": r["target"], "avg_value": r["avg_value"]})
    return [{"date": str(ts.date()), "risk_off": bool(row["close"] < row["ema50"]), "buys": buys.get(str(ts.date()), [])}
            for ts, row in tail.iterrows()]


def public_data(conn, cfg: dict, backtest: Path | None = None, telegram: dict | None = None) -> dict[str, object]:
    """Every file the site publishes, by name: core, market, predict, backtest and stock/<SYMBOL>."""
    d = views.Data(conn, cfg, views.Cache(), is_admin=False, multi_user=True)
    scan_date, df = views.current_scan(conn)
    signals = views.records(df)
    for r in signals:
        sector = d.table.loc[r["symbol"], "sector"] if r["symbol"] in d.table.index else None
        r["sector"] = sector or "Other"
        high = d.prices(r["symbol"])["high"].tail(20)
        r["trigger"] = float(high.max()) if len(high) else None
        r["to_trigger"] = r["trigger"] / r["close"] - 1 if r["trigger"] and r["close"] else None

    index_ind = d.indicators(prices.INDEX_SYMBOL)
    spark = index = None
    if len(index_ind):
        tail = index_ind.tail(130)
        spark = {"time": [str(t.date()) for t in tail.index], "close": views.column(tail["close"], 2),
                 "ema50": views.column(tail["ema50"], 2)}
        long = index_ind.tail(SERIES_TAIL)
        index = {"time": [str(t.date()) for t in long.index], "close": views.column(long["close"], 2)}
    m = views.market_info(conn)
    b = views.breadth_data(d)
    events = [{"id": f"{r['symbol']}:{r['ex_date']}", "symbol": r["symbol"], "ex_date": r["ex_date"], "factor": r["factor"]}
              for r in conn.execute("SELECT symbol, ex_date, factor FROM price_events ORDER BY ex_date, id")]
    personal_keys = [k for k in config.PERSONAL_KEYS if not k.startswith("telegram_")]
    core = {
        "v": 1, "built": datetime.now().isoformat(timespec="seconds"), "scan_date": scan_date, "market": m or None,
        "final": scan.scan_is_final(conn),     # False: scanned during the session, again after the close
        "signals": signals, "stocks": views.stocks_list(d), "predictions": views.predictions(d),
        "spark": spark, "index": index or {"time": [], "close": []},
        "breadth_today": {**{k: b[k] for k in ("above50", "stocks", "advancers", "decliners")},
                          **breadth.verdict(b, m.get("risk_off") if m else None)} if b else None,
        "strategy": strategy_settings(cfg),
        "personal_defaults": {k: config.DEFAULTS[k] for k in personal_keys},
        "sections": [s for s in views.SETTINGS_SECTIONS if s["scope"] == "personal"],
        "events": events, "data_status": views.settings_view(d)["data"],
        "scans": _scan_history(conn, index_ind, d.table),
        "kashif_url": shariah.stock_url(""), "sell_reasons": views.SELL_REASONS, "telegram": telegram,
    }
    out: dict[str, object] = {"core": core, "market": views.market_view(d), "predict": views.predict_public(d)}
    if backtest and backtest.exists():
        out["backtest"] = json.loads(backtest.read_text(encoding="utf-8"))
    with_prices = {r[0] for r in conn.execute("SELECT DISTINCT symbol FROM prices")}
    for sym in d.table.index:
        if sym in with_prices:
            out[f"stock/{sym}"] = views.stock_public(d, sym, STOCK_COLS, SERIES_TAIL)
    return out


# ------------------------------------------------------------------ the page itself
def _csp(page: str) -> str:
    hashes = " ".join(f"'sha256-{base64.b64encode(hashlib.sha256(s.encode()).digest()).decode()}'"
                      for s in re.findall(r"<script(?:\s[^>]*)?>(.*?)</script>", page, flags=re.S) if s.strip())
    return ("default-src 'self'; script-src 'self' " + hashes + "; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; "
            "form-action 'self'")


def index_html() -> str:
    """The Mac's index.html with relative paths (the site lives under /<repository>/), marked as the static site."""
    page = (STATIC / "index.html").read_text(encoding="utf-8")
    page = page.replace('"/static/', '"./static/').replace('<html lang="en" data-theme="dark">',
                                                           '<html lang="en" data-theme="dark" data-mode="static">')
    extra = ('  <meta name="robots" content="noindex, nofollow">\n'
             '  <meta name="referrer" content="no-referrer">\n'
             '  <meta name="apple-mobile-web-app-capable" content="yes">\n'
             '  <meta name="apple-mobile-web-app-title" content="EGX Agent">\n'
             '  <link rel="manifest" href="manifest.webmanifest">\n')
    page = page.replace('  <title>', extra + '  <title>', 1)
    csp = f'  <meta http-equiv="Content-Security-Policy" content="{_csp(page)}">\n'
    return page.replace('  <meta charset="utf-8">\n', '  <meta charset="utf-8">\n' + csp, 1)


MANIFEST = {"name": "EGX Trading Agent", "short_name": "EGX Agent", "start_url": "./", "scope": "./",
            "display": "standalone", "background_color": "#0f1115", "theme_color": "#0f1115",
            "icons": [{"src": "static/favicon.svg", "sizes": "any", "type": "image/svg+xml"}]}


def build(conn, cfg: dict, out: Path, password: str, site_id: str = "local", backtest: Path | None = None,
          telegram: dict | None = None) -> dict:
    """Write the whole site to `out` (emptied first). `telegram` is {"bot", "link"} when friends can connect
    Telegram. Returns what was published."""
    if len(password or "") < MIN_PASSWORD:
        raise SystemExit(f"The group password must be at least {MIN_PASSWORD} characters.")
    out = Path(out)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(STATIC, out / "static", ignore=shutil.ignore_patterns("index.html", ".DS_Store"))
    (out / "index.html").write_text(index_html(), encoding="utf-8")
    (out / "manifest.webmanifest").write_text(json.dumps(MANIFEST), encoding="utf-8")
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")

    files = public_data(conn, cfg, backtest, telegram)
    plain = {name: to_json(obj) for name, obj in files.items() if name != "core"}
    # The stamp changes only when the content does, so browsers reload only after a real update.
    stamp = hashlib.sha256(b"".join(n.encode() + b"\0" + p for n, p in sorted(plain.items()))
                           + to_json({**files["core"], "built": None})).hexdigest()[:16]
    plain["core"] = to_json({**files["core"], "stamp": stamp})

    salt = salt_for(site_id)
    key = derive_key(password, salt)
    for name, body in plain.items():
        path = out / "data" / f"{name}.bin"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(seal(body, key))
    info = {"v": 1, "salt": base64.b64encode(salt).decode(), "iter": ITERATIONS, "stamp": stamp,
            "built": files["core"]["built"]}
    (out / "data" / "site.json").write_text(json.dumps(info), encoding="utf-8")
    return {"stamp": stamp, "files": len(plain), "stocks": sum(1 for n in plain if n.startswith("stock/")),
            "bytes": sum(p.stat().st_size for p in (out / "data").rglob("*.bin"))}


# ------------------------------------------------------------------ the strategy the site uses
def strategy_settings(cfg: dict) -> dict:
    """The rules everyone on the site shares: your settings without your own numbers or the Telegram token."""
    return {k: cfg[k] for k in config.DEFAULTS if k in cfg and k not in config.PERSONAL_KEYS
            and not k.startswith("telegram_")}


def export_strategy(cfg: dict, path: Path = STRATEGY_PATH) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    head = "# The strategy the website uses, copied from your Mac's settings by 'Publish website.command'.\n"
    path.write_text(head + yaml.safe_dump(strategy_settings(cfg), sort_keys=False, allow_unicode=True),
                    encoding="utf-8")
    return path


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="EGX Trading Agent: the GitHub Pages site")
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="write the site to a folder")
    b.add_argument("--db", default=str(config.DB_PATH))
    b.add_argument("--config", help="settings file (default: config.yaml)")
    b.add_argument("--out", required=True)
    b.add_argument("--backtest", help="a backtest result to show (JSON)")
    b.add_argument("--site-id", default=os.environ.get("GITHUB_REPOSITORY", "local"))
    b.add_argument("--telegram-bot", help="the bot's @username, to show the Connect Telegram button")
    sub.add_parser("strategy", help="copy the strategy from config.yaml to site/strategy.yaml")
    a = p.parse_args(argv)
    if a.cmd == "strategy":
        print(f"Wrote {export_strategy(config.load_config())}")
        return 0
    if a.config:
        config.CONFIG_PATH = Path(a.config)
    password = os.environ.get("EGX_SITE_PASSWORD", "")
    telegram = None
    if a.telegram_bot:
        telegram = {"bot": a.telegram_bot,
                    "link": f"https://t.me/{a.telegram_bot}?start={telegram_code(password, a.site_id)}"}
    conn = db.connect(a.db)
    try:
        res = build(conn, config.load_config(), Path(a.out), password, a.site_id,
                    Path(a.backtest) if a.backtest else None, telegram)
    finally:
        conn.close()
    print(f"Built the site: {res['files']} files ({res['stocks']} stocks), {res['bytes'] / 1e6:.1f} MB, "
          f"stamp {res['stamp']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
