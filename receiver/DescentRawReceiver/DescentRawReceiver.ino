// DescentRawReceiver
//
// LilyGO T-Beam (ESP32 + SX1276) raw ground receiver for the DeSCENT ChipSat
// fleet dashboard. Every LoRa packet is forwarded over USB serial as hex; the
// dashboard (browser, Web Serial) does all decoding and CRC checks.
//
// Serial: 115200 baud, one ASCII line per event, '\n' terminated.
//   #DG,RX,v1,id=XXXXXX,f=..,bw=..,sf=..,cr=..,sync=0x..,pre=..   boot, every 30 s, #GET, #SET
//   PKT,<len>,<HEX>,<rssi dBm>,<snr dB>,<freqErr Hz>              good packet
//   ERR,<radiolib code>,<rssi dBm>,<snr dB>                        bad packet
//   HB,<millis>,<ok count>,<error count>                           every 5 s
//   #DG,FATAL,<radiolib code>                                      setup failed (halts)
//   #DG,ERR,<key>                                                  command rejected
//
// Commands in, same line format:
//   #GET                             reprint the header now
//   #SET,<key>,<value>               key is sf, freq, bw, cr, sync or pre

#include <Arduino.h>
#include <Preferences.h>
#include <RadioLib.h>
#include <math.h>
#include "boards.h"

#if __has_include(<esp_mac.h>)
#include <esp_mac.h>      // ESP32 core 3.x
#else
#include <esp_system.h>   // ESP32 core 2.x
#endif

// =============================================================================
// RADIO PARAMETERS -- must match the ChipSat transmitters. These are only the
// defaults: #SET over serial changes any of them and the change is kept in
// flash, because there is no compiler in the field.
// =============================================================================
struct Radio {
  float    freqMHz;
  float    bwKHz;
  uint8_t  sf;
  uint8_t  cr;      // 4/7
  uint8_t  sync;    // private LoRa sync word
  uint16_t pre;
};

Radio settings = { 915.0f, 125.0f, 9, 7, 0x12, 8 };

constexpr int8_t   kOutputPowerDbm  = 20;     // unused by a receiver; begin() requires it
constexpr uint8_t  kGain            = 1;      // LNA gain 1 = highest
constexpr bool     kPhyCrc          = true;   // LoRa PHY CRC on
// Explicit header and standard IQ are RadioLib defaults.
// =============================================================================

// NVS namespace for the settings above.
constexpr char kPrefsNamespace[] = "dgrx";

// The only bandwidths the SX127x has (RadioLib SX1278::setBandwidth).
constexpr float kBandwidthsKHz[] = {
  7.8f, 10.4f, 15.6f, 20.8f, 31.25f, 41.7f, 62.5f, 125.0f, 250.0f, 500.0f };

constexpr size_t   kFlightPacketBytes = 55;   // fixed, and what SF6 needs told to it
constexpr uint32_t kHeartbeatMs     = 5000;
constexpr uint32_t kHeaderMs        = 30000;
constexpr uint32_t kSerialBaud      = 115200;

SX1276 radio = new Module(
  RADIO_CS_PIN,
  RADIO_DI0_PIN,
  RADIO_RST_PIN,
  RADIO_DIO1_PIN);

volatile bool receivedFlag = false;
volatile bool receiveInterruptEnabled = true;

char deviceId[7] = "000000";
uint32_t packetsOk = 0;
uint32_t packetErrors = 0;
uint32_t lastHeartbeatMs = 0;
uint32_t lastHeaderMs = 0;

size_t lastLength = 0;
float lastRssi = 0.0f;
float lastSnr = 0.0f;

// LoRa max payload is 255 bytes: "PKT,255," + 510 hex + ",-123.4,-12.34,-123456\n".
char lineBuffer[600];

// Longest command is "#SET,freq,915.0", so 32 is plenty.
char commandBuffer[32];
size_t commandLength = 0;
bool commandTooLong = false;

#if defined(ESP8266) || defined(ESP32)
IRAM_ATTR
#endif
void setFlag() {
  if (receiveInterruptEnabled) {
    receivedFlag = true;
  }
}

void readDeviceId() {
  uint8_t mac[6] = { 0 };
  esp_efuse_mac_get_default(mac);
  snprintf(deviceId, sizeof(deviceId), "%02X%02X%02X", mac[3], mac[4], mac[5]);
}

// Nothing is stored until the first #SET, and a read-only begin() on a namespace
// that isn't there fails, which leaves the compiled-in defaults standing.
void loadSettings() {
  Preferences prefs;
  if (!prefs.begin(kPrefsNamespace, true)) {
    return;
  }
  settings.freqMHz = prefs.getFloat("freq", settings.freqMHz);
  settings.bwKHz   = prefs.getFloat("bw", settings.bwKHz);
  settings.sf      = prefs.getUChar("sf", settings.sf);
  settings.cr      = prefs.getUChar("cr", settings.cr);
  settings.sync    = prefs.getUChar("sync", settings.sync);
  settings.pre     = prefs.getUShort("pre", settings.pre);
  prefs.end();
}

void saveSettings() {
  Preferences prefs;
  if (!prefs.begin(kPrefsNamespace, false)) {
    return;
  }
  prefs.putFloat("freq", settings.freqMHz);
  prefs.putFloat("bw", settings.bwKHz);
  prefs.putUChar("sf", settings.sf);
  prefs.putUChar("cr", settings.cr);
  prefs.putUChar("sync", settings.sync);
  prefs.putUShort("pre", settings.pre);
  prefs.end();
}

// Every parameter in use, not just the id: a receiver on the wrong spreading
// factor hears nothing at all, which looks exactly like a satellite that never
// powered up. This line is how the two are told apart.
void printHeader() {
  const int n = snprintf(
    lineBuffer, sizeof(lineBuffer),
    "#DG,RX,v1,id=%s,f=%.1f,bw=%.1f,sf=%u,cr=%u,sync=0x%02X,pre=%u\n",
    deviceId, settings.freqMHz, settings.bwKHz,
    (unsigned)settings.sf, (unsigned)settings.cr,
    (unsigned)settings.sync, (unsigned)settings.pre);
  Serial.write(reinterpret_cast<const uint8_t*>(lineBuffer), n);
}

void printHeartbeat(uint32_t now) {
  const int n = snprintf(
    lineBuffer, sizeof(lineBuffer), "HB,%lu,%lu,%lu\n",
    (unsigned long)now, (unsigned long)packetsOk, (unsigned long)packetErrors);
  Serial.write(reinterpret_cast<const uint8_t*>(lineBuffer), n);
}

void printPacket(const uint8_t* data, size_t len, float rssi, float snr, long freqErr) {
  static const char kHex[] = "0123456789ABCDEF";
  int n = snprintf(lineBuffer, sizeof(lineBuffer), "PKT,%u,", (unsigned)len);
  for (size_t i = 0; i < len; ++i) {
    lineBuffer[n++] = kHex[data[i] >> 4];
    lineBuffer[n++] = kHex[data[i] & 0x0F];
  }
  n += snprintf(lineBuffer + n, sizeof(lineBuffer) - n, ",%.1f,%.2f,%ld\n", rssi, snr, freqErr);
  Serial.write(reinterpret_cast<const uint8_t*>(lineBuffer), n);
}

void printError(int code, float rssi, float snr) {
  const int n = snprintf(lineBuffer, sizeof(lineBuffer), "ERR,%d,%.1f,%.2f\n", code, rssi, snr);
  Serial.write(reinterpret_cast<const uint8_t*>(lineBuffer), n);
}

void updateDisplay() {
#ifdef HAS_DISPLAY
  if (!u8g2) {
    return;
  }
  char line[32];
  u8g2->clearBuffer();
  u8g2->setFont(u8g2_font_6x12_tf);
  u8g2->drawStr(0, 12, "DescentRaw");
  snprintf(line, sizeof(line), "id %s", deviceId);
  u8g2->drawStr(0, 24, line);
  snprintf(line, sizeof(line), "ok %lu err %lu", (unsigned long)packetsOk, (unsigned long)packetErrors);
  u8g2->drawStr(0, 36, line);
  snprintf(line, sizeof(line), "len %u", (unsigned)lastLength);
  u8g2->drawStr(0, 48, line);
  snprintf(line, sizeof(line), "R %.1f S %.2f", lastRssi, lastSnr);
  u8g2->drawStr(0, 60, line);
  u8g2->sendBuffer();
#endif
}

// Setup failure: report the RadioLib code and halt (as the original does).
// The line is repeated so a dashboard that connects late still sees it.
void fatal(int code) {
#ifdef HAS_DISPLAY
  if (u8g2) {
    char line[32];
    u8g2->clearBuffer();
    u8g2->setFont(u8g2_font_6x12_tf);
    u8g2->drawStr(0, 12, "Radio init failed");
    snprintf(line, sizeof(line), "code %d", code);
    u8g2->drawStr(0, 28, line);
    u8g2->sendBuffer();
  }
#endif
  while (true) {
    const int n = snprintf(lineBuffer, sizeof(lineBuffer), "#DG,FATAL,%d\n", code);
    Serial.write(reinterpret_cast<const uint8_t*>(lineBuffer), n);
    delay(5000);
  }
}

// SF6 has no explicit header on this radio. Below SF7 the length is fixed in the
// receiver; at SF7 and above the header carries it and any length is forwarded.
int applyHeaderMode(uint8_t sf) {
  return sf == 6 ? radio.implicitHeader(kFlightPacketBytes) : radio.explicitHeader();
}

void startListening() {
  const int state = radio.startReceive();
  if (state != RADIOLIB_ERR_NONE) {
    ++packetErrors;
    printError(state, 0.0f, 0.0f);
  }
}

void printCommandError(const char* what) {
  const int n = snprintf(lineBuffer, sizeof(lineBuffer), "#DG,ERR,%s\n", what);
  Serial.write(reinterpret_cast<const uint8_t*>(lineBuffer), n);
}

// strtol and strtof stop at the first character they don't like and report no
// error, so check the whole value was used: "9x" is a typo, not 9.
bool parseLong(const char* value, int base, long* out) {
  char* end = nullptr;
  const long v = strtol(value, &end, base);
  if (end == value || *end != '\0') {
    return false;
  }
  *out = v;
  return true;
}

bool parseFloat(const char* value, float* out) {
  char* end = nullptr;
  const float v = strtof(value, &end);
  if (end == value || *end != '\0') {
    return false;
  }
  *out = v;
  return true;
}

bool knownBandwidth(float bw) {
  for (float allowed : kBandwidthsKHz) {
    if (fabsf(bw - allowed) <= 0.001f) {
      return true;
    }
  }
  return false;
}

enum Setting : uint8_t { kSetFreq, kSetBw, kSetSf, kSetCr, kSetSync, kSetPre };

// "<key>,<value>" from a #SET line. Checked before the radio is touched, so a
// value we won't take never costs a packet.
void applySetting(char* arg) {
  char* value = strchr(arg, ',');
  if (value == nullptr || value == arg) {
    printCommandError("cmd");
    return;
  }
  *value++ = '\0';
  const char* key = arg;

  Radio wanted = settings;
  Setting which = kSetSf;
  long n = 0;
  float f = 0.0f;

  if (strcmp(key, "sf") == 0) {
    // SF6 works, but only in implicit header mode: the SX127x has no explicit header at
    // that spreading factor, so the receiver is told the length instead of reading it.
    // The flight packet is always 55 bytes, which is what makes that possible here.
    if (!parseLong(value, 10, &n) || n < 6 || n > 12) {
      printCommandError(key);
      return;
    }
    wanted.sf = (uint8_t)n;
    which = kSetSf;
  } else if (strcmp(key, "freq") == 0) {
    if (!parseFloat(value, &f) || f < 137.0f || f > 1020.0f) {
      printCommandError(key);
      return;
    }
    wanted.freqMHz = f;
    which = kSetFreq;
  } else if (strcmp(key, "bw") == 0) {
    if (!parseFloat(value, &f) || !knownBandwidth(f)) {
      printCommandError(key);
      return;
    }
    wanted.bwKHz = f;
    which = kSetBw;
  } else if (strcmp(key, "cr") == 0) {
    if (!parseLong(value, 10, &n) || n < 5 || n > 8) {
      printCommandError(key);
      return;
    }
    wanted.cr = (uint8_t)n;
    which = kSetCr;
  } else if (strcmp(key, "sync") == 0) {
    if (!parseLong(value, 0, &n) || n < 0 || n > 255) {   // base 0, so 0x12 and 18 both work
      printCommandError(key);
      return;
    }
    wanted.sync = (uint8_t)n;
    which = kSetSync;
  } else if (strcmp(key, "pre") == 0) {
    if (!parseLong(value, 10, &n) || n < 6 || n > 65535) {
      printCommandError(key);
      return;
    }
    wanted.pre = (uint16_t)n;
    which = kSetPre;
  } else {
    printCommandError(key);
    return;
  }

  // Standby first: a parameter changed while the radio is in receive does not
  // take reliably. RadioLib sets the low data rate optimisation itself for SF12
  // at 125 kHz, so we leave that alone.
  radio.standby();
  int state = RADIOLIB_ERR_NONE;
  switch (which) {
    case kSetFreq: state = radio.setFrequency(wanted.freqMHz); break;
    case kSetBw:   state = radio.setBandwidth(wanted.bwKHz); break;
    case kSetSf:
      state = radio.setSpreadingFactor(wanted.sf);
      if (state == RADIOLIB_ERR_NONE) {
        state = applyHeaderMode(wanted.sf);
      }
      break;
    case kSetCr:   state = radio.setCodingRate(wanted.cr); break;
    case kSetSync: state = radio.setSyncWord(wanted.sync); break;
    case kSetPre:  state = radio.setPreambleLength(wanted.pre); break;
  }

  if (state != RADIOLIB_ERR_NONE) {
    printCommandError(key);
  } else {
    settings = wanted;
    saveSettings();
    printHeader();
  }

  // A packet that arrived during the change was never read out, and its length
  // register means nothing after the restart.
  receivedFlag = false;
  startListening();
}

void handleCommand(char* line) {
  if (strcmp(line, "#GET") == 0) {
    printHeader();
  } else if (strncmp(line, "#SET,", 5) == 0) {
    applySetting(line + 5);
  }
  // Anything else isn't ours. Keep quiet: the dashboard sends nothing else.
}

void readCommands() {
  while (Serial.available() > 0) {
    const int c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (commandTooLong) {
        printCommandError("cmd");
      } else if (commandLength > 0) {
        commandBuffer[commandLength] = '\0';
        handleCommand(commandBuffer);
      }
      commandLength = 0;
      commandTooLong = false;
    } else if (commandLength < sizeof(commandBuffer) - 1) {
      commandBuffer[commandLength++] = (char)c;
    } else {
      commandTooLong = true;   // no command is this long, drop the whole line
    }
  }
}

void setup() {
  Serial.setTxBufferSize(1024);  // a full PKT line never blocks on the UART
  Serial.begin(kSerialBaud);
  readDeviceId();
  loadSettings();
  initBoard();

  // The T-Beam radio power rail needs a brief startup delay.
  delay(1500);

  int state = radio.begin(
    settings.freqMHz,
    settings.bwKHz,
    settings.sf,
    settings.cr,
    settings.sync,
    kOutputPowerDbm,
    settings.pre,
    kGain);
  if (state != RADIOLIB_ERR_NONE) {
    fatal(state);
  }

  state = radio.setCRC(kPhyCrc);
  if (state != RADIOLIB_ERR_NONE) {
    fatal(state);
  }

  state = applyHeaderMode(settings.sf);
  if (state != RADIOLIB_ERR_NONE) {
    fatal(state);
  }

  radio.setPacketReceivedAction(setFlag);

  const uint32_t now = millis();
  printHeader();
  lastHeaderMs = now;
  lastHeartbeatMs = now;
  updateDisplay();

  startListening();
}

void handlePacket() {
  receiveInterruptEnabled = false;
  receivedFlag = false;

  // Explicit header: the radio reports the real payload length. Any length is
  // forwarded; the dashboard decides what it is.
  const size_t len = radio.getPacketLength();
  uint8_t packet[256];
  const int state = radio.readData(packet, len);

  const float rssi = radio.getRSSI();
  const float snr = radio.getSNR();
  lastRssi = rssi;
  lastSnr = snr;

  if (state == RADIOLIB_ERR_NONE) {
    ++packetsOk;
    lastLength = len;
    const long freqErr = lroundf(radio.getFrequencyError());
    printPacket(packet, len, rssi, snr, freqErr);
  } else {
    ++packetErrors;
    printError(state, rssi, snr);
  }

  updateDisplay();

  receiveInterruptEnabled = true;
  startListening();
}

void loop() {
  const uint32_t now = millis();

  readCommands();

  if (now - lastHeaderMs >= kHeaderMs) {
    lastHeaderMs = now;
    printHeader();
  }

  if (now - lastHeartbeatMs >= kHeartbeatMs) {
    lastHeartbeatMs = now;
    printHeartbeat(now);
  }

  if (receivedFlag) {
    handlePacket();
  }
}
