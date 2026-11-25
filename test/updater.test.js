// The update check goes straight to the newest release, never to the one after the running version.
const test = require('node:test');
const assert = require('node:assert');
const U = require('../src/updater');

const rel = (v, extra = {}) => ({ tag_name: `v${v}`, html_url: `https://example.invalid/${v}`, draft: false, prerelease: false,
  assets: [{ name: `AI-3D-Print-Advisor-Studio-${v}-win-x64.zip`, browser_download_url: `https://example.invalid/${v}.zip`, size: 1 },
    { name: 'SHA256SUMS.txt', browser_download_url: `https://example.invalid/${v}.sums` }], ...extra });
const fakeFetch = (list, latest) => async (url) => {
  const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (url.includes('/releases?')) return list instanceof Error ? { ok: false, status: 500 } : json(list);
  if (url.endsWith('/releases/latest')) return json(latest);
  if (url.endsWith('CHANGELOG.md')) return { ok: true, text: async () => '## 2.37.4\n- d\n## 2.37.3\n- c\n## 2.37.2\n- b\n## 2.37.1\n- a\n' };
  throw new Error('unexpected ' + url);
};

test('picks the highest version, not the next one', async () => {
  const list = [rel('2.37.2'), rel('2.37.4'), rel('2.37.3'), rel('2.38.0', { prerelease: true }), rel('2.39.0', { draft: true })];
  const info = await U.check({ fetch: fakeFetch(list, rel('2.37.3')), current: '2.37.1' });
  assert.strictEqual(info.latest, '2.37.4');
  assert.strictEqual(info.available, true);
  assert.match(info.zip.url, /2\.37\.4\.zip$/);
  assert.deepStrictEqual(info.notes.map(n => n.version), ['2.37.4', '2.37.3', '2.37.2']);
});

test("GitHub's latest wins when it is newer than the list", async () => {
  const info = await U.check({ fetch: fakeFetch([rel('2.37.2')], rel('2.37.4')), current: '2.30.0' });
  assert.strictEqual(info.latest, '2.37.4');
});

test('falls back to latest when the list fails', async () => {
  const info = await U.check({ fetch: fakeFetch(new Error('x'), rel('2.37.4')), current: '2.37.4' });
  assert.strictEqual(info.latest, '2.37.4');
  assert.strictEqual(info.available, false);
});
