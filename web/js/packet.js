// DeSCENT telemetry packet: 55 bytes, little-endian.
// Mirrors SSDS_DeSCENT/Software/V2_6_X/V2_6_X_Code/src/app/Telemetry.h.
// Bytes 0-52 are data, bytes 53-54 are CRC-16/CCITT-FALSE over bytes 0-52.
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else (root.DG = root.DG || {}).packet = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PACKET_LENGTH = 55;
  const DATA_LENGTH = 53;

  // Validity bits (bit 0 = LSB). `short` is the letter used in the fleet list.
  const VALIDITY_BITS = [
    { bit: 0, key: 'accel', short: 'L', name: 'Linear acceleration' },
    { bit: 1, key: 'gyro', short: 'G', name: 'Gyroscope' },
    { bit: 2, key: 'mag', short: 'M', name: 'Magnetometer' },
    { bit: 3, key: 'quat', short: 'Q', name: 'Quaternion' },
    { bit: 4, key: 'gps', short: 'P', name: 'GPS' },
    { bit: 5, key: 'soc', short: 'S', name: 'State of charge' },
    { bit: 6, key: 'env', short: 'E', name: 'Environment' },
    { bit: 7, key: 'fresh', short: 'F', name: 'All data fresh' },
  ];

  // Every field in packet order.
  // type: storage type; scale: raw / scale = value; group: validity bit key
  // that says whether the value can be trusted (null = always trusted).
  // csvDecimals: how the old CSV receiver prints it (used to rebuild bytes).
  const FIELDS = [
    { key: 'lat', label: 'Latitude', unit: 'deg', type: 'i32', scale: 1e7, group: 'gps', csvDecimals: 7 },
    { key: 'lon', label: 'Longitude', unit: 'deg', type: 'i32', scale: 1e7, group: 'gps', csvDecimals: 7 },
    { key: 'gpsAlt', label: 'GPS altitude MSL', unit: 'm', type: 'i32', scale: 1000, group: 'gps', csvDecimals: 3 },
    { key: 'envAlt', label: 'Pressure altitude', unit: 'm', type: 'i32', scale: 100, group: 'env', csvDecimals: 2 },
    { key: 'ax', label: 'Accel X', unit: 'm/s²', type: 'i16', scale: 100, group: 'accel', csvDecimals: 2 },
    { key: 'ay', label: 'Accel Y', unit: 'm/s²', type: 'i16', scale: 100, group: 'accel', csvDecimals: 2 },
    { key: 'az', label: 'Accel Z', unit: 'm/s²', type: 'i16', scale: 100, group: 'accel', csvDecimals: 2 },
    { key: 'gx', label: 'Gyro X', unit: 'deg/s', type: 'i16', scale: 10, group: 'gyro', csvDecimals: 1 },
    { key: 'gy', label: 'Gyro Y', unit: 'deg/s', type: 'i16', scale: 10, group: 'gyro', csvDecimals: 1 },
    { key: 'gz', label: 'Gyro Z', unit: 'deg/s', type: 'i16', scale: 10, group: 'gyro', csvDecimals: 1 },
    { key: 'mx', label: 'Mag X', unit: 'µT', type: 'i16', scale: 10, group: 'mag', csvDecimals: 1 },
    { key: 'my', label: 'Mag Y', unit: 'µT', type: 'i16', scale: 10, group: 'mag', csvDecimals: 1 },
    { key: 'mz', label: 'Mag Z', unit: 'µT', type: 'i16', scale: 10, group: 'mag', csvDecimals: 1 },
    { key: 'qi', label: 'Quat i', unit: '', type: 'i16', scale: 32767, group: 'quat', csvDecimals: 5 },
    { key: 'qj', label: 'Quat j', unit: '', type: 'i16', scale: 32767, group: 'quat', csvDecimals: 5 },
    { key: 'qk', label: 'Quat k', unit: '', type: 'i16', scale: 32767, group: 'quat', csvDecimals: 5 },
    { key: 'qr', label: 'Quat real', unit: '', type: 'i16', scale: 32767, group: 'quat', csvDecimals: 5 },
    { key: 'temp', label: 'Temperature', unit: '°C', type: 'i16', scale: 100, group: 'env', csvDecimals: 2 },
    { key: 'pressure', label: 'Pressure', unit: 'hPa', type: 'u16', scale: 10, group: 'env', csvDecimals: 1 },
    { key: 'humidity', label: 'Humidity', unit: '%RH', type: 'u16', scale: 100, group: 'env', csvDecimals: 2 },
    { key: 'counter', label: 'Packet counter', unit: '', type: 'u16', scale: 1, group: null, csvDecimals: 0 },
    { key: 'csid', label: 'CSID', unit: '', type: 'u8', scale: 1, group: null, csvDecimals: 0 },
    { key: 'battery', label: 'Battery', unit: '%', type: 'u8', scale: 2, group: 'soc', csvDecimals: 1 },
    { key: 'validity', label: 'Validity', unit: '', type: 'u8', scale: 1, group: null, csvDecimals: 0 },
  ];

  const SIZES = { i32: 4, i16: 2, u16: 2, u8: 1 };
  let offset = 0;
  for (const f of FIELDS) { f.offset = offset; offset += SIZES[f.type]; }
  if (offset !== DATA_LENGTH) throw new Error('packet field table is ' + offset + ' bytes, expected 53');

  // BNO085 accelerometer range is ±8 g (≈78 m/s²). The packet can hold more,
  // so a value near the sensor limit means the sensor probably clipped.
  const ACCEL_SATURATION_MPS2 = 75;

  function crc16(bytes, length) {
    let crc = 0xffff;
    for (let i = 0; i < length; i++) {
      crc ^= bytes[i] << 8;
      for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  }

  function hexToBytes(hex) {
    const clean = hex.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length % 2) return null;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }

  function bytesToHex(bytes) {
    let s = '';
    for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
    return s;
  }

  function readRaw(view, f) {
    switch (f.type) {
      case 'i32': return view.getInt32(f.offset, true);
      case 'i16': return view.getInt16(f.offset, true);
      case 'u16': return view.getUint16(f.offset, true);
      default: return view.getUint8(f.offset);
    }
  }

  function writeRaw(view, f, raw) {
    switch (f.type) {
      case 'i32': view.setInt32(f.offset, raw, true); break;
      case 'i16': view.setInt16(f.offset, raw, true); break;
      case 'u16': view.setUint16(f.offset, raw, true); break;
      default: view.setUint8(f.offset, raw);
    }
  }

  function validityFlags(mask) {
    const flags = {};
    for (const v of VALIDITY_BITS) flags[v.key] = (mask >> v.bit & 1) === 1;
    return flags;
  }

  // Decode a 55-byte packet. Never throws; problems are reported in the result.
  // Result: { ok, error?, crcOk, crcReceived, crcCalculated, values, valid, saturated }
  function decode(bytes) {
    if (!bytes || bytes.length !== PACKET_LENGTH) {
      return { ok: false, error: 'length ' + (bytes ? bytes.length : 0) + ', expected 55' };
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = {};
    for (const f of FIELDS) values[f.key] = readRaw(view, f) / f.scale;
    const crcReceived = view.getUint16(DATA_LENGTH, true);
    const crcCalculated = crc16(bytes, DATA_LENGTH);
    const valid = validityFlags(values.validity);
    return {
      ok: true,
      crcOk: crcReceived === crcCalculated,
      crcReceived,
      crcCalculated,
      values,
      valid,
      saturated: valid.accel && ['ax', 'ay', 'az'].some((k) => Math.abs(values[k]) >= ACCEL_SATURATION_MPS2),
    };
  }

  // Rebuild the 53 data bytes from decoded values (used for CSV-receiver lines,
  // which print values but not bytes). Returns Uint8Array(55) with the given CRC.
  function encode(values, crc) {
    const bytes = new Uint8Array(PACKET_LENGTH);
    const view = new DataView(bytes.buffer);
    for (const f of FIELDS) writeRaw(view, f, Math.round(values[f.key] * f.scale));
    view.setUint16(DATA_LENGTH, crc & 0xffff, true);
    return bytes;
  }

  return {
    PACKET_LENGTH, DATA_LENGTH, FIELDS, VALIDITY_BITS, ACCEL_SATURATION_MPS2,
    crc16, hexToBytes, bytesToHex, decode, encode, validityFlags,
  };
});
