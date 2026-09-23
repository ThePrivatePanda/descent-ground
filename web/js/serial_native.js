// The native app reads the ports itself and pushes lines over a WebSocket.
// Same shape as SerialHub, so app.js does not care which one it got.
(function (root, factory) {
  const mod = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else Object.assign(root.DG = root.DG || {}, mod);
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  const RETRY_MS = 1000;

  // The whole transport rule. Not a fetch probe: from file:// a probe rejects instead of
  // answering, and app.js builds its hub synchronously.
  function isNativeHost(loc) {
    return loc.protocol === 'http:' && (loc.hostname === '127.0.0.1' || loc.hostname === 'localhost');
  }

  // One WebSocket frame. Boot noise or half a message must not take the socket down.
  function makeFrameHandler(onLine, onPorts, onFlash) {
    return function (data) {
      let m;
      try { m = JSON.parse(data); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'line') onLine(m.rx, m.text);
      else if (m.type === 'ports') onPorts();
      else if (m.type === 'flash' && onFlash) onFlash(m);
    };
  }

  class NativeHub {
    // onLine(rxKey, text), onChange() whenever a port opens, closes or errors.
    // note(msg) is only used if this turns out not to be our app after all.
    constructor(onLine, onChange, note) {
      this.onLine = onLine;
      this.onChange = onChange;
      this.note = note || function () {};
      this.found = [];   // {key, status, error, usb}
      this.boards = []; // every usb serial port, and what we do about it
      this.log = null;
      this.web = null;   // a SerialHub, once we know the server on this port is not ours
      this.onFlash = null;   // the setup panel sets this while it is open
      this.frame = makeFrameHandler(onLine, () => this.refresh(), (m) => { if (this.onFlash) this.onFlash(m); });
      this.refresh();
      this.connect();
    }

    get ports() { return this.web ? this.web.ports : this.found; }
    get native() { return !this.web; }
    get supported() { return this.web ? this.web.supported : true; }

    connect() {
      if (this.web) return;
      const ws = new WebSocket('ws://' + location.host + '/api/stream');
      ws.onmessage = (e) => this.frame(e.data);
      // The app outlives the tab and can be restarted under it, so keep trying.
      ws.onclose = () => setTimeout(() => this.connect(), RETRY_MS);
      ws.onopen = () => this.refresh();
      this.ws = ws;
    }

    async refresh() {
      try {
        const r = await fetch('/api/ports');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (!Array.isArray(j.ports)) throw new Error('not our /api/ports');
        this.found = j.ports;
        this.boards = j.boards || [];
        this.log = j.log || null;
      } catch (err) {
        this.fall(err);
        return;
      }
      this.onChange();
    }

    // Some other local web server answered. Hand the page back to Web Serial rather than
    // leave it with no way to reach a receiver.
    fall(err) {
      if (this.web) return;
      this.found = [];
      this.web = new root.DG.SerialHub(this.onLine, this.onChange);
      try { if (this.ws) this.ws.close(); } catch (e) { /* never opened */ }
      this.note('No receivers here (' + (err.message || err) + '). Using the browser instead.');
      this.onChange();
    }

    // Discovery is automatic, so Connect is a rescan. Nothing found throws what a
    // cancelled Web Serial picker throws, which app.js already ignores.
    async add() {
      if (this.web) return this.web.add();
      await this.refresh();
      if (!this.ports.length) throw { name: 'NotFoundError', message: 'no receiver found' };
      return this.ports[0];
    }

    async close(p) {
      if (this.web) return this.web.close(p);
      await fetch('/api/receiver/' + p.key + '/close', { method: 'POST' });
      await this.refresh();
    }

    // Say what a board is. Until this, it is left alone: opening a port pulses DTR
    // and can reset whatever is on the other end, and the chip cannot tell a T-Beam
    // from a ChipSat. Remembered by board, so a replug needs no second answer.
    async setBoard(port, isReceiver) {
      const where = isReceiver ? '/api/board/receiver' : '/api/board/ignore';
      const r = await fetch(where, { method: 'POST', body: JSON.stringify({ port }) });
      const j = await r.json().catch(() => ({ ok: false }));
      if (!j.ok) throw new Error(j.error || 'HTTP ' + r.status);
      await this.refresh();
    }

    // Every T-Beam-shaped port, whether or not we are reading it: reflashing a
    // working receiver is the normal case.
    async candidates() {
      const r = await fetch('/api/flash/candidates');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }

    // Writes the firmware in the app unless image names a file on this machine.
    async flash(port, sf, image) {
      const body = { port, sf: Number(sf) };
      if (image) body.image = image;
      const r = await fetch('/api/flash', { method: 'POST', body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
      if (!j.ok) throw new Error(j.error || 'flash failed');
      return j;
    }

    async setSf(key, sf) {
      const r = await fetch('/api/receiver/' + key + '/config', {
        method: 'POST',
        body: JSON.stringify({ sf: Number(sf) }),
      });
      if (!r.ok) throw new Error('receiver refused SF' + sf + ' (HTTP ' + r.status + ')');
    }
  }

  function makeHub(onLine, onChange, note) {
    if (isNativeHost(location)) return new NativeHub(onLine, onChange, note);
    return new root.DG.SerialHub(onLine, onChange);
  }

  return { NativeHub, makeHub, makeFrameHandler, isNativeHost };
});
