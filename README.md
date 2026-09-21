# DeSCENT Ground

Fleet dashboard for DeSCENT ChipSats. Runs in the browser, reads one or more T-Beam LoRa receivers over USB.

**Open it:** https://privatepanda.co/descent-ground/

- Chrome or Edge (desktop): Windows, macOS, Linux, ChromeOS.
- Firefox and Safari can open saved logs but cannot connect to a receiver (no Web Serial).
- No internet at the site: download this repo and double-click `web/index.html`. The hosted page also keeps an offline copy after the first visit.

## Use

1. Plug in a T-Beam. Click **Connect receiver** and pick its port. Repeat for more receivers.
2. **Record to file** streams every received line to a file (saved to disk every 5 s).
3. **Save session** downloads everything received since the page opened.
4. **Open log** replays a saved file, or an old lab log from the CSV receiver.

## Screen

| Area | Shows |
|---|---|
| Left | Every field of the selected unit's latest packet. Fields whose validity bit is clear show `—` and the last trusted value. |
| Right top | One row per CSID: state, age, counter, packets, missed, Rx %, resets, battery, validity bits, best RSSI/SNR, packet interval, receivers that heard it. |
| Right bottom | History of the selected unit: Overview, IMU, Environment, GPS, Radio (per receiver). |

## Rules

| Item | Rule |
|---|---|
| CRC | Checked in the browser. A bad-CRC packet is counted and never updates a unit. |
| CSV receiver | Old `V2_5_X_T_BEAM_DECODE_CSV` T-Beams work too. The packet is rebuilt from the printed values to check the CRC. |
| Missed | Counter gaps, modulo 65536. |
| Reset | Counter drops, or 0 twice in a row. |
| Stale | No packet for 3× the unit's own measured interval (min 5 s). |
| Lost | No packet for 10 min. |
| Several receivers | Identical bytes within 1.5 s = one packet. RSSI/SNR kept per receiver; the fleet list shows the best. |
| Saturation | ▲sat when valid acceleration reaches ±75 m/s² (BNO085 limit is ±8 g). |
| Low battery | Below 20 %. |
| Weak RF | Best RSSI below −115 dBm. |

## Receiver

`receiver/DescentRawReceiver/` is the T-Beam sketch that sends raw packets. See `receiver/README.md`.

## Files

| Path | What it does |
|---|---|
| `web/index.html` | The page. |
| `web/js/packet.js` | Packet layout, CRC, decode. Mirrors `Telemetry.h` in the flight code. |
| `web/js/lines.js` | Turns one serial line (raw, CSV, hex dump) into an event. |
| `web/js/fleet.js` | Per-unit state: missed, resets, interval, stale/lost, history, dedupe. |
| `web/js/serial.js` | Web Serial ports. |
| `web/js/recorder.js` | Recording, log files, replay parsing. |
| `web/js/charts.js` | History charts (uPlot). |
| `web/js/app.js` | Wires it together and draws the screen. |
| `web/sw.js` | Offline copy for the hosted site. |
| `test/` | `node --test test/*.test.js`. Uses real lab logs from the `SSDS_DeSCENT` repo checked out next to this one. |
| `docs/design-guide.md` | Colours, type, layout rules. |

## Log format

```
# descent-ground log v1 started 2026-09-26T14:00:00.000Z
<unix ms>	<receiver>	<line exactly as received>
```
