/* REALWORLDS 主程序：路由 / 游戏库 / 导入 / 播放器 / 存档 / 设置 */
import { listLibrary, importArchiveFile, importDirectoryEntries, importFromServer, getGameBundle, deleteGame, updateProgress, reparseGame } from './core/library.js';
import { DB } from './core/db.js';
import { VFS } from './core/vfs.js';
import { StoryPlayer } from './core/player.js';
import { makeResolver, coverGradient, glyphFor } from './core/assets.js';
import { escapeHtml, formatBytes, formatDuration, formatHours, formatRelative, basename } from './core/util.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const icon = (name) => `<svg class="ic"><use href="#i-${name}"/></svg>`;
const esc = escapeHtml;

const DEFAULT_SETTINGS = {
  theme: 'midnight', textSpeed: 24, autoDelay: 1500, fontSize: 1,
  bgmVolume: 0.55, seVolume: 0.8, view: 'grid', sort: 'recent', useGameUi: false, keepArchives: false,
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  games: [],
  filter: 'all',
  query: '',
  coverUrls: new Map(),
  bundle: null,
  resolver: null,
  player: null,
  audio: { bgm: null, se: null, voice: null },
  typing: { timer: null, full: '', shown: 0, done: true },
  auto: false, skip: false,
  autoTimer: null, skipTimer: null,
  sessionStart: 0,
  playtimeBase: 0,
  saveTimer: null, playtimeTimer: null,
  importing: false,
  abortCtrl: null,
  importTimer: null,
  importLastMessage: '',
  importLastEvent: 0,
  lastChapter: null,
  themer: null,
  uiSkin: { status: 'off', message: '', path: null },
};

/* ============================== 启动 ============================== */
boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<div style="padding:40px;font:14px monospace;color:#f88">启动失败：${esc(e.message)}</div>`;
});

async function boot() {
  state.settings = { ...DEFAULT_SETTINGS, ...(await DB.getSettings()) };
  applyTheme(state.settings.theme);
  bindGlobalEvents();
  await refreshLibrary();
  try {
    const removed = await VFS.cleanupOrphans(state.games.map((g) => g.id));
    if (removed) toast(`已清理 ${removed} 份未完成的导入残留`, 'info', 3600);
  } catch { /* ignore */ }
  route();
  if (location.search.includes('demo=1')) await installDemos({ silent: true });
  const hint = $('#storage-hint');
  if (hint) {
    const kind = await VFS.kind();
    hint.textContent = `存储：${kind === 'opfs' ? 'OPFS（可存大文件）' : 'IndexedDB 兜底'}`;
  }
  window.REALWORLDS = { state, importArchiveFile, importDirectoryEntries, importFromServer, importDirectoryEntriesWithProgress, openNativeModal, refreshLibrary, reparseGame, installDemos, openGame, openDetail, advance, choose, exitPlayer, openSettings, showLibrary };
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  state.settings.theme = theme;
  DB.setSetting('theme', theme).catch(() => {});
}

/* ============================== 路由 ============================== */
function route() {
  const hash = location.hash || '';
  const mPlay = /^#\/play\/(.+)$/.exec(hash);
  const mGame = /^#\/game\/(.+)$/.exec(hash);
  if (mPlay) openGame(mPlay[1], { mode: 'continue' });
  else if (mGame) openDetail(mGame[1]);
  else showLibrary();
}

function showLibrary() {
  closePlayerUI();
  $('#player').hidden = true;
  $('#detail').hidden = true;
  $('#library').hidden = false;
  document.body.dataset.screen = 'library';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  renderLibrary();
}

/* ============================== 游戏库 ============================== */
async function refreshLibrary() {
  state.games = await listLibrary();
  await hydrateCovers();
  renderLibrary();
}

async function hydrateCovers() {
  for (const g of state.games) {
    if (!g.coverPath) continue;
    try { state.coverUrls.set(g.id, await VFS.url(g.id, g.coverPath)); } catch { /* ignore */ }
  }
}

function coverInner(game, { glyph = true } = {}) {
  const url = state.coverUrls.get(game.id);
  if (url) return `<img class="cover-img" src="${url}" alt="" loading="lazy" >`;
  const grad = coverGradient(game.title + game.id);
  return `<span class="cover-fallback" style="background:${grad}"></span>${glyph ? `<span class="cover-glyph">${esc(glyphFor(game.title))}</span>` : ''}`;
}

function filteredGames() {
  let list = state.games.slice();
  const q = state.query.trim().toLowerCase();
  if (q) list = list.filter((g) => `${g.title} ${g.engineLabel} ${g.root || ''}`.toLowerCase().includes(q));
  if (state.filter === 'recent') list = list.filter((g) => g.lastPlayedAt && g.progress < 100);
  if (state.filter === 'fav') list = list.filter((g) => g.favorite);
  if (state.filter === 'done') list = list.filter((g) => g.progress >= 100);
  if (state.settings.sort === 'name') list.sort((a, b) => String(a.title).localeCompare(String(b.title), 'ja'));
  else if (state.settings.sort === 'progress') list.sort((a, b) => (b.progress || 0) - (a.progress || 0));
  else list.sort((a, b) => (b.lastPlayedAt || b.importedAt) - (a.lastPlayedAt || a.importedAt));
  return list;
}

function renderLibrary() {
  const games = state.games;
  const empty = games.length === 0;
  $('#empty').hidden = !empty;
  $('#hero').hidden = empty;
  $('#shelf').hidden = empty;
  $('#stats').hidden = empty;
  $('#lib-count').textContent = games.length;
  if (empty) { renderStats(); return; }

  const list = filteredGames();
  const hero = list.find((g) => g.lastPlayedAt && g.progress < 100) || list[0] || games[0];
  renderHero(hero);
  renderCards(list);
  renderStats();
}

function renderHero(g) {
  const url = state.coverUrls.get(g.id);
  const gradient = coverGradient(g.title + g.id);
  const hasProgress = g.progress > 0 || g.lastPlayedAt;
  const chapter = g.chapter ? esc(g.chapter) : '尚未开始';
  $('#hero').innerHTML = `
    <div class="hero-info">
      <div class="eyebrow"><span class="pulse"></span>${hasProgress ? '继续阅读 · CONTINUE' : '开始新的故事 · START'}</div>
      <h1 class="hero-title">${esc(g.title)}</h1>
      <p class="hero-meta">
        <span class="tag-engine">${esc(g.engineLabel)}</span>
        <span class="dot-sep"></span><span>${formatHours(g.playtimeMs || 0)} 小时</span>
        <span class="dot-sep"></span><span>${g.lastPlayedAt ? '上次游玩 ' + formatRelative(g.lastPlayedAt) : '导入于 ' + formatRelative(g.importedAt)}</span>
      </p>
      <div class="hero-progress">
        <div class="pbar"><i style="width:${g.progress || 0}%"></i></div>
        <span class="pct">${g.progress || 0}%</span>
      </div>
      <div class="hero-actions">
        <button class="btn primary lg" data-act="play" data-id="${g.id}">${icon('play')}${hasProgress ? '继续阅读' : '开始阅读'}</button>
        <button class="btn ghost" data-act="detail" data-id="${g.id}">${icon('star')}作品详情</button>
      </div>
      <div class="hero-chapter">
        <span class="ch-label">当前进度</span>
        <span class="ch-name">${chapter}${g.meta ? ` · 已读 ${g.beatsSeen || 0} / ${g.meta.totalBeats} 段` : ''}</span>
      </div>
    </div>
    <div class="hero-art">
      <div class="deck d3" style="background:${coverGradient(g.id + 'x')}"></div>
      <div class="deck d2" style="background:${coverGradient(g.title + 'd2')}"></div>
      <div class="cover-art hero-cover ${url ? 'has-img' : ''}" style="${url ? '' : 'background:' + gradient}">
        ${url ? `<img class="cover-img" src="${url}" alt="">` : `<span class="cover-glyph">${esc(glyphFor(g.title))}</span>`}
        <span class="cover-frame"></span>
        <span class="cover-caption">${esc((g.engineLabel || '').toUpperCase())}</span>
      </div>
    </div>`;
}

function renderCards(list) {
  const view = state.settings.view || 'grid';
  $('#cards').hidden = view !== 'grid';
  $('#card-list').hidden = view !== 'list';
  $$('#view-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

  $('#cards').innerHTML = list.map((g) => {
    const badge = g.progress >= 100 ? '<span class="badge-new done">已读完</span>' : (g.lastPlayedAt ? '' : '<span class="badge-new">NEW</span>');
    return `
    <article class="card" data-id="${g.id}">
      <div class="card-cover cover-art ${state.coverUrls.get(g.id) ? 'has-img' : ''}" style="${state.coverUrls.get(g.id) ? '' : 'background:' + coverGradient(g.title + g.id)}">
        ${coverInner(g)}
        <span class="cover-frame"></span>
        <span class="badge-engine">${esc(g.engineLabel)}</span>
        ${badge}
      </div>
      <div class="card-body">
        <h3 class="card-title">${esc(g.title)}</h3>
        <div class="card-sub">
          ${g.progress >= 100
            ? `<span class="done">✓ 已读完</span><span>${formatHours(g.playtimeMs || 0)}h</span>`
            : `<span class="pbar"><i style="width:${g.progress || 0}%"></i></span><b>${g.progress || 0}%</b><span>${formatHours(g.playtimeMs || 0)}h</span>`}
        </div>
      </div>
    </article>`;
  }).join('');

  $('#card-list').innerHTML = list.map((g) => `
    <div class="row-item" data-id="${g.id}">
      <div class="row-thumb cover-art" style="${state.coverUrls.get(g.id) ? '' : 'background:' + coverGradient(g.title + g.id)}">${coverInner(g)}</div>
      <div class="row-main">
        <div class="row-title">${esc(g.title)}</div>
        <div class="row-sub">${esc(g.engineLabel)} · ${formatBytes(g.size)} · ${g.fileCount} 个文件</div>
      </div>
      <div class="row-progress"><div class="pbar"><i style="width:${g.progress || 0}%"></i></div><span>${g.progress || 0}%</span></div>
      <div class="row-time">${formatRelative(g.lastPlayedAt || g.importedAt)}</div>
      <button class="btn ghost sm" data-act="play" data-id="${g.id}">${icon('play')}阅读</button>
    </div>`).join('');

  if (!list.length) {
    $('#cards').innerHTML = `<div class="inline-empty">没有符合条件的作品。换个筛选试试。</div>`;
  }
}

function renderStats() {
  const games = state.games;
  const totalTime = games.reduce((n, g) => n + (g.playtimeMs || 0), 0);
  const totalSeen = games.reduce((n, g) => n + (g.beatsSeen || 0), 0);
  const favs = games.filter((g) => g.favorite).length;
  const byEngine = {};
  for (const g of games) byEngine[g.engineLabel] = (byEngine[g.engineLabel] || 0) + 1;
  const total = games.length || 1;
  $('#stats').innerHTML = `
    <div class="stat"><span class="stat-num">${games.length}</span><span class="stat-label">作品</span></div>
    <div class="stat"><span class="stat-num">${formatHours(totalTime)}<em>h</em></span><span class="stat-label">累计阅读</span></div>
    <div class="stat"><span class="stat-num">${totalSeen}</span><span class="stat-label">已读段落</span></div>
    <div class="stat"><span class="stat-num">${favs}</span><span class="stat-label">收藏</span></div>
    <div class="engines">
      ${Object.entries(byEngine).map(([k, v]) => `<div class="eng-row"><span>${esc(k)}</span><div class="pbar sm"><i style="width:${(v / total) * 100}%"></i></div><b>${v}</b></div>`).join('') || '<div class="eng-row"><span>暂无数据</span></div>'}
    </div>`;
}

/* ============================== 详情页 ============================== */
async function openDetail(id) {
  const { game, story, manifest } = await getGameBundle(id);
  if (!game) { toast('找不到这部作品'); return; }
  closePlayerUI();
  $('#player').hidden = true;
  $('#library').hidden = true;
  const url = await VFS.url(id, game.coverPath).catch(() => null);
  const labels = story?.labels || [];
  const chapters = labels.filter((l) => l.chapter);
  const chapterList = chapters.length ? chapters : labels;
  const warnings = [...(game.warnings || []), ...(story?.warnings || [])].slice(0, 8);
  $('#detail').innerHTML = `
    <div class="detail-wrap">
      <header class="detail-top">
        <button class="btn ghost" data-act="back">${icon('back')}返回游戏库</button>
        <span class="detail-top-meta">${esc(game.engineLabel)} · ${formatBytes(game.size)} · ${game.fileCount} 个文件</span>
      </header>
      <div class="detail-body">
        <div class="detail-cover cover-art ${url ? 'has-img' : ''}" style="${url ? '' : 'background:' + coverGradient(game.title)}">
          ${url ? `<img class="cover-img" src="${url}" alt="">` : `<span class="cover-glyph">${esc(glyphFor(game.title))}</span>`}
          <span class="cover-frame"></span>
        </div>
        <div class="detail-info">
          <div class="eyebrow">${icon('sparkle')} ${game.playable ? '可播放' : '仅解包'} · ${esc(game.engineLabel)}</div>
          <h1 class="detail-title">${esc(game.title)}</h1>
          <div class="detail-meta">
            <span>${formatHours(game.playtimeMs || 0)} 小时</span><span class="dot-sep"></span>
            <span>${game.progress || 0}% · ${game.beatsSeen || 0}/${game.meta?.totalBeats || 0} 段</span><span class="dot-sep"></span>
            <span>${chapterList.length} 个章节</span><span class="dot-sep"></span>
            <span>导入于 ${formatRelative(game.importedAt)}</span>
          </div>
          <div class="hero-progress"><div class="pbar"><i style="width:${game.progress || 0}%"></i></div><span class="pct">${game.progress || 0}%</span></div>
          <div class="detail-actions">
            <button class="btn primary" data-act="play" data-id="${id}" data-mode="${game.lastPlayedAt ? 'continue' : 'start'}">${icon('play')}${game.lastPlayedAt ? '继续阅读' : '开始阅读'}</button>
            <button class="btn ghost" data-act="restart" data-id="${id}">${icon('refresh')}从头开始</button>
            <button class="btn ghost sm" data-act="reparse" data-id="${id}" title="解析器升级后，用当前版本重新生成剧情（不用重新解压）">重新解析剧本</button>
            <button class="btn ghost" data-act="fav" data-id="${id}">${icon('heart')}${game.favorite ? '已收藏' : '收藏'}</button>
            <button class="btn ghost danger" data-act="delete" data-id="${id}">${icon('trash')}删除</button>
          </div>
          ${warnings.length ? `<div class="detail-warnings"><b>导入提示</b>${warnings.map((w) => `<span>· ${esc(w)}</span>`).join('')}</div>` : ''}
          ${!game.playable ? `<div class="detail-warnings warn"><b>无法播放的原因</b><span>· ${esc(game.parseError || '没有找到可解析的脚本')}</span><span>· 文件已完整解包，可在此查看章节/资源信息</span></div>` : ''}
          <div class="detail-section">
            <h3>章节</h3>
            <div class="chapter-list">
              ${chapterList.length ? chapterList.map((l, i) => `
                <button class="chapter-item" data-act="jump" data-id="${id}" data-index="${l.index}">
                  <span class="ci-num">${String(i + 1).padStart(2, '0')}</span>
                  <span class="ci-name">${esc(l.title || l.name)}</span>
                  <span class="ci-progress">${l.index <= (game.beatIndex || 0) ? '已读到这里' : '未读'}</span>
                </button>`).join('') : '<p class="muted">没有可显示的章节</p>'}
            </div>
          </div>
          <div class="detail-section">
            <h3>资源统计</h3>
            <div class="res-grid">
              <div><b>${game.stats?.images || 0}</b><span>图片</span></div>
              <div><b>${game.stats?.audio || 0}</b><span>音频</span></div>
              <div><b>${game.stats?.scripts || 0}</b><span>脚本</span></div>
              <div><b>${manifest?.unpacked || 0}</b><span>内封包解出</span></div>
            </div>
            <p class="muted mono">${esc(game.sourceName || '')}${game.root ? ' / ' + esc(game.root) : ''}</p>
          </div>
        </div>
      </div>
    </div>`;
  $('#detail').hidden = false;
  document.body.dataset.screen = 'detail';
}

/* ============================== 导入 ============================== */
/* ---------- 本机解压（server.py 调用系统原生工具） ---------- */
const pjoin = (a, b) => String(a).replace(/\/+$/, '') + '/' + b;

async function openNativeModal() {
  let info;
  try {
    info = await (await fetch('/api/tools')).json();
  } catch (e) {
    toast('本机解压服务不可用：请用 start.command 启动 server.py 后再试', 'error', 6000);
    return;
  }
  const tools = info.tools || [];
  const cacheSize = info.cacheSize || 0;
  openModal(`
    <div class="modal-head"><h3>本机解压导入</h3><button class="icon-btn" data-close="1">${icon('close')}</button></div>
    <div class="modal-body native-body">
      <div class="native-tools">可用工具：${tools.length ? tools.map((t) => `<span class="native-tool">${esc(t.label)}</span>`).join('') : '<span class="native-tool">未检测到（需要 bsdtar / unzip）</span>'}</div>
      <p class="muted">浏览器不能直接调用「解压专家」这类 GUI 软件，但本地 server.py 会用系统自带 bsdtar / ditto / unzip 和内置 lz4 解压，大包更快、也不占浏览器内存。rar / 7z / zip / tar / .zip.lz4 都能直接来。</p>
      <div class="native-pathbar">
        <button class="btn ghost sm" id="native-up" title="上一级">↑</button>
        <input id="native-path" class="native-path" placeholder="选择文件或文件夹路径" spellcheck="false">
        <button class="btn primary sm" id="native-go">${icon('play')}解压 / 导入</button>
      </div>
      <div class="browse-list" id="native-list">加载中…</div>
      <p class="native-status muted" id="native-status">选择一个压缩包，或进入游戏文件夹后点「解压 / 导入」。7z 若加密需要先手动解压。</p>
      <div class="native-foot"><button class="btn ghost sm" id="native-clear">清理解压缓存（${formatBytes(cacheSize)}）</button></div>
    </div>`);
  $('#native-up').addEventListener('click', () => nativeBrowse());
  $('#native-go').addEventListener('click', nativeGo);
  $('#native-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') nativeGo(); });
  $('#native-clear').addEventListener('click', async () => {
    await fetch('/api/cache/clear', { method: 'POST' });
    toast('解压缓存已清空', 'ok');
    const el = $('#native-clear'); if (el) el.textContent = '清理解压缓存（0 B）';
  });
  nativeBrowse('');
}

async function nativeBrowse(path) {
  const list = $('#native-list');
  if (!list) return;
  const status = $('#native-status');
  list.innerHTML = '加载中…';
  try {
    const res = await fetch('/api/browse' + (path ? `?path=${encodeURIComponent(path)}` : ''));
    const data = await res.json();
    if (data.error) { list.innerHTML = ''; status.textContent = '失败：' + data.error; status.dataset.state = 'fail'; return; }
    $('#native-path').value = data.path;
    const rows = [];
    if (data.path !== data.parent) rows.push(`<button class="browse-row dir" data-dir="${esc(data.parent)}"><span class="br-icon">↑</span><span class="br-name">..</span></button>`);
    for (const d of data.dirs) rows.push(`<button class="browse-row dir" data-dir="${esc(pjoin(data.path, d))}"><span class="br-icon">📁</span><span class="br-name">${esc(d)}</span></button>`);
    for (const f of data.files) rows.push(`<button class="browse-row file ${f.archive ? 'archive' : ''}" data-file="${esc(pjoin(data.path, f.name))}"><span class="br-icon">${f.archive ? '🗜️' : '📄'}</span><span class="br-name">${esc(f.name)}</span><span class="br-size">${formatBytes(f.size)}</span></button>`);
    list.innerHTML = rows.join('') || '<p class="muted">这个目录是空的</p>';
    list.querySelectorAll('[data-dir]').forEach((el) => el.addEventListener('click', () => nativeBrowse(el.dataset.dir)));
    list.querySelectorAll('[data-file]').forEach((el) => el.addEventListener('click', () => {
      $('#native-path').value = el.dataset.file;
      status.dataset.state = '';
      status.textContent = `已选择：${el.dataset.file}（点「解压 / 导入」）`;
    }));
  } catch (e) {
    list.innerHTML = '';
    status.textContent = '读取目录失败：' + e.message;
    status.dataset.state = 'fail';
  }
}

async function nativeGo() {
  const path = $('#native-path').value.trim();
  const status = $('#native-status');
  const btn = $('#native-go');
  if (!path) { status.textContent = '先选一个压缩包或文件夹'; return; }
  btn.disabled = true;
  status.dataset.state = '';
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (!status.isConnected) { clearInterval(timer); return; }
    status.textContent = `本机解压中… 已 ${((Date.now() - t0) / 1000).toFixed(0)}s（大包请耐心等，窗口别关）`;
  }, 500);
  try {
    const res = await fetch('/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    clearInterval(timer);
    status.textContent = `${data.folder ? '目录' : '解压完成'}（${data.tool || '目录'}）· ${data.fileCount} 个文件 · ${formatBytes(data.totalSize)} · ${data.elapsed}s，正在导入…`;
    const ls = await (await fetch('/api/listdir?path=' + encodeURIComponent(data.dir))).json();
    if (ls.error) throw new Error(ls.error);
    const out = await importFromServer(data.dir, ls.files, {
      keepArchives: state.settings.keepArchives,
      onProgress: (p) => { if (p.message) status.textContent = `导入中 · ${p.message}${p.percent != null ? ' · ' + Math.round(p.percent) + '%' : ''}`; },
    });
    clearInterval(timer);
    if (out.games.length) await promptReplaceDuplicates(out.games);
    if (!out.games.length) {
      status.textContent = '解压成功，但没有识别出 galgame（引擎可能还不支持）';
      status.dataset.state = 'fail';
    } else {
      status.textContent = `完成：${out.games.map((g) => g.title).join('、')}`;
      for (const g of out.games) toast(`已导入《${g.title}》${g.playable ? ` · ${g.meta?.totalBeats || 0} 段剧情` : ' · 暂不可播放'}`, g.playable ? 'ok' : 'warn', 4200);
      await refreshLibrary();
      setTimeout(() => closeModal(), 900);
    }
  } catch (e) {
    clearInterval(timer);
    status.textContent = '失败：' + e.message;
    status.dataset.state = 'fail';
  } finally {
    btn.disabled = false;
  }
}

async function handleReparse(id) {
  toast('正在用当前解析器重新解析剧本…', 'info', 1600);
  try {
    const g = await reparseGame(id);
    await refreshLibrary();
    if (g.playable) toast(`《${g.title}》重新解析完成：${g.meta?.totalBeats || 0} 段剧情`, 'ok', 4200);
    else toast(`《${g.title}》重新解析后仍不可播放：${g.parseError || '没有可读脚本'}`, 'warn', 6000);
  } catch (e) {
    toast(`重新解析失败：${e.message}`, 'error', 6500);
  }
}

/** 导入完成后：遇到同名同引擎的旧条目，询问是否替换（避免越导越乱） */
async function promptReplaceDuplicates(games) {
  if (!games?.length) return;
  for (const g of games) {
    const dup = state.games.find((x) => x.id !== g.id && x.title === g.title && x.engine === g.engine);
    if (!dup) continue;
    if (confirm(`《${g.title}》已经在库里了（同一个引擎）。\n\n用刚导入的版本替换旧条目吗？\n（解析器修复后重建的版本建议替换）`)) {
      try { await deleteGame(dup.id); } catch { /* ignore */ }
      toast(`已替换旧的《${g.title}》`, 'ok', 3200);
    } else {
      toast(`保留两份《${g.title}》`, 'info', 3000);
    }
  }
}

const BIG_ARCHIVE_RE = /\.(rar|7z|zip|tgz|tar|gz|lz4)$/i;

function openFilePicker() { $('#file-input').click(); }
function openFolderPicker() { $('#folder-input').click(); }

function walkEntry(entry, prefix, out) {
  return new Promise((resolve) => {
    if (!entry) return resolve();
    if (entry.isFile) {
      entry.file((file) => { out.push({ path: prefix + file.name, blob: file }); resolve(); }, () => resolve());
      return;
    }
    if (!entry.isDirectory) return resolve();
    const reader = entry.createReader();
    const readBatch = () => {
      reader.readEntries(async (batch) => {
        if (!batch.length) return resolve();
        for (const child of batch) await walkEntry(child, prefix + entry.name + '/', out);
        readBatch();
      }, () => resolve());
    };
    readBatch();
  });
}

async function importDirectoryEntriesWithProgress(entries, title) {
  if (state.importing) return;
  if (!entries.length) { toast('文件夹里没有可读取的文件', 'warn'); return; }
  state.importing = true;
  const top = title || (entries[0]?.path || '').split('/')[0] || '本地文件夹';
  showImportPanel(`文件夹 ${top}`);
  try {
    const { games, warnings } = await importDirectoryEntries(entries, top, { onProgress: updateImportPanel });
    for (const g of games) {
      toast(`已导入《${g.title}》${g.playable ? ` · ${g.meta?.totalBeats || 0} 段剧情` : ' · 暂不可播放'}`, g.playable ? 'ok' : 'warn', 4200);
    }
    if (!games.length) toast('这个文件夹里没有识别出 galgame', 'warn', 5600);
    else await promptReplaceDuplicates(games);
    for (const w of warnings.slice(0, 3)) toast(w, 'warn', 5200);
  } catch (e) {
    console.error(e);
    toast(`文件夹导入失败：${e.message}`, 'error', 6500);
  } finally {
    hideImportPanel();
    state.importing = false;
  }
  await refreshLibrary();
}

async function importDirectoryFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  const bigArchives = list.filter((f) => BIG_ARCHIVE_RE.test(f.name || '') && (f.size || 0) > 300 * 1024 * 1024);
  if (bigArchives.length) {
    const total = bigArchives.reduce((n, f) => n + (f.size || 0), 0);
    toast(`这个文件夹里有 ${bigArchives.length} 个大压缩包（${formatBytes(total)}）。浏览器内解压会非常慢、吃内存；请点顶栏方块图标用「本机解压」选择这个文件夹，服务端解压后再导入。`, 'warn', 10000);
    return;
  }
  const entries = list.map((f) => {
    let rel = f.webkitRelativePath || f.name || 'file';
    return { path: rel.replace(/^\/+/, ''), blob: f };
  });
  await importDirectoryEntriesWithProgress(entries);
}
async function handleFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) { toast('没有选中文件（拖进来的是文件夹？请先压缩成 zip）', 'warn', 5200); return; }
  if (state.importing) return;
  state.importing = true;
  for (const file of list) {
    if (!file.size) {
      toast(`「${file.name}」是 0 字节：可能是文件夹或不完整的下载，读不到内容`, 'warn', 6000);
      continue;
    }
    const sizeGB = file.size / 1073741824;
    if (sizeGB >= 1.2) {
      const ok = confirm(`「${file.name}」有 ${sizeGB.toFixed(1)} GB。\n\n在浏览器里解压这么大的包会非常慢（可能十几分钟）、吃大量内存，甚至中途失败。\n\n建议先用解压软件（Keka / The Unarchiver / 7-Zip）解压成文件夹，再点「选择游戏文件夹」导入——那样快很多，也更稳。\n\n仍然尝试在浏览器里解压吗？`);
      if (!ok) { toast('已跳过：建议解压成文件夹后用「选择游戏文件夹」导入', 'info', 5200); continue; }
    }
    state.abortCtrl = new AbortController();
    showImportPanel(file.name);
    try {
      const { games, warnings } = await importArchiveFile(file, {
        onProgress: updateImportPanel,
        keepArchives: state.settings.keepArchives,
        signal: state.abortCtrl.signal,
      });
      for (const g of games) {
        toast(`已导入《${g.title}》${g.playable ? ` · ${g.meta?.totalBeats || 0} 段剧情` : ' · 暂不可播放'}`, g.playable ? 'ok' : 'warn', 4200);
      }
      if (!games.length) toast('没有识别出可导入的游戏', 'warn');
      else await promptReplaceDuplicates(games);
      for (const w of warnings.slice(0, 3)) toast(w, 'warn', 5200);
    } catch (e) {
      console.error(e);
      const name = e && e.name;
      if (name === 'AbortError') {
        toast('已取消导入（未完成的文件已清理）', 'info', 4200);
      } else if (name === 'NotReadableError' || name === 'NotFoundError' || name === 'SecurityError') {
        toast(`导入失败：浏览器读不到「${file.name}」。可能文件被移动/删除，或者你拖进来的是文件夹`, 'error', 8000);
      } else {
        toast(`导入失败：${e.message}`, 'error', 6500);
      }
    } finally {
      state.abortCtrl = null;
      hideImportPanel();
    }
    await refreshLibrary();
  }
  state.importing = false;
}

function showImportPanel(name) {
  $('#import-panel').hidden = false;
  $('#ip-title').textContent = `正在导入 ${name}`;
  state.importLastMessage = '读取中…';
  state.importLastEvent = Date.now();
  state.importStart = Date.now();
  state.importLastPaint = 0;
  $('#ip-msg').textContent = '读取中… · 0.0s';
  $('#ip-bar').style.width = '2%';
  clearInterval(state.importTimer);
  state.importTimer = setInterval(() => {
    if ($('#import-panel').hidden) return;
    const now = Date.now();
    const sec = ((now - (state.importStart || now)) / 1000).toFixed(1);
    const idle = (now - (state.importLastEvent || now)) / 1000;
    const hint = idle > 12 ? ' · 大文件解压中，可能较久，可点右上角 ✕ 取消' : '';
    $('#ip-msg').textContent = `${state.importLastMessage} · ${sec}s${hint}`;
  }, 300);
}
function updateImportPanel(p = {}) {
  if (p.percent != null) $('#ip-bar').style.width = Math.max(2, Math.min(100, p.percent)) + '%';
  if (p.message) { state.importLastMessage = p.message; state.importLastEvent = Date.now(); }
}
function cancelImport() {
  if (state.importing && state.abortCtrl) {
    state.abortCtrl.abort();
    state.importLastMessage = '正在取消…';
  }
}
function hideImportPanel() {
  $('#import-panel').hidden = true;
  $('#ip-bar').style.width = '100%';
  clearInterval(state.importTimer);
  state.importTimer = null;
}

async function installDemos({ silent = false } = {}) {
  try {
    const index = await (await fetch('demo/index.json')).json();
    let n = 0;
    for (const item of index) {
      const res = await fetch('demo/' + item.file);
      if (!res.ok) throw new Error(`下载演示包失败：${item.file}`);
      const blob = await res.blob();
      const file = new File([blob], item.file, { type: 'application/zip' });
      showImportPanel(item.file);
      try {
        const { games } = await importArchiveFile(file, { onProgress: updateImportPanel, keepArchives: state.settings.keepArchives });
        n += games.length;
      } catch (e) { toast(`演示包 ${item.file} 导入失败：${e.message}`, 'error'); }
      hideImportPanel();
    }
    await refreshLibrary();
    if (!silent) toast(`已安装 ${n} 个内置演示`, 'ok');
    return n;
  } catch (e) {
    toast(`内置演示安装失败：${e.message}`, 'error', 6000);
    return 0;
  }
}

/* ============================== 播放器 ============================== */
async function openGame(id, { mode = 'continue', jumpIndex = null } = {}) {
  const bundle = await getGameBundle(id);
  if (!bundle.game) { toast('找不到这部作品'); return; }
  if (!bundle.story) {
    toast('这部作品没有可解析的脚本，只完成了文件解包', 'warn', 5000);
    openDetail(id);
    return;
  }
  state.bundle = bundle;
  state.resolver = makeResolver(bundle.manifest?.paths || []);
  const game = bundle.game;
  let snapshot = null;
  if (jumpIndex != null) snapshot = { pc: jumpIndex, seen: [] };
  else if (mode === 'continue') {
    const auto = await DB.get('saves', DB.saveKey(id, 0));
    if (auto?.snapshot) snapshot = auto.snapshot;
  }
  state.player = new StoryPlayer(bundle.story, snapshot);
  state.sessionStart = Date.now();
  state.playtimeBase = game.playtimeMs || 0;
  state.lastChapter = null;
  state.auto = false;
  state.skip = false;

  $('#library').hidden = true;
  $('#detail').hidden = true;
  $('#player').hidden = false;
  document.body.dataset.screen = 'player';
  $('#p-title').textContent = game.title;
  $('#p-chapter').textContent = '';
  $('#end-card').hidden = true;
  $('#line').textContent = '';
  $('#nameplate').hidden = true;
  $('#choices').hidden = true;
  applyFontSize();
  playStageAudio(state.player.stage);

  resetDialogueSkin();
  const first = state.player.current || state.player.next();
  renderBeat(first);
  if (state.settings.useGameUi) setTimeout(() => applyGameUiSkin(), 80);

  clearInterval(state.playtimeTimer);
  state.playtimeTimer = setInterval(() => { persistSession(); }, 20000);
}

function closePlayerUI() {
  clearInterval(state.typing.timer);
  clearTimeout(state.autoTimer);
  clearInterval(state.skipTimer);
  clearInterval(state.playtimeTimer);
  state.auto = false;
  state.skip = false;
  stopAudio('se');
  stopAudio('voice');
  if (state.audio.bgm) { try { state.audio.bgm.pause(); } catch { } state.audio.bgm = null; }
}

async function exitPlayer(goLibrary = true) {
  if (state.bundle) await persistSession(true);
  closePlayerUI();
  state.player = null;
  state.bundle = null;
  state.resolver = null;
  if (goLibrary) { location.hash = ''; showLibrary(); }
  await refreshLibrary();
}

async function persistSession(force = false) {
  if (!state.player || !state.bundle) return;
  const elapsed = Date.now() - state.sessionStart;
  state.sessionStart = Date.now();
  state.playtimeBase += elapsed;
  const game = state.bundle.game;
  const patch = {
    beatIndex: state.player.current?.index ?? 0,
    chapter: state.player.currentLabel()?.title || state.player.currentLabel()?.name || '',
    beatsSeen: state.player.seen.size,
    seen: state.player.seen.size,
    playtimeMs: state.playtimeBase,
  };
  try {
    const next = await updateProgress(game.id, patch);
    if (next) state.bundle.game = { ...game, ...next };
    await DB.putSave(game.id, 0, state.player.save(), { auto: true, chapter: patch.chapter });
  } catch (e) { console.warn(e); }
}

function playerProgress() {
  return state.player ? state.player.progress : 0;
}

function updateProgressUI() {
  const p = playerProgress();
  $('#p-progress-bar').style.width = p + '%';
  $('#p-progress-text').textContent = p + '%';
  const label = state.player?.currentLabel();
  $('#p-chapter').textContent = label ? (label.title || label.name) : '';
  if (label && state.lastChapter !== label.key) {
    if (state.lastChapter != null) showChapterToast(label.title || label.name);
    state.lastChapter = label.key;
  }
}

function showChapterToast(text) {
  const el = $('#chapter-toast');
  el.textContent = text;
  el.hidden = false;
  el.classList.add('show');
  setTimeout(() => { el.classList.remove('show'); el.hidden = true; }, 2200);
}

function applyFontSize() {
  document.documentElement.style.setProperty('--line-scale', String(state.settings.fontSize || 1));
}

function renderBeat(beat) {
  updateProgressUI();
  if (!beat || beat.t === 'end') { showEnd(); return; }
  if (beat.t === 'choice') {
    finishTypingNow();
    renderChoices(beat);
    return;
  }
  hideChoices();
  const name = beat.name || '';
  const np = $('#nameplate');
  if (name) { np.hidden = false; np.textContent = name; } else { np.hidden = true; }
  applyStage(beat);
  if (beat.voice) playVoice(beat.voice); else if (state.audio.voice) stopAudio('voice');
  typeText(beat.text || '');
  updateProgressUI();
  persistSessionThrottled();
}

function applyStage(beat) {
  const stage = beat.stage || state.player.stage;
  const bgPath = stage.bg ? state.resolver?.bg(stage.bg) : null;
  const img = $('#bg-img');
  const bgWrap = $('#stage-bg');
  const COLOR_BG = /^(black|white|red|blue|green|yellow|gray|grey|transparent)$/i;
  const HEX_BG = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  const namedColor = stage.bg && COLOR_BG.test(stage.bg) ? stage.bg.toLowerCase() : null;
  const hexColor = stage.bg && HEX_BG.test(stage.bg) ? stage.bg.toLowerCase() : null;
  if (!bgPath && (namedColor || hexColor)) {
    img.hidden = true;
    img.removeAttribute('src');
    bgWrap.classList.remove('photo');
    bgWrap.style.background = namedColor === 'transparent' ? 'transparent' : (namedColor || hexColor);
  } else if (!bgPath && stage.bg) {
    // 脚本指定了背景但素材没解出来：用暗场而不是主题渐变，避免误以为在放主题背景
    img.hidden = true;
    img.removeAttribute('src');
    bgWrap.classList.remove('photo');
    bgWrap.style.background = '#05070c';
  } else if (bgPath) {
    VFS.url(state.bundle.game.id, bgPath).then((url) => {
      if (img.src !== url) img.src = url;
      img.hidden = false;
      bgWrap.classList.add('photo');
    }).catch(() => { img.hidden = true; bgWrap.classList.remove('photo'); });
  } else {
    img.hidden = true;
    bgWrap.classList.remove('photo');
    bgWrap.style.background = '';
  }
  if (bgPath) bgWrap.style.background = '';

  const sprites = $('#sprites');
  const wanted = (stage.sprites || []).map((s) => ({ ...s, path: state.resolver?.sprite(s.name) })).filter((s) => s.path);
  sprites.innerHTML = '';
  for (const s of wanted) {
    const el = document.createElement('img');
    el.className = `sprite-img pos-${s.pos || 'center'}`;
    el.alt = '';
    VFS.url(state.bundle.game.id, s.path).then((url) => { el.src = url; }).catch(() => { });
    sprites.appendChild(el);
  }
  playStageAudio(stage);
  if (beat.se) for (const se of beat.se) playSe(se);
}

function playStageAudio(stage) {
  const wanted = stage?.bgm ? state.resolver?.audio(stage.bgm) : null;
  const wantedKey = wanted || null;
  if (state.audio.bgmKey === wantedKey && wantedKey) return;
  if (!wantedKey) {
    if (state.audio.bgm) { state.audio.bgm.pause(); state.audio.bgm = null; state.audio.bgmKey = null; }
    return;
  }
  VFS.url(state.bundle.game.id, wantedKey).then((url) => {
    if (state.audio.bgmKey === wantedKey) return;
    if (state.audio.bgm) { try { state.audio.bgm.pause(); } catch { } }
    const audio = new Audio(url);
    audio.loop = true;
    audio.volume = state.settings.bgmVolume;
    audio.play().catch(() => { });
    state.audio.bgm = audio;
    state.audio.bgmKey = wantedKey;
  }).catch(() => { });
}

/* ---------- 游戏内对话框素材（可选） ---------- */
const UI_SKIN_NAME_RE = /(textbox|message[_\- ]?(window|box|frame)?|msgbox|messagebox|dialog(ue)?[_\- ]?(box|window|frame)?|menubox|window[_\- ]?frame)/i;

function findDialogueCandidates(paths) {
  const scored = [];
  for (const p of paths) {
    if (!/\.(png|webp|jpe?g|bmp)$/i.test(p)) continue;
    if (/icon|button|btn|logo|thumb|title|badge|cursor|bar\.|_bar/i.test(p)) continue;
    const base = basename(p).toLowerCase();
    const full = p.toLowerCase();
    let score = 0;
    if (/gui\/textbox/.test(full)) score += 100;
    if (/textbox/.test(base)) score += 80;
    if (/message[_\- ]?window|msgbox|messagebox/.test(base)) score += 60;
    if (/dialog/.test(base)) score += 40;
    if (UI_SKIN_NAME_RE.test(base)) score += 20;
    if (!score) continue;
    scored.push({ path: p, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((x) => x.path);
}

function probeImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ ok: false, w: 0, h: 0 });
    img.src = url;
  });
}

function resetDialogueSkin() {
  const box = $('#dialogue');
  if (box) {
    box.classList.remove('game-ui');
    box.style.backgroundImage = '';
  }
  state.uiSkin = {
    status: state.settings.useGameUi ? 'idle' : 'off',
    message: '',
    path: null,
  };
  updateSkinStatusUI();
}

function skinStatusText() {
  if (!state.settings.useGameUi) return '';
  const s = state.uiSkin;
  if (s.status === 'ok') return s.message;
  if (s.status === 'fail') return s.message;
  if (s.status === 'idle') return '进入游戏后尝试套用';
  return '';
}

function updateSkinStatusUI() {
  const el = $('#ui-skin-status');
  if (el) { el.textContent = skinStatusText(); el.dataset.state = state.settings.useGameUi ? state.uiSkin.status : 'off'; }
  const btn = $('#toggle-gameui');
  if (btn) { btn.classList.toggle('active', !!state.settings.useGameUi); btn.textContent = state.settings.useGameUi ? '已开启' : '关闭'; }
}

async function applyGameUiSkin({ announce = false } = {}) {
  const box = $('#dialogue');
  const gameId = state.bundle?.game?.id;
  if (!box || !gameId) return;
  box.classList.remove('game-ui');
  box.style.backgroundImage = '';
  if (!state.settings.useGameUi) {
    state.uiSkin = { status: 'off', message: '关闭', path: null };
    updateSkinStatusUI();
    return;
  }
  const paths = state.bundle.manifest?.paths || [];
  const candidates = findDialogueCandidates(paths);
  if (!candidates.length) {
    state.uiSkin = { status: 'fail', message: '失败：这部作品里没有找到对话框素材', path: null };
    if (announce) toast(state.uiSkin.message, 'warn', 4400);
    updateSkinStatusUI();
    return;
  }
  for (const p of candidates.slice(0, 10)) {
    try {
      const url = await VFS.url(gameId, p);
      const dim = await probeImage(url);
      if (!dim.ok) continue;
      if (dim.w < 480 || dim.h < 70 || dim.h / dim.w > 0.6) continue;
      box.classList.add('game-ui');
      box.style.backgroundImage = `url("${url}")`;
      state.uiSkin = { status: 'ok', message: `已应用：${p}（${dim.w}×${dim.h}）`, path: p };
      if (announce) toast(`已套用游戏内对话框：${basename(p)}`, 'ok');
      updateSkinStatusUI();
      return;
    } catch { /* 继续尝试下一个候选 */ }
  }
  state.uiSkin = { status: 'fail', message: '失败：找到疑似素材，但都无法作为对话框使用', path: null };
  if (announce) toast(state.uiSkin.message, 'warn', 4800);
  updateSkinStatusUI();
}

function stopAudio(kind) {
  const a = state.audio[kind];
  if (a) {
    try { a.pause(); a.currentTime = 0; } catch { /* ignore */ }
    state.audio[kind] = null;
  }
  if (kind === 'bgm') { state.audio.bgmKey = null; }
}

async function playVoice(name) {
  stopAudio('voice');
  const path = state.resolver?.audio(name);
  if (!path) return;
  try {
    const url = await VFS.url(state.bundle.game.id, path);
    const a = new Audio(url);
    a.volume = Math.min(1, state.settings.voiceVolume ?? 1);
    state.audio.voice = a;
    a.play().catch(() => { });
  } catch { /* ignore */ }
}

async function playSe(name) {
  const path = state.resolver?.audio(name);
  if (!path) return;
  try {
    const url = await VFS.url(state.bundle.game.id, path);
    const a = new Audio(url);
    a.volume = state.settings.seVolume;
    a.play().catch(() => { });
    state.audio.se = a;
  } catch { /* ignore */ }
}

/* ---------- 打字机 ---------- */
function typeText(text) {
  clearInterval(state.typing.timer);
  clearTimeout(state.autoTimer);
  const line = $('#line');
  const full = String(text || '');
  state.typing = { full, shown: 0, done: false, timer: null };
  $('#next-hint').style.visibility = 'hidden';
  if (!full.trim()) { line.textContent = ''; finishTyping(); return; }
  if (state.skip || state.settings.textSpeed <= 0) {
    line.textContent = full;
    finishTyping();
    return;
  }
  line.textContent = '';
  const speed = Math.max(6, state.settings.textSpeed);
  state.typing.timer = setInterval(() => {
    state.typing.shown += 1;
    line.textContent = full.slice(0, state.typing.shown);
    if (state.typing.shown >= full.length) finishTyping();
  }, speed);
}

function finishTypingNow() {
  clearInterval(state.typing.timer);
  if (!state.typing.done) {
    $('#line').textContent = state.typing.full;
    finishTyping();
  }
}
function finishTyping() {
  clearInterval(state.typing.timer);
  state.typing.done = true;
  $('#next-hint').style.visibility = 'visible';
  scheduleAuto();
  scheduleSkip();
}

function scheduleAuto() {
  clearTimeout(state.autoTimer);
  if (!state.auto) return;
  state.autoTimer = setTimeout(() => { if (state.auto) advance(); }, Math.max(600, state.settings.autoDelay));
}
function scheduleSkip() {
  clearInterval(state.skipTimer);
  if (!state.skip) return;
  if (!$('#choices').hidden) return;
  state.skipTimer = setInterval(() => { if (state.skip) advance(true); }, 90);
}

function advance(fromSkip = false) {
  if (!state.player) return;
  if (!$('#choices').hidden) return;
  if (!state.typing.done) { finishTypingNow(); return; }
  const beat = state.player.next();
  renderBeat(beat);
  if (!fromSkip) { clearTimeout(state.autoTimer); state.skip = false; clearInterval(state.skipTimer); renderBadges(); }
}

function renderChoices(beat) {
  const box = $('#choices');
  $('#stage').classList.add('choosing');
  box.hidden = false;
  box.innerHTML = `<div class="choices-head">要怎么做？</div>` + beat.options.map((o, i) =>
    `<button class="choice" data-choice="${i}">${esc(o.text)}</button>`).join('');
  $('#next-hint').style.visibility = 'hidden';
  clearInterval(state.skipTimer);
}

function hideChoices() {
  $('#choices').hidden = true;
  $('#stage').classList.remove('choosing');
}

function choose(i) {
  if (!state.player) return;
  hideChoices();
  const beat = state.player.choose(i);
  renderBeat(beat);
}

function showEnd() {
  const card = $('#end-card');
  card.hidden = false;
  const p = state.player;
  const labels = state.bundle?.story?.chapterCount || state.bundle?.story?.labels?.length || 0;
  $('#end-meta').textContent = `已读 ${p.seen.size} / ${p.total} 段 · 覆盖 ${labels} 个章节 · 用时 ${formatDuration(Date.now() - (state.sessionStart - 0) + (state.bundle?.game?.playtimeMs || 0))}`;
  $('#next-hint').style.visibility = 'hidden';
  clearInterval(state.skipTimer);
  state.auto = false;
  renderBadges();
  persistSession();
}

/* ---------- 播放器 UI 事件 ---------- */
function renderBadges() {
  $('#player-badges').innerHTML = [
    state.auto ? '<span class="badge-play">AUTO</span>' : '',
    state.skip ? '<span class="badge-play">SKIP</span>' : '',
  ].join('');
}

function toggleAuto() { state.auto = !state.auto; state.skip = false; renderBadges(); if (state.auto) scheduleAuto(); else clearTimeout(state.autoTimer); }
function toggleSkip() { state.skip = !state.skip; state.auto = false; renderBadges(); if (state.skip) { advance(true); scheduleSkip(); } else clearInterval(state.skipTimer); }

async function toggleFavorite(id) {
  const g = state.games.find((x) => x.id === id) || (state.bundle?.game?.id === id ? state.bundle.game : null);
  if (!g) return;
  const next = !g.favorite;
  await DB.updateGame(id, { favorite: next });
  if (state.bundle?.game?.id === id) state.bundle.game.favorite = next;
  toast(next ? '已加入收藏' : '已取消收藏');
  await refreshLibrary();
  if (!$('#detail').hidden) openDetail(id);
}

async function removeGame(id) {
  const g = state.games.find((x) => x.id === id);
  if (!g) return;
  const ok = confirm(`删除《${g.title}》？\n会同时删除已解包的文件和存档。`);
  if (!ok) return;
  await deleteGame(id);
  state.coverUrls.delete(id);
  toast('已删除');
  location.hash = '';
  showLibrary();
  await refreshLibrary();
}

/* ---------- 存档 / 读档 / 回放 / 设置 ---------- */
async function openSaveModal(mode) {
  if (!state.player || !state.bundle) return;
  const id = state.bundle.game.id;
  const saves = await DB.listSaves(id).catch(() => []);
  const html = `
    <div class="modal-head"><h3>${mode === 'save' ? '存档' : '读档'}</h3><button class="icon-btn" data-close="1">${icon('close')}</button></div>
    <div class="modal-body">
      <div class="slot-grid">
        ${[1, 2, 3, 4, 5, 6, 7, 8].map((slot) => {
          const s = saves.find((x) => x.slot === slot);
          const snap = s?.snapshot;
          const when = s ? formatRelative(s.createdAt) : '';
          const pct = snap && state.bundle.story ? Math.round(((snap.seen?.length || 0) / Math.max(1, state.bundle.story.totalBeats)) * 100) : 0;
          return `<button class="slot ${s ? 'filled' : ''}" data-slot="${slot}">
            <span class="slot-no">${String(slot).padStart(2, '0')}</span>
            <span class="slot-main">${s ? esc(s.meta?.chapter || '进度') : '空存档位'}</span>
            <span class="slot-sub">${s ? `${pct}% · ${when}` : '点击' + (mode === 'save' ? '保存' : '读取')}</span>
          </button>`;
        }).join('')}
      </div>
      ${mode === 'load' && saves.length ? '<p class="muted">点击存档位读取；长按/右键可删除。</p>' : ''}
    </div>`;
  openModal(html);
  $$('#modals .slot').forEach((btn) => {
    const slot = Number(btn.dataset.slot);
    btn.addEventListener('click', async (e) => {
      if (mode === 'save') {
        await DB.putSave(id, slot, state.player.save(), { chapter: state.player.currentLabel()?.title || state.player.currentLabel()?.name || '' });
        toast(`已保存到存档 ${slot}`);
        closeModal();
        openSaveModal('save');
      } else {
        const s = await DB.get('saves', DB.saveKey(id, slot));
        if (!s) { toast('这个存档位是空的', 'warn'); return; }
        state.player = new StoryPlayer(state.bundle.story, s.snapshot);
        state.lastChapter = null;
        closeModal();
        $('#end-card').hidden = true;
        renderBeat(state.player.current || state.player.next());
        toast(`已读取存档 ${slot}`);
      }
    });
    btn.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      if (mode !== 'load') return;
      await DB.deleteSave(id, slot);
      toast('已删除该存档');
      openSaveModal('load');
    });
  });
}

function openBacklog() {
  if (!state.player) return;
  const items = state.player.history.slice(-220).reverse();
  openModal(`
    <div class="modal-head"><h3>回放</h3><button class="icon-btn" data-close="1">${icon('close')}</button></div>
    <div class="modal-body backlog">
      ${items.length ? items.map((h) => `<div class="backlog-item"><div class="bl-name">${esc(h.name || '旁白')}</div><div class="bl-text">${esc(h.text)}</div></div>`).join('') : '<p class="muted">还没有读过任何内容</p>'}
    </div>`);
}

async function openSettings(inPlayer = false) {
  const s = state.settings;
  const vfsKind = await VFS.kind();
  const themes = [['midnight', 'A 深夜书房'], ['washi', 'B 和纸'], ['neon', 'C 霓虹'], ['minimal', 'D 极简白']];
  openModal(`
    <div class="modal-head"><h3>设置</h3><button class="icon-btn" data-close="1">${icon('close')}</button></div>
    <div class="modal-body settings">
      <div class="field"><label>界面风格</label>
        <div class="seg theme-seg">${themes.map(([k, n]) => `<button class="${s.theme === k ? 'active' : ''}" data-theme="${k}">${n}</button>`).join('')}</div>
      </div>
      <div class="field"><label>文字速度 <b id="lbl-speed">${s.textSpeed <= 0 ? '瞬间' : s.textSpeed + 'ms / 字'}</b></label>
        <input type="range" min="0" max="80" step="2" value="${s.textSpeed}" data-set="textSpeed" id="rng-speed">
      </div>
      <div class="field"><label>自动阅读间隔 <b id="lbl-auto">${s.autoDelay}ms</b></label>
        <input type="range" min="400" max="4000" step="100" value="${s.autoDelay}" data-set="autoDelay" id="rng-auto">
      </div>
      <div class="field"><label>正文字号 <b id="lbl-font">${Math.round(s.fontSize * 100)}%</b></label>
        <input type="range" min="80" max="140" step="5" value="${Math.round(s.fontSize * 100)}" data-set="fontSize" id="rng-font">
      </div>
      <div class="field"><label>BGM 音量 <b id="lbl-bgm">${Math.round(s.bgmVolume * 100)}%</b></label>
        <input type="range" min="0" max="100" step="5" value="${Math.round(s.bgmVolume * 100)}" data-set="bgmVolume" id="rng-bgm">
      </div>
      <div class="field"><label>音效音量 <b id="lbl-se">${Math.round(s.seVolume * 100)}%</b></label>
        <input type="range" min="0" max="100" step="5" value="${Math.round(s.seVolume * 100)}" data-set="seVolume" id="rng-se">
      </div>
      <div class="field row"><label>游戏内对话框素材</label>
        <div class="ui-skin-row">
          <button class="pill-toggle ${s.useGameUi ? 'active' : ''}" id="toggle-gameui">${s.useGameUi ? '已开启' : '关闭'}</button>
          <span class="ui-skin-status" id="ui-skin-status" data-state="${s.useGameUi ? state.uiSkin.status : 'off'}">${skinStatusText()}</span>
        </div>
      </div>
      <div class="field"><label>说明</label><span class="muted">开启后会从游戏文件里找 textbox / message window 之类的 UI 图，找到就替换对话框底图；找不到或加载失败会直接显示「失败」，不影响正常阅读。</span></div>
      <div class="field row"><label>维护</label>
        <button class="btn ghost sm" id="btn-reparse-all">重新解析所有剧本</button>
      </div>
      <div class="field"><span class="muted">解析器升级后，用这个让库里的旧游戏按新版本重新生成剧情——不会重新解压，几秒完成。</span></div>
      <div class="field row"><label>保留原始封包文件</label>
        <div class="ui-skin-row">
          <button class="pill-toggle ${s.keepArchives ? 'active' : ''}" id="toggle-keeparchives">${s.keepArchives ? '保留' : '跳过（更快）'}</button>
        </div>
      </div>
      <div class="field"><label>说明</label><span class="muted">关闭时，KiriKiri/Ren'Py/ONS 的内封包（xp3 / rpa / nsa / sar）只解出图片、音频、脚本，原始封包不落盘：导入更快、占空间更少；需要自己手动提取资源时再打开。</span></div>
      <div class="field row"><label>存储位置</label><span class="muted">${vfsKind === 'opfs' ? 'OPFS（可存大文件）' : 'IndexedDB 兜底'}</span></div>
      <div class="field row"><label>快捷键</label><span class="muted">空格/回车 前进 · A 自动 · Ctrl 快进 · H 回放 · F 全屏 · Esc 返回</span></div>
      <div class="field row"><label>危险操作</label><button class="btn ghost danger sm" id="btn-clear-all">${icon('trash')}清空游戏库</button></div>
    </div>`);
  $$('#modals [data-theme]').forEach((b) => b.addEventListener('click', () => {
    applyTheme(b.dataset.theme);
    $$('#modals [data-theme]').forEach((x) => x.classList.toggle('active', x === b));
  }));
  $('#btn-reparse-all')?.addEventListener('click', async () => {
    const games = state.games.filter((g) => ['renpy', 'kirikiri', 'ons'].includes(g.engine));
    if (!games.length) { toast('没有可重新解析的游戏', 'info'); return; }
    for (let i = 0; i < games.length; i++) {
      try { await reparseGame(games[i].id); } catch { /* ignore */ }
      toast(`重新解析 ${i + 1}/${games.length}：${games[i].title}`, 'info', 1100);
    }
    await refreshLibrary();
    toast('所有剧本已按当前解析器重新生成', 'ok', 4200);
  });
  $('#toggle-keeparchives')?.addEventListener('click', async () => {
    state.settings.keepArchives = !state.settings.keepArchives;
    await DB.setSetting('keepArchives', state.settings.keepArchives);
    const btn = $('#toggle-keeparchives');
    if (btn) { btn.classList.toggle('active', state.settings.keepArchives); btn.textContent = state.settings.keepArchives ? '保留' : '跳过（更快）'; }
    toast(state.settings.keepArchives ? '之后导入会保留原始封包（更慢、更占空间）' : '之后导入会跳过原始封包（更快、更省空间）', 'info', 3600);
  });
  $('#toggle-gameui')?.addEventListener('click', async () => {
    state.settings.useGameUi = !state.settings.useGameUi;
    await DB.setSetting('useGameUi', state.settings.useGameUi);
    if (state.bundle && state.player) {
      await applyGameUiSkin({ announce: true });
    } else {
      state.uiSkin = { status: state.settings.useGameUi ? 'idle' : 'off', message: state.settings.useGameUi ? '' : '关闭', path: null };
    }
    updateSkinStatusUI();
  });
  bindSettingRange('rng-speed', 'textSpeed', (v) => $('#lbl-speed').textContent = v <= 0 ? '瞬间' : v + 'ms / 字');
  bindSettingRange('rng-auto', 'autoDelay', (v) => $('#lbl-auto').textContent = v + 'ms');
  bindSettingRange('rng-font', 'fontSize', (v) => { $('#lbl-font').textContent = v + '%'; applyFontSize(); }, 100);
  bindSettingRange('rng-bgm', 'bgmVolume', (v) => { $('#lbl-bgm').textContent = v + '%'; if (state.audio.bgm) state.audio.bgm.volume = v / 100; }, 100);
  bindSettingRange('rng-se', 'seVolume', (v) => $('#lbl-se').textContent = v + '%', 100);
  $('#btn-clear-all')?.addEventListener('click', async () => {
    if (!confirm('清空整个游戏库？所有导入的游戏与存档都会被删除。')) return;
    for (const g of state.games) await deleteGame(g.id);
    state.coverUrls.clear();
    closeModal();
    toast('游戏库已清空');
    await refreshLibrary();
  });
}

function bindSettingRange(id, key, labelFn, scale = 1) {
  const el = $('#' + id);
  if (!el) return;
  el.addEventListener('input', async () => {
    const v = Number(el.value) / scale;
    state.settings[key] = key === 'fontSize' || key === 'bgmVolume' || key === 'seVolume' ? v : Number(el.value);
    labelFn(Number(el.value));
    await DB.setSetting(key, state.settings[key]);
    if (key === 'bgmVolume' && state.audio.bgm) state.audio.bgm.volume = state.settings.bgmVolume;
  });
}

/* ---------- 模态框 / Toast ---------- */
function openModal(html) {
  const root = $('#modals');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog">${html}</div></div>`;
  root.classList.add('open');
  $$('.modal-backdrop [data-close]', root).forEach((b) => b.addEventListener('click', closeModal));
  const back = $('.modal-backdrop', root);
  back.addEventListener('click', (e) => { if (e.target === back) closeModal(); });
}
function closeModal() {
  $('#modals').innerHTML = '';
  $('#modals').classList.remove('open');
}

function toast(message, kind = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(message)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('visible'), 10);
  setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 300); }, ms);
}

/* ============================== 全局事件 ============================== */
function bindGlobalEvents() {
  $('#btn-import').addEventListener('click', openFilePicker);
  $('#btn-import-2')?.addEventListener('click', openFilePicker);
  $('#btn-native')?.addEventListener('click', openNativeModal);
  $('#btn-native-2')?.addEventListener('click', openNativeModal);
  $('#btn-import-folder')?.addEventListener('click', openFolderPicker);
  $('#btn-folder-2')?.addEventListener('click', openFolderPicker);
  $('#folder-input').addEventListener('change', async (e) => {
    const input = e.target;
    const picked = Array.from(input.files || []);
    await importDirectoryFiles(picked);
    input.value = '';
  });
  $('#btn-demos')?.addEventListener('click', () => installDemos());
  $('#btn-settings').addEventListener('click', () => openSettings(false));
  $('#btn-player-settings').addEventListener('click', () => openSettings(true));
  $('#ip-close').addEventListener('click', () => {
    if (state.importing && state.abortCtrl) { cancelImport(); return; }
    hideImportPanel();
  });
  $('#file-input').addEventListener('change', async (e) => {
    const input = e.target;
    const picked = Array.from(input.files || []);
    await handleFiles(picked);
    input.value = '';
  });

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    state.filter = b.dataset.filter;
    $$('#tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
    $$('#chips .chip').forEach((x) => x.classList.toggle('active', x.dataset.filter === state.filter));
    renderLibrary();
  });
  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    state.filter = b.dataset.filter;
    $$('#chips .chip').forEach((x) => x.classList.toggle('active', x === b));
    $$('#tabs .tab').forEach((x) => x.classList.toggle('active', x.dataset.filter === state.filter));
    renderLibrary();
  });
  $('#sort').addEventListener('click', async () => {
    const order = ['recent', 'name', 'progress'];
    const names = { recent: '最近游玩', name: '标题', progress: '进度' };
    const next = order[(order.indexOf(state.settings.sort) + 1) % order.length];
    state.settings.sort = next;
    $('#sort').innerHTML = `${names[next]}${icon('chevron')}`;
    await DB.setSetting('sort', next);
    renderLibrary();
  });
  $('#view-toggle').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    state.settings.view = b.dataset.view;
    await DB.setSetting('view', b.dataset.view);
    renderLibrary();
  });
  $('#search').addEventListener('input', (e) => { state.query = e.target.value; renderLibrary(); });

  // 卡片 / 详情 / 播放器 上的通用动作
  document.addEventListener('click', async (e) => {
    const actEl = e.target.closest('[data-act]');
    if (actEl) {
      const { act, id, index, mode } = actEl.dataset;
      if (act === 'play') { e.stopPropagation(); openGame(id, { mode: mode || 'continue' }); return; }
      if (act === 'detail') { e.stopPropagation(); location.hash = `#/game/${id}`; return; }
      if (act === 'restart') { e.stopPropagation(); openGame(id, { mode: 'restart' }); return; }
      if (act === 'jump') { e.stopPropagation(); openGame(id, { mode: 'restart', jumpIndex: Number(index) }); return; }
      if (act === 'fav') { e.stopPropagation(); toggleFavorite(id); return; }
      if (act === 'reparse') { e.stopPropagation(); handleReparse(id); return; }
      if (act === 'delete') { e.stopPropagation(); removeGame(id); return; }

      if (act === 'back') { e.stopPropagation(); location.hash = ''; showLibrary(); return; }
      if (act === 'restart' && !id && state.bundle) { e.stopPropagation(); openGame(state.bundle.game.id, { mode: 'restart' }); return; }
      if (act === 'to-library' && !id) { e.stopPropagation(); exitPlayer(); return; }
      if (act === 'to-library' && state.bundle) { e.stopPropagation(); exitPlayer(); return; }
      if (act === 'restart' && state.bundle) { e.stopPropagation(); openGame(state.bundle.game.id, { mode: 'restart' }); return; }
    }
    const card = e.target.closest('.card, .row-item');
    if (card && card.dataset.id) { location.hash = `#/game/${card.dataset.id}`; return; }
    const choice = e.target.closest('.choice[data-choice]');
    if (choice) { choose(Number(choice.dataset.choice)); return; }
  });

  $('#btn-exit').addEventListener('click', () => exitPlayer());
  $('#btn-fullscreen').addEventListener('click', toggleFullscreen);
  $('#dialogue').addEventListener('click', (e) => { if (!e.target.closest('button')) advance(); });
  $('#stage').addEventListener('click', (e) => {
    if (e.target.closest('button, #dialogue, #choices, #stage-top, #end-card')) return;
    if (!state.player || !$('#choices').hidden) return;
    advance();
  });
  $$('.dlg-controls button').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = b.dataset.act;
    if (act === 'auto') toggleAuto();
    if (act === 'skip') toggleSkip();
    if (act === 'backlog') openBacklog();
    if (act === 'save') openSaveModal('save');
    if (act === 'load') openSaveModal('load');
    if (act === 'settings') openSettings(true);
  }));

  // 键盘
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('#modals').classList.contains('open')) { closeModal(); return; }
      if (!state.player) return;
      if (!$('#choices').hidden) return;
      exitPlayer();
      return;
    }
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#search')?.focus(); return; }
    if (!state.player || $('#modals').classList.contains('open')) return;
    if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); advance(); return; }
    if (e.key === 'a' || e.key === 'A') { toggleAuto(); return; }
    if (e.key === 'Control') { if (!state.skip) toggleSkip(); return; }
    if (e.key === 'h' || e.key === 'H') { openBacklog(); return; }
    if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); const b = state.player.back(); if (b) renderBeat(b); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); advance(); return; }
    if (/^[1-9]$/.test(e.key) && !$('#choices').hidden) { choose(Number(e.key) - 1); return; }
  });
  document.addEventListener('keyup', (e) => { if (e.key === 'Control' && state.skip) toggleSkip(); });

  // 拖拽导入
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    dragDepth++; $('#drop-overlay').hidden = false;
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop-overlay').hidden = true; });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    const dt = e.dataTransfer;
    const items = [...(dt?.items || [])];
    let hasDir = false;
    for (const it of items) {
      if (it.kind !== 'file') continue;
      try { if (it.webkitGetAsEntry?.()?.isDirectory) { hasDir = true; break; } } catch { /* ignore */ }
    }
    if (hasDir) {
      const dirEntries = [...(dt?.items || [])].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null)).filter(Boolean);
      const files = [];
      for (const en of dirEntries) await walkEntry(en, '', files);
      await importDirectoryEntriesWithProgress(files, dirEntries[0]?.name || '本地文件夹');
      return;
    }
    handleFiles(dt?.files);
  });

  window.addEventListener('hashchange', route);
  $('#sort').innerHTML = `${({ recent: '最近游玩', name: '标题', progress: '进度' })[state.settings.sort] || '最近游玩'}${icon('chevron')}`;
  $$('#view-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === (state.settings.view || 'grid')));
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => { });
  else document.exitFullscreen?.().catch(() => { });
}

/* 每 900ms 把进度写回 IndexedDB（避免每个字都写） */
function persistSessionThrottled() {
  if (state.saveTimer) return;
  state.saveTimer = setTimeout(() => { state.saveTimer = null; persistSession(); }, 900);
}

/* 占位：自动导入时的进度面板 */
window.addEventListener('beforeunload', () => { if (state.player) persistSession(true); });
