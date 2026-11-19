// A short, speakable "print name" for a model ("White Voronoi Cat"), used for saved files and for the file name
// on the printer, which voice assistants read out in announcements. Downloaded files are often named with URL
// encoding, emoji and other languages ("Baby+Katze+–+dekoratives+Voronoi-Design+🖤🐾+Pfote+hoch").
const { callStructured } = require('./claude');

const COLORS = [
  ['White', [245, 245, 245]], ['Black', [20, 20, 20]], ['Gray', [128, 128, 128]], ['Silver', [192, 192, 192]],
  ['Red', [200, 30, 30]], ['Orange', [240, 130, 30]], ['Yellow', [240, 220, 40]], ['Green', [40, 160, 60]],
  ['Teal', [30, 140, 140]], ['Blue', [40, 80, 200]], ['Purple', [130, 60, 180]], ['Pink', [240, 140, 180]],
  ['Brown', [120, 75, 40]], ['Beige', [225, 210, 180]], ['Gold', [212, 175, 55]],
];
function colorName(hex) {
  const m = /^#?([0-9a-f]{6})/i.exec(String(hex || ''));
  if (!m) return null;
  const v = parseInt(m[1], 16), rgb = [v >> 16 & 255, v >> 8 & 255, v & 255];
  let best = null, bd = Infinity;
  for (const [n, c] of COLORS) { const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2; if (d < bd) { bd = d; best = n; } }
  return best;
}

// letters, digits, spaces and hyphens only; words in Title Case; at most 6 words / 48 characters
function tidy(s) {
  const words = String(s || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')            // é → e
    .replace(/ß/g, 'ss').replace(/[æÆ]/g, 'ae').replace(/[øØ]/g, 'o')
    .replace(/[^A-Za-z0-9\s-]+/g, ' ')                               // emoji, symbols, punctuation
    .replace(/\s*-\s*/g, ' ').trim().split(/\s+/).filter(Boolean)
    .map(w => (/^[A-Z0-9]{2,5}$/.test(w) ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()));
  let out = '';
  for (const w of words.slice(0, 6)) { if ((out + ' ' + w).trim().length > 48) break; out = (out + ' ' + w).trim(); }
  return out;
}

// No AI: clean up the file name itself.
function heuristicName(fileName) {
  let s = String(fileName || '').replace(/\.(3mf|gcode|stl|step)$/i, '');
  try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch { s = s.replace(/\+/g, ' '); }
  s = s.replace(/[_]+/g, ' ').replace(/\s*\((advisor[^)]*|\d+)\)\s*$/i, '').replace(/_plate_\d+$/i, '');
  // tags from model-sharing sites that mean nothing when spoken
  s = s.replace(/\b(no[\s-]?ams|ams|multi[\s-]?colou?r|single[\s-]?colou?r|remix|updated|final|v\d+(\.\d+)*|3mf|stl|print[\s-]?ready)\b/gi, ' ');
  return tidy(s) || 'My Print';
}

function valid(name) {
  const n = tidy(name);
  const words = n.split(' ').filter(Boolean);
  return words.length >= 1 && words.length <= 6 && n.length >= 3 ? n : null;
}

// With AI: a brief descriptive English name from the file name, part names, main color and a picture.
async function aiName({ apiKey, fileName, objectNames = [], mainColor = null, image = null }) {
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } });
  content.push({ type: 'text', text: JSON.stringify({ fileName, objectNames: objectNames.slice(0, 12), mainFilamentColor: colorName(mainColor) }) });
  const out = await callStructured({
    apiKey, model: 'claude-haiku-5-5',
    system: 'You name 3D prints so a voice assistant can announce them clearly ("Your White Voronoi Cat has finished printing"). Reply with a short descriptive English name of 2 to 4 words in Title Case: what the object is, optionally a defining style word, and the main filament color first when known (e.g. "White Voronoi Cat", "Red Garden Mushroom", "Black Phone Stand"). Translate non-English names. No emoji, symbols, numbers, file extensions, version words or brand names.',
    content, schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  });
  return valid(out && out.name);
}

module.exports = { heuristicName, aiName, colorName, tidy };
