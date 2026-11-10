// Elliott waves, a Gann fan and harmonic patterns, drawn from a chart's own prices (charts.js puts them on the candles).
// Tested on 10 years of EGX (10 Nov 2026): harmonic patterns did no better than any day, and Elliott and Gann can't be
// tested at all: the same chart can be counted another way, and a Gann line flips with the scale you pick. So they're
// drawings, switched off until you turn them on, never part of a signal.
// Output: { lines: [{ a: [bar, price], b: [bar, price], color, dash, label, labelAt }], shapes: [{ pts: [[bar, price]…], color }],
//           labels: [{ at: [bar, price], text, color, up }], notes: ['…'] }, colors as names from charts.js's palette.

// Swing highs and lows: a swing ends when the price turns back by p (a share, e.g. 0.08 = 8%). The last one is still
// open (the move in progress), marked open: true.
export function zigzag(high, low, p) {
  const piv = [];
  let dir = 0, hi = -Infinity, lo = Infinity, hiI = -1, loI = -1, ext = 0, extI = -1;
  for (let i = 0; i < high.length; i++) {
    const h = high[i], l = low[i];
    if (h == null || l == null) continue;
    if (dir === 0) {
      if (h > hi) { hi = h; hiI = i; }
      if (l < lo) { lo = l; loI = i; }
      if (hi >= lo * (1 + p)) {
        dir = hiI > loI ? 1 : -1;
        piv.push(dir === 1 ? { i: loI, price: lo, high: false } : { i: hiI, price: hi, high: true });
        [ext, extI] = dir === 1 ? [hi, hiI] : [lo, loI];
      }
    } else if (dir === 1) {
      if (h > ext) { ext = h; extI = i; } else if (l <= ext * (1 - p)) { piv.push({ i: extI, price: ext, high: true }); dir = -1; ext = l; extI = i; }
    } else if (l < ext) { ext = l; extI = i; } else if (h >= ext * (1 + p)) { piv.push({ i: extI, price: ext, high: false }); dir = 1; ext = h; extI = i; }
  }
  if (dir !== 0) piv.push({ i: extI, price: ext, high: dir === 1, open: true });
  return piv;
}

// How big a swing counts: about 4 normal days' range of this chart (EGX30 ~6%, a busy stock ~12%), 4%–20%.
export function swingSize(high, low, close) {
  const r = [];
  for (let i = Math.max(0, close.length - 250); i < close.length; i++) {
    if (high[i] != null && low[i] != null && close[i] > 0) r.push((high[i] - low[i]) / close[i]);
  }
  if (!r.length) return 0.08;
  r.sort((a, b) => a - b);
  return Math.min(0.2, Math.max(0.04, 4 * r[Math.floor(r.length / 2)]));
}

// The latest 5-wave move the textbook rules allow: wave 2 doesn't go past wave 1's start, wave 3 goes past wave 1's end
// and isn't the shortest of 1, 3, 5, wave 4 stays out of wave 1's range, wave 5 goes past wave 3's end. Then A, B, C.
export function elliott(piv) {
  for (let s = piv.length - 6; s >= 0; s--) {
    const [p0, p1, p2, p3, p4, p5] = piv.slice(s, s + 6).map(x => x.price);
    const k = p1 > p0 ? 1 : -1;
    const w1 = k * (p1 - p0), w3 = k * (p3 - p2), w5 = k * (p5 - p4);
    if (k * (p2 - p0) <= 0 || k * (p3 - p1) <= 0 || k * (p4 - p1) <= 0 || k * (p5 - p3) <= 0) continue;
    if (w3 < w1 && w3 < w5) continue;
    return { up: k === 1, points: piv.slice(s, s + 6), after: piv.slice(s + 6, s + 9) };
  }
  return null;
}

// XABCD ratios (b = AB/XA, c = BC/AB, d = CD/BC, x = D's retracement of XA), ±0.04, the same as the EGX test.
const near = (v, lo, hi = lo) => v >= lo - 0.04 && v <= hi + 0.04;
export const PATTERNS = {
  Gartley: (b, c, d, x) => near(b, 0.618) && near(c, 0.382, 0.886) && near(d, 1.27, 1.618) && near(x, 0.786),
  Bat: (b, c, d, x) => near(b, 0.382, 0.5) && near(c, 0.382, 0.886) && near(d, 1.618, 2.618) && near(x, 0.886),
  Butterfly: (b, c, d, x) => near(b, 0.786) && near(c, 0.382, 0.886) && near(d, 1.618, 2.24) && near(x, 1.27, 1.618),
  Crab: (b, c, d, x) => near(b, 0.382, 0.618) && near(c, 0.382, 0.886) && near(d, 2.24, 3.618) && near(x, 1.618),
};

export function harmonic(piv) {
  for (let s = piv.length - 5; s >= 0; s--) {
    const pts = piv.slice(s, s + 5);
    const [X, A, B, C, D] = pts.map(x => x.price);
    const XA = Math.abs(A - X), AB = Math.abs(A - B), BC = Math.abs(C - B);
    if (!XA || !AB || !BC) continue;
    const r = [AB / XA, BC / AB, Math.abs(C - D) / BC, Math.abs(A - D) / XA];
    const name = Object.keys(PATTERNS).find(k => PATTERNS[k](...r));
    if (name) return { name, bullish: !pts[4].high, points: pts, forming: !!pts[4].open };
  }
  return null;
}

// A Gann fan from the past year's main low (or high, if the high came first), with price and time "squared": the
// 1×1 line climbs the year's range in a year. Gann gives no rule for that scale; another one moves every line.
export function gann(high, low, from) {
  let lo = Infinity, hi = -Infinity, loI = -1, hiI = -1;
  for (let i = from; i < high.length; i++) {
    if (low[i] != null && low[i] < lo) { lo = low[i]; loI = i; }
    if (high[i] != null && high[i] > hi) { hi = high[i]; hiI = i; }
  }
  if (loI < 0 || hiI < 0 || hi <= lo) return null;
  const up = loI < hiI;
  return { i0: up ? loI : hiI, p0: up ? lo : hi, up, unit: (hi - lo) / Math.max(1, high.length - 1 - from),
    fans: [[4, 1], [2, 1], [1, 1], [1, 2], [1, 4]] };
}

// Everything to draw for the switches that are on (show.waves, show.gann, show.harmonic), and what each says in plain
// words. f: { t: translator, day: bar → date text, price: number → text, pct: share → text }.
const plain = (s, v) => (v ? Object.entries(v).reduce((a, [k, x]) => a.split(`{${k}}`).join(x), s) : s);
export function drawings(series, show, f = {}) {
  const { t = plain, day = i => String(series.time[i]), price = x => x.toFixed(2), pct = x => `${(x * 100).toFixed(1)}%` } = f;
  const out = { lines: [], shapes: [], labels: [], notes: [] };
  if (!show.waves && !show.gann && !show.harmonic) return out;
  const { high, low, close } = series;
  const n = close.length;
  const piv = zigzag(high, low, swingSize(high, low, close));
  const at = p => [p.i, p.price];
  const seg = (a, b, color, dash = false) => out.lines.push({ a: at(a), b: at(b), color, dash });
  const last = close[n - 1];

  if (show.waves) {
    const e = elliott(piv);
    if (e) {
      const all = [...e.points, ...e.after];
      for (let j = 1; j < all.length; j++) seg(all[j - 1], all[j], 'violet', j > 5);
      all.slice(1).forEach((p, j) => out.labels.push({ at: at(p), text: j < 5 ? String(j + 1) : 'ABC'[j - 5], color: 'violet', up: p.high }));
      const k = e.after.length, end5 = e.points[5], v = { move: t(e.up ? 'rise' : 'fall'), date: day(end5.i) };
      const text = !k
        ? (end5.open ? 'Elliott waves: the price is in wave 5, the last push of a {move}. In the theory, a 3-step pullback (A, B, C) comes after it.'
          : 'Elliott waves: a 5-wave {move} ended {date}. In the theory, a 3-step pullback (A, B, C) comes next.')
        : k < 3 || e.after[2].open
          ? 'Elliott waves: a 5-wave {move} ended {date}. Now in step {step} of the 3-step pullback. In the theory, the {move} carries on after step C.'
          : 'Elliott waves: a 5-wave {move} ended {date}, then a 3-step pullback (A, B, C) to {date2}. In the theory, a new {move} starts after C.';
      const step = 'ABC'[e.after[k - 1] && e.after[k - 1].open ? k - 1 : Math.min(k, 2)];
      out.notes.push(t(text, { ...v, step, date2: k ? day(e.after[k - 1].i) : '' }) + ' ' + t('Another count can read this chart the other way.'));
    } else out.notes.push(t('Elliott waves: no 5-wave count fits the rules on this chart.'));
  }

  if (show.gann) {
    const g = gann(high, low, Math.max(0, n - 250));
    if (g) {
      const end = n + 60;
      for (const [pp, tt] of g.fans) {
        const y = i => Math.max(g.p0 * 0.01, g.p0 + (g.up ? 1 : -1) * g.unit * (pp / tt) * (i - g.i0));
        out.lines.push({ a: [g.i0, g.p0], b: [end, y(end)], color: 'warn', dash: pp !== tt, label: `${pp}×${tt}`,
          labelAt: [n - 1, y(n - 1)] });
      }
      const line = Math.max(g.p0 * 0.01, g.p0 + (g.up ? 1 : -1) * g.unit * (n - 1 - g.i0));
      const v = { price: price(last), line: price(line), date: day(g.i0) };
      out.notes.push(t(g.up
        ? (last >= line ? "Gann: the price ({price}) is above the main 1×1 line ({line}). In Gann's reading, the rise since {date} is keeping its pace."
          : "Gann: the price ({price}) is below the main 1×1 line ({line}). In Gann's reading, the rise since {date} has slowed.")
        : (last <= line ? "Gann: the price ({price}) is below the main 1×1 line ({line}). In Gann's reading, the fall since {date} is keeping its pace."
          : "Gann: the price ({price}) is above the main 1×1 line ({line}). In Gann's reading, the fall since {date} has slowed."), v)
        + ' ' + t('A different scale moves the lines.'));
    }
  }

  if (show.harmonic) {
    const h = harmonic(piv);
    if (h) {
      const [X, A, B, C, D] = h.points;
      const color = h.bullish ? 'up' : 'down';
      out.shapes.push({ pts: [at(X), at(A), at(B)], color }, { pts: [at(B), at(C), at(D)], color });
      [[X, A], [A, B], [B, C], [C, D]].forEach(([a, b]) => seg(a, b, color));
      seg(X, B, color, true); seg(B, D, color, true);
      h.points.forEach((p, j) => out.labels.push({ at: at(p), text: 'XABCD'[j], color, up: p.high }));
      const v = { name: t(`${h.bullish ? 'Bullish' : 'Bearish'} ${h.name}`), price: price(D.price), date: day(D.i) };
      let text = t(h.forming
        ? (h.bullish ? 'Harmonic: a {name} may be forming, D at {price} so far. In the theory, the price turns up from D, but D can still move.'
          : 'Harmonic: a {name} may be forming, D at {price} so far. In the theory, the price turns down from D, but D can still move.')
        : (h.bullish ? 'Harmonic: a {name} ended at D ({price}, {date}). In the theory, the price turns up from D.'
          : 'Harmonic: a {name} ended at D ({price}, {date}). In the theory, the price turns down from D.'), v);
      if (!h.forming) {
        const j = Math.min(n - 1, D.i + 20);
        text += ' ' + t(j === D.i + 20 ? 'What happened: {pct} in the 20 sessions after D.' : 'What happened so far: {pct}.',
          { pct: pct(close[j] / D.price - 1) });
      }
      out.notes.push(text);
    } else out.notes.push(t('Harmonic: no textbook pattern on this chart.'));
  }
  return out;
}
