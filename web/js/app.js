// Wires the page together: serial / log input -> fleet -> panels and charts.
(function () {
  'use strict';
  const { packet: P, lines: L, fleet: F, recorder: R, store: S } = DG;
  const $ = (id) => document.getElementById(id);

  let settings = S.loadSettings();
  const live = new F.Fleet(settings);
  const recorder = new R.Recorder();
  const autosave = new S.Autosave();
  const rxMeta = new Map();   // rxKey -> {index, source}
  let rxCount = 0;

  const view = {
    sel: null, paused: false, sort: 'attention',
    replay: null,   // {events, pos, clock, playing, speed, fleet, names}
  };
  const fleet = () => (view.replay ? view.replay.fleet : live);
  const now = () => (view.replay ? view.replay.clock : Date.now());
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  function meta(rx) {
    let m = rxMeta.get(rx);
    if (!m) { m = { index: rxCount++ % 8, source: null }; rxMeta.set(rx, m); }
    return m;
  }
  function rxName(rx) {
    const r = fleet().receivers.get(rx);
    const name = r && r.id ? rx + ' · ' + r.id : rx;
    return name.length > 22 ? name.slice(0, 20) + '…' : name;
  }

  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 3000);
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- input ----------
  function ingestLine(target, rx, text, t) {
    const ev = L.parseLine(text);
    const m = meta(rx);
    if (ev.kind === 'packet' || ev.kind === 'badlength') m.source = ev.source;
    if (ev.kind === 'rxinfo') m.source = 'raw';
    return target.ingest(ev, t, rx);
  }

  const hub = new DG.SerialHub((rx, text) => {
    const t = Date.now();
    recorder.add(t, rx, text);
    if (settings.autosave) autosave.add(R.formatLine(t, rx, text));
    ingestLine(live, rx, text, t);
  }, () => renderReceivers());

  if (!hub.supported) { $('unsupported').hidden = false; $('btn-connect').disabled = true; $('btn-record').disabled = true; }

  $('btn-connect').addEventListener('click', async () => {
    try {
      const p = await hub.add();
      meta(p.key);
      toast('Connected ' + p.key + (p.usb ? ' (USB ' + p.usb + ')' : ''));
    } catch (e) {
      if (e && e.name !== 'NotFoundError') toast('Could not open port: ' + (e.message || e));
    }
  });

  // ---------- recording ----------
  $('btn-record').addEventListener('click', async () => {
    const b = $('btn-record');
    if (recorder.writable) {
      await recorder.stop();
      b.textContent = 'Record to file'; b.classList.remove('rec');
      toast('Recording saved to ' + recorder.fileName);
      return;
    }
    if (!recorder.canStream()) { toast('This browser cannot stream to a file; use Save session instead'); return; }
    try {
      await recorder.start(settings.fileTag);
      b.textContent = '● Recording ' + recorder.fileName; b.classList.add('rec');
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('Could not start recording: ' + (e.message || e));
    }
  });

  $('btn-save').addEventListener('click', () => {
    download(recorder.sessionBlob(), settings.fileTag + '-session-' + stamp() + '.log');
    toast('Saved ' + recorder.lines + ' lines');
  });

  window.addEventListener('beforeunload', (e) => {
    if (recorder.writable || live.total > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- crash autosave ----------
  function armAutosave() {
    clearInterval(armAutosave.timer);
    if (settings.autosave) armAutosave.timer = setInterval(() => autosave.flush().catch(() => {}), settings.autosaveS * 1000);
  }
  armAutosave();

  let recovering = null;
  autosave.previous().then((list) => {
    const withLines = list.filter((s) => s.lines > 0);
    if (!withLines.length) return;
    recovering = withLines[0];
    $('recover-text').textContent = 'Unsaved session from ' + new Date(recovering.started).toLocaleString() +
      ' (' + recovering.lines + ' lines) is still in this browser.' + (withLines.length > 1 ? ' ' + (withLines.length - 1) + ' older.' : '');
    $('recover').hidden = false;
  }).catch(() => {});

  const recoveredText = async () => R.HEADER + ' recovered ' + recovering.started + '\n' + await autosave.text(recovering.id);
  $('recover-open').addEventListener('click', async () => {
    const events = R.parseLogFile(await recoveredText(), 'recovered', 0);
    if (events.length) startReplay(events, ['recovered session']);
  });
  $('recover-download').addEventListener('click', async () => {
    download(new Blob([await recoveredText()], { type: 'text/plain' }), settings.fileTag + '-recovered-' + recovering.started.slice(0, 19).replace(/[:T]/g, '-') + '.log');
  });
  $('recover-discard').addEventListener('click', async () => {
    await autosave.remove(recovering.id);
    $('recover').hidden = true;
    toast('Discarded the stored session');
  });

  // ---------- replay ----------
  $('file-open').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const parsed = [];
    for (const f of files) parsed.push(R.parseLogFile(await f.text(), f.name, midnight.getTime()));
    const events = R.mergeFiles(parsed);
    if (!events.length) { toast('No lines found in ' + files.map((f) => f.name).join(', ')); return; }
    startReplay(events, files.map((f) => f.name));
  });

  function startReplay(events, names) {
    stopPlay();
    view.replay = { events, pos: 0, clock: events[0].t, playing: false, speed: +$('rp-speed').value, fleet: new F.Fleet(settings), names };
    view.sel = null;
    $('replay').hidden = false;
    $('rp-pos').max = events.length;
    seek(events.length);   // show the whole log first; scrub or play from the start
    toast('Opened ' + names.join(', ') + ': ' + events.length + ' lines, ' + view.replay.fleet.total + ' packets');
  }

  function seek(pos) {
    const r = view.replay;
    if (pos < r.pos) { r.fleet = new F.Fleet(settings); r.pos = 0; }
    while (r.pos < pos) { const e = r.events[r.pos++]; ingestLine(r.fleet, e.rx, e.text, e.t); }
    r.clock = r.pos ? r.events[r.pos - 1].t : r.events[0].t;
    $('rp-pos').value = r.pos;
    $('rp-time').textContent = new Date(r.clock).toTimeString().slice(0, 8);
    render(true);
  }

  function stopPlay() {
    if (view.replay) view.replay.playing = false;
    clearInterval(view.playTimer);
    $('rp-play').textContent = 'Play';
  }

  $('rp-play').addEventListener('click', () => {
    const r = view.replay;
    if (r.playing) { stopPlay(); return; }
    if (r.pos >= r.events.length) seek(0);
    r.playing = true;
    $('rp-play').textContent = 'Pause';
    view.playTimer = setInterval(() => {
      r.clock += 100 * r.speed;
      let pos = r.pos;
      while (pos < r.events.length && r.events[pos].t <= r.clock) pos++;
      const keepClock = r.clock;
      if (pos !== r.pos) seek(pos);
      r.clock = keepClock;
      render();
      if (r.pos >= r.events.length) stopPlay();
    }, 100);
  });
  $('rp-speed').addEventListener('change', (e) => { if (view.replay) view.replay.speed = +e.target.value; });
  $('rp-pos').addEventListener('input', (e) => { stopPlay(); seek(+e.target.value); });
  $('rp-exit').addEventListener('click', () => {
    stopPlay(); view.replay = null; view.sel = null; $('replay').hidden = true; render(true);
  });

  // ---------- fleet controls ----------
  $('sort').addEventListener('change', (e) => { view.sort = e.target.value; render(); });
  $('btn-pause').addEventListener('click', (e) => {
    view.paused = !view.paused;
    e.target.textContent = view.paused ? 'Resume' : 'Pause';
    e.target.classList.toggle('on', view.paused);
  });
  $('sel-unit').addEventListener('change', (e) => { view.sel = +e.target.value; render(true); });
  $('btn-hide').addEventListener('click', () => {
    if (view.sel === null) return;
    fleet().hidden.add(view.sel); toast('Hid CSID ' + view.sel); view.sel = null; render(true);
  });
  $('btn-only').addEventListener('click', () => {
    if (view.sel === null) return;
    for (const c of fleet().units.keys()) if (c !== view.sel) fleet().hidden.add(c);
    toast('Showing only CSID ' + view.sel); render(true);
  });
  $('btn-restore').addEventListener('click', () => { fleet().hidden.clear(); render(true); });
  $('btn-reset').addEventListener('click', () => {
    const f = fleet();
    const keep = f.receivers;
    f.clear(); f.receivers = keep;
    view.sel = null; toast('Fleet reset. Receivers stay connected; the session file keeps every line.'); render(true);
  });
  $('fleet').querySelector('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (tr) { view.sel = +tr.dataset.csid; render(true); }
  });

  // ---------- settings ----------
  const MIN = (n) => [n, n ? 'Last ' + n + ' min' : 'All data kept'];
  const FIELDS = [
    { section: 'Graphs' },
    { key: 'graphWindowMin', label: 'Time shown', type: 'select', options: [0, 1, 5, 15, 30, 60].map(MIN),
      hint: 'Counted back from the newest packet.' },
    { key: 'retainMin', label: 'Drop graph data older than', type: 'select',
      options: [[0, 'Never'], [5, '5 min'], [15, '15 min'], [30, '30 min'], [60, '1 hour'], [180, '3 hours']],
      hint: 'Packet counts, misses and resets are never dropped; only graph history.' },
    { key: 'maxPoints', label: 'Max graph points per unit', type: 'number', min: 100, step: 100 },
    { key: 'lineWidth', label: 'Line width', type: 'select', options: [[1, 'Thin'], [1.25, 'Normal'], [2, 'Thick']] },
    { section: 'Status' },
    { key: 'lostMin', label: 'Lost after silence of (min)', type: 'number', min: 1, step: 1 },
    { key: 'staleFactor', label: 'Stale after missed intervals', type: 'number', min: 1, step: 0.5 },
    { key: 'staleMinS', label: 'Stale no sooner than (s)', type: 'number', min: 1, step: 1 },
    { key: 'lowBatteryPct', label: 'Low battery below (%)', type: 'number', min: 0, max: 100, step: 1 },
    { key: 'weakRssiDbm', label: 'Weak RF below (dBm)', type: 'number', max: 0, step: 1 },
    { key: 'saturationMps2', label: 'Accel saturation at (m/s²)', type: 'number', min: 1, step: 1,
      hint: 'BNO085 range is ±8 g ≈ 78 m/s².' },
    { key: 'dedupeMs', label: 'Same packet across receivers within (ms)', type: 'number', min: 100, step: 100 },
    { section: 'Saving' },
    { key: 'autosave', label: 'Autosave session in this browser', type: 'checkbox',
      hint: 'Survives a crashed tab or laptop; offered for recovery on the next visit.' },
    { key: 'autosaveS', label: 'Autosave every (s)', type: 'number', min: 1, step: 1 },
    { key: 'fileTag', label: 'File name prefix', type: 'text' },
  ];

  function buildSettingsForm() {
    const form = $('settings-form');
    form.innerHTML = '';
    for (const f of FIELDS) {
      if (f.section) { const h = document.createElement('h3'); h.textContent = f.section; form.appendChild(h); continue; }
      const row = document.createElement('div'); row.className = 'field';
      const id = 'set-' + f.key;
      let input;
      if (f.type === 'select') {
        input = document.createElement('select');
        for (const [v, label] of f.options) input.add(new Option(label, v));
        // A value saved by an older version may no longer be offered: use the nearest option.
        if (!f.options.some(([v]) => v === settings[f.key])) {
          const near = f.options.reduce((a, b) => (Math.abs(b[0] - settings[f.key]) < Math.abs(a[0] - settings[f.key]) ? b : a))[0];
          settings = Object.assign({}, settings, { [f.key]: near });
          S.saveSettings(settings);
        }
        input.value = settings[f.key];
      } else {
        input = document.createElement('input');
        input.type = f.type;
        for (const a of ['min', 'max', 'step']) if (f[a] !== undefined) input[a] = f[a];
        if (f.type === 'checkbox') input.checked = settings[f.key]; else input.value = settings[f.key];
      }
      input.id = id; input.dataset.key = f.key;
      const label = document.createElement('label'); label.htmlFor = id; label.textContent = f.label;
      row.append(label, input);
      if (f.hint) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = f.hint; row.appendChild(h); }
      form.appendChild(row);
    }
  }

  function applySettings(next) {
    settings = next;
    S.saveSettings(settings);
    live.setConfig(settings);
    if (view.replay) view.replay.fleet.setConfig(settings);
    $('window').value = settings.graphWindowMin;
    armAutosave();
    render(true);
  }

  $('settings-form').addEventListener('change', (e) => {
    const k = e.target.dataset.key;
    if (!k) return;
    const def = S.defaults()[k];
    let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (typeof def === 'number') { v = Number(v); if (!Number.isFinite(v)) { e.target.value = settings[k]; return; } }
    applySettings(Object.assign({}, settings, { [k]: v }));
  });
  $('settings-reset').addEventListener('click', () => { applySettings(S.defaults()); buildSettingsForm(); toast('Settings reset to defaults'); });
  $('btn-settings').addEventListener('click', () => { buildSettingsForm(); $('settings').hidden = !$('settings').hidden; });
  $('settings-close').addEventListener('click', () => { $('settings').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('settings').hidden = true; });

  for (const [v, label] of [0, 1, 5, 15, 30, 60].map(MIN)) $('window').add(new Option(label, v));
  $('window').value = settings.graphWindowMin;
  buildSettingsForm();   // also corrects values an older version saved
  $('window').addEventListener('change', (e) => { applySettings(Object.assign({}, settings, { graphWindowMin: +e.target.value })); buildSettingsForm(); });

  // ---------- theme ----------
  try { const th = localStorage.getItem('dg-theme'); if (th) document.documentElement.dataset.theme = th; } catch (e) { /* storage blocked */ }
  $('btn-theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('dg-theme', next); } catch (e) { /* storage blocked */ }
    charts.restyle();
  });

  // ---------- rendering ----------
  const fmt = (v, d) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function age(ms) {
    if (!Number.isFinite(ms)) return '—';
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm' + String(Math.floor(s % 60)).padStart(2, '0');
    return Math.floor(s / 3600) + 'h' + String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  }

  function bits(mask, big) {
    return '<span class="bits' + (big ? ' lg' : '') + '">' + P.VALIDITY_BITS.map((b) => {
      const on = (mask >> b.bit) & 1;
      return '<span class="' + (on ? '' : 'off') + '" title="' + b.name + (on ? ' valid' : ' NOT valid') + '">' + b.short + '</span>';
    }).join('') + '</span>';
  }

  const STATE_GLYPH = { OK: '●', STALE: '◐', LOST: '○' };
  const stateHtml = (st) => '<span class="state ' + st + '">' + STATE_GLYPH[st] + ' ' + st + '</span>';

  function renderSummary(f, t) {
    const s = f.summary(t);
    const item = (label, v, cls) => '<span class="' + (v && cls ? cls : '') + '">' + label + ' <b>' + v + '</b></span>';
    $('summary').innerHTML = [
      item('Heard', s.heard), item('Active', s.active), item('Stale', s.stale, 'warn'), item('Lost', s.lost, 'bad'),
      item('Packets', s.packets), item('Bad CRC', s.badCrc, 'bad'), item('Low batt', s.lowBattery, 'warn'),
      item('Validity issues', s.validityIssues, 'warn'), item('Weak RF', s.weakRf, 'warn'),
      item('Saturated', s.saturated, 'warn'), item('Resets', s.resets, 'warn'),
    ].join('');
  }

  function renderFleet(f, t) {
    const rows = f.rows(t, view.sort);
    if (view.sel === null || !f.units.has(view.sel) || f.hidden.has(view.sel)) view.sel = rows.length ? rows[0].unit.csid : null;
    $('fleet-empty').hidden = rows.length > 0;
    const rxTotal = [...f.receivers.values()].filter((r) => r.packets > 0).length;
    $('fleet').querySelector('tbody').innerHTML = rows.map(({ unit: u, state, age: a }) => {
      const d = u.latest;
      const batt = d.valid.soc ? fmt(d.values.battery, 1) + '%' : '—';
      const battCls = d.valid.soc && d.values.battery < settings.lowBatteryPct ? ' warn-v' : '';
      const rssiCls = u.bestRssi < settings.weakRssiDbm ? ' warn-v' : '';
      const fresh = t - u.lastT < 300 ? ' flash' : '';
      return '<tr data-csid="' + u.csid + '" class="' + (u.csid === view.sel ? 'sel' : '') + fresh + '">' +
        '<td class="csid">' + u.csid + '</td>' +
        '<td>' + stateHtml(state) + (d.saturated ? ' <span class="warn-v" title="Acceleration near the sensor limit">▲sat</span>' : '') + '</td>' +
        '<td class="r">' + age(a) + '</td>' +
        '<td class="r">' + u.lastCounter + '</td>' +
        '<td class="r">' + u.packets + '</td>' +
        '<td class="r">' + u.missed + '</td>' +
        '<td class="r">' + fmt(f.rxPercent(u), 1) + '</td>' +
        '<td class="r' + (u.resets ? ' warn-v' : '') + '">' + u.resets + '</td>' +
        '<td class="r' + battCls + '">' + batt + '</td>' +
        '<td>' + bits(d.values.validity) + '</td>' +
        '<td class="r' + rssiCls + '">' + fmt(u.bestRssi, 1) + '</td>' +
        '<td class="r">' + fmt(u.bestSnr, 1) + '</td>' +
        '<td class="r">' + (Number.isFinite(u.intervalMs) ? fmt(u.intervalMs / 1000, u.intervalMs < 10000 ? 2 : 0) + 's' : '—') + '</td>' +
        '<td class="num" title="' + esc(u.receptions.map((r) => rxName(r.rx) + ' ' + fmt(r.rssi, 1) + ' dBm').join('\n')) + '">' + u.receptions.length + '/' + rxTotal + '</td>' +
        '</tr>';
    }).join('');
    const sel = $('sel-unit');
    const opts = [...f.units.keys()].sort((a, b) => a - b);
    const want = opts.map((c) => '<option value="' + c + '">CSID ' + c + '</option>').join('');
    if (sel.dataset.sig !== want) { sel.innerHTML = want; sel.dataset.sig = want; }
    if (view.sel !== null) sel.value = view.sel;
  }

  // One value cell: live when its validity bit is set, otherwise the last
  // trusted value in muted ink (or — if there never was one).
  function cell(u, key, dec) {
    const fd = P.FIELDS.find((x) => x.key === key);
    const d = u.latest;
    if (d.valid[fd.group]) {
      const sat = fd.group === 'accel' && Math.abs(d.values[key]) >= settings.saturationMps2;
      return '<td class="v' + (sat ? ' warn-v' : '') + '"' + (sat ? ' title="Near the accelerometer limit"' : '') + '>' + (sat ? '▲' : '') + fmt(d.values[key], dec) + '</td>';
    }
    const lv = u.lastValid[key];
    return '<td class="v stale" title="Not valid in this packet' + (lv !== undefined ? '; last trusted value shown' : '') + '">' + (lv !== undefined ? fmt(lv, dec) : '—') + '</td>';
  }

  function sectTitle(u, name, group) {
    return '<h3>' + name + (u.latest.valid[group] ? '' : ' <span class="bad-v">not valid</span>') + '</h3>';
  }

  function renderLatest(f, t) {
    if (view.paused) return;
    const u = view.sel === null ? null : f.units.get(view.sel);
    const el = $('latest');
    if (!u) { el.innerHTML = '<div class="none">No unit selected</div>'; return; }
    const d = u.latest;
    const stat = (k, v, title) => '<div class="stat"' + (title ? ' title="' + esc(title) + '"' : '') + '><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
    const crc = d.crcOk ? '<span style="color:var(--good)">✓</span> ' + d.crcReceived.toString(16).toUpperCase().padStart(4, '0') : '<span class="bad-v">✗ fail</span>';
    const kv = (label, key, dec, unit) => '<tr><td class="k">' + label + '</td>' + cell(u, key, dec) + '<td class="u">' + unit + '</td></tr>';
    // Vector rows have 4 value columns; 3-axis sensors leave "real" empty.
    const vec = (label, keys, dec, unit) => '<tr><td class="k">' + label + '</td>' + keys.map((k) => cell(u, k, dec)).join('') +
      (keys.length === 3 ? '<td></td>' : '') + '<td class="u">' + unit + '</td></tr>';
    const imuBad = ['accel', 'gyro', 'mag', 'quat'].filter((g) => !d.valid[g]);

    el.innerHTML =
      '<div class="lp-head"><span class="id">CSID ' + u.csid + '</span>' + stateHtml(f.state(u, t)) +
        (d.saturated ? '<span class="warn-v">▲ accel saturated</span>' : '') +
        '<span class="age">' + age(t - u.lastT) + ' ago</span></div>' +
      '<div class="stats">' +
        stat('Counter', d.values.counter) +
        stat('Battery', d.valid.soc ? fmt(d.values.battery, 1) + '%' : '—') +
        stat('Every', Number.isFinite(u.intervalMs) ? fmt(u.intervalMs / 1000, 2) + 's' : '—') +
        stat('CRC', crc, u.latestSource === 'csv' ? 'Old CSV receiver: packet rebuilt from the printed values to check the CRC' : '') +
        stat('Packets', u.packets) + stat('Missed', u.missed) + stat('Resets', u.resets) + stat('Rx %', fmt(f.rxPercent(u), 1)) +
      '</div>' +
      '<div>' + bits(d.values.validity, true) + ' <span class="stale-note">0x' + d.values.validity.toString(16).toUpperCase().padStart(2, '0') + '</span></div>' +
      '<div class="rxlist">' + (u.receptions.map((r) => '<span>' + esc(rxName(r.rx)) + ' ' + fmt(r.rssi, 1) + ' dBm / ' + fmt(r.snr, 1) + ' dB</span>').join('') || '—') + '</div>' +
      '<div class="two">' +
        '<div class="sect">' + sectTitle(u, 'GPS', 'gps') + '<table class="vals">' +
          kv('Latitude', 'lat', 6, '°') + kv('Longitude', 'lon', 6, '°') + kv('Altitude', 'gpsAlt', 1, 'm') + '</table></div>' +
        '<div class="sect">' + sectTitle(u, 'Environment', 'env') + '<table class="vals">' +
          kv('Temp', 'temp', 2, '°C') + kv('Pressure', 'pressure', 1, 'hPa') + kv('Humidity', 'humidity', 1, '%') + kv('Altitude', 'envAlt', 1, 'm') + '</table></div>' +
      '</div>' +
      '<div class="sect"><h3>IMU' + (imuBad.length ? ' <span class="bad-v">not valid: ' + imuBad.join(', ') + '</span>' : '') + '</h3><table class="vals">' +
        '<tr><th></th><th>X / i</th><th>Y / j</th><th>Z / k</th><th>real</th><th></th></tr>' +
        vec('Accel', ['ax', 'ay', 'az'], 2, 'm/s²') +
        vec('Gyro', ['gx', 'gy', 'gz'], 1, 'deg/s') +
        vec('Mag', ['mx', 'my', 'mz'], 1, 'µT') +
        vec('Quat', ['qi', 'qj', 'qk', 'qr'], 4, '') +
      '</table></div>';
  }

  function renderReceivers() {
    const f = fleet();
    const t = now();
    const keys = new Set([...f.receivers.keys(), ...hub.ports.map((p) => p.key)]);
    $('receivers').innerHTML = [...keys].map((k) => {
      const r = f.receivers.get(k);
      const port = hub.ports.find((p) => p.key === k);
      const m = meta(k);
      let st = 'no data'; let cls = 'warning';
      if (port && port.status !== 'open') { st = port.status; cls = 'critical'; } else if (r && t - r.lastT < 7000) { st = 'live'; cls = 'good'; } else if (r) { st = 'quiet ' + age(t - r.lastT); }
      const sf = r && r.info.sf ? ' SF' + r.info.sf : '';
      const kind = m.source === 'csv' ? ' CSV' : m.source === 'raw' ? ' raw' : '';
      const nums = r ? r.unique + ' new · ' + (r.packets - r.unique - r.badCrc) + ' dup' + (r.badCrc ? ' · ' + r.badCrc + ' bad' : '') + (r.radioErrors ? ' · ' + r.radioErrors + ' err' : '') : '';
      return '<span class="rx" title="' + esc((port && port.usb ? 'USB ' + port.usb + '\n' : '') + (port && port.error ? port.error : '')) + '">' +
        '<span class="sw" style="background:var(--series-' + (m.index + 1) + ')"></span>' +
        '<b>' + esc(rxName(k)) + '</b><span class="st ' + cls + '">' + st + '</span>' +
        '<span class="meta">' + kind + sf + ' ' + nums + '</span>' +
        (port && port.status === 'open' ? '<button data-close="' + k + '" title="Disconnect">×</button>' : '') + '</span>';
    }).join('');
    const sfs = new Set([...f.receivers.values()].map((r) => r.info.sf).filter(Boolean));
    if (sfs.size > 1) $('receivers').insertAdjacentHTML('beforeend', '<span class="rx"><span class="st critical">▲ receivers disagree on SF</span></span>');
    $('mode').textContent = view.replay ? 'Replaying ' + view.replay.names.join(', ') : (recorder.lines ? recorder.lines + ' lines this session' : '');
  }
  $('receivers').addEventListener('click', (e) => {
    const k = e.target.dataset.close;
    const p = k && hub.ports.find((x) => x.key === k);
    if (p) hub.close(p);
  });

  const charts = new DG.Charts($('charts'), $('tabs'), (k) => ({ label: rxName(k), index: meta(k).index }));
  let lastChart = 0;

  function render(force) {
    const f = fleet();
    const t = now();
    renderSummary(f, t);
    renderFleet(f, t);
    renderLatest(f, t);
    renderReceivers();
    if (force || Date.now() - lastChart > 500) {
      lastChart = Date.now();
      const u = view.sel === null ? null : f.units.get(view.sel);
      $('graph-title').textContent = u ? 'CSID ' + u.csid + ' history' : 'History';
      charts.update(u, { windowMin: settings.graphWindowMin, lineWidth: settings.lineWidth, saturationMps2: settings.saturationMps2 });
    }
  }

  setInterval(() => { if (!view.replay || !view.replay.playing) render(); }, 250);
  render(true);

  // Offline copy for the hosted site. file:// pages don't need it.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Handle for manual checks in the console.
  window.DGApp = { live, view, hub, recorder, autosave, startReplay, seek, settings: () => settings };
})();
