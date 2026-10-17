// A rights issue's rights on the Stocks page (#/stock/KORA_r1), like your broker's KORA_r1 page, in pictures: the
// price, where it stands on its timeline, its chart (TradingView's EGX:KORAR1, empty until the rights trade), what one
// share was worth before and after, your three choices, what comes after the subscription, and what past rights
// issues did. Facts only, never which choice to make. The issue: views.rights_list; your rights: /portfolio.
import { html, useApi, useStore, useState, fmt, cls, go, stockHref } from '../lib.js';
import { PageLoading, PageHead, Callout, More, StockAvatar, useQuotes, sessionState, Empty, Icon, DataTable, Seg } from '../ui.js';
import { t } from '../i18n.js';
import { LineChart } from '../charts.js';

// Where the issue stands on a Cairo day: [label, chip tone], from its milestones (news.KNOWN_ACTIONS schedule).
function stage(sched, day) {
  const at = what => (sched.find(s => s[2] === what) || [])[0];
  if (day < at('Rights trading starts')) return ['Not trading yet', 'nodata'];
  if (day <= at('Rights trading ends')) return ['Rights trading', 'hold'];
  if (day <= at('Round 1 ends')) return ['Subscription only', 'review'];
  if (day <= at('Subscription closes')) return ['Round 2', 'review'];
  return ['Waiting for the new shares', 'nodata'];
}

const CHECK = { better: ['Better odds', 'hold'], weaker: ['Weaker odds', 'review'] };
const pastHref = p => `${stockHref(`${p.symbol}_r1`)}?ex=${p.ex}`;

// #/stock/KORA_r1: the rights issue going on now; #/stock/SVCE_r1?ex=2026-04-23: a past one (PastRights).
export function RightsPage({ base, ex }) {
  const issues = useStore(s => s.rights);
  if (ex && issues && !issues.some(x => x.base === base && x.ex_date === ex)) return html`<${PastRights} base=${base} ex=${ex} />`;
  return html`<${CurrentRights} base=${base} />`;
}

function CurrentRights({ base }) {
  const issues = useStore(s => s.rights);
  const { data: study } = useApi('/rights/history');
  const stocks = useStore(s => s.stocks);
  const { data: pf } = useApi('/portfolio');
  const { data: div } = useApi('/dividends');
  const q = useQuotes([base, `${base}R1`]);
  if (!issues) return html`<${PageLoading} />`;
  const is = issues.find(x => x.base === base);
  if (!is) {
    return html`<${Empty} title="No rights here" text=${t('{sym} has no rights issue going on now.', { sym: base })}
      action=${html`<a class="btn" href=${stockHref(base)}>${base}</a>`} />`;
  }
  const day = sessionState().day, sched = is.schedule;
  const at = what => (sched.find(s => s[2] === what) || [])[0];
  const live = q[`${base}R1`];
  const price = live ? live.price : is.ref;
  const sharePrice = (q[base] && q[base].price) ?? ((stocks || []).find(s => s.symbol === base) || {}).close;
  const pos = pf && pf.positions.find(p => p.symbol === base && p.rights);
  const [label, tone] = stage(sched, day);
  return html`
    <article class="card">
      <div class="pos-head"><${StockAvatar} symbol=${base} size=${40} />
        <div class="pos-who"><span class="sym-big" style="font-size:24px">${is.symbol}</span>
          <div class="faint pos-sub" dir="auto">${is.name_ar || base}</div></div>
        <span class=${cls('chip', tone)}><span class="dot"></span>${t(label)}</span></div>
      <div class="rt-prices">
        <div><div class="k">${t(live ? 'Last trade price' : 'Price')}</div><div class="v">${fmt.price(price)}</div>
          <div class="s">${live ? html`<span class=${live.change >= 0 ? 'up' : 'down'}>${fmt.pct(live.change)}</span>` : t('not traded yet')}</div></div>
        <div><div class="k">${t('Subscription price')}</div><div class="v">${fmt.price(is.price)}</div>
          <div class="s">${t('per 1 right')}</div></div>
        ${pos && html`<div><div class="k">${t('Your rights')}</div><div class="v">${fmt.int(pos.rights.units)}</div>
          <div class="s">${fmt.int(pos.rights.units * price)} ${t('EGP')}</div></div>`}
      </div>
      <a class="btn sm ghost" href=${stockHref(base)}>${t('{sym} stock page', { sym: base })}<${Icon} name="chevron" size=${14} /></a>
    </article>

    <${Timeline} sched=${sched} day=${day} />

    <${TradingChart} is=${is} day=${day} live=${live} share=${q[base]} />

    <${ShareValue} is=${is} day=${day} sharePrice=${sharePrice} price=${price} base=${base} />
    ${study && html`<${CheckCard} study=${study} row=${study.past.find(p => p.symbol === base && p.ex === is.ex_date)} />`}
    ${study && study.stages && html`<${StagesCard} study=${study} mine=${(study.past.find(p => p.symbol === base && p.ex === is.ex_date) || {}).last5} />`}
    <${Choices} is=${is} pos=${pos} price=${price} at=${at} />
    <${AfterSub} base=${base} r=${is.symbol} />
    ${div && div.rights_history && div.rights_history.run_up && html`<${History} h=${div.rights_history} />`}
    <${Callout}>${t("Facts, not advice. Check the dates and price in your broker's app before you act.")}<//>`;
}

const month = d => fmt.date(d, false).replace(/^\d+\s*/, '');   // "Oct" / "أكتوبر"

// The rights' own chart over their whole trading period, laid out ahead (days still to come stay blank): each day's
// last trade (rights_prices, today's live price while trading) against what a right is worth if you subscribe with it,
// the share's price less the subscription price.
function TradingChart({ is, day, live, share }) {
  const tr = is.trading || {};
  if (!tr.days || !tr.days.length) return null;
  const byDay = (rows, f) => Object.fromEntries(rows.map(r => [r.date, f(r)]));
  const rights = byDay(tr.bars, r => r.close), worth = byDay(tr.share, r => r.close - is.price);
  if (tr.days.includes(day) && sessionState().state !== 'pre') {      // today, before its close is saved
    if (live && rights[day] == null) rights[day] = live.price;
    if (share && worth[day] == null) worth[day] = share.price - is.price;
  }
  const line = m => tr.days.map(d => (m[d] == null ? { time: d } : { time: d, value: +m[d].toFixed(3) }));
  const any = Object.keys(rights).length > 0;
  const lines = [{ data: line(rights), color: '--accent', title: is.symbol },
    { data: line(worth), color: '--warn', title: t('Worth if you subscribe'), dashed: true, width: 1.5 },
    { data: tr.days.map(d => ({ time: d, value: is.ref })), hidden: true }];    // the whole period on the axis
  return html`<article class="card"><div class="card-title">${t('{r} over its trading period', { r: is.symbol })}
      <span class="faint right s">${fmt.date(tr.days[0], false)} – ${fmt.date(tr.days.at(-1), false)}</span></div>
    ${any ? html`<${LineChart} lines=${lines} height=${280} format="price" key=${Object.keys(rights).length} />`
      : html`<div class="rt-days">${tr.days.map(d => html`<div><b>${+d.slice(8)}</b><span>${month(d)}</span></div>`)}</div>
        <p class="faint s" style="margin:8px 0 0">${t('Fills in day by day from {date}, when the rights start trading.', { date: fmt.date(tr.days[0], false) })}</p>`}
    <p class="faint s" style="margin:8px 0 0">${t('When the blue line is under the dashed one, the rights sell for less than they are worth if you subscribe (the share price less {p}).', { p: fmt.price(is.price) })}</p>
  </article>`;
}

// The milestones as a line of dots: done ones filled, the next one ringed, then the full list with what happened.
function Timeline({ sched, day }) {
  const next = sched.findIndex(s => s[0] > day);
  return html`<article class="card"><div class="card-title">${t('Timeline')}</div>
    <div class="rt-track">${sched.map(([d, , what], i) => html`<div class=${cls('rt-step', d <= day && 'done', i === next && 'next')}
      title=${t(what)}><span class="rt-dot"></span><span class="rt-date">${+d.slice(8)}</span>
      <span class="rt-month">${(!i || d.slice(5, 7) !== sched[i - 1][0].slice(5, 7)) ? month(d) : ''}</span></div>`)}</div>
    ${next >= 0 && html`<div class="rt-next"><${Icon} name="calendar" size=${16} />
      <span>${t('Next')}: <b>${t(sched[next][2])}</b> · ${fmt.date(sched[next][0], false)}${sched[next][1] && ` · ${sched[next][1]}`}</span></div>`}
    <${More} label="All dates">
      <ol class="steps">${sched.map(([d, time, what, happened]) => html`<li class=${cls(d <= day && 'done')}><div>
        <b>${t(what)}</b> <span class="faint">${fmt.date(d, false)}${time && ` · ${time}`}</span>
        ${happened && d <= day && html`<div>${t(happened)}</div>`}</div></li>`)}</ol>
      <p class="faint s">${t('Thndr takes subscriptions until one working day before the bank. The subscription can close early if every new share is taken.')}</p><//>
  </article>`;
}

// What one share held before the ex-date was worth: the share alone before, the share plus its rights after.
function ShareValue({ is, day, sharePrice, price, base }) {
  const rows = is.schedule.filter(s => s[4] != null && s[0] <= day).map(s => ({
    label: fmt.date(s[0], false), share: s[4], rights: s[0] >= is.ex_date ? is.ratio * is.ref : 0 }));
  if (sharePrice != null) rows.push({ label: t('Now'), share: sharePrice, rights: is.ratio * price });
  const max = Math.max(...rows.map(r => r.share + r.rights));
  return html`<article class="card"><div class="card-title">${t('What one {sym} share is worth', { sym: base })}</div>
    <div class="rt-bars">${rows.map(r => html`<div class="rt-bar-row"><span class="rt-bar-l">${r.label}</span>
      <div class="rt-bar"><span class="seg share" style=${`width:${(r.share / max) * 100}%`}></span>
        ${r.rights > 0 && html`<span class="seg rights" style=${`width:${(r.rights / max) * 100}%`}></span>`}</div>
      <span class="rt-bar-v">${fmt.num(r.share + r.rights)}</span></div>`)}</div>
    <div class="rt-legend"><span><i class="seg share"></i>${t('the share')}</span><span><i class="seg rights"></i>${t('its {r} rights', { r: is.ratio })}</span></div>
    <p class="s" style="margin:8px 0 0">${t('On {date} each share split into a cheaper share plus {r} rights. Count both: nothing was lost that day.', { date: fmt.date(is.ex_date, false), r: is.ratio })}</p>
  </article>`;
}

// Sell, subscribe or do nothing, with your own numbers when you hold the rights (per right otherwise).
function Choices({ is, pos, price, at }) {
  const n = pos ? pos.rights.units : 1;
  const money = v => (pos ? `${fmt.int(v)} ${t('EGP')}` : fmt.price(v));
  const after = pos && (pos.avg_price * pos.shares + n * is.price) / (pos.shares + n);
  const card = (icon, tone, title, big, lines) => html`<div class=${cls('rt-choice', `c-${tone}`)}>
    <div class="rt-ic"><${Icon} name=${icon} size=${20} /></div><b>${t(title)}</b>
    <div class="rt-big">${big}</div>${lines.map(l => html`<div class="s">${l}</div>`)}</div>`;
  return html`<article class="card"><div class="card-title">${t(pos ? 'Your 3 choices' : 'Your 3 choices, for each right')}</div>
    <div class="grid grid-3">
      ${card('sell', 'up', 'Sell the rights', `+${money(n * price)}`,
        [t('You get cash.'), t('Until {date}', { date: fmt.date(at('Rights trading ends'), false) })])}
      ${card('plus', 'info', 'Subscribe', `−${money(n * is.price)}`,
        [pos ? t('You get {n} new shares: {total} in all, average {avg}.', { n: fmt.int(n), total: fmt.int(pos.shares + n), avg: fmt.price(after) })
          : t('You get 1 new share.'), t('Thndr: until {date}', { date: fmt.date(at('Last day to subscribe on Thndr'), false) })])}
      ${card('xCircle', 'down', 'Do nothing', `−${money(n * price)}`, [t('The rights expire and that value is lost.')])}
    </div>
    <p class="faint s" style="margin:10px 0 0">${t('You can mix: sell some rights and subscribe with the rest. Thndr charges 60 EGP to subscribe (free on Thndr Trader), and your national ID must stay valid until 45 days after the subscription ends.')}</p>
  </article>`;
}

// What happens after the subscription, as four steps.
function AfterSub({ base, r }) {
  const steps = [['users', 'Round 2', 'Leftover shares are shared out among those who asked'],
    ['shield', 'Approval', 'The company and the regulator (FRA) sign off'],
    ['calendar', 'New shares listed', '1 to 3 months after'],
    ['briefcase', 'In your account', '{r} becomes {sym} shares you can sell']];
  return html`<article class="card"><div class="card-title">${t('After the subscription')}</div>
    <div class="rt-flow">${steps.map(([ic, title, sub]) => html`<div class="rt-flow-step">
      <div class="rt-ic"><${Icon} name=${ic} size=${18} /></div><b>${t(title)}</b><div class="s faint">${t(sub, { r, sym: base })}</div></div>`)}</div>
    <ul class="reasons" style="margin-top:12px">
      <li>${t("Until then the new shares can't be sold.")}</li>
      <li>${t('Your {sym} shares stay the same. Subscribe to all your rights and you keep your share of the company; if not, it gets smaller.', { sym: base })}</li>
      <li>${t('Once the new shares are listed, more {sym} shares can be sold.', { sym: base })}</li>
    </ul>
  </article>`;
}

// How often the shares rose at each stage of past rights issues (corporate.rights_history), against a 50% line.
function History({ h }) {
  const rows = [['Announcement → last day with the rights', h.run_up], ['The day the rights split off', h.ex_day],
    ['While the rights trade', h.trading], ['After the subscription', h.after_sub]];
  return html`<article class="card"><div class="card-title">${t('How often the shares rose in {n} past rights issues', { n: h.n })}</div>
    <div class="rt-bars">${rows.map(([label, x]) => html`<div class="rt-hist">
      <div class="rt-hist-l">${t(label)} <span class="faint">(${t('typically {v}', { v: fmt.pct(x.median, 1) })})</span></div>
      <div class="rt-bar half"><span class=${cls('seg', x.up >= 0.5 ? 'share' : 'low')} style=${`width:${x.up * 100}%`}></span></div>
      <span class="rt-bar-v">${fmt.pct(x.up, 0, false)}</span></div>`)}</div>
    <p class="faint s" style="margin:8px 0 0">${t('EGX, since {year}. The line is 50%: a coin flip. The rights are counted at their worth. Not a forecast.', { year: h.since })}</p>
  </article>`;
}

// ------------------------------------------------------------------ the rights check (corporate.rights_study)
// Which group of past rights issues this one falls in, by its last week with the rights, and how that group did.
function CheckCard({ study, row }) {
  if (!row || !row.check) return null;
  const g = study.checks[row.check], [label, tone] = CHECK[row.check];
  return html`<article class="card"><div class="card-title">${t('What past rights issues say')}
    <span class=${cls('chip', tone, 'right')}><span class="dot"></span>${t(label)}</span></div>
    <p class="s" style="margin:0 0 10px">${t(row.check === 'better'
      ? 'In its last week with the rights the share fell {v}. Past issues that fell or stayed flat then:'
      : 'In its last week with the rights the share rose {v}. Past issues that rose then:', { v: fmt.pct(Math.abs(row.last5), 0, false) })}</p>
    <${GroupStats} g=${g} />
    <a class="btn sm ghost" href="#/rights" style="margin-top:10px">${t('All rights issues and how the check works')}<${Icon} name="chevron" size=${14} /></a>
  </article>`;
}

// What the share did after its last week with the rights, by how it moved that week (corporate.rights_study
// stages): a grid, green where it mostly rose, red where it mostly fell. `mine`: the row this issue falls in.
const STAGE_COLS = [['ex_day', 'Split day'], ['trade_weeks', 'While the rights trade'], ['after_trade', 'Then, to 3 months']];
export function StagesCard({ study, mine }) {
  const row = mine == null ? null : mine <= -0.10 ? 0 : mine <= 0 ? 1 : 2;
  const tint = v => (v >= 0.6 ? 'good' : v <= 0.4 ? 'bad' : '');
  return html`<article class="card"><div class="card-title">${t('After the last week with the rights: what the share did next')}</div>
    <div class="rt-grid">
      <div></div>${STAGE_COLS.map(([, l]) => html`<div class="rt-grid-h">${t(l)}</div>`)}
      ${study.stages.map((g, i) => html`<div class=${cls('rt-grid-l', i === row && 'mine')}><b>${t(g.label)}</b>
          <span class="faint">${t('{n} issues', { n: g.n })}${i === row ? ` · ${t('this one')}` : ''}</span></div>
        ${STAGE_COLS.map(([k]) => (g[k] ? html`<div class=${cls('rt-cell', tint(g[k].up), i === row && 'mine')}>
          <b>${fmt.pct(g[k].up, 0, false)}</b><span>${t('rose')}</span><span>${t('typ. {v}', { v: fmt.pct(g[k].median, 1) })}</span></div>`
          : html`<div class="rt-cell">–</div>`))}`)}
    </div>
    <p class="faint s" style="margin:10px 0 0">${t('The split day counts the rights at their worth. The rights follow the share: a right is worth about the share price less the subscription price, so it rises and falls with it, by a bit more in %. The rights\u2019 own past prices are gone, so they can\u2019t be measured directly. Few issues fell 10% or more: treat it as a hint.')}</p>
  </article>`;
}

// A group's three numbers as tiles: beat EGX30, typical lead over it, the worst 1 in 10.
function GroupStats({ g }) {
  return html`<div class="rt-prices" style="margin:0">
    <div><div class="k">${t('Beat EGX30')}</div><div class=${cls('v', g.beat >= 0.6 ? 'up' : '')}>${fmt.pct(g.beat, 0, false)}</div>
      <div class="s">${t('of {n} issues, in 3 months', { n: g.n })}</div></div>
    <div><div class="k">${t('Typically')}</div><div class="v">${fmt.pct(g.median, 1)}</div><div class="s">${t('vs EGX30')}</div></div>
    <div><div class="k">${t('1 in 10 lost')}</div><div class="v down">${fmt.pct(-g.p10, 0, false)}</div><div class="s">${t('or more, in 3 months')}</div></div>
  </div>`;
}

// #/rights: the check, what it rests on, the rights issues coming up and every past one.
export function RightsListPage() {
  const { data, error } = useApi('/rights/history');
  const [show, setShow] = useState('all');
  if (!data) return html`<${PageHead} title="Rights issues" /><${PageLoading} error=${error} />`;
  const past = data.past.filter(p => show === 'all' || p.check === show);
  const columns = [
    { key: 'symbol', label: 'Stock', render: p => html`<div><b>${p.symbol}_r1</b><div class="faint s">${fmt.date(p.ex)}</div></div>` },
    { key: 'last5', label: 'Last week', align: 'r', render: p => html`<span class=${p.last5 > 0 ? 'up' : 'down'}>${fmt.pct(p.last5, 1)}</span>` },
    { key: 'check', label: 'Check', render: p => p.check && html`<span class=${cls('chip', CHECK[p.check][1])}><span class="dot"></span>${t(CHECK[p.check][0])}</span>` },
    { key: 'quarter', label: '3 months', align: 'r', render: p => p.quarter == null ? html`<span class="faint">${t('not yet')}</span>`
      : html`<span class=${p.quarter >= 0 ? 'up' : 'down'}>${fmt.pct(p.quarter, 0)}</span><div class="faint s">EGX30 ${fmt.pct(p.egx30_quarter, 0)}</div>` },
  ];
  return html`
    <${PageHead} title="Rights issues" sub=${t('Every EGX rights issue since {year}, and a check for the ones coming up', { year: data.since })} />
    <article class="card"><div class="card-title">${t('The check: the share’s last week with the rights')}</div>
      <div class="grid grid-2">
        ${['better', 'weaker'].map(c => html`<div class=${cls('rt-choice', c === 'better' ? 'c-up' : 'c-down')}>
          <div class="rt-ic"><${Icon} name=${c === 'better' ? 'checkCircle' : 'alert'} size=${20} /></div>
          <b>${t(c === 'better' ? 'Fell or stayed flat' : 'Rose')}</b><span class=${cls('chip', CHECK[c][1])} style="align-self:flex-start"><span class="dot"></span>${t(CHECK[c][0])}</span>
          <${GroupStats} g=${data.checks[c]} /></div>`)}
      </div>
      <p class="faint s" style="margin:10px 0 0">${t('Bought at the close of the last day with the rights and subscribed, held 3 months. Picked on the years before 2022 and still there after, though smaller. Facts from the past, not a promise.')}</p>
    </article>

    ${data.stages && html`<${StagesCard} study=${data} />`}
    <article class="card"><div class="card-title">${t('When to buy: how often it beat EGX30 in 3 months')}</div>
      <div class="rt-bars">${data.entries.map((e, i) => html`<div class="rt-hist">
        <div class="rt-hist-l">${t(e.label)} <span class="faint">(${t('typically {v}', { v: fmt.pct(e.median, 1) })})</span></div>
        <div class="rt-bar half"><span class=${cls('seg', i === 1 ? 'share' : 'low')} style=${`width:${e.beat * 100}%`}></span></div>
        <span class="rt-bar-v">${fmt.pct(e.beat, 0, false)}</span></div>`)}</div>
    </article>

    <article class="card"><div class="card-title">${t('What we checked')}</div>
      <p class="faint s" style="margin:0 0 10px">${t('How often the issues beat EGX30, splitting them in half by each thing on the last day. Only the first one made a real difference.')}</p>
      <div class="rt-bars">${data.factors.map((f, i) => html`<div class=${cls('rt-factor', i === 0 && 'key')}>
        <div class="rt-hist-l"><b>${t(f.label)}</b>${i === 0 && html` <span class="chip hold"><span class="dot"></span>${t('this one')}</span>`}</div>
        ${[['lower half', f.lo], ['higher half', f.hi]].map(([k, v]) => html`<div class="rt-hist">
          <div class="rt-bar half"><span class=${cls('seg', i ? 'muted' : v >= 0.6 ? 'share' : 'low')} style=${`width:${v * 100}%`}></span></div>
          <span class="rt-bar-v">${fmt.pct(v, 0, false)}</span><div class="faint s rt-half">${t(k)}</div></div>`)}</div>`)}</div>
      <p class="faint s" style="margin:8px 0 0">${t('The line is 50%: a coin flip. The size of the discount isn’t in the past data, so it isn’t checked.')}</p>
    </article>

    <section class="section"><h2 class="rt-h2">${t('Coming up')}</h2>
      ${data.coming.length ? html`<div class="grid grid-2">${data.coming.map(p => html`<article class="card">
        <div class="pos-head"><${StockAvatar} symbol=${p.symbol} size=${36} /><div class="pos-who"><a class="sym-big" href=${stockHref(p.symbol)}>${p.symbol}</a>
          <div class="faint pos-sub">${t('Last day with the rights: {date}', { date: fmt.date(p.last_day) })}</div></div>
          ${p.check && html`<span class=${cls('chip', CHECK[p.check][1])}><span class="dot"></span>${t(CHECK[p.check][0])}</span>`}</div>
        <p class="s" style="margin:8px 0 0">${t('Its last 5 sessions so far: {v}. The check is final at the close of {date}.', { v: fmt.pct(p.last5, 1), date: fmt.date(p.last_day, false) })}</p>
      </article>`)}</div>` : html`<div class="card"><p class="faint s" style="margin:0">${t('No rights issue is announced right now. One shows here as soon as it is.')}</p></div>`}
    </section>

    <section class="section"><div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
      <h2 class="rt-h2" style="margin:0">${t('Past rights issues')} <span class="pill-count">${data.past.length}</span></h2>
      <${Seg} options=${[{ value: 'all', label: 'All' }, { value: 'better', label: 'Better odds' }, { value: 'weaker', label: 'Weaker odds' }]} value=${show} onChange=${setShow} /></div>
      <div class="card flush"><${DataTable} columns=${columns} rows=${past} rowKey=${p => `${p.symbol}${p.ex}`} limit=${15}
        onRowClick=${p => go(pastHref(p))} /></div>
      <p class="faint s">${t('Tap one to see it like KORA_r1.')}</p>
    </section>
    <${Callout}>${t("Facts, not advice. Check the dates and price in your broker's app before you act.")}<//>`;
}

// #/stock/SVCE_r1?ex=2026-04-23: a past rights issue, like KORA_r1's page: its check, its timeline, and its share
// against EGX30 from the last day with the rights (100) for three months.
function PastRights({ base, ex }) {
  const { data, error } = useApi('/rights/history');
  if (!data) return html`<${PageLoading} error=${error} />`;
  const p = data.past.find(x => x.symbol === base && x.ex === ex);
  if (!p) return html`<${Empty} title="No rights here" text=${t('{sym} has no rights issue on {date} in the list.', { sym: base, date: fmt.date(ex) })}
    action=${html`<a class="btn" href="#/rights">${t('Rights issues')}</a>`} />`;
  const d = p.path.date, at = d.indexOf(ex), last = at - 1;
  const steps = [[p.announced, 'Announced'], [d[last], 'Last day with the rights'], [ex, 'Rights split off the shares'],
    [d[at + 10], 'Two weeks later'], [d[at + 60], 'Three months later']].filter(x => x[0]);
  const lines = [{ data: d.map((x, i) => ({ time: x, value: p.path.stock[i] })), color: '--accent', title: `${base}` },
    { data: d.map((x, i) => ({ time: x, value: p.path.egx30[i] })), color: '--text-3', title: 'EGX30', dashed: true, width: 1.5 }];
  const tile = (k, v, sub) => html`<div><div class="k">${t(k)}</div><div class=${cls('v', v == null ? '' : v >= 0 ? 'up' : 'down')}>${v == null ? '–' : fmt.pct(v, 0)}</div>
    <div class="s">${sub || ''}</div></div>`;
  return html`
    <article class="card">
      <div class="pos-head"><${StockAvatar} symbol=${base} size=${40} />
        <div class="pos-who"><span class="sym-big" style="font-size:24px">${base}_r1</span>
          <div class="faint pos-sub">${t('Rights issue of {date}', { date: fmt.date(ex) })}</div></div>
        ${p.check && html`<span class=${cls('chip', CHECK[p.check][1])}><span class="dot"></span>${t(CHECK[p.check][0])}</span>`}</div>
      <div class="rt-prices">
        ${tile('Last week', p.last5, t('before the last day'))}${tile('The ex-date', p.ex_day)}
        ${tile('2 weeks', p.two_weeks)}${tile('3 months', p.quarter, p.egx30_quarter != null ? `EGX30 ${fmt.pct(p.egx30_quarter, 0)}` : '')}
      </div>
      <div class="row" style="gap:8px"><a class="btn sm ghost" href=${stockHref(base)}>${t('{sym} stock page', { sym: base })}</a>
        <a class="btn sm ghost" href="#/rights">${t('All rights issues')}</a></div>
    </article>
    <article class="card"><div class="card-title">${t('Timeline')}</div>
      <ol class="steps">${steps.map(([day, what]) => html`<li class="done"><div><b>${t(what)}</b> <span class="faint">${fmt.date(day)}</span></div></li>`)}</ol></article>
    ${p.rights && p.rights.length > 0 && html`<article class="card"><div class="card-title">${t('{r} over its trading period', { r: `${base}_r1` })}</div>
      <${LineChart} lines=${[{ data: p.rights.map(r => ({ time: r.date, value: r.close })), color: '--accent', title: `${base}_r1` }]} height=${240} format="price" /></article>`}
    ${!(p.rights && p.rights.length) && p.trade && p.trade.length > 1 && html`<article class="card">
      <div class="card-title">${t('{sym} while its rights traded', { sym: base })}<span class="faint right s">${fmt.date(p.trade[0].date, false)} – ${fmt.date(p.trade.at(-1).date, false)}</span></div>
      <${LineChart} lines=${[{ data: p.trade.map(r => ({ time: r.date, value: r.close })), color: '--accent', title: base }]} height=${240} format="price" />
      <p class="faint s" style="margin:8px 0 0">${t('The share from the split day for about the 10 sessions its rights traded (the exact dates aren\u2019t in the data). The rights\u2019 own prices are gone; a right is worth about the share price less the subscription price, so they moved with it.')}</p></article>`}
    ${data.stages && html`<${StagesCard} study=${data} mine=${p.last5} />`}
    <article class="card"><div class="card-title">${t('{sym} and EGX30, 100 = the last day with the rights', { sym: base })}</div>
      <${LineChart} lines=${lines} height=${300} format="num" />
      <p class="faint s" style="margin:8px 0 0">${t(p.rights && p.rights.length ? 'Counting the rights at their worth (a holder who subscribed).' : 'Counting the rights at their worth (a holder who subscribed). The rights’ own prices from back then are gone: TradingView drops them when an issue ends. Since October 2026 the site keeps them.')}</p></article>
    <${Callout}>${t("Facts, not advice. Check the dates and price in your broker's app before you act.")}<//>`;
}
