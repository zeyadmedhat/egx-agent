// Stocks → Compare: two stocks side by side, from their own pages' data (views.stock_detail): how each moved over the
// last year (both start at 0%), the numbers that matter, and what each method says (methods.js). #/compare/A?vs=B.
import { html, useApi, fmt, tone, cls, go, remember, store, stockHref } from '../lib.js';
import { PageHead, StockPicker, Icon } from '../ui.js';
import { t, tn } from '../i18n.js';
import { methodsFor, LEAN } from '../methods.js';

const DAYS = 250;     // about a year of sessions
const COLORS = ['var(--accent)', 'var(--warn)'];

export function ComparePage({ route }) {
  const a = (route.arg || remember('symbol') || 'COMI').toUpperCase();
  const b = ((route.query && route.query.vs) || remember('compare-vs') || (a === 'CIEB' ? 'COMI' : 'CIEB')).toUpperCase();
  const set = (x, y) => { remember('compare-vs', y); go(`#/compare/${encodeURIComponent(x)}?vs=${encodeURIComponent(y)}`); };
  const da = useApi(`/stock/${encodeURIComponent(a)}`).data, db = useApi(`/stock/${encodeURIComponent(b)}`).data;
  const both = [da, db];
  return html`
    <${PageHead} title="Compare" sub=${t('Two stocks side by side.')} />
    <div class="compare-pick">
      <div><span class="dot-key" style=${`background:${COLORS[0]}`}></span><${StockPicker} value=${a} onChange=${x => set(x, b)} /></div>
      <span class="faint">${t('vs')}</span>
      <div><span class="dot-key" style=${`background:${COLORS[1]}`}></span><${StockPicker} value=${b} onChange=${y => set(a, y)} /></div>
    </div>
    ${da && db && da.has_data && db.has_data ? html`
      <div class="card"><div class="card-title">${t('The last year')}<span class="right faint">${t('both start at 0%')}</span></div>
        <${Lines} list=${both} /></div>
      <div class="card" style="margin-top:12px"><table class="compare-table">
        <thead><tr><th></th>${both.map((d, i) => html`<th><a href=${stockHref(d.symbol)} style=${`color:${COLORS[i]}`}>${d.symbol}</a></th>`)}</tr></thead>
        <tbody>${ROWS.map(([label, get, toneOf]) => html`<tr><td class="faint">${t(label)}</td>${both.map(d => {
          const v = get(d);
          return html`<td class=${toneOf ? tone(toneOf(d)) : ''}>${v == null ? '–' : v}</td>`;
        })}</tr>`)}</tbody></table></div>
      <div class="compare-methods">${both.map((d, i) => html`<${MethodList} d=${d} color=${COLORS[i]} key=${d.symbol} />`)}</div>
      <p class="faint" style="font-size:13px;margin-top:10px">${t("From each stock's own page. Not advice.")}</p>`
    : html`<div class="card"><p class="muted">${both.some(d => d && !d.has_data) ? t('No price data for one of these stocks.') : t('Loading…')}</p></div>`}`;
}

const pct = (v, d = 0) => (v == null ? null : fmt.pct(v, d));
const f = d => (d.fundamentals && d.fundamentals.values) || {};
const ROWS = [
  ['Sector', d => tn((d.info || {}).sector || '')],
  ['Last close', d => fmt.price(d.stats.close)],
  ['On the day', d => pct(d.stats.change, 1), d => d.stats.change],
  ['3-month change', d => pct(d.stats.ret63), d => d.stats.ret63],
  ['1-year change', d => pct(yearChange(d)), d => yearChange(d)],
  ['1-year low – high', d => `${fmt.price(d.stats.low52)} – ${fmt.price(d.stats.high52)}`],
  ['Traded a day', d => `${fmt.short(d.stats.value_avg20)} ${t('EGP')}`],
  ['Price / earnings (P/E)', d => (f(d).pe == null ? null : f(d).pe > 0 ? `${fmt.num(f(d).pe, 1)}×` : t('loss-making'))],
  ['Profit growth', d => pct(f(d).eps_growth), d => f(d).eps_growth],
  ['Model rating', d => (d.prediction && d.prediction.rating != null ? `${d.prediction.rating}/100` : null)],
  ['Reward/risk', d => (d.chart && d.chart.rr != null ? `${fmt.num(d.chart.rr, 1)}×` : null)],
  ["Analysts' target", d => (d.analysts && d.analysts.avg ? `${fmt.price(d.analysts.avg)} (${fmt.pct(d.analysts.avg / d.stats.close - 1, 0)})` : null)],
  ['Lean to buy', d => { const m = methodsFor(d, (store.status || {}).market); return `${m.n.yes} / ${m.rows.length}`; }],
];

function yearChange(d) {
  const c = ((d.series && d.series.close) || []).filter(v => v != null).slice(-DAYS);
  return c.length > 1 ? c[c.length - 1] / c[0] - 1 : null;
}

// Both stocks' closes over the last year as % from their first day, on one small chart.
function Lines({ list }) {
  const W = 600, H = 180, P = 6;
  const ser = list.map(d => {
    const c = ((d.series && d.series.close) || []).slice(-DAYS);
    const first = c.find(v => v != null);
    return c.map(v => (v == null || !first ? null : v / first - 1));
  });
  const all = ser.flat().filter(v => v != null);
  if (!all.length) return null;
  const lo = Math.min(0, ...all), hi = Math.max(0, ...all), span = hi - lo || 1;
  const n = Math.max(...ser.map(s => s.length));
  const x = i => P + (i / Math.max(n - 1, 1)) * (W - 2 * P), y = v => P + (1 - (v - lo) / span) * (H - 2 * P);
  const path = s => s.map((v, i) => (v == null ? '' : `${i && s[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join('');
  const last = s => s.filter(v => v != null).pop();
  return html`<svg class="compare-chart" viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
      aria-label=${list.map((d, i) => `${d.symbol} ${fmt.pct(last(ser[i]), 0)}`).join(', ')}>
    <line x1=${P} x2=${W - P} y1=${y(0)} y2=${y(0)} class="zero" />
    ${ser.map((s, i) => html`<path d=${path(s)} fill="none" stroke=${COLORS[i]} stroke-width="2" vector-effect="non-scaling-stroke" />`)}
  </svg>
  <div class="compare-legend">${list.map((d, i) => html`<span><span class="dot-key" style=${`background:${COLORS[i]}`}></span>${d.symbol}${' '}<b class=${tone(last(ser[i]))}>${fmt.pct(last(ser[i]), 0)}</b></span>`)}</div>`;
}

function MethodList({ d, color }) {
  const m = methodsFor(d, (store.status || {}).market);
  return html`<div class="card"><div class="card-title"><span class="dot-key" style=${`background:${color}`}></span>${d.symbol}
      <span class=${cls('methods-chip right', m.kind)}>${t('{a} of {b} lean to buy', { a: m.n.yes, b: m.rows.length })}</span></div>
    <ul class="methods-list">${m.rows.map(r => html`<li key=${r.name}>
      <span class=${LEAN[r.lean][1]}><${Icon} name=${LEAN[r.lean][0]} size=${15} /></span>
      <div><b>${t(r.name)}</b>${r.tested && html` <span class="tag sm">${t('tested')}</span>`}
        <div class="muted">${r.text}</div></div></li>`)}</ul></div>`;
}
