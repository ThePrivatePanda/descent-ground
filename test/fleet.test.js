const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../web/js/lines.js');
const P = require('../web/js/packet.js');
const { Fleet, LOST_MS } = require('../web/js/fleet.js');

const LOG_DIR = path.join(__dirname, '../../SSDS_DeSCENT/Software/V2_5_X/powerTesting/packetDecoder');

// Feed a real log through the fleet using its serial-monitor timestamps.
function replay(file) {
  const fleet = new Fleet();
  let day = 0; let prev = null; let t = 0;
  for (const line of fs.readFileSync(path.join(LOG_DIR, file), 'utf8').split('\n')) {
    const ev = L.parseLine(line);
    if (ev.clock !== null) {
      if (prev !== null && ev.clock < prev - 12 * 3600e3) day++;
      prev = ev.clock;
      t = ev.clock + day * 86400e3;
    }
    fleet.ingest(ev, t, 'rx1');
  }
  return { fleet, end: t };
}

// A real packet re-stamped with a new counter/CSID and a correct CRC.
function packetLine(counter, csid, rssi) {
  const base = P.decode(P.hexToBytes('00 00 00 00 00 00 00 00 98 BD FF FF 23 5B 00 00 FD FF 00 00 FD FF 01 00 FF FF FF FF AC FF 18 FF D4 FD 4A 06 8E 02 ED 82 56 1A 7A 0A 7F 26 0F 11 04 00 09 6D 6F 09 23'));
  const v = Object.assign({}, base.values, { counter, csid });
  const b = P.encode(v, 0);
  const crc = P.crc16(b, 53);
  return 'PKT,55,' + P.bytesToHex(P.encode(v, crc)) + ',' + rssi + ',5.00,0';
}

test('real log: resets, misses and interval match the ground survey', () => {
  const { fleet } = replay('two_five_seven.txt');
  const u7 = fleet.units.get(7);
  assert.strictEqual(u7.resets, 43);
  assert.strictEqual(u7.packets, 307);
  assert.ok(Math.abs(u7.intervalMs - 122000) < 1500);
  assert.strictEqual(fleet.units.get(5).resets, 4);
  assert.strictEqual(fleet.badCrc, 0);
});

test('real overnight log: three units, CSID 4 resets 31 times', () => {
  const { fleet } = replay('Three_Four_Seven_Overnight_Recieve_Logs.txt');
  assert.deepStrictEqual([...fleet.units.keys()].sort(), [3, 4, 7]);
  assert.strictEqual(fleet.units.get(4).resets, 31);
  assert.strictEqual(fleet.units.get(7).missed, 60);
});

test('same packet heard by two receivers counts once, keeps both RSSIs', () => {
  const fleet = new Fleet();
  assert.strictEqual(fleet.ingest(L.parseLine(packetLine(10, 3, -90)), 1000, 'A'), 'new');
  assert.strictEqual(fleet.ingest(L.parseLine(packetLine(10, 3, -70)), 1200, 'B'), 'duplicate');
  const u = fleet.units.get(3);
  assert.strictEqual(u.packets, 1);
  assert.strictEqual(u.receptions.length, 2);
  assert.strictEqual(u.bestRssi, -70);
  assert.strictEqual(u.history.rssi[0], -70);
  assert.deepStrictEqual(Object.keys(u.rxHistory).sort(), ['A', 'B']);
});

test('counter gap = missed, drop = reset, 65535 -> 0 = wrap', () => {
  const fleet = new Fleet();
  const feed = (c, t) => fleet.ingest(L.parseLine(packetLine(c, 1, -80)), t, 'A');
  feed(5, 0); feed(6, 1000); feed(9, 4000);
  const u = fleet.units.get(1);
  assert.strictEqual(u.missed, 2);
  feed(0, 5000);
  assert.strictEqual(u.resets, 1);
  feed(0, 12000);
  assert.strictEqual(u.resets, 2, '0 then 0 again is a reboot before packet 1');
  const w = new Fleet();
  w.ingest(L.parseLine(packetLine(65534, 1, -80)), 0, 'A');
  w.ingest(L.parseLine(packetLine(65535, 1, -80)), 1000, 'A');
  w.ingest(L.parseLine(packetLine(1, 1, -80)), 3000, 'A');
  const wu = w.units.get(1);
  assert.strictEqual(wu.resets, 0, 'wrap is not a reset');
  assert.strictEqual(wu.missed, 1, '65535 -> 1 skips counter 0');
  assert.strictEqual(wu.intervalMs, 1000);
});

test('stale after 3 intervals, lost after 10 minutes', () => {
  const fleet = new Fleet();
  for (let i = 0; i < 5; i++) fleet.ingest(L.parseLine(packetLine(i, 2, -80)), i * 1000, 'A');
  const u = fleet.units.get(2);
  assert.strictEqual(fleet.state(u, 4000 + 2000), 'OK');
  assert.strictEqual(fleet.state(u, 4000 + 6000), 'STALE');
  assert.strictEqual(fleet.state(u, 4000 + LOST_MS + 1), 'LOST');
});

test('bad CRC never creates or updates a unit', () => {
  const fleet = new Fleet();
  const line = packetLine(1, 9, -80);
  const broken = line.replace(/^(PKT,55,)(..)/, (m, a, b) => a + (b === '00' ? '01' : '00'));
  assert.strictEqual(fleet.ingest(L.parseLine(broken), 0, 'A'), 'badcrc');
  assert.strictEqual(fleet.units.size, 0);
  assert.strictEqual(fleet.badCrc, 1);
});
