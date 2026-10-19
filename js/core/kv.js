// A small key-value store in this browser's IndexedDB, for things too big for localStorage
// (Capture's takes). Values are any structured-cloneable data. Never throws: a read that fails
// gives the fallback, a write that fails is dropped (and logged).
let dbp = null;
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('ostinato-kv', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
function run(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const tx = d.transaction('kv', mode), req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  }));
}
export const kv = {
  async get(key, fallback) {
    try { const v = await run('readonly', st => st.get(key)); return v === undefined ? fallback : v; } catch { return fallback; }
  },
  async set(key, value) {
    try { await run('readwrite', st => st.put(value, key)); } catch (err) { console.warn('kv.set', key, err); }
  },
  async del(key) {
    try { await run('readwrite', st => st.delete(key)); } catch (err) { console.warn('kv.del', key, err); }
  },
};
