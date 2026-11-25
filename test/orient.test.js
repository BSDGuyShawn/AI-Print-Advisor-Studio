// Orientation scoring: a display piece is never flipped so that its visible top prints on supports.
const test = require('node:test');
const assert = require('node:assert');
const { orientObject } = require('../src/orient');

// a convex piece between two square rings (CCW from above): bottom at z0 (half-size a), top at z1 (half-size b)
function piece(a, z0, b, z1) {
  const ring = (s, z) => [[-s, -s, z], [s, -s, z], [s, s, z], [-s, s, z]];
  const B = ring(a, z0), T = ring(b, z1), out = [];
  const tri = (p, q, r) => out.push(...p, ...q, ...r);
  tri(B[0], B[2], B[1]); tri(B[0], B[3], B[2]);           // bottom, facing down
  tri(T[0], T[1], T[2]); tri(T[0], T[2], T[3]);           // top, facing up
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; tri(B[i], B[j], T[j]); tri(B[i], T[j], T[i]); }
  return new Float32Array(out);
}
// a mushroom-like figure: a thin stem, a wide cap, and a sloped (domed) top with a small flat crown
const figure = [piece(5, 0, 5, 20), piece(20, 20, 20, 25), piece(20, 25, 10, 30)];

test('a figure stays upright: flipping it would put its top on supports', () => {
  const opts = orientObject(figure);
  const best = opts[0], flipped = opts.find(o => o.label === 'Upside down');
  assert.ok(flipped, 'upside down is a candidate');
  assert.ok(flipped.overhangCm2 < opts.find(o => o.isCurrent).overhangCm2, 'flipping has less raw overhang (the old trap)');
  assert.ok(flipped.visibleTopCm2 > 10);
  assert.strictEqual(flipped.look.level, 'bad');
  assert.ok(opts.indexOf(flipped) > opts.findIndex(o => o.isCurrent), 'upside down ranks below the pose as designed');
  assert.notStrictEqual(best, flipped);
  assert.strictEqual(best.visibleTopCm2, 0, `best was ${best.label}`);
  assert.notStrictEqual(best.look.level, 'bad');
});
