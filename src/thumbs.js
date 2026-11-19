// Snapmaker Orca's command line regenerates any missing plate thumbnails with OpenGL right after slicing
// (Snapmaker_Orca.cpp, "thumbnails stage"). On Linux that uses OSMesa offscreen; on Windows it opens a
// hidden OpenGL window, and in practice the process ends there: the G-code exists, but the exported 3MF
// and result.json are never written. When every plate already has its thumbnail, no-light thumbnail,
// top view and pick map, the CLI skips rendering. This module makes sure they exist.
const zlib = require('zlib');

// Minimal PNG encoder: solid color, RGBA.
function solidPng(w, h, [r, g, b, a = 255]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + w * 4);
  for (let x = 0; x < w; x++) row.set([r, g, b, a], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const KEYS = [
  ['thumbnail_file', (n) => `Metadata/plate_${n}.png`],
  ['thumbnail_no_light_file', (n) => `Metadata/plate_no_light_${n}.png`],
  ['top_file', (n) => `Metadata/top_${n}.png`],
  ['pick_file', (n) => `Metadata/pick_${n}.png`],
];

function setMeta(body, key, value) {
  const re = new RegExp(`<metadata key="${key}" value="[^"]*"\\s*/>`);
  const tag = `<metadata key="${key}" value="${value}"/>`;
  return re.test(body) ? body.replace(re, tag) : body.replace(/(<metadata key="plater_id"[^>]*\/>)/, `$1\n    ${tag}`);
}

/**
 * Ensures every plate in the zip has all four thumbnail images and references them.
 * @param zip JSZip instance (modified in place)
 * @param fallbackImage optional PNG Buffer to use when the file has no thumbnail of its own
 */
const PLACEHOLDER = solidPng(256, 256, [205, 210, 214, 255]);

async function ensureThumbnails(zip, fallbackImage) {
  const placeholder = PLACEHOLDER;
  const msFile = zip.file('Metadata/model_settings.config');
  if (!msFile) return false; // plain models: no plate data to complete (callers convert them first)
  let xml = await msFile.async('string');
  if (!/<plate>/.test(xml)) return false;
  let plateNo = 0;
  xml = await replaceAsync(xml, /<plate>([\s\S]*?)<\/plate>/g, async (m, body) => {
    plateNo++;
    const id = (/<metadata key="plater_id" value="(\d+)"/.exec(body) || [])[1] || String(plateNo);
    // best available picture for this plate
    let own = null;
    for (const name of [`Metadata/plate_${id}.png`, 'Metadata/thumbnail.png', `Metadata/plate_no_light_${id}.png`, `Metadata/top_${id}.png`]) {
      if (zip.file(name)) { own = await zip.file(name).async('nodebuffer'); break; }
    }
    const img = own || fallbackImage || placeholder;
    for (const [key, pathFor] of KEYS) {
      const p = pathFor(id);
      if (!zip.file(p)) zip.file(p, key === 'pick_file' ? placeholder : img);
      body = setMeta(body, key, p);
    }
    return `<plate>${body}</plate>`;
  });
  zip.file('Metadata/model_settings.config', xml);
  return true;
}

async function replaceAsync(str, re, fn) {
  const parts = [];
  let last = 0;
  for (const m of str.matchAll(re)) {
    parts.push(str.slice(last, m.index), await fn(...m));
    last = m.index + m[0].length;
  }
  parts.push(str.slice(last));
  return parts.join('');
}

const PLACEHOLDER_BASE64 = PLACEHOLDER.toString('base64');
module.exports = { ensureThumbnails, solidPng, PLACEHOLDER_BASE64 };
