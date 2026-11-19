// The Quality↔Speed slider picks a recipe. Each recipe starts from Snapmaker's own U1 process preset for
// that layer height (so speeds and line widths are the ones Snapmaker tuned) plus a few deliberate tweaks.
// Only layer-dependent keys are taken from the preset, so the creator's walls/infill/supports are left alone.
const { BY_KEY } = require('./orca-settings');

const RECIPES = [
  { id: 'finest', name: 'Finest', range: [0, 15], layer: 0.12, about: '0.12 mm layers, slower outer walls, aligned seam',
    tweaks: { seam_position: 'aligned', wall_generator: 'arachne' }, scale: { outer_wall_speed: 0.7, top_surface_speed: 0.8 } },
  { id: 'fine', name: 'Fine', range: [16, 38], layer: 0.16, about: '0.16 mm layers from Snapmaker’s 0.16 mm Standard profile', tweaks: {}, scale: {} },
  { id: 'balanced', name: 'Balanced', range: [39, 61], layer: null, about: 'Stock 0.20 mm Standard profile, no recipe changes', tweaks: {}, scale: {} },
  { id: 'fast', name: 'Fast', range: [62, 84], layer: 0.24, about: '0.24 mm layers from Snapmaker’s 0.24 mm Standard profile', tweaks: {}, scale: {} },
  { id: 'fastest', name: 'Fastest', range: [85, 100], layer: 0.28, about: '0.28 mm layers, 2 walls, 12% adaptive cubic infill',
    tweaks: { wall_loops: '2', sparse_infill_density: '12%', sparse_infill_pattern: 'adaptivecubic', top_shell_layers: '4', bottom_shell_layers: '3' }, scale: {} },
];

const LAYER_DEPENDENT = /^(layer_height|initial_layer_print_height|.*line_width|top_shell_layers|bottom_shell_layers|support_top_z_distance|support_bottom_z_distance)$/;
const first = (v) => (Array.isArray(v) ? v[0] : v);

// The recipes for the selected printer: Finest uses the finest layer height the printer has a preset for
// (Snapmaker's or the user's own, e.g. 0.08 mm), and Fine sits between it and the 0.20 mm standard.
function recipesFor(lib) {
  let heights = [];
  try { if (lib && lib.available) heights = lib.layerHeights().filter(h => h >= 0.04 && h < 0.2); } catch {}
  if (!heights.length) return RECIPES;
  const finest = heights[0];
  const fine = finest < 0.12 ? (heights.find(h => Math.abs(h - 0.12) < 0.011) ? 0.12 : 0.16) : 0.16;
  return RECIPES.map(r => {
    if (r.id === 'finest' && finest !== r.layer) return { ...r, layer: finest, about: `${finest} mm layers (the finest preset for this printer), slower outer walls, aligned seam` };
    if (r.id === 'fine' && fine !== r.layer) return { ...r, layer: fine, about: `${fine} mm layers from the printer’s ${fine} mm profile` };
    return r;
  });
}

function recipeFor(slider, lib = null) {
  const list = recipesFor(lib);
  return list.find(r => slider >= r.range[0] && slider <= r.range[1]) || list[2];
}

// Changes (relative to the base project settings) that apply the recipe.
function recipeChanges(recipe, baseSettings, lib) {
  const out = new Map();
  if (recipe.layer) {
    let preset = null;
    if (lib && lib.available) {
      try { preset = lib.flatten('process', lib.processForLayer(recipe.layer)); } catch {}
    }
    if (preset) {
      for (const [k, v] of Object.entries(preset)) {
        const meta = BY_KEY[k];
        if (!meta || meta.scope !== 'process') continue;
        if (!(meta.group === 'Speed' || LAYER_DEPENDENT.test(k))) continue;
        const nv = String(first(v));
        if (nv !== String(first(baseSettings[k]))) out.set(k, nv);
      }
    } else {
      out.set('layer_height', String(recipe.layer));
    }
  }
  for (const [k, f] of Object.entries(recipe.scale)) {
    const cur = parseFloat(out.get(k) ?? first(baseSettings[k]));
    if (Number.isFinite(cur)) out.set(k, String(Math.round(cur * f)));
  }
  for (const [k, v] of Object.entries(recipe.tweaks)) if (String(first(baseSettings[k])) !== v) out.set(k, v);
  return [...out.entries()].map(([key, value]) => ({ key, value, source: 'recipe' }));
}

module.exports = { RECIPES, recipesFor, recipeFor, recipeChanges };
