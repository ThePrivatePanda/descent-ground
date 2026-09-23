const test = require('node:test');
const assert = require('node:assert');
const N = require('../web/js/serial_native.js');

test('native transport only when the page came from the local app', () => {
  assert.equal(N.isNativeHost({ protocol: 'http:', hostname: '127.0.0.1' }), true);
  assert.equal(N.isNativeHost({ protocol: 'http:', hostname: 'localhost' }), true);
  assert.equal(N.isNativeHost({ protocol: 'file:', hostname: '' }), false);
  assert.equal(N.isNativeHost({ protocol: 'https:', hostname: 'ground.privatepanda.co' }), false);
  assert.equal(N.isNativeHost({ protocol: 'http:', hostname: '192.168.1.5' }), false);
});

test('a line frame reaches the page as receiver key and text', () => {
  const seen = [];
  const handle = N.makeFrameHandler((rx, text) => seen.push([rx, text]), () => {});
  handle(JSON.stringify({ type: 'line', rx: 'rx1', t: 1790000000000, text: 'HB,1,2,3' }));
  assert.deepStrictEqual(seen, [['rx1', 'HB,1,2,3']]);
});

test('nothing in the dashboard reaches the network', () => {
  // The field has no internet. A CDN font or script added later must fail here.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'web');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const offenders = [];
  for (const f of walk(dir)) {
    if (!/\.(html|js|css)$/.test(f) || f.includes(path.join('web', 'vendor'))) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/g)) offenders.push(f + ': ' + m[0]);
  }
  assert.deepStrictEqual(offenders, []);
});

test('junk on the socket is ignored, not thrown', () => {
  const handle = N.makeFrameHandler(() => { throw new Error('should not be called'); }, () => {});
  handle('not json');
  handle(JSON.stringify({ type: 'unknown' }));
});
