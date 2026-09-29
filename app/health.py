"""Alarms for the owner: a Telegram message when something breaks, and another when it's fixed.

What counts as a problem:
- a run that crashed (the website's daily job on GitHub, or a scan on your Mac);
- no new closing prices for SESSIONS_LATE sessions (a long holiday looks the same, so the message says so);
- a data source (prices, Egypt data, dividends, a news site, Kashif, the model) failing for FAIL_HOURS in a row:
  one bad run is normal, a whole day isn't;
- the prediction model not retrained for MODEL_LATE_DAYS (it retrains every 30).

Each problem is sent once, when it starts, and once more when it's fixed. Only the stdlib is used at the top so the
website's "the run failed" step works even when installing the packages is what failed.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from html import escape
from typing import Callable, Iterable

SESSIONS_LATE = 2       # sessions without a new close: one is often a holiday, two in a row rarely (the Eids)
FAIL_HOURS = 24
MODEL_LATE_DAYS = 40

Send = Callable[[str], None]


def _meta(conn: sqlite3.Connection, key: str) -> dict:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    try:
        return json.loads(row[0]) if row and row[0] else {}
    except ValueError:
        return {}


def _set(conn: sqlite3.Connection, key: str, value: dict) -> None:
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, json.dumps(value)))
    conn.commit()


def _now() -> datetime:
    return datetime.now()


def _when(iso: str) -> str:
    t = datetime.fromisoformat(iso)
    return f"{t:%a} {t.day} {t:%b} {t:%H:%M}"


# ------------------------------------------------------------------ what's failing

def note(conn: sqlite3.Connection, failed: Iterable[str], checked: Iterable[str], now: datetime | None = None) -> None:
    """Remember which sources failed this run. checked: every source this run tried (a source it didn't try keeps
    its state). A source is a problem once it has failed on every try for FAIL_HOURS."""
    now = now or _now()
    failed = set(failed)
    failing = _meta(conn, "health_failing")
    for name in set(checked) | failed:
        if name in failed:
            failing.setdefault(name, now.isoformat(timespec="seconds"))
        else:
            failing.pop(name, None)
    _set(conn, "health_failing", failing)


def sessions_behind(data_date: str, expected: date) -> int:
    """Trading sessions (Sunday–Thursday) after data_date up to the one whose close should be out by now."""
    d, n = date.fromisoformat(data_date), 0
    while d < expected:
        d += timedelta(days=1)
        n += d.weekday() in (6, 0, 1, 2, 3)
    return n


def problems(conn: sqlite3.Connection, now: datetime | None = None) -> dict[str, str]:
    """The problems right now, {key: what to tell the owner}. The key stays the same while the problem lasts."""
    from egx_agent import predict, scan   # heavy: only here

    now = now or _now()
    out: dict[str, str] = {}
    row = conn.execute("SELECT value FROM meta WHERE key='scan_data_date'").fetchone()
    if row and row[0]:
        behind = sessions_behind(row[0], scan.expected_session_date())
        if behind >= SESSIONS_LATE:
            last = datetime.fromisoformat(row[0])
            out["stale"] = (f"No new closing prices for {behind} sessions: the last close is {last:%a} {last.day} "
                            f"{last:%b}. If the exchange wasn't closed for a holiday, the price download is broken.")
    for name, since in _meta(conn, "health_failing").items():
        if now - datetime.fromisoformat(since) >= timedelta(hours=FAIL_HOURS):
            out[f"source:{name}"] = (f"{escape(name)} hasn't worked since {_when(since)}. The rest of the agent "
                                     f"carries on with what it had.")
    try:
        meta = predict.load_meta(predict.model_dir(conn))
    except Exception:
        meta = None
    if meta and meta.get("trained_at"):
        age = predict.age_days(meta, now.date())
        if age >= MODEL_LATE_DAYS:
            out["model"] = (f"The prediction model is {age} days old (it retrains every {predict.RETRAIN_DAYS}): "
                            f"retraining keeps failing.")
        try:
            h = predict.health(conn, meta)
        except Exception:
            h = {}
        if h.get("status") == "bad":
            out["model_edge"] = (f"The prediction model stopped working lately: over the last {h['days']} sessions its "
                                 f"top picks made {h['top']:+.2%} a trade, no better than the average stock "
                                 f"({h['all']:+.2%}). Until that changes it adds no BUYs of its own; it still orders "
                                 "the rules' BUYs.")
    return out


FIXED = {"stale": "New closing prices are coming in again.",
         "run": "The runs work again.",
         "model": "The prediction model was retrained.",
         "model_edge": "The prediction model's picks beat the average stock again, so it adds its own BUYs again."}


def _fixed_text(key: str) -> str:
    if key.startswith("source:"):
        return f"{escape(key[7:])} works again."
    return FIXED.get(key, "Fixed.")


def message(new: dict[str, str], fixed: Iterable[str], link: str = "", where: str = "") -> str:
    parts = []
    if new:
        parts.append(f"⚠️ <b>EGX agent{where}: something needs a look</b>\n" + "\n".join(f"• {t}" for t in new.values()))
    fixed = list(fixed)
    if fixed:
        parts.append(f"✅ <b>EGX agent{where}: fixed</b>\n" + "\n".join(f"• {_fixed_text(k)}" for k in fixed))
    if link:
        parts.append(f'<a href="{escape(link, quote=True)}">Open the run</a>')
    return "\n\n".join(parts)


def notify(conn: sqlite3.Connection, current: dict[str, str], send: Send | None, link: str = "", where: str = "",
           keep: Iterable[str] = ()) -> dict:
    """Tell the owner about new problems and fixed ones. The record only changes once a message has gone out, so
    with no owner to tell (or Telegram down) the next run tries again. keep: open problems this run can't judge
    (only a run that got through clears a crash). Returns counts for the logs."""
    was = _meta(conn, "health_open")
    keep = {k for k in keep if k in was and k not in current}
    new = {k: t for k, t in current.items() if k not in was}
    fixed = [k for k in was if k not in current and k not in keep]
    res = {"open": len(current) + len(keep), "new": len(new), "fixed": len(fixed), "sent": False}
    if not (new or fixed) or send is None:
        return res
    try:
        send(message(new, fixed, link, where))
    except Exception:          # tried again next run
        return res
    stamp = _now().isoformat(timespec="seconds")
    _set(conn, "health_open", {**{k: v for k, v in was.items() if k not in fixed}, **{k: stamp for k in new}})
    res["sent"] = True
    return res


def crashed(conn: sqlite3.Connection, what: str, send: Send | None, link: str = "", where: str = "") -> bool:
    """A run crashed: tell the owner, once until a run gets through again (which sends "fixed")."""
    was = _meta(conn, "health_open")
    if send is None or "run" in was:
        return False
    return notify(conn, {"run": what}, send, link, where, keep=was)["sent"]


# ------------------------------------------------------------------ Telegram without extra packages

def telegram_sender(token: str, chat_id: str) -> Send:
    def send(text: str) -> None:
        body = json.dumps({"chat_id": chat_id, "text": text, "parse_mode": "HTML",
                           "disable_web_page_preview": True}).encode()
        req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=body,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                ok = json.loads(r.read()).get("ok")
        except (urllib.error.URLError, ValueError, OSError):
            ok = False                 # the error's text holds the URL, and so the token: don't pass it on
        if not ok:
            raise RuntimeError("Telegram didn't take the message")
    return send


def run_link() -> str:
    """This GitHub Actions run's page (empty elsewhere)."""
    e = os.environ
    if e.get("GITHUB_RUN_ID") and e.get("GITHUB_REPOSITORY"):
        return f"{e.get('GITHUB_SERVER_URL', 'https://github.com')}/{e['GITHUB_REPOSITORY']}/actions/runs/{e['GITHUB_RUN_ID']}"
    return ""


def site_owner_chat(conn: sqlite3.Connection) -> str | None:
    return _meta(conn, "site_owner").get("chat")


def main(argv: list[str] | None = None) -> int:
    """The website's "this run failed" step: python -m app.health crashed --db state/egx.db"""
    args = argv if argv is not None else sys.argv[1:]
    if args[:1] != ["crashed"] or "--db" not in args:
        print("usage: python -m app.health crashed --db state/egx.db")
        return 2
    path = args[args.index("--db") + 1]
    token = os.environ.get("TELEGRAM_TOKEN", "").strip()
    if not (token and os.path.exists(path)):
        print("Alarm: no Telegram bot or no data yet, so GitHub's own e-mail is the only alarm.")
        return 0
    conn = sqlite3.connect(path)
    try:
        chat = site_owner_chat(conn)
        if not chat:
            print("Alarm: the owner isn't connected on Telegram yet (the OWNER_TELEGRAM secret).")
            return 0
        sent = crashed(conn, "Today's website run failed. The site keeps showing the last data it had, and GitHub "
                             "tries again at the next scheduled time.",
                       telegram_sender(token, chat), run_link(), " website")
        print("Alarm: sent to the owner." if sent else "Alarm: already sent (or Telegram didn't answer).")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
