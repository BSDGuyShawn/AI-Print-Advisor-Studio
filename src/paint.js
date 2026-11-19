// Painted colour in 3MF files (Bambu Studio `paint_color`, PrusaSlicer `slic3rpe:mmu_segmentation`).
// Each painted triangle carries a hex string describing a subdivision tree; every leaf has a state:
// 0 = the part's own filament, N = filament N. Format as in Orca/Bambu/PrusaSlicer TriangleSelector:
// the string is read from its last character to its first, one hex digit (nibble) at a time.
//   leaf:  low 2 bits 00, high 2 bits = state 0..2; high bits 11 = state in the next nibble + 3
//          (next nibble 0b1111 = state in the nibble after + 18)
//   split: low 2 bits = number of split sides (1..3), high 2 bits = special side; children follow,
//          written last-child-first.

function nibbles(str) {
  const out = [];
  for (let i = str.length - 1; i >= 0; i--) { const v = parseInt(str[i], 16); if (Number.isNaN(v)) return null; out.push(v); }
  return out;
}

// -> tree: { state } or { sides, special, children: [...] } (children in natural order), or null if malformed
function decode(str) {
  const n = nibbles(String(str || '').trim().toUpperCase());
  if (!n || !n.length) return null;
  let i = 0;
  const next = () => { if (i >= n.length) throw new Error('short'); return n[i++]; };
  const node = (depth) => {
    if (depth > 40) throw new Error('deep');
    const code = next();
    const sides = code & 3;
    if (!sides) {
      let state = code >> 2;
      if (state === 3) { const x = next(); state = x === 15 ? next() + 18 : x + 3; }
      return { state };
    }
    const special = sides === 3 ? 0 : code >> 2;
    if (special === 3 && sides !== 3) throw new Error('bad side');
    const children = new Array(sides + 1);
    for (let c = sides; c >= 0; c--) children[c] = node(depth + 1);
    return { sides, special, children };
  };
  try { return node(0); } catch { return null; }
}

function encode(tree) {
  const out = [];
  const put = (t) => {
    if (!t.children) {
      const s = t.state | 0;
      if (s < 3) out.push(s << 2);
      else if (s <= 17) { out.push(12); out.push(s - 3); }
      else { out.push(12); out.push(15); out.push(s - 18); }
      return;
    }
    out.push(((t.sides === 3 ? 0 : t.special) << 2) | t.sides);
    for (let c = t.sides; c >= 0; c--) put(t.children[c]);
  };
  put(tree);
  return out.reverse().map(v => v.toString(16).toUpperCase()).join('');
}

function states(tree, acc = new Set()) {
  if (!tree) return acc;
  if (!tree.children) { acc.add(tree.state); return acc; }
  for (const c of tree.children) states(c, acc);
  return acc;
}

// map leaf states (filament numbers) with fn(state) -> state; returns the new string
function remap(str, fn) {
  const t = decode(str);
  if (!t) return str;
  const walk = (x) => { if (!x.children) x.state = fn(x.state); else x.children.forEach(walk); };
  walk(t);
  return encode(t);
}

// Split a triangle (three [x,y,z] corners) into its painted pieces: calls emit(a, b, c, state).
function subdivide(tree, a, b, c, emit) {
  if (!tree.children) { emit(a, b, c, tree.state); return; }
  const v = [a, b, c];
  const L = [v[tree.special % 3], v[(tree.special + 1) % 3], v[(tree.special + 2) % 3]];
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
  const ch = tree.children;
  if (tree.sides === 1) {
    const m = mid(L[1], L[2]);
    subdivide(ch[0], L[0], L[1], m, emit);
    subdivide(ch[1], m, L[2], L[0], emit);
  } else if (tree.sides === 2) {
    const m01 = mid(L[0], L[1]), m02 = mid(L[0], L[2]);
    subdivide(ch[0], L[0], m01, m02, emit);
    subdivide(ch[1], m01, L[1], m02, emit);
    subdivide(ch[2], L[1], L[2], m02, emit);
  } else {
    const m01 = mid(L[0], L[1]), m12 = mid(L[1], L[2]), m20 = mid(L[2], L[0]);
    subdivide(ch[0], L[0], m01, m20, emit);
    subdivide(ch[1], m01, L[1], m12, emit);
    subdivide(ch[2], m12, L[2], m20, emit);
    subdivide(ch[3], m01, m12, m20, emit);
  }
}

module.exports = { decode, encode, states, remap, subdivide };
