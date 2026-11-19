// Parts that fit together (assemblies, pegs and sockets, lids, print-in-place joints) are designed and tested
// with specific settings. Changing anything that moves a wall or changes its width can stop them fitting, so for
// assemblies these settings are never changed by the advisor, whatever the AI suggests.
const FIT_CRITICAL = new Set([
  'wall_loops', 'wall_generator', 'wall_sequence', 'precise_outer_wall',
  'line_width', 'outer_wall_line_width', 'inner_wall_line_width', 'top_surface_line_width', 'initial_layer_line_width',
  'filament_flow_ratio', 'print_flow_ratio', 'filament_shrink', 'filament_shrinkage_compensation_z',
  'xy_hole_compensation', 'xy_contour_compensation', 'elefant_foot_compensation', 'elefant_foot_compensation_layers',
  'hole_to_polyhole', 'fuzzy_skin', 'fuzzy_skin_thickness', 'resolution',
]);

const ASSEMBLY_WORDS = /\b(fit|fits|fitting|assembl\w*|snap|press[- ]?fit|interlock\w*|joint|peg|pin|socket|hinge|thread\w*|screw|bolt|nut|lid|cap|insert|connector|print[- ]in[- ]place|articulat\w*|puzzle|dovetail|tab|slot)\b/i;

// several different parts (not just copies of one), or names/notes that say so
function looksLikeAssembly({ objects = [], purpose = '' } = {}) {
  const names = objects.map(o => String(o.name || '').replace(/[\s_-]*(\(\d+\)|\d+|copy.*)$/i, '').trim().toLowerCase()).filter(Boolean);
  const distinct = new Set(names);
  if (distinct.size >= 2) return true;
  const parts = objects.flatMap(o => (o.parts || []).map(p => p.name || '')).join(' ');
  return ASSEMBLY_WORDS.test(`${names.join(' ')} ${parts} ${purpose}`);
}

// drop fit-critical suggestions; returns { kept, dropped }
function guardFit(settings = [], assembly = false) {
  if (!assembly) return { kept: settings, dropped: [] };
  const kept = [], dropped = [];
  for (const s of settings) (FIT_CRITICAL.has(s.key) ? dropped : kept).push(s);
  return { kept, dropped };
}

const FIT_RULE = 'If partsFitTogether is true, the parts must fit each other: NEVER change wall_loops, line widths, flow ratio, XY hole/contour compensation, elephant foot compensation, wall generator/sequence, precise outer wall, shrinkage or fuzzy skin, because these change how the parts fit. Solve problems another way (supports, cooling, speed, orientation, layer height for looks).';

module.exports = { FIT_CRITICAL, looksLikeAssembly, guardFit, FIT_RULE };
