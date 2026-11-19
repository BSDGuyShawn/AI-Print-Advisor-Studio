// Reads Orca/Snapmaker Orca G-code: header totals plus per-feature extrusion volume, nominal time and
// volumetric flow (mm³/s). Flow is computed per move from E, distance and feedrate, so it reflects what the
// slicer actually commanded after its own volumetric-speed caps.

const FILAMENT_AREA = Math.PI * 0.875 * 0.875; // 1.75 mm filament
const BIN = 0.5;                                // mm³/s histogram bin

function parseDuration(s) {
  let t = 0;
  for (const [, n, u] of s.matchAll(/(\d+)\s*([dhms])/g)) t += +n * { d: 86400, h: 3600, m: 60, s: 1 }[u];
  return t || null;
}

// One line at a time, so files of any size can be streamed with flat memory use.
function createAnalyzer() {
  const features = new Map();
  const tools = new Map();
  let type = 'Other', tool = 0;
  let x = 0, y = 0, z = 0, f = 3000, relE = true, eAbs = 0;
  let toolChanges = 0, retracts = 0, layers = 0, travelDist = 0;
  const header = {};

  const feat = (name) => {
    if (!features.has(name)) features.set(name, { volume: 0, time: 0, hist: new Map(), maxFlow: 0 });
    return features.get(name);
  };

  function line(line) {
    const c0 = line.charCodeAt(0);
    if (c0 === 59) { // ';'
      if (line.startsWith(';TYPE:')) type = line.slice(6).trim();
      else if (line.startsWith(';LAYER_CHANGE') || line.startsWith('; CHANGE_LAYER')) layers++;
      else {
        let m;
        if ((m = /^; estimated printing time \(normal mode\) = (.+)$/.exec(line))) header.timeSeconds = parseDuration(m[1]);
        else if ((m = /^; total filament used \[g\] = ([\d.]+)/.exec(line))) header.grams = +m[1];
        else if ((m = /^; filament used \[g\] = (.+)$/.exec(line))) header.gramsPerTool = m[1].split(',').map(Number);
        else if ((m = /^; total layer number: (\d+)/.exec(line))) header.layers = +m[1];
        else if ((m = /^; max_z_height: ([\d.]+)/.exec(line))) header.maxZ = +m[1];
        else if ((m = /^; total filament cost = ([\d.]+)/.exec(line))) header.cost = +m[1];
      }
      return;
    }
    if (c0 === 84 && /^T\d+\s*$/.test(line)) { // 'T'
      const t = +line.slice(1);
      if (t !== tool) toolChanges++;
      tool = t;
      return;
    }
    if (c0 === 77) { // 'M'
      if (line.startsWith('M83')) relE = true;
      else if (line.startsWith('M82')) relE = false;
      return;
    }
    if (c0 !== 71) return; // 'G'
    if (line.startsWith('G92')) { const m = /E(-?[\d.]+)/.exec(line); if (m) eAbs = +m[1]; return; }
    if (!(line.startsWith('G1 ') || line.startsWith('G0 ') || line.startsWith('G2 ') || line.startsWith('G3 '))) return;
    const semi = line.indexOf(';');
    const cmd = semi >= 0 ? line.slice(0, semi) : line;
    let nx = x, ny = y, nz = z, de = 0, hasE = false;
    for (const part of cmd.split(' ')) {
      const k = part.charCodeAt(0), v = +part.slice(1);
      if (k === 88) nx = v; else if (k === 89) ny = v; else if (k === 90) nz = v;
      else if (k === 70) f = v;
      else if (k === 69) { hasE = true; if (relE) de = v; else { de = v - eAbs; eAbs = v; } }
    }
    const dist = Math.hypot(nx - x, ny - y); // arcs approximated by chord
    if (hasE && de < 0 && dist === 0) retracts++;
    if (hasE && de > 0 && dist > 0 && f > 0) {
      const t = dist / (f / 60);
      const vol = de * FILAMENT_AREA;
      const flow = vol / t;
      const fe = feat(type);
      fe.volume += vol; fe.time += t;
      if (flow > fe.maxFlow) fe.maxFlow = flow;
      const b = Math.floor(flow / BIN);
      fe.hist.set(b, (fe.hist.get(b) || 0) + t);
      tools.set(tool, (tools.get(tool) || 0) + vol);
    } else if (!hasE || de <= 0) {
      travelDist += dist;
    }
    x = nx; y = ny; z = nz;
  }

  function finish() {

  const p95 = (hist, total) => {
    const bins = [...hist.entries()].sort((a, b) => a[0] - b[0]);
    let acc = 0;
    for (const [b, t] of bins) { acc += t; if (acc >= total * 0.95) return (b + 1) * BIN; }
    return 0;
  };
  const totalTime = [...features.values()].reduce((s, v) => s + v.time, 0) || 1;
  const byFeature = [...features.entries()].map(([name, v]) => ({
    name,
    volumeCm3: +(v.volume / 1000).toFixed(2),
    timeShare: +(v.time / totalTime).toFixed(3),
    flowP95: +Math.min(p95(v.hist, v.time), v.maxFlow).toFixed(1),
    flowMax: +v.maxFlow.toFixed(1),
  })).sort((a, b) => b.timeShare - a.timeShare);

  return {
    timeSeconds: header.timeSeconds ?? null,
    grams: header.grams ?? null,
    gramsPerTool: header.gramsPerTool || null,
    layers: header.layers ?? layers,
    maxZ: header.maxZ ?? null,
    cost: header.cost ?? null,
    toolChanges, retracts,
    travelMeters: +(travelDist / 1000).toFixed(1),
    volumeByTool: Object.fromEntries([...tools.entries()].map(([t, v]) => [`T${t}`, +(v / 1000).toFixed(2)])),
    byFeature,
    peakFlowP95: Math.max(0, ...byFeature.map(f => f.flowP95)),
  };
  }

  return { line, finish };
}

function analyzeGcode(text) {
  const a = createAnalyzer();
  let pos = 0;
  const len = text.length;
  while (pos < len) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0) nl = len;
    a.line(text.slice(pos, nl));
    pos = nl + 1;
  }
  return a.finish();
}

// Streams the file in 1 MB pieces instead of loading it whole (G-code can be hundreds of MB).
function analyzeGcodeFile(file) {
  const fs = require('fs');
  return new Promise((resolve, reject) => {
    const a = createAnalyzer();
    let rest = '';
    const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
    stream.on('data', (chunk) => {
      const text = rest + chunk;
      let pos = 0, nl;
      while ((nl = text.indexOf('\n', pos)) >= 0) { a.line(text.slice(pos, nl)); pos = nl + 1; }
      rest = text.slice(pos);
    });
    stream.on('end', () => { if (rest) a.line(rest); resolve(a.finish()); });
    stream.on('error', reject);
  });
}

module.exports = { analyzeGcode, analyzeGcodeFile, createAnalyzer };
