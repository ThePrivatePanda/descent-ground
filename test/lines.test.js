const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../web/js/lines.js');
const P = require('../web/js/packet.js');

// Real CSV-receiver logs from the team repo (read-only).
const LOG_DIR = path.join(__dirname, '../../SSDS_DeSCENT/Software/V2_5_X/powerTesting/packetDecoder');
const REAL_HEX = '00 00 00 00 00 00 00 00 98 BD FF FF 23 5B 00 00 FD FF 00 00 FD FF 01 00 FF FF FF FF AC FF 18 FF D4 FD 4A 06 8E 02 ED 82 56 1A 7A 0A 7F 26 0F 11 04 00 09 6D 6F 09 23';

test('raw receiver PKT line', () => {
  const hex = REAL_HEX.replace(/ /g, '');
  const ev = L.parseLine('PKT,55,' + hex + ',-50.0,13.75,-1234\r');
  assert.strictEqual(ev.kind, 'packet');
  assert.strictEqual(ev.source, 'raw');
  assert.ok(ev.decoded.crcOk);
  assert.strictEqual(ev.decoded.values.csid, 9);
  assert.strictEqual(ev.rssi, -50);
  assert.strictEqual(ev.snr, 13.75);
  assert.strictEqual(ev.freqErr, -1234);
});

test('raw receiver short packet is badlength', () => {
  assert.strictEqual(L.parseLine('PKT,3,010203,-90.0,1.00,0').kind, 'badlength');
});

test('receiver info, heartbeat and error lines', () => {
  const info = L.parseLine('#DG,RX,v1,id=A1B2C3,f=915.0,bw=125.0,sf=9,cr=7,sync=0x12,pre=8');
  assert.strictEqual(info.kind, 'rxinfo');
  assert.strictEqual(info.info.id, 'A1B2C3');
  assert.strictEqual(info.info.sf, '9');
  assert.deepStrictEqual(
    { k: L.parseLine('HB,5000,12,1').kind, ok: L.parseLine('HB,5000,12,1').ok },
    { k: 'heartbeat', ok: 12 });
  assert.strictEqual(L.parseLine('ERR,-7,-120.5,-12.25').code, -7);
});

test('console hex dump with serial-monitor timestamp', () => {
  const ev = L.parseLine('19:54:56.286  ' + REAL_HEX);
  assert.strictEqual(ev.kind, 'packet');
  assert.strictEqual(ev.source, 'hexdump');
  assert.strictEqual(ev.clock, ((19 * 60 + 54) * 60 + 56) * 1000 + 286);
});

test('every row of every real CSV log rebuilds to its logged CRC', () => {
  const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.txt'));
  let rows = 0; let headers = 0; const bad = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n')) {
      const ev = L.parseLine(line);
      if (ev.kind === 'csvheader') headers++;
      if (ev.kind !== 'packet') continue;
      rows++;
      assert.strictEqual(ev.source, 'csv');
      if (!ev.decoded.crcOk) bad.push(f + ': ' + line.slice(0, 80));
    }
  }
  assert.strictEqual(files.length, 12);
  assert.ok(headers >= 12);
  assert.strictEqual(rows, 5652, 'expected the 5,652 rows counted in notes/discovery/ground.md');
  assert.deepStrictEqual(bad, []);
});

test('a corrupted CSV value is caught by the rebuilt CRC', () => {
  const file = path.join(LOG_DIR, 'two_five_seven.txt');
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => L.parseLine(l).kind === 'packet');
  const parts = line.replace(/^.*-> /, '').split(',');
  parts[20] = String(Number(parts[20]) + 1); // counter off by one
  const ev = L.parseLine(parts.join(','));
  assert.strictEqual(ev.decoded.crcOk, false);
});

test('unrelated lines are other, never packets', () => {
  for (const s of ['Radio receive failed. RadioLib code -24', 'hello', '1,2,3']) {
    assert.strictEqual(L.parseLine(s).kind, 'other');
  }
  assert.strictEqual(P.FIELDS.length, 24);
});
