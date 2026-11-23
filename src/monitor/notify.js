// Print Monitor alerts: Windows notifications, ntfy (phone push), email. Ported from U1 Studio
// (backend/u1studio/notify.py) plus the Home Assistant automations print_finished.yaml and progress_emails.yaml.
// The settings come from Settings → Print monitor; secrets (ntfy token, mail password) are decrypted by main.js.
const fs = require('fs');
const path = require('path');
const smtp = require('./smtp');

const TAGS = { start: 'printer', complete: 'checkered_flag', ready: 'white_check_mark', error: 'rotating_light',
  paused: 'pause_button', cancelled: 'x', snapshot: 'camera', progress: 'hourglass_flowing_sand', test: 'bell' };
const ascii = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

class Notifier {
  // getCfg(): the notifications part of the monitor settings (with secrets decrypted)
  // desktop(title, body, imagePath): shows a Windows notification (Electron's Notification in main.js)
  constructor({ getCfg, desktop, log = () => {}, fetchFn = fetch, sendMail = smtp.send }) {
    Object.assign(this, { getCfg, desktop, log, fetchFn, sendMail });
    this.history = [];
    this.listeners = new Set();
  }
  onItem(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // event: start/paused/error/cancelled/complete/ready/snapshot/progress/test
  async send({ event, printer, title, message, imagePath = null, priority = 'default', email = null, force = false }) {
    const cfg = this.getCfg() || {};
    const item = { ts: Date.now(), event, printer, title, message, image: imagePath ? path.basename(imagePath) : null, results: {} };
    this.history.unshift(item); this.history.length = Math.min(this.history.length, 50);
    // progress emails (1/25/50/75 %) go by email only, when that's switched on; the other alerts follow each channel's events
    const only = event === 'progress' ? 'email' : null;
    const on = (ch) => force || (ch.events || {})[event];
    const jobs = [];
    if (!only && cfg.desktop && cfg.desktop.enabled && on(cfg.desktop)) jobs.push(['Windows', async () => this.desktop(title, message, imagePath && fs.existsSync(imagePath) ? imagePath : null)]);
    const n = cfg.ntfy || {};
    if (!only && n.enabled && n.topic && on(n)) jobs.push(['ntfy', () => this.ntfy(n, event, title, message, imagePath, priority)]);
    const m = cfg.email || {};
    if (m.enabled && m.host && m.to && (only || force || on(m))) jobs.push(['email', () => this.email(m, email || this.simpleEmail(title, message, imagePath))]);
    if (only && !jobs.length) { this.history.shift(); return item; }   // a progress email with email off: nothing to say
    for (const [name, fn] of jobs) {
      try { await fn(); item.results[name] = 'ok'; }
      catch (e) { item.results[name] = `failed: ${e.message || e}`; this.log(`print monitor: ${name} alert failed: ${e.message || e}`); }
    }
    for (const l of this.listeners) { try { l(item); } catch {} }
    return item;
  }

  async ntfy(n, event, title, message, imagePath, priority) {
    const url = String(n.server || 'https://ntfy.sh').replace(/\/+$/, '') + '/' + String(n.topic).replace(/^\/+|\/+$/g, '');
    if (!/^https?:\/\//i.test(url)) throw new Error('the ntfy server address must start with https://');
    const headers = { Title: ascii(title), Tags: TAGS[event] || 'printer', Priority: priority === 'high' ? 'high' : 'default' };
    if (n.token) headers.Authorization = `Bearer ${n.token}`;
    let r;
    if (imagePath && fs.existsSync(imagePath)) {
      headers.Message = ascii(message);
      headers.Filename = path.basename(imagePath);
      r = await this.fetchFn(url, { method: 'PUT', body: await fs.promises.readFile(imagePath), headers, signal: AbortSignal.timeout(30000) });
    } else r = await this.fetchFn(url, { method: 'POST', body: Buffer.from(message, 'utf8'), headers, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  }

  simpleEmail(title, message, imagePath) {
    const img = imagePath && fs.existsSync(imagePath) ? [{ cid: 'photo', name: path.basename(imagePath), file: imagePath }] : [];
    return { subject: title, text: message,
      html: `<div style="font:15px/1.5 Segoe UI,Arial,sans-serif;color:#18232E"><h2 style="margin:0 0 8px">${esc(title)}</h2><p>${esc(message)}</p>${img.length ? '<img src="cid:photo" style="max-width:640px;width:100%;border-radius:10px">' : ''}<p style="color:#7a8794;font-size:12px">From AI 3D Print Advisor Studio’s Print Monitor.</p></div>`,
      images: img };
  }
  async email(m, msg) {
    const images = [];
    for (const im of msg.images || []) {
      try { images.push({ cid: im.cid, name: im.name, data: im.data || await fs.promises.readFile(im.file) }); } catch { /* photo gone */ }
    }
    await this.sendMail(m, { ...msg, images });
  }
}

module.exports = { Notifier, esc };
