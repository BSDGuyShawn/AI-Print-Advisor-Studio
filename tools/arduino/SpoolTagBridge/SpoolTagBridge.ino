// SpoolTagBridge: an Arduino Leonardo + PN532 NFC shield (I2C) as a spool tag reader/writer for
// AI 3D Print Advisor Studio.
//
// The Arduino only moves bytes. The computer does everything brand-specific (working out Bambu/Snapmaker/
// Creality keys from the tag's ID, decoding, signature checks), so this sketch never needs updating when a
// brand changes its format.
//
// Talks plain text over the Leonardo's USB serial port, one command per line, one reply per line:
//   HELLO                      -> OK SPOOLBRIDGE 1 PN532 <ver>      (or ERR NO_PN532)
//   UID                        -> OK <uid> <atqa> <sak> <lastWritablePage>   or NONE (no tag on the reader)
//   AUTH <block> <A|B> <key>   -> OK | ERR AUTH        MIFARE Classic login (key = 12 hex digits)
//   READ <block>               -> OK <32 hex digits>   16 bytes (Classic block, or 4 NTAG pages)
//   WRITE <page> <8 hex>       -> OK | ERR <why>       NTAG/Ultralight data-area pages only (see below)
//
// Writing is deliberately narrow: only NDEF-formatted NTAG/Ultralight stickers (the open spool formats: OpenSpool,
// OpenTag3D, TigerTag), and only the data area their capability container declares, from page 4. The ID, lock
// bytes, capability container, config and password pages can't be written, so a tag can't be locked or bricked from here. MIFARE Classic tags (Bambu, Snapmaker,
// Creality, QIDI) are read-only: there is no Classic write command in this sketch at all.
//
// Wiring: the PN532's I2C (SDA/SCL) only. IRQ and RESET are not used; on a Leonardo, D2/D3 ARE the I2C pins,
// so if the shield connects IRQ/RESET to D2/D3 those connections must be broken (see the instructions).

#include <Wire.h>

const uint8_t PN532_ADDR = 0x24;
const uint8_t CMD_FIRMWARE = 0x02, CMD_SAM = 0x14, CMD_RFCONFIG = 0x32, CMD_LIST = 0x4A,
              CMD_EXCHANGE = 0x40, CMD_THRU = 0x42;

bool pnReady = false;
uint8_t fwVer = 0, fwRev = 0;
uint8_t tagUid[10], tagUidLen = 0, tagSak = 0;
uint16_t tagAtqa = 0;
bool tagSelected = false;
uint8_t lastUserPage = 0;   // 0: this tag can't be written

// ------------------------------------------------------------------ PN532 frames over I2C
bool waitReady(uint16_t ms) {
  uint32_t t0 = millis();
  while (millis() - t0 < ms) {
    if (Wire.requestFrom(PN532_ADDR, (uint8_t)1) == 1 && (Wire.read() & 1)) return true;
    delay(2);
  }
  return false;
}

bool sendCommand(const uint8_t *cmd, uint8_t len) {
  uint8_t l = len + 1, sum = 0xD4;
  Wire.beginTransmission(PN532_ADDR);
  Wire.write(0x00); Wire.write(0x00); Wire.write(0xFF);
  Wire.write(l); Wire.write((uint8_t)(~l + 1));
  Wire.write(0xD4);
  for (uint8_t i = 0; i < len; i++) { Wire.write(cmd[i]); sum += cmd[i]; }
  Wire.write((uint8_t)(~sum + 1)); Wire.write(0x00);
  if (Wire.endTransmission() != 0) return false;
  if (!waitReady(100)) return false;
  uint8_t a[7];
  if (Wire.requestFrom(PN532_ADDR, (uint8_t)7) != 7) return false;
  for (uint8_t i = 0; i < 7; i++) a[i] = Wire.read();
  return a[1] == 0x00 && a[2] == 0x00 && a[3] == 0xFF && a[4] == 0x00 && a[5] == 0xFF;
}

// Returns the number of data bytes after D5 <cmd+1>, or -1.
int readResponse(uint8_t cmd, uint8_t *out, uint8_t maxLen, uint16_t ms) {
  if (!waitReady(ms)) return -1;
  uint8_t r[32];
  uint8_t n = Wire.requestFrom(PN532_ADDR, (uint8_t)32);
  for (uint8_t i = 0; i < n; i++) r[i] = Wire.read();
  if (n < 9 || !(r[0] & 1) || r[1] != 0x00 || r[2] != 0x00 || r[3] != 0xFF) return -1;
  uint8_t len = r[4];
  if ((uint8_t)(len + r[5]) != 0 || len < 2 || r[6] != 0xD5 || r[7] != (uint8_t)(cmd + 1)) return -1;
  uint8_t dlen = len - 2;
  if (9 + dlen > n || dlen > maxLen) return -1;
  uint8_t sum = 0xD5 + r[7];
  for (uint8_t i = 0; i < dlen; i++) { out[i] = r[8 + i]; sum += r[8 + i]; }
  if ((uint8_t)(sum + r[8 + dlen]) != 0) return -1;
  return dlen;
}

int pn(const uint8_t *cmd, uint8_t len, uint8_t *out, uint8_t maxOut, uint16_t ms = 1000) {
  if (!sendCommand(cmd, len)) return -1;
  return readResponse(cmd[0], out, maxOut, ms);
}

bool pnInit() {
  uint8_t out[8];
  for (uint8_t attempt = 0; attempt < 3; attempt++) {
    const uint8_t fw[] = { CMD_FIRMWARE };
    if (pn(fw, 1, out, sizeof out) >= 4) {
      fwVer = out[1]; fwRev = out[2];
      const uint8_t sam[] = { CMD_SAM, 0x01, 0x14, 0x01 };                  // normal mode, no SAM
      const uint8_t retry[] = { CMD_RFCONFIG, 0x05, 0xFF, 0x01, 0x02 };     // a scan gives up quickly when no tag
      if (pn(sam, 4, out, sizeof out) >= 0 && pn(retry, 5, out, sizeof out) >= 0) return true;
    }
    delay(50);
  }
  return false;
}

// ------------------------------------------------------------------ tag access
bool selectTag() {
  tagSelected = false;
  const uint8_t c[] = { CMD_LIST, 0x01, 0x00 };                             // one ISO 14443A tag, 106 kbps
  uint8_t out[20];
  int n = pn(c, 3, out, sizeof out, 500);
  if (n < 6 || out[0] == 0) return false;
  tagAtqa = ((uint16_t)out[2] << 8) | out[3];
  tagSak = out[4];
  tagUidLen = out[5];
  if (tagUidLen > sizeof tagUid || 6 + tagUidLen > n) return false;
  memcpy(tagUid, out + 6, tagUidLen);
  tagSelected = true;
  return true;
}

// Last page of the sticker's NDEF data area, from its capability container (page 3: E1 10 <size/8> <access>).
// GET_VERSION (NTAG21x) caps it to the chip's real user memory; older chips such as the NTAG203 don't answer it,
// so the CC alone decides. 0 (not writable here) for anything that isn't an NDEF-formatted Ultralight/NTAG.
uint8_t ntagLastUserPage() {
  if (tagSak != 0x00) return 0;                                            // only the Ultralight/NTAG family
  uint8_t chipLast = 0;
  const uint8_t gv[] = { CMD_THRU, 0x60 };                                 // GET_VERSION
  uint8_t out[20];
  int n = pn(gv, 2, out, sizeof out, 300);
  if (n >= 9 && out[0] == 0x00 && out[2] == 0x04 && out[3] == 0x04) {
    if (out[7] == 0x0F) chipLast = 39;          // NTAG213: pages 4-39
    else if (out[7] == 0x11) chipLast = 129;    // NTAG215: pages 4-129
    else if (out[7] == 0x13) chipLast = 225;    // NTAG216: pages 4-225
  } else if (!selectTag()) return 0;                                       // no GET_VERSION: the tag halted, wake it
  const uint8_t rd[] = { CMD_EXCHANGE, 0x01, 0x30, 0x03 };                         // READ page 3 (the CC)
  n = pn(rd, 4, out, sizeof out);
  if (n < 5 || out[0] != 0x00 || out[1] != 0xE1 || (out[4] & 0x0F) != 0x00 || out[3] == 0) return 0;
  uint16_t ccLast = 3 + (uint16_t)out[3] * 2;                              // size/8 bytes -> pages of 4
  if (ccLast > 225) ccLast = 225;
  return chipLast && chipLast < ccLast ? chipLast : (uint8_t)ccLast;
}

// ------------------------------------------------------------------ serial commands
char line[72];
uint8_t lineLen = 0;

void hex(const uint8_t *b, uint8_t n) {
  for (uint8_t i = 0; i < n; i++) { if (b[i] < 0x10) Serial.print('0'); Serial.print(b[i], HEX); }
}

int8_t nib(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

bool parseHex(const char *s, uint8_t *out, uint8_t n) {
  if (!s || strlen(s) != (size_t)n * 2) return false;
  for (uint8_t i = 0; i < n; i++) {
    int8_t h = nib(s[2 * i]), l = nib(s[2 * i + 1]);
    if (h < 0 || l < 0) return false;
    out[i] = (h << 4) | l;
  }
  return true;
}

bool parseNum(const char *s, uint8_t &v) {
  if (!s || !*s) return false;
  long x = 0;
  for (; *s; s++) { if (*s < '0' || *s > '9') return false; x = x * 10 + (*s - '0'); if (x > 255) return false; }
  v = (uint8_t)x;
  return true;
}

void err(const __FlashStringHelper *why) { Serial.print(F("ERR ")); Serial.println(why); }

void handle(char *cmd) {
  char *a1 = strtok(cmd, " "), *a2 = strtok(NULL, " "), *a3 = strtok(NULL, " "), *a4 = strtok(NULL, " ");
  if (!a1) return;
  for (char *p = a1; *p; p++) *p = toupper(*p);

  if (!strcmp(a1, "HELLO")) {
    if (!pnReady) pnReady = pnInit();
    if (!pnReady) return err(F("NO_PN532"));
    Serial.print(F("OK SPOOLBRIDGE 1 PN532 ")); Serial.print(fwVer); Serial.print('.'); Serial.println(fwRev);
    return;
  }
  if (!pnReady && !(pnReady = pnInit())) return err(F("NO_PN532"));

  if (!strcmp(a1, "UID")) {
    if (!selectTag()) { lastUserPage = 0; Serial.println(F("NONE")); return; }
    lastUserPage = ntagLastUserPage();
    if (!tagSelected) { Serial.println(F("NONE")); return; }
    Serial.print(F("OK ")); hex(tagUid, tagUidLen);
    Serial.print(' '); uint8_t at[2] = { (uint8_t)(tagAtqa >> 8), (uint8_t)tagAtqa }; hex(at, 2);
    Serial.print(' '); hex(&tagSak, 1);
    Serial.print(' '); Serial.println(lastUserPage);
    return;
  }
  if (!tagSelected) return err(F("NO_TAG"));

  if (!strcmp(a1, "AUTH")) {
    uint8_t block, key[6];
    if (!parseNum(a2, block) || !a3 || (toupper(a3[0]) != 'A' && toupper(a3[0]) != 'B') || !parseHex(a4, key, 6))
      return err(F("ARGS"));
    uint8_t c[14] = { CMD_EXCHANGE, 0x01, (uint8_t)(toupper(a3[0]) == 'A' ? 0x60 : 0x61), block };
    memcpy(c + 4, key, 6);
    memcpy(c + 10, tagUid + tagUidLen - 4, 4);                              // the last 4 bytes of the UID
    uint8_t out[4];
    int n = pn(c, 14, out, sizeof out);
    if (n >= 1 && out[0] == 0x00) { Serial.println(F("OK")); return; }
    selectTag();                                                            // a failed login halts the tag
    return err(F("AUTH"));
  }
  if (!strcmp(a1, "READ")) {
    uint8_t block;
    if (!parseNum(a2, block)) return err(F("ARGS"));
    const uint8_t c[] = { CMD_EXCHANGE, 0x01, 0x30, block };
    uint8_t out[20];
    int n = pn(c, 4, out, sizeof out);
    if (n < 17 || out[0] != 0x00) return err(F("READ"));
    Serial.print(F("OK ")); hex(out + 1, 16); Serial.println();
    return;
  }
  if (!strcmp(a1, "WRITE")) {
    uint8_t page, d[4];
    if (!parseNum(a2, page) || !parseHex(a3, d, 4)) return err(F("ARGS"));
    if (lastUserPage == 0) return err(F("NOT_WRITABLE"));                  // not an NTAG213/215/216
    if (page < 4 || page > lastUserPage) return err(F("PROTECTED_PAGE"));
    const uint8_t c[] = { CMD_EXCHANGE, 0x01, 0xA2, page, d[0], d[1], d[2], d[3] };   // NTAG WRITE (4 bytes)
    uint8_t out[4];
    int n = pn(c, 8, out, sizeof out);
    if (n < 1 || out[0] != 0x00) return err(F("WRITE"));
    Serial.println(F("OK"));
    return;
  }
  err(F("UNKNOWN"));
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.setClock(100000);
  delay(100);                                                               // let the PN532 power up
  pnReady = pnInit();
}

void loop() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') { line[lineLen] = 0; if (lineLen) handle(line); lineLen = 0; }
    else if (lineLen < sizeof line - 1) line[lineLen++] = ch;
    else lineLen = 0;                                                       // too long: drop it
  }
}
