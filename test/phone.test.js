// Phone access (src/phone/server.js): pairing, who gets in, what's served, conflicts, live updates; and the pieces it
// relies on (FilamentStore revisions, sticker links).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PhoneServer, deviceName } = require('../src/phone/server');
const { FilamentStore } = require('../src/filament');
const { encodeTag } = require('../src/nfc/encoders');
const { decodeUltralight } = require('../src/nfc/decoders');
const { parseNdef, uriOf } = require('../src/nfc/ndef');

const APP = path.join(__dirname, '..');

function req(port, p, { method = 'GET', headers = {}, body, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}
const cookieOf = (res) => (res.headers['set-cookie'] || [])[0].split(';')[0];
const JSONH = { 'content-type': 'application/json', 'x-aipa': '1' };

async function setup(t, apiOverrides = {}) {
  let cfg = { enabled: true, port: 0, https: false, httpsPort: 0, linkHost: 'name', devices: [] };
  const saves = [];
  const api = {
    load: async () => ({ state: { v: 2 }, rev: 7 }),
    save: async (d) => { if (d.rev === 1) throw Object.assign(new Error('STALE: changed'), { code: 'STALE' }); saves.push(d); return { rev: 8 }; },
    claude: async () => ({ ok: true }), fetch: async () => 'x', hasKey: async () => true, ...apiOverrides,
  };
  const s = new PhoneServer({ appDir: APP, imagesDir: path.join(os.tmpdir(), 'aipa-img-none'), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aipa-')),
    api, conf: { get: () => cfg, set: (c) => { cfg = c; } } });
  await s.start();
  assert.ok(s.http, s.error);
  const port = s.http.address().port;
  t.after(() => s.stop());
  const pair = async (ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)') => {
    const code = new URL(s.newPairCode().url).searchParams.get('c');
    const look = await req(port, `/pair?c=${code}`, { headers: { 'user-agent': ua } });
    assert.strictEqual(look.status, 200);
    assert.ok(!look.headers['set-cookie'], 'just opening the link pairs nothing');
    const r = await req(port, '/pair', { method: 'POST', headers: { 'user-agent': ua, 'content-type': 'application/x-www-form-urlencoded' }, body: `c=${code}` });
    assert.strictEqual(r.status, 303);
    return cookieOf(r);
  };
  const post = (code) => req(port, '/pair', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `c=${code}` });
  return { s, port, pair, post, saves, get cfg() { return cfg; } };
}

test('unpaired phones get the page’s own files but no data', async (t) => {
  const { port } = await setup(t);
  assert.strictEqual((await req(port, '/app/index.html')).status, 200, 'the page itself holds no data');
  assert.strictEqual((await req(port, '/api/load')).status, 401);
  assert.strictEqual((await req(port, '/api/load', { headers: { 'x-aipa-key': 'x'.repeat(43) } })).status, 401);
  assert.strictEqual((await req(port, '/images/a.jpg')).status, 401);
  assert.strictEqual((await req(port, `/i/${'y'.repeat(43)}/a.jpg`)).status, 401);
  assert.strictEqual((await req(port, `/api/events?k=${'z'.repeat(43)}`)).status, 401);
  assert.strictEqual((await req(port, '/ping')).status, 200, 'ping answers (for the .local check), with no data');
  assert.strictEqual((await req(port, '/pair?c=nope')).status, 403);
});

test('pairing gives a cookie that opens the page; the app keeps only a hash', async (t) => {
  const env = await setup(t);
  const cookie = await env.pair();
  assert.match(cookie, /^aipa_phone=[A-Za-z0-9_-]{40,}$/);
  const token = cookie.split('=')[1];
  assert.strictEqual(env.cfg.devices.length, 1);
  assert.strictEqual(env.cfg.devices[0].name, 'iPhone');
  assert.ok(!JSON.stringify(env.cfg).includes(token), 'token itself is not stored');
  const page = await req(env.port, '/app/index.html', { headers: { cookie } });
  assert.strictEqual(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  const load = JSON.parse((await req(env.port, '/api/load', { headers: { cookie } })).body);
  assert.strictEqual(load.rev, 7);
  assert.strictEqual(load.imagesBase, '/images/');
  assert.strictEqual((await req(env.port, '/s/054', { headers: { cookie } })).headers.location, '/app/index.html#spool=054');
});

test('a pairing code works once and expires; link previews do not use it up', async (t) => {
  const { s, port, post } = await setup(t);
  const code = new URL(s.newPairCode().url).searchParams.get('c');
  for (let i = 0; i < 3; i++) assert.strictEqual((await req(port, `/pair?c=${code}`)).status, 200, 'a preview just sees the button page');
  assert.strictEqual((await post(code)).status, 303);
  assert.strictEqual((await post(code)).status, 403);
  assert.strictEqual((await req(port, '/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { c: code } })).status, 403);
  const old = new URL(s.newPairCode().url).searchParams.get('c');
  s.codes.get(old).expires = Date.now() - 1;
  assert.strictEqual((await req(port, `/pair?c=${old}`)).status, 403);
});

test('too many wrong pairing codes are refused for a while', async (t) => {
  const { s, port } = await setup(t);
  for (let i = 0; i < 10; i++) await req(port, `/pair?c=wrong${i}`);
  const good = new URL(s.newPairCode().url).searchParams.get('c');
  assert.strictEqual((await req(port, `/pair?c=${good}`)).status, 429);
  assert.strictEqual((await req(port, '/pair', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `c=${good}` })).status, 429);
});

test('requests for another host name are refused (DNS rebinding)', async (t) => {
  const env = await setup(t);
  const cookie = await env.pair();
  assert.strictEqual((await req(env.port, '/api/load', { headers: { cookie }, host: 'evil.example:80' })).status, 421);
  assert.strictEqual((await req(env.port, '/api/load', { headers: { cookie }, host: `${os.hostname().toLowerCase()}.local:${env.port}` })).status, 200);
});

test('writes need the app’s header and JSON (no cross-site form posts); stale saves get 409', async (t) => {
  const env = await setup(t);
  const cookie = await env.pair();
  const body = { state: { v: 2 }, stock: { filaments: [] }, rev: 7 };
  assert.strictEqual((await req(env.port, '/api/save', { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body })).status, 403);
  assert.strictEqual((await req(env.port, '/api/save', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body })).status, 403);
  const ok = await req(env.port, '/api/save', { method: 'POST', headers: { cookie, ...JSONH }, body });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(JSON.parse(ok.body).rev, 8);
  const stale = await req(env.port, '/api/save', { method: 'POST', headers: { cookie, ...JSONH }, body: { ...body, rev: 1 } });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(JSON.parse(stale.body).code, 'STALE');
});

test('only the Filament screen’s own files are served', async (t) => {
  const env = await setup(t);
  const cookie = await env.pair();
  const get = (p) => req(env.port, p, { headers: { cookie } }).then(r => r.status);
  assert.strictEqual(await get('/app/inventory.js'), 200);
  assert.strictEqual(await get('/phone/phone-boot.js'), 200);
  assert.strictEqual(await get('/app/../../main.js'), 404);
  assert.strictEqual(await get('/app/%2e%2e/%2e%2e/main.js'), 404);
  assert.strictEqual(await get('/app/..%5c..%5cmain.js'), 404);
  assert.strictEqual(await get('/images/..%2f..%2fconfig.json'), 404);
  assert.strictEqual(await get('/main.js'), 404);
  assert.strictEqual(await get('/node_modules/koffi/index.js'), 404);
});

test('a removed phone is locked out; another address of the same phone pairs through a link code', async (t) => {
  const env = await setup(t);
  const cookie = await env.pair('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140');
  assert.strictEqual(env.cfg.devices[0].name, 'Android (Pixel 9)');
  const { code } = JSON.parse((await req(env.port, '/api/link-code', { method: 'POST', headers: { cookie, ...JSONH }, body: {} })).body);
  const r = await req(env.port, `/pair?c=${code}`);
  assert.strictEqual(r.status, 303, 'link codes (opened by the page itself) go straight through');
  assert.strictEqual(env.cfg.devices.length, 1, 'same phone, not a new one');
  assert.strictEqual(env.cfg.devices[0].hashes.length, 2);
  env.s.removeDevice(env.cfg.devices[0].id);
  assert.strictEqual((await req(env.port, '/api/load', { headers: { cookie } })).status, 401);
  assert.strictEqual((await req(env.port, '/api/load', { headers: { cookie: cookieOf(r) } })).status, 401);
});

test('live updates reach paired phones', async (t) => {
  const env = await setup(t);
  const cookie = await env.pair();
  const got = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: env.port, path: '/api/events', headers: { host: `127.0.0.1:${env.port}`, cookie } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; if (buf.includes('event: changed')) { res.destroy(); resolve(buf); } });
      setTimeout(() => env.s.broadcast('changed', { rev: 9 }), 50);
    });
    r.on('error', reject); r.end();
  });
  assert.match(got, /event: changed\ndata: \{"rev":9\}/);
});

test('device names from phone browsers', () => {
  assert.strictEqual(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)'), 'iPhone');
  assert.strictEqual(deviceName('Mozilla/5.0 (Linux; Android 10; K) Chrome'), 'Android phone');
  assert.strictEqual(deviceName(''), 'Phone');
});

test('the inventory refuses a save based on an older revision', async () => {
  const store = new FilamentStore(fs.mkdtempSync(path.join(os.tmpdir(), 'aipa-fil-')));
  const changes = [];
  store.onChange = (r) => changes.push(r);
  const data = { state: { v: 2, spools: {}, custom: [] }, stock: { filaments: [] } };
  const r0 = store.load().rev;
  const { rev: r1 } = await store.save({ ...data, rev: r0 });
  assert.strictEqual(r1, r0 + 1);
  assert.throws(() => store.save({ ...data, rev: r0 }), (e) => e.code === 'STALE');
  await store.save({ ...data, rev: r1 });
  assert.deepStrictEqual(changes, [r0 + 1, r0 + 2]);
});

const F = { brand: 'Polymaker', type: 'PLA', subtype: 'Matte', hex: '#E8E4DA', weight: 1000, nozzleMin: 190, nozzleMax: 230 };
const tagWith = (msg) => Buffer.concat([Buffer.from('041122334455667788990000E1103E00', 'hex'), msg, Buffer.alloc(400)]);

test('stickers get the spool link first, with the OpenSpool record still readable', () => {
  const msg = encodeTag('openspool', { ...F, link: 'http://mypc.local:8765/s/054' }, 496);
  const recs = parseNdef(tagWith(msg));
  assert.strictEqual(recs[0].type, 'U');
  assert.strictEqual(uriOf(recs[0].payload), 'http://mypc.local:8765/s/054');
  assert.strictEqual(decodeUltralight(tagWith(msg), Buffer.alloc(7)).decoder, 'openspool');
  assert.ok(!msg.linkOnly);
});

test('a sticker too small for the details gets the link alone', () => {
  const msg = encodeTag('openspool', { ...F, link: 'http://mypc.local:8765/s/054' }, 139);
  assert.ok(msg.linkOnly);
  assert.ok(msg.length <= 139);
  assert.strictEqual(uriOf(parseNdef(tagWith(msg))[0].payload), 'http://mypc.local:8765/s/054');
  assert.throws(() => encodeTag('openspool', F, 139), /NTAG215/, 'without a link it still says it’s too small');
});

test('other screens hear about a save only once it is on disk', async () => {
  const store = new FilamentStore(fs.mkdtempSync(path.join(os.tmpdir(), 'aipa-fil-')));
  const seen = [];
  store.onChange = (r) => seen.push({ r, onDisk: store.load().state && store.load().state.n });
  const r0 = store.load().rev;
  const p = store.save({ state: { v: 2, spools: {}, custom: [], n: 1 }, stock: { filaments: [] }, rev: r0 });
  assert.strictEqual(store.load().rev, r0, 'before the write finishes, load() still reports the old revision');
  await p;
  assert.deepStrictEqual(seen, [{ r: r0 + 1, onDisk: 1 }]);
  assert.strictEqual(store.load().rev, r0 + 1);
});

test('the key also reaches the page in the address fragment, and works without the cookie', async (t) => {
  const env = await setup(t);
  const code = new URL(env.s.newPairCode().url).searchParams.get('c');
  const r = await env.post(code);
  const key = /#k=([A-Za-z0-9_-]+)$/.exec(r.headers.location)[1];
  assert.strictEqual(cookieOf(r), `aipa_phone=${key}`);
  const load = await req(env.port, '/api/load', { headers: { 'x-aipa-key': key } });
  assert.strictEqual(load.status, 200);
  assert.strictEqual(JSON.parse(load.body).imagesBase, `/i/${key}/`, 'photos carry the key in their path');
  assert.strictEqual((await req(env.port, '/api/save', { method: 'POST', headers: { 'x-aipa-key': key, ...JSONH }, body: { state: { v: 2 }, stock: { filaments: [] }, rev: 7 } })).status, 200);
  assert.ok([401, 404].includes((await req(env.port, `/i/${key}/../../config.json`)).status), 'nothing outside the photos folder');
  assert.ok([401, 404].includes((await req(env.port, `/i/${key}/..%2f..%2fconfig.json`)).status));
});

test('labels link by address when a paired phone can’t find the PC by name', async (t) => {
  const env = await setup(t);
  await env.pair('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140');
  const ips = require('../src/phone/server').lanAddresses();
  if (!ips.length) return;   // no network on this machine
  assert.strictEqual(env.s.linkVia().via, 'name');
  env.cfg.devices[0].localOk = false;
  assert.deepStrictEqual(env.s.linkVia(), { via: 'ip', because: 'Android (Pixel 9)' });
  assert.match(env.s.linkBase(), /^http:\/\/\d+\.\d+\.\d+\.\d+:/);
});
