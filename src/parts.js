// Named parts for Color remix: the AI groups the model's patches (see patches.js) into the parts a painter would
// colour separately ("shell", "skin", "eyes", "base"), the user checks and corrects them, and the colour schemes
// are then designed per part. Eyes get pupils painted automatically. Confirmed parts are kept per model.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { callStructured } = require('./claude');
const { meshKey } = require('./patches');

const KINDS = ['eye', 'pupil', 'skin', 'body', 'shell', 'hair', 'mouth', 'nose', 'ear', 'limb', 'clothing', 'accessory', 'marking', 'base', 'text', 'other'];

// the meshes a plate prints, once each (copies of an object share a mesh), in world space
function eachMesh(items, fn) {
  const seen = new Set();
  for (const it of items) for (const m of it.meshes) {
    if (m.type === 'support' || m.type === 'other') continue;
    const part = (it.parts || []).find(p => String(p.id) === String(m.sourceId));
    if (part && part.subtype && part.subtype !== 'normal_part') continue;
    const key = meshKey(m); if (seen.has(key)) continue; seen.add(key);
    fn(m, key, it);
  }
}

// Same shape, same key: survives repainting, conversion for the printer and renaming the file.
function geomKey(items, plateIndex) {
  const h = crypto.createHash('sha1');
  eachMesh(items, (m, key) => {
    const V = m.mesh.vertices, T = m.mesh.triangles;
    h.update(`${T.length}|${V.length}|`);
    const step = Math.max(3, Math.floor(V.length / 600 / 3) * 3);
    for (let i = 0; i < V.length; i += step) h.update(V[i].toFixed(3) + ',');
  });
  h.update(`|plate${plateIndex}`);
  return h.digest('hex').slice(0, 24);
}

// world-space triangle geometry of one mesh: centroids, unit normals, areas, adjacency
function geometry(m) {
  const V = m.mesh.vertices, T = m.mesh.triangles, M = m.transform, nt = T.length / 3, nv = V.length / 3;
  const P = new Float64Array(V.length);
  for (let i = 0; i < V.length; i += 3) {
    P[i] = V[i] * M[0] + V[i + 1] * M[3] + V[i + 2] * M[6] + M[9];
    P[i + 1] = V[i] * M[1] + V[i + 1] * M[4] + V[i + 2] * M[7] + M[10];
    P[i + 2] = V[i] * M[2] + V[i + 1] * M[5] + V[i + 2] * M[8] + M[11];
  }
  const C = new Float64Array(nt * 3), N = new Float64Array(nt * 3), A = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, L = Math.hypot(nx, ny, nz) || 1e-12;
    A[t] = L / 2; N[t * 3] = nx / L; N[t * 3 + 1] = ny / L; N[t * 3 + 2] = nz / L;
    for (let k = 0; k < 3; k++) C[t * 3 + k] = (P[a + k] + P[b + k] + P[c + k]) / 3;
  }
  let adj = null;
  const adjacency = () => {
    if (adj) return adj;
    adj = new Int32Array(nt * 3).fill(-1);
    const map = new Map();
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
      const a = T[t * 3 + k], b = T[t * 3 + (k + 1) % 3], key = a < b ? a * nv + b : b * nv + a;
      const o = map.get(key);
      if (o === undefined) map.set(key, t * 3 + k); else { adj[t * 3 + k] = Math.floor(o / 3); adj[o] = t; map.delete(key); }
    }
    return adj;
  };
  return { nt, C, N, A, adjacency };
}

// ---------- AI: group patches into named parts ----------
function systemPrompt() {
  return `You identify the parts of a 3D-printable model so it can be painted in several filament colours. The model has been cut into numbered patches along its sculpted grooves and creases. You see it from several sides: one plain picture, and patch maps where every patch has its own colour and number. Each patch is also listed with its size, centre (x right, y back, z up, in mm), height range and the direction it faces.

Your job:
1. Say what the model depicts ("subject").
2. List the parts a careful human painter would give their own colour: for a turtle, e.g. "Shell", "Skin" (head, neck and flippers), "Eyes", "Belly plates", "Base"; for a figure, "Face and hands", "Hair", "Shirt", "Eyes"… Use the names a person would use. Keep it to what matters for colouring: usually 3–8 parts, never more than 12. Mirror pairs (left and right eye) are one part.
3. Put every patch in exactly one part. Look carefully at the numbers in every view; a patch that's hard to see goes with the part it sits in or next to.

Kinds: give each part one kind from the list. Use "eye" for eyeballs (the round eye surfaces; pupils are painted on automatically later) and "pupil" only if the sculpt already has separate pupil/iris patches. Use "base" for a stand, plinth, board or plaque the model sits on.
"realColor" is the part's natural colour in words (e.g. "olive green", "dark brown with tan edges", "white").`;
}

function schema() {
  return {
    type: 'object', additionalProperties: false, required: ['subject', 'parts', 'patches'],
    properties: {
      subject: { type: 'string' },
      parts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'name', 'kind', 'realColor'],
        properties: { id: { type: 'integer' }, name: { type: 'string' }, kind: { type: 'string', enum: KINDS }, realColor: { type: 'string' } } } },
      patches: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['patch', 'part'],
        properties: { patch: { type: 'integer' }, part: { type: 'integer' } } } },
    },
  };
}

function content({ images, patches, modelName, hint }) {
  const out = [];
  for (const im of images || []) {
    out.push({ type: 'text', text: im.label });
    out.push({ type: 'image', source: { type: 'base64', media_type: im.dataUrl.slice(5, im.dataUrl.indexOf(';')), data: im.dataUrl.split(',')[1] } });
  }
  out.push({ type: 'text', text: JSON.stringify({
    fileName: modelName, userSays: hint || undefined,
    patches: patches.map(p => ({ id: p.id, areaCm2: p.areaCm2, centre: p.centroid, z: [p.zMin, p.zMax], faces: p.normal })),
  }) });
  return out;
}

const PRICES = { 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20], 'claude-haiku-5-5': [0.1, 0.5] };
function estimateCost({ model, patches, images = 7 }) {
  const [pi, po] = PRICES[model] || PRICES['claude-sonnet-5-5'];
  const input = 700 + images * 1150 + patches * 45 + 200, output = 250 + patches * 14;
  const usd = (input * pi + output * po) / 1e6;
  return { input, output, usd, low: usd * 0.75, high: usd * 1.4 };
}

// The AI's grouping, made complete: every patch gets a part (skipped ones join the nearest grouped patch).
function tidyAnswer(answer, patches) {
  const parts = [];
  const idMap = new Map();
  for (const p of (answer && answer.parts) || []) {
    if (idMap.has(p.id)) continue;
    const id = parts.length + 1; idMap.set(p.id, id);
    parts.push({ id, name: String(p.name || `Part ${id}`).slice(0, 40), kind: KINDS.includes(p.kind) ? p.kind : 'other', realColor: p.realColor || '' });
  }
  if (!parts.length) parts.push({ id: 1, name: 'Body', kind: 'body', realColor: '' });
  const byPatch = new Map(patches.map(p => [p.id, p]));
  const patchPart = {};
  for (const a of (answer && answer.patches) || []) if (byPatch.has(a.patch) && idMap.has(a.part)) patchPart[a.patch] = idMap.get(a.part);
  const done = patches.filter(p => patchPart[p.id]);
  for (const p of patches) {
    if (patchPart[p.id]) continue;
    let best = parts[0].id, bd = Infinity;
    for (const q of done) { const d = Math.hypot(...[0, 1, 2].map(k => q.centroid[k] - p.centroid[k])); if (d < bd) { bd = d; best = patchPart[q.id]; } }
    patchPart[p.id] = best;
  }
  // parts that ended up with no patch are dropped (ids stay as they are; the window shows what has patches)
  return { subject: (answer && answer.subject) || '', parts, patchPart };
}

async function identify({ apiKey, model, images, patches, modelName, hint }) {
  const answer = await callStructured({ apiKey, model, system: systemPrompt(), content: content({ images, patches, modelName, hint }), schema: schema() });
  return tidyAnswer(answer, patches);
}

// ---------- pupils ----------
// Each separate eyeball (a connected piece of an "eye" part) gets a round pupil at the point that looks furthest
// out, along the eyeball's average facing direction. Returns how many pupils were added.
function addPupils(items, labels, parts, { size = 0.45 } = {}) {
  const eyeIds = new Set(parts.filter(p => p.kind === 'eye').map(p => p.id));
  if (!eyeIds.size) return 0;
  let pupil = parts.find(p => p.kind === 'pupil');
  let added = 0;
  eachMesh(items, (m, key) => {
    const lab = labels.get(key); if (!lab) return;
    const g = geometry(m), adj = g.adjacency();
    const seen = new Uint8Array(g.nt);
    for (let s = 0; s < g.nt; s++) {
      if (seen[s] || !eyeIds.has(lab[s])) continue;
      // one eyeball: flood through neighbouring triangles of the same part
      const comp = [s]; seen[s] = 1;
      for (let i = 0; i < comp.length; i++) { const t = comp[i]; for (let k = 0; k < 3; k++) { const u = adj[t * 3 + k]; if (u >= 0 && !seen[u] && lab[u] === lab[s]) { seen[u] = 1; comp.push(u); } } }
      let area = 0; const c = [0, 0, 0], n = [0, 0, 0];
      for (const t of comp) { const a = g.A[t]; area += a; for (let k = 0; k < 3; k++) { c[k] += g.C[t * 3 + k] * a; n[k] += g.N[t * 3 + k] * a; } }
      if (area < 1) continue; // under 1 mm²: a speck, not an eye
      const nl = Math.hypot(...n) || 1; for (let k = 0; k < 3; k++) { c[k] /= area; n[k] /= nl; }
      let apex = comp[0], best = -Infinity;
      for (const t of comp) { const d = (g.C[t * 3] - c[0]) * n[0] + (g.C[t * 3 + 1] - c[1]) * n[1] + (g.C[t * 3 + 2] - c[2]) * n[2]; if (d > best) { best = d; apex = t; } }
      // eyeball radius from its area (a dome of radius R has area 2πR², a flat disc πR²: use the dome, it's the usual sculpt)
      const flat = nl / area > 0.85; // nearly all facing one way: a flat or shallow eye
      const R = Math.sqrt(area / (flat ? Math.PI : 2 * Math.PI)), r = R * size, r2 = r * r;
      if (!pupil) { pupil = { id: Math.max(...parts.map(p => p.id)) + 1, name: 'Pupils', kind: 'pupil', realColor: 'black', auto: true }; parts.push(pupil); }
      const ax = g.C[apex * 3], ay = g.C[apex * 3 + 1], az = g.C[apex * 3 + 2];
      let marked = 0;
      for (const t of comp) { const dx = g.C[t * 3] - ax, dy = g.C[t * 3 + 1] - ay, dz = g.C[t * 3 + 2] - az; if (dx * dx + dy * dy + dz * dz <= r2) { lab[t] = pupil.id; marked++; } }
      if (!marked) lab[apex] = pupil.id;
      added++;
    }
  });
  return added;
}

// remove automatic pupils again (before re-adding them, e.g. when the user edits the eyes)
function clearAutoPupils(labels, parts) {
  const auto = parts.find(p => p.kind === 'pupil' && p.auto);
  if (!auto) return;
  const eye = parts.find(p => p.kind === 'eye');
  for (const lab of labels.values()) for (let t = 0; t < lab.length; t++) if (lab[t] === auto.id) lab[t] = eye ? eye.id : lab[t];
}

// ---------- part statistics (what the colour designer is told) ----------
function partStats(items, labels, parts) {
  const st = new Map(parts.map(p => [p.id, { area: 0, c: [0, 0, 0], n: [0, 0, 0], zMin: Infinity, zMax: -Infinity }]));
  eachMesh(items, (m, key) => {
    const lab = labels.get(key); if (!lab) return;
    const g = geometry(m);
    for (let t = 0; t < g.nt; t++) {
      const s = st.get(lab[t]); if (!s) continue;
      const a = g.A[t]; s.area += a;
      for (let k = 0; k < 3; k++) { s.c[k] += g.C[t * 3 + k] * a; s.n[k] += g.N[t * 3 + k] * a; }
      const z = g.C[t * 3 + 2]; if (z < s.zMin) s.zMin = z; if (z > s.zMax) s.zMax = z;
    }
  });
  return parts.map(p => {
    const s = st.get(p.id); if (!s || !s.area) return null;
    const nl = Math.hypot(...s.n) || 1, nz = s.n[2] / nl;
    return { id: p.id, name: p.name, kind: p.kind, realColor: p.realColor || '', partName: p.name, areaCm2: +(s.area / 100).toFixed(2),
      centroid: s.c.map(v => +(v / s.area).toFixed(1)), zMin: +s.zMin.toFixed(1), zMax: +s.zMax.toFixed(1),
      facing: nz > 0.5 ? 'faces up' : nz < -0.5 ? 'faces down' : 'faces sideways' };
  }).filter(Boolean);
}

// ---------- saved parts (per model shape) ----------
function rle(lab) { // [value, run, value, run…] as base64 of Uint32 pairs
  const out = [];
  for (let i = 0; i < lab.length;) { let j = i + 1; while (j < lab.length && lab[j] === lab[i]) j++; out.push(lab[i], j - i); i = j; }
  return Buffer.from(new Uint32Array(out).buffer).toString('base64');
}
function unrle(b64, n) {
  const buf = Buffer.from(b64, 'base64'), a = new Uint32Array(buf.buffer, buf.byteOffset, buf.length / 4), lab = new Uint16Array(n);
  let p = 0; for (let i = 0; i < a.length; i += 2) { lab.fill(a[i], p, p + a[i + 1]); p += a[i + 1]; }
  return lab;
}
const store = (dir, key) => path.join(dir, `${key}.json`);
function save(dir, key, { subject, parts, labels, pupils }) {
  fs.mkdirSync(dir, { recursive: true });
  const L = {}; for (const [k, lab] of labels) L[k] = { n: lab.length, d: rle(lab) };
  fs.writeFileSync(store(dir, key), JSON.stringify({ v: 1, saved: new Date().toISOString(), subject, parts, pupils, labels: L }));
}
function load(dir, key) {
  try {
    const j = JSON.parse(fs.readFileSync(store(dir, key), 'utf8'));
    const labels = new Map(Object.entries(j.labels).map(([k, v]) => [k, unrle(v.d, v.n)]));
    return { subject: j.subject || '', parts: j.parts || [], labels, pupils: j.pupils !== false, saved: j.saved };
  } catch { return null; }
}

module.exports = { KINDS, eachMesh, geomKey, identify, tidyAnswer, estimateCost, addPupils, clearAutoPupils, partStats, save, load, rle, unrle };
