// History charts (uPlot). One set of panels per tab; each panel has its own
// y axis so no chart ever mixes units.
(function (root) {
  'use strict';

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const series = (i) => css('--series-' + (i + 1));

  // Tab -> panels -> series. `key` reads unit.history[key]; `rx` = per receiver.
  const TABS = [
    { id: 'overview', label: 'Overview', panels: [
      { title: 'Packet counter', series: [{ key: 'counter', label: 'Counter' }] },
      { title: 'Battery (%)', series: [{ key: 'battery', label: 'Battery' }] },
      { title: 'RSSI, best receiver (dBm)', series: [{ key: 'rssi', label: 'RSSI' }] },
      { title: 'SNR, best receiver (dB)', series: [{ key: 'snr', label: 'SNR' }] },
    ] },
    { id: 'imu', label: 'IMU', panels: [
      { title: 'Linear acceleration (m/s²)', band: 75, series: [{ key: 'ax', label: 'X' }, { key: 'ay', label: 'Y' }, { key: 'az', label: 'Z' }] },
      { title: 'Gyroscope (deg/s)', series: [{ key: 'gx', label: 'X' }, { key: 'gy', label: 'Y' }, { key: 'gz', label: 'Z' }] },
      { title: 'Magnetometer (µT)', series: [{ key: 'mx', label: 'X' }, { key: 'my', label: 'Y' }, { key: 'mz', label: 'Z' }] },
      { title: 'Quaternion', series: [{ key: 'qi', label: 'i' }, { key: 'qj', label: 'j' }, { key: 'qk', label: 'k' }, { key: 'qr', label: 'real' }] },
    ] },
    { id: 'env', label: 'Environment', panels: [
      { title: 'Temperature (°C)', series: [{ key: 'temp', label: 'Temperature' }] },
      { title: 'Pressure (hPa)', series: [{ key: 'pressure', label: 'Pressure' }] },
      { title: 'Humidity (%RH)', series: [{ key: 'humidity', label: 'Humidity' }] },
      { title: 'Pressure altitude (m)', series: [{ key: 'envAlt', label: 'Altitude' }] },
    ] },
    { id: 'gps', label: 'GPS', panels: [
      { title: 'GPS altitude MSL (m)', series: [{ key: 'gpsAlt', label: 'Altitude' }] },
      { title: 'Latitude (deg)', series: [{ key: 'lat', label: 'Latitude' }] },
      { title: 'Longitude (deg)', series: [{ key: 'lon', label: 'Longitude' }] },
    ] },
    { id: 'radio', label: 'Radio', panels: [
      { title: 'RSSI per receiver (dBm)', rx: 'rssi' },
      { title: 'SNR per receiver (dB)', rx: 'snr' },
    ] },
  ];

  function timeFmt(u, splits) {
    return splits.map((s) => new Date(s * 1000).toTimeString().slice(0, 8));
  }

  class Charts {
    constructor(container, tabsEl, rxLabel) {
      this.el = container;
      this.tabsEl = tabsEl;
      this.rxLabel = rxLabel;     // rxKey -> {label, index}
      this.tab = 'overview';
      this.plots = [];
      this.sig = '';
      for (const t of TABS) {
        const b = document.createElement('button');
        b.textContent = t.label; b.dataset.tab = t.id;
        b.addEventListener('click', () => { this.tab = t.id; this.sig = ''; this.markTabs(); if (this.last) this.update(...this.last); });
        tabsEl.appendChild(b);
      }
      this.markTabs();
      new ResizeObserver(() => this.resize()).observe(container);
    }

    markTabs() {
      for (const b of this.tabsEl.children) b.classList.toggle('on', b.dataset.tab === this.tab);
    }

    resize() {
      for (const p of this.plots) {
        const w = p.box.clientWidth - 12;
        if (w > 50 && Math.abs(w - p.u.width) > 2) p.u.setSize({ width: w, height: 170 });
      }
    }

    // Build the column arrays for one panel.
    panelData(panel, unit, t0) {
      if (!unit) return null;
      if (panel.rx) {
        const keys = Object.keys(unit.rxHistory);
        if (!keys.length) return null;
        // Align all receivers on one time axis; gaps are null.
        const times = [...new Set(keys.flatMap((k) => unit.rxHistory[k].t))].filter((t) => t >= t0).sort((a, b) => a - b);
        const idx = new Map(times.map((t, i) => [t, i]));
        const cols = keys.map((k) => {
          const col = new Array(times.length).fill(null);
          const h = unit.rxHistory[k];
          h.t.forEach((t, i) => { if (idx.has(t) && Number.isFinite(h[panel.rx][i])) col[idx.get(t)] = h[panel.rx][i]; });
          return col;
        });
        return { data: [times].concat(cols), labels: keys.map((k) => this.rxLabel(k)) };
      }
      const h = unit.history;
      let start = 0;
      while (start < h.t.length && h.t[start] < t0) start++;
      // Break the line where packets are missing (gap > 3 intervals) so a
      // straight segment never pretends there was data.
      const gapS = Number.isFinite(unit.intervalMs) ? 3 * unit.intervalMs / 1000 : Infinity;
      const data = [[]].concat(panel.series.map(() => []));
      for (let i = start; i < h.t.length; i++) {
        if (i > start && h.t[i] - h.t[i - 1] > gapS) {
          data[0].push((h.t[i] + h.t[i - 1]) / 2);
          for (let s = 0; s < panel.series.length; s++) data[s + 1].push(null);
        }
        data[0].push(h.t[i]);
        panel.series.forEach((s, j) => data[j + 1].push(h[s.key][i]));
      }
      return { data, labels: panel.series.map((s) => ({ label: s.label, index: panel.series.indexOf(s) })) };
    }

    build(panels) {
      this.el.innerHTML = '';
      this.plots = [];
      for (const { panel, pd } of panels) {
        const box = document.createElement('div');
        box.className = 'chart';
        const h = document.createElement('h3'); h.textContent = panel.title; box.appendChild(h);
        this.el.appendChild(box);
        if (!pd || pd.data[0].length === 0) {
          const n = document.createElement('div'); n.className = 'none';
          n.textContent = panel.rx ? 'No receiver data yet' : 'No valid data in this window';
          box.appendChild(n);
          continue;
        }
        const grid = { stroke: css('--line'), width: 1 };
        const axis = { stroke: css('--text-2'), grid, ticks: { stroke: css('--line') }, font: '11px ' + css('--sans') };
        const opts = {
          width: Math.max(200, box.clientWidth - 12), height: 170,
          legend: { live: true },
          cursor: { points: { size: 8 }, drag: { x: false, y: false } },
          scales: { x: { time: true } },
          axes: [Object.assign({ values: timeFmt }, axis), Object.assign({ size: 56 }, axis)],
          series: [{ value: (u, v) => (v == null ? '—' : new Date(v * 1000).toTimeString().slice(0, 8)) }].concat(pd.labels.map((l) => ({
            label: l.label, stroke: series(l.index), width: 2, spanGaps: false,
            points: { show: pd.data[0].length < 60, size: 5 },
            value: (u, v) => (v == null ? '—' : +v.toFixed(5)),
          }))),
        };
        if (panel.band) {
          opts.hooks = { draw: [(u) => {
            // Shade beyond ±75 m/s²: the accelerometer is probably clipping there.
            const ctx = u.ctx; const { left, width } = u.bbox;
            ctx.save(); ctx.fillStyle = 'rgba(250,178,25,0.12)';
            for (const lim of [panel.band, -panel.band]) {
              const y = u.valToPos(lim, 'y', true);
              const edge = lim > 0 ? u.bbox.top : u.bbox.top + u.bbox.height;
              if (y > u.bbox.top && y < u.bbox.top + u.bbox.height) ctx.fillRect(left, Math.min(y, edge), width, Math.abs(edge - y));
            }
            ctx.restore();
          }] };
        }
        const u = new uPlot(opts, pd.data, box);
        this.plots.push({ u, box, panel });
      }
    }

    // Redraw for the selected unit. Rebuilds DOM only when the shape changes.
    update(unit, now, windowS) {
      this.last = [unit, now, windowS];
      const tab = TABS.find((t) => t.id === this.tab);
      const t0 = windowS ? now / 1000 - windowS : -Infinity;
      const panels = tab.panels.map((panel) => ({ panel, pd: this.panelData(panel, unit, t0) }));
      const sig = this.tab + '|' + (unit ? unit.csid : '-') + '|' + panels.map((p) => (p.pd && p.pd.data[0].length ? p.pd.labels.map((l) => l.label).join(',') : 'x')).join(';');
      if (sig !== this.sig) { this.sig = sig; this.build(panels); return; }
      let i = 0;
      for (const { pd } of panels) {
        if (!pd || !pd.data[0].length) continue;
        const p = this.plots[i++];
        p.u.batch(() => {
          p.u.setData(pd.data);
          const xmax = now / 1000;
          p.u.setScale('x', { min: windowS ? xmax - windowS : pd.data[0][0], max: Math.max(xmax, pd.data[0][pd.data[0].length - 1]) });
        });
      }
    }

    // Colours come from CSS; rebuild after a theme switch.
    restyle() { this.sig = ''; if (this.last) this.update(...this.last); }
  }

  (root.DG = root.DG || {}).Charts = Charts;
  root.DG.TABS = TABS;
})(self);
