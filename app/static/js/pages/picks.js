// Picks: what to buy at the next session and what may come next, from the BUY rules and the prediction model side by
// side. The Picks tab answers, in order: can I buy now (the market light), what (the BUY cards), what's coming (close
// to a BUY, the model's week) and can I trust it now. Track record: how the published BUYs and the model did live.
import { html, useApi, useState, fmt, tone, stockHref, cls, go } from '../lib.js';
import {
  Icon, Badges, IndexPills, Empty, Callout, PageHead, SectionHead, StockAvatar, Cautions, Term, DataTable,
  SessionBadge, More, ShariahNote, Rating, Reason, Why, Chance, useQuotes, sessionState, PlanBar, Bell, useBells,
} from '../ui.js';
import { t, tp, tn } from '../i18n.js';
import { useToday, buyHref } from './today.js';
import { Health, Recent, RankMove } from './predict.js';

const WK = 5;           // the model's week (predict.WEEK)

export function PicksPage() {
  const { page, data, blocked } = useToday('Picks');
  const { data: pred } = useApi('/predict');
  if (page) return page;
  const m = data.market;
  const model = pred && pred.model ? pred : null;
  const week = Object.fromEntries(((model && model.rows) || []).map(r => [r.symbol, r]));
  return html`
    <${PageHead} title="Picks" sub=${t('For the next session, from the {date} close', { date: fmt.date(m.date) })}>
      <${SessionBadge} dataDate=${m.date} /><//>
    <${Light} m=${m} b=${data.breadth} blocked=${blocked} />
    ${m.warnings && m.warnings.length > 0 && html`<div class="stack" style="margin-top:12px">
      ${m.warnings.map(w => html`<${Callout} tone="warn">${tn(w)}<//>`)}</div>`}
    <section class="section">
      <${SectionHead} title="Buy at the next session" count=${data.buys.length}
        hint=${data.buys.length ? "Don't pay more than Buy up to. If it opens higher, skip it." : ''} />
      ${data.buys.length
        ? html`<div class="signal-grid">${data.buys.map(s => html`<${PickCard} s=${s} m=${m} wk=${week[s.symbol]}
            odds=${data.odds} fee=${data.cfg.fee_pct_per_side} model=${data.model} key=${s.symbol} />`)}</div>`
        : html`<div class="card"><${Empty} icon="shield" title="No BUY signals for the next session" text=${blocked
          ? 'No new BUYs while EGX30 is below its 50-day average. Sitting in cash is a valid decision. Below: what is close to a BUY once the market recovers.'
          : 'No stock met all the entry rules at the last close. Sitting in cash is a valid decision. Below: what is close to a BUY.'} /></div>`}
    </section>
    <section class="section">
      <${SectionHead} title=${html`<${Term} k="watchlist">${t('Getting close')}<//>`} count=${data.watch.length}
        hint="Strong uptrends waiting to break out. A close above the breakout price can make them a BUY.">
        <${ShariahNote} mode=${data.cfg.shariah_filter} /><//>
      <${NearBoxes} rows=${data.watch} rated=${!!data.model} tg=${data.telegram} />
    </section>
    ${model && model.week && html`<section class="section"><${WeekPicks} p=${model} /></section>`}
    <section class="section"><${Trust} rec=${data.record} p=${model} /></section>
    <p class="faint note" style="margin-top:14px">${t('Tested rules and chances, not advice. Always use the stop.')}</p>`;
}

// ------------------------------------------------------------------ can I buy now?
// The rules' EGX30 check (no new BUYs, or only the strongest, while EGX30 is under its 50-day average) and the market
// switch for the model's picks (how many stocks are in an uptrend), as one light.
function Light({ m, b, blocked }) {
  const sw = b && b.switch;
  const gap = m.egx30_close / m.egx30_ema50 - 1;
  const [lt, head, text] = blocked
    ? ['bad', 'No new BUYs', t('EGX30 is below its 50-day average, so the agent makes no new BUY calls until it recovers. Focus on managing your open positions.')]
    : m.risk_off
      ? ['warn', 'Only the strongest BUYs', t('Weak market: only very strong signals (score ≥ {n}) and at most half the usual number of positions.', { n: fmt.int(m.buy_threshold) })]
      : sw && sw.state === 'half'
        ? ['warn', "BUYs allowed, the model's picks at half size", `${t(sw.text)} ${t("Buy the model's top picks at half your usual size.")}`]
        : sw && sw.state === 'off'
          ? ['warn', "The rules' BUYs only", `${t(sw.text)} ${t("Don't buy the model's picks until more stocks are back above their average.")}`]
          : ['ok', 'BUYs allowed', t('EGX30 is above its 50-day average, so new BUY signals are allowed.')];
  return html`<div class=${cls('card light', lt)}>
    <div class="light-head"><span class="light-dot"></span><b>${t(head)}</b></div>
    <p class="light-text">${text}</p>
    <div class="light-nums">
      <a href="#/egx30">EGX30 <b class=${tone(gap)}>${fmt.pct(gap, 1)}</b> ${t('vs its 50-day average')}</a>
      ${b && html`<a href="#/market">${t('Stocks in uptrend')} <b class=${b.above50 >= 0.5 ? 'up' : b.above50 < 0.4 ? 'down' : 'warn'}>${fmt.pct(b.above50, 0, false)}</b></a>`}
      ${sw && html`<a href="#/market">${t('Model picks: {label}', { label: t(sw.label) })}</a>`}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ the BUY cards
// What the rules' BUYs with a score like this one did in the 10-year test (egx_agent/record.py). Not for the model's
// picks: its own test is on the Rankings tab.
function Odds({ s, odds }) {
  if (!odds || s.source === 'model') return null;
  const b = (odds.bands || []).find(x => s.score >= x.from && s.score < (x.to === 100 ? 101 : x.to));
  if (!b || !b.n) return null;
  return html`<p class="odds-line">${t('In {years} of tests, BUYs scored {from}–{to} won {win} of the time, {avg} a trade on average after fees ({n} trades).', {
    years: t('10 years'), from: b.from, to: b.to, win: fmt.pct(b.win_rate, 0, false), avg: fmt.pct(b.avg, 1), n: fmt.int(b.n) })}</p>`;
}

// Two opinions: the rules (BUY and their score, or none for a model pick) and the model (its rating, and next week's
// chance when it gives one).
function Opinions({ s, wk }) {
  const p = s.pred;
  return html`<div class="opinions">
    <div class="opinion"><div class="k">${t('The rules')}</div>
      ${s.source === 'model'
        ? html`<div class="v"><span class="faint">${t('No BUY of their own')}</span></div>`
        : html`<div class="v"><b class="up">${t('BUY')}</b></div><div class="s">${t('score {n}', { n: fmt.int(s.score) })}</div>`}</div>
    <div class="opinion"><div class="k">${t('The model')}</div>
      <div class="v">${p && p.rating != null ? html`<${Rating} v=${p.rating} /> <span class="faint">/100</span>` : html`<span class="faint">${t('No rating')}</span>`}</div>
      ${wk && wk[`p${WK}`] != null && html`<div class="s" title=${t('Chance it rises 1.5× its daily range before it falls as far, within 5 sessions')}>${
        t('next week {pct}', { pct: fmt.pct(wk[`p${WK}`], 0, false) })}</div>`}</div>
  </div>`;
}

// Why it is a BUY at a glance: a tick, a warning or a cross for each check. From the signal's own data.
const COMING = { results: 'Results', ex_dividend: 'Ex-dividend', bonus: 'Bonus shares', split: 'Split', rights: 'Rights issue', bad_news: 'Bad news?' };
function checks(s, m) {
  const r = s.pred && s.pred.rating, co = s.co, ev = (s.cautions || [])[0];
  const warns = (s.reasons || []).filter(x => /^Caution/.test(x)).length;
  return [
    ['ok', s.source === 'model' ? t('Model pick') : t(s.setup || 'Breakout')],
    m.risk_off ? ['warn', t('Weak market')] : ['ok', t('Market OK')],
    r == null ? ['none', t('No rating')] : [r >= 71 ? 'ok' : r >= 51 ? 'warn' : 'bad', t('Rating {v}/100', { v: r })],
    !co || (co.growth == null && !(co.margin < 0)) ? ['none', t('No results yet')]
      : co.margin < 0 ? ['bad', t('Lost money')]
        : [co.growth >= 0 ? 'ok' : 'bad', t('Profit {pct} in a year', { pct: fmt.pct(co.growth, 0) })],
    warns ? ['warn', warns === 1 ? t('1 caution: see Why') : t('{n} cautions: see Why', { n: warns })] : ['ok', t('No cautions')],
    ev ? ['warn', `${t(COMING[ev.kind] || ev.kind)}${ev.kind !== 'bad_news' ? ` ${fmt.date(ev.date, false)}` : ''}`] : ['ok', t('No results or dividend due')],
  ];
}
const MARK = { ok: 'check', warn: 'alert', bad: 'x', none: 'info' };
function Checks({ items }) {
  return html`<ul class="checks">${items.map(([k, text]) => html`<li class=${k}><${Icon} name=${MARK[k]} size=${13} /><span dir="auto">${text}</span></li>`)}</ul>`;
}

// Your money: the shares for your account (the risk rule in Settings), what the stop would cost and the target would
// make, with both sides' fees. ponytail: fees as your broker's % a side (feePct), not Thndr's EGP 2 an order.
function Money({ s, fee }) {
  if (!s.shares) return html`<p class="money faint">${t('Not sized')}: <span dir="auto">${tn(s.size_note) || '–'}</span></p>`;
  const f = (fee || 0) / 100, buy = s.amount * (1 + f);
  const loss = buy - s.shares * s.stop * (1 - f), gain = s.shares * s.target * (1 - f) - buy;
  return html`<p class="money">${tp('For your account: {shares} shares, {amount}. At the stop {loss}, at the target {gain}, after fees.', {
    shares: html`<b>${fmt.int(s.shares)}</b>`, amount: html`<b>${fmt.egp(s.amount)}</b>`,
    loss: html`<b class="down">${fmt.signed(-loss)}</b>`, gain: html`<b class="up">${fmt.signed(gain)}</b>` })}</p>`;
}

function PickCard({ s, m, wk, odds, fee, model }) {
  const i = s.info;
  const both = s.source !== 'model' && s.pred && s.pred.top10;
  const cautions = s.cautions || [];
  const results = cautions.find(c => c.kind === 'results');
  return html`<article class="card signal">
    <div class="sig-head">
      <div class="who">
        <div class="sym-line"><${StockAvatar} symbol=${s.symbol} size=${34} /><a class="sym-big" href=${stockHref(s.symbol)}>${s.symbol}</a>
          ${s.source === 'model'
            ? html`<span class="model-pick" title=${t("One of the prediction model's top picks today that also passes the trading and uptrend checks. Same stop, target and sizing as any BUY.")}><${Icon} name="target" size=${12} />${t('Model pick')}</span>`
            : both && html`<span class="agree" title=${t("A BUY by the rules that is also one of the model's top 10% today")}><${Icon} name="check" size=${12} />${t('Both agree')}</span>`}</div>
        <div class="stock-name" dir="rtl" style="text-align:start">${i.name_ar}<span class="faint"> · ${tn(i.sector)}</span></div>
      </div>
    </div>
    <div class="sig-tags"><${Badges} info=${i} compact /><${IndexPills} info=${i} /></div>
    <${Opinions} s=${s} wk=${wk} />
    <div>
      <div class="buy-line"><span><${Term} k="buyupto">${t('Buy up to')}<//> <b>${fmt.price(s.entry_high)}</b></span>
        <span class="faint">${t('last close')} ${fmt.price(s.close)}</span></div>
      <${PlanBar} p=${{ stop: s.stop, target: s.target, price: s.close, avg_price: s.entry_high }} />
    </div>
    <${Checks} items=${checks(s, m)} />
    <${Money} s=${s} fee=${fee} />
    <${Odds} s=${s} odds=${odds} />
    <${More} label="Why this signal">
      <ul class="reasons" dir="auto">${(s.reasons || []).map(r => html`<li class=${/^Caution/.test(r) ? 'caution' : ''}>${tn(r)}</li>`)}</ul>
      ${model && s.pred && html`<div class="model-line"><${Icon} name="target" size=${14} />
        ${s.pred.top10 === false
          ? t('Model: #{rank} of {n}, not one of its top picks today', { rank: fmt.int(s.pred.rank10), n: fmt.int(model.count) })
          : tp('Model: #{rank} of {n}, {chance} chance of target before stop in 2 weeks', {
              rank: fmt.int(s.pred.rank10), n: fmt.int(model.count), chance: html`<${Chance} p=${s.pred.p10} base=${model.base[10]} />` })}</div>
        ${s.pred.why10 && s.pred.why10.length > 0 && html`<${Why} items=${s.pred.why10} />`}`}
      ${cautions.length > 0 && html`<${Cautions} items=${cautions} />`}
      ${cautions.some(c => c.kind === 'ex_dividend') && html`<p>${t('It goes ex-dividend before this trade would end. The price drops by the dividend that morning and you get it in cash, so the agent lowers the stop and target by the same amount (a to-do reminds you the evening before). Counting the dividend, BUYs this close to an ex-date did as well as the others in 10 years of tests.')}</p>`}
      ${results && html`<p>${t('Results are expected around {date}, before this trade would end. The price can jump either way that day; the agent keeps the same stop.', {
        date: fmt.date(results.date, false) })}</p>`}
      <p class="faint">${t('Sizing')}: <span dir="auto">${tn(s.size_note)}</span> · ${t('hold at most until')} <b class="muted">${fmt.date(s.sell_by)}</b></p>
    <//>
    <div class="sig-foot">
      <a class="btn sm ghost" href=${stockHref(s.symbol)}><${Icon} name="chart" />${t('Chart')}</a>
      <a class="btn sm ghost" href=${`#/calc/${encodeURIComponent(s.symbol)}`}><${Icon} name="coins" />${t('Size it')}</a>
      <a class="btn sm primary" href=${buyHref(s.symbol, s.entry_high, s.shares)}><${Icon} name="plus" />${t('Log buy')}</a>
    </div>
  </article>`;
}

// ------------------------------------------------------------------ what may come next
// The agent's stocks close to a BUY (not your own Watchlist), the model's favourites first: how far each is from its
// breakout price (the 20-day high). During the session, with live prices, the ones already above it are marked: a
// BUY needs the close above it, so that isn't a signal yet.
const SHOW = 8;
const GAP = 0.2;        // ponytail: the bar starts 20% under the breakout price; farther ones show an empty bar
function NearBoxes({ rows, rated, tg }) {
  const [all, setAll] = useState(false);
  const [bells, setBells] = useBells(tg);
  const q = useQuotes(rows.map(r => r.symbol));
  if (!rows.length) return html`<div class="card"><${Empty} icon="eye" title="Nothing close to a BUY" text="No strong uptrend is waiting to break out at the last close." /></div>`;
  const live = sessionState().state === 'open';
  const rate = r => (r.pred && r.pred.rating != null ? r.pred.rating : -1);
  const sorted = [...rows].sort(rated ? (a, b) => rate(b) - rate(a) : (a, b) => b.score - a.score);
  const shown = all ? sorted : sorted.slice(0, SHOW);
  return html`<div class="near-grid">${shown.map(r => {
    const quote = live && q[r.symbol];
    const now = quote ? quote.price : r.close;
    const away = r.trigger ? r.trigger / now - 1 : null;
    const over = quote && away != null && away <= 0;
    const near = away != null && away <= 0.05;      // within 5%: one good session can do it
    return html`<article class=${cls('card near-box', over && 'over')} key=${r.symbol} onClick=${() => go(stockHref(r.symbol))}>
      <div class="nb-head">
        <div class="nb-who"><a class="sym" href=${stockHref(r.symbol)}>${r.symbol}</a>
          <div class="faint nb-name" dir="rtl">${r.info && r.info.name_ar}</div></div>
        ${rated && html`<${Rating} v=${r.pred && r.pred.rating} />`}
        <${Bell} sym=${r.symbol} tg=${tg} bells=${bells} setBells=${setBells} />
      </div>
      ${over ? html`<div class="nb-over" title=${t('A BUY needs the close above the breakout price')}>${t('Above it now: wait for the close')}</div>`
        : away != null && html`<div class="nb-away"><b class=${near ? 'up' : ''}>${fmt.pct(away, 1)}</b> <span class="faint">${t('to break out')}</span></div>`}
      <div class=${cls('bar', over ? '' : 'up')}><span style=${`width:${away == null ? 0 : Math.max(4, Math.min(100, (1 - away / GAP) * 100))}%`}></span></div>
      <div class="nb-prices">
        <span><b>${fmt.price(now)}</b>${quote ? html` <span class="live-dot" title=${t('Live, about 15 minutes late')}></span>` : ''}
          <span class="faint">${t(quote ? 'now' : 'last close')}</span></span>
        <span class="r" title=${t('Breakout price: the 20-day high')}><b>${fmt.price(r.trigger)}</b>
          <span class="faint">${t('breakout')}</span></span></div>
      ${rated && r.pred && r.pred.why10 && html`<div class="nb-why"><${Reason} items=${r.pred.why10} stacked /></div>`}
    </article>`;
  })}</div>
  ${sorted.length > SHOW && html`<button class="btn sm ghost near-more" onClick=${() => setAll(!all)}>${
    all ? t('Show fewer') : t('Show all {n}', { n: sorted.length })}</button>`}`;
}

// The model's favourites for the next 5 sessions (the Rankings tab has all of them).
function WeekPicks({ p }) {
  const w = p.week, base = w.test.all.hit;
  const rows = p.rows.filter(r => r[`rank${WK}`] != null).sort((a, b) => a[`rank${WK}`] - b[`rank${WK}`]).slice(0, 5);
  return html`<${SectionHead} title="The model's picks for next week"
      hint=${t('Chance it rises to its target before it falls to its stop, within 5 sessions. The average stock: {pct}.', { pct: fmt.pct(base, 0, false) })}>
      <a class="btn sm ghost" href="#/predict">${t('All rankings')} <${Icon} name="chevron" size=${14} /></a><//>
    ${w.weak && html`<div style="margin-bottom:10px"><${Callout} tone="warn">${t('Weak market: better to skip short trades this week.')}<//></div>`}
    <div class="card flush near-list">${rows.map(r => html`<div class="near week-row" key=${r.symbol} onClick=${() => go(stockHref(r.symbol))}>
      <span class="faint wk-rank">${fmt.int(r[`rank${WK}`])} <${RankMove} now=${r[`rank${WK}`]} before=${r[`prev_rank${WK}`]} /></span>
      <span class="near-who"><a class="sym" href=${stockHref(r.symbol)}>${r.symbol}</a>
        ${r.level === 'good' && r[`rank${WK}`] <= p.top_n && html`<span class="model-pick" title=${t('One of its top 10% today, in an uptrend, while the market is healthy')}>${t('Strong')}</span>`}
        ${r.action === 'BUY' && html`<span class="agree">${t('A BUY too')}</span>`}
        ${r.held && html`<span class="tag"><${Icon} name="briefcase" size=${12} />${t('In your portfolio')}</span>`}</span>
      <span class="wk-chance"><${Chance} p=${r[`p${WK}`]} base=${base} /></span>
      <span class="wk-move faint"><span class="up">${fmt.pct(r[`move${WK}`], 1)}</span> / <span class="down">${fmt.pct(-r[`move${WK}`], 1)}</span></span>
    </div>`)}</div>`;
}

// ------------------------------------------------------------------ can I trust it now?
const NEED_WEEK = 30;   // ended strong week picks before their live hit rate means much
const MODEL_SAYS = { ok: 'On track', weak: 'Weaker than in its tests', bad: 'Not working lately', early: 'Too early to tell' };
function trustRows(rec, p) {
  const out = [];
  if (rec) {
    const s = rec.summary, h = rec.health;
    out.push([h.status === 'ok' ? 'ok' : h.status === 'cold' ? 'warn' : 'none', "The rules' BUYs",
      h.status === 'early' ? t('Too early: {n} of {need} ended', { n: fmt.int(h.closed), need: fmt.int(h.need) })
        : t('Won {win}, tests {test}', { win: fmt.pct(s.win_rate, 0, false), test: fmt.pct(h.test_win_rate, 0, false) })]);
  }
  if (p && p.health && MODEL_SAYS[p.health.status]) {
    const st = p.health.status;
    out.push([{ ok: 'ok', weak: 'warn', bad: 'bad' }[st] || 'none', 'The model (2 weeks)', t(MODEL_SAYS[st])]);
  }
  if (p && p.week) {
    const live = p.week.live && p.week.live.strong, n = (live && live.n) || 0, test = p.week.test.strong.hit;
    out.push(n < NEED_WEEK ? ['none', "Next week's strong picks", t('Too early: {n} of {need} ended', { n: fmt.int(n), need: NEED_WEEK })]
      : [live.hit >= test - 0.1 ? 'ok' : 'warn', "Next week's strong picks",
        t('Won {win}, tests {test}', { win: fmt.pct(live.hit, 0, false), test: fmt.pct(test, 0, false) })]);
  }
  return out;
}
function Trust({ rec, p }) {
  const rows = trustRows(rec, p);
  if (!rows.length) return null;
  return html`<${SectionHead} title="Can I trust it now?" hint="How they did live, against their tests.">
      <a class="btn sm ghost" href="#/record">${t('Track record')} <${Icon} name="chevron" size=${14} /></a><//>
    <div class="card flush trust">${rows.map(([k, label, text]) => html`<a class="trust-row" href="#/record" key=${label}>
      <span><span class=${cls('health-dot', k)}></span>${t(label)}</span><span class="muted">${text}</span></a>`)}</div>`;
}

// ------------------------------------------------------------------ Track record
// Every BUY the agent published, followed with the same exit rules from the next open (egx_agent/record.py), set
// against the 10-year test; and the model's live check. The live record is the honest check; the test only says what
// to expect.
export function RecordPage() {
  const { page, data } = useToday('Track record');
  const { data: pred } = useApi('/predict');
  if (page) return page;
  const model = pred && pred.model ? pred : null;
  return html`
    <${PageHead} title="Track record" sub="How the BUY signals and the model did since they went live." />
    ${data.record && html`<${TrackRecord} rec=${data.record} odds=${data.odds} />`}
    ${model && html`<section class="section"><${SectionHead} title="The model, live" />
      <div class="stack"><${Health} h=${model.health} /><${Recent} rec=${(model.recent || {})['10']} />
        <${Recent} rec=${(model.recent || {})[String(WK)]} /></div></section>`}
    ${data.cfg.auto_paper && data.paper && data.paper.last_scan && html`<p class="faint note">
      ${t('Paper trading at this scan: {filled} filled, {closed} closed, {skipped} skipped, {orders} new orders for the next session.', {
        filled: data.paper.last_scan.filled || 0, closed: data.paper.last_scan.closed || 0,
        skipped: data.paper.last_scan.cancelled || 0, orders: data.paper.last_scan.new_orders || 0 })}</p>`}`;
}

function TrackRecord({ rec, odds }) {
  const s = rec.summary, h = rec.health, test = odds && odds.all;
  const ended = x => (x.status === 'closed' ? tn(x.reason) : x.status === 'open' ? t('Still open')
    : x.status === 'waiting' ? t('Buys at the next open') : t('Skipped: the open was past its limits'));
  const columns = [
    { key: 'date', label: 'Signal', fmt: v => fmt.date(v) },
    { key: 'symbol', label: 'Stock', render: r => html`<a href=${stockHref(r.symbol)}>${r.symbol}</a>` },
    { key: 'status', label: 'How it went', sortable: false, render: r => html`<span dir="auto">${ended(r)}</span>` },
    { key: 'days', label: 'Days', align: 'r', fmt: v => (v ? fmt.int(v) : '–') },
    { key: 'return', label: 'Result', align: 'r', fmt: v => (v == null ? '–' : html`<span class=${tone(v)}>${fmt.pct(v, 1)}</span>`) },
  ];
  return html`<${SectionHead} title="BUY signals" hint=${s.since ? t('Every BUY since {date}, followed with the same exit rules', { date: fmt.date(s.since) }) : ''} />
    <div class="card">
      ${s.signals ? html`<div class="stat-list">
          <span class="k">${t('BUY signals')}</span><span class="v">${fmt.int(s.signals)}${s.open ? html` <span class="faint" style="font-weight:500">· ${t('{n} still open', { n: fmt.int(s.open) })}</span>` : ''}</span>
          <span class="k">${t('Ended')}</span><span class="v">${fmt.int(s.n)}</span>
          ${s.n > 0 && html`<span class="k">${t('Won')}</span><span class="v">${fmt.pct(s.win_rate, 0, false)}</span>
            <span class="k">${t('Average per trade, after fees')}</span><span class=${cls('v', tone(s.avg))}>${fmt.pct(s.avg, 1)}</span>`}
        </div>`
        : html`<p class="muted" style="font-size:13px">${t('No BUY signals published yet. Each one is added here and followed until it ends.')}</p>`}
      ${h.status === 'cold' && html`<div style="margin-top:12px"><${Callout} tone="warn">${t('The last {n} signals did clearly worse than the tests: {win} won against {test}. Consider smaller positions until they recover.', {
        n: fmt.int(h.closed), win: fmt.pct(s.win_rate, 0, false), test: fmt.pct(h.test_win_rate, 0, false) })}<//></div>`}
      ${h.status === 'ok' && html`<p class="muted" style="font-size:13px;margin-top:10px">${t('In line with the tests: {win} won against {test}.', {
        win: fmt.pct(s.win_rate, 0, false), test: fmt.pct(h.test_win_rate, 0, false) })}</p>`}
      ${h.status === 'early' && html`<p class="muted" style="font-size:13px;margin-top:10px">${t('{closed} of the {need} ended signals needed to judge it. Until then, go by the test below, not these numbers.', {
        closed: fmt.int(h.closed), need: fmt.int(h.need) })}</p>`}
      ${test && test.n > 0 && html`<p class="faint" style="font-size:12.5px;margin-top:10px">${t('The same rules on {from} – {to}: {n} trades, {win} won, {avg} a trade on average, {cagr} a year, worst drop {dd}.', {
        from: fmt.date(odds.from), to: fmt.date(odds.to), n: fmt.int(test.n), win: fmt.pct(test.win_rate, 0, false),
        avg: fmt.pct(test.avg, 1), cagr: fmt.pct(odds.cagr, 1), dd: fmt.pct(odds.max_drawdown, 1) })}</p>`}
      ${rec.signals.length > 0 && html`<${More} label="Every signal"><div class="flush"><${DataTable} columns=${columns} rows=${rec.signals}
        rowKey=${r => `${r.date}:${r.symbol}`} sort=${{ key: 'date', dir: 'desc' }} /></div><//>`}
      <${More} label="How far to trust these numbers"><p>${t(TRUST)}</p><//>
    </div>`;
}

const TRUST = 'The test replays the current rules on 10 years of prices, from the open after each signal, fees included. It '
  + 'flatters them a little: it only knows the companies listed today (ones that failed and left the exchange are missing), '
  + 'and the rules were chosen by testing on those same years. The track record is the honest check: every BUY the agent '
  + 'published, followed the same way. Judge it after about 30 ended signals; a handful proves nothing either way. In the '
  + 'test a higher score barely changed the odds, so treat every BUY about the same.';
