/* TAR 读取器（ustar / GNU longname / pax），用于 .tar 与 .tar.gz */
import { decodeName, normPath } from './util.js';

export function isTar(head) {
  if (!head || head.length < 262) return false;
  // 'ustar' at 257
  return head[257] === 0x75 && head[258] === 0x73 && head[259] === 0x74 &&
    head[260] === 0x61 && head[261] === 0x72;
}

function cstr(buf, off, len) {
  let end = off;
  while (end < off + len && buf[end] !== 0) end++;
  return buf.subarray(off, end);
}
function octal(buf, off, len) {
  let s = '';
  for (let i = off; i < off + len; i++) {
    const c = buf[i];
    if (c === 0 || c === 0x20) continue;
    s += String.fromCharCode(c);
  }
  if (!s) return 0;
  if (buf[off] & 0x80) {
    // base-256
    let v = 0;
    for (let i = off + 1; i < off + len; i++) v = v * 256 + buf[i];
    return v;
  }
  return parseInt(s, 8) || 0;
}

/**
 * @returns {Promise<{entries: Array, warnings: string[]}>}
 */
export async function readTar(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const warnings = [];
  const entries = [];
  let pos = 0;
  let longName = null;
  let paxPath = null;
  while (pos + 512 <= buf.length) {
    const block = buf.subarray(pos, pos + 512);
    if (block.every((b) => b === 0)) break;
    const rawName = cstr(block, 0, 100);
    const prefix = cstr(block, 345, 155);
    let name = prefix.length
      ? new TextDecoder('utf-8').decode(prefix) + '/' + new TextDecoder('utf-8').decode(rawName)
      : new TextDecoder('utf-8').decode(rawName);
    const size = octal(block, 124, 12);
    const type = block[156];
    const dataStart = pos + 512;
    const dataEnd = Math.min(buf.length, dataStart + size);

    if (type === 0x4c) { // 'L' GNU long name
      longName = new TextDecoder('utf-8').decode(cstr(buf, dataStart, size));
      pos = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }
    if (type === 0x78 || type === 0x67) { // 'x' pax header / 'g' global
      const text = new TextDecoder('utf-8').decode(buf.subarray(dataStart, dataEnd));
      if (type === 0x78) {
        const m = /(?:^|\n)\d+ path=([^\n]*)/.exec(text);
        if (m) paxPath = m[1];
      }
      pos = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }

    const finalName = paxPath || longName || name;
    longName = null;
    paxPath = null;
    const path = normPath(finalName);
    if (!path) { pos = dataStart + Math.ceil(size / 512) * 512; continue; }
    const isDir = type === 0x35 || /\/$/.test(finalName);
    if (!isDir) {
      if (dataEnd > dataStart) {
        const data = buf.subarray(dataStart, dataEnd);
        entries.push({ path, dir: false, size: data.length, read: async () => data.slice() });
      } else {
        entries.push({ path, dir: false, size: 0, read: async () => new Uint8Array(0) });
      }
    } else {
      entries.push({ path, dir: true, size: 0, read: async () => new Uint8Array(0) });
    }
    pos = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!entries.length) warnings.push('TAR 中没有解析到文件');
  return { entries, warnings };
}
