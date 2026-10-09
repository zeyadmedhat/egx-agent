// The stock page's "How far it could move" (app/views.py range_view, egx_agent/ranges.py): the range the close ended
// inside 8 times in 10 over the next week or month, the chance it trades at a price on the way, and how its past
// ranges held. It says how far, not which way.
import { html, useState, fmt } from '../lib.js';
import { Seg, More } from '../ui.js';
import { t } from '../i18n.js';

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

export function PriceRange({ r, sym }) {
  const [k, setK] = useState(r.steps['5'] ? '5' : '20');   // a stock idle for a week has only its month left
  const [price, setPrice] = useState('');
  const s = r.steps[k];
  if (!s) return null;
  const c = r.close, typed = Number(price), mine = s.record, all = r.all[k], test = r.tested.steps[k];
  const when = { date: fmt.date(s.target, false), n: k };
  const pick = typed > 0 && !s.reset ? reachChance(s, c, typed) : null;
  return html`<div class="card range-card">
    <div class="range-head">
      <div><h3>${t('How far {sym} could move', { sym })}</h3>
        <p class="faint">${t('From the close of {date} ({price}). It says how far, not which way.', { date: fmt.date(r.made), price: fmt.price(c) })}</p></div>
      <${Seg} options=${STEPS} value=${k} onChange=${setK} />
    </div>
    ${s.reset ? html`<p class="warn-text ai-reset">${t("Ex-date of the {what}: {date}, inside this window. That day the price is reset for the new shares, so a range in today's prices would be wrong. It comes back once the price history is re-based for them.",
      { what: t(RESET[s.reset.kind]), date: fmt.date(s.reset.date, false) })}</p>` : html`<div class="range-main">
      <span class="k-label">${t('8 times in 10, the close {n} sessions later ({date}) was between', when)}</span>
      <div class="range-ends"><b>${fmt.price(s.lo)}</b><span class="faint">${t('and')}</span><b>${fmt.price(s.hi)}</b></div>
      <span class="faint"><bdi>${fmt.pct(ret(s.lo, c), 1)}</bdi> ${t('to')} <bdi>${fmt.pct(ret(s.hi, c), 1)}</bdi></span>
      <${Bar} s=${s} c=${c} />
    </div>
    <div>
      <h4>${t('The chance it trades at a price by {date}', when)}</h4>
      <p class="faint range-sub">${t('At any moment in the next {n} sessions, from the session highs and lows. Up and down are separate chances: both can happen.', when)}</p>
      <div class="range-ladder">
        <${Ladder} title="Up to" pts=${s.up} cap=${s.cap} c=${c} />
        <${Ladder} title="Down to" pts=${s.down} cap=${s.cap} c=${c} />
      </div>
      <label class="range-check"><span>${t('Check a price')}</span>
        <input class="input" type="number" min="0" step="any" inputmode="decimal" placeholder=${fmt.price(c)}
          value=${price} onInput=${e => setPrice(e.target.value)} /></label>
      ${pick && html`<p class="range-answer">${t(typed > c ? 'The chance it trades at {price} or higher by {date}: {chance}.'
        : 'The chance it trades at {price} or lower by {date}: {chance}.', { ...when, price: fmt.price(typed), chance: chanceText(pick) })}</p>`}
    </div>`}
    <div class="range-record">
      <h4>${t('Did these ranges hold before?')}</h4>
      <p>${mine.n >= 30 ? t('{sym}, the last year: the close ended inside {a} of {n} ranges ({p}).', { sym, a: mine.inside, n: mine.n, p: fmt.pct(mine.inside / mine.n, 0, false) })
        : t('{sym}: too few of its ranges have finished to tell ({n}).', { sym, n: mine.n })}</p>
      ${all && all.n > 0 && html`<p>${t('Every stock, the last year: {p} of {n} ranges.', { p: fmt.pct(all.inside / all.n, 0, false), n: fmt.int(all.n) })}</p>`}
      <p>${t('Tested from {from} to {to} on every stock: {p} of {n} ranges, {g1} to {g2} in each group of similar stocks.', {
        from: fmt.month(r.tested.from), to: fmt.month(r.tested.to), p: fmt.pct(test.cover, 0, false), n: fmt.int(test.n),
        g1: fmt.pct(test.groups[0], 0, false), g2: fmt.pct(test.groups[1], 0, false) })}</p>
    </div>
    <${More} label="How it's worked out"><p>${t(HOW)}</p><p>${t(WHY)}</p><//>
  </div>`;
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

// The ladder's capped chance (said more is less sure: tested chances above it ran high), half and the 1-in-10.
function Ladder({ title, pts, cap, c }) {
  const seen = new Set();
  const shown = pts.filter(([p]) => p === cap || p === 0.5 || p === 0.3 || p === 0.1)
    .map(([p, v]) => [p, Number(v.toFixed(v < 10 ? 3 : 2))])              // as fmt.price shows it
    .filter(([, v]) => v !== c && !seen.has(v) && seen.add(v));
  return html`<div class="range-col"><span class="k-label">${t(title)}</span>
    ${shown.length ? shown.map(([p, v]) => html`<div class="range-row">
      <span class="range-pct">${fmt.pct(p, 0, false)}</span>
      <b>${fmt.price(v)}</b><small class=${v > c ? 'up' : 'down'}><bdi>${fmt.pct(ret(v, c), 1)}</bdi></small></div>`)
      : html`<p class="faint">${t('No price that way has a real chance.')}</p>`}</div>`;
}

// The range on a line, low prices on the left: the 1-in-10 prices each way at the ends, the 8-in-10 range shaded,
// the close marked.
function Bar({ s, c }) {
  const far = (pts, end) => (pts.length ? pts[pts.length - 1][1] : end);
  const a = Math.min(far(s.down, s.lo), s.lo, c), b = Math.max(far(s.up, s.hi), s.hi, c);
  const X = v => Math.log(v / a) / Math.log(b / a) * 100;
  return html`<div class="range-bar" dir="ltr" aria-hidden="true">
    <i class="band" style=${`left:${X(s.lo).toFixed(2)}%;width:${(X(s.hi) - X(s.lo)).toFixed(2)}%`}></i>
    <i class="now" style=${`left:${X(c).toFixed(2)}%`}></i>
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
