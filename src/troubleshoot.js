// "Print Issue Troubleshooter": Claude diagnoses a failed or flawed print from the settings that were actually
// printed (the G-code's config block), what the printer was doing where it failed (G-code window for the
// painted region), the user's description and photos, and the model's geometry.
const { CATALOG } = require('./orca-settings');
const { callStructured, normalizeSettings, catalogText, PRINTER } = require('./claude');
const { FIT_RULE } = require('./fit');

const ISSUES = [
  'Spaghetti / came loose', 'Warping or lifting corners', 'Poor first layer', 'Stringing or blobs', 'Drooping overhangs',
  'Support problems', 'Layer shift', 'Layer separation / cracks', 'Under-extrusion / gaps', 'Over-extrusion / rough walls',
  'Elephant foot', 'Rough or pillowed top', 'Zits or seam marks', 'Color / toolhead change problems', 'Dimensions off', 'Other',
];

function schema(withKeyEnum) {
  const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const str = (description) => ({ type: 'string', description });
  return obj({
    summary: str('2-3 sentences: what went wrong, where, and the single most likely reason.'),
    causes: {
      type: 'array', description: 'Likely causes, most likely first. 1-5 entries.',
      items: obj({
        cause: str('Short name of the cause.'),
        likelihood: { type: 'string', enum: ['high', 'medium', 'low'] },
        evidence: str('What in the G-code, settings, geometry, photos or description points to this. Quote real numbers.'),
        kind: { type: 'string', enum: ['settings', 'model/orientation', 'material', 'printer/hardware'] },
      }),
    },
    settings: {
      type: 'array', description: 'Setting changes for the next print, relative to the settings actually printed.',
      items: obj({
        key: withKeyEnum ? { type: 'string', enum: CATALOG.map(c => c.key) } : str('One of the allowed setting keys, exactly as listed.'),
        recommended: str('Value in Orca config format.'),
        slot: { type: 'integer', description: 'Filament keys: 1-based toolhead (1-4). Process keys: 0.' },
        action: { type: 'string', enum: ['change', 'check'] },
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        reason: str('Why this fixes the problem in the failed area. One or two sentences.'),
      }),
    },
    physical_checks: { type: 'array', items: { type: 'string' }, description: 'Things to check or do at the printer or with the filament (clean the plate, dry the spool, check the nozzle wipe, etc.). Empty array if none.' },
    orientation: str('Orientation or model change that would avoid the problem, or an empty string.'),
    questions: { type: 'array', items: { type: 'string' }, description: 'Up to 3 short questions whose answers would change the diagnosis. Empty array if confident.' },
  });
}

function systemPrompt({ compact = false } = {}) {
  return `You are an expert 3D-printing failure analyst helping a hobbyist fix a print on a ${PRINTER.name}.

Printer facts:
${PRINTER.facts.map(f => `- ${f}`).join('\n')}

You get: the issue types the user picked and their description; optionally photos of the print; where on the part it failed (painted on the 3D model or picked on a plate map), translated into a height range, the affected object, the face direction, and how much of that area is overhang; what the printer was doing in that region from the actual G-code (features, speeds, volumetric flow, fan, nozzle and bed temperatures, toolheads, retractions, tool changes, layer heights); the settings that were actually printed; job facts (finished, cancelled or failed, duration vs estimate); and previous diagnoses of the same model.

How to diagnose:
- Work from evidence. Cite the numbers you rely on (e.g. "outer wall ran at 200 mm/s and 12 mm³/s at 23-26 mm"). The region data and photos outweigh generic advice.
- Separate causes: slicer settings, model/orientation, material (wet PETG strings and pops; PLA softens with too little cooling; PETG and PLA don't bond to each other), and printer/hardware (dirty plate, nozzle clog, loose belt for layer shifts). Don't blame settings for a hardware problem.
- Height matters: failures in the first ~1 mm are adhesion/first layer; mid-height failures on tall thin parts are often wobble or nozzle strikes; failures at an overhang height are cooling/support.
- U1 specifics: four independent toolheads, no purge. Idle heads sit at standby temperature and can ooze or drag strings onto the part; the prime tower and ooze prevention help; standby_temperature_delta lowers idle temperature. A cancelled job early on with a "came loose" description usually means bed adhesion.
- Recommend only settings that address this failure, using exactly the listed keys with valid values. Filament keys need slot 1-4 (the toolhead used in the failed region); process keys use slot 0.
- Physical checks are often the real fix: say so plainly when they are.
- If something essential is unknown, ask up to 3 short questions, but still give your best diagnosis.
- Write for a newcomer: concrete and short.

${FIT_RULE}

Keep print time reasonable: unless the slider is at the quality end or the stated purpose needs real strength, avoid changes that together more than double the print time. Heavy infill or many extra solid layers rarely help decorative pieces or snap-fit parts; say so instead of adding them.

Allowed settings${compact ? '' : ' (curated ones first)'}:
${catalogText({ curatedOnly: compact })}`;
}

function buildContent(p) {
  const payload = {
    issue: { types: p.issueTypes, description: p.description || '(none given)' },
    partsFitTogether: !!p.assembly,
    failedRegion: p.region || 'not marked',
    gcodeInFailedRegion: p.regionGcode || 'not available',
    wholePrint: p.wholePrint || 'not available',
    job: p.job,
    settingsPrinted: p.settings || 'not available (G-code could not be read from the printer)',
    modelGeometry: p.geometry || 'model not loaded',
    previousDiagnoses: p.previous && p.previous.length ? p.previous : 'none',
  };
  const content = [];
  for (const img of p.images || []) {
    content.push({ type: 'text', text: `Image: ${img.label}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
  }
  content.push({ type: 'text', text: 'Print problem to diagnose:\n```json\n' + JSON.stringify(payload, null, 1) + '\n```\nReturn your diagnosis as JSON matching the required schema.' });
  return content;
}

async function troubleshoot({ apiKey, model, ...p }) {
  const out = await callStructured({ apiKey, model, system: systemPrompt(), content: buildContent(p), schema: schema(true), schemaNoEnum: schema(false) });
  for (const c of out.causes || []) c.likelihood = ['high', 'medium', 'low'].includes(String(c.likelihood).toLowerCase()) ? String(c.likelihood).toLowerCase() : 'medium';
  normalizeSettings(out.settings);
  return out;
}

module.exports = { troubleshoot, ISSUES, schema, systemPrompt, buildContent };
