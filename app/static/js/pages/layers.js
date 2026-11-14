// Picks → 7 Layers: today's actively traded stocks at 6/7 layers or more, then the close ones at 5, each with what it
// misses and its BUY status; the live record of each day's 6/7 list against EGX30; and what 10 years of EGX said
// (views.layers_view, egx_agent/layers.py). A checklist, not BUY signals: the 10-year test is why.
import { html, useApi, fmt, cls, stockHref } from '../lib.js';
import { PageHead, PageLoading, Callout, StockAvatar, StatusChip, DataTable } from '../ui.js';
import { t } from '../i18n.js';

export const LAYER_NAMES = { trend: 'Trend', momentum: 'Momentum', volume: 'Volume', volatility: 'Volatility', squeeze: 'Squeeze',
  timeframes: 'Week & month', smart_money: 'Smart money' };

function StockTile({ r }) {
  return html`<a class=${cls('card', 'lay-tile', r.score >= 6 && 'pass')} href=${stockHref(r.symbol)}>
    <div class="pos-head"><${StockAvatar} symbol=${r.symbol} size=${34} />
      <div class="pos-who"><b class="sym-big">${r.symbol}</b>
        <div class="faint pos-sub">${fmt.price(r.close)} <span class=${r.chg1 >= 0 ? 'up' : 'down'}>${fmt.pct(r.chg1, 1)}</span></div></div>
      <span class=${cls('lay-score', r.score >= 6 && 'up')}>${r.score}<small>/7</small></span></div>
    <div class="lay-miss">${r.misses.length ? html`<span class="faint s">${t('Misses:')}</span> ${r.misses.map(k => html`<span class="tag">${t(LAYER_NAMES[k])}</span>`)}`
      : html`<span class="tag up">${t('All 7 pass')}</span>`}</div>
    ${r.action && html`<div style="margin-top:8px"><${StatusChip} status=${r.action} /></div>`}
  </a>`;
}

export function LayersPage() {
  const { data, error } = useApi('/layers');
  if (!data) return html`<${PageHead} title="7 Layers" /><${PageLoading} error=${error} />`;
  const pass = data.rows.filter(r => r.score >= data.pass_at), near = data.rows.filter(r => r.score < data.pass_at);
  const s = data.study, rec = data.record;
  // every year together: the stock-days at 6/7+ against the rest (layers.study by_score)
  const beat = test => { const g = ((s && s.by_score) || []).filter(r => r.n && test(r.score));
    const n = g.reduce((a, r) => a + r.n, 0); return n ? g.reduce((a, r) => a + r.n * r.beat, 0) / n : null; };
  const hi = s && { pass: beat(k => k >= data.pass_at), rest: beat(k => k < data.pass_at) };
  const columns = [
    { key: 'date', label: 'Day', render: r => fmt.date(r.date, false) },
    { key: 'symbol', label: 'Stock', render: r => html`<a href=${stockHref(r.symbol)}><b>${r.symbol}</b></a> <span class="faint">${r.score}/7</span>` },
    { key: 'now', label: 'Since then', align: 'r', render: r => r.sessions
      ? html`<span class=${r.now >= 0 ? 'up' : 'down'}>${fmt.pct(r.now, 1)}</span>` : html`<span class="faint">${t('Today')}</span>` },
    { key: 'egx30_now', label: 'EGX30', align: 'r', render: r => r.sessions ? html`<span class="faint">${fmt.pct(r.egx30_now, 1)}</span>` : '' },
  ];
  return html`
    <${PageHead} title="7 Layers" sub=${t('Stocks passing 6 or more of the 7 layers today, then the close ones at 5')} />
    <${Callout} tone="warn">${t('A checklist, not BUY signals.')} ${s && hi && hi.pass != null && t('On EGX since {year}, 6/7 or more beat EGX30 over the next month {a} of the time. Lower scores: {b}. As BUYs it did worse than the rules: {c} a year against {d}.', {
      year: s.from.slice(0, 4), a: fmt.pct(hi.pass, 0, false), b: fmt.pct(hi.rest, 0, false),
      c: fmt.pct(s.strict.cagr, 0, false), d: fmt.pct(s.rules.cagr, 0, false) })}<//>

    <section class="section"><h2 class="rt-h2">${t('6/7 or more')} <span class="pill-count">${pass.length}</span></h2>
      ${pass.length ? html`<div class="grid grid-3">${pass.map(r => html`<${StockTile} r=${r} />`)}</div>`
        : html`<div class="card"><p class="faint s" style="margin:0">${t('No actively traded stock passes 6 of the 7 layers today.')}</p></div>`}</section>
    ${near.length > 0 && html`<section class="section"><h2 class="rt-h2">${t('Close: 5/7')} <span class="pill-count">${near.length}</span></h2>
      <div class="grid grid-3">${near.map(r => html`<${StockTile} r=${r} />`)}</div></section>`}

    <section class="section"><h2 class="rt-h2">${t('Live record')}</h2>
      ${rec && rec.so_far ? html`<article class="card">
        <div class="rt-prices" style="margin-top:0">
          <div><div class="k">${t('Picks so far')}</div><div class="v">${fmt.int(rec.so_far.n)}</div><div class="s">${t('on {n} days, since {date}', { n: rec.days, date: fmt.date(rec.since, false) })}</div></div>
          <div><div class="k">${t('Beat EGX30 so far')}</div><div class=${cls('v', rec.so_far.beat >= 0.5 ? 'up' : 'down')}>${fmt.pct(rec.so_far.beat, 0, false)}</div>
            <div class="s">${t('ahead by {v} on average', { v: fmt.pct(rec.so_far.avg, 1) })}</div></div>
          <div><div class="k">${t('After a month')}</div>${rec.month ? html`<div class=${cls('v', rec.month.beat >= 0.5 ? 'up' : 'down')}>${fmt.pct(rec.month.beat, 0, false)}</div>
            <div class="s">${t('of {n} picks beat EGX30 over 20 sessions', { n: rec.month.n })}</div>` : html`<div class="v faint">–</div><div class="s">${t('none has had 20 sessions yet')}</div>`}</div>
        </div>
        <div class="card flush"><${DataTable} columns=${columns} rows=${rec.recent} rowKey=${r => r.date + r.symbol} limit=${10} /></div>
      </article>` : html`<div class="card"><p class="faint s" style="margin:0">${t('Each day’s 6/7 list is kept from now on, and shown here against EGX30 as it goes.')}</p></div>`}
    </section>
    <p class="faint s">${t('Telegram: send /watch SYMBOL layers to the bot for a message when that stock reaches 6/7.')}</p>`;
}
