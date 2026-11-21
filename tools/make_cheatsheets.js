// Makes the printable cheat sheets (US Letter PDFs) in docs/cheat-sheets/: a 1-page quick sheet and a booklet with
// every glossary word and its drawing. The words and drawings come from renderer/glossary.js, so the PDFs match
// the app. Run with Electron's official build (it has the default app that runs a script):
//     <electron>/electron.exe tools/make_cheatsheets.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'cheat-sheets');
const VERSION = require(path.join(ROOT, 'package.json')).version;

// the glossary's words and drawings (the module's export keywords dropped so it runs as a plain script)
const src = fs.readFileSync(path.join(ROOT, 'renderer', 'glossary.js'), 'utf8').replace(/^export /gm, '');
const { TERMS, PIC } = vm.runInNewContext(src + '\n;({ TERMS, PIC })', {});
// plain text: tags removed until none are left (so nested leftovers like "<scr<b>ipt>" can't come back), then any
// stray angle brackets
const strip = (s) => {
  let t = String(s || ''), prev;
  do { prev = t; t = t.replace(/<[^<>]*>/g, ''); } while (t !== prev);
  return t.replace(/[<>]/g, '');
};

// ---------- shared content ----------
const STEPS = [
  ['Open your model', 'Drag the <b>.3mf</b> in, or click <b>Open 3MF</b> (top right). MakerWorld and Printables files work.'],
  ['Set T1–T4', 'Pick the filament you’ll load in each toolhead (left: Toolheads and materials).'],
  ['Check overhangs', 'Click <b>Overhangs</b> above the model. Red needs supports. Pick the <b>“lowest risk”</b> orientation.'],
  ['Quality or speed', 'Slide <b>Quality ↔ Speed</b> and say what the part is for.'],
  ['Get recommended settings', 'Read each change and its reason; untick what you don’t want.'],
  ['Save or print', '<b>Save as 3MF</b> (open it in your slicer) or <b>Send to printer…</b>. Optional: <b>Compare slices</b> first.'],
];
const BUTTONS = [
  ['AI $…', 'What the AI cost this month. Click for details.'],
  ['Filament', 'Your filament library (Back to model returns).'],
  ['Guide', 'Step-by-step help, on or off.'],
  ['Glossary', 'Every word explained, with a picture. Cheat sheets too.'],
  ['Open 3MF', 'Open a model.'],
  ['⚙ (gear)', 'Settings: API key, printers, slicer, experience.'],
];
const PROBLEMS = [
  ['Lots of red in Overhangs', 'Another orientation; if still red, keep supports on.', 'Supports, orientation'],
  ['Comes loose / falls over', 'More bed contact; keep the brim; clean the bed.', 'Bed, brim, first layer'],
  ['Spaghetti mess', 'Usually it came loose or had no supports. Run the troubleshooter.', 'Spaghetti'],
  ['Stringing, hairs', 'Dry the filament; troubleshooter suggests retraction/temperature.', 'Ooze, retraction'],
  ['Corners lift (warping)', 'Brim, warmer bed, no drafts; ABS/ASA need an enclosure.', 'Warping'],
  ['First layer messy', 'Clean the bed; re-run bed leveling; check Z offset.', 'First layer, leveling'],
  ['Gaps, thin walls', 'Partly clogged nozzle or wet filament; slow down.', 'Under-extrusion, clog'],
  ['Layers shifted sideways', 'Something blocked the head, or loose belts; slow down.', 'Layer shift'],
  ['Takes too long / looks rough', 'Slide toward Speed / toward Quality, or pick Fast / Fine.', 'Layer height'],
];
const FACTORS = [
  ['Damp filament', 'Most filament soaks up moisture from the air (PETG, TPU and nylon most). Wet filament strings, pops, looks rough and prints weak. Dry it, and store it sealed with desiccant.'],
  ['The room', 'Cold rooms, drafts (fans, windows, air vents) and temperature swings cause warping, cracks and prints coming loose. ABS and ASA need an enclosure.'],
  ['The filament itself', 'Brands and even colors of the same material print differently. Check the temperatures on the spool’s label.'],
  ['The printer', 'A dirty or uneven bed, a worn or partly clogged nozzle, loose belts or skipped calibration cause failures no setting fixes. Clean the bed (dish soap and water, or isopropyl alcohol) and calibrate now and then.'],
  ['The model', 'Very thin walls, a tiny footprint on the bed or a broken mesh can fail whatever the settings.'],
];
const AI_NOTE = '<b>AI can make mistakes</b>, especially with little to go on. Say what the part is for, describe problems in the troubleshooter and add photos. The app’s safety checks catch settings that wouldn’t work, but read each change, and do a small test print when it matters.';
const KEY_NOTE = 'The app needs an <b>Anthropic API key</b> to use AI on its own: it sends Claude pictures of your model, the slice results and your settings, and puts the answers straight into the app. A chatbot can’t (the free chatbot mode means copy and paste every time). Pay-as-you-go, no subscription: most analyses cost a few cents (about 4–10¢ with Sonnet; $5 lasts 60+). Create a key at <b>platform.claude.com → API keys</b>, then ⚙ Settings → paste → <b>Save settings</b>. Total cost so far: your API keys page.';

// one-line versions for the 1-page sheet (the booklet has the full explanations with pictures)
const QUICK_WORDS = [
  ['Slicer', 'turns a 3D model into printer instructions (Snapmaker Orca)'],
  ['Layer / layer height', 'one thin slice of the print; 0.08 mm smooth … 0.28 mm fast'],
  ['Nozzle', 'the hot tip that lays down melted plastic'],
  ['Toolhead (T1–T4)', 'a nozzle with its own filament; one color each'],
  ['Bed', 'the plate the print is built on; keep it clean'],
  ['Filament / spool', 'the plastic “ink”, wound on a spool'],
  ['PLA · PETG · TPU', 'easiest · tougher, heat-resistant · flexible'],
  ['Overhang', 'part printed over thin air (red in Overhangs)'],
  ['Supports', 'scaffolding under overhangs; snap off after'],
  ['Brim', 'thin rings around the base so it sticks'],
  ['Infill', 'the inside pattern; 10–20% is typical'],
  ['Walls', 'the outer shell loops; 2–3 is typical'],
  ['Purge / prime tower', 'waste plastic when switching colors / the block it goes into'],
  ['Stringing', 'thin hairs between parts; often wet filament'],
  ['Warping', 'corners lifting off the bed as plastic cools'],
  ['Orientation', 'which way the model sits on the bed'],
];

const CSS = `
@page { size: Letter; margin: 0.42in; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; color: #18232E; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1 { margin: 0; font-size: 19pt; }
h2 { font-size: 11.5pt; margin: 0 0 4px; color: #167585; border-bottom: 1.5px solid #1F9AAE; padding-bottom: 2px; }
.head { display: flex; align-items: baseline; justify-content: space-between; background: #1F9AAE; color: #fff; padding: 8px 12px; border-radius: 6px; margin-bottom: 8px; }
.head small { font-size: 9pt; opacity: .9; }
table { width: 100%; border-collapse: collapse; }
td, th { vertical-align: top; text-align: left; padding: 2px 4px; border-bottom: 1px solid #E1E6EA; }
th { color: #4E5B67; font-weight: 600; }
.num { display: inline-block; width: 16px; height: 16px; border-radius: 50%; background: #1F9AAE; color: #fff; text-align: center; font-weight: 700; font-size: 8pt; line-height: 16px; }
.box { border: 1.5px solid #E8833A; background: #FFF6EC; border-radius: 6px; padding: 6px 9px; }
.box.key { border-color: #1F9AAE; background: #EEF8FA; }
.box h2 { border: 0; color: #B85E1C; margin-bottom: 2px; }
.box.key h2 { color: #167585; }
.foot { color: #5F6C78; font-size: 7.5pt; text-align: center; margin-top: 6px; }
.kbd { border: 1px solid #C3CAD0; border-radius: 3px; padding: 0 3px; background: #F3F5F7; white-space: nowrap; }
`;

function quickHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}
  body { font-size: 8.3pt; line-height: 1.32; }
  .cols { display: grid; grid-template-columns: 1.05fr 1fr; gap: 10px; }
  section { margin-bottom: 7px; }
  .steps td:first-child { width: 20px; }
  .wordgrid div { margin-bottom: 1px; }
  .box ul { margin: 2px 0 3px; padding-left: 14px; } .box li { margin-bottom: 1px; }
  </style></head><body>
  <div class="head"><h1>AI 3D Print Advisor Studio · Cheat sheet</h1><small>version ${VERSION} · keep it next to your printer</small></div>
  <div class="cols"><div>
    <section><h2>The 6 steps to a good print</h2><table class="steps">${STEPS.map(([t, d], i) => `<tr><td><span class="num">${i + 1}</span></td><td><b>${t}.</b> ${d}</td></tr>`).join('')}</table></section>
    <section><h2>Buttons at the top</h2><table>${BUTTONS.map(([b, d]) => `<tr><td><span class="kbd">${b}</span></td><td>${d}</td></tr>`).join('')}</table>
      <p style="margin:3px 0 0"><b>Mouse:</b> drag turns the model · scroll zooms · right-drag turns while painting.</p></section>
    <section><h2>Problem → what to try</h2><table>${PROBLEMS.map(([p, t]) => `<tr><td style="width:36%"><b>${p}</b></td><td>${t}</td></tr>`).join('')}</table>
      <p style="margin:3px 0 0">For a failed print: <b>Print history → Troubleshoot…</b>, paint where it failed, add photos.</p></section>
  </div><div>
    <section class="box"><h2>Why a print can still fail</h2><p style="margin:0">The app picks settings. These happen outside it:</p>
      <ul>${FACTORS.map(([t, d]) => `<li><b>${t}.</b> ${d}</li>`).join('')}</ul><p style="margin:0">${AI_NOTE}</p></section>
    <section class="box key" style="margin-top:7px"><h2>Your AI key</h2><p style="margin:0">${KEY_NOTE}</p></section>
    <section style="margin-top:7px"><h2>Color remix in 5 clicks</h2><p style="margin:0"><b>Color remix…</b> → <b>Identify parts with AI</b> → <b>Confirm parts</b> → <b>Generate</b> → <b>Apply to model</b>.</p></section>
    <section><h2>Words to know</h2><div class="wordgrid">${QUICK_WORDS.map(([w, d]) => `<div><b>${w}:</b> ${d}</div>`).join('')}</div>
      <p style="margin:3px 0 0">Every word, with pictures: <b>Glossary</b> in the app (or the booklet).</p></section>
  </div></div>
  <div class="foot">Free and open source · github.com/jtroberts83/AI-Print-Advisor-Studio · Not affiliated with Snapmaker or Anthropic.</div>
  </body></html>`;
}

function bookletHtml() {
  const terms = [...TERMS].sort((a, b) => a.title.localeCompare(b.title));
  const PER = 12, pages = [];
  for (let i = 0; i < terms.length; i += PER) pages.push(terms.slice(i, i + PER));
  const TROUBLE = [
    ['Spaghetti (a tangle of loose plastic)', 'The print came loose, or an overhang had nothing under it.', 'Clean the bed; keep the brim; more bed contact; supports on; use the troubleshooter.'],
    ['Warping (corners lift)', 'Plastic shrinks as it cools; cold room or drafts; dirty bed.', 'Brim; clean bed; warmer bed; no drafts; enclosure for ABS/ASA.'],
    ['Poor first layer', 'Bed dirty or not level; Z offset off; damp filament.', 'Wash the bed; re-run leveling/calibration; slow first layer.'],
    ['Stringing and blobs', 'Wet filament; nozzle too hot; little retraction.', 'Dry the filament; lower temperature a little; more retraction.'],
    ['Drooping overhangs', 'Too steep without supports; not enough cooling.', 'Better orientation; supports on; more cooling; slower.'],
    ['Under-extrusion (gaps, thin walls)', 'Partly clogged or worn nozzle; wet filament; too fast.', 'Clean or replace the nozzle; dry filament; slow down.'],
    ['Layer shift (layers move sideways)', 'Head hit something; loose belts; too fast.', 'Check belts; clear the area; lower speed and acceleration.'],
    ['Layer separation, cracks', 'Too cool; drafts; temperature swings.', 'Hotter nozzle; less cooling; no drafts; enclosure.'],
    ['Elephant’s foot (bottom bulges)', 'Bed too hot; first layer squashed.', 'Lower bed a few degrees; check Z offset.'],
    ['Color mixing at changes', 'Too little purge between colors.', 'More purge; keep the prime tower.'],
    ['Zits and seams', 'Where each loop starts and ends.', 'Seam position “aligned” or “back”; dry filament.'],
  ];
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}
  body { font-size: 9.6pt; line-height: 1.42; }
  .page { break-after: page; }
  .page:last-child { break-after: auto; }
  section { margin-bottom: 12px; }
  h2 { font-size: 13pt; margin-bottom: 6px; }
  .steps td:first-child { width: 24px; }
  .steps td { padding: 4px; }
  .box { padding: 9px 12px; margin-bottom: 12px; }
  .box li { margin-bottom: 4px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .card { border: 1px solid #CBD2D8; border-radius: 6px; overflow: hidden; break-inside: avoid; font-size: 8pt; line-height: 1.35; }
  .card .pic { background: #F3F5F7; border-bottom: 1px solid #E1E6EA; }
  .card .pic svg { display: block; width: 100%; height: 108px; }
  .card h3 { font-size: 9.5pt; margin: 4px 7px 1px; }
  .card p { margin: 0 7px 5px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .cover { text-align: center; margin: 4px 0 14px; color: #4E5B67; }
  </style></head><body>
  <div class="page">
    <div class="head"><h1>AI 3D Print Advisor Studio · Booklet</h1><small>version ${VERSION}</small></div>
    <p class="cover">Your reference for the app and for 3D printing words. Pages 1–2: using the app and getting good prints. Page 3: fixing problems. Then every word, with a picture.</p>
    <section><h2>The 6 steps to a good print</h2><table class="steps">${STEPS.map(([t, d], i) => `<tr><td><span class="num">${i + 1}</span></td><td><b>${t}.</b> ${d}</td></tr>`).join('')}</table></section>
    <section><h2>Buttons at the top</h2><table>${BUTTONS.map(([b, d]) => `<tr><td style="width:110px"><span class="kbd">${b}</span></td><td>${d}</td></tr>`).join('')}</table></section>
    <section><h2>Mouse</h2><table><tr><td style="width:110px"><b>Drag</b></td><td>Turn the model</td></tr><tr><td><b>Scroll</b></td><td>Zoom</td></tr><tr><td><b>Right-drag</b></td><td>Turn while painting (Color remix, troubleshooter)</td></tr></table></section>
    <section><h2>More things the app does</h2><table>
      <tr><td style="width:150px"><b>Compare slices</b></td><td>Slice Fine, Fast and Recommended versions side by side: how it looks, how strong, how long.</td></tr>
      <tr><td><b>Color remix</b></td><td>Color remix… → Identify parts with AI → Confirm parts → Generate → Apply to model. Uses filament from your library.</td></tr>
      <tr><td><b>Filament library</b></td><td>Filament → + Add filament, or 📷 From screenshot (drop or Ctrl+V an order page). Track spools and locations.</td></tr>
      <tr><td><b>Troubleshooter</b></td><td>Print history → Troubleshoot… → paint where it failed → add photos → Troubleshoot with Claude.</td></tr>
      <tr><td><b>MakerWorld files</b></td><td>Open them here first: the app converts Bambu Lab files for a Snapmaker U1 or another non-Bambu printer.</td></tr>
      <tr><td><b>Guided tour</b></td><td>⚙ Settings → Take the guided tour again.</td></tr></table></section>
  </div>
  <div class="page">
    <div class="box key"><h2>Setting up: your AI key</h2><p style="margin:0 0 6px">${KEY_NOTE}</p>
      <p style="margin:0"><b>In ⚙ Settings you also set:</b> your printers (Find printers on my network, or type the address you open Fluidd/Mainsail with), where Snapmaker Orca is, your Claude model (Sonnet is the best balance; Haiku is cheapest; Opus is most careful), your experience level and the word explanations.</p></div>
    <div class="box"><h2>Why a print can still fail (and it’s not the settings)</h2>
      <p style="margin:0 0 4px">The app chooses settings. A lot of what decides a print happens outside it, so even the best settings can’t promise a perfect print:</p>
      <ul style="margin:0 0 6px; padding-left: 18px">${FACTORS.map(([t, d]) => `<li><b>${t}.</b> ${d}</li>`).join('')}</ul>
      <p style="margin:0">${AI_NOTE}</p></div>
    <section><h2>Good habits</h2><table>
      <tr><td style="width:24px">✔</td><td>Keep filament dry: sealed bags or boxes with desiccant; dry it if it has been out for days.</td></tr>
      <tr><td>✔</td><td>Wash the bed now and then (dish soap and water), and don’t touch the print area with your fingers.</td></tr>
      <tr><td>✔</td><td>Watch the first layer: most failures show up there.</td></tr>
      <tr><td>✔</td><td>Keep the printer away from drafts, windows and air vents; keep the room temperature steady.</td></tr>
      <tr><td>✔</td><td>Run the printer’s calibration after moving it or changing the nozzle.</td></tr>
      <tr><td>✔</td><td>New filament or a big print? Try a small test print first.</td></tr>
      <tr><td>✔</td><td>When something fails, use the troubleshooter: the more you tell it (photos too), the better it gets.</td></tr></table></section>
  </div>
  <div class="page">
    <h2>Problem → likely cause → what to try</h2>
    <table><tr><th style="width:30%">Problem</th><th style="width:32%">Likely cause</th><th>What to try</th></tr>
      ${TROUBLE.map(([p, c, t]) => `<tr><td><b>${p}</b></td><td>${c}</td><td>${t}</td></tr>`).join('')}</table>
    <p style="margin-top:10px">The app’s <b>troubleshooter</b> (Print history → Troubleshoot…) reads what the printer actually did at the failed spot and suggests settings for the next print, plus things to check at the printer.</p>
  </div>
  ${pages.map((ts, i) => `<div class="page"><h2>Words, explained (${i + 1} of ${pages.length})</h2><div class="grid">${ts.map(t => `<div class="card"><div class="pic">${PIC[t.pic] || ''}</div><h3>${t.title}</h3><p>${strip(t.short)}</p></div>`).join('')}</div></div>`).join('')}
  </body></html>`;
}

async function toPdf(html, file) {
  const w = new BrowserWindow({ show: false, width: 816, height: 1056 });
  fs.mkdirSync(OUT, { recursive: true });
  const page = file.replace(/\.pdf$/, '.html');
  fs.writeFileSync(page, html);
  await w.loadFile(page);
  const pdf = await w.webContents.printToPDF({ pageSize: 'Letter', printBackground: true, preferCSSPageSize: true });
  fs.writeFileSync(file, pdf);
  w.destroy(); fs.unlinkSync(page);
  console.log('Wrote', file);
}

app.on('window-all-closed', () => {});   // keep running between the two PDFs
app.whenReady().then(async () => {
  try {
    await toPdf(quickHtml(), path.join(OUT, 'AI-3D-Print-Advisor-Cheat-Sheet-1-page.pdf'));
    await toPdf(bookletHtml(), path.join(OUT, 'AI-3D-Print-Advisor-Booklet.pdf'));
  } catch (e) { console.error(e); process.exitCode = 1; }
  app.quit();
});
