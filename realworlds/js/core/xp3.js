/* KiriKiri XP3 封包（含 .exe 自解压包内嵌索引） */
import { ByteReader, concatBytes, u32leAt, u64leAt } from './bytes.js';
import { inflateZlib } from './codec.js';
import { normPath } from './util.js';

export const XP3_MAGIC = new Uint8Array([0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01]);

export function isXP3(head) {
  if (!head || head.length < XP3_MAGIC.length) return false;
  for (let i = 0; i < XP3_MAGIC.length; i++) if (head[i] !== XP3_MAGIC[i]) return false;
  return true;
}

export function findBytes(buf, needle, from = 0, to = buf.length) {
  const end = Math.min(to, buf.length) - needle.length;
  outer: for (let i = from; i <= end; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const utf16 = new TextDecoder('utf-16le');

export async function readXP3(input, { onProgress } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const base = findBytes(bytes, XP3_MAGIC, 0, Math.min(bytes.length, 4 * 1024 * 1024));
  if (base < 0) throw new Error('不是有效的 XP3 封包');
  const warnings = [];

  let dirOffset = base + u64leAt(bytes, base + 11);
  if (dirOffset < 0 || dirOffset >= bytes.length) throw new Error('XP3 索引偏移越界');
  if (u32leAt(bytes, dirOffset) === 0x80) {
    dirOffset = base + u64leAt(bytes, dirOffset + 9);
  }
  const headerType = bytes[dirOffset];
  let headerBytes;
  if (headerType === 0) {
    const size = u64leAt(bytes, dirOffset + 1);
    headerBytes = bytes.subarray(dirOffset + 9, dirOffset + 9 + size);
  } else if (headerType === 1) {
    const packed = u64leAt(bytes, dirOffset + 1);
    const size = u64leAt(bytes, dirOffset + 9);
    if (packed <= 0 || dirOffset + 17 + packed > bytes.length) throw new Error('XP3 索引段越界');
    headerBytes = await inflateZlib(bytes.subarray(dirOffset + 17, dirOffset + 17 + packed));
    if (!headerBytes.length && size) warnings.push('XP3 索引解压为空');
  } else {
    throw new Error(`未知的 XP3 索引类型：${headerType}`);
  }

  const entries = [];
  const hr = new ByteReader(headerBytes);
  let guard = 0;
  while (hr.remaining >= 12 && guard++ < 200000) {
    const sig = hr.u32le();
    const entrySize = hr.i64le();
    if (entrySize < 0 || hr.pos + entrySize > hr.end) break;
    const entryEnd = hr.pos + entrySize;
    if (sig === 0x656c6946 /* File */) {
      let name = '';
      let encrypted = false;
      let unpacked = 0;
      const segments = [];
      while (hr.pos + 12 <= entryEnd) {
        const section = hr.u32le();
        const sectionSize = hr.i64le();
        const secEnd = Math.min(hr.pos + sectionSize, entryEnd);
        if (section === 0x6f666e69 /* info */) {
          try {
            encrypted = hr.u32le() !== 0;
            unpacked = hr.i64le();
            hr.i64le(); // packed size
            const nameLen = hr.u16le();
            if (nameLen > 0 && nameLen <= 0x1000 && hr.pos + nameLen * 2 <= secEnd) {
              name = utf16.decode(hr.bytes(nameLen * 2)).replace(/\0+$/, '');
            }
          } catch { /* ignore malformed info */ }
        } else if (section === 0x6d676573 /* segm */) {
          const count = Math.floor(sectionSize / 0x1c);
          for (let i = 0; i < count; i++) {
            const compressed = hr.i32le() !== 0;
            const offset = base + hr.i64le();
            const size = hr.i64le();
            const packedSize = hr.i64le();
            if (offset < 0 || offset + packedSize > bytes.length) { warnings.push(`XP3 段越界：${name}`); break; }
            segments.push({ compressed, offset, size, packedSize });
          }
        }
        hr.seek(secEnd);
      }
      if (name && segments.length) {
        const path = normPath(name);
        if (path) {
          entries.push({
            path,
            dir: false,
            encrypted,
            size: segments.reduce((n, s) => n + s.size, 0) || unpacked,
            async read() {
              if (encrypted) throw new Error('该 XP3 条目被加密（需要对应的 crypt 方案），暂不支持');
              const chunks = [];
              for (const s of segments) {
                let data = bytes.subarray(s.offset, s.offset + s.packedSize);
                if (s.compressed) data = await inflateZlib(data);
                chunks.push(data);
              }
              return chunks.length === 1 ? chunks[0] : concatBytes(chunks);
            },
          });
          if (entries.length % 50 === 0) onProgress?.({ message: `解析 XP3 索引 ${entries.length}`, done: entries.length });
        }
      }
    }
    hr.seek(entryEnd);
  }
  if (!entries.length) warnings.push('XP3 中没有解析到条目（可能是加密封包）');
  const encryptedCount = entries.filter((e) => e.encrypted).length;
  if (encryptedCount) warnings.push(`XP3 中有 ${encryptedCount} 个加密条目，已跳过内容`);
  return { entries, warnings };
}
