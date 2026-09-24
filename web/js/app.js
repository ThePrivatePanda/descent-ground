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
    sel: null, paused: false, sort: 'attention', expanded: new Set(),
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
    const name = r && r.id ? rx + ' ' + r.id : rx;
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

  // Every line from every connected receiver is recorded, whichever unit is on screen.
  // The native app or Web Serial, depending on where the page was loaded from.
  const hub = DG.makeHub((rx, text) => {
    const t = Date.now();
    const result = ingestLine(live, rx, text, t);
    recorder.add(t, rx, text, result === 'new' || result === 'duplicate' || result === 'badcrc');
    if (settings.autosave) autosave.add(R.formatLine(t, rx, text));
  }, () => renderReceivers(), (msg) => { toast(msg); serialBanner(); });

  // Called again if the transport changes under us, so it has to set both ways round.
  function serialBanner() {
    const native = hub.native;
    $('btn-connect').textContent = native ? 'Rescan' : 'Connect receiver';
    $('btn-connect').title = native
      ? 'Receivers are found by themselves; this looks again now'
      : 'Pick a T-Beam serial port';
    $('btn-setup').hidden = !native;
    if (!native) $('setup').hidden = true;
    if (hub.supported) return;
    $('unsupported').hidden = false; $('btn-connect').disabled = true;
  }
  serialBanner();

  $('btn-connect').addEventListener('click', async () => {
    try {
      const p = await hub.add();
      meta(p.key);
      toast(hub.native
        ? hub.ports.length + (hub.ports.length === 1 ? ' receiver' : ' receivers') + ' found'
        : 'Connected ' + p.key + (p.usb ? ' (USB ' + p.usb + ')' : ''));
    } catch (e) {
      if (e && e.name !== 'NotFoundError') toast('Could not open port: ' + (e.message || e));
    }
  });

  // ---------- setting up a receiver ----------
  // Writing firmware to a T-Beam. The board is normally already being read, so the
  // app hands the port over and hands it back; the existing firmware is saved first.
  const setup = { rows: [], busy: null, pct: 0, note: '' };

  function boardNow(port) {
    const p = hub.ports.find((x) => x.port === port);
    if (!p) return 'not being read';
    const r = fleet().receivers.get(p.key);
    const m = rxMeta.get(p.key);
    if (r && r.id) return p.key + ' ' + r.id + (r.info && r.info.sf ? ', SF' + r.info.sf : '');
    if (m && m.source === 'csv') return p.key + ', CSV firmware';
    return p.key + ', nothing heard yet';
  }

  // Every board plugged in, and what the app is doing about it. Nothing is opened
  // until it is called a receiver: opening a port pulses DTR and can reset whatever is
  // on the other end, and the USB chip cannot tell a T-Beam from a ChipSat.
  const STATE_WORDS = {
    receiver: 'reading it',
    waiting: 'not touched',
    dismissed: 'disconnected by you',
    ignored: 'left alone',
  };

  // Which physical board is /dev/ttyUSB0? Nobody can answer that from a port name, so
  // the app watches for one to be unplugged and plugged back in, and you name that one.
  const ident = { watching: false, found: null, left: 0, timer: null };

  function identBanner() {
    if (ident.found) {
      return '<div class="ident found"><b>' + esc(ident.found) + '</b> is the one you just replugged. ' +
        'Give it a name below.</div>';
    }
    if (ident.watching) {
      return '<div class="ident"><b>Unplug the board you want to name, then plug it back in.</b> ' +
        'Waiting ' + ident.left + ' s. Nothing is opened while it watches.</div>';
    }
    return '';
  }

  function boardRow(b) {
    const is = b.state === 'receiver';
    const mine = ident.found === b.port;
    const buttons = is
      ? '<button data-not="' + esc(b.port) + '">Not a receiver</button>'
      : '<button data-yes="' + esc(b.port) + '" class="primary">This is a receiver</button>' +
        (b.state === 'ignored' ? '' : '<button data-not="' + esc(b.port) + '">Leave it alone</button>');
    const title = b.name ? esc(b.name) : esc(b.port);
    return '<div class="setup-row' + (mine ? ' found' : '') + '">' +
      '<div><b>' + title + '</b><span class="note">' + (b.name ? ' — ' + esc(b.port) : '') +
        ' — ' + esc(b.label) + ', USB ' + esc(b.usb) + (b.serial ? ', serial ' + esc(b.serial) : '') +
        ' — ' + esc(STATE_WORDS[b.state] || b.state) + '</span></div>' +
      '<div class="setup-actions">' +
        '<input class="nameit" data-name="' + esc(b.port) + '" value="' + esc(b.name || '') +
          '" placeholder="call it something" maxlength="40">' +
        '<button data-test="' + esc(b.port) + '" title="Open it for five seconds and show what it says. This can reset the board.">Test</button>' +
        buttons + '</div>' +
      (b.testResult ? '<pre class="testout">' + esc(b.testResult) + '</pre>' : '') +
      '</div>';
  }

  function renderBoards() {
    const boards = hub.boards || [];
    const head = '<h3>Boards</h3><p class="note">The app opens a board only once you say it is a receiver, ' +
      'because opening a port can reset the board on the other end. It remembers the board, not the ' +
      'socket, so a replug needs no second answer.</p>' +
      '<div class="setup-actions"><button id="btn-ident"' + (ident.watching ? ' disabled' : '') + '>' +
      (ident.watching ? 'Watching…' : 'Which board is which?') + '</button></div>' + identBanner();
    if (!boards.length) return head + '<p class="note">Nothing plugged in.</p>';
    return head + boards.map(boardRow).join('');
  }

  async function pollIdentify() {
    let st;
    try { st = await hub.identifyState(); } catch (e) { return; }
    ident.watching = !!st.watching;
    ident.left = st.seconds_left || 0;
    if (st.found) {
      ident.found = st.found;
      ident.watching = false;
      clearInterval(ident.timer); ident.timer = null;
      toast(st.found + ' is the board you replugged');
    } else if (!st.watching) {
      clearInterval(ident.timer); ident.timer = null;
    }
    renderSetup();
  }

  function renderSetup() {
    const body = $('setup-body');
    // A redraw while someone is typing a name throws away what they typed, and the
    // panel redraws whenever a board is seen. Put the caret back where it was.
    const active = document.activeElement;
    const typingIn = active && active.getAttribute && active.getAttribute('data-name');
    const caret = typingIn ? [active.getAttribute('data-name'), active.value, active.selectionStart] : null;
    if (!setup.rows.length) {
      body.innerHTML = renderBoards();
      restoreTyping(caret);
      return;
    }
    body.innerHTML = setup.rows.map((row) => {
      const busy = setup.busy === row.port;
      const bar = busy ? '<div class="bar-track"><div class="bar-fill" style="width:' + setup.pct + '%"></div></div><span class="note">' + esc(setup.note) + '</span>' : '';
      const action = busy ? ''
        : row.confirm
          ? '<button data-flash="' + esc(row.port) + '" class="primary">Overwrite it</button><button data-cancel="' + esc(row.port) + '">Cancel</button>'
          : '<button data-ask="' + esc(row.port) + '"' + (setup.busy ? ' disabled' : '') + '>Flash</button>';
      const keep = busy ? '' : '<label class="note"><input type="checkbox" data-backup="' + esc(row.port) + '"' +
        (row.skipBackup ? '' : ' checked') + '> save the old firmware first (a few minutes)</label>';
      const sf = busy ? '' : '<label class="note">comes up on <select data-sf="' + esc(row.port) + '">' +
        [7, 8, 9, 10, 11, 12].map((n) => '<option value="' + n + '"' + (n === row.sf ? ' selected' : '') + '>SF' + n + '</option>').join('') +
        '</select></label>';
      return '<div class="setup-row"><div><b>' + esc(row.port) + '</b><span class="note"> — ' + esc(boardNow(row.port)) + '</span></div>' +
        '<div class="setup-actions">' + keep + sf + action + '</div>' + bar + '</div>';
    }).join('') + renderBoards();
    restoreTyping(caret);
  }

  async function openSetup() {
    $('setup').hidden = false;
    $('setup-body').innerHTML = '<p class="note">Looking for boards…</p>';
    hub.onFlash = (m) => {
      setup.pct = m.pct || 0;
      setup.note = m.note || '';
      renderSetup();
    };
    try {
      const j = await hub.candidates();
      setup.rows = (j.candidates || []).map((c) => ({ port: c.port, sf: 9, confirm: false }));
      $('setup-note').textContent = j.firmware
        ? 'Writes ' + j.firmware + '. The board\'s current firmware is saved beside the app first.'
        : 'This build has no firmware in it.';
    } catch (e) {
      setup.rows = [];
      $('setup-note').textContent = 'Could not ask the app: ' + (e.message || e);
    }
    renderSetup();
  }

  // Which build this page is, for when someone asks whether the hosted copy is current.
  // Written by the deploy; absent when the page came off a disk or out of the app.
  fetch('version.json').then((r) => (r.ok ? r.json() : null)).then((v) => {
    if (v && v.commit) {
      document.querySelector('.brand').title = 'build ' + v.commit + ', deployed ' + v.built;
    }
  }).catch(() => { /* not deployed from the repo */ });

  // First run with boards plugged in and none of them claimed yet: show the panel,
  // because an empty dashboard with no explanation is the worst of both worlds.
  let offeredSetup = false;
  function offerSetupOnce() {
    if (offeredSetup || !hub.native) return;
    const boards = hub.boards || [];
    if (!boards.length || boards.some((b) => b.state === 'receiver')) return;
    offeredSetup = true;
    openSetup();
  }

  $('btn-setup').addEventListener('click', () => {
    if ($('setup').hidden) openSetup(); else $('setup').hidden = true;
  });
  $('setup-close').addEventListener('click', () => { $('setup').hidden = true; hub.onFlash = null; });

  $('setup-body').addEventListener('change', async (e) => {
    const named = e.target.getAttribute('data-name');
    if (named) {
      try {
        const clean = await hub.setName(named, e.target.value);
        toast(clean ? 'Called it ' + clean : 'Name cleared');
        if (ident.found === named) ident.found = null;
        renderSetup();
      } catch (err) {
        toast('Could not name it: ' + (err.message || err));
      }
      return;
    }
    const backup = e.target.getAttribute('data-backup');
    if (backup) {
      const r = setup.rows.find((x) => x.port === backup);
      if (r) r.skipBackup = !e.target.checked;
      renderSetup();
      return;
    }
    const port = e.target.getAttribute('data-sf');
    if (!port) return;
    const row = setup.rows.find((r) => r.port === port);
    if (row) row.sf = Number(e.target.value);
  });

  $('setup-body').addEventListener('click', async (e) => {
    if (e.target.id === 'btn-ident') {
      ident.found = null;
      await hub.identifyStart();
      ident.watching = true; ident.left = 60;
      clearInterval(ident.timer);
      ident.timer = setInterval(pollIdentify, 1000);
      renderSetup();
      return;
    }
    const test = e.target.getAttribute('data-test');
    if (test) {
      const b = (hub.boards || []).find((x) => x.port === test);
      if (b) { b.testResult = 'listening for five seconds…'; renderSetup(); }
      try {
        const j = await hub.testPort(test);
        const what = { 'descent-receiver': 'a DeSCENT receiver', 'csv-receiver': 'an old CSV receiver',
          'something-else': 'something, but not a receiver', silent: 'nothing at all' }[j.looks_like] || j.looks_like;
        if (b) b.testResult = 'Heard ' + what + (j.lines.length ? ':\n' + j.lines.slice(0, 6).join('\n') : '');
      } catch (err) {
        if (b) b.testResult = 'Could not listen: ' + (err.message || err);
      }
      renderSetup();
      return;
    }
    const yes = e.target.getAttribute('data-yes');
    const not = e.target.getAttribute('data-not');
    if (yes || not) {
      const port = yes || not;
      try {
        await hub.setBoard(port, !!yes);
        toast(yes ? 'Reading ' + port : 'Leaving ' + port + ' alone');
        await openSetup();
      } catch (err) {
        toast('Could not change ' + port + ': ' + (err.message || err));
      }
      return;
    }
    const ask = e.target.getAttribute('data-ask');
    const cancel = e.target.getAttribute('data-cancel');
    const go = e.target.getAttribute('data-flash');
    if (ask || cancel) {
      const row = setup.rows.find((r) => r.port === (ask || cancel));
      if (row) row.confirm = !!ask;
      renderSetup();
      return;
    }
    if (!go) return;
    const row = setup.rows.find((r) => r.port === go);
    if (!row) return;
    setup.busy = go; setup.pct = 0; row.confirm = false;
    // The whole chip is read before anything is erased. It is minutes, not seconds, so
    // say so rather than let a still line look like a board that stopped answering.
    setup.note = row.skipBackup
      ? 'writing the firmware'
      : "saving the board's current firmware first — this reads the whole chip and takes a few minutes";
    renderSetup();
    try {
      const j = await hub.flash(go, row.sf, null, !row.skipBackup);
      toast('Flashed ' + go + ' on SF' + row.sf + '. Old firmware saved to ' + j.backup);
    } catch (err) {
      toast('Did not flash ' + go + ': ' + (err.message || err));
    }
    setup.busy = null;
    renderSetup();
  });

  // ---------- recording ----------
  $('rec-start').addEventListener('click', async () => {
    try {
      await recorder.start(settings.fileTag);
      toast(recorder.toFile ? 'Recording to ' + recorder.fileName : 'Recording. This browser saves the file when you press Stop.');
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('Could not start recording: ' + (e.message || e));
    }
    renderRecorder();
  });
  $('rec-pause').addEventListener('click', () => {
    if (recorder.state === 'recording') recorder.pause(); else recorder.resume();
    renderRecorder();
  });
  $('rec-stop').addEventListener('click', async () => {
    const lines = recorder.rec.lines;
    const blob = await recorder.stop();
    if (blob) download(blob, recorder.fileName);
    toast('Saved ' + lines + ' lines to ' + recorder.fileName);
    renderRecorder();
  });

  function renderRecorder() {
    const st = recorder.state;
    const label = { idle: 'Not recording', recording: 'Recording', paused: 'Paused' }[st];
    $('rec-state').textContent = label;
    $('rec-state').className = 'rec-state ' + st;
    $('rec-start').disabled = st !== 'idle';
    $('rec-pause').disabled = st === 'idle';
    $('rec-pause').textContent = st === 'paused' ? 'Resume' : 'Pause';
    $('rec-stop').disabled = st === 'idle';
    const r = recorder.rec;
    const rxs = Object.keys(r.perRx);
    if (st === 'idle') {
      $('rec-info').innerHTML = recorder.fileName ? 'Last: ' + esc(recorder.fileName) : '';
      $('rec-info').title = '';
      return;
    }
    const secs = Math.floor(recorder.elapsedMs(Date.now()) / 1000);
    const hms = [Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60].map((n) => String(n).padStart(2, '0')).join(':');
    $('rec-info').innerHTML = '<b>' + hms + '</b>  ' + r.packets + ' packets from ' + rxs.length + (rxs.length === 1 ? ' receiver' : ' receivers');
    $('rec-info').title = 'File: ' + recorder.fileName + '\n' + rxs.map((k) => rxName(k) + ': ' + r.perRx[k].packets + ' packets, ' + r.perRx[k].lines + ' lines').join('\n') +
      (recorder.error ? '\nWrite error: ' + recorder.error : '');
  }

  $('btn-save').addEventListener('click', () => {
    download(recorder.sessionBlob(), settings.fileTag + '-session-' + stamp() + '.log');
    toast('Saved ' + recorder.lines + ' lines');
  });

  window.addEventListener('beforeunload', (e) => {
    if (recorder.state !== 'idle' || live.total > 0) { e.preventDefault(); e.returnValue = ''; }
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

  // ?log=<url> replays a file without anyone clicking Open log, so pulling a chip can
  // be one command that ends with the dashboard already showing it. Repeatable:
  // ?log=a&log=b merges them the way opening both files does.
  async function openFromUrl() {
    const urls = new URLSearchParams(location.search).getAll('log');
    if (!urls.length) return;
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const parsed = [];
    const names = [];
    for (const u of urls) {
      try {
        const r = await fetch(u);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const name = (u.split('?')[0].split(/[\\/]/).pop()) || 'log';
        parsed.push(R.parseLogFile(await r.text(), name, midnight.getTime()));
        names.push(name);
      } catch (err) {
        // A bad link leaves a working dashboard and says why, rather than a blank page.
        toast('Could not open ' + u + ': ' + (err.message || err));
      }
    }
    const events = R.mergeFiles(parsed);
    if (!events.length) return;
    startReplay(events, names);
  }
  openFromUrl();

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
  $('sel-unit').addEventListener('change', (e) => { view.sel = e.target.value; render(true); });
  $('btn-hide').addEventListener('click', () => {
    if (view.sel === null) return;
    fleet().hidden.add(Number(view.sel)); toast('Hid CSID ' + view.sel); view.sel = null; render(true);
  });
  $('btn-restore').addEventListener('click', () => { fleet().hidden.clear(); render(true); });
  // ---------- clearing ----------
  // Everything is on the page: tick what should go, press Clear. Nothing here touches
  // lines already written to disk unless a new log file is asked for.
  const clearBoxes = { units: 'cl-units', sel: 'cl-sel', rx: 'cl-rx', hidden: 'cl-hidden', log: 'cl-log' };
  const clearWanted = () => Object.fromEntries(Object.entries(clearBoxes).map(([k, id]) => [k, $(id).checked]));

  function renderClear() {
    const w = clearWanted();
    const bits = [];
    if (w.sel && view.sel) bits.push('CSID ' + view.sel);
    else if (w.units) bits.push('all units');
    if (w.rx) bits.push('receiver counts');
    if (w.hidden) bits.push('hidden');
    if (w.log) bits.push('new log file');
    $('clear-what').textContent = bits.length ? bits.join(', ') : 'nothing ticked';
    $('btn-clear').disabled = !bits.length;
  }
  for (const id of Object.values(clearBoxes)) $(id).addEventListener('change', renderClear);

  $('btn-clear').addEventListener('click', async () => {
    const w = clearWanted();
    const f = fleet();
    const done = [];
    if (w.sel && view.sel) {
      const label = view.sel;
      if (f.clearUnit(label)) { done.push('CSID ' + label); view.sel = null; }
    } else if (w.units) {
      f.clearUnits(); view.sel = null; view.expanded.clear(); done.push('every unit');
    }
    if (w.rx) { f.clearReceivers(); done.push('receiver counts'); }
    if (w.hidden) { f.hidden.clear(); done.push('hidden units'); }
    if (w.log) {
      try {
        const j = await hub.rotateLog();
        done.push('new log ' + (j.log || '').split(/[\\/]/).pop());
      } catch (err) {
        toast('Could not start a new log: ' + (err.message || err));
      }
    }
    toast(done.length ? 'Cleared ' + done.join(', ') : 'Nothing to clear');
    render(true);
  });

  $('fleet').querySelector('tbody').addEventListener('click', (e) => {
    const merge = e.target.getAttribute('data-merge');
    if (merge) {
      const into = fleet().mergeRun(merge);
      if (into) {
        toast('Merged ' + merge + ' into ' + into);
        if (view.sel === merge) view.sel = into;
      }
      render(true);
      return;
    }
    const mergeAll = e.target.getAttribute('data-mergeall');
    if (mergeAll) {
      const n = fleet().mergeAllRuns(Number(mergeAll));
      toast(n ? 'Joined ' + n + (n === 1 ? ' earlier run' : ' earlier runs') + ' into CSID ' + mergeAll : 'Nothing to join');
      view.sel = String(mergeAll);
      render(true);
      return;
    }
    const drop = e.target.getAttribute('data-drop');
    if (drop) {
      if (fleet().clearUnit(drop)) toast('Deleted run ' + drop);
      if (view.sel === drop) view.sel = null;
      render(true);
      return;
    }
    const more = e.target.getAttribute('data-gens');
    if (more) {
      // Folding away a board that opened itself has to be remembered, or it reopens.
      const auto = fleet().earlierRuns(Number(more)).length <= AUTO_OPEN_RUNS;
      const isOpen = view.expanded.has(more) || (auto && !view.expanded.has('shut' + more));
      view.expanded.delete(more); view.expanded.delete('shut' + more);
      if (isOpen) view.expanded.add('shut' + more); else view.expanded.add(more);
      render(true);
      return;
    }
    const tr = e.target.closest('tr');
    if (tr && tr.dataset.label) { view.sel = tr.dataset.label; render(true); }
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

  function bits(mask) {
    return '<span class="bits">' + P.VALIDITY_BITS.map((b) => {
      const on = (mask >> b.bit) & 1;
      return '<span class="' + (on ? '' : 'off') + '" title="' + b.name + (on ? ' valid' : ' NOT valid') + '">' + b.short + '</span>';
    }).join('') + '</span>';
  }

  const STATE_LABEL = { OK: 'OK', STALE: 'Stale', LOST: 'Lost' };
  const stateHtml = (st) => '<span class="state ' + st + '">' + STATE_LABEL[st] + '</span>';

  function renderSummary(f, t) {
    const s = f.summary(t);
    // Always: how many units and packets. Problems: only when there are some.
    const base = [['heard', s.heard], ['active', s.active], ['packets', s.packets]]
      .map(([k, v]) => '<span><b>' + v + '</b> ' + k + '</span>');
    const issues = [
      ['stale', s.stale, ''], ['lost', s.lost, 'bad'], ['bad CRC', s.badCrc, 'bad'], ['low battery', s.lowBattery, ''],
      ['with invalid sensors', s.validityIssues, ''], ['weak RF', s.weakRf, ''], ['saturated', s.saturated, ''], ['resets', s.resets, ''],
    ].filter(([, v]) => v > 0).map(([k, v, c]) => '<span class="issue ' + c + '"><b>' + v + '</b> ' + k + '</span>');
    $('summary').innerHTML = base.concat(issues).join('');
  }

  function ageCell(f, u, a) {
    const limit = f.staleAfterMs(u);
    const frac = Math.min(1, a / limit);
    const cls = a > limit ? 'over' : frac > 0.66 ? 'near' : '';
    return '<span class="age" title="Stale after ' + fmt(limit / 1000, 1) + ' s without a packet">' + age(a) +
      '<i><b class="' + cls + '" style="width:' + (a > limit ? 100 : Math.max(2, frac * 100)).toFixed(0) + '%"></b></i></span>';
  }

  function battCell(d) {
    if (!d.valid.soc) return '<span class="muted">—</span>';
    const pct = Math.max(0, Math.min(100, d.values.battery));
    return '<span class="batt' + (pct < settings.lowBatteryPct ? ' low' : '') + '"><i><b style="width:' + pct.toFixed(0) + '%"></b></i>' + fmt(pct, 1) + '%</span>';
  }

  // An earlier run of a board, shown under the live one. Deliberately thin: it is
  // history, and the row that matters is the one still transmitting.
  const AUTO_OPEN_RUNS = 3;

  // The Runs tab. A board's counter starts again from 0 every time it restarts, so its
  // data is kept as separate runs. This is where they are put back together when the
  // restart was an accident, and thrown away when the run was rubbish.
  function renderRuns(el, unit) {
    if (!unit) { el.innerHTML = '<p class="empty">Select a unit in the fleet list.</p>'; return; }
    const f = fleet();
    const csid = unit.csid;
    const live = f.units.get(csid);
    const earlier = f.earlierRuns(csid);
    const all = earlier.concat(live ? [live] : []);
    const t = now();

    const head = '<p class="note">CSID ' + csid + ' has ' + (all.length === 1 ? 'one run' : all.length + ' runs') +
      '. A run ends when the board restarts and its counter goes back to 0. ' +
      (earlier.length ? 'If a restart was an accident, join the runs back together.' : 'Nothing to join.') + '</p>' +
      (earlier.length > 1 ? '<p><button id="runs-joinall" class="primary">Join all ' + all.length + ' runs into one</button></p>' : '');

    const rows = all.map((u) => {
      const span = u.firstT === null ? '—' : age(u.lastT - u.firstT);
      const when = u.firstT === null ? '' : new Date(u.firstT).toLocaleTimeString() + ' to ' + new Date(u.lastT).toLocaleTimeString();
      const joinable = !u.live;
      return '<div class="runrow' + (u.label === view.sel ? ' sel' : '') + '">' +
        '<div class="runhead"><b data-pick="' + u.label + '">' + u.label + '</b>' +
        (u.boot !== null && u.boot !== undefined ? '<span class="muted">boot ' + esc(u.boot) + '</span>' : '') +
        (u.live ? '<span class="st good">transmitting now</span>' : '<span class="muted">earlier run</span>') + '</div>' +
        '<div class="note">' + u.packets + ' packets, ' + u.missed + ' missed, ran for ' + span +
          (when ? ' — ' + esc(when) : '') + '</div>' +
        '<div class="setup-actions">' +
          (joinable ? '<button data-merge="' + u.label + '" class="primary">Join into the next run</button>' : '') +
          '<button data-drop="' + u.label + '">Delete this run</button>' +
        '</div></div>';
    }).join('');
    el.innerHTML = '<div class="runs">' + head + rows + '</div>';
  }

  function restoreTyping(caret) {
    if (!caret) return;
    const box = $('setup-body').querySelector('[data-name="' + caret[0].replace(/"/g, '\\"') + '"]');
    if (!box) return;
    box.value = caret[1];
    box.focus();
    try { box.setSelectionRange(caret[2], caret[2]); } catch (e) { /* not a text box any more */ }
  }

  function earlierRow(f, u, t, rxTotal) {
    const span = u.firstT === null ? '—' : age(u.lastT - u.firstT);
    return '<tr class="gen' + (u.label === view.sel ? ' sel' : '') + '" data-label="' + u.label + '">' +
      // Actions go in the first cell. The fleet table is fourteen columns wide and
      // scrolls sideways, so anything in the last cell is off the edge of the window.
      '<td class="csid">' + u.label +
        ' <button data-merge="' + u.label + '" class="act" title="It was not really a new run: join it to the one after it">join</button>' +
        ' <button data-drop="' + u.label + '" class="act" title="Throw this run away">delete</button></td>' +
      '<td><span class="muted">earlier run</span></td>' +
      '<td class="r muted" title="Ended ' + esc(new Date(u.lastT).toLocaleString()) + '">' + age(t - u.lastT) + ' ago</td>' +
      '<td class="r muted">' + u.lastCounter + '</td>' +
      '<td class="r">' + u.packets + '</td>' +
      '<td class="r' + (u.missed ? '' : ' muted') + '">' + u.missed + '</td>' +
      '<td class="r muted">' + fmt(f.rxPercent(u), 1) + '</td>' +
      '<td class="r muted">—</td>' +
      '<td class="muted">ran for ' + span + '</td>' +
      '<td colspan="5" class="muted">ended ' + esc(new Date(u.lastT).toLocaleTimeString()) + '</td>' +
      '</tr>';
  }

  function renderFleet(f, t) {
    const rows = f.rows(t, view.sort);
    if (view.sel === null || !f.unit(view.sel) || f.hidden.has(Number(view.sel))) view.sel = rows.length ? rows[0].unit.label : null;
    $('fleet-empty').hidden = rows.length > 0;
    const rxTotal = [...f.receivers.values()].filter((r) => r.packets > 0).length;
    $('fleet').querySelector('tbody').innerHTML = rows.map(({ unit: u, state, age: a }) => {
      const d = u.latest;
      const rssiCls = u.bestRssi < settings.weakRssiDbm ? ' serious' : '';
      const earlier = f.earlierRuns(u.csid);
      // One or two earlier runs is the bench case: a knocked cable, and the operator
      // wants to join them. Show them without making anyone find a button first.
      // Thirty of them is a night of logs, which stays folded.
      const open = view.expanded.has(String(u.csid)) ||
        (earlier.length <= AUTO_OPEN_RUNS && !view.expanded.has('shut' + u.csid));
      return '<tr data-label="' + u.label + '"' + (u.label === view.sel ? ' class="sel"' : '') + '>' +
        '<td class="csid">' + u.label +
          (earlier.length ? ' <button class="act" data-gens="' + u.csid + '" title="Runs of this board that ended when it restarted">' +
            (open ? 'hide' : earlier.length + ' earlier') + '</button>' : '') +
          // While they are on screen each run has its own join, so this one would be a
          // second way to do the same thing. It is for the folded case.
          (earlier.length && !open ? ' <button class="act" data-mergeall="' + u.csid + '" title="It was one run really: put every earlier run back into this one">' +
            (earlier.length === 1 ? 'join it' : 'join all') + '</button>' : '') + '</td>' +
        '<td>' + stateHtml(state) + (d.saturated ? '<span class="flag" title="Acceleration near the accelerometer limit">saturated</span>' : '') + '</td>' +
        '<td class="r">' + ageCell(f, u, a) + '</td>' +
        '<td class="r">' + u.lastCounter + '</td>' +
        '<td class="r">' + u.packets + '</td>' +
        // Off a chip there is no link and no transmission counter to reason from, so
        // these say nothing rather than saying something wrong.
        '<td class="r' + (u.fromChip || !u.missed ? ' muted' : '') + '">' + (u.fromChip ? '—' : u.missed) + '</td>' +
        '<td class="r' + (u.fromChip ? ' muted' : '') + '">' + (u.fromChip ? '—' : fmt(f.rxPercent(u), 1)) + '</td>' +
        '<td class="r' + (u.fromChip || !u.resets ? ' muted' : ' serious') + '">' + (u.fromChip ? '—' : u.resets) + '</td>' +
        '<td>' + battCell(d) + '</td>' +
        '<td>' + bits(d.values.validity) + '</td>' +
        '<td class="r' + rssiCls + '">' + fmt(u.bestRssi, 1) + '</td>' +
        '<td class="r">' + fmt(u.bestSnr, 1) + '</td>' +
        '<td class="r">' + (Number.isFinite(u.intervalMs) ? fmt(u.intervalMs / 1000, u.intervalMs < 10000 ? 2 : 0) + ' s' : '—') + '</td>' +
        '<td class="r" title="' + esc(u.receptions.map((r) => rxName(r.rx) + ': ' + fmt(r.rssi, 1) + ' dBm').join('\n')) + '">' + u.receptions.length + ' of ' + rxTotal + '</td>' +
        '</tr>' + (open ? earlier.map((g) => earlierRow(f, g, t, rxTotal)).join('') : '');
    }).join('');
    const sel = $('sel-unit');
    const want = [...f.allUnits().values()]
      .sort((a, b) => (a.csid - b.csid) || (b.live - a.live) || (a.gen - b.gen))
      .map((u) => '<option value="' + u.label + '">CSID ' + u.label + (u.live ? '' : ' (earlier run)') + '</option>')
      .join('');
    if (sel.dataset.sig !== want) { sel.innerHTML = want; sel.dataset.sig = want; }
    if (view.sel !== null) sel.value = view.sel;
  }

  // One list row. A field whose validity bit is clear shows the last trusted
  // value in muted ink, or — if there never was one.
  function fieldRow(u, label, key, dec, unit) {
    const fd = P.FIELDS.find((x) => x.key === key);
    const d = u.latest;
    let v;
    if (d.valid[fd.group]) {
      const sat = fd.group === 'accel' && Math.abs(d.values[key]) >= settings.saturationMps2;
      v = '<dd class="v' + (sat ? ' sat' : '') + '"' + (sat ? ' title="Near the accelerometer limit"' : '') + '>' + fmt(d.values[key], dec) + '</dd>';
    } else {
      const lv = u.lastValid[key];
      v = '<dd class="v stale" title="Not valid in this packet' + (lv !== undefined ? '. Last trusted value shown.' : '') + '">' + (lv !== undefined ? fmt(lv, dec) : '—') + '</dd>';
    }
    return '<dt>' + label + '</dt>' + v + '<dd class="u">' + unit + '</dd>';
  }
  const plainRow = (label, value, unit, cls) => '<dt>' + label + '</dt><dd class="v ' + (cls || '') + '">' + value + '</dd><dd class="u">' + (unit || '') + '</dd>';

  function list(title, rows, group, d) {
    const note = group && !d.valid[group] ? ' <span class="note bad">not valid</span>' : '';
    return '<section class="list"><h3>' + title + note + '</h3><dl>' + rows.join('') + '</dl></section>';
  }

  function renderLatest(f, t) {
    if (view.paused) return;
    const u = view.sel === null ? null : f.unit(view.sel);
    const el = $('latest');
    if (!u) { el.innerHTML = '<div class="none">Select a unit in the fleet list.</div>'; return; }
    const d = u.latest;
    const st = f.state(u, t);
    const crcOk = d.crcOk
      ? '<span class="good" title="' + (u.latestSource === 'csv' ? 'Old CSV receiver: packet rebuilt from the printed values to check the CRC' : 'CRC matches') + '">pass</span>'
      : '<span class="bad">fail</span>';
    const rx = u.receptions.map((r) => plainRow(esc(rxName(r.rx)), fmt(r.rssi, 1) + ' / ' + fmt(r.snr, 1), 'dBm/dB'));
    el.innerHTML =
      '<div class="unit-head"><span class="id"><small>CSID</small>' + u.csid + '</span>' + stateHtml(st) +
        (d.saturated ? '<span class="flag">accel saturated</span>' : '') +
        '<span class="when"><b>' + new Date(u.lastT).toTimeString().slice(0, 8) + '</b>' + age(t - u.lastT) + ' ago</span></div>' +
      '<div class="validity-line">' + bits(d.values.validity) + '<span class="hex">0x' + d.values.validity.toString(16).toUpperCase().padStart(2, '0') + '</span></div>' +
      '<div class="lists">' +
        list('Link', [
          plainRow('Counter', d.values.counter),
          plainRow('Battery', d.valid.soc ? fmt(d.values.battery, 1) : '—', '%', d.valid.soc ? '' : 'stale'),
          plainRow('Interval', Number.isFinite(u.intervalMs) ? fmt(u.intervalMs / 1000, 2) : '—', 's'),
          plainRow('CRC', crcOk + ' <span class="hex muted">' + d.crcReceived.toString(16).toUpperCase().padStart(4, '0') + '</span>'),
          plainRow('Packets', u.packets), plainRow('Missed', u.missed), plainRow('Resets', u.resets),
          plainRow('Received', fmt(f.rxPercent(u), 1), '%'),
        ].concat(rx)) +
        list('GPS', [fieldRow(u, 'Latitude', 'lat', 6, '°'), fieldRow(u, 'Longitude', 'lon', 6, '°'), fieldRow(u, 'Altitude MSL', 'gpsAlt', 1, 'm')], 'gps', d) +
        list('Environment', [fieldRow(u, 'Temperature', 'temp', 2, '°C'), fieldRow(u, 'Pressure', 'pressure', 1, 'hPa'),
          fieldRow(u, 'Humidity', 'humidity', 1, '%'), fieldRow(u, 'Pressure altitude', 'envAlt', 1, 'm')], 'env', d) +
        list('Accelerometer', ['x', 'y', 'z'].map((a) => fieldRow(u, a.toUpperCase(), 'a' + a, 2, 'm/s²')), 'accel', d) +
        list('Gyroscope', ['x', 'y', 'z'].map((a) => fieldRow(u, a.toUpperCase(), 'g' + a, 1, 'deg/s')), 'gyro', d) +
        list('Magnetometer', ['x', 'y', 'z'].map((a) => fieldRow(u, a.toUpperCase(), 'm' + a, 1, 'µT')), 'mag', d) +
        list('Orientation', [['i', 'qi'], ['j', 'qj'], ['k', 'qk'], ['Real', 'qr']].map(([l, k]) => fieldRow(u, l, k, 4, '')), 'quat', d) +
      '</div>';
  }

  // Values 7-12 are what we fly. A board reporting anything else keeps its own number
  // rather than showing the nearest option, since this select is the board's truth.
  function sfSelect(k, sf) {
    const values = [7, 8, 9, 10, 11, 12];
    if (!values.includes(Number(sf))) values.push(Number(sf));
    const opts = values.sort((a, b) => a - b)
      .map((n) => '<option value="' + n + '"' + (n === Number(sf) ? ' selected' : '') + '>SF' + n + '</option>').join('');
    return '<select data-sf="' + esc(k) + '" aria-label="Spreading factor on ' + esc(k) + '">' + opts + '</select>';
  }

  function renderReceivers() {
    // The strip redraws every 250 ms, which would shut an open select under the operator.
    const focus = document.activeElement;
    if (focus && focus.tagName === 'SELECT' && $('receivers').contains(focus)) return;
    const f = fleet();
    const t = now();
    const keys = new Set([...f.receivers.keys(), ...hub.ports.map((p) => p.key)]);
    $('receivers').innerHTML = [...keys].map((k) => {
      const r = f.receivers.get(k);
      const port = hub.ports.find((p) => p.key === k);
      const m = meta(k);
      let st = 'no data'; let cls = 'warning';
      if (port && port.status !== 'open') { st = port.status; cls = 'critical'; } else if (r && t - r.lastT < 7000) { st = 'live'; cls = 'good'; } else if (r) { st = 'quiet for ' + age(t - r.lastT); }
      const kind = m.source === 'csv' ? 'CSV firmware' : m.source === 'raw' ? 'raw firmware' : '';
      const detail = [kind, r && r.info.sf ? 'SF' + r.info.sf : '', r ? r.unique + ' new, ' + (r.packets - r.unique - r.badCrc) + ' duplicate' : '',
        r && r.badCrc ? r.badCrc + ' bad CRC' : '', r && r.radioErrors ? r.radioErrors + ' radio errors' : '', port && port.usb ? 'USB ' + port.usb : '', port && port.error ? port.error : '']
        .filter(Boolean).join('\n');
      return '<span class="rx" title="' + esc(detail) + '">' +
        '<span class="sw" style="background:var(--series-' + (m.index + 1) + ')"></span>' +
        '<span class="name">' + esc(rxName(k)) + '</span><span class="st ' + cls + '">' + st + '</span>' +
        (r ? '<span class="meta">' + r.unique + ' packets</span>' : '') +
        (hub.native && r && r.info.sf ? sfSelect(k, r.info.sf) : '') +
        (port && port.status === 'open' ? '<button data-close="' + k + '" title="Disconnect" aria-label="Disconnect ' + esc(k) + '">✕</button>' : '') + '</span>';
    }).join('');
    // Lines that did not come off a radio. Said plainly, because an absent RSSI is an
    // absence and not a fault, and a screenshot of a replay should not read as live.
    for (const [rx, src] of fleet().sources) {
      const what = src.kind === 'flash' ? 'Flash dump' : (src.kind || 'Not a radio');
      const bits = [src.from, src.boot ? 'boot ' + src.boot : '', src.packets ? src.packets + ' records' : '']
        .filter(Boolean).join(', ');
      // Anything not anchored to GPS is a derived time, however it was derived, and
      // once it is epoch milliseconds it looks exactly like a real one. Tested the
      // other way round on purpose: a new kind of derived time must not slip through
      // by not being on a list.
      const guessed = !!src.time_source && src.time_source !== 'anchor';
      const when = guessed ? '\nTimes are not from GPS (' + src.time_source + '), so the time axis is derived.'
        : (src.anchor_utc ? '\nTime anchored at ' + src.anchor_utc +
            (src.anchor_tacc_ns ? ' (receiver accuracy ' + src.anchor_tacc_ns + ' ns)' : '') : '');
      $('receivers').insertAdjacentHTML('beforeend', '<span class="rx" title="' +
        esc('No RSSI or SNR: these lines came off a chip, not a radio.' + when) +
        '"><span class="name">' + esc(rx) + '</span><span class="st warning">' + esc(what) + '</span>' +
        (bits ? '<span class="meta">' + esc(bits) + '</span>' : '') +
        (guessed ? '<span class="st serious">times not from GPS</span>' : '') + '</span>');
    }
    offerSetupOnce();
    renderClear();
    // Two spreading factors is the normal setup for a test: the LE boards are on SF9, the HP
    // boards on SF12, and one receiver hears only one of them.
    const onSf = [...f.receivers.entries()].filter(([, r]) => r.info.sf);
    if (new Set(onSf.map(([, r]) => r.info.sf)).size > 1) {
      $('receivers').insertAdjacentHTML('beforeend', '<span class="rx"><span class="meta">' +
        esc(onSf.map(([k, r]) => rxName(k) + ' on SF' + r.info.sf).join(', ')) + '</span></span>');
    }
    $('mode').textContent = view.replay ? 'Replaying ' + view.replay.names.join(', ') : (recorder.lines ? recorder.lines + ' lines this session' : '');
  }
  $('receivers').addEventListener('click', (e) => {
    const k = e.target.dataset.close;
    const p = k && hub.ports.find((x) => x.key === k);
    if (p) hub.close(p);
  });
  $('receivers').addEventListener('change', (e) => {
    const k = e.target.dataset.sf;
    if (!k) return;
    const sf = Number(e.target.value);
    // Back to whatever the board last reported; the select settles when its next header arrives.
    e.target.blur();
    renderReceivers();
    hub.setSf(k, sf).then(() => toast('Asked ' + rxName(k) + ' for SF' + sf))
      .catch((err) => toast('Could not set SF: ' + (err.message || err)));
  });

  const charts = new DG.Charts($('charts'), $('tabs'), (k) => ({ label: rxName(k), index: meta(k).index }));
  charts.custom = renderRuns;

  // The Runs tab owns its own buttons; the fleet table's copies do the same work.
  $('charts').addEventListener('click', (e) => {
    const merge = e.target.getAttribute('data-merge');
    const drop = e.target.getAttribute('data-drop');
    const pick = e.target.getAttribute('data-pick');
    const f = fleet();
    if (e.target.id === 'runs-joinall') {
      const u = view.sel === null ? null : f.unit(view.sel);
      if (u) { const n = f.mergeAllRuns(u.csid); view.sel = String(u.csid); toast('Joined ' + n + ' earlier ' + (n === 1 ? 'run' : 'runs')); }
    } else if (merge) {
      const into = f.mergeRun(merge);
      if (into) { toast('Joined ' + merge + ' into ' + into); if (view.sel === merge) view.sel = into; }
    } else if (drop) {
      if (f.clearUnit(drop)) toast('Deleted run ' + drop);
      if (view.sel === drop) view.sel = null;
    } else if (pick) {
      view.sel = pick;
    } else {
      return;
    }
    render(true);
  });
  let lastChart = 0;

  function render(force) {
    const f = fleet();
    const t = now();
    renderSummary(f, t);
    renderFleet(f, t);
    renderLatest(f, t);
    renderReceivers();
    renderRecorder();
    if (force || Date.now() - lastChart > 500) {
      lastChart = Date.now();
      const u = view.sel === null ? null : f.unit(view.sel);
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
