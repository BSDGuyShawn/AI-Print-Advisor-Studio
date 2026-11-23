// Phone access: the Filament library on phones on the home network (Settings → Phone access; off by default).
//
// The app serves the same Filament screen it shows itself (renderer/filament/) to paired phones, with a small shim
// (renderer/phone/phone-boot.js) that does the screen's few calls to the app over HTTP instead of Electron IPC.
// Everything stays on the PC: the phone reads and saves through these calls, and the Claude API key never leaves.
//
// Safety:
//   - Only paired phones get in. Pairing = scanning a one-time QR code from Settings (5 minutes, single use); the
//     phone gets a random 256-bit token in a cookie, the app keeps only its SHA-256. Settings lists phones and can
//     remove them. Failed pairing attempts are rate-limited.
//   - Requests must be addressed to this PC (its name, its home-network addresses or localhost): blocks DNS
//     rebinding. Writes also need a custom header and JSON (blocks cross-site form posts).
//   - Only the Filament screen's own files, its product photos and two QR libraries are served, from fixed folders.
//   - Optional HTTPS on a second port with the app's own certificate (cert.js), for camera scanning and web NFC.
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { makeCA, makeServerCert, serverCertFits } = require('./cert');

const PAIR_MS = 5 * 60 * 1000, LINK_MS = 2 * 60 * 1000;
const COOKIE = 'aipa_phone';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

// The PC's home-network IPv4 addresses (no loopback, no 169.254 "no DHCP" addresses)
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  }
  const priv = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return [...new Set(out)].sort((a, b) => priv(b) - priv(a));
}
// What a phone is, from its browser's description (for the list in Settings)
function deviceName(ua = '') {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  const m = /Android [\d.]+; ([^;)]+)/.exec(ua);
  if (m) return m[1].trim() === 'K' ? 'Android phone' : `Android (${m[1].trim().slice(0, 30)})`;
  if (/Android/.test(ua)) return 'Android phone';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'Phone';
}
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:28px 22px;background:#E6E9EC;color:#18232E}h1{font-size:21px;margin:0 0 10px}
.card{background:#fff;border-radius:14px;padding:20px;max-width:520px;margin:auto}@media (prefers-color-scheme:dark){body{background:#151b21;color:#dde4ea}.card{background:#1f272f}}</style>
</head><body><div class="card"><h1>${esc(title)}</h1>${body}</div></body></html>`;
}

class PhoneServer extends EventEmitter {
  // api: { load(), save(data), claude(body), fetch(arg), hasKey() } — the same functions the app's own screen uses
  // conf: { get(): phoneConfig, set(phoneConfig) } — saved settings and paired devices
  constructor({ appDir, imagesDir, dataDir, api, conf, log = () => {} }) {
    super();
    Object.assign(this, { appDir, imagesDir, dataDir, api, conf, log });
    this.http = null; this.https = null; this.error = null;
    this.codes = new Map();   // one-time code -> { expires, deviceId? }
    this.streams = new Set(); // { res, deviceId }
    this.failures = new Map();   // ip -> { n, until }
    this.seenSaved = 0;
    this.statics = {
      '/app/': path.join(appDir, 'renderer', 'filament'),
      '/phone/': path.join(appDir, 'renderer', 'phone'),
    };
    this.libs = {
      '/node_modules/qrcode-generator/dist/qrcode.js': path.join(appDir, 'node_modules', 'qrcode-generator', 'dist', 'qrcode.js'),
      '/node_modules/jsqr/dist/jsQR.js': path.join(appDir, 'node_modules', 'jsqr', 'dist', 'jsQR.js'),
    };
  }

  get cfg() { return this.conf.get(); }
  get pcName() { return os.hostname().toLowerCase(); }
  urls() {
    const c = this.cfg, ips = lanAddresses();
    return {
      name: `http://${this.pcName}.local:${c.port}`,
      ips: ips.map(ip => `http://${ip}:${c.port}`),
      https: c.https ? `https://${this.pcName}.local:${c.httpsPort}` : null,
      httpsIps: c.https ? ips.map(ip => `https://${ip}:${c.httpsPort}`) : [],
    };
  }
  // Where labels and stickers point: the PC's name (default), or its address when that's chosen or when a paired
  // phone can't find the PC by name (some Android phones can't), so the links work on every paired phone
  linkVia() {
    const c = this.cfg;
    if (!lanAddresses().length) return { via: 'name' };
    if (c.linkHost === 'ip') return { via: 'ip' };
    const d = (c.devices || []).find(x => x.localOk === false);
    return d ? { via: 'ip', because: d.name } : { via: 'name' };
  }
  linkBase() {
    const u = this.urls();
    return this.linkVia().via === 'ip' ? u.ips[0] : u.name;
  }
  status() {
    const c = this.cfg;
    return { running: !!this.http, error: this.error, urls: this.urls(), linkBase: this.linkBase(), linkVia: this.linkVia(), pcName: this.pcName,
      devices: (c.devices || []).map(d => ({ id: d.id, name: d.name, paired: d.paired, lastSeen: d.lastSeen, localOk: d.localOk ?? null })) };
  }

  // ---------------------------------------------------------------- start / stop
  async start() {
    await this.stop();
    const c = this.cfg;
    this.error = null;
    try {
      this.http = await this.listen(http.createServer((q, r) => this.handle(q, r, false)), c.port);
      if (c.https) this.https = await this.listen(https.createServer(await this.tlsOptions(), (q, r) => this.handle(q, r, true)), c.httpsPort);
      this.log(`phone access on ${this.urls().name}${c.https ? ` and ${this.urls().https}` : ''}`);
    } catch (e) {
      this.error = e.code === 'EADDRINUSE' ? `Port ${e.port || ''} is already used by another program. Pick another port.` : `Couldn’t start: ${e.message}`;
      this.log(`phone access: ${this.error}`);
      await this.stop(true);
    }
    this.emit('status', this.status());
  }
  listen(server, port) {
    return new Promise((resolve, reject) => {
      server.once('error', (e) => { e.port = port; reject(e); });
      server.listen(port, '0.0.0.0', () => { server.removeAllListeners('error'); server.on('error', (e) => this.log(`phone access: ${e.message}`)); resolve(server); });
    });
  }
  async stop(keepError) {
    for (const s of this.streams) { try { s.res.end(); } catch {} }
    this.streams.clear();
    for (const k of ['http', 'https']) {
      const s = this[k]; this[k] = null;
      if (s) await new Promise(r => { s.close(() => r()); s.closeAllConnections?.(); });
    }
    if (!keepError) this.error = null;
  }
  // the app's certificate authority (made once) and a server certificate for today's names and addresses
  async tlsOptions() {
    const dir = path.join(this.dataDir, 'phone');
    await fsp.mkdir(dir, { recursive: true });
    const f = (n) => path.join(dir, n);
    let ca;
    try { ca = { certPem: await fsp.readFile(f('ca.pem'), 'utf8'), keyPem: await fsp.readFile(f('ca-key.pem'), 'utf8') }; }
    catch { ca = makeCA(this.pcName); await fsp.writeFile(f('ca.pem'), ca.certPem); await fsp.writeFile(f('ca-key.pem'), ca.keyPem); }
    const want = { dnsNames: [`${this.pcName}.local`, this.pcName, 'localhost'], ips: [...lanAddresses(), '127.0.0.1'] };
    let sv;
    try { sv = { certPem: await fsp.readFile(f('server.pem'), 'utf8'), keyPem: await fsp.readFile(f('server-key.pem'), 'utf8') }; } catch {}
    if (!sv || !serverCertFits(sv.certPem, want)) {
      sv = makeServerCert(ca, want);
      await fsp.writeFile(f('server.pem'), sv.certPem); await fsp.writeFile(f('server-key.pem'), sv.keyPem);
    }
    this.caPem = ca.certPem;
    return { key: sv.keyPem, cert: sv.certPem + ca.certPem };
  }
  async caCertDer() {
    if (!this.caPem) { try { this.caPem = await fsp.readFile(path.join(this.dataDir, 'phone', 'ca.pem'), 'utf8'); } catch { return null; } }
    return Buffer.from(this.caPem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  }

  // ---------------------------------------------------------------- pairing and devices
  newPairCode() {
    const code = token();
    this.codes.set(code, { expires: Date.now() + PAIR_MS });
    const ip = lanAddresses()[0];
    const base = ip ? `http://${ip}:${this.cfg.port}` : this.urls().name;
    return { url: `${base}/pair?c=${code}`, expires: Date.now() + PAIR_MS };
  }
  removeDevice(id) {
    const c = this.cfg;
    c.devices = (c.devices || []).filter(d => d.id !== id);
    this.conf.set(c);
    for (const s of [...this.streams]) if (s.deviceId === id) { try { s.res.end(); } catch {} this.streams.delete(s); }
    this.emit('status', this.status());
  }
  // A paired phone's key: the page sends it in a header (it keeps it in the phone's storage), or in the path of
  // photos (/i/<key>/...) and the live-update stream (?k=), which can't send headers; or the cookie, where the browser
  // keeps that (some, like recent Chrome on Android, drop it on a plain-http home-network address).
  keyOf(req, u) {
    const ok = (k) => (typeof k === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(k) ? k : null);
    const fromCookie = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,100})`).exec(req.headers.cookie || '');
    const img = /^\/i\/([A-Za-z0-9_-]{20,100})\//.exec(u.pathname);
    return ok(req.headers['x-aipa-key']) || (img && img[1]) || (u.pathname === '/api/events' && ok(u.searchParams.get('k'))) || (fromCookie && fromCookie[1]) || null;
  }
  deviceFor(req, u = new URL(req.url, 'http://x')) {
    const k = this.keyOf(req, u);
    if (!k) return null;
    const h = sha(k);
    return (this.cfg.devices || []).find(d => (d.hashes || []).includes(h)) || null;
  }
  touch(dev, patch = {}) {
    const c = this.cfg, d = (c.devices || []).find(x => x.id === dev.id);
    if (!d) return;
    const now = Date.now();
    Object.assign(d, patch);
    if (Object.keys(patch).length || !d.lastSeen || now - d.lastSeen > 60000) {
      d.lastSeen = now;
      this.conf.set(c);
      this.emit('status', this.status());
    }
  }
  // GET /pair?c=... only shows a "Pair this phone" button; the code is used when that's tapped (POST). Camera apps and
  // chat apps open links in the background to show a preview, and must not use up the code or get the phone's cookie.
  // Link codes (another address of an already-paired phone, opened by the page itself) go straight through.
  async pair(req, res, secure, u) {
    const ip = req.socket.remoteAddress || '';
    const f = this.failures.get(ip);
    if (f && f.n >= 10 && f.until > Date.now()) return this.send(res, 429, page('Too many tries', '<p>Wait ten minutes, then make a new pairing code in the app.</p>'), 'text/html; charset=utf-8');
    let code = u.searchParams.get('c') || '';
    if (req.method === 'POST') {
      if (!/^application\/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) return this.send(res, 403, 'Refused.', 'text/plain');
      const chunks = []; let n = 0;
      for await (const ch of req) { n += ch.length; if (n > 2048) return this.send(res, 413, 'Too large.', 'text/plain'); chunks.push(ch); }
      code = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('c') || '';
    }
    const entry = this.codes.get(code);
    if (!entry || entry.expires < Date.now()) {
      this.failures.set(ip, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 10 * 60 * 1000 });
      return this.send(res, 403, page('This pairing link has expired', '<p>On your PC, open the app’s <b>Settings → Phone access</b> and click <b>Pair a phone</b> to get a new QR code.</p>'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && !entry.deviceId) {
      return this.send(res, 200, page('Pair this phone?', `<p>This lets this phone open your filament library from <b>AI 3D Print Advisor Studio</b> on <b>${esc(this.pcName)}</b>, while it’s on your home Wi-Fi.</p>
        <form method="post" action="/pair"><input type="hidden" name="c" value="${esc(code)}">
        <button type="submit" style="font:inherit;font-weight:600;padding:12px 22px;border:0;border-radius:10px;background:#1F7A8C;color:#fff;width:100%">Pair this phone</button></form>
        <p style="font-size:14px;opacity:.75">Opened in a preview inside your camera app? Open it in your browser (Chrome or Safari) first, so the browser is the one that’s paired.</p>`), 'text/html; charset=utf-8');
    }
    this.codes.delete(code);
    const t = token(), c = this.cfg;
    c.devices = c.devices || [];
    let dev = entry.deviceId && c.devices.find(d => d.id === entry.deviceId);
    if (dev) dev.hashes = [...(dev.hashes || []), sha(t)].slice(-6);
    else {
      dev = { id: crypto.randomBytes(6).toString('hex'), name: deviceName(req.headers['user-agent']), hashes: [sha(t)], paired: Date.now(), lastSeen: Date.now() };
      c.devices.push(dev);
    }
    this.conf.set(c);
    this.emit('status', this.status());
    this.log(`phone access: paired ${dev.name}${entry.deviceId ? ' (another address)' : ''} on ${req.headers.host} (${String(req.headers['user-agent'] || '').slice(0, 160)})`);
    res.setHeader('Set-Cookie', `${COOKIE}=${t}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
    res.writeHead(303, { location: `/app/index.html${!entry.deviceId || entry.welcome ? '?paired=1' : ''}#k=${t}`, 'cache-control': 'no-store' });
    return res.end();
  }

  // ---------------------------------------------------------------- live updates (Server-Sent Events)
  broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of this.streams) { try { s.res.write(msg); } catch {} }
  }
  events(req, res, dev) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': hello\n\n');
    const s = { res, deviceId: dev.id };
    this.streams.add(s);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ping); this.streams.delete(s); });
  }

  // ---------------------------------------------------------------- requests
  allowedHost(host) {
    const h = host.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return [this.pcName, `${this.pcName}.local`, 'localhost', '127.0.0.1', ...lanAddresses()].includes(h);
  }
  send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
    if (res.headersSent) return;
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(code, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', ...extra });
    res.end(buf);
  }
  redirect(res, to) { res.writeHead(302, { location: to, 'cache-control': 'no-store' }); res.end(); }
  async body(req, limit) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error('Too large.'), { status: 413 }); chunks.push(c); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  }
  async file(res, file, root) {
    const norm = path.normalize(file);
    if (!norm.startsWith(path.normalize(root) + path.sep)) return this.send(res, 404, 'Not found', 'text/plain');
    try {
      const body = await fsp.readFile(norm);
      const ext = path.extname(norm).toLowerCase();
      const extra = ext === '.html' ? { 'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self' http://*.local:* https://*.local:*; frame-ancestors 'none'" } : {};
      this.send(res, 200, body, MIME[ext] || 'application/octet-stream', extra);
    } catch { this.send(res, 404, 'Not found', 'text/plain'); }
  }

  async handle(req, res, secure) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    try {
      if (!this.allowedHost(req.headers.host || '')) return this.send(res, 421, 'This address isn’t this PC.', 'text/plain; charset=utf-8');
      const u = new URL(req.url, 'http://x');
      const p = u.pathname;
      if (p === '/ping') return this.send(res, 200, { app: 'aipa', ok: true }, undefined, { 'access-control-allow-origin': '*' });
      if (p === '/pair' && (req.method === 'GET' || req.method === 'POST')) return this.pair(req, res, secure, u);
      // the page's own files hold no data: anyone on the network may load them (the page then asks for the data)
      if (req.method === 'GET') {
        if (p === '/' || p === '/app' || p === '/app/') return this.redirect(res, '/app/index.html');
        const s = /^\/s\/([A-Za-z0-9_-]{1,24})$/.exec(p);
        if (s) return this.redirect(res, `/app/index.html#spool=${s[1]}`);
        for (const [prefix, root] of Object.entries(this.statics)) if (p.startsWith(prefix)) return this.file(res, path.join(root, decodeURIComponent(p.slice(prefix.length))), root);
        if (this.libs[p]) return this.file(res, this.libs[p], path.dirname(this.libs[p]));
      }
      const dev = this.deviceFor(req, u);
      if (!dev) {
        // for troubleshooting: why (never the cookie's value)
        const names = (req.headers.cookie || '').split(';').map(c => c.trim().split('=')[0]).filter(Boolean);
        const why = req.headers['x-aipa-key'] ? 'a key this PC doesn’t know (phone removed?)' : names.includes(COOKIE) ? 'a phone that isn’t paired anymore' : 'no key';
        this.log(`phone access: refused ${p.replace(/^\/i\/[^/]+/, '/i/…')} from ${req.socket.remoteAddress} (${why}; ${String(req.headers['user-agent'] || '').slice(0, 160)})`);
        if (p.startsWith('/api/') || p.startsWith('/i/')) return this.send(res, 401, { error: 'This phone isn’t paired.', others: this.otherAddresses(req, secure) });
        // phones keep "paired" per address: one paired on another address of this PC can go there
        const others = this.otherAddresses(req, secure);
        return this.send(res, 401, page('Pair this phone first', `<p>To open your filament library here, on your PC open the app’s <b>Settings → Phone access</b>, click <b>Pair a phone</b> and scan the QR code with this phone’s camera.</p>
          ${others.length ? `<p><b>Already paired this phone?</b> It may be paired on another address of your PC. Try:</p><ul>${others.map(o => `<li><a href="${esc(o)}/app/index.html">${esc(o)}</a></li>`).join('')}</ul>` : ''}`), 'text/html; charset=utf-8');
      }
      this.touch(dev);
      if (req.method === 'GET') {
        const img = /^\/(?:images|i\/[A-Za-z0-9_-]{20,100})\/([A-Za-z0-9_.-]{1,120}\.(?:jpe?g|png|webp|gif))$/i.exec(p);
        if (img) return this.file(res, path.join(this.imagesDir, img[1]), this.imagesDir);
        if (p === '/cert/aipa-ca.crt') {
          const der = await this.caCertDer();
          return der ? this.send(res, 200, der, 'application/x-x509-ca-cert', { 'content-disposition': 'attachment; filename="AI-3D-Print-Advisor-Studio.crt"' }) : this.send(res, 404, 'Turn on the secure address in the app first.', 'text/plain');
        }
        if (p === '/api/load') {
          const k = req.headers['x-aipa-key'];
          return this.send(res, 200, { ...(await this.api.load()), imagesBase: k ? `/i/${k}/` : '/images/', phone: this.phoneInfo(dev, secure) });
        }
        if (p === '/api/has-key') return this.send(res, 200, { hasKey: await this.api.hasKey() });
        if (p === '/api/events') return this.events(req, res, dev);
        return this.send(res, 404, { error: 'Not found' });
      }
      if (req.method === 'POST' && p.startsWith('/api/')) {
        // CSRF: a page on another site can't send this header or a JSON body without the browser asking first
        if (req.headers['x-aipa'] !== '1' || !/^application\/json/.test(req.headers['content-type'] || '')) return this.send(res, 403, { error: 'Refused.' });
        if (p === '/api/save') {
          const data = await this.body(req, 60 * 1024 * 1024);
          try { return this.send(res, 200, await this.api.save(data)); }
          catch (e) { return this.send(res, e.code === 'STALE' ? 409 : 400, { error: e.message, code: e.code || null }); }
        }
        if (p === '/api/claude') return this.send(res, 200, await this.api.claude(await this.body(req, 40 * 1024 * 1024)));
        if (p === '/api/fetch') return this.send(res, 200, { result: await this.api.fetch(await this.body(req, 64 * 1024)) });
        if (p === '/api/local-check') { const b = await this.body(req, 1024); this.touch(dev, { localOk: !!(b && b.ok) }); return this.send(res, 200, { ok: true }); }
        if (p === '/api/link-code') {
          const code = token(), b = await this.body(req, 1024).catch(() => null);
          this.codes.set(code, { expires: Date.now() + LINK_MS, deviceId: dev.id, welcome: !!(b && b.welcome) });
          return this.send(res, 200, { code });
        }
        return this.send(res, 404, { error: 'Not found' });
      }
      this.send(res, 405, { error: 'Not allowed' });
    } catch (e) {
      this.log(`phone access: ${req.method} ${String(req.url).replace(/^\/i\/[^/]+/, '/i/…').replace(/([?&]k=)[^&]+/, '$1…')}: ${e.message}`);
      // only the message, one line (never a stack trace)
      const msg = e instanceof Error && typeof e.message === 'string' ? e.message.split(/\r?\n/)[0].slice(0, 300) : 'Something went wrong.';
      this.send(res, e.status || 500, { error: msg });
    }
  }
  // this PC's other addresses (a phone is paired per address; one paired on another can go there)
  otherAddresses(req, secure) {
    const u = this.urls(), here = `${secure ? 'https' : 'http'}://${String(req.headers.host || '').toLowerCase()}`;
    return [u.name, ...u.ips, ...(u.https ? [u.https, ...u.httpsIps] : [])].filter(o => o !== here);
  }
  phoneInfo(dev, secure) {
    const u = this.urls();
    return { device: dev.name, secure, pcName: this.pcName, name: u.name, https: u.https, linkBase: this.linkBase(),
      localOk: dev.localOk ?? null, port: this.cfg.port, httpsPort: this.cfg.https ? this.cfg.httpsPort : null };
  }
}

module.exports = { PhoneServer, lanAddresses, deviceName };
