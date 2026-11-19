const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, protocol, net } = require('electron');

// The UI is served from app:// with explicit content types. Loading it as file:// lets Windows decide the
// content type from its registry, and a changed .html/.js association can make the page render wrongly.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const path = require('path');
const fs = require('fs/promises');
const { load3mf, analyzePlate, settingsSummary, buildPresets, applyChanges } = require('./src/threemf');
const { getMachine, setMachine } = require('./src/machine');
const { analyzeWithClaude, buildRows, buildSystemPrompt, buildUserContent } = require('./src/claude');
const { buildChatPrompt, saveImages, parseChatAnswer } = require('./src/chatmode');
const { ProfileLibrary, candidateExecutables, orcaSingleInstance } = require('./src/profiles');
const { spawn } = require('child_process');
const { Slicer } = require('./src/slicer');
const { recipeFor, recipesFor, recipeChanges, recipeGoverns, RECIPES } = require('./src/recipes');
const { runChecks } = require('./src/checks');
const { withCompat } = require('./src/compat');
const { PLACEHOLDER_BASE64 } = require('./src/thumbs');
const { U1Printer, withThumbnails, safeRemoteName } = require('./src/printer');
const { parseConfigBlock, objectsFromGcode, headerInfo, regionWindow, supportPaths } = require('./src/gcodeinfo');
const { describe } = require('./src/describe');
const { looksLikeAssembly, guardFit, FIT_CRITICAL } = require('./src/fit');
const { heuristicName, aiName } = require('./src/naming');
const { analyzeGcode } = require('./src/gcode');
const { troubleshoot, ISSUES, systemPrompt: tsSystemPrompt, buildContent: tsBuildContent } = require('./src/troubleshoot');
const { CATALOG, CONTEXT_KEYS, BY_KEY } = require('./src/orca-settings');
const crypto = require('crypto');
const JSZip = require('jszip');
const fss = require('fs');
const { fetchJobs, PrintLog, historyForPrompt } = require('./src/history');
const Spend = require('./src/spend');
// Which feature an AI call belongs to, for the spending record: the window action that started it.
const AI_FEATURES = { 'run-claude': 'Recommendations', 'parts-identify': 'Color remix: parts', 'remix-run': 'Color remix: schemes',
  'shopping-find': 'Finding filament to buy', 'ts-run': 'Troubleshooting', 'filament-claude': 'Filament: screenshots and photos', 'open-path': 'Print names' };
{
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => handle(channel, AI_FEATURES[channel] ? (...a) => Spend.run(AI_FEATURES[channel], () => fn(...a)) : fn);
}

// The demo build ships a demo/ folder (made by tools/build_demo.py). Its window then uses preload-demo.js, which
// replays recorded answers: nothing is sliced, saved, sent or asked of the AI. It has its own data folder, so it
// never touches the real app's settings or filament.
const DEMO = require('fs').existsSync(path.join(__dirname, 'demo', 'recording.json'));
if (DEMO) app.setPath('userData', path.join(app.getPath('appData'), 'AI 3D Print Advisor Studio DEMO'));
// For testing only: run against a separate data folder so a test never touches your settings or filament.
if (process.env.AIPA_USER_DATA) app.setPath('userData', process.env.AIPA_USER_DATA);

let win;
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const S = {
  ready: Promise.resolve(),
  original: null, originalBuffer: null, filePath: null,
  base: null,          // { buffer, settings, mode, notes, project }
  slots: [], rotations: {}, lib: null, slicer: null, printLog: null,
  lastSlices: {},
};

// The app was renamed (from "U1 Print Advisor", then "AI Print Advisor Studio"): bring settings, printers, ratings, diagnoses and sent-job copies
// over from the old data folder on first launch. Runs before anything reads the data folder.
function migrateFromOldName() {
  try {
    const fsSync = require('fs');
    const newDir = app.getPath('userData');
    // earlier names of the app, newest first
    const oldDir = ['AI Print Advisor Studio', 'U1 Print Advisor'].map(n => path.join(app.getPath('appData'), n)).find(d => fsSync.existsSync(path.join(d, 'config.json')));
    if (!oldDir || fsSync.existsSync(path.join(newDir, 'config.json'))) return;
    fsSync.mkdirSync(newDir, { recursive: true });
    for (const name of ['config.json', 'print-log.json', 'sent', 'analyses', 'session.json', 'sessions']) {
      const from = path.join(oldDir, name);
      if (fsSync.existsSync(from)) fsSync.cpSync(from, path.join(newDir, name), { recursive: true });
    }
    S.migratedFromOldName = true;
  } catch {}
}
if (!process.env.AIPA_USER_DATA && !DEMO) migrateFromOldName();   // a test data folder starts empty
// the window shows each AI request's cost as it happens (the "AI" counter in the top bar)
Spend.init(app.getPath('userData'), (e, s) => { if (win && !win.isDestroyed()) win.webContents.send('spend', { usd: e.usd, feature: e.feature, month: s.month }); });

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
async function readConfig() { try { return JSON.parse(await fs.readFile(CONFIG_PATH(), 'utf8')); } catch { return {}; } }
async function writeConfig(cfg) { await fs.mkdir(path.dirname(CONFIG_PATH()), { recursive: true }); await fs.writeFile(CONFIG_PATH(), JSON.stringify(cfg, null, 2)); }
const enc = (s) => (safeStorage.isEncryptionAvailable() ? { v: safeStorage.encryptString(s).toString('base64'), e: true } : { v: s, e: false });
// a key encrypted under the old app name may not decrypt any more: treat it as missing (the user re-enters it)
const dec = (o) => { if (!o) return ''; if (!o.e) return o.v; try { return safeStorage.decryptString(Buffer.from(o.v, 'base64')); } catch { return ''; } };
async function getApiKey() {
  const cfg = await readConfig();
  if (cfg.apiKey && typeof cfg.apiKey === 'object') return dec(cfg.apiKey);
  if (cfg.apiKey) { try { return cfg.apiKeyEncrypted ? safeStorage.decryptString(Buffer.from(cfg.apiKey, 'base64')) : cfg.apiKey; } catch { return ''; } }
  return process.env.ANTHROPIC_API_KEY || '';
}
// For recording the demo only: AIPA_FAKE_PRINTER=<folder> stands in for a printer. Its jobs.json is the print
// history, and the G-code of a job is <folder>/<file name>, so the troubleshooter can run on sample prints.
const FAKE_PRINTER = process.env.AIPA_FAKE_PRINTER || null;
async function getPrinters() {
  if (FAKE_PRINTER) return [{ name: 'U1 #1', url: 'http://demo-printer.invalid', apiKey: '' }];
  const cfg = await readConfig();
  return (cfg.printers || []).map(p => ({ name: p.name, url: p.url, apiKey: dec(p.apiKey) }));
}
const progress = (text) => win && win.webContents.send('progress', text);
// startup state is kept so a page that loads after an update can still ask for it
function startup(label, pct, done = false, warn = false) {
  S.startup = { label, pct, done, warn };
  if (win && !win.isDestroyed()) win.webContents.send('startup', S.startup);
}
ipcMain.handle('startup-state', () => S.startup || { label: 'Starting…', pct: 5, done: false });

async function setupSlicer() {
  const cfg = await readConfig();
  const exe = cfg.slicerPath || candidateExecutables()[0] || null;
  S.lib = new ProfileLibrary(exe, { cacheFile: path.join(app.getPath('userData'), 'profile-index.json'), machine: cfg.machine || undefined });
  S.slicer = new Slicer({ exe, lib: S.lib, workDir: path.join(app.getPath('userData'), 'work') });
  // the selected printer's facts drive conversion, checks and the printer check before saving or sending
  try { if (S.lib.available) setMachine(S.lib.machineFacts()); } catch (e) { logLine('printer facts unavailable:', e.message); }
}
function slicerInfo() {
  return {
    available: !!(S.slicer && S.slicer.available), exe: S.slicer ? S.slicer.exe : null, profiles: !!(S.lib && S.lib.available),
    filaments: S.lib && S.lib.available ? S.lib.filamentChoices() : [],
    recipes: recipesFor(S.lib).map(r => ({ id: r.id, name: r.name, range: r.range, about: r.about, layer: r.layer })),
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 940, minWidth: 1150, minHeight: 720, title: DEMO ? 'AI 3D Print Advisor Studio (DEMO)' : 'AI 3D Print Advisor Studio', backgroundColor: '#E9ECEE', autoHideMenuBar: false,
    webPreferences: { preload: path.join(__dirname, DEMO ? 'preload-demo.js' : 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadURL('app://bundle/renderer/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => {
    // the demo's stand-in shop links go nowhere: the window explains instead
    if (DEMO && /^https?:\/\/demo\.invalid(\/|$)/i.test(url)) win.webContents.send('demo-notice', 'link');
    else if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (DEMO) win.on('page-title-updated', (e) => e.preventDefault());
  const fileArg = process.argv.slice(1).find(a => /\.(3mf|aipsession)$/i.test(a));
  if (fileArg) win.webContents.once('did-finish-load', () => win.webContents.send('open-from-os', fileArg));
}

function fileFilaments(ps) {
  if (!ps || !Array.isArray(ps.filament_type)) return [];
  return ps.filament_type.slice(0, 4).map((t, i) => ({
    slot: i + 1, type: t, color: (Array.isArray(ps.filament_colour) && ps.filament_colour[i]) || '#888888',
    preset: (Array.isArray(ps.filament_settings_id) && ps.filament_settings_id[i]) || '',
  }));
}

async function openPath(p) {
  const buf = await fs.readFile(p);
  S.original = await load3mf(buf);
  S.originalBuffer = buf; S.filePath = p; S.rotations = {}; S.lastSlices = {};
  S.originalHash = crypto.createHash('sha1').update(buf).digest('hex');
  S.printName = null; setTimeout(() => setupPrintName().catch(() => {}), 0);
  S.slotMap = null; S.assembly = false; S.assemblyGuess = false; S.remix = null; S.remixUndo = null; S.heavyUndo = null;
  S.base = { buffer: buf, settings: S.original.projectSettings || {}, mode: 'original', notes: [], project: S.original };
  return {
    fileName: path.basename(p), filePath: p,
    plates: S.original.plates.map(pl => ({ index: pl.index, name: pl.name, objectCount: pl.objectIds.length })),
    // skip the plain gray placeholders the app adds so the slicer never has to render thumbnails
    images: S.original.images.filter(i => i.base64 !== PLACEHOLDER_BASE64).map(i => ({ name: i.name, label: i.label, dataUrl: i.dataUrl })),
    warnings: S.original.warnings, hasSettings: !!S.original.projectSettings,
    printer: S.original.projectSettings ? (S.original.projectSettings.printer_settings_id || '') : '',
    filaments: fileFilaments(S.original.projectSettings),
  };
}

ipcMain.handle('choose-3mf', async () => { await S.ready;
  const r = await dialog.showOpenDialog(win, { title: 'Open a 3MF file', filters: [{ name: '3MF project', extensions: ['3mf'] }], properties: ['openFile'] });
  return r.canceled || !r.filePaths[0] ? null : openPath(r.filePaths[0]);
});
ipcMain.handle('open-path', async (_e, p) => { await S.ready; return openPath(p); });
ipcMain.handle('slicer-info', async () => { await S.ready; return slicerInfo(); });

// Is the working project set up for the selected printer? Returns a description of the mismatch, or null.
// Nothing is saved, sliced, sent or analyzed for a project set up for a different printer.
function wrongPrinter(base = S.base) {
  if (!base || !S.slicer || !S.slicer.available) return null;
  const ps = base.settings || {};
  if (!Object.keys(ps).length) return null; // plain model not yet set up: handled by conversion
  const M = getMachine();
  const id = String(Array.isArray(ps.printer_settings_id) ? ps.printer_settings_id[0] : ps.printer_settings_id || '');
  const model = String(Array.isArray(ps.printer_model) ? ps.printer_model[0] : ps.printer_model || '');
  const target = (S.lib && S.lib.machine) || M.name;
  const ok = id === target || (!!M.model && model === M.model) || (M.isU1 && (/U1/.test(id) || /U1/.test(model)));
  return ok ? null : { project: id || model || 'another printer', printer: M.model || target };
}
function assertRightPrinter() {
  const w = wrongPrinter();
  if (w) throw new Error(`This project is still set up for the ${w.project}, not your ${w.printer}, because converting it failed. Nothing was saved, sliced or sent. Try opening the file again; if it keeps failing, open it in your slicer, choose your printer there, save it, and open that copy here.`);
}

// Convert / swap filaments so everything downstream works on a real U1 project.
// Convert a project for the selected printer, trying every method in turn (the slicer's own conversion, then
// the built-in converter, then without the file's settings, then rebuilt from the shapes). Used when a file is
// opened and by batch conversion. Returns { base, error } (base = the file as-is when everything failed).
// Custom G-code from a newer slicer can use placeholders the installed one doesn't know; it would slice the whole
// model and then fail writing the G-code. Swap such G-code for the installed printer profile's own.
async function fixForeignGcode(base, slots) {
  if (!base || !base.buffer || !S.lib) return base;
  try {
    const machine = S.lib.flatten('machine', S.slicer.targetMachine);
    let process_ = null; try { process_ = S.lib.flatten('process', S.lib.defaultProcess()); } catch {}
    const filaments = [];
    for (const s of slots || []) { try { filaments[s.slot - 1] = s.preset ? S.lib.flatten('filament', s.preset) : null; } catch { filaments[s.slot - 1] = null; } }
    const r = await GcodeCompat.fixBuffer(base.buffer, { machine, process: process_, filaments });
    if (!r.changed) return base;
    logLine(`custom G-code from a newer slicer replaced (${r.fields.join(', ')}): unknown ${r.unknown.join(', ')}`);
    const project = await load3mf(r.buffer);
    const names = { machine_start_gcode: 'start', machine_end_gcode: 'end', change_filament_gcode: 'filament change', filament_start_gcode: 'filament start', filament_end_gcode: 'filament end' };
    const ws = [...new Set(r.fields.map(f => names[f] || f.replace(/_gcode$/, '').replace(/_/g, ' ')))];
    const which = ws.length > 1 ? `${ws.slice(0, -1).join(', ')} and ${ws[ws.length - 1]}` : ws[0];
    return { ...base, buffer: r.buffer, project, settings: project.projectSettings || r.settings,
      notes: [...(base.notes || []), `This file’s ${which} G-code was written for a newer slicer (it uses ${r.unknown.slice(0, 3).join(', ')}${r.unknown.length > 3 ? '…' : ''}, which your ${S.slicer.label} doesn’t know), so it uses your ${S.slicer.label}’s own ${getMachine().short || 'printer'} G-code instead. Without this, slicing fails at the very end.`] };
  } catch (e) { logLine('G-code check failed:', e.message); return base; }
}

async function convertForPrinter(buffer, project, slots, say = progress) {
  const r = await convertForPrinterRaw(buffer, project, slots, say);
  if (r.base && S.slicer && S.slicer.available) r.base = await fixForeignGcode(r.base, slots);
  return r;
}
async function convertForPrinterRaw(buffer, project, slots, say = progress) {
  const M = getMachine();
  try {
    say(`Preparing the project for the ${M.short || 'printer'}…`);
    return { base: await S.slicer.prepareBase(buffer, project, slots), error: null };
  } catch (e) {
    logLine('conversion failed, retrying with the model only:', e.message);
    const ops = project.projectSettings || null;
    const from = ops && ops.printer_settings_id;
    const attempts = [
      // the app converts it itself; the slicer never reads the foreign file (fast, and immune to the slicer
      // crashing on newer or unusual files)
      async () => S.slicer.nativeConvert(project, slots, ops),
      // the same file without its settings
      async () => { const b = await Slicer.stripToModel(buffer); return S.slicer.prepareBase(b, await load3mf(b), slots, { carryFrom: ops }); },
      // a brand-new file from the geometry alone, converted by the slicer
      async () => { const b = await Slicer.rebuildFromGeometry(project); return S.slicer.prepareBase(b, await load3mf(b), slots, { carryFrom: ops }); },
    ];
    for (const [k, attempt] of attempts.entries()) {
      try {
        say(`Converting a different way (${k + 2} of ${attempts.length + 1})…`);
        const base = await attempt();
        // one clear note instead of the converter's plain-model wording
        base.notes = base.notes.filter(n => !/^Plain model:|^Converted by the app itself/.test(n));
        base.notes.unshift(`${from ? `This file was made for the ${from}, and` : 'This file’s'} ${S.slicer.label} crashed reading it, so ${k === 0 ? `the app converted it itself${(base.carried || []).length ? `, keeping the creator’s ${base.carried.length} quality/strength/support settings,` : ''}` : k === 1 ? 'it was converted without its own settings' : 'it was rebuilt from the model’s shapes'} and set up with the ${M.model || M.name}’s profiles. Check the result before printing.`);
        return { base, error: null };
      } catch (e2) { logLine(`conversion plan ${k + 2} failed:`, e2.message); }
    }
    return { base: { buffer, settings: project.projectSettings || {}, mode: 'original', notes: [], project }, error: e.message };
  }
}

ipcMain.handle('prepare', async (_e, slots) => { await S.ready;
  if (!S.original) throw new Error('Open a .3mf file first.');
  // after a renumbering (e.g. file filaments 1, 3, 5 shown as T1, T2, T3), the choices come back in the new
  // numbering; translate them to the file's own numbers before converting the original again
  if (S.slotMap) {
    const inv = {};
    for (const [o, n] of Object.entries(S.slotMap)) if (!(n in inv)) inv[n] = +o;
    slots = slots.map(x => (inv[x.slot] ? { ...x, slot: inv[x.slot] } : x));
  }
  S.slots = slots;
  // without a slicer the working copy is the file itself (it may have just been repainted by a colour remix)
  if (!(S.slicer && S.slicer.available)) {
    S.base = { buffer: S.originalBuffer, settings: S.original.projectSettings || {}, mode: 'original', notes: [], project: S.original };
    // test hook: a working copy with different internal names, like a slicer conversion makes
    if (process.env.U1_TEST_REBUILD_BASE && !S.original.__rebuilt) { const b = await Slicer.rebuildFromGeometry(S.original); const pr = await load3mf(b); pr.__rebuilt = true; S.base = { ...S.base, buffer: b, project: pr }; }
  }
  let error = null;
  if (S.slicer && S.slicer.available) {
    const r = await convertForPrinter(S.originalBuffer, S.original, slots);
    S.base = r.base; error = r.error;
  }
  S.lastSlices = {};
  S.blockerBase = null; S.blockerCache = new Map(); // a fresh base has no added blockers
  S.slotMap = S.base.slotMap || null;
  const wrong = wrongPrinter();
  return { mode: S.base.mode, notes: S.base.notes, error, wrongPrinter: wrong, slotMap: S.base.slotMap || null, filaments: fileFilaments(S.base.settings), hasSettings: !!Object.keys(S.base.settings || {}).length };
});

// ---------- convert without AI: one file, or many in a row ----------
// Starting toolheads for a file: its own filaments with matching presets, else PLA on every filament it uses.
function defaultSlots(project) {
  const lib = S.lib, has = (n) => n && lib && lib.byType && lib.byType.filament.has(n);
  const ff = fileFilaments(project.projectSettings);
  if (ff.length) return ff.map(f => ({ slot: f.slot, type: f.type || 'PLA', color: String(f.color).slice(0, 7), preset: has(f.preset) ? f.preset : (lib ? lib.presetForMaterial(f.type || 'PLA') : '') }));
  const used = new Set(project.items.flatMap(it => [it.extruder || 1, ...it.parts.map(p => p.extruder || 0), ...(it.paintStates || [])]).filter(n => n > 0 && n <= 16));
  return [...(used.size ? used : [1])].sort((a, b) => a - b).map(n => ({ slot: n, type: 'PLA', color: '#888888', preset: lib ? lib.presetForMaterial('PLA') : '' }));
}
// The automatic safety fixes (plate type, temperatures, object labels…) for the whole project, then the file.
async function convertedFile(base) {
  const plates = base.project.plates.length ? base.project.plates.map(p => p.index) : [1];
  const per = plates.map(pi => analyzePlate(base.project, pi, {}, { orient: false }));
  const usedSlots = [...new Set(per.flatMap(a => a.totals.extrudersUsed))].sort((a, b) => a - b);
  const fin = withCompat({ baseSettings: { ...base.settings, __converted: base.mode === 'converted' }, changes: [], usedSlots: usedSlots.length ? usedSlots : [1], lib: S.lib, objectCount: Math.max(1, ...per.map(a => a.totals.objectCount)) });
  const built = await Slicer.buildVariantDetailed(base.buffer, { changes: fin.changes, rotations: {}, project: base.project });
  return { buffer: built.buffer, fixes: fin.fixes.length + ((built.corrections || []).length) };
}
function freePath(p) {
  if (!fss.existsSync(p)) return p;
  for (let n = 2; n < 100; n++) { const q = p.replace(/\.3mf$/i, ` ${n}.3mf`); if (!fss.existsSync(q)) return q; }
  return p;
}
ipcMain.handle('batch-choose', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose .3mf files to convert', filters: [{ name: '3MF project', extensions: ['3mf'] }], properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('batch-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Save the converted files in…', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});
// files: paths; outDir: null = next to each original. Reports each file as it goes ('batch-progress').
ipcMain.handle('batch-convert', async (_e, { files, outDir }) => { await S.ready;
  if (!(S.slicer && S.slicer.available)) throw new Error('Converting needs Snapmaker Orca. Set its location in Settings.');
  const M = getMachine(), results = [];
  const send = (i, status, extra = {}) => { if (win && !win.isDestroyed()) win.webContents.send('batch-progress', { i, status, ...extra }); };
  S.batchCancel = false;
  for (const [i, file] of files.entries()) {
    if (S.batchCancel) { send(i, 'skipped', { note: 'Stopped' }); results.push({ file, ok: false, note: 'Stopped' }); continue; }
    const t = Date.now();
    try {
      send(i, 'working', { note: 'Reading…' });
      const buf = await fs.readFile(file);
      const project = await load3mf(buf);
      const { base, error } = await convertForPrinter(buf, project, defaultSlots(project), (msg) => send(i, 'working', { note: msg }));
      const wrong = wrongPrinter(base);
      if (error || wrong) throw new Error(wrong ? `Still set up for the ${wrong.project}: every way of converting it failed${error ? ` (${error})` : ''}.` : error);
      send(i, 'working', { note: 'Applying safety fixes and saving…' });
      const out = await convertedFile(base);
      const dir = outDir || path.dirname(file);
      let target = path.join(dir, `${heuristicName(path.basename(file))}.3mf`);
      if (path.resolve(target) === path.resolve(file)) target = target.replace(/\.3mf$/i, ' (advisor).3mf');
      target = freePath(target);
      await fs.writeFile(target, await stampPrintName(out.buffer, target).catch(() => out.buffer));
      const note = `${base.mode === 'same' ? 'Already set up for the ' + (M.short || 'printer') : 'Converted'}${out.fixes ? `, ${out.fixes} automatic fix${out.fixes === 1 ? '' : 'es'}` : ''} · ${((Date.now() - t) / 1000).toFixed(0)} s`;
      send(i, 'done', { note, out: target });
      results.push({ file, ok: true, out: target, note });
    } catch (e) {
      logLine('batch convert failed for', file, e.message);
      send(i, 'failed', { note: e.message });
      results.push({ file, ok: false, note: e.message });
    }
  }
  return results;
});
ipcMain.handle('batch-cancel', () => { S.batchCancel = true; return true; });

// ---------- models too heavy to slice (AI-generated meshes with texture-baked colours) ----------
const Heavy = require('./src/heavy');
ipcMain.handle('heavy-check', async (_e, { plateIndex }) => { await S.ready;
  if (!S.base) return { heavy: false };
  S.heavyCache = S.heavyCache || new WeakMap();
  const key = S.base.buffer;
  let r = S.heavyCache.get(key) && S.heavyCache.get(key)[plateIndex || 1];
  if (!r) {
    try { r = Heavy.analyze(plateItems(S.base.project, plateIndex)); } catch (e) { logLine('heavy check failed:', e.message); r = { heavy: false }; }
    delete r.meshes;
    const c = S.heavyCache.get(key) || {}; c[plateIndex || 1] = r; S.heavyCache.set(key, c);
    if (r.heavy) logLine(`heavy model: ${r.triangles} triangles, ${r.specks} colour specks, ${r.areas} colour areas${r.aiMade ? ', AI-generated mesh' : ''}`);
  }
  return { ...r, fixed: !!S.heavyUndo };
});
ipcMain.handle('heavy-fix', async (_e, { plateIndex }) => { await S.ready;
  if (!S.base) throw new Error('Open a model first.');
  progress('Cleaning up the colors and lightening the mesh… (can take a minute on big models)');
  const before = { buffer: S.originalBuffer, project: S.original, hash: S.originalHash };
  const t0 = Date.now();
  const { buffer, report } = await Heavy.fix(S.base.buffer, plateItems(S.base.project, plateIndex));
  logLine(`heavy fix: ${report.trianglesBefore} -> ${report.trianglesAfter} triangles, ${report.specksMerged} specks merged, ${Date.now() - t0} ms`);
  // the fixed version becomes the model from now on (it's already set up for your printer)
  S.heavyUndo = S.heavyUndo || before;
  S.originalBuffer = buffer;
  S.original = await load3mf(buffer);
  S.originalHash = crypto.createHash('sha1').update(buffer).digest('hex');
  S.lastSlices = {};
  return report;
});
ipcMain.handle('heavy-undo', async () => { await S.ready;
  if (!S.heavyUndo) return false;
  S.originalBuffer = S.heavyUndo.buffer; S.original = S.heavyUndo.project; S.originalHash = S.heavyUndo.hash; S.heavyUndo = null; S.lastSlices = {};
  return true;
});

// ---------- support blockers inside hollow, open models (Voronoi, lattice…) ----------
const Blk = require('./src/blockers');
function plateItems(project, plateIndex) {
  const a = analyzePlate(project, plateIndex || 1, {}, { orient: false });
  return a.objects.map(o => project.items[o.itemIndex]).filter(Boolean);
}
async function blockerInfo(plateIndex) {
  const src = S.blockerBase ? S.blockerBase.project : S.base.project;
  S.blockerCache = S.blockerCache || new Map();
  const out = { found: false, items: [], existing: false };
  const seenObj = new Set();
  for (const it of plateItems(src, plateIndex)) {
    if (Blk.hasBlockers(it)) { out.existing = true; continue; }
    // copies of one model share its definition: one blocker serves them all
    if (seenObj.has(String(it.objectId))) continue;
    seenObj.add(String(it.objectId));
    let a = S.blockerCache.get(it.index);
    if (a === undefined) { try { a = Blk.analyze(it); } catch (e) { logLine('blocker analysis failed:', e.message); a = null; } S.blockerCache.set(it.index, a); }
    if (a && a.found) { out.found = true; out.items.push({ index: it.index, name: it.name, hollowCm3: a.hollowCm3 }); }
  }
  return out;
}
ipcMain.handle('blocker-check', async (_e, { plateIndex }) => { await S.ready;
  if (!S.base) return { found: false, items: [] };
  const info = await blockerInfo(plateIndex);
  return { ...info, on: !!S.blockerBase };
});
ipcMain.handle('set-blockers', async (_e, { plateIndex, on }) => { await S.ready;
  if (!S.base) return { on: false };
  if (!on) {
    if (S.blockerBase) { S.base.buffer = S.blockerBase.buffer; S.base.project = S.blockerBase.project; S.blockerBase = null; S.lastSlices = {}; }
    return { on: false };
  }
  if (S.blockerBase) return { on: true };
  const info = await blockerInfo(plateIndex);
  if (!info.found) return { on: false };
  progress('Adding support blockers inside the model…');
  const before = { buffer: S.base.buffer, project: S.base.project };
  let buf = S.base.buffer;
  for (const { index } of info.items) {
    const it = before.project.items[index], a = S.blockerCache.get(index);
    buf = await Blk.addBlockerPart(buf, it, Blk.blockerMesh(a));
  }
  S.blockerBase = before;
  S.base.buffer = buf;
  S.base.project = await load3mf(buf);
  S.lastSlices = {};
  return { on: true, items: info.items };
});

ipcMain.handle('analyze-plate', async (_e, { plateIndex, rotations }) => { await S.ready;
  if (!S.base) throw new Error('Open a .3mf file first.');
  S.rotations = rotations || {};
  const a = analyzePlate(S.base.project, plateIndex, S.rotations);
  // judged on the whole project, not this plate: a big piece alone on its plate is still part of a multi-piece model
  a.assemblyGuess = projectLooksLikeAssembly(S.base.project);
  return a;
});

ipcMain.handle('recipe-preview', async (_e, slider) => { await S.ready;
  const r = recipeFor(slider, S.lib);
  return { recipe: { id: r.id, name: r.name, about: r.about }, changes: S.base ? recipeChanges(r, S.base.settings, S.lib) : [], governs: recipeGoverns(r, S.lib) };
});

ipcMain.handle('run-checks', async (_e, { plateIndex, changes, rotations }) => { await S.ready;
  if (!S.base) return { checks: [], fixes: [] };
  const a = analyzePlate(S.base.project, plateIndex, rotations || {}, { orient: false });
  const fin = finalize(changes, plateIndex, rotations);
  const checks = runChecks({ baseSettings: S.base.settings, changes: fin.changes, usedSlots: a.totals.extrudersUsed, totals: a.totals });
  const fitRisk = (changes || []).filter(c => FIT_CRITICAL.has(c.key));
  const looksAssembly = S.assemblyGuess || projectLooksLikeAssembly(S.base.project);
  if (!S.assembly && looksAssembly && fitRisk.length) {
    checks.unshift({ severity: 'critical', title: '⚠ These parts look like they fit together, and these changes can stop them fitting',
      detail: `This plate has several different parts, and these changes alter their walls or sizes: ${[...new Set(fitRisk.map(c => (BY_KEY[c.key] ? BY_KEY[c.key].label : c.key)))].join(', ')}. On snap-together, peg-and-socket or multi-piece models that usually makes pegs too thick and holes too small, so the pieces no longer fit, even when every piece prints perfectly. Tick “These parts fit together” to keep them exactly as designed, unless you’re sure these parts don’t connect.`,
      keys: fitRisk.map(c => c.key) });
  }
  return { checks: [...fin.problems, ...checks], fixes: fin.fixes };
});

// Append the fixes Snapmaker Orca would otherwise prompt for (or refuse) when the project is opened.
function finalize(changes, plateIndex, rotations) {
  const a = analyzePlate(S.base.project, plateIndex || 1, rotations || {}, { orient: false });
  // Parts that fit together: nothing changes walls, line widths or sizes, whatever proposed it (the AI, a quality
  // preset, a Compare version). This is the one place every save, slice, send and "open in Orca" passes through.
  let kept = [];
  if (S.assembly) { const g = guardFit(changes || [], true); changes = g.kept; kept = g.dropped; }
  const fin = withCompat({ baseSettings: { ...S.base.settings, __converted: S.base.mode === 'converted' }, changes: changes || [], customLayering: a.totals.customLayering, usedSlots: a.totals.extrudersUsed, lib: S.lib, objectCount: a.totals.objectCount });
  if (kept.length) fin.fixes = [...fin.fixes, { key: 'parts fit together', value: 'kept as designed', reason: fitNote(kept) }];
  fin.fitKept = kept;
  return fin;
}

// Several plates, or differently named parts anywhere in the file, mean a multi-piece model.
function projectLooksLikeAssembly(project) {
  if (!project) return false;
  const platesWithParts = (project.plates || []).length;
  const objects = (project.items || []).map(it => ({ name: it.name, parts: it.parts }));
  return platesWithParts > 1 || looksLikeAssembly({ objects });
}

// the "These parts fit together" choice (and the app's own guess), from the window
ipcMain.handle('set-assembly', async (_e, { assembly, guess }) => { S.assembly = !!assembly; S.assemblyGuess = !!guess; return true; });
ipcMain.handle('fit-critical', () => [...FIT_CRITICAL]);

async function sliceVariant(plateIndex, v) {
  try { return await sliceVariantOnce(plateIndex, v); }
  catch (e) {
    logLine('slice failed:', e.message, e.log ? `| ${String(e.log).split(/\r?\n/).filter(l => /\[(error|warning)\]|error/i.test(l)).slice(-4).join(' | ').slice(0, 600)}` : '');
    // a thicker layer height can make a thin detail vanish between layers ("empty layer"): retry this version
    // with the model's own layer height, keeping its other changes
    const layerKeys = ['layer_height', 'initial_layer_print_height'];
    if (!e.failedSlicing || !(v.changes || []).some(c => layerKeys.includes(c.key))) throw e;
    const tried = (v.changes.find(c => c.key === 'layer_height') || {}).value;
    const r = await sliceVariantOnce(plateIndex, { ...v, changes: v.changes.filter(c => !layerKeys.includes(c.key)) });
    const note = `Couldn’t slice with ${tried ? `${tried} mm` : 'these'} layers: this model has a detail too thin for them (it leaves an empty layer), so this version uses the model’s own layer height and keeps its other changes.`;
    return { ...r, corrections: [note, ...(r.corrections || [])], layerFallback: true };
  }
}

async function sliceVariantOnce(plateIndex, v) {
  const fin = finalize(v.changes, plateIndex, v.rotations);
  const built = await Slicer.buildVariantDetailed(S.base.buffer, { changes: fin.changes, rotations: v.rotations || {}, project: S.base.project });
  const cacheKey = JSON.stringify({ file: S.originalHash, slots: S.slots, changes: fin.changes.map(c => [c.key, c.value, c.slot || 0]).sort(), rotations: v.rotations || {}, app: require('./package.json').version });
  const r = await S.slicer.slice(built.buffer, plateIndex, cacheKey);
  const fixes = fin.fixes.map(f => `${f.key.replace(/_/g, ' ')} → ${f.value}: ${f.reason}`);
  return { ...r, corrections: [...new Set([...fixes, ...built.corrections, ...(r.corrections || [])])] };
}

// Recommendations: prepare (slice original, history, images) -> Claude API, or a chat prompt in free mode -> finish.
// the wording for settings left alone because the parts must fit together
const fitNote = (dropped) => `Not changed because these parts must fit together: ${[...new Set(dropped.map(d => (BY_KEY[d.key] ? BY_KEY[d.key].label : d.key).toLowerCase()))].join(', ')}. Changing them can make parts too tight or too loose.`;

function finishRecommendation(ctx, plan) {
  // assemblies: the app itself refuses fit-critical changes, whatever the AI said
  const { kept, dropped } = guardFit(plan.settings || [], ctx.assembly);
  plan = { ...plan, settings: kept };
  if (dropped.length) plan.manual_steps = [...(plan.manual_steps || []), fitNote(dropped)];
  const { rows, unknown } = buildRows(plan, ctx.rChanges, S.base.settings);
  const orientationChoices = [];
  for (const c of plan.orientation_choices || []) {
    const obj = ctx.analysis.objects[c.object_index];
    const opt = obj && (obj.orientationOptions || []).find(o => o.id === c.option_id);
    if (opt && !opt.isCurrent) orientationChoices.push({ itemIndex: obj.itemIndex, objectName: obj.name, option: opt, reason: c.reason });
  }
  return {
    plan: { ...plan, manual_steps: [...(plan.manual_steps || []), ...unknown], risks: plan.risks || [] },
    rows, recipe: { id: ctx.recipe.id, name: ctx.recipe.name, about: ctx.recipe.about }, orientationChoices,
    originalSlice: ctx.originalSlice, sliceError: ctx.sliceError, usedHistory: !!ctx.history,
  };
}

// Free chatbots have smaller limits: keep only the settings they may change and the most telling details.
const CURATED_KEYS = new Set(require('./src/orca-settings').CATALOG.filter(c => c.curated).map(c => c.key));
const onlyCurated = (obj) => obj ? Object.fromEntries(Object.entries(obj).filter(([k]) => CURATED_KEYS.has(k))) : obj;
function compactPayload(p) {
  const analysis = { ...p.analysis, objects: p.analysis.objects.slice(0, 6).map(o => ({ ...o, orientationOptions: (o.orientationOptions || []).slice(0, 3), overrides: onlyCurated(o.overrides) })) };
  const originalSlice = p.originalSlice ? { ...p.originalSlice, gcode: { ...p.originalSlice.gcode, byFeature: p.originalSlice.gcode.byFeature.slice(0, 6) } } : null;
  const history = p.history ? { ...p.history, rated: (p.history.rated || []).slice(0, 6), sameModel: (p.history.sameModel || []).slice(0, 4) } : null;
  return { ...p, analysis, originalSlice, history, settings: { ...p.settings, current: onlyCurated(p.settings.current) } };
}

// Free chatbot mode: write the prompt + images, remember the context until the reply is pasted back.
async function chatHandoff(kind, ctx, system, content) {
  const { text, images } = buildChatPrompt({ kind, system, content });
  const id = `${kind}-${Date.now()}`;
  const folder = path.join(app.getPath('userData'), 'chat-images', id);
  const files = await saveImages(images, folder);
  S.chat = S.chat || {};
  S.chat[id] = { kind, ctx };
  return { chat: true, id, kind, prompt: text, folder, imageCount: files.length, chars: text.length };
}

ipcMain.handle('run-claude', async (_e, args) => { await S.ready;
  if (S.base) assertRightPrinter();
  if (!S.base) throw new Error('Open a .3mf file first.');
  const cfg = await readConfig();
  const chatMode = cfg.aiMode === 'chat';
  const analysis = analyzePlate(S.base.project, args.plateIndex, S.rotations);
  for (const o of analysis.objects) delete o.rotationAffine;
  delete analysis.preview;
  const recipe = recipeFor(args.slider, S.lib);
  const rChanges = recipeChanges(recipe, S.base.settings, S.lib);
  const assembly = typeof args.assembly === 'boolean' ? args.assembly : (projectLooksLikeAssembly(S.base.project) || looksLikeAssembly({ objects: analysis.objects, purpose: args.purpose }));
  S.assembly = assembly;
  // quality presets can differ in walls/line widths between Snapmaker's profiles: not for assemblies
  if (assembly) { const g = guardFit(rChanges, true); rChanges.splice(0, rChanges.length, ...g.kept); }

  let originalSlice = null, sliceError = null;
  if (S.slicer && S.slicer.available) {
    progress('Slicing the original in Snapmaker Orca…');
    S.slicer.setLimitFor((S.base.project.items || []).reduce((n, it) => n + it.meshes.reduce((m, x) => m + x.mesh.triangles.length / 3, 0), 0));
    try { originalSlice = await sliceVariant(args.plateIndex, { changes: [], rotations: S.rotations }); S.lastSlices.original = originalSlice; }
    catch (e) { sliceError = e.message; }
  }
  let history = null;
  const printers = await getPrinters();
  if (printers.some(p => p.url)) {
    progress('Reading print history from your printers…');
    try {
      const { jobs } = FAKE_PRINTER ? { jobs: JSON.parse(await fs.readFile(path.join(FAKE_PRINTER, 'jobs.json'), 'utf8')) } : await fetchJobs(printers);
      history = historyForPrompt(S.printLog.decorate(jobs), path.basename(S.filePath));
    } catch {}
  }
  const thumb = S.original.images.find(i => i.name === `Metadata/plate_${analysis.plateIndex}.png`) || S.original.images.find(i => /plate_\d+\.png$|thumbnail/i.test(i.name));
  const images = [];
  if (thumb && thumb.base64 !== PLACEHOLDER_BASE64) images.push({ label: 'Slicer plate thumbnail', mediaType: thumb.mediaType, base64: thumb.base64 });
  for (const r of args.renders || []) {
    const m = /^data:(image\/\w+);base64,(.+)$/.exec(r.dataUrl);
    if (m) images.push({ label: r.label, mediaType: m[1], base64: m[2] });
  }
  const payload = {
    fileName: path.basename(S.filePath), analysis, settings: settingsSummary({ projectSettings: S.base.settings }),
    slider: args.slider, recipe, recipeChanges: rChanges, materials: args.materials, purpose: args.purpose, images, assembly,
    originalSlice, history, baseNotes: S.base.notes,
  };
  const ctx = { analysis, recipe, rChanges, originalSlice, sliceError, history, slider: args.slider, purpose: args.purpose, assembly };
  if (chatMode) {
    progress('Preparing the prompt for your chatbot…');
    return chatHandoff('recs', ctx, buildSystemPrompt({ compact: true }), buildUserContent(compactPayload(payload)));
  }
  progress('Claude is reviewing the model, slice and settings…');
  const plan = await analyzeWithClaude({ apiKey: await getApiKey(), model: cfg.model || DEFAULT_MODEL, ...payload });
  const out = finishRecommendation(ctx, plan);
  await archiveAnalysis({ kind: 'recs', model: cfg.model || DEFAULT_MODEL, slider: args.slider, purpose: args.purpose, slots: S.slots, rotations: S.rotations, result: out }).catch(e => logLine('archive failed:', e));
  return out;
});

ipcMain.handle('slice-variants', async (_e, { plateIndex, variants }) => { await S.ready;
  if (S.base) assertRightPrinter();
  if (!S.slicer || !S.slicer.available) throw new Error('Set the Snapmaker Orca location in Settings to slice.');
  let done = 0;
  const tris = (S.base.project.items || []).reduce((n, it) => n + it.meshes.reduce((m, x) => m + x.mesh.triangles.length / 3, 0), 0);
  const parallel = S.slicer.setLimitFor(tris);
  progress(`Slicing ${variants.length} variant${variants.length === 1 ? '' : 's'}${parallel > 1 && variants.length > 1 ? ` (${parallel} at a time)` : ''}…`);
  const results = await Promise.all(variants.map(async (v) => {
    try {
      const r = await sliceVariant(plateIndex, v);
      S.lastSlices[v.id] = r;
      progress(`Sliced ${++done} of ${variants.length}`);
      return { id: v.id, ok: true, ...r };
    } catch (e) {
      progress(`Sliced ${++done} of ${variants.length}`);
      return { id: v.id, ok: false, error: e.message };
    }
  }));
  // what each version means for the finished print, compared with the original (from the settings it was sliced with)
  const settingsOf = async (r) => (r && r.gcodePath ? await gcodeSettings(r.gcodePath) : null);
  const origRes = results.find(r => r.id === 'original' && r.ok) || (S.lastSlices.original ? { ...S.lastSlices.original, ok: true } : null);
  const orig = (await settingsOf(origRes)) || S.base.settings;
  for (const r of results) {
    if (!r.ok) continue;
    try { r.look = describe((await settingsOf(r)) || S.base.settings, r.id === 'original' ? null : orig); } catch {}
  }
  return results;
});

// The settings a G-code was sliced with: the slicer writes them in a block at the very end, so only the tail is read.
async function gcodeSettings(file) {
  try {
    const fh = await fs.open(file, 'r');
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, 1_500_000);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      return parseConfigBlock(buf.toString('utf8'));
    } finally { await fh.close(); }
  } catch { return null; }
}

ipcMain.handle('save-3mf', async (_e, { changes, rotations, slider, purpose, plateIndex, variantName, thumbs }) => { await S.ready;
  if (S.base) assertRightPrinter();
  if (!S.base) throw new Error('Open a .3mf file first.');
  // A plain model with no slicer available: wrap it as a U1 project from the bundled template instead of refusing.
  let baseBuffer = S.base.buffer;
  const extra = [];
  if (!Object.keys(S.base.settings || {}).length) {
    baseBuffer = await Slicer.cliReady(S.base.buffer, S.base.project);
    extra.push('This model had no slicer settings, so it was saved as a Snapmaker U1 project using the stock 0.20 mm profile. Check the filament presets in Orca after opening.');
  }
  // the file name says which version it is: "(advisor)" for the recommendations, "(advisor - Fast)" and so on from Compare
  const tag = variantName && !/^(recommended|current|original)$/i.test(variantName) ? ` - ${String(variantName).replace(/\s*(\+.*|recipe)$/i, '').replace(/^Reoriented:\s*/i, '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)}` : '';
  const def = friendlyPath(path.dirname(S.filePath), tag);
  const r = await dialog.showSaveDialog(win, { title: variantName ? `Save “${variantName}” as a 3MF project` : 'Save as a 3MF project', defaultPath: def, filters: [{ name: '3MF project', extensions: ['3mf'] }] });
  if (r.canceled || !r.filePath) return null;
  const fin = finalize(changes, plateIndex, rotations);
  const built = await Slicer.buildVariantDetailed(baseBuffer, { changes: fin.changes, rotations: rotations || {}, project: baseBuffer === S.base.buffer ? S.base.project : null });
  built.buffer = await addPackageThumbnails(built.buffer, thumbs, plateIndex || 1).catch(() => built.buffer);
  built.buffer = await stampPrintName(built.buffer, r.filePath).catch(() => built.buffer);
  await fs.writeFile(r.filePath, built.buffer);
  await S.printLog.addRun({ file: path.basename(r.filePath), modelPath: r.filePath, source: path.basename(S.filePath), changes: fin.changes.map(c => ({ key: c.key, value: c.value, slot: c.slot || null })), rotated: Object.keys(rotations || {}).length, slots: S.slots, slider, purpose });
  return { path: r.filePath, fixes: fin.fixes, corrections: [...extra, ...built.corrections] };
});

ipcMain.handle('save-gcode', async (_e, { variantId, name }) => { await S.ready;
  const s = S.lastSlices[variantId];
  if (!s) throw new Error('Slice that variant first.');
  const vword = /^(original|recommended)$/i.test(String(name || '')) ? '' : ` ${String(name || '').replace(/\s*(\+.*|recipe)$/i, '').replace(/^Reoriented:\s*/i, '').replace(/[\\/:*?"<>|]+/g, ' ').trim()}`;
  const def = friendlyPath(path.dirname(S.filePath), vword, '.gcode');
  const r = await dialog.showSaveDialog(win, { title: 'Save G-code', defaultPath: def, filters: [{ name: 'G-code', extensions: ['gcode'] }] });
  if (r.canceled || !r.filePath) return null;
  await fs.copyFile(s.gcodePath, r.filePath);
  return r.filePath;
});

ipcMain.handle('export-presets', async (_e, { changes, plateIndex, rotations }) => { await S.ready;
  if (!S.base) throw new Error('Open a .3mf file first.');
  const fin = finalize(changes, plateIndex, rotations);
  const files = buildPresets({ projectSettings: S.base.settings }, fin.changes, path.basename(S.filePath).replace(/\.3mf$/i, ''));
  if (!files.length) throw new Error('Select at least one setting to export.');
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder for the preset files', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const written = [];
  for (const f of files) { const out = path.join(r.filePaths[0], f.fileName); await fs.writeFile(out, JSON.stringify(f.json, null, 4)); written.push(out); }
  return { folder: r.filePaths[0], files: written, missingParent: !S.base.settings.print_settings_id };
});

// ---------- sending a print to a U1 ----------
async function printerClients() { return (await getPrinters()).filter(p => p.url).map(p => new U1Printer(p)); }

ipcMain.handle('printers-status', async () => { await S.ready;
  const clients = await printerClients();
  return Promise.all(clients.map(async (c, i) => ({ index: i, name: c.name, url: c.base, ...(await c.status()) })));
});

// Slice the chosen variant if needed and describe the job for the send dialog.
ipcMain.handle('send-prepare', async (_e, { plateIndex, variant }) => { await S.ready;
  if (S.base) assertRightPrinter();
  if (!S.slicer || !S.slicer.available) throw new Error('Set the Snapmaker Orca location in Settings first: sending needs a real slice.');
  let r = S.lastSlices[variant.id];
  if (!r) {
    progress(`Slicing ${variant.name || 'the print'} in Snapmaker Orca…`);
    r = await sliceVariant(plateIndex, variant);
    S.lastSlices[variant.id] = r;
  }
  const ps = S.base.settings || {};
  const types = ps.filament_type || [], colors = ps.filament_colour || [], presets = ps.filament_settings_id || [];
  const fromSlice = (r.filaments || []).map(f => ({ index: Number(f.id) - 1, grams: f.usedGrams || 0, type: f.type }));
  const filaments = (fromSlice.length ? fromSlice : (r.gcode.gramsPerTool || []).map((g, i) => ({ index: i, grams: g })))
    .filter(f => f.grams > 0)
    .map(f => ({ ...f, type: f.type || types[f.index] || 'PLA', color: colors[f.index] || '#888888', preset: presets[f.index] || '' }));
  // the name a voice assistant will read out: "White Voronoi Cat", or "White Voronoi Cat Fast" for a version
  const vword = /^(original|recommended)$/.test(variant.id) ? '' : ` ${String(variant.name || variant.id).replace(/\s*(\+.*|recipe)$/i, '').replace(/^Reoriented:\s*/i, '').trim()}`;
  return { variantId: variant.id, remoteName: safeRemoteName(`${printName()}${vword}`),
    timeSeconds: r.timeSeconds, grams: r.grams, filaments, warnings: r.warnings || [], corrections: r.corrections || [] };
});

ipcMain.handle('send-print', async (_e, { variantId, printerIndex, remoteName, mapTable, prefs, thumbs }) => { await S.ready;
  const r = S.lastSlices[variantId];
  if (!r) throw new Error('Slice this version first.');
  const client = (await printerClients())[printerIndex];
  if (!client) throw new Error('Pick a printer.');
  const st = await client.status();
  if (!st.online) throw new Error(`${client.name} isn’t reachable (${st.error}). Check that it’s on and its address in Settings.`);
  if (/printing|paused/.test(st.state)) throw new Error(`${client.name} is busy (${st.state}${st.filename ? `: ${st.filename}` : ''}). Wait for it to finish, or pick the other printer.`);
  if (!mapTable.length) throw new Error('Map each filament to a toolhead first.');
  // embed U1-sized thumbnails rendered by the app (CLI G-code has none)
  const pngs = (thumbs || []).map(t => ({ w: t.w, h: t.h, base64: String(t.dataUrl).split(',')[1] || '' })).filter(t => t.base64);
  const raw = await fs.readFile(r.gcodePath, 'utf8');
  // never send a job that would print on a cold bed
  const startBlock = raw.slice(0, Math.max(0, raw.indexOf(';LAYER_CHANGE')) || 200000);
  const bedSets = [...startBlock.matchAll(/^M(?:140|190)\b[^\n]*?\bS(\d+(?:\.\d+)?)/gm)].map(m => +m[1]);
  if (bedSets.length && Math.max(...bedSets) === 0) throw new Error('This G-code never heats the bed (0 °C), so the first layer wouldn’t stick. Re-slice it in the app (the plate type is fixed automatically) and try again.');
  const gcode = withThumbnails(raw, pngs);
  const tmp = path.join(app.getPath('temp'), `u1-send-${Date.now()}.gcode`);
  await fs.writeFile(tmp, gcode);
  const name = safeRemoteName(remoteName);
  try {
    let lastPct = -1;
    const remote = await client.upload(tmp, name, (f) => {
      const pct = Math.floor(f * 100);
      if (pct !== lastPct) { lastPct = pct; win.webContents.send('send-progress', { stage: 'upload', pct, label: `Uploading to ${client.name}… ${pct}%` }); }
    });
    win.webContents.send('send-progress', { stage: 'start', pct: 100, label: `Starting the print on ${client.name}…` });
    const res = await client.startPrint(remote, { mapTable, bedLevel: prefs.bedLevel, flowCalibrate: prefs.flowCalibrate, timelapse: prefs.timelapse });
    // keep the exact project that was printed, so a later troubleshooting session can show and paint it
    let modelPath = null;
    try {
      const dir = path.join(app.getPath('userData'), 'sent'); await fs.mkdir(dir, { recursive: true });
      modelPath = path.join(dir, name.replace(/\.gcode$/i, '') + '.3mf');
      await fs.copyFile(r.slicedProjectPath, modelPath);
    } catch { modelPath = null; }
    await S.printLog.addRun({ file: name, modelPath, source: path.basename(S.filePath), printer: client.name, changes: [], sent: true, mapTable, prefs, slots: S.slots });
    return { ok: true, printer: client.name, remote, method: res.method };
  } finally { fs.unlink(tmp).catch(() => {}); }
});

// ---------- crash safety: session, AI answer archive, logging ----------
// Nothing paid for is lost to a crash: every AI answer is archived per file the moment it arrives, the working
// session is saved as the user goes, and a crashed window is reloaded and restored automatically.
const sha1buf = (b) => crypto.createHash('sha1').update(b).digest('hex');
async function writeJsonAtomic(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj));
  await fs.rename(tmp, file); // a crash mid-write leaves the previous version intact
}
const sessionFile = () => path.join(app.getPath('userData'), 'session.json');
const archiveFile = (hash) => path.join(app.getPath('userData'), 'analyses', `${hash}.json`);

async function archiveAnalysis(entry) {
  if (!S.originalHash) return;
  const f = archiveFile(S.originalHash);
  let list = [];
  try { list = JSON.parse(await fs.readFile(f, 'utf8')); } catch {}
  list.unshift({ ...entry, at: new Date().toISOString(), file: path.basename(S.filePath) });
  await writeJsonAtomic(f, list.slice(0, 10));
}
ipcMain.handle('past-analyses', async () => {
  if (!S.originalHash) return [];
  try { return JSON.parse(await fs.readFile(archiveFile(S.originalHash), 'utf8')); } catch { return []; }
});
ipcMain.handle('session-save', async (_e, data) => {
  if (!S.filePath) return false;
  await writeJsonAtomic(sessionFile(), { ...data, version: 1, filePath: S.filePath, fileHash: S.originalHash, savedAt: new Date().toISOString() });
  return true;
});
ipcMain.handle('session-get', async () => {
  let s;
  try { s = JSON.parse(await fs.readFile(sessionFile(), 'utf8')); } catch { return null; }
  if (!s || !s.filePath || !fss.existsSync(s.filePath)) return null;
  try { s.fileChanged = sha1buf(await fs.readFile(s.filePath)) !== s.fileHash; } catch { return null; }
  s.autoRestore = !!S.autoRestore; S.autoRestore = false;
  return s;
});
ipcMain.handle('session-clear', async () => { await fs.unlink(sessionFile()).catch(() => {}); return true; });

const logFile = () => path.join(app.getPath('userData'), 'logs', 'app.log');
function logLine(...parts) {
  try {
    const fsSync = require('fs');
    fsSync.mkdirSync(path.dirname(logFile()), { recursive: true });
    try { if (fsSync.statSync(logFile()).size > 2e6) fsSync.renameSync(logFile(), logFile() + '.old'); } catch {}
    fsSync.appendFileSync(logFile(), `[${new Date().toISOString()}] ${parts.map(p => (p && p.stack) || (typeof p === 'object' ? JSON.stringify(p) : String(p))).join(' ')}\n`);
  } catch {}
}
process.on('uncaughtException', (e) => logLine('uncaught exception:', e));
process.on('unhandledRejection', (e) => logLine('unhandled rejection:', e));
try { require('electron').crashReporter.start({ uploadToServer: false }); } catch {}
app.on('render-process-gone', (_e, wc, details) => {
  logLine('window crashed:', details);
  if (details.reason !== 'clean-exit' && win && !win.isDestroyed() && wc === win.webContents) { S.autoRestore = true; setTimeout(() => win.reload(), 500); }
});
app.on('child-process-gone', (_e, details) => logLine('helper process ended:', details));
ipcMain.handle('open-log-folder', () => shell.openPath(path.dirname(logFile())));

// ---------- finding printers on the network ----------
ipcMain.handle('printers-discover', async () => {
  const { discoverPrinters } = require('./src/discover');
  const found = await discoverPrinters({ onProgress: (done, total, n) => win && win.webContents.send('discover-progress', { done, total, found: n }) });
  return found;
});

// ---------- the G-code name follows the saved file's name ----------
// Snapmaker Orca names the G-code it prints from a template ({input_filename_base}_{filament}_{time}) built from
// where each object originally came from, and some screens show the project's stored title. Renaming the 3MF
// changes neither, so a saved "White Voronoi Cat.3mf" would still print under the original download's name.
// This writes the saved file's name into all three, so the printer (and voice announcements) get the same name.
function gcodeNameFor(filePath) {
  return path.basename(filePath).replace(/\.3mf$/i, '').replace(/\s*\(advisor[^)]*\)\s*$/i, '')
    .replace(/\s+-\s+/g, ' ').replace(/[{}\[\]\\/:*?"<>|;]+/g, ' ').replace(/\s+/g, ' ').trim() || 'My Print';
}
async function stampPrintName(buffer, filePath) {
  const name = gcodeNameFor(filePath);
  const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const zip = await JSZip.loadAsync(buffer);
  // the G-code name template: exactly this name
  const psf = zip.file('Metadata/project_settings.config');
  if (psf) {
    const ps = JSON.parse(await psf.async('string'));
    ps.filename_format = `${name}.gcode`;
    zip.file('Metadata/project_settings.config', JSON.stringify(ps, null, 4));
  }
  // the project title
  const mf = zip.file('3D/3dmodel.model');
  if (mf) {
    let m = await mf.async('string');
    if (/<metadata name="Title">[^<]*<\/metadata>/.test(m)) m = m.replace(/<metadata name="Title">[^<]*<\/metadata>/, `<metadata name="Title">${xml(name)}</metadata>`);
    else m = m.replace(/(<model\b[^>]*>)/, `$1\n <metadata name="Title">${xml(name)}</metadata>`);
    zip.file('3D/3dmodel.model', m);
  }
  // where each object "came from": this file
  const msf = zip.file('Metadata/model_settings.config');
  if (msf) {
    const ms = await msf.async('string');
    if (/key="source_file"/.test(ms)) zip.file('Metadata/model_settings.config', ms.replace(/(<metadata key="source_file" value=")[^"]*(")/g, `$1${xml(filePath)}$2`));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------- file thumbnails ----------
// Windows Explorer (and Finder previews) show a 3MF's "package thumbnail": a picture the file's _rels/.rels
// declares with the standard thumbnail relationship. Bambu/Orca files also declare medium and small cover images.
// Saved files get a render of the model from the app's 3D view in all three, and the shown plate's placeholder
// picture is replaced so the slicer's plate list shows the model too.
async function addPackageThumbnails(buffer, thumbs, plateIndex = 1) {
  const pick = (w) => (thumbs || []).find(t => t.w === w);
  const toBuf = (t) => (t && /^data:image\/png;base64,/.test(t.dataUrl) ? Buffer.from(t.dataUrl.split(',')[1], 'base64') : null);
  const large = toBuf(pick(512)), middle = toBuf(pick(256)) || large, small = toBuf(pick(128)) || middle;
  if (!large) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  zip.file('Auxiliaries/.thumbnails/thumbnail_3mf.png', large);
  zip.file('Auxiliaries/.thumbnails/thumbnail_middle.png', middle);
  zip.file('Auxiliaries/.thumbnails/thumbnail_small.png', small);
  const plateImg = `Metadata/plate_${plateIndex}.png`;
  const existing = zip.file(plateImg) && (await zip.file(plateImg).async('base64'));
  if (!existing || existing === PLACEHOLDER_BASE64) zip.file(plateImg, large);
  // declare them in the package relationships (replacing any older thumbnail entries)
  let rels = zip.file('_rels/.rels') ? await zip.file('_rels/.rels').async('string') : '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  rels = rels.replace(/\s*<Relationship\b[^>]*Type="[^"]*(metadata\/thumbnail|cover-thumbnail-middle|cover-thumbnail-small)"[^>]*\/>/g, '');
  const add = [
    ['/Auxiliaries/.thumbnails/thumbnail_3mf.png', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail'],
    ['/Auxiliaries/.thumbnails/thumbnail_middle.png', 'http://schemas.bambulab.com/package/2021/cover-thumbnail-middle'],
    ['/Auxiliaries/.thumbnails/thumbnail_small.png', 'http://schemas.bambulab.com/package/2021/cover-thumbnail-small'],
  ].map(([t, type], i) => `\n <Relationship Target="${t}" Id="rel-thumb-${i + 1}" Type="${type}"/>`).join('');
  rels = rels.replace(/<\/Relationships>\s*$/, `${add}\n</Relationships>`);
  zip.file('_rels/.rels', rels);
  // PNG must be a declared content type
  let ct = zip.file('[Content_Types].xml') ? await zip.file('[Content_Types].xml').async('string') : '';
  if (ct && !/Extension="png"/i.test(ct)) zip.file('[Content_Types].xml', ct.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------- export for Bambu Lab printers (for sharing on MakerWorld) ----------
// The working U1 version is converted to a Bambu printer with Bambu's own presets, keeping the tuned choices
// (walls, infill, supports, layer height, filament colours), and the final file is written by Bambu Studio
// itself, so it is a genuine Bambu Studio project that MakerWorld accepts.
async function findBambuStudio() {
  const cfg = await readConfig();
  if (cfg.bambuPath && fss.existsSync(cfg.bambuPath)) return cfg.bambuPath;
  const { installedSlicers } = require('./src/profiles');
  const b = installedSlicers().find(x => x.kind === 'bambu-studio');
  return b ? b.exe : null;
}
ipcMain.handle('bambu-info', async () => { await S.ready;
  const exe = await findBambuStudio();
  if (!exe) return { found: false, printers: [] };
  const lib = new ProfileLibrary(exe, { cacheFile: path.join(app.getPath('userData'), 'profile-index-bambu.json') });
  const printers = lib.machineCatalog().filter(p => p.vendor === 'BBL').map(p => p.name);
  return { found: true, exe, printers, label: lib.slicer.label };
});
ipcMain.handle('bambu-locate', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Where is Bambu Studio?', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Bambu Studio', extensions: ['exe'] }] : [] });
  if (r.canceled || !r.filePaths[0]) return null;
  const cfg = await readConfig(); cfg.bambuPath = r.filePaths[0]; await writeConfig(cfg);
  return r.filePaths[0];
});
ipcMain.handle('export-bambu', async (_e, { machine, changes, rotations, plateIndex, variantName, thumbs }) => { await S.ready;
  if (!S.base) throw new Error('Open a model first.');
  assertRightPrinter();
  const exe = await findBambuStudio();
  if (!exe) throw new Error('Bambu Studio isn’t installed (it’s free from bambulab.com). It does the final export so MakerWorld accepts the file.');
  // the version being shared, exactly as it would print on the U1 (fit protection and fixes included)
  const fin = finalize(changes || [], plateIndex, rotations);
  const u1 = await Slicer.buildVariantDetailed(S.base.buffer, { changes: fin.changes, rotations: rotations || {}, project: S.base.project });
  const u1ps = JSON.parse(await (await JSZip.loadAsync(u1.buffer)).file('Metadata/project_settings.config').async('string'));
  const lib = new ProfileLibrary(exe, { machine, cacheFile: path.join(app.getPath('userData'), 'profile-index-bambu.json') });
  const slicer = new Slicer({ exe, lib, workDir: path.join(app.getPath('userData'), 'work-bambu') });
  const usedSlots = [...new Set((S.slots || []).map(x => x.slot))].sort((a, b) => a - b);
  const slots = (S.slots || [{ slot: 1, type: 'PLA' }]).map(x => ({ slot: x.slot, type: x.type, preset: lib.presetForMaterial(x.type) }));
  const saved = getMachine();
  setMachine(lib.machineFacts());
  let out, how;
  try {
    progress(`Converting to the ${lib.machine} with ${lib.slicer.label}…`);
    const proj = await load3mf(u1.buffer);
    let base;
    try { base = await slicer.prepareBase(u1.buffer, proj, slots); how = 'converted by Bambu Studio'; }
    catch (e) { logLine('bambu export: conversion failed, using the built-in converter:', e.message); base = await slicer.nativeConvert(proj, slots, u1ps); how = 'converted by the app, saved by Bambu Studio'; }
    const z = await JSZip.loadAsync(base.buffer);
    const ps = JSON.parse(await z.file('Metadata/project_settings.config').async('string'));
    // keep the U1 version's filament colours, one per filament
    const nFil = Array.isArray(ps.filament_settings_id) ? ps.filament_settings_id.length : 1;
    if (Array.isArray(u1ps.filament_colour)) ps.filament_colour = Array.from({ length: nFil }, (_, i) => u1ps.filament_colour[i] || (Array.isArray(ps.filament_colour) ? ps.filament_colour[Math.min(i, ps.filament_colour.length - 1)] : '#FFFFFF'));
    // every per-filament list must have one entry per filament (Bambu Studio's conversion can leave some at one,
    // and then refuses to slice once there are two colours)
    for (const [k, v] of Object.entries(ps)) {
      if (!Array.isArray(v) || !v.length || v.length >= nFil) continue;
      if (!/^filament_|^default_filament_colour$/.test(k)) continue;
      ps[k] = Array.from({ length: nFil }, (_, i) => v[Math.min(i, v.length - 1)]);
    }
    // the purge table between filaments must be exactly filaments × filaments (Bambu Studio fails writing the
    // G-code otherwise); keep the existing values for the filaments in use
    if (Array.isArray(ps.flush_volumes_matrix)) {
      const m = Math.round(Math.sqrt(ps.flush_volumes_matrix.length)), old = ps.flush_volumes_matrix;
      ps.flush_volumes_matrix = [];
      for (let i = 0; i < nFil; i++) for (let j = 0; j < nFil; j++) ps.flush_volumes_matrix.push(i === j ? '0' : (i < m && j < m ? old[i * m + j] : '280'));
    }
    if (Array.isArray(ps.flush_volumes_vector)) ps.flush_volumes_vector = Array.from({ length: nFil * 2 }, (_, i) => ps.flush_volumes_vector[Math.min(i, ps.flush_volumes_vector.length - 1)]);
    // the same safety fixes as for the U1, now with the Bambu printer's facts: e.g. a plate type the filaments
    // support (PETG isn't allowed on Cool Plate, which would leave the bed cold)
    const ba = analyzePlate(await load3mf(base.buffer), plateIndex || 1, {}, { orient: false });
    const bfix = withCompat({ baseSettings: { ...ps, __converted: true }, usedSlots: ba.totals.extrudersUsed, objectCount: ba.totals.objectCount });
    applyChanges(ps, bfix.changes);
    z.file('Metadata/project_settings.config', JSON.stringify(ps, null, 4));
    await Slicer.plateBedTypes(z);
    progress('Saving it with Bambu Studio…');
    out = await slicer.exportRoundTrip(await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  } finally { setMachine(saved); }
  out = await addPackageThumbnails(out, thumbs, plateIndex || 1).catch(() => out);
  const short = lib.machine.replace(/^Bambu Lab\s+/, '').replace(/\s+[\d.]+ nozzle$/, '');
  const r = await dialog.showSaveDialog(win, { title: `Save the ${short} version`, defaultPath: friendlyPath(path.dirname(S.filePath), ` - Bambu ${short}`), filters: [{ name: '3MF project', extensions: ['3mf'] }] });
  if (r.canceled || !r.filePath) return null;
  out = await stampPrintName(out, r.filePath).catch(() => out);
  await fs.writeFile(r.filePath, out);
  const oz = await JSZip.loadAsync(out);
  const model = await oz.file('3D/3dmodel.model').async('string');
  const application = (/<metadata name="Application">([^<]*)</.exec(model) || [])[1] || null;
  const printer = JSON.parse(await oz.file('Metadata/project_settings.config').async('string')).printer_settings_id;
  return { path: r.filePath, machine: lib.machine, how, application, printer };
});

// ---------- filament inventory and colour remix ----------
const Inv = require('./src/inventory');
const Remix = require('./src/remix');
const { findPatches } = require('./src/patches');
const Parts = require('./src/parts');
const GcodeCompat = require('./src/gcodecompat');
const { FilamentStore } = require('./src/filament');
const Fil = new FilamentStore(app.getPath('userData'));
// The filaments Color remix and the shopping check choose from: what's on hand on the Filament screen.
async function inventory() {
  return Fil.stock() || { ok: false, error: 'You haven’t added any filament yet. Open Filament (top right) to add yours.' };
}
ipcMain.handle('inventory-status', async () => {
  const own = Fil.stock();
  if (!own) return { set: false };
  return { set: true, builtin: true, ok: true, onHand: true, updated: own.updated, count: own.filaments.length, spools: own.filaments.reduce((t, f) => t + (f.spools || 0), 0) };
});

// ---------- the Filament screen (renderer/filament/) ----------
ipcMain.handle('filament-load', async () => {
  const cfg = await readConfig();
  return { ...Fil.load(), imagesBase: 'app://filament/images/', hasKey: !!(await getApiKey()),
    printers: (cfg.printers || []).map(p => p.name).filter(Boolean) };
});
ipcMain.handle('filament-save', (_e, data) => Fil.save(data));
ipcMain.handle('filament-has-key', async () => !!(await getApiKey()));
ipcMain.handle('filament-open-folder', async () => { await fs.mkdir(Fil.backupsDir, { recursive: true }); return shell.openPath(Fil.backupsDir); });
// Claude for the Filament screen (reading screenshots, finding product pages). The screen builds the request;
// the key is added here and never goes to the page.
ipcMain.handle('filament-claude', async (_e, body) => {
  const key = await getApiKey();
  if (!key) throw new Error('Add your Anthropic API key in Settings first (the gear at the top right).');
  const { betas, ...rest } = body || {};
  if (!rest.model || !Array.isArray(rest.messages)) throw new Error('Bad request.');
  rest.max_tokens = Math.min(+rest.max_tokens || 16000, 32000);
  const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  if (Array.isArray(betas) && betas.length) headers['anthropic-beta'] = betas.join(',');
  let res;
  try { res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(rest), signal: AbortSignal.timeout(10 * 60 * 1000) }); }
  catch (e) { throw new Error(e.name === 'TimeoutError' ? 'Claude took too long to answer. Try again.' : 'Couldn’t reach Anthropic. Check your internet connection.'); }
  const data = await res.json().catch(() => null);
  if (res.ok && data) { Spend.record(data, rest.model); return data; }
  const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
  logLine(`filament: Claude request failed (${res.status}): ${msg}`);
  if (res.status === 401) throw new Error('Anthropic didn’t accept the API key. Check it in Settings.');
  if (res.status === 403) throw new Error('This API key isn’t allowed to use Claude. Check it in the Anthropic Console.');
  if (res.status === 429) throw new Error('Anthropic is limiting requests on this key right now. Wait a minute and try again.');
  if (res.status === 529 || res.status >= 500) throw new Error('Anthropic is busy right now. Try again in a minute.');
  if (res.status === 400 && /credit|balance|billing/i.test(msg)) throw new Error(`Your Anthropic account needs credits: ${msg}`);
  throw new Error(`Anthropic turned the request down: ${msg}`);
});
// A web page or image for the Filament screen, fetched here (no browser CORS limits): a store's product data
// (Shopify's /products/<name>.js) or its product photo. https only, size-limited. Uses Chromium's network stack
// (Windows certificates and proxy settings, like a browser). Stores briefly refuse bursts of requests (429), so
// those are retried after a pause.
ipcMain.handle('filament-fetch', async (_e, { url, as }) => {
  let u; try { u = new URL(url); } catch { throw new Error('Bad address.'); }
  if (u.protocol !== 'https:') throw new Error('Only https addresses can be fetched.');
  let res;
  const accept = as === 'image' ? 'image/*' : as === 'text' ? 'text/html' : 'application/json';
  for (let attempt = 0; ; attempt++) {
    res = await net.fetch(u.href, { headers: { accept }, signal: AbortSignal.timeout(20000) });
    if (res.status !== 429 || attempt === 2) break;
    // the store says how long to wait (Retry-After, seconds); at most 20 s so the window doesn't hang
    const after = Number(res.headers.get('retry-after'));
    await new Promise(r => setTimeout(r, Math.min(20, Number.isFinite(after) && after > 0 ? after : 3 * (attempt + 1)) * 1000));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 15 * 1024 * 1024) throw new Error('Too large.');
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (as === 'image') {
    if (!/^image\//.test(type)) throw new Error('Not an image.');
    return { type, base64: buf.toString('base64') };
  }
  if (as === 'text') return buf.toString('utf8').slice(0, 2_000_000);
  return JSON.parse(buf.toString('utf8'));
});

// Color remix, step 1: cut the plate into patches along its grooves; the window shows them, the AI groups them
// into named parts, the user checks and corrects them. Parts confirmed before for this shape come back as they were.
const partsDir = () => path.join(app.getPath('userData'), 'parts');
ipcMain.handle('remix-prepare', async (_e, { plateIndex, detail }) => { await S.ready;
  if (!S.base) throw new Error('Open a model first.');
  const inv = await inventory();
  if (!inv.ok) throw new Error(inv.error);
  // the version shown in the 3D view (converted for your printer when a slicer is set up), so labels match the
  // preview triangle for triangle, and painting it keeps the conversion
  const proj = S.base.project;
  plateIndex = plateIndex || 1;
  const a = analyzePlate(proj, plateIndex, {}, { orient: false });
  const items = a.objects.map(o => proj.items[o.itemIndex]);
  const t0 = Date.now();
  const pat = findPatches(items, { target: detail || 80 });
  if (!pat) throw new Error('This plate has no printable parts to colour.');
  logLine(`remix: ${pat.regions.length} patches in ${Date.now() - t0} ms`);
  const key = Parts.geomKey(items, plateIndex);
  let saved = Parts.load(partsDir(), key);
  if (saved && [...pat.labels].some(([k, lab]) => !saved.labels.has(k) || saved.labels.get(k).length !== lab.length)) saved = null;
  S.remix = { plateIndex, patches: pat, items, key, inv, variations: [], base: S.base.buffer, parts: null };
  const cfg = await readConfig();
  const model = cfg.model || DEFAULT_MODEL;
  return { patches: pat.regions, patchLabels: Object.fromEntries(pat.labels), kinds: Parts.KINDS,
    saved: saved ? { subject: saved.subject, parts: saved.parts.filter(p => !(p.kind === 'pupil' && p.auto)), labels: Object.fromEntries(saved.labels), pupils: saved.pupils, savedAt: saved.saved } : null,
    identifyCost: Parts.estimateCost({ model, patches: pat.regions.length }), model,
    inventory: { onHand: inv.onHand, count: inv.filaments.length, note: inv.note },
    maxColors: getMachine().extruders || 4, hasKey: !!(await getApiKey()), aiMode: cfg.aiMode || 'api' };
});
// AI proposes: which patches make up which part
ipcMain.handle('parts-identify', async (_e, { images, hint }) => { await S.ready;
  if (!S.remix) throw new Error('Open Color remix again.');
  const key = await getApiKey();
  if (!key) throw new Error('Identifying parts needs a Claude API key (Settings).');
  const cfg = await readConfig();
  progress('Identifying the parts of the model…');
  const r = await Parts.identify({ apiKey: key, model: cfg.model || DEFAULT_MODEL, images, patches: S.remix.patches.regions, modelName: printName(), hint });
  logLine(`remix: parts "${r.subject}": ${r.parts.map(p => `${p.name} (${p.kind})`).join(', ')}`);
  return r;
});
// The user confirmed the parts: add pupils, measure each part, remember them for this shape.
ipcMain.handle('parts-confirm', async (_e, { subject, parts, labels, pupils }) => { await S.ready;
  if (!S.remix) throw new Error('Open Color remix again.');
  const L = new Map(Object.entries(labels).map(([k, v]) => [k, Uint16Array.from(v)]));
  parts = (parts || []).map(p => ({ ...p }));
  Parts.clearAutoPupils(L, parts);
  parts = parts.filter(p => !(p.kind === 'pupil' && p.auto));
  const used = new Set(); for (const lab of L.values()) for (const v of lab) used.add(v);
  const hasOwnPupils = parts.some(p => p.kind === 'pupil' && used.has(p.id));
  // remembered as the user left them (pupils are worked out again each time)
  try { Parts.save(partsDir(), S.remix.key, { subject, parts: parts.map(p => ({ ...p })), labels: L, pupils }); } catch (e) { logLine(`remix: couldn't save parts: ${e.message}`); }
  const pupilsAdded = pupils && !hasOwnPupils ? Parts.addPupils(S.remix.items, L, parts) : 0;
  const regions = Parts.partStats(S.remix.items, L, parts);
  if (!regions.length) throw new Error('No parts left to colour.');
  S.remix.parts = { subject, regions, labels: L };
  S.remix.variations = [];
  const cfg = await readConfig();
  const model = cfg.model || DEFAULT_MODEL;
  const estimates = Object.fromEntries(Array.from({ length: 12 }, (_, i) => i + 1).map(n => [n, Remix.estimateCost({ model, regions: regions.length, filaments: S.remix.inv.filaments.length, count: n })]));
  return { regions, parts, labels: Object.fromEntries(L), pupilsAdded, estimates };
});

ipcMain.handle('remix-run', async (_e, { styles, custom, extras, material, images }) => { await S.ready;
  styles = (styles || []).filter(x => x.count > 0);
  const count = styles.reduce((t, x) => t + x.count, 0);
  if (!count) throw new Error('Choose at least one style.');
  if (!S.remix) throw new Error('Open Color remix again.');
  if (!S.remix.parts) throw new Error('Confirm the parts first.');
  const cfg = await readConfig();
  const key = await getApiKey();
  if (!key) throw new Error('Color remix needs a Claude API key (Settings).');
  const { inv } = S.remix, seg = S.remix.parts;
  const M = getMachine();
  const maxColors = M.extruders || 4;
  const pool = material && material !== 'any' ? inv.filaments.filter(f => Remix.family(f.type) === material) : inv.filaments;
  if (!pool.length) throw new Error('No filaments of that material are on hand.');
  progress(`Designing ${count} colour scheme${count === 1 ? '' : 's'}…`);
  const answer = await Remix.runRemix({ apiKey: key, model: cfg.model || DEFAULT_MODEL, styles, custom, count, maxColors, extras, material: material || 'any',
    regions: seg.regions, filaments: Inv.forPrompt(pool), images, modelName: printName(), subject: seg.subject });
  const variations = Remix.finalizeVariations(answer, { regions: seg.regions, inventory: pool, maxColors, extras });
  S.remix.variations = variations;
  logLine(`remix: ${styles.map(x => `${x.id}×${x.count}`).join(', ')}, ${variations.length} variations`);
  return { subject: answer.subject || '', variations: variations.map(v => ({ ...v, tools: v.tools.map(t => ({ tool: t.tool, from: t.from, fid: t.fid, name: `${t.filament.brand} ${t.filament.line} ${t.filament.color}`.replace(/\s+/g, ' '), color: t.filament.color, type: t.filament.type, finish: t.filament.finish, hex: Inv.mainHex(t.filament), spools: t.filament.spools, remainingG: t.filament.remainingG })) })) };
});

// Paint the chosen scheme into the model; the window then sets the toolheads and prepares it as usual.
ipcMain.handle('remix-apply', async (_e, { index }) => { await S.ready;
  const v = S.remix && S.remix.variations[index];
  if (!v) throw new Error('That scheme is no longer available. Generate again.');
  progress('Painting the colours into the model…');
  const regionTool = new Map();
  for (const [rid, fid] of Object.entries(v.assign)) {
    const t = v.tools.filter(x => x.fid === fid).sort((a, b) => b.from - a.from)[0];
    if (t) regionTool.set(+rid, t.tool);
  }
  const before = { buffer: S.originalBuffer, project: S.original, hash: S.originalHash };
  if (S.remix.base !== S.base.buffer) throw new Error('The model changed since the color regions were made. Close Color remix and open it again.');
  // paint the shown version and make it the model from now on (it's already set up for your printer)
  const out = await Remix.paintModel(S.base.buffer, S.remix.parts.labels, regionTool, v.pauses, S.remix.plateIndex);
  S.remixUndo = S.remixUndo || before;
  S.originalBuffer = out;
  S.original = await load3mf(out);
  S.originalHash = crypto.createHash('sha1').update(out).digest('hex');
  S.lastSlices = {};
  // toolheads: the filament that starts each toolhead, with its own preset when Snapmaker Orca has it
  const slots = v.tools.filter(t => !t.from).map(t => {
    const f = t.filament;
    const preset = f.preset && S.lib && S.lib.byType && S.lib.byType.filament.has(f.preset) ? f.preset : (S.lib ? S.lib.presetForMaterial(f.type) : null);
    return { slot: t.tool, type: f.type, preset, color: Inv.mainHex(f).toUpperCase(), name: `${f.brand} ${f.line} ${f.color}`.replace(/\s+/g, ' ') };
  });
  const swaps = v.pauses.map(p => `At ${p.z} mm the printer pauses: swap T${p.tool} (${p.from.brand} ${p.from.color}) for ${p.to.brand} ${p.to.color}, then resume.`);
  return { slots, swaps, name: v.name };
});
ipcMain.handle('remix-undo', async () => { await S.ready;
  if (!S.remixUndo) return false;
  S.originalBuffer = S.remixUndo.buffer; S.original = S.remixUndo.project; S.originalHash = S.remixUndo.hash; S.remixUndo = null; S.lastSlices = {};
  return true;
});

// ---------- buying the colours a model was designed with ----------
const Shop = require('./src/shopping');
ipcMain.handle('shopping-check', async (_e, { slots }) => {
  const cfg = await readConfig();
  if (!Fil.stock()) return { set: false };   // no filament yet: the check stays hidden
  const inv = await inventory();
  if (!inv.ok) return { set: true, ok: false, error: inv.error };
  const rows = Shop.check(slots || [], inv.filaments);
  const model = cfg.model || DEFAULT_MODEL;
  const missing = rows.filter(r => r.status !== 'have').length;
  return { set: true, ok: true, onHand: inv.onHand, rows, findCost: missing ? Shop.findCost(missing, model) : null, hasKey: !!(await getApiKey()), model };
});
ipcMain.handle('shopping-find', async (_e, { rows }) => {
  const cfg = await readConfig();
  const key = await getApiKey();
  const inv = await inventory();
  const brands = inv.ok ? [...new Set(inv.filaments.map(f => f.brand).filter(Boolean))].slice(0, 12) : [];
  progress('Searching the web for matching filaments…');
  const r = await Shop.findProducts({ apiKey: key, model: cfg.model || DEFAULT_MODEL, items: rows, brands });
  logLine(`shopping: ${rows.length} colours, ${r.searches} web searches`);
  return r;
});

// ---------- print names: short, speakable names for saved and sent files ----------
const namesFile = () => path.join(app.getPath('userData'), 'print-names.json');
async function readNames() { try { return JSON.parse(await fs.readFile(namesFile(), 'utf8')); } catch { return {}; } }
async function rememberName(hash, entry) { const all = await readNames(); all[hash] = entry; await writeJsonAtomic(namesFile(), all).catch(() => {}); }
function printName() { return (S.printName && S.printName.name) || heuristicName(path.basename(S.filePath || 'My Print')); }
// a file name for this model in a folder, never the original file itself
function friendlyPath(dir, suffix = '', ext = '.3mf') {
  let p = path.join(dir, `${printName()}${suffix}${ext}`);
  if (S.filePath && path.resolve(p) === path.resolve(S.filePath)) p = path.join(dir, `${printName()}${suffix} (advisor)${ext}`);
  return p;
}
// Called when a file opens: a cleaned-up name right away, then (with an API key) a short AI-made name in the
// background, remembered per file. A name the user typed always wins.
async function setupPrintName() {
  const hash = S.originalHash, cached = (await readNames())[hash];
  S.printName = cached || { name: heuristicName(path.basename(S.filePath)), source: 'file' };
  if (win && !win.isDestroyed()) win.webContents.send('print-name', S.printName);
  if (cached && cached.source !== 'file') return;
  const cfg = await readConfig();
  const key = cfg.aiMode !== 'chat' ? await getApiKey() : '';
  if (!key) return;
  try {
    const thumb = (S.original.images || []).find(i => /plate_1\.png$/.test(i.name)) || (S.original.images || []).find(i => /\.png$/.test(i.name) && !/pick|top|no_light/.test(i.name));
    const colors = (S.original.projectSettings || {}).filament_colour;
    const name = await aiName({ apiKey: key, fileName: path.basename(S.filePath), objectNames: (S.original.items || []).map(i => i.name).filter(Boolean),
      mainColor: Array.isArray(colors) ? colors[0] : colors, image: thumb && thumb.base64 !== PLACEHOLDER_BASE64 ? { mediaType: thumb.mediaType, base64: thumb.base64 } : null });
    if (!name || S.originalHash !== hash || (S.printName && S.printName.source === 'user')) return;
    S.printName = { name, source: 'ai' };
    await rememberName(hash, S.printName);
    if (win && !win.isDestroyed()) win.webContents.send('print-name', S.printName);
  } catch (e) { logLine('naming failed:', e.message); }
}
ipcMain.handle('print-name', () => S.printName || null);
ipcMain.handle('set-print-name', async (_e, name) => {
  const { tidy } = require('./src/naming');
  const n = tidy(name);
  if (!n) return S.printName;
  S.printName = { name: n, source: 'user' };
  if (S.originalHash) await rememberName(S.originalHash, S.printName);
  return S.printName;
});

// ---------- File menu: session files ----------
// A session file (.aipsession) is a zip holding everything needed to pick up later, even on another computer
// or after the model was moved: the model itself, the working state (toolheads, orientation, slider, notes,
// recommendations with the user's edits, compared versions) and every AI answer for this model.
const SESSION_EXT = 'aipsession';
async function recentSessions() { const cfg = await readConfig(); return (cfg.recentSessions || []).filter(p => fss.existsSync(p)); }
async function rememberSession(p) {
  const cfg = await readConfig();
  cfg.recentSessions = [p, ...(cfg.recentSessions || []).filter(x => x !== p)].slice(0, 10);
  await writeConfig(cfg);
  buildMenu();
}

ipcMain.handle('session-export', async (_e, { data, saveAs }) => { await S.ready;
  if (!S.filePath || !S.originalBuffer) throw new Error('Open a model first.');
  let target = !saveAs && S.sessionFile ? S.sessionFile : null;
  if (!target) {
    const stem = path.basename(S.filePath).replace(/\.3mf$/i, '').replace(/\s*\(advisor[^)]*\)\s*$/i, '');
    const r = await dialog.showSaveDialog(win, { title: 'Save session', defaultPath: path.join(path.dirname(S.filePath), `${printName()} session.${SESSION_EXT}`), filters: [{ name: 'AI 3D Print Advisor session', extensions: [SESSION_EXT] }] });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  const zip = new JSZip();
  zip.file('session.json', JSON.stringify({ format: 1, app: require('./package.json').version, savedAt: new Date().toISOString(), fileName: path.basename(S.filePath), filePath: S.filePath, fileHash: S.originalHash, state: data }, null, 1));
  zip.file(`model/${path.basename(S.filePath)}`, S.originalBuffer);
  let analyses = [];
  try { analyses = JSON.parse(await fs.readFile(archiveFile(S.originalHash), 'utf8')); } catch {}
  zip.file('analyses.json', JSON.stringify(analyses));
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  await fs.rename(tmp, target); // never leave a half-written session over a good one
  S.sessionFile = target;
  await rememberSession(target);
  return { path: target, name: path.basename(target) };
});

ipcMain.handle('session-import', async (_e, file) => { await S.ready;
  if (!file) {
    const r = await dialog.showOpenDialog(win, { title: 'Open session', filters: [{ name: 'AI 3D Print Advisor session', extensions: [SESSION_EXT] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    file = r.filePaths[0];
  }
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const meta = JSON.parse(await zip.file('session.json').async('string'));
  const modelEntry = Object.values(zip.files).find(f => f.name.startsWith('model/') && !f.dir);
  if (!meta || !modelEntry) throw new Error('This isn’t a valid session file.');
  const model = await modelEntry.async('nodebuffer');
  const hash = sha1buf(model);
  // use the original file if it's still there and unchanged (so saves land next to it), else the copy inside the session
  let modelPath = meta.filePath;
  let usingCopy = false;
  try { if (!fss.existsSync(modelPath) || sha1buf(await fs.readFile(modelPath)) !== hash) throw 0; } catch {
    const dir = path.join(app.getPath('userData'), 'sessions', hash.slice(0, 12));
    await fs.mkdir(dir, { recursive: true });
    modelPath = path.join(dir, meta.fileName);
    await fs.writeFile(modelPath, model);
    usingCopy = true;
  }
  // bring the session's AI answers into this computer's archive, so they can be reused for free
  try {
    const incoming = JSON.parse(await zip.file('analyses.json').async('string'));
    let mine = [];
    try { mine = JSON.parse(await fs.readFile(archiveFile(hash), 'utf8')); } catch {}
    const seen = new Set(mine.map(a => a.at));
    const merged = [...mine, ...incoming.filter(a => !seen.has(a.at))].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20);
    await writeJsonAtomic(archiveFile(hash), merged);
  } catch {}
  S.pendingSessionFile = file;
  await rememberSession(file);
  return { filePath: modelPath, usingCopy, originalPath: meta.filePath, savedAt: meta.savedAt, state: meta.state, name: path.basename(file) };
});
// the renderer confirms once the session's model is open, so Save Session writes back to that file
ipcMain.handle('session-opened', async () => { S.sessionFile = S.pendingSessionFile || null; S.pendingSessionFile = null; return true; });
ipcMain.handle('session-forget-file', async () => { S.sessionFile = null; return true; });
ipcMain.handle('recent-sessions', () => recentSessions());

// ---------- the menu bar ----------
async function buildMenu() {
  const { Menu } = require('electron');
  const send = (action, arg) => () => win && win.webContents.send('menu', { action, arg });
  const recent = await recentSessions().catch(() => []);
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Open Model…', accelerator: 'CmdOrCtrl+O', click: send('open-model') },
      { label: 'Open Session…', accelerator: 'CmdOrCtrl+Shift+O', click: send('open-session') },
      { label: 'Open Recent Session', submenu: recent.length ? [...recent.map(p => ({ label: path.basename(p), click: send('open-session', p) })), { type: 'separator' }, { label: 'Clear List', click: async () => { const cfg = await readConfig(); cfg.recentSessions = []; await writeConfig(cfg); buildMenu(); } }] : [{ label: 'No recent sessions', enabled: false }] },
      { type: 'separator' },
      { label: 'Save Session', accelerator: 'CmdOrCtrl+S', click: send('save-session') },
      { label: 'Save Session As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-session-as') },
      { type: 'separator' },
      { label: 'Save Model as 3MF…', click: send('save-3mf') },
      { label: 'Export for Bambu Lab Printers…', click: send('export-bambu') },
      { label: 'Batch Convert to U1…', accelerator: 'CmdOrCtrl+Shift+B', click: send('batch') },
      { label: 'Close Model', accelerator: 'CmdOrCtrl+W', click: send('close-model') },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
      ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Exit' }]),
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [
      { label: 'Step-by-Step Guide', click: send('guide') },
      { label: 'User Guide (online)', click: () => shell.openExternal('https://github.com/jtroberts83/AI-Print-Advisor-Studio#readme') },
      { label: 'Troubleshooting (online)', click: () => shell.openExternal('https://github.com/jtroberts83/AI-Print-Advisor-Studio/blob/main/docs/TROUBLESHOOTING.md') },
      { label: 'Report a Problem…', click: () => shell.openExternal('https://github.com/jtroberts83/AI-Print-Advisor-Studio/issues/new/choose') },
      { type: 'separator' },
      { label: 'Open Log Folder', click: () => shell.openPath(path.dirname(logFile())) },
      { label: `About AI 3D Print Advisor Studio ${require('./package.json').version}`, enabled: false },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- open in Snapmaker Orca ----------
// Writes "<name> (advisor).3mf" next to the original, launches a new Snapmaker Orca window with it, and watches
// the file so edits saved in Orca can be reloaded here.
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
function orcaTargetPath(src) {
  const dir = path.dirname(src);
  const stem = path.basename(src).replace(/\.3mf$/i, '').replace(/\s*\(advisor(?: \d+)?\)\s*$/i, '');
  return path.join(dir, `${stem} (advisor).3mf`);
}
function nextFreeCopy(p) {
  for (let n = 2; n < 100; n++) { const q = p.replace(/(\s*\(advisor\))?\.3mf$/i, ` ${n}$1.3mf`); if (!fss.existsSync(q)) return q; }
  return p.replace(/\.3mf$/i, ` ${Date.now()}.3mf`);
}

function watchOrcaFile(file, writtenHash) {
  if (S.orcaWatch && S.orcaWatch.file !== file) fss.unwatchFile(S.orcaWatch.file);
  // written: what the advisor last wrote or reloaded (anything else on disk is Orca's edit and is protected);
  // seen: what was last noticed on disk (so one save gives one notice)
  S.orcaWatch = { file, written: writtenHash, seen: writtenHash, pending: null };
  fss.unwatchFile(file);
  fss.watchFile(file, { interval: 1500 }, (cur, prev) => {
    if (!cur.mtimeMs || cur.mtimeMs === prev.mtimeMs) return;
    clearTimeout(S.orcaWatch.pending);
    // Orca writes in steps; wait until the file has settled before comparing
    S.orcaWatch.pending = setTimeout(async () => {
      try {
        const h = sha1(await fs.readFile(file));
        if (h === S.orcaWatch.seen) return;
        S.orcaWatch.seen = h;
        if (h !== S.orcaWatch.written && win && !win.isDestroyed()) win.webContents.send('orca-file-changed', { file, name: path.basename(file) });
      } catch {}
    }, 2500);
  });
}

ipcMain.handle('open-in-orca', async (_e, { changes, rotations, plateIndex, variantName, thumbs }) => { await S.ready;
  if (S.base) assertRightPrinter();
  if (!S.base) throw new Error('Open a .3mf file first.');
  const exe = S.slicer && S.slicer.exe;
  if (!exe || !fss.existsSync(exe)) throw new Error('Set the Snapmaker Orca location in Settings first.');
  let baseBuffer = S.base.buffer;
  if (!Object.keys(S.base.settings || {}).length) baseBuffer = await Slicer.cliReady(S.base.buffer, S.base.project);
  const fin = finalize(changes || [], plateIndex, rotations);
  const built = await Slicer.buildVariantDetailed(baseBuffer, { changes: fin.changes, rotations: rotations || {}, project: baseBuffer === S.base.buffer ? S.base.project : null });
  let target = friendlyPath(path.dirname(S.filePath));
  const inPlace = path.resolve(target) === path.resolve(S.filePath);
  // don't overwrite edits made in Orca since the advisor last wrote this file
  if (fss.existsSync(target) && !inPlace) {
    const onDisk = sha1(await fs.readFile(target));
    const ours = S.orcaWatch && S.orcaWatch.file === target ? S.orcaWatch.written : null;
    if (onDisk !== ours) {
      const c = await dialog.showMessageBox(win, { type: 'question', buttons: ['Replace it', 'Save a new copy', 'Cancel'], defaultId: 1, cancelId: 2,
        title: 'Open in Snapmaker Orca', message: `${path.basename(target)} already exists and may have edits made in Orca.`,
        detail: 'Replace it with the advisor’s version, or save the advisor’s version as a new copy next to it?' });
      if (c.response === 2) return null;
      if (c.response === 1) target = nextFreeCopy(target);
    }
  }
  built.buffer = await addPackageThumbnails(built.buffer, thumbs, plateIndex || 1).catch(() => built.buffer);
  built.buffer = await stampPrintName(built.buffer, target).catch(() => built.buffer);
  await fs.writeFile(target, built.buffer);
  watchOrcaFile(target, sha1(built.buffer));
  const child = spawn(exe, [target], { detached: true, stdio: 'ignore', windowsHide: false, cwd: path.dirname(exe) });
  child.on('error', () => {});
  child.unref();
  await S.printLog.addRun({ file: path.basename(target), modelPath: target, source: path.basename(S.filePath), changes: fin.changes.map(c => ({ key: c.key, value: c.value, slot: c.slot || null })), openedInOrca: true, variant: variantName || null, slots: S.slots });
  return { path: target, fixes: fin.fixes.length + built.corrections.length, singleInstance: orcaSingleInstance() };
});

// the reloaded Orca file is now in sync with what's on disk
ipcMain.handle('orca-reloaded', async (_e, file) => {
  try { if (S.orcaWatch && S.orcaWatch.file === file) S.orcaWatch.written = S.orcaWatch.seen = sha1(await fs.readFile(file)); } catch {}
  return true;
});

// ---------- print issue troubleshooter ----------
const stemOf = (f) => String(f || '').split(/[\\/]/).pop().replace(/\.(gcode|3mf)$/i, '').replace(/_plate_\d+$/i, '').replace(/\s*\((advisor|recommended|original|[a-z]+ recipe)\)\s*$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

ipcMain.handle('ts-open', async (_e, { jobId }) => { await S.ready;
  const job = (S.lastJobs || []).find(j => j.id === jobId);
  if (!job) throw new Error('Refresh the print history and try again.');
  let modelPath = job.run && job.run.modelPath && fss.existsSync(job.run.modelPath) ? job.run.modelPath : null;
  if (!modelPath && S.filePath && stemOf(S.filePath) && stemOf(job.filename).includes(stemOf(S.filePath))) modelPath = S.filePath;
  return { job, modelPath, issues: ISSUES };
});
ipcMain.handle('ts-pick-model', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open the model you printed', filters: [{ name: '3MF project', extensions: ['3mf'] }], properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('ts-load', async (_e, { jobId, modelPath }) => { await S.ready;
  const job = (S.lastJobs || []).find(j => j.id === jobId);
  if (!job) throw new Error('Refresh the print history and try again.');
  S.ts = { job, gcode: null, gcodeError: null, project: null, analysis: null, modelPath };
  // the G-code that was printed, straight from the printer (cached)
  const pconf = (await getPrinters()).find(p => p.name === job.printer);
  if (pconf) {
    const dir = path.join(app.getPath('userData'), 'gcode-cache'); await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, crypto.createHash('sha1').update(`${job.printer}|${job.filename}|${job.start}`).digest('hex') + '.gcode');
    try {
      if (!fss.existsSync(file)) {
        progress('Downloading the printed G-code from the printer…');
        if (FAKE_PRINTER) await fs.copyFile(path.join(FAKE_PRINTER, path.basename(job.filename)), file);
        else await new U1Printer(pconf).download(job.filename, file);
      }
      S.ts.gcode = await fs.readFile(file, 'utf8');
    } catch (e) { S.ts.gcodeError = e.message; fs.unlink(file).catch(() => {}); }
  } else S.ts.gcodeError = 'That printer isn’t in Settings anymore.';
  const g = S.ts.gcode;
  S.ts.settings = g ? parseConfigBlock(g) : null;
  S.ts.objects = g ? objectsFromGcode(g) : [];
  S.ts.header = g ? headerInfo(g) : null;
  let model = null;
  if (modelPath) {
    progress('Loading the model…');
    const proj = await load3mf(await fs.readFile(modelPath));
    const plate = Number((/_plate_(\d+)/i.exec(job.filename) || [])[1]) || (proj.plates[0] && proj.plates[0].index) || 1;
    const a = analyzePlate(proj, plate, {}, { orient: false });
    S.ts.project = proj; S.ts.analysis = a;
    model = { preview: a.preview, offset: a.offset, totals: a.totals, names: a.objects.map(o => o.name), fileName: path.basename(modelPath), assemblyGuess: projectLooksLikeAssembly(proj) };
    if (!S.ts.settings) S.ts.settings = proj.projectSettings || null;
  }
  // the supports that were printed, for drawing and painting in the 3D view
  let supports = null;
  if (g && model) {
    const sp = supportPaths(g);
    if (sp.count) supports = sp;
  }
  const colors = S.ts.settings && S.ts.settings.filament_colour;
  return {
    gcode: g ? { ok: true, objects: S.ts.objects, header: S.ts.header } : { ok: false, error: S.ts.gcodeError },
    model, supports, filamentColors: Array.isArray(colors) ? colors : [],
    printed: S.ts.settings ? { layer: S.ts.settings.layer_height, filaments: S.ts.settings.filament_type, process: S.ts.settings.print_settings_id } : null,
  };
});

function pointInPolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

ipcMain.handle('ts-run', async (_e, args) => { await S.ready;
  const T = S.ts;
  if (!T) throw new Error('Open the troubleshooter from a print first.');
  const cfg = await readConfig();
  const region = args.region || null;
  // which G-code objects the painted/picked area belongs to
  let objs = region && region.objects && region.objects.length ? region.objects : null;
  if (!objs && region && region.centerXY && T.objects.length) {
    const hit = T.objects.filter(o => o.polygon.length > 2 && pointInPolygon(region.centerXY, o.polygon)).map(o => o.name);
    if (hit.length) objs = hit;
  }
  let regionGcode = null, wholePrint = null;
  if (T.gcode) {
    progress('Reading what the printer did at the failed spot…');
    if (region && region.zMin != null) regionGcode = { objectsAnalyzed: objs || 'all objects', ...regionWindow(T.gcode, { zMin: region.zMin, zMax: region.zMax, objects: objs }) };
    const whole = analyzeGcode(T.gcode);
    wholePrint = { header: T.header, toolChanges: whole.toolChanges, byFeature: whole.byFeature.slice(0, 10), objects: T.objects.map(o => o.name) };
  }
  const settings = T.settings ? Object.fromEntries([...CATALOG.map(c => c.key), ...CONTEXT_KEYS, 'curr_bed_type', 'printable_area'].filter(k => k in T.settings).map(k => [k, T.settings[k]])) : null;
  const j = T.job;
  const job = { file: j.filename, printer: j.printer, status: j.status, when: j.start, printedHours: +(j.printSeconds / 3600).toFixed(2),
    estimatedHours: T.header && T.header.estimatedSeconds ? +(T.header.estimatedSeconds / 3600).toFixed(2) : (j.estimatedSeconds ? +(j.estimatedSeconds / 3600).toFixed(2) : null),
    stoppedAtPercent: T.header && T.header.estimatedSeconds && j.status !== 'completed' ? Math.round(100 * j.printSeconds / T.header.estimatedSeconds) : null,
    rating: j.rating ? j.rating.rating : null, note: j.rating ? j.rating.note : null, material: j.filamentType };
  const images = [];
  for (const im of [...(args.renders || []), ...(args.photos || [])]) {
    const m = /^data:(image\/\w+);base64,(.+)$/.exec(im.dataUrl);
    if (m) images.push({ label: im.label, mediaType: m[1], base64: m[2] });
  }
  const previous = Object.entries(S.printLog.data.diagnoses || {}).filter(([id]) => id !== j.id).flatMap(([, list]) => list)
    .filter(d => d.stem && d.stem === stemOf(j.filename)).slice(0, 3).map(d => ({ when: d.at, issue: d.issueTypes, summary: d.summary, changes: d.changes }));
  const tsPayload = { issueTypes: args.issueTypes, description: args.description, region: region ? { ...region, gcodeObjects: objs } : null, regionGcode, wholePrint, job, settings,
    geometry: T.analysis ? { totals: T.analysis.totals, objects: T.analysis.objects.map(o => ({ name: o.name, sizeMm: o.sizeMm, bedContactAreaCm2: o.bedContactAreaCm2, overhangAreaBelow45Cm2: o.overhangAreaBelow45Cm2, heightToBaseRatio: o.heightToBaseRatio })) } : null,
    previous, images, assembly: !!args.assembly };
  const ctx = { job: j, region, regionGcode, issueTypes: args.issueTypes, description: args.description, printedSettings: T.settings || {}, modelPath: T.modelPath, assembly: !!args.assembly };
  if (cfg.aiMode === 'chat') {
    progress('Preparing the prompt for your chatbot…');
    return chatHandoff('ts', ctx, tsSystemPrompt({ compact: true }), tsBuildContent({ ...tsPayload, settings: tsPayload.settings ? { ...onlyCurated(tsPayload.settings), ...Object.fromEntries(['filament_type', 'printer_settings_id', 'print_settings_id', 'curr_bed_type'].filter(k => k in tsPayload.settings).map(k => [k, tsPayload.settings[k]])) } : null }));
  }
  progress('Claude is diagnosing the print…');
  const result = await troubleshoot({ apiKey: await getApiKey(), model: cfg.model || DEFAULT_MODEL, ...tsPayload });
  return finishTroubleshoot(ctx, result);
});

async function finishTroubleshoot(ctx, result) {
  const { kept, dropped } = guardFit(result.settings || [], ctx.assembly);
  result = { ...result, settings: kept, physical_checks: [...(result.physical_checks || []), ...(dropped.length ? [fitNote(dropped)] : [])] };
  const { rows, unknown } = buildRows({ settings: result.settings }, [], ctx.printedSettings);
  await S.printLog.addDiagnosis(ctx.job.id, { stem: stemOf(ctx.job.filename), issueTypes: ctx.issueTypes, description: ctx.description, region: ctx.region ? { zMin: ctx.region.zMin, zMax: ctx.region.zMax, facing: ctx.region.facing } : null,
    summary: result.summary, causes: result.causes.map(c => c.cause), changes: result.settings.map(st => `${st.key}=${st.recommended}${st.slot ? `@T${st.slot}` : ''}`),
    full: { result: { ...result, physical_checks: [...result.physical_checks, ...unknown] }, rows, regionGcode: ctx.regionGcode, modelPath: ctx.modelPath } });
  return { result: { ...result, physical_checks: [...result.physical_checks, ...unknown] }, rows, regionGcode: ctx.regionGcode, modelPath: ctx.modelPath };
}

// A reply pasted back from a chatbot (free mode)
ipcMain.handle('chat-answer', async (_e, { id, text }) => { await S.ready;
  const pending = S.chat && S.chat[id];
  if (!pending) throw new Error('That request expired. Start it again.');
  const parsed = parseChatAnswer(text, pending.kind);
  if (!parsed.summary && !parsed.settings.length) throw new Error('The reply had no summary or settings. Make sure you copied the chatbot’s JSON answer.');
  const out = pending.kind === 'ts' ? await finishTroubleshoot(pending.ctx, parsed) : finishRecommendation(pending.ctx, parsed);
  if (pending.kind !== 'ts') await archiveAnalysis({ kind: 'recs', model: 'chatbot', slider: pending.ctx.slider, purpose: pending.ctx.purpose, slots: S.slots, rotations: S.rotations, result: out }).catch(e => logLine('archive failed:', e));
  delete S.chat[id];
  return out;
});
ipcMain.handle('open-folder', (_e, p) => shell.openPath(p));

// rows for settings coming from elsewhere (the troubleshooter), against the currently prepared project
ipcMain.handle('rows-for', async (_e, settings) => { await S.ready; return buildRows({ settings }, [], (S.base && S.base.settings) || {}).rows; });

ipcMain.handle('history-list', async () => { await S.ready;
  const printers = await getPrinters();
  if (!printers.some(p => p.url)) return { configured: false, jobs: [], errors: [] };
  const { jobs, errors } = FAKE_PRINTER ? { jobs: JSON.parse(await fs.readFile(path.join(FAKE_PRINTER, 'jobs.json'), 'utf8')), errors: [] } : await fetchJobs(printers);
  S.lastJobs = S.printLog.decorate(jobs);
  return { configured: true, jobs: S.lastJobs, errors };
});
ipcMain.handle('history-rate', async (_e, { jobId, rating, note }) => { await S.ready; await S.printLog.rate(jobId, rating, note); return true; });

ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('browse-slicer', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Find Snapmaker Orca', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Program', extensions: ['exe'] }] : [] });
  return r.canceled ? null : r.filePaths[0];
});

// ---------- AI spending ----------
ipcMain.handle('spend-summary', () => Spend.summary());
ipcMain.handle('spend-clear', () => { Spend.clear(); return Spend.summary(); });
// Anthropic's own figure for this month (organization total and this app's key), with an Admin API key
ipcMain.handle('account-spend', async (_e, { adminKey } = {}) => {
  const cfg = await readConfig();
  const key = (adminKey || '').trim() || dec(cfg.adminKey);
  if (!key) throw new Error('Paste an Admin API key first (it starts with sk-ant-admin).');
  return Spend.accountSpend(key, await getApiKey());
});

ipcMain.handle('get-config', async () => { await S.ready;
  const cfg = await readConfig();
  return {
    model: cfg.model || DEFAULT_MODEL, hasKey: !!(await getApiKey()), keyNeedsReentry: !!cfg.apiKey && !(await getApiKey()), aiMode: cfg.aiMode || 'api', hasAdminKey: !!dec(cfg.adminKey),
    experience: Number.isInteger(cfg.experience) ? cfg.experience : null, guideDone: !!cfg.guideDone,
    slicerPath: cfg.slicerPath || '', detectedSlicer: candidateExecutables()[0] || '',
    printers: (cfg.printers || []).map(p => ({ name: p.name, url: p.url, hasKey: !!p.apiKey })),
    slicer: slicerInfo(),
    version: require('./package.json').version, homepage: /YOUR-GITHUB-USERNAME/.test(require('./package.json').homepage || '') ? null : require('./package.json').homepage,
  };
});
ipcMain.handle('set-config', async (_e, patch) => { await S.ready;
  const cfg = await readConfig();
  if (typeof patch.adminKey === 'string') { const k = patch.adminKey.trim(); if (k) cfg.adminKey = enc(k); else delete cfg.adminKey; }
  if (patch.model) cfg.model = patch.model.trim();
  if (patch.aiMode === 'api' || patch.aiMode === 'chat') cfg.aiMode = patch.aiMode;
  if (Number.isInteger(patch.experience) && patch.experience >= 0 && patch.experience <= 3) cfg.experience = patch.experience;
  if (typeof patch.guideDone === 'boolean') cfg.guideDone = patch.guideDone;
  if (typeof patch.apiKey === 'string') {
    const key = patch.apiKey.trim();
    if (!key) delete cfg.apiKey; else cfg.apiKey = enc(key);
    delete cfg.apiKeyEncrypted;
  }
  if (typeof patch.slicerPath === 'string') cfg.slicerPath = patch.slicerPath.trim();
  if (Array.isArray(patch.printers)) {
    const old = cfg.printers || [];
    cfg.printers = patch.printers.filter(p => p.url).map((p, i) => ({
      name: p.name || `U1 ${i + 1}`, url: p.url.trim(),
      apiKey: p.apiKey ? enc(p.apiKey) : (old.find(o => o.url === p.url.trim()) || {}).apiKey || null,
    }));
  }
  await writeConfig(cfg);
  if (typeof patch.slicerPath === 'string') await setupSlicer();
  return { model: cfg.model || DEFAULT_MODEL, hasKey: !!cfg.apiKey || !!process.env.ANTHROPIC_API_KEY, aiMode: cfg.aiMode || 'api', slicer: slicerInfo() };
});

// Remove cached slices, prepared projects, downloaded G-code and chat images older than two weeks, so the
// app's data folder doesn't grow forever. Saved files, settings, ratings and diagnoses are never touched.
async function pruneOldFiles(maxAgeDays = 14) {
  const root = app.getPath('userData');
  const cutoff = Date.now() - maxAgeDays * 86400000;
  let removed = 0;
  for (const dir of [path.join(root, 'work', 'slices'), path.join(root, 'work', 'prepare'), path.join(root, 'work', 'slice-cache'), path.join(root, 'gcode-cache'), path.join(root, 'chat-images')]) {
    let entries = [];
    try { entries = await fs.readdir(dir); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e);
      try { const st = await fs.stat(p); if (st.mtimeMs < cutoff) { await fs.rm(p, { recursive: true, force: true }); removed++; } } catch {}
    }
  }
  return removed;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    const f = argv.find(a => /\.(3mf|aipsession)$/i.test(a));
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); if (f) win.webContents.send('open-from-os', f); }
  });
  app.on('open-file', (e, f) => { e.preventDefault(); if (win) win.webContents.send('open-from-os', f); });
  app.whenReady().then(() => {
    protocol.handle('app', async (req) => {
      const u = new URL(req.url);
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      // app://filament/images/<name>: product photos of the filament inventory, from the data folder
      const root = u.host === 'filament' ? Fil.imagesDir : __dirname;
      const file = path.normalize(path.join(root, u.host === 'filament' ? rel.replace(/^images\//, '') : rel));
      if (!file.startsWith(path.normalize(root) + path.sep)) return new Response('Not found', { status: 404 });
      try {
        const body = await fs.readFile(file);
        return new Response(body, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
      } catch { return new Response('Not found', { status: 404 }); }
    });
    // window first; everything slow happens after it is on screen, with progress shown in the app
    createWindow();
    buildMenu().catch(e => logLine('menu failed:', e));
    logLine(`started AI 3D Print Advisor Studio ${require('./package.json').version} on ${process.platform} ${process.arch}`); // the log always exists, for bug reports
    S.ready = (async () => {
      try {
        startup('Reading your settings and print log…', 15);
        S.printLog = await new PrintLog(app.getPath('userData')).load();
        startup('Looking for Snapmaker Orca…', 35);
        await new Promise(r => setImmediate(r));
        const firstRun = !require('fs').existsSync(path.join(app.getPath('userData'), 'profile-index.json'));
        startup(firstRun ? 'Loading Snapmaker U1 profiles (first run builds an index)…' : 'Loading Snapmaker U1 profiles…', 60);
        await new Promise(r => setImmediate(r));
        if (!DEMO) await setupSlicer();   // the demo slices nothing
        const info = slicerInfo();
        startup(info.available ? `Ready. Snapmaker Orca found with ${info.filaments.length} U1 filament presets.` : 'Ready. Snapmaker Orca wasn’t found, so slicing is off until you set it in Settings.', 100, true, !info.available);
        setTimeout(() => pruneOldFiles().catch(() => {}), 15000); // housekeeping, after startup
      } catch (e) {
        S.printLog = S.printLog || await new PrintLog(app.getPath('userData')).load();
        startup(`Started with a problem: ${e.message}`, 100, true, true);
      }
    })();
  });
  app.on('window-all-closed', () => app.quit());
}
