// Market overview: breadth (how many stocks rise with the index), the biggest movers and which sectors lead. Context
// only; the BUY rules don't use it. The coming results dates are on the Dividends & results tab.
import { html, useApi, useState, useStore, fmt, tone, stockHref } from '../lib.js';
import {
  Kpi, Callout, PageHead, SectionHead, PageLoading, DataTable, Empty, MarketSwitch, Seg, Term, SessionBadge,
  Fold, More,
} from '../ui.js';
import { t, tp, tn } from '../i18n.js';
import { BreadthChart, MoodChart } from '../charts.js';

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
    ${data.investors && data.investors.length > 0 && html`<${Investors} days=${data.investors} />`}
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
      <${SectorBars} rows=${b.sectors} />
      ${data.sector_money && data.sector_money.length > 0 && html`<${SectorMoney} rows=${data.sector_money} />`}
      <${Fold} title="Every sector in a table" hint="How many of its stocks are above their 50-day average, and its strongest names." flush>
        <${DataTable} columns=${columns} rows=${b.sectors} rowKey=${r => r.sector} sort=${{ key: 'r21', dir: 'desc' }} /><//>
    </section>
    <${Fold} title="Stocks in uptrend vs EGX30" hint="1 year. When most stocks are above their averages, breakouts have more support." flush>
      <${BreadthChart} h=${b.history} /><//>
    <${Fold} title="Short- and long-term trend" hint="How many stocks are above their 20- and 200-day averages.">
      <div class="kpis">
        <${Kpi} label="Above 20-day average" value=${fmt.pct(b.above20, 0, false)} sub="short-term trend" />
        <${Kpi} label="Above 200-day average" value=${fmt.pct(b.above200, 0, false)} sub="long-term trend" />
      </div><//>`;
}

// Sectors as bars from a middle line: right and green if its stocks rose (median), left and red if they fell.
const SECTOR_SPANS = [{ value: 'r5', label: '1 week' }, { value: 'r21', label: '1 month' }, { value: 'r63', label: '3 months' }];
function SectorBars({ rows }) {
  const [k, setK] = useState('r21');
  const list = rows.filter(r => r[k] != null).sort((a, b) => b[k] - a[k]);
  if (!list.length) return null;
  const sizes = list.map(r => Math.abs(r[k])).sort((a, b) => b - a);
  const max = Math.max(0.001, sizes[1] ?? sizes[0]);       // one runaway sector fills its half instead of shrinking the rest
  const big = list.filter(r => r.stocks >= 3);              // a sector of one or two stocks is those names alone
  const [top, low] = big.length ? [big[0], big[big.length - 1]] : [list[0], list[list.length - 1]];
  return html`<div class="card inv sec">
    <div class="inv-top"><div class="card-title" style="margin:0">${t('Which sectors rose')}</div>
      <${Seg} options=${SECTOR_SPANS} value=${k} onChange=${setK} /></div>
    <p class="inv-say">${tp('Strongest: {a} ({x}); weakest: {b} ({y}).', {
      a: html`<b class=${tone(top[k])}>${tn(top.sector)}</b>`, x: fmt.pct(top[k], 1),
      b: html`<b class=${tone(low[k])}>${tn(low.sector)}</b>`, y: fmt.pct(low[k], 1) })}</p>
    <div class="inv-axis"><span></span><div><span>${t('Fell')}</span><span>${t('Rose')}</span></div><span></span></div>
    ${list.map(r => html`<div class="inv-row"><span class=${r.stocks < 3 ? 'faint' : ''} title=${tn(r.sector)}>${tn(r.sector)}</span>
      <div class="inv-track"><span class=${`inv-bar ${r[k] >= 0 ? 'up' : 'down'}`}
        style=${`${r[k] >= 0 ? 'inset-inline-start' : 'inset-inline-end'}:50%;width:${Math.min(1, Math.abs(r[k]) / max) * 50}%`}></span></div>
      <b class=${`inv-v ${tone(r[k])}`}>${fmt.pct(r[k], 1)}</b></div>`)}
  </div>`;
}

// Money by sector: each sector's share of the money traded at the last close (the bar) against its usual share over
// the 20 sessions before (the line), biggest first (views.movers).
const SECTORS_SHOWN = 8;
const VS_USUAL = r => (r.usual == null ? '' : r.share >= r.usual * 1.25 ? 'up' : r.share <= r.usual * 0.8 ? 'down' : '');
function SectorMoney({ rows }) {
  const [all, setAll] = useState(false);
  const max = Math.max(...rows.map(r => Math.max(r.share, r.usual || 0)));
  const jump = rows.filter(r => r.usual && r.share >= 0.03).sort((a, b) => b.share / b.usual - a.share / a.usual)[0];
  const sector = r => html`<b>${tn(r.sector)}</b>`;
  return html`<div class="card inv sec sec-money">
    <div class="card-title" style="margin:0">${t('Where the money went')}</div>
    <p class="inv-say">${tp('Most money went to {a} ({x} of the day)', { a: sector(rows[0]), x: fmt.pct(rows[0].share, 0, false) })}${
      jump && VS_USUAL(jump) === 'up' ? html`; ${tp('{a} got far more than usual ({x}, against {y})', {
        a: sector(jump), x: fmt.pct(jump.share, 0, false), y: fmt.pct(jump.usual, 0, false) })}` : ''}.</p>
    ${(all ? rows : rows.slice(0, SECTORS_SHOWN)).map(r => html`<div class="inv-row"><span title=${tn(r.sector)}>${tn(r.sector)}</span>
      <div class="inv-track"><span class="inv-bar info" style=${`inset-inline-start:0;width:${(r.share / max) * 100}%`}></span>
        ${r.usual != null && html`<span class="sec-usual" style=${`inset-inline-start:${(r.usual / max) * 100}%`}></span>`}</div>
      <b class=${`inv-v ${VS_USUAL(r)}`}>${fmt.pct(r.share, 0, false)}${VS_USUAL(r) ? (VS_USUAL(r) === 'up' ? ' ▲' : ' ▼') : ''}</b></div>`)}
    ${rows.length > SECTORS_SHOWN && html`<button class="btn sm ghost" style="margin-top:8px" onClick=${() => setAll(x => !x)}>
      ${all ? t('Show fewer') : t('Show all {n}', { n: rows.length })}</button>`}
    <p class="faint inv-note">${t("Bar: the sector's share of the money traded at the last close. Line: its usual share, over the 20 sessions before. ▲ well above usual, ▼ well below. A single big deal counts too.")}</p>
  </div>`;
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
    ${m.history && m.history.time.length > 1 && html`<div class="mood-chart"><${MoodChart} h=${m.history} /></div>`}
    <div class="mood-parts">${m.parts.map(p => html`<div class="mood-part">
      <span>${t(p.text)} <span class="faint">${partValue(p)}</span></span>
      ${p.score == null ? html`<span class="faint">–</span>` : html`<div class="gauge"><b class="gauge-v">${Math.round(p.score)}</b>
        <div class=${`bar ${MOOD_TONE(p.score)}`}><span style=${`width:${p.score}%`}></span></div></div>`}</div>`)}</div>
    <${More} label="How it's made, and what it told in the past">
      <p>${t("Built like CNN's Fear & Greed Index. Each measure scores 0–100 by where today's value sits among the last two years', and the mood is their average. CNN's options and junk-bond measures don't exist on EGX; small companies against EGX30 stand in for the appetite for risk. The seventh, foreign and Arab investors' net buying, is EGX's own.")}</p>
      <p>${t("Tested since {date}: it didn't tell where EGX30 went next. The differences below are small and changed from one period to another, so use it to know the mood, not to time a buy or a sale.", { date: fmt.date(m.since) })}</p>
      <${DataTable} columns=${past} rows=${m.past} rowKey=${r => r.label} /><//>
  </div>`;
}

// Who bought and who sold: Egyptians, Arabs and foreigners, each as individuals and institutions, net in pounds over the
// last session, week or month (egx_agent/data/flows.py: the exchange's daily statement, as Youm7 gives it). Bought goes
// one way from the middle line and sold the other, each bar with its amount.
const GROUPS = [['egyptians', 'Egyptians'], ['arabs', 'Arabs'], ['foreigners', 'Foreigners']];
const KINDS = [['individuals', 'Individuals'], ['institutions', 'Institutions']];
const ADJ = { egyptians: 'Egyptian', arabs: 'Arab', foreigners: 'Foreign' };
const SPANS = [{ value: 1, label: 'Last session' }, { value: 5, label: '1 week' }, { value: 21, label: '1 month' }];
// million EGP, rounded to read at a glance: +484M, −7.7M, +1.3B
const money = v => {
  const a = Math.abs(v);
  return `${v > 0.05 ? '+' : v < -0.05 ? '−' : ''}${a >= 1000 ? `${fmt.num(a / 1000, 1)}B` : `${fmt.num(a, a >= 100 ? 0 : 1)}M`}`;
};

function Investors({ days }) {
  const [n, setN] = useState(1);
  const use = days.slice(-n);
  const sum = (g, k) => use.reduce((a, d) => a + ((d[g] || {})[k] || 0), 0);
  const rows = GROUPS.map(([g, name]) => ({ g, name, cells: KINDS.map(([k, kn]) => ({ g, k, kn, v: sum(g, k) })) }));
  const cells = rows.flatMap(r => r.cells);
  const max = Math.max(1, ...cells.map(c => Math.abs(c.v)));
  const top = cells.reduce((a, c) => (c.v > a.v ? c : a), { v: 0 });
  const low = cells.reduce((a, c) => (c.v < a.v ? c : a), { v: 0 });
  const who = c => t(`${ADJ[c.g]} ${c.k}`);
  const span = use.length === 1 ? fmt.date(use[0].date)
    : t('{from} – {to} · {n} sessions', { from: fmt.date(use[0].date, false), to: fmt.date(use[use.length - 1].date, false), n: use.length });
  return html`<section class="card inv">
    <div class="inv-top"><div class="card-title" style="margin:0">${t('Who bought and who sold')}</div>
      <${Seg} options=${SPANS} value=${n} onChange=${setN} /></div>
    <p class="inv-say">${top.v > 0 && html`<b class="up">${who(top)}</b> ${t('bought the most ({v})', { v: money(top.v) })}`}${top.v > 0 && low.v < 0 ? '; ' : ''}${low.v < 0 && html`<b class="down">${who(low)}</b> ${t('sold the most ({v})', { v: money(low.v) })}`}.</p>
    <div class="inv-axis"><span></span><div><span>${t('Sold')}</span><span>${t('Bought')}</span></div><span></span></div>
    ${rows.map(r => html`<div class="inv-group">
      <div class="inv-name"><b>${t(r.name)}</b><b class=${tone(r.cells[0].v + r.cells[1].v)}>${money(r.cells[0].v + r.cells[1].v)}</b></div>
      ${r.cells.map(c => html`<div class="inv-row"><span class="muted">${t(c.kn)}</span>
        <div class="inv-track"><span class=${`inv-bar ${c.v >= 0 ? 'up' : 'down'}`}
          style=${`${c.v >= 0 ? 'inset-inline-start' : 'inset-inline-end'}:50%;width:${(Math.abs(c.v) / max) * 50}%`}></span></div>
        <b class="inv-v">${money(c.v)}</b></div>`)}</div>`)}
    <p class="faint inv-note">${span}. ${t("Net buying (+) or selling (−) in pounds. From the exchange's daily statement, as Youm7 reports it.")}
      ${use.length < n ? ' ' + t('Only {k} sessions have these numbers so far.', { k: use.length }) : ''}</p>
  </section>`;
}
