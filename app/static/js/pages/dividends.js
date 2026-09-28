// Dividends: every EGX company's cash dividends (coming up and recent), the highest yields, your own stocks, and
// the bonus shares and splits of the last year. From TradingView, which gives each company's latest dividend and the
// next one once announced, so the history grows from the first download on.
import { html, useApi, useState, useMemo, useStore, fmt, go, stockHref } from '../lib.js';
import { Icon, PageHead, PageLoading, SectionHead, DataTable, StockCell, Seg, Disclaimer, Callout } from '../ui.js';

const SHOW = [{ value: 'all', label: 'All stocks' }, { value: 'mine', label: 'My stocks' }];

export function DividendsPage() {
  const { data, error } = useApi('/dividends');
  const stocks = useStore(s => s.stocks) || [];
  const info = useMemo(() => new Map(stocks.map(s => [s.symbol, s])), [stocks]);
  const [show, setShow] = useState('all');
  if (!data) return html`<${PageHead} title="Dividends" /><${PageLoading} error=${error} />`;
  const held = new Set(data.held);
  const mine = r => show === 'all' || held.has(r.symbol);
  const withInfo = r => ({ ...r, info: info.get(r.symbol) || { symbol: r.symbol }, held: held.has(r.symbol) });
  const coming = data.dividends.filter(r => r.upcoming && mine(r)).map(withInfo)
    .sort((a, b) => (a.ex_date < b.ex_date ? -1 : 1));
  const recent = data.dividends.filter(r => !r.upcoming && mine(r)).map(withInfo);
  const yields = data.yields.filter(r => (show === 'mine' ? held.has(r.symbol) : r.value >= data.min_value))
    .slice(0, show === 'mine' ? 100 : 25).map(withInfo);
  const bonus = data.bonus.filter(mine).map(withInfo);

  const stock = { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} info=${r.info}
    sub=${r.held ? html`<span class="tag"><${Icon} name="briefcase" size=${11} />You hold it</span>` : undefined} />` };
  const cashCols = [
    { key: 'ex_date', label: 'Ex-date', title: 'Buy before this day to get the dividend', fmt: v => html`<b>${fmt.date(v)}</b>` },
    stock,
    { key: 'amount', label: 'Per share', align: 'r', fmt: v => `${fmt.num(v, v < 1 ? 3 : 2)} EGP` },
    { key: 'pct', label: 'Of the price', align: 'r', fmt: v => html`<span class="up">${fmt.pct(v, 1, false)}</span>` },
    { key: 'pay_date', label: 'Paid', fmt: v => (v ? fmt.date(v) : html`<span class="faint">not set yet</span>`) },
  ];
  const yieldCols = [
    stock,
    { key: 'sector', label: 'Sector', sortValue: r => r.info.sector || '', render: r => html`<span class="muted">${r.info.sector || ''}</span>` },
    { key: 'yield', label: 'Yield a year', align: 'r', fmt: v => html`<b class="up">${fmt.pct(v, 1, false)}</b>` },
    { key: 'value', label: 'Traded per day', align: 'r', fmt: v => (v ? `${fmt.short(v)} EGP` : '–') },
  ];
  const bonusCols = [
    { key: 'ex_date', label: 'Date', fmt: v => fmt.date(v) }, stock,
    { key: 'text', label: 'What happened', render: r => html`<span class="muted">${r.text}</span>` },
  ];
  const open = r => go(stockHref(r.symbol));

  return html`<${PageHead} title="Dividends"
      sub="Cash dividends of every EGX company, the highest yields, and bonus shares. Buy before the ex-date to get a dividend.">
      <${Seg} options=${SHOW} value=${show} onChange=${setShow} /><//>
    ${!data.dividends.length && html`<div style="margin-bottom:14px"><${Callout}><b>No dividend data yet.</b> It downloads
      with the next scan after the close.<//></div>`}
    ${show === 'mine' && !held.size && html`<div style="margin-bottom:14px"><${Callout}>You have no open positions, so
      there's nothing to show for your stocks.${' '}<a href="#/portfolio">Log a buy in My Portfolio →</a><//></div>`}
    <section class="section">
      <${SectionHead} title="Coming up" count=${coming.length}
        hint="Announced dividends. On the ex-date the price usually drops by about the dividend, so it isn't free money: it's part of the return." />
      <div class="card flush"><${DataTable} columns=${cashCols} rows=${coming} rowKey=${r => r.symbol + r.ex_date}
        onRowClick=${open} empty="No dividend announced for the coming weeks yet." /></div>
    </section>
    <section class="section">
      <${SectionHead} title=${show === 'mine' ? 'Yields of your stocks' : 'Highest yields'}
        hint=${show === 'mine' ? "The last 12 months of cash dividends ÷ today's price."
          : `The last 12 months of cash dividends ÷ today's price, among stocks trading at least ${fmt.short(data.min_value)} EGP a day. A very high yield can mean the price fell, or a one-off payout.`} />
      <div class="card flush"><${DataTable} columns=${yieldCols} rows=${yields} rowKey=${r => r.symbol}
        sort=${{ key: 'yield', dir: 'desc' }} onRowClick=${open} empty="None of these pays a cash dividend." /></div>
    </section>
    <section class="section">
      <${SectionHead} title="Recent dividends" count=${recent.length} hint="Ex-dates that have passed, newest first." />
      <div class="card flush"><${DataTable} columns=${cashCols} rows=${recent} rowKey=${r => r.symbol + r.ex_date}
        limit=${25} onRowClick=${open} empty="None yet." /></div>
    </section>
    <section class="section">
      <${SectionHead} title="Bonus shares and splits" count=${bonus.length}
        hint="From the last year, found in the prices. If you held the stock, My Portfolio asks you to update your share count." />
      <div class="card flush"><${DataTable} columns=${bonusCols} rows=${bonus} rowKey=${r => r.symbol + r.ex_date}
        onRowClick=${open} empty="None in the last year." /></div>
    </section>
    ${data.updated && html`<p class="faint" style="font-size:12px;margin-top:12px">From TradingView, last updated${' '}
      ${fmt.datetime(data.updated)}. It gives each company's latest dividend and the next one once announced, so older
      ones appear as the agent sees them.</p>`}
    <${Disclaimer} />`;
}
