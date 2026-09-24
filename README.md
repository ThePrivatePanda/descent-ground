# DeSCENT Ground

Fleet dashboard for DeSCENT ChipSats. Runs in the browser, reads one or more T-Beam LoRa receivers over USB.

## Standalone executable

For running it without opening the page or picking ports by hand: grab the file for your machine
from the [Releases](../../releases) page — `descent-ground-linux-x64`, `descent-ground-macos-arm64`
or `descent-ground-windows-x64.exe`. One file, no install. Double-click it and it opens your browser to the dashboard, finds every T-Beam plugged in with no port picker, and writes every line from every receiver to a log file next to itself, whether or not a browser is open.

- Windows: the exe is unsigned, so SmartScreen warns once — More info → Run anyway.
- Linux: you need to be in the `dialout` group, the same one Chrome's Web Serial already needs.
- Needs no internet at all, on either platform.

It opens your browser on startup. To stop that, run it with `--no-browser`, or put
`browser = no` in a file called `descent-ground.conf` beside the program — a double-click cannot
pass a flag, so the file is the way to make it stick. Either way it prints its address, and you
open that when you want it. `--browser` overrides the file for one run, and `--help` lists the
lot.

Flashing saves the board's existing firmware first, which reads the whole chip and takes a few
minutes with a running count. Untick **save the old firmware first** to skip it.

If you cannot tell which port is which board, press **Which board is which?**, then unplug the
board you mean and plug it back in. The app watches which port disappears and returns, and you give
that one a name. Nothing is opened to do this, so it is safe to do with a ChipSat on the same
laptop. **Test** listens to a board for five seconds without writing to it and says whether it
heard a receiver, an old CSV receiver, something else, or silence.

Every board you plug in is listed under **Set up receiver** with its USB chip and serial number.
You say which ones are receivers; the app opens those and leaves everything else alone. It asks
first because opening a port pulses DTR, which resets an ESP32, and the USB chip cannot tell a
T-Beam from a ChipSat: they can carry the same one.

The answer is remembered per board, not per socket, in `descent-ground-boards.txt` beside the app,
so a replug or a different USB port needs no second answer and any new T-Beam takes one click.
Disconnecting a receiver with ✕ keeps it shut until you plug it back in.

## Building it yourself

`tools/rebuild.sh` builds both binaries in `app/target`. The `post-commit` and `post-merge` git
hooks run it in the background, so the paths people launch stay current.

This matters more than it sounds. The dashboard is compiled into the binary, so a build left over
from an earlier commit serves an older interface and nothing on screen says which. A build started
from a checkout now checks the tree beside it and says so on startup:

```
WARNING: this build is older than /…/descent-ground/web — run: cargo build --release
```

A downloaded release has no source beside it and says nothing. Every run prints its version.

## Runs

A ChipSat's counter starts again from 0 every time it reboots, so a reflash would otherwise mix old
data into new. Each run is kept separately: the one transmitting now keeps the plain CSID, and
earlier runs become `64a`, `64b` and so on, oldest first. The fleet list shows one row per board
with a `+3` button to unfold them, so a board that restarted thirty times is still one row.

Runs are managed in the **Runs** tab of the history panel, beside Overview and IMU: every run of the
selected board, what it holds, and a button to join it into the next one or throw it away. The fleet
list carries the same actions in miniature.

If a restart was an accident — a knocked cable on the bench — press **Join into the next run** and
the earlier run goes back into the current one, history and all. The restart is still counted, so the
board does not read as one that never rebooted. Individual runs can be deleted instead.

## Clearing

The **Clear** box at the bottom left holds one tick per thing: all units, only the unit shown,
receiver counts, hidden units, and starting a new log file. Tick what should go and press Clear.
Clearing receiver counts does not disconnect anything, and nothing already written to a log file is
touched unless you ask for a new one.

## Replaying a log without clicking

`?log=<url>` on the address opens a log on load and goes straight into replay, so pulling a chip can
end with the dashboard already showing it:

```
http://127.0.0.1:8765/?log=http://127.0.0.1:44333/log.log
```

Repeat the parameter to merge several files, as opening several at once does. Percent-encode the
inner URL if it contains an `&`. A file that will not load leaves a working page and says why.

Note that the hosted site at ground.privatepanda.co **cannot** do this for a log served from your
own machine: a page loaded over https is not allowed to fetch `http://127.0.0.1`, and the browser
blocks it before any request is made. Use the app's own address for that, as above.

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

A dump that names its boots with `#DG,BOOT,v1,n=<n>` is split into one run per boot, which the
counter alone could never do. Otherwise a chip log is not split into runs at all, nothing in
it is discarded as a duplicate reception, and the columns that are read off the transmission
counter — missed, restarts, Rx %, interval — show nothing rather than something wrong. The board
logs at 20 Hz while the counter moves once per transmission, and every boot in a dump starts at the
same time, so the counter tells you nothing about runs here.

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
