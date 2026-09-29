"""Telegram alerts: after each scan, the orders for the next session arrive on your phone.

Set up in Settings → Alerts. The admin creates one bot with @BotFather and pastes its token (kept in config.yaml,
only ever sent to api.telegram.org, never shown again). Each person then opens the bot through a one-time link
(t.me/<bot>?start=<code>) and presses Start, which tells the agent their chat. On your Mac you are both.
"""
from __future__ import annotations

import hashlib
import hmac
import html
import json
import re
import secrets
import sqlite3
from datetime import date, datetime, timedelta

import pandas as pd
import requests

from egx_agent import breadth, config, db, portfolio, predict, scan
from egx_agent.data import news

from . import views

API = "https://api.telegram.org/bot{token}/{method}"
TOKEN_RE = re.compile(r"^\d{5,15}:[A-Za-z0-9_-]{30,60}$")
MAX_LEN = 4000  # Telegram allows 4096 characters per message
ICON = {"adjust": "⚠️", "sell": "🔴", "stop": "🔵", "review": "🟠", "buy": "🟢"}
KASHIF = {"compliant": "🟢", "non_compliant": "🔴", "awaiting": "🕐", "blocked": "🚫"}


class TelegramError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


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
        raise TelegramError(f"Telegram answered with an error ({r.status_code}).", r.status_code) from None
    if not data.get("ok"):
        if r.status_code in (401, 404):
            raise TelegramError("Telegram doesn't recognise this bot token. Copy it again from @BotFather.",
                                r.status_code)
        raise TelegramError(f"Telegram: {data.get('description') or r.status_code}", r.status_code)
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


SWITCH_ICON = {"full": "🟢", "half": "🟡", "off": "🔴"}


def _switch_line(v: dict) -> str:
    sw = v.get("switch")
    return f"Market switch: {SWITCH_ICON[sw['state']]} {sw['label']} (for the model's picks)" if sw else ""


def _caution_lines(items: list[dict], indent: str = "      ") -> list[str]:
    """A signal's or position's cautions (views.cautions_map), one short line each."""
    out = []
    for c in items or []:
        day = views.nice_date(c["date"]) if c.get("date") else ""
        if c["kind"] == "ex_dividend":
            amt = f" ({c['amount']:g} EGP)" if c.get("amount") else ""
            out.append(f"{indent}ℹ️ Ex-dividend {day}{amt}: the price drops by it that morning and you get it in cash; "
                       "lower the stop by the same amount the evening before")
        elif c["kind"] == "bad_news":
            out.append(f"{indent}⚠️ News: {_e(c['title'])} ({_e(c['source'])})")
        elif c["kind"] in ("bonus", "split"):
            out.append(f"{indent}ℹ️ {'Bonus shares' if c['kind'] == 'bonus' else 'Split'} {day}: the price is re-based that day")
        elif c["kind"] == "rights":
            out.append(f"{indent}ℹ️ Rights issue, ex-date {day}")
    return out


def _held_news(d: views.Data, symbols: list[str], since: str, limit: int = 5) -> list[str]:
    """New headlines about the stocks you hold (newest first)."""
    rows = []
    for sym in symbols:
        rows += [{**n, "symbol": sym} for n in news.stock_news(d.conn, sym, 5) if n["published"] >= since]
    rows.sort(key=lambda n: n["published"], reverse=True)
    dot = {1: "🟢", -1: "🔴"}
    return [f"{dot.get(n['tone'], '⚪')} <b>{_e(n['symbol'])}</b>: {_e(n['title'])} "
            f"({_e(news.SOURCES.get(n['source'], n['source']))})" for n in rows[:limit]]


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
        head.append(_switch_line(v))

    preds = views.predictions(d)
    warn = views.cautions_map(d)
    body = ["", f"<b>Orders for {views.nice_date(o['session'], True)}</b>"]
    for it in o["items"]:
        body.append(f"{ICON[it['kind']]} <b>{_e(it['title'])}</b>")
        body.append(f"      {_e(it['detail'])}")
        if it["kind"] == "buy":
            if it.get("source") == "model":
                body.append("      🎯 A prediction-model pick (its top picks that pass the checks are BUYs too)")
            body.append(f"      {_shariah(it['info'])}")
            body += _caution_lines(warn.get(it["symbol"]))
            pr = preds["by_symbol"].get(it["symbol"])
            if pr and pr.get("p10") is not None and preds["base"].get(10):
                rank = f"#{pr['rank10']:.0f} of {preds['count']}, " if pr.get("rank10") else ""
                body.append(f"      Model: {rank}{pr['p10']:.0%} chance of target before stop in 2 weeks "
                            f"(average stock {preds['base'][10]:.0%})" if pr.get("top10") else
                            f"      Model: {rank}not one of its top picks today")
    if not o["items"]:
        body.append("Nothing to do. " + ("No new buys while EGX30 is below its 50-day average." if o["blocked"]
                                         else "No BUY signals at this close."))
    tail = []
    if o["holds"]:
        tail.append("Holding: " + ", ".join(f"{h['symbol']} (stop {views.px(h['stop'])})" for h in o["holds"]))
    if o["skipped"]:
        tail.append("Not bought: " + ", ".join(f"{s['symbol']} ({_e(s['note'])})" for s in o["skipped"]))
    held = sorted({p["symbol"] for p in views.open_positions(d)})
    held_warn = [ln for sym in held for ln in _caution_lines(warn.get(sym), f"<b>{_e(sym)}</b> ")
                 if "Ex-dividend" in ln or "re-based" in ln or "Rights" in ln]
    since = (datetime.fromisoformat(o["scan_date"]) - pd.Timedelta(days=1)).strftime("%Y-%m-%dT%H:%M")
    held_news = _held_news(d, held, since)
    if held_warn or held_news:
        tail += ["", "<b>Your stocks</b>"] + held_warn + held_news
    paper = portfolio.account_summary(d.conn, "paper", d.cfg, d.closes())
    if paper["open_count"] or paper["realized"]:
        tail.append(f"Paper account {paper['equity']:,.0f} EGP ({paper['return_pct']:+.1%})")
    tail = ([""] + tail if tail else []) + ["", "<i>Rules-based signals, not investment advice.</i>"]

    text = "\n".join(head + body + tail)
    while len(text) > MAX_LEN and len(body) > 3:  # a very long list: keep the most urgent, drop from the end
        body = body[:-2]
        text = "\n".join(head + body + ["…more on the dashboard."] + tail)
    return text, bool(o["items"])


def build_site_message(d: views.Data, site_url: str = "") -> str:
    """The GitHub Pages site's message, sent to each friend who connected Telegram: the day's signals for everyone,
    without share counts (each person sizes them with their own numbers on the site)."""
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
        lines.append(_switch_line(v))
    preds = views.predictions(d)
    warn = views.cautions_map(d)
    lines += ["", f"<b>BUY signals for {views.nice_date(session, True)}</b>" if buys else "<b>No BUY signals</b> at this close."]
    for r in sorted(buys, key=views.signal_order):      # the order money goes in: the model's rank first
        pick = " (model pick)" if r.get("source") == "model" else ""
        lines.append(f"🟢 <b>{_e(r['symbol'])}</b>{pick}: buy up to {views.px(r['entry_high'])} · "
                     f"stop {views.px(r['stop'])} · target {views.px(r['target'])}")
        extra = [f"score {r['score']:.0f}", _shariah(d.info(r["symbol"]))]
        pr = preds["by_symbol"].get(r["symbol"])
        if pr and pr.get("p10") is not None and preds["base"].get(10):
            extra.append(f"model top pick {pr['p10']:.0%} (avg {preds['base'][10]:.0%})" if pr.get("top10")
                         else "not a model top pick")
        lines.append("      " + " · ".join(extra))
        lines += _caution_lines(warn.get(r["symbol"]))
    watch = len(rows) - len(buys)
    if watch:
        lines.append(f"Watchlist: {watch} stock{'s' if watch != 1 else ''} could trigger next.")
    lines += ["", "Open the site for your share counts, your Shariah filter and what to do with your own positions."
              + (f"\n{site_url}" if site_url else ""), "",
              "<i>Rules-based signals, not investment advice.</i> Send /stop to stop these messages."]
    text = "\n".join(lines)
    return text if len(text) <= MAX_LEN else text[:MAX_LEN - 20] + "\n…more on the site."


# ------------------------------------------------------------------ the website: a message to each friend
# Each friend presses "Connect Telegram" on the site, which opens t.me/<bot>?start=<the site's code>. The code comes
# from the site's password (static_site.telegram_code), so only people who can open the site have it, and changing
# the password disconnects everyone until they press the new link. The GitHub job reads the bot's messages a few
# times a day. It doesn't confirm them to Telegram (your Mac's copy reads the same bot): it remembers the last one
# it handled instead, and ignores any other /start (like your Mac's own link).
STOP_RE = re.compile(r"^/stop(@\w+)?\s*$")
WELCOME = ("✅ <b>Connected.</b> After each EGX close you'll get the day's signals here. Your share counts are on "
           "the website.\nSend /help for alerts on the stocks you follow, or /stop to stop.")
STOPPED = "Stopped. To start again, open the website → Settings → Connect Telegram."
RESET = ("The website's password has changed, so these messages have stopped. Open the website with the new "
         "password → Settings → Connect Telegram to get them again.")


def _fingerprint(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()[:16]


def _subscribers(conn: sqlite3.Connection) -> dict:
    return json.loads(db.get_meta(conn, "site_subscribers") or "{}")


def _reply(token: str, chat_id: str, text: str) -> None:
    try:
        send(token, chat_id, text)
    except TelegramError:
        pass  # only a courtesy: the next message tries again


# Alerts for the stocks a friend follows: sent after a close, when the stock gets a BUY signal or closes past a price.
WATCH_RE = re.compile(r"^/watch(?:@\w+)?\s+([A-Za-z0-9]{2,12})(?:\s+([0-9]+(?:[.,][0-9]+)?))?\s*$", re.I)
UNWATCH_RE = re.compile(r"^/unwatch(?:@\w+)?\s+([A-Za-z0-9]{2,12})\s*$", re.I)
LIST_RE = re.compile(r"^/(?:list|alerts)(?:@\w+)?\s*$", re.I)
WEEKLY_RE = re.compile(r"^/weekly(?:@\w+)?\s+(on|off)\s*$", re.I)
MAX_ALERTS = 20
HELP = ("<b>Alerts for the stocks you follow</b>, checked after each close:\n"
        "/watch COMI: when COMI gets a BUY signal\n"
        "/watch COMI 45: when COMI closes above 45 (or below, if 45 is under today's price)\n"
        "/unwatch COMI: stop COMI's alerts\n"
        "/list: your alerts\n"
        "/weekly off: no Thursday summary (/weekly on to have it again)\n"
        "/stop: stop all messages\n"
        "I read messages every few hours, so a reply can take up to 3 hours.")


def _alert_key(a) -> tuple:
    return a["chat_id"], a["symbol"], a["kind"]


def _drop_alert(conn: sqlite3.Connection, key: tuple) -> None:
    conn.execute("DELETE FROM watch_alerts WHERE chat_id=? AND symbol=? AND kind=?", key)


def forget_alerts(conn: sqlite3.Connection, chat_id: str, symbol: str | None = None) -> int:
    """Remove a chat's alerts (all, or one stock's). Returns how many there were."""
    if symbol:
        return conn.execute("DELETE FROM watch_alerts WHERE chat_id=? AND symbol=?", (chat_id, symbol)).rowcount
    return conn.execute("DELETE FROM watch_alerts WHERE chat_id=?", (chat_id,)).rowcount


def _alert_text(a) -> str:
    if a["kind"] == "buy":
        return f"{a['symbol']}: a BUY signal"
    return f"{a['symbol']}: a close {a['kind']} {views.px(a['price'])}"


def watch_command(conn: sqlite3.Connection, chat_id: str, text: str) -> str | None:
    """A connected friend's alert command: the reply, or None when the message isn't a command."""
    if not text.startswith("/"):
        return None
    if LIST_RE.match(text):
        rows = conn.execute("SELECT * FROM watch_alerts WHERE chat_id=? ORDER BY symbol, kind", (chat_id,)).fetchall()
        if not rows:
            return "You have no alerts yet.\n\n" + HELP
        return "<b>Your alerts</b>\n" + "\n".join(_e(_alert_text(a)) for a in rows)
    m = UNWATCH_RE.match(text)
    if m:
        sym = m.group(1).upper()
        n = forget_alerts(conn, chat_id, sym)
        conn.commit()
        return f"Removed {n} alert{'s' if n != 1 else ''} for {_e(sym)}." if n else f"You have no alert for {_e(sym)}."
    m = WATCH_RE.match(text)
    if not m:
        return HELP
    sym = m.group(1).upper()
    if not conn.execute("SELECT 1 FROM stocks WHERE symbol=?", (sym,)).fetchone():
        return f"I don't know {_e(sym)}. Use the stock's EGX symbol, like COMI."
    have = conn.execute("SELECT COUNT(*) FROM watch_alerts WHERE chat_id=?", (chat_id,)).fetchone()[0]
    if have >= MAX_ALERTS:
        return f"You already have {MAX_ALERTS} alerts. Remove some with /unwatch first."
    last = conn.execute("SELECT close FROM prices WHERE symbol=? ORDER BY date DESC LIMIT 1", (sym,)).fetchone()
    if m.group(2) is None:
        kind, price = "buy", None
        reply = f"OK: I'll tell you when {sym} gets a BUY signal, after any close."
    else:
        price = float(m.group(2).replace(",", "."))
        if last is None:
            return f"There are no prices for {_e(sym)} yet, so I can't watch its price."
        kind = "above" if price > last["close"] else "below"
        reply = (f"OK: I'll tell you when {sym} closes {kind} {views.px(price)} "
                 f"(last close {views.px(last['close'])}).")
    conn.execute("INSERT OR REPLACE INTO watch_alerts(chat_id, symbol, kind, price, created, fired) VALUES "
                 "(?,?,?,?,?,NULL)", (chat_id, sym, kind, price, _now()))
    conn.commit()
    return reply


def fire_watch_alerts(conn: sqlite3.Connection, token: str, data_date: str) -> int:
    """After a close: tell each connected friend about the stocks they follow. A BUY alert stays (it fires once per
    close with a BUY); a price alert is done once it fires. Returns how many were sent."""
    subs = _subscribers(conn)
    _, df = views.current_scan(conn)
    buys = {r["symbol"]: r for r in views.records(df) if r["action"] == "BUY"}
    sent = 0
    for a in conn.execute("SELECT * FROM watch_alerts ORDER BY chat_id, symbol").fetchall():
        if a["chat_id"] not in subs:          # disconnected: their alerts go too
            _drop_alert(conn, _alert_key(a))
            continue
        text = None
        if a["kind"] == "buy":
            b = buys.get(a["symbol"])
            if b and a["fired"] != data_date:
                text = (f"🔔 <b>{_e(a['symbol'])}</b> got a BUY signal at the {views.nice_date(data_date)} close: buy up "
                        f"to {views.px(b['entry_high'])} · stop {views.px(b['stop'])} · target {views.px(b['target'])}."
                        f"\nYour share count is on the website. /unwatch {_e(a['symbol'])} to stop these.")
        else:
            row = conn.execute("SELECT close FROM prices WHERE symbol=? AND date=?", (a["symbol"], data_date)).fetchone()
            if row and (row["close"] >= a["price"] if a["kind"] == "above" else row["close"] <= a["price"]):
                text = (f"🔔 <b>{_e(a['symbol'])}</b> closed at {views.px(row['close'])} on "
                        f"{views.nice_date(data_date)}: {a['kind']} your {views.px(a['price'])}. This alert is done.")
        if not text:
            continue
        try:
            send(token, a["chat_id"], text)
        except TelegramError:
            continue            # tried again after the next run
        sent += 1
        if a["kind"] == "buy":
            conn.execute("UPDATE watch_alerts SET fired=? WHERE chat_id=? AND symbol=? AND kind=?",
                         (data_date, *_alert_key(a)))
        else:
            _drop_alert(conn, _alert_key(a))
    conn.commit()
    return sent


def sync_subscribers(conn: sqlite3.Connection, token: str, code: str) -> dict:
    """Connect the friends who pressed Start through the site's link and disconnect those who sent /stop.
    Returns counts only (the logs are public)."""
    subs = _subscribers(conn)
    seen = int(db.get_meta(conn, "site_update_seen") or 0)
    fp = _fingerprint(code)
    replies, joined, left, commands = [], 0, 0, 0
    for u in sorted(call(token, "getUpdates", timeout=0, allowed_updates=["message"]), key=lambda u: u["update_id"]):
        if int(u["update_id"]) <= seen:
            continue
        seen = int(u["update_id"])
        msg = u.get("message") or {}
        chat = msg.get("chat") or {}
        if chat.get("type") != "private":
            continue
        cid, text = str(chat["id"]), (msg.get("text") or "").strip()
        m = START_RE.match(text)
        if m and hmac.compare_digest(m.group(1), code):
            if subs.get(cid, {}).get("code") != fp:
                name = " ".join(x for x in (chat.get("first_name"), chat.get("last_name")) if x)
                subs[cid] = {"name": name or chat.get("username") or "", "code": fp, "since": _now(), "sent_for": None}
                replies.append((cid, WELCOME))
                joined += 1
        elif STOP_RE.match(text) and cid in subs:
            del subs[cid]
            forget_alerts(conn, cid)
            replies.append((cid, STOPPED))
            left += 1
        elif cid in subs and (w := WEEKLY_RE.match(text)):
            subs[cid]["weekly"] = w.group(1).lower() != "off"
            replies.append((cid, "OK: you'll get the week's summary after Thursday's close." if subs[cid]["weekly"]
                            else "OK: no weekly summary. Send /weekly on to have it again."))
            commands += 1
        elif cid in subs and (reply := watch_command(conn, cid, text)):
            replies.append((cid, reply))
            commands += 1
    for cid in [c for c, s in subs.items() if s["code"] != fp]:   # the password changed
        del subs[cid]
        forget_alerts(conn, cid)
        replies.append((cid, RESET))
        left += 1
    db.set_meta(conn, "site_subscribers", json.dumps(subs))
    db.set_meta(conn, "site_update_seen", str(seen))
    for cid, text in replies:
        _reply(token, cid, text)
    return {"connected": len(subs), "joined": joined, "left": left, "commands": commands}


def send_to_subscribers(conn: sqlite3.Connection, token: str, text: str, data_date: str) -> dict:
    """Send this close's message to every connected friend who hasn't had it yet (a friend who connects later
    gets the latest one). A friend who blocked the bot is removed; other failures are tried again next run."""
    subs = _subscribers(conn)
    sent = failed = gone = 0
    for cid, s in list(subs.items()):
        if s.get("sent_for") == data_date:
            continue
        try:
            send(token, cid, text)
            s["sent_for"] = data_date
            sent += 1
        except TelegramError as exc:
            if exc.status == 403 or "chat not found" in str(exc).lower():
                del subs[cid]
                gone += 1
            else:
                failed += 1
    db.set_meta(conn, "site_subscribers", json.dumps(subs))
    return {"sent": sent, "failed": failed, "gone": gone}


# ------------------------------------------------------------------ the weekly summary (after Thursday's close)

HEALTH_WORDS = {"ok": "🟢 on track (its top picks keep beating the average stock)",
                "weak": "🟠 weaker than in its tests (still better than the average stock)",
                "bad": "🔴 not working lately (it adds no BUYs of its own until it does)",
                "early": "⚪ too early to judge its live results"}


def week_of(day: str) -> str:
    """The EGX week (Sunday–Thursday) a day belongs to, named by its Sunday."""
    d = date.fromisoformat(day)
    return (d - timedelta(days=(d.weekday() + 1) % 7)).isoformat()


def weekly_due(data_date: str | None, sent_for: str | None, today: date | None = None) -> bool:
    """The summary goes once a week: after Thursday's close, or on Friday or Saturday if Thursday's scan came late
    (or the week ended early for a holiday). Never for an older week's data."""
    if not data_date:
        return False
    today = today or datetime.now(scan.CAIRO).date()
    week = week_of(data_date)
    if sent_for == week or week_of(today.isoformat()) != week:
        return False
    return date.fromisoformat(data_date).weekday() == 3 or today.weekday() in (4, 5)


def build_weekly(d: views.Data, site_url: str = "", mine: bool = True) -> str:
    """The week in one message: the market, the week's BUY signals, how the last month's signals are doing, the
    paper account, and whether the prediction model still works. mine: your own positions too (your Mac)."""
    data_date = db.get_meta(d.conn, "scan_data_date")
    week = week_of(data_date)
    lines = [f"📅 <b>EGX Agent · the week of {views.nice_date(week)}</b>"]
    idx = d.prices(scan.prices.INDEX_SYMBOL)["close"]
    before = idx[idx.index < pd.Timestamp(week)]
    if len(idx) and len(before):
        lines.append(f"EGX30 {idx.iloc[-1]:,.0f}: {idx.iloc[-1] / before.iloc[-1] - 1:+.1%} this week")
    b = views.breadth_data(d)
    m = views.market_info(d.conn)
    if b:
        lines.append(_switch_line(breadth.verdict(b, m.get("risk_off") if m else None)))

    week_rows = d.conn.execute("SELECT scan_date, symbol, source FROM scans WHERE action='BUY' AND scan_date >= ? "
                               "ORDER BY scan_date", (week,)).fetchall()
    first = {}
    for r in week_rows:
        first.setdefault(r["symbol"], r)
    lines += ["", f"<b>BUY signals this week: {len(first)}</b>"]
    if first:
        lines.append(", ".join(f"{_e(s)}{' 🎯' if r['source'] == 'model' else ''} ({views.nice_date(r['scan_date'])})"
                               for s, r in first.items()))
    month = (date.fromisoformat(week) - timedelta(days=28)).isoformat()
    past = d.conn.execute("SELECT scan_date, symbol, close FROM scans WHERE action='BUY' AND scan_date >= ? "
                          "AND scan_date < ?", (month, week)).fetchall()
    closes = d.closes()
    moves = [closes[r["symbol"]] / r["close"] - 1 for r in past if r["symbol"] in closes and r["close"]]
    if moves:
        up = sum(x > 0 for x in moves)
        lines.append(f"The {len(moves)} BUY signals of the 4 weeks before: {sum(moves) / len(moves):+.1%} on average "
                     f"since their signal close, {up} of {len(moves)} up (before stops and targets).")

    if mine:
        positions = views.open_positions(d)
        if positions:
            lines += ["", f"<b>Your {len(positions)} position{'s' if len(positions) != 1 else ''}</b>"]
            for p in positions:
                lines.append(f"{_e(p['symbol'])} {p['pnl_pct']:+.1%} · {p['status'].lower()}")
    paper = portfolio.account_summary(d.conn, "paper", d.cfg, closes)
    if paper["open_count"] or paper["realized"]:
        lines += ["", f"Paper account {paper['equity']:,.0f} EGP ({paper['return_pct']:+.1%} since it started)"]
    meta = predict.load_meta(predict.model_dir(d.conn))
    if meta:
        h = predict.health(d.conn, meta)
        if h["status"] in HEALTH_WORDS:
            lines += ["", f"Prediction model: {HEALTH_WORDS[h['status']]}"]
    lines += ["", (f"{site_url}\n" if site_url else "") + "<i>Rules-based signals, not investment advice.</i>"
              + ("" if mine else " /weekly off stops this summary.")]
    text = "\n".join(lines)
    return text if len(text) <= MAX_LEN else text[:MAX_LEN - 20] + "\n…"


def weekly_after_scan(conn: sqlite3.Connection, cfg: dict) -> str:
    """Your Mac: the week's summary to your own Telegram, once a week."""
    token, chat = cfg.get("telegram_token"), cfg.get("telegram_chat_id")
    data_date = db.get_meta(conn, "scan_data_date")
    if not (token and chat) or not scan.scan_is_final(conn) \
            or not weekly_due(data_date, db.get_user_meta(conn, "weekly_sent_for")):
        return ""
    send(token, chat, build_weekly(views.Data(conn, cfg, views.Cache())))
    db.set_user_meta(conn, "weekly_sent_for", week_of(data_date))
    return "weekly summary sent"


def send_weekly_to_subscribers(conn: sqlite3.Connection, token: str, text: str, week: str) -> int:
    """The website: the week's summary to every connected friend who hasn't turned it off (/weekly off)."""
    subs = _subscribers(conn)
    sent = 0
    for cid, s in subs.items():
        if s.get("weekly", True) is False or s.get("weekly_for") == week:
            continue
        try:
            send(token, cid, text)
        except TelegramError:
            continue            # tried again next run
        s["weekly_for"] = week
        sent += 1
    db.set_meta(conn, "site_subscribers", json.dumps(subs))
    return sent


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
    if not force and not scan.scan_is_final(conn):
        return "waiting for the close"   # a scan during the session: the one after the close is sent
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
