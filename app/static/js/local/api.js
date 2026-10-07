// The GitHub Pages site has no server: this answers the dashboard's /api/... requests in the browser, with the same
// shapes app/views.py and app/server.py give on your Mac. The shared parts come from the scan's published files;
// your portfolio and settings come from this browser (site.js). Paper trading and the backtest are only on the Mac.
import * as E from './engine.js';
import { load, loadBook, saveBook, validBook, emptyBook } from './site.js';

export class LocalError extends Error {
  constructor(message, status = 400, detail = null) { super(message); this.status = status; this.detail = detail ?? { message }; }
}
const fail = (status, message, extra) => { throw new LocalError(message, status, { message, ...extra }); };

const STATUS_ORDER = { ADJUST: 0, EXIT: 1, BOUNCE: 2, REVIEW: 3, 'TIGHTEN STOP': 4, HOLD: 5, 'NO DATA': 6 };
const ACTION_STATUSES = ['ADJUST', 'EXIT', 'BOUNCE', 'REVIEW', 'TIGHTEN STOP'];
const KEEP_ON_RESET = ['capital', 'broker', 'fee_pct_per_side'];

const localToday = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

// ------------------------------------------------------------------ one request's context
async function context() {
  const core = await load('core');
  E.setHolidays(core.holidays);
  const book = loadBook();
  const cfg = { ...core.strategy, ...core.personal_defaults };
  for (const [k, v] of Object.entries(book.settings || {})) if (k in core.personal_defaults) cfg[k] = v;
  // set your own fee % before the broker choice came: keep it
  if (book.settings && 'fee_pct_per_side' in book.settings && !('broker' in book.settings)) cfg.broker = 'other';
  const plan = cfg.broker === 'thndr_trader' && book.plan;
  const due = plan ? E.planRenewals(plan, plan.paid_to || plan.added, localToday()) : [];
  if (due.length) {          // Thndr Trader renewed since you last looked: its price came out of your wallet
    book.cash = [...(book.cash || []), ...due.map(date => ({ id: E.nextId(book), date, kind: 'fee', amount: plan.price,
      fee: 0, note: 'Thndr Trader plan' }))];
    plan.paid_to = due.at(-1);
    saveBook(book);
  }
  return { core, book, cfg, stocks: new Map(core.stocks.map(s => [s.symbol, s])), bars: {} };
}

// Your fees on an order that day: with Thndr Trader, Thndr's commission stays on one after the plan month's 50 free
// ones (engine.js planFree). skip: the transaction being changed, which doesn't count against itself.
const feeCfg = (c, day, skip = null) => (c.cfg.broker === 'thndr_trader' && c.book.plan
  ? { ...c.cfg, free_trade: E.planFree(c.book, c.book.plan, day, skip) } : c.cfg);

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
        close: E.num(s.close[i]), atr14: E.num(s.atr14[i]), ema20: E.num(s.ema20[i]), ema50: E.num(s.ema50[i]), div: divs[s.time[i]] || 0,
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
  const pend = E.pending(book, core.events, 'real');
  const divs = E.dividendsByTrade(book, 'real');
  const open = E.trades(book, 'real', ['open']).filter(t => !symbol || t.symbol === symbol);
  const bars = await barsFor(c, open.map(t => t.symbol));
  // a big loss's averaging-down rule: only when the stock earns a buy on its own (a BUY signal or a top-10% rating)
  const buys = new Set(signals(c)[1].filter(x => x.action === 'BUY').map(x => x.symbol));
  const preds = (core.predictions && core.predictions.by_symbol) || {};
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
        reason: ev.rights   // views.adjust_reason
          ? `Rights issue from ${E.niceDate(ev.ex_date)}: past prices ÷ ${E.g(+ev.factor.toPrecision(4))}. Once you've `
            + 'subscribed or sold your rights, enter the shares you hold now so the stop and P&L stay right.'
          : `Bonus shares or split from ${E.niceDate(ev.ex_date)}: ${ev.describe}. `
            + 'Enter the shares you hold now so the stop and P&L stay right.' };
    } else {
      stt = E.realStatus(r, b, cfg);
      last = stt.last_close || r.entry_price;
    }
    const fees = r.fees || 0;
    const div = divs[r.id] || 0;
    const fills = E.fillsOf(book, r.id).map(f => ({ id: f.id, date: f.date, side: f.side, shares: f.shares,
      price: f.price, fees: f.fees, note: f.note, fees_in: !!f.fees_in }));
    for (const x of book.dividends.filter(d => d.trade_id === r.id).sort((a, b2) => (a.date < b2.date ? -1 : 1))) {
      fills.push({ id: null, dividend_id: x.id, date: x.date, side: 'dividend', shares: x.shares,
        price: x.shares ? x.amount / x.shares : null, fees: 0, amount: x.amount, note: x.note || '' });
    }
    fills.sort((a, b2) => (a.date < b2.date ? -1 : a.date > b2.date ? 1 : (a.side === 'dividend') - (b2.side === 'dividend')));
    const worth = last * factor;
    return {
      id: r.id, symbol: r.symbol, info: info(c, r.symbol), status: stt.status, reason: stt.reason,
      first_buy: r.entry_date, avg_price: r.entry_price, shares: r.shares, last, value: worth * r.shares,
      // like your broker: against what you paid with the buy fees; selling fees count once you sell
      pnl_pct: ((worth - r.entry_price) * r.shares - fees) / (r.entry_price * r.shares + fees),
      pnl: (worth - r.entry_price) * r.shares - fees + div,
      stop: stt.stop, prev_stop: stt.prev_stop ?? null, initial_stop: r.initial_stop, target: r.target, my_stop: r.my_stop ?? null,
      stops_mine: cfg.stop_moves === 'mine',
      bounce_level: stt.bounce_level ?? null, bounce_by: stt.bounce_by ?? null,
      buy_signal: buys.has(r.symbol), top_pick: !!(preds[r.symbol] && preds[r.symbol].top10),
      // how far under its 3-month high: after a 50%+ fall even the model's top ratings did worse (2026-10)
      from_high: b.length ? last / Math.max(...b.slice(-60).map(x => x.close)) - 1 : null,
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
    holidays: Object.fromEntries(Object.entries(c.core.holidays || {}).filter(([d]) => d >= localToday())),
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
    } else if (st === 'BOUNCE') {        // a big loss: sold on the first bounce (engine.js onBounce)
      items.push({ ...base, key: `bounce:${sym}`, kind: 'review', level: p.bounce_level,
        title: `Sell ${sym} on a bounce: at its first close above ${E.px(p.bounce_level)}`, detail: p.reason });
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
    spark: core.spark, orders: orders(c, positions), breadth: core.breadth_today, mood: core.mood_today || null, paper: null,
    model: Object.keys(preds.by_symbol).length ? { base: preds.base, count: preds.count, date: preds.date } : null,
    cfg: { ...Object.fromEntries(['max_hold_days', 'review_day', 'riskoff_block_buys', 'buy_score',
      'shariah_filter'].map(k => [k, cfg[k]])), fee_pct_per_side: E.feePct(cfg) },
    record: core.record || null, odds: core.odds || null,
    telegram: core.telegram || null,      // Picks' bell: the site's bot (/watch SYMBOL)
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
    out.fee_pct = E.feePct(c.cfg);
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
    rows = closed.map(t => {
      const src = sourceOf(t), main = book.trades.find(x => x.id === src);
      return { ...Object.fromEntries(['id', 'symbol', 'entry_date', 'entry_price', 'exit_date', 'exit_price',
        'shares', 'pnl', 'return_pct', 'exit_reason', 'notes'].map(k => [k, t[k] ?? null])),
      source_id: src, source_open: !!main && main.status === 'open',
      fills: E.fillsOf(book, src).map(f => ({ id: f.id, date: f.date, side: f.side, shares: f.shares, price: f.price,
        fees: f.fees, note: f.note })) };
    });
    stats = { count: closed.length, win_rate: closed.filter(t => t.pnl > 0).length / closed.length,
      total: closed.reduce((a, t) => a + t.pnl, 0) };
  }
  const [, sig] = signals(c);
  return {
    summary: s, wallet: walletView(c, s), positions: await openPositions(c), closed: rows, closed_stats: stats,
    signals: sig.filter(r => r.action === 'BUY').map(r => ({ symbol: r.symbol, entry_high: r.entry_high, shares: r.shares })),
    fee_pct: E.feePct(cfg), fee_cfg: { broker: cfg.broker, fee_pct_per_side: cfg.fee_pct_per_side,
      free_trade: feeCfg(c, localToday()).free_trade },
    sell_reasons: c.core.sell_reasons, max_hold_days: cfg.max_hold_days,
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
  const moves = (c.book.cash || []).map(m => ({ date: m.date, cash: E.walletEffect(m), flow: E.walletFlow(m) }));
  const symbols = [...new Set(fills.map(f => f.symbol))];
  const pages = await Promise.all(symbols.map(s => load(`stock/${s}`).catch(() => null)));
  const series = {};
  symbols.forEach((s, i) => { if (pages[i] && pages[i].series) series[s] = { time: pages[i].series.time, close: pages[i].series.close }; });
  const shared = (await load('history').catch(() => null)) || { buys: [], inflation: [] };
  const pending = Object.values(E.pending(c.book, c.core.events, 'real'))
    .map(e => ({ symbol: e.symbol, ex_date: e.ex_date, factor: e.factor }));
  return { start: +c.cfg.capital, fills, dividends, moves, pending, events: c.core.events.filter(e => symbols.includes(e.symbol)),
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
  'max_per_sector', 'max_pct_of_adv', 'broker', 'fee_pct_per_side', 'target_r', 'stop_min_pct', 'stop_max_pct'];
// Your buy and sell orders in the last 30 days: how many and their value (for Calculator → Thndr fees).
function orders30(book) {
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const real = new Set(book.trades.filter(t => t.account === 'real').map(t => t.id));
  const f = book.fills.filter(x => real.has(x.trade_id) && (x.side === 'buy' || x.side === 'sell') && x.date >= since);
  return { n: f.length, value: f.reduce((a, x) => a + x.shares * x.price, 0) };
}
function calcView(c) {
  const real = E.accountSummary(c.book, 'real', c.cfg, closes(c), c.core.events);
  const b = c.core.breadth_today;
  return {
    equity: real.equity, cash: real.cash, orders_30d: orders30(c.book), positions: E.positionsForAllocation(c.book, 'real', ['open']),
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
    } else if (f.kind === 'choice') {                 // one of the options as it is: true/false, or a word like 'mine'
      if (!f.options.some(o => o.value === v)) errors[f.key] = 'Pick one of the options.';
      else next[f.key] = v;
    } else if (f.kind === 'toggle') next[f.key] = !!v;
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

// The ATR and the chart's stop (under support) and target on a day, or the last session before it: what a buy's
// stop and target come from.
const marketAt = (bars, cfg) => day => {
  const d = bars.filter(b => b.date <= day).at(-1);
  return { atr: bars.length ? atrOn(bars, day) : NaN,
    chart: cfg.levels_mode === 'chart' && d && Number.isFinite(d.ptgt) ? { stop: d.sup, target: d.ptgt } : null };
};

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
  const { chart } = marketAt(bars, c.cfg)(date);
  E.addRealBuy(c.book, feeCfg(c, date), sym, date, price, shares, atr, info(c, sym).sector || '', stop || null,
    String(body.notes || '').trim().slice(0, 500), chart, !!body.fees_in);
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
  const cfg = feeCfg(c, date);
  const pnl = (price - pos.entry_price) * shares - (pos.fees || 0) * shares / pos.shares - E.orderFee(price * shares, cfg);
  const before = { symbol: pos.symbol, shares: pos.shares, avg: pos.entry_price };
  let result;
  try {
    result = E.sellReal(c.book, cfg, id, date, price, shares, reason);
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
  const shares = Number(body.shares), paid = Number(body.paid) || 0;
  if (!shares) fail(400, 'Enter how many shares you hold now.');
  // corporate.adjust_problem
  if (ev.rights) {
    if (shares < pos.shares) {
      fail(400, `You held ${E.int(pos.shares)} before the rights issue: enter those plus the new shares you subscribed `
        + 'to. Sold some? Log that sale first.');
    }
    if (shares > pos.shares && !(paid > 0)) fail(400, 'Enter what each new share cost you (the subscription price).');
  } else if (!(shares >= 0.75 * pos.shares * ev.factor && shares <= 1.25 * pos.shares * ev.factor)) {
    fail(400, `${E.int(shares)} shares is far from the expected ${E.int(ev.shares_expected)}. Check the number at your `
      + "broker. If your shares didn't change, choose 'My shares didn't change'.");
  }
  const res = E.applyEvent(c.book, id, c.core.events.find(e => e.id === ev.event_id), shares, localToday(), paid);
  saveBook(c.book);
  return { message: `Updated ${res.symbol}: ${E.int(res.old)} → ${E.int(res.new)} shares at an average of `
    + `${res.avg.toFixed(3)}. The stop and target moved with the prices.` };
}

// A stop you choose for an open position (e.g. right on a support), counted from the next session (today's before
// the open); null, or the automatic stop's own price: back to the automatic one. It must not be under the automatic
// stop, which never goes down, and must be under the last close.
async function setStop(c, id, body) {
  const pos = c.book.trades.find(t => t.id === id && t.account === 'real' && t.status === 'open');
  if (!pos) fail(404, 'This position is no longer open. Refresh the page.');
  if (body.stop === null) {
    delete pos.my_stop;
    delete pos.my_stop_from;
    saveBook(c.book);
    return { message: `${pos.symbol} is back on the automatic stop.` };
  }
  const stop = toNum(body.stop, 'stop');
  const bars = (await barsFor(c, [pos.symbol]))[pos.symbol];
  const auto = E.realStatus({ ...pos, my_stop: null }, bars, c.cfg);
  if (auto.stop != null && (stop <= auto.stop || E.px(stop) === E.px(auto.stop))) {
    if (E.px(stop) !== E.px(auto.stop)) {
      fail(400, `The automatic stop is ${E.px(auto.stop)} and a stop can't go under it. To go back to it, type `
        + `${E.px(auto.stop)} or choose Back to the automatic stop.`);
    }
    delete pos.my_stop;
    delete pos.my_stop_from;
    saveBook(c.book);
    return { message: `${pos.symbol} is back on the automatic stop, ${E.px(auto.stop)}. Move your stop order at your broker too.` };
  }
  if (auto.last_close != null && stop >= auto.last_close) {
    fail(400, `${pos.symbol} closed at ${E.f2(auto.last_close)}: the stop must be under that.`);
  }
  const from = E.stopFrom();
  Object.assign(pos, { my_stop: stop, my_stop_from: from });
  saveBook(c.book);
  return { message: `${pos.symbol} stop set to ${E.px(stop)}, from the ${E.niceDate(from, true)} session. `
    + 'Move your stop order at your broker too.' };
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

// ------------------------------------------------------------------ your wallet (engine.js walletEffect)
const THNDR_WITHDRAW_FEE = 2.5;     // EGP a bank transfer out of Thndr (Oct 2026)
const THNDR_SETTLE = { pct: 0.003, min_fee: 5, min_amount: 300 };   // Thndr's Settle now (support.thndr.app, Oct 2026)
const WALLET_KINDS = ['deposit', 'withdraw', 'fee', 'refund', 'fix', 'settle'];

// Like your broker's wallet: the balance, what can be withdrawn now, and every pound in or out, newest first.
function walletView(c, s) {
  const { book } = c;
  const real = new Set(book.trades.filter(t => t.account === 'real').map(t => t.id));
  const today = localToday();
  const wait = E.unsettled(book, today);
  const plan = c.cfg.broker === 'thndr_trader' && book.plan;
  // With Thndr Trader, an order whose fees have no commission was one of the month's free ones: like Thndr's wallet,
  // the commission shows taken with the order and given back the same day (the balance is the same either way).
  const back = f => (plan && !f.fees_in && f.date >= plan.since && (f.fees || 0) < E.governmentFees(f.shares * f.price) + 0.005
    ? E.thndrCommission(f.shares * f.price) : 0);
  const rows = [
    ...(book.cash || []).map(m => ({ id: m.id, date: m.date, kind: m.kind, amount: E.walletEffect(m), fee: m.fee || 0,
      note: m.note || '', settled: m.kind === 'settle' ? m.amount : undefined })),
    ...book.fills.filter(f => real.has(f.trade_id) && (f.side === 'buy' || f.side === 'sell')).flatMap(f => {
      const k = back(f), fee = (f.fees || 0) + k, v = f.shares * f.price;
      return [...(k ? [{ date: f.date, kind: 'kickback', symbol: f.symbol, amount: k }] : []),
        { date: f.date, kind: f.side, symbol: f.symbol, shares: f.shares, fee, amount: f.side === 'buy' ? -(v + fee) : v - fee }];
    }),
    ...book.dividends.filter(d => real.has(d.trade_id)).map(d => ({ date: d.date, kind: 'dividend', symbol: d.symbol,
      amount: d.amount })),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id || 0) - (a.id || 0)));
  return { balance: s.cash, unsettled: wait, available: Math.max(0, s.cash - wait), moves: rows,
    withdraw_fee: String(c.cfg.broker).startsWith('thndr') ? THNDR_WITHDRAW_FEE : 0, settle_days: E.SETTLE_DAYS,
    settle: String(c.cfg.broker).startsWith('thndr') ? THNDR_SETTLE : null, thndr: String(c.cfg.broker).startsWith('thndr'),
    plan: plan ? { ...plan, free: E.PLAN_FREE, used: E.planTrades(book, plan, today), month: E.planMonth(plan, today),
      next: E.planNext(plan, today) } : null, prices: E.PLAN_PRICE, plan_free: E.PLAN_FREE };
}

// Your Thndr Trader plan, from its page in Thndr's app (Account → Subscriptions): saving it also sets your fees to
// Thndr Trader's, and removing it to Thndr's own. Renewals from today on come out of your wallet (context()).
function savePlan(c, body) {
  const since = toDay(body.since, 'Member since');
  const today = localToday();
  if (since > today) fail(422, "Member since: that's in the future.");
  const kind = body.kind === 'yearly' ? 'yearly' : 'monthly';
  const price = toNum(body.price, 'Plan price', { strict: false });
  const had = c.book.plan;
  const plan = { since, kind, price, added: had ? had.added : today,
    paid_to: had && had.since === since && had.kind === kind ? had.paid_to : E.planRenewals({ since, kind }, '', today).at(-1) };
  // Thndr's count this plan month: what you didn't log here is kept beside the ones you log (engine.js planTrades)
  const month = E.planMonth(plan, today)[0];
  if (body.used !== undefined && body.used !== null && body.used !== '') {
    const used = toNum(body.used, 'Free trades used', { strict: false, integer: true });
    plan.used_at = { month, n: Math.max(0, used - E.planTrades(c.book, plan, today)) };
  } else if (had && had.used_at && had.used_at.month === month) plan.used_at = had.used_at;
  c.book.plan = plan;
  c.book.settings = { ...c.book.settings, broker: 'thndr_trader' };
  saveBook(c.book);
  return { message: had ? 'Your Thndr Trader plan is updated.'
    : `Saved your Thndr Trader plan: ${E.PLAN_FREE} orders a month without Thndr's commission, and ${money2(price)} EGP out of your wallet on each renewal.` };
}

function deletePlan(c) {
  if (!c.book.plan) fail(404, 'No plan saved.');
  delete c.book.plan;
  c.book.settings = { ...c.book.settings, broker: 'thndr' };
  saveBook(c.book);
  return { message: "Removed your Thndr Trader plan: your orders count Thndr's commission again." };
}

function walletMove(c, body) {
  const kind = String(body.kind || '');
  if (!WALLET_KINDS.includes(kind)) fail(422, 'Choose top up, withdraw, settle now, a fee or money back.');
  const date = toDay(body.date || localToday());
  const note = String(body.note || '').trim().slice(0, 100);
  const s = E.accountSummary(c.book, 'real', c.cfg, closes(c), c.core.events);
  let amount, fee = 0, message;
  if (kind === 'fix') {             // what your broker's wallet shows: the difference is set right
    const balance = toNum(body.balance, 'Balance', { strict: false });
    amount = Math.round((balance - s.cash) * 100) / 100;
    if (!amount) return { message: 'Your wallet already shows that.' };
    message = `Your wallet now shows ${money2(balance)} EGP (${amount > 0 ? '+' : '−'}${money2(Math.abs(amount))} set right).`;
  } else if (kind === 'settle') {   // money from a sale made withdrawable at once, for a fee
    amount = toNum(body.amount, 'Amount');
    fee = toNum(body.fee || 0, 'Fee', { strict: false });
    const wait = E.unsettled(c.book, date);
    if (amount > wait + 0.005) fail(422, `Only ${money2(wait)} EGP was still settling on that day.`);
    if (String(c.cfg.broker).startsWith('thndr') && amount < THNDR_SETTLE.min_amount) {
      fail(422, `Thndr settles ${THNDR_SETTLE.min_amount} EGP or more at a time.`);
    }
    message = `Settled ${money2(amount)} EGP now${fee ? ` for a ${money2(fee)} EGP fee` : ''}: you can withdraw it at once.`;
  } else {
    amount = toNum(body.amount, 'Amount');
    if (kind === 'deposit' || kind === 'withdraw') fee = toNum(body.fee || 0, 'Fee', { strict: false });
    if (kind === 'deposit' && fee >= amount) fail(422, 'The fee is more than the amount.');
    if (kind === 'withdraw') {
      const free = s.cash - E.unsettled(c.book, localToday());
      if (amount + fee > free + 0.005) {
        fail(422, `You can withdraw up to ${money2(Math.max(0, free - fee))} EGP now. Money from a sale can buy at once `
          + `but can be withdrawn only after ${E.SETTLE_DAYS} working days, or at once with "Settle now" for a fee. If your `
          + 'broker shows a different balance, use "Match my broker" first.');
      }
    }
    message = {
      deposit: `Added ${money2(amount - fee)} EGP to your wallet.`,
      withdraw: `Took ${money2(amount)} EGP out of your wallet${fee ? ` (+ ${money2(fee)} EGP fee)` : ''}.`,
      fee: `Recorded a ${money2(amount)} EGP fee.`,
      refund: `Recorded ${money2(amount)} EGP back.`,
    }[kind];
  }
  c.book.cash = [...(c.book.cash || []), { id: E.nextId(c.book), date, kind, amount, fee, note }];
  saveBook(c.book);
  return { message };
}

function deleteWalletMove(c, id) {
  if (!(c.book.cash || []).some(m => m.id === id)) fail(404, 'Not found.');
  c.book.cash = c.book.cash.filter(m => m.id !== id);
  saveBook(c.book);
  return { message: 'Removed from your wallet.' };
}

// ------------------------------------------------------------------ editing a trade's transactions
// The trade a closed row came from: a partial sale's position, or itself.
const sourceOf = t => { const m = /^partial sale from position #(\d+)$/.exec(t.notes || ''); return m ? +m[1] : t.id; };

// Change the transactions of trade id with change(), then rebuild it (engine.rebuildTrade). First checks that its
// transactions add up to what it holds now: one saved by an older version may not, and rebuilding it would change it.
async function changeTrade(c, id, change) {
  const t = c.book.trades.find(x => x.id === id && x.account === 'real');
  if (!t) fail(404, 'This trade no longer exists. Refresh the page.');
  const bars = (await barsFor(c, [t.symbol]))[t.symbol];
  const at = marketAt(bars, c.cfg);
  const copy = structuredClone(c.book);
  let check;
  try { check = E.rebuildTrade(copy, c.cfg, id, at); } catch { check = null; }
  if (!check || check.shares !== t.shares || Math.abs(check.entry_price - t.entry_price) > 1e-6 || check.status !== t.status) {
    fail(400, `The ${t.symbol} transactions don't add up to what the trade holds (it was saved by an older version), `
      + 'so they can\'t be edited. Delete it and log it again instead.');
  }
  change();
  let res;
  try { res = E.rebuildTrade(c.book, c.cfg, id, at); } catch (e) { fail(400, e.message); }
  saveBook(c.book);
  return { symbol: t.symbol, trade: res };
}

function fillBody(body, side) {
  const date = toDay(body.date);
  if (date > localToday()) fail(422, "date: that's in the future.");
  return { date, price: toNum(body.price, 'price'), shares: toNum(body.shares, 'shares', { min: 1, strict: false, integer: true }),
    note: String(body.note ?? (side === 'sell' ? 'Other / my decision' : '')).trim().slice(0, 200) };
}

const changedMsg = (sym, res) => (!res ? `Deleted ${sym}: no buy was left.`
  : res.status === 'closed' ? `Updated ${sym}. The trade is closed.`
    : `Updated ${sym}: ${E.int(res.shares)} shares at an average of ${res.entry_price.toFixed(3)}. Stop ${E.f2(res.stop)}, target ${E.f2(res.target)}.`);

async function editFill(c, fid, body) {
  const f = c.book.fills.find(x => x.id === fid);
  if (!f || !['buy', 'sell'].includes(f.side)) fail(404, 'This transaction no longer exists. Refresh the page.');
  const v = fillBody({ note: f.note, ...body }, f.side);
  const feesIn = f.side === 'buy' && (body.fees_in ?? !!f.fees_in);   // the price already has the fees in it
  const { symbol, trade } = await changeTrade(c, f.trade_id, () => {
    Object.assign(f, v, { fees: feesIn ? 0 : E.orderFee(v.price * v.shares, feeCfg(c, v.date, f.id)) });
    if (feesIn) f.fees_in = true; else delete f.fees_in;
  });
  return { message: changedMsg(symbol, trade) };
}

async function deleteFill(c, fid) {
  const f = c.book.fills.find(x => x.id === fid);
  if (!f || !['buy', 'sell'].includes(f.side)) fail(404, 'This transaction no longer exists. Refresh the page.');
  const { symbol, trade } = await changeTrade(c, f.trade_id, () => { c.book.fills = c.book.fills.filter(x => x.id !== fid); });
  return { message: changedMsg(symbol, trade) };
}

async function addFillTo(c, id, body) {
  const side = body.side === 'sell' ? 'sell' : 'buy';
  const v = fillBody(body, side);
  const t = c.book.trades.find(x => x.id === id && x.account === 'real');
  if (!t) fail(404, 'This trade no longer exists. Refresh the page.');
  const feesIn = side === 'buy' && !!body.fees_in;
  const { symbol, trade } = await changeTrade(c, id, () => c.book.fills.push({ id: E.nextId(c.book), trade_id: id,
    symbol: t.symbol, side, ...v, fees: feesIn ? 0 : E.orderFee(v.price * v.shares, feeCfg(c, v.date)), ...(feesIn ? { fees_in: true } : {}) }));
  return { message: changedMsg(symbol, trade) };
}

// A closed trade, with everything it came from: its position's transactions, partial sales and dividends.
function deleteClosed(c, id) {
  const row = c.book.trades.find(t => t.id === id && t.account === 'real' && t.status === 'closed');
  if (!row) fail(404, 'This trade no longer exists. Refresh the page.');
  const src = sourceOf(row);
  const main = c.book.trades.find(t => t.id === src);
  if (main && main.status === 'open') {
    fail(400, `Part of this ${row.symbol} position is still open. Delete this sale from its transactions instead.`);
  }
  const tag = `partial sale from position #${src}`;
  c.book.trades = c.book.trades.filter(t => !(t.status === 'closed' && t.notes === tag));
  E.deleteTrade(c.book, src);
  saveBook(c.book);
  return { message: `Deleted the ${row.symbol} trade and its transactions.` };
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
    const book = { date: c.core.scan_date, start: Math.max(0, pv.summary.start), cash: pv.summary.cash, closed: pv.closed_stats,
      watchlist: c.book.watchlist || [],
      positions: pv.positions.map(p => ({ symbol: p.symbol, shares: p.shares, avg: p.avg_price, fees: p.fees, last: p.last,
        stop: p.stop, target: p.target, status: p.status, reason: p.reason || '' })) };
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

// The bells on Picks (worker/bot.js bell): the stocks whose BUY signal you get on Telegram, and turning one on or off
// from here. null when this browser isn't linked to the bot (the bell then opens Telegram instead).
export async function bells() {
  const link = botLink();
  if (!link || link.pending) return null;
  try {
    return (await botPost(link.url, '/bells', { token: link.token })).bells;
  } catch (err) {
    if (err.status === 401 || err.status === 403) return null;
    throw err;
  }
}
export async function setBell(symbol, on) {
  const link = botLink();
  if (!link || link.pending) throw new Error('Connect Telegram first: Settings → Connect Telegram.');
  return (await botPost(link.url, '/bell', { token: link.token, symbol, on })).bells;
}

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
      case 'egx30': return load('egx30');
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
  if (method === 'POST' && a === 'portfolio' && x === 'stop') return setStop(c, id, body || {});
  if (method === 'POST' && a === 'portfolio' && x === 'fills') return addFillTo(c, id, body || {});
  if (method === 'PUT' && a === 'portfolio' && b === 'fills') return editFill(c, Number(x), body || {});
  if (method === 'DELETE' && a === 'portfolio' && b === 'fills') return deleteFill(c, Number(x));
  if (method === 'DELETE' && a === 'portfolio' && b === 'closed') return deleteClosed(c, Number(x));
  if (method === 'POST' && a === 'portfolio' && b === 'plan') return savePlan(c, body || {});
  if (method === 'DELETE' && a === 'portfolio' && b === 'plan') return deletePlan(c);
  if (method === 'DELETE' && a === 'portfolio' && b && !x) return deletePosition(c, id);
  if (method === 'DELETE' && a === 'dividends') return deleteDividend(c, id);
  if (method === 'POST' && a === 'portfolio' && b === 'wallet') return walletMove(c, body || {});
  if (method === 'DELETE' && a === 'wallet') return deleteWalletMove(c, id);
  if (method === 'PUT' && a === 'settings') return saveSettings(c, body);
  if (method === 'PUT' && a === 'watchlist') return saveWatchlist(c, body || {});
  if (method === 'POST' && a === 'settings' && b === 'defaults') return resetSettings(c);
  return fail(404, "That isn't available on this site. Scans run by themselves after every close.");
}
