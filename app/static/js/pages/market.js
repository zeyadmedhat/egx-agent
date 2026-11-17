// Market overview: breadth (how many stocks rise with the index), the biggest movers and which sectors lead. Context
// only; the BUY rules don't use it. The coming results dates are on the Dividends & results tab.
import { html, useApi, useState, useStore, fmt, tone, stockHref } from '../lib.js';
import {
  Callout, PageHead, SectionHead, PageLoading, DataTable, Empty, MarketSwitch, Seg, SessionBadge,
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
  return html`
    <${PageHead} title="Market" sub=${t('How many stocks rise with the index, from {date}.', { date: fmt.date(b.date) })}>
      <${SessionBadge} dataDate=${b.date} /><//>
    ${data.indices && data.indices.length > 0 && html`<${Strip} rows=${data.indices} />`}
    <div class="grid grid-2 mkt-pair">
      ${data.activity && data.activity.days.length > 0 && html`<${Activity} a=${data.activity} />`}
      ${data.tiles && data.tiles.length > 0 && html`<${Participation} tiles=${data.tiles} />`}
    </div>
    ${data.mood && html`<${Mood} m=${data.mood} />`}
    <${Callout} tone=${TONE[v.tone]}><b>${t(v.text)}</b>${change != null
      ? ' ' + t(change >= 0 ? '{pct} of {n} stocks are above their 50-day average. Up {pts} points in a week.'
        : '{pct} of {n} stocks are above their 50-day average. Down {pts} points in a week.',
      { pct: fmt.pct(b.above50, 0, false), n: b.stocks, pts: fmt.int(Math.abs(change * 100)) })
      : ''}<//>
    ${v.switch && html`<div style="margin-top:10px"><${MarketSwitch} sw=${v.switch} compact /></div>`}

    ${data.movers && html`<${Movers} data=${data} />`}
    ${data.rates && (data.rates.interest || data.rates.inflation) && html`<${Rates} r=${data.rates} />`}

    <section class="section">
      <${SectionHead} title="Sectors" count=${b.sectors.length}
        hint="The middle return of the sector's stocks. A sector of one or two stocks moves with those names." />
      <${SectorBars} rows=${b.sectors} />
      ${data.sector_money && data.sector_money.length > 0 && html`<${SectorMoney} rows=${data.sector_money} />`}
    </section>
    <${Fold} title="Stocks in uptrend vs EGX30" hint="1 year. When most stocks are above their averages, breakouts have more support." flush>
      <${BreadthChart} h=${b.history} /><//>`;
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

// The actively traded stocks that moved most, and the most traded: each a bar, longest = the biggest in the list.
function Movers({ data }) {
  const [period, setPeriod] = useState('ret5');
  const stocks = useStore(s => s.stocks) || [];
  const name = sym => (stocks.find(s => s.symbol === sym) || {}).name_ar || '';
  const m = data.movers[period];
  const top = Math.max(...m.up.map(r => Math.abs(r.ret)), ...m.down.map(r => Math.abs(r.ret)), 0.001);
  const bars = (rows, size, value, extra) => html`<div class="mbar-list">${rows.map(r => html`
    <a class="mbar" href=${stockHref(r.symbol)} title=${`${r.symbol} ${fmt.price(r.close)}`}>
      <span class="mbar-name"><b>${r.symbol}</b><small dir="auto">${name(r.symbol)}</small></span>
      <span class="mbar-track"><span class=${`mbar-fill ${extra ? 'accent' : tone(r.ret)}`} style=${`width:${Math.max(4, size(r) * 100)}%`}></span></span>
      <b class=${extra ? '' : tone(r.ret)}>${value(r)}</b>
      ${extra && html`<span class=${`mbar-chg ${tone(r.ret)}`}>${fmt.pct(r.ret, 1)}</span>`}
    </a>`)}</div>`;
  const most = data.active && data.active.length ? Math.max(...data.active.map(r => r.value)) : 1;
  return html`
    <section class="section">
      <${SectionHead} title="Biggest movers" hint="Actively traded stocks only. Splits and bonus shares are left out.">
        <${Seg} options=${PERIODS} value=${period} onChange=${setPeriod} /><//>
      <div class="grid grid-2">
        <div class="card"><div class="card-title up">${t('Rose most')}</div>${bars(m.up, r => Math.abs(r.ret) / top, r => fmt.pct(r.ret, 1))}</div>
        <div class="card"><div class="card-title down">${t('Fell most')}</div>${bars(m.down, r => Math.abs(r.ret) / top, r => fmt.pct(r.ret, 1))}</div>
      </div>
      ${data.active && data.active.length > 0 && html`<div class="card" style="margin-top:14px">
        <div class="card-title">${t('Most traded at the last session')}<span class="right faint">${t('money traded · change on the day')}</span></div>
        ${bars(data.active, r => r.value / most, r => `${fmt.short(r.value)} ${t('EGP')}`, true)}</div>`}
    </section>`;
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
const SPANS = [{ value: 1, label: 'Last session' }, { value: 5, label: '1 week' }, { value: 21, label: '1 month' }];
// million EGP, rounded to read at a glance: +484M, −7.7M, +1.3B
const money = v => {
  const a = Math.abs(v);
  return `${v > 0.05 ? '+' : v < -0.05 ? '−' : ''}${a >= 1000 ? `${fmt.num(a / 1000, 1)}B` : `${fmt.num(a, a >= 100 ? 0 : 1)}M`}`;
};

// million EGP with 2 decimals, as the exchange's report gives them: −194.59M, +1.21B
const net2 = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(2) + 'B' : Math.abs(v).toFixed(2) + 'M'}`;

export function Investors({ days, latest }) {
  const [n, setN] = useState(1);
  const use = days.slice(-n);
  const sum = (g, k) => use.reduce((a, d) => a + ((d[g] || {})[k] || 0), 0);
  const span = use.length === 1 ? fmt.date(use[0].date)
    : t('{from} – {to} · {n} sessions', { from: fmt.date(use[0].date, false), to: fmt.date(use[use.length - 1].date, false), n: use.length });
  const last = days[days.length - 1].date;
  const swatch = (g, k) => html`<i class=${`invt-key ${k === 'individuals' ? 'dash' : ''}`} style=${`--c:${FLOW_COLORS[g]}`}></i>`;
  return html`<section class="card inv">
    <div class="card-title" style="margin:0">${t('Who bought and who sold')}</div>
    <p class="muted invt-sub">${t('Net buying and selling on EGX by Egyptian, Arab and foreign investors. In pounds.')}</p>
    ${latest > last && html`<p class="faint s" style="margin:4px 0 0">${t(latest === sessionState().day
      ? "{date}'s numbers come out about 5 pm. These go up to {last}." : 'No numbers for {date}. These go up to {last}.',
      { date: fmt.date(latest, false), last: fmt.date(last, false) })}</p>`}
    ${days.length > 2 && html`<${FlowLines} days=${days} />`}
    <div class="invt-seg"><${Seg} options=${SPANS} value=${n} onChange=${setN} /></div>
    <table class="invt">
      <thead><tr><th></th><th>${t('Net')}</th></tr></thead>
      ${GROUPS.map(([g, name]) => {
        const total = KINDS.reduce((a, [k]) => a + sum(g, k), 0);
        return html`<tbody key=${g}>
          <tr class="invt-group"><th>${t(name)}</th><td class=${tone(total)}>${net2(total)}</td></tr>
          ${KINDS.map(([k, kn]) => html`<tr><th class="muted">${swatch(g, k)}${t(kn)}</th>
            <td class=${tone(sum(g, k))}>${net2(sum(g, k))}</td></tr>`)}
        </tbody>`;
      })}
    </table>
    <p class="faint inv-note">${span}. ${t("From the exchange's daily report, via Youm7 or Hapi Journal.")}
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
  const W = 600, H = 170, P = 8;
  const lines = GROUPS.flatMap(([g]) => KINDS.map(([k]) => {
    let run = 0;
    return { g, k, pts: days.map(d => (run += ((d[g] || {})[k] || 0))) };
  }));
  const all = lines.flatMap(l => l.pts).concat(0);
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const x = i => P + (i / Math.max(days.length - 1, 1)) * (W - 2 * P - 6), y = v => P + (1 - (v - lo) / span) * (H - 2 * P);
  return html`<div class="flow-lines">
    <div class="flow-plot"><svg viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label=${t('Flows added up over {n} sessions', { n: days.length })}>
      <line x1=${P} x2=${W - P} y1=${y(0)} y2=${y(0)} class="zero" vector-effect="non-scaling-stroke" />
      ${lines.map(l => html`<path d=${l.pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}
        fill="none" stroke=${FLOW_COLORS[l.g]} stroke-width="2.2" stroke-dasharray=${l.k === 'individuals' ? '5 4' : ''}
        stroke-linejoin="round" vector-effect="non-scaling-stroke" />`)}
    </svg>${lines.map(l => html`<i class="flow-dot" style=${`left:${(x(l.pts.length - 1) / W) * 100}%;top:${(y(l.pts[l.pts.length - 1]) / H) * 100}%;background:${FLOW_COLORS[l.g]}`}></i>`)}</div>
    <p class="faint s">${t('Added up over the last {n} sessions ({from} – {to}). Solid: institutions. Dashed: individuals.', { n: days.length, from: fmt.date(days[0].date, false), to: fmt.date(days[days.length - 1].date, false) })}</p>
  </div>`;
}
