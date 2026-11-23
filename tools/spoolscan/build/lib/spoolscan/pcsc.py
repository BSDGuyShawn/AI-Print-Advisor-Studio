"""pyscard glue: a Transport for a live card, and a background card watcher."""
from __future__ import annotations

import logging
import threading
import time

from smartcard import scard as s
from smartcard.System import readers as list_readers
from smartcard.pcsc.PCSCReader import PCSCReader
from smartcard.Exceptions import CardConnectionException, NoCardException
from smartcard.scard import SCARD_SHARE_SHARED
from smartcard.util import toHexString

from .cardio import TagLost

log = logging.getLogger("spoolscan.pcsc")


class PcscTransport:
    def __init__(self, connection, trace: bool = False):
        self.c = connection
        self.trace = trace

    def transmit(self, apdu):
        data, sw1, sw2 = self.c.transmit(list(apdu))
        if self.trace:
            # Never print key bytes from LOAD KEY
            shown = apdu[:5] + ["**"] * 6 if apdu[:2] == [0xFF, 0x82] else apdu
            print(f"  >> {' '.join(x if isinstance(x, str) else f'{x:02X}' for x in shown)}"
                  f"   << {toHexString(data)} {sw1:02X}{sw2:02X}", flush=True)
        return data, sw1, sw2

    def reselect(self):
        """Get the tag back to a fresh state after a failed MIFARE auth.

        Drivers differ: some reject UNPOWER (e.g. Cryptnox on Windows), and a
        reset takes a moment to finish. Try a warm reset first, then fall back
        to a plain reconnect with retries.
        """
        # pyscard may wrap the connection in a decorator; the PC/SC handle
        # lives on the innermost component.
        inner = self.c
        while hasattr(inner, "component"):
            inner = inner.component
        for disp in (s.SCARD_RESET_CARD, s.SCARD_UNPOWER_CARD):
            if getattr(inner, "hcard", None) is None:
                break
            try:
                self.c.reconnect(mode=SCARD_SHARE_SHARED, disposition=disp)
                if self.trace:
                    print(f"  -- reselect ok (disposition {disp})", flush=True)
                return
            except Exception as e:
                log.debug("reconnect disposition %s failed: %s", disp, e)
                if self.trace:
                    print(f"  -- reconnect (disposition {disp}) failed: {e}", flush=True)
        try:
            self.c.disconnect()
        except Exception:
            pass
        last = None
        for attempt in range(15):  # ~3 s total
            time.sleep(0.05 if attempt == 0 else 0.2)
            try:
                self.c.connect(mode=SCARD_SHARE_SHARED)
                if self.trace:
                    print(f"  -- reselect ok after reconnect (attempt {attempt + 1})", flush=True)
                return
            except NoCardException as e:
                raise TagLost("tag removed during read") from e
            except CardConnectionException as e:
                last = e
        raise TagLost(f"could not re-select tag: {last}")

    def atr(self):
        return bytes(self.c.getATR())

    def close(self):
        try:
            self.c.disconnect()
        except Exception:
            pass


_SERVICE_GONE = {s.SCARD_E_NO_SERVICE, s.SCARD_E_SERVICE_STOPPED, s.SCARD_E_INVALID_HANDLE}


def run_monitor(handle_card, handle_removed, reader_filter: str | None = None,
                stop: threading.Event | None = None, on_status=None):
    """Block until stopped, calling handle_card(reader_name, transport) for each tag placed.

    Survives the reader being unplugged/replugged and the PC/SC service
    stopping (Windows stops it when no reader is attached).
    """
    stop = stop or threading.Event()
    ctx = None
    present: dict[str, bool] = {}
    waiting_logged = False
    last_status = [None]

    def status(state, names=()):
        key = (state, tuple(sorted(names)))
        if key != last_status[0]:
            last_status[0] = key
            if on_status:
                on_status(state, sorted(names))

    def wanted(name):
        return not reader_filter or reader_filter.lower() in name.lower()

    while not stop.is_set():
        if ctx is None:
            hr, ctx = s.SCardEstablishContext(s.SCARD_SCOPE_USER)
            if hr != s.SCARD_S_SUCCESS:
                ctx = None
                status("no_service")
                if not waiting_logged:
                    log.warning("PC/SC service not available yet (plug in the reader); retrying...")
                    waiting_logged = True
                time.sleep(3)
                continue

        hr, names = s.SCardListReaders(ctx, [])
        if hr in _SERVICE_GONE:
            s.SCardReleaseContext(ctx)
            ctx = None
            continue
        names = [n for n in (names if hr == s.SCARD_S_SUCCESS else []) if wanted(n)]
        if not names:
            status("no_reader")
            if not waiting_logged:
                log.warning("no matching reader connected; waiting...")
                waiting_logged = True
            present.clear()
            time.sleep(2)
            continue
        status("watching", names)
        if waiting_logged or set(names) != set(present):
            log.info("watching: %s", ", ".join(names))
            waiting_logged = False
        for gone in set(present) - set(names):
            present.pop(gone, None)

        states = [(n, s.SCARD_STATE_UNAWARE) for n in names]
        hr, new = s.SCardGetStatusChange(ctx, 1000, states)
        if hr in _SERVICE_GONE:
            s.SCardReleaseContext(ctx)
            ctx = None
            continue
        if hr != s.SCARD_S_SUCCESS:
            continue  # timeout or reader list changed; loop re-lists readers

        for name, state, _atr in new:
            is_present = bool(state & s.SCARD_STATE_PRESENT) and not (state & s.SCARD_STATE_MUTE)
            was_present = present.get(name, False)
            present[name] = is_present
            if is_present and not was_present:
                _scan_reader(name, handle_card)
            elif was_present and not is_present:
                handle_removed(name)

        # Block until something changes (or 1s passes, to notice new readers).
        states = [(n, st & ~s.SCARD_STATE_CHANGED) for n, st, _ in new]
        hr, _ = s.SCardGetStatusChange(ctx, 1000, states)
        if hr in _SERVICE_GONE:
            s.SCardReleaseContext(ctx)
            ctx = None

    if ctx is not None:
        s.SCardReleaseContext(ctx)


def _scan_reader(name, handle_card):
    conn = PCSCReader(name).createConnection()
    try:
        conn.connect(mode=SCARD_SHARE_SHARED)
    except (NoCardException, CardConnectionException) as e:
        log.warning("could not connect to tag on %s: %s", name, e)
        return
    t = PcscTransport(conn)
    try:
        handle_card(name, t)
    finally:
        t.close()


def connect_first(reader_filter: str | None = None, timeout: float = 30.0, trace: bool = False):
    """For one-shot/diagnose: wait for a tag on the first matching reader."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for r in list_readers():
            if reader_filter and reader_filter.lower() not in str(r).lower():
                continue
            conn = r.createConnection()
            try:
                conn.connect(mode=SCARD_SHARE_SHARED)
                return str(r), PcscTransport(conn, trace=trace)
            except (NoCardException, CardConnectionException):
                continue
        time.sleep(0.3)
    raise TimeoutError("no tag presented")
