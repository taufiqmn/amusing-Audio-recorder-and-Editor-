// IndexedDB persistence: the project autosaves after every edit, and recordings
// are written in chunks while you record so a crash or closed tab loses nothing.
const DB_NAME = 'takeflow', VERSION = 1;
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('sources')) d.createObjectStore('sources');
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      if (!d.objectStoreNames.contains('pending')) d.createObjectStore('pending');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode); const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  }));
}

export const Storage = {
  available: typeof indexedDB !== 'undefined',
  async saveSource(id, data) { return tx('sources', 'readwrite', (s) => s.put(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), id)); },
  async loadSource(id) { const b = await tx('sources', 'readonly', (s) => s.get(id)); return b ? new Float32Array(b) : null; },
  async sourceIds() { return (await tx('sources', 'readonly', (s) => s.getAllKeys())) || []; },
  async deleteSource(id) { return tx('sources', 'readwrite', (s) => s.delete(id)); },
  async saveMeta(meta) { return tx('meta', 'readwrite', (s) => s.put(meta, 'project')); },
  async loadMeta() { return tx('meta', 'readonly', (s) => s.get('project')); },
  async clearProject() {
    await tx('sources', 'readwrite', (s) => s.clear());
    await tx('meta', 'readwrite', (s) => s.clear());
  },
  // crash-safe recording chunks
  async savePending(takeId, index, data, info) {
    return tx('pending', 'readwrite', (s) => s.put({ takeId, index, data: data.buffer.slice(0), info }, `${takeId}:${String(index).padStart(8, '0')}`));
  },
  async loadPending() { return (await tx('pending', 'readonly', (s) => s.getAll())) || []; },
  async clearPending() { return tx('pending', 'readwrite', (s) => s.clear()); },
  async persist() { try { return await navigator.storage?.persist?.(); } catch { return false; } },
  async estimate() { try { return await navigator.storage?.estimate?.(); } catch { return null; } },
};
