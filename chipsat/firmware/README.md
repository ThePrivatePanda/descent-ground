# flash_dump

`flash_dump.bin` is the ChipSat bench sketch that prints the flight log over the console. The app
carries a copy and writes it to the board itself, so pulling a log needs no toolchain, no OpenOCD
and no checkout of the flight repo.

It is built in the flight repo, not here:

```
./build.sh --sketch flash_dump      # builds only, does not flash
```

which leaves `firmware/flash_dump.bin` there. Copy it in and rebuild the app. The flight repo's
`build/` is wiped by every build, which is why the copy lives here instead of being read from there.

Flashes at 0x08000000 on an STM32WLE5.

| | |
|---|---|
| taken from | `SSDS_DeSCENT/Software/V2_6_X/firmware/flash_dump.bin` |
| size | 31224 bytes |
| sha256 | 4a5f0ead87429a51d9c84757c8be07058b58ed14ac885e25b9f48ca3f8c531a6 |

The sketch changes — it grew a larger line buffer when the `found` summary was being cut off at 96
characters — and the image carries no version of its own. The app prints the first twelve
characters of this hash on startup and reports it at `/api/health`, so a copy that has fallen
behind the sketch can be seen rather than guessed at.
