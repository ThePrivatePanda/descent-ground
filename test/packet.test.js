const test = require('node:test');
const assert = require('node:assert');
const P = require('../web/js/packet.js');

// Real packet from a ChipSat console hex dump
// (SSDS/logs/20260909_195429_baseline_prior_fw.log, line 34).
const REAL_HEX = '00 00 00 00 00 00 00 00 98 BD FF FF 23 5B 00 00 FD FF 00 00 FD FF 01 00 FF FF FF FF AC FF 18 FF D4 FD 4A 06 8E 02 ED 82 56 1A 7A 0A 7F 26 0F 11 04 00 09 6D 6F 09 23';

test('CRC-16/CCITT-FALSE standard check value', () => {
  assert.strictEqual(P.crc16(new TextEncoder().encode('123456789'), 9), 0x29b1);
});

test('decodes a real ChipSat packet', () => {
  const r = P.decode(P.hexToBytes(REAL_HEX));
  assert.ok(r.ok);
  assert.ok(r.crcOk);
  assert.strictEqual(r.crcReceived, 0x2309);
  assert.strictEqual(r.values.counter, 4);
  assert.strictEqual(r.values.csid, 9);
  assert.strictEqual(r.values.validity, 0x6f);
  assert.strictEqual(r.valid.gps, false);
  assert.strictEqual(r.valid.accel, true);
  assert.strictEqual(r.valid.fresh, false);
  assert.strictEqual(r.values.gpsAlt, -17);
  assert.strictEqual(r.saturated, false);
});

test('a flipped bit fails the CRC', () => {
  const b = P.hexToBytes(REAL_HEX);
  b[10] ^= 0x01;
  assert.strictEqual(P.decode(b).crcOk, false);
});

test('wrong length is reported, not thrown', () => {
  const r = P.decode(new Uint8Array(54));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /length 54/);
});

test('encode(decode(x)) round-trips the real packet', () => {
  const b = P.hexToBytes(REAL_HEX);
  const r = P.decode(b);
  assert.deepStrictEqual(Array.from(P.encode(r.values, r.crcReceived)), Array.from(b));
});

test('saturation flag only when accel is valid and near ±8 g', () => {
  const r = P.decode(P.hexToBytes(REAL_HEX));
  const v = Object.assign({}, r.values, { ax: -78.4 });
  const b = P.encode(v, 0);
  const crc = P.crc16(b, 53);
  const r2 = P.decode(P.encode(v, crc));
  assert.ok(r2.crcOk);
  assert.strictEqual(r2.saturated, true);
  const r3 = P.decode(P.encode(Object.assign({}, v, { validity: v.validity & ~1 }), 0));
  assert.strictEqual(r3.saturated, false);
});
