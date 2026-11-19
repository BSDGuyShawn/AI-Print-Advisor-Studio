// Plain rule checks run on the final settings before anything is saved or sliced.
// They catch mistakes regardless of where a value came from (Claude, a recipe, or a hand edit).
const { applyChanges } = require('./threemf');
const { BED_KEYS } = require('./compat');

const { getMachine } = require('./machine');
const HOTEND_MAX_FLOW = 32;   // mm³/s, Snapmaker U1 spec (other printers: the filament preset's rated maximum)
// the selected printer's limits; unknown hotend flow falls back to each filament preset's own maximum
const limits = () => { const M = getMachine(); return { flow: M.hotendMaxFlow || Infinity, nozzle: M.maxTemp || 300, bed: M.maxBed || 120, name: M.short || 'printer', M }; };
const NOZZLE = 0.4;

// Typical ranges on textured PEI. Keys are matched by prefix of the filament type.
const MATERIAL = [
  { match: /^PETG|^PCTG/, nozzle: [225, 270], bed: [60, 90], fanMax: 70 },
  { match: /^PLA/, nozzle: [190, 235], bed: [45, 70], fanMin: 40 },
  { match: /^TPU|^PEBA/, nozzle: [200, 250], bed: [30, 60] },
  { match: /^ABS|^ASA/, nozzle: [235, 280], bed: [85, 100], fanMax: 50 },
  { match: /^PVA|^BVOH/, nozzle: [180, 230], bed: [40, 65] },
  { match: /^PA|^PC/, nozzle: [250, 300], bed: [80, 100], fanMax: 40 },
];
const first = (v, i = 0) => (Array.isArray(v) ? v[Math.min(i, v.length - 1)] : v);
const num = (v) => parseFloat(String(v ?? '').replace('%', ''));

function lineWidth(ps, key) {
  const raw = String(first(ps[key]) ?? '');
  if (!raw || raw === '0' || raw === '0%') return lineWidth(ps, 'line_width') || NOZZLE * 1.05;
  if (raw.endsWith('%')) return (num(raw) / 100) * NOZZLE;
  return num(raw) || NOZZLE * 1.05;
}

function runChecks({ baseSettings, changes = [], usedSlots = [1], totals = null, sliceResult = null }) {
  const ps = JSON.parse(JSON.stringify(baseSettings || {}));
  applyChanges(ps, changes);
  const out = [];
  const add = (severity, title, detail, keys = []) => out.push({ severity, title, detail, keys });

  const lh = num(first(ps.layer_height));
  const flh = num(first(ps.initial_layer_print_height));
  if (lh && (lh < NOZZLE * 0.15 || lh > NOZZLE * 0.8)) add('warn', 'Layer height outside the nozzle’s range', `${lh} mm on a 0.4 mm nozzle; stay between 0.06 and 0.32 mm.`, ['layer_height']);
  if (flh && (flh < 0.1 || flh > 0.35)) add('warn', 'Unusual first layer height', `${flh} mm. 0.2–0.3 mm sticks most reliably.`, ['initial_layer_print_height']);

  // volumetric flow per speed setting, against each used filament's cap and the hotend
  const speeds = [['outer_wall_speed', 'outer_wall_line_width'], ['inner_wall_speed', 'inner_wall_line_width'], ['sparse_infill_speed', 'sparse_infill_line_width'],
    ['internal_solid_infill_speed', 'internal_solid_infill_line_width'], ['top_surface_speed', 'top_surface_line_width']];
  if (lh) {
    for (const slot of usedSlots) {
      const i = slot - 1;
      const L = limits();
      const mvs = num(first(ps.filament_max_volumetric_speed, i)) || (Number.isFinite(L.flow) ? L.flow : HOTEND_MAX_FLOW);
      const cap = Math.min(mvs, L.flow);
      const over = [];
      // Stock profiles deliberately set speeds above the filament cap (Orca slows them automatically),
      // so only flag speeds that this plan raises.
      const raised = new Set(changes.map(c => c.key));
      for (const [sk, wk] of speeds) {
        if (!raised.has(sk)) continue;
        const sp = num(first(ps[sk]));
        if (!sp) continue;
        const flow = sp * lh * lineWidth(ps, wk);
        if (flow > cap * 1.02) over.push(`${sk.replace(/_speed$/, '').replace(/_/g, ' ')} ${sp} mm/s needs ${flow.toFixed(1)} mm³/s (Orca will slow it to about ${Math.floor(cap / (lh * lineWidth(ps, wk)))} mm/s)`);
      }
      if (over.length) add(mvs > L.flow ? 'warn' : 'info', `T${slot}: raised speeds exceed the ${cap} mm³/s flow limit`, `${over.join('; ')}. The slicer caps these automatically, so raising them saves no time.`, speeds.map(s => s[0]));
    }
  }

  // temperatures and cooling per material
  const bedTemps = [];
  for (const slot of usedSlots) {
    const i = slot - 1;
    const type = String(first(ps.filament_type, i) || '');
    const m = MATERIAL.find(x => x.match.test(type));
    const bedKey = BED_KEYS[String(first(ps.curr_bed_type) || '')] || 'textured_plate_temp';
    const nt = num(first(ps.nozzle_temperature, i)), bt = num(first(ps[bedKey], i));
    const L2 = limits();
    if (nt > L2.nozzle) add('critical', `T${slot}: nozzle above ${L2.nozzle} °C`, `${nt} °C exceeds the ${L2.name} hotend maximum.`, ['nozzle_temperature']);
    if (bt > L2.bed) add('critical', `T${slot}: bed above ${L2.bed} °C`, `${bt} °C exceeds the ${L2.name} bed maximum.`, ['hot_plate_temp']);
    if (bt) bedTemps.push([slot, type, bt]);
    if (!m) continue;
    // Vendor presets are tuned for the printer; only judge values this plan changes for this toolhead.
    const changed = (key) => changes.some(c => c.key === key && (c.slot || 1) === slot);
    if (nt && changed('nozzle_temperature') && (nt < m.nozzle[0] || nt > m.nozzle[1])) add('warn', `T${slot}: ${type} nozzle temperature looks off`, `${nt} °C; ${type} usually prints at ${m.nozzle[0]}–${m.nozzle[1]} °C.`, ['nozzle_temperature']);
    if (bt && (changed('hot_plate_temp') || changed(bedKey)) && (bt < m.bed[0] || bt > m.bed[1])) add('warn', `T${slot}: ${type} bed temperature looks off`, `${bt} °C; ${type} usually wants ${m.bed[0]}–${m.bed[1]} °C on textured PEI.`, ['hot_plate_temp']);
    const fmax = num(first(ps.fan_max_speed, i)), fmin = num(first(ps.fan_min_speed, i));
    if (m.fanMax && changed('fan_max_speed') && fmax > m.fanMax) add('warn', `T${slot}: a lot of part cooling for ${type}`, `Max fan ${fmax}%. ${type} layer bonding suffers above about ${m.fanMax}%.`, ['fan_max_speed']);
    if (m.fanMin && changed('fan_min_speed') && fmin && fmin < m.fanMin) add('info', `T${slot}: low cooling for ${type}`, `Min fan ${fmin}%. PLA overhangs and bridges look better with more cooling.`, ['fan_min_speed']);
  }
  const bedSet = [...new Set(bedTemps.map(b => b[2]))];
  if (bedSet.length > 1) add('info', 'Toolheads want different bed temperatures', `${bedTemps.map(([s, t, b]) => `T${s} ${t} ${b} °C`).join(', ')}. The bed runs at one temperature (the first layer’s filament), so the other material prints off its ideal.`, ['hot_plate_temp']);

  // structure
  const pattern = String(first(ps.sparse_infill_pattern) || '');
  if (pattern === 'lightning' && totals && totals.flatTopAreaCm2 > 2) add('warn', 'Lightning infill under large flat tops', `${totals.flatTopAreaCm2} cm² of flat top surface would bridge over sparse lightning branches and can sag. Adaptive cubic saves similar material without that.`, ['sparse_infill_pattern']);
  const walls = num(first(ps.wall_loops));
  if (walls && walls < 2) add('warn', 'Only one wall', 'Single walls leak, look rough and are weak. Use at least 2.', ['wall_loops']);
  const support = String(first(ps.enable_support)) === '1';
  if (totals) {
    if (!support && totals.overhangPercent45 > 5) add('warn', 'Overhangs without supports', `${totals.overhangPercent45}% of the surface (${totals.overhangAreaBelow45Cm2} cm²) is steeper than 45° and support is off.`, ['enable_support']);
    if (support && totals.overhangAreaBelow45Cm2 < 0.3) add('info', 'Supports may be unnecessary', 'Almost no surface is steeper than 45°.', ['enable_support']);
    if (totals.partlyOffPlate && totals.partlyOffPlate.length) add('info', 'Moved onto the plate', `${totals.partlyOffPlate.join(', ')} ${totals.partlyOffPlate.length === 1 ? 'hangs' : 'hang'} over the edge of the plate, which Orca won’t slice. The app slides ${totals.partlyOffPlate.length === 1 ? 'it' : 'them'} fully onto the plate when slicing and saving.`);
    if (!totals.fitsBuildVolume) add('critical', 'Larger than the build volume', `The plate measures ${totals.sizeMm.x} × ${totals.sizeMm.y} × ${totals.sizeMm.z} mm; the ${limits().name} prints ${limits().M.bed.width} × ${limits().M.bed.depth} × ${limits().M.height} mm.`);
    const brim = String(first(ps.brim_type) || '');
    if (totals.tipRatio > 5 && (brim === 'no_brim' || brim === '')) add('warn', 'Tall, narrow part without a brim', `Height-to-base ratio ${totals.tipRatio}:1. A brim or mouse ears help it stay put.`, ['brim_type']);
  }
  const ironing = String(first(ps.ironing_type) || 'no ironing');
  if (ironing !== 'no ironing' && usedSlots.some(s => /^PETG/.test(String(first(ps.filament_type, s - 1))))) add('info', 'Ironing with PETG', 'PETG tends to string and smear when ironed. Check the top surface on the first print.', ['ironing_type']);
  {
    const travel = num(first(ps.travel_speed)), maxX = num(first(ps.machine_max_speed_x));
    if (travel && maxX && travel > maxX * 1.01) add('warn', 'Travel speed above the printer’s limit', `Travel is set to ${travel} mm/s but the ${limits().name} moves at most ${maxX} mm/s. Settings this fast usually come from another printer’s profile; check the printer and process presets.`, ['travel_speed']);
  }
  const stz = num(first(ps.support_top_z_distance));
  if (support && stz && lh && Math.abs(stz / lh - Math.round(stz / lh)) > 0.05) add('info', 'Support gap is not a whole number of layers', `${stz} mm with ${lh} mm layers. The slicer rounds it, which changes how easily supports peel off.`, ['support_top_z_distance']);

  // real slice results
  if (sliceResult) {
    for (const w of sliceResult.warnings || []) add('warn', 'Snapmaker Orca warning', w);
    const g = sliceResult.gcode;
    if (g && Number.isFinite(limits().flow) && g.peakFlowP95 > limits().flow) add('critical', 'G-code exceeds the hotend flow', `Peak flow ${g.peakFlowP95} mm³/s is above the ${limits().name} hotend’s ${limits().flow} mm³/s.`);
  }
  const order = { critical: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

module.exports = { runChecks, HOTEND_MAX_FLOW };
