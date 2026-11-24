import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Filament finishes in the 3D view. Each triangle carries a 'finish' code and a 'sparkle' amount:
//   0 normal · 1 galaxy / glitter (flakes that glint as the view or the light moves) · 2 silk (glossy, pearly sheen and
//   faint layer lines) · 3 matte (no shine) · 4 translucent (lighter, light through the edges) · 5 glow in the dark
//   (pale in the light; glows when the lights are off) · 6 chrome (a mirror: fully metallic, almost perfectly smooth)
// The lights stay put while you turn the view (or the Spin button turns it), so highlights move across each finish.
export const FINISH_CODES = { normal: 0, galaxy: 1, silk: 2, matte: 3, translucent: 4, glow: 5, chrome: 6 };
// A soft studio for shiny filament to reflect: a light-to-dark room with three softboxes (above, left, right), made
// once and blurred by roughness (PMREM), so silk shows bright, sharp reflections and matte shows none
let STUDIO = null;
function studioEnvironment(renderer) {
  if (STUDIO) return STUDIO;
  const room = new THREE.Scene();
  const sky = new THREE.SphereGeometry(100, 32, 16);
  const cols = [], pos = sky.attributes.position;
  // a darkish room (so reflections have contrast) with a bright light strip around the horizon
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i), t = (z / 100 + 1) / 2, strip = Math.exp(-(((z - 8) / 9) ** 2)) * 2.6;
    const k = 0.03 + 0.16 * t + strip;
    cols.push(k, k * 1.02, k * 1.06);
  }
  sky.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  room.add(new THREE.Mesh(sky, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const box = (w, h, x, y, z, k) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k), side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); room.add(m); };
  box(60, 35, 0, -25, 85, 7.0);    // big softbox above
  box(30, 70, -80, -35, 25, 5.0);  // tall strip on the left
  box(20, 60, 75, 45, 30, 3.5);    // strip on the right, behind
  const pm = new THREE.PMREMGenerator(renderer);
  STUDIO = pm.fromScene(room, 0.02).texture;
  pm.dispose();
  return STUDIO;
}
// the colour a glow-in-the-dark filament glows: pale/white ones the classic aqua-green, coloured ones a saturated
// version of their colour (matches the shader)
function glowColor(hex) {
  const c = new THREE.Color(hex);
  const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
  if (mx - mn < 0.15) return '#6BFFC7';
  const h = new THREE.Color((c.r - mn) / (mx - mn), (c.g - mn) / (mx - mn), (c.b - mn) / (mx - mn));
  const hsl = {}; h.getHSL(hsl);
  return '#' + new THREE.Color().setHSL(hsl.h, 0.95, 0.6).getHexString();
}
const SPARKLE_TIME = { value: 0 };
const NIGHT = { value: 0 };
function addSparkle(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSparkleTime = SPARKLE_TIME;
    shader.uniforms.uNight = NIGHT;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float sparkle;
attribute float finish;
varying float vSparkle;
varying float vFinish;
varying vec3 vObjPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vSparkle = sparkle;
vFinish = finish;
vObjPos = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uSparkleTime;
uniform float uNight;
varying float vSparkle;
varying float vFinish;
varying vec3 vObjPos;
float spHash(vec3 p) { p = fract(p * vec3(443.897, 441.423, 437.195)); p += dot(p, p.yzx + 19.19); return fract((p.x + p.y) * p.z); }`)
      // how shiny each finish is
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
if (vFinish < 0.5) roughnessFactor = 0.45;
else if (vFinish > 1.5 && vFinish < 2.5) roughnessFactor = 0.07;
else if (vFinish > 2.5 && vFinish < 3.5) roughnessFactor = 1.0;
else if (vFinish > 3.5 && vFinish < 4.5) roughnessFactor = 0.2;
else if (vFinish > 5.5) roughnessFactor = 0.015;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
if (vFinish > 1.5 && vFinish < 2.5) metalnessFactor = 0.6;
else if (vFinish > 2.5 && vFinish < 3.5) metalnessFactor = 0.0;
else if (vFinish > 5.5) metalnessFactor = 1.0;`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
reflectedLight.indirectDiffuse *= 0.35;
if (vFinish > 5.5) { reflectedLight.indirectSpecular *= 3.2; reflectedLight.directSpecular *= 2.5; }
else if (vFinish > 1.5 && vFinish < 2.5) { reflectedLight.indirectSpecular *= 2.2; reflectedLight.directSpecular *= 2.0; }
else if (vFinish > 2.5 && vFinish < 3.5) { reflectedLight.indirectSpecular = vec3(0.0); reflectedLight.directSpecular = vec3(0.0); }
else if (vFinish < 1.5) reflectedLight.indirectSpecular *= 0.35;`)
      .replace('#include <opaque_fragment>', `{
  vec3 vdir = normalize(vViewPosition);
  float fres = pow(1.0 - clamp(abs(dot(normal, vdir)), 0.0, 1.0), 3.0);
  vec3 keyDir = normalize((viewMatrix * vec4(0.35, -0.55, 0.75, 0.0)).xyz);
  vec3 halfV = normalize(keyDir + vdir);
  float nh = max(dot(normal, halfV), 0.0);
  if (vFinish > 1.5 && vFinish < 2.5) {
    // silk: bright and glossy, a soft pearly sheen that slides across the surface as it turns, and the fine layer
    // lines (0.2 mm) catching the light
    float band = 0.5 + 0.5 * sin(vObjPos.z * 31.4159);
    float sheen = pow(nh, 6.0);
    outgoingLight = outgoingLight * (1.05 + 0.08 * band) + diffuseColor.rgb * 0.18 + (diffuseColor.rgb * 0.6 + vec3(0.4)) * (sheen * 0.8 + fres * 0.5) + vec3(1.0) * pow(nh, 120.0) * 1.2;
  } else if (vFinish > 2.5 && vFinish < 3.5) {
    // matte: flat and slightly chalky, no highlights
    float l = dot(outgoingLight, vec3(0.299, 0.587, 0.114));
    outgoingLight = mix(outgoingLight, vec3(l), 0.18) * 0.92 + diffuseColor.rgb * 0.08;
  } else if (vFinish > 3.5 && vFinish < 4.5) {
    // translucent: see-through, lighter, light glowing at the thin edges
    outgoingLight = mix(outgoingLight, diffuseColor.rgb, 0.3) + diffuseColor.rgb * fres * 1.2 + vec3(1.0) * pow(nh, 40.0) * 0.5;
    diffuseColor.a = 0.72 + 0.25 * fres;
  }
  // lights off: only glow-in-the-dark filament shows
  if (vFinish > 5.5) {
    // chrome: a mirror of the room, tinted by the filament colour (silver = classic chrome), a crisp rim
    outgoingLight = outgoingLight * 1.15 + vec3(1.0) * pow(nh, 400.0) * 2.0 + mix(diffuseColor.rgb, vec3(1.0), 0.5) * fres * 0.35;
    if (uNight > 0.0) outgoingLight *= 1.0 - 0.82 * uNight;
  } else if (vFinish > 4.5) {
    // the colour it glows: a pale/white filament glows the classic aqua-green, a coloured one a saturated version of
    // its own colour (the same rule as glowColor() below)
    vec3 c = diffuseColor.rgb;
    float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
    vec3 hue = mx - mn < 0.15 ? vec3(0.42, 1.0, 0.78) : (c - mn) / max(mx - mn, 0.001);
    vec3 gcol = normalize(hue + 0.05) * 1.25;
    if (uNight > 0.0) {
      // in the dark it is the light: brightest where it faces you, a near-white core, glowing thin edges, layer lines
      float facing = clamp(dot(normal, vdir), 0.0, 1.0);
      float band = 0.5 + 0.5 * sin(vObjPos.z * 31.4159);
      float lum = (0.42 + 0.58 * pow(facing, 0.7)) * (0.92 + 0.08 * band) + fres * 0.45;
      vec3 glowLight = gcol * lum;
      glowLight += (vec3(1.0) - glowLight) * clamp(lum - 0.75, 0.0, 1.0) * 0.55;
      glowLight *= 0.94 + 0.06 * sin(uSparkleTime * 0.7);
      outgoingLight = mix(outgoingLight, glowLight, uNight);
    } else {
      // in the light: pale, with a faint glow
      outgoingLight = mix(outgoingLight, vec3(dot(outgoingLight, vec3(0.333))), 0.15) + gcol * 0.05;
    }
  } else if (uNight > 0.0) {
    // everything else goes dark (the glow's own light still reaches it: see the glow lights)
    outgoingLight *= 1.0 - 0.82 * uNight;
  }
}
if (vSparkle > 0.0) {
  // flakes about 0.35 mm apart, each tilted its own way: bright when it reflects the light toward the eye
  vec3 cell = floor(vObjPos * 2.8);
  float glints = 0.0;
  for (int k = 0; k < 2; k++) {
    vec3 c = cell + float(k) * 17.0;
    float r = spHash(c);
    if (r > 0.82) {
      vec3 tilt = normalize(vec3(spHash(c + 1.3), spHash(c + 2.7), spHash(c + 4.1)) - 0.5);
      vec3 n = normalize(normal + tilt * 0.9);
      vec3 v = normalize(vViewPosition);
      vec3 lightDir = normalize(vec3(0.35, 0.55, 0.75));
      float facing = max(dot(reflect(v, n), lightDir), 0.0);
      float twinkle = 0.65 + 0.35 * sin(uSparkleTime * (1.5 + 3.0 * r) + r * 40.0);
      glints += pow(facing, 18.0) * twinkle * (0.6 + 1.6 * spHash(c + 7.7));
    }
  }
  // a faint shimmer everywhere plus the bright flakes, tinted a little by the filament color
  vec3 tint = mix(vec3(1.0), normalize(diffuseColor.rgb + 0.05) * 1.6, 0.35);
  outgoingLight += tint * (glints * 1.8 + 0.04) * vSparkle;
}
#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'finish6';
}

export class ModelViewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(200, -300, 400);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.6);
    rim.position.set(-300, 200, -100);
    this.scene.add(rim);
    this.lights = [[hemi, 1.6], [key, 1.6], [rim, 0.6]];
    this.scene.environment = studioEnvironment(this.renderer);
    this.night = false; this.spin = false; this.onSpinStop = null;
    // turning the view yourself stops the spin
    this.controls.addEventListener('start', () => { if (this.spin) { this.setSpin(false); if (this.onSpinStop) this.onSpinStop(); } });

    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);
    this.bed = null;
    this.mode = 'colors';
    this.colors = {};
    this.chunks = [];
    this.tool = 'rotate';
    this.brush = 6; // mm
    this.paintColor = new THREE.Color('#FF2BD6');
    this.raycaster = new THREE.Raycaster();
    this.painting = false;
    this.onPaint = null;
    const el = this.renderer.domElement;
    // capture phase runs before OrbitControls: left button paints in paint/erase mode, other buttons still orbit
    el.addEventListener('pointerdown', (e) => {
      if (this.tool === 'rotate') { this.controls.enabled = true; return; }
      if (e.button !== 0) { this.controls.enabled = true; return; }
      this.controls.enabled = false;
      this.painting = true; el.setPointerCapture(e.pointerId); this.paintAt(e);
    }, { capture: true });
    el.addEventListener('pointermove', (e) => {
      if (!this.painting) return;
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this.paintAt(e); });
    });
    const stop = () => {
      if (this.painting) { this.painting = false; if (this.tool.startsWith('part-')) { if (this.onRegionEdit) this.onRegionEdit(); } else if (this.onPaint) this.onPaint(this.region()); }
      this.controls.enabled = this.tool === 'rotate';
    };
    el.addEventListener('pointerup', stop); el.addEventListener('pointercancel', stop);
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    let last = null;
    const loop = (t) => {
      SPARKLE_TIME.value = (t || 0) / 1000; this.spinStep(t || 0);
      // the spin goes by the clock, not by frames, so it's the same speed on any screen
      const dt = last == null ? 1 / 60 : Math.min(0.1, ((t || 0) - last) / 1000); last = t || 0;
      this.controls.update(this.spin ? dt : null); this.renderer.render(this.scene, this.camera); requestAnimationFrame(loop);
    };
    loop();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    this.applyTheme();
  }

  // Spin: a slow turntable (the model turns under the fixed lights) while the view rises and dips between about 12° and
  // 55° above the bed, so the light sweeps across the surfaces from different angles
  setSpin(on) {
    this.spin = !!on;
    this.controls.autoRotate = this.spin;
    this.controls.autoRotateSpeed = 2.4;   // 25 s per turn
    this.spinT0 = null;
  }
  spinStep(t) {
    if (!this.spin) return;
    if (this.spinT0 == null) {
      this.spinT0 = t;
      const off = this.camera.position.clone().sub(this.controls.target);
      this.spinR = off.length();
    }
    const s = (t - this.spinT0) / 1000;
    const el = (33 + 21 * Math.sin(s * 0.21)) * Math.PI / 180;
    const off = this.camera.position.clone().sub(this.controls.target);
    const az = Math.atan2(off.y, off.x), r = this.spinR;
    this.camera.position.set(this.controls.target.x + r * Math.cos(el) * Math.cos(az), this.controls.target.y + r * Math.cos(el) * Math.sin(az), this.controls.target.z + r * Math.sin(el));
  }
  // Lights off: the room goes dark so glow-in-the-dark filament shows
  setNight(on) {
    this.night = !!on;
    NIGHT.value = this.night ? 1 : 0;
    for (const [l, i] of this.lights) l.intensity = this.night ? i * 0.06 : i;
    this.scene.environment = this.night ? null : studioEnvironment(this.renderer);
    this.scene.background = this.night ? new THREE.Color('#030405') : new THREE.Color(css('--viewer-bg') || '#DDE2E6');
    this.updateGlowFx();
  }
  // In the dark a glow-in-the-dark print lights what's around it: a light at each glowing object's centre (the bed and
  // neighbouring parts take its colour) and a soft halo (like the bloom in a photo of one)
  updateGlowFx() {
    if (this.glowFx) { this.scene.remove(this.glowFx); this.glowFx.traverse(o => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); }); this.glowFx = null; }
    if (!this.night) return;
    const g = new THREE.Group();
    const glows = this.chunks.filter(c => c.glow).sort((a, b) => b.glow.radius - a.glow.radius).slice(0, 8);
    if (!glows.length) return;
    if (!this.haloTex) {
      const cv = document.createElement('canvas'); cv.width = cv.height = 128;
      const x = cv.getContext('2d'), gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.22)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
      this.haloTex = new THREE.CanvasTexture(cv);
    }
    for (const c of glows) {
      const col = new THREE.Color(c.glow.color);
      const light = new THREE.PointLight(col, 7, c.glow.radius * 9, 1.1);
      light.position.copy(c.glow.center);
      g.add(light);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.haloTex, color: col, transparent: true, opacity: 0.4, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
      halo.position.copy(c.glow.center);
      halo.scale.setScalar(c.glow.radius * 3);
      halo.renderOrder = 10;
      g.add(halo);
    }
    this.glowFx = g;
    this.scene.add(g);
  }

  applyTheme() {
    this.scene.background = new THREE.Color(css('--viewer-bg') || '#DDE2E6');
    this.buildBed();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  buildBed() {
    if (this.bed) { this.scene.remove(this.bed); this.bed.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); }
    const g = new THREE.Group();
    const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(270, 270),
      new THREE.MeshStandardMaterial({ color: dark ? 0x2a3138 : 0xb9a37a, roughness: 0.95, metalness: 0.05, transparent: true, opacity: 0.85, envMapIntensity: 0.15 })
    );
    plate.position.z = -0.05;
    g.add(plate);
    const grid = new THREE.GridHelper(270, 27, dark ? 0x56616c : 0x8f7d5c, dark ? 0x3a434c : 0xa8946f);
    grid.rotation.x = Math.PI / 2;
    g.add(grid);
    this.bed = g;
    this.scene.add(g);
  }

  // map: filament number → color; sparkle (optional): filament number → 0..1 for galaxy / glitter filament;
  // finish (optional): filament number → FINISH_CODES value
  setFilamentColors(map, sparkle = {}, finish = {}) { this.colors = map; this.sparkle = sparkle || {}; this.finish = finish || {}; this.recolor(); }

  load(preview) {
    for (const c of this.chunks) { c.mesh.geometry.dispose(); c.mesh.material.dispose(); this.modelGroup.remove(c.mesh); }
    this.chunks = [];
    let maxZ = 0;
    for (const p of preview) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      geo.computeVertexNormals();
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(p.positions.length), 3));
      geo.setAttribute('sparkle', new THREE.BufferAttribute(new Float32Array(p.positions.length / 3), 1));
      geo.setAttribute('finish', new THREE.BufferAttribute(new Float32Array(p.positions.length / 3), 1));
      const isMod = p.kind === 'modifier';
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide,
        transparent: isMod, opacity: isMod ? 0.18 : 1, depthWrite: !isMod, flatShading: true,
      });
      if (!isMod) addSparkle(mat);
      const mesh = new THREE.Mesh(geo, mat);
      this.modelGroup.add(mesh);
      const n = p.positions.length / 9, cen = new Float32Array(n * 3), a = p.positions;
      for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) cen[t * 3 + k] = (a[t * 9 + k] + a[t * 9 + 3 + k] + a[t * 9 + 6 + k]) / 3;
      this.chunks.push({ mesh, extruder: p.extruder, kind: p.kind, name: p.name, centroids: cen, painted: new Uint8Array(n), triFilament: p.triFilament || null });
      geo.computeBoundingBox();
      maxZ = Math.max(maxZ, geo.boundingBox.max.z);
    }
    this.recolor();
    this.fit('iso');
  }

  setMode(mode) { this.mode = mode; this.recolor(); }

  recolor() {
    this._recolor();
    if (this.night) this.updateGlowFx();
  }
  _recolor() {
    const tmp = new THREE.Color();
    const red = new THREE.Color(css('--danger') || '#C2412D');
    const amber = new THREE.Color(css('--warn') || '#C98A16');
    const green = new THREE.Color(css('--ok') || '#3E8E5A');
    const neutral = new THREE.Color('#c9cfd4');
    const cos45 = Math.cos(Math.PI / 4), cos55 = Math.cos((55 * Math.PI) / 180);
    let zMin = Infinity;
    for (const c of this.chunks) {
      if (c.kind === 'modifier') continue;
      const pos = c.mesh.geometry.attributes.position.array;
      for (let i = 2; i < pos.length; i += 3) if (pos[i] < zMin) zMin = pos[i];
    }
    for (const c of this.chunks) {
      const pos = c.mesh.geometry.attributes.position.array;
      const col = c.mesh.geometry.attributes.color;
      const out = col.array;
      const spA = c.mesh.geometry.attributes.sparkle, sp = spA ? spA.array : null, spk = this.sparkle || {};
      const fnA = c.mesh.geometry.attributes.finish, fn = fnA ? fnA.array : null, fns = this.finish || {};
      const sparkleOn = this.mode === 'colors' && c.kind !== 'modifier' && Object.keys(spk).length > 0;
      const base = tmp.set(this.colors[c.extruder] || '#9aa5ae').clone();
      if (c.kind === 'modifier') base.set('#7fb2ff');
      // painted colour: each triangle's own filament (0 = the part's)
      const tf = c.triFilament, byFil = new Map();
      const filColor = (f) => { let x = byFil.get(f); if (!x) { x = new THREE.Color(this.colors[f] || '#9aa5ae'); byFil.set(f, x); } return x; };
      for (let i = 0; i < pos.length; i += 9) {
        let color = tf && tf[i / 9] ? filColor(tf[i / 9]) : base;
        if (this.mode === 'regions' && c.region && this.regionColors) color = this.regionColors[c.region[i / 9]] || neutral;
        if (this.mode === 'overhang' && c.kind !== 'modifier') {
          const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
          const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          const down = -nz / (Math.hypot(nx, ny, nz) || 1);
          const onBed = pos[i + 2] - zMin < 0.05 && pos[i + 5] - zMin < 0.05 && pos[i + 8] - zMin < 0.05;
          if (down > 0 && onBed) color = green;
          else if (down > cos45) color = red;
          else if (down > cos55) color = amber;
          else color = neutral;
        }
        if (c.painted && c.painted[i / 9]) color = this.paintColor;
        for (let v = 0; v < 3; v++) { out[i + v * 3] = color.r; out[i + v * 3 + 1] = color.g; out[i + v * 3 + 2] = color.b; }
        if (sp) { const s = sparkleOn && !(c.painted && c.painted[i / 9]) ? (spk[tf && tf[i / 9] ? tf[i / 9] : c.extruder] || 0) : 0; sp[i / 3] = s; sp[i / 3 + 1] = s; sp[i / 3 + 2] = s; }
        if (fn) { const f = this.mode === 'colors' && c.kind !== 'modifier' && !(c.painted && c.painted[i / 9]) ? (fns[tf && tf[i / 9] ? tf[i / 9] : c.extruder] || 0) : 0; fn[i / 3] = f; fn[i / 3 + 1] = f; fn[i / 3 + 2] = f; }
      }
      col.needsUpdate = true;
      if (spA) spA.needsUpdate = true;
      if (fnA) fnA.needsUpdate = true;
      if (fn && c.kind !== 'modifier') {
        let glowN = 0;
        for (let k = 0; k < fn.length; k += 3) if (fn[k] > 4.5 && fn[k] < 5.5) glowN++;
        if (glowN > fn.length / 3 * 0.2) {
          const bb = c.mesh.geometry.boundingBox || (c.mesh.geometry.computeBoundingBox(), c.mesh.geometry.boundingBox);
          const glowFil = Object.keys(fns).find(k => fns[k] === 5 && (Number(k) === c.extruder || (tf && tf.includes(Number(k))))) || c.extruder;
          c.glow = { color: glowColor(this.colors[glowFil] || '#cfe9d8'), center: bb.getCenter(new THREE.Vector3()), radius: Math.max(5, bb.getSize(new THREE.Vector3()).length() / 2) };
        } else c.glow = null;
        let clear = false;
        for (let k = 0; k < fn.length; k += 3) if (fn[k] > 3.5 && fn[k] < 4.5) { clear = true; break; }
        const m = c.mesh.material;
        if (m.transparent !== clear) { m.transparent = clear; m.depthWrite = !clear; m.needsUpdate = true; }
        // drawn after the (slightly see-through) bed, so the bed never paints over them
        c.mesh.renderOrder = clear ? 2 : 0;
      }
    }
  }

  fit(view = 'iso') {
    const box = new THREE.Box3().setFromObject(this.modelGroup);
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 50));
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z, 20) * 0.5;
    const dist = (r / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.45;
    const dirs = {
      iso: new THREE.Vector3(0.75, -1, 0.75),
      front: new THREE.Vector3(0, -1, 0.08),
      top: new THREE.Vector3(0.001, -0.001, 1),
      bottom: new THREE.Vector3(0.35, -0.6, -1),
      back: new THREE.Vector3(-0.75, 1, 0.6),
      side: new THREE.Vector3(1, 0.05, 0.25),
      left: new THREE.Vector3(-1, -0.05, 0.25),
    };
    const d = (dirs[view] || dirs.iso).clone().normalize();
    this.camera.position.copy(center).addScaledVector(d, dist);
    this.camera.near = dist / 100; this.camera.far = dist * 20; this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    if (this.bed) this.bed.visible = view !== 'bottom';
  }

  // Renders fixed views for Claude. Returns [{label, dataUrl}]
  capture() {
    const prevMode = this.mode;
    const prevPos = this.camera.position.clone(), prevTarget = this.controls.target.clone();
    const shots = [];
    const take = (mode, view, label) => {
      this.mode = mode; this.recolor(); this.fit(view);
      this.renderer.render(this.scene, this.camera);
      shots.push({ label, dataUrl: this.downscale(this.renderer.domElement, 900) });
    };
    take('colors', 'iso', 'App render: 3D view in filament colors');
    take('overhang', 'iso', 'App render: overhang map, 3D view (red = steeper than 45°, green = bed contact)');
    take('overhang', 'bottom', 'App render: overhang map seen from below');
    this.mode = prevMode; this.recolor();
    this.camera.position.copy(prevPos); this.controls.target.copy(prevTarget); this.controls.update();
    if (this.bed) this.bed.visible = true;
    return shots;
  }

  // ---------- colour regions (colour remix) ----------
  // labels: { meshKey: Uint16Array of region per source triangle }; each shown chunk knows its meshKey/srcTri
  // returns how many shown triangles got a region (0 = the labels don't belong to what's shown)
  setRegions(preview, labels) {
    let mapped = 0;
    this.chunks.forEach((c, i) => {
      const p = preview[i], lab = p && labels[p.meshKey];
      if (!lab || c.kind === 'modifier') { c.region = null; return; }
      // srcTri is only sent when shown triangles differ from the file's (simplified or painted); otherwise 1:1
      const n = p.srcTri ? p.srcTri.length : p.positions.length / 9;
      const r = new Uint16Array(n);
      for (let j = 0; j < n; j++) { r[j] = lab[p.srcTri ? p.srcTri[j] : j] || 0; if (r[j]) mapped++; }
      c.region = r; c.meshKey = p.meshKey; c.srcTri = p.srcTri || null;
    });
    return mapped;
  }
  // patches (the pieces parts are made of), shown triangle by shown triangle, for click-to-assign
  setPatches(preview, labels) {
    this.chunks.forEach((c, i) => {
      const p = preview[i], lab = p && labels[p.meshKey];
      if (!lab || c.kind === 'modifier') { c.patch = null; return; }
      const n = p.srcTri ? p.srcTri.length : p.positions.length / 9, r = new Uint16Array(n);
      for (let j = 0; j < n; j++) r[j] = lab[p.srcTri ? p.srcTri[j] : j] || 0;
      c.patch = r;
    });
  }
  // the edited regions back in the file's triangles (start from `base`, which covers triangles not shown)
  exportRegions(base) {
    const out = {};
    for (const [k, v] of Object.entries(base)) out[k] = Uint16Array.from(v);
    for (const c of this.chunks) {
      if (!c.region || !c.meshKey || !out[c.meshKey]) continue;
      const lab = out[c.meshKey];
      for (let j = 0; j < c.region.length; j++) lab[c.srcTri ? c.srcTri[j] : j] = c.region[j];
    }
    return out;
  }
  hitAt(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const live = this.chunks.filter(c => c.kind !== 'modifier' && c.region);
    const hit = this.raycaster.intersectObjects(live.map(c => c.mesh), false)[0];
    if (!hit) return null;
    return { chunk: live.find(c => c.mesh === hit.object), face: hit.faceIndex, point: hit.point };
  }
  // part editing: 'part-patch' gives the whole patch under the pointer to this.editValue, 'part-brush' paints
  // the triangles within this.brush mm that face the camera
  editAt(e) {
    const h = this.hitAt(e); if (!h) return;
    const v = this.editValue || 0; if (!v) return;
    if (this.tool === 'part-patch') {
      const pid = h.chunk.patch && h.chunk.patch[h.face]; if (!pid) return;
      for (const c of this.chunks) if (c.patch && c.region) for (let j = 0; j < c.patch.length; j++) if (c.patch[j] === pid) c.region[j] = v;
    } else {
      const p = h.point, r2 = this.brush * this.brush, eye = this.camera.position;
      for (const c of this.chunks) {
        if (!c.region) continue;
        const cen = c.centroids, pos = c.mesh.geometry.attributes.position.array;
        for (let t = 0; t < c.region.length; t++) {
          const dx = cen[t * 3] - p.x, dy = cen[t * 3 + 1] - p.y, dz = cen[t * 3 + 2] - p.z;
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          const i = t * 9;
          const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
          const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          if (nx * (eye.x - cen[t * 3]) + ny * (eye.y - cen[t * 3 + 1]) + nz * (eye.z - cen[t * 3 + 2]) < 0) continue;
          c.region[t] = v;
        }
      }
    }
    this.recolor();
  }
  // which region is under the pointer (for hover hints)
  regionAt(e) { const h = this.hitAt(e); return h ? { region: h.chunk.region[h.face], patch: h.chunk.patch ? h.chunk.patch[h.face] : 0 } : null; }
  // show region colours (hex per region id); null = back to filament colours
  showRegionColors(hexById) {
    if (!hexById) { this.mode = 'colors'; this.regionColors = null; this.recolor(); return; }
    this.regionColors = [];
    for (const [id, hex] of Object.entries(hexById)) this.regionColors[+id] = new THREE.Color(hex);
    this.mode = 'regions'; this.recolor();
  }
  // Region map pictures for the AI: distinct colours with each region's number drawn where it is visible.
  regionMapShots(regionIds, views = ['iso', 'front', 'back', 'side', 'top'], noun = 'region') {
    const prev = { mode: this.mode, colors: this.regionColors, pos: this.camera.position.clone(), target: this.controls.target.clone() };
    const palette = (i) => new THREE.Color().setHSL(((i * 0.618034) % 1), 0.65, i % 2 ? 0.45 : 0.6);
    // well-separated sRGB colours, one per region; read back with a small tolerance (colour management rounds)
    const idRGB = new Map(regionIds.map((id, i) => { const h = (i * 0.618034) % 1, c = new THREE.Color().setHSL(h, 1, i % 3 === 0 ? 0.35 : i % 3 === 1 ? 0.55 : 0.75); return [id, [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)]]; }));
    const idColor = (id) => { const [r, g, b] = idRGB.get(id); return THREE.SRGBColorSpace ? new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace) : new THREE.Color(r / 255, g / 255, b / 255); };
    const decode = (r, g, b) => { let best = null, bd = 13 * 13 * 3; for (const [id, c] of idRGB) { const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2; if (d < bd) { bd = d; best = id; } } return best; };
    const shots = [];
    const W = this.renderer.domElement.width, H = this.renderer.domElement.height;
    for (const view of views) {
      this.fit(view);
      // pass 1: flat ID colours, to find where each region is visible
      this.regionColors = []; for (const id of regionIds) this.regionColors[id] = idColor(id);
      this.mode = 'regions'; this.recolor();
      const mats = this.chunks.map(c => c.mesh.material);
      this.chunks.forEach(c => { c.mesh.material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }); });
      const bedVis = this.bed && this.bed.visible; if (this.bed) this.bed.visible = false;
      const bg = this.scene.background; this.scene.background = new THREE.Color('#ffffff');
      this.renderer.render(this.scene, this.camera);
      const S = 320, small = document.createElement('canvas'); small.width = S; small.height = Math.round(S * H / W);
      const g = small.getContext('2d'); g.drawImage(this.renderer.domElement, 0, 0, small.width, small.height);
      const px = g.getImageData(0, 0, small.width, small.height).data;
      const acc = new Map();
      for (let y = 0; y < small.height; y++) for (let x = 0; x < small.width; x++) {
        const o = (y * small.width + x) * 4;
        if (px[o + 3] < 250) continue;
        const id = decode(px[o], px[o + 1], px[o + 2]); if (id == null) continue;
        let a = acc.get(id); if (!a) { a = { n: 0, x: 0, y: 0, pts: [] }; acc.set(id, a); }
        a.n++; a.x += x; a.y += y; if (a.pts.length < 4000) a.pts.push(x, y);
      }
      this.chunks.forEach((c, i) => { c.mesh.material.dispose(); c.mesh.material = mats[i]; });
      // pass 2: shaded region colours with numbers
      this.regionColors = []; regionIds.forEach((id, i) => { this.regionColors[id] = palette(i); });
      this.recolor(); this.renderer.render(this.scene, this.camera);
      const out = document.createElement('canvas'), sc = Math.min(1, 900 / Math.max(W, H));
      out.width = Math.round(W * sc); out.height = Math.round(H * sc);
      const o2 = out.getContext('2d'); o2.drawImage(this.renderer.domElement, 0, 0, out.width, out.height);
      const k = out.width / small.width;
      o2.font = 'bold 15px sans-serif'; o2.textAlign = 'center'; o2.textBaseline = 'middle';
      for (const [id, a] of acc) {
        if (a.n < 12) continue;
        // the visible pixel of the region closest to its middle (stays on the region even if it's curved)
        const cx = a.x / a.n, cy = a.y / a.n; let bx = cx, by = cy, bd = Infinity;
        for (let i = 0; i < a.pts.length; i += 2) { const d = (a.pts[i] - cx) ** 2 + (a.pts[i + 1] - cy) ** 2; if (d < bd) { bd = d; bx = a.pts[i]; by = a.pts[i + 1]; } }
        const X = bx * k, Y = by * k;
        o2.fillStyle = 'rgba(255,255,255,0.9)'; o2.beginPath(); o2.arc(X, Y, 11, 0, Math.PI * 2); o2.fill();
        o2.strokeStyle = '#000'; o2.lineWidth = 1.5; o2.stroke(); o2.fillStyle = '#000'; o2.fillText(String(id), X, Y + 1);
      }
      shots.push({ label: `${noun[0].toUpperCase() + noun.slice(1)} map, ${view} view: each colour is one numbered ${noun}`, dataUrl: out.toDataURL('image/jpeg', 0.85) });
      this.scene.background = bg; if (this.bed) this.bed.visible = bedVis;
    }
    this.mode = prev.mode; this.regionColors = prev.colors; this.recolor();
    this.camera.position.copy(prev.pos); this.controls.target.copy(prev.target); this.controls.update();
    return shots;
  }
  // the model's surface per filament (each part's own, or each painted triangle's), in mm²: { filament: area }
  filamentAreas() {
    const out = {};
    for (const c of this.chunks) {
      if (c.kind === 'modifier') continue;
      const a = c.mesh.geometry.attributes.position.array, tf = c.triFilament;
      for (let i = 0, t = 0; i < a.length; i += 9, t++) {
        const ux = a[i + 3] - a[i], uy = a[i + 4] - a[i + 1], uz = a[i + 5] - a[i + 2];
        const vx = a[i + 6] - a[i], vy = a[i + 7] - a[i + 1], vz = a[i + 8] - a[i + 2];
        const f = tf && tf[t] ? tf[t] : c.extruder;
        out[f] = (out[f] || 0) + Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      }
    }
    return out;
  }
  // a square picture of the model in the given filament colours ({ colors, sparkle }), for a scheme card
  filamentPreview(looks, size = 200, view = 'iso') {
    const prev = { mode: this.mode, colors: this.colors, sparkle: this.sparkle, finish: this.finish, pos: this.camera.position.clone(), target: this.controls.target.clone(), bg: this.scene.background };
    this.mode = 'colors'; this.colors = looks.colors; this.sparkle = looks.sparkle || {}; this.finish = looks.finish || {}; this.recolor(); this.fit(view);
    if (this.bed) this.bed.visible = false;
    this.scene.background = null; this.renderer.setClearColor(0x000000, 0);
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement, side = Math.min(src.width, src.height);
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    c.getContext('2d').drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, size, size);
    this.scene.background = prev.bg; if (this.bed) this.bed.visible = true;
    this.mode = prev.mode; this.colors = prev.colors; this.sparkle = prev.sparkle; this.finish = prev.finish; this.recolor();
    this.camera.position.copy(prev.pos); this.controls.target.copy(prev.target); this.controls.update();
    return c.toDataURL('image/png');
  }
  // a square picture of the model in the given region colours, for a scheme card
  regionPreview(hexById, size = 360, view = 'iso') {
    const prev = { mode: this.mode, colors: this.regionColors, pos: this.camera.position.clone(), target: this.controls.target.clone(), bg: this.scene.background };
    this.showRegionColors(hexById); this.fit(view);
    if (this.bed) this.bed.visible = false;
    this.scene.background = null; this.renderer.setClearColor(0x000000, 0);
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement, side = Math.min(src.width, src.height);
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    c.getContext('2d').drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, size, size);
    this.scene.background = prev.bg; if (this.bed) this.bed.visible = true;
    this.mode = prev.mode; this.regionColors = prev.colors; this.recolor();
    this.camera.position.copy(prev.pos); this.controls.target.copy(prev.target); this.controls.update();
    return c.toDataURL('image/png');
  }

  // ---------- printed supports (from the G-code), for the troubleshooter ----------
  // segments: plate coordinates [x1,y1,z1,x2,y2,z2,...]; offset: where the model preview was centered from
  setSupports(sp, offset = [0, 0, 0]) {
    if (this.supports) { this.scene.remove(this.supports.lines); this.supports.lines.geometry.dispose(); this.supports = null; }
    if (!sp || !sp.count) return;
    const n = sp.count, pos = new Float32Array(n * 6), col = new Float32Array(n * 6), mid = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 6; k++) pos[i * 6 + k] = sp.segments[i * 6 + k] - offset[k % 3];
      for (let k = 0; k < 3; k++) mid[i * 3 + k] = (pos[i * 6 + k] + pos[i * 6 + 3 + k]) / 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
    this.supports = { lines, mid, iface: sp.interface, painted: new Uint8Array(n), count: n };
    this.recolorSupports();
    this.scene.add(lines);
  }
  setSupportsVisible(on) { if (this.supports) this.supports.lines.visible = on; this.renderer.render(this.scene, this.camera); }
  recolorSupports() {
    const S = this.supports; if (!S) return;
    const col = S.lines.geometry.attributes.color.array;
    const base = new THREE.Color('#8A96A3'), iface = new THREE.Color('#5E9FB0');
    for (let i = 0; i < S.count; i++) {
      const c = S.painted[i] ? this.paintColor : (S.iface && S.iface[i] ? iface : base);
      for (let v = 0; v < 2; v++) { col[i * 6 + v * 3] = c.r; col[i * 6 + v * 3 + 1] = c.g; col[i * 6 + v * 3 + 2] = c.b; }
    }
    S.lines.geometry.attributes.color.needsUpdate = true;
  }
  // paint support segments near the pointer (screen distance; supports are thin lines, not surfaces)
  paintSupportsAt(e, val) {
    const S = this.supports; if (!S || !S.lines.visible) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const r = Math.max(8, this.brush * 3.5), r2 = r * r;
    const v = new THREE.Vector3(), eye = this.camera.position;
    // under the brush on screen, then only the supports nearest the viewer (not ones far behind them)
    const hits = [];
    let nearest = Infinity;
    for (let i = 0; i < S.count; i++) {
      v.set(S.mid[i * 3], S.mid[i * 3 + 1], S.mid[i * 3 + 2]);
      const d = v.distanceTo(eye);
      v.project(this.camera);
      if (v.z > 1) continue;
      const sx = (v.x + 1) / 2 * rect.width, sy = (1 - v.y) / 2 * rect.height;
      if ((sx - px) * (sx - px) + (sy - py) * (sy - py) <= r2) { hits.push(i, d); if (d < nearest) nearest = d; }
    }
    const depth = Math.max(4, this.brush * 1.5); // mm behind the nearest support that still counts
    for (let k = 0; k < hits.length; k += 2) if (hits[k + 1] <= nearest + depth) S.painted[hits[k]] = val;
    this.recolorSupports();
  }
  supportRegion(offset = [0, 0, 0]) {
    const S = this.supports; if (!S) return null;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let n = 0, ifaceN = 0;
    for (let i = 0; i < S.count; i++) {
      if (!S.painted[i]) continue;
      n++; if (S.iface && S.iface[i]) ifaceN++;
      for (let k = 0; k < 3; k++) { const x = S.mid[i * 3 + k] + offset[k]; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; }
    }
    if (!n) return null;
    return { segments: n, interfaceShare: Math.round(100 * ifaceN / n), zMin: +min[2].toFixed(2), zMax: +max[2].toFixed(2),
      xRange: [+min[0].toFixed(1), +max[0].toFixed(1)], yRange: [+min[1].toFixed(1), +max[1].toFixed(1)], centerXY: [+((min[0] + max[0]) / 2).toFixed(1), +((min[1] + max[1]) / 2).toFixed(1)] };
  }

  // ---------- painting the failure area ----------
  setTool(tool) { this.tool = tool; this.controls.enabled = tool === 'rotate'; this.renderer.domElement.style.cursor = tool === 'rotate' ? 'grab' : tool === 'part-patch' ? 'pointer' : 'crosshair'; }
  clearPaint() { for (const c of this.chunks) c.painted && c.painted.fill(0); if (this.supports) { this.supports.painted.fill(0); this.recolorSupports(); } this.recolor(); if (this.onPaint) this.onPaint(this.region()); }

  paintAt(e) {
    if (this.tool.startsWith('part-')) { this.editAt(e); return; }
    if (this.tool === 'paint-supports') { this.paintSupportsAt(e, 1); return; }
    if (this.tool === 'erase' && this.supports && this.supports.lines.visible) this.paintSupportsAt(e, 0);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.chunks.filter(c => c.kind !== 'modifier').map(c => c.mesh), false)[0];
    if (!hit) return;
    const p = hit.point, r2 = this.brush * this.brush, val = this.tool === 'erase' ? 0 : 1;
    const eye = this.camera.position;
    for (const c of this.chunks) {
      if (c.kind === 'modifier') continue;
      const cen = c.centroids, pos = c.mesh.geometry.attributes.position.array;
      for (let t = 0; t < c.painted.length; t++) {
        const dx = cen[t * 3] - p.x, dy = cen[t * 3 + 1] - p.y, dz = cen[t * 3 + 2] - p.z;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        // only faces turned toward the camera, so painting the front doesn't paint through to the back
        const i = t * 9;
        const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
        const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        if (nx * (eye.x - cen[t * 3]) + ny * (eye.y - cen[t * 3 + 1]) + nz * (eye.z - cen[t * 3 + 2]) < 0) continue;
        c.painted[t] = val;
      }
    }
    this.recolor();
  }

  // What the painted triangles describe, in plate coordinates (offset = where the preview was centered from).
  region(offset = [0, 0, 0]) {
    let area = 0, ov = 0, n = 0;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], nsum = [0, 0, 0], names = new Set();
    let partTop = 0;
    for (const c of this.chunks) {
      if (c.kind === 'modifier') continue;
      const pos = c.mesh.geometry.attributes.position.array;
      for (let i = 2; i < pos.length; i += 3) if (pos[i] > partTop) partTop = pos[i];
      for (let t = 0; t < c.painted.length; t++) {
        if (!c.painted[t]) continue;
        const i = t * 9;
        const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
        const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz); if (!len) continue;
        const a = len / 2; area += a; n++;
        nsum[0] += nx / 2; nsum[1] += ny / 2; nsum[2] += nz / 2;
        if (-nz / len > Math.SQRT1_2) ov += a;
        for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) { const x = pos[i + v * 3 + k]; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; }
        if (c.name) names.add(c.name);
      }
    }
    if (!n) return null;
    const nl = Math.hypot(...nsum) || 1, d = nsum.map(v => v / nl);
    const facing = d[2] > 0.7 ? 'top surface (faces up)' : d[2] < -0.7 ? 'underside (faces down)'
      : `side wall facing ${Math.abs(d[0]) > Math.abs(d[1]) ? (d[0] > 0 ? '+X (right)' : '−X (left)') : (d[1] > 0 ? '+Y (back)' : '−Y (front)')}${d[2] < -0.3 ? ', angled downward' : d[2] > 0.3 ? ', angled upward' : ''}`;
    const w = (k) => [+(min[k] + offset[k]).toFixed(1), +(max[k] + offset[k]).toFixed(1)];
    return {
      source: 'painted on the 3D model', triangles: n, areaCm2: +(area / 100).toFixed(2), overhangSharePercent: Math.round(100 * ov / area),
      zMin: w(2)[0], zMax: w(2)[1], xRange: w(0), yRange: w(1),
      centerXY: [+((min[0] + max[0]) / 2 + offset[0]).toFixed(1), +((min[1] + max[1]) / 2 + offset[1]).toFixed(1)],
      heightOfPartPercent: [Math.round(100 * (min[2]) / (partTop || 1)), Math.round(100 * max[2] / (partTop || 1))],
      nearBed: min[2] + offset[2] < 1.0, facing, faceDirection: d.map(v => +v.toFixed(2)), modelObjects: [...names],
    };
  }

  // Renders that show the painted area: the current view plus one looking straight at it.
  capturePainted(dir) {
    const prevPos = this.camera.position.clone(), prevTarget = this.controls.target.clone();
    const shots = [{ label: 'Model with the failed area painted magenta (user’s view)', dataUrl: this.downscale((this.renderer.render(this.scene, this.camera), this.renderer.domElement), 900) }];
    if (dir) {
      const box = new THREE.Box3().setFromObject(this.modelGroup); const center = box.getCenter(new THREE.Vector3());
      const r = Math.max(...box.getSize(new THREE.Vector3()).toArray(), 20) * 0.5;
      const dist = (r / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.45;
      const v = new THREE.Vector3(dir[0], dir[1], dir[2] * 0.8 + 0.25).normalize();
      this.camera.position.copy(center).addScaledVector(v, dist); this.controls.target.copy(center); this.controls.update();
      this.renderer.render(this.scene, this.camera);
      shots.push({ label: 'Model seen from the painted side (failed area in magenta)', dataUrl: this.downscale(this.renderer.domElement, 900) });
      this.camera.position.copy(prevPos); this.controls.target.copy(prevTarget); this.controls.update();
    }
    return shots;
  }

  // Square PNG renders of the plate for the printer's screen (U1 wants 48x48 and 300x300) and the send dialog.
  thumbnails(sizes = [48, 300, 512]) {
    const prevMode = this.mode;
    const prevPos = this.camera.position.clone(), prevTarget = this.controls.target.clone();
    const prevBg = this.scene.background;
    this.mode = 'colors'; this.recolor(); this.fit('iso');
    if (this.bed) this.bed.visible = false;
    this.scene.background = null;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const side = Math.min(src.width, src.height);
    const sx = (src.width - side) / 2, sy = (src.height - side) / 2;
    const out = sizes.map(n => {
      const c = document.createElement('canvas'); c.width = n; c.height = n;
      c.getContext('2d').drawImage(src, sx, sy, side, side, 0, 0, n, n);
      return { w: n, h: n, dataUrl: c.toDataURL('image/png') };
    });
    this.scene.background = prevBg;
    if (this.bed) this.bed.visible = true;
    this.mode = prevMode; this.recolor();
    this.camera.position.copy(prevPos); this.controls.target.copy(prevTarget); this.controls.update();
    return out;
  }

  downscale(canvas, max) {
    const s = Math.min(1, max / Math.max(canvas.width, canvas.height));
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  }
}
