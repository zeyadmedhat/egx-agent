// Stock: TradingView-style chart with your levels, why it does or doesn't qualify, your position, Shariah details.
import { html, useApi, useState, useEffect, useMemo, fmt, tone, cls, go, stockHref, remember } from '../lib.js';
import {
  Icon, Badges, IndexPills, StatusChip, Kpi, Callout, PageLoading, StockPicker, Seg, Disclaimer, DayBar, Chance, WatchStar,
} from '../ui.js';
import { PriceChart } from '../charts.js';

const RANGES = [
  { value: 60, label: '3M' }, { value: 120, label: '6M' }, { value: 250, label: '1Y' }, { value: 500, label: '2Y' },
  { value: 1000, label: '4Y' }, { value: 100000, label: 'All' },
];
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

  const picker = html`<div class="page-head"><div><h1>Stock</h1><div class="sub">Chart, entry checklist and Shariah details</div></div>
    <div style="width:min(380px,100%)"><${StockPicker} value=${sym} onChange=${s => go(stockHref(s))}
      placeholder="Switch stock (symbol or name)…" /></div></div>`;
  if (!data) return html`${picker}<${PageLoading} error=${error} />`;

  const info = data.info || {};
  const st = data.stats;
  return html`${picker}
    <div class="card stock-head">
      <div class="who">
        <div class="sym-line"><span class="sym-big" style="font-size:26px">${data.symbol}</span>
          <${WatchStar} symbol=${data.symbol} label /><${IndexPills} info=${info} />
          ${data.signal && html`<${StatusChip} status=${data.signal.action} />`}
          ${data.position && html`<span class="tag"><${Icon} name="briefcase" size=${13} />You hold it</span>`}</div>
        <div class="row" style="gap:8px"><span class="stock-name" dir="rtl">${info.name_ar || ''}</span>
          <span class="faint">·</span><span class="stock-sector">${info.sector || ''}</span></div>
        <${Badges} info=${info} />
      </div>
      ${st && html`<div class="price"><div class="big">${fmt.price(st.close)}</div>
        <div class=${cls('chg', tone(st.change))}>${fmt.pct(st.change, 2)} on the day</div>
        <div class="faint" style="font-size:12px">Last bar ${fmt.date(st.last_bar)}</div></div>`}
    </div>

    ${!data.has_data ? html`<div style="margin-top:14px"><${Callout} tone="warn"><b>No price data.</b> ${data.message}<//></div>`
      : html`
      <div class="kpis" style="margin-top:14px">
        <${Kpi} compact label="Traded per day (20d avg)" value=${`${fmt.short(st.value_avg20)} EGP`} />
        <${Kpi} compact label="RSI (14)" value=${fmt.num(st.rsi14, 0)} sub=${st.rsi14 > 70 ? 'overbought' : st.rsi14 < 30 ? 'oversold' : 'neutral'} />
        <${Kpi} compact label="ADX trend strength" value=${fmt.num(st.adx14, 0)} sub=${st.adx14 >= 25 ? 'strong trend' : st.adx14 >= 20 ? 'moderate' : 'weak'} />
        <${Kpi} compact label="Daily range (ATR)" value=${fmt.pct(st.atr_pct, 1, false)} sub="average move per day" />
        <${Kpi} compact label="3-month return" value=${fmt.pct(st.ret63, 0)} valueClass=${tone(st.ret63)}
          sub=${st.index_ret63 != null ? `EGX30 ${fmt.pct(st.index_ret63, 0)}` : ''} />
        <${Kpi} compact label="1-year range" value=${`${fmt.price(st.low52)} – ${fmt.price(st.high52)}`} />
      </div>
      <div class="stock-layout">
        <div class="card chart-card">
          <div class="chart-toolbar">
            <${Seg} options=${RANGES} value=${bars} onChange=${pickRange} />
            <div class="right">${PANES.map(([k, label]) => html`<button class=${cls('toggle-chip', show[k] && 'on')}
              onClick=${() => toggle(k)}>${label}</button>`)}</div>
          </div>
          <${PriceChart} series=${data.series} levels=${data.levels} fills=${data.fills} bars=${bars} show=${show} />
        </div>
        <aside class="stack">
          <a class="btn block" href=${`#/calc/${encodeURIComponent(data.symbol)}`}><${Icon} name="coins" />Size a buy with your rules</a>
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
    return html`<div class="card"><div class="card-title">Entry checklist<span class="right faint">${passed}/${(data.checklist || []).length} met</span></div>
      <p class="muted" style="font-size:13px;margin-bottom:12px">No signal for this stock at the last scan. A BUY needs all of these:</p>
      <ul class="checklist">${(data.checklist || []).map(c => html`<li>
        <span class=${c.ok ? 'ok' : 'no'}><${Icon} name=${c.ok ? 'checkCircle' : 'xCircle'} /></span><span>${c.text}</span></li>`)}</ul></div>`;
  }
  const buy = s.action === 'BUY';
  return html`<div class="card">
    <div class="card-title"><${StatusChip} status=${s.action} /> Score ${fmt.num(s.score, 0)}${s.setup ? ` · ${s.setup}` : ''}</div>
    ${buy && html`<div class="stat-list" style="margin-bottom:14px">
      <span class="k">Buy up to</span><span class="v">${fmt.price(s.entry_high)}</span>
      <span class="k">Stop-loss</span><span class="v down">${fmt.price(s.stop)}</span>
      <span class="k">Target</span><span class="v up">${fmt.price(s.target)}</span>
      <span class="k">Shares</span><span class="v">${s.shares ? fmt.int(s.shares) : '–'}</span>
      <span class="k">Max loss</span><span class="v">${fmt.egp(s.risk_egp)}</span></div>`}
    ${!buy && html`<p class="muted" style="font-size:13px;margin-bottom:8px">In a strong uptrend but no entry trigger yet.</p>`}
    <ul class="reasons">${(s.reasons || []).map(r => html`<li class=${/^Caution/.test(r) ? 'caution' : ''}>${r}</li>`)}</ul>
    ${buy && html`<a class="btn primary block" style="margin-top:14px"
      href=${`#/portfolio?buy=${encodeURIComponent(data.symbol)}&price=${s.entry_high.toFixed(2)}&shares=${s.shares || ''}`}>
      <${Icon} name="plus" />Log this buy</a>`}
  </div>`;
}

// Cash dividends (TradingView: the latest and the next announced; kept as they're seen) and bonus shares/splits.
function CorporatePanel({ c }) {
  const cash = c.dividends || [];
  const bonus = c.bonus || [];
  return html`<div class="card"><div class="card-title"><${Icon} name="coins" size=${15} />Dividends & bonus shares
      ${c.yield != null && html`<span class="right faint">Yield ${fmt.pct(c.yield, 1, false)} a year</span>`}</div>
    ${cash.length ? html`<div class="stat-list">${cash.slice(0, 6).map(r => html`
      <span class="k">${fmt.date(r.ex_date)}${r.upcoming ? html` <span class="tag">coming</span>` : ''}</span>
      <span class="v">${fmt.num(r.amount, r.amount < 1 ? 3 : 2)} EGP
        <span class="faint" style="font-weight:500"> ${fmt.pct(r.pct, 1, false)}${r.pay_date ? ` · paid ${fmt.date(r.pay_date)}` : ''}</span></span>`)}
      </div>` : html`<p class="muted" style="font-size:13px">No cash dividend seen for it yet.</p>`}
    ${bonus.length > 0 && html`<div class="stat-list" style="margin-top:12px">${bonus.map(b => html`
      <span class="k">${fmt.date(b.ex_date)}</span><span class="v" style="font-weight:500">${b.text}</span>`)}</div>`}
    <p class="faint" style="font-size:12px;margin-top:10px">Dates are ex-dates: buy before that day to get the
      dividend. Amounts per share, % of today's price. From TradingView, which gives the latest dividend and the next
      one once announced, so the list grows over time.</p></div>`;
}

function PredictionPanel({ p }) {
  return html`<div class="card"><div class="card-title"><${Icon} name="target" size=${15} />Prediction model
    <span class="right faint">${fmt.date(p.date)} close</span></div>
    <p class="muted" style="font-size:13px;margin-bottom:12px">Chance that buying at the next open with the usual stop and
      target reaches the target first.</p>
    <div class="stat-list">
      <span class="k">Within 2 weeks</span><span class="v"><${Chance} p=${p.p10} base=${p.base[10]} top=${p.top10} />
        <span class="faint" style="font-weight:500"> #${fmt.int(p.rank10)} of ${fmt.int(p.count)}</span></span>
      <span class="k">Within 1 month</span><span class="v"><${Chance} p=${p.p20} base=${p.base[20]} top=${p.top20} />
        <span class="faint" style="font-weight:500"> #${fmt.int(p.rank20)} of ${fmt.int(p.count)}</span></span>
      <span class="k">Average stock</span><span class="v">${fmt.pct(p.base[10], 0, false)} / ${fmt.pct(p.base[20], 0, false)}</span>
    </div>
    ${p.top_n && html`<p class="faint" style="font-size:12px;margin-top:10px">It gives a chance only for its top${' '}
      ${fmt.int(p.top_n)} stocks each day (its best 10%): its test results are about those.</p>`}
    <a class="btn sm block" style="margin-top:14px" href="#/predict">How reliable is it?</a></div>`;
}

function PositionPanel({ p, hold }) {
  return html`<div class="card">
    <div class="card-title">Your position<span class="right"><${StatusChip} status=${p.status} /></span></div>
    <div class="stat-list">
      <span class="k">Shares</span><span class="v">${fmt.int(p.shares)}</span>
      <span class="k">Average price</span><span class="v">${fmt.price(p.avg_price)}</span>
      <span class="k">P&L after fees</span><span class=${cls('v', tone(p.pnl))}>${fmt.egp(p.pnl)} (${fmt.pct(p.pnl_pct)})</span>
      <span class="k">Stop now</span><span class="v down">${fmt.price(p.stop)}</span>
      <span class="k">Target</span><span class="v up">${fmt.price(p.target)}</span>
      <span class="k">First buy</span><span class="v">${fmt.date(p.first_buy)}</span>
    </div>
    <p class="muted" style="font-size:13px;margin:12px 0">${p.reason}</p>
    <${DayBar} day=${p.day} max=${hold.max} review=${hold.review} />
    <a class="btn sm block" style="margin-top:12px" href="#/portfolio">Manage in My Portfolio</a>
  </div>`;
}

function ShariahPanel({ info }) {
  return html`<div class="card"><div class="card-title"><${Icon} name="shield" size=${15} />Shariah details</div>
    <div class="stat-list">
      <span class="k">Kashif status</span><span class="v" dir="auto">${info.kashif_label || 'not listed'}</span>
      <span class="k">Purity grade</span><span class="v">${info.purity || '–'}</span>
      <span class="k">Purification</span><span class="v">${info.purification_pct || '–'}</span>
      <span class="k">Statements date</span><span class="v">${info.statements_date || '–'}</span>
      <span class="k">EGX33 member</span><span class="v">${info.egx33 ? (info.egx33_manual ? 'yes (added by you)' : 'yes') : 'no'}</span>
      <span class="k">Last checked</span><span class="v">${info.kashif_updated ? fmt.date(info.kashif_updated) : '–'}</span>
    </div>
    <a class="btn sm block" style="margin-top:14px" href=${info.kashif_url} target="_blank" rel="noopener">
      Open on kasheif.com <${Icon} name="external" size=${14} /></a></div>`;
}
