// NDEF: the standard way NFC stickers (NTAG213/215/216) store records. Open spool formats (OpenSpool, OpenTag3D,
// SpoolEase) are NDEF records; this reads them out of a tag's memory and builds them for writing.
//
// The parser follows OpenRFID's (GPL-3.0, itself adapted from paxx12's Snapmaker U1 Extended Firmware) so the
// same tags decode the same way. No Electron imports: tested with plain Node (test/nfc-decoders.test.js).
'use strict';

const URI_PREFIXES = ['', 'http://www.', 'https://www.', 'http://', 'https://', 'tel:', 'mailto:', 'ftp://anonymous:anonymous@',
  'ftp://ftp.', 'ftps://', 'sftp://', 'smb://', 'nfs://', 'ftp://', 'dav://', 'news:', 'telnet://', 'imap:', 'rtsp://', 'urn:',
  'pop:', 'sip:', 'sips:', 'tftp:', 'btspp://', 'btl2cap://', 'btgoep://', 'tcpobex://', 'irdaobex://', 'file://', 'urn:epc:id:',
  'urn:epc:tag:', 'urn:epc:pat:', 'urn:epc:raw:', 'urn:epc:', 'urn:nfc:'];

// Records from a tag's memory (starting at page 0, or at the capability container). [] when there are none.
// Each record: { tnf, type, payload } (MIME records: tnf 2 and type is the MIME type; URI records: tnf 1, type 'U').
function parseNdef(data) {
  if (!data || data.length < 4) return [];
  let pos = 0;
  if (data.length > 12 && data[0] !== 0xE1) {
    for (let i = 0; i < Math.min(16, data.length - 4); i++) {
      if (data[i] === 0xE1 && (data[i + 1] === 0x10 || data[i + 1] === 0x11 || data[i + 1] === 0x40)) { pos = i; break; }
    }
  }
  if (data[pos] !== 0xE1) return [];
  pos += 4;
  const records = [];
  while (pos + 2 <= data.length) {
    const tag = data[pos];
    if (tag === 0xFE) break;
    let len = data[pos + 1];
    pos += 2;
    if (len === 0xFF) {
      if (pos + 2 > data.length) break;
      len = (data[pos] << 8) | data[pos + 1];
      pos += 2;
    }
    if (tag !== 0x03) { pos += len; continue; }
    const msg = data.subarray(pos, pos + len);
    pos += len;
    let o = 0;
    while (o < msg.length - 2) {
      const header = msg[o++];
      const tnf = header & 0x07, sr = (header >> 4) & 1, il = (header >> 3) & 1;
      const typeLen = msg[o++];
      let payloadLen;
      if (sr) payloadLen = msg[o++];
      else {
        if (o + 4 > msg.length) break;
        payloadLen = ((msg[o] << 24) | (msg[o + 1] << 16) | (msg[o + 2] << 8) | msg[o + 3]) >>> 0;
        o += 4;
      }
      const idLen = il ? msg[o++] : 0;
      if (o + typeLen + idLen + payloadLen > msg.length) break;
      const type = Buffer.from(msg.subarray(o, o + typeLen)).toString('latin1').replace(/[^\x00-\x7f]/g, '');
      o += typeLen + idLen;
      const payload = Buffer.from(msg.subarray(o, o + payloadLen));
      o += payloadLen;
      if (tnf === 0x02 || (tnf === 0x01 && type === 'U')) records.push({ tnf, type, payload });
    }
  }
  return records;
}

// The text of a URI record (its first byte is a prefix code)
function uriOf(payload) {
  if (!payload || payload.length < 1) throw new Error('Invalid NDEF URI payload');
  return ((URI_PREFIXES[payload[0]] || '') + payload.subarray(1).toString('utf8')).trim();
}

// One MIME record in an NDEF message TLV, ready to write from page 4: 03 <len> <record> FE
function mimeMessage(mimeType, payload) {
  const type = Buffer.from(mimeType, 'ascii');
  const short = payload.length < 256;
  const head = short ? Buffer.from([0xD2, type.length, payload.length])   // MB ME SR, TNF 2 (MIME)
    : Buffer.from([0xC2, type.length, (payload.length >>> 24) & 255, (payload.length >>> 16) & 255, (payload.length >>> 8) & 255, payload.length & 255]);
  const record = Buffer.concat([head, type, payload]);
  const len = record.length < 0xFF ? Buffer.from([record.length]) : Buffer.from([0xFF, record.length >> 8, record.length & 255]);
  return Buffer.concat([Buffer.from([0x03]), len, record, Buffer.from([0xFE])]);
}

// A URI record's payload: the shortest matching prefix code, then the rest of the address
function uriPayload(url) {
  let code = 0;
  for (let i = 1; i < URI_PREFIXES.length; i++) if (url.startsWith(URI_PREFIXES[i]) && URI_PREFIXES[i].length > (URI_PREFIXES[code] || '').length) code = i;
  return Buffer.concat([Buffer.from([code]), Buffer.from(url.slice(URI_PREFIXES[code].length), 'utf8')]);
}
// An NDEF message TLV with several records: [{ tnf: 1|2, type: 'U' | mime type, payload }]
function message(records) {
  const recs = records.map((r, i) => {
    const type = Buffer.from(r.type, 'ascii');
    const short = r.payload.length < 256;
    let head = (i === 0 ? 0x80 : 0) | (i === records.length - 1 ? 0x40 : 0) | (short ? 0x10 : 0) | r.tnf;
    const plen = short ? Buffer.from([r.payload.length])
      : Buffer.from([(r.payload.length >>> 24) & 255, (r.payload.length >>> 16) & 255, (r.payload.length >>> 8) & 255, r.payload.length & 255]);
    return Buffer.concat([Buffer.from([head, type.length]), plen, type, r.payload]);
  });
  const body = Buffer.concat(recs);
  const len = body.length < 0xFF ? Buffer.from([body.length]) : Buffer.from([0xFF, body.length >> 8, body.length & 255]);
  return Buffer.concat([Buffer.from([0x03]), len, body, Buffer.from([0xFE])]);
}

module.exports = { parseNdef, uriOf, mimeMessage, message, uriPayload, URI_PREFIXES };
