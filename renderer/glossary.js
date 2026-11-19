// Beginner word help: 3D printing words in the app get a dotted underline; hovering one shows a plain explanation
// with a drawing, clicking keeps it open, and the Glossary window lists every word. On for "Brand new" and
// "A little" (Settings can turn it on or off for anyone). Works in the main window and the Filament screen (an iframe).
//
// The text is only wrapped in <span class="term">: an element's textContent stays the same, and when the app
// re-renders something the spans go with it and are added again.

// ---------- drawings (drawn here, so they work offline and in both themes: they sit on a light card) ----------
const K = { bed: '#3B4148', bedTop: '#7A848D', brass: '#D4A62A', block: '#9AA4AD', fin: '#B8C0C7', ink: '#18232E', mute: '#5F6C78',
  teal: '#1F9AAE', tealD: '#167585', orange: '#E8833A', red: '#D9534F', blue: '#3B6FD1', white: '#FFFFFF', grey: '#C3CAD0', green: '#3E8E5A', paper: '#FFFFFF' };
const svg = (body, vb = '0 0 240 140') => `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" font-family="Segoe UI, sans-serif">${body}</svg>`;
const T = (x, y, s, o = {}) => `<text x="${x}" y="${y}" font-size="${o.size || 10.5}" fill="${o.color || K.ink}" text-anchor="${o.anchor || 'middle'}" font-weight="${o.bold ? 600 : 400}">${s}</text>`;
const line = (x1, y1, x2, y2, c = K.mute, w = 1, dash = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="${w}" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
const arrow = (x1, y1, x2, y2, c = K.mute) => { const a = Math.atan2(y2 - y1, x2 - x1), h = 6;
  return line(x1, y1, x2, y2, c, 1.6) + `<polygon points="${x2},${y2} ${x2 - h * Math.cos(a - .45)},${y2 - h * Math.sin(a - .45)} ${x2 - h * Math.cos(a + .45)},${y2 - h * Math.sin(a + .45)}" fill="${c}"/>`; };
const bed = (x, y, w) => `<rect x="${x}" y="${y}" width="${w}" height="9" rx="2" fill="${K.bed}"/><rect x="${x}" y="${y}" width="${w}" height="2.5" rx="1" fill="${K.bedTop}"/>`;
// a hotend whose nozzle tip is at (x, y); s scales it
const nozzle = (x, y, s = 1, fil = K.teal) => `<g transform="translate(${x} ${y}) scale(${s})">
  <line x1="0" y1="-62" x2="0" y2="-44" stroke="${fil}" stroke-width="3"/>
  ${[0, 1, 2, 3].map(i => `<rect x="-11" y="${-48 + i * 4}" width="22" height="2.4" fill="${K.fin}"/>`).join('')}
  <rect x="-13" y="-31" width="26" height="14" rx="1.5" fill="${K.block}"/>
  <polygon points="-7,-17 7,-17 2.5,0 -2.5,0" fill="${K.brass}"/></g>`;
const spool = (x, y, r = 26, c = K.teal) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>${[.82, .64].map(k => `<circle cx="${x}" cy="${y}" r="${r * k}" fill="none" stroke="${K.white}" stroke-opacity=".35"/>`).join('')}
  <circle cx="${x}" cy="${y}" r="${r * .42}" fill="#E9EDF0" stroke="${K.grey}"/><circle cx="${x}" cy="${y}" r="${r * .16}" fill="${K.mute}"/>`;
const rocket = (x, y, s, upright) => upright
  ? `<g transform="translate(${x} ${y}) scale(${s})"><polygon points="0,-60 -9,-44 9,-44" fill="${K.red}"/><rect x="-9" y="-44" width="18" height="38" fill="${K.white}" stroke="${K.mute}"/><circle cx="0" cy="-30" r="4" fill="${K.blue}"/><polygon points="-9,-16 -17,-2 -9,-6" fill="${K.red}"/><polygon points="9,-16 17,-2 9,-6" fill="${K.red}"/><rect x="-6" y="-6" width="12" height="6" fill="${K.grey}"/></g>`
  : `<g transform="translate(${x} ${y}) scale(${s})"><polygon points="60,-9 44,0 44,-18" fill="${K.red}"/><rect x="6" y="-18" width="38" height="18" fill="${K.white}" stroke="${K.mute}"/><circle cx="30" cy="-9" r="4" fill="${K.blue}"/><rect x="0" y="-15" width="6" height="12" fill="${K.grey}"/></g>`;
const cube = (x, y, s, c = K.teal) => `<g transform="translate(${x} ${y}) scale(${s})"><polygon points="0,-30 26,-15 0,0 -26,-15" fill="${c}" opacity=".75"/><polygon points="-26,-15 0,0 0,30 -26,15" fill="${c}"/><polygon points="26,-15 0,0 0,30 26,15" fill="${K.tealD}"/></g>`;
const fileDoc = (x, y) => `<path d="M${x} ${y} h60 l22 22 v88 h-82 z" fill="${K.paper}" stroke="${K.grey}"/><path d="M${x + 60} ${y} v22 h22" fill="none" stroke="${K.grey}"/>`;
const gear = (x, y, c = K.mute) => `<g transform="translate(${x} ${y})" fill="${c}">${[...Array(8)].map((_, i) => `<rect x="-2.5" y="-11" width="5" height="6" rx="1" transform="rotate(${i * 45})"/>`).join('')}<circle r="7.5"/><circle r="3" fill="${K.paper}"/></g>`;

const PIC = {
  slicer: svg(`${cube(40, 62, 1)}${T(40, 118, '3D model')}${arrow(74, 62, 96, 62)}
    ${[0, 1, 2, 3, 4, 5].map(i => `<rect x="104" y="${38 + i * 9}" width="44" height="6" rx="1" fill="${i % 2 ? K.teal : K.tealD}"/>`).join('')}${T(126, 118, 'cut into layers')}
    ${arrow(154, 62, 172, 62)}<rect x="178" y="30" width="52" height="64" rx="3" fill="${K.paper}" stroke="${K.grey}"/>
    ${['G1 X12', 'G1 Y30', 'G1 X40', 'G1 Y8', 'G1 Z.2'].map((s, i) => T(204, 44 + i * 11, s, { size: 8.5, color: K.mute })).join('')}${T(204, 118, 'instructions')}`),
  gcode: svg(`<rect x="44" y="12" width="152" height="104" rx="4" fill="${K.paper}" stroke="${K.grey}"/>
    ${['G28        ; go home', 'M104 S210  ; heat nozzle', 'G1 Z0.2    ; move down', 'G1 X20 Y35 E0.4', 'G1 X40 Y35 E0.8', '…  thousands more'].map((s, i) => T(56, 32 + i * 15, s, { size: 9.5, anchor: 'start', color: i > 4 ? K.mute : K.ink })).join('')}
    ${T(120, 132, 'each line is one small move for the printer', { color: K.mute })}`),
  layers: svg(`${bed(40, 112, 160)}${[...Array(12)].map((_, i) => { const w = 110 - i * 6; return `<rect x="${120 - w / 2}" y="${104 - i * 7.5}" width="${w}" height="6.5" rx="3" fill="${i % 2 ? K.teal : K.tealD}"/>`; }).join('')}
    ${line(170, 36, 152, 60)}${T(170, 22, 'each band is', { anchor: 'start' })}${T(170, 34, 'one layer', { anchor: 'start' })}${T(120, 134, 'printed from the bottom up, one layer at a time', { color: K.mute })}`),
  layerHeight: svg(`${bed(20, 104, 90)}${bed(130, 104, 90)}
    ${[...Array(12)].map((_, i) => `<rect x="35" y="${99 - i * 5}" width="60" height="4" rx="2" fill="${i % 2 ? K.teal : K.tealD}"/>`).join('')}
    ${[...Array(4)].map((_, i) => `<rect x="145" y="${89 - i * 15}" width="60" height="14" rx="7" fill="${i % 2 ? K.orange : '#C96A27'}"/>`).join('')}
    ${T(65, 126, 'thin: 0.08 mm', { bold: true })}${T(65, 137, 'smooth, slow', { color: K.mute })}${T(175, 126, 'thick: 0.28 mm', { bold: true })}${T(175, 137, 'rougher, fast', { color: K.mute })}`, '0 0 240 142'),
  nozzle: svg(`${bed(20, 118, 200)}${nozzle(110, 112, 1.5)}<rect x="40" y="113" width="68" height="5" rx="2.5" fill="${K.teal}"/>
    ${line(132, 34, 160, 26)}${T(164, 29, 'cooling fins', { anchor: 'start' })}${line(130, 75, 160, 66)}${T(164, 69, 'heater block', { anchor: 'start' })}
    ${line(117, 102, 160, 96)}${T(164, 99, 'nozzle', { anchor: 'start', bold: true })}${T(164, 110, '(0.4 mm hole)', { anchor: 'start', color: K.mute })}
    ${line(110, 18, 76, 14)}${T(72, 17, 'filament in', { anchor: 'end' })}${T(60, 108, 'melted plastic', { color: K.mute })}`),
  toolhead: svg(`<rect x="10" y="14" width="220" height="6" rx="2" fill="${K.grey}"/>
    ${[[K.teal, 'T1', 40, 0], [K.red, 'T2', 92, 0], [K.blue, 'T3', 144, 0], [K.orange, 'T4', 196, 0]].map(([c, n, x]) => `${nozzle(x, n === 'T1' ? 104 : 80, .9, c)}<text x="${n === 'T1' ? x + 22 : x}" y="${n === 'T1' ? 88 : 100}" font-size="11" font-weight="600" text-anchor="middle" fill="${K.ink}">${n}</text>`).join('')}
    ${bed(10, 128, 220)}${T(120, 152, 'T1 is printing; the others wait their turn', { color: K.mute })}`, '0 0 240 158'),
  toolChange: svg(`<rect x="10" y="14" width="220" height="6" rx="2" fill="${K.grey}"/>${nozzle(70, 96, .9, K.teal)}${nozzle(170, 70, .9, K.red)}
    ${arrow(44, 102, 44, 70)}${arrow(196, 70, 196, 104)}${T(70, 118, 'T1 lifts away', { bold: true })}${T(170, 118, 'T2 comes down', { bold: true })}
    ${bed(10, 124, 220)}${T(120, 46, 'new color', { color: K.mute })}`),
  filament: svg(`${spool(70, 70, 46, K.teal)}<path d="M112 54 C150 40 170 40 190 28" fill="none" stroke="${K.teal}" stroke-width="3"/>
    ${T(180, 70, 'a plastic strand', { bold: true })}${T(180, 84, 'about 1.75 mm thick', { color: K.mute })}${T(180, 98, 'wound on a spool', { color: K.mute })}`),
  materials: svg(`${['', 'Easy', 'Tough', 'Heat', 'Bendy'].map((s, i) => T(52 + i * 40, 18, s, { bold: true })).join('')}
    ${[['PLA', 3, 1, 1, 0], ['PETG', 2, 2, 2, 0], ['ABS/ASA', 1, 2, 3, 0], ['TPU', 1, 3, 1, 3]].map(([n, ...v], r) => T(44, 44 + r * 26, n, { bold: true, anchor: 'end' }) +
      v.map((d, i) => [0, 1, 2].map(k => `<circle cx="${80 + i * 40 + (k - 1) * 9}" cy="${40 + r * 26}" r="3.6" fill="${k < d ? K.teal : K.grey}"/>`).join('')).join('')).join('')}
    ${T(130, 138, 'PLA is the easiest place to start', { color: K.mute })}`, '0 0 240 144'),
  genericPla: svg(`${spool(55, 52, 30, K.white)}<circle cx="55" cy="52" r="30" fill="none" stroke="${K.grey}"/>${spool(175, 52, 30, K.orange)}
    ${T(55, 100, 'Generic PLA', { bold: true })}${T(55, 113, 'safe settings that', { color: K.mute })}${T(55, 125, 'suit any PLA', { color: K.mute })}
    ${T(175, 100, 'Brand-name PLA', { bold: true })}${T(175, 113, 'settings tuned for', { color: K.mute })}${T(175, 125, 'that exact product', { color: K.mute })}`),
  bed: svg(`<rect x="22" y="10" width="8" height="112" fill="${K.grey}"/><rect x="210" y="10" width="8" height="112" fill="${K.grey}"/><rect x="22" y="20" width="196" height="6" fill="${K.grey}"/>
    ${nozzle(140, 66, .9)}${cube(96, 82, .9)}${bed(36, 112, 168)}${T(120, 134, 'the bed: the plate the model is printed on', { color: K.mute })}`),
  firstLayer: svg(`${bed(10, 100, 220)}${nozzle(130, 94, 1.5)}${[...Array(5)].map((_, i) => `<ellipse cx="${30 + i * 18}" cy="97" rx="9.5" ry="3.5" fill="${K.teal}"/>`).join('')}
    ${T(64, 78, 'squished flat', { bold: true })}${T(64, 90, 'so it grips', { color: K.mute })}${T(120, 128, 'the first layer is pressed onto the bed', { color: K.mute })}`),
  brim: svg(`<rect x="20" y="10" width="200" height="104" rx="6" fill="#E3E7EA"/>${[44, 37, 30, 23].map(r => `<circle cx="120" cy="62" r="${r}" fill="none" stroke="${K.orange}" stroke-width="2.4"/>`).join('')}
    <circle cx="120" cy="62" r="18" fill="${K.teal}"/>${T(120, 66, 'model', { color: K.white, size: 9 })}${line(160, 40, 186, 26)}${T(190, 28, 'brim', { anchor: 'start', bold: true })}
    ${T(120, 132, 'seen from above: extra rings, peeled off after', { color: K.mute })}`),
  raft: svg(`${bed(20, 112, 200)}${[0, 1, 2].map(i => `<rect x="62" y="${104 - i * 6}" width="116" height="5" fill="${i ? K.grey : '#AEB6BD'}"/>`).join('')}
    ${[...Array(10)].map((_, i) => line(66 + i * 12, 92, 66 + i * 12, 109, K.white, 1)).join('')}${cube(120, 58, .9)}
    ${line(178, 100, 196, 84)}${T(198, 82, 'raft', { anchor: 'start', bold: true })}${T(120, 134, 'a throw-away platform under the model', { color: K.mute })}`),
  skirt: svg(`<rect x="20" y="10" width="200" height="104" rx="6" fill="#E3E7EA"/><circle cx="120" cy="62" r="42" fill="none" stroke="${K.orange}" stroke-width="2.4"/>
    <circle cx="120" cy="62" r="22" fill="${K.teal}"/>${line(158, 44, 186, 26)}${T(190, 28, 'skirt', { anchor: 'start', bold: true })}
    ${T(120, 132, 'seen from above: a loop that doesn’t touch it', { color: K.mute })}`),
  overhang: svg(`${bed(10, 112, 220)}<polygon points="60,112 60,40 180,40 180,56 92,56 92,112" fill="${K.teal}"/>${line(92, 56, 180, 56, K.red, 3)}
    <rect x="94" y="60" width="86" height="50" fill="none" stroke="${K.red}" stroke-dasharray="3 3"/>${T(138, 88, 'thin air', { color: K.red, bold: true })}
    ${T(200, 36, 'overhang', { bold: true, anchor: 'end' })}${T(120, 134, 'the red underside has nothing below it to print on', { color: K.mute })}`),
  supports: svg(`${bed(10, 112, 220)}<polygon points="40,112 40,40 130,40 130,56 62,56 62,112" fill="${K.teal}"/>
    ${[74, 86, 98, 110, 122].map(x => `<rect x="${x}" y="58" width="5" height="54" fill="${K.grey}"/>`).join('')}${T(86, 30, 'normal supports', { bold: true })}
    <polygon points="150,112 150,40 226,40 226,56 168,56 168,112" fill="${K.teal}"/><path d="M200 112 L200 88 M200 88 L184 58 M200 88 L198 58 M200 88 L214 58" stroke="${K.grey}" stroke-width="4" fill="none" stroke-linecap="round"/>
    ${T(190, 30, 'tree supports', { bold: true })}${T(120, 134, 'grey: temporary props, snapped off after printing', { color: K.mute })}`),
  bridge: svg(`${bed(10, 112, 220)}<rect x="40" y="40" width="34" height="72" fill="${K.teal}"/><rect x="166" y="40" width="34" height="72" fill="${K.teal}"/>
    <rect x="74" y="40" width="92" height="8" fill="${K.orange}"/>${arrow(80, 30, 160, 30)}${T(120, 24, 'printed straight across the gap', { bold: true })}
    ${T(120, 84, 'nothing underneath', { color: K.mute })}${T(120, 134, 'a bridge: plastic stretched between two points', { color: K.mute })}`),
  infill: svg(`${[[60, 15, 4], [180, 40, 8]].map(([cx, pct, n]) => `<rect x="${cx - 46}" y="16" width="92" height="92" fill="#F4F6F7" stroke="${K.teal}" stroke-width="6"/>
    ${[...Array(n)].map((_, i) => { const t = 22 + (i + 1) * 80 / (n + 1); return line(cx - 40, t, cx + 40, t, K.orange, 1.6) + line(cx - 46 + 6 + (i + 1) * 80 / (n + 1), 22, cx - 46 + 6 + (i + 1) * 80 / (n + 1), 102, K.orange, 1.6); }).join('')}
    ${T(cx, 126, `${pct}% infill`, { bold: true })}`).join('')}${T(120, 140, 'cut open: the hidden pattern inside', { color: K.mute })}`, '0 0 240 146'),
  walls: svg(`<rect x="44" y="14" width="100" height="100" fill="#F4F6F7"/>${[0, 7, 14].map(d => `<rect x="${47 + d}" y="${17 + d}" width="${94 - 2 * d}" height="${94 - 2 * d}" fill="none" stroke="${K.teal}" stroke-width="5"/>`).join('')}
    ${[...Array(4)].map((_, i) => line(70 + i * 16, 40, 70 + i * 16, 88, K.orange, 1.4) + line(66, 44 + i * 14, 122, 44 + i * 14, K.orange, 1.4)).join('')}
    ${line(144, 24, 166, 24)}${T(170, 27, 'walls (3 loops)', { anchor: 'start', bold: true })}${line(110, 64, 166, 70)}${T(170, 73, 'infill', { anchor: 'start' })}${T(120, 134, 'cut open, seen from above', { color: K.mute })}`),
  purge: svg(`${nozzle(90, 70, 1.2, K.white)}
    <path d="M90 72 C 92 82, 84 88, 90 96" stroke="#E9A0A0" stroke-width="5" fill="none"/><ellipse cx="90" cy="104" rx="20" ry="7" fill="#E7B9B9"/><ellipse cx="90" cy="104" rx="10" ry="3" fill="${K.red}" opacity=".6"/>
    ${T(170, 50, 'old red is pushed out', { bold: true })}${T(170, 64, 'until the new white', { color: K.mute })}${T(170, 77, 'comes out clean', { color: K.mute })}${T(120, 132, 'the waste goes into the prime tower', { color: K.mute })}`),
  primeTower: svg(`${bed(10, 112, 220)}${rocket(80, 112, 1.4, true)}${[K.white, K.red, K.blue, K.grey, K.red, K.white, K.blue, K.red].map((c, i) => `<rect x="160" y="${102 - i * 9}" width="30" height="9" fill="${c}" stroke="${K.grey}" stroke-width=".5"/>`).join('')}
    ${line(192, 44, 200, 36)}${T(202, 26, 'prime', { bold: true, anchor: 'start' })}${T(202, 38, 'tower', { bold: true, anchor: 'start' })}${T(120, 134, 'the nozzle cleans out here at each color change', { color: K.mute, size: 9.5 })}`),
  ooze: svg(`${bed(10, 112, 220)}<rect x="40" y="56" width="30" height="56" fill="${K.teal}"/><rect x="170" y="56" width="30" height="56" fill="${K.teal}"/>
    ${[[60, 0], [64, 6], [62, 12], [66, 18]].map(([y, d]) => `<path d="M70 ${y} Q 120 ${y + 14 + d / 2} 170 ${y + 4}" stroke="${K.teal}" stroke-width=".9" fill="none"/>`).join('')}
    ${nozzle(120, 36, .8)}<ellipse cx="120" cy="40" rx="2.5" ry="4" fill="${K.teal}"/>${T(120, 134, 'oozing leaves thin “strings” between parts', { color: K.mute })}`),
  retraction: svg(`${bed(10, 112, 220)}${nozzle(70, 98, 1.2)}${arrow(48, 66, 48, 34, K.orange)}${T(48, 26, 'pulled back', { bold: true, color: K.orange })}
    ${arrow(86, 92, 160, 92, K.mute)}${nozzle(176, 98, 1.2)}${T(124, 108, 'no drips', { color: K.mute })}${T(120, 134, 'retraction: a quick pull-back before each jump', { color: K.mute })}`),
  warping: svg(`${bed(10, 112, 220)}<path d="M40 92 Q 46 108 70 110 L170 110 Q 194 108 200 92 L200 60 L40 60 Z" fill="${K.teal}"/>
    <path d="M40 92 Q 46 108 70 110" stroke="${K.red}" stroke-width="3" fill="none"/><path d="M200 92 Q 194 108 170 110" stroke="${K.red}" stroke-width="3" fill="none"/>
    ${T(30, 84, 'lifted', { color: K.red, bold: true, anchor: 'end' })}${T(120, 134, 'corners shrink as they cool and lift up', { color: K.mute })}`),
  orientation: svg(`${bed(10, 112, 100)}${bed(130, 112, 100)}${rocket(30, 92, .9, false)}${[38, 50, 62, 74].map(x => `<rect x="${x}" y="92" width="3" height="20" fill="${K.grey}"/>`).join('')}
    ${rocket(180, 112, 1.1, true)}${T(60, 40, 'lying down', { bold: true })}${T(60, 52, 'needs supports', { color: K.red })}${T(180, 40, 'standing up', { bold: true })}${T(180, 52, 'none needed', { color: K.green })}
    ${T(120, 134, 'the same model, placed two ways', { color: K.mute })}`),
  flow: svg(`${[['too little', 'gaps', 0], ['just right', '', 1], ['too much', 'blobs', 2]].map(([a, b, i]) => {
      const y = 30 + i * 34; return T(60, y + 4, a, { anchor: 'end', bold: true }) + (i === 0 ? [...Array(8)].map((_, k) => `<rect x="${74 + k * 15}" y="${y - 3}" width="10" height="6" rx="3" fill="${K.teal}"/>`).join('')
        : i === 1 ? `<rect x="74" y="${y - 3.5}" width="115" height="7" rx="3.5" fill="${K.teal}"/>` : `<path d="M74 ${y} q 8 -9 16 0 t 16 0 t 16 0 t 16 0 t 16 0 t 16 0 t 16 0" stroke="${K.teal}" stroke-width="10" fill="none" stroke-linecap="round"/>`) + T(198, y + 4, b, { color: K.mute, anchor: 'start' }); }).join('')}
    ${T(120, 134, 'flow: how much plastic comes out of the nozzle', { color: K.mute })}`),
  leveling: svg(`<polygon points="40,90 200,90 230,120 10,120" fill="${K.bedTop}"/>${[96, 105, 114].map(y => [0, 1, 2, 3, 4].map(c => `<circle cx="${(40 - (y - 90)) + (160 + 2 * (y - 90)) * (c + .5) / 5}" cy="${y}" r="2.4" fill="${K.orange}"/>`).join('')).join('')}
    ${nozzle(120, 82, 1)}${T(120, 136, 'the printer measures the bed at many points first', { color: K.mute })}`),
  timelapse: svg(`${[0, 1, 2, 3].map(i => `<rect x="${14 + i * 54}" y="40" width="48" height="56" rx="3" fill="#EEF1F3" stroke="${K.grey}"/>${bed(18 + i * 54, 84, 40)}<rect x="${30 + i * 54}" y="${84 - (i + 1) * 9}" width="16" height="${(i + 1) * 9}" fill="${K.teal}"/>`).join('')}
    ${T(120, 26, 'one photo per layer, played as a video', { bold: true })}${T(120, 120, 'timelapse', { color: K.mute })}`),
  temperature: svg(`${[[70, 'nozzle', '≈ 210 °C', .8], [170, 'bed', '≈ 60 °C', .35]].map(([x, a, b, f]) => `<rect x="${x - 7}" y="22" width="14" height="72" rx="7" fill="#EEF1F3" stroke="${K.grey}"/>
      <rect x="${x - 3.5}" y="${92 - 66 * f}" width="7" height="${66 * f}" rx="3.5" fill="${K.red}"/><circle cx="${x}" cy="98" r="11" fill="${K.red}"/>${T(x, 124, a, { bold: true })}${T(x, 136, b, { color: K.mute })}`).join('')}`, '0 0 240 142'),
  fan: svg(`${bed(10, 112, 220)}<rect x="40" y="70" width="90" height="42" fill="${K.teal}"/>${nozzle(110, 70, .9)}
    <circle cx="184" cy="56" r="22" fill="#EEF1F3" stroke="${K.grey}"/>${[0, 120, 240].map(a => `<ellipse cx="184" cy="46" rx="5" ry="10" fill="${K.mute}" transform="rotate(${a} 184 56)"/>`).join('')}
    ${arrow(160, 62, 126, 72, K.blue)}${arrow(162, 70, 132, 80, K.blue)}${T(120, 134, 'the fan cools each fresh layer so it sets quickly', { color: K.mute })}`),
  seam: svg(`<ellipse cx="120" cy="28" rx="46" ry="12" fill="${K.tealD}"/><rect x="74" y="28" width="92" height="80" fill="${K.teal}"/><ellipse cx="120" cy="108" rx="46" ry="12" fill="${K.teal}"/>
    ${[...Array(10)].map((_, i) => `<circle cx="134" cy="${36 + i * 8}" r="2" fill="${K.white}"/>`).join('')}${line(138, 60, 190, 50)}${T(194, 53, 'seam', { anchor: 'start', bold: true })}
    ${T(120, 136, 'where each layer starts and ends', { color: K.mute })}`),
  ironing: svg(`<rect x="20" y="70" width="200" height="40" fill="${K.teal}"/><path d="M20 70 ${[...Array(12)].map((_, i) => `l 5 -4 l 5 4`).join(' ')}" fill="${K.teal}"/>
    ${nozzle(140, 68, 1.1)}${arrow(160, 56, 196, 56)}${T(70, 54, 'rough', { color: K.mute })}${T(190, 90, 'smooth', { color: K.white, bold: true })}
    ${T(120, 134, 'the hot nozzle glides over the top to smooth it', { color: K.mute })}`),
  preset: svg(`${[['Printer', 'Snapmaker U1 (0.4 nozzle)'], ['Filament', 'Generic PLA'], ['Process', '0.20 mm Standard']].map(([a, b], i) => `<rect x="${30 + i * 10}" y="${14 + i * 30}" width="170" height="40" rx="5" fill="${K.paper}" stroke="${K.grey}"/>
      ${T(42 + i * 10, 30 + i * 30, a, { anchor: 'start', bold: true })}${T(42 + i * 10, 44 + i * 30, b, { anchor: 'start', color: K.mute })}`).join('')}
    ${T(120, 132, 'saved groups of settings you pick by name', { color: K.mute })}`),
  clog: svg(`${bed(10, 112, 220)}${nozzle(120, 88, 1.5)}${line(108, 92, 132, 116, K.red, 4)}${line(132, 92, 108, 116, K.red, 4)}
    ${T(190, 60, 'nothing', { bold: true, color: K.red })}${T(190, 73, 'comes out', { bold: true, color: K.red })}${T(120, 134, 'a clog: something blocks the nozzle', { color: K.mute })}`),
  underExtrusion: svg(`${T(120, 20, 'gaps and thin lines', { bold: true })}${[0, 1, 2, 3].map(r => [...Array(10)].map((_, k) => (r + k) % 3 === 0 ? '' : `<rect x="${30 + k * 18}" y="${30 + r * 16}" width="${10 + (k % 2) * 4}" height="${6 + (k % 3)}" rx="3" fill="${K.teal}"/>`).join('')).join('')}
    ${T(120, 116, 'under-extrusion: not enough plastic comes out', { color: K.mute })}`, '0 0 240 128'),
  layerShift: svg(`${bed(10, 112, 220)}<rect x="60" y="66" width="80" height="46" fill="${K.teal}"/><rect x="88" y="22" width="80" height="44" fill="${K.teal}"/>${line(60, 66, 170, 66, K.red, 2)}
    ${T(186, 62, 'slipped', { bold: true, color: K.red, anchor: 'start' })}${T(120, 134, 'layer shift: the top part moved sideways', { color: K.mute })}`),
  spaghetti: svg(`${bed(10, 112, 220)}<path d="M40 108 C 60 60, 90 120, 110 70 S 150 40, 140 100 S 190 60, 200 104 M60 100 C 80 40, 120 110, 160 50 S 200 90, 180 108 M70 108 C 100 80, 90 30, 130 80" stroke="${K.teal}" stroke-width="2.4" fill="none"/>
    ${T(120, 134, 'a failed print: loose tangled plastic', { color: K.mute })}`),
  mesh: svg(`${(() => { const P = [[120, 18], [168, 40], [180, 88], [140, 118], [96, 118], [58, 88], [70, 40]], c = [120, 72];
      return P.map((p, i) => { const q = P[(i + 1) % P.length]; return `<polygon points="${p} ${q} ${c}" fill="${i % 2 ? K.teal : K.tealD}" stroke="${K.white}" stroke-width="1.4"/>`; }).join(''); })()}
    ${T(120, 136, 'a model’s surface is made of flat triangles', { color: K.mute })}`),
  elephantFoot: svg(`${bed(10, 112, 220)}<path d="M74 30 L166 30 L166 98 Q 176 106 174 112 L66 112 Q 64 106 74 98 Z" fill="${K.teal}"/>
    <path d="M166 98 Q 176 106 174 112 M74 98 Q 64 106 66 112" stroke="${K.red}" stroke-width="3" fill="none"/>${T(196, 100, 'bulge', { color: K.red, bold: true })}
    ${T(120, 134, 'elephant’s foot: the bottom layers spread out', { color: K.mute })}`),
  extruder: svg(`<line x1="120" y1="4" x2="120" y2="96" stroke="${K.teal}" stroke-width="4"/>${[96, 144].map(x => `<circle cx="${x}" cy="40" r="20" fill="${K.grey}"/>${[...Array(10)].map((_, i) => `<rect x="${x - 2}" y="${18}" width="4" height="6" fill="${K.grey}" transform="rotate(${i * 36} ${x} 40)"/>`).join('')}<circle cx="${x}" cy="40" r="4" fill="${K.mute}"/>`).join('')}
    ${nozzle(120, 124, .9, K.teal).replace('y1="-62"', 'y1="-50"')}${arrow(60, 30, 60, 60, K.orange)}${T(46, 74, 'pushes', { color: K.orange, bold: true })}
    ${T(170, 80, 'gears grip the', { anchor: 'start', size: 9 })}${T(170, 92, 'filament', { anchor: 'start', size: 9 })}`, '0 0 240 132'),
  file3mf: svg(`${fileDoc(80, 12)}${cube(121, 62, .7)}${T(121, 108, '.3mf', { bold: true, size: 14 })}
    ${line(56, 56, 98, 62)}${T(52, 59, 'model', { anchor: 'end', size: 9.5 })}
    ${[K.red, K.white, K.blue].map((c, i) => `<circle cx="${180 + i * 13}" cy="38" r="5" fill="${c}" stroke="${K.mute}" stroke-width=".8"/>`).join('')}${T(193, 56, 'colors', { size: 9.5 })}
    ${gear(193, 82)}${T(193, 104, 'settings', { size: 9.5 })}
    ${T(120, 136, 'one file: model + colors + settings', { color: K.mute })}`, '0 0 240 142'),
  fileStl: svg(`${fileDoc(80, 12)}${cube(121, 62, .7, K.block).replace(`fill="${K.tealD}"`, `fill="${K.mute}"`)}${T(121, 108, '.stl', { bold: true, size: 14 })}
    ${line(56, 56, 98, 62)}${T(52, 59, 'shape', { anchor: 'end', size: 9.5 })}
    ${['no colors', 'no settings'].map((s, i) => `<g transform="translate(178 ${38 + i * 34})">${line(-5, -5, 5, 5, K.red, 2)}${line(-5, 5, 5, -5, K.red, 2)}</g>${T(178, 56 + i * 34, s, { size: 9.5 })}`).join('')}
    ${T(120, 136, 'shape only: you choose colors and settings', { color: K.mute })}`, '0 0 240 142'),
  website: svg(`<rect x="20" y="12" width="200" height="104" rx="5" fill="${K.paper}" stroke="${K.grey}"/><rect x="20" y="12" width="200" height="14" rx="5" fill="#E3E7EA"/>
    ${[0, 1, 2].map(c => [0, 1].map(r => `<rect x="${32 + c * 62}" y="${34 + r * 40}" width="52" height="32" rx="3" fill="#EEF1F3"/>${cube(58 + c * 62, 52 + r * 40, .38, [K.teal, K.orange, K.blue][(c + r) % 3])}`).join('')).join('')}
    ${T(120, 134, 'a website full of free models to download', { color: K.mute })}`),
};

// ---------- the words ----------
// match: the spellings to underline (longest wins). cs: match case exactly (so "PLA" isn't found inside other words).
const TERMS = [
  { id: 'slicer', title: 'Slicer, slicing', pic: 'slicer', match: ['slicer', 'slicers', 'slicing', 'sliced', 'slice', 'slices', 'Snapmaker Orca', 'Orca Slicer', 'Bambu Studio'],
    short: 'A slicer is the program that turns a 3D model into instructions the printer can follow. It cuts the model into hundreds of thin horizontal layers (“slices”) and works out every move of the nozzle.',
    more: 'Snapmaker Orca and Bambu Studio are slicers. In this app, “a slice” means one run of the slicer with a set of settings, so comparing slices means comparing versions of the same print.' },
  { id: 'gcode', title: 'G-code', pic: 'gcode', match: ['G-code', 'gcode', 'g-code'],
    short: 'The file the printer actually runs: a long list of simple steps like “heat to 210 °C” and “move here while pushing out plastic”.',
    more: 'The slicer writes it from your model and settings. You don’t need to read it; the app sends it to the printer for you.' },
  { id: '3mf', title: '3MF file', pic: 'file3mf', cs: true, match: ['3MF', '.3mf', '3mf'],
    short: 'A 3D model file. Besides the shape, it can hold the colors and the print settings, so one file has everything needed to print.',
    more: 'Most models you download from MakerWorld or Printables come as .3mf. An STL file is the older kind: shape only, no colors or settings.' },
  { id: 'stl', title: 'STL file', pic: 'fileStl', cs: true, match: ['STL', 'STLs'],
    short: 'An older, very common 3D model file. It holds only the shape: no colors and no settings.', more: 'This app works with .3mf files. Snapmaker Orca can open an STL and save it as a 3MF.' },
  { id: 'mesh', title: 'Mesh, triangles', pic: 'mesh', match: ['mesh', 'meshes', 'triangles', 'triangle'],
    short: 'A 3D model’s surface is built from many small flat triangles, together called the mesh. More triangles means more detail, but a bigger, slower file.',
    more: 'Very detailed downloads can have millions of triangles. “Fix model” can lighten them without a visible difference.' },
  { id: 'layer', title: 'Layer', pic: 'layers', match: ['layer', 'layers', 'layer lines'],
    short: 'A 3D printer builds a model as a stack of very thin flat slices of plastic, one on top of the other, from the bottom up. Each slice is a layer.',
    more: 'You can often see faint lines on the side of a print: those are the layers.' },
  { id: 'layerHeight', title: 'Layer height', pic: 'layerHeight', match: ['layer height', 'layer heights'],
    short: 'How thick each layer is, usually 0.08–0.28 mm. Thinner layers look smoother but take much longer; thicker ones print fast with more visible lines.',
    more: '0.20 mm is the everyday choice. Halving the layer height roughly doubles the print time.' },
  { id: 'firstLayer', title: 'First layer', pic: 'firstLayer', match: ['first layer', 'first layers', 'bed adhesion', 'adhesion'],
    short: 'The very bottom layer, pressed onto the bed. If it sticks well, the rest of the print usually goes well.',
    more: 'Most failed prints start with a first layer that didn’t stick. A clean bed (wash it with dish soap and water) helps a lot.' },
  { id: 'nozzle', title: 'Nozzle', pic: 'nozzle', match: ['nozzle', 'nozzles', 'hotend', 'hotends', 'hot end'],
    short: 'The small brass tip that melts the plastic and lays it down in a thin line, like a very precise hot glue gun. The usual hole size is 0.4 mm.',
    more: 'The hotend is the heated part the nozzle is screwed into. Never touch it while the printer is on: it’s over 200 °C.' },
  { id: 'toolhead', title: 'Toolhead (T1, T2, T3, T4)', pic: 'toolhead', match: ['toolhead', 'toolheads', 'tool head', 'tool heads', 'T1', 'T2', 'T3', 'T4'], cs: true,
    short: 'The moving part of the printer that holds a nozzle. The Snapmaker U1 has four toolheads, called T1 to T4, each loaded with its own filament, so it can print up to four colors.',
    more: 'A printer with one toolhead uses T1 for everything. In this app you tell each toolhead which filament it has.' },
  { id: 'toolChange', title: 'Tool change', pic: 'toolChange', match: ['tool change', 'tool changes', 'toolchange', 'toolchanges', 'color change', 'color changes', 'colour change'],
    short: 'Switching from one toolhead to another in the middle of a print, to print a different color or material.',
    more: 'Each change takes a few seconds, so models with many color changes per layer take longer.' },
  { id: 'filament', title: 'Filament', pic: 'filament', match: ['filament', 'filaments'],
    short: 'The plastic “ink” of a 3D printer: a long strand of plastic, about 1.75 mm thick, wound on a spool. The printer melts it to build the model.',
    more: 'It comes in many materials (PLA, PETG, TPU…) and colors. Most filament dislikes damp air: store it in a sealed bag or box when you’re not using it.' },
  { id: 'spool', title: 'Spool', pic: 'filament', match: ['spool', 'spools'],
    short: 'The reel that filament is wound on, usually holding 1 kg (about 330 m).', more: 'The Filament screen keeps track of how many spools you have and roughly how much is left.' },
  { id: 'pla', title: 'PLA', pic: 'materials', cs: true, match: ['PLA', 'PLA+'],
    short: 'The most common and easiest filament. It prints at low temperatures, doesn’t smell much and rarely warps. Start with PLA.',
    more: 'It softens in heat (say, a hot car), so it isn’t ideal for outdoor or hot uses.' },
  { id: 'petg', title: 'PETG', pic: 'materials', cs: true, match: ['PETG'],
    short: 'A tougher filament than PLA that handles heat better and bends a little before it breaks. Good for useful parts.', more: 'It’s a bit stringier than PLA and sticks very strongly to some beds.' },
  { id: 'abs', title: 'ABS and ASA', pic: 'materials', cs: true, match: ['ABS', 'ASA'],
    short: 'Strong, heat-resistant filaments (ASA also survives sunlight). They give off fumes and tend to warp, so they print best in an enclosed printer with good ventilation.', more: 'Not recommended as a first material.' },
  { id: 'tpu', title: 'TPU', pic: 'materials', cs: true, match: ['TPU'],
    short: 'A rubbery, flexible filament for things like phone cases, tyres and bumpers.', more: 'It has to be printed slowly.' },
  { id: 'genericPla', title: '“Generic PLA”', pic: 'genericPla', match: ['Generic PLA', 'Generic PETG', 'Generic TPU', 'Generic ABS', 'Generic ASA', 'generic preset', 'generic presets'],
    short: '“Generic” filament settings are safe, middle-of-the-road settings that work for any brand of that material. “Generic PLA” means “standard settings for any PLA”.',
    more: 'Some brands also have their own preset, tuned for their exact filament. If yours isn’t listed, the Generic one is the right pick.' },
  { id: 'bed', title: 'Bed (build plate)', pic: 'bed', match: ['bed', 'beds', 'build plate', 'build plates', 'print bed', 'heated bed', 'plate', 'plates', 'buildplate'],
    short: 'The flat surface the model is printed on. It’s heated so the first layer sticks, and on most printers it’s a removable sheet you flex to pop the print off.',
    more: 'A “plate” in a project file means one bed’s worth of parts; a 3MF can hold several plates.' },
  { id: 'leveling', title: 'Bed leveling', pic: 'leveling', match: ['bed leveling', 'bed levelling', 'leveling', 'levelling', 'auto-leveling', 'bed mesh'],
    short: 'Before printing, the printer measures the height of the bed at many points, so it can keep the nozzle at exactly the right distance everywhere.',
    more: 'It adds a minute or two, and helps the first layer stick evenly.' },
  { id: 'temperature', title: 'Nozzle and bed temperature', pic: 'temperature', match: ['temperature', 'temperatures', 'nozzle temperature', 'bed temperature', 'nozzle temp', 'bed temp'],
    short: 'How hot the nozzle (to melt the plastic) and the bed (to keep the first layer stuck) are. Each material has its own range: PLA is about 210 °C nozzle, 60 °C bed.',
    more: 'The filament preset sets these for you.' },
  { id: 'fan', title: 'Cooling fan', pic: 'fan', match: ['cooling fan', 'part cooling', 'part fan', 'fan', 'fans', 'cooling'],
    short: 'A fan next to the nozzle blows on each fresh layer so the plastic hardens quickly and keeps its shape.', more: 'PLA likes lots of cooling; ABS and ASA need little or none.' },
  { id: 'brim', title: 'Brim', pic: 'brim', match: ['brim', 'brims'],
    short: 'A few extra flat rings printed around the bottom edge of the model, like the brim of a hat. They give it more grip on the bed so it doesn’t come loose or curl up.',
    more: 'Peel or trim it off when the print is done. Useful for tall, thin or small-footed models.' },
  { id: 'raft', title: 'Raft', pic: 'raft', match: ['raft', 'rafts'],
    short: 'A thick throw-away platform printed first, with the model built on top of it. It helps very difficult models stick.', more: 'It uses more plastic and leaves a rougher bottom, so a brim is usually tried first.' },
  { id: 'skirt', title: 'Skirt', pic: 'skirt', match: ['skirt', 'skirts'],
    short: 'A loop printed around the model, not touching it, before the real print starts. It gets the plastic flowing smoothly.', more: 'It’s just waste; pull it off the bed afterwards.' },
  { id: 'overhang', title: 'Overhang', pic: 'overhang', match: ['overhang', 'overhangs', 'overhanging'],
    short: 'A part of the model that sticks out over empty space, like an arm held out or the underside of a chin. The printer can’t print onto thin air.',
    more: 'Gentle slopes (up to about 45°) print fine. Steeper overhangs need supports, or the model turned a different way.' },
  { id: 'supports', title: 'Supports', pic: 'supports', match: ['supports', 'support', 'tree supports', 'tree support', 'support material'],
    short: 'Temporary props the slicer adds under overhangs so they have something to be printed on. You snap or cut them off afterwards.',
    more: '“Tree” supports branch out like a tree: they use less plastic and come off more easily. Turning the model to need fewer supports gives a cleaner result.' },
  { id: 'bridge', title: 'Bridge', pic: 'bridge', match: ['bridge', 'bridges', 'bridging'],
    short: 'A flat stretch of plastic printed straight across a gap between two points, with nothing underneath. Short bridges print fine without supports.', more: 'The fan helps the strand harden before it sags.' },
  { id: 'infill', title: 'Infill', pic: 'infill', match: ['infill', 'infill density', 'infill pattern'],
    short: 'Prints are mostly hollow inside: the slicer fills them with a light pattern called infill. 15% means about 15% of the inside is plastic.',
    more: 'More infill makes a part stronger and heavier but slower to print. 15% is fine for decorations; 30–40% for parts that take force.' },
  { id: 'walls', title: 'Walls', pic: 'walls', match: ['walls', 'wall', 'wall loops', 'perimeters', 'perimeter'],
    short: 'The solid outer outline of each layer. “3 walls” means three loops of plastic side by side around the edge.',
    more: 'Extra walls add more strength than extra infill. 2 is standard; 3–4 for strong parts.' },
  { id: 'purge', title: 'Purge (flush)', pic: 'purge', match: ['purge', 'purges', 'purging', 'purged', 'flush', 'flushing', 'flushed'],
    short: 'When the color changes, the old color still inside the nozzle has to be pushed out first, or it would streak into the new one. That waste plastic is the purge.',
    more: 'A printer with one nozzle per color (like the U1’s four toolheads) purges much less than one that swaps filament in a single nozzle.' },
  { id: 'primeTower', title: 'Prime tower (purge tower)', pic: 'primeTower', match: ['prime tower', 'prime towers', 'prime-tower', 'purge-tower', 'purge tower', 'purge towers', 'wipe tower', 'wipe towers'],
    short: 'A small block the printer builds next to a multi-color model. After each tool change the nozzle cleans out and settles here first, so the model itself stays clean.',
    more: 'It’s thrown away afterwards. It adds plastic and time, so fewer color changes means a smaller tower.' },
  { id: 'ooze', title: 'Ooze and stringing', pic: 'ooze', match: ['ooze', 'oozes', 'oozing', 'stringing', 'strings', 'stringy', 'oozed'],
    short: 'Melted plastic can drip from a hot nozzle while it isn’t printing (ooze). When the nozzle moves between parts, it leaves thin hair-like strings behind (stringing).',
    more: 'Damp filament makes it worse. Retraction, a lower temperature or drying the filament helps; leftover strings can be removed with a quick pass of a hair dryer.' },
  { id: 'retraction', title: 'Retraction', pic: 'retraction', match: ['retraction', 'retractions', 'retract', 'retracts'],
    short: 'Before the nozzle jumps to another spot, the printer pulls the filament back a tiny bit, so molten plastic doesn’t drip out on the way.', more: 'It’s the main setting against stringing.' },
  { id: 'extruder', title: 'Extruder, extrusion', pic: 'extruder', match: ['extruder', 'extruders', 'extrusion', 'extruding', 'extrude', 'extruded'],
    short: 'The extruder is the motor with small gears that grips the filament and pushes it into the hot nozzle. Extrusion is the plastic coming out.', more: '' },
  { id: 'flow', title: 'Flow', pic: 'flow', match: ['flow', 'flow rate', 'flow ratio', 'flow calibration', 'flow dynamics'],
    short: 'How much plastic the nozzle pushes out. Too little leaves gaps; too much leaves blobs and rough surfaces.', more: 'Flow calibration lets the printer measure and fine-tune it before printing.' },
  { id: 'underExtrusion', title: 'Under-extrusion', pic: 'underExtrusion', match: ['under-extrusion', 'underextrusion', 'under extrusion', 'under-extruded', 'over-extrusion'],
    short: 'Too little plastic coming out: thin lines, gaps and weak layers. Over-extrusion is the opposite: too much, giving blobs.',
    more: 'Common causes: a partly blocked nozzle, damp filament, printing too fast or too cold.' },
  { id: 'clog', title: 'Clog', pic: 'clog', match: ['clog', 'clogs', 'clogged', 'jam', 'jammed'],
    short: 'Something blocks the nozzle so plastic can’t get out: a bit of burnt plastic or dust, or filament that softened too early.', more: 'The printer’s manual explains how to clear or swap the nozzle.' },
  { id: 'warping', title: 'Warping', pic: 'warping', match: ['warping', 'warp', 'warped', 'warps', 'curling'],
    short: 'Plastic shrinks a little as it cools, which can pull the corners of a print up off the bed.', more: 'A clean bed, a brim, the right bed temperature and no drafts help.' },
  { id: 'elephantFoot', title: 'Elephant’s foot', pic: 'elephantFoot', match: ['elephant’s foot', 'elephant\'s foot', 'elephant foot'],
    short: 'The bottom few layers spread out a little wider than the rest, like an elephant’s foot.', more: 'Usually the bed is a bit too hot or the first layer is squished too much.' },
  { id: 'layerShift', title: 'Layer shift', pic: 'layerShift', match: ['layer shift', 'layer shifts', 'layer shifting', 'shifted layers'],
    short: 'Part of the print is suddenly offset sideways, as if the top slid over. The printer lost its position mid-print.', more: 'Often the nozzle hit a curled-up part, or the printer was bumped.' },
  { id: 'spaghetti', title: 'Spaghetti', pic: 'spaghetti', match: ['spaghetti'],
    short: 'A failed print where the model came loose and the printer kept going, leaving a tangle of loose plastic that looks like spaghetti.', more: 'It almost always starts with a first layer that didn’t stick.' },
  { id: 'orientation', title: 'Orientation', pic: 'orientation', match: ['orientation', 'orientations', 'orient', 'oriented'],
    short: 'How the model is turned before printing: which side faces down on the bed. The same model can need lots of supports one way and none another way.',
    more: 'The app scores every way and suggests the “lowest risk” one.' },
  { id: 'seam', title: 'Seam', pic: 'seam', match: ['seam', 'seams', 'z seam', 'z-seam'],
    short: 'Each layer’s outline starts and ends at one spot, leaving a tiny bump. Stacked up, these bumps form a faint vertical line called the seam.', more: 'The slicer can hide it in a corner or at the back.' },
  { id: 'ironing', title: 'Ironing', pic: 'ironing', match: ['ironing', 'ironed'],
    short: 'After the top layer, the hot nozzle passes over it once more, pushing out almost no plastic, to smooth it like an iron.', more: 'Nicer flat tops, but slower.' },
  { id: 'timelapse', title: 'Timelapse', pic: 'timelapse', match: ['timelapse', 'timelapses', 'time-lapse'],
    short: 'The printer’s camera takes one photo per layer and makes a short video of the model growing.', more: 'Fun to watch; it adds a little time.' },
  { id: 'preset', title: 'Preset (profile)', pic: 'preset', match: ['preset', 'presets', 'profile', 'profiles', 'process profile', 'filament profile', 'printer profile'],
    short: 'A saved group of settings you pick by name instead of setting each one. A slicer has three kinds: the printer, the filament, and the process (quality and speed).',
    more: 'The app starts from your slicer’s presets and only changes what helps this particular model.' },
  { id: 'makerworld', title: 'MakerWorld', pic: 'website', match: ['MakerWorld', 'Printables', 'Thingiverse'],
    short: 'Websites with millions of free 3D models to download and print. MakerWorld is run by Bambu Lab; Printables and Thingiverse are others.',
    more: 'MakerWorld files are set up for Bambu Lab printers. This app converts them for other printers such as the Snapmaker U1.' },
];

// ---------- matching ----------
const ALIASES = [];
for (const t of TERMS) for (const a of t.match) ALIASES.push({ a, id: t.id, cs: !!t.cs && /[A-Z]/.test(a) });
ALIASES.sort((x, y) => y.a.length - x.a.length);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RE = new RegExp(`(?<![\\w-])(?:${ALIASES.map(x => escRe(x.a)).join('|')})(?![\\w-])`, 'gi');
const BY_ID = new Map(TERMS.map(t => [t.id, t]));
function termFor(s) {
  for (const x of ALIASES) if (x.cs ? x.a === s : x.a.toLowerCase() === s.toLowerCase()) return x.id;
  return null;
}
// where not to underline: anything you type in or click, code, file names, and the help itself
const SKIP = 'script,style,textarea,input,select,option,button,a,code,pre,kbd,svg,canvas,[contenteditable],[data-no-gloss],.term,.file-title,.print-name,.gloss-pop,.gloss-dialog,#tipPop,#welcomeDialog,.toast,title,.demo-banner,#busyBar';
// a word is underlined once per paragraph / row / heading, not every time it appears
const BLOCK = 'p,li,tr,dd,dt,h1,h2,h3,h4,h5,label,summary,legend,figcaption,blockquote,.guide-text,#guideText';

const CSS = `
.term { text-decoration: underline dotted 1.5px; text-decoration-color: color-mix(in srgb, currentColor 55%, #1F9AAE); text-underline-offset: 3px; cursor: help; }
.term:hover { background: rgb(31 154 174 / .14); border-radius: 2px; }
.gloss-pop { margin: 0; inset: auto; position: fixed; width: 340px; max-width: calc(100vw - 24px); padding: 0; border: 1px solid #CBD2D8; border-radius: 10px;
  background: #FFFFFF; color: #18232E; box-shadow: 0 10px 30px rgb(0 0 0 / .28); font: 13px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; overflow: hidden; }
.gloss-pop .gp-pic, .gloss-dialog .gd-pic { background: #F3F5F7; border-bottom: 1px solid #E1E6EA; }
.gloss-pop .gp-pic svg { display: block; width: 100%; height: auto; max-height: 180px; }
.gloss-pop .gp-body { padding: 10px 14px 12px; }
.gloss-pop h4 { margin: 0 0 4px; font-size: 15px; }
.gloss-pop p { margin: 0 0 6px; }
.gloss-pop .gp-more { color: #4E5B67; }
.gloss-pop .gp-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; color: #5F6C78; }
.gloss-pop .gp-foot button, .gloss-dialog .gd-close { border: 1px solid #CBD2D8; background: #F7F8F9; color: #18232E; border-radius: 4px; padding: 3px 10px; cursor: pointer; font: inherit; }
.gloss-dialog { width: min(980px, 96vw); height: min(820px, 92vh); padding: 0; border: 1px solid #CBD2D8; border-radius: 10px; background: var(--panel, #F7F8F9); color: var(--ink, #18232E); }
.gloss-dialog[open] { display: flex; flex-direction: column; }
.gloss-dialog .gd-head { display: flex; gap: 12px; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--line, #CBD2D8); }
.gloss-dialog .gd-head h2 { margin: 0; font-size: 18px; flex: 1; }
.gloss-dialog .gd-head input { width: 260px; padding: 6px 10px; border: 1px solid var(--line, #CBD2D8); border-radius: 4px; background: var(--raised, #fff); color: inherit; font: inherit; }
.gloss-dialog .gd-intro { margin: 0; padding: 10px 18px 0; color: var(--muted, #586774); }
.gloss-dialog .gd-grid { overflow-y: auto; padding: 14px 18px 18px; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; align-content: start; grid-auto-rows: max-content; flex: 1 1 auto; min-height: 0; }
.gloss-dialog .gd-card { border: 1px solid #CBD2D8; border-radius: 8px; overflow: hidden; background: #FFFFFF; color: #18232E; font-size: 13px; line-height: 1.5; }
.gloss-dialog .gd-card.flash { outline: 3px solid #1F9AAE; }
.gloss-dialog .gd-pic svg { display: block; width: 100%; height: auto; }
.gloss-dialog .gd-card h3 { margin: 8px 12px 2px; font-size: 14.5px; }
.gloss-dialog .gd-card p { margin: 0 12px 8px; }
.gloss-dialog .gd-card .gp-more { color: #4E5B67; }
.gloss-dialog .gd-none { color: var(--muted, #586774); }
`;

// ---------- the module ----------
export function createGlossary({ isOn }) {
  const docs = new Map();   // document -> { observer, frame }
  let pop, dialog, showT, hideT, pinned = false, current = null;

  function ensureStyle(doc) {
    if (doc.getElementById('glossStyle')) return;
    const s = doc.createElement('style'); s.id = 'glossStyle'; s.textContent = CSS; doc.head.appendChild(s);
  }

  // underline the words inside root
  function wrap(doc, root) {
    if (!root || !root.isConnected) return;
    const start = root.nodeType === 3 ? root.parentElement : root;
    if (!start || start.closest(SKIP)) return;
    const walker = doc.createTreeWalker(start, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (!n.nodeValue.trim() || !n.parentElement || n.parentElement.closest(SKIP)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const nodes = []; for (let n; (n = walker.nextNode());) nodes.push(n);
    for (const node of nodes) {
      const text = node.nodeValue; RE.lastIndex = 0;
      let m, last = 0, frag = null;
      const block = node.parentElement.closest(BLOCK) || node.parentElement, here = new Set();
      while ((m = RE.exec(text))) {
        const id = termFor(m[0]); if (!id) continue;
        if (here.has(id) || block.querySelector(`.term[data-term="${id}"]`)) continue;
        here.add(id);
        frag = frag || doc.createDocumentFragment();
        frag.append(text.slice(last, m.index));
        const s = doc.createElement('span'); s.className = 'term'; s.dataset.term = id; s.textContent = m[0];
        frag.append(s); last = m.index + m[0].length;
      }
      if (frag) { frag.append(text.slice(last)); node.replaceWith(frag); }
    }
  }
  function unwrapAll(doc) {
    doc.querySelectorAll('.term').forEach(s => { const p = s.parentNode; s.replaceWith(doc.createTextNode(s.textContent)); p && p.normalize(); });
  }

  function attach(doc, frame = null) {
    if (!doc || docs.has(doc)) return;
    ensureStyle(doc);
    let queue = new Set(), raf = 0;
    const flush = () => {
      raf = 0; if (!isOn()) { queue.clear(); return; }
      obs.disconnect();
      for (const r of queue) wrap(doc, r);
      queue.clear(); obs.takeRecords();
      obs.observe(doc.body, { childList: true, subtree: true, characterData: true });
    };
    const obs = new (doc.defaultView.MutationObserver)((muts) => {
      if (!isOn()) return;
      for (const m of muts) {
        if (m.type === 'characterData') queue.add(m.target);
        else m.addedNodes.forEach(n => { if (n.nodeType === 1 || n.nodeType === 3) queue.add(n); });
      }
      if (!raf) raf = doc.defaultView.requestAnimationFrame(flush);
    });
    obs.observe(doc.body, { childList: true, subtree: true, characterData: true });
    docs.set(doc, { obs, frame });
    doc.addEventListener('pointerover', (e) => { const t = e.target.closest && e.target.closest('.term'); if (t) hoverIn(t, frame); });
    doc.addEventListener('pointerout', (e) => { const t = e.target.closest && e.target.closest('.term'); if (t && !t.contains(e.relatedTarget)) hoverOut(); });
    doc.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('.term');
      if (t) { e.preventDefault(); e.stopPropagation(); clearTimeout(showT); show(t, frame); pinned = true; return; }
      if (pinned && !(pop && pop.contains(e.target))) hide();
    }, true);
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop && pop.matches(':popover-open')) { hide(); e.stopPropagation(); } }, true);
    if (isOn()) wrap(doc, doc.body);
  }

  // ---------- the popup ----------
  function buildPop() {
    pop = document.createElement('div'); pop.className = 'gloss-pop'; pop.setAttribute('popover', 'manual'); pop.setAttribute('role', 'tooltip');
    document.body.appendChild(pop);
    pop.addEventListener('pointerenter', () => clearTimeout(hideT));
    pop.addEventListener('pointerleave', () => { if (!pinned) hideT = setTimeout(hide, 250); });
    pop.addEventListener('click', (e) => { const b = e.target.closest('[data-gloss-all]'); if (b) { const id = current; hide(); open(id); } });
  }
  function hoverIn(t, frame) { clearTimeout(hideT); if (pinned && current === t.dataset.term) return; clearTimeout(showT); showT = setTimeout(() => { pinned = false; show(t, frame); }, 220); }
  function hoverOut() { clearTimeout(showT); if (!pinned) hideT = setTimeout(hide, 300); }
  function show(t, frame) {
    const term = BY_ID.get(t.dataset.term); if (!term) return;
    if (!pop) buildPop();
    current = term.id;
    pop.innerHTML = `<div class="gp-pic">${PIC[term.pic] || ''}</div><div class="gp-body"><h4>${term.title}</h4><p>${term.short}</p>${term.more ? `<p class="gp-more">${term.more}</p>` : ''}
      <div class="gp-foot"><span>Click a word to keep this open</span><button type="button" data-gloss-all>All words</button></div></div>`;
    if (pop.matches(':popover-open')) pop.hidePopover();
    // an open window (Settings, Color remix…) blocks everything outside it, so the popup goes inside that window
    const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
    if (pop.parentElement !== host) host.appendChild(pop);
    pop.showPopover();   // top layer: shows above any open window (Color remix, Settings…)
    const r = t.getBoundingClientRect(), off = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
    const box = { left: r.left + off.left, top: r.top + off.top, bottom: r.bottom + off.top };
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, box.left));
    const top = box.bottom + 8 + h <= window.innerHeight - 8 ? box.bottom + 8 : Math.max(8, box.top - h - 8);
    pop.style.left = `${left}px`; pop.style.top = `${top}px`;
  }
  function hide() { clearTimeout(showT); clearTimeout(hideT); pinned = false; current = null; if (pop && pop.matches(':popover-open')) pop.hidePopover(); }

  // ---------- the Glossary window: every word with its picture, searchable ----------
  function open(focusId) {
    hide();
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.className = 'gloss-dialog'; dialog.id = 'glossaryDialog';
      dialog.innerHTML = `<div class="gd-head"><h2>3D printing words, explained</h2><input type="search" placeholder="Find a word…" aria-label="Find a word"><button type="button" class="gd-close">Close</button></div>
        <p class="gd-intro">Words with a dotted underline in the app are in this list: hover over one to see its explanation.</p><div class="gd-grid"></div>`;
      document.body.appendChild(dialog);
      const grid = dialog.querySelector('.gd-grid'), q = dialog.querySelector('input');
      const sorted = [...TERMS].sort((a, b) => a.title.localeCompare(b.title));
      grid.innerHTML = sorted.map(t => `<article class="gd-card" data-id="${t.id}" data-find="${(t.title + ' ' + t.match.join(' ') + ' ' + t.short).toLowerCase().replace(/"/g, '')}">
        <div class="gd-pic">${PIC[t.pic] || ''}</div><h3>${t.title}</h3><p>${t.short}</p>${t.more ? `<p class="gp-more">${t.more}</p>` : ''}</article>`).join('') + '<p class="gd-none" hidden>No word matches that. Try a shorter search.</p>';
      q.addEventListener('input', () => {
        const s = q.value.trim().toLowerCase(); let n = 0;
        grid.querySelectorAll('.gd-card').forEach(c => { const hit = !s || c.dataset.find.includes(s); c.hidden = !hit; n += hit; });
        grid.querySelector('.gd-none').hidden = n > 0;
      });
      dialog.querySelector('.gd-close').onclick = () => dialog.close();
    }
    const q = dialog.querySelector('input'); q.value = ''; q.dispatchEvent(new Event('input'));
    dialog.showModal();
    if (focusId) {
      const c = dialog.querySelector(`.gd-card[data-id="${focusId}"]`);
      if (c) { c.scrollIntoView({ block: 'center' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1600); }
    } else q.focus();
  }

  // turn on or off (after a change of experience level or the Settings switch)
  function refresh() {
    for (const doc of docs.keys()) { if (isOn()) wrap(doc, doc.body); else unwrapAll(doc); }
    if (!isOn()) hide();
  }

  attach(document);
  return { attach, refresh, open, terms: TERMS };
}
