// The printer the app is working for. Set once the slicer's profiles are loaded (main.js), read by the
// geometry, safety-check and slicing code instead of fixed Snapmaker U1 numbers. Defaults to the U1.
const U1 = {
  name: 'Snapmaker U1 (0.4 nozzle)', vendor: 'Snapmaker', model: 'Snapmaker U1', short: 'U1',
  bed: { minX: 0, minY: 0, maxX: 270, maxY: 270, width: 270, depth: 270 }, height: 270,
  nozzle: 0.4, extruders: 4, multiMaterial: 'toolheads', maxTemp: 300, maxBed: 100, hotendMaxFlow: 32,
  flavor: 'klipper', hostType: 'octoprint', minLayer: 0.04, maxLayer: 0.3, defaultBedType: 'Textured PEI Plate',
};
let current = U1;

// a short name people use for the printer ("U1", "X1 Carbon", "MK4"), for messages
function shortName(f) {
  return String(f.model || f.name).replace(/^(Snapmaker|Bambu Lab|Prusa|Creality|Elegoo|Anycubic|Qidi|QIDI|Sovol|Voron|Flashforge)\s+/i, '').replace(/\s*\([^)]*nozzle\)|\s+[\d.]+ nozzle$/i, '').trim() || f.name;
}

function setMachine(facts) {
  current = { ...U1, ...facts, bed: { ...U1.bed, ...(facts && facts.bed) } };
  current.short = shortName(current);
  current.isU1 = /Snapmaker U1/i.test(current.name);
  if (!facts || facts.hotendMaxFlow == null) current.hotendMaxFlow = current.isU1 ? 32 : null; // unknown for others: judged per filament preset
  return current;
}
const getMachine = () => current;
setMachine(U1);

module.exports = { setMachine, getMachine, U1 };
