// Models too heavy to slice in reasonable time: AI-generated meshes (Meshy, Tripo, image-to-3D…) whose colours were
// baked in from a texture typically come with 1–2 million triangles and thousands of tiny colour specks. The slicer
// must work out every speck on every layer and can run out of memory doing it. This finds such models and fixes
// them: specks merge into the colour around them, and the mesh is reduced (each colour area on its own with its
// borders locked, so colours keep their exact edges and the mesh stays closed).
const JSZip = require('jszip');
const { decode, encode } = require('./paint');
const { meshKey } = require('./patches');

const SPECK_MM2 = 4;            // colour areas smaller than this are specks (a 2 x 2 mm patch)
const HEAVY_TRIANGLES = 600000; // above this the slicer gets slow and memory-hungry
const MANY_SPECKS = 300;
const TARGET_TRIANGLES = 450000;
const MAX_ERROR_MM = 0.03;      // shape change allowed when reducing: far below what a 0.4 mm nozzle can show

function dominantState(tree) {
  if (!tree) return 0;
  const area = new Map();
  const walk = (t, a) => {
    if (!t.children) { area.set(t.state, (area.get(t.state) || 0) + a); return; }
    const share = t.sides === 1 ? [0.5, 0.5] : t.sides === 2 ? [0.25, 0.25, 0.5] : [0.25, 0.25, 0.25, 0.25];
    t.children.forEach((c, i) => walk(c, a * share[i]));
  };
  walk(tree, 1);
  let best = 0, bestA = -1;
  for (const [s, a] of area) if (a > bestA) { best = s; bestA = a; }
  return best;
}

// the meshes of these items, once each (copies share a mesh)
function uniqueMeshes(items) {
  const out = [], seen = new Set();
  for (const it of items) for (const m of it.meshes) {
    if (m.type === 'support' || m.type === 'other') continue;
    const key = meshKey(m); if (seen.has(key)) continue; seen.add(key);
    const part = (it.parts || []).find(p => String(p.id) === String(m.sourceId));
    if (part && part.subtype && part.subtype !== 'normal_part') continue;
    out.push({ m, key, item: it, extruder: (part && part.extruder) || it.extruder || 1 });
  }
  return out;
}

// triangle neighbours through shared edges (-1: open edge)
function adjacency(T, nv) {
  const nt = T.length / 3, adj = new Int32Array(nt * 3).fill(-1), map = new Map();
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const a = T[t * 3 + k], b = T[t * 3 + (k + 1) % 3], key = a < b ? a * nv + b : b * nv + a;
    const o = map.get(key);
    if (o === undefined) map.set(key, t * 3 + k); else { adj[t * 3 + k] = Math.floor(o / 3); adj[o] = t; map.delete(key); }
  }
  return adj;
}

function triAreas(V, T, M) {
  const nt = T.length / 3, A = new Float64Array(nt);
  const w = (i) => [V[i] * M[0] + V[i + 1] * M[3] + V[i + 2] * M[6], V[i] * M[1] + V[i + 1] * M[4] + V[i + 2] * M[7], V[i] * M[2] + V[i + 1] * M[5] + V[i + 2] * M[8]];
  for (let t = 0; t < nt; t++) {
    const a = w(T[t * 3] * 3), b = w(T[t * 3 + 1] * 3), c = w(T[t * 3 + 2] * 3);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    A[t] = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return A;
}

// colour (filament number) of each triangle: its painted colour (the main one when a triangle is split), else the part's
function triangleColours(m, extruder) {
  const nt = m.mesh.triangles.length / 3, lab = new Uint8Array(nt).fill(extruder);
  let split = 0;
  const P = m.mesh.paint;
  if (P) {
    const memo = new Map();
    for (let t = 0; t < nt; t++) {
      const code = P[t]; if (!code) continue;
      let s = memo.get(code);
      if (s === undefined) { const tree = decode(code); s = { state: dominantState(tree), split: !!tree.children }; memo.set(code, s); }
      if (s.state > 0) lab[t] = s.state;
      if (s.split) split++;
    }
  }
  return { lab, split };
}

// connected areas of one colour: id per triangle, area per id
function colourAreas(lab, adj, A) {
  const nt = lab.length, id = new Int32Array(nt).fill(-1), area = [];
  const stack = new Int32Array(nt);
  let n = 0;
  for (let s = 0; s < nt; s++) {
    if (id[s] >= 0) continue;
    let top = 0, a = 0; stack[top++] = s; id[s] = n;
    while (top) {
      const t = stack[--top]; a += A[t];
      for (let k = 0; k < 3; k++) { const u = adj[t * 3 + k]; if (u >= 0 && id[u] < 0 && lab[u] === lab[s]) { id[u] = n; stack[top++] = u; } }
    }
    area.push(a); n++;
  }
  return { id, area: Float64Array.from(area), count: n };
}

const scaleOf = (M) => Math.cbrt(Math.abs(M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]))) || 1;

// ---------- the check ----------
function analyze(items) {
  const out = { triangles: 0, specks: 0, areas: 0, painted: false, splitTriangles: 0, meshes: [], aiMade: false };
  for (const { m, key, item, extruder } of uniqueMeshes(items)) {
    const T = m.mesh.triangles, nt = T.length / 3;
    out.triangles += nt;
    const src = String((item.parts || []).map(p => p.sourceFile || '').join(' ') + ' ' + (item.sourceFile || ''));
    if (/\.(glb|gltf|obj|fbx)\b/i.test(src)) out.aiMade = true;
    let specks = 0, areas = 1;
    if (m.mesh.paint) {
      out.painted = true;
      const { lab, split } = triangleColours(m, extruder);
      const adj = adjacency(T, m.mesh.vertices.length / 3), A = triAreas(m.mesh.vertices, T, m.transform);
      const ca = colourAreas(lab, adj, A);
      for (let i = 0; i < ca.count; i++) if (ca.area[i] < SPECK_MM2) specks++;
      areas = ca.count; out.splitTriangles += split;
    }
    out.specks += specks; out.areas += areas;
    out.meshes.push({ key, triangles: nt, specks });
  }
  out.heavy = out.triangles > HEAVY_TRIANGLES || out.specks > MANY_SPECKS;
  out.reduceTo = out.triangles > HEAVY_TRIANGLES ? TARGET_TRIANGLES : out.triangles;
  return out;
}

// ---------- the fix ----------
// merge specks into the colour they sit in (the colour along most of their edge), a few passes for specks in specks
function mergeSpecks(lab, adj, A) {
  let merged = 0;
  for (let pass = 0; pass < 8; pass++) {
    const ca = colourAreas(lab, adj, A);
    const votes = new Map(); // area id -> Map(colour -> edges)
    for (let t = 0; t < lab.length; t++) {
      const a = ca.id[t]; if (ca.area[a] >= SPECK_MM2) continue;
      for (let k = 0; k < 3; k++) {
        const u = adj[t * 3 + k]; if (u < 0 || lab[u] === lab[t]) continue;
        let v = votes.get(a); if (!v) { v = new Map(); votes.set(a, v); }
        v.set(lab[u], (v.get(lab[u]) || 0) + 1);
      }
    }
    if (!votes.size) break;
    const to = new Map();
    for (const [a, v] of votes) to.set(a, [...v].sort((x, y) => y[1] - x[1])[0][0]);
    let n = 0;
    for (let t = 0; t < lab.length; t++) { const c = to.get(ca.id[t]); if (c !== undefined && c !== lab[t]) { lab[t] = c; n++; } }
    merged += to.size;
    if (!n) break;
  }
  return merged;
}

let simplifier = null;
async function getSimplifier() {
  if (!simplifier) { simplifier = require('meshoptimizer/meshopt_simplifier.js'); await simplifier.ready; }
  return simplifier;
}

// reduce one mesh, colour area by colour area with the borders between colours locked. A colour area whose reduced
// triangles don't join up cleanly (thin strips can fold onto a neighbour) keeps its original triangles.
async function reduce(V, T, lab, ratio, scale) {
  const S = await getSimplifier();
  const pos = Float32Array.from(V);
  const nv = V.length / 3;
  // split into connected colour areas, so each area can fall back on its own
  const adj = adjacency(T, nv), ca = colourAreas(lab, adj, new Float64Array(lab.length).fill(1));
  const members = Array.from({ length: ca.count }, () => []);
  for (let t = 0; t < lab.length; t++) members[ca.id[t]].push(t);
  const orig = members.map(ts => { const idx = new Uint32Array(ts.length * 3); ts.forEach((t, j) => { idx[j * 3] = T[t * 3]; idx[j * 3 + 1] = T[t * 3 + 1]; idx[j * 3 + 2] = T[t * 3 + 2]; }); return idx; });
  const zeros = new Float32Array(nv);
  const locks = orig.map(() => null);
  const run = (ai) => {
    const idx = orig[ai];
    if (idx.length < 60) return idx; // small areas: not worth it
    const target = Math.max(3, Math.floor(idx.length / 3 * ratio) * 3);
    if (!locks[ai]) return S.simplify(idx, pos, 3, Math.min(target, idx.length), MAX_ERROR_MM / scale, ['LockBorder', 'ErrorAbsolute'])[0];
    return S.simplifyWithAttributes(idx, pos, 3, zeros, 1, [0], locks[ai], Math.min(target, idx.length), MAX_ERROR_MM / scale, ['LockBorder', 'ErrorAbsolute'])[0];
  };
  S.useExperimentalFeatures = true;
  const result = orig.map((_, ai) => run(ai));
  // an edge used by more than two triangles (a thin strip folded onto a neighbour): lock the vertices around it and
  // reduce that area again; after a few tries the area keeps its original triangles
  for (let pass = 0; pass < 5; pass++) {
    const use = new Map();
    result.forEach((r, ai) => { for (let i = 0; i < r.length; i += 3) for (let k = 0; k < 3; k++) {
      const a = r[i + k], b = r[i + (k + 1) % 3], key = a < b ? a * nv + b : b * nv + a;
      const e = use.get(key); if (e) { e.n++; e.areas.add(ai); } else use.set(key, { n: 1, areas: new Set([ai]), a, b });
    } });
    const bad = new Map();
    for (const e of use.values()) if (e.n !== 2) for (const ai of e.areas) if (result[ai] !== orig[ai]) { if (!bad.has(ai)) bad.set(ai, []); bad.get(ai).push(e.a, e.b); }
    if (!bad.size) break;
    for (const [ai, vs] of bad) {
      if (pass === 4) { result[ai] = orig[ai]; continue; }
      const lock = locks[ai] || (locks[ai] = new Uint8Array(nv));
      const near = new Set(vs);
      // and their neighbours in the original area, a ring wider each pass
      for (let ring = 0; ring <= pass; ring++) {
        const add = [];
        const idx = orig[ai];
        for (let i = 0; i < idx.length; i += 3) if (near.has(idx[i]) || near.has(idx[i + 1]) || near.has(idx[i + 2])) add.push(idx[i], idx[i + 1], idx[i + 2]);
        for (const v of add) near.add(v);
      }
      for (const v of near) lock[v] = 1;
      result[ai] = run(ai);
    }
  }
  // join, drop unused vertices
  let total = 0; for (const r of result) total += r.length;
  const Tn = new Uint32Array(total), Ln = new Uint8Array(total / 3);
  let o = 0;
  result.forEach((r, ai) => { Tn.set(r, o); Ln.fill(lab[members[ai][0]], o / 3, (o + r.length) / 3); o += r.length; });
  const remap = new Int32Array(nv).fill(-1); let n2 = 0;
  for (let i = 0; i < Tn.length; i++) { if (remap[Tn[i]] < 0) remap[Tn[i]] = n2++; Tn[i] = remap[Tn[i]]; }
  const Vn = new Float64Array(n2 * 3);
  for (let v = 0; v < nv; v++) if (remap[v] >= 0) { Vn[remap[v] * 3] = V[v * 3]; Vn[remap[v] * 3 + 1] = V[v * 3 + 1]; Vn[remap[v] * 3 + 2] = V[v * 3 + 2]; }
  return { V: Vn, T: Tn, lab: Ln };
}

// every edge shared by exactly two triangles (closed and clean)?
function closedEdges(T, nv) {
  const map = new Map();
  for (let t = 0; t < T.length / 3; t++) for (let k = 0; k < 3; k++) {
    const a = T[t * 3 + k], b = T[t * 3 + (k + 1) % 3], key = a < b ? a * nv + b : b * nv + a;
    map.set(key, (map.get(key) || 0) + 1);
  }
  let open = 0, over = 0; for (const c of map.values()) { if (c === 1) open++; else if (c > 2) over++; }
  return { open, over };
}

// Fix the meshes of `items` inside the 3MF in `buffer`. Returns the new buffer and what was done.
async function fix(buffer, items, { reduceMesh = true, cleanColours = true } = {}) {
  const zip = await JSZip.loadAsync(buffer);
  const report = { trianglesBefore: 0, trianglesAfter: 0, specksMerged: 0, reduced: false, meshes: 0 };
  const list = uniqueMeshes(items);
  const total = list.reduce((t, x) => t + x.m.mesh.triangles.length / 3, 0);
  const ratio = reduceMesh && total > HEAVY_TRIANGLES ? TARGET_TRIANGLES / total : 1;
  const byFile = new Map();
  for (const x of list) {
    const { m, extruder } = x;
    const V = m.mesh.vertices, T = m.mesh.triangles, nv = V.length / 3;
    report.trianglesBefore += T.length / 3;
    const painted = !!m.mesh.paint;
    let lab = triangleColours(m, extruder).lab;
    const adj = adjacency(T, nv), A = triAreas(V, T, m.transform);
    if (painted && cleanColours) report.specksMerged += mergeSpecks(lab, adj, A);
    let mesh = { V, T, lab };
    if (ratio < 0.95) {
      const before = closedEdges(T, nv);
      const r = await reduce(V, T, lab, ratio, scaleOf(m.transform));
      const after = closedEdges(r.T, r.V.length / 3);
      if (process.env.HEAVY_DEBUG) console.log('reduce', T.length / 3, '->', r.T.length / 3, JSON.stringify(before), JSON.stringify(after));
      // keep the reduced mesh only if it is as closed and clean as the original
      if (after.open <= before.open && after.over <= before.over && r.T.length < T.length) { mesh = r; report.reduced = true; }
    }
    report.trianglesAfter += mesh.T.length / 3;
    report.meshes++;
    const i = x.key.lastIndexOf('#'); const file = x.key.slice(0, i).replace(/^\//, ''), id = x.key.slice(i + 1);
    if (!byFile.has(file)) byFile.set(file, new Map());
    byFile.get(file).set(id, { ...mesh, painted, extruder });
  }
  const codes = new Map(); const codeFor = (s) => { let c = codes.get(s); if (!c) { c = encode({ state: s }); codes.set(s, c); } return c; };
  const fmt = (v) => { const s = v.toFixed(5); return s.replace(/\.?0+$/, '') || '0'; };
  for (const [file, objs] of byFile) {
    const f = zip.file(file) || zip.file(decodeURIComponent(file));
    if (!f) continue;
    let xml = await f.async('string');
    xml = xml.replace(/(<object\b[^>]*\bid="([^"]+)"[^>]*>)([\s\S]*?)(<\/object>)/g, (m0, open, id, body, close) => {
      const g = objs.get(id);
      if (!g || !/<(?:\w+:)?triangles>/.test(body)) return m0;
      const vtag = (/<(\w+:)?vertex\b/.exec(body) || [])[1] || '', ttag = (/<(\w+:)?triangle\b/.exec(body) || [])[1] || '';
      const parts = [];
      for (let v = 0; v < g.V.length; v += 3) parts.push(`<${vtag}vertex x="${fmt(g.V[v])}" y="${fmt(g.V[v + 1])}" z="${fmt(g.V[v + 2])}"/>`);
      const verts = parts.join('\n     ');
      const tris = [];
      for (let t = 0; t < g.T.length / 3; t++) {
        const paint = g.painted && g.lab[t] !== g.extruder ? ` paint_color="${codeFor(g.lab[t])}"` : '';
        tris.push(`<${ttag}triangle v1="${g.T[t * 3]}" v2="${g.T[t * 3 + 1]}" v3="${g.T[t * 3 + 2]}"${paint}/>`);
      }
      body = body.replace(/<((?:\w+:)?vertices)>[\s\S]*?<\/\1>/, `<${vtag}vertices>\n     ${verts}\n    </${vtag}vertices>`)
        .replace(/<((?:\w+:)?triangles)>[\s\S]*?<\/\1>/, `<${ttag}triangles>\n     ${tris.join('\n     ')}\n    </${ttag}triangles>`);
      return open + body + close;
    });
    zip.file(f.name, xml);
  }
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { buffer: out, report };
}

module.exports = { analyze, fix, SPECK_MM2, HEAVY_TRIANGLES, TARGET_TRIANGLES };
