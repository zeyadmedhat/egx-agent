// Home → Summary: the day in a few sentences, the orders for the next session and your positions. The market has its
// own tabs (Market, EGX30) and the BUY signals are on Picks (pages/picks.js), which reads the same /today.
import { html, useApi, useState, useEffect, api, toast, fmt, tone, stockHref, cls, todayISO, copyText, STATIC } from '../lib.js';
import {
  Icon, Badges, Empty, Callout, PageHead, SectionHead, PageLoading, JobControl, SessionBadge, useQuotes, livePosition,
  PositionCard,
} from '../ui.js';
import { t, isAr, tn } from '../i18n.js';

// Summary, Picks and Track record read /today; before the first scan they explain how to get one.
export function useToday(title) {
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
      ${m.warnings.map(w => html`<${Callout} tone="warn">${tn(w)}<//>`)}</div>`}
    ${data.orders && html`<${OrdersCard} o=${data.orders} />`}
    ${data.positions.length > 0 && html`<${Positions} positions=${data.positions} cfg=${data.cfg} alerts=${alerts} />`}`;
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
  if (data.mood) {
    lines.push(html`<a href="#/market">${t('Market mood: {label} ({score} of 100).',
      { label: t(data.mood.label), score: Math.round(data.mood.score) })}</a>`);
  }
  if (m.risk_off) lines.push(t(blocked ? 'Weak market: no new BUYs until EGX30 recovers.' : 'Weak market: only very strong BUYs, and fewer of them.'));
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
    ${data.buys.length > 0 && html`<a class="btn sm primary brief-go" href="#/signals">${t('See the picks')}
      <${Icon} name="chevron" size=${14} /></a>`}
  </div>`;
}

// Your positions as cards: what to do, the price and profit/loss (live during the session), stop to target.
function Positions({ positions, cfg, alerts }) {
  const q = useQuotes(positions.map(p => p.symbol));
  const list = positions.map(p => livePosition(p, q));
  const total = list.reduce((s, p) => s + p.pnl, 0);
  return html`<section class="section">
    <${SectionHead} title="Your open positions" count=${positions.length}
      hint=${html`${t(alerts ? (alerts === 1 ? '{n} needs your attention' : '{n} need your attention') : 'Nothing to do: all on hold', { n: alerts })}
${' '}· ${t('Total')} <b class=${tone(total)}>${fmt.signed(total)} ${t('EGP')}</b>`}>
      <a class="btn sm" href="#/portfolio">${t('Manage')} <${Icon} name="chevron" size=${14} /></a><//>
    <div class="pos-grid">${list.map(p => html`<${PositionCard} p=${p} key=${p.id}
      hold=${{ max: cfg.max_hold_days, review: cfg.review_day }} />`)}</div></section>`;
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


export const buyHref = (sym, price, shares) =>
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
      ${o.skipped.length > 0 && html`<span>${t('Not bought')}: ${o.skipped.map((x, i) => html`${i ? ', ' : ''}<b>${x.symbol}</b> (<span dir="auto">${tn(x.note)}</span>)`)}</span>`}
    </div>`}
  </div></section>`;
}
