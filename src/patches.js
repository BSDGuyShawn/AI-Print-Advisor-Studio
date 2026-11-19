// Splits a model into patches that follow its real features: the grooves and creases a sculptor or designer
// cut (between shell plates, around eyes, along a mouth, where a body meets its base). These become the
// building blocks that the AI groups into named parts ("shell", "skin", "eyes") and the user confirms.
//
// Method per mesh: vertices in a groove sit below their neighbours (concave), so a vertex whose neighbours'
// average lies clearly above it along its normal is marked as a boundary. Triangles are flood-filled into
// patches without crossing boundary edges; the many tiny pieces (texture bumps, scale outlines) are then merged
// into the neighbour they share the most edge with, until the requested number of patches remains.
const { decode: decodePaint } = require('./paint');

const meshKey = (m) => `${m.sourcePath}#${m.sourceId}`;

function percentile(arr, p) {
  const a = Float64Array.from(arr).sort();
  return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0;
}

function meshPatches(V, T, M, opts = {}) {
  const boundaryPercentile = opts.boundaryPercentile ?? 0.86;
  const nv = V.length / 3, nt = T.length / 3;
  // world positions
  const P = new Float64Array(V.length);
  for (let i = 0; i < V.length; i += 3) {
    P[i] = V[i] * M[0] + V[i + 1] * M[3] + V[i + 2] * M[6] + M[9];
    P[i + 1] = V[i] * M[1] + V[i + 1] * M[4] + V[i + 2] * M[7] + M[10];
    P[i + 2] = V[i] * M[2] + V[i + 1] * M[5] + V[i + 2] * M[8] + M[11];
  }
  // face normals, areas, centroids; area-weighted vertex normals
  const FN = new Float64Array(nt * 3), A = new Float64Array(nt), C = new Float64Array(nt * 3), VN = new Float64Array(nv * 3);
  for (let t = 0; t < nt; t++) {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, L = Math.hypot(nx, ny, nz) || 1e-12;
    A[t] = L / 2; FN[t * 3] = nx / L; FN[t * 3 + 1] = ny / L; FN[t * 3 + 2] = nz / L;
    for (let k = 0; k < 3; k++) C[t * 3 + k] = (P[a + k] + P[b + k] + P[c + k]) / 3;
    for (const v of [a, b, c]) { VN[v] += nx; VN[v + 1] += ny; VN[v + 2] += nz; }
  }
  // vertex neighbours (CSR)
  const deg = new Int32Array(nv + 1);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) deg[T[t * 3 + k] + 1] += 2;
  for (let i = 0; i < nv; i++) deg[i + 1] += deg[i];
  const nb = new Int32Array(deg[nv]), fill = deg.slice(0, nv);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) { const v = T[t * 3 + k]; nb[fill[v]++] = T[t * 3 + (k + 1) % 3]; nb[fill[v]++] = T[t * 3 + (k + 2) % 3]; }
  // concavity: how far the neighbours' average sits above the vertex, relative to edge length
  const conc = new Float64Array(nv);
  for (let v = 0; v < nv; v++) {
    const s = deg[v], e = deg[v + 1]; if (e <= s) continue;
    let mx = 0, my = 0, mz = 0, el = 0;
    for (let j = s; j < e; j++) { const u = nb[j] * 3; mx += P[u]; my += P[u + 1]; mz += P[u + 2]; el += Math.hypot(P[u] - P[v * 3], P[u + 1] - P[v * 3 + 1], P[u + 2] - P[v * 3 + 2]); }
    const n = e - s; mx /= n; my /= n; mz /= n; el /= n;
    const L = Math.hypot(VN[v * 3], VN[v * 3 + 1], VN[v * 3 + 2]) || 1;
    conc[v] = ((mx - P[v * 3]) * VN[v * 3] + (my - P[v * 3 + 1]) * VN[v * 3 + 1] + (mz - P[v * 3 + 2]) * VN[v * 3 + 2]) / L / (el || 1);
  }
  // smooth over neighbours so grooves become continuous valleys and texture noise fades
  let cs = conc;
  for (let pass = 0; pass < (opts.smooth ?? 3); pass++) {
    const nx = new Float64Array(nv);
    for (let v = 0; v < nv; v++) { const s = deg[v], e = deg[v + 1]; let acc = cs[v] * 2, w = 2; for (let j = s; j < e; j++) { acc += cs[nb[j]]; w++; } nx[v] = acc / w; }
    cs = nx;
  }
  // triangle adjacency through shared edges, and each edge's groove strength
  const edgeMap = new Map(), adj = new Int32Array(nt * 3).fill(-1), eg = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const a = T[t * 3 + k], b = T[t * 3 + (k + 1) % 3], key = a < b ? a * nv + b : b * nv + a;
    const o = edgeMap.get(key);
    if (o === undefined) edgeMap.set(key, t * 3 + k);
    else { adj[t * 3 + k] = Math.floor(o / 3); adj[o] = t; const g = (cs[a] + cs[b]) / 2; eg[t * 3 + k] = g; eg[o] = g; edgeMap.delete(key); }
  }
  // watershed: flood the surface from its most convex places (bump tops) in order of rising groove strength;
  // where two floods meet is a groove. This over-segments (every scale is a basin); merging comes later.
  const g = new Float32Array(nt);
  for (let t = 0; t < nt; t++) g[t] = (cs[T[t * 3]] + cs[T[t * 3 + 1]] + cs[T[t * 3 + 2]]) / 3;
  const order = new Uint32Array(nt); for (let t = 0; t < nt; t++) order[t] = t;
  order.sort((x, y) => g[x] - g[y]);
  const label = new Int32Array(nt).fill(-1);
  let n = 0;
  for (let i = 0; i < nt; i++) {
    const t = order[i];
    // join the neighbour basin reached through the weakest edge
    let best = -1, bg = Infinity;
    for (let k = 0; k < 3; k++) { const u = adj[t * 3 + k]; if (u >= 0 && label[u] >= 0 && eg[t * 3 + k] < bg) { bg = eg[t * 3 + k]; best = label[u]; } }
    label[t] = best >= 0 ? best : n++;
  }
  const pos = []; for (let v = 0; v < nv; v += 7) if (cs[v] > 0) pos.push(cs[v]);
  const scale = Math.max(percentile(pos, 0.5), 1e-9);
  if (process.env.PATCH_DEBUG) console.log('debug: basins', n, 'groove scale', scale.toExponential(2));
  return { label, count: n, adj, eg, scale, A, FN, C, nt };
}

// Merge basins into patches, weakest border first: two neighbours whose shared border is barely a groove join
// early, deep grooves (shell against skin, round an eye, body against base) stay borders until last. Small
// pieces count as weaker so specks don't survive. Stops when `target` patches remain.
function mergePatches(meshes, target, opts = {}) {
  let total = 0; for (const m of meshes) { m.offset = total; total += m.res.count; }
  const area = new Float64Array(total), parent = new Int32Array(total); for (let i = 0; i < total; i++) parent[i] = i;
  const nbr = Array.from({ length: total }, () => new Map()); // neighbour -> [sum of groove strength, edges]
  let totalArea = 0, sc = 0;
  for (const m of meshes) {
    const { label, adj, eg, A, nt, scale } = m.res; sc = Math.max(sc, scale);
    for (let t = 0; t < nt; t++) {
      const p = m.offset + label[t]; area[p] += A[t]; totalArea += A[t];
      for (let k = 0; k < 3; k++) {
        const u = adj[t * 3 + k]; if (u < 0) continue; const q = m.offset + label[u]; if (q === p) continue;
        let e = nbr[p].get(q); if (!e) { e = [0, 0]; nbr[p].set(q, e); } e[0] += eg[t * 3 + k]; e[1]++;
      }
    }
  }
  const ref = totalArea / Math.max(target, 1), sizeW = opts.sizeWeight ?? 1;
  const cost = (a, b, e) => {
    const strength = Math.max(e[0] / e[1], 0) / sc + 0.02;            // mean groove depth along the border
    const small = Math.min(area[a], area[b]) / ref;                    // pieces much smaller than a patch merge first
    return strength * Math.pow(Math.min(small, 4), 0.5 * sizeW) / Math.pow(e[1], 0.15);
  };
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const ver = new Int32Array(total);
  const heap = [];
  const push = (c, a, b) => { heap.push([c, a, b, ver[a], ver[b]]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < heap.length && heap[l][0] < heap[s][0]) s = l; if (r < heap.length && heap[r][0] < heap[s][0]) s = r; if (s === i) break; [heap[s], heap[i]] = [heap[i], heap[s]]; i = s; } } return top; };
  for (let a = 0; a < total; a++) for (const [b, e] of nbr[a]) if (a < b) push(cost(a, b, e), a, b);
  let alive = total;
  while (alive > target && heap.length) {
    const [, a, b, va, vb] = pop();
    if (parent[a] !== a || parent[b] !== b || va !== ver[a] || vb !== ver[b]) continue; // stale
    // merge the smaller neighbour list into the larger
    let keep = a, drop = b; if (nbr[a].size < nbr[b].size) { keep = b; drop = a; }
    parent[drop] = keep; area[keep] += area[drop]; alive--;
    nbr[keep].delete(drop);
    for (const [q, e] of nbr[drop]) {
      if (q === keep) continue;
      let k = nbr[keep].get(q); if (!k) { k = [0, 0]; nbr[keep].set(q, k); } k[0] += e[0]; k[1] += e[1];
      const qm = nbr[q]; qm.delete(drop); qm.set(keep, k);
    }
    nbr[drop] = new Map();
    ver[keep]++;
    for (const [q, e] of nbr[keep]) push(cost(keep, q, e), keep, q);
  }
  const roots = [...new Set([...Array(total).keys()].map(find))].sort((x, y) => area[y] - area[x]);
  const idOf = new Map(roots.map((r, i) => [r, i + 1]));
  return { idOfPatch: (gid) => idOf.get(find(gid)), count: roots.length };
}

// items: the objects on a plate. Returns { regions: patch stats, labels: Map(meshKey -> Uint16Array) }
function findPatches(items, opts = {}) {
  const target = opts.target ?? 50;
  const meshes = [], seen = new Set();
  for (const it of items) {
    for (const m of it.meshes) {
      if (m.type === 'support' || m.type === 'other') continue;
      const part = (it.parts || []).find(p => String(p.id) === String(m.sourceId));
      if (part && part.subtype && part.subtype !== 'normal_part') continue;
      const key = meshKey(m); if (seen.has(key)) continue; seen.add(key);
      const res = meshPatches(m.mesh.vertices, m.mesh.triangles, m.transform, opts);
      // existing colours (parts, painting) stay boundaries: split patches by them
      const ext = (part && part.extruder) || it.extruder || 1;
      if (m.mesh.paint) {
        const cache = new Map(); const remap = new Map(); let n = 0;
        for (let t = 0; t < res.nt; t++) {
          const code = m.mesh.paint[t]; let s = ext;
          if (code) { let st = cache.get(code); if (st === undefined) { const tr = decodePaint(code); st = tr && !tr.children ? tr.state : 0; cache.set(code, st); } if (st > 0) s = st; }
          const k = res.label[t] * 64 + s; let id = remap.get(k); if (id === undefined) { id = n++; remap.set(k, id); } res.label[t] = id;
        }
        res.count = n;
      }
      meshes.push({ key, res, objectName: it.name, partName: part ? part.name : it.name });
    }
  }
  if (!meshes.length) return null;
  const merged = mergePatches(meshes, target, opts);
  const labels = new Map(), stats = new Map();
  for (const m of meshes) {
    const { label, A, FN, C, nt } = m.res, out = new Uint16Array(nt);
    for (let t = 0; t < nt; t++) {
      const id = merged.idOfPatch(m.offset + label[t]); out[t] = id;
      let s = stats.get(id); if (!s) { s = { id, area: 0, c: [0, 0, 0], n: [0, 0, 0], zMin: Infinity, zMax: -Infinity, objectName: m.objectName, partName: m.partName }; stats.set(id, s); }
      const a = A[t]; s.area += a;
      for (let k = 0; k < 3; k++) { s.c[k] += C[t * 3 + k] * a; s.n[k] += FN[t * 3 + k] * a; }
      const z = C[t * 3 + 2]; if (z < s.zMin) s.zMin = z; if (z > s.zMax) s.zMax = z;
    }
    labels.set(m.key, out);
  }
  const regions = [...stats.values()].sort((a, b) => a.id - b.id).map(s => {
    const nl = Math.hypot(...s.n) || 1, nz = s.n[2] / nl;
    return { id: s.id, objectName: s.objectName, partName: s.partName, areaCm2: +(s.area / 100).toFixed(2), centroid: s.c.map(v => +(v / s.area).toFixed(1)),
      normal: s.n.map(v => +(v / nl).toFixed(2)), zMin: +s.zMin.toFixed(1), zMax: +s.zMax.toFixed(1), facing: nz > 0.5 ? 'faces up' : nz < -0.5 ? 'faces down' : 'faces sideways' };
  });
  return { regions, labels };
}

module.exports = { findPatches, meshKey };
