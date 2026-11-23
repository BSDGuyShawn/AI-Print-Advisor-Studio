// Spool tags (NFC/RFID): turning a scanned tag into something the inventory understands.
// Pure helpers with no page state, shared by inventory.js (as window.SpoolTags) and the tests (test/tags.test.js).
//
// A scan from the app (src/nfc.js) looks like:
//   { status:'decoded'|'unrecognized'|'read_error', decoder:'bambu', spoolId:'bambu:<tray uid>' or 'uid:<tag uid>',
//     tag:{ uid, type }, filament:{ manufacturer, material, modifiers[], colorHex, colorsHex[], weightG, diameterMm,
//     nozzleMin, nozzleMax, bed, dryTemp, dryHours, made } | null, extras:{ materialId, … } | null }
// spoolId is what a spool remembers (spool.tags). Both tags on a Bambu Lab spool share one spoolId.
(function (root) {
  // the names stores and this library use for brands whose tags say something shorter
  const BRAND_ALIASES = { 'bambu': 'Bambu Lab', 'bambulab': 'Bambu Lab', 'bambu lab': 'Bambu Lab', 'snapmaker': 'Snapmaker',
    'creality': 'Creality', 'elegoo': 'ELEGOO', 'qidi': 'QIDI', 'anycubic': 'Anycubic', 'polymaker': 'Polymaker', 'sunlu': 'SUNLU' };
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const brandName = (b) => BRAND_ALIASES[norm(b)] || String(b || '').trim();
  const sameBrand = (a, b) => norm(brandName(a)).replace(/ /g, '') === norm(brandName(b)).replace(/ /g, '');

  function typeFrom(material, modifiers, types) {
    const m = String(material || '').toUpperCase().replace(/\s+/g, '');
    const mods = (modifiers || []).map(x => String(x).toUpperCase());
    let t = m;
    if (/^PA|NYLON/.test(m)) t = 'Nylon';
    else if (mods.includes('CF') && !m.endsWith('-CF')) t = `${m}-CF`;
    return types.includes(t) ? t : (types.includes(m) ? m : 'Other');
  }

  const FINISH_WORDS = [[/matte/i, 'Matte'], [/silk/i, 'Silk'], [/translucent|transparent|clear/i, 'Translucent'],
    [/metal/i, 'Metallic'], [/galaxy|sparkle|glitter/i, 'Galaxy'], [/wood/i, 'Wood'], [/carbon|\bcf\b/i, 'Carbon Fiber'],
    [/gradient|rainbow|dual|tri/i, 'Gradient'], [/color ?change|chameleon/i, 'Color Change']];
  function finishFrom(words) {
    const text = (words || []).join(' ');
    for (const [re, f] of FINISH_WORDS) if (re.test(text)) return f;
    return 'Standard';
  }

  function rgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // a rough perceptual distance (weighted RGB): good enough to tell "the same orange" from "a different orange"
  function hexDistance(a, b) {
    const x = rgb(Array.isArray(a) ? a[0] : a), y = rgb(Array.isArray(b) ? b[0] : b);
    if (!x || !y) return Infinity;
    const rm = (x[0] + y[0]) / 2, dr = x[0] - y[0], dg = x[1] - y[1], db = x[2] - y[2];
    return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
  }
  // The library's color group for a color (Red, Orange, … White, Grey, Black)
  function familyOf(hex) {
    const c = rgb(hex);
    if (!c) return 'Multicolor';
    const [r, g, b] = c.map(v => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (s < 0.15 || d < 0.08) return l > 0.85 ? 'White' : l < 0.18 ? 'Black' : 'Grey';
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    if (h < 15 || h >= 345) return l > 0.75 ? 'Pink' : 'Red';
    if (h < 45) return l < 0.35 ? 'Brown' : (s < 0.45 && l > 0.6 ? 'Beige' : 'Orange');
    if (h < 66) return l < 0.3 ? 'Brown' : 'Yellow';
    if (h < 165) return 'Green';
    if (h < 195) return 'Teal';
    if (h < 255) return 'Blue';
    if (h < 290) return 'Purple';
    return 'Pink';
  }

  // What a new filament record would look like, from a decoded tag (the user checks it before it's added)
  function draftFromTag(scan, types) {
    const f = scan && scan.filament;
    if (!f) return null;
    const mods = f.modifiers || [];
    const hex = (f.colorsHex && f.colorsHex.length > 1) ? f.colorsHex : (f.colorHex || '#888888');
    const fam = familyOf(Array.isArray(hex) ? hex[0] : hex);
    const words = [...mods, (scan.extras && scan.extras.detailedType) || ''];
    const type = typeFrom(f.material, mods, types);
    const deg = (a, b) => (a && b && a !== b ? `${a}–${b}` : (a || b ? String(a || b) : ''));
    return {
      brand: brandName(f.manufacturer),
      type,
      line: mods.filter(m => !/^cf$/i.test(m)).join(' ') || type,
      finish: finishFrom(words),
      color: '',                       // tags don't carry a color name: the user names it
      colorGuess: Array.isArray(hex) ? 'Multicolor' : fam,
      fams: Array.isArray(hex) ? ['Multicolor'] : [fam],
      hex,
      grams: f.weightG > 0 ? Math.round(f.weightG) : 1000,
      nozzle: deg(f.nozzleMin, f.nozzleMax),
      bed: f.bed ? String(f.bed) : '',
      dry: f.dryTemp ? `${f.dryTemp} °C${f.dryHours ? ` · ${f.dryHours} h` : ''}` : '',
    };
  }

  // The filament in the library this tag most likely is: same brand and type, closest color, same size preferred.
  // Returns { filament, distance } or null when nothing is close enough to suggest.
  function matchFilament(draft, filaments, maxDistance = 90) {
    if (!draft) return null;
    let best = null;
    for (const f of filaments) {
      if (!sameBrand(f.brand, draft.brand) || f.type !== draft.type) continue;
      let d = hexDistance(f.hex, draft.hex);
      if (f.finish !== draft.finish) d += 40;
      if (+f.grams !== +draft.grams) d += 25;
      if (norm(f.line) !== norm(draft.line)) d += 15;
      if (!best || d < best.distance) best = { filament: f, distance: d };
    }
    return best && best.distance <= maxDistance ? best : null;
  }

  // The spool this tag was linked to, if any
  function spoolForTag(spools, spoolId) {
    if (!spoolId) return null;
    for (const s of Object.values(spools || {})) if (Array.isArray(s.tags) && s.tags.includes(spoolId)) return s;
    return null;
  }

  // Short label for a tag in the spool's history and lists
  function tagLabel(spoolId) {
    const [kind, id] = String(spoolId || '').split(':');
    if (!id) return spoolId || '';
    return kind === 'bambu' ? `Bambu Lab spool ${id.slice(0, 8)}…` : `tag ${id}`;
  }

  const api = { brandName, sameBrand, typeFrom, finishFrom, hexDistance, familyOf, draftFromTag, matchFilament, spoolForTag, tagLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpoolTags = api;
})(typeof window !== 'undefined' ? window : globalThis);
