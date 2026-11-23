// Certificates for the phone page's optional HTTPS address (Settings → Phone access → secure address).
// Phones only allow camera scanning and (Android) web NFC on HTTPS pages, and a home network has no public name to
// get a real certificate for. So the app makes its own small certificate authority (kept in its data folder, made
// once), which each phone trusts once, and a server certificate signed by it for the PC's name and addresses (remade
// by itself when those change; the phone doesn't need to do anything again).
//
// Node has no API to create certificates, so the X.509 structure is built here (DER) and signed with Node's crypto.
// Checked with crypto.X509Certificate in test/phone.test.js.
'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------- DER
const len = (n) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const int = (buf) => { let b = Buffer.from(buf); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return tlv(0x02, b); };
const smallInt = (n) => int(Buffer.from([n]));
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xFF : 0]));
const octets = (b) => tlv(0x04, b);
const bits = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const utf8 = (s) => tlv(0x0C, Buffer.from(s, 'utf8'));
const ctx = (n, body, constructed = true) => tlv((constructed ? 0xA0 : 0x80) | n, body);
function oid(str) {
  const p = str.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const bytes = [v & 0x7F];
    for (let x = v >>> 7; x; x >>>= 7) bytes.unshift((x & 0x7F) | 0x80);
    out.push(...bytes);
  }
  return tlv(0x06, Buffer.from(out));
}
function time(d) {   // UTCTime until 2049, GeneralizedTime after
  const z = (n, w = 2) => String(n).padStart(w, '0');
  const y = d.getUTCFullYear();
  const body = `${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`;
  return y < 2050 ? tlv(0x17, Buffer.from(z(y % 100) + body)) : tlv(0x18, Buffer.from(z(y, 4) + body));
}
const OID = { sha256rsa: '1.2.840.113549.1.1.11', cn: '2.5.4.3', org: '2.5.4.10', basic: '2.5.29.19', keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37', san: '2.5.29.17', ski: '2.5.29.14', aki: '2.5.29.35', serverAuth: '1.3.6.1.5.5.7.3.1' };
const algo = seq(oid(OID.sha256rsa), tlv(0x05, Buffer.alloc(0)));
const name = (cn) => seq(set(seq(oid(OID.org), utf8('AI 3D Print Advisor Studio'))), set(seq(oid(OID.cn), utf8(cn))));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
const keyId = (spki) => crypto.createHash('sha1').update(spki).digest();

function build({ subject, issuer, spki, signKey, days, extensions }) {
  const now = Date.now();
  const tbs = seq(
    ctx(0, smallInt(2)),                                   // v3
    int(Buffer.concat([Buffer.from([0x01]), crypto.randomBytes(15)])),   // positive serial
    algo, issuer,
    seq(time(new Date(now - 24 * 3600e3)), time(new Date(now + days * 24 * 3600e3))),
    subject, spki,
    ctx(3, seq(...extensions)),
  );
  const sig = crypto.sign('sha256', tbs, signKey);
  const der = seq(tbs, algo, bits(sig));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}
const spkiOf = (pub) => pub.export({ type: 'spki', format: 'der' });

// A certificate authority for this PC (10 years). { certPem, keyPem }
function makeCA(pcName) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = spkiOf(publicKey);
  const subject = name(`AI 3D Print Advisor Studio on ${pcName}`);
  const certPem = build({ subject, issuer: subject, spki, signKey: privateKey, days: 3650, extensions: [
    ext(OID.basic, true, seq(bool(true))),
    ext(OID.keyUsage, true, bits(Buffer.from([0x06]))),   // keyCertSign, cRLSign
    ext(OID.ski, false, octets(keyId(spki))),
  ] });
  return { certPem, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

// A server certificate for the PC's name(s) and addresses, signed by the CA (800 days: under Apple's 825-day limit)
function makeServerCert(ca, { dnsNames, ips }) {
  const caKey = crypto.createPrivateKey(ca.keyPem);
  const caCert = new crypto.X509Certificate(ca.certPem);
  const caSpki = spkiOf(caCert.publicKey);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = spkiOf(publicKey);
  const alt = [...dnsNames.map(d => ctx(2, Buffer.from(d, 'ascii'), false)),
    ...ips.map(ip => ctx(7, Buffer.from(ip.split('.').map(Number)), false))];
  const issuer = caSubjectDer(ca.certPem);
  const certPem = build({ subject: name(dnsNames[0] || ips[0] || 'localhost'), issuer, spki, signKey: caKey, days: 800, extensions: [
    ext(OID.basic, true, seq()),
    ext(OID.keyUsage, true, bits(Buffer.from([0xA0]))),   // digitalSignature, keyEncipherment
    ext(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
    ext(OID.san, false, seq(...alt)),
    ext(OID.ski, false, octets(keyId(spki))),
    ext(OID.aki, false, seq(ctx(0, keyId(caSpki), false))),
  ] });
  return { certPem, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

// The CA's subject name exactly as encoded in its certificate (the issuer of server certificates must match byte for byte)
function caSubjectDer(caPem) {
  const der = new crypto.X509Certificate(caPem).raw;
  // Certificate ::= SEQ { tbs SEQ { [0] version, serial, sigAlg, issuer, validity, subject, ... } }
  const read = (buf, pos) => {
    const tag = buf[pos]; let l = buf[pos + 1], hdr = 2;
    if (l & 0x80) { const n = l & 0x7F; l = 0; for (let i = 0; i < n; i++) l = (l << 8) | buf[pos + 2 + i]; hdr = 2 + n; }
    return { tag, start: pos, body: pos + hdr, end: pos + hdr + l };
  };
  const cert = read(der, 0), tbs = read(der, cert.body);
  let p = tbs.body;
  const items = [];
  while (p < tbs.end && items.length < 6) { const it = read(der, p); items.push(it); p = it.end; }
  const subject = items[0].tag === 0xA0 ? items[5] : items[4];
  return der.subarray(subject.start, subject.end);
}

// Does the server certificate still cover these names/addresses and have a month left?
function serverCertFits(certPem, { dnsNames, ips }) {
  try {
    const c = new crypto.X509Certificate(certPem);
    if (new Date(c.validTo) - Date.now() < 30 * 24 * 3600e3) return false;
    const san = c.subjectAltName || '';
    return dnsNames.every(d => san.includes(`DNS:${d}`)) && ips.every(ip => san.includes(`IP Address:${ip}`));
  } catch { return false; }
}

module.exports = { makeCA, makeServerCert, serverCertFits };
