// Loads the saved inventory from the app, then starts inventory.js with it (window.__FIL).
// This page runs inside the main window (an iframe from the same app:// origin), so it uses the main window's
// bridge to the app: window.parent.advisor.
(async () => {
  const fail = (msg) => {
    document.querySelector('main').innerHTML = `<div class="empty" style="padding:60px 20px">Couldn’t load your filament: ${String(msg).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}<br><br><button class="btn" id="retry">Try again</button></div>`;
    document.getElementById('retry').addEventListener('click', () => location.reload());
  };
  try {
    if (!window.parent || !window.parent.advisor) throw new Error('open this screen from the app.');
    window.__FIL = await window.parent.advisor.filamentLoad();
  } catch (e) { return fail(e.message || e); }
  const s = document.createElement('script');
  s.src = 'inventory.js';
  document.body.appendChild(s);
})();
