// Web Mercator tile arithmetic and a canvas map drawn from tiles already on disk.
// No mapping library: the page has to work with no internet, and a map that is only
// ever a handful of 256 px squares plus a track does not need one.
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.DG = root.DG || {}).mapview = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 256;          // every tile server in this shape uses 256 px tiles
  const MAX_ZOOM = 19;

  // Fractional tile coordinates, so the same maths places a tile and a point inside it.
  const xOf = (lon, z) => ((lon + 180) / 360) * Math.pow(2, z);
  function yOf(lat, z) {
    const r = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
  }
  const lonOf = (x, z) => (x / Math.pow(2, z)) * 360 - 180;
  function latOf(y, z) {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  // A degree of latitude is 111.32 km everywhere; longitude shrinks towards the poles.
  function boxAround(lat, lon, metres) {
    const dLat = metres / 111320;
    const dLon = metres / (111320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
    return { north: lat + dLat, south: lat - dLat, east: lon + dLon, west: lon - dLon };
  }

  // Every tile covering a square around a point, shallowest zoom first so a part-finished
  // download still draws something over the whole area instead of detail in one corner.
  function tilesFor(lat, lon, metres, zMin, zMax, cap) {
    const out = [];
    const b = boxAround(lat, lon, metres);
    for (let z = Math.max(0, zMin); z <= Math.min(MAX_ZOOM, zMax); z++) {
      const side = Math.pow(2, z);
      const x0 = Math.floor(xOf(b.west, z));
      const x1 = Math.floor(xOf(b.east, z));
      const y0 = Math.floor(yOf(b.north, z));
      const y1 = Math.floor(yOf(b.south, z));
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          if (x < 0 || y < 0 || x >= side || y >= side) continue;
          out.push({ z, x, y });
          if (cap && out.length >= cap) return out;
        }
      }
    }
    return out;
  }

  // How many tiles a request would be, for telling someone before they start.
  const countFor = (lat, lon, metres, zMin, zMax) => tilesFor(lat, lon, metres, zMin, zMax, 0).length;

  // The zoom at which a square of the given size fits the canvas, so opening the map
  // frames the flight rather than the planet.
  function fitZoom(metres, pixels) {
    for (let z = MAX_ZOOM; z >= 0; z--) {
      const b = boxAround(0, 0, metres);
      const span = (xOf(b.east, z) - xOf(b.west, z)) * SIZE;
      if (span <= pixels) return z;
    }
    return 0;
  }

  // Draws the tiles under the view, then the track, then home and the last fix on top.
  // Tiles that were never downloaded are left as background, which is how the map shows
  // honestly that there is no data for that square rather than inventing one.
  function draw(canvas, view, layers, tileUrl) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width; const h = canvas.height;
    const z = Math.round(view.zoom);
    const cx = xOf(view.lon, z) * SIZE;
    const cy = yOf(view.lat, z) * SIZE;
    const left = cx - w / 2;
    const top = cy - h / 2;
    const style = getComputedStyle(canvas);
    ctx.fillStyle = style.getPropertyValue('--sunk') || '#e6eaee';
    ctx.fillRect(0, 0, w, h);

    const side = Math.pow(2, z);
    const missing = [];
    for (let tx = Math.floor(left / SIZE); tx <= Math.floor((left + w) / SIZE); tx++) {
      for (let ty = Math.floor(top / SIZE); ty <= Math.floor((top + h) / SIZE); ty++) {
        if (tx < 0 || ty < 0 || tx >= side || ty >= side) continue;
        const img = tileImage(z, tx, ty, tileUrl);
        const px = tx * SIZE - left; const py = ty * SIZE - top;
        if (img && img.complete && img.naturalWidth) ctx.drawImage(img, px, py, SIZE, SIZE);
        else missing.push({ px, py });
      }
    }

    const toPx = (lat, lon) => ({ x: xOf(lon, z) * SIZE - left, y: yOf(lat, z) * SIZE - top });

    const track = layers.track || [];
    if (track.length > 1) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = style.getPropertyValue('--accent') || '#2f6fdb';
      ctx.beginPath();
      track.forEach((p, i) => {
        const q = toPx(p.lat, p.lon);
        if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      });
      ctx.stroke();
    }

    if (layers.home) {
      const q = toPx(layers.home.lat, layers.home.lon);
      ctx.strokeStyle = style.getPropertyValue('--ink-2') || '#566474';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(q.x - 6, q.y); ctx.lineTo(q.x + 6, q.y);
      ctx.moveTo(q.x, q.y - 6); ctx.lineTo(q.x, q.y + 6); ctx.stroke();
    }

    if (layers.fix) {
      const q = toPx(layers.fix.lat, layers.fix.lon);
      ctx.fillStyle = style.getPropertyValue('--critical') || '#c93434';
      ctx.beginPath(); ctx.arc(q.x, q.y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = style.getPropertyValue('--panel') || '#fff';
      ctx.lineWidth = 1.5; ctx.stroke();
    }

    return { missing: missing.length, zoom: z };
  }

  // Tiles are kept as Image objects so panning does not re-request what is on screen.
  const cache = new Map();
  function tileImage(z, x, y, tileUrl) {
    const key = z + '/' + x + '/' + y;
    let img = cache.get(key);
    if (img) return img;
    img = new Image();
    img.src = (tileUrl || '/tiles/') + key + '.png';
    img.onerror = () => { img.failed = true; };
    cache.set(key, img);
    if (cache.size > 600) for (const k of [...cache.keys()].slice(0, 200)) cache.delete(k);
    return img;
  }

  const forget = () => cache.clear();

  return { SIZE, MAX_ZOOM, xOf, yOf, lonOf, latOf, boxAround, tilesFor, countFor, fitZoom, draw, forget };
});
