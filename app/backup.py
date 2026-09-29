"""The website's data, backed up once a day as a locked file kept by GitHub for BACKUP_DAYS days.

The website's database (prices, signals, the paper account, the model's live record, who connected on Telegram)
lives in GitHub's cache between runs. If that cache is ever lost, the next run brings back the latest backup by
itself (.github/workflows/site.yml). The file is gzip + AES-256-GCM with a key made from the site password *and*
the Telegram bot token, so friends who know the site password can't open it; only the owner's secrets can.

    python -m app.backup make --db state/egx.db --out _backup/state.egxb
    python -m app.backup restore --file _backup/state.egxb --db state/egx.db
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import os
import secrets
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"EGXB1"
ITERATIONS = 300_000
BACKUP_EVERY = timedelta(hours=20)   # about once a day, whatever time the runs happen
BACKUP_DAYS = 30                     # how long GitHub keeps each one (the workflow's retention-days)


class BackupError(Exception):
    pass


def secret() -> str:
    """What the key is made from: the site password and the bot token (the bot token is optional)."""
    return os.environ.get("EGX_SITE_PASSWORD", "") + "\n" + os.environ.get("TELEGRAM_TOKEN", "").strip()


def _key(material: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", material.encode(), salt, ITERATIONS, 32)


def _copy(db_path: Path) -> bytes:
    """A consistent copy of the database, even while it's open elsewhere."""
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp) / "copy.db"
        src, dst = sqlite3.connect(db_path), sqlite3.connect(dest)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        return dest.read_bytes()


def make(db_path: Path, out: Path, material: str) -> int:
    """Write the locked backup. Returns its size in bytes."""
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    box = MAGIC + salt + iv + AESGCM(_key(material, salt)).encrypt(iv, gzip.compress(_copy(db_path), 6), MAGIC)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(box)
    return len(box)


def restore(backup: Path, db_path: Path, material: str) -> None:
    """Unlock a backup into db_path, only if it opens and the database inside is whole."""
    box = backup.read_bytes()
    if not box.startswith(MAGIC) or len(box) < len(MAGIC) + 28:
        raise BackupError("not a backup file")
    salt, iv, body = box[5:21], box[21:33], box[33:]
    try:
        plain = gzip.decompress(AESGCM(_key(material, salt)).decrypt(iv, body, MAGIC))
    except InvalidTag:
        raise BackupError("it doesn't open with this site password and bot token") from None
    db_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = db_path.with_suffix(".restoring")
    tmp.write_bytes(plain)
    try:
        conn = sqlite3.connect(tmp)
        try:
            ok = conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        finally:
            conn.close()
    except sqlite3.DatabaseError:
        ok = False
    if not ok:
        tmp.unlink()
        raise BackupError("the database inside is damaged")
    tmp.replace(db_path)


def due(conn: sqlite3.Connection, now: datetime | None = None) -> bool:
    row = conn.execute("SELECT value FROM meta WHERE key='backup_last'").fetchone()
    return not (row and row[0]) or (now or datetime.now()) - datetime.fromisoformat(row[0]) >= BACKUP_EVERY


def make_if_due(db_path: Path, out: Path, material: str) -> int | None:
    """Back up if the last backup is about a day old. Returns the size, or None when not due."""
    conn = sqlite3.connect(db_path)
    try:
        if not due(conn):
            return None
        size = make(db_path, out, material)
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('backup_last', ?)",
                     (datetime.now().isoformat(timespec="seconds"),))
        conn.commit()
        return size
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Back up or bring back the website's data")
    p.add_argument("action", choices=["make", "restore"])
    p.add_argument("--db", default="state/egx.db")
    p.add_argument("--out", default="_backup/state.egxb")
    p.add_argument("--file", default="_backup/state.egxb")
    a = p.parse_args(argv)
    if not os.environ.get("EGX_SITE_PASSWORD"):
        print("The SITE_PASSWORD secret is missing.")
        return 1
    if a.action == "make":
        size = make(Path(a.db), Path(a.out), secret())
        print(f"Backup: {size / 1e6:.1f} MB")
        return 0
    try:
        restore(Path(a.file), Path(a.db), secret())
    except BackupError as exc:
        print(f"This backup can't be used: {exc}.")
        return 1
    print("Brought back the data from the backup.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
