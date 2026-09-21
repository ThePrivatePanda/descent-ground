// Recording and log files.
// Our log format: a "# descent-ground log v1" header, then one line per
// received line: <unix ms> TAB <receiver> TAB <text exactly as received>.
// Old lab logs (Arduino Serial Monitor, optional "HH:MM:SS.mmm -> " prefix)
// open too; their times are time-of-day only.
(function (root, factory) {
  const L = typeof require === 'function' ? require('./lines.js') : root.DG.lines;
  const mod = factory(L);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.DG = root.DG || {}).recorder = mod;
})(typeof self !== 'undefined' ? self : this, function (L) {
  'use strict';

  const HEADER = '# descent-ground log v1';

  function formatLine(t, rx, text) {
    return t + '\t' + rx + '\t' + text.replace(/[\r\n\t]/g, ' ') + '\n';
  }

  // Parse one file into [{t, rx, text}] sorted by time.
  // baseMs: midnight used for time-of-day logs.
  function parseLogFile(content, name, baseMs) {
    const lines = content.replace(/^﻿/, '').split(/\r?\n/);
    const out = [];
    if (lines[0].startsWith(HEADER)) {
      for (const l of lines.slice(1)) {
        const a = l.indexOf('\t'); const b = l.indexOf('\t', a + 1);
        if (a < 0 || b < 0) continue;
        const t = Number(l.slice(0, a));
        if (Number.isFinite(t)) out.push({ t, rx: l.slice(a + 1, b), text: l.slice(b + 1) });
      }
      return out;
    }
    const rx = name.replace(/\.[^.]*$/, '');
    let day = 0; let prev = null; let t = baseMs; let n = 0;
    for (const l of lines) {
      if (!l.trim()) continue;
      const ev = L.parseLine(l);
      if (ev.clock !== null) {
        if (prev !== null && ev.clock < prev - 12 * 3600e3) day++;
        prev = ev.clock;
        t = baseMs + ev.clock + day * 86400e3;
      } else if (prev === null) {
        t = baseMs + 1000 * n++;   // no timestamps at all: assume 1 line per second
      }
      out.push({ t, rx, text: l });
    }
    return out;
  }

  function mergeFiles(parsed) {
    return [].concat(...parsed).sort((a, b) => a.t - b.t);
  }

  // Live capture: everything is kept in memory for "Save session"; while
  // recording, lines are also streamed to a file the user picked.
  class Recorder {
    constructor() {
      this.session = [HEADER + ' started ' + new Date().toISOString() + '\n'];
      this.writable = null;
      this.pending = '';
      this.fileName = null;
      this.lines = 0;
    }
    add(t, rx, text) {
      const s = formatLine(t, rx, text);
      this.session.push(s);
      this.lines++;
      if (this.writable) this.pending += s;
    }
    canStream() { return typeof showSaveFilePicker === 'function'; }
    async start() {
      this.handle = await showSaveFilePicker({
        suggestedName: 'descent-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.log',
        types: [{ description: 'DeSCENT log', accept: { 'text/plain': ['.log'] } }],
      });
      this.fileName = this.handle.name;
      this.size = 0;
      this.writable = true;
      this.pending = HEADER + ' started ' + new Date().toISOString() + '\n';
      await this.flush();
      this.timer = setInterval(() => this.flush().catch((e) => { this.error = String(e); }), 5000);
    }
    // A file writer only reaches the real file on close(), so every flush
    // opens, appends and closes. A crash loses at most one interval.
    async flush() {
      if (!this.writable || !this.pending || this.flushing) return;
      this.flushing = true;
      const chunk = new TextEncoder().encode(this.pending); this.pending = '';
      try {
        const w = await this.handle.createWritable({ keepExistingData: true });
        await w.seek(this.size);
        await w.write(chunk);
        await w.close();
        this.size += chunk.length;
      } finally { this.flushing = false; }
    }
    async stop() {
      clearInterval(this.timer);
      await this.flush();
      this.writable = null;
    }
    sessionBlob() { return new Blob(this.session, { type: 'text/plain' }); }
  }

  return { HEADER, formatLine, parseLogFile, mergeFiles, Recorder };
});
