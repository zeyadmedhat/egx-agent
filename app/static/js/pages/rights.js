// A rights issue's own page (#/rights/KORA), like your broker's KORA_r1 page: the rights' price and the subscription
// price, where it stands, its milestones, your rights and what each choice means for them, a guide to what happens
// next, and what EGX stocks did at each stage of past rights issues. Facts only, never which choice to make.
import { html, useApi, fmt, cls } from '../lib.js';
import { PageHead, PageLoading, Callout, More, StockAvatar, useQuotes, sessionState, Empty } from '../ui.js';
import { t } from '../i18n.js';

// Where the issue stands on a Cairo day, from its milestones (corporate.rights_terms schedule).
function stage(sched, day) {
  const at = what => (sched.find(s => s[2].startsWith(what)) || [])[0];
  const open = at('Rights start'), stop = at('Rights stop'), first = at('First round'), end = at('Subscription closes');
  if (!open || day < open) return ['Not trading yet', 'nodata'];
  if (day <= stop) return ['Rights trading', 'hold'];
  if (day <= first) return ['Subscription only', 'review'];
  if (end && day <= end) return ['Second round', 'review'];
  return ['Subscription closed', 'nodata'];
}

export function RightsPage({ route }) {
  const sym = (route.arg || '').toUpperCase();
  const { data, error } = useApi('/portfolio');
  const { data: div } = useApi('/dividends');
  const q = useQuotes(sym ? [sym, `${sym}R1`] : []);
  if (!data) return html`<${PageHead} title=${`${sym}_r1`} /><${PageLoading} error=${error} />`;
  const p = data.positions.find(x => x.symbol === sym && x.rights);
  if (!p) {
    return html`<${PageHead} title=${`${sym}_r1`} /><${Empty} title="No rights here"
      text=${t("You don't hold rights in {sym}, or you've already recorded what you did with them.", { sym })}
      action=${html`<a class="btn" href="#/portfolio">${t('Portfolio')}</a>`} />`;
  }
  const r = p.rights, day = sessionState().day, sched = r.schedule || [];
  const live = q[`${sym}R1`], price = live ? live.price : r.price;
  const [label, tone] = stage(sched, day);
  const sub = r.units * r.sub_price, total = p.shares + r.units;
  const avgAll = (p.avg_price * p.shares + sub) / total;
  const sharePrice = (q[sym] && q[sym].price) || p.last;
  const g = v => fmt.price(v);
  return html`
    <${PageHead} title=${r.symbol} sub=${t('{sym} rights issue', { sym })}>
      <a class="btn sm ghost" href="#/portfolio">${t('Portfolio')}</a><//>

    <article class="card">
      <div class="pos-head"><${StockAvatar} symbol=${sym} size=${40} />
        <div class="pos-who"><span class="sym-big">${r.symbol}</span>
          <div class="faint pos-sub" dir="auto">${(p.info && p.info.name_ar) || sym}</div></div>
        <span class=${cls('chip', tone)}><span class="dot"></span>${t(label)}</span></div>
      <div class="kpis" style="margin-top:14px">
        <div class="kpi"><div class="k-label">${t(live ? 'Last trade price' : 'Price')}</div>
          <div class="k-value">${t('EGP')} ${g(price)}</div>
          <div class="k-sub">${live ? html`<span class=${live.change >= 0 ? 'up' : 'down'}>${fmt.pct(live.change)}</span>`
            : t('not traded yet')}</div></div>
        <div class="kpi"><div class="k-label">${t('Subscription price')}</div>
          <div class="k-value">${t('EGP')} ${g(r.sub_price)}</div><div class="k-sub">${t('per 1 right')}</div></div>
        <div class="kpi"><div class="k-label">${t('Your rights')}</div>
          <div class="k-value">${fmt.int(r.units)}</div>
          <div class="k-sub">${fmt.int(r.units * price)} ${t('EGP')}</div></div>
      </div>
      <p class="faint s">${t('{r} right for each of your {n} shares. Before the rights trade, the exchange sets their price at the ex-date open less the subscription price; once they trade, it is their last trade.', { r: r.ratio, n: fmt.int(p.shares) })}</p>
    </article>

    ${sched.length > 0 && html`<article class="card"><div class="card-title">${t('Rights milestones')}</div>
      <ol class="steps">${sched.map(([d, time, what, happened]) => html`<li class=${cls(d <= day && 'done')}><div>
        <b>${t(what)}</b><div class="faint">${fmt.date(d)}${time && ` · ${time}`}</div>
        ${happened && d <= day && html`<div>${t(happened)}</div>`}</div></li>`)}</ol>
      <p class="faint s">${t('Your broker may close earlier than the bank: Thndr takes subscriptions until one working day before. The subscription can also close early once every new share is taken.')}</p>
    </article>`}

    <article class="card"><div class="card-title">${t('Your three choices')}</div>
      <ul class="reasons">
        <li><b>${t('Sell the rights')}</b> · ${t('While they trade, you sell them like a stock and get their price in cash ({v} EGP for all {n} at {p}, before fees). Your {sym} shares stay as they are, but they become a smaller part of the company once the new shares are out.', { v: fmt.int(r.units * price), n: fmt.int(r.units), p: g(price), sym })}</li>
        <li><b>${t('Subscribe')}</b> · ${t("Pay {sp} for each right before your broker closes: {cost} EGP for all {n}. You then get {n} new {sym} shares, {total} in all, at an average of {avg} (now {now}). Thndr charges 60 EGP to subscribe unless you're on Thndr Trader, and your national ID must be valid for 45 more days. You can also split them: sell some rights and subscribe with the rest.", { sp: g(r.sub_price), cost: fmt.num(sub), n: fmt.int(r.units), sym, total: fmt.int(total), avg: g(avgAll), now: g(p.avg_price) })}</li>
        <li><b>${t('Do nothing')}</b> · ${t('The rights expire when the subscription closes and are worth nothing. The {sym} price already fell by their value on the ex-date, so that value is lost.', { sym })}</li>
      </ul>
      <p class="faint s">${t('Which one suits you depends on your own money and plans; this page only shows what each does.')}</p>
    </article>

    <article class="card"><div class="card-title">${t('What happens next')}</div>
      <ol class="steps">
        <li><div><b>${t('While the rights trade')}</b> ${t("They have their own symbol ({r} at your broker) and price, which moves with the share's: roughly the share price less the subscription price. Only Egyptians can trade them. Anyone who buys rights can subscribe with them too.", { r: r.symbol })}</div></li>
        <li><div><b>${t('After they stop trading')}</b> ${t("They can't be sold or moved any more, only used to subscribe until the first round ends.")}</div></li>
        <li><div><b>${t('Second round')}</b> ${t('New shares nobody subscribed to are offered again to those who still hold rights, with no limit per right. If more are asked for than are left, each gets a share in proportion, and the extra money comes back within about a week.')}</div></li>
        <li><div><b>${t('After the subscription closes')}</b> ${t("The company announces how much was taken, the regulator (FRA) approves, the new capital is registered, and EGX lists the new shares. This takes 1 to 3 months. Until then you see {r} and the money you paid, and the new shares can't be sold.", { r: r.symbol })}</div></li>
        <li><div><b>${t('When the new shares are listed')}</b> ${t('{r} disappears and the new shares join your {sym} shares under the same symbol, as ordinary shares you can sell. Record it here then (Portfolio → {sym} → record what you did with the rights) so the average, stop and profit stay right.', { r: r.symbol, sym })}</div></li>
      </ol>
      <${More} label=${t('What happens to {sym} itself', { sym })}>
        <ul class="reasons">
          <li>${t("Your shares don't change: same number, same symbol. Their price was already lowered on the ex-date to make room for the new shares (now {p}).", { p: g(sharePrice) })}</li>
          <li>${t('The company ends up with more shares. If you subscribe to all your rights you keep the same share of it; if not, your share shrinks.')}</li>
          <li>${t('Nothing changes the price by rule when the new shares are listed, but from then on their holders can sell them, which is more shares for sale on the same days.')}</li>
        </ul><//>
    </article>

    ${div && div.rights_history && div.rights_history.run_up && html`<${History} h=${div.rights_history} />`}
    <${Callout}>${t("Facts to help you decide, not advice. Check the dates and the price in your broker's app before you act.")}<//>`;
}

// What EGX stocks did at each stage of past rights issues (corporate.rights_history), re-based prices: a holder who
// subscribed (or sold the rights for what they were worth). Facts, not a forecast.
function History({ h }) {
  const p = v => fmt.pct(v, 0, false), r = v => fmt.pct(v, 1);
  return html`<article class="card"><div class="card-title">${t('What happened at each stage of {n} past rights issues on EGX (since {year})', { n: h.n, year: h.since })}</div>
    <ul class="reasons">
      <li><b>${t('From the announcement to the last day with the rights')}</b> · ${t('up {up} of the time, typically {median}, and ahead of EGX30 only {beat} of the time.', { up: p(h.run_up.up), median: r(h.run_up.median), beat: p(h.run_up.beat) })}</li>
      <li><b>${t('The ex-date')}</b> · ${t('counting the rights at their worth, up {up} of the time, typically {median}: the price is set from the last close, and the shares often rise from there.', { up: p(h.ex_day.up), median: r(h.ex_day.median) })}</li>
      <li><b>${t('The three weeks the rights trade and the subscription runs')}</b> · ${t('the shares were up only {up} of the time, typically {median}.', { up: p(h.trading.up), median: r(h.trading.median) })}</li>
      <li><b>${t('After the subscription, while the new shares wait to be listed (to three months after the ex-date)')}</b> · ${t('up {up} of the time, typically {median}, ahead of EGX30 {beat} of the time: a coin flip.', { up: p(h.after_sub.up), median: r(h.after_sub.median), beat: p(h.after_sub.beat) })}</li>
    </ul>
    <p class="faint s">${t('These count the rights at their worth: you get that only if you subscribe, or sell the rights while they trade (they can sell for less). Past rights issues, not a forecast for any one stock.')}</p>
  </article>`;
}
