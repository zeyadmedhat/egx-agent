// Shared building blocks: icons, Shariah badges, KPI tiles, tables, forms, the stock picker, dialogs.
import {
  html, Fragment, useState, useEffect, useRef, useMemo, store, useStore, startJob, dismissToast, fmt, tone, cls,
  stockHref, watchForData, toggleWatch, STATIC,
} from './lib.js';

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
  down: '<path d="m6 9 6 6 6-6"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
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
  return html`<svg class="icon" viewBox="0 0 24 24" style=${style} aria-hidden="true" dangerouslySetInnerHTML=${{ __html: ICONS[name] || '' }}></svg>`;
}

// ------------------------------------------------------------------ Shariah badges + index pills
const KASHIF = {
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
    : html`<span class="badge muted" title="Not in the EGX33 Shariah index">EGX33 ✗</span>`;
  const [c, text] = KASHIF[info.kashif_status] || ['muted', 'Not on Kashif'];
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
       onClick=${e => e.stopPropagation()}><span class="dot"></span>Kashif · ${text}</a>
  </div>`;
}
export function IndexPills({ info }) {
  if (!info) return null;
  const tags = [['egx30', 'EGX30'], ['egx70', 'EGX70'], ['egx33', 'EGX33']].filter(([k]) => info[k]);
  return tags.map(([, t]) => html`<span class="idx-pill">${t}</span>`);
}

// ------------------------------------------------------------------ chips, tiles, bits
const STATUS = {
  ADJUST: 'adjust', EXIT: 'exit', REVIEW: 'review', 'TIGHTEN STOP': 'tighten', HOLD: 'hold', 'NO DATA': 'nodata',
  BUY: 'buy', WATCH: 'watch',
};
const STATUS_LABEL = { ADJUST: 'UPDATE SHARES' };
export function StatusChip({ status }) {
  return html`<span class=${`chip ${STATUS[status] || 'nodata'}`}><span class="dot"></span>${STATUS_LABEL[status] || status}</span>`;
}

export function Kpi({ label, value, sub, valueClass, subClass, title, compact, icon }) {
  return html`<div class=${cls('kpi', compact && 'compact')} title=${title}>
    <div class="k-label">${icon && html`<${Icon} name=${icon} size=${14} />`}${label}</div>
    <div class=${cls('k-value', valueClass)}>${value}</div>
    ${sub != null && sub !== '' && html`<div class=${cls('k-sub', subClass)}>${sub}</div>`}
  </div>`;
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

export function ScoreBar({ score }) {
  const v = Math.max(0, Math.min(100, score || 0));
  return html`<div class="score-cell"><b>${Math.round(v)}</b><div class=${cls('bar', v >= 70 ? 'up' : '')} style="flex:1">
    <span style=${`width:${v}%`}></span></div></div>`;
}

export function DayBar({ day, max, review }) {
  const pct = Math.min(100, (day / max) * 100);
  const t = day >= max ? 'down' : day >= review ? 'warn' : '';
  return html`<div class="days"><span>Day ${day} of ${max}</span><div class=${cls('bar', t)}><span style=${`width:${pct}%`}></span></div></div>`;
}

export function Empty({ icon = 'info', title, text, action }) {
  return html`<div class="empty">
    <div class="e-icon"><${Icon} name=${icon} size=${22} /></div>
    ${title && html`<h3>${title}</h3>`}
    ${text && html`<p>${text}</p>`}
    ${action && html`<div class="e-action">${action}</div>`}
  </div>`;
}

export function Callout({ tone: t = '', icon, children }) {
  const ic = icon || (t === 'warn' ? 'alert' : t === 'ok' ? 'checkCircle' : t === 'bad' ? 'xCircle' : 'info');
  return html`<div class=${cls('callout', t)}><${Icon} name=${ic} /><div>${children}</div></div>`;
}

export function PageHead({ title, sub, children }) {
  return html`<div class="page-head"><div><h1>${title}</h1>${sub && html`<div class="sub">${sub}</div>`}</div>
    ${children && html`<div class="row">${children}</div>`}</div>`;
}

export function SectionHead({ title, count, hint, children }) {
  return html`<div class="section-head"><h2>${title}</h2>
    ${count != null && html`<span class="pill-count">${count}</span>`}
    ${hint && html`<span class="hint">${hint}</span>`}
    ${children && html`<div class="right">${children}</div>`}</div>`;
}

export function Disclaimer() {
  return html`<div class="disclaimer">Rules-based signals to support your own decisions. Not investment advice: you
    decide and place every order yourself. Past (backtest) results do not guarantee future returns.</div>`;
}

export function PageLoading({ error }) {
  if (error) return html`<div class="card"><${Callout} tone="bad"><b>Couldn't load this page.</b> ${error.message}<//></div>`;
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
    return html`<span class="chance-off" title="Not in the model's top 10% today. Its test results are about its top picks, so it doesn't give a chance for the rest.">not a top pick</span>`;
  }
  const ratio = base ? p / base : 1;
  return html`<span class=${cls('chance', ratio >= 1.3 ? 'up' : ratio <= 0.8 ? 'low' : '')}
    title=${base ? `The average liquid stock: ${fmt.pct(base, 0, false)}` : ''}>${fmt.pct(p, 0, false)}</span>`;
}

// Why the prediction model scored a stock as it did: the measures that pushed its score up (green) and down (red),
// from its own trees (predict.explain). Whole-market measures are left out: they move every stock alike.
export function Why({ items }) {
  if (!items || !items.length) return null;
  return html`<ul class="model-why" aria-label="Why the model scored it like this">${items.map(x => html`<li
    class=${x.up ? 'up' : 'down'} key=${x.f} title=${x.up ? 'Pushed its score up' : 'Pulled its score down'}>
    <span aria-hidden="true">${x.up ? '▲' : '▼'}</span>${x.text}</li>`)}</ul>`;
}

// A star that adds the stock to your watchlist (or takes it off).
export function WatchStar({ symbol, label }) {
  const list = useStore(s => s.watchlist) || [];
  const on = list.includes(symbol);
  return html`<button type="button" class=${cls('star-btn', on && 'on', label && 'labelled')}
    title=${on ? 'On your watchlist: click to remove it' : 'Add to your watchlist'} aria-pressed=${on}
    onClick=${e => { e.stopPropagation(); toggleWatch(symbol); }}>${on ? '★' : '☆'}${label ? html`<span>${on ? 'Watching' : 'Watch'}</span>` : ''}</button>`;
}

// What a buyer or holder should know now (data/news.py cautions): an ex-dividend date within a month, bonus
// shares or a rights issue coming, bad news this week. compact: one chip each.
const CAUTION_SHORT = { ex_dividend: 'Ex-dividend', bonus: 'Bonus shares', split: 'Split', rights: 'Rights issue',
  bad_news: 'Bad news?' };
export function Cautions({ items, compact }) {
  if (!items || !items.length) return null;
  if (compact) {
    return html`<span class="cautions">${items.map(c => html`<span class=${cls('caution-chip', c.level)} title=${c.text}>
      <${Icon} name=${c.level === 'warn' ? 'alert' : 'info'} size=${12} />${CAUTION_SHORT[c.kind] || c.kind}${
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
  if (!items || !items.length) return html`<p class="muted" style="font-size:13px">${empty}</p>`;
  const shown = limit && !all ? items.slice(0, limit) : items;
  return html`<ul class="news-list">${shown.map(n => html`<li key=${`${n.id}|${n.symbol || ''}`}>
      <span class=${cls('tone-dot', n.tone > 0 ? 'up' : n.tone < 0 ? 'down' : '')}
        title=${n.tone > 0 ? 'Sounds like good news (keyword rules)' : n.tone < 0 ? 'Sounds like bad news (keyword rules)' : 'Neutral'}></span>
      <div class="news-body">
        <a class="news-title" dir="auto" href=${n.url} target="_blank" rel="noopener noreferrer">${n.title}</a>
        <div class="news-meta">
          ${showSymbol && n.symbol && html`<a class="sym-link" href=${stockHref(n.symbol)}>${n.symbol}</a>`}
          <span>${sources[n.source] || n.source}</span><span>${fmt.date(n.published.slice(0, 10))} ${n.published.slice(11, 16)}</span>
          ${(n.tags || []).map(t => html`<span class="tag">${TAG_LABELS[t] || t}</span>`)}
        </div>
      </div></li>`)}</ul>
    ${limit && items.length > limit && html`<button class="linkish" style="margin-top:8px" onClick=${() => setAll(!all)}>
      ${all ? 'Show fewer' : `Show all ${items.length}`}</button>`}`;
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
    return html`<a class=${cls('switch-pill', sw.state)} href="#/market" title=${`${sw.text} ${SWITCH_DO[sw.state]}`}>
      <span class="dot"></span>Model picks: ${sw.label}</a>`;
  }
  return html`<${Callout} tone=${SWITCH_TONE[sw.state]}><b>Market switch: ${sw.label}.</b>${' '}${sw.text}${' '}
    ${SWITCH_DO[sw.state]}${' '}<span class="faint">Tested 2016–2026, it cut the worst drop of the model's top picks from
    −62% to −22%. Your BUY rules keep their own EGX30 rule.</span><//>`;
}

export function Change({ value, digits = 2 }) {
  return html`<span class=${tone(value)}>${fmt.pct(value, digits)}</span>`;
}

export function StockCell({ symbol, info, sub }) {
  return html`<div><a class="sym" href=${stockHref(symbol)} onClick=${e => e.stopPropagation()}>${symbol}</a>
    ${sub !== false && html`<div class="sub" dir="auto" style="text-align:left">${sub || info?.name_ar || ''}</div>`}</div>`;
}

// ------------------------------------------------------------------ segmented control / switch
export function Seg({ options, value, onChange }) {
  return html`<div class="seg">${options.map(o => html`<button type="button" class=${o.value === value ? 'on' : ''}
    onClick=${() => onChange(o.value)}>${o.label}</button>`)}</div>`;
}
export function Switch({ checked, onChange, label }) {
  return html`<label class="switch"><input type="checkbox" checked=${checked} onChange=${e => onChange(e.target.checked)} />
    <span class="track"></span>${label && html`<span>${label}</span>`}</label>`;
}
export function Field({ label, help, error, children, className }) {
  return html`<div class=${cls('field', className)}>
    ${label && html`<label>${label}</label>`}${children}
    ${error ? html`<div class="f-error">${error}</div>` : help && html`<div class="f-help">${help}</div>`}</div>`;
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
      onClick=${() => clickSort(c)} title=${c.title}>${c.label}${sort && sort.key === c.key
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
    }) : html`<tr><td colspan=${columns.length} class="table-empty">${empty}</td></tr>`}</tbody>
  </table>${limit && sorted.length > limit && html`<div class="table-more">
    <button class="linkish" onClick=${() => setAll(a => !a)}>${all ? 'Show fewer' : `Show all ${sorted.length}`}</button></div>`}</div>`;
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
    <input ref=${input} class=${cls('input', invalid && 'invalid')} value=${shown} placeholder=${placeholder}
      onFocus=${() => { setOpen(true); setQ(''); }} onBlur=${() => setTimeout(() => setOpen(false), 150)}
      onInput=${e => { setQ(e.target.value); setOpen(true); }} onKeyDown=${onKey} autocomplete="off" spellcheck=${false} />
    ${search && !open && html`<kbd>/</kbd>`}
    ${open && html`<div class="dropdown" ref=${listRef}>${list.length ? list.map((x, i) => html`
      <div class=${cls('dd-item', i === hi && 'on')} onMouseDown=${e => { e.preventDefault(); pick(x); }} onMouseEnter=${() => setHi(i)}>
        <span class="s">${star.has(x.symbol) ? '⭐ ' : ''}${x.symbol}</span>
        <span class="n"><span dir="rtl">${x.name_ar || ''}</span> <span class="faint">· ${x.sector || ''}</span></span>
        <span class="p">${x.close != null ? html`${fmt.price(x.close)} <${Change} value=${x.change} />` : html`<span class="faint">no data</span>`}</span>
      </div>`) : html`<div class="dd-empty">${stocks ? 'No stock matches.' : 'Loading stocks…'}</div>`}</div>`}
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
      <h3>${title}</h3><p>${text}</p>
      <div class="actions">
        <button class="btn ghost" onClick=${onClose}>Cancel</button>
        <button class=${cls('btn', danger ? 'danger' : 'primary')} disabled=${busy}
          onClick=${async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } onClose(); }}>${confirmLabel}</button>
      </div>
    </div></div>`;
}

export function Toasts() {
  const toasts = useStore(s => s.toasts);
  return html`<div class="toasts" role="status">${toasts.map(t => html`<div class=${`toast ${t.tone}`} key=${t.id}>
    <${Icon} name=${t.tone === 'error' ? 'xCircle' : 'checkCircle'} /><div>${t.message}</div>
    <button class="x" onClick=${() => dismissToast(t.id)} aria-label="Dismiss"><${Icon} name="x" size=${14} /></button></div>`)}</div>`;
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
    const pill = market && html`<span class="data-pill" title="The site scans by itself after every close">
      <${Icon} name="check" size=${14} /><span class="hide-mobile">Data:${' '}</span>${fmt.date(market.date, false)} close</span>`;
    // The GitHub Pages site: the owner's button opens the scan on GitHub (Settings → Run a scan now).
    const url = STATIC && owner && scanUrl;
    return url ? html`${pill}<a class="btn primary" href=${url} target="_blank" rel="noopener noreferrer"
      onClick=${() => watchForData()} title="Opens the scan on GitHub: press Run workflow there. The new data shows here in about 5 minutes.">
      <${Icon} name="refresh" /> Run scan</a>` : pill;
  }
  return html`<button class="btn primary" onClick=${() => startJob('/jobs/scan', { update_data: true })}
    title=${`Download the latest closing prices and look for signals${market ? ` (data now: ${fmt.date(market.date)} close)` : ''}`}>
    <${Icon} name="refresh" /> Run scan</button>`;
}

export function JobProgress({ kind, title }) {
  const { job, mine } = useJob(kind);
  if (!mine) return null;
  const pct = Math.round((job.progress || 0) * 100);
  return html`<div class="card progress-card">
    <div class="row"><span class="spinner"></span><b>${title || job.label}</b><span class="faint" style="margin-left:auto">${pct}%</span></div>
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
const widgetSrc = (name, opts) => `${TV_WIDGET}${name}/?locale=en#${encodeURIComponent(JSON.stringify(opts))}`;

function TvFrame({ src, height, title }) {
  return html`<iframe class="tv-frame" src=${src} title=${title} style=${`height:${height}px`} loading="lazy"
    referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>`;
}

export function LiveChart({ symbol, height = 520 }) {
  const theme = useStore(s => s.theme);
  const q = new URLSearchParams({ symbol: tvSymbol(symbol), interval: 'D', theme, style: '1', locale: 'en',
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
    title="Live prices from TradingView" />`;
}

export const LIVE_NOTE = 'Live prices from TradingView, about 15 minutes late. The signals, stops and your P&L still use the last close.';
