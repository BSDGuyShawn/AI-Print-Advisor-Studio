"""spoolscan: read-only filament spool tag scanner that emits JSON."""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import tempfile
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from . import __version__
from .cardio import ScanOutcome, scan_tag, ApduError
from .decoders import build_processors, make_scan_result, TagType, decode_classic, decode_ultralight

log = logging.getLogger("spoolscan")


def outcome_to_record(o: ScanOutcome, reader: str, include_raw: bool) -> dict:
    rec = {
        "event": "tag_scanned",
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "reader": reader,
        "status": o.status,
        "decoder": o.decoder,
        "spool_id": o.spool_id,
        "tag": {
            "uid": o.uid.hex().upper(),
            "type": o.tag_type.name,
            "atr": o.atr.hex().upper() if o.atr else None,
        },
        "filament": o.filament,
    }
    if o.extras:
        rec["extras"] = o.extras
    if o.unreadable_sectors:
        rec["tag"]["unreadable_sectors"] = o.unreadable_sectors
    if o.error:
        rec["error"] = o.error
    if include_raw and o.raw is not None:
        rec["raw_hex"] = o.raw.hex().upper()
    return rec


class Sinks:
    def __init__(self, args):
        self.stdout = not args.quiet
        self.out = Path(args.out).expanduser() if args.out else None
        self.latest = Path(args.latest).expanduser() if args.latest else None
        self.webhook = args.webhook
        self.lock = threading.Lock()
        for p in (self.out, self.latest):
            if p:
                p.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, rec: dict):
        line = json.dumps(rec, separators=(",", ":"))
        with self.lock:
            if self.stdout:
                print(line, flush=True)
            if self.out:
                with self.out.open("a", encoding="utf-8") as f:
                    f.write(line + "\n")
            if self.latest:
                fd, tmp = tempfile.mkstemp(dir=self.latest.parent, prefix=".spoolscan-")
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(rec, f, indent=2)
                os.replace(tmp, self.latest)
        if self.webhook:
            threading.Thread(target=self._post, args=(line,), daemon=True).start()

    def _post(self, body: str):
        req = urllib.request.Request(self.webhook, data=body.encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(req, timeout=10).read()
        except Exception as e:
            log.error("webhook POST failed: %s", e)


def load_key_overrides(path: str | None) -> dict:
    if not path:
        return {}
    return json.loads(Path(path).expanduser().read_text())


# ----------------------------------------------------------------- commands
def cmd_watch(args):
    from .pcsc import run_monitor
    classic, ultra = build_processors(load_key_overrides(args.keys))
    sinks = Sinks(args)
    recent: dict[str, float] = {}

    def handle(reader, transport):
        t0 = time.time()
        try:
            o = scan_tag(transport, classic, ultra)
        except ApduError as e:
            log.warning("read failed on %s: %s (hold the tag still and try again)", reader, e)
            if args.emit_status:
                sinks.emit({"event": "read_error", "reader": reader, "error": str(e),
                            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds")})
            return
        except Exception:
            log.exception("unexpected error reading tag")
            return
        last = recent.get(o.spool_id)
        recent[o.spool_id] = time.time()
        if last and time.time() - last < args.dedupe:
            log.info("same spool %s within %.0fs, not re-emitting", o.spool_id, args.dedupe)
            return
        log.info("%s %s in %.2fs", o.status, o.decoder or "", time.time() - t0)
        sinks.emit(outcome_to_record(o, reader, args.raw))

    def removed(reader):
        if args.emit_removed:
            sinks.emit({"event": "tag_removed", "reader": reader,
                        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds")})

    log.info("spoolscan %s watching for tags (Ctrl+C to stop)", __version__)
    try:
        def on_status(state, readers):
            if args.emit_status:
                sinks.emit({"event": "reader_status", "state": state, "readers": readers,
                            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds")})

        run_monitor(handle, removed, args.reader, on_status=on_status)
    except KeyboardInterrupt:
        pass


def cmd_once(args):
    from .pcsc import connect_first
    classic, ultra = build_processors(load_key_overrides(args.keys))
    reader, t = connect_first(args.reader, args.timeout, trace=args.trace)
    if args.trace:
        print(f"reader: {reader}\nATR: {t.atr().hex().upper()}", flush=True)
    try:
        o = scan_tag(t, classic, ultra)
    except ApduError as e:
        print(f"spoolscan: read failed: {e}\nHold the spool still on the reader and try again; "
              "if it keeps failing, run `spoolscan once --trace` and share the output.", file=sys.stderr)
        return 5
    finally:
        t.close()
    rec = outcome_to_record(o, reader, args.raw)
    print(json.dumps(rec, indent=2))
    return 0 if o.status == "decoded" else 2


def cmd_readers(args):
    from smartcard.System import readers
    rs = readers()
    if not rs:
        print("No PC/SC readers found. Is the reader plugged in (and pcscd running on Linux)?")
        return 1
    for r in rs:
        print(r)
    return 0


def cmd_decode(args):
    """Decode a saved 1K / NTAG dump file (e.g. from a Proxmark or --raw)."""
    data = Path(args.file).read_bytes()
    if args.hex:
        data = bytes.fromhex(data.decode().strip())
    classic, ultra = build_processors(load_key_overrides(args.keys))
    if len(data) == 1024:
        uid = data[:4]
        scan = make_scan_result(TagType.MifareClassic1k, uid)
        for name, proc in classic:
            try:
                res = decode_classic(name, proc, scan, data)
            except Exception as e:
                log.debug("%s: %s", name, e)
                continue
            if res:
                fj, extras, sid = res
                print(json.dumps({"status": "decoded", "decoder": name, "spool_id": sid or f"uid:{uid.hex().upper()}",
                                  "filament": fj, **({"extras": extras} if extras else {})}, indent=2))
                return 0
    else:
        uid = data[:3] + data[4:8]
        scan = make_scan_result(TagType.MifareUltralight, uid)
        res = decode_ultralight(ultra, scan, data)
        if res:
            print(json.dumps({"status": "decoded", "decoder": res[0], "filament": res[1]}, indent=2))
            return 0
    print(json.dumps({"status": "unrecognized"}))
    return 2


def main(argv=None):
    ap = argparse.ArgumentParser(prog="spoolscan", description=__doc__)
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--log-file", help="write logs here instead of stderr (useful when run in the background)")
    ap.add_argument("--version", action="version", version=__version__)
    sub = ap.add_subparsers(dest="cmd")

    def common(p):
        p.add_argument("--reader", help="only use readers whose name contains this text")
        p.add_argument("--raw", action="store_true", help="include the full tag memory as hex")
        p.add_argument("--keys", help="JSON file overriding decoder keys (normally not needed)")

    w = sub.add_parser("watch", help="run in the background and emit JSON for every tag (default)")
    common(w)
    w.add_argument("--out", help="append JSON Lines to this file")
    w.add_argument("--latest", help="overwrite this file with the most recent scan")
    w.add_argument("--webhook", help="POST each scan as JSON to this URL")
    w.add_argument("--quiet", action="store_true", help="don't print JSON to stdout")
    w.add_argument("--dedupe", type=float, default=3.0,
                   help="seconds to ignore the same spool re-scanned (default 3)")
    w.add_argument("--emit-removed", action="store_true", help="also emit tag_removed events")
    w.add_argument("--emit-status", action="store_true",
                   help="also emit reader_status and read_error events (for apps showing reader state)")

    o = sub.add_parser("once", help="wait for one tag, print pretty JSON, exit")
    common(o)
    o.add_argument("--timeout", type=float, default=30)
    o.add_argument("--trace", action="store_true", help="show every APDU (keys masked)")

    sub.add_parser("readers", help="list PC/SC readers")

    d = sub.add_parser("decode", help="decode a saved dump file")
    d.add_argument("file")
    d.add_argument("--hex", action="store_true", help="file contains hex text, not binary")
    d.add_argument("--keys")

    argv = list(sys.argv[1:] if argv is None else argv)
    if not any(a in sub.choices for a in argv) and not any(a in ("-h", "--help", "--version") for a in argv):
        argv.append("watch")  # bare `spoolscan` / `spoolscan -v` == watch
    args = ap.parse_args(argv)
    log_kw = {"filename": args.log_file} if args.log_file else {"stream": sys.stderr}
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s", **log_kw)
    if not args.verbose:
        # Decoders log "not my format" chatter while probing; keep it quiet.
        from .decoders import CLASSIC_DECODERS, ULTRALIGHT_DECODERS
        for n, _ in CLASSIC_DECODERS + ULTRALIGHT_DECODERS:
            logging.getLogger(f"tag_processor:{n}").setLevel(logging.CRITICAL)
        logging.getLogger().setLevel(logging.INFO)

    try:
        return {"watch": cmd_watch, "once": cmd_once, "readers": cmd_readers, "decode": cmd_decode}[args.cmd](args) or 0
    except TimeoutError as e:
        print(f"spoolscan: {e}", file=sys.stderr)
        return 3
    except Exception as e:
        if type(e).__name__ == "EstablishContextException":
            print("spoolscan: PC/SC service not available. Plug in the reader "
                  "(Windows starts the Smart Card service then); on Linux install and start pcscd.",
                  file=sys.stderr)
            return 4
        raise


if __name__ == "__main__":
    sys.exit(main())
