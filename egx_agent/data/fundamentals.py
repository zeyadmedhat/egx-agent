"""Each company's past results as they were known on each day: the prediction model's company numbers.

TradingView's screener (the same one request as data/dividends.py) has every EGX company's last 32 quarters and about
20 years of profit, sales, assets, debt, free cash flow and earnings and dividend per share (per share on today's
share count, like the prices). reports() turns them into the day each set of numbers became known, and features()
gives every stock on every day the numbers known by then: how cheap it is for its profit, sales and cash, its
dividend, how fast profit and sales grew, how profitable it is and how much debt it carries.

A quarter's numbers count as known Q_LAG days after it ends, the fiscal year's last quarter Y_LAG days: later than
most companies publish, on purpose. Walk-forward in 2026-10 (4 random seeds each, the rules plus the model's picks
replayed on 2016-07..2026-09): with these numbers the 10-session model's replay made 33.8% a year against 30.8%, its
worst drop -18.3% against -25.8%, better in both halves; counting quarters as known after 75/105 days instead did
worse in the second half. Only a few of the numbers (value and growth) did worse than all of them. The 20-session
model neither gains nor loses with them.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

import numpy as np
import pandas as pd

Q_LAG, Y_LAG = 120, 150
# ours → TradingView's column: lists, newest first (quarters _fq_h, years _fy_h)
QUARTERS = {"ni": "net_income_fq_h", "rev": "total_revenue_fq_h", "assets": "total_assets_fq_h",
            "debt": "total_debt_fq_h", "eps": "earnings_per_share_diluted_fq_h", "fcf": "free_cash_flow_fq_h"}
YEARS = {"ni": "net_income_fy_h", "rev": "total_revenue_fy_h", "assets": "total_assets_fy_h", "debt": "total_debt_fy_h",
         "eps": "earnings_per_share_diluted_fy_h", "dps": "dps_common_stock_prim_issue_fy_h", "year": "fiscal_period_fy_h"}
DATES = {"q_end": "fiscal_period_end_fq", "y_end": "fiscal_period_end_fy", "shares": "total_shares_outstanding"}
COLUMNS = list(DATES.values()) + list(QUARTERS.values()) + list(YEARS.values())
FEATURES = ["f_ey", "f_sy", "f_fcfy", "f_dy", "f_ni_growth", "f_rev_growth", "f_q_yoy", "f_margin", "f_roa",
            "f_debt_assets", "f_profit", "rank_ey", "rank_growth", "rank_quality"]


def save(conn: sqlite3.Connection, rows: list[dict], names: dict[str, str] | None = None) -> int:
    """Store each company's history from the screener's rows. names: TradingView's name → ours where they differ.
    Returns how many companies had one."""
    now = datetime.now().isoformat(timespec="seconds")
    n = 0
    for r in rows:
        data = {ours: r.get(col) for ours, col in DATES.items()}
        data["q"] = {ours: r.get(col) for ours, col in QUARTERS.items() if r.get(col)}
        data["y"] = {ours: r.get(col) for ours, col in YEARS.items() if r.get(col)}
        if not (data["q"].get("ni") or data["y"].get("ni")):
            continue
        conn.execute("INSERT OR REPLACE INTO fin_history(symbol, data, updated) VALUES (?,?,?)",
                     ((names or {}).get(r["name"], r["name"]), json.dumps(data), now))
        n += 1
    conn.commit()
    return n


def ready(conn: sqlite3.Connection) -> bool:
    return conn.execute("SELECT COUNT(*) FROM fin_history").fetchone()[0] > 0


def _day(ts) -> pd.Timestamp:
    return pd.Timestamp(datetime.fromtimestamp(ts, timezone.utc).date())


def _growth(now, before):
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.clip((now - before) / np.abs(before), -2, 5)


def reports(conn: sqlite3.Connection) -> pd.DataFrame:
    """One row per quarter and per year as it became known: symbol, known (date), kind (q|y), shares, ni and rev (the
    last 4 quarters, or the year) with the same a year before, eps, fcf, assets, debt, dps, q_yoy (the quarter's profit
    against the same quarter a year before)."""
    out = []
    for sym, raw in conn.execute("SELECT symbol, data FROM fin_history"):
        d = json.loads(raw)
        at = lambda a, i: a[i] if i < len(a) and a[i] is not None else np.nan          # noqa: E731
        base = {"symbol": sym, "shares": d.get("shares") or np.nan}
        y = d.get("y", {})
        if d.get("y_end"):
            end0 = _day(d["y_end"])
            ni, rev = y.get("ni", []), y.get("rev", [])
            for i in range(len(y.get("year") or ni)):
                out.append({**base, "known": end0 - pd.DateOffset(years=i) + pd.Timedelta(days=Y_LAG), "kind": "y",
                            "ni": at(ni, i), "ni_prev": at(ni, i + 1), "rev": at(rev, i), "rev_prev": at(rev, i + 1),
                            "eps": at(y.get("eps", []), i), "assets": at(y.get("assets", []), i),
                            "debt": at(y.get("debt", []), i), "dps": at(y.get("dps", []), i)})
        q = d.get("q", {})
        if d.get("q_end") and q.get("ni"):
            end0 = _day(d["q_end"])
            year_end = _day(d["y_end"]).strftime("%m") if d.get("y_end") else None
            ttm = lambda a, i: float(sum(a[i:i + 4])) if i + 4 <= len(a) and None not in a[i:i + 4] else np.nan  # noqa: E731
            ni, rev = q["ni"], q.get("rev", [])
            for i in range(len(ni)):
                end = end0 - pd.DateOffset(months=3 * i) + pd.offsets.MonthEnd(0)
                lag = Y_LAG if end.strftime("%m") == year_end else Q_LAG
                out.append({**base, "known": end + pd.Timedelta(days=lag), "kind": "q",
                            "ni": ttm(ni, i), "ni_prev": ttm(ni, i + 4), "rev": ttm(rev, i), "rev_prev": ttm(rev, i + 4),
                            "eps": ttm(q.get("eps", []), i), "fcf": ttm(q.get("fcf", []), i),
                            "assets": at(q.get("assets", []), i), "debt": at(q.get("debt", []), i),
                            "q_yoy": _growth(at(ni, i), at(ni, i + 4))})
    cols = ["symbol", "known", "kind", "shares", "ni", "ni_prev", "rev", "rev_prev", "eps", "fcf", "assets", "debt",
            "dps", "q_yoy"]
    rep = pd.DataFrame(out, columns=cols)
    rep["known"] = pd.to_datetime(rep["known"])
    return rep.sort_values("known").reset_index(drop=True)


def features(ds: pd.DataFrame, rep: pd.DataFrame | None) -> pd.DataFrame:
    """FEATURES for every row of the model's dataset (columns date, symbol, close, liquid), from the reports known
    by that date: the last 4 quarters when known, otherwise the last year. Empty (NaN) without reports."""
    f = pd.DataFrame(np.nan, index=ds.index, columns=FEATURES, dtype="float32")
    if rep is None or rep.empty or ds.empty:
        return f
    left = ds[["date", "symbol"]].reset_index().sort_values("date")
    left["date"] = pd.to_datetime(left["date"])

    def asof(kind):
        part = rep[rep["kind"] == kind].drop(columns="kind")
        return (pd.merge_asof(left, part, left_on="date", right_on="known", by="symbol", direction="backward")
                .set_index("index").reindex(ds.index))
    m, yr = asof("q"), asof("y")
    use_year = m["ni"].isna()
    for c in ("ni", "ni_prev", "rev", "rev_prev", "eps", "assets", "debt", "fcf", "q_yoy", "shares"):
        m.loc[use_year, c] = yr.loc[use_year, c]
    close = ds["close"].astype(float)
    mcap = close * m["shares"]
    with np.errstate(divide="ignore", invalid="ignore"):
        f["f_ey"] = (m["eps"] / close).clip(-1, 1)
        f["f_sy"] = (m["rev"] / mcap).clip(0, 20)
        f["f_fcfy"] = (m["fcf"] / mcap).clip(-1, 1)
        f["f_dy"] = (yr["dps"] / close).clip(0, 0.5)
        f["f_ni_growth"] = _growth(m["ni"], m["ni_prev"])
        f["f_rev_growth"] = _growth(m["rev"], m["rev_prev"])
        f["f_q_yoy"] = m["q_yoy"]
        f["f_margin"] = (m["ni"] / m["rev"]).where(m["rev"] > 0).clip(-2, 2)
        f["f_roa"] = (m["ni"] / m["assets"]).where(m["assets"] > 0).clip(-1, 1)
        f["f_debt_assets"] = (m["debt"] / m["assets"]).where(m["assets"] > 0).clip(0, 2)
    f["f_profit"] = (m["ni"] > 0).astype(float).where(m["ni"].notna())
    day, liquid = ds["date"], ds["liquid"].astype(bool)
    for src, dst in (("f_ey", "rank_ey"), ("f_ni_growth", "rank_growth"), ("f_roa", "rank_quality")):
        f[dst] = f[src].where(liquid).groupby(day).rank(pct=True)
    return f.replace([np.inf, -np.inf], np.nan).astype("float32")
