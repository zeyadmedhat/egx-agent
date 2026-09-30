// Heatmap: the whole market in one picture. One tile per stock that traded at the last close, grouped by sector,
// sized by the company's value (or the money traded in it), coloured by its move. Tap a tile for the stock.
import { html, useApi, useState, useEffect, useRef, useMemo, fmt, go, stockHref, remember } from '../lib.js';
import { PageHead, PageLoading, Seg, Empty, SessionBadge } from '../ui.js';
import { t, tn } from '../i18n.js';

const PERIODS = [{ value: 'chg1', label: 'Last session' }, { value: 'ret5', label: '1 week' }, { value: 'ret21', label: '1 month' }];
const SIZES = [{ value: 'cap', label: 'Company value' }, { value: 'value', label: 'Money traded' }];
const FULL = { chg1: 0.05, ret5: 0.10, ret21: 0.20 };      // a move this big gets the strongest colour
const LABEL_H = 18;                                         // a sector's name above its tiles

// Squarified treemap (Bruls, Huizing & van Wijk): rectangles for `items` ({weight}) filling x, y, w, h, as close to
// squares as it can, biggest first.
export function squarify(items, x, y, w, h) {
  const total = items.reduce((s, it) => s + it.weight, 0);
  if (!total || w <= 0 || h <= 0) return [];
  let rest = [...items].sort((a, b) => b.weight - a.weight).map(it => ({ ...it, a: (it.weight / total) * w * h }));
  const worst = (row, side) => {
    const s = row.reduce((m, r) => m + r.a, 0), big = Math.max(...row.map(r => r.a)), small = Math.min(...row.map(r => r.a));
    return Math.max((side * side * big) / (s * s), (s * s) / (side * side * small));
  };
  const out = [];
  while (rest.length) {
    const side = Math.min(w, h);
    let n = 1;
    while (n < rest.length && worst(rest.slice(0, n + 1), side) <= worst(rest.slice(0, n), side)) n += 1;
    const row = rest.slice(0, n), area = row.reduce((m, r) => m + r.a, 0);
    if (w >= h) {                     // a column on the left
      const cw = area / h;
      let yy = y;
      for (const r of row) { const rh = r.a / cw; out.push({ ...r, x, y: yy, w: cw, h: rh }); yy += rh; }
      x += cw; w -= cw;
    } else {                          // a row along the top
      const rh = area / w;
      let xx = x;
      for (const r of row) { const rw = r.a / rh; out.push({ ...r, x: xx, y, w: rw, h: rh }); xx += rw; }
      y += rh; h -= rh;
    }
    rest = rest.slice(n);
  }
  return out;
}

function colour(v, full) {
  if (v == null || Math.abs(v) < 0.0005) return 'var(--panel-3)';
  const p = Math.round(28 + 62 * Math.min(1, Math.abs(v) / full));
  return `color-mix(in srgb, ${v > 0 ? 'var(--up)' : 'var(--down)'} ${p}%, var(--panel-2))`;
}

export function HeatmapPage() {
  const { data, error } = useApi('/market');
  const [period, setPeriod] = useState(() => remember('heat-period') || 'chg1');
  const [size, setSize] = useState(() => remember('heat-size') || 'cap');
  const box = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!box.current) return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [data]);

  const tiles = (data && data.tiles) || [];
  const used = useMemo(() => tiles.filter(x => x[size] > 0), [tiles, size]);
  const height = width < 600 ? Math.round(width * 1.45) : Math.round(Math.min(720, Math.max(420, width * 0.6)));
  const rects = useMemo(() => {
    if (!width || !used.length) return [];
    const bySector = new Map();
    for (const x of used) {
      const s = bySector.get(x.sector) || [];
      s.push({ ...x, weight: x[size] });
      bySector.set(x.sector, s);
    }
    const sectors = squarify([...bySector].map(([name, list]) => ({ name, list, weight: list.reduce((m, r) => m + r.weight, 0) })),
      0, 0, width, height);
    return sectors.map(sec => {
      const label = sec.h > 44 && sec.w > 70;
      return { ...sec, label, stocks: squarify(sec.list, sec.x + 1, sec.y + (label ? LABEL_H : 1), sec.w - 2,
        sec.h - (label ? LABEL_H : 1) - 1) };
    });
  }, [used, size, width, height]);

  if (!data) return html`<${PageHead} title="Heatmap" /><${PageLoading} error=${error} />`;
  if (!tiles.length) {
    return html`<${PageHead} title="Heatmap" /><div class="card"><${Empty} icon="bars" title="No price data yet"
      text="Run a scan first. The heatmap is drawn from every stock's last close." /></div>`;
  }
  const moved = tiles.filter(x => x[period] != null);
  const up = moved.filter(x => x[period] > 0.0005).length, down = moved.filter(x => x[period] < -0.0005).length;
  const full = FULL[period];
  const left = tiles.length - used.length;
  const pick = (setter, key) => v => { setter(v); remember(key, v); };
  return html`
    <${PageHead} title="Heatmap"
      sub=${t('Every stock that traded at the {date} close, by sector. Bigger tiles are bigger companies; green rose, red fell.', { date: fmt.date(data.breadth && data.breadth.date) })}>
      ${data.breadth && html`<${SessionBadge} dataDate=${data.breadth.date} />`}<//>
    <div class="row heat-controls">
      <${Seg} options=${PERIODS} value=${period} onChange=${pick(setPeriod, 'heat-period')} />
      <${Seg} options=${SIZES} value=${size} onChange=${pick(setSize, 'heat-size')} />
      <span class="faint heat-count"><b class="up">${fmt.int(up)}</b> ${t('up')} · <b class="down">${fmt.int(down)}</b> ${t('down')}
        · ${fmt.int(moved.length - up - down)} ${t('unchanged')}</span>
    </div>
    <div class="card flush heat-card">
      <div class="heatmap" ref=${box} style=${`height:${height}px`} role="img"
        aria-label=${t('Heatmap of {n} stocks', { n: used.length })}>
        ${rects.map(sec => html`<div class="heat-sector" key=${sec.name}
            style=${`left:${sec.x}px;top:${sec.y}px;width:${sec.w}px;height:${sec.h}px`}>
          ${sec.label && html`<div class="heat-sector-name">${tn(sec.name)}</div>`}</div>
          ${sec.stocks.map(x => {
            const v = x[period], fs = Math.max(9, Math.min(18, Math.min(x.w / 4.2, x.h / 2.6)));
            const strong = v != null && Math.abs(v) / full > 0.4;
            return html`<a class=${strong ? 'heat-tile strong' : 'heat-tile'} key=${x.symbol} href=${stockHref(x.symbol)}
              onClick=${e => { e.preventDefault(); go(stockHref(x.symbol)); }}
              style=${`left:${x.x}px;top:${x.y}px;width:${Math.max(0, x.w - 1)}px;height:${Math.max(0, x.h - 1)}px;background:${colour(v, full)};font-size:${fs}px`}
              title=${`${x.symbol} · ${tn(x.sector)} · ${v == null ? '–' : fmt.pct(v, 1)} · ${fmt.short(x[size])} EGP`}>
              ${x.w > 30 && x.h > 16 && html`<b>${x.symbol}</b>`}
              ${x.w > 38 && x.h > 32 && html`<span>${v == null ? '–' : fmt.pct(Math.abs(v) < 0.0005 ? 0 : v, 1)}</span>`}</a>`;
          })}`)}
      </div>
    </div>
    <div class="heat-legend" aria-hidden="true">
      <span>${fmt.pct(-full, 0)}</span>
      ${[-1, -0.6, -0.3, -0.1, 0, 0.1, 0.3, 0.6, 1].map(k => html`<i style=${`background:${colour(k * full, full)}`}></i>`)}
      <span>${fmt.pct(full, 0)}</span>
    </div>
    <p class="faint" style="font-size:12px;margin-top:8px">${size === 'cap'
      ? t("Size: the company's market value from TradingView. {n} stocks without one are left out: switch to Money traded to see them.", { n: left })
      : t('Size: the average money traded in it a day over the last 20 sessions.')}
      ${' '}${t('A move over 30% in one day (a split or bonus shares not in the prices yet) shows as –.')}</p>`;
}
