/* 资源索引：把脚本里引用的背景 / 立绘 / 音乐名字映射到实际文件 */
import { basename, ext, isAudio, isImage } from './util.js';

const AUDIO_EXTS = ['ogg', 'oga', 'opus', 'mp3', 'wav', 'flac', 'm4a', 'aac'];

export function normName(s = '') {
  return String(s)
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^.*\//, '')
    .replace(/\.[a-z0-9]{2,5}$/, '')
    .replace(/[\s_\-・]+/g, ' ')
    .trim();
}

export function buildAssetIndex(paths) {
  const index = new Map(); // normalized name -> [paths]
  const pathIndex = new Map();
  const push = (key, p) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(p);
  };
  for (const p of paths) {
    if (!isImage(p) && !isAudio(p)) continue;
    pathIndex.set(p.toLowerCase(), p);
    push(normName(basename(p)), p);
    push(normName(p.replace(/^__unpacked__\//, '')), p);
  }
  return { index, pathIndex, paths };
}

function pick(candidates, wantAudio) {
  if (!candidates || !candidates.length) return null;
  const filtered = candidates.filter((p) => (wantAudio ? isAudio(p) : isImage(p)));
  const list = filtered.length ? filtered : candidates;
  // 优先普通路径（非 __unpacked__），再优先短路径
  list.sort((a, b) => {
    const ua = a.startsWith('__unpacked__') ? 1 : 0;
    const ub = b.startsWith('__unpacked__') ? 1 : 0;
    if (ua !== ub) return ua - ub;
    return a.length - b.length;
  });
  return list[0];
}

/**
 * @param {string[]} paths 清单里的所有文件路径
 */
export function makeResolver(paths) {
  const { index } = buildAssetIndex(paths);
  const allNames = [...index.keys()];

  function lookup(name, wantAudio = false) {
    if (!name) return null;
    const n = normName(name);
    if (!n) return null;
    if (index.has(n)) {
      const hit = pick(index.get(n), wantAudio);
      if (hit) return hit;
    }
    // 名字里带扩展名（如 bg_dusk.jpg）
    const withoutExt = normName(name.replace(/\.[a-z0-9]{2,5}$/i, ''));
    if (index.has(withoutExt)) {
      const hit = pick(index.get(withoutExt), wantAudio);
      if (hit) return hit;
    }
    // 逐段前缀（Ren'Py 的 "sora normal" / KAG 的 "char_sora"）
    const tokens = n.split(' ').filter(Boolean);
    for (let take = tokens.length; take > 0; take--) {
      const key = tokens.slice(0, take).join(' ');
      if (index.has(key)) {
        const hit = pick(index.get(key), wantAudio);
        if (hit) return hit;
      }
    }
    // 模糊包含
    for (const key of allNames) {
      if (key.includes(n) || n.includes(key)) {
        const hit = pick(index.get(key), wantAudio);
        if (hit) return hit;
      }
    }
    for (const tok of tokens) {
      if (tok.length < 2) continue;
      for (const key of allNames) {
        if (key.includes(tok)) {
          const hit = pick(index.get(key), wantAudio);
          if (hit) return hit;
        }
      }
    }
    return null;
  }

  return {
    index,
    bg: (name) => lookup(name, false),
    sprite: (name) => lookup(name, false),
    audio: (name) => lookup(name, true),
    any: (name) => lookup(name, false) || lookup(name, true),
    has: (name) => !!lookup(name, false),
    candidates: allNames,
    AUDIO_EXTS,
  };
}

/** 生成一个稳定的渐变封面（没有封面图时用） */
export function coverGradient(seed = '') {
  const palettes = [
    ['#16233f', '#3f6ea6', '#ecc684'], ['#c9dae6', '#7fa6c0', '#f7f1e7'],
    ['#241a38', '#6f4687', '#e8c56c'], ['#0d1828', '#2b7a95', '#93e6ef'],
    ['#35210f', '#a06a2c', '#f2daa6'], ['#2b1621', '#a34f6b', '#f4c9c9'],
    ['#0b0714', '#6b2bd6', '#ff3ea5'], ['#171d29', '#55637c', '#dcd3c2'],
  ];
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const p = palettes[h % palettes.length];
  return `linear-gradient(156deg, ${p[0]} 6%, ${p[1]} 55%, ${p[2]} 100%)`;
}

export function glyphFor(title = '') {
  const clean = String(title).replace(/[\s\d\p{P}]/gu, '');
  return clean ? [...clean][0] : '？';
}
