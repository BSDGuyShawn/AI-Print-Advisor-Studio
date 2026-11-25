// Loads the saved inventory from the app, then starts inventory.js with it (window.__FIL).
// In the app this page runs inside the main window (an iframe from the same app:// origin), so it uses the main
// window's bridge to the app: window.parent.advisor. On a phone (Settings → Phone access) it's opened over the
// home network from the app's own server, and renderer/phone/phone-boot.js provides the same calls (window.advisor).
(async () => {
  const fail = (msg) => {
    document.querySelector('main').innerHTML = `<div class="empty" style="padding:60px 20px">Couldn’t load your filament: ${String(msg).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}<br><br><button class="btn" id="retry">Try again</button></div>`;
    document.getElementById('retry').addEventListener('click', () => location.reload());
  };
  const script = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`couldn’t load ${src}`));
    document.body.appendChild(s);
  });
  const inApp = window.parent !== window && window.parent.advisor;
  const phone = !inApp && /^https?:$/.test(location.protocol);
  try {
    if (phone) await script('/phone/phone-boot.js');
    const api = inApp ? window.parent.advisor : window.advisor;
    if (!api) throw new Error('open this screen from the app.');
    window.__FIL = await api.filamentLoad();
  } catch (e) {
    fail(e.message || e);
    if (e.others) document.querySelector('main .empty').insertAdjacentHTML('beforeend', `<p style="margin-top:14px">Paired this phone already? It may be on another address of your PC: ${e.others}</p>`);
    return;
  }
  try {
    await script('gaps.js');
    await script('inventory.js');
    if (phone) await script('/phone/phone-ui.js');
  } catch (e) { fail(e.message || e); }
})();
