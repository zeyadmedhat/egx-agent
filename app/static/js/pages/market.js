// Market overview: breadth (how many stocks rise with the index), the biggest movers and which sectors lead. Context
// only; the BUY rules don't use it. The coming results dates are on the Dividends & results tab.
import { html, useApi, useState, useStore, fmt, tone, stockHref } from '../lib.js';
import {
  Kpi, Callout, PageHead, SectionHead, PageLoading, DataTable, Empty, MarketSwitch, Seg, Term, SessionBadge,
  Fold, More, sessionState,
} from '../ui.js';
import { t, tp, tn, isAr } from '../i18n.js';
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
      text="Run a scan first. These numbers come from every stock's prices." /></div>`;
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
    <${PageHead} title="Market" sub=${t('How many stocks rise with the index, from {date}.', { date: fmt.date(b.date) })}>
      <${SessionBadge} dataDate=${b.date} /><//>
    ${data.indices && data.indices.length > 0 && html`<${Strip} rows=${data.indices} />`}
    <div class="grid grid-2 mkt-pair">
      ${data.activity && data.activity.days.length > 0 && html`<${Activity} a=${data.activity} />`}
      ${data.tiles && data.tiles.length > 0 && html`<${Participation} tiles=${data.tiles} />`}
    </div>
    ${data.mood && html`<${Mood} m=${data.mood} />`}
    ${data.investors && data.investors.length > 0 && html`<${Investors} days=${data.investors} latest=${b.date} />`}
    <${Callout} tone=${TONE[v.tone]}><b>${t(v.text)}</b>${change != null
      ? ' ' + t(change >= 0 ? '{pct} of {n} stocks are above their 50-day average. Up {pts} points in a week.'
        : '{pct} of {n} stocks are above their 50-day average. Down {pts} points in a week.',
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
    ${data.rates && (data.rates.interest || data.rates.inflation) && html`<${Rates} r=${data.rates} />`}

    <section class="section">
      <${SectionHead} title="Sectors" count=${b.sectors.length}
        hint="The middle return of the sector's stocks. A sector of one or two stocks moves with those names." />
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
  // a sector of one or two stocks is those names alone: they go last, under their own line
  const list = rows.filter(r => r[k] != null).sort((a, b) => (a.stocks < 3) - (b.stocks < 3) || b[k] - a[k]);
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
    ${list.map((r, i) => html`${i > 0 && r.stocks < 3 && list[i - 1].stocks >= 3 && html`<p class="faint inv-small">${t('Sectors of one or two stocks')}</p>`}<div class="inv-row"><span class=${r.stocks < 3 ? 'faint' : ''} title=${tn(r.sector)}>${tn(r.sector)}</span>
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
      jump && VS_USUAL(jump) === 'up' ? html`. ${tp('{a} got far more than usual ({x}, against {y})', {
        a: sector(jump), x: fmt.pct(jump.share, 0, false), y: fmt.pct(jump.usual, 0, false) })}` : ''}.</p>
    ${(all ? rows : rows.slice(0, SECTORS_SHOWN)).map(r => html`<div class="inv-row"><span title=${tn(r.sector)}>${tn(r.sector)}</span>
      <div class="inv-track"><span class="inv-bar info" style=${`inset-inline-start:0;width:${(r.share / max) * 100}%`}></span>
        ${r.usual != null && html`<span class="sec-usual" style=${`inset-inline-start:${(r.usual / max) * 100}%`}></span>`}</div>
      <b class=${`inv-v ${VS_USUAL(r)}`}>${fmt.pct(r.share, 0, false)}${VS_USUAL(r) ? (VS_USUAL(r) === 'up' ? ' ▲' : ' ▼') : ''}</b></div>`)}
    ${rows.length > SECTORS_SHOWN && html`<button class="btn sm ghost" style="margin-top:8px" onClick=${() => setAll(x => !x)}>
      ${all ? t('Show fewer') : t('Show all {n}', { n: rows.length })}</button>`}
    <p class="faint inv-note">${t("Bar: the sector's share of the last session's money. Line: its usual share (20 sessions before). ▲ far above usual. ▼ far below. One big deal can move it.")}</p>
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
        hint="Only actively traded stocks. A jump over 30% in one day is left out. That's a split or bonus shares, not a real move.">
        <${Seg} options=${PERIODS} value=${period} onChange=${setPeriod} /><//>
      <div class="grid grid-2">
        <div class="card"><div class="card-title up">${t('Rose most')}</div>${list(m.up)}</div>
        <div class="card"><div class="card-title down">${t('Fell most')}</div>${list(m.down)}</div>
      </div>
      ${data.active && data.active.length > 0 && html`<div class="card" style="margin-top:14px">
        <div class="card-title">${t('Most traded at the last session')}</div>
        <div class="mover-list">${data.active.map(r => html`<a class="mover" href=${stockHref(r.symbol)}>
          <span><b>${r.symbol}</b><span class="faint" dir="auto">${name(r.symbol)}</span></span>
          <span class="price">${fmt.short(r.value)} ${t('EGP')}</span><b class=${tone(r.ret)}>${fmt.pct(r.ret, 1)}</b></a>`)}</div></div>`}
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
    <${More} label="How it's made, and what it told in the past">
      <div class="mood-parts">${m.parts.map(p => html`<div class="mood-part">
        <span>${t(p.text)} <span class="faint">${partValue(p)}</span></span>
        ${p.score == null ? html`<span class="faint">–</span>` : html`<div class="gauge"><b class="gauge-v">${Math.round(p.score)}</b>
          <div class=${`bar ${MOOD_TONE(p.score)}`}><span style=${`width:${p.score}%`}></span></div></div>`}</div>`)}</div>
      <p>${t("Built like CNN's Fear & Greed Index. Each measure gets a score from 0 to 100. The score compares today with the last two years. The mood is the average. EGX has no options or junk bonds. So small companies against EGX30 show the appetite for risk. The seventh measure is EGX's own: foreign and Arab net buying.")}</p>
      <p>${t("Tested since {date}. It didn't predict where EGX30 went next. The differences below are small and not steady. Use it to read the mood, not to time a trade.", { date: fmt.date(m.since) })}</p>
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

export function Investors({ days, latest }) {
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
  const last = days[days.length - 1].date;
  return html`<section class="card inv">
    <div class="inv-top"><div class="card-title" style="margin:0">${t('Who bought and who sold')}</div>
      <${Seg} options=${SPANS} value=${n} onChange=${setN} /></div>
    ${latest > last && html`<p class="faint s" style="margin:6px 0 0">${t(latest === sessionState().day
      ? "{date}'s numbers come out about 5 pm. These go up to {last}." : 'No numbers for {date}. These go up to {last}.',
      { date: fmt.date(latest, false), last: fmt.date(last, false) })}</p>`}
    <p class="inv-say">${top.v > 0 && html`<b class="up">${who(top)}</b> ${t('bought the most ({v})', { v: money(top.v) })}`}${top.v > 0 && low.v < 0 ? '; ' : ''}${low.v < 0 && html`<b class="down">${who(low)}</b> ${t('sold the most ({v})', { v: money(low.v) })}`}.</p>
    ${days.length > 2 && html`<${FlowLines} days=${days} />`}
    <div class="inv-axis"><span></span><div><span>${t('Sold')}</span><span>${t('Bought')}</span></div><span></span></div>
    ${rows.map(r => html`<div class="inv-group">
      <div class="inv-name"><b>${t(r.name)}</b><b class=${tone(r.cells[0].v + r.cells[1].v)}>${money(r.cells[0].v + r.cells[1].v)}</b></div>
      ${r.cells.map(c => html`<div class="inv-row"><span class="muted">${t(c.kn)}</span>
        <div class="inv-track"><span class=${`inv-bar ${c.v >= 0 ? 'up' : 'down'}`}
          style=${`${c.v >= 0 ? 'inset-inline-start' : 'inset-inline-end'}:50%;width:${(Math.abs(c.v) / max) * 50}%`}></span></div>
        <b class="inv-v">${money(c.v)}</b></div>`)}</div>`)}
    <p class="faint inv-note">${span}. ${t("Net buying (+) or selling (−), in pounds. From the exchange's daily report, via Youm7.")}
      ${use.length < n ? ' ' + t('Only {k} sessions have these numbers so far.', { k: use.length }) : ''}</p>
  </section>`;
}

// The top strip: EGX30, EGX70, the dollar and gold, each with its change on the last session (views.market_strip).
function Strip({ rows }) {
  return html`<div class="mkt-strip">${rows.map(r => html`<div key=${r.name}>
    <span>${t(r.name)}</span><b>${r.name.startsWith('EGX') ? fmt.int(r.value) : fmt.num(r.value, 2)}</b>
    <small class=${tone(r.change)}>${r.change > 0 ? '▲' : r.change < 0 ? '▼' : ''} ${fmt.pct(Math.abs(r.change), 2, false)}</small></div>`)}</div>`;
}

const weekday = iso => new Date(`${iso}T12:00`).toLocaleDateString(isAr() ? 'ar-EG' : 'en-GB', { weekday: 'short' });

// Market activity: the money (or shares) traded at each of the last sessions, with the usual day (20 sessions) as a
// dashed line. A session still coming in (fewer stocks than the day before) says so.
function Activity({ a }) {
  const [k, setK] = useState('value');
  const days = a.days;
  const usual = k === 'value' ? a.usual : null;
  const top = Math.max(...days.map(d => d[k]), usual || 0) * 1.08;
  const last = days[days.length - 1], prev = days[days.length - 2];
  const partial = prev && last.stocks < prev.stocks - 5;
  return html`<div class="card">
    <div class="inv-top"><div class="card-title" style="margin:0">${t('Market activity')}</div>
      <${Seg} options=${[{ value: 'value', label: 'Money' }, { value: 'volume', label: 'Shares' }]} value=${k} onChange=${setK} /></div>
    <p class="act-now"><b>${fmt.short(last[k])}</b> ${k === 'value' ? t('EGP') : t('shares')}
      ${usual && html`<span class="faint"> · ${t('usual day {v}', { v: fmt.short(usual) })}</span>`}</p>
    <div class="act-bars">
      ${usual && html`<div class="act-usual" style=${`bottom:${(usual / top) * 100}%`}></div>`}
      ${days.map((d, i) => html`<div class="act-col" key=${d.date}>
        <div class=${'act-bar' + (i === days.length - 1 ? ' now' : '')} style=${`height:${(d[k] / top) * 100}%`}
          title=${`${fmt.date(d.date, false)}: ${fmt.short(d[k])}`}></div>
        <span>${weekday(d.date)}</span></div>`)}
    </div>
    ${partial && html`<p class="faint s">${t('The last session is still coming in: {n} stocks so far.', { n: last.stocks })}</p>`}
  </div>`;
}

// Up and down: how many stocks moved by how much at the last session, in 1% steps, red falling and green rising.
const STEPS = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
function Participation({ tiles }) {
  const moves = tiles.map(x => x.chg1).filter(v => v != null);
  const step = v => (Math.abs(v) < 0.0005 ? 0 : Math.sign(v) * Math.min(4, Math.ceil(Math.abs(v) * 100 - 1e-9)));
  const n = Object.fromEntries(STEPS.map(k => [k, 0]));
  for (const v of moves) n[step(v)] += 1;
  const top = Math.max(1, ...Object.values(n));
  const down = moves.filter(v => step(v) < 0).length, up = moves.filter(v => step(v) > 0).length;
  return html`<div class="card">
    <div class="card-title">${t('Up and down')}</div>
    <div class="part-bars">${STEPS.map(k => html`<div class="part-col" key=${k} title=${`${n[k]}`}>
      <b>${n[k] || ''}</b><div class=${'part-bar ' + (k < 0 ? 'down' : k > 0 ? 'up' : 'flat')} style=${`height:${(n[k] / top) * 100}%`}></div>
      <span>${k === 0 ? '0' : `${k > 0 ? '+' : '−'}${Math.abs(k)}${Math.abs(k) === 4 ? '+' : ''}`}</span></div>`)}</div>
    <div class="part-key"><span><i class="down"></i>${t('Fell')} <b>${down}</b></span><span><i class="flat"></i>${t('Flat')} <b>${n[0]}</b></span>
      <span><i class="up"></i>${t('Rose')} <b>${up}</b></span></div>
    <p class="faint s">${t('Each bar: how many stocks moved by that much (%) at the last session.')}</p>
  </div>`;
}

// Interest and inflation: the interbank rate and yearly inflation, each with its last move in points, and the gap
// between them (what a deposit earns above inflation).
function Rates({ r }) {
  const cell = (label, x, goodDown) => x && html`<div><span>${t(label)}</span><b>${fmt.num(x.value, 2)}%</b>
    ${x.change != null && html`<small class=${tone(goodDown ? -x.change : x.change)}>${x.change > 0 ? '+' : '−'}${fmt.num(Math.abs(x.change), 2)} ${t('pts')}</small>`}</div>`;
  const real = r.interest && r.inflation ? r.interest.value - r.inflation.value : null;
  return html`<section class="section"><div class="card">
    <div class="card-title">${t('Interest and inflation')}</div>
    <div class="mkt-strip flat">
      ${cell('Interbank rate', r.interest, false)}
      ${cell('Inflation (a year)', r.inflation, true)}
      ${real != null && html`<div><span>${t('Rate above inflation')}</span><b>${fmt.num(real, 2)} ${t('pts')}</b></div>`}
    </div>
    <p class="faint s">${t('From TradingView. The interbank rate is what banks charge each other overnight; the central bank sets it close to its own rate.')}</p>
  </div></section>`;
}

// The flows over the shown sessions, added up day by day: one line each, solid for institutions and dashed for
// individuals, a colour for Egyptians, Arabs and foreigners. The last point is the total on the bars below.
const FLOW_COLORS = { egyptians: 'var(--accent)', arabs: 'var(--up)', foreigners: 'var(--warn)' };
function FlowLines({ days }) {
  const W = 600, H = 150, P = 6;
  const lines = GROUPS.flatMap(([g]) => KINDS.map(([k]) => {
    let run = 0;
    return { g, k, pts: days.map(d => (run += ((d[g] || {})[k] || 0))) };
  }));
  const all = lines.flatMap(l => l.pts).concat(0);
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const x = i => P + (i / Math.max(days.length - 1, 1)) * (W - 2 * P), y = v => P + (1 - (v - lo) / span) * (H - 2 * P);
  return html`<div class="flow-lines">
    <svg viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label=${t('Flows added up over {n} sessions', { n: days.length })}>
      <line x1=${P} x2=${W - P} y1=${y(0)} y2=${y(0)} class="zero" />
      ${lines.map(l => html`<path d=${l.pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}
        fill="none" stroke=${FLOW_COLORS[l.g]} stroke-width="2" stroke-dasharray=${l.k === 'individuals' ? '5 4' : ''}
        vector-effect="non-scaling-stroke" />`)}
    </svg>
    <div class="flow-key">${GROUPS.map(([g, gn]) => html`<span><i style=${`background:${FLOW_COLORS[g]}`}></i>${t(gn)}</span>`)}
      <span class="faint">${t('solid: institutions · dashed: individuals')}</span></div>
    <p class="faint s">${t('Added up over the last {n} sessions ({from} – {to}).', { n: days.length, from: fmt.date(days[0].date, false), to: fmt.date(days[days.length - 1].date, false) })}</p>
  </div>`;
}
