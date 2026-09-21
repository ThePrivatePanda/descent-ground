// Wires the page together: serial / log input -> fleet -> tables and charts.
(function () {
  'use strict';
  const { packet: P, lines: L, fleet: F, recorder: R } = DG;
  const $ = (id) => document.getElementById(id);

  const live = new F.Fleet();
  const recorder = new R.Recorder();
  const rxMeta = new Map();   // rxKey -> {index, source, lastLineT}
  let rxCount = 0;

  const view = {
    sel: null, paused: false, sort: 'attention', windowS: 300,
    replay: null,   // {events, pos, clock, playing, speed, fleet, names}
  };
  const fleet = () => (view.replay ? view.replay.fleet : live);
  const now = () => (view.replay ? view.replay.clock : Date.now());

  function meta(rx) {
    let m = rxMeta.get(rx);
    if (!m) { m = { index: rxCount++ % 8, source: null, lastLineT: 0 }; rxMeta.set(rx, m); }
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

  // ---------- input ----------
  function ingestLine(target, rx, text, t) {
    const ev = L.parseLine(text);
    const m = meta(rx);
    m.lastLineT = t;
    if (ev.kind === 'packet' || ev.kind === 'badlength') m.source = ev.source;
    if (ev.kind === 'rxinfo') m.source = 'raw';
    return target.ingest(ev, t, rx);
  }

  const hub = new DG.SerialHub((rx, text) => {
    const t = Date.now();
    recorder.add(t, rx, text);
    const r = ingestLine(live, rx, text, t);
    if (r === 'new' && !view.replay) flashNew = true;
  }, () => renderReceivers());

  let flashNew = false;

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
      await recorder.start();
      b.textContent = '● Recording ' + recorder.fileName; b.classList.add('rec');
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('Could not start recording: ' + (e.message || e));
    }
  });

  $('btn-save').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(recorder.sessionBlob());
    a.download = 'descent-session-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.log';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Saved ' + recorder.lines + ' lines');
  });

  window.addEventListener('beforeunload', (e) => {
    if (recorder.writable || live.total > 0) { e.preventDefault(); e.returnValue = ''; }
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
    view.replay = { events, pos: 0, clock: events[0].t, playing: false, speed: +$('rp-speed').value, fleet: new F.Fleet(), names };
    view.sel = null;
    $('replay').hidden = false;
    $('rp-pos').max = events.length;
    seek(events.length);   // show the whole log first; scrub or play from the start
    toast('Opened ' + names.join(', ') + ': ' + events.length + ' lines, ' + view.replay.fleet.total + ' packets');
  }

  function seek(pos) {
    const r = view.replay;
    if (pos < r.pos) { r.fleet = new F.Fleet(); r.pos = 0; }
    while (r.pos < pos) { const e = r.events[r.pos++]; ingestLine(r.fleet, e.rx, e.text, e.t); }
    r.clock = r.pos ? r.events[r.pos - 1].t : r.events[0].t;
    $('rp-pos').value = r.pos;
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
  $('window').addEventListener('change', (e) => { view.windowS = +e.target.value; render(true); });
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
      const battCls = d.valid.soc && d.values.battery < F.LOW_BATTERY_PCT ? ' warn-v' : '';
      const rssiCls = u.bestRssi < F.WEAK_RSSI_DBM ? ' warn-v' : '';
      const rxp = f.rxPercent(u);
      const fresh = t - u.lastT < 700 ? ' flash' : '';
      return '<tr data-csid="' + u.csid + '" class="' + (u.csid === view.sel ? 'sel' : '') + fresh + '">' +
        '<td class="csid">' + u.csid + '</td>' +
        '<td><span class="state ' + state + '">' + STATE_GLYPH[state] + ' ' + state + '</span>' + (d.saturated ? ' <span class="warn-v" title="Acceleration near the ±8 g sensor limit">▲sat</span>' : '') + '</td>' +
        '<td class="r">' + age(a) + '</td>' +
        '<td class="r">' + u.lastCounter + '</td>' +
        '<td class="r">' + u.packets + '</td>' +
        '<td class="r">' + u.missed + '</td>' +
        '<td class="r">' + fmt(rxp, 1) + '</td>' +
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

  const GROUP_TITLES = { gps: 'GPS', env: 'Environment', accel: 'Linear acceleration', gyro: 'Gyroscope', mag: 'Magnetometer', quat: 'Quaternion' };

  function renderLatest(f, t) {
    if (view.paused) return;
    const u = view.sel === null ? null : f.units.get(view.sel);
    const tbl = $('latest');
    if (!u) { tbl.innerHTML = '<tr><td class="k">No unit selected</td></tr>'; return; }
    const d = u.latest;
    const row = (k, v, unit, cls) => '<tr><td class="k">' + k + '</td><td class="v ' + (cls || '') + '">' + v + '</td><td class="u">' + (unit || '') + '</td></tr>';
    const crc = d.crcOk
      ? '<span style="color:var(--good)">✓ pass</span>' + (u.latestSource === 'csv' ? ' <span class="stale-note" title="The old CSV receiver prints values, not bytes; the packet was rebuilt from them to check the CRC">(CSV)</span>' : '')
      : '<span class="bad-v">✗ fail</span>';
    let html = '<colgroup><col style="width:42%"><col><col style="width:58px"></colgroup>' +
      '<tr class="grp"><td colspan="3">Packet</td></tr>' +
      row('CSID', u.csid) +
      row('State', '<span class="state ' + f.state(u, t) + '">' + STATE_GLYPH[f.state(u, t)] + ' ' + f.state(u, t) + '</span>') +
      row('Age', age(t - u.lastT)) +
      row('Counter', d.values.counter) +
      row('Battery', d.valid.soc ? fmt(d.values.battery, 1) : '—', '%') +
      row('Validity', bits(d.values.validity), '0x' + d.values.validity.toString(16).toUpperCase().padStart(2, '0')) +
      row('CRC-16', crc, d.crcReceived.toString(16).toUpperCase().padStart(4, '0')) +
      row('Packet every', Number.isFinite(u.intervalMs) ? fmt(u.intervalMs / 1000, 2) : '—', 's') +
      row('Received by', u.receptions.map((r) => esc(rxName(r.rx)) + ' ' + fmt(r.rssi, 1) + '/' + fmt(r.snr, 1)).join('<br>') || '—', 'dBm/dB');
    let group = null;
    for (const fd of P.FIELDS) {
      if (!fd.group || fd.group === 'soc') continue;
      if (fd.group !== group) { group = fd.group; html += '<tr class="grp"><td colspan="3">' + GROUP_TITLES[group] + (d.valid[group] ? '' : ' <span class="bad-v">— not valid</span>') + '</td></tr>'; }
      const dec = Math.min(fd.csvDecimals, fd.scale >= 1e7 ? 7 : 5);
      if (d.valid[group]) {
        const sat = group === 'accel' && Math.abs(d.values[fd.key]) >= P.ACCEL_SATURATION_MPS2;
        html += row(fd.label, fmt(d.values[fd.key], dec) + (sat ? ' <span class="warn-v" title="Near the ±8 g sensor limit">▲sat</span>' : ''), fd.unit);
      } else {
        const lv = u.lastValid[fd.key];
        html += row(fd.label, '—' + (lv !== undefined ? '<span class="stale-note">last ' + fmt(lv, dec) + '</span>' : ''), fd.unit, 'stale');
      }
    }
    tbl.innerHTML = html;
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
    if (force || t - lastChart > 500 || view.replay) {
      lastChart = t;
      const u = view.sel === null ? null : f.units.get(view.sel);
      $('graph-title').textContent = u ? 'CSID ' + u.csid + ' history' : 'History';
      // Window ends at the unit's last packet, so a silent unit still shows
      // its final minutes instead of an empty chart.
      charts.update(u, u ? Math.min(t, u.lastT + 2000) : t, view.windowS);
    }
  }

  setInterval(() => { if (!view.replay || !view.replay.playing) render(flashNew); flashNew = false; }, 250);
  render(true);

  // Offline copy for the hosted site. file:// pages don't need it.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Handle for manual checks in the console.
  window.DGApp = { live, view, hub, recorder, startReplay, seek };
})();
