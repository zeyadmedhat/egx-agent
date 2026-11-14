// Money flow (views.money_flow): where the traded money went. EGX doesn't say who traded which stock, so a stock's
// money counts as "in" on a day it closed up and "out" on a day it closed down. Then the whales: block deals from the
// stocks' headlines and big owners changing their stakes. Where money went, not where it will go: the rules don't use it.
import { html, useApi, useState, useEffect, api, fmt, tone, stockHref } from '../lib.js';
import { PageHead, PageLoading, Empty, Seg, More, SessionBadge, sessionState } from '../ui.js';
import { t, tp, tn } from '../i18n.js';
import { Investors } from './market.js';

const SPANS = [{ value: '1', label: 'Last session' }, { value: '5', label: '1 week' }, { value: '21', label: '1 month' }];
const egp = v => `${fmt.short(Math.abs(v))} ${t('EGP')}`;
const signed = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${egp(v)}`;
const short = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt.short(Math.abs(v))}`;
const times = v => (v == null ? '' : t('{x}× usual', { x: fmt.num(v, v >= 10 ? 0 : 1) }));

export function FlowPage() {
  const { data, error } = useApi('/flow');
  const [k, setK] = useState('5');
  if (!data) return html`<${PageLoading} error=${error} />`;
  const s = data.spans && (data.spans[k] || data.spans['1']);
  if (!data.has_data || !s) {
    return html`<${PageHead} title="Money flow" /><div class="card"><${Empty} icon="bars" title="No price data yet"
      text="Run a scan first. Money flow comes from every stock's prices and trading." /></div>`;
  }
  const span = s.from === s.to ? fmt.date(s.to) : t('{from} – {to}', { from: fmt.date(s.from, false), to: fmt.date(s.to, false) });
  return html`
    <${PageHead} title="Money flow" sub=${t('Where the money traded on EGX went, up to {date}.', { date: fmt.date(data.date) })}>
      <${SessionBadge} dataDate=${data.date} /><//>
    <${Live} sectors=${data.sectors || {}} usual=${data.usual_day} />
    <div class="flow-span"><${Seg} options=${SPANS} value=${k} onChange=${setK} /><span class="faint">${span}</span></div>
    <${Market} s=${s} />
    <${Sectors} rows=${s.sectors} />
    <${Bubbles} rows=${s.stocks} />
    <${Footprints} list=${data.footprints || []} />
    ${data.investors && data.investors.length > 0 && html`<${Investors} days=${data.investors} latest=${data.date} />`}
    <${Whales} deals=${data.deals} owners=${data.owners} end=${data.date} />
    <${More} label="How this is worked out"><p>${t(HOW)}</p><//>`;
}

const HOW = 'EGX doesn\'t publish who bought or sold each stock. So we follow the money the usual way. Money '
  + 'traded on a day the stock closed higher counts as money in. On a day it closed lower, as money out. '
  + '"Usual" is the average of the 60 sessions before. Whales: big blocks of shares traded in one go, '
  + 'taken from each stock\'s headlines. And big owners (1% or more) whose stake moved, from the owners '
  + 'lists (read about once a month). Only deals in the news are here, so some are missing. This shows '
  + 'where money went, not where it will go. The agent\'s signals don\'t use it. Not advice.';

// The whole market: what was traded against usual, and how it split between rising and falling stocks.
function Market({ s }) {
  const total = s.in + s.out || 1;
  const more = s.in >= s.out;
  return html`<section class="card flow-mkt">
    <div class="card-title" style="margin:0">${t('The market\'s money')}</div>
    <p class="inv-say">${tp(more ? '{a} went into rising stocks. Only {b} left falling ones.'
      : '{b} left falling stocks. Only {a} went into rising ones.', {
      a: html`<b class="up">${egp(s.in)}</b>`, b: html`<b class="down">${egp(s.out)}</b>` })}</p>
    <div class="flow-split"><span class="up" style=${`width:${(s.in / total) * 100}%`}></span><span class="down" style=${`width:${(s.out / total) * 100}%`}></span></div>
    <div class="flow-split-l"><span>${t('In')} ${fmt.pct(s.in / total, 0, false)}</span><span>${t('Out')} ${fmt.pct(s.out / total, 0, false)}</span></div>
    <div class="flow-kpis">
      <div><span class="faint">${t('Traded')}</span><b>${egp(s.value)}</b><span class=${s.vs >= 1.25 ? 'up' : s.vs <= 0.8 ? 'down' : 'faint'}>${times(s.vs)}</span></div>
      <div><span class="faint">${t('Net')}</span><b class=${tone(s.net)}>${signed(s.net)}</b><span class="faint">${t('in minus out')}</span></div>
    </div>
  </section>`;
}

// Each sector's money in minus out, biggest in first.
function Sectors({ rows, title = 'Which sectors money went into', bare }) {
  const [all, setAll] = useState(false);
  const list = rows.filter(r => r.value >= 1e6);
  if (!list.length) return null;
  const max = Math.max(...list.map(r => Math.abs(r.net)), 1);
  const top = list[0], low = list[list.length - 1];
  const shown = all ? list : [...list.slice(0, 5), ...list.slice(-5)].filter((r, i, a) => a.indexOf(r) === i);
  return html`<section class=${bare ? 'inv sec flow-bare' : 'card inv sec'}>
    <div class="card-title" style="margin:0">${t(title)}</div>
    <p class="inv-say">${top.net > 0 && html`${tp('Most in: {a} ({x})', { a: html`<b class="up">${tn(top.sector)}</b>`, x: signed(top.net) })}`}${
      top.net > 0 && low.net < 0 ? '. ' : ''}${low.net < 0 && html`${tp('Most out: {a} ({x})', { a: html`<b class="down">${tn(low.sector)}</b>`, x: signed(low.net) })}`}.</p>
    <div class="inv-axis"><span></span><div><span>${t('Money out')}</span><span>${t('Money in')}</span></div><span></span></div>
    ${shown.map(r => html`<div class="inv-row" title=${`${tn(r.sector)} · ${t('Traded')} ${egp(r.value)} · ${times(r.vs)}`}>
      <span>${tn(r.sector)}</span>
      <div class="inv-track"><span class=${`inv-bar ${r.net >= 0 ? 'up' : 'down'}`}
        style=${`${r.net >= 0 ? 'inset-inline-start' : 'inset-inline-end'}:50%;width:${(Math.abs(r.net) / max) * 50}%`}></span></div>
      <b class=${`inv-v ${tone(r.net)}`}>${short(r.net)}</b></div>`)}
    ${list.length > shown.length || all ? html`<button class="btn sm ghost" style="margin-top:8px" onClick=${() => setAll(x => !x)}>
      ${all ? t('Show fewer') : t('Show all {n}', { n: list.length })}</button>` : ''}
  </section>`;
}

// The stocks money moved most in or out of: across, the price change; up, the money against usual (doubling steps);
// the bubble's size, the money traded; green more in than out, red more out.
// a phone draws on a narrower canvas, so the words stay readable
const narrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 560px)').matches;
const L = 44, R = 14, T = 14, B = 34;
function Bubbles({ rows }) {
  if (!rows.length) return null;
  const [W, H] = narrow() ? [400, 340] : [720, 360];
  const rets = rows.map(r => Math.abs(r.ret)).sort((a, b) => a - b);
  const xm = Math.max(0.05, Math.min(0.6, rets[Math.floor(rets.length * 0.95)] * 1.1));
  const vs = rows.map(r => r.vs || 1);
  const y0 = Math.min(-1, Math.floor(Math.log2(Math.min(...vs)))), y1 = Math.max(2, Math.min(5, Math.ceil(Math.log2(Math.max(...vs)))));
  const X = v => L + ((Math.max(-xm, Math.min(xm, v)) + xm) / (2 * xm)) * (W - L - R);
  const Y = v => T + (1 - (Math.log2(Math.max(2 ** y0, Math.min(2 ** y1, v || 1))) - y0) / (y1 - y0)) * (H - T - B);
  const vmax = Math.max(...rows.map(r => r.value));
  const rad = v => 4 + 20 * Math.sqrt(v / vmax);
  const named = new Set([...rows].sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 8).map(r => r.symbol));
  const ticks = [];
  for (let i = y0; i <= y1; i++) ticks.push(2 ** i);
  const ins = rows.filter(r => r.net > 0).sort((a, b) => b.net - a.net).slice(0, 5);
  const outs = rows.filter(r => r.net < 0).sort((a, b) => a.net - b.net).slice(0, 5);
  return html`<section class="card">
    <div class="card-title" style="margin:0">${t('Stocks with the most money in or out')}</div>
    <p class="faint s" style="margin:6px 0 10px">${t('Higher: more money than usual. Right: the price rose. Bigger: more money traded. Green: more money in than out. Tap a bubble to open the stock.')}</p>
    <svg class="flow-bub" viewBox=${`0 0 ${W} ${H}`} role="img" aria-label=${t('Stocks with the most money in or out')}>
      <rect x=${X(0)} y=${T} width=${W - R - X(0)} height=${Y(1) - T} class="flow-q up" />
      <rect x=${L} y=${T} width=${X(0) - L} height=${Y(1) - T} class="flow-q down" />
      <text x=${W - R - 6} y=${T + 14} text-anchor="end" class="flow-ql">${t('More money, price up')}</text>
      <text x=${L + 6} y=${T + 14} class="flow-ql">${t('More money, price down')}</text>
      ${ticks.map(v => html`<line x1=${L} x2=${W - R} y1=${Y(v)} y2=${Y(v)} class=${v === 1 ? 'flow-axis' : 'flow-grid'} />
        <text x=${L - 6} y=${Y(v) + 4} text-anchor="end" class="flow-tick">${v < 1 ? `${fmt.num(v, 2)}×` : `${v}×`}</text>`)}
      <line x1=${X(0)} x2=${X(0)} y1=${T} y2=${H - B} class="flow-axis" />
      ${[-xm, -xm / 2, 0, xm / 2, xm].map(v => html`<text x=${X(v)} y=${H - B + 18} text-anchor="middle" class="flow-tick">${fmt.pct(v, 0)}</text>`)}
      ${[...rows].sort((a, b) => b.value - a.value).map(r => html`<a href=${stockHref(r.symbol)}>
        <circle cx=${X(r.ret)} cy=${Y(r.vs)} r=${rad(r.value)} class=${`flow-dot ${r.net >= 0 ? 'up' : 'down'}`}>
          <title>${`${r.symbol} · ${fmt.pct(r.ret, 1)} · ${times(r.vs)} · ${t('Net')} ${signed(r.net)}`}</title></circle>
        ${named.has(r.symbol) && html`<text x=${X(r.ret)} y=${Y(r.vs) - rad(r.value) - 3} text-anchor="middle" class="flow-sym">${r.symbol}</text>`}</a>`)}
    </svg>
    <div class="flow-lists">
      <${Top} title="Most money in" rows=${ins} />
      <${Top} title="Most money out" rows=${outs} />
    </div>
  </section>`;
}

function Top({ title, rows }) {
  return html`<div><div class="card-sub" style="font-weight:650;margin-bottom:4px">${t(title)}</div>
    ${rows.length ? rows.map(r => html`<a class="flow-top" href=${stockHref(r.symbol)}>
      <b>${r.symbol}</b><span class=${tone(r.net)}>${signed(r.net)}</span><span class="faint">${fmt.pct(r.ret, 1)} · ${times(r.vs)}</span></a>`)
      : html`<p class="faint s">${t('None')}</p>`}</div>`;
}

// The whales of the last 90 days on one line (bought on top, sold underneath), then the list.
const DEAL_WHO = {
  insider: 'a company official', fund: 'a fund', company: 'a company or institution',
  shareholder: 'a shareholder', staff: "the staff's reward plan",
};
const LANE = side => (side === 'buy' ? 0 : side === 'sell' ? 2 : 1);
const TH = 128, TL = 104, TR = 14;
function Whales({ deals, owners, end }) {
  const TW = narrow() ? 420 : 720;
  const [all, setAll] = useState(false);
  const items = [
    ...deals.map(d => ({ ...d, kind: 'deal' })),
    ...owners.map(o => ({ ...o, kind: 'owner', side: o.after > o.before ? 'buy' : 'sell' })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));
  const day = s => new Date(`${s}T00:00:00Z`).getTime();
  const e = day(end), s = e - 90 * 864e5;
  const X = d => TL + ((day(d) - s) / (e - s)) * (TW - TL - TR);
  const ly = side => 24 + LANE(side) * 38;
  const vmax = Math.max(1, ...deals.map(d => d.value || 0));
  const r = d => (d.value ? 4 + 12 * Math.sqrt(d.value / vmax) : 4);
  const months = [];
  for (let m = new Date(s); m.getTime() <= e; m.setUTCMonth(m.getUTCMonth() + 1, 1)) if (m.getTime() >= s) months.push(m.toISOString().slice(0, 10));
  const bought = items.filter(i => i.side === 'buy').length, sold = items.filter(i => i.side === 'sell').length;
  const shown = all ? items : items.slice(0, 12);
  return html`<section class="card">
    <div class="card-title" style="margin:0">${t('Whales: big deals and big owners')}</div>
    ${items.length === 0 ? html`<p class="faint" style="margin-top:10px">${t('No big deals or owner moves in the last 90 days.')}</p>` : html`
    <p class="inv-say">${tp('Last 90 days: big players bought {a} times and sold {b} times.', {
      a: html`<b class="up">${bought}</b>`, b: html`<b class="down">${sold}</b>` })}</p>
    <svg class="flow-tl" viewBox=${`0 0 ${TW} ${TH}`} role="img" aria-label=${t('Whales: big deals and big owners')}>
      ${[['buy', 'Bought'], [null, 'Changed hands'], ['sell', 'Sold']].map(([k, label]) => html`
        <line x1=${TL} x2=${TW - TR} y1=${ly(k)} y2=${ly(k)} class="flow-grid" />
        <text x=${TL - 8} y=${ly(k) + 4} text-anchor="end" class="flow-tick">${t(label)}</text>`)}
      ${months.map(m => html`<text x=${X(m)} y=${TH - 2} text-anchor="middle" class="flow-tick">${fmt.date(m, false).replace(/^\d+\s/, '')}</text>`)}
      ${[...items].reverse().filter(i => day(i.date) >= s).map(i => html`<a href=${stockHref(i.symbol)}>
        ${i.kind === 'owner'
          ? html`<rect x=${X(i.date) - 5} y=${ly(i.side) - 5} width="10" height="10" transform=${`rotate(45 ${X(i.date)} ${ly(i.side)})`} class=${`flow-dot ${i.side === 'buy' ? 'up' : 'down'}`} />`
          : html`<circle cx=${X(i.date)} cy=${ly(i.side)} r=${r(i)} class=${`flow-dot ${i.side === 'buy' ? 'up' : i.side === 'sell' ? 'down' : 'none'}`} />`}
        <title>${`${i.symbol} · ${fmt.date(i.date, false)}${i.value ? ` · ${egp(i.value)}` : ''}`}</title></a>`)}
    </svg>
    <p class="faint s" style="margin:2px 0 10px">${t('Circles: big deals, bigger for more money. Diamonds: a big owner\'s stake went up or down.')}</p>
    <div class="stat-list">${shown.map(i => html`
      <span class="k">${fmt.date(i.date, false)}</span>
      <span class="v" style="font-weight:500"><a href=${stockHref(i.symbol)}><b>${i.symbol}</b></a> · ${i.kind === 'owner'
        ? html`<bdi dir="auto">${i.holder}</bdi>: <bdi class=${i.side === 'buy' ? 'up' : 'down'}>${fmt.pct(i.before, 1, false)} → ${fmt.pct(i.after, 1, false)}</bdi>`
        : html`<bdi class=${i.side === 'buy' ? 'up' : i.side === 'sell' ? 'down' : ''}>${t(i.side === 'buy' ? 'Bought' : i.side === 'sell' ? 'Sold' : 'Changed hands')}</bdi>${
          i.value != null ? html` · <bdi>${egp(i.value)}</bdi>` : ''}${i.who ? html` · <bdi>${t(DEAL_WHO[i.who])}</bdi>` : ''}
          <a class="faint" style="display:block;font-weight:400;font-size:12px" href=${i.url} target="_blank" rel="noopener noreferrer" dir="auto">${i.title}</a>`}
      </span>`)}</div>
    ${items.length > 12 && html`<button class="btn sm ghost" style="margin-top:8px" onClick=${() => setAll(x => !x)}>
      ${all ? t('Show fewer') : t('Show all {n}', { n: items.length })}</button>`}`}
  </section>`;
}

// The session so far, from TradingView's screener (about 15 minutes late), every 2 minutes while it's open: money in
// rising stocks against falling ones, by sector, and the stocks trading far more than usual right now.
const LIVE_EVERY = 120000;
function Live({ sectors, usual }) {
  const [feed, setFeed] = useState(null);
  const open = sessionState().state === 'open';
  useEffect(() => {
    let alive = true;
    const get = () => api('/flow/live').then(f => alive && setFeed(f)).catch(() => {});
    get();
    const id = open ? setInterval(get, LIVE_EVERY) : null;
    return () => { alive = false; if (id) clearInterval(id); };
  }, [open]);
  const rows = ((feed && feed.rows) || []).filter(r => sectors[r[0]] && r[3] > 0)
    .map(([symbol, price, change, value, rel]) => ({ symbol, price, change, value, rel, sector: sectors[symbol],
      net: change > 0 ? value : change < 0 ? -value : 0 }));
  if (!rows.length) return null;
  const sum = f => rows.reduce((a, r) => a + f(r), 0);
  const s = { in: sum(r => Math.max(0, r.net)), out: sum(r => Math.max(0, -r.net)), value: sum(r => r.value) };
  const by = {};
  for (const r of rows) {
    const x = by[r.sector] || (by[r.sector] = { sector: r.sector, value: 0, net: 0 });
    x.value += r.value; x.net += r.net;
  }
  const secs = Object.values(by).sort((a, b) => b.net - a.net);
  const hot = rows.filter(r => r.rel >= 2 && r.value >= 2e6).sort((a, b) => b.rel - a.rel).slice(0, 8);
  const ins = rows.filter(r => r.net > 0).sort((a, b) => b.net - a.net).slice(0, 5);
  const outs = rows.filter(r => r.net < 0).sort((a, b) => a.net - b.net).slice(0, 5);
  const total = s.in + s.out || 1;
  const at = new Date(feed.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' });
  return html`<section class="card flow-live">
    <div class="inv-top"><div class="card-title" style="margin:0">${open && html`<span class="live-dot"></span>`}${t(open ? 'Now, during the session' : 'The latest session, from the live feed')}</div>
      <span class="faint s">${open ? t('About 15 min late · updated {time}', { time: at }) : t('Updates every 2 minutes during the session')}</span></div>
    <p class="inv-say">${tp('{a} into rising stocks, {b} out of falling ones', {
      a: html`<b class="up">${egp(s.in)}</b>`, b: html`<b class="down">${egp(s.out)}</b>` })}${usual ? html`. ${tp(open ? 'So far {p} of a usual day\'s money' : '{p} of a usual day\'s money', {
      p: html`<b>${fmt.pct(s.value / usual, 0, false)}</b>` })}` : ''}.</p>
    <div class="flow-split"><span class="up" style=${`width:${(s.in / total) * 100}%`}></span><span class="down" style=${`width:${(s.out / total) * 100}%`}></span></div>
    <div class="flow-split-l"><span>${t('In')} ${fmt.pct(s.in / total, 0, false)}</span><span>${t('Out')} ${fmt.pct(s.out / total, 0, false)}</span></div>
    <${Sectors} rows=${secs} title="By sector" bare />
    <div class="flow-lists">
      <${LiveTop} title="Most money in" rows=${ins} />
      <${LiveTop} title="Most money out" rows=${outs} />
    </div>
    ${hot.length > 0 && html`<div class="card-sub" style="font-weight:650;margin:14px 0 6px">${t('Trading far more than usual')}</div>
      <div class="flow-hot">${hot.map(r => html`<a href=${stockHref(r.symbol)} class="flow-chip">
        <b>${r.symbol}</b><span class=${tone(r.change)}>${fmt.pct(r.change, 1)}</span><span class="faint">${t('{x}× its volume', { x: fmt.num(r.rel, 1) })}</span></a>`)}</div>
      <p class="faint s" style="margin:4px 0 0">${t('Volume so far today against its usual full day (10-day average).')}</p>`}
  </section>`;
}

function LiveTop({ title, rows }) {
  return html`<div><div class="card-sub" style="font-weight:650;margin-bottom:4px">${t(title)}</div>
    ${rows.length ? rows.map(r => html`<a class="flow-top" href=${stockHref(r.symbol)}>
      <b>${r.symbol}</b><span class=${tone(r.net)}>${egp(r.value)}</span><span class="faint">${fmt.pct(r.change, 1)}${r.rel != null ? ` · ${t('{x}× its volume', { x: fmt.num(r.rel, 1) })}` : ''}</span></a>`)
      : html`<p class="faint s">${t('None')}</p>`}</div>`;
}

// Whale footprints (views.footprints): the stocks whose last 20 sessions look like a big player's steady buying or
// selling, each with its 20 closes and how hard buyers or sellers pushed (money flow, −1 to +1).
const FOOT_GROUPS = [
  ['Signs of buying', ['quiet_buying', 'buying_streak'], 'up'],
  ['Signs of selling', ['quiet_selling', 'selling_streak'], 'down'],
  ['Huge volume, the price didn\'t move', ['big_flat'], 'none'],
];
function footLine(r, k) {
  const x = fmt.num(r.vs, 1), p = fmt.pct(r.ret, 1);
  switch (k) {
    case 'quiet_buying': return t('Quiet buying: {x}× its usual money for 20 sessions. The price stayed flat ({p}). Most days closed near the high.', { x, p });
    case 'quiet_selling': return t('Quiet selling: {x}× its usual money for 20 sessions. The price stayed flat ({p}). Most days closed near the low.', { x, p });
    case 'buying_streak': return t('Closed near the day\'s high {n} of the last 10 days. Money: {x}× usual.', { n: r.hi, x });
    case 'selling_streak': return t('Closed near the day\'s low {n} of the last 10 days. Money: {x}× usual. In tests, weaker months often followed.', { n: r.lo, x });
    case 'big_flat': return t('{date}: {x}× its usual money in one day. The price moved only {c}. A big player took all the shares, or sold into every bid.', {
      date: fmt.date(r.big.date, false), x: fmt.num(r.big.x, 1), c: fmt.pct(r.big.chg, 1) });
    default: return '';
  }
}
function Spark({ v, tn: tn_ }) {
  const lo = Math.min(...v), hi = Math.max(...v), w = 90, h = 30;
  const pts = v.map((y, i) => `${(i / (v.length - 1)) * w},${hi > lo ? h - ((y - lo) / (hi - lo)) * h : h / 2}`).join(' ');
  return html`<svg class="flow-spark" viewBox=${`-2 -2 ${w + 4} ${h + 4}`} aria-hidden="true"><polyline points=${pts} class=${`flow-line ${tn_}`} /></svg>`;
}
function Footprints({ list }) {
  return html`<section class="card">
    <div class="card-title" style="margin:0">${t('Whale footprints')}</div>
    <p class="faint s" style="margin:6px 0 4px">${t('Stocks where a big player seems to buy or sell steadily (last 20 sessions).')}</p>
    ${!list.length ? html`<p class="faint" style="margin-top:10px">${t('No whale footprints in the last 20 sessions.')}</p>`
      : FOOT_GROUPS.map(([name, kinds, tn_]) => {
        const rows = list.filter(r => r.kinds.some(k => kinds.includes(k)));
        return rows.length > 0 && html`<div class="card-sub flow-fg"><span class=${`flow-tag ${tn_}`}></span>${t(name)} <span class="faint">${rows.length}</span></div>
          <div class="flow-feet">${rows.map(r => html`<a class="flow-foot" href=${stockHref(r.symbol)}>
            <div class="flow-foot-h"><b>${r.symbol}</b><span class="faint">${tn(r.sector)}</span><${Spark} v=${r.closes} tn=${tn_} /></div>
            <div class="flow-press" title=${t('Buying or selling pressure (money flow): {v}', { v: fmt.num(r.cmf, 2) })}>
              <span class="faint">${t('Sellers')}</span><div class="inv-track"><span class=${`inv-bar ${r.cmf >= 0 ? 'up' : 'down'}`}
                style=${`${r.cmf >= 0 ? 'inset-inline-start' : 'inset-inline-end'}:50%;width:${Math.min(1, Math.abs(r.cmf) / 0.5) * 50}%`}></span></div><span class="faint">${t('Buyers')}</span></div>
            ${r.kinds.filter(k => kinds.includes(k)).map(k => html`<p>${footLine(r, k)}</p>`)}</a>`)}</div>`;
      })}
    <${More} label="How these are found"><p>${t(FOOT_HOW)}</p><//>
  </section>`;
}
const FOOT_HOW = 'From daily prices of the last 20 sessions. Only stocks trading 5 million pounds a day or more. Quiet '
  + 'buying or selling: 1.2× the usual money and a flat price. Most closes are near the day\'s high (or '
  + 'low). This uses Chaikin\'s money flow. Closing near the high or low: 7 of the last 10 days. Money: '
  + '1.2× usual or more. Huge volume: one day of the last 5 with 3× the usual money. The price moved 1% '
  + 'or less. Tested on EGX since 2016. None of these found stocks that beat EGX30 more often (44%). '
  + 'Closing near the low on heavy trading came before weaker months (39% since 2022). They show what '
  + 'happened, not what will. Not advice.';
