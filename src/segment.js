// Splits the objects on a plate into numbered colour regions for AI repainting.
// Regions never cross the designer's parts or existing painted colours (those are kept as boundaries); larger
// areas are divided further by k-means on triangle position and facing direction, so a turtle's shell top,
// belly, flippers and head end up in different regions. Labels are kept per source mesh (shared by copies).
const { decode: decodePaint } = require('./paint');

const meshKey = (m) => `${m.sourcePath}#${m.sourceId}`;

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

function segment(items, { regions = 16, normalWeight = 0.35, seed = 7 } = {}) {
  // 1. world-space triangles, grouped by (object, part, existing colour)
  const groups = new Map();
  const meshes = [];
  const seen = new Set();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const it of items) {
    for (const m of it.meshes) {
      if (m.type === 'support' || m.type === 'other') continue;
      const part = (it.parts || []).find(p => String(p.id) === String(m.sourceId));
      if (part && part.subtype && part.subtype !== 'normal_part') continue;
      const key = meshKey(m);
      if (seen.has(key)) continue; // a copy of an object already handled
      seen.add(key);
      const V = m.mesh.vertices, T = m.mesh.triangles, M = m.transform, n = T.length / 3;
      const cen = new Float32Array(n * 3), nor = new Float32Array(n * 3), area = new Float32Array(n), gid = new Int32Array(n);
      const ext = (part && part.extruder) || it.extruder || 1;
      const paintCache = new Map();
      const w = (i) => [V[i] * M[0] + V[i + 1] * M[3] + V[i + 2] * M[6] + M[9], V[i] * M[1] + V[i + 1] * M[4] + V[i + 2] * M[7] + M[10], V[i] * M[2] + V[i + 1] * M[5] + V[i + 2] * M[8] + M[11]];
      for (let t = 0; t < n; t++) {
        const a = w(T[t * 3] * 3), b = w(T[t * 3 + 1] * 3), c = w(T[t * 3 + 2] * 3);
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const L = Math.hypot(nx, ny, nz) || 1;
        area[t] = L / 2; nor[t * 3] = nx / L; nor[t * 3 + 1] = ny / L; nor[t * 3 + 2] = nz / L;
        for (let k = 0; k < 3; k++) { const v = (a[k] + b[k] + c[k]) / 3; cen[t * 3 + k] = v; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
        let colour = ext;
        const code = m.mesh.paint && m.mesh.paint[t];
        if (code) { let s = paintCache.get(code); if (s === undefined) { s = dominantState(decodePaint(code)); paintCache.set(code, s); } if (s > 0) colour = s; }
        const gk = `${it.objectId}|${key}|${colour}`;
        let g = groups.get(gk);
        if (!g) { g = { key: gk, objectName: it.name, partName: part ? part.name : it.name, colour, members: [], area: 0 }; groups.set(gk, g); }
        g.members.push(meshes.length, t); g.area += area[t];
        gid[t] = -1;
      }
      meshes.push({ key, cen, nor, area, n, label: new Uint16Array(n) });
    }
  }
  if (!meshes.length) return null;
  const scale = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const total = [...groups.values()].reduce((s, g) => s + g.area, 0) || 1;

  // 2. regions per group, in proportion to area (at least one each)
  let rnd = seed;
  const rand = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd / 0x7fffffff; };
  const feat = (mi, t, out) => {
    const m = meshes[mi];
    out[0] = m.cen[t * 3] / scale; out[1] = m.cen[t * 3 + 1] / scale; out[2] = m.cen[t * 3 + 2] / scale;
    out[3] = m.nor[t * 3] * normalWeight; out[4] = m.nor[t * 3 + 1] * normalWeight; out[5] = m.nor[t * 3 + 2] * normalWeight;
  };
  const stats = [];
  const f = new Float64Array(6);
  for (const g of [...groups.values()].sort((a, b) => b.area - a.area)) {
    const cnt = g.members.length / 2;
    const k = Math.max(1, Math.min(cnt, Math.round(regions * g.area / total)));
    // sample for k-means
    const sampleN = Math.min(cnt, 20000), step = cnt / sampleN;
    const S = new Float64Array(sampleN * 6), SW = new Float64Array(sampleN);
    for (let i = 0; i < sampleN; i++) { const j = Math.floor(i * step); const mi = g.members[j * 2], t = g.members[j * 2 + 1]; feat(mi, t, f); S.set(f, i * 6); SW[i] = meshes[mi].area[t]; }
    // k-means++ init
    const C = new Float64Array(k * 6);
    C.set(S.subarray(0, 6), 0);
    const d2 = new Float64Array(sampleN).fill(Infinity);
    for (let c = 1; c < k; c++) {
      let sum = 0;
      for (let i = 0; i < sampleN; i++) { let d = 0; for (let q = 0; q < 6; q++) { const x = S[i * 6 + q] - C[(c - 1) * 6 + q]; d += x * x; } if (d < d2[i]) d2[i] = d; sum += d2[i] * SW[i]; }
      let r = rand() * sum, pick = 0;
      for (let i = 0; i < sampleN; i++) { r -= d2[i] * SW[i]; if (r <= 0) { pick = i; break; } }
      C.set(S.subarray(pick * 6, pick * 6 + 6), c * 6);
    }
    const near = (x, off = 0) => { let best = 0, bd = Infinity; for (let c = 0; c < k; c++) { let d = 0; for (let q = 0; q < 6; q++) { const y = x[off + q] - C[c * 6 + q]; d += y * y; } if (d < bd) { bd = d; best = c; } } return best; };
    for (let iter = 0; iter < 10 && k > 1; iter++) {
      const acc = new Float64Array(k * 6), wsum = new Float64Array(k);
      for (let i = 0; i < sampleN; i++) { const c = near(S, i * 6); for (let q = 0; q < 6; q++) acc[c * 6 + q] += S[i * 6 + q] * SW[i]; wsum[c] += SW[i]; }
      for (let c = 0; c < k; c++) if (wsum[c]) for (let q = 0; q < 6; q++) C[c * 6 + q] = acc[c * 6 + q] / wsum[c];
    }
    // assign every triangle; collect region stats
    const base = stats.length;
    for (let c = 0; c < k; c++) stats.push({ id: base + c + 1, group: g.key, objectName: g.objectName, partName: g.partName, originalFilament: g.colour, area: 0, c: [0, 0, 0], n: [0, 0, 0], zMin: Infinity, zMax: -Infinity });
    for (let j = 0; j < cnt; j++) {
      const mi = g.members[j * 2], t = g.members[j * 2 + 1], m = meshes[mi];
      feat(mi, t, f);
      const c = k > 1 ? near(f) : 0, st = stats[base + c], a = m.area[t];
      m.label[t] = base + c + 1;
      st.area += a;
      for (let q = 0; q < 3; q++) { st.c[q] += m.cen[t * 3 + q] * a; st.n[q] += m.nor[t * 3 + q] * a; }
      const z = m.cen[t * 3 + 2]; if (z < st.zMin) st.zMin = z; if (z > st.zMax) st.zMax = z;
    }
  }
  const regionsOut = stats.filter(s => s.area > 0).map(s => {
    const nl = Math.hypot(...s.n) || 1;
    const facing = s.n[2] / nl > 0.5 ? 'faces up' : s.n[2] / nl < -0.5 ? 'faces down' : 'faces sideways';
    return { id: s.id, objectName: s.objectName, partName: s.partName, originalFilament: s.originalFilament, areaCm2: +(s.area / 100).toFixed(1),
      centroid: s.c.map(v => +(v / s.area).toFixed(1)), zMin: +s.zMin.toFixed(1), zMax: +s.zMax.toFixed(1), facing };
  });
  const labels = new Map(meshes.map(m => [m.key, m.label]));
  return { regions: regionsOut, labels };
}

module.exports = { segment, meshKey };
