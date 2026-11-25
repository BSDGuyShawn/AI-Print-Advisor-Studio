// Color gaps (Filament screen → Color gaps): where the colors you have on hand leave medium to large holes, and which
// new colors would fill the most of them. Free and local; finding products to buy is a separate, paid AI step
// (inventory.js). Colors are compared in CIELAB (ΔE: about 2 is barely visible, 10 clearly different, 25+ another color).
//
// How it works: a fixed set of reference colors spread over everything filament comes in (every hue at several
// shades, plus whites, grays and blacks). Each one is "covered" by its nearest color you own. The gap at a reference
// color is how far that nearest color is. New colors are picked one at a time: each time the one that would shrink
// the remaining gaps the most (how much of the color range it fills), then counted as owned, so the next pick goes
// somewhere else.
(function (root) {
  const COVERED = 10;      // ΔE: closer than this counts as having the color
  const MEDIUM = 15, LARGE = 25;
  const CAP = 45;          // a hole bigger than this counts like this, so one far corner doesn't outweigh everything

  const rgb = (h) => { const v = parseInt(String(h || '').replace('#', '').slice(0, 6), 16) || 0; return [v >> 16 & 255, v >> 8 & 255, v & 255]; };
  const hex = ([r, g, b]) => '#' + [r, g, b].map(c => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');
  function lab(h) {
    const lin = (c) => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
    const [r, g, b] = rgb(h).map(lin);
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), y = f(r * 0.2126 + g * 0.7152 + b * 0.0722), z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  function hsl(h, s, l) {
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return hex([f(0) * 255, f(8) * 255, f(4) * 255]);
  }
  // reference colors: 36 hues × 7 shades (bright, deep, dark, light, pastel, muted, dusky) + 9 neutrals
  // each with a weight: how common that shade is in filament (bright and deep colors most, dusky ones least)
  const SHADES = [[1, 0.5, 1.6], [0.85, 0.36, 1.3], [0.6, 0.2, 0.9], [0.75, 0.7, 1], [0.55, 0.84, 0.8], [0.4, 0.52, 0.6], [0.3, 0.32, 0.5]];
  const REF = [], W = [];
  for (let h = 0; h < 360; h += 10) for (const [s, l, w] of SHADES) { REF.push(hsl(h, s, l)); W.push(w); }
  for (const l of [0.04, 0.15, 0.27, 0.4, 0.52, 0.64, 0.76, 0.88, 0.98]) { REF.push(hsl(0, 0, l)); W.push(1.2); }
  const REF_LAB = REF.map(lab);

  // the color people search for (same words as the app's "colors you may not have")
  const HUES = [[0, 'red'], [18, 'orange red'], [30, 'orange'], [45, 'gold'], [55, 'yellow'], [75, 'lime green'], [100, 'green'], [150, 'emerald green'], [170, 'teal'], [190, 'cyan'], [205, 'sky blue'], [220, 'blue'], [240, 'royal blue'], [260, 'indigo'], [275, 'purple'], [288, 'violet'], [312, 'magenta'], [340, 'pink'], [355, 'red']];
  function colorWords(h) {
    const [r, g, b] = rgb(h).map(c => c / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (s < 0.12 || d < 0.06) return l > 0.9 ? 'white' : l < 0.12 ? 'black' : l > 0.7 ? 'light gray' : l < 0.35 ? 'dark gray' : 'gray';
    let hh = (mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60; if (hh < 0) hh += 360;
    let name = HUES.reduce((best, x) => (Math.abs(x[0] - hh) < Math.abs(best[0] - hh) ? x : best))[1];
    if (hh >= 60 && hh <= 120 && s < 0.5 && l < 0.5) name = 'olive green';
    else if (hh >= 15 && hh <= 45 && l < 0.45) name = l < 0.25 ? 'dark brown' : 'brown';
    else if (hh >= 30 && hh <= 55 && l > 0.7 && s < 0.6) name = 'beige';
    else if (/^(red|orange red)$/.test(name) && s < 0.45) name = l < 0.33 ? 'maroon' : 'brick red';
    else if (name !== 'pink' && l > 0.78 && s < 0.7) name = `pastel ${name}`;
    else if (name !== 'pink' && l > 0.72) name = `light ${name}`;
    else if (l < 0.28) name = `dark ${name}`;
    else if (s < 0.45) name = `muted ${name}`;
    else if (l < 0.42 && s > 0.6) name = `deep ${name}`;
    else if (s > 0.9 && l <= 0.6) name = `bright ${name}`;
    return name;
  }

  const hole = (d) => Math.max(0, Math.min(d, CAP) - COVERED);

  // owned: [{ hex: '#rrggbb' | [...], name }] (on-hand filament, already filtered by material and finish)
  // → { gaps: [{ hex, words, size, gapDE, fills (share of the missing range), nearest: { name, hex, deltaE } }], missing, owned }
  function findGaps(owned, { max = 15 } = {}) {
    const pts = [];
    for (const f of owned) for (const h of [].concat(f.hex || [])) if (/^#?[0-9a-f]{6}/i.test(String(h))) pts.push({ lab: lab(h), hex: String(h).slice(0, 7), name: f.name });
    const near = REF_LAB.map((p) => { let best = null, bd = Infinity; for (const o of pts) { const d = dist(p, o.lab); if (d < bd) { bd = d; best = o; } } return { d: pts.length ? bd : CAP + COVERED, o: best }; });
    const d = near.map(n => n.d);
    const missing0 = d.reduce((t, x, j) => t + W[j] * hole(x), 0);
    const gaps = [];
    const taken = new Set();
    for (let k = 0; k < max; k++) {
      let bi = -1, bg = 0;
      for (let i = 0; i < REF.length; i++) {
        if (taken.has(i) || d[i] < MEDIUM || W[i] < 0.8) continue;   // only colors in a medium or large gap, in shades filament is sold in
        let g = 0;
        for (let j = 0; j < REF.length; j++) { const nd = dist(REF_LAB[i], REF_LAB[j]); if (nd < d[j]) g += W[j] * (hole(d[j]) - hole(nd)); }
        if (g > bg) { bg = g; bi = i; }
      }
      if (bi < 0 || !missing0 || bg / missing0 < 0.005) break;
      taken.add(bi);
      const n = near[bi];
      gaps.push({ hex: REF[bi], words: colorWords(REF[bi]), gapDE: Math.round(d[bi]), size: d[bi] >= LARGE ? 'large' : 'medium',
        fills: bg / missing0, nearest: n.o ? { name: n.o.name, hex: n.o.hex, deltaE: Math.round(n.d) } : null });
      for (let j = 0; j < REF.length; j++) d[j] = Math.min(d[j], dist(REF_LAB[bi], REF_LAB[j]));
    }
    const missingAfter = d.reduce((t, x, j) => t + W[j] * hole(x), 0);
    return { gaps, owned: pts.length, missing: missing0 / (W.reduce((t, w) => t + w, 0) * (CAP - COVERED)), filledByAll: missing0 ? 1 - missingAfter / missing0 : 0 };
  }

  const api = { findGaps, colorWords, lab, deltaE: (a, b) => dist(lab(a), lab(b)), REF, COVERED, MEDIUM, LARGE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ColorGaps = api;
})(typeof window !== 'undefined' ? window : globalThis);
