// The ten 3D-built settings for "See it in place": real size (millimetres), Z up, the camera looking along +Y at a
// placement spot on a surface (a table, a shelf, a mantel…). Each build(time) returns
//   { group, spot: Vector3 (where the model stands), frame: { width (mm of setting in view at true size), dir },
//     background, animate(t)? (flames, twinkling lights) }
import * as THREE from '../vendor/three.module.js';
import { mat, box, cyl, cone, ball, torus, lathe, wall, floor, glowLight, gradient, pattern, texMat, daylight } from './kit.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const isNight = (t) => t === 'night', isEve = (t) => t === 'evening';
const sky = (t) => t === 'day' ? gradient('#7fb5ea', '#dcecf7') : t === 'evening' ? gradient('#3c3b6e', '#f2a65a') : gradient('#05081a', '#1b2448');
const roomBg = (t, day = '#e9e2d6') => new THREE.Color(isNight(t) ? '#07080c' : isEve(t) ? '#4a3a30' : day);
// lamps and flames: brighter at night, a little in the evening, faint by day
const lampPower = (t, base) => base * (isNight(t) ? 1 : isEve(t) ? 0.7 : 0.25);

// patterns
const bricks = (c, n) => { c.fillStyle = '#6e3b2c'; c.fillRect(0, 0, n, n); const h = n / 8, w = n / 4; c.fillStyle = '#8c4a35';
  for (let r = 0; r < 8; r++) for (let k = -1; k < 5; k++) { const off = r % 2 ? w / 2 : 0; c.fillStyle = ['#8c4a35', '#7d3f2e', '#985440', '#83432f'][(r * 7 + k * 3) & 3]; c.fillRect(k * w + off + 3, r * h + 3, w - 6, h - 6); } };
const boards = (light, dark) => (c, n) => { for (let i = 0; i < 8; i++) { c.fillStyle = i % 2 ? light : dark; c.fillRect(0, i * n / 8, n, n / 8 - 2); c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect(0, (i + 1) * n / 8 - 2, n, 2); } };
const tiles = (c, n) => { c.fillStyle = '#c9c4bb'; c.fillRect(0, 0, n, n); c.fillStyle = '#f4f1ec'; for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) c.fillRect(i * n / 4 + (j % 2 ? n / 8 : 0) + 2, j * n / 8 + 2, n / 4 - 4, n / 8 - 4); };
const wood = (base) => (c, n) => { c.fillStyle = base; c.fillRect(0, 0, n, n); for (let i = 0; i < 40; i++) { c.strokeStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.08})`; c.beginPath(); const y = Math.random() * n; c.moveTo(0, y); c.bezierCurveTo(n / 3, y + 6, 2 * n / 3, y - 6, n, y); c.stroke(); } };
const wallpaper = (bg, dot) => (c, n) => { c.fillStyle = bg; c.fillRect(0, 0, n, n); c.fillStyle = dot; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { c.beginPath(); c.arc(i * n / 4 + (j % 2 ? n / 8 : 0) + n / 8, j * n / 4 + n / 8, n / 40, 0, 7); c.fill(); } };

function flicker(lights, base, t, speed = 9) {
  lights.forEach((l, i) => { if (l && l.userData.light) l.userData.light.intensity = base * (0.82 + 0.12 * Math.sin(t * speed + i * 2.1) + 0.08 * Math.sin(t * 23 + i)); });
}

export const BUILT = [
  { id: 'garden', name: 'Garden table', kind: 'outdoor', build(t) {
    const g = new THREE.Group();
    daylight(g, t, 'outdoor', V(0, 0, 750));
    floor(g, 12000, 12000, mat(isNight(t) ? 0x203018 : 0x5d8f3a, { r: 1 }), 0, 2000, 0);
    // a round garden table
    cyl(g, 330, 330, 30, mat(0xe8e4dc, { r: 0.5 }), 0, 0, 720); cyl(g, 30, 30, 720, mat(0x2f2f2f, { r: 0.4, m: 0.6 }), 0, 0, 0); cyl(g, 200, 220, 20, mat(0x2f2f2f, { r: 0.4, m: 0.6 }), 0, 0, 0);
    // hedge, flower bed, picket fence, trees
    box(g, 5000, 600, 1300, mat(0x2e5a24, { r: 1 }), 0, 1700, 0);
    const petals = [0xe94c6f, 0xf6d04d, 0xb57edc, 0xffffff, 0xf08a3c];
    for (let i = 0; i < 26; i++) { const x = -2200 + i * 175 + (i % 3) * 30, y = 1250 + (i % 4) * 60; cyl(g, 6, 6, 380 + (i % 5) * 60, mat(0x3b6e2a), x, y, 0); ball(g, 55 + (i % 3) * 15, mat(petals[i % 5], { r: 0.7 }), x, y, 430 + (i % 5) * 60, 1, 1, 0.7); }
    for (let i = 0; i < 24; i++) box(g, 70, 25, 1550, mat(0xf2f2ee, { r: 0.7 }), -2400 + i * 210, 2050, 0);
    box(g, 5000, 25, 70, mat(0xf2f2ee), 0, 2050, 1450); box(g, 5000, 25, 70, mat(0xf2f2ee), 0, 2050, 1150);
    for (const [x, y] of [[-2600, 3800], [2300, 4200], [600, 5200]]) { cyl(g, 110, 140, 1800, mat(0x5a3d26), x, y, 0); ball(g, 1100, mat(0x3f7a2c, { r: 1 }), x, y, 2700, 1, 1, 1.1); }
    // garden lanterns light up at night
    const lanterns = [glowLight(g, 0xffcf80, lampPower(t, 900), 3500, -900, 900, 300, 30), glowLight(g, 0xffcf80, lampPower(t, 900), 3500, 1100, 800, 300, 30)];
    if (isNight(t)) glowLight(g, 0xfffbe8, 0, 0, -3000, 9000, 6000, 260);   // the moon
    return { group: g, spot: V(0, 0, 750), frame: { width: 1300, dir: V(0, -1, 0.42) }, background: sky(t), animate: (s) => flicker(lanterns, lampPower(t, 900), s, 3) };
  } },

  { id: 'shelf', name: 'Bedroom wall shelf', kind: 'indoor', build(t) {
    const g = new THREE.Group();
    daylight(g, t, 'indoor', V(0, 0, 1230), [-0.6, -0.55, 0.6]);
    wall(g, 6000, 3000, texMat(pattern(wallpaper('#cfdbe6', '#b4c6d6'), 256, 12, 6), { r: 0.95 }), 0, 140, 0);
    floor(g, 6000, 4000, texMat(pattern(boards('#a77b52', '#9a7049'), 256, 10, 6), { r: 0.7 }), 0, -1800, 0);
    box(g, 900, 220, 30, texMat(pattern(wood('#f2ede4'), 256), { r: 0.6 }), 0, 30, 1200);
    const covers = [0x2f5d8a, 0xb5473a, 0x3f7a55, 0xd8b04a, 0x6b4c8a];
    covers.forEach((c, i) => box(g, 32, 160, 200 + (i % 3) * 20, mat(c, { r: 0.7 }), -400 + i * 36, 50, 1230));
    lathe(g, [[0, 0], [55, 0], [65, 110], [0, 110]], mat(0xd9c2a5, { r: 0.8 }), 330, 40, 1230);
    for (let i = 0; i < 7; i++) ball(g, 45, mat(0x3f8a3a, { r: 0.9 }), 330 + Math.cos(i) * 40, 40 + Math.sin(i) * 25, 1360 + (i % 3) * 30, 1, 1, 1.6);
    box(g, 420, 20, 320, mat(0x3a2f28, { r: 0.5 }), -150, 128, 1550); box(g, 380, 22, 280, mat(0xe8d9c0, { r: 0.9 }), -150, 126, 1570);
    // bed corner below, a bedside lamp that's on in the evening / night
    box(g, 1700, 2100, 450, mat(0xe9e6f2, { r: 1 }), -1300, -900, 0); box(g, 700, 300, 160, mat(0xffffff, { r: 1 }), -1500, 0, 450);
    box(g, 450, 400, 560, texMat(pattern(wood('#b98e62'), 256)), 650, -50, 0);
    const lamp = glowLight(g, 0xffd9a0, lampPower(t, 1400), 4000, 650, -60, 860, 45);
    cone(g, 120, 160, mat(0xf3ead8, { e: isNight(t) || isEve(t) ? 0xffd9a0 : 0, ei: 0.5, ds: true }), 650, -60, 780);
    cyl(g, 10, 10, 220, mat(0x8a7a60, { m: 0.5 }), 650, -60, 560);
    return { group: g, spot: V(80, 25, 1230), frame: { width: 1000, dir: V(0.15, -1, 0.18) }, background: roomBg(t), animate: () => {} };
  } },

  { id: 'mantel', name: 'Fireplace mantel', kind: 'indoor', build(t) {
    const g = new THREE.Group();
    daylight(g, t, 'indoor', V(0, 0, 1160), [0.5, -0.6, 0.6]);
    wall(g, 7000, 3200, mat(0xd8cbb8, { r: 0.95 }), 0, 300, 0);
    floor(g, 7000, 4000, texMat(pattern(boards('#7a5236', '#6c472d'), 256, 12, 8), { r: 0.6 }), 0, -1700, 0);
    box(g, 1600, 460, 1100, texMat(pattern(bricks, 256, 5, 4), { r: 0.95 }), 0, 70, 0);
    box(g, 820, 200, 720, mat(0x15110e, { r: 1 }), 0, -70, 0);           // the opening
    box(g, 1800, 300, 70, texMat(pattern(wood('#5b3a22'), 256, 2, 1), { r: 0.5 }), 0, -10, 1100);   // mantel shelf
    // the fire: logs and flames with real light
    for (const [x, rz] of [[-120, 0.3], [110, -0.25]]) { const l = cyl(g, 45, 45, 380, mat(0x4a2e1a), x, -80, 60); l.rotation.set(0, Math.PI / 2, rz); }
    const flames = [];
    for (let i = 0; i < 5; i++) { const f = cone(g, 50 - i * 4, 220 - i * 25, mat(0xff8a2a, { e: 0xff6a10, ei: 2.2, r: 1 }), -160 + i * 80, -90, 90); flames.push(f); }
    const fireLight = glowLight(g, 0xff8a3a, 2600, 4500, 0, -250, 280, 1);
    // candles, a frame above
    const candles = [];
    for (const x of [-700, -620, 690]) { cyl(g, 28, 28, 160 + (x % 3) * 20, mat(0xf3ead6, { r: 0.6 }), x, -20, 1170); candles.push(glowLight(g, 0xffc070, lampPower(t, 380), 1800, x, -20, 1360 + (x % 3) * 20, 9)); }
    box(g, 700, 30, 480, mat(0x7a5a2a, { r: 0.4, m: 0.4 }), 0, 270, 1450); box(g, 620, 30, 400, mat(0x4f6f8f, { r: 0.9 }), 0, 255, 1490);
    return { group: g, spot: V(150, -10, 1170), frame: { width: 2100, dir: V(-0.12, -1, 0.02) }, background: roomBg(t, '#d8cbb8'),
      animate: (s) => { flicker([fireLight], 2600, s, 11); flicker(candles, lampPower(t, 380), s, 7); flames.forEach((f, i) => { f.scale.y = 0.85 + 0.2 * Math.sin(s * (7 + i) + i); }); } };
  } },

  { id: 'porch', name: 'Front porch by the door', kind: 'outdoor', build(t) {
    const g = new THREE.Group();
    daylight(g, t, 'outdoor', V(0, 0, 600), [-0.5, -0.7, 0.55]);
    wall(g, 7000, 3200, texMat(pattern(boards('#7c95a8', '#7189a0'), 256, 3, 16), { r: 0.8 }), 0, 400, 0);
    floor(g, 7000, 4000, texMat(pattern(boards('#9c7a5b', '#8f6f52'), 256, 1, 14), { r: 0.7 }), 0, -1600, 0);
    // the front door with its frame, panels, knob and a mat
    box(g, 1100, 60, 2250, mat(0xf4f2ec, { r: 0.6 }), -700, 380, 0); box(g, 920, 70, 2120, mat(0x7a1f25, { r: 0.4 }), -700, 360, 0);
    for (const [x, z] of [[-890, 300], [-510, 300], [-890, 1250], [-510, 1250]]) box(g, 300, 20, 700, mat(0x6b1a20, { r: 0.4 }), x, 320, z);
    ball(g, 30, mat(0xcaa64a, { r: 0.2, m: 1 }), -330, 300, 1050);
    box(g, 900, 600, 15, mat(0x5a4a3a, { r: 1 }), -700, -100, 0);
    // a porch light that's on in the evening and at night
    box(g, 150, 150, 300, mat(0x1d1d1d, { m: 0.7, r: 0.4 }), 40, 330, 1600);
    const lamp = glowLight(g, 0xffd89a, lampPower(t, 1600), 4500, 40, 260, 1750, 50);
    // a side table and a potted plant
    cyl(g, 230, 230, 30, texMat(pattern(wood('#3a2a1e'), 256)), 450, 100, 570); cyl(g, 25, 25, 570, mat(0x1f1f1f, { m: 0.6, r: 0.4 }), 450, 100, 0);
    lathe(g, [[0, 0], [170, 0], [220, 520], [0, 520]], mat(0x4b4b4b, { r: 0.6 }), 1100, 150, 0);
    for (let i = 0; i < 9; i++) ball(g, 140, mat(0x2f6e2c, { r: 0.9 }), 1100 + Math.cos(i * 0.8) * 120, 150 + Math.sin(i * 0.8) * 100, 680 + (i % 3) * 90);
    return { group: g, spot: V(440, 90, 600), frame: { width: 1500, dir: V(-0.25, -1, 0.3) }, background: sky(t), animate: () => {} };
  } },

  { id: 'thanksgiving', name: 'Thanksgiving table', kind: 'indoor', build(t) {
    const g = new THREE.Group();
    daylight(g, t, 'indoor', V(0, 0, 765), [0.4, -0.5, 0.7]);
    wall(g, 7000, 3200, mat(0xe2cfa8, { r: 0.95 }), 0, 900, 0);
    floor(g, 7000, 5000, texMat(pattern(boards('#6e4a2e', '#62412a'), 256, 12, 10), { r: 0.6 }), 0, -1500, 0);
    box(g, 2200, 1100, 40, texMat(pattern(wood('#6b4426'), 256, 3, 2), { r: 0.5 }), 0, 0, 720);
    for (const [x, y] of [[-1000, -450], [1000, -450], [-1000, 450], [1000, 450]]) box(g, 60, 60, 720, mat(0x5a381f), x, y, 0);
    box(g, 2200, 360, 6, mat(0xa8502a, { r: 0.9 }), 0, 0, 760);   // table runner
    // plates, pumpkins, candles, scattered leaves
    for (const x of [-750, 750]) { cyl(g, 140, 120, 15, mat(0xf6f3ec, { r: 0.3 }), x, -330, 760); cyl(g, 90, 80, 10, mat(0xd6c6a8, { r: 0.4 }), x, -330, 775); }
    const pumpkin = (x, y, r, c) => { ball(g, r, mat(c, { r: 0.6 }), x, y, 766 + r * 0.7, 1, 1, 0.72); cyl(g, r * 0.08, r * 0.1, r * 0.35, mat(0x5a4a22), x, y, 766 + r * 1.35); };
    pumpkin(-330, 150, 120, 0xe27a2a); pumpkin(-160, 230, 80, 0xf0a030); pumpkin(380, 180, 95, 0xe8e0c8); pumpkin(560, 120, 60, 0xd56a1e);
    const candles = [];
    for (const x of [-560, 230]) { cyl(g, 30, 30, 260, mat(0xf4e8cf, { r: 0.6 }), x, 60, 766); candles.push(glowLight(g, 0xffc070, lampPower(t, 450), 2200, x, 60, 1045, 10)); }
    const leaf = [0xc8462a, 0xe08a2a, 0xb8902a, 0x8a3a1e];
    for (let i = 0; i < 18; i++) { const l = cyl(g, 30, 30, 2, mat(leaf[i % 4], { r: 0.9 }), -950 + i * 110, (i % 3 - 1) * 120, 766); l.scale.set(1, 0.55, 1); l.rotation.z = i; }
    box(g, 1400, 40, 1100, mat(isNight(t) ? 0x0a0f22 : isEve(t) ? 0x7a5a6a : 0xbfd8ee, { e: isNight(t) ? 0x0a1030 : 0, r: 0.2 }), 0, 880, 1100);   // window
    return { group: g, spot: V(80, -120, 766), frame: { width: 1300, dir: V(0, -1, 0.42) }, background: roomBg(t, '#e2cfa8'), animate: (s) => flicker(candles, lampPower(t, 450), s) };
  } },

  { id: 'christmas', name: 'Christmas', kind: 'indoor', build(t) {
    const g = new THREE.Group();
    daylight(g, t, 'indoor', V(0, 0, 800), [0.5, -0.5, 0.6]);
    wall(g, 7000, 3200, texMat(pattern(wallpaper('#7a2a2a', '#8e3636'), 256, 12, 6), { r: 0.95 }), 0, 600, 0);
    floor(g, 7000, 5000, texMat(pattern(boards('#7a5236', '#6c472d'), 256, 12, 10), { r: 0.6 }), 0, -1500, 0);
    // a sideboard with a runner and garland: the model stands on it
    box(g, 1200, 450, 800, texMat(pattern(wood('#4a2e1c'), 256, 2, 1), { r: 0.5 }), 450, 300, 0);
    box(g, 1200, 200, 5, mat(0xe8e2d2, { r: 0.9 }), 450, 300, 800);
    for (let i = 0; i < 24; i++) ball(g, 30, mat(0x235c2e, { r: 0.9 }), -110 + i * 49, 470, 790 - Math.sin(i / 23 * Math.PI) * 120);
    // the tree with twinkling lights, a star and presents
    const T = [-750, 650];
    cyl(g, 60, 70, 300, mat(0x4a2e1c), T[0], T[1], 0);
    [[750, 900], [600, 800], [450, 700], [300, 600]].forEach(([r, h], i) => cone(g, r, h, mat(0x1f5a2c, { r: 0.9 }), T[0], T[1], 280 + i * 420));
    const bulbs = [], cols = [0xff4040, 0x40c0ff, 0xffd040, 0x60ff70, 0xff70e0];
    for (let i = 0; i < 46; i++) { const h = 350 + (i / 46) * 1700, r = 720 * (1 - (h - 280) / 2050) + 40, a = i * 2.4;
      bulbs.push(glowLight(g, cols[i % 5], i % 6 === 0 ? lampPower(t, 260) : 0, 1500, T[0] + Math.cos(a) * r, T[1] + Math.sin(a) * r - 40, h, 14)); }
    const star = glowLight(g, 0xffe070, lampPower(t, 500), 2000, T[0], T[1] - 20, 2380, 45);
    const wrap = [0xc0282d, 0x2a6ab8, 0xe0b23a, 0x2e8a4a];
    [[-1100, 250, 300, 260], [-750, 150, 380, 200], [-420, 260, 260, 300]].forEach(([x, y, s, h], i) => { box(g, s, s, h, mat(wrap[i], { r: 0.5 }), x, y, 0); box(g, s + 4, 40, h + 4, mat(0xf2e6c8, { r: 0.3 }), x, y, 0); });
    box(g, 900, 40, 1100, mat(isNight(t) ? 0x0c1630 : 0xcfe2f2, { e: isNight(t) ? 0x101c40 : 0x3a4a5a, ei: 0.6, r: 0.2 }), 900, 580, 1000);   // snowy window
    return { group: g, spot: V(480, 230, 805), frame: { width: 2400, dir: V(0.55, -1, 0.22) }, background: roomBg(t, '#7a2a2a'),
      animate: (s) => { bulbs.forEach((b, i) => { b.material.color.setHex(cols[i % 5]); b.material.color.multiplyScalar(0.55 + 0.45 * (0.5 + 0.5 * Math.sin(s * 2.2 + i * 1.7))); }); star.scale.setScalar(1 + 0.08 * Math.sin(s * 3)); } };
  } },

  { id: 'desk', name: 'Desk / home office', kind: 'indoor', build(t) {
    const g = new THREE.Group();
    daylight(g, t, 'indoor', V(0, 0, 740), [-0.5, -0.6, 0.6]);
    wall(g, 6000, 3000, mat(0xdfe3e6, { r: 0.95 }), 0, 500, 0);
    floor(g, 6000, 4000, mat(0x8a8f96, { r: 0.9 }), 0, -1500, 0);
    box(g, 1600, 750, 35, texMat(pattern(wood('#c49a6c'), 256, 2, 1), { r: 0.45 }), 0, 100, 705);
    for (const x of [-760, 760]) box(g, 40, 700, 705, mat(0x2b2b2b, { m: 0.5, r: 0.4 }), x, 100, 0);
    // monitor (its screen glows), keyboard, mug, notebook, lamp, pin board
    box(g, 700, 30, 400, mat(0x1b1b1b, { r: 0.3, m: 0.3 }), -250, 380, 900); box(g, 660, 6, 360, mat(0x1a2a40, { e: 0x5a8ad0, ei: isNight(t) ? 0.9 : 0.5 }), -250, 362, 920);
    box(g, 60, 60, 160, mat(0x1b1b1b), -250, 400, 740); box(g, 260, 200, 10, mat(0x1b1b1b), -250, 400, 740);
    const screen = glowLight(g, 0x8ab4ff, lampPower(t, 500), 2000, -250, 200, 1100, 1);
    box(g, 450, 150, 22, mat(0x2d2d2d, { r: 0.5 }), -250, 50, 740);
    lathe(g, [[0, 0], [42, 0], [45, 100], [0, 100]], mat(0xc0392b, { r: 0.4 }), 420, -50, 740); torus(g, 28, 7, mat(0xc0392b, { r: 0.4 }), 470, -50, 795, 0, Math.PI / 2, 0);
    box(g, 220, 300, 15, mat(0x2a4f7a, { r: 0.8 }), 560, 220, 740);
    cyl(g, 80, 80, 20, mat(0x1b1b1b, { m: 0.6, r: 0.4 }), 650, 380, 740); cyl(g, 10, 10, 420, mat(0x1b1b1b, { m: 0.6 }), 650, 380, 760);
    cone(g, 90, 120, mat(0x1b1b1b, { m: 0.6, r: 0.4, ds: true }), 600, 330, 1130);
    const lamp = glowLight(g, 0xfff0d0, lampPower(t, 1300), 3000, 600, 320, 1120, 25);
    box(g, 800, 20, 500, mat(0xb08a5a, { r: 0.9 }), 300, 488, 1250);
    for (let i = 0; i < 6; i++) box(g, 90, 6, 110, mat([0xf7e36a, 0x9ad0f5, 0xf5a8c8][i % 3]), 50 + i * 100, 476, 1300 + (i % 2) * 150);
    return { group: g, spot: V(170, -60, 740), frame: { width: 1200, dir: V(0.05, -1, 0.42) }, background: roomBg(t, '#dfe3e6'), animate: () => {} };
  } },

  { id: 'kitchen', name: 'Kitchen counter', kind: 'indoor', build(t) {
    const g = new THREE.Group();
    daylight(g, t, 'indoor', V(0, 0, 910), [0.4, -0.6, 0.7]);
    wall(g, 6000, 3000, texMat(pattern(tiles, 256, 14, 6), { r: 0.35 }), 0, 330, 0);
    floor(g, 6000, 4000, mat(0x6f6a64, { r: 0.8 }), 0, -1500, 0);
    box(g, 3000, 640, 860, mat(0x2f4f5f, { r: 0.6 }), 0, 0, 0);                       // cabinets
    for (let i = 0; i < 5; i++) { box(g, 560, 10, 700, mat(0x34596b, { r: 0.6 }), -1200 + i * 600, -326, 80); box(g, 180, 20, 20, mat(0xc8c8c8, { m: 1, r: 0.3 }), -1200 + i * 600, -340, 700); }
    box(g, 3060, 680, 45, mat(0xeeeae4, { r: 0.25 }), 0, 0, 860);                    // the counter top
    box(g, 3000, 350, 700, mat(0x2f4f5f, { r: 0.6 }), 0, 150, 1500);                 // upper cabinets
    // fruit bowl, kettle, cutting board, under-cabinet lights
    lathe(g, [[0, 0], [90, 0], [170, 90], [160, 95], [80, 10], [0, 10]], mat(0xf6f6f2, { r: 0.3 }), -700, 60, 905);
    [[0xd63a2a, -760, 30], [0xf2c230, -650, 90], [0x5aa83a, -690, 0], [0xe8892a, -620, 30]].forEach(([c, x, y]) => ball(g, 45, mat(c, { r: 0.5 }), x, 60 + y, 990));
    lathe(g, [[0, 0], [110, 0], [120, 120], [90, 200], [30, 230], [0, 235]], mat(0xb8bcc2, { r: 0.15, m: 1 }), 750, 150, 905);
    box(g, 420, 280, 25, texMat(pattern(wood('#c8965a'), 256)), 300, 150, 905);
    const ucl = [glowLight(g, 0xfff1d6, lampPower(t, 700), 2200, -700, 120, 1450, 1), glowLight(g, 0xfff1d6, lampPower(t, 700), 2200, 700, 120, 1450, 1)];
    return { group: g, spot: V(80, -110, 905), frame: { width: 1300, dir: V(0, -1, 0.35) }, background: roomBg(t, '#eae6df'), animate: () => {} };
  } },

  { id: 'halloween', name: 'Halloween', kind: 'outdoor', build(t) {
    const g = new THREE.Group();
    // Halloween is an evening/night scene: "day" is dusk
    const tt = t === 'day' ? 'evening' : t;
    daylight(g, tt, 'outdoor', V(0, 0, 700), [-0.3, -0.5, 0.5]);
    wall(g, 7000, 3200, texMat(pattern(boards('#3a2c40', '#33263a'), 256, 3, 16), { r: 0.9 }), 0, 600, 0);
    floor(g, 7000, 4000, texMat(pattern(boards('#4a3a2a', '#3f3124'), 256, 1, 14), { r: 0.8 }), 0, -1600, 0);
    // an old crate the model stands on, jack-o'-lanterns, candles, a moon and cobwebs
    box(g, 700, 500, 650, texMat(pattern(boards('#7a6040', '#6a5236'), 256, 1, 3), { r: 0.9 }), 0, 50, 0);
    const lanterns = [];
    const jack = (x, y, z, r) => {
      ball(g, r, mat(0xe0661a, { r: 0.6 }), x, y, z + r * 0.75, 1, 1, 0.8);
      cyl(g, r * 0.08, r * 0.1, r * 0.3, mat(0x3f4a1e), x, y, z + r * 1.35);
      for (const [dx, dz, s] of [[-0.35, 0.95, 0.18], [0.35, 0.95, 0.18], [0, 0.5, 0.32]]) { const f = box(g, r * s * (dz < 0.6 ? 2.2 : 1), 10, r * s * 0.7, mat(0xffc040, { e: 0xffa020, ei: 2 }), x + dx * r, y - r * 0.93, z + dz * r); f.castShadow = false; }
      lanterns.push(glowLight(g, 0xff9a2a, 1300, 2600, x, y - r * 0.6, z + r * 0.8, 1));
    };
    jack(-700, -150, 0, 210); jack(650, -100, 0, 170); jack(-1100, 250, 0, 150);
    const candles = [];
    for (const x of [-250, 230]) { cyl(g, 25, 25, 200, mat(0xe8e0d0), x, 180, 650); candles.push(glowLight(g, 0xffb050, 400, 1600, x, 180, 870, 9)); }
    glowLight(g, 0xf2f0dc, 0, 0, 2600, 9000, 5200, 520);                                  // the moon
    for (let i = 0; i < 6; i++) { const w = box(g, 3, 3, 500, mat(0xdddddd, { op: 0.5 }), -2000 + i * 40, 590, 2300 - i * 60); w.rotation.y = (i - 3) * 0.25; }
    return { group: g, spot: V(30, 0, 650), frame: { width: 2300, dir: V(0.1, -1, 0.34) }, background: tt === 'night' ? gradient('#090416', '#2a1440') : gradient('#2a1440', '#c0602a'),
      animate: (s) => { flicker(lanterns, 1300, s, 8); flicker(candles, 400, s, 10); } };
  } },

  { id: 'kids', name: "Kids' room toy shelf", kind: 'indoor', build(t) {
    const g = new THREE.Group();
    daylight(g, t, 'indoor', V(0, 0, 900), [0.5, -0.6, 0.6]);
    wall(g, 6000, 3000, texMat(pattern(wallpaper('#fbe7a8', '#f6d36a'), 256, 14, 7), { r: 0.95 }), 0, 330, 0);
    floor(g, 6000, 4000, texMat(pattern(boards('#c9a37a', '#be986f'), 256, 10, 6), { r: 0.7 }), 0, -1500, 0);
    cyl(g, 1000, 1000, 8, mat(0x6fb7e8, { r: 1 }), 0, -800, 0);                                        // round rug
    // a cubby shelf with toys
    const frameM = mat(0xffffff, { r: 0.6 });
    box(g, 1200, 330, 30, frameM, 0, 150, 870); box(g, 1200, 330, 30, frameM, 0, 150, 0); box(g, 1200, 330, 30, frameM, 0, 150, 435);
    for (const x of [-585, -195, 195, 585]) box(g, 30, 330, 900, frameM, x, 150, 0);
    const bins = [0xe8504a, 0x4aa8e8, 0x5ac46a, 0xf2c230, 0xb07ae0, 0xf08a3c];
    bins.forEach((c, i) => box(g, 340, 280, 360, mat(c, { r: 0.7 }), -390 + (i % 3) * 390, 140, i < 3 ? 40 : 470));
    const blocks = [0xe8504a, 0x4aa8e8, 0x5ac46a, 0xf2c230];
    blocks.forEach((c, i) => box(g, 70, 70, 70, mat(c, { r: 0.6 }), -460 + i * 85, 120, 900, i * 0.3)); box(g, 70, 70, 70, mat(0xb07ae0), -420, 120, 970, 0.5);
    ball(g, 90, mat(0xe8504a, { r: 0.5 }), 480, 120, 990); torus(g, 90, 12, mat(0xffffff), 480, 120, 990, 0, Math.PI / 2, 0);
    for (let i = 0; i < 7; i++) { const s = cone(g, 40, 10, mat(0xffffff, { e: isNight(t) ? 0xbfe0ff : 0x000000, ei: 0.8 }), -1200 + i * 380, 320, 1500 + (i % 3) * 300, 5); s.rotation.set(0, 0, i); }
    const nightLight = glowLight(g, 0x9fd0ff, lampPower(t, 600), 2500, 900, 0, 200, 40);
    return { group: g, spot: V(150, 120, 900), frame: { width: 1300, dir: V(0, -1, 0.32) }, background: roomBg(t, '#fbe7a8'), animate: () => {} };
  } },
];
