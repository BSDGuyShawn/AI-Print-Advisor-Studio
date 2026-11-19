import { ModelViewer } from './viewer.js';
import { createGlossary } from './glossary.js';

const api = window.advisor;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cleanErr = e => String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const TYPES = ['PLA', 'PLA Matte', 'PLA Silk', 'PLA-CF', 'PETG', 'PETG-HF', 'PETG-CF', 'PCTG', 'TPU', 'PVA', 'ABS', 'ASA'];
const DEFAULT_COLORS = ['#2F8F9D', '#E8E4DA', '#C2412D', '#2B3A4A'];

const state = {
  file: null, info: { available: false, filaments: [], recipes: [] }, config: {},
  slots: [], plateIndex: 1, analysis: null, rotations: {}, orientObj: null,
  result: null, recipe: null, compare: null, selectedVariant: null, history: null, busy: false, checks: [],
};
const viewer = new ModelViewer($('viewer'));
// beginner word help (renderer/glossary.js): dotted-underlined words explained with a picture on hover
const glossary = createGlossary({ isOn: () => wordsOn() });

// ---------- progress strip ----------
const busy = new Map(); // task id -> { label, pct }
let busyHideTimer;
function renderBusy() {
  const bar = $('busyBar');
  const last = [...busy.values()].pop();
  clearTimeout(busyHideTimer);
  if (!last) { busyHideTimer = setTimeout(() => bar.classList.add('idle'), 150); return; }
  bar.classList.remove('idle', 'warn');
  bar.classList.toggle('indeterminate', last.pct == null);
  $('busyFill').style.width = last.pct == null ? '' : `${last.pct}%`;
  $('busyLabel').textContent = last.label;
}
function setBusy(id, label, pct = null) { busy.delete(id); busy.set(id, { label, pct }); renderBusy(); }
function clearBusy(id) { busy.delete(id); renderBusy(); }
async function withBusy(id, label, fn) { setBusy(id, label); try { return await fn(); } finally { clearBusy(id); } }

api.onProgress(t => {
  document.querySelectorAll('.progress-line').forEach(el => { el.textContent = t; });
  const last = [...busy.keys()].pop();
  if (!last) return;
  const m = /Sliced (\d+) of (\d+)/.exec(t);
  setBusy(last, t, m ? Math.round(100 * m[1] / m[2]) : null);
});

function onStartup(st) {
  if (!st.done) { setBusy('startup', st.label, st.pct); return; }
  setBusy('startup', st.label, 100);
  if (st.warn) $('busyBar').classList.add('warn');
  setTimeout(() => clearBusy('startup'), st.warn ? 6000 : 1500);
  loadConfig().then(maybeWelcome).then(maybeRestoreSession);
}
api.onStartup(onStartup);
api.startupState().then(onStartup);

// ---------- tabs ----------
function showTab(name) {
  setTimeout(() => saveSession(), 0);
  document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  ['recs', 'compare', 'history'].forEach(t => $(`tab-${t}`).classList.toggle('hidden', t !== name));
  if (name === 'history' && !state.history) loadHistory();
  if (name === 'compare') renderVariantPicks();
}
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => showTab(b.dataset.tab));

// ---------- slider + recipe ----------
function sliderText(v) {
  if (v <= 15) return 'Best possible finish and detail. Print time is not a concern.';
  if (v <= 38) return 'Leaning toward quality. Longer prints for cleaner surfaces.';
  if (v <= 61) return 'Balanced. Close to the stock U1 profile.';
  if (v <= 84) return 'Leaning toward speed. Some visible layer lines are fine.';
  return 'As fast as it can reliably go. Looks come second.';
}
function drawLayers() {
  const v = Number($('slider').value);
  // the layer heights of the printer's own presets (Finest may be 0.08 mm), else the usual steps
  const rs = (state.info && state.info.recipes) || [];
  const rec = rs.find(r => v >= r.range[0] && v <= r.range[1]);
  const lh = (rec && rec.layer) || [0.12, 0.16, 0.2, 0.24, 0.28][v <= 15 ? 0 : v <= 38 ? 1 : v <= 61 ? 2 : v <= 84 ? 3 : 4];
  const px = Math.max(2, lh * 38);
  const count = Math.floor(66 / (px + 1.5));
  $('layerPreview').innerHTML = Array.from({ length: count }, () => `<span style="height:${px}px;margin-top:1.5px"></span>`).join('');
  $('sliderNote').textContent = sliderText(v);
}
const refreshRecipe = debounce(async () => {
  if (!state.file) return;
  const r = await api.recipePreview(Number($('slider').value));
  state.recipe = r;
  $('recipeLine').innerHTML = `Recipe: <b>${esc(r.recipe.name)}</b>. ${esc(r.recipe.about)}${r.changes.length ? ` (${r.changes.length} setting${r.changes.length === 1 ? '' : 's'})` : ''}`;
}, 150);
$('slider').addEventListener('input', () => { drawLayers(); refreshRecipe(); saveSession(); });
$('purpose').addEventListener('input', () => saveSession());
$('fitTogether').addEventListener('change', async () => {
  state.assemblyChoice = $('fitTogether').checked; saveSession();
  await api.setAssembly({ assembly: $('fitTogether').checked, guess: state.assemblyGuess }).catch(() => {});
  state.compare = null; renderCompare(); refreshChecks();
  if (!$('fitTogether').checked && state.assemblyGuess) toast('Fit protection is off. Walls, line widths and sizes may now change, which can stop parts fitting together.', 7000);
});

// Before saving, sending or opening: a likely assembly with fit protection off, and changes that alter walls or sizes
let FIT_KEYS = null;
async function fitConfirm(changes) {
  if (!state.assemblyGuess || $('fitTogether').checked) return true;
  FIT_KEYS = FIT_KEYS || new Set(await api.fitCritical().catch(() => []));
  const risky = (changes || []).filter(c => FIT_KEYS.has(c.key));
  if (!risky.length) return true;
  return window.confirm(`These parts look like they fit together, and “These parts fit together” is unticked.\n\nThis version changes ${[...new Set(risky.map(c => c.label || c.key.replace(/_/g, ' ')))].join(', ')}. On snap-together or multi-piece models that usually makes the pieces too tight or too loose to fit, even if every piece prints perfectly.\n\nContinue anyway?`);
}
drawLayers();

// ---------- opening files ----------
// restore: a saved session to bring back (toolheads, orientation, slider, recommendations, edits, comparisons)
async function openFile(promise, restore = null, opts = {}) {
  if (!opts.fromSession) { api.sessionForgetFile().catch(() => {}); document.title = 'AI 3D Print Advisor Studio'; }
  try {
    setBusy('file', restore ? 'Restoring your session…' : 'Reading the 3MF…');
    const info = await promise;
    if (!info) { clearBusy('file'); return; }
    Object.assign(state, { file: info, result: null, compare: null, rotations: {}, checks: [], orientObj: null, assemblyChoice: null, blockersOn: false, remixApplied: false });
    resetRemix();
    state.slots = initialSlots(info.filaments);
    renderFileInfo();
    if (restore) {
      if (restore.slots && restore.slots.length) state.slots = restore.slots;
      state.rotations = restore.rotations || {};
      if (restore.plateIndex) { state.plateIndex = restore.plateIndex; $('plateSelect').value = String(restore.plateIndex); }
      if (restore.slider != null) { $('slider').value = restore.slider; drawLayers(); }
      $('purpose').value = restore.purpose || '';
      state.assemblyChoice = restore.assemblyChoice ?? null;
      state.blockersOn = !!restore.blockersOn;
    }
    await prepare();
    if (restore && restore.result) {
      state.result = restore.result;
      renderResults();
      applyRowEdits(restore.rowEdits);
      $('analyzeBtn').textContent = 'Get new recommendations';
      if (restore.comparePicks) state.comparePicks = new Set(restore.comparePicks);
      if (restore.compareIds && restore.compareIds.length && state.info.available) await runCompare(restore.compareIds); // served from the slice cache
      if (restore.tab) showTab(restore.tab);
    } else {
      await offerPastAnalyses();
    }
    info.warnings.forEach(w => toast(w, 7000));
    api.printName().then(showPrintName).catch(() => {});
    saveSession();
    guideEvent('opened');
  } catch (e) { toast(`Could not open the file: ${cleanErr(e)}`, 8000); }
  finally { clearBusy('file'); }
}

// ---------- crash safety: session save/restore, earlier analyses ----------
function rowEdits() {
  const out = {};
  document.querySelectorAll('#resultsBody .setting').forEach(r => { out[r.dataset.id] = { checked: r.querySelector('input[type=checkbox]').checked, value: r.querySelector('input[type=text]').value }; });
  return out;
}
function applyRowEdits(edits) {
  if (!edits) return;
  document.querySelectorAll('#resultsBody .setting').forEach(r => {
    const e = edits[r.dataset.id]; if (!e) return;
    r.querySelector('input[type=checkbox]').checked = e.checked;
    r.querySelector('input[type=text]').value = e.value;
  });
  updateCount(); refreshChecks();
}
// everything needed to pick up where you left off
function sessionPayload() {
  const tab = (document.querySelector('[data-tab][aria-selected=true]') || {}).dataset?.tab || 'recs';
  return {
    plateIndex: state.plateIndex, slots: state.slots, rotations: state.rotations, slider: Number($('slider').value), purpose: $('purpose').value,
    result: state.result, rowEdits: state.result ? rowEdits() : null,
    comparePicks: state.comparePicks ? [...state.comparePicks] : null,
    compareIds: state.compare && state.compare.results ? state.compare.results.filter(r => r.ok).map(r => r.id) : [], tab,
    selectedVariant: state.selectedVariant || null,
    assemblyChoice: state.assemblyChoice ?? null,
    blockersOn: !!state.blockersOn,
  };
}
const saveSession = debounce(() => {
  if (!state.file) return;
  api.sessionSave(sessionPayload()).catch(() => {});
}, 700);

// ---------- models too heavy to slice (AI-generated, colours baked in from a texture) ----------
const fmtN = (n) => Number(n).toLocaleString();
async function checkHeavy() {
  const r = await api.heavyCheck({ plateIndex: state.plateIndex }).catch(() => null);
  const row = $('heavyRow');
  if (!r || (!r.heavy && !r.fixed)) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  row.classList.toggle('fixed', !r.heavy && r.fixed);
  $('heavyUndoBtn').classList.toggle('hidden', !r.fixed);
  $('heavyFixBtn').classList.toggle('hidden', !r.heavy);
  if (!r.heavy) {
    $('heavyTitle').textContent = 'Model fixed for faster slicing';
    $('heavyText').textContent = `Now ${fmtN(r.triangles)} triangles${r.painted ? ` and ${fmtN(r.areas)} color areas` : ''}. For the fastest slice, use Fine or Balanced rather than Finest.`;
    return;
  }
  $('heavyTitle').textContent = 'This model will be very slow to slice';
  const why = [];
  if (r.triangles > 600000) why.push(`${fmtN(r.triangles)} triangles`);
  if (r.specks > 300) why.push(`${fmtN(r.specks)} tiny color specks`);
  $('heavyText').innerHTML = `${r.aiMade ? 'Likely AI-generated (Meshy, Tripo…) with colors baked in from a texture: ' : 'It has '}${why.join(' and ')}. The slicer may take very long or run out of memory and seem stuck.` +
    `<details><summary>What Fix model does</summary>Merges each speck into the color around it${r.triangles > 600000 ? ` and lightens the mesh to about ${fmtN(r.reduceTo)} triangles, keeping the shape within 0.03 mm` : ''}. Colors keep their edges and the model stays watertight. You can undo it.</details>`;
  if (state.heavyToldFor !== state.file) { state.heavyToldFor = state.file; toast('This model will be very slow to slice. See “Fix model” at the top left.', 8000); }
}
$('heavyFixBtn').onclick = async () => {
  $('heavyFixBtn').disabled = true;
  try {
    const r = await withBusy('heavy', 'Cleaning up the colors and lightening the mesh… (can take a minute)', () => api.heavyFix({ plateIndex: state.plateIndex }));
    state.compare = null; state.result = null; renderCompare();
    await prepare();
    toast(`Fixed: ${fmtN(r.trianglesBefore)} → ${fmtN(r.trianglesAfter)} triangles${r.specksMerged ? `, ${fmtN(r.specksMerged)} color specks merged` : ''}. Save it with Save as 3MF to keep the fixed copy.`, 9000);
  } catch (e) { toast(cleanErr(e), 8000); }
  finally { $('heavyFixBtn').disabled = false; }
};
$('heavyUndoBtn').onclick = async () => {
  if (await api.heavyUndo()) { state.compare = null; renderCompare(); await prepare(); toast('Back to the model as it was.', 4000); }
};

// ---------- support blockers inside hollow, open models ----------
async function checkBlockers() {
  const info = await api.blockerCheck({ plateIndex: state.plateIndex }).catch(() => null);
  if (!info || !info.found) { $('blockRow').classList.add('hidden'); return; }
  $('blockRow').classList.remove('hidden');
  const cm = Math.round(info.items.reduce((t, x) => t + x.hollowCm3, 0));
  $('blockText').textContent = `This model is hollow with openings (about ${cm} cm³ inside). Supports can grow up through the openings and get stuck inside, where you can't remove them. This fills the inside with a support blocker (shown in light blue) so supports stay outside. A few inner edges of the openings then print without support.`;
  $('blockInside').checked = !!info.on;
  // remembered choice: re-apply after the project is rebuilt (e.g. after changing a filament)
  if (state.blockersOn && !info.on) applyBlockers(true);
}
async function applyBlockers(on) {
  try {
    const r = await withBusy('blockers', on ? 'Adding support blockers inside the model…' : 'Removing the support blockers…', () => api.setBlockers({ plateIndex: state.plateIndex, on }));
    state.blockersOn = !!(r && r.on);
    $('blockInside').checked = state.blockersOn;
    state.compare = null; renderCompare();
    const a = await api.analyzePlate({ plateIndex: state.plateIndex, rotations: state.rotations });
    viewer.load(a.preview); pushColors();
    refreshChecks(); saveSession();
    if (on && state.blockersOn) toast('Support blockers added inside the model. They’re included when you compare, save, send or open it in your slicer.', 7000);
  } catch (e) { toast(cleanErr(e), 7000); }
}
$('blockInside').addEventListener('change', () => applyBlockers($('blockInside').checked));

// ---------- colour remix ----------
// Step 1, Parts: the model is cut into patches along its grooves; the AI groups them into named parts; the user
// checks and fixes them (click a patch, or brush). Step 2, Colors: schemes are designed per confirmed part.
const RX_STYLES = [['realistic', 'Realistic'], ['fun', 'Fun'], ['galaxy', 'Galaxy'], ['colorshift', 'Color Shift'], ['pastel', 'Pastel'], ['monochrome', 'Monochrome'], ['holiday', 'Holiday']];
const RX = { counts: { realistic: 3 }, prep: null, variations: [], previews: [], regions: null, labels: null, estimates: null };
// the parts being edited (labels: part id per triangle of the file, before pupils are added)
const PT = { subject: '', parts: [], labels: null, sel: 0, history: [] };
const KIND_NAMES = { eye: 'Eyes', pupil: 'Pupils', skin: 'Skin', body: 'Body', shell: 'Shell', hair: 'Hair / fur', mouth: 'Mouth', nose: 'Nose', ear: 'Ears', limb: 'Limbs', clothing: 'Clothing', accessory: 'Accessory', marking: 'Markings', base: 'Base / stand', text: 'Text', other: 'Other' };
const PART_COLORS = ['#3FA34D', '#8B5A2B', '#F2F2F2', '#2B6CB0', '#E0A526', '#C53D6B', '#6B46C1', '#2C9C9C', '#E86A33', '#7A8B99', '#B8D54A', '#5C3B8C'];
// show each part in (roughly) its natural colour, so the editor reads like the real thing; parts that would
// look the same get distinct colours instead
const COLOR_WORDS = [['white', '#F4F4F4'], ['ivory', '#F3EBD3'], ['cream', '#F1E6C8'], ['beige', '#D9C7A0'], ['tan', '#C9A66B'], ['black', '#1A1A1A'], ['gray', '#8A8F94'], ['grey', '#8A8F94'], ['silver', '#BFC5CA'],
  ['olive', '#6B7A2E'], ['lime', '#8BC34A'], ['dark green', '#2E6B34'], ['green', '#3FA34D'], ['teal', '#2C9C9C'], ['turquoise', '#3BC1B5'], ['navy', '#22315E'], ['sky', '#78B7E5'], ['blue', '#2B6CB0'],
  ['purple', '#6B46C1'], ['violet', '#8E5BD6'], ['pink', '#E68FB0'], ['magenta', '#C53D9B'], ['red', '#C8312E'], ['orange', '#E8772E'], ['gold', '#D4A72C'], ['yellow', '#EDD03A'],
  ['dark brown', '#5A3A1E'], ['brown', '#8B5A2B'], ['wood', '#A87A4D'], ['copper', '#B8693A'], ['bronze', '#9C6B30']];
function partHex(p) {
  if (p.kind === 'pupil') return '#151515';
  const words = String(p.realColor || '').toLowerCase();
  const natural = (COLOR_WORDS.find(([w]) => words.includes(w)) || [])[1] || (p.kind === 'eye' ? '#F4F4F4' : null);
  const fallback = PART_COLORS[(p.id - 1) % PART_COLORS.length];
  if (!natural) return fallback;
  // an earlier part already shows this colour: use the palette so the two can be told apart
  const earlier = PT.parts.filter(q => q.id < p.id && q.kind !== 'pupil').some(q => partHexNatural(q) === natural);
  return earlier ? fallback : natural;
}
function partHexNatural(p) { const w = String(p.realColor || '').toLowerCase(); return (COLOR_WORDS.find(([k]) => w.includes(k)) || [])[1] || (p.kind === 'eye' ? '#F4F4F4' : null); }
const RX_MAX = 12;
const rxTotal = () => Object.values(RX.counts).reduce((t, n) => t + n, 0);
const money = (usd) => (usd < 0.01 ? 'under 1¢' : usd < 1 ? `${Math.round(usd * 100)}¢` : `$${usd.toFixed(2)}`);
function resetRemix() { RX.prep = null; RX.variations = []; RX.regions = null; RX.labels = null; Object.assign(PT, { subject: '', parts: [], labels: null, sel: 0, history: [] }); $('rxResults').innerHTML = ''; }

// style chips: click to pick or drop a style; a picked style shows − count + for how many schemes of it
function renderStyles() {
  $('rxStyles').innerHTML = RX_STYLES.map(([id, name]) => {
    const n = RX.counts[id] || 0;
    return n
      ? `<span class="rx-chip on" data-style="${id}"><button type="button" class="step" data-step="-1" aria-label="One fewer ${name}">−</button><button type="button" data-toggle aria-pressed="true" title="Click to remove this style">${name}</button><span class="n" aria-label="${n} ${name} schemes">${n}</span><button type="button" class="step" data-step="1" aria-label="One more ${name}">+</button></span>`
      : `<span class="rx-chip" data-style="${id}"><button type="button" data-toggle aria-pressed="false">${name}</button></span>`;
  }).join('');
  rxCost();
}
$('rxStyles').onclick = (e) => {
  const chip = e.target.closest('[data-style]'); if (!chip) return;
  const id = chip.dataset.style, step = e.target.closest('[data-step]');
  if (step) {
    const n = (RX.counts[id] || 0) + Number(step.dataset.step);
    if (n <= 0) delete RX.counts[id]; else if (rxTotal() < RX_MAX || n < RX.counts[id]) RX.counts[id] = n;
    else toast(`Up to ${RX_MAX} schemes at a time.`, 3000);
  } else if (e.target.closest('[data-toggle]')) {
    if (RX.counts[id]) delete RX.counts[id]; else if (rxTotal() < RX_MAX) RX.counts[id] = 1;
  }
  renderStyles();
};
renderStyles();
function rxCost() {
  const total = rxTotal();
  if (!RX.prep || !RX.estimates) { $('rxGo').disabled = true; return; } // parts not confirmed yet (also: called at startup)
  const est = total && RX.estimates[Math.min(total, RX_MAX)];
  const name = (MODELS[RX.prep.model] || {}).name || 'the selected model';
  $('rxCost').textContent = !total ? 'Pick at least one style.' : est ? `${total} scheme${total === 1 ? '' : 's'}. Estimated cost: about ${money(est.low)}–${money(est.high)} with ${name}` : '';
  $('rxGo').disabled = !total || !RX.prep.hasKey;
}

// ----- step switching -----
function rxStep(n) {
  $('rxPartsPane').classList.toggle('hidden', n !== 1);
  $('rxColorsPane').classList.toggle('hidden', n !== 2);
  $('rxStep1').setAttribute('aria-selected', n === 1); $('rxStep2').setAttribute('aria-selected', n === 2);
  $('rxStep2').disabled = !RX.labels;
  if (n === 1) requestAnimationFrame(() => { window.dispatchEvent(new Event('resize')); });
  if (n === 2) { rxShowGrid(); rxCost(); }
}
$('rxStep1').onclick = () => rxStep(1);
$('rxStep2').onclick = () => { if (RX.labels) rxStep(2); };
$('rxBackParts').onclick = () => rxStep(1);

// ----- step 1: patches and parts -----
const modelTris = (preview) => preview.filter(p => p.kind === 'model').reduce((t, p) => t + (p.srcTri ? p.srcTri.length : p.positions.length / 9), 0);
// make sure the patches belong to what the main 3D view shows (it reloads at times); redo them if not
async function ensurePrep() {
  if (RX.prep && RX.prep.plateIndex === state.plateIndex) {
    const mapped = viewer.setRegions(state.analysis.preview, RX.prep.patchLabels);
    if (mapped && mapped >= modelTris(state.analysis.preview) * 0.9) return true;
  }
  resetRemix();
  await rxPrepare();
  return !!RX.prep;
}
async function rxPrepare() {
  $('rxPartsStatus').textContent = 'Finding the patches along the model’s grooves…';
  $('rxIdentify').disabled = true; $('rxConfirm').disabled = true;
  try {
    RX.prep = await withBusy('remix', 'Preparing the color remix…', () => api.remixPrepare({ plateIndex: state.plateIndex, detail: Number($('rxDetail').value) }));
    RX.prep.plateIndex = state.plateIndex;
    let mapped = viewer.setRegions(state.analysis.preview, RX.prep.patchLabels);
    if (!mapped) {
      const a = await api.analyzePlate({ plateIndex: state.plateIndex, rotations: state.rotations });
      state.analysis = a; viewer.load(a.preview); pushColors();
      mapped = viewer.setRegions(a.preview, RX.prep.patchLabels);
    }
    if (!mapped) throw new Error('Couldn’t match the patches to the model shown. Close this window and open Color remix again.');
    const p = RX.prep;
    const est = p.identifyCost, mName = (MODELS[p.model] || {}).name || 'the selected model';
    $('rxIdCost').textContent = p.hasKey ? `about ${money(est.low)}–${money(est.high)} with ${mName}` : 'needs a Claude API key (Settings)';
    $('rxIdentify').disabled = !p.hasKey;
    if (p.saved) {
      Object.assign(PT, { subject: p.saved.subject, parts: p.saved.parts, labels: p.saved.labels, history: [] });
      PT.sel = PT.parts[0] ? PT.parts[0].id : 0; $('rxPupils').checked = p.saved.pupils !== false;
      $('rxIdentify').textContent = 'Identify again with AI';
      $('rxPartsStatus').textContent = `These are the parts you confirmed for this model on ${new Date(p.saved.savedAt).toLocaleDateString()}. Check them and confirm, or identify again.`;
    } else {
      Object.assign(PT, { subject: '', parts: [], labels: null, sel: 0, history: [] });
      $('rxIdentify').textContent = 'Identify parts with AI';
      $('rxPartsStatus').textContent = `${p.patches.length} patches found. ${p.hasKey ? 'Next: Identify parts with AI.' : 'Add parts yourself with “+ Add a part”, or add a Claude API key in Settings so the AI can do it.'}`;
    }
    showParts();
  } catch (e) { $('rxPartsStatus').textContent = cleanErr(e); RX.prep = null; }
}
// the parts editor's own 3D view
function partsViewer() {
  if (!RX.pv) {
    RX.pv = new ModelViewer($('rxPartsView'));
    RX.pv.onRegionEdit = () => {
      PT.history.push(PT.labels); if (PT.history.length > 15) PT.history.shift();
      PT.labels = RX.pv.exportRegions(PT.labels);
      $('rxUndoEdit').disabled = false; renderPartList();
    };
    const el = $('rxPartsView');
    el.addEventListener('pointermove', (e) => {
      if (RX.pv.painting) return;
      const r = RX.pv.regionAt(e), part = r && PT.parts.find(p => p.id === r.region);
      $('rxHover').classList.toggle('hidden', !r);
      if (r) $('rxHover').textContent = part ? `${part.name} · patch ${r.patch}` : `Patch ${r.patch}`;
    });
    el.addEventListener('pointerleave', () => $('rxHover').classList.add('hidden'));
  }
  return RX.pv;
}
function showParts() {
  const pv = partsViewer(), pre = state.analysis.preview;
  pv.load(pre);
  pv.setFilamentColors(Object.fromEntries(state.slots.map(s => [s.slot, s.color])));
  pv.setPatches(pre, RX.prep.patchLabels);
  if (PT.labels) {
    pv.setRegions(pre, PT.labels);
    pv.showRegionColors(Object.fromEntries(PT.parts.map(p => [p.id, partHex(p)])));
  } else {
    // no parts yet: every patch in its own colour
    pv.setRegions(pre, RX.prep.patchLabels);
    pv.showRegionColors(Object.fromEntries(RX.prep.patches.map((p, i) => [p.id, `hsl(${Math.round((i * 137.5) % 360)}, 55%, ${i % 2 ? 48 : 62}%)`])));
  }
  pv.editValue = PT.sel; RX.pvFor = RX.prep;
  requestAnimationFrame(() => { window.dispatchEvent(new Event('resize')); pv.fit('iso'); });
  renderPartList();
}
function recolorParts() {
  if (!RX.pv || !PT.labels) return;
  RX.pv.showRegionColors(Object.fromEntries(PT.parts.map(p => [p.id, partHex(p)])));
}
function partShares() {
  const n = new Map(); let total = 0;
  for (const lab of Object.values(PT.labels || {})) for (let i = 0; i < lab.length; i++) { n.set(lab[i], (n.get(lab[i]) || 0) + 1); total++; }
  return { n, total: total || 1 };
}
function renderPartList() {
  const { n, total } = partShares();
  $('rxSubject').classList.toggle('hidden', !PT.subject);
  $('rxSubject').innerHTML = PT.subject ? `Recognized: <b>${esc(PT.subject)}</b>` : '';
  $('rxParts').innerHTML = PT.parts.map(p => {
    const share = (n.get(p.id) || 0) / total;
    return `<li data-part="${p.id}" class="${p.id === PT.sel ? 'sel' : ''}" title="${esc(p.realColor ? 'Natural color: ' + p.realColor : '')}">
      <span class="sw" style="background:${partHex(p)}"></span>
      <input type="text" value="${esc(p.name)}" aria-label="Part name" data-name>
      <select aria-label="Kind of part" data-kind>${Object.entries(KIND_NAMES).map(([k, v]) => `<option value="${k}" ${k === p.kind ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <span class="area">${share ? (share < 0.01 ? '<1' : Math.round(share * 100)) + '%' : 'empty'}</span>
      <button class="del" data-del title="Remove this part (its surface goes to the biggest other part)" aria-label="Remove ${esc(p.name)}">×</button></li>`;
  }).join('');
  $('rxConfirm').disabled = !PT.parts.length || !PT.labels;
  if (RX.pv) RX.pv.editValue = PT.sel;
}
$('rxParts').addEventListener('click', (e) => {
  const li = e.target.closest('[data-part]'); if (!li) return;
  const id = +li.dataset.part;
  if (e.target.closest('[data-del]')) {
    const { n } = partShares();
    const rest = PT.parts.filter(p => p.id !== id); if (!rest.length) return;
    const to = rest.reduce((b, p) => ((n.get(p.id) || 0) > (n.get(b.id) || 0) ? p : b), rest[0]).id;
    PT.history.push(PT.labels);
    const out = {}; for (const [k, lab] of Object.entries(PT.labels)) { const c = Uint16Array.from(lab); for (let i = 0; i < c.length; i++) if (c[i] === id) c[i] = to; out[k] = c; }
    PT.labels = out; PT.parts = rest; if (PT.sel === id) PT.sel = to;
    RX.pv.setRegions(state.analysis.preview, PT.labels); recolorParts(); renderPartList(); $('rxUndoEdit').disabled = false;
    return;
  }
  if (PT.sel !== id) { PT.sel = id; renderPartList(); if (RX.pv && RX.pv.tool === 'rotate') setPartTool('part-patch'); }
});
$('rxParts').addEventListener('change', (e) => {
  const li = e.target.closest('[data-part]'); if (!li) return;
  const p = PT.parts.find(x => x.id === +li.dataset.part); if (!p) return;
  if (e.target.matches('[data-name]')) p.name = e.target.value.trim() || p.name;
  if (e.target.matches('[data-kind]')) { p.kind = e.target.value; recolorParts(); renderPartList(); }
});
$('rxAddPart').onclick = () => {
  if (!RX.prep) return;
  if (!PT.labels) { // first part by hand: everything starts as "Body"
    PT.parts = [{ id: 1, name: 'Body', kind: 'body', realColor: '' }];
    PT.labels = Object.fromEntries(Object.entries(RX.prep.patchLabels).map(([k, lab]) => [k, new Uint16Array(lab.length).fill(1)]));
    RX.pv.setRegions(state.analysis.preview, PT.labels);
  }
  const id = Math.max(0, ...PT.parts.map(p => p.id)) + 1;
  PT.parts.push({ id, name: `Part ${id}`, kind: 'other', realColor: '' });
  PT.sel = id; recolorParts(); renderPartList(); setPartTool('part-patch');
  const inp = $('rxParts').querySelector(`[data-part="${id}"] input`); if (inp) { inp.focus(); inp.select(); }
  $('rxPartsStatus').textContent = 'Click the patches that belong to the new part, or use the brush.';
};
function setPartTool(tool) {
  partsViewer().setTool(tool);
  document.querySelectorAll('[data-ptool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.ptool === tool));
  $('rxBrushRow').classList.toggle('hidden', tool !== 'part-brush');
  if (tool !== 'rotate' && !PT.labels) { $('rxPartsStatus').textContent = 'Identify the parts first, or add one with “+ Add a part”.'; }
}
document.querySelectorAll('[data-ptool]').forEach(b => { b.onclick = () => setPartTool(b.dataset.ptool); });
$('rxBrush').oninput = () => { partsViewer().brush = Number($('rxBrush').value); $('rxBrushVal').textContent = `${$('rxBrush').value} mm`; };
$('rxUndoEdit').onclick = () => {
  if (!PT.history.length) return;
  PT.labels = PT.history.pop();
  RX.pv.setRegions(state.analysis.preview, PT.labels); recolorParts(); renderPartList();
  $('rxUndoEdit').disabled = !PT.history.length;
};
$('rxDetail').onchange = () => { resetRemix(); rxPrepare(); };
$('rxIdentify').onclick = async () => {
  if (!RX.prep || !(await ensurePrep())) return;
  $('rxIdentify').disabled = true; $('rxPartsStatus').textContent = 'Looking at the model from every side… (usually under a minute)';
  try {
    const ids = RX.prep.patches.map(p => p.id);
    viewer.setRegions(state.analysis.preview, RX.prep.patchLabels);
    const shots = viewer.regionMapShots(ids, ['front', 'back', 'side', 'left', 'top', 'iso'], 'patch');
    viewer.showRegionColors(null); pushColors();
    const plain = viewer.thumbnails([700])[0];
    const images = [{ label: 'The model as it looks now', dataUrl: plain.dataUrl }, ...shots];
    const r = await withBusy('remix', 'Identifying the parts…', () => api.partsIdentify({ images, hint: $('rxHint').value.trim() }));
    PT.history = PT.labels ? [PT.labels] : [];
    PT.subject = r.subject; PT.parts = r.parts;
    PT.labels = Object.fromEntries(Object.entries(RX.prep.patchLabels).map(([k, lab]) => { const o = new Uint16Array(lab.length); for (let i = 0; i < lab.length; i++) o[i] = r.patchPart[lab[i]] || PT.parts[0].id; return [k, o]; }));
    PT.parts = PT.parts.filter(p => Object.values(r.patchPart).includes(p.id));
    PT.sel = PT.parts[0] ? PT.parts[0].id : 0;
    RX.pv.setRegions(state.analysis.preview, PT.labels); recolorParts(); renderPartList();
    $('rxUndoEdit').disabled = !PT.history.length;
    $('rxPartsStatus').textContent = 'Check the parts from every side (drag to rotate). Wrong spot? Pick the right part in the list, then click the patch or brush over it. Then confirm.';
  } catch (e) { $('rxPartsStatus').textContent = cleanErr(e); }
  finally { $('rxIdentify').disabled = !(RX.prep && RX.prep.hasKey); }
};
$('rxConfirm').onclick = async () => {
  if (!PT.labels || !PT.parts.length) return;
  $('rxConfirm').disabled = true;
  try {
    const r = await withBusy('remix', 'Saving the parts…', () => api.partsConfirm({ subject: PT.subject, parts: PT.parts, labels: PT.labels, pupils: $('rxPupils').checked }));
    RX.regions = r.regions; RX.labels = r.labels; RX.estimates = r.estimates; RX.variations = []; $('rxResults').innerHTML = '';
    const p = RX.prep;
    $('rxInfo').textContent = `${r.regions.length} parts${r.pupilsAdded ? ` (pupils added on ${r.pupilsAdded} eye${r.pupilsAdded === 1 ? '' : 's'})` : ''}. ${p.inventory.count} filaments ${p.inventory.onHand ? 'on hand' : 'in your inventory'}; up to ${p.maxColors} colors (one per toolhead).${p.inventory.note ? ' ' + p.inventory.note : ''}`;
    $('rxStatus').textContent = !p.hasKey ? 'Color remix needs a Claude API key (Settings).' : '';
    rxStep(2);
  } catch (e) { $('rxPartsStatus').textContent = cleanErr(e); }
  finally { $('rxConfirm').disabled = false; }
};

// ----- step 2: colors -----
// attach the confirmed parts to what the main 3D view shows (it reloads at times)
async function ensureRegions() {
  if (RX.labels && RX.prep && RX.prep.plateIndex === state.plateIndex) {
    const mapped = viewer.setRegions(state.analysis.preview, RX.labels);
    if (mapped && mapped >= modelTris(state.analysis.preview) * 0.9) return true;
  }
  $('rxStatus').textContent = 'The model changed. Check the parts again and confirm.';
  await ensurePrep(); rxStep(1);
  return false;
}
async function openRemix() {
  if (!state.file) { toast('Open a model first.', 3000); return; }
  const inv = await api.inventoryStatus().catch(() => ({ set: false }));
  if (!inv.set || !inv.ok) {
    toast(inv.set ? `Couldn’t read your filament inventory: ${inv.error}` : 'Color remix picks from the filament you have. Add yours here first.', 7000);
    showFilament(true);
    return;
  }
  $('rxUndo').classList.toggle('hidden', !state.remixApplied);
  $('remixDialog').showModal();
  rxStep(RX.labels ? 2 : 1);
  if (!(await ensurePrep())) return;
  if (RX.pvFor !== RX.prep) showParts();
  rxStep(RX.labels ? 2 : 1);
}
$('remixBtn').onclick = openRemix;
$('rxClose').onclick = () => { $('remixDialog').close(); };
$('remixDialog').addEventListener('close', () => { viewer.showRegionColors(null); pushColors(); });
$('rxGo').onclick = async () => {
  if (!RX.prep || !RX.labels) return;
  const count = rxTotal();
  if (!count) return;
  const styles = Object.entries(RX.counts).map(([id, n]) => ({ id, count: n }));
  $('rxGo').disabled = true; $('rxStatus').textContent = `Designing ${count} color scheme${count === 1 ? '' : 's'}… (usually under a minute)`;
  try {
    if (!(await ensureRegions())) return;
    const ids = RX.regions.map(r => r.id);
    const shots = viewer.regionMapShots(ids, ['iso', 'front', 'back', 'side', 'top'], 'part');
    viewer.showRegionColors(null); pushColors();
    const real = viewer.thumbnails([700])[0];
    const images = [{ label: 'The model in its current colours', dataUrl: real.dataUrl }, ...shots];
    const r = await withBusy('remix', 'Designing color schemes…', () => api.remixRun({ styles, custom: $('rxCustom').value.trim(), extras: $('rxExtras').checked, material: $('rxMaterial').value, images }));
    RX.variations = r.variations;
    viewer.setRegions(state.analysis.preview, RX.labels);
    RX.previews = r.variations.map(v => viewer.regionPreview(schemeHex(v)));
    viewer.showRegionColors(null); pushColors();
    rxShowGrid();
    $('rxStatus').textContent = 'Click a picture to see it larger in 3D.';
    renderRemix();
  } catch (e) { $('rxStatus').textContent = cleanErr(e); }
  finally { rxCost(); }
};
const schemeHex = (v) => Object.fromEntries(Object.entries(v.assign).map(([rid, fid]) => [rid, (v.tools.find(t => t.fid === fid) || {}).hex || '#999']));
function rxShowGrid() { $('rxBig').classList.add('hidden'); $('rxResults').classList.remove('hidden'); }
async function rxShowBig(i) {
  const v = RX.variations[i];
  if (!v || !(await ensureRegions())) return;
  $('rxResults').classList.add('hidden'); $('rxBig').classList.remove('hidden');
  $('rxBigTitle').textContent = v.name;
  if (!RX.big) RX.big = new ModelViewer($('rxBigView'));
  RX.big.load(state.analysis.preview);
  RX.big.setFilamentColors(Object.fromEntries(state.slots.map(s => [s.slot, s.color])));
  RX.big.setRegions(state.analysis.preview, RX.labels);
  RX.big.showRegionColors(schemeHex(v));
  requestAnimationFrame(() => { window.dispatchEvent(new Event('resize')); RX.big.fit('iso'); });
  const card = $('rxResults').querySelector(`.rx-card[data-i="${i}"]`);
  const byPart = Object.entries(v.assign).map(([rid, fid]) => { const part = RX.regions.find(r => r.id === +rid), t = v.tools.find(x => x.fid === fid); return part && t ? `<li><span class="sw" style="background:${esc(t.hex)}"></span>${esc(part.name)}: ${esc(t.color || t.name)}</li>` : ''; }).join('');
  $('rxBigSide').innerHTML = `<p>${esc(v.description)}</p>${card ? card.querySelector('.rx-tools').outerHTML : ''}
    <h4 style="margin:6px 0 0">By part</h4><ul class="rx-tools">${byPart}</ul>
    ${v.pauses.length ? `<p class="hint">${v.pauses.map(p => `At ${p.z} mm the print pauses: swap T${p.tool} for ${esc(p.to.color || '')}.`).join(' ')}</p>` : ''}
    <div class="row-btns"><button class="btn primary" data-apply="${i}">Apply to model</button></div>`;
  $('rxBigSide').querySelector('[data-apply]').onclick = (e) => $('rxResults').onclick({ target: e.target });
}
$('rxBigBack').onclick = rxShowGrid;

function renderRemix() {
  $('rxResults').innerHTML = RX.variations.map((v, i) => `<div class="rx-card" data-i="${i}">
    <img src="${RX.previews[i]}" alt="${esc(v.name)}" data-preview="${i}" title="Click to see it larger in 3D">
    ${v.style ? `<span class="rx-tag">${esc((RX_STYLES.find(x => x[0] === v.style) || [0, v.style])[1])}</span>` : ''}<h3>${esc(v.name)}</h3><p>${esc(v.description)}</p>
    <ul class="rx-tools">${v.tools.map(t => `<li><span class="sw" style="background:${esc(t.hex)}"></span><b>T${t.tool}${t.from ? ` from ${t.from} mm` : ''}</b> ${esc(t.name)} <span class="muted">${esc(t.type)}${t.spools ? `, ${t.spools} spool${t.spools === 1 ? '' : 's'}` : ''}</span></li>`).join('')}</ul>
    ${v.pauses.length ? `<p class="hint">${v.pauses.length} filament swap${v.pauses.length === 1 ? '' : 's'} during the print.</p>` : ''}
    ${v.notes.length ? `<ul class="rx-notes">${v.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <div class="row-btns"><button class="btn primary" data-apply="${i}">Apply to model</button></div>
  </div>`).join('');
}
$('rxResults').onclick = async (e) => {
  const pv = e.target.closest('[data-preview]');
  if (pv) { rxShowBig(+pv.dataset.preview); return; }
  const ap = e.target.closest('[data-apply]');
  if (!ap) return;
  try {
    const r = await withBusy('remix', 'Painting the colors into the model…', () => api.remixApply({ index: +ap.dataset.apply }));
    state.slots = r.slots.map(s => ({ slot: s.slot, type: s.type, preset: s.preset || matchPreset(s.type), color: s.color }));
    state.remixApplied = true; state.compare = null; state.result = null;
    $('remixDialog').close();
    renderMaterials(); await prepare();
    toast(`Applied “${r.name}”. The colors are painted into the model and the toolheads are set to your filaments.${r.swaps.length ? ' ' + r.swaps.join(' ') : ''} Save it with Save as 3MF.`, r.swaps.length ? 16000 : 8000);
    // the parts stay remembered for this shape, so another remix starts from them
    resetRemix();
    guideEvent('remixed');
  } catch (err) { $('rxStatus').textContent = cleanErr(err); }
};
$('rxUndo').onclick = async () => {
  if (await api.remixUndo()) { state.remixApplied = false; $('remixDialog').close(); resetRemix(); await prepare(); toast('Remix undone: back to the model’s own colors.', 5000); }
};

// ---------- Filament: the built-in filament inventory, shown over the whole window ----------
// renderer/filament/ runs in an iframe (its own page and styles) and talks to the app through window.advisor here.
function showFilament(on) {
  const view = $('filamentView');
  if (on && !view.querySelector('iframe')) {
    const f = document.createElement('iframe');
    f.src = 'filament/index.html'; f.title = 'Filament inventory';
    f.addEventListener('load', () => { try { glossary.attach(f.contentDocument, f); } catch (e) { console.warn('glossary', e); } });
    view.appendChild(f);
  }
  document.body.classList.toggle('filament-open', on);
  $('filamentBtn').textContent = on ? 'Back to model' : 'Filament';
  $('filamentBtn').setAttribute('aria-pressed', String(on));
  if (on) { view.querySelector('iframe').focus(); guideEvent('filament'); }
  else { SHOP.key = ''; renderShopping(); }   // what's on hand may have changed
}
$('glossaryBtn').onclick = () => glossary.open();
$('filamentBtn').onclick = () => showFilament(!document.body.classList.contains('filament-open'));


// rough cost of getting recommendations, shown under the button
function showAnalyzeCost() {
  const m = MODELS[state.config && state.config.model];
  $('analyzeCost').textContent = state.config && state.config.aiMode === 'chat' ? 'Free chatbot mode: no API cost.' : m ? `About ${m.cost.replace(/^~/, '').replace(/ per analysis$/, '')} with ${m.name}` : '';
  // a diagnosis sends the printed file's details and photos: about the same as an analysis
  $('tsCost').textContent = state.config && state.config.aiMode === 'chat' ? 'Free chatbot mode: no API cost.' : m ? `About ${m.cost.replace(/^~/, '').replace(/ per analysis$/, '')} with ${m.name} (a bit more with photos)` : '';
}

// ---------- print name: the short, speakable name for saved and sent files ----------
function showPrintName(p) {
  if (!p || !p.name || !state.file) { $('printNameBox').classList.add('hidden'); return; }
  $('printNameBox').classList.remove('hidden');
  $('printNameBtn').textContent = `“${p.name}”`;
  $('printNameBtn').title = p.source === 'ai' ? 'Named by AI from the model. Click to change.' : p.source === 'user' ? 'Your name for this print. Click to change.' : 'Cleaned up from the file name. Click to change.';
}
api.onPrintName(showPrintName);
$('printNameBtn').onclick = () => {
  const inp = $('printNameInput');
  inp.value = $('printNameBtn').textContent.replace(/[“”]/g, '');
  $('printNameBtn').classList.add('hidden'); inp.classList.remove('hidden'); inp.focus(); inp.select();
};
async function commitPrintName(save) {
  const inp = $('printNameInput');
  if (inp.classList.contains('hidden')) return;
  inp.classList.add('hidden'); $('printNameBtn').classList.remove('hidden');
  if (save && inp.value.trim()) showPrintName(await api.setPrintName(inp.value));
}
$('printNameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') commitPrintName(true); if (e.key === 'Escape') commitPrintName(false); });
$('printNameInput').addEventListener('blur', () => commitPrintName(true));

// ---------- File menu ----------
async function saveSessionFile(saveAs = false) {
  if (!state.file) { toast('Open a model first, then save the session.', 4000); return; }
  try {
    const r = await api.sessionExport({ data: sessionPayload(), saveAs });
    if (!r) return;
    document.title = `${r.name} · AI 3D Print Advisor Studio`;
    toast(`Session saved as ${r.name}. Open it anytime with File → Open Session (or double-click it) to pick up exactly where you left off.`, 7000, () => api.showInFolder(r.path));
  } catch (e) { toast(`Couldn’t save the session: ${cleanErr(e)}`, 8000); }
}
async function openSessionFile(file = null) {
  try {
    const r = await withBusy('session', 'Opening the session…', () => api.sessionImport(file));
    if (!r) return;
    await openFile(api.openPath(r.filePath), r.state, { fromSession: true });
    await api.sessionOpened();
    if (r.state && r.state.selectedVariant) { state.selectedVariant = r.state.selectedVariant; renderCompare(); }
    document.title = `${r.name} · AI 3D Print Advisor Studio`;
    toast(`Opened ${r.name}${r.savedAt ? `, saved ${new Date(r.savedAt).toLocaleString()}` : ''}.${r.usingCopy ? ' The original model file was moved or changed, so the copy saved inside the session is used.' : ''}`, 7000);
  } catch (e) { toast(`Couldn’t open the session: ${cleanErr(e)}`, 8000); }
}
async function closeModel() {
  await api.sessionClear().catch(() => {});
  await api.sessionForgetFile().catch(() => {});
  location.reload();
}
// ---------- export for Bambu Lab printers ----------
async function openBambuExport() {
  if (!state.file) { toast('Open a model first.', 3000); return; }
  const dlg = $('bambuDialog');
  $('bxStatus').textContent = 'Looking for Bambu Studio…'; $('bxPrinter').innerHTML = ''; $('bxExport').disabled = true;
  $('bxVersion').querySelector('[value=recommended]').disabled = !state.result;
  $('bxVersion').value = state.result ? 'recommended' : 'original';
  dlg.showModal();
  const info = await api.bambuInfo().catch(() => ({ found: false }));
  $('bxLocate').classList.toggle('hidden', info.found);
  if (!info.found) { $('bxStatus').textContent = 'Bambu Studio wasn’t found. It’s free from bambulab.com; install it, or locate it if it’s already installed.'; return; }
  const pref = ['Bambu Lab X1 Carbon 0.4 nozzle', 'Bambu Lab P1S 0.4 nozzle', 'Bambu Lab A1 0.4 nozzle'];
  const list = info.printers.filter(n => /0\.4 nozzle/.test(n));
  $('bxPrinter').innerHTML = list.map(n => `<option ${n === pref.find(p => list.includes(p)) ? 'selected' : ''}>${esc(n)}</option>`).join('');
  $('bxStatus').textContent = `Using ${info.label} (${info.exe}).`;
  $('bxExport').disabled = false;
}
$('bxClose').onclick = () => $('bambuDialog').close();
$('bxLocate').onclick = async () => { if (await api.bambuLocate()) openBambuExport(); };
$('bxExport').onclick = async () => {
  const def = variantDef($('bxVersion').value);
  $('bxExport').disabled = true; $('bxStatus').textContent = 'Converting and exporting with Bambu Studio… (a minute or two)';
  try {
    const r = await withBusy('bambu', 'Exporting for Bambu Lab…', () => api.exportBambu({ machine: $('bxPrinter').value, changes: def.changes, rotations: def.rotations || state.rotations, plateIndex: state.plateIndex, variantName: def.name, thumbs: fileThumbs() }));
    if (r) { $('bambuDialog').close(); toast(`Saved the ${r.machine.replace(/ 0\.4 nozzle$/, '')} version (${r.how}). It’s a Bambu Studio project, ready to upload to MakerWorld.`, 9000, () => api.showInFolder(r.path)); }
    else $('bxStatus').textContent = '';
  } catch (e) { $('bxStatus').textContent = cleanErr(e); }
  finally { $('bxExport').disabled = false; }
};

// ---------- convert without AI ----------
$('quickSaveBtn').onclick = () => { if (!state.file) { toast('Open a model first.', 3000); return; } save3mf(null, { noAI: true }); };

const BC = { files: [], outDir: null, running: false, status: [] };
function renderBatch() {
  const icon = { waiting: '·', working: '…', done: '✓', failed: '✕', skipped: '–' };
  $('bcList').innerHTML = BC.files.map((f, i) => {
    const st = BC.status[i] || { status: 'waiting', note: '' };
    return `<li><span class="st ${st.status}">${icon[st.status] || '·'}</span><span class="nm">${esc(f.split(/[\\/]/).pop())}${st.note ? `<span class="nt">${esc(st.note)}</span>` : ''}${st.out ? `<span class="nt">Saved as ${esc(st.out.split(/[\\/]/).pop())} <button class="link" data-show="${i}">Show</button></span>` : ''}</span>${BC.running ? '' : `<button class="link" data-remove="${i}" aria-label="Remove">✕</button>`}</li>`;
  }).join('');
  $('bcStart').disabled = BC.running || !BC.files.length;
  $('bcStop').classList.toggle('hidden', !BC.running);
  $('bcFolder').textContent = BC.outDir || '';
}
function openBatch(paths = []) {
  if (!BC.running) { const seen = new Set(BC.files); for (const p of paths) if (!seen.has(p)) { BC.files.push(p); BC.status.push(null); } }
  $('bcSummary').textContent = '';
  renderBatch();
  if (!$('batchDialog').open) $('batchDialog').showModal();
}
$('bcAdd').onclick = async () => openBatch(await api.batchChoose());
$('bcClear').onclick = () => { if (!BC.running) { BC.files = []; BC.status = []; renderBatch(); } };
$('bcPick').onclick = async () => { const d = await api.batchFolder(); if (d) { BC.outDir = d; document.querySelector('input[name=bcWhere][value=folder]').checked = true; renderBatch(); } };
$('bcClose').onclick = () => $('batchDialog').close();
$('bcStop').onclick = () => { api.batchCancel(); $('bcStop').disabled = true; };
$('bcList').onclick = (e) => {
  const r = e.target.closest('[data-remove]'); if (r) { BC.files.splice(+r.dataset.remove, 1); BC.status.splice(+r.dataset.remove, 1); renderBatch(); return; }
  const s2 = e.target.closest('[data-show]'); if (s2) api.showInFolder(BC.status[+s2.dataset.show].out);
};
api.onBatchProgress(({ i, status, note, out }) => { BC.status[i] = { status, note, out }; renderBatch(); });
$('bcStart').onclick = async () => {
  const toFolder = document.querySelector('input[name=bcWhere]:checked').value === 'folder';
  if (toFolder && !BC.outDir) { const d = await api.batchFolder(); if (!d) return; BC.outDir = d; }
  BC.running = true; BC.status = BC.files.map(() => ({ status: 'waiting', note: '' })); $('bcStop').disabled = false; renderBatch();
  try {
    const res = await api.batchConvert({ files: BC.files, outDir: toFolder ? BC.outDir : null });
    const ok = res.filter(r => r.ok).length;
    $('bcSummary').textContent = `${ok} of ${res.length} converted${ok < res.length ? `; ${res.length - ok} didn’t (see the list)` : ''}.`;
  } catch (e) { $('bcSummary').textContent = cleanErr(e); }
  finally { BC.running = false; renderBatch(); }
};

api.onMenu(({ action, arg }) => {
  if (action === 'batch') { openBatch(); return; }
  if (action === 'export-bambu') { openBambuExport(); return; }
  if (action === 'open-model') openFile(api.choose3mf());
  else if (action === 'open-session') openSessionFile(arg || null);
  else if (action === 'save-session') saveSessionFile(false);
  else if (action === 'save-session-as') saveSessionFile(true);
  else if (action === 'save-3mf') { if (state.file) save3mf(); else toast('Open a model first.', 3000); }
  else if (action === 'close-model') closeModel();
  else if (action === 'settings') openSettings();
  else if (action === 'guide') startGuide(state.result ? 5 : state.file ? 1 : 0);
});

async function offerPastAnalyses() {
  const list = await api.pastAnalyses().catch(() => []);
  const box = $('emptyFlow');
  if (!list.length || state.result) { box.textContent = 'Claude reviews the model’s shape and overhangs, a real slice of the original, your past prints, and the current Orca settings, then lists what to change.'; return; }
  const when = (iso) => new Date(iso).toLocaleString();
  const modelName = (m) => m === 'chatbot' ? 'free chatbot' : String(m).replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/^\w/, c => c.toUpperCase());
  box.innerHTML = `<b>You’ve analyzed this file before.</b> Reuse an earlier answer at no cost:
    <span class="past-list">${list.slice(0, 5).map((a, i) => `<button class="btn" data-past="${i}">${esc(when(a.at))} · ${esc(modelName(a.model))}${a.result && a.result.recipe ? ` · ${esc(a.result.recipe.name)}` : ''}</button>`).join('')}</span>`;
  box.querySelectorAll('[data-past]').forEach(b => b.onclick = () => {
    const a = list[Number(b.dataset.past)];
    state.result = a.result;
    if (a.slider != null) { $('slider').value = a.slider; drawLayers(); refreshRecipe(); }
    if (a.purpose) $('purpose').value = a.purpose;
    state.compare = null;
    renderResults(); renderStats();
    $('analyzeBtn').textContent = 'Get new recommendations';
    toast('Loaded the earlier recommendations. No new AI request was made.', 5000);
    saveSession();
  });
}

let restoreChecked = false;
async function maybeRestoreSession() {
  if (restoreChecked) return; restoreChecked = true;
  const s = await api.sessionGet().catch(() => null);
  if (!s || state.file) return;
  const name = s.filePath.split(/[\\/]/).pop();
  const restore = () => openFile(api.openPath(s.filePath), s.fileChanged ? { ...s, result: null } : s);
  if (s.autoRestore) { restore(); toast('The window had a problem and was reloaded. Your session was restored.', 7000); return; }
  const ago = Math.round((Date.now() - new Date(s.savedAt)) / 60000);
  const agoText = ago < 60 ? `${ago} min ago` : ago < 1440 ? `${Math.round(ago / 60)} h ago` : `${Math.round(ago / 1440)} days ago`;
  noticeWithActions(`Pick up where you left off? ${name}${s.result ? ' with its recommendations' : ''}${s.compareIds && s.compareIds.length ? ' and sliced comparisons' : ''}, saved ${agoText}.${s.fileChanged ? ' (The file has changed since, so recommendations will be fetched fresh.)' : ''}`, [
    { label: 'Restore', primary: true, fn: restore },
    { label: 'Start fresh', fn: () => api.sessionClear() },
  ]);
}
$('openBtn').onclick = () => openFile(api.choose3mf());
$('browseBtn').onclick = () => openFile(api.choose3mf());
api.onOpenFromOS(p => (/\.aipsession$/i.test(p) ? openSessionFile(p) : openFile(api.openPath(p))));
const drop = $('dropZone');
window.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragging'); });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) drop.classList.remove('dragging'); });
window.addEventListener('drop', e => {
  e.preventDefault(); drop.classList.remove('dragging');
  // several models at once: batch convert them
  const many = [...e.dataTransfer.files].filter(x => /\.3mf$/i.test(x.name));
  if (many.length > 1) { openBatch(many.map(x => api.pathForFile(x))); return; }
  const f = [...e.dataTransfer.files].find(x => /\.(3mf|aipsession)$/i.test(x.name));
  if (!f) { toast('That isn’t a .3mf model or a saved session. Drop a .3mf file, or an .aipsession file to reopen a session.', 5000); return; }
  if (/\.aipsession$/i.test(f.name)) openSessionFile(api.pathForFile(f));
  else openFile(api.openPath(api.pathForFile(f)));
});
drop.addEventListener('keydown', e => { if (e.key === 'Enter') openFile(api.choose3mf()); });

function matchPreset(type, preferred) {
  const list = state.info.filaments;
  if (!list.length) return '';
  if (preferred && list.some(f => f.name === preferred)) return preferred;
  const t = String(type || 'PLA').toUpperCase().replace('PETG-HF', 'PETG HF');
  return (list.find(f => f.group === 'Generic' && f.type.toUpperCase() === t) || list.find(f => f.type.toUpperCase() === t) || list.find(f => f.name === 'Generic PLA') || list[0]).name;
}
function initialSlots(filaments) {
  const src = filaments.length ? filaments : [{ slot: 1, type: 'PETG', color: DEFAULT_COLORS[0], preset: '' }];
  return src.map(f => {
    const type = TYPES.find(t => t.toLowerCase() === String(f.type).toLowerCase()) || f.type || 'PLA';
    return { slot: f.slot, type, color: String(f.color).slice(0, 7), preset: matchPreset(type, f.preset) };
  });
}

function renderFileInfo() {
  const f = state.file;
  $('fileTitle').innerHTML = `<strong>${esc(f.fileName)}</strong>${f.printer ? ` <span>made for ${esc(f.printer)}</span>` : ''}`;
  drop.classList.add('compact');
  drop.querySelector('.drop-title').textContent = 'Drop another .3mf here to replace it';
  ['thumbBlock', 'plateBlock', 'materialBlock', 'prefBlock', 'viewerTools'].forEach(id => $(id).classList.remove('hidden'));
  $('viewerEmpty').classList.add('hidden');
  const imgs = f.images.filter(i => !/pick|small/i.test(i.label));
  $('thumbBlock').classList.toggle('hidden', !imgs.length);
  $('thumbs').innerHTML = imgs.map((i, n) => `<button data-n="${n}" title="${esc(i.label)}"><img src="${i.dataUrl}" alt="${esc(i.label)}"></button>`).join('');
  $('thumbs').querySelectorAll('button').forEach(b => b.onclick = () => {
    const i = imgs[Number(b.dataset.n)];
    $('lightboxImg').src = i.dataUrl; $('lightboxLabel').textContent = i.label; $('lightbox').showModal();
  });
  $('plateBlock').classList.toggle('hidden', f.plates.length < 2);
  $('plateSelect').innerHTML = f.plates.map(p => `<option value="${p.index}">Plate ${p.index}${p.name ? `: ${esc(p.name)}` : ''} (${p.objectCount} object${p.objectCount === 1 ? '' : 's'})</option>`).join('');
  state.plateIndex = f.plates[0]?.index || 1;
  $('analyzeBtn').textContent = 'Get recommended settings';
  $('orcaBtn').disabled = !state.info.available;
  $('orcaBtn').title = state.info.available ? 'Write this project with the current changes and open it in Snapmaker Orca' : 'Set the Snapmaker Orca location in Settings';
  renderMaterials(); renderResults(); renderCompare(); refreshRecipe();
}
$('plateSelect').onchange = e => { state.plateIndex = Number(e.target.value); state.compare = null; loadPlate(); };

async function prepare() {
  $('prepStatus').textContent = state.info.available ? 'Preparing the project for your printer…' : '';
  try {
    const r = await withBusy('prepare', state.info.available ? 'Preparing the project for your printer…' : 'Reading the project…', () => api.prepare(state.slots.map(s => ({ slot: s.slot, type: s.type, preset: s.preset, color: s.color }))));
    const notes = [...r.notes];
    if (r.slotMap) {
      // filaments were renumbered to fit the toolheads (e.g. 1, 3, 5 → T1, T2, T3): move the choices along
      const moved = state.slots.filter(x => r.slotMap[x.slot]).map(x => ({ ...x, slot: r.slotMap[x.slot] }));
      state.slots = moved.filter((x, i, a) => a.findIndex(y => y.slot === x.slot) === i).sort((a, b) => a.slot - b.slot);
      renderMaterials();
    }
    state.prepNotes = r.notes.filter(n => /^Corrected|^Kept the creator|^Converted|^Plain model/.test(n));
    if (!state.info.available) notes.push('Snapmaker Orca isn’t set up, so slicing and conversion are off. Set its location in Settings.');
    state.wrongPrinter = r.wrongPrinter || null;
    $('prepStatus').classList.toggle('prep-error', !!r.wrongPrinter);
    $('prepStatus').textContent = r.wrongPrinter
      ? `This file is still set up for the ${r.wrongPrinter.project}, not your ${r.wrongPrinter.printer}: converting it failed${r.error ? ` (${r.error})` : ''}. To keep your printer safe, the app won’t save, slice, send or analyze it. Open it in your slicer, choose your printer, save it, and open that copy here.`
      : notes.join(' ');
    if (r.wrongPrinter) toast(`This file couldn’t be converted to your ${r.wrongPrinter.printer}. See the red note on the left.`, 9000);
  } catch (e) { $('prepStatus').textContent = cleanErr(e); }
  await loadPlate();
  refreshRecipe();
}
const reprepare = debounce(async () => { state.compare = null; saveSession(); await prepare(); if (state.result) { toast('Toolheads changed. Get new recommendations to update the plan.', 5000); refreshChecks(); } }, 500);

async function loadPlate() {
  const a = await withBusy('measure', 'Measuring the model and scoring orientations…', () => api.analyzePlate({ plateIndex: state.plateIndex, rotations: state.rotations }));
  state.analysis = a;
  checkBlockers();
  checkHeavy();
  // assemblies: show the "fit together" choice; the user's choice wins over the guess
  // always offered: a piece alone on its plate can still snap or glue to pieces on other plates
  $('fitRow').classList.remove('hidden');
  state.assemblyGuess = !!a.assemblyGuess;
  $('fitTogether').checked = state.assemblyChoice ?? state.assemblyGuess;
  api.setAssembly({ assembly: $('fitTogether').checked, guess: state.assemblyGuess }).catch(() => {});
  let added = false;
  for (const e of a.totals.extrudersUsed) {
    if (e <= 4 && !state.slots.find(s => s.slot === e)) { const type = state.slots[0]?.type || 'PETG'; state.slots.push({ slot: e, type, preset: matchPreset(type), color: DEFAULT_COLORS[(e - 1) % 4] }); added = true; }
  }
  state.slots.sort((x, y) => x.slot - y.slot);
  renderMaterials();
  viewer.load(a.preview);
  const notes = [];
  if (a.totals.parkedObjects) notes.push(`${a.totals.parkedObjects} object${a.totals.parkedObjects === 1 ? '' : 's'} parked off the plate ${a.totals.parkedObjects === 1 ? 'is' : 'are'} ignored, as in Orca.`);
  if (a.totals.previewSimplified) notes.push('Preview simplified for speed. Measurements use the full mesh.');
  $('viewerNote').classList.toggle('hidden', !notes.length);
  $('viewerNote').textContent = notes.join(' ');
  renderStats(); renderOrientation();
  if (added) reprepare();
}

// ---------- materials ----------
function presetOptions(sel) {
  const groups = {};
  for (const f of state.info.filaments) (groups[f.group] ||= []).push(f);
  return Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(f => `<option value="${esc(f.name)}" ${f.name === sel ? 'selected' : ''}>${esc(f.name.replace(/ @U1.*$/, ''))}</option>`).join('')}</optgroup>`).join('');
}
function renderMaterials() {
  const used = new Set(state.analysis?.totals.extrudersUsed || [1]);
  const usePresets = state.info.filaments.length > 0;
  $('materials').innerHTML = state.slots.map(s => `
    <div class="mat-row ${used.has(s.slot) ? '' : 'unused'}" data-slot="${s.slot}">
      <label class="swatch" style="background:${esc(s.color)}" title="Filament color"><input type="color" value="${esc(s.color)}"></label>
      <span class="tool">T${s.slot}</span>
      <select aria-label="Filament for toolhead ${s.slot}">${usePresets ? presetOptions(s.preset) : TYPES.map(m => `<option ${m === s.type ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
      ${used.has(s.slot) ? '<span></span>' : `<button class="remove" title="Remove T${s.slot}" aria-label="Remove toolhead ${s.slot}">×</button>`}
    </div>`).join('');
  $('materials').querySelectorAll('.mat-row').forEach(row => {
    const slot = state.slots.find(s => s.slot === Number(row.dataset.slot));
    row.querySelector('select').onchange = e => {
      if (usePresets) { slot.preset = e.target.value; slot.type = (state.info.filaments.find(f => f.name === slot.preset) || {}).type || slot.type; }
      else slot.type = e.target.value;
      reprepare();
    };
    row.querySelector('input[type=color]').oninput = e => { slot.color = e.target.value; row.querySelector('.swatch').style.background = slot.color; pushColors(); };
    row.querySelector('input[type=color]').onchange = () => reprepare();
    const rm = row.querySelector('.remove');
    if (rm) rm.onclick = () => { state.slots = state.slots.filter(s => s !== slot); renderMaterials(); reprepare(); };
  });
  $('addSlotBtn').classList.toggle('hidden', state.slots.length >= 4);
  pushColors();
  renderShopping().catch(() => {});
}
$('addSlotBtn').onclick = () => {
  const free = [1, 2, 3, 4].find(n => !state.slots.find(s => s.slot === n));
  if (!free) return;
  state.slots.push({ slot: free, type: 'PLA', preset: matchPreset('PLA'), color: DEFAULT_COLORS[free - 1] });
  state.slots.sort((x, y) => x.slot - y.slot);
  renderMaterials(); reprepare();
};
// ---------- the model's own colours vs. the filament inventory: what to buy ----------
const SHOP = { key: '', data: null, found: null };
async function renderShopping() {
  const used = new Set(state.analysis?.totals.extrudersUsed || []);
  const slots = state.slots.filter(s => used.has(s.slot)).map(s => ({ slot: s.slot, type: s.type, color: s.color }));
  const key = JSON.stringify(slots);
  if (!state.file || !slots.length) { $('shop').classList.add('hidden'); return; }
  if (key !== SHOP.key) {
    SHOP.key = key; SHOP.found = null;
    SHOP.data = await api.shoppingCheck({ slots }).catch(() => null);
    if (SHOP.key !== key) return; // changed again meanwhile
  }
  const d = SHOP.data;
  const need = d && d.ok ? d.rows.filter(r => r.status !== 'have') : [];
  $('shop').classList.toggle('hidden', !need.length);
  if (!need.length) return;
  const found = SHOP.found;
  $('shop').innerHTML = `<h4>Colors you may not have</h4>
    <ul>${need.map(r => {
      const prods = found && (found.results.find(x => x.slot === r.slot) || {}).products;
      return `<li><span class="sw" style="background:${esc(r.color)}"></span><div>
        <b>T${r.slot}: ${esc(r.words)} ${esc(r.type)}</b> <span class="muted">${esc(r.color.toUpperCase())}</span><br>
        <span class="muted">${r.have ? (r.status === 'close' ? `Closest you have: ${esc(r.have.name)} (similar)` : `Closest you have: ${esc(r.have.name)} (not a close match)`) : `No ${esc(r.type)} in your inventory`}</span>
        <div class="links"><a href="${esc(r.amazon)}" target="_blank" rel="noopener">Search Amazon</a></div>
        ${prods ? (prods.length ? prods.map(p => `<div class="prod"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>${p.price ? ` <b>${esc(p.price)}</b>` : ''} <span class="muted">${esc(p.colorMatch || '')}${p.why ? ' · ' + esc(p.why) : ''}</span></div>`).join('') : '<div class="muted">No exact product found.</div>') : ''}
      </div></li>`;
    }).join('')}</ul>
    ${!found && d.hasKey ? `<div class="row-btns"><button class="btn small" id="shopFind">Find exact products with AI</button> <span class="cost-line">${d.findCost ? `about ${money(d.findCost.low)}–${money(d.findCost.high)}` : ''}</span></div>` : ''}
    ${d.onHand ? '' : '<span class="muted">Compared with everything you’ve bought; import your inventory on the Filament screen to compare with what’s on hand.</span>'}`;
  const b = $('shop').querySelector('#shopFind');
  if (b) b.onclick = async () => {
    b.disabled = true; b.textContent = 'Searching…';
    try { SHOP.found = await withBusy('shop', 'Searching the web for matching filaments…', () => api.shoppingFind({ rows: need })); renderShopping(); }
    catch (e) { toast(cleanErr(e), 7000); b.disabled = false; b.textContent = 'Find exact products with AI'; }
  };
}
function pushColors() { viewer.setFilamentColors(Object.fromEntries(state.slots.map(s => [s.slot, s.color]))); }

// ---------- orientation ----------
function renderOrientation() {
  const objs = (state.analysis?.objects || []).filter(o => o.orientationOptions && o.orientationOptions.length);
  $('orientBlock').classList.toggle('hidden', !objs.length);
  if (!objs.length) return;
  if (!objs.find(o => o.itemIndex === state.orientObj)) state.orientObj = objs[0].itemIndex;
  $('orientObject').classList.toggle('hidden', objs.length < 2);
  $('orientObject').innerHTML = objs.map(o => `<option value="${o.itemIndex}" ${o.itemIndex === state.orientObj ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  const obj = objs.find(o => o.itemIndex === state.orientObj);
  const current = state.rotations[obj.itemIndex];
  const bestId = obj.orientationOptions[0].id;
  const list = obj.orientationShortlist || obj.orientationOptions.slice(0, 4);
  $('orientList').innerHTML = list.map(o => {
    const on = current ? JSON.stringify(o.rotation) === JSON.stringify(current) : o.isCurrent;
    return `<label class="orient-opt ${o.id === bestId ? 'best' : ''} ${o.unstable ? 'unstable' : ''}" aria-checked="${on}">
      <input type="radio" name="orient" value="${esc(o.id)}" ${on ? 'checked' : ''}>
      <span class="t">${esc(o.isCurrent ? 'As placed in the file' : o.label)}</span>
      <span class="m">${o.overhangCm2} cm² overhang, ${o.contactCm2} cm² on the bed, ${o.heightMm} mm (${inch(o.heightMm)} in) tall${o.fits ? '' : ', too big'}</span>
    </label>`;
  }).join('');
  $('orientList').querySelectorAll('input').forEach(inp => inp.onchange = () => {
    const o = obj.orientationOptions.find(x => x.id === inp.value);
    setRotation(obj.itemIndex, o.isCurrent ? null : o.rotation);
    guideEvent('oriented');
  });
}
$('orientObject').onchange = e => { state.orientObj = Number(e.target.value); renderOrientation(); };
async function setRotation(itemIndex, rotation) {
  if (rotation) state.rotations[itemIndex] = rotation; else delete state.rotations[itemIndex];
  saveSession();
  state.compare = null;
  await loadPlate();
  refreshChecks();
}

// ---------- viewer controls ----------
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-checked', String(x === b)));
  viewer.setMode(b.dataset.mode);
  $('legend').classList.toggle('hidden', b.dataset.mode !== 'overhang');
});
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => viewer.fit(b.dataset.view));

// ---------- measurement strip ----------
const fmt = n => (Math.round(n * 10) / 10).toLocaleString();
const inch = mm => (mm / 25.4).toFixed(2);
const compact = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);
// rounded to whole minutes first, so 1 h 59.6 min shows as 2h 0m, not 1h 60m
const hm = s => { if (!s && s !== 0) return '—'; const t = Math.round(s / 60), h = Math.floor(t / 60), m = t % 60; return h ? `${h}h ${m}m` : `${m}m`; };
function renderStats() {
  const t = state.analysis.totals, objs = state.analysis.objects;
  const footprint = objs.reduce((s, o) => s + (o.sizeMm.x * o.sizeMm.y) / 100, 0);
  const contactPct = footprint ? Math.round(100 * t.bedContactAreaCm2 / footprint) : 0;
  const orig = state.compare?.results?.find(r => r.id === 'original' && r.ok) || (state.result?.originalSlice ? { ...state.result.originalSlice, ok: true } : null);
  const cells = [
    { k: 'Size in mm (X × Y × Z)', v: `${fmt(t.sizeMm.x)} × ${fmt(t.sizeMm.y)} × ${fmt(t.sizeMm.z)}`, sub: t.fitsBuildVolume ? 'fits the U1' : 'larger than 270 mm', cls: t.fitsBuildVolume ? '' : 'bad' },
    { k: 'Size in inches', v: `${inch(t.sizeMm.x)} × ${inch(t.sizeMm.y)} × ${inch(t.sizeMm.z)}`, sub: 'U1 prints up to 10.6 in' },
    { k: 'Solid volume', v: `${fmt(t.volumeCm3)} cm³`, sub: `${(t.volumeCm3 / 16.387).toFixed(2)} in³, ${t.objectCount} object${t.objectCount === 1 ? '' : 's'}` },
    { k: 'Overhangs past 45°', v: `${t.overhangPercent45}%`, sub: `${fmt(t.overhangAreaBelow45Cm2)} cm²`, cls: t.overhangPercent45 > 15 ? 'bad' : t.overhangPercent45 > 4 ? 'warn' : '' },
    { k: 'Bed contact', v: `${fmt(t.bedContactAreaCm2)} cm²`, sub: `${contactPct}% of footprint`, cls: t.bedContactAreaCm2 < 0.2 ? 'bad' : contactPct < 12 && t.sizeMm.z > 30 ? 'warn' : '' },
    { k: 'Height to base', v: `${t.tipRatio.toFixed(1)} : 1`, sub: t.tipRatio > 5 ? 'high tipping risk' : t.tipRatio > 3 ? 'may wobble' : 'stable', cls: t.tipRatio > 5 ? 'bad' : t.tipRatio > 3 ? 'warn' : '' },
    { k: 'Colors', v: `${t.extrudersUsed.length}`, sub: t.paintedTriangles ? `painted on ${t.paintedTriangles.toLocaleString()} faces` : t.multiColor ? 'per-part colors' : 'single toolhead' },
    { k: 'Triangles', v: compact(t.triangles), sub: t.flatTopAreaCm2 ? `${fmt(t.flatTopAreaCm2)} cm² flat tops` : 'no flat tops' },
  ];
  if (orig) cells.push({ k: 'Sliced (original)', v: hm(orig.timeSeconds), sub: `${fmt(orig.grams || 0)} g filament` });
  $('stats').innerHTML = cells.map(c => `<div class="stat ${c.cls || ''}"><div class="v">${esc(c.v)}</div><div class="k">${esc(c.k)}</div><div class="sub">${esc(c.sub || '')}</div></div>`).join('');
  $('stats').classList.remove('hidden');
}

// ---------- Claude ----------
$('analyzeBtn').onclick = async () => {
  if (!state.file || state.busy) return;
  if (state.config.aiMode !== 'chat' && !state.config.hasKey) { openSettings(); return; }
  state.busy = true; $('analyzeBtn').disabled = true; showTab('recs');
  const started = Date.now();
  $('resultsEmpty').classList.add('hidden');
  const body = $('resultsBody');
  body.classList.remove('hidden');
  body.innerHTML = `<div class="working"><h2>Reviewing ${esc(state.file.fileName)}</h2><div class="bar"></div><p class="progress-line">Measuring the model…</p><p class="hint" id="elapsed"></p></div>`;
  const timer = setInterval(() => { const el = $('elapsed'); if (el) el.textContent = `${Math.round((Date.now() - started) / 1000)} s`; }, 1000);
  try {
    const renders = viewer.capture();
    const used = state.analysis.totals.extrudersUsed || [];
    const materials = state.slots.map(s => ({ toolhead: `T${s.slot}`, material: s.type, preset: s.preset || null, color: s.color, usedOnThisPlate: used.includes(s.slot) }));
    setBusy('claude', 'Getting recommendations…');
    let res = await api.runClaude({ plateIndex: state.plateIndex, slider: Number($('slider').value), materials, purpose: $('purpose').value.trim(), renders, assembly: $('fitTogether').checked });
    if (res && res.chat) {
      body.innerHTML = '<div class="working"><p>Waiting for the chatbot’s answer. Follow the steps in the window that just opened.</p></div>';
      res = await askChatbot(res);
      if (!res) { state.result ? renderResults() : (body.classList.add('hidden'), $('resultsEmpty').classList.remove('hidden')); return; }
    }
    state.result = res;
    state.compare = null;
    saveSession();
    setTimeout(() => guideEvent('analyzed'), 50);
    renderResults(); renderStats();
    $('analyzeBtn').textContent = 'Get new recommendations';
    // The recommended version isn't sliced here: the recommendations only need the slice of the original (made
    // before asking the AI). Slicing it is up to the user in Compare slices; sending a print slices it if needed.
    renderCompare();
  } catch (e) {
    body.innerHTML = `<div class="error"><b>Analysis failed.</b><p>${esc(cleanErr(e))}</p></div>`;
  } finally { clearInterval(timer); clearBusy('claude'); state.busy = false; $('analyzeBtn').disabled = false; }
};

function renderResults() {
  const body = $('resultsBody');
  if (!state.result) { body.classList.add('hidden'); $('resultsEmpty').classList.remove('hidden'); return; }
  const { plan, rows, recipe, orientationChoices, sliceError, usedHistory } = state.result;
  const order = ['Quality', 'Strength', 'Speed', 'Support', 'Adhesion', 'Multi-color', 'Filament', 'Other'];
  const claudeRows = rows.filter(r => r.source === 'claude');
  const recipeRows = rows.filter(r => r.source === 'recipe' && !claudeRows.find(c => c.id === r.id));
  const groups = {};
  for (const r of claudeRows) (groups[r.group] ||= []).push(r);
  const orientHtml = orientationChoices.map((c, i) => {
    const applied = JSON.stringify(state.rotations[c.itemIndex]) === JSON.stringify(c.option.rotation);
    return `<div class="callout"><b>Reorient ${esc(c.objectName)}: ${esc(c.option.label)}.</b> ${esc(c.reason)}
      <div class="row">${applied ? '<span class="ok-line">Applied</span>' : `<button class="btn primary" data-orient="${i}">Apply this orientation</button>`}</div></div>`;
  }).join('');
  body.innerHTML = `
    <div class="actions">
      <span class="count" id="selCount"></span>
      <button class="btn" id="copyBtn" title="Copy a to-do list of these changes, to make them by hand in your slicer">Copy checklist</button>
      <button class="btn" id="presetBtn" title="Optional: save just the settings (without the model) as Orca presets you can import and reuse on other models">Save as Orca presets</button>
      <button class="btn primary" id="saveBtn" title="Save this model with the checked settings built in, as a project file you open in your slicer">Save as 3MF</button>
      <button class="btn primary" id="sendRecBtn" ${state.info.available ? '' : 'disabled title="Set the Snapmaker Orca location in Settings to send prints"'}>Send to printer…</button>
    </div>
    <p class="hint save-hint"><b>Which should I use?</b> <b>Save as 3MF</b> saves this model with the checked settings built in: open it in your slicer and print. That’s all most people need. <b>Orca presets</b> are optional: just the settings, to reuse on other models. To pick a faster or finer version first, use <button class="link" id="toCompare">Compare slices</button>.</p>
    <p class="summary">${esc(plan.summary)}</p>
    <p class="meta-line">Recipe: <b>${esc(recipe.name)}</b>. ${esc(recipe.about)}</p>
    ${plan.orientation ? `<p class="meta-line">Orientation: <b>${esc(plan.orientation)}</b></p>` : ''}
    ${plan.estimated_effect ? `<p class="meta-line">Expected effect: <b>${esc(plan.estimated_effect)}</b></p>` : ''}
    ${sliceError ? `<p class="meta-line">The original couldn’t be sliced for comparison: ${esc(sliceError)}</p>` : ''}
    ${orientHtml}
    <div id="checksBox"></div>
    ${plan.risks.length ? `<ul class="risks">${plan.risks.map(r => `<li class="${esc(r.severity)}"><b>${esc(r.title)}</b><span>${esc(r.detail)}</span></li>`).join('')}</ul>` : ''}
    ${order.filter(g => groups[g]).map(g => `<h3 class="group-title">${esc(g)}</h3>${groups[g].map(settingRow).join('')}`).join('')}
    ${recipeRows.length ? `<details class="recipe-group"><summary>From the ${esc(recipe.name)} recipe (${recipeRows.length})</summary>${recipeRows.map(settingRow).join('')}</details>` : ''}
    <div class="notes">
      ${plan.manual_steps.length ? `<h3>Do these by hand in Orca</h3><ol>${plan.manual_steps.map(m => `<li>${esc(m)}</li>`).join('')}</ol>` : ''}
      ${plan.material_notes ? `<h3>Materials</h3><p>${esc(plan.material_notes)}</p>` : ''}
      ${plan.multicolor_notes ? `<h3>Multi-color</h3><p>${esc(plan.multicolor_notes)}</p>` : ''}
      ${usedHistory && plan.history_notes ? `<h3>From your past prints</h3><p>${esc(plan.history_notes)}</p>` : ''}
    </div>`;
  body.querySelectorAll('[data-orient]').forEach(b => b.onclick = async () => {
    const c = orientationChoices[Number(b.dataset.orient)];
    await setRotation(c.itemIndex, c.option.rotation);
    renderResults();
  });
  body.querySelectorAll('.setting input').forEach(i => i.addEventListener('input', onRowEdit));
  $('copyBtn').onclick = copyChecklist; $('presetBtn').onclick = exportPresets; $('saveBtn').onclick = () => { save3mf(); guideEvent('saved'); };
  $('toCompare').onclick = () => showTab('compare');
  $('sendRecBtn').onclick = () => openSend('recommended');
  updateCount(); refreshChecks();
}

function settingRow(s) {
  const checked = s.action === 'change' && !s.unchanged && !s.invalid;
  const cur = s.current == null ? '<span class="cur none">not set</span>' : `<span class="cur">${esc(s.current)}</span>`;
  const list = s.options ? `<datalist id="dl-${esc(s.id)}">${s.options.map(o => `<option value="${esc(o)}">`).join('')}</datalist>` : '';
  return `
    <div class="setting ${s.unchanged ? 'same' : ''}" data-id="${esc(s.id)}">
      <input type="checkbox" ${checked ? 'checked' : ''} aria-label="Apply ${esc(s.label)}">
      <div class="name">${esc(s.label)}${s.slot ? ` <span class="tool">T${s.slot}</span>` : ''}
        ${s.source === 'claude' ? `<span class="pri ${esc(s.priority)}">${esc(s.priority)}</span>` : ''}
        ${s.action === 'check' ? '<span class="check">double-check</span>' : ''}</div>
      <div class="values">${cur}<span class="arrow" aria-hidden="true">›</span>
        <input type="text" value="${esc(s.recommended)}" ${s.options ? `list="dl-${esc(s.id)}"` : ''} class="${s.invalid ? 'bad' : ''}" aria-label="New value for ${esc(s.label)}"> <span class="unit">${esc(s.unit)}</span>${list}</div>
      <div class="err">${esc(s.invalid || '')}</div>
      ${s.reason ? `<div class="reason">${esc(s.reason)}</div>` : ''}
      <div class="where">${esc(s.gui)}</div>
    </div>`;
}

function rowById(id) { return state.result.rows.find(x => x.id === id); }
function selectedChanges() {
  return [...document.querySelectorAll('#resultsBody .setting')].filter(r => r.querySelector('input[type=checkbox]').checked).map(r => {
    const s = rowById(r.dataset.id);
    return { key: s.key, value: r.querySelector('input[type=text]').value.trim(), slot: s.slot, label: s.label, current: s.current, gui: s.gui, reason: s.reason, id: s.id, source: s.source };
  });
}
// light client-side validation mirror: enums and numbers; the main process re-validates on save
function quickValidate(s, v) {
  if (!v) return 'Enter a value';
  if (s.options && !s.options.includes(v)) return 'Pick one of the listed values';
  if (/^\d|^-/.test(s.recommended) && !/^-?\d+(\.\d+)?%?$/.test(v)) return 'Number only';
  return '';
}
function onRowEdit(e) {
  saveSession();
  const row = e.target.closest('.setting');
  const s = rowById(row.dataset.id);
  const txt = row.querySelector('input[type=text]');
  const err = quickValidate(s, txt.value.trim());
  txt.classList.toggle('bad', !!err);
  row.querySelector('.err').textContent = err;
  updateCount(); refreshChecks();
}
function updateCount() {
  const ch = selectedChanges();
  const bad = [...document.querySelectorAll('#resultsBody .setting')].some(r => r.querySelector('input[type=checkbox]').checked && r.querySelector('input.bad'));
  $('selCount').textContent = `${ch.length} change${ch.length === 1 ? '' : 's'} selected${Object.keys(state.rotations).length ? ', reoriented' : ''}${bad ? '. Fix the values marked in red first.' : ''}`;
  $('presetBtn').disabled = !ch.length || bad;
  $('saveBtn').disabled = bad || (!ch.length && !Object.keys(state.rotations).length);
}

const refreshChecks = debounce(async () => {
  if (!state.file) return;
  const changes = state.result ? selectedChanges() : [];
  const r = await api.runChecks({ plateIndex: state.plateIndex, changes, rotations: state.rotations });
  state.checks = r.checks; state.fixes = r.fixes;
  const box = $('checksBox');
  if (!box) return;
  const recSlice = state.compare?.results?.find(x => x.id === 'recommended');
  const sliceWarn = recSlice && recSlice.ok ? recSlice.warnings.map(w => ({ severity: 'warn', title: 'Snapmaker Orca warning', detail: w })) : [];
  const all = [...state.checks, ...sliceWarn];
  document.querySelectorAll('#resultsBody .fixnote').forEach(el => el.remove());
  for (const f of r.fixes) {
    const row = document.querySelector(`#resultsBody .setting[data-id="${f.key}#0"]`);
    if (row) row.querySelector('.err').insertAdjacentHTML('afterend', `<div class="fixnote">Will be saved as <b>${esc(f.value)}</b> so Snapmaker Orca accepts the file.</div>`);
  }
  const fileFixes = (state.prepNotes || []).filter(n => /^Corrected/.test(n));
  const fixesHtml = (r.fixes.length || fileFixes.length) ? `<h3 class="group-title">Fixed automatically so Snapmaker Orca accepts the file</h3><ul class="checks">${fileFixes.map(n => `<li class="info">${esc(n)}</li>`).join('')}${r.fixes.map(f => `<li class="info"><b>${esc(f.key.replace(/_/g, ' '))} → ${esc(f.value)}.</b>${esc(f.reason)}</li>`).join('')}</ul>` : '';
  box.innerHTML = fixesHtml + (all.length
    ? `<h3 class="group-title">Safety checks</h3><ul class="checks">${all.map(c => `<li class="${esc(c.severity)}"><b>${esc(c.title)}.</b>${esc(c.detail)}</li>`).join('')}</ul>`
    : '<p class="ok-line">Safety checks passed: flow, temperatures, cooling and supports look consistent.</p>');
}, 300);

// pictures of the model for the saved file's thumbnail (what Windows Explorer and the slicer's plate list show)
function fileThumbs() { try { return viewer.thumbnails([512, 256, 128]); } catch { return []; } }

// variantId: a version from Compare slices; none = the recommendations with the checked rows
async function save3mf(variantId = null, opts = {}) {
  try {
    const def = variantId ? variantDef(variantId) : null;
    // "no AI": just the conversion and the automatic safety fixes, whatever recommendations are on screen
    const changes = opts.noAI ? [] : def ? def.changes : selectedChanges();
    if (!(await fitConfirm(changes))) return;
    const out = await api.save3mf({ changes, rotations: def ? (def.rotations || state.rotations) : state.rotations, slider: Number($('slider').value), purpose: $('purpose').value.trim(), plateIndex: state.plateIndex, variantName: def ? def.name : null, thumbs: fileThumbs() });
    if (out) {
      const n = out.fixes.length + out.corrections.length;
      toast(`Saved${def ? ` “${def.name}”` : ''}${n ? ` with ${n} automatic fix${n === 1 ? '' : 'es'}` : ''}. Open the file in your slicer (double-click it, or File → Open Project), check the preview, then print.`, n ? 12000 : 8000, () => api.showInFolder(out.path));
    }
  } catch (e) { toast(cleanErr(e), 8000); }
}
async function exportPresets() {
  try {
    const r = await api.exportPresets({ changes: selectedChanges(), plateIndex: state.plateIndex, rotations: state.rotations });
    if (!r) return;
    toast(`Saved ${r.files.length} preset file${r.files.length === 1 ? '' : 's'}. To use them on other models: in Orca choose File → Import → Import Configs, select the files, then pick the new presets in the sidebar.${r.missingParent ? ' Select your printer profile after importing.' : ''} (Not needed for this model if you saved it as a 3MF.)`, 14000, () => api.showInFolder(r.files[0]));
  } catch (e) { toast(cleanErr(e), 8000); }
}
async function copyChecklist() {
  const lines = [`Snapmaker Orca changes for ${state.file.fileName}`, ''];
  for (const [i, rot] of Object.entries(state.rotations)) { const o = state.analysis.objects.find(x => x.itemIndex === +i); if (rot && o) lines.push(`[ ] Reorient ${o.name} (see the app's orientation choice)`); }
  for (const c of selectedChanges()) lines.push(`[ ] ${c.label}${c.slot ? ` (T${c.slot})` : ''}: ${c.current ?? 'default'} -> ${c.value}   [${c.gui}]${c.reason ? `\n    ${c.reason}` : ''}`);
  if (state.result.plan.manual_steps.length) { lines.push('', 'By hand:'); state.result.plan.manual_steps.forEach(m => lines.push(`[ ] ${m}`)); }
  await navigator.clipboard.writeText(lines.join('\n'));
  toast('Checklist copied.', 3000);
}

// ---------- compare slices ----------
const VARIANT_NAMES = { original: 'Original', recommended: 'Recommended', finest: 'Finest recipe', fine: 'Fine recipe', fast: 'Fast recipe', fastest: 'Fastest recipe' };
const RECIPE_SLIDER = { finest: 5, fine: 25, fast: 75, fastest: 95 };
function renderVariantPicks() {
  const hasPlan = !!state.result;
  const picks = ['original', 'recommended', 'finest', 'fine', 'fast', 'fastest'];
  const on = state.comparePicks || new Set(['original', 'recommended', 'fast']);
  state.comparePicks = on;
  $('variantPicks').innerHTML = picks.map(p => `<label><input type="checkbox" value="${p}" ${on.has(p) ? 'checked' : ''} ${p === 'recommended' && !hasPlan ? 'disabled' : ''}> ${VARIANT_NAMES[p]}</label>`).join('')
    + `<p class="hint picks-hint">${hasPlan ? 'Finest, Fine, Fast and Fastest use the printer maker’s quality presets for layer height and speed, plus the other recommended settings (supports, cooling and so on).' : 'Finest, Fine, Fast and Fastest are the printer maker’s own quality presets.'} Pick one in the table to save it as a 3MF, send it, or open it in your slicer.</p>`;
  $('variantPicks').querySelectorAll('input').forEach(i => i.onchange = () => { if (i.checked) on.add(i.value); else on.delete(i.value); });
  $('sliceBtn').disabled = !state.file || !state.info.available;
  $('compareHint').textContent = !state.info.available ? 'Set the Snapmaker Orca location in Settings to slice variants.'
    : 'Slices each variant with Snapmaker Orca (with your current orientation and toolheads) and compares real print time, filament, tool changes and flow.';
}
$('sliceBtn').onclick = () => runCompare([...state.comparePicks].filter(p => p !== 'recommended' || state.result));

async function runCompare(ids) {
  if (!state.file || !state.info.available) return;
  const variants = [];
  for (const id of ids) {
    if (id === 'original') variants.push({ id, name: VARIANT_NAMES[id], changes: [] });
    else if (id === 'recommended') { if (state.result) variants.push({ id, name: VARIANT_NAMES[id], changes: selectedChanges().map(c => ({ key: c.key, value: c.value, slot: c.slot })) }); }
    else {
      // a quality preset plus the AI's other recommendations (supports, cooling…), so picking "Fast" doesn't
      // drop what the model needs; the preset decides layer height and speeds
      const r = await api.recipePreview(RECIPE_SLIDER[id]);
      // keys the recipe decides (even ones it leaves as they are) aren't overridden by the AI's values
      const presetKeys = new Set([...r.changes.map(c => `${c.key}#${c.slot || 0}`), ...(r.governs || []).map(k => `${k}#0`)]);
      const extra = state.result ? selectedChanges().filter(c => c.source !== 'recipe' && !presetKeys.has(`${c.key}#${c.slot || 0}`)).map(c => ({ key: c.key, value: c.value, slot: c.slot })) : [];
      variants.push({ id, name: state.result ? VARIANT_NAMES[id].replace(' recipe', ' + recommendations') : VARIANT_NAMES[id], changes: [...r.changes, ...extra] });
    }
  }
  for (const v of variants) v.rotations = state.rotations;
  state.variantDefs = Object.fromEntries(variants.map(v => [v.id, v]));
  $('compareBody').innerHTML = `<div class="working"><div class="bar"></div><p class="progress-line">Slicing…</p></div>`;
  setBusy('slice', `Slicing ${variants.length} variant${variants.length === 1 ? '' : 's'} in Snapmaker Orca…`, 0);
  try {
    const results = await api.sliceVariants({ plateIndex: state.plateIndex, variants: variants.map(({ id, changes, rotations }) => ({ id, changes, rotations })) });
    const names = Object.fromEntries(variants.map(v => [v.id, v.name]));
    state.compare = { results: results.map(r => ({ ...r, name: names[r.id] || VARIANT_NAMES[r.id] })) };
    state.selectedVariant = state.compare.results.find(r => r.id === 'recommended' && r.ok) ? 'recommended' : state.compare.results.find(r => r.ok)?.id;
  } catch (e) { state.compare = { error: cleanErr(e) }; }
  finally { clearBusy('slice'); }
  renderCompare(); renderStats(); refreshChecks(); saveSession();
  const tabBtn = document.querySelector('[data-tab=compare]');
  if (tabBtn.getAttribute('aria-selected') !== 'true' && state.compare?.results) tabBtn.innerHTML = 'Compare slices<span class="badge">new</span>';
}

const LOOK_WORDS = ['', 'Rough', 'Visible lines', 'Standard', 'Smooth', 'Very smooth'];
const STRENGTH_WORDS = ['', 'Light', 'Light–normal', 'Normal', 'Strong', 'Very strong'];
const meter = (n) => n ? `<span class="meter" aria-label="${n} of 5">${'●'.repeat(n)}<span class="off">${'●'.repeat(5 - n)}</span></span>` : '';
const lookPart = (r, id) => (r.look || []).find(x => x.id === id);

function renderCompare() {
  renderVariantPicks();
  const c = state.compare, body = $('compareBody');
  if (!c) { body.innerHTML = ''; return; }
  if (c.error) { body.innerHTML = `<div class="error">${esc(c.error)}</div>`; return; }
  const base = c.results.find(r => r.id === 'original' && r.ok);
  const delta = (v, b, unit, fmtFn) => {
    if (!base || v == null || b == null || v === b) return '';
    const d = v - b, pct = b ? Math.round(100 * d / b) : 0;
    return `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : '−'}${fmtFn(Math.abs(d))}${unit} (${pct > 0 ? '+' : ''}${pct}%)</span>`;
  };
  // pick something to describe straight away (the first version that isn't the original)
  if (!c.results.some(r => r.ok && r.id === state.selectedVariant)) state.selectedVariant = (c.results.find(r => r.ok && r.id !== 'original') || c.results.find(r => r.ok) || {}).id;
  const tech = state.showTech ?? (level() >= 3);
  body.innerHTML = `
    <div class="ctable-head"><span class="hint">${level() <= 1 ? 'Click a version to see what you’ll get and to save or print it.' : 'Click a version for details.'}</span>
      <button class="link" id="techToggle">${tech ? 'Hide' : 'Show'} technical details</button></div>
    <div class="ctable-wrap"><table class="ctable ${tech ? 'show-tech' : ''}"><thead><tr><th>Version</th><th title="Surface finish: how visible the layer lines are">Look</th><th title="How strong and stiff the part will be">Strength</th><th>Time</th><th>Filament</th><th class="tech">Layers</th><th class="tech" title="Toolhead or filament changes">Swaps</th><th class="tech" title="95th percentile volumetric flow, mm³/s">Flow</th></tr></thead><tbody>
    ${c.results.map(r => {
      if (!r.ok) return `<tr><td>${esc(r.name)}</td><td colspan="7" class="err">${esc(r.error)}</td></tr>`;
      const lk = lookPart(r, 'look'), st = lookPart(r, 'strength');
      return `<tr data-v="${r.id}" class="${r.id === state.selectedVariant ? 'sel' : ''}" tabindex="0">
      <td>${esc(r.name)}${base && r.id !== 'original' && base.timeSeconds && r.timeSeconds > 2 * base.timeSeconds ? `<span class="delta up">${(r.timeSeconds / base.timeSeconds).toFixed(1)}× as long</span>` : ''}${r.warnings.length ? `<span class="delta up">${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}</span>` : ''}${(r.corrections || []).length ? `<span class="delta fixed">${r.corrections.length} fixed automatically</span>` : ''}</td>
      <td title="${esc(lk ? lk.text : '')}">${lk ? `${meter(lk.score)}<span class="mword">${LOOK_WORDS[lk.score]}</span>` : '—'}</td>
      <td title="${esc(st ? st.text : '')}">${st ? `${meter(st.score)}<span class="mword">${STRENGTH_WORDS[st.score]}</span>` : '—'}</td>
      <td>${hm(r.timeSeconds)}${r.id !== 'original' ? delta(r.timeSeconds, base?.timeSeconds, '', hm) : ''}</td>
      <td>${fmt(r.grams || 0)} g${r.id !== 'original' ? delta(r.grams, base?.grams, ' g', fmt) : ''}</td>
      <td class="tech">${r.gcode.layers}</td><td class="tech">${r.gcode.toolChanges}</td><td class="tech">${r.gcode.peakFlowP95}</td></tr>`;
    }).join('')}
  </tbody></table></div><div id="variantDetail"></div>`;
  $('techToggle').onclick = () => { state.showTech = !tech; renderCompare(); };
  body.querySelectorAll('tr[data-v]').forEach(tr => {
    const pick = () => { state.selectedVariant = tr.dataset.v; renderCompare(); guideEvent('compare-picked'); };
    tr.onclick = pick; tr.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
  });
  const sel = c.results.find(r => r.id === state.selectedVariant && r.ok);
  if (!sel) return;
  const feats = sel.gcode.byFeature.filter(f => f.timeShare >= 0.005);
  const cards = (sel.look || []).map(x => `<div class="look-card"><div class="lc-head"><b>${esc(x.title)}</b>${x.score ? meter(x.score) : ''}</div>
      <p>${esc(x.text)}</p>${x.compare ? `<p class="lc-cmp">${esc(x.compare)}</p>` : ''}${x.detail && level() >= 2 ? `<p class="lc-detail">${esc(x.detail)}</p>` : ''}</div>`).join('');
  $('variantDetail').innerHTML = `
    ${base && sel.id !== 'original' && base.timeSeconds && sel.timeSeconds > 2 * base.timeSeconds ? (() => {
      const why = ['look', 'strength'].map(id => { const a = lookPart(base, id), b = lookPart(sel, id); return a && b && a.detail !== b.detail ? `${b.detail} instead of ${a.detail}` : null; }).filter(Boolean);
      return `<div class="error time-warn"><b>This version takes ${(sel.timeSeconds / base.timeSeconds).toFixed(1)}× as long as the original</b> (${esc(hm(sel.timeSeconds))} instead of ${esc(hm(base.timeSeconds))}) and uses ${fmt(sel.grams || 0)} g instead of ${fmt(base.grams || 0)} g.${why.length ? ` Mainly: ${esc(why.join('; '))}.` : ''} Untick the rows that cause it in Recommendations if you don’t need the extra quality or strength.</div>`;
    })() : ''}
    <h3>What you’ll get with “${esc(sel.name)}”</h3>
    <div class="look-cards">${cards || '<p class="hint">Descriptions appear after slicing.</p>'}</div>
    <p class="hint">${esc(hm(sel.timeSeconds))} to print, ${fmt(sel.grams || 0)} g of filament${base && sel.id !== 'original' ? ` (original: ${esc(hm(base.timeSeconds))}, ${fmt(base.grams || 0)} g)` : ''}.</p>
    ${sel.warnings.length ? `<ul class="warn-list">${sel.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <h3>Use “${esc(sel.name)}”</h3>
    <div class="row-btns" id="useButtons"><button class="btn primary" id="save3mfVariant">Save as 3MF</button> <button class="btn" id="sendVariant">Send to printer…</button> <button class="btn" id="orcaVariant">Open in slicer</button></div>
    <p class="hint"><b>Save as 3MF</b> saves the model with this version’s settings built in, ready to open in your slicer and print. <button class="link" id="saveGcode">Save the G-code instead</button> (advanced: the finished print file, only needed to upload to a printer yourself, e.g. with Fluidd or a USB stick).</p>
    <details class="time-details" ${level() >= 3 ? 'open' : ''}><summary>Where the print time goes</summary>
      <div class="feature-bars">${feats.map(f => `<div class="fbar"><span>${esc(f.name)}</span><span class="track"><span class="fill" style="width:${Math.round(f.timeShare * 100)}%"></span></span><span class="n">${Math.round(f.timeShare * 100)}%, ${f.flowP95} mm³/s</span></div>`).join('')}</div>
      <p class="hint">Per-toolhead filament: ${sel.filaments.length ? sel.filaments.map(f => `T${f.id} ${f.type} ${fmt(f.usedGrams || 0)} g`).join(', ') : Object.entries(sel.gcode.volumeByTool).map(([t, v]) => `${t} ${v} cm³`).join(', ')}. Flow (mm³/s) is the 95th percentile per feature, after the slicer’s own speed caps.</p>
      ${(sel.corrections || []).length ? `<h3>Fixed automatically</h3><ul class="fix-list">${sel.corrections.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    </details>`;
  $('save3mfVariant').onclick = () => { save3mf(sel.id); guideEvent('saved'); };
  $('sendVariant').onclick = () => { openSend(sel.id); guideEvent('saved'); };
  $('orcaVariant').onclick = () => openInOrca(sel.id);
  $('saveGcode').onclick = async () => {
    try { const p = await api.saveGcode({ variantId: sel.id, name: sel.name }); if (p) toast('G-code saved.', 5000, () => api.showInFolder(p)); }
    catch (e) { toast(cleanErr(e), 6000); }
  };
}

// ---------- history ----------
$('historyRefresh').onclick = () => loadHistory();
async function loadHistory() {
  $('historyBody').innerHTML = '<p class="progress-line">Reading print history…</p>';
  try {
    const h = await withBusy('history', 'Reading print history from your printers…', () => api.historyList());
    state.history = h;
    if (!h.configured) { $('historyBody').innerHTML = `<p>Add your printers’ addresses in <button class="link" id="histSettings">Settings</button> to see their print history here.</p>`; $('histSettings').onclick = openSettings; return; }
    const err = h.errors.length ? `<p class="error">${h.errors.map(esc).join('<br>')}</p>` : '';
    if (!h.jobs.length) { $('historyBody').innerHTML = err + '<p class="hint">No prints yet.</p>'; return; }
    $('historyBody').innerHTML = err + h.jobs.map((j, i) => `
      <div class="job" data-i="${i}">
        <span class="f">${esc(j.filename)}</span><span class="st ${esc(j.status)}">${esc(j.status)}</span>
        <span class="m">${esc(j.printer)}, ${j.start ? new Date(j.start).toLocaleString() : ''}, ${hm(j.printSeconds)}${j.filamentType ? `, ${esc(j.filamentType)}` : ''}${j.layerHeight ? `, ${j.layerHeight} mm layers` : ''}${j.run ? ' <span class="adv">· advisor settings</span>' : ''}</span>
        <div class="rate">
          ${['good', 'issues', 'failed'].map(r => `<button class="btn" data-r="${r}" aria-pressed="${j.rating?.rating === r}">${{ good: 'Good', issues: 'Had issues', failed: 'Failed' }[r]}</button>`).join('')}
          <input type="text" placeholder="What happened? (optional)" value="${esc(j.rating?.note || '')}" aria-label="Note for ${esc(j.filename)}">
          <button class="btn ts-btn" data-ts="${i}">Troubleshoot…</button>
        </div>
        ${j.diagnoses && j.diagnoses[0] ? `<div class="diag">Diagnosis ${new Date(j.diagnoses[0].at).toLocaleDateString()}: ${esc(j.diagnoses[0].summary)}</div>` : ''}
      </div>`).join('');
    $('historyBody').querySelectorAll('.job').forEach(el => {
      const j = h.jobs[Number(el.dataset.i)];
      const note = el.querySelector('input');
      const save = async (rating) => { await api.historyRate({ jobId: j.id, rating, note: note.value.trim() }); j.rating = rating ? { rating, note: note.value.trim() } : null; el.querySelectorAll('[data-r]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.r === rating))); };
      el.querySelectorAll('[data-r]').forEach(b => b.onclick = () => save(j.rating?.rating === b.dataset.r ? null : b.dataset.r));
      note.onchange = () => { if (j.rating) save(j.rating.rating); else toast('Pick Good, Had issues or Failed to save the note.', 3500); };
      el.querySelector('[data-ts]').onclick = () => openTroubleshooter(j);
    });
  } catch (e) { $('historyBody').innerHTML = `<p class="error">${esc(cleanErr(e))}</p>`; }
}

// ---------- open in Snapmaker Orca ----------
async function openInOrca(variantId) {
  if (!state.file) return;
  if (!state.info.available) { toast('Set the Snapmaker Orca location in Settings first.', 5000); openSettings(); return; }
  // the current plan (if any), or a sliced version from Compare
  const def = variantId ? variantDef(variantId) : { id: 'current', name: state.result ? 'Recommended' : 'Current', changes: state.result ? selectedChanges().map(c => ({ key: c.key, value: c.value, slot: c.slot })) : [], rotations: state.rotations };
  if (!(await fitConfirm(def.changes))) return;
  try {
    const r = await withBusy('orca', 'Writing the project and starting Snapmaker Orca…', () => api.openInOrca({ changes: def.changes, rotations: def.rotations, plateIndex: state.plateIndex, variantName: def.name, thumbs: fileThumbs() }));
    if (!r) return;
    const name = r.path.split(/[\\/]/).pop();
    const big = state.analysis && state.analysis.totals.triangles > 300000;
    toast(`Saved ${name}${r.fixes ? ` with ${r.fixes} automatic fix${r.fixes === 1 ? '' : 'es'}` : ''} and started ${r.singleInstance ? 'your running' : 'a new'} Snapmaker Orca window.${big ? ` This model has ${(state.analysis.totals.triangles / 1e6).toFixed(1)}M triangles, so Orca may take a minute or two to finish loading it.` : ' Orca can take a little while to start.'} Save there and the advisor will offer to reload your edits.${r.singleInstance ? ' (Orca’s “only one instance” preference is on, so it used the existing window.)' : ''}`, 12000, () => api.showInFolder(r.path));
  } catch (e) { toast(cleanErr(e), 8000); }
}
$('orcaBtn').onclick = () => openInOrca(null);

api.onOrcaFileChanged(({ file, name }) => {
  noticeWithActions(`${name} was saved in Snapmaker Orca.`, [
    { label: 'Reload your Orca edits', primary: true, fn: async () => { await openFile(api.openPath(file)); api.orcaReloaded(file); toast('Reloaded the project from Snapmaker Orca. Its settings are now the starting point here.', 6000); } },
    { label: 'Dismiss', fn: () => {} },
  ]);
});

// a persistent notice (until acted on) with buttons
function noticeWithActions(msg, actions) {
  const t = $('toast');
  clearTimeout(toastTimer);
  t.innerHTML = `${esc(msg)} ${actions.map((a, i) => `<button class="link notice-btn ${a.primary ? 'primary' : ''}" data-a="${i}">${esc(a.label)}</button>`).join(' ')}`;
  t.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { hideToast(); actions[Number(b.dataset.a)].fn(); });
  t.classList.remove('hidden');
}

// ---------- send to printer ----------
const SEND = { job: null, printers: [], printer: null, map: {} };
const prefsKey = 'u1advisor.sendPrefs';
function variantDef(id) {
  if (id === 'recommended') return { id, name: 'Recommended', changes: selectedChanges().map(c => ({ key: c.key, value: c.value, slot: c.slot })), rotations: state.rotations };
  if (id === 'original') return { id, name: 'Original', changes: [], rotations: state.rotations };
  return (state.variantDefs && state.variantDefs[id]) || { id, name: id, changes: [], rotations: state.rotations };
}
function sdStatus(text, pct = null, kind = '') {
  const box = document.querySelector('.sd-progress');
  box.classList.remove('error', 'done'); if (kind) box.classList.add(kind);
  $('sdStatus').textContent = text || '';
  $('sdFill').style.width = pct == null ? '0%' : `${pct}%`;
}
api.onSendProgress(p => sdStatus(p.label, p.pct));

async function openSend(variantId) {
  if (!state.file) return;
  if (!(await fitConfirm(variantDef(variantId).changes))) return;
  if (!state.config.printers || !state.config.printers.length) { toast('Add your printers’ addresses in Settings first.', 5000); openSettings(); return; }
  const dlg = $('sendDialog');
  SEND.job = null; SEND.map = {};
  $('sdFilaments').innerHTML = ''; $('sdPrinters').innerHTML = '<p class="hint">Checking your printers…</p>'; $('sdFilNote').textContent = '';
  $('sdStart').disabled = true;
  const thumbs = viewer.thumbnails([48, 300, 512]);
  SEND.thumbs = thumbs.filter(t => t.w !== 512);
  $('sdThumb').src = thumbs.find(t => t.w === 512).dataUrl;
  const p = JSON.parse(localStorage.getItem(prefsKey) || '{}');
  $('sdFlow').checked = !!p.flowCalibrate; $('sdTimelapse').checked = !!p.timelapse; $('sdLevel').checked = !!p.bedLevel;
  sdStatus('Preparing the job…');
  dlg.showModal();
  const def = variantDef(variantId);
  const [job, printers] = await Promise.all([
    withBusy('send', `Slicing ${def.name} for the printer…`, () => api.sendPrepare({ plateIndex: state.plateIndex, variant: def })).catch(e => ({ error: cleanErr(e) })),
    api.printersStatus().catch(() => []),
  ]);
  if (job.error) { sdStatus(job.error, null, 'error'); return; }
  SEND.job = job; SEND.printers = printers;
  $('sdName').value = job.remoteName;
  $('sdTime').textContent = hm(job.timeSeconds);
  $('sdGrams').textContent = `${fmt(job.grams || 0)} g`;
  $('sdVariant').textContent = def.name + (job.corrections.length ? ` (${job.corrections.length} fixed automatically)` : '');
  const last = localStorage.getItem('u1advisor.lastPrinter');
  const usable = printers.filter(x => x.online && !/printing|paused/.test(x.state));
  SEND.printer = (usable.find(x => x.name === last) || usable[0] || printers[0] || null);
  renderSendPrinters(); renderSendFilaments();
  sdStatus(job.warnings.length ? `Slicer warning: ${job.warnings[0]}` : '');
}

function printerLine(x) {
  if (!x.online) return { cls: 'off', text: `Offline: ${x.error}` };
  if (/printing|paused/.test(x.state)) return { cls: 'busy', text: `${x.state === 'paused' ? 'Paused' : 'Printing'}${x.filename ? ` ${x.filename}` : ''}${x.progress != null ? ` (${Math.round(x.progress * 100)}%)` : ''}` };
  const loaded = x.heads.filter(h => h.loaded).map(h => `T${h.index + 1} ${h.type}`).join(', ');
  return { cls: 'ready', text: `Ready${loaded ? `. Loaded: ${loaded}` : ''}` };
}
function renderSendPrinters() {
  $('sdPrinters').innerHTML = SEND.printers.map(x => {
    const l = printerLine(x); const dis = !x.online || /printing|paused/.test(x.state);
    return `<div class="sd-printer ${dis ? 'disabled' : ''}" role="radio" tabindex="0" aria-checked="${SEND.printer && SEND.printer.index === x.index}" data-i="${x.index}">
      <span class="dot dot-${l.cls}"></span><span class="n">${esc(x.name)}</span><span class="hint">${esc(x.url.replace(/^https?:\/\//, ''))}</span><span class="s">${esc(l.text)}</span></div>`;
  }).join('') || '<p class="hint">No printers set up.</p>';
  $('sdPrinters').querySelectorAll('.sd-printer').forEach(el => {
    const pick = () => { const x = SEND.printers[Number(el.dataset.i)]; if (!x.online || /printing|paused/.test(x.state)) return; SEND.printer = x; SEND.map = {}; renderSendPrinters(); renderSendFilaments(); };
    el.onclick = pick; el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
  });
}
const baseType = t => String(t || '').toUpperCase().replace(/[\s_-]+/g, '').replace(/^(PLA|PETG|PCTG|TPU|ABS|ASA|PVA|PA|PC).*/, '$1');
function colorDist(a, b) { const p = c => [1, 3, 5].map(i => parseInt(String(c || '#888888').replace('#', '').padEnd(6, '8').slice(i - 1, i + 1), 16)); const x = p(a), y = p(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); }
function defaultMap(fils, heads) {
  const map = {}, used = new Set();
  for (const f of fils) {
    const cands = heads.filter(h => h.loaded && !used.has(h.index) && baseType(h.type) === baseType(f.type)).sort((a, b) => colorDist(a.color, f.color) - colorDist(b.color, f.color));
    const pick = cands[0] || heads.find(h => h.index === f.index && !used.has(h.index)) || heads.find(h => !used.has(h.index)) || { index: f.index % 4 };
    map[f.index] = pick.index; used.add(pick.index);
  }
  return map;
}
function renderSendFilaments() {
  const job = SEND.job; if (!job) return;
  const heads = (SEND.printer && SEND.printer.heads && SEND.printer.heads.length) ? SEND.printer.heads : [0, 1, 2, 3].map(i => ({ index: i, type: null, loaded: false }));
  if (!Object.keys(SEND.map).length) SEND.map = defaultMap(job.filaments, heads);
  const textOn = c => { const v = parseInt(String(c || '#888888').replace('#', '').slice(0, 6), 16); const lum = 0.299 * (v >> 16 & 255) + 0.587 * (v >> 8 & 255) + 0.114 * (v & 255); return lum > 150 ? '#18232E' : '#FFFFFF'; };
  $('sdFilaments').innerHTML = job.filaments.map(f => {
    const h = heads.find(x => x.index === SEND.map[f.index]);
    let warn = '';
    if (h && !h.loaded) warn = `Nothing is loaded in T${h.index + 1}.`;
    else if (h && h.type && baseType(h.type) !== baseType(f.type)) warn = `T${h.index + 1} has ${h.type} loaded; this part is ${f.type}.`;
    const dup = job.filaments.filter(o => SEND.map[o.index] === SEND.map[f.index]).length > 1;
    if (dup) warn = (warn ? warn + ' ' : '') + 'Two filaments share this toolhead.';
    return `<div class="sd-fil" data-f="${f.index}">
      <div class="top" style="background:${esc(f.color)};color:${textOn(f.color)}">${esc(f.type)}<br>${fmt(f.grams)} g</div>
      <div class="bottom"><select aria-label="Toolhead for filament ${f.index + 1}">${heads.map(x => `<option value="${x.index}" ${x.index === SEND.map[f.index] ? 'selected' : ''}>T${x.index + 1}${x.loaded && x.type ? ` · ${esc(x.type)}` : x.loaded ? '' : ' · empty'}</option>`).join('')}</select>
      ${warn ? `<span class="warn">${esc(warn)}</span>` : ''}</div></div>`;
  }).join('');
  $('sdFilaments').querySelectorAll('.sd-fil select').forEach(sel => sel.onchange = () => { SEND.map[Number(sel.closest('.sd-fil').dataset.f)] = Number(sel.value); renderSendFilaments(); });
  $('sdFilNote').textContent = SEND.printer && SEND.printer.online ? `Toolheads show what ${SEND.printer.name} reports as loaded.` : 'Printer offline: toolheads can’t show what’s loaded.';
  const bad = job.filaments.some(f => job.filaments.filter(o => SEND.map[o.index] === SEND.map[f.index]).length > 1);
  $('sdStart').disabled = !SEND.printer || !SEND.printer.online || /printing|paused/.test(SEND.printer.state) || bad;
}
['sdFlow', 'sdTimelapse', 'sdLevel'].forEach(id => $(id).addEventListener('change', () => localStorage.setItem(prefsKey, JSON.stringify({ flowCalibrate: $('sdFlow').checked, timelapse: $('sdTimelapse').checked, bedLevel: $('sdLevel').checked }))));
$('sdClose').onclick = () => $('sendDialog').close();
$('sdStart').onclick = async () => {
  const job = SEND.job, pr = SEND.printer;
  if (!job || !pr) return;
  $('sdStart').disabled = true;
  sdStatus(`Uploading to ${pr.name}…`, 0);
  try {
    const mapTable = job.filaments.map(f => [f.index, SEND.map[f.index]]).sort((a, b) => a[0] - b[0]);
    const r = await api.sendPrint({ variantId: job.variantId, printerIndex: pr.index, remoteName: $('sdName').value || job.remoteName, mapTable,
      prefs: { flowCalibrate: $('sdFlow').checked, timelapse: $('sdTimelapse').checked, bedLevel: $('sdLevel').checked }, thumbs: SEND.thumbs });
    localStorage.setItem('u1advisor.lastPrinter', pr.name);
    sdStatus(`Printing on ${r.printer}.`, 100, 'done');
    toast(`Sent ${r.remote} to ${r.printer}. It’s printing now.`, 7000);
    state.history = null;
    setTimeout(() => $('sendDialog').close(), 1800);
  } catch (e) {
    sdStatus(cleanErr(e), null, 'error');
    $('sdStart').disabled = false;
  }
};

// ---------- print issue troubleshooter ----------
const TS = { job: null, modelPath: null, model: null, viewer: null, region: null, mapSel: new Set(), photos: [], issues: new Set(), gcode: null, result: null };

async function openTroubleshooter(job) {
  Object.assign(TS, { job, modelPath: null, model: null, region: null, mapSel: new Set(), photos: [], issues: new Set(), gcode: null, result: null });
  $('tsDesc').value = job.rating && job.rating.note ? job.rating.note : '';
  $('tsZmin').value = ''; $('tsZmax').value = '';
  $('tsResult').innerHTML = ''; renderTsPhotos();
  const prev = (job.diagnoses || []).find(d => d.full);
  if (prev) {
    $('tsResult').innerHTML = `<p class="hint">This print was diagnosed on ${esc(new Date(prev.at).toLocaleString())}. <button class="link" id="tsShowPrev">Show that diagnosis</button> (no new AI request), or describe the problem again below.</p>`;
    $('tsShowPrev').onclick = () => { TS.result = prev.full; renderTsResult(); };
  }
  $('tsJob').innerHTML = `<h3>${esc(job.filename)}</h3><dl class="ts-job"><dt>Printer</dt><dd>${esc(job.printer)}</dd><dt>When</dt><dd>${job.start ? new Date(job.start).toLocaleString() : '—'}</dd><dt>Result</dt><dd>${esc(job.status)} after ${hm(job.printSeconds)}${job.rating ? `, rated “${esc({ good: 'Good', issues: 'Had issues', failed: 'Failed' }[job.rating.rating])}”` : ''}</dd><dt>Material</dt><dd>${esc(job.filamentType || '—')}</dd></dl>`;
  $('tsEmpty').innerHTML = '<p>Loading the print…</p>'; $('tsEmpty').classList.remove('hidden');
  $('tsTools').classList.add('hidden'); $('tsMap').classList.add('hidden'); $('tsViewer').classList.remove('hidden');
  $('tsLeftHint').textContent = '';
  $('tsDialog').showModal();
  try {
    const info = await api.tsOpen({ jobId: job.id });
    $('tsIssues').innerHTML = info.issues.map(x => `<button class="chip" aria-pressed="false" data-issue="${esc(x)}">${esc(x)}</button>`).join('');
    $('tsIssues').querySelectorAll('.chip').forEach(c => c.onclick = () => { const on = c.getAttribute('aria-pressed') !== 'true'; c.setAttribute('aria-pressed', String(on)); on ? TS.issues.add(c.dataset.issue) : TS.issues.delete(c.dataset.issue); });
    if (job.rating && job.rating.rating === 'failed' && job.status === 'cancelled') { /* no preselection: let the user say what happened */ }
    await tsLoad(info.modelPath);
  } catch (e) { $('tsEmpty').innerHTML = `<p class="error">${esc(cleanErr(e))}</p>`; }
}

async function tsLoad(modelPath) {
  TS.modelPath = modelPath || null;
  const res = await withBusy('ts', modelPath ? 'Loading the printed G-code and the model…' : 'Loading the printed G-code…', () => api.tsLoad({ jobId: TS.job.id, modelPath }));
  TS.gcode = res.gcode; TS.model = res.model;
  const gNames = new Set((res.gcode.objects || []).map(o => o.name.replace(/_id_\d+_copy_\d+$/, '')));
  const tsMulti = (res.model && (res.model.names.length > 1 || res.model.assemblyGuess)) || gNames.size > 1;
  $('tsFitRow').classList.remove('hidden');
  $('tsFitTogether').checked = !!((res.model && res.model.assemblyGuess) || gNames.size > 1);
  const maxZ = (res.gcode.ok && res.gcode.header && res.gcode.header.maxZ) || (res.model && res.model.totals.sizeMm.z) || 270;
  $('tsZmin').max = $('tsZmax').max = maxZ;
  $('tsLeftHint').textContent = res.gcode.ok
    ? `Using the G-code that was printed (${res.gcode.header.slicer || 'Snapmaker Orca'}, ${res.gcode.header.layers || '?'} layers${res.printed && res.printed.layer ? `, ${res.printed.layer} mm` : ''}). ${res.model ? 'Rotate with the left button; in Paint mode, right-drag rotates.' : ''}`
    : `Couldn’t read the G-code from the printer (${res.gcode.error}).${res.model ? ' Claude will use the model’s saved settings instead.' : ''}`;
  if (res.model) {
    $('tsEmpty').classList.add('hidden'); $('tsMap').classList.add('hidden'); $('tsViewer').classList.remove('hidden'); $('tsTools').classList.remove('hidden');
    if (!TS.viewer) {
      TS.viewer = new ModelViewer($('tsViewer'));
      TS.viewer.onPaint = () => setTsRegion();
    }
    TS.viewer.setFilamentColors(Object.fromEntries(res.filamentColors.map((c, i) => [i + 1, String(c).slice(0, 7)])));
    TS.viewer.load(res.model.preview);
    TS.viewer.setSupports(res.supports, res.model.offset);
    const hasSup = !!(res.supports && res.supports.count);
    $('tsSupportsRow').classList.toggle('hidden', !hasSup); $('tsPaintSupports').classList.toggle('hidden', !hasSup);
    $('tsShowSupports').checked = false; TS.viewer.setSupportsVisible(false);
    TS.viewer.setTool('paint'); setToolButtons('paint');
    $('tsRegionText').textContent = hasSup ? 'Paint the area where it failed (magenta). If the supports failed, tick “Show printed supports” and use “Paint supports”.' : 'Paint the area where it failed (magenta). Use Erase to fix mistakes.';
  } else {
    $('tsTools').classList.add('hidden');
    const objs = res.gcode.ok ? res.gcode.objects.filter(o => o.polygon.length > 2) : [];
    if (objs.length) {
      $('tsViewer').classList.add('hidden'); $('tsMap').classList.remove('hidden');
      renderTsMap(objs);
      $('tsRegionText').textContent = 'Click the part that failed on the plate map and set the height below.';
      $('tsLeftHint').insertAdjacentHTML('beforeend', ' <button class="link" id="tsOpenModel">Open the model (.3mf)</button> to paint the exact spot instead.');
    } else {
      $('tsViewer').classList.remove('hidden'); $('tsMap').classList.add('hidden');
      $('tsEmpty').classList.remove('hidden');
      $('tsRegionText').textContent = 'Set the height where it failed below.';
    }
    $('tsEmpty').innerHTML = `<div><p>${res.gcode.ok ? 'This print wasn’t made or sent with the advisor, so its model isn’t on file.' : 'No model on file for this print.'}</p><button class="btn primary" id="tsOpenModel2">Open the model (.3mf) to paint the failure</button></div>`;
    for (const id of ['tsOpenModel', 'tsOpenModel2']) { const b = $(id); if (b) b.onclick = async () => { const pth = await api.tsPickModel(); if (pth) tsLoad(pth); }; }
  }
}

function setToolButtons(tool) { document.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.tool === tool))); }
document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => {
  setToolButtons(b.dataset.tool); if (!TS.viewer) return;
  TS.viewer.setTool(b.dataset.tool);
  if (b.dataset.tool === 'paint-supports' && !$('tsShowSupports').checked) { $('tsShowSupports').checked = true; TS.viewer.setSupportsVisible(true); }
});
$('tsShowSupports').onchange = () => TS.viewer && TS.viewer.setSupportsVisible($('tsShowSupports').checked);
$('tsBrush').oninput = () => { $('tsBrushV').textContent = `${$('tsBrush').value} mm`; if (TS.viewer) TS.viewer.brush = Number($('tsBrush').value); };
$('tsClear').onclick = () => TS.viewer && TS.viewer.clearPaint();
$('tsClose').onclick = () => $('tsDialog').close();

function setTsRegion() {
  const off = TS.model ? TS.model.offset : [0, 0, 0];
  const m = TS.viewer ? TS.viewer.region(off) : null, sup = TS.viewer ? TS.viewer.supportRegion(off) : null;
  let r = m;
  if (sup && !m) {
    r = { source: 'painted on the printed supports', onSupports: true, supports: sup, zMin: sup.zMin, zMax: sup.zMax, xRange: sup.xRange, yRange: sup.yRange, centerXY: sup.centerXY, facing: 'support structure', nearBed: sup.zMin < 1 };
  } else if (sup && m) {
    r = { ...m, source: 'painted on the model and its printed supports', onSupports: true, supports: sup, zMin: Math.min(m.zMin, sup.zMin), zMax: Math.max(m.zMax, sup.zMax) };
  }
  TS.region = r;
  if (r && r.onSupports && !m) {
    $('tsZmin').value = Math.max(0, r.zMin).toFixed(1); $('tsZmax').value = r.zMax.toFixed(1);
    $('tsRegionText').textContent = `Painted ${sup.segments} lines of the printed supports, ${r.zMin.toFixed(1)}–${r.zMax.toFixed(1)} mm up${sup.interfaceShare > 30 ? ', mostly the support interface (the layer right under the part)' : ''}${r.nearBed ? ', at the bed' : ''}.`;
    return;
  }
  if (!r) { $('tsRegionText').textContent = 'Paint the area where it failed (magenta). Use Erase to fix mistakes.'; return; }
  $('tsZmin').value = Math.max(0, r.zMin).toFixed(1); $('tsZmax').value = r.zMax.toFixed(1);
  $('tsRegionText').textContent = `Painted ${m.areaCm2} cm² on the ${m.facing}, ${r.zMin.toFixed(1)}–${r.zMax.toFixed(1)} mm up (${m.heightOfPartPercent[0]}–${m.heightOfPartPercent[1]}% of the part’s height)${m.overhangSharePercent ? `, ${m.overhangSharePercent}% of it overhang` : ''}${m.nearBed ? ', touching the bed' : ''}${sup ? `, plus ${sup.segments} lines of the supports` : ''}.`;
}

// "Bracket_id_0_copy_1" -> "Bracket", numbered when several objects share a name
function mapLabels(objs) {
  const base = objs.map(o => o.name.replace(/_id_\d+_copy_\d+$/, '').replace(/_/g, ' '));
  const count = {}; base.forEach(b => { count[b] = (count[b] || 0) + 1; });
  const seen = {};
  return base.map(b => count[b] > 1 ? `${b} #${(seen[b] = (seen[b] || 0) + 1)}` : b);
}
function renderTsMap(objs) {
  const labels = mapLabels(objs);
  const pts = objs.flatMap(o => o.polygon);
  const minX = Math.min(0, ...pts.map(p => p[0])), maxX = Math.max(270, ...pts.map(p => p[0])), minY = Math.min(0, ...pts.map(p => p[1])), maxY = Math.max(270, ...pts.map(p => p[1]));
  const pad = 6;
  $('tsMap').innerHTML = `<svg viewBox="${minX - pad} ${-(maxY + pad)} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}" role="group" aria-label="Plate map">
    <rect class="bed" x="0" y="-270" width="270" height="270" rx="3"></rect>
    ${objs.map((o, i) => `<g><polygon class="obj ${TS.mapSel.has(o.name) ? 'sel' : ''}" data-i="${i}" tabindex="0" points="${o.polygon.map(p => `${p[0]},${-p[1]}`).join(' ')}"><title>${esc(labels[i])}</title></polygon>
      ${o.center ? `<text x="${o.center[0]}" y="${-o.center[1]}" text-anchor="middle">${esc(labels[i].slice(0, 20))}</text>` : ''}</g>`).join('')}
  </svg>`;
  $('tsMap').querySelectorAll('.obj').forEach(pg => {
    const toggle = () => { const o = objs[Number(pg.dataset.i)]; TS.mapSel.has(o.name) ? TS.mapSel.delete(o.name) : TS.mapSel.add(o.name); renderTsMap(objs);
      $('tsRegionText').textContent = TS.mapSel.size ? `Picked: ${objs.map((x, k) => TS.mapSel.has(x.name) ? labels[k] : null).filter(Boolean).join(', ')}. Set the height below.` : 'Click the part that failed on the plate map and set the height below.'; };
    pg.onclick = toggle; pg.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  });
}
$('tsFirstLayers').onclick = () => { $('tsZmin').value = '0'; $('tsZmax').value = '1.0'; };

$('tsPhotoInput').onchange = async (e) => {
  for (const f of [...e.target.files].slice(0, 4 - TS.photos.length)) {
    const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
    const img = await new Promise(r => { const im = new Image(); im.onload = () => r(im); im.src = url; });
    const sc = Math.min(1, 1280 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    TS.photos.push({ label: `User photo of the failed print (${f.name})`, dataUrl: c.toDataURL('image/jpeg', 0.85) });
  }
  e.target.value = ''; renderTsPhotos();
};
function renderTsPhotos() {
  $('tsPhotos').innerHTML = TS.photos.map((p, i) => `<div class="ph"><img src="${p.dataUrl}" alt="Photo ${i + 1}"><button class="x" data-i="${i}" aria-label="Remove photo">×</button></div>`).join('');
  $('tsPhotos').querySelectorAll('.x').forEach(b => b.onclick = () => { TS.photos.splice(Number(b.dataset.i), 1); renderTsPhotos(); });
}

$('tsRun').onclick = async () => {
  if (!TS.job) return;
  if (state.config.aiMode !== 'chat' && !state.config.hasKey) { openSettings(); return; }
  if (!TS.issues.size && !$('tsDesc').value.trim()) { toast('Pick at least one issue type or describe what happened.', 4000); return; }
  const zMin = $('tsZmin').value === '' ? null : Number($('tsZmin').value), zMax = $('tsZmax').value === '' ? null : Number($('tsZmax').value);
  let region = TS.region ? { ...TS.region } : (TS.mapSel.size ? { source: 'picked on the plate map', objects: [...TS.mapSel] } : null);
  if (zMin != null || zMax != null) {
    region = region || { source: 'height range only' };
    region.zMin = zMin ?? 0; region.zMax = zMax ?? region.zMin + 2;
    if (region.zMax < region.zMin) [region.zMin, region.zMax] = [region.zMax, region.zMin];
  }
  const renders = TS.model && TS.viewer ? TS.viewer.capturePainted(TS.region ? TS.region.faceDirection : null) : [];
  $('tsRun').disabled = true;
  $('tsResult').innerHTML = '<div class="working"><div class="bar"></div><p class="progress-line">Claude is diagnosing the print…</p></div>';
  try {
    let out = await withBusy('tsrun', 'Diagnosing the print…', () => api.tsRun({ issueTypes: [...TS.issues], description: $('tsDesc').value.trim(), region, photos: TS.photos, renders, assembly: !$('tsFitRow').classList.contains('hidden') && $('tsFitTogether').checked }));
    if (out && out.chat) {
      $('tsResult').innerHTML = '<p class="hint">Waiting for the chatbot’s answer…</p>';
      out = await askChatbot(out);
      if (!out) { $('tsResult').innerHTML = ''; return; }
    }
    TS.result = out; renderTsResult(); guideEvent('troubleshot');
    $('tsResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
    state.history = null; // refresh to show the saved diagnosis
  } catch (e) { $('tsResult').innerHTML = `<div class="error"><b>Couldn’t troubleshoot.</b><p>${esc(cleanErr(e))}</p></div>`; }
  finally { $('tsRun').disabled = false; }
};

function renderTsResult() {
  const { result: r, rows, regionGcode } = TS.result;
  const fixes = rows.filter(x => !x.invalid);
  $('tsResult').innerHTML = `
    <h3 class="group-title">Diagnosis</h3>
    <p class="summary">${esc(r.summary)}</p>
    ${r.causes.map(c => `<div class="cause ${esc(c.likelihood)}"><span class="k">${esc(c.likelihood)} likelihood · ${esc(c.kind)}</span><b>${esc(c.cause)}</b><span class="e">${esc(c.evidence)}</span></div>`).join('')}
    ${regionGcode ? `<p class="hint">At ${regionGcode.zFrom ?? '?'}–${regionGcode.zTo ?? '?'} mm the printer ran ${regionGcode.features.slice(0, 3).map(f => `${f.name.toLowerCase()} at ${f.speedMedian} mm/s`).join(', ')}; fan ${regionGcode.fanPercent || '—'}; ${regionGcode.toolheads.join(', ') || '—'}.</p>` : ''}
    ${fixes.length ? `<h3 class="group-title">Settings for the next print</h3>${fixes.map(x => `
      <div class="setting" data-id="${esc(x.id)}"><input type="checkbox" ${x.action === 'change' && !x.unchanged ? 'checked' : ''} aria-label="Use ${esc(x.label)}">
        <div class="name">${esc(x.label)}${x.slot ? ` <span class="tool">T${x.slot}</span>` : ''} <span class="pri ${esc(x.priority)}">${esc(x.priority)}</span>${x.action === 'check' ? ' <span class="check">double-check</span>' : ''}</div>
        <div class="values">${x.current == null ? '<span class="cur none">not set</span>' : `<span class="cur">${esc(x.current)}</span>`}<span class="arrow">›</span><input type="text" value="${esc(x.recommended)}" aria-label="New value for ${esc(x.label)}"> <span class="unit">${esc(x.unit)}</span></div>
        <div class="reason">${esc(x.reason)}</div><div class="where">${esc(x.gui)}</div></div>`).join('')}` : ''}
    ${r.physical_checks.length ? `<h3 class="group-title">Check at the printer</h3><ol class="fix-list">${r.physical_checks.map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
    ${r.orientation ? `<h3 class="group-title">Orientation</h3><p>${esc(r.orientation)}</p>` : ''}
    ${r.questions.length ? `<h3 class="group-title">To narrow it down</h3><ul class="fix-list">${r.questions.map(x => `<li>${esc(x)}</li>`).join('')}</ul><p class="hint">Add the answers to the description and troubleshoot again.</p>` : ''}
    <div class="ts-actions">
      ${TS.modelPath ? '<button class="btn primary" id="tsUse">Use these settings</button>' : '<button class="btn primary" id="tsUseOpen">Open the model and use these settings</button>'}
      <button class="btn" id="tsCopy">Copy checklist</button>
    </div>`;
  $('tsCopy').onclick = async () => {
    const lines = [`Troubleshooting ${TS.job.filename}`, '', r.summary, ''];
    for (const x of tsSelected()) lines.push(`[ ] ${x.label}${x.slot ? ` (T${x.slot})` : ''}: ${x.current ?? 'default'} -> ${x.recommended}   [${x.gui}]`);
    if (r.physical_checks.length) { lines.push('', 'At the printer:'); r.physical_checks.forEach(c => lines.push(`[ ] ${c}`)); }
    await navigator.clipboard.writeText(lines.join('\n')); toast('Checklist copied.', 3000);
  };
  const use = async (pathToModel) => {
    const picked = tsSelected().map(x => ({ key: x.key, recommended: x.recommended, slot: x.slot || 0, action: 'change', priority: x.priority, reason: x.reason }));
    $('tsDialog').close();
    await openFile(api.openPath(pathToModel));
    const newRows = await api.rowsFor(picked);
    state.result = { plan: { summary: `From the troubleshooter (${TS.job.filename}): ${r.summary}`, risks: r.causes.slice(0, 3).map(c => ({ severity: c.likelihood === 'high' ? 'warn' : 'info', title: c.cause, detail: c.evidence })),
        manual_steps: r.physical_checks, orientation: r.orientation, estimated_effect: '', material_notes: '', multicolor_notes: '', history_notes: '' },
      rows: newRows, recipe: { name: 'None', about: 'Settings from the troubleshooter, on top of the project as saved.' }, orientationChoices: [], originalSlice: null, usedHistory: false };
    renderResults(); showTab('recs');
    toast('Troubleshooter settings loaded. Compare slices, save, or send the fixed print.', 7000);
  };
  const u = $('tsUse'); if (u) u.onclick = () => use(TS.modelPath);
  const uo = $('tsUseOpen'); if (uo) uo.onclick = async () => { const pth = await api.tsPickModel(); if (pth) use(pth); };
}
function tsSelected() {
  return [...document.querySelectorAll('#tsResult .setting')].filter(el => el.querySelector('input[type=checkbox]').checked).map(el => {
    const x = TS.result.rows.find(rw => rw.id === el.dataset.id);
    return { ...x, recommended: el.querySelector('input[type=text]').value.trim() };
  });
}

// ---------- free chatbot mode ----------
// Resolves with the finished result, or null if the user closes the window.
function askChatbot(req) {
  return new Promise((resolve) => {
    const dlg = $('chatDialog');
    $('chatTitle').textContent = req.kind === 'ts' ? 'Ask a free chatbot to diagnose the print' : 'Ask a free chatbot for settings';
    setBusy(req.kind === 'ts' ? 'tsrun' : 'claude', 'Waiting for the chatbot’s answer. Follow the steps in the window.');
    $('chatSize').textContent = `${Math.round(req.chars / 100) / 10}k characters`;
    $('chatImgHint').textContent = req.imageCount ? `${req.imageCount} picture${req.imageCount === 1 ? '' : 's'} saved. Drag them into the chat (or use its attach button) along with the prompt.` : 'No pictures for this request.';
    $('chatImages').classList.toggle('hidden', !req.imageCount);
    $('chatReply').value = ''; $('chatError').classList.add('hidden');
    let done = false;
    const finish = (v) => { if (done) return; done = true; dlg.close(); resolve(v); };
    $('chatCopy').onclick = async () => { await navigator.clipboard.writeText(req.prompt); $('chatCopy').textContent = 'Copied'; setTimeout(() => { $('chatCopy').textContent = 'Copy prompt'; }, 2000); };
    dlg.querySelectorAll('[data-open]').forEach(b => b.onclick = () => window.open(b.dataset.open, '_blank'));
    $('chatImages').onclick = () => api.openFolder(req.folder);
    $('chatUse').onclick = async () => {
      $('chatError').classList.add('hidden');
      try { finish(await api.chatAnswer({ id: req.id, text: $('chatReply').value })); }
      catch (e) { $('chatError').textContent = cleanErr(e); $('chatError').classList.remove('hidden'); }
    };
    $('chatClose').onclick = () => finish(null);
    dlg.onclose = () => finish(null);
    dlg.showModal();
  });
}

const KEYS_URL = 'https://platform.claude.com/settings/keys';

// ---------- model choices ----------
// Costs measured from the app's real requests at Anthropic list prices (Nov 2026); ranges run from a repeat
// analysis within 5 minutes (instructions cached) to a first analysis.
const MODELS = {
  'claude-sonnet-5-5': { name: 'Sonnet 5.5', badge: 'Recommended', quality: 4, cost: '~4–10¢ per analysis', perFive: '~60–115 analyses for $5',
    about: 'The best balance for this app: thorough, specific advice at a few cents. Use this unless you have a reason not to.' },
  'claude-opus-5-5': { name: 'Opus 5.5', badge: 'Best results', quality: 5, cost: '~9–20¢ per analysis', perFive: '~30–55 analyses for $5',
    about: 'The most careful reasoning. Worth it for tricky multi-color prints, big plates and stubborn failures. About 2× the cost of Sonnet.' },
  'claude-haiku-5-5': { name: 'Haiku 5.5', badge: 'Cheapest', quality: 3, cost: 'well under 1¢ per analysis', perFive: '1,000+ analyses for $5',
    about: 'About 20× cheaper than Sonnet. Good for everyday prints; advice is simpler and can miss subtle problems. The app’s own checks still catch invalid or unsafe values.' },
};
function renderModelCard() {
  const v = $('modelSelect').value, m = MODELS[v];
  $('modelCard').innerHTML = m
    ? `<div class="mc-head"><b>${esc(m.name)}</b><span class="mc-badge">${esc(m.badge)}</span><span class="mc-stars" aria-label="Quality ${m.quality} of 5">${'★'.repeat(m.quality)}${'☆'.repeat(5 - m.quality)}</span></div>
       <p>${esc(m.about)}</p><p class="mc-cost">${esc(m.cost)} · ${esc(m.perFive)}</p>`
    : '<p>Any Claude model ID from the Claude Console. Costs and quality depend on the model.</p>';
}

// ---------- experience level, guide and tips ----------
// 0 brand new, 1 a little, 2 comfortable, 3 experienced. Decides how much help is shown.
function level() { const x = state.config && state.config.experience; return Number.isInteger(x) ? x : 1; }
function applyLevel() { document.body.dataset.level = String(level()); glossary.refresh(); }
// "Explain 3D printing words": on for Brand new and A little unless changed in Settings; off until a level is chosen
function wordsOn() {
  const c = state.config;
  if (!c || c.experience == null) return false;
  return typeof c.explainWords === 'boolean' ? c.explainWords : c.experience <= 1;
}

const sectionOf = (tip) => { const b = document.querySelector(`[data-tip="${tip}"]`); return b ? b.closest('section, .panel, .block') || b.parentElement.parentElement : null; };
const GUIDE_STEPS = [
  { id: 'open', title: 'Open a 3D model', text: 'Drag a .3mf file onto the window, or click Open 3MF. Files from MakerWorld, Printables and Snapmaker Orca all work. Downloaded a model? It’s usually in your Downloads folder.', target: () => $('dropZone'), until: 'opened', skipIf: () => !!state.file },
  { id: 'toolheads', title: 'Match your filament', text: 'Each toolhead (T1, T2…) should be set to the filament you’ll actually load. Pick the material (PLA is the most common) and click the color dot to match your spool. Parts of the model use the toolhead shown in the 3D view’s colors.', target: () => sectionOf('toolheads') },
  { id: 'inspect', title: 'Look the model over', text: 'Drag on the model to rotate it and scroll to zoom. Click “Overhangs”: red areas would be printed over thin air and need supports. The Orientation list suggests the safest way to place it on the bed.', target: () => $('viewerTools') },
  { id: 'goal', title: 'Choose quality or speed', text: 'Slide toward Quality for smoother, better-looking prints, or toward Speed for faster ones. If you like, say what the part is for (e.g. “display piece” or “holds weight”); the advice takes it into account.', target: () => sectionOf('goal') },
  { id: 'ask', title: 'Get recommended settings', text: 'Click “Get recommended settings”. The app slices your model to measure it, then asks the AI which settings to change and why. It usually takes under a minute.', target: () => $('analyzeBtn'), until: 'analyzed', skipIf: () => !!state.result },
  { id: 'review', title: 'Read the recommendations', text: 'Each row is one suggested change with the reason in plain words. Untick anything you don’t want. Safety checks at the top catch settings that wouldn’t work, and fix many automatically.', target: () => $('tab-recs') },
  { id: 'compare', title: 'Compare versions', text: 'Open “Compare slices” and click a version. You’ll see how it will look (smooth or visible layer lines), how strong it will be, and how long it takes, side by side.', target: () => document.querySelector('[data-tab=compare]'), until: 'compare-picked' },
  { id: 'finish', title: 'Save it or print it', text: 'Happy with a version? Click “Save as 3MF” to keep the model with these settings (open it in your slicer and print), or “Send to printer…” to print right away.', target: () => $('useButtons') || $('saveBtn'), until: 'saved' },
  { id: 'done', title: 'You’re all set!', text: 'That’s the whole workflow. If a print goes wrong, open Print history and click “Troubleshoot…”: you can paint where it failed and get fixes. Reopen this guide anytime with the Guide button at the top.' },
];
// The demo (api.demo) has its own tour: the sample rocket through every feature, with recorded results.
const DEMO_STEPS = [
  { id: 'open', title: 'Welcome to the demo!', text: 'This tour walks through the app with a sample model. Everything is recorded from the real app: nothing is sliced, printed or sent to the AI. Click Open 3MF and choose “Demo Rocket”.', target: () => $('openBtn'), until: 'opened', skipIf: () => !!state.file },
  { id: 'inspect', title: 'Spot the problem', text: 'This rocket was saved lying on its side. Click “Overhangs” above the model: red areas would be printed over thin air and need supports. Drag to rotate, scroll to zoom.', target: () => $('viewerTools') },
  { id: 'orient', title: 'Stand it up', text: 'The Orientation list scores every way to place the model. Pick “Stood upright · lowest risk”: overhangs drop from about 34 cm² to under 1 cm², so it needs no supports.', target: () => sectionOf('orientation'), until: 'oriented' },
  { id: 'toolheads', title: 'Four colors, four toolheads', text: 'Each toolhead (T1–T4) prints one filament: white body, red nose and fins, blue windows, grey nozzle. In the full app you set these to the spools you load.', target: () => sectionOf('toolheads') },
  { id: 'goal', title: 'Choose quality or speed', text: 'Slide toward Quality or Speed and say what the part is for. The advice takes both into account.', target: () => sectionOf('goal') },
  { id: 'ask', title: 'Get recommended settings', text: 'Click “Get recommended settings”. In the full app your model is sliced and Claude reviews it (about a minute, a few cents with your API key). Here the answer was recorded.', target: () => $('analyzeBtn'), until: 'analyzed', skipIf: () => !!state.result },
  { id: 'review', title: 'Read the recommendations', text: 'This file had 0.08 mm layers (6½ hours), 1 wall, 5% infill and no brim. Each row says what changes and why, in plain words. Untick anything you don’t want.', target: () => $('tab-recs') },
  { id: 'compare', title: 'Compare versions', text: 'Open “Compare slices”, click “Slice and compare”, then click a version to see how it will look, how strong it is and how long it takes.', target: () => document.querySelector('[data-tab=compare]'), until: 'compare-picked' },
  { id: 'finish', title: 'Save it or print it', text: 'In the full app, “Save as 3MF” keeps the model with these settings and “Send to printer…” prints it on your U1. In the demo they explain instead. Try “Send to printer…” to see the printer picker.', target: () => $('useButtons') || $('saveBtn') },
  { id: 'remix', title: 'Color remix', text: 'Click “Color remix…”: Identify parts with AI, Confirm parts, then Generate. Each scheme uses filament from your library. Apply “Deep Space Cruiser” to repaint the rocket.', target: () => $('remixBtn'), until: 'remixed' },
  { id: 'filament', title: 'Your filament library', text: 'Click “Filament” at the top right: the library Color remix picks from, with photos, spools, locations and print settings. Click a filament, try Spools and Dashboard. Changes last until you close the demo.', target: () => $('filamentBtn'), until: 'filament' },
  { id: 'history', title: 'When a print fails', text: 'Click “Back to model”, open “Print history” and click “Troubleshoot…” on the cancelled “Demo Rocket” print, then run it. The AI explains what went wrong and what to change.', target: () => document.querySelector('[data-tab=history]'), until: 'troubleshot' },
  { id: 'makerworld', title: 'MakerWorld files on a U1 (optional)', text: 'Using a Snapmaker U1 or another non-Bambu printer? Click Open 3MF and choose “Demo Rocket (MakerWorld version)” to see the app convert a Bambu Lab file. Bambu Lab owners open MakerWorld files as they are.', target: () => $('openBtn') },
  { id: 'done', title: 'That’s the tour!', text: 'Install the full AI 3D Print Advisor Studio to use all of this with your own models, printers and filament. You’ll need your own Anthropic API key, or use the free chatbot mode. Reopen this tour anytime with the Guide button.' },
];
if (api.demo) GUIDE_STEPS.splice(0, GUIDE_STEPS.length, ...DEMO_STEPS);

// What to click next, step by step (also inside windows like Color remix): the guide rings it with a pulsing
// "Click here" and names it. Each returns [element, what it's called] or null when the step is just reading.
const openDlg = (id) => { const d = $(id); return d && d.open ? d : null; };
const tabOn = (t) => { const b = document.querySelector(`[data-tab=${t}]`); return b && b.getAttribute('aria-selected') === 'true'; };
const byText = (sel, re, root = document) => [...root.querySelectorAll(sel)].find(b => re.test(b.textContent));
const filamentOpen = () => $('filamentBtn').getAttribute('aria-pressed') === 'true';
const demoPickBtn = (i, fallback) => { const d = openDlg('demoPick'); return d ? [d.querySelector(`[data-i="${i}"]`), `“${(d.querySelector(`[data-i="${i}"] b`) || {}).textContent || 'the model'}”`] : fallback; };
const NEXT_CLICK = {
  open: () => demoPickBtn(0, [$('openBtn'), '“Open 3MF”']),
  makerworld: () => demoPickBtn(1, [$('openBtn'), '“Open 3MF”']),
  inspect: () => { const b = document.querySelector('#viewerTools [data-mode=overhang]'); return b && b.getAttribute('aria-checked') !== 'true' ? [b, '“Overhangs”'] : null; },
  orient: () => { const o = byText('#orientList .orient-opt', /upright/i) || document.querySelector('#orientList .orient-opt.best'); return o ? [o, 'the upright orientation'] : null; },
  ask: () => [$('analyzeBtn'), '“Get recommended settings”'],
  compare: () => {
    if (!tabOn('compare')) return [document.querySelector('[data-tab=compare]'), '“Compare slices”'];
    const row = document.querySelector('#compareBody tr[data-v]:not([data-v=original])');
    return row ? [row, 'a version in the table'] : [$('sliceBtn'), '“Slice and compare”'];
  },
  finish: () => api.demo ? ($('sendVariant') ? [$('sendVariant'), '“Send to printer…”'] : null)
    : ($('save3mfVariant') ? [$('save3mfVariant'), '“Save as 3MF”'] : [$('saveBtn'), '“Save as 3MF”']),
  remix: () => {
    if (!openDlg('remixDialog')) return [$('remixBtn'), '“Color remix…”'];
    if (!$('rxPartsPane').classList.contains('hidden')) return !$('rxConfirm').disabled ? [$('rxConfirm'), '“Confirm parts”'] : [$('rxIdentify'), '“Identify parts with AI”'];
    const side = !$('rxBig').classList.contains('hidden') && $('rxBigSide').querySelector('[data-apply]');
    if (side) return [side, '“Apply to model”'];
    const cards = [...$('rxResults').querySelectorAll('.rx-card')];
    if (!cards.length) return [$('rxGo'), '“Generate”'];
    const card = cards.find(c => /deep space/i.test(c.textContent)) || cards[0];
    return [card.querySelector('[data-apply]'), '“Apply to model”' + (/deep space/i.test(card.textContent) ? ' on Deep Space Cruiser' : '')];
  },
  filament: () => [$('filamentBtn'), '“Filament”'],
  history: () => {
    if (filamentOpen()) return [$('filamentBtn'), '“Back to model”'];
    if (openDlg('tsDialog')) return [$('tsRun'), '“Troubleshoot with Claude”'];
    if (!tabOn('history')) return [document.querySelector('[data-tab=history]'), '“Print history”'];
    const b = document.querySelector('#tab-history [data-ts]'); return b ? [b, '“Troubleshoot…”'] : null;
  },
};
const GUIDE = { i: 0, on: false };
// The guide is a floating card. Windows like Color remix open as modal dialogs (above the page, the rest of it
// unclickable), so the card moves into whichever window is open and comes back when it closes. The "Click here" ring
// goes into the topmost window too (also the demo's model picker). While the guide is on, guideTick() keeps the ring
// on the thing to click next and moves the card to the corner where it covers neither that nor the main buttons.
const ring = document.createElement('div');
ring.id = 'guideRing'; ring.className = 'guide-ring hidden'; ring.setAttribute('aria-hidden', 'true');
ring.innerHTML = '<span class="guide-ring-tag">Click here</span>';
document.body.appendChild(ring);
const topDialog = (withDemo) => [...document.querySelectorAll('dialog[open]')].filter(d => d.id !== 'glossaryDialog' && (withDemo || !/^demo/.test(d.id))).pop();
function placeGuide() {
  const g = $('guide'), open = topDialog(false), home = open || document.body, top = topDialog(true) || document.body;
  if (g.parentElement !== home) home.appendChild(g);
  if (ring.parentElement !== top) top.appendChild(ring);
  g.classList.toggle('in-dialog', !!open);
  if (GUIDE.on) guideTick();
}
new MutationObserver(placeGuide).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
// an element's box when it's showing and clickable (not under another window); scrolled to first if it's off screen
function shownRect(el, scroll = false) {
  if (!el || !el.isConnected || el.closest('.hidden')) return null;
  const d = topDialog(true);
  if (d && !d.contains(el)) return null;
  let r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  if (scroll && (r.top < 0 || r.bottom > innerHeight) && guideScrolled !== el) {   // scroll to it once, then leave the scrolling to the user
    guideScrolled = el; el.scrollIntoView({ block: 'center' }); r = el.getBoundingClientRect();
  }
  return r.bottom < 0 || r.top > innerHeight ? null : r;
}
const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
let guideSpot = 0, guideLastEl = null, guideScrolled = null, guideTimer = null;
function positionCard(target) {
  const g = $('guide'); if (g.classList.contains('hidden')) return;
  const W = innerWidth, H = innerHeight, w = g.offsetWidth, h = g.offsetHeight, m = 16, top = 70;
  const mid = (W - w) / 2;
  const spots = [[m, H - h - m], [W - w - m, H - h - m], [W - w - m, top], [m, top], [mid, H - h - m], [mid, top]];
  const avoid = [];
  if (target) avoid.push([{ left: target.left - 40, right: target.right + 40, top: target.top - 48, bottom: target.bottom + 48 }, 1000]);
  const scope = topDialog(true) || document;
  scope.querySelectorAll('button, [role=radio], select, input, .orient-opt, .rx-card').forEach(el => { if (g.contains(el) || el.closest('.guide-ring')) return; const r = shownRect(el); if (r) avoid.push([r, el.matches('.btn.primary, [role=tab]') ? 4 : 2]); });
  const banner = document.querySelector('.demo-banner'); if (banner) avoid.push([banner.getBoundingClientRect(), 20]);
  const score = ([x, y]) => avoid.reduce((s, [r, k]) => s + k * overlap(r, { left: x, top: y, right: x + w, bottom: y + h }), 0);
  const scores = spots.map(score);
  const best = scores.indexOf(Math.min(...scores));
  if (scores[best] < scores[guideSpot]) guideSpot = best;   // stay put unless another corner is clearly better
  const [x, y] = spots[guideSpot];
  g.style.left = Math.max(m, x) + 'px'; g.style.top = Math.max(m, y) + 'px';
}
function guideTick() {
  const st = GUIDE.on && GUIDE_STEPS[GUIDE.i];
  if (!st) { ring.classList.add('hidden'); return; }
  const next = NEXT_CLICK[st.id] && st.id !== 'done' ? NEXT_CLICK[st.id]() : null;
  let el = next && next[0], r = shownRect(el, true);
  const click = !!r;
  if (!r) { el = st.target && st.target(); r = shownRect(el); }
  const act = click ? `Click ${next[1]}` : '';
  if ($('guideAct').textContent !== act) { $('guideAct').textContent = act; $('guideAct').classList.toggle('hidden', !act); $('guideWait').classList.toggle('hidden', !!act); }
  if (el && el !== guideLastEl) { guideLastEl = el; if (!click) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  ring.classList.toggle('hidden', !r);
  if (r) {
    const p = 5;
    Object.assign(ring.style, { left: `${r.left - p}px`, top: `${r.top - p}px`, width: `${r.width + 2 * p}px`, height: `${r.height + 2 * p}px` });
    ring.classList.toggle('soft', !click);
    ring.classList.toggle('tag-below', r.top < 48);
  }
  positionCard(r);
}
function startGuide(from = 0) { GUIDE.on = true; GUIDE.i = from; while (GUIDE_STEPS[GUIDE.i] && GUIDE_STEPS[GUIDE.i].skipIf && GUIDE_STEPS[GUIDE.i].skipIf()) GUIDE.i++; renderGuide(); }
function stopGuide(done = false) {
  GUIDE.on = false; $('guide').classList.add('hidden'); ring.classList.add('hidden');
  clearInterval(guideTimer); guideTimer = null;
  if (done) api.setConfig({ guideDone: true }).catch(() => {});
}
function renderGuide() {
  if (!GUIDE.on) return;
  const st = GUIDE_STEPS[GUIDE.i];
  if (!st) { stopGuide(true); return; }
  $('guide').classList.remove('hidden');
  $('guideStep').textContent = st.id === 'done' ? 'Done' : `Step ${GUIDE.i + 1} of ${GUIDE_STEPS.length - 1}`;
  $('guideTitle').textContent = st.title;
  $('guideText').innerHTML = esc(st.text) + (st.id === 'open' && wordsOn() ? '<br><span class="waiting">Words with a dotted underline are explained: hover over one to see what it means and a picture.</span>' : '');
  $('guideWait').textContent = st.until ? { opened: 'Waiting for you to open a model…', analyzed: 'Click the highlighted button to continue.', 'compare-picked': 'Click a version in the table to continue.', saved: 'Save or send it to finish.', oriented: 'Pick an orientation to continue.', remixed: 'Apply a scheme to continue.', filament: 'Open Filament to continue.', troubleshot: 'Run the troubleshooter to continue.' }[st.until] : '';
  $('guideAct').textContent = ''; $('guideAct').classList.add('hidden'); $('guideWait').classList.remove('hidden');
  $('guideDots').innerHTML = GUIDE_STEPS.slice(0, -1).map((_, k) => `<span class="${k <= GUIDE.i ? 'on' : ''}"></span>`).join('');
  $('guideBack').disabled = GUIDE.i === 0;
  $('guideNext').textContent = st.id === 'done' ? 'Finish' : st.until ? 'Skip step' : 'Next';
  guideLastEl = null;
  placeGuide();
  guideTick();
  if (!guideTimer) guideTimer = setInterval(guideTick, 250);
}
// the app reports what the user just did; the guide moves on when it's what the current step waits for
function guideEvent(name) {
  if (!GUIDE.on) return;
  const st = GUIDE_STEPS[GUIDE.i];
  if (st && st.until === name) { GUIDE.i++; while (GUIDE_STEPS[GUIDE.i] && GUIDE_STEPS[GUIDE.i].skipIf && GUIDE_STEPS[GUIDE.i].skipIf()) GUIDE.i++; renderGuide(); return; }
  // done a step or two early (before pressing Next): move on past it
  const ahead = GUIDE_STEPS.findIndex((x, k) => k > GUIDE.i && k <= GUIDE.i + 2 && x.until === name);
  if (ahead > 0) { GUIDE.i = ahead + 1; renderGuide(); }
  else if (name === 'analyzed') { const review = GUIDE_STEPS.findIndex(x => x.id === 'review'); if (GUIDE.i < review) { GUIDE.i = review; renderGuide(); } }
}
$('guideNext').onclick = () => { if (GUIDE_STEPS[GUIDE.i].id === 'done') { stopGuide(true); return; } GUIDE.i++; renderGuide(); };
$('guideBack').onclick = () => { if (GUIDE.i > 0) { GUIDE.i--; renderGuide(); } };
$('guideHide').onclick = () => { stopGuide(); toast('Guide hidden. Click “Guide” at the top to bring it back.', 4000); };
$('guideBtn').onclick = () => (GUIDE.on ? stopGuide() : startGuide(state.result ? GUIDE_STEPS.findIndex(x => x.id === 'review') : state.file ? 1 : 0));

// first launch: ask about experience once
function maybeWelcome() {
  applyLevel();
  if (state.config.experience != null) {
    if ((level() <= 1 || api.demo) && !state.config.guideDone && !GUIDE.on) startGuide(state.result ? GUIDE_STEPS.findIndex(x => x.id === 'review') : state.file ? 1 : 0);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const dlg = $('welcomeDialog');
    dlg.querySelectorAll('[data-xp]').forEach(b => b.onclick = async () => {
      const xp = Number(b.dataset.xp);
      state.config.experience = xp;
      await api.setConfig({ experience: xp }).catch(() => {});
      applyLevel(); dlg.close();
      if (xp <= 1 || api.demo) startGuide(state.file ? 1 : 0);
      else toast(xp === 3 ? 'Expert mode: tips are hidden and technical details shown. Change it anytime in Settings.' : 'Tips are on (the “?” buttons). Click “Guide” at the top for a step-by-step walkthrough anytime.', 6000);
      resolve();
    });
    dlg.addEventListener('cancel', (e) => e.preventDefault(), { once: true }); // a choice is needed; any choice is fine
    dlg.showModal();
  });
}

// "?" tips: plain-language explanations next to sections
const TIPS = {
  toolheads: 'A toolhead (T1, T2…) is a nozzle that melts and lays down one filament. Single-nozzle printers use T1 for everything. Set each to the filament you’ll load: PLA is easiest and most common, PETG is tougher and handles heat better, TPU is flexible.',
  orientation: 'How the model sits on the bed changes a lot: parts printed over thin air (“overhangs”) need supports, and a model touching the bed with a large flat area sticks better and won’t tip over. “Lowest risk” is the app’s pick.',
  goal: 'Quality prints thinner layers, so surfaces look smoother but the print takes longer. Speed prints thicker layers: much faster, with more visible lines. The middle is a good everyday choice.',
};
function showTip(btn) {
  const pop = $('tipPop');
  pop.textContent = TIPS[btn.dataset.tip] || '';
  pop.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  pop.style.left = `${Math.min(window.innerWidth - 340, r.left)}px`; pop.style.top = `${r.bottom + 8}px`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.tip-btn');
  if (b) { e.preventDefault(); showTip(b); return; }
  if (!e.target.closest('#tipPop')) $('tipPop').classList.add('hidden');
});

// ---------- settings ----------
async function loadConfig() {
  state.config = await api.getConfig();
  state.info = state.config.slicer;
  applyLevel();
  setTimeout(showAnalyzeCost, 0);
  $('keyHint').innerHTML = state.config.aiMode === 'chat' ? 'Free chatbot mode: you’ll copy a prompt into ChatGPT, Claude or Gemini and paste the answer back.'
    : !state.config.hasKey ? `To get recommendations, create a Claude API key at <a href="${KEYS_URL}" target="_blank" rel="noopener">platform.claude.com/settings/keys</a> and paste it in <button class="link" id="keyLink">Settings</button>, or switch to the free chatbot mode there.`
    : state.config.hasKey ? '' : 'To get recommendations, add a Claude API key or switch to the free chatbot mode in <button class="link" id="keyLink">Settings</button>.';
  const kl = $('keyLink'); if (kl) kl.onclick = openSettings;
}
function openSettings() {
  const sel = $('modelSelect');
  const known = [...sel.options].some(o => o.value === state.config.model);
  sel.value = known ? state.config.model : 'custom';
  $('customModel').value = known ? '' : state.config.model;
  $('customModel').classList.toggle('hidden', known);
  renderModelCard();
  $('apiKey').value = '';
  const keysLink = `<a href="${KEYS_URL}" target="_blank" rel="noopener">platform.claude.com/settings/keys</a>`;
  $('keyStatus').innerHTML = state.config.keyNeedsReentry ? `Your saved key couldn’t be unlocked after the app was renamed. Please paste it again (find or create it at ${keysLink}).`
    : state.config.hasKey ? `A key is saved. Leave blank to keep it. Manage your keys at ${keysLink}.`
    : `No key saved yet. Create one at ${keysLink} (pay-as-you-go; a Claude subscription isn’t needed, but the account needs a little prepaid credit).`;
  document.querySelectorAll('input[name=aiMode]').forEach(r => { r.checked = r.value === (state.config.aiMode || 'api'); });
  $('experienceSelect').value = String(level());
  $('explainWords').checked = wordsOn() || (state.config.experience == null && level() <= 1);
  $('experienceSelect').onchange = () => { $('explainWords').checked = Number($('experienceSelect').value) <= 1; };
  const syncMode = () => { const chat = document.querySelector('input[name=aiMode]:checked').value === 'chat'; $('apiKeyField').classList.toggle('hidden', chat); $('modelSelect').closest('.field').classList.toggle('hidden', chat); };
  document.querySelectorAll('input[name=aiMode]').forEach(r => { r.onchange = syncMode; });
  syncMode();
  $('slicerPath').value = state.config.slicerPath || '';
  $('slicerPath').placeholder = state.config.detectedSlicer ? `Detected: ${state.config.detectedSlicer}` : 'Not found. Browse to snapmaker-orca.exe';
  $('slicerStatus').textContent = state.info.available ? `Ready: ${state.info.filaments.length} U1 filament presets found.` : 'Slicing is off until Snapmaker Orca is found.';
  $('printerRows').innerHTML = '';
  (state.config.printers.length ? state.config.printers : [{}]).forEach(p => addPrinterRow(p));
  $('discoverResults').innerHTML = ''; $('discoverStatus').textContent = '';
  renderSpend();
  $('aboutLine').innerHTML = `AI 3D Print Advisor Studio ${esc(state.config.version || '')}${state.config.homepage ? ` · <a href="${esc(state.config.homepage)}#readme" target="_blank" rel="noopener">Guide and help</a>` : ''} · Not affiliated with Snapmaker.`;
  $('settingsDialog').showModal();
}
$('settingsBtn').onclick = openSettings;

// ---------- AI spending: top-bar counter and the Settings section ----------
const dollars = (usd) => (usd >= 1 ? `$${usd.toFixed(2)}` : usd >= 0.01 ? `${(usd * 100).toFixed(usd < 0.1 ? 1 : 0)}¢` : usd > 0 ? 'under 1¢' : '$0.00');
function showSpendChip(month) { $('spendChip').textContent = `AI ${month.usd >= 1 ? '$' + month.usd.toFixed(2) : month.usd > 0 ? dollars(month.usd) : '$0.00'}`; }
let spendFlash;
api.onSpend(({ usd, feature, month }) => {
  const chip = $('spendChip');
  chip.textContent = `+${dollars(usd)}`; chip.classList.add('flash'); chip.title = `${feature}: ${dollars(usd)}. This month: ${dollars(month.usd)} (details in Settings)`;
  clearTimeout(spendFlash);
  spendFlash = setTimeout(() => { chip.classList.remove('flash'); showSpendChip(month); }, 4000);
  if ($('settingsDialog').open) renderSpend();
});
api.spendSummary().then(s => showSpendChip(s.month)).catch(() => {});
$('spendChip').onclick = () => { openSettings(); setTimeout(() => $('spendField').scrollIntoView({ block: 'center' }), 50); };
async function renderSpend() {
  const s = await api.spendSummary().catch(() => null);
  if (!s) return;
  showSpendChip(s.month);
  const when = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  $('spendSummary').innerHTML = `<div class="spend-totals"><span><b>${dollars(s.month.usd)}</b>this month (${s.month.calls} request${s.month.calls === 1 ? '' : 's'})</span>
      <span><b>${dollars(s.last30.usd)}</b>last 30 days</span><span><b>${dollars(s.all.usd)}</b>${s.since ? `since ${new Date(s.since).toLocaleDateString()}` : 'in total'}</span></div>
    ${s.byFeature.length ? `<table><tbody>${s.byFeature.map(f => `<tr><td>${esc(f.feature)}</td><td class="n">${f.calls}×</td><td class="n">${dollars(f.usd)}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">No AI requests yet this month.</p>'}
    ${s.recent.length ? `<details><summary>Latest requests</summary><table><tbody>${s.recent.map(e => `<tr><td>${esc(when(e.t))} · ${esc(e.feature)}<br><small>${esc(e.model)}: ${e.in + e.cr + e.cw} tokens in, ${e.out} out${e.searches ? `, ${e.searches} web search${e.searches === 1 ? '' : 'es'}` : ''}</small></td><td class="n">${dollars(e.usd)}</td></tr>`).join('')}</tbody></table></details>` : ''}`;
}
$('spendClear').onclick = async () => { await api.spendClear(); renderSpend(); toast('The app’s spending record was cleared.', 3000); };

// ---------- printers in Settings: any number, added by hand or found on the network ----------
function addPrinterRow(p = {}) {
  const n = $('printerRows').children.length + 1;
  const row = document.createElement('div');
  row.className = 'printer-row';
  row.innerHTML = `<input type="text" class="p-name" placeholder="Name, e.g. Office U1" aria-label="Printer ${n} name">
    <input type="text" class="p-url" placeholder="Address, e.g. 192.168.1.50" aria-label="Printer ${n} address">
    <input type="password" class="p-key" placeholder="${p.hasKey ? 'Key saved' : 'API key (optional)'}" aria-label="Printer ${n} API key">
    <button type="button" class="btn ghost p-remove" aria-label="Remove printer ${n}" title="Remove this printer">×</button>`;
  row.querySelector('.p-name').value = p.name || '';
  row.querySelector('.p-url').value = p.url || '';
  row.querySelector('.p-remove').onclick = () => { row.remove(); if (!$('printerRows').children.length) addPrinterRow(); };
  $('printerRows').appendChild(row);
  return row;
}
$('addPrinterBtn').onclick = () => addPrinterRow().querySelector('.p-name').focus();
const normAddr = (u) => String(u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/:80$/, '');
api.onDiscoverProgress(({ done, total, found }) => { $('discoverStatus').textContent = `Checking your network… ${Math.round(100 * done / total)}% (${found} found)`; });
$('discoverBtn').onclick = async () => {
  $('discoverBtn').disabled = true; $('discoverResults').innerHTML = ''; $('discoverStatus').textContent = 'Checking your network…';
  try {
    const found = await api.discoverPrinters();
    const have = () => new Set([...document.querySelectorAll('.printer-row .p-url')].map(i => normAddr(i.value)).filter(Boolean));
    if (!found.length) {
      $('discoverStatus').textContent = '';
      $('discoverResults').innerHTML = '<p class="hint">No printers answered. Make sure they’re on and on the same network as this computer, or add them by hand with their address (shown in each printer’s network settings, or your router’s device list).</p>';
      return;
    }
    $('discoverStatus').textContent = `Found ${found.length} printer${found.length === 1 ? '' : 's'}.`;
    const render = () => {
      const h = have();
      const fresh = found.filter(f => !h.has(normAddr(f.url)));
      $('discoverResults').innerHTML = `<ul class="discover-list">${found.map((f, i) => `<li><span><b>${esc(f.hostname || f.host)}</b> · ${esc(f.kind)} · ${esc(f.url)}</span>${h.has(normAddr(f.url)) ? '<span class="ok-line">Added</span>' : `<button type="button" class="btn" data-add="${i}">Add</button>`}</li>`).join('')}</ul>
        ${fresh.length > 1 ? '<button type="button" class="btn primary" id="addAllFound">Add all</button>' : ''}`;
      const add = (f) => {
        // fill an empty row first, else add one; name from the printer's own name
        const empty = [...document.querySelectorAll('.printer-row')].find(r => !r.querySelector('.p-url').value.trim() && !r.querySelector('.p-name').value.trim());
        const row = empty || addPrinterRow();
        const count = document.querySelectorAll('.printer-row').length;
        row.querySelector('.p-name').value = f.hostname ? f.hostname.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : `${f.isU1 ? 'U1' : 'Printer'} ${count}`;
        row.querySelector('.p-url').value = f.url;
      };
      $('discoverResults').querySelectorAll('[data-add]').forEach(b => b.onclick = () => { add(found[Number(b.dataset.add)]); render(); });
      const all = $('addAllFound'); if (all) all.onclick = () => { fresh.forEach(add); render(); };
    };
    render();
  } catch (e) { $('discoverStatus').textContent = `Couldn’t search the network: ${cleanErr(e)}`; }
  finally { $('discoverBtn').disabled = false; }
};
$('browseSlicer').onclick = async () => { const p = await api.browseSlicer(); if (p) $('slicerPath').value = p; };
$('modelSelect').onchange = e => { $('customModel').classList.toggle('hidden', e.target.value !== 'custom'); renderModelCard(); };
$('settingsDialog').addEventListener('close', async () => {
  if ($('settingsDialog').returnValue !== 'save') return;
  const model = $('modelSelect').value === 'custom' ? $('customModel').value : $('modelSelect').value;
  const printers = [...document.querySelectorAll('.printer-row')].map(r => ({ name: r.querySelector('.p-name').value.trim(), url: r.querySelector('.p-url').value.trim(), apiKey: r.querySelector('.p-key').value.trim() })).filter(p => p.url);
  const patch = { model, printers, slicerPath: $('slicerPath').value.trim(), aiMode: (document.querySelector('input[name=aiMode]:checked') || {}).value || 'api', experience: Number($('experienceSelect').value) };
  // remember the switch only when it differs from what the level would choose, so changing level later still applies
  patch.explainWords = $('explainWords').checked === (patch.experience <= 1) ? null : $('explainWords').checked;
  if ($('apiKey').value.trim()) patch.apiKey = $('apiKey').value;
  const before = state.info.available;
  await api.setConfig(patch);
  await loadConfig();
  state.history = null;
  toast('Settings saved.', 2500);
  if (state.file && before !== state.info.available) { state.slots = state.slots.map(s => ({ ...s, preset: matchPreset(s.type, s.preset) })); renderMaterials(); prepare(); }
});

// ---------- toast ----------
let toastTimer;
function toast(msg, ms = 4000, onReveal) {
  const t = $('toast');
  t.innerHTML = esc(msg) + (onReveal ? ' <button class="link">Show in folder</button>' : '');
  if (onReveal) t.querySelector('button').onclick = onReveal;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('toast').classList.add('hidden'); }
document.querySelector('[data-tab=compare]').addEventListener('click', e => { e.currentTarget.textContent = 'Compare slices'; });

loadConfig();
