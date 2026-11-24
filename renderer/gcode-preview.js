// The sliced print that is about to be sent, drawn from its G-code (src/preflight.js toolpaths): every feature in
// Orca's colours, each one can be shown or hidden, and a layer slider shows the print up to any layer. The bed's
// printable area is outlined; a move outside it is marked in red.
import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';

export class GcodePreview {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--viewer-bg').trim() || '#1F262D');
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.group = new THREE.Group(); this.scene.add(this.group);
    this.lines = new Map();   // feature name -> { obj, layerEnds }
    this.maxLayer = 0;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => { if (this.container.isConnected && this.container.offsetParent) { this.controls.update(); this.renderer.render(this.scene, this.camera); } this.raf = requestAnimationFrame(loop); };
    loop();
  }
  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }
  clear() {
    for (const o of [...this.group.children]) { this.group.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
    this.lines.clear();
  }
  // data: { features: [{name, color, segments, layerEnds}], layers }; bed: { rect, worst } from the bed check
  load(data, bed) {
    this.clear();
    const r = bed && bed.rect ? bed.rect : { x0: 0, x1: 270, y0: 0, y1: 270 };
    // the printable area: a plate and its outline
    const w = r.x1 - r.x0, d = r.y1 - r.y0;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color: 0x2a3138, transparent: true, opacity: 0.9 }));
    plate.position.set(r.x0 + w / 2, r.y0 + d / 2, -0.05);
    this.group.add(plate);
    const grid = new THREE.GridHelper(Math.max(w, d), Math.round(Math.max(w, d) / 10), 0x46515c, 0x37404a);
    grid.rotation.x = Math.PI / 2; grid.position.set(r.x0 + w / 2, r.y0 + d / 2, -0.02);
    this.group.add(grid);
    const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]].map(([x, y]) => new THREE.Vector3(x, y, 0))),
      new THREE.LineBasicMaterial({ color: bed && !bed.ok ? 0xff4d4d : 0x8a99a6 }));
    this.group.add(edge);
    if (bed && !bed.ok && bed.worst) {
      const p = bed.worst, at = new THREE.Vector3(p.axis === 'X' ? p.value : (bed.extent.x0 + bed.extent.x1) / 2, p.axis === 'Y' ? p.value : (bed.extent.y0 + bed.extent.y1) / 2, 0.3);
      const mark = new THREE.Mesh(new THREE.SphereGeometry(3, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff3030 }));
      mark.position.copy(at); this.group.add(mark);
    }
    let box = new THREE.Box3();
    for (const f of data.features) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(f.segments, 3));
      g.computeBoundingBox();
      if (f.count) box = box.union(g.boundingBox);
      const obj = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: new THREE.Color(f.color) }));
      this.group.add(obj);
      this.lines.set(f.name, { obj, layerEnds: f.layerEnds });
    }
    this.layers = data.layers || [];
    this.setMaxLayer(this.layers.length - 1);
    // look at the print from the front, a little above
    if (box.isEmpty()) box.set(new THREE.Vector3(r.x0, r.y0, 0), new THREE.Vector3(r.x1, r.y1, 10));
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const dist = Math.max(size.x, size.y, size.z, 40) * 2.2;
    this.controls.target.copy(c);
    this.camera.position.set(c.x, c.y - dist, c.z + dist * 0.75);
    this.camera.lookAt(c);
  }
  setVisible(name, on) { const l = this.lines.get(name); if (l) l.obj.visible = on; }
  setMaxLayer(L) {
    this.maxLayer = L;
    for (const l of this.lines.values()) l.obj.geometry.setDrawRange(0, 2 * (L >= 0 && l.layerEnds.length ? l.layerEnds[Math.min(L, l.layerEnds.length - 1)] : 0));
  }
}
