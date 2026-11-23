// Serial (COM) ports through Windows' own functions (kernel32/advapi32 via koffi), for NFC readers that plug in as
// a COM port: an Arduino with a PN532 shield running tools/arduino/SpoolTagBridge, or a PN532 board on a USB-serial
// adapter. Nothing here opens a port by itself: listPorts() only reads the registry, and a port is opened only
// when the user picks it (or "find automatically", which only tries Arduino boards, never other serial devices
// such as a 3D printer, which opening a port could reset).
'use strict';

let K = null;
function bind() {
  if (K) return K;
  const koffi = require('koffi');
  const k32 = koffi.load('kernel32.dll'), adv = koffi.load('advapi32.dll');
  koffi.struct('DCB', { DCBlength: 'uint32_t', BaudRate: 'uint32_t', fFlags: 'uint32_t', wReserved: 'uint16_t', XonLim: 'uint16_t',
    XoffLim: 'uint16_t', ByteSize: 'uint8_t', Parity: 'uint8_t', StopBits: 'uint8_t', XonChar: 'int8_t', XoffChar: 'int8_t',
    ErrorChar: 'int8_t', EofChar: 'int8_t', EvtChar: 'int8_t', wReserved1: 'uint16_t' });
  koffi.struct('COMMTIMEOUTS', { ReadIntervalTimeout: 'uint32_t', ReadTotalTimeoutMultiplier: 'uint32_t', ReadTotalTimeoutConstant: 'uint32_t',
    WriteTotalTimeoutMultiplier: 'uint32_t', WriteTotalTimeoutConstant: 'uint32_t' });
  K = {
    koffi,
    CreateFile: k32.func('intptr_t __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *sa, uint32_t disp, uint32_t flags, void *tmpl)'),
    CloseHandle: k32.func('int __stdcall CloseHandle(intptr_t h)'),
    GetCommState: k32.func('int __stdcall GetCommState(intptr_t h, _Inout_ DCB *dcb)'),
    BuildCommDCB: k32.func('int __stdcall BuildCommDCBW(const char16_t *def, _Inout_ DCB *dcb)'),
    SetCommState: k32.func('int __stdcall SetCommState(intptr_t h, const DCB *dcb)'),
    SetCommTimeouts: k32.func('int __stdcall SetCommTimeouts(intptr_t h, const COMMTIMEOUTS *t)'),
    ReadFile: k32.func('int __stdcall ReadFile(intptr_t h, _Out_ uint8_t *buf, uint32_t n, _Out_ uint32_t *read, void *ov)'),
    WriteFile: k32.func('int __stdcall WriteFile(intptr_t h, const uint8_t *buf, uint32_t n, _Out_ uint32_t *written, void *ov)'),
    PurgeComm: k32.func('int __stdcall PurgeComm(intptr_t h, uint32_t flags)'),
    GetLastError: k32.func('uint32_t __stdcall GetLastError()'),
    RegOpenKeyEx: adv.func('int32_t __stdcall RegOpenKeyExW(uintptr_t key, const char16_t *sub, uint32_t opts, uint32_t sam, _Out_ uintptr_t *out)'),
    RegCloseKey: adv.func('int32_t __stdcall RegCloseKey(uintptr_t key)'),
    RegEnumKeyEx: adv.func('int32_t __stdcall RegEnumKeyExW(uintptr_t key, uint32_t i, _Out_ uint16_t *name, _Inout_ uint32_t *len, void *r, void *c, void *cl, void *t)'),
    RegEnumValue: adv.func('int32_t __stdcall RegEnumValueW(uintptr_t key, uint32_t i, _Out_ uint16_t *name, _Inout_ uint32_t *len, void *r, _Out_ uint32_t *type, _Out_ uint8_t *data, _Inout_ uint32_t *dlen)'),
    RegQueryValueEx: adv.func('int32_t __stdcall RegQueryValueExW(uintptr_t key, const char16_t *name, void *r, _Out_ uint32_t *type, _Out_ uint8_t *data, _Inout_ uint32_t *dlen)'),
  };
  return K;
}

// ---------------------------------------------------------------- the registry (which COM ports exist, and what they are)
const HKLM = 0x80000002, KEY_READ = 0x20019;
const u16 = (buf, len) => String.fromCharCode(...buf.subarray(0, len));
const sz = (bytes, len) => Buffer.from(bytes.subarray(0, len)).toString('utf16le').replace(/\0+$/, '');
function withKey(path, fn, root = HKLM) {
  const k = bind(), out = [0];
  if (k.RegOpenKeyEx(root, path, 0, KEY_READ, out) !== 0) return null;
  try { return fn(out[0]); } finally { k.RegCloseKey(out[0]); }
}
function subkeys(h) {
  const k = bind(), names = [];
  for (let i = 0; i < 4096; i++) {
    const buf = new Uint16Array(256), len = [256];
    if (k.RegEnumKeyEx(h, i, buf, len, null, null, null, null) !== 0) break;
    names.push(u16(buf, len[0]));
  }
  return names;
}
function stringValue(h, name) {
  const k = bind(), type = [0], data = new Uint8Array(1024), len = [1024];
  if (k.RegQueryValueEx(h, name, null, type, data, len) !== 0 || type[0] !== 1) return null;
  return sz(data, len[0]);
}

// Known USB IDs: what a port probably is
const ARDUINO_VIDS = new Set(['2341', '2A03', '1B4F', '239A', '2886', '303A']);   // Arduino, Arduino.org, SparkFun, Adafruit, Seeed, Espressif
const KNOWN = { '2341:8036': 'Arduino Leonardo', '2341:0036': 'Arduino Leonardo (bootloader)', '2341:8037': 'Arduino Micro',
  '2341:0043': 'Arduino Uno', '2341:0042': 'Arduino Mega 2560', '2341:0010': 'Arduino Mega 2560', '2341:0058': 'Arduino Nano Every',
  '1A86:7523': 'USB-serial (CH340)', '1A86:55D4': 'USB-serial (CH9102)', '10C4:EA60': 'USB-serial (CP210x)', '0403:6001': 'USB-serial (FTDI)',
  '0403:6015': 'USB-serial (FTDI)', '067B:2303': 'USB-serial (Prolific)' };

// [{ port: 'COM11', name, vid, pid, arduino: bool }] for the COM ports present now
function listPorts() {
  bind();
  const present = withKey('HARDWARE\\DEVICEMAP\\SERIALCOMM', (h) => {
    const k = bind(), ports = [];
    for (let i = 0; i < 256; i++) {
      const name = new Uint16Array(256), nlen = [256], type = [0], data = new Uint8Array(256), dlen = [256];
      if (k.RegEnumValue(h, i, name, nlen, null, type, data, dlen) !== 0) break;
      if (type[0] === 1) ports.push(sz(data, dlen[0]));
    }
    return ports;
  }) || [];
  const info = {};
  for (const bus of ['USB', 'FTDIBUS']) {
    withKey(`SYSTEM\\CurrentControlSet\\Enum\\${bus}`, (busKey) => {
      for (const dev of subkeys(busKey)) {
        const m = /VID_([0-9A-F]{4})\+?&?PID_([0-9A-F]{4})/i.exec(dev);
        withKey(`SYSTEM\\CurrentControlSet\\Enum\\${bus}\\${dev}`, (devKey) => {
          for (const inst of subkeys(devKey)) {
            const base = `SYSTEM\\CurrentControlSet\\Enum\\${bus}\\${dev}\\${inst}`;
            const port = withKey(`${base}\\Device Parameters`, (p) => stringValue(p, 'PortName'));
            if (!port || !/^COM\d+$/i.test(port)) continue;
            const friendly = withKey(base, (p) => stringValue(p, 'FriendlyName')) || '';
            info[port.toUpperCase()] = { vid: m ? m[1].toUpperCase() : '', pid: m ? m[2].toUpperCase() : '', friendly };
          }
        });
      }
    });
  }
  return present.filter(p => /^COM\d+$/i.test(p)).map(p => {
    const i = info[p.toUpperCase()] || {};
    const known = KNOWN[`${i.vid}:${i.pid}`];
    return { port: p.toUpperCase(), name: known || (i.friendly || '').replace(/\s*\(COM\d+\)\s*$/i, '') || 'Serial port',
      vid: i.vid || '', pid: i.pid || '', arduino: ARDUINO_VIDS.has(i.vid) };
  }).sort((a, b) => parseInt(a.port.slice(3)) - parseInt(b.port.slice(3)));
}

// ---------------------------------------------------------------- an open port
class SerialPort {
  constructor(port, baud = 115200) {
    const k = bind();
    if (!/^COM\d+$/i.test(port)) throw new Error(`not a COM port: ${port}`);
    this.port = port.toUpperCase();
    this.h = k.CreateFile(`\\\\.\\${this.port}`, 0xC0000000 /* read|write */, 0, null, 3 /* OPEN_EXISTING */, 0, null);
    if (this.h === -1 || this.h === -1n) {
      const err = k.GetLastError();
      throw Object.assign(new Error(err === 5 ? `${this.port} is in use by another program (close the Arduino IDE’s Serial Monitor, for example).` : err === 2 ? `${this.port} isn’t connected.` : `Couldn’t open ${this.port} (error ${err}).`), { code: err });
    }
    const dcb = { DCBlength: 28 };
    if (!k.GetCommState(this.h, dcb) || !k.BuildCommDCB(`baud=${baud} parity=N data=8 stop=1 dtr=on rts=on`, dcb) || !k.SetCommState(this.h, dcb)) {
      this.close();
      throw new Error(`Couldn’t set up ${this.port}.`);
    }
    this.timeout(50);
    k.PurgeComm(this.h, 0x0F);
    this.pending = Buffer.alloc(0);
  }
  timeout(ms) {
    // return as soon as any byte arrives, or after ms with nothing
    bind().SetCommTimeouts(this.h, { ReadIntervalTimeout: 0xFFFFFFFF, ReadTotalTimeoutMultiplier: 0xFFFFFFFF,
      ReadTotalTimeoutConstant: Math.max(1, ms), WriteTotalTimeoutMultiplier: 0, WriteTotalTimeoutConstant: 1000 });
    this.ms = ms;
  }
  write(bytes) {
    const k = bind(), n = [0], b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (!k.WriteFile(this.h, b, b.length, n, null) || n[0] !== b.length) throw new Error(`${this.port}: write failed (unplugged?)`);
  }
  // whatever arrived within ms (may be empty)
  readSome(ms) {
    const k = bind();
    if (ms !== this.ms) this.timeout(ms);
    const buf = Buffer.alloc(256), n = [0];
    if (!k.ReadFile(this.h, buf, buf.length, n, null)) throw new Error(`${this.port}: read failed (unplugged?)`);
    return buf.subarray(0, n[0]);
  }
  // one text line (without the newline), or null after ms
  readLine(ms) {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.pending.indexOf(0x0A);
      if (i >= 0) { const line = this.pending.subarray(0, i).toString('latin1').replace(/\r$/, ''); this.pending = this.pending.subarray(i + 1); return line; }
      const left = end - Date.now();
      if (left <= 0) return null;
      const got = this.readSome(Math.min(left, 100));
      if (got.length) this.pending = Buffer.concat([this.pending, got]);
      if (this.pending.length > 4096) this.pending = Buffer.alloc(0);
    }
  }
  // exactly n bytes, or null after ms
  readBytes(n, ms) {
    const end = Date.now() + ms;
    while (this.pending.length < n) {
      const left = end - Date.now();
      if (left <= 0) return null;
      const got = this.readSome(Math.min(left, 100));
      if (got.length) this.pending = Buffer.concat([this.pending, got]);
    }
    const out = this.pending.subarray(0, n); this.pending = this.pending.subarray(n);
    return Buffer.from(out);
  }
  drain() { this.pending = Buffer.alloc(0); try { bind().PurgeComm(this.h, 0x0F); } catch {} }
  close() { if (this.h && this.h !== -1 && this.h !== -1n) { try { bind().CloseHandle(this.h); } catch {} } this.h = null; }
}

module.exports = { listPorts, SerialPort, ARDUINO_VIDS };
