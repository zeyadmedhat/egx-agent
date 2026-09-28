// The agent's money rules for the GitHub Pages site, where your portfolio lives in your browser.
// Line-for-line ports of egx_agent/engine.py, risk.py, portfolio.py and corporate.py, so the site and the Mac
// give the same answers (tests/test_static_site.py runs both on the same cases). No browser APIs in here: the
// tests run this file in Node.
//
// A "book" is one person's data, shaped like the Mac's database tables:
//   { trades: [...], fills: [...], dividends: [...], adjustments: [...], next_id: 1 }
// Bars are { date: 'YYYY-MM-DD', open, high, low, close, atr14, ema50 } (missing numbers are NaN).

// ------------------------------------------------------------------ small helpers
export const f2 = v => Number(v).toFixed(2);
export const g = v => String(+Number(v).toPrecision(6));                       // Python's {x:g}
export const int = v => Math.round(v).toLocaleString('en-US');               // Python's {n:,}
export const num = v => (v === null || v === undefined ? NaN : Number(v));
const sum = xs => xs.reduce((a, b) => a + b, 0);
const byId = (a, b) => a.id - b.id;

// ------------------------------------------------------------------ dates (EGX trades Sunday–Thursday)
const DAY = 86400000;
const iso = d => d.toISOString().slice(0, 10);
const weekday = day => new Date(day + 'T00:00:00Z').getUTCDay();   // 0 = Sunday … 6 = Saturday
const trading = day => weekday(day) <= 4;

export function addDays(day, n) {
  return iso(new Date(Date.parse(day + 'T00:00:00Z') + n * DAY));
}

// Date n EGX sessions after `day` (public holidays not included), like views.sessions_after.
export function sessionsAfter(day, n) {
  let d = day;
  for (let k = 0; k < n;) {
    d = addDays(d, 1);
    if (trading(d)) k += 1;
  }
  return d;
}

// Most recent EGX session whose closing data should be available by now (scan.expected_session_date).
export function expectedSessionDate(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now).map(x => [x.type, x.value]));
  let d = `${p.year}-${p.month}-${p.day}`;
  const minutes = +p.hour * 60 + +p.minute;
  if (trading(d) && minutes >= 15 * 60 + 30) return d;
  d = addDays(d, -1);
  while (!trading(d)) d = addDays(d, -1);
  return d;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function niceDate(day, withWeekday = false) {
  const d = new Date(day + 'T00:00:00Z');
  const s = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return withWeekday ? `${WEEKDAYS[d.getUTCDay()]} ${s}` : s;
}

// A price the way the dashboard shows it: 3 decimals under 10 EGP, else 2 (views.px).
export function px(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  const d = Math.abs(v) < 10 ? 3 : 2;
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

// ------------------------------------------------------------------ strategy.py / engine.py
export function initialStop(close, atr, cfg) {
  const pct = Math.min(Math.max(cfg.atr_stop_mult * atr / close, cfg.stop_min_pct / 100), cfg.stop_max_pct / 100);
  return close * (1 - pct);
}

export function position(o) {
  return {
    symbol: o.symbol, entry_date: o.entry_date, entry_price: +o.entry_price, shares: Math.trunc(o.shares),
    initial_stop: +o.initial_stop, stop: +o.stop, target: +o.target, highest_close: +o.highest_close,
    days_held: o.days_held || 0, exit_next_open: o.exit_next_open || null, sector: o.sector || '',
  };
}

function stopLabel(p) {
  if (p.stop > p.entry_price * 1.0005) return 'Trailing stop';
  if (p.stop >= p.entry_price * 0.9995) return 'Breakeven stop';
  return 'Stop-loss';
}

// Fill a next-day buy order at the open, unless the open already broke the plan.
export function fillOrder(order, bar) {
  const o = bar.open;
  if (o <= order.stop) return [null, `cancelled: opened at ${f2(o)}, below the stop ${f2(order.stop)}`];
  if (o > order.entry_limit) {
    return [null, `cancelled: gapped up to ${f2(o)}, above the entry limit ${f2(order.entry_limit)} (not chasing)`];
  }
  return [position({
    symbol: order.symbol, entry_date: bar.date, entry_price: o, shares: order.shares, initial_stop: order.stop,
    stop: order.stop, target: order.target, highest_close: o, sector: order.sector || '',
  }), 'filled'];
}

// Advance a position through one daily bar. Returns [exit price, reason] when it exits.
export function processBar(p, bar, cfg) {
  if (p.exit_next_open) return [bar.open, p.exit_next_open];
  p.days_held += 1;
  const { open: o, high: h, low: l } = bar;
  if (o <= p.stop) return [o, `${stopLabel(p)} (gap down)`];
  if (l <= p.stop) return [p.stop, stopLabel(p)];
  if (o >= p.target) return [o, 'Target reached (gap up)'];
  if (h >= p.target) return [p.target, 'Target reached'];
  updateAfterClose(p, bar, cfg);
  return null;
}

// End-of-day bookkeeping: raise the stop and flag close-based exits for the next open.
export function updateAfterClose(p, bar, cfg) {
  const c = bar.close;
  if (c > p.highest_close) p.highest_close = c;          // Python's max() skips a NaN close the same way
  const r = p.entry_price - p.initial_stop;
  if (p.highest_close >= p.entry_price + r) {
    const trail = p.highest_close - cfg.atr_stop_mult * bar.atr14;
    p.stop = Math.max(p.stop, p.entry_price);
    if (trail > p.stop) p.stop = trail;                    // a NaN trail (no ATR yet) is ignored, as in Python
  }
  if (c < bar.ema50) p.exit_next_open = 'Trend break (closed below 50-day average)';
  else if (p.days_held >= cfg.max_hold_days) p.exit_next_open = `Max hold reached (${cfg.max_hold_days} trading days)`;
}

// Status for a real trade: replay every bar after the entry day and report what the rules say now.
export function replayStatus(p, bars, cfg) {
  const entry = p.entry_date;
  const entryBar = bars.find(b => b.date === entry);
  p.days_held = 1;
  if (entryBar) updateAfterClose(p, entryBar, cfg);
  let prevStop = p.stop;
  for (const bar of bars) {
    if (bar.date <= entry) continue;
    prevStop = p.stop;
    if (p.exit_next_open) {
      return { status: 'EXIT', reason: `${p.exit_next_open}: sell at the open (flagged before ${bar.date})`,
        stop: p.stop, days_held: p.days_held, event_date: bar.date };
    }
    const res = processBar(p, bar, cfg);
    if (res) {
      return { status: 'EXIT', reason: `${res[1]} on ${bar.date} at ${f2(res[0])}`, stop: p.stop,
        days_held: p.days_held, event_date: bar.date };
    }
  }
  const last = bars.length ? bars[bars.length - 1].date : 'None';
  const r = p.entry_price - p.initial_stop;
  if (p.exit_next_open) {
    return { status: 'EXIT', reason: `${p.exit_next_open}: sell at the next open`, stop: p.stop,
      days_held: p.days_held, event_date: last };
  }
  if (p.days_held >= cfg.review_day && p.highest_close < p.entry_price + r) {
    return { status: 'REVIEW',
      reason: `Day ${p.days_held}: no +1R move yet (needs ${f2(p.entry_price + r)}). Consider exiting.`,
      stop: p.stop, days_held: p.days_held, event_date: last };
  }
  if (p.stop > prevStop + 1e-9) {
    return { status: 'TIGHTEN STOP', reason: `Raise your stop to ${f2(p.stop)}`, stop: p.stop, prev_stop: prevStop,
      days_held: p.days_held, event_date: last };
  }
  return { status: 'HOLD', reason: `Stop ${f2(p.stop)}, target ${f2(p.target)}`, stop: p.stop,
    days_held: p.days_held, event_date: last };
}

// What the exit rules say about one open real trade today (portfolio.real_status).
export function realStatus(t, bars, cfg) {
  if (!bars || !bars.length) {
    return { status: 'NO DATA', reason: 'No price data for this symbol', stop: t.stop, days_held: 0, last_close: null };
  }
  const p = position({ ...t, stop: t.initial_stop, highest_close: t.entry_price, days_held: 0, exit_next_open: null });
  const st = replayStatus(p, bars, cfg);
  st.last_close = bars[bars.length - 1].close;
  return st;
}

// ------------------------------------------------------------------ risk.py
export function sizePosition(entry, stop, equity, cash, avgValue20, openRisk, cfg) {
  const perShare = entry - stop;
  if (!(perShare > 0) || !(entry > 0)) return { shares: 0, amount: 0, risk_egp: 0, size_note: 'invalid stop' };
  let budget = equity * cfg.risk_per_trade_pct / 100;
  let note = `${g(cfg.risk_per_trade_pct)}% risk rule`;
  const heatLeft = equity * cfg.max_open_risk_pct / 100 - openRisk;
  if (heatLeft < budget) {
    budget = Math.max(0, heatLeft);
    note = `reduced: total open risk limit (${g(cfg.max_open_risk_pct)}%)`;
  }
  let shares = Math.floor(budget / perShare);
  const fee = cfg.fee_pct_per_side / 100;
  const caps = [
    [`max ${g(cfg.max_position_pct)}% of account per stock`, equity * cfg.max_position_pct / 100 / entry],
    [`liquidity: ${g(cfg.max_pct_of_adv)}% of daily traded value`, avgValue20 * cfg.max_pct_of_adv / 100 / entry],
    ['available cash', cash / (entry * (1 + fee))],
  ];
  for (const [name, cap] of caps) {
    if (Math.floor(cap) < shares) { shares = Math.floor(cap); note = `capped by ${name}`; }
  }
  shares = Math.max(0, Math.trunc(shares));
  return { shares, amount: shares * entry, risk_egp: shares * perShare, size_note: note };
}

// Money lost if every open position hit its stop now (locked-in stops count as zero).
export const openRisk = positions => sum(positions.map(p => Math.max(0, p.entry_price - p.stop) * p.shares));

// Size candidates best-score-first while respecting slots, sector limits, total risk and cash.
export function allocate(candidates, equity, cash, positions, cfg, riskOff) {
  const maxPos = riskOff ? Math.max(1, Math.floor(cfg.max_positions / 2)) : cfg.max_positions;
  let slots = maxPos - positions.length;
  const sectors = new Map();
  const sectorKey = s => (s === undefined ? null : s);
  for (const p of positions) sectors.set(sectorKey(p.sector), (sectors.get(sectorKey(p.sector)) || 0) + 1);
  const held = new Set(positions.map(p => p.symbol));
  let riskNow = openRisk(positions);
  const fee = cfg.fee_pct_per_side / 100;
  const none = { shares: 0, amount: 0, risk_egp: 0 };
  return candidates.map(c => {
    const res = { ...c };
    const sector = sectorKey(c.sector);
    if (held.has(c.symbol)) Object.assign(res, none, { size_note: 'already in your portfolio' });
    else if (slots <= 0) {
      Object.assign(res, none, { size_note: `portfolio full (${maxPos} positions${riskOff ? ' in risk-off mode' : ''})` });
    } else if ((sectors.get(sector) || 0) >= cfg.max_per_sector) {
      Object.assign(res, none, { size_note: `already ${cfg.max_per_sector} positions in ${c.sector}` });
    } else {
      Object.assign(res, sizePosition(c.close, c.stop, equity, cash, c.avg_value, riskNow, cfg));
      if (res.shares > 0) {
        slots -= 1;
        sectors.set(sector, (sectors.get(sector) || 0) + 1);
        cash -= res.amount * (1 + fee);
        riskNow += res.risk_egp;
      }
    }
    return res;
  });
}

// data/shariah.py passes_filter: the Shariah setting decides which stocks can get BUY signals.
export function passesFilter(stock, mode) {
  const kashif = (stock || {}).kashif_status === 'compliant';
  const egx33 = !!(stock || {}).egx33;
  return { off: true, kashif, egx33, either: kashif || egx33, both: kashif && egx33 }[mode] ?? true;
}

// ------------------------------------------------------------------ corporate.py: bonus shares and splits
function limitDenominator(x, maxDen) {
  let best = [Math.round(x), 1];
  for (let den = 2; den <= maxDen; den++) {
    const n = Math.round(x * den);
    if (Math.abs(n / den - x) < Math.abs(best[0] / best[1] - x)) best = [n, den];
  }
  return best;
}

// Plain words for a price ratio: 1.25 → '1 free share for every 4 you hold'.
export function describe(factor) {
  if (factor >= 1) {
    if (factor >= 2 && Math.abs(factor - Math.round(factor)) < 1e-6) {
      return `${Math.round(factor)} shares for each 1 you held (split or bonus)`;
    }
    const [k, n] = limitDenominator(factor - 1, 20);
    if (k && Math.abs(k / n - (factor - 1)) < 1e-6) return `${k} free share${k > 1 ? 's' : ''} for every ${n} you hold`;
    return `prices divided by ${g(+factor.toPrecision(4))}`;
  }
  const inv = 1 / factor;
  if (Math.abs(inv - Math.round(inv)) < 1e-6) return `every ${Math.round(inv)} shares combined into 1`;
  return `prices multiplied by ${g(+inv.toPrecision(4))}`;
}

export const expectedShares = (shares, factor) => Math.max(1, Math.floor(shares * factor + 1e-6));

// Open positions bought before their stock was re-based and not updated yet: {trade id: event}.
// events: [{ id, symbol, ex_date, factor }], oldest first.
export function pending(book, events, account = 'real') {
  const done = new Set(book.adjustments.map(a => `${a.event_id}|${a.trade_id}`));
  const out = {};
  const evs = [...events].sort((a, b) => (a.ex_date < b.ex_date ? -1 : a.ex_date > b.ex_date ? 1 : 0));
  for (const e of evs) {
    for (const t of book.trades) {
      if (t.account !== account || !['open', 'pending'].includes(t.status) || t.symbol !== e.symbol) continue;
      if (!((t.entry_date || t.signal_date) < e.ex_date) || done.has(`${e.id}|${t.id}`) || out[t.id]) continue;
      out[t.id] = { event_id: e.id, symbol: e.symbol, ex_date: e.ex_date, factor: e.factor, describe: describe(e.factor),
        shares_now: t.shares, shares_expected: expectedShares(t.shares, e.factor) };
    }
  }
  return out;
}

// Update a position to its new share count; prices and levels move by the same ratio, so its cost is unchanged.
export function applyEvent(book, tradeId, event, newShares, today) {
  const t = book.trades.find(x => x.id === tradeId && ['open', 'pending'].includes(x.status));
  if (!t || !event || event.symbol !== t.symbol) throw new Error('This position or event no longer exists. Refresh the page.');
  newShares = Math.trunc(newShares);
  if (newShares < 1) throw new Error('Enter how many shares you hold now.');
  const old = Math.trunc(t.shares);
  const ratio = newShares / old;
  const avg = t.entry_price;
  t.shares = newShares;
  for (const k of ['entry_price', 'initial_stop', 'stop', 'target', 'highest_close', 'entry_limit']) {
    if (t[k] !== null && t[k] !== undefined) t[k] /= ratio;
  }
  if (t.account === 'real') {
    addFill(book, t.id, t.symbol, event.ex_date, 'bonus', newShares - old, 0, 0,
      `${describe(event.factor)}: ${int(old)} → ${int(newShares)} shares`);
  }
  setAdjustment(book, event.id, t.id, 'applied', ratio, today);
  return { symbol: t.symbol, old, new: newShares, ratio, avg: avg ? avg / ratio : null };
}

export function ignoreEvent(book, tradeId, eventId, today) {
  setAdjustment(book, eventId, tradeId, 'ignored', null, today);
}

function setAdjustment(book, eventId, tradeId, action, ratio, date) {
  book.adjustments = book.adjustments.filter(a => !(a.event_id === eventId && a.trade_id === tradeId));
  book.adjustments.push({ event_id: eventId, trade_id: tradeId, action, ratio, date });
}

// Paper trades follow the re-based prices by themselves.
export function applyPaper(book, events, today) {
  let n = 0;
  for (const [id, ev] of Object.entries(pending(book, events, 'paper'))) {
    applyEvent(book, +id, events.find(e => e.id === ev.event_id), ev.shares_expected, today);
    n += 1;
  }
  return n;
}

export function dividendsByTrade(book, account = 'real') {
  const accountOf = new Map(book.trades.map(t => [t.id, t.account]));
  const out = {};
  for (const d of book.dividends) {
    if (accountOf.get(d.trade_id) === account) out[d.trade_id] = (out[d.trade_id] || 0) + d.amount;
  }
  return out;
}

export function addDividend(book, tradeId, day, amount, note = '') {
  const t = book.trades.find(x => x.id === tradeId && x.account === 'real');
  if (!t) throw new Error('Position not found.');
  if (!(amount > 0)) throw new Error('Enter the amount you received.');
  book.dividends.push({ id: nextId(book), trade_id: tradeId, symbol: t.symbol, date: day, shares: Math.trunc(t.shares),
    amount: +amount, note });
  return { symbol: t.symbol, per_share: amount / Math.trunc(t.shares) };
}

// ------------------------------------------------------------------ portfolio.py
export function nextId(book) {
  book.next_id = (book.next_id || 1);
  return book.next_id++;
}

export const trades = (book, account, statuses) => book.trades
  .filter(t => t.account === account && (!statuses || statuses.includes(t.status))).sort(byId);

function addFill(book, tradeId, symbol, date, side, shares, price, fees, note = '') {
  book.fills.push({ id: nextId(book), trade_id: tradeId, symbol, date, side, shares: Math.trunc(shares), price: +price,
    fees: +fees, note });
}

export const fillsOf = (book, tradeId) => book.fills.filter(f => f.trade_id === tradeId)
  .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));

export function openPosition(book, account, symbol) {
  return book.trades.filter(t => t.account === account && t.status === 'open' && t.symbol === symbol)
    .sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : a.id - b.id))[0] || null;
}

// Stop (typed by you, or the ATR rule) and the matching target for an entry/average price.
function levels(price, atr, cfg, stop) {
  const s = stop ? +stop : initialStop(price, atr, cfg);
  return [s, price + cfg.target_r * (price - s)];
}

// Log a buy. If you already hold this stock, the shares join that position at the average price.
export function addRealBuy(book, cfg, symbol, date, price, shares, atr, sector = '', stop = null, notes = '') {
  const fee = price * shares * cfg.fee_pct_per_side / 100;
  const pos = openPosition(book, 'real', symbol);
  let id;
  if (!pos) {
    const [s, target] = levels(price, atr, cfg, stop);
    id = nextId(book);
    book.trades.push({ id, account: 'real', status: 'open', symbol, sector, signal_date: null, entry_date: date,
      entry_price: price, shares, initial_stop: s, stop: s, target, entry_limit: null, highest_close: price,
      days_held: 0, exit_next_open: null, last_bar_date: null, exit_date: null, exit_price: null, exit_reason: null,
      fees: fee, notes });
  } else {
    id = pos.id;
    const total = pos.shares + shares;
    const avg = (pos.entry_price * pos.shares + price * shares) / total;
    const [s, target] = levels(avg, atr, cfg, stop);
    Object.assign(pos, { entry_date: pos.entry_date < date ? pos.entry_date : date, entry_price: avg, shares: total,
      initial_stop: s, stop: s, target, highest_close: avg, fees: (pos.fees || 0) + fee,
      notes: [pos.notes, notes].filter(Boolean).join('; ') });
  }
  addFill(book, id, symbol, date, 'buy', shares, price, fee, notes);
  return id;
}

export function closeTrade(book, cfg, tradeId, date, price, reason) {
  const t = book.trades.find(x => x.id === tradeId);
  t.fees = (t.fees || 0) + price * t.shares * cfg.fee_pct_per_side / 100;
  Object.assign(t, { status: 'closed', exit_date: date, exit_price: price, exit_reason: reason });
}

// Sell some or all shares of an open real position. Returns 'partial' or 'closed'.
export function sellReal(book, cfg, tradeId, date, price, shares, reason) {
  const pos = book.trades.find(t => t.id === tradeId && t.status === 'open');
  if (!pos) throw new Error('This position is not open.');
  shares = Math.trunc(shares);
  if (!(shares > 0 && shares <= pos.shares)) throw new Error(`You can sell between 1 and ${int(pos.shares)} shares.`);
  const sellFee = price * shares * cfg.fee_pct_per_side / 100;
  addFill(book, tradeId, pos.symbol, date, 'sell', shares, price, sellFee, reason);
  if (shares === pos.shares) {
    closeTrade(book, cfg, tradeId, date, price, reason);
    return 'closed';
  }
  const buyFeePart = (pos.fees || 0) * shares / pos.shares;
  book.trades.push({ ...pos, id: nextId(book), status: 'closed', shares, exit_date: date, exit_price: price,
    exit_reason: reason, fees: buyFeePart + sellFee, notes: `partial sale from position #${tradeId}` });
  pos.shares -= shares;
  pos.fees = (pos.fees || 0) - buyFeePart;
  return 'partial';
}

// Remove a position logged by mistake, with its transaction history.
export function deleteTrade(book, tradeId) {
  book.fills = book.fills.filter(f => f.trade_id !== tradeId);
  book.dividends = book.dividends.filter(d => d.trade_id !== tradeId);
  book.adjustments = book.adjustments.filter(a => a.trade_id !== tradeId);
  book.trades = book.trades.filter(t => t.id !== tradeId);
}

export function accountSummary(book, account, cfg, lastClose, events = []) {
  const start = +(account === 'real' ? cfg.capital : cfg.paper_capital);
  const closed = trades(book, account, ['closed']);
  const open = trades(book, account, ['open']);
  const dividends = sum(Object.values(dividendsByTrade(book, account)));
  const realized = sum(closed.map(t => (t.exit_price - t.entry_price) * t.shares - (t.fees || 0))) + dividends;
  const cost = sum(open.map(t => t.entry_price * t.shares + (t.fees || 0)));
  const cash = start + realized - cost;
  // A position still waiting for its bonus-share update holds the old share count at old prices.
  const factor = Object.fromEntries(Object.entries(pending(book, events, account)).map(([id, e]) => [id, e.factor]));
  const market = sum(open.map(t => (lastClose[t.symbol] ?? t.entry_price) * t.shares * (factor[t.id] ?? 1)));
  const equity = cash + market;
  return {
    start, cash, equity, realized, dividends, unrealized: market - cost, open_count: open.length,
    open_risk: sum(open.map(t => Math.max(0, t.entry_price - t.stop) * t.shares)), return_pct: equity / start - 1,
  };
}

export function positionsForAllocation(book, account, statuses = ['open', 'pending']) {
  return trades(book, account, statuses).map(t => ({
    symbol: t.symbol, sector: t.sector, entry_price: +(t.entry_price ?? t.entry_limit), stop: +t.stop,
    shares: Math.trunc(t.shares),
  }));
}

// ------------------------------------------------------------------ paper trading
export function createPaperOrders(book, orders, signalDate) {
  let n = 0;
  for (const o of orders) {
    if (!(o.shares > 0)) continue;
    book.trades.push({ id: nextId(book), account: 'paper', status: 'pending', symbol: o.symbol, sector: o.sector ?? null,
      signal_date: signalDate, entry_date: null, entry_price: null, shares: Math.trunc(o.shares), initial_stop: +o.stop,
      stop: +o.stop, target: +o.target, entry_limit: +o.entry_limit, highest_close: null, days_held: 0,
      exit_next_open: null, last_bar_date: null, exit_date: null, exit_price: null, exit_reason: null, fees: 0,
      notes: o.setup || '' });
    n += 1;
  }
  return n;
}

// Fill pending paper orders at the next open and walk open paper trades through new bars (up to `upto`).
export function processPaper(book, cfg, barsBySymbol, upto) {
  const fee = cfg.fee_pct_per_side / 100;
  const stats = { filled: 0, cancelled: 0, closed: 0 };
  for (const r of trades(book, 'paper', ['pending'])) {
    const bars = (barsBySymbol[r.symbol] || []).filter(b => b.date > r.signal_date && b.date <= upto);
    if (!bars.length) continue;
    const bar = bars[0];
    const [pos, msg] = fillOrder({ symbol: r.symbol, shares: r.shares, stop: r.stop, target: r.target,
      entry_limit: r.entry_limit, sector: r.sector }, bar);
    if (!pos) {
      Object.assign(r, { status: 'cancelled', exit_reason: msg, exit_date: bar.date });
      stats.cancelled += 1;
      continue;
    }
    const { cash } = accountSummary(book, 'paper', cfg, {});
    pos.shares = Math.min(pos.shares, Math.floor(cash / (pos.entry_price * (1 + fee))));
    if (pos.shares <= 0) {
      Object.assign(r, { status: 'cancelled', exit_reason: 'not enough paper cash' });
      stats.cancelled += 1;
      continue;
    }
    Object.assign(r, { status: 'open', entry_date: pos.entry_date, entry_price: pos.entry_price, shares: pos.shares,
      highest_close: pos.entry_price, fees: pos.entry_price * pos.shares * fee, last_bar_date: null, days_held: 0 });
    stats.filled += 1;
  }
  for (const r of trades(book, 'paper', ['open'])) {
    const all = barsBySymbol[r.symbol];
    if (!all) continue;
    const bars = all.filter(b => (r.last_bar_date ? b.date > r.last_bar_date : b.date >= r.entry_date) && b.date <= upto);
    const pos = position(r);
    let last = r.last_bar_date;
    let exit = null;
    for (const bar of bars) {
      const res = processBar(pos, bar, cfg);
      last = bar.date;
      if (res) { exit = res; break; }
    }
    Object.assign(r, { stop: pos.stop, highest_close: pos.highest_close, days_held: pos.days_held,
      exit_next_open: pos.exit_next_open, last_bar_date: last });
    if (exit) {
      closeTrade(book, cfg, r.id, last, exit[0], exit[1]);
      stats.closed += 1;
    }
  }
  return stats;
}

// One scan day for a paper account (scan.process_account): bonus-share updates, fills and exits up to that close, then
// the orders for that day's BUY signals. day = { date, risk_off, buys: [...] }; stocks: Map of symbol → stock info.
export function paperDay(book, cfg, barsBySymbol, events, day, stocks, today) {
  applyPaper(book, events, today);
  const st = processPaper(book, cfg, barsBySymbol, day.date);
  let newOrders = 0;
  const mine = day.buys.filter(b => stocks.has(b.symbol) && passesFilter(stocks.get(b.symbol), cfg.shariah_filter));
  if (cfg.auto_paper && mine.length) {
    const px = {};
    for (const [sym, bars] of Object.entries(barsBySymbol)) {
      const upto = bars.filter(b => b.date <= day.date);
      const last = upto[upto.length - 1];
      if (last && Number.isFinite(last.close)) px[sym] = last.close;
    }
    const paper = accountSummary(book, 'paper', cfg, px, events);
    const sized = allocate(mine, paper.equity, paper.cash, positionsForAllocation(book, 'paper'), cfg, day.risk_off);
    const already = new Set(trades(book, 'paper').filter(t => t.signal_date === day.date).map(t => t.symbol));
    newOrders = createPaperOrders(book, sized.filter(o => !already.has(o.symbol)), day.date);
  }
  return { ...st, new_orders: newOrders, date: day.date };
}

// The last close at or before `day` in a sorted series { time: [...], close: [...] }.
export function closeOn(series, day) {
  let lo = 0, hi = series.time.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.time[mid] <= day) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found >= 0 ? series.close[found] : null;
}

// Daily account value from the first trade onward (cash + holdings at each close).
export function equityCurve(book, account, cfg, closes, dates) {
  const ts = trades(book, account, ['open', 'closed']);
  const start = +(account === 'real' ? cfg.capital : cfg.paper_capital);
  if (!ts.length) return [];
  const first = ts.map(t => t.entry_date).sort()[0];
  const fee = cfg.fee_pct_per_side / 100;
  const out = [];
  for (const d of dates.filter(x => x >= first)) {
    let cash = start, held = 0;
    for (const r of ts) {
      if (r.entry_date > d) continue;
      cash -= r.entry_price * r.shares * (1 + fee);
      if (r.status === 'closed' && r.exit_date <= d) cash += r.exit_price * r.shares * (1 - fee);
      else {
        const s = closes[r.symbol];
        const c = s ? closeOn(s, d) : null;
        held += (c ?? r.entry_price) * r.shares;
      }
    }
    out.push([d, cash + held]);
  }
  return out;
}
