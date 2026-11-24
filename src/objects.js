// The unique objects in a file, for "Analyze all objects": every object on every plate, grouped so the AI looks at
// each different object once. One group:
//   - copies of one object (build items sharing a 3MF object id: they print the same and share one set of settings)
//   - near-identical objects: same toolhead(s), and the same shape as placed on the bed within a tolerance (each size
//     within 1 mm or 10 %, mesh detail, volume, overhang and bed contact within 15 %), e.g. a set of claws or pegs
//     that differ slightly. A copy turned another way up (other overhangs, other supports) is its own group.
'use strict';

const { analyzePlate, plateMembership } = require('./threemf');

const near = (a, b, rel, abs = 0) => Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));

function signature(it, o) {
  const tris = it.meshes.reduce((n, m) => n + m.mesh.triangles.length, 0);
  const verts = it.meshes.reduce((n, m) => n + m.mesh.vertices.length, 0);
  return { tris, verts, tool: [o.extruder || 1, ...(o.partExtruders || [])].join(','), painted: o.paintedTriangles || 0,
    size: [o.sizeMm.x, o.sizeMm.y, o.sizeMm.z], volume: o.volumeCm3 || 0, overhang: o.overhangAreaBelow45Cm2 || 0, contact: o.bedContactAreaCm2 || 0 };
}
function sameShape(a, b) {
  return a.tool === b.tool && (a.painted > 0) === (b.painted > 0) && near(a.tris, b.tris, 0.15)
    && a.size.every((v, i) => near(v, b.size[i], 0.1, 1)) && near(a.volume, b.volume, 0.15, 0.05)
    && near(a.overhang, b.overhang, 0.15, 0.5) && near(a.contact, b.contact, 0.15, 0.3);
}

// rotations: { itemIndex: rotation } chosen in the app. Returns groups, biggest first:
// [{ id, name, plates:[plateIndex], items:[itemIndex], objectIds:[...], count, lead: { plate, itemIndex } }]
function uniqueObjects(project, rotations = {}) {
  const plates = project.plates && project.plates.length ? project.plates.map(p => p.index) : [1];
  // each object's plate: where it sits (as Orca decides), else the file's plate list, else the first plate
  const mem = plateMembership(project);
  const plateOf = (it) => {
    const m = mem.get(it.index);
    if (m && m.where !== 'outside' && plates.includes(m.plate)) return m.plate;
    const p = (project.plates || []).find(x => (x.objectIds || []).includes(it.objectId));
    return p ? p.index : plates[0];
  };
  const byPlate = new Map();
  for (const it of project.items) if (it.printable !== false) { const p = plateOf(it); if (!byPlate.has(p)) byPlate.set(p, new Set()); byPlate.get(p).add(it.index); }
  const entries = [];
  for (const [pi, want] of byPlate) {
    let a;
    try { a = analyzePlate(project, pi, rotations, { orient: false }); } catch { continue; }
    for (const o of a.objects) {
      if (!want.has(o.itemIndex)) continue;
      want.delete(o.itemIndex);
      entries.push({ plate: pi, o, it: project.items[o.itemIndex], sig: signature(project.items[o.itemIndex], o) });
    }
  }
  const groups = [];
  for (const e of entries) {
    let g = groups.find(x => x.objectIds.includes(String(e.it.objectId)));
    if (!g) g = groups.find(x => sameShape(x.sig, e.sig));
    if (!g) {
      g = { id: `g${groups.length + 1}`, name: String(e.o.name || e.it.name || 'Object').replace(/_id_\d+_copy_\d+$/, ''), plates: [], items: [], objectIds: [], count: 0,
        lead: { plate: e.plate, itemIndex: e.o.itemIndex }, sig: e.sig, volume: e.sig.volume };
      groups.push(g);
    }
    g.items.push(e.o.itemIndex);
    if (!g.objectIds.includes(String(e.it.objectId))) g.objectIds.push(String(e.it.objectId));
    if (!g.plates.includes(e.plate)) g.plates.push(e.plate);
    g.count++;
  }
  groups.sort((a, b) => b.volume - a.volume);
  return groups.map(({ sig, volume, ...g }) => g);
}

module.exports = { uniqueObjects };
