# DescentRawReceiver

LilyGO T-Beam (ESP32 + SX1276) ground receiver for the DeSCENT fleet dashboard.

- Receives LoRa packets, forwards raw bytes as hex over USB serial.
- No decoding, no packet CRC check: the dashboard (browser, Web Serial) does that.
- Any packet length is forwarded (flight packet is 55 bytes).

## Files

| File | Purpose |
|---|---|
| `DescentRawReceiver/DescentRawReceiver.ino` | Sketch: radio setup, receive loop, serial protocol |
| `DescentRawReceiver/boards.h` | Board bring-up (SPI, I2C, AXP192 power rails, OLED). Unmodified copy from the CSV receiver. |
| `DescentRawReceiver/utilities.h` | Pin map; board variant select (`LILYGO_TBeam_V1_1`) |

`boards.h`, `utilities.h` and the radio setup are the same as the V2_5_X CSV receiver (`V2_5_X_T_BEAM_DECODE_CSV`). Only the serial output differs.

## Requirements

- ESP32 Arduino core **2.0.17** (Espressif board index)
- RadioLib **7.1.2**
- AXP202X_Library (Lewis He) and U8g2: Library Manager
- Board: T-Beam V1.0 / V1.1 (AXP192), same as the CSV receiver.

## Flash

Arduino IDE:
- Boards Manager URL: `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
- Install `esp32` by Espressif, version 2.0.17
- Board: **T-Beam** (`Tools > Board > esp32 > T-Beam`)
- Open `DescentRawReceiver/DescentRawReceiver.ino`, Upload

arduino-cli (compile command used for verification):

```
arduino-cli core install esp32:esp32@2.0.17 \
  --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli compile --fqbn esp32:esp32:t-beam --warnings all DescentRawReceiver
arduino-cli upload  --fqbn esp32:esp32:t-beam -p /dev/ttyACM0 DescentRawReceiver
```

The port may be `/dev/ttyUSB0` or `/dev/ttyACM0`, depending on the board's USB chip.
Build size: 366 KB flash (27%), 24.8 KB RAM (7%).

## Serial protocol

115200 baud, ASCII, one line per event, `\n` terminated. `boards.h` prints a few start-up lines at boot; the dashboard ignores them.

| Line | When | Fields |
|---|---|---|
| `#DG,RX,v1,id=<ID>,f=915.0,bw=125.0,sf=9,cr=7,sync=0x12,pre=8` | boot, then every 30 s | `ID` = last 3 bytes of ESP32 eFuse MAC, 6 uppercase hex |
| `PKT,<len>,<hex>,<rssi>,<snr>,<freqErr>` | good radio read | byte count; payload uppercase hex, no spaces; RSSI dBm (1 dp); SNR dB (2 dp); frequency error Hz (integer) |
| `ERR,<code>,<rssi>,<snr>` | bad radio read | RadioLib code (`-7` PHY CRC mismatch, `-24` header damaged); RSSI; SNR |
| `HB,<millis>,<ok>,<err>` | every 5 s | uptime ms; good packets since boot; errors since boot |
| `#DG,FATAL,<code>` | setup failure | RadioLib code; repeated every 5 s, board halted |

Example: `PKT,55,0000…0923,-50.0,13.75,-1234`

A failed `startReceive()` is reported as `ERR,<code>,0.0,0.00`.

## Radio parameters

One block at the top of `DescentRawReceiver.ino` (`RADIO PARAMETERS`):

| Constant | Value |
|---|---|
| `kFrequencyMHz` | 915.0 |
| `kBandwidthKHz` | 125.0 |
| `kSpreadingFactor` | 9 (may change to 7) |
| `kCodingRate` | 7 (4/7) |
| `kSyncWord` | 0x12 |
| `kPreambleLength` | 8 |
| `kGain` | 1 |
| `kPhyCrc` | true |

Explicit header and standard IQ are RadioLib defaults. The `#DG,RX` header line reports the values in use.
Must match the ChipSat transmitters.

## OLED

- Shows: `DescentRaw`, id, ok/err counts, last length, last RSSI/SNR.
