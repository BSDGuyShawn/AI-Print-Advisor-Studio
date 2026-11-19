// Finds installed slicers from the Bambu Studio / OrcaSlicer family (Snapmaker Orca, OrcaSlicer, Bambu Studio),
// reads their bundled printer/process/filament profiles (folders of JSON, or OrcaSlicer 2.5+ packed .opc files)
// plus the user's own presets, and flattens "inherits" chains into complete configs the slicer CLI accepts.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readOpc } = require('./opc');

// Preferred filament presets per material on the Snapmaker U1 (other printers pick by material type).
const MATERIAL_PRESETS = {
  'PLA': ['Generic PLA', 'Snapmaker PLA Basic @U1'],
  'PLA Matte': ['Snapmaker PLA Matte @U1', 'Generic PLA'],
  'PLA Silk': ['Generic PLA Silk', 'Snapmaker PLA Silk @U1'],
  'PLA-CF': ['Generic PLA-CF', 'Snapmaker PLA-CF @U1 0.4 nozzle'],
  'PLA High Speed': ['Generic PLA High Speed', 'Snapmaker PLA SnapSpeed @U1'],
  'PETG': ['Generic PETG'],
  'PETG-HF': ['Generic PETG HF'],
  'PETG-CF': ['Generic PETG-CF', 'Snapmaker PETG-CF @U1 0.4 nozzle'],
  'PCTG': ['Generic PCTG'],
  'TPU': ['Generic TPU', 'Snapmaker TPU @U1 0.4 nozzle'],
  'PVA': ['Generic PVA', 'Snapmaker PVA @U1'],
  'ABS': ['Generic ABS', 'Snapmaker ABS @U1 0.4 nozzle'],
  'ASA': ['Generic ASA @U1 0.4 nozzle', 'Snapmaker ASA @U1 0.4 nozzle'],
};
const DEFAULT_MACHINE = 'Snapmaker U1 (0.4 nozzle)';
const DEFAULT_PROCESS = '0.20mm Standard @Snapmaker U1 (0.4 nozzle)';

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

// ---------- the slicers we support ----------
// kind -> how to find it and its quirks. All three share the 3MF format, settings and command line.
const SLICERS = {
  'snapmaker-orca': {
    label: 'Snapmaker Orca', defaultMachine: 'Snapmaker U1 (0.4 nozzle)', dataNames: ['Snapmaker_Orca', 'Snapmaker Orca', 'SnapmakerOrca'],
    winDir: /snapmaker.*orca|orca.*snapmaker/i, winExe: /orca.*\.exe$/i, macApps: ['Snapmaker Orca.app', 'Snapmaker_Orca.app'], linux: ['/usr/bin/snapmaker-orca'],
    cli: { allowNewer: ['--allow-newer-file'] },
  },
  'orcaslicer': {
    label: 'OrcaSlicer', defaultMachine: 'Bambu Lab X1 Carbon 0.4 nozzle', dataNames: ['OrcaSlicer'], filamentLibrary: 'OrcaFilamentLibrary',
    winDir: /^orca ?slicer/i, winExe: /^orca-?slicer\.exe$/i, macApps: ['OrcaSlicer.app'], linux: ['/usr/bin/orca-slicer', '/usr/bin/OrcaSlicer'],
    cli: { allowNewer: ['--allow-newer-file'] },
  },
  'bambu-studio': {
    label: 'Bambu Studio', defaultMachine: 'Bambu Lab X1 Carbon 0.4 nozzle', dataNames: ['BambuStudio'],
    winDir: /bambu ?studio/i, winExe: /^bambu-?studio\.exe$/i, macApps: ['BambuStudio.app', 'Bambu Studio.app'], linux: ['/usr/bin/bambu-studio'],
    cli: { allowNewer: ['--allow-newer-file'] }, // a value after a space is read as an input file name
  },
};

// Which slicer an executable is, from its path and its bundled profiles.
function slicerKindFor(exe) {
  if (!exe) return null;
  const p = exe.toLowerCase();
  if (/snapmaker/.test(p)) return 'snapmaker-orca';
  if (/bambu/.test(p)) return 'bambu-studio';
  if (/orca/.test(p)) {
    const dir = profilesDirFor(exe);
    if (dir && fs.existsSync(path.join(dir, 'Snapmaker')) && !fs.existsSync(path.join(dir, 'OrcaFilamentLibrary')) && !fs.existsSync(path.join(dir, 'OrcaFilamentLibrary.opc'))) return 'snapmaker-orca';
    return 'orcaslicer';
  }
  // a renamed or wrapped install: decide by what it ships
  const dir = profilesDirFor(exe);
  if (dir && fs.existsSync(path.join(dir, 'Snapmaker')) && fs.existsSync(path.join(dir, 'Snapmaker.json')) && !fs.readdirSync(dir).some(f => f.endsWith('.opc'))) return 'snapmaker-orca';
  if (dir && fs.readdirSync(dir).some(f => f.endsWith('.opc'))) return 'orcaslicer';
  return 'snapmaker-orca';
}

// Every supported slicer found on this computer: [{ kind, label, exe }]
function installedSlicers() {
  const out = [];
  const push = (kind, p) => { if (p && fs.existsSync(p) && !out.some(o => o.exe === p)) out.push({ kind, label: SLICERS[kind].label, exe: p }); };
  for (const [kind, s] of Object.entries(SLICERS)) {
    if (process.platform === 'win32') {
      const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
      for (const r of roots) {
        let dirs = [];
        try { dirs = fs.readdirSync(r).filter(d => s.winDir.test(d) && (kind !== 'orcaslicer' || !/snapmaker/i.test(d))); } catch {}
        for (const d of dirs) {
          let files = [];
          try { files = fs.readdirSync(path.join(r, d)); } catch {}
          for (const f of files) if (/\.exe$/i.test(f) && !/unins|crash|update|helper/i.test(f) && (s.winExe.test(f) || /orca|bambu/i.test(f))) push(kind, path.join(r, d, f));
        }
      }
    } else if (process.platform === 'darwin') {
      for (const appName of s.macApps) {
        for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
          const dir = path.join(base, appName, 'Contents/MacOS');
          // the main program, not helpers that may sit next to it in the bundle
          try { for (const f of fs.readdirSync(dir)) if (/orca|bambu/i.test(f) && !/helper|crash|update/i.test(f)) push(kind, path.join(dir, f)); } catch {}
        }
      }
    } else {
      for (const p of s.linux) push(kind, p);
    }
  }
  return out;
}
// kept for older callers: just the paths, Snapmaker Orca first
function candidateExecutables() { return installedSlicers().map(s => s.exe); }

// resources/profiles lives next to the exe on Windows, in Contents/Resources on Mac, ../resources on Linux AppImage
function profilesDirFor(exe) {
  if (!exe) return null;
  const d = path.dirname(exe);
  const tries = [path.join(d, 'resources', 'profiles'), path.join(d, '..', 'Resources', 'profiles'), path.join(d, '..', 'resources', 'profiles')];
  return tries.find(t => { try { return fs.readdirSync(t).some(v => v.endsWith('.opc') || v.endsWith('.json')); } catch { return false; } }) || null;
}

function userDataDirs(kind = 'snapmaker-orca') {
  const names = (SLICERS[kind] || SLICERS['snapmaker-orca']).dataNames;
  const bases = process.platform === 'win32' ? [process.env.APPDATA]
    : process.platform === 'darwin' ? [path.join(os.homedir(), 'Library/Application Support')]
    : [path.join(os.homedir(), '.config')];
  const out = [];
  for (const b of bases.filter(Boolean)) for (const n of names) if (fs.existsSync(path.join(b, n))) out.push(path.join(b, n));
  return out;
}

// ---------- index ----------
class ProfileLibrary {
  // machine: the printer preset to work with (defaults to the slicer's usual printer, e.g. the U1 in Snapmaker Orca)
  // cacheFile: optional path for a cached index (rebuilt when the slicer install changes)
  constructor(exe, { cacheFile, machine } = {}) {
    this.exe = exe;
    this.kind = slicerKindFor(exe);
    this.slicer = SLICERS[this.kind] || SLICERS['snapmaker-orca'];
    this.dir = profilesDirFor(exe);
    this.byType = { machine: new Map(), process: new Map(), filament: new Map() };
    this.userPresets = { machine: [], process: [], filament: [] };
    this.loadedVendors = new Set();
    this.allLoaded = false;
    this._filamentChoices = new Map();
    this.cacheFile = cacheFile;
    this._catalog = null;
    if (this.dir) {
      const stamp = this.installStamp();
      this.machine = machine || this.slicer.defaultMachine;
      const cached = cacheFile && readJson(cacheFile);
      if (cached && cached.stamp === stamp && cached.dir === this.dir && cached.machine === this.machine) {
        for (const t of ['machine', 'process', 'filament']) this.byType[t] = new Map(cached.byType[t]);
        for (const v of cached.vendors) this.loadedVendors.add(v);
      } else {
        // the printer's own brand is the likeliest place, so try it first before searching every brand
        const guess = { 'snapmaker-orca': 'Snapmaker' }[this.kind] || (/^Bambu Lab/.test(this.machine) ? 'BBL' : this.machine.split(' ')[0]);
        if (guess && this.vendors().includes(guess)) this.loadVendor(guess);
        let vendor = this.vendorOfMachine(this.machine);
        if (!vendor) { this.machine = this.slicer.defaultMachine; vendor = this.vendorOfMachine(this.machine); }
        const wanted = [vendor, this.slicer.filamentLibrary].filter(Boolean);
        for (const v of wanted) this.loadVendor(v);
        if (cacheFile) {
          try {
            fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
            fs.writeFileSync(cacheFile, JSON.stringify({ stamp, dir: this.dir, machine: this.machine, vendors: [...this.loadedVendors], byType: Object.fromEntries(Object.entries(this.byType).map(([t, m]) => [t, [...m]])) }));
          } catch {}
        }
      }
    }
    this.indexUser();
  }

  // changes when the slicer is updated
  installStamp() {
    const parts = [this.kind];
    for (const p of [this.exe, this.dir]) { try { const st = fs.statSync(p); parts.push(`${st.size}:${st.mtimeMs}`); } catch { parts.push('-'); } }
    try { parts.push(fs.readdirSync(this.dir).length); } catch {}
    return parts.join('|');
  }

  vendors() {
    try { return fs.readdirSync(this.dir).filter(v => v.endsWith('.opc') || fs.statSync(path.join(this.dir, v)).isDirectory()).map(v => v.replace(/\.opc$/, '')).filter((v, i, a) => a.indexOf(v) === i); } catch { return []; }
  }

  // Reads one vendor's presets, from <vendor>.opc (OrcaSlicer 2.5+) or <vendor>/{machine,process,filament}/*.json
  loadVendor(v) {
    if (!v || this.loadedVendors.has(v)) return;
    this.loadedVendors.add(v);
    const opc = path.join(this.dir, `${v}.opc`);
    if (fs.existsSync(opc)) {
      let pack;
      try { pack = readOpc(opc); } catch { return; }
      for (const type of ['machine', 'process', 'filament']) {
        for (const e of pack[type]) {
          if (this.byType[type].has(e.name)) continue;
          const entry = { type, ...e.config, name: e.name, __vendor: v, __file: e.sub_path }; // JSON presets carry their type; slicers check it
          if (e.inherits) entry.inherits = e.inherits;
          if (e.instantiation) entry.instantiation = e.instantiation;
          if (e.setting_id) entry.setting_id = e.setting_id;
          if (e.filament_id) entry.filament_id = e.filament_id;
          this.byType[type].set(e.name, entry);
        }
      }
      return;
    }
    for (const type of ['machine', 'process', 'filament']) {
      const dir = path.join(this.dir, v, type);
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      // include one level of subfolders (some vendors nest by family)
      const all = [];
      for (const f of files) {
        const p = path.join(dir, f);
        if (f.endsWith('.json')) all.push(p);
        else { try { if (fs.statSync(p).isDirectory()) for (const g of fs.readdirSync(p)) if (g.endsWith('.json')) all.push(path.join(p, g)); } catch {} }
      }
      for (const p of all) {
        const j = readJson(p);
        if (!j || !j.name) continue;
        if (!this.byType[type].has(j.name)) this.byType[type].set(j.name, { ...j, __vendor: v, __file: p });
      }
    }
  }
  indexSystem(vendors) { for (const v of vendors) this.loadVendor(v); } // older callers

  loadAllVendors() {
    if (this.allLoaded || !this.dir) return;
    this.allLoaded = true;
    for (const v of this.vendors()) this.loadVendor(v);
  }
  loadOtherVendors() { this.loadAllVendors(); }

  // Every printer this slicer has a profile for: [{ name, vendor }]. Cached; reading all vendors takes a few seconds.
  machineCatalog() {
    if (this._catalog) return this._catalog;
    const file = this.cacheFile ? this.cacheFile.replace(/\.json$/, '') + '-printers.json' : null;
    const stamp = this.installStamp();
    const cached = file && readJson(file);
    if (cached && cached.stamp === stamp) return (this._catalog = cached.printers);
    const printers = [];
    for (const v of this.vendors()) {
      const vjson = readJson(path.join(this.dir, `${v}.json`));
      if (vjson && Array.isArray(vjson.machine_list) && !fs.existsSync(path.join(this.dir, `${v}.opc`))) {
        // folder vendors list their presets in <vendor>.json; instantiable printers are the ones with a nozzle in the name
        for (const m of vjson.machine_list) {
          const j = readJson(path.join(this.dir, v, m.sub_path));
          if (j && j.instantiation === 'true') printers.push({ name: j.name, vendor: v });
        }
        continue;
      }
      this.loadVendor(v);
    }
    for (const [name, e] of this.byType.machine) if (e.instantiation === 'true' && e.__vendor !== 'user' && !printers.some(p => p.name === name)) printers.push({ name, vendor: e.__vendor });
    printers.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name));
    if (file) { try { fs.writeFileSync(file, JSON.stringify({ stamp, printers })); } catch {} }
    return (this._catalog = printers);
  }

  vendorOfMachine(name) {
    if (!name || !this.dir) return null;
    const hit = this.byType.machine.get(name);
    if (hit && hit.__vendor !== 'user') return hit.__vendor;
    // folder vendors: look in <vendor>.json lists; packed vendors: read the pack (fast)
    for (const v of this.vendors()) {
      const vjson = readJson(path.join(this.dir, `${v}.json`));
      if (vjson && Array.isArray(vjson.machine_list) && vjson.machine_list.some(m => m.name === name)) return v;
    }
    for (const v of this.vendors()) {
      if (!fs.existsSync(path.join(this.dir, `${v}.opc`))) continue;
      this.loadVendor(v);
      if (this.byType.machine.has(name)) return v;
    }
    return null;
  }

  indexUser() {
    for (const base of userDataDirs(this.kind)) {
      const userRoot = path.join(base, 'user');
      let accounts = [];
      try { accounts = fs.readdirSync(userRoot); } catch { continue; }
      for (const acct of accounts) {
        for (const type of ['machine', 'process', 'filament']) {
          const dir = path.join(userRoot, acct, type);
          let files = [];
          try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { continue; }
          for (const f of files) {
            const j = readJson(path.join(dir, f));
            if (!j || !j.name) continue;
            const entry = { ...j, __vendor: 'user', __file: path.join(dir, f) };
            this.userPresets[type].push(entry);
            this.byType[type].set(j.name, entry);
          }
        }
      }
    }
  }

  get available() { return !!this.dir; }

  flatten(type, name, depth = 0) {
    let p = this.byType[type].get(name);
    if (!p && !this.allLoaded) { this.loadAllVendors(); p = this.byType[type].get(name); }
    if (!p) throw new Error(`${this.slicer.label} has no ${type} preset named "${name}".`);
    let base = {};
    if (p.inherits && depth < 12) base = this.flatten(type, p.inherits, depth + 1);
    const merged = { ...base };
    for (const [k, v] of Object.entries(p)) if (!k.startsWith('__')) merged[k] = v;
    if (depth === 0) {
      delete merged.inherits;
      merged.from = 'system';
      merged.instantiation = 'true';
      merged.name = name;
    }
    return merged;
  }

  compatible(entry, machineName) {
    const cp = entry.compatible_printers;
    if (Array.isArray(cp) && cp.length) return cp.includes(machineName);
    // the shared filament library suits every printer (its base names can also exist inside a vendor's pack,
    // so this is decided before walking up the inheritance chain)
    if (this.slicer.filamentLibrary && entry.__vendor === this.slicer.filamentLibrary) return true;
    if (entry.inherits) {
      const parent = this.byType.filament.get(entry.inherits) || this.byType.process.get(entry.inherits);
      if (parent) return this.compatible(parent, machineName);
    }
    // no list: a vendor's own presets name the printer they're for; library presets suit everyone
    if (machineName === DEFAULT_MACHINE) return /U1/.test(entry.name);
    return false;
  }

  // Filament presets usable on the selected printer, grouped for the UI
  filamentChoices(machineName = this.machine) {
    if (this._filamentChoices.has(machineName)) return this._filamentChoices.get(machineName);
    const out = [];
    const brand = (this.vendorOfMachine(machineName) || '').replace(/^BBL$/, 'Bambu Lab');
    for (const [name, e] of this.byType.filament) {
      const inst = e.instantiation === 'true' || e.__vendor === 'user';
      if (!inst) continue;
      if (e.__vendor === 'OrcaFilamentLibrary' && this.kind !== 'orcaslicer') continue;
      if (!this.compatible(e, machineName)) continue;
      let type;
      try { type = [].concat(this.flatten('filament', name).filament_type || [])[0]; } catch { continue; }
      out.push({ name, type: type || 'PLA', group: e.__vendor === 'user' ? 'Your presets' : /^Generic/.test(name) ? 'Generic' : (e.__vendor === this.slicer.filamentLibrary ? 'Filament library' : brand || e.__vendor) });
    }
    out.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
    this._filamentChoices.set(machineName, out);
    return out;
  }

  processChoices(machineName = this.machine) {
    const out = [];
    for (const [name, e] of this.byType.process) {
      if (!(e.instantiation === 'true' || e.__vendor === 'user')) continue;
      if (!this.compatible(e, machineName)) continue;
      out.push(name);
    }
    return out.sort();
  }

  presetForMaterial(material, machineName = this.machine) {
    if (machineName === DEFAULT_MACHINE) for (const n of MATERIAL_PRESETS[material] || []) if (this.byType.filament.has(n)) return n;
    const want = String(material).toLowerCase().replace(/\s+/g, ' ');
    const choices = this.filamentChoices(machineName);
    const byType = choices.filter(f => f.type.toLowerCase() === want.split(' ')[0]);
    const named = choices.filter(f => f.name.toLowerCase().includes(want));
    const pick = named.find(f => /^generic/i.test(f.name)) || byType.find(f => /^generic/i.test(f.name)) || named[0] || byType[0] || choices.find(f => f.type === 'PLA') || choices[0];
    return pick ? pick.name : null;
  }

  // The printer's "standard" process preset closest to a layer height
  // A process preset's layer height: from its name ("0.08mm Extra Fine @…"), else from its settings
  // (the user's own presets can be named anything).
  layerOfProcess(name) {
    this._layerCache = this._layerCache || new Map();
    if (this._layerCache.has(name)) return this._layerCache.get(name);
    let v = null;
    const m = /^([\d.]+)\s*mm/i.exec(name);
    if (m) v = +m[1];
    else { try { const f = this.flatten('process', name); const x = parseFloat(Array.isArray(f.layer_height) ? f.layer_height[0] : f.layer_height); if (Number.isFinite(x)) v = x; } catch {} }
    if (!(v > 0.02 && v < 1)) v = null;
    this._layerCache.set(name, v);
    return v;
  }

  // Layer heights this printer has presets for (Snapmaker's and the user's own), smallest first.
  layerHeights(machineName = this.machine) {
    const set = new Set();
    for (const n of this.processChoices(machineName)) { const v = this.layerOfProcess(n); if (v) set.add(+v.toFixed(3)); }
    return [...set].sort((a, b) => a - b);
  }

  processForLayer(layer, machineName = this.machine) {
    // Vendors name their quality levels differently ("Standard", "Fine", "Optimal", "Draft"…): take the closest
    // layer height, preferring the vendor's plain preset over variants (Strength, Speed, @…Pro and so on).
    const all = this.processChoices(machineName);
    let best = this.defaultProcess(machineName), bestScore = Infinity;
    for (const n of all) {
      const lh = this.layerOfProcess(n);
      if (!lh) continue;
      const plain = /Standard|Fine|Optimal|Draft|Quality|Normal|Detail/i.test(n) && !/Strength|Speed|Support|Silent|Elegant|Lightning/i.test(n);
      const score = Math.abs(lh - layer) * 100 + (plain ? 0 : 0.5) + n.length / 1000;
      if (score < bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  defaultProcess(machineName = this.machine) {
    if (machineName === DEFAULT_MACHINE) return DEFAULT_PROCESS;
    try {
      const m = this.flatten('machine', machineName);
      if (m.default_print_profile && this.byType.process.has(m.default_print_profile)) return m.default_print_profile;
    } catch {}
    const all = this.processChoices(machineName);
    return all.find(n => /0\.20mm Standard/.test(n)) || all[0] || null;
  }

  // What the app needs to know about a printer, read from its profile.
  machineFacts(machineName = this.machine) {
    const m = this.flatten('machine', machineName);
    const first = (v) => (Array.isArray(v) ? v[0] : v);
    const pts = [].concat(m.printable_area || []).join(',').split(',').map(s => s.split('x').map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const nozzles = [].concat(m.nozzle_diameter || ['0.4']).map(Number);
    const vendor = this.vendorOfMachine(machineName) || '';
    // Most profiles switch single_extruder_multi_material on by default, so it says nothing about hardware. A
    // filament changer is assumed for Bambu printers (AMS) and printers named for one (MMU, CFS, ACE, IFS…).
    const singleNozzleMM = nozzles.length === 1 && (/BBL|Bambu/i.test(vendor) || /\b(MMU|AMS|CFS|ACE|IFS|MMS|ERCF|Box Turtle|Tradrack)\b/i.test(`${machineName} ${m.printer_model || ''}`));
    return {
      name: machineName, vendor: vendor.replace(/^BBL$/, 'Bambu Lab'), model: m.printer_model || machineName,
      bed: pts.length ? { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys), width: Math.max(...xs) - Math.min(...xs), depth: Math.max(...ys) - Math.min(...ys) } : { minX: 0, minY: 0, maxX: 256, maxY: 256, width: 256, depth: 256 },
      height: Number(first(m.printable_height)) || 250,
      nozzle: nozzles[0] || 0.4, extruders: nozzles.length,
      // how multiple filaments are printed: separate toolheads (U1, IDEX), or one nozzle with purging (AMS, MMU)
      multiMaterial: nozzles.length > 1 ? 'toolheads' : singleNozzleMM ? 'single-nozzle-purge' : 'single',
      maxTemp: Number(first(m.nozzle_temperature_range_high)) || 300,
      flavor: first(m.gcode_flavor) || 'marlin', hostType: first(m.host_type) || '',
      minLayer: Number(first(m.min_layer_height)) || 0.04, maxLayer: Number(first(m.max_layer_height)) || nozzles[0] * 0.75,
      // OrcaSlicer's rules (Plater.cpp, Preset::get_default_bed_type): plate types are only a choice on Bambu
      // printers or with support_multi_bed_types; otherwise the "High Temp Plate" temperatures apply. Without a
      // default_bed_type, Bambu X1-series default to Cool Plate and everything else to High Temp Plate.
      supportsBedTypes: /BBL|Bambu/i.test(vendor) || String(first(m.support_multi_bed_types)) === '1' || !!first(m.default_bed_type),
      defaultBedType: first(m.default_bed_type) || (/X1/i.test(`${m.printer_model || machineName}`) && /BBL|Bambu/i.test(vendor) ? 'Cool Plate' : 'High Temp Plate'),
    };
  }
}

// Snapmaker Orca's own "Allow only one instance" preference (app.single_instance in Snapmaker_Orca.conf).
function orcaSingleInstance() {
  for (const d of userDataDirs()) {
    for (const f of ['Snapmaker_Orca.conf', 'Snapmaker Orca.conf']) {
      const j = readJson(path.join(d, f));
      if (j && j.app && j.app.single_instance != null) return String(j.app.single_instance) === 'true' || j.app.single_instance === true;
    }
  }
  return false;
}

module.exports = { orcaSingleInstance, ProfileLibrary, candidateExecutables, installedSlicers, slicerKindFor, profilesDirFor, SLICERS, MATERIAL_PRESETS, DEFAULT_MACHINE, DEFAULT_PROCESS };
