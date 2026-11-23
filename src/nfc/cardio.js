// Reading and writing a spool tag through any reader. The reader-specific parts (USB PC/SC readers, the Arduino
// bridge, PN532 boards) are "transports" with the same few operations:
//   auth(block, 'A'|'B', key6) -> true/false   MIFARE Classic login (re-selects the tag after a failed one)
//   read(block)               -> 16 bytes      (NTAG: 4 pages; some PC/SC readers return only 4 bytes)
//   write(page, 4 bytes)                       NTAG/Ultralight only
// and an optional authModes (how many login variants to try, for PC/SC reader quirks) + setAuthMode(i).
//
// Reading never changes a tag. Writing only ever touches NTAG/Ultralight user pages (from page 4, inside the data
// area the tag's capability container declares): never MIFARE Classic tags, never the ID, lock, config or
// password pages, so a tag can't be locked or bricked.
'use strict';

const { classicKeys, decodeClassic, decodeUltralight, FF6 } = require('./decoders');
const { parseNdef } = require('./ndef');

const ZERO6 = Buffer.alloc(6);
const TRAILER_ACCESS = Buffer.from([0x87, 0x87, 0x87, 0x69]);   // as OpenRFID rebuilds trailers (Snapmaker signatures cover them)
const TYPE_NAMES = { classic: 'MifareClassic1k', ultralight: 'MifareUltralight', other: 'Other' };

// What kind of tag: from the PC/SC ATR (Part 3 storage card), else the ISO 14443 SAK, else the UID length
function tagKind({ atr, sak, uid }) {
  if (atr && atr.length >= 15 && atr[4] === 0x80 && atr[5] === 0x4F && atr[6] === 0x0C && atr.subarray(7, 12).equals(Buffer.from('A000000306', 'hex'))) {
    const name = atr.readUInt16BE(13);
    if (name === 0x0001 || name === 0x0026 || name === 0x0002) return 'classic';
    if (name === 0x0003 || name === 0x003A || name === 0x0030) return 'ultralight';
  }
  if (sak != null) {
    if ([0x08, 0x09, 0x18, 0x88, 0x28, 0x38].includes(sak)) return 'classic';
    if (sak === 0x00) return 'ultralight';
    return 'other';
  }
  return uid && uid.length === 4 ? 'classic' : 'ultralight';
}

// ---------------------------------------------------------------- MIFARE Classic
async function authSector(t, sector, candidates) {
  for (const [key, kind] of candidates) if (await t.auth(sector * 4 + 3, kind, key)) return true;
  return false;
}
// All 16 sectors with one brand's keys. Returns the 1 KB image (trailers rebuilt) and the sectors that wouldn't open.
async function dumpClassic(t, keys) {
  const out = Buffer.alloc(1024);
  const failed = [];
  for (let s = 0; s < 16; s++) {
    const cands = [[keys.a[s], 'A']];
    if (!keys.b[s].equals(ZERO6)) cands.push([keys.b[s], 'B']);
    if (!keys.a[s].equals(FF6) && !keys.b[s].equals(FF6)) cands.push([FF6, 'A']);
    if (!(await authSector(t, s, cands))) { failed.push(s); continue; }
    for (let b = 0; b < 3; b++) {
      const d = await t.read(s * 4 + b);
      if (!d || d.length < 16) throw new Error(`read block ${s * 4 + b} failed`);
      d.copy(out, (s * 4 + b) * 16, 0, 16);
    }
    Buffer.concat([keys.a[s], TRAILER_ACCESS, keys.b[s]]).copy(out, (s * 4 + 3) * 16);
  }
  return { data: out, failed };
}

async function scanClassic(t, uid, out) {
  const tried = [];
  const modes = t.authModes || 1;
  for (let mode = 0; mode < modes; mode++) {
    if (t.setAuthMode) t.setAuthMode(mode);
    let opened = false;
    for (const { name, keys } of classicKeys(uid)) {
      // a cheap probe first: does this brand's key open the first sector it keys?
      let probe = keys.a.findIndex(k => !k.equals(FF6));
      if (probe < 0) probe = 0;
      const ok = await t.auth(probe * 4 + 3, 'A', keys.a[probe]);
      tried.push(`${name}${modes > 1 ? `[${mode}]` : ''}=${ok ? 'ok' : 'no'}`);
      if (!ok) continue;
      opened = true;
      const { data } = await dumpClassic(t, keys);
      const r = decodeClassic(name, data);
      if (r) return Object.assign(out, { status: 'decoded', decoder: r.decoder, filament: r.filament, extras: r.extras, spool_id: r.spoolId || null });
    }
    if (opened) break;   // the reader logs in fine; the tag just isn't a brand we know
  }
  out.extras = { probed: tried };
  return out;
}

// ---------------------------------------------------------------- NTAG / Ultralight
// The memory from page 0 through the end of the data area the capability container declares (or, with no CC,
// until the tag stops answering). Chips differ past the data area (an NTAG203 has 42 pages, an NTAG213 45), so
// nothing beyond it is read.
async function readUltralight(t) {
  const first = await t.read(0);
  if (!first) throw new Error('read page 0 failed');
  const step = first.length >= 16 ? 4 : 1;                   // some readers return one page per read
  const buf = [first.subarray(0, step * 4)];
  for (let p = 1; p < 4 / step; p++) { const d = await t.read(p); if (!d) throw new Error(`read page ${p} failed`); buf.push(d.subarray(0, 4)); }
  const head = Buffer.concat(buf);
  const cc = head.subarray(12, 16);
  const total = cc[0] === 0xE1 && cc[2] ? 4 + cc[2] * 2 : null;   // CC byte 2 = data area size / 8; 4 bytes a page
  const limit = Math.min(total || 231, 231);
  const pages = [head];
  for (let page = 4; page < limit;) {
    const d = await t.read(page).catch(() => null);
    if (!d) { if (total) throw new Error(`read page ${page} failed`); break; }
    const take = Math.min(step, limit - page);
    pages.push(d.subarray(0, take * 4));
    page += take;
  }
  return Buffer.concat(pages);
}

// Read a tag that's on the reader. info = { uid: Buffer, sak?, atr? }. Returns the record src/nfc.js expects.
async function scanTag(t, info) {
  const uidHex = info.uid.toString('hex').toUpperCase();
  const kind = tagKind(info);
  const out = { event: 'tag_scanned', status: 'unrecognized', decoder: null, spool_id: null,
    tag: { uid: uidHex, type: TYPE_NAMES[kind] }, reader: t.name, filament: null, extras: null };
  try {
    if (kind === 'classic') {
      await scanClassic(t, info.uid, out);
      // no key opened anything, not even the factory default: most often the tag moved during the login. Once more.
      if (out.status === 'unrecognized' && out.extras && out.extras.probed.every(p => p.endsWith('=no'))) await scanClassic(t, info.uid, out);
    }
    else if (kind === 'ultralight') {
      const data = await readUltralight(t);
      const r = decodeUltralight(data, info.uid);
      if (r) Object.assign(out, { status: 'decoded', decoder: r.decoder, filament: r.filament, extras: r.extras });
    }
  } catch (e) {
    out.status = 'read_error';
    out.error = String(e && e.message || e);
  }
  if (!out.spool_id) out.spool_id = `uid:${uidHex}`;
  return out;
}

// ---------------------------------------------------------------- writing (NTAG213/215/216 stickers)
// Where an NDEF message can start: after any Lock/Memory Control TLVs at the front of the data area (factory
// formatting on some chips, e.g. NTAG203). Those are kept as they are.
function controlPrefix(body) {
  let p = 0;
  for (;;) {
    let q = p;
    while (q < body.length && body[q] === 0x00) q++;                 // NULL TLVs
    if (q < body.length && (body[q] === 0x01 || body[q] === 0x02) && q + 1 < body.length) { p = q + 2 + body[q + 1]; continue; }
    return Math.min(p, body.length);
  }
}
// What's on a sticker and whether it can be written: { writable, reason, capacity, prefix, hasData, decoded }
async function inspectForWrite(t, info) {
  const kind = tagKind(info);
  if (kind === 'classic') return { writable: false, reason: 'classic' };
  if (kind !== 'ultralight') return { writable: false, reason: 'other' };
  const data = await readUltralight(t);
  const cc = data.subarray(12, 16);
  if (cc[0] !== 0xE1) return { writable: false, reason: 'unformatted' };
  if ((cc[3] & 0x0F) !== 0x00) return { writable: false, reason: 'readonly' };   // CC byte 3, low nibble: write access
  if (data[10] || data[11]) return { writable: false, reason: 'locked' };   // static lock bits on user pages
  const area = cc[2] * 8;
  const decoded = decodeUltralight(data, info.uid);
  const records = parseNdef(data);
  const body = data.subarray(16, 16 + area);
  const pre = controlPrefix(body);
  const rest = body.subarray(pre);
  const blank = !rest.length || rest[0] === 0xFE || (rest[0] === 0x03 && rest[1] === 0x00) || rest.every(b => b === 0);
  return { writable: true, area, capacity: area - pre, prefix: Buffer.from(body.subarray(0, pre)),
    hasData: !blank && (records.length > 0 || !!decoded || rest.some(b => b !== 0 && b !== 0xFE)), decoded, data };
}

// Write an NDEF message (from encoders.encodeTag) into the data area, after its control TLVs, and read it back.
// space: inspectForWrite's result ({ capacity, prefix, area }), or just the data area size for a bare sticker.
async function writeMessage(t, info, message, space) {
  if (tagKind(info) !== 'ultralight') throw new Error('Only NTAG/Ultralight stickers can be written.');
  const sp = typeof space === 'number' ? { capacity: space, prefix: Buffer.alloc(0), area: space } : space;
  if (message.length > sp.capacity) throw new Error('The data doesn’t fit on this sticker.');
  const image = Buffer.concat([sp.prefix, message]);
  const padded = Buffer.alloc(Math.ceil(image.length / 4) * 4);
  image.copy(padded);
  if (padded.length > sp.area) throw new Error('The data doesn’t fit on this sticker.');
  for (let p = 0; p < padded.length / 4; p++) await t.write(4 + p, padded.subarray(p * 4, p * 4 + 4));
  const back = await readUltralight(t);
  if (!back.subarray(16, 16 + padded.length).equals(padded)) throw new Error('The sticker didn’t keep what was written. Hold it still and try again.');
  return decodeUltralight(back, info.uid);
}

module.exports = { scanTag, inspectForWrite, writeMessage, readUltralight, dumpClassic, tagKind, controlPrefix };
