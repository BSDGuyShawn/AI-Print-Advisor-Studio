// The Send dialog's check: settings read back from the sliced print (src/verify.js)
const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { verifyPrint, measureLayers } = require('../src/verify');

const gcode = (layer, steps) => {
  let z = 0.3, out = ';Z:0.3\n';
  for (let i = 0; i < steps; i++) { z += layer; out += `;Z:${z.toFixed(2)}\n`; }
  return out + `; CONFIG_BLOCK_START\n; layer_height = ${layer}\n; initial_layer_print_height = 0.3\n; wall_loops = 3\n; sparse_infill_density = 15%\n; nozzle_temperature = 220,215\n; enable_support = 1\n; CONFIG_BLOCK_END\n`;
};

test('layer heights are measured from the toolpaths', () => {
  const L = measureLayers(gcode(0.12, 40));
  assert.strictEqual(L.first, 0.3);
  assert.strictEqual(L.step, 0.12);
  assert.strictEqual(L.count, 41);
});

test('each change is checked against the sliced print; a missing one is flagged', async () => {
  const v = await verifyPrint({ gcodeText: gcode(0.12, 40), usedSlots: [1, 2], changes: [
    { key: 'layer_height', value: '0.12', slot: 0 }, { key: 'wall_loops', value: '3', slot: 0 }, { key: 'sparse_infill_density', value: '15', slot: 0 },
    { key: 'nozzle_temperature', value: '215', slot: 2 }, { key: 'nozzle_temperature', value: '230', slot: 1 }] });
  const by = (k, s = 0) => v.checks.find(c => c.key === k && c.slot === s);
  assert.ok(by('layer_height').ok, 'layer height in the settings and in the toolpaths');
  assert.ok(by('wall_loops').ok);
  assert.ok(by('sparse_infill_density').ok, '15 and 15% are the same');
  assert.ok(by('nozzle_temperature', 2).ok, "T2's own temperature");
  assert.ok(!by('nozzle_temperature', 1).ok, 'T1 prints at 220, not 230');
  assert.strictEqual(by('nozzle_temperature', 1).actual, '220');
  assert.strictEqual(v.allOk, false);
  assert.ok(v.summary.some(s => /T1 220 °C, T2 215 °C/.test(s.value)));
  // the settings say 0.12 but the toolpaths are 0.2 (e.g. a variable layer profile won): flagged
  const v2 = await verifyPrint({ gcodeText: gcode(0.2, 30).replace('; layer_height = 0.2', '; layer_height = 0.12'), changes: [{ key: 'layer_height', value: '0.12' }] });
  assert.ok(!v2.checks[0].ok);
});

test('per-object settings are checked in the sliced project', async () => {
  const zip = new JSZip();
  zip.file('Metadata/model_settings.config', '<config><object id="3"><metadata key="name" value="Wing"/><metadata key="wall_loops" value="5"/></object><object id="4"><metadata key="name" value="Body"/></object></config>');
  const sliced = await zip.generateAsync({ type: 'nodebuffer' });
  const v = await verifyPrint({ gcodeText: gcode(0.2, 10), slicedProject: sliced, names: { 3: 'Wing', 4: 'Body' },
    objectChanges: { 3: [{ key: 'wall_loops', value: '5' }], 4: [{ key: 'wall_loops', value: '4' }] } });
  const wing = v.checks.find(c => c.wanted === '5'), body = v.checks.find(c => c.wanted === '4');
  assert.ok(wing.ok);
  assert.match(wing.where, /Wing \(per object\)/);
  assert.ok(!body.ok, 'the setting is missing on Body');
});
