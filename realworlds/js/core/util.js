/* 通用工具：路径 / 编码猜测 / 文件类型 / 格式化 */

export function uid(prefix = 'g') {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function ext(path = '') {
  const m = /\.([^./\\]+)$/.exec(path);
  return m ? m[1].toLowerCase() : '';
}
export function basename(path = '') { return path.replace(/\\/g, '/').split('/').pop() || ''; }
export function stem(path = '') { return basename(path).replace(/\.[^.]+$/, ''); }
export function dirname(path = '') {
  const p = path.replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
export function joinPath(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
}
export function normPath(path = '') {
  let p = String(path).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '');
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}
export function stripCommonRoot(paths) {
  if (!paths.length) return { root: '', paths };
  const split = paths.map((p) => p.split('/'));
  let depth = 0;
  const first = split[0];
  // 只允许剥离“所有条目都在同一个目录下”的情况
  outer: while (depth < first.length - 1) {
    const seg = first[depth];
    for (const parts of split) {
      if (parts.length <= depth + 1 || parts[depth] !== seg) break outer;
    }
    depth++;
  }
  if (depth === 0) return { root: '', paths };
  const root = first.slice(0, depth).join('/');
  return { root, paths: paths.map((p) => p.split('/').slice(depth).join('/')) };
}

/* ------------------------------------------------------------------ */
/* 文本 / 编码                                                          */
/* ------------------------------------------------------------------ */
const decoderCache = new Map();
function decoder(enc, fatal = true) {
  const key = enc + (fatal ? '!' : '');
  if (!decoderCache.has(key)) {
    try { decoderCache.set(key, new TextDecoder(enc, { fatal })); }
    catch { decoderCache.set(key, null); }
  }
  return decoderCache.get(key);
}
export const CJK_ENCODINGS = ['utf-8', 'shift_jis', 'gbk', 'euc-kr', 'big5'];

export function decodeStrict(bytes, enc) {
  const d = decoder(enc, true);
  if (!d) return null;
  try { return d.decode(bytes); } catch { return null; }
}
export function decodeLoose(bytes, enc = 'utf-8') {
  try { return new TextDecoder(enc).decode(bytes); } catch { return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes); }
}

/** 猜一段“文件名/短文本”字节的编码（galgame 里 Shift-JIS / GBK 很常见） */
export function decodeName(bytes) {
  if (!bytes || !bytes.length) return '';
  let b = bytes;
  const nul = b.indexOf(0);
  if (nul >= 0) b = b.subarray(0, nul);
  if (!b.length) return '';
  const utf8 = decodeStrict(b, 'utf-8');
  if (utf8 != null && (utf8 === '' || scoreText(utf8) >= 0)) return utf8;
  let best = null;
  for (const enc of ['shift_jis', 'gbk', 'euc-kr', 'big5']) {
    const t = decodeStrict(b, enc);
    if (t == null) continue;
    const s = scoreText(t);
    if (!best || s > best.score) best = { text: t, score: s };
  }
  if (best && best.score > 0) return best.text;
  return best ? best.text : new TextDecoder('utf-8').decode(b);
}

const KANA = /[\u3040-\u30ff]/;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const HANGUL = /[\uac00-\ud7af]/;
const FULLWIDTH = /[\uff00-\uffef\u3000-\u303f]/;
export function scoreText(text) {
  let good = 0, bad = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c === 0xfffd) { bad += 6; continue; }
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) { bad += 5; continue; }
    if (c >= 0xff61 && c <= 0xff9f) { bad += 3; continue; } // 半角片假名：常见于 GBK 误判成 Shift-JIS
    if (c >= 0x3040 && c <= 0x30ff) good += 3;
    else if (c >= 0x4e00 && c <= 0x9fff) good += 1;
    else if (c >= 0x3000 && c <= 0x303f) good += 1.2;
    else if (c >= 0xac00 && c <= 0xd7af) good += 2;
    else if (c >= 0xff00 && c <= 0xffef) good += 1;
    else if (c >= 0x80) good += 0.15;
    else good += 0.05;
  }
  return good - bad;
}

/** 读脚本正文：BOM / nscript.dat 的 XOR 0x84 / 日文或中文编码 */
export function decodeScriptBytes(bytes) {
  if (!bytes || !bytes.length) return '';
  let b = bytes;
  // BOM
  if (b.length > 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length > 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  const sampleBytes = b.subarray(0, Math.min(b.length, 262144));
  // 严格 UTF-8 通过 = 极强的正信号：GBK/Shift-JIS 文本几乎不可能整段构成合法 UTF-8。
  // 没有这条，纯中文 UTF-8 脚本会因为「gbk 先验分高」被解成乱码（蝉时雨 → 铦夋椂闆）。
  const strictUtf8 = decodeStrict(sampleBytes, 'utf-8');
  const utf8Clean = strictUtf8 != null && /[^\x00-\x7f]/.test(strictUtf8);
  const candidates = [];
  for (const enc of ['utf-8', 'shift_jis', 'gbk', 'gb18030', 'euc-kr', 'big5']) {
    let sample;
    try { sample = new TextDecoder(enc).decode(sampleBytes); } catch { continue; }
    const score = scoreText(sample);
    const kana = (sample.match(KANA) || []).length;
    const hangul = (sample.match(HANGUL) || []).length;
    const han = (sample.match(HAN) || []).length;
    const halfwidth = (sample.match(/[\uff61-\uff9f]/g) || []).length;
    const commonCn = (sample.match(/[的了是在不我他她你说就都而及与着或一个这那么什么也很有和到对会好看想要给种样]/g) || []).length;
    const commonJp = (sample.match(/[のはをにがでてとしれさかなるすたくなことだいまも]/g) || []).length;
    const fwPunct = (sample.match(/[，。！？；：、…「」『』（）]/g) || []).length;
    // 编码先验：这个播放器的目标文本是中文/日文，韩文游戏极少
    const prior = { 'utf-8': 2, shift_jis: 4, gbk: 7, gb18030: 7, 'euc-kr': -8, big5: 2 }[enc] || 0;
    let bonus = prior - halfwidth * 4 + commonCn * 2.5 + fwPunct * 1.2;
    if (enc === 'shift_jis') bonus += kana * 3 + commonJp * 1.5 - han * 0.15;
    if (enc === 'euc-kr') bonus += hangul * 0.4 - han * 0.5;
    if (enc === 'gbk' || enc === 'gb18030' || enc === 'big5') bonus += han * 0.6 - kana * 3;
    if (enc === 'utf-8') bonus += han * 0.4 + (utf8Clean ? 12 : 0);
    candidates.push({ enc, score: score + bonus });
  }
  candidates.sort((x, y) => y.score - x.score);
  const pick = candidates.find((c) => c.score > 0) || candidates[0];
  if (pick) {
    try { return stripBom(new TextDecoder(pick.enc).decode(b)); } catch { /* fallthrough */ }
  }
  return stripBom(new TextDecoder('utf-8').decode(b));
}
function stripBom(s) { return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; }

/* ------------------------------------------------------------------ */
/* 文件类型                                                            */
/* ------------------------------------------------------------------ */
export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tga', 'avif', 'jxl']);
export const AUDIO_EXT = new Set(['ogg', 'oga', 'opus', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'wma', 'mid', 'midi']);
export const VIDEO_EXT = new Set(['mp4', 'webm', 'mkv', 'avi', 'wmv', 'mpg', 'mpeg', 'mov']);
export const FONT_EXT = new Set(['ttf', 'otf', 'ttc', 'woff', 'woff2']);
export const SCRIPT_EXT = new Set(['rpy', 'rpym', 'ks', 'tjs', 'nsc', 'txt', 'scn', 'asd']);
export const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz4', 'iso']);
export const isImage = (p) => IMAGE_EXT.has(ext(p));
export const isAudio = (p) => AUDIO_EXT.has(ext(p));
export const isVideo = (p) => VIDEO_EXT.has(ext(p));
export const isFont = (p) => FONT_EXT.has(ext(p));
export const isScript = (p) => SCRIPT_EXT.has(ext(p));
export const isArchiveName = (p) => ARCHIVE_EXT.has(ext(p));

const MIME = {
  html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript',
  css: 'text/css', json: 'application/json', wasm: 'application/wasm',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml',
  tga: 'image/x-tga',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg',
  wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  mp4: 'video/mp4', webm: 'video/webm',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  txt: 'text/plain',
};
export function mimeFor(path) { return MIME[ext(path)] || 'application/octet-stream'; }

/* ------------------------------------------------------------------ */
/* 格式化                                                              */
/* ------------------------------------------------------------------ */
export function formatBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}
export function formatDuration(ms) {
  if (!ms || ms < 1000) return '0 分钟';
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  if (h <= 0) return `${Math.max(1, m)} 分钟`;
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
}
export function formatHours(ms) {
  if (!ms) return '0';
  const h = ms / 3600000;
  return h >= 10 ? h.toFixed(1) : h.toFixed(1);
}
export function formatRelative(ts) {
  if (!ts) return '未开始';
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3600_000) return Math.floor(d / 60_000) + ' 分钟前';
  if (d < 86400_000) return Math.floor(d / 3600_000) + ' 小时前';
  if (d < 86400_000 * 2) return '昨天';
  if (d < 86400_000 * 30) return Math.floor(d / 86400_000) + ' 天前';
  const dt = new Date(ts);
  return `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`;
}
export function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
