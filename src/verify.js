// What a print will really use, read back from the sliced result that is about to be sent (not from what the app meant
// to change): the settings Snapmaker Orca embedded in the G-code (; CONFIG_BLOCK), the layer heights measured from the
// toolpaths themselves (;Z: lines), and the per-object settings in the sliced project. Each intended change is checked
// against that, so the Send dialog can show ✓ or a warning before printing.
'use strict';

const JSZip = require('jszip');
const { BY_KEY, SCHEMA, normalize } = require('./orca-settings');
const { parseConfigBlock } = require('./gcodeinfo');

const label = (k) => (BY_KEY[k] && BY_KEY[k].label) || (SCHEMA[k] && SCHEMA[k].label) || k.replace(/_/g, ' ');
const isFilament = (k) => (BY_KEY[k] && BY_KEY[k].scope === 'filament') || (SCHEMA[k] && SCHEMA[k].scope === 'filament');
const clean = (v) => String(v ?? '').replace(/%$/, '').trim();
function same(a, b) {
  const x = clean(a), y = clean(b);
  const nx = Number(x), ny = Number(y);
  if (x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny)) return Math.abs(nx - ny) <= 1e-6 + 0.0005 * Math.max(Math.abs(nx), Math.abs(ny));
  return x === y;
}
const round = (n) => +(+n).toFixed(3);

// layer heights as printed: the first layer, the usual step, and every step used (per-object or variable heights)
function measureLayers(text) {
  const z = [...text.matchAll(/^;Z:([\d.]+)/gm)].map(m => +m[1]);
  if (!z.length) return null;
  const steps = new Map();
  for (let i = 1; i < z.length; i++) { const d = round(z[i] - z[i - 1]); if (d > 0) steps.set(d, (steps.get(d) || 0) + 1); }
  const sorted = [...steps.entries()].sort((a, b) => b[1] - a[1]);
  return { count: z.length, first: round(z[0]), step: sorted.length ? sorted[0][0] : round(z[0]), steps: sorted.map(([h, n]) => ({ h, n })), top: round(z[z.length - 1]) };
}

// A project's objects: { objectId: { key: value } } (their own metadata, name included)
async function objectSettings(zipBuffer) {
  const out = {};
  if (!zipBuffer) return out;
  const zip = await JSZip.loadAsync(zipBuffer);
  const f = zip.file('Metadata/model_settings.config');
  if (!f) return out;
  const xml = await f.async('string');
  for (const m of xml.matchAll(/<object id="([^"]+)">([\s\S]*?)<\/object>/g)) {
    const own = m[2].replace(/<part\b[\s\S]*?<\/part>/g, '');
    out[m[1]] = Object.fromEntries([...own.matchAll(/<metadata key="([^"]+)" value="([^"]*)"/g)].map(x => [x[1], x[2]]));
  }
  return out;
}

// changes: [{key, value, slot}] for the whole print; objectChanges: { objectId: [{key, value}] }; names: { objectId: name };
// usedSlots: toolheads the print uses. Returns { checks: [{label, where, wanted, actual, ok, note}], summary: [...], layers, allOk }
// inputProject: the file given to the slicer; Orca renumbers objects in the project it exports (and keeps only the
// plate's objects), so objects are matched by name (names are made unique before slicing)
async function verifyPrint({ gcodeText, slicedProject, inputProject = null, changes = [], objectChanges = null, names = {}, usedSlots = [1] }) {
  const cfg = parseConfigBlock(gcodeText || '') || {};
  const L = gcodeText ? measureLayers(gcodeText) : null;
  const value = (key, slot) => { const v = cfg[key]; return Array.isArray(v) ? v[isFilament(key) ? Math.max(0, (slot || 1) - 1) : 0] : v; };
  const checks = [];
  for (const c of changes) {
    const wanted = normalize(c.key, c.value);
    let actual = value(c.key, c.slot), ok = actual !== undefined && same(wanted, actual), note = '';
    if (c.key === 'layer_height' && L) { ok = ok && L.steps.some(s => same(s.h, wanted)); note = `measured in the toolpaths: ${L.steps.filter(s => s.n >= Math.max(3, L.count * 0.05)).slice(0, 3).map(s => `${s.h} mm`).join(', ') || `${L.step} mm`} layers`; }
    if (c.key === 'initial_layer_print_height' && L) { ok = same(L.first, wanted); actual = L.first; note = 'measured: the first layer'; }
    checks.push({ key: c.key, label: label(c.key), slot: c.slot || 0, where: 'whole print', wanted: String(wanted), actual: actual === undefined ? 'not in the print' : String(actual), ok, note });
  }
  if (objectChanges && Object.keys(objectChanges).length) {
    const slicedById = await objectSettings(slicedProject);
    const input = inputProject ? await objectSettings(inputProject) : null;
    const byName = new Map(Object.values(slicedById).filter(o => o.name).map(o => [o.name, o]));
    // the input's id -> the same object in the sliced project (by its unique name); without the input, by id
    const sliced = {};
    for (const id of Object.keys(objectChanges)) {
      const nm = input && input[id] && input[id].name;
      if (input) { if (nm && byName.has(nm)) sliced[id] = byName.get(nm); } else if (slicedById[id]) sliced[id] = slicedById[id];
      if (nm) names[id] = nm;
    }
    // one row per setting and value, listing the objects in this print that get it (objects on other plates aren't)
    const rows = new Map();
    for (const [id, list] of Object.entries(objectChanges)) for (const c of list) {
      if (input && !sliced[id]) continue;
      const wanted = normalize(c.key, c.value), k = `${c.key}=${wanted}`;
      const r = rows.get(k) || { key: c.key, wanted, ids: [] };
      r.ids.push(id); rows.set(k, r);
    }
    for (const r of rows.values()) {
      const missing = r.ids.filter(id => !(sliced[id] && same(sliced[id][r.key], r.wanted)));
      let ok = !missing.length, note = '';
      if (r.key === 'layer_height' && L) { const hit = L.steps.some(s => same(s.h, r.wanted)); ok = ok && hit; note = hit ? `measured in the toolpaths: ${r.wanted} mm layers` : `no ${r.wanted} mm layers found in the toolpaths`; }
      const who = [...new Set(r.ids.map(id => names[id] || `object ${id}`))];
      checks.push({ key: r.key, label: label(r.key), slot: 0, where: `${who.length === 1 ? who[0] : `${who.length} objects`} (per object)`, objects: who, wanted: String(r.wanted),
        actual: ok ? String(r.wanted) : missing.length ? `missing on ${missing.length} object${missing.length === 1 ? '' : 's'}` : 'not found', ok, note });
    }
  }
  // the main settings the print uses, whatever was changed
  const summary = [];
  if (L) summary.push({ label: 'Layer height (measured)', value: `${L.steps.filter(s => s.n >= Math.max(3, L.count * 0.05)).slice(0, 3).map(s => `${s.h} mm`).join(' / ') || `${L.step} mm`}, first layer ${L.first} mm, ${L.count} layers` });
  for (const k of ['wall_loops', 'top_shell_layers', 'bottom_shell_layers', 'sparse_infill_density', 'sparse_infill_pattern', 'enable_support', 'support_type', 'brim_type', 'outer_wall_speed']) {
    const v = value(k);
    if (v !== undefined) summary.push({ label: label(k), value: k === 'enable_support' ? (v === '1' ? 'on' : 'off') : String(v) });
  }
  const temps = usedSlots.map(s => `T${s} ${value('nozzle_temperature', s) ?? '?'} °C`).join(', ');
  if (cfg.nozzle_temperature) summary.push({ label: 'Nozzle temperature', value: temps });
  return { checks, summary, layers: L, allOk: checks.every(c => c.ok), hasConfig: Object.keys(cfg).length > 0 };
}

module.exports = { verifyPrint, measureLayers, same };
