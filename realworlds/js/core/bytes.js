/* 小端/大端二进制读取器 —— 所有封包解析共用 */

export class ByteReader {
  constructor(data, offset = 0, length = null) {
    if (data instanceof ArrayBuffer) data = new Uint8Array(data);
    this.buf = data;
    this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.start = offset;
    this.pos = offset;
    this.end = length == null ? data.byteLength : Math.min(data.byteLength, offset + length);
  }
  get remaining() { return this.end - this.pos; }
  get eof() { return this.pos >= this.end; }
  need(n) { if (this.pos + n > this.end) throw new Error(`读取越界：需要 ${n} 字节，剩 ${this.end - this.pos}`); }
  u8() { this.need(1); return this.dv.getUint8(this.pos++); }
  i8() { this.need(1); return this.dv.getInt8(this.pos++); }
  u16le() { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16le() { this.need(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32le() { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i32le() { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  u64le() { this.need(8); const v = this.dv.getBigUint64(this.pos, true); this.pos += 8; return Number(v); }
  i64le() { this.need(8); const v = this.dv.getBigInt64(this.pos, true); this.pos += 8; return Number(v); }
  u16be() { this.need(2); const v = this.dv.getUint16(this.pos, false); this.pos += 2; return v; }
  i16be() { this.need(2); const v = this.dv.getInt16(this.pos, false); this.pos += 2; return v; }
  u32be() { this.need(4); const v = this.dv.getUint32(this.pos, false); this.pos += 4; return v; }
  bytes(n) { this.need(n); const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  skip(n) { this.need(n); this.pos += n; }
  seek(p) { this.pos = p; }
  text(n, enc = 'utf-8') { return new TextDecoder(enc).decode(this.bytes(n)); }
  cstr(enc = 'utf-8', max = 4096) {
    const start = this.pos;
    let i = this.pos;
    while (i < this.end && this.buf[i] !== 0 && i - start < max) i++;
    const out = new TextDecoder(enc).decode(this.buf.subarray(start, i));
    this.pos = Math.min(i + 1, this.end);
    return out;
  }
  clone() { const r = new ByteReader(this.buf, this.start, this.end - this.start); r.seek(this.pos); return r; }
}

export function u16leAt(b, o) { return b[o] | (b[o + 1] << 8); }
export function u32leAt(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
export function u32beAt(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
export function u16beAt(b, o) { return (b[o] << 8) | b[o + 1]; }
export function u64leAt(b, o) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]);
  return Number(v);
}
export function asciiAt(b, o, s) {
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
}
export function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
