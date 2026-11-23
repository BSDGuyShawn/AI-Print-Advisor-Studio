// The spool tag decoders (src/nfc/decoders.js) against real tag dumps from all ten formats. The expected values
// (.yml next to each dump) are OpenRFID's own output for the same dump, so this checks the port field by field.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { classicKeys, decodeClassic, decodeUltralight } = require('../src/nfc/decoders');

const FIX = path.join(__dirname, 'fixtures', 'tags');
const CLASSIC_DIRS = { Bambu: 'bambu', Snapmaker: 'snapmaker', Creality: 'creality', Qidi: 'qidi' };
const UL_DIRS = { Anycubic: 'anycubic', Elegoo: 'elegoo', OpenSpool: 'openspool', OpenTag3D: 'opentag3d', SpoolEase: 'spoolease', Tigertag: 'tigertag' };

// the fixtures' YAML is flat "key: value" plus "- item" lists
function readYaml(file) {
  const out = {};
  let list = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const unq = (v) => v.trim().replace(/^"(.*)"$|^'(.*)'$/, '$1$2');
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && list) { out[list].push(unq(item[1])); continue; }
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    if (v === '') { out[k] = []; list = k; continue; }
    list = null;
    const inline = /^\[(.*)\]$/.exec(v);
    out[k] = inline ? (inline[1].trim() ? inline[1].split(',').map(unq) : []) : unq(v);
  }
  return out;
}
const num = (v) => Number(v);
const argbOf = (f) => f.colors_rgba_hex.map(h => '0X' + (h.slice(6) + h.slice(0, 6)));

function check(got, want, label) {
  assert.ok(got, `${label}: not decoded`);
  const f = got.filament;
  if (want.unique_id) assert.strictEqual(f.product_id, want.unique_id, `${label}: product id`);
  assert.strictEqual(f.manufacturer, want.manufacturer, `${label}: manufacturer`);
  assert.strictEqual(f.material, want.type, `${label}: material`);
  assert.deepStrictEqual(f.modifiers, want.modifiers, `${label}: modifiers`);
  assert.deepStrictEqual(argbOf(f), want.colors.map(c => c.toUpperCase()), `${label}: colors`);
  assert.strictEqual(f.diameter_mm, Math.round(num(want.diameter_mm) * 1000) / 1000, `${label}: diameter`);
  assert.strictEqual(f.weight_g, num(want.weight_grams), `${label}: weight`);
  assert.strictEqual(f.nozzle_temp_min_c, num(want.hotend_min_temp_c), `${label}: nozzle min`);
  assert.strictEqual(f.nozzle_temp_max_c, num(want.hotend_max_temp_c), `${label}: nozzle max`);
  assert.strictEqual(f.bed_temp_c, num(want.bed_temp_c), `${label}: bed`);
  assert.strictEqual(f.drying_temp_c, num(want.drying_temp_c), `${label}: drying temp`);
  assert.strictEqual(f.drying_time_h, num(want.drying_time_hours), `${label}: drying time`);
  assert.strictEqual(f.manufacturing_date, want.manufacturing_date, `${label}: date`);
  assert.strictEqual(f.td_mm || 0, num(want.td || 0), `${label}: td`);
}

const cases = (dirs) => Object.entries(dirs).flatMap(([dir, brand]) =>
  fs.readdirSync(path.join(FIX, dir)).filter(f => f.endsWith('.bin')).map(f => ({ brand, file: path.join(FIX, dir, f), name: `${dir}/${f}` })));

for (const c of cases(CLASSIC_DIRS)) {
  test(`decodes ${c.name}`, () => {
    const dump = fs.readFileSync(c.file);
    const uid = dump.subarray(0, 4);
    // the keys worked out from the tag's ID are the keys actually on the tag (dumps keep them in the sector trailers)
    const k = classicKeys(uid).find(x => x.name === c.brand).keys;
    for (let s = 0; s < 16; s++) {
      const onTag = dump.subarray(s * 64 + 48, s * 64 + 54);
      if (c.brand !== 'qidi' && !(c.brand === 'creality' && s !== 1)) assert.ok(k.a[s].equals(onTag), `${c.name}: key A of sector ${s}`);
    }
    check(decodeClassic(c.brand, dump), readYaml(c.file.replace(/\.bin$/, '.yml')), c.name);
  });
}

for (const c of cases(UL_DIRS)) {
  test(`decodes ${c.name}`, () => {
    const dump = fs.readFileSync(c.file);
    const uid = Buffer.concat([dump.subarray(0, 3), dump.subarray(4, 8)]);
    const r = decodeUltralight(dump, uid);
    assert.strictEqual(r && r.decoder, c.brand, `${c.name}: decoder`);
    check(r, readYaml(c.file.replace(/\.bin$/, '.yml')), c.name);
  });
}

test('a Snapmaker tag with one changed byte fails its signature check', () => {
  const file = cases(CLASSIC_DIRS).find(c => c.brand === 'snapmaker').file;
  const dump = Buffer.from(fs.readFileSync(file));
  assert.ok(decodeClassic('snapmaker', dump));
  dump[130] ^= 1;   // the weight
  assert.strictEqual(decodeClassic('snapmaker', dump), null);
});

test('Bambu tags carry the tray id shared by both tags of a spool', () => {
  const file = cases(CLASSIC_DIRS).find(c => c.brand === 'bambu').file;
  const r = decodeClassic('bambu', fs.readFileSync(file));
  assert.match(r.spoolId, /^bambu:[0-9A-F]{32}$/);
  assert.ok(r.extras.material_id);
});

test('garbage and empty memory decode as nothing, without throwing', () => {
  for (const brand of Object.values(CLASSIC_DIRS)) {
    assert.strictEqual(decodeClassic(brand, Buffer.alloc(1024)), null);
    assert.strictEqual(decodeClassic(brand, Buffer.alloc(1024, 0xAB)), null);
  }
  assert.strictEqual(decodeUltralight(Buffer.alloc(540), Buffer.alloc(7)), null);
  assert.strictEqual(decodeUltralight(Buffer.alloc(540, 0xE1), Buffer.alloc(7)), null);
  assert.strictEqual(decodeUltralight(Buffer.alloc(3), Buffer.alloc(7)), null);
});
