const test = require('node:test');
const assert = require('node:assert');
const R = require('../web/js/recorder.js');

test('recorded lines read back exactly (our log format)', () => {
  const rows = [
    { t: 1790000000000, rx: 'rx1', text: 'PKT,55,00FF,-50.0,13.75,-12' },
    { t: 1790000000400, rx: 'rx2', text: '#DG,RX,v1,id=A1B2C3,f=915.0' },
    { t: 1790000001000, rx: 'rx1', text: 'HB,5000,3,0' },
  ];
  const file = R.HEADER + ' started x\n' + rows.map((r) => R.formatLine(r.t, r.rx, r.text)).join('');
  assert.deepStrictEqual(R.parseLogFile(file, 'a.log', 0), rows);
});

test('tabs and CR inside a line cannot break the format', () => {
  const file = R.HEADER + '\n' + R.formatLine(5, 'rx1', 'a\tb\rc');
  assert.deepStrictEqual(R.parseLogFile(file, 'a.log', 0), [{ t: 5, rx: 'rx1', text: 'a b c' }]);
});

test('two receiver files merge in time order', () => {
  const a = R.parseLogFile(R.HEADER + '\n' + R.formatLine(10, 'rx1', 'x') + R.formatLine(30, 'rx1', 'y'), 'a', 0);
  const b = R.parseLogFile(R.HEADER + '\n' + R.formatLine(20, 'rx2', 'z'), 'b', 0);
  assert.deepStrictEqual(R.mergeFiles([a, b]).map((e) => e.text), ['x', 'z', 'y']);
});

test('lab log with serial-monitor times, and one without any times', () => {
  const timed = R.parseLogFile('﻿23:59:59.000 -> a\n00:00:01.500 -> b\n', 'lab.txt', 1000);
  assert.deepStrictEqual(timed.map((e) => e.t), [1000 + 86399000, 1000 + 86400000 + 1500], 'midnight rollover');
  assert.strictEqual(timed[0].rx, 'lab');
  const bare = R.parseLogFile('Latitude_deg,x\n1,2\n3,4\n', 'bare.txt', 0);
  assert.deepStrictEqual(bare.map((e) => e.t), [0, 1000, 2000]);
});

test('recording: all receivers, nothing while paused, readable on replay', async () => {
  const rec = new R.Recorder();
  rec.add(1, 'rx1', 'before start', false);          // session only
  await rec.start('t');
  assert.strictEqual(rec.state, 'recording');
  rec.add(10, 'rx1', 'PKT,a', true);
  rec.add(11, 'rx2', 'PKT,b', true);
  rec.add(12, 'rx2', 'HB,1,1,0', false);
  rec.pause();
  rec.add(20, 'rx1', 'while paused', true);
  rec.resume();
  rec.add(30, 'rx3', 'PKT,c', true);
  const blob = await rec.stop();
  const events = R.parseLogFile(await blob.text(), 'x', 0);
  assert.deepStrictEqual(events.map((e) => e.rx + ' ' + e.text), ['rx1 PKT,a', 'rx2 PKT,b', 'rx2 HB,1,1,0', 'rx3 PKT,c']);
  assert.deepStrictEqual(rec.rec.perRx, { rx1: { lines: 1, packets: 1 }, rx2: { lines: 2, packets: 1 }, rx3: { lines: 1, packets: 1 } });
  assert.strictEqual(rec.lines, 6, 'the session keeps every line, paused or not');
  assert.strictEqual(rec.state, 'idle');
});
