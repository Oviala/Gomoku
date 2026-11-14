/* 导入流水线：压缩包 → 解压 → 识别引擎 → 解内封包 → 存文件 → 解析剧本 → 入库 */
import { DB } from './db.js';
import { VFS } from './vfs.js';
import { extractArchive, sniffArchive } from './archive.js';
import { headBytes } from './codec.js';
import { readXP3 } from './xp3.js';
import { readRPA } from './rpa.js';
import { readNSA, readSAR, decodeNscriptData } from './nsa.js';
import { detectGames, detectEngineOf, pickCover, ENGINE_LABEL, summarizeFiles } from './detect.js';
import { parseRenpy } from './parsers/rpy.js';
import { parseKS } from './parsers/ks.js';
import { parseNSC } from './parsers/nsc.js';
import { compileStory } from './story.js';
import { decodeScriptBytes, basename, ext, isAudio, isFont, isImage, isScript, normPath, stripCommonRoot, uid } from './util.js';

const UNPACK = '__unpacked__';

/** 有些压缩包会把目录也写成 0 字节“文件”，若某路径是其它路径的前缀目录则丢弃 */
function dropPseudoDirs(list) {
  const sorted = [...list].sort((a, b) => a.path.localeCompare(b.path));
  const drop = new Set();
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i].path;
    for (let j = i + 1; j < sorted.length; j++) {
      const q = sorted[j].path;
      if (!q.startsWith(p)) break;
      if (q.length > p.length && q[p.length] === '/') { drop.add(p); break; }
    }
  }
  return list.filter((e) => !drop.has(e.path));
}
const INNER_LIMITS = { perFile: 160 * 1024 * 1024, total: 2600 * 1024 * 1024, files: 90000, archives: 40 };

export function engineArchiveType(path, head) {
  const e = ext(path);
  if (e === 'xp3') return 'xp3';
  if (e === 'rpa') return 'rpa';
  if (e === 'nsa') return 'nsa';
  if (e === 'sar') return 'sar';
  return null;
}

async function readTextFromVfs(gameId, path) {
  const bytes = await VFS.text(gameId, path);
  if (/nscript\.dat$/i.test(path)) return decodeScriptBytes(decodeNscriptData(bytes));
  return decodeScriptBytes(bytes);
}

/** 从引擎配置文件里补标题 */
async function guessTitle(gameId, paths, engine, fallback) {
  try {
    if (engine === 'renpy') {
      const opt = paths.find((p) => /^game\/options\.rpy$/i.test(p));
      if (opt) {
        const t = await readTextFromVfs(gameId, opt);
        const m = /config\.name\s*=\s*(?:_\()?\s*"((?:[^"\\]|\\.)*)"/.exec(t);
        if (m) return m[1];
        const gui = /build\.name\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(t);
        if (gui) return gui[1];
      }
    }
    if (engine === 'kirikiri') {
      for (const p of paths.filter((x) => /(startup|config|system)\.tjs$/i.test(x))) {
        const t = await readTextFromVfs(gameId, p);
        const m = /System\.title\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(t) || /Title\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(t);
        if (m) return m[1];
      }
    }
  } catch { /* ignore */ }
  return fallback;
}

function pickScriptFiles(paths, engine) {
  const list = paths.filter((p) => !p.startsWith(UNPACK + '/') || true);
  if (engine === 'renpy') {
    return list.filter((p) => /\.rpy$/i.test(p) && !/\/tl\//.test(p) &&
      !/(screens|options|gui|common|00console|00keymap|00layout|_test)\.rpy$/i.test(basename(p)));
  }
  if (engine === 'kirikiri') {
    return list.filter((p) => /\.ks$/i.test(p));
  }
  if (engine === 'ons') {
    const ons = list.filter((p) => /\.(txt|nsc|dat)$/i.test(p) && (/(^|\/)(nscript\.dat|0+\.txt|.*\.nsc)$/i.test(p) || /script/i.test(p)));
    const nscript = ons.filter((p) => /nscript\.dat$/i.test(p));
    if (nscript.length) return nscript.slice(0, 4);
    return ons.slice(0, 8);
  }
  return [];
}

async function parseStoryFromFiles(gameId, paths, engine, sizeMap = new Map()) {
  let scriptPaths = pickScriptFiles(paths, engine);
  if (engine === 'ons') {
    const nscripts = scriptPaths.filter((p) => /nscript\.dat$/i.test(p));
    if (nscripts.length > 1) {
      nscripts.sort((a, b) => (sizeMap.get(b) || 0) - (sizeMap.get(a) || 0));
      scriptPaths = [nscripts[0]];
    }
  }
  if (!scriptPaths.length) return { story: null, error: `没有找到 ${ENGINE_LABEL[engine] || ''} 可读脚本` };
  const files = [];
  for (const p of scriptPaths.slice(0, 200)) {
    try {
      const text = await readTextFromVfs(gameId, p);
      if (text && text.trim()) files.push({ path: p, text });
    } catch { /* ignore */ }
  }
  if (!files.length) return { story: null, error: '脚本读取失败（可能编码无法识别）' };
  let parsed;
  if (engine === 'renpy') parsed = parseRenpy(files);
  else if (engine === 'kirikiri') parsed = parseKS(files);
  else if (engine === 'ons') parsed = parseNSC(files);
  else return { story: null, error: '未知引擎' };
  if (!parsed.labels.size) return { story: null, error: '脚本解析后没有任何剧情段落' };
  const story = compileStory(parsed);
  if (!story.totalBeats) return { story: null, error: '脚本里没有可播放的对话' };
  return { story, parsed, scriptPaths };
}

const JUNK_PATH = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini|\.git|\.svn)(\/|$)/i;
const NESTED_ARCHIVE_EXT = /\.(zip|rar|7z|tar|tgz|gz|lz4)$/i;

/** 把一批文件条目识别成游戏并入库（压缩包与文件夹导入共用） */
const abortError = () => Object.assign(new Error('已取消导入'), { name: 'AbortError' });

export async function importEntries(rawEntries, sourceName, { onProgress, expandArchives = false, keepArchives = false, signal } = {}) {
  const warnings = [];
  let entries = rawEntries.filter((e) => e.path && !JUNK_PATH.test(e.path) && !/\.(tmp|lnk|url)$/i.test(e.path));

  // 文件夹导入时，把里面直接放着的普通压缩包也展开
  if (expandArchives) {
    const expanded = [];
    let i = 0;
    for (const e of entries) {
      expanded.push(e);
      i++;
      if (NESTED_ARCHIVE_EXT.test(e.path) && e.blob) {
        let expandedOk = false;
        try {
          const type = sniffArchive(await headBytes(e.blob, 1200));
          if (type) {
            const sub = await extractArchive(e.blob, e.path, { onProgress: () => {} });
            for (const child of sub.entries) {
              expanded.push({ path: `${e.path}/${child.path}`, blob: child.blob, size: child.size });
            }
            expandedOk = sub.entries.length > 0;
          }
        } catch (err) {
          warnings.push(`展开 ${e.path} 失败：${err.message}`);
        }
        if (expandedOk) {
          // 已经解出内容，不再保留外层压缩包本体（省空间）
          expanded.splice(expanded.lastIndexOf(e), 1);
        }
      }
      if (onProgress && (i % 60 === 0 || i === entries.length)) {
        onProgress({ stage: 'scan', message: `扫描文件夹 ${i}/${entries.length}`, percent: 6 + (i / Math.max(1, entries.length)) * 12 });
      }
    }
    entries = expanded;
  }

  if (!entries.length) return { games: [], warnings: [...warnings, '没有可导入的文件'] };

  // ONS 资源包：脚本和 nsa 分散在不同子目录/压缩包里，组装成同一部游戏
  const hasOnsScript = entries.some((e) => /(^|\/)nscript\.dat$/i.test(e.path));
  const nsaCount = entries.filter((e) => /\.nsa$/i.test(e.path)).length;
  const games = (hasOnsScript && nsaCount > 0)
    ? [{ root: '', engine: 'ons', score: 999, scores: { ons: 999 }, markers: ['nscript.dat', ...Array(Math.min(3, nsaCount)).fill('.nsa')], files: entries.map((e) => e.path) }]
    : detectGames(entries.map((e) => e.path));
  const imported = [];
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    const basePercent = 18 + (i / games.length) * 76;
    const span = 76 / games.length;
    try {
      const res = await importGame(entries, g, sourceName, {
        onProgress: (pr) => onProgress?.({ ...pr, percent: basePercent + ((pr.percent || 0) * span) / 100 }),
        keepArchives,
        signal,
      });
      imported.push(res.game);
      warnings.push(...res.warnings);
    } catch (err) {
      warnings.push(`导入 ${g.root || sourceName} 失败：${err.message}`);
    }
  }
  onProgress?.({ stage: 'done', message: '导入完成', percent: 100 });
  return { games: imported, warnings };
}

/**
 * 从本机解压目录导入：文件按需通过 /api/serve 拉取，避免一次性读入内存
 */
export async function importFromServer(outDir, files, { onProgress, keepArchives = false, signal } = {}) {
  const base = String(outDir).replace(/\/+$/, '');
  const entries = files.map((f) => ({
    path: String(f.path).replace(/^\/+/, ''),
    size: f.size || 0,
    getBlob: async () => {
      const res = await fetch(`/api/serve?path=${encodeURIComponent(base + '/' + f.path)}`);
      if (!res.ok) throw new Error(`读取文件失败：${f.path}（HTTP ${res.status}）`);
      return res.blob();
    },
  }));
  if (!entries.length) throw new Error('解压目录是空的');
  return importEntries(entries, '本机解压', { onProgress, keepArchives, signal });
}

/** 目录导入：entries 为 { path, blob }（blob 可直接是 File） */
export async function importDirectoryEntries(entries, sourceName = '本地文件夹', opts = {}) {
  return importEntries(entries, sourceName, { ...opts, expandArchives: true });
}

/**
 * 导入一个压缩包（可能是多部游戏合集的压缩包）
 */
export async function importArchiveFile(file, { onProgress, keepArchives = false, signal } = {}) {
  const name = file.name || 'archive';
  onProgress?.({ stage: 'unpack', message: `正在解压 ${name}`, percent: 2 });
  const { entries, warnings } = await extractArchive(file, name, {
    signal,
    onProgress: (e) => {
      const pct = e.percent != null ? 3 + (e.percent / 100) * 9 : 6;
      onProgress?.({ stage: 'unpack', message: e.message || '解压中', detail: e.file, percent: pct });
    },
  });
  if (!entries.length) throw new Error('压缩包里没有解出任何文件');
  onProgress?.({ stage: 'detect', message: '识别游戏引擎', percent: 12 });
  const res = await importEntries(entries, name, { onProgress, keepArchives, signal });
  return { games: res.games, warnings: [...warnings, ...res.warnings] };
}

async function importGame(entries, info, sourceName, { onProgress, keepArchives = false, signal } = {}) {
  const abortError = () => Object.assign(new Error('已取消导入'), { name: 'AbortError' });
  const root = info.root || '';
  const prefix = root ? root + '/' : '';
  let local = entries
    .filter((e) => !prefix || e.path.startsWith(prefix))
    .map((e) => ({
      path: prefix ? e.path.slice(prefix.length) : e.path,
      blob: e.blob,
      getBlob: e.getBlob,
      size: e.size,
    }));
  if (!local.length) throw new Error('该游戏目录为空');
  local = dropPseudoDirs(local);
  // 去掉所有文件共享的顶层目录
  const stripped = stripCommonRoot(local.map((e) => e.path));
  if (stripped.root) {
    local = local.map((e) => ({ ...e, path: e.path.slice(stripped.root.length + 1) }));
    local = dropPseudoDirs(local);
  }
  const engine = info.engine && info.engine !== 'unknown' ? info.engine : detectEngineOf(local.map((e) => e.path)).engine;
  const titleHint = root ? basename(root) : basename(sourceName).replace(/\.[^.]+$/, '');
  const gameId = uid('game');
  const warnings = [];

  const engineArchives = local.filter((e) => engineArchiveType(e.path));
  const keepList = keepArchives ? local : local.filter((e) => !engineArchiveType(e.path));
  if (!keepArchives && engineArchives.length) {
    warnings.push(`已跳过 ${engineArchives.length} 个原始封包（${engineArchives.slice(0, 3).map((e) => basename(e.path)).join('、')}${engineArchives.length > 3 ? ' 等' : ''}），设置里可改为保留`);
  }

  onProgress?.({ stage: 'store', message: `写入游戏文件（${keepList.length} 个）`, percent: 12 });
  try {
    await VFS.writeGame(gameId, keepList, ({ done, total }) => {
      onProgress?.({ stage: 'store', message: `写入游戏文件 ${done}/${total}`, percent: 12 + (done / Math.max(1, total)) * 26 });
    });
  } catch (err) {
    await VFS.deleteGame(gameId);
    throw err;
  }
  if (signal?.aborted) { await VFS.deleteGame(gameId); throw abortError(); }

  // 解内封包（xp3 / rpa / nsa / sar）：先收集索引，再并行读取要保留的资源
  const innerCandidates = [];
  const innerWarnings = [];
  let archiveCount = 0;
  for (const e of engineArchives) {
    if (signal?.aborted) { await VFS.deleteGame(gameId); throw abortError(); }
    if (archiveCount++ > INNER_LIMITS.archives) { innerWarnings.push('内封包数量过多，剩余的已跳过'); break; }
    const type = engineArchiveType(e.path);
    onProgress?.({ stage: 'inner', message: `解包内封包 ${e.path}`, percent: 42 });
    try {
      let blob = e.blob;
      if (!blob && e.getBlob) blob = await e.getBlob();
      if (!blob) continue;
      if (blob.size > 1.6 * 1024 * 1024 * 1024) {
        innerWarnings.push(`${e.path} 超过 1.6GB，内存放不下，已跳过内解包`);
        continue;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let res;
      if (type === 'xp3') res = await readXP3(bytes);
      else if (type === 'rpa') res = await readRPA(bytes);
      else if (type === 'nsa') res = await readNSA(bytes);
      else res = await readSAR(bytes);
      for (const msg of res.warnings || []) innerWarnings.push(msg);
      for (const f of res.entries) {
        if (!isImage(f.path) && !isAudio(f.path) && !isScript(f.path) && !isFont(f.path)) continue;
        if (f.encrypted) continue;
        innerCandidates.push({ outPath: `${UNPACK}/${e.path}/${normPath(f.path)}`, read: f.read });
      }
    } catch (err) {
      innerWarnings.push(`解包 ${e.path} 失败：${err.message}`);
    }
  }

  const innerPaths = [];
  let innerBytes = 0;
  let innerCount = 0;
  let tooMany = false;
  let writing = Promise.resolve();
  const writeBatch = (batch) => {
    if (!batch.length) return writing;
    writing = writing.then(() => VFS.writeGame(gameId, batch, () => {
      onProgress?.({ stage: 'inner', message: `写入解包资源 ${innerCount}/${innerCandidates.length}`, percent: 62 + Math.min(1, innerBytes / Math.max(1, INNER_LIMITS.total)) * 12 });
    }));
    return writing;
  };
  let batch = [];
  for (const c of innerCandidates) {
    if (signal?.aborted) { await VFS.deleteGame(gameId); throw abortError(); }
    if (tooMany) break;
    try {
      const data = await c.read();
      if (data.length > INNER_LIMITS.perFile) continue;
      if (innerBytes + data.length > INNER_LIMITS.total || innerCount >= INNER_LIMITS.files) {
        innerWarnings.push('内封包解出的资源超出上限，剩余已跳过');
        tooMany = true;
        break;
      }
      innerBytes += data.length;
      innerCount++;
      innerPaths.push({ path: c.outPath, size: data.length });
      batch.push({ path: c.outPath, blob: new Blob([data]), size: data.length });
      if (batch.length >= 400) { await writeBatch(batch); batch = []; }
    } catch (err) {
      innerWarnings.push(`跳过 ${c.outPath}：${err.message}`);
    }
  }
  await writeBatch(batch);
  await writing;
  if (innerCount) onProgress?.({ stage: 'inner', message: `解包资源完成（${innerCount} 个）`, percent: 74 });
  const allPaths = [
    ...keepList.map((e) => e.path),
    ...(keepArchives ? engineArchives.map((e) => e.path) : []),
    ...innerPaths.map((e) => e.path),
  ];

  onProgress?.({ stage: 'parse', message: '解析剧本', percent: 74 });
  let story = null, parseError = null;
  if (engine === 'reallive') {
    parseError = 'RealLive 引擎：剧本 Seen.txt 是加密的二进制 VM 格式，目前只支持解包资源（CG/音乐），不支持解析剧情';
  } else if (engine === 'siglus') {
    parseError = 'Siglus 引擎：剧本 Scene.pck 是加密的二进制场景包，目前只支持解包资源（CG/音乐），不支持解析剧情';
  }
  if (['renpy', 'kirikiri', 'ons'].includes(engine)) {
    const sizeMap = new Map([...local.map((e) => [e.path, e.size || 0]), ...innerPaths.map((e) => [e.path, e.size || 0])]);
    const res = await parseStoryFromFiles(gameId, allPaths, engine, sizeMap);
    story = res.story;
    parseError = res.error || null;
  }
  let title = '';
  if (story && story.title) title = story.title;
  if (!title) title = await guessTitle(gameId, allPaths, engine, '');
  if (!title) title = titleHint || '未命名作品';

  const coverPath = pickCover(allPaths);
  const stats = summarizeFiles(allPaths);
  const now = Date.now();
  const game = {
    id: gameId,
    title,
    engine,
    engineLabel: ENGINE_LABEL[engine] || engine,
    sourceName: sourceName || '',
    root,
    importedAt: now,
    lastPlayedAt: 0,
    playtimeMs: 0,
    favorite: false,
    playable: !!(story && story.totalBeats),
    coverPath: coverPath || null,
    progress: 0,
    beatsSeen: 0,
    beatIndex: 0,
    chapter: '',
    fileCount: allPaths.length,
    size: [...keepList, ...innerPaths].reduce((n, e) => n + (e.size || 0), 0),
    stats,
    meta: story ? {
      totalBeats: story.totalBeats,
      sayCount: story.sayCount,
      choiceCount: story.choiceCount,
      labels: story.chapterCount || story.labels.length,
    } : null,
    parseError,
    warnings: [...innerWarnings.slice(0, 30)],
  };

  if (signal?.aborted) { await VFS.deleteGame(gameId); throw abortError(); }
  await DB.putGame(game);
  await DB.putManifest(gameId, {
    root,
    paths: allPaths,
    files: local.length,
    unpacked: innerCount,
    engine,
    sourceName,
  });
  if (story) {
    await DB.putStory(gameId, {
      engine: story.engine,
      title: story.title,
      program: story.program,
      labels: story.labels,
      labelIndex: story.labelIndex,
      startIndex: story.startIndex,
      chars: story.chars,
      assets: story.assets,
      totalBeats: story.totalBeats,
      sayCount: story.sayCount,
      choiceCount: story.choiceCount,
      warnings: story.warnings.slice(0, 50),
    });
  }
  onProgress?.({ stage: 'done', message: `已导入：${title}`, percent: 100 });
  return { game, warnings: [...warnings, ...innerWarnings] };
}

/** 用当前解析器重新解析已导入的游戏（不重新解压，用于解析器升级 / 旧数据修复） */
export async function reparseGame(gameId) {
  const game = await DB.getGame(gameId);
  if (!game) throw new Error('游戏不存在');
  const files = await VFS.list(gameId);
  if (!files.length) throw new Error('游戏文件缺失，需要重新导入');
  const paths = files.map((f) => f.path);
  const sizeMap = new Map(files.map((f) => [f.path, f.size || 0]));
  const res = await parseStoryFromFiles(gameId, paths, game.engine, sizeMap);
  const story = res.story;
  game.playable = !!(story && story.totalBeats);
  game.parseError = story ? null : (res.error || '解析失败');
  if (story) {
    if (story.title) game.title = story.title;
    game.meta = {
      totalBeats: story.totalBeats,
      sayCount: story.sayCount,
      choiceCount: story.choiceCount,
      labels: story.chapterCount || story.labels.length,
    };
    await DB.putStory(gameId, {
      engine: story.engine,
      title: story.title,
      program: story.program,
      labels: story.labels,
      labelIndex: story.labelIndex,
      startIndex: story.startIndex,
      chars: story.chars,
      assets: story.assets,
      totalBeats: story.totalBeats,
      sayCount: story.sayCount,
      choiceCount: story.choiceCount,
      warnings: story.warnings.slice(0, 50),
    });
  }
  await DB.putGame(game);
  return game;
}

export async function listLibrary() {
  const games = await DB.listGames();
  return games.sort((a, b) => (b.lastPlayedAt || b.importedAt) - (a.lastPlayedAt || a.importedAt));
}

export async function getGameBundle(id) {
  const [game, story, manifest] = await Promise.all([DB.getGame(id), DB.getStory(id), DB.getManifest(id)]);
  return { game, story, manifest };
}

export async function deleteGame(id) {
  await VFS.deleteGame(id);
  await DB.deleteGame(id);
}

export async function updateProgress(id, patch) {
  const game = await DB.getGame(id);
  if (!game) return null;
  const next = {
    ...game,
    ...patch,
    lastPlayedAt: Date.now(),
  };
  if (patch.seen != null && game.meta?.totalBeats) {
    next.progress = Math.min(100, Math.round((patch.seen / game.meta.totalBeats) * 100));
  }
  await DB.putGame(next);
  return next;
}

export { ENGINE_LABEL };
