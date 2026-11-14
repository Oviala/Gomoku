/* Ren'Py RPA 封包（RPA-3.0 / 3.2）：zlib 压缩的 Python pickle 索引 */
import { ByteReader } from './bytes.js';
import { inflateZlib } from './codec.js';
import { decodeName, normPath } from './util.js';

export function isRPA(head) {
  if (!head || head.length < 8) return false;
  const s = String.fromCharCode(...head.subarray(0, 8));
  return /^RPA-[0-9]\.[0-9] $/.test(s) || s.startsWith('RPA-3');
}

/* ---------------- Python pickle 最小实现（只覆盖 RPA 索引用到的 opcode） ---------------- */
const OP = {
  PROTO: 0x80, FRAME: 0x95, STOP: 0x2e, MARK: 0x28, NONE: 0x4e, NEWTRUE: 0x88, NEWFALSE: 0x89,
  EMPTY_DICT: 0x7d, EMPTY_LIST: 0x5d, EMPTY_TUPLE: 0x29, APPEND: 0x61, APPENDS: 0x65,
  SETITEM: 0x73, SETITEMS: 0x75, TUPLE: 0x74, TUPLE1: 0x85, TUPLE2: 0x86, TUPLE3: 0x87,
  BININT: 0x4a, BININT1: 0x4b, BININT2: 0x4d, LONG1: 0x8a, LONG4: 0x8b, BINFLOAT: 0x47,
  SHORT_BINBYTES: 0x43, BINBYTES: 0x42, BINBYTES8: 0x8e,
  SHORT_BINUNICODE: 0x8c, BINUNICODE: 0x58, BINUNICODE8: 0x8d,
  BINPUT: 0x71, LONG_BINPUT: 0x72, MEMOIZE: 0x94, GET: 0x67, BINGET: 0x68, LONG_BINGET: 0x6a,
  POP: 0x30, DUP: 0x32, STRING: 0x53, BINSTRING: 0x54, SHORT_BINSTRING: 0x55,
};

class Pickle {
  constructor(bytes) { this.b = bytes; this.p = 0; this.stack = []; this.memo = new Map(); }
  read(n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  i32() { const dv = new DataView(this.b.buffer, this.b.byteOffset + this.p, 4); const v = dv.getInt32(0, true); this.p += 4; return v; }
  u32() { const dv = new DataView(this.b.buffer, this.b.byteOffset + this.p, 4); const v = dv.getUint32(0, true); this.p += 4; return v; }
  u64() { const dv = new DataView(this.b.buffer, this.b.byteOffset + this.p, 8); const v = Number(dv.getBigUint64(0, true)); this.p += 8; return v; }
  load() {
    while (this.p < this.b.length) {
      const op = this.b[this.p++];
      switch (op) {
        case OP.PROTO: this.p += 1; break;
        case OP.FRAME: this.p += 8; break;
        case OP.STOP: return this.stack.pop();
        case OP.MARK: this.stack.push({ __mark: true }); break;
        case OP.NONE: this.stack.push(null); break;
        case OP.NEWTRUE: this.stack.push(true); break;
        case OP.NEWFALSE: this.stack.push(false); break;
        case OP.EMPTY_DICT: this.stack.push(new Map()); break;
        case OP.EMPTY_LIST: this.stack.push([]); break;
        case OP.EMPTY_TUPLE: this.stack.push([]); break;
        case OP.BININT: this.stack.push(this.i32()); break;
        case OP.BININT1: this.stack.push(this.b[this.p++]); break;
        case OP.BININT2: { const v = this.b[this.p] | (this.b[this.p + 1] << 8); this.p += 2; this.stack.push(v); break; }
        case OP.LONG1: { const n = this.b[this.p++]; const v = this._long(this.read(n)); this.stack.push(v); break; }
        case OP.LONG4: { const n = this.i32(); const v = this._long(this.read(Math.abs(n))); this.stack.push(v); break; }
        case OP.BINFLOAT: { const dv = new DataView(this.b.buffer, this.b.byteOffset + this.p, 8); this.stack.push(dv.getFloat64(0, false)); this.p += 8; break; }
        case OP.SHORT_BINBYTES: { const n = this.b[this.p++]; this.stack.push(this.read(n).slice()); break; }
        case OP.BINBYTES: { const n = this.u32(); this.stack.push(this.read(n).slice()); break; }
        case OP.BINBYTES8: { const n = this.u64(); this.stack.push(this.read(n).slice()); break; }
        case OP.SHORT_BINUNICODE: { const n = this.b[this.p++]; this.stack.push(new TextDecoder('utf-8').decode(this.read(n))); break; }
        case OP.BINUNICODE: { const n = this.u32(); this.stack.push(new TextDecoder('utf-8').decode(this.read(n))); break; }
        case OP.BINUNICODE8: { const n = this.u64(); this.stack.push(new TextDecoder('utf-8').decode(this.read(n))); break; }
        case OP.STRING: { const line = this._line(); this.stack.push(line.replace(/^'|'$/g, '').replace(/\\(.)/g, '$1')); break; }
        case OP.SHORT_BINSTRING: { const n = this.b[this.p++]; this.stack.push(this.read(n).slice()); break; }
        case OP.BINSTRING: { const n = this.u32(); this.stack.push(this.read(n).slice()); break; }
        case OP.TUPLE: this.stack.push(this._popMark()); break;
        case OP.TUPLE1: { const a = this.stack.pop(); this.stack.push([a]); break; }
        case OP.TUPLE2: { const b = this.stack.pop(), a = this.stack.pop(); this.stack.push([a, b]); break; }
        case OP.TUPLE3: { const c = this.stack.pop(), b = this.stack.pop(), a = this.stack.pop(); this.stack.push([a, b, c]); break; }
        case OP.APPEND: { const v = this.stack.pop(); const list = this.stack[this.stack.length - 1]; if (Array.isArray(list)) list.push(v); break; }
        case OP.APPENDS: { const items = this._popMark(); const list = this.stack[this.stack.length - 1]; if (Array.isArray(list)) list.push(...items); break; }
        case OP.SETITEM: { const v = this.stack.pop(); const k = this.stack.pop(); const d = this.stack[this.stack.length - 1]; if (d instanceof Map) d.set(this._key(k), v); break; }
        case OP.SETITEMS: {
          const items = this._popMark();
          const d = this.stack[this.stack.length - 1];
          if (d instanceof Map) for (let i = 0; i + 1 < items.length; i += 2) d.set(this._key(items[i]), items[i + 1]);
          break;
        }
        case OP.BINPUT: this.memo.set(this.b[this.p++], this.stack[this.stack.length - 1]); break;
        case OP.LONG_BINPUT: { const idx = this.u32(); this.memo.set(idx, this.stack[this.stack.length - 1]); break; }
        case OP.MEMOIZE: this.memo.set(this.memo.size, this.stack[this.stack.length - 1]); break;
        case OP.BINGET: { const idx = this.b[this.p++]; this.stack.push(this.memo.get(idx)); break; }
        case OP.LONG_BINGET: { const idx = this.u32(); this.stack.push(this.memo.get(idx)); break; }
        case OP.GET: { const idx = this.b[this.p++]; this.stack.push(this.memo.get(idx)); break; }
        case OP.POP: this.stack.pop(); break;
        case OP.DUP: this.stack.push(this.stack[this.stack.length - 1]); break;
        default: return this.stack.pop(); // 遇到未知 opcode，尽量返回已有结果
      }
    }
    return this.stack.pop();
  }
  _key(k) {
    if (k instanceof Uint8Array) return new TextDecoder('utf-8').decode(k);
    return k;
  }
  _popMark() {
    const out = [];
    while (this.stack.length) {
      const v = this.stack.pop();
      if (v && v.__mark) break;
      out.push(v);
    }
    return out.reverse();
  }
  _line() {
    const start = this.p;
    while (this.p < this.b.length && this.b[this.p] !== 0x0a) this.p++;
    const s = new TextDecoder('utf-8').decode(this.b.subarray(start, this.p));
    this.p++;
    return s;
  }
  _long(bytes) {
    let v = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
    const n = Number(v);
    return n;
  }
}

/* ---------------- RPA 读取 ---------------- */
export async function readRPA(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 8));
  if (!/^RPA-3\.[0-9] $/.test(head)) throw new Error(`不支持的 RPA 版本：${head}`);
  const offsetHex = new TextDecoder('latin1').decode(bytes.subarray(8, 24));
  const indexOffset = parseInt(offsetHex, 16);
  if (!Number.isFinite(indexOffset) || indexOffset <= 0 || indexOffset >= bytes.length) throw new Error('RPA 索引偏移异常');
  let key = 0;
  const keyHex = new TextDecoder('latin1').decode(bytes.subarray(25, 33));
  if (/^[0-9a-fA-F]{8}$/.test(keyHex)) key = parseInt(keyHex, 16) >>> 0;
  const indexBytes = await inflateZlib(bytes.subarray(indexOffset));
  const dict = new Pickle(indexBytes).load();
  const warnings = [];
  const entries = [];
  const keyBig = BigInt(key);
  for (const [name, value] of dict) {
    const tuples = Array.isArray(value) ? value : [value];
    for (const t of tuples) {
      if (!Array.isArray(t) || t.length < 2) continue;
      const offset = Number(BigInt(t[0]) ^ keyBig);
      const size = Number(BigInt(t[1]) ^ keyBig);
      const prefix = t[2] instanceof Uint8Array ? t[2] : null;
      if (offset < 0 || offset > bytes.length) { warnings.push(`RPA 条目越界：${name}`); continue; }
      const len = Math.max(0, Math.min(size, bytes.length - offset));
      entries.push({
        path: normPath(name),
        dir: false,
        size: len + (prefix ? prefix.length : 0),
        async read() {
          const out = new Uint8Array((prefix ? prefix.length : 0) + len);
          if (prefix) out.set(prefix, 0);
          out.set(bytes.subarray(offset, offset + len), prefix ? prefix.length : 0);
          return out;
        },
      });
    }
  }
  return { entries, warnings, meta: { key } };
}

export { Pickle };
