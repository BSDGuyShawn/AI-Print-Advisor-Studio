// Updates from the project's GitHub releases, installed in place.
//
// check():   the newest published release, and the CHANGELOG sections newer than the running version.
// install(): download that release's zip into the app's own folder, check its SHA-256 against SHA256SUMS.txt (attached
//            by the release workflow once its ClamAV virus scan has finished: no checksum yet = not installed yet),
//            unpack it beside the running copy (app-update\), then hand over to a small script that waits for the
//            app to close, swaps the folders, and starts the program again.
// Settings, filament, history and API key live in the Windows user profile (%APPDATA%), not in the app folder, so
// an update never touches them. Nothing is sent to GitHub but plain requests for the public release information.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const UPDATE_SCRIPT = 'apply-update.cmd';   // the update hand-over script, next to the app
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'jtroberts83/AI-Print-Advisor-Studio';
const UA = { 'User-Agent': 'AI-3D-Print-Advisor-Studio-updater', Accept: 'application/vnd.github+json' };

const parts = (v) => String(v || '').replace(/^v/i, '').split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
function newer(a, b) { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; }

async function getJson(fetch, url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(r.status === 403 ? 'GitHub is limiting requests right now. Try again in an hour.' : `GitHub answered ${r.status}.`);
  return r.json();
}

// The CHANGELOG.md sections for versions after `current` (newest first): [{ version, text }]
function changesSince(changelog, current) {
  const out = [];
  let cur = null;
  for (const line of String(changelog).split(/\r?\n/)) {
    const h = /^##\s+v?(\d+\.\d+\.\d+)/.exec(line);
    if (h) { cur = newer(h[1], current) ? { version: h[1], text: '' } : null; if (cur) out.push(cur); continue; }
    if (cur) cur.text += line + '\n';
  }
  return out.map(s => ({ ...s, text: s.text.trim() }));
}

async function check({ fetch, current }) {
  const rel = await getJson(fetch, `https://api.github.com/repos/${REPO}/releases/latest`);
  const latest = String(rel.tag_name || '').replace(/^v/i, '');
  const zip = (rel.assets || []).find(a => /win-x64\.zip$/i.test(a.name) && !/demo/i.test(a.name));
  const sums = (rel.assets || []).find(a => /^SHA256SUMS/i.test(a.name));
  const info = { current, latest, available: !!latest && newer(latest, current), page: rel.html_url, publishedAt: rel.published_at,
    zip: zip ? { name: zip.name, url: zip.browser_download_url, size: zip.size } : null, sumsUrl: sums ? sums.browser_download_url : null, notes: [] };
  if (!info.available) return info;
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${rel.tag_name}/CHANGELOG.md`, { headers: { 'User-Agent': UA['User-Agent'] } });
    if (r.ok) info.notes = changesSince(await r.text(), current);
  } catch {}
  if (!info.notes.length && rel.body) info.notes = [{ version: latest, text: String(rel.body).trim() }];
  return info;
}

// Where this copy lives: <folder>\<program>.exe (the launcher) and <folder>\app\ (Electron). null when it isn't
// laid out like a release (running from source, or an old-style folder): then updates are downloaded by hand.
function installLayout(execPath, title) {
  const appDir = path.dirname(execPath);
  if (path.basename(appDir).toLowerCase() !== 'app') return null;
  const root = path.dirname(appDir);
  const launcher = path.join(root, `${title}.exe`);
  if (!fs.existsSync(launcher)) return null;
  return { root, appDir, launcher };
}

async function download(fetch, url, dest, onProgress) {
  const r = await fetch(url, { headers: { 'User-Agent': UA['User-Agent'] } });
  if (!r.ok || !r.body) throw new Error(`The download failed (${r.status}).`);
  const total = +r.headers.get('content-length') || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  let got = 0;
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value); got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise(res => out.once('drain', res));
      if (onProgress) onProgress(total ? got / total : 0);
    }
  } finally { await new Promise(res => out.end(res)); }
  return hash.digest('hex');
}

async function install({ fetch, info, execPath, title, pid, onProgress }) {
  const L = installLayout(execPath, title);
  if (!L) throw new Error('This copy isn’t in a release folder, so it can’t update itself. Download the new version from the release page.');
  if (!info || !info.zip) throw new Error('The new release has no Windows download yet. Try again in a few minutes.');
  if (!info.sumsUrl) throw new Error('The new release is still being virus-scanned on GitHub (it takes a few minutes after publishing). Try again shortly.');
  // write access to the folder (e.g. not under Program Files)
  const probe = path.join(L.root, '.update-write-test');
  try { await fsp.writeFile(probe, 'ok'); await fsp.unlink(probe); }
  catch { throw new Error(`The app can’t write to its folder (${L.root}), so it can’t update itself. Move the folder somewhere you own (e.g. Documents), or download the new version by hand.`); }

  const sumsText = await (await fetch(info.sumsUrl, { headers: { 'User-Agent': UA['User-Agent'] } })).text();
  const want = (sumsText.split(/\r?\n/).map(l => /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(l.trim())).find(m => m && m[2].trim() === info.zip.name) || [])[1];
  if (!want) throw new Error('The release’s checksum list doesn’t include the download, so it wasn’t installed.');

  const zipPath = path.join(L.root, 'update-download.zip');
  const got = await download(fetch, info.zip.url, zipPath, p => onProgress && onProgress('download', p));
  if (got.toLowerCase() !== want.toLowerCase()) { await fsp.rm(zipPath, { force: true }); throw new Error('The download didn’t match the release’s checksum, so it wasn’t installed. Try again.'); }

  // unpack: app\ → app-update\, the program → <program>.exe.new, everything else (cheat sheets…) → update-extra\
  onProgress && onProgress('unpack', 0);
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(await fsp.readFile(zipPath));
  const stage = path.join(L.root, 'app-update'), extra = path.join(L.root, 'update-extra');
  await fsp.rm(stage, { recursive: true, force: true }); await fsp.rm(extra, { recursive: true, force: true });
  const files = Object.values(zip.files).filter(f => !f.dir);
  // a zip with one wrapper folder (older releases) is read from inside it
  const top = new Set(files.map(f => f.name.split('/')[0]));
  const strip = top.size === 1 && !files.some(f => !f.name.includes('/')) ? [...top][0] + '/' : '';
  let n = 0, hasApp = false, newLauncher = null;
  for (const f of files) {
    const rel = f.name.slice(strip.length);
    if (!rel || rel.split('/').some(s => s === '..' || s === '') || path.isAbsolute(rel)) continue;
    let dest;
    if (rel.startsWith('app/')) { dest = path.join(stage, ...rel.slice(4).split('/')); hasApp = true; }
    else if (!rel.includes('/') && /\.exe$/i.test(rel)) { dest = path.join(L.root, `${title}.exe.new`); newLauncher = dest; }
    else dest = path.join(extra, ...rel.split('/'));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, await f.async('nodebuffer'));
    if (++n % 50 === 0 && onProgress) onProgress('unpack', n / files.length);
  }
  await fsp.rm(zipPath, { force: true });
  if (!hasApp || !fs.existsSync(path.join(stage, path.basename(execPath)))) throw new Error('The download doesn’t look like this app, so it wasn’t installed.');

  // the hand-over script: wait for this app to close, swap the folders, start the program again
  const q = (p) => `"${p}"`;
  const exeName = `${title}.exe`;
  const script = [
    '@echo off', 'setlocal',
    `cd /d ${q(L.root)}`,
    // Windows can't rename the app folder while the app (pid ${pid}) still runs from it, so trying is the wait:
    // retry for up to about 2 minutes, and if it never frees, start the old copy again. (No pipes here: a pipe in a
    // script without a console window can hang.)
    'if exist app-old rmdir /s /q app-old',
    'ping -n 3 127.0.0.1 >nul',
    'set /a tries=0',
    ':swap',
    'move app app-old >nul 2>&1',
    'if not exist app goto swapped',
    'set /a tries+=1',
    `if %tries% geq 60 ( start "" ${q(exeName)} & exit /b 1 )`,
    'ping -n 2 127.0.0.1 >nul',
    'goto swap',
    ':swapped',
    'move app-update app >nul',
    'if not exist app move app-old app >nul',
    `if exist ${q(exeName + '.new')} move /y ${q(exeName + '.new')} ${q(exeName)} >nul`,
    'if exist update-extra ( xcopy update-extra . /e /i /y /q >nul & rmdir /s /q update-extra )',
    `start "" ${q(exeName)}`,
    'rmdir /s /q app-old',
    '(goto) 2>nul & del "%~f0"',
  ].join('\r\n');
  const bat = path.join(L.root, UPDATE_SCRIPT);
  await fsp.writeFile(bat, script, 'utf8');
  return { bat, root: L.root, newLauncher };
}

// The hand-over script is run by its fixed name from its own folder, so no path ends up in the command line.
function runHandOver(bat) {
  if (path.basename(bat) !== UPDATE_SCRIPT) throw new Error('unexpected update script');
  // ".\" so cmd runs the one in this folder even where NoDefaultCurrentDirectoryInExePath is set
  const child = spawn('cmd.exe', ['/d', '/c', '.\\' + UPDATE_SCRIPT], { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(bat) });
  child.unref();
}

module.exports = { check, install, runHandOver, installLayout, newer, changesSince, REPO };
