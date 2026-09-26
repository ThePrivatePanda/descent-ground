const test = require('node:test');
const assert = require('node:assert');
const R = require('../web/js/recovery.js');

// A unit as the fleet builds it, cut down to what recovery reads.
function unit(points) {
  const h = { t: [], lat: [], lon: [], gpsAlt: [], envAlt: [] };
  for (const p of points) {
    h.t.push(p.t);
    h.lat.push(p.lat === undefined ? null : p.lat);
    h.lon.push(p.lon === undefined ? null : p.lon);
    h.gpsAlt.push(p.gpsAlt === undefined ? null : p.gpsAlt);
    h.envAlt.push(p.envAlt === undefined ? null : p.envAlt);
  }
  return { history: h };
}

test('distance and bearing against known pairs', () => {
  // A tenth of a degree of latitude is 11.1 km due north, whatever the longitude.
  let g = R.greatCircle(52.0, 5.0, 52.1, 5.0);
  assert.ok(Math.abs(g.m - 11119) < 20, 'a tenth of a degree north is about 11.1 km, got ' + g.m);
  assert.ok(Math.abs(g.deg - 0) < 0.01, 'due north is 0 degrees, got ' + g.deg);

  g = R.greatCircle(0, 0, 0, 1);
  assert.ok(Math.abs(g.m - 111195) < 60, 'a degree of longitude at the equator, got ' + g.m);
  assert.strictEqual(Math.round(g.deg), 90, 'due east is 90 degrees');

  // London to Paris, a pair with a published answer: about 344 km on a bearing of 148.
  g = R.greatCircle(51.5007, -0.1246, 48.8566, 2.3522);
  assert.ok(Math.abs(g.m - 343500) < 2000, 'London to Paris is about 343.5 km, got ' + g.m);
  assert.ok(Math.abs(g.deg - 148) < 1.5, 'bearing about 148 degrees, got ' + g.deg);
});

test('compass points read the right way round', () => {
  assert.strictEqual(R.compass(0), 'N');
  assert.strictEqual(R.compass(44), 'NE');
  assert.strictEqual(R.compass(90), 'E');
  assert.strictEqual(R.compass(181), 'S');
  assert.strictEqual(R.compass(315), 'NW');
  assert.strictEqual(R.compass(359), 'N', 'wraps back to north');
});

test('last fix ignores invalid packets and a 0,0 unlocked receiver', () => {
  const u = unit([
    { t: 1, lat: 52.1, lon: 5.1 },
    { t: 2 },                       // invalid GPS in this packet
    { t: 3, lat: 0, lon: 0 },       // no lock yet, not the Atlantic
  ]);
  const fix = R.lastFix(u);
  assert.ok(fix, 'a fix is found');
  assert.strictEqual(fix.lat, 52.1);
  assert.strictEqual(fix.t, 1000, 'reported in milliseconds');
  assert.strictEqual(R.lastFix(unit([{ t: 1 }])), null, 'no position at all');
  assert.strictEqual(R.lastFix(null), null);
});

test('vertical rate is negative while falling and ignores gaps', () => {
  // 100 m down over 10 s, with one invalid packet in the middle.
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push({ t: i, gpsAlt: i === 5 ? undefined : 1000 - i * 10 });
  const rate = R.verticalRate(unit(pts), 'gpsAlt', 10);
  assert.ok(Math.abs(rate + 10) < 0.001, 'ten metres a second down, got ' + rate);

  const up = R.verticalRate(unit(pts.map((p) => ({ t: p.t, gpsAlt: p.gpsAlt === undefined ? undefined : 2000 - p.gpsAlt }))), 'gpsAlt', 10);
  assert.ok(up > 9.9, 'rising is positive, got ' + up);

  assert.ok(Number.isNaN(R.verticalRate(unit([{ t: 0, gpsAlt: 5 }, { t: 1, gpsAlt: 6 }]), 'gpsAlt', 10)), 'two points is not a trend');
  assert.ok(Number.isNaN(R.verticalRate(unit(pts), 'envAlt', 10)), 'no barometer data');
});

test('the rate window only looks at recent points', () => {
  // Level for a minute, then falling for the last 10 s. A 10 s window sees the fall.
  const pts = [];
  for (let i = 0; i <= 60; i++) pts.push({ t: i, gpsAlt: 500 });
  for (let i = 1; i <= 10; i++) pts.push({ t: 60 + i, gpsAlt: 500 - i * 5 });
  assert.ok(R.verticalRate(unit(pts), 'gpsAlt', 10) < -4.5, 'sees the recent fall');
  assert.ok(Math.abs(R.verticalRate(unit(pts), 'gpsAlt', 600)) < 1.5, 'over the whole flight it averages out');
});

test('a typed home point takes commas or spaces, and refuses nonsense', () => {
  assert.deepStrictEqual(R.parsePoint('52.1, 5.2'), { lat: 52.1, lon: 5.2 });
  assert.deepStrictEqual(R.parsePoint(' -33.9  18.4 '), { lat: -33.9, lon: 18.4 });
  assert.strictEqual(R.parsePoint(''), null);
  assert.strictEqual(R.parsePoint('52.1'), null, 'one number is not a point');
  assert.strictEqual(R.parsePoint('91, 5'), null, 'latitude past the pole');
  assert.strictEqual(R.parsePoint('52, 181'), null, 'longitude past the line');
  assert.strictEqual(R.parsePoint('north, east'), null);
});

test('distances read as metres near by and kilometres far off', () => {
  assert.strictEqual(R.metres(4.4), '4 m');
  assert.strictEqual(R.metres(999), '999 m');
  assert.strictEqual(R.metres(1000), '1.00 km');
  assert.strictEqual(R.metres(3456), '3.46 km');
});
