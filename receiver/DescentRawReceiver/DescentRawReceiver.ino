// DescentRawReceiver
//
// LilyGO T-Beam (ESP32 + SX1276) raw ground receiver for the DeSCENT ChipSat
// fleet dashboard. Every LoRa packet is forwarded over USB serial as hex; the
// dashboard (browser, Web Serial) does all decoding and CRC checks.
//
// Serial: 115200 baud, one ASCII line per event, '\n' terminated.
//   #DG,RX,v1,id=XXXXXX,f=..,bw=..,sf=..,cr=..,sync=0x..,pre=..   boot + every 30 s
//   PKT,<len>,<HEX>,<rssi dBm>,<snr dB>,<freqErr Hz>              good packet
//   ERR,<radiolib code>,<rssi dBm>,<snr dB>                        bad packet
//   HB,<millis>,<ok count>,<error count>                           every 5 s
//   #DG,FATAL,<radiolib code>                                      setup failed (halts)

#include <Arduino.h>
#include <RadioLib.h>
#include <math.h>
#include "boards.h"

#if __has_include(<esp_mac.h>)
#include <esp_mac.h>      // ESP32 core 3.x
#else
#include <esp_system.h>   // ESP32 core 2.x
#endif

// =============================================================================
// RADIO PARAMETERS -- must match the ChipSat transmitters. Change them here.
// =============================================================================
constexpr float    kFrequencyMHz    = 915.0;
constexpr float    kBandwidthKHz    = 125.0;
constexpr uint8_t  kSpreadingFactor = 9;      // flight team may move to 7
constexpr uint8_t  kCodingRate      = 7;      // 4/7
constexpr uint8_t  kSyncWord        = 0x12;   // private LoRa sync word
constexpr uint16_t kPreambleLength  = 8;
constexpr int8_t   kOutputPowerDbm  = 20;     // unused by a receiver; begin() requires it
constexpr uint8_t  kGain            = 1;      // LNA gain 1 = highest
constexpr bool     kPhyCrc          = true;   // LoRa PHY CRC on
// Explicit header and standard IQ are RadioLib defaults.
// =============================================================================

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

void printHeader() {
  const int n = snprintf(
    lineBuffer, sizeof(lineBuffer),
    "#DG,RX,v1,id=%s,f=%.1f,bw=%.1f,sf=%u,cr=%u,sync=0x%02X,pre=%u\n",
    deviceId, kFrequencyMHz, kBandwidthKHz,
    (unsigned)kSpreadingFactor, (unsigned)kCodingRate,
    (unsigned)kSyncWord, (unsigned)kPreambleLength);
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

void startListening() {
  const int state = radio.startReceive();
  if (state != RADIOLIB_ERR_NONE) {
    ++packetErrors;
    printError(state, 0.0f, 0.0f);
  }
}

void setup() {
  Serial.setTxBufferSize(1024);  // a full PKT line never blocks on the UART
  Serial.begin(kSerialBaud);
  readDeviceId();
  initBoard();

  // The T-Beam radio power rail needs a brief startup delay.
  delay(1500);

  int state = radio.begin(
    kFrequencyMHz,
    kBandwidthKHz,
    kSpreadingFactor,
    kCodingRate,
    kSyncWord,
    kOutputPowerDbm,
    kPreambleLength,
    kGain);
  if (state != RADIOLIB_ERR_NONE) {
    fatal(state);
  }

  state = radio.setCRC(kPhyCrc);
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
