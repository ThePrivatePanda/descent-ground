// History charts (uPlot). One set of panels per tab; each panel has its own
// y axis so no chart ever mixes units. The x axis spans exactly the data
// shown: from the first to the last packet kept (or the chosen window,
// counted back from the newest packet).
(function (root) {
  'use strict';

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Series colour at 70% opacity: noisy data reads calmer.
  function seriesColor(i) {
    const hex = css('--series-' + (i + 1)).replace('#', '');
    const n = parseInt(hex, 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',0.7)';
  }

  // Tab -> panels -> series. `key` reads unit.history[key]; `rx` = per receiver.
  const TABS = [
    { id: 'overview', label: 'Overview', panels: [
      { title: 'Packet counter', series: [{ key: 'counter', label: 'Counter' }] },
      { title: 'Battery (%)', series: [{ key: 'battery', label: 'Battery' }] },
      { title: 'RSSI, best receiver (dBm)', series: [{ key: 'rssi', label: 'RSSI' }] },
      { title: 'SNR, best receiver (dB)', series: [{ key: 'snr', label: 'SNR' }] },
    ] },
    { id: 'imu', label: 'IMU', panels: [
      { title: 'Linear acceleration (m/s²)', band: 'saturationMps2', series: [{ key: 'ax', label: 'X' }, { key: 'ay', label: 'Y' }, { key: 'az', label: 'Z' }] },
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

  const clock = (s) => new Date(s * 1000).toTimeString().slice(0, 8);
  const HEAD_PX = 58;   // panel title + legend

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

    // Fit all panels of the tab into the pane: columns from the width,
    // height shared between the rows.
    plotSize(box) {
      const n = Math.max(1, this.el.children.length);
      const cols = Math.max(1, getComputedStyle(this.el).gridTemplateColumns.split(' ').length);
      const rows = Math.ceil(n / cols);
      const h = Math.floor((this.el.clientHeight - 16 - 8 * (rows - 1)) / rows) - HEAD_PX;
      return { width: Math.max(200, box.clientWidth - 12), height: Math.max(90, h) };
    }

    resize() {
      for (const p of this.plots) {
        const size = this.plotSize(p.box);
        if (Math.abs(size.width - p.u.width) > 2 || Math.abs(size.height - p.u.height) > 2) p.u.setSize(size);
      }
    }

    // Column arrays for one panel, from t0 (seconds) onwards.
    panelData(panel, unit, t0) {
      if (!unit) return null;
      if (panel.rx) {
        const keys = Object.keys(unit.rxHistory);
        if (!keys.length) return null;
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
      return { data, labels: panel.series.map((s, j) => ({ label: s.label, index: j })) };
    }

    build(panels, opt) {
      this.el.innerHTML = '';
      this.plots = [];
      const boxes = panels.map(({ panel }) => {
        const box = document.createElement('div');
        box.className = 'chart';
        const h = document.createElement('h3'); h.textContent = panel.title; box.appendChild(h);
        this.el.appendChild(box);
        return box;
      });
      panels.forEach(({ panel, pd }, i) => {
        const box = boxes[i];
        if (!pd || pd.data[0].length === 0) {
          const n = document.createElement('div'); n.className = 'none';
          n.textContent = panel.rx ? 'No receiver data yet' : 'No valid data yet';
          n.style.height = this.plotSize(box).height + 'px';
          box.appendChild(n);
          return;
        }
        const grid = { stroke: css('--line'), width: 1 };
        const axis = { stroke: css('--text-2'), grid, ticks: { stroke: css('--line') }, font: '11px ' + css('--sans') };
        const few = pd.data[0].length < 40;
        const opts = Object.assign(this.plotSize(box), {
          legend: { live: true },
          cursor: { points: { size: 7 }, drag: { x: false, y: false } },
          scales: { x: { time: true } },
          axes: [Object.assign({ values: (u, splits) => splits.map(clock) }, axis), Object.assign({ size: 56 }, axis)],
          series: [{ value: (u, v) => (v == null ? '—' : clock(v)) }].concat(pd.labels.map((l) => ({
            label: l.label, stroke: seriesColor(l.index), width: opt.lineWidth, spanGaps: false,
            points: { show: few, size: 4, width: 1 },
            value: (u, v) => (v == null ? '—' : +v.toFixed(5)),
          }))),
        });
        const lim = panel.band && opt[panel.band];
        if (lim) {
          opts.hooks = { draw: [(u) => {
            // Shade beyond the saturation limit: the accelerometer is probably clipping there.
            const ctx = u.ctx; const { left, top, width, height } = u.bbox;
            ctx.save(); ctx.fillStyle = 'rgba(250,178,25,0.10)';
            for (const v of [lim, -lim]) {
              const y = u.valToPos(v, 'y', true);
              const edge = v > 0 ? top : top + height;
              if (y > top && y < top + height) ctx.fillRect(left, Math.min(y, edge), width, Math.abs(edge - y));
            }
            ctx.restore();
          }] };
        }
        this.plots.push({ u: new uPlot(opts, pd.data, box), box, panel });
      });
    }

    // Redraw for the selected unit. Rebuilds DOM only when the shape changes.
    // opt: {windowMin, lineWidth, saturationMps2}
    update(unit, opt) {
      this.last = [unit, opt];
      const tab = TABS.find((t) => t.id === this.tab);
      const newest = unit && unit.history.t.length ? unit.history.t[unit.history.t.length - 1] : 0;
      const t0 = opt.windowMin ? newest - opt.windowMin * 60 : -Infinity;
      const panels = tab.panels.map((panel) => ({ panel, pd: this.panelData(panel, unit, t0) }));
      const sig = [this.tab, unit ? unit.csid : '-', opt.lineWidth, opt.saturationMps2]
        .concat(panels.map((p) => (p.pd && p.pd.data[0].length ? p.pd.labels.map((l) => l.label).join(',') + (p.pd.data[0].length < 40 ? 'f' : '') : 'x'))).join('|');
      if (sig !== this.sig) { this.sig = sig; this.build(panels, opt); return; }
      let i = 0;
      for (const { pd } of panels) {
        if (!pd || !pd.data[0].length) continue;
        this.plots[i++].u.setData(pd.data);   // x and y rescale to the data
      }
    }

    // Colours come from CSS; rebuild after a theme switch.
    restyle() { this.sig = ''; if (this.last) this.update(...this.last); }
  }

  (root.DG = root.DG || {}).Charts = Charts;
  root.DG.TABS = TABS;
})(self);
