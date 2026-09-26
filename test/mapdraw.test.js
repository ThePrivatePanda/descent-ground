const test = require('node:test');
const assert = require('node:assert');

// The drawing runs in a browser, so the few browser things it touches are stood in for
// here. This checks where it puts things, not what they look like.
class FakeImage {
  constructor() { this.complete = false; this.naturalWidth = 0; }
}
function recorder() {
  const calls = [];
  const ctx = {};
  for (const name of ['fillRect', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill', 'clearRect']) {
    ctx[name] = (...args) => calls.push({ name, args });
  }
  return { ctx, calls };
}
function fakeCanvas(w, h) {
  const r = recorder();
  return { width: w, height: h, calls: r.calls, getContext: () => r.ctx };
}

global.Image = FakeImage;
global.getComputedStyle = () => ({ getPropertyValue: () => '' });

const M = require('../web/js/mapview.js');

test('the point the view is centred on lands in the middle of the canvas', () => {
  M.forget();
  const c = fakeCanvas(800, 600);
  const fix = { lat: 42.4439578, lon: -76.4797761 };
  const out = M.draw(c, { lat: fix.lat, lon: fix.lon, zoom: 16 }, { fix });
  assert.strictEqual(out.zoom, 16);
  const arc = c.calls.find((k) => k.name === 'arc');
  assert.ok(arc, 'the last fix is drawn');
  assert.ok(Math.abs(arc.args[0] - 400) < 0.5, 'x is the middle, got ' + arc.args[0]);
  assert.ok(Math.abs(arc.args[1] - 300) < 0.5, 'y is the middle, got ' + arc.args[1]);
});

test('missing tiles are reported and none are drawn', () => {
  M.forget();
  const c = fakeCanvas(512, 512);
  const out = M.draw(c, { lat: 0, lon: 0, zoom: 10 }, {});
  // Nothing was downloaded in this test, so every square the canvas covers is missing.
  assert.ok(out.missing >= 4 && out.missing <= 12, 'a 512 px canvas covers a handful, got ' + out.missing);
  assert.strictEqual(c.calls.filter((k) => k.name === 'drawImage').length, 0, 'no tile is drawn');
  assert.ok(c.calls.some((k) => k.name === 'fillRect'), 'the background is still painted');
});

test('the track is drawn as one line through every point', () => {
  M.forget();
  const c = fakeCanvas(800, 600);
  const track = [];
  for (let i = 0; i < 12; i++) track.push({ lat: 42.4439 + i * 0.0001, lon: -76.4797 - i * 0.0001 });
  M.draw(c, { lat: 42.444, lon: -76.480, zoom: 17 }, { track });
  const moves = c.calls.filter((k) => k.name === 'moveTo');
  const lines = c.calls.filter((k) => k.name === 'lineTo');
  assert.strictEqual(moves.length, 1, 'one start');
  assert.strictEqual(lines.length, 11, 'and a segment to each of the others');
  // A track going north-east on the ground goes right and up on screen.
  assert.ok(lines[10].args[0] < moves[0].args[0], 'west is left');
  assert.ok(lines[10].args[1] < moves[0].args[1], 'north is up');
});

test('a single point track is not stroked as a line', () => {
  M.forget();
  const c = fakeCanvas(400, 400);
  M.draw(c, { lat: 0, lon: 0, zoom: 12 }, { track: [{ lat: 0, lon: 0 }] });
  assert.strictEqual(c.calls.filter((k) => k.name === 'lineTo').length, 0);
});

test('home is a cross, and it is where it should be relative to the fix', () => {
  M.forget();
  const c = fakeCanvas(800, 600);
  const home = { lat: 42.4400, lon: -76.4800 };
  const fix = { lat: 42.4450, lon: -76.4700 };   // north-east of home
  M.draw(c, { lat: home.lat, lon: home.lon, zoom: 15 }, { home, fix });
  const lines = c.calls.filter((k) => k.name === 'moveTo');
  assert.strictEqual(lines.length, 2, 'the cross is two strokes');
  const arc = c.calls.find((k) => k.name === 'arc');
  assert.ok(arc.args[0] > 400, 'the fix is east of centre, so to the right');
  assert.ok(arc.args[1] < 300, 'and north of centre, so above');
});

test('tiles outside the world are skipped rather than requested', () => {
  M.forget();
  const c = fakeCanvas(900, 700);
  // At zoom 1 there are only four tiles, so a big canvas runs off the edges.
  const out = M.draw(c, { lat: 0, lon: 0, zoom: 1 }, {});
  assert.ok(out.missing <= 4, 'never more than the world has, got ' + out.missing);
});
