# Field card

One page to print. There is no internet at the site, so nothing here needs it.

## Before leaving

- download map tiles while you still have a connection: **Map** → centre, radius, **Download tiles**
- set the spreading factor you are flying and flash both receivers to it
- flash a spare T-Beam the same way, so a dead receiver is a swap
- check the laptop clock, because logs are timestamped from it
- check free disk space; a long flight is a few MB, a chip dump about 5 MB
- close the Arduino IDE, including its Serial Monitor

## Starting up

1. plug the receiver in
2. open the app, go to **Hardware**
3. mark the board **This is a receiver** — nothing is offered for flashing or reading until you do
4. pick the spreading factor, **Flash** if it needs it
5. wait for packets in the fleet table
6. set **Home** in the Recovery pane to where you are standing: type it, or **Use last fix**

## During the flight

- Recovery shows the last known position, distance and bearing from Home, and whether it is falling
- a unit that stops being heard beeps three times
- **Copy** puts the position on the clipboard for reading out
- the log is written continuously next to the program, browser open or not

## After landing

- walk out on the bearing and distance in the Recovery pane
- **Pull from chip** for the on-board log: needs the ST-Link, takes a few minutes, flashes twice
- the flight software is saved before the dump and written back after

## When something looks broken

- **"Device or resource busy"** — something else holds the port. Usually the Arduino IDE's Serial
  Monitor. Close it and try again.
- **busy for the first few seconds after plugging in** — ModemManager is probing the port. Wait
  fifteen seconds.
- **no Flash button** — the board is not marked as a receiver yet.
- **"no data"** on a receiver — wrong spreading factor, or it is a different board than you think.
  **Test** says what a board is without writing to it.
- **map is blank squares** — those tiles were never downloaded. The position numbers still work.
- **SF6 does not link** — the ChipSat sends an explicit header, which the receiver cannot read at
  SF6. Fly SF7 or above.

## Numbers

| | |
|---|---|
| Frequency | 915.0 MHz |
| Bandwidth | 125 kHz |
| Coding rate | 4/7 |
| Sync word | 0x12 |
| Preamble | 8 |
| Packet | 55 bytes, CRC-16/CCITT-FALSE over the first 53 |
