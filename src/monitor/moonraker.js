// One live connection to a printer's Moonraker JSON-RPC websocket (Klipper printers: Snapmaker U1, Voron, Creality
// K1/K2 with Moonraker, Sovol, ...). Subscribes to the printer objects the Print Monitor needs, merges the diffs
// Moonraker pushes into one `status` object, reconnects with backoff, and offers call() for JSON-RPC requests.
// Ported from U1 Studio (backend/u1studio/moonraker.py).
//
// Address: the printer's address from Settings. Moonraker answers on its own port (7125) and, on most printers, behind
// the web server on port 80. When the address has no port, port 80 is tried first (with the API key, when there is
// one) and then 7125, and the one that works is remembered.
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const WANTED = new Set(['print_stats', 'virtual_sdcard', 'display_status', 'heater_bed', 'toolhead', 'gcode_move', 'fan',
  'print_task_config', 'timelapse', 'idle_timeout', 'pause_resume', 'webhooks', 'exclude_object', 'filament_detect',
  'machine_state_manager']);
const WANTED_PREFIXES = ['extruder', 'fan_generic ', 'temperature_sensor ', 'led ', 'heater_generic '];

function baseUrls(url) {
  let s = String(url || '').trim().replace(/\/+$/, '');
  if (!s) return [];
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  if (u.port) return [u.origin];
  return [u.origin, `${u.protocol}//${u.hostname}:7125`];
}

class Connection extends EventEmitter {
  // opts: { url, apiKey, wsFactory? (for tests) }
  constructor({ url, apiKey, wsFactory }) {
    super();
    this.candidates = baseUrls(url);
    this.base = this.candidates[0] || '';
    this.apiKey = apiKey || '';
    this.wsFactory = wsFactory || ((u, o) => new WebSocket(u, o));
    this.status = {};
    this.connected = false;
    this.klippyState = 'disconnected';
    this.lastError = '';
    this.lastUpdate = 0;
    this.systemMemory = {};
    this.objects = [];
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stopped = true;
    this.backoff = 1000;
    this.timers = new Set();
    this.which = 0;   // index into candidates
  }

  start() {
    if (!this.stopped || !this.candidates.length) return;
    this.stopped = false;
    this.connect();
  }
  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t), clearInterval(t);
    this.timers.clear();
    if (this.ws) { try { this.ws.terminate(); } catch {} this.ws = null; }
    this.failPending('stopped');
    this.connected = false;
  }
  later(fn, ms) { const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms); this.timers.add(t); return t; }

  call(method, params, ms = 15000) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('The printer isn’t connected.'));
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', method, id };
    if (params !== undefined) msg.params = params;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, ms);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      try { ws.send(JSON.stringify(msg)); } catch (e) { this.pending.delete(id); clearTimeout(t); reject(e); }
    });
  }
  // A plain HTTP request to Moonraker (thumbnails, files): same base and key as the websocket
  headers(extra = {}) { return this.apiKey ? { 'X-Api-Key': this.apiKey, ...extra } : extra; }
  async fetch(path, opts = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
    try { return await fetch(this.base + path, { ...opts, headers: this.headers(opts.headers), signal: ctrl.signal }); }
    finally { clearTimeout(t); }
  }

  connect() {
    if (this.stopped) return;
    this.base = this.candidates[this.which % this.candidates.length];
    const url = this.base.replace(/^http/i, 'ws') + '/websocket';
    let ws;
    try { ws = this.wsFactory(url, { headers: this.headers(), handshakeTimeout: 6000, maxPayload: 32 * 1024 * 1024 }); }
    catch (e) { return this.lost(e); }
    this.ws = ws;
    let opened = false;
    ws.on('open', async () => {
      opened = true;
      try {
        await this.initialise();
        this.connected = true;
        this.lastError = '';
        this.backoff = 1000;
        this.emit('update', new Set(['_connection']));
        const mem = setInterval(() => this.refreshMemory().catch(() => {}), 30000);
        this.timers.add(mem);
        ws.once('close', () => { clearInterval(mem); this.timers.delete(mem); });
      } catch (e) {
        this.lastError = e.message;
        try { ws.terminate(); } catch {}
      }
    });
    ws.on('message', (data) => this.onMessage(data));
    ws.on('error', (e) => { this.lastError = e.message || String(e); });
    ws.on('unexpected-response', (_req, res) => { this.lastError = `HTTP ${res.statusCode}`; });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      // never opened: try the other address (port 80 / 7125) next time
      if (!opened && this.candidates.length > 1) this.which++;
      this.lost();
    });
  }
  lost(e) {
    if (e) this.lastError = e.message || String(e);
    const was = this.connected;
    this.connected = false;
    this.klippyState = 'disconnected';
    this.failPending('connection lost');
    if (was || this.lastUpdate) this.emit('update', new Set(['_connection']));
    if (this.stopped) return;
    this.later(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30000);
  }
  failPending(why) {
    for (const p of this.pending.values()) p.reject(new Error(why));
    this.pending.clear();
  }

  async initialise() {
    const info = await this.call('server.info');
    this.klippyState = (info && info.klippy_state) || 'unknown';
    if (this.klippyState === 'ready') await this.subscribe();
    await this.refreshMemory().catch(() => {});
  }
  async subscribe() {
    const objs = ((await this.call('printer.objects.list')) || {}).objects || [];
    this.objects = objs;
    const wanted = {};
    for (const o of objs) if (WANTED.has(o) || WANTED_PREFIXES.some(p => o.startsWith(p))) wanted[o] = null;
    const res = await this.call('printer.objects.subscribe', { objects: wanted });
    this.status = {};
    for (const [k, v] of Object.entries((res && res.status) || {})) if (/^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,80}$/.test(k) && k !== 'constructor' && v && typeof v === 'object') this.status[k] = v;
    this.lastUpdate = Date.now();
    this.emit('update', new Set(Object.keys(this.status)));
  }
  async refreshMemory() {
    const st = await this.call('machine.proc_stats');
    this.systemMemory = (st && st.system_memory) || {};
  }

  onMessage(data) {
    let m;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (m.id != null && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || String(m.error))); else p.resolve(m.result);
      return;
    }
    this.onNotification(m.method, m.params || []);
  }
  onNotification(method, params) {
    if (method === 'notify_status_update' && params[0]) {
      const changed = new Set();
      for (const [obj, diff] of Object.entries(params[0])) {
        // printer object names only (never __proto__ and the like), and plain objects as values
        if (!/^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,80}$/.test(obj) || obj === 'constructor' || !diff || typeof diff !== 'object') continue;
        this.status[obj] = { ...(this.status[obj] || {}), ...diff };
        changed.add(obj);
      }
      this.lastUpdate = Date.now();
      this.emit('update', changed);
    } else if (method === 'notify_klippy_ready') {
      this.klippyState = 'ready';
      this.subscribe().catch(e => { this.lastError = e.message; });
    } else if (method === 'notify_klippy_shutdown' || method === 'notify_klippy_disconnected') {
      this.klippyState = method.endsWith('shutdown') ? 'shutdown' : 'disconnected';
      this.emit('update', new Set(['_connection']));
    } else if (method === 'notify_history_changed') {
      this.emit('update', new Set(['_history']));
    }
  }
}

module.exports = { Connection, baseUrls };
