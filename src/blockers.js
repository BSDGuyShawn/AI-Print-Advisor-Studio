// Support blockers for hollow, open designs (Voronoi, lattice, cage-like models).
// Tree supports that start on the plate can thread up through the openings and grow inside the body to hold up
// its inner ceiling; they then can't be removed. This finds that inner hollow and builds a support blocker that
// fills it (plus the ceiling faces that look down into it), leaving every outside surface free to be supported.
//
// Method, on a voxel grid of the object:
//   shell     = voxels the model's surface passes through
//   closed    = the shell with openings bridged over (morphological closing, radius ~ the largest opening)
//   hollow    = space not reachable from outside once openings are closed, enclosed on four sides and above
//   leaky     = the hollow IS reachable from outside through the real openings (so supports can get in)
//   blocker   = hollow + shell voxels holding downward faces whose normal points into the hollow

const first = (v) => (Array.isArray(v) ? v[0] : v);

function invertAffine(T) {
  // row-vector 3MF affine: p' = p*M + t, M rows (T0..2),(T3..5),(T6..8), t = T9..11
  const [a, b, c, d, e, f, g, h, i] = T;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!det) return null;
  const inv = [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
  const tx = T[9], ty = T[10], tz = T[11];
  inv.push(-(tx * inv[0] + ty * inv[3] + tz * inv[6]), -(tx * inv[1] + ty * inv[4] + tz * inv[7]), -(tx * inv[2] + ty * inv[5] + tz * inv[8]));
  return inv;
}
const apply = (T, x, y, z) => [x * T[0] + y * T[3] + z * T[6] + T[9], x * T[1] + y * T[4] + z * T[7] + T[10], x * T[2] + y * T[5] + z * T[8] + T[11]];

// world-space triangles of an item's printable parts (no modifiers, blockers or enforcers)
function modelTriangles(item) {
  const out = [];
  for (const m of item.meshes) {
    if (m.type === 'support' || m.type === 'other') continue;
    const part = (item.parts || []).find(p => String(p.id) === String(m.sourceId));
    if (part && part.subtype && part.subtype !== 'normal_part') continue;
    const V = m.mesh.vertices, T = m.mesh.triangles, M = m.transform;
    const W = new Float32Array(V.length);
    for (let i = 0; i < V.length; i += 3) { const p = apply(M, V[i], V[i + 1], V[i + 2]); W[i] = p[0]; W[i + 1] = p[1]; W[i + 2] = p[2]; }
    out.push({ W, T });
  }
  return out;
}

function hasBlockers(item) { return (item.parts || []).some(p => p.subtype === 'support_blocker'); }

function analyze(item, opts = {}) {
  const tris = modelTriangles(item);
  if (!tris.length) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const { W } of tris) for (let i = 0; i < W.length; i += 3) for (let k = 0; k < 3; k++) { const v = W[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  if (!(span > 15)) return null; // too small to have a hollow worth blocking
  const vs = opts.voxel || Math.min(2.5, Math.max(0.8, span / 110));
  const openingRadius = opts.openingRadius || Math.min(9, Math.max(3, span / 14)); // bridges openings up to ~2x this wide
  const r = Math.max(2, Math.round(openingRadius / vs));
  const pad = r + 2;
  const nx = Math.ceil((hi[0] - lo[0]) / vs) + 2 * pad, ny = Math.ceil((hi[1] - lo[1]) / vs) + 2 * pad, nz = Math.ceil((hi[2] - lo[2]) / vs) + 2 * pad;
  if (nx * ny * nz > 12e6) return null;
  const N = nx * ny * nz, sxy = nx * ny;
  const ox = lo[0] - pad * vs, oy = lo[1] - pad * vs, oz = lo[2] - pad * vs;
  const idx = (x, y, z) => x + nx * (y + ny * z);
  const cell = (p, k) => Math.floor((p - [ox, oy, oz][k]) / vs);

  // 1. shell
  const shell = new Uint8Array(N);
  const downs = []; // downward faces: centroid + normal
  for (const { W, T } of tris) {
    for (let t = 0; t < T.length; t += 3) {
      const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
      const ax = W[a], ay = W[a + 1], az = W[a + 2], bx = W[b], by = W[b + 1], bz = W[b + 2], cx = W[c], cy = W[c + 1], cz = W[c + 2];
      const e = Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - ax, cy - ay, cz - az), Math.hypot(cx - bx, cy - by, cz - bz));
      const n = Math.max(1, Math.ceil(e / (vs * 0.5)));
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
        const u = i / n, w = j / n, s = 1 - u - w;
        const px = ax * s + bx * u + cx * w, py = ay * s + by * u + cy * w, pz = az * s + bz * u + cz * w;
        shell[idx(Math.floor((px - ox) / vs), Math.floor((py - oy) / vs), Math.floor((pz - oz) / vs))] = 1;
      }
      const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
      let Nx = uy * wz - uz * wy, Ny = uz * wx - ux * wz, Nz = ux * wy - uy * wx;
      const L = Math.hypot(Nx, Ny, Nz) || 1; Nx /= L; Ny /= L; Nz /= L;
      if (Nz < -0.5) downs.push((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3, Nx, Ny, Nz);
    }
  }

  // flood fill from the grid's border over cells where pass[i] is 1
  const flood = (pass) => {
    const seen = new Uint8Array(N), q = new Int32Array(N);
    let h = 0, t = 0;
    const push = (i) => { if (pass[i] && !seen[i]) { seen[i] = 1; q[t++] = i; } };
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) push(idx(x, y, z));
    while (h < t) {
      const i = q[h++], x = i % nx, y = ((i / nx) | 0) % ny, z = (i / sxy) | 0;
      if (x > 0) push(i - 1); if (x < nx - 1) push(i + 1);
      if (y > 0) push(i - nx); if (y < ny - 1) push(i + nx);
      if (z > 0) push(i - sxy); if (z < nz - 1) push(i + sxy);
    }
    return seen;
  };
  // box dilation by r along each axis (separable)
  const dilate = (src) => {
    let a = src;
    for (const [stride, len] of [[1, nx], [nx, ny], [sxy, nz]]) {
      const b = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        if (!a[i]) continue;
        const pos = ((i / stride) | 0) % len;
        for (let d = -r; d <= r; d++) { const p = pos + d; if (p >= 0 && p < len) b[i + d * stride] = 1; }
      }
      a = b;
    }
    return a;
  };

  // 2. reachable from outside through the real openings
  const notShell = new Uint8Array(N); for (let i = 0; i < N; i++) notShell[i] = shell[i] ? 0 : 1;
  const outsideRaw = flood(notShell);
  // 3. openings closed: outside of the dilated shell, grown back by r
  const D = dilate(shell);
  const notD = new Uint8Array(N); for (let i = 0; i < N; i++) notD[i] = D[i] ? 0 : 1;
  const outsideClosed = dilate(flood(notD));
  // 4. hollow: not outside (closed), not shell, enclosed by the closed solid on four sides and above
  const hollow = new Uint8Array(N);
  let cand = 0;
  for (let i = 0; i < N; i++) if (!outsideClosed[i] && !shell[i]) { hollow[i] = 1; cand++; }
  if (!cand) return { found: false, reason: 'no hollow' };
  const closedSolid = new Uint8Array(N); for (let i = 0; i < N; i++) closedSolid[i] = outsideClosed[i] ? 0 : 1;
  const hitsSolid = (i, stride, steps) => { for (let s = 1, j = i + stride; s < steps; s++, j += stride) if (shell[j]) return true; return false; };
  let hollowN = 0, leakyN = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = idx(x, y, z);
    if (!hollow[i]) continue;
    // walls on all four sides and a ceiling (checked against the shell, through the closed solid)
    const ok = hitsSolid(i, 1, nx - x) && hitsSolid(i, -1, x + 1) && hitsSolid(i, nx, ny - y) && hitsSolid(i, -nx, y + 1) && hitsSolid(i, sxy, nz - z);
    if (!ok) { hollow[i] = 0; continue; }
    hollowN++;
    // only the part supports can actually reach (through the openings); solid insides stay out of it
    if (outsideRaw[i]) leakyN++; else hollow[i] = 0;
  }
  void closedSolid;
  const cellCm3 = vs * vs * vs / 1000;
  const hollowCm3 = leakyN * cellCm3;              // the hollow supports could get into
  const leakyShare = hollowN ? leakyN / hollowN : 0;
  const found = hollowCm3 >= (opts.minCm3 || 3);

  // 5. blocker = the hollow, extended straight up by a few mm. The slicer removes an overhang where the blocker
  // lies above the empty space under it, so this covers the inner ceiling and walls leaning in over the hollow,
  // while a surface leaning outward sits over open air and is never covered.
  const up = Math.max(2, Math.round(1.5 / vs) + 1);
  const block = new Uint8Array(N);
  let ceilingFaces = 0;
  for (let i = 0; i < N; i++) if (hollow[i]) for (let k = 0; k <= up; k++) { const j = i + k * sxy; if (j < N) block[j] = 1; }
  // one cell sideways into the walls (never into open air), so inner overhangs at the hollow's edges are covered
  const side = opts.side ?? 1;
  for (let pass = 0; pass < side; pass++) {
    const add = [];
    for (let i = 0; i < N; i++) {
      if (block[i] || !shell[i]) continue;
      if (block[i - 1] || block[i + 1] || block[i - nx] || block[i + nx]) add.push(i);
    }
    for (const i of add) block[i] = 1;
  }
  for (let k = 0; k < downs.length; k += 6) {
    const tx = downs[k] + downs[k + 3] * vs, ty = downs[k + 1] + downs[k + 4] * vs, tz = downs[k + 2] + downs[k + 5] * vs;
    if (hollow[idx(Math.floor((tx - ox) / vs), Math.floor((ty - oy) / vs), Math.floor((tz - oz) / vs))]) ceilingFaces++;
  }
  void cell; void first;
  return { hollowMask: hollow, found, hollowCm3: +hollowCm3.toFixed(1), leakyShare: +leakyShare.toFixed(2), ceilingFaces, voxel: vs, grid: { nx, ny, nz, ox, oy, oz, vs }, block };
}

// Surface of the blocker cells as one closed mesh, in world coordinates.
function blockerMesh(a) {
  const { nx, ny, nz, ox, oy, oz, vs } = a.grid, B = a.block, sxy = nx * ny;
  const at = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz ? 0 : B[x + nx * (y + ny * z)]);
  const verts = [], vmap = new Map(), tris = [];
  const v = (x, y, z) => { const k = x + (nx + 1) * (y + (ny + 1) * z); let i = vmap.get(k); if (i === undefined) { i = verts.length / 3; vmap.set(k, i); verts.push(ox + x * vs, oy + y * vs, oz + z * vs); } return i; };
  const quad = (a1, b1, c1, d1) => { tris.push(a1, b1, c1, a1, c1, d1); };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (!B[x + nx * (y + ny * z)]) continue;
    // outward-facing quads (counter-clockwise seen from outside)
    if (!at(x - 1, y, z)) quad(v(x, y, z), v(x, y, z + 1), v(x, y + 1, z + 1), v(x, y + 1, z));
    if (!at(x + 1, y, z)) quad(v(x + 1, y, z), v(x + 1, y + 1, z), v(x + 1, y + 1, z + 1), v(x + 1, y, z + 1));
    if (!at(x, y - 1, z)) quad(v(x, y, z), v(x + 1, y, z), v(x + 1, y, z + 1), v(x, y, z + 1));
    if (!at(x, y + 1, z)) quad(v(x, y + 1, z), v(x, y + 1, z + 1), v(x + 1, y + 1, z + 1), v(x + 1, y + 1, z));
    if (!at(x, y, z - 1)) quad(v(x, y, z), v(x, y + 1, z), v(x + 1, y + 1, z), v(x + 1, y, z));
    if (!at(x, y, z + 1)) quad(v(x, y, z + 1), v(x + 1, y, z + 1), v(x + 1, y + 1, z + 1), v(x, y + 1, z + 1));
  }
  void sxy;
  return { vertices: verts, triangles: tris };
}

module.exports = { analyze, blockerMesh, hasBlockers, invertAffine, apply, modelTriangles };

// Add a support blocker part (mesh in world/plate coordinates) to an object of a Bambu/Orca-style 3MF, the way
// Snapmaker Orca stores one: a component of the object, plus a part with subtype "support_blocker".
async function addBlockerPart(buffer, item, mesh, name = 'Advisor support blocker (inside)') {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const rootName = '3D/3dmodel.model';
  let root = await zip.file(rootName).async('string');
  const objId = String(item.objectId);
  const objRe = new RegExp(`(<object\\b[^>]*\\bid="${objId}"[^>]*>)([\\s\\S]*?)(</object>)`);
  const om = objRe.exec(root);
  if (!om || !/<components>/.test(om[2])) throw new Error('This model’s layout doesn’t allow adding a blocker automatically.');
  // object-local coordinates: undo the build placement
  const inv = invertAffine(item.buildTransform || [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const V = mesh.vertices, T = mesh.triangles;
  const fmt = (x) => (Math.round(x * 1e4) / 1e4).toString();
  let vx = '';
  for (let i = 0; i < V.length; i += 3) { const p = apply(inv, V[i], V[i + 1], V[i + 2]); vx += `<vertex x="${fmt(p[0])}" y="${fmt(p[1])}" z="${fmt(p[2])}"/>`; }
  let tr = '';
  for (let i = 0; i < T.length; i += 3) tr += `<triangle v1="${T[i]}" v2="${T[i + 1]}" v3="${T[i + 2]}"/>`;
  const comps = [...om[2].matchAll(/<component\b([^>]*)\/>/g)].map(m => m[1]);
  const usesPath = comps.some(c => /p:path="/.test(c));
  const ids = [...root.matchAll(/<object\b[^>]*\bid="(\d+)"/g)].map(m => +m[1]);
  const compIds = comps.map(c => +((/objectid="(\d+)"/.exec(c) || [])[1] || 0));
  let newId, compXml;
  if (usesPath) {
    // its own file, linked from the root model like the other parts
    newId = Math.max(0, ...compIds) + 1;
    const file = `3D/Objects/advisor_blocker_${objId}.model`;
    zip.file(file, `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">\n <resources>\n  <object id="${newId}" type="model"><mesh><vertices>${vx}</vertices><triangles>${tr}</triangles></mesh></object>\n </resources>\n <build/>\n</model>\n`);
    compXml = `<component p:path="/${file}" objectid="${newId}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`;
    const relName = '3D/_rels/3dmodel.model.rels';
    let rels = zip.file(relName) ? await zip.file(relName).async('string') : '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n</Relationships>';
    if (!rels.includes(`/${file}`)) rels = rels.replace('</Relationships>', ` <Relationship Target="/${file}" Id="rel-advisor-${objId}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>`);
    zip.file(relName, rels);
  } else {
    // inline: a mesh object in the root model, placed before the object that uses it
    newId = Math.max(0, ...ids) + 1;
    root = root.replace(om[0], `<object id="${newId}" type="model"><mesh><vertices>${vx}</vertices><triangles>${tr}</triangles></mesh></object>\n  ${om[0]}`);
    compXml = `<component objectid="${newId}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`;
  }
  root = root.replace(objRe, (m0, a, body, c) => `${a}${body.replace('</components>', `  ${compXml}\n   </components>`)}${c}`);
  zip.file(rootName, root);
  // the part's settings: a support blocker
  const msName = 'Metadata/model_settings.config';
  let ms = zip.file(msName) ? await zip.file(msName).async('string') : '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n</config>';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const partXml = `    <part id="${newId}" subtype="support_blocker">\n      <metadata key="name" value="${esc(name)}"/>\n      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n      <metadata key="extruder" value="0"/>\n    </part>\n`;
  const msObj = new RegExp(`(<object id="${objId}">[\\s\\S]*?)(\\s*</object>)`);
  if (msObj.test(ms)) ms = ms.replace(msObj, (m0, a, c) => `${a}\n${partXml.trimEnd()}${c}`);
  else ms = ms.replace('</config>', `  <object id="${objId}">\n${partXml}  </object>\n</config>`);
  zip.file(msName, ms);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports.addBlockerPart = addBlockerPart;
