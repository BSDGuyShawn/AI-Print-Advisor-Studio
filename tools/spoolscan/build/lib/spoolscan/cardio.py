"""Read-only tag access over standard PC/SC pseudo-APDUs (PC/SC Part 3).

Only these commands are ever sent:
  FF CA 00 00 00            get UID
  FF 82 00 00 06 <key>      load key into the reader's volatile memory (not the tag)
  FF 86 00 00 05 ...        authenticate a MIFARE Classic block
  FF B0 00 <blk> <len>      read binary
No write command (FF D6) exists anywhere in this program.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Protocol

from .decoders import (
    TagType, make_scan_result, decode_classic, decode_ultralight,
)

log = logging.getLogger("spoolscan.cardio")

TRAILER_ACCESS = bytes([0x87, 0x87, 0x87, 0x69])  # matches OpenRFID's dump layout
DEFAULT_KEY = bytes([0xFF] * 6)
KEY_A, KEY_B = 0x60, 0x61


class ApduError(Exception):
    def __init__(self, sw1: int, sw2: int, what: str = ""):
        super().__init__(f"{what} failed: SW={sw1:02X}{sw2:02X}")
        self.sw = (sw1, sw2)


class TagLost(ApduError):
    """The tag could not be re-selected (moved away, or the reader gave up)."""
    def __init__(self, msg: str):
        Exception.__init__(self, msg)
        self.sw = (0, 0)


class Transport(Protocol):
    def transmit(self, apdu: list[int]) -> tuple[list[int], int, int]: ...
    def reselect(self) -> None:
        """Re-power/reconnect the card (needed after a failed MIFARE auth)."""
        ...
    def atr(self) -> bytes: ...


def _ok(resp, what):
    data, sw1, sw2 = resp
    if (sw1, sw2) != (0x90, 0x00):
        raise ApduError(sw1, sw2, what)
    return bytes(data)


def get_uid(t: Transport) -> bytes:
    return _ok(t.transmit([0xFF, 0xCA, 0x00, 0x00, 0x00]), "get UID")


def detect_type(atr: bytes, uid: bytes) -> TagType:
    # PC/SC Part 3 storage-card ATR: 3B 8F 80 01 80 4F 0C A0 00 00 03 06 SS NN NN ...
    if len(atr) >= 15 and atr[4:5] == b"\x80" and atr[5:7] == b"\x4f\x0c" and atr[7:12] == bytes.fromhex("A000000306"):
        name = atr[13:15]
        if name in (b"\x00\x01", b"\x00\x26"):          # Classic 1K / Mini
            return TagType.MifareClassic1k
        if name in (b"\x00\x03", b"\x00\x3a", b"\x00\x30"):  # Ultralight / UL-C / NTAG-ish
            return TagType.MifareUltralight
    # Fallback heuristic: 4-byte UID -> Classic, 7-byte -> NTAG/Ultralight.
    return TagType.MifareClassic1k if len(uid) == 4 else TagType.MifareUltralight


# ---------------------------------------------------------------- MIFARE Classic
class Classic:
    # Ways PC/SC readers differ on MIFARE auth. Tried in order only if no brand's
    # key works with the first one, so a reader quirk doesn't look like "unknown tag".
    #   (key slot, auth INS, authenticate on trailer block?)
    MODES = [
        (0x00, 0x86, True),    # PC/SC 2.07 general authenticate (most readers)
        (0x01, 0x86, True),    # some readers reserve slot 0
        (0x00, 0x88, True),    # legacy PC/SC 2.01 authenticate
        (0x00, 0x86, False),   # authenticate on the sector's first data block
    ]

    def __init__(self, t: Transport):
        self.t = t
        self.mode = 0
        self._load_p1 = 0x00

    def describe_mode(self) -> str:
        slot, ins, trailer = self.MODES[self.mode]
        return f"slot={slot:02X} ins={ins:02X} block={'trailer' if trailer else 'data'}"

    def _load_key(self, key: bytes, slot: int):
        resp = self.t.transmit([0xFF, 0x82, self._load_p1, slot, 0x06, *key])
        if resp[1:] != (0x90, 0x00) and self._load_p1 == 0x00:
            self._load_p1 = 0x20  # some readers only accept the other key structure
            resp = self.t.transmit([0xFF, 0x82, self._load_p1, slot, 0x06, *key])
        _ok(resp, "load key")

    def auth(self, sector: int, key: bytes, key_type: int = KEY_A) -> bool:
        slot, ins, on_trailer = self.MODES[self.mode]
        block = sector * 4 + (3 if on_trailer else 0)
        self._load_key(key, slot)
        if ins == 0x86:
            r = self.t.transmit([0xFF, 0x86, 0x00, 0x00, 0x05, 0x01, 0x00, block, key_type, slot])
        else:
            r = self.t.transmit([0xFF, 0x88, 0x00, block, key_type, slot])
        return (r[1], r[2]) == (0x90, 0x00)

    def read_block(self, block: int) -> bytes:
        d = _ok(self.t.transmit([0xFF, 0xB0, 0x00, block, 0x10]), f"read block {block}")
        if len(d) != 16:
            raise ApduError(0, 0, f"read block {block} (got {len(d)} bytes)")
        return d

    def auth_sector(self, sector: int, keys: list[tuple[bytes, int]]) -> bool:
        for i, (key, kt) in enumerate(keys):
            if i:
                self.t.reselect()   # a failed auth halts the tag
            if self.auth(sector, key, kt):
                return True
        self.t.reselect()
        return False

    def dump(self, key_a: list[bytes], key_b: list[bytes]) -> tuple[bytes, list[int]]:
        """Read all 16 sectors. Returns (1024-byte image, unreadable sectors)."""
        out = bytearray(1024)
        failed = []
        for s in range(16):
            cands = [(key_a[s], KEY_A)]
            if key_b[s] != bytes(6):
                cands.append((key_b[s], KEY_B))
            if DEFAULT_KEY not in (key_a[s], key_b[s]):
                cands.append((DEFAULT_KEY, KEY_A))
            if not self.auth_sector(s, cands):
                failed.append(s)
                continue
            for b in range(3):
                out[(s * 4 + b) * 16:(s * 4 + b + 1) * 16] = self.read_block(s * 4 + b)
            # Tags never reveal Key A; rebuild the trailer the way OpenRFID's
            # reader does so signature checks (Snapmaker) see the same bytes.
            out[(s * 4 + 3) * 16:(s * 4 + 4) * 16] = key_a[s] + TRAILER_ACCESS + key_b[s]
        return bytes(out), failed


# ------------------------------------------------------------- NTAG / Ultralight
UL_PAGES_BY_CC = {0x06: 16, 0x12: 45, 0x3E: 135, 0x6D: 231}


def read_ultralight(t: Transport) -> bytes:
    def rd(page, le):
        data, sw1, sw2 = t.transmit([0xFF, 0xB0, 0x00, page, le])
        return bytes(data) if (sw1, sw2) == (0x90, 0x00) else None

    first = rd(0, 0x10)
    if first is None:
        raise ApduError(0, 0, "read page 0")
    step = 4 if len(first) >= 16 else 1   # some readers return one page per read
    le = 0x10 if step == 4 else 0x04
    buf = bytearray(first[:16] if step == 4 else first[:4])
    if step == 1:
        for p in range(1, 4):
            d = rd(p, le)
            if d is None:
                raise ApduError(0, 0, f"read page {p}")
            buf += d[:4]

    cc = buf[12:16]
    total_pages = UL_PAGES_BY_CC.get(cc[2]) if cc[0] == 0xE1 else None
    limit = total_pages or 231
    page = 4
    while page < limit:
        d = rd(page, le)
        if d is None:
            if total_pages:
                raise ApduError(0, 0, f"read page {page}")
            break                     # unknown size: stop at end of memory
        take = min(step, limit - page)
        buf += d[:take * 4]
        page += take
    return bytes(buf)


# ----------------------------------------------------------------------- scanning
@dataclass
class ScanOutcome:
    uid: bytes
    tag_type: TagType
    atr: bytes
    status: str = "unrecognized"          # decoded | unrecognized | read_error
    decoder: str | None = None
    filament: dict | None = None
    extras: dict = field(default_factory=dict)
    spool_id: str | None = None
    raw: bytes | None = None
    unreadable_sectors: list[int] = field(default_factory=list)
    error: str | None = None


def _probe_and_decode(t, mc: Classic, classic_procs, scan, out: ScanOutcome, tried: list) -> bool:
    """Try every brand's key with the current auth mode. True if any key opened the tag."""
    opened = False
    for name, proc in classic_procs:
        auth = proc.authenticate_tag(scan)
        if auth is None:
            continue
        ka = [bytes(k) for k in auth.hkdf_key_a]
        kb = [bytes(k) for k in auth.hkdf_key_b]
        # Cheap probe: does this brand's key open the first sector it keys?
        probe = next((s for s in range(16) if ka[s] != DEFAULT_KEY), 0)
        ok = mc.auth_sector(probe, [(ka[probe], KEY_A)])
        tried.append(f"{name}[{mc.describe_mode()}]={'ok' if ok else 'no'}")
        if not ok:
            log.debug("%s: probe auth failed on sector %d (%s)", name, probe, mc.describe_mode())
            continue
        opened = True
        t.reselect()
        data, failed = mc.dump(ka, kb)
        out.raw, out.unreadable_sectors = data, failed
        try:
            res = decode_classic(name, proc, scan, data)
        except Exception as e:
            log.debug("%s decode error: %s", name, e)
            res = None
        if res:
            out.status, out.decoder = "decoded", name
            out.filament, out.extras, out.spool_id = res
            return True
        t.reselect()
    return opened


def scan_tag(t: Transport, classic_procs, ultra_procs) -> ScanOutcome:
    uid = get_uid(t)
    atr = t.atr()
    ttype = detect_type(atr, uid)
    out = ScanOutcome(uid=uid, tag_type=ttype, atr=atr, spool_id=None)
    scan = make_scan_result(ttype, uid)

    if ttype == TagType.MifareClassic1k:
        mc = Classic(t)
        tried = []
        for mode in range(len(mc.MODES)):
            mc.mode = mode
            opened = _probe_and_decode(t, mc, classic_procs, scan, out, tried)
            if opened:
                break
        if out.status != "decoded" and tried:
            out.extras = {"probed": tried}
    else:
        try:
            data = read_ultralight(t)
        except ApduError as e:
            out.status, out.error = "read_error", str(e)
            return out
        out.raw = data
        res = decode_ultralight(ultra_procs, scan, data)
        if res:
            out.status, out.decoder = "decoded", res[0]
            out.filament = res[1]

    if out.spool_id is None:
        out.spool_id = "uid:" + uid.hex().upper()
    return out
