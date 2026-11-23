// A printer's camera: frames are fetched once (however many screens are watching) and shared.
// Ported from U1 Studio (backend/u1studio/camera.py), which ported snapmaker_camera_pulse.py from the Home Assistant
// dashboard repo.
//   mode 'u1'       http://<host>/server/files/camera/monitor.jpg polled every intervalMs (Snapmaker U1)
//   mode 'snapshot' any still-image URL, polled (most Klipper webcams: .../webcam/?action=snapshot)
//   mode 'mjpeg'    any multipart MJPEG stream; frames are cut out of the byte stream
//   mode 'off'
// Keep-alive (U1): the U1 only refreshes monitor.jpg while something has recently called its `camera.start_monitor`
// over the port-80 websocket with ?token=<API key>; sent every 60 s while the camera is needed.
// A picture that stops changing for 15 s is reported as "asleep".
const crypto = require('crypto');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const KEEPALIVE_EVERY = 60000;
const VIEWER_GRACE = 30000;   // keep fetching this long after the last viewer asked for a frame
const STALE_AFTER = 15000;

class Camera extends EventEmitter {
  // cfg: { host, port80Base (http://host[:port]), mode, url, intervalMs, keepalive, apiKey }
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.frame = null; this.frameTs = 0; this.frameId = 0;
    this.lastHash = ''; this.lastChange = 0;
    this.error = '';
    this.keepaliveStatus = 'not sent yet'; this.keepaliveTs = 0;
    this.forced = false;          // set by the printer watcher while a print runs
    this.viewerTs = 0;
    this.stopped = true;
    this.waiters = new Set();
  }
  get mode() { return this.cfg.mode || 'u1'; }
  touch() { this.viewerTs = Date.now(); if (!this.stopped) this.kick(); }
  get active() { return this.mode !== 'off' && (this.forced || Date.now() - this.viewerTs < VIEWER_GRACE); }
  get stale() { return !!this.frame && this.active && Date.now() - this.lastChange > STALE_AFTER; }
  info() {
    const now = Date.now();
    return {
      mode: this.mode, interval_ms: this.cfg.intervalMs || 1000, has_frame: !!this.frame,
      frame_age: this.frame ? Math.round((now - this.frameTs) / 100) / 10 : null,
      unchanged_for: this.frame ? Math.round((now - this.lastChange) / 100) / 10 : null,
      stale: this.stale, error: this.error, keepalive: this.keepaliveStatus,
      keepalive_age: this.keepaliveTs ? Math.round((now - this.keepaliveTs) / 1000) : null,
      frame_id: this.frameId,
    };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop();
    this.kaLoop();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.loopTimer); clearTimeout(this.kaTimer);
    if (this.mjpegAbort) this.mjpegAbort.abort();
    for (const w of this.waiters) w(null);
    this.waiters.clear();
  }
  kick() { if (this.sleeping) { clearTimeout(this.loopTimer); this.sleeping = false; this.loop(); } if (this.kaSleeping) { clearTimeout(this.kaTimer); this.kaSleeping = false; this.kaLoop(); } }

  // The next frame after `afterId` (or the current one if newer), waiting up to `ms`.
  waitFrame(afterId, ms = 10000) {
    this.touch();
    if (this.frame && this.frameId !== afterId) return Promise.resolve({ id: this.frameId, data: this.frame });
    return new Promise((resolve) => {
      const done = (f) => { clearTimeout(t); this.waiters.delete(done); resolve(f ? { id: this.frameId, data: f } : { id: this.frameId, data: this.frame }); };
      const t = setTimeout(() => done(null), ms);
      this.waiters.add(done);
    });
  }
  // A brand-new frame straight from the source (the 99 % photo).
  async freshSnapshot(ms = 6000) {
    try {
      if (this.mode === 'mjpeg') { this.touch(); return (await this.waitFrame(this.frameId, ms)).data; }
      if (this.mode === 'off') return null;
      const r = await this.get(this.stillUrl(), ms);
      return r || this.frame;
    } catch { return this.frame; }
  }

  stillUrl() {
    const base = this.mode === 'snapshot' && this.cfg.url ? this.cfg.url : `${this.cfg.port80Base}/server/files/camera/monitor.jpg`;
    return base + (base.includes('?') ? '&' : '?') + 't=' + Date.now();
  }
  async get(url, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error(`camera: HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('the camera returned something that isn’t a JPEG picture');
      return buf;
    } finally { clearTimeout(t); }
  }
  publish(data) {
    const h = crypto.createHash('md5').update(data).digest('hex');
    const now = Date.now();
    if (h !== this.lastHash) { this.lastHash = h; this.lastChange = now; }
    this.frame = data; this.frameTs = now; this.frameId++;
    for (const w of [...this.waiters]) w(data);
    this.emit('frame', this.frameId);
  }

  async loop() {
    if (this.stopped) return;
    if (!this.active) { this.sleeping = true; this.loopTimer = setTimeout(() => { this.sleeping = false; this.loop(); }, 1000); return; }
    const t0 = Date.now();
    let wait = Math.max(200, (this.cfg.intervalMs || 1000));
    try {
      if (this.mode === 'mjpeg' && this.cfg.url) { await this.readMjpeg(this.cfg.url); wait = 500; }
      else { this.publish(await this.get(this.stillUrl(), 5000)); this.error = ''; wait = Math.max(200, wait - (Date.now() - t0)); }
    } catch (e) { this.error = e.name === 'AbortError' ? 'the camera didn’t answer' : (e.message || String(e)); wait = 3000; }
    if (!this.stopped) this.loopTimer = setTimeout(() => this.loop(), wait);
  }
  async readMjpeg(url) {
    const ctrl = new AbortController();
    this.mjpegAbort = ctrl;
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`camera: HTTP ${r.status}`);
    let buf = Buffer.alloc(0);
    try {
      for await (const chunk of r.body) {
        buf = Buffer.concat([buf, Buffer.from(chunk)]);
        for (;;) {
          const s = buf.indexOf(Buffer.from([0xff, 0xd8]));
          const e = s >= 0 ? buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2) : -1;
          if (s < 0 || e < 0) { if (buf.length > 8 * 1024 * 1024) buf = Buffer.alloc(0); break; }
          this.publish(Buffer.from(buf.subarray(s, e + 2)));
          this.error = '';
          buf = buf.subarray(e + 2);
        }
        if (!this.active || this.stopped) { ctrl.abort(); return; }
      }
    } catch (e) { if (e.name !== 'AbortError') throw e; }
  }

  async kaLoop() {
    if (this.stopped) return;
    if (this.active && this.mode === 'u1' && this.cfg.keepalive !== false) {
      await this.sendKeepalive();
      if (!this.stopped) this.kaTimer = setTimeout(() => this.kaLoop(), KEEPALIVE_EVERY);
    } else { this.kaSleeping = true; this.kaTimer = setTimeout(() => { this.kaSleeping = false; this.kaLoop(); }, 1000); }
  }
  sendKeepalive() {
    const key = this.cfg.apiKey;
    if (!key) { this.keepaliveStatus = 'no API key (add it to this printer in Settings)'; return Promise.resolve(false); }
    const url = `${this.cfg.port80Base.replace(/^http/i, 'ws')}/websocket?token=${encodeURIComponent(key)}`;
    return new Promise((resolve) => {
      let ws, done = false;
      const finish = (ok, status) => {
        if (done) return; done = true;
        clearTimeout(t);
        this.keepaliveStatus = status;
        if (ok) this.keepaliveTs = Date.now();
        try { ws && ws.close(); } catch {}
        resolve(ok);
      };
      const t = setTimeout(() => finish(true, 'ok'), 4000);   // no reply in time: sent anyway (U1 Studio did the same)
      try { ws = new WebSocket(url, { handshakeTimeout: 5000 }); } catch (e) { return finish(false, `failed: ${e.message}`); }
      ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'camera.start_monitor', params: { domain: 'lan', interval: 0 }, id: 1 })));
      ws.on('message', (d) => {
        let m; try { m = JSON.parse(String(d)); } catch { return; }
        if (m.id !== 1) return;
        if (m.error) finish(false, `the printer replied with an error: ${String(m.error.message || JSON.stringify(m.error)).slice(0, 160)}`);
        else finish(true, 'ok');
      });
      ws.on('unexpected-response', (_q, res) => finish(false, `refused (HTTP ${res.statusCode}): check the API key`));
      ws.on('error', (e) => finish(false, `failed: ${e.message}`));
    });
  }
}

module.exports = { Camera };
