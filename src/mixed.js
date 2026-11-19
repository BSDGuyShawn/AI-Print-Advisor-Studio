// Snapmaker Orca's mixed filaments ("Full Spectrum"): a new color made by printing thin alternating layers of 2–4
// real filaments. The recipe lives in project_settings.config → mixed_filament_definitions: rows joined by ';'.
//   pair  : A,B,enabled,custom,B%,pointillism,g,w,m2,…,d0,o0,u<id>[,pattern…]   → A (100−B)% + B B%
//   list  : 1,2,1,1,50,0,g<ids>,w<p1/p2/…>,m0,…,d0,o0,u<id>                       → each id at its weight
// A row with d1 is deleted. The live rows become filament numbers after the real ones, in row order: with 4 real
// filaments the first live mix is filament 5, the next 6 (Snapmaker Orca's mixed_index_from_filament_id).
// Painted areas and objects use those numbers like any filament, but only the real ones are loaded in the printer.

function parseRow(row, nPhys) {
  const f = String(row).split(',').map(s => s.trim());
  if (f.length < 5 || f.includes('d1')) return null;
  const tok = (re) => f.find(x => re.test(x));
  const uIdx = f.findIndex(x => /^u\d+$/.test(x));
  const pattern = uIdx >= 0 ? f.slice(uIdx + 1).filter(x => /^\d+$/.test(x)).map(Number) : [];
  const clamp = (n) => (n >= 1 && (!nPhys || n <= nPhys) ? n : null);
  let parts = [];
  if (pattern.length) {
    // a repeating layer sequence (3–4 filaments): each filament's share of the sequence
    const count = new Map();
    for (const n of pattern) if (clamp(n)) count.set(n, (count.get(n) || 0) + 1);
    parts = [...count].map(([slot, c]) => ({ slot, pct: (100 * c) / pattern.length }));
  } else {
    const g = tok(/^g\d+$/), w = tok(/^w[\d/]+$/), m = tok(/^m\d+$/);
    if (g && m !== 'm2') {
      const ids = g.slice(1).split('').map(Number);
      const ws = w && w.includes('/') ? w.slice(1).split('/').map(Number) : ids.map(() => 100 / ids.length);
      parts = ids.map((slot, i) => ({ slot: clamp(slot), pct: ws[i] || 0 })).filter(p => p.slot && p.pct > 0);
    } else {
      const a = clamp(+f[0]), b = clamp(+f[1]), pb = Math.max(0, Math.min(100, +f[4] || 0));
      if (a && b) parts = a === b ? [{ slot: a, pct: 100 }] : [{ slot: a, pct: 100 - pb }, { slot: b, pct: pb }].filter(p => p.pct > 0);
    }
  }
  const total = parts.reduce((s, p) => s + p.pct, 0);
  if (!parts.length || !total) return null;
  return parts.map(p => ({ slot: p.slot, pct: Math.round((1000 * p.pct) / total) / 10 }));
}

// [{ id, parts: [{ slot, pct }], label }] for the file's live mixes; [] when there are none
function parseMixes(ps) {
  if (!ps) return [];
  const raw = ps.mixed_filament_definitions;
  const nPhys = Array.isArray(ps.filament_colour) ? ps.filament_colour.length : Array.isArray(ps.filament_settings_id) ? ps.filament_settings_id.length : 0;
  if (!raw || typeof raw !== 'string' || !nPhys) return [];
  const out = [];
  for (const row of raw.split(';')) {
    if (!row.trim()) continue;
    const parts = parseRow(row, nPhys);
    if (!parts) { if (!String(row).split(',').includes('d1')) out.push(null); continue; } // unreadable live row: keep the numbering
    out.push(parts);
  }
  return out.map((parts, i) => parts && ({ id: nPhys + 1 + i, parts, label: parts.map(p => `T${p.slot} ${Math.round(p.pct)}%`).join(' + ') })).filter(Boolean);
}

// the real filaments behind a filament number (itself when it's a real one)
function expand(n, mixes) {
  const m = mixes && mixes.length ? mixes.find(x => x.id === n) : null;
  return m ? m.parts.map(p => p.slot) : [n];
}

// the blended color the slicer shows for a mix (sRGB-weighted average, which matches Snapmaker Orca's swatches)
function blendHex(parts, colorOf) {
  const rgb = [0, 0, 0];
  for (const p of parts) {
    const m = /^#?([0-9a-f]{6})/i.exec(String(colorOf(p.slot) || '#888888')) || [0, '888888'];
    const v = parseInt(m[1], 16);
    rgb[0] += ((v >> 16) & 255) * p.pct / 100; rgb[1] += ((v >> 8) & 255) * p.pct / 100; rgb[2] += (v & 255) * p.pct / 100;
  }
  return '#' + rgb.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

module.exports = { parseMixes, expand, blendHex };
