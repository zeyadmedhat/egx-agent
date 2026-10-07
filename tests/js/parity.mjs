// Runs the browser's money rules (app/static/js/local/engine.js) on cases from tests/test_static_site.py and prints
// the results as JSON, so the test can check they match the Python rules exactly.
//   node tests/js/parity.mjs < cases.json
import * as E from '../../app/static/js/local/engine.js';
import { readBackup } from '../../app/static/js/local/site.js';
import { planTrade } from '../../app/static/js/sizing.js';
import * as I from '../../app/static/js/insights.js';

const input = JSON.parse(await new Promise(resolve => {
  let s = '';
  process.stdin.on('data', d => { s += d; });
  process.stdin.on('end', () => resolve(s));
}));

const bars = list => list.map(b => ({ ...b, atr14: E.num(b.atr14), ema50: E.num(b.ema50), sup: E.num(b.sup) }));
const emptyBook = () => ({ next_id: 1, trades: [], fills: [], dividends: [], adjustments: [] });

const OPS = {
  realStatus: ({ trade, bars: b, cfg }) => E.realStatus(trade, bars(b), cfg),
  allocate: ({ candidates, equity, cash, positions, cfg, risk_off: riskOff }) =>
    E.allocate(candidates, equity, cash, positions, cfg, riskOff),
  real: ({ cfg, steps, events }) => {
    const book = emptyBook();
    const out = [];
    for (const s of steps) {
      if (s.op === 'buy') out.push(E.addRealBuy(book, cfg, s.symbol, s.date, s.price, s.shares, s.atr, s.sector, s.stop, s.notes, null, !!s.fees_in));
      if (s.op === 'sell') out.push(E.sellReal(book, cfg, s.trade_id, s.date, s.price, s.shares, s.reason));
      if (s.op === 'dividend') out.push(E.addDividend(book, s.trade_id, s.date, s.amount, s.note).per_share);
      if (s.op === 'pending') out.push(E.pending(book, events, 'real'));
      if (s.op === 'apply') out.push(E.applyEvent(book, s.trade_id, events.find(e => e.id === s.event_id), s.shares, s.today, s.paid || 0));
      // editing transactions (local/api.js editFill / deleteFill / addFillTo): fill is its place in book.fills
      const at = () => ({ atr: s.atr, chart: null });
      if (s.op === 'edit') {
        const f = book.fills[s.fill];
        Object.assign(f, s.set);
        f.fees = f.fees_in ? 0 : E.orderFee(f.price * f.shares, cfg);   // a price with the fees in it keeps none
        out.push(E.rebuildTrade(book, cfg, f.trade_id, at) && 'ok');
      }
      if (s.op === 'delfill') {
        const f = book.fills[s.fill];
        book.fills = book.fills.filter(x => x !== f);
        out.push(E.rebuildTrade(book, cfg, f.trade_id, at) ? 'kept' : 'deleted');
      }
    }
    return { out, trades: E.trades(book, 'real'), fills: book.fills,
      summary: E.accountSummary(book, 'real', cfg, steps.at(-1).closes || {}, events) };
  },
  // A backup file made from the Mac's portfolio, restored the way Settings → Restore from a backup does it.
  backup: ({ text, cfg, closes, events }) => {
    const book = readBackup(text);
    return { summary: E.accountSummary(book, 'real', cfg, closes, events), pending: E.pending(book, events, 'real'),
      trades: E.trades(book, 'real'), fills: book.fills, dividends: E.dividendsByTrade(book, 'real'),
      settings: book.settings, next_id: E.nextId(book) };
  },
  // your wallet (local/api.js walletView): the account with its top-ups, withdrawals and fees, and what's settling
  wallet: ({ book, cfg, today }) => ({ summary: E.accountSummary(book, 'real', cfg, {}, []),
    unsettled: today.map(d => E.unsettled(book, d)) }),
  plan: args => planTrade(args),
  equity: args => I.equityCurve(args),
  journal: ({ closed, history }) => I.journal(closed, history),
  correlations: ({ series, symbols }) => I.correlations(series, symbols),
  describe: ({ factors }) => factors.map(f => E.describe(f)),
  sessionsAfter: ({ pairs }) => pairs.map(([d, n]) => E.sessionsAfter(d, n)),
  expected: ({ times }) => times.map(t => E.expectedSessionDate(new Date(t))),
  stopFrom: ({ times }) => times.map(t => E.stopFrom(new Date(t))),
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
