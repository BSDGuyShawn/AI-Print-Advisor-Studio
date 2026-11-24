// Before a print is sent: the sliced G-code drawn as a preview (toolpaths by feature, layer by layer), and checked for
// anything that would make the printer stop or print badly, the way Snapmaker Orca refuses to print such a plate.
//   toolpaths(text)            -> features, layers and line segments for the 3D preview
//   preflight(text, cfg, opts) -> problems: { severity: 'block' | 'warn', title, detail }
'use strict';

const { bedCheck } = require('./verify');

// Orca's feature names (;TYPE:) and the colours its preview uses (close enough to recognise)
const FEATURES = [
  ['Outer wall', '#FF8C26'], ['Inner wall', '#FFD966'], ['Overhang wall', '#2E7DDB'], ['Sparse infill', '#B03A2E'],
  ['Internal solid infill', '#9B3FD0'], ['Top surface', '#F04848'], ['Bottom surface', '#6E5ADB'], ['Bridge', '#3D7EAA'],
  ['Internal Bridge', '#5A93B8'], ['Gap infill', '#FFFFFF'], ['Skirt', '#00AA88'], ['Brim', '#00AA88'], ['Support', '#33CC33'],
  ['Support interface', '#22A022'], ['Support transition', '#7BD87B'], ['Prime tower', '#B0B0B0'], ['Ironing', '#FF6EB4'],
  ['Custom', '#888888'],
];
const COLOR = Object.fromEntries(FEATURES);

// Extrusion toolpaths as line segments, grouped by feature and ordered by layer, so the preview can show any set of
// features up to any layer. Long files are thinned evenly (every n-th point of each continuous path) to stay smooth.
function toolpaths(text, maxSegments = 700000) {
  const stop = (() => { const c = text.lastIndexOf('; CONFIG_BLOCK_START'); return c > 0 ? c : text.length; })();
  const paths = [];   // { type, layer, pts: [x,y,z,...] }
  const layers = [];
  let x = 0, y = 0, z = 0, type = 'Custom', relE = true, eAbs = 0, layer = -1, cur = null, pos = 0, total = 0;
  while (pos < stop) {
    let nl = text.indexOf('\n', pos); if (nl < 0) nl = text.length;
    const line = text.slice(pos, nl); pos = nl + 1;
    const c = line.charCodeAt(0);
    if (c === 59) {
      if (line.startsWith(';TYPE:')) { type = line.slice(6).trim(); cur = null; }
      else if (line.startsWith(';LAYER_CHANGE')) { layer++; cur = null; }
      else if (line.startsWith(';Z:')) { layers[Math.max(0, layer)] = +line.slice(3); }
      continue;
    }
    if (c === 77) { if (line.startsWith('M83')) relE = true; else if (line.startsWith('M82')) relE = false; continue; }
    if (c !== 71) continue;
    if (line.startsWith('G92')) { const m = /E(-?[\d.]+)/.exec(line); if (m) eAbs = +m[1]; continue; }
    if (!(line.startsWith('G1 ') || line.startsWith('G0 ') || line.startsWith('G2 ') || line.startsWith('G3 '))) continue;
    const semi = line.indexOf(';'); const cmd = semi >= 0 ? line.slice(0, semi) : line;
    let nx = x, ny = y, nz = z, de = 0, hasE = false;
    for (const part of cmd.split(' ')) {
      const k = part.charCodeAt(0), v = +part.slice(1);
      if (k === 88) nx = v; else if (k === 89) ny = v; else if (k === 90) nz = v;
      else if (k === 69) { hasE = true; if (relE) de = v; else { de = v - eAbs; eAbs = v; } }
    }
    if (layer >= 0 && hasE && de > 0 && (nx !== x || ny !== y)) {
      if (!cur || cur.z !== nz) { cur = { type, layer, z: nz, pts: [x, y, nz] }; paths.push(cur); }
      cur.pts.push(nx, ny, nz); total++;
    } else if (cur && (nx !== x || ny !== y || nz !== z)) cur = null;
    x = nx; y = ny; z = nz;
  }
  const step = Math.max(1, Math.ceil(total / maxSegments));
  const byType = new Map();
  for (const p of paths) {
    const t = byType.get(p.type) || { segs: [], layer: [] };
    const n = p.pts.length / 3;
    let i = 0;
    while (i < n - 1) {
      const j = Math.min(n - 1, i + step);
      t.segs.push(p.pts[i * 3], p.pts[i * 3 + 1], p.pts[i * 3 + 2], p.pts[j * 3], p.pts[j * 3 + 1], p.pts[j * 3 + 2]);
      t.layer.push(p.layer);
      i = j;
    }
    byType.set(p.type, t);
  }
  const features = [...byType.entries()].map(([name, t]) => {
    // segments are already in print order, so layers ascend: layerEnd[L] = segments in layers 0..L
    const ends = new Uint32Array(Math.max(1, layers.length));
    let k = 0;
    for (let L = 0; L < ends.length; L++) { while (k < t.layer.length && t.layer[k] <= L) k++; ends[L] = k; }
    return { name, color: COLOR[name] || '#999999', segments: Float32Array.from(t.segs), layerEnds: ends, count: t.layer.length };
  }).sort((a, b) => (FEATURES.findIndex(f => f[0] === a.name) + 100) % 100 - (FEATURES.findIndex(f => f[0] === b.name) + 100) % 100);
  return { features, layers: layers.map(v => +(+v || 0).toFixed(3)), thinned: step > 1, total };
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
const num = (v) => { const n = parseFloat(first(v)); return Number.isFinite(n) ? n : null; };

// Everything that would stop the printer or ruin the print, checked on the G-code that will be sent.
// opts: { warnings: the slicer's own warnings, usedSlots: toolheads used }
function preflight(text, cfg, opts = {}) {
  const out = [];
  const block = (title, detail) => out.push({ severity: 'block', title, detail });
  const warn = (title, detail) => out.push({ severity: 'warn', title, detail });
  if (!text || text.length < 1000) { block('The print file is empty or cut short', 'The slicer didn’t produce a complete G-code file.'); return out; }
  if (!cfg || !Object.keys(cfg).length) warn('The print file has no settings block', 'It may not come from Snapmaker Orca; the checks below are limited.');
  if (!/; EXECUTABLE_BLOCK_END/.test(text) && !/;\s*filament used/i.test(text.slice(-200000))) block('The print file looks cut short', 'Its end is missing, so the printer could stop part-way.');
  const bed = bedCheck(text, cfg);
  if (bed && !bed.ok) block('Goes outside the bed', `The ${String(bed.worst && bed.worst.type || 'print').toLowerCase()} reaches ${bed.worst ? `${bed.worst.axis} ${bed.worst.value} mm` : 'past the edge'}; the bed is X ${bed.rect.x0}–${bed.rect.x1}, Y ${bed.rect.y0}–${bed.rect.y1} mm. The printer would stop with “movement exceeded travel limit”.`);
  // height, layers, extrusion, numbers that make no sense
  const zs = [...text.matchAll(/^;Z:([-\d.]+)/gm)].map(m => +m[1]);
  const maxH = num(cfg && cfg.printable_height);
  if (!zs.length) block('No layers in the print', 'The slicer produced no layers: nothing would print.');
  else {
    const top = Math.max(...zs);
    if (maxH && top > maxH + 0.05) block('Too tall for the printer', `The print is ${top.toFixed(2)} mm tall; the printer can print ${maxH} mm.`);
    if (zs.some(v => v < 0)) block('A layer below the bed', 'The print has a layer below Z 0.');
    const lh = num(cfg && cfg.layer_height), noz = num(cfg && cfg.nozzle_diameter);
    for (let i = 1; i < zs.length; i++) {
      const d = zs[i] - zs[i - 1];
      if (noz && d > noz * 0.85 + 0.01) { block('A layer is too thick for the nozzle', `A ${d.toFixed(2)} mm step at Z ${zs[i].toFixed(2)} mm (nozzle ${noz} mm).`); break; }
      if (lh && d > 3 * lh + 0.5) { warn('A jump between layers', `${d.toFixed(2)} mm between Z ${zs[i - 1]} and ${zs[i]} mm.`); break; }
    }
  }
  if (!/^G[123] [^;\n]*E\d*\.?\d*[1-9]/m.test(text)) block('No extrusion in the print', 'Nothing in the file pushes filament: it would print nothing.');
  if (/^G[0-3] [^;\n]*(NaN|Infinity)/m.test(text)) block('Broken numbers in the print', 'Some moves have invalid coordinates (NaN).');
  // temperatures the printer is asked for
  const temps = [...text.matchAll(/^M10[49] (?:T(\d+) )?S(\d+)/gm)].map(m => ({ t: m[1] != null ? +m[1] : null, s: +m[2] }));
  const hot = Math.max(0, ...temps.map(t => t.s));
  if (hot > 300) block('Nozzle temperature too high', `The print asks for ${hot} °C; the U1’s hotend tops out at 300 °C.`);
  const ranges = (cfg && cfg.nozzle_temperature_range_high) || [];
  for (const s of opts.usedSlots || []) {
    const want = num(Array.isArray(cfg && cfg.nozzle_temperature) ? cfg.nozzle_temperature[s - 1] : cfg && cfg.nozzle_temperature);
    const hi = num(Array.isArray(ranges) ? ranges[s - 1] : ranges), lo = num(Array.isArray(cfg && cfg.nozzle_temperature_range_low) ? cfg.nozzle_temperature_range_low[s - 1] : cfg && cfg.nozzle_temperature_range_low);
    if (want != null && hi != null && want > hi + 0.5) warn(`T${s} hotter than its filament’s range`, `${want} °C; the filament’s range is ${lo ?? '?'}–${hi} °C.`);
    if (want != null && lo != null && want < lo - 0.5) warn(`T${s} cooler than its filament’s range`, `${want} °C; the filament’s range is ${lo}–${hi ?? '?'} °C.`);
  }
  const bedT = Math.max(0, ...[...text.matchAll(/^M1(?:40|90) S(\d+)/gm)].map(m => +m[1]));
  if (bedT > 120) block('Bed temperature too high', `The print asks for a ${bedT} °C bed.`);
  // what the slicer itself said while slicing (Orca shows these in its preview; some it treats as errors)
  for (const w of opts.warnings || []) {
    const t = String(w);
    // Orca refuses these; path conflicts and floating regions it only warns about
    if (/outside|beyond|exceed|out of (the )?(print|bed|plate)|collision|cannot|failed|error/i.test(t) && !/conflict|floating/i.test(t)) block('Snapmaker Orca reported a problem', t);
    else warn('Snapmaker Orca warning', t);
  }
  return out;
}

module.exports = { toolpaths, preflight, FEATURES };
