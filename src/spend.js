// What the app's AI calls cost, worked out from the token counts Anthropic returns with every answer, at list
// prices. Kept in <userData>/ai-spend.json (the last 5,000 calls). The feature a call belongs to comes from the
// window action that started it (run(feature, fn) wraps that action; see main.js).
//
// For the key's total cost so far (including use outside the app), Settings points to the Claude Console's API
// keys page.
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

// $ per million tokens: input, output, cache read, cache write (5 minutes). Web search: $10 per 1,000 searches.
const PRICES = {
  'claude-fable-5-2': { in: 8, out: 40, cr: 0.20, cw: 10 },
  'claude-opus-5-5': { in: 4, out: 20, cr: 0.20, cw: 5 },
  'claude-opus-5': { in: 5, out: 25, cr: 0.50, cw: 6.25 },
  'claude-sonnet-5-5': { in: 2, out: 10, cr: 0.10, cw: 2.5 },
  'claude-sonnet-5': { in: 2, out: 10, cr: 0.20, cw: 2.5 },
  'claude-haiku-5-5': { in: 0.10, out: 0.50, cr: 0.01, cw: 0.125 },
};
const SEARCH_USD = 0.01;
const priceFor = (model) => PRICES[model] || PRICES[Object.keys(PRICES).find(k => String(model || '').startsWith(k))] || null;

function costOf(model, u) {
  const p = priceFor(model) || PRICES['claude-sonnet-5-5'];
  const cw = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens || 0) + (u.cache_creation.ephemeral_1h_input_tokens || 0) * 1.6 : (u.cache_creation_input_tokens || 0);
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_read_input_tokens || 0) * p.cr + cw * p.cw) / 1e6
    + ((u.server_tool_use && u.server_tool_use.web_search_requests) || 0) * SEARCH_USD;
}

const als = new AsyncLocalStorage();
let file = null, entries = null, listener = null;

function init(userData, onRecord) {
  file = path.join(userData, 'ai-spend.json');
  try { entries = JSON.parse(fs.readFileSync(file, 'utf8')).entries || []; } catch { entries = []; }
  listener = onRecord || null;
}
const run = (feature, fn) => als.run({ feature }, fn);

// one Claude answer (the whole Messages API response)
function record(data, fallbackModel) {
  if (!entries || !data || !data.usage) return null;
  const u = data.usage, model = data.model || fallbackModel || 'unknown';
  const e = { t: new Date().toISOString(), feature: (als.getStore() || {}).feature || 'Other', model,
    in: u.input_tokens || 0, out: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0,
    searches: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0, usd: +costOf(model, u).toFixed(6), estimated: !priceFor(model) };
  entries.push(e);
  if (entries.length > 5000) entries = entries.slice(-5000);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ entries })); } catch {}
  try { if (listener) listener(e, summary()); } catch {}
  return e;
}

function summary() {
  const all = entries || [];
  const now = new Date(), monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime(), d30 = now.getTime() - 30 * 86400e3;
  const total = (list) => ({ usd: +list.reduce((t, e) => t + e.usd, 0).toFixed(6), calls: list.length });
  const month = all.filter(e => Date.parse(e.t) >= monthStart);
  const byFeature = {};
  for (const e of month) { const f = (byFeature[e.feature] ||= { usd: 0, calls: 0 }); f.usd += e.usd; f.calls++; }
  return { month: total(month), last30: total(all.filter(e => Date.parse(e.t) >= d30)), all: total(all), since: all[0] ? all[0].t : null,
    byFeature: Object.entries(byFeature).map(([feature, v]) => ({ feature, usd: +v.usd.toFixed(6), calls: v.calls })).sort((a, b) => b.usd - a.usd),
    recent: all.slice(-8).reverse() };
}
function clear() { entries = []; try { fs.writeFileSync(file, JSON.stringify({ entries })); } catch {} }

module.exports = { init, run, record, summary, clear, costOf, PRICES };
