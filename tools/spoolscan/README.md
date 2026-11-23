# spoolscan

> In AI 3D Print Advisor Studio this is the program behind **Filament → Settings → Scan spool tags**. The app runs
> `spoolscan watch --emit-status` in the background (see `src/nfc.js`); releases ship it built with
> `tools/build_spoolscan.py`. It also works on its own, as described below.

Read-only scanner for the RFID/NFC tags on filament spools. It runs in the background and emits one JSON record per spool you tap on a USB PC/SC reader. Built and tested for the Cryptnox contactless reader, and it should work with any PC/SC reader that supports MIFARE Classic (ACR122U, ACR1252U, ACR1552U, …).

**It never writes to a tag.** It sends only these commands: get UID, load key (into the reader), authenticate, and read. There's no write command (`FF D6`) anywhere in the code, and the tests fail if one is ever sent.

## Supported tags

| Brand / format | Chip | Notes |
|---|---|---|
| Bambu Lab | MIFARE Classic 1K | Keys derived from the UID. `spool_id` uses the tray UID, which is the same on both tags of a spool |
| Snapmaker (U1) | MIFARE Classic 1K | RSA signature verified, so a decode is a genuine Snapmaker tag |
| Creality (CFS) | MIFARE Classic 1K | AES-encrypted payload decrypted |
| QIDI (QIDI Box) | MIFARE Classic 1K | Default keys |
| Anycubic (ACE) | NTAG | |
| Elegoo | NTAG | |
| OpenSpool, OpenTag3D, SpoolEase, TigerTag | NTAG / NDEF | |
| **Prusa OpenPrintTag** | ISO 15693 (NFC-V) | **Not readable on the Cryptnox.** It's an ISO 14443-only reader. Use an ACR1552U or a phone |

Unrecognized tags still produce a record with the UID and type (add `--raw` for the full memory dump), so you can still use them as spool IDs.

## Install

Python 3.10+.

```bash
cd spoolscan
pip install .            # Windows: py -m pip install .
spoolscan readers        # should list the Cryptnox
spoolscan once           # tap a spool; prints pretty JSON
```

Linux also needs `pcscd` (`sudo apt install pcscd libccid`). Windows and macOS work out of the box.

## Run in the background

```bash
spoolscan watch --out ~/spoolscan/spools.jsonl --latest ~/spoolscan/latest.json
```

- `--out FILE`: appends one JSON line per scan. This is the permanent log.
- `--latest FILE`: overwritten on every scan with the latest record, so other tools can poll it.
- `--webhook URL`: POSTs each record as JSON (Home Assistant, Node-RED, n8n, Spoolman glue, your own API…).
- `--quiet`: no stdout. `--raw` adds the full tag memory as hex. `--emit-removed` also logs when a spool leaves the reader.
- `--dedupe N`: ignores the same spool for N seconds (default 3), so flipping a Bambu spool to its second tag doesn't double-log.

It keeps running while the reader is unplugged and replugged. On Windows the Smart Card service stops when no reader is attached; spoolscan waits and reconnects when it comes back.

**Windows autostart (no console window):** `powershell -ExecutionPolicy Bypass -File scripts\install-windows-task.ps1` (optional `-Webhook http://...`). Logs go to `%USERPROFILE%\spoolscan\spoolscan.log`.

**Linux:** see `scripts/spoolscan.service` (systemd user unit).

You can also pipe it: `spoolscan watch | your-ingest-script`. Logs go to stderr, JSON to stdout.

## Output

```json
{
  "event": "tag_scanned",
  "timestamp": "2026-11-22T23:19:19+00:00",
  "reader": "<your PC/SC reader name>",
  "status": "decoded",
  "decoder": "bambu",
  "spool_id": "bambu:D7AC3B89A16B47C4B061728044E1F2D5",
  "tag": { "uid": "75886B1D", "type": "MifareClassic1k", "atr": "3B8F…6A" },
  "filament": {
    "manufacturer": "Bambu", "material": "PLA", "modifiers": ["Basic"], "name": "Bambu PLA Basic",
    "color_hex": "#FF6A13", "colors_hex": ["#FF6A13"], "colors_rgba_hex": ["FF6A13FF"],
    "diameter_mm": 1.75, "weight_g": 250,
    "nozzle_temp_min_c": 220, "nozzle_temp_max_c": 220, "bed_temp_c": 45,
    "drying_temp_c": 55, "drying_time_h": 8,
    "manufacturing_date": "2022-10-15", "td_mm": null,
    "product_id": "200e6462…"
  },
  "extras": {
    "tray_uid": "D7AC3B89A16B47C4B061728044E1F2D5", "material_id": "GFA00",
    "material_variant_id": "A00-A0", "detailed_type": "PLA Basic",
    "production_datetime": "2022_10_15_08_26", "filament_length_m": 82,
    "nozzle_diameter_mm": 0.2, "spool_width_um": 6625
  }
}
```

- `status`: `decoded`, `unrecognized` (the tag was read but no decoder matched; `filament` is `null`), or `read_error`.
- `spool_id`: a stable key for your database. It's the Bambu tray UID when available, otherwise `uid:<tag UID>`.
- `product_id`: a hash of the product attributes. It's the same for every spool of the same SKU, so use it to group spools by product.
- `extras`: only present for Bambu right now.

## Troubleshooting

- **`spoolscan once --trace`** prints every command and reply, with keys masked. If authentication fails on every brand with the Cryptnox, send me that output. The fix is usually a different PC/SC key slot or authenticate variant, and the code already tries the common two.
- Hold the spool still for about half a second. A Classic tag takes 16 authenticate/read rounds.
- Bambu spools have a tag on each side. Either one works.
- `spoolscan decode dump.bin` decodes a saved 1K/NTAG image (for example from a Proxmark, or the `raw_hex` from `--raw` saved with `--hex`).

## Credits and license

The brand decoders are vendored unmodified from [OpenRFID](https://github.com/suchmememanyskill/OpenRFID) by suchmememanyskill (GPL-3.0), commit `a13bc9e`, in `spoolscan/_vendor/openrfid`. The tag formats and keys come from public community research: [Bambu-Research-Group/RFID-Tag-Guide](https://github.com/Bambu-Research-Group/RFID-Tag-Guide) and the Creality CFS work. Because the decoders are GPL, spoolscan is GPL-3.0 too (see `LICENSE`).

Run the tests with `pip install .[test] && pytest`. They simulate the reader with real tag dumps from all ten formats.
