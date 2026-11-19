// Colours baked into a model that the user doesn't have: compare each toolhead's filament with the inventory
// (same material family, colour difference in CIELAB), and offer ways to buy the missing ones:
// an Amazon search link always, and (optional, uses the API) Claude searching the web for exact products.
const { callApi } = require('./claude');
const { mainHex } = require('./inventory');

const family = (t) => (/^(PETG|PCTG)/i.test(t) ? 'petg' : /^(ABS|ASA)/i.test(t) ? 'abs' : /^TPU/i.test(t) ? 'tpu' : /^(PA|PET-CF|PAHT)/i.test(t) ? 'pa' : /^PC\b/i.test(t) ? 'pc' : 'pla');
const rgb = (h) => { const v = parseInt(String(h).replace('#', '').slice(0, 6), 16) || 0; return [v >> 16 & 255, v >> 8 & 255, v & 255]; };
function lab(hex) {
  const lin = (c) => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
  const [r, g, b] = rgb(hex).map(lin);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), y = f(r * 0.2126 + g * 0.7152 + b * 0.0722), z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

// a colour name people search for: hue words plus light/dark
const HUES = [[0, 'red'], [18, 'orange red'], [30, 'orange'], [45, 'gold'], [55, 'yellow'], [75, 'lime green'], [100, 'green'], [150, 'emerald green'], [170, 'teal'], [190, 'cyan'], [205, 'sky blue'], [220, 'blue'], [240, 'royal blue'], [260, 'indigo'], [275, 'purple'], [295, 'violet'], [320, 'magenta'], [340, 'pink'], [355, 'red']];
function colorWords(hex) {
  const [r, g, b] = rgb(hex).map(c => c / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.12 || d < 0.06) return l > 0.9 ? 'white' : l < 0.12 ? 'black' : l > 0.7 ? 'light gray' : l < 0.35 ? 'dark gray' : 'gray';
  let h = (mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60; if (h < 0) h += 360;
  let name = HUES.reduce((best, x) => (Math.abs(x[0] - h) < Math.abs(best[0] - h) ? x : best))[1];
  if (h >= 60 && h <= 120 && s < 0.5 && l < 0.5) name = 'olive green';
  else if (h >= 15 && h <= 45 && l < 0.45) name = l < 0.25 ? 'dark brown' : 'brown';
  else if (h >= 30 && h <= 55 && l > 0.7 && s < 0.6) name = 'beige';
  else if (/^(red|orange red)$/.test(name) && s < 0.45) name = l < 0.33 ? 'maroon' : 'brick red';
  else if (name !== 'pink' && l > 0.72) name = `light ${name}`;
  else if (l < 0.28) name = `dark ${name}`;
  return name;
}

const amazonUrl = (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q).replace(/%20/g, '+')}`;

// slots: [{ slot, type, color }] (only the toolheads the model uses)
function check(slots, filaments) {
  return slots.map(s => {
    const fam = family(s.type || 'PLA');
    const pool = filaments.filter(f => family(f.type) === fam && (f.spools == null || f.spools > 0));
    let best = null, bd = Infinity;
    for (const f of pool) for (const h of (Array.isArray(f.hex) ? f.hex.slice(0, 1) : [mainHex(f)])) { const d = deltaE(h, s.color); if (d < bd) { bd = d; best = f; } }
    const words = colorWords(s.color), type = (s.type || 'PLA').toUpperCase();
    const status = best && bd <= 10 ? 'have' : best && bd <= 22 ? 'close' : 'missing';
    return {
      slot: s.slot, type, color: s.color, words, status,
      have: best ? { name: `${best.brand} ${best.line} ${best.color}`.replace(/\s+/g, ' '), hex: mainHex(best), deltaE: Math.round(bd) } : null,
      search: `${type} filament 1.75mm ${words}`,
      amazon: amazonUrl(`${type} 3D printer filament 1.75mm ${words}`),
    };
  });
}

// ---------- optional: Claude finds exact products on the web ----------
const SYSTEM = `You help a 3D-printing hobbyist buy filament. For each colour you're given (material, hex colour and a colour name), search the web for 1–3 real, currently sold 1.75 mm filament spools that match the colour as closely as possible, preferring Amazon listings (amazon.com) and brands the user already buys. Check that the colour really matches (look at the product's colour name and photos/description), and that it's the right material.

Answer with ONLY a JSON object, no other text:
{"results":[{"slot":<number>,"products":[{"title":"…","brand":"…","url":"https://…","price":"$19.99 or empty","colorMatch":"exact | close | approximate","why":"one short sentence"}]}]}
Use only URLs you actually found. If you can't find a good match for a colour, give the closest one and say so in "why".`;

async function findProducts({ apiKey, model, items, brands }) {
  if (!apiKey) throw new Error('Finding products needs a Claude API key (Settings).');
  const messages = [{ role: 'user', content: JSON.stringify({ colours: items.map(i => ({ slot: i.slot, material: i.type, hex: i.color, colourName: i.words })), brandsTheUserAlreadyBuys: brands }) }];
  let data;
  for (let turn = 0; turn < 4; turn++) {
    const r = await callApi(apiKey, { model, max_tokens: 6000, system: SYSTEM, messages, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: Math.min(8, 2 + items.length * 2) }] });
    if (!r.res.ok) throw new Error(r.res.status === 401 ? 'The API key was rejected. Check it in Settings.' : `Product search failed: ${r.msg}`);
    data = r.data;
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }
  const text = (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  let out; try { out = JSON.parse(m ? m[0] : text); } catch { throw new Error('The product search didn’t return a usable answer. Try again.'); }
  const searches = (data.usage && data.usage.server_tool_use && data.usage.server_tool_use.web_search_requests) || 0;
  const results = (out.results || []).map(r => ({ slot: r.slot, products: (r.products || []).filter(p => /^https?:\/\//.test(p.url || '')).slice(0, 3) }));
  return { results, searches };
}
// rough cost: web searches are $10 per 1,000, plus the tokens the search results add
function findCost(n, model) {
  const per = /haiku/.test(model) ? 0.004 : /opus/.test(model) ? 0.05 : 0.025;
  const usd = n * (0.02 + per);
  return { low: usd * 0.6, high: usd * 1.6 };
}

module.exports = { check, findProducts, findCost, colorWords, deltaE, amazonUrl };
