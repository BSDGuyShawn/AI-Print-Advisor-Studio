// The phone page's own parts, added once the Filament screen has started (see phone-boot.js):
//   - links to a spool (/s/054 on labels and stickers) open it
//   - after pairing: switch to the PC's name (<pc>.local) when this phone can reach it, so label links work here
//   - Scan: the camera (QR labels) and, on Android, NFC stickers. Phones only allow those on HTTPS pages, so on the
//     plain address this explains how to set up the app's secure address once.
//   - a note when the PC can't be reached
(function () {
  const api = window.advisor, P = window.__PHONE || {};
  const $ = (s, el = document) => el.querySelector(s);
  const toast = (m, ms) => (window.__toast ? window.__toast(m, ms) : alert(m));
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const nameOrigin = P.name || '';
  const onName = nameOrigin && location.origin === nameOrigin;

  // ---------------------------------------------------------------- spool links
  function openFromLink(text) {
    const m = /\/s\/([A-Za-z0-9_-]{1,24})(?:$|[?#/])/.exec(String(text || ''));
    if (!m) { toast('That isn’t a spool label from this app.', 4000); return false; }
    if (!window.__openSpool(m[1])) toast(`Spool #${m[1]} isn’t in your library (deleted?).`, 5000);
    return true;
  }
  function fromHash() {
    const m = /^#spool=([A-Za-z0-9_-]{1,24})$/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, '', location.pathname + '#inventory');
    if (!window.__openSpool(m[1])) toast(`Spool #${m[1]} isn’t in your library (deleted?).`, 5000);
  }
  window.addEventListener('hashchange', fromHash);
  setTimeout(fromHash, 50);

  // ---------------------------------------------------------------- the sheet (bottom panel) used below
  const sheet = document.createElement('div');
  sheet.className = 'psheet';
  sheet.innerHTML = '<div class="psheet-card" role="dialog" aria-modal="true"></div>';
  document.body.appendChild(sheet);
  let onClose = null;
  function openSheet(html, closeCb) {
    $('.psheet-card', sheet).innerHTML = `${html}<button class="btn psheet-close" data-close-sheet>Close</button>`;
    sheet.classList.add('open'); onClose = closeCb || null;
  }
  function closeSheet() { sheet.classList.remove('open'); const cb = onClose; onClose = null; if (cb) cb(); }
  sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('[data-close-sheet]')) closeSheet(); });

  // ---------------------------------------------------------------- switching to another address of the PC
  // (the cookie that says "paired" belongs to each address, so the app pairs the new one through a short-lived code)
  async function goTo(origin, welcome = false) {
    try { const { code } = await api.call('/api/link-code', { welcome }); location.href = `${origin}/pair?c=${encodeURIComponent(code)}`; }
    catch (e) { toast(e.message, 5000); }
  }
  // Finding the PC by name can take several seconds the first time (multicast DNS), so try twice, patiently
  async function nameWorks() {
    if (!nameOrigin || location.protocol !== 'http:') return null;
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch(`${nameOrigin}/ping`, { mode: 'cors', cache: 'no-store', signal: AbortSignal.timeout(8000) });
        if (r.ok && (await r.json()).app === 'aipa') return true;
      } catch { /* try again */ }
    }
    return false;
  }
  const params = new URLSearchParams(location.search);
  (async () => {
    if (onName) {
      if (params.get('paired')) welcome();
      if (P.localOk !== true) api.call('/api/local-check', { ok: true }).catch(() => {});
      return;
    }
    if (location.protocol !== 'http:') { if (params.get('paired')) welcome(P.localOk === false); return; }
    if (!params.get('paired') && P.localOk === false) return;
    const ok = await nameWorks();
    if (ok !== null) api.call('/api/local-check', { ok }).catch(() => {});
    if (ok) return goTo(nameOrigin, !!params.get('paired'));   // carries on pairing there; labels link to that address
    if (params.get('paired')) welcome(true);
  })();
  function welcome(noName) {
    sessionStorage.setItem('aipaHello', '1');
    history.replaceState(null, '', location.pathname + location.hash);
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    openSheet(`<h2>This phone is paired</h2>
      <p>Your filament library is here whenever this phone is on your home Wi-Fi and the app is open on your PC.</p>
      <p><b>Add it to your Home Screen</b> to open it like an app: ${ios ? 'tap <b>Share</b> (the square with an arrow), then <b>Add to Home Screen</b>' : 'tap the <b>⋮</b> menu, then <b>Add to Home screen</b>'}.</p>
      ${noName ? `<p class="pwarn">This phone can’t find your PC by its name (${esc(P.pcName || '')}.local), which some Android phones can’t do. That’s fine: it uses the PC’s address (${esc(location.host)}), and labels and stickers will link to that address too.</p>
      <p class="muted">So that address doesn’t change, reserve it for your PC in your router’s settings (often called “DHCP reservation” or “static lease”). <button class="btn" data-try-name>Try the PC’s name again</button></p>` : ''}`);
    const t = $('[data-try-name]', sheet);
    if (t) t.onclick = () => goTo(nameOrigin, true);
  }

  // ---------------------------------------------------------------- Scan
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.id = 'phoneScanBtn';
  btn.textContent = '📷 Scan';
  const add = $('#addBtn');
  if (add) add.parentNode.insertBefore(btn, add);
  btn.addEventListener('click', () => (window.isSecureContext ? scanChoices() : secureHowTo()));
  // "This phone": the certificate, the secure address and NFC, whenever they're needed
  const setupBtn = document.createElement('button');
  setupBtn.className = 'btn';
  setupBtn.id = 'phoneSetupBtn';
  setupBtn.textContent = '⚙';
  setupBtn.title = setupBtn.ariaLabel = 'This phone: certificate and scanning';
  if (add) add.parentNode.insertBefore(setupBtn, btn);
  // the Print Monitor: every printer's print, camera and time left (from the app's Settings → Printers)
  const monBtn = document.createElement('a');
  monBtn.className = 'btn';
  monBtn.id = 'phoneMonitorBtn';
  monBtn.href = '/monitor/index.html';
  monBtn.textContent = '🖨 Printers';
  if (add) add.parentNode.insertBefore(monBtn, setupBtn);
  // photos of a failed print for the app's print troubleshooter (renderer/phone/snap.html)
  const snapBtn = document.createElement('a');
  snapBtn.className = 'btn';
  snapBtn.id = 'phoneSnapBtn';
  snapBtn.href = '/phone/snap.html';
  snapBtn.textContent = '📷';
  snapBtn.title = snapBtn.ariaLabel = 'Photos of a failed print, for the troubleshooter on the PC';
  if (add) add.parentNode.insertBefore(snapBtn, setupBtn);
  setupBtn.addEventListener('click', phoneSetup);

  function scanChoices() {
    const nfc = 'NDEFReader' in window;
    openSheet(`<h2>Scan a spool</h2>
      <div class="pchoices">
        <button class="btn primary" data-scan="camera">📷 Scan a label’s QR code</button>
        ${nfc ? '<button class="btn primary" data-scan="nfc">📶 Tap an NFC sticker</button>' : ''}
      </div>
      <p class="muted">${nfc ? '' : 'This phone’s browser can’t read NFC stickers (only Chrome on Android can). '}Brand tags (Bambu Lab, Snapmaker…) need the reader on your PC: a scan there opens the spool here too.</p>`);
    $('[data-scan="camera"]', sheet).onclick = scanCamera;
    const n = $('[data-scan="nfc"]', sheet); if (n) n.onclick = scanNfc;
  }

  const ios = /iPhone|iPad/.test(navigator.userAgent);
  function certSteps() {
    return `<li><a href="/cert/aipa-ca.crt" class="btn primary" download>Download the app’s certificate</a></li>
      ${ios ? `<li>Open <b>Settings</b>: tap <b>Profile Downloaded</b> near the top, then <b>Install</b>.</li>
      <li>Then <b>Settings → General → About → Certificate Trust Settings</b> and switch on <b>AI 3D Print Advisor Studio on ${esc(P.pcName || '')}</b>.</li>`
        : `<li>Go to the phone’s <b>Settings</b> and search for <b>CA certificate</b> (usually <b>Security → More security settings → Encryption &amp; credentials → Install a certificate → CA certificate</b>). Tap <b>Install anyway</b> and pick the downloaded file (in <b>Downloads</b>).</li>
      <li>Close Chrome completely (swipe it away in the recent apps), then open this page again.</li>`}`;
  }
  function phoneSetup() {
    const secureOn = !!(P.httpsPort || P.https);
    const nfcOk = window.isSecureContext && 'NDEFReader' in window;
    let cert;
    if (!secureOn) cert = `<p>Scanning inside this page needs the app’s <b>Secure address</b>: turn it on in the app on your PC (<b>Settings → Phone access</b>), then come back here.</p>`;
    else if (location.protocol === 'https:') cert = `<p>You’re on the app’s secure address. If the browser shows a warning sign by the address (or a red “Not secure”), this phone doesn’t trust the app’s certificate yet:</p><ol>${certSteps()}</ol>`;
    else cert = `<p>Scanning inside this page needs the app’s secure address, which this phone trusts once:</p><ol>${certSteps()}<li><button class="btn primary" data-go-secure>Open the secure page</button></li></ol>`;
    openSheet(`<h2>This phone</h2>
      <h3>Secure address and certificate</h3>${cert}
      <p class="muted">The certificate is made by the app on your PC and only covers your PC. You can remove it in the phone’s settings any time.</p>
      ${nfcOk ? `<h3>NFC stickers</h3><p>${nfcOn ? '✓ This page reads stickers while it’s open.' : 'Let this page read stickers, so tapping one opens it here instead of Android’s “New tag” screen.'}</p>${nfcOn ? '' : '<button class="btn primary" data-nfc-allow>Allow reading stickers</button>'}` : ''}`);
    const g = $('[data-go-secure]', sheet);
    if (g) g.onclick = () => goTo(P.httpsPort ? `https://${location.hostname}:${P.httpsPort}` : P.https);
    const a = $('[data-nfc-allow]', sheet);
    if (a) a.onclick = () => nfcStart().then(phoneSetup, (e) => toast(`NFC isn’t available: ${e.message || e}`, 5000));
  }

  function secureHowTo() {
    if (!P.https) {
      openSheet(`<h2>Scanning</h2>
        <p><b>Spool labels:</b> point your phone’s <b>camera app</b> at a label’s QR code and tap the link: the spool opens here.</p>
        <p><b>NFC stickers</b> the app writes open the spool too when you tap them to the phone.</p>
        <p class="muted">To scan from inside this page instead, turn on <b>Secure address</b> in the app’s <b>Settings → Phone access</b>, then come back here.</p>`);
      return;
    }
    openSheet(`<h2>Set up scanning</h2>
      <p>Phones only allow the camera and NFC on secure (https) pages. The app has its own secure address; this phone needs to trust it once:</p>
      <ol>
        ${certSteps()}
        <li><button class="btn primary" data-go-secure>Open the secure page</button></li>
      </ol>
      <p class="muted">This certificate is made by the app on your PC and only covers your PC. You can remove it from the phone’s settings any time. Labels’ QR codes work with the camera app without any of this.</p>`);
    // the same address this phone uses now (by name, or by number for phones that can't find the PC by name)
    $('[data-go-secure]', sheet).onclick = () => goTo(P.httpsPort ? `https://${location.hostname}:${P.httpsPort}` : P.https);
  }

  // camera: BarcodeDetector where the browser has it (Android), else jsQR (iPhone)
  let stream = null;
  function stopCamera() { if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; }
  async function scanCamera() {
    openSheet(`<h2>Point the camera at a label</h2><div class="pcam"><video playsinline muted></video><div class="pcam-frame"></div></div>`, stopCamera);
    const video = $('video', sheet);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (e) { return openSheet(`<h2>No camera</h2><p>The page couldn’t use the camera (${esc(e.message || e)}). Allow camera access for this page in the browser’s settings, or use the camera app on a label.</p>`); }
    video.srcObject = stream;
    await video.play().catch(() => {});
    let detect;
    if ('BarcodeDetector' in window && (await window.BarcodeDetector.getSupportedFormats().catch(() => [])).includes('qr_code')) {
      const d = new window.BarcodeDetector({ formats: ['qr_code'] });
      detect = async () => { const r = await d.detect(video); return r[0] && r[0].rawValue; };
    } else {
      if (!window.jsQR) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/node_modules/jsqr/dist/jsQR.js'; s.onload = res; s.onerror = rej; document.body.appendChild(s); });
      const c = document.createElement('canvas'), g = c.getContext('2d', { willReadFrequently: true });
      detect = async () => {
        const w = Math.min(720, video.videoWidth), h = Math.round(video.videoHeight * w / (video.videoWidth || 1));
        if (!w || !h) return null;
        c.width = w; c.height = h; g.drawImage(video, 0, 0, w, h);
        const r = window.jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
        return r && r.data;
      };
    }
    const tick = async () => {
      if (!stream) return;
      const text = await detect().catch(() => null);
      if (text) { stopCamera(); closeSheet(); openFromLink(text); return; }
      setTimeout(tick, 180);
    };
    tick();
  }

  // Web NFC (Chrome on Android): links the app wrote, OpenSpool stickers, or any sticker by its ID.
  // The page keeps listening while it's open (once allowed): while it does, Chrome gets the tags, not Android's own
  // "New tag scanned" screen. Android pauses it by itself while the page is in the background.
  let nfcOn = false, nfcWait = false;
  function onNfcReading({ serialNumber, message }) {
    if (nfcWait) { nfcWait = false; closeSheet(); }
    const uid = String(serialNumber || '').replace(/:/g, '').toUpperCase();
    const dec = new TextDecoder();
    for (const rec of message.records) {
      if (rec.recordType === 'url' || rec.recordType === 'absolute-url') {
        const url = dec.decode(rec.data);
        if (/\/s\/[A-Za-z0-9_-]+/.test(url)) return openFromLink(url);
      }
    }
    const base = { event: 'tag_scanned', status: 'unrecognized', decoder: null, spoolId: `uid:${uid}`, tag: { uid, type: 'MifareUltralight' }, filament: null, extras: null };
    for (const rec of message.records) {
      if (rec.recordType !== 'mime' || rec.mediaType !== 'application/json') continue;
      try {
        const j = JSON.parse(dec.decode(rec.data));
        if (j.protocol !== 'openspool') continue;
        const hex = /^#?([0-9a-f]{6})/i.exec(String(j.color_hex || '')) ? `#${/^#?([0-9a-f]{6})/i.exec(j.color_hex)[1].toUpperCase()}` : null;
        const n = (v) => (Number.isFinite(+v) && v !== '' && v != null ? +v : null);
        return window.__onTag({ ...base, status: 'decoded', decoder: 'openspool', filament: { manufacturer: String(j.brand || 'Generic').slice(0, 80),
          material: String(j.type || 'PLA').toUpperCase().slice(0, 40), modifiers: j.subtype ? [String(j.subtype).slice(0, 40)] : [], colorHex: hex,
          colorsHex: hex ? [hex] : [], diameterMm: n(j.diameter), weightG: n(j.weight), nozzleMin: n(j.min_temp), nozzleMax: n(j.max_temp),
          bed: n(j.bed_max_temp), dryTemp: null, dryHours: null, made: null } });
      } catch { /* not OpenSpool */ }
    }
    if (uid) window.__onTag(base);
  }
  async function nfcStart() {
    if (nfcOn) return;
    const r = new window.NDEFReader();
    r.onreading = onNfcReading;
    r.onreadingerror = () => toast('This phone couldn’t read that tag. Brand tags (Bambu Lab, Snapmaker…) need the reader on your PC.', 5000);
    await r.scan();
    nfcOn = true;
    nfcBar.classList.remove('show');
  }
  async function scanNfc() {
    try {
      await nfcStart();
      nfcWait = true;
      openSheet(`<h2>Hold a sticker to the back of the phone</h2><p class="muted">Keep it there for a second. This page reads stickers whenever it’s open, so next time you can just tap one.</p>`, () => { nfcWait = false; });
    } catch (e) {
      openSheet(`<h2>NFC isn’t available</h2><p>${esc(e.message || e)}. Check that NFC is on in the phone’s settings, and that this page is allowed to use NFC (the ⓘ or lock icon by the address).</p>`);
    }
  }
  // Already allowed: start listening now. Not yet: offer it once (the phone asks for permission on a tap).
  const nfcBar = document.createElement('div');
  nfcBar.className = 'pnfc';
  nfcBar.innerHTML = '<span>Let this page read spool stickers? Then tapping one opens it here, not Android’s “New tag” screen.</span><button class="btn primary" data-nfc-yes>Allow</button><button class="btn" data-nfc-no aria-label="Not now">✕</button>';
  document.body.appendChild(nfcBar);
  $('[data-nfc-yes]', nfcBar).onclick = () => nfcStart().catch((e) => { nfcBar.classList.remove('show'); toast(`NFC isn’t available: ${e.message || e}`, 5000); });
  $('[data-nfc-no]', nfcBar).onclick = () => { nfcBar.classList.remove('show'); try { localStorage.setItem('aipaNfcAsk', 'no'); } catch {} };
  if (window.isSecureContext && 'NDEFReader' in window) {
    (async () => {
      let state = 'prompt';
      try { state = (await navigator.permissions.query({ name: 'nfc' })).state; } catch { /* older Chrome */ }
      if (state === 'granted') nfcStart().catch(() => {});
      else if (state === 'prompt' && localStorage.getItem('aipaNfcAsk') !== 'no') nfcBar.classList.add('show');
    })();
  }

  // ---------------------------------------------------------------- connection to the PC
  const bar = document.createElement('div');
  bar.className = 'pconn';
  bar.textContent = 'Can’t reach your PC. Is the app open and this phone on the same Wi-Fi? Retrying…';
  document.body.appendChild(bar);
  api.onConnection((ok) => bar.classList.toggle('show', !ok));
})();
