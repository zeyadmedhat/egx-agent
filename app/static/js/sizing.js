// The size calculator's arithmetic: the BUY signals' own sizing rule (local/engine.js sizePosition, a port of
// egx_agent/risk.py) plus the portfolio limits the signals check. No browser APIs: tests/js/parity.mjs runs it in Node.
import { sizePosition, openRisk } from './local/engine.js';

const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
const num = v => Math.round(v).toLocaleString('en-US');
const ok = text => ({ level: 'ok', text });
const warn = text => ({ level: 'warn', text });
const bad = text => ({ level: 'bad', text });

// symbol/sector: the stock; entry/stop: prices; equity/cash/positions: your real account (positions as
// portfolio.positions_for_allocation gives them); avgValue: the stock's average daily traded value (20 days);
// cfg: your limits (views.CALC_KEYS); riskOff: EGX30 below its 50-day average; half: buy half the usual size.
export function planTrade({ symbol, sector, entry, stop, equity, cash, avgValue, positions = [], cfg, riskOff = false,
  half = false }) {
  const perShare = entry - stop;
  if (!(entry > 0) || !(stop > 0)) return { ok: false, error: 'Enter an entry price and a stop.' };
  if (!(perShare > 0)) return { ok: false, error: 'The stop must be below the entry price.' };
  if (!(equity > 0)) return { ok: false, error: 'Enter how much your account is worth.' };
  const fee = cfg.fee_pct_per_side / 100;
  const riskNow = openRisk(positions);
  const full = sizePosition(entry, stop, equity, cash, avgValue, riskNow, cfg);
  let shares = full.shares;
  let note = full.size_note;
  if (half && shares > 0) {
    shares = Math.floor(shares / 2);
    note = `half of ${num(full.shares)} shares (${note})`;
  }
  const amount = shares * entry;
  const buyFee = amount * fee;
  const target = entry + cfg.target_r * perShare;
  const lossAtStop = shares * perShare + buyFee + shares * stop * fee;
  const gainAtTarget = shares * (target - entry) - buyFee - shares * target * fee;
  const stopPct = perShare / entry;
  const maxPos = riskOff ? Math.max(1, Math.floor(cfg.max_positions / 2)) : cfg.max_positions;
  const inSector = positions.filter(p => p.sector === sector).length;
  const riskAfter = riskNow + shares * perShare;
  const lo = cfg.stop_min_pct, hi = cfg.stop_max_pct;
  const offMode = riskOff ? ' (half the usual number while EGX30 is below its 50-day average)' : '';
  const checks = [
    shares === 0 && bad(`Your rules give 0 shares here: ${full.size_note}.`),
    positions.some(p => p.symbol === symbol) && bad(`You already hold ${symbol}.`),
    positions.length >= maxPos
      ? bad(`Your portfolio is full: ${positions.length} of ${maxPos} positions${offMode}.`)
      : ok(`${positions.length} of ${maxPos} positions used${offMode}.`),
    inSector >= cfg.max_per_sector
      ? bad(`Already ${inSector} positions in ${sector} (your limit is ${cfg.max_per_sector}).`)
      : ok(`${inSector} of ${cfg.max_per_sector} positions in ${sector}.`),
    stopPct * 100 < lo || stopPct * 100 > hi
      ? warn(`The stop is ${pct(stopPct)} below the entry; the agent's usual stop is ${lo}–${hi}% below.`)
      : ok(`The stop is ${pct(stopPct)} below the entry (the usual is ${lo}–${hi}%).`),
    (riskAfter / equity) * 100 > cfg.max_open_risk_pct + 1e-9
      ? warn(`If every stop were hit you'd lose ${pct(riskAfter / equity)} of your account (your limit is ${cfg.max_open_risk_pct}%).`)
      : ok(`If every stop were hit, including this one, you'd lose ${pct(riskAfter / equity)} of your account (limit ${cfg.max_open_risk_pct}%).`),
  ].filter(Boolean);
  return {
    ok: true, shares, full_shares: full.shares, amount, buy_fee: buyFee, per_share: perShare, stop_pct: stopPct,
    target, target_pct: target / entry - 1, loss_at_stop: lossAtStop, loss_pct: lossAtStop / equity,
    gain_at_target: gainAtTarget, position_pct: amount / equity, cash_after: cash - amount - buyFee, size_note: note,
    max_positions: maxPos, checks,
  };
}
