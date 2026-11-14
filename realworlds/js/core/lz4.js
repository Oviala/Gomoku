/* LZ4 解压：支持 LZ4 Frame（0x184D2204）、Legacy（0x184C2102）与 skippable 帧
   帧内块可以压缩也可以原样存储；校验和只跳过不验证 */
const FRAME_MAGIC = 0x184d2204;
const LEGACY_MAGIC = 0x184c2102;
const SKIP_MIN = 0x184d2a50;
const SKIP_MAX = 0x184d2a5f;

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]);
  return Number(v);
};

export function isLZ4(head) {
  if (!head || head.length < 4) return false;
  const m = u32(head, 0);
  return m === FRAME_MAGIC || m === LEGACY_MAGIC || (m >= SKIP_MIN && m <= SKIP_MAX);
}

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

/** LZ4 block 解压，返回实际写出的字节数 */
function decompressBlock(src, sp, len, dst) {
  const end = sp + len;
  let dp = 0;
  while (sp < end) {
    const token = src[sp++];
    let litLen = token >>> 4;
    if (litLen === 15) {
      let b;
      do { b = src[sp++]; litLen += b; } while (b === 255 && sp < end);
    }
    if (sp + litLen > end) throw new Error('LZ4 数据损坏：literal 越界');
    for (let i = 0; i < litLen; i++) dst[dp++] = src[sp++];
    if (sp >= end) break;
    if (sp + 2 > end) throw new Error('LZ4 数据损坏：缺少 offset');
    const offset = src[sp] | (src[sp + 1] << 8);
    sp += 2;
    if (offset === 0 || offset > dp) throw new Error('LZ4 数据损坏：非法 offset');
    let matchLen = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      let b;
      do { b = src[sp++]; matchLen += b; } while (b === 255 && sp < end);
    }
    let mp = dp - offset;
    for (let i = 0; i < matchLen; i++) dst[dp++] = dst[mp++];
  }
  return dp;
}

function decodeFrame(src, start) {
  let p = start + 4;
  if (p + 3 > src.length) throw new Error('LZ4 帧不完整');
  const flg = src[p++];
  const bd = src[p++];
  if ((flg >>> 6) !== 1) throw new Error('不支持的 LZ4 版本');
  const blockChecksum = !!(flg & 0x10);
  const hasContentSize = !!(flg & 0x08);
  const contentChecksum = !!(flg & 0x04);
  const hasDict = !!(flg & 0x01);
  let contentSize = 0;
  if (hasContentSize) { contentSize = u64(src, p); p += 8; }
  if (hasDict) p += 4;
  p += 1; // header checksum
  const bMax = [0, 0, 0, 0, 64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024][(bd >>> 4) & 7] || 4 * 1024 * 1024;
  const chunks = [];
  let total = 0;
  while (p + 4 <= src.length) {
    const size = u32(src, p);
    p += 4;
    if (size === 0) break; // EndMark
    const uncompressed = !!(size & 0x80000000);
    const blockLen = size & 0x7fffffff;
    if (p + blockLen > src.length) throw new Error('LZ4 块越界');
    if (uncompressed) {
      chunks.push(src.slice(p, p + blockLen));
      total += blockLen;
    } else {
      const dst = new Uint8Array(bMax);
      const n = decompressBlock(src, p, blockLen, dst);
      chunks.push(dst.subarray(0, n));
      total += n;
    }
    p += blockLen;
    if (blockChecksum) p += 4;
  }
  if (contentChecksum) p += 4;
  if (contentSize && total !== contentSize) {
    // 大小不一致通常说明数据损坏，但依然返回已解出的内容
  }
  return { out: concat(chunks), next: p };
}

function decodeLegacy(src, start) {
  let p = start + 4;
  const chunks = [];
  while (p + 4 <= src.length) {
    const size = u32(src, p);
    p += 4;
    if (size === 0) break;
    if (p + size > src.length) throw new Error('LZ4 legacy 块越界');
    const dst = new Uint8Array(8 * 1024 * 1024);
    const n = decompressBlock(src, p, size, dst);
    chunks.push(dst.subarray(0, n));
    p += size;
  }
  return { out: concat(chunks), next: p };
}

/** @returns {Uint8Array} */
export function decodeLZ4(input) {
  const src = input instanceof Uint8Array ? input : new Uint8Array(input);
  const chunks = [];
  let p = 0;
  while (p + 4 <= src.length) {
    const magic = u32(src, p);
    if (magic === FRAME_MAGIC) {
      const r = decodeFrame(src, p);
      chunks.push(r.out);
      p = r.next;
    } else if (magic === LEGACY_MAGIC) {
      const r = decodeLegacy(src, p);
      chunks.push(r.out);
      p = r.next;
    } else if (magic >= SKIP_MIN && magic <= SKIP_MAX && p + 8 <= src.length) {
      p += 8 + u32(src, p + 4);
    } else {
      break;
    }
  }
  if (!chunks.length) throw new Error('不是有效的 LZ4 数据');
  return concat(chunks);
}
