"""Tests run against a simulated PC/SC reader using real tag dumps."""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from spoolscan.cardio import scan_tag, detect_type  # noqa: E402
from spoolscan.decoders import (  # noqa: E402
    build_processors, make_scan_result, TagType, filament_to_json, DEFAULT_KEYS,
)
from spoolscan.cli import outcome_to_record, main  # noqa: E402

FIX = ROOT / "tests" / "fixtures"
CLASSIC, ULTRA = build_processors()

ATR_1K = bytes.fromhex("3B8F8001804F0CA000000306030001000000006A")
ATR_UL = bytes.fromhex("3B8F8001804F0CA0000003060300030000000068")


class SimClassic:
    """MIFARE Classic 1K behind a PC/SC reader. Halts after a failed auth."""

    def __init__(self, image: bytes, key_a, key_b=None, atr=ATR_1K, quirk=None):
        self.img, self.ka, self.kb = image, key_a, key_b or [None] * 16
        self.quirk = quirk  # None | "slot1" | "legacy88"
        self.slots = {}
        self._atr = atr
        self.loaded = None
        self.authed = None
        self.halted = False
        self.sent = []

    def atr(self):
        return self._atr

    def reselect(self):
        self.halted, self.authed = False, None

    def transmit(self, apdu):
        self.sent.append(list(apdu))
        cla, ins = apdu[0], apdu[1]
        assert cla == 0xFF
        assert ins != 0xD6, "write command sent!"
        if ins == 0xCA:
            return list(self.img[:4]), 0x90, 0x00
        if ins == 0x82:
            self.slots[apdu[3]] = bytes(apdu[5:11])
            return [], 0x90, 0x00
        if ins in (0x86, 0x88):
            if ins == 0x86:
                block, kt, slot = apdu[7], apdu[8], apdu[9]
            else:
                block, kt, slot = apdu[3], apdu[4], apdu[5]
            if (self.quirk == "legacy88" and ins == 0x86) or (self.quirk == "slot1" and slot != 1):
                self.halted, self.authed = True, None
                return [], 0x63, 0x00
            self.loaded = self.slots.get(slot)
            sector = block // 4
            want = self.ka[sector] if kt == 0x60 else self.kb[sector]
            if self.halted or want is None or self.loaded != want:
                self.halted, self.authed = True, None
                return [], 0x63, 0x00
            self.authed = sector
            return [], 0x90, 0x00
        if ins == 0xB0:
            block = apdu[3]
            if self.halted or self.authed != block // 4:
                return [], 0x69, 0x82
            d = bytearray(self.img[block * 16:(block + 1) * 16])
            if block % 4 == 3:
                d[0:6] = bytes(6)  # Key A is never readable
            return list(d), 0x90, 0x00
        return [], 0x6D, 0x00


class SimUltralight:
    def __init__(self, image: bytes, four_byte_reads=False):
        self.img = image
        self.pages = len(image) // 4
        self.fb = four_byte_reads

    def atr(self):
        return ATR_UL

    def reselect(self):
        pass

    def transmit(self, apdu):
        assert apdu[1] != 0xD6, "write command sent!"
        if apdu[1] == 0xCA:
            return list(self.img[0:3] + self.img[4:8]), 0x90, 0x00
        if apdu[1] == 0xB0:
            p = apdu[3]
            if p >= self.pages:
                return [], 0x6A, 0x82
            n = 4 if self.fb else 16
            d = self.img[p * 4:p * 4 + n]
            d = d + self.img[:n - len(d)]  # NTAG READ rolls over
            return list(d), 0x90, 0x00
        return [], 0x6D, 0x00


def brand_keys(brand, uid):
    proc = dict(CLASSIC)[brand]
    auth = proc.authenticate_tag(make_scan_result(TagType.MifareClassic1k, uid))
    ka = [bytes(k) for k in auth.hkdf_key_a]
    kb = [bytes(k) if any(k) else None for k in auth.hkdf_key_b]
    return ka, kb


def oracle(brand_cls_name, data, tag_type):
    """What OpenRFID itself returns for the raw fixture (same UID as the sim card)."""
    procs = dict(CLASSIC + ULTRA)
    uid = data[:4] if tag_type == TagType.MifareClassic1k else data[0:3] + data[4:8]
    f = procs[brand_cls_name].process_tag(make_scan_result(tag_type, uid), data)
    return filament_to_json(f)


# --------------------------------------------------------------- key derivation
def trailer_keys(img):
    """Key A of each sector, as stored in the trailers of OpenRFID's dumps of real tags (the keys that opened them)."""
    return [img[s * 64 + 48:s * 64 + 54] for s in range(16)]


BAMBU_DUMPS = sorted((FIX / "Bambu").glob("*.bin"))


@pytest.mark.parametrize("path", BAMBU_DUMPS, ids=lambda p: p.stem)
def test_bambu_kdf_matches_keys_from_real_tags(path):
    img = path.read_bytes()
    ka, _ = brand_keys("bambu", img[:4])
    assert ka == trailer_keys(img)


def test_creality_kdf_matches_published_example():
    ka, _ = brand_keys("creality", bytes.fromhex("60EA1221"))
    assert ka[1] == bytes.fromhex("1F1E83A97182")


def test_all_classic_decoders_enabled():
    assert [n for n, _ in CLASSIC] == ["bambu", "snapmaker", "creality", "qidi"]


# --------------------------------------------- end to end through the sim reader
def test_bambu_dump_with_keys_from_the_tag():
    """Card keys come from the dump itself, not from our KDF."""
    img = BAMBU_DUMPS[0].read_bytes()
    o = scan_tag(SimClassic(img, trailer_keys(img)), CLASSIC, ULTRA)
    assert o.status == "decoded" and o.decoder == "bambu"
    assert o.spool_id.startswith("bambu:")
    assert o.filament["manufacturer"] == "Bambu"


CLASSIC_CASES = (
    [("bambu", p) for p in sorted((FIX / "Bambu").glob("*.bin"))]
    + [("snapmaker", p) for p in sorted((FIX / "Snapmaker").glob("*.bin"))]
    + [("creality", p) for p in sorted((FIX / "Creality").glob("*.bin"))]
    + [("qidi", p) for p in sorted((FIX / "Qidi").glob("*.bin"))]
)


@pytest.mark.parametrize("brand,path", CLASSIC_CASES, ids=lambda x: getattr(x, "stem", x))
def test_classic_fixture_via_reader(brand, path):
    img = path.read_bytes()
    uid = img[:4]
    ka, kb = brand_keys(brand, uid)
    sim = SimClassic(img, ka, kb)
    o = scan_tag(sim, CLASSIC, ULTRA)
    assert o.status == "decoded", (o.status, o.unreadable_sectors)
    assert o.decoder == brand
    assert o.filament == oracle(brand, img, TagType.MifareClassic1k)
    assert not any(a[1] == 0xD6 for a in sim.sent)


UL_DIRS = {"OpenSpool": "openspool", "OpenTag3D": "opentag3d", "SpoolEase": "spoolease",
           "Tigertag": "tigertag", "Anycubic": "anycubic", "Elegoo": "elegoo"}
UL_CASES = [(b, p) for d, b in UL_DIRS.items() for p in sorted((FIX / d).glob("*.bin"))]


@pytest.mark.parametrize("brand,path", UL_CASES, ids=lambda x: getattr(x, "stem", x))
@pytest.mark.parametrize("four_byte", [False, True], ids=["16B-reads", "4B-reads"])
def test_ultralight_fixture_via_reader(brand, path, four_byte):
    img = path.read_bytes()
    o = scan_tag(SimUltralight(img, four_byte), CLASSIC, ULTRA)
    assert o.status == "decoded", o
    assert o.decoder == brand
    assert o.raw[:len(img)] == img[:len(o.raw)]
    assert o.filament == oracle(brand, img, TagType.MifareUltralight)


def test_unknown_classic_tag_is_reported_not_crashed():
    img = bytearray(1024)
    img[:4] = bytes.fromhex("DEADBEEF")
    o = scan_tag(SimClassic(bytes(img), [bytes.fromhex("112233445566")] * 16), CLASSIC, ULTRA)
    assert o.status == "unrecognized"
    rec = outcome_to_record(o, "sim", True)
    assert rec["tag"]["uid"] == "DEADBEEF" and rec["filament"] is None


def test_blank_default_key_tag_is_unrecognized():
    img = bytearray(1024)
    img[:4] = bytes.fromhex("01020304")
    o = scan_tag(SimClassic(bytes(img), [b"\xff" * 6] * 16), CLASSIC, ULTRA)
    assert o.status == "unrecognized" and o.raw is not None


def test_detect_type_fallback():
    assert detect_type(b"", b"1234") == TagType.MifareClassic1k
    assert detect_type(b"", b"1234567") == TagType.MifareUltralight
    assert detect_type(ATR_UL, b"1234") == TagType.MifareUltralight


def test_decode_command(capsys):
    p = sorted((FIX / "Snapmaker").glob("*.bin"))[0]
    assert main(["decode", str(p)]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["decoder"] == "snapmaker" and out["filament"]["material"] == "PLA"


# ------------------------------------------------------------ monitor loop
def test_monitor_survives_service_outage_and_detects_insert_remove(monkeypatch):
    import threading
    from smartcard import scard as real
    import spoolscan.pcsc as pcsc

    stop = threading.Event()
    # timeline of what the fake PC/SC layer reports, advanced per GetStatusChange
    phases = ["noservice", "empty", "card", "card", "empty", "done"]
    st = {"i": 0, "ctx_calls": 0}

    class Fake:
        def __getattr__(self, n):
            return getattr(real, n)

        def SCardEstablishContext(self, scope):
            st["ctx_calls"] += 1
            if phases[st["i"]] == "noservice":
                st["i"] += 1
                return real.SCARD_E_NO_SERVICE, None
            return real.SCARD_S_SUCCESS, 1

        def SCardReleaseContext(self, c):
            return 0

        def SCardListReaders(self, c, g):
            return real.SCARD_S_SUCCESS, ["Cryptnox Reader 0"]

        def SCardGetStatusChange(self, c, timeout, states):
            ph = phases[min(st["i"], len(phases) - 1)]
            if ph == "done":
                stop.set()
                return real.SCARD_E_TIMEOUT, []
            blocking = all(s != real.SCARD_STATE_UNAWARE for _, s in states)
            if blocking:
                st["i"] += 1
                return real.SCARD_S_SUCCESS, []
            state = real.SCARD_STATE_PRESENT if ph == "card" else real.SCARD_STATE_EMPTY
            return real.SCARD_S_SUCCESS, [("Cryptnox Reader 0", state | real.SCARD_STATE_CHANGED, [])]

    events = []
    statuses = []
    monkeypatch.setattr(pcsc, "s", Fake())
    monkeypatch.setattr(pcsc, "time", type("T", (), {"sleep": staticmethod(lambda x: None)}))
    monkeypatch.setattr(pcsc, "_scan_reader", lambda name, h: events.append(("insert", name)))
    pcsc.run_monitor(lambda *a: None, lambda name: events.append(("remove", name)), "cryptnox", stop,
                     on_status=lambda st, rs: statuses.append((st, rs)))
    assert events == [("insert", "Cryptnox Reader 0"), ("remove", "Cryptnox Reader 0")]
    assert statuses == [("no_service", []), ("watching", ["Cryptnox Reader 0"])]
    assert st["ctx_calls"] >= 2


def test_reselect_falls_back_when_driver_rejects_reconnect(monkeypatch):
    """Cryptnox on Windows: reconnect fails, first connect fails mid-reset."""
    import spoolscan.pcsc as pcsc
    from smartcard.Exceptions import CardConnectionException

    class Conn:
        def __init__(self):
            self.hcard, self.connects = 1, 0

        def reconnect(self, **kw):
            self.hcard = None
            raise CardConnectionException("The device does not recognize the command.")

        def disconnect(self):
            pass

        def connect(self, **kw):
            self.connects += 1
            if self.connects < 3:
                raise CardConnectionException("The smart card is not responding to a reset.")
            self.hcard = 1

    monkeypatch.setattr(pcsc.time, "sleep", lambda x: None)
    c = Conn()
    pcsc.PcscTransport(c).reselect()
    assert c.connects == 3


def test_reselect_gives_up_cleanly(monkeypatch):
    import spoolscan.pcsc as pcsc
    from spoolscan.cardio import TagLost
    from smartcard.Exceptions import CardConnectionException

    class Conn:
        hcard = None
        def disconnect(self): pass
        def connect(self, **kw): raise CardConnectionException("nope")

    monkeypatch.setattr(pcsc.time, "sleep", lambda x: None)
    with pytest.raises(TagLost):
        pcsc.PcscTransport(Conn()).reselect()


@pytest.mark.parametrize("quirk", ["slot1", "legacy88"])
def test_reader_auth_quirks_are_worked_around(quirk):
    img = BAMBU_DUMPS[0].read_bytes()
    o = scan_tag(SimClassic(img, trailer_keys(img), quirk=quirk), CLASSIC, ULTRA)
    assert o.status == "decoded" and o.decoder == "bambu"


def test_unrecognized_classic_reports_what_was_probed():
    img = bytearray(1024)
    img[:4] = bytes.fromhex("1D0703F4")
    o = scan_tag(SimClassic(bytes(img), [bytes.fromhex("112233445566")] * 16), CLASSIC, ULTRA)
    assert o.status == "unrecognized"
    assert len(o.extras["probed"]) == 4 * 4  # 4 brands x 4 auth modes


def test_reselect_with_pyscard_decorator_wrapper(monkeypatch):
    """pyscard returns a CardConnectionDecorator without .hcard."""
    import spoolscan.pcsc as pcsc

    class Inner:
        hcard = 1
        def reconnect(self, **kw): self.reconnected = True

    class Decorator:
        def __init__(self): self.component = Inner()
        def reconnect(self, **kw): self.component.reconnect(**kw)

    d = Decorator()
    pcsc.PcscTransport(d).reselect()
    assert d.component.reconnected
