"""Mubasher's stock news and owners lists, read on your Mac and sent to the website's run.

After each daily run the Mac locks what it read from Mubasher (gzip + AES-256-GCM, the key made from the Telegram bot
token, which only the Mac and the website's secrets know) and puts it on the repository's "mac-feed" release. The
website's run downloads it (.github/workflows/site.yml) and adds what's new: more stocks' news than its own rotation
reaches, and the owners lists, which it then leaves to the Mac while the file is under news.MAC_FRESH old.
(Built in Oct 2026 when Mubasher's stock pages seemed to refuse GitHub; it was a few broken pages stopping the
queue, see news.BROKEN. The website reads the stock news itself too.)

    python -m app.macfeed send                                     # on the Mac (app/daily.py does it)
    python -m app.macfeed apply --file _macfeed/mubasher.egxm      # the website's run (app/site_daily.py does it)
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import secrets
import shutil
import sqlite3
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from egx_agent import config, db

from .backup import _key

MAGIC = b"EGXM1"
RELEASE = "mac-feed"                      # the GitHub release the file sits on (replaced each time)
FILE = config.ROOT / "data" / "macfeed" / "mubasher.egxm"
NEWS_DAYS = 45                            # the headlines sent: a stock's Mubasher news of the last 45 days
RESEND = timedelta(hours=20)              # an unchanged file is sent again after this, so the website knows it's fresh
NEWS_COLS = ("id", "symbol", "source", "lang", "published", "title", "url", "tags", "tone", "first_seen")
OWNER_COLS = ("symbol", "holders", "free_float", "updated")


def export(conn: sqlite3.Connection) -> dict:
    since = (datetime.now() - timedelta(days=NEWS_DAYS)).strftime("%Y-%m-%d")
    news = conn.execute(f"SELECT {','.join(NEWS_COLS)} FROM news WHERE source = 'mubasher' AND symbol != '' "
                        "AND published >= ? ORDER BY published, id, symbol", (since,)).fetchall()
    owners = conn.execute(f"SELECT {','.join(OWNER_COLS)} FROM ownership ORDER BY symbol").fetchall()
    return {"news": [list(r) for r in news], "owners": [list(r) for r in owners]}


def lock(payload: dict, token: str) -> bytes:
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    plain = gzip.compress(json.dumps(payload, ensure_ascii=False).encode(), 6)
    return MAGIC + salt + iv + AESGCM(_key(token, salt)).encrypt(iv, plain, MAGIC)


def unlock(box: bytes, token: str) -> dict:
    if not box.startswith(MAGIC) or len(box) < len(MAGIC) + 28:
        raise ValueError("not a Mac file")
    salt, iv, body = box[5:21], box[21:33], box[33:]
    try:
        return json.loads(gzip.decompress(AESGCM(_key(token, salt)).decrypt(iv, body, MAGIC)))
    except InvalidTag:
        raise ValueError("it doesn't open with this bot token (the Mac's and GitHub's must be the same)") from None


def upload(path: Path) -> None:
    env = dict(os.environ)
    if (Path.home() / ".gh-config").is_dir():          # this Mac keeps gh's sign-in there (~/.config is root's)
        env.setdefault("GH_CONFIG_DIR", str(Path.home() / ".gh-config"))
    gh = shutil.which("gh") or "/opt/homebrew/bin/gh"   # the scheduled run's PATH is short
    subprocess.run([gh, "release", "upload", RELEASE, str(path), "--clobber"], cwd=config.ROOT, env=env,
                   check=True, capture_output=True, timeout=180)


def send(conn: sqlite3.Connection, cfg: dict, now: datetime | None = None, up=upload) -> str:
    """On the Mac: lock and upload what it read from Mubasher, unless it's unchanged and was sent lately."""
    token = (cfg.get("telegram_token") or "").strip()
    if not token:
        return "not sent (no Telegram bot token in the settings)"
    now = now or datetime.now()
    payload = export(conn)
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    last = json.loads(db.get_meta(conn, "mac_feed_sent") or "{}")
    if last.get("hash") == digest and now - datetime.fromisoformat(last["at"]) < RESEND:
        return "unchanged"
    FILE.parent.mkdir(parents=True, exist_ok=True)
    FILE.write_bytes(lock({**payload, "made": now.isoformat(timespec="seconds")}, token))
    up(FILE)
    db.set_meta(conn, "mac_feed_sent", json.dumps({"at": now.isoformat(timespec="seconds"), "hash": digest}))
    return f"sent ({len(payload['news'])} headlines, {len(payload['owners'])} owners lists)"


def apply(conn: sqlite3.Connection, path: Path, token: str) -> str:
    """On the website's run: add the Mac's headlines and its newer owners lists."""
    data = unlock(path.read_bytes(), token)
    if data["made"] <= (db.get_meta(conn, "mac_feed") or ""):
        return "nothing newer from the Mac"
    before = conn.total_changes
    conn.executemany(f"INSERT OR IGNORE INTO news({','.join(NEWS_COLS)}) VALUES ({','.join('?' * len(NEWS_COLS))})",
                     data["news"])
    new = conn.total_changes - before
    conn.executemany(f"INSERT INTO ownership({','.join(OWNER_COLS)}) VALUES (?,?,?,?) ON CONFLICT(symbol) DO UPDATE "
                     "SET holders=excluded.holders, free_float=excluded.free_float, updated=excluded.updated "
                     "WHERE excluded.updated > COALESCE(ownership.updated, '')", data["owners"])
    conn.commit()
    db.set_meta(conn, "mac_feed", data["made"])
    if new:
        db.set_meta(conn, "news_updated", datetime.now().isoformat(timespec="seconds"))
    return f"{new} new headlines, {len(data['owners'])} owners lists (made {data['made'][:16].replace('T', ' ')})"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Mubasher's pages from the Mac to the website")
    p.add_argument("what", choices=["send", "apply"])
    p.add_argument("--db", default=str(config.DB_PATH))
    p.add_argument("--file", default=str(FILE))
    a = p.parse_args(argv)
    conn = db.connect(a.db)
    try:
        if a.what == "send":
            print(send(conn, config.load_config()))
        else:
            print(apply(conn, Path(a.file), os.environ.get("TELEGRAM_TOKEN", "").strip()))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
