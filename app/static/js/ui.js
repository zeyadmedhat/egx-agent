// Shared building blocks: icons, Shariah badges, KPI tiles, tables, forms, the stock picker, dialogs.
import {
  html, Fragment, useState, useEffect, useLayoutEffect, useRef, useMemo, store, useStore, startJob, dismissToast, fmt, tone, cls,
  stockHref, watchForData, toggleWatch, STATIC, api, todayISO,
} from './lib.js';
import { t, term, tn, tw } from './i18n.js';

const tx = v => (typeof v === 'string' ? t(v) : v);   // plain text is translated; built pieces are left alone

// ------------------------------------------------------------------ icons (stroke icons, 24×24)
const ICONS = {
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  chart: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
  briefcase: '<rect width="20" height="14" x="2" y="7" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  flask: '<path d="M9 3h6"/><path d="M10 3v6.5L4.6 18.6A1.6 1.6 0 0 0 6 21h12a1.6 1.6 0 0 0 1.4-2.4L14 9.5V3"/><path d="M7 15h10"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  pencil: '<path d="M21.2 6.8a2.8 2.8 0 0 0-4-4L4 16v4h4Z"/><path d="m15 5 4 4"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
  alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
  xCircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  trendUp: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  play: '<path d="M7 4v16l13-8Z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  sell: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  bars: '<path d="M3 3v18h18"/><path d="M7 16v-4M12 16V8M17 16v-7"/>',
  copy: '<rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  news: '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8M15 18h-5M10 6h8v4h-8z"/>',
  percent: '<path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.1 10.4A6 6 0 1 1 10.3 18"/><path d="M7 6h1v4"/>',
  listCheck: '<path d="M11 6h10M11 12h10M11 18h10"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/>',
  split: '<path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.2-2.8L3 3"/><path d="m15 9 6-6"/>',
  unlink: '<path d="m18.8 13.4 1.5-1.4a5 5 0 0 0-7.1-7.1l-1.4 1.5"/><path d="m5.2 10.6-1.5 1.4a5 5 0 0 0 7.1 7.1l1.4-1.5"/><path d="M8 2v3M2 8h3M16 22v-3M22 16h-3"/>',
};
export function Icon({ name, size }) {
  const style = size ? `width:${size}px;height:${size}px` : undefined;
  return html`<svg class="icon" data-i=${name} viewBox="0 0 24 24" style=${style} aria-hidden="true" dangerouslySetInnerHTML=${{ __html: ICONS[name] || '' }}></svg>`;
}

// ------------------------------------------------------------------ Shariah badges + index pills
const KASHIF = {   // labels go through t() where shown
  compliant: ['ok', 'Compliant'],
  non_compliant: ['bad', 'Not compliant'],
  awaiting: ['warn', 'Awaiting statements'],
  blocked: ['muted', 'Status withheld'],
};
export function Badges({ info, compact }) {
  if (!info) return null;
  const src = info.egx33_manual ? 'added by you in Settings' : "Kashif's EGX33 index list";
  const egx = info.egx33
    ? html`<span class="badge ok" title=${`Member of the EGX33 Shariah index (source: ${src})`}>EGX33 ✓</span>`
    : html`<span class="badge muted" title=${t('Not in the EGX33 Shariah index')}>EGX33 ✗</span>`;
  const [c, en] = KASHIF[info.kashif_status] || ['muted', 'Not on Kashif'];
  const text = t(en);
  const tip = [
    `Kashif: ${info.kashif_label || text}`,
    info.purity && `Purity: ${info.purity}`,
    info.purification_pct && `Purification: ${info.purification_pct}`,
    info.statements_date && `Statements: ${info.statements_date}`,
    info.kashif_updated && `Checked: ${String(info.kashif_updated).slice(0, 10)}`,
    'Click to open on kasheif.com',
  ].filter(Boolean).join('\n');
  return html`<div class=${cls('badges', compact && 'compact')}>
    ${egx}
    <a class=${`badge ${c}`} href=${info.kashif_url} target="_blank" rel="noopener" title=${tip}
       onClick=${e => e.stopPropagation()}><span class="dot"></span>${t('Kashif')} · ${text}</a>
  </div>`;
}
export function IndexPills({ info }) {
  if (!info) return null;
  const tags = [['egx30', 'EGX30'], ['egx70', 'EGX70'], ['egx33', 'EGX33']].filter(([k]) => info[k]);
  return tags.map(([, t]) => html`<span class="idx-pill">${t}</span>`);
}

// ------------------------------------------------------------------ chips, tiles, bits
const STATUS = {
  ADJUST: 'adjust', EXIT: 'exit', BOUNCE: 'review', REVIEW: 'review', 'TIGHTEN STOP': 'tighten', HOLD: 'hold', 'NO DATA': 'nodata',
  BUY: 'buy', WATCH: 'watch',
};
const STATUS_LABEL = { ADJUST: 'UPDATE SHARES', EXIT: 'SELL', BOUNCE: 'SELL ON A BOUNCE', 'TIGHTEN STOP': 'RAISE STOP', REVIEW: 'CONSIDER SELLING',
  WATCH: 'NEAR A BUY' };
export function StatusChip({ status }) {
  return html`<span class=${`chip ${STATUS[status] || 'nodata'}`}><span class="dot"></span>${t(STATUS_LABEL[status] || status)}</span>`;
}

export function Kpi({ label, value, sub, valueClass, subClass, title, compact }) {
  return html`<div class=${cls('kpi', compact && 'compact')} title=${title}>
    <div class="k-label">${tx(label)}</div>
    <div class=${cls('k-value', valueClass)}>${Number.isInteger(value) ? fmt.int(value) : value}</div>
    ${sub != null && sub !== '' && html`<div class=${cls('k-sub', subClass)}>${tx(sub)}</div>`}
  </div>`;
}

// A small tile with the first letters of the symbol.
export function StockAvatar({ symbol, size = 30 }) {
  return html`<span class="avatar" aria-hidden="true"
    style=${`width:${size}px;height:${size}px;font-size:${Math.round(size * 0.36)}px`}>${String(symbol).slice(0, 2)}</span>`;
}

export function ScoreRing({ score }) {
  const r = 20, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, score || 0));
  const color = v >= 70 ? 'var(--up)' : v >= 60 ? 'var(--accent)' : 'var(--text-3)';
  return html`<div class="score-ring" title="Score out of 100: trend, strength vs other stocks, volume and room to run">
    <svg viewBox="0 0 48 48"><circle cx="24" cy="24" r=${r} fill="none" stroke="var(--panel-3)" stroke-width="4" />
      <circle cx="24" cy="24" r=${r} fill="none" stroke=${color} stroke-width="4" stroke-linecap="round"
        stroke-dasharray=${`${(c * v) / 100} ${c}`} /></svg>
    <div class="v">${Math.round(v)}</div>
  </div>`;
}

// The rating (views.rating): where the model's 2-week chance puts a stock among the day's actively traded stocks, 1–100.
// 91+ is its top 10%, the group its tests are about.
export function Rating({ v, big }) {
  if (v == null) return html`<span class="faint" title=${t('No rating: the model rates only stocks with enough daily trading.')}>–</span>`;
  const band = v >= 91 ? 'top' : v >= 71 ? 'good' : v >= 51 ? 'mid' : 'low';
  return html`<span class=${cls('rating', band, big && 'big')}
    title=${t('Rating {v}/100: where the model puts it among the actively traded stocks today (100 = its first).', { v })}>${v}</span>`;
}

// A company's latest results in brief (views.company_brief): profit and sales growth over a year, or that it lost
// money, and its P/E next to its sector's. compact: the growth and P/E only, for a table cell.
export function CompanyLine({ co, compact }) {
  if (!co) return compact ? html`<span class="faint">–</span>` : null;
  const lost = co.margin != null && co.margin < 0;
  const g = v => html`<b class=${v >= 0 ? 'up' : 'down'}>${fmt.pct(v, 0)}</b>`;
  const pe = co.pe != null && html`<span title=${t('Price ÷ a year of profit: lower is cheaper')}>${t('P/E')} <b>${fmt.num(co.pe, 1)}</b>${
    co.sector_pe != null && !compact ? html`<span class="faint"> (${t('sector')} ${fmt.num(co.sector_pe, 1)})</span>` : ''}</span>`;
  const parts = [
    lost ? html`<b class="down">${t('Lost money')}</b>` : co.growth != null && html`<span>${t('Profit')} ${g(co.growth)}</span>`,
    !compact && co.sales != null && html`<span>${t('Sales')} ${g(co.sales)}</span>`,
    pe,
  ].filter(Boolean);
  if (!parts.length) return compact ? html`<span class="faint">–</span>` : null;
  return html`<span class=${cls('company-line', compact && 'compact')}
    title=${t("The company's last 4 reported quarters against the 4 before (TradingView)")}>${
    parts.map((p, i) => html`${i ? html`<span class="faint"> · </span>` : ''}${p}`)}</span>`;
}

export function ScoreBar({ score }) {
  const v = Math.max(0, Math.min(100, score || 0));
  return html`<div class="score-cell"><b>${Math.round(v)}</b><div class=${cls('bar', v >= 70 ? 'up' : '')} style="flex:1">
    <span style=${`width:${v}%`}></span></div></div>`;
}

export function DayBar({ day, max, review }) {
  const pct = Math.min(100, (day / max) * 100);
  const tn = day >= max ? 'down' : day >= review ? 'warn' : '';
  return html`<div class="days"><span>${t('Day {day} of {max}', { day, max })}</span><div class=${cls('bar', tn)}><span style=${`width:${pct}%`}></span></div></div>`;
}

// ------------------------------------------------------------------ your positions, with live prices
// Live prices for a few stocks (/quotes: TradingView's screener, about 15 minutes late): {symbol: {price, change}},
// asked again every minute while the session is open. {} until they come, or when they can't be had.
export function useQuotes(symbols) {
  const key = [...new Set(symbols)].sort().join(',');
  const [q, setQ] = useState({});
  useEffect(() => {
    if (!key) return undefined;
    let on = true;
    const get = () => api(`/quotes?s=${encodeURIComponent(key)}`).then(r => { if (on && r) setQ(r); }).catch(() => null);
    get();
    const id = setInterval(() => { if (!document.hidden && sessionState().state === 'open') get(); }, 60000);
    return () => { on = false; clearInterval(id); };
  }, [key]);
  return q;
}

// A position at the newest price when there is one: price, P&L after fees (the selling fee on the new value) and
// whether it has already crossed its stop or target. Live only while the session is open; otherwise the quote is the
// last close. p: views.open_positions / local/api.js openPositions.
export function livePosition(p, q) {
  const quote = q && q[p.symbol];
  if (!quote || p.adjust) return { ...p, price: p.last, live: false, day_change: null };
  const price = quote.price;
  const pnl = p.pnl + (price - p.last) * p.shares;          // like the broker's: selling fees count once you sell
  const cost = p.avg_price * p.shares + (p.fees || 0);
  return { ...p, price, live: sessionState().state === 'open', day_change: quote.change, pnl, pnl_pct: (price * p.shares - cost) / cost,
    hit_stop: p.stop != null && price <= p.stop, hit_target: price >= p.target };
}

// What the agent says to do, in two or three words (the exit rules' status, egx_agent/portfolio.py).
const DO = { HOLD: 'Hold', EXIT: 'Sell at the open', BOUNCE: 'Sell on a bounce', REVIEW: 'Consider selling', 'TIGHTEN STOP': 'Raise your stop',
  ADJUST: 'Update your shares', 'NO DATA': 'No price yet' };

// Where the price sits between your stop and your target, with your buy price marked.
function PlanBar({ p }) {
  if (p.stop == null || !(p.target > p.stop)) return null;
  const at = v => `${Math.max(0, Math.min(100, ((v - p.stop) / (p.target - p.stop)) * 100))}%`;
  return html`<div class="planbar" aria-hidden="true">
      <div class="track"><span class="fill" style=${`width:${at(p.price)}`}></span>
        <span class="mark buy" style=${`inset-inline-start:${at(p.avg_price)}`} title=${t('Your buy price')}></span>
        <span class="mark now" style=${`inset-inline-start:${at(p.price)}`}></span></div></div>
    <div class="planbar-labels">
      <span><span class="down">${t('Stop')} ${fmt.price(p.stop)}</span> <span class="faint">${fmt.pct(p.stop / p.price - 1, 1)}</span></span>
      <span><span class="up">${t('Target')} ${fmt.price(p.target)}</span> <span class="faint">${fmt.pct(p.target / p.price - 1, 1)}</span></span>
    </div>`;
}

// One open position: what to do, the price and P&L (live during the session), stop to target, days held.
export function PositionCard({ p, hold, children, onOpen, open }) {
  // selling on a bounce (a big loss): the stop and target bar means nothing now, its reason says when to sell
  const urgent = p.hit_stop && p.status !== 'BOUNCE' ? { tone: 'exit', text: 'At or under your stop now: sell' }
    : p.hit_target ? { tone: 'hold', text: 'At your target now: take the profit' } : null;
  return html`<article class=${cls('card pos-card', p.status !== 'HOLD' && 'act', open && 'open')} id=${`pos-${p.id}`}>
    <div class="pos-head">
      <${StockAvatar} symbol=${p.symbol} size=${36} />
      <div class="pos-who"><a class="sym-big" href=${stockHref(p.symbol)}>${p.symbol}</a>
        <div class="faint pos-sub">${t('{n} shares · bought at {price}', { n: fmt.int(p.shares), price: fmt.price(p.avg_price) })}</div></div>
      <span class=${`chip ${STATUS[p.status] || 'nodata'}`}><span class="dot"></span>${t(DO[p.status] || p.status)}</span>
    </div>
    <div class="pos-nums">
      <div><div class="k">${t('Price')}${p.live ? html` <span class="live-dot" title=${t('Live, about 15 minutes late')}></span>` : ''}</div>
        <div class="v">${fmt.price(p.price)}${p.day_change != null ? html` <span class=${cls('pos-day', tone(p.day_change))}>${fmt.pct(p.day_change, 1)}</span>` : ''}</div>
        <div class="faint s">${p.live ? t('live, ~15 min late') : t('last close')}</div></div>
      <div class="r"><div class="k">${t('Profit / loss')}</div>
        <div class=${cls('v', tone(p.pnl))}>${fmt.pct(p.pnl_pct, 1)}</div>
        <div class=${cls('s', tone(p.pnl))}>${fmt.signed(p.pnl)} ${t('EGP')}</div></div>
    </div>
    ${p.status !== 'BOUNCE' && html`<${PlanBar} p=${p} />`}
    ${urgent && html`<div class=${cls('pos-urgent', urgent.tone)}><${Icon} name="alert" size=${14} />${t(urgent.text)}</div>`}
    ${p.status !== 'HOLD' && html`<p class="pos-reason" dir="auto">${tn(p.reason)}</p>`}
    ${p.cautions && p.cautions.length > 0 && html`<div style="margin-bottom:8px"><${Cautions} items=${p.cautions} compact /></div>`}
    <div class="pos-foot"><${DayBar} day=${p.day} max=${hold.max} review=${hold.review} />
      ${onOpen && (open ? html`<button class="btn sm" onClick=${onOpen} aria-expanded="true"><${Icon} name="x" size=${14} />${t('Close')}</button>`
        : html`<button class="btn sm ghost" onClick=${onOpen} aria-expanded="false">${t('Sell or edit')}<${Icon} name="chevron" size=${14} /></button>`)}</div>
    ${children}
  </article>`;
}

export function Empty({ icon = 'info', title, text, action }) {
  return html`<div class="empty">
    <div class="e-icon"><${Icon} name=${icon} size=${22} /></div>
    ${title && html`<h3>${tx(title)}</h3>`}
    ${text && html`<p>${tx(text)}</p>`}
    ${action && html`<div class="e-action">${action}</div>`}
  </div>`;
}

export function Callout({ tone: tn = '', icon, children }) {
  const ic = icon || (tn === 'warn' ? 'alert' : tn === 'ok' ? 'checkCircle' : tn === 'bad' ? 'xCircle' : 'info');
  return html`<div class=${cls('callout', tn)}><${Icon} name=${ic} /><div>${children}</div></div>`;
}

export function PageHead({ title, sub, children }) {
  return html`<div class="page-head"><div><h1>${tx(title)}</h1>${sub && html`<div class="sub">${tx(sub)}</div>`}</div>
    ${children && html`<div class="row">${children}</div>`}</div>`;
}

export function SectionHead({ title, count, hint, children }) {
  return html`<div class="section-head"><h2>${tx(title)}</h2>
    ${count != null && html`<span class="pill-count">${count}</span>`}
    ${hint && html`<span class="hint">${tx(hint)}</span>`}
    ${children && html`<div class="right">${children}</div>`}</div>`;
}

export function Disclaimer() {
  return html`<div class="disclaimer">${t('Rules-based signals to support your own decisions. Not investment advice: you decide and place every order yourself. Past (backtest) results do not guarantee future returns.')}</div>`;
}

// ------------------------------------------------------------------ plain-language helpers (ideas from esthmr.com)
// A market word with a dotted underline: tap it for a two-line explanation (i18n.js GLOSSARY).
let closeOpenTerm = null;
export function Term({ k, children }) {
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const info = term(k);
  useEffect(() => {
    if (!pos) return undefined;
    const close = e => { if (!e || !btn.current || !btn.current.parentNode.contains(e.target)) setPos(null); };
    const esc = e => e.key === 'Escape' && setPos(null);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', () => setPos(null), { once: true, capture: true });
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc); };
  }, [pos]);
  if (!info) return children;
  const open = e => {
    e.preventDefault();
    e.stopPropagation();
    if (pos) { setPos(null); return; }
    if (closeOpenTerm) closeOpenTerm();
    closeOpenTerm = () => setPos(null);
    const r = btn.current.getBoundingClientRect();
    const w = Math.min(300, window.innerWidth - 24);
    const left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 12));
    const below = r.bottom + 170 < window.innerHeight;
    setPos({ left, width: w, top: below ? r.bottom + 8 : undefined, bottom: below ? undefined : window.innerHeight - r.top + 8 });
  };
  const style = pos && Object.entries({ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom })
    .filter(([, v]) => v != null).map(([k2, v]) => `${k2}:${v}px`).join(';');
  return html`<span class="term-wrap"><button type="button" class="term" ref=${btn} aria-expanded=${!!pos}
      onClick=${open} title=${info[1]}>${children || info[0]}</button>
    ${pos && html`<span class="term-pop" role="tooltip" style=${style}><b>${info[0]}</b>${info[1]}</span>`}</span>`;
}

// Is EGX trading right now? Sunday to Thursday, 10:00–14:30 Cairo time (public holidays aren't known here).
export function sessionState(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  if (parts.weekday === 'Fri' || parts.weekday === 'Sat') return { state: 'weekend', day };
  if (mins < 600) return { state: 'pre', day };
  if (mins < 870) return { state: 'open', day };
  return { state: 'after', day };
}

// Whether the numbers on the page are final: during the session they aren't, after the close they are once the
// agent has scanned. dataDate: the close the page's numbers come from.
export function SessionBadge({ dataDate }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(id); }, []);
  const s = sessionState(now);
  const date = fmt.date(dataDate);
  const [tn, label, sub, text] = s.state === 'open'
    ? ['warn', 'Session open', 'Prices not final',
      "EGX is trading now (10:00–14:30 Cairo). The live boxes are about 15 minutes late; the agent's numbers use the {date} close."]
    : s.state === 'after' && dataDate < s.day
      ? ['info', "Today's close not in yet", '',
        'The session ended. The agent scans after the close; until then its numbers use the {date} close.']
      : s.state === 'weekend'
        ? ['ok', 'Market closed', 'Closing prices', 'Final closing prices of {date}. EGX trades Sunday to Thursday.']
        : ['ok', s.state === 'pre' ? 'Before the open' : 'Market closed', 'Closing prices',
          'Final closing prices of {date}. The next session opens at 10:00 Cairo time.'];
  return html`<div class=${cls('session', tn)} title=${t(text, { date })}>
    <span class="dot"></span><b>${t(label)}</b>${sub && html`<span>· ${t(sub)}</span>`}</div>`;
}

// A section that stays closed until you open it: the title and a short hint show, the rest is one tap away. What's
// inside is drawn only once it's open (a chart needs its width).
export function Fold({ title, hint, open: first, flush, children }) {
  const [open, setOpen] = useState(!!first);
  return html`<details class="fold card" open=${open} onToggle=${e => setOpen(e.currentTarget.open)}>
    <summary><${Icon} name="chevron" size=${16} /><b>${tx(title)}</b>${hint && html`<span class="hint">${tx(hint)}</span>`}</summary>
    ${open && html`<div class=${cls('fold-body', flush && 'flush')}>${children}</div>`}</details>`;
}

// Which stocks a list shows under your Shariah filter (Settings), with a link to change it.
const SHARIAH_SHOWN = { kashif: 'Kashif compliant only', egx33: 'EGX33 members only',
  either: 'Kashif compliant OR EGX33 member', both: 'Kashif compliant AND EGX33 member' };
export function ShariahNote({ mode }) {
  if (!SHARIAH_SHOWN[mode]) return null;
  return html`<span class="shariah-note"><${Icon} name="shield" size=${13} />${t('Showing: {filter}', { filter: t(SHARIAH_SHOWN[mode]) })}
    <a href="#/settings">${t('Change')}</a></span>`;
}

// Short main text, the fine print one tap away.
export function More({ label = 'Details and caveats', children, open }) {
  return html`<details class="more" open=${open}><summary><${Icon} name="chevron" size=${14} />${t(label)}</summary>
    <div class="more-body">${children}</div></details>`;
}

export function PageLoading({ error }) {
  if (error) return html`<div class="card"><${Callout} tone="bad"><b>${t("Couldn't load this page.")}</b> ${error.message}<//></div>`;
  return html`<div class="stack">
    <div class="skeleton" style="height:64px"></div>
    <div class="kpis">${[1, 2, 3, 4].map(() => html`<div class="skeleton" style="height:86px"></div>`)}</div>
    <div class="skeleton" style="height:320px"></div></div>`;
}

// The prediction model's chance, coloured against the average stock's chance (base).
// The model's chance, shown only for its top picks (top = false): its tested results are about its best 10% each
// day, so a number for the rest would look more reliable than it is.
export function Chance({ p, base, top }) {
  if (p == null) return html`<span class="faint">–</span>`;
  if (top === false) {
    return html`<span class="chance-off" title="Not in the model's top 10% today. Its test results are about its top picks, so it doesn't give a chance for the rest.">${t('not a top pick')}</span>`;
  }
  const ratio = base ? p / base : 1;
  return html`<span class=${cls('chance', ratio >= 1.3 ? 'up' : ratio <= 0.8 ? 'low' : '')}
    title=${base ? `The average actively traded stock: ${fmt.pct(base, 0, false)}` : ''}>${fmt.pct(p, 0, false)}</span>`;
}

// Why the prediction model scored a stock as it did: the measures that pushed its score up (green) and down (red),
// from its own trees (predict.explain). Whole-market measures are left out: they move every stock alike.
export function Why({ items }) {
  if (!items || !items.length) return null;
  return html`<ul class="model-why" aria-label="Why the model scored it like this">${items.map(x => html`<li
    class=${x.up ? 'up' : 'down'} key=${x.f} title=${x.up ? 'Pushed its score up' : 'Pulled its score down'}>
    <span aria-hidden="true">${x.up ? '▲' : '▼'}</span>${tw(x.text)}</li>`)}</ul>`;
}

// The rating's reason in one line, from the same list (Why): its strongest push up from the chart and from the
// company's results (or its two strongest when one side has none), and its strongest pull down. stacked: one a line.
const COMPANY_WHY = /^(f_|rank_(ey|growth|quality)$)/;
export function Reason({ items, stacked }) {
  if (!items || !items.length) return null;
  const ups = items.filter(x => x.up);
  const chart = ups.find(x => !COMPANY_WHY.test(x.f)), co = ups.find(x => COMPANY_WHY.test(x.f));
  const pick = [...(chart && co ? ups.filter(x => x === chart || x === co) : ups.slice(0, 2)), ...items.filter(x => !x.up).slice(0, 1)];
  return html`<span class=${cls('rating-why', stacked && 'stacked')} title=${t('What lifted (▲) and lowered (▼) its rating most')}>${pick.map((x, i) => html`${
    i ? html`<span class="faint"> · </span>` : ''}<span class=${x.up ? 'up' : 'down'} key=${x.f}><span aria-hidden="true">${
    x.up ? '▲' : '▼'}</span> ${tw(x.text)}</span>`)}</span>`;
}

// A star that adds the stock to your watchlist (or takes it off).
export function WatchStar({ symbol, label }) {
  const list = useStore(s => s.watchlist) || [];
  const on = list.includes(symbol);
  return html`<button type="button" class=${cls('star-btn', on && 'on', label && 'labelled')}
    title=${t(on ? 'On your watchlist: click to remove it' : 'Add to your watchlist')} aria-pressed=${on}
    onClick=${e => { e.stopPropagation(); toggleWatch(symbol); }}>${on ? '★' : '☆'}${label ? html`<span>${t(on ? 'Watching' : 'Watch')}</span>` : ''}</button>`;
}

// What a buyer or holder should know now (data/news.py cautions): an ex-dividend date within a month, bonus
// shares or a rights issue coming, bad news this week. compact: one chip each.
const CAUTION_SHORT = { ex_dividend: 'Ex-dividend', bonus: 'Bonus shares', split: 'Split', rights: 'Rights issue',
  bad_news: 'Bad news?', results: 'Results' };
export function Cautions({ items, compact }) {
  if (!items || !items.length) return null;
  if (compact) {
    return html`<span class="cautions">${items.map(c => html`<span class=${cls('caution-chip', c.level)} title=${c.text}>
      <${Icon} name=${c.level === 'warn' ? 'alert' : 'info'} size=${12} />${t(CAUTION_SHORT[c.kind] || c.kind)}${
        c.kind !== 'bad_news' ? ` ${fmt.date(c.date)}` : ''}</span>`)}</span>`;
  }
  return html`<ul class="caution-list">${items.map(c => html`<li class=${c.level}>
    <${Icon} name=${c.level === 'warn' ? 'alert' : 'info'} size=${14} />
    <span dir="auto">${c.url ? html`<a href=${c.url} target="_blank" rel="noopener noreferrer">${c.text}</a>` : c.text}</span></li>`)}</ul>`;
}

// Headlines (data/news.py): date, source, a good/bad dot from keyword rules, the title linking to the article.
export const TAG_LABELS = { dividend: 'Dividend', bonus: 'Bonus shares', results: 'Results', capital: 'Capital',
  deal: 'Deal', financing: 'Financing', legal: 'Legal', meeting: 'Meeting', buyback: 'Buyback', analysis: 'Analysis' };
export function NewsList({ items, sources = {}, showSymbol, limit, empty = 'No news yet.' }) {
  const [all, setAll] = useState(false);
  if (!items || !items.length) return html`<p class="muted" style="font-size:13px">${tx(empty)}</p>`;
  const shown = limit && !all ? items.slice(0, limit) : items;
  return html`<ul class="news-list">${shown.map(n => html`<li key=${`${n.id}|${n.symbol || ''}`}>
      <span class=${cls('tone-dot', n.tone > 0 ? 'up' : n.tone < 0 ? 'down' : '')}
        title=${n.tone > 0 ? 'Sounds like good news (keyword rules)' : n.tone < 0 ? 'Sounds like bad news (keyword rules)' : 'Neutral'}></span>
      <div class="news-body">
        <a class="news-title" dir="auto" href=${n.url} target="_blank" rel="noopener noreferrer">${n.title}</a>
        <div class="news-meta">
          ${showSymbol && n.symbol && html`<a class="sym-link" href=${stockHref(n.symbol)}>${n.symbol}</a>`}
          <span>${sources[n.source] || n.source}</span><span>${fmt.date(n.published.slice(0, 10))} ${n.published.slice(11, 16)}</span>
          ${(n.tags || []).map(tag => html`<span class="tag">${t(TAG_LABELS[tag] || tag)}</span>`)}
        </div>
      </div></li>`)}</ul>
    ${limit && items.length > limit && html`<button class="linkish" style="margin-top:8px" onClick=${() => setAll(!all)}>
      ${t(all ? 'Show fewer' : 'Show all {n}', { n: items.length })}</button>`}`;
}

// The market switch for the model's picks: full size, half size or no new buys, from breadth.
const SWITCH_TONE = { full: 'ok', half: 'warn', off: 'bad' };
const SWITCH_DO = {
  full: "The model's top picks can be bought at your usual size.",
  half: "Buy the model's top picks at half your usual size.",
  off: "Don't buy the model's picks until more stocks are back above their average.",
};
export function MarketSwitch({ sw, compact }) {
  if (!sw) return null;
  if (compact) {
    return html`<a class=${cls('switch-pill', sw.state)} href="#/market" title=${`${t(sw.text)} ${t(SWITCH_DO[sw.state])}`}>
      <span class="dot"></span>${t('Model picks: {label}', { label: t(sw.label) })}</a>`;
  }
  return html`<${Callout} tone=${SWITCH_TONE[sw.state]}><b>${t('Market switch: {label}.', { label: t(sw.label) })}</b>${' '}${t(sw.text)}${' '}
    ${t(SWITCH_DO[sw.state])}${' '}<span class="faint">${t("Tested 2016–2026, it cut the worst drop of the model's top picks from −62% to −22%. Your BUY rules keep their own EGX30 rule.")}</span><//>`;
}

export function Change({ value, digits = 2, pill }) {
  if (!pill) return html`<span class=${tone(value)}>${fmt.pct(value, digits)}</span>`;
  const tn = tone(value);
  return html`<span class=${cls('chg-pill', tn)}>${tn === 'up' ? '▲ ' : tn === 'down' ? '▼ ' : ''}${fmt.pct(Math.abs(value), digits, false)}</span>`;
}

export function StockCell({ symbol, info, sub }) {
  return html`<div class="stock-cell"><${StockAvatar} symbol=${symbol} size=${28} /><div>
    <a class="sym" href=${stockHref(symbol)} onClick=${e => e.stopPropagation()}>${symbol}</a>
    ${sub !== false && html`<div class="sub" dir="auto" style="text-align:start" title=${sub || info?.name_ar || undefined}>${sub || info?.name_ar || ''}</div>`}</div></div>`;
}

// ------------------------------------------------------------------ segmented control / switch
// The highlight slides to the chosen option.
export function Seg({ options, value, onChange }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const place = () => {
      const on = box.querySelector('button.on');
      if (!on || !on.offsetWidth) { box.classList.remove('slid'); return; }
      for (const [k, v] of [['--x', on.offsetLeft], ['--y', on.offsetTop], ['--w', on.offsetWidth], ['--h', on.offsetHeight]]) {
        box.style.setProperty(k, `${v}px`);
      }
      box.classList.add('slid');
      if (!box.dataset.ready) requestAnimationFrame(() => { box.dataset.ready = '1'; });
    };
    place();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    if (ro) ro.observe(box);
    return () => ro && ro.disconnect();
  }, [value, options.length]);
  return html`<div class="seg" ref=${ref}>${options.map(o => html`<button type="button" class=${o.value === value ? 'on' : ''}
    onClick=${() => onChange(o.value)}>${tx(o.label)}</button>`)}</div>`;
}
export function Switch({ checked, onChange, label }) {
  return html`<label class="switch"><input type="checkbox" checked=${checked} onChange=${e => onChange(e.target.checked)} />
    <span class="track"></span>${label && html`<span>${label}</span>`}</label>`;
}
// ------------------------------------------------------------------ a date, picked on the site's own calendar
// (the browser's own can't be styled). EGX trades Sunday–Thursday, so trade dates skip Friday and Saturday
// (`weekends` lets them through, e.g. a dividend's payday) and nothing after `max` (today). A drop-in for
// <input type="date">: onInput gets {target: {value: 'YYYY-MM-DD'}}. On a phone it opens as a sheet at the bottom.
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayOf = s => new Date(`${s}T00:00:00`);
const offDay = d => d.getDay() === 5 || d.getDay() === 6;
export function lastSession(day = todayISO()) {
  const d = dayOf(day);
  while (offDay(d)) d.setDate(d.getDate() - 1);
  return isoOf(d);
}
const DP_W = 300;

export function DateInput({ value, onInput, max = todayISO(), weekends = false, small }) {
  const [view, setView] = useState(null);        // the month shown (its 1st) while open, else null
  const [pos, setPos] = useState(null);          // where the calendar sits; null on a phone (a sheet)
  const btn = useRef(null);
  const ar = store.lang === 'ar', locale = ar ? 'ar-EG-u-nu-latn' : 'en-GB';
  const close = () => { setView(null); btn.current && btn.current.focus(); };
  useEffect(() => {
    if (!view) return undefined;
    const onKey = e => e.key === 'Escape' && close();
    const onMove = e => !(e.target.closest && e.target.closest('.dp')) && close();
    addEventListener('keydown', onKey); addEventListener('resize', onMove); addEventListener('scroll', onMove, true);
    return () => { removeEventListener('keydown', onKey); removeEventListener('resize', onMove); removeEventListener('scroll', onMove, true); };
  }, [!view]);
  const open = () => {
    const r = btn.current.getBoundingClientRect(), h = 372;
    const left = Math.max(8, Math.min(ar ? r.right - DP_W : r.left, innerWidth - DP_W - 8));
    setPos(innerWidth < 560 ? null : { left, top: r.bottom + h + 8 > innerHeight && r.top > h ? r.top - h - 6 : r.bottom + 6 });
    const d = dayOf(value || max);
    setView(new Date(d.getFullYear(), d.getMonth(), 1));
  };
  const pick = day => { onInput({ target: { value: day } }); close(); };
  const shown = value ? dayOf(value).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : t('Pick a date');
  const trigger = html`<button type="button" ref=${btn} class=${cls('input', 'date-btn', small && 'sm')} onClick=${() => (view ? close() : open())}
    aria-haspopup="dialog" aria-expanded=${!!view}><${Icon} name="calendar" size=${small ? 14 : 16} /><span>${shown}</span></button>`;
  if (!view) return trigger;
  const y = view.getFullYear(), m = view.getMonth(), today = todayISO(), quick = weekends ? max : lastSession(max);
  const cells = [...Array(view.getDay()).fill(null), ...Array.from({ length: new Date(y, m + 1, 0).getDate() }, (_, i) => new Date(y, m, i + 1))];
  const heads = Array.from({ length: 7 }, (_, i) => new Date(2026, 0, 4 + i)       // 4 Jan 2026 was a Sunday
    .toLocaleDateString(locale, { weekday: ar ? 'narrow' : 'short' }).slice(0, ar ? 3 : 2));
  const later = isoOf(new Date(y, m + 1, 1)) > max;
  return html`${trigger}<div class=${cls('dp-scrim', !pos && 'dim')} onMouseDown=${close}></div>
    <div class=${cls('dp', !pos && 'sheet')} role="dialog" aria-label=${t('Pick a date')} style=${pos ? `left:${pos.left}px;top:${pos.top}px` : undefined}>
      <div class="dp-head">
        <button type="button" class="dp-nav prev" onClick=${() => setView(new Date(y, m - 1, 1))} aria-label=${t('Previous month')}><${Icon} name="chevron" size=${16} /></button>
        <b>${view.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}</b>
        <button type="button" class="dp-nav" disabled=${later} onClick=${() => setView(new Date(y, m + 1, 1))} aria-label=${t('Next month')}><${Icon} name="chevron" size=${16} /></button>
      </div>
      <div class="dp-grid">
        ${heads.map((h, i) => html`<span class=${cls('dp-wd', !weekends && i >= 5 && 'off')}>${h}</span>`)}
        ${cells.map((d, i) => {
          if (!d) return html`<span key=${`b${i}`}></span>`;
          const s = isoOf(d), off = s > max || (!weekends && offDay(d));
          return html`<button type="button" key=${s} class=${cls('dp-day', s === value && 'on', s === today && 'today')} disabled=${off}
            aria-pressed=${s === value} aria-label=${d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            onClick=${() => pick(s)}>${d.getDate()}</button>`;
        })}
      </div>
      <div class="dp-foot">
        <button type="button" class="btn sm" onClick=${() => pick(quick)}>${t(quick === today ? 'Today' : 'Last session')}</button>
        ${!weekends && html`<span class="faint">${t('Fri and Sat: no trading')}</span>`}
      </div>
    </div>`;
}

export function Field({ label, help, error, children, className }) {
  return html`<div class=${cls('field', className)}>
    ${label && html`<label>${tx(label)}</label>`}${children}
    ${error ? html`<div class="f-error">${error}</div>` : help && html`<div class="f-help">${tx(help)}</div>`}</div>`;
}

// ------------------------------------------------------------------ sortable table
function compare(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return a < b ? -1 : a > b ? 1 : 0;
}
export function DataTable({ columns, rows, rowKey = (r, i) => i, onRowClick, sort: initialSort, empty = 'Nothing here yet.',
  expandedKey, renderExpanded, limit }) {
  const [sort, setSort] = useState(initialSort || null);
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find(c => c.key === sort.key);
    const val = (col && col.sortValue) || (r => r[sort.key]);
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null || y == null) return compare(x, y);
      return compare(x, y) * dir;
    });
  }, [rows, sort, columns]);
  const clickSort = c => {
    if (c.sortable === false) return;
    setSort(s => (s && s.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key: c.key, dir: c.align === 'r' ? 'desc' : 'asc' }));
  };
  const shown = limit && !all ? sorted.slice(0, limit) : sorted;
  return html`<div class="table-wrap"><table class="table">
    <thead><tr>${columns.map(c => html`<th class=${cls(c.align, c.sortable !== false && 'sortable')} style=${c.width ? `width:${c.width}` : ''}
      onClick=${() => clickSort(c)} title=${tx(c.title)}>${tx(c.label)}${sort && sort.key === c.key
        ? html`<span class="arrow">${sort.dir === 'asc' ? '↑' : '↓'}</span>` : ''}</th>`)}</tr></thead>
    <tbody>${shown.length ? shown.map((r, i) => {
      const k = rowKey(r, i);
      const open = expandedKey != null && expandedKey === k;
      return html`<${Fragment} key=${k}>
        <tr class=${cls(onRowClick && 'clickable', open && 'expanded')} onClick=${onRowClick ? () => onRowClick(r) : undefined}>
          ${columns.map(c => html`<td class=${c.align}>${c.render ? c.render(r) : c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? '–')}</td>`)}
        </tr>
        ${open && renderExpanded && html`<tr class="detail"><td colspan=${columns.length}>${renderExpanded(r)}</td></tr>`}
      <//>`;
    }) : html`<tr><td colspan=${columns.length} class="table-empty">${tx(empty)}</td></tr>`}</tbody>
  </table>${limit && sorted.length > limit && html`<div class="table-more">
    <button class="linkish" onClick=${() => setAll(a => !a)}>${t(all ? 'Show fewer' : 'Show all {n}', { n: sorted.length })}</button></div>`}</div>`;
}

// ------------------------------------------------------------------ stock picker / search
function matches(stocks, q) {
  if (!stocks) return [];
  const s = q.trim().toUpperCase();
  if (!s) return stocks.slice(0, 60);
  const starts = [], contains = [], names = [];
  for (const x of stocks) {
    if (x.symbol.startsWith(s)) starts.push(x);
    else if (x.symbol.includes(s)) contains.push(x);
    else if ((x.name_ar || '').includes(q.trim()) || (x.sector || '').toUpperCase().includes(s)) names.push(x);
  }
  return [...starts, ...contains, ...names].slice(0, 60);
}

export function StockPicker({ value, onChange, starred = [], placeholder = 'Search stocks…', search, hotkey, invalid }) {
  const stocks = useStore(s => s.stocks);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const input = useRef();
  const listRef = useRef();
  const star = new Set(starred);
  const list = useMemo(() => {
    const m = matches(stocks, q);
    return q.trim() ? m : [...m.filter(x => star.has(x.symbol)), ...m.filter(x => !star.has(x.symbol))];
  }, [stocks, q, starred.join()]);
  const current = stocks && value ? stocks.find(x => x.symbol === value) : null;

  useEffect(() => {
    if (!hotkey) return;
    const onKey = e => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [hotkey]);
  useEffect(() => { setHi(0); }, [q]);
  useEffect(() => {
    const el = listRef.current?.children[hi];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const pick = x => {
    onChange(x.symbol);
    setOpen(false);
    setQ('');
    if (search) input.current?.blur();
  };
  const onKey = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi(h => Math.min(h + 1, list.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (list[hi]) pick(list[hi]); }
    else if (e.key === 'Escape') { setOpen(false); input.current?.blur(); }
  };
  const shown = open ? q : search ? '' : current ? `${current.symbol} · ${current.name_ar || ''}` : value || '';
  return html`<div class=${search ? 'search' : 'picker'}>
    ${search && html`<${Icon} name="search" />`}
    <input ref=${input} class=${cls('input', invalid && 'invalid')} value=${shown} placeholder=${tx(placeholder)}
      onFocus=${() => { setOpen(true); setQ(''); }} onBlur=${() => setTimeout(() => setOpen(false), 150)}
      onInput=${e => { setQ(e.target.value); setOpen(true); }} onKeyDown=${onKey} autocomplete="off" spellcheck=${false} />
    ${search && !open && html`<kbd>/</kbd>`}
    ${open && html`<div class="dropdown" ref=${listRef}>${list.length ? list.map((x, i) => html`
      <div class=${cls('dd-item', i === hi && 'on')} onMouseDown=${e => { e.preventDefault(); pick(x); }} onMouseEnter=${() => setHi(i)}>
        <span class="s">${star.has(x.symbol) ? '⭐ ' : ''}${x.symbol}</span>
        <span class="n"><span dir="rtl">${x.name_ar || ''}</span> <span class="faint">· ${tn(x.sector || '')}</span></span>
        <span class="p">${x.close != null ? html`${fmt.price(x.close)} <${Change} value=${x.change} />` : html`<span class="faint">${t('no data')}</span>`}</span>
      </div>`) : html`<div class="dd-empty">${t(stocks ? 'No stock matches.' : 'Loading stocks…')}</div>`}</div>`}
  </div>`;
}

// ------------------------------------------------------------------ dialogs, toasts, job progress
export function Confirm({ title, text, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  return html`<div class="modal-bg" onMouseDown=${e => e.target === e.currentTarget && onClose()}>
    <div class="modal" role="dialog" aria-modal="true">
      <h3>${tx(title)}</h3><p>${tx(text)}</p>
      <div class="actions">
        <button class="btn ghost" onClick=${onClose}>${t('Cancel')}</button>
        <button class=${cls('btn', danger ? 'danger' : 'primary')} disabled=${busy}
          onClick=${async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } onClose(); }}>${tx(confirmLabel)}</button>
      </div>
    </div></div>`;
}

export function Toasts() {
  const toasts = useStore(s => s.toasts);
  return html`<div class="toasts" role="status">${toasts.map(x => html`<div class=${`toast ${x.tone}`} key=${x.id}>
    <${Icon} name=${x.tone === 'error' ? 'xCircle' : 'checkCircle'} /><div>${x.message}</div>
    <button class="x" onClick=${() => dismissToast(x.id)} aria-label=${t('Dismiss')}><${Icon} name="x" size=${14} /></button></div>`)}</div>`;
}

export function useJob(kind) {
  const job = useStore(s => s.status && s.status.job);
  const running = job && job.state === 'running';
  return { job, running, mine: running && (!kind || job.kind === kind) };
}

export function JobControl() {
  const { job, running } = useJob();
  const market = useStore(s => s.status && s.status.market);
  const scanUrl = useStore(s => s.status && s.status.scan_url);
  const owner = useStore(s => s.owner);
  if (running) {
    const pct = Math.round((job.progress || 0) * 100);
    return html`<div class="job" title=${job.message}><span class="spinner"></span>
      <span class="msg">${job.label}: ${job.message}</span>
      <span class="pbar"><span style=${`width:${pct}%`}></span></span><b>${pct}%</b></div>`;
  }
  if (store.me && !store.me.user.is_admin) {
    const pill = market && html`<span class="data-pill" title=${t('The site scans by itself after every close')}>
      <${Icon} name="check" size=${14} /><span class="hide-mobile">${t('Data:')}${' '}</span>${t('{date} close', { date: fmt.date(market.date, false) })}</span>`;
    // The GitHub Pages site: the owner's button opens the scan on GitHub (Settings → Run a scan now).
    const url = STATIC && owner && scanUrl;
    return url ? html`${pill}<a class="btn primary" href=${url} target="_blank" rel="noopener noreferrer"
      onClick=${() => watchForData()} title="Opens the scan on GitHub: press Run workflow there. The new data shows here in about 5 minutes.">
      <${Icon} name="refresh" /><span class="btn-label">${t('Run scan')}</span></a>` : pill;
  }
  return html`<button class="btn primary" onClick=${() => startJob('/jobs/scan', { update_data: true })}
    title=${`Download the latest closing prices and look for signals${market ? ` (data now: ${fmt.date(market.date)} close)` : ''}`}>
    <${Icon} name="refresh" /><span class="btn-label">${t('Run scan')}</span></button>`;
}

export function JobProgress({ kind, title }) {
  const { job, mine } = useJob(kind);
  if (!mine) return null;
  const pct = Math.round((job.progress || 0) * 100);
  return html`<div class="card progress-card">
    <div class="row"><span class="spinner"></span><b>${title || job.label}</b><span class="faint" style="margin-inline-start:auto">${pct}%</span></div>
    <div class="pbar"><span style=${`width:${Math.max(pct, 3)}%`}></span></div>
    <div class="muted" style="font-size:13px">${job.message}</div></div>`;
}

// ------------------------------------------------------------------ live prices (TradingView's own boxes)
// Plain iframes from TradingView, not its script: TradingView's code runs in its own box and can't read this page
// (your portfolio, the unlocked signals). Its free EGX prices are about 15 minutes late ("D" next to the price).
// Kashif code → TradingView code where they differ: the same list as TV_ALIASES in egx_agent/data/prices.py.
export const TV_ALIASES = { AIHC: 'AIH', ANFI: 'TYCN', FCMD: 'EGS3I0S1C019', NAPR: 'EGS370O1C013' };
export const tvSymbol = sym => `EGX:${TV_ALIASES[sym] || sym}`;
const TV_WIDGET = 'https://www.tradingview-widget.com/embed-widget/';
const tvLocale = () => (store.lang === 'ar' ? 'ar_AE' : 'en');
const widgetSrc = (name, opts) => `${TV_WIDGET}${name}/?locale=${tvLocale()}#${encodeURIComponent(JSON.stringify(opts))}`;

function TvFrame({ src, height, title }) {
  return html`<iframe class="tv-frame" src=${src} title=${title} style=${`height:${height}px`} loading="lazy"
    referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>`;
}

export function LiveChart({ symbol, height = 520 }) {
  const theme = useStore(s => s.theme);
  const q = new URLSearchParams({ symbol: tvSymbol(symbol), interval: 'D', theme, style: '1', locale: tvLocale(),
    timezone: 'Africa/Cairo', hidesidetoolbar: '1', symboledit: '0', saveimage: '0', withdateranges: '1',
    hideideas: '1' });
  return html`<${TvFrame} key=${theme + symbol} src=${`https://s.tradingview.com/widgetembed/?${q}`} height=${height}
    title=${`${symbol} live chart from TradingView`} />`;
}

export function LiveQuote({ symbol }) {
  const theme = useStore(s => s.theme);
  return html`<${TvFrame} key=${theme + symbol} height=${92} title=${`${symbol} live price from TradingView`}
    src=${widgetSrc('single-quote', { symbol: tvSymbol(symbol), width: '100%', colorTheme: theme, isTransparent: true })} />`;
}

// A live price table for a few stocks (EGX30 is "EGX30"). At most 15, so the box stays short.
export function LiveQuotes({ symbols, title = 'Live' }) {
  const theme = useStore(s => s.theme);
  const list = [...new Set(symbols)].slice(0, 15);
  if (!list.length) return null;
  const opts = { width: '100%', height: '100%', colorTheme: theme, isTransparent: true, showSymbolLogo: true,
    symbolsGroups: [{ name: title, symbols: list.map(s => ({ name: tvSymbol(s), displayName: s })) }] };
  return html`<${TvFrame} key=${theme + list.join()} height=${96 + 38 * list.length} src=${widgetSrc('market-quotes', opts)}
    title=${t('Live prices from TradingView')} />`;
}

export const LIVE_NOTE = 'Live prices from TradingView, about 15 minutes late. The signals, stops and your profit / loss still use the last close.';
