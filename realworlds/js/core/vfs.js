/* 虚拟文件系统：优先 OPFS（可存几个 GB），不支持时退回 IndexedDB */
import { DB } from './db.js';

const urlCache = new Map();
const cacheKey = (gameId, path) => gameId + '::' + path;

export function revokeGameUrls(gameId) {
  for (const [k, url] of urlCache) {
    if (k.startsWith(gameId + '::')) { URL.revokeObjectURL(url); urlCache.delete(k); }
  }
}

class OpfsStore {
  constructor(root) { this.root = root; this.kind = 'opfs'; this._idxCache = new Map(); }

  static async create() {
    if (!navigator.storage?.getDirectory) return null;
    try {
      const root = await navigator.storage.getDirectory();
      const games = await root.getDirectoryHandle('games', { create: true });
      return new OpfsStore(games);
    } catch { return null; }
  }

  async gameDir(gameId, create = false) {
    return this.root.getDirectoryHandle(gameId, { create });
  }

  async bundleDir(gameId, create = false) {
    const gd = await this.gameDir(gameId, create);
    return gd.getDirectoryHandle('__bundle__', { create });
  }

  async _readBundleIndex(gameId) {
    if (this._idxCache.has(gameId)) return this._idxCache.get(gameId);
    let files = null;
    try {
      const bdir = await this.bundleDir(gameId, false);
      const fh = await bdir.getFileHandle('index.json');
      const data = JSON.parse(await (await fh.getFile()).text());
      files = data && data.files ? data.files : null;
    } catch { files = null; }
    this._idxCache.set(gameId, files);
    return files;
  }

  /** 写入：一个游戏一个 bundle（data.bin + index.json），避免大量小文件写入开销 */
  async writeGame(gameId, entries, onProgress) {
    try {
      await this._writeBundle(gameId, entries, onProgress);
    } catch (err) {
      console.warn('bundle 写入失败，回退到逐文件写入', err);
      await this._writeFilesLegacy(gameId, entries, onProgress);
    }
  }

  async _writeBundle(gameId, entries, onProgress) {
    const gd = await this.gameDir(gameId, true);
    const bdir = await gd.getDirectoryHandle('__bundle__', { create: true });
    const dataHandle = await bdir.getFileHandle('data.bin', { create: true });
    const existing = await this._readBundleIndex(gameId);
    const files = existing ? { ...existing } : {};
    let offset = 0;
    if (existing) {
      try { offset = (await dataHandle.getFile()).size; } catch { offset = 0; }
    }
    const writable = await dataHandle.createWritable({ keepExistingData: !!existing && offset > 0 });
    if (offset > 0) await writable.seek(offset);
    let done = 0;
    const total = entries.length;
    for (const e of entries) {
      let payload = e.blob ?? e.data;
      if (!payload && e.getBlob) payload = await e.getBlob();
      if (!payload) continue;
      const size = payload.size ?? payload.byteLength ?? 0;
      files[e.path] = [offset, size];
      await writable.write(payload);
      offset += size;
      done++;
      if (onProgress && (done % 150 === 0 || done === total)) {
        onProgress({ done, total, file: e.path });
      }
    }
    await writable.close();
    const idxHandle = await bdir.getFileHandle('index.json', { create: true });
    const w = await idxHandle.createWritable();
    await w.write(JSON.stringify({ version: 1, files }));
    await w.close();
    this._idxCache.set(gameId, files);
  }

  /** 兼容旧格式（每个文件一个 OPFS 文件） */
  async _writeFilesLegacy(gameId, entries, onProgress) {
    const root = await this.gameDir(gameId, true);
    const dirCache = new Map([['', root]]);
    const getDir = async (parts) => {
      let key = '';
      let cur = root;
      for (const seg of parts) {
        const nk = key ? key + '/' + seg : seg;
        const cached = dirCache.get(nk);
        if (cached) { cur = cached; key = nk; continue; }
        cur = await cur.getDirectoryHandle(seg, { create: true });
        dirCache.set(nk, cur);
        key = nk;
      }
      return cur;
    };
    const total = entries.length;
    let done = 0;
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(12, total)) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= total) return;
        const e = entries[i];
        const parts = e.path.split('/').filter(Boolean);
        if (parts.length) {
          try {
            const parent = await getDir(parts.slice(0, -1));
            const fh = await parent.getFileHandle(parts[parts.length - 1], { create: true });
            const w = await fh.createWritable();
            let payload = e.blob ?? e.data;
            if (!payload && e.getBlob) payload = await e.getBlob();
            await w.write(payload);
            await w.close();
          } catch { /* ignore */ }
        }
        done++;
        if (onProgress && (done % 60 === 0 || done === total)) onProgress({ done, total, file: e.path });
      }
    });
    await Promise.all(workers);
  }

  async list(gameId) {
    const idx = await this._readBundleIndex(gameId);
    if (idx) return Object.entries(idx).map(([path, v]) => ({ path, size: v[1] }));
    const out = [];
    let dir;
    try { dir = await this.gameDir(gameId); } catch { return out; }
    const walk = async (d, prefix) => {
      for await (const [name, handle] of d.entries()) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'directory') await walk(handle, p);
        else {
          const file = await handle.getFile();
          out.push({ path: p, size: file.size });
        }
      }
    };
    await walk(dir, '');
    return out;
  }

  async read(gameId, path) {
    const idx = await this._readBundleIndex(gameId);
    if (idx && idx[path]) {
      const [off, size] = idx[path];
      const bdir = await this.bundleDir(gameId, false);
      const fh = await bdir.getFileHandle('data.bin');
      const file = await fh.getFile();
      return file.slice(off, off + size);
    }
    const parts = path.split('/').filter(Boolean);
    let cur = await this.gameDir(gameId);
    for (let i = 0; i < parts.length - 1; i++) cur = await cur.getDirectoryHandle(parts[i]);
    const fh = await cur.getFileHandle(parts[parts.length - 1]);
    return fh.getFile();
  }

  async deleteGame(gameId) {
    revokeGameUrls(gameId);
    this._idxCache.delete(gameId);
    try { await this.root.removeEntry(gameId, { recursive: true }); } catch { /* ignore */ }
  }

  async listGameIds() {
    const ids = [];
    try {
      for await (const [name, handle] of this.root.entries()) {
        if (handle.kind === 'directory') ids.push(name);
      }
    } catch { /* ignore */ }
    return ids;
  }

  async usage() { return null; }
}

class IdbStore {
  constructor() { this.kind = 'idb'; }

  static async create() { return new IdbStore(); }

  async writeGame(gameId, entries, onProgress) {
    const total = entries.length;
    let done = 0;
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(8, total)) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= total) return;
        const e = entries[i];
        const blob = e.blob ?? (e.getBlob ? await e.getBlob() : new Blob([]));
        await DB.put('files', { gameId, path: e.path, blob, size: blob.size });
        done++;
        if (onProgress && (done % 60 === 0 || done === total)) {
          onProgress({ done, total, file: e.path });
        }
      }
    });
    await Promise.all(workers);
  }

  async list(gameId) {
    const rows = await DB.listByGame('files', gameId);
    return rows.map((r) => ({ path: r.path, size: r.size || (r.blob ? r.blob.size : 0) }));
  }

  async read(gameId, path) {
    const row = await DB.get('files', [gameId, path]);
    if (!row) throw new Error(`文件不存在：${path}`);
    return row.blob;
  }

  async deleteGame(gameId) {
    revokeGameUrls(gameId);
    const rows = await DB.listByGame('files', gameId);
    for (const r of rows) await DB.del('files', [r.gameId, r.path]);
  }

  async listGameIds() { return []; }

  async usage() { return null; }
}

let storePromise = null;
export function getStore() {
  if (!storePromise) {
    storePromise = (async () => (await OpfsStore.create()) || (await IdbStore.create()))();
  }
  return storePromise;
}

export const VFS = {
  async kind() { return (await getStore()).kind; },
  async writeGame(gameId, entries, onProgress) { return (await getStore()).writeGame(gameId, entries, onProgress); },
  async list(gameId) { return (await getStore()).list(gameId); },
  async read(gameId, path) { return (await getStore()).read(gameId, path); },
  async deleteGame(gameId) { return (await getStore()).deleteGame(gameId); },
  /** 清掉没有入库记录的残留（导入中途取消/刷新留下的文件） */
  async cleanupOrphans(validIds = []) {
    const store = await getStore();
    const keep = new Set(validIds);
    const ids = await store.listGameIds();
    let removed = 0;
    for (const id of ids) {
      if (keep.has(id)) continue;
      await store.deleteGame(id);
      removed++;
    }
    return removed;
  },
  async url(gameId, path) {
    const key = cacheKey(gameId, path);
    if (urlCache.has(key)) return urlCache.get(key);
    const blob = await VFS.read(gameId, path);
    const url = URL.createObjectURL(blob);
    urlCache.set(key, url);
    return url;
  },
  async text(gameId, path) {
    const blob = await VFS.read(gameId, path);
    return new Uint8Array(await blob.arrayBuffer());
  },
};
