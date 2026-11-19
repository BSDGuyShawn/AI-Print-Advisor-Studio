// Print history from each U1's Moonraker (/server/history/list), plus a local log of
// your ratings and of what the advisor changed, so past outcomes inform future recommendations.
const fs = require('fs/promises');
const path = require('path');

async function fetchJson(url, apiKey, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: apiKey ? { 'X-Api-Key': apiKey } : {} });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

function baseUrl(u) {
  let s = String(u || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//.test(s)) s = `http://${s}`;
  return s;
}

async function fetchJobs(printers, limit = 60) {
  const jobs = [], errors = [];
  await Promise.all(printers.filter(p => p.url).map(async (p) => {
    try {
      const data = await fetchJson(`${baseUrl(p.url)}/server/history/list?limit=${limit}&order=desc`, p.apiKey);
      for (const j of (data.result && data.result.jobs) || []) {
        const md = j.metadata || {};
        jobs.push({
          id: `${p.name}:${j.job_id}`, printer: p.name, filename: j.filename, status: j.status,
          start: j.start_time ? new Date(j.start_time * 1000).toISOString() : null,
          printSeconds: Math.round(j.print_duration || 0), totalSeconds: Math.round(j.total_duration || 0),
          filamentMm: Math.round(j.filament_used || 0),
          estimatedSeconds: md.estimated_time ? Math.round(md.estimated_time) : null,
          layerHeight: md.layer_height ?? null, filamentType: md.filament_type || null, filamentName: md.filament_name || null,
          grams: md.filament_weight_total ?? null, slicer: md.slicer ? `${md.slicer} ${md.slicer_version || ''}`.trim() : null,
          objectHeight: md.object_height ?? null,
        });
      }
    } catch (e) {
      errors.push(`${p.name}: ${e.name === 'AbortError' ? 'no response (check the address and that the printer is on)' : e.message}`);
    }
  }));
  jobs.sort((a, b) => String(b.start).localeCompare(String(a.start)));
  return { jobs, errors };
}

const stem = (s) => String(s || '').split(/[\\/]/).pop().replace(/\.(gcode|3mf)$/i, '').replace(/_plate_\d+$/i, '').replace(/\s*\(advisor[^)]*\)\s*/i, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

class PrintLog {
  constructor(dir) { this.file = path.join(dir, 'print-log.json'); this.data = { ratings: {}, runs: [] }; }
  async load() { try { this.data = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch {} this.data.ratings ||= {}; this.data.runs ||= []; this.data.diagnoses ||= {}; return this; }
  async addDiagnosis(jobId, entry) { (this.data.diagnoses[jobId] ||= []).unshift({ ...entry, at: new Date().toISOString() }); this.data.diagnoses[jobId] = this.data.diagnoses[jobId].slice(0, 10); await this.save(); }
  async save() { await fs.mkdir(path.dirname(this.file), { recursive: true }); await fs.writeFile(this.file, JSON.stringify(this.data, null, 1)); }
  async rate(jobId, rating, note) {
    if (!rating) delete this.data.ratings[jobId];
    else this.data.ratings[jobId] = { rating, note: note || '', at: new Date().toISOString() };
    await this.save();
  }
  async addRun(run) {
    this.data.runs.unshift({ ...run, at: new Date().toISOString(), stem: stem(run.file) });
    this.data.runs = this.data.runs.slice(0, 300);
    await this.save();
  }
  runFor(job) {
    const s = stem(job.filename);
    return this.data.runs.find(r => r.stem && s && (s.includes(r.stem) || r.stem.includes(s))) || null;
  }
  decorate(jobs) {
    return jobs.map(j => ({ ...j, rating: this.data.ratings[j.id] || null, run: this.runFor(j), diagnoses: this.data.diagnoses[j.id] || [] }));
  }
}

// Compact, relevant history for Claude: rated prints, prints of this same model, and completion rates by material.
function historyForPrompt(jobs, fileName) {
  const s = stem(fileName);
  const brief = (j) => ({
    when: j.start && j.start.slice(0, 10), printer: j.printer, file: j.filename, status: j.status,
    rating: j.rating ? j.rating.rating : null, note: j.rating ? j.rating.note : undefined,
    material: j.filamentType, layer: j.layerHeight, hours: +(j.printSeconds / 3600).toFixed(2),
    advisorChanges: j.run ? (j.run.changes || []).map(c => `${c.key}=${c.value}${c.slot ? `@T${c.slot}` : ''}`).slice(0, 25) : undefined,
    diagnosis: j.diagnoses && j.diagnoses[0] ? { issue: j.diagnoses[0].issueTypes, summary: j.diagnoses[0].summary, changes: j.diagnoses[0].changes } : undefined,
  });
  const sameModel = jobs.filter(j => s && stem(j.filename).includes(s)).slice(0, 8).map(brief);
  const rated = jobs.filter(j => j.rating || (j.diagnoses && j.diagnoses.length)).slice(0, 20).map(brief);
  const byMaterial = {};
  for (const j of jobs) {
    const m = String(j.filamentType || 'unknown').split(';')[0];
    byMaterial[m] ||= { prints: 0, completed: 0, cancelled: 0, failed: 0, ratedFailed: 0 };
    const b = byMaterial[m];
    b.prints++;
    if (j.status === 'completed') b.completed++;
    else if (j.status === 'cancelled') b.cancelled++;
    else b.failed++;
    if (j.rating && j.rating.rating === 'failed') b.ratedFailed++;
  }
  if (!jobs.length) return null;
  return { sameModel, rated, byMaterial, totalJobs: jobs.length };
}

module.exports = { fetchJobs, PrintLog, historyForPrompt, stem };
