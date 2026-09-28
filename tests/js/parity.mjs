// Runs the browser's money rules (app/static/js/local/engine.js) on cases from tests/test_static_site.py and prints
// the results as JSON, so the test can check they match the Python rules exactly.
//   node tests/js/parity.mjs < cases.json
import * as E from '../../app/static/js/local/engine.js';

const input = JSON.parse(await new Promise(resolve => {
  let s = '';
  process.stdin.on('data', d => { s += d; });
  process.stdin.on('end', () => resolve(s));
}));

const bars = list => list.map(b => ({ ...b, atr14: E.num(b.atr14), ema50: E.num(b.ema50) }));
const barsBySymbol = obj => Object.fromEntries(Object.entries(obj).map(([s, b]) => [s, bars(b)]));
const emptyBook = () => ({ next_id: 1, trades: [], fills: [], dividends: [], adjustments: [] });

const OPS = {
  realStatus: ({ trade, bars: b, cfg }) => E.realStatus(trade, bars(b), cfg),
  allocate: ({ candidates, equity, cash, positions, cfg, risk_off: riskOff }) =>
    E.allocate(candidates, equity, cash, positions, cfg, riskOff),
  paper: ({ cfg, bars: b, days, stocks }) => {
    const book = emptyBook();
    const all = barsBySymbol(b);
    const info = new Map(Object.entries(stocks));
    const stats = days.map(day => E.paperDay(book, cfg, all, [], day, info, '2026-01-01'));
    const last = days[days.length - 1].date;
    const closes = Object.fromEntries(Object.entries(all).map(([s, x]) => [s, x.filter(y => y.date <= last).at(-1).close]));
    const series = Object.fromEntries(Object.entries(all).map(([s, x]) => [s, { time: x.map(y => y.date), close: x.map(y => y.close) }]));
    const dates = all[Object.keys(all)[0]].map(y => y.date).filter(d => d <= last);
    return { stats, trades: E.trades(book, 'paper'), summary: E.accountSummary(book, 'paper', cfg, closes),
      curve: E.equityCurve(book, 'paper', cfg, series, dates) };
  },
  real: ({ cfg, steps, events }) => {
    const book = emptyBook();
    const out = [];
    for (const s of steps) {
      if (s.op === 'buy') out.push(E.addRealBuy(book, cfg, s.symbol, s.date, s.price, s.shares, s.atr, s.sector, s.stop, s.notes));
      if (s.op === 'sell') out.push(E.sellReal(book, cfg, s.trade_id, s.date, s.price, s.shares, s.reason));
      if (s.op === 'dividend') out.push(E.addDividend(book, s.trade_id, s.date, s.amount, s.note).per_share);
      if (s.op === 'pending') out.push(E.pending(book, events, 'real'));
      if (s.op === 'apply') out.push(E.applyEvent(book, s.trade_id, events.find(e => e.id === s.event_id), s.shares, s.today));
    }
    return { out, trades: E.trades(book, 'real'), fills: book.fills,
      summary: E.accountSummary(book, 'real', cfg, steps.at(-1).closes || {}, events) };
  },
  describe: ({ factors }) => factors.map(f => E.describe(f)),
  sessionsAfter: ({ pairs }) => pairs.map(([d, n]) => E.sessionsAfter(d, n)),
  expected: ({ times }) => times.map(t => E.expectedSessionDate(new Date(t))),
  px: ({ values }) => values.map(v => E.px(v)),
};

const results = input.cases.map(c => {
  try {
    return { ok: true, value: OPS[c.op](c.args) };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
});
process.stdout.write(JSON.stringify(results, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)));
