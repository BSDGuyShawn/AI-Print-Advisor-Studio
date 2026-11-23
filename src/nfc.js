// Spool tag scanning (NFC/RFID): runs the bundled reader program (spoolscan, built from tools/spoolscan) in the
// background and turns its output into events for the Filament screen.
//
// spoolscan talks to a USB smart-card (PC/SC) reader, reads the tag on a filament spool (Bambu Lab, Snapmaker,
// Creality, QIDI, Anycubic, Elegoo, OpenSpool, TigerTag…) and prints one JSON line per event:
//   {"event":"tag_scanned", "status":"decoded"|"unrecognized"|"read_error", "spool_id", "tag":{uid,type}, "filament":{…}}
//   {"event":"reader_status", "state":"no_service"|"no_reader"|"watching", "readers":[…]}
//   {"event":"read_error", "error":"…"}
// It only ever reads tags; it has no way to write one.
//
// No Electron imports here, so this can be tested with plain Node (test/nfc.test.js).
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const MAX_LINE = 256 * 1024;          // a tag record is ~2 KB; anything far bigger is not ours
const RESTART_DELAYS = [1000, 3000, 10000, 30000];
const EVENTS = new Set(['tag_scanned', 'reader_status', 'read_error']);
const STATES = new Set(['no_service', 'no_reader', 'watching']);

// Where to find the reader program: next to the app (release builds ship it there), an override for testing,
// or one installed with `pip install tools/spoolscan` (on PATH) when running from source.
function locate(appDir, env = process.env, platform = process.platform) {
  if (env.AIPA_SPOOLSCAN) return { cmd: env.AIPA_SPOOLSCAN, bundled: false };
  const exe = path.join(appDir, 'spoolscan', platform === 'win32' ? 'spoolscan.exe' : 'spoolscan');
  if (fs.existsSync(exe)) return { cmd: exe, bundled: true };
  return { cmd: 'spoolscan', bundled: false };
}

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const hexColor = (v) => (typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v) ? v.toUpperCase() : null);

// Keep only the fields the screen uses, with the types it expects. The reader is our own program, but this is
// the boundary between another process and the window, so nothing unexpected gets through.
function clean(rec) {
  if (!rec || typeof rec !== 'object' || !EVENTS.has(rec.event)) return null;
  if (rec.event === 'reader_status') {
    if (!STATES.has(rec.state)) return null;
    return { event: rec.event, state: rec.state, readers: Array.isArray(rec.readers) ? rec.readers.map(r => str(r)).filter(Boolean).slice(0, 8) : [] };
  }
  if (rec.event === 'read_error') return { event: rec.event, error: str(rec.error, 300) || 'read failed', reader: str(rec.reader) };
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
      lengthM: num(x.filament_length_m), made: str(x.production_datetime, 20) };
  }
  return out;
}

class TagReader extends EventEmitter {
  constructor({ appDir, log = () => {}, spawnFn = spawn, env = process.env } = {}) {
    super();
    this.appDir = appDir;
    this.log = log;
    this.spawnFn = spawnFn;
    this.env = env;
    this.child = null;
    this.enabled = false;
    this.restarts = 0;
    this.timer = null;
    this.status = { state: 'off', readers: [] };
  }

  setStatus(s) {
    this.status = { readers: [], ...s };
    this.emit('status', this.status);
  }

  start({ reader } = {}) {
    this.enabled = true;
    this.readerFilter = reader || '';
    if (!this.child) this.launch();
  }

  stop() {
    this.enabled = false;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.child) { try { this.child.kill(); } catch {} this.child = null; }
    this.setStatus({ state: 'off' });
  }

  launch() {
    const { cmd, bundled } = locate(this.appDir, this.env);
    const args = ['watch', '--emit-status', '--dedupe', '3'];
    if (this.readerFilter) args.push('--reader', this.readerFilter);
    this.setStatus({ state: 'starting' });
    let child;
    try {
      child = this.spawnFn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return this.failed(e, bundled);
    }
    this.child = child;
    const started = Date.now();
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_LINE && !buf.includes('\n')) { buf = ''; return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (t) => { for (const l of String(t).split(/\r?\n/)) if (l.trim()) this.log(`spoolscan: ${l.trim().slice(0, 500)}`); });
    child.on('error', (e) => { if (this.child === child) { this.child = null; this.failed(e, bundled); } });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.enabled) return;
      if (Date.now() - started > 60000) this.restarts = 0;   // it ran fine for a while: start the back-off over
      const delay = RESTART_DELAYS[Math.min(this.restarts++, RESTART_DELAYS.length - 1)];
      this.log(`spoolscan stopped (code ${code}); restarting in ${delay / 1000} s`);
      this.setStatus({ state: 'error', error: 'The tag reader program stopped; restarting…' });
      this.timer = setTimeout(() => { if (this.enabled && !this.child) this.launch(); }, delay);
    });
  }

  failed(e, bundled) {
    const missing = e && e.code === 'ENOENT';
    this.log(`spoolscan: couldn't start (${e && e.message})`);
    this.setStatus({ state: missing ? 'missing' : 'error',
      error: missing ? (bundled ? 'The tag reader program is missing from this copy of the app.' : 'The tag reader program isn’t installed.') : `Couldn’t start the tag reader: ${e && e.message}` });
  }

  onLine(line) {
    if (line.length > MAX_LINE) return;
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    const ev = clean(rec);
    if (!ev) return;
    if (ev.event === 'reader_status') this.setStatus({ state: ev.state, readers: ev.readers });
    else if (ev.event === 'read_error') this.emit('read-error', ev);
    else this.emit('tag', ev);
  }
}

module.exports = { TagReader, clean, locate };
