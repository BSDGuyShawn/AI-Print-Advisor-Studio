// Print Monitor (src/monitor): job watching and alerts, time left, previews, emails, ntfy, the monitor's requests.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PrinterWatch } = require('../src/monitor/watch');
const { parseGcode, render, printedLayers, parseHex } = require('../src/monitor/preview');
const { buildMessage } = require('../src/monitor/smtp');
const { Notifier } = require('../src/monitor/notify');
const { MonitorHub } = require('../src/monitor/hub');
const { baseUrls } = require('../src/monitor/moonraker');
const { compare } = require('../src/monitor/compare');

// a printer that does what the test says
class FakeConn extends EventEmitter {
  constructor() { super(); this.base = 'http://printer.test'; this.status = {}; this.connected = true; this.klippyState = 'ready'; this.objects = ['print_task_config']; this.systemMemory = {}; this.calls = []; }
  start() {} stop() {}
  headers() { return {}; }
  async call(method, params) {
    this.calls.push(method);
    if (method === 'server.files.metadata') return { estimated_time: 3600, filament_total: 10000, size: 1, modified: 1, thumbnails: [] };
    if (method === 'server.history.totals') return { job_totals: { total_jobs: 3, total_filament_used: 12000 } };
    if (method.startsWith('printer.print.')) return 'ok';
    return {};
  }
  async fetch() { return new Response('x'); }
  set(st) { for (const [k, v] of Object.entries(st)) this.status[k] = { ...(this.status[k] || {}), ...v }; this.emit('update', new Set(Object.keys(st))); }
}
class FakeCam { constructor() { this.forced = false; } start() {} stop() {} info() { return { mode: 'u1' }; } async freshSnapshot() { return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9])]); } }
const tick = () => new Promise(r => setTimeout(r, 30));

function makeWatch(dir, conn = new FakeConn(), settings = {}) {
  const sent = [];
  const w = new PrinterWatch({ printer: { id: 'p1', name: 'U1 #1', url: 'printer.test' }, dataDir: dir,
    settings: () => ({ safe_bed_c: 40, snapshot_progress: 99, preview_minutes: 5, units: 'F', milestones: [], ...settings }),
    notify: async (event, o) => { sent.push({ event, ...o }); }, previews: null,
    connectionFactory: () => conn, cameraFactory: () => new FakeCam() });
  return { w, conn, sent };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipa-mon-'));

test('a whole print: started, 99 % photo, finished, then ready once the bed cools; nothing twice after a restart', async () => {
  const dir = tmp();
  const { w, conn, sent } = makeWatch(dir);
  conn.set({ print_stats: { state: 'standby', filename: '' }, heater_bed: { temperature: 25 } });
  await tick();
  conn.set({ print_stats: { state: 'printing', filename: 'Cat.gcode', print_duration: 0, total_duration: 5, info: { current_layer: 0, total_layer: 100 } }, heater_bed: { temperature: 60, target: 60 }, virtual_sdcard: { progress: 0 } });
  await tick();
  assert.deepStrictEqual(sent.map(s => s.event), ['start']);
  assert.strictEqual(w.stage, 'preparing');
  conn.set({ print_stats: { info: { current_layer: 50, total_layer: 100 }, print_duration: 1800, filament_used: 5000 }, display_status: { progress: 0.5 } });
  await tick();
  assert.strictEqual(w.stage, 'printing');
  const t = w.timeLeft();
  assert.ok(Math.abs(t.left - 1800) < 1, `half done in 30 min: 30 min left (${t.left})`);
  conn.set({ display_status: { progress: 0.995 } });
  await tick(); await tick();
  assert.ok(sent.some(s => s.event === 'snapshot'), 'the photo at 99 %');
  const photos = fs.readdirSync(path.join(dir, 'gallery', 'p1'));
  assert.ok(photos.some(f => f.endsWith('.jpg')) && photos.some(f => f.endsWith('.json')));
  conn.set({ print_stats: { state: 'complete' }, heater_bed: { temperature: 58, target: 0 } });
  await tick();
  assert.ok(sent.some(s => s.event === 'complete'));
  assert.strictEqual(w.stage, 'cooling');
  assert.ok(!sent.some(s => s.event === 'ready'));
  conn.set({ heater_bed: { temperature: 39 } });
  await tick();
  const ready = sent.filter(s => s.event === 'ready');
  assert.strictEqual(ready.length, 1);
  assert.ok(ready[0].email && /ready to remove/.test(ready[0].email.subject), 'the finished email (Home Assistant print_finished)');
  assert.strictEqual(w.stage, 'ready');
  // the app restarts: same finished job, no alerts again
  const again = makeWatch(dir, conn);
  conn.set({ heater_bed: { temperature: 30 } });
  await tick();
  assert.deepStrictEqual(again.sent, []);
});

test('progress emails go out once per step, not when a step is caught up after a reconnect', async () => {
  const { conn, sent } = makeWatch(tmp(), new FakeConn(), { milestones: [1, 25, 50] });
  conn.set({ print_stats: { state: 'standby' } }); await tick();
  conn.set({ print_stats: { state: 'printing', filename: 'a.gcode', info: { current_layer: 3, total_layer: 9 } }, display_status: { progress: 0.012 } }); await tick(); await tick();
  conn.set({ display_status: { progress: 0.40 } }); await tick(); await tick();   // 25 % passed while away: skipped
  conn.set({ display_status: { progress: 0.51 } }); await tick(); await tick();
  const p = sent.filter(s => s.event === 'progress');
  assert.deepStrictEqual(p.map(x => x.title.match(/@ (\d+)%/)[1]), ['1', '50']);
  assert.ok(p[0].email.images.length === 1 && /cid:cam/.test(p[0].email.html), 'with the camera photo');
});

test('controls only when they make sense', async () => {
  const { w, conn } = makeWatch(tmp());
  conn.set({ print_stats: { state: 'standby' } });
  await assert.rejects(w.control('pause'), /Can’t pause/);
  conn.set({ print_stats: { state: 'printing' } });
  assert.strictEqual(await w.control('pause'), 'ok');
  await assert.rejects(w.control('explode'), /Unknown/);
});

test('watching never pauses, resumes or cancels by itself; a pause from elsewhere is said to be not from this app', async () => {
  const logs = [];
  const conn = new FakeConn();
  const sent = [];
  const w = new PrinterWatch({ printer: { id: 'p1', name: 'U1 #1', url: 'printer.test' }, dataDir: tmp(),
    settings: () => ({ safe_bed_c: 40, snapshot_progress: 99, preview_minutes: 5, units: 'F', milestones: [] }),
    notify: async (event, o) => { sent.push({ event, ...o }); }, previews: null, log: (m) => logs.push(m),
    connectionFactory: () => conn, cameraFactory: () => new FakeCam() });
  conn.set({ print_stats: { state: 'printing', filename: 'Deer.gcode', print_duration: 60, info: { current_layer: 5, total_layer: 100 } }, heater_bed: { temperature: 60 } });
  await tick();
  // the monitor window opening and closing (camera on and off), reconnecting, a whole print going by
  w.camera.start(); w.camera.stop(); conn.emit('update', new Set(['print_stats']));
  conn.set({ display_status: { progress: 0.5 } }); await tick();
  conn.set({ print_stats: { state: 'paused' } }); await tick();
  assert.deepStrictEqual(conn.calls.filter(c => c.startsWith('printer.print.')), [], 'no print command without the user');
  assert.ok(logs.some(l => /paused by something other than this app/.test(l)));
  assert.match(sent.find(s => s.event === 'paused').message, /not by this app/);
  // the user's own, confirmed pause is said to be the app's
  conn.set({ print_stats: { state: 'printing' } }); await tick();
  await w.control('pause');
  conn.set({ print_stats: { state: 'paused' } }); await tick();
  assert.deepStrictEqual(conn.calls.filter(c => c.startsWith('printer.print.')), ['printer.print.pause']);
  assert.ok(logs.some(l => /paused by this app \(the user confirmed Pause\)/.test(l)));
});
test('G-code preview: layers, colors per toolhead, how far the printer got', () => {
  const g = ['; filament_colour = #FF0000;#00FF00', 'G90', 'M83', 'T0', 'G1 Z0.2', 'G1 X0 Y0', 'G1 X10 Y0 E1', 'G1 X10 Y10 E1', 'T1', 'G1 Z0.4', 'G1 X0 Y10 E1', ';TYPE:Support', 'G1 X0 Y0 E1', 'G1 Z0.6 X5 Y5', 'G1 X6 Y6 E0.5'].join('\n');
  const p = parseGcode(g);
  assert.strictEqual(p.layerZ.length, 3);
  assert.strictEqual(p.count, 5);
  assert.deepStrictEqual(Array.from(p.segSupport), [0, 0, 0, 1, 1], "support until the next ;TYPE:");
  assert.deepStrictEqual(p.headerColors, ['#FF0000', '#00FF00']);
  assert.strictEqual(printedLayers(p, { filePosition: p.layerOff[1] + 1 }), 2);
  assert.strictEqual(printedLayers(p, { state: 'complete' }), 3);
  const png = render(p, -35, 32, 2, false, { 0: parseHex('#FF0000'), 1: parseHex('#00FF00') });
  assert.deepStrictEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.ok(png.length > 1000);
  assert.deepStrictEqual(parseHex('000000FF'), [70, 70, 70], 'black is lifted so it shows on the dark picture');
});

test('emails: an HTML body with the photo inline', () => {
  const m = buildMessage({ from: 'me@x.test', to: ['you@x.test'], subject: 'U1 #1 @ 50% - Cat', html: '<img src="cid:cam">', text: 'hi', images: [{ cid: 'cam', name: 'camera.jpg', data: Buffer.from('jpeg') }] });
  assert.match(m, /Subject: U1 #1 @ 50% - Cat/);
  assert.match(m, /Content-ID: <cam>/);
  assert.match(m, /multipart\/related/);
  assert.match(buildMessage({ from: 'a@b', to: ['c@d'], subject: 'Druck fertig ✓', html: '', text: '' }), /Subject: =\?UTF-8\?B\?/);
});

test('alerts: each channel gets only its events; progress goes by email only; ntfy carries the photo', async () => {
  const dir = tmp(), img = path.join(dir, 'p.jpg');
  fs.writeFileSync(img, 'jpeg');
  const desk = [], fetched = [], mails = [];
  const n = new Notifier({
    getCfg: () => ({ desktop: { enabled: true, events: { start: true } }, ntfy: { enabled: true, topic: 't0pic', server: 'https://ntfy.test', events: { ready: true } }, email: { enabled: true, host: 'smtp.test', to: 'a@b', events: { ready: true } } }),
    desktop: async (t) => desk.push(t), fetchFn: async (url, o) => { fetched.push({ url, o }); return new Response('ok'); }, sendMail: async (cfg, msg) => mails.push(msg),
  });
  await n.send({ event: 'start', title: 'started', message: 'm' });
  assert.deepStrictEqual([desk.length, fetched.length, mails.length], [1, 0, 0]);
  const r = await n.send({ event: 'ready', title: 'ready', message: 'cool', imagePath: img });
  assert.deepStrictEqual(r.results, { ntfy: 'ok', email: 'ok' });
  assert.strictEqual(fetched[0].url, 'https://ntfy.test/t0pic');
  assert.strictEqual(fetched[0].o.method, 'PUT');
  assert.strictEqual(fetched[0].o.headers.Filename, 'p.jpg');
  await n.send({ event: 'progress', title: '50%', message: 'm', email: { subject: '50%', html: '', text: '' } });
  assert.deepStrictEqual([desk.length, fetched.length, mails.length], [1, 1, 2]);
});

test('the monitor’s requests: photos stay in their folder, controls need a confirmation', async () => {
  const dir = tmp();
  const notifier = new Notifier({ getCfg: () => ({}), desktop: async () => {} });
  const ctl = [];
  const hub = new MonitorHub({ dataDir: dir, notifier, getSettings: () => ({}), getPrinters: async () => [{ id: 'p1', name: 'A', url: 'x' }],
    watchFactory: () => Object.assign(new EventEmitter(), { id: 'p1', start() {}, stop() {}, snapshot: () => ({ id: 'p1', stage: 'idle' }), control: async (a) => { ctl.push(a); return 'ok'; }, camera: {} }) });
  await hub.reload();
  assert.strictEqual((await hub.handle(new Request('app://bundle/api/monitor/state'))).status, 200);
  assert.strictEqual((await hub.handle(new Request('app://bundle/api/monitor/gallery/p1/..%2F..%2Fconfig.jpg'))).status, 404);
  assert.strictEqual((await hub.handle(new Request('app://bundle/api/monitor/p1/nope'))).status, 404);
  const no = await hub.handle(new Request('app://bundle/api/monitor/p/p1/control', { method: 'POST', body: JSON.stringify({ action: 'cancel' }) }));
  assert.strictEqual(no.status, 400);
  assert.deepStrictEqual(ctl, []);
  const yes = await hub.handle(new Request('app://bundle/api/monitor/p/p1/control', { method: 'POST', body: JSON.stringify({ action: 'cancel', confirm: true }) }));
  assert.strictEqual(yes.status, 200);
  assert.deepStrictEqual(ctl, ['cancel']);
  hub.stop();
});

test('printer addresses: port 80 first, then Moonraker’s own port', () => {
  assert.deepStrictEqual(baseUrls('192.168.1.87'), ['http://192.168.1.87', 'http://192.168.1.87:7125']);
  assert.deepStrictEqual(baseUrls('http://10.0.0.5:7125/'), ['http://10.0.0.5:7125']);
  assert.match(compare(3.4), /basketball hoop/);
});
