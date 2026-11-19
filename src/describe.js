// Explains, in plain words, what a set of slicer settings means for the finished print: how it will look,
// how strong it will be, how overhangs come out and how much fine detail survives. Built from the settings
// that decide those things (not from AI), so it is free, instant and consistent.
const first = (v) => (Array.isArray(v) ? v[0] : v);
const num = (v, d = 0) => { const n = parseFloat(first(v)); return Number.isFinite(n) ? n : d; };
const pct = (v, d = 0) => num(String(first(v) ?? '').replace('%', ''), d);

// the facts that matter, from a settings object (project settings or a G-code config block)
function features(s) {
  const layer = num(s.layer_height, 0.2);
  const walls = num(s.wall_loops, 2);
  const infill = pct(s.sparse_infill_density, 15);
  const top = num(s.top_shell_layers, 4);
  const bottom = num(s.bottom_shell_layers, 3);
  const pattern = String(first(s.sparse_infill_pattern) || 'grid');
  const support = String(first(s.enable_support)) === '1';
  const supportType = String(first(s.support_type) || '');
  const outerSpeed = num(s.outer_wall_speed, 200);
  const ironing = !/no ironing|none|^$/i.test(String(first(s.ironing_type) || 'no ironing'));
  const fuzzy = !/none|^$/i.test(String(first(s.fuzzy_skin) || 'none'));
  const variableLayers = String(first(s.adaptive_layer_height)) === '1';
  return { layer, walls, infill, top, bottom, pattern, support, supportType, outerSpeed, ironing, fuzzy, variableLayers };
}

// layer height decides how visible the lines are; 0.2 mm is the everyday standard
const LOOK = [
  [0.1, 5, 'Very smooth. Layer lines are hard to see even up close, and curves look round.'],
  [0.16, 4, 'Smooth. Layer lines are faint, visible mostly on gentle slopes and up close.'],
  [0.2, 3, 'Standard. Fine layer lines you can see and feel up close; looks clean from arm’s length.'],
  [0.24, 2, 'Visible layer lines, and slight “stair steps” on curved or sloped tops.'],
  [Infinity, 1, 'Clearly visible layer lines and stair-stepping on curves. Fine for practical parts, less so for display pieces.'],
];

function strengthScore(f) {
  // walls carry most of the load in typical parts; infill and solid layers add stiffness
  const strongPattern = /gyroid|cubic|honeycomb|adaptivecubic|3dhoneycomb|triangles|grid/i.test(f.pattern) ? 1 : 0.85;
  return f.walls * 1.0 + (f.infill / 100) * 6 * strongPattern + Math.min(f.top, 8) * 0.12 + Math.min(f.bottom, 8) * 0.08;
}

function describe(settings, original = null) {
  const f = features(settings);
  const o = original ? features(original) : null;
  const out = [];
  // look
  const [, lookScore, lookText] = LOOK.find(([max]) => f.layer <= max);
  let lookCmp = '';
  if (o) {
    const d = f.layer - o.layer;
    lookCmp = Math.abs(d) < 0.01 ? 'Same surface finish as the original.' : d < 0 ? 'Smoother than the original.' : 'More visible layer lines than the original.';
  }
  const extras = [];
  if (f.ironing) extras.push('flat tops are ironed smooth');
  if (f.fuzzy) extras.push('outer walls get an intentionally rough, textured skin');
  if (f.variableLayers) extras.push('layer height varies, finer on curved areas');
  if (f.outerSpeed <= 120) extras.push('outer walls print slowly for a cleaner surface');
  out.push({ id: 'look', title: 'How it looks', score: lookScore, text: `${lookText}${extras.length ? ` Also: ${extras.join('; ')}.` : ''}`, compare: lookCmp, detail: `${f.layer} mm layers` });

  // strength
  const s = strengthScore(f);
  // calibrated so everyday defaults (2 walls, 15% infill) land in the middle: Normal
  const sScore = s < 2.6 ? 1 : s < 3.3 ? 2 : s < 4.6 ? 3 : s < 6 ? 4 : 5;
  const sText = [
    'Light duty. Fine for decorative pieces; may crack or flex under load.',
    'Light-to-normal duty. Good for most decorative and everyday items.',
    'Normal strength. Good for everyday items and light functional parts.',
    'Strong. Good for functional parts like brackets, hooks and tools.',
    'Very strong and stiff. For parts that carry real load, at the cost of time and filament.',
  ][sScore - 1];
  let sCmp = '';
  if (o) {
    const r = s / strengthScore(o);
    sCmp = r > 1.08 ? `About ${Math.round((r - 1) * 100)}% stronger than the original.` : r < 0.92 ? `About ${Math.round((1 - r) * 100)}% weaker than the original.` : 'About the same strength as the original.';
  }
  out.push({ id: 'strength', title: 'How strong', score: sScore, text: sText, compare: sCmp, detail: `${f.walls} walls, ${f.infill}% ${f.pattern} infill, ${f.top} top / ${f.bottom} bottom layers` });

  // overhangs and supports
  const sup = f.support
    ? `Supports hold up parts printed over thin air, so overhangs come out clean. You’ll peel the supports off after printing, which can leave small marks underneath${/tree/i.test(f.supportType) ? ' (tree supports touch less of the part and usually peel off cleanly)' : ''}.`
    : 'No supports. Nothing to remove afterwards, but steep overhangs (parts printed over thin air) can droop or get stringy underneath.';
  let supCmp = '';
  if (o && f.support !== o.support) supCmp = f.support ? 'Adds supports the original didn’t have.' : 'Removes the original’s supports.';
  out.push({ id: 'overhangs', title: 'Overhangs and supports', score: null, text: sup, compare: supCmp, detail: f.support ? `supports on${f.supportType ? ` (${f.supportType})` : ''}` : 'supports off' });

  // fine detail
  const detailText = f.layer <= 0.12 ? 'Small details, text and sharp edges come out crisp.'
    : f.layer <= 0.2 ? 'Most details print well; very small text or tiny features may soften.'
    : 'Small details and text soften; best for larger, simpler shapes.';
  let dCmp = '';
  if (o) { const d = f.layer - o.layer; dCmp = Math.abs(d) < 0.01 ? '' : d < 0 ? 'Sharper detail than the original.' : 'Softer detail than the original.'; }
  out.push({ id: 'detail', title: 'Fine detail', score: f.layer <= 0.12 ? 5 : f.layer <= 0.16 ? 4 : f.layer <= 0.2 ? 3 : 2, text: detailText, compare: dCmp, detail: '' });
  return out;
}

module.exports = { describe, features };
