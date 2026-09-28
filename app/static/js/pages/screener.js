// Screener: every stock's trend, momentum, volume, model rank and dividend yield in one table, with filters.
// Filters are remembered on this device. Information only: the BUY rules decide the signals.
import { html, useApi, useState, useMemo, useStore, fmt, tone, go, stockHref, remember, cls } from '../lib.js';
import { Icon, PageHead, PageLoading, DataTable, StockCell, StatusChip, Chance, Disclaimer, WatchStar } from '../ui.js';

const DEFAULTS = {
  q: '', sector: '', trend: 'any', rsi: 'any', volume: 'any', high: 'any', model: 'any', shariah: 'any',
  signal: 'any', yield: 'any', liquid: true,
};
const PRESETS = [
  ['Uptrend with volume', { trend: 'up', volume: 'high' }],
  ['Near a 1-year high', { trend: 'up', high: 'near5' }],
  ['Pullback in an uptrend', { trend: 'above50', rsi: 'below45' }],
  ['Model top picks', { model: 'either' }],
  ['Dividend payers', { yield: '6' }],
];
const OPTIONS = {
  trend: [['any', 'Any trend'], ['up', 'Uptrend (above 20- & 50-day avg)'], ['above50', 'Above 50-day avg'],
    ['above200', 'Above 200-day avg'], ['below50', 'Below 50-day avg']],
  rsi: [['any', 'Any RSI'], ['oversold', 'Oversold (RSI < 30)'], ['below45', 'Cooling off (RSI < 45)'],
    ['overbought', 'Overbought (RSI > 70)']],
  volume: [['any', 'Any volume'], ['high', 'Volume ≥ 1.5× normal']],
  high: [['any', 'Anywhere in its range'], ['near5', 'Within 5% of its 1-year high'],
    ['near10', 'Within 10% of its 1-year high'], ['far30', '30%+ below its 1-year high']],
  model: [['any', 'Any model rank'], ['top10', "Model's top pick (2 weeks)"], ['top20', "Model's top pick (1 month)"],
    ['either', 'Model top pick (either)']],
  shariah: [['any', 'Any Shariah status'], ['compliant', 'Kashif: compliant only']],
  signal: [['any', 'Any signal'], ['buy', 'BUY today'], ['watch', 'On the watchlist'], ['signal', 'BUY or watchlist'],
    ['held', 'In my portfolio']],
  yield: [['any', 'Any dividend'], ['3', 'Yield ≥ 3%'], ['6', 'Yield ≥ 6%'], ['10', 'Yield ≥ 10%']],
};

function loadFilters() {
  try { return { ...DEFAULTS, ...JSON.parse(remember('screener') || '{}') }; } catch { return { ...DEFAULTS }; }
}

const TESTS = {
  trend: { up: r => r.vs_ema20 > 0 && r.vs_ema50 > 0, above50: r => r.vs_ema50 > 0, above200: r => r.vs_ema200 > 0,
    below50: r => r.vs_ema50 < 0 },
  rsi: { oversold: r => r.rsi < 30, below45: r => r.rsi < 45, overbought: r => r.rsi > 70 },
  volume: { high: r => r.vol_ratio >= 1.5 },
  high: { near5: r => r.from_high >= -0.05, near10: r => r.from_high >= -0.10, far30: r => r.from_high <= -0.30 },
  model: { top10: r => r.top10, top20: r => r.top20, either: r => r.top10 || r.top20 },
  signal: { buy: r => r.action === 'BUY', watch: r => r.action === 'WATCH', signal: r => !!r.action, held: r => r.held },
  yield: { 3: r => r.yield >= 0.03, 6: r => r.yield >= 0.06, 10: r => r.yield >= 0.10 },
};

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
      return Object.keys(TESTS).every(k => f[k] === 'any' || !TESTS[k][f[k]] || TESTS[k][f[k]](r));
    });
  }, [data, f, info]);

  if (!data) return html`<${PageHead} title="Screener" /><${PageLoading} error=${error} />`;
  const changed = Object.keys(DEFAULTS).some(k => f[k] !== DEFAULTS[k]);
  const pick = k => html`<select class="input" value=${f[k]} onChange=${set(k)}>
    ${OPTIONS[k].map(([v, label]) => html`<option value=${v}>${label}</option>`)}</select>`;

  return html`<${PageHead} title="Screener"
      sub=${`Every stock's numbers from the ${fmt.date(data.date)} close. Filter and sort; click a stock for its chart. Information only: the BUY rules decide the signals.`} />
    <div class="row" style="margin-bottom:12px">
      ${PRESETS.map(([label, p]) => html`<button class="btn sm" onClick=${() => save({ ...DEFAULTS, ...p })}>${label}</button>`)}
      ${changed && html`<button class="linkish" onClick=${() => save({ ...DEFAULTS })}>Clear filters</button>`}
    </div>
    <div class="card screener-filters">
      <div class="form-grid">
        <input class="input" placeholder="Symbol or name…" value=${f.q} onInput=${set('q')} />
        <select class="input" value=${f.sector} onChange=${set('sector')}>
          <option value="">All sectors</option>${sectors.map(s => html`<option value=${s}>${s}</option>`)}</select>
        ${pick('trend')}${pick('rsi')}${pick('volume')}${pick('high')}${pick('model')}${pick('signal')}${pick('yield')}
        ${pick('shariah')}
      </div>
      <label class="check" style="margin-top:12px"><input type="checkbox" checked=${f.liquid} onChange=${set('liquid')} />
        Only liquid stocks that traded recently (at least ${fmt.short(data.min_value)} EGP a day, like the BUY rules)</label>
    </div>
    <div class="row" style="margin:14px 0 8px;justify-content:space-between">
      <b>${fmt.int(rows.length)} of ${fmt.int(data.rows.length)} stocks</b>
      <span class="faint" style="font-size:12.5px">Your filters are remembered on this device.</span>
    </div>
    <div class="card flush"><${DataTable} columns=${COLUMNS} rows=${rows} rowKey=${r => r.symbol} limit=${50}
      sort=${{ key: 'ret63', dir: 'desc' }} onRowClick=${r => go(stockHref(r.symbol))}
      empty="No stock matches all of these filters. Try removing one." /></div>
    <${Disclaimer} />`;
}

const pctCell = (v, d = 1) => html`<span class=${tone(v)}>${fmt.pct(v, d)}</span>`;
const above = (v, label) => html`<span class=${cls('trend-dot', v > 0 ? 'up' : v < 0 ? 'down' : 'faint')}
  title=${v == null ? `Not enough history for the ${label}-day average` : `${fmt.pct(v, 1)} vs its ${label}-day average`}>${label}</span>`;

const COLUMNS = [
  { key: 'star', label: '', sortable: false, width: '34px', render: r => html`<${WatchStar} symbol=${r.symbol} />` },
  { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} info=${r.info} />` },
  { key: 'sector', label: 'Sector', sortValue: r => r.info.sector || '', render: r => html`<span class="muted">${r.info.sector || ''}</span>` },
  { key: 'close', label: 'Close', align: 'r', fmt: v => fmt.price(v) },
  { key: 'chg1', label: 'Day', align: 'r', render: r => pctCell(r.chg1) },
  { key: 'ret21', label: '1 month', align: 'r', render: r => pctCell(r.ret21, 0) },
  { key: 'ret63', label: '3 months', align: 'r', render: r => pctCell(r.ret63, 0) },
  { key: 'trend', label: 'Above avg', sortValue: r => (r.vs_ema20 > 0) + (r.vs_ema50 > 0) + (r.vs_ema200 > 0),
    title: 'Above (green) or below (red) its 20-, 50- and 200-day averages',
    render: r => html`<span class="trend-dots">${above(r.vs_ema20, 20)}${above(r.vs_ema50, 50)}${above(r.vs_ema200, 200)}</span>` },
  { key: 'rsi', label: 'RSI', align: 'r', fmt: v => html`<span class=${v > 70 ? 'warn' : v < 30 ? 'down' : ''}>${fmt.num(v, 0)}</span>` },
  { key: 'vol_ratio', label: 'Volume', align: 'r', title: 'Last session vs its 20-day average',
    fmt: v => html`<span class=${v >= 1.5 ? 'up' : 'muted'}>${fmt.num(v, 1)}×</span>` },
  { key: 'from_high', label: 'From 1-yr high', align: 'r', render: r => pctCell(r.from_high, 0) },
  { key: 'p10', label: 'Model 2 wk', align: 'r', sortValue: r => (r.top10 ? r.p10 : -1),
    title: "The model's chance of target before stop, shown for its top 10% each day",
    render: r => html`<${Chance} p=${r.p10} top=${r.top10} />` },
  { key: 'yield', label: 'Yield', align: 'r', sortValue: r => r.yield ?? -1,
    fmt: v => (v ? fmt.pct(v, 1, false) : html`<span class="faint">–</span>`) },
  { key: 'action', label: 'Signal', sortValue: r => (r.action === 'BUY' ? 0 : r.action ? 1 : r.held ? 2 : 3),
    render: r => html`<div class="row" style="gap:6px">${r.action && html`<${StatusChip} status=${r.action} />`}
      ${r.held && html`<span class="tag"><${Icon} name="briefcase" size=${12} />Held</span>`}</div>` },
];
