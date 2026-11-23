// Preview pictures of the print, drawn from its G-code: the whole model from a second angle, and the model filling in
// layer by layer. Ported from snapmaker_gcode_preview.py (Home Assistant dashboard repo, via U1 Studio's
// backend/u1studio/gcode_preview.py). No libraries: a line drawer, 2x supersampling, PNG written with zlib.
//
// Runs in a worker thread (see PreviewWorker below): parsing a big G-code file and drawing a few hundred thousand lines
// would otherwise hold up the app. The parsed G-code of the last few files is kept in the worker, so the
// layer-by-layer picture every few minutes doesn't download the file again.
const zlib = require('zlib');
const path = require('path');

const SIZE = 560, SS = 2;
const BG = [28, 28, 28], GHOST = [62, 72, 90], FOOT = [74, 84, 102];
const GRADIENT = [[56, 189, 248], [167, 139, 250], [244, 114, 182]];
const MAX_SEGS = 350000;

// ---------------------------------------------------------------- G-code parsing (streamed)
// Segments of every extruding move: one Float32Array of x0 y0 x1 y1 tool, plus which layer and whether it's support.
class Parser {
  constructor() {
    this.x = 0; this.y = 0; this.z = 0; this.e = 0; this.absXYZ = true; this.absE = true;
    this.tool = 0; this.support = false; this.hdrColors = null;
    this.seg = new Float32Array(1 << 16); this.n = 0;   // floats used
    this.segLayer = new Int32Array(1 << 14); this.segSupport = new Uint8Array(1 << 14); this.count = 0;
    this.layerZ = []; this.layerOff = []; this.curZ = null;
    this.minx = 1e9; this.miny = 1e9; this.maxx = -1e9; this.maxy = -1e9; this.maxz = 0;
    this.offset = 0; this.rest = '';
  }
  push(x0, y0, x1, y1) {
    if (this.n + 5 > this.seg.length) { const s = new Float32Array(this.seg.length * 2); s.set(this.seg); this.seg = s; }
    if (this.count + 1 > this.segLayer.length) {
      const a = new Int32Array(this.segLayer.length * 2); a.set(this.segLayer); this.segLayer = a;
      const b = new Uint8Array(this.segSupport.length * 2); b.set(this.segSupport); this.segSupport = b;
    }
    this.seg.set([x0, y0, x1, y1, this.tool], this.n); this.n += 5;
    this.segLayer[this.count] = this.layerZ.length - 1; this.segSupport[this.count] = this.support ? 1 : 0; this.count++;
  }
  // text arrives in chunks; byte offsets are counted for "how far the printer has read" (file_position)
  write(chunk) {
    const text = this.rest + chunk;
    const lines = text.split('\n');
    this.rest = lines.pop();
    for (const l of lines) this.line(l + '\n');
  }
  end() { if (this.rest) this.line(this.rest); this.rest = ''; }
  line(raw) {
    const start = this.offset;
    this.offset += Buffer.byteLength(raw);
    const c0 = raw.charCodeAt(0);
    if (!raw || c0 === 59 || c0 === 10 || c0 === 13) {   // comment or empty
      if (raw.startsWith(';TYPE:')) this.support = /support/i.test(raw);
      else if (c0 === 59 && /filament_colou?r/i.test(raw.slice(0, 40)) && raw.includes('=')) {
        this.hdrColors = raw.split('=', 2)[1].replace(/,/g, ';').split(';').map(s => s.trim().replace(/^"|"$/g, ''));
      }
      return;
    }
    const code = raw.split(';', 1)[0].trim().split(/\s+/);
    if (!code[0]) return;
    const cmd = code[0].toUpperCase();
    if (cmd[0] === 'T' && /^T\d+$/.test(cmd)) { this.tool = +cmd.slice(1); return; }
    if (cmd === 'G1' || cmd === 'G0' || cmd === 'G2' || cmd === 'G3' || cmd === 'G01' || cmd === 'G00') {
      let nx = this.x, ny = this.y, nz = this.z, ne = null;
      for (let i = 1; i < code.length; i++) {
        const p = code[i], c = p[0].toUpperCase(), v = parseFloat(p.slice(1));
        if (!Number.isFinite(v)) continue;
        if (c === 'X') nx = this.absXYZ ? v : this.x + v;
        else if (c === 'Y') ny = this.absXYZ ? v : this.y + v;
        else if (c === 'Z') nz = this.absXYZ ? v : this.z + v;
        else if (c === 'E') ne = v;
      }
      let de = 0;
      if (ne != null) { if (this.absE) { de = ne - this.e; this.e = ne; } else de = ne; }
      if (de > 0 && (nx !== this.x || ny !== this.y)) {
        if (this.curZ == null || Math.abs(nz - this.curZ) > 0.004) { this.layerZ.push(nz); this.layerOff.push(start); this.curZ = nz; }
        this.push(this.x, this.y, nx, ny);
        this.minx = Math.min(this.minx, this.x, nx); this.miny = Math.min(this.miny, this.y, ny);
        this.maxx = Math.max(this.maxx, this.x, nx); this.maxy = Math.max(this.maxy, this.y, ny);
        if (nz > this.maxz) this.maxz = nz;
      }
      this.x = nx; this.y = ny; this.z = nz;
    } else if (cmd === 'G90') this.absXYZ = true;
    else if (cmd === 'G91') this.absXYZ = false;
    else if (cmd === 'M82') this.absE = true;
    else if (cmd === 'M83') this.absE = false;
    else if (cmd === 'G92') { for (let i = 1; i < code.length; i++) if (code[i][0].toUpperCase() === 'E') { const v = parseFloat(code[i].slice(1)); if (Number.isFinite(v)) this.e = v; } }
  }
  result() {
    if (!this.layerZ.length) throw new Error('no extruding moves found in the G-code');
    return { headerColors: this.hdrColors, seg: this.seg.subarray(0, this.n), segLayer: this.segLayer.subarray(0, this.count),
      segSupport: this.segSupport.subarray(0, this.count), count: this.count, layerZ: this.layerZ, layerOff: this.layerOff,
      bbox: [this.minx, this.miny, 0, this.maxx, this.maxy, this.maxz] };
  }
}
function parseGcode(text) { const p = new Parser(); p.write(text); p.end(); return p.result(); }

// ---------------------------------------------------------------- drawing
class Canvas {
  constructor(size, ss) {
    this.size = size; this.ss = ss; this.n = size * ss;
    this.buf = new Uint8Array(this.n * this.n * 3);
    for (let i = 0; i < this.buf.length; i += 3) { this.buf[i] = BG[0]; this.buf[i + 1] = BG[1]; this.buf[i + 2] = BG[2]; }
  }
  line(x0, y0, x1, y1, [r, g, b]) {
    const n = this.n, buf = this.buf;
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    if ((x0 < 0 && x1 < 0) || (y0 < 0 && y1 < 0) || (x0 >= n - 1 && x1 >= n - 1) || (y0 >= n && y1 >= n)) return;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, guard = 4 * n;
    for (;;) {
      if (x0 >= 0 && x0 < n - 1 && y0 >= 0 && y0 < n) {
        const i = (y0 * n + x0) * 3;
        buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = r; buf[i + 4] = g; buf[i + 5] = b;
      }
      if ((x0 === x1 && y0 === y1) || --guard < 0) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  png() {
    const { n, ss, size, buf } = this;
    const raw = Buffer.alloc(size * (size * 3 + 1));
    const div = ss * ss;
    let o = 0;
    for (let oy = 0; oy < size; oy++) {
      raw[o++] = 0;
      for (let ox = 0; ox < size; ox++) {
        for (let c = 0; c < 3; c++) {
          let acc = 0;
          for (let ky = 0; ky < ss; ky++) for (let kx = 0; kx < ss; kx++) acc += buf[((oy * ss + ky) * n + ox * ss + kx) * 3 + c];
          raw[o++] = (acc / div) | 0;
        }
      }
    }
    return encodePng(size, size, raw);
  }
}
const CRC = (() => { const t = new Int32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c; } return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(tag, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(tag, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, raw) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
function lerpColor(t) {
  t = Math.max(0, Math.min(1, t)) * (GRADIENT.length - 1);
  const i = Math.min(t | 0, GRADIENT.length - 2), f = t - i, a = GRADIENT[i], b = GRADIENT[i + 1];
  return [0, 1, 2].map(k => (a[k] + (b[k] - a[k]) * f) | 0);
}
const tint = (rgb, f) => rgb.map(c => Math.max(0, Math.min(255, (c * f) | 0)));
const usable = (rgb) => (Math.max(...rgb) < 90 ? rgb.map(c => (c * 0.5 + 70) | 0) : rgb);   // lift black so it shows on dark
function parseHex(v) {
  const s = String(v == null ? '' : v).trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return null;
  return usable([0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)));
}
function projector(bbox, yaw, pitch, sizePx) {
  const cy = Math.cos(yaw * Math.PI / 180), sy = Math.sin(yaw * Math.PI / 180), cp = Math.cos(pitch * Math.PI / 180), sp = Math.sin(pitch * Math.PI / 180);
  const [minx, miny, minz, maxx, maxy, maxz] = bbox;
  const ox = (minx + maxx) / 2, oy = (miny + maxy) / 2;
  const raw = (x, y, z) => { x -= ox; y -= oy; const xr = x * cy - y * sy, yr = x * sy + y * cy; return [xr, z * cp + yr * sp]; };
  const pts = [];
  for (const x of [minx, maxx]) for (const y of [miny, maxy]) for (const z of [minz, maxz]) pts.push(raw(x, y, z));
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const w = Math.max(...xs) - Math.min(...xs) || 1, h = Math.max(...ys) - Math.min(...ys) || 1;
  const scale = sizePx * (1 - 2 * 0.09) / Math.max(w, h);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cyv = (Math.max(...ys) + Math.min(...ys)) / 2, half = sizePx / 2;
  return (x, y, z) => { const [a, b] = raw(x, y, z); return [half + (a - cx) * scale, half - (b - cyv) * scale]; };
}
// printed = layers already printed (null = everything finished)
function render(parsed, yaw, pitch, printed = null, hideSupports = false, toolColors = null) {
  const { seg, segLayer, segSupport, count, layerZ, bbox } = parsed;
  const canvas = new Canvas(SIZE, SS);
  const proj = projector(bbox, yaw, pitch, canvas.n);
  const [minx, miny, , maxx, maxy] = bbox;
  const pad = 0.06 * Math.max(maxx - minx, maxy - miny);
  const corners = [[minx - pad, miny - pad], [maxx + pad, miny - pad], [maxx + pad, maxy + pad], [minx - pad, maxy + pad]];
  for (let i = 0; i < 4; i++) { const a = proj(corners[i][0], corners[i][1], 0), b = proj(corners[(i + 1) % 4][0], corners[(i + 1) % 4][1], 0); canvas.line(a[0], a[1], b[0], b[1], FOOT); }
  const total = layerZ.length;
  let segTotal = 0;
  for (let i = 0; i < count; i++) if (!(hideSupports && segSupport[i])) segTotal++;
  const stride = segTotal > MAX_SEGS ? Math.ceil(segTotal / MAX_SEGS) : 1;
  const last = printed == null ? null : Math.max(0, Math.min(total, printed) - 1);
  const drawLayer = (li) => li % stride === 0 || li === total - 1 || li === last;
  const top = Math.max(...layerZ) || 1;
  // in file order, i.e. layer by layer from the bottom, so higher layers draw over lower ones
  {
    for (let i = 0; i < count; i++) {
      if (hideSupports && segSupport[i]) continue;
      const li = segLayer[i];
      if (!drawLayer(li)) continue;
      const done = printed == null || li < printed;
      const glow = printed != null && done && li >= printed - 2;
      const z = layerZ[li], shade = 0.6 + 0.4 * (z / top);
      const grad = done ? (glow ? [250, 250, 250] : lerpColor(z / top)) : GHOST;
      let color = grad;
      if (toolColors && done) {
        const base = toolColors[seg[i * 5 + 4] | 0] || toolColors[0];
        if (base) color = glow ? base.map(c => (c + 255) >> 1) : tint(base, shade);
      }
      const [x0, y0] = proj(seg[i * 5], seg[i * 5 + 1], z), [x1, y1] = proj(seg[i * 5 + 2], seg[i * 5 + 3], z);
      canvas.line(x0, y0, x1, y1, color);
    }
  }
  return canvas.png();
}
function placeholderPng() {
  const c = new Canvas(SIZE, SS), n = c.n;
  for (let i = 0; i < 3; i++) { const w = ((n / 3) | 0) + ((i * n / 12) | 0), y = ((n / 2) | 0) + (((i - 1) * n / 14) | 0); c.line(n / 2 - w / 2, y, n / 2 + w / 2, y, FOOT); }
  return c.png();
}
// How many layers the printer has done: from how far it has read the file, else the layer count
function printedLayers(parsed, st) {
  const total = parsed.layerZ.length;
  if (st.state === 'complete') return total;
  if (st.filePosition) { let lo = 0, hi = parsed.layerOff.length; while (lo < hi) { const m = (lo + hi) >> 1; if (parsed.layerOff[m] <= st.filePosition) lo = m + 1; else hi = m; } return lo; }
  if (st.currentLayer) return Math.min(total, st.currentLayer | 0);
  return 0;
}

// ---------------------------------------------------------------- worker side
// message in:  { id, key, url, headers, colors: [hex...], st: { state, filePosition, currentLayer }, model: bool }
// message out: { id, model?: Buffer, progress: Buffer, layers, printed } or { id, error }
if (require('worker_threads').parentPort && require('worker_threads').workerData === 'aipa-preview') {
  const { parentPort } = require('worker_threads');
  const cache = new Map();   // key -> parsed (last 3 files)
  parentPort.on('message', async (job) => {
    try {
      let parsed = cache.get(job.key);
      if (!parsed) {
        const r = await fetch(job.url, { headers: job.headers || {} });
        if (!r.ok) throw new Error(`downloading the G-code: HTTP ${r.status}`);
        const p = new Parser(), dec = new TextDecoder();
        for await (const ch of r.body) p.write(dec.decode(ch, { stream: true }));
        p.end();
        parsed = p.result();
        cache.set(job.key, parsed);
        while (cache.size > 3) cache.delete(cache.keys().next().value);
      }
      const colors = {};
      (job.colors || []).forEach((h, i) => { const c = parseHex(h); if (c) colors[i] = c; });
      (parsed.headerColors || []).forEach((h, i) => { if (!(i in colors)) { const c = parseHex(h); if (c) colors[i] = c; } });
      const tc = Object.keys(colors).length ? colors : null;
      const printed = printedLayers(parsed, job.st || {});
      const out = { id: job.id, layers: parsed.layerZ.length, printed, progress: render(parsed, -35, 32, printed, false, tc) };
      if (job.model) out.model = render(parsed, 145, 32, null, false, tc);
      parentPort.postMessage(out);
    } catch (e) { parentPort.postMessage({ id: job.id, error: e.message || String(e) }); }
  });
}

// ---------------------------------------------------------------- main side
class PreviewWorker {
  constructor() { this.w = null; this.jobs = new Map(); this.n = 0; }
  ensure() {
    if (this.w) return this.w;
    const { Worker } = require('worker_threads');
    this.w = new Worker(path.join(__dirname, 'preview.js'), { workerData: 'aipa-preview' });
    this.w.on('message', (m) => { const j = this.jobs.get(m.id); if (j) { this.jobs.delete(m.id); m.error ? j.reject(new Error(m.error)) : j.resolve(m); } });
    this.w.on('error', (e) => { for (const j of this.jobs.values()) j.reject(e); this.jobs.clear(); this.w = null; });
    this.w.on('exit', () => { for (const j of this.jobs.values()) j.reject(new Error('preview stopped')); this.jobs.clear(); this.w = null; });
    this.w.unref();
    return this.w;
  }
  draw(job) {
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.ensure().postMessage({ ...job, id });
      setTimeout(() => { if (this.jobs.has(id)) { this.jobs.delete(id); reject(new Error('preview took too long')); } }, 5 * 60 * 1000);
    });
  }
  stop() { if (this.w) { this.w.terminate().catch(() => {}); this.w = null; } }
}

module.exports = { Parser, parseGcode, render, placeholderPng, printedLayers, parseHex, encodePng, PreviewWorker };
