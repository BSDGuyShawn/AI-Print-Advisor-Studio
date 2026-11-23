// Tests for src/nfc.js: the boundary between the reader process and the window. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { TagReader, clean, cleanWrite } = require('../src/nfc');

const BAMBU = {
  event: 'tag_scanned', reader: 'Cryptnox NFC 0', status: 'decoded', decoder: 'bambu',
  spool_id: 'bambu:D7AC3B89A16B47C4B061728044E1F2D5', tag: { uid: '75886B1D', type: 'MifareClassic1k', atr: '3B8F' },
  filament: { manufacturer: 'Bambu', material: 'PLA', modifiers: ['Basic'], name: 'Bambu PLA Basic', color_hex: '#ff6a13',
    colors_hex: ['#FF6A13'], diameter_mm: 1.75, weight_g: 1000, nozzle_temp_min_c: 190, nozzle_temp_max_c: 230, bed_temp_c: 45,
    drying_temp_c: 55, drying_time_h: 8, manufacturing_date: '2022-10-15', product_id: 'x' },
  extras: { tray_uid: 'D7AC', material_id: 'GFA00', material_variant_id: 'A00-A0', detailed_type: 'PLA Basic', filament_length_m: 330 },
};

// a stand-in for Electron's utility process
function fakeFork() {
  const calls = [];
  const fn = (file) => {
    const child = new EventEmitter();
    child.sent = [];
    child.postMessage = (m) => child.sent.push(m);
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', 0)); };
    calls.push({ file, child });
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
  const odd = clean({ ...BAMBU, filament: { ...BAMBU.filament, color_hex: 'red; background:url(x)', weight_g: '1000' } });
  assert.equal(odd.filament.colorHex, null);
  assert.equal(odd.filament.weightG, null);
  const unk = clean({ event: 'tag_scanned', status: 'unrecognized', tag: { uid: 'deadbeef', type: 'MifareClassic1k' }, filament: null });
  assert.equal(unk.spoolId, 'uid:DEADBEEF');
  assert.equal(unk.filament, null);
  assert.equal(clean({ ...BAMBU, spool_id: 'javascript:alert(1)' }).spoolId, 'uid:75886B1D', 'spool ids are only bambu:/uid: hex');
});

test('cleanWrite only passes known statuses and hex ids', () => {
  assert.deepEqual(cleanWrite({ status: 'written', uid: '04A1B2C3D4E5F6' }).spoolId, 'uid:04A1B2C3D4E5F6');
  assert.equal(cleanWrite({ status: 'weird', uid: '<b>' }).status, 'error');
  assert.equal(cleanWrite({ status: 'confirm', uid: '<b>' }).uid, null);
});

test('TagReader starts the worker, passes config, and turns its messages into events', async () => {
  const fork = fakeFork();
  const r = new TagReader({ forkFn: fork, workerPath: 'worker.js' });
  const tags = [], statuses = [];
  r.on('tag', t => tags.push(t)); r.on('status', s => statuses.push(s.state));
  r.start({ pcsc: true, serialPort: 'COM11' });
  const child = fork.calls[0].child;
  assert.deepEqual(child.sent[0], { type: 'config', pcsc: true, reader: '', serialPort: 'COM11' });
  child.emit('message', { type: 'status', state: 'watching', readers: ['Arduino on COM11'] });
  child.emit('message', { type: 'tag', record: BAMBU });
  child.emit('message', { type: 'tag', record: { event: 'tag_scanned', tag: { uid: 'zz' } } });   // dropped
  child.emit('message', { type: 'status', state: 'hacked' });                                    // dropped
  assert.equal(tags.length, 1);
  assert.equal(tags[0].decoder, 'bambu');
  assert.deepEqual(statuses, ['starting', 'watching']);
  assert.deepEqual(r.status.readers, ['Arduino on COM11']);
  r.start({ pcsc: false, serialPort: '' });   // a config change goes to the running worker
  assert.deepEqual(child.sent.at(-1), { type: 'config', pcsc: false, reader: '', serialPort: '' });
  assert.equal(fork.calls.length, 1);
  r.stop();
  assert.deepEqual(child.sent.at(-1), { type: 'stop' });
});

test('a write resolves with the worker’s result; progress comes as events', async () => {
  const fork = fakeFork();
  const r = new TagReader({ forkFn: fork });
  r.start({});
  const child = fork.calls[0].child;
  const progress = [];
  r.on('write-progress', p => progress.push(p.status));
  const p = r.write({ format: 'openspool', filament: { brand: 'X' } });
  const msg = child.sent.at(-1);
  assert.equal(msg.type, 'write');
  child.emit('message', { type: 'write-progress', id: msg.id, status: 'not-writable', message: 'MIFARE Classic' });
  child.emit('message', { type: 'write-result', id: msg.id, status: 'written', uid: '04AABBCCDDEEFF' });
  const res = await p;
  assert.equal(res.status, 'written');
  assert.equal(res.spoolId, 'uid:04AABBCCDDEEFF');
  assert.deepEqual(progress, ['not-writable']);
  r.stop();
});

test('the worker restarts after it stops unexpectedly, and an open write is answered', async () => {
  const fork = fakeFork();
  const r = new TagReader({ forkFn: fork });
  r.start({});
  const p = r.write({ format: 'openspool', filament: {} });
  fork.calls[0].child.emit('exit', 1);
  assert.equal((await p).status, 'error');
  assert.equal(r.status.state, 'error');
  await new Promise(res => setTimeout(res, 1100));
  assert.equal(fork.calls.length, 2, 'restarted');
  r.stop();
});

test('ports can be listed while scanning is off (the worker starts idle)', async () => {
  const fork = fakeFork();
  const r = new TagReader({ forkFn: fork });
  const p = r.listPorts();
  const child = fork.calls[0].child;
  assert.deepEqual(child.sent[0], { type: 'config', pcsc: false, reader: '', serialPort: '' });
  const req = child.sent.at(-1);
  child.emit('message', { type: 'ports', id: req.id, ports: [{ port: 'COM11', name: 'Arduino Leonardo', arduino: true }, { port: 'LPT1' }] });
  assert.deepEqual((await p).ports, [{ port: 'COM11', name: 'Arduino Leonardo', arduino: true }]);
  r.stop();
});
