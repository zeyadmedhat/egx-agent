// Market: breadth (how many stocks rise with the index) and which sectors lead. Context only; the BUY rules don't use it.
import { html, useApi, fmt, stockHref } from '../lib.js';
import { Kpi, Callout, PageHead, SectionHead, Disclaimer, PageLoading, DataTable, Empty, MarketSwitch } from '../ui.js';
import { BreadthChart } from '../charts.js';

const TONE = { ok: 'ok', warn: 'warn', bad: 'bad' };

function Heat({ v }) {
  if (v == null) return html`<span class="faint">–</span>`;
  const strength = Math.min(42, Math.abs(v) * 420);   // ±10% → strongest colour
  const color = v >= 0 ? 'var(--up)' : 'var(--down)';
  return html`<span class="heat" style=${`background:color-mix(in srgb, ${color} ${strength}%, transparent)`}>${fmt.pct(v, 1)}</span>`;
}

function Gauge({ v }) {
  const t = v >= 0.6 ? 'up' : v >= 0.4 ? 'warn' : 'down';
  return html`<div class="gauge"><b style="width:38px;text-align:right">${fmt.pct(v, 0, false)}</b>
    <div class=${`bar ${t}`}><span style=${`width:${v * 100}%`}></span></div></div>`;
}

export function MarketPage() {
  const { data, error } = useApi('/market');
  if (!data) return html`<${PageLoading} error=${error} />`;
  const b = data.breadth;
  if (!b) {
    return html`<${PageHead} title="Market" /><div class="card"><${Empty} icon="bars" title="No price data yet"
      text="Run a scan first. The breadth numbers are calculated from every stock's price history." /></div>`;
  }
  const v = data.verdict;
  const change = v.change_week;
  const columns = [
    { key: 'sector', label: 'Sector', render: r => html`<b>${r.sector}</b>` },
    { key: 'stocks', label: 'Stocks', align: 'r' },
    { key: 'above50', label: 'Above 50-day avg', width: '190px', render: r => html`<${Gauge} v=${r.above50} />` },
    { key: 'r5', label: '1 week', align: 'r', render: r => html`<${Heat} v=${r.r5} />` },
    { key: 'r21', label: '1 month', align: 'r', render: r => html`<${Heat} v=${r.r21} />` },
    { key: 'r63', label: '3 months', align: 'r', render: r => html`<${Heat} v=${r.r63} />` },
    { key: 'leaders', label: 'Strongest (1 month)', sortable: false, render: r => html`<div class="sector-leaders">
      ${r.leaders.map(l => html`<a href=${stockHref(l.symbol)} title=${`${fmt.pct(l.r21, 1)} in a month`}>${l.symbol}</a>`)}</div>` },
  ];
  return html`
    <${PageHead} title="Market"
      sub=${`How many EGX stocks are rising along with the index, from the ${fmt.date(b.date)} close. Context for you: it doesn't change the BUY rules.`} />
    <${Callout} tone=${TONE[v.tone]}><b>${v.text}</b>${change != null
      ? ` ${fmt.pct(b.above50, 0, false)} of ${b.stocks} stocks are above their 50-day average, ${change >= 0 ? 'up' : 'down'} ${fmt.int(Math.abs(change * 100))} points in a week.`
      : ''}<//>
    ${v.switch && html`<div style="margin-top:10px"><${MarketSwitch} sw=${v.switch} /></div>`}
    <div class="kpis" style="margin-top:14px">
      <${Kpi} label="Above 50-day average" icon="bars" value=${fmt.pct(b.above50, 0, false)}
        valueClass=${b.above50 >= 0.6 ? 'up' : b.above50 < 0.4 ? 'down' : 'warn'}
        sub=${b.above50_week_ago != null ? `${fmt.pct(b.above50_week_ago, 0, false)} a week ago` : 'medium-term trend'} />
      <${Kpi} label="Above 20-day average" value=${fmt.pct(b.above20, 0, false)} sub="short-term trend" />
      <${Kpi} label="Above 200-day average" value=${fmt.pct(b.above200, 0, false)} sub="long-term trend" />
      <${Kpi} label="Up / down last session" value=${html`<span class="up">${b.advancers}</span> / <span class="down">${b.decliners}</span>`}
        sub=${`${b.unchanged} unchanged`} />
      <${Kpi} label="52-week highs / lows" value=${html`<span class="up">${b.new_highs}</span> / <span class="down">${b.new_lows}</span>`}
        sub="stocks at a 1-year high or low" />
    </div>

    <section class="section">
      <${SectionHead} title="Breadth vs EGX30" hint="1 year. When most stocks are above their averages, breakouts have more support." />
      <div class="card flush"><${BreadthChart} h=${b.history} /></div>
    </section>

    <section class="section">
      <${SectionHead} title="Sectors" count=${b.sectors.length}
        hint="Median return of the sector's stocks. Sectors with one or two stocks move with those names alone." />
      <div class="card flush"><${DataTable} columns=${columns} rows=${b.sectors} rowKey=${r => r.sector}
        sort=${{ key: 'r21', dir: 'desc' }} /></div>
    </section>
    <${Disclaimer} />`;
}
