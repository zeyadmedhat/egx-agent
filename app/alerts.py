"""Telegram alerts: after each scan, the orders for the next session arrive on your phone.

Set up in Settings → Alerts. The admin creates one bot with @BotFather and pastes its token (kept in config.yaml,
only ever sent to api.telegram.org, never shown again). Each person then opens the bot through a one-time link
(t.me/<bot>?start=<code>) and presses Start, which tells the agent their chat. On your Mac you are both.
"""
from __future__ import annotations

import html
import json
import re
import secrets
import sqlite3
from datetime import datetime

import requests

from egx_agent import breadth, config, db, portfolio

from . import views

API = "https://api.telegram.org/bot{token}/{method}"
TOKEN_RE = re.compile(r"^\d{5,15}:[A-Za-z0-9_-]{30,60}$")
MAX_LEN = 4000  # Telegram allows 4096 characters per message
ICON = {"adjust": "⚠️", "sell": "🔴", "stop": "🔵", "review": "🟠", "buy": "🟢"}
KASHIF = {"compliant": "🟢", "non_compliant": "🔴", "awaiting": "🕐", "blocked": "🚫"}


class TelegramError(Exception):
    pass


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def call(token: str, method: str, **params):
    try:
        r = requests.post(API.format(token=token, method=method), json=params, timeout=20)
    except requests.RequestException:
        # The library's message contains the URL, and so the token: don't pass it on.
        raise TelegramError("Can't reach Telegram. Check your internet connection.") from None
    try:
        data = r.json()
    except ValueError:
        raise TelegramError(f"Telegram answered with an error ({r.status_code}).") from None
    if not data.get("ok"):
        if r.status_code in (401, 404):
            raise TelegramError("Telegram doesn't recognise this bot token. Copy it again from @BotFather.")
        raise TelegramError(f"Telegram: {data.get('description') or r.status_code}")
    return data["result"]


def check_token(token: str) -> dict:
    token = token.strip()
    if not TOKEN_RE.match(token):
        raise TelegramError("That doesn't look like a bot token. It looks like 123456789:AAE…, "
                            "copied from @BotFather's message.")
    me = call(token, "getMe")
    return {"username": me.get("username"), "name": me.get("first_name")}


START_RE = re.compile(r"^/start\s+([A-Za-z0-9_-]{8,64})\s*$")
KEEP_STARTS = 200


def new_link_code() -> str:
    return secrets.token_urlsafe(12)


def collect_starts(conn: sqlite3.Connection, token: str) -> dict:
    """Read the bot's new messages and remember every "/start <code>" (who pressed Start through which link).

    Messages are confirmed to Telegram once read, so the list never fills up; the codes are kept in the shared
    meta table because several people may connect at about the same time.
    """
    seen = json.loads(db.get_meta(conn, "telegram_starts") or "{}")
    offset = int(db.get_meta(conn, "telegram_update_offset") or 0)
    updates = call(token, "getUpdates", timeout=0, offset=offset or None, allowed_updates=["message"])
    for u in updates:
        offset = max(offset, int(u["update_id"]) + 1)
        msg = u.get("message") or {}
        chat = msg.get("chat") or {}
        m = START_RE.match(msg.get("text") or "")
        if m and chat.get("type") == "private":
            name = " ".join(x for x in (chat.get("first_name"), chat.get("last_name")) if x)
            seen[m.group(1)] = {"id": str(chat["id"]), "name": name or chat.get("username") or "you", "at": _now()}
    if updates:
        seen = dict(sorted(seen.items(), key=lambda kv: kv[1]["at"])[-KEEP_STARTS:])
        db.set_meta(conn, "telegram_starts", json.dumps(seen))
        db.set_meta(conn, "telegram_update_offset", str(offset))
    return seen


def find_chat_by_code(conn: sqlite3.Connection, token: str, code: str) -> dict | None:
    """The chat that pressed Start through this person's link, or None if they haven't yet."""
    return collect_starts(conn, token).get(code)


def send(token: str, chat_id: str, text: str) -> None:
    call(token, "sendMessage", chat_id=chat_id, text=text, parse_mode="HTML", disable_web_page_preview=True)


# ------------------------------------------------------------------ the message

def _e(x) -> str:
    return html.escape(str(x), quote=False)


def _shariah(info: dict) -> str:
    egx = "EGX33 ✓" if info.get("egx33") else "EGX33 ✗"
    return f"{egx} · Kashif {KASHIF.get(info.get('kashif_status'), '–')}"


def build_message(d: views.Data) -> tuple[str, bool]:
    """The scan summary as Telegram HTML, and whether it asks you to do anything."""
    m = views.market_info(d.conn)
    o = views.orders(d)
    if not m or not o:
        return "<b>EGX Agent</b>\nNo scan yet. Open the dashboard and press Run scan.", False
    head = [f"<b>EGX Agent · {views.nice_date(o['scan_date'], True)} close</b>"]
    mood = "🔴 Risk-off" if m.get("risk_off") else "🟢 Market OK"
    if o["blocked"]:
        mood += ": no new buys"
    head.append(f"EGX30 {m['egx30_close']:,.0f} ({m['egx30_change']:+.1%}) · {mood}")
    b = views.breadth_data(d)
    if b:
        v = breadth.verdict(b, m.get("risk_off"))
        week = f" ({v['change_week'] * 100:+.0f} pts in a week)" if v["change_week"] is not None else ""
        head.append(f"Breadth: {b['above50']:.0%} of stocks above their 50-day average{week}")

    preds = views.predictions(d)
    body = ["", f"<b>Orders for {views.nice_date(o['session'], True)}</b>"]
    for it in o["items"]:
        body.append(f"{ICON[it['kind']]} <b>{_e(it['title'])}</b>")
        body.append(f"      {_e(it['detail'])}")
        if it["kind"] == "buy":
            body.append(f"      {_shariah(it['info'])}")
            pr = preds["by_symbol"].get(it["symbol"])
            if pr and pr.get("p10") is not None and preds["base"].get(10):
                body.append(f"      Model: {pr['p10']:.0%} chance of target before stop in 2 weeks "
                            f"(average stock {preds['base'][10]:.0%})")
    if not o["items"]:
        body.append("Nothing to do. " + ("No new buys while EGX30 is below its 50-day average." if o["blocked"]
                                         else "No BUY signals at this close."))
    tail = []
    if o["holds"]:
        tail.append("Holding: " + ", ".join(f"{h['symbol']} (stop {views.px(h['stop'])})" for h in o["holds"]))
    if o["skipped"]:
        tail.append("Not bought: " + ", ".join(f"{s['symbol']} ({_e(s['note'])})" for s in o["skipped"]))
    paper = portfolio.account_summary(d.conn, "paper", d.cfg, d.closes())
    if paper["open_count"] or paper["realized"]:
        tail.append(f"Paper account {paper['equity']:,.0f} EGP ({paper['return_pct']:+.1%})")
    tail = ([""] + tail if tail else []) + ["", "<i>Rules-based signals, not investment advice.</i>"]

    text = "\n".join(head + body + tail)
    while len(text) > MAX_LEN and len(body) > 3:  # a very long list: keep the most urgent, drop from the end
        body = body[:-2]
        text = "\n".join(head + body + ["…more on the dashboard."] + tail)
    return text, bool(o["items"])


def build_group_message(d: views.Data, site_url: str = "") -> str:
    """The GitHub Pages site's message to the group chat: the day's signals for everyone, without share counts
    (each person sizes them with their own numbers on the site)."""
    m = views.market_info(d.conn)
    scan_date, df = views.current_scan(d.conn)
    if not m or not scan_date:
        return "<b>EGX Agent</b>\nNo scan yet."
    rows = views.records(df)
    buys = [r for r in rows if r["action"] == "BUY"]
    session = views.sessions_after(scan_date, 1)
    mood = "🔴 Risk-off" if m.get("risk_off") else "🟢 Market OK"
    if m.get("risk_off") and d.cfg.get("riskoff_block_buys"):
        mood += ": no new buys"
    lines = [f"<b>EGX Agent · {views.nice_date(scan_date, True)} close</b>",
             f"EGX30 {m['egx30_close']:,.0f} ({m['egx30_change']:+.1%}) · {mood}"]
    b = views.breadth_data(d)
    if b:
        v = breadth.verdict(b, m.get("risk_off"))
        week = f" ({v['change_week'] * 100:+.0f} pts in a week)" if v["change_week"] is not None else ""
        lines.append(f"Breadth: {b['above50']:.0%} of stocks above their 50-day average{week}")
    preds = views.predictions(d)
    lines += ["", f"<b>BUY signals for {views.nice_date(session, True)}</b>" if buys else "<b>No BUY signals</b> at this close."]
    for r in buys:
        lines.append(f"🟢 <b>{_e(r['symbol'])}</b>: buy up to {views.px(r['entry_high'])} · stop {views.px(r['stop'])} · "
                     f"target {views.px(r['target'])}")
        extra = [f"score {r['score']:.0f}", _shariah(d.info(r["symbol"]))]
        pr = preds["by_symbol"].get(r["symbol"])
        if pr and pr.get("p10") is not None and preds["base"].get(10):
            extra.append(f"model {pr['p10']:.0%} (avg {preds['base'][10]:.0%})")
        lines.append("      " + " · ".join(extra))
    watch = len(rows) - len(buys)
    if watch:
        lines.append(f"Watchlist: {watch} stock{'s' if watch != 1 else ''} could trigger next.")
    lines += ["", "Open the site for your share counts, your Shariah filter and what to do with your own positions."
              + (f"\n{site_url}" if site_url else ""), "", "<i>Rules-based signals, not investment advice.</i>"]
    text = "\n".join(lines)
    return text if len(text) <= MAX_LEN else text[:MAX_LEN - 20] + "\n…more on the site."


# ------------------------------------------------------------------ sending after a scan

def after_scan(conn: sqlite3.Connection, cfg: dict, force: bool = False) -> str:
    """Send the latest scan to Telegram, once per closing-price date. Returns what happened, for the logs."""
    token, chat = cfg.get("telegram_token"), cfg.get("telegram_chat_id")
    if not (token and chat):
        return "off"
    data_date = db.get_meta(conn, "scan_data_date")
    if not data_date:
        return "no scan yet"
    if not force and db.get_user_meta(conn, "telegram_sent_for") == data_date:
        return "already sent"
    text, action = build_message(views.Data(conn, cfg, views.Cache()))
    if not force and cfg.get("telegram_only_action") and not action:
        db.set_user_meta(conn, "telegram_sent_for", data_date)
        return "nothing to do, so not sent"
    try:
        send(token, chat, text)
    except TelegramError as exc:
        db.set_user_meta(conn, "telegram_error", json.dumps({"at": _now(), "message": str(exc)}))
        raise
    db.set_user_meta(conn, "telegram_sent_for", data_date)
    db.set_user_meta(conn, "telegram_last_sent", _now())
    db.set_user_meta(conn, "telegram_error", None)
    return "sent"


# ------------------------------------------------------------------ settings

def save(**changes) -> dict:
    cfg = config.load_config()
    cfg.update(changes)
    config.save_config(cfg)
    return cfg


def status(conn: sqlite3.Connection, cfg: dict, is_admin: bool = True) -> dict:
    token = cfg.get("telegram_token") or ""
    err = db.get_user_meta(conn, "telegram_error")
    bot = db.get_meta(conn, "telegram_bot")
    return {
        "token_set": bool(token), "token_hint": f"…{token[-4:]}" if token and is_admin else "",
        "bot": json.loads(bot) if bot and token else None,
        "connected": bool(token and cfg.get("telegram_chat_id")),
        "chat_name": db.get_user_meta(conn, "telegram_chat_name") if cfg.get("telegram_chat_id") else None,
        "only_action": bool(cfg.get("telegram_only_action")),
        "last_sent": db.get_user_meta(conn, "telegram_last_sent"),
        "error": json.loads(err) if err else None,
        "can_set_bot": is_admin,
    }


def forget_me(conn: sqlite3.Connection) -> None:
    """Remove this person's Telegram status (after they disconnect or the bot changes)."""
    conn.execute("DELETE FROM user_meta WHERE key LIKE 'telegram_%'")
    conn.commit()
