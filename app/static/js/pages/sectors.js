// Market → Sectors: each sector's typical liquid stock over 4 weeks and 1 week, and its share of the money traded
// in the last 4 weeks against the 4 weeks before (views.movers → sector_trend). Shows where money went lately.
// Tested on EGX 2017–2026: the past 4 weeks' order of sectors didn't predict the next 4 weeks (rank correlation 0.01).
import { html, useApi, useState, fmt, tone, remember } from '../lib.js';
import { PageHead, PageLoading, Seg, Empty, SessionBadge } from '../ui.js';
import { t, tn } from '../i18n.js';
import { SectorMoney } from './market.js';

const PERIODS = [{ value: 'ret21', label: '4 weeks' }, { value: 'ret5', label: '1 week' }];

export function SectorsPage() {
  const { data, error } = useApi('/market');
  const [period, setPeriod] = useState(() => remember('sector-period') || 'ret21');
  if (!data) return html`<${PageHead} title="Sectors" /><${PageLoading} error=${error} />`;
  const rows = [...(data.sector_trend || [])].filter(r => r[period] != null).sort((a, b) => b[period] - a[period]);
  if (!rows.length) {
    return html`<${PageHead} title="Sectors" /><div class="card"><${Empty} icon="bars" title="No price data yet"
      text="Run a scan first." /></div>`;
  }
  const top = Math.max(...rows.map(r => Math.abs(r[period])), 0.01);
  return html`
    <${PageHead} title="Sectors" sub=${t('How each sector moved, and where the money went.')}>
      ${data.breadth && html`<${SessionBadge} dataDate=${data.breadth.date} />`}<//>
    <div class="row heat-controls">
      <${Seg} options=${PERIODS} value=${period} onChange=${v => { setPeriod(v); remember('sector-period', v); }} />
    </div>
    <div class="card">
      ${rows.map(r => {
        const w = Math.abs(r[period]) / top * 50, more = r.share - r.share_before;
        return html`<div class="sector-row" key=${r.sector}>
          <div class="sector-name"><b>${tn(r.sector)}</b> <span class="faint">${t('{n} stocks', { n: r.stocks })}</span></div>
          <div class="sector-bar"><span class=${tone(r[period])}
            style=${r[period] >= 0 ? `inset-inline-start:50%;width:${w}%` : `inset-inline-end:50%;width:${w}%`}></span></div>
          <b class=${'sector-pct ' + tone(r[period])}>${fmt.pct(r[period])}</b>
          <div class="sector-money faint">${t('Share of money: {a} → {b}', { a: fmt.pct(r.share_before, 0, false), b: fmt.pct(r.share, 0, false) })}
            ${Math.abs(more) >= 0.01 && html` <b class=${tone(more)}>${more > 0 ? '▲' : '▼'}</b>`}</div>
        </div>`;
      })}
    </div>
    ${data.sector_money && data.sector_money.length > 0 && html`<div style="margin-top:14px"><${SectorMoney} rows=${data.sector_money} /></div>`}
    <p class="faint" style="font-size:13px;margin-top:10px">${t('The move is the typical (middle) stock in each sector that trades 5 million pounds a day or more. Share of money: the last 4 weeks against the 4 weeks before. Tested on EGX since 2017: sectors that rose most did no better over the next 4 weeks. This shows where money went, not where it will go. Not advice.')}</p>`;
}
