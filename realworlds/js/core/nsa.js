/* NScripter NSA / ONScripter SAR 封包 */
import { u16beAt, u32beAt } from './bytes.js';
import { decodeName, ext, normPath } from './util.js';

export function isNSA(head) {
  return head && head.length > 3 && head[0] === 0x4e && head[1] === 0x53 && head[2] === 0x41;
}
export function looksLikeSAR(bytes) {
  if (!bytes || bytes.length < 10) return false;
  const count = u16beAt(bytes, 0);
  if (count <= 0 || count > 20000) return false;
  const base = u32beAt(bytes, 2);
  return base > 6 && base < bytes.length && base >= 10 * count;
}

/** NSA：大端索引；条目 = 名字\0 + 压缩类型(1) + 偏移(4) + 大小(4) + 原始大小(4) */
export function readNSA(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const warnings = [];
  let p = 0;
  if (u16beAt(bytes, 0) === 0) p = 2; // 某些 NSA 前面有 2 字节 0
  const basePos = p;
  const count = u16beAt(bytes, p); p += 2;
  if (count <= 0 || count > 300000) throw new Error('不是有效的 NSA 封包');
  const dataStart = basePos + u32beAt(bytes, p); p += 4;
  if (dataStart <= 0 || dataStart > bytes.length) throw new Error('NSA 数据段偏移越界');
  const entries = [];
  for (let i = 0; i < count; i++) {
    const nameStart = p;
    while (p < bytes.length && bytes[p] !== 0) p++;
    const name = decodeName(bytes.subarray(nameStart, p));
    p++;
    if (p + 13 > bytes.length) break;
    const compression = bytes[p]; p += 1;
    const offset = u32beAt(bytes, p) + dataStart; p += 4;
    const size = u32beAt(bytes, p); p += 4;
    const unpacked = u32beAt(bytes, p); p += 4;
    if (!name || offset < 0 || offset + size > bytes.length) { warnings.push(`NSA 条目越界：${name}`); continue; }
    entries.push({
      path: normPath(name),
      dir: false,
      size: unpacked || size,
      compression,
      async read() {
        if (compression !== 0) throw new Error(`NSA 压缩条目（类型 ${compression}）暂不支持`);
        return bytes.subarray(offset, offset + size);
      },
    });
  }
  return { entries, warnings };
}

/** SAR：大端；int16 数量 + uint32 基址 + [名字\0 + 偏移(4) + 大小(4)] */
export function readSAR(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const warnings = [];
  const count = u16beAt(bytes, 0);
  const base = u32beAt(bytes, 2);
  if (count <= 0 || count > 300000) throw new Error('不是有效的 SAR 封包');
  if (base <= 6 || base > bytes.length) throw new Error('SAR 数据段偏移越界');
  let p = 6;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const nameStart = p;
    while (p < bytes.length && bytes[p] !== 0) p++;
    const name = decodeName(bytes.subarray(nameStart, p));
    p++;
    if (p + 8 > bytes.length) break;
    const offset = u32beAt(bytes, p) + base; p += 4;
    const size = u32beAt(bytes, p); p += 4;
    if (!name || offset < 0 || offset + size > bytes.length) { warnings.push(`SAR 条目越界：${name}`); continue; }
    entries.push({
      path: normPath(name),
      dir: false,
      size,
      async read() { return bytes.subarray(offset, offset + size); },
    });
  }
  return { entries, warnings };
}

/** ONS 的 nscript.dat：整文件 XOR 0x84（也可能直接是明文） */
export function decodeNscriptData(bytes) {
  const xor = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) xor[i] = bytes[i] ^ 0x84;
  const sample = new TextDecoder('shift_jis').decode(xor.subarray(0, Math.min(4096, xor.length)));
  const plain = new TextDecoder('shift_jis').decode(bytes.subarray(0, Math.min(4096, bytes.length)));
  const score = (s) => (/^\s*\*define/m.test(s) ? 6 : 0) + (/^\s*\*start/m.test(s) ? 6 : 0) +
    (/^\s*(game|bg|ld|select|goto|jump|click|wait|monocro)\b/m.test(s) ? 3 : 0) +
    (s.includes('\u0000') ? -8 : 0);
  return score(sample) >= score(plain) ? xor : bytes;
}
