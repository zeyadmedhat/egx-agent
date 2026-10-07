// The agent's money rules for the GitHub Pages site, where your portfolio lives in your browser.
// Line-for-line ports of egx_agent/engine.py, risk.py, portfolio.py and corporate.py, so the site and the Mac
// give the same answers (tests/test_static_site.py runs both on the same cases). No browser APIs in here: the
// tests run this file in Node.
//
// A "book" is one person's data, shaped like the Mac's database tables:
//   { trades: [...], fills: [...], dividends: [...], adjustments: [...], next_id: 1 }
// Bars are { date: 'YYYY-MM-DD', open, high, low, close, atr14, ema50, div, sup } (missing numbers are NaN; div is
// the cash dividend going ex that day, 0 on other days; sup the chart's stop under support that day, levels.py).

// ------------------------------------------------------------------ fees (egx_agent/config.py)
// Thndr's own commission on one order: EGP 2 + 0.1% (none on a Thndr Trader order).
export const thndrCommission = v => (v > 0 ? 2 + v * 0.001 : 0);
// What every Egyptian broker passes on, per order: EGX, clearing, investor fund and stamp duty 0.075%, FRA 0.005% (EGP 1–250).
export const governmentFees = v => (v > 0 ? v * 0.00075 + Math.min(Math.max(v * 0.00005, 1), 250) : 0);
// What one buy or sell order of this value (EGP) costs with your broker. Thndr Trader: no commission on the plan
// month's first 50 orders (free_trade false: one after them, or from before you subscribed).
export function orderFee(v, cfg) {
  if (cfg.broker === 'thndr') return thndrCommission(v) + governmentFees(v);
  if (cfg.broker === 'thndr_trader') return governmentFees(v) + (cfg.free_trade === false ? thndrCommission(v) : 0);
  return v * cfg.fee_pct_per_side / 100;
}
// Your fees a side as a %, for estimates where the order's size isn't known.
export const feePct = cfg => ({ thndr: 0.18, thndr_trader: 0.08 })[cfg.broker] ?? cfg.fee_pct_per_side;

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
let holidays = {};                // EGX's announced holidays, {date: title} (egx_agent/holidays.py)
export function setHolidays(h) { holidays = h || {}; }
const trading = day => weekday(day) <= 4 && !(day in holidays);

export function addDays(day, n) {
  return iso(new Date(Date.parse(day + 'T00:00:00Z') + n * DAY));
}

// Date n EGX sessions after `day` (the announced holidays skipped), like views.sessions_after.
export function sessionsAfter(day, n) {
  let d = day;
  for (let k = 0; k < n;) {
    d = addDays(d, 1);
    if (trading(d)) k += 1;
  }
  return d;
}

// Cairo's date and minutes after midnight at `now`.
function cairo(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute };
}

// Most recent EGX session whose closing data should be available by now (scan.expected_session_date).
export function expectedSessionDate(now = new Date()) {
  let { day: d, minutes } = cairo(now);
  if (trading(d) && minutes >= 15 * 60 + 30) return d;
  d = addDays(d, -1);
  while (!trading(d)) d = addDays(d, -1);
  return d;
}

// The first session a stop you set now counts in: today's if it hasn't opened yet (10:00 Cairo), else the next one,
// so a price earlier today, from before you set it, can't sell you.
export function stopFrom(now = new Date()) {
  const { day, minutes } = cairo(now);
  return trading(day) && minutes < 10 * 60 ? day : sessionsAfter(day, 1);
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
    ...(o.my_stop ? { my_stop: +o.my_stop, my_stop_from: o.my_stop_from } : {}),
  };
}

function stopLabel(p) {
  if (p.stop > p.entry_price * 1.0005) return 'Trailing stop';
  if (p.stop >= p.entry_price * 0.9995) return 'Breakeven stop';
  return 'Stop-loss';
}

// Advance a position through one daily bar. Returns [exit price, reason] when it exits.
// The stock goes ex-dividend today: the price drops by the dividend, which the holder gets, so the stop, the target
// and the highest close move down by it too (engine.ex_dividend).
export function exDividend(p, amount) {
  p.stop -= amount;
  p.target -= amount;
  p.highest_close -= amount;
}

export function processBar(p, bar, cfg) {
  if (p.exit_next_open) return [bar.open, p.exit_next_open];
  p.days_held += 1;
  if (p.days_held >= 2 && bar.div > 0) {                    // held at the close before: the dividend is ours
    exDividend(p, bar.div);
    if (p.my_stop && bar.date >= p.my_stop_from) p.my_stop -= bar.div;   // you chose it on the prices before
  }
  // a stop you set yourself (only ever higher) counts from its first session (stopFrom), not on the days before
  if (p.my_stop > p.stop && bar.date >= p.my_stop_from) p.stop = p.my_stop;
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
  if (p.highest_close >= p.entry_price + r && !cfg.freeze_stops) {   // freeze_stops: stop_moves "mine" (realStatus)
    const trail = p.highest_close - cfg.atr_stop_mult * bar.atr14;
    p.stop = Math.max(p.stop, p.entry_price * (1 + (cfg.breakeven_pct || 0) / 100));   // entry + breakeven_pct
    if (trail > p.stop) p.stop = trail;                    // a NaN trail (no ATR yet) is ignored, as in Python
  }
  if (cfg.stop_follows_support && !cfg.freeze_stops && bar.sup > p.stop) p.stop = bar.sup;   // under the nearest support; NaN: none
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
  if (p.my_stop > p.stop) p.stop = p.my_stop;          // set after the last close: it counts from the next session
  const last = bars.length ? bars[bars.length - 1].date : 'None';
  const r = p.entry_price - p.initial_stop;
  if (p.exit_next_open) {
    return { status: 'EXIT', reason: `${p.exit_next_open}: sell at the next open`, stop: p.stop,
      days_held: p.days_held, event_date: last };
  }
  const close = bars.length ? bars[bars.length - 1].close : null;
  if (close != null && close <= p.stop) {
    // no day after the buy was replayed (its date is the last close's or later, e.g. an old buy logged today)
    return { status: 'EXIT', reason: `Stop-loss: closed at ${f2(close)}, under your stop (${f2(p.stop)}): sell at the next open`,
      stop: p.stop, days_held: p.days_held, event_date: last };
  }
  if (p.days_held >= cfg.review_day && p.highest_close < p.entry_price + r) {
    return { status: 'REVIEW',
      reason: `Day ${p.days_held}: no +1R move yet (needs ${f2(p.entry_price + r)}). Consider exiting.`,
      stop: p.stop, days_held: p.days_held, event_date: last };
  }
  if (p.stop > prevStop + 1e-9 && p.stop !== p.my_stop) {   // a stop you set yourself needs no reminder
    return { status: 'TIGHTEN STOP', reason: `Raise your stop to ${f2(p.stop)}`, stop: p.stop, prev_stop: prevStop,
      days_held: p.days_held, event_date: last };
  }
  return { status: 'HOLD', reason: `Stop ${f2(p.stop)}, target ${f2(p.target)}`, stop: p.stop,
    days_held: p.days_held, event_date: last };
}

// The rules say sell a position 30%+ under its average price: sell it on the first bounce instead (portfolio.on_bounce,
// where the tests behind it are).
export const BIG_LOSS = 0.30, BOUNCE_DAYS = 20;
function onBounce(t, bars, st) {
  const deep = t.entry_price * (1 - BIG_LOSS);
  const last = bars[bars.length - 1];
  if (st.status !== 'EXIT' || last.close > deep) return st;
  const loss = `${((last.close / t.entry_price - 1) * 100).toFixed(1)}%`;
  // the plan starts at the first close after the buy 30%+ under it (the last close, for an old buy logged later)
  let start = bars.findIndex(b => b.date > t.entry_date && b.close <= deep);
  if (start < 0) start = bars.length - 1;
  const up = bars.slice(start).find(b => b.ema20 != null && b.close > b.ema20);
  if (up) return { ...st, reason: `Big loss (${loss}): back above its 20-day average on ${up.date}: sell at the next open` };
  if (bars.length - 1 - start >= BOUNCE_DAYS) {
    return { ...st, reason: `Big loss (${loss}): no close above its 20-day average in ${BOUNCE_DAYS} sessions: sell at the next open` };
  }
  const by = sessionsAfter(bars[start].date, BOUNCE_DAYS);
  return { ...st, status: 'BOUNCE', bounce_level: last.ema20, bounce_by: by,
    reason: `Big loss (${loss}): sell at the first close above its 20-day average (${f2(last.ema20)} now), by ${by} at the latest` };
}

// What the exit rules say about one open real trade today (portfolio.real_status).
export function realStatus(t, bars, cfg) {
  if (!bars || !bars.length) {
    return { status: 'NO DATA', reason: 'No price data for this symbol', stop: t.stop, days_held: 0, last_close: null };
  }
  const p = position({ ...t, stop: t.initial_stop, highest_close: t.entry_price, days_held: 0, exit_next_open: null });
  if (cfg.stop_moves === 'mine') cfg = { ...cfg, freeze_stops: true };   // the stop stays where it was set
  const st = onBounce(t, bars, replayStatus(p, bars, cfg));
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
  const fee = feePct(cfg) / 100;
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
  const fee = feePct(cfg) / 100;
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
      // a rights issue (corporate.pending): how many new shares you subscribed to is yours to say
      out[t.id] = { event_id: e.id, symbol: e.symbol, ex_date: e.ex_date, factor: e.factor, rights: !!e.rights,
        describe: e.rights ? `a rights issue, past prices divided by ${g(+e.factor.toPrecision(4))}` : describe(e.factor),
        shares_now: t.shares, shares_expected: e.rights ? t.shares : expectedShares(t.shares, e.factor) };
    }
  }
  return out;
}

// The average price on the new prices (corporate.new_average). Bonus shares or a split: the same cost over more
// shares. A rights issue: the new shares add what they cost (paid each); kept the old count (sold the rights): the
// shares are worth ÷ factor and the rest came back as the rights' price, so the cost goes ÷ factor too.
export function newAverage(avg, old, n, factor, rights, paid = 0) {
  if (rights && n === old) return avg / factor;
  return (avg * old + Math.max(n - old, 0) * paid) / n;
}

// Update a position to its new share count; its levels (your own stop too) move with the prices (÷ the event's factor).
export function applyEvent(book, tradeId, event, newShares, today, paid = 0) {
  const t = book.trades.find(x => x.id === tradeId && ['open', 'pending'].includes(x.status));
  if (!t || !event || event.symbol !== t.symbol) throw new Error('This position or event no longer exists. Refresh the page.');
  newShares = Math.trunc(newShares);
  if (newShares < 1) throw new Error('Enter how many shares you hold now.');
  const old = Math.trunc(t.shares);
  const ratio = newShares / old;
  const f = +event.factor, rights = !!event.rights;
  if (!rights) paid = 0;
  const avg = t.entry_price ? newAverage(t.entry_price, old, newShares, f, rights, paid) : null;
  t.shares = newShares;
  t.entry_price = avg;
  for (const k of ['initial_stop', 'stop', 'target', 'highest_close', 'entry_limit', 'my_stop']) {
    if (t[k] !== null && t[k] !== undefined) t[k] /= f;
  }
  if (t.account === 'real') {
    const note = !rights ? `${describe(f)}: ${int(old)} → ${int(newShares)} shares`
      : newShares > old ? `Rights issue: ${int(newShares - old)} new shares at ${g(paid)}, ${int(old)} → ${int(newShares)} shares`
        : `Rights issue: kept ${int(old)} shares, prices ÷ ${g(+f.toPrecision(4))}`;
    addFill(book, t.id, t.symbol, event.ex_date, 'bonus', newShares - old, paid, 0, note);
    if (rights) book.fills.at(-1).factor = f;          // so rebuildTrade can follow it
  }
  setAdjustment(book, event.id, t.id, 'applied', ratio, today);
  return { symbol: t.symbol, old, new: newShares, ratio, avg };
}

export function ignoreEvent(book, tradeId, eventId, today) {
  setAdjustment(book, eventId, tradeId, 'ignored', null, today);
}

function setAdjustment(book, eventId, tradeId, action, ratio, date) {
  book.adjustments = book.adjustments.filter(a => !(a.event_id === eventId && a.trade_id === tradeId));
  book.adjustments.push({ event_id: eventId, trade_id: tradeId, action, ratio, date });
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

function addFill(book, tradeId, symbol, date, side, shares, price, fees, note = '', feesIn = false) {
  book.fills.push({ id: nextId(book), trade_id: tradeId, symbol, date, side, shares: Math.trunc(shares), price: +price,
    fees: +fees, note, ...(feesIn ? { fees_in: true } : {}) });
}

export const fillsOf = (book, tradeId) => book.fills.filter(f => f.trade_id === tradeId)
  .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));

export function openPosition(book, account, symbol) {
  return book.trades.filter(t => t.account === account && t.status === 'open' && t.symbol === symbol)
    .sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : a.id - b.id))[0] || null;
}

// Stop and target for an entry/average price (portfolio._levels): the stop you typed, else the chart's support when
// it's between stop_min_pct and stop_max_pct below, else the ATR rule; the chart's target when it pays at least the
// risk, else target_r × the risk. chart: { stop, target } on the buy date, stop NaN when no support was in reach.
// Also where each came from (stop_src: yours / chart / formula, target_src: chart / formula), for the stock page.
function levels(price, atr, cfg, stop, chart = null) {
  const gap = chart ? 1 - chart.stop / price : NaN;
  const fromChart = !stop && !!chart && gap >= cfg.stop_min_pct / 100 && gap <= cfg.stop_max_pct / 100;
  const s = stop ? +stop : fromChart ? chart.stop : initialStop(price, atr, cfg);
  const risk = price - s;
  const chartTarget = !!chart && chart.target >= price + risk;
  return [s, chartTarget ? chart.target : price + cfg.target_r * risk,
    { stop_src: stop ? 'yours' : fromChart ? 'chart' : 'formula', target_src: chartTarget ? 'chart' : 'formula' }];
}

// Log a buy. If you already hold this stock, the shares join that position at the average price. feesIn: the price
// is your broker's average cost, which already has the fees in it (Thndr's does), so none are added.
export function addRealBuy(book, cfg, symbol, date, price, shares, atr, sector = '', stop = null, notes = '', chart = null,
  feesIn = false) {
  const fee = feesIn ? 0 : orderFee(price * shares, cfg);
  const pos = openPosition(book, 'real', symbol);
  let id;
  if (!pos) {
    const [s, target, src] = levels(price, atr, cfg, stop, chart);
    id = nextId(book);
    book.trades.push({ id, account: 'real', status: 'open', symbol, sector, signal_date: null, entry_date: date,
      entry_price: price, shares, initial_stop: s, stop: s, target, entry_limit: null, highest_close: price,
      days_held: 0, exit_next_open: null, last_bar_date: null, exit_date: null, exit_price: null, exit_reason: null,
      fees: fee, notes, ...src });
  } else {
    id = pos.id;
    const total = pos.shares + shares;
    const avg = (pos.entry_price * pos.shares + price * shares) / total;
    const [s, target, src] = levels(avg, atr, cfg, stop, chart);
    Object.assign(pos, { entry_date: pos.entry_date < date ? pos.entry_date : date, entry_price: avg, shares: total,
      initial_stop: s, stop: s, target, highest_close: avg, fees: (pos.fees || 0) + fee,
      notes: [pos.notes, notes].filter(Boolean).join('; '), ...src });
  }
  addFill(book, id, symbol, date, 'buy', shares, price, fee, notes, feesIn);
  return id;
}

export function closeTrade(book, cfg, tradeId, date, price, reason) {
  const t = book.trades.find(x => x.id === tradeId);
  t.fees = (t.fees || 0) + orderFee(price * t.shares, cfg);
  Object.assign(t, { status: 'closed', exit_date: date, exit_price: price, exit_reason: reason });
}

// Sell some or all shares of an open real position. Returns 'partial' or 'closed'.
export function sellReal(book, cfg, tradeId, date, price, shares, reason) {
  const pos = book.trades.find(t => t.id === tradeId && t.status === 'open');
  if (!pos) throw new Error('This position is not open.');
  shares = Math.trunc(shares);
  if (!(shares > 0 && shares <= pos.shares)) throw new Error(`You can sell between 1 and ${int(pos.shares)} shares.`);
  const sellFee = orderFee(price * shares, cfg);
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
// After you edit, delete or add a transaction: the position rebuilt from its transactions in date order, as if each
// had been logged on its day. Its partial sales become closed trades again, a sale of every share closes it, and
// removing that sale opens it again. The stop and target are worked out again only when the buys changed; at(day)
// gives { atr, chart } on a day for that. Returns the trade, or null when no buy is left (then it's all deleted).
export function rebuildTrade(book, cfg, tradeId, at) {
  const t = book.trades.find(x => x.id === tradeId && x.account === 'real');
  if (!t) throw new Error('This trade no longer exists. Refresh the page.');
  const tag = `partial sale from position #${tradeId}`;
  const fills = fillsOf(book, tradeId);
  if (!fills.some(f => f.side === 'buy')) {
    book.trades = book.trades.filter(x => !(x.status === 'closed' && x.notes === tag));
    deleteTrade(book, tradeId);
    return null;
  }
  let shares = 0, avg = 0, fees = 0, first = null, lastBuy = null, avgAtBuy = 0, scale = 1, end = null;
  const sales = [];
  for (const f of fills) {
    if (end) throw new Error(`All its shares were sold on ${end.date}, so nothing can come after that. Log a later buy as a new position.`);
    if (f.side === 'buy') {
      avg = (avg * shares + f.price * f.shares) / (shares + f.shares);
      shares += f.shares; fees += f.fees || 0;
      first = first || f.date; lastBuy = f; avgAtBuy = avg; scale = 1;
    } else if (f.side === 'bonus' && shares) {
      // bonus shares or a split: prices ÷ the share ratio; a rights issue carries its own factor (applyEvent)
      const r = f.factor || (shares + f.shares) / shares;
      avg = newAverage(avg, shares, shares + f.shares, r, !!f.factor, f.price || 0);
      shares += f.shares; scale *= r;
    } else if (f.side === 'sell') {
      if (f.shares > shares) {
        throw new Error(`On ${f.date} you'd sell ${int(f.shares)} shares, but you held ${int(shares)} then.`);
      }
      if (f.shares === shares) { end = f; fees += f.fees || 0; continue; }
      const part = fees * f.shares / shares;
      sales.push({ shares: f.shares, entry_price: avg, exit_date: f.date, exit_price: f.price,
        exit_reason: f.note || 'Other / my decision', fees: part + (f.fees || 0) });
      fees -= part; shares -= f.shares;
    }
  }
  if (!end && book.trades.some(x => x.id !== tradeId && x.account === 'real' && x.status === 'open' && x.symbol === t.symbol)) {
    throw new Error(`You have another open ${t.symbol} position, so this one can't open again. Sell or delete that one first.`);
  }
  // The stop and target: as they were unless the buys changed; then from the last buy, like logging it again.
  let lv = {};
  if (Math.abs(avg - t.entry_price) > 1e-9 || first !== t.entry_date) {
    const m = at(lastBuy.date);
    const yours = t.stop_src === 'yours' ? t.initial_stop * scale : null;
    if (Number.isFinite(m.atr) || yours) {
      const [s, target, src] = levels(avgAtBuy, m.atr, cfg, yours, m.chart);
      lv = { initial_stop: s / scale, stop: s / scale, target: target / scale, highest_close: avg, ...src };
    }
  }
  const base = { ...t, ...lv, entry_price: avg, entry_date: first };
  book.trades = book.trades.filter(x => !(x.status === 'closed' && x.notes === tag));
  for (const s of sales) book.trades.push({ ...base, ...s, id: nextId(book), status: 'closed', notes: tag });
  Object.assign(t, base, end
    ? { status: 'closed', shares, fees, exit_date: end.date, exit_price: end.price, exit_reason: end.note || 'Other / my decision' }
    : { status: 'open', shares, fees, exit_date: null, exit_price: null, exit_reason: null });
  return t;
}

export function deleteTrade(book, tradeId) {
  book.fills = book.fills.filter(f => f.trade_id !== tradeId);
  book.dividends = book.dividends.filter(d => d.trade_id !== tradeId);
  book.adjustments = book.adjustments.filter(a => a.trade_id !== tradeId);
  book.trades = book.trades.filter(t => t.id !== tradeId);
}

// Your broker wallet (book.cash, the real account): money you topped up or withdrew, and money in or out beside the
// orders (settlement fees, a commission kickback). A fix sets the balance to what your broker shows.
export const walletEffect = m => (m.kind === 'deposit' ? m.amount - (m.fee || 0) : m.kind === 'withdraw'
  ? -m.amount - (m.fee || 0) : m.kind === 'fee' ? -m.amount : m.kind === 'settle' ? -(m.fee || 0) : m.amount);
export const walletFlow = m => (m.kind === 'deposit' ? m.amount : m.kind === 'withdraw' ? -m.amount : 0);   // put in / took out

// Thndr Trader (book.plan: { since, kind: 'monthly' | 'yearly', price, added, paid_to }). Thndr takes its commission
// on every order and gives it back to your wallet at the end of the day ("Commission kickback") on the first 50 buys
// and sales of each plan month, which starts on the day of the month you subscribed; the price comes out of your
// wallet when the plan renews (support.thndr.app, Oct 2026). A renewal before you added the plan here is already in
// the balance you had then (paid_to: the last one taken).
export const PLAN_FREE = 50;
export const PLAN_PRICE = { monthly: 245, yearly: 2646 };

// The date n months after `day`, on its day of the month (the 31st is a shorter month's last day).
export function monthsAfter(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const k = y * 12 + m - 1 + n, Y = Math.floor(k / 12), M = k - Y * 12;
  return iso(new Date(Date.UTC(Y, M, Math.min(d, new Date(Date.UTC(Y, M + 1, 0)).getUTCDate()))));
}

// The plan month `day` is in, [its first day, the next one's]; null before you subscribed.
export function planMonth(plan, day) {
  if (!plan || day < plan.since) return null;
  let n = (+day.slice(0, 4) - +plan.since.slice(0, 4)) * 12 + (+day.slice(5, 7) - +plan.since.slice(5, 7));
  if (monthsAfter(plan.since, n) > day) n -= 1;
  return [monthsAfter(plan.since, n), monthsAfter(plan.since, n + 1)];
}

// Your buys and sales in that plan month up to `day` (not counting the transaction `skip`, one being changed).
export function planTrades(book, plan, day, skip = null) {
  const m = planMonth(plan, day);
  if (!m) return 0;
  const real = new Set(book.trades.filter(t => t.account === 'real').map(t => t.id));
  return book.fills.filter(f => f.id !== skip && real.has(f.trade_id) && (f.side === 'buy' || f.side === 'sell')
    && f.date >= m[0] && f.date <= day).length;
}
export const planFree = (book, plan, day, skip = null) => !!planMonth(plan, day) && planTrades(book, plan, day, skip) < PLAN_FREE;

// The renewals from `from` on: the next one after today (from = today), or the ones due up to today not taken yet.
export function planRenewals(plan, from, to) {
  const step = plan.kind === 'yearly' ? 12 : 1, out = [];
  for (let n = step, d; (d = monthsAfter(plan.since, n)) <= to; n += step) if (d > from) out.push(d);
  return out;
}
export const planNext = (plan, today) => planRenewals(plan, today, monthsAfter(today, 13))[0];

// A sale's money can buy at once, but can be withdrawn only once it settles, 2 sessions later, or at once with
// your broker's Settle now (a 'settle' wallet move: that much of the money still settling then, oldest sale first).
export const SETTLE_DAYS = 2;
export function unsettled(book, today) {
  const real = new Set(book.trades.filter(t => t.account === 'real').map(t => t.id));
  const sales = book.fills.filter(f => f.side === 'sell' && real.has(f.trade_id))
    .map(f => ({ date: f.date, until: sessionsAfter(f.date, SETTLE_DAYS), left: f.shares * f.price - (f.fees || 0) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const m of (book.cash || []).filter(x => x.kind === 'settle' && x.date <= today)) {
    let a = m.amount;
    for (const s of sales) {
      if (a <= 0) break;
      if (s.date <= m.date && s.until > m.date) { const k = Math.min(a, s.left); s.left -= k; a -= k; }
    }
  }
  return sum(sales.filter(s => s.until > today).map(s => s.left));
}

export function accountSummary(book, account, cfg, lastClose, events = []) {
  const capital = +(account === 'real' ? cfg.capital : cfg.paper_capital);
  const moves = account === 'real' ? book.cash || [] : [];
  const added = sum(moves.map(walletFlow));
  const start = capital + added;                  // the money you put in: returns don't count top-ups as profit
  const closed = trades(book, account, ['closed']);
  const open = trades(book, account, ['open']);
  const dividends = sum(Object.values(dividendsByTrade(book, account)));
  const realized = sum(closed.map(t => (t.exit_price - t.entry_price) * t.shares - (t.fees || 0))) + dividends;
  const cost = sum(open.map(t => t.entry_price * t.shares + (t.fees || 0)));
  const cash = capital + sum(moves.map(walletEffect)) + realized - cost;
  // A position still waiting for its bonus-share update holds the old share count at old prices.
  const factor = Object.fromEntries(Object.entries(pending(book, events, account)).map(([id, e]) => [id, e.factor]));
  const market = sum(open.map(t => (lastClose[t.symbol] ?? t.entry_price) * t.shares * (factor[t.id] ?? 1)));
  const equity = cash + market;
  return {
    start, capital, added, cash, equity, realized, dividends, unrealized: market - cost, open_count: open.length,
    open_risk: sum(open.map(t => Math.max(0, t.entry_price - t.stop) * t.shares)),
    return_pct: start > 0 ? equity / start - 1 : null,
  };
}

export function positionsForAllocation(book, account, statuses = ['open', 'pending']) {
  return trades(book, account, statuses).map(t => ({
    symbol: t.symbol, sector: t.sector, entry_price: +(t.entry_price ?? t.entry_limit), stop: +t.stop,
    shares: Math.trunc(t.shares),
  }));
}
