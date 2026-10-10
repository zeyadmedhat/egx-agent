// Stock: TradingView-style chart with your levels, why it does or doesn't qualify, your position, Shariah details.
import { html, useApi, useState, useEffect, fmt, tone, cls, remember, todayISO, api, toast, refreshAll, STATIC } from '../lib.js';
import {
  Icon, Badges, IndexPills, StatusChip, Kpi, Callout, PageLoading, Seg, DayBar, WatchStar,
  Cautions, NewsList, Why, LiveChart, LIVE_NOTE, Term, More, Change, StockAvatar, Fold, Rating, Reason, useQuotes, livePosition, PositionCard, sessionState,
  Bell, useBells,
} from '../ui.js';
import { t, tn } from '../i18n.js';
import { PriceChart } from '../charts.js';
import { AiForecast } from './ai.js';
import { PriceRange, ReachLine } from './range.js';

const RANGES = [
  { value: 60, label: '3M' }, { value: 120, label: '6M' }, { value: 250, label: '1Y' }, { value: 500, label: '2Y' },
  { value: 1000, label: '4Y' }, { value: 100000, label: 'All' },   // labels go through t() in Seg
];
// Bars shown for each range on the 4-hour (2 bars a session) and 1-hour (5 a session) charts.
const INTRADAY_RANGES = {
  '4h': [{ value: 44, label: '1M' }, { value: 130, label: '3M' }, { value: 260, label: '6M' }, { value: 100000, label: 'All' }],
  '1h': [{ value: 25, label: '1W' }, { value: 110, label: '1M' }, { value: 330, label: '3M' }, { value: 100000, label: 'All' }],
};
const FRAMES = [{ value: '1d', label: '1D' }, { value: '4h', label: '4H' }, { value: '1h', label: '1H' }];
const VIEWS = [{ value: 'agent', label: 'Agent chart' }, { value: 'live', label: 'Live (TradingView)' }];
const PANES = [['zones', 'Support & resistance'], ['fib', 'Fibonacci'], ['ema', 'Averages'], ['volume', 'Volume'],
  ['rsi', 'RSI'], ['macd', 'MACD']];
const PANES_ON = { zones: true, fib: false, ema: true, volume: true, rsi: true, macd: true };

export function StockPage({ route }) {
  const sym = (route.arg || remember('symbol') || 'COMI').toUpperCase();
  useEffect(() => { remember('symbol', sym); }, [sym]);
  const { data, error } = useApi(`/stock/${encodeURIComponent(sym)}`);
  const [bars, setBars] = useState(Number(remember('bars')) || 250);
  const [show, setShow] = useState(() => {
    try { return { ...PANES_ON, ...JSON.parse(remember('panes') || '{}') }; }
    catch { return { ...PANES_ON }; }
  });
  const toggle = k => setShow(s => { const n = { ...s, [k]: !s[k] }; remember('panes', JSON.stringify(n)); return n; });
  const pickRange = v => { setBars(v); remember('bars', v); };
  const [view, setView] = useState('agent');          // the agent's chart first, every time
  const [frame, setFrame] = useState(() => (FRAMES.some(f => f.value === remember('frame')) ? remember('frame') : '1d'));
  const pickFrame = v => { setFrame(v); remember('frame', v); };
  const [ibars, setIbars] = useState({ '4h': 130, '1h': 110 });
  const hourly = useApi(view === 'agent' && frame !== '1d' ? `/stock/${encodeURIComponent(sym)}/intraday` : null);

  const quotes = useQuotes(data && data.has_data ? [data.symbol] : []);
  const quote = quotes[sym];
  if (!data) return html`<${PageLoading} error=${error} />`;

  const info = data.info || {};
  const st = data.stats;
  const pe = data.fundamentals && data.fundamentals.values && data.fundamentals.values.pe;
  return html`
    <div class="card stock-head">
      <div class="who">
        <div class="sym-line"><${StockAvatar} symbol=${data.symbol} size=${40} /><span class="sym-big" style="font-size:26px">${data.symbol}</span>
          <${WatchStar} symbol=${data.symbol} label /><${StockBell} sym=${data.symbol} tg=${data.telegram} /><${IndexPills} info=${info} />
          ${data.signal && html`<${StatusChip} status=${data.signal.action} />`}
          ${data.position && html`<span class="tag"><${Icon} name="briefcase" size=${13} />${t('You hold it')}</span>`}</div>
        <div class="row" style="gap:8px"><span class="stock-name" dir="rtl">${info.name_ar || ''}</span>
          <span class="faint">·</span><span class="stock-sector">${tn(info.sector || '')}</span></div>
        <${Badges} info=${info} />
      </div>
      ${st && html`<div class="price"><div class="big">${fmt.price(st.close)}</div>
        <div class="chg"><${Change} value=${st.change} pill /> <span class="faint" style="font-weight:500">${t('on the day')}</span></div>
        <div class="faint" style="font-size:12px">${t('Close of {date}', { date: fmt.date(st.last_bar) })}</div>
        ${quote && Math.abs(quote.price - st.close) > 1e-9 && (sessionState().state === 'open'
          ? html`<div class="live-now"><span class="live-dot"></span>
              ${t('Live')} <b>${fmt.price(quote.price)}</b> <${Change} value=${quote.change} /> <span class="faint">${t('~15 min late')}</span></div>`
          : html`<div class="live-now">${t('Newest close')} <b>${fmt.price(quote.price)}</b> <${Change} value=${quote.change} /></div>`)}
        ${data.corporate && data.corporate.results && data.corporate.results.next && html`<div class="next-results">
          <${Term} k="results">${t('Next results')}<//>: <b>${t('expected around {date}', { date: fmt.date(data.corporate.results.next) })}</b></div>`}</div>`}
    </div>

    ${!data.has_data ? html`<div style="margin-top:14px"><${Callout} tone="warn"><b>${t('No price data.')}</b> ${data.message}<//></div>`
      : html`
      <${Verdict} data=${data} />
      <div class="kpis" style="margin-top:14px">
        <${Kpi} compact label="3-month change" value=${fmt.pct(st.ret63, 0)} valueClass=${tone(st.ret63)}
          sub=${st.index_ret63 != null ? `EGX30 ${fmt.pct(st.index_ret63, 0)}` : ''} />
        <${Kpi} compact label="1-year low – high" value=${`${fmt.price(st.low52)} – ${fmt.price(st.high52)}`} />
        <${Kpi} compact label="Traded a day" value=${`${fmt.short(st.value_avg20)} ${t('EGP')}`} sub="last 20 sessions" />
        ${pe != null && html`<${Kpi} compact label="Price / earnings (P/E)" value=${pe > 0 ? `${fmt.num(pe, 1)}×` : t('loss-making')}
          sub=${pe > 0 && data.fundamentals.sector_median && data.fundamentals.sector_median.pe ? `${t('sector')} ${fmt.num(data.fundamentals.sector_median.pe, 1)}×` : ''} />`}
      </div>
      <div class="stock-layout">
        <div class="stack" style="min-width:0">
        <div class="card chart-card">
          <div class="chart-toolbar">
            <${Seg} options=${VIEWS} value=${view} onChange=${setView} />
            ${view === 'agent' && html`<${Seg} options=${FRAMES} value=${frame} onChange=${pickFrame} />
            ${frame === '1d' ? html`<${Seg} options=${RANGES} value=${bars} onChange=${pickRange} />`
              : html`<${Seg} options=${INTRADAY_RANGES[frame]} value=${ibars[frame]} onChange=${v => setIbars(b => ({ ...b, [frame]: v }))} />`}
            <div class="right">${PANES.map(([k, label]) => html`<button class=${cls('toggle-chip', show[k] && 'on')}
              onClick=${() => toggle(k)}>${t(label)}</button>`)}</div>`}
          </div>
          ${view === 'agent' ? (frame === '1d'
            ? html`<${PriceChart} series=${data.series} levels=${data.levels} fills=${data.fills} bars=${bars} show=${show} chart=${data.chart} />`
            : hourly.data && hourly.data[frame]
              ? html`<${PriceChart} series=${hourly.data[frame]} levels=${data.levels} bars=${ibars[frame]} show=${show} chart=${data.chart} />`
              : html`<div class="chart-box chart-wait">${hourly.data || hourly.error
                ? html`<p class="faint">${t('No hourly prices for this stock yet. They download with each scan.')}</p>`
                : html`<p class="faint">${t('Loading…')}</p>`}</div>`)
            : html`<${LiveChart} symbol=${data.symbol} />
              <p class="faint chart-note">${t(LIVE_NOTE)} ${t('Your buy, stop and target lines are on the Agent chart.')}</p>`}
        </div>
        ${data.range && html`<${PriceRange} r=${data.range} sym=${data.symbol} series=${data.series} plan=${rangePlan(data)} ai=${data.ai}
          results=${data.corporate && data.corporate.results && data.corporate.results.next} cautions=${data.cautions} />`}
        ${data.ai && html`<${AiForecast} ai=${data.ai} sym=${data.symbol} rg=${data.range} pred=${data.prediction} />`}
        ${data.news && html`<div class="card stock-news"><div class="card-title"><${Icon} name="news" size=${15} />${t('News')}
            <span class="right faint">Mubasher, Reuters, Zawya</span></div>
          <${NewsList} items=${data.news} sources=${SOURCES} limit=${5}
            empty="No headlines for this stock yet. The agent reads a few stocks' news pages each run, so it can take a couple of days to reach every stock." />
          <${More} label="About these headlines"><p>${t('Headlines link to the publisher. The green/red dot is a rough guess from keywords, not a reading of the article.')}</p><//></div>`}
        </div>
        <aside class="stack">
          ${data.cautions && data.cautions.length > 0 && html`<div class="card"><div class="card-title">
            <${Icon} name="alert" size=${15} />${t('Good to know now')}</div><${Cautions} items=${data.cautions} /></div>`}
          ${data.position && html`<${PositionPanel} p=${data.position} hold=${data.hold} c=${data.chart} atr=${st.atr_pct * st.close} quotes=${quotes} rg=${data.range} />`}
          ${data.signal && html`<${SignalPanel} data=${data} />`}
          <${EntryCard} data=${data} />
          ${data.chart && html`<${LevelsPanel} c=${data.chart} pos=${data.position} atr=${st.atr_pct * st.close} sym=${data.symbol} tg=${data.telegram} rg=${data.range} />`}
          <a class="btn block" href=${`#/calc/${encodeURIComponent(data.symbol)}`}><${Icon} name="coins" />${t('Size a buy with your rules')}</a>
          ${!data.signal && !data.position && (data.checklist || []).length > 0 && html`<${Checklist} list=${data.checklist} />`}
          ${data.fundamentals && html`<${CompanyPanel} f=${data.fundamentals} />`}
          ${data.corporate && html`<${CorporatePanel} c=${data.corporate} />`}
          <${ShariahPanel} info=${info} />
        </aside>
      </div>`}`;
}

// The stop and target drawn on "How far it could move": your position's (unless it waits for a re-base), else the BUY
// signal's, else the chart's plan from support and resistance.
function rangePlan(data) {
  const p = data.position, s = data.signal, c = data.chart;
  if (p && p.status !== 'ADJUST') return { stop: p.stop, target: p.target, mine: true };
  if (s && s.action === 'BUY') return { stop: s.stop, target: s.target };
  return c ? { stop: c.stop, target: c.target } : null;
}

// The page in one line: Buy / Hold / Sell / Wait / Avoid, from the signal, the checklist, your position, the model
// and the chart levels. A summary of the cards below, not a new rule.
export function verdictFor(data) {
  const st = data.stats || {}, ch = data.chart, pr = data.prediction, pos = data.position, sig = data.signal;
  const close = st.close;
  const notes = [];
  const modelNote = () => {
    if (!pr) return;
    // half or less of its 3-month high: after crashes like that its top ratings did worse than the rest (2026-10)
    const closes = ((data.series && data.series.close) || []).slice(-60).filter(v => v != null);
    const crashed = closes.length > 0 && close <= Math.max(...closes) * 0.5;
    if (pr.top10 && crashed) notes.push(t("The model ranks it in its top 10% (#{rank} of {n}), but it is at half its 3-month high or less: after crashes like that, its top-rated stocks usually kept falling in the tests.", { rank: fmt.int(pr.rank10), n: fmt.int(pr.count) }));
    else if (pr.top10) notes.push(t('The model ranks it in its top 10% (#{rank} of {n}).', { rank: fmt.int(pr.rank10), n: fmt.int(pr.count) }));
    else if (pr.rank10 && pr.count && pr.rank10 > pr.count / 2) notes.push(t('The model ranks it in its bottom half (#{rank} of {n}).', { rank: fmt.int(pr.rank10), n: fmt.int(pr.count) }));
  };
  if (pos) {
    if (pos.status === 'EXIT') return { kind: 'sell', label: 'Sell', line: tn(pos.reason), notes };
    if (pos.status === 'BOUNCE') return { kind: 'sell', label: 'Sell on a bounce', line: tn(pos.reason), notes };
    const line = t('{a} above your stop ({stop}), {b} to your target ({target}).', {
      a: fmt.pct(close / pos.stop - 1, 1, false), stop: fmt.price(pos.stop),
      b: fmt.pct(pos.target / close - 1, 1, false), target: fmt.price(pos.target) });
    if (pos.status && pos.status !== 'HOLD') notes.push(tn(pos.reason));
    modelNote();
    return { kind: 'hold', label: 'Hold', line, notes };
  }
  if (sig && sig.action === 'BUY') {
    modelNote();
    if (ch && ch.hurdle) notes.push(t('Resistance at {price} comes before the target.', { price: fmt.price(ch.hurdle.price) }));
    return { kind: 'buy', label: 'Buy', notes, line: t('A BUY signal{setup}: buy up to {price}, stop {stop}, target {target}.', {
      setup: sig.setup ? ` (${t(sig.setup)})` : '', price: fmt.price(sig.entry_high), stop: fmt.price(sig.stop), target: fmt.price(sig.target) }) };
  }
  const list = data.checklist || [];
  if (list.length && !list[0].ok) {
    return { kind: 'avoid', label: 'Avoid', notes, line: t('Too thinly traded or its price history is unreliable, so the agent never buys it.') };
  }
  if (!sig && list.length > 1 && !list[1].ok) {
    modelNote();
    return { kind: 'avoid', label: 'Avoid for now', notes, line: t('Not in an uptrend: the price is under its 20- or 50-day average.') };
  }
  const missing = list.filter(c => !c.ok).length;
  let line = sig ? t('A strong uptrend, but no entry trigger yet.')
    : t('An uptrend, but {n} of the entry checks are not met yet.', { n: missing });
  const sup = ch && (ch.supports || [])[0];
  if (sup && close) {
    const gap = 1 - sup.price / close;
    if (gap > 0.05) notes.push(t('The price is {gap} above the nearest support; a better entry is near {price}.', { gap: fmt.pct(gap, 1, false), price: fmt.price(sup.price) }));
    else notes.push(t('The price is close to support at {price}.', { price: fmt.price(sup.price) }));
  }
  if (ch && ch.rr < 1.5) notes.push(t('Reward/risk is only {rr}× from here.', { rr: fmt.num(ch.rr, 1) }));
  modelNote();
  return { kind: 'wait', label: 'Wait', line, notes };
}

const VERDICT_ICON = { buy: 'checkCircle', hold: 'briefcase', sell: 'sell', wait: 'history', avoid: 'xCircle' };

// The page in one card: what to do (verdictFor) and the model's rating with its reason in one line.
function Verdict({ data }) {
  const v = verdictFor(data);
  const p = data.prediction;
  const b = p && p.rating != null && (p.bands || []).find(x => p.rating >= x.from && p.rating <= x.to);
  return html`<div class=${cls('card verdict', v.kind)}>
    <div class="verdict-head"><span class="verdict-chip"><${Icon} name=${VERDICT_ICON[v.kind]} size=${15} />${t(v.label)}</span>
      <span class="verdict-line">${v.line}</span></div>
    ${v.notes.length > 0 && html`<ul class="verdict-notes">${v.notes.map(n => html`<li>${n}</li>`)}</ul>`}
    <div class="verdict-rating">
      <${Rating} v=${p ? p.rating : null} />
      ${p && p.rating != null
        ? html`<div><b>${t('Rating {v}/100', { v: p.rating })}</b>${b && b.hit != null ? html`<span class="faint"> · ${t('stocks rated like it reached the target first {hit} of the time (the average stock {base})', {
            hit: fmt.pct(b.hit, 0, false), base: fmt.pct(p.base && p.base[10], 0, false) })}</span>` : ''}
            ${p.why10 && p.why10.length > 0 && html`<div style="margin-top:4px"><${Reason} items=${p.why10} /></div>`}</div>`
        : html`<span class="muted">${t('No rating: the model rates only stocks with enough daily trading.')}</span>`}
    </div>
    <p class="faint verdict-foot">${t('A summary of the cards below, not advice.')}</p>
  </div>`;
}

function StockBell({ sym, tg }) {
  const [bells, setBells] = useBells(tg);
  return html`<${Bell} sym=${sym} tg=${tg} bells=${bells} setBells=${setBells} />`;
}

// Where to buy it: now (only with a BUY signal), on a dip to support or on a breakout, each with the chart's own stop
// and target at that price (levels.entries). The best is the BUY when there is one, else the most reward for the risk.
const ENTRY = {
  now: ['Now: at the next session', 'Up to {price}. Skip it if it opens higher.'],
  today: ["At today's price", "For comparison: there's no BUY signal, so the rules wouldn't buy here."],
  dip: ['On a dip to support', 'If it falls to about {price} ({away}) and holds there.'],
  breakout: ['On a breakout', 'On a close above {price} ({away}) with more trading than usual: the BUY rule\'s trigger.'],
};

function EntryCard({ data }) {
  const sig = data.signal, ch = data.chart, close = data.stats.close;
  const rows = [];
  if (sig && sig.action === 'BUY') rows.push({ kind: 'now', price: sig.entry_high, stop: sig.stop, target: sig.target });
  else if (ch) rows.push({ kind: 'today', price: close, stop: ch.stop, target: ch.target });
  rows.push(...(data.entries || []).map(e => ({ ...e })));
  if (rows.length < 2 && rows[0] && rows[0].kind === 'today') return null;
  for (const r of rows) r.rr = (r.target - r.price) / (r.price - r.stop);
  const best = rows[0].kind === 'now' ? rows[0]
    : rows.filter(r => r.kind !== 'today').reduce((b, r) => (!b || r.rr > b.rr ? r : b), null);
  const uptrend = (sig && sig.action === 'BUY') || !(data.checklist && data.checklist[1] && !data.checklist[1].ok);
  const how = { now: 'now', dip: 'on a dip', breakout: 'on a breakout' }[best && best.kind];
  return html`<${Fold} title="Where to buy it"
    hint=${best ? t('Best: {how} at {price}, {rr}× reward for the risk', { how: t(how), price: fmt.price(best.price), rr: fmt.num(best.rr, 1) }) : ''}>
    ${!uptrend && html`<p class="entry-note">${t("Not in an uptrend now, and the rules buy only in one (price above its 20- and 50-day averages). Until then these are prices to watch, not buys.")}</p>`}
    ${rows.map(r => html`<div class=${cls('entry-row', r === best && 'best', r.kind === 'today' && 'ref')}>
      <span class="entry-name">${t(ENTRY[r.kind][0])}${r === best && html`<span class="best-chip">${t('Best')}</span>`}</span>
      <span class="entry-price">${fmt.price(r.price)}</span>
      ${r.kind !== 'today' && html`<span class="entry-detail">${t(ENTRY[r.kind][1], { price: fmt.price(r.price), away: fmt.pct(r.away, 1) })}
        ${r.kind === 'dip' && r.why && r.why.length ? html` ${t('Support:')} ${sources(r.why)}.` : ''}</span>`}
      ${r.kind === 'today' && html`<span class="entry-detail">${t(ENTRY.today[1])}</span>`}
      <span class="entry-nums"><span class="down">${t('stop')} ${fmt.price(r.stop)}</span><span class="up">${t('target')} ${fmt.price(r.target)}</span>
        <span>${t('{rr}× reward for the risk', { rr: fmt.num(r.rr, 1) })}</span></span>
    </div>`)}
    <p class="faint entry-foot">${t('Stops and targets from the chart\'s support and resistance at each price. Prices to watch, not advice.')}</p>
  <//>`;
}

function Checklist({ list }) {
  const passed = list.filter(c => c.ok).length;
  return html`<${Fold} title="Why it isn't a BUY yet" hint=${t('{k} of {n} checks met', { k: passed, n: list.length })}>
    <ul class="checklist" dir="ltr">${list.map(c => html`<li>
      <span class=${c.ok ? 'ok' : 'no'}><${Icon} name=${c.ok ? 'checkCircle' : 'xCircle'} /></span><span>${c.text}</span></li>`)}</ul><//>`;
}

function SignalPanel({ data }) {
  const s = data.signal;
  const buy = s.action === 'BUY';
  // a BUY opens with its prices and the Log button; NEAR A BUY folds to one line, its reasons a tap away
  return html`<${Fold} open=${buy}
    title=${html`<span class="sig-title"><${StatusChip} status=${s.action} /> ${t('Score')} ${fmt.num(s.score, 0)}${s.setup ? ` · ${t(s.setup)}` : ''}</span>`}
    hint=${buy ? '' : t('In a strong uptrend but no entry trigger yet.')}>
    ${buy && html`<div class="stat-list" style="margin-bottom:14px">
      <span class="k"><${Term} k="buyupto">${t('Buy up to')}<//></span><span class="v">${fmt.price(s.entry_high)}</span>
      <span class="k"><${Term} k="stop">${t('Stop-loss')}<//></span><span class="v down">${fmt.price(s.stop)}</span>
      <span class="k"><${Term} k="target">${t('Target')}<//></span><span class="v up">${fmt.price(s.target)}</span>
      <span class="k">${t('Shares')}</span><span class="v">${s.shares ? fmt.int(s.shares) : '–'}</span>
      <span class="k">${t('Max loss')}</span><span class="v">${fmt.egp(s.risk_egp)}</span></div>`}
    <ul class="reasons" dir="auto">${(s.reasons || []).map(r => html`<li class=${/^Caution/.test(r) ? 'caution' : ''}>${tn(r)}</li>`)}</ul>
    ${buy && html`<a class="btn primary block" style="margin-top:14px"
      href=${`#/portfolio?buy=${encodeURIComponent(data.symbol)}&price=${s.entry_high.toFixed(2)}&shares=${s.shares || ''}`}>
      <${Icon} name="plus" />${t('Log this buy')}</a>`}
  <//>`;
}

// Where a level comes from: "swing low 2026-03-16" → "Swing low (16 Mar 2026)", each in the chosen language.
function source(what) {
  const m = /^(.*?) (\d{4}-\d{2}-\d{2})$/.exec(what);
  const name = m ? m[1] : what;
  const label = t(name.charAt(0).toUpperCase() + name.slice(1));
  return m ? `${label} (${fmt.date(m[2])})` : label;
}
const sources = list => (list || []).map(source).join(' · ');

// The chart zone your stop or target sits at. levels.py puts a stop 0.3× the daily range under a support's low and a
// target 0.1× under a resistance's low; the range has moved since they were set, so the match is a little loose.
// A stop you set on a support is inside its zone; otherwise it's the nearest zone above the stop.
const stopZone = (p, c, atr) => {
  const zs = (c && c.supports) || [];
  return zs.find(z => p.stop >= z.low - 1e-3 && p.stop <= z.high + 1e-3)
    || zs.filter(z => z.low > p.stop && z.low - p.stop <= 0.6 * atr).sort((a, b) => a.low - b.low)[0] || null;
};
const targetZone = (p, c, atr) => ((c && c.resistances) || []).find(z => Math.abs(z.low - 0.1 * atr - p.target) <= 0.3 * atr) || null;
function nextTarget(p, c, atr) {
  const z = ((c && c.resistances) || []).find(r => r.low - 0.1 * atr > p.target * 1.02);
  return z ? z.low - 0.1 * atr : null;
}

function stopWhy(p, c, atr) {
  const z = stopZone(p, c, atr);
  if (p.my_stop && Math.abs(p.stop - p.my_stop) < 1e-6) {
    return z ? `${t('the stop you set, at support:')} ${sources(z.sources)}` : t('the stop you set');
  }
  if (z) return `${t('just under support:')} ${sources(z.sources)}`;
  if (p.stop >= p.avg_price * 0.9995) return t('raised as the price rose: it now protects at least your buy price');
  if (p.stop_src === 'yours') return t('the stop you entered');
  if (p.stop_src === 'formula') return t('no support in reach when you bought, so 2× the daily range under your price');
  if (p.stop_src === 'chart') return t('just under a support on the chart the day you bought');
  return '';
}

function targetWhy(p, c, atr) {
  const z = targetZone(p, c, atr);
  if (z) return `${t('just under resistance:')} ${sources(z.sources)}`;
  if (p.target_src === 'formula') return t('no resistance within reach when you bought, so 2× the risk');
  if (p.target_src === 'chart') return t('just under a resistance on the chart the day you bought');
  return '';
}

// "Stop" / "Target" beside the zone each one sits under: the plan's, or your position's when you hold it.
function tagFor(z, down, c, pos, atr) {
  if (pos) {
    if (down && z === stopZone(pos, c, atr)) {
      return html` <span class="tag down">${pos.stop < z.low - 1e-3
        ? t('Your stop ({price}) just under', { price: fmt.price(pos.stop) }) : t('Your stop')}</span>`;
    }
    if (!down && z === targetZone(pos, c, atr)) return html` <span class="tag up">${t('Your target')}</span>`;
    return '';
  }
  const same = (a, b) => (a || []).slice(0, 3).join('|') === (b || []).slice(0, 3).join('|');
  if (down && c.stop_why.length && same(z.sources, c.stop_why)) return html` <span class="tag down">${t('Stop')}</span>`;
  if (!down && c.target_why.length && same(z.sources, c.target_why)) return html` <span class="tag up">${t('Target')}</span>`;
  return '';
}

// Your own stop right on a support (local/api.js setStop).
async function stopAt(pos, price) {
  try {
    toast((await api(`/portfolio/${pos.id}/stop`, { method: 'POST', body: { stop: +price.toFixed(3) } })).message);
    refreshAll();
  } catch (err) {
    toast(err.message, 'error', 9000);
  }
}

function ZoneList({ c, pos, atr }) {
  // a support between your stop and the price can become your stop
  const canStop = z => STATIC && pos && pos.id && pos.stop != null && z.price > pos.stop + 1e-6 && z.price < c.close;
  const zone = (z, down) => html`<div class=${cls('zone', down ? 'down' : 'up')}><span class="p">${fmt.price(z.price)}
      <small><span dir="ltr">${fmt.pct(z.price / c.close - 1, 1)}</span></small></span>
    <span class="s" title=${t('Strength')}>${'●'.repeat(Math.min(5, Math.round(z.strength / 1.5)) || 1)}</span>
    <span class="w">${sources(z.sources)}${tagFor(z, down, c, pos, atr)}${down && canStop(z) && html`
      <button type="button" class="btn sm ghost zone-stop" onClick=${() => stopAt(pos, z.price)}>${t('Stop here')}</button>`}</span></div>`;
  return html`<div class="zone-list">
      ${(c.resistances || []).slice().reverse().map(z => zone(z, false))}
      <div class="zone now"><span class="p">${fmt.price(c.close)}</span><span>${t('Last close')}</span></div>
      ${(c.supports || []).map(z => zone(z, true))}</div>
    <p class="faint" style="font-size:12px;margin-top:8px">${t('More dots: more tools agree on the level.')}</p>`;
}

// Stop-loss and target from the chart's support and resistance (egx_agent/levels.py), for every stock. When you hold
// it, your position's stop and target are the only ones shown (Your position), and this card lists the levels.
function LevelsPanel({ c, pos, atr, sym, tg, rg }) {
  const hint = tg && tg.bot && html`<p class="faint tg-hint"><${Icon} name="bell" size=${13} />${' '}
    ${t('A Telegram message when it nears support or reaches resistance: send {cmd} to @{bot}.', { cmd: `/watch ${sym} levels`, bot: tg.bot })}</p>`;
  if (pos) {
    return html`<${Fold} title="Support & resistance levels" hint=${t('from the chart')}>
      <${ZoneList} c=${c} pos=${pos} atr=${atr} />
      <${More} label="How these are worked out"><p>${t(LEVELS_HOW)}</p><//>${hint}<//>`;
  }
  return html`<div class="card levels-card">
    <div class="card-title"><${Icon} name="target" size=${15} />${t('Stop-loss & target')}
      <span class="right faint">${t('from the chart')}</span></div>
    <div class="stat-list">
      <span class="k"><${Term} k="stop">${t('Stop-loss')}<//></span>
      <span class="v down">${fmt.price(c.stop)} <span class="faint" style="font-weight:500">${fmt.pct(-c.stop_pct, 1)}</span></span>
      <span class="k"><${Term} k="target">${t('Target')}<//></span>
      <span class="v up">${fmt.price(c.target)} <span class="faint" style="font-weight:500">${fmt.pct(c.target_pct, 1)}</span></span>
      ${c.target2 && html`<span class="k">${t('Next target')}</span>
        <span class="v up">${fmt.price(c.target2)} <span class="faint" style="font-weight:500">${fmt.pct(c.target2 / c.close - 1, 1)}</span></span>`}
      <span class="k"><${Term} k="rr">${t('Reward / risk')}<//></span><span class="v">${fmt.num(c.rr, 1)}×</span>
    </div>
    <${ReachLine} r=${rg} stop=${c.stop} target=${c.target} />
    <ul class="level-why">
      ${c.stop_why.length > 0 && html`<li><b class="down">${t('Stop')}</b> ${t('just under support:')} ${sources(c.stop_why)}</li>`}
      ${c.method === 'atr' && html`<li><b class="down">${t('Stop')}</b> ${t('no support in range, so 2× the daily range')}</li>`}
      ${c.target_why.length > 0 && html`<li><b class="up">${t('Target')}</b> ${t('just under resistance:')} ${sources(c.target_why)}</li>`}
      ${!c.target_why.length && html`<li><b class="up">${t('Target')}</b> ${t('no resistance within reach, so {r}× the risk', { r: fmt.num(c.rr, 1) })}</li>`}
      ${c.hurdle && html`<li class="caution">${t('Resistance at {price} comes first: {what}', { price: fmt.price(c.hurdle.price), what: sources(c.hurdle.sources) })}</li>`}
    </ul>
    <p class="faint" style="font-size:12px;margin-top:10px">${t('For a buy at the last close ({price}). The agent logs these with your buy.', { price: fmt.price(c.close) })}</p>
    <${More} label="Support & resistance levels"><${ZoneList} c=${c} atr=${atr} /><//>
    <${More} label="How these are worked out"><p>${t(LEVELS_HOW)}</p><//>${hint}
  </div>`;
}

const LEVELS_HOW = 'The agent marks prices where buyers or sellers stepped in before: swing lows and highs of the last year, '
  + 'Fibonacci retracements (23.6–78.6%) and extensions (127.2%, 161.8%) of the latest big rise, the 20- and 50-day '
  + 'averages, monthly pivot points, the price where the most shares traded in 6 months, and the 1-year high. Levels '
  + 'that sit together make one zone; the more tools agree, the stronger it is. The stop goes a little under the '
  + 'nearest solid support (at least one normal daily move away, at most the widest stop in Settings); the target a '
  + 'little under the first resistance that pays at least 1.5× the risk. It is a plan, not a promise.';

const SOURCES = { mubasher: 'Mubasher', reuters: 'Reuters', zawya: 'Zawya', 'dow-jones': 'Dow Jones', lse: 'LSE filings',
  alborsa: 'Al Borsa News', dne: 'Daily News Egypt' };

// Cash dividends (TradingView: the latest and the next announced; kept as they're seen), bonus shares/splits, and
// Mubasher's list of the company's corporate actions (announced → ex-date) from the exchange's filings.
function CorporatePanel({ c }) {
  const cash = c.dividends || [];
  const bonus = c.bonus || [];
  const acts = c.actions || [];
  const r = c.results;
  return html`<${Fold} title="Dividends, bonus shares & results"
      hint=${c.yield != null ? t('Yield {pct} a year', { pct: fmt.pct(c.yield, 1, false) }) : ''}>
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
    <${More} label="How to read these dates"><p>${t("Dates are ex-dates: buy before that day to get the dividend. Amounts per share, % of today's price, from TradingView. The announcements come from Mubasher's list of the exchange's filings. The next results date is TradingView's estimate from when the company reported before.")}</p><//><//>`;
}

// The company's numbers from TradingView (data/dividends.py FUNDAMENTALS), next to the middle of its sector.
const COMPANY = [
  ['market_cap', 'Market value', v => `${fmt.short(v)} ${t('EGP')}`],
  ['pe', 'Price / earnings (P/E)', v => (v > 0 ? `${fmt.num(v, 1)}×` : t('loss-making'))],
  ['pb', 'Price / book', v => `${fmt.num(v, 1)}×`],
  ['eps_growth', 'Profit growth (1 year)', v => fmt.pct(v, 0)],
  ['revenue_growth', 'Sales growth (1 year)', v => fmt.pct(v, 0)],
  ['net_margin', 'Net margin', v => fmt.pct(v, 0, false)],
  ['roe', 'Return on equity', v => fmt.pct(v, 0, false)],
  ['debt_equity', 'Debt / equity', v => `${fmt.num(v, 2)}×`],
];
const GROWTH = new Set(['eps_growth', 'revenue_growth']);

function CompanyPanel({ f }) {
  const v = f.values, med = f.sector_median || {};
  const rows = COMPANY.filter(([k]) => v[k] != null);
  return html`<${Fold} title="Company numbers"
      hint=${v.pe > 0 ? t('P/E {pe}', { pe: fmt.num(v.pe, 1) }) : v.market_cap ? t('Worth {v}', { v: `${fmt.short(v.market_cap)} ${t('EGP')}` }) : ''}>
    <div class="stat-list">${rows.map(([k, label, show]) => html`
      <span class="k">${t(label)}</span>
      <span class=${cls('v', GROWTH.has(k) && tone(v[k]))}>${show(v[k])}${k !== 'market_cap' && med[k] != null
        ? html`<span class="faint" style="font-weight:500"> · ${t('sector')} ${show(med[k])}</span>` : ''}</span>`)}
    </div>
    ${rows.length < COMPANY.length && html`<p class="faint" style="font-size:12px;margin-top:8px">${t('TradingView has no figure for the rest.')}</p>`}
    <${More} label="What these mean"><p>${t(COMPANY_HOW)}</p><//>
    <p class="faint" style="font-size:11.5px;margin-top:8px">${t('From TradingView, the latest yearly figures, checked {date}. Sector: the middle of {n} companies in {sector}.', {
      date: fmt.date((f.updated || '').slice(0, 10)), n: fmt.int(f.peers), sector: t(f.sector || 'Other') })}</p><//>`;
}

const COMPANY_HOW = 'P/E: the price divided by a year of profit per share; lower is cheaper, but a growing company usually '
  + 'costs more. Price / book: the price against what the company owns minus what it owes. Growth: the last 12 months '
  + 'against the 12 before (in EGP, so inflation lifts it too). Net margin: profit from each pound of sales. Return on '
  + 'equity: yearly profit on the owners\' money. Debt / equity: borrowing against the owners\' money; over 1 is a lot for '
  + 'most companies except banks. The agent\'s signals don\'t use these: they are here to know the company.';

// Your position: the same card as Today and My Portfolio (live price, P&L, stop to target), and where the stop and
// target come from. The stop rises to each new support under the price (egx_agent/engine.py); the target stays.
function PositionPanel({ p, hold, c, atr, quotes, rg }) {
  const next = p.stop != null && c ? nextTarget(p, c, atr) : null;
  const sw = p.stop != null ? stopWhy(p, c, atr) : '';
  const tw = targetWhy(p, c, atr);
  return html`<${PositionCard} p=${livePosition(p, quotes)} hold=${hold}>
    ${p.status !== 'ADJUST' && html`<${ReachLine} r=${rg} stop=${p.stop} target=${p.target} />`}
    ${(sw || tw || next) && html`<${More} label="Where the stop and target come from"><ul class="level-why">
      ${sw && html`<li><b class="down">${t('Stop')}</b> ${sw}</li>`}
      ${tw && html`<li><b class="up">${t('Target')}</b> ${tw}</li>`}
      ${next && html`<li><b class="up">${t('Next target')}</b> ${fmt.price(next)}: ${t('the next resistance above your target, if the price gets through it')}</li>`}
    </ul>
    <p class="faint" style="font-size:12px;margin-top:8px">${p.stops_mine
      ? t('The stop stays where it is until you change it (Settings → Your stops). The target stays where it was set.')
      : t('Each evening the stop rises to just under the newest support below the price, and never goes down. The target stays where it was set.')}</p><//>`}
    <a class="btn sm block" href=${`#/portfolio?open=${p.id}`}>${t('Sell or edit in My Portfolio')}</a>
  <//>`;
}

function ShariahPanel({ info }) {
  return html`<${Fold} title="Shariah details" hint=${info.kashif_label || ''}>
    <div class="stat-list">
      <span class="k">${t('Kashif status')}</span><span class="v" dir="auto">${info.kashif_label || 'not listed'}</span>
      <span class="k">${t('Purity grade')}</span><span class="v">${info.purity || '–'}</span>
      <span class="k">${t('Purification')}</span><span class="v">${info.purification_pct || '–'}</span>
      <span class="k">${t('Statements date')}</span><span class="v">${info.statements_date || '–'}</span>
      <span class="k">${t('EGX33 member')}</span><span class="v">${info.egx33 ? (info.egx33_manual ? 'yes (added by you)' : 'yes') : 'no'}</span>
      <span class="k">${t('Last checked')}</span><span class="v">${info.kashif_updated ? fmt.date(info.kashif_updated) : '–'}</span>
    </div>
    <a class="btn sm block" style="margin-top:14px" href=${info.kashif_url} target="_blank" rel="noopener">
      ${t('Open on kasheif.com')} <${Icon} name="external" size=${14} /></a><//>`;
}
