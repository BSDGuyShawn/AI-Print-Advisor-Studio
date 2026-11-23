// Reading and writing tags through a reader (src/nfc/cardio.js), with simulated tags built from real dumps:
// reader login quirks, never writing while reading, and writing blank stickers safely.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { scanTag, inspectForWrite, writeMessage, readUltralight } = require('../src/nfc/cardio');
const { encodeTag } = require('../src/nfc/encoders');
const { decodeUltralight } = require('../src/nfc/decoders');

const FIX = path.join(__dirname, 'fixtures', 'tags');
const first = (dir) => path.join(FIX, dir, fs.readdirSync(path.join(FIX, dir)).find(f => f.endsWith('.bin')));

// A MIFARE Classic 1K tag: keys from its dump's trailers; key A can't be read back; a failed login halts it
class SimClassic {
  constructor(img, { quirkModes = 0 } = {}) {
    this.img = img; this.name = 'sim'; this.authed = null; this.writes = 0;
    this.authModes = 4; this.mode = 0; this.quirkModes = quirkModes;
  }
  setAuthMode(i) { this.mode = i; }
  async auth(block, kind, key) {
    const s = Math.floor(block / 4);
    const t = this.img.subarray(s * 64 + 48, s * 64 + 64);
    const want = kind === 'A' ? t.subarray(0, 6) : t.subarray(10, 16);
    const ok = this.mode >= this.quirkModes && Buffer.from(key).equals(want);
    this.authed = ok ? s : null;
    return ok;
  }
  async read(block) {
    if (this.authed !== Math.floor(block / 4)) return null;
    const d = Buffer.from(this.img.subarray(block * 16, block * 16 + 16));
    if (block % 4 === 3) d.fill(0, 0, 6);
    return d;
  }
  async write() { this.writes++; throw new Error('write sent to a MIFARE Classic tag'); }
}
// An NTAG sticker: 4-byte pages; READ returns 16 bytes (4 pages) or 4 with fourByteReads
class SimNtag {
  constructor(pages, { cc = [0xE1, 0x10, 0x3E, 0x00], fourByteReads = false, lock = [0, 0] } = {}) {
    this.mem = Buffer.alloc(pages * 4);
    Buffer.from([0x04, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, ...lock, ...cc]).copy(this.mem);
    this.name = 'sim'; this.four = fourByteReads; this.written = [];
  }
  async auth() { return false; }
  async read(page) {
    if (page * 4 >= this.mem.length) return null;
    const out = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) out[i] = this.mem[(page * 4 + i) % this.mem.length];
    return this.four ? out.subarray(0, 4) : out;
  }
  async write(page, four) {
    assert.ok(page >= 4, `wrote system page ${page}`);
    this.written.push(page);
    Buffer.from(four).copy(this.mem, page * 4);
  }
}
const ntagUid = (t) => Buffer.concat([t.mem.subarray(0, 3), t.mem.subarray(4, 8)]);

test('reads each MIFARE Classic brand through a reader, never writing', async () => {
  for (const [dir, brand] of [['Bambu', 'bambu'], ['Snapmaker', 'snapmaker'], ['Creality', 'creality'], ['Qidi', 'qidi']]) {
    const img = fs.readFileSync(first(dir));
    const t = new SimClassic(img);
    const r = await scanTag(t, { uid: img.subarray(0, 4), sak: 0x08 });
    assert.strictEqual(r.status, 'decoded', dir);
    assert.strictEqual(r.decoder, brand, dir);
    assert.strictEqual(t.writes, 0);
    if (brand === 'bambu') assert.match(r.spool_id, /^bambu:/);
    else assert.strictEqual(r.spool_id, `uid:${img.subarray(0, 4).toString('hex').toUpperCase()}`);
  }
});

test('works around readers that need another login variant', async () => {
  const img = fs.readFileSync(first('Snapmaker'));
  const r = await scanTag(new SimClassic(img, { quirkModes: 2 }), { uid: img.subarray(0, 4), sak: 0x08 });
  assert.strictEqual(r.decoder, 'snapmaker');
});

test('a blank MIFARE Classic card is reported by its ID, not as a brand', async () => {
  const img = Buffer.alloc(1024);
  for (let s = 0; s < 16; s++) Buffer.from('FFFFFFFFFFFFFF078069FFFFFFFFFFFF', 'hex').copy(img, s * 64 + 48);
  Buffer.from('DEADBEEF', 'hex').copy(img);
  const r = await scanTag(new SimClassic(img), { uid: Buffer.from('DEADBEEF', 'hex'), sak: 0x08 });
  assert.strictEqual(r.status, 'unrecognized');
  assert.strictEqual(r.spool_id, 'uid:DEADBEEF');
});

test('reads NTAG brand tags, with 16-byte and 4-byte reads', async () => {
  for (const dir of ['OpenSpool', 'Tigertag', 'Anycubic', 'Elegoo', 'SpoolEase', 'OpenTag3D']) {
    const img = fs.readFileSync(first(dir));
    for (const four of [false, true]) {
      const t = new SimNtag(Math.ceil(img.length / 4), { fourByteReads: four });
      img.copy(t.mem);
      const r = await scanTag(t, { uid: ntagUid(t), sak: 0x00 });
      assert.strictEqual(r.status, 'decoded', `${dir} ${four}`);
    }
  }
});

const MY_FILAMENT = { brand: 'Polymaker', type: 'PLA', subtype: 'Matte', colorName: 'Muted White', hex: '#E8E4DA',
  weight: 1000, diameter: 1.75, nozzleMin: 190, nozzleMax: 230, bedMin: 55, bedMax: 65, dryTemp: 50, dryHours: 6 };

test('writes OpenSpool to a blank NTAG215 and reads it back', async () => {
  const t = new SimNtag(135);
  const info = { uid: ntagUid(t), sak: 0x00 };
  const insp = await inspectForWrite(t, info);
  assert.deepStrictEqual([insp.writable, insp.hasData, insp.capacity], [true, false, 496]);
  const back = await writeMessage(t, info, encodeTag('openspool', MY_FILAMENT, insp.capacity), insp.capacity);
  assert.strictEqual(back.decoder, 'openspool');
  assert.strictEqual(back.filament.manufacturer, 'Polymaker');
  assert.strictEqual(back.filament.material, 'PLA');
  assert.deepStrictEqual(back.filament.modifiers, ['Matte']);
  assert.strictEqual(back.filament.color_hex, '#E8E4DA');
  assert.deepStrictEqual([back.filament.nozzle_temp_min_c, back.filament.nozzle_temp_max_c, back.filament.weight_g], [190, 230, 1000]);
  assert.ok(Math.max(...t.written) <= 3 + 496 / 4, 'stays inside the data area');
  // now it has data: a second write asks first
  assert.strictEqual((await inspectForWrite(t, info)).hasData, true);
});

test('writes OpenTag3D (with the color name) to an NTAG215', async () => {
  const t = new SimNtag(135);
  const info = { uid: ntagUid(t), sak: 0x00 };
  const back = await writeMessage(t, info, encodeTag('opentag3d', MY_FILAMENT, 496), 496);
  assert.strictEqual(back.decoder, 'opentag3d');
  assert.strictEqual(back.extras.color_name, 'Muted White');
  assert.strictEqual(back.filament.material, 'PLA');
  assert.deepStrictEqual([back.filament.nozzle_temp_min_c, back.filament.nozzle_temp_max_c, back.filament.bed_temp_c], [190, 230, 65]);
});

test('optional details are dropped to fit; an NTAG213 is too small, with a clear message', async () => {
  const full = encodeTag('openspool', MY_FILAMENT, 0);
  const trimmed = encodeTag('openspool', MY_FILAMENT, full.length - 10);
  assert.ok(trimmed.length <= full.length - 10);
  assert.throws(() => encodeTag('openspool', MY_FILAMENT, 144), /NTAG215/);
  assert.throws(() => encodeTag('opentag3d', MY_FILAMENT, 144), /NTAG215/);
  const t = new SimNtag(135);
  const back = await writeMessage(t, { uid: ntagUid(t), sak: 0x00 }, trimmed, 496);
  assert.strictEqual(back.decoder, 'openspool');
  assert.deepStrictEqual(back.filament.modifiers, ['Matte']);
});

test('refuses MIFARE Classic tags, locked and unformatted stickers', async () => {
  const img = fs.readFileSync(first('Bambu'));
  assert.strictEqual((await inspectForWrite(new SimClassic(img), { uid: img.subarray(0, 4), sak: 0x08 })).reason, 'classic');
  const locked = new SimNtag(135, { lock: [0xF0, 0xFF] });
  assert.strictEqual((await inspectForWrite(locked, { uid: ntagUid(locked), sak: 0 })).reason, 'locked');
  const ro = new SimNtag(135, { cc: [0xE1, 0x10, 0x3E, 0x0F] });
  assert.strictEqual((await inspectForWrite(ro, { uid: ntagUid(ro), sak: 0 })).reason, 'readonly');
  const raw = new SimNtag(135, { cc: [0, 0, 0, 0] });
  assert.strictEqual((await inspectForWrite(raw, { uid: ntagUid(raw), sak: 0 })).reason, 'unformatted');
  await assert.rejects(writeMessage(new SimClassic(img), { uid: img.subarray(0, 4), sak: 0x08 }, Buffer.alloc(8), 100), /Only NTAG/);
});

test('encoding checks the filament before anything touches a tag', () => {
  assert.throws(() => encodeTag('openspool', { ...MY_FILAMENT, nozzleMin: undefined, nozzleMax: undefined }), /nozzle/);
  assert.throws(() => encodeTag('openspool', { ...MY_FILAMENT, type: 'Other' }), /material type/);
  assert.throws(() => encodeTag('openspool', { ...MY_FILAMENT, hex: 'red' }), /color/);
  const nylon = decodeUltralight(Buffer.concat([Buffer.from('041122334455667788990000E1103E00', 'hex'),
    encodeTag('openspool', { ...MY_FILAMENT, type: 'Nylon' }, 496), Buffer.alloc(300)]), Buffer.alloc(7));
  assert.strictEqual(nylon.filament.material, 'PA');
});

test('an NTAG203 (42 pages, factory Lock Control TLV) reads, counts as blank and keeps its TLV', async () => {
  // as the real sticker read on the Arduino: CC E1 10 12 00, data area 01 03 A0 10 44 | 03 00 | FE
  const t = new SimNtag(42, { cc: [0xE1, 0x10, 0x12, 0x00] });
  Buffer.from('0103A01044' + '0300FE', 'hex').copy(t.mem, 16);
  t.read = async (page) => (page >= 42 ? null : SimNtag.prototype.read.call(t, page));   // no wrap-around past page 41
  const info = { uid: ntagUid(t), sak: 0x00 };
  assert.strictEqual((await readUltralight(t)).length, 16 * 10 + 0, 'reads only the data area (pages 0-39)');
  const insp = await inspectForWrite(t, info);
  assert.deepStrictEqual([insp.writable, insp.hasData, insp.capacity, insp.prefix.toString('hex')], [true, false, 139, '0103a01044']);
  assert.throws(() => encodeTag('openspool', MY_FILAMENT, insp.capacity), /NTAG215/);
  const small = require('../src/nfc/ndef').mimeMessage('text/plain', Buffer.from('spool 054'));
  await writeMessage(t, info, small, insp);
  assert.strictEqual(t.mem.subarray(16, 21).toString('hex'), '0103a01044', 'control TLV kept');
  assert.ok(Math.max(...t.written) <= 39);
});

test('a MIFARE Classic tag that slipped during the first login is read on the retry', async () => {
  const img = fs.readFileSync(first('Snapmaker'));
  const t = new SimClassic(img);
  let fails = 5;   // the first round of logins all fail, as when the spool moves on the reader
  const auth = t.auth.bind(t);
  t.auth = async (...a) => (fails-- > 0 ? false : auth(...a));
  const r = await scanTag(t, { uid: img.subarray(0, 4), sak: 0x08 });
  assert.strictEqual(r.decoder, 'snapmaker');
});
