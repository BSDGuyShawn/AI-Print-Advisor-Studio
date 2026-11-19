// One-time import of the old Filament Inventory web page into the app's Filament screen (not part of the app's UI).
// Run with the app's own Electron as Node, while the app is closed:
//
//   set ELECTRON_RUN_AS_NODE=1
//   "AI 3D Print Advisor Studio.exe" tools\import_filament_inventory.js <inventory folder> [backup.json] [data folder]
//
// <inventory folder>  the folder with the old page's index.html, data.js and images\
// [backup.json]       the old page's Settings > Download backup (spool statuses, weights, locations live there)
// [data folder]       default: %APPDATA%\AI 3D Print Advisor Studio
// A copy of anything replaced is kept in <data folder>\filament\backups. Open the Filament screen once afterwards:
// it writes what's on hand for Color remix.
const path = require('path');
const { FilamentStore } = require('../src/filament');

(async () => {
  const [folder, backup, dataDir] = process.argv.slice(2);
  if (!folder) { console.log('Usage: import_filament_inventory.js <inventory folder> [backup.json] [data folder]'); process.exit(1); }
  const userData = dataDir || path.join(process.env.APPDATA, 'AI 3D Print Advisor Studio');
  const r = await new FilamentStore(userData).importOld({ folder, backup: backup || null });
  console.log(`Imported ${r.orders} order lines, ${r.photos} photos${r.spools == null ? ' (no backup: every spool starts sealed)' : `, ${r.spools} spools`} into ${userData}`);
})().catch(e => { console.error('Import failed:', e.message); process.exit(1); });
