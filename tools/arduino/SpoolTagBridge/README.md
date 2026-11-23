# SpoolTagBridge: an Arduino + PN532 as a spool tag reader and writer

Turns an Arduino with a **PN532 NFC shield** into a reader for AI 3D Print Advisor Studio's spool tags (Settings →
Spool tags). The Arduino only moves bytes between the computer and the PN532: the app does everything brand-specific
(working out Bambu Lab, Snapmaker and Creality keys, decoding, checking Snapmaker's signature), so this sketch never
needs updating when a brand changes its tags.

Tested on an **Arduino Leonardo** with a PN532 shield on **I2C**. Other boards with native or USB serial (Uno, Mega,
Micro, Nano) work the same way.

## Set it up

1. Set the shield to **I2C** (on most boards: switch SEL0 on, SEL1 off).
2. **Leonardo / Micro only:** the I2C pins are D2 (SDA) and D3 (SCL). If the shield connects its IRQ or RESET to D2
   or D3, bend those two shield pins out (or cut the IRQ jumper): this sketch doesn't use IRQ or RESET, and on these
   boards they would sit on the I2C lines. If the shield only uses A4/A5 for I2C, wire A4 to SDA and A5 to SCL.
3. Open `SpoolTagBridge.ino` in the Arduino IDE (no libraries needed), pick your board and port, and click **Upload**.
4. In the app: **Settings → Spool tags (NFC)**, tick **Scan spool tags**, leave the board on **Find an Arduino
   automatically** (or pick its COM port), click **Test**, then **Save settings**.

## What it does

Plain text over the USB serial port (115200 baud), one command per line, one reply per line:

| Command | Reply |
|---|---|
| `HELLO` | `OK SPOOLBRIDGE 1 PN532 <firmware>` or `ERR NO_PN532` |
| `UID` | `OK <uid> <atqa> <sak> <lastWritablePage>` or `NONE` |
| `AUTH <block> <A\|B> <key>` | `OK` or `ERR AUTH` (MIFARE Classic login; key = 12 hex digits) |
| `READ <block>` | `OK <32 hex digits>` (16 bytes) |
| `WRITE <page> <8 hex>` | `OK` or `ERR <why>` |

**Writing is deliberately narrow**, checked here as well as in the app: only NDEF-formatted NTAG/Ultralight stickers,
and only the data area their capability container declares, from page 4. A tag's ID, lock bytes, capability
container, configuration and password pages can't be written, so a sticker can't be locked or bricked. There's no
MIFARE Classic write command at all: Bambu Lab, Snapmaker, Creality and QIDI tags are only ever read.

Any reader that speaks this protocol works with the app, so the sketch can be ported to other NFC chips.
