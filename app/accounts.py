"""Who is using the dashboard, and where their data lives.

On your Mac (local mode) there's one person, no login, and one file with everything: data/egx.db.
On the website (multi-user mode) the shared market data is in data/market.db and each person's portfolio, paper
account and settings in data/users/<id>.db, opened with the market file attached (see db.connect_person).

Admin command on the server (prints a one-time link to claim the admin account, or a reset link):
    .venv/bin/python -m app.accounts admin-link --db data/market.db --site https://NAME.duckdns.org
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterator

from egx_agent import config, db

from . import auth


@dataclass(frozen=True)
class Person:
    id: int
    username: str
    display_name: str
    is_admin: bool
    accepted_terms: bool = True

    def public(self) -> dict:
        return asdict(self)

    @classmethod
    def from_row(cls, row) -> "Person":
        return cls(int(row["id"]), row["username"] or "", row["display_name"], bool(row["is_admin"]),
                   bool(row["accepted_terms"]))


LOCAL = Person(0, "you", "You", True, True)   # the only person on your Mac


class Site:
    def __init__(self, market_path: Path | str, multi_user: bool = False):
        self.market_path = Path(market_path)
        self.multi_user = multi_user
        self.users_dir = self.market_path.parent / "users"

    # ---------------------------------------------------------- connections
    def market(self) -> sqlite3.Connection:
        if not self.multi_user:
            return db.connect(self.market_path)
        conn = db.connect_market(self.market_path)
        auth.ensure_schema(conn)
        return conn

    def person_path(self, person: Person) -> Path:
        return self.users_dir / f"{int(person.id)}.db" if self.multi_user else self.market_path

    def connect(self, person: Person) -> sqlite3.Connection:
        if not self.multi_user:
            return db.connect(self.market_path)
        return db.connect_person(self.person_path(person), self.market_path)

    def cfg(self, conn: sqlite3.Connection) -> dict:
        """The settings for whoever `conn` belongs to: the strategy plus their own numbers."""
        cfg = config.load_config()
        return config.with_personal(cfg, db.personal_settings(conn)) if self.multi_user else cfg

    def backtest_path(self, person: Person) -> Path:
        if self.multi_user:
            return self.users_dir / f"{int(person.id)}_backtest.json"
        return self.market_path.parent / "last_backtest.json"

    # ---------------------------------------------------------- people
    def people(self, market: sqlite3.Connection | None = None) -> list[Person]:
        if not self.multi_user:
            return [LOCAL]
        own = market is None
        conn = market or self.market()
        try:
            rows = conn.execute("SELECT * FROM users WHERE disabled=0 AND pw_hash != ? ORDER BY id",
                                (auth.NO_PASSWORD,)).fetchall()
        finally:
            if own:
                conn.close()
        return [Person.from_row(r) for r in rows]

    def each(self, market: sqlite3.Connection, cfg: dict | None = None) -> Iterator[tuple[Person, sqlite3.Connection, dict]]:
        """Every active person's connection and settings, for work done after a scan (paper trades, Telegram)."""
        if not self.multi_user:
            yield LOCAL, market, cfg if cfg is not None else self.cfg(market)
            return
        for person in self.people(market):
            conn = self.connect(person)
            try:
                yield person, conn, self.cfg(conn)
            finally:
                conn.close()

    # ---------------------------------------------------------- settings
    def save_settings(self, conn: sqlite3.Connection, person: Person, values: dict) -> None:
        """Save changed settings where they belong: your own numbers in your file, the strategy in config.yaml."""
        if not self.multi_user:
            config.save_config({**config.load_config(), **values})
            return
        own = {k: v for k, v in values.items() if k in config.PERSONAL_KEYS}
        rules = {k: v for k, v in values.items() if k not in config.PERSONAL_KEYS}
        if rules and not person.is_admin:
            raise PermissionError("Only the admin can change the strategy settings.")
        if own:
            db.save_personal_settings(conn, own)
        if rules:
            config.save_config({**config.load_config(), **rules})


def admin_link(market_path: Path | str, site_url: str) -> str:
    """A one-time link for the admin: to claim the account the first time, or to reset its password later."""
    site = Site(market_path, multi_user=True)
    conn = site.market()
    try:
        row = conn.execute("SELECT * FROM users WHERE is_admin=1 ORDER BY id LIMIT 1").fetchone()
        if row is None:
            user_id = auth.create_unclaimed_admin(conn, 1)
            code = auth.create_invite(conn, None, "invite", user_id, note="admin account")
            return f"{site_url.rstrip('/')}/#/join?code={code}"
        if row["pw_hash"] == auth.NO_PASSWORD:
            code = auth.create_invite(conn, None, "invite", row["id"], note="admin account")
            return f"{site_url.rstrip('/')}/#/join?code={code}"
        code = auth.create_invite(conn, None, "reset", row["id"], note="admin password reset", days=1)
        return f"{site_url.rstrip('/')}/#/reset?code={code}"
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="EGX Trading Agent website accounts")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("admin-link", help="print a one-time link to claim (or reset) the admin account")
    a.add_argument("--db", default=str(config.ROOT / "data" / "market.db"))
    a.add_argument("--site", required=True, help="the website address, e.g. https://name.duckdns.org")
    args = p.parse_args(argv)
    if args.cmd == "admin-link":
        print(admin_link(args.db, args.site))
    return 0


if __name__ == "__main__":
    sys.exit(main())
