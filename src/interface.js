// "Support interface in the opposite material": PLA and PETG don't stick to each other, so printing the support's
// contact layers (its roof under the model, and its floor where it stands on the model) in the other material lets
// the supports come off cleanly, leaving an almost flawless surface.
//
// The catch: the model doesn't stick to that roof either, so it can slide off small support tips. The settings below
// therefore give wide, flat, solid roofs (normal grid supports, expanded past the overhang, denser base underneath)
// and no gap at all between roof and model (top Z distance 0, solid interlaced interface: Snapmaker Orca's own advice
// for support-material interfaces). The app applies these itself; the AI can't change them.

const family = (t) => (/^(PETG|PCTG|PET\b)/i.test(String(t || '').trim()) ? 'PETG' : /^PLA/i.test(String(t || '').trim()) ? 'PLA' : null);
const OPPOSITE = { PLA: 'PETG', PETG: 'PLA' };

// materials: [{ slot, type }] loaded toolheads; used: toolheads the model prints with on this plate.
// Returns { ok, modelFamily, interfaceFamily, slot, reason }.
function pickInterface(materials = [], used = []) {
  const bySlot = new Map(materials.map(m => [Number(m.slot), m]));
  const usedFams = [...new Set(used.map(s => family((bySlot.get(Number(s)) || {}).type)))];
  if (!used.length || usedFams.includes(null)) return { ok: false, reason: 'The model needs to be printed in PLA or PETG for this.' };
  if (usedFams.length > 1) return { ok: false, reason: 'The model already uses both PLA and PETG, so there is no opposite material for the supports.' };
  const modelFamily = usedFams[0], interfaceFamily = OPPOSITE[modelFamily];
  const candidates = materials.filter(m => family(m.type) === interfaceFamily).map(m => Number(m.slot));
  // a toolhead the model doesn't print with first (its color stays off the model), then any
  const slot = candidates.find(s => !used.map(Number).includes(s)) ?? candidates[0];
  if (!slot) return { ok: false, modelFamily, interfaceFamily, reason: `Load ${interfaceFamily} in a toolhead to print the support interface in it (the model is ${modelFamily}).` };
  return { ok: true, modelFamily, interfaceFamily, slot };
}

const num = (v) => parseFloat([].concat(v)[0]);

// The settings, with a reason for each. base: the project's settings (for the threshold angle).
function interfaceChanges(pick, base = {}) {
  const m = pick.modelFamily, i = pick.interfaceFamily, T = `T${pick.slot}`;
  const angle = Math.max(40, num(base.support_threshold_angle) || 0);
  return [
    { key: 'enable_support', value: '1', reason: `Supports on, with their contact layers printed in ${i} (${T}).` },
    { key: 'support_type', value: 'normal(auto)', reason: `Normal supports give wide, flat roofs. Tree supports end in small tips, and the ${m} model would slide off them because it doesn't stick to ${i}.` },
    { key: 'support_style', value: 'grid', reason: 'Grid style: stable, straight-sided supports with a full flat roof under each overhang.' },
    { key: 'support_interface_filament', value: String(pick.slot), reason: `Support interface printed in ${i} on ${T}: ${m} and ${i} don't bond, so the supports lift off cleanly.` },
    { key: 'support_filament', value: '0', reason: `The support body stays in the model's own ${m}; only the layers touching the model are ${i}.` },
    { key: 'support_interface_not_for_body', value: '1', reason: `Keeps the ${i} to the contact layers (fewer tool changes, less ${i} used).` },
    { key: 'support_top_z_distance', value: '0', reason: `No gap between the support roof and the model: the materials don't stick, so the model can sit right on the roof and its underside comes out smooth instead of droopy.` },
    { key: 'support_bottom_z_distance', value: '0', reason: 'No gap where supports stand on the model either (that floor is also the other material).' },
    { key: 'support_interface_top_layers', value: '3', reason: 'Three solid roof layers: a firm, flat surface for the model to print on.' },
    { key: 'support_interface_bottom_layers', value: '2', reason: `Where supports stand on the model, two ${i} layers too, so they don't fuse to the surface below.` },
    { key: 'support_interface_spacing', value: '0', reason: 'Solid roof (no gaps between lines), so the underside of the model is as smooth as a top surface.' },
    { key: 'support_bottom_interface_spacing', value: '0', reason: 'Solid floor where supports stand on the model.' },
    { key: 'support_interface_pattern', value: 'rectilinear_interlaced', reason: 'Interlaced lines (each layer crosses the last): a flat, stiff roof. Snapmaker Orca recommends it for support-material interfaces.' },
    { key: 'independent_support_layer_height', value: '0', reason: 'Supports use the model\'s layer heights, so the roof lines up exactly with the model (needed for a 0 mm gap).' },
    { key: 'support_expansion', value: '1.5', reason: `Roofs reach 1.5 mm past each overhang's edge, so edges are carried and the model can't slip off the ${i}.` },
    { key: 'support_base_pattern_spacing', value: '1.5', reason: 'Denser support body under the roof, so the roof doesn\'t sag between lines (a sagging roof shows on the model).' },
    { key: 'support_threshold_angle', value: String(angle), reason: `Supports overhangs up to ${angle}° from flat, so large and gently sloping overhangs rest on the clean interface instead of drooping.` },
    { key: 'enable_prime_tower', value: '1', reason: `Every roof layer swaps to ${T} and back: the prime tower cleans the nozzles so no ${i} smears onto the model.` },
  ];
}

const KEYS = new Set(interfaceChanges({ modelFamily: 'PLA', interfaceFamily: 'PETG', slot: 2 }).map(c => c.key));

// In a plan: the AI's own values for these keys are replaced by the app's.
function enforceInterface(settings = [], pick, base) {
  if (!pick || !pick.ok) return settings;
  return [...settings.filter(s => !KEYS.has(s.key)),
    ...interfaceChanges(pick, base).map(c => ({ key: c.key, recommended: c.value, slot: 0, action: 'change', priority: 'high', reason: `Clean-release supports (${pick.interfaceFamily} interface): ${c.reason}` }))];
}

const PROMPT_RULE = 'If supportInterface is given, the user chose to print the support interface in the opposite material (PLA under PETG or PETG under PLA) for clean removal. The app sets these support settings itself and will override yours: enable_support, support_type, support_style, support_filament, support_interface_filament, support_interface_not_for_body, support_top_z_distance, support_bottom_z_distance, support_interface_top_layers, support_interface_bottom_layers, support_interface_spacing, support_bottom_interface_spacing, support_interface_pattern, independent_support_layer_height, support_expansion, support_base_pattern_spacing, support_threshold_angle, enable_prime_tower. Don\'t recommend those. Do mention what it means for this model: the overhangs rest on a solid, gap-free roof the model doesn\'t stick to, so the undersides come out smooth; tall or thin supports can be knocked over more easily since the model isn\'t glued to them; a few extra tool changes per layer that has support roofs.';

module.exports = { family, pickInterface, interfaceChanges, enforceInterface, KEYS, PROMPT_RULE };
