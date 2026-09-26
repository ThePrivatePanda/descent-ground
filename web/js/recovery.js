// Where the unit last was, how far that is from where you are standing, and whether it
// was still coming down. Kept apart from the page so the arithmetic can be tested.
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.DG = root.DG || {}).recovery = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EARTH_M = 6371008.8;   // IUGG mean radius
  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

  // Haversine distance and initial bearing. Good to about a metre over a launch site,
  // which is as much as walking to a landing spot needs.
  function greatCircle(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const p1 = lat1 * r; const p2 = lat2 * r;
    const dp = (lat2 - lat1) * r; const dl = (lon2 - lon1) * r;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    const m = 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return { m, deg: (Math.atan2(y, x) / r + 360) % 360 };
  }

  const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];

  // The newest history point that carried a position, with the time it arrived. A unit
  // that has lost its fix still has a last known place, and that is the useful one.
  // 0,0 is treated as no fix: it is what an unlocked receiver reports, not the Atlantic.
  function lastFix(u) {
    if (!u || !u.history) return null;
    const h = u.history;
    for (let i = h.t.length - 1; i >= 0; i--) {
      const lat = h.lat[i]; const lon = h.lon[i];
      if (lat === null || lon === null) continue;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat === 0 && lon === 0) continue;
      return { lat, lon, t: h.t[i] * 1000, alt: h.gpsAlt[i] };
    }
    return null;
  }

  // Metres per second from a straight line through the last window of altitudes, which
  // rides out the metre or two of noise on any single reading. Negative means falling.
  // Fewer than three usable points is not a trend, so it returns NaN instead.
  function verticalRate(u, key, windowS) {
    if (!u || !u.history) return NaN;
    const h = u.history;
    const end = h.t.length - 1;
    if (end < 1) return NaN;
    const until = h.t[end] - windowS;
    let n = 0; let st = 0; let sa = 0; let stt = 0; let sta = 0;
    for (let i = end; i >= 0 && h.t[i] >= until; i--) {
      const a = h[key] ? h[key][i] : null;
      if (a === null || !Number.isFinite(a)) continue;
      const x = h.t[i] - h.t[end];
      n++; st += x; sa += a; stt += x * x; sta += x * a;
    }
    if (n < 3) return NaN;
    const denom = n * stt - st * st;
    return denom === 0 ? NaN : (n * sta - st * sa) / denom;
  }

  // The newest value a field actually carried, so an invalid packet does not blank it.
  function lastValue(u, key) {
    if (!u || !u.history || !u.history[key]) return null;
    const c = u.history[key];
    for (let i = c.length - 1; i >= 0; i--) if (c[i] !== null && Number.isFinite(c[i])) return c[i];
    return null;
  }

  // "lat, lon" as typed by someone standing in a field, spaces or comma either way.
  function parsePoint(text) {
    const parts = String(text || '').split(/[\s,]+/).filter((x) => x !== '');
    if (parts.length !== 2) return null;
    const lat = Number(parts[0]); const lon = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  const metres = (m) => (m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km');

  return { greatCircle, compass, lastFix, verticalRate, lastValue, parsePoint, metres };
});
