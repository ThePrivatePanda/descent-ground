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
  const WRAP_SLACK = 1000;
  const SLACK = 2000;                 // points kept past the cap before one tidy-up             // counter 65xxx -> small = wrap, not reset
  const INTERVAL_SAMPLES = 15;

  const SERIES = ['counter', 'rssi', 'snr'].concat(
    P.FIELDS.filter((f) => f.group).map((f) => f.key));

  function median(a) {
    if (!a.length) return NaN;
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // Retired generations are lettered oldest first, so 64a came before 64b, and the
  // plain number is always the one transmitting now.
  function genLabel(n) {
    let s = '';
    n += 1;
    while (n > 0) {
      n -= 1;
      s = String.fromCharCode(97 + (n % 26)) + s;
      n = Math.floor(n / 26);
    }
    return s;
  }

  function newUnit(csid) {
    const history = { t: [] };
    for (const k of SERIES) history[k] = [];
    return {
      csid,
      boot: null,             // which boot of the board this run is, when the dump says
      sourceRx: null,         // the source this run came from, for a log off a chip
      fromChip: false,        // read off flash, so counter-derived numbers do not apply
      label: String(csid),    // '64' while live, '64a' once retired
      live: true,
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
      for (const u of this.units.values()) this.trimHistory(u, true);
    }

    clear() {
      this.units = new Map();
      this.receivers = new Map();
      this.sources = new Map();   // rx -> where its lines came from, if not a radio
      this.retired = new Map();   // label -> a generation that ended at a counter reset
      this.generations = new Map();  // csid -> how many of its generations have ended
      this.currentBoot = null;       // the boot a dump is currently replaying
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
        // Not a radio. A flash dump has no RSSI or SNR by nature, and a replay of one
        // must not be mistaken for live reception in a screenshot.
        case 'source': r.source = ev.info; this.sources.set(rx, ev.info); return 'source';
        // Which boot the records after this one belong to. The counter cannot tell us.
        case 'boot': this.currentBoot = ev.info.n; return 'boot';
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
      // Deduplication exists because two receivers hear one transmission. A chip log has
      // no receivers, and two records that happen to hold the same bytes are two real
      // samples, so dropping one loses data that was measured.
      const seen = this.sources.get(rx) ? null : this.recent.get(ev.hex);
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
      // A log read off a chip is not a packet stream and its counter does not mean what
      // it means on the air: the board logs at 20 Hz but the counter moves once per
      // transmission, so the same value repeats nine or ten times over records that are
      // all different. Worse, every boot in a dump is dated from the same start, so the
      // boots interleave and the counter appears to jump backwards constantly. Runs come
      // from the dump's own boot boundaries instead, which arrive as separate sources.
      // Splitting on the source does not work either: every boot in a dump starts at
      // the same time, so they interleave and the source changes on nearly every
      // record. A chip log is therefore not split at all. The boots are still visible
      // as separate sources, and telling them apart properly needs a boot number on
      // each record, which the file does not carry yet.
      const fromChip = !!this.sources.get(rx);
      let u = this.units.get(csid);
      // A dump that names its boots can be split properly: one run per boot, which the
      // counter could never give us.
      if (fromChip && u && u.boot !== null && this.currentBoot !== null && u.boot !== this.currentBoot) {
        const old = this.retire(csid);
        this.lastRetired = old ? old.label : null;
        u = null;
      }
      if (!fromChip && u && this.cfg.splitOnReset !== false && this.isReset(u, d.values.counter)) {
        const old = this.retire(csid);
        u = null;
        this.lastRetired = old ? old.label : null;
      }
      if (!u) { u = newUnit(csid); this.units.set(csid, u); }
      if (fromChip) {
        // Missed, restarts, repeats and the transmit interval are all read off the
        // counter, and for a chip log the counter counts transmissions while the file
        // holds every sample, with the boots interleaved on top. Nothing derived from
        // it would be true, so none of it is claimed.
        u.sourceRx = rx;
        u.fromChip = true;
        if (u.boot === null) u.boot = this.currentBoot;
        u.lastCounter = d.values.counter;
      } else {
        this.updateCounter(u, d.values.counter, t);
      }
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

    // A board that rebooted. The counter starts again from 0, so a drop that is not a
    // wrap, or a second 0 in a row, means the packets after it belong to a new run.
    isReset(u, counter) {
      const last = u.lastCounter;
      if (last === null) return false;
      const wrapped = last > 65535 - WRAP_SLACK && counter < WRAP_SLACK;
      return (counter < last && !wrapped) || (counter === 0 && last === 0);
    }

    // Put the run that just ended aside under a letter and start a clean one, so a
    // reflashed board does not mix its old data into its new.
    retire(csid) {
      const u = this.units.get(csid);
      if (!u) return null;
      const n = this.generations.get(csid) || 0;
      this.generations.set(csid, n + 1);
      u.label = String(csid) + genLabel(n);
      u.gen = n;        // past the 26th run the labels read aa, ab, which do not sort as text
      u.live = false;
      this.retired.set(u.label, u);
      this.units.delete(csid);
      return u;
    }

    // Every generation, newest run of each board first.
    allUnits() {
      const out = new Map();
      for (const [csid, u] of this.units) out.set(String(csid), u);
      for (const [label, u] of this.retired) out.set(label, u);
      return out;
    }

    // Undo a split. A board that rebooted for a boring reason, a knocked cable on the
    // bench, is still one run as far as the operator is concerned, so its data is put
    // back together with the run that followed it. Times only ever go forward between
    // runs, so the older one goes in front.
    mergeRun(label) {
      const a = this.retired.get(label);
      if (!a) return null;
      const later = [...this.retired.values()]
        .filter((u) => u.csid === a.csid && u.gen > a.gen)
        .sort((x, y) => x.gen - y.gen)[0] || this.units.get(a.csid);
      if (!later) return null;

      if (a.firstT !== null) later.firstT = later.firstT === null ? a.firstT : Math.min(a.firstT, later.firstT);
      later.packets += a.packets;
      later.missed += a.missed;
      later.repeats += a.repeats;
      // The board did reboot, whatever the operator calls it. Splitting replaced the
      // reset count, so merging has to put it back or a merged board reads as one that
      // never restarted.
      later.resets += a.resets + 1;
      later.saturatedCount += a.saturatedCount;

      for (const k of Object.keys(later.history)) {
        later.history[k] = (a.history[k] || []).concat(later.history[k]);
      }
      for (const [rx, h] of Object.entries(a.rxHistory)) {
        const into = later.rxHistory[rx] || (later.rxHistory[rx] = { t: [], rssi: [], snr: [] });
        into.t = h.t.concat(into.t);
        into.rssi = h.rssi.concat(into.rssi);
        into.snr = h.snr.concat(into.snr);
      }
      // The newer run's last trusted values win; the older one fills what it never saw.
      for (const [k, v] of Object.entries(a.lastValid)) {
        if (later.lastValid[k] === undefined) later.lastValid[k] = v;
      }

      this.retired.delete(label);
      if (!this.earlierRuns(a.csid).length) this.generations.delete(a.csid);
      return later.label;
    }

    // Put every earlier run of a board back into the one transmitting now.
    mergeAllRuns(csid) {
      let n = 0;
      for (const u of this.earlierRuns(csid).reverse()) {
        if (this.mergeRun(u.label)) n++;
      }
      return n;
    }

    // Everything that makes this fleet what it is, copied deeply enough to put back.
    // Replay scrubs backwards by restoring the nearest earlier copy instead of feeding
    // every event again from the start, which is what made a long log unscrubbable.
    snapshot() {
      return structuredClone({
        units: this.units,
        retired: this.retired,
        generations: this.generations,
        receivers: this.receivers,
        sources: this.sources,
        recent: this.recent,
        hidden: this.hidden,
        currentBoot: this.currentBoot,
        total: this.total,
        duplicates: this.duplicates,
        badCrc: this.badCrc,
        badLength: this.badLength,
      });
    }

    restore(state) {
      const c = structuredClone(state);
      this.units = c.units;
      this.retired = c.retired;
      this.generations = c.generations;
      this.receivers = c.receivers;
      this.sources = c.sources;
      this.recent = c.recent;
      this.hidden = c.hidden;
      this.currentBoot = c.currentBoot;
      this.total = c.total;
      this.duplicates = c.duplicates;
      this.badCrc = c.badCrc;
      this.badLength = c.badLength;
    }

    // Runs of one board that ended at a restart, oldest first.
    earlierRuns(csid) {
      return [...this.retired.values()].filter((u) => u.csid === csid)
        .sort((a, b) => a.gen - b.gen);
    }

    unit(label) {
      return this.units.get(Number(label)) || this.retired.get(label) || null;
    }

    // Clean slate, in pieces, so an operator part-way through a bench run can throw
    // away only what is in the way. None of this touches what is already on disk.
    clearUnit(label) {
      const u = this.unit(label);
      if (!u) return false;
      if (u.live) this.units.delete(u.csid); else this.retired.delete(label);
      for (const [hex, seen] of this.recent) if (seen.csid === u.csid) this.recent.delete(hex);
      this.hidden.delete(label);
      // With nothing of this board left, its lettering starts from a again rather than
      // carrying on from where it was and looking as though runs went missing.
      if (!this.units.has(u.csid) && !this.earlierRuns(u.csid).length) this.generations.delete(u.csid);
      return true;
    }

    clearUnits() {
      this.units.clear();
      this.retired.clear();
      this.generations.clear();
      this.recent.clear();
      this.hidden.clear();
      this.total = 0;
      this.duplicates = 0;
      this.badCrc = 0;
      this.badLength = 0;
    }

    // Zero a receiver's tallies without closing it: it keeps receiving.
    clearReceiver(rx) {
      const r = this.receivers.get(rx);
      if (!r) return false;
      r.packets = 0; r.unique = 0; r.badCrc = 0; r.radioErrors = 0;
      r.firstT = null;
      return true;
    }

    clearReceivers() {
      for (const rx of this.receivers.keys()) this.clearReceiver(rx);
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

    // Drop history older than the retention time and beyond the point cap. Pass exact to
    // cut to the cap on the spot; ingest lets it drift instead, for the reason below.
    trimHistory(u, exact = false) {
      const cut = (h) => {
        let n = 0;
        if (this.cfg.retainMin > 0 && h.t.length) {
          const oldest = h.t[h.t.length - 1] - this.cfg.retainMin * 60;
          while (n < h.t.length && h.t[n] < oldest) n++;
        }
        // The retention window decides what the charts show, so it is honoured exactly.
        // The cap is only a memory guard, and cutting one point off the front of every
        // series on every packet moves all twenty thousand of the others each time. Past
        // the cap that is milliseconds per packet, which is what makes a long log crawl.
        const over = h.t.length - n - this.cfg.maxPoints;
        if (over > 0 && (exact || over >= SLACK)) n += over;
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
