// Spool tag scanning and writing (NFC/RFID): runs the reader (src/nfc/worker.js) in a background utility process
// and turns what it reports into events for the Filament screen.
//
// Readers (all built in, nothing to install): USB NFC readers through Windows' smart-card system (ACR122U,
// ACR1252U, Cryptnox, HID Omnikey…), an Arduino with a PN532 shield running tools/arduino/SpoolTagBridge, or a
// PN532 board on a USB-serial adapter. Tags: Bambu Lab, Snapmaker, Creality, QIDI, Anycubic, ELEGOO, OpenSpool,
// OpenTag3D, SpoolEase and TigerTag are read; blank NTAG stickers can be written (OpenSpool or OpenTag3D).
//
// The worker's records are checked here (clean): this is the boundary between another process and the window, so
// only the fields the screen uses, with the types it expects, get through.
// No Electron imports at the top, so this can be tested with plain Node (test/nfc.test.js).
'use strict';

const { EventEmitter } = require('events');
const path = require('path');

const RESTART_DELAYS = [1000, 3000, 10000, 30000];
const STATES = new Set(['off', 'starting', 'no_service', 'no_reader', 'watching', 'error']);

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const hexColor = (v) => (typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v) ? v.toUpperCase() : null);

// A scan record from the worker -> what the window gets (null if it doesn't look right)
function clean(rec) {
  if (!rec || typeof rec !== 'object' || rec.event !== 'tag_scanned') return null;
  const tag = rec.tag || {};
  const uid = str(tag.uid, 32);
  if (!uid || !/^[0-9A-F]+$/i.test(uid)) return null;
  const out = {
    event: 'tag_scanned',
    status: ['decoded', 'unrecognized', 'read_error'].includes(rec.status) ? rec.status : 'unrecognized',
    decoder: str(rec.decoder, 40),
    spoolId: str(rec.spool_id, 80) || `uid:${uid.toUpperCase()}`,
    tag: { uid: uid.toUpperCase(), type: str(tag.type, 40) },
    reader: str(rec.reader),
    filament: null,
    extras: null,
  };
  if (!/^(bambu|uid):[0-9A-F]+$/.test(out.spoolId)) out.spoolId = `uid:${out.tag.uid}`;
  const f = rec.filament;
  if (out.status === 'decoded' && f && typeof f === 'object') {
    out.filament = {
      manufacturer: str(f.manufacturer, 80) || '',
      material: str(f.material, 40) || '',
      modifiers: Array.isArray(f.modifiers) ? f.modifiers.map(m => str(m, 40)).filter(Boolean).slice(0, 6) : [],
      colorHex: hexColor(f.color_hex),
      colorsHex: Array.isArray(f.colors_hex) ? f.colors_hex.map(hexColor).filter(Boolean).slice(0, 5) : [],
      diameterMm: num(f.diameter_mm),
      weightG: num(f.weight_g),
      nozzleMin: num(f.nozzle_temp_min_c), nozzleMax: num(f.nozzle_temp_max_c),
      bed: num(f.bed_temp_c), dryTemp: num(f.drying_temp_c), dryHours: num(f.drying_time_h),
      made: str(f.manufacturing_date, 20),
    };
  }
  const x = rec.extras;
  if (x && typeof x === 'object') {
    out.extras = { materialId: str(x.material_id, 20), variantId: str(x.material_variant_id, 20), detailedType: str(x.detailed_type, 40),
      lengthM: num(x.filament_length_m), made: str(x.production_datetime, 20), colorName: str(x.color_name, 40) };
  }
  return out;
}

// A write result from the worker -> what the window gets
function cleanWrite(m) {
  const status = ['written', 'confirm', 'too-small', 'error', 'timeout', 'cancelled', 'not-writable', 'writing'].includes(m.status) ? m.status : 'error';
  const uid = str(m.uid, 32);
  return { status, uid: uid && /^[0-9A-F]+$/.test(uid) ? uid : null, spoolId: uid && /^[0-9A-F]+$/.test(uid) ? `uid:${uid}` : null,
    message: str(m.message, 300), existing: str(m.existing, 120), readBack: str(m.readBack, 120), format: str(m.format, 20) };
}

const defaultFork = (file) => require('electron').utilityProcess.fork(file, [], { serviceName: 'Spool tag reader', stdio: 'pipe' });

class TagReader extends EventEmitter {
  constructor({ log = () => {}, forkFn = defaultFork, workerPath = path.join(__dirname, 'nfc', 'worker.js') } = {}) {
    super();
    this.log = log; this.forkFn = forkFn; this.workerPath = workerPath;
    this.child = null; this.enabled = false; this.restarts = 0; this.timer = null;
    this.cfg = { pcsc: true, reader: '', serialPort: '' };
    this.status = { state: 'off', readers: [] };
    this.pending = new Map();   // request id -> { resolve, timer, kind }
    this.seq = 0;
  }

  setStatus(s) { this.status = { readers: [], ...s }; this.emit('status', this.status); }

  start(cfg = {}) {
    this.enabled = true;
    this.cfg = { pcsc: cfg.pcsc !== false, reader: String(cfg.reader || '').slice(0, 100), serialPort: String(cfg.serialPort || '').slice(0, 20) };
    if (!this.child) this.launch();
    else this.post({ type: 'config', ...this.cfg });
  }

  stop() {
    this.enabled = false;
    clearTimeout(this.timer); this.timer = null;
    if (this.child) {
      const c = this.child; this.child = null;
      try { c.postMessage({ type: 'stop' }); } catch {}
      setTimeout(() => { try { c.kill(); } catch {} }, 1000);
    }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve(p.kind === 'write' ? { status: 'cancelled' } : null); }
    this.pending.clear();
    this.setStatus({ state: 'off' });
  }

  post(m) { if (this.child) { try { this.child.postMessage(m); } catch (e) { this.log(`spool tag reader: ${e.message}`); } } }

  launch() {
    this.setStatus({ state: 'starting' });
    let child;
    try { child = this.forkFn(this.workerPath); } catch (e) { return this.failed(e); }
    this.child = child;
    const started = Date.now();
    child.on('message', (m) => { if (this.child === child) this.onMessage(m); });
    if (child.stderr) child.stderr.on('data', (t) => String(t).split(/\r?\n/).filter(l => l.trim()).forEach(l => this.log(`spool tag reader: ${l.trim().slice(0, 500)}`)));
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.enabled) return;
      if (Date.now() - started > 60000) this.restarts = 0;
      const delay = RESTART_DELAYS[Math.min(this.restarts++, RESTART_DELAYS.length - 1)];
      this.log(`spool tag reader stopped (code ${code}); restarting in ${delay / 1000} s`);
      this.setStatus({ state: 'error', error: 'The tag reader stopped; restarting…' });
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve(p.kind === 'write' ? { status: 'error', message: 'The tag reader stopped. Try again.' } : null); }
      this.pending.clear();
      this.timer = setTimeout(() => { if (this.enabled && !this.child) this.launch(); }, delay);
    });
    this.post({ type: 'config', ...this.cfg });
  }

  failed(e) {
    this.log(`spool tag reader: couldn't start (${e && e.message})`);
    this.setStatus({ state: 'error', error: `Couldn’t start the tag reader: ${e && e.message}` });
  }

  onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'status') {
      if (!STATES.has(m.state)) return;
      this.setStatus({ state: m.state, readers: Array.isArray(m.readers) ? m.readers.map(r => str(r)).filter(Boolean).slice(0, 8) : [], error: str(m.error, 300) });
    } else if (m.type === 'tag') {
      const ev = clean(m.record);
      if (ev) this.emit('tag', ev);
    } else if (m.type === 'log') {
      this.log(`spool tag reader: ${str(m.line, 500)}`);
    } else if (m.type === 'write-progress') {
      this.emit('write-progress', { id: m.id, ...cleanWrite(m) });
    } else if (['write-result', 'ports', 'port-test'].includes(m.type)) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.type === 'write-result') p.resolve(cleanWrite(m));
      else if (m.type === 'ports') p.resolve({ open: str(m.open, 20), ports: Array.isArray(m.ports) ? m.ports.slice(0, 64).map(x => ({
        port: str(x.port, 10), name: str(x.name, 80), arduino: !!x.arduino })).filter(x => /^COM\d+$/.test(x.port || '')) : [] });
      else p.resolve({ ok: !!m.ok, kind: str(m.kind, 10), name: str(m.name, 80), version: str(m.version, 60), error: str(m.error, 300) });
    }
  }

  request(kind, msg, timeoutMs) {
    if (!this.child) return Promise.resolve(kind === 'write' ? { status: 'error', message: 'Turn on spool tags in Settings first.' } : null);
    const id = `${kind}-${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(kind === 'write' ? { status: 'timeout' } : null); }, timeoutMs);
      this.pending.set(id, { resolve, timer, kind });
      this.post({ ...msg, id });
    });
  }

  // Arm a write: the next sticker tapped gets the filament. Resolves with the outcome (see cleanWrite).
  write({ format, filament, overwriteUid, overwriteAny = false, timeoutMs = 90000 }) {
    if (this.writeId) this.cancelWrite();
    const id = `write-${this.seq + 1}`;   // the id request() is about to use
    const p = this.request('write', { type: 'write', format, filament, overwriteUid, overwriteAny: !!overwriteAny, timeoutMs }, timeoutMs + 5000);
    this.writeId = this.child ? id : null;
    return p.finally(() => { if (this.writeId === id) this.writeId = null; });
  }
  cancelWrite() { if (this.writeId) this.post({ type: 'cancel-write', id: this.writeId }); this.writeId = null; }
  // Settings can list and test ports while scanning is off: start the worker idle (it reads no tags)
  idle() { if (!this.child) { const cfg = this.cfg; this.cfg = { pcsc: false, reader: '', serialPort: '' }; this.launch(); this.cfg = cfg; } }
  listPorts() { this.idle(); return this.request('ports', { type: 'list-ports' }, 8000); }
  testPort(port) { this.idle(); return this.request('port-test', { type: 'test-port', port }, 15000); }
}

module.exports = { TagReader, clean, cleanWrite };
