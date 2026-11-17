// "What each method says" about a stock, shared by the Stock page's card, the Picks cards' count and Stocks → Compare,
// so all three always agree. No new rules: it reads what the stock's page already has (views.stock_detail).
import { html, useApi, store, fmt, cls, stockHref } from './lib.js';
import { t } from './i18n.js';

// "What each method says": every method on this page in one list, each leaning toward buying soon (yes), against
// (no) or neither, and how many agree. "Tested" marks the two that helped in the agent's 10-year EGX tests (the BUY
// rules and the model's rating) and the market switch they both use; the rest are information. Not advice.
export function methodsFor(data, market = null) {
  const st = data.stats || {}, close = st.close, sig = data.signal, list = data.checklist || [];
  const rows = [];
  const add = (name, lean, text, tested = false) => rows.push({ name, lean, text, tested });
  const met = list.filter(c => c.ok).length;
  if (sig && sig.action === 'BUY') add('BUY rules', 'yes', t('A BUY signal now.'), true);
  else if (list.length && !list[0].ok) add('BUY rules', 'no', t('Too thinly traded: the rules never buy it.'), true);
  else if (list.length > 1 && !list[1].ok) add('BUY rules', 'no', t('Not in an uptrend yet ({n} of {m} checks met).', { n: met, m: list.length }), true);
  else if (list.length) add('BUY rules', 'wait', t('{n} of {m} entry checks met.', { n: met, m: list.length }), true);
  const p = data.prediction;
  if (p && p.rating != null) {
    add('Model rating', p.rating >= 71 ? 'yes' : p.rating <= 50 ? 'no' : 'wait', t('Rating {v}/100.', { v: p.rating }), true);
  }
  if (market && market.risk_off != null) {
    add('Market switch', market.risk_off ? 'no' : 'yes',
      t(market.risk_off ? 'Weak market: fewer or no new buys.' : 'The market allows new buys.'), true);
  }
  const ch = data.chart;
  if (ch && ch.rr != null && ch.target) {
    add('Price levels', ch.rr >= 2 ? 'yes' : ch.rr < 1.5 ? 'no' : 'wait',
      t('Reward/risk {rr}× (target {target}, stop {stop}).', { rr: fmt.num(ch.rr, 1), target: fmt.price(ch.target), stop: fmt.price(ch.stop) }));
  }
  const l = data.layers;
  if (l) add('7 Layers', l.score >= l.pass_at ? 'yes' : l.score <= l.pass_at - 3 ? 'no' : 'wait', t('{n} of 7 layers.', { n: l.score }));
  const a = data.analysts;
  if (a && a.n >= 2 && a.avg && close) {
    const up = a.avg / close - 1;
    add('Analysts', up >= 0.15 && a.buy > a.sell ? 'yes' : up < 0 || a.sell > a.buy ? 'no' : 'wait',
      t('{n} analysts: average target {price} ({pct}).', { n: a.n, price: fmt.price(a.avg), pct: fmt.pct(up, 0) }));
  }
  const g = data.fundamentals && data.fundamentals.values && data.fundamentals.values.eps_growth;
  if (g != null) add('Company profits', g > 0.1 ? 'yes' : g < 0 ? 'no' : 'wait', t('Profit growth {pct} a year.', { pct: fmt.pct(g, 0) }));
  const moves = data.owner_moves || [];
  if (moves.length) {
    const net = moves.reduce((s, m) => s + ((m.after || 0) - (m.before || 0)), 0);
    if (net) add('Big owners', net > 0 ? 'yes' : 'no', t(net > 0 ? 'Big owners bought lately.' : 'Big owners sold lately.'));
  }
  const n = { yes: 0, no: 0, wait: 0 };
  for (const r of rows) n[r.lean] += 1;
  const tested = rows.filter(r => r.tested), tNo = tested.filter(r => r.lean === 'no').length;
  const kind = n.yes >= 2 * Math.max(n.no + n.wait, 1) && !tNo ? 'buy' : n.no > n.yes ? 'avoid' : 'wait';
  return { rows, n, kind, tNo };
}

export const LEAN = { yes: ['checkCircle', 'up'], no: ['xCircle', 'down'], wait: ['history', 'warn-text'] };


// The count alone, for a card: "3 of 7 lean to buy", coloured like the Stock page's card. Loads the stock's page data.
export function MethodsChip({ sym }) {
  const { data } = useApi(`/stock/${encodeURIComponent(sym)}`);
  if (!data || !data.has_data) return null;
  const m = methodsFor(data, (store.status || {}).market);
  if (m.rows.length < 3) return null;
  return html`<a class=${cls('methods-chip', m.kind)} href=${stockHref(sym)} onClick=${e => e.stopPropagation()}
    title=${t('What each method says: see the stock page')}>${t('{a} of {b} lean to buy', { a: m.n.yes, b: m.rows.length })}</a>`;
}
