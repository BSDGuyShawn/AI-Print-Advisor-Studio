// A small SMTP client for the Print Monitor's emails (no library): implicit TLS (port 465) or STARTTLS (587/25),
// AUTH PLAIN / LOGIN, one message with an HTML body and inline JPEG pictures.
// Works with Gmail / Outlook / iCloud app passwords and most mail providers' SMTP servers.
const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');

function b64lines(buf) { return buf.toString('base64').replace(/.{1,76}/g, '$&\r\n'); }
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const addr = (s) => String(s || '').trim();

// { from, to: [..], subject, html, text, images: [{ cid, name, data: Buffer }] } -> RFC 5322 message
function buildMessage({ from, to, subject, html, text, images = [] }) {
  const b1 = `aipa-${crypto.randomBytes(8).toString('hex')}`, b2 = `aipa-${crypto.randomBytes(8).toString('hex')}`;
  const lines = [
    `From: ${encWord('AI 3D Print Advisor Studio')} <${addr(from)}>`,
    `To: ${to.map(addr).join(', ')}`,
    `Subject: ${encWord(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${(addr(from).split('@')[1] || 'localhost')}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${b1}"`,
    '',
    `--${b1}`,
    `Content-Type: multipart/alternative; boundary="${b2}"`,
    '',
    `--${b2}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64lines(Buffer.from(text || '', 'utf8')),
    `--${b2}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64lines(Buffer.from(html || '', 'utf8')),
    `--${b2}--`,
  ];
  for (const im of images) {
    lines.push(`--${b1}`, `Content-Type: image/jpeg; name="${im.name}"`, 'Content-Transfer-Encoding: base64',
      `Content-ID: <${im.cid}>`, `Content-Disposition: inline; filename="${im.name}"`, '', b64lines(im.data));
  }
  lines.push(`--${b1}--`, '');
  return lines.join('\r\n');
}

// cfg: { host, port, security: 'tls' | 'starttls' | 'none', user, pass, from, to }
function send(cfg, msg, { timeout = 30000 } = {}) {
  const port = Number(cfg.port) || (cfg.security === 'tls' ? 465 : 587);
  const to = String(cfg.to || '').split(/[,;\s]+/).filter(Boolean);
  if (!cfg.host || !to.length) return Promise.reject(new Error('Set the mail server and who to send to.'));
  const from = cfg.from || cfg.user;
  const data = buildMessage({ ...msg, from, to });
  return new Promise((resolve, reject) => {
    let sock, buf = '', waiting = null, finished = false;
    const fail = (e) => { if (finished) return; finished = true; try { sock.destroy(); } catch {} reject(e instanceof Error ? e : new Error(String(e))); };
    const timer = setTimeout(() => fail(new Error('The mail server didn’t answer in time.')), timeout);
    const onData = (d) => {
      buf += d.toString('utf8');
      // a reply is complete when a line has "NNN " (space, not dash)
      const m = buf.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/);
      if (!m || !waiting) return;
      const reply = buf; buf = '';
      const w = waiting; waiting = null;
      w(+m[1], reply);
    };
    const expect = (codes) => new Promise((res, rej) => {
      waiting = (code, reply) => (codes.includes(code) ? res(reply) : rej(new Error(`Mail server: ${reply.trim().split('\r\n').pop()}`)));
    });
    const cmd = (line, codes) => { const p = expect(codes); sock.write(line + '\r\n'); return p; };
    const attach = (s) => { sock = s; s.on('data', onData); s.on('error', fail); s.on('close', () => fail(new Error('The mail server closed the connection.'))); };
    const run = async () => {
      const name = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
      let ehlo = await cmd(`EHLO ${name}`, [250]);
      if (cfg.security === 'starttls') {
        if (!/STARTTLS/i.test(ehlo)) throw new Error('This mail server doesn’t offer STARTTLS on that port. Try port 465 with SSL/TLS.');
        await cmd('STARTTLS', [220]);
        const plain = sock;
        plain.removeAllListeners('data'); plain.removeAllListeners('close'); plain.removeAllListeners('error');
        await new Promise((res, rej) => { const t = tls.connect({ socket: plain, servername: cfg.host }, res); t.on('error', rej); attach(t); });
        ehlo = await cmd(`EHLO ${name}`, [250]);
      }
      if (cfg.user) {
        if (/AUTH[ =][^\r\n]*PLAIN/i.test(ehlo)) await cmd(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass || ''}`).toString('base64')}`, [235]);
        else {
          await cmd('AUTH LOGIN', [334]);
          await cmd(Buffer.from(cfg.user).toString('base64'), [334]);
          await cmd(Buffer.from(cfg.pass || '').toString('base64'), [235]);
        }
      }
      await cmd(`MAIL FROM:<${addr(from)}>`, [250]);
      for (const t of to) await cmd(`RCPT TO:<${t}>`, [250, 251]);
      await cmd('DATA', [354]);
      await cmd(data.replace(/\r\n\./g, '\r\n..') + '\r\n.', [250]);
      await cmd('QUIT', [221]).catch(() => {});
      finished = true; clearTimeout(timer); try { sock.end(); } catch {}
      resolve({ ok: true });
    };
    const greeting = expect([220]);
    const onConnect = () => greeting.then(run).catch(e => { clearTimeout(timer); fail(/535|auth/i.test(e.message) ? new Error(`The mail server didn’t accept the user name or password (for Gmail, use an app password). ${e.message}`) : e); });
    if (cfg.security === 'tls') attach(tls.connect({ host: cfg.host, port, servername: cfg.host }, onConnect));
    else attach(net.connect({ host: cfg.host, port }, onConnect));
  });
}

module.exports = { send, buildMessage };
