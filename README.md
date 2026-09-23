# DeSCENT Ground

Fleet dashboard for DeSCENT ChipSats. Runs in the browser, reads one or more T-Beam LoRa receivers over USB.

## Standalone executable

For running it without opening the page or picking ports by hand: grab `DescentGround.exe` (Windows) or `descent-ground` (Linux) from the [Releases](../../releases) page. One file, no install. Double-click it and it opens your browser to the dashboard, finds every T-Beam plugged in with no port picker, and writes every line from every receiver to a log file next to itself, whether or not a browser is open.

- Windows: the exe is unsigned, so SmartScreen warns once — More info → Run anyway.
- Linux: you need to be in the `dialout` group, the same one Chrome's Web Serial already needs.
- Needs no internet at all, on either platform.

Every board you plug in is listed under **Set up receiver** with its USB chip and serial number.
You say which ones are receivers; the app opens those and leaves everything else alone. It asks
first because opening a port pulses DTR, which resets an ESP32, and the USB chip cannot tell a
T-Beam from a ChipSat: they can carry the same one.

The answer is remembered per board, not per socket, in `descent-ground-boards.txt` beside the app,
so a replug or a different USB port needs no second answer and any new T-Beam takes one click.
Disconnecting a receiver with ✕ keeps it shut until you plug it back in.

## Run it

For just the dashboard page, with no executable:

1. Download this repo (green **Code** button → **Download ZIP**) and unzip it. No install, no internet needed.
2. Double-click **`Open DeSCENT Ground.html`** in Chrome or Edge (Windows, macOS, Linux, ChromeOS).
3. Plug in a T-Beam, click **Connect receiver**, pick its port. Repeat for each extra T-Beam.

- Firefox and Safari can open saved logs but cannot connect to a receiver (no Web Serial).
- A hosted copy is at https://ground.privatepanda.co.

## Replaying a flash dump

**Open log** also takes a log written from a ChipSat's flash, exported by
`V2_6_X/tools/flash_to_ground.py` on the flight-software side. Such a file names itself on its
second line:

```
#DG,SRC,v1,kind=flash,from=CS64_2026-09-24.bin,boot=7,packets=120,anchor_uptime_ms=41230,anchor_utc=2026-09-24T11:02:03.500Z,anchor_tacc_ns=35000000
```

A boot that never got a GPS fix carries `time_source=start` instead of an anchor, meaning its
times were chosen by a human. The dashboard says so on screen, because once both are epoch
milliseconds a guessed time axis looks exactly like a real one.

The dashboard shows that source in the receiver strip so a replayed dump cannot be mistaken for
live reception. Records off a chip carry no RSSI or SNR, so those columns stay blank and the weak
RF warning never fires: an absence, not a fault.

## Recording

| Control | Does |
|---|---|
| **Start** | Asks where to save, then writes every line from **every connected receiver** to that file, whichever unit is on screen. Saved to disk every 5 s. |
| **Pause / Resume** | Stops / restarts writing. The file marks where it paused. |
| **Stop** | Finishes the file. |
| **Save session** | Downloads everything from all receivers since the page opened, recorded or not. |
| Autosave | Everything is also kept in the browser every 5 s. After a crash, the next visit offers to open, download or discard it. |
| **Open log** | Replays a saved file, or an old lab log from the CSV receiver. |

In browsers without the save-file picker, the recording is kept in memory and downloaded on **Stop**.

**Settings** (graph time span, when old graph data is dropped, status thresholds, saving) are remembered per browser.

## Screen

| Area | Shows |
|---|---|
| Left | Every field of the selected unit's latest packet. Fields whose validity bit is clear show `—` and the last trusted value. |
| Right top | One row per CSID: state, age, counter, packets, missed, Rx %, resets, battery, validity bits, best RSSI/SNR, packet interval, receivers that heard it. |
| Right bottom | History of the selected unit: Overview, IMU, Environment, GPS, Radio (per receiver). The time axis spans the data received. |

## Rules

| Item | Rule |
|---|---|
| CRC | Checked in the browser. A bad-CRC packet is counted and never updates a unit. |
| CSV receiver | Old `V2_5_X_T_BEAM_DECODE_CSV` T-Beams work too. The packet is rebuilt from the printed values to check the CRC. |
| Missed | Counter gaps, modulo 65536. |
| Reset | Counter drops, or 0 twice in a row. |
| Stale | No packet for 3× the unit's own measured interval (min 5 s). |
| Lost | No packet for 10 min. |
| Thresholds | All rules below are defaults; change them in Settings. |
| Several receivers | Identical bytes within 1.5 s = one packet. RSSI/SNR kept per receiver; the fleet list shows the best. |
| Saturation | ▲sat when valid acceleration reaches ±75 m/s² (BNO085 limit is ±8 g). |
| Low battery | Below 20 %. |
| Weak RF | Best RSSI below −115 dBm. |

## Receiver

`receiver/DescentRawReceiver/` is the T-Beam sketch that sends raw packets. See `receiver/README.md`.

## Files

| Path | What it does |
|---|---|
| `Open DeSCENT Ground.html` | Double-click launcher; opens `web/index.html`. |
| `web/index.html` | The page. |
| `web/js/packet.js` | Packet layout, CRC, decode. Mirrors `Telemetry.h` in the flight code. |
| `web/js/lines.js` | Turns one serial line (raw, CSV, hex dump) into an event. |
| `web/js/fleet.js` | Per-unit state: missed, resets, interval, stale/lost, history, dedupe. |
| `web/js/serial.js` | Web Serial ports. |
| `web/js/recorder.js` | Recording, log files, replay parsing. |
| `web/js/store.js` | Settings and crash autosave (browser storage). |
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
