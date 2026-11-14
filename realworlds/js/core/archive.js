/* 压缩包总调度：magic 识别 → 对应解包器 → 嵌套解压 */
import { isZip, readZip } from './zip.js';
import { isTar, readTar } from './tar.js';
import { gunzip, headBytes, startsWithBytes } from './codec.js';
import { isLZ4, decodeLZ4 } from './lz4.js';
import { readWithLibarchive } from './wasm-archive.js';
import { normPath, basename, ext } from './util.js';

const SIG = {
  rar: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
  seven: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  gzip: [0x1f, 0x8b],
  bzip2: [0x42, 0x5a, 0x68],
  xz: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
};

export function sniffArchive(head) {
  if (!head || head.length < 4) return null;
  if (isZip(head)) return 'zip';
  if (startsWithBytes(head, SIG.rar)) return 'rar';
  if (startsWithBytes(head, SIG.seven)) return '7z';
  if (startsWithBytes(head, SIG.gzip)) return 'gzip';
  if (isLZ4(head)) return 'lz4';
  if (isTar(head)) return 'tar';
  if (startsWithBytes(head, SIG.xz)) return 'xz';
  if (startsWithBytes(head, SIG.bzip2)) return 'bzip2';
  return null;
}

function stripGz(name) {
  return name.replace(/\.(gz|tgz)$/i, '').replace(/\.tar$/i, '') || 'unpacked';
}

async function readOne(blob, label, type, onProgress, signal) {
  if (type === 'zip') {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return readZip(bytes);
  }
  if (type === 'tar') {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return readTar(bytes);
  }
  if (type === 'gzip') {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const inner = await gunzip(bytes);
    if (isTar(inner.subarray(0, 320))) return readTar(inner);
    return {
      entries: [{ path: stripGz(basename(label)), dir: false, size: inner.length, read: async () => inner }],
      warnings: [],
    };
  }
  if (type === 'lz4') {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const inner = decodeLZ4(bytes);
    if (isTar(inner.subarray(0, 320))) return readTar(inner);
    const name = basename(label).replace(/\.lz4$/i, '') || 'unpacked';
    return { entries: [{ path: name, dir: false, size: inner.length, read: async () => inner }], warnings: [] };
  }
  if (type === 'rar' || type === '7z') {
    return readWithLibarchive(blob, { onProgress, signal });
  }
  throw new Error(`暂不支持 ${type} 格式（可以先转换成 zip/7z）`);
}

/**
 * 解压任意压缩包（支持嵌套），返回扁平文件列表
 * @param {Blob|File} file
 * @param {string} name
 * @param {{onProgress?: Function, maxDepth?: number}} opts
 * @returns {Promise<{entries: Array<{path:string, blob:Blob, size:number}>, warnings: string[], type: string}>}
 */
export async function extractArchive(file, name = '', opts = {}) {
  const { onProgress, maxDepth = 3, signal } = opts;
  const abort = () => { const e = new Error('已取消导入'); e.name = 'AbortError'; return e; };
  const warnings = [];
  let filesDone = 0;

  const walk = async (blob, label, depth) => {
    const head = await headBytes(blob, 1200);
    let type = sniffArchive(head);
    if (!type && depth === 0 && /\.(gz|tgz)$/i.test(label)) type = 'gzip';
    if (!type) {
      if (depth === 0) {
        throw new Error(`无法识别的压缩格式：${label || '文件'}`);
      }
      warnings.push(`跳过无法识别的内容：${label}`);
      return [];
    }
    onProgress?.({ phase: 'read', message: depth ? `解压嵌套压缩包：${basename(label)}` : `解压：${basename(label)}` });
    const { entries, warnings: w } = await readOne(blob, label, type, onProgress, signal);
    for (const msg of w || []) warnings.push(msg);
    // 并行解出条目（IO/解压密集），再顺序处理嵌套包
    const results = new Array(entries.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(8, entries.length)) }, async () => {
      while (true) {
        if (signal?.aborted) throw abort();
        const k = cursor++;
        if (k >= entries.length) return;
        const e = entries[k];
        const path = normPath(e.path);
        if (!path) continue;
        if (e.dir) { results[k] = { path: path + '/', dir: true, size: 0 }; continue; }
        let bytes;
        try {
          bytes = await e.read();
        } catch (err) {
          warnings.push(`无法解出 ${path}：${err.message}`);
          continue;
        }
        results[k] = { path, dir: false, blob: new Blob([bytes]), size: bytes.length };
        filesDone++;
        onProgress?.({ phase: 'extract', message: depth ? `解压嵌套包：${basename(label)}` : `解压：${basename(label)}`, done: filesDone, file: path });
      }
    });
    await Promise.all(workers);

    const out = [];
    for (const entry of results) {
      if (!entry) continue;
      out.push(entry);
      if (entry.dir || depth >= maxDepth) continue;
      const bytes = new Uint8Array(await entry.blob.slice(0, 1200).arrayBuffer());
      const nested = sniffArchive(bytes);
      if (!nested) continue;
      try {
        const sub = await walk(entry.blob, entry.path, depth + 1);
        for (const child of sub) {
          if (child.dir) continue;
          out.push({ path: `${entry.path}/${child.path}`, dir: false, blob: child.blob, size: child.size });
        }
      } catch (err) {
        warnings.push(`嵌套解压失败 ${entry.path}：${err.message}`);
      }
    }
    return out;
  };

  const head = await headBytes(file, 1200);
  const type = sniffArchive(head) || (/\.(gz|tgz)$/i.test(name) ? 'gzip' : null);
  if (!type) throw new Error(`无法识别的压缩格式：${name || '文件'}`);
  const entries = await walk(file, name || basename(name) || 'archive', 0);
  return { entries: entries.filter((e) => !e.dir), warnings, type };
}

export function archiveTypeOf(head) { return sniffArchive(head); }
export { ext };
