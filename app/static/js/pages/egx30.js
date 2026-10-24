// EGX30: the index's chart with its averages, where it stands, its returns in pounds and in dollars (and EGX70's),
// each year's, how jumpy it is, and the agent's rule about it (views.index_view). Context only.
import { html, useApi, useState, fmt, tone, cls, remember } from '../lib.js';
import { Kpi, Callout, PageHead, SectionHead, PageLoading, DataTable, Seg, Fold, Change, LiveChart, Empty, More, Icon, sources } from '../ui.js';
import { t } from '../i18n.js';
import { PriceChart, LineChart } from '../charts.js';

const RANGES = [
  { value: 60, label: '3M' }, { value: 120, label: '6M' }, { value: 250, label: '1Y' }, { value: 500, label: '2Y' },
  { value: 1250, label: '5Y' }, { value: 100000, label: 'All' },
];
const VIEWS = [{ value: 'agent', label: 'Agent chart' }, { value: 'live', label: 'Live (TradingView)' }];
const PANES = [['zones', 'Support & resistance'], ['fib', 'Fibonacci'], ['ema', 'Averages'], ['volume', 'Volume'], ['rsi', 'RSI'], ['macd', 'MACD']];
const PERIOD = { '1W': '1 week', '1M': '1 month', '3M': '3 months', '6M': '6 months', YTD: 'This year', '1Y': '1 year',
  '3Y': '3 years', '5Y': '5 years' };
const pct = v => (v == null ? html`<span class="faint">–</span>` : html`<b class=${tone(v)}>${fmt.pct(v, 1)}</b>`);

export function Egx30Page() {
  const { data, error } = useApi('/egx30');
  const [bars, setBars] = useState(Number(remember('egx30-bars')) || 250);
  const [view, setView] = useState('agent');
  const [show, setShow] = useState({ zones: true, fib: false, ema: true, volume: false, rsi: true, macd: false });
  if (!data) return html`<${PageLoading} error=${error} />`;
  if (!data.has_data) {
    return html`<${PageHead} title="EGX30" /><div class="card"><${Empty} icon="bars" title="No price data yet"
      text="Run a scan first." /></div>`;
  }
  const d = data;
  const vs = v => d.close / v - 1;
  const avg = { v: fmt.int(d.ema50) };
  return html`
    <${PageHead} title="EGX30" sub=${t("Egypt's 30 biggest and most traded companies, from the {date} close.", { date: fmt.date(d.date) })}>
      <div class="egx30-price"><b class="num">${fmt.int(d.close)}</b> <${Change} value=${d.change} pill /></div><//>
    ${d.risk_off != null && html`<${Callout} tone=${d.risk_off ? 'warn' : 'ok'}>${d.risk_off
      ? html`<b>${t('Under its 50-day average ({v}).', avg)}</b> ${t('The agent gives no new BUYs until EGX30 closes back above it.')}`
      : html`<b>${t('Above its 50-day average ({v}).', avg)}</b> ${t('New BUYs are allowed.')}`}<//>`}
    <div class="kpis" style="margin-top:14px">
      <${Kpi} label="vs its 50-day average" value=${fmt.pct(vs(d.ema50), 1)} valueClass=${tone(vs(d.ema50))}
        sub=${t('average {v}', avg)} />
      <${Kpi} label="vs its 200-day average" value=${fmt.pct(vs(d.ema200), 1)} valueClass=${tone(vs(d.ema200))}
        sub=${t('average {v}', { v: fmt.int(d.ema200) })} />
      <${Kpi} label="1-year low – high" value=${`${fmt.int(d.low52)} – ${fmt.int(d.high52)}`} />
      <${Kpi} label="From its record close" value=${fmt.pct(d.from_ath, 1)} valueClass=${tone(d.from_ath)}
        sub=${`${fmt.int(d.ath)} · ${fmt.date(d.ath_date)}`} />
      ${d.usd_close != null && html`<${Kpi} label="In dollars" value=${`$${fmt.int(d.usd_close)}`}
        sub=${t('{v} pounds a dollar', { v: fmt.num(d.close / d.usd_close, 2) })} />`}
      ${d.above50 != null && html`<${Kpi} label="Stocks above their 50-day average" value=${fmt.pct(d.above50, 0, false)}
        valueClass=${d.above50 >= 0.5 ? 'up' : d.above50 < 0.4 ? 'down' : 'warn'} sub=${html`<a href="#/market">${t('the whole market')}</a>`} />`}
    </div>

    <div class="card chart-card" style="margin-top:14px">
      <div class="chart-toolbar">
        <${Seg} options=${VIEWS} value=${view} onChange=${setView} />
        ${view === 'agent' && html`<${Seg} options=${RANGES} value=${bars} onChange=${v => { setBars(v); remember('egx30-bars', v); }} />
          <div class="right">${PANES.map(([k, label]) => html`<button class=${cls('toggle-chip', show[k] && 'on')}
            onClick=${() => setShow(s => ({ ...s, [k]: !s[k] }))}>${t(label)}</button>`)}</div>`}
      </div>
      ${view === 'agent' ? html`<${PriceChart} series=${d.series} bars=${bars} show=${show} chart=${d.levels} />` : html`<${LiveChart} symbol="EGX30" />`}
    </div>

    ${d.levels && html`<${Levels} z=${d.levels} />`}

    <section class="section">
      <${SectionHead} title="Returns" hint="In dollars: what a dollar investor made, after the pound's moves. EGX70: smaller companies, all weighted the same." />
      <div class="card flush"><${DataTable} rows=${d.periods} rowKey=${r => r.key} columns=${[
        { key: 'key', label: 'Period', sortable: false, render: r => html`<b>${t(PERIOD[r.key] || r.key)}</b>` },
        { key: 'egp', label: 'In pounds', align: 'r', sortable: false, render: r => pct(r.egp) },
        { key: 'usd', label: 'In dollars', align: 'r', sortable: false, render: r => pct(r.usd) },
        { key: 'egx70', label: 'EGX70', align: 'r', sortable: false, render: r => pct(r.egx70) },
      ]} /></div>
    </section>

    <${Fold} title="Each year" hint=${t('{n} years, in pounds and in dollars', { n: d.years.length })} flush>
      <${DataTable} rows=${d.years} rowKey=${r => r.year} columns=${[
        { key: 'year', label: 'Year', sortable: false, render: r => html`<b>${r.year}</b>${r.partial ? html` <span class="faint">${t('so far')}</span>` : ''}` },
        { key: 'egp', label: 'In pounds', align: 'r', sortable: false, render: r => pct(r.egp) },
        { key: 'usd', label: 'In dollars', align: 'r', sortable: false, render: r => pct(r.usd) },
      ]} /><//>
    ${d.usd_line.length > 0 && html`<${Fold} title="EGX30 in dollars" hint="A rise in pounds can be a loss in dollars when the pound falls." flush>
      <${LineChart} lines=${[{ data: d.usd_line, color: '--accent', title: t('EGX30 in dollars'), area: true }]} format="usd" /><//>`}
    <${Fold} title="How jumpy it is" hint=${t('{v} a year (volatility)', { v: fmt.pct(d.volatility, 0, false) })}>
      <div class="kpis">
        <${Kpi} label="Biggest drop in the last year" value=${fmt.pct(d.drop_1y, 1)} valueClass="down" sub="from a high to the low after it" />
        <${Kpi} label="Best day" value=${fmt.pct(d.best_day.ret, 1)} valueClass="up" sub=${fmt.date(d.best_day.date)} />
        <${Kpi} label="Worst day" value=${fmt.pct(d.worst_day.ret, 1)} valueClass="down" sub=${fmt.date(d.worst_day.date)} />
        <${Kpi} label="Days it rose" value=${fmt.pct(d.up_days, 0, false)} sub="in the last year" />
        <${Kpi} label="RSI" value=${fmt.num(d.rsi14, 0)} sub=${d.rsi14 >= 70 ? t('stretched up') : d.rsi14 <= 30 ? t('stretched down') : t('neither stretched up nor down')} />
      </div><//>`;
}

// Support and resistance around the last close (egx_agent/levels.py nearby): the same tools as a stock's levels.
const dots = z => '●'.repeat(Math.min(5, Math.round(z.strength / 1.5)) || 1);
function Levels({ z }) {
  const zone = (x, down) => html`<div class=${cls('zone', down ? 'down' : 'up')}><span class="p">${fmt.int(x.price)}
      <small><span dir="ltr">${fmt.pct(x.price / z.close - 1, 1)}</span></small></span>
    <span class="s" title=${t('Strength')}>${dots(x)}</span><span class="w">${sources(x.sources)}</span></div>`;
  const s1 = z.supports[0], r1 = z.resistances[0];
  return html`<div class="card" style="margin-top:14px">
    <div class="card-title"><${Icon} name="target" size=${15} />${t('Support & resistance')}
      <span class="right faint">${[s1 && t('support {v}', { v: fmt.int(s1.price) }), r1 && t('resistance {v}', { v: fmt.int(r1.price) })]
        .filter(Boolean).join(' · ')}</span></div>
    <div class="zone-list">
      ${z.resistances.slice().reverse().map(x => zone(x, false))}
      <div class="zone now"><span class="p">${fmt.int(z.close)}</span><span>${t('Last close')}${z.at
        ? html` · <span class="faint">${t('on a level: {what}', { what: sources(z.at.sources) })}</span>` : ''}</span></div>
      ${z.supports.map(x => zone(x, true))}</div>
    <p class="faint" style="font-size:12px;margin-top:8px">${t('More dots: more tools agree on the level.')}</p>
    <${More} label="How these are worked out"><p>${t(LEVELS_HOW)}</p><//>
  </div>`;
}

const LEVELS_HOW = 'Prices where buyers or sellers stepped in before: the index\'s swing lows and highs of the last year, '
  + 'Fibonacci retracements (23.6–78.6%) and extensions of its latest big rise, its 20- and 50-day averages, monthly '
  + 'pivot points, the level where the most shares traded in 6 months and the 1-year high, the same tools as each '
  + 'stock\'s levels. Levels that sit together make one zone; the more tools agree, the stronger it is. They show where '
  + 'the index has turned before, not where it will turn.';
