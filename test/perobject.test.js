// Per-object settings in a 3MF (src/perobject.js) and how buildVariantDetailed uses them.
const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { setObjectSettings, releaseLayerHeights, canBePerObject } = require('../src/perobject');

const MS = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="3">
    <metadata key="name" value="Wing"/>
    <metadata key="extruder" value="2"/>
    <metadata key="layer_height" value="0.08"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="Wing part"/>
      <metadata key="wall_loops" value="9"/>
    </part>
  </object>
  <object id="4">
    <metadata key="name" value="Body"/>
    <metadata key="extruder" value="1"/>
    <metadata key="wall_loops" value="2"/>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
  </plate>
</config>`;
const own = (xml, id) => new RegExp(`<object id="${id}">([\\s\\S]*?)</object>`).exec(xml)[1].replace(/<part\b[\s\S]*?<\/part>/g, '');

test('which settings can be per object (OrcaSlicer PrintObjectConfig + PrintRegionConfig)', () => {
  for (const k of ['wall_loops', 'sparse_infill_density', 'enable_support', 'support_type', 'layer_height', 'outer_wall_speed', 'brim_type', 'seam_position']) assert.ok(canBePerObject(k), k);
  for (const k of ['nozzle_temperature', 'initial_layer_print_height', 'enable_prime_tower', 'travel_speed', 'curr_bed_type']) assert.ok(!canBePerObject(k), k);
});

test('settings are written on the object itself, after name/extruder, replacing what was there; parts untouched', () => {
  const r = setObjectSettings(MS, { 3: [{ key: 'wall_loops', value: '4' }, { key: 'sparse_infill_density', value: '25' }, { key: 'nozzle_temperature', value: '230' }], 4: [{ key: 'wall_loops', value: 3 }] });
  const o3 = own(r.xml, 3), o4 = own(r.xml, 4);
  assert.match(o3, /key="wall_loops" value="4"/);
  assert.match(o3, /key="sparse_infill_density" value="25%"/, 'percent settings get their %');
  assert.ok(o3.indexOf('key="extruder"') < o3.indexOf('key="wall_loops"'), 'name and extruder stay first (remix reads them)');
  assert.match(r.xml, /<part id="1"[\s\S]*key="wall_loops" value="9"/, "the part's own setting is untouched");
  assert.strictEqual((o4.match(/wall_loops/g) || []).length, 1, 'an existing setting is replaced, not duplicated');
  assert.match(o4, /value="3"/);
  assert.deepStrictEqual(r.skipped.map(s => s.key), ['nozzle_temperature'], 'filament settings are not per object');
  assert.match(r.xml, /<plate>[\s\S]*plater_id/, 'plates untouched');
  assert.strictEqual(setObjectSettings(MS, { 99: [{ key: 'wall_loops', value: 1 }] }).skipped[0].why, 'object not found');
});

test("a new layer height releases the model's own layer heights (per object and variable profile), keeps height ranges", async () => {
  const zip = new JSZip();
  zip.file('Metadata/model_settings.config', MS);
  zip.file('Metadata/layer_heights_profile.txt', 'layer_heights_profile_format_version=2\nobject_id=3|0.000000;0.200000;1.000000;0.100000\nobject_id=4|0.000000;0.200000;2.000000;0.120000\n');
  zip.file('Metadata/layer_config_ranges.xml', '<objects><object id="1"><range min_z="1" max_z="2"><option opt_key="layer_height">0.12</option></range></object></objects>');
  const notes = await releaseLayerHeights(zip, ['3']);
  const xml = await zip.file('Metadata/model_settings.config').async('string');
  assert.doesNotMatch(own(xml, 3), /layer_height/);
  const prof = await zip.file('Metadata/layer_heights_profile.txt').async('string');
  assert.doesNotMatch(prof, /object_id=3\|/);
  assert.match(prof, /object_id=4\|/, 'other objects keep their profile');
  assert.strictEqual(notes.length, 3);
  assert.match(notes[0], /Wing \(0\.08 mm\)/);
  assert.match(notes[2], /Height ranges/);
  await releaseLayerHeights(zip, null);
  assert.ok(!zip.file('Metadata/layer_heights_profile.txt'), 'an empty profile file is removed');
  // an object getting its own new layer height keeps that line
  const z2 = new JSZip(); z2.file('Metadata/model_settings.config', MS);
  await releaseLayerHeights(z2, null, { 3: true });
  assert.match(own(await z2.file('Metadata/model_settings.config').async('string'), 3), /layer_height/);
});

// a tiny two-cube Orca project, enough for buildVariantDetailed (sameTool: both cubes on T1)
async function twoCubes(sameTool = false) {
  const cube = (id, x) => {
    const v = [[0,0,0],[10,0,0],[10,10,0],[0,10,0],[0,0,10],[10,0,10],[10,10,10],[0,10,10]];
    const t = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
    return `<object id="${id}" type="model"><mesh><vertices>${v.map(p => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join('')}</vertices>` +
      `<triangles>${t.map(q => `<triangle v1="${q[0]}" v2="${q[1]}" v3="${q[2]}"/>`).join('')}</triangles></mesh></object>`;
  };
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
  zip.file('3D/3dmodel.model', `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">Snapmaker_Orca-2.4.1</metadata><resources>${cube(3)}${cube(4)}</resources>` +
    '<build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 100 100 0" printable="1"/><item objectid="4" transform="1 0 0 0 1 0 0 0 1 140 100 0" printable="1"/></build></model>');
  zip.file('Metadata/model_settings.config', sameTool ? MS.replace('<metadata key="extruder" value="2"/>', '<metadata key="extruder" value="1"/>') : MS);
  zip.file('Metadata/project_settings.config', JSON.stringify({ layer_height: '0.2', wall_loops: '2', print_settings_id: 'x', different_settings_to_system: ['', ''] }));
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('buildVariantDetailed: project-wide layer height clears per-object ones; per-object settings land on their objects', async () => {
  const { Slicer } = require('../src/slicer');
  const out = await Slicer.buildVariantDetailed(await twoCubes(), { changes: [{ key: 'layer_height', value: '0.16' }], objectChanges: { 4: [{ key: 'wall_loops', value: '5' }] } });
  const z = await JSZip.loadAsync(out.buffer);
  const ps = JSON.parse(await z.file('Metadata/project_settings.config').async('string'));
  assert.strictEqual(String([].concat(ps.layer_height)[0]), '0.16');
  const xml = await z.file('Metadata/model_settings.config').async('string');
  assert.doesNotMatch(own(xml, 3), /layer_height/, "the object's own 0.08 would have overridden 0.16 in Orca");
  assert.match(own(xml, 4), /key="wall_loops" value="5"/);
  assert.ok(out.corrections.some(c => /Wing \(0\.08 mm\)/.test(c)), 'the user is told');
  // a layer height for one object: only that object changes
  const one = await Slicer.buildVariantDetailed(await twoCubes(), { objectChanges: { 3: [{ key: 'layer_height', value: '0.12' }] } });
  const x1 = await (await JSZip.loadAsync(one.buffer)).file('Metadata/model_settings.config').async('string');
  assert.match(own(x1, 3), /key="layer_height" value="0.12"/);
});

test('unique objects: identical objects are analyzed once, a different shape is its own group', async () => {
  const { load3mf } = require('../src/threemf');
  const { uniqueObjects } = require('../src/objects');
  const proj = await load3mf(await twoCubes(true));
  assert.strictEqual(uniqueObjects(await load3mf(await twoCubes())).length, 2, "same shape on another toolhead: its own group");
  const g = uniqueObjects(proj);
  assert.strictEqual(g.length, 1, 'two identical cubes: one group');
  assert.strictEqual(g[0].count, 2);
  assert.deepStrictEqual(g[0].objectIds.sort(), ['3', '4']);
  // make the second cube three times as tall: now two groups
  const z = await JSZip.loadAsync(await twoCubes(true));
  const model = (await z.file('3D/3dmodel.model').async('string')).replace(/(<item objectid="4" transform="1 0 0 0 1 0 0 0 )1/, '$13');
  z.file('3D/3dmodel.model', model);
  const g2 = uniqueObjects(await load3mf(await z.generateAsync({ type: 'nodebuffer' })));
  assert.strictEqual(g2.length, 2);
  assert.ok(g2.every(x => x.count === 1));
});
