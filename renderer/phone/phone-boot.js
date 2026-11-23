// The phone's side of Phone access (src/phone/server.js). Loaded by renderer/filament/boot.js when the Filament
// screen is opened from the app's home-network address instead of inside the app. Provides the same calls the screen
// uses in the app (window.advisor, like preload.js does there), done over HTTP, plus live updates:
//   changed   another screen (the app or another phone) saved the inventory
//   nfc-tag   a spool was scanned on the PC's NFC reader (if that's on in the app's Settings)
(function () {
  // This phone's key from pairing: the app puts it after # in the address (never sent over the network); kept in the
  // phone's storage for this address and sent with every request.
  const m = /(?:^#|&)k=([A-Za-z0-9_-]{20,100})/.exec(location.hash);
  if (m) { try { localStorage.setItem('aipaKey', m[1]); } catch {} history.replaceState(null, '', location.pathname + location.search); }
  let KEY = null;
  try { KEY = localStorage.getItem('aipaKey'); } catch {}
  const auth = KEY ? { 'x-aipa-key': KEY } : {};
  const POST = { 'content-type': 'application/json', 'x-aipa': '1', ...auth };
  async function call(path, body) {
    const init = body === undefined ? { credentials: 'same-origin', headers: auth } : { method: 'POST', headers: POST, body: JSON.stringify(body), credentials: 'same-origin' };
    let r;
    try { r = await fetch(path, init); } catch { throw new Error('Can’t reach the PC. Is it on, with the app open, and is this phone on the same Wi-Fi?'); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) {
      const others = (j.others || []).map(o => `<a href="${o}/app/index.html">${o}</a>`).join(' · ');
      throw Object.assign(new Error('This phone isn’t paired with this address. On your PC, open the app’s Settings → Phone access, click Pair a phone and scan the QR code with this phone.'), { others, notPaired: true });
    }
    if (!r.ok) throw new Error((j.code === 'STALE' ? 'STALE: ' : '') + (j.error || `HTTP ${r.status}`));
    return j;
  }

  const on = { changed: new Set(), tag: new Set(), connection: new Set() };
  const add = (set) => (cb) => { set.add(cb); return () => set.delete(cb); };
  let es = null, connected = true;
  function stream() {
    es = new EventSource(KEY ? `/api/events?k=${encodeURIComponent(KEY)}` : '/api/events');
    es.addEventListener('changed', (e) => on.changed.forEach(cb => cb(JSON.parse(e.data))));
    es.addEventListener('nfc-tag', (e) => on.tag.forEach(cb => cb(JSON.parse(e.data))));
    es.onopen = () => { if (!connected) { connected = true; on.connection.forEach(cb => cb(true)); on.changed.forEach(cb => cb({ rev: Infinity })); } };
    es.onerror = () => { if (connected) { connected = false; on.connection.forEach(cb => cb(false)); } };   // EventSource reconnects by itself
  }

  window.advisor = {
    phone: true,
    filamentLoad: async () => { const j = await call('/api/load'); window.__PHONE = j.phone || {}; return { ...j, linkBase: (j.phone || {}).linkBase || j.linkBase }; },
    filamentSave: (data) => call('/api/save', data),
    filamentClaude: (body) => call('/api/claude', body),
    filamentFetch: async (arg) => (await call('/api/fetch', arg)).result,
    filamentHasKey: async () => (await call('/api/has-key')).hasKey,
    filamentOpenFolder: async () => {},
    // spool tags: writing stays on the PC; scans on the PC's reader arrive here
    nfcStatus: async () => ({ enabled: false, phone: true, state: 'off', readers: [] }),
    onNfcTag: add(on.tag),
    onNfcStatus: () => () => {},
    onNfcWriteProgress: () => () => {},
    onFilamentChanged: add(on.changed),
    onConnection: add(on.connection),
    call,
  };
  if (KEY) stream();

  // phone look, and "Add to Home Screen" as an app
  const head = document.head;
  const link = (rel, href, extra = {}) => { const l = document.createElement('link'); l.rel = rel; l.href = href; Object.assign(l, extra); head.appendChild(l); };
  const meta = (name, content) => { const m = document.createElement('meta'); m.name = name; m.content = content; head.appendChild(m); };
  link('stylesheet', '/phone/phone.css');
  link('manifest', '/phone/manifest.webmanifest');
  link('apple-touch-icon', '/phone/icon-180.png');
  meta('theme-color', '#1F7A8C');
  meta('apple-mobile-web-app-capable', 'yes');
  meta('mobile-web-app-capable', 'yes');
  meta('apple-mobile-web-app-title', 'Filament');
  document.title = 'Filament';
  document.documentElement.classList.add('phone');
})();
