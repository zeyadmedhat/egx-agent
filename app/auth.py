"""Logins for the shared website: people, sessions and invite links. The dashboard on your Mac has no login.

Passwords are kept only as scrypt hashes, and session tokens and invite codes only as SHA-256 hashes, so a copy of
the database can't be used to log in. There is no public sign-up: every account starts from an invite link.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import sqlite3
import threading
import time
from base64 import b64decode, b64encode
from datetime import datetime, timedelta

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,           -- NULL until the admin account is claimed
    display_name TEXT NOT NULL,
    pw_hash TEXT NOT NULL,          -- scrypt; '!' = no password yet
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    accepted_terms TEXT,            -- when they accepted the first-login notice
    created TEXT NOT NULL,
    last_seen TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created TEXT NOT NULL,
    expires TEXT NOT NULL,
    last_seen TEXT
);
CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,             -- invite: create an account (or claim user_id's) | reset: new password for user_id
    user_id INTEGER,
    note TEXT,                      -- who it's for, as the admin typed it
    created_by INTEGER,
    created TEXT NOT NULL,
    expires TEXT NOT NULL,
    used_at TEXT
);
"""
SESSION_DAYS = 30
INVITE_DAYS = 7
MIN_PASSWORD = 10
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,29}$")
SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1}
NO_PASSWORD = "!"
WRONG = "Wrong username or password."


class AuthError(Exception):
    pass


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


def _now() -> datetime:
    return datetime.now().replace(microsecond=0)


def _iso(d: datetime) -> str:
    return d.isoformat(timespec="seconds")


def _digest(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


# ------------------------------------------------------------------ passwords

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    key = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **SCRYPT)
    return f"scrypt${SCRYPT['n']}${SCRYPT['r']}${SCRYPT['p']}${b64encode(salt).decode()}${b64encode(key).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, key = stored.split("$")
        got = hashlib.scrypt(password.encode(), salt=b64decode(salt), dklen=32, n=int(n), r=int(r), p=int(p))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got, b64decode(key))


_DUMMY = hash_password(secrets.token_hex(8))  # checked for unknown usernames, so the answer takes the same time


def check_password(password: str, username: str | None = None) -> None:
    if len(password) < MIN_PASSWORD:
        raise AuthError(f"Use at least {MIN_PASSWORD} characters for the password.")
    if len(password) > 200:
        raise AuthError("That password is too long.")
    if username and password.lower() == username.lower():
        raise AuthError("The password can't be your username.")
    if len(set(password)) < 4:
        raise AuthError("That password is too easy to guess.")


def clean_username(username: str) -> str:
    u = (username or "").strip().lower()
    if not USERNAME_RE.match(u):
        raise AuthError("Usernames are 3–30 characters: letters, numbers, dots, dashes or underscores.")
    return u


def clean_name(name: str, fallback: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip())[:40] or fallback


# ------------------------------------------------------------------ people

def user_row(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()


def public(row) -> dict:
    return {"id": row["id"], "username": row["username"], "display_name": row["display_name"],
            "is_admin": bool(row["is_admin"]), "accepted_terms": bool(row["accepted_terms"])}


def create_user(conn: sqlite3.Connection, username: str, display_name: str, password: str,
                is_admin: bool = False) -> int:
    u = clean_username(username)
    check_password(password, u)
    if conn.execute("SELECT 1 FROM users WHERE username=?", (u,)).fetchone():
        raise AuthError("That username is taken. Pick another one.")
    cur = conn.execute("INSERT INTO users(username, display_name, pw_hash, is_admin, created) VALUES (?,?,?,?,?)",
                       (u, clean_name(display_name, u), hash_password(password), int(is_admin), _iso(_now())))
    conn.commit()
    return int(cur.lastrowid)


def create_unclaimed_admin(conn: sqlite3.Connection, user_id: int | None = None) -> int:
    """The admin account before it has a username or password (claimed through an invite link)."""
    cur = conn.execute("INSERT INTO users(id, username, display_name, pw_hash, is_admin, created) VALUES (?,?,?,?,1,?)",
                       (user_id, None, "Admin", NO_PASSWORD, _iso(_now())))
    conn.commit()
    return int(cur.lastrowid)


def people(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT * FROM users ORDER BY is_admin DESC, id").fetchall()
    return [{**public(r), "disabled": bool(r["disabled"]), "created": r["created"], "last_seen": r["last_seen"],
             "claimed": r["pw_hash"] != NO_PASSWORD} for r in rows]


def set_disabled(conn: sqlite3.Connection, user_id: int, disabled: bool) -> None:
    conn.execute("UPDATE users SET disabled=? WHERE id=?", (int(disabled), user_id))
    if disabled:
        conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
    conn.commit()


def accept_terms(conn: sqlite3.Connection, user_id: int) -> None:
    conn.execute("UPDATE users SET accepted_terms=? WHERE id=?", (_iso(_now()), user_id))
    conn.commit()


def change_password(conn: sqlite3.Connection, user_id: int, old: str, new: str) -> None:
    row = user_row(conn, user_id)
    if row is None or not verify_password(old, row["pw_hash"]):
        raise AuthError("Your current password isn't right.")
    check_password(new, row["username"])
    conn.execute("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(new), user_id))
    conn.commit()


# ------------------------------------------------------------------ invite and reset links

def create_invite(conn: sqlite3.Connection, created_by: int | None, kind: str = "invite", user_id: int | None = None,
                  note: str = "", days: int = INVITE_DAYS) -> str:
    code = secrets.token_urlsafe(24)
    now = _now()
    conn.execute("INSERT INTO invites(code_hash, kind, user_id, note, created_by, created, expires) VALUES (?,?,?,?,?,?,?)",
                 (_digest(code), kind, user_id, note.strip()[:60], created_by, _iso(now), _iso(now + timedelta(days=days))))
    conn.commit()
    return code


def _invite(conn: sqlite3.Connection, code: str) -> sqlite3.Row | None:
    row = conn.execute("SELECT * FROM invites WHERE code_hash=?", (_digest(code or ""),)).fetchone()
    if row is None or row["used_at"] or row["expires"] < _iso(_now()):
        return None
    return row


def invite_info(conn: sqlite3.Connection, code: str) -> dict | None:
    row = _invite(conn, code)
    if row is None:
        return None
    out = {"kind": row["kind"], "expires": row["expires"], "note": row["note"] or ""}
    if row["user_id"]:
        user = user_row(conn, row["user_id"])
        out["username"] = user["username"] if user else None
        out["claim"] = bool(user and user["pw_hash"] == NO_PASSWORD)
    return out


def pending_invites(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT id, kind, user_id, note, created, expires FROM invites WHERE used_at IS NULL "
                        "AND expires >= ? ORDER BY id DESC", (_iso(_now()),)).fetchall()
    return [dict(r) for r in rows]


def delete_invite(conn: sqlite3.Connection, invite_id: int) -> None:
    conn.execute("DELETE FROM invites WHERE id=? AND used_at IS NULL", (invite_id,))
    conn.commit()


def accept_invite(conn: sqlite3.Connection, code: str, username: str, display_name: str, password: str) -> int:
    """Create the account an invite link is for (or claim the admin account). Returns the user id."""
    row = _invite(conn, code)
    if row is None or row["kind"] != "invite":
        raise AuthError("This invite link has expired or was already used. Ask for a new one.")
    u = clean_username(username)
    check_password(password, u)
    taken = conn.execute("SELECT id FROM users WHERE username=?", (u,)).fetchone()
    if taken and taken["id"] != row["user_id"]:
        raise AuthError("That username is taken. Pick another one.")
    if row["user_id"]:
        user_id = int(row["user_id"])
        conn.execute("UPDATE users SET username=?, display_name=?, pw_hash=? WHERE id=?",
                     (u, clean_name(display_name, u), hash_password(password), user_id))
    else:
        user_id = int(conn.execute("INSERT INTO users(username, display_name, pw_hash, created) VALUES (?,?,?,?)",
                                   (u, clean_name(display_name, u), hash_password(password), _iso(_now()))).lastrowid)
    conn.execute("UPDATE invites SET used_at=? WHERE id=?", (_iso(_now()), row["id"]))
    conn.commit()
    return user_id


def accept_reset(conn: sqlite3.Connection, code: str, password: str) -> int:
    row = _invite(conn, code)
    if row is None or row["kind"] != "reset":
        raise AuthError("This reset link has expired or was already used. Ask for a new one.")
    user = user_row(conn, row["user_id"])
    if user is None or user["disabled"]:
        raise AuthError("This account is switched off.")
    check_password(password, user["username"])
    conn.execute("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(password), user["id"]))
    conn.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
    conn.execute("UPDATE invites SET used_at=? WHERE id=?", (_iso(_now()), row["id"]))
    conn.commit()
    return int(user["id"])


# ------------------------------------------------------------------ sessions

class Throttle:
    """Slows down password guessing: 5 wrong tries lock that username, and that address, for 15 minutes."""

    def __init__(self, limit: int = 5, window: int = 900):
        self.limit, self.window = limit, window
        self._fails: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def _recent(self, key: str, now: float) -> list[float]:
        return [t for t in self._fails.get(key, []) if now - t < self.window]

    def wait(self, *keys: str) -> int:
        """Seconds until these keys may try again (0 = now)."""
        now = time.monotonic()
        with self._lock:
            waits = [int(self.window - (now - r[0])) + 1 for k in keys if len(r := self._recent(k, now)) >= self.limit]
        return max(waits, default=0)

    def fail(self, *keys: str) -> None:
        now = time.monotonic()
        with self._lock:
            for k in keys:
                self._fails[k] = self._recent(k, now) + [now]

    def clear(self, *keys: str) -> None:
        with self._lock:
            for k in keys:
                self._fails.pop(k, None)


def login(conn: sqlite3.Connection, username: str, password: str, throttle: Throttle, address: str) -> tuple[str, int]:
    """Check a username and password. Returns (session token, user id)."""
    u = (username or "").strip().lower()
    keys = (f"user:{u}", f"ip:{address}")
    wait = throttle.wait(*keys)
    if wait:
        raise AuthError(f"Too many wrong tries. Try again in {max(1, wait // 60)} minute{'s' if wait > 60 else ''}.")
    row = conn.execute("SELECT * FROM users WHERE username=?", (u,)).fetchone() if u else None
    ok = verify_password(password or "", row["pw_hash"] if row else _DUMMY)
    if not ok or row is None or row["disabled"]:
        throttle.fail(*keys)
        raise AuthError(WRONG)
    throttle.clear(f"user:{u}")
    return new_session(conn, int(row["id"])), int(row["id"])


def new_session(conn: sqlite3.Connection, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    now = _now()
    conn.execute("INSERT INTO sessions(token_hash, user_id, created, expires, last_seen) VALUES (?,?,?,?,?)",
                 (_digest(token), user_id, _iso(now), _iso(now + timedelta(days=SESSION_DAYS)), _iso(now)))
    conn.execute("UPDATE users SET last_seen=? WHERE id=?", (_iso(now), user_id))
    conn.execute("DELETE FROM sessions WHERE expires < ?", (_iso(now),))
    conn.commit()
    return token


def session_user(conn: sqlite3.Connection, token: str | None) -> sqlite3.Row | None:
    """The person a session cookie belongs to, or None if it's missing, expired, or their account is off."""
    if not token:
        return None
    row = conn.execute(
        """SELECT u.*, s.token_hash, s.expires, s.last_seen AS s_seen FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash=?""", (_digest(token),)).fetchone()
    now = _now()
    if row is None or row["expires"] < _iso(now) or row["disabled"] or row["pw_hash"] == NO_PASSWORD:
        return None
    if not row["s_seen"] or row["s_seen"] < _iso(now - timedelta(minutes=5)):
        conn.execute("UPDATE sessions SET last_seen=? WHERE token_hash=?", (_iso(now), row["token_hash"]))
        conn.execute("UPDATE users SET last_seen=? WHERE id=?", (_iso(now), row["id"]))
        conn.commit()
    return row


def end_session(conn: sqlite3.Connection, token: str | None) -> None:
    if token:
        conn.execute("DELETE FROM sessions WHERE token_hash=?", (_digest(token),))
        conn.commit()


def end_all_sessions(conn: sqlite3.Connection, user_id: int) -> None:
    conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
    conn.commit()
