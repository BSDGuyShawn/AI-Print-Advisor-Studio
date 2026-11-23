"""Brand decoders.

The byte-level parsing for each brand comes from OpenRFID (GPL-3.0), vendored
unmodified under ``_vendor/openrfid``. This module builds the processors with
the publicly documented keys and adds a few Bambu-specific extras.
"""
from __future__ import annotations

import logging
import struct
import sys
from pathlib import Path

_VENDOR = Path(__file__).resolve().parent / "_vendor" / "openrfid"
if str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))

from reader.scan_result import ScanResult  # noqa: E402
from tag.tag_types import TagType  # noqa: E402
from tag.mifare_classic_tag_processor import MifareClassicTagProcessor, TagAuthentication  # noqa: E402
from tag.tag_processor import TagProcessor  # noqa: E402
from tag.bambu.processor import BambuTagProcessor  # noqa: E402
from tag.creality.processor import CrealityTagProcessor  # noqa: E402
from tag.snapmaker.processor import SnapmakerTagProcessor  # noqa: E402
from tag.qidi.processor import QidiTagProcessor  # noqa: E402
from tag.anycubic.processor import AnycubicTagProcessor  # noqa: E402
from tag.elegoo.processor import ElegooTagProcessor  # noqa: E402
from tag.openspool.processor import OpenspoolTagProcessor  # noqa: E402
from tag.opentag3d import OpenTag3DTagProcessor  # noqa: E402
from tag.spoolease.processor import SpooleaseTagProcessor  # noqa: E402
from tag.tigertag.processor import TigerTagProcessor  # noqa: E402
import tag.bambu.constants as BambuC  # noqa: E402

log = logging.getLogger("spoolscan.decoders")

# Publicly documented keys. OpenRFID checks each against a SHA-256 hash and
# disables the processor if it doesn't match, so a typo fails loudly.
#  - Bambu: HKDF salt from Bambu-Research-Group/RFID-Tag-Guide (deriveKeys.py)
#  - Creality: AES keys from the CFS research (cfs-programmer docs/TAG_FORMAT.md)
#  - Snapmaker: HKDF salt used by OpenRFID's own reader/test code
DEFAULT_KEYS = {
    "bambu": {"key": "9a759cf2c4f7caff222cb9769b41bc96"},
    "creality": {
        "key": "713362755e74316e71665a2870662431",
        "encryption_key": "484043466b526e7a404b4174424a7032",
    },
    "snapmaker": {"key": "536e61706d616b65725f71776572747975696f705b2c2e3b5d5f317132773365"},
}

# Order matters for MIFARE Classic: the probe tries each brand's keys in turn,
# and QIDI (factory-default keys) goes last so it doesn't claim keyed tags.
CLASSIC_DECODERS = [
    ("bambu", BambuTagProcessor),
    ("snapmaker", SnapmakerTagProcessor),
    ("creality", CrealityTagProcessor),
    ("qidi", QidiTagProcessor),
]

ULTRALIGHT_DECODERS = [
    ("opentag3d", OpenTag3DTagProcessor),
    ("openspool", OpenspoolTagProcessor),
    ("spoolease", SpooleaseTagProcessor),
    ("tigertag", TigerTagProcessor),
    ("anycubic", AnycubicTagProcessor),
    ("elegoo", ElegooTagProcessor),
]


def build_processors(overrides: dict | None = None):
    keys = {k: dict(v) for k, v in DEFAULT_KEYS.items()}
    for brand, vals in (overrides or {}).items():
        keys.setdefault(brand, {}).update(vals)

    classic, ultra = [], []
    for name, cls in CLASSIC_DECODERS:
        cfg = {"__name": name, **keys.get(name, {})}
        p = cls(cfg)
        if p.enabled:
            classic.append((name, p))
        else:
            log.warning("decoder %s disabled (key missing or wrong)", name)
    for name, cls in ULTRALIGHT_DECODERS:
        ultra.append((name, cls({"__name": name})))
    return classic, ultra


def make_scan_result(tag_type: TagType, uid: bytes) -> ScanResult:
    bcc = 0
    for b in uid[:4]:
        bcc ^= b
    sak = b"\x08" if tag_type == TagType.MifareClassic1k else b"\x00"
    return ScanResult(tag_type=tag_type, uid=uid, atqa=b"\x00\x00", bcc=bytes([bcc]), sak=sak)


def argb_to_hex(argb: int) -> str:
    return f"#{argb & 0xFFFFFF:06X}"


def filament_to_json(filament) -> dict:
    d = filament.to_dict()
    colors = d.get("colors") or []
    return {
        "manufacturer": d["manufacturer"],
        "material": d["type"],
        "modifiers": d["modifiers"],
        "name": " ".join([d["manufacturer"], d["type"], *d["modifiers"]]).strip(),
        "color_hex": argb_to_hex(colors[0]) if colors else None,
        "colors_hex": [argb_to_hex(c) for c in colors],
        "colors_rgba_hex": d.get("colors_rgba_hex", []),
        "diameter_mm": round(float(d["diameter_mm"]), 3),
        "weight_g": d["weight_grams"],
        "nozzle_temp_min_c": d["hotend_min_temp_c"],
        "nozzle_temp_max_c": d["hotend_max_temp_c"],
        "bed_temp_c": d["bed_temp_c"],
        "drying_temp_c": d["drying_temp_c"],
        "drying_time_h": d["drying_time_hours"],
        "manufacturing_date": d["manufacturing_date"],
        "td_mm": d.get("td") or None,
        "product_id": d["unique_id"],
    }


def _s(data: bytes, pos: int, n: int) -> str:
    return data[pos:pos + n].split(b"\x00", 1)[0].decode("ascii", errors="ignore").strip()


def bambu_extras(data: bytes) -> dict:
    """Fields OpenRFID parses but doesn't return (per BambuLabRfid.md)."""
    tray_uid = data[BambuC.TRAY_UID_POS:BambuC.TRAY_UID_POS + BambuC.TRAY_UID_LEN]
    return {
        "tray_uid": tray_uid.hex().upper(),  # same on both tags of a spool
        "material_id": _s(data, BambuC.MATERIAL_ID_POS, BambuC.MATERIAL_ID_LEN),
        "material_variant_id": _s(data, BambuC.MATERIAL_VARIANT_ID_POS, BambuC.MATERIAL_VARIANT_ID_LEN),
        "detailed_type": _s(data, BambuC.DETAILED_FILAMENT_TYPE_POS, BambuC.DETAILED_FILAMENT_TYPE_LEN),
        "production_datetime": _s(data, BambuC.PRODUCTION_DATETIME_POS, BambuC.PRODUCTION_DATETIME_LEN),
        "filament_length_m": struct.unpack_from("<H", data, BambuC.FILAMENT_LENGTH_POS)[0],
        "nozzle_diameter_mm": round(struct.unpack_from("<f", data, BambuC.NOZZLE_DIAMETER_POS)[0], 2),
        "spool_width_um": struct.unpack_from("<H", data, BambuC.SPOOL_WIDTH_POS)[0],
    }


def decode_classic(name: str, proc: TagProcessor, scan: ScanResult, data: bytes):
    """Return (filament_json, extras, spool_id) or None."""
    filament = proc.process_tag(scan, data)
    if filament is None:
        return None
    fj = filament_to_json(filament)
    extras, spool_id = {}, None
    if name == "bambu":
        extras = bambu_extras(data)
        spool_id = "bambu:" + extras["tray_uid"]
    return fj, extras, spool_id


def decode_ultralight(processors, scan: ScanResult, data: bytes):
    """Try each NTAG/Ultralight decoder; return (name, filament_json) or None."""
    for name, proc in processors:
        try:
            filament = proc.process_tag(scan, data)
        except Exception as e:  # decoders raise on foreign formats
            log.debug("%s: %s", name, e)
            continue
        if filament is not None:
            return name, filament_to_json(filament)
    return None
