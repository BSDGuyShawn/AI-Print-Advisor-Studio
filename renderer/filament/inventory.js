// Filament inventory, built into AI 3D Print Advisor Studio (it began as a separate web page).
// boot.js fetches the saved data from the app before this script runs: window.__FIL =
//   { catalog: { orders, prices }, state, imagesBase, hasKey }.
// Everything is saved by the app in its data folder (filament\state.json), not in browser storage. Each change
// also saves what's on hand (filament\stock.json), which Color remix and the shopping check use.
// Only view preferences (filters, sort, current tab) stay in this page's localStorage.
const api = window.parent.advisor;
const BOOT = window.__FIL;
const ORDERS = BOOT.catalog.orders || [];   // purchase history imported from the old page's data.js
const PRICES = BOOT.catalog.prices || {};
let saveTimer = null, saveErr = false;   // see persist()
// An error from the app arrives as "Error invoking remote method 'x': Error: <message>"; keep the message.
const ipcMessage = e => String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');

// ======================================================================
// Constants
// ======================================================================
const UI_KEY = 'filamentInventory.ui.v2';
const FAMS = [
  ['Red','#d32f2f'],['Orange','#fb8c00'],['Yellow','#fdd835'],['Gold','linear-gradient(135deg,#f5e08a,#b8860b)'],
  ['Green','#2e9e44'],['Teal','#00968a'],['Blue','#1e5bd0'],['Purple','#7b3fa0'],['Pink','#f48fb1'],
  ['Brown','#6d4c41'],['Beige','#d8c3a0'],['White','#ffffff'],['Grey','#8a8a8a'],
  ['Silver','linear-gradient(135deg,#f4f4f4,#9a9a9a)'],['Black','#111111'],['Clear',null],
  ['Multicolor','conic-gradient(#d32f2f,#fdd835,#2e9e44,#1e5bd0,#7b3fa0,#d32f2f)']
];
const FAM_INDEX = Object.fromEntries(FAMS.map(([f], i) => [f, i]));
const SYNONYMS = { Grey:'gray', Clear:'transparent translucent see-through', Pink:'magenta rose', Purple:'violet lavender', Multicolor:'gradient rainbow dual multi', Silver:'metallic chrome', Gold:'metallic', Teal:'cyan aqua turquoise', Beige:'tan cream natural' };
const FINISHES = ['Standard','Matte','Silk','Translucent','Gradient','Metallic','Galaxy','Carbon Fiber','Wood','Color Change'];
const FIL_TYPES = ['PLA','PETG','PCTG','TPU','ABS','ASA','PLA-CF','PETG-CF','Nylon','Other'];
// Spool lifecycle, modeled on FilaMan's statuses plus "On order" for undelivered purchases.
const STATUSES = [
  { k:'ordered',  l:'On order', c:'#b7791f' },
  { k:'new',      l:'Sealed',   c:'#2f855a' },
  { k:'opened',   l:'Opened',   c:'#2b6cb0' },
  { k:'drying',   l:'Drying',   c:'#dd6b20' },
  { k:'active',   l:'Loaded',   c:'#805ad5' },
  { k:'empty',    l:'Empty',    c:'#718096' },
  { k:'archived', l:'Archived', c:'#a0aec0' },
];
const ST = Object.fromEntries(STATUSES.map(s => [s.k, s]));
const IN_STOCK = new Set(['new','opened','drying','active']);
const STATUS_FILTERS = [
  ['stock','In stock + on order', s => IN_STOCK.has(s.status) || s.status === 'ordered'],
  ['instock','In stock', s => IN_STOCK.has(s.status)],
  ['new','Sealed', s => s.status === 'new'],
  ['opened','Opened / in use', s => ['opened','active','drying'].includes(s.status)],
  ['active','Loaded in printer', s => s.status === 'active'],
  ['drying','Drying', s => s.status === 'drying'],
  ['low','Running low', s => lowLevel(s) > 0],
  ['ordered','On order', s => s.status === 'ordered'],
  ['empty','Empty', s => s.status === 'empty'],
  ['archived','Archived', s => s.status === 'archived'],
  ['all','All spools', () => true],
];
const SF = Object.fromEntries(STATUS_FILTERS.map(([k, , fn]) => [k, fn]));
// General starting points only; your filament's box / product page wins.
const TYPICAL = {
  PLA:  { nozzle:'190–230', bed:'55–65', dry:'50 °C · 4–6 h' },
  PETG: { nozzle:'230–250', bed:'70–85', dry:'65 °C · 4–6 h' },
  TPU:  { nozzle:'210–230', bed:'40–60', dry:'50 °C · 4–6 h' },
  PCTG: { nozzle:'240–260', bed:'70–85', dry:'65 °C · 4–6 h' },
  ABS:  { nozzle:'240–260', bed:'90–110', dry:'80 °C · 4 h' },
  ASA:  { nozzle:'240–260', bed:'90–110', dry:'80 °C · 4 h' },
};
// A new inventory starts with a shelf, a dry box and a slot per toolhead of each printer set up in the app's Settings.
const DEFAULT_LOCATIONS = [
  ['Shelf', false], ['Dry box', false],
  ...(BOOT.printers.length ? BOOT.printers : ['Printer 1']).flatMap(p => [1, 2, 3, 4].map(t => [`${p} · Toolhead ${t}`, true])),
];
// Bring saved location lists up to date without touching anything the user renamed or added.
// Each version step only adds what was new in that version, so locations the user deleted stay deleted.
function upgradeLocations() {
  const ver = state.locVer || 1;
  if (ver >= 3) return;
  let n = Math.max(0, ...state.locations.map(l => +l.id.slice(1) || 0)) + 1;
  const has = name => state.locations.some(l => l.name === name);
  const insertAfter = (afterName, name, printer = false) => {
    if (has(name)) return;
    const loc = { id:'L' + n++, name, printer };
    let i = state.locations.findIndex(l => l.name === afterName);
    if (i < 0) i = state.locations.findIndex(l => l.printer) - 1;   // else: end of the storage group
    state.locations.splice(i < 0 ? state.locations.length : i + 1, 0, loc);
  };
  if (ver < 2) {
    for (const l of state.locations) {
      const m = l.name.match(/^Snapmaker U1 · Toolhead (\d)$/);
      if (m) l.name = `Snapmaker U1 #1 · Toolhead ${m[1]}`;
    }
    for (const [name, printer] of DEFAULT_LOCATIONS)
      if (/^PopStation Mini|^Snapmaker U1 #[123]/.test(name) && !has(name)) state.locations.push({ id:'L' + n++, name, printer });
    state.locations.sort((a, b) => a.printer - b.printer);   // storage first, then printer slots (stable)
  }
  if (ver < 3) {
    const d = state.locations.find(l => l.name === 'SpacePi X4 dryer');
    if (d) d.name = 'SpacePi X4 dryer 1';
    insertAfter('SpacePi X4 dryer 1', 'SpacePi X4 dryer 2');
  }
  state.locVer = 3;
}

// ======================================================================
// Helpers
// ======================================================================
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const today = () => new Date().toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString();
const fmtDate = d => d ? new Date(d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' }) : '';
const fmtDT = d => d ? new Date(d).toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '';
const fmtKg = g => g >= 1000 ? (g / 1000).toFixed(1).replace(/\.0$/, '') + ' kg' : Math.round(g) + ' g';
const fmt$ = v => v == null ? '' : '$' + v.toFixed(2);
const fmt$0 = v => '$' + Math.round(v).toLocaleString();
const specFor = (brand, line, finish) => (typeof SPECS !== 'undefined' && (SPECS[`${brand}|${line}|${finish}`] || SPECS[`${brand}|${line}`])) || null;
function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { toast('Could not save: ' + e.message); } }
let toastTimer;
function toast(msg, ms = 2000) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms); }
function swatchBg(hex) { return Array.isArray(hex) ? `linear-gradient(135deg,${hex.join(',')})` : (hex || '#ccc'); }
function famBg(f) { const v = FAMS[FAM_INDEX[f]]?.[1]; return v == null ? '' : `background:${v}`; }
const famDot = f => `<span class="dot ${f === 'Clear' ? 'clearpat' : ''}" style="${famBg(f)}"></span>`;
function swatchStyle(f) {
  const clear = f.fams.includes('Clear') && !Array.isArray(f.hex);
  return clear ? `background:linear-gradient(${f.hex}cc,${f.hex}cc),repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/8px 8px` : `background:${swatchBg(f.hex)}`;
}
const itemSwatch = (f, cls) => `<span class="dot ${cls}" style="${swatchStyle(f)}"></span>`;
const stPill = k => `<span class="st" style="--c:${ST[k].c}">${ST[k].l}</span>`;
const typeOrder = t => ({ PLA:0, PETG:1, PCTG:2, ABS:3 })[t] ?? 4;

// ======================================================================
// Catalog (one entry per product + color) built from data.js
// ======================================================================
function buildBase() {
  const map = new Map();
  ORDERS.forEach(o => {
    const total = o.colors.reduce((s, c) => s + (c[3] || 1), 0);
    const unit = o.noPrice ? null : PRICES[`${o.asin}|${o.date}`] ?? null;
    const perSpool = unit == null ? null : +(o.bundle ? unit / total : unit).toFixed(2);
    for (const [color, fams, hex, n = 1] of o.colors) {
      const id = slug([o.brand, o.type, o.line, color, o.grams].join(' '));
      let f = map.get(id);
      if (!f) {
        f = { id, brand:o.brand, type:o.type, line:o.line, finish:o.finish, color, grams:o.grams, fams:fams.split(','), hex,
              img:null, imgFromBundle:true, sources:[], note:o.note || '', custom:false,
              spec: specFor(o.brand, o.line, o.finish) };
        map.set(id, f);
      }
      if (!f.img || (f.imgFromBundle && !o.bundle)) { f.img = `${BOOT.imagesBase}${o.asin}.jpg`; f.imgFromBundle = o.bundle; }
      const srcs = [];
      for (let i = 0; i < n; i++) srcs.push(`${o.asin}|${o.date}|${color}|${o.grams}|${i}`);
      f.sources.push({ asin:o.asin, date:o.date, store:o.store || "Amazon", url:o.url || `https://www.amazon.com/dp/${o.asin}`, n, pending:!!o.pending, bundle:o.bundle, price:perSpool, srcs });
    }
  });
  return [...map.values()];
}
const BASE = buildBase();

// ======================================================================
// State: per-spool tracking (status, remaining grams, location, history)
// ======================================================================
let state = BOOT.state;
if (!state) state = migrateV1(null);   // first start: a spool for every imported order line (none for a new user)
upgradeLocations();
syncSources();
persist();

function blankState() {
  return { v:2, locVer:3, seq:1, spools:{}, fil:{}, custom:[], deletedSrc:[],
           locations: DEFAULT_LOCATIONS.map(([name, printer], i) => ({ id:'L' + (i + 1), name, printer })),
           settings: { low:150, empty:{}, reusable:'', theme:'auto', label:'sheet' } };
}
function filDef(fid) { return BASE.find(b => b.id === fid) || state.custom.find(c => c.id === fid); }
function newSpool(fid, o = {}) {
  const f = filDef(fid);
  const id = String(state.seq++).padStart(3, '0');
  const status = o.status || 'new';
  state.spools[id] = { id, fid, src:o.src || null, status, rem: o.rem ?? (status === 'empty' ? 0 : f.grams), loc:o.loc || '',
    price:o.price ?? null, bought:o.bought || today(), opened:null, used:null, emptyG:null,
    log:[{ t:nowISO(), type:'created', note:o.note || (o.src ? 'Imported from order' : 'Added') }] };
  return state.spools[id];
}
function syncSources() {
  const have = new Set(Object.values(state.spools).map(s => s.src).filter(Boolean));
  const deleted = new Set(state.deletedSrc);
  for (const f of BASE) for (const src of f.sources) for (const key of src.srcs) {
    if (have.has(key) || deleted.has(key)) continue;
    newSpool(f.id, { src:key, status: src.pending ? 'ordered' : 'new', price:src.price, bought:src.date });
  }
}
// v1 stored only a count + notes per color; turn that into individual spools.
function migrateV1(v1) {
  state = blankState();
  syncSources();
  if (!v1) return state;
  for (const [fid, q] of Object.entries(v1.qty || {})) {
    const sp = Object.values(state.spools).filter(s => s.fid === fid);
    const f = filDef(fid); if (!f) continue;
    if (q < sp.length) sp.slice(q).forEach(s => { s.status = 'empty'; s.rem = 0; s.log.push({ t:nowISO(), type:'status', to:'empty', note:'Carried over from the old version' }); });
    for (let i = sp.length; i < q; i++) newSpool(fid, { note:'Carried over from the old version' });
  }
  for (const [fid, n] of Object.entries(v1.notes || {})) (state.fil[fid] ||= {}).notes = n;
  for (const c of v1.custom || []) {
    const { qty = 0, ...def } = c;
    state.custom.push(def);
    for (let i = 0; i < qty; i++) newSpool(def.id, { bought:def.added });
  }
  return state;
}
// Saved by the app a moment after the last change (typing in a note doesn't save on every key), and right away
// when the page goes away. Each save also sends what's on hand, for Color remix and the shopping check.
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 300); }
function flushSave() {
  clearTimeout(saveTimer); saveTimer = null;
  return api.filamentSave({ state, stock: advisorStock() }).then(() => {
    if (saveErr) { saveErr = false; toast('Saved'); }
  }, e => { saveErr = true; toast('Couldn’t save your filament: ' + ipcMessage(e), 8000); });
}
window.addEventListener('pagehide', () => { if (saveTimer) flushSave(); });

function logEv(s, type, data = {}) { s.log.push({ t:nowISO(), type, ...data }); }

const spoolsOf = fid => Object.values(state.spools).filter(s => s.fid === fid);
const locName = id => state.locations.find(l => l.id === id)?.name || '';
const isPrinterLoc = id => !!state.locations.find(l => l.id === id)?.printer;
function lowLevel(s) { // 0 ok, 1 low, 2 critical (FilaMan: critical = half the threshold)
  if (!['opened','active','drying'].includes(s.status)) return 0;
  const th = state.settings.low || 0;
  if (s.rem <= th / 2) return 2;
  return s.rem <= th ? 1 : 0;
}
function emptyWeightFor(s) {
  const f = filDef(s.fid);
  if (s.emptyG != null) return s.emptyG;
  if (/refill/i.test(f.note || '') && state.settings.reusable !== '') return +state.settings.reusable;
  const v = state.settings.empty[f.brand];
  return v === '' || v == null ? null : +v;
}

// Status / location / weight changes keep each other consistent.
function setStatus(s, to, note) {
  if (s.status === to) return;
  const from = s.status;
  s.status = to;
  if (to === 'empty') s.rem = 0;
  if (from === 'ordered' && to === 'new') s.bought = s.bought || today();
  if (['opened','active','drying'].includes(to) && !s.opened) s.opened = today();
  if (to !== 'active' && isPrinterLoc(s.loc)) s.loc = '';
  logEv(s, 'status', { from, to, note });
}
function setLoc(s, loc) {
  if (s.loc === loc) return;
  logEv(s, 'move', { from:locName(s.loc) || 'none', to:locName(loc) || 'none' });
  const wasPrinter = isPrinterLoc(s.loc);
  s.loc = loc;
  if (isPrinterLoc(loc) && s.status !== 'active') { // only one spool per printer slot
    Object.values(state.spools).forEach(o => { if (o !== s && o.loc === loc) { o.loc = ''; if (o.status === 'active') setStatus(o, 'opened', 'Unloaded'); } });
    setStatus(s, 'active');
  } else if (wasPrinter && !isPrinterLoc(loc) && s.status === 'active') setStatus(s, 'opened', 'Unloaded');
}
function setRem(s, g, type = 'weight', extra = {}) {
  g = Math.max(0, Math.round(g));
  const delta = g - s.rem;
  s.rem = g;
  logEv(s, type, { delta, rem:g, ...extra });
  if (g === 0 && s.status !== 'empty') setStatus(s, 'empty');
  else if (g > 0 && s.status === 'new' && delta < 0) setStatus(s, 'opened');
  else if (g > 0 && s.status === 'empty') setStatus(s, 'opened');
  if (delta < 0) s.used = today();
}

// ======================================================================
// Derived view of filaments
// ======================================================================
function allFilaments() {
  const defs = BASE.concat(state.custom.map(c => ({ ...c, sources:[], custom:true, imgFromBundle:false, spec: specFor(c.brand, c.line, c.finish) })));
  return defs.map(f => {
    const fx = state.fil[f.id] || {};
    const sp = spoolsOf(f.id).sort((a, b) => a.id.localeCompare(b.id));
    const stock = sp.filter(s => IN_STOCK.has(s.status));
    const fams = Array.isArray(f.hex) && !f.fams.includes('Multicolor') ? [...f.fams, 'Multicolor'] : f.fams;
    const hay = [f.brand, f.type, f.line, f.finish, f.color, f.note, fx.notes, f.grams + 'g', ...fams, ...fams.map(x => SYNONYMS[x] || ''),
      ...sp.map(s => `#${s.id} ${s.id} ${locName(s.loc)} ${ST[s.status].l}`)].join(' ').toLowerCase();
    return { ...f, fams, fx, spools:sp, stock, qty:stock.length,
      ordered: sp.filter(s => s.status === 'ordered').length,
      remG: stock.reduce((t, s) => t + s.rem, 0), low: Math.max(0, ...sp.map(lowLevel)),
      lastDate: f.sources?.map(s => s.date).sort().pop() || f.added || '', hay };
  });
}

// ======================================================================
// UI state + filtering
// ======================================================================
let ui = Object.assign({ view:'inventory', q:'', type:'All', brand:'', finish:'', fams:[], status:'stock', loc:'', group:'type-fam', sort:'color', tsort:'id', tasc:true }, load(UI_KEY, {}));
const persistUI = () => save(UI_KEY, ui);

function spoolPass(s) { return SF[ui.status](s) && (!ui.loc || (ui.loc === '-' ? !s.loc : s.loc === ui.loc)); }
function filPass(f, ignore = '') {
  const terms = ui.q.toLowerCase().split(/\s+/).filter(Boolean);
  return (ignore === 'type' || ui.type === 'All' || f.type === ui.type) &&
    (!ui.brand || f.brand === ui.brand) && (!ui.finish || f.finish === ui.finish) &&
    (ignore === 'fams' || !ui.fams.length || ui.fams.some(x => f.fams.includes(x))) &&
    terms.every(t => f.hay.includes(t)) &&
    (ui.status === 'all' && !ui.loc ? true : f.spools.some(spoolPass));
}
const primaryFam = f => f.fams.filter(x => x !== 'Multicolor').sort((a, b) => FAM_INDEX[a] - FAM_INDEX[b])[0] || 'Multicolor';
function sorter(a, b) {
  switch (ui.sort) {
    case 'brand': return a.brand.localeCompare(b.brand) || a.line.localeCompare(b.line) || a.color.localeCompare(b.color);
    case 'qty': return b.qty - a.qty || a.color.localeCompare(b.color);
    case 'remaining': return (a.qty ? a.remG : 1e9) - (b.qty ? b.remG : 1e9);
    case 'rating': return (b.fx.rating || 0) - (a.fx.rating || 0) || a.color.localeCompare(b.color);
    case 'date': return b.lastDate.localeCompare(a.lastDate) || a.color.localeCompare(b.color);
    default: return FAM_INDEX[primaryFam(a)] - FAM_INDEX[primaryFam(b)] || a.color.localeCompare(b.color) || a.brand.localeCompare(b.brand);
  }
}

// ======================================================================
// Render: header + filters
// ======================================================================
function render() {
  const fil = allFilaments();
  document.documentElement.dataset.theme = state.settings.theme === 'auto' ? '' : state.settings.theme;
  if (state.settings.theme === 'auto') delete document.documentElement.dataset.theme;
  const all = Object.values(state.spools);
  const stock = all.filter(s => IN_STOCK.has(s.status));
  const lowN = all.filter(s => lowLevel(s) > 0).length;
  const ordered = all.filter(s => s.status === 'ordered').length;
  $('#stats').innerHTML = `<span><b>${stock.length}</b> spools</span><span><b>${fmtKg(stock.reduce((t, s) => t + s.rem, 0))}</b> on hand</span>${ordered ? `<span><b>${ordered}</b> on order</span>` : ''}`;
  document.querySelectorAll('#tabs a').forEach(a => {
    a.classList.toggle('on', a.dataset.view === ui.view);
    if (a.dataset.view === 'dashboard') a.innerHTML = 'Dashboard' + (lowN ? `<span class="pill">${lowN}</span>` : '');
  });
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + ui.view));
  $('#filterBar').style.display = ['inventory','spools'].includes(ui.view) ? '' : 'none';
  if (['inventory','spools'].includes(ui.view)) renderFilters(fil);
  ({ inventory:renderInventory, spools:renderSpools, dashboard:renderDashboard, settings:renderSettings })[ui.view](fil);
}

function renderFilters(fil) {
  const tFil = fil.filter(f => filPass(f, 'type'));
  const countSp = arr => arr.reduce((t, f) => t + f.spools.filter(spoolPass).length, 0);
  const types = ['All', ...[...new Set(fil.map(f => f.type))].sort((a, b) => typeOrder(a) - typeOrder(b))];
  $('#typeSeg').innerHTML = types.map(t => `<button data-type="${esc(t)}" class="${ui.type === t ? 'on' : ''}">${esc(t)}<small>${countSp(tFil.filter(f => t === 'All' || f.type === t))}</small></button>`).join('');
  $('#statusSel').innerHTML = STATUS_FILTERS.map(([k, l]) => `<option value="${k}" ${k === ui.status ? 'selected' : ''}>${l}</option>`).join('');
  $('#locSel').innerHTML = `<option value="">All locations</option><option value="-" ${ui.loc === '-' ? 'selected' : ''}>No location set</option>` +
    state.locations.map(l => `<option value="${l.id}" ${l.id === ui.loc ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  const brands = [...new Set(fil.map(f => f.brand))].sort((a, b) => a.localeCompare(b));
  $('#brandSel').innerHTML = `<option value="">All brands</option>` + brands.map(b => `<option ${b === ui.brand ? 'selected' : ''}>${esc(b)}</option>`).join('');
  const finishes = FINISHES.filter(x => fil.some(f => f.finish === x)).concat([...new Set(fil.map(f => f.finish))].filter(x => !FINISHES.includes(x)));
  $('#finishSel').innerHTML = `<option value="">All finishes</option>` + finishes.map(x => `<option ${x === ui.finish ? 'selected' : ''}>${esc(x)}</option>`).join('');
  $('#groupSel').value = ui.group; $('#sortSel').value = ui.sort;
  $('#groupSel').style.display = $('#sortSel').style.display = ui.view === 'inventory' ? '' : 'none';
  if ($('#q').value !== ui.q) $('#q').value = ui.q;
  const fFil = fil.filter(f => filPass(f, 'fams'));
  const active = ui.fams.length || ui.q || ui.brand || ui.finish || ui.type !== 'All' || ui.status !== 'stock' || ui.loc;
  $('#famChips').innerHTML = FAMS.map(([x]) => {
    const n = countSp(fFil.filter(f => f.fams.includes(x)));
    if (!n && !ui.fams.includes(x)) return '';
    return `<button class="chip ${ui.fams.includes(x) ? 'on' : ''}" data-fam="${x}">${famDot(x)}${x}<small>${n}</small></button>`;
  }).join('') + (active ? `<button class="chip clear" data-clear>Clear filters ✕</button>` : '');
}

// ======================================================================
// Inventory (cards)
// ======================================================================
function renderInventory(fil) {
  const list = fil.filter(f => filPass(f)).sort(sorter);
  const el = $('#view-inventory');
  if (!allFilaments().length) {   // nothing added yet: how to start
    el.innerHTML = `<div class="empty" style="max-width:620px;margin:0 auto;text-align:left;line-height:1.55">
      <h2 style="margin:0 0 6px;color:var(--text)">Add the filament you have</h2>
      Color remix picks from it, and the app tells you which colors a model needs that you don't have yet.
      <div class="actions" style="margin-top:14px">
        <button class="btn primary" data-start="shot">📷 From a screenshot of your orders</button>
        <button class="btn" data-start="add">+ Add filament by hand</button>
      </div>
      <p class="muted" style="font-size:13px;margin:10px 0 0">Screenshots work from Amazon or any store's order history, a receipt or a product page; Claude reads them with the API key from Settings.</p></div>`;
    return;
  }
  if (!list.length) { el.innerHTML = `<div class="empty">No filament matches.<br><br><button class="btn" data-clear>Clear filters</button></div>`; return; }
  el.innerHTML = groupBy(list).map(g => `
    <div class="section">
      ${g.title ? `<h2>${g.title}<small>${g.count} spool${g.count === 1 ? '' : 's'} · ${g.colors} color${g.colors === 1 ? '' : 's'}</small></h2>` : ''}
      ${g.subs.map(s => `${s.title ? `<h3>${s.title} <span style="font-weight:500">${s.count}</span></h3>` : ''}<div class="grid">${s.items.map(card).join('')}</div>`).join('')}
    </div>`).join('');
}
function groupBy(list) {
  const sum = arr => arr.reduce((t, f) => t + f.qty, 0);
  const famTitle = x => `${famDot(x)}${x}`;
  const bucket = (arr, keyFn, orderFn) => {
    const m = new Map();
    for (const it of arr) for (const k of [].concat(keyFn(it))) { if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
    return [...m.entries()].sort((a, b) => orderFn(a[0], b[0]));
  };
  const famOrder = (a, b) => FAM_INDEX[a] - FAM_INDEX[b];
  const mk = (title, arr, subs) => ({ title, count:sum(arr), colors:arr.length, subs });
  const byType = (arr, sub) => bucket(arr, f => f.type, (a, b) => typeOrder(a) - typeOrder(b)).map(([t, a2]) => mk(esc(t), a2, sub(a2)));
  switch (ui.group) {
    case 'type': return byType(list, a => [{ items:a }]);
    case 'brand': return bucket(list, f => f.brand, (a, b) => a.localeCompare(b)).map(([b, arr]) => mk(esc(b), arr,
      bucket(arr, f => f.type, (a, b) => typeOrder(a) - typeOrder(b)).map(([t, a2]) => ({ title:esc(t), count:sum(a2), items:a2 }))));
    case 'fam': return bucket(list, primaryFam, famOrder).map(([x, arr]) => mk(famTitle(x), arr, [{ items:arr }]));
    case 'loc': {
      const order = ['', ...state.locations.map(l => l.id)];
      return bucket(list, f => [...new Set(f.spools.filter(spoolPass).map(s => s.loc))], (a, b) => (order.indexOf(a) - order.indexOf(b)) || 0)
        .sort((a, b) => (a[0] === '') - (b[0] === '')).map(([l, arr]) => mk(esc(locName(l) || 'No location set'), arr, [{ items:arr }]));
    }
    case 'none': return [{ title:'', subs:[{ items:list }] }];
    default: return byType(list, a2 => bucket(a2, primaryFam, famOrder).map(([x, a3]) => ({ title:famTitle(x), count:sum(a3), items:a3 })));
  }
}
function meterHTML(f) {
  if (!f.stock.length) return '<div class="meter"></div>';
  return `<div class="meter">${f.stock.map(s => `<i class="${['','low','crit'][lowLevel(s)]}" style="width:${Math.max(3, 100 * s.rem / f.grams / f.stock.length)}%"></i>`).join('')}</div>`;
}
function card(f) {
  const photo = f.img ? `<img loading="lazy" src="${esc(f.img)}" alt="">` : itemSwatch(f, 'big-swatch');
  const opened = f.stock.filter(s => s.status !== 'new').length;
  const parts = [`${f.qty} spool${f.qty === 1 ? '' : 's'}`];
  if (opened) parts.push(`${opened} open`);
  if (f.qty) parts.push(fmtKg(f.remG));
  const tags = [f.finish !== 'Standard' ? f.finish : '', f.grams !== 1000 ? f.grams + ' g' : ''].filter(Boolean);
  const loaded = f.spools.find(s => s.status === 'active');
  return `<article class="card ${f.qty + f.ordered === 0 ? 'out' : ''}" data-fid="${esc(f.id)}">
    <div class="photo">${photo}${itemSwatch(f, 'swatch')}
      <div class="badges"><span class="badge ${f.type.toLowerCase()}">${esc(f.type)}</span>
        ${f.ordered ? `<span class="badge warn">${f.ordered} on order</span>` : ''}
        ${f.low ? `<span class="badge ${f.low === 2 ? 'crit' : 'warn'}">${f.low === 2 ? 'Almost out' : 'Low'}</span>` : ''}
        ${loaded ? `<span class="badge" style="background:#805ad5">Loaded</span>` : ''}
        ${f.img && f.imgFromBundle ? `<span class="badge bundle" title="Photo shows the whole bundle">bundle</span>` : ''}</div>
      ${f.fx.rating ? `<span class="fav">${'★'.repeat(f.fx.rating)}</span>` : ''}
    </div>
    <div class="body"><div class="cname">${esc(f.color)}</div><div class="meta">${esc(f.brand)} · ${esc(f.line)}${tags.length ? ' · ' + tags.map(esc).join(' · ') : ''}</div></div>
    <div class="foot"><div class="sum">${parts.join(' · ')}${meterHTML(f)}</div>
      <div class="stepper" data-stop><button data-dq="-1" title="Mark one spool used up">−</button><span>${f.qty}</span><button data-dq="1" title="Add a sealed spool">+</button></div>
    </div></article>`;
}
function quickStep(fid, dir) {
  if (dir > 0) { newSpool(fid, { note:'Added with +' }); toast('Added a sealed spool'); }
  else {
    const f = allFilaments().find(x => x.id === fid);
    if (!f.stock.length) return;
    // use up the spool that's furthest along: loaded/opened first, then least remaining
    const rank = s => ({ active:0, opened:1, drying:2, new:3 })[s.status];
    const s = [...f.stock].sort((a, b) => rank(a) - rank(b) || a.rem - b.rem)[0];
    setStatus(s, 'empty', 'Marked used up with −');
    toast(`Spool #${s.id} marked empty`);
  }
  persist(); render();
}

// ======================================================================
// Spools (table)
// ======================================================================
const selected = new Set();
function renderSpools(fil) {
  const byId = Object.fromEntries(fil.map(f => [f.id, f]));
  let rows = fil.filter(f => filPass(f)).flatMap(f => f.spools.filter(spoolPass).map(s => ({ s, f })));
  const cols = [
    ['id','#', r => r.s.id], ['color','Filament', r => r.f.color], ['brand','Brand', r => r.f.brand + r.f.line], ['type','Type', r => r.f.type],
    ['status','Status', r => STATUSES.findIndex(x => x.k === r.s.status)], ['rem','Remaining', r => r.s.rem], ['loc','Location', r => locName(r.s.loc) || '~'],
    ['bought','Bought', r => r.s.bought || ''], ['price','Paid', r => r.s.price ?? -1], ['used','Last used', r => r.s.used || ''],
  ];
  const key = cols.find(c => c[0] === ui.tsort) || cols[0];
  rows.sort((a, b) => { const x = key[2](a), y = key[2](b); return (x < y ? -1 : x > y ? 1 : 0) * (ui.tasc ? 1 : -1); });
  for (const id of [...selected]) if (!state.spools[id]) selected.delete(id);
  const allSel = rows.length && rows.every(r => selected.has(r.s.id));
  $('#view-spools').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
      <strong>${rows.length} spool${rows.length === 1 ? '' : 's'}</strong><span class="muted">${fmtKg(rows.reduce((t, r) => t + r.s.rem, 0))} remaining</span>
      <span class="spacer"></span>
      <button class="btn small" data-export-csv>Export CSV</button>
    </div>
    ${rows.length ? `<div class="tablewrap"><table class="spools"><thead><tr>
      <th style="width:30px"><input type="checkbox" data-selall ${allSel ? 'checked' : ''}></th>
      ${cols.map(c => `<th data-tsort="${c[0]}" class="${ui.tsort === c[0] ? 'sorted' + (ui.tasc ? ' asc' : '') : ''}">${c[1]}</th>`).join('')}
    </tr></thead><tbody>
    ${rows.map(({ s, f }) => `<tr data-sid="${s.id}" data-fid="${esc(f.id)}" class="${selected.has(s.id) ? 'sel' : ''}">
      <td><input type="checkbox" data-sel="${s.id}" ${selected.has(s.id) ? 'checked' : ''}></td>
      <td class="sid">#${s.id}</td>
      <td>${f.img ? `<img class="thumb" loading="lazy" src="${esc(f.img)}" alt="">` : itemSwatch(f, 'thumb')} ${itemSwatch(f, '')} <span class="cname">${esc(f.color)}</span></td>
      <td>${esc(f.brand)} <span class="muted">${esc(f.line)}</span></td>
      <td>${esc(f.type)}</td>
      <td>${stPill(s.status)}</td>
      <td><div class="rem"><div class="meter"><i class="${['','low','crit'][lowLevel(s)]}" style="width:${Math.min(100, 100 * s.rem / f.grams)}%"></i></div>${s.rem} g</div></td>
      <td>${esc(locName(s.loc)) || '<span class="muted">—</span>'}</td>
      <td>${fmtDate(s.bought)}</td>
      <td>${fmt$(s.price)}</td>
      <td>${fmtDate(s.used) || '<span class="muted">—</span>'}</td>
    </tr>`).join('')}</tbody></table></div>` : `<div class="empty">No spools match.<br><br><button class="btn" data-clear>Clear filters</button></div>`}
    <div class="bulk ${selected.size ? 'on' : ''}">
      <strong>${selected.size} selected</strong>
      <select data-bulk-status><option value="">Set status…</option>${STATUSES.map(s => `<option value="${s.k}">${s.l}</option>`).join('')}</select>
      <select data-bulk-loc><option value="">Move to…</option><option value="-">No location</option>${state.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>
      <button class="btn small" data-bulk-labels>Print labels</button>
      <span class="spacer"></span>
      <button class="btn small" data-bulk-clear>Clear selection</button>
    </div>`;
}
function exportCSV() {
  const fil = Object.fromEntries(allFilaments().map(f => [f.id, f]));
  const head = ['Spool','Brand','Line','Type','Finish','Color','Status','Remaining g','Spool size g','Location','Bought','Price','Opened','Last used','Order ID (ASIN / SKU)','Notes'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = Object.values(state.spools).sort((a, b) => a.id.localeCompare(b.id)).map(s => {
    const f = fil[s.fid];
    return [s.id, f.brand, f.line, f.type, f.finish, f.color, ST[s.status].l, s.rem, f.grams, locName(s.loc), s.bought, s.price, s.opened, s.used, s.src?.split('|')[0], f.fx.notes].map(q).join(',');
  });
  download(`filament-spools-${today()}.csv`, [head.map(q).join(','), ...lines].join('\r\n'), 'text/csv');
}
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ======================================================================
// Dashboard
// ======================================================================
function renderDashboard(fil) {
  const byId = Object.fromEntries(fil.map(f => [f.id, f]));
  const all = Object.values(state.spools);
  const stock = all.filter(s => IN_STOCK.has(s.status));
  const remG = stock.reduce((t, s) => t + s.rem, 0);
  const spent = all.reduce((t, s) => t + (s.price || 0), 0);
  const value = stock.reduce((t, s) => t + (s.price || 0) * s.rem / byId[s.fid].grams, 0);
  const low = all.filter(s => lowLevel(s) > 0).sort((a, b) => a.rem - b.rem);
  const ordered = all.filter(s => s.status === 'ordered');
  const sealed = stock.filter(s => s.status === 'new').length;
  const priced = stock.filter(s => s.price);
  const perKg = priced.length ? priced.reduce((t, s) => t + s.price / (byId[s.fid].grams / 1000), 0) / priced.length : 0;

  const agg = keyFn => { const m = new Map(); for (const s of stock) for (const k of [].concat(keyFn(s))) { const e = m.get(k) || { g:0, n:0 }; e.g += s.rem; e.n++; m.set(k, e); } return m; };
  const bars = (m, opts = {}) => {
    const rows = [...m.entries()].sort(opts.order || ((a, b) => b[1].g - a[1].g)).slice(0, opts.limit || 99);
    const max = Math.max(1, ...rows.map(r => r[1].g));
    return `<div class="bars">${rows.map(([k, e]) => {
      const lab = opts.label ? opts.label(k) : esc(k);
      const tip = `${opts.tipName ? opts.tipName(k) : k}: ${fmtKg(e.g)} on ${e.n} spool${e.n === 1 ? '' : 's'}`;
      const fill = opts.fill ? opts.fill(k) : '';
      return `<span class="lab" data-tip="${esc(tip)}">${lab}</span><div class="track" data-tip="${esc(tip)}"><div class="fill ${fill ? 'fam' : ''}" style="width:${100 * e.g / max}%;${fill}"></div></div><span class="val">${fmtKg(e.g)} · ${e.n}</span>`;
    }).join('')}</div>`;
  };
  const famFill = x => x === 'Clear' ? 'background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/8px 8px' : famBg(x);
  const printerLocs = state.locations.filter(l => l.printer);
  const recent = all.flatMap(s => s.log.filter(e => e.type !== 'created').map(e => ({ e, s }))).sort((a, b) => b.e.t.localeCompare(a.e.t)).slice(0, 12);
  const listItem = (s, right) => { const f = byId[s.fid]; return `<div class="it" data-open-fid="${esc(f.id)}">${itemSwatch(f, '')}<span class="grow"><b>${esc(f.color)}</b> <span class="muted">${esc(f.brand)} ${esc(f.type)} · #${s.id}</span></span>${right}</div>`; };

  $('#view-dashboard').innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="v">${stock.length}</div><div class="l">Spools in stock · ${sealed} sealed</div></div>
      <div class="kpi"><div class="v">${fmtKg(remG)}</div><div class="l">Filament on hand</div></div>
      <div class="kpi"><div class="v">${new Set(stock.map(s => s.fid)).size}</div><div class="l">Different colors</div></div>
      <div class="kpi"><div class="v">${fmt$0(spent)}</div><div class="l">Spent on tracked spools</div></div>
      <div class="kpi"><div class="v">${fmt$0(value)}</div><div class="l">Value of what's left · ~$${perKg.toFixed(2)}/kg</div></div>
      <div class="kpi ${low.length ? 'alert' : ''}"><div class="v">${low.length}</div><div class="l">Running low (≤ ${state.settings.low} g)</div></div>
    </div>
    <div class="panels">
      ${printerLocs.length ? `<div class="panel" style="grid-column:1/-1"><h3>Loaded in printers</h3><div class="slots">${printerLocs.map(l => {
        const s = all.find(x => x.loc === l.id && x.status === 'active'); const f = s && byId[s.fid];
        return s ? `<div class="slot full" data-open-fid="${esc(f.id)}"><span class="sn">${esc(l.name)}</span><span style="display:flex;gap:8px;align-items:center">${itemSwatch(f, '')}<b>${esc(f.color)}</b></span><span class="muted">${esc(f.brand)} ${esc(f.type)} · ${s.rem} g</span></div>`
                 : `<div class="slot"><span class="sn">${esc(l.name)}</span><span class="muted">Empty. Move a spool here to mark it loaded.</span></div>`;
      }).join('')}</div></div>` : ''}
      <div class="panel"><h3>On hand by type <small>· kg · spools</small></h3>${bars(agg(s => byId[s.fid].type))}</div>
      <div class="panel"><h3>On hand by color <small>· kg · spools</small></h3>${bars(agg(s => primaryFam(byId[s.fid])), { order:(a, b) => FAM_INDEX[a[0]] - FAM_INDEX[b[0]], label:x => famDot(x) + x, fill:famFill })}</div>
      <div class="panel"><h3>On hand by brand <small>· kg · spools</small></h3>${bars(agg(s => byId[s.fid].brand))}</div>
      <div class="panel"><h3>By location <small>· kg · spools</small></h3>${bars(agg(s => locName(s.loc) || 'No location set'))}</div>
      <div class="panel"><h3>By finish <small>· kg · spools</small></h3>${bars(agg(s => byId[s.fid].finish))}</div>
      <div class="panel"><h3>Running low <small>· ${low.length}</small></h3><div class="list">${low.length ? low.map(s => listItem(s, `<span class="badge ${lowLevel(s) === 2 ? 'crit' : 'warn'}">${s.rem} g</span>`)).join('') : '<span class="muted">Nothing is running low. Weigh opened spools to keep this accurate.</span>'}</div></div>
      ${ordered.length ? `<div class="panel"><h3>On order <small>· ${ordered.length}</small></h3><div class="list">${ordered.map(s => listItem(s, `<button class="btn small" data-arrived="${s.id}">Arrived</button>`)).join('')}</div></div>` : ''}
      <div class="panel"><h3>Recent activity</h3><div class="list">${recent.length ? recent.map(({ e, s }) => listItem(s, `<span class="muted" style="font-size:12px">${esc(evText(e))} · ${fmtDT(e.t)}</span>`)).join('') : '<span class="muted">Changes you make (status, weigh-ins, moves) show up here.</span>'}</div></div>
    </div>`;
}
function evText(e) {
  switch (e.type) {
    case 'created': return e.note || 'Added';
    case 'status': return `${ST[e.from]?.l || e.from} → ${ST[e.to]?.l || e.to}${e.note ? ' (' + e.note + ')' : ''}`;
    case 'move': return `Moved: ${e.from} → ${e.to}`;
    case 'weigh': return `Weighed: ${e.rem} g left${e.gross != null ? ` (scale ${e.gross} g)` : ''}`;
    case 'use': return `Used ${-e.delta} g${e.note ? ' (' + e.note + ')' : ''}, ${e.rem} g left`;
    case 'weight': return `Set remaining to ${e.rem} g`;
    default: return e.type;
  }
}

// ======================================================================
// Settings
// ======================================================================
function renderSettings(fil) {
  const brands = [...new Set(fil.map(f => f.brand))].sort((a, b) => a.localeCompare(b));
  const all = Object.values(state.spools);
  $('#view-settings').innerHTML = `<div class="setgrid">
    <div class="panel"><h3>Claude <small>· for adding filament from screenshots</small></h3>
      <p class="muted" style="margin:0 0 8px;font-size:13px"><b>📷 From screenshot</b> and <b>Find missing photos online</b> use the Anthropic API key from the app's Settings (the gear at the top right), billed to your Anthropic account: usually a few cents per screenshot.</p>
      <div class="setrow"><span class="grow">${hasKey ? '<b style="color:var(--petg)">✓ API key set</b>' : '<span class="muted">No API key set yet</span>'}</span>
        <button class="btn small" data-app-settings>Open Settings</button></div>
    </div>
    <div class="panel"><h3>Storage locations</h3>
      <p class="muted" style="margin:0 0 8px;font-size:13px">Tick <b>Printer</b> for toolheads or AMS slots. Moving a spool into one marks it <i>Loaded</i>.</p>
      ${state.locations.map(l => `<div class="setrow"><input type="text" class="grow" value="${esc(l.name)}" data-locname="${l.id}">
        <label class="muted" style="font-size:13px"><input type="checkbox" data-locprinter="${l.id}" ${l.printer ? 'checked' : ''}> Printer</label>
        <span class="muted" style="font-size:12px;min-width:56px;text-align:right">${all.filter(s => s.loc === l.id).length} spools</span>
        <button class="btn small danger" data-locdel="${l.id}" title="Remove location">✕</button></div>`).join('')}
      <div class="setrow"><input type="text" class="grow" id="newLoc" placeholder="New location, e.g. Shelf 2 / Bin C"><button class="btn small" data-locadd>Add</button></div>
    </div>
    <div class="panel"><h3>Empty spool weights (for weigh-ins)</h3>
      <p class="muted" style="margin:0 0 8px;font-size:13px">Put an empty spool from each brand on your scale and enter its weight. Then <b>Weigh</b> works out the filament left as scale reading − empty spool.</p>
      ${brands.map(b => `<div class="setrow"><span class="grow">${esc(b)}</span><input type="number" min="0" style="width:90px" value="${esc(state.settings.empty[b] ?? '')}" data-emptyw="${esc(b)}" placeholder="g"> g</div>`).join('')}
      <div class="setrow"><span class="grow">Reusable spool (for refills)</span><input type="number" min="0" style="width:90px" value="${esc(state.settings.reusable)}" data-reusable placeholder="g"> g</div>
    </div>
    <div class="panel"><h3>Alerts &amp; display</h3>
      <div class="setrow"><span class="grow">Low-stock warning at (opened spools)</span><input type="number" min="0" step="10" style="width:90px" value="${state.settings.low}" data-lowth> g</div>
      <div class="setrow"><span class="grow">Theme</span><select class="sel" data-theme-sel>${['auto','light','dark'].map(t => `<option ${t === state.settings.theme ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="setrow"><span class="grow">Label format</span><select class="sel" data-label-sel>
        <option value="sheet" ${state.settings.label === 'sheet' ? 'selected' : ''}>Avery 5160 sheet (1 × 2⅝ in, 30/page)</option>
        <option value="roll" ${state.settings.label === 'roll' ? 'selected' : ''}>Label printer (2¼ × 1¼ in)</option></select></div>
    </div>
    <div class="panel"><h3>Backup &amp; data</h3>
      <p class="muted" style="margin:0 0 8px;font-size:13px">Everything is saved by the app on this computer, with a copy kept each day for two weeks (<a href="#" data-open-backups>open that folder</a>). Download a backup to move your filament to another computer.</p>
      <div class="actions" style="margin-top:0">
        <button class="btn" data-backup>Download backup</button>
        <button class="btn" data-restore>Restore backup…</button>
        <button class="btn" data-export-csv>Export spools CSV</button>
        <button class="btn" data-labels-all>Print labels for all in-stock spools</button>
      </div>
      <div class="actions"><button class="btn danger" data-resetall>${ORDERS.length ? 'Reset everything to the imported order data' : 'Erase everything and start over'}</button></div>
    </div>
  </div>`;
}

// ======================================================================
// Filament detail modal (with per-spool rows)
// ======================================================================
let openFid = null, openPanel = null; // openPanel: {sid, kind:'weigh'|'use'|'hist'}
function openDetail(fid) {
  openFid = fid; openPanel = null;
  const f = allFilaments().find(x => x.id === fid); if (!f) return;
  const fx = f.fx, typ = TYPICAL[f.type] || {}, sp = f.spec;
  const deg = v => v && /\d$/.test(v) ? v + ' °C' : v;
  const mfr = sp ? `<div class="mfr"><strong>Manufacturer settings</strong>
      <div class="row"><span>Nozzle</span><span>${esc(deg(sp.n))}</span></div>
      <div class="row"><span>Bed</span><span>${esc(deg(sp.b))}</span></div>
      ${sp.d ? `<div class="row"><span>Drying</span><span>${esc(sp.d)}</span></div>` : ''}
      ${sp.spd ? `<div class="row"><span>Speed</span><span>${esc(sp.spd)}</span></div>` : ''}
      <div class="row"><span>Source</span><span>${esc(sp.src)}</span></div>
      ${sp.note ? `<div class="muted" style="margin-top:4px">${esc(sp.note)}</div>` : ''}
      <div class="preset"><span>Snapmaker Orca preset:</span><code>${esc(sp.preset)}</code>
        ${sp.system ? `<span class="muted">(built into Snapmaker Orca)</span>` : sp.existing ? `<span class="muted">(your own preset)</span>` : `<a class="btn small" href="profiles/${encodeURIComponent(sp.preset)}.json" download>Download .json</a>`}
        <span class="muted">${sp.system ? '' : `Prints at ${sp.nz} °C nozzle · ${sp.bd} °C bed`}</span></div>
    </div>` : '';
  const photo = f.img ? `<img src="${esc(f.img)}" alt="">` : itemSwatch(f, 'big-swatch');
  const src0 = f.sources?.[0];
  $('#modal').innerHTML = `<button class="x" data-close>×</button>
  <div class="detail">
    <div class="photo">${photo}</div>
    <div class="info">
      <h2>${esc(f.color)}</h2>
      <div class="sub">${esc(f.brand)} ${esc(f.line)}${f.line.includes(f.type) ? '' : ' ' + esc(f.type)} · ${esc(f.finish)} · ${fmtKg(f.grams)} spools</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div class="swrow">${itemSwatch(f, '')}<span>Approximate color.<br>The photo is the better reference.</span></div>
        <div class="stars" data-stars title="Your rating">${[1,2,3,4,5].map(n => `<button data-rate="${n}" class="${(fx.rating || 0) >= n ? 'on' : ''}">★</button>`).join('')}</div>
      </div>
      <div class="psets">
        <label>Nozzle °C<input data-fx="nozzle" value="${esc(fx.nozzle || (sp && sp.n) || '')}" placeholder="${typ.nozzle ? 'typ. ' + typ.nozzle : ''}"></label>
        <label>Bed °C<input data-fx="bed" value="${esc(fx.bed || (sp && sp.b) || '')}" placeholder="${typ.bed ? 'typ. ' + typ.bed : ''}"></label>
        <label>Drying<input data-fx="dry" value="${esc(fx.dry || (sp && sp.d) || '')}" placeholder="${typ.dry ? 'typ. ' + typ.dry : ''}"></label>
      </div>
      <textarea data-fx="notes" placeholder="Notes: print settings that worked, what it looks like printed, slicer profile…">${esc(fx.notes || '')}</textarea>
      ${f.note ? `<div class="muted" style="font-size:13px;margin-top:6px">${esc(f.note)}</div>` : ''}
      ${mfr}
      ${f.sources?.length ? `<div class="orders"><strong>Orders</strong>${f.sources.map(s => `<div><span>${fmtDate(s.date)} · ${s.n} spool${s.n > 1 ? 's' : ''}${s.bundle ? ' (bundle)' : ''}${s.price != null ? ' · ' + fmt$(s.price) + ' each' : ''}</span><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.store)} ↗</a></div>`).join('')}</div>` : ''}
      <div class="actions">
        ${src0 ? `<a class="btn small" href="${esc(src0.url)}" target="_blank" rel="noopener">Reorder on ${esc(src0.store)} ↗</a>` : ''}
        ${f.custom ? `<button class="btn small" data-edit>Edit filament</button><button class="btn small danger" data-delfil>Delete filament</button>` : ''}
      </div>
    </div>
  </div>
  <div class="spoolbox" id="spoolbox"></div>`;
  renderSpoolBox();
  $('#overlay').classList.add('open');
}
function renderSpoolBox() {
  const f = allFilaments().find(x => x.id === openFid); if (!f) return;
  const box = $('#spoolbox'); if (!box) return;
  const locOpts = sel => `<option value="">— no location —</option>` + state.locations.map(l => `<option value="${l.id}" ${l.id === sel ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  const visible = f.spools.filter(s => s.status !== 'archived' || openPanel?.showArchived);
  box.innerHTML = `<h3>Spools <span class="muted" style="font-weight:500;font-size:14px">${f.qty} in stock${f.ordered ? ` · ${f.ordered} on order` : ''} · ${fmtKg(f.remG)} left</span>
      <span class="spacer"></span><button class="btn small" data-addspool>+ Add spool</button>
      ${f.stock.length ? `<button class="btn small" data-labels-fil>Print labels</button>` : ''}</h3>
    ${visible.map(s => {
      const lvl = lowLevel(s);
      const panel = openPanel?.sid === s.id ? subPanel(s, f) : '';
      return `<div class="srow" data-sid="${s.id}">
        <span class="sid">#${s.id}</span>
        <select data-sstatus>${STATUSES.map(x => `<option value="${x.k}" ${x.k === s.status ? 'selected' : ''}>${x.l}</option>`).join('')}</select>
        <select data-sloc>${locOpts(s.loc)}</select>
        <div class="remcell"><input type="number" min="0" step="1" value="${s.rem}" data-srem title="Grams of filament left"><span class="muted">g</span>
          <div class="meter"><i class="${['','low','crit'][lvl]}" style="width:${Math.min(100, 100 * s.rem / f.grams)}%"></i></div></div>
        <div class="acts">
          <button class="btn small" data-panel="weigh" title="Weigh on a scale">⚖ Weigh</button>
          <button class="btn small" data-panel="use" title="Log filament used by a print">Use</button>
          <button class="btn small" data-panel="hist" title="History">⋯</button>
        </div>
        ${panel}
      </div>`;
    }).join('') || '<p class="muted">No spools. Use “+ Add spool” to add one.</p>'}
    ${f.spools.some(s => s.status === 'archived') ? `<p><button class="btn small" data-toggle-arch>${openPanel?.showArchived ? 'Hide' : 'Show'} archived spools</button></p>` : ''}`;
}
function subPanel(s, f) {
  if (openPanel.kind === 'weigh') {
    const ew = emptyWeightFor(s);
    const refill = /refill/i.test(f.note || '');
    return `<div class="sub-panel">
      <label>Scale reading (g)<input type="number" min="0" data-gross autofocus></label>
      <label>Empty spool (g)<input type="number" min="0" data-emptyg value="${ew ?? ''}" placeholder="${refill ? 'reusable spool' : 'weigh one empty'}"></label>
      <label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" data-remember ${ew == null ? 'checked' : ''} style="width:auto"> Save as default for ${refill ? 'refills' : esc(f.brand)}</label>
      <button class="btn small primary" data-doweigh>Save weight</button>
      <span class="muted" data-weighout></span></div>`;
  }
  if (openPanel.kind === 'use') return `<div class="sub-panel">
      <label>Grams used<input type="number" min="0" data-used autofocus placeholder="from slicer"></label>
      <label>What did you print? (optional)<input type="text" data-usenote style="width:220px"></label>
      <button class="btn small primary" data-douse>Subtract</button>
      <button class="btn small danger" data-delspool style="margin-left:auto">Delete this spool</button></div>`;
  return `<div class="sub-panel"><div class="hist">
      <div><span><b>Bought</b></span><span>${fmtDate(s.bought)}${s.price != null ? ' · ' + fmt$(s.price) : ''}${s.opened ? ` · opened ${fmtDate(s.opened)}` : ''}${s.used ? ` · last used ${fmtDate(s.used)}` : ''}</span></div>
      ${[...s.log].reverse().map(e => `<div><span>${fmtDT(e.t)}</span><span>${esc(evText(e))}</span></div>`).join('')}
    </div></div>`;
}
function closeModal() {
  $('#overlay').classList.remove('open'); openFid = null; openPanel = null;
  if (shot) { shot.urls.forEach(u => URL.revokeObjectURL(u)); shot = null; }
  render();
}

// ======================================================================
// Add / edit custom filament
// ======================================================================
function openForm(existing) {
  const fil = allFilaments();
  const brands = [...new Set(fil.map(f => f.brand))].sort();
  const lines = [...new Set(fil.map(f => f.line))].sort();
  const e = existing || { brand:'', type:'PLA', line:'', finish:'Standard', color:'', fams:[], hex:'#888888', grams:1000, img:'' };
  const hex1 = Array.isArray(e.hex) ? e.hex[0] : e.hex;
  openFid = null;
  $('#modal').innerHTML = `<button class="x" data-close>×</button>
  <form class="add" id="addForm">
    <h2>${existing ? 'Edit filament' : 'Add filament'}</h2>
    <label>Color name<input name="color" required value="${esc(e.color)}" placeholder="e.g. Galaxy Purple"></label>
    <label>Brand<input name="brand" required list="brandList" value="${esc(e.brand)}" placeholder="e.g. Bambu Lab"></label>
    <datalist id="brandList">${brands.map(b => `<option value="${esc(b)}">`).join('')}</datalist>
    <label>Type<select name="type">${FIL_TYPES.map(t => `<option ${t === e.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label>Product line (optional)<input name="line" list="lineList" value="${esc(e.line)}" placeholder="e.g. Basic, Matte, Silk+"></label>
    <datalist id="lineList">${lines.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
    <label>Finish<select name="finish">${FINISHES.map(x => `<option ${x === e.finish ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label>Swatch color (approx.)<input type="color" name="hex" value="${esc(hex1)}"></label>
    <label>Spool size (g)<input type="number" name="grams" min="1" step="1" value="${e.grams}"></label>
    ${existing ? '' : `<label>How many spools<input type="number" name="qty" min="0" step="1" value="1"></label>
    <label>Price per spool (optional)<input type="number" name="price" min="0" step="0.01" placeholder="$"></label>
    <label>Location<select name="loc"><option value="">— none —</option>${state.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>`}
    <div class="full"><div style="font-size:13px;color:var(--muted);margin-bottom:6px">Color group (pick one or more)</div>
      <div class="famPick">${FAMS.filter(([x]) => x !== 'Multicolor').map(([x]) => `<label class="chip ${e.fams.includes(x) ? 'on' : ''}"><input type="checkbox" name="fam" value="${x}" ${e.fams.includes(x) ? 'checked' : ''} hidden>${famDot(x)}${x}</label>`).join('')}</div></div>
    <label class="full">Photo: choose an image file, or paste an image URL
      <span style="display:flex;gap:8px"><input type="file" name="imgFile" accept="image/*" style="flex:1"><input name="imgUrl" placeholder="https://…" style="flex:1" value="${esc(e.img && !e.img.startsWith('data:') ? e.img : '')}"></span>
      ${e.img ? `<span>Current photo is kept unless you choose a new one.</span>` : ''}</label>
    <div class="actions full"><button class="btn primary" type="submit">${existing ? 'Save' : 'Add filament'}</button><button class="btn" type="button" data-close>Cancel</button></div>
  </form>`;
  $('#overlay').classList.add('open');
  const form = $('#addForm');
  form.querySelectorAll('.famPick input').forEach(cb => cb.addEventListener('change', () => cb.parentElement.classList.toggle('on', cb.checked)));
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const fd = new FormData(form);
    let fams = fd.getAll('fam'); if (!fams.length) fams = ['Multicolor'];
    let img = e.img || '';
    const file = fd.get('imgFile');
    if (file && file.size) img = await shrinkImage(file);
    else if (fd.get('imgUrl').trim()) img = fd.get('imgUrl').trim();
    const rec = { id: existing?.id || 'c-' + Date.now().toString(36), brand:fd.get('brand').trim(), type:fd.get('type'), line:fd.get('line').trim() || fd.get('type'),
      finish:fd.get('finish'), color:fd.get('color').trim(), fams, hex:fd.get('hex'), grams:+fd.get('grams') || 1000, img, note:existing?.note || '',
      added: existing?.added || today() };
    if (existing) state.custom[state.custom.findIndex(c => c.id === existing.id)] = rec;
    else {
      state.custom.push(rec);
      const price = fd.get('price') ? +fd.get('price') : null;
      for (let i = 0; i < (+fd.get('qty') || 0); i++) { const s = newSpool(rec.id, { price }); if (fd.get('loc')) setLoc(s, fd.get('loc')); }
    }
    persist(); toast(existing ? 'Saved' : 'Filament added');
    existing ? openDetail(rec.id) : closeModal();
  });
}
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const max = 600, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.82)); URL.revokeObjectURL(img.src);
    };
    img.onerror = reject; img.src = URL.createObjectURL(file);
  });
}

// ======================================================================
// Labels
// ======================================================================
function printLabels(ids) {
  if (!ids.length) return toast('No spools to label');
  const fil = Object.fromEntries(allFilaments().map(f => [f.id, f]));
  const mode = state.settings.label;
  const labels = ids.map(id => state.spools[id]).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id)).map(s => {
    const f = fil[s.fid], typ = TYPICAL[f.type] || {};
    const noz = f.fx.nozzle || f.spec?.n || typ.nozzle, bed = f.fx.bed || f.spec?.b || typ.bed;
    return `<div class="lbl"><span class="sw" style="${swatchStyle(f)}"></span><div class="t">
      <b>${esc(f.color)}</b><span>${esc(f.brand)} ${esc(f.line)}</span>
      <span>${esc(f.type)}${f.finish !== 'Standard' ? ' · ' + esc(f.finish) : ''} · ${fmtKg(f.grams)}</span>
      <span>${noz ? '🌡 ' + esc(noz) + '°' : ''}${bed ? ' · bed ' + esc(bed) + '°' : ''}</span>
      <span class="id">#${s.id}</span></div></div>`;
  }).join('');
  const area = $('#printArea');
  area.innerHTML = `<style>@page{${mode === 'roll' ? 'size:2.25in 1.25in;margin:0' : 'size:letter;margin:.5in .19in 0'}}</style><div class="${mode}">${labels}</div>`;
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 50);
}

// ======================================================================
// Events
// ======================================================================
function clearFilters() { Object.assign(ui, { q:'', type:'All', brand:'', finish:'', fams:[], status:'stock', loc:'' }); persistUI(); render(); }
function go(view) { ui.view = view; history.replaceState(null, "", "#" + view); persistUI(); render(); window.scrollTo(0, 0); }
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (['inventory','spools','dashboard','settings'].includes(v)) go(v); });
if (['inventory','spools','dashboard','settings'].includes(location.hash.slice(1))) ui.view = location.hash.slice(1);

$('#q').addEventListener('input', e => { ui.q = e.target.value; persistUI(); render(); });
$('#typeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; ui.type = b.dataset.type; persistUI(); render(); });
for (const [sel, key] of [['#brandSel','brand'],['#finishSel','finish'],['#groupSel','group'],['#sortSel','sort'],['#statusSel','status'],['#locSel','loc']])
  $(sel).addEventListener('change', e => { ui[key] = e.target.value; persistUI(); render(); });
$('#famChips').addEventListener('click', e => {
  const b = e.target.closest('[data-fam]'); if (!b) return;
  const x = b.dataset.fam; ui.fams = ui.fams.includes(x) ? ui.fams.filter(y => y !== x) : [...ui.fams, x]; persistUI(); render();
});
document.addEventListener('click', e => { if (e.target.closest('[data-clear]')) clearFilters(); });

$('#view-inventory').addEventListener('click', e => {
  const c = e.target.closest('.card'); if (!c) return;
  const dq = e.target.closest('[data-dq]');
  if (dq) return quickStep(c.dataset.fid, +dq.dataset.dq);
  if (e.target.closest('[data-stop]')) return;
  openDetail(c.dataset.fid);
});

$('#view-spools').addEventListener('click', e => {
  const t = e.target;
  if (t.matches('[data-sel]')) { t.checked ? selected.add(t.dataset.sel) : selected.delete(t.dataset.sel); return render(); }
  if (t.matches('[data-selall]')) { document.querySelectorAll('[data-sel]').forEach(cb => t.checked ? selected.add(cb.dataset.sel) : selected.delete(cb.dataset.sel)); return render(); }
  const th = t.closest('[data-tsort]');
  if (th) { if (ui.tsort === th.dataset.tsort) ui.tasc = !ui.tasc; else { ui.tsort = th.dataset.tsort; ui.tasc = true; } persistUI(); return render(); }
  if (t.closest('[data-export-csv]')) return exportCSV();
  if (t.closest('[data-bulk-labels]')) return printLabels([...selected]);
  if (t.closest('[data-bulk-clear]')) { selected.clear(); return render(); }
  const tr = t.closest('tr[data-fid]');
  if (tr) openDetail(tr.dataset.fid);
});
$('#view-spools').addEventListener('change', e => {
  const t = e.target;
  if (t.matches('[data-bulk-status]') && t.value) { selected.forEach(id => setStatus(state.spools[id], t.value, 'Bulk change')); persist(); toast(`Updated ${selected.size} spools`); render(); }
  if (t.matches('[data-bulk-loc]') && t.value) { selected.forEach(id => setLoc(state.spools[id], t.value === '-' ? '' : t.value)); persist(); toast(`Moved ${selected.size} spools`); render(); }
});

$('#view-dashboard').addEventListener('click', e => {
  const a = e.target.closest('[data-arrived]');
  if (a) { const s = state.spools[a.dataset.arrived]; setStatus(s, "new", "Delivered"); persist(); toast(`#${s.id} marked arrived`); return render(); }
  const o = e.target.closest('[data-open-fid]'); if (o) openDetail(o.dataset.openFid);
});
// tooltip for dashboard bars
document.addEventListener('mousemove', e => {
  const t = e.target.closest?.('[data-tip]'), tip = $('#tip');
  if (!t) { tip.style.display = 'none'; return; }
  tip.textContent = t.dataset.tip; tip.style.display = 'block';
  tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = (e.clientY + 14) + 'px';
});

$('#view-settings').addEventListener('change', e => {
  const t = e.target, d = t.dataset;
  if (d.locname) { const l = state.locations.find(x => x.id === d.locname); l.name = t.value.trim() || l.name; }
  else if (d.locprinter) state.locations.find(x => x.id === d.locprinter).printer = t.checked;
  else if (d.emptyw !== undefined) { if (t.value === '') delete state.settings.empty[d.emptyw]; else state.settings.empty[d.emptyw] = +t.value; }
  else if (d.reusable !== undefined) state.settings.reusable = t.value === '' ? '' : +t.value;
  else if (d.lowth !== undefined) state.settings.low = Math.max(0, +t.value || 0);
  else if (t.matches('[data-theme-sel]')) state.settings.theme = t.value;
  else if (t.matches('[data-label-sel]')) state.settings.label = t.value;
  else return;
  persist(); render(); toast('Saved');
});
$('#view-settings').addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  const d = t.dataset;
  if (d.locadd !== undefined) {
    const name = $('#newLoc').value.trim(); if (!name) return;
    const n = Math.max(0, ...state.locations.map(l => +l.id.slice(1))) + 1;
    state.locations.push({ id:'L' + n, name, printer:false }); persist(); render();
  } else if (d.locdel) {
    if (!d.armed) { t.dataset.armed = 1; t.textContent = 'Sure?'; return; }
    Object.values(state.spools).forEach(s => { if (s.loc === d.locdel) setLoc(s, ''); });
    state.locations = state.locations.filter(l => l.id !== d.locdel); persist(); render();
  } else if (d.backup !== undefined) backup();
  else if (d.restore !== undefined) $('#importFile').click();
  else if (d.exportCsv !== undefined) exportCSV();
  else if (d.labelsAll !== undefined) printLabels(Object.values(state.spools).filter(s => IN_STOCK.has(s.status)).map(s => s.id));
  else if (d.resetall !== undefined) {
    if (!d.armed) { t.dataset.armed = 1; t.textContent = 'This erases your changes. Click again to reset'; return; }
    backup(); state = blankState(); syncSources(); persist(); toast('Reset. A backup of the old data was downloaded'); render();
  }
});
// ---------- What's on hand, for the rest of the app (Color remix, the shopping check) ----------
// Saved with every change as filament\stock.json. total = all spools ever tracked, so the app can tell an
// inventory that's in use but has nothing on hand from one that was never set up.
function advisorStock() {
  const out = [];
  for (const f of [...BASE, ...state.custom]) {
    const sp = spoolsOf(f.id).filter(s => IN_STOCK.has(s.status));
    if (!sp.length) continue;
    const spec = f.spec || {};
    out.push({ id: f.id, brand: f.brand, type: f.type, line: f.line, finish: f.finish, color: f.color, fams: f.fams, hex: f.hex,
      grams: f.grams, spools: sp.length, remainingG: Math.round(sp.reduce((t, s) => t + (+s.rem || 0), 0)),
      loaded: [...new Set(sp.filter(s => s.status === 'active' || isPrinterLoc(s.loc)).map(s => locName(s.loc)).filter(Boolean))],
      preset: spec.preset || null, nozzle: spec.nz || null, bed: spec.bd || null });
  }
  return { app: 'filament-inventory', kind: 'print-advisor-stock', version: 1, updated: nowISO(), total: Object.keys(state.spools).length, filaments: out };
}

// ---------- Links from this screen into the app ----------
document.addEventListener('click', e => {
  if (e.target.closest('[data-app-settings]')) { e.preventDefault(); return window.parent.document.getElementById('settingsBtn')?.click(); }
  if (e.target.closest('[data-open-backups]')) { e.preventDefault(); return api.filamentOpenFolder().catch(err => toast(ipcMessage(err))); }
  const start = e.target.closest('[data-start]');
  if (start) return start.dataset.start === 'shot' ? openShot() : openForm();
});

function backup() {
  download(`filament-backup-${today()}.json`, JSON.stringify({ app:'filament-inventory', version:2, exported:nowISO(), state }, null, 2), 'application/json');
  toast('Backup downloaded');
}
$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const s = data.state || data;
    if (s && s.v === 2 && s.spools) state = s;
    else if (s && 'qty' in s) state = migrateV1(s);
    else throw new Error('not a filament backup');
    syncSources(); persist(); render(); toast('Backup restored');
  } catch (err) { toast('Could not restore: ' + err.message); }
  e.target.value = '';
});

// modal interactions
$('#overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget || e.target.closest('[data-close]')) return closeModal();
  const t = e.target, row = t.closest('.srow'), s = row && state.spools[row.dataset.sid];
  const rate = t.closest('[data-rate]');
  if (rate && openFid) {
    const fx = (state.fil[openFid] ||= {}); const n = +rate.dataset.rate; fx.rating = fx.rating === n ? 0 : n; persist();
    document.querySelectorAll('[data-rate]').forEach(b => b.classList.toggle('on', fx.rating >= +b.dataset.rate)); return;
  }
  if (t.closest('[data-edit]')) return openForm(state.custom.find(c => c.id === openFid));
  if (t.closest('[data-delfil]')) {
    const b = t.closest('[data-delfil]');
    if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Deletes it and all its spools. Click again'; return; }
    spoolsOf(openFid).forEach(x => delete state.spools[x.id]); state.custom = state.custom.filter(c => c.id !== openFid); delete state.fil[openFid];
    persist(); toast('Deleted'); return closeModal();
  }
  if (t.closest('[data-addspool]')) { newSpool(openFid); persist(); renderSpoolBox(); return toast('Spool added'); }
  if (t.closest('[data-labels-fil]')) return printLabels(spoolsOf(openFid).filter(x => IN_STOCK.has(x.status)).map(x => x.id));
  if (t.closest('[data-toggle-arch]')) { openPanel = { ...(openPanel || {}), showArchived: !openPanel?.showArchived }; return renderSpoolBox(); }
  const p = t.closest('[data-panel]');
  if (p && s) { openPanel = openPanel?.sid === s.id && openPanel.kind === p.dataset.panel ? null : { sid:s.id, kind:p.dataset.panel }; renderSpoolBox(); $("#spoolbox").querySelector(`[data-sid="${s.id}"] [autofocus]`)?.focus(); return; }
  if (t.closest('[data-doweigh]') && s) {
    const gross = +row.querySelector('[data-gross]').value, ew = row.querySelector('[data-emptyg]').value;
    if (!gross) return toast('Enter the scale reading');
    if (ew === '') return toast('Enter the empty spool weight');
    if (row.querySelector('[data-remember]').checked) {
      const f = filDef(s.fid);
      if (/refill/i.test(f.note || '')) state.settings.reusable = +ew; else state.settings.empty[f.brand] = +ew;
    }
    setRem(s, gross - +ew, 'weigh', { gross, empty:+ew }); openPanel = null; persist(); renderSpoolBox(); return toast(`#${s.id}: ${s.rem} g left`);
  }
  if (t.closest('[data-douse]') && s) {
    const used = +row.querySelector('[data-used]').value; if (!used) return toast('Enter grams used');
    if (s.status === 'new' || s.status === 'ordered') setStatus(s, 'opened');
    setRem(s, s.rem - used, 'use', { note: row.querySelector('[data-usenote]').value.trim() }); openPanel = null; persist(); renderSpoolBox(); return toast(`#${s.id}: ${s.rem} g left`);
  }
  if (t.closest('[data-delspool]') && s) {
    const b = t.closest('[data-delspool]');
    if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Click again to delete (use Empty/Archived to keep history)'; return; }
    if (s.src) state.deletedSrc.push(s.src);
    delete state.spools[s.id]; openPanel = null; persist(); renderSpoolBox(); return toast('Spool deleted');
  }
});
$('#overlay').addEventListener('change', e => {
  const t = e.target, row = t.closest('.srow'), s = row && state.spools[row.dataset.sid];
  if (t.matches('[data-sstatus]') && s) { setStatus(s, t.value); if (t.value !== 'empty' && s.rem === 0) s.rem = filDef(s.fid).grams; }
  else if (t.matches('[data-sloc]') && s) setLoc(s, t.value);
  else if (t.matches('[data-srem]') && s) setRem(s, +t.value || 0);
  else return;
  persist(); renderSpoolBox();
});
$('#overlay').addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.fx && openFid) { const fx = (state.fil[openFid] ||= {}); fx[t.dataset.fx] = t.value; persist(); }
  if ((t.matches('[data-gross]') || t.matches('[data-emptyg]'))) {
    const row = t.closest('.srow'), g = +row.querySelector('[data-gross]').value, ew = row.querySelector('[data-emptyg]').value;
    row.querySelector('[data-weighout]').textContent = g && ew !== '' ? `= ${Math.max(0, g - +ew)} g of filament` : '';
  }
});
$('#overlay').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.matches('[data-gross],[data-emptyg]')) e.target.closest('.srow').querySelector('[data-doweigh]').click();
  if (e.target.matches('[data-used],[data-usenote]')) e.target.closest('.srow').querySelector('[data-douse]').click();
});

// ======================================================================
// Claude: "add filament from a screenshot" and "find missing photos online"
// The requests go through the app, which adds the API key from its Settings. The key never reaches this page.
// ======================================================================
const CLAUDE_MODEL = 'claude-opus-5-5';
const CLAUDE_PRICE = { in: 4, out: 20 };   // $ per million tokens for CLAUDE_MODEL, only for the cost shown after a read
let hasKey = !!BOOT.hasKey;
// the key can be added or removed in Settings while this screen is open
async function refreshKey() { try { hasKey = await api.filamentHasKey(); } catch {} return hasKey; }
async function callClaude(body) {
  try { return await api.filamentClaude(body); }
  catch (e) { throw new Error(ipcMessage(e)); }
}

// Screenshots are cut into pieces Claude reads at full detail: at most 1568 px wide, tall pages split into
// overlapping 1568 px slices (a long order-history page stays readable instead of being shrunk to a blur).
const TILE = 1568, OVERLAP = 120, MAX_TILES = 10;
// Product photos are kept with the filament (about 30-50 KB each at this size).
const PHOTO_PX = 480;
async function imageTiles(file) {
  const bmp = await createImageBitmap(file);
  const n = k => Math.max(1, Math.ceil((bmp.height * k - OVERLAP) / (TILE - OVERLAP)));
  let k = Math.min(1, TILE / bmp.width);
  while (n(k) > MAX_TILES) k *= 0.9;
  const W = Math.round(bmp.width * k), H = Math.round(bmp.height * k), count = n(k), tiles = [];
  for (let i = 0; i < count; i++) {
    const y = Math.min(i * (TILE - OVERLAP), Math.max(0, H - TILE)), h = Math.min(TILE, H);
    const c = document.createElement('canvas'); c.width = W; c.height = h;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, h); ctx.drawImage(bmp, 0, -y, W, H);
    tiles.push({ data: c.toDataURL('image/jpeg', 0.9).split(',')[1], y, h });
  }
  bmp.close?.();
  return { k, W, tiles };
}
// Cut a product picture out of the ORIGINAL screenshot (sharper than the slice Claude saw).
// box = edges as fractions of the slice Claude saw; src = { file, k, W, y, h } for that slice.
async function cropPhoto(src, box, bitmaps) {
  const { left, top, right, bottom } = box;
  if (![left, top, right, bottom].every(v => Number.isFinite(v) && v >= -0.01 && v <= 1.01) || right <= left || bottom <= top) return null;
  let bmp = bitmaps.get(src.file);
  if (!bmp) { bmp = await createImageBitmap(src.file); bitmaps.set(src.file, bmp); }
  let x0 = left * src.W / src.k, x1 = right * src.W / src.k, y0 = (src.y + top * src.h) / src.k, y1 = (src.y + bottom * src.h) / src.k;
  const pad = 0.03 * Math.max(x1 - x0, y1 - y0);   // a little margin so a slightly-off box doesn't clip the spool
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(bmp.width, x1 + pad); y1 = Math.min(bmp.height, y1 + pad);
  if (x1 - x0 < 16 || y1 - y0 < 16) return null;
  const s = Math.min(1, PHOTO_PX / Math.max(x1 - x0, y1 - y0));
  const c = document.createElement('canvas'); c.width = Math.round((x1 - x0) * s); c.height = Math.round((y1 - y0) * s);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

const nullable = t => ({ anyOf:[{ type:t }, { type:'null' }] });
const SHOT_SCHEMA = { type:'object', additionalProperties:false, required:['items', 'notes'], properties:{
  items:{ type:'array', items:{ type:'object', additionalProperties:false,
    required:['brand', 'type', 'line', 'finish', 'color', 'families', 'hex', 'grams', 'spools', 'price_each', 'store', 'order_date', 'on_order', 'photo', 'note'],
    properties:{
      photo:{ anyOf:[{ type:'object', additionalProperties:false, required:['image', 'left', 'top', 'right', 'bottom'],
        properties:{ image:{ type:'integer' }, left:{ type:'number' }, top:{ type:'number' }, right:{ type:'number' }, bottom:{ type:'number' } } }, { type:'null' }] },
      brand:{ type:'string' }, type:{ type:'string', enum:FIL_TYPES }, line:{ type:'string' },
      finish:{ type:'string', enum:FINISHES }, color:{ type:'string' },
      families:{ type:'array', items:{ type:'string', enum:FAMS.map(f => f[0]) } },
      hex:{ type:'array', items:{ type:'string' } },
      grams:{ type:'integer' }, spools:{ type:'integer' }, price_each:nullable('number'),
      store:{ type:'string' }, order_date:nullable('string'), on_order:{ type:'boolean' }, note:{ type:'string' } } } },
  notes:{ type:'string' } } };
const SHOT_SYSTEM = `You read screenshots of 3D-printer filament purchases (order history pages, receipts, order confirmation emails, shopping carts, product pages, or photos of spool labels) and list the filament in them, so it can be added to a home filament inventory.

Return one item per distinct filament color:
- spools: the total number of spools of that color. Multiply pack sizes by the quantity ordered (2 × a 4-pack = 8). For a bundle of several colors, make one item per color with its own spool count.
- grams: filament per spool (1 kg = 1000). Use 1000 when the size isn't shown.
- price_each: the price per spool, after splitting pack or bundle prices across their spools. null when no price is visible.
- brand is the manufacturer (for example "Polymaker", not the store). line is the product line without the brand, type or color (for example "Panchroma Matte", "PLA+ HS", "Rapid PETG"); use the type itself when there is no line name. finish is the closest allowed value ("Standard" when nothing special is stated).
- color: the color name as the seller writes it.
- families: one or more color groups that describe it. "Clear" for transparent, "Multicolor" for gradient, dual- or tri-color filament.
- hex: your best estimate of the color as "#rrggbb", from the product photo or the color name. Two or three values for gradient or multi-color filament, otherwise one.
- store: the shop (for example "Amazon"). order_date: the order date as YYYY-MM-DD when shown, otherwise null.
- on_order: true when the screenshot shows it hasn't been delivered yet (ordered, shipped, arriving), otherwise false.
- photo: where this product's own picture is, so it can be cut out and kept as the product photo. image is the number from the "Image N" label before that image. left, top, right and bottom are the edges of the picture as fractions of that image's width and height (0 = left or top edge, 1 = right or bottom edge). Box the product picture only, not the text next to it. When several colors share one picture (a bundle), give each of them that same box. null when there is no picture of it.
- note: anything the person should double-check, such as an unreadable quantity or a guessed spool size; otherwise "".

Skip everything that isn't filament (printers, nozzles, dryers, tools). When the same filament shows up in overlapping parts of one screenshot or in several screenshots of the same order, list it once. When there is no filament, return no items and say why in notes. notes: one short sentence about anything you skipped or weren't sure of, otherwise "".

When a brand and product line match one in the known list in the message, use exactly that spelling.`;

async function readScreenshots(files) {
  if (!await refreshKey()) throw new Error('Add your Anthropic API key in Settings first (the gear at the top right).');
  const content = [], sent = [];   // sent[n - 1] = where "Image n" came from, for cutting out product photos
  for (const [i, f] of files.entries()) {
    const { k, W, tiles } = await imageTiles(f);
    tiles.forEach((t, j) => {
      sent.push({ file: f, k, W, y: t.y, h: t.h });
      content.push({ type:'text', text: `Image ${sent.length}: screenshot ${i + 1}` + (tiles.length > 1 ? `, part ${j + 1} of ${tiles.length} (the parts overlap a little)` : '') });
      content.push({ type:'image', source:{ type:'base64', media_type:'image/jpeg', data: t.data } });
    });
  }
  const known = [...new Set([...Object.keys(typeof SPECS !== 'undefined' ? SPECS : {}).map(k => k.split('|').slice(0, 2).join(' | ')),
    ...allFilaments().map(f => `${f.brand} | ${f.line}`)])].sort();
  content.push({ type:'text', text: 'List the filament in these screenshots.' + (known.length ? '\n\nKnown brand | product line names:\n' + known.join('\n') : '') });
  const t0 = performance.now();
  const resp = await callClaude({
    model: CLAUDE_MODEL, max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',   // if a safety check declines, another model retries
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SHOT_SCHEMA } },
    system: SHOT_SYSTEM, messages: [{ role:'user', content }],
  });
  if (resp.stop_reason === 'refusal') throw new Error('Claude declined to read these screenshots.');
  if (resp.stop_reason === 'max_tokens') throw new Error('Too much to read in one go. Try fewer screenshots at a time.');
  let out;
  try { out = JSON.parse(resp.content.filter(b => b.type === 'text').map(b => b.text).join('')); }
  catch { throw new Error('Claude’s answer couldn’t be read. Try again.'); }
  const u = resp.usage || {};
  const cost = ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) * 0.1) * CLAUDE_PRICE.in / 1e6
             + (u.output_tokens || 0) * CLAUDE_PRICE.out / 1e6;
  const isHex = h => /^#[0-9a-f]{6}$/i.test(h);
  const items = (out.items || []).map(it => ({
    ...it, on: true, hex: (it.hex || []).filter(isHex).length ? it.hex.filter(isHex).slice(0, 3) : ['#888888'],
    families: (it.families || []).filter(f => f in FAM_INDEX), grams: it.grams > 0 ? it.grams : 1000,
    spools: Math.max(0, it.spools | 0), price: it.price_each ?? '', status: it.on_order ? 'ordered' : 'new' }));
  const bitmaps = new Map();
  for (const it of items) {
    const src = it.photo && sent[it.photo.image - 1];
    it.photo = src ? await cropPhoto(src, it.photo, bitmaps).catch(() => null) : null;
    it.usePhoto = !!it.photo;
  }
  bitmaps.forEach(b => b.close?.());
  return { items, notes: out.notes || '', secs: (performance.now() - t0) / 1000, cost };
}

// ---------- "Find missing photos online": Claude finds the brand's own store page, the app takes the photo from it ----------
// Claude (web search) only finds the product page. The photo itself comes from the store: most filament brands'
// shops run on Shopify, which publishes every product with a photo per color at <shop>/products/<name>.js; the app
// fetches it. The app picks the variant for this color and keeps a small copy, like a screenshot cut-out.
const SEARCH_PRICE = 0.01;   // $ per web search
const PAGES_TOOL = {
  name: 'report_product_pages', strict: true,
  description: 'Report the product page you found for each numbered item. Call this once, at the end, with every item number.',
  input_schema: { type:'object', additionalProperties:false, required:['products'], properties:{
    products:{ type:'array', items:{ type:'object', additionalProperties:false, required:['item', 'page_url', 'store_color'],
      properties:{ item:{ type:'integer' }, page_url:nullable('string'), store_color:nullable('string') } } } } },
};
const PAGES_SYSTEM = `You find the official product page for 3D-printer filament so its product photo can be shown in a home filament inventory.

For each numbered item, use web search to find the page for that exact product line on the manufacturer's own online store. Prefer pages whose address looks like https://<store>/products/<product-name>; most filament brands' stores work that way. Don't use Amazon, eBay, AliExpress, Walmart or other marketplaces, reviews, videos or forums. Several colors of the same product line usually share one page, so search once per product line, not once per color.

store_color is the color as that store names it (for example "Translucent Red"), or null if you can't tell. Give page_url null when you can't find a page on the manufacturer's own store. When you're done, call report_product_pages once with every item.`;

async function findProductPages(list) {
  if (!await refreshKey()) throw new Error('Add your Anthropic API key in Settings first (the gear at the top right).');
  const messages =[{ role:'user', content: 'Find the manufacturer’s product page for each of these filaments:\n'
    + list.map((it, i) => `${i + 1}. ${it.brand} ${it.line} (${it.type}), color "${it.color}", ${it.grams} g spool`).join('\n') }];
  const lines = new Set(list.map(it => norm(it.brand + it.line))).size;
  let resp, cost = 0;
  for (let turn = 0; turn < 5; turn++) {   // the server pauses long search runs (pause_turn); send its work back to continue
    resp = await callClaude({
      model: CLAUDE_MODEL, max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort: 'medium' }, system: PAGES_SYSTEM, messages,
      tools: [{ type:'web_search_20260209', name:'web_search', max_uses: Math.min(15, lines * 2 + 2) }, PAGES_TOOL],
    });
    const u = resp.usage || {};
    cost += ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) * 0.1) * CLAUDE_PRICE.in / 1e6
          + (u.output_tokens || 0) * CLAUDE_PRICE.out / 1e6 + (u.server_tool_use?.web_search_requests || 0) * SEARCH_PRICE;
    if (resp.stop_reason !== 'pause_turn') break;
    messages.push({ role:'assistant', content: resp.content });
  }
  if (resp.stop_reason === 'refusal') throw new Error('Claude declined this search.');
  const call = resp.content.find(b => b.type === 'tool_use' && b.name === PAGES_TOOL.name);
  if (!call || !Array.isArray(call.input?.products)) throw new Error('Claude didn’t come back with product pages. Try again.');
  return { pages: call.input.products, cost };
}
// A store image -> small JPEG data URL kept with the filament (works offline, survives the store changing its site).
async function photoFromUrl(src) {
  const u = new URL(src.startsWith('//') ? 'https:' + src : src);
  if (u.hostname.endsWith('shopify.com')) u.searchParams.set('width', '800');
  const img = await api.filamentFetch({ url: u.href, as: 'image' });   // fetched by the app (no browser CORS limits)
  const bytes = Uint8Array.from(atob(img.base64), c => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: img.type }));
  const s = Math.min(1, PHOTO_PX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', 0.8);
}
// The photo for this color from a Shopify product page; { photo, page, exact } or null when the store isn't Shopify.
async function storePhoto(pageUrl, color, storeColor) {
  let u; try { u = new URL(pageUrl); } catch { return null; }
  const m = u.pathname.match(/\/products\/([^/?#]+)/); if (!m) return null;
  const p = await api.filamentFetch({ url: `${u.origin}/products/${m[1]}.js`, as: 'json' }).catch(() => null);
  if (!p) return null;
  const words = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let best = null, bestScore = 0;
  for (const v of p.variants || []) {
    if (!v.featured_image?.src) continue;
    const have = new Set(words(v.title));
    for (const want of [storeColor, color].filter(Boolean)) {
      const w = words(want); if (!w.length) continue;
      const score = w.filter(x => have.has(x)).length / w.length + (have.has('1') && have.has('75') ? 0.001 : 0);   // prefer 1.75 mm
      if (score > bestScore) { best = v; bestScore = score; }
    }
  }
  const exact = bestScore >= 1;
  const src = exact ? best.featured_image.src : (p.featured_image || p.images?.[0]);
  if (!src) return null;
  return { photo: await photoFromUrl(src), page: u.origin + '/products/' + m[1], exact };
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function findExisting(it, fil) {
  return fil.find(f => norm(f.brand) === norm(it.brand) && f.type === it.type && norm(f.color) === norm(it.color)
    && +f.grams === +it.grams && norm(f.line) === norm(it.line || it.type));
}

let shot = null;   // the open "From screenshot" window: { files, urls, busy, err, result }
function openShot(files = []) {
  if (shot) shot.urls.forEach(u => URL.revokeObjectURL(u));
  shot = { files:[], urls:[], busy:false, err:'', result:null };
  openFid = null;
  addShotFiles(files);
  $('#overlay').classList.add('open');
  renderShot();
  refreshKey().then(() => { if (shot) renderShot(); });   // the key may have been set in Settings meanwhile
}
function addShotFiles(files) {
  for (const f of files) if (f.type.startsWith('image/')) { shot.files.push(f); shot.urls.push(URL.createObjectURL(f)); }
}
function renderShot() {
  if (!shot) return;
  const r = shot.result, ready = shot.files.length && !shot.busy && hasKey;
  $('#modal').innerHTML = `<button class="x" data-close>×</button><div class="shot">
    <h2>Add filament from a screenshot</h2>
    <p class="muted" style="margin:0">Drop, paste (Ctrl+V) or choose screenshots of an order page, receipt, cart or product page. Claude reads them, and you check the list before anything is added.</p>
    ${hasKey ? '' : `<div class="mfr" style="margin-top:12px">To read screenshots, first add your Anthropic API key in the app's <a href="#" data-app-settings>Settings</a>.</div>`}
    <div class="drop" data-drop>Drop screenshots here, paste with Ctrl+V, or <u>choose files</u><input type="file" accept="image/*" multiple hidden data-shotfile></div>
    ${shot.files.length ? `<div class="thumbs">${shot.urls.map((u, i) => `<figure><img src="${u}" alt="Screenshot ${i + 1}"><button class="btn small" data-shotdel="${i}" title="Remove this screenshot">✕</button></figure>`).join('')}</div>` : ''}
    <div class="actions" style="margin-top:4px;align-items:center">
      <button class="btn primary" data-shotread ${ready ? '' : 'disabled'}>${shot.busy ? '<span class="spin"></span> Reading… (usually under a minute)' : r ? 'Read again' : 'Read with Claude'}</button>
      ${shot.err ? `<span style="color:var(--danger);font-size:14px">${esc(shot.err)}</span>` : ''}
    </div>
    ${r ? reviewHtml(r) : ''}
  </div>`;
}
const missingPhotos = r => r.items.filter(it => it.on && !(it.photo && it.usePhoto) && String(it.brand).trim() && String(it.color).trim());
function reviewHtml(r) {
  if (!r.items.length) return `<div class="empty" style="padding:30px 10px">No filament found.${r.notes ? '<br>' + esc(r.notes) : ''}</div>`;
  const fil = allFilaments();
  const opt = (list, v) => list.map(x => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const brands = [...new Set(fil.map(f => f.brand))].sort();
  return `<datalist id="shotBrands">${brands.map(b => `<option value="${esc(b)}">`).join('')}</datalist>
  <div class="tablewrap" style="margin-top:14px;overflow:auto"><table class="review"><thead><tr>
    <th></th><th>Photo</th><th></th><th style="width:20%">Color</th><th>Brand</th><th>Type</th><th>Product line</th><th>Finish</th><th>g / spool</th><th>Spools</th><th>$ each</th><th>Status</th></tr></thead><tbody>
  ${r.items.map((it, i) => { const ex = findExisting(it, fil); return `<tr data-i="${i}">
    <td><input type="checkbox" data-k="on" ${it.on ? 'checked' : ''} title="Add this one"></td>
    <td>${it.photo ? `<label class="ph" title="${it.photoPage ? (it.photoExact ? 'Product photo from the brand’s store' : 'Photo of the product line from the brand’s store (no photo of this exact color)') : 'Product photo cut from the screenshot'}. Untick to leave it out."><img src="${it.photo}" alt=""><span><input type="checkbox" data-k="usePhoto" ${it.usePhoto ? 'checked' : ''}> use</span></label>
      ${it.photoPage ? `<a class="phsrc" href="${esc(it.photoPage)}" target="_blank" rel="noopener">${it.photoExact ? 'from store' : 'store · line photo'}</a>` : ''}` : '<span class="muted" style="font-size:12px">none</span>'}</td>
    <td><input type="color" data-k="hex0" value="${esc(it.hex[0])}" title="Swatch color (approximate)"></td>
    <td><input data-k="color" value="${esc(it.color)}">${ex ? `<div class="match">Adds spools to your existing ${esc(ex.color)}</div>` : ''}${it.note ? `<div class="note">${esc(it.note)}</div>` : ''}</td>
    <td><input data-k="brand" list="shotBrands" value="${esc(it.brand)}"></td>
    <td><select data-k="type">${opt(FIL_TYPES, it.type)}</select></td>
    <td><input data-k="line" value="${esc(it.line)}"></td>
    <td><select data-k="finish">${opt(FINISHES, it.finish)}</select></td>
    <td><input type="number" min="1" step="1" data-k="grams" value="${esc(it.grams)}" style="width:76px"></td>
    <td><input type="number" min="0" step="1" data-k="spools" value="${esc(it.spools)}" style="width:60px"></td>
    <td><input type="number" min="0" step="0.01" data-k="price" value="${esc(it.price)}" style="width:76px"></td>
    <td><select data-k="status">${[['new', 'Sealed'], ['opened', 'Opened'], ['ordered', 'On order']].map(([k, l]) => `<option value="${k}" ${k === it.status ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
  </tr>`; }).join('')}
  </tbody></table></div>
  <div class="actions" style="align-items:center">
    <label class="muted" style="font-size:13px">Put in-stock spools in
      <select class="sel" data-shotloc><option value="">— no location —</option>${state.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>
    <span style="flex:1"></span>
    <span class="muted" style="font-size:13px">${r.items.length} found · read in ${Math.round(r.secs)} s · cost about ${fmt$(r.cost)}</span>
    <button class="btn primary" data-shotadd>Add checked filament</button>
  </div>
  <div class="actions" style="align-items:center;margin-top:8px">
    ${(() => { const n = missingPhotos(r).length; return `<button class="btn" data-shotweb ${n && !shot.webBusy && !shot.busy ? '' : 'disabled'} title="Claude searches the web for each brand’s own store page, then the photo for that color is copied from the store. About 1 cent per search plus Claude’s time.">${shot.webBusy ? '<span class="spin"></span> Searching the brands’ stores…' : `🔎 Find missing photos online${n ? ` (${n})` : ''}`}</button>`; })()}
    <span style="font-size:13px;color:${shot.photoErr ? 'var(--danger)' : 'var(--muted)'}">${esc(shot.photoMsg || '')}</span>
  </div>
  ${r.notes ? `<p class="muted" style="font-size:13px;margin:8px 0 0">Claude’s note: ${esc(r.notes)}</p>` : ''}`;
}
function addFromShot() {
  const loc = $('[data-shotloc]')?.value || '';
  let newFil = 0, spools = 0, skipped = 0;
  shot.result.items.forEach((it, n) => {
    if (!it.on) return;
    if (!String(it.color).trim() || !String(it.brand).trim()) { skipped++; return; }
    let f = findExisting(it, allFilaments());
    if (!f) {
      f = { id: 'c-' + Date.now().toString(36) + n, brand: it.brand.trim(), type: it.type, line: it.line.trim() || it.type, finish: it.finish,
            color: it.color.trim(), fams: it.families.length ? it.families : ['Multicolor'], hex: it.hex.length > 1 ? it.hex : it.hex[0],
            grams: +it.grams || 1000, img: it.usePhoto && it.photo || '', note: it.store ? `Bought from ${it.store}${it.order_date ? ' on ' + fmtDate(it.order_date) : ''}` : '', added: today() };
      state.custom.push(f); newFil++;
    } else if (f.custom && !f.img && it.usePhoto && it.photo) {
      state.custom.find(c => c.id === f.id).img = it.photo;   // an existing filament without a photo gets this one
    }
    const price = it.price === '' || it.price == null ? null : +it.price;
    for (let i = 0; i < (+it.spools || 0); i++) {
      const s = newSpool(f.id, { status: it.status === 'ordered' ? 'ordered' : 'new', price, bought: it.order_date || today(), note: 'Added from a screenshot' });
      if (it.status === 'opened') setStatus(s, 'opened');
      if (loc && it.status !== 'ordered') setLoc(s, loc);
      spools++;
    }
  });
  if (!newFil && !spools) return toast(skipped ? 'Each checked row needs a color and a brand' : 'Nothing checked to add');
  persist(); closeModal();
  toast(`Added ${spools} spool${spools === 1 ? '' : 's'}${newFil ? ` · ${newFil} new filament${newFil === 1 ? '' : 's'}` : ''}${skipped ? ` · ${skipped} skipped (no color or brand)` : ''}`);
}

$('#shotBtn').addEventListener('click', () => openShot());
$('#overlay').addEventListener('click', async e => {
  if (!shot) return;
  const t = e.target;
  if (t.closest('[data-drop]') && !t.matches('input')) return $('[data-shotfile]').click();
  const del = t.closest('[data-shotdel]');
  if (del) { const i = +del.dataset.shotdel; URL.revokeObjectURL(shot.urls[i]); shot.files.splice(i, 1); shot.urls.splice(i, 1); return renderShot(); }
  if (t.closest('[data-shotadd]')) return addFromShot();
  if (t.closest('[data-shotweb]')) {
    const mine = shot, list = missingPhotos(mine.result);
    if (!list.length) return;
    mine.webBusy = true; mine.photoMsg = ''; mine.photoErr = false; renderShot();
    try {
      const { pages, cost } = await findProductPages(list);
      let found = 0, lineOnly = 0;
      await Promise.all(pages.map(async p => {
        const it = list[p.item - 1];
        if (!it || !p.page_url) return;
        const got = await storePhoto(p.page_url, it.color, p.store_color).catch(() => null);
        if (!got) return;
        Object.assign(it, { photo: got.photo, usePhoto: true, photoPage: got.page, photoExact: got.exact });
        found++; if (!got.exact) lineOnly++;
      }));
      mine.photoMsg = `Found ${found} of ${list.length} photo${list.length === 1 ? '' : 's'}`
        + (lineOnly ? ` (${lineOnly} show${lineOnly === 1 ? 's' : ''} the product line, not that exact color)` : '')
        + (found < list.length ? '. The rest aren’t on a brand store the app can read.' : '')
        + ` · cost about ${fmt$(cost)}`;
    } catch (err) { mine.photoMsg = err.message; mine.photoErr = true; }
    mine.webBusy = false;
    if (shot === mine) renderShot();
  }
  if (t.closest('[data-shotread]')) {
    const mine = shot;
    mine.busy = true; mine.err = ''; renderShot();
    try { mine.result = await readScreenshots(mine.files); } catch (err) { mine.err = err.message; }
    mine.busy = false;
    if (shot === mine) renderShot();
  }
});
function updateShotItem(t) {
  const row = t.closest('table.review tr[data-i]'), k = t.dataset.k;
  if (!shot?.result || !row || !k) return;
  const it = shot.result.items[+row.dataset.i];
  if (t.type === 'checkbox') it[k] = t.checked;
  else if (k === 'hex0') it.hex[0] = t.value;
  else it[k] = t.type === 'number' ? (t.value === '' ? '' : +t.value) : t.value;
}
$('#overlay').addEventListener('input', e => { if (shot) updateShotItem(e.target); });
$('#overlay').addEventListener('change', e => {
  if (!shot) return;
  if (e.target.matches('[data-shotfile]')) { addShotFiles(e.target.files); renderShot(); }
  else updateShotItem(e.target);
});
// Drop or paste an image anywhere: opens the screenshot reader (or adds to it when it's already open).
const imageFiles = list => [...(list || [])].filter(f => f.type.startsWith('image/'));
const draggingImage = e => [...(e.dataTransfer?.items || [])].some(i => i.kind === 'file' && i.type.startsWith('image/'));
const formOpen = () => $('#overlay').classList.contains('open') && !shot;   // another window (Add filament, details) is open
document.addEventListener('dragover', e => {
  if (!draggingImage(e) || e.target.closest?.('input[type=file]') || formOpen()) return;
  e.preventDefault(); $('[data-drop]')?.classList.add('over');
});
document.addEventListener('dragleave', e => { if (!e.relatedTarget) $('[data-drop]')?.classList.remove('over'); });
document.addEventListener('drop', e => {
  if (e.target.closest?.('input[type=file]') || formOpen()) return;
  const files = imageFiles(e.dataTransfer?.files);
  if (!files.length) return;
  e.preventDefault();
  if (shot) { addShotFiles(files); renderShot(); } else openShot(files);
});
document.addEventListener('paste', e => {
  const files = imageFiles(e.clipboardData?.files);
  if (!files.length || formOpen()) return;
  e.preventDefault();
  if (shot) { addShotFiles(files); renderShot(); } else openShot(files);
});

$('#addBtn').addEventListener('click', () => openForm());
$('#themeBtn').addEventListener('click', () => {
  const order = ['auto','light','dark']; state.settings.theme = order[(order.indexOf(state.settings.theme) + 1) % 3];
  persist(); render(); toast('Theme: ' + state.settings.theme);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#overlay').classList.contains('open')) closeModal();
  else if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
    e.preventDefault(); if (!['inventory','spools'].includes(ui.view)) go('inventory'); $('#q').focus();
  }
});

render();
