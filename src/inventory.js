// Helpers for the filament inventory (the Filament screen; data in src/filament.js): the main colour of a filament,
// the compact list sent to the AI for Color remix, and resolving a folder location (used when importing the old
// Filament Inventory web page with tools/import_filament_inventory.js).
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

function resolveFolder(loc) {
  let p = String(loc || '').trim().replace(/^"|"$/g, '');
  if (!p) return null;
  if (/^file:/i.test(p)) { try { p = fileURLToPath(p.replace(/#.*$/, '').replace(/\?.*$/, '')); } catch { return null; } }
  try { if (fs.statSync(p).isFile()) p = path.dirname(p); } catch { return null; }
  return p;
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

module.exports = { resolveFolder, mainHex, forPrompt };
