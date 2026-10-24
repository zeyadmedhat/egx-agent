// News: the last month's headlines about EGX stocks and the market from reliable sources (Mubasher, Reuters, Zawya,
// Al Borsa News, Daily News Egypt), and what companies announced this month (the coming ex-dates are on Dividends &
// results). Headlines link to the
// publisher; the good/bad dot is a rough keyword guess. Filters are remembered on this device.
import { html, useApi, useState, useMemo, useStore, fmt, stockHref, remember } from '../lib.js';
import { Icon, PageHead, PageLoading, Seg, Callout, NewsList, TAG_LABELS, More } from '../ui.js';
import { t, tn } from '../i18n.js';

const SHOW = [{ value: 'stocks', label: 'Stock news' }, { value: 'mine', label: 'My stocks' },
  { value: 'market', label: 'Market & economy' }, { value: 'all', label: 'Everything' }];
const DEFAULTS = { show: 'stocks', source: '', tag: '', tone: '', q: '' };

function loadFilters() {
  try { return { ...DEFAULTS, ...JSON.parse(remember('news') || '{}') }; } catch { return { ...DEFAULTS }; }
}

export function NewsPage() {
  const { data, error } = useApi('/news');
  const stocks = useStore(s => s.stocks) || [];
  const names = useMemo(() => new Map(stocks.map(s => [s.symbol, s.name_ar || ''])), [stocks]);
  const [f, setF] = useState(loadFilters);
  const save = next => { setF(next); remember('news', JSON.stringify(next)); };
  const set = k => e => save({ ...f, [k]: e && e.target ? e.target.value : e });

  const mine = useMemo(() => new Set([...((data && data.held) || []), ...((data && data.watchlist) || [])]), [data]);
  const items = useMemo(() => {
    if (!data) return [];
    const q = f.q.trim().toLowerCase();
    return data.items.filter(n => {
      if (f.show === 'stocks' && !n.symbol) return false;
      if (f.show === 'market' && n.symbol) return false;
      if (f.show === 'mine' && !mine.has(n.symbol)) return false;
      if (f.source && n.source !== f.source) return false;
      if (f.tag && !(n.tags || []).includes(f.tag)) return false;
      if (f.tone === 'good' && !(n.tone > 0)) return false;
      if (f.tone === 'bad' && !(n.tone < 0)) return false;
      if (q && !`${n.title} ${n.symbol} ${names.get(n.symbol) || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, f, mine, names]);

  if (!data) return html`<${PageHead} title="News" /><${PageLoading} error=${error} />`;
  const announced = data.announced.filter(a => f.show !== 'mine' || mine.has(a.symbol));
  const changed = Object.keys(DEFAULTS).some(k => f[k] !== DEFAULTS[k]);
  const sourcesUsed = [...new Set(data.items.map(n => n.source))];

  return html`<${PageHead} title="News" sub="Headlines about EGX stocks and the market, and what companies announced.">
      <${Seg} options=${SHOW} value=${f.show} onChange=${set('show')} /><//>
    ${!data.items.length && html`<div style="margin-bottom:14px"><${Callout}><b>${t('No news downloaded yet.')}</b> ${t('It comes with the next scan after the close.')}<//></div>`}
    ${f.show === 'mine' && !mine.size && html`<div style="margin-bottom:14px"><${Callout}>${t('No stocks of yours yet: log a buy in My Portfolio or star stocks for your watchlist.')}<//></div>`}
    <div class="news-layout">
      <div>
        <div class="card" style="margin-bottom:12px"><div class="news-filters">
          <input class="input" style="flex:1;min-width:180px" placeholder=${t('Search headlines, symbols, names…')} value=${f.q}
            onInput=${set('q')} />
          <select class="input" style="width:auto" value=${f.source} onChange=${set('source')}>
            <option value="">${t('All sources')}</option>
            ${sourcesUsed.map(s => html`<option value=${s}>${data.sources[s] || s}</option>`)}</select>
          <select class="input" style="width:auto" value=${f.tag} onChange=${set('tag')}>
            <option value="">${t('All topics')}</option>
            ${data.tags.map(tag => html`<option value=${tag}>${t(TAG_LABELS[tag] || tag)}</option>`)}</select>
          <select class="input" style="width:auto" value=${f.tone} onChange=${set('tone')}>
            <option value="">${t('Any tone')}</option><option value="good">${t('Sounds good')}</option><option value="bad">${t('Sounds bad')}</option></select>
          ${changed && html`<button class="linkish" onClick=${() => save({ ...DEFAULTS })}>${t('Clear')}</button>`}
        </div></div>
        <div class="card">
          <div class="card-title"><${Icon} name="news" size=${15} />${t('{n} headlines', { n: fmt.int(items.length) })}
            <span class="right faint">${data.updated ? t('Updated {when}', { when: fmt.datetime(data.updated) }) : ''}</span></div>
          <${NewsList} items=${items} sources=${data.sources} showSymbol limit=${60}
            empty="No headline matches these filters." />
        </div>
        <${More} label="About these headlines"><p>${t("Only headlines are kept here: each links to the publisher's article. The topics and the green/red dot come from keyword rules in Arabic and English. They're a quick guide, not a reading of the article. The agent reads each stock's Mubasher page every few days, and Reuters and Zawya every run.")}</p><//>
      </div>
      <aside class="stack">
        <div class="card"><div class="card-title"><${Icon} name="info" size=${15} />${t('Announced this month')}</div>
          ${announced.length ? html`<div class="stat-list">${announced.slice(0, 25).map(a => html`
            <span class="k">${fmt.date(a.announced)}</span>
            <span class="v" style="font-weight:500"><a href=${stockHref(a.symbol)}>${a.symbol}</a> · ${tn(a.label)}${
              a.effective ? html`<span class="faint"> · ${fmt.date(a.effective)}</span>` : ''}</span>`)}</div>`
            : html`<p class="muted" style="font-size:13px">${t('Nothing new this month.')}</p>`}
          <p class="faint" style="font-size:12px;margin-top:10px">${t("From Mubasher's list of the exchange's filings.")}</p></div>
      </aside>
    </div>`;
}
