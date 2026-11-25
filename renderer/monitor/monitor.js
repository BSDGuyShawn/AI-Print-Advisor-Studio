// Print Monitor: every printer's print, camera, temperatures, time left, timelapses and final photos.
// Adapted from U1 Studio's web/js/app.js and pages.js (the same views and layout, from the Home Assistant dashboards).
// It runs in two places:
//   - in the app, a window loaded from app://bundle/renderer/monitor/; live updates come from the app (preload.js:
//     advisor.onMonitor) and everything else from app://bundle/api/monitor/... (src/monitor/hub.js)
//   - on a paired phone (Settings → Phone access), from the app's home-network server; live updates come over the
//     phone's event stream and requests carry the phone's key
// icons.js (icon) and derive.js (banner, countdown, toolhead, ...) are loaded before this file.
(function () {
  'use strict';
  const PHONE = /^https?:$/.test(location.protocol);
  let KEY = null;
  if (PHONE) { try { KEY = localStorage.getItem('aipaKey'); } catch {} }
  const advisor = PHONE ? null : window.advisor;

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function setHTML(el, html) { if (el && el.__html !== html) { el.innerHTML = html; el.__html = html; } }
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  // an address on the monitor's API (with the phone's key, for pictures and videos the page can't add a header to)
  const url = (p) => `/api/monitor${p}${KEY ? (p.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(KEY) : ''}`;
  async function api(p, opts = {}) {
    const headers = { ...(opts.body ? { 'content-type': 'application/json', 'x-aipa': '1' } : {}), ...(KEY ? { 'x-aipa-key': KEY } : {}) };
    const r = await fetch(`/api/monitor${p}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) }, cache: 'no-store' });
    if (r.status === 401) throw Object.assign(new Error('This phone isn’t paired. Pair it in the app: Settings → Phone access.'), { notPaired: true });
    const ct = r.headers.get('content-type') || '';
    const body = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error((body && body.error) || body || r.statusText);
    return body;
  }

  // ---------------------------------------------------------------- store + live updates
  const store = { printers: {}, order: [], settings: null, notifications: [], connected: false };
  const listeners = new Set();
  const onStore = (fn) => (listeners.add(fn), () => listeners.delete(fn));
  function emit() { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } }
  function applyState(msg) {
    store.settings = msg.settings; store.notifications = msg.notifications || [];
    store.printers = {}; store.order = [];
    for (const p of msg.printers) { store.printers[p.id] = p; store.order.push(p.id); }
  }
  async function refreshState() {
    try { applyState(await api('/state')); store.connected = true; store.error = null; }
    catch (e) { store.connected = false; store.error = e; }
    renderNav(); route(true); emit();
  }
  function onLive(msg) {
    if (msg.type === 'printer' && msg.printer) {
      const known = !!store.printers[msg.printer.id];
      store.printers[msg.printer.id] = msg.printer;
      if (!known) { refreshState(); return; }
      emit();
    } else if (msg.type === 'notify') onNotify(msg.item);
    else if (msg.type === 'state') refreshState();
  }
  if (advisor && advisor.onMonitor) advisor.onMonitor(onLive);
  if (PHONE && KEY) {
    const es = new EventSource(`/api/events?monitor=1&k=${encodeURIComponent(KEY)}`);
    es.addEventListener('monitor', (e) => onLive(JSON.parse(e.data)));
    es.onopen = () => { if (!store.connected) refreshState(); };
    es.onerror = () => { store.connected = false; store.lostAt = Date.now(); emit(); };
  }
  // a safety net: a fresh full state every 30 s
  setInterval(() => { if (!document.hidden) refreshState(); }, 30000);

  // ---------------------------------------------------------------- dialogs + toasts
  function dialog(html, { wide = false, onOpen } = {}) {
    return new Promise((resolve) => {
      const d = $('#dlg');
      d.className = 'dlg' + (wide ? ' wide' : '');
      d.innerHTML = html;
      // returnValue stays from the dialog before unless cleared: closing this one with Esc or the window would
      // otherwise answer with the last one's "yes"
      d.returnValue = '';
      d.onclose = () => { d.innerHTML = ''; resolve(d.returnValue); };
      d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', (e) => { if (e.isTrusted) d.close(b.dataset.close); }));
      d.showModal();
      if (onOpen) onOpen(d);
    });
  }
  async function confirmBox(title, body, okLabel = 'OK', danger = false) {
    const v = await dialog(`<div class="db"><h3>${esc(title)}</h3><div class="muted">${body}</div></div>
      <div class="da"><button class="btn ghost" data-close="no" autofocus>Keep going</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-close="yes">${esc(okLabel)}</button></div>`);
    return v === 'yes';
  }
  function toast(title, msg = '', kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.innerHTML = `<b>${esc(title)}</b><div class="small muted">${esc(msg)}</div>`;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 9000 : 6000);
  }
  function onNotify(item) {
    store.notifications.unshift(item);
    if (item.event !== 'test' && item.event !== 'progress') toast(item.title, item.message, item.event === 'error' ? 'error' : item.event === 'ready' ? 'good' : '');
  }

  // ---------------------------------------------------------------- nav + router
  function renderNav() {
    const r = location.hash || '#/';
    const link = (href, ic, label) => `<a href="${href}" class="${r === href || (href !== '#/' && r.startsWith(href)) ? 'on' : ''}">${icon(ic, 18)}<span>${esc(label)}</span></a>`;
    let html = link('#/', 'grid', 'All printers');
    for (const id of store.order) html += link(`#/p/${id}`, 'printer', store.printers[id].name);
    html += link('#/timelapse', 'film', 'Timelapses') + link('#/gallery', 'image', 'Final photos');
    if (advisor && advisor.openSettingsTab) html += `<a href="#" data-settings>${icon('cog', 18)}<span>Settings</span></a>`;
    if (PHONE) html += `<a href="/app/index.html">${icon('layers', 18)}<span>Filament</span></a>`;
    setHTML($('#nav'), html);
  }
  $('#nav').addEventListener('click', (e) => { if (e.target.closest('[data-settings]')) { e.preventDefault(); advisor.openSettingsTab('monitor'); } });
  onStore(() => $('#conn').classList.toggle('ok', store.connected));

  function renderOffline() {
    const box = $('#offline');
    const down = !store.connected && store.error;
    document.body.classList.toggle('is-offline', !!down);
    if (!down) { box.hidden = true; return; }
    setHTML(box, `<div class="offline-title">${icon('alert', 20)}<b>${store.error.notPaired ? 'This phone isn’t paired' : 'Can’t reach the app'}</b></div><div>${esc(store.error.message)}</div>
      <div class="offline-retry"><button type="button" class="btn" data-act="retry-now">Try again</button></div>`);
    box.hidden = false;
  }
  $('#offline').addEventListener('click', (e) => { if (e.target.closest('[data-act="retry-now"]')) refreshState(); });
  onStore(renderOffline);

  let current = null, currentKey = null;
  function route(force = false) {
    const parts = (location.hash || '#/').slice(1).split('/').filter(Boolean);
    const key = parts.join('/');
    if (!force && key === currentKey) return;
    if (force && key === currentKey && current && current.keep) { if (current.update) current.update(); return; }
    if (current && current.unmount) current.unmount();
    currentKey = key;
    const el = $('#app');
    el.innerHTML = '';
    if (!store.settings) { el.innerHTML = `<div class="empty">${store.error ? '' : 'Connecting…'}</div>`; current = null; return; }
    if (!store.order.length) {
      el.innerHTML = `<div class="empty">${store.settings.enabled === false ? 'The Print Monitor is off. Turn it on in Settings → Print monitor.' : 'No printers yet. Add your printers in Settings → Printers (address and API key), and they show up here.'}</div>`;
      current = null; renderNav(); return;
    }
    if (parts[0] === 'p' && store.printers[parts[1]]) current = printerView(el, parts[1]);
    else if (parts[0] === 'timelapse') current = timelapseView(el, parts[1]);
    else if (parts[0] === 'gallery') current = galleryView(el);
    else current = overviewView(el);
    renderNav();
    if (current && current.update) current.update();
  }
  window.addEventListener('hashchange', () => route());
  onStore(() => { if (current && current.update) current.update(); });

  // ---------------------------------------------------------------- shared components
  const units = () => (store.settings && store.settings.units) || 'F';

  // Live camera: frames are fetched one after another (each request waits for the next new frame), decoded
  // off-screen and drawn over the previous one, so the picture never blanks.
  function mountCamera(box, pid) {
    box.innerHTML = `<canvas role="img" aria-label="Live camera" hidden></canvas><div class="cam-msg" hidden></div><div class="cam-badge" hidden></div>`;
    const canvas = box.querySelector('canvas'), msg = box.querySelector('.cam-msg'), badge = box.querySelector('.cam-badge');
    const ctx = canvas.getContext('2d');
    let alive = true, after = 0, ctrl = null;
    const pull = async () => {
      while (alive) {
        if (document.hidden) { await new Promise(r => setTimeout(r, 1000)); continue; }
        try {
          ctrl = new AbortController();
          const r = await fetch(url(`/p/${encodeURIComponent(pid)}/frame?after=${after}`), { signal: ctrl.signal, cache: 'no-store', headers: KEY ? { 'x-aipa-key': KEY } : {} });
          after = Number(r.headers.get('x-frame-id')) || after;
          if (r.status === 200) {
            const bm = await createImageBitmap(await r.blob());
            if (alive) {
              if (canvas.width !== bm.width || canvas.height !== bm.height) { canvas.width = bm.width; canvas.height = bm.height; }
              ctx.drawImage(bm, 0, 0); canvas.hidden = false;
            }
            bm.close();
          } else await new Promise(res => setTimeout(res, r.status === 204 ? 300 : 3000));
        } catch { if (alive) await new Promise(res => setTimeout(res, 3000)); }
      }
    };
    pull();
    return {
      update(p) {
        const c = p.camera || {};
        if (c.mode === 'off') { msg.hidden = false; setHTML(msg, `${icon('camera', 34)}<div>No camera set for this printer</div><div class="small">Settings → Printers → Camera</div>`); badge.hidden = true; return; }
        const off = !p.enabled || (!c.has_frame && (c.error || !p.connected));
        msg.hidden = !off && c.has_frame;
        if (!c.has_frame) setHTML(msg, `${icon('camera', 34)}<div>${p.enabled === false ? 'Printer turned off in Settings' : c.error ? 'Camera unavailable' : 'Waiting for the camera…'}</div>` + (c.error ? `<div class="small">${esc(c.error)}</div>` : ''));
        badge.hidden = !c.has_frame;
        if (c.stale) { badge.className = 'cam-badge warn'; setHTML(badge, `Camera asleep · same picture for ${Math.round(c.unchanged_for)}s · ${esc(c.keepalive === 'ok' ? 'keep-alive sent' : c.keepalive)}`); }
        else { badge.className = 'cam-badge'; setHTML(badge, `<span class="live-dot"></span>LIVE · ${(c.interval_ms / 1000).toFixed(c.interval_ms % 1000 ? 1 : 0)} s`); }
      },
      unmount() { alive = false; if (ctrl) ctrl.abort(); },
    };
  }

  // Preview window rotating every 6 s: slicer thumbnail, whole model (second angle), layer by layer.
  function mountRotator(box, pid) {
    box.innerHTML = `<div class="ph">${icon('printer', 40)}<div>No print preview yet</div></div><div class="cap"></div>`;
    const cap = box.querySelector('.cap'), ph = box.querySelector('.ph');
    let imgs = [], idx = 0, sig = '';
    const timer = setInterval(() => show(idx + 1), 6000);
    function show(i) {
      const ok = imgs.filter((x) => x.ok);
      ph.hidden = ok.length > 0;
      if (!ok.length) { cap.textContent = ''; return; }
      idx = ((i % ok.length) + ok.length) % ok.length;
      imgs.forEach((x) => x.el.classList.remove('on'));
      ok[idx].el.classList.add('on');
      cap.textContent = ok[idx].cap;
    }
    return {
      update(p) {
        const prog = Math.round((p.progress || 0) * 100);
        const want = [];
        const id = encodeURIComponent(pid);
        if (p.thumb) want.push({ src: url(`/p/${id}/thumbnail?v=${p.thumb_v}`), cap: 'Slicer preview' });
        if (p.preview_v) {
          want.push({ src: url(`/p/${id}/preview/model.png?v=${p.preview_v}`), cap: 'Whole model · second angle' });
          want.push({ src: url(`/p/${id}/preview/progress.png?v=${p.preview_v}`), cap: `Layer by layer · ${prog}%` });
        }
        const s = want.map((w) => w.src).join('|');
        if (s !== sig) {
          sig = s;
          imgs.forEach((x) => x.el.remove());
          imgs = want.map((w) => {
            const el = new Image();
            const item = { el, cap: w.cap, ok: false };
            el.onload = () => { item.ok = true; show(idx); };
            el.onerror = () => { item.ok = false; el.remove(); };
            el.src = w.src; el.alt = w.cap;
            box.prepend(el);
            return item;
          });
        } else if (imgs[2]) imgs[2].cap = `Layer by layer · ${prog}%`;
      },
      unmount() { clearInterval(timer); },
    };
  }

  function bannerHTML(p) {
    const b = banner(p, units());
    return `<div class="banner ${b.anim ? 'anim' : ''}" style="background-image:${b.bg};box-shadow:0 0 28px ${b.glow}">
      ${icon(b.icon, 44)}<div class="grow"><div class="p">${esc(b.primary)}</div><div class="s">${esc(b.secondary)}</div></div></div>`;
  }

  function toolsHTML(p, mini = false) {
    const show = LS.get('aipa.monitor.showEmpty', false);
    const tools = visibleToolheads(p, show);
    if (!tools.length) return `<div class="card muted small">No toolheads in use${show ? '' : ' (empty slots hidden)'}</div>`;
    const u = units();
    if (mini) {
      return `<div class="mtools">${tools.map((t) => `<div class="mtool ${t.active ? 'act' : ''}" title="${esc(t.filament.vendor)}">
        <span class="sw" style="background:${t.filament.color || 'transparent'}"></span>
        <div class="grow"><b>T${t.i + 1}</b> ${esc(t.filament.type || '—')}<div class="muted">${fmtTemp(t.tempC, u)}${t.targetC ? ' → ' + fmtTemp(t.targetC, u) : ''}</div></div></div>`).join('')}</div>`;
    }
    return `<div class="tools" style="--n:${tools.length}">${tools.map((t) => {
      const f = t.filament;
      return `<div class="tool ${t.colSt}">
        <div class="tl ${t.active ? 'act' : ''}">TOOLHEAD ${t.i + 1}${t.active ? ' - ACTIVE' : ''}</div>
        <div class="tc"><span style="color:${t.col}">${icon(t.icon, 26)}</span>
          <div class="v">${fmtTemp(t.tempC, u)}</div>
          <div class="l">${t.label} · ${t.powerPct}%</div>
          <div class="tg">${t.targetC ? 'target ' + fmtTemp(t.targetC, u) : 'off'}${typeof t.fan === 'number' ? ` · fan ${Math.round(t.fan * 100)}%` : ''}</div>
          <div class="bar4"><i style="width:${t.bar}%;background:${t.col}"></i></div></div>
        ${f.loaded ? `<div class="swatch" style="background:${f.color};color:${f.text}"><b>${esc(f.type)}</b><span>${esc(f.vendor)}</span></div>`
          : p.kind === 'u1' ? '<div class="swatch none"><b>No filament set</b></div>' : ''}
      </div>`;
    }).join('')}</div>`;
  }

  function statsHTML(p) {
    const u = units();
    const b = bed(p), e = enclosure(p), l = layers(p);
    const stat = (ic, col, v, label, bar, barCol) => `<div class="card stat"><span style="color:${col}">${icon(ic, 28)}</span>
      <div class="v">${v}</div><div class="l">${label}</div><div class="bar4"><i style="width:${bar}%;background:${barCol || col}"></i></div></div>`;
    return `<div class="stats">
      ${b ? stat('bed', b.col, fmtTemp(b.tempC, u) + (b.targetC ? ` <span class="muted small">→ ${fmtTemp(b.targetC, u)}</span>` : ''), `Heated Bed · ${b.label}`, b.bar, '#f59e0b') : ''}
      ${e ? stat('enclosure', e.col, fmtTemp(e.tempC, u), 'Enclosure', e.bar, '#f59e0b') : ''}
      ${stat('layers', '#8b5cf6', l.tot ? `${l.cur} / ${l.tot}` : '—', 'Layers', l.bar)}
      ${stat('chip', '#06b6d4', p.memory_pct != null ? p.memory_pct + '%' : '—', 'Printer Memory', p.memory_pct || 0)}
    </div>`;
  }

  // the times: elapsed, estimated duration, time left, end time
  const clock = (ts) => new Date(ts * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const dur = (s) => (s == null || !isFinite(s) ? '—' : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')} min`);
  function timesHTML(p) {
    const now = Date.now() / 1000, j = p.job || {}, t = p.time || {};
    const active = ['printing', 'paused', 'preparing'].includes(p.stage), done = ['cooling', 'ready', 'waiting'].includes(p.stage);
    const elapsed = j.started_at ? ((done && j.ended_at ? j.ended_at : now) - j.started_at) : null;
    const est = active && elapsed != null && t.left != null ? elapsed + t.left : (done && elapsed != null ? elapsed : null);
    const row = (k, v, sub = '') => `<div class="trow"><span class="muted">${k}</span><b>${v}</b>${sub ? `<span class="small muted">${sub}</span>` : ''}</div>`;
    if (!active && !done) return '';
    return `<div class="card times">
      ${row('Started', j.started_at ? clock(j.started_at) : '—')}
      ${row(done ? 'Print took' : 'Elapsed', dur(elapsed))}
      ${active ? row('Time left', dur(t.left)) : ''}
      ${row('Estimated duration', dur(est), p.meta && p.meta.estimated_time ? `slicer said ${dur(p.meta.estimated_time)}` : '')}
      ${row(done ? 'Finished' : 'Ends', done && j.ended_at ? clock(j.ended_at) : t.eta ? clock(t.eta) : '—')}
    </div>`;
  }

  function chipsHTML(p) {
    const m = motion(p);
    const pct = (v) => (typeof v === 'number' ? Math.round(v * 100) + '%' : '—');
    const idx = EXTRUDERS.indexOf(p.status && p.status.toolhead && p.status.toolhead.extruder);
    return `<div class="chips">
      <span class="chip">${icon('speed', 16)} Speed <b>${pct(m.speed)}</b></span>
      <span class="chip">Flow <b>${pct(m.flow)}</b></span>
      ${m.fans.map((f) => `<span class="chip">${icon('fan', 16)} ${esc(f.name)} <b>${pct(f.speed)}</b></span>`).join('')}
      ${idx >= 0 ? `<span class="chip">Active tool <b>T${idx + 1}</b></span>` : ''}
      ${p.status && p.status.timelapse ? `<span class="chip">${icon('film', 16)} Timelapse <b>${p.status.timelapse.is_active ? 'recording' : 'off'}</b></span>` : ''}
    </div>`;
  }

  function progressHTML(p) {
    const pct = Math.round((p.progress || 0) * 1000) / 10;
    const active = ['printing', 'paused', 'preparing', 'cooling', 'ready', 'waiting'].includes(p.stage);
    const v = active ? pct : 0;
    return `<div class="progress"><div class="fill" style="width:${v}%"></div><div class="lbl">${active ? `${v.toFixed(v % 1 ? 1 : 0)}% complete` : 'No active print'}</div></div>`;
  }

  function controlsBind(box, pid) {
    box.addEventListener('click', async (ev) => {
      const b = ev.target.closest('button[data-act]');
      if (!b || b.disabled || !ev.isTrusted) return;
      const p = store.printers[pid], a = b.dataset.act;
      const name = esc(jobName(p.status && p.status.print_stats && p.status.print_stats.filename));
      const t = {
        pause: [`Pause ${p.name}?`, `Pause <b>${name}</b>? You can resume it afterwards with Resume.`, 'Pause print', false],
        resume: [`Resume ${p.name}?`, `Resume printing <b>${name}</b>.`, 'Resume print', false],
        cancel: [`Cancel the print on ${p.name}?`, `This stops <b>${name}</b> for good. It can’t be resumed.`, 'Cancel print', true],
      }[a];
      if (!(await confirmBox(...t))) return;
      try { await api(`/p/${encodeURIComponent(pid)}/control`, { method: 'POST', body: JSON.stringify({ action: a, confirm: true }) }); toast(`${t[2]}: sent`, p.name, 'good'); }
      catch (e) { toast(`${t[2]} failed`, e.message, 'error'); }
    });
  }
  function controlsHTML(p) {
    const st = p.state;
    return `<button class="ctl pause" data-act="pause" ${st === 'printing' ? '' : 'disabled'}><span class="bub">${icon('pause')}</span>Pause</button>
      <button class="ctl resume" data-act="resume" ${st === 'paused' ? '' : 'disabled'}><span class="bub">${icon('play')}</span>Resume</button>
      <button class="ctl cancel" data-act="cancel" ${['printing', 'paused'].includes(st) ? '' : 'disabled'}><span class="bub">${icon('stop')}</span>Cancel</button>`;
  }

  let comparisons = null;
  fetch('comparisons.json').then((r) => r.json()).then((x) => (comparisons = x)).catch(() => {});
  function funHTML(p) {
    const used = ((p.status && p.status.print_stats && p.status.print_stats.filament_used) || 0) / 1000;
    const t = p.totals || {};
    const tot = (t.total_filament_used || 0) / 1000;
    return `<div class="duo">
      <div class="card fun stat-line"><span style="color:#ec4899">${icon('ruler', 30)}</span><div class="grow">
        <div class="t1">${used.toFixed(1)} m of filament used</div><div class="t2">${esc(compare(used))}</div></div></div>
      <div class="card stat-line"><span style="color:#f59e0b">${icon('history', 30)}</span><div class="grow">
        <div class="t1">Lifetime: ${Math.round(t.total_jobs || 0)} jobs</div>
        <div class="t2">${tot.toFixed(1)} m filament · ${hms(t.total_print_time)} printing</div>
        ${comparisons && tot > 0 ? `<div class="t2 muted">${esc(compare(tot, comparisons))}</div>` : ''}</div></div>
    </div>`;
  }
  const STAGE_LABEL = { printing: 'Printing', preparing: 'Preparing', paused: 'Paused', cooling: 'Complete · cooling', ready: 'Complete', waiting: 'Complete', error: 'Error', cancelled: 'Cancelled', idle: 'Idle', offline: 'Offline' };

  // ---------------------------------------------------------------- one printer (the Home Assistant desktop layout)
  function printerView(el, pid) {
    el.innerHTML = `<div class="pp">
      <div class="pp-left">
        <div class="camera" data-cam></div>
        <div data-k="progress"></div>
        <div class="controls" data-k="controls"></div>
        <div data-k="chips"></div>
        <div data-k="fun"></div>
      </div>
      <div class="pp-right">
        <div data-k="banner"></div>
        <div class="pp-mid">
          <div class="card preview" data-rot></div>
          <div class="pp-midr"><div class="card filecard row" data-k="file"></div><div class="countdown" data-k="cd"></div></div>
        </div>
        <div data-k="times"></div>
        <div data-k="tools"></div>
        <div data-k="stats"></div>
        <label class="check small muted"><input type="checkbox" data-showempty ${LS.get('aipa.monitor.showEmpty', false) ? 'checked' : ''}> Show empty filament slots</label>
      </div></div>`;
    const k = (n) => el.querySelector(`[data-k="${n}"]`);
    const cam = mountCamera(el.querySelector('[data-cam]'), pid);
    const rot = mountRotator(el.querySelector('[data-rot]'), pid);
    controlsBind(k('controls'), pid);
    el.querySelector('[data-showempty]').addEventListener('change', (e) => { LS.set('aipa.monitor.showEmpty', e.target.checked); view.update(); });
    const view = {
      update() {
        const p = store.printers[pid];
        if (!p) return;
        document.title = `${p.name} · Print Monitor`;
        cam.update(p); rot.update(p);
        setHTML(k('banner'), bannerHTML(p));
        setHTML(k('progress'), progressHTML(p));
        setHTML(k('controls'), controlsHTML(p));
        setHTML(k('chips'), chipsHTML(p));
        setHTML(k('fun'), funHTML(p));
        const fname = (p.status && p.status.print_stats && p.status.print_stats.filename) || (p.job && p.job.filename);
        setHTML(k('file'), `<span style="color:#3b82f6">${icon('nozzleHeat', 30)}</span><div class="grow"><div class="name ellipsis">${esc(jobName(fname) || 'No file loaded')}</div><div class="sub">${esc(STAGE_LABEL[p.stage] || p.stage)}${p.meta && p.meta.slicer ? ' · ' + esc(p.meta.slicer) : ''}</div></div>`);
        const cd = countdown(p);
        setHTML(k('cd'), `<div class="big">${cd.big}</div><div class="lbl">${cd.label}</div>${cd.sub ? `<div class="sub">${cd.sub}</div>` : ''}`);
        setHTML(k('times'), timesHTML(p));
        setHTML(k('tools'), toolsHTML(p));
        setHTML(k('stats'), statsHTML(p));
      },
      unmount() { cam.unmount(); rot.unmount(); document.title = 'Print Monitor'; },
    };
    return view;
  }

  // ---------------------------------------------------------------- all printers side by side
  // lifetime print time: every printer and all together (from each printer's own history)
  function lifeHTML() {
    const ps = store.order.map((id) => store.printers[id]).filter(Boolean);
    const t = (p) => (p.totals && p.totals.total_print_time) || 0, j = (p) => (p.totals && p.totals.total_jobs) || 0, f = (p) => (p.totals && p.totals.total_filament_used) || 0;
    const all = ps.reduce((a, p) => a + t(p), 0);
    if (!all) return '';
    const hrs = (s) => { const h = s / 3600; return h >= 100 ? `${Math.round(h).toLocaleString()} h` : `${Math.floor(h)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')} m`; };
    return `<div class="life">
      <div class="card life-all"><span style="color:#f59e0b">${icon('history', 28)}</span><div><div class="lv">${hrs(all)}</div><div class="ll">printed on all printers · ${Math.round(ps.reduce((a, p) => a + j(p), 0)).toLocaleString()} prints · ${(ps.reduce((a, p) => a + f(p), 0) / 1000).toFixed(0)} m of filament</div></div></div>
      ${ps.map((p) => `<a class="card life-one" href="#/p/${esc(p.id)}"><div class="lv">${hrs(t(p))}</div><div class="ll">${esc(p.name)} · ${Math.round(j(p)).toLocaleString()} prints</div></a>`).join('')}
    </div>`;
  }
  function overviewView(el) {
    el.innerHTML = `<div data-life></div><div class="ov">${store.order.map((id) => `<section class="card ovc" data-p="${esc(id)}">
        <a class="hdr" href="#/p/${esc(id)}" style="color:inherit;text-decoration:none"><span class="nm grow ellipsis" data-k="name"></span><span class="pill" data-k="pill"></span></a>
        <div class="camera" data-cam></div>
        <div data-k="progress"></div>
        <div class="mini"><div data-k="cd"></div><div class="grow" data-k="txt"></div></div>
        <div data-k="tools"></div>
      </section>`).join('')}</div>`;
    const parts = store.order.map((id) => {
      const sec = el.querySelector(`[data-p="${CSS.escape(id)}"]`);
      return { id, sec, cam: mountCamera(sec.querySelector('[data-cam]'), id) };
    });
    return {
      update() {
        setHTML(el.querySelector('[data-life]'), lifeHTML());
        for (const { id, sec, cam } of parts) {
          const p = store.printers[id];
          if (!p) continue;
          const k = (n) => sec.querySelector(`[data-k="${n}"]`);
          cam.update(p);
          const b = banner(p, units());
          setHTML(k('name'), esc(p.name));
          const pill = k('pill'); pill.textContent = b.stage; pill.style.backgroundImage = b.bg;
          setHTML(k('progress'), progressHTML(p));
          const cd = countdown(p);
          const t = p.time || {};
          setHTML(k('cd'), `<div class="cd">${cd.big}</div><div class="cdl">${cd.sub || cd.label}</div>`);
          const fname = jobName((p.status && p.status.print_stats && p.status.print_stats.filename) || (p.job && p.job.filename));
          setHTML(k('txt'), `<div class="ellipsis"><b>${esc(fname || 'No file loaded')}</b></div><div class="small">${esc(b.primary)}</div><div class="small muted">${esc(b.secondary)}</div>`);
          setHTML(k('tools'), toolsHTML(p, true));
          void t;
        }
      },
      unmount() { parts.forEach((x) => x.cam.unmount()); },
    };
  }

  // ---------------------------------------------------------------- timelapses
  const fmtDate = (ts) => new Date(ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
  const pname = (id) => (store.printers[id] && store.printers[id].name) || id;
  const encPath = (s) => s.split('/').map(encodeURIComponent).join('/');
  function tabs(active, base) {
    return `<div class="tabs">${store.order.map((id) => `<a class="btn ${id === active ? 'on' : ''}" href="${base}/${esc(id)}">${esc(pname(id))}</a>`).join('')}</div>`;
  }
  function timelapseView(el, pid) {
    pid = pid && store.printers[pid] ? pid : store.order[0];
    el.innerHTML = `<h1 class="h2">${icon('film')} Timelapse videos</h1>${tabs(pid, '#/timelapse')}<div data-list><div class="empty">Loading…</div></div>`;
    const list = el.querySelector('[data-list]');
    let alive = true;
    const id = encodeURIComponent(pid);
    api(`/p/${id}/timelapses`).then((items) => {
      if (!alive) return;
      if (!items.length) { list.innerHTML = `<div class="empty">No timelapse videos on ${esc(pname(pid))} yet. The printer records one when timelapse is switched on for a print.</div>`; return; }
      const f = (v, p, dl) => url(`/p/${id}/file/${v.root}/${encPath(p)}${dl ? '?download=1' : ''}`);
      list.innerHTML = `<div class="mgrid">${items.map((v, i) => `<div class="card media">
          <button class="thumb" data-i="${i}" style="${v.cover ? `background-image:url('${f(v, v.cover)}')` : ''}" aria-label="Play ${esc(v.title)}">
            <span class="playo">${icon('play', 46)}</span></button>
          <div class="meta"><div class="t ellipsis">${i === 0 ? '★ ' : ''}${esc(v.title)}</div>
            <div class="small muted">${fmtDate(v.modified)} · ${mb(v.size || 0)}</div>
            <div class="acts"><a class="btn" href="${f(v, v.path, true)}" download>${icon('download', 16)} Download</a></div></div></div>`).join('')}</div>`;
      list.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-i]');
        if (!b) return;
        const v = items[+b.dataset.i];
        dialog(`<div class="db"><h3>${esc(v.title)}</h3>
          <video controls autoplay playsinline preload="metadata" src="${f(v, v.path)}"></video>
          <div class="small muted" style="margin-top:8px">${fmtDate(v.modified)} · ${mb(v.size || 0)}</div></div>
          <div class="da"><a class="btn" href="${f(v, v.path, true)}" download>${icon('download', 16)} Download</a><button class="btn primary" data-close="x">Close</button></div>`, { wide: true });
      });
    }).catch((e) => { if (alive) list.innerHTML = `<div class="empty bad">Couldn’t list the videos: ${esc(e.message)}</div>`; });
    return { unmount() { alive = false; } };
  }

  // ---------------------------------------------------------------- final photos (taken at 99 %)
  function galleryView(el) {
    let filter = LS.get('aipa.monitor.galleryFilter', '');
    el.innerHTML = `<h1 class="h2">${icon('image')} Final photos</h1>
      <p class="muted small" style="margin-top:-6px">Taken by the app at ${esc(store.settings.snapshot_progress)}% progress, while the part is still on the bed, and kept on your PC.</p>
      <div data-tabs></div><div data-list><div class="empty">Loading…</div></div>`;
    const list = el.querySelector('[data-list]');
    let items = [];
    const draw = () => {
      setHTML(el.querySelector('[data-tabs]'), `<div class="tabs">${[['', 'All printers'], ...store.order.map((id) => [id, pname(id)])]
        .map(([id, n]) => `<button class="btn ${id === filter ? 'on' : ''}" data-f="${esc(id)}">${esc(n)}</button>`).join('')}</div>`);
      const shown = items.filter((m) => !filter || m.printer === filter);
      if (!shown.length) { list.innerHTML = `<div class="empty">No photos yet. One is taken for every print at ${esc(store.settings.snapshot_progress)}%.</div>`; return; }
      list.innerHTML = `<div class="mgrid">${shown.map((m) => {
        const src = url(`/gallery/${encodeURIComponent(m.printer)}/${encodeURIComponent(m.file)}`);
        const dl = url(`/gallery/${encodeURIComponent(m.printer)}/${encodeURIComponent(m.file)}?download=1`);
        return `<div class="card media"><button class="thumb" data-view="${esc(src)}" data-dl="${esc(dl)}" data-title="${esc(m.job || '')}" style="background-image:url('${src}')" aria-label="View"></button>
          <div class="meta"><div class="t ellipsis">${esc((m.job || '').replace(/\.gcode$/i, ''))}</div>
            <div class="small muted">${esc(m.printer_name || pname(m.printer))} · ${fmtDate(m.taken)} · ${esc(m.kind)}</div>
            <div class="small muted">${m.layers ? m.layers + ' layers · ' : ''}${m.filament_m ? m.filament_m + ' m filament' : ''}</div>
            <div class="acts"><a class="btn" href="${dl}" download>${icon('download', 16)}</a>
            <button class="btn ghost" data-del="${esc(m.printer)}/${esc(m.file)}">${icon('trash', 16)}</button></div></div></div>`;
      }).join('')}</div>`;
    };
    el.addEventListener('click', async (ev) => {
      const f = ev.target.closest('[data-f]');
      if (f) { filter = f.dataset.f; LS.set('aipa.monitor.galleryFilter', filter); draw(); return; }
      const v = ev.target.closest('[data-view]');
      if (v) {
        dialog(`<div class="db"><h3>${esc(v.dataset.title)}</h3><img class="big-img" src="${v.dataset.view}" alt=""></div>
          <div class="da"><a class="btn" href="${v.dataset.dl}" download>${icon('download', 16)} Download</a><button class="btn primary" data-close="x">Close</button></div>`, { wide: true });
        return;
      }
      const d = ev.target.closest('[data-del]');
      if (d && await confirmBox('Delete this photo?', 'The photo is removed from your PC. This can’t be undone.', 'Delete', true)) {
        const [p, file] = d.dataset.del.split('/');
        try { await api(`/gallery/${encodeURIComponent(p)}/${encodeURIComponent(file)}`, { method: 'DELETE', headers: { 'x-aipa': '1' } }); items = items.filter((m) => !(m.printer === p && m.file === file)); draw(); }
        catch (e) { toast('Couldn’t delete it', e.message, 'error'); }
      }
    });
    api('/gallery').then((x) => { items = x; draw(); }).catch((e) => (list.innerHTML = `<div class="empty bad">${esc(e.message)}</div>`));
    return {};
  }

  // ---------------------------------------------------------------- start
  if (advisor && advisor.onMonitorFocus) advisor.onMonitorFocus((id) => { location.hash = id ? `#/p/${id}` : '#/'; });
  route();
  refreshState();
})();
