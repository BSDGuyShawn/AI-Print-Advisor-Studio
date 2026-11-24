// Per-object settings in an Orca 3MF (Metadata/model_settings.config): different print settings for different objects
// in one file, the same thing Orca does with right-click on an object -> Add settings. Each object's own metadata
// (outside its <part> elements) overrides the project settings for that object:
//   <object id="3">
//     <metadata key="name" value="Wing"/>
//     <metadata key="extruder" value="1"/>
//     <metadata key="wall_loops" value="4"/>        <- per-object setting
// Only the settings in src/per-object-keys.json can be per object (OrcaSlicer's PrintObjectConfig + PrintRegionConfig);
// first-layer height, travel/first-layer speeds, the prime tower, filament and printer settings apply to the whole
// plate. Objects are identified by their 3MF object id (copies of one object share it).
//
// A model's own layer heights override the project's layer height in Orca: a per-object layer_height, and a variable
// layer height profile (Metadata/layer_heights_profile.txt, keyed by object id in format v2). When the layer height is
// changed, releaseLayerHeights() removes them for the objects concerned so the new height really applies.
'use strict';

const { normalize } = require('./orca-settings');
const PER_OBJECT = new Set(require('./per-object-keys.json').keys);
const canBePerObject = (key) => PER_OBJECT.has(key);

const MS = 'Metadata/model_settings.config';
const PROFILE = 'Metadata/layer_heights_profile.txt';
const RANGES = 'Metadata/layer_config_ranges.xml';
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// An object's block and its own part (without its <part> elements)
function objectBlock(xml, id) {
  const m = new RegExp(`<object id="${reEsc(id)}">([\\s\\S]*?)</object>`).exec(xml);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length, body: m[1] };
}
function objectName(xml, id) {
  const b = objectBlock(xml, id);
  const m = b && /<metadata key="name" value="([^"]*)"/.exec(b.body.replace(/<part\b[\s\S]*?<\/part>/g, ''));
  return m ? m[1] : `object ${id}`;
}

// Set (or replace) settings on objects. objectChanges: { [objectId]: [{ key, value }] }. Settings that can't be per
// object are skipped and reported. Returns { xml, written, skipped }.
function setObjectSettings(xml, objectChanges) {
  const written = [], skipped = [];
  for (const [id, list] of Object.entries(objectChanges || {})) {
    const b = objectBlock(xml, id);
    if (!b) { for (const c of list) skipped.push({ id, key: c.key, why: 'object not found' }); continue; }
    // the object's own metadata comes before its first <part>; new entries go after name/extruder (remix.js reads
    // those two first)
    const partAt = b.body.search(/<part\b/);
    let own = partAt < 0 ? b.body : b.body.slice(0, partAt);
    const rest = partAt < 0 ? '' : b.body.slice(partAt);
    const indent = (/\n([ \t]*)<metadata/.exec(own) || [, '    '])[1];
    for (const c of list) {
      if (!canBePerObject(c.key)) { skipped.push({ id, key: c.key, why: 'not a per-object setting' }); continue; }
      const value = escAttr(normalize(c.key, c.value));
      const line = `<metadata key="${c.key}" value="${value}"/>`;
      const re = new RegExp(`<metadata key="${reEsc(c.key)}" value="[^"]*"\\s*/>`);
      if (re.test(own)) own = own.replace(re, line);
      else {
        const anchor = /(<metadata key="extruder"[^>]*\/>)|(<metadata key="name"[^>]*\/>)/g;
        let last = null, m;
        while ((m = anchor.exec(own))) last = m;
        own = last ? own.slice(0, last.index + last[0].length) + `\n${indent}${line}` + own.slice(last.index + last[0].length)
          : own.replace(/^\s*/, (ws) => `${ws}${line}\n${indent}`);
      }
      written.push({ id, key: c.key, value: normalize(c.key, c.value) });
    }
    xml = xml.slice(0, b.start) + `<object id="${id}">${own}${rest}</object>` + xml.slice(b.end);
  }
  return { xml, written, skipped };
}

// Remove a model's own layer heights for some objects (ids; null = every object), so a new layer height applies:
// their per-object layer_height (unless keep[id] says that object gets a new one) and their variable layer height
// profile. Height-range settings (layer_config_ranges.xml) are the designer's deliberate fine sections: kept, and
// reported. Returns plain-language notes.
async function releaseLayerHeights(zip, ids = null, keep = {}) {
  const notes = [];
  const want = ids ? new Set(ids.map(String)) : null;
  const msFile = zip.file(MS);
  let xml = msFile ? await msFile.async('string') : '';
  const allIds = [...xml.matchAll(/<object id="([^"]+)">/g)].map(m => m[1]);
  const targets = want ? allIds.filter(id => want.has(id)) : allIds;
  // per-object layer heights
  const dropped = [];
  for (const id of targets) {
    if (keep[id]) continue;
    const b = objectBlock(xml, id);
    if (!b) continue;
    const partAt = b.body.search(/<part\b/);
    const own = partAt < 0 ? b.body : b.body.slice(0, partAt);
    const m = /[ \t]*<metadata key="layer_height" value="([^"]*)"\s*\/>\r?\n?/.exec(own);
    if (!m) continue;
    dropped.push(`${objectName(xml, id)} (${m[1]} mm)`);
    const body = own.replace(m[0], '') + (partAt < 0 ? '' : b.body.slice(partAt));
    xml = xml.slice(0, b.start) + `<object id="${id}">${body}</object>` + xml.slice(b.end);
  }
  if (dropped.length) {
    zip.file(MS, xml);
    notes.push(`Removed the layer height set on ${dropped.length === 1 ? 'the object' : `${dropped.length} objects`} (${dropped.slice(0, 3).join(', ')}${dropped.length > 3 ? '…' : ''}): it overrode the new layer height in Orca.`);
  }
  // variable layer height profiles (v2 is keyed by object id; v1 by position, so only "all objects" can clear it)
  const pf = zip.file(PROFILE);
  if (pf) {
    const text = await pf.async('string');
    const v2 = /layer_heights_profile_format_version\s*=\s*2/.test(text);
    const lines = text.split(/\r?\n/);
    const removed = [];
    const kept = lines.filter(line => {
      const m = /^object_id=([^|]+)\|/.exec(line.trim());
      if (!m) return true;
      const hit = !want || (v2 && want.has(m[1]));
      if (hit) removed.push(objectName(xml, m[1]));
      return !hit;
    });
    if (removed.length) {
      if (kept.some(l => /^object_id=/.test(l.trim()))) zip.file(PROFILE, kept.join('\n'));
      else zip.remove(PROFILE);
      notes.push(`Removed the variable layer height on ${removed.length === 1 ? removed[0] : `${removed.length} objects`}: it set its own layer heights, so the new layer height wouldn't have applied (in Orca: Variable layer height to add it back).`);
    }
  }
  const rf = zip.file(RANGES);
  if (rf && /opt_key="layer_height"/.test(await rf.async('string'))) {
    notes.push('Height ranges set in the model (e.g. a finer section) keep their own layer heights; the new layer height applies everywhere else.');
  }
  return notes;
}

module.exports = { PER_OBJECT, canBePerObject, setObjectSettings, releaseLayerHeights, objectName };
