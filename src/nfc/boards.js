// NFC readers that plug in as a COM port (see serial.js):
//   Bridge: an Arduino with a PN532 shield running tools/arduino/SpoolTagBridge (a simple text protocol; the
//           sketch itself also refuses to write anything but NTAG user pages).
//   Pn532:  a PN532 board in HSU (UART) mode on a USB-serial adapter (CH340, CP2102, FTDI…), e.g. the common
//           "PN532 NFC module V3" with its switches set to HSU. Driven directly with the PN532's own frames.
// Both find one ISO 14443A tag at a time and give the same operations as the USB readers (pcsc.js).
'use strict';

const { SerialPort } = require('./serial');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- Arduino bridge
class Bridge {
  constructor(port) { this.port = port; this.kind = 'bridge'; this.name = `Arduino on ${port}`; this.io = null; }
  // true if the sketch answers; leaves the port open
  async open() {
    this.io = new SerialPort(this.port);
    // boards that reset when the port opens (Uno, Mega) need ~2 s before the sketch runs; a Leonardo answers at once
    for (let attempt = 0; attempt < 3; attempt++) {
      this.io.drain();
      this.io.write(Buffer.from('\nHELLO\n'));
      const end = Date.now() + 1500;   // a chatty device that isn't ours mustn't keep us here
      for (let line; Date.now() < end && (line = this.io.readLine(Math.max(1, end - Date.now()))) !== null;) {
        if (line.startsWith('OK SPOOLBRIDGE')) { this.version = line.slice(3); return true; }
        if (line === 'ERR NO_PN532') throw new Error('The Arduino is running the bridge, but it can’t find the PN532 shield. Check the shield’s I2C wiring and switches.');
      }
      await sleep(400);
    }
    this.close();
    return false;
  }
  cmd(text, ms = 1500) {
    this.io.write(Buffer.from(text + '\n'));
    const line = this.io.readLine(ms);
    if (line === null) throw new Error('The Arduino stopped answering (unplugged?)');
    return line;
  }
  async poll() {
    const r = this.cmd('UID');
    if (r === 'NONE') return null;
    const m = /^OK ([0-9A-F]+) ([0-9A-F]{4}) ([0-9A-F]{2}) (\d+)$/.exec(r);
    if (!m) throw new Error(`unexpected reply: ${r}`);
    return { uid: Buffer.from(m[1], 'hex'), sak: parseInt(m[3], 16), atqa: parseInt(m[2], 16) };
  }
  async auth(block, kind, key) { return this.cmd(`AUTH ${block} ${kind} ${key.toString('hex').toUpperCase()}`) === 'OK'; }
  async read(block) {
    const r = this.cmd(`READ ${block}`);
    return r.startsWith('OK ') ? Buffer.from(r.slice(3), 'hex') : null;
  }
  async write(page, four) {
    if (page < 4) throw new Error('refusing to write a system page');
    const r = this.cmd(`WRITE ${page} ${Buffer.from(four).toString('hex').toUpperCase()}`);
    if (r !== 'OK') throw new Error(r === 'ERR NOT_WRITABLE' || r === 'ERR PROTECTED_PAGE' ? 'This sticker can’t be written (it isn’t an NTAG213/215/216).' : `write page ${page} failed (${r})`);
  }
  close() { if (this.io) this.io.close(); this.io = null; }
}

// ---------------------------------------------------------------- PN532 over HSU (UART)
class Pn532 {
  constructor(port) { this.port = port; this.kind = 'pn532'; this.name = `PN532 on ${port}`; this.io = null; this.uid = null; }
  frame(data) {
    const body = Buffer.from([0xD4, ...data]);
    const len = body.length;
    const dcs = (0x100 - (body.reduce((a, b) => a + b, 0) & 0xFF)) & 0xFF;
    return Buffer.concat([Buffer.from([0x00, 0x00, 0xFF, len, (0x100 - len) & 0xFF]), body, Buffer.from([dcs, 0x00])]);
  }
  // the next frame from the PN532: 'ack', or the data after D5 <cmd+1>; null on timeout
  readFrame(ms) {
    const end = Date.now() + ms;
    let prev = -1;
    for (;;) {
      const left = end - Date.now();
      if (left <= 0) return null;
      const b = this.io.readBytes(1, left);
      if (!b) return null;
      if (prev === 0x00 && b[0] === 0xFF) break;
      prev = b[0];
    }
    const lh = this.io.readBytes(2, 200);
    if (!lh) return null;
    const [len, lcs] = lh;
    if (len === 0x00 && lcs === 0xFF) { this.io.readBytes(1, 50); return 'ack'; }
    if (((len + lcs) & 0xFF) !== 0) return null;
    const rest = this.io.readBytes(len + 2, 300);
    if (!rest || rest[0] !== 0xD5) return null;
    const sum = rest.subarray(0, len).reduce((a, b) => a + b, 0) + rest[len];
    if ((sum & 0xFF) !== 0) return null;
    return rest.subarray(2, len);
  }
  command(data, ms = 1000) {
    this.io.write(this.frame(data));
    if (this.readFrame(150) !== 'ack') throw new Error('the PN532 didn’t acknowledge');
    const r = this.readFrame(ms);
    if (r === null || r === 'ack') throw new Error('no reply from the PN532');
    return r;
  }
  async open() {
    this.io = new SerialPort(this.port);
    try {
      // wake it from power-down: a long run of 0x55 and zeros, then SAMConfiguration (normal mode)
      this.io.write(Buffer.concat([Buffer.from([0x55, 0x55]), Buffer.alloc(14), this.frame([0x14, 0x01, 0x14, 0x01])]));
      this.readFrame(150); this.readFrame(300);
      this.io.drain();
      const fw = this.command([0x02]);
      if (fw.length < 4 || fw[0] !== 0x32) throw new Error('not a PN532');
      this.version = `${fw[1]}.${fw[2]}`;
      this.command([0x14, 0x01, 0x14, 0x01]);
      this.command([0x32, 0x05, 0xFF, 0x01, 0x02]);   // a scan gives up quickly when there's no tag
      return true;
    } catch {
      this.close();
      return false;
    }
  }
  select() {
    const r = this.command([0x4A, 0x01, 0x00], 500);
    if (!r.length || r[0] === 0 || r.length < 6) { this.uid = null; return null; }
    const len = r[5];
    this.uid = Buffer.from(r.subarray(6, 6 + len));
    return { uid: this.uid, atqa: (r[2] << 8) | r[3], sak: r[4] };
  }
  async poll() { return this.select(); }
  async auth(block, kind, key) {
    const uid4 = this.uid.subarray(this.uid.length - 4);
    const r = this.command([0x40, 0x01, kind === 'B' ? 0x61 : 0x60, block, ...key, ...uid4]);
    if (r[0] === 0x00) return true;
    this.select();   // a failed login halts the tag
    return false;
  }
  async read(block) {
    const r = this.command([0x40, 0x01, 0x30, block]);
    return r[0] === 0x00 && r.length >= 17 ? Buffer.from(r.subarray(1, 17)) : null;
  }
  async write(page, four) {
    if (page < 4) throw new Error('refusing to write a system page');
    const r = this.command([0x40, 0x01, 0xA2, page, ...four]);
    if (r[0] !== 0x00) throw new Error(`write page ${page} failed`);
  }
  close() { if (this.io) this.io.close(); this.io = null; }
}

// Which kind of board is on a port (tries the Arduino bridge first, then a PN532 in HSU mode). An open board, or null.
async function openBoard(port) {
  const b = new Bridge(port);
  if (await b.open()) return b;
  const p = new Pn532(port);
  if (await p.open()) return p;
  return null;
}

module.exports = { Bridge, Pn532, openBoard };
