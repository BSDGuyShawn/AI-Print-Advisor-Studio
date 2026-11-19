// Reads OrcaSlicer 2.5+ packed vendor profiles (<vendor>.opc), which replaced the folders of JSON presets.
// Format (OrcaSlicer src/libslic3r/PresetCacheFormat.cpp, CACHE_VERSION 2), all little-endian cereal binary:
//   header: u32 magic "ORCZ" (0x4F52435A), u32 version, u64 body size, u32 crc32
//   body:   u32 version, string vendor name, string vendor version,
//           dictionary: vector<string> keys, vector<u16> types, vector<string> enum names,
//           vendor block (printer models etc., not needed here),
//           process entries, filament entries, machine entries, u64 parse_errors
//   entry:  string name, string sub_path, config, string inherits, vector<string> includes, string description,
//           string instantiation, string setting_id, string filament_id, vector<string> renamed_from
//   config: u32 count, then per option u16 key index + value (enums: u32 n, then u16 name index [+ i32 raw if 0])
// Values are returned the way Orca's JSON profiles store them (strings, vectors as arrays of strings), so the
// rest of the app can treat .opc and .json profiles alike.
const fs = require('fs');

const T = { float: 1, int: 2, string: 3, percent: 4, floatOrPercent: 5, point: 6, point3: 7, bool: 8, enum: 9, VEC: 0x4000 };

class Reader {
  constructor(buf, pos = 0) { this.b = buf; this.p = pos; }
  need(n) { if (this.p + n > this.b.length) throw new Error('past end'); }
  u8() { this.need(1); return this.b[this.p++]; }
  u16() { this.need(2); const v = this.b.readUInt16LE(this.p); this.p += 2; return v; }
  u32() { this.need(4); const v = this.b.readUInt32LE(this.p); this.p += 4; return v; }
  i32() { this.need(4); const v = this.b.readInt32LE(this.p); this.p += 4; return v; }
  u64() { this.need(8); const v = this.b.readBigUInt64LE(this.p); this.p += 8; if (v > 50_000_000n) throw new Error('size out of range'); return Number(v); }
  f64() { this.need(8); const v = this.b.readDoubleLE(this.p); this.p += 8; return v; }
  str() { const n = this.u64(); this.need(n); const s = this.b.toString('utf8', this.p, this.p + n); this.p += n; return s; }
  vec(fn) { const n = this.u64(); const out = new Array(n); for (let i = 0; i < n; i++) out[i] = fn(); return out; }
}

// numbers the way Orca writes them in JSON (no trailing zeros)
const num = (v) => (Number.isFinite(v) ? String(+v.toPrecision(12)) : (Number.isNaN(v) ? 'nil' : String(v)));
const pct = (v) => `${num(v)}%`;

function readValue(r, type, dict) {
  switch (type) {
    case T.float: return num(r.f64());
    case T.float | T.VEC: return r.vec(() => num(r.f64()));
    case T.int: return String(r.i32());
    case T.int | T.VEC: return r.vec(() => { const v = r.i32(); return v === 2147483647 ? 'nil' : String(v); });
    case T.string: return r.str();
    case T.string | T.VEC: return r.vec(() => r.str());
    case T.percent: return pct(r.f64());
    case T.percent | T.VEC: return r.vec(() => pct(r.f64()));
    case T.floatOrPercent: { const v = r.f64(); return r.u8() ? pct(v) : num(v); }
    case T.floatOrPercent | T.VEC: return r.vec(() => { const v = r.f64(); return r.u8() ? pct(v) : num(v); });
    case T.point: { const x = r.f64(), y = r.f64(); return `${num(x)}x${num(y)}`; }
    case T.point | T.VEC: return r.vec(() => { const x = r.f64(), y = r.f64(); return `${num(x)}x${num(y)}`; });
    case T.point3: { const x = r.f64(), y = r.f64(), z = r.f64(); return `${num(x)}x${num(y)}x${num(z)}`; }
    case T.bool: return r.u8() ? '1' : '0';
    case T.bool | T.VEC: return r.vec(() => (r.u8() ? '1' : '0'));
    case T.enum: case T.enum | T.VEC: {
      const n = r.u32();
      const vals = [];
      for (let i = 0; i < n; i++) {
        const idx = r.u16(); if (idx >= dict.enums.length) throw new Error('enum index');
        if (idx === 0) { const raw = r.i32(); vals.push(raw === 2147483647 ? 'nil' : String(raw)); } // INT_MAX marks an unset (nullable) value
        else vals.push(dict.enums[idx]);
      }
      return type === T.enum ? vals[0] : vals;
    }
    case 10 | T.VEC: return r.vec(() => r.vec(() => { const x = r.f64(), y = r.f64(); return `${num(x)}x${num(y)}`; }).join(','));
    case 11 | T.VEC: return r.vec(() => r.vec(() => String(r.i32())).join(','));
    default: throw new Error(`unknown option type ${type}`);
  }
}

function readConfig(r, dict) {
  const n = r.u32();
  if (n > 5000) throw new Error('config too large');
  const out = {};
  for (let i = 0; i < n; i++) {
    const idx = r.u16();
    if (idx >= dict.keys.length) throw new Error('key index');
    out[dict.keys[idx]] = readValue(r, dict.types[idx], dict);
  }
  return out;
}

function readEntries(r, dict) {
  const n = r.u32();
  if (n > 100000) throw new Error('entry count');
  const out = [];
  for (let i = 0; i < n; i++) {
    const name = r.str(), sub_path = r.str();
    const config = readConfig(r, dict);
    const e = { name, sub_path, config, inherits: r.str(), includes: r.vec(() => r.str()), description: r.str(), instantiation: r.str(), setting_id: r.str(), filament_id: r.str(), renamed_from: r.vec(() => r.str()) };
    out.push(e);
  }
  return out;
}

function readOpc(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x4F52435A) throw new Error(`${file} is not an OrcaSlicer profile pack`);
  const version = buf.readUInt32LE(4);
  if (version !== 2) throw new Error(`unsupported profile pack version ${version}`);
  const body = buf.subarray(20, 20 + Number(buf.readBigUInt64LE(8)));
  const r = new Reader(body);
  if (r.u32() !== 2) throw new Error('unsupported body version');
  const vendor = r.str(), vendorVersion = r.str();
  const dict = { keys: r.vec(() => r.str()), types: r.vec(() => r.u16()), enums: r.vec(() => r.str()) };
  if (dict.keys.length !== dict.types.length) throw new Error('bad dictionary');
  // The vendor block isn't needed; the entries are found by trying start positions after it until a parse lands
  // exactly on the end of the body, which only the true start does.
  const after = r.p;
  for (let start = after; start < Math.min(body.length, after + 4_000_000); start++) {
    try {
      const rr = new Reader(body, start);
      const process = readEntries(rr, dict), filament = readEntries(rr, dict), machine = readEntries(rr, dict);
      rr.u64(); // parse_errors
      if (rr.p !== body.length) continue;
      return { vendor, vendorVersion, process, filament, machine };
    } catch { /* not the start */ }
  }
  throw new Error(`could not read the presets in ${file}`);
}

module.exports = { readOpc };
