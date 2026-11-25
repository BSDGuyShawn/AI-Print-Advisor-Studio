// Setting combinations Snapmaker Orca refuses or "fixes" with a dialog when a project is opened.
// Rules come from Snapmaker/OrcaSlicer source:
//   GUI/ConfigManipulation.cpp  - 100% infill only with solid patterns; support style must match support type
//   libslic3r/Print.cpp         - variable layer height vs organic supports; layer height vs nozzle;
//                                 mixing high- and low-temperature filaments
// Each fix mirrors what Orca itself offers, so the saved project opens without prompts.
const fs = require('fs');
const path = require('path');
const { SCHEMA } = require('./orca-settings');
const { applyChanges } = require('./threemf');

const SOLID_PATTERNS = (SCHEMA.top_surface_pattern && SCHEMA.top_surface_pattern.enum) ||
  ['monotonic', 'monotonicline', 'rectilinear', 'alignedrectilinear', 'concentric', 'hilbertcurve', 'archimedeanchords', 'octagramspiral'];
const TREE_STYLES = ['default', 'tree_slim', 'tree_strong', 'tree_hybrid', 'organic'];
const NORMAL_STYLES = ['default', 'grid', 'snug'];
const FALLBACK_TEMP_TYPES = {
  high_temp_filament: ['ABS', 'ASA', 'PC', 'PA', 'PA-CF', 'PA-GF', 'PA6-CF', 'PET-CF', 'PETG-GF', 'PPS', 'PPS-CF', 'PPA-GF', 'PPA-CF', 'ABS-Aero', 'ABS-GF'],
  low_temp_filament: ['PLA', 'TPU', 'PLA-CF', 'PLA-AERO', 'PVA', 'BVOH', 'SBS'],
  high_low_compatible_filament: ['HIPS', 'PETG', 'PCTG', 'PE', 'PP', 'EVA', 'PE-CF', 'PP-CF', 'PP-GF', 'PHA'],
};

const first = (v, i = 0) => (Array.isArray(v) ? v[Math.min(i, v.length - 1)] : v);

// Plate type -> the filament setting holding its bed temperature (PrintConfig.hpp get_bed_temp_key).
// A temperature of 0 means the filament isn't supported on that plate; the CLI then heats the bed to 0 °C.
const BED_KEYS = {
  'Cool Plate': 'cool_plate_temp', 'Engineering Plate': 'eng_plate_temp', 'High Temp Plate': 'hot_plate_temp',
  'Textured PEI Plate': 'textured_plate_temp', 'Textured Cool Plate': 'textured_cool_plate_temp',
  'Supertack Plate': 'supertack_plate_temp', 'Graphic Effect Plate': 'graphic_effect_plate_temp',
};
const PLATE_ORDER = ['Textured PEI Plate', 'High Temp Plate', 'Engineering Plate', 'Graphic Effect Plate', 'Textured Cool Plate', 'Cool Plate', 'Supertack Plate'];
function bedTemp(ps, plate, slot) { const k = BED_KEYS[plate]; return k ? parseFloat(first(ps[k], slot - 1)) : NaN; }
// Returns null when the plate is fine, else { plate, temps } for the best supported plate.
function supportedPlate(ps, plate, usedSlots) {
  const ok = (pl) => usedSlots.every(s => bedTemp(ps, pl, s) > 0);
  if (BED_KEYS[plate] && ok(plate)) return null;
  const def = String(first(ps.default_bed_type) || require('./machine').getMachine().defaultBedType || 'Textured PEI Plate');
  const pick = [def, ...PLATE_ORDER].find(pl => BED_KEYS[pl] && ok(pl));
  return pick ? { plate: pick, temps: usedSlots.map(s => bedTemp(ps, pick, s)) } : null;
}
const num = (v) => parseFloat(String(v ?? '').replace('%', ''));

// The installed slicer's own list wins (resources/info/filament_info.json next to resources/profiles).
let tempTypesCache = null;
function tempTypes(lib) {
  if (tempTypesCache) return tempTypesCache;
  try {
    if (lib && lib.dir) {
      const j = JSON.parse(fs.readFileSync(path.join(lib.dir, '..', 'info', 'filament_info.json'), 'utf8'));
      if (j.high_temp_filament && j.low_temp_filament) return (tempTypesCache = j);
    }
  } catch {}
  return FALLBACK_TEMP_TYPES;
}

/**
 * @returns {{ fixes: Array<{key,value,slot,reason}>, problems: Array<{severity,title,detail}> }}
 * fixes are extra changes to append after the user's changes; problems can't be fixed automatically.
 */
function compatFixes({ baseSettings, changes = [], customLayering = [], usedSlots = [1], lib = null, objectCount = 1 }) {
  const fixes = [], problems = [];
  const ps = JSON.parse(JSON.stringify(baseSettings || {}));
  applyChanges(ps, changes);
  const fix = (key, value, reason) => { fixes.push({ key, value, slot: null, reason, source: 'compat' }); applyChanges(ps, [{ key, value }]); };
  // supports printed with their own toolheads (e.g. an opposite-material interface) use those toolheads too
  if (String(first(ps.enable_support)) === '1') {
    const extra = [ps.support_filament, ps.support_interface_filament].map(v => parseInt(first(v), 10)).filter(n => n > 0);
    usedSlots = [...new Set([...usedSlots, ...extra])].sort((a, b) => a - b);
  }

  // 1. 100% infill only works with the patterns that are valid top-surface patterns
  const density = num(first(ps.sparse_infill_density));
  const pattern = String(first(ps.sparse_infill_pattern) || '');
  if (density >= 100 && pattern && !SOLID_PATTERNS.includes(pattern)) {
    fix('sparse_infill_pattern', 'rectilinear', `Snapmaker Orca doesn’t allow ${pattern} at 100% infill and would ask to switch to rectilinear when opening the file.`);
  }

  // 2. support style must belong to the support type
  if (String(first(ps.enable_support)) === '1') {
    const type = String(first(ps.support_type) || 'normal(auto)');
    const isTree = type.startsWith('tree');
    let style = String(first(ps.support_style) || 'default');
    if (!(isTree ? TREE_STYLES : NORMAL_STYLES).includes(style)) {
      fix('support_style', 'default', `“${style}” isn’t a valid style for ${isTree ? 'tree' : 'normal'} supports; Orca resets it to Default.`);
      style = 'default';
    }
    // 3. organic tree supports (Orca's default tree style) can't be used with variable layer height
    if (isTree && (style === 'organic' || style === 'default') && customLayering.length) {
      fix('support_style', 'tree_hybrid', `${customLayering.join(', ')} ${customLayering.length === 1 ? 'uses' : 'use'} variable layer height, which Snapmaker Orca can’t combine with organic tree supports (its default tree style). Tree Hybrid works with variable layers.`);
    }
  }

  // 3b. several objects on the plate: label them so the printer can skip one mid-print (touchscreen Skip Objects,
  //     Fluidd/Mainsail, or Klipper's EXCLUDE_OBJECT). Needs "Exclude objects" and "Label objects".
  if (objectCount > 1) {
    if (String(first(ps.gcode_label_objects)) !== '1') fix('gcode_label_objects', '1', `Labels each of the ${objectCount} objects in the G-code so one can be skipped mid-print.`);
    if (String(first(ps.exclude_object)) !== '1') fix('exclude_object', '1', `Turns on Exclude objects so a failing part can be skipped from the printer’s screen or Fluidd/Mainsail while the other ${objectCount - 1} keep printing.`);
  }

  // 3c. the plate type must support every filament in use, or the bed is heated to 0 °C
  {
    const M = require('./machine').getMachine();
    // a printer with a single bed type: the slicer uses the High Temp Plate temperatures, whatever the file says
    if (M.supportsBedTypes === false && String(first(ps.curr_bed_type) || '') !== 'High Temp Plate') {
      fix('curr_bed_type', 'High Temp Plate', `The ${M.short || 'printer'} has one bed type, so the slicer uses its standard bed temperatures (stored as “High Temp Plate”) instead of “${first(ps.curr_bed_type) || 'none'}” from the file.`);
      ps.curr_bed_type = 'High Temp Plate';
    }
    // a project converted from another printer starts from this printer's default plate type
    if (ps.__converted && M.supportsBedTypes !== false && M.defaultBedType && String(first(ps.curr_bed_type) || '') !== M.defaultBedType) {
      fix('curr_bed_type', M.defaultBedType, `Converted from another printer, so the plate type starts from the ${M.short || 'printer'}’s default (${M.defaultBedType}).`);
      ps.curr_bed_type = M.defaultBedType;
    }
    const plate = String(first(ps.curr_bed_type) || '');
    const alt = supportedPlate(ps, plate, usedSlots);
    if (alt) {
      const why = BED_KEYS[plate]
        ? `${plate} isn’t supported by ${usedSlots.filter(sl => !(bedTemp(ps, plate, sl) > 0)).map(sl => `T${sl} ${first(ps.filament_type, sl - 1)}`).join(', ')} (its bed temperature is 0 °C, so the bed wouldn’t heat)`
        : `“${plate || 'no plate'}” has no bed temperature for these filaments`;
      fix('curr_bed_type', alt.plate, `${why}. Switched to ${alt.plate}: bed ${[...new Set(alt.temps)].join('/')} °C.`);
    }
  }

  // 3d. several toolheads in one print: idle nozzles must be kept from oozing, or every tool change leaves strings
  {
    const M = require('./machine').getMachine();
    if (M.multiMaterial === 'toolheads' && usedSlots.length > 1) {
      const ooze = String(first(ps.ooze_prevention)) === '1', prime = String(first(ps.enable_prime_tower)) === '1';
      if (!ooze && !prime) {
        fix('ooze_prevention', '1', `This print uses ${usedSlots.length} toolheads, but ooze prevention and the prime tower were both off, so idle nozzles would drip and leave strings. Turned on ooze prevention (idle nozzles cool down while they wait), as in the ${M.short || 'printer'}’s own profiles.`);
      }
      const standby = parseFloat(first(ps.standby_temperature_delta));
      if ((ooze || !prime) && Number.isFinite(standby) && standby > -40 && M.isU1) {
        fix('standby_temperature_delta', '-150', `Idle toolheads only cooled by ${-standby} °C while waiting, which lets them ooze. Set to the U1 profile’s 150 °C drop; they reheat before their turn.`);
      }
    }
  }

  // 4. layer heights can't exceed the 0.4 mm nozzle
  const nozzle = num(first(ps.nozzle_diameter)) || 0.4;
  if (num(first(ps.layer_height)) > nozzle) fix('layer_height', String(+(nozzle * 0.7).toFixed(2)), `Layer height can’t exceed the ${nozzle} mm nozzle.`);
  if (num(first(ps.initial_layer_print_height)) > nozzle) fix('initial_layer_print_height', String(+(nozzle * 0.75).toFixed(2)), `First layer height can’t exceed the ${nozzle} mm nozzle.`);

  // 5. Orca refuses to slice high-temperature and low-temperature filaments together
  const tt = tempTypes(lib);
  const types = usedSlots.map(s => String(first(ps.filament_type, s - 1) || ''));
  const high = types.filter(t => tt.high_temp_filament.includes(t));
  const low = types.filter(t => tt.low_temp_filament.includes(t));
  if (high.length && low.length) {
    problems.push({ severity: 'critical', title: 'Snapmaker Orca won’t slice these filaments together',
      detail: `${[...new Set(high)].join(', ')} and ${[...new Set(low)].join(', ')} print at very different temperatures. Pick materials from the same group, or use PETG, which Orca treats as compatible with both.` });
  }
  return { fixes, problems };
}

// changes + any fixes needed, deduplicated so the last value for a key/slot wins
function withCompat(opts) {
  const { fixes, problems } = compatFixes(opts);
  const all = [...(opts.changes || []), ...fixes];
  const map = new Map();
  for (const c of all) map.set(`${c.key}#${c.slot || 0}`, c);
  return { changes: [...map.values()], fixes, problems };
}

module.exports = { compatFixes, withCompat, SOLID_PATTERNS, BED_KEYS, supportedPlate, bedTemp };
