"""What three AI forecasting models say about each stock's next 20 sessions (the stock page's "What the AI models
forecast"), and how their past forecasts did.

Each is a pretrained time-series model from a different lab, built a different way (an encoder, a decoder, an xLSTM).
Chronos-2 has been trained further on EGX's own history (EGX_DIR); the other two never saw EGX. They read the stock's
own past closes, and Chronos-2 EGX30's on the same days too, nothing else. They run once a day after the close,
in their own step of the website's run (they need torch, which nothing else does), and save each stock's 20-session
path (ai_paths, the latest only) and the price it forecast 1, 5 and 20 sessions ahead (ai_forecasts, every day). The
site grades those against what happened, next to "no change", the forecast that's hard to beat on stock prices.

    python -m egx_agent.ai_forecast due --db state/egx.db           # prints due=<the close to forecast from, or empty>
    python -m egx_agent.ai_forecast run --db state/egx.db

Kronos-small (Tsinghua, made for stock candles) was tried and left out (Oct 2026): it measures the last price against
the whole history's average and caps it, so a stock that rose 10× (HBCO) "fell" 42% the next session, and on a CPU it
took 19 minutes for what the other three do in under one.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

from . import db, scan
from .data.prices import INDEX_SYMBOL

HORIZON = 20
STEPS = (1, 5, 20)
CONTEXT = 512          # sessions each model reads, about two years
MIN_BARS = 60          # less history than this (about 3 months): no forecast. KORA, listed June 2026, has 80
VERSION = 4            # raise when which stocks or models change: the last close is forecast again at the next run
BACKFILL = 40          # sessions before the first forecast also forecast (from what was known then): a record at once
BACK_PER_RUN = 8       # ... this many a run, newest first (about a minute each on GitHub)
# How the models' middle did before going live (7 Oct 2026): every stock with 120+ sessions, on 34 closes 15 sessions
# apart from 21 Aug 2024 to 7 Sep 2026 (run() on each, then record() and grade()), all and by the card's confidence
# score (0–29, 30–59, 60+). The next session's direction was a little better than a coin flip, more so at high scores
# (mostly a fall forecast after a jump); 20 sessions ahead it wasn't; "no change" was the closer guess at every window.
# Since VERSION 4 (10 Oct 2026) Chronos-2 is EGX-trained (_chronos2), tested on 100 closes 5 sessions apart from 21 Aug
# 2024 to 7 Sep 2026 with a copy trained only on closes up to 31 Jul 2024: alone it was closer than "no change"
# 43.6/45.3/48.3% of the time against 43.0/44.5/45.0% untrained (it won on 73/86/95% of the dates), and the middle
# below against 46.0/45.7/44.2% before. A lighter training (LoRA) and reading 2048 sessions instead of 512 didn't help.
TESTED = {"dates": 100, "from": "2024-08-21", "to": "2026-09-07", "steps": {
    "1": {"all": {"n": 22238, "direction": 0.537, "closer": 0.464}, "0": {"n": 17129, "direction": 0.527, "closer": 0.46},
          "30": {"n": 2992, "direction": 0.561, "closer": 0.479}, "60": {"n": 2117, "direction": 0.584, "closer": 0.471}},
    "5": {"all": {"n": 22238, "direction": 0.51, "closer": 0.463}, "0": {"n": 17859, "direction": 0.506, "closer": 0.468},
          "30": {"n": 2646, "direction": 0.51, "closer": 0.446}, "60": {"n": 1733, "direction": 0.548, "closer": 0.441}},
    "20": {"all": {"n": 22238, "direction": 0.492, "closer": 0.45}, "0": {"n": 18490, "direction": 0.494, "closer": 0.463},
           "30": {"n": 2096, "direction": 0.464, "closer": 0.391}, "60": {"n": 1652, "direction": 0.502, "closer": 0.378}}}}
# Chronos-2 trained further on every EGX stock's closes (with EGX30) to 7 Oct 2026: 1,500 steps of full fine-tuning
# (Chronos2Pipeline.fit, learning rate 1e-6, 64 series a batch, 20 sessions ahead), about 35 minutes on a Mac. 478 MB,
# so it's a release file (EGX_RELEASE), not in the code; site.yml downloads it here.
EGX_DIR = Path(os.environ.get("EGX_CHRONOS2", "_models/chronos2-egx"))
EGX_RELEASE = "chronos2-egx-1"
MODELS = {             # key → (name, lab)
    "chronos2_egx": ("Chronos-2", "Amazon, trained on EGX"),
    "timesfm": ("TimesFM 2.5", "Google"),
    "tirex": ("TiRex", "NXAI"),
}


def due(conn: sqlite3.Connection) -> str | None:
    """The close to forecast from, if it's final (not one taken during the session) and not forecast yet (or forecast
    by an older VERSION)."""
    made = db.get_meta(conn, "scan_data_date")
    if not made or not scan.scan_is_final(conn):
        return None
    done = conn.execute("SELECT 1 FROM ai_forecasts WHERE made=? LIMIT 1", (made,)).fetchone()
    return None if done and db.get_meta(conn, "ai_version") == str(VERSION) else made


def inputs(conn: sqlite3.Connection, made: str) -> dict[str, pd.DataFrame]:
    """Each stock with enough history that traded in the last two weeks: its last CONTEXT daily bars up to `made` (one
    that didn't trade that day starts from its last close)."""
    since = (date.fromisoformat(made) - timedelta(days=int(CONTEXT * 7 / 5) + 60)).isoformat()
    recent = (date.fromisoformat(made) - timedelta(days=14)).isoformat()
    rows = pd.read_sql_query("SELECT symbol, date, open, high, low, close, volume FROM prices "
                             "WHERE date > ? AND date <= ? AND symbol != ? AND close > 0 ORDER BY symbol, date",
                             conn, params=(since, made, INDEX_SYMBOL))
    egx30 = pd.read_sql_query("SELECT date, close FROM prices WHERE symbol=? AND date > ? AND date <= ?", conn,
                              params=(INDEX_SYMBOL, since, made)).set_index("date")["close"]
    out = {}
    for sym, g in rows.groupby("symbol"):
        if g["date"].iloc[-1] >= recent and len(g) >= MIN_BARS:
            g = g.tail(CONTEXT).reset_index(drop=True)
            out[sym] = g.assign(open=g["open"].fillna(g["close"]), high=g["high"].fillna(g["close"]),
                                low=g["low"].fillna(g["close"]), volume=g["volume"].fillna(0),
                                egx30=egx30.reindex(g["date"]).ffill().bfill().to_numpy())
    return out


# ------------------------------------------------------------------ the models (each: data → {symbol: 20 prices})
def _chronos2(data: dict[str, pd.DataFrame], made: str) -> dict[str, np.ndarray]:
    """Chronos-2 also reads EGX30's closes on the same days (past covariates; it can't see the index's future). Tested in
    Oct 2026 on the 34 closes of TESTED: 20 sessions ahead it was closer than on the stock's closes alone 56.9% of the
    time (on 85% of the dates), and the middle with it beat the middle without it at 1, 5 and 20 sessions (51%, 52%,
    57%). Also tried and left out: the market mood gauge, foreign and Arab net buying, and the stock's open, high, low
    and volume (noise-sized gains)."""
    from chronos import Chronos2Pipeline

    if not (EGX_DIR / "model.safetensors").exists():   # never the untrained one under the EGX-trained name
        raise FileNotFoundError(f"the EGX-trained Chronos-2 isn't in {EGX_DIR} (site.yml downloads it)")
    pipe = Chronos2Pipeline.from_pretrained(str(EGX_DIR), device_map="cpu")
    syms = list(data)
    batch = []
    for s in syms:
        x = {"target": data[s]["close"].to_numpy(float)}
        if "egx30" in data[s] and data[s]["egx30"].notna().all():
            x["past_covariates"] = {"egx30": data[s]["egx30"].to_numpy(float)}
        batch.append(x)
    q, _ = pipe.predict_quantiles(batch, prediction_length=HORIZON, quantile_levels=[0.5])
    return {s: q[i][0, :, 0].numpy() for i, s in enumerate(syms)}


def _timesfm(data: dict[str, pd.DataFrame], made: str) -> dict[str, np.ndarray]:
    import timesfm

    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch")
    model.compile(timesfm.ForecastConfig(max_context=CONTEXT, max_horizon=128, normalize_inputs=True,
                                         use_continuous_quantile_head=True, force_flip_invariance=True,
                                         infer_is_positive=True, fix_quantile_crossing=True, per_core_batch_size=64))
    syms = list(data)
    point, _ = model.forecast(horizon=HORIZON, inputs=[data[s]["close"].to_numpy(float) for s in syms])
    return {s: np.asarray(point[i]) for i, s in enumerate(syms)}


def _tirex(data: dict[str, pd.DataFrame], made: str) -> dict[str, np.ndarray]:
    import torch
    from tirex import load_model

    model = load_model("NX-AI/TiRex", device="cpu")
    syms = list(data)
    q, _ = model.forecast(context=[torch.tensor(data[s]["close"].to_numpy(np.float32)) for s in syms],
                          prediction_length=HORIZON)
    return {s: q[i, :, 4].numpy() for i, s in enumerate(syms)}          # the 9 quantiles' middle one


RUNNERS: dict[str, Callable[[dict, str], dict]] = {"chronos2_egx": _chronos2, "timesfm": _timesfm, "tirex": _tirex}


def _r(v: float) -> float:
    return float(f"{v:.5g}")


def save(conn: sqlite3.Connection, made: str, model: str, paths: dict[str, np.ndarray]) -> int:
    good = {s: p for s, p in paths.items() if len(p) == HORIZON and np.all(np.isfinite(p)) and np.all(p > 0)}
    conn.executemany("INSERT OR REPLACE INTO ai_forecasts VALUES (?, ?, ?, ?, ?, ?)",
                     [(made, s, model, *(_r(p[k - 1]) for k in STEPS)) for s, p in good.items()])
    conn.executemany("INSERT INTO ai_paths VALUES (?, ?, ?, ?) ON CONFLICT(symbol, model) DO UPDATE SET "
                     "made=excluded.made, path=excluded.path WHERE excluded.made >= ai_paths.made",   # not a backfill's
                     [(s, model, made, json.dumps([_r(v) for v in p])) for s, p in good.items()])
    conn.commit()
    return len(good)


def run(conn: sqlite3.Connection, made: str, models: list[str] | None = None) -> dict[str, str]:
    """Every model's forecast for every stock from the `made` close. One model failing doesn't stop the others."""
    data = inputs(conn, made)
    report = {}
    for key in models or list(RUNNERS):
        t0 = time.time()
        try:
            n = save(conn, made, key, RUNNERS[key](data, made))
            report[key] = f"{n} stocks in {time.time() - t0:.0f}s"
        except Exception as exc:  # noqa: BLE001 - the others still run
            report[key] = f"failed ({type(exc).__name__}: {str(exc)[:120]})"
    db.set_meta(conn, "ai_version", str(VERSION))
    return report


def backfill_days(conn: sqlite3.Connection, made: str) -> list[str]:
    """Sessions before `made` within BACKFILL without forecasts, newest first, BACK_PER_RUN of them."""
    days = [r[0] for r in conn.execute("SELECT date FROM prices WHERE symbol=? AND date<? ORDER BY date DESC LIMIT ?",
                                       (INDEX_SYMBOL, made, BACKFILL))]
    done = {r[0] for r in conn.execute("SELECT DISTINCT made FROM ai_forecasts")}
    return [d for d in days if d not in done][:BACK_PER_RUN]


# ------------------------------------------------------------------ how they did (no torch needed)
def record(conn: sqlite3.Connection) -> pd.DataFrame:
    """Every finished forecast, one row per (made, symbol, model, step), with the close it started from (start), the
    session it was about (target), the forecast and the close that session (actual). model 'middle' is the models'
    median."""
    fc = pd.read_sql_query("SELECT * FROM ai_forecasts", conn)
    cols = ["made", "symbol", "model", "step", "start", "target", "forecast", "actual"]
    if fc.empty:
        return pd.DataFrame(columns=cols)
    days = [r[0] for r in conn.execute("SELECT date FROM prices WHERE symbol=? AND date>=? ORDER BY date",
                                       (INDEX_SYMBOL, fc["made"].min()))]
    pos = {d: i for i, d in enumerate(days)}
    syms = list(fc["symbol"].unique())
    closes = pd.read_sql_query(f"SELECT symbol, date, close FROM prices WHERE date>=? AND symbol IN "
                               f"({','.join('?' * len(syms))})", conn, params=(fc["made"].min(), *syms))
    wide = closes.pivot(index="date", columns="symbol", values="close").reindex(days).ffill()
    long = fc.melt(id_vars=["made", "symbol", "model"], value_vars=["p1", "p5", "p20"], var_name="step",
                   value_name="forecast").dropna(subset=["forecast"])
    long["step"] = long["step"].str[1:].astype(int)
    mid = long.groupby(["made", "symbol", "step"], as_index=False)["forecast"].median().assign(model="middle")
    long = pd.concat([long, mid], ignore_index=True)
    j = long["made"].map(pos) + long["step"]
    long = long[j < len(days)].copy()             # also drops a made the index has no close for (NaN)
    long["target"] = np.array(days, dtype=object)[j[long.index].astype(int)]
    stack = wide.stack()
    at = lambda day, sym: stack.reindex(pd.MultiIndex.from_arrays([day, sym])).to_numpy()   # noqa: E731
    long["start"], long["actual"] = at(long["made"], long["symbol"]), at(long["target"], long["symbol"])
    return long.dropna(subset=["start", "actual"])[cols].reset_index(drop=True)


def grade(rows: pd.DataFrame) -> dict | None:
    """How a set of finished forecasts did: how many, how often the direction was right (when both the forecast and
    the price moved; forecasts are saved to 5 digits, so less than 0.01% isn't a move), how often the forecast was
    closer to the close than "no change" was, and the middle error of each."""
    if rows.empty:
        return None
    fc, act = rows["forecast"] / rows["start"] - 1, rows["actual"] / rows["start"] - 1
    moved = (fc.abs() > 1e-4) & (act.abs() > 1e-9)
    return {"n": int(len(rows)),
            "direction": float((np.sign(fc[moved]) == np.sign(act[moved])).mean()) if moved.any() else None,
            "closer": float(((act.abs() - (fc - act).abs()) > 1e-4).mean()),
            "error": float((rows["forecast"] / rows["actual"] - 1).abs().median()),
            "naive_error": float((rows["start"] / rows["actual"] - 1).abs().median())}


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="The AI models' forecasts")
    p.add_argument("what", choices=["due", "run"])
    p.add_argument("--db", required=True)
    p.add_argument("--models", help="comma-separated, default all")
    a = p.parse_args(argv)
    if not Path(a.db).exists():                  # the first run: nothing to forecast from yet
        print("due=" if a.what == "due" else "No data yet.")
        return
    conn = db.connect(a.db)
    made = due(conn)
    if a.what == "due":
        print(f"due={made or ''}")
        return
    if not made:
        print("Nothing to forecast: the last close's forecasts are saved, or it isn't final yet.")
        return
    models = a.models.split(",") if a.models else None
    for day in [made, *backfill_days(conn, made)]:
        for key, res in run(conn, day, models).items():
            print(f"{day} {MODELS[key][0]}: {res}")


if __name__ == "__main__":
    main()
