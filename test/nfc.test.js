// Tests for src/nfc.js (the spool tag reader process). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const { TagReader, clean, locate } = require('../src/nfc');

const BAMBU = {
  event: 'tag_scanned', timestamp: '2026-11-22T23:19:19+00:00', reader: 'Cryptnox NFC 0', status: 'decoded', decoder: 'bambu',
  spool_id: 'bambu:D7AC3B89A16B47C4B061728044E1F2D5', tag: { uid: '75886B1D', type: 'MifareClassic1k', atr: '3B8F' },
  filament: { manufacturer: 'Bambu', material: 'PLA', modifiers: ['Basic'], name: 'Bambu PLA Basic', color_hex: '#ff6a13',
    colors_hex: ['#FF6A13'], diameter_mm: 1.75, weight_g: 1000, nozzle_temp_min_c: 190, nozzle_temp_max_c: 230, bed_temp_c: 45,
    drying_temp_c: 55, drying_time_h: 8, manufacturing_date: '2022-10-15', product_id: 'x' },
  extras: { tray_uid: 'D7AC', material_id: 'GFA00', material_variant_id: 'A00-A0', detailed_type: 'PLA Basic', filament_length_m: 330 },
};

function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null)); };
    calls.push({ cmd, args, opts, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}

test('clean keeps the fields the screen uses, normalised', () => {
  const c = clean(BAMBU);
  assert.equal(c.event, 'tag_scanned');
  assert.equal(c.spoolId, 'bambu:D7AC3B89A16B47C4B061728044E1F2D5');
  assert.equal(c.filament.colorHex, '#FF6A13');
  assert.equal(c.filament.weightG, 1000);
  assert.equal(c.extras.materialId, 'GFA00');
  assert.equal(c.tag.atr, undefined, 'drops fields the screen does not use');
});

test('clean rejects junk and odd values', () => {
  assert.equal(clean(null), null);
  assert.equal(clean({ event: 'something_else' }), null);
  assert.equal(clean({ event: 'tag_scanned', tag: { uid: '<script>' } }), null);
  assert.equal(clean({ event: 'reader_status', state: 'bogus' }), null);
  const odd = clean({ ...BAMBU, filament: { ...BAMBU.filament, color_hex: 'red; background:url(x)', weight_g: '1000' } });
  assert.equal(odd.filament.colorHex, null);
  assert.equal(odd.filament.weightG, null);
  const unk = clean({ event: 'tag_scanned', status: 'unrecognized', tag: { uid: 'deadbeef', type: 'MifareClassic1k' }, filament: null });
  assert.equal(unk.spoolId, 'uid:DEADBEEF');
  assert.equal(unk.filament, null);
});

test('locate prefers the copy shipped next to the app, then PATH', () => {
  const here = path.join(__dirname, 'no-such-app');
  assert.deepEqual(locate(here, {}, 'win32'), { cmd: 'spoolscan', bundled: false });
  assert.deepEqual(locate(here, { AIPA_SPOOLSCAN: 'C:\\x\\spoolscan.exe' }, 'win32'), { cmd: 'C:\\x\\spoolscan.exe', bundled: false });
});

test('TagReader starts spoolscan watch and turns its lines into events', async () => {
  const spawnFn = fakeSpawn();
  const r = new TagReader({ appDir: __dirname, spawnFn, env: {} });
  const tags = [], statuses = [], errors = [];
  r.on('tag', t => tags.push(t)); r.on('status', s => statuses.push(s.state)); r.on('read-error', e => errors.push(e));
  r.start({ reader: 'Cryptnox' });
  const { cmd, args, opts, child } = spawnFn.calls[0];
  assert.equal(cmd, 'spoolscan');
  assert.deepEqual(args, ['watch', '--emit-status', '--dedupe', '3', '--reader', 'Cryptnox']);
  assert.equal(opts.windowsHide, true);
  // a record split across chunks, a noise line, then status and error events
  const line = JSON.stringify(BAMBU) + '\n';
  child.stdout.write(line.slice(0, 40)); child.stdout.write(line.slice(40));
  child.stdout.write('not json\n');
  child.stdout.write(JSON.stringify({ event: 'reader_status', state: 'watching', readers: ['Cryptnox NFC 0'] }) + '\n');
  child.stdout.write(JSON.stringify({ event: 'read_error', error: 'tag removed during read' }) + '\n');
  await new Promise(r => setImmediate(r));
  assert.equal(tags.length, 1);
  assert.equal(tags[0].decoder, 'bambu');
  assert.deepEqual(statuses, ['starting', 'watching']);
  assert.equal(r.status.readers[0], 'Cryptnox NFC 0');
  assert.equal(errors.length, 1);
  r.stop();
  assert.equal(r.status.state, 'off');
  assert.ok(child.killed);
});

test('TagReader restarts spoolscan if it stops, but not after stop()', async () => {
  const spawnFn = fakeSpawn();
  const r = new TagReader({ appDir: __dirname, spawnFn, env: {} });
  const t0 = setTimeout; let scheduled = 0;
  global.setTimeout = (fn, ms) => { scheduled = ms; return t0(fn, 0); };
  try {
    r.start();
    spawnFn.calls[0].child.emit('exit', 1);
    assert.equal(r.status.state, 'error');
    assert.equal(scheduled, 1000);
    await new Promise(res => t0(res, 5));
    assert.equal(spawnFn.calls.length, 2, 'relaunched');
    r.stop();
    spawnFn.calls[1].child.emit('exit', 0);
    await new Promise(res => t0(res, 5));
    assert.equal(spawnFn.calls.length, 2, 'not relaunched after stop');
  } finally { global.setTimeout = t0; r.stop(); }
});

test('TagReader reports a missing reader program clearly', () => {
  const r = new TagReader({ appDir: __dirname, env: {}, spawnFn: () => { const e = new Error('spawn spoolscan ENOENT'); e.code = 'ENOENT'; throw e; } });
  r.start();
  assert.equal(r.status.state, 'missing');
  assert.match(r.status.error, /isn’t installed/);
  r.stop();
});
