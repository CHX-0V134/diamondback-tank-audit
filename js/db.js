// ---------------------------------------------------------------------------
// db.js — IndexedDB local store. This is the durability layer: every edit is
// written here FIRST and survives tab close, reload, and offline. Nothing is
// pushed to Supabase until it is safely in IndexedDB.
// ---------------------------------------------------------------------------
const DB_NAME = 'well-config-audit';
const DB_VERSION = 1;

// Object stores:
//   tanks    keyPath id  — server snapshot of audit_tanks
//   wells    keyPath id  — server snapshot of audit_wells
//   products keyPath id  — server snapshot of audit_products
//   outbox   keyPath localId (autoInc) — pending mutations not yet confirmed by server
//   meta     keyPath key — misc (lastPull timestamp, deviceId, cached user)
const STORES = ['tanks', 'wells', 'products', 'outbox', 'meta'];

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('tanks')) db.createObjectStore('tanks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('wells')) {
        const s = db.createObjectStore('wells', { keyPath: 'id' });
        s.createIndex('tank_id', 'tank_id', { unique: false });
      }
      if (!db.objectStoreNames.contains('products')) db.createObjectStore('products', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'localId', autoIncrement: true });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((r) => { out = r; }).catch(reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const idbReq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const DB = {
  async getAll(store) { return tx(store, 'readonly', (s) => idbReq(s.getAll())); },
  async get(store, key) { return tx(store, 'readonly', (s) => idbReq(s.get(key))); },
  async put(store, val) { return tx(store, 'readwrite', (s) => idbReq(s.put(val))); },
  async putMany(store, vals) {
    return tx(store, 'readwrite', (s) => { vals.forEach((v) => s.put(v)); return true; });
  },
  async delete(store, key) { return tx(store, 'readwrite', (s) => idbReq(s.delete(key))); },
  async clear(store) { return tx(store, 'readwrite', (s) => idbReq(s.clear())); },

  // meta helpers
  async getMeta(key, dflt) { const r = await this.get('meta', key); return r ? r.value : dflt; },
  async setMeta(key, value) { return this.put('meta', { key, value }); },

  // outbox
  async enqueue(mutation) { return this.put('outbox', mutation); },
  async outbox() { return this.getAll('outbox'); },
  async dequeue(localId) { return this.delete('outbox', localId); },
};

// Stable per-device id for change-log attribution / debugging.
async function getDeviceId() {
  let id = await DB.getMeta('deviceId', null);
  if (!id) { id = crypto.randomUUID(); await DB.setMeta('deviceId', id); }
  return id;
}

window.DB = DB;
window.getDeviceId = getDeviceId;
