// The GitHub Pages site has no server: this answers the dashboard's /api/... requests in the browser, with the same
// shapes app/views.py and app/server.py give on your Mac. The shared parts come from the scan's published files;
// your portfolio and settings come from this browser (site.js). Paper trading and the backtest are only on the Mac.
import * as E from './engine.js';
import { load, loadBook, saveBook, validBook, emptyBook } from './site.js';

export class LocalError extends Error {
  constructor(message, status = 400, detail = null) { super(message); this.status = status; this.detail = detail ?? { message }; }
}
const fail = (status, message, extra) => { throw new LocalError(message, status, { message, ...extra }); };

const STATUS_ORDER = { ADJUST: 0, EXIT: 1, REVIEW: 2, 'TIGHTEN STOP': 3, HOLD: 4, 'NO DATA': 5 };
const ACTION_STATUSES = ['ADJUST', 'EXIT', 'REVIEW', 'TIGHTEN STOP'];
const KEEP_ON_RESET = ['capital', 'fee_pct_per_side'];

const localToday = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

// ------------------------------------------------------------------ one request's context
async function context() {
  const core = await load('core');
  const book = loadBook();
  const cfg = { ...core.strategy, ...core.personal_defaults };
  for (const [k, v] of Object.entries(book.settings || {})) if (k in core.personal_defaults) cfg[k] = v;
  return { core, book, cfg, stocks: new Map(core.stocks.map(s => [s.symbol, s])), bars: {} };
}

const info = (c, sym) => c.stocks.get(sym)
  || { symbol: sym, egx33_manual: false, kashif_url: `${c.core.kashif_url}${encodeURIComponent(sym)}` };
const closes = c => Object.fromEntries(c.core.stocks.filter(s => s.close != null).map(s => [s.symbol, s.close]));

// Daily bars for the exit rules, from the stock's published page.
async function barsFor(c, symbols) {
  await Promise.all([...new Set(symbols)].filter(s => !(s in c.bars)).map(async sym => {
    const page = await load(`stock/${sym}`);
    const s = page && page.series;
    if (!s) { c.bars[sym] = []; return; }
    const bars = [];
    const divs = s.divs || {};            // cash dividend per share by ex-date
    for (let i = 0; i < s.time.length; i++) {
      bars.push({ date: s.time[i], open: E.num(s.open[i]), high: E.num(s.high[i]), low: E.num(s.low[i]),
        close: E.num(s.close[i]), atr14: E.num(s.atr14[i]), ema50: E.num(s.ema50[i]), div: divs[s.time[i]] || 0,
        sup: E.num((s.sup || [])[i]), ptgt: E.num((s.ptgt || [])[i]) });   // the chart's stop and target that day
    }
    c.bars[sym] = bars;
  }));
  return c.bars;
}

// ------------------------------------------------------------------ views (app/views.py)
function signals(c) {
  if (c.signals) return c.signals;
  const buys = [], other = [];
  for (const r0 of c.core.signals) {
    const r = { ...r0 };
    const st = c.stocks.get(r.symbol);
    r.sector = (st && st.sector) || 'Other';
    if (r.action === 'BUY' && !E.passesFilter(st || {}, c.cfg.shariah_filter)) {
      Object.assign(r, { action: 'WATCH', size_note: "doesn't pass your Shariah filter" });
    }
    if (r.action === 'BUY') buys.push(r);
    else {
      Object.assign(r, { shares: 0, amount: 0, risk_egp: 0, size_note: r.size_note || 'watch only: no entry signal yet' });
      other.push(r);
    }
  }
  let sized = buys;
  // Who gets money first: the prediction model's rank that day, then the rules' score (views.signal_order).
  const pri = r => (r.priority == null ? -1 : r.priority);
  const order = (a, b) => pri(b) - pri(a) || b.score - a.score;
  if (buys.length) {
    const real = E.accountSummary(c.book, 'real', c.cfg, closes(c), c.core.events);
    sized = E.allocate([...buys].sort(order), real.equity, real.cash,
      E.positionsForAllocation(c.book, 'real', ['open']), c.cfg, !!(c.core.market && c.core.market.risk_off));
  }
  const rows = [...sized, ...other].sort((a, b) => (a.action !== 'BUY') - (b.action !== 'BUY') || order(a, b));
  c.signals = [c.core.scan_date, rows];
  return c.signals;
}

async function openPositions(c, symbol = null) {
  const { book, cfg, core } = c;
  const fee = cfg.fee_pct_per_side / 100;
  const pend = E.pending(book, core.events, 'real');
  const divs = E.dividendsByTrade(book, 'real');
  const open = E.trades(book, 'real', ['open']).filter(t => !symbol || t.symbol === symbol);
  const bars = await barsFor(c, open.map(t => t.symbol));
  const out = open.map(r => {
    const b = bars[r.symbol] || [];
    const ev = pend[r.id];
    let factor = 1, stt, last;
    if (ev) {
      // Past prices were re-based after this buy, so the exit rules can't be checked until the share count is
      // updated. Value the old share count at the new price × the ratio meanwhile.
      factor = ev.factor;
      last = b.length ? b[b.length - 1].close : r.entry_price / factor;
      stt = { status: 'ADJUST', stop: null, days_held: b.filter(x => x.date >= r.entry_date).length,
        reason: `Bonus shares or split from ${E.niceDate(ev.ex_date)}: ${ev.describe}. `
          + 'Enter the shares you hold now so the stop and P&L stay right.' };
    } else {
      stt = E.realStatus(r, b, cfg);
      last = stt.last_close || r.entry_price;
    }
    const fees = r.fees || 0;
    const div = divs[r.id] || 0;
    const fills = E.fillsOf(book, r.id).map(f => ({ id: f.id, date: f.date, side: f.side, shares: f.shares,
      price: f.price, fees: f.fees, note: f.note }));
    for (const x of book.dividends.filter(d => d.trade_id === r.id).sort((a, b2) => (a.date < b2.date ? -1 : 1))) {
      fills.push({ id: null, dividend_id: x.id, date: x.date, side: 'dividend', shares: x.shares,
        price: x.shares ? x.amount / x.shares : null, fees: 0, amount: x.amount, note: x.note || '' });
    }
    fills.sort((a, b2) => (a.date < b2.date ? -1 : a.date > b2.date ? 1 : (a.side === 'dividend') - (b2.side === 'dividend')));
    const worth = last * factor;
    return {
      id: r.id, symbol: r.symbol, info: info(c, r.symbol), status: stt.status, reason: stt.reason,
      first_buy: r.entry_date, avg_price: r.entry_price, shares: r.shares, last, value: worth * r.shares,
      pnl_pct: worth / r.entry_price - 1,
      pnl: (worth - r.entry_price) * r.shares - fees - worth * r.shares * fee + div,
      stop: stt.stop, prev_stop: stt.prev_stop ?? null, initial_stop: r.initial_stop, target: r.target,
      stop_src: r.stop_src || null, target_src: r.target_src || null, day: stt.days_held, sell_by: E.sessionsAfter(r.entry_date, cfg.max_hold_days - 1), fees, dividends: div,
      notes: r.notes || '', fills, adjust: ev || null, n_buys: fills.filter(f => f.side === 'buy').length || 1,
    };
  });
  out.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || (a.symbol < b.symbol ? -1 : 1));
  return out;
}

function status(c, positions) {
  const m = c.core.market;
  const [, sig] = signals(c);
  return {
    version: c.core.stamp,
    market: m ? { ...Object.fromEntries(['date', 'egx30_close', 'egx30_change', 'egx30_ema50', 'risk_off', 'watches',
      'finished'].map(k => [k, m[k] ?? null])), buys: sig.filter(r => r.action === 'BUY').length } : null,
    alerts: positions.filter(p => ACTION_STATUSES.includes(p.status)).length,
    positions: positions.length,
    job: null,
    scan_url: c.core.scan_url || null,
  };
}

function orders(c, positions) {
  const [scanDate, rows] = signals(c);
  if (!scanDate) return null;
  const m = c.core.market || {};
  const session = E.sessionsAfter(scanDate, 1);
  const items = [], holds = [], skipped = [];
  for (const p of positions) {
    const sym = p.symbol, st = p.status;
    const base = { symbol: sym, trade_id: p.id, shares: p.shares };
    if (st === 'ADJUST') {
      const d = p.adjust.describe;
      items.push({ ...base, key: `adjust:${sym}`, kind: 'adjust', title: `Update ${sym} for its bonus shares`,
        detail: `${d.charAt(0).toUpperCase()}${d.slice(1)}, from ${E.niceDate(p.adjust.ex_date)}. `
          + "On My Portfolio, enter the shares you hold now. Its stop can't be checked until then." });
    } else if (st === 'EXIT') {
      items.push({ ...base, key: `sell:${sym}`, kind: 'sell', title: `Sell all ${E.int(p.shares)} ${sym} at the open`,
        detail: p.reason });
    } else if (st === 'TIGHTEN STOP') {
      items.push({ ...base, key: `stop:${sym}`, kind: 'stop', from: p.prev_stop, to: p.stop,
        title: `Move your ${sym} stop up to ${E.px(p.stop)}`,
        detail: `It was ${E.px(p.prev_stop)}. Sell if the price falls to ${E.px(p.stop)}.` });
    } else if (st === 'REVIEW') {
      items.push({ ...base, key: `review:${sym}`, kind: 'review', title: `Decide on ${sym}: day ${p.day} without progress`,
        detail: p.reason });
    } else if (st === 'HOLD') {
      holds.push({ symbol: sym, stop: p.stop, target: p.target, day: p.day });
    }
  }
  // A position whose stock goes ex-dividend at the next session: lower the stop first (views.exdiv_item).
  const coming = c.core.dividends_coming || {};
  for (const p of positions) {
    const div = coming[p.symbol];
    if (div && div.ex_date === session && div.amount && ['HOLD', 'TIGHTEN STOP', 'REVIEW'].includes(p.status)) {
      const amount = +div.amount, to = p.stop - amount;
      items.push({ symbol: p.symbol, trade_id: p.id, shares: p.shares, key: `exdiv:${p.symbol}`, kind: 'stop',
        from: p.stop, to, title: `Lower your ${p.symbol} stop to ${E.px(to)} before the open`,
        detail: `${p.symbol} goes ex-dividend: the price opens about ${E.g(amount)} EGP lower, and you get `
          + `${E.g(amount)} EGP a share (${E.int(amount * p.shares)} EGP). The agent moves the stop and the target `
          + "down by the same amount, so the drop alone doesn't sell." });
    }
  }
  for (const r of rows.filter(x => x.action === 'BUY')) {
    if (r.shares > 0) {
      items.push({
        symbol: r.symbol, key: `buy:${r.symbol}`, kind: 'buy', info: info(c, r.symbol), shares: r.shares,
        limit: r.entry_high, stop: r.stop, target: r.target, amount: r.amount, risk_egp: r.risk_egp,
        source: r.source || 'rules',
        title: `Buy ${E.int(r.shares)} ${r.symbol}, paying no more than ${E.px(r.entry_high)}`,
        detail: `Use a limit order; skip it if it opens higher. Once filled: stop ${E.px(r.stop)}, `
          + `target ${E.px(r.target)}, max loss ${E.int(r.risk_egp)} EGP.`,
      });
    } else skipped.push({ symbol: r.symbol, note: r.size_note });
  }
  const rank = { adjust: 0, sell: 1, stop: 2, review: 3, buy: 4 };
  items.sort((a, b) => rank[a.kind] - rank[b.kind]);
  const done = c.book.checklist[session] || {};
  for (const it of items) it.done = it.key in done;
  return {
    session, scan_date: scanDate, items, holds, skipped, blocked: !!(m.risk_off && c.cfg.riskoff_block_buys),
    stale: session <= E.expectedSessionDate(),
  };
}

async function today(c) {
  const { cfg, core } = c;
  const [scanDate, rows] = signals(c);
  const preds = core.predictions;
  const buys = [], watch = [];
  const warn = core.cautions || {};
  for (const x of rows) {
    const r = { ...x, info: info(c, x.symbol), pred: preds.by_symbol[x.symbol] ?? null, cautions: warn[x.symbol] || [],
      co: (core.company || {})[x.symbol] || null };
    if (r.action === 'BUY') {
      delete r.trigger; delete r.to_trigger;
      r.sell_by = E.sessionsAfter(scanDate, cfg.max_hold_days);
      buys.push(r);
    } else if (E.passesFilter(r.info, cfg.shariah_filter)) watch.push(r);   // close to a BUY: only what your filter allows
  }
  const positions = (await openPositions(c)).map(p => ({ ...p, cautions: warn[p.symbol] || [] }));
  const early = core.final === false
    ? ["These signals use prices from during today's session. The site scans again after the close, from about 4 pm."] : [];
  return {
    market: core.market ? { ...core.market, buys: buys.length, warnings: [...early, ...(core.market.warnings || [])] } : null,
    scan_date: scanDate, buys, watch, positions,
    spark: core.spark, orders: orders(c, positions), breadth: core.breadth_today, paper: null,
    model: Object.keys(preds.by_symbol).length ? { base: preds.base, count: preds.count, date: preds.date } : null,
    cfg: Object.fromEntries(['max_hold_days', 'review_day', 'riskoff_block_buys', 'buy_score',
      'shariah_filter', 'fee_pct_per_side'].map(k => [k, cfg[k]])),
    record: core.record || null, odds: core.odds || null,
  };
}

async function stockDetail(c, symbol) {
  const sym = symbol.toUpperCase();
  const page = await load(`stock/${sym}`);
  const out = page ? { ...page, info: info(c, sym) } : {
    symbol: sym, info: info(c, sym), known: c.stocks.has(sym),
    hold: { max: c.cfg.max_hold_days, review: c.cfg.review_day }, has_data: false,
    message: (c.stocks.get(sym) || {}).price_note || 'No price data for this symbol yet.',
  };
  if (!out.has_data) return out;
  const [, rows] = signals(c);
  const row = rows.find(r => r.symbol === sym);
  const ch = out.chart;
  let levels = ch ? [{ label: 'Stop', price: ch.stop, kind: 'stop' }, { label: 'Target', price: ch.target, kind: 'target' }] : [];
  if (row) {
    out.signal = row;
    delete out.checklist;
    if (row.action === 'BUY') {
      levels = [{ label: 'Buy up to', price: row.entry_high, kind: 'entry' },
        { label: 'Stop', price: row.stop, kind: 'stop' }, { label: 'Target', price: row.target, kind: 'target' }];
    }
  }
  const pos = await openPositions(c, sym);
  if (pos.length) {
    out.position = pos[0];
    levels = [{ label: 'Avg price', price: pos[0].avg_price, kind: 'entry' },
      { label: 'Stop', price: pos[0].stop, kind: 'stop' }, { label: 'Target', price: pos[0].target, kind: 'target' }];
  }
  out.levels = levels;
  out.telegram = c.core.telegram || null;     // the site's bot: /watch SYMBOL levels (app/alerts.py)
  const real = new Set(c.book.trades.filter(t => t.account === 'real').map(t => t.id));
  const groups = new Map();
  for (const f of c.book.fills) {
    if (!real.has(f.trade_id) || f.symbol !== sym || !['buy', 'sell'].includes(f.side)) continue;
    const k = `${f.date}|${f.side}`;
    const gr = groups.get(k) || { date: f.date, side: f.side, shares: 0, total: 0, n: 0 };
    gr.shares += f.shares; gr.total += f.price; gr.n += 1;
    groups.set(k, gr);
  }
  out.fills = [...groups.values()].map(x => ({ date: x.date, side: x.side, shares: x.shares, price: x.total / x.n }));
  return out;
}

async function portfolioView(c) {
  const { book, cfg } = c;
  const s = E.accountSummary(book, 'real', cfg, closes(c), c.core.events);
  const divs = E.dividendsByTrade(book, 'real');
  let rows = [], stats = { count: 0 };
  const closed = E.trades(book, 'real', ['closed']).map(t => {
    const dividends = divs[t.id] || 0;
    const pnl = (t.exit_price - t.entry_price) * t.shares - (t.fees || 0) + dividends;
    return { ...t, dividends, pnl, return_pct: pnl / (t.entry_price * t.shares) };
  });
  if (closed.length) {
    closed.sort((a, b) => (a.exit_date < b.exit_date ? 1 : a.exit_date > b.exit_date ? -1 : b.id - a.id));
    rows = closed.map(t => Object.fromEntries(['id', 'symbol', 'entry_date', 'entry_price', 'exit_date', 'exit_price',
      'shares', 'pnl', 'return_pct', 'exit_reason', 'notes'].map(k => [k, t[k] ?? null])));
    stats = { count: closed.length, win_rate: closed.filter(t => t.pnl > 0).length / closed.length,
      total: closed.reduce((a, t) => a + t.pnl, 0) };
  }
  const [, sig] = signals(c);
  return {
    summary: s, positions: await openPositions(c), closed: rows, closed_stats: stats,
    signals: sig.filter(r => r.action === 'BUY').map(r => ({ symbol: r.symbol, entry_high: r.entry_high, shares: r.shares })),
    fee_pct: cfg.fee_pct_per_side, sell_reasons: c.core.sell_reasons, max_hold_days: cfg.max_hold_days,
    review_day: cfg.review_day, max_open_risk_pct: cfg.max_open_risk_pct,
    limits: Object.fromEntries(['max_position_pct', 'max_positions', 'max_per_sector', 'max_open_risk_pct'].map(k => [k, cfg[k]])),
    nothing_saved: !book.trades.some(t => t.account === 'real'),
  };
}

// The model's ranking, with only the stocks your Shariah filter allows (their rank stays the model's).
async function predictView(c) {
  const out = await load('predict');
  if (out && out.model) {
    const [, rows] = signals(c);
    const action = Object.fromEntries(rows.map(r => [r.symbol, r.action]));
    const held = new Set(E.trades(c.book, 'real', ['open']).map(t => t.symbol));
    return { ...out, shariah_filter: c.cfg.shariah_filter,
      rows: out.rows.filter(r => E.passesFilter(r.info || info(c, r.symbol), c.cfg.shariah_filter))
        .map(r => ({ ...r, action: action[r.symbol] ?? null, held: held.has(r.symbol) })) };
  }
  return out && { ...out, shariah_filter: c.cfg.shariah_filter };
}

// The dividend calendar (views.dividends_view): everyone's dividends, plus which of them you hold.
async function dividendsView(c) {
  const out = (await load('dividends').catch(() => null))
    || { today: null, dividends: [], yields: [], bonus: [], coming: [], min_value: c.cfg.min_avg_value_egp };
  return { ...out, held: [...new Set(E.trades(c.book, 'real', ['open']).map(t => t.symbol))].sort() };
}

// The News page (views.news_view): everyone's headlines and coming dividends, plus your stocks.
async function newsView(c) {
  const out = (await load('news').catch(() => null))
    || { today: null, items: [], coming: [], announced: [], sources: {}, tags: [] };
  return { ...out, held: [...new Set(E.trades(c.book, 'real', ['open']).map(t => t.symbol))].sort(),
    watchlist: c.book.watchlist || [] };
}

// The screener (views.screener_view): everyone's numbers, plus your Shariah filter's signals and what you hold.
async function screenerView(c) {
  const out = await load('screener');
  if (!out) return { date: null, min_value: c.cfg.min_avg_value_egp, rows: [] };
  const [, rows] = signals(c);
  const action = Object.fromEntries(rows.map(r => [r.symbol, r.action]));
  const held = new Set(E.trades(c.book, 'real', ['open']).map(t => t.symbol));
  return { ...out, rows: out.rows.map(r => ({ ...r, action: action[r.symbol] ?? null, held: held.has(r.symbol) })) };
}

// My Portfolio's Health and Journal tabs (views.portfolio_history): your fills and dividends from this browser, the
// published prices of the stocks you've held, and the shared history (past BUY signals, inflation).
async function historyView(c) {
  const real = new Set(c.book.trades.filter(t => t.account === 'real').map(t => t.id));
  const fills = c.book.fills.filter(f => real.has(f.trade_id))
    .map(f => ({ date: f.date, symbol: f.symbol, side: f.side, shares: f.shares, price: f.price, fees: f.fees || 0 }));
  const dividends = c.book.dividends.filter(x => real.has(x.trade_id)).map(x => ({ date: x.date, amount: x.amount }));
  const symbols = [...new Set(fills.map(f => f.symbol))];
  const pages = await Promise.all(symbols.map(s => load(`stock/${s}`).catch(() => null)));
  const series = {};
  symbols.forEach((s, i) => { if (pages[i] && pages[i].series) series[s] = { time: pages[i].series.time, close: pages[i].series.close }; });
  const shared = (await load('history').catch(() => null)) || { buys: [], inflation: [] };
  const pending = Object.values(E.pending(c.book, c.core.events, 'real'))
    .map(e => ({ symbol: e.symbol, ex_date: e.ex_date, factor: e.factor }));
  return { start: +c.cfg.capital, fills, dividends, pending, events: c.core.events.filter(e => symbols.includes(e.symbol)),
    series, index: fills.length ? c.core.index : null, ...shared };
}

// The stocks you starred (views.save_watchlist), kept in this browser with your portfolio and in its backups.
function saveWatchlist(c, body) {
  const known = new Set(c.core.stocks.map(s => s.symbol));
  const out = [...new Set((body.symbols || []).map(s => String(s).trim().toUpperCase()))].filter(s => known.has(s)).slice(0, 100);
  c.book.watchlist = out;
  saveBook(c.book);
  return { symbols: out };
}

// The size calculator's side (views.calc_view): your account, your limits and the market's state.
const CALC_KEYS = ['capital', 'risk_per_trade_pct', 'max_position_pct', 'max_open_risk_pct', 'max_positions',
  'max_per_sector', 'max_pct_of_adv', 'fee_pct_per_side', 'target_r', 'stop_min_pct', 'stop_max_pct'];
function calcView(c) {
  const real = E.accountSummary(c.book, 'real', c.cfg, closes(c), c.core.events);
  const b = c.core.breadth_today;
  return {
    equity: real.equity, cash: real.cash, positions: E.positionsForAllocation(c.book, 'real', ['open']),
    cfg: Object.fromEntries(CALC_KEYS.map(k => [k, c.cfg[k]])),
    risk_off: !!(c.core.market && c.core.market.risk_off), switch: (b && b.switch) || null,
    money: c.core.money || null, shares_value: real.equity - real.cash,
  };
}

function settingsView(c) {
  const keys = c.core.sections.flatMap(s => s.fields.map(f => f.key));
  return {
    values: Object.fromEntries(keys.map(k => [k, c.cfg[k]])),
    defaults: Object.fromEntries(keys.map(k => [k, c.core.personal_defaults[k]])),
    sections: c.core.sections, multi_user: true, is_admin: false, static: true, data: c.core.data_status,
    telegram: c.core.telegram || null, scan_url: c.core.scan_url || null,
  };
}

// views.parse_settings, for your own numbers.
export function parseSettings(values, current, sections) {
  const next = { ...current }, errors = {};
  for (const f of sections.flatMap(s => s.fields)) {
    if (!(f.key in values)) continue;
    const v = values[f.key];
    if (f.kind === 'float' || f.kind === 'int') {
      const n = v === null || v === '' ? NaN : Number(v) / (f.scale || 1);
      if (Number.isNaN(n)) { errors[f.key] = "This value isn't valid."; continue; }
      if (!Number.isFinite(n) || n < f.min || n > f.max) {
        errors[f.key] = `Enter a number between ${E.g(f.min)} and ${E.g(f.max)}.`;
        continue;
      }
      const scaled = n * (f.scale || 1);
      next[f.key] = f.kind === 'int' ? Math.round(scaled) : scaled;
    } else if (f.kind === 'select') {
      if (!f.options.some(o => o.value === v)) errors[f.key] = 'Pick one of the options.';
      else next[f.key] = v;
    } else if (f.kind === 'toggle' || f.kind === 'choice') next[f.key] = !!v;
  }
  return [next, errors];
}

// ------------------------------------------------------------------ changes you make (app/server.py)
const toNum = (v, what, { min = 0, strict = true, integer = false } = {}) => {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n) || (strict ? n <= min : n < min) || (integer && !Number.isInteger(n))) {
    fail(422, `${what}: enter a valid number.`);
  }
  return n;
};
const toDay = (v, what = 'date') => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) || Number.isNaN(Date.parse(v))) fail(422, `${what}: enter a valid date.`);
  return v;
};

function atrOn(bars, day) {
  const hist = bars.filter(b => b.date <= day);
  const use = hist.length ? hist : bars;
  return use.length ? use[use.length - 1].atr14 : NaN;
}

async function buy(c, body) {
  const sym = String(body.symbol || '').trim().toUpperCase();
  if (!sym || sym.length > 20) fail(422, 'symbol: enter a symbol.');
  const date = toDay(body.date);
  const price = toNum(body.price, 'price');
  const shares = toNum(body.shares, 'shares', { min: 1, strict: false, integer: true });
  const stop = body.stop === null || body.stop === undefined || body.stop === '' ? null : toNum(body.stop, 'stop', { strict: false });
  if (!c.stocks.has(sym)) fail(400, `${sym} isn't an EGX stock the agent knows.`);
  if (stop && stop >= price) fail(400, 'The stop-loss must be below the price you paid.');
  const bars = (await barsFor(c, [sym]))[sym];
  const atr = bars.length ? atrOn(bars, date) : NaN;
  if (!Number.isFinite(atr) && !stop) {
    fail(400, "There's no price history for this stock, so the automatic stop can't be calculated. Enter a stop-loss.");
  }
  const had = !!E.openPosition(c.book, 'real', sym);
  // The chart's stop (under support) and target on the buy date, or the last session before it.
  const day = bars.filter(b => b.date <= date).at(-1);
  const chart = c.cfg.levels_mode === 'chart' && day && Number.isFinite(day.ptgt) ? { stop: day.sup, target: day.ptgt } : null;
  E.addRealBuy(c.book, c.cfg, sym, date, price, shares, atr, info(c, sym).sector || '', stop || null,
    String(body.notes || '').trim().slice(0, 500), chart);
  saveBook(c.book);
  const pos = E.openPosition(c.book, 'real', sym);
  const message = had
    ? `Added ${E.int(shares)} ${sym} to your position: now ${E.int(pos.shares)} shares at an average of `
      + `${pos.entry_price.toFixed(3)}. New stop ${E.f2(pos.stop)}, target ${E.f2(pos.target)}.`
    : `Saved: ${E.int(shares)} ${sym} at ${E.f2(price)}. Stop ${E.f2(pos.stop)}, target ${E.f2(pos.target)}.`;
  return { message, trade_id: pos.id };
}

function sell(c, body) {
  const id = Number(body.trade_id);
  const date = toDay(body.date);
  const price = toNum(body.price, 'price');
  const shares = toNum(body.shares, 'shares', { min: 1, strict: false, integer: true });
  const reason = String(body.reason || 'Other / my decision').slice(0, 100);
  const pos = c.book.trades.find(t => t.id === id && t.account === 'real' && t.status === 'open');
  if (!pos) fail(404, 'This position is no longer open. Refresh the page.');
  if (shares > pos.shares) fail(400, `You hold ${E.int(pos.shares)} shares, so you can't sell ${E.int(shares)}.`);
  const fee = c.cfg.fee_pct_per_side / 100;
  const pnl = (price - pos.entry_price) * shares - (pos.fees || 0) * shares / pos.shares - price * shares * fee;
  const before = { symbol: pos.symbol, shares: pos.shares, avg: pos.entry_price };
  let result;
  try {
    result = E.sellReal(c.book, c.cfg, id, date, price, shares, reason);
  } catch (e) {
    fail(400, e.message);
  }
  saveBook(c.book);
  const left = before.shares - shares;
  const signed = `${pnl >= 0 ? '+' : '-'}${E.int(Math.abs(pnl))}`;
  const message = `Sold ${E.int(shares)} ${before.symbol} at ${E.f2(price)} (P&L after fees ${signed} EGP). `
    + (result === 'partial' ? `${E.int(left)} shares still open at an average of ${before.avg.toFixed(3)}.` : 'Position closed.');
  return { message, result, pnl };
}

function adjust(c, id, body) {
  const pos = c.book.trades.find(t => t.id === id && t.account === 'real' && t.status === 'open');
  const ev = E.pending(c.book, c.core.events, 'real')[id];
  if (!pos || !ev || ev.event_id !== body.event_id) fail(409, 'This position was already updated. Refresh the page.');
  if (body.ignore) {
    E.ignoreEvent(c.book, id, ev.event_id, localToday());
    saveBook(c.book);
    return { message: `Kept your ${pos.symbol} position as it is (${E.int(pos.shares)} shares).` };
  }
  const shares = Number(body.shares);
  if (!shares) fail(400, 'Enter how many shares you hold now.');
  const expected = pos.shares * ev.factor;
  if (!(shares >= 0.75 * expected && shares <= 1.25 * expected)) {
    fail(400, `${E.int(shares)} shares is far from the expected ${E.int(ev.shares_expected)}. Check the number at your `
      + "broker. If your shares didn't change, choose 'My shares didn't change'.");
  }
  const res = E.applyEvent(c.book, id, c.core.events.find(e => e.id === ev.event_id), shares, localToday());
  saveBook(c.book);
  return { message: `Updated ${res.symbol}: ${E.int(res.old)} → ${E.int(res.new)} shares at an average of `
    + `${res.avg.toFixed(3)}. The stop and target moved by the same ratio.` };
}

const money2 = v => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function dividend(c, id, body) {
  const date = toDay(body.date);
  const amount = toNum(body.amount, 'amount');
  let res;
  try {
    res = E.addDividend(c.book, id, date, amount, String(body.note || '').trim().slice(0, 200));
  } catch (e) {
    fail(400, e.message);
  }
  saveBook(c.book);
  return { message: `Recorded a ${money2(amount)} EGP dividend on ${res.symbol} (${res.per_share.toFixed(3)} per share). `
    + 'It now counts in your P&L.' };
}

function deleteDividend(c, id) {
  const row = c.book.dividends.find(d => d.id === id);
  if (!row) fail(404, 'Dividend not found.');
  c.book.dividends = c.book.dividends.filter(d => d.id !== id);
  saveBook(c.book);
  return { message: `Removed the ${money2(row.amount)} EGP ${row.symbol} dividend.` };
}

function deletePosition(c, id) {
  const row = c.book.trades.find(t => t.id === id && t.account === 'real' && t.status === 'open');
  if (!row) fail(404, 'Position not found.');
  E.deleteTrade(c.book, id);
  saveBook(c.book);
  return { message: `Deleted the ${row.symbol} position and its transactions.` };
}

function saveSettings(c, values) {
  const [next, errors] = parseSettings(values || {}, c.cfg, c.core.sections);
  if (Object.keys(errors).length) fail(400, 'Some settings need fixing.', { errors });
  for (const k of Object.keys(c.core.personal_defaults)) {
    if (k in next && next[k] !== c.cfg[k]) c.book.settings[k] = next[k];
  }
  saveBook(c.book);
  return { message: 'Settings saved. Your BUY signals and share counts use them from now on.', values: next };
}

function resetSettings(c) {
  c.book.settings = Object.fromEntries(Object.entries(c.book.settings).filter(([k]) => KEEP_ON_RESET.includes(k)));
  saveBook(c.book);
  return { message: 'Your settings are back to the defaults (your capital and fees were kept).' };
}

function checkItem(c, body) {
  const session = toDay(body.session, 'session');
  const item = String(body.item || '').slice(0, 60);
  if (!item) fail(422, 'item: missing.');
  const done = { ...(c.book.checklist[session] || {}) };
  if (body.done) done[item] = new Date().toISOString().slice(0, 19);
  else delete done[item];
  // the last 30 sessions are plenty
  c.book.checklist = Object.fromEntries(Object.entries({ ...c.book.checklist, [session]: done })
    .sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 30));
  saveBook(c.book);
  return { ok: true };
}

// ------------------------------------------------------------------ routing
export const ME = {
  multi_user: false, static: true,
  user: { id: 0, username: 'you', display_name: 'You', is_admin: false, accepted_terms: true },
};

// ------------------------------------------------------------------ your portfolio in Telegram (worker/bot.js)
// Once linked (the Connect Telegram button, a /link code typed in Settings, or opening the site inside Telegram), this
// browser sends the bot a copy of your portfolio after every change and once a day when the site opens: a summary for
// /portfolio, and the whole record, which the site's run checks with the exit rules after each close and your other
// devices bring back. The newest change wins: a device holding an older copy takes the newer one. The link is kept
// only in this browser.
const BOT_LINK = 'egx-bot-link';
const WAIT_DAYS = 2;        // a Connect link that nobody pressed Start on in Telegram by then is dropped

export function botLink() {
  try { return JSON.parse(localStorage.getItem(BOT_LINK) || 'null'); } catch { return null; }
}
function setLink(v) {
  try { if (v) localStorage.setItem(BOT_LINK, JSON.stringify(v)); else localStorage.removeItem(BOT_LINK); } catch { /* */ }
}
// 'linked', 'waiting' (Connect pressed, Start not yet), or null
export function botStatus() {
  const link = botLink();
  return !link ? null : link.pending ? 'waiting' : 'linked';
}

async function botPost(url, path, body) {
  const res = await fetch(url.replace(/\/$/, '') + path, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.error || `The bot didn't answer (${res.status}).`), { status: res.status });
  return out;
}

const changedOf = book => (book.meta && book.meta.changed) || '';
const hasAnything = book => book.trades.length > 0 || (book.watchlist || []).length > 0;

// The bot's copy, brought here when it's newer than this browser's (or this browser has nothing yet). True if it was.
async function pullBook(link, force = false) {
  const got = await botPost(link.url, '/restore', { token: link.token });
  if (!got.book || !validBook(got.book)) return false;
  const local = loadBook();
  if (!force && hasAnything(local) && changedOf(local) >= (got.changed || '')) return false;
  saveBook({ ...emptyBook(), ...got.book, meta: { ...(got.book.meta || {}), changed: got.changed || '' } }, true);
  window.dispatchEvent(new CustomEvent('egx-book'));        // the page shows the new portfolio (main.js)
  return true;
}

async function sendBook(c) {
  const link = botLink();
  if (!link) return;
  try {
    if (!link.synced) {                       // newly linked: a portfolio on another device comes here first
      if (await pullBook(link)) c = await context();
    }
    const pv = await portfolioView(c);
    const book = { date: c.core.scan_date, start: pv.summary.start, cash: pv.summary.cash, closed: pv.closed_stats,
      watchlist: c.book.watchlist || [],
      positions: pv.positions.map(p => ({ symbol: p.symbol, shares: p.shares, avg: p.avg_price, last: p.last, stop: p.stop,
        target: p.target, status: p.status, reason: p.reason || '' })) };
    await botPost(link.url, '/book', { token: link.token, book, full: c.book, changed: changedOf(c.book) });
    setLink({ url: link.url, token: link.token, synced: true, sent: c.core.scan_date });
  } catch (err) {
    if (err.status === 409) {                 // another device changed it since: take that one
      await pullBook(link, true).catch(() => null);
      setLink({ url: link.url, token: link.token, synced: true, sent: c.core.scan_date });
    } else if (err.status === 401 && !(link.pending && Date.now() - link.pending < WAIT_DAYS * 86400000)) {
      setLink(null);                          // unlinked in Telegram (or Start never pressed)
    }
  }
}

// The Connect Telegram button: its link carries a one-time code for this browser after the site's own code, so
// pressing Start in Telegram connects the messages and links this portfolio in one go. arm() on the tap.
export function connectLink(telegram) {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  return { href: telegram.link + (telegram.worker ? nonce : ''),
    arm: () => { if (telegram.worker) setLink({ url: telegram.worker, token: nonce, pending: Date.now() }); } };
}

export async function linkBot(code) {
  const c = await context();
  const url = c.core.telegram && c.core.telegram.worker;
  if (!url) throw new Error("The site's bot can't answer about portfolios yet.");
  const { token } = await botPost(url, '/pair', { code });
  setLink({ url, token });
  await sendBook(c);
}

export async function unlinkBot() {
  const link = botLink();
  setLink(null);
  if (link) await botPost(link.url, '/unpair', { token: link.token }).catch(() => null);
}

// "Bring my portfolio from Telegram": replaces this browser's with the bot's copy. False if the bot has none.
export async function restoreFromBot() {
  const link = botLink();
  if (!link || link.pending) throw new Error('Link this browser to the bot first.');
  const done = await pullBook(link, true);
  if (done) setLink({ ...link, synced: true });
  return done;
}

export const syncNow = () => context().then(sendBook);

// "Add from a screenshot": the bot's free AI reads the holdings off a picture of your broker's portfolio screen
// (worker/bot.js read). {holdings: [{symbol, name, shares, avg_price, last}]}; the picture isn't kept.
export async function readScreenshot(image) {
  const link = botLink();
  if (!link || link.pending) throw new Error('Connect Telegram first (Settings → Connect Telegram): the bot reads the picture.');
  return botPost(link.url, '/read', { token: link.token, image });
}

let syncing = null, again = false, checked = false;

// In the background, so the page doesn't wait: after a change (force), when the site has a newer close, and once
// each time the site opens (a newer copy from another device comes here).
function syncBot(force) {
  const link = botLink();
  if (!link) return;
  if (syncing) { again = again || force; return; }
  const first = !checked && link.synced;
  checked = true;
  syncing = context().then(async c => {
    if (first && await pullBook(link)) return;
    if (force || link.pending || c.core.scan_date !== link.sent) await sendBook(c);
  }).catch(() => null).finally(() => { syncing = null; if (again) { again = false; syncBot(true); } });
}

// Live prices for your positions: the site's bot asks TradingView's screener (worker/bot.js /quotes), about 15 minutes
// late. {} when the site has no bot or it can't be reached: the page then shows the last close.
async function quotes(c, path) {
  const url = c.core.telegram && c.core.telegram.worker;
  const s = new URLSearchParams(path.split('?')[1] || '').get('s');
  if (!url || !s) return {};
  const res = await fetch(`${url.replace(/\/$/, '')}/quotes?s=${encodeURIComponent(s)}`).catch(() => null);
  return res && res.ok ? res.json().catch(() => ({})) : {};
}

export async function localApi(path, opts = {}) {
  const out = await route(path, opts);
  syncBot((opts.method || 'GET') !== 'GET');
  return out;
}

async function route(path, { method = 'GET', body } = {}) {
  const [route] = path.split('?');
  const [a, b, x] = route.split('/').filter(Boolean);
  if (method === 'GET' && a === 'me') return ME;
  if (method === 'GET' && a === 'health') return { ok: true, app: 'egx-trading-agent' };
  if (method === 'GET' && a === 'jobs') return { job: null };
  const c = await context();
  if (method === 'GET') {
    switch (a) {
      case 'status': return status(c, await openPositions(c));
      case 'stocks': return c.core.stocks;
      case 'today': return today(c);
      case 'stock': return x === 'intraday' ? load(`intraday/${decodeURIComponent(b || '').toUpperCase()}`).catch(() => ({}))
        : stockDetail(c, decodeURIComponent(b || ''));
      case 'portfolio': return b === 'history' ? historyView(c) : portfolioView(c);
      case 'calc': return calcView(c);
      case 'screener': return screenerView(c);
      case 'dividends': return dividendsView(c);
      case 'news': return newsView(c);
      case 'watchlist': return { symbols: c.book.watchlist || [] };
      case 'market': return load('market');
      case 'predict': return predictView(c);
      case 'quotes': return quotes(c, path);
      case 'settings': return settingsView(c);
      case 'alerts': return { telegram: { connected: false, token_set: false, can_set_bot: false }, static: true };
      default: break;
    }
  }
  const id = Number(b);
  if (method === 'PUT' && a === 'orders' && b === 'check') return checkItem(c, body || {});
  if (method === 'POST' && a === 'portfolio' && b === 'buy') return buy(c, body || {});
  if (method === 'POST' && a === 'portfolio' && b === 'sell') return sell(c, body || {});
  if (method === 'POST' && a === 'portfolio' && x === 'adjust') return adjust(c, id, body || {});
  if (method === 'POST' && a === 'portfolio' && x === 'dividend') return dividend(c, id, body || {});
  if (method === 'DELETE' && a === 'portfolio' && b && !x) return deletePosition(c, id);
  if (method === 'DELETE' && a === 'dividends') return deleteDividend(c, id);
  if (method === 'PUT' && a === 'settings') return saveSettings(c, body);
  if (method === 'PUT' && a === 'watchlist') return saveWatchlist(c, body || {});
  if (method === 'POST' && a === 'settings' && b === 'defaults') return resetSettings(c);
  return fail(404, "That isn't available on this site. Scans run by themselves after every close.");
}
