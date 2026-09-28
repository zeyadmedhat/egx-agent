// My Portfolio's Health and Journal tabs: sums over your own trades. The Mac app (views.portfolio_history) and the
// site (local/api.js historyView) hand this the same raw history, so both show the same numbers.
// No browser APIs: tests/js/parity.mjs runs it in Node.

const DAY = 86400000;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const sum = xs => xs.reduce((s, x) => s + x, 0);
const byDateAsc = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

// Prices as they really traded that day. The stored history is re-based after bonus shares and splits (every price
// before the ex-date divided by the factor), while your fills are in the prices you paid.
function rawCloses(series, events, symbol) {
  const evs = events.filter(e => e.symbol === symbol);
  const out = new Map();
  (series.time || []).forEach((t, i) => {
    const c = series.close[i];
    if (c == null) return;
    out.set(t, evs.reduce((v, e) => (t < e.ex_date ? v * e.factor : v), c));
  });
  return out;
}

// Your account's value after every session since your first buy, next to EGX30 scaled to the same start.
// fills: {date, symbol, side: buy|sell|bonus, shares, price, fees}; dividends: {date, amount}; pending: bonus shares
// or splits you haven't entered yet, valued like My Portfolio does meanwhile (old shares × new price × the ratio).
export function equityCurve({ start, fills, dividends = [], series = {}, events = [], pending = [], index }) {
  if (!fills.length || !index || !index.time.length) return null;
  const sorted = [...fills].sort(byDateAsc);
  const sessions = index.time.map((t, i) => [t, index.close[i]]).filter(([t, c]) => t >= sorted[0].date && c != null);
  if (!sessions.length) return null;
  const closes = Object.fromEntries(Object.keys(series).map(s => [s, rawCloses(series[s], events, s)]));
  const divs = [...dividends].sort(byDateAsc);
  const shares = new Map();
  const last = new Map();
  let cash = start, fi = 0, di = 0;
  const time = [], value = [], bench = [];
  const base = sessions[0][1];
  for (const [t, idx] of sessions) {
    for (; fi < sorted.length && sorted[fi].date <= t; fi += 1) {
      const f = sorted[fi];
      const n = shares.get(f.symbol) || 0;
      if (f.side === 'buy') { shares.set(f.symbol, n + f.shares); cash -= f.shares * f.price + (f.fees || 0); }
      if (f.side === 'sell') { shares.set(f.symbol, n - f.shares); cash += f.shares * f.price - (f.fees || 0); }
      if (f.side === 'bonus') shares.set(f.symbol, n + f.shares);
      if (f.price > 0) last.set(f.symbol, f.price);
    }
    for (; di < divs.length && divs[di].date <= t; di += 1) cash += divs[di].amount;
    let held = 0;
    for (const [s, n] of shares) {
      if (!n) continue;
      const c = closes[s] && closes[s].get(t);
      if (c != null) last.set(s, c);
      const waiting = pending.filter(e => e.symbol === s && t >= e.ex_date).reduce((f, e) => f * e.factor, 1);
      held += n * (last.get(s) || 0) * waiting;
    }
    time.push(t);
    value.push(cash + held);
    bench.push(start * idx / base);
  }
  let peak = -Infinity, maxDd = 0;
  for (const v of value) { peak = Math.max(peak, v); maxDd = Math.min(maxDd, v / peak - 1); }
  return { time, value, index: bench, ret: value[value.length - 1] / start - 1,
    index_ret: bench[bench.length - 1] / start - 1, max_drawdown: maxDd };
}

// How closely your stocks move together: correlation of daily returns over the last `n` sessions (1 = in step).
export function correlations(series, symbols, n = 60) {
  const rets = {};
  for (const s of symbols) {
    const sr = series[s];
    if (!sr) continue;
    const m = new Map();
    for (let i = 1; i < sr.time.length; i += 1) {
      const a = sr.close[i - 1], b = sr.close[i];
      if (a && b) m.set(sr.time[i], b / a - 1);
    }
    rets[s] = m;
  }
  const have = symbols.filter(s => rets[s]);
  const pairs = [];
  for (let i = 0; i < have.length; i += 1) {
    for (let j = i + 1; j < have.length; j += 1) {
      const a = rets[have[i]], b = rets[have[j]];
      const common = [...a.keys()].filter(t => b.has(t)).sort().slice(-n);
      if (common.length < 20) continue;
      const x = common.map(t => a.get(t)), y = common.map(t => b.get(t));
      const mx = mean(x), my = mean(y);
      const cov = sum(x.map((v, k) => (v - mx) * (y[k] - my)));
      const sx = Math.sqrt(sum(x.map(v => (v - mx) ** 2))), sy = Math.sqrt(sum(y.map(v => (v - my) ** 2)));
      if (sx > 0 && sy > 0) pairs.push({ a: have[i], b: have[j], r: cov / (sx * sy), n: common.length });
    }
  }
  pairs.sort((p, q) => q.r - p.r);
  return { pairs, average: pairs.length ? mean(pairs.map(p => p.r)) : null };
}

// Where your money is: each sector's share of the account, and cash.
export function sectorMix(positions, cash) {
  const sectorOf = p => (p.info && p.info.sector) || 'Other';
  const by = new Map();
  for (const p of positions) by.set(sectorOf(p), (by.get(sectorOf(p)) || 0) + (p.value || 0));
  const rows = [...by].map(([sector, value]) => ({
    sector, value, symbols: positions.filter(p => sectorOf(p) === sector).map(p => p.symbol) }));
  if (cash > 0) rows.push({ sector: 'Cash', value: cash, symbols: [] });
  const total = sum(rows.map(r => r.value));
  return rows.map(r => ({ ...r, pct: total ? r.value / total : 0 })).sort((a, b) => b.value - a.value);
}

// What you'd lose from today's prices if every stop were hit (a stop above the price counts as zero).
export function stopRisk(positions, equity) {
  const rows = positions.filter(p => p.stop != null && p.last != null).map(p => ({
    symbol: p.symbol, loss: Math.max(0, (p.last - p.stop) * p.shares), pct: Math.max(0, p.last - p.stop) / p.last,
    locked: p.stop >= p.avg_price }));
  const total = sum(rows.map(r => r.loss));
  return { rows: rows.sort((a, b) => b.loss - a.loss), total, pct: equity ? total / equity : null };
}

// Egypt's yearly inflation (%) known on a day: the latest monthly figure dated on or before it.
function inflationOn(inflation, day) {
  let v = null;
  for (const r of inflation) { if (r.date <= day) v = r.value; else break; }
  return v;
}

function group(trades, key) {
  const by = new Map();
  for (const t of trades) by.set(key(t), [...(by.get(key(t)) || []), t]);
  return [...by].map(([label, ts]) => ({
    label, n: ts.length, win_rate: ts.filter(t => t.pnl > 0).length / ts.length, pnl: sum(ts.map(t => t.pnl)),
    real_pnl: sum(ts.map(t => t.real_pnl)), avg_return: mean(ts.map(t => t.return_pct)),
  }));
}

// Your closed trades: how they did, where the money came from, and what inflation took.
// closed: rows from My Portfolio; history.buys: past BUY signals {date, symbol, setup}; history.inflation: {date, value}.
export function journal(closed, { buys = [], inflation = [] } = {}) {
  const infl = [...inflation].sort(byDateAsc);
  const trades = closed.map(t => {
    const cost = t.entry_price * t.shares;
    const held = Math.max(1, days(t.entry_date, t.exit_date));
    const sig = buys.filter(b => b.symbol === t.symbol && b.date < t.entry_date && days(b.date, t.entry_date) <= 7)
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const yoy = inflationOn(infl, t.entry_date);
    const inflPct = yoy == null ? null : (1 + yoy / 100) ** (held / 365.25) - 1;
    const eaten = inflPct == null ? 0 : cost * inflPct;
    return { ...t, cost, days: held, source: sig ? (sig.setup || 'BUY signal') : 'Your own idea',
      inflation: inflPct, real_pnl: t.pnl - eaten, real_return: (t.pnl - eaten) / cost };
  });
  if (!trades.length) return { n: 0, trades };
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const lossSum = -sum(losses.map(t => t.pnl));
  return {
    n: trades.length, win_rate: wins.length / trades.length,
    avg_win: mean(wins.map(t => t.return_pct)), avg_loss: mean(losses.map(t => t.return_pct)),
    profit_factor: lossSum > 0 ? sum(wins.map(t => t.pnl)) / lossSum : null,
    pnl: sum(trades.map(t => t.pnl)), real_pnl: sum(trades.map(t => t.real_pnl)),
    per_trade: mean(trades.map(t => t.pnl)), avg_days: mean(trades.map(t => t.days)),
    has_inflation: trades.some(t => t.inflation != null),
    by_month: group(trades, t => t.exit_date.slice(0, 7)).sort((a, b) => (a.label < b.label ? 1 : -1)),
    by_source: group(trades, t => t.source).sort((a, b) => b.n - a.n),
    by_exit: group(trades, t => (t.exit_reason || 'Not given').replace(/ \(.*\)$/, '')).sort((a, b) => b.n - a.n),
    trades: trades.sort((a, b) => (a.exit_date < b.exit_date ? 1 : -1)),
  };
}
