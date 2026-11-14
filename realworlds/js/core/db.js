/* IndexedDB：游戏库元数据 / 存档 / 设置 / 文件清单 / 解析后的剧本 */

const DB_NAME = 'galplay';
const DB_VERSION = 2;

const STORES = [
  { name: 'games', keyPath: 'id' },
  { name: 'saves', keyPath: 'id', indexes: [['gameId', 'gameId']] },
  { name: 'settings', keyPath: 'key' },
  { name: 'files', keyPath: ['gameId', 'path'], indexes: [['gameId', 'gameId']] }, // OPFS 不可用时的兜底
  { name: 'manifests', keyPath: 'gameId' },
  { name: 'stories', keyPath: 'gameId' },
];

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const def of STORES) {
        let store;
        if (!db.objectStoreNames.contains(def.name)) {
          store = db.createObjectStore(def.name, { keyPath: def.keyPath });
        } else {
          store = req.transaction.objectStore(def.name);
        }
        for (const [name, keyPath] of def.indexes || []) {
          if (!store.indexNames.contains(name)) store.createIndex(name, keyPath);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeNames, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    try {
      result = fn(t);
    } catch (e) { reject(e); }
  });
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const DB = {
  async get(store, key) { return tx(store, 'readonly', (t) => wrap(t.objectStore(store).get(key))); },
  async getAll(store) { return tx(store, 'readonly', (t) => wrap(t.objectStore(store).getAll())); },
  async put(store, value) { return tx(store, 'readwrite', (t) => wrap(t.objectStore(store).put(value))); },
  async del(store, key) { return tx(store, 'readwrite', (t) => wrap(t.objectStore(store).delete(key))); },
  async count(store) { return tx(store, 'readonly', (t) => wrap(t.objectStore(store).count())); },

  async listByGame(store, gameId) {
    return tx(store, 'readonly', (t) => {
      const idx = t.objectStore(store).index('gameId');
      return wrap(idx.getAll(gameId));
    });
  },

  /* ---------- 游戏 ---------- */
  listGames: () => DB.getAll('games'),
  getGame: (id) => DB.get('games', id),
  putGame: (game) => DB.put('games', game),
  async updateGame(id, patch) {
    const g = await DB.get('games', id);
    if (!g) return null;
    const next = { ...g, ...patch };
    await DB.put('games', next);
    return next;
  },

  /* ---------- 存档 ---------- */
  saveKey: (gameId, slot) => `${gameId}::${slot}`,
  async listSaves(gameId) {
    const rows = await DB.listByGame('saves', gameId);
    return rows.sort((a, b) => a.slot - b.slot);
  },
  async putSave(gameId, slot, snapshot, meta = {}) {
    const rec = {
      id: DB.saveKey(gameId, slot), gameId, slot,
      createdAt: Date.now(), snapshot, meta,
    };
    await DB.put('saves', rec);
    return rec;
  },
  async deleteSave(gameId, slot) { return DB.del('saves', DB.saveKey(gameId, slot)); },

  /* ---------- 设置 ---------- */
  async getSettings() {
    const rows = await DB.getAll('settings');
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  },
  async setSetting(key, value) { return DB.put('settings', { key, value }); },

  /* ---------- 清单 / 剧本 ---------- */
  getManifest: (gameId) => DB.get('manifests', gameId),
  putManifest: (gameId, data) => DB.put('manifests', { gameId, ...data }),
  getStory: (gameId) => DB.get('stories', gameId),
  putStory: (gameId, story) => DB.put('stories', { gameId, ...story }),

  /* ---------- 删除整部游戏 ---------- */
  async deleteGame(id) {
    const saves = await DB.listByGame('saves', id);
    for (const s of saves) await DB.del('saves', s.id);
    await DB.del('games', id);
    await DB.del('manifests', id);
    await DB.del('stories', id);
    const files = await DB.listByGame('files', id);
    for (const f of files) await DB.del('files', [f.gameId, f.path]);
  },
};

export async function estimateStorage() {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch { return null; }
}
