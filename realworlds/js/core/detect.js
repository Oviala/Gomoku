/* 引擎识别 & 多游戏拆分（一个压缩包里可能塞了好几部游戏） */
import { basename, dirname, ext, isImage, isAudio, isScript } from './util.js';

export const ENGINE_LABEL = {
  kirikiri: 'KiriKiri',
  renpy: "Ren'Py",
  ons: 'ONScripter',
  reallive: 'RealLive',
  siglus: 'Siglus',
  cat2: 'CatSystem2',
  tyrano: 'TyranoScript',
  web: '网页引擎',
  unknown: '未知引擎',
};

const RULES = [
  // [引擎, 正则, 权重]
  ['kirikiri', /(^|\/)(data|patch|patch2|video)\.xp3$/i, 12],
  ['kirikiri', /\.xp3$/i, 8],
  ['kirikiri', /(^|\/)startup\.tjs$/i, 8],
  ['kirikiri', /(^|\/)config\.tjs$/i, 5],
  ['kirikiri', /\.ks$/i, 5],
  ['kirikiri', /\.tjs$/i, 2],
  ['kirikiri', /(^|\/)kirikiri\.exe$/i, 10],
  ['renpy', /(^|\/)renpy\//i, 9],
  ['renpy', /(^|\/)game\/script\.rpy$/i, 12],
  ['renpy', /\.rpy$/i, 7],
  ['renpy', /\.rpyc$/i, 5],
  ['renpy', /\.rpa$/i, 7],
  ['renpy', /(^|\/)renpy\.exe$/i, 10],
  ['renpy', /(^|\/)lib\/.*python/i, 3],
  ['ons', /(^|\/)nscript\.dat$/i, 12],
  ['ons', /(^|\/)(arc|nsa)\.nsa$/i, 9],
  ['ons', /\.nsa$/i, 7],
  ['ons', /\.sar$/i, 6],
  ['ons', /(^|\/)(0|00|nscript)\.txt$/i, 7],
  ['ons', /\.nsc$/i, 6],
  ['ons', /(^|\/)onscript/i, 8],
  ['reallive', /(^|\/)seen\.txt$/i, 12],
  ['reallive', /(^|\/)gameexe\.ini$/i, 8],
  ['reallive', /(^|\/)reallive[a-z0-9_]*\.exe$/i, 8],
  ['reallive', /\.g00$/i, 4],
  ['reallive', /\.nwa$/i, 3],
  ['siglus', /(^|\/)scene[a-z0-9_]*\.pck$/i, 12],
  ['siglus', /(^|\/)gameexe[a-z0-9_]*\.dat$/i, 8],
  ['siglus', /(^|\/)siglusengine[a-z0-9_]*\.exe$/i, 10],
  ['siglus', /\.gan$/i, 3],
  ['cat2', /\.int$/i, 5],
  ['cat2', /\.c2p$/i, 5],
  ['tyrano', /(^|\/)tyrano\//i, 8],
  ['tyrano', /(^|\/)data\/scenario\/.*\.ks$/i, 7],
];

export function detectEngineOf(files) {
  const scores = { kirikiri: 0, renpy: 0, ons: 0, reallive: 0, siglus: 0, cat2: 0, tyrano: 0 };
  const markers = { kirikiri: [], renpy: [], ons: [], reallive: [], siglus: [], cat2: [], tyrano: [] };
  for (const f of files) {
    for (const [engine, re, w] of RULES) {
      if (re.test(f)) {
        scores[engine] += w;
        if (markers[engine].length < 12 && w >= 5) markers[engine].push(f);
      }
    }
  }
  let best = 'unknown', bestScore = 0;
  for (const [engine, s] of Object.entries(scores)) {
    if (s > bestScore) { best = engine; bestScore = s; }
  }
  return { engine: best, score: bestScore, scores, markers: markers[best] || [] };
}

/** 标记文件 → 游戏根目录（Ren'Py 要去掉 game/ 与 renpy/ 这一层） */
export function gameRootForPath(p) {
  const lower = p.toLowerCase();
  let i = lower.lastIndexOf('/game/');
  if (i >= 0) return p.slice(0, i);
  if (/^game\//i.test(p)) return '';
  i = lower.lastIndexOf('/renpy/');
  if (i >= 0) return p.slice(0, i);
  if (/^renpy\//i.test(p)) return '';
  return dirname(p);
}

/** 从文件列表里找出所有可能的“游戏根目录” */
export function detectGames(entries) {
  const files = entries.map((e) => (typeof e === 'string' ? e : e.path));
  // 1. 以“标记文件”所在目录为候选根目录
  const candidateRoots = new Set();
  for (const f of files) {
    for (const [engine, re, w] of RULES) {
      if (w >= 6 && re.test(f)) {
        candidateRoots.add(gameRootForPath(f));
        break;
      }
    }
  }
  const roots = [];
  const sorted = [...candidateRoots].sort((a, b) => a.split('/').length - b.split('/').length);
  for (const root of sorted) {
    // 已有更浅的候选根目录包含它 → 跳过
    if (roots.some((r) => root === r || root.startsWith(r + '/'))) continue;
    const own = files.filter((f) => (root ? f.startsWith(root + '/') : true));
    const rel = own.map((f) => (root ? f.slice(root.length + 1) : f));
    const info = detectEngineOf(rel);
    if (info.engine === 'unknown') continue;
    roots.push({
      root,
      engine: info.engine,
      score: info.score,
      scores: info.scores,
      markers: info.markers,
      files: rel,
    });
  }
  if (roots.length) {
    // 若根目录相同则合并
    return roots.sort((a, b) => b.score - a.score);
  }
  // 2. 没有明确标记 → 整体当一个未知游戏
  const info = detectEngineOf(files);
  return [{ root: '', engine: info.engine, score: info.score, scores: info.scores, markers: info.markers, files }];
}

/** 找出该游戏可用于播放的脚本 / 图片 / 音频统计 */
export function summarizeFiles(files) {
  const stat = { images: 0, audio: 0, video: 0, scripts: 0, other: 0, bytes: 0 };
  for (const f of files) {
    if (isImage(f)) stat.images++;
    else if (isAudio(f)) stat.audio++;
    else if (isScript(f)) stat.scripts++;
    else stat.other++;
  }
  return stat;
}

/** 找封面：优先 cover / 标题图，其次第一张背景图 */
export function pickCover(files) {
  const images = files.filter((f) => isImage(f) && !/\/tl\//i.test(f));
  const score = (p) => {
    const b = basename(p).toLowerCase();
    let s = 0;
    if (/cover|package|jacket|title|logo|icon/.test(b)) s += 20;
    if (/(^|\/)game\/images\//.test(p)) s += 3;
    if (/thumb|btn|button|ui\/|gui\//.test(b)) s -= 6;
    if (/bg_?01|background/.test(b)) s += 2;
    return s;
  };
  const sorted = images.slice().sort((a, b) => score(b) - score(a));
  const pick = sorted[0];
  if (!pick || score(pick) <= 0) return null;
  return pick;
}

export { ext, basename, dirname };
