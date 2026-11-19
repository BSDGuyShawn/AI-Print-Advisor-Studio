// Scores candidate orientations for one object (Tweaker-style): which face goes down, and what that does
// to overhang area, bed contact and height. Works on world-space triangles (9 floats each).

const COS45 = Math.SQRT1_2, COS30 = Math.cos(Math.PI / 6);
const { getMachine } = require('./machine');

function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// Rotation (row-vector convention, 9 numbers row-major, p' = p·R) that turns direction d into -Z.
function rotationTo(d) {
  const a = norm(d), b = [0, 0, -1];
  const c = dot(a, b);
  let Rc;
  if (c > 0.999999) Rc = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  else if (c < -0.999999) Rc = [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
  else {
    const v = cross(a, b), k = 1 / (1 + c);
    const vx = [[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]];
    const vx2 = [0, 1, 2].map(i => [0, 1, 2].map(j => vx[i][0] * vx[0][j] + vx[i][1] * vx[1][j] + vx[i][2] * vx[2][j]));
    Rc = [0, 1, 2].map(i => [0, 1, 2].map(j => (i === j ? 1 : 0) + vx[i][j] + vx2[i][j] * k));
  }
  // row-vector matrix is the transpose of the column-vector one
  return [Rc[0][0], Rc[1][0], Rc[2][0], Rc[0][1], Rc[1][1], Rc[2][1], Rc[0][2], Rc[1][2], Rc[2][2]];
}

// Named by what happens to the model, not by the file's axes: a model saved lying down that gets turned onto its
// end is "stood upright", not "on its side". h / h0: height in this orientation / as placed in the file.
function describe(d, h, h0) {
  const turned = h0 && h > h0 * 1.3 ? 'Stood upright' : h0 && h < h0 * 0.77 ? 'Laid down' : 'Turned onto a side';
  const ax = [[0, 0, -1, 'Current orientation'], [0, 0, 1, 'Upside down'], [1, 0, 0, `${turned} (+X face down)`], [-1, 0, 0, `${turned} (−X face down)`], [0, 1, 0, `${turned} (+Y face down)`], [0, -1, 0, `${turned} (−Y face down)`]];
  for (const [x, y, z, label] of ax) if (dot(d, [x, y, z]) > 0.996) return label;
  const tilt = Math.round(Math.acos(Math.max(-1, Math.min(1, -d[2]))) * 180 / Math.PI);
  return `Tilted ${tilt}° onto a flat face`;
}

function evaluate(tris, d) {
  const up = [-d[0], -d[1], -d[2]];
  const u = norm(Math.abs(d[2]) < 0.9 ? cross(d, [0, 0, 1]) : cross(d, [1, 0, 0]));
  const w = cross(d, u);
  let minH = Infinity, maxH = -Infinity, minU = Infinity, maxU = -Infinity, minW = Infinity, maxW = -Infinity;
  for (const a of tris) for (let i = 0; i < a.length; i += 3) {
    const h = a[i] * up[0] + a[i + 1] * up[1] + a[i + 2] * up[2];
    const pu = a[i] * u[0] + a[i + 1] * u[1] + a[i + 2] * u[2];
    const pw = a[i] * w[0] + a[i + 1] * w[1] + a[i + 2] * w[2];
    if (h < minH) minH = h; if (h > maxH) maxH = h;
    if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
    if (pw < minW) minW = pw; if (pw > maxW) maxW = pw;
  }
  let ov45 = 0, ov30 = 0, contact = 0;
  for (const a of tris) for (let i = 0; i < a.length; i += 9) {
    const ux = a[i + 3] - a[i], uy = a[i + 4] - a[i + 1], uz = a[i + 5] - a[i + 2];
    const vx = a[i + 6] - a[i], vy = a[i + 7] - a[i + 1], vz = a[i + 8] - a[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!len) continue;
    const down = (nx * d[0] + ny * d[1] + nz * d[2]) / len;
    if (down <= COS45) continue;
    const area = len / 2;
    const h0 = a[i] * up[0] + a[i + 1] * up[1] + a[i + 2] * up[2] - minH;
    const h1 = a[i + 3] * up[0] + a[i + 4] * up[1] + a[i + 5] * up[2] - minH;
    const h2 = a[i + 6] * up[0] + a[i + 7] * up[1] + a[i + 8] * up[2] - minH;
    if (down > 0.999 && h0 < 0.05 && h1 < 0.05 && h2 < 0.05) { contact += area; continue; }
    ov45 += area;
    if (down > COS30) ov30 += area;
  }
  const size = { x: +(maxU - minU).toFixed(1), y: +(maxW - minW).toFixed(1), z: +(maxH - minH).toFixed(1) };
  const M = getMachine();
  const fits = Math.min(size.x, size.y) <= Math.min(M.bed.width, M.bed.depth) && Math.max(size.x, size.y) <= Math.max(M.bed.width, M.bed.depth) && size.z <= M.height;
  const slender = size.z / Math.max(1, Math.min(size.x, size.y));
  const o = { overhangCm2: ov45 / 100, overhang30Cm2: ov30 / 100, contactCm2: contact / 100, heightMm: size.z, size, fits };
  // a part that only touches the bed along a line or point cannot stand without supports or a raft
  // large enough that a stable option always ranks above an unstable one
  const unstable = o.contactCm2 < 0.2 ? 50 : 0;
  o.score = o.overhangCm2 + 2 / (o.contactCm2 + 0.4) + 0.003 * o.heightMm + (slender > 4 ? 2 : 0) + unstable + (fits ? 0 : 1000);
  o.unstable = !!unstable;
  return o;
}

function candidates(tris) {
  const dirs = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  const buckets = new Map();
  for (const a of tris) for (let i = 0; i < a.length; i += 9) {
    const ux = a[i + 3] - a[i], uy = a[i + 4] - a[i + 1], uz = a[i + 5] - a[i + 2];
    const vx = a[i + 6] - a[i], vy = a[i + 7] - a[i + 1], vz = a[i + 8] - a[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!len) continue;
    const key = `${Math.round(nx / len * 20)},${Math.round(ny / len * 20)},${Math.round(nz / len * 20)}`;
    const b = buckets.get(key) || [0, 0, 0, 0];
    b[0] += nx / 2; b[1] += ny / 2; b[2] += nz / 2; b[3] += len / 2;
    buckets.set(key, b);
  }
  const big = [...buckets.values()].sort((p, q) => q[3] - p[3]).slice(0, 10);
  for (const b of big) dirs.push(norm([b[0], b[1], b[2]]));
  const out = [];
  for (const d of dirs.map(norm)) if (!out.some(e => dot(e, d) > 0.98)) out.push(d);
  return out;
}

// tris: array of Float32Array world triangles for one object. Returns options sorted best first.
function orientObject(tris) {
  const dirs = candidates(tris);
  const h0 = evaluate(tris, dirs[0]).heightMm;
  const results = dirs.map((d, i) => {
    const e = evaluate(tris, d);
    return {
      id: i === 0 ? 'current' : `o${i}`,
      label: describe(d, e.heightMm, h0), isCurrent: i === 0, down: d.map(v => +v.toFixed(4)),
      rotation: rotationTo(d).map(v => +v.toFixed(6)),
      overhangCm2: +e.overhangCm2.toFixed(2), overhang30Cm2: +e.overhang30Cm2.toFixed(2),
      contactCm2: +e.contactCm2.toFixed(2), heightMm: e.heightMm, size: e.size, fits: e.fits, unstable: e.unstable, score: +e.score.toFixed(3),
    };
  });
  results.sort((a, b) => a.score - b.score);
  // collapse symmetric duplicates (same overhang, contact and height)
  const out = [];
  for (const r of results) {
    if (!r.isCurrent && out.some(o => Math.abs(o.overhangCm2 - r.overhangCm2) < 0.05 && Math.abs(o.contactCm2 - r.contactCm2) < 0.05 && Math.abs(o.heightMm - r.heightMm) < 0.2)) continue;
    out.push(r);
  }
  return out;
}

// The best n options, always including the file's own orientation (so it can be chosen again
// even when it scores poorly), kept in score order.
function shortlist(options, n = 4) {
  const current = options.find(o => o.isCurrent);
  const others = options.filter(o => !o.isCurrent).slice(0, current ? n - 1 : n);
  return [...others, ...(current ? [current] : [])].sort((a, b) => a.score - b.score);
}

module.exports = { orientObject, rotationTo, shortlist };
