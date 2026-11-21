// The filament inventory built into the app (it began as a separate "Filament Inventory" web page).
// The Filament screen (renderer/filament/) edits it; this keeps it on disk in <userData>/filament/:
//   state.json    spools (status, grams left, location, history), filaments added by hand (with their photos),
//                 storage locations and settings: everything the screen edits
//   stock.json    what's on hand, written by the screen with every change; Color remix and the shopping check read it
//   catalog.json  { orders, prices }: the purchase history imported from the old page's data.js (none for new users)
//   images/       product photos for those imported orders (<asin>.jpg)
//   backups/      a copy of state.json per day for the last two weeks, plus one before every import
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const vm = require('vm');
const { resolveFolder } = require('./inventory');

const KEEP_DAILY = 14;
const PHOTO_EXT = /\.(jpe?g|png|webp|gif)$/i;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const day = () => new Date().toISOString().slice(0, 10);

// one line of a purchase, for telling sample orders apart from your own
const orderKey = (o) => JSON.stringify([o.asin, o.date, o.brand, o.line, o.grams, o.colors]);
class FilamentStore {
  constructor(userData) {
    this.dir = path.join(userData, 'filament');
    this.writing = Promise.resolve();   // saves run one after another, never interleaved
  }
  file(name) { return path.join(this.dir, name); }
  get imagesDir() { return this.file('images'); }
  get backupsDir() { return this.file('backups'); }

  readJson(name, fallback) {
    try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch { return fallback; }
  }
  // write to a temporary file, then swap it in, so a crash mid-write never leaves a half-written file
  async writeAtomic(name, text) {
    const target = this.file(name), tmp = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, text);
    await fsp.rename(tmp, target);
  }

  load() {
    const catalog = this.readJson('catalog.json', null) || {};
    return { catalog: { orders: Array.isArray(catalog.orders) ? catalog.orders : [], prices: catalog.prices || {} }, state: this.readJson('state.json', null) };
  }

  save({ state, stock }) {
    if (!state || state.v !== 2 || typeof state.spools !== 'object' || !Array.isArray(state.custom)) throw new Error('the inventory data looks damaged, so it wasn’t saved.');
    if (!stock || !Array.isArray(stock.filaments)) throw new Error('the on-hand list is missing.');
    const run = async () => {
      await fsp.mkdir(this.dir, { recursive: true });
      await this.dailyBackup();
      await this.writeAtomic('state.json', JSON.stringify(state));
      await this.writeAtomic('stock.json', JSON.stringify(stock, null, 1));
    };
    this.writing = this.writing.then(run, run);
    return this.writing;
  }

  // the first save of each day keeps the previous state as that day's backup
  async dailyBackup() {
    const cur = this.file('state.json');
    if (!fs.existsSync(cur)) return;
    await fsp.mkdir(this.backupsDir, { recursive: true });
    const target = path.join(this.backupsDir, `state-${day()}.json`);
    if (fs.existsSync(target)) return;
    await fsp.copyFile(cur, target);
    const daily = (await fsp.readdir(this.backupsDir)).filter(n => /^state-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
    for (const old of daily.slice(0, Math.max(0, daily.length - KEEP_DAILY))) await fsp.unlink(path.join(this.backupsDir, old)).catch(() => {});
  }

  // ---------- the sample library ----------
  // Empty: no spools, no filament of your own and no imported orders.
  isEmpty() {
    const { catalog, state } = this.load();
    return !catalog.orders.length && (!state || (!Object.keys(state.spools || {}).length && !(state.custom || []).length));
  }
  sampleStatus(sampleDir) {
    const available = fs.existsSync(path.join(sampleDir, 'catalog.json'));
    return { available, loaded: fs.existsSync(this.file('samples.json')), empty: this.isEmpty() };
  }
  // Copy the sample library in (only into an empty library) and remember what's sample, so it can be removed
  // later without touching anything added since.
  async loadSamples(sampleDir) {
    if (!fs.existsSync(path.join(sampleDir, 'catalog.json'))) throw new Error('this version has no sample library.');
    if (!this.isEmpty()) throw new Error('your filament library already has filament in it.');
    await this.writing;
    await fsp.mkdir(this.imagesDir, { recursive: true });
    const catalog = JSON.parse(await fsp.readFile(path.join(sampleDir, 'catalog.json'), 'utf8'));
    // the tour's placeholder shop links go nowhere: without them the screen links the public product page
    for (const o of catalog.orders || []) if (/^https?:\/\/demo\.invalid(\/|$)/i.test(o.url || '')) delete o.url;
    let state = null;
    try { state = JSON.parse(await fsp.readFile(path.join(sampleDir, 'state.json'), 'utf8')); } catch {}
    const images = fs.existsSync(path.join(sampleDir, 'images')) ? await fsp.readdir(path.join(sampleDir, 'images')) : [];
    for (const n of images) await fsp.copyFile(path.join(sampleDir, 'images', n), path.join(this.imagesDir, n));
    await this.writeAtomic('catalog.json', JSON.stringify(catalog));
    if (state) await this.writeAtomic('state.json', JSON.stringify(state)); else await fsp.unlink(this.file('state.json')).catch(() => {});
    await fsp.unlink(this.file('stock.json')).catch(() => {});   // the Filament screen writes it when it opens
    const spools = Object.values((state && state.spools) || {});
    await this.writeAtomic('samples.json', JSON.stringify({
      orders: (catalog.orders || []).map(orderKey), images,
      spoolIds: spools.map(s => s.id), fids: [...new Set(spools.map(s => s.fid))], customIds: ((state && state.custom) || []).map(c => c.id),
    }));
  }
  // Remove the sample filament: its orders, spools, filaments and photos. Anything added since stays.
  async clearSamples() {
    const marks = this.readJson('samples.json', null);
    if (!marks) return;
    await this.writing;
    const { catalog, state } = this.load();
    const sampleOrders = new Set(marks.orders || []), fids = new Set([...(marks.fids || []), ...(marks.customIds || [])]);
    const spoolIds = new Set(marks.spoolIds || []);
    // a copy of everything first, just in case
    await fsp.mkdir(this.backupsDir, { recursive: true });
    if (state) await fsp.writeFile(path.join(this.backupsDir, `state-before-removing-samples-${day()}.json`), JSON.stringify(state));
    const orders = catalog.orders.filter(o => !sampleOrders.has(orderKey(o)));
    await this.writeAtomic('catalog.json', JSON.stringify({ orders, prices: orders.length ? catalog.prices : {} }));
    let keep = null;
    if (state) {
      const spools = Object.fromEntries(Object.entries(state.spools || {}).filter(([id, s]) => !spoolIds.has(id) && !fids.has(s.fid)));
      const custom = (state.custom || []).filter(c => !fids.has(c.id));
      if (Object.keys(spools).length || custom.length) {
        const fil = Object.fromEntries(Object.entries(state.fil || {}).filter(([fid]) => !fids.has(fid)));
        keep = { ...state, spools, custom, fil, deletedSrc: [] };
      }
    }
    if (keep) {
      await this.writeAtomic('state.json', JSON.stringify(keep));
      // what's on hand, minus the samples (the Filament screen rewrites it in full when it opens)
      const stock = this.readJson('stock.json', null);
      if (stock && Array.isArray(stock.filaments)) {
        stock.filaments = stock.filaments.filter(f => !fids.has(f.id));
        stock.total = Object.keys(keep.spools).length;
        await this.writeAtomic('stock.json', JSON.stringify(stock, null, 1));
      }
    } else {
      // nothing of your own: back to a brand-new library (the Filament screen starts a fresh one)
      await fsp.unlink(this.file('state.json')).catch(() => {});
      await fsp.unlink(this.file('stock.json')).catch(() => {});
    }
    const still = keep ? JSON.stringify(keep) : '';
    for (const n of marks.images || []) if (!still.includes(n)) await fsp.unlink(path.join(this.imagesDir, n)).catch(() => {});
    await fsp.unlink(this.file('samples.json')).catch(() => {});
  }

  // What's on hand, in the shape Color remix and the shopping check use (the same as the old page's
  // print-advisor-stock.json). null until the inventory is in use: at least one spool tracked.
  stock() {
    const j = this.readJson('stock.json', null);
    if (!j || !Array.isArray(j.filaments) || !(j.total > 0)) return null;
    return { ok: true, builtin: true, onHand: true, updated: j.updated || null, filaments: j.filaments, total: j.total };
  }

  // ---------- importing the old Filament Inventory web page ----------
  // Its folder holds data.js (ORDERS: what was bought, PRICES) and images/ (a photo per product).
  readOldFolder(loc) {
    const dir = resolveFolder(loc);
    if (!dir) throw new Error('That folder wasn’t found.');
    const dataFile = path.join(dir, 'data.js');
    if (!fs.existsSync(dataFile)) throw new Error('That folder has no data.js. Choose the Filament Inventory folder (the one with index.html and data.js).');
    const ctx = vm.createContext({ console: { log() {}, warn() {} } });
    try {
      vm.runInContext(fs.readFileSync(dataFile, 'utf8') + '\n;this.__ORDERS = typeof ORDERS !== "undefined" ? ORDERS : null; this.__PRICES = typeof PRICES !== "undefined" ? PRICES : {};', ctx, { timeout: 2000 });
    } catch (e) { throw new Error(`Couldn’t read data.js: ${e.message}`); }
    if (!Array.isArray(ctx.__ORDERS)) throw new Error('data.js in that folder has no order list.');
    // plain copies (objects made inside the sandbox belong to another JavaScript world)
    const orders = JSON.parse(JSON.stringify(ctx.__ORDERS)), prices = JSON.parse(JSON.stringify(ctx.__PRICES || {}));
    const imgDir = path.join(dir, 'images');
    const photos = fs.existsSync(imgDir) ? fs.readdirSync(imgDir).filter(n => PHOTO_EXT.test(n)) : [];
    return { dir, orders, prices, photos, imgDir };
  }
  checkFolder(loc) {
    const r = this.readOldFolder(loc);
    return { path: r.dir, orders: r.orders.length, photos: r.photos.length };
  }
  // a backup downloaded from the old page: { app, version, exported, state } (or the state on its own)
  readBackup(file) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`Couldn’t read that backup: ${e.message}`); }
    const state = data && (data.state || data);
    if (!state || state.v !== 2 || typeof state.spools !== 'object') throw new Error('That file isn’t a Filament Inventory backup (Settings → Download backup in the old page).');
    if (!Array.isArray(state.custom)) state.custom = [];
    return { state, exported: data.exported || null };
  }
  checkBackup(file) {
    const { state, exported } = this.readBackup(file);
    return { path: file, name: path.basename(file), spools: Object.keys(state.spools).length, custom: state.custom.length, exported };
  }
  async importOld({ folder, backup }) {
    const src = this.readOldFolder(folder);
    const b = backup ? this.readBackup(backup) : null;
    await this.writing.catch(() => {});
    await fsp.mkdir(this.imagesDir, { recursive: true });
    await fsp.mkdir(this.backupsDir, { recursive: true });
    for (const name of ['state.json', 'catalog.json']) {
      if (fs.existsSync(this.file(name))) await fsp.copyFile(this.file(name), path.join(this.backupsDir, `before-import-${stamp()}-${name}`));
    }
    for (const name of src.photos) await fsp.copyFile(path.join(src.imgDir, name), path.join(this.imagesDir, name));
    await this.writeAtomic('catalog.json', JSON.stringify({ orders: src.orders, prices: src.prices, importedFrom: src.dir, imported: new Date().toISOString() }));
    // without a backup the screen starts over from the orders: one sealed (or on order) spool per spool bought
    if (b) await this.writeAtomic('state.json', JSON.stringify(b.state));
    else await fsp.unlink(this.file('state.json')).catch(() => {});
    // the screen reloads and writes the new on-hand list straight away
    await fsp.unlink(this.file('stock.json')).catch(() => {});
    return { orders: src.orders.length, photos: src.photos.length, spools: b ? Object.keys(b.state.spools).length : null };
  }
}

module.exports = { FilamentStore, PHOTO_EXT };
