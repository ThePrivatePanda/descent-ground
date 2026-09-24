// Web Serial: any number of T-Beam receivers, one line at a time.
// Each port gets a key (rx1, rx2, ...) that stays with it for the session.
(function (root) {
  'use strict';

  const BAUD = 115200;

  class SerialHub {
    // onLine(rxKey, text), onChange() whenever a port opens, closes or errors.
    constructor(onLine, onChange) {
      this.onLine = onLine;
      this.onChange = onChange;
      this.ports = [];   // {key, port, status, error, usb}
      this.next = 1;
      this.supported = 'serial' in navigator;
      if (this.supported) {
        navigator.serial.addEventListener('disconnect', (e) => {
          const p = this.ports.find((x) => x.port === e.target);
          if (p) { p.status = 'unplugged'; this.onChange(); }
        });
        navigator.serial.addEventListener('connect', (e) => {
          const p = this.ports.find((x) => x.port === e.target);
          if (p && p.status === 'unplugged') this.open(p);
        });
      }
    }

    async add() {
      const port = await navigator.serial.requestPort();
      let p = this.ports.find((x) => x.port === port);
      if (p && p.status === 'open') return p;
      if (!p) {
        const info = port.getInfo();
        p = { key: 'rx' + this.next++, port, status: 'new', error: null,
          usb: info.usbVendorId ? info.usbVendorId.toString(16).padStart(4, '0') + ':' + info.usbProductId.toString(16).padStart(4, '0') : '' };
        this.ports.push(p);
      }
      await this.open(p);
      return p;
    }

    async open(p) {
      try {
        await p.port.open({ baudRate: BAUD, bufferSize: 65536 });
      } catch (err) {
        if (!/already open/i.test(String(err))) {
          p.status = 'error'; p.error = String(err.message || err); this.onChange(); return;
        }
      }
      p.status = 'open'; p.error = null; this.onChange();
      this.read(p);
    }

    async read(p) {
      const decoder = new TextDecoder();
      let buffer = '';
      while (p.port.readable && p.status === 'open') {
        p.reader = p.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await p.reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              this.onLine(p.key, line);
            }
            if (buffer.length > 8192) buffer = ''; // runaway line without newline
          }
        } catch (err) {
          p.error = String(err.message || err);
        } finally {
          p.reader.releaseLock();
          p.reader = null;
        }
      }
      if (p.status === 'open') p.status = 'closed';
      this.onChange();
    }

    // No app process here, so there is no log file on disk to roll over.
    async rotateLog() {
      throw new Error('only the app writes a log file; this page is not the app');
    }

    async close(p) {
      p.status = 'closing';
      try { if (p.reader) await p.reader.cancel(); } catch (e) { /* already gone */ }
      try { await p.port.close(); } catch (e) { /* already closed */ }
      p.status = 'closed';
      this.onChange();
    }
  }

  (root.DG = root.DG || {}).SerialHub = SerialHub;
})(self);
