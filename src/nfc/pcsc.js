// USB NFC readers through Windows' own smart-card system (PC/SC, winscard.dll), called directly with koffi (no
// driver or program of our own). Works with standard contactless readers: ACS ACR122U / ACR1252U / ACR1552U,
// Cryptnox, HID Omnikey 5022/5427, Identiv uTrust, and others that read MIFARE Classic and NTAG.
//
// Only standard PC/SC Part 3 "pseudo-APDUs" are sent:
//   FF CA 00 00 00            get UID
//   FF 82 .. .. 06 <key>      load a key into the reader's memory (not the tag)
//   FF 86 / FF 88             MIFARE Classic authenticate
//   FF B0 00 <blk> 10         read
//   FF D6 00 <page> 04 <4 B>  write one NTAG page (only ever sent by cardio.writeMessage, for NTAG user pages)
// Readers differ on MIFARE login (key slot, command version, which block): the four variants below are tried in
// turn, only if no brand's key works with the first (the approach and variants come from PR #10's spoolscan, tested
// on a Cryptnox reader).
'use strict';

const S_OK = 0;
const E = { NO_SERVICE: 0x8010001D, SERVICE_STOPPED: 0x8010001E, INVALID_HANDLE: 0x80100003, NO_READERS: 0x8010002E,
  TIMEOUT: 0x8010000A, NO_SMARTCARD: 0x8010000C, REMOVED: 0x80100069, UNKNOWN_READER: 0x80100009, READER_UNAVAILABLE: 0x80100017 };
const STATE = { UNAWARE: 0, CHANGED: 0x2, PRESENT: 0x20, MUTE: 0x200 };
const SHARE_SHARED = 2, PROTO_ANY = 3, RESET_CARD = 1, UNPOWER_CARD = 2, LEAVE_CARD = 0;
const GONE = new Set([E.NO_SERVICE, E.SERVICE_STOPPED, E.INVALID_HANDLE]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let W = null;   // winscard functions, bound on first use
function bind() {
  if (W) return W;
  const koffi = require('koffi');
  const lib = koffi.load('winscard.dll');
  koffi.struct('SCARD_READERSTATEW', { szReader: 'const char16_t *', pvUserData: 'void *', dwCurrentState: 'uint32_t',
    dwEventState: 'uint32_t', cbAtr: 'uint32_t', rgbAtr: koffi.array('uint8_t', 36) });
  koffi.struct('SCARD_IO_REQUEST', { dwProtocol: 'uint32_t', cbPciLength: 'uint32_t' });
  W = {
    koffi,
    establish: lib.func('int32_t __stdcall SCardEstablishContext(uint32_t scope, void *r1, void *r2, _Out_ uintptr_t *ctx)'),
    release: lib.func('int32_t __stdcall SCardReleaseContext(uintptr_t ctx)'),
    list: lib.func('int32_t __stdcall SCardListReadersW(uintptr_t ctx, const char16_t *groups, _Out_ uint16_t *readers, _Inout_ uint32_t *len)'),
    status: lib.func('int32_t __stdcall SCardGetStatusChangeW(uintptr_t ctx, uint32_t timeout, _Inout_ SCARD_READERSTATEW *states, uint32_t count)'),
    connect: lib.func('int32_t __stdcall SCardConnectW(uintptr_t ctx, const char16_t *reader, uint32_t share, uint32_t protocols, _Out_ uintptr_t *card, _Out_ uint32_t *active)'),
    reconnect: lib.func('int32_t __stdcall SCardReconnect(uintptr_t card, uint32_t share, uint32_t protocols, uint32_t init, _Out_ uint32_t *active)'),
    disconnect: lib.func('int32_t __stdcall SCardDisconnect(uintptr_t card, uint32_t disposition)'),
    transmit: lib.func('int32_t __stdcall SCardTransmit(uintptr_t card, const SCARD_IO_REQUEST *send, const uint8_t *buf, uint32_t len, void *recvPci, _Out_ uint8_t *out, _Inout_ uint32_t *outLen)'),
  };
  return W;
}
const hr = (n) => n >>> 0;

// The context: one per watcher; recreated when Windows stops the smart-card service (it does when no reader is plugged in)
class PcscContext {
  constructor() { this.ctx = 0; }
  ensure() {
    if (this.ctx) return true;
    const w = bind(), out = [0];
    const r = hr(w.establish(2 /* SCARD_SCOPE_SYSTEM */, null, null, out));
    if (r !== S_OK) { this.ctx = 0; return false; }
    this.ctx = out[0];
    return true;
  }
  drop() { if (this.ctx) { try { bind().release(this.ctx); } catch {} } this.ctx = 0; }
  // Reader names, or null when the service is gone (call ensure() again later)
  readers() {
    if (!this.ensure()) return null;
    const w = bind(), len = [0];
    let r = hr(w.list(this.ctx, null, null, len));
    if (r === E.NO_READERS) return [];
    if (GONE.has(r)) { this.drop(); return null; }
    if (r !== S_OK) return [];
    const buf = new Uint16Array(len[0]);
    r = hr(w.list(this.ctx, null, buf, len));
    if (r !== S_OK) { if (GONE.has(r)) this.drop(); return r === E.NO_READERS ? [] : null; }
    return String.fromCharCode(...buf.subarray(0, len[0])).split('\0').filter(Boolean);
  }
  // { present, atr } for one reader, right now
  state(reader) {
    const w = bind();
    const st = { szReader: reader, pvUserData: null, dwCurrentState: STATE.UNAWARE, dwEventState: 0, cbAtr: 0, rgbAtr: new Array(36).fill(0) };
    const r = hr(w.status(this.ctx, 0, st, 1));
    if (GONE.has(r)) { this.drop(); return null; }
    if (r !== S_OK && r !== E.TIMEOUT) return { present: false };
    const present = !!(st.dwEventState & STATE.PRESENT) && !(st.dwEventState & STATE.MUTE);
    return { present, atr: Buffer.from(st.rgbAtr).subarray(0, st.cbAtr) };
  }
}

// One tag on one reader
class PcscTag {
  constructor(ctx, reader) {
    this.ctx = ctx; this.reader = reader; this.name = reader; this.kind = 'pcsc';
    this.card = 0; this.proto = 0; this.mode = 0; this.loadP1 = 0x00;
    this.authModes = PcscTag.MODES.length;
  }
  open() {
    const w = bind(), card = [0], active = [0];
    const r = hr(w.connect(this.ctx.ctx, this.reader, SHARE_SHARED, PROTO_ANY, card, active));
    if (r !== S_OK) throw Object.assign(new Error(`connect failed (0x${r.toString(16)})`), { code: r });
    this.card = card[0]; this.proto = active[0];
  }
  close() { if (this.card) { try { bind().disconnect(this.card, LEAVE_CARD); } catch {} } this.card = 0; }
  apdu(bytes) {
    const w = bind();
    const out = new Uint8Array(258), len = [out.length];
    const r = hr(w.transmit(this.card, { dwProtocol: this.proto, cbPciLength: 8 }, Uint8Array.from(bytes), bytes.length, null, out, len));
    if (r !== S_OK) throw Object.assign(new Error(`transmit failed (0x${r.toString(16)})`), { code: r });
    const n = len[0];
    if (n < 2) throw new Error('short reply');
    return { data: Buffer.from(out.subarray(0, n - 2)), sw: (out[n - 2] << 8) | out[n - 1] };
  }
  uid() {
    const { data, sw } = this.apdu([0xFF, 0xCA, 0x00, 0x00, 0x00]);
    if (sw !== 0x9000 || !data.length) throw new Error('get UID failed');
    return data;
  }
  // Get the tag back to a fresh state after a failed MIFARE login (a failed login halts it)
  async reselect() {
    const w = bind(), active = [0];
    for (const init of [RESET_CARD, UNPOWER_CARD]) {
      if (this.card && hr(w.reconnect(this.card, SHARE_SHARED, PROTO_ANY, init, active)) === S_OK) { this.proto = active[0]; return; }
    }
    this.close();
    let last = null;
    for (let i = 0; i < 15; i++) {
      await sleep(i ? 200 : 50);
      try { this.open(); return; } catch (e) {
        if (e.code === E.NO_SMARTCARD || e.code === E.REMOVED) throw new Error('tag removed during read');
        last = e;
      }
    }
    throw new Error(`could not re-select the tag: ${last && last.message}`);
  }
  setAuthMode(i) { this.mode = i; }
  loadKey(key, slot) {
    let r = this.apdu([0xFF, 0x82, this.loadP1, slot, 0x06, ...key]);
    if (r.sw !== 0x9000 && this.loadP1 === 0x00) { this.loadP1 = 0x20; r = this.apdu([0xFF, 0x82, this.loadP1, slot, 0x06, ...key]); }
    if (r.sw !== 0x9000) throw new Error('load key failed');
  }
  async auth(block, kind, key) {
    const [slot, ins, onTrailer] = PcscTag.MODES[this.mode];
    const sector = Math.floor(block / 4);
    const b = sector * 4 + (onTrailer ? 3 : 0);
    const kt = kind === 'B' ? 0x61 : 0x60;
    let ok = false;
    try {
      this.loadKey(key, slot);
      const r = ins === 0x86 ? this.apdu([0xFF, 0x86, 0x00, 0x00, 0x05, 0x01, 0x00, b, kt, slot]) : this.apdu([0xFF, 0x88, 0x00, b, kt, slot]);
      ok = r.sw === 0x9000;
    } catch (e) { if (/removed/.test(e.message)) throw e; }
    if (!ok) await this.reselect();
    return ok;
  }
  async read(block) {
    const { data, sw } = this.apdu([0xFF, 0xB0, 0x00, block, 0x10]);
    return sw === 0x9000 && data.length >= 4 ? data : null;
  }
  async write(page, four) {
    if (page < 4) throw new Error('refusing to write a system page');
    let r = this.apdu([0xFF, 0xD6, 0x00, page, 0x04, ...four]);
    if (r.sw !== 0x9000) r = this.apdu([0xFF, 0xD6, 0x00, page, 0x10, ...four, ...Array(12).fill(0)]);   // readers that only take 16
    if (r.sw !== 0x9000) throw new Error(`write page ${page} failed (${r.sw.toString(16)})`);
  }
}
// (key slot, authenticate command, authenticate on the sector trailer?)
PcscTag.MODES = [[0x00, 0x86, true], [0x01, 0x86, true], [0x00, 0x88, true], [0x00, 0x86, false]];

module.exports = { PcscContext, PcscTag, available: () => { try { bind(); return true; } catch { return false; } } };
