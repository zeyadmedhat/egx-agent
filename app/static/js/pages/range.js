// The stock page's "How far it could move" (app/views.py range_view, egx_agent/ranges.py): the range the close ended
// inside 8 times in 10 over the next week or month, drawn as a cone after the recent closes, the chance it trades at a
// price on the way, and how its past ranges held. It says how far, not which way.
import { html, useState, fmt, cls } from '../lib.js';
import { Seg, More, Icon } from '../ui.js';
import { t, isAr } from '../i18n.js';

const STEPS = [{ value: '5', label: 'Next week' }, { value: '20', label: 'Next month' }];
const RESET = { rights: 'rights issue', bonus: 'bonus shares', split: 'stock split', consolidation: 'share consolidation' };
const ret = (p, c) => p / c - 1;

// The chance it trades at `price` (or beyond it, away from the close) within the step: {p} between the ladder's
// prices (in between by distance), {over: cap} nearer than the capped chance, {under: 0.1} past the 1-in-10 price.
export function reachChance(step, close, price) {
  if (!step || !(price > 0) || !(close > 0) || price === close) return null;
  const pts = (price > close ? step.up : step.down).filter(([c]) => c <= step.cap);
  if (!pts.length) return null;
  const d = p => Math.abs(Math.log(p / close)), x = d(price);
  if (x <= d(pts[0][1])) return { over: pts[0][0] };
  for (let i = 1; i < pts.length; i++) {
    const [c0, p0] = pts[i - 1], [c1, p1] = pts[i];
    if (x <= d(p1)) return { p: c0 + (c1 - c0) * (x - d(p0)) / (d(p1) - d(p0)) };
  }
  return { under: pts[pts.length - 1][0] };
}

export const chanceText = r => (!r ? '–' : r.over != null ? t('over {p}', { p: fmt.pct(r.over, 0, false) })
  : r.under != null ? t('under {p}', { p: fmt.pct(r.under, 0, false) })
    : t('about {p}', { p: fmt.pct(Math.round(r.p * 20) / 20, 0, false) }));

// The card: a picture first (the recent closes, then the cone the price stayed inside 8 times in 10, with the stop,
// target and the AI models' middle guess on it), the two ranges in big numbers, then the chance of touching a price
// as bars. plan: {stop, target, mine} (your position's, else the BUY's, else the chart's); ai: the AI card's data;
// results: the next results date; cautions: the stock's "Good to know now".
export function PriceRange({ r, sym, series, plan, ai, results, cautions }) {
  const [k, setK] = useState(r.steps['5'] && !r.steps['5'].reset ? '5' : '20');   // a stock idle for a week has only its month left
  const [price, setPrice] = useState('');
  const c = r.close, s = r.steps[k];
  const typed = Number(price), pick = s && typed > 0 && !s.reset ? reachChance(s, c, typed) : null;
  const month = r.steps['20'], end = (month && month.target) || (s && s.target);
  const reset = Object.values(r.steps).find(x => x.reset);
  const ex = (cautions || []).find(x => x.kind === 'ex_dividend' && x.date > r.made && x.date <= end);
  const due = results && results > r.made && results <= end;
  const rec = r.steps['5'] || month, held = rec.record.n >= 30 ? rec.record.inside / rec.record.n : null;
  return html`<div class="card range-card">
    <div class="range-head">
      <div><h3>${t('How far {sym} could move', { sym })}</h3>
        <p class="faint">${t('How far, not which way. From the close of {date}: {price}.', { date: fmt.date(r.made, false), price: fmt.price(c) })}</p></div>
    </div>
    <${Cone} r=${r} series=${series} plan=${plan} ai=${ai} />
    <div class="rg-tiles">${STEPS.map(({ value: v, label }) => {
      const x = r.steps[v];
      if (!x) return null;
      return html`<div class=${cls('rg-tile', x.reset && 'paused')}>
        <span class="k-label">${t(label)} · ${t('by {date}', { date: fmt.date(x.target, false) })}</span>
        ${x.reset ? html`<b class="rg-paused">${t('Not shown')}</b><small class="warn">${t('{what} on {date}', { what: t(RESET[x.reset.kind]), date: fmt.date(x.reset.date, false) })}</small>`
          : html`<b><bdi>${fmt.price(x.lo)}</bdi> – <bdi>${fmt.price(x.hi)}</bdi></b>
            <small><bdi class="down">${fmt.pct(ret(x.lo, c), 0)}</bdi> ${t('to')} <bdi class="up">${fmt.pct(ret(x.hi, c), 0)}</bdi></small>`}
      </div>`;
    })}</div>
    <p class="rg-caption">${t('8 times in 10, the price ended inside these ranges.')}</p>
    <div class="rg-chips">
      ${held != null && html`<span class=${cls('rg-chip', held >= 0.7 ? 'ok' : 'warn')}><${Icon} name=${held >= 0.7 ? 'check' : 'alert'} size=${13} />
        ${t('{sym} ended inside {p} of its ranges last year', { sym, p: fmt.pct(held, 0, false) })}</span>`}
      ${due && html`<span class="rg-chip warn"><${Icon} name="alert" size=${13} />${t('Results expected around {date}: ranges with results inside held a little less often (77% vs 79%)', { date: fmt.date(results, false) })}</span>`}
      ${ex && html`<span class="rg-chip warn"><${Icon} name="alert" size=${13} />${t('Ex-dividend {date}: the price drops by the dividend that morning', { date: fmt.date(ex.date, false) })}</span>`}
    </div>
    ${reset && html`<p class="warn-text ai-reset">${t("Ex-date of the {what}: {date}, inside this window. That day the price is reset for the new shares, so a range in today's prices would be wrong. It comes back once the price history is re-based for them.",
      { what: t(RESET[reset.reset.kind]), date: fmt.date(reset.reset.date, false) })}</p>`}
    ${s && !s.reset && html`<div class="rg-touch">
      <div class="range-head"><h4>${t('Chance it touches a price on the way')}</h4><${Seg} options=${STEPS} value=${k} onChange=${setK} /></div>
      <${Ladder} s=${s} c=${c} plan=${plan} />
      <label class="range-check"><span>${t('Check a price')}</span>
        <input class="input" type="number" min="0" step="any" inputmode="decimal" placeholder=${fmt.price(c)}
          value=${price} onInput=${e => setPrice(e.target.value)} /></label>
      ${pick && html`<p class="range-answer">${t(typed > c ? 'The chance it trades at {price} or higher by {date}: {chance}.'
        : 'The chance it trades at {price} or lower by {date}: {chance}.', { date: fmt.date(s.target, false), price: fmt.price(typed), chance: chanceText(pick) })}</p>`}
    </div>`}
    <${More} label="How it's worked out and tested"><p>${t(HOW)}</p><p>${t(WHY)}</p><${Record} r=${r} sym=${sym} /><//>
  </div>`;
}

function Record({ r, sym }) {
  return STEPS.map(({ value: k, label }) => {
    const s = r.steps[k], all = r.all[k], test = r.tested.steps[k];
    const mine = s && s.record;
    return html`<p><b>${t(label)}.</b> ${mine && mine.n >= 30 ? t('{sym}, the last year: the close ended inside {a} of {n} ranges ({p}).', { sym, a: mine.inside, n: mine.n, p: fmt.pct(mine.inside / mine.n, 0, false) })
      : t('{sym}: too few of its ranges have finished to tell ({n}).', { sym, n: mine ? mine.n : 0 })}
      ${all && all.n > 0 ? ` ${t('Every stock, the last year: {p} of {n} ranges.', { p: fmt.pct(all.inside / all.n, 0, false), n: fmt.int(all.n) })}` : ''}
      ${' '}${t('Tested from {from} to {to} on every stock: {p} of {n} ranges, {g1} to {g2} in each group of similar stocks.', {
        from: fmt.month(r.tested.from), to: fmt.month(r.tested.to), p: fmt.pct(test.cover, 0, false), n: fmt.int(test.n),
        g1: fmt.pct(test.groups[0], 0, false), g2: fmt.pct(test.groups[1], 0, false) })}</p>`;
  });
}

const HOW = 'The swing is the stock\'s daily moves, the recent ones counting more. Every day, stocks are put in 9 '
  + 'groups by how much they trade and how jumpy they have been. In each group, the agent looks at how far the close '
  + 'really went, measured in swings, in the past year\'s ranges that have finished, and takes the 1-in-10 move down '
  + 'and the 1-in-10 move up. The chances of trading at a price come the same way, from how far the session highs and '
  + 'lows reached.';
const WHY = 'Which way a share goes next is close to a coin flip, even for the AI models. How far it swings is '
  + 'different: a share that has been swinging hard keeps swinging hard for a while. So this is the most honest '
  + 'forecast the agent can make. Results, news and a share going limit up or down can still take the price outside '
  + 'the range: those are the 2 times in 10.';

// The ladder as one column of prices, highest first, the close in the middle: each price with a bar as long as the
// chance it trades there (the capped chance, half, 3 in 10 and 1 in 10 each way; said more is less sure: tested chances
// above the cap ran high). Then the stop's and target's own chances in this window.
function Ladder({ s, c, plan }) {
  const side = (pts, dir) => {
    const seen = new Set();
    return pts.filter(([p]) => p === s.cap || p === 0.5 || p === 0.3 || p === 0.1)
      .map(([p, v]) => [p, Number(v.toFixed(v < 10 ? 3 : 2))])              // as fmt.price shows it
      .filter(([, v]) => v !== c && !seen.has(v) && seen.add(v)).map(([p, v]) => ({ p, v, dir }));
  };
  const rows = [...side(s.up, 'up').reverse(), { now: true, v: c }, ...side(s.down, 'down')];
  return html`<div class="rg-ladder" role="list">${rows.map(x => x.now
    ? html`<div class="rg-row now" role="listitem"><b>${fmt.price(c)}</b><span class="rg-now">${t('Last close')}</span></div>`
    : html`<div class=${cls('rg-row', x.dir)} role="listitem">
        <b>${fmt.price(x.v)}</b><small><bdi>${fmt.pct(ret(x.v, c), 0)}</bdi></small>
        <span class="rg-bar"><i style=${`width:${Math.round(x.p * 100)}%`}></i></span>
        <span class="rg-p">${x.p === s.cap ? t('over {p}', { p: fmt.pct(x.p, 0, false) }) : fmt.pct(x.p, 0, false)}</span>
      </div>`)}
    ${plan && html`<p class="rg-plan faint"><span>${t('By {date}:', { date: fmt.date(s.target, false) })}</span>${[['target', plan.target, 'up'], ['stop', plan.stop, 'down']].filter(([, v]) => v > 0)
      .map(([what, v, tone_]) => {
        const ch = reachChance(s, c, v);
        return ch && html`<span><b class=${tone_}>${t(plan.mine ? (what === 'stop' ? 'Your stop' : 'Your target') : (what === 'stop' ? 'Stop' : 'Target'))} ${fmt.price(v)}</b> ${chanceText(ch)}</span>`;
      })}</p>`}
  </div>`;
}

// The picture: the last 40 closes, then the cone the close stayed inside 8 times in 10, out to the week's and the
// month's ends (drawn between them by √time, as swings grow), the stop and target as lines with their month chance,
// and the AI models' middle guess as a diamond when it's from the same close.
const ok = x => x && !x.reset;
const iso = s => (isAr() ? `\u2067${s}\u2069` : s);    // Arabic words in the left-to-right picture, kept in order

// The cone's edges 0..far sessions out ([[h, price]] for the top and the bottom), drawn between the week's and the
// month's ranges by √time, as swings grow; far is the last window without an ex-date. Null when neither has a range.
export function cone(r, upTo = 20) {
  const c = r.close;
  const ends = [[5, r.steps['5']], [20, r.steps['20']]].filter(([, x]) => ok(x));
  if (!ends.length) return null;
  const far = Math.min(upTo, ends[ends.length - 1][0]);
  const edge = (h, key) => {
    const pts = [[0, 0], ...ends.map(([n, x]) => [n, Math.log(x[key] / c)])];
    for (let i = 1; i < pts.length; i++) {
      const [h0, v0] = pts[i - 1], [h1, v1] = pts[i];
      if (h <= h1) return v0 + (v1 - v0) * (Math.sqrt(h) - Math.sqrt(h0)) / (Math.sqrt(h1) - Math.sqrt(h0));
    }
    return pts[pts.length - 1][1];
  };
  const hs = Array.from({ length: far + 1 }, (_, h) => h);
  return { far, top: hs.map(h => [h, c * Math.exp(edge(h, 'hi'))]), bot: hs.map(h => [h, c * Math.exp(edge(h, 'lo'))]) };
}

function Cone({ r, series, plan, ai }) {
  const c = r.close, wk = r.steps['5'], mo = r.steps['20'];
  const cn = cone(r);
  if (!cn) return null;
  const { far, top, bot } = cn;
  const narrow = window.innerWidth < 600;
  const W = narrow ? 420 : 640, H = narrow ? 230 : 250, L = 46, R = narrow ? 92 : 112, T = 14, B = 22;
  const times = (series && series.time) || [], closes = (series && series.close) || [];
  const at = times.lastIndexOf(r.made);
  const past = at >= 0 ? closes.slice(Math.max(0, at - 40), at + 1).map((v, i, a) => [i - a.length + 1, v]).filter(([, v]) => v != null) : [];
  const mids = ai && ai.made === r.made ? [[5, ai.steps['5']], [20, ai.steps['20']]].filter(([n, x]) => x && n <= far && !x.reset).map(([n, x]) => [n, x.mid]) : [];
  const ys = [...past.map(([, v]) => v), ...top.map(([, v]) => v), ...bot.map(([, v]) => v), ...mids.map(([, v]) => v)];
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const lines = plan ? [['target', plan.target, 'up'], ['stop', plan.stop, 'down']]
    .filter(([, v]) => v > 0 && v > lo - (hi - lo) * 0.35 && v < hi + (hi - lo) * 0.35) : [];
  for (const [, v] of lines) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const x0 = past.length ? past[0][0] : -10;
  const mid = L + (W - L - R) * 0.45;      // the past on the left 45%, the coming sessions on the rest
  const X = i => (i <= 0 ? L + (i - x0) / -x0 * (mid - L) : mid + i / far * (W - R - mid)), Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const path = pts => pts.map(([i, v], j) => `${j ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const ticks = Array.from({ length: 4 }, (_, j) => lo + pad + (hi - lo - 2 * pad) * j / 3);
  const label = (v, cl, txt) => html`<text x=${X(far) + 6} y=${Y(v) + 4} class=${cl}>${txt || fmt.price(v)}</text>`;
  // the stop's and target's labels sit at the right, moved apart when they'd overlap the cone's end labels
  const side = [[top[far][1], 'hi'], [bot[far][1], 'lo']];
  return html`<div class="rg-cone">
    <svg class="ai-draw" viewBox=${`0 0 ${W} ${H}`} role="img" aria-label=${t('How far it could move')}>
      ${ticks.map(v => html`<line x1=${L} x2=${W - R} y1=${Y(v)} y2=${Y(v)} class="grid" /><text x=${L - 6} y=${Y(v) + 4} class="axis" text-anchor="end">${fmt.price(v)}</text>`)}
      <path d=${path(top) + path([...bot].reverse()).replace('M', 'L') + 'Z'} class="rg-fill" />
      ${ok(wk) && ok(mo) && html`<line x1=${X(5)} x2=${X(5)} y1=${Y(top[5][1])} y2=${Y(bot[5][1])} class="rg-week" />`}
      <line x1=${X(0)} x2=${X(0)} y1=${T} y2=${H - B} class="now-line" />
      ${lines.map(([what, v, tn_]) => html`<line x1=${X(0)} x2=${X(far)} y1=${Y(v)} y2=${Y(v)} class=${cls('rg-plan-line', tn_)} />`)}
      ${past.length > 1 && html`<path d=${path(past)} class="closes" />`}
      ${mids.map(([n, v]) => html`<path d=${`M${X(n)},${Y(v) - 6}L${X(n) + 6},${Y(v)}L${X(n)},${Y(v) + 6}L${X(n) - 6},${Y(v)}Z`} class="rg-ai" />`)}
      <circle cx=${X(0)} cy=${Y(c)} r="4.5" class="start" />
      ${side.map(([v, cl]) => label(v, cl))}
      ${lines.map(([what, v, tn_]) => {
        const ch = mo && ok(mo) ? reachChance(mo, c, v) : null;
        const clash = side.some(([sv]) => Math.abs(Y(sv) - Y(v)) < 13);
        return !clash && label(v, cls('rg-plan-txt', tn_), iso(`${t(what === 'stop' ? 'Stop' : 'Target')} ${ch ? chanceText(ch) : ''}`));
      })}
      ${ok(wk) && ok(mo) && html`<text x=${X(5)} y=${H - 6} class="axis" text-anchor="middle">${t('1 week')}</text>`}
      <text x=${X(far)} y=${H - 6} class="axis" text-anchor="middle">${t(far === 20 ? '1 month' : '1 week')}</text>
      <text x=${X(0)} y=${H - 6} class="axis" text-anchor="middle">${t('Now')}</text>
    </svg>
    <div class="ai-legend faint">
      <span><i class="ln solid"></i>${t('Closes')}</span><span><i class="sw rg"></i>${t('Where the price ended 8 times in 10')}</span>
      ${lines.length > 0 && html`<span><i class="ln rg-plan"></i>${t(plan.mine ? 'Your stop and target, with the chance it trades there by the month\'s end' : 'Stop and target, with the chance it trades there by the month\'s end')}</span>`}
      ${mids.length > 0 && html`<span><i class="rg-ai-key"></i>${t("The AI models' middle guess (card below)")}</span>`}
    </div>
  </div>`;
}

// The stop-loss and target cards: the chance each trades by the end of the month's range (separate chances).
export function ReachLine({ r, stop, target }) {
  const s = r && r.steps['20'] && !r.steps['20'].reset ? r.steps['20'] : null;
  const up = s && target > r.close ? chanceText(reachChance(s, r.close, target)) : null;
  const down = s && stop > 0 && stop < r.close ? chanceText(reachChance(s, r.close, stop)) : null;
  return (up || down) && html`<p class="reach-line"><span class="faint">${t('Chance it trades there by {date}', { date: fmt.date(s.target, false) })}</span>
    ${up && html`<span><b class="up">${t('Target')}</b> ${up}</span>`}${down && html`<span><b class="down">${t('Stop')}</b> ${down}</span>`}</p>`;
}
