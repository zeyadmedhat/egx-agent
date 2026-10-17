// A rights issue's rights on the Stocks page (#/stock/KORA_r1), like your broker's KORA_r1 page, in pictures: the
// price, where it stands on its timeline, its chart (TradingView's EGX:KORAR1, empty until the rights trade), what one
// share was worth before and after, your three choices, what comes after the subscription, and what past rights
// issues did. Facts only, never which choice to make. The issue: views.rights_list; your rights: /portfolio.
import { html, useApi, useStore, fmt, cls, stockHref } from '../lib.js';
import { PageLoading, Callout, More, StockAvatar, useQuotes, sessionState, Empty, Icon, LiveChart } from '../ui.js';
import { t } from '../i18n.js';

// Where the issue stands on a Cairo day: [label, chip tone], from its milestones (news.KNOWN_ACTIONS schedule).
function stage(sched, day) {
  const at = what => (sched.find(s => s[2] === what) || [])[0];
  if (day < at('Rights trading starts')) return ['Not trading yet', 'nodata'];
  if (day <= at('Rights trading ends')) return ['Rights trading', 'hold'];
  if (day <= at('Round 1 ends')) return ['Subscription only', 'review'];
  if (day <= at('Subscription closes')) return ['Round 2', 'review'];
  return ['Waiting for the new shares', 'nodata'];
}

export function RightsPage({ base }) {
  const issues = useStore(s => s.rights);
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

    <article class="card"><div class="card-title">${t('{r} chart', { r: is.symbol })}</div>
      ${day < at('Rights trading starts') && html`<p class="faint s" style="margin:0 0 8px">${t('Empty until the rights start trading on {date}.', { date: fmt.date(at('Rights trading starts'), false) })}</p>`}
      <${LiveChart} symbol=${`${base}R1`} height=${360} /></article>

    <${ShareValue} is=${is} day=${day} sharePrice=${sharePrice} price=${price} base=${base} />
    <${Choices} is=${is} pos=${pos} price=${price} at=${at} />
    <${AfterSub} base=${base} r=${is.symbol} />
    ${div && div.rights_history && div.rights_history.run_up && html`<${History} h=${div.rights_history} />`}
    <${Callout}>${t("Facts, not advice. Check the dates and price in your broker's app before you act.")}<//>`;
}

const month = d => fmt.date(d, false).replace(/^\d+\s*/, '');   // "Oct" / "أكتوبر"

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
  const card = (icon, tone, title, big, lines) => html`<div class=${cls('rt-choice', tone)}>
    <div class="rt-ic"><${Icon} name=${icon} size=${20} /></div><b>${t(title)}</b>
    <div class="rt-big">${big}</div>${lines.map(l => html`<div class="s">${l}</div>`)}</div>`;
  return html`<article class="card"><div class="card-title">${t(pos ? 'Your 3 choices' : 'Your 3 choices, for each right')}</div>
    <div class="grid grid-3">
      ${card('sell', 'up', 'Sell the rights', `+${money(n * price)}`,
        [t('You get cash.'), t('Until {date}', { date: fmt.date(at('Rights trading ends'), false) })])}
      ${card('plus', 'info', 'Subscribe', `−${money(n * is.price)}`,
        [pos ? t('You get {n} new shares: {total} in all, average {avg}.', { n: fmt.int(n), total: fmt.int(pos.shares + n), avg: fmt.price(after) })
          : t('You get 1 new share.'), t('Thndr: until {date}', { date: fmt.date(at('Round 1 ends'), false) })])}
      ${card('xCircle', 'down', 'Do nothing', `−${money(n * price)}`, [t('The rights expire and that value is lost.')])}
    </div>
    <p class="faint s" style="margin:10px 0 0">${t('You can mix: sell some rights and subscribe with the rest. Thndr charges 60 EGP to subscribe (free on Thndr Trader).')}</p>
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
