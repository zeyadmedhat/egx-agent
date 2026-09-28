from egx_agent import risk

BIG = 1e12  # liquidity/cash that never binds


def test_risk_rule_sets_size(cfg):
    r = risk.size_position(entry=10, stop=9, equity=100_000, cash=BIG, avg_value20=BIG, open_risk=0, cfg=cfg)
    assert r["shares"] == 1500              # 1.5% of 100k = 1,500 EGP / 1 EGP per share
    assert r["risk_egp"] == 1500


def test_max_position_cap(cfg):
    r = risk.size_position(entry=10, stop=9.5, equity=100_000, cash=BIG, avg_value20=BIG, open_risk=0, cfg=cfg)
    assert r["shares"] == 2500              # 3,000 by risk, capped at 25% of account = 25,000 EGP
    assert "25%" in r["size_note"]


def test_liquidity_cap(cfg):
    r = risk.size_position(entry=10, stop=9, equity=100_000, cash=BIG, avg_value20=200_000, open_risk=0, cfg=cfg)
    assert r["shares"] == 1000              # 5% of 200k daily value = 10k EGP


def test_total_risk_cap(cfg):
    r = risk.size_position(entry=10, stop=9, equity=100_000, cash=BIG, avg_value20=BIG, open_risk=5_000, cfg=cfg)
    assert r["shares"] == 1000              # only 6,000 - 5,000 = 1,000 EGP of risk left


def test_cash_cap(cfg):
    r = risk.size_position(entry=10, stop=9, equity=100_000, cash=5_000, avg_value20=BIG, open_risk=0, cfg=cfg)
    assert r["shares"] * 10 * (1 + cfg["fee_pct_per_side"] / 100) <= 5_000


def _cand(sym, sector="Banks"):
    return {"symbol": sym, "sector": sector, "close": 10.0, "stop": 9.0, "avg_value": BIG}


def test_allocate_respects_slots_sectors_and_holdings(cfg):
    held = [{"symbol": "AAA", "sector": "Banks", "entry_price": 10, "stop": 9, "shares": 100}]
    cands = [_cand("AAA"), _cand("BBB"), _cand("CCC"), _cand("DDD", "Real Estate")]
    out = {o["symbol"]: o for o in risk.allocate(cands, 100_000, 90_000, held, cfg, risk_off=False)}
    assert out["AAA"]["shares"] == 0 and "already" in out["AAA"]["size_note"]
    assert out["BBB"]["shares"] > 0
    assert out["CCC"]["shares"] == 0 and "Banks" in out["CCC"]["size_note"]   # max 2 per sector
    assert out["DDD"]["shares"] > 0


def test_allocate_halves_slots_in_risk_off(cfg):
    cands = [_cand(f"S{i}", f"sector{i}") for i in range(6)]
    out = risk.allocate(cands, 1e7, 1e7, [], cfg, risk_off=True)
    assert sum(o["shares"] > 0 for o in out) == cfg["max_positions"] // 2
