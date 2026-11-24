// Building blocks for the 3D settings (renderer/scenes/built.js): simple shapes in millimetres, Z up, placed by their
// bottom; materials; and the light for each time of day. Every mesh casts and receives shadows.
import * as THREE from '../vendor/three.module.js';

export const TIMES = ['day', 'evening', 'night'];

export function mat(color, o = {}) {
  return new THREE.MeshStandardMaterial({
    color, roughness: o.r ?? 0.8, metalness: o.m ?? 0,
    emissive: new THREE.Color(o.e ?? 0x000000), emissiveIntensity: o.ei ?? 1,
    transparent: o.op != null, opacity: o.op ?? 1, side: o.ds ? THREE.DoubleSide : THREE.FrontSide,
  });
}
function put(g, geo, m, x, y, z, rx = 0, ry = 0, rz = 0) {
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.set(x, y, z); mesh.rotation.set(rx, ry, rz);
  mesh.castShadow = true; mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}
// boxes and cylinders are placed by the centre of their bottom
export const box = (g, w, d, h, m, x = 0, y = 0, z = 0, rz = 0) => put(g, new THREE.BoxGeometry(w, d, h), m, x, y, z + h / 2, 0, 0, rz);
export const cyl = (g, r1, r2, h, m, x = 0, y = 0, z = 0, seg = 28) => put(g, new THREE.CylinderGeometry(r1, r2, h, seg), m, x, y, z + h / 2, Math.PI / 2);
export const cone = (g, r, h, m, x = 0, y = 0, z = 0, seg = 20) => put(g, new THREE.ConeGeometry(r, h, seg), m, x, y, z + h / 2, Math.PI / 2);
export const ball = (g, r, m, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) => { const b = put(g, new THREE.SphereGeometry(r, 28, 18), m, x, y, z); b.scale.set(sx, sy, sz); return b; };
export const torus = (g, r, t, m, x, y, z, rx = 0, ry = 0, rz = 0) => put(g, new THREE.TorusGeometry(r, t, 12, 40), m, x, y, z, rx, ry, rz);
// a shape turned around its vertical axis: points [[radius, height], ...]
export const lathe = (g, pts, m, x = 0, y = 0, z = 0) => put(g, new THREE.LatheGeometry(pts.map(([r, h]) => new THREE.Vector2(r, h)), 40), m, x, y, z, Math.PI / 2);
// a flat panel facing -Y (towards the camera), placed by its bottom centre
export const wall = (g, w, h, m, x = 0, y = 0, z = 0) => put(g, new THREE.PlaneGeometry(w, h), m, x, y, z + h / 2, Math.PI / 2);
export const floor = (g, w, d, m, x = 0, y = 0, z = 0) => put(g, new THREE.PlaneGeometry(w, d), m, x, y, z);

// a small light that's part of the setting (a flame, a bulb, a screen): a glowing shape and, optionally, real light
export function glowLight(g, color, intensity, dist, x, y, z, r = 8) {
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color }));
  bulb.position.set(x, y, z); g.add(bulb);
  if (intensity > 0) { const l = new THREE.PointLight(color, intensity, dist, 1); l.position.set(x, y, z); g.add(l); bulb.userData.light = l; }
  return bulb;
}

// A canvas texture: a sky or a soft gradient (top → bottom colours)
export function gradient(top, bottom, h = 256) {
  const c = document.createElement('canvas'); c.width = 4; c.height = h;
  const x = c.getContext('2d'), gr = x.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, top); gr.addColorStop(1, bottom);
  x.fillStyle = gr; x.fillRect(0, 0, 4, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// A repeating pattern drawn on a canvas (bricks, tiles, boards, wallpaper)
export function pattern(draw, size = 256, repeatX = 1, repeatY = 1) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeatX, repeatY); t.anisotropy = 4;
  return t;
}
export function texMat(tex, o = {}) { const m = mat(0xffffff, o); m.map = tex; return m; }

// The light for a time of day. kind: 'indoor' (a room: window light by day, lamps by evening, dark at night) or
// 'outdoor' (sun, low warm sun, moonlight). sun: direction the light comes from. Returns the shadow-casting light.
export function daylight(g, time, kind, around, sun = [0.45, -0.6, 0.75]) {
  const P = {
    outdoor: { day: [0xffffff, 0xa8c48a, 1.4, 0xfff4e0, 3.0], evening: [0xffd2a8, 0x6a5a6a, 0.8, 0xffa860, 2.0], night: [0x6070a0, 0x101020, 0.25, 0x9fb4ff, 0.35] },
    indoor: { day: [0xffffff, 0x9a8f80, 1.3, 0xfff2df, 2.2], evening: [0xffd9b0, 0x504038, 0.7, 0xffb878, 1.2], night: [0x303850, 0x080808, 0.12, 0x8090c0, 0.15] },
  }[kind][time];
  g.add(new THREE.HemisphereLight(P[0], P[1], P[2]));
  const d = new THREE.DirectionalLight(P[3], P[4]);
  const dir = new THREE.Vector3(...sun).normalize();
  d.position.copy(around).addScaledVector(dir, 3000);
  d.target.position.copy(around); g.add(d.target);
  d.castShadow = true;
  d.shadow.mapSize.set(2048, 2048);
  const s = d.shadow.camera; s.left = -900; s.right = 900; s.top = 900; s.bottom = -900; s.near = 100; s.far = 7000;
  d.shadow.bias = -0.0004; d.shadow.normalBias = 0.6; d.shadow.radius = 3;
  g.add(d);
  return d;
}
