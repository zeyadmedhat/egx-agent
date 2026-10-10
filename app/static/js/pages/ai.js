// The stock page's "What the AI models forecast" (app/views.py ai_view, egx_agent/ai_forecast.py): three pretrained
// models' forecasts for the next session, 5 or 20 sessions, drawn after the stock's recent closes; how far they agree;
// and how their earlier forecasts did, against what happened and against simply "no change".
import { html, useState, fmt, tone, cls } from '../lib.js';
import { Seg, More } from '../ui.js';
import { t } from '../i18n.js';
import { cone } from './range.js';

const STEPS = [{ value: '1', label: 'Next session' }, { value: '5', label: '5 sessions' }, { value: '20', label: '20 sessions' }];
const AFTER = { 1: 'after the next session', 5: 'after 5 sessions', 20: 'after 20 sessions' };
const SEEN = { 1: 10, 5: 10, 20: 40 };               // past sessions on the drawing
const level = s => (s >= 60 ? 'High' : s >= 30 ? 'Medium' : 'Low');
const median = xs => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const enough = g => g && g.n >= 30;
const BAND = { 0: 'under 30', 30: '30 to 59', 60: '60 or more' };
const FOR = { 1: 'next-session forecasts', 5: '5-session forecasts', 20: '20-session forecasts' };
const RESET = { rights: 'rights issue', bonus: 'bonus shares', split: 'stock split', consolidation: 'share consolidation' };

export function AiForecast({ ai, sym, rg, pred }) {
  const [k, setK] = useState('5');
  const [pick, setPick] = useState(null);           // the model whose line is picked out
  const [before, setBefore] = useState(false);      // earlier forecasts on the drawing
  const s = ai.steps[k], n = +k;
  const times = ai.closes.time, closes = ai.closes.close;
  const at = times.indexOf(ai.start_date);
  const since = times.length - 1 - at;              // sessions closed since the forecasts were made
  const last = closes[closes.length - 1];
  const mid = s.mid, change = mid / ai.start - 1;
  const all = s.all || {};
  const done = s.past.filter(p => p.actual != null), open = s.past.length - done.length;
  return html`<div class="card ai-card">
    <div class="ai-head">
      <div><span class="ai-beta">${t('Beta · not advice')}</span>
        <h3>${t('What the AI models forecast for {sym}', { sym })}</h3>
        <p class="faint">${t('Saved after the close of {date}, and measured from that close.', { date: fmt.date(ai.made) })}</p></div>
      <${Seg} options=${STEPS} value=${k} onChange=${setK} />
    </div>
    <div class="ai-boxes">
      <div class="ai-box"><span class="k-label"><i class="dot start"></i>${t('Start · close of {date}', { date: fmt.date(ai.start_date, false) })}</span>
        <b>${fmt.price(ai.start)}</b><small class="hint">${t('Every forecast here begins at this price.')}</small></div>
      <div class="ai-box"><span class="k-label"><i class="dot now"></i>${t('Now · {date}', { date: fmt.date(times[times.length - 1], false) })}</span>
        <b>${fmt.price(last)}</b><small class=${since ? tone(last / ai.start - 1) : ''}>${since
          ? t('{chg} since the start, {n} sessions in', { chg: fmt.pct(last / ai.start - 1, 2), n: since })
          : t('No session has closed since the start.')}</small></div>
      <div class="ai-box"><span class="k-label"><i class="dot mid"></i>${t('Middle forecast · {when}', { when: t(AFTER[n]) })}</span>
        <b class="accent">${fmt.price(mid)}</b><small class=${tone(change)}>${t('{chg} from the start', { chg: fmt.pct(change, 2) })} · ${fmt.date(s.target, false)}</small></div>
    </div>
    ${s.reset && html`<p class="warn-text ai-reset">${t("Ex-date of the {what}: {date}, inside this window. That day the price is reset for the new shares, which the models can't know: their forecast is in today's prices. Once it's past, their earlier forecasts move to the new prices before they're graded.",
      { what: t(RESET[s.reset.kind]), date: fmt.date(s.reset.date, false) })}</p>`}
    <div class="ai-grid">
      <div style="min-width:0">
        <${Drawing} ai=${ai} k=${n} at=${at} pick=${pick} before=${before} rg=${rg && rg.made === ai.made ? rg : null} />
        <div class="ai-legend faint">
          <span><i class="ln solid"></i>${t('Closes')}</span><span><i class="dot start"></i>${t('Start')}</span>
          <span><i class="ln mid"></i>${t('Middle of the forecasts')}</span><span><i class="ln dash"></i>${t('Each model')}</span>
          <span><i class="sw band"></i>${t('Lowest to highest forecast, not a range of likely prices')}</span>
          ${rg && rg.made === ai.made && html`<span><i class="sw rg"></i>${t('Where the price really ended 8 times in 10 (card above)')}</span>`}
          ${before && html`<span><i class="ln dot2"></i>${t('An earlier forecast, to the session it was about')}</span>
            <span><i class="ln gap"></i>${t('Its gap to that session\'s close')}</span>`}
        </div>
        <div class="row ai-before">
          <button class=${cls('btn sm', before && 'primary')} aria-pressed=${before} onClick=${() => setBefore(b => !b)}>${t('What it forecast before')}</button>
          <span class="faint">${s.past.length === 0 ? t('No earlier forecasts for this share yet: they build up one a day.')
            : t('The middle of the models: {n} earlier forecasts at this window have finished, {a} ended above the price and {b} below it, {e} off in the middle. {u} more have not finished yet.', {
              n: done.length, a: done.filter(p => p.value > p.actual).length, b: done.filter(p => p.value < p.actual).length,
              e: done.length ? fmt.pct(median(done.map(p => Math.abs(p.value / p.actual - 1))), 1, false) : '–', u: open })}</span>
        </div>
        <${Record} s=${s} n=${n} ai=${ai} />
      </div>
      <${Confidence} s=${s} n=${n} ai=${ai} change=${change} pred=${pred} />
    </div>
    <div class="ai-models-head"><span class="k-label">${t('Each model · {when}', { when: t(AFTER[n]) })}</span>
      <span class="faint">${t('Press one to pick its line out of the drawing.')}</span></div>
    <div class="ai-models">${ai.models.map(m => {
      const v = s.values[m.key], g = all[m.key];
      return v != null && html`<button class=${cls('ai-model', pick === m.key && 'on')} aria-pressed=${pick === m.key}
        onClick=${() => setPick(p => (p === m.key ? null : m.key))}>
        <span><b>${m.name}</b><small class="faint">${m.lab}</small></span>
        <span class="r"><b>${fmt.price(v)}</b><small class=${tone(v / ai.start - 1)}>${fmt.pct(v / ai.start - 1, 2)}</small></span>
        ${enough(g) && html`<small class="faint ai-rec">${t('closer than "no change" {p} of the time on every stock', { p: fmt.pct(g.closer, 0, false) })}</small>`}
      </button>`;
    })}</div>
    <p class="faint ai-foot">${t("Each line is one model's saved forecast, session by session. Model output, not advice: nothing here tells you what to do with any share.")}</p>
  </div>`;
}

// How the middle did before: in the test before going live, in its own record on every stock, and on this one.
function Record({ s, n, ai }) {
  const mine = s.record, every = (s.all || {}).middle, test = ai.tested, ta = test.steps[n].all;
  const span = { n: test.dates, from: fmt.date(test.from), to: fmt.date(test.to) };
  return html`<div class="ai-conf ai-record">
    <h4 style="margin-top:0">${t('Have these models been right before?')}</h4>
    <p>${t('Tested on {n} past closes from {from} to {to}, on every stock: the middle got the direction right {d} of the time and was closer than "no change" {c} of the time.',
      { ...span, d: fmt.pct(ta.direction, 0, false), c: fmt.pct(ta.closer, 0, false) })}</p>
    <p>${enough(mine) ? t('For this share, {n} have finished: the middle was closer to the close than "no change" {p} of the time and got the direction right {d} of the time.',
        { n: mine.n, p: fmt.pct(mine.closer, 0, false), d: fmt.pct(mine.direction, 0, false) })
      : t('Not known yet for this share: {n} of its forecasts at this window have finished, too few to tell.', { n: mine ? mine.n : 0 })}</p>
    <p>${enough(every) ? t('In its own record, on every stock, {n} have finished: closer than "no change" {p} of the time, direction right {d}.',
        { n: fmt.int(every.n), p: fmt.pct(every.closer, 0, false), d: fmt.pct(every.direction, 0, false) })
      : t('In its own record: too few have finished yet. A forecast {k} sessions ahead is checked {k} sessions after it\'s made.', { k: n })}</p>
    ${(enough(every) ? every.closer : ta.closer) < 0.5 && html`<p class="warn-text">${t('Simply guessing "no change" has been the closer guess more often. Treat these lines as what the models think, not a forecast to act on.')}</p>`}
  </div>`;
}

function Confidence({ s, n, ai, change, pred }) {
  const m = ai.models.filter(x => s.values[x.key] != null).length;
  const big = s.typical != null && Math.abs(change) >= s.typical;
  const band = s.score >= 60 ? '60' : s.score >= 30 ? '30' : '0', tb = ai.tested.steps[n][band];
  return html`<div class="ai-conf">
    <div class="row"><span class="k-label">${t('Confidence score')}</span><span class=${cls('tag', s.score >= 60 ? 'up' : s.score >= 30 ? 'warn' : '')}>${t(level(s.score))}</span></div>
    <div class="ai-score"><b>${s.score}</b><span class="faint">/100</span></div>
    <div class="ai-meter"><i style=${`width:${s.score}%`}></i></div>
    <p><b>${t('How strongly the models point the same way. It is not the chance that they are right.')}</b></p>
    <p class="faint">${t('When they agree they can be wrong together: they all read the same past prices (Chronos-2 the EGX30 index too) and nothing else.')}</p>
    <p>${t('In the test before going live, {what} with a score {band} got the direction right {d} of the time.',
      { what: t(FOR[n]), band: t(BAND[band]), d: fmt.pct(tb.direction, 0, false) })}</p>
    <h4>${t('Do the models agree?')}</h4>
    <div class="ai-votes">${ai.models.filter(x => s.values[x.key] != null).map(x => html`<i class=${s.values[x.key] > ai.start ? 'up' : s.values[x.key] < ai.start ? 'down' : ''}></i>`)}</div>
    <p>${s.up === m ? t('{n} of {m} expect a rise.', { n: s.up, m }) : s.down === m ? t('{n} of {m} expect a fall.', { n: s.down, m })
      : t('They split: {u} expect a rise, {d} a fall.', { u: s.up, d: s.down })}</p>
    <h4>${t('Is the move big for this share?')}</h4>
    ${s.typical != null && html`<div class="ai-meter thin"><i style=${`width:${Math.min(100, Math.abs(change) / s.typical * 100)}%`}></i></div>`}
    <p>${s.typical == null ? t('Too little history to say what a usual move is.')
      : t(big ? "The middle forecast, {v}, is bigger than most of this share's {k}-session moves in the past year. A usual move is about {u}, up or down."
        : "The middle forecast, {v}, is smaller than most of this share's {k}-session moves in the past year. A usual move is about {u}, up or down.",
        { v: fmt.pct(change, 2), k: n, u: fmt.pct(s.typical, 1, false) })}</p>
    <${Agent} p=${pred} />
    <${More} label="How the score is worked out"><p>${t('Agreement: all the models pointing the same way counts fully, an even split not at all. Size: the middle move against this share\'s usual move over the same number of sessions, full at a usual move or more. The score is the two multiplied, out of 100.')}</p><//>
  </div>`;
}

// The agent's own model next to the AI models: trained on EGX's own history and tested on what it picked, so it's
// the one to weigh for a decision (Rankings). Its rating and how stocks rated like it did in that test.
function Agent({ p }) {
  if (!p || p.rating == null) return null;
  const b = (p.bands || []).find(x => p.rating >= x.from && p.rating <= x.to);
  return html`<div class="ai-agent"><h4>${t("Compare: the agent's own model")}</h4>
    <p>${t('Rating {v}/100.', { v: p.rating })} ${b && b.hit != null ? t('Stocks rated like it reached their target before their stop {hit} of the time in its test (the average stock {base}).', {
      hit: fmt.pct(b.hit, 0, false), base: fmt.pct(p.base && p.base[10], 0, false) }) : ''}</p>
    <p class="faint">${t("It learned from every liquid EGX stock's past and was tested on years it hadn't seen, so weigh it more than these lines.")} <a href="#/predict">${t('Rankings')}</a></p></div>`;
}

// The drawing: past closes, then each model's path, their middle and spread; earlier forecasts on request.
function Drawing({ ai, k, at, pick, before, rg }) {
  const narrow = window.innerWidth < 600;           // a phone: fewer units across, so the words stay readable
  const W = narrow ? 420 : 640, H = narrow ? 260 : 300, L = 50, R = 58, T = 16, B = 26;
  const past = SEEN[k], times = ai.closes.time, closes = ai.closes.close;
  const from = Math.max(0, at - past);
  const shown = closes.slice(from), x0 = from - at;            // session index of the first shown close (≤ 0)
  const span = Math.max(k, closes.length - 1 - at);
  const keys = ai.models.map(m => m.key).filter(m => ai.paths[m]);
  const step = i => keys.map(m => ai.paths[m][i]);
  const mids = Array.from({ length: k }, (_, i) => median(step(i)));
  const los = Array.from({ length: k }, (_, i) => Math.min(...step(i))), his = Array.from({ length: k }, (_, i) => Math.max(...step(i)));
  const pastFc = before ? ai.steps[k].past.map(p => ({ ...p, i: times.indexOf(p.made) - at })).filter(p => p.i >= x0 && times.indexOf(p.made) >= 0) : [];
  const cn = rg && cone(rg, k);          // the price range card's 8-in-10 cone, from the same close
  const ys = [...shown, ai.start, ...los, ...his, ...pastFc.flatMap(p => [p.value, p.actual].filter(v => v != null)),
    ...(cn ? [...cn.top, ...cn.bot].map(([, v]) => v) : [])];
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo || hi * 0.02) * 0.1; lo -= pad; hi += pad;
  const X = i => L + (i - x0) / (span - x0) * (W - L - R), Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const line = pts => pts.map(([i, v], j) => `${j ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const ticks = Array.from({ length: 4 }, (_, j) => lo + pad + (hi - lo - 2 * pad) * j / 3);
  const end = (v, c) => html`<text x=${X(k) + 6} y=${Y(v) + 4} class=${c}>${fmt.price(v)}</text>`;
  const labels = [[his[k - 1], 'hi'], [mids[k - 1], 'mid'], [los[k - 1], 'lo']].filter(([v], j, a) => j === 1 || Math.abs(Y(v) - Y(a[1][0])) > 12);
  return html`<svg class="ai-draw" viewBox=${`0 0 ${W} ${H}`} role="img" aria-label=${t('What the AI models forecast')}>
    <rect x=${X(0)} y=${T} width=${X(span) - X(0)} height=${H - T - B} class="fc-zone" />
    ${ticks.map(v => html`<line x1=${L} x2=${W - R} y1=${Y(v)} y2=${Y(v)} class="grid" /><text x=${L - 6} y=${Y(v) + 4} class="axis" text-anchor="end">${fmt.price(v)}</text>`)}
    ${cn && html`<path d=${line(cn.top) + line([...cn.bot].reverse()).replace('M', 'L') + 'Z'} class="rg-fill" />`}
    <line x1=${X(0)} x2=${X(0)} y1=${T} y2=${H - B} class="now-line" />
    <path d=${line([[0, ai.start], ...his.map((v, i) => [i + 1, v])]) + line([...los.map((v, i) => [i + 1, v]).reverse(), [0, ai.start]]).replace('M', 'L') + 'Z'} class="band" />
    ${keys.map(m => html`<path d=${line([[0, ai.start], ...ai.paths[m].slice(0, k).map((v, i) => [i + 1, v])])}
      class=${cls('model', pick === m && 'on', pick && pick !== m && 'off')} />`)}
    <path d=${line([[0, ai.start], ...mids.map((v, i) => [i + 1, v])])} class=${cls('mid', pick && 'off')} />
    <path d=${line(shown.map((v, j) => [x0 + j, v]))} class="closes" />
    ${pastFc.map(p => html`<g class="past">
      <path d=${line([[p.i, p.start], [p.i + k, p.value]])} /><circle cx=${X(p.i + k)} cy=${Y(p.value)} r="3" />
      ${p.actual != null && html`<line x1=${X(p.i + k)} x2=${X(p.i + k)} y1=${Y(p.value)} y2=${Y(p.actual)} class="gap" />`}</g>`)}
    <circle cx=${X(0)} cy=${Y(ai.start)} r="4.5" class="start" />
    <text x=${X(0)} y=${Y(ai.start) - 10} class="val" text-anchor="middle">${fmt.price(ai.start)}</text>
    ${labels.map(([v, c]) => end(v, c))}
    <text x=${L} y=${H - 6} class="axis">${fmt.date(times[from], false)}</text>
    <text x=${X(0)} y=${H - 6} class="axis" text-anchor="middle">${fmt.date(ai.start_date, false)}</text>
    <text x=${W - R} y=${H - 6} class="axis" text-anchor="end">${t('+{k} sessions', { k: span })}</text>
  </svg>`;
}
