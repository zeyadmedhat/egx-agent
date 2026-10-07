// Market overview: breadth (how many stocks rise with the index), the biggest movers and which sectors lead. Context
// only; the BUY rules don't use it. The coming results dates are on the Dividends & results tab.
import { html, useApi, useState, useStore, fmt, tone, stockHref } from '../lib.js';
import {
  Kpi, Callout, PageHead, SectionHead, PageLoading, DataTable, Empty, MarketSwitch, Seg, Term, SessionBadge,
  Fold, More,
} from '../ui.js';
import { t, tp, tn } from '../i18n.js';
import { BreadthChart } from '../charts.js';

const TONE = { ok: 'ok', warn: 'warn', bad: 'bad' };

function Heat({ v }) {
  if (v == null) return html`<span class="faint">–</span>`;
  const strength = Math.min(42, Math.abs(v) * 420);   // ±10% → strongest colour
  const color = v >= 0 ? 'var(--up)' : 'var(--down)';
  return html`<span class="heat" style=${`background:color-mix(in srgb, ${color} ${strength}%, transparent)`}>${fmt.pct(v, 1)}</span>`;
}

function Gauge({ v }) {
  const tn = v >= 0.6 ? 'up' : v >= 0.4 ? 'warn' : 'down';
  return html`<div class="gauge"><b class="gauge-v">${fmt.pct(v, 0, false)}</b>
    <div class=${`bar ${tn}`}><span style=${`width:${v * 100}%`}></span></div></div>`;
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
    { key: 'sector', label: 'Sector', render: r => html`<b>${tn(r.sector)}</b>` },
    { key: 'stocks', label: 'Stocks', align: 'r' },
    { key: 'above50', label: 'Above 50-day avg', width: '190px', render: r => html`<${Gauge} v=${r.above50} />` },
    { key: 'r5', label: '1 week', align: 'r', render: r => html`<${Heat} v=${r.r5} />` },
    { key: 'r21', label: '1 month', align: 'r', render: r => html`<${Heat} v=${r.r21} />` },
    { key: 'r63', label: '3 months', align: 'r', render: r => html`<${Heat} v=${r.r63} />` },
    { key: 'leaders', label: 'Strongest (1 month)', sortable: false, render: r => html`<div class="sector-leaders">
      ${r.leaders.map(l => html`<a href=${stockHref(l.symbol)} title=${`${fmt.pct(l.r21, 1)} in a month`}>${l.symbol}</a>`)}</div>` },
  ];
  return html`
    <${PageHead} title="Market" sub=${t('How many stocks rise with the index, from the {date} close.', { date: fmt.date(b.date) })}>
      <${SessionBadge} dataDate=${b.date} /><//>
    ${data.mood && html`<${Mood} m=${data.mood} />`}
    <${Callout} tone=${TONE[v.tone]}><b>${t(v.text)}</b>${change != null
      ? ' ' + t(change >= 0 ? '{pct} of {n} stocks are above their 50-day average, up {pts} points in a week.'
        : '{pct} of {n} stocks are above their 50-day average, down {pts} points in a week.',
      { pct: fmt.pct(b.above50, 0, false), n: b.stocks, pts: fmt.int(Math.abs(change * 100)) })
      : ''}<//>
    ${v.switch && html`<div style="margin-top:10px"><${MarketSwitch} sw=${v.switch} compact /></div>`}
    <div class="kpis" style="margin-top:14px">
      <${Kpi} label=${html`<${Term} k="breadth">${t('Above 50-day average')}<//>`} value=${fmt.pct(b.above50, 0, false)}
        valueClass=${b.above50 >= 0.6 ? 'up' : b.above50 < 0.4 ? 'down' : 'warn'}
        sub=${b.above50_week_ago != null ? t('{pct} a week ago', { pct: fmt.pct(b.above50_week_ago, 0, false) }) : 'medium-term trend'} />
      <${Kpi} label="Up / down last session" value=${html`<span class="up">${b.advancers}</span> / <span class="down">${b.decliners}</span>`}
        sub=${t('{n} unchanged', { n: b.unchanged })} />
      <${Kpi} label="52-week highs / lows" value=${html`<span class="up">${b.new_highs}</span> / <span class="down">${b.new_lows}</span>`}
        sub="stocks at a 1-year high or low" />
    </div>

    ${data.movers && html`<${Movers} data=${data} />`}

    <section class="section">
      <${SectionHead} title="Sectors" count=${b.sectors.length}
        hint="Median return of the sector's stocks. Sectors with one or two stocks move with those names alone." />
      <div class="card flush"><${DataTable} columns=${columns} rows=${b.sectors} rowKey=${r => r.sector}
        sort=${{ key: 'r21', dir: 'desc' }} /></div>
    </section>
    <${Fold} title="Stocks in uptrend vs EGX30" hint="1 year. When most stocks are above their averages, breakouts have more support." flush>
      <${BreadthChart} h=${b.history} /><//>
    <${Fold} title="Short- and long-term trend" hint="How many stocks are above their 20- and 200-day averages.">
      <div class="kpis">
        <${Kpi} label="Above 20-day average" value=${fmt.pct(b.above20, 0, false)} sub="short-term trend" />
        <${Kpi} label="Above 200-day average" value=${fmt.pct(b.above200, 0, false)} sub="long-term trend" />
      </div><//>`;
}

const PERIODS = [{ value: 'chg1', label: 'Last session' }, { value: 'ret5', label: '1 week' }, { value: 'ret21', label: '1 month' }];

// The actively traded stocks that moved most, and the stocks at a 1-year high or low at the last close.
function Movers({ data }) {
  const [period, setPeriod] = useState('ret5');
  const stocks = useStore(s => s.stocks) || [];
  const name = sym => (stocks.find(s => s.symbol === sym) || {}).name_ar || '';
  const m = data.movers[period];
  const list = rows => html`<div class="mover-list">${rows.map(r => html`<a class="mover" href=${stockHref(r.symbol)}>
    <span><b>${r.symbol}</b><span class="faint" dir="auto">${name(r.symbol)}</span></span>
    <span class="price">${fmt.price(r.close)}</span><b class=${tone(r.ret)}>${fmt.pct(r.ret, 1)}</b></a>`)}</div>`;
  const chips = syms => (syms.length ? html`<div class="sector-leaders">${syms.map(s => html`<a href=${stockHref(s)}>${s}</a>`)}</div>`
    : html`<p class="muted" style="font-size:13px">${t('None today.')}</p>`);
  return html`
    <section class="section">
      <${SectionHead} title="Biggest movers"
        hint="Among actively traded stocks (enough daily trading for the BUY rules). A stock that jumped more than 30% in one day is left out: that's a split or bonus shares the prices don't reflect yet.">
        <${Seg} options=${PERIODS} value=${period} onChange=${setPeriod} /><//>
      <div class="grid grid-2">
        <div class="card"><div class="card-title up">${t('Rose most')}</div>${list(m.up)}</div>
        <div class="card"><div class="card-title down">${t('Fell most')}</div>${list(m.down)}</div>
      </div>
    </section>
    <${Fold} title="At a 1-year high or low" hint=${`${data.highs.length} ${t('1-year highs')} · ${data.lows.length} ${t('1-year lows')}`}>
      <div class="grid grid-2">
        <div class="card"><div class="card-title up">${t('1-year highs')} · ${data.highs.length}</div>${chips(data.highs)}</div>
        <div class="card"><div class="card-title down">${t('1-year lows')} · ${data.lows.length}</div>${chips(data.lows)}</div>
      </div><//>`;
}

// Market mood (egx_agent/mood.py): a fear & greed gauge built like CNN's from six EGX measures, each scored against
// the last two years. Context only: tested since 2018, it didn't tell where EGX30 went next.
const MOOD_TONE = s => (s < 45 ? 'down' : s < 56 ? 'warn' : 'up');
function partValue(p) {
  if (p.value == null) return '–';
  if (p.key === 'calm') return t('{x}× its usual swings', { x: fmt.num(-p.value, 2) });
  return p.key === 'foreign' ? t('{pct} of the money traded', { pct: fmt.pct(p.value, 1) }) : fmt.pct(p.value, 1);
}
// The last session's net buying (+) or selling (−) by each group, in million EGP (egx_agent/data/flows.py)
function Flows({ f }) {
  const v = x => html`<b class=${tone(x)}>${x > 0 ? '+' : x < 0 ? '−' : ''}${fmt.num(Math.abs(x), 1)}</b>`;
  return html`<p class="faint" style="font-size:13px;margin-top:10px">${tp('Net buying on {date}, million EGP: Egyptians {e} · Arabs {a} · foreigners {f}. From the exchange\'s daily statement, as Amwal Al Ghad reports it.',
    { date: fmt.date(f.date), e: v(f.egyptians), a: v(f.arabs), f: v(f.foreigners) })}</p>`;
}
function Mood({ m }) {
  const s = Math.round(m.score);
  const past = [
    { key: 'label', label: 'Mood', render: r => html`<b>${t(r.label)}</b>` },
    { key: 'sessions', label: 'Sessions', align: 'r' },
    { key: 'up', label: 'Up after a month', align: 'r', fmt: v => fmt.pct(v, 0, false) },
    { key: 'median', label: 'Typical month', align: 'r', render: r => html`<${Heat} v=${r.median} />` },
  ];
  return html`<div class="card mood">
    <div class="card-title">${t('Market mood')}</div>
    <div class="mood-head"><b class=${`mood-score ${MOOD_TONE(m.score)}`}>${s}</b>
      <span><b class=${MOOD_TONE(m.score)}>${t(m.label)}</b><span class="faint"> · ${t('0 = extreme fear, 100 = extreme greed')}</span>
      ${m.week_ago != null && html`<br /><span class="faint">${t('{n} a week ago', { n: Math.round(m.week_ago) })}</span>`}</span></div>
    <div class="mood-scale"><span style=${`inset-inline-start:${Math.max(0, Math.min(100, m.score))}%`}></span></div>
    <div class="mood-parts">${m.parts.map(p => html`<div class="mood-part">
      <span>${t(p.text)} <span class="faint">${partValue(p)}</span></span>
      ${p.score == null ? html`<span class="faint">–</span>` : html`<div class="gauge"><b class="gauge-v">${Math.round(p.score)}</b>
        <div class=${`bar ${MOOD_TONE(p.score)}`}><span style=${`width:${p.score}%`}></span></div></div>`}</div>`)}</div>
    ${m.flows && html`<${Flows} f=${m.flows} />`}
    <${More} label="How it's made, and what it told in the past">
      <p>${t("Built like CNN's Fear & Greed Index. Each measure scores 0–100 by where today's value sits among the last two years', and the mood is their average. CNN's options and junk-bond measures don't exist on EGX; small companies against EGX30 stand in for the appetite for risk. The seventh, foreign and Arab investors' net buying, is EGX's own.")}</p>
      <p>${t("Tested since {date}: it didn't tell where EGX30 went next. The differences below are small and changed from one period to another, so use it to know the mood, not to time a buy or a sale.", { date: fmt.date(m.since) })}</p>
      <${DataTable} columns=${past} rows=${m.past} rowKey=${r => r.label} /><//>
  </div>`;
}
