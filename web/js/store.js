// Settings (localStorage) and crash autosave (IndexedDB).
// Both are per browser. If storage is blocked the page still works, it just
// forgets settings and cannot recover a crashed session.
(function (root) {
  'use strict';

  const SETTINGS_KEY = 'dg-settings-v1';

  // Page settings on top of the fleet thresholds (DG.fleet.DEFAULTS).
  const UI_DEFAULTS = {
    graphWindowMin: 0,        // 0 = show everything kept
    lineWidth: 1.25,
    autosave: true,
    autosaveS: 5,
    fileTag: 'descent',       // prefix for saved file names
  };

  function defaults() { return Object.assign({}, root.DG.fleet.DEFAULTS, UI_DEFAULTS); }

  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { /* blocked or corrupt */ }
    const out = defaults();
    for (const k in out) if (typeof saved[k] === typeof out[k]) out[k] = saved[k];
    return out;
  }

  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); return true; } catch (e) { return false; }
  }

  // ---------- autosave ----------
  const DB = 'descent-ground';
  const KEEP_DAYS = 14;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('sessions', { keyPath: 'id' });
        db.createObjectStore('chunks', { autoIncrement: true }).createIndex('session', 'session');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
  const request = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  class Autosave {
    constructor() {
      this.id = new Date().toISOString();
      this.pending = [];
      this.lines = 0;
      this.ok = false;
      this.db = openDb().then((db) => { this.ok = true; return db; }).catch(() => null);
    }
    add(line) { this.pending.push(line); }

    async flush() {
      const db = await this.db;
      if (!db || !this.pending.length) return;
      const text = this.pending.join(''); const n = this.pending.length;
      this.pending = [];
      const tx = db.transaction(['sessions', 'chunks'], 'readwrite');
      tx.objectStore('chunks').add({ session: this.id, text });
      this.lines += n;
      tx.objectStore('sessions').put({ id: this.id, started: this.id, updated: new Date().toISOString(), lines: this.lines });
      await done(tx);
    }

    // Earlier sessions still in storage (newest first), excluding this one.
    async previous() {
      const db = await this.db;
      if (!db) return [];
      const all = await request(db.transaction('sessions').objectStore('sessions').getAll());
      const old = Date.now() - KEEP_DAYS * 86400e3;
      for (const s of all) if (Date.parse(s.updated) < old) await this.remove(s.id);
      return all.filter((s) => s.id !== this.id && Date.parse(s.updated) >= old).sort((a, b) => (a.updated < b.updated ? 1 : -1));
    }

    async text(id) {
      const db = await this.db;
      const chunks = await request(db.transaction('chunks').objectStore('chunks').index('session').getAll(id));
      return chunks.map((c) => c.text).join('');
    }

    async remove(id) {
      const db = await this.db;
      if (!db) return;
      const tx = db.transaction(['sessions', 'chunks'], 'readwrite');
      tx.objectStore('sessions').delete(id);
      const idx = tx.objectStore('chunks').index('session');
      const keys = await request(idx.getAllKeys(id));
      for (const k of keys) tx.objectStore('chunks').delete(k);
      await done(tx);
    }
  }

  root.DG.store = { UI_DEFAULTS, defaults, loadSettings, saveSettings, Autosave };
})(self);
