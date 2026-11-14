/* libarchive.js (wasm) 桥接：负责 RAR / 7z 等 zip.js 覆盖不到的格式 */
let modulePromise = null;

async function getArchive() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const mod = await import('../../vendor/libarchive/libarchive.js');
      mod.Archive.init();
      return mod.Archive;
    })();
  }
  return modulePromise;
}

export async function isWasmArchiveReady() {
  try { await getArchive(); return true; } catch { return false; }
}

/**
 * 用 libarchive 解包，返回统一 entries
 * @returns {Promise<{entries: Array, warnings: string[]}>}
 */
export async function readWithLibarchive(file, { onProgress, signal } = {}) {
  const abort = () => { const e = new Error('已取消导入'); e.name = 'AbortError'; return e; };
  const Archive = await getArchive();
  onProgress?.({ message: '读取压缩包目录…', done: 0, total: 0, percent: 0 });
  const reader = await Archive.open(file);
  const warnings = [];
  try {
    if (await reader.hasEncryptedData()) {
      warnings.push('压缩包带有加密内容，可能需要密码，已跳过加密条目');
    }
    onProgress?.({ message: '解析压缩包目录…', done: 0, total: 0, percent: 1 });
    const list = await reader.getFilesArray();
    let totalBytes = 0;
    for (const item of list) {
      const f = item.file;
      if (f && typeof f !== 'string' && f.size) totalBytes += f.size;
    }
    const entries = [];
    let i = 0;
    let bytesDone = 0;
    for (const item of list) {
      if (signal?.aborted) throw abort();
      i++;
      const parent = item.path || '';
      const f = item.file;
      if (f == null) continue;
      if (typeof f === 'string') {
        entries.push({ path: `${parent}${f}/`.replace(/\/{2,}/g, '/'), dir: true, size: 0, read: async () => new Uint8Array(0) });
        continue;
      }
      const name = f.name ?? '';
      const full = (parent + name).replace(/^\/+/, '');
      if (!full) continue;
      const pct = totalBytes ? Math.min(99, (bytesDone / totalBytes) * 100) : (i / Math.max(1, list.length)) * 100;
      const mb = (n) => (n / 1048576).toFixed(1);
      onProgress?.({
        message: `解压 ${i}/${list.length} · ${mb(bytesDone)}/${mb(totalBytes)} MB`,
        done: i, total: list.length, percent: pct,
      });
      try {
        const blob = await f.extract();
        bytesDone += blob.size;
        entries.push({ path: full, dir: false, size: blob.size, read: async () => new Uint8Array(await blob.arrayBuffer()) });
      } catch (e) {
        if (signal?.aborted) throw abort();
        warnings.push(`解包失败：${full}（${e.message}）`);
      }
    }
    return { entries, warnings };
  } finally {
    try { await reader.close(); } catch { /* ignore */ }
  }
}
