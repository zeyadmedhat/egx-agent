// Watchlist: the stocks you starred, with the Screener's numbers, and how to get Telegram alerts for them.
// The list is yours: on your Mac it's kept with your portfolio; on the website, in this browser (and its backups).
import { html, useApi, useMemo, useStore, fmt, tone, go, stockHref, cls, toggleWatch, STATIC } from '../lib.js';
import {
  Icon, PageLoading, DataTable, StockCell, StatusChip, Chance, Empty, StockPicker, WatchStar, Fold,
} from '../ui.js';
import { t } from '../i18n.js';

export function WatchlistPage() {
  const list = useStore(s => s.watchlist);
  const stocks = useStore(s => s.stocks) || [];
  const { data, error } = useApi('/screener');
  const info = useMemo(() => new Map(stocks.map(s => [s.symbol, s])), [stocks]);
  const add = sym => { if (sym && !(list || []).includes(sym)) toggleWatch(sym); };
  const head = html`<div class="page-head"><div><h1>${t('Watchlist')}</h1>
      <div class="sub">${t('The stocks you follow. Star any stock (☆) on its page or in the Screener to add it.')}</div></div>
    <div style="width:min(380px,100%)"><${StockPicker} value="" onChange=${add} placeholder="Add a stock (symbol or name)…" /></div></div>`;
  if (!data || list == null) return html`${head}<${PageLoading} error=${error} />`;
  const bySym = new Map(data.rows.map(r => [r.symbol, r]));
  const rows = list.map(s => ({ ...(bySym.get(s) || { symbol: s }), info: info.get(s) || { symbol: s } }));
  const pct = (v, d = 1) => html`<span class=${tone(v)}>${fmt.pct(v, d)}</span>`;
  const above = (v, label) => html`<span class=${cls('trend-dot', v > 0 ? 'up' : v < 0 ? 'down' : 'faint')}>${label}</span>`;
  const columns = [
    { key: 'star', label: '', sortable: false, width: '34px', render: r => html`<${WatchStar} symbol=${r.symbol} />` },
    { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} info=${r.info} />` },
    { key: 'close', label: 'Close', align: 'r', fmt: v => fmt.price(v) },
    { key: 'chg1', label: 'Day', align: 'r', render: r => pct(r.chg1) },
    { key: 'ret21', label: '1 month', align: 'r', render: r => pct(r.ret21, 0) },
    { key: 'trend', label: 'Above avg', sortValue: r => (r.vs_ema20 > 0) + (r.vs_ema50 > 0) + (r.vs_ema200 > 0),
      render: r => html`<span class="trend-dots">${above(r.vs_ema20, 20)}${above(r.vs_ema50, 50)}${above(r.vs_ema200, 200)}</span>` },
    { key: 'rsi', label: 'RSI', align: 'r', fmt: v => fmt.num(v, 0) },
    { key: 'from_high', label: 'From 1-yr high', align: 'r', render: r => pct(r.from_high, 0) },
    { key: 'p10', label: 'Model 2 wk', align: 'r', sortValue: r => (r.top10 ? r.p10 : -1),
      render: r => html`<${Chance} p=${r.p10} top=${r.top10} />` },
    { key: 'yield', label: 'Yield', align: 'r', fmt: v => (v ? fmt.pct(v, 1, false) : html`<span class="faint">–</span>`) },
    { key: 'action', label: 'Signal', sortValue: r => (r.action === 'BUY' ? 0 : r.action ? 1 : r.held ? 2 : 3),
      render: r => html`<div class="row" style="gap:6px">${r.action && html`<${StatusChip} status=${r.action} />`}
        ${r.held && html`<span class="tag"><${Icon} name="briefcase" size=${12} />Held</span>`}</div>` },
  ];
  return html`${head}
    ${rows.length ? html`<div class="card flush"><${DataTable} columns=${columns} rows=${rows} rowKey=${r => r.symbol}
        onRowClick=${r => go(stockHref(r.symbol))} /></div>`
      : html`<div class="card"><${Empty} icon="eye" title="No stocks yet"
        text="Add one with the search box above, or press the star (☆) next to a stock on its page or in the Screener." /></div>`}
    <p class="faint" style="font-size:12px;margin-top:8px">${STATIC
      ? 'Kept in this browser with your portfolio, and in your backups (Settings → Download a backup).'
      : 'Kept with your portfolio on this Mac.'}</p>
    <${Fold} title="Alerts in Telegram" hint="Get a message when a stock gets a BUY signal or closes past a price.">
      <p class="muted" style="font-size:13px;margin-bottom:10px">The website's Telegram bot can tell you after a close
        when a stock gets a BUY signal or closes past a price. Connect it on the website (Settings → Connect Telegram),
        then send it:</p>
      <div class="stat-list">
        <span class="k"><code>/watch COMI</code></span><span class="v" style="font-weight:500">when COMI gets a BUY signal</span>
        <span class="k"><code>/watch COMI 45</code></span><span class="v" style="font-weight:500">when COMI closes above 45 (or below, if 45 is under its price)</span>
        <span class="k"><code>/unwatch COMI</code></span><span class="v" style="font-weight:500">stop COMI's alerts</span>
        <span class="k"><code>/list</code></span><span class="v" style="font-weight:500">your alerts</span>
      </div>
      <p class="faint" style="font-size:12px;margin-top:10px">The bot reads messages every few hours, so its reply can
        take up to 3 hours. Telegram alerts are set in the chat, separately from this list.</p><//>`;
}
