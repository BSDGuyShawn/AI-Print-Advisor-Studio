// The guided tour's stand-in for preload.js (used on the first launch, see decideTour in main.js). Same
// window.advisor calls, but every answer comes from demo/recording.json (real results recorded once from the app on
// the sample models). Nothing is sliced, saved, exported, sent to a printer or asked of the AI; anything that would
// do one of those explains instead. It puts the "GUIDED TOUR" banner on the window and keeps filament edits in
// memory only. Two things are real: an API key typed into Settings is saved for later, and finishing the tour.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const fs = require('fs');
const path = require('path');
const { decode } = require('./src/demo-codec');

const DIR = path.join(__dirname, 'demo');
const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return fallback; } };
const REC = decode(read('recording.json', []));
const PRINTERS = read('printers.json', []);
const FIL = { catalog: read('filament/catalog.json', { orders: [], prices: {} }), state: read('filament/state.json', null) };
const base = (p) => String(p || '').split(/[\\/]/).pop();
const MODELS = [...new Set(REC.filter(r => r.m === 'open-path').map(r => r.args[0]))];   // the tour models, in tour order
const ctx = { file: null, remix: null };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const clone = (v) => (v == null ? v : structuredClone(v));

// ---------- the banner and the "tour only" notice ----------
const NOTICES = {
  save: ['Saving is turned off in the tour', 'After the tour this saves the model as a 3MF with the settings built in, ready to open in your slicer.'],
  send: ['Nothing is sent to a printer in the tour', 'After the tour this uploads the print to the chosen Snapmaker U1 and starts it, with the filaments mapped to its toolheads.'],
  orca: ['The tour doesn’t open your slicer', 'After the tour this writes the project and opens it in Snapmaker Orca, then offers to reload your edits.'],
  export: ['Exporting is turned off in the tour', 'After the tour this saves the settings or the project as a file.'],
  open: ['The tour only opens its sample models', 'Pick one of the sample models. To check your own models, finish the tour: the app then opens any .3mf.'],
  ai: ['No AI in the tour', 'After the tour this asks Claude with your own Anthropic API key (usually a few cents). In the tour everything shown was recorded earlier from the real app.'],
  remix: ['This scheme can’t be applied in the tour', 'The tour can apply “{name}”. After the tour you can apply any scheme.'],
  link: ['Shop links are switched off in the tour', 'After the tour this opens the store page where you bought the filament, so you can reorder it.'],
  key: ['Your API key is saved', 'The tour itself only replays recorded results, so the key isn’t used yet. Once you finish the tour, the app uses it for real AI advice on your own models.'],
  printers: ['Printer setup is switched off in the tour', 'After the tour you add your printers here (address and API key) to send prints and see their history.'],
  ts: ['The tour troubleshoots one sample print', 'Open the troubleshooter on the cancelled “Demo Rocket” print. After the tour any print from your printers can be troubleshot.'],
  files: ['Files are switched off in the tour', 'After the tour this opens or saves files on your computer.'],
  generic: ['Not available in the tour', 'The tour uses recorded results. Finish the tour to do this for real.'],
};
function notice(kind, vars = {}) {
  const [title, text] = NOTICES[kind] || NOTICES.generic;
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] || '');
  let dlg = document.getElementById('demoNotice');
  if (!dlg) {
    dlg = document.createElement('dialog'); dlg.id = 'demoNotice'; dlg.className = 'demo-notice';
    dlg.innerHTML = '<h2></h2><p class="dn-text"></p><p class="dn-more">This is the <b>guided tour</b>: a sample model with recorded results. Finish the tour (the last step) to use the app with your own models, printers and filament.</p><div class="dn-btns"><button class="btn primary" autofocus>OK</button></div>';
    dlg.querySelector('button').onclick = () => dlg.close();
    document.body.appendChild(dlg);
  }
  dlg.querySelector('h2').textContent = fill(title);
  dlg.querySelector('.dn-text').textContent = fill(text);
  if (!dlg.open) dlg.showModal();
}
ipcRenderer.on('demo-notice', (_e, kind) => notice(kind));
window.addEventListener('DOMContentLoaded', () => {
  const css = document.createElement('style');
  css.textContent = `
    .demo-banner { position: fixed; z-index: 1000; right: 14px; bottom: 14px; pointer-events: none; width: 360px;
      background: rgb(194 65 45 / .78); color: #fff; padding: 8px 14px; border-radius: 10px; font: 600 12.5px/1.35 var(--font, sans-serif);
      box-shadow: 0 4px 16px rgb(0 0 0 / .25); backdrop-filter: blur(2px); }
    .demo-banner b { letter-spacing: .08em; }
    .demo-notice { max-width: 460px; border: 1px solid var(--line, #ccc); border-radius: 10px; padding: 20px 22px; background: var(--raised, #fff); color: var(--ink, #111); }
    .demo-notice h2 { margin: 0 0 8px; font-size: 17px; }
    .demo-notice .dn-more { color: var(--muted, #666); font-size: 13px; }
    .demo-notice .dn-btns { text-align: right; margin-top: 12px; }
    .demo-notice::backdrop { background: rgb(0 0 0 / .35); }
    .demo-pick { display: grid; gap: 8px; margin-top: 10px; }
    .demo-pick button { text-align: left; padding: 10px 12px; }
    .demo-pick small { display: block; color: var(--muted, #666); font-weight: 400; margin-top: 2px; }`;
  document.head.appendChild(css);
  const b = document.createElement('div');
  b.className = 'demo-banner';
  b.innerHTML = '<b>GUIDED TOUR</b> · a sample model with recorded results: nothing is sliced, saved, printed or sent to AI. Finish the tour to use your own models and filament.';
  document.body.appendChild(b);
});

// "Open 3MF" in the tour: choose one of the two sample models
function pickModel() {
  return new Promise((resolve) => {
    let dlg = document.getElementById('demoPick');
    if (!dlg) {
      dlg = document.createElement('dialog'); dlg.id = 'demoPick'; dlg.className = 'demo-notice';
      document.body.appendChild(dlg);
    }
    const about = {
      'Demo Rocket.3mf': 'A 4-color toy rocket saved lying on its side with poor settings. The main tour: orientation, recommendations, slice comparison, Color remix and troubleshooting.',
      'Demo Rocket (MakerWorld version).3mf': 'The same rocket as a MakerWorld download, a Bambu Lab P1S project. Shows how the app converts Bambu files for a Snapmaker U1 or another non-Bambu printer. (Bambu Lab owners can open MakerWorld files as they are.)',
    };
    dlg.innerHTML = `<h2>Open a sample model</h2><p class="dn-more">The tour opens only its sample models. After the tour you open any .3mf (MakerWorld, Printables, your slicer…).</p>
      <div class="demo-pick">${MODELS.map((m, i) => `<button class="btn" data-i="${i}"><b>${base(m)}</b><small>${about[base(m)] || ''}</small></button>`).join('')}</div>
      <div class="dn-btns"><button class="btn ghost" data-cancel>Cancel</button></div>`;
    dlg.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (b) { dlg.close(); resolve(MODELS[+b.dataset.i]); }
      else if (e.target.closest('[data-cancel]')) { dlg.close(); resolve(null); }
    };
    dlg.oncancel = () => resolve(null);
    dlg.showModal();
  });
}

// ---------- replaying recorded answers ----------
// which recorded answer fits a call: same model and remix state, same inputs where they matter, else the latest
const KEY = {
  'analyze-plate': (a) => JSON.stringify(a[0] && a[0].rotations || {}),
  'recipe-preview': (a) => String(a[0]),
  'prepare': (a) => JSON.stringify((a[0] || []).map(s => [s.slot, s.type, String(s.color || '').toUpperCase()])),
  'run-checks': (a) => JSON.stringify([a[0] && a[0].changes || [], a[0] && a[0].rotations || {}]),
  'send-prepare': (a) => a[0] && a[0].variant && a[0].variant.id,
  'remix-apply': (a) => String(a[0] && a[0].index),
  'ts-open': (a) => a[0] && a[0].jobId,
  'open-path': (a) => base(a[0]),
  'heavy-check': (a) => JSON.stringify(a[0] || {}), 'blocker-check': (a) => JSON.stringify(a[0] || {}),
};
function find(m, args, { strict = false } = {}) {
  const all = REC.filter(r => r.m === m);
  if (!all.length) return null;
  const k = KEY[m] ? KEY[m](args) : null;
  const sameFile = (r) => base(r.ctx.file) === base(ctx.file), sameRemix = (r) => (r.ctx.remix || null) === (ctx.remix || null);
  const keyed = (r) => k == null || (KEY[m](r.args) === k);
  const tiers = [(r) => sameFile(r) && sameRemix(r) && keyed(r), (r) => sameFile(r) && keyed(r), (r) => keyed(r)];
  if (!strict) tiers.push((r) => sameFile(r) && sameRemix(r), (r) => sameFile(r), () => true);
  for (const t of tiers) { const hit = all.filter(t).pop(); if (hit) return hit; }
  return null;
}
async function replay(m, args, { delay = 0, steps = [], strict = false } = {}) {
  const r = find(m, args, { strict });
  if (steps.length) for (const s of steps) { say(s); await wait(delay / steps.length); }
  else if (delay) await wait(delay);
  if (!r) throw new Error('Not part of this tour.');
  if (r.err) throw new Error(r.err);
  return clone(r.r);
}

const listeners = { progress: [], startup: [], printName: [], sendProgress: [], spend: [] };
// AI spending as the app after the tour shows it, with typical costs of the recorded requests (nothing is charged in the tour)
const demoSpend = { entries: [] };
function spent(feature, usd) {
  demoSpend.entries.push({ t: new Date().toISOString(), feature, model: 'claude-opus-5-5', in: 0, out: 0, cr: 0, cw: 0, searches: 0, usd });
  const month = { usd: +demoSpend.entries.reduce((t, e) => t + e.usd, 0).toFixed(4), calls: demoSpend.entries.length };
  listeners.spend.forEach(cb => { try { cb({ usd, feature, month }); } catch {} });
}
function spendSummary() {
  const total = { usd: +demoSpend.entries.reduce((t, e) => t + e.usd, 0).toFixed(4), calls: demoSpend.entries.length };
  const by = {};
  for (const e of demoSpend.entries) { const f = (by[e.feature] ||= { usd: 0, calls: 0 }); f.usd += e.usd; f.calls++; }
  return { month: total, last30: total, all: total, since: demoSpend.entries[0] ? demoSpend.entries[0].t : null,
    byFeature: Object.entries(by).map(([feature, v]) => ({ feature, usd: +v.usd.toFixed(4), calls: v.calls })), recent: demoSpend.entries.slice(-8).reverse() };
}
const withCost = (feature, usd, p) => p.then(r => { spent(feature, usd); return r; });
const say = (text) => listeners.progress.forEach(cb => { try { cb(text); } catch {} });
const blocked = (kind, value = null) => async () => { notice(kind); return value; };
const failing = (kind, message) => async () => { notice(kind); throw new Error(message || NOTICES[kind][0]); };

// in-memory settings for the session (nothing is written)
const recordedConfig = (find('get-config', []) || {}).r || {};
const config = Object.assign({}, recordedConfig, {
  hasKey: true, keyNeedsReentry: false, aiMode: 'api', experience: null, guideDone: false, explainWords: null, model: recordedConfig.model || 'claude-opus-5-5',
  printers: PRINTERS.map(p => ({ name: p.name, url: p.url, hasKey: false })), demo: true,
  version: require('./package.json').version,   // this build's version, not the one the answers were recorded with
});
let filamentState = clone(FIL.state);
let filamentStock = null;

// a recorded print history, with the dates moved so the newest is yesterday
function historyShifted(list) {
  const out = clone(list);
  const times = (out.jobs || []).map(j => Date.parse(j.start)).filter(Boolean);
  if (!times.length) return out;
  const shift = (Date.now() - 20 * 3600 * 1000) - Math.max(...times);
  for (const j of out.jobs) if (j.start) j.start = new Date(Date.parse(j.start) + shift).toISOString();
  return out;
}

// your printers, as the send dialog sees them (made up: one busy, one offline)
function printersStatus() {
  const heads = (colors) => colors.map((c, i) => ({ index: i, type: 'PLA', subType: null, vendor: 'Generic', color: c, loaded: true }));
  return PRINTERS.map((p, i) => ({
    index: i, name: p.name, url: p.url,
    ...(i === 1 ? { online: true, klippy: 'ready', state: 'printing', filename: 'Desk Organizer_plate_1.gcode', progress: 0.42, heads: heads(['#FFFFFF', '#161616', '#2D9E59', '#F55A7C']), hasTaskConfig: true }
      : i === 3 ? { online: false, error: 'Not reachable', heads: [] }
      : { online: true, klippy: 'ready', state: 'standby', filename: null, progress: null, heads: heads(['#FFFFFF', '#D32F2F', '#1E5BD0', '#8A8A8A']), hasTaskConfig: true }),
  }));
}

contextBridge.exposeInMainWorld('advisor', {
  demo: true, tour: true,
  // the end of the tour: remember it and start the app for real (with the experience level picked in the tour)
  finishTour: () => ipcRenderer.invoke('tour-finish', { experience: config.experience, explainWords: config.explainWords }),
  choose3mf: async () => { const p = await pickModel(); return p ? api_openPath(p) : null; },
  openPath: (p) => api_openPath(p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  slicerInfo: async () => clone(config.slicer),
  prepare: (slots) => replay('prepare', [slots], { delay: 700, steps: ['Preparing the project for your printer…'] }),
  analyzePlate: (a) => replay('analyze-plate', [a], { delay: 500 }),
  recipePreview: (s) => replay('recipe-preview', [s]),
  runChecks: (a) => replay('run-checks', [a]),
  runClaude: (a) => withCost('Recommendations', 0.16, replay('run-claude', [a], { delay: 7000, steps: ['Slicing the original in Snapmaker Orca…', 'Reading print history from your printers…', 'Claude is reviewing the model, slice and settings…', 'Claude is reviewing the model, slice and settings…'] })),
  sliceVariants: async ({ variants }) => {
    // each version from its recorded slice of this model
    const recs = REC.filter(r => r.m === 'slice-variants' && base(r.ctx.file) === base(ctx.file));
    say(`Slicing ${variants.length} variant${variants.length === 1 ? '' : 's'}…`);
    const out = [];
    for (const [i, v] of variants.entries()) {
      await wait(700);
      const hit = recs.map(r => r.r.find(x => x.id === v.id)).filter(Boolean).pop();
      out.push(hit ? clone(hit) : { id: v.id, ok: false, error: 'This version wasn’t sliced for the tour. After the tour the app slices any version you pick.' });
      say(`Sliced ${i + 1} of ${variants.length}`);
    }
    return out;
  },
  save3mf: blocked('save'), saveGcode: blocked('save'), exportPresets: blocked('export'),
  historyList: async () => historyShifted(await replay('history-list', [], { delay: 600 })),
  printersStatus: async () => printersStatus(),
  sendPrepare: (a) => replay('send-prepare', [a], { delay: 400 }),
  sendPrint: failing('send', 'Tour: nothing was sent. Use the app after the tour to print.'),
  onSendProgress: (cb) => listeners.sendProgress.push(cb),
  tsOpen: async (a) => { const r = find('ts-open', [a], { strict: true }); if (!r) { notice('ts'); throw new Error('The tour troubleshoots the “Demo Rocket” print only.'); } return clone(r.r); },
  tsPickModel: blocked('files'),
  tsLoad: (a) => replay('ts-load', [a], { delay: 1500, steps: ['Loading the printed G-code and the model…'] }),
  tsRun: (a) => withCost('Troubleshooting', 0.12, replay('ts-run', [a], { delay: 6000, steps: ['Reading what the printer did at the failed spot…', 'Claude is diagnosing the print…', 'Claude is diagnosing the print…'] })),
  rowsFor: (s) => replay('rows-for', [s]),
  chatAnswer: failing('ai'),
  openFolder: blocked('files'), showInFolder: blocked('files'), openLogFolder: blocked('files'),
  pastAnalyses: async () => [],
  sessionSave: async () => true, sessionGet: async () => null, sessionClear: async () => true,
  sessionExport: blocked('export'), sessionImport: blocked('files'), sessionOpened: async () => null, sessionForgetFile: async () => true, recentSessions: async () => [],
  discoverPrinters: blocked('printers', []),
  setAssembly: async () => true,
  fitCritical: () => replay('fit-critical', []).catch(() => []),
  printName: () => replay('print-name', []).catch(() => null),
  setPrintName: async (n) => { listeners.printName.forEach(cb => cb({ name: n })); return true; },
  onPrintName: (cb) => listeners.printName.push(cb),
  blockerCheck: (a) => replay('blocker-check', [a]).catch(() => ({ offer: false })),
  heavyCheck: (a) => replay('heavy-check', [a]).catch(() => ({ heavy: false })),
  heavyFix: failing('generic'), heavyUndo: async () => false,
  setBlockers: (a) => replay('set-blockers', [a]).catch(() => true),
  inventoryStatus: async () => (filamentStock ? { set: true, builtin: true, ok: true, onHand: true, count: filamentStock.filaments.length, spools: filamentStock.filaments.reduce((t, f) => t + (f.spools || 0), 0) } : { set: true, builtin: true, ok: true, onHand: true, count: 0, spools: 0 }),
  batchChoose: blocked('files', []), batchFolder: blocked('files'), batchConvert: failing('files'), batchCancel: async () => true,
  onBatchProgress: () => {},
  // the Filament screen: your sample inventory, editable for this session only
  filamentLoad: async () => ({ catalog: clone(FIL.catalog), state: clone(filamentState), imagesBase: 'app://bundle/demo/filament/images/', hasKey: true, printers: PRINTERS.map(p => p.name) }),
  filamentSave: async ({ state, stock }) => { filamentState = clone(state); filamentStock = clone(stock); return true; },
  filamentHasKey: async () => true,
  filamentClaude: failing('ai', 'Tour: reading screenshots and finding photos need the app after the tour and your API key.'),
  filamentFetch: failing('ai', 'Tour: looking up store photos needs the app after the tour.'),
  filamentOpenFolder: blocked('files'),
  remixPrepare: (a) => replay('remix-prepare', [a], { delay: 900, steps: ['Cutting the model into patches…'] }),
  partsIdentify: (a) => withCost('Color remix: parts', 0.08, replay('parts-identify', [a], { delay: 5000, steps: ['Identifying the parts of the model…'] })),
  partsConfirm: (a) => replay('parts-confirm', [a], { delay: 600 }),
  shoppingCheck: (a) => replay('shopping-check', [a]).catch(() => ({ set: false })),
  shoppingFind: failing('ai', 'Tour: searching shops needs the app after the tour.'),
  remixRun: (a) => withCost('Color remix: schemes', 0.10, replay('remix-run', [a], { delay: 6000, steps: ['Designing color schemes…'] })),
  remixApply: async (a) => {
    const r = find('remix-apply', [a], { strict: true });
    const any = find('remix-apply', [a]);
    if (!r) { notice('remix', { name: any && any.r && any.r.name }); throw new Error(`In the tour you can apply “${any && any.r && any.r.name}”.`); }
    await wait(1200);
    ctx.remix = r.r.name;
    return clone(r.r);
  },
  remixUndo: async () => { if (!ctx.remix) return false; ctx.remix = null; return true; },
  bambuInfo: () => replay('bambu-info', []).catch(() => ({ available: false })),
  bambuLocate: blocked('files'), exportBambu: blocked('export'),
  onDiscoverProgress: () => {},
  onMenu: (cb) => ipcRenderer.on('menu', (_e, m) => cb(m)),
  openInOrca: blocked('orca'), orcaReloaded: async () => null, onOrcaFileChanged: () => {},
  historyRate: async () => true,
  browseSlicer: blocked('files'),
  // whether a real API key is saved (the tour's own answers don't need one)
  getConfig: async () => { try { const real = await ipcRenderer.invoke('get-config'); config.realHasKey = real.hasKey; config.realAiMode = real.aiMode; } catch {} return clone(config); },
  spendSummary: async () => spendSummary(),
  spendClear: async () => { demoSpend.entries = []; return spendSummary(); },
  onSpend: (cb) => listeners.spend.push(cb),
  setConfig: async (patch) => {
    // the API key and AI choice are real settings: kept for when the tour is over
    const real = {};
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) real.apiKey = patch.apiKey;
    if (patch.aiMode === 'api' || patch.aiMode === 'chat') real.aiMode = patch.aiMode;
    if (Object.keys(real).length) { await ipcRenderer.invoke('set-config', real); if (real.apiKey) { config.realHasKey = true; notice('key'); } }
    for (const k of ['experience', 'guideDone', 'explainWords', 'model', 'aiMode']) if (k in patch) config[k] = patch[k];
    return true;
  },
  onOpenFromOS: () => {},
  onProgress: (cb) => listeners.progress.push(cb),
  startupState: async () => ({ label: 'Guided tour. Everything here is recorded from the real app.', pct: 100, done: true }),
  onStartup: (cb) => listeners.startup.push(cb),
});

// opening a model: only the tour models (dropping your own file explains instead)
async function api_openPath(p) {
  const known = MODELS.find(m => base(m).toLowerCase() === base(p).toLowerCase());
  if (!known) { notice('open'); throw new Error('The tour opens only its sample models.'); }
  ctx.file = known; ctx.remix = null;
  return replay('open-path', [known], { delay: 600, steps: ['Reading the model…'] });
}
