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

// A reset now ends a generation instead of only being counted, so the facts these
// logs established are the same numbers read across a board's generations.
function gens(fleet, csid) {
  return [...fleet.allUnits().values()].filter((u) => u.csid === csid);
}
function sum(fleet, csid, key) {
  return gens(fleet, csid).reduce((a, u) => a + u[key], 0);
}
function resetsOf(fleet, csid) {
  return gens(fleet, csid).length - 1;   // n generations means n-1 reboots
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
  assert.strictEqual(resetsOf(fleet, 7), 43);
  assert.strictEqual(sum(fleet, 7, 'packets'), 307);
  assert.ok(Math.abs(fleet.units.get(7).intervalMs - 122000) < 1500);
  assert.strictEqual(resetsOf(fleet, 5), 4);
  assert.strictEqual(fleet.badCrc, 0);
  // Every history series lines up with the time axis, in every generation.
  for (const u of fleet.allUnits().values()) {
    for (const [k, col] of Object.entries(u.history)) assert.strictEqual(col.length, u.history.t.length, 'series ' + k);
  }
  const u2 = fleet.units.get(2);
  assert.strictEqual(u2.history.battery.at(-1), u2.latest.values.battery);
});

test('real overnight log: three units, CSID 4 resets 31 times', () => {
  const { fleet } = replay('Three_Four_Seven_Overnight_Recieve_Logs.txt');
  assert.deepStrictEqual([...fleet.units.keys()].sort(), [3, 4, 7]);
  assert.strictEqual(resetsOf(fleet, 4), 31);
  assert.strictEqual(sum(fleet, 7, 'missed'), 60);
  // 31 reboots is 32 generations of one board: the table has to fold these away.
  assert.strictEqual(gens(fleet, 4).length, 32);
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
  assert.strictEqual(fleet.units.get(1).missed, 2);
  feed(0, 5000);
  assert.strictEqual(resetsOf(fleet, 1), 1, 'a counter drop ends the run');
  assert.strictEqual(fleet.unit('1a').missed, 2, 'the missed packets stay with the run they happened in');
  feed(0, 12000);
  assert.strictEqual(resetsOf(fleet, 1), 2, '0 then 0 again is a reboot before packet 1');
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

test('history retention: drop points older than N minutes, and a point cap', () => {
  const fleet = new Fleet({ retainMin: 1 });
  for (let i = 0; i < 180; i++) fleet.ingest(L.parseLine(packetLine(i, 4, -80)), i * 1000, 'A');
  const h = fleet.units.get(4).history;
  assert.ok(h.t[0] >= 179 - 60, 'oldest point within 1 min of newest');
  for (const col of Object.values(h)) assert.strictEqual(col.length, h.t.length);
  fleet.setConfig({ retainMin: 0, maxPoints: 10 });
  assert.strictEqual(h.t.length, 10);
  assert.strictEqual(fleet.units.get(4).packets, 180, 'counts are never dropped');
});

test('thresholds come from settings', () => {
  const fleet = new Fleet({ lostMin: 1 });
  fleet.ingest(L.parseLine(packetLine(1, 6, -80)), 0, 'A');
  assert.strictEqual(fleet.state(fleet.units.get(6), 61000), 'LOST');
});

// A reflashed board starts its counter again. The run that ended keeps its data under
// a letter so it cannot be read as part of the new one.
function synthetic(csid, counter) {
  const values = {};
  for (const f of P.FIELDS) values[f.key] = 0;
  values.csid = csid;
  values.counter = counter;
  const blank = P.encode(values, 0);
  return L.parseLine('PKT,55,' + P.bytesToHex(P.encode(values, P.crc16(blank, P.DATA_LENGTH))) + ',,,');
}

test('a counter reset retires the old run under a letter, newest keeps the plain CSID', () => {
  const fleet = new Fleet();
  let t = 1000;
  for (const c of [0, 1, 2]) fleet.ingest(synthetic(64, c), t += 1000, 'rx1');
  for (const c of [0, 1]) fleet.ingest(synthetic(64, c), t += 1000, 'rx1');
  for (const c of [0, 1, 2, 3]) fleet.ingest(synthetic(64, c), t += 1000, 'rx1');

  assert.deepStrictEqual([...fleet.allUnits().keys()].sort(), ['64', '64a', '64b']);
  assert.equal(fleet.unit('64').packets, 4);
  assert.equal(fleet.unit('64').live, true);
  assert.equal(fleet.unit('64a').packets, 3);   // oldest run
  assert.equal(fleet.unit('64b').packets, 2);
  assert.equal(fleet.unit('64a').live, false);
});

test('a counter wrap at 65535 is not a new generation', () => {
  const fleet = new Fleet();
  let t = 1000;
  fleet.ingest(synthetic(64, 65534), t += 1000, 'rx1');
  fleet.ingest(synthetic(64, 65535), t += 1000, 'rx1');
  fleet.ingest(synthetic(64, 0), t += 1000, 'rx1');
  assert.deepStrictEqual([...fleet.allUnits().keys()], ['64']);
  assert.equal(fleet.unit('64').packets, 3);
});

test('clearing one unit leaves the others and the receiver alone', () => {
  const fleet = new Fleet();
  let t = 1000;
  fleet.ingest(synthetic(64, 0), t += 1000, 'rx1');
  fleet.ingest(synthetic(65, 0), t += 1000, 'rx1');
  assert.equal(fleet.clearUnit('64'), true);
  assert.equal(fleet.unit('64'), null);
  assert.equal(fleet.unit('65').packets, 1);
  assert.equal(fleet.receivers.get('rx1').packets, 2);
  assert.equal(fleet.clearUnit('64'), false);
});

test('clearing receiver counts keeps the receiver connected', () => {
  const fleet = new Fleet();
  fleet.ingest(synthetic(64, 0), 2000, 'rx1');
  assert.equal(fleet.receivers.get('rx1').packets, 1);
  fleet.clearReceivers();
  assert.equal(fleet.receivers.get('rx1').packets, 0);
  assert.ok(fleet.receivers.has('rx1'));
});

test('clearing everything leaves no units and no totals', () => {
  const fleet = new Fleet();
  let t = 1000;
  for (const c of [0, 1]) fleet.ingest(synthetic(64, c), t += 1000, 'rx1');
  for (const c of [0, 1]) fleet.ingest(synthetic(64, c), t += 1000, 'rx1');
  assert.equal(fleet.allUnits().size, 2);
  fleet.clearUnits();
  assert.equal(fleet.allUnits().size, 0);
  assert.equal(fleet.total, 0);
  assert.equal(fleet.badCrc, 0);
});

test('past the 26th run the labels keep their order', () => {
  const fleet = new Fleet();
  let t = 1000;
  for (let run = 0; run < 30; run++) {
    fleet.ingest(synthetic(9, 0), t += 1000, 'rx1');
    fleet.ingest(synthetic(9, 1), t += 1000, 'rx1');
  }
  const runs = fleet.earlierRuns(9);
  assert.strictEqual(runs.length, 29);
  assert.strictEqual(runs[0].label, '9a');
  assert.strictEqual(runs[25].label, '9z');
  assert.strictEqual(runs[26].label, '9aa', 'the 27th run carries on past z');
  assert.deepStrictEqual(runs.map((u) => u.gen), runs.map((u, i) => i), 'oldest first, no reordering');
});

test('an accidental reset can be merged back into the run that followed', () => {
  const fleet = new Fleet();
  let t = 1000;
  for (const c of [0, 1, 2]) fleet.ingest(synthetic(64, c), t += 1000, 'rx1');
  for (const c of [0, 1]) fleet.ingest(synthetic(64, c), t += 1000, 'rx1');
  assert.deepStrictEqual([...fleet.allUnits().keys()].sort(), ['64', '64a']);

  const before = fleet.unit('64a').history.t.length + fleet.unit('64').history.t.length;
  assert.strictEqual(fleet.mergeRun('64a'), '64');
  assert.strictEqual(fleet.unit('64a'), null, 'the merged run is gone');
  const u = fleet.unit('64');
  assert.strictEqual(u.packets, 5, 'packets from both runs');
  assert.strictEqual(u.history.t.length, before, 'no history points lost');
  for (const [k, col] of Object.entries(u.history)) {
    assert.strictEqual(col.length, u.history.t.length, 'series ' + k + ' still lines up');
  }
  assert.ok(u.history.t.every((v, i) => i === 0 || v >= u.history.t[i - 1]), 'times still go forward');
});

test('merging is a no-op on a run that is not there', () => {
  const fleet = new Fleet();
  fleet.ingest(synthetic(64, 0), 2000, 'rx1');
  assert.strictEqual(fleet.mergeRun('64z'), null);
  assert.strictEqual(fleet.unit('64').packets, 1);
});

test('all of a board\'s earlier runs can go back into the live one at once', () => {
  const fleet = new Fleet();
  let t = 1000;
  for (let run = 0; run < 4; run++) for (const c of [0, 1]) fleet.ingest(synthetic(7, c), t += 1000, 'rx1');
  assert.strictEqual(fleet.earlierRuns(7).length, 3);
  assert.strictEqual(fleet.mergeAllRuns(7), 3);
  assert.strictEqual(fleet.earlierRuns(7).length, 0);
  assert.strictEqual(fleet.unit('7').packets, 8);
  assert.strictEqual(fleet.unit('7').history.t.length, 8);
});

test('a merged board still shows that it rebooted', () => {
  const fleet = new Fleet();
  let t = 1000;
  for (const c of [0, 1, 2]) fleet.ingest(synthetic(64, c), t += 1000, 'rx1');
  for (const c of [0, 1]) fleet.ingest(synthetic(64, c), t += 1000, 'rx1');
  fleet.mergeRun('64a');
  assert.strictEqual(fleet.unit('64').resets, 1, 'the restart is still counted after merging');
});

test('lettering starts again once a board has no runs left', () => {
  const fleet = new Fleet();
  let t = 1000;
  for (const c of [0, 1]) fleet.ingest(synthetic(64, c), t += 1000, 'rx1');
  for (const c of [0, 1]) fleet.ingest(synthetic(64, c), t += 1000, 'rx1');
  assert.ok(fleet.unit('64a'));
  fleet.clearUnit('64a');
  fleet.clearUnit('64');
  // Two identical packets inside the dedupe window are one packet, so space them.
  fleet.ingest(synthetic(64, 0), t += 5000, 'rx1');
  fleet.ingest(synthetic(64, 0), t += 5000, 'rx1');
  assert.ok(fleet.unit('64a'), 'the next split is 64a again, not a letter further on');
});
