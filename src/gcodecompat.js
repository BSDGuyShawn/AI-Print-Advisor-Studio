// Custom G-code written for a newer slicer than the one installed. A file made in a newer Snapmaker Orca (or Bambu
// Studio / OrcaSlicer with a newer U1 profile) carries its start G-code, and that G-code can use placeholders the
// installed Snapmaker Orca doesn't know (e.g. {min_vitrification_temperature}). The slicer then slices the whole
// model and fails at the very end ("Not a variable name"). Such G-code is swapped for the installed printer
// profile's own version.
const JSZip = require('jszip');
const schema = require('./orca-schema.json');

const MACHINE_GCODE = ['machine_start_gcode', 'machine_end_gcode', 'before_layer_change_gcode', 'layer_change_gcode', 'change_filament_gcode',
  'machine_pause_gcode', 'template_custom_gcode', 'printing_by_object_gcode', 'time_lapse_gcode', 'change_extrusion_role_gcode', 'wrapping_detection_gcode'];
const FILAMENT_GCODE = ['filament_start_gcode', 'filament_end_gcode'];
const PROCESS_GCODE = ['post_process'];
// words of the macro language itself, not settings
const SYNTAX = new Set(['if', 'elsif', 'else', 'endif', 'and', 'or', 'not', 'true', 'false', 'min', 'max', 'int', 'round', 'digits', 'zdigits', 'is_nil',
  'interpolate_table', 'local', 'global', 'one_of', 'size', 'empty', 'filament_extruder_id', 'regex', 'then', 'e', 'x', 'y', 'z', 'abs', 'sqrt', 'floor', 'ceil', 'mod']);
// placeholders the slicer fills in while writing G-code (not settings)
const RUNTIME = new Set(['current_extruder', 'next_extruder', 'previous_extruder', 'initial_extruder', 'initial_tool', 'initial_no_support_extruder', 'layer_num', 'layer_z',
  'max_layer_z', 'total_layer_count', 'layer_height', 'toolchange_z', 'toolchange_count', 'is_extruder_used', 'timestamp', 'year', 'month', 'day', 'hour', 'minute', 'second',
  'first_layer_print_min', 'first_layer_print_max', 'first_layer_print_size', 'first_layer_center_no_wipe_tower', 'print_bed_min', 'print_bed_max', 'print_bed_size',
  'first_layer_height', 'bed_temperature_initial_layer_single', 'bed_temperature_initial_layer_vector', 'overall_chamber_temperature', 'plate_name', 'print_preset',
  'filament_preset', 'printer_preset', 'physical_printer_preset', 'num_extruders', 'num_objects', 'num_instances', 'scale', 'input_filename', 'input_filename_base',
  'total_toolchanges', 'extruded_volume', 'extruded_weight', 'total_weight', 'total_cost', 'used_filament', 'outer_wall_volumetric_speed', 'retraction_distance_when_cut',
  'long_retraction_when_cut', 'last_loaded_extruder', 'flush_length', 'old_retract_length', 'new_retract_length', 'old_filament_temp', 'new_filament_temp',
  'x_after_toolchange', 'y_after_toolchange', 'z_after_toolchange', 'travel_point_1_x', 'travel_point_1_y', 'travel_point_2_x', 'travel_point_2_y', 'travel_point_3_x',
  'travel_point_3_y', 'flush_length_1', 'flush_length_2', 'flush_length_3', 'flush_length_4', 'old_filament_e_feedrate', 'new_filament_e_feedrate', 'fan_speed',
  'is_support_used', 'has_wipe_tower', 'in_head_wrap_detect_zone', 'most_used_physical_extruder_id', 'max_print_z', 'first_non_support_filaments', 'pause_at_layer']);

function identifiers(code) {
  const out = new Set();
  const s = String(code || '');
  for (const m of s.matchAll(/\{([^{}]*)\}/g)) {
    const inner = m[1].replace(/"(?:[^"\\]|\\.)*"/g, ' ');
    for (const w of inner.matchAll(/(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(w[1]);
  }
  for (const m of s.matchAll(/\[([A-Za-z_][A-Za-z0-9_]*)(?:_\d+)?\]/g)) out.add(m[1]);
  return [...out].filter(w => !SYNTAX.has(w));
}

// every name the installed slicer knows: its settings, its own profiles' G-code placeholders, and the runtime ones
function knownNames(presets) {
  const known = new Set([...Object.keys(schema.settings || {}), ...RUNTIME]);
  for (const p of presets) {
    if (!p) continue;
    for (const k of Object.keys(p)) known.add(k);
    for (const k of [...MACHINE_GCODE, ...FILAMENT_GCODE]) for (const v of [].concat(p[k] || [])) for (const w of identifiers(v)) known.add(w);
  }
  return known;
}

// settings: the file's project settings; machine: the installed printer profile (flattened); filaments: flattened
// presets per filament slot (index 0 = filament 1), may contain nulls. Returns { changed, notes, settings }.
function fixSettings(settings, { machine, filaments = [], process: proc = null }) {
  const known = knownNames([machine, proc, ...filaments]);
  const notes = [], unknownAll = new Set();
  const out = { ...settings };
  let changed = false;
  for (const key of MACHINE_GCODE) {
    if (out[key] == null) continue;
    const vals = [].concat(out[key]);
    const bad = vals.flatMap(v => identifiers(v)).filter(w => !known.has(w));
    if (!bad.length) continue;
    bad.forEach(w => unknownAll.add(w));
    out[key] = machine && machine[key] != null ? machine[key] : Array.isArray(out[key]) ? out[key].map(() => '') : '';
    changed = true; notes.push(key);
  }
  for (const key of FILAMENT_GCODE) {
    if (!Array.isArray(out[key])) continue;
    const arr = out[key].slice();
    let hit = false;
    arr.forEach((v, i) => {
      const bad = identifiers(v).filter(w => !known.has(w));
      if (!bad.length) return;
      bad.forEach(w => unknownAll.add(w));
      const f = filaments[i];
      arr[i] = f && f[key] != null ? [].concat(f[key])[0] : '';
      hit = true;
    });
    if (hit) { out[key] = arr; changed = true; notes.push(key); }
  }
  return { changed, settings: out, fields: notes, unknown: [...unknownAll] };
}

async function fixBuffer(buffer, opts) {
  const zip = await JSZip.loadAsync(buffer);
  const f = zip.file('Metadata/project_settings.config');
  if (!f) return { changed: false, buffer };
  let settings; try { settings = JSON.parse(await f.async('string')); } catch { return { changed: false, buffer }; }
  const r = fixSettings(settings, opts);
  if (!r.changed) return { changed: false, buffer };
  zip.file(f.name, JSON.stringify(r.settings, null, 4));
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { changed: true, buffer: out, settings: r.settings, fields: r.fields, unknown: r.unknown };
}

module.exports = { identifiers, fixSettings, fixBuffer, MACHINE_GCODE };
