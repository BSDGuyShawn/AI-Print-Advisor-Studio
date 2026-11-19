// Colour remix: the AI assigns the user's on-hand filaments to numbered regions of the model, in a chosen style.
// The app then enforces the rules (only listed filaments, no more colours than toolheads unless filament-swap
// pauses are allowed, one material family) and paints the result into the model.
const JSZip = require('jszip');
const { callStructured } = require('./claude');
const { encode } = require('./paint');
const { mainHex } = require('./inventory');

const STYLES = {
  realistic: 'Realistic: the natural, real-world colours of the subject (identify it from the pictures and names), as close as the user’s filaments allow.',
  fun: 'Fun: bright, playful, high-contrast colours that make people smile.',
  galaxy: 'Galaxy: deep space looks: dark blues, purples and blacks with sparkle/galaxy and metallic finishes where available.',
  colorshift: 'Color Shift: favour silk dual/tri-colour, gradient, colour-change and other multicolour filaments, used on the largest visible areas.',
  pastel: 'Pastel: soft, light, muted tones.',
  monochrome: 'Monochrome: shades of one colour family (plus white/black accents if they help).',
  holiday: 'Holiday: festive colours that suit the subject.',
};

const hexRgb = (h) => { const v = parseInt(String(h).replace('#', '').slice(0, 6), 16) || 0; return [v >> 16 & 255, v >> 8 & 255, v & 255]; };
const dist = (a, b) => { const x = hexRgb(a), y = hexRgb(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
// materials Snapmaker Orca will print together: PLA family / PETG+PCTG / ABS+ASA
const family = (t) => (/^(PETG|PCTG)/i.test(t) ? 'petg' : /^(ABS|ASA)/i.test(t) ? 'abs' : /^TPU/i.test(t) ? 'tpu' : 'pla');

function systemPrompt() {
  return `You are a colour designer for multi-material 3D prints. The model's parts have already been identified and confirmed by the user (each has a name, a kind and its natural colour), and you see them in part-map pictures with their numbers. Choose a filament for every part from the user's own on-hand filaments to create distinct colour schemes in the requested styles.

Rules:
- Colour by what each part IS. In the Realistic style every part gets the filament closest to its natural colour ("realColor"): a sea turtle's skin is green, its shell brown, its eyeballs white with black pupils. Never give a part a colour that belongs to another part.
- Eyes must read as eyes in every style: "eye" parts light (white or near white unless the style truly calls for another light colour) and "pupil" parts black or very dark.
- Parts that are one material in real life stay one colour; don't split one part between colours.
- Use only filament ids from the list. Prefer filaments with spools on hand and enough remaining.
- Each scheme uses at most "maxColors" different filaments. If "extraColorsWithPauses" is true you may use up to maxColors + 2, but only when an extra colour's parts all sit above the parts of the colour it replaces (the printer pauses at that height so the user can swap a spool). When there are more parts than colours, let small parts share a colour with a part they'd naturally match (e.g. pupils and a dark mouth), never eyes with skin.
- Use one material family per scheme (all PLA-type, or all PETG/PCTG, or all ABS/ASA); prefer the family given in "material".
- Make exactly the number of schemes asked for in each style ("schemesWanted"), and set each scheme's "style" to that style's id. Make the schemes clearly different from each other.
- "subject" is what the model depicts. For each assignment, "label" is the part's name.`;
}

function schema() {
  return {
    type: 'object', additionalProperties: false, required: ['subject', 'variations'],
    properties: {
      subject: { type: 'string' },
      variations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['style', 'name', 'description', 'assignments'],
        properties: { style: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
          assignments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['region', 'filament_id', 'label'],
            properties: { region: { type: 'integer', description: 'part id' }, filament_id: { type: 'string' }, label: { type: 'string' } } } } } } },
    },
  };
}

function buildContent({ styles, style, custom, count, maxColors, extras, material, regions, filaments, images, modelName, subject }) {
  // several styles at once: [{ id, count }]
  const wanted = (styles && styles.length ? styles : [{ id: style, count }]).filter(x => x.count > 0);
  const content = [];
  for (const im of images || []) {
    content.push({ type: 'text', text: im.label });
    content.push({ type: 'image', source: { type: 'base64', media_type: im.dataUrl.slice(5, im.dataUrl.indexOf(';')), data: im.dataUrl.split(',')[1] } });
  }
  content.push({ type: 'text', text: JSON.stringify({
    model: modelName, subject: subject || undefined, userRequest: custom || undefined,
    schemesWanted: wanted.map(x => ({ style: x.id, howMany: x.count, meaning: STYLES[x.id] || x.id })),
    variationsWanted: wanted.reduce((t, x) => t + x.count, 0),
    maxColors, extraColorsWithPauses: !!extras, material,
    parts: regions.map(r => ({ id: r.id, name: r.name || r.partName, kind: r.kind, realColor: r.realColor || undefined, areaCm2: r.areaCm2, zFromTo: [r.zMin, r.zMax], facing: r.facing })),
    filaments,
  }) });
  return content;
}

// Rough cost before running: measured sizes (images ~900 px ≈ 1,100 tokens each) at list prices per million tokens.
const PRICES = { 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20], 'claude-haiku-5-5': [0.1, 0.5] };
function estimateCost({ model, regions, filaments, count, images = 5 }) {
  const [pi, po] = PRICES[model] || PRICES['claude-sonnet-5-5'];
  const input = 900 + images * 1150 + regions * 28 + filaments * 55 + 300;
  const output = 60 + count * (regions * 22 + 80);
  const usd = (input * pi + output * po) / 1e6;
  return { input, output, usd, low: usd * 0.75, high: usd * 1.35 };
}

// Make each variation follow the rules; returns tidy variations with toolhead plans.
function finalizeVariations(answer, { regions, inventory, maxColors, extras }) {
  const byId = new Map(inventory.map(f => [f.id, f]));
  const regionById = new Map(regions.map(r => [r.id, r]));
  const out = [];
  for (const v of (answer && answer.variations) || []) {
    const assign = new Map(), labels = new Map(), notes = [];
    for (const a of v.assignments || []) {
      if (!regionById.has(a.region)) continue;
      let f = byId.get(a.filament_id);
      if (!f) { // unknown id: nearest listed filament by name or colour
        f = inventory.find(x => `${x.brand} ${x.line} ${x.color}`.toLowerCase() === String(a.filament_id).toLowerCase()) || null;
        if (!f) continue;
      }
      assign.set(a.region, f.id); if (a.label) labels.set(a.region, a.label);
    }
    // regions the AI skipped: the filament of the nearest assigned region
    for (const r of regions) {
      if (assign.has(r.id)) continue;
      let best = null, bd = Infinity;
      for (const [rid, fid] of assign) { const o = regionById.get(rid); const d = Math.hypot(...[0, 1, 2].map(k => o.centroid[k] - r.centroid[k])); if (d < bd) { bd = d; best = fid; } }
      if (best) assign.set(r.id, best);
    }
    if (!assign.size) continue;
    // one material family: the family covering the most area wins; others move to the nearest colour in it
    const areaBy = (pred) => { const m = new Map(); for (const [rid, fid] of assign) if (pred(fid)) m.set(fid, (m.get(fid) || 0) + regionById.get(rid).areaCm2); return m; };
    const famArea = new Map();
    for (const [fid, a] of areaBy(() => true)) { const fam = family(byId.get(fid).type); famArea.set(fam, (famArea.get(fam) || 0) + a); }
    const fam = [...famArea].sort((a, b) => b[1] - a[1])[0][0];
    const nearestIn = (hex, pool) => pool.reduce((b, x) => (!b || dist(mainHex(x), hex) < dist(mainHex(b), hex) ? x : b), null);
    for (const [rid, fid] of assign) {
      const f = byId.get(fid);
      if (family(f.type) !== fam) {
        const used = [...new Set(assign.values())].map(id => byId.get(id)).filter(x => family(x.type) === fam);
        const alt = nearestIn(mainHex(f), used.length ? used : inventory.filter(x => family(x.type) === fam));
        if (alt) { assign.set(rid, alt.id); notes.push(`${f.color} (${f.type}) swapped for ${alt.color} so all materials print together.`); }
      }
    }
    // eyes stay readable: light eyeballs (Realistic), dark pupils that differ from the eyeballs
    const lum = (f) => { const [r, g, b] = hexRgb(mainHex(f)); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
    const famPool = inventory.filter(x => family(x.type) === fam && !/silk.*(dual|tri)|gradient|rainbow/i.test(`${x.line} ${x.finish}`));
    const usedFids = () => [...new Set(assign.values())].map(id => byId.get(id));
    const pick = (cands, score) => cands.reduce((b, x) => (!b || score(x) > score(b) ? x : b), null);
    for (const r of regions) {
      if (!assign.has(r.id)) continue;
      const f = byId.get(assign.get(r.id));
      const multi = (x) => Array.isArray(x.hex) && x.hex.length > 1;
      if (r.kind === 'pupil' && (lum(f) > 0.3 || multi(f))) {
        const alt = pick(usedFids().filter(x => !multi(x)), x => -lum(x)); const dark = alt && lum(alt) <= 0.3 ? alt : pick(famPool.filter(x => !multi(x)), x => -lum(x));
        if (dark && dark.id !== f.id && lum(dark) <= Math.max(0.3, lum(f))) { assign.set(r.id, dark.id); notes.push(`Pupils use ${dark.color} so the eyes stand out.`); }
      }
      if (r.kind === 'eye' && v.style === 'realistic' && lum(f) < 0.6) {
        const alt = pick(usedFids(), x => lum(x)); const light = alt && lum(alt) >= 0.75 ? alt : pick(famPool, x => lum(x));
        if (light && lum(light) > lum(f)) { assign.set(r.id, light.id); notes.push(`Eyes use ${light.color} for a natural look.`); }
      }
    }
    // colour count: toolheads, plus up to two swaps at a pause when allowed
    const plan = planToolheads(assign, regionById, byId, maxColors, extras);
    notes.push(...plan.notes);
    out.push({ style: v.style || '', name: v.name, description: v.description, assign: Object.fromEntries(plan.assign), labels: Object.fromEntries(labels),
      tools: plan.tools.map(t => ({ ...t, filament: byId.get(t.fid) })), pauses: plan.pauses, notes: [...new Set(notes)] });
  }
  return out;
}

function planToolheads(assignIn, regionById, byId, maxColors, extras) {
  const assign = new Map(assignIn), notes = [];
  const area = () => { const m = new Map(); for (const [rid, fid] of assign) m.set(fid, (m.get(fid) || 0) + regionById.get(rid).areaCm2); return m; };
  const zr = (fid) => { let a = Infinity, b = -Infinity; for (const [rid, f] of assign) if (f === fid) { const r = regionById.get(rid); a = Math.min(a, r.zMin); b = Math.max(b, r.zMax); } return [a, b]; };
  const limit = maxColors + (extras ? 2 : 0);
  const mergeSmallest = () => {
    const a = [...area()].sort((x, y) => y[1] - x[1]);
    const [drop] = a[a.length - 1];
    const keep = a.slice(0, -1).map(x => x[0]);
    const to = keep.reduce((b, id) => (!b || dist(mainHex(byId.get(id)), mainHex(byId.get(drop))) < dist(mainHex(byId.get(b)), mainHex(byId.get(drop))) ? id : b), null);
    for (const [rid, f] of assign) if (f === drop) assign.set(rid, to);
    notes.push(`Used ${byId.get(to).color} instead of ${byId.get(drop).color} to stay within ${extras ? 'the colour limit' : `${maxColors} toolheads`}.`);
  };
  while (area().size > limit) mergeSmallest();
  // largest areas get their own toolhead; extras try to take over a toolhead after a pause
  let ordered = [...area()].sort((x, y) => y[1] - x[1]).map(x => x[0]);
  const tools = [], pauses = [];
  for (const fid of ordered.slice(0, maxColors)) tools.push({ tool: tools.length + 1, fid, from: 0 });
  for (const fid of ordered.slice(maxColors)) {
    const [eLo] = zr(fid);
    // a toolhead whose current colour is finished below where this colour starts
    const host = tools.filter(t => !tools.some(o => o.tool === t.tool && o.from > t.from)).find(t => zr(t.fid)[1] <= eLo - 0.4);
    if (host) {
      tools.push({ tool: host.tool, fid, from: +eLo.toFixed(2) });
      pauses.push({ z: +eLo.toFixed(2), tool: host.tool, from: byId.get(host.fid), to: byId.get(fid) });
    } else {
      // can't be swapped in at a pause: merge into the closest colour already on a toolhead
      const to = tools.reduce((b, t) => (!b || dist(mainHex(byId.get(t.fid)), mainHex(byId.get(fid))) < dist(mainHex(byId.get(b.fid)), mainHex(byId.get(fid))) ? t : b), null);
      for (const [rid, f] of assign) if (f === fid) assign.set(rid, to.fid);
      notes.push(`${byId.get(fid).color} would need a spool swap where both colours are still printing, so it uses ${byId.get(to.fid).color} instead.`);
    }
  }
  return { assign, tools, pauses: pauses.sort((a, b) => a.z - b.z), notes };
}

// Paint every triangle of the plate's meshes with its region's toolhead; returns the new 3MF buffer.
async function paintModel(buffer, labels, regionTool, pauses = [], plateIndex = 1) {
  const zip = await JSZip.loadAsync(buffer);
  const codes = new Map(); // tool -> paint code
  const codeFor = (tool) => { let c = codes.get(tool); if (!c) { c = encode({ state: tool }); codes.set(tool, c); } return c; };
  const byFile = new Map();
  const counts = new Map(); // mesh object id -> tool -> triangles
  for (const [key, lab] of labels) { const i = key.lastIndexOf('#'); const file = key.slice(0, i).replace(/^\//, ''), id = key.slice(i + 1); if (!byFile.has(file)) byFile.set(file, new Map()); byFile.get(file).set(id, lab); }
  for (const [file, objs] of byFile) {
    const f = zip.file(file) || zip.file(decodeURIComponent(file));
    if (!f) continue;
    let xml = await f.async('string');
    xml = xml.replace(/(<object\b[^>]*\bid="([^"]+)"[^>]*>)([\s\S]*?)(<\/object>)/g, (m0, open, id, body, close) => {
      const lab = objs.get(id);
      if (!lab || !/<triangles>/.test(body)) return m0;
      let t = 0;
      const cnt = counts.get(id) || new Map(); counts.set(id, cnt);
      body = body.replace(/<((?:\w+:)?triangle)\b([^>]*?)\/>/g, (m1, tag, attrs) => {
        const tool = regionTool.get(lab[t++]);
        if (tool) cnt.set(tool, (cnt.get(tool) || 0) + 1);
        attrs = attrs.replace(/\s+(?:paint_color|(?:\w+:)?mmu_segmentation|paint_supports|paint_seam)="[^"]*"/g, (m2) => (/paint_supports|paint_seam/.test(m2) ? m2 : ''));
        return tool ? `<${tag}${attrs} paint_color="${codeFor(tool)}"/>` : `<${tag}${attrs}/>`;
      });
      return open + body + close;
    });
    zip.file(f.name, xml);
  }
  // each painted part's (and object's) own filament: its main colour, so no unused toolhead stays "in use"
  const top = (m) => [...m].sort((a, b) => b[1] - a[1])[0];
  const msf = zip.file('Metadata/model_settings.config');
  if (msf && counts.size) {
    let ms = await msf.async('string');
    ms = ms.replace(/(<object id="[^"]+">)([\s\S]*?)(<\/object>)/g, (m0, open, body, close) => {
      const all = new Map();
      body = body.replace(/(<part id="([^"]+)"[^>]*>)([\s\S]*?)(<\/part>)/g, (p0, po, pid, pb, pc) => {
        const c = counts.get(pid); if (!c || !c.size) return p0;
        for (const [k, v] of c) all.set(k, (all.get(k) || 0) + v);
        const tool = top(c)[0];
        pb = /key="extruder"/.test(pb) ? pb.replace(/(key="extruder" value=")\d+(")/, `$1${tool}$2`) : pb.replace(/(\s*)(<\/?(?:metadata|mesh_stat)|$)/, `$1<metadata key="extruder" value="${tool}"/>$1$2`);
        return po + pb + pc;
      });
      if (all.size) body = body.replace(/^(\s*(?:<metadata key="name"[^>]*\/>\s*)?<metadata key="extruder" value=")\d+(")/, `$1${top(all)[0]}$2`);
      return open + body + close;
    });
    zip.file(msf.name, ms);
  }
  // filament-swap pauses at heights (the printer's pause command, as Snapmaker Orca writes them)
  if (pauses.length) {
    const xmlName = 'Metadata/custom_gcode_per_layer.xml';
    let xml = zip.file(xmlName) ? await zip.file(xmlName).async('string') : '<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_layer>\n</custom_gcodes_per_layer>\n';
    const plateRe = new RegExp(`<plate>\\s*<plate_info id="${plateIndex}"/>[\\s\\S]*?</plate>`);
    const layers = pauses.map(p => `<layer top_z="${p.z}" type="1" extruder="${p.tool}" color="" extra="" gcode="M600"/>`).join('\n');
    if (plateRe.test(xml)) xml = xml.replace(plateRe, (m) => m.replace(/<layer\b[^>]*type="1"[^>]*\/>\s*/g, '').replace(/(<plate_info[^>]*\/>)/, `$1\n${layers}`));
    else xml = xml.replace('</custom_gcodes_per_layer>', `<plate>\n<plate_info id="${plateIndex}"/>\n${layers}\n<mode value="MultiAsSingle"/>\n</plate>\n</custom_gcodes_per_layer>`);
    zip.file(xmlName, xml);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function runRemix({ apiKey, model, ...args }) {
  return callStructured({ apiKey, model, system: systemPrompt(), content: buildContent(args), schema: schema() });
}

module.exports = { STYLES, runRemix, finalizeVariations, paintModel, estimateCost, family };
