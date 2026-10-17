"""Bonus shares, splits and cash dividends on your positions.

EGX companies often hand out bonus shares. When they do, TradingView divides all past prices by the ratio
(÷1.25 for 1 free share for every 4 held). A position logged at the old prices would then look like a big
loss and could trigger a false stop-loss EXIT, so it is flagged until you confirm your new share count.
Paper trades are updated by themselves.

A rights issue re-bases the prices too (by the right's value), but the shares don't follow by themselves: holders
subscribe to new shares at the issue price, or sell their rights. So the share count is yours to give, with what
each new share cost.
"""
from __future__ import annotations

import math
import re
import sqlite3
from datetime import date
from fractions import Fraction

import pandas as pd


def describe(factor: float) -> str:
    """Plain words for a price ratio: 1.25 → '1 free share for every 4 you hold'."""
    if factor >= 1:
        if factor >= 2 and abs(factor - round(factor)) < 1e-6:
            return f"{round(factor)} shares for each 1 you held (split or bonus)"
        frac = Fraction(factor - 1).limit_denominator(20)
        if frac and abs(float(frac) - (factor - 1)) < 1e-6:
            k, n = frac.numerator, frac.denominator
            return f"{k} free share{'s' if k > 1 else ''} for every {n} you hold"
        return f"prices divided by {factor:.4g}"
    inv = 1 / factor
    if abs(inv - round(inv)) < 1e-6:
        return f"every {round(inv)} shares combined into 1"
    return f"prices multiplied by {inv:.4g}"


def expected_shares(shares: int, factor: float) -> int:
    """Your share count after the event; fractions of a share are usually paid out in cash, so round down."""
    return max(1, math.floor(shares * factor + 1e-6))


# A re-base within a week of a rights issue's ex-date (data/news.py's corporate actions) was that rights issue.
RIGHTS_SQL = """EXISTS (SELECT 1 FROM corp_actions a WHERE a.symbol = e.symbol AND a.kind = 'rights'
                        AND ABS(julianday(a.effective) - julianday(e.ex_date)) <= 7)"""


def what(factor: float, rights: bool) -> str:
    return f"a rights issue, past prices divided by {factor:.4g}" if rights else describe(factor)


RIGHTS_RE = re.compile(r"([\d.]+) new shares? for each share held, at ([\d.]+) EGP")


def rights_terms(conn: sqlite3.Connection, symbol: str, ex_date: str) -> dict | None:
    """A rights issue's terms from its corporate action (data/news.py), and the rights' price as the exchange sets it
    before they trade: the ex-date's opening price less the subscription price, in whole piastres (KORA, 14 Oct 2026:
    2.53 − 0.205 → 2.32, Thndr's KORA_r1). None when the note doesn't say."""
    a = conn.execute("SELECT note FROM corp_actions WHERE symbol=? AND kind='rights' "
                     "AND ABS(julianday(effective) - julianday(?)) <= 7 ORDER BY effective DESC", (symbol, ex_date)).fetchone()
    m = a and RIGHTS_RE.search(a["note"] or "")
    op = conn.execute("SELECT open FROM prices WHERE symbol=? AND date>=? ORDER BY date LIMIT 1", (symbol, ex_date)).fetchone()
    if not m or not op:
        return None
    # ponytail: the price before the rights trade; once they do (KORA: 18–27 Oct) your broker shows theirs
    price = float(m[2])
    from .data.news import KNOWN_ACTIONS
    sched = next((k["schedule"] for k in KNOWN_ACTIONS if k["symbol"] == symbol and k.get("schedule")
                  and abs((date.fromisoformat(k["effective"]) - date.fromisoformat(ex_date)).days) <= 7), [])
    return {"ratio": float(m[1]), "price": price, "ref": max(0.0, math.floor((op[0] - price) * 100 + 1e-6) / 100),
            "note": a["note"], "schedule": sched}


def rights_holding(ev: dict | None, shares: int) -> dict | None:
    """The rights a position bought before its rights issue holds until you subscribe or sell them, as your broker
    lists them (Thndr: KORA_r1, cost 0). None for anything else (local/engine.js rightsHolding)."""
    t = ev and ev.get("terms")
    if not t:
        return None
    units = math.floor(shares * t["ratio"] + 1e-6)
    return {"symbol": f"{ev['symbol']}_r1", "units": units, "price": t["ref"], "value": units * t["ref"],
            "sub_price": t["price"], "note": t["note"], "ratio": t["ratio"],
            "schedule": t.get("schedule", [])}


def events(conn: sqlite3.Connection) -> list[dict]:
    """Every re-base of past prices, oldest first, as the website's browser reads them (local/engine.js pending)."""
    return [{"id": f"{r['symbol']}:{r['ex_date']}", "symbol": r["symbol"], "ex_date": r["ex_date"],
             "factor": r["factor"], "rights": bool(r["rights"]),
             "terms": rights_terms(conn, r["symbol"], r["ex_date"]) if r["rights"] else None}
            for r in conn.execute(f"SELECT e.symbol, e.ex_date, e.factor, {RIGHTS_SQL} AS rights "
                                  "FROM price_events e ORDER BY e.ex_date, e.id")]


def pending(conn: sqlite3.Connection, account: str = "real") -> dict[int, dict]:
    """Open positions bought before their stock was re-based and not updated yet: {trade_id: event}."""
    rows = conn.execute(
        f"""SELECT t.id AS trade_id, e.id AS event_id, e.symbol, e.ex_date, e.factor, t.shares, {RIGHTS_SQL} AS rights
           FROM trades t JOIN price_events e ON e.symbol = t.symbol
           WHERE t.account = ? AND t.status IN ('open', 'pending')
             AND COALESCE(t.entry_date, t.signal_date) < e.ex_date
             AND NOT EXISTS (SELECT 1 FROM position_adjustments a WHERE a.event_id = e.id AND a.trade_id = t.id)
           ORDER BY e.ex_date""",
        (account,),
    ).fetchall()
    out: dict[int, dict] = {}
    for r in rows:
        if r["trade_id"] not in out:  # oldest first; a second event shows after the first is handled
            rights = bool(r["rights"])
            out[r["trade_id"]] = {
                "event_id": r["event_id"], "symbol": r["symbol"], "ex_date": r["ex_date"], "factor": r["factor"],
                "rights": rights, "describe": what(r["factor"], rights), "shares_now": r["shares"],
                # how many new shares you subscribed to is yours to say
                "shares_expected": r["shares"] if rights else expected_shares(r["shares"], r["factor"]),
                "terms": rights_terms(conn, r["symbol"], r["ex_date"]) if rights else None,
            }
    return out


def new_average(avg: float, old: int, new: int, factor: float, rights: bool, paid: float = 0.0,
                got: float | None = None) -> float:
    """The average price on the new prices. Bonus shares or a split: the same cost over more shares. A rights issue:
    the new shares add what they cost (paid each); kept the old count (sold the rights): what you got for them comes
    off the cost (got; without it, as old records did, the cost ÷ factor)."""
    # ponytail: subscribing to only part of your rights counts the sold rights' cost in, so the average is a bit high
    if rights and new == old:
        return (avg * old - got) / old if got is not None else avg / factor
    return (avg * old + max(new - old, 0) * paid) / new


def adjust_problem(shares_now: int, ev: dict, new: int, paid: float = 0.0) -> str | None:
    """Why a new share count can't be right, or None (local/api.js adjust says the same)."""
    if ev.get("rights"):
        if new < shares_now:
            return (f"You held {shares_now:,} before the rights issue: enter those plus the new shares you subscribed "
                    "to. Sold some? Log that sale first.")
        if new > shares_now and not paid > 0:
            return "Enter what each new share cost you (the subscription price)."
        return None
    if not 0.75 * shares_now * ev["factor"] <= new <= 1.25 * shares_now * ev["factor"]:
        return (f"{new:,} shares is far from the expected {ev['shares_expected']:,}. Check the number at your broker. "
                "If your shares didn't change, choose 'My shares didn't change'.")
    return None


def apply(conn: sqlite3.Connection, trade_id: int, event_id: int, new_shares: int, paid: float = 0.0,
          got: float | None = None) -> dict:
    """Update a position to its new share count; its levels move with the prices (÷ the event's factor)."""
    t = conn.execute("SELECT * FROM trades WHERE id=? AND status IN ('open', 'pending')", (trade_id,)).fetchone()
    e = conn.execute(f"SELECT e.*, {RIGHTS_SQL} AS rights FROM price_events e WHERE id=?", (event_id,)).fetchone()
    if t is None or e is None or e["symbol"] != t["symbol"]:
        raise ValueError("This position or event no longer exists. Refresh the page.")
    new_shares = int(new_shares)
    if new_shares < 1:
        raise ValueError("Enter how many shares you hold now.")
    old, f, rights = int(t["shares"]), float(e["factor"]), bool(e["rights"])
    ratio = new_shares / old
    if not rights or new_shares > old:
        got = None
    avg = new_average(float(t["entry_price"]), old, new_shares, f, rights, paid, got) if t["entry_price"] else None
    conn.execute(
        """UPDATE trades SET shares=?, entry_price=?, initial_stop=initial_stop/?, stop=stop/?,
               target=target/?, highest_close=highest_close/?, entry_limit=entry_limit/? WHERE id=?""",
        (new_shares, avg, f, f, f, f, f, trade_id),
    )
    today = date.today().isoformat()
    if t["account"] == "real":
        note = (f"{describe(f)}: {old:,} → {new_shares:,} shares" if not rights
                else f"Rights issue: {new_shares - old:,} new shares at {paid:g}, {old:,} → {new_shares:,} shares"
                if new_shares > old else f"Rights issue: sold the rights for {got:,.0f} EGP, kept {old:,} shares"
                if got is not None else f"Rights issue: kept {old:,} shares, prices ÷ {f:.4g}")
        conn.execute(
            "INSERT INTO fills(trade_id, symbol, date, side, shares, price, fees, note) VALUES (?,?,?,?,?,?,?,?)",
            (trade_id, t["symbol"], e["ex_date"], "bonus", new_shares - old, paid if rights else 0.0, 0.0, note),
        )
    conn.execute(
        "INSERT OR REPLACE INTO position_adjustments(event_id, trade_id, action, ratio, date) VALUES (?,?,?,?,?)",
        (event_id, trade_id, "applied", ratio, today),
    )
    conn.commit()
    return {"symbol": t["symbol"], "old": old, "new": new_shares, "ratio": ratio, "avg": avg}


def ignore(conn: sqlite3.Connection, trade_id: int, event_id: int) -> None:
    """Your shares didn't change (for example, the price move wasn't a bonus issue): keep the position as it is."""
    conn.execute(
        "INSERT OR REPLACE INTO position_adjustments(event_id, trade_id, action, ratio, date) VALUES (?,?,?,?,?)",
        (event_id, trade_id, "ignored", None, date.today().isoformat()),
    )
    conn.commit()


def apply_paper(conn: sqlite3.Connection) -> int:
    """Update open and pending paper trades for every new bonus issue or split. Returns how many changed."""
    n = 0
    for trade_id, ev in pending(conn, "paper").items():
        apply(conn, trade_id, ev["event_id"], ev["shares_expected"])
        n += 1
    return n


# ------------------------------------------------------------------ cash dividends

def add_dividend(conn: sqlite3.Connection, trade_id: int, day: str, amount: float, note: str = "") -> dict:
    t = conn.execute("SELECT * FROM trades WHERE id=? AND account='real'", (trade_id,)).fetchone()
    if t is None:
        raise ValueError("Position not found.")
    if not amount > 0:
        raise ValueError("Enter the amount you received.")
    conn.execute(
        "INSERT INTO dividends(trade_id, symbol, date, shares, amount, note) VALUES (?,?,?,?,?,?)",
        (trade_id, t["symbol"], day, int(t["shares"]), float(amount), note),
    )
    conn.commit()
    return {"symbol": t["symbol"], "per_share": float(amount) / int(t["shares"])}


def delete_dividend(conn: sqlite3.Connection, dividend_id: int) -> sqlite3.Row | None:
    row = conn.execute("SELECT * FROM dividends WHERE id=?", (dividend_id,)).fetchone()
    if row is not None:
        conn.execute("DELETE FROM dividends WHERE id=?", (dividend_id,))
        conn.commit()
    return row


def dividends_by_trade(conn: sqlite3.Connection, account: str = "real") -> dict[int, float]:
    rows = conn.execute(
        """SELECT d.trade_id, SUM(d.amount) AS amount FROM dividends d JOIN trades t ON t.id = d.trade_id
           WHERE t.account=? GROUP BY d.trade_id""",
        (account,),
    ).fetchall()
    return {int(r["trade_id"]): float(r["amount"]) for r in rows}


def dividends_df(conn: sqlite3.Connection, trade_id: int) -> pd.DataFrame:
    return pd.read_sql_query("SELECT * FROM dividends WHERE trade_id=? ORDER BY date, id", conn, params=(trade_id,))


WEEK, QUARTER = 5, 60          # sessions after the ex-date
TRADING = 15                   # ~ the rights trade and the subscription closes (KORA: ex 14 Oct, first round ends 29 Oct)


def rights_history(conn: sqlite3.Connection, today: str | None = None) -> dict | None:
    """What EGX stocks did around their past rights issues (Mubasher's list), for the Dividends page: bought at the close
    before the ex-date (the last day that gets the rights), at the announcement, or on the ex-date itself. The prices are
    re-based, which counts each right at its worth, so these are the returns of a holder who subscribed (or sold the
    rights for what they were worth). A history TradingView didn't re-base (a fall of more than 20% that day) is left
    out, as is any without 60 sessions after it yet."""
    today = today or date.today().isoformat()
    ev = pd.read_sql_query("SELECT DISTINCT symbol, announced, effective FROM corp_actions WHERE kind = 'rights' "
                           "AND effective != '' AND effective < ?", conn, params=(today,))
    if ev.empty:
        return None
    syms = sorted(set(ev["symbol"]) | {"EGX30"})
    px = pd.read_sql_query(f"SELECT symbol, date, close FROM prices WHERE symbol IN ({','.join('?' * len(syms))})",
                           conn, params=syms)
    px["date"] = pd.to_datetime(px["date"])
    wide = px.pivot(index="date", columns="symbol", values="close")
    if "EGX30" not in wide:
        return None
    idx = wide.pop("EGX30").dropna()
    wide = wide.reindex(idx.index).ffill(limit=5)
    rows = []
    for e in ev.drop_duplicates(["symbol", "effective"]).itertuples():
        if e.symbol not in wide:
            continue
        c = wide[e.symbol]
        i = int(c.index.searchsorted(pd.Timestamp(e.effective)))
        if i < 1 or i + QUARTER >= len(c) or pd.isna(c.iloc[i - 1]) or pd.isna(c.iloc[i]) or pd.isna(c.iloc[i + QUARTER]):
            continue
        if c.iloc[i] / c.iloc[i - 1] < 0.8:
            continue
        ret = lambda a, b: c.iloc[b] / c.iloc[a] - 1                                      # noqa: E731
        beat = lambda a, b: ret(a, b) - (idx.iloc[b] / idx.iloc[a] - 1)                  # noqa: E731
        a = int(c.index.searchsorted(pd.Timestamp(e.announced))) if e.announced else -1
        ann = 0 <= a < i - 1 and pd.notna(c.iloc[a])
        rows.append({"year": c.index[i].year, "ex_day": ret(i - 1, i), "week": ret(i - 1, i + WEEK),
                     "quarter": ret(i - 1, i + QUARTER), "beat": beat(i - 1, i + QUARTER), "after": ret(i, i + WEEK),
                     "ann_beat": beat(a, i + QUARTER) if 0 <= a < i and pd.notna(c.iloc[a]) else None,
                     # the stages of a rights issue (rights page): announcement → last day with the rights, the
                     # rights' trading weeks, and after the subscription, while the new shares wait to be listed
                     "run_up": ret(a, i - 1) if ann else None, "run_beat": beat(a, i - 1) if ann else None,
                     "trading": ret(i, i + TRADING), "after_sub": ret(i + TRADING, i + QUARTER),
                     "sub_beat": beat(i + TRADING, i + QUARTER)})
    if len(rows) < 10:
        return None
    df = pd.DataFrame(rows)
    up = lambda s: float((s.dropna() > 0).mean())                                       # noqa: E731
    q = df["quarter"]
    return {
        "n": len(df), "since": int(df["year"].min()),
        "ex_day": {"median": float(df["ex_day"].median()), "up": up(df["ex_day"])},
        "week": {"median": float(df["week"].median()), "up": up(df["week"])},
        "quarter": {"median": float(q.median()), "up": up(q), "beat": up(df["beat"]),
                    "p10": float(q.quantile(0.1)), "p90": float(q.quantile(0.9))},
        "after": {"median": float(df["after"].median()), "up": up(df["after"])},
        "announced": {"beat": up(df["ann_beat"].astype(float))},
        "run_up": {"median": float(df["run_up"].astype(float).median()), "up": up(df["run_up"].astype(float)),
                   "beat": up(df["run_beat"].astype(float)), "n": int(df["run_up"].notna().sum())},
        "trading": {"median": float(df["trading"].median()), "up": up(df["trading"])},
        "after_sub": {"median": float(df["after_sub"].median()), "up": up(df["after_sub"]), "beat": up(df["sub_beat"])},
    }


# The rights check (rights_study): what past EGX rights issues did for a holder who bought on the last day with the
# rights and subscribed, held three months, against EGX30. Of everything measured (Oct 2026, 94 issues since 2016)
# only the share's move over its last 5 sessions with the rights told them apart: those that rose did worse (beat
# EGX30 about half the time, 1 in 10 lost a third) than those that fell or stayed flat (about 3 in 4); picked on the
# years before 2022, it held (more weakly) after. How busy the trading was, the move since the announcement, the
# stock's and the market's trend didn't separate them once the last week was known.
CHECK_SESSIONS = 5             # the last week with the rights
PATH_BEFORE = 15               # sessions shown before the last day with the rights
TRADE_SESSIONS = 10            # about how long rights trade, from the ex-date (KORA: 14 Oct → 27 Oct)
# What the share did after its last week with the rights (rights_study "stages"), by how it moved in that week
STAGE_GROUPS = (("Fell 10% or more", -9.0, -0.10), ("Fell up to 10%", -0.10, 0.0), ("Rose", 0.0, 9.0))


def rights_check(last5: float | None) -> str | None:
    """'better' (fell or stayed flat over its last week with the rights) or 'weaker' (rose), as past issues did."""
    return None if last5 is None else "weaker" if last5 > 0 else "better"


def rights_study(conn: sqlite3.Connection, today: str | None = None) -> dict | None:
    """Every past EGX rights issue (Mubasher's list) as its stock and EGX30 moved around it, on re-based prices (a
    holder who subscribed, or sold the rights for their worth), each with the rights check; what each thing measured
    said; and the rights issues coming up, with their check so far."""
    from . import holidays
    today = today or date.today().isoformat()
    ev = pd.read_sql_query("SELECT symbol, MIN(announced) AS announced, effective FROM corp_actions "
                           "WHERE kind = 'rights' AND effective != '' GROUP BY symbol, effective", conn)
    if ev.empty:
        return None
    syms = sorted(set(ev["symbol"]) | {"EGX30"})
    px = pd.read_sql_query(f"SELECT symbol, date, close, volume FROM prices WHERE symbol IN ({','.join('?' * len(syms))})",
                           conn, params=syms)
    px["date"] = pd.to_datetime(px["date"])
    cl = px.pivot(index="date", columns="symbol", values="close")
    vo = px.pivot(index="date", columns="symbol", values="volume")
    if "EGX30" not in cl:
        return None
    idx = cl.pop("EGX30").dropna()
    cl, vo = cl.reindex(idx.index).ffill(limit=5), vo.reindex(idx.index)
    past, coming = [], []
    for e in ev.itertuples():
        if e.symbol not in cl:
            continue
        s = cl[e.symbol]
        upcoming = e.effective > today
        i = len(s) if upcoming else int(s.index.searchsorted(pd.Timestamp(e.effective)))   # the ex-date
        last = i - 1                                                       # the last day with the rights (or today)
        if last < CHECK_SESSIONS + 20 or s.iloc[last - CHECK_SESSIONS - 20:last + 1].isna().any():
            continue
        last5 = float(s.iloc[last] / s.iloc[last - CHECK_SESSIONS] - 1)
        value = float((s * vo[e.symbol]).iloc[last - 20:last].median())   # EGP a session, the same re-based or not
        a = int(s.index.searchsorted(pd.Timestamp(e.announced))) if e.announced else -1
        row = {"symbol": e.symbol, "announced": e.announced or None, "ex": e.effective, "last5": last5, "value": value,
               "run_up": float(s.iloc[last] / s.iloc[a] - 1) if 0 <= a < last else None,
               "trend": float(s.iloc[last] / s.iloc[last - QUARTER] - 1) if last >= QUARTER and pd.notna(s.iloc[last - QUARTER]) else None,
               "market": float(idx.iloc[last] / idx.iloc[last - QUARTER] - 1) if last >= QUARTER else None}
        if upcoming:
            row["last_day"] = (pd.Timestamp(e.effective) - holidays.session_day()).date().isoformat()
            coming.append(row)
            continue
        if s.iloc[i] / s.iloc[last] < 0.8:
            continue                                                       # TradingView didn't re-base this one
        end = min(i + QUARTER, len(s) - 1)
        r = lambda n: float(s.iloc[i + n] / s.iloc[last] - 1) if i + n < len(s) and pd.notna(s.iloc[i + n]) else None  # noqa: E731
        x = lambda n: float(idx.iloc[i + n] / idx.iloc[last] - 1) if i + n < len(s) else None                     # noqa: E731
        k = slice(max(0, last - PATH_BEFORE), end + 1)
        tr = lambda a, b: float(s.iloc[i + b] / s.iloc[i + a] - 1) if i + b < len(s) and pd.notna(s.iloc[i + b]) else None  # noqa: E731
        row.update({"ex_day": r(0), "two_weeks": r(10), "quarter": r(QUARTER), "egx30_quarter": x(QUARTER),
                    # the share alone after the split: while its rights traded (about 10 sessions), then to 3 months
                    "trade_weeks": tr(0, TRADE_SESSIONS), "after_trade": tr(TRADE_SESSIONS, QUARTER),
                    "trade": [{"date": d.date().isoformat(), "close": round(float(v), 3)}
                              for d, v in s.iloc[i:i + TRADE_SESSIONS + 1].items() if pd.notna(v)],
                    "path": {"date": [d.date().isoformat() for d in s.index[k]],
                             "stock": [round(float(v / s.iloc[last] * 100), 1) for v in s.iloc[k]],
                             "egx30": [round(float(v / idx.iloc[last] * 100), 1) for v in idx.iloc[k]]},
                    "ann_entry": float(s.iloc[i + QUARTER] / s.iloc[a] - idx.iloc[i + QUARTER] / idx.iloc[a])
                    if 0 <= a < last and i + QUARTER < len(s) else None,
                    "ex_entry": float(s.iloc[i + QUARTER] / s.iloc[i] - idx.iloc[i + QUARTER] / idx.iloc[i])
                    if i + QUARTER < len(s) else None,
                    # the rights' own prices while they traded, kept since Oct 2026 (prices.update_rights)
                    "rights": [{"date": d, "close": c} for d, c in conn.execute(
                        "SELECT date, close FROM rights_prices WHERE symbol=? AND date>=? ORDER BY date",
                        (f"{e.symbol}_r1", e.effective))]})
        past.append(row)
    done = [p for p in past if p["quarter"] is not None]
    if len(done) < 20:
        return None
    df = pd.DataFrame(done)
    df["beat"] = df["quarter"] - df["egx30_quarter"]
    for p in past + coming:
        p["check"] = rights_check(p["last5"])
    df["check"] = [rights_check(a) for a in df["last5"]]
    group = lambda g: {"n": int(len(g)), "beat": float((g["beat"] > 0).mean()), "median": float(g["beat"].median()),  # noqa: E731
                       "p10": float(g["quarter"].quantile(0.1)), "up": float((g["quarter"] > 0).mean())} if len(g) else None

    def halves(col: str, label: str) -> dict:
        d = df[df[col].notna()]
        hi = d[col].astype(float) > d[col].astype(float).median()
        return {"label": label, "hi": float((d.loc[hi, "beat"] > 0).mean()), "lo": float((d.loc[~hi, "beat"] > 0).mean())}
    entries = [(label, df[col].dropna()) for label, col in (("On the announcement", "ann_entry"),
                                                              ("On the last day with the rights", "beat"),
                                                              ("On the ex-date (no rights)", "ex_entry"))]
    stat = lambda v: {"up": float((v > 0).mean()), "median": float(v.median())} if len(v) else None  # noqa: E731
    stages = []
    for label, lo, hi in STAGE_GROUPS:
        g = df[(df["last5"] > lo) & (df["last5"] <= hi)]
        stages.append({"label": label, "n": int(len(g)), "ex_day": stat(g["ex_day"].dropna()),
                       "trade_weeks": stat(g["trade_weeks"].dropna()), "after_trade": stat(g["after_trade"].dropna())})
    return {
        "n": len(df), "since": int(df["ex"].min()[:4]), "all": group(df), "stages": stages,
        "checks": {c: group(df[df["check"] == c]) for c in ("better", "weaker")},
        # what each thing measured on the last day said: how often the higher half and the lower half beat EGX30
        "factors": [halves("last5", "The last week's move"), halves("value", "How busy the trading was"),
                    halves("run_up", "The move since the announcement"), halves("trend", "The stock's last 3 months"),
                    halves("market", "EGX30's last 3 months")],
        "entries": [{"label": label, "beat": float((v > 0).mean()), "median": float(v.median()), "n": int(len(v))}
                    for label, v in entries],
        "past": sorted(past, key=lambda p: p["ex"], reverse=True), "coming": sorted(coming, key=lambda p: p["ex"]),
    }
