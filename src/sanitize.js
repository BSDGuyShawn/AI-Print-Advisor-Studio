// Repairs values current Snapmaker Orca rejects on the command line, the way the desktop app silently
// corrects them when opening a file. Covers, globally and per object/part:
//   - numbers outside Snapmaker Orca's ranges (src/orca-schema.json), e.g. legacy wall_filament = 0
//     ("the object's toolhead") or tree_support_wall_count = -1 (old "auto")
//   - choice values that no longer exist (renamed/removed options) -> the stock U1 value
//   - layer heights outside the printer's min/max layer height
// Every fix is returned with a plain-language description so the app can show it.
const { SCHEMA } = require('./orca-settings');
const U1_TEMPLATE = require('./u1-template-settings.json');

const NUMERIC = new Set(['coInt', 'coInts', 'coFloat', 'coFloats']);
const ENUM = new Set(['coEnum', 'coEnums']);
const FILAMENT_PICK = /_filament$/;
const first = (v) => (Array.isArray(v) ? v[0] : v);

// defaults: values to fall back to for invalid choices (stock U1). own: the settings being checked, whose
// printer limits (min/max layer height, nozzle) decide what layer heights are valid.
function makeContext(defaults, own) {
  const d = { ...U1_TEMPLATE, ...(defaults || {}) };
  const o = own || d;
  const num = (k) => { const v = parseFloat(first(o[k])); return Number.isFinite(v) ? v : null; };
  // In Orca a limit of 0 means "no limit": the maximum then follows the nozzle (75% of it), the minimum is tiny.
  const pos = (k) => { const v = num(k); return v != null && v > 0 ? v : null; };
  const nozzle = pos('nozzle_diameter') ?? 0.4;
  // only judge layer heights when the settings carry their printer's own limits (every real project does)
  const hasLimits = num('max_layer_height') != null;
  return { defaults: d, hasLimits, minLayer: pos('min_layer_height') ?? 0.04,
    maxLayer: Math.min(pos('max_layer_height') ?? nozzle * 0.75, nozzle) };
}

// Returns a corrected string, or null when the value is fine / not ours to judge.
function fixValue(key, raw, ctx) {
  const s = SCHEMA[key];
  if (!s) return null;
  const str = String(raw).trim();
  if (ENUM.has(s.type)) {
    if (!s.enum || !s.enum.length || s.enum.includes(str) || (s.accepted && s.accepted.includes(str))) return null;
    const dv = first(ctx.defaults[key]);
    return dv != null && s.enum.includes(String(dv)) && String(dv) !== str ? String(dv) : null;
  }
  if (!NUMERIC.has(s.type) || !/^-?\d+(\.\d+)?$/.test(str)) return null;
  const v = Number(str);
  if (ctx.hasLimits && (key === 'layer_height' || key === 'initial_layer_print_height')) {
    if (v > 0 && v < ctx.minLayer) return String(ctx.minLayer);
    if (v > ctx.maxLayer) return String(ctx.maxLayer);
  }
  if (s.min == null && s.max == null) return null;
  const isInt = s.type.startsWith('coInt');
  if (s.min != null && v < s.min) return String(isInt ? Math.ceil(s.min) : s.min);
  if (s.max != null && v > s.max) return String(isInt ? Math.floor(s.max) : s.max);
  return null;
}

function sanitizeSettings(ps, defaults) {
  const ctx = makeContext(defaults, ps);
  const fixes = [];
  for (const [key, val] of Object.entries(ps || {})) {
    if (Array.isArray(val)) {
      let changed = false;
      const out = val.map(v => { const f = fixValue(key, v, ctx); if (f != null) { changed = true; return f; } return v; });
      if (changed) { fixes.push({ key, from: val.join(', '), to: out.join(', ') }); ps[key] = out; }
    } else {
      const f = fixValue(key, val, ctx);
      if (f != null) { fixes.push({ key, from: String(val), to: f }); ps[key] = f; }
    }
  }
  return fixes;
}

function sanitizeModelSettings(xml, defaults, own) {
  const ctx = makeContext(defaults, own);
  const fixes = [];
  const out = xml.replace(/[ \t]*<metadata key="([^"]+)" value="([^"]*)"\s*\/>\r?\n?/g, (m, key, value) => {
    const f = fixValue(key, value, ctx);
    if (f == null) return m;
    if (FILAMENT_PICK.test(key) && Number(value) === 0) { fixes.push({ key, from: value, to: 'the object’s toolhead', perObject: true }); return ''; }
    fixes.push({ key, from: value, to: f, perObject: true });
    return m.replace(`value="${value}"`, `value="${f}"`);
  });
  return { xml: out, fixes };
}

async function sanitizeZip(zip, defaults) {
  const fixes = [];
  const psFile = zip.file('Metadata/project_settings.config');
  let ps = null;
  if (psFile) {
    ps = JSON.parse(await psFile.async('string'));
    const f = sanitizeSettings(ps, defaults);
    if (f.length) { zip.file('Metadata/project_settings.config', JSON.stringify(ps, null, 4)); fixes.push(...f); }
  }
  const msFile = zip.file('Metadata/model_settings.config');
  if (msFile) {
    const r = sanitizeModelSettings(await msFile.async('string'), defaults, ps);
    if (r.fixes.length) { zip.file('Metadata/model_settings.config', r.xml); fixes.push(...r.fixes); }
  }
  return fixes;
}

// "tree_support_wall_count: -1 not in range [0,2]" lines from the CLI (catches anything the schema misses)
function parseRangeErrors(log) {
  const out = [];
  for (const m of String(log || '').matchAll(/^\s*([a-z0-9_]+): (-?[\d.]+) not in range \[(-?[\d.e+]+),\s*(-?[\d.e+]+)\]/gim)) {
    out.push({ key: m[1], value: m[2], min: Number(m[3]), max: Number(m[4]) });
  }
  return out;
}

// Apply the CLI's own ranges to a zip. Returns fixes.
async function applyRangeErrors(zip, errors) {
  const fixes = [];
  const clamp = (key, raw, e) => {
    const v = Number(raw);
    if (!Number.isFinite(v) || (v >= e.min && v <= e.max)) return null;
    return String(v < e.min ? e.min : e.max);
  };
  const psFile = zip.file('Metadata/project_settings.config');
  if (psFile) {
    const ps = JSON.parse(await psFile.async('string'));
    for (const e of errors) {
      if (!(e.key in ps)) continue;
      const before = ps[e.key];
      ps[e.key] = Array.isArray(before) ? before.map(x => clamp(e.key, x, e) ?? x) : (clamp(e.key, before, e) ?? before);
      if (JSON.stringify(before) !== JSON.stringify(ps[e.key])) fixes.push({ key: e.key, from: String(before), to: String(ps[e.key]) });
    }
    zip.file('Metadata/project_settings.config', JSON.stringify(ps, null, 4));
  }
  const msFile = zip.file('Metadata/model_settings.config');
  if (msFile) {
    let xml = await msFile.async('string');
    for (const e of errors) {
      xml = xml.replace(new RegExp(`[ \\t]*<metadata key="${e.key}" value="([^"]*)"\\s*/>\\r?\\n?`, 'g'), (m, value) => {
        const f = clamp(e.key, value, e);
        if (f == null) return m;
        if (FILAMENT_PICK.test(e.key) && Number(value) === 0) { fixes.push({ key: e.key, from: value, to: 'the object’s toolhead', perObject: true }); return ''; }
        fixes.push({ key: e.key, from: value, to: f, perObject: true });
        return m.replace(`value="${value}"`, `value="${f}"`);
      });
    }
    zip.file('Metadata/model_settings.config', xml);
  }
  return fixes;
}

function describeFix(f) {
  const label = (SCHEMA[f.key] && (SCHEMA[f.key].full_label || SCHEMA[f.key].label)) || f.key;
  return `${label}${f.perObject ? ' (on an object)' : ''}: ${f.from} → ${f.to}`;
}
function describe(fixes) {
  const uniq = new Map();
  for (const f of fixes) uniq.set(`${f.key}${f.perObject ? 'p' : ''}`, describeFix(f));
  return [...uniq.values()].join('; ');
}

module.exports = { sanitizeZip, sanitizeSettings, sanitizeModelSettings, parseRangeErrors, applyRangeErrors, describe, describeFix };
