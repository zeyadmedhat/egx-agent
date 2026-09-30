// Today, in two tabs. Summary: the day in a few sentences, the orders for the next session, your positions and the
// market. Signals: the BUY signals and the stocks close to one.
import { html, useApi, useState, useEffect, api, toast, fmt, tone, stockHref, cls, go, todayISO, copyText, remember, STATIC } from '../lib.js';
import {
  Icon, Badges, IndexPills, StatusChip, ScoreRing, DayBar, Empty, Callout, PageHead, SectionHead, PageLoading, DataTable,
  StockCell, JobControl, Chance, MarketSwitch, Cautions, Why, LiveQuotes, LIVE_NOTE, StockAvatar, Change, Term,
  SessionBadge, More, ScoreBar, ShariahNote,
} from '../ui.js';
import { t, tp, isAr, tn } from '../i18n.js';
import { Sparkline } from '../charts.js';

// Both tabs read /today; before the first scan they explain how to get one.
function useToday(title) {
  const { data, error } = useApi('/today');
  if (!data) return { page: html`<${PageLoading} error=${error} />` };
  if (!data.market) {
    return { page: html`<${PageHead} title=${title} />
      <div class="card"><${Empty} icon="activity" title="No scan yet"
        text=${STATIC ? 'The site scans by itself after every close. Check back after the next one.'
          : 'Press Run scan to download 5 years of prices for every EGX stock and look for signals. The first time takes about 5–10 minutes; after that about 2 minutes.'}
        action=${STATIC ? null : html`<${JobControl} />`} /></div>` };
  }
  const blocked = data.market.risk_off && data.cfg.riskoff_block_buys;
  return { data, blocked, alerts: data.positions.filter(p => p.status !== 'HOLD').length };
}

export function TodayPage() {
  const { page, data, blocked, alerts } = useToday('Today');
  if (page) return page;
  const m = data.market;
  return html`
    <${PageHead} title="Today" sub=${t('From the {date} close', { date: fmt.date(m.date) })}>
      <${SessionBadge} dataDate=${m.date} /><//>
    <${Brief} data=${data} blocked=${blocked} alerts=${alerts} />
    ${m.warnings && m.warnings.length > 0 && html`<div class="stack" style="margin-top:12px">
      ${m.warnings.map(w => html`<${Callout} tone="warn">${w}<//>`)}</div>`}
    ${data.orders && html`<${OrdersCard} o=${data.orders} />`}
    ${data.positions.length > 0 && html`<${Positions} positions=${data.positions} cfg=${data.cfg} alerts=${alerts} />`}
    <section class="section">
      <${SectionHead} title="Market" />
      <${MarketCard} m=${m} spark=${data.spark} blocked=${blocked} b=${data.breadth} />
    </section>
    <${LiveNow} positions=${data.positions} buys=${data.buys} />`;
}

export function SignalsPage() {
  const { page, data, blocked } = useToday('Signals');
  if (page) return page;
  const m = data.market;
  return html`
    <${PageHead} title="Signals" sub=${t('Signals for the next session, from the {date} close', { date: fmt.date(m.date) })}>
      <${SessionBadge} dataDate=${m.date} /><//>
    <section>
      <${SectionHead} title="BUY signals" count=${data.buys.length}
        hint=${data.buys.length ? "Don't pay more than Buy up to. If it opens higher, skip it." : ''} />
      ${data.buys.length
        ? html`<div class="signal-grid">${data.buys.map(s => html`<${SignalCard} s=${s} model=${data.model} odds=${data.odds} key=${s.symbol} />`)}</div>`
        : html`<div class="card"><${Empty} icon="shield" title="No BUY signals for the next session" text=${blocked
          ? "The market is in risk-off mode (EGX30 is below its 50-day average), so the agent isn't making new BUY calls. Sitting in cash is a valid decision. The list below shows what is close to a BUY once the market recovers."
          : 'No stock met all the entry rules at the last close. Sitting in cash is a valid decision. The list below shows what is close to a BUY.'} /></div>`}
    </section>
    <section class="section">
      <${SectionHead} title=${html`<${Term} k="watchlist">${t('Close to a BUY')}<//>`} count=${data.watch.length}
        hint="Strong uptrends without an entry trigger yet."><${ShariahNote} mode=${data.cfg.shariah_filter} /><//>
      <div class="card flush"><${NearList} rows=${data.watch} model=${data.model} /></div>
    </section>
    ${data.record && html`<section class="section"><${TrackRecord} rec=${data.record} odds=${data.odds} /></section>`}
    ${data.cfg.auto_paper && data.paper && data.paper.last_scan && html`<p class="faint note">
      ${t('Paper trading at this scan: {filled} filled, {closed} closed, {skipped} skipped, {orders} new orders for the next session.', {
        filled: data.paper.last_scan.filled || 0, closed: data.paper.last_scan.closed || 0,
        skipped: data.paper.last_scan.cancelled || 0, orders: data.paper.last_scan.new_orders || 0 })}</p>`}`;
}

// "Today in one minute": the market, the signals and your positions in a few plain sentences, from this page's data.
function Brief({ data, blocked, alerts }) {
  const m = data.market, b = data.breadth;
  const lines = [];
  const chg = m.egx30_change, value = fmt.int(m.egx30_close);
  lines.push(chg > 0 ? t('EGX30 rose {pct} to {value}.', { pct: fmt.pct(chg, 2, false), value })
    : chg < 0 ? t('EGX30 fell {pct} to {value}.', { pct: fmt.pct(-chg, 2, false), value })
      : t('EGX30 was flat at {value}.', { value }));
  const gap = m.egx30_close / m.egx30_ema50 - 1;
  lines[0] += ' ' + t(gap >= 0 ? 'It is {pct} above its 50-day average.' : 'It is {pct} below its 50-day average.',
    { pct: fmt.pct(Math.abs(gap), 1, false) });
  if (b) {
    lines.push(t('{up} stocks rose and {down} fell; {above} are above their 50-day average.',
      { up: b.advancers, down: b.decliners, above: fmt.pct(b.above50, 0, false) }));
  }
  if (m.risk_off) lines.push(t(blocked ? 'Risk-off market: no new BUYs until EGX30 recovers.' : 'Risk-off market: only very strong BUYs, and fewer of them.'));
  const syms = data.buys.map(x => x.symbol).join(isAr() ? '، ' : ', ');
  if (!data.buys.length) { if (!blocked) lines.push(t('No BUY signals for the next session.')); } else {
    lines.push(t(data.buys.length === 1 ? '1 BUY signal: {list}.' : '{n} BUY signals: {list}.', { n: data.buys.length, list: syms }));
  }
  const pos = data.positions;
  lines.push(!pos.length ? t('You have no open positions.')
    : alerts ? t('Your positions: {n} need action. See the orders below.', { n: alerts })
      : pos.length === 1 ? t('Your position: nothing to do, it stays on hold.') : t('Your {n} positions: nothing to do, all on hold.', { n: pos.length }));
  for (const p of pos) {
    for (const c of p.cautions || []) {
      if (c.kind === 'results') lines.push(t('{sym}: results expected around {date}.', { sym: p.symbol, date: fmt.date(c.date, false) }));
      if (c.kind === 'ex_dividend') lines.push(t('{sym}: goes ex-dividend on {date}.', { sym: p.symbol, date: fmt.date(c.date, false) }));
    }
  }
  return html`<div class="card brief">
    <div class="brief-head">${t('Today in one minute')}</div>
    <ul>${lines.map(l => html`<li>${l}</li>`)}</ul>
    ${data.buys.length > 0 && html`<a class="btn sm primary brief-go" href="#/signals">${t('See the BUY signals')}
      <${Icon} name="chevron" size=${14} /></a>`}
  </div>`;
}

// EGX30, your stocks and the BUY signals at TradingView's live prices (about 15 minutes late). Closed until you open it.
function LiveNow({ positions, buys }) {
  const [open, setOpen] = useState(() => remember('live-open') === '1');
  const flip = e => { const on = e.currentTarget.open; setOpen(on); remember('live-open', on ? '1' : '0'); };
  const symbols = ['EGX30', ...positions.map(p => p.symbol), ...buys.map(s => s.symbol)];
  return html`<details class="fold card" open=${open} onToggle=${flip}>
    <summary><${Icon} name="chevron" size=${16} /><b>${t('Live prices')}</b><span class="hint">${t('TradingView, about 15 minutes late')}</span></summary>
    ${open && html`<div class="live-list"><${LiveQuotes} symbols=${symbols}
      title=${t(positions.length ? 'EGX30, your stocks and the BUYs' : 'EGX30 and the BUYs')} /></div>
      <p class="faint note">${t(LIVE_NOTE)}</p>`}
  </details>`;
}

function MarketCard({ m, spark, blocked, b }) {
  const gap = m.egx30_close / m.egx30_ema50 - 1;
  const text = blocked
    ? t('EGX30 is below its 50-day average, so the agent makes no new BUY calls until it recovers. Focus on managing your open positions.')
    : m.risk_off
      ? t('Risk-off: only very strong signals (score ≥ {n}) and at most half the usual number of positions.', { n: fmt.int(m.buy_threshold) })
      : t('EGX30 is above its 50-day average, so new BUY signals are allowed.');
  return html`<div class="card market">
    <div class="market-main">
      <div class="row" style="justify-content:space-between"><span class="eyebrow">${t('EGX30 index')}</span>
        ${m.risk_off
          ? html`<span class="chip riskoff"><span class="dot"></span><${Term} k="riskoff">${t('Risk-off')}<//></span>`
          : html`<span class="chip riskon"><span class="dot"></span>${t('Market OK')}</span>`}</div>
      <div class="market-price">${fmt.int(m.egx30_close)}<${Change} value=${m.egx30_change} pill /></div>
      <div class="market-meta"><${Term} k="ema50">${t('50-day average')}<//> ${fmt.int(m.egx30_ema50)} ·${' '}
        ${tp(gap >= 0 ? 'the index is {pct} above it' : 'the index is {pct} below it',
          { pct: html`<b class=${tone(gap)}>${fmt.pct(Math.abs(gap), 1, false)}</b>` })}</div>
      <p class="market-text">${text}</p>
      ${b && b.switch && html`<div style="margin-top:8px"><${MarketSwitch} sw=${b.switch} compact /></div>`}
    </div>
    <div class="market-spark">
      <div class="spark-legend">
        <span><span class="legend-dot" style=${`background:var(--${m.risk_off ? 'down' : 'up'})`}></span>${t('EGX30, 6 months')}</span>
        <span><span class="legend-dot" style="background:var(--warn)"></span>${t('50-day average')}</span></div>
      <${Sparkline} spark=${spark} />
    </div>
    <div class="market-stats">
      ${b && html`<a href="#/market"><${Term} k="breadth">${t('Breadth')}<//>${' '}<b class=${b.tone === 'ok' ? 'up' : b.tone === 'bad' ? 'down' : 'warn'}>${fmt.pct(b.above50, 0, false)}</b> ${t('above 50-day avg')}
        <${Icon} name="chevron" size=${13} /></a>`}
      <span>${t('Data')}: <b>${fmt.date(m.date)}</b> ${t('close')}</span><span>${t('Last run')} <b>${fmt.datetime(m.finished)}</b></span>
    </div>
  </div>`;
}

function Positions({ positions, cfg, alerts }) {
  return html`<section class="section">
    <${SectionHead} title="Your open positions" count=${positions.length}
      hint=${alerts ? t(alerts === 1 ? '{n} needs your attention' : '{n} need your attention', { n: alerts }) : 'Nothing to do: all on hold'}>
      <a class="btn sm" href="#/portfolio">${t('Manage')} <${Icon} name="chevron" size=${14} /></a><//>
    <div class="card flush alerts">${positions.map(p => html`<div class="alert-row" key=${p.id}>
      <div class="stock-cell"><${StockAvatar} symbol=${p.symbol} size=${34} /><div><a class="sym-big" style="font-size:15px" href=${stockHref(p.symbol)}>${p.symbol}</a>
        <div class="faint" style="font-size:12px;white-space:nowrap">${fmt.int(p.shares)} ${t('sh')} · <span class=${tone(p.pnl_pct)}>${fmt.pct(p.pnl_pct)}</span></div></div></div>
      <div><${StatusChip} status=${p.status} /></div>
      <div class="reason" dir="auto">${tn(p.reason)}${p.cautions && p.cautions.length > 0 && html`<div style="margin-top:4px">
        <${Cautions} items=${p.cautions} compact /></div>`}</div>
      <${DayBar} day=${p.day} max=${cfg.max_hold_days} review=${cfg.review_day} />
    </div>`)}</div></section>`;
}

// ------------------------------------------------------------------ orders for the next session
const KIND = { adjust: 'UPDATE', sell: 'SELL', stop: 'STOP', review: 'REVIEW', buy: 'BUY' };

function sessionName(day) {
  const d = new Date(day + 'T00:00:00');
  const tomorrow = new Date(todayISO() + 'T00:00:00');
  tomorrow.setDate(tomorrow.getDate() + 1);
  const label = d.toLocaleDateString(isAr() ? 'ar-EG-u-nu-latn' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
  if (day === todayISO()) return t('today, {day}', { day: label });
  if (d.getTime() === tomorrow.getTime()) return t('tomorrow, {day}', { day: label });
  return label;
}


const buyHref = (sym, price, shares) =>
  `#/portfolio?buy=${encodeURIComponent(sym)}&price=${Number(price).toFixed(2)}&shares=${shares || ''}`;

function OrderAction({ it }) {
  if (it.kind === 'buy') return html`<a class="btn sm" href=${buyHref(it.symbol, it.limit, it.shares)}><${Icon} name="plus" />${t('Log buy')}</a>`;
  if (it.kind === 'sell' || it.kind === 'review') {
    return html`<a class="btn sm" href=${`#/portfolio?open=${it.trade_id}`}><${Icon} name="sell" />${t('Log sale')}</a>`;
  }
  if (it.kind === 'adjust') return html`<a class="btn sm" href=${`#/portfolio?open=${it.trade_id}`}><${Icon} name="split" />${t('Update')}</a>`;
  return html`<a class="btn sm ghost" href=${stockHref(it.symbol)}><${Icon} name="chart" />${t('Chart')}</a>`;
}

function OrdersCard({ o }) {
  const initial = () => new Set(o.items.filter(i => i.done).map(i => i.key));
  const [done, setDone] = useState(initial);
  useEffect(() => setDone(initial()), [o]);
  const toggle = async it => {
    const before = done;
    const next = new Set(done);
    const on = !next.has(it.key);
    if (on) next.add(it.key); else next.delete(it.key);
    setDone(next);
    try {
      await api('/orders/check', { method: 'PUT', body: { session: o.session, item: it.key, done: on } });
    } catch (e) {
      setDone(before);
      toast(e.message, 'error', 8000);
    }
  };
  const copy = () => {
    const lines = [`EGX orders for ${sessionName(o.session)}`, ''];
    for (const it of o.items) lines.push(`${done.has(it.key) ? '[x]' : '[ ]'} ${it.title}`, `    ${it.detail}`);
    if (!o.items.length) lines.push('Nothing to do.');
    if (o.holds.length) lines.push('', `No change: ${o.holds.map(h => `${h.symbol} (stop ${fmt.price(h.stop)})`).join(', ')}`);
    if (copyText(lines.join('\n'))) toast('Copied. Paste it into your notes or a message to your broker.');
    else toast("Couldn't copy from this browser. Select the list and copy it instead.", 'error');
  };
  const n = o.items.length;
  const k = o.items.filter(i => done.has(i.key)).length;
  return html`<section class="section"><div class="card flush">
    <div class="orders-head">
      <div><h2>${t('Orders for {when}', { when: sessionName(o.session) })}</h2>
        <div class="sub">${n ? t('Most urgent first. Tick each one off as you place it at your broker.')
          : t('From the {date} close.', { date: fmt.date(o.scan_date) })}</div></div>
      <div class="right">
        ${n > 0 && html`<span class="orders-progress">${t('{k} of {n} done', { k, n })}<span class=${cls('bar', k === n && 'up')}>
          <span style=${`width:${(k / n) * 100}%`}></span></span></span>`}
        <button class="btn sm ghost" onClick=${copy} title=${t('Copy the list as text')}><${Icon} name="copy" />${t('Copy')}</button>
      </div>
    </div>
    ${o.stale && html`<div style="padding:0 18px 12px"><${Callout} tone="warn">${t('These orders were for {date}.', { date: fmt.date(o.session) })}${' '}
      ${t(STATIC ? "The next session's list appears here after the site's next scan." : "Press Run scan for the next session's list.")}<//></div>`}
    ${o.items.map(it => html`<div class=${cls('order', done.has(it.key) && 'done')} key=${it.key}>
      <button class=${cls('tick', done.has(it.key) && 'on')} onClick=${() => toggle(it)}
        aria-label=${done.has(it.key) ? 'Mark as not done' : 'Mark as done'} title="Done"><${Icon} name="check" /></button>
      <span class=${`kind ${it.kind}`}>${t(KIND[it.kind])}</span>
      <div class="o-body" dir="auto"><div class="o-title">${tn(it.title)}</div><div class="o-detail">${tn(it.detail)}</div>
        ${it.kind === 'buy' && html`<div class="o-shariah"><${Badges} info=${it.info} compact /></div>`}</div>
      <div class="o-act"><${OrderAction} it=${it} /></div>
    </div>`)}
    ${!n && html`<div class="orders-empty"><${Icon} name="checkCircle" />${t('Nothing to do at your broker.')}${' '}
      ${t(o.blocked ? 'No new buys while EGX30 is below its 50-day average.' : 'No BUY signals at this close.')}</div>`}
    ${(o.holds.length > 0 || o.skipped.length > 0) && html`<div class="orders-foot">
      ${o.holds.length > 0 && html`<span>${t('No change')}: ${o.holds.map((h, i) => html`${i ? ', ' : ''}<b>${h.symbol}</b> (${t('stop')} ${fmt.price(h.stop)})`)}</span>`}
      ${o.skipped.length > 0 && html`<span>${t('Not bought')}: ${o.skipped.map((x, i) => html`${i ? ', ' : ''}<b>${x.symbol}</b> (${x.note})`)}</span>`}
    </div>`}
  </div></section>`;
}

function Level({ label, value, sub, subCls }) {
  return html`<div class="level"><div class="l-label">${typeof label === 'string' ? t(label) : label}</div><div class="l-value">${value}</div>
    ${sub && html`<div class=${cls('l-sub', subCls)}>${sub}</div>`}</div>`;
}

// What the rules' BUYs with a score like this one did in the 10-year test (egx_agent/record.py). Not for the model's
// picks: its own test is on the Predict page.
function Odds({ s, odds }) {
  if (!odds || s.source === 'model') return null;
  const b = (odds.bands || []).find(x => s.score >= x.from && s.score < (x.to === 100 ? 101 : x.to));
  if (!b || !b.n) return null;
  return html`<p class="odds-line">${t('In {years} of tests, BUYs scored {from}–{to} won {win} of the time, {avg} a trade on average after fees ({n} trades).', {
    years: t('10 years'), from: b.from, to: b.to, win: fmt.pct(b.win_rate, 0, false), avg: fmt.pct(b.avg, 1), n: fmt.int(b.n) })}</p>`;
}

// Every BUY the agent published, followed with the same exit rules from the next open (egx_agent/record.py), set
// against the 10-year test. The live record is the honest check; the test only says what to expect.
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
  return html`<${SectionHead} title="Track record" hint=${s.since ? t('Every BUY since {date}, followed with the same exit rules', { date: fmt.date(s.since) }) : ''} />
    <div class="card">
      ${s.signals ? html`<div class="stat-list">
          <span class="k">${t('BUY signals')}</span><span class="v">${fmt.int(s.signals)}${s.open ? html` <span class="faint" style="font-weight:500">· ${t('{n} still open', { n: fmt.int(s.open) })}</span>` : ''}</span>
          <span class="k">${t('Ended')}</span><span class="v">${fmt.int(s.n)}</span>
          ${s.n > 0 && html`<span class="k">${t('Won')}</span><span class="v">${fmt.pct(s.win_rate, 0, false)}</span>
            <span class="k">${t('Average per trade, after fees')}</span><span class=${cls('v', tone(s.avg))}>${fmt.pct(s.avg, 1)}</span>`}
        </div>`
        : html`<p class="muted" style="font-size:13px">${t('No BUY signals published yet. Each one is added here and followed until it ends.')}</p>`}
      ${h.status === 'cold' && html`<div style="margin-top:12px"><${Callout} tone="warn">${t('The last {n} signals did clearly worse than the tests: {win} won against {test}, and they lost on average. Consider smaller positions until they recover.', {
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

function SignalCard({ s, model, odds }) {
  const i = s.info;
  const logHref = buyHref(s.symbol, s.entry_high, s.shares);
  const cautions = s.cautions || [];
  const results = cautions.find(c => c.kind === 'results');
  return html`<article class="card signal">
    <div class="sig-head">
      <div class="who">
        <div class="sym-line"><${StockAvatar} symbol=${s.symbol} size=${34} /><a class="sym-big" href=${stockHref(s.symbol)}>${s.symbol}</a>
          ${s.source === 'model'
            ? html`<span class="model-pick" title="One of the prediction model's top picks today that also passes the liquidity and uptrend checks. Same stop, target and sizing as any BUY."><${Icon} name="target" size=${12} />${t('Model pick')}</span>`
            : s.setup && html`<span class="tag">${t(s.setup)}</span>`}</div>
        <div class="stock-name" dir="rtl" style="text-align:start">${i.name_ar}<span class="faint"> · ${tn(i.sector)}</span></div>
      </div>
      <${ScoreRing} score=${s.score} />
    </div>
    <div class="sig-tags"><${Badges} info=${i} compact /><${IndexPills} info=${i} /><${Cautions} items=${cautions} compact /></div>
    <div class="levels">
      <${Level} label="Last close" value=${fmt.price(s.close)} />
      <${Level} label=${html`<${Term} k="buyupto">${t('Buy up to')}<//>`} value=${fmt.price(s.entry_high)} sub=${fmt.pct(s.entry_high / s.close - 1)} subCls="faint" />
      <${Level} label=${html`<${Term} k="stop">${t('Stop-loss')}<//>`} value=${fmt.price(s.stop)} sub=${fmt.pct(s.stop / s.close - 1)} subCls="down" />
      <${Level} label=${html`<${Term} k="target">${t('Target')}<//>`} value=${fmt.price(s.target)} sub=${fmt.pct(s.target / s.close - 1)} subCls="up" />
    </div>
    <div class="sizing">
      <span>${t('Shares')} <b>${s.shares ? fmt.int(s.shares) : '–'}</b></span>
      <span>${t('Amount')} <b>${fmt.egp(s.amount)}</b></span>
      <span>${t('Max loss')} <b class="down">${fmt.egp(s.risk_egp)}</b></span>
    </div>
    <${Odds} s=${s} odds=${odds} />
    <${More} label="Why this signal">
      <ul class="reasons" dir="auto">${(s.reasons || []).map(r => html`<li class=${/^Caution/.test(r) ? 'caution' : ''}>${tn(r)}</li>`)}</ul>
      ${model && s.pred && html`<div class="model-line"><${Icon} name="target" size=${14} />
        ${s.pred.top10 === false
          ? html`<a href="#/predict">${t('Model: #{rank} of {n}, not one of its top picks today', { rank: fmt.int(s.pred.rank10), n: fmt.int(model.count) })}</a>`
          : html`<a href="#/predict">${tp('Model: #{rank} of {n}, {chance} chance of target before stop in 2 weeks', {
              rank: fmt.int(s.pred.rank10), n: fmt.int(model.count), chance: html`<${Chance} p=${s.pred.p10} base=${model.base[10]} />` })}</a>
        <span class="faint">(${t('average stock {pct}', { pct: fmt.pct(model.base[10], 0, false) })})</span>`}</div>
        ${s.pred.why10 && s.pred.why10.length > 0 && html`<${Why} items=${s.pred.why10} />`}`}
      ${cautions.some(c => c.kind === 'ex_dividend') && html`<p>${t('It goes ex-dividend before this trade would end. The price drops by the dividend that morning and you get it in cash, so the agent lowers the stop and target by the same amount (a to-do reminds you the evening before). Counting the dividend, BUYs this close to an ex-date did as well as the others in 10 years of tests.')}</p>`}
      ${results && html`<p>${t('Results are expected around {date}, before this trade would end. The price can jump either way that day; the agent keeps the same stop.', {
        date: fmt.date(results.date, false) })}</p>`}
      <p class="faint">${t('Sizing')}: <span dir="auto">${tn(s.size_note)}</span> · ${t('hold at most until')} <b class="muted">${fmt.date(s.sell_by)}</b></p>
    <//>
    <div class="sig-foot">
      <a class="btn sm ghost" href=${stockHref(s.symbol)}><${Icon} name="chart" />${t('Chart')}</a>
      <a class="btn sm ghost" href=${`#/calc/${encodeURIComponent(s.symbol)}`}><${Icon} name="coins" />${t('Size it')}</a>
      <a class="btn sm primary" href=${logHref}><${Icon} name="plus" />${t('Log buy')}</a>
    </div>
  </article>`;
}

// The agent's list of stocks close to a BUY (not your own Watchlist).
function NearList({ rows, model }) {
  const columns = [
    { key: 'symbol', label: 'Stock', render: r => html`<${StockCell} symbol=${r.symbol} info=${r.info} />` },
    { key: 'score', label: html`<${Term} k="score">${t('Score')}<//>`, width: '140px', render: r => html`<${ScoreBar} score=${r.score} />` },
    { key: 'close', label: 'Close', align: 'r', fmt: v => fmt.price(v) },
    { key: 'trigger', label: html`<${Term} k="breakout">${t('Breakout above')}<//>`, align: 'r', fmt: v => html`<b>${fmt.price(v)}</b>` },
    { key: 'to_trigger', label: 'Distance', align: 'r', fmt: v => html`<span class="muted">${fmt.pct(v)}</span>`,
      title: 'How far the price must rise to break out' },
    { key: 'shariah', label: 'Shariah', sortable: false, render: r => html`<${Badges} info=${r.info} compact />` },
    { key: 'cautions', label: 'Good to know', sortable: false, render: r => html`<${Cautions} items=${r.cautions} compact />` },
  ];
  if (model) {
    columns.push({ key: 'model', label: 'Model (2 wk)', align: 'r', sortValue: r => (r.pred ? r.pred.p10 : -1),
      title: 'Prediction model: chance of target before stop within 10 sessions',
      render: r => html`<${Chance} p=${r.pred && r.pred.p10} base=${model.base[10]} top=${r.pred && r.pred.top10} />` });
  }
  return html`<${DataTable} columns=${columns} rows=${rows} rowKey=${r => r.symbol} sort=${{ key: 'score', dir: 'desc' }}
    onRowClick=${r => go(stockHref(r.symbol))} empty="No stocks on the watchlist at the last close." />`;
}
