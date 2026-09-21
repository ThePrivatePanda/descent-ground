# Design guide

**Identity:** a ground-station console. Quiet chrome, mono numbers, one row per ChipSat. Colour only ever means link or sensor state.

## Colour

| Token | Meaning (only this) |
|---|---|
| `--good` `#0ca30c` | OK state, valid bit set, CRC pass |
| `--warning` `#fab219` | Stale unit, saturation, receiver quiet |
| `--serious` `#ec835a` | Low battery, weak RF |
| `--critical` `#d03b3b` | Lost unit, invalid bit, CRC fail |
| `--accent` (blue) | Selection only |
| `--series-1..8` | Chart lines, fixed order (X Y Z, or receivers in connect order) |

- Status always comes with a glyph or a letter (● ◐ ○, L G M Q P S E F). Never colour alone.
- Invalid data shows `—` plus the last trusted value in muted ink. It is never shown as live.

## Type

- UI labels: system sans.
- Every changing number: system mono + `tabular-nums`.
- No web fonts, so the page works offline.

## Layout

- Left: latest packet of the selected unit.
- Right top: fleet list.
- Right bottom: graph tabs.
- Each pane scrolls on its own; the page never scrolls.

## Motion

None, except a row flash when a new packet arrives.
