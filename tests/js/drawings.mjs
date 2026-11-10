// Checks the chart drawings (app/static/js/drawings.js) on made-up prices:  node tests/js/drawings.mjs
import assert from 'node:assert/strict';
import { zigzag, elliott, harmonic, gann, drawings } from '../../app/static/js/drawings.js';

// A path through given turning points, one bar per 1% step, so every turn is a 10%+ swing.
function path(turns) {
  const c = [];
  for (let k = 1; k < turns.length; k++) {
    const a = turns[k - 1], b = turns[k], steps = Math.max(2, Math.round(Math.abs(b / a - 1) / 0.01));
    for (let j = 0; j < steps; j++) c.push(a + ((b - a) * j) / steps);
  }
  c.push(turns.at(-1));
  return { high: c.map(x => x * 1.001), low: c.map(x => x * 0.999), close: c, time: c.map((_, i) => i) };
}

// 5 waves up (100→150→125→220→180→260), then A-B-C down.
const up = path([100, 150, 125, 220, 180, 260, 210, 240, 190]);
const piv = zigzag(up.high, up.low, 0.08);
assert.deepEqual(piv.map(p => Math.round(p.price)), [100, 150, 125, 220, 180, 260, 210, 240, 190]);
assert.equal(piv.at(-1).open, true);
const e = elliott(piv);
assert.ok(e && e.up && e.points.length === 6 && e.after.length === 3);

// Wave 4 dipping into wave 1's range breaks the rules: no count.
const bad = path([100, 150, 125, 220, 140, 260]);
assert.equal(elliott(zigzag(bad.high, bad.low, 0.08)), null);

// A bullish Gartley: XA 100→200, B at 0.618, C at 0.618 of AB, D at 0.786 of XA (CD/BC ≈ 1.6).
const g = path([100, 200, 138.2, 176.5, 121.4, 160]);
const h = harmonic(zigzag(g.high, g.low, 0.08).slice(0, 5));
assert.ok(h && h.name === 'Gartley' && h.bullish);

// Gann from the year's low, rising; nothing drawn with every switch off.
const fan = gann(up.high, up.low, 0);
assert.ok(fan.up && fan.i0 === 0 && fan.unit > 0);
assert.equal(drawings(up, {}).lines.length, 0);
const all = drawings(up, { waves: true, gann: true, harmonic: true });
assert.ok(all.lines.length >= 13 && all.labels.length >= 8 && all.notes.length === 3);
console.log('drawings ok');
