# Firmware image

`descent-raw-receiver-1.0.0.bin` is the receiver sketch as one merged image, ready to write at
offset 0. The standalone app carries a copy and flashes it over USB, so nobody needs the Arduino
toolchain to set up a T-Beam. It is the sketch in `../DescentRawReceiver/` built with the ESP32
core 2.0.17 and RadioLib 7.1.2, 382 KB of program storage.

Rebuild it after changing the sketch:

```
arduino-cli compile --fqbn esp32:esp32:t-beam --output-dir /tmp/dgrx ../DescentRawReceiver
esptool.py --chip esp32 merge_bin -o descent-raw-receiver-<version>.bin \
  0x1000 /tmp/dgrx/DescentRawReceiver.ino.bootloader.bin \
  0x8000 /tmp/dgrx/DescentRawReceiver.ino.partitions.bin \
  0xe000 <esp32 core>/tools/partitions/boot_app0.bin \
  0x10000 /tmp/dgrx/DescentRawReceiver.ino.bin
```

No `--flash_mode` or `--flash_size`: the defaults keep whatever the bootloader header already says.
The first 4 kB of the merged file are padding, so the 0xE9 image magic sits at 0x1000 rather than
at byte zero. The app looks for it there and refuses a bare app image, which would otherwise go to
the wrong offset and leave a board needing a rescue.

The version in the name is the sketch's, bumped by hand. The app embeds whichever `.bin` here
sorts last when it is built.
