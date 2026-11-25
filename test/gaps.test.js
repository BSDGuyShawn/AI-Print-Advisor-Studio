const test = require('node:test');
const assert = require('node:assert');
const G = require('../renderer/filament/gaps');

test('color gaps: nothing owned → the first picks are far apart, all large', () => {
  const r = G.findGaps([], { max: 6 });
  assert.strictEqual(r.gaps.length, 6);
  assert.ok(r.gaps.every(g => g.size === 'large' && g.nearest === null));
  for (let i = 0; i < r.gaps.length; i++) for (let j = i + 1; j < r.gaps.length; j++)
    assert.ok(G.deltaE(r.gaps[i].hex, r.gaps[j].hex) > 25, 'picks spread out');
  // ranked: each fills less than the one before
  for (let i = 1; i < r.gaps.length; i++) assert.ok(r.gaps[i].fills <= r.gaps[i - 1].fills + 1e-9);
});

test('color gaps: a library of only blues and grays is missing reds, yellows and greens', () => {
  const owned = ['#1f3fbf', '#3366ff', '#0a1a4a', '#87a8ff', '#000000', '#ffffff', '#808080', '#404040', '#c0c0c0']
    .map((hex, i) => ({ hex, name: `Blue-gray ${i}` }));
  const r = G.findGaps(owned, { max: 8 });
  const words = r.gaps.map(g => g.words).join(' | ');
  assert.match(words, /red|orange|pink|magenta/, words);
  assert.match(words, /green|lime|yellow|gold/, words);
  assert.ok(!r.gaps.some(g => G.deltaE(g.hex, '#3366ff') < G.MEDIUM), 'nothing next to a blue already owned');
  assert.ok(r.gaps.every(g => g.nearest && g.gapDE >= G.MEDIUM));
  assert.ok(r.gaps[0].fills > 0.05);
});

test('color gaps: a gradient spool counts all its colors', () => {
  const one = G.findGaps([{ hex: '#ff0000', name: 'Red' }], { max: 3 });
  const grad = G.findGaps([{ hex: ['#ff0000', '#00c000', '#0000ff'], name: 'Rainbow' }], { max: 3 });
  assert.ok(grad.missing < one.missing);
  assert.strictEqual(grad.owned, 3);
});
