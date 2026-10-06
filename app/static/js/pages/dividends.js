// Dividends & results: every EGX company's cash dividends (coming up and recent), the results dates expected in the
// next weeks, the highest yields, your own stocks, and the bonus shares and splits of the last year. From TradingView, which gives each company's latest dividend and the
// next one once announced (so the history grows from the first download on), and Mubasher's list of announced
// bonus shares, rights issues and splits.
import { html, useApi, useState, useMemo, useStore, fmt, go, stockHref } from '../lib.js';
import { Icon, PageHead, PageLoading, SectionHead, DataTable, StockCell, Seg, Callout, Fold, Term, More } from '../ui.js';
import { t, tn } from '../i18n.js';

const SHOW = [{ value: 'all', label: 'All stocks' }, { value: 'mine', label: 'My stocks' }];

export function DividendsPage() {
  const { data, error } = useApi('/dividends');
  const { data: market } = useApi('/market');
  const stocks = useStore(s => s.stocks) || [];
  const info = useMemo(() => new Map(stocks.map(s => [s.symbol, s])), [stocks]);
  const [show, setShow] = useState('all');
  if (!data) return html`<${PageHead} title="Dividends & results" /><${PageLoading} error=${error} />`;
  const held = new Set(data.held);
  const mine = r => show === 'all' || held.has(r.symbol);
  const withInfo = r => ({ ...r, info: info.get(r.symbol) || { symbol: r.symbol }, held: held.has(r.symbol) });
  const coming = data.dividends.filter(r => r.upcoming && mine(r)).map(withInfo)
    .sort((a, b) => (a.ex_date < b.ex_date ? -1 : 1));
  const recent = data.dividends.filter(r => !r.upcoming && mine(r)).map(withInfo);
  const yields = data.yields.filter(r => (show === 'mine' ? held.has(r.symbol) : r.value >= data.min_value))
    .slice(0, show === 'mine' ? 100 : 25).map(withInfo);
  const bonus = data.bonus.filter(mine).map(withInfo);
  const actions = (data.coming || []).filter(mine).map(withInfo);

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
    { key: 'sector', label: 'Sector', sortValue: r => r.info.sector || '', render: r => html`<span class="muted">${tn(r.info.sector || '')}</span>` },
    { key: 'yield', label: 'Yield a year', align: 'r', fmt: v => html`<b class="up">${fmt.pct(v, 1, false)}</b>` },
    { key: 'value', label: 'Traded per day', align: 'r', fmt: v => (v ? `${fmt.short(v)} EGP` : '–') },
  ];
  const bonusCols = [
    { key: 'ex_date', label: 'Date', fmt: v => fmt.date(v) }, stock,
    { key: 'text', label: 'What happened', render: r => html`<span class="muted">${r.text}</span>` },
  ];
  const actionCols = [
    { key: 'effective', label: 'Ex-date', title: 'The price adjusts at the open that day',
      fmt: v => (v ? html`<b>${fmt.date(v)}</b>` : html`<span class="faint">${t('not set yet')}</span>`) },
    stock,
    { key: 'label', label: 'What', render: r => html`${r.label}${r.kind === 'dividend'
      ? html`<span class="faint"> · amount not in yet</span>` : ''}` },
    { key: 'announced', label: 'Announced', fmt: v => (v ? fmt.date(v) : '–') },
  ];
  const open = r => go(stockHref(r.symbol));

  return html`<${PageHead} title="Dividends & results"
      sub="Cash dividends of every EGX company, the highest yields, and bonus shares. Buy before the ex-date to get a dividend.">
      <${Seg} options=${SHOW} value=${show} onChange=${setShow} /><//>
    ${!data.dividends.length && html`<div style="margin-bottom:14px"><${Callout}><b>${t('No dividend data yet.')}</b> ${t('It downloads with the next scan after the close.')}<//></div>`}
    ${show === 'mine' && !held.size && html`<div style="margin-bottom:14px"><${Callout}>${t("You have no open positions, so there's nothing to show for your stocks.")}${' '}<a href="#/portfolio">${t('Log a buy in My Portfolio →')}</a><//></div>`}
    <section class="section">
      <${SectionHead} title="Coming up" count=${coming.length}
        hint="Announced dividends. On the ex-date the price usually drops by about the dividend, so it isn't free money: it's part of the return." />
      <div class="card flush"><${DataTable} columns=${cashCols} rows=${coming} rowKey=${r => r.symbol + r.ex_date}
        onRowClick=${open} empty="No dividend announced for the coming weeks yet." /></div>
    </section>
    ${market && market.results && html`<${Results} rows=${market.results.filter(mine)} />`}
    <section class="section">
      <${SectionHead} title="Also announced: bonus shares, rights issues and more" count=${actions.length}
        hint="From Mubasher's list of the exchange's filings. Bonus shares and splits re-base the price (you get more shares); a rights issue usually adjusts it. Cash dividends here don't have an amount on TradingView yet." />
      <div class="card flush"><${DataTable} columns=${actionCols} rows=${actions} rowKey=${r => r.symbol + r.type + r.effective}
        onRowClick=${open} empty="Nothing else announced for the coming weeks." /></div>
      ${data.rights_history && html`<${RightsPast} h=${data.rights_history} open=${actions.some(a => a.kind === 'rights')} />`}
    </section>
    <section class="section">
      <${SectionHead} title=${show === 'mine' ? 'Yields of your stocks' : 'Highest yields'}
        hint=${show === 'mine' ? "The last 12 months of cash dividends ÷ today's price."
          : t("The last 12 months of cash dividends ÷ today's price, among stocks trading at least {v} EGP a day. A very high yield can mean the price fell, or a one-off payout.", { v: fmt.short(data.min_value) })} />
      <div class="card flush"><${DataTable} columns=${yieldCols} rows=${yields} rowKey=${r => r.symbol}
        sort=${{ key: 'yield', dir: 'desc' }} onRowClick=${open} empty="None of these pays a cash dividend." /></div>
    </section>
    <${Fold} title="Recent dividends" hint=${t('{n} ex-dates that have passed, newest first.', { n: recent.length })} flush>
      <${DataTable} columns=${cashCols} rows=${recent} rowKey=${r => r.symbol + r.ex_date}
        limit=${25} onRowClick=${open} empty="None yet." /><//>
    <${Fold} title="Bonus shares and splits" hint=${t('{n} in the last year.', { n: bonus.length })} flush>
      <${DataTable} columns=${bonusCols} rows=${bonus} rowKey=${r => r.symbol + r.ex_date}
        onRowClick=${open} empty="None in the last year." /><//>
    ${data.updated && html`<p class="faint" style="font-size:12px;margin-top:12px">From TradingView, last updated${' '}
      ${fmt.datetime(data.updated)}. It gives each company's latest dividend and the next one once announced, so older
      ones appear as the agent sees them.</p>`}`;
}

// When companies are expected to publish results in the next few weeks (TradingView's estimates).
function Results({ rows }) {
  const today = new Date(new Date().toDateString());
  const days = d => Math.round((new Date(d + 'T00:00:00') - today) / 864e5);
  const columns = [
    { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} sub=${r.name} />` },
    { key: 'date', label: 'Expected', render: r => html`<b>${fmt.date(r.date)}</b>` },
    { key: 'in', label: 'In', align: 'r', sortValue: r => r.date, render: r => {
      const n = days(r.date);
      return html`<span class="muted">${n <= 0 ? t('Today') : n === 1 ? t('tomorrow') : t('{n} days', { n })}</span>`;
    } },
  ];
  return html`<section class="section">
    <${SectionHead} title=${html`<${Term} k="results">${t('Results coming')}<//>`} count=${rows.length}
      hint="Expected dates from TradingView (estimates). Prices can move a lot on results day." />
    <div class="card flush"><${DataTable} columns=${columns} rows=${rows} rowKey=${r => r.symbol}
      sort=${{ key: 'date', dir: 'asc' }} empty="No results expected in the next 6 weeks." limit=${10} /></div>
    <${More} label="Where these dates come from">
      <p>${t("TradingView estimates each company's next results date from when it reported before; EGX companies often publish a few days earlier or later. Only companies that reported on TradingView in the last 13 months are listed.")}</p><//>
  </section>`;
}

// What EGX stocks did around their past rights issues (egx_agent/corporate.py rights_history). Facts, not a forecast.
function RightsPast({ h, open }) {
  const p = v => fmt.pct(v, 0, false), r = v => fmt.pct(v, 1);
  return html`<${More} label=${t('What happened around {n} past rights issues on EGX (since {year})', { n: h.n, year: h.since })} open=${open}>
    <ul class="reasons">
      <li>${t('Bought at the close before the ex-date (the last day that gets the rights): up on the ex-date {up} of the time, typically {median}.', { up: p(h.ex_day.up), median: r(h.ex_day.median) })}</li>
      <li>${t('A week later most of that was gone: up {up} of the time, typically {median}.', { up: p(h.week.up), median: r(h.week.median) })}</li>
      <li>${t('Three months later: up {up} of the time, typically {median}, and ahead of EGX30 {beat} of the time. 1 in 10 lost {p10} or more; 1 in 10 gained {p90} or more.', { up: p(h.quarter.up), median: r(h.quarter.median), beat: p(h.quarter.beat), p10: fmt.pct(-h.quarter.p10, 0, false), p90: fmt.pct(h.quarter.p90, 0, false) })}</li>
      <li>${t('Bought on the announcement instead and held to the same day: ahead of EGX30 only {beat} of the time.', { beat: p(h.announced.beat) })}</li>
      <li>${t('Bought on the ex-date itself (no rights then): down a week later {down} of the time, typically {median}.', { down: p(1 - h.after.up), median: r(h.after.median) })}</li>
    </ul>
    <p class="faint">${t("These count the rights at their worth: you get that only if you subscribe and pay for the new shares, or sell the rights while they trade (they can sell for less). New shares can't be sold until they're listed, weeks after the subscription. Past rights issues, not a forecast for any one stock.")}</p><//>`;
}
