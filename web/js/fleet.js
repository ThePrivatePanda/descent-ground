// Fleet state: one entry per CSID, one per receiver.
// Pure logic, no DOM. Every call takes the current time `t` in ms so the same
// code runs live (Date.now()) and in replay (time from the log).
(function (root, factory) {
  const P = typeof require === 'function' ? require('./packet.js') : root.DG.packet;
  const mod = factory(P);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.DG = root.DG || {}).fleet = mod;
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  // Every threshold the user can change in Settings. Fleet copies these;
  // setConfig() replaces them.
  const DEFAULTS = {
    lostMin: 10,              // silent this long = lost (user rule)
    staleFactor: 3,           // stale after this many missed intervals
    staleMinS: 5,
    dedupeMs: 1500,           // same bytes within this window = same over-the-air packet
    retainMin: 0,             // drop history older than this (0 = keep everything)
    maxPoints: 20000,         // history points kept per unit
    lowBatteryPct: 20,
    weakRssiDbm: -115,
    saturationMps2: 75,       // BNO085 accelerometer range is ±8 g (≈78 m/s²)
  };
  const LOST_MS = DEFAULTS.lostMin * 60000;
  const STALE_DEFAULT_MS = 30000;      // before the interval is known
  const WRAP_SLACK = 1000;             // counter 65xxx -> small = wrap, not reset
  const INTERVAL_SAMPLES = 15;

  const SERIES = ['counter', 'rssi', 'snr'].concat(
    P.FIELDS.filter((f) => f.group).map((f) => f.key));

  function median(a) {
    if (!a.length) return NaN;
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function newUnit(csid) {
    const history = { t: [] };
    for (const k of SERIES) history[k] = [];
    return {
      csid,
      firstT: null, lastT: null,
      packets: 0, missed: 0, resets: 0, repeats: 0,
      lastCounter: null,
      gaps: [],               // recent ms per counter step
      intervalMs: NaN,
      latest: null,           // decoded packet
      latestSource: null,
      receptions: [],         // [{rx, rssi, snr}] for the latest packet
      bestRssi: NaN, bestSnr: NaN,
      history,
      rxHistory: {},          // rx -> {t, rssi, snr}
      lastValid: {},          // field key -> last value seen while its bit was set
      saturatedCount: 0,
    };
  }

  class Fleet {
    constructor(cfg) { this.cfg = Object.assign({}, DEFAULTS, cfg); this.clear(); }

    setConfig(cfg) {
      this.cfg = Object.assign({}, DEFAULTS, cfg);
      for (const u of this.units.values()) this.trimHistory(u);
    }

    clear() {
      this.units = new Map();
      this.receivers = new Map();
      this.recent = new Map();   // hex -> {t, csid}
      this.badCrc = 0;
      this.badLength = 0;
      this.total = 0;
      this.duplicates = 0;
      this.hidden = new Set();
    }

    receiver(rx) {
      let r = this.receivers.get(rx);
      if (!r) {
        r = { key: rx, id: null, info: {}, firstT: null, lastT: null, lastHbT: null,
          packets: 0, unique: 0, badCrc: 0, radioErrors: 0, reportedOk: NaN, reportedErrors: NaN };
        this.receivers.set(rx, r);
      }
      return r;
    }

    // Feed one parsed line. Returns what happened: 'new', 'duplicate',
    // 'badcrc', 'badlength', or the event kind for non-packet lines.
    ingest(ev, t, rx) {
      const r = this.receiver(rx || 'rx');
      if (r.firstT === null) r.firstT = t;
      switch (ev.kind) {
        case 'rxinfo': r.info = ev.info; r.id = ev.info.id || r.id; r.lastT = t; return 'rxinfo';
        case 'heartbeat': r.lastHbT = t; r.lastT = t; r.reportedOk = ev.ok; r.reportedErrors = ev.errors; return 'heartbeat';
        case 'rxerror': r.radioErrors++; r.lastT = t; return 'rxerror';
        case 'badlength': r.lastT = t; this.badLength++; return 'badlength';
        case 'packet': break;
        default: return ev.kind;
      }
      r.lastT = t;
      r.packets++;
      if (!ev.decoded.crcOk) { r.badCrc++; this.badCrc++; return 'badcrc'; }

      for (const [hex, seen] of this.recent) if (t - seen.t > this.cfg.dedupeMs) this.recent.delete(hex);
      const seen = this.recent.get(ev.hex);
      if (seen) {
        this.duplicates++;
        const u = this.units.get(seen.csid);
        this.addReception(u, rx, ev, t);
        return 'duplicate';
      }
      r.unique++;
      this.total++;
      const d = ev.decoded;
      d.saturated = d.valid.accel && ['ax', 'ay', 'az'].some((k) => Math.abs(d.values[k]) >= this.cfg.saturationMps2);
      const csid = d.values.csid;
      this.recent.set(ev.hex, { t, csid });
      let u = this.units.get(csid);
      if (!u) { u = newUnit(csid); this.units.set(csid, u); }
      this.updateCounter(u, d.values.counter, t);
      u.packets++;
      if (u.firstT === null) u.firstT = t;
      u.lastT = t;
      u.latest = d;
      u.latestSource = ev.source;
      u.receptions = [];
      u.bestRssi = NaN; u.bestSnr = NaN;
      if (d.saturated) u.saturatedCount++;
      for (const f of P.FIELDS) if (f.group && d.valid[f.group]) u.lastValid[f.key] = d.values[f.key];
      this.pushHistory(u, d, t);
      this.addReception(u, rx, ev, t);
      return 'new';
    }

    updateCounter(u, counter, t) {
      const last = u.lastCounter;
      u.lastCounter = counter;
      if (last === null) return;
      const wrapped = last > 65535 - WRAP_SLACK && counter < WRAP_SLACK;
      if ((counter < last && !wrapped) || (counter === 0 && last === 0)) { u.resets++; return; }
      if (counter === last) { u.repeats++; return; }
      const step = (counter - last + 65536) % 65536;
      u.missed += step - 1;
      if (u.lastT !== null && t > u.lastT) {
        u.gaps.push((t - u.lastT) / step);
        if (u.gaps.length > INTERVAL_SAMPLES) u.gaps.shift();
        u.intervalMs = median(u.gaps);
      }
    }

    addReception(u, rx, ev, t) {
      if (!u) return;
      u.receptions.push({ rx, rssi: ev.rssi, snr: ev.snr });
      if (Number.isFinite(ev.rssi) && !(ev.rssi <= u.bestRssi)) u.bestRssi = ev.rssi;
      if (Number.isFinite(ev.snr) && !(ev.snr <= u.bestSnr)) u.bestSnr = ev.snr;
      let h = u.rxHistory[rx];
      if (!h) h = u.rxHistory[rx] = { t: [], rssi: [], snr: [] };
      h.t.push(t / 1000); h.rssi.push(ev.rssi); h.snr.push(ev.snr);
      // Best-of-receivers values for the latest history point.
      const hist = u.history;
      const i = hist.t.length - 1;
      if (i >= 0 && hist.t[i] === Math.round(u.lastT) / 1000) {
        hist.rssi[i] = Number.isFinite(u.bestRssi) ? u.bestRssi : null;
        hist.snr[i] = Number.isFinite(u.bestSnr) ? u.bestSnr : null;
      }
    }

    pushHistory(u, d, t) {
      const h = u.history;
      h.t.push(Math.round(t) / 1000);
      h.counter.push(d.values.counter);
      h.rssi.push(null); h.snr.push(null);
      // Every field with a validity group, battery included; null when invalid.
      for (const f of P.FIELDS) if (f.group) h[f.key].push(d.valid[f.group] ? d.values[f.key] : null);
      this.trimHistory(u);
    }

    // Drop history older than the retention time and beyond the point cap.
    trimHistory(u) {
      const cut = (h) => {
        let n = Math.max(0, h.t.length - this.cfg.maxPoints);
        if (this.cfg.retainMin > 0 && h.t.length) {
          const oldest = h.t[h.t.length - 1] - this.cfg.retainMin * 60;
          while (n < h.t.length && h.t[n] < oldest) n++;
        }
        if (n > 0) for (const k in h) h[k].splice(0, n);
      };
      cut(u.history);
      for (const k in u.rxHistory) cut(u.rxHistory[k]);
    }

    staleAfterMs(u) {
      return Number.isFinite(u.intervalMs)
        ? Math.max(this.cfg.staleMinS * 1000, this.cfg.staleFactor * u.intervalMs) : STALE_DEFAULT_MS;
    }

    state(u, now) {
      const age = now - u.lastT;
      if (age > this.cfg.lostMin * 60000) return 'LOST';
      if (age > this.staleAfterMs(u)) return 'STALE';
      return 'OK';
    }

    issues(u) {
      const out = [];
      const d = u.latest;
      if (!d) return out;
      if (d.valid.soc && d.values.battery < this.cfg.lowBatteryPct) out.push('low battery');
      for (const v of P.VALIDITY_BITS) if (v.bit < 7 && !d.valid[v.key]) out.push(v.name + ' invalid');
      if (Number.isFinite(u.bestRssi) && u.bestRssi < this.cfg.weakRssiDbm) out.push('weak RF');
      if (d.saturated) out.push('accel saturated');
      return out;
    }

    rxPercent(u) {
      const expected = u.packets + u.missed;
      return expected ? (100 * u.packets) / expected : NaN;
    }

    // Rows for the fleet list, worst first when sort = 'attention'.
    rows(now, sort) {
      const rank = { LOST: 0, STALE: 1, OK: 2 };
      const rows = [];
      for (const u of this.units.values()) {
        if (this.hidden.has(u.csid)) continue;
        rows.push({ unit: u, state: this.state(u, now), age: now - u.lastT, issues: this.issues(u) });
      }
      rows.sort((a, b) => {
        if (sort === 'attention') {
          const r = rank[a.state] - rank[b.state];
          if (r) return r;
          const i = b.issues.length - a.issues.length;
          if (i) return i;
        }
        return a.unit.csid - b.unit.csid;
      });
      return rows;
    }

    summary(now) {
      const s = { heard: 0, active: 0, stale: 0, lost: 0, packets: this.total, lowBattery: 0,
        validityIssues: 0, weakRf: 0, resets: 0, badCrc: this.badCrc, saturated: 0 };
      for (const u of this.units.values()) {
        if (this.hidden.has(u.csid)) continue;
        s.heard++;
        const st = this.state(u, now);
        if (st === 'OK') s.active++; else if (st === 'STALE') s.stale++; else s.lost++;
        const d = u.latest;
        if (d.valid.soc && d.values.battery < this.cfg.lowBatteryPct) s.lowBattery++;
        if ((d.values.validity & 0x7f) !== 0x7f) s.validityIssues++;
        if (Number.isFinite(u.bestRssi) && u.bestRssi < this.cfg.weakRssiDbm) s.weakRf++;
        if (d.saturated) s.saturated++;
        s.resets += u.resets;
      }
      return s;
    }
  }

  return { Fleet, DEFAULTS, LOST_MS, SERIES };
});
