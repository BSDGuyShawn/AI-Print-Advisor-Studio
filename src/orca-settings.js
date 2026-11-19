// Settings Claude may change. Built from src/orca-schema.json (generated from Snapmaker Orca's
// PrintConfig.cpp/Preset.cpp by tools/extract-schema.py) plus hand-written labels and menu paths
// for the most common settings.
const SCHEMA = require('./orca-schema.json').settings;

// Curated: friendlier labels, groups and where to find them in Orca.
const CURATED = {
  layer_height: ['Layer height', 'Quality', 'Process > Quality > Layer height'],
  initial_layer_print_height: ['First layer height', 'Quality', 'Process > Quality > Layer height'],
  line_width: ['Default line width', 'Quality', 'Process > Quality > Line width'],
  outer_wall_line_width: ['Outer wall line width', 'Quality', 'Process > Quality > Line width'],
  seam_position: ['Seam position', 'Quality', 'Process > Quality > Seam'],
  wall_generator: ['Wall generator', 'Quality', 'Process > Quality > Wall generator'],
  detect_thin_wall: ['Detect thin walls', 'Quality', 'Process > Quality > Wall generator'],
  ironing_type: ['Ironing', 'Quality', 'Process > Quality > Ironing'],
  elefant_foot_compensation: ['Elephant foot compensation', 'Quality', 'Process > Quality > Precision'],
  fuzzy_skin: ['Fuzzy skin', 'Quality', 'Process > Others > Fuzzy skin'],
  wall_loops: ['Wall loops', 'Strength', 'Process > Strength > Walls'],
  top_shell_layers: ['Top shell layers', 'Strength', 'Process > Strength > Top/bottom shells'],
  bottom_shell_layers: ['Bottom shell layers', 'Strength', 'Process > Strength > Top/bottom shells'],
  top_shell_thickness: ['Top shell thickness', 'Strength', 'Process > Strength > Top/bottom shells'],
  top_surface_pattern: ['Top surface pattern', 'Strength', 'Process > Strength > Top/bottom shells'],
  sparse_infill_density: ['Infill density', 'Strength', 'Process > Strength > Infill'],
  sparse_infill_pattern: ['Infill pattern', 'Strength', 'Process > Strength > Infill'],
  only_one_wall_top: ['Only one wall on top surfaces', 'Strength', 'Process > Quality > Walls and surfaces'],
  infill_combination: ['Infill combination', 'Strength', 'Process > Strength > Advanced'],
  ensure_vertical_shell_thickness: ['Ensure vertical shell thickness', 'Strength', 'Process > Strength > Advanced'],
  outer_wall_speed: ['Outer wall speed', 'Speed', 'Process > Speed'],
  inner_wall_speed: ['Inner wall speed', 'Speed', 'Process > Speed'],
  sparse_infill_speed: ['Sparse infill speed', 'Speed', 'Process > Speed'],
  internal_solid_infill_speed: ['Internal solid infill speed', 'Speed', 'Process > Speed'],
  top_surface_speed: ['Top surface speed', 'Speed', 'Process > Speed'],
  initial_layer_speed: ['First layer speed', 'Speed', 'Process > Speed > First layer'],
  gap_infill_speed: ['Gap infill speed', 'Speed', 'Process > Speed'],
  travel_speed: ['Travel speed', 'Speed', 'Process > Speed > Travel'],
  default_acceleration: ['Normal printing acceleration', 'Speed', 'Process > Speed > Acceleration'],
  outer_wall_acceleration: ['Outer wall acceleration', 'Speed', 'Process > Speed > Acceleration'],
  enable_overhang_speed: ['Slow down for overhangs', 'Speed', 'Process > Speed > Overhang speed'],
  enable_support: ['Enable support', 'Support', 'Process > Support'],
  support_type: ['Support type', 'Support', 'Process > Support'],
  support_style: ['Support style', 'Support', 'Process > Support'],
  support_threshold_angle: ['Support threshold angle', 'Support', 'Process > Support'],
  support_on_build_plate_only: ['Support on build plate only', 'Support', 'Process > Support'],
  support_top_z_distance: ['Support top Z distance', 'Support', 'Process > Support > Advanced'],
  support_interface_top_layers: ['Support top interface layers', 'Support', 'Process > Support > Advanced'],
  support_filament: ['Support/raft base toolhead', 'Support', 'Process > Support > Filament for supports'],
  support_interface_filament: ['Support interface toolhead', 'Support', 'Process > Support > Filament for supports'],
  brim_type: ['Brim type', 'Adhesion', 'Process > Others > Bed adhesion'],
  brim_width: ['Brim width', 'Adhesion', 'Process > Others > Bed adhesion'],
  skirt_loops: ['Skirt loops', 'Adhesion', 'Process > Others > Skirt'],
  raft_layers: ['Raft layers', 'Adhesion', 'Process > Support > Raft'],
  enable_prime_tower: ['Enable prime tower', 'Multi-color', 'Process > Multimaterial > Prime tower'],
  prime_tower_width: ['Prime tower width', 'Multi-color', 'Process > Multimaterial > Prime tower'],
  prime_volume: ['Prime volume', 'Multi-color', 'Process > Multimaterial > Prime tower'],
  flush_into_infill: ['Flush into infill', 'Multi-color', 'Process > Multimaterial > Flush options'],
  flush_into_objects: ['Flush into objects', 'Multi-color', 'Process > Multimaterial > Flush options'],
  ooze_prevention: ['Ooze prevention', 'Multi-color', 'Process > Multimaterial > Ooze prevention'],
  standby_temperature_delta: ['Standby temperature delta', 'Multi-color', 'Process > Multimaterial > Ooze prevention'],
  nozzle_temperature: ['Nozzle temperature', 'Filament', 'Filament > Temperature'],
  nozzle_temperature_initial_layer: ['Nozzle temp (first layer)', 'Filament', 'Filament > Temperature'],
  hot_plate_temp: ['Bed temperature', 'Filament', 'Filament > Temperature > Bed'],
  hot_plate_temp_initial_layer: ['Bed temp (first layer)', 'Filament', 'Filament > Temperature > Bed'],
  filament_max_volumetric_speed: ['Max volumetric speed', 'Filament', 'Filament > Basic information'],
  fan_min_speed: ['Part fan min speed', 'Filament', 'Filament > Cooling'],
  fan_max_speed: ['Part fan max speed', 'Filament', 'Filament > Cooling'],
  overhang_fan_speed: ['Overhang fan speed', 'Filament', 'Filament > Cooling'],
  close_fan_the_first_x_layers: ['No cooling for first N layers', 'Filament', 'Filament > Cooling'],
  slow_down_layer_time: ['Min layer time (slow down)', 'Filament', 'Filament > Cooling'],
  filament_flow_ratio: ['Flow ratio', 'Filament', 'Filament > Basic information'],
};

const EXCLUDE = /gcode|filename|post_process|notes|compatible|inherits|_settings_id$|wipe_tower_[xy]$|thumbnail|timelapse|exclude_object|^printer_|^machine_|host|_url|_api|preset|^name$|^version$|^from$|setting_id|filament_ids|filament_vendor|filament_cost|filament_density|filament_diameter|filament_colour|filament_type$|filament_soluble|filament_is_support|extruder_colour|^wipe_tower_filament$|bed_custom|bed_exclude|printable_area|printable_height|extruder_offset|nozzle_diameter|_variant$|process_flow_support|role_based_wipe|template_custom|calib|print_flow_ratio|counterbore|retract|chamber|activate_air|complete_print|during_print_exhaust|pressure_advance|adaptive_pressure|filament_shrink|filament_loading|filament_unloading|filament_multitool_ramming|filament_ramming|filament_cooling|filament_minimal_purge|filament_stamping|filament_toolchange|filament_dev|required_nozzle_HRC|temperature_vitrification|idle_temperature|textured_|cool_plate|eng_plate|supertack|_plate_temp_initial_layer$|_plate_temp$/;
const KEEP_TYPES = new Set(['coFloat', 'coFloats', 'coInt', 'coInts', 'coPercent', 'coPercents', 'coFloatOrPercent', 'coFloatsOrPercents', 'coBool', 'coBools', 'coEnum']);
const GROUP_BY_CATEGORY = { Quality: 'Quality', Strength: 'Strength', Speed: 'Speed', Support: 'Support', Others: 'Other', Multimaterial: 'Multi-color', Extruders: 'Multi-color' };

function labelFor(key, s) {
  let l = s.full_label || s.label || key;
  if (!s.full_label && /^(Other layers|Initial layer|First layer|Default|Type|Style|Width|Enable|Length|Speed|Threshold)$/i.test(l)) l = key.replace(/_/g, ' ');
  if (s.sidetext === 'mm/s' && !/speed/i.test(l)) l += ' speed';
  if (s.sidetext === 'mm/s²' && !/accel/i.test(l)) l += ' acceleration';
  return l.charAt(0).toUpperCase() + l.slice(1);
}
function unitFor(s) {
  if (s.type === 'coBool' || s.type === 'coBools') return '0 or 1';
  return s.sidetext || '';
}

const CATALOG = [];
for (const [key, s] of Object.entries(SCHEMA)) {
  const cur = CURATED[key];
  const scope = s.scope === 'filament' ? 'filament' : s.scope === 'process' ? 'process' : null;
  if (!scope) continue;
  if (!cur && (!KEEP_TYPES.has(s.type) || EXCLUDE.test(key))) continue;
  CATALOG.push({
    key, scope, type: s.type,
    label: cur ? cur[0] : labelFor(key, s),
    group: cur ? cur[1] : scope === 'filament' ? 'Filament' : (GROUP_BY_CATEGORY[s.category] || 'Other'),
    gui: cur ? cur[2] : `${scope === 'filament' ? 'Filament' : 'Process'}${s.category ? ` > ${s.category}` : ''} > ${s.full_label || s.label || key}`,
    unit: unitFor(s), options: s.enum, min: s.min, max: s.max, tooltip: s.tooltip || '', curated: !!cur,
  });
}
for (const [key, c] of Object.entries(CURATED)) {
  if (!CATALOG.find(x => x.key === key)) CATALOG.push({ key, scope: c[1] === 'Filament' ? 'filament' : 'process', type: 'unknown', label: c[0], group: c[1], gui: c[2], unit: '', curated: true });
}
CATALOG.sort((a, b) => (b.curated - a.curated) || a.key.localeCompare(b.key));
const BY_KEY = Object.fromEntries(CATALOG.map(s => [s.key, s]));
const FILAMENT_KEYS = Object.entries(SCHEMA).filter(([, s]) => s.scope === 'filament').map(([k]) => k);
const PROCESS_KEYS = Object.entries(SCHEMA).filter(([, s]) => s.scope === 'process').map(([k]) => k);

// Returns an error string, or null when the value is valid for the setting.
function validate(key, raw) {
  const s = BY_KEY[key];
  if (!s) return 'Unknown setting';
  const v = String(raw ?? '').trim();
  if (v === '') return 'Enter a value';
  const num = /^-?\d+(\.\d+)?$/;
  const range = (n) => {
    if (s.min != null && n < s.min) return `Must be at least ${s.min}`;
    if (s.max != null && n > s.max) return `Must be at most ${s.max}`;
    return null;
  };
  switch (s.type) {
    case 'coBool': case 'coBools':
      return v === '0' || v === '1' ? null : 'Use 1 (on) or 0 (off)';
    case 'coInt': case 'coInts':
      return /^-?\d+$/.test(v) ? range(+v) : 'Whole number only';
    case 'coFloat': case 'coFloats':
      return num.test(v) ? range(+v) : 'Number only';
    case 'coPercent': case 'coPercents': {
      const n = v.replace(/%$/, '');
      return num.test(n) ? range(+n) : 'Number or percentage, like 15%';
    }
    case 'coFloatOrPercent': case 'coFloatsOrPercents':
      return num.test(v.replace(/%$/, '')) ? null : 'Number (mm) or percentage';
    case 'coEnum':
      return !s.options || s.options.includes(v) ? null : `Use one of: ${s.options.slice(0, 12).join(', ')}${s.options.length > 12 ? '…' : ''}`;
    default:
      return null;
  }
}

// Orca stores percent types with the % sign
function normalize(key, raw) {
  const s = BY_KEY[key];
  let v = String(raw).trim();
  if (s && (s.type === 'coPercent' || s.type === 'coPercents') && /^-?[\d.]+$/.test(v)) v += '%';
  return v;
}

const CONTEXT_KEYS = [
  'printer_settings_id', 'print_settings_id', 'filament_settings_id', 'printer_model',
  'filament_type', 'filament_colour', 'nozzle_diameter', 'curr_bed_type', 'version', 'different_settings_to_system',
];

module.exports = { CATALOG, BY_KEY, CURATED, CONTEXT_KEYS, SCHEMA, FILAMENT_KEYS, PROCESS_KEYS, validate, normalize };
