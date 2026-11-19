// JSON that keeps typed arrays (3D previews, painted labels) and Maps, for the demo's recorded app answers.
// encode() before JSON.stringify, decode() after JSON.parse.
const TYPED = ['Float32Array', 'Float64Array', 'Uint32Array', 'Uint16Array', 'Uint8Array', 'Int32Array', 'Int16Array', 'Int8Array'];

function encode(v) {
  if (v == null || typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    return { __ta: v.constructor.name, b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  }
  if (v instanceof Map) return { __map: [...v.entries()].map(([k, x]) => [encode(k), encode(x)]) };
  if (Array.isArray(v)) return v.map(encode);
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = encode(x);
  return out;
}

function decode(v) {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decode);
  if (v.__ta && TYPED.includes(v.__ta)) {
    const b = Buffer.from(v.b64, 'base64');
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    return new globalThis[v.__ta](ab);
  }
  if (v.__map) return new Map(v.__map.map(([k, x]) => [decode(k), decode(x)]));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = decode(x);
  return out;
}

module.exports = { encode, decode };
