"""The GitHub Pages site: the same dashboard with no server. The scan's results are published as encrypted files and
each person's portfolio stays in their own browser (app/static/js/local/).

    python -m app.static_site build --db data/egx.db --out _site     (group password from EGX_SITE_PASSWORD)
    python -m app.static_site strategy                                (site/strategy.yaml from your config.yaml)
    python -m app.static_site portfolio-backup --out FILE              (your Mac portfolio, for Restore on the site)

Every file under data/ is gzip + AES-256-GCM with a key made from the group password (PBKDF2-SHA256), so only people
you gave the password can read the signals. Nothing personal goes in: no portfolio, no Telegram token.
The site has no paper trading and no backtest: those stay on the Mac.
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

from egx_agent import breadth, config, db, record, scan
from egx_agent.data import dividends, prices, shariah

from . import views

STATIC = Path(__file__).resolve().parent / "static"
STRATEGY_PATH = config.ROOT / "site" / "strategy.yaml"
ITERATIONS = 600_000        # PBKDF2 rounds: each guess costs about a second on a phone, so passwords can't be tried fast
SERIES_TAIL = 750           # about 3 years of daily bars per stock page
MIN_PASSWORD = 10
MAC_ONLY_KEYS = ("paper_capital", "auto_paper")     # settings for the Mac's paper account
SITE_DEFAULTS = {"shariah_filter": "kashif", "broker": "thndr"}   # friends start with Kashif stocks only, on Thndr
WORKFLOW = "site.yml"       # the GitHub job that scans and publishes the site (.github/workflows/)
# the exit rules in the browser need the ATR and the stop under support too, and a logged buy the chart's target
STOCK_COLS = views.SERIES_COLS + ("atr14", "sup", "ptgt")


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


def scan_page(repo: str) -> str | None:
    """The scan's page on GitHub, for the owner's Run scan button: only someone signed in with access to the
    repository can press Run workflow there."""
    return f"https://github.com/{repo}/actions/workflows/{WORKFLOW}" if re.fullmatch(r"[\w.-]+/[\w.-]+", repo) else None


# ------------------------------------------------------------------ what the site shows
def site_sections() -> list[dict]:
    """The settings each friend has: your personal sections, without the paper account's."""
    out = []
    for s in views.SETTINGS_SECTIONS:
        fields = [f for f in s["fields"] if f["key"] not in MAC_ONLY_KEYS]
        if s["scope"] == "personal" and fields:
            out.append({**s, "fields": fields})
    return out


def personal_keys() -> list[str]:
    """Each friend's own numbers on the site (capital, fees, risk limits, Shariah filter)."""
    return [k for k in config.PERSONAL_KEYS if not k.startswith("telegram_") and k not in MAC_ONLY_KEYS]


def public_data(conn, cfg: dict, telegram: dict | None = None, scan_url: str | None = None) -> dict[str, object]:
    """Every file the site publishes, by name: core, market, predict and stock/<SYMBOL>."""
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
    core = {
        "v": 1, "built": datetime.now().isoformat(timespec="seconds"), "scan_date": scan_date, "market": m or None,
        "final": scan.scan_is_final(conn),     # False: scanned during the session, again after the close
        "signals": signals, "stocks": views.stocks_list(d), "predictions": views.predictions(d),
        "spark": spark, "index": index or {"time": [], "close": []},
        "breadth_today": {**{k: b[k] for k in ("above50", "stocks", "advancers", "decliners")},
                          **breadth.verdict(b, m.get("risk_off") if m else None)} if b else None,
        "strategy": strategy_settings(cfg),
        "personal_defaults": {k: SITE_DEFAULTS.get(k, config.DEFAULTS[k]) for k in personal_keys()},
        "sections": site_sections(),
        "events": events, "data_status": views.settings_view(d)["data"],
        "kashif_url": shariah.stock_url(""), "sell_reasons": views.SELL_REASONS, "telegram": telegram,
        "scan_url": scan_url, "cautions": views.cautions_map(d),
        # each stock's next cash dividend: a holder lowers the stop by it before the ex-date (views.exdiv_item)
        "dividends_coming": dividends.coming(conn, scan_date or datetime.now().date().isoformat()),
        # every BUY published so far and how it went, and what the rules' past signals did by score (record.py)
        "record": views.signal_record(d), "odds": record.public_odds(record.stored_odds(conn)),
        # the dollar, gold, interest rate and inflation now: the zakat and certificate calculators
        "money": views.money_rates(conn),
        "company": views.company_brief(d),     # each company's results in brief: the BUY cards and Close to a BUY
    }
    out: dict[str, object] = {"core": core, "market": views.market_view(d), "egx30": views.index_view(d),
                              "predict": views.predict_public(d),
                              "screener": views.screener(d), "history": views.history_data(d),
                              "dividends": views.dividend_calendar(d), "news": views.news_feed(d)}
    with_prices = {r[0] for r in conn.execute("SELECT DISTINCT symbol FROM prices")}
    hourly = {r[0] for r in conn.execute("SELECT DISTINCT symbol FROM intraday")}
    for sym in d.table.index:
        if sym in with_prices:
            out[f"stock/{sym}"] = views.stock_public(d, sym, STOCK_COLS, SERIES_TAIL)
        if sym in hourly:      # the 1-hour and 4-hour charts, loaded only when someone picks them
            out[f"intraday/{sym}"] = views.stock_intraday(d, sym)
    return out


# ------------------------------------------------------------------ the page itself
def _csp(page: str, connect: str = "") -> str:
    hashes = " ".join(f"'sha256-{base64.b64encode(hashlib.sha256(s.encode()).digest()).decode()}'"
                      for s in re.findall(r"<script(?:\s[^>]*)?>(.*?)</script>", page, flags=re.S) if s.strip())
    return ("default-src 'self'; script-src 'self' " + hashes + "; style-src 'self' 'unsafe-inline'; "
            f"img-src 'self' data:; connect-src 'self'{' ' + connect if connect else ''}; font-src 'self'; "
            "object-src 'none'; base-uri 'self'; frame-src https://s.tradingview.com https://www.tradingview-widget.com; "
            "form-action 'self'")


def _origin(url: str | None) -> str:
    m = re.match(r"^https://[A-Za-z0-9.-]+", url or "")
    return m.group(0) if m else ""


def code_version() -> str:
    """A fingerprint of the page's code: its files are published under static/<this>/, so a browser can't keep using
    an old copy after an update (it would otherwise, for up to hours on some browsers and phones)."""
    h = hashlib.sha256()
    for f in sorted(STATIC.rglob("*")):
        if f.is_file() and f.name != ".DS_Store":
            h.update(str(f.relative_to(STATIC)).encode() + f.read_bytes())
    return h.hexdigest()[:10]


def index_html(worker: str | None = None, version: str = "") -> str:
    """The Mac's index.html with relative paths (the site lives under /<repository>/), marked as the static site.
    `worker`: the Telegram bot's Worker, the one other address the page may send to (your portfolio, if you link it)."""
    page = (STATIC / "index.html").read_text(encoding="utf-8")
    page = page.replace('"/static/', f'"./static/{version + "/" if version else ""}').replace('<html lang="en" data-theme="dark">',
                                                           '<html lang="en" data-theme="dark" data-mode="static">')
    extra = ('  <meta name="robots" content="noindex, nofollow">\n'
             '  <meta name="referrer" content="no-referrer">\n'
             '  <meta name="apple-mobile-web-app-capable" content="yes">\n'
             '  <meta name="apple-mobile-web-app-title" content="EGX Agent">\n'
             '  <link rel="manifest" href="manifest.webmanifest">\n' + RELOAD_ON_OLD_PAGE)
    page = page.replace('  <title>', extra + '  <title>', 1)
    csp = f'  <meta http-equiv="Content-Security-Policy" content="{_csp(page, _origin(worker))}">\n'
    return page.replace('  <meta charset="utf-8">\n', '  <meta charset="utf-8">\n' + csp, 1)


# A browser may keep the front page for 10 minutes (GitHub Pages' rule) and ask for page code an update has removed:
# then it gets a fresh front page and reloads, once a minute at most, instead of showing an empty screen.
RELOAD_ON_OLD_PAGE = """  <script>
    addEventListener('error', function (e) {
      var src = e.target && (e.target.src || e.target.href) || '';
      if (src.indexOf('static/') < 0) return;
      try {
        if (Date.now() - (+sessionStorage.getItem('egx-reloaded') || 0) < 60000) return;
        sessionStorage.setItem('egx-reloaded', String(Date.now()));
      } catch (x) { return; }
      fetch('./', { cache: 'reload' }).then(function () { location.reload(); }, function () {});
    }, true);
  </script>
"""
SERVICE_WORKER = Path(__file__).resolve().parent / "sw.js"


def service_worker(version: str, out: Path) -> str:
    """app/sw.js with this version's page code listed, so it's kept on the device for offline use."""
    files = sorted(f"static/{version}/{p.relative_to(out / 'static' / version).as_posix()}"
                   for p in (out / "static" / version).rglob("*") if p.is_file())
    return (SERVICE_WORKER.read_text(encoding="utf-8").replace("__VERSION__", version)
            .replace("__FILES__", json.dumps(files)))


MANIFEST = {"name": "EGX Trading Agent", "short_name": "EGX Agent", "start_url": "./", "scope": "./",
            "display": "standalone", "background_color": "#0f1115", "theme_color": "#0f1115",
            "icons": [{"src": "static/favicon.svg", "sizes": "any", "type": "image/svg+xml"}]}


def build(conn, cfg: dict, out: Path, password: str, site_id: str = "local", telegram: dict | None = None,
          scan_url: str | None = None) -> dict:
    """Write the whole site to `out` (emptied first). `telegram` is {"bot", "link"} when friends can connect
    Telegram; `scan_url` is the scan's page on GitHub, for the owner's Run scan button. Returns what was published."""
    if len(password or "") < MIN_PASSWORD:
        raise SystemExit(f"The group password must be at least {MIN_PASSWORD} characters.")
    out = Path(out)
    if out.exists():
        shutil.rmtree(out)
    ver = code_version()
    shutil.copytree(STATIC, out / "static" / ver, ignore=shutil.ignore_patterns("index.html", ".DS_Store"))
    (out / "index.html").write_text(index_html((telegram or {}).get("worker"), ver), encoding="utf-8")
    manifest = {**MANIFEST, "icons": [{**MANIFEST["icons"][0], "src": f"static/{ver}/favicon.svg"}]}
    (out / "manifest.webmanifest").write_text(json.dumps(manifest), encoding="utf-8")
    (out / "sw.js").write_text(service_worker(ver, out), encoding="utf-8")
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")

    files = public_data(conn, cfg, telegram, scan_url)
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
    # worker: the Telegram bot's address (already in the page's security header), for opening inside Telegram
    info = {"v": 1, "salt": base64.b64encode(salt).decode(), "iter": ITERATIONS, "stamp": stamp,
            "built": files["core"]["built"], "worker": (telegram or {}).get("worker")}
    (out / "data" / "site.json").write_text(json.dumps(info), encoding="utf-8")
    return {"stamp": stamp, "files": len(plain), "stocks": sum(1 for n in plain if n.startswith("stock/")),
            "bytes": sum(p.stat().st_size for p in (out / "data").rglob("*.bin"))}


# ------------------------------------------------------------------ your Mac portfolio, for the site
def portfolio_backup(conn, cfg: dict) -> dict:
    """Your Mac portfolio (real trades, transactions, dividends, bonus-share updates and your own numbers) as a site
    backup file: Settings → Restore from a backup on the site loads it into that browser. It's written on this
    computer only; nothing here is published. Paper trades stay on the Mac."""
    count = 0

    def new_id() -> int:          # the site numbers everything in a book from one counter
        nonlocal count
        count += 1
        return count

    ids: dict[int, int] = {}
    trades = []
    for r in conn.execute("SELECT * FROM trades WHERE account = 'real' ORDER BY id"):
        ids[r["id"]] = new_id()
        trades.append({**dict(r), "id": ids[r["id"]]})
    fills = [{**dict(r), "id": new_id(), "trade_id": ids[r["trade_id"]]}
             for r in conn.execute("SELECT * FROM fills ORDER BY id") if r["trade_id"] in ids]
    dividends = [{**dict(r), "id": new_id(), "trade_id": ids[r["trade_id"]]}
                 for r in conn.execute("SELECT * FROM dividends ORDER BY id") if r["trade_id"] in ids]
    events = {r["id"]: f"{r['symbol']}:{r['ex_date']}" for r in conn.execute("SELECT id, symbol, ex_date FROM price_events")}
    adjustments = [{**dict(r), "event_id": events[r["event_id"]], "trade_id": ids[r["trade_id"]]}
                   for r in conn.execute("SELECT * FROM position_adjustments ORDER BY date")
                   if r["trade_id"] in ids and r["event_id"] in events]
    book = {"v": 1, "next_id": count + 1, "trades": trades, "fills": fills, "dividends": dividends,
            "adjustments": adjustments, "checklist": {}, "settings": {k: cfg[k] for k in personal_keys() if k in cfg},
            "meta": {}, "watchlist": json.loads(db.get_user_meta(conn, "watchlist") or "[]")}
    return {"app": "egx-trading-agent", "kind": "portfolio-backup",
            "exported": datetime.now().isoformat(timespec="seconds"), "book": book}


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
    b.add_argument("--site-id", default=os.environ.get("GITHUB_REPOSITORY", "local"))
    b.add_argument("--telegram-bot", help="the bot's @username, to show the Connect Telegram button")
    b.add_argument("--github-repo", help="OWNER/REPO, to show the owner's Run scan button (it opens the scan there)")
    sub.add_parser("strategy", help="copy the strategy from config.yaml to site/strategy.yaml")
    pb = sub.add_parser("portfolio-backup", help="save your Mac portfolio as a file the site can restore")
    pb.add_argument("--db", default=str(config.DB_PATH))
    pb.add_argument("--out", required=True)
    a = p.parse_args(argv)
    if a.cmd == "strategy":
        print(f"Wrote {export_strategy(config.load_config())}")
        return 0
    if a.cmd == "portfolio-backup":
        conn = db.connect(a.db)
        try:
            backup = portfolio_backup(conn, config.load_config())
        finally:
            conn.close()
        Path(a.out).write_text(json.dumps(backup, ensure_ascii=False, indent=1), encoding="utf-8")
        n = sum(1 for t in backup["book"]["trades"] if t["status"] == "open")
        print(f"Wrote {a.out}: {n} open position{'' if n == 1 else 's'}, {len(backup['book']['trades'])} trades in all")
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
        res = build(conn, config.load_config(), Path(a.out), password, a.site_id, telegram,
                    scan_page(a.github_repo) if a.github_repo else None)
    finally:
        conn.close()
    print(f"Built the site: {res['files']} files ({res['stocks']} stocks), {res['bytes'] / 1e6:.1f} MB, "
          f"stamp {res['stamp']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
