// Finds Moonraker printers (Snapmaker U1 and other Klipper printers) on the local network by asking every
// address in this computer's own subnet(s) for Moonraker's /server/info, on its own port (7125) and through
// the web interface (port 80). Each find is then asked for its name and whether it's a U1.
const os = require('os');

function privateIPv4(addr) {
  const [a, b] = addr.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// every host in the /24 around each of this computer's private addresses (254 per network)
function hostsToScan() {
  if (process.env.U1_DISCOVER_HOSTS) return process.env.U1_DISCOVER_HOSTS.split(',').map(s => s.trim()).filter(Boolean); // tests
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || !privateIPv4(i.address)) continue;
      const base = i.address.split('.').slice(0, 3).join('.');
      for (let h = 1; h < 255; h++) if (`${base}.${h}` !== i.address) out.add(`${base}.${h}`);
    }
  }
  return [...out];
}

async function getJson(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

// one candidate: "192.168.1.50" (tries :7125 then :80) or an explicit "host:port"
async function probe(host, ms) {
  const bases = /:\d+$/.test(host) ? [`http://${host}`] : [`http://${host}:7125`, `http://${host}`];
  for (const base of bases) {
    const info = await getJson(`${base}/server/info`, ms);
    if (!info || !info.result || !('klippy_state' in info.result || 'moonraker_version' in info.result)) continue;
    const [pinfo, objs] = await Promise.all([getJson(`${base}/printer/info`, 2500), getJson(`${base}/printer/objects/list`, 2500)]);
    const objects = (objs && objs.result && objs.result.objects) || [];
    const isU1 = objects.includes('print_task_config');
    const hostname = (pinfo && pinfo.result && pinfo.result.hostname) || '';
    return { url: base.replace(/^http:\/\//, '').replace(/:80$/, ''), host, hostname, isU1, kind: isU1 ? 'Snapmaker U1' : 'Klipper printer', state: info.result.klippy_state || '' };
  }
  return null;
}

async function discoverPrinters({ onProgress, timeoutMs = 900, concurrency = 64 } = {}) {
  const hosts = hostsToScan();
  const found = [];
  let next = 0, done = 0;
  async function worker() {
    while (next < hosts.length) {
      const h = hosts[next++];
      const r = await probe(h, timeoutMs);
      if (r && !found.some(f => f.host === r.host)) found.push(r);
      done++;
      if (onProgress && (done % 16 === 0 || done === hosts.length)) onProgress(done, hosts.length, found.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

module.exports = { discoverPrinters, hostsToScan, probe };
