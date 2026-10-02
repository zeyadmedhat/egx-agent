"""Settings: defaults live here, user overrides live in config.yaml (edited from the Settings page)."""
from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config.yaml"
DB_PATH = ROOT / "data" / "egx.db"

SHARIAH_MODES = {
    "off": "No filter (show badges only)",
    "kashif": "Kashif compliant only",
    "egx33": "EGX33 members only",
    "either": "Kashif compliant OR EGX33 member",
    "both": "Kashif compliant AND EGX33 member",
}

DEFAULTS: dict = {
    # Money
    "capital": 100_000.0,            # real account starting capital (EGP)
    "paper_capital": 100_000.0,      # virtual account starting capital (EGP)
    "fee_pct_per_side": 0.25,        # commission + exchange/clearing fees + taxes, per buy or sell (%)
    # Risk & sizing
    "risk_per_trade_pct": 1.5,       # max loss per trade if the stop is hit (% of equity)
    "max_position_pct": 25.0,        # max size of one position (% of equity)
    "max_positions": 5,
    "max_open_risk_pct": 6.0,        # total risk of all open positions (% of equity)
    "max_per_sector": 2,
    "max_pct_of_adv": 5.0,           # position value <= this % of the stock's 20-day avg traded value
    # Universe filters
    "min_avg_value_egp": 5_000_000.0,  # 20-day average traded value
    "min_price": 1.0,
    "min_history_bars": 250,
    "shariah_filter": "off",
    "egx33_extra": [],               # EGX33 members missing from Kashif's index list, added by hand
    "symbol_aliases": {},            # extra Kashif code → TradingView code pairs (built-ins are in data/prices.py)
    # Entries
    "buy_score": 70,
    "watch_score": 60,
    "riskoff_score_bonus": 5,        # min score rises by this when EGX30 is below its 50-day EMA
    # Defaults chosen from the 2022–2026 backtest: breakouts carried the edge, pullback/MACD entries lost
    # money, and skipping new buys while EGX30 is below its 50-day EMA helped in both halves of the test.
    "riskoff_block_buys": True,      # no new buys while EGX30 is below its 50-day EMA
    "setups": ["breakout"],          # also available: "pullback", "macd"
    # The prediction model's 10-session rank decides which BUYs get money first, and its top picks that pass the
    # liquidity and uptrend checks are BUYs too (0 = none). Walk-forward 2016–2026 (its test years only, dividends
    # counted): rules alone 15.3% a year; in the model's order 19.8%; plus its top 3 26.9%, same worst drop (−20%),
    # better in both halves.
    "model_picks": 3,
    # Exits. "chart": the stop under the nearest solid support and the target under the first resistance paying at
    # least target_min_r × the risk (levels.py: swing points, Fibonacci, averages, pivots, volume). "atr": the stop
    # atr_stop_mult × the daily range below (within stop_min/max_pct) and the target target_r × the risk above.
    # Walk-forward 2016–2026: the BUY rules made 13.4% a year with chart levels vs 7.8% with ATR, worst drop −20% vs
    # −22%; with the model's picks 24.4% vs 27.7% (ATR's lead is all in 2021–26; 2016–21 13.4% vs 9.2%), drop −22% vs −26%.
    "levels_mode": "chart",
    "target_min_r": 1.5,
    "target_max_r": 3.0,
    "atr_stop_mult": 2.0,
    "stop_min_pct": 4.0,
    "stop_max_pct": 12.0,
    "target_r": 2.0,
    # Each evening an open position's stop rises to just under the nearest solid support below the close (never
    # down). Walk-forward 2016–2026 with the model's picks: 31.8% a year against 22.3%, worst drop −25.2% against
    # −22.7%; the rules alone 20.4% against 13.4% (engine.py). Also tried: skipping BUYs with no support within
    # stop_max_pct (28.1%, drop −14.8%, but worse in 2016–21) and stops up to 20% under support (18.0%): not used.
    "stop_follows_support": True,
    # Once a trade has gained 1× its risk, the stop goes no lower than the entry plus this % (enough to cover both
    # fees): a trade that comes back ends a small win instead of a small loss. Walk-forward 2016–2026 with the model's
    # picks (4 seeds): 48.0% of trades won against 44.9% with the stop at the entry (higher in every seed), the same
    # 33.7% a year, worst drop −17.9% against −18.3%. +0.5% (fees only) changed nothing, +0.75–1% and +2% made less.
    "breakeven_pct": 1.5,
    "review_day": 10,                # ~2 weeks
    "max_hold_days": 20,             # ~1 month (hard time stop)
    # Automation
    "auto_paper": True,
    "history_years": 5,
    # Telegram alerts (set up in Settings → Alerts)
    "telegram_token": "",
    "telegram_chat_id": "",
    "telegram_only_action": False,   # True: skip the message on days with nothing to do
}


# Each person's own numbers on the shared website. Everything else is the strategy, which the admin sets for all.
PERSONAL_KEYS = (
    "capital", "paper_capital", "fee_pct_per_side", "risk_per_trade_pct", "max_position_pct", "max_positions",
    "max_open_risk_pct", "max_per_sector", "max_pct_of_adv", "shariah_filter", "auto_paper",
    "telegram_chat_id", "telegram_only_action",
)


def with_personal(cfg: dict, personal: dict) -> dict:
    """The strategy settings plus one person's own numbers (defaults where they haven't set any)."""
    out = {**cfg, **{k: DEFAULTS[k] for k in PERSONAL_KEYS}}
    out.update({k: v for k, v in personal.items() if k in PERSONAL_KEYS})
    return out


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, encoding="utf-8") as f:
            user = yaml.safe_load(f) or {}
        cfg.update({k: v for k, v in user.items() if k in DEFAULTS})
    return cfg


def save_config(cfg: dict) -> None:
    clean = {k: cfg[k] for k in DEFAULTS if k in cfg}
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        yaml.safe_dump(clean, f, sort_keys=False, allow_unicode=True)
