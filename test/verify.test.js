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

test('the bed check catches a skirt past the bed edge and works out the move back on', () => {
  const { bedCheck } = require('../src/verify');
  const { preflight } = require('../src/preflight');
  const cfg = { printable_area: '0.5x1,270.5x1,270.5x271,0.5x271', printable_height: '270', nozzle_diameter: '0.4', layer_height: '0.2' };
  const body = (y) => `; EXECUTABLE_BLOCK_START\nG1 X10 Y-3 F3000\n;LAYER_CHANGE\n;Z:0.2\n;TYPE:Skirt\nG1 X100 Y${y} E.5\nG1 X150 Y${y} E.5\n;TYPE:Outer wall\nG1 X120 Y50 E.5\n;LAYER_CHANGE\n;Z:0.4\nG1 X120 Y60 E.5\nG1 X5 Y280 F9000\n; EXECUTABLE_BLOCK_END\n`;
  const bad = bedCheck(body(-1.06), cfg);
  assert.strictEqual(bad.ok, false);
  assert.deepStrictEqual(bad.worst, { axis: 'Y', value: -1.06, type: 'Skirt' });
  assert.strictEqual(bad.shift.dy, 3.06, 'moved back so the skirt is 1 mm inside the bed');
  assert.ok(bedCheck(body(2), cfg).ok, 'the start code (Y -3) and the parking move after the last extrusion are not the print');
  const probs = preflight(body(-1.06).padEnd(2000, ' '), cfg, { usedSlots: [1] });
  assert.ok(probs.some(p => p.severity === 'block' && /outside the bed/.test(p.title)));
  assert.ok(!preflight(body(2).padEnd(2000, ' '), cfg, { usedSlots: [1] }).some(p => p.severity === 'block'));
  // too tall, slicer errors, an empty file
  const tall = body(2).replace(';Z:0.4', ';Z:300').padEnd(2000, ' ');
  assert.ok(preflight(tall, cfg).some(p => /Too tall/.test(p.title)));
  assert.ok(preflight(body(2).padEnd(2000, ' '), cfg, { warnings: ['Object is outside the print area'] }).some(p => p.severity === 'block'));
  assert.ok(!preflight(body(2).padEnd(2000, ' '), cfg, { warnings: ['G-code path conflict between A and B'] }).some(p => p.severity === 'block'), 'Orca only warns about path conflicts');
  assert.ok(preflight('', cfg).some(p => p.severity === 'block'));
});
