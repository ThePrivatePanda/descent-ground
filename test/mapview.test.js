const test = require('node:test');
const assert = require('node:assert');
const M = require('../web/js/mapview.js');

test('tile numbers match the published Web Mercator values', () => {
  // Zoom 0 is one tile; the centre of the world sits at its middle.
  assert.strictEqual(Math.floor(M.xOf(0, 0)), 0);
  assert.ok(Math.abs(M.xOf(0, 1) - 1) < 1e-9, 'the prime meridian splits zoom 1');
  assert.ok(Math.abs(M.yOf(0, 1) - 1) < 1e-9, 'the equator splits zoom 1');

  // Berlin at zoom 14, worked through the slippy-map formulae by hand:
  // x = (13.4 + 180) / 360 * 2^14 = 8801.85, y = (1 - ln(tan+sec)/pi) / 2 * 2^14 = 5374.66.
  assert.strictEqual(Math.floor(M.xOf(13.4, 14)), 8801);
  assert.strictEqual(Math.floor(M.yOf(52.5, 14)), 5374);

  // Ithaca, where the roof drop happened: 4711.32 and 6054.2 the same way.
  assert.strictEqual(Math.floor(M.xOf(-76.4797761, 14)), 4711);
  assert.strictEqual(Math.floor(M.yOf(42.4439578, 14)), 6054);
});

test('pixel maths round trips back to the same place', () => {
  for (const [lat, lon, z] of [[42.44, -76.48, 16], [-33.9, 18.4, 12], [0, 0, 5], [60.1, 24.9, 18]]) {
    const back = { lat: M.latOf(M.yOf(lat, z), z), lon: M.lonOf(M.xOf(lon, z), z) };
    assert.ok(Math.abs(back.lat - lat) < 1e-9, 'latitude survives, got ' + back.lat);
    assert.ok(Math.abs(back.lon - lon) < 1e-9, 'longitude survives, got ' + back.lon);
  }
});

test('a box around a point is the size that was asked for', () => {
  const b = M.boxAround(42.4439578, -76.4797761, 1000);
  assert.ok(Math.abs((b.north - b.south) * 111320 - 2000) < 5, 'two km tall');
  // Longitude is stretched by the latitude, so the box stays square on the ground.
  const wideM = (b.east - b.west) * 111320 * Math.cos((42.4439578 * Math.PI) / 180);
  assert.ok(Math.abs(wideM - 2000) < 20, 'two km wide on the ground, got ' + wideM);
});

test('the tile list grows with area and zoom, and the cap holds', () => {
  const near = M.countFor(42.44, -76.48, 500, 13, 15);
  const far = M.countFor(42.44, -76.48, 5000, 13, 15);
  assert.ok(far > near, 'a wider area needs more tiles');

  const deep = M.countFor(42.44, -76.48, 500, 13, 17);
  assert.ok(deep > near, 'more zoom levels need more tiles');

  const capped = M.tilesFor(42.44, -76.48, 5000, 13, 18, 40);
  assert.strictEqual(capped.length, 40, 'stops at the cap');
  assert.ok(capped.every((t) => t.z >= 13 && t.z <= 18));
  assert.ok(capped[0].z <= capped[capped.length - 1].z, 'shallow zooms come first');
});

test('every listed tile exists at its zoom', () => {
  // Near the date line and the poles is where tile indices go out of range.
  for (const [lat, lon] of [[0, 179.99], [0, -179.99], [84, 10], [-84, 10]]) {
    for (const t of M.tilesFor(lat, lon, 4000, 10, 14, 0)) {
      const side = Math.pow(2, t.z);
      assert.ok(t.x >= 0 && t.x < side, 'x in range at zoom ' + t.z);
      assert.ok(t.y >= 0 && t.y < side, 'y in range at zoom ' + t.z);
    }
  }
});

test('fit zoom frames the area instead of the planet', () => {
  const tight = M.fitZoom(300, 600);
  const wide = M.fitZoom(20000, 600);
  assert.ok(tight > wide, 'a smaller area is drawn closer in');
  assert.ok(tight <= M.MAX_ZOOM && wide >= 0);
});
