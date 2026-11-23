// Market overview: breadth (how many stocks rise with the index), the biggest movers and which sectors lead. Context
// only; the BUY rules don't use it. The coming results dates are on the Dividends & results tab.
import { html, useApi, useState, useStore, fmt, tone, stockHref, remember } from '../lib.js';
import {
  Callout, PageHead, PageLoading, DataTable, Empty, MarketSwitch, Seg, SessionBadge,
  Fold, More, sessionState,
} from '../ui.js';
import { t, tp, tn, isAr } from '../i18n.js';
import { BreadthChart, MoodChart } from '../charts.js';
import { squarify } from './heatmap.js';

const TONE = { ok: 'ok', warn: 'warn', bad: 'bad' };

function Heat({ v }) {
  if (v == null) return html`<span class="faint">–</span>`;
  const strength = Math.min(42, Math.abs(v) * 420);   // ±10% → strongest colour
  const color = v >= 0 ? 'var(--up)' : 'var(--down)';
  return html`<span class="heat" style=${`background:color-mix(in srgb, ${color} ${strength}%, transparent)`}>${fmt.pct(v, 1)}</span>`;
}

// The overview's boxes, in the order you set (Arrange): kept in this browser.
const BOXES = ['activity', 'flow', 'heat', 'movers', 'updown', 'rates', 'mood'];
const savedOrder = () => {
  let got = [];
  try { got = JSON.parse(remember('market-order') || '[]'); } catch { /* the default order */ }
  return [...got.filter(k => BOXES.includes(k)), ...BOXES.filter(k => !got.includes(k))];
};
// Each box's width on a laptop: a third, half or the whole row (a phone always shows one box a row).
const SIZES = ['small', 'half', 'wide'];
const SIZE_NAMES = { small: 'Small', half: 'Half', wide: 'Wide' };
const DEFAULT_SIZES = { mood: 'wide' };
const savedSizes = () => {
  try { return { ...DEFAULT_SIZES, ...JSON.parse(remember('market-sizes') || '{}') }; } catch { return { ...DEFAULT_SIZES }; }
};

export function MarketPage() {
  const { data, error } = useApi('/market');
  const flow = useApi('/flow').data;
  const [order, setOrder] = useState(savedOrder);
  const [sizes, setSizes] = useState(savedSizes);
  const [arrange, setArrange] = useState(false);
  const [drag, setDrag] = useState(null);
  if (!data) return html`<${PageLoading} error=${error} />`;
  const b = data.breadth;
  if (!b) {
    return html`<${PageHead} title="Market" /><div class="card"><${Empty} icon="bars" title="No price data yet"
      text="Run a scan first. These numbers come from every stock's prices." /></div>`;
  }
  const v = data.verdict;
  const change = v.change_week;
  const boxes = {
    activity: data.activity && data.activity.days.length > 0 && html`<${Activity} a=${data.activity} />`,
    flow: flow && flow.investors && flow.investors.length > 0 && html`<${FlowCard} days=${flow.investors} latest=${b.date} />`,
    heat: data.tiles && data.tiles.length > 0 && html`<${SectorHeat} tiles=${data.tiles} />`,
    movers: data.movers && html`<${Movers} data=${data} />`,
    updown: data.tiles && data.tiles.length > 0 && html`<${Participation} tiles=${data.tiles} />`,
    rates: data.rates && (data.rates.interest || data.rates.inflation) && html`<${Rates} r=${data.rates} />`,
    mood: data.mood && html`<${Mood} m=${data.mood} />`,
  };
  const shown = order.filter(k => boxes[k]);
  const save = list => { setOrder(list); remember('market-order', JSON.stringify(list)); };
  const resize = (k, size) => setSizes(s => { const n = { ...s, [k]: size }; remember('market-sizes', JSON.stringify(n)); return n; });
  const reset = () => { save(BOXES); setSizes({ ...DEFAULT_SIZES }); remember('market-sizes', '{}'); };
  // moves a shown box; boxes without data today keep their place in the saved order
  const reorder = (from, to) => {
    const list = order.filter(k => k !== from);
    list.splice(list.indexOf(to) + (order.indexOf(from) < order.indexOf(to) ? 1 : 0), 0, from);
    save(list);
  };
  const place = (from, to) => reorder(from, to);
  const move = (i, step) => reorder(shown[i], shown[i + step]);
  return html`
    <${PageHead} title="Market" sub=${t('How many stocks rise with the index, from {date}.', { date: fmt.date(b.date) })}>
      <${SessionBadge} dataDate=${b.date} /><//>
    ${data.indices && data.indices.length > 0 && html`<${Strip} rows=${data.indices} />`}
    <div class="arrange-bar">${arrange
      ? html`<span class="faint s">${t('Drag a box, or use its arrows. Pick each box\'s size. Kept on this device.')}</span>
        <button class="btn sm ghost" onClick=${reset}>${t('Reset')}</button>
        <button class="btn sm" onClick=${() => setArrange(false)}>${t('Done')}</button>`
      : html`<button class="btn sm ghost" onClick=${() => setArrange(true)}>⇅ ${t('Arrange boxes')}</button>`}</div>
    <div class="mkt-boxes">
      ${shown.map((k, i) => html`<div key=${k} class=${'box-slot size-' + (sizes[k] || 'half') + (arrange ? ' arranging' : '') + (drag === k ? ' dragging' : '')}
          draggable=${arrange} onDragStart=${() => setDrag(k)} onDragEnd=${() => setDrag(null)}
          onDragOver=${e => arrange && e.preventDefault()} onDrop=${e => { e.preventDefault(); if (drag && drag !== k) place(drag, k); setDrag(null); }}>
        ${arrange && html`<div class="box-tools"><span>⠿ ${t(BOX_NAMES[k])}</span>
          <button class="icon-btn" disabled=${i === 0} onClick=${() => move(i, -1)} aria-label=${t('Move up')}>↑</button>
          <button class="icon-btn" disabled=${i === shown.length - 1} onClick=${() => move(i, 1)} aria-label=${t('Move down')}>↓</button>
          <div class="box-size" role="group" aria-label=${t('Box size')}>${SIZES.map(z => html`<button
            class=${(sizes[k] || 'half') === z ? 'on' : ''} onClick=${() => resize(k, z)}>${t(SIZE_NAMES[z])}</button>`)}</div></div>`}
        ${boxes[k]}</div>`)}
    </div>
    <${Callout} tone=${TONE[v.tone]}><b>${t(v.text)}</b>${change != null
      ? ' ' + t(change >= 0 ? '{pct} of {n} stocks are above their 50-day average. Up {pts} points in a week.'
        : '{pct} of {n} stocks are above their 50-day average. Down {pts} points in a week.',
      { pct: fmt.pct(b.above50, 0, false), n: b.stocks, pts: fmt.int(Math.abs(change * 100)) })
      : ''}<//>
    ${v.switch && html`<div style="margin-top:10px"><${MarketSwitch} sw=${v.switch} compact /></div>`}

    <${Fold} title="Stocks in uptrend vs EGX30" hint="1 year. When most stocks are above their averages, breakouts have more support." flush>
      <${BreadthChart} h=${b.history} /><//>`;
}

// Money by sector: each sector's share of the money traded at the last close (the bar) against its usual share over
// the 20 sessions before (the line), biggest first (views.movers).
const SECTORS_SHOWN = 8;
const VS_USUAL = r => (r.usual == null ? '' : r.share >= r.usual * 1.25 ? 'up' : r.share <= r.usual * 0.8 ? 'down' : '');
export function SectorMoney({ rows }) {
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

const BOX_NAMES = { activity: 'Market activity', flow: 'Who bought and who sold', heat: 'Heatmap', movers: 'Biggest movers',
  updown: 'Up and down', rates: 'Interest and inflation', mood: 'Market mood' };
const PERIODS = [{ value: 'chg1', label: 'Last session' }, { value: 'ret5', label: '1 week' }, { value: 'ret21', label: '1 month' }];

function Head({ title, href, children }) {
  return html`<div class="ov-head"><div class="card-title">${t(title)}</div>${children}
    ${href && html`<a class="ov-go" href=${href} aria-label=${t('See all')} title=${t('See all')}>→</a>`}</div>`;
}

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
  const [tab, setTab] = useState('up');
  const tabs = [['up', 'Rose most', '▲'], ['down', 'Fell most', '▼'], ...(data.active && data.active.length ? [['active', 'Most traded', '●']] : [])];
  return html`<div class="card">
    <${Head} title="Biggest movers" href="#/screener" />
    <div class="mv-tabs">${tabs.map(([k, label, mark]) => html`<button class=${'mv-tab ' + k + (tab === k ? ' on' : '')}
      onClick=${() => setTab(k)}><i>${mark}</i>${t(label)}</button>`)}</div>
    ${tab === 'active'
      ? html`<p class="faint s">${t('At the last session · money traded and the change on the day')}</p>
        ${bars(data.active, r => r.value / most, r => `${fmt.short(r.value)} ${t('EGP')}`, true)}`
      : html`<div class="mv-seg"><${Seg} options=${PERIODS} value=${period} onChange=${setPeriod} /></div>
        ${bars(m[tab], r => Math.abs(r.ret) / top, r => fmt.pct(r.ret, 1))}`}
    <p class="faint s">${t('Actively traded stocks only. Splits and bonus shares are left out.')}</p>
  </div>`;
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
  const [pick, setPick] = useState(null);                  // the session the chart points at; null: the last one
  const daily = n === 1;
  // last session: that one day, no chart; a week or a month: added up, with a chart to touch
  const use = days.slice(-n);
  const i = pick == null ? use.length - 1 : Math.min(pick, use.length - 1);
  const upto = use.slice(0, i + 1);
  const sum = (g, k) => upto.reduce((a, d) => a + ((d[g] || {})[k] || 0), 0);
  const span = daily || upto.length === 1 ? fmt.date(upto[upto.length - 1].date)
    : t('{from} – {to} · {n} sessions', { from: fmt.date(upto[0].date, false), to: fmt.date(upto[upto.length - 1].date, false), n: upto.length });
  const last = days[days.length - 1].date;
  const swatch = (g, k) => html`<i class=${`invt-key ${k === 'individuals' ? 'dash' : ''}`} style=${`--c:${FLOW_COLORS[g]}`}></i>`;
  return html`<section class="card inv">
    <div class="card-title" style="margin:0">${t('Who bought and who sold')}</div>
    <p class="muted invt-sub">${t('Net buying and selling on EGX by Egyptian, Arab and foreign investors. In pounds.')}</p>
    ${latest > last && html`<p class="faint s" style="margin:4px 0 0">${t(latest === sessionState().day
      ? "{date}'s numbers come out about 5 pm. These go up to {last}." : 'No numbers for {date}. These go up to {last}.',
      { date: fmt.date(latest, false), last: fmt.date(last, false) })}</p>`}
    ${!daily && use.length > 1 && html`<${FlowLines} days=${use} pick=${i} onPick=${setPick} />`}
    <div class="invt-seg"><${Seg} options=${SPANS} value=${n} onChange=${v => { setN(v); setPick(null); }} /></div>
    <p class="invt-when"><b>${span}</b></p>
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
    <p class="faint inv-note">${t("From the exchange's daily report, via Youm7 or Hapi Journal. It comes once a day, after the close, so there are no numbers inside a session.")}
      ${!daily && days.length < n ? ' ' + t('Only {k} sessions have these numbers so far.', { k: days.length }) : ''}</p>
  </section>`;
}

// The top strip: EGX30, EGX70, the dollar and gold, each with its change on the last session (views.market_strip).
const INDEX_HREF = { EGX30: '#/egx30', EGX70: '#/egx30?i=EGX70' };
function Strip({ rows }) {
  const cell = r => html`<span>${t(r.name)}</span><b>${r.name.startsWith('EGX') ? fmt.int(r.value) : fmt.num(r.value, 2)}</b>
    <small class=${tone(r.change)}>${r.change > 0 ? '▲' : r.change < 0 ? '▼' : ''} ${fmt.pct(Math.abs(r.change), 2, false)}</small>`;
  return html`<div class="mkt-strip">${rows.map(r => (INDEX_HREF[r.name]
    ? html`<a key=${r.name} class="mkt-link" href=${INDEX_HREF[r.name]} title=${t('Open its chart')}>${cell(r)}<i class="mkt-go">→</i></a>`
    : html`<div key=${r.name}>${cell(r)}</div>`))}</div>`;
}

// Who bought and who sold at the last session (Thndr's Investor Flow): each group's individuals and institutions as a
// bar from the middle line, bought to the right in green and sold to the left in red. The full card is on Money flow.
function FlowCard({ days, latest }) {
  const d = days[days.length - 1];
  const v = (g, k) => (d[g] || {})[k] || 0;
  const top = Math.max(0.001, ...GROUPS.flatMap(([g]) => KINDS.map(([k]) => Math.abs(v(g, k)))));
  return html`<div class="card inv">
    <${Head} title="Who bought and who sold" href="#/flow" />
    <p class="faint s" style="margin:0 0 6px">${fmt.date(d.date)} · ${t('net, in pounds')}${latest > d.date
      ? ' · ' + t(latest === sessionState().day ? "{date}'s numbers come out about 5 pm." : 'No numbers for {date} yet.', { date: fmt.date(latest, false) }) : ''}</p>
    ${GROUPS.map(([g, name]) => html`<div key=${g} class="fc-group"><b>${t(name)}</b>
      ${KINDS.map(([k, kn]) => html`<div class="inv-row"><span class="muted">${t(kn)}</span>
        <div class="inv-track"><span class=${`inv-bar ${v(g, k) >= 0 ? 'up' : 'down'}`}
          style=${`${v(g, k) >= 0 ? 'inset-inline-start' : 'inset-inline-end'}:50%;width:${Math.max(1, (Math.abs(v(g, k)) / top) * 50)}%`}></span></div>
        <b class=${`inv-v ${tone(v(g, k))}`}>${net2(v(g, k))}</b></div>`)}</div>`)}
  </div>`;
}

// Sectors as a small heatmap: each sector's tile sized by its companies' value, coloured by how much that value moved
// at the last session (the full stock-by-stock map is the Heatmap tab).
function SectorHeat({ tiles }) {
  const by = new Map();
  for (const x of tiles) {
    if (!(x.cap > 0) || x.chg1 == null) continue;
    const s = by.get(x.sector) || { name: x.sector, weight: 0, moved: 0 };
    s.weight += x.cap; s.moved += x.cap * x.chg1;
    by.set(x.sector, s);
  }
  const W = 100, H = 70;
  const rects = squarify([...by.values()], 0, 0, W, H);
  if (!rects.length) return null;
  const colour = v => (Math.abs(v) < 0.0005 ? 'var(--panel-3)'
    : `color-mix(in srgb, ${v > 0 ? 'var(--up)' : 'var(--down)'} ${Math.round(25 + 60 * Math.min(1, Math.abs(v) / 0.04))}%, var(--panel-2))`);
  return html`<div class="card">
    <${Head} title="Heatmap" href="#/heatmap" />
    <div class="sh-map" role="img" aria-label=${t('Sectors at the last session')}>${rects.map(r => {
      const v = r.moved / r.weight;
      return html`<a key=${r.name} class="sh-tile" href="#/heatmap" title=${`${tn(r.name)} · ${fmt.pct(v, 2)} · ${fmt.short(r.weight)} ${t('EGP')}`}
        style=${`left:${r.x}%;top:${(r.y / H) * 100}%;width:${r.w}%;height:${(r.h / H) * 100}%;background:${colour(v)}`}>
        ${r.w > 9 && r.h > 7 && html`<b>${tn(r.name)}</b>`}${r.w > 10 && r.h > 10 && html`<span>${fmt.pct(v, 2)}</span>`}</a>`;
    })}</div>
    <p class="faint s">${t("Last session. Bigger tile: more company value. The change is the sector's companies together, by value.")}</p>
  </div>`;
}

const weekday = iso => new Date(`${iso}T12:00`).toLocaleDateString(isAr() ? 'ar-EG' : 'en-GB', { weekday: 'short' });

// Market activity: the money (or shares) traded at each of the last sessions, with the usual day (20 sessions) as a
// dashed line. A session still coming in (fewer stocks than the day before) says so.
function Activity({ a }) {
  const days = a.days;
  const [k, setK] = useState('value');
  const [pick, setPick] = useState(days.length - 1);
  const i = Math.min(pick, days.length - 1), day = days[i];
  const usual = k === 'value' ? a.usual : a.usual_volume;
  const top = Math.max(...days.map(d => d[k]), usual || 0) * 1.06;
  const last = days[days.length - 1], prev = days[days.length - 2];
  const partial = i === days.length - 1 && prev && last.stocks < prev.stocks - 5;
  const kinds = [['value', 'Money traded', v => `${fmt.short(v)} ${t('EGP')}`], ['volume', 'Shares traded', v => fmt.short(v)]];
  return html`<div class="card">
    <${Head} title="Market activity" />
    <p class="faint s" style="margin:4px 0 0">${fmt.date(day.date)}${day[k] && usual
      ? ' · ' + t(day[k] >= usual ? '{p} above a usual day' : '{p} below a usual day', { p: fmt.pct(Math.abs(day[k] / usual - 1), 0, false) }) : ''}</p>
    <div class="act-tabs">${kinds.map(([key, label, show]) => html`<button class=${'act-tab' + (k === key ? ' on' : '')}
      onClick=${() => setK(key)}><span>${t(label)}</span><b>${show(day[key])}</b></button>`)}</div>
    <div class="act-bars">
      ${usual && html`<div class="act-usual" style=${`bottom:${(usual / top) * 100}%`}>
        <span>${t('Usual')}</span><span>${fmt.short(usual)}</span></div>`}
      ${days.map((d, j) => html`<button class="act-col" key=${d.date} onClick=${() => setPick(j)}
          aria-label=${`${fmt.date(d.date, false)}: ${fmt.short(d[k])}`}>
        <div class=${'act-bar' + (j === i ? ' now' : '')} style=${`height:${(d[k] / top) * 100}%`}></div>
        <span class=${j === i ? 'on' : ''}>${weekday(d.date)}</span></button>`)}
    </div>
    <p class="faint s">${partial ? t('The last session is still coming in: {n} stocks so far.', { n: last.stocks })
      : t('Tap a day to see its numbers.')}</p>
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
    <${Head} title="Up and down" href="#/heatmap" />
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
  return html`<div class="card">
    <${Head} title="Interest and inflation" />
    <div class="mkt-strip flat">
      ${cell('Interbank rate', r.interest, false)}
      ${cell('Inflation (a year)', r.inflation, true)}
      ${real != null && html`<div><span>${t('Rate above inflation')}</span><b>${fmt.num(real, 2)} ${t('pts')}</b></div>`}
    </div>
    <p class="faint s">${t('From TradingView. The interbank rate is what banks charge each other overnight; the central bank sets it close to its own rate.')}</p>
  </div>`;
}

// The flows over the shown sessions, added up day by day: one line each, solid for institutions and dashed for
// individuals, a colour for Egyptians, Arabs and foreigners. The last point is the total on the bars below.
const FLOW_COLORS = { egyptians: 'var(--accent)', arabs: 'var(--up)', foreigners: 'var(--warn)' };
function FlowLines({ days, pick, onPick }) {
  const W = 600, H = 170, P = 8;
  // a one-off day far bigger than the rest (one block deal, or a misread report) would flatten every other line: it's
  // left out of the added-up lines and out of the scale (the table keeps it), and named under the chart
  const size = d => GROUPS.reduce((a, [g]) => a + KINDS.reduce((b, [k]) => b + Math.abs((d[g] || {})[k] || 0), 0), 0);
  const sizes = days.map(size).sort((a, b) => a - b);
  const mid = sizes[Math.floor(sizes.length / 2)] || 1;
  const odd = days.filter(d => size(d) > 6 * mid);
  const lines = GROUPS.flatMap(([g]) => KINDS.map(([k]) => {
    let run = 0;
    const v = d => (d[g] || {})[k] || 0;
    return { g, k, pts: days.map(d => (run += odd.includes(d) ? 0 : v(d))) };
  }));
  const all = lines.flatMap(l => l.pts).concat(0);
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const x = j => P + (j / Math.max(days.length - 1, 1)) * (W - 2 * P - 6);
  const y = v => P + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / span) * (H - 2 * P);
  // drag, hover or touch: the nearest session; arrow keys too
  const at = e => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    const px = f * W;                              // the chart reads left to right in both languages (dir="ltr")
    onPick(Math.max(0, Math.min(days.length - 1, Math.round(((px - P) / (W - 2 * P - 6)) * (days.length - 1)))));
  };
  const key = e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onPick(Math.max(0, Math.min(days.length - 1, pick + (e.key === 'ArrowRight' ? 1 : -1)))); }
  };
  const gx = (x(pick) / W) * 100;
  return html`<div class="flow-lines">
    <div class="fl-when" style=${`left:${Math.max(12, Math.min(88, gx))}%`}>${fmt.date(days[pick].date, false)}</div>
    <div class="flow-plot" dir="ltr" tabindex="0" role="slider" aria-valuemin="1" aria-valuemax=${days.length} aria-valuenow=${pick + 1}
        aria-valuetext=${fmt.date(days[pick].date)} aria-label=${t('Pick a session on the chart')}
        onPointerDown=${e => { e.currentTarget.setPointerCapture(e.pointerId); at(e); }} onPointerMove=${e => (e.pointerType === 'mouse' || e.buttons) && at(e)}
        onKeyDown=${key}>
      <svg viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label=${t('Flows added up over {n} sessions', { n: days.length })}>
        <line x1=${P} x2=${W - P} y1=${y(0)} y2=${y(0)} class="zero" vector-effect="non-scaling-stroke" />
        ${lines.map(l => html`<path d=${l.pts.map((v, j) => `${j ? 'L' : 'M'}${x(j).toFixed(1)},${y(v).toFixed(1)}`).join('')}
          fill="none" stroke=${FLOW_COLORS[l.g]} stroke-width="2.2" stroke-dasharray=${l.k === 'individuals' ? '5 4' : ''}
          stroke-linejoin="round" vector-effect="non-scaling-stroke" />`)}
      </svg>
      <i class="fl-guide" style=${`left:${gx}%`}></i>
      ${lines.map(l => html`<i class="fl-end" style=${`left:${gx}%;top:${(y(l.pts[pick]) / H) * 100}%;background:${FLOW_COLORS[l.g]}`}></i>`)}
    </div>
    <p class="faint s">${t('Added up over the last {n} sessions ({from} – {to}). Touch or drag on the chart to see the total up to a session. Solid: institutions. Dashed: individuals.',
      { n: days.length, from: fmt.date(days[0].date, false), to: fmt.date(days[days.length - 1].date, false) })}${odd.length
      ? ' ' + t('Left out of the lines, far bigger than a usual day: {days}.', { days: odd.map(d => fmt.date(d.date, false)).join(', ') }) : ''}</p>
  </div>`;
}
