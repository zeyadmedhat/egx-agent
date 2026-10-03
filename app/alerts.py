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
import math
import re
import secrets
import sqlite3
from datetime import date, datetime, timedelta

import pandas as pd
import requests

from egx_agent import breadth, config, db, levels, portfolio, predict, scan
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
    try:
        return collect_starts(conn, token).get(code)
    except TelegramError as exc:
        if exc.status != 409:
            raise
    # 409: the website's bot answers through its Cloudflare Worker (worker/bot.js), and Telegram hands the messages
    # only to it. The Worker notes each other /start, so ask it who pressed Start through this link.
    hook = (call(token, "getWebhookInfo").get("url") or "").removesuffix("/telegram")
    if not hook.startswith("https://"):
        raise TelegramError("Telegram gives this bot's messages to another program, so it can't be connected here.")
    try:
        r = requests.post(hook + "/started", json={"code": code}, timeout=20)
        found = r.json() if r.ok else {}
    except (requests.RequestException, ValueError):
        raise TelegramError("The bot's Cloudflare Worker didn't answer. Try again in a minute.") from None
    if not found.get("found"):
        return None
    return {"id": str(found["id"]), "name": found.get("name") or "you", "at": _now()}


def send(token: str, chat_id: str, text: str, buttons: list | None = None) -> None:
    params = dict(chat_id=chat_id, text=text, parse_mode="HTML", disable_web_page_preview=True)
    try:
        call(token, "sendMessage", **params, **({"reply_markup": {"inline_keyboard": buttons}} if buttons else {}))
    except TelegramError as exc:
        if not buttons or exc.status != 400:
            raise
        call(token, "sendMessage", **params)     # Telegram refused the buttons: the message matters more


# ------------------------------------------------------------------ the message

def _e(x) -> str:
    return html.escape(str(x), quote=False)


def _shariah(info: dict) -> str:
    egx = "EGX33 ✓" if info.get("egx33") else "EGX33 ✗"
    return f"{egx} · Kashif {KASHIF.get(info.get('kashif_status'), '–')}"


# The website's friends choose English or Arabic in Telegram (/lang; at first, their Telegram app's language).
MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"]
DAYS_AR = ["الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"]


def _date(day: str, lang: str = "en", weekday: bool = False) -> str:
    if lang != "ar":
        return views.nice_date(day, weekday)
    d = pd.Timestamp(day)
    return (f"{DAYS_AR[d.weekday()]} " if weekday else "") + f"{d.day} {MONTHS_AR[d.month - 1]}"


# The exit rules' notes (egx_agent/engine.py) in Arabic; anything else stays as written. In step with worker/bot.js.
NOTES_AR = [
    (r"^Trend break \(closed below 50-day average\)", "كسر الاتجاه (أغلق تحت متوسط 50 يومًا)"),
    (r"^Max hold reached \((\d+) trading days\)", r"انتهت مدة الاحتفاظ (\1 جلسة)"),
    (r"^Trailing stop", "الوقف المتحرك"), (r"^Breakeven stop", "وقف التعادل"), (r"^Stop-loss", "وقف الخسارة"),
    (r": closed at ([\d.]+), under your stop \(([\d.]+)\)", r": أغلق عند \1، تحت وقفك (\2)"),
    (r"^Target reached", "تم الوصول للهدف"), (r": sell at the next open", ": بع عند الافتتاح القادم"),
    (r": sell at the open \(flagged before ([\d-]+)\)", r": بع عند الافتتاح (ظهرت قبل \1)"),
    (r" \(gap down\)", " (فجوة هبوط)"), (r" \(gap up\)", " (فجوة صعود)"), (r" on ([\d-]+) at ([\d.]+)", r" يوم \1 عند \2"),
    (r"^Day (\d+): no \+1R move yet \(needs ([\d.]+)\)\. Consider exiting\.",
     r"اليوم \1: لم يتحرك +1R بعد (يحتاج \2). فكّر في الخروج."),
    (r"^Raise your stop to ([\d.]+)", r"ارفع وقفك إلى \1"), (r"^Stop ([\d.]+), target ([\d.]+)", r"الوقف \1، الهدف \2"),
]


def note_ar(text: str) -> str:
    for pattern, arabic in NOTES_AR:
        text = re.sub(pattern, arabic, text, count=1)
    return text


SWITCH_ICON = {"full": "🟢", "half": "🟡", "off": "🔴"}
SWITCH_AR = {"full": "حجم كامل", "half": "نصف الحجم", "off": "لا مشتريات جديدة"}


def _switch_line(v: dict, lang: str = "en") -> str:
    sw = v.get("switch")
    if not sw:
        return ""
    if lang == "ar":
        return f"مفتاح السوق: {SWITCH_ICON[sw['state']]} {SWITCH_AR.get(sw['state'], sw['label'])} (لاختيارات النموذج)"
    return f"Market switch: {SWITCH_ICON[sw['state']]} {sw['label']} (for the model's picks)"


def _caution_lines(items: list[dict], indent: str = "      ", lang: str = "en") -> list[str]:
    """A signal's or position's cautions (views.cautions_map), one short line each."""
    out, ar = [], lang == "ar"
    for c in items or []:
        day = _date(c["date"], lang) if c.get("date") else ""
        if c["kind"] == "ex_dividend":
            amt = (f" ({c['amount']:g} جنيه)" if ar else f" ({c['amount']:g} EGP)") if c.get("amount") else ""
            out.append(f"{indent}ℹ️ توزيع نقدي {day}{amt}: ينخفض السعر بقيمته صباح ذلك اليوم وتحصل عليه نقدًا؛ اخفض "
                       "الوقف بنفس القيمة في المساء السابق" if ar else
                       f"{indent}ℹ️ Ex-dividend {day}{amt}: the price drops by it that morning and you get it in cash; "
                       "lower the stop by the same amount the evening before")
        elif c["kind"] == "bad_news":
            out.append(f"{indent}⚠️ {'خبر' if ar else 'News'}: {_e(c['title'])} ({_e(c['source'])})")
        elif c["kind"] in ("bonus", "split"):
            out.append(f"{indent}ℹ️ {'أسهم منحة' if c['kind'] == 'bonus' else 'تجزئة'} {day}: يُعاد حساب السعر في ذلك اليوم"
                       if ar else
                       f"{indent}ℹ️ {'Bonus shares' if c['kind'] == 'bonus' else 'Split'} {day}: the price is re-based that day")
        elif c["kind"] == "rights":
            out.append(f"{indent}ℹ️ {'حق اكتتاب، التاريخ' if ar else 'Rights issue, ex-date'} {day}")
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


def _cold_lines(d: views.Data, lang: str = "en") -> list[str]:
    """On a day with BUYs: a warning when the BUYs' live record is clearly worse than the tests (record.health:
    10 points or more fewer winners, after 30 ended)."""
    h = views.signal_record(d)["health"]
    if h["status"] != "cold":
        return []
    if lang == "ar":
        return ["", f"⚠️ آخر {h['closed']} إشارة ربحت {h['win_rate']:.0%} مقابل {h['test_win_rate']:.0%} في الاختبارات. "
                    "فكّر في مراكز أصغر حتى تتحسن."]
    return ["", f"⚠️ The last {h['closed']} signals won {h['win_rate']:.0%} against {h['test_win_rate']:.0%} in the tests. "
                "Consider smaller positions until they recover."]


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
    if any(it["kind"] == "buy" for it in o["items"]):
        body += _cold_lines(d)
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


def build_site_message(d: views.Data, site_url: str = "", lang: str = "en", personal: list[str] | None = None) -> str:
    """The GitHub Pages site's message, sent to each friend who connected Telegram: the day's signals for everyone,
    without share counts (each person sizes them with their own numbers on the site). `personal`: the friend's own
    positions (personal_part), when their portfolio is linked to the bot; None when it isn't."""
    ar = lang == "ar"
    m = views.market_info(d.conn)
    scan_date, df = views.current_scan(d.conn)
    if not m or not scan_date:
        return "<b>EGX Agent</b>\n" + ("لا يوجد فحص بعد." if ar else "No scan yet.")
    rows = views.records(df)
    buys = [r for r in rows if r["action"] == "BUY"]
    session = views.sessions_after(scan_date, 1)
    blocked = m.get("risk_off") and d.cfg.get("riskoff_block_buys")
    if ar:
        mood = ("🔴 تجنب المخاطر" + (": لا مشتريات جديدة" if blocked else "")) if m.get("risk_off") else "🟢 السوق جيد"
        lines = [f"<b>EGX Agent · إغلاق {_date(scan_date, lang, True)}</b>"]
    else:
        mood = ("🔴 Risk-off" + (": no new buys" if blocked else "")) if m.get("risk_off") else "🟢 Market OK"
        lines = [f"<b>EGX Agent · {views.nice_date(scan_date, True)} close</b>"]
    lines.append(f"EGX30 {m['egx30_close']:,.0f} ({m['egx30_change']:+.1%}) · {mood}")
    b = views.breadth_data(d)
    if b:
        v = breadth.verdict(b, m.get("risk_off"))
        if v["change_week"] is None:
            week = ""
        else:
            week = f" ({v['change_week'] * 100:+.0f} {'نقطة في أسبوع' if ar else 'pts in a week'})"
        lines.append(f"الاتساع: {b['above50']:.0%} من الأسهم فوق متوسط 50 يومًا{week}" if ar else
                     f"Breadth: {b['above50']:.0%} of stocks above their 50-day average{week}")
        lines.append(_switch_line(v, lang))
    preds = views.predictions(d)
    warn = views.cautions_map(d)
    if ar:
        lines += ["", f"<b>إشارات الشراء لجلسة {_date(session, lang, True)}</b>" if buys
                  else "<b>لا توجد إشارات شراء</b> عند هذا الإغلاق."]
    else:
        lines += ["", f"<b>BUY signals for {views.nice_date(session, True)}</b>" if buys
                  else "<b>No BUY signals</b> at this close."]
    for r in sorted(buys, key=views.signal_order):      # the order money goes in: the model's rank first
        lines.append(_buy_line(r, lang))
        extra = [f"{'التقييم' if ar else 'score'} {r['score']:.0f}", _shariah(d.info(r["symbol"]))]
        pr = preds["by_symbol"].get(r["symbol"])
        if pr and pr.get("p10") is not None and preds["base"].get(10):
            if ar:
                extra.append(f"من أفضل اختيارات النموذج {pr['p10']:.0%} (المتوسط {preds['base'][10]:.0%})"
                             if pr.get("top10") else "ليس من أفضل اختيارات النموذج")
            else:
                extra.append(f"model top pick {pr['p10']:.0%} (avg {preds['base'][10]:.0%})" if pr.get("top10")
                             else "not a model top pick")
        lines.append("      " + " · ".join(extra))
        lines += _caution_lines(warn.get(r["symbol"]), lang=lang)
    if buys:
        lines += _cold_lines(d, lang)
    near = sorted((r for r in rows if r["action"] != "BUY"), key=views.signal_order)
    if near:              # the site's "Close to a BUY" list: the first few by the same order
        names, more = [_e(r["symbol"]) for r in near[:3]], len(near) - 3
        lines.append(f"قريبة من الشراء: {'، '.join(names)}" + (f" و{more} أخرى" if more > 0 else "") + "." if ar else
                     f"Close to a BUY: {', '.join(names)}" + (f" and {more} more" if more > 0 else "") + ".")
    if personal:
        lines += personal
    if ar:
        foot = ("عدد الأسهم لكل صفقة وفلتر الشريعة على الموقع." if personal is not None else
                "افتح الموقع لعدد الأسهم وفلتر الشريعة وما تفعله في مراكزك، أو اربط محفظتك (الإعدادات ← ربط تيليجرام) "
                "لتصلك أوامرك هنا.")
        lines += ["", foot + (f"\n{site_url}" if site_url else ""), "",
                  "<i>إشارات مبنية على قواعد، وليست نصيحة استثمارية.</i> أرسل /stop لإيقاف هذه الرسائل."]
    else:
        foot = ("Your share counts and Shariah filter are on the site." if personal is not None else
                "Open the site for your share counts, your Shariah filter and what to do with your own positions, "
                "or link your portfolio (Settings → Connect Telegram) to get your orders here.")
        lines += ["", foot + (f"\n{site_url}" if site_url else ""), "",
                  "<i>Rules-based signals, not investment advice.</i> Send /stop to stop these messages."]
    text = "\n".join(lines)
    return text if len(text) <= MAX_LEN else text[:MAX_LEN - 20] + ("\n…المزيد على الموقع." if ar else "\n…more on the site.")


def _buy_line(r: dict, lang: str = "en") -> str:
    lv = (views.px(r["entry_high"]), views.px(r["stop"]), views.px(r["target"]))
    if lang == "ar":
        pick = " (اختيار النموذج)" if r.get("source") == "model" else ""
        return f"🟢 <b>{_e(r['symbol'])}</b>{pick}: اشترِ حتى {lv[0]} · الوقف {lv[1]} · الهدف {lv[2]}"
    pick = " (model pick)" if r.get("source") == "model" else ""
    return f"🟢 <b>{_e(r['symbol'])}</b>{pick}: buy up to {lv[0]} · stop {lv[1]} · target {lv[2]}"


def personal_part(d: views.Data, positions: list[dict], lang: str = "en") -> tuple[list[str], bool]:
    """A linked friend's own positions (views.book_positions) for the evening message: what to do at the next
    session, most urgent first, as the orders list on the site. Also whether there is anything to do."""
    o = views.orders(d, positions) if positions else None
    if not o:
        return [], False
    items = _order_items(o, positions, lang)
    lines = ["", "<b>مراكزك</b>" if lang == "ar" else "<b>Your positions</b>"]
    for kind, title, detail in items:
        lines += [f"{ICON[kind]} <b>{title}</b>", f"      {_e(detail)}"]
    if o["holds"]:
        ar = lang == "ar"
        lines.append(("تحتفظ بـ: " if ar else "Holding: ") + ("، " if ar else ", ").join(
            f"{_e(h['symbol'])} ({'الوقف' if ar else 'stop'} {views.px(h['stop'])}، {'اليوم' if ar else 'day'} {h['day']})"
            if ar else f"{_e(h['symbol'])} (stop {views.px(h['stop'])}, day {h['day']})" for h in o["holds"]))
    return lines, bool(items)


def morning_message(d: views.Data, positions: list[dict], lang: str = "en") -> str | None:
    """The reminder the Worker sends at 9:30 Cairo, before the session the last close's orders are for: only what
    to do at the open (a linked friend's own orders, then the BUY signals), or None when there's nothing to do."""
    scan_date, df = views.current_scan(d.conn)
    if not scan_date:
        return None
    o = views.orders(d, positions) if positions else None
    items = _order_items(o, positions, lang) if o else []
    buys = sorted((r for r in views.records(df) if r["action"] == "BUY"), key=views.signal_order)
    if not items and not buys:
        return None
    ar = lang == "ar"
    lines = [f"☀️ <b>{'قبل الافتتاح' if ar else 'Before the open'}</b> "
             f"({'من إغلاق' if ar else 'from the'} {_date(scan_date, lang, True) if ar else views.nice_date(scan_date, True)}"
             f"{'' if ar else ' close'})"]
    lines += [f"{ICON[kind]} {title}" for kind, title, _ in items]
    lines += [_buy_line(r, lang) for r in buys]
    if buys:
        lines.append("عدد الأسهم لكل صفقة على الموقع." if ar else "Your share counts are on the site.")
    lines.append("/morning off يوقف هذا التذكير." if ar else "/morning off stops this reminder.")
    text = "\n".join(lines)
    return text if len(text) <= MAX_LEN else text[:MAX_LEN - 20] + "\n…"


def _order_items(o: dict, positions: list[dict], lang: str) -> list[tuple[str, str, str]]:
    """views.orders' items for your own positions (the BUYs are for everyone, without share counts), each
    (kind, title, detail) in the friend's language; the English title is HTML-escaped here."""
    ar = lang == "ar"
    items = [it for it in o["items"] if it["kind"] != "buy"]
    days = {p["symbol"]: p["day"] for p in positions}
    out = []
    for it in items:
        sym = _e(it["symbol"])
        if not ar:
            title, detail = it["title"], it["detail"]
        elif it["kind"] == "adjust":
            title = f"حدّث {sym} لأسهم المنحة أو التجزئة"
            detail = "على صفحة محفظتي أدخل عدد الأسهم التي تملكها الآن. لا يمكن فحص الوقف حتى تفعل."
        elif it["kind"] == "sell":
            title, detail = f"بع كل {it['shares']:,} من {sym} عند الافتتاح", note_ar(it["detail"])
        elif it["kind"] == "stop" and it["key"].startswith("exdiv:"):
            amount = it["from"] - it["to"]
            title = f"اخفض وقف {sym} إلى {views.px(it['to'])} قبل الافتتاح"
            detail = (f"{sym} يصرف توزيعًا نقديًا: يفتح السعر أقل بحوالي {amount:g} جنيه وتحصل على {amount:g} جنيه "
                      "للسهم. يخفض الوكيل الوقف والهدف بنفس القيمة حتى لا يبيع الهبوط وحده.")
        elif it["kind"] == "stop":
            title = f"ارفع وقف {sym} إلى {views.px(it['to'])}"
            detail = f"كان {views.px(it['from'])}. بع إذا هبط السعر إلى {views.px(it['to'])}."
        else:
            title, detail = f"قرّر بشأن {sym}: اليوم {days.get(it['symbol'], '')} بدون تقدم", note_ar(it["detail"])
        out.append((it["kind"], title if ar else _e(title), detail))
    return out


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
WATCH_RE = re.compile(r"^/watch(?:@\w+)?\s+([A-Za-z0-9]{2,12})(?:\s+([0-9]+(?:[.,][0-9]+)?|levels))?\s*$", re.I)
UNWATCH_RE = re.compile(r"^/unwatch(?:@\w+)?\s+([A-Za-z0-9]{2,12})\s*$", re.I)
LIST_RE = re.compile(r"^/(?:list|alerts)(?:@\w+)?\s*$", re.I)
WEEKLY_RE = re.compile(r"^/weekly(?:@\w+)?\s+(on|off)\s*$", re.I)
QUIET_RE = re.compile(r"^/quiet(?:@\w+)?(?:\s+(on|off))?\s*$", re.I)
MORNING_RE = re.compile(r"^/morning(?:@\w+)?(?:\s+(on|off))?\s*$", re.I)
LANG_RE = re.compile(r"^/lang(?:@\w+)?(?:\s+(\S+))?\s*$", re.I)
LANG_WORDS = {"ar": "ar", "arabic": "ar", "عربي": "ar", "العربية": "ar", "en": "en", "english": "en", "انجليزي": "en",
              "الإنجليزية": "en"}
MAX_ALERTS = 20


def _lang_of(msg: dict) -> str | None:
    """The language of the person's Telegram app, if it says: "ar" or "en"."""
    code = str((msg.get("from") or {}).get("language_code") or "")
    return ("ar" if code.startswith("ar") else "en") if code else None
HELP = ("<b>Alerts for the stocks you follow</b>, checked after each close:\n"
        "/watch COMI: when COMI gets a BUY signal\n"
        "/watch COMI 45: when COMI closes above 45 (or below, if 45 is under today's price)\n"
        "/watch COMI levels: when COMI closes near a strong support (a place to buy) or reaches resistance "
        "(a place to take profit)\n"
        "/unwatch COMI: stop COMI's alerts (/unwatch all: every alert)\n"
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
    if a["kind"] == "levels":
        return f"{a['symbol']}: near support or resistance"
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
        n = forget_alerts(conn, chat_id, None if sym == "ALL" else sym)
        if sym == "ALL":
            conn.commit()
            return f"Removed all your alerts ({n})." if n else "You have no alerts."
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
    elif m.group(2).lower() == "levels":
        kind, price = "levels", None
        reply = (f"OK: I'll tell you when {sym} closes near a strong support or reaches resistance "
                 "(the levels on its page on the website).")
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


NEAR_SUPPORT = 0.015    # a close this close above a strong support zone's top (or inside it) is "near support"


def level_touch(d: views.Data, symbol: str, data_date: str, lang: str = "en") -> dict | None:
    """Did the close on `data_date` come near a strong support or reach a strong resistance (levels.py)?
    {key, text}: the key names the zone, so the same touch isn't sent again day after day."""
    ind = d.indicators(symbol)
    if ind.empty or str(ind.index[-1].date()) != data_date:
        return None
    p = levels.plan_at(ind, d.cfg)
    if not p:
        return None
    c, name = p["close"], _e(symbol)
    sup = next((z for z in p["supports"] if z["strength"] >= levels.SOLID), None)
    res = next((z for z in p["resistances"] if z["strength"] >= levels.SOLID), None)
    if lang == "ar" and sup and c <= sup["high"] * (1 + NEAR_SUPPORT):
        return {"key": f"support {sup['price']:.2f}", "text": (
            f"🔔 <b>{name}</b> أغلق عند {views.px(c)} يوم {_date(data_date, lang)}، قرب الدعم عند {views.px(sup['price'])} "
            f"({_e(', '.join(sup['sources'][:2]))}). دخل المشترون هناك من قبل؛ وإغلاق أقل منه بوضوح يكسره. "
            f"وقف الرسم البياني {views.px(p['stop'])}، الهدف {views.px(p['target'])}.")}
    if lang == "ar" and res and c >= res["low"] * 0.99:
        return {"key": f"resistance {res['price']:.2f}", "text": (
            f"🔔 <b>{name}</b> أغلق عند {views.px(c)} يوم {_date(data_date, lang)}، عند المقاومة {views.px(res['price'])} "
            f"({_e(', '.join(res['sources'][:2]))}). دخل البائعون هناك من قبل: مكان لجني بعض الربح، أو انتظر إغلاقًا "
            "واضحًا فوقها.")}
    if sup and c <= sup["high"] * (1 + NEAR_SUPPORT):
        return {"key": f"support {sup['price']:.2f}", "text": (
            f"🔔 <b>{name}</b> closed at {views.px(c)} on {views.nice_date(data_date)}, near support at "
            f"{views.px(sup['price'])} ({_e(', '.join(sup['sources'][:2]))}). Buyers stepped in there before; a close "
            f"well under it would break it. Chart stop {views.px(p['stop'])}, target {views.px(p['target'])}.")}
    if res and c >= res["low"] * 0.99:
        return {"key": f"resistance {res['price']:.2f}", "text": (
            f"🔔 <b>{name}</b> closed at {views.px(c)} on {views.nice_date(data_date)}, at resistance "
            f"{views.px(res['price'])} ({_e(', '.join(res['sources'][:2]))}). Sellers stepped in there before: "
            "a place to take some profit, or to wait for a clear close above it.")}
    return None


def fire_watch_alerts(conn: sqlite3.Connection, token: str, data_date: str, cfg: dict | None = None) -> int:
    """After a close: tell each connected friend about the stocks they follow. A BUY alert stays (it fires once per
    close with a BUY); a price alert is done once it fires. Returns how many were sent."""
    subs = _subscribers(conn)
    cache = views.Cache()
    _, df = views.current_scan(conn)
    buys = {r["symbol"]: r for r in views.records(df) if r["action"] == "BUY"}
    sent = 0
    for a in conn.execute("SELECT * FROM watch_alerts ORDER BY chat_id, symbol").fetchall():
        if a["chat_id"] not in subs:          # disconnected: their alerts go too
            _drop_alert(conn, _alert_key(a))
            continue
        text = None
        ar = subs[a["chat_id"]].get("lang") == "ar"
        stop_these = (f"\n/unwatch {_e(a['symbol'])} لإيقاف هذه التنبيهات." if ar
                      else f"\n/unwatch {_e(a['symbol'])} to stop these.")
        if a["kind"] == "buy":
            b = buys.get(a["symbol"])
            if b and a["fired"] != data_date:
                lv = (views.px(b["entry_high"]), views.px(b["stop"]), views.px(b["target"]))
                text = (f"🔔 <b>{_e(a['symbol'])}</b> حصل على إشارة شراء عند إغلاق {_date(data_date, 'ar')}: اشترِ حتى "
                        f"{lv[0]} · الوقف {lv[1]} · الهدف {lv[2]}.\nعدد الأسهم على الموقع." if ar else
                        f"🔔 <b>{_e(a['symbol'])}</b> got a BUY signal at the {views.nice_date(data_date)} close: buy up "
                        f"to {lv[0]} · stop {lv[1]} · target {lv[2]}.\nYour share count is on the website.") + stop_these
        elif a["kind"] == "levels":
            hit = level_touch(views.Data(conn, cfg or config.DEFAULTS, cache), a["symbol"], data_date,
                              "ar" if ar else "en")
            if hit and a["fired"] != hit["key"]:
                text = hit["text"] + stop_these
        else:
            row = conn.execute("SELECT close FROM prices WHERE symbol=? AND date=?", (a["symbol"], data_date)).fetchone()
            if row and (row["close"] >= a["price"] if a["kind"] == "above" else row["close"] <= a["price"]):
                text = (f"🔔 <b>{_e(a['symbol'])}</b> أغلق عند {views.px(row['close'])} يوم {_date(data_date, 'ar')}: "
                        f"{'فوق' if a['kind'] == 'above' else 'تحت'} سعرك {views.px(a['price'])}. انتهى هذا التنبيه." if ar else
                        f"🔔 <b>{_e(a['symbol'])}</b> closed at {views.px(row['close'])} on "
                        f"{views.nice_date(data_date)}: {a['kind']} your {views.px(a['price'])}. This alert is done.")
        if not text:
            continue
        try:
            send(token, a["chat_id"], text)
        except TelegramError:
            continue            # tried again after the next run
        sent += 1
        if a["kind"] in ("buy", "levels"):      # standing alerts: remember what was sent, so it isn't sent twice
            conn.execute("UPDATE watch_alerts SET fired=? WHERE chat_id=? AND symbol=? AND kind=?",
                         (data_date if a["kind"] == "buy" else hit["key"], *_alert_key(a)))
        else:
            _drop_alert(conn, _alert_key(a))
    conn.commit()
    return sent


def sync_subscribers(conn: sqlite3.Connection, token: str, code: str, updates: list | None = None,
                     answered: bool = False) -> dict:
    """Connect the friends who pressed Start through the site's link and disconnect those who sent /stop.
    `updates`: the messages, when the Worker collected them (it has `answered` them already), else read here.
    Returns counts only (the logs are public)."""
    subs = _subscribers(conn)
    seen = int(db.get_meta(conn, "site_update_seen") or 0)
    fp = _fingerprint(code)
    replies, joined, left, commands = [], 0, 0, 0
    if updates is None:
        updates = call(token, "getUpdates", timeout=0, allowed_updates=["message"])
    for u in sorted(updates, key=lambda u: u["update_id"]):
        if int(u["update_id"]) <= seen:
            continue
        seen = int(u["update_id"])
        msg = u.get("message") or {}
        chat = msg.get("chat") or {}
        if chat.get("type") != "private":
            continue
        cid, text = str(chat["id"]), (msg.get("text") or "").strip()
        told = _lang_of(msg)
        if cid in subs and told and not subs[cid].get("lang"):
            subs[cid]["lang"] = told       # their Telegram app's language, until they choose with /lang
        m = START_RE.match(text)
        # The site's Connect button may add a browser's link after the code (the Worker links that browser).
        if m and hmac.compare_digest(m.group(1)[:len(code)], code):
            if subs.get(cid, {}).get("code") != fp:
                name = " ".join(x for x in (chat.get("first_name"), chat.get("last_name")) if x)
                subs[cid] = {"name": name or chat.get("username") or "", "code": fp, "since": _now(), "sent_for": None,
                             **({"lang": told} if told else {})}
                replies.append((cid, WELCOME))
                joined += 1
        elif cid in subs and (q := QUIET_RE.match(text)):
            subs[cid]["quiet"] = (q.group(1) or "on").lower() == "on"
            replies.append((cid, "OK: after a close I'll only message you when there's something to do." if subs[cid]["quiet"]
                            else "OK: you'll get every close's message again."))
            commands += 1
        elif cid in subs and (mo := MORNING_RE.match(text)):
            subs[cid]["morning"] = (mo.group(1) or "on").lower() == "on"
            replies.append((cid, "OK: I'll remind you at 9:30 on days with something to do at the open."
                            if subs[cid]["morning"] else "OK: no morning reminder. /morning on to have it again."))
            commands += 1
        elif cid in subs and (lg := LANG_RE.match(text)):
            now = subs[cid].get("lang") or told or "en"
            subs[cid]["lang"] = LANG_WORDS.get((lg.group(1) or "").lower()) or ("en" if now == "ar" else "ar")
            replies.append((cid, "تم: سأرد بالعربية." if subs[cid]["lang"] == "ar" else "OK: I'll answer in English."))
            commands += 1
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
    if answered:
        replies = []
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


# The Cloudflare Worker (worker/bot.js) that answers the bot's messages at once. Set up with
# "Set up instant Telegram replies.command"; the run finds it through the WORKER_URL and WORKER_KEY secrets.

def worker_call(url: str, key: str, path: str, body: dict | None = None) -> dict:
    try:
        r = requests.request("POST" if body is not None else "GET", url.rstrip("/") + path, json=body, timeout=30,
                             headers={"Authorization": f"Bearer {key}"})
        r.raise_for_status()
        return r.json()
    except (requests.RequestException, ValueError) as exc:
        raise TelegramError(f"The Telegram Worker didn't answer ({type(exc).__name__}).") from None


def _r(v, digits=3):
    return None if v is None or not math.isfinite(v) else round(float(v), digits)


def bot_info(conn: sqlite3.Connection, cfg: dict) -> dict:
    """What the bot answers /stock, /top, /buys and /why from: each stock's last close, today's signal, the prediction
    model's chances and rating, the company's results in brief (co), the chart's stop, target and nearest support and
    resistance, and the BUY rule's checks
    (k: liquid, uptrend, breakout, volume, ADX as 1/0, with the 20-day high, volume ratio and ADX behind them).
    Short keys: it's sent every run."""
    d = views.Data(conn, cfg, views.Cache())
    scan_date, df = views.current_scan(conn)
    sig = {r["symbol"]: r for r in views.records(df)}
    pred = predict.latest(conn)
    pred = {} if pred.empty else views.clean(pred.to_dict("index"))
    preds = views.predictions(d)
    firms = views.company_brief(d)
    names = dict(conn.execute("SELECT symbol, name_ar FROM stocks").fetchall())
    stocks = {}
    for sym, last in d.last_two().items():
        s = {"n": names.get(sym) or "", "c": last["close"], "d": last["date"],
             "ch": _r(last["close"] / last["prev"] - 1, 4) if last["prev"] else None}
        if sym in sig:
            r = sig[sym]
            s.update(a=r["action"], e=_r(r.get("entry_high")), s=_r(r.get("stop")), t=_r(r.get("target")))
        p = pred.get(sym) or {}
        for hz in (10, 20):
            if p.get(f"p{hz}") is not None:
                s.update({f"p{hz}": _r(p[f"p{hz}"]), f"r{hz}": p.get(f"rank{hz}"), f"x{hz}": _r(p.get(f"exp{hz}"), 4)})
        g = (preds["by_symbol"].get(sym) or {}).get("rating")
        if g is not None:
            s["g"] = g
        if co := firms.get(sym):                # the company's results in brief, for /why
            s["co"] = [_r(co.get(k), 3) for k in ("growth", "sales", "margin", "pe", "sector_pe")]
        ind = d.indicators(sym)
        try:
            plan = levels.plan_at(ind, cfg)
        except Exception:
            plan = None
        try:
            k = views.rule_checks(ind, cfg) if len(ind) >= 30 else None
        except Exception:  # one odd price history must not stop the bot's data for every stock
            k = None
        if k:
            s.update(k="".join("1" if k[x] else "0" for x in ("liquid", "trend", "breakout", "volume", "adx")),
                     h20=_r(k["high20"]), vr=_r(k["vol_ratio"], 2), adx=_r(k["adx14"], 1))
        if plan:
            s.update(cs=_r(plan["stop"]), ct=_r(plan["target"]),
                     sup=_r(plan["supports"][0]["price"]) if plan["supports"] else None,
                     res=_r(plan["resistances"][0]["price"]) if plan["resistances"] else None)
        stocks[sym] = s
    # final: False while the scan is one taken during the session (the Worker then still asks for the one after it)
    return {"scan": scan_date, "final": scan.scan_is_final(conn), "pred": db.get_meta(conn, "prediction_date"),
            "stocks": stocks, "bands": [[b["from"], b["to"], _r(b["hit"], 4), _r(b["ret"], 4)] for b in preds.get("bands") or []],
            "base10": _r((preds.get("base") or {}).get("10"), 4), "rated": preds.get("count") or 0,
            "min_value": cfg["min_avg_value_egp"]}


def worker_state(conn: sqlite3.Connection, code: str, cfg: dict | None = None, extra: dict | None = None) -> dict:
    """What the Worker needs to answer on its own: who's connected (and their language and /quiet), their alerts, and
    each stock's last close. `extra`: the site's address and key (for the mini app) and each linked friend's
    positions as checked at this close ("mine")."""
    alerts: dict = {}
    for a in conn.execute("SELECT chat_id, symbol, kind, price FROM watch_alerts"):
        alerts.setdefault(a["chat_id"], []).append({"symbol": a["symbol"], "kind": a["kind"], "price": a["price"]})
    stocks = {r["symbol"]: r["close"] for r in conn.execute(
        "SELECT s.symbol, (SELECT close FROM prices p WHERE p.symbol = s.symbol ORDER BY date DESC LIMIT 1) AS close "
        "FROM stocks s")}
    extra = dict(extra or {})
    info = {**bot_info(conn, cfg or config.DEFAULTS), **({"site": extra.pop("site")} if extra.get("site") else {})}
    return {"fp": _fingerprint(code), "seen": int(db.get_meta(conn, "site_update_seen") or 0), "stocks": stocks,
            "subs": {c: {"weekly": s.get("weekly", True), **{k: s[k] for k in ("lang", "quiet") if s.get(k)},
                         **({"morning": False} if s.get("morning") is False else {})}
                     for c, s in _subscribers(conn).items()},
            "alerts": alerts, "info": info, **{k: v for k, v in extra.items() if k != "site"}}


def send_to_subscribers(conn: sqlite3.Connection, token: str, text, data_date: str) -> dict:
    """Send this close's message to every connected friend who hasn't had it yet (a friend who connects later
    gets the latest one). A friend who blocked the bot is removed; other failures are tried again next run.
    `text`: the message, or a function of (chat, friend) giving theirs: {"text", "buttons"}, or None for nothing
    today (/quiet on a day with nothing to do)."""
    subs = _subscribers(conn)
    sent = failed = gone = 0
    for cid, s in list(subs.items()):
        if s.get("sent_for") == data_date:
            continue
        mine = text(cid, s) if callable(text) else {"text": text}
        if mine is None:
            s["sent_for"] = data_date
            continue
        try:
            if mine.get("buttons"):
                send(token, cid, mine["text"], mine["buttons"])
            else:
                send(token, cid, mine["text"])
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


HEALTH_AR = {"ok": "🟢 على المسار (أفضل اختياراته تتفوق على السهم المتوسط)",
             "weak": "🟠 أضعف من اختباراته (ما زال أفضل من السهم المتوسط)",
             "bad": "🔴 لا يعمل مؤخرًا (لا يضيف إشارات شراء خاصة به حتى يتحسن)",
             "early": "⚪ مبكر للحكم على نتائجه الفعلية"}


def build_weekly(d: views.Data, site_url: str = "", mine: bool = True, lang: str = "en") -> str:
    """The week in one message: the market, the week's BUY signals, how the last month's signals are doing, the
    paper account, and whether the prediction model still works. mine: your own positions too (your Mac)."""
    ar = lang == "ar"
    data_date = db.get_meta(d.conn, "scan_data_date")
    week = week_of(data_date)
    lines = [f"📅 <b>EGX Agent · أسبوع {_date(week, lang)}</b>" if ar
             else f"📅 <b>EGX Agent · the week of {views.nice_date(week)}</b>"]
    idx = d.prices(scan.prices.INDEX_SYMBOL)["close"]
    before = idx[idx.index < pd.Timestamp(week)]
    if len(idx) and len(before):
        lines.append(f"EGX30 {idx.iloc[-1]:,.0f}: {idx.iloc[-1] / before.iloc[-1] - 1:+.1%} "
                     + ("هذا الأسبوع" if ar else "this week"))
    b = views.breadth_data(d)
    m = views.market_info(d.conn)
    if b:
        lines.append(_switch_line(breadth.verdict(b, m.get("risk_off") if m else None), lang))

    week_rows = d.conn.execute("SELECT scan_date, symbol, source FROM scans WHERE action='BUY' AND scan_date >= ? "
                               "ORDER BY scan_date", (week,)).fetchall()
    first = {}
    for r in week_rows:
        first.setdefault(r["symbol"], r)
    lines += ["", f"<b>إشارات الشراء هذا الأسبوع: {len(first)}</b>" if ar else f"<b>BUY signals this week: {len(first)}</b>"]
    if first:
        lines.append(("، " if ar else ", ").join(
            f"{_e(s)}{' 🎯' if r['source'] == 'model' else ''} ({_date(r['scan_date'], lang)})" for s, r in first.items()))
    month = (date.fromisoformat(week) - timedelta(days=28)).isoformat()
    past = d.conn.execute("SELECT scan_date, symbol, close FROM scans WHERE action='BUY' AND scan_date >= ? "
                          "AND scan_date < ?", (month, week)).fetchall()
    closes = d.closes()
    moves = [closes[r["symbol"]] / r["close"] - 1 for r in past if r["symbol"] in closes and r["close"]]
    if moves:
        up, avg = sum(x > 0 for x in moves), sum(moves) / len(moves)
        lines.append(f"إشارات الشراء الـ{len(moves)} في الأسابيع الأربعة السابقة: {avg:+.1%} في المتوسط منذ إغلاق "
                     f"الإشارة، {up} من {len(moves)} صاعدة (قبل الوقف والهدف)." if ar else
                     f"The {len(moves)} BUY signals of the 4 weeks before: {avg:+.1%} on average "
                     f"since their signal close, {up} of {len(moves)} up (before stops and targets).")

    if mine:
        positions = views.open_positions(d)
        if positions:
            lines += ["", f"<b>Your {len(positions)} position{'s' if len(positions) != 1 else ''}</b>"]
            for p in positions:
                lines.append(f"{_e(p['symbol'])} {p['pnl_pct']:+.1%} · {p['status'].lower()}")
    paper = portfolio.account_summary(d.conn, "paper", d.cfg, closes)
    if paper["open_count"] or paper["realized"]:
        lines += ["", f"الحساب التجريبي {paper['equity']:,.0f} جنيه ({paper['return_pct']:+.1%} منذ بدايته)" if ar else
                  f"Paper account {paper['equity']:,.0f} EGP ({paper['return_pct']:+.1%} since it started)"]
    meta = predict.load_meta(predict.model_dir(d.conn))
    if meta:
        h = predict.health(d.conn, meta)
        if h["status"] in HEALTH_WORDS:
            lines += ["", f"نموذج التوقع: {HEALTH_AR[h['status']]}" if ar else
                      f"Prediction model: {HEALTH_WORDS[h['status']]}"]
    if ar:
        lines += ["", (f"{site_url}\n" if site_url else "") + "<i>إشارات مبنية على قواعد، وليست نصيحة استثمارية.</i>"
                  + ("" if mine else " /weekly off يوقف هذا الملخص.")]
    else:
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


def send_weekly_to_subscribers(conn: sqlite3.Connection, token: str, text, week: str) -> int:
    """The website: the week's summary to every connected friend who hasn't turned it off (/weekly off).
    `text`: one message, or {language: message}."""
    subs = _subscribers(conn)
    sent = 0
    for cid, s in subs.items():
        if s.get("weekly", True) is False or s.get("weekly_for") == week:
            continue
        try:
            send(token, cid, text.get(s.get("lang") or "en", text["en"]) if isinstance(text, dict) else text)
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
