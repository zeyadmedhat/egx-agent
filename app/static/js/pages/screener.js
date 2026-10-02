// Screener: every stock's trend, momentum, volume, model rank and dividend yield in one table, with filters.
// Filters are remembered on this device. Information only: the BUY rules decide the signals.
import { html, useApi, useState, useMemo, useStore, fmt, tone, go, stockHref, remember, cls } from '../lib.js';
import { Icon, PageHead, PageLoading, DataTable, StockCell, StatusChip, Chance, WatchStar, Fold, Rating } from '../ui.js';
import { t, tn } from '../i18n.js';

const DEFAULTS = {
  q: '', sector: '', trend: 'any', rsi: 'any', volume: 'any', high: 'any', model: 'any', shariah: 'any',
  signal: 'any', yield: 'any', rating: 'any', exdiv: 'any', pe: 'any', liquid: true, sort: null,
};
const BY_RATING = { key: 'rating', dir: 'desc' };
// Ready-made lists: one tap sets the filters (and the order) for a common question.
const PRESETS = [
  ['Best rated', { rating: '91' }],
  ['Shariah and close to a BUY', { shariah: 'compliant', signal: 'signal' }],
  ['Ex-dividend in the next 30 days', { exdiv: '30', sort: { key: 'exdiv', dir: 'asc' } }],
  ['At a 1-year high', { high: 'at' }],
  ['Cheapest on P/E', { pe: 'profit', sort: { key: 'pe', dir: 'asc' } }],
  ['Uptrend with volume', { trend: 'up', volume: 'high' }],
  ['High dividend yield', { yield: '6', sort: { key: 'yield', dir: 'desc' } }],
];
const OPTIONS = {
  trend: [['any', 'Any trend'], ['up', 'Uptrend (above 20- & 50-day avg)'], ['above50', 'Above 50-day avg'],
    ['above200', 'Above 200-day avg'], ['below50', 'Below 50-day avg']],
  rsi: [['any', 'Any RSI'], ['oversold', 'Oversold (RSI < 30)'], ['below45', 'Cooling off (RSI < 45)'],
    ['overbought', 'Overbought (RSI > 70)']],
  volume: [['any', 'Any volume'], ['high', 'Volume ≥ 1.5× normal']],
  high: [['any', 'Anywhere in its range'], ['at', 'At its 1-year high (within 1%)'], ['near5', 'Within 5% of its 1-year high'],
    ['near10', 'Within 10% of its 1-year high'], ['far30', '30%+ below its 1-year high']],
  model: [['any', 'Any model rank'], ['top10', "Model's top pick (2 weeks)"], ['top20', "Model's top pick (1 month)"],
    ['either', 'Model top pick (either)']],
  shariah: [['any', 'Any Shariah status'], ['compliant', 'Kashif: compliant only']],
  signal: [['any', 'Any signal'], ['buy', 'BUY today'], ['watch', 'On the watchlist'], ['signal', 'BUY or watchlist'],
    ['held', 'In my portfolio']],
  yield: [['any', 'Any dividend'], ['3', 'Yield ≥ 3%'], ['6', 'Yield ≥ 6%'], ['10', 'Yield ≥ 10%']],
  rating: [['any', 'Any rating'], ['91', 'Rating 91–100 (the model\'s top 10%)'], ['71', 'Rating 71 or more']],
  exdiv: [['any', 'Any ex-dividend date'], ['30', 'Ex-dividend in the next 30 days']],
  pe: [['any', 'Any P/E'], ['profit', 'Profitable (P/E above 0)'], ['cheap', 'P/E under 10 (profitable)']],
};

function loadFilters() {
  try { return { ...DEFAULTS, ...JSON.parse(remember('screener') || '{}') }; } catch { return { ...DEFAULTS }; }
}

const TESTS = {
  trend: { up: r => r.vs_ema20 > 0 && r.vs_ema50 > 0, above50: r => r.vs_ema50 > 0, above200: r => r.vs_ema200 > 0,
    below50: r => r.vs_ema50 < 0 },
  rsi: { oversold: r => r.rsi < 30, below45: r => r.rsi < 45, overbought: r => r.rsi > 70 },
  volume: { high: r => r.vol_ratio >= 1.5 },
  high: { at: r => r.from_high >= -0.01, near5: r => r.from_high >= -0.05, near10: r => r.from_high >= -0.10,
    far30: r => r.from_high <= -0.30 },
  model: { top10: r => r.top10, top20: r => r.top20, either: r => r.top10 || r.top20 },
  signal: { buy: r => r.action === 'BUY', watch: r => r.action === 'WATCH', signal: r => !!r.action, held: r => r.held },
  yield: { 3: r => r.yield >= 0.03, 6: r => r.yield >= 0.06, 10: r => r.yield >= 0.10 },
  rating: { 91: r => r.rating >= 91, 71: r => r.rating >= 71 },
  pe: { profit: r => r.pe > 0, cheap: r => r.pe > 0 && r.pe < 10 },
};
const DAY = 86400000;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function ScreenerPage() {
  const { data, error } = useApi('/screener');
  const stocks = useStore(s => s.stocks) || [];
  const [f, setF] = useState(loadFilters);
  const save = next => { setF(next); remember('screener', JSON.stringify(next)); };
  const set = k => e => save({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const info = useMemo(() => new Map(stocks.map(s => [s.symbol, s])), [stocks]);
  const sectors = useMemo(() => [...new Set(stocks.map(s => s.sector).filter(Boolean))].sort(), [stocks]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = f.q.trim().toLowerCase();
    const fresh = data.date ? new Date(data.date).getTime() - 10 * 86400000 : 0;
    return data.rows.map(r => ({ ...r, info: info.get(r.symbol) || { symbol: r.symbol } })).filter(r => {
      if (f.liquid && !(r.value >= data.min_value && new Date(r.date).getTime() >= fresh)) return false;
      if (q && !`${r.symbol} ${r.info.name_ar || ''}`.toLowerCase().includes(q)) return false;
      if (f.sector && r.info.sector !== f.sector) return false;
      if (f.shariah === 'compliant' && r.info.kashif_status !== 'compliant') return false;
      if (f.exdiv === '30' && !(r.exdiv && (Date.parse(r.exdiv) - Date.parse(data.date)) / DAY <= 30)) return false;
      return Object.keys(TESTS).every(k => f[k] === 'any' || !TESTS[k][f[k]] || TESTS[k][f[k]](r));
    });
  }, [data, f, info]);

  if (!data) return html`<${PageHead} title="Screener" /><${PageLoading} error=${error} />`;
  const changed = Object.keys(DEFAULTS).some(k => !same(f[k], DEFAULTS[k]));
  const isOn = p => Object.keys(DEFAULTS).every(k => same(f[k], k in p ? p[k] : DEFAULTS[k]));
  const pick = k => html`<select class="input" value=${f[k]} onChange=${set(k)}>
    ${OPTIONS[k].map(([v, label]) => html`<option value=${v}>${t(label)}</option>`)}</select>`;

  const MORE = ['rating', 'trend', 'rsi', 'volume', 'high', 'model', 'yield', 'exdiv', 'pe'];
  const more = MORE.filter(k => f[k] !== 'any').length + (f.liquid ? 0 : 1);
  return html`<${PageHead} title="Screener"
      sub=${t("Every stock's numbers from the {date} close. Filter, sort, and tap a stock for its chart.", { date: fmt.date(data.date) })} />
    <div class="row" style="margin-bottom:12px">
      ${PRESETS.map(([label, p]) => html`<button class=${cls('btn sm', isOn(p) && 'on')} aria-pressed=${isOn(p)}
        onClick=${() => save({ ...DEFAULTS, ...p })}>${t(label)}</button>`)}
      ${changed && html`<button class="linkish" onClick=${() => save({ ...DEFAULTS })}>${t('Clear filters')}</button>`}
    </div>
    <div class="card screener-filters">
      <div class="form-grid">
        <input class="input" placeholder=${t('Symbol or name…')} value=${f.q} onInput=${set('q')} />
        <select class="input" value=${f.sector} onChange=${set('sector')}>
          <option value="">${t('All sectors')}</option>${sectors.map(s => html`<option value=${s}>${tn(s)}</option>`)}</select>
        ${pick('signal')}${pick('shariah')}
      </div>
    </div>
    <${Fold} title="More filters" hint=${more ? t('{n} on', { n: more }) : t('Rating, trend, RSI, volume, 1-year high, dividend, P/E')}>
      <div class="form-grid">${MORE.map(pick)}</div>
      <label class="check" style="margin-top:12px"><input type="checkbox" checked=${f.liquid} onChange=${set('liquid')} />
        Only actively traded stocks that traded recently (at least ${fmt.short(data.min_value)} EGP a day, like the BUY rules)</label><//>
    <div class="row" style="margin:16px 0 8px"><b>${t('{k} of {n} stocks', { k: fmt.int(rows.length), n: fmt.int(data.rows.length) })}</b></div>
    <div class="card flush"><${DataTable} key=${JSON.stringify(f.sort)} columns=${COLUMNS} rows=${rows} rowKey=${r => r.symbol}
      limit=${50} sort=${f.sort || BY_RATING} onRowClick=${r => go(stockHref(r.symbol))}
      empty="No stock matches all of these filters. Try removing one." /></div>`;
}

const pctCell = (v, d = 1) => html`<span class=${tone(v)}>${fmt.pct(v, d)}</span>`;
const above = (v, label) => html`<span class=${cls('trend-dot', v > 0 ? 'up' : v < 0 ? 'down' : 'faint')}
  title=${v == null ? `Not enough history for the ${label}-day average` : `${fmt.pct(v, 1)} vs its ${label}-day average`}>${label}</span>`;

const COLUMNS = [
  { key: 'star', label: '', sortable: false, width: '34px', render: r => html`<${WatchStar} symbol=${r.symbol} />` },
  { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} info=${r.info} />` },
  { key: 'rating', label: 'Rating', align: 'r', title: "The model's rank among the day's actively traded stocks, 1–100 (91+ is its top 10%)",
    render: r => html`<${Rating} v=${r.rating} />` },
  { key: 'close', label: 'Price', align: 'r', fmt: v => fmt.price(v) },
  { key: 'chg1', label: 'Day', align: 'r', render: r => pctCell(r.chg1) },
  { key: 'ret21', label: '1 month', align: 'r', render: r => pctCell(r.ret21, 0) },
  { key: 'ret63', label: '3 months', align: 'r', render: r => pctCell(r.ret63, 0) },
  { key: 'trend', label: 'Above avg', sortValue: r => (r.vs_ema20 > 0) + (r.vs_ema50 > 0) + (r.vs_ema200 > 0),
    title: 'Above (green) or below (red) its 20-, 50- and 200-day averages',
    render: r => html`<span class="trend-dots">${above(r.vs_ema20, 20)}${above(r.vs_ema50, 50)}${above(r.vs_ema200, 200)}</span>` },
  { key: 'rsi', label: 'RSI', align: 'r', fmt: v => html`<span class=${v > 70 ? 'warn' : v < 30 ? 'down' : ''}>${fmt.num(v, 0)}</span>` },
  { key: 'p10', label: 'Model 2 wk', align: 'r', sortValue: r => (r.top10 ? r.p10 : -1),
    title: "The model's chance of target before stop, shown for its top 10% each day",
    render: r => html`<${Chance} p=${r.p10} top=${r.top10} />` },
  { key: 'yield', label: 'Yield', align: 'r', sortValue: r => r.yield ?? -1,
    fmt: v => (v ? fmt.pct(v, 1, false) : html`<span class="faint">–</span>`) },
  { key: 'pe', label: 'P/E', align: 'r', sortValue: r => (r.pe > 0 ? r.pe : null), title: 'Price over a year of profit per share (TradingView)',
    fmt: v => (v > 0 ? fmt.num(v, 1) : html`<span class="faint">–</span>`) },
  { key: 'exdiv', label: 'Ex-div', sortValue: r => r.exdiv || null, title: 'Its next announced cash dividend',
    fmt: v => (v ? fmt.date(v) : html`<span class="faint">–</span>`) },
  { key: 'action', label: 'Signal', sortValue: r => (r.action === 'BUY' ? 0 : r.action ? 1 : r.held ? 2 : 3),
    render: r => html`<div class="row" style="gap:6px">${r.action && html`<${StatusChip} status=${r.action} />`}
      ${r.held && html`<span class="tag"><${Icon} name="briefcase" size=${12} />${t('Held')}</span>`}</div>` },
];
