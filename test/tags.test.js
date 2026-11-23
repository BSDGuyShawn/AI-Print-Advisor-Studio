// Tests for renderer/filament/tags.js (turning a scanned tag into inventory records). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const T = require('../renderer/filament/tags.js');

const TYPES = ['PLA', 'PETG', 'PCTG', 'TPU', 'ABS', 'ASA', 'PLA-CF', 'PETG-CF', 'Nylon', 'Other'];
const scan = (f, extras = null) => ({ status: 'decoded', decoder: 'bambu', spoolId: 'bambu:AA', tag: { uid: '75886B1D' }, filament: f, extras });
const bambuOrange = scan({ manufacturer: 'Bambu', material: 'PLA', modifiers: ['Basic'], colorHex: '#FF6A13', colorsHex: ['#FF6A13'],
  weightG: 1000, diameterMm: 1.75, nozzleMin: 190, nozzleMax: 230, bed: 45, dryTemp: 55, dryHours: 8 }, { detailedType: 'PLA Basic' });

test('brand names from tags match the names in the library', () => {
  assert.equal(T.brandName('Bambu'), 'Bambu Lab');
  assert.ok(T.sameBrand('Bambu', 'Bambu Lab'));
  assert.ok(T.sameBrand('BambuLab', 'bambu lab'));
  assert.ok(!T.sameBrand('Bambu', 'Snapmaker'));
  assert.equal(T.brandName('Overture'), 'Overture');
});

test('types and finishes map onto the library lists', () => {
  assert.equal(T.typeFrom('PLA', ['Basic'], TYPES), 'PLA');
  assert.equal(T.typeFrom('PETG', ['CF'], TYPES), 'PETG-CF');
  assert.equal(T.typeFrom('PLA-CF', [], TYPES), 'PLA-CF');
  assert.equal(T.typeFrom('PA6-CF', [], TYPES), 'Nylon');
  assert.equal(T.typeFrom('PVA', [], TYPES), 'Other');
  assert.equal(T.finishFrom(['Matte']), 'Matte');
  assert.equal(T.finishFrom(['SnapSpeed']), 'Standard');
  assert.equal(T.finishFrom(['Translucent']), 'Translucent');
  assert.equal(T.finishFrom(['Silk+']), 'Silk');
});

test('color groups from hex', () => {
  const cases = { '#FF6A13': 'Orange', '#E72F1D': 'Red', '#080A0D': 'Black', '#F5F5F5': 'White', '#8A8A8A': 'Grey', '#1E5BD0': 'Blue',
    '#2E9E44': 'Green', '#FDD835': 'Yellow', '#7B3FA0': 'Purple', '#F48FB1': 'Pink', '#6D4C41': 'Brown', '#00968A': 'Teal' };
  for (const [hex, fam] of Object.entries(cases)) assert.equal(T.familyOf(hex), fam, hex);
});

test('draft from a decoded Bambu tag', () => {
  const d = T.draftFromTag(bambuOrange, TYPES);
  assert.equal(d.brand, 'Bambu Lab');
  assert.equal(d.type, 'PLA');
  assert.equal(d.line, 'Basic');
  assert.equal(d.finish, 'Standard');
  assert.equal(d.hex, '#FF6A13');
  assert.deepEqual(d.fams, ['Orange']);
  assert.equal(d.grams, 1000);
  assert.equal(d.nozzle, '190–230');
  assert.equal(d.bed, '45');
  assert.equal(d.dry, '55 °C · 8 h');
  assert.equal(d.color, '', 'tags have no color name; the user types it');
  assert.equal(T.draftFromTag({ status: 'unrecognized', filament: null }, TYPES), null);
});

test('multicolor tags keep every color', () => {
  const d = T.draftFromTag(scan({ manufacturer: 'Bambu', material: 'PLA', modifiers: ['Silk'], colorHex: '#FF0000', colorsHex: ['#FF0000', '#0000FF'], weightG: 1000 }), TYPES);
  assert.deepEqual(d.hex, ['#FF0000', '#0000FF']);
  assert.deepEqual(d.fams, ['Multicolor']);
  assert.equal(d.finish, 'Silk');
});

test('matching finds the same filament already in the library', () => {
  const d = T.draftFromTag(bambuOrange, TYPES);
  const lib = [
    { id: 'a', brand: 'Bambu Lab', type: 'PLA', line: 'Basic', finish: 'Standard', hex: '#FF7A1F', grams: 1000, color: 'Orange' },
    { id: 'b', brand: 'Bambu Lab', type: 'PLA', line: 'Basic', finish: 'Standard', hex: '#1E5BD0', grams: 1000, color: 'Blue' },
    { id: 'c', brand: 'Bambu Lab', type: 'PETG', line: 'HF', finish: 'Standard', hex: '#FF6A13', grams: 1000, color: 'Orange' },
    { id: 'd', brand: 'Overture', type: 'PLA', line: 'Basic', finish: 'Standard', hex: '#FF6A13', grams: 1000, color: 'Orange' },
  ];
  assert.equal(T.matchFilament(d, lib).filament.id, 'a');
  assert.equal(T.matchFilament(d, lib.slice(1)), null, 'a blue spool or another brand is not a match');
});

test('spools remember their tags', () => {
  const spools = { '001': { id: '001', tags: ['uid:1D0703F4'] }, '002': { id: '002' }, '003': { id: '003', tags: ['bambu:AA'] } };
  assert.equal(T.spoolForTag(spools, 'bambu:AA').id, '003');
  assert.equal(T.spoolForTag(spools, 'uid:FFFFFFFF'), null);
  assert.equal(T.tagLabel('uid:1D0703F4'), 'tag 1D0703F4');
  assert.match(T.tagLabel('bambu:D7AC3B89A16B47C4B061728044E1F2D5'), /^Bambu Lab spool D7AC3B89/);
});
