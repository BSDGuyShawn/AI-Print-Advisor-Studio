// The user's filament inventory (their own "Filament Inventory" page). Two sources, best first:
//   print-advisor-stock.json  written by the inventory page whenever it changes: what's actually on hand
//   data.js (+ specs.js)      the purchase catalog the page is built from: everything ever bought
// The location may be the folder, its index.html, or a file:/// link to it (with or without #inventory).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fileURLToPath } = require('url');

function resolveFolder(loc) {
  let p = String(loc || '').trim().replace(/^"|"$/g, '');
  if (!p) return null;
  if (/^file:/i.test(p)) { try { p = fileURLToPath(p.replace(/#.*$/, '').replace(/\?.*$/, '')); } catch { return null; } }
  try { if (fs.statSync(p).isFile()) p = path.dirname(p); } catch { return null; }
  return p;
}

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Run data.js (+ specs.js) in a sandbox and rebuild the filament list the way the page does.
function fromCatalog(dir) {
  const code = ['specs.js', 'data.js'].filter(f => fs.existsSync(path.join(dir, f))).map(f => fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!code.length || !fs.existsSync(path.join(dir, 'data.js'))) return null;
  const ctx = vm.createContext({ console: { log() {}, warn() {} } });
  vm.runInContext(code.join('\n;\n') + '\n;this.__ORDERS = typeof ORDERS !== "undefined" ? ORDERS : []; this.__SPECS = typeof SPECS !== "undefined" ? SPECS : {};', ctx, { timeout: 2000 });
  const map = new Map();
  for (const o of ctx.__ORDERS || []) {
    for (const [color, fams, hex, n = 1] of o.colors || []) {
      const id = slug([o.brand, o.type, o.line, color, o.grams].join(' '));
      let f = map.get(id);
      if (!f) {
        const spec = ctx.__SPECS[`${o.brand}|${o.line}|${o.finish}`] || ctx.__SPECS[`${o.brand}|${o.line}`] || {};
        f = { id, brand: o.brand, type: o.type, line: o.line, finish: o.finish, color, fams: String(fams).split(','), hex, grams: o.grams, spools: 0, remainingG: null, loaded: [], preset: spec.preset || null, nozzle: spec.nz || null, bed: spec.bd || null };
        map.set(id, f);
      }
      f.spools += n;
    }
  }
  return [...map.values()];
}

function loadInventory(loc) {
  const dir = resolveFolder(loc);
  if (!dir) return { ok: false, error: 'That location wasn’t found. Choose the Filament Inventory folder (the one with index.html).' };
  const stockFile = path.join(dir, 'print-advisor-stock.json');
  if (fs.existsSync(stockFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(stockFile, 'utf8'));
      if (Array.isArray(j.filaments)) return { ok: true, dir, onHand: true, updated: j.updated || null, filaments: j.filaments };
    } catch (e) { /* fall through to the catalog */ }
  }
  try {
    const f = fromCatalog(dir);
    if (f && f.length) return { ok: true, dir, onHand: false, updated: null, filaments: f, note: 'Using every filament you’ve bought (empties included). Import it on the Filament screen so only what’s on hand is used.' };
  } catch (e) { return { ok: false, error: `Couldn’t read the inventory: ${e.message}` }; }
  return { ok: false, error: 'No inventory data found there (expected print-advisor-stock.json or data.js).' };
}

// First colour of a filament (gradients and dual colours list several)
const mainHex = (f) => String(Array.isArray(f.hex) ? f.hex[0] : f.hex || '#888888').slice(0, 7);

// A compact list for the AI: one line per filament
function forPrompt(filaments, { types = null } = {}) {
  return filaments.filter(f => !types || types.includes(f.type)).map(f => ({
    id: f.id, name: `${f.brand} ${f.line} ${f.color}`.replace(/\s+/g, ' '), type: f.type, finish: f.finish,
    hex: Array.isArray(f.hex) ? f.hex : mainHex(f), families: f.fams, spools: f.spools,
    remainingG: f.remainingG, loaded: f.loaded && f.loaded.length ? f.loaded : undefined,
  }));
}

module.exports = { loadInventory, resolveFolder, mainHex, forPrompt };
