// 밑줄서재 — IndexedDB 저장소
const DB_NAME = 'mitjul';
const DB_VER = 1;
export const STORES = ['books', 'quotes', 'people', 'relations'];

let dbPromise;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of STORES) {
        if (!d.objectStoreNames.contains(s)) {
          const os = d.createObjectStore(s, { keyPath: 'id' });
          if (s !== 'books') os.createIndex('bookId', 'bookId');
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return openDB().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const db = {
  all: (s) => run(s, 'readonly', (os) => os.getAll()),
  get: (s, id) => run(s, 'readonly', (os) => os.get(id)),
  byBook: (s, bookId) => run(s, 'readonly', (os) => os.index('bookId').getAll(bookId)),
  put: async (s, obj) => { await run(s, 'readwrite', (os) => os.put(obj)); return obj; },
  del: (s, id) => run(s, 'readwrite', (os) => os.delete(id)),
  clear: (s) => run(s, 'readwrite', (os) => os.clear()),

  async deleteBook(bookId) {
    for (const s of ['quotes', 'people', 'relations']) {
      const rows = await db.byBook(s, bookId);
      for (const r of rows) await db.del(s, r.id);
    }
    await db.del('books', bookId);
  },

  async deletePerson(personId, bookId) {
    const rels = await db.byBook('relations', bookId);
    for (const r of rels) if (r.from === personId || r.to === personId) await db.del('relations', r.id);
    await db.del('people', personId);
  },

  async exportAll() {
    const out = { app: 'mitjul', version: 1, exportedAt: new Date().toISOString() };
    for (const s of STORES) out[s] = await db.all(s);
    return out;
  },

  async importAll(data, { replace = false } = {}) {
    if (!data || data.app !== 'mitjul') throw new Error('밑줄서재 백업 파일이 아니에요');
    for (const s of STORES) {
      if (replace) await db.clear(s);
      for (const row of data[s] || []) await db.put(s, row);
    }
  },
};
