// "Free chatbot" mode: for people without an Anthropic API key. The app builds one self-contained prompt that
// can be pasted into ChatGPT, Claude or Gemini (free plans included), saves the images to a folder to attach,
// and reads the reply back. Replies go through the same validation, safety checks and automatic fixes as API answers.
const fs = require('fs/promises');
const path = require('path');

const RECS_TEMPLATE = {
  summary: '2-4 sentences: what the model is, the main printing challenge, the strategy.',
  orientation: 'Orientation advice in plain words.',
  orientation_choices: [{ object_index: 0, option_id: 'o1', reason: 'only if an orientation option is clearly better, otherwise leave this list empty' }],
  risks: [{ severity: 'info | warn | critical', title: 'short title', detail: 'one sentence' }],
  settings: [{ key: 'one of the allowed setting keys', recommended: 'value in Orca format, e.g. 0.16 or 15% or tree(auto)', slot: 0, action: 'change | check', priority: 'high | medium | low', reason: 'why, one sentence' }],
  manual_steps: ['things to do by hand in Orca'],
  material_notes: '', multicolor_notes: '', history_notes: '', estimated_effect: '',
};
const TS_TEMPLATE = {
  summary: '2-3 sentences: what went wrong, where, and the most likely reason.',
  causes: [{ cause: 'short name', likelihood: 'high | medium | low', evidence: 'numbers from the data that point to it', kind: 'settings | model/orientation | material | printer/hardware' }],
  settings: [{ key: 'one of the allowed setting keys', recommended: 'value in Orca format', slot: 0, action: 'change | check', priority: 'high | medium | low', reason: 'why, one sentence' }],
  physical_checks: ['things to check at the printer or with the filament'],
  orientation: '', questions: [],
};

// content: Anthropic-style content array (text + image blocks) from the normal request builder
function buildChatPrompt({ kind, system, content }) {
  const images = content.filter(c => c.type === 'image');
  const labels = content.filter((c, i) => c.type === 'text' && content[i + 1] && content[i + 1].type === 'image').map(c => c.text.replace(/^Image:\s*/, ''));
  const data = content.filter(c => c.type === 'text' && !/^Image:/.test(c.text)).map(c => c.text).join('\n\n')
    .replace(/Return your (plan|diagnosis) as JSON matching the required schema\./, '');
  const template = kind === 'ts' ? TS_TEMPLATE : RECS_TEMPLATE;
  const text = [
    kind === 'ts' ? 'Please help me diagnose a 3D print problem.' : 'Please recommend 3D print settings for me.',
    '',
    system,
    '',
    images.length ? `I attached ${images.length} image${images.length === 1 ? '' : 's'}:\n${labels.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n(If you can't see them, continue without them.)` : '',
    '',
    data,
    '',
    'IMPORTANT: Reply with ONLY one JSON object in exactly this shape (no other text). Use the allowed setting keys exactly as listed. Use slot 0 for process settings and 1-4 (the toolhead) for filament settings:',
    '```json',
    JSON.stringify(template, null, 2),
    '```',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  return { text, images };
}

async function saveImages(images, dir) {
  await fs.mkdir(dir, { recursive: true });
  const files = [];
  let n = 0;
  for (const im of images) {
    n++;
    const ext = /png/.test(im.source.media_type) ? 'png' : 'jpg';
    const f = path.join(dir, `image-${n}.${ext}`);
    await fs.writeFile(f, Buffer.from(im.source.data, 'base64'));
    files.push(f);
  }
  return files;
}

// Chat replies often wrap the JSON in prose or code fences, or use smart quotes and trailing commas.
function extractJson(text) {
  let s = String(text || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence && fence[1].includes('{')) s = fence[1];
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON found. Copy the chatbot’s whole reply (it should start with { and end with }).');
  s = s.slice(start, end + 1);
  const attempts = [
    (x) => x,
    (x) => x.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"),
    (x) => x.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, '$1'),
    (x) => x.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, '$1').replace(/\/\/[^\n"]*$/gm, ''),
  ];
  for (const f of attempts) { try { return JSON.parse(f(s)); } catch {} }
  throw new Error('The reply looks cut off or isn’t valid JSON. Ask the chatbot: “Please send the complete JSON again, nothing else.”');
}

const str = (v) => (v == null ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const pick = (v, ok, d) => { const x = str(v).toLowerCase().trim(); return ok.includes(x) ? x : d; };
function normSettings(list) {
  return arr(list).filter(x => x && x.key).map(x => ({
    key: str(x.key).trim(), recommended: str(x.recommended ?? x.value).trim(), slot: Number(x.slot) || 0,
    action: pick(x.action, ['change', 'check'], 'change'), priority: pick(x.priority, ['high', 'medium', 'low'], 'medium'), reason: str(x.reason),
  })).filter(x => x.recommended !== '');
}

function parseChatAnswer(text, kind) {
  const j = extractJson(text);
  if (kind === 'ts') {
    return {
      summary: str(j.summary), orientation: str(j.orientation),
      causes: arr(j.causes).map(c => ({ cause: str(c.cause || c.name), likelihood: pick(c.likelihood, ['high', 'medium', 'low'], 'medium'), evidence: str(c.evidence), kind: str(c.kind || 'settings') })),
      settings: normSettings(j.settings), physical_checks: arr(j.physical_checks).map(str), questions: arr(j.questions).map(str),
    };
  }
  return {
    summary: str(j.summary), orientation: str(j.orientation),
    orientation_choices: arr(j.orientation_choices).filter(c => c && c.option_id != null).map(c => ({ object_index: Number(c.object_index) || 0, option_id: str(c.option_id), reason: str(c.reason) })),
    risks: arr(j.risks).map(r => ({ severity: pick(r.severity, ['info', 'warn', 'critical'], 'info'), title: str(r.title), detail: str(r.detail) })),
    settings: normSettings(j.settings), manual_steps: arr(j.manual_steps).map(str),
    material_notes: str(j.material_notes), multicolor_notes: str(j.multicolor_notes), history_notes: str(j.history_notes), estimated_effect: str(j.estimated_effect),
  };
}

module.exports = { buildChatPrompt, saveImages, parseChatAnswer, extractJson };
