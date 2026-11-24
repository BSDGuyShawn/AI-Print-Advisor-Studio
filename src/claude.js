// Builds the request to Claude and validates the structured answer.
const { FIT_RULE } = require('./fit');
const { CATALOG, BY_KEY, validate, normalize } = require('./orca-settings');

const PRINTER = {
  name: 'Snapmaker U1',
  facts: [
    'CoreXY, 270 x 270 x 270 mm build volume, textured PEI flexible steel plate, no heated chamber',
    'SnapSwap toolchanger: 4 independent toolheads (T1-T4), each with its own 0.4 mm stainless nozzle, ~5 s tool swaps',
    'Each color has its own nozzle, so there is no purging between colors; idle heads sit at standby temperature and can ooze, which is what the prime tower cleans',
    'Max toolhead speed 500 mm/s, max acceleration 20,000 mm/s², hotend max flow ~32 mm³/s, max nozzle 300 °C, max bed 100 °C',
    'Klipper firmware, sliced in Snapmaker Orca (an OrcaSlicer fork)',
  ],
};

function sliderDescription(v) {
  if (v <= 15) return 'Maximum quality: print time is not a concern. Prioritize surface finish, fine detail and dimensional accuracy.';
  if (v <= 38) return 'Quality-leaning: accept noticeably longer prints for clearly better surfaces and detail.';
  if (v <= 61) return 'Balanced: good-looking, reliable print at a reasonable speed (close to the stock profile).';
  if (v <= 84) return 'Speed-leaning: finish faster; accept visible layer lines and minor cosmetic flaws, but the print must still succeed.';
  return 'Maximum speed: fastest reliable print, cosmetic quality is secondary. Never trade away print success.';
}

// Structured output schema (output_config.format). Rules: additionalProperties false on every object,
// at most 24 optional fields and 16 union types in total, so every field is required and nothing is nullable.
function planSchema({ withKeyEnum = true } = {}) {
  const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const str = (description) => ({ type: 'string', description });
  return obj({
    summary: str('2-4 sentences: what this model is, the main printing challenge, and the overall strategy.'),
    orientation: str('Orientation advice in plain words, including why the chosen option (or the current one) is best.'),
    orientation_choices: {
      type: 'array', description: 'For each object whose orientation should change, the id of one of its listed options. Empty array to keep all as placed.',
      items: obj({ object_index: { type: 'integer' }, option_id: { type: 'string' }, reason: { type: 'string' } }),
    },
    risks: { type: 'array', items: obj({ severity: { type: 'string', enum: ['info', 'warn', 'critical'] }, title: { type: 'string' }, detail: { type: 'string' } }) },
    settings: {
      type: 'array',
      description: 'Changes on top of the base settings AFTER the recipe is applied. Include a key to override a recipe value. Add a few high-value "check" items.',
      items: obj({
        key: withKeyEnum ? { type: 'string', enum: CATALOG.map(c => c.key) } : str('One of the allowed setting keys, exactly as listed.'),
        recommended: str('Value in Orca config format: plain numbers, percentages like "15%", enum values exactly as listed, 1/0 for on/off.'),
        slot: { type: 'integer', description: 'Filament keys: 1-based toolhead (1-4). Process keys: 0.' },
        action: { type: 'string', enum: ['change', 'check'] },
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        reason: str('One or two sentences tied to this model\'s geometry, the slice results, past prints, or the user\'s goal.'),
      }),
    },
    manual_steps: { type: 'array', items: { type: 'string' }, description: 'Things to do by hand in Orca that are not a single setting. Empty array if none.' },
    material_notes: str('Material advice. Empty string if nothing to add.'),
    multicolor_notes: str('Multi-color advice. Empty string if single color.'),
    history_notes: str('What past prints told you. Empty string if no history or nothing relevant.'),
    estimated_effect: str('Expected effect on print time and quality vs. the original slice.'),
  });
}

function catalogText({ curatedOnly = false } = {}) {
  const lines = [];
  for (const s of CATALOG) {
    if (curatedOnly && !s.curated) continue;
    const range = s.options ? ` options: ${s.options.slice(0, 14).join(' | ')}${s.options.length > 14 ? ' | …' : ''}`
      : (s.min != null || s.max != null) ? ` range ${s.min ?? ''}–${s.max ?? ''}` : '';
    const tip = s.curated ? '' : (s.tooltip ? ` — ${s.tooltip.slice(0, 90)}` : '');
    lines.push(`- ${s.key} [${s.scope}] ${s.label}${s.unit ? ` (${s.unit})` : ''}${range}${tip}`);
  }
  return lines.join('\n');
}

function buildSystemPrompt({ compact = false } = {}) {
  return `You are an expert FDM slicing engineer helping a new 3D printing hobbyist get great results on a ${PRINTER.name}.

Printer facts:
${PRINTER.facts.map(f => `- ${f}`).join('\n')}

You receive: geometry measured from the mesh (after any orientation already applied), scored orientation options per object, the base slicer settings (already converted to the U1 and the user's toolhead filaments), the recipe the user's Quality-to-Speed slider selected (its changes are applied automatically), real slice results of the original from Snapmaker Orca when available (time, grams, per-feature time share and volumetric flow, tool changes, slicer warnings), the user's print history from their U1s when available, and images (the slicer thumbnail plus app renders; red = faces steeper than 45° from vertical).

How to decide:
- Ground every recommendation in this evidence. Slicer warnings (e.g. "floating cantilever") are authoritative.
- Orientation: choose an option id only when it is clearly better (less overhang without becoming unstable, i.e. enough bed contact). Options flagged unstable touch the bed along a line or point.
- Respect the slider, but never recommend something likely to fail. Speeds above a filament's max volumetric speed are capped by the slicer, so raising them saves nothing; the hotend caps at ~32 mm³/s.
- Materials: PLA prints cool and fast with strong cooling; PETG on textured PEI wants ~235-255 °C, 70-80 °C bed, 30-60% fan, and slower outer walls; don't iron PETG unless quality is the explicit goal. With mixed materials, mention the shared bed temperature and that PLA and PETG bond poorly (useful for support interfaces, bad for multi-material parts that must hold together).
- Multi-color on the U1: no flushing between colors. The prime tower costs time and filament (see its share in the slice results); suggest trimming it rather than disabling it unless ooze is clearly not a concern.
- Avoid lightning infill under flat top surfaces; adaptive cubic is the safer light-infill choice.
- Snapmaker Orca rejects some combinations: 100% sparse infill only works with rectilinear, aligned rectilinear, monotonic, monotonic line, concentric, Hilbert curve, Archimedean chords or octagram spiral patterns; organic tree supports (also what tree supports use when support_style is "default") can't be used on objects with variable layer height (plate.totals.customLayering lists them; use tree_hybrid, tree_slim or tree_strong there); layer height can't exceed the 0.4 mm nozzle; high-temperature filaments (ABS, ASA, PC, PA…) can't be printed with low-temperature ones (PLA, TPU, PVA…). The app auto-corrects these, but recommend valid combinations.
- Use print history: repeat what worked, avoid what failed, and say so in history_notes.
- Only include settings whose value should change from base+recipe, plus a few high-value "check" items. Use exactly the listed keys. Values must be valid for the listed type/range/options. Filament keys need slot 1-4; process keys use slot 0.
- plate.totals.parkedObjects counts objects the user parked off the plate; they are not printed and are excluded from all measurements. Don't mention them unless relevant.
- Write for a newcomer: short, concrete reasons.

${FIT_RULE}

Keep print time reasonable: unless the slider is at the quality end or the stated purpose needs real strength, avoid changes that together more than double the print time. Heavy infill or many extra solid layers rarely help decorative pieces or snap-fit parts; say so instead of adding them.

Allowed settings${compact ? '' : ' (curated ones first)'}:
${catalogText({ curatedOnly: compact })}`;
}

function buildUserContent(p) {
  const { fileName, analysis, settings, slider, recipe, recipeChanges, materials, purpose, images, originalSlice, history, baseNotes } = p;
  const payload = {
    // "Analyze all objects": one request per unique object; its settings are written on that object in the file
    ...(p.focus ? { task: {
      analyze: `Only the object in plate.objects (${p.focus.name}${p.focus.copies > 1 ? `, ${p.focus.copies} copies/near-identical objects that get the same settings` : ''}). Recommend the settings for THIS object; they are saved as per-object settings on it, so other objects keep their own.`,
      wholePlateSettings: 'Filament (toolhead) settings, first-layer height, first-layer and travel speeds and the prime tower apply to every object on the plate: recommend those only if this object really needs them, and say why in the reason.',
      otherObjectsOnThisPlate: p.focus.others,
    } } : {}),
    file: fileName,
    preference: { sliderValue0Quality100Speed: slider, meaning: sliderDescription(slider) },
    recipe: { name: recipe.name, about: recipe.about, appliedChanges: recipeChanges.map(c => `${c.key}=${c.value}`) },
    purpose: purpose || '(not specified)',
    partsFitTogether: !!p.assembly,
    materialsByToolhead: materials,
    projectPreparation: baseNotes,
    plate: {
      index: analysis.plateIndex, totals: analysis.totals,
      objects: analysis.objects.map((o, i) => ({
        objectIndex: i, name: o.name, extruder: o.extruder, partExtruders: o.partExtruders, paintedTriangles: o.paintedTriangles,
        sizeMm: o.sizeMm, volumeCm3: o.volumeCm3, bedContactAreaCm2: o.bedContactAreaCm2,
        overhangAreaBelow45Cm2: o.overhangAreaBelow45Cm2, overhangByHeightBandCm2_bottomToTop: o.overhangByHeightBandCm2,
        flatTopAreaCm2: o.flatTopAreaCm2, heightToBaseRatio: o.heightToBaseRatio, smallestDimensionMm: o.smallestDimensionMm,
        perObjectOverrides: o.overrides, modifierParts: o.modifierParts,
        orientationApplied: o.rotation ? 'yes (measurements above are for the new orientation)' : 'no',
        orientationOptions: require('./orient').shortlist(o.orientationOptions || [], 5).map(x => ({ id: x.id, label: x.isCurrent ? 'As placed in the file' : x.label, overhangCm2: x.overhangCm2, bedContactCm2: x.contactCm2, heightMm: x.heightMm, unstable: x.unstable, fits: x.fits })),
      })),
    },
    originalSlice: originalSlice ? {
      time: `${(originalSlice.timeSeconds / 3600).toFixed(2)} h`, grams: originalSlice.grams, filaments: originalSlice.filaments,
      layers: originalSlice.gcode.layers, toolChanges: originalSlice.gcode.toolChanges, warnings: originalSlice.warnings,
      byFeature: originalSlice.gcode.byFeature.slice(0, 10),
    } : 'not available (slicer not set up)',
    printHistory: history || 'not available',
    baseSettings: settings.current,
    context: settings.context,
  };
  const content = [];
  for (const img of images.slice(0, 4)) {
    content.push({ type: 'text', text: `Image: ${img.label}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
  }
  content.push({ type: 'text', text: 'Model analysis, slice results and settings:\n```json\n' + JSON.stringify(payload, null, 1) + '\n```\nReturn your plan as JSON matching the required schema.' });
  return content;
}

async function callApi(apiKey, body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (res.ok && data) require('./spend').record(data, body.model);   // what this answer cost (Settings > AI spending)
  return { res, data, msg: data && data.error ? data.error.message : `HTTP ${res.status}` };
}

// One structured-output request with automatic retries (schema too complex, rate limits, cut-off or invalid answers).
async function callStructured({ apiKey, model, system, content, schema, schemaNoEnum }) {
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings first.');
  let useEnum = true, maxTokens = 16000, out = null, lastProblem = '';
  for (let attempt = 0; attempt < 3 && !out; attempt++) {
    const b = {
      model, max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: useEnum ? schema : (schemaNoEnum || schema) } },
      messages: [{ role: 'user', content }],
    };
    const { res, data, msg } = await callApi(apiKey, b);
    if (res.status === 400 && useEnum && schemaNoEnum && /schema|grammar|complex|compil/i.test(msg)) { useEnum = false; continue; }
    if (res.status === 429 || res.status === 529 || res.status >= 500) { lastProblem = msg; await new Promise(r => setTimeout(r, 4000 * (attempt + 1))); continue; }
    if (!res.ok) {
      if (res.status === 401) throw new Error('The API key was rejected. Check it in Settings.');
      if (res.status === 404) throw new Error(`Model "${model}" was not found. Pick another model in Settings. (${msg})`);
      if (res.status === 400 && /credit|balance|billing/i.test(msg)) throw new Error(`Your Anthropic account needs credits: ${msg}`);
      throw new Error(`Claude request failed: ${msg}`);
    }
    if (data.stop_reason === 'refusal') throw new Error('Claude declined this request. Try rewording it.');
    if (data.stop_reason === 'max_tokens') { lastProblem = 'the answer was cut off'; maxTokens = 32000; continue; }
    const text = (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
    try { out = JSON.parse(text); } catch { lastProblem = 'the answer wasn’t valid JSON'; }
  }
  if (!out) throw new Error(`Claude couldn’t return a usable answer after three tries (${lastProblem || 'unknown problem'}). Try again in a minute.`);
  return out;
}

// settings rows in answers: enum casing isn't guaranteed
function normalizeSettings(list) {
  const lc = (v, ok, d) => { const x = String(v || '').toLowerCase(); return ok.includes(x) ? x : d; };
  for (const st of list || []) {
    st.action = lc(st.action, ['change', 'check'], 'check');
    st.priority = lc(st.priority, ['high', 'medium', 'low'], 'low');
    st.key = String(st.key || '').trim();
    if (!st.slot) st.slot = null;
  }
  return list || [];
}

async function analyzeWithClaude({ apiKey, model, ...rest }) {
  const plan = await callStructured({ apiKey, model, system: buildSystemPrompt(), content: buildUserContent(rest),
    schema: planSchema({ withKeyEnum: true }), schemaNoEnum: planSchema({ withKeyEnum: false }) });
  for (const r of plan.risks || []) r.severity = ['info', 'warn', 'critical'].includes(String(r.severity).toLowerCase()) ? String(r.severity).toLowerCase() : 'info';
  normalizeSettings(plan.settings);
  return plan;
}

// Merge recipe + Claude into rows the UI shows; fill current values from the base settings.
function buildRows(plan, recipeChanges, baseSettings) {
  const rows = new Map();
  const currentOf = (key, slot) => {
    const v = baseSettings[key];
    if (Array.isArray(v)) return v[slot ? slot - 1 : 0] ?? null;
    return v ?? null;
  };
  const add = (key, value, extra) => {
    const meta = BY_KEY[key];
    if (!meta) return false;
    const slot = meta.scope === 'filament' ? (Number(extra.slot) || 1) : null;
    const id = `${key}#${slot || 0}`;
    const current = currentOf(key, slot);
    const rec = normalize(key, value);
    rows.set(id, {
      id, key, label: meta.label, group: meta.group, scope: meta.scope, unit: meta.unit || '', gui: meta.gui, options: meta.options || null,
      slot, current: current == null ? null : String(current), recommended: rec,
      action: extra.action || 'change', priority: extra.priority || 'low', reason: extra.reason || '', source: extra.source,
      unchanged: current != null && String(current) === rec, invalid: validate(key, rec),
    });
    return true;
  };
  for (const c of recipeChanges) add(c.key, c.value, { source: 'recipe', reason: 'Part of the recipe for your slider position.', priority: 'low' });
  const unknown = [];
  for (const s of plan.settings || []) {
    if (!add(s.key, s.recommended, { ...s, source: 'claude' })) unknown.push(`Not a recognized Orca setting, so not applied: ${s.key} = ${s.recommended}${s.reason ? ` (${s.reason})` : ''}`);
  }
  return { rows: [...rows.values()], unknown };
}

module.exports = { callApi, analyzeWithClaude, buildSystemPrompt, buildUserContent, buildRows, sliderDescription, planSchema, callStructured, normalizeSettings, catalogText, PRINTER };
