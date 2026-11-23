// Spool tag decoders: turn the memory read from a filament spool's NFC/RFID tag into filament details.
//
// A JavaScript port of the brand decoders in OpenRFID by suchmememanyskill (https://github.com/suchmememanyskill/OpenRFID,
// GPL-3.0, commit a13bc9e), which the first version of this feature ran as a Python program. Same results, checked
// against the same real tag dumps (test/fixtures/tags, test/nfc-decoders.test.js). The lookup tables are in
// ./data (generated from OpenRFID's constants; the OpenTag3D schema is the official spec.json, unchanged).
//
// MIFARE Classic tags (Bambu Lab, Snapmaker, Creality, QIDI) are locked with per-tag keys worked out from the tag's
// ID: classicKeys() gives each brand's keys, the reader logs in with them and reads all 16 sectors, then
// decodeClassic() parses the 1 KB dump. NTAG/Ultralight tags (OpenSpool, OpenTag3D, SpoolEase, TigerTag, Anycubic,
// ELEGOO) are read whole and decodeUltralight() tries each format.
//
// Each decode returns { decoder, filament, extras, spoolId } with filament in the shape the app's src/nfc.js expects
// (snake_case, as the Python program printed it), or null when the data isn't that brand's.
'use strict';

const crypto = require('crypto');
const BR = require('./data/brands.json');
const TT = require('./data/tigertag.json');
const OT3D = require('./data/opentag3d-v2.json');
const { parseNdef, uriOf } = require('./ndef');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
// Publicly documented keys (Bambu: Bambu-Research-Group/RFID-Tag-Guide; Creality: the CFS research; Snapmaker:
// OpenRFID). Each is checked against OpenRFID's hash, so a typo fails loudly instead of silently not reading.
function checkedKey(hex, hash) {
  const b = Buffer.from(hex, 'hex');
  if (sha256(b) !== hash) throw new Error('spool tag key check failed');
  return b;
}
const KEYS = {
  bambu: checkedKey('9a759cf2c4f7caff222cb9769b41bc96', BR.keyHashes.bambu),
  creality: checkedKey('713362755e74316e71665a2870662431', BR.keyHashes.creality),
  crealityEnc: checkedKey('484043466b526e7a404b4174424a7032', BR.keyHashes.crealityEnc),
  snapmaker: checkedKey('536e61706d616b65725f71776572747975696f705b2c2e3b5d5f317132773365', BR.keyHashes.snapmaker),
};
const VALID = new Set(BR.validMaterials);
const FF6 = Buffer.alloc(6, 0xFF), ZERO6 = Buffer.alloc(6);
const SNAP_RSA = Object.fromEntries(Object.entries(BR.snapmaker.rsaKeys)
  .map(([v, b64]) => [v, crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' })]));

// ---------------------------------------------------------------- helpers
// The product id is OpenRFID's: a hash of the values joined the way Python prints them (so ids match its output)
const pyFloat = (n) => (Number.isInteger(n) ? `${n}.0` : String(n));
const productId = (...args) => sha256(Buffer.from(args.map(String).join('|'), 'utf8'));
const asciiStr = (d, pos, len) => Buffer.from(d.subarray(pos, pos + len)).toString('latin1').replace(/[^\x00-\x7f]/g, '').replace(/\0+$/, '');
function strictAscii(buf) {              // Python's bytes.decode('ASCII'): fails on anything else
  for (const c of buf) if (c > 0x7f) throw new Error('not ASCII');
  return Buffer.from(buf).toString('latin1');
}
function pyInt(s, base = 10) {           // Python's int(str, base): the whole string must be a number
  const t = String(s).trim();
  const ok = base === 16 ? /^[+-]?[0-9a-f]+$/i.test(t) : /^[+-]?\d+$/.test(t);
  if (!ok) throw new Error(`invalid number ${s}`);
  return parseInt(t, base);
}
const argb = (a, r, g, b) => ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
const hex6 = (n) => '#' + (n & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
const rgbaHex = (n) => (((n & 0xFFFFFF) << 8 | (n >>> 24)) >>> 0).toString(16).toUpperCase().padStart(8, '0');

// OpenRFID's GenericFilament: CF/GF modifiers become part of the material ("PLA" + "CF" -> "PLA-CF")
function filament(o) {
  let type = o.type;
  const modifiers = [...(o.modifiers || [])];
  for (const x of ['CF', 'GF']) { const i = modifiers.indexOf(x); if (i >= 0) { type += `-${x}`; modifiers.splice(i, 1); } }
  if (!VALID.has(type)) throw new Error(`unknown material ${type}`);   // as OpenRFID: also rejects garbage reads
  const colors = (o.colors || []).map(c => c >>> 0);
  return {
    manufacturer: o.manufacturer,
    material: type,
    modifiers,
    name: [o.manufacturer, type, ...modifiers].join(' ').trim(),
    color_hex: colors.length ? hex6(colors[0]) : null,
    colors_hex: colors.map(hex6),
    colors_rgba_hex: colors.map(rgbaHex),
    diameter_mm: Math.round(Number(o.diameter) * 1000) / 1000,
    weight_g: o.weight,
    nozzle_temp_min_c: o.nozzleMin,
    nozzle_temp_max_c: o.nozzleMax,
    bed_temp_c: o.bed,
    drying_temp_c: o.dryTemp,
    drying_time_h: o.dryHours,
    manufacturing_date: o.made,
    td_mm: o.td || null,
    product_id: o.id,
  };
}

// ---------------------------------------------------------------- MIFARE Classic: keys
// HKDF-SHA256 (RFC 5869) with a 6-byte key per sector
function bambuKeys(uid) {
  const okm = Buffer.from(crypto.hkdfSync('sha256', uid.subarray(0, 4), KEYS.bambu, Buffer.from('RFID-A\0'), 96));
  return { a: [...Array(16)].map((_, i) => okm.subarray(i * 6, i * 6 + 6)), b: Array(16).fill(ZERO6) };
}
function snapmakerKeys(uid) {
  const derive = (salt, kind) => {
    if (salt[salt.length - 1] === 0) salt = salt.subarray(0, -1);
    const prk = crypto.createHmac('sha256', salt).update(uid.subarray(0, 4)).digest();
    return [...Array(16)].map((_, i) => crypto.createHmac('sha256', prk)
      .update(Buffer.concat([Buffer.from(`key_${kind}_${i}`), Buffer.from([1])])).digest().subarray(0, 6));
  };
  return { a: derive(KEYS.snapmaker.subarray(0, 25), 'a'), b: derive(KEYS.snapmaker, 'b') };
}
function aes(key, data, encrypt) {
  const c = (encrypt ? crypto.createCipheriv : crypto.createDecipheriv)('aes-128-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}
function crealityKeys(uid) {
  if (uid.length !== 4) return null;
  const a = Array(16).fill(FF6);
  a[1] = aes(KEYS.creality, Buffer.concat([uid, uid, uid, uid]), true).subarray(0, 6);
  return { a, b: Array(16).fill(FF6) };
}
const defaultKeys = () => ({ a: Array(16).fill(FF6), b: Array(16).fill(FF6) });

// The brands to try on a MIFARE Classic tag, in order. QIDI (factory-default keys) goes last so it doesn't claim
// keyed tags. Each: { name, keys: {a: [16 x 6 bytes], b: [...]} }.
function classicKeys(uid) {
  return [['bambu', bambuKeys(uid)], ['snapmaker', snapmakerKeys(uid)], ['creality', crealityKeys(uid)], ['qidi', defaultKeys()]]
    .filter(([, k]) => k).map(([name, keys]) => ({ name, keys }));
}

// ---------------------------------------------------------------- MIFARE Classic: decoders (1024-byte dumps)
function bambu(d) {
  const type = asciiStr(d, 32, 16), detailed = asciiStr(d, 64, 16);
  const variant = asciiStr(d, 16, 8), materialId = asciiStr(d, 24, 8);
  const color = argb(d[83], d[80], d[81], d[82]);
  const prod = asciiStr(d, 192, 16);
  const colors = [color];
  if (d.readUInt16LE(256) === 0x0002 && d.readUInt16LE(258) > 1) {
    const abgr = d.readUInt32LE(260);
    colors.push(argb((abgr >>> 24) & 255, abgr & 255, (abgr >>> 8) & 255, (abgr >>> 16) & 255));
  }
  const p = prod.split('_');
  const mod = detailed.startsWith(type) ? detailed.slice(type.length).trim() : detailed;
  const trayUid = Buffer.from(d.subarray(144, 160)).toString('hex').toUpperCase();
  return {
    filament: filament({ id: productId('Bambu Lab', type, detailed, color, prod), manufacturer: 'Bambu', type,
      modifiers: mod && mod !== type ? [mod] : [], colors, diameter: d.readFloatLE(88), weight: d.readUInt16LE(84),
      nozzleMin: d.readUInt16LE(106), nozzleMax: d.readUInt16LE(104), bed: d.readUInt16LE(102),
      dryTemp: d.readUInt16LE(96), dryHours: d.readUInt16LE(98),
      made: p.length >= 3 ? `${p[0]}-${p[1].padStart(2, '0')}-${p[2].padStart(2, '0')}` : '1970-01-01' }),
    extras: { tray_uid: trayUid, material_id: materialId, material_variant_id: variant, detailed_type: detailed,
      production_datetime: prod, filament_length_m: d.readUInt16LE(228),
      nozzle_diameter_mm: Math.round(d.readFloatLE(140) * 100) / 100, spool_width_um: d.readUInt16LE(164) },
    spoolId: `bambu:${trayUid}`,
  };
}

function snapmaker(d) {
  const le = (pos, n) => { let x = 0; for (let i = n - 1; i >= 0; i--) x = x * 256 + d[pos + i]; return x; };
  const be = (pos, n) => { let x = 0; for (let i = 0; i < n; i++) x = x * 256 + d[pos + i]; return x; };
  // a genuine tag is signed by Snapmaker (RSA PKCS#1 v1.5, SHA-256) over its first 640 bytes
  const ver = d[168] | (d[169] << 8);
  const key = SNAP_RSA[ver];
  if (!key) return null;
  const sig = Buffer.concat([...Array(6)].map((_, i) => d.subarray((10 + i) * 64, (10 + i) * 64 + 48))).subarray(0, 256);
  if (!crypto.verify('sha256', d.subarray(0, 640), key, sig)) return null;
  const vendor = strictAscii(d.subarray(16, 32)).replace(/\0+$/, '');
  const manufacturer = strictAscii(d.subarray(32, 48)).replace(/\0+$/, '');
  const main = BR.snapmaker.main[le(66, 2)], sub = BR.snapmaker.sub[le(68, 2)];
  if (main == null || sub == null) return null;
  const tray = le(70, 2), alpha = 0xFF - d[73], count = d[72];
  if (count > 5) return null;
  const rgb = [0, 3, 6, 9, 12].map(o => ((alpha << 24) | be(80 + o, 3)) >>> 0);
  const weight = le(130, 2), sku = le(96, 4);
  return {
    filament: filament({ id: productId('Snapmaker', vendor, manufacturer, main, sub, rgb[0], weight, sku, tray),
      manufacturer: vendor, type: main, modifiers: [sub], colors: rgb.slice(0, count), diameter: le(128, 2) / 100, weight,
      nozzleMin: le(150, 2), nozzleMax: le(148, 2), bed: le(154, 2), dryTemp: le(144, 2), dryHours: le(146, 2),
      made: '2026-01-01' }),
  };
}

function creality(d) {
  let p = d.subarray(64, 112);
  if (!(p[3] === 0x32 && (p[17] === 0x30 || p[17] === 0x23))) p = aes(KEYS.crealityEnc, p, false);
  const s = Buffer.from(p).toString('latin1').replace(/[^\x00-\x7f]/g, '');
  const year = 2000 + pyInt(s.slice(3, 5)), month = pyInt(s[5], 16), day = pyInt(s.slice(6, 8));
  const material = s.slice(12, 17);
  const color = ((0xFF << 24) | pyInt(s.slice(18, 24), 16)) >>> 0;
  const lengthM = pyInt(s.slice(24, 28));
  const x = BR.creality[material];
  if (!x) return null;
  const weight = { 330: 1000, 165: 500, 80: 250 }[lengthM] || 1000;
  return {
    filament: filament({ id: productId('Creality', s), manufacturer: 'Creality', type: x[0], modifiers: x[1], colors: [color],
      diameter: 1.75, weight, nozzleMin: x[2], nozzleMax: x[3], bed: x[4], dryTemp: x[5], dryHours: x[6],
      made: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` }),
  };
}

function qidi(d) {
  const s = d.subarray(64, 112);
  const [m, c, mf] = s;
  if (s.subarray(3).some(b => b !== 0) || !m || !c || !mf) return null;
  const mat = BR.qidi.materials[m], col = BR.qidi.colors[c];
  if (!mat || !col) return null;
  return {
    filament: filament({ id: productId('QIDI', m, c, mf), manufacturer: 'QIDI', type: mat[0], modifiers: mat[1],
      colors: [parseInt(col, 16)], diameter: 1.75, weight: 1000, nozzleMin: 0, nozzleMax: 0, bed: 0,
      dryTemp: 0, dryHours: 0, made: '0001-01-01' }),
  };
}

const CLASSIC = { bambu, snapmaker, creality, qidi };
// Decode a 1024-byte MIFARE Classic dump read with that brand's keys
function decodeClassic(brand, dump) {
  if (!CLASSIC[brand] || !dump || dump.length !== 1024) return null;
  try {
    const r = CLASSIC[brand](dump);
    return r ? { decoder: brand, extras: null, spoolId: null, ...r } : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- NTAG / Ultralight (whole memory from page 0)
function openspool(records) {
  for (const r of records) {
    if (r.type !== 'application/json') continue;
    try {
      const j = JSON.parse(r.payload.toString('utf8'));
      if (!j || typeof j !== 'object' || Array.isArray(j) || j.protocol !== 'openspool') continue;
      const brand = j.brand ?? 'Generic';
      const type = String(j.type ?? 'PLA').toUpperCase();
      const subtype = j.subtype ?? '';
      let rgb;
      try { rgb = pyInt(String(j.color_hex ?? 'FFFFFF').replace(/^#/, ''), 16); } catch { rgb = 0xFFFFFF; }
      if (typeof (j.alpha ?? 'FF') !== 'string') continue;
      const alpha = Math.max(0, Math.min(255, pyInt(j.alpha ?? 'FF', 16)));
      const color = ((alpha * 0x1000000) + rgb) >>> 0;
      let diameter = Number(j.diameter ?? 1.75); if (!Number.isFinite(diameter)) diameter = 1.75;
      let weight = 1000;
      try { weight = typeof j.weight === 'number' ? Math.trunc(j.weight) : pyInt(j.weight ?? 1000); } catch { weight = 1000; }
      const int = v => (typeof v === 'number' ? Math.trunc(v) : pyInt(v));
      const min = int(j.min_temp ?? 0), max = int(j.max_temp ?? 0);
      if (max < min) continue;
      const x = BR.openspoolDefaults[type] || [0, 0, 0];
      return { decoder: 'openspool', filament: filament({ id: productId('OpenSpool', brand, type, subtype, color), manufacturer: brand,
        type, modifiers: subtype ? [subtype] : [], colors: [color], diameter, weight, nozzleMin: min, nozzleMax: max,
        bed: x[0], dryTemp: x[1], dryHours: x[2], made: '0001-01-01' }) };
    } catch { /* not this format */ }
  }
  return null;
}

function spoolease(records) {
  for (const r of records) {
    if (r.tnf !== 0x01 || r.type !== 'U') continue;
    try {
      const url = new URL(uriOf(r.payload));
      if (url.host.toLowerCase() !== 'tag.spoolease.io' || !url.pathname.startsWith('/S1')) continue;
      const q = (k) => { const v = url.searchParams.get(k); return v === '' ? null : v; };
      const raw = String(q('M') || 'PLA').toUpperCase();
      const material = BR.spooleaseAliases[raw] || raw;
      const subtype = q('MS') || '', brand = q('B') || 'Generic';
      const req = (k) => { const v = q(k); if (v == null) throw new Error(`missing ${k}`); return pyInt(v); };
      const min = req('NN'), max = req('NX');
      const weight = q('WL') == null ? 1000 : pyInt(q('WL'));
      if (max < min) continue;
      const colors = [];
      for (const code of String(q('CC') || 'FFFFFFFF').split(';')) {
        if (colors.length >= 5) break;
        const h = code.trim().replace(/^#/, '');
        if (!h) continue;
        if (h.length === 6) colors.push(((0xFF * 0x1000000) + pyInt(h, 16)) >>> 0);
        else if (h.length === 8) colors.push(((pyInt(h.slice(6), 16) * 0x1000000) + pyInt(h.slice(0, 6), 16)) >>> 0);
        else throw new Error('bad color');
      }
      if (!colors.length) colors.push(0xFFFFFFFF);
      const x = BR.spooleaseDefaults[material] || [0, 0, 0];
      return { decoder: 'spoolease', filament: filament({ id: productId('SpoolEase', brand, material, subtype, ...colors, weight),
        manufacturer: brand, type: material, modifiers: subtype ? [subtype] : [], colors, diameter: 1.75, weight,
        nozzleMin: min, nozzleMax: max, bed: x[0], dryTemp: x[1], dryHours: x[2], made: '0001-01-01' }) };
    } catch { /* not this format */ }
  }
  return null;
}

// OpenTag3D: fields from the official schema (offsets, lengths, scaling)
const OT3D_MIME = OT3D.mime_type;
const OT3D_VERSION = (() => { const [a, b] = OT3D.version.split('.'); return +a * 1000 + +b; })();
function decodeOpenTag3DPayload(payload) {
  if (payload.length < 2) throw new Error('missing version');
  const version = payload.readUInt16BE(0);
  if (Math.floor(version / 1000) !== 2) throw new Error('unsupported version');
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const v = {};
  for (const f of OT3D.core.fields) {
    const start = parseInt(f.start, 16);
    const raw = Buffer.alloc(f.length);
    payload.copy(raw, 0, start, Math.min(payload.length, start + f.length));
    if (f.type === 'int') { let x = 0; for (const b of raw) x = x * 256 + b; v[f.id] = x * (f.scaling ?? 1); }
    else if (f.type === 'utf8' || f.type === 'ascii') {
      const cut = raw.indexOf(0) >= 0 ? raw.subarray(0, raw.indexOf(0)) : raw;
      if (f.type === 'ascii' && cut.some(b => b > 0x7f)) throw new Error('not ASCII');
      v[f.id] = utf8.decode(cut);
    } else if (f.type === 'rgba') v[f.id] = [...raw];
    else if (f.type === 'date') {
      if (!raw.some(Boolean)) { v[f.id] = null; continue; }
      const y = raw.readUInt16BE(0), m = raw[2], d = raw[3];
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (y < 1 || m < 1 || m > 12 || dt.getUTCDate() !== d) throw new Error('bad date');
      v[f.id] = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    } else if (f.type === 'time') {
      if (raw[0] > 23 || raw[1] > 59 || raw[2] > 59) throw new Error('bad time');
      v[f.id] = raw.some(Boolean) ? raw : null;
    } else throw new Error(`unsupported field type ${f.type}`);
  }
  return v;
}
function opentag3d(records, uid) {
  for (const r of records) {
    if (r.tnf !== 0x02 || r.type !== OT3D_MIME) continue;
    try {
      const v = decodeOpenTag3DPayload(r.payload);
      const colors = [];
      for (let i = 1; i <= 4; i++) {
        const [cr, cg, cb, ca] = v[`color_${i}`];
        if (i === 1 || cr || cg || cb || ca) colors.push(argb(ca, cr, cg, cb));
      }
      const min = v.min_print_temp || v.print_temp, max = v.max_print_temp || v.print_temp;
      if (max < min) continue;
      return { decoder: 'opentag3d', filament: filament({ id: productId('OpenTag3D', uid.toString('hex')), manufacturer: v.manufacturer,
        type: v.material, modifiers: v.material_mod ? [v.material_mod] : [], colors, diameter: v.diameter, weight: v.weight,
        nozzleMin: min, nozzleMax: max, bed: v.bed_temp, dryTemp: v.max_dry_temp, dryHours: v.dry_time,
        made: v.mfg_date || '0001-01-01', td: v.td }),
        extras: v.color_name ? { color_name: v.color_name } : null };
    } catch { /* not this format */ }
  }
  return null;
}

const TIGER_IDS = new Set([0x5BF59264, 0xBC0FCB97]);
function tigertag(data) {
  if (data.length < 16 + 36) return null;
  const u = data.subarray(16);
  if (!TIGER_IDS.has(u.readUInt32BE(0))) return null;
  const productIdRaw = u.readUInt32BE(4), materialId = u.readUInt16BE(8);
  const brandId = u.readUInt16BE(14);
  const color = argb(u[19], u[16], u[17], u[18]);
  const measure = (u[20] << 16) | (u[21] << 8) | u[22], unit = u[23];
  const tmin = u.readUInt16BE(24), tmax = u.readUInt16BE(26), dryT = u[28], dryH = u[29];
  const td = u.length > 45 ? u.readUInt16BE(44) / 10 : 0;
  const ts = u.readUInt32BE(32);
  const m = TT.material[materialId];
  const label = m ? m[0] : `Unknown(${materialId})`;
  const mtype = m ? (m[1] || label) : label;
  const resolved = m && m[2] ? `${mtype}-${m[2]}` : mtype;
  const brand = TT.brand[brandId] || `Unknown(${brandId})`;
  const diameter = TT.diameter[u[13]] ?? 1.75;
  const mods = [u[10], u[11]].map(a => TT.aspect[a] || '').filter(a => a && a !== 'None' && a !== '-');
  const grams = unit === 2 || unit === 35 ? measure * 1000 : unit === 10 ? measure / 1000 : measure;
  let made = '0001-01-01';
  if (ts) { const dt = new Date((ts + 946684800) * 1000); if (!isNaN(dt)) made = dt.toISOString().slice(0, 10); }
  return { decoder: 'tigertag', filament: filament({ id: productId('TigerTag', brand, resolved, color, productIdRaw, ts), manufacturer: brand,
    type: resolved, modifiers: mods, colors: [color], diameter, weight: grams, nozzleMin: tmin, nozzleMax: tmax, bed: 0,
    dryTemp: dryT, dryHours: dryH, made, td }) };
}

function anycubic(d) {
  if (d.length < 0x7C || d[0x10] !== 0x7B || d[0x11] !== 0x00 || d[0x12] !== 0x65 || d[0x13] !== 0x00) return null;
  const sku = strictAscii(d.subarray(0x14, 0x24)).replace(/\0+$/, '');
  const brand = strictAscii(d.subarray(0x28, 0x38)).replace(/\0+$/, '');
  const ftype = strictAscii(d.subarray(0x3C, 0x4C)).replace(/\0+$/, '');
  const parts = ftype.replace(/-/g, ' ').split(' ');
  if (parts[0].endsWith('+')) { parts[0] = parts[0].slice(0, -1); parts.push('+'); }
  const color = argb(d[0x50], d[0x53], d[0x52], d[0x51]);
  const lengthM = d.readUInt16LE(0x7A);
  const weight = { 330: 1000, 247: 750, 198: 600, 165: 500, 82: 250 }[lengthM] || 1000;
  return { decoder: 'anycubic', filament: filament({ id: productId('Anycubic', sku, brand, ftype, color, lengthM), manufacturer: brand,
    type: parts[0] || 'PLA', modifiers: parts.slice(1), colors: [color], diameter: d.readUInt16LE(0x78) / 100, weight,
    nozzleMin: d.readUInt16LE(0x60), nozzleMax: d.readUInt16LE(0x62), bed: d.readUInt16LE(0x76), dryTemp: 0, dryHours: 0,
    made: '0001-01-01' }) };
}

function elegoo(d) {
  const f = d.subarray(0x40, 0x69);
  if (f.length < 0x20 || f[1] !== 0xEE || f[2] !== 0xEE || f[3] !== 0xEE || f[4] !== 0xEE) return null;
  // OpenRFID reads the material bytes oddly (hex digits as decimal); kept as is so product ids match
  const chars = [...f.subarray(8, 12)].filter(Boolean).map(x => {
    const h = x.toString(16);
    if (!/^\d+$/.test(h)) throw new Error('bad material id');
    return String.fromCharCode(parseInt(h, 10));
  });
  const pyList = chars.length ? `['${chars.map(c => c.replace(/\\/g, '\\\\').replace(/'/g, "\\'")).join("', '")}']` : '[]';
  const sub = f.readUInt16BE(0x0C);
  const mat = BR.elegoo[`${sub >> 8}:${sub & 0xFF}`];
  if (!mat) return null;
  const color = argb(f[0x13], f[0x10], f[0x11], f[0x12]);
  const diameter = f.readUInt16BE(0x1C) / 100, weight = f.readUInt16BE(0x1E);
  return { decoder: 'elegoo', filament: filament({ id: productId('Elegoo', pyList, sub, color, pyFloat(diameter), weight), manufacturer: 'Elegoo',
    type: mat[0], modifiers: mat[1], colors: [color], diameter, weight, nozzleMin: f.readUInt16BE(0x14),
    nozzleMax: f.readUInt16BE(0x16), bed: 0, dryTemp: 0, dryHours: 0, made: '0001-01-01' }) };
}

// Decode an NTAG/Ultralight memory dump (from page 0). Tries each format; null when none matches.
function decodeUltralight(data, uid) {
  if (!data || data.length < 16) return null;
  let records = [];
  try { records = parseNdef(data); } catch { records = []; }
  const tries = [() => opentag3d(records, uid), () => openspool(records), () => spoolease(records),
    () => tigertag(data), () => anycubic(data), () => elegoo(data)];
  for (const t of tries) {
    try { const r = t(); if (r) return { extras: null, spoolId: null, ...r }; } catch { /* next format */ }
  }
  return null;
}

module.exports = { classicKeys, decodeClassic, decodeUltralight, decodeOpenTag3DPayload, OT3D, OT3D_MIME, OT3D_VERSION, FF6 };
