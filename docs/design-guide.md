# Design guide

**Identity:** ground-station instrument software. Cool slate surfaces, one engineering typeface, numbers first. Colour only means state.

## Colour

| Token | Light | Dark | Meaning (only this) |
|---|---|---|---|
| `--bg` | `#edf0f3` | `#0e151c` | App background |
| `--panel` | `#ffffff` | `#151f29` | Panes |
| `--ink` / `--ink-2` / `--ink-3` | `#18222c` / `#566474` / `#8a96a3` | `#e4eaf0` / `#a3b0bd` / `#6d7b89` | Values / labels / units, stale values |
| `--accent` | `#2f6fdb` | `#5b92ea` | Selection, primary action |
| `--good` | `#0f8a3c` | `#3cbf6a` | OK, valid bit, CRC pass |
| `--warning` | `#b7791f` | `#e0a53a` | Stale, near stale, saturation |
| `--serious` | `#c2572b` | `#e5794d` | Low battery, weak RF, resets |
| `--critical` | `#c93434` | `#ec6464` | Lost, invalid bit, CRC fail |
| `--series-1..8` | validated palette | | Chart lines in fixed order (X Y Z, or receivers in connect order), drawn at 70% opacity |

- Status is never colour alone: a word ("Lost"), a letter (L G M Q P S E F) or a shape (hollow dot = lost).
- An invalid field shows its last trusted value in `--ink-3`, or `—`.

## Type

- IBM Plex Sans (400/500/600) for everything; tabular figures on the whole page.
- IBM Plex Mono only for hex (CRC, validity mask).
- Fonts are stored in `web/vendor/fonts/`, so the page works offline.
- Sentence case everywhere. No all-caps labels, no middle-dot separators.

## Layout

- Left: the selected unit. Header (CSID, state, time), validity row, then lists by area (Link, GPS, Environment, Accelerometer, Gyroscope, Magnetometer, Orientation), flowing into two columns. Never scrolls.
- Right top: fleet table. The header shows unit and packet counts; issue counts appear only when non-zero.
- Right bottom: two wide chart columns, 190 px plots, no boxes. Single-series charts have no legend; the hover value appears beside the title.

## The one distinctive element

The "Last heard" cell: time since the last packet, over a thin bar that fills toward that unit's own stale limit (green, amber past two thirds, red once stale).

## Motion

None.
