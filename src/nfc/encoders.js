// Writing your own filament to a blank NFC sticker (NTAG213/215/216) in an open format other tools can read:
//   OpenSpool  (openspool.io): a small JSON record (about 150-250 bytes). The most widely read open format.
//   OpenTag3D  (opentag3d.info): a 224-byte binary record with the color name, weight, density and more.
// Both need an NTAG215 or NTAG216 sticker: an NTAG213 holds only 144 bytes.
// The app reads both back (decoders.js), and a written tag is linked to your spool by the tag's own ID.
// Bambu Lab and Snapmaker tags can't be made: those are signed by the manufacturer.
'use strict';

const { message, uriPayload } = require('./ndef');
const { OT3D, OT3D_MIME, OT3D_VERSION } = require('./decoders');
const VALID = new Set(require('./data/brands.json').validMaterials);

// The app's material names -> the names other readers expect
const TYPE_ALIASES = { NYLON: 'PA', 'PA-CF': 'PA-CF', 'PLA+': 'PLA', 'PETG+': 'PETG' };
// Typical densities (g/cm³), for OpenTag3D's required density field
const DENSITY = { PLA: 1.24, 'PLA-CF': 1.29, PETG: 1.27, 'PETG-CF': 1.3, PCTG: 1.23, ABS: 1.04, ASA: 1.07, TPU: 1.21, PA: 1.14, 'PA-CF': 1.2, PC: 1.2, PVA: 1.23, HIPS: 1.04 };

function materialOf(type) {
  const t = String(type || '').trim().toUpperCase().replace(/\s+/g, '');
  const m = TYPE_ALIASES[t] || t;
  if (!VALID.has(m)) throw new Error(`Set this filament’s material type first: “${type || 'Other'}” isn’t a material other NFC readers know.`);
  return m;
}
const hex6 = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || ''));
  if (!m) throw new Error('This filament has no swatch color to write.');
  return m[1].toUpperCase();
};
const clampTemp = (v) => (Number.isFinite(+v) && +v > 0 && +v < 500 ? Math.round(+v) : null);
// UTF-8 bytes, cut to fit without splitting a character
function utf8Fit(s, max) {
  let b = Buffer.from(String(s || ''), 'utf8');
  while (b.length > max) { s = String(s).slice(0, -1); b = Buffer.from(s, 'utf8'); }
  return b;
}

// What gets written, from the app's filament: { brand, type, subtype, colorName, hex, hex2?, weight, diameter,
// nozzleMin, nozzleMax, bedMin?, bedMax?, dryTemp?, dryHours? }. Checks it before anything touches a tag.
function normalize(f) {
  const nozzleMin = clampTemp(f.nozzleMin), nozzleMax = clampTemp(f.nozzleMax) ?? nozzleMin;
  if (!nozzleMin || !nozzleMax) throw new Error('Add this filament’s nozzle temperature first (on its card).');
  return {
    brand: String(f.brand || 'Generic').trim().slice(0, 40) || 'Generic',
    type: materialOf(f.type),
    subtype: String(f.subtype || '').trim().slice(0, 40),
    colorName: String(f.colorName || '').trim(),
    hex: hex6(f.hex),
    hex2: f.hex2 ? hex6(f.hex2) : null,
    weight: Math.round(+f.weight) > 0 ? Math.min(65535, Math.round(+f.weight)) : 1000,
    diameter: +f.diameter > 0 ? +f.diameter : 1.75,
    nozzleMin: Math.min(nozzleMin, nozzleMax), nozzleMax: Math.max(nozzleMin, nozzleMax),
    bedMin: clampTemp(f.bedMin), bedMax: clampTemp(f.bedMax) ?? clampTemp(f.bedMin),
    dryTemp: clampTemp(f.dryTemp), dryHours: Number.isFinite(+f.dryHours) && +f.dryHours > 0 ? Math.min(255, Math.round(+f.dryHours)) : null,
    link: typeof f.link === 'string' && /^https?:\/\/[^\s]{1,150}$/.test(f.link) ? f.link : null,
  };
}

// OpenSpool JSON records, fullest first: optional fields are dropped (least useful last) until it fits the sticker.
function openSpool(f) {
  const j = { protocol: 'openspool', version: '1.0', type: f.type, color_hex: f.hex, brand: f.brand,
    min_temp: String(f.nozzleMin), max_temp: String(f.nozzleMax) };
  const optional = [
    ['subtype', f.subtype], ['weight', String(f.weight)], ['diameter', String(f.diameter)],
    ['bed_min_temp', f.bedMin ? String(f.bedMin) : ''], ['bed_max_temp', f.bedMax ? String(f.bedMax) : ''],
  ].filter(([, v]) => v);
  const out = [];
  for (let n = optional.length; n >= 0; n--) out.push({ tnf: 2, type: 'application/json', payload: Buffer.from(JSON.stringify({ ...j, ...Object.fromEntries(optional.slice(0, n)) }), 'utf8') });
  return out;
}

// OpenTag3D binary record, laid out by the official schema (same file the reader uses)
function openTag3D(f) {
  const payload = Buffer.alloc(parseInt(OT3D.core.address_range.end, 16) + 1);
  const field = Object.fromEntries(OT3D.core.fields.map(x => [x.id, x]));
  const putInt = (id, value) => {
    const x = field[id]; if (value == null) return;
    let n = Math.round(value / (x.scaling ?? 1));
    n = Math.max(0, Math.min(2 ** (8 * x.length) - 1, n));
    for (let i = x.length - 1; i >= 0; i--) { payload[parseInt(x.start, 16) + i] = n % 256; n = Math.floor(n / 256); }
  };
  const putStr = (id, s) => { const x = field[id]; utf8Fit(s, x.length).copy(payload, parseInt(x.start, 16)); };
  const putRgba = (id, hex) => { if (!hex) return; const x = field[id]; Buffer.from(hex + 'FF', 'hex').copy(payload, parseInt(x.start, 16)); };
  putInt('tag_version', OT3D_VERSION / 1000);
  const [base, ...mods] = f.type.split('-');
  putStr('material', base);
  putStr('material_mod', mods.join('-') || f.subtype);
  putStr('manufacturer', f.brand);
  putStr('color_name', f.colorName);
  putRgba('color_1', f.hex);
  putRgba('color_2', f.hex2);
  putInt('diameter', f.diameter);
  putInt('print_temp', Math.round((f.nozzleMin + f.nozzleMax) / 2 / 5) * 5);
  putInt('min_print_temp', f.nozzleMin);
  putInt('max_print_temp', f.nozzleMax);
  putInt('bed_temp', f.bedMax || f.bedMin || 0);
  putInt('min_bed_temp', f.bedMin);
  putInt('max_bed_temp', f.bedMax);
  putInt('max_dry_temp', f.dryTemp);
  putInt('dry_time', f.dryHours);
  putInt('density', DENSITY[f.type] || 1.24);
  putInt('weight', f.weight);
  return [{ tnf: 2, type: OT3D_MIME, payload }];
}

const FORMATS = { openspool: openSpool, opentag3d: openTag3D };
// The NDEF message (TLV, from page 4) to write. capacity = the sticker's data area in bytes (from its CC; 0 = no limit).
// With a link (phone access on), its URI record goes first, so tapping the sticker with a phone opens the spool's
// page (phones open the first record); readers of OpenSpool/OpenTag3D look through all the records. If the
// filament's details don't fit next to the link, the sticker gets the link alone (result.linkOnly).
function encodeTag(format, filament, capacity) {
  const f = normalize(filament);
  const fits = (m) => !capacity || m.length <= capacity;
  const link = f.link ? { tnf: 1, type: 'U', payload: uriPayload(f.link) } : null;
  for (const rec of (FORMATS[format] || openSpool)(f)) {
    const m = message(link ? [link, rec] : [rec]);
    if (fits(m)) return m;
  }
  if (link) {
    const m = message([link]);
    if (fits(m)) return Object.assign(m, { linkOnly: true });
  }
  throw new Error(format === 'opentag3d' ? 'An OpenTag3D record needs an NTAG215 or NTAG216 sticker. Use one of those, or switch to OpenSpool in Settings.'
    : 'This sticker is too small for the filament’s details. Use an NTAG215 or NTAG216.');
}

module.exports = { encodeTag, normalize, FORMATS: Object.keys(FORMATS) };
