/* ZIP 读取器：中央目录 + ZIP64 + deflate/store，文件名编码自动识别 */
import { ByteReader, u32leAt } from './bytes.js';
import { inflateRaw } from './codec.js';
import { decodeName, normPath } from './util.js';

const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOC_SIG = 0x07064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32leAt(buf, i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * @returns {Promise<{entries: Array, warnings: string[]}>}
 * entry: { path, dir, size, compSize, method, encrypted, crc, offset, read(): Promise<Uint8Array> }
 */
export async function readZip(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const warnings = [];
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP：找不到中央目录');

  let count = u16(buf, eocd + 10);
  let cdSize = u32leAt(buf, eocd + 12);
  let cdOffset = u32leAt(buf, eocd + 16);

  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const locPos = eocd - 20;
    if (locPos >= 0 && u32leAt(buf, locPos) === EOCD64_LOC_SIG) {
      const e64 = Number(new DataView(buf.buffer, buf.byteOffset).getBigUint64(locPos + 8, true));
      if (u32leAt(buf, e64) === EOCD64_SIG) {
        const dv = new DataView(buf.buffer, buf.byteOffset);
        count = Number(dv.getBigUint64(e64 + 32, true));
        cdSize = Number(dv.getBigUint64(e64 + 40, true));
        cdOffset = Number(dv.getBigUint64(e64 + 48, true));
      }
    }
  }

  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length) break;
    if (u32leAt(buf, pos) !== CEN_SIG) { warnings.push('中央目录损坏，提前结束'); break; }
    const flags = u16(buf, pos + 8);
    const method = u16(buf, pos + 10);
    const crc = u32leAt(buf, pos + 16);
    let compSize = u32leAt(buf, pos + 20);
    let size = u32leAt(buf, pos + 24);
    const nameLen = u16(buf, pos + 28);
    const extraLen = u16(buf, pos + 30);
    const commentLen = u16(buf, pos + 32);
    let localOffset = u32leAt(buf, pos + 42);
    const rawName = buf.subarray(pos + 46, pos + 46 + nameLen);
    const extra = buf.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen);

    // ZIP64 扩展字段
    let ep = 0;
    while (ep + 4 <= extra.length) {
      const id = u16(extra, ep);
      const len = u16(extra, ep + 2);
      const body = extra.subarray(ep + 4, ep + 4 + len);
      if (id === 0x0001) {
        let q = 0;
        const dv = new DataView(body.buffer, body.byteOffset, body.length);
        if (size === 0xffffffff && q + 8 <= body.length) { size = Number(dv.getBigUint64(q, true)); q += 8; }
        if (compSize === 0xffffffff && q + 8 <= body.length) { compSize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (localOffset === 0xffffffff && q + 8 <= body.length) { localOffset = Number(dv.getBigUint64(q, true)); q += 8; }
      }
      ep += 4 + len;
    }

    let utf8Name = null;
    if (!(flags & 0x0800)) {
      let ep2 = 0;
      while (ep2 + 4 <= extra.length) {
        const id = u16(extra, ep2);
        const len = u16(extra, ep2 + 2);
        if (id === 0x7075 && len >= 5) {
          const body = extra.subarray(ep2 + 4, ep2 + 4 + len);
          try { utf8Name = new TextDecoder('utf-8').decode(body.subarray(5)); } catch { /* ignore */ }
        }
        ep2 += 4 + len;
      }
    }
    const rawPathStr = utf8Name || decodeName(rawName);
    const isDirName = /[\\/]$/.test(rawPathStr);
    const path = normPath(rawPathStr);
    if (!path) { pos += 46 + nameLen + extraLen + commentLen; continue; }

    // 数据偏移：读本地头
    let dataOffset = -1;
    if (localOffset + 30 <= buf.length && u32leAt(buf, localOffset) === LOC_SIG) {
      const lnLen = u16(buf, localOffset + 26);
      const leLen = u16(buf, localOffset + 28);
      dataOffset = localOffset + 30 + lnLen + leLen;
    }
    if (dataOffset < 0 || dataOffset + compSize > buf.length) {
      warnings.push(`条目越界，跳过：${path}`);
      pos += 46 + nameLen + extraLen + commentLen;
      continue;
    }
    const encrypted = !!(flags & 0x0001);
    const dir = isDirName;
    entries.push({
      path,
      dir,
      size,
      compSize,
      method,
      crc,
      encrypted,
      offset: dataOffset,
      async read() {
        if (encrypted) throw new Error('ZIP 已加密，暂不支持');
        const raw = buf.subarray(dataOffset, dataOffset + compSize);
        if (method === 0) return raw.slice();
        if (method === 8) return inflateRaw(raw);
        throw new Error(`不支持的压缩方式 ${method}`);
      },
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, warnings };
}

function u16(b, o) { return b[o] | (b[o + 1] << 8); }

export function isZip(head) {
  return head && head.length > 4 && head[0] === 0x50 && head[1] === 0x4b &&
    (head[2] === 3 || head[2] === 5 || head[2] === 7);
}
