// Stock: TradingView-style chart with your levels, why it does or doesn't qualify, your position, Shariah details.
import { html, useApi, useState, useEffect, useMemo, fmt, tone, cls, go, stockHref, remember, todayISO } from '../lib.js';
import {
  Icon, Badges, IndexPills, StatusChip, Kpi, Callout, PageLoading, StockPicker, Seg, Disclaimer, DayBar, Chance, WatchStar,
  Cautions, NewsList, Why, LiveChart, LiveQuote, LIVE_NOTE, Term, More, Change, StockAvatar,
} from '../ui.js';
import { t } from '../i18n.js';
import { PriceChart } from '../charts.js';

const RANGES = [
  { value: 60, label: '3M' }, { value: 120, label: '6M' }, { value: 250, label: '1Y' }, { value: 500, label: '2Y' },
  { value: 1000, label: '4Y' }, { value: 100000, label: 'All' },   // labels go through t() in Seg
];
const VIEWS = [{ value: 'agent', label: 'Agent chart' }, { value: 'live', label: 'Live (TradingView)' }];
const PANES = [['ema', 'Averages'], ['volume', 'Volume'], ['rsi', 'RSI'], ['macd', 'MACD']];

export function StockPage({ route }) {
  const sym = (route.arg || remember('symbol') || 'COMI').toUpperCase();
  useEffect(() => { remember('symbol', sym); }, [sym]);
  const { data, error } = useApi(`/stock/${encodeURIComponent(sym)}`);
  const [bars, setBars] = useState(Number(remember('bars')) || 250);
  const [show, setShow] = useState(() => {
    try { return { ema: true, volume: true, rsi: true, macd: true, ...JSON.parse(remember('panes') || '{}') }; }
    catch { return { ema: true, volume: true, rsi: true, macd: true }; }
  });
  const toggle = k => setShow(s => { const n = { ...s, [k]: !s[k] }; remember('panes', JSON.stringify(n)); return n; });
  const pickRange = v => { setBars(v); remember('bars', v); };
  const [view, setView] = useState(remember('chart_view') === 'live' ? 'live' : 'agent');
  const pickView = v => { setView(v); remember('chart_view', v); };

  const picker = html`<div class="page-head"><div><h1>${t('Stock')}</h1><div class="sub">${t('Chart, entry checklist and Shariah details')}</div></div>
    <div style="width:min(380px,100%)"><${StockPicker} value=${sym} onChange=${s => go(stockHref(s))}
      placeholder="Switch stock (symbol or name)…" /></div></div>`;
  if (!data) return html`${picker}<${PageLoading} error=${error} />`;

  const info = data.info || {};
  const st = data.stats;
  return html`${picker}
    <div class="card stock-head">
      <div class="who">
        <div class="sym-line"><${StockAvatar} symbol=${data.symbol} size=${40} /><span class="sym-big" style="font-size:26px">${data.symbol}</span>
          <${WatchStar} symbol=${data.symbol} label /><${IndexPills} info=${info} />
          ${data.signal && html`<${StatusChip} status=${data.signal.action} />`}
          ${data.position && html`<span class="tag"><${Icon} name="briefcase" size=${13} />${t('You hold it')}</span>`}</div>
        <div class="row" style="gap:8px"><span class="stock-name" dir="rtl">${info.name_ar || ''}</span>
          <span class="faint">·</span><span class="stock-sector">${info.sector || ''}</span></div>
        <${Badges} info=${info} />
      </div>
      ${st && html`<div class="price"><div class="big">${fmt.price(st.close)}</div>
        <div class="chg"><${Change} value=${st.change} pill /> <span class="faint" style="font-weight:500">${t('on the day')}</span></div>
        <div class="faint" style="font-size:12px">${t('Last bar {date}', { date: fmt.date(st.last_bar) })}</div>
        ${data.corporate && data.corporate.results && data.corporate.results.next && html`<div class="next-results">
          <${Term} k="results">${t('Next results')}<//>: <b>${t('expected around {date}', { date: fmt.date(data.corporate.results.next) })}</b></div>`}</div>`}
    </div>

    ${!data.has_data ? html`<div style="margin-top:14px"><${Callout} tone="warn"><b>${t('No price data.')}</b> ${data.message}<//></div>`
      : html`
      <div class="kpis" style="margin-top:14px">
        <${Kpi} compact label="Traded per day (20d avg)" value=${`${fmt.short(st.value_avg20)} EGP`} />
        <${Kpi} compact label=${html`<${Term} k="rsi">RSI (14)<//>`} value=${fmt.num(st.rsi14, 0)} sub=${st.rsi14 > 70 ? 'overbought' : st.rsi14 < 30 ? 'oversold' : 'neutral'} />
        <${Kpi} compact label=${html`<${Term} k="adx">${t('ADX trend strength')}<//>`} value=${fmt.num(st.adx14, 0)} sub=${st.adx14 >= 25 ? 'strong trend' : st.adx14 >= 20 ? 'moderate' : 'weak'} />
        <${Kpi} compact label=${html`<${Term} k="atr">${t('Daily range (ATR)')}<//>`} value=${fmt.pct(st.atr_pct, 1, false)} sub="average move per day" />
        <${Kpi} compact label="3-month return" value=${fmt.pct(st.ret63, 0)} valueClass=${tone(st.ret63)}
          sub=${st.index_ret63 != null ? `EGX30 ${fmt.pct(st.index_ret63, 0)}` : ''} />
        <${Kpi} compact label="1-year range" value=${`${fmt.price(st.low52)} – ${fmt.price(st.high52)}`} />
      </div>
      <div class="stock-layout">
        <div class="stack" style="min-width:0">
        <div class="card chart-card">
          <div class="chart-toolbar">
            <${Seg} options=${VIEWS} value=${view} onChange=${pickView} />
            ${view === 'agent' && html`<${Seg} options=${RANGES} value=${bars} onChange=${pickRange} />
            <div class="right">${PANES.map(([k, label]) => html`<button class=${cls('toggle-chip', show[k] && 'on')}
              onClick=${() => toggle(k)}>${t(label)}</button>`)}</div>`}
          </div>
          ${view === 'agent'
            ? html`<${PriceChart} series=${data.series} levels=${data.levels} fills=${data.fills} bars=${bars} show=${show} />`
            : html`<${LiveChart} symbol=${data.symbol} />
              <p class="faint chart-note">${t(LIVE_NOTE)} ${t('Your buy, stop and target lines are on the Agent chart.')}</p>`}
        </div>
        ${data.news && html`<div class="card stock-news"><div class="card-title"><${Icon} name="news" size=${15} />${t('News')}
            <span class="right faint">Mubasher, Reuters, Zawya</span></div>
          <${NewsList} items=${data.news} sources=${SOURCES} limit=${8}
            empty="No headlines for this stock yet. The agent reads a few stocks' news pages each run, so it can take a couple of days to reach every stock." />
          <${More} label="About these headlines"><p>${t('Headlines link to the publisher. The green/red dot is a rough guess from keywords, not a reading of the article.')}</p><//></div>`}
        </div>
        <aside class="stack">
          <div class="card live-card"><div class="card-title"><span class="live-dot"></span>${t('Live price')}
            <span class="right faint">${t('TradingView, ~15 min late')}</span></div><${LiveQuote} symbol=${data.symbol} /></div>
          <a class="btn block" href=${`#/calc/${encodeURIComponent(data.symbol)}`}><${Icon} name="coins" />${t('Size a buy with your rules')}</a>
          ${data.cautions && data.cautions.length > 0 && html`<div class="card"><div class="card-title">
            <${Icon} name="alert" size=${15} />${t('Good to know now')}</div><${Cautions} items=${data.cautions} /></div>`}
          ${data.position && html`<${PositionPanel} p=${data.position} hold=${data.hold} />`}
          <${SignalPanel} data=${data} />
          ${data.prediction && html`<${PredictionPanel} p=${data.prediction} />`}
          ${data.corporate && html`<${CorporatePanel} c=${data.corporate} />`}
          <${ShariahPanel} info=${info} />
        </aside>
      </div>`}
    <${Disclaimer} />`;
}

function SignalPanel({ data }) {
  const s = data.signal;
  if (!s) {
    const passed = (data.checklist || []).filter(c => c.ok).length;
    return html`<div class="card"><div class="card-title">${t('Entry checklist')}<span class="right faint">${t('{k}/{n} met', { k: passed, n: (data.checklist || []).length })}</span></div>
      <p class="muted" style="font-size:13px;margin-bottom:12px">${t('No signal for this stock at the last scan. A BUY needs all of these:')}</p>
      <ul class="checklist" dir="ltr">${(data.checklist || []).map(c => html`<li>
        <span class=${c.ok ? 'ok' : 'no'}><${Icon} name=${c.ok ? 'checkCircle' : 'xCircle'} /></span><span>${c.text}</span></li>`)}</ul></div>`;
  }
  const buy = s.action === 'BUY';
  return html`<div class="card">
    <div class="card-title"><${StatusChip} status=${s.action} /> <${Term} k="score">${t('Score')}<//> ${fmt.num(s.score, 0)}${s.setup ? ` · ${t(s.setup)}` : ''}</div>
    ${buy && html`<div class="stat-list" style="margin-bottom:14px">
      <span class="k"><${Term} k="buyupto">${t('Buy up to')}<//></span><span class="v">${fmt.price(s.entry_high)}</span>
      <span class="k"><${Term} k="stop">${t('Stop-loss')}<//></span><span class="v down">${fmt.price(s.stop)}</span>
      <span class="k"><${Term} k="target">${t('Target')}<//></span><span class="v up">${fmt.price(s.target)}</span>
      <span class="k">${t('Shares')}</span><span class="v">${s.shares ? fmt.int(s.shares) : '–'}</span>
      <span class="k">${t('Max loss')}</span><span class="v">${fmt.egp(s.risk_egp)}</span></div>`}
    ${!buy && html`<p class="muted" style="font-size:13px;margin-bottom:8px">${t('In a strong uptrend but no entry trigger yet.')}</p>`}
    <ul class="reasons" dir="ltr">${(s.reasons || []).map(r => html`<li class=${/^Caution/.test(r) ? 'caution' : ''}>${r}</li>`)}</ul>
    ${buy && html`<a class="btn primary block" style="margin-top:14px"
      href=${`#/portfolio?buy=${encodeURIComponent(data.symbol)}&price=${s.entry_high.toFixed(2)}&shares=${s.shares || ''}`}>
      <${Icon} name="plus" />${t('Log this buy')}</a>`}
  </div>`;
}

const SOURCES = { mubasher: 'Mubasher', reuters: 'Reuters', zawya: 'Zawya', 'dow-jones': 'Dow Jones', lse: 'LSE filings',
  alborsa: 'Al Borsa News', dne: 'Daily News Egypt' };

// Cash dividends (TradingView: the latest and the next announced; kept as they're seen), bonus shares/splits, and
// Mubasher's list of the company's corporate actions (announced → ex-date) from the exchange's filings.
function CorporatePanel({ c }) {
  const cash = c.dividends || [];
  const bonus = c.bonus || [];
  const acts = c.actions || [];
  const r = c.results;
  return html`<div class="card"><div class="card-title"><${Icon} name="coins" size=${15} />${t('Dividends, bonus shares & results')}
      ${c.yield != null && html`<span class="right faint">${t('Yield {pct} a year', { pct: fmt.pct(c.yield, 1, false) })}</span>`}</div>
    ${r && (r.next || r.last) && html`<div class="stat-list" style="margin-bottom:12px">
      ${r.next && html`<span class="k"><${Term} k="results">${t('Next results')}<//></span>
        <span class="v">${fmt.date(r.next)} <span class="tag">${t('expected')}</span></span>`}
      ${r.last && html`<span class="k">${t('Last results')}</span><span class="v" style="font-weight:500">${fmt.date(r.last)}</span>`}</div>`}
    ${cash.length ? html`<div class="stat-list">${cash.slice(0, 6).map(x => html`
      <span class="k">${fmt.date(x.ex_date)}${x.upcoming ? html` <span class="tag">${t('coming')}</span>` : ''}</span>
      <span class="v">${fmt.num(x.amount, x.amount < 1 ? 3 : 2)} ${t('EGP')}
        <span class="faint" style="font-weight:500"> ${fmt.pct(x.pct, 1, false)}${x.pay_date ? ` · ${t('paid {date}', { date: fmt.date(x.pay_date) })}` : ''}</span></span>`)}
      </div>` : html`<p class="muted" style="font-size:13px">${t('No cash dividend seen for it yet.')}</p>`}
    ${bonus.length > 0 && html`<div class="stat-list" style="margin-top:12px">${bonus.map(b => html`
      <span class="k">${fmt.date(b.ex_date)}</span><span class="v" style="font-weight:500">${b.text}</span>`)}</div>`}
    ${acts.length > 0 && html`<div class="card-sub" style="margin-top:14px;font-weight:650;font-size:13px">${t('Announcements (Mubasher)')}</div>
      <div class="stat-list" style="margin-top:6px">${acts.slice(0, 8).map(a => html`
        <span class="k">${a.effective ? fmt.date(a.effective) : '–'}${a.effective > todayISO() ? html` <span class="tag">${t('coming')}</span>` : ''}</span>
        <span class="v" style="font-weight:500">${t(a.label)}<span class="faint"> · ${t('announced {date}', { date: fmt.date(a.announced) })}</span></span>`)}</div>`}
    <${More} label="How to read these dates"><p>${t("Dates are ex-dates: buy before that day to get the dividend. Amounts per share, % of today's price, from TradingView. The announcements come from Mubasher's list of the exchange's filings. The next results date is TradingView's estimate from when the company reported before.")}</p><//></div>`;
}

function PredictionPanel({ p }) {
  return html`<div class="card"><div class="card-title"><${Icon} name="target" size=${15} />${t('Prediction model')}
    <span class="right faint">${fmt.date(p.date)} close</span></div>
    <p class="muted" style="font-size:13px;margin-bottom:12px">Chance that buying at the next open with the usual stop and
      target reaches the target first.</p>
    <div class="stat-list">
      <span class="k">${t('Within 2 weeks')}</span><span class="v"><${Chance} p=${p.p10} base=${p.base[10]} top=${p.top10} />
        <span class="faint" style="font-weight:500"> #${fmt.int(p.rank10)} of ${fmt.int(p.count)}</span></span>
      <span class="k">${t('Within 1 month')}</span><span class="v"><${Chance} p=${p.p20} base=${p.base[20]} top=${p.top20} />
        <span class="faint" style="font-weight:500"> #${fmt.int(p.rank20)} of ${fmt.int(p.count)}</span></span>
      <span class="k">${t('Average stock')}</span><span class="v">${fmt.pct(p.base[10], 0, false)} / ${fmt.pct(p.base[20], 0, false)}</span>
    </div>
    ${p.top_n && html`<p class="faint" style="font-size:12px;margin-top:10px">It gives a chance only for its top${' '}
      ${fmt.int(p.top_n)} stocks each day (its best 10%): its test results are about those.</p>`}
    ${p.why10 && p.why10.length > 0 && html`<div style="margin-top:14px">
      <div class="faint" style="font-size:12px;margin-bottom:6px">Why it ranks it #${fmt.int(p.rank10)} (2 weeks):
        green pushed it up, red down</div><${Why} items=${p.why10} /></div>`}
    <a class="btn sm block" style="margin-top:14px" href="#/predict">${t('How reliable is it?')}</a></div>`;
}

function PositionPanel({ p, hold }) {
  return html`<div class="card">
    <div class="card-title">${t('Your position')}<span class="right"><${StatusChip} status=${p.status} /></span></div>
    <div class="stat-list">
      <span class="k">${t('Shares')}</span><span class="v">${fmt.int(p.shares)}</span>
      <span class="k">${t('Average price')}</span><span class="v">${fmt.price(p.avg_price)}</span>
      <span class="k">${t('P&L after fees')}</span><span class=${cls('v', tone(p.pnl))}>${fmt.egp(p.pnl)} (${fmt.pct(p.pnl_pct)})</span>
      <span class="k">${t('Stop now')}</span><span class="v down">${fmt.price(p.stop)}</span>
      <span class="k">${t('Target')}</span><span class="v up">${fmt.price(p.target)}</span>
      <span class="k">${t('First buy')}</span><span class="v">${fmt.date(p.first_buy)}</span>
    </div>
    <p class="muted" style="font-size:13px;margin:12px 0">${p.reason}</p>
    <${DayBar} day=${p.day} max=${hold.max} review=${hold.review} />
    <a class="btn sm block" style="margin-top:12px" href="#/portfolio">${t('Manage in My Portfolio')}</a>
  </div>`;
}

function ShariahPanel({ info }) {
  return html`<div class="card"><div class="card-title"><${Icon} name="shield" size=${15} />${t('Shariah details')}</div>
    <div class="stat-list">
      <span class="k">${t('Kashif status')}</span><span class="v" dir="auto">${info.kashif_label || 'not listed'}</span>
      <span class="k">${t('Purity grade')}</span><span class="v">${info.purity || '–'}</span>
      <span class="k">${t('Purification')}</span><span class="v">${info.purification_pct || '–'}</span>
      <span class="k">${t('Statements date')}</span><span class="v">${info.statements_date || '–'}</span>
      <span class="k">${t('EGX33 member')}</span><span class="v">${info.egx33 ? (info.egx33_manual ? 'yes (added by you)' : 'yes') : 'no'}</span>
      <span class="k">${t('Last checked')}</span><span class="v">${info.kashif_updated ? fmt.date(info.kashif_updated) : '–'}</span>
    </div>
    <a class="btn sm block" style="margin-top:14px" href=${info.kashif_url} target="_blank" rel="noopener">
      ${t('Open on kasheif.com')} <${Icon} name="external" size=${14} /></a></div>`;
}
