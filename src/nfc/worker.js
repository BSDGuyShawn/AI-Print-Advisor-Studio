// The spool tag reader, in its own background process (an Electron utility process started by src/nfc.js), so
// waiting on readers never slows the window. It watches every enabled reader, reads a tag when one is placed, and
// writes a sticker when asked.
//
// Messages in (from src/nfc.js):
//   { type:'config', pcsc: bool, reader: 'name filter', serialPort: '' | 'auto' | 'COM5' }
//   { type:'write', id, format, filament, overwriteUid?, overwriteAny?, timeoutMs }   arm: the next tag placed gets written
//   { type:'cancel-write', id }      { type:'list-ports', id }      { type:'test-port', id, port }      { type:'stop' }
// Messages out:
//   { type:'status', state, readers, error? }     state: off | starting | no_service | no_reader | watching | error
//   { type:'tag', record }                        a scan (cardio.scanTag's record)
//   { type:'write-progress', id, status, ... }    e.g. a tag that can't be written was tapped (the write stays armed)
//   { type:'write-result', id, status, ... }      written | confirm | error | timeout | cancelled
//   { type:'ports', id, ports } / { type:'port-test', id, ... } / { type:'log', line }
'use strict';

const { scanTag, inspectForWrite, writeMessage } = require('./cardio');
const { encodeTag } = require('./encoders');

const parent = process.parentPort;
const send = (m) => { try { parent ? parent.postMessage(m) : process.send && process.send(m); } catch {} };
const log = (...a) => send({ type: 'log', line: a.map(String).join(' ').slice(0, 500) });
const hex = (b) => Buffer.from(b).toString('hex').toUpperCase();

let pcscMod = null, boardsMod = null, serialMod = null, libError = null;
try {
  pcscMod = require('./pcsc'); boardsMod = require('./boards'); serialMod = require('./serial');
  pcscMod.available() || (libError = 'The tag reader library (koffi) is missing from this copy of the app.');
} catch (e) { libError = `The tag reader library couldn’t load: ${e.message}`; }

let cfg = { pcsc: true, reader: '', serialPort: '' };
let running = false, timer = null, busy = false;
// USB (PC/SC) readers
let ctx = null, pcscReaders = [], pcscState = 'off', nextList = 0;
// a COM-port board
let board = null, boardErr = null, boardRetryAt = 0, boardMisses = 0;
const failedPorts = new Map();   // "find automatically": ports that didn't answer, and until when to skip them
// what's on each reader now and was already handled (so a tag left on the reader isn't read again and again)
const present = new Map();
let writeJob = null;
let lastStatus = '';

// ---------------------------------------------------------------- status
function emitStatus() {
  const readers = [...pcscReaders, ...(board ? [`${board.name}${board.version ? ` (${board.kind === 'bridge' ? 'bridge ' : 'PN532 '}${board.version.replace(/^SPOOLBRIDGE \d+ /, '')})` : ''}`] : [])];
  let state, error = null;
  if (libError) { state = 'error'; error = libError; }
  else if (readers.length) state = 'watching';
  else if (cfg.serialPort && boardErr) { state = 'error'; error = boardErr; }
  else if (!cfg.pcsc && !cfg.serialPort) state = 'off';
  else state = cfg.pcsc ? pcscState : 'no_reader';
  const s = { type: 'status', state, readers, error };
  const key = JSON.stringify(s);
  if (key !== lastStatus) { lastStatus = key; send(s); }
}

// ---------------------------------------------------------------- reading / writing one tag
async function handleTag(t, info) {
  if (writeJob) return doWrite(t, info);
  const record = await scanTag(t, info);
  log(`tag ${record.tag.uid}: ${record.status}${record.decoder ? ' ' + record.decoder : ''} on ${t.name}`);
  send({ type: 'tag', record });
}

const NOT_WRITABLE = {
  classic: 'That’s a MIFARE Classic tag (the kind on Bambu Lab, Snapmaker, Creality and QIDI spools). Those can’t be written here. Use a blank NTAG215 or NTAG216 sticker.',
  other: 'That tag isn’t an NFC sticker that can hold filament details (a bank card or phone, maybe?). Use a blank NTAG215 or NTAG216 sticker.',
  unformatted: 'That sticker isn’t formatted for NFC data (NDEF). Format it once with a phone app such as NFC Tools, or use another sticker.',
  readonly: 'That sticker is locked read-only.',
  locked: 'That sticker is locked, so it can’t be written.',
};
async function doWrite(t, info) {
  const job = writeJob, uid = hex(info.uid);
  try {
    const insp = await inspectForWrite(t, info);
    if (!insp.writable) {
      send({ type: 'write-progress', id: job.id, status: 'not-writable', uid, message: NOT_WRITABLE[insp.reason] || 'That tag can’t be written.' });
      return;   // stays armed: tap the right sticker
    }
    if (insp.hasData && !job.overwriteAny && job.overwriteUid !== uid) {
      const d = insp.decoded && insp.decoded.filament;
      return finishWrite({ status: 'confirm', uid, existing: d ? `${d.name}${d.color_hex ? ' ' + d.color_hex : ''}` : 'other data' });
    }
    let message;
    try { message = encodeTag(job.format, job.filament, insp.capacity); }
    catch (e) {
      // too small for the filament's details (NTAG203/213 hold 144 bytes): the window offers to link it by its ID instead
      return finishWrite({ status: 'too-small', uid, message: `This sticker holds ${insp.capacity} bytes, too little for the filament’s details (${job.format === 'opentag3d' ? 'OpenTag3D needs about 240' : 'OpenSpool needs about 150–250'}). Use an NTAG215 or NTAG216 sticker, or link this one by its ID without writing.` });
    }
    send({ type: 'write-progress', id: job.id, status: 'writing', uid });
    const back = await writeMessage(t, info, message, insp);
    log(`wrote ${job.format} to ${uid} on ${t.name}`);
    finishWrite({ status: 'written', uid, spoolId: `uid:${uid}`, format: message.linkOnly ? 'link' : job.format, readBack: back ? back.filament.name : null, reader: t.name });
  } catch (e) {
    finishWrite({ status: 'error', uid, message: String(e && e.message || e) });
  }
}
function finishWrite(result) {
  if (!writeJob) return;
  send({ type: 'write-result', id: writeJob.id, ...result });
  writeJob = null;
}

// ---------------------------------------------------------------- USB (PC/SC) readers
const wanted = (name) => !cfg.reader || name.toLowerCase().includes(cfg.reader.toLowerCase());
async function pcscTick() {
  if (!cfg.pcsc || !pcscMod || libError) { pcscReaders = []; pcscState = 'off'; return; }
  if (!ctx) ctx = new pcscMod.PcscContext();
  const now = Date.now();
  if (now >= nextList) {
    const names = ctx.readers();
    if (names === null) { pcscReaders = []; pcscState = 'no_service'; nextList = now + 3000; return; }
    pcscReaders = names.filter(wanted);
    pcscState = pcscReaders.length ? 'watching' : 'no_reader';
    for (const k of [...present.keys()]) if (k.startsWith('pcsc:') && !pcscReaders.includes(k.slice(5))) present.delete(k);
    nextList = now + 2000;
  }
  for (const name of pcscReaders) {
    const st = ctx.state(name);
    if (!st) { pcscReaders = []; pcscState = 'no_service'; nextList = 0; return; }
    const key = `pcsc:${name}`;
    if (!st.present) { present.delete(key); continue; }
    if (present.has(key)) continue;
    const t = new pcscMod.PcscTag(ctx, name);
    try {
      t.open();
      const uid = t.uid();
      present.set(key, hex(uid));
      await handleTag(t, { uid, atr: st.atr });
    } catch (e) {
      present.set(key, '?');
      log(`${name}: ${e.message}`);
      if (!writeJob) send({ type: 'tag', record: { event: 'tag_scanned', status: 'read_error', tag: { uid: '00', type: null }, reader: name, error: e.message } });
    } finally { t.close(); }
  }
}

// ---------------------------------------------------------------- a COM-port board (Arduino bridge or PN532)
function closeBoard(err) {
  if (board) { try { board.close(); } catch {} log(`closed ${board.name}`); }
  board = null; present.delete('board');
  if (err !== undefined) boardErr = err;
}
async function findArduino() {
  const now = Date.now();
  for (const p of serialMod.listPorts().filter(x => x.arduino)) {
    if ((failedPorts.get(p.port) || 0) > now) continue;
    const b = await boardsMod.openBoard(p.port).catch(() => null);
    if (b) return b;
    failedPorts.set(p.port, now + 60000);
  }
  return null;
}
async function boardTick() {
  if (!cfg.serialPort || !boardsMod || libError) { if (board) closeBoard(null); boardErr = null; return; }
  if (!board) {
    if (Date.now() < boardRetryAt) return;
    try {
      board = cfg.serialPort === 'auto' ? await findArduino() : await boardsMod.openBoard(cfg.serialPort);
      boardErr = board ? null : cfg.serialPort === 'auto'
        ? 'No Arduino with the spool tag bridge found. Plug it in, or pick its port in Settings.'
        : `No NFC reader answered on ${cfg.serialPort}. Is the bridge sketch on the Arduino, or the PN532 switched to HSU mode?`;
    } catch (e) { board = null; boardErr = e.message; }
    if (!board) { boardRetryAt = Date.now() + 5000; return; }
    log(`opened ${board.name} ${board.version || ''}`);
  }
  const info = await board.poll();
  if (!info) { if (++boardMisses >= 2) present.delete('board'); return; }
  boardMisses = 0;
  const uid = hex(info.uid);
  if (present.get('board') === uid) return;
  present.set('board', uid);
  await handleTag(board, info);
}

// ---------------------------------------------------------------- the loop
async function tick() {
  timer = null;
  if (!running) return;
  if (!busy) {
    busy = true;
    try { await pcscTick(); } catch (e) { log('USB reader:', e.message); ctx && ctx.drop(); pcscState = 'no_service'; nextList = Date.now() + 3000; }
    try { await boardTick(); } catch (e) { log('board:', e.message); closeBoard(e.message); boardRetryAt = Date.now() + 3000; }
    if (writeJob && Date.now() > writeJob.expires) finishWrite({ status: 'timeout' });
    busy = false;
    emitStatus();
  }
  if (running) timer = setTimeout(tick, 250);
}

function onMessage(m) {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'config') {
    const next = { pcsc: m.pcsc !== false, reader: String(m.reader || ''), serialPort: String(m.serialPort || '') };
    if (next.serialPort !== cfg.serialPort) { closeBoard(null); boardRetryAt = 0; failedPorts.clear(); }
    if (next.reader !== cfg.reader) nextList = 0;
    cfg = next;
    if (!running) { running = true; send({ type: 'status', state: 'starting', readers: [] }); tick(); }
  } else if (m.type === 'write') {
    if (writeJob) finishWrite({ status: 'cancelled' });
    try { encodeTag(m.format, m.filament, 0); } catch (e) { return send({ type: 'write-result', id: m.id, status: 'error', message: e.message }); }
    writeJob = { id: m.id, format: m.format, filament: m.filament, overwriteUid: m.overwriteUid || null, overwriteAny: !!m.overwriteAny,
      expires: Date.now() + Math.min(Math.max(+m.timeoutMs || 60000, 5000), 300000) };
    present.clear();   // a sticker already on the reader counts
  } else if (m.type === 'cancel-write') {
    if (writeJob && (!m.id || m.id === writeJob.id)) finishWrite({ status: 'cancelled' });
  } else if (m.type === 'list-ports') {
    let ports = [];
    try { ports = serialMod ? serialMod.listPorts() : []; } catch (e) { log('ports:', e.message); }
    send({ type: 'ports', id: m.id, ports, open: board ? board.port : null });
  } else if (m.type === 'test-port') {
    (async () => {
      if (board && board.port === m.port) return send({ type: 'port-test', id: m.id, ok: true, kind: board.kind, name: board.name, version: board.version });
      if (busy) await new Promise(r => setTimeout(r, 300));
      try {
        const b = await boardsMod.openBoard(m.port);
        if (!b) return send({ type: 'port-test', id: m.id, ok: false, error: `No NFC reader answered on ${m.port}.` });
        const r = { type: 'port-test', id: m.id, ok: true, kind: b.kind, name: b.name, version: b.version };
        b.close();
        send(r);
      } catch (e) { send({ type: 'port-test', id: m.id, ok: false, error: e.message }); }
    })();
  } else if (m.type === 'stop') {
    running = false;
    if (timer) clearTimeout(timer);
    finishWrite({ status: 'cancelled' });
    closeBoard(null);
    if (ctx) ctx.drop();
    setTimeout(() => process.exit(0), 50);
  }
}

if (parent) parent.on('message', (e) => onMessage(e.data));
else process.on('message', onMessage);
