// Clean-release supports: the support interface in the opposite material (PLA <-> PETG).
const test = require('node:test');
const assert = require('node:assert');
const I = require('../src/interface');
const { compatFixes } = require('../src/compat');

const mats = [{ slot: 1, type: 'PLA' }, { slot: 2, type: 'PLA Silk' }, { slot: 3, type: 'PETG' }, { slot: 4, type: 'PETG' }];

test('PLA model gets a PETG interface toolhead it does not print with', () => {
  const p = I.pickInterface(mats, [1]);
  assert.deepStrictEqual([p.ok, p.modelFamily, p.interfaceFamily, p.slot], [true, 'PLA', 'PETG', 3]);
  const q = I.pickInterface(mats, [3, 4]);
  assert.deepStrictEqual([q.ok, q.interfaceFamily, q.slot], [true, 'PLA', 1]);
});

test('refuses when there is no opposite material or the model mixes both', () => {
  assert.strictEqual(I.pickInterface([{ slot: 1, type: 'PLA' }, { slot: 2, type: 'PLA' }], [1]).ok, false);
  assert.match(I.pickInterface([{ slot: 1, type: 'PLA' }], [1]).reason, /Load PETG/);
  assert.strictEqual(I.pickInterface(mats, [1, 3]).ok, false);
  assert.strictEqual(I.pickInterface([{ slot: 1, type: 'ABS' }, { slot: 2, type: 'PETG' }], [1]).ok, false);
});

test('the settings: no gap, solid interlaced roof, wide normal supports, prime tower', () => {
  const c = Object.fromEntries(I.interfaceChanges({ modelFamily: 'PLA', interfaceFamily: 'PETG', slot: 3 }, { support_threshold_angle: ['30'] }).map(x => [x.key, x.value]));
  assert.strictEqual(c.support_top_z_distance, '0');
  assert.strictEqual(c.support_bottom_z_distance, '0');
  assert.strictEqual(c.support_interface_spacing, '0');
  assert.strictEqual(c.support_interface_pattern, 'rectilinear_interlaced');
  assert.strictEqual(c.support_interface_filament, '3');
  assert.strictEqual(c.support_type, 'normal(auto)');
  assert.ok(+c.support_expansion > 0);
  assert.ok(+c.support_interface_top_layers >= 3);
  assert.strictEqual(c.independent_support_layer_height, '0');
  assert.strictEqual(c.enable_prime_tower, '1');
  assert.strictEqual(c.support_threshold_angle, '40');
});

test("the AI's values for these keys are replaced, others kept", () => {
  const pick = I.pickInterface(mats, [1]);
  const out = I.enforceInterface([{ key: 'support_top_z_distance', recommended: '0.2' }, { key: 'support_type', recommended: 'tree(auto)' }, { key: 'wall_loops', recommended: '3' }], pick, {});
  assert.strictEqual(out.filter(s => s.key === 'support_top_z_distance').length, 1);
  assert.strictEqual(out.find(s => s.key === 'support_top_z_distance').recommended, '0');
  assert.strictEqual(out.find(s => s.key === 'support_type').recommended, 'normal(auto)');
  assert.ok(out.find(s => s.key === 'wall_loops'));
  assert.deepStrictEqual(I.enforceInterface([{ key: 'support_type', recommended: 'tree(auto)' }], null, {}), [{ key: 'support_type', recommended: 'tree(auto)' }]);
});

test('every key is a known Orca setting and every value validates', () => {
  const { validate } = require('../src/orca-settings');
  for (const c of I.interfaceChanges({ modelFamily: 'PETG', interfaceFamily: 'PLA', slot: 2 }, {})) assert.strictEqual(validate(c.key, c.value), null, c.key);
});

test('the interface toolhead counts as used (ooze protection for two toolheads)', () => {
  const base = { enable_support: ['0'], ooze_prevention: ['0'], enable_prime_tower: ['0'], filament_type: ['PLA', 'PETG'] };
  const changes = I.interfaceChanges({ modelFamily: 'PLA', interfaceFamily: 'PETG', slot: 2 }, {}).filter(c => c.key !== 'enable_prime_tower');
  const { fixes } = compatFixes({ baseSettings: base, changes, usedSlots: [1] });
  assert.ok(fixes.find(f => f.key === 'ooze_prevention'), 'two toolheads in use -> ooze prevention');
});
