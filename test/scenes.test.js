'use strict';
// "See it in place": the photo settings' manifest must point at photos that ship with the app, with sane placements
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'renderer', 'scenes', 'photos');

test('every photo setting in the manifest has its photo and a placement on it', () => {
  const list = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(list) && list.length >= 1);
  const ids = new Set();
  for (const p of list) {
    assert.match(p.id, /^[a-z0-9-]+$/);
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`); ids.add(p.id);
    assert.ok(p.name && typeof p.name === 'string');
    assert.match(p.file, /^[a-z0-9-]+\.jpg$/);
    const buf = fs.readFileSync(path.join(dir, p.file));
    assert.ok(buf[0] === 0xff && buf[1] === 0xd8, `${p.file} is a JPEG`);
    assert.ok(buf.length < 1.5 * 1024 * 1024, `${p.file} is a reasonable size`);
    assert.ok(Array.isArray(p.at) && p.at.length === 2 && p.at.every(v => v > 0 && v < 1), `${p.id} placement`);
    assert.ok(['left', 'right', 'front', 'back'].includes(p.light));
  }
});

test('photos ship without EXIF metadata (no camera or location details)', () => {
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.jpg'))) {
    const head = fs.readFileSync(path.join(dir, f)).subarray(0, 4096).toString('latin1');
    assert.ok(!head.includes('Exif\0'), `${f} has EXIF`);
  }
});
