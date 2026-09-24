// Turns one line of receiver output into an event.
// Understands:
//   - the raw receiver (receiver/DescentRawReceiver):  PKT, ERR, HB, #DG lines
//   - the old CSV receiver (V2_5_X_T_BEAM_DECODE_CSV): 35-column CSV + header
//   - a ChipSat console hex dump: 55 space-separated bytes
// Lines saved by the Arduino Serial Monitor carry an "HH:MM:SS.mmm -> " prefix;
// it is stripped and returned as clock.
(function (root, factory) {
  const P = typeof require === 'function' ? require('./packet.js') : root.DG.packet;
  const mod = factory(P);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.DG = root.DG || {}).lines = mod;
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  const CSV_COLUMNS = 35;
  const TIME_PREFIX = /^(\d{1,2}):(\d{2}):(\d{2})\.(\d{3})\s*(?:->)?\s*/;
  const HEX_DUMP = /^(?:[0-9A-Fa-f]{2}\s+){54}[0-9A-Fa-f]{2}$/;

  function num(s) {
    const v = Number(s);
    return s !== '' && Number.isFinite(v) ? v : NaN;
  }

  // Build a packet event from bytes; crcFromCsv marks a CSV-rebuilt packet.
  function packetEvent(source, bytes, rssi, snr, freqErr) {
    const decoded = P.decode(bytes);
    return {
      kind: decoded.ok ? 'packet' : 'badlength',
      source,
      bytes,
      hex: P.bytesToHex(bytes),
      decoded,
      rssi, snr, freqErr,
    };
  }

  function parseRaw(parts) {
    // PKT,<len>,<hex>,<rssi>,<snr>,<freqErr>
    const bytes = P.hexToBytes(parts[2] || '');
    if (!bytes) return { kind: 'other' };
    return packetEvent('raw', bytes, num(parts[3]), num(parts[4]), num(parts[5]));
  }

  function parseCsv(parts) {
    const values = {};
    for (let i = 0; i < P.FIELDS.length; i++) {
      const v = num(parts[i].trim());
      if (Number.isNaN(v)) return null;
      values[P.FIELDS[i].key] = v;
    }
    const crc = num(parts[32]);
    if (Number.isNaN(crc)) return null;
    const bytes = P.encode(values, crc);
    return packetEvent('csv', bytes, num(parts[33]), num(parts[34]), NaN);
  }

  function keyValues(parts) {
    const info = {};
    for (const p of parts) {
      const eq = p.indexOf('=');
      if (eq > 0) info[p.slice(0, eq)] = p.slice(eq + 1);
    }
    return info;
  }

  function parseDevice(parts) {
    // #DG,RX,v1,id=XXXX,f=915.0,...   or  #DG,FATAL,<code>
    // #DG,SRC,v1,kind=flash,...       where the lines did not come off a radio
    if (parts[1] === 'RX') {
      return { kind: 'rxinfo', version: parts[2], info: keyValues(parts.slice(3)) };
    }
    // #DG,BOOT,v1,n=<n> — the dump says where one boot ends and the next begins, which
    // is the only thing that can separate them: the counter cannot.
    if (parts[1] === 'BOOT') {
      return { kind: 'boot', version: parts[2], info: keyValues(parts.slice(3)) };
    }
    if (parts[1] === 'SRC') {
      return { kind: 'source', version: parts[2], info: keyValues(parts.slice(3)) };
    }
    if (parts[1] === 'FATAL') return { kind: 'rxfatal', code: num(parts[2]) };
    return { kind: 'other' };
  }

  function parseLine(input) {
    let line = String(input).replace(/^﻿/, '').replace(/\r$/, '').trim();
    let clock = null;
    const m = TIME_PREFIX.exec(line);
    if (m) {
      clock = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
      line = line.slice(m[0].length).trim();
    }
    let ev = { kind: 'other' };
    if (line === '') ev = { kind: 'empty' };
    else if (line.startsWith('PKT,')) ev = parseRaw(line.split(','));
    else if (line.startsWith('ERR,')) {
      const p = line.split(',');
      ev = { kind: 'rxerror', code: num(p[1]), rssi: num(p[2]), snr: num(p[3]) };
    } else if (line.startsWith('HB,')) {
      const p = line.split(',');
      ev = { kind: 'heartbeat', uptimeMs: num(p[1]), ok: num(p[2]), errors: num(p[3]) };
    } else if (line.startsWith('#DG,')) ev = parseDevice(line.split(','));
    else if (line.startsWith('Latitude_deg,')) ev = { kind: 'csvheader' };
    else if (HEX_DUMP.test(line)) ev = packetEvent('hexdump', P.hexToBytes(line), NaN, NaN, NaN);
    else {
      const parts = line.split(',');
      if (parts.length === CSV_COLUMNS) ev = parseCsv(parts) || { kind: 'other' };
    }
    ev.clock = clock;
    ev.text = line;
    return ev;
  }

  return { parseLine, CSV_COLUMNS };
});
