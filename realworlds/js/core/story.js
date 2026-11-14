/* 把解析出的脚本编译成可播放的线性程序（beats + 跳转/选项索引） */
import { ENGINE_LABEL } from './detect.js';

function buildIndexes(parsed) {
  const byName = new Map();
  const byFileAndName = new Map();
  for (const [key, label] of parsed.labels) {
    const name = label.name || String(key).split('::').pop();
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(key);
    if (label.file) byFileAndName.set(label.file + '::' + name, key);
  }
  return { byName, byFileAndName };
}

/**
 * @param {{engine:string, labels:Map, order:string[], chars:Object, meta:Object}} parsed
 * @param {{title?:string}} opts
 */
export function compileStory(parsed, opts = {}) {
  const chars = parsed.chars || {};
  const { byName, byFileAndName } = buildIndexes(parsed);
  const warnings = [...(parsed.meta?.diagnostics || [])];
  const program = [];
  const labelIndex = new Map();
  const pending = [];
  const queueSe = [];
  let queueVoice = null;
  let stage = { bg: null, sprites: [], bgm: null };
  const snap = () => ({ bg: stage.bg, sprites: stage.sprites.map((s) => ({ ...s })), bgm: stage.bgm });

  const labelName = (key) => {
    const l = parsed.labels.get(key);
    if (l?.name) return l.name;
    const i = String(key).lastIndexOf('::');
    return i >= 0 ? String(key).slice(i + 2) : String(key);
  };

  const resolveTarget = (target, storage = '', currentFile = '') => {
    const t = String(target || '').replace(/^\*/, '').trim();
    if (!t) return null;
    if (parsed.labels.has(t)) return t;
    const direct = byFileAndName.get((storage || currentFile) + '::' + t);
    if (direct) return direct;
    if (storage) {
      const st = storage.replace(/\\/g, '/');
      for (const [key, label] of parsed.labels) {
        if ((label.name || '') !== t) continue;
        const f = label.file || '';
        if (f === st || f.endsWith('/' + st) || st.endsWith('/' + f) || f.split('/').pop() === st.split('/').pop()) return key;
      }
    }
    const list = byName.get(t);
    return list && list.length ? list[0] : null;
  };

  const compileCmds = (cmds, ctx) => {
    for (const c of cmds) {
      switch (c.op) {
        case 'say': {
          const beat = {
            t: 'say',
            who: c.who || null,
            name: c.who ? (chars[c.who]?.name || c.who) : null,
            text: c.text,
            stage: snap(),
          };
          if (c.voice || queueVoice) { beat.voice = c.voice || queueVoice; queueVoice = null; }
          if (queueSe.length) { beat.se = queueSe.splice(0); }
          program.push(beat);
          break;
        }
        case 'voice':
          queueVoice = c.name;
          break;
        case 'se':
          queueSe.push(c.name);
          break;
        case 'bg':
          stage.bg = c.name;
          break;
        case 'show': {
          const existing = c.slot != null
            ? stage.sprites.find((s) => s.slot === c.slot)
            : stage.sprites.find((s) => s.name === c.name);
          if (existing) {
            existing.name = c.name;
            existing.pos = c.pos || existing.pos;
            existing.x = c.x ?? existing.x;
            existing.y = c.y ?? existing.y;
          } else {
            stage.sprites.push({ name: c.name, pos: c.pos || 'center', slot: c.slot ?? null, x: c.x ?? null, y: c.y ?? null });
          }
          break;
        }
        case 'hideSlots':
          stage.sprites = stage.sprites.filter((s) => !(c.slots || []).includes(s.slot));
          break;
        case 'hide':
          if (c.name === '*') stage.sprites = [];
          else stage.sprites = stage.sprites.filter((s) => s.name !== c.name && !s.name.startsWith(c.name + ' '));
          break;
        case 'bgm':
          stage.bgm = c.name;
          break;
        case 'stopbgm':
          stage.bgm = null;
          break;
        case 'jump': {
          const beat = { t: 'jump', to: -1 };
          program.push(beat);
          pending.push({ kind: 'label', obj: beat, prop: 'to', target: c.target, storage: c.storage, file: ctx.file });
          break;
        }
        case 'call': {
          const beat = { t: 'call', to: -1 };
          program.push(beat);
          pending.push({ kind: 'label', obj: beat, prop: 'to', target: c.target, storage: c.storage, file: ctx.file });
          break;
        }
        case 'return':
        case 'end':
          program.push({ t: 'return' });
          break;
        case 'menu': {
          const beat = { t: 'choice', options: [], stage: snap() };
          if (queueSe.length) { beat.se = queueSe.splice(0); }
          program.push(beat);
          const contJumps = [];
          for (const opt of c.options || []) {
            if (opt.cmds) {
              const start = program.length;
              beat.options.push({ text: opt.text, to: start });
              compileCmds(opt.cmds, ctx);
              const j = { t: 'jump', to: -1 };
              program.push(j);
              contJumps.push(j);
            } else {
              const o = { text: opt.text, to: -1 };
              beat.options.push(o);
              pending.push({ kind: 'label', obj: o, prop: 'to', target: opt.target, storage: opt.storage, file: ctx.file });
            }
          }
          const cont = program.length;
          for (const j of contJumps) j.to = cont;
          break;
        }
        default:
          break;
      }
    }
  };

  // 起始 label：优先 start，其次第一个有对白的 label
  const order = (parsed.order || []).filter((k) => parsed.labels.has(k));
  let startKey = null;
  for (const k of order) if (labelName(k) === 'start') { startKey = k; break; }
  if (!startKey) {
    for (const k of order) {
      const cmds = parsed.labels.get(k)?.cmds || [];
      if (cmds.some((c) => c.op === 'say' || c.op === 'menu')) { startKey = k; break; }
    }
  }
  if (!startKey && order.length) startKey = order[0];

  // 按文件顺序编译：从 start 开始线性执行时会自然落到下一个 label（ONS 常见结构）
  const compileOrder = order;
  for (const key of compileOrder) {
    const label = parsed.labels.get(key);
    if (!label) continue;
    labelIndex.set(key, program.length);
    if (label.title) program.push({ t: 'chapter', title: label.title, label: labelName(key) });
    compileCmds(label.cmds || [], { file: label.file || '' });
  }

  // 回填跳转目标
  for (const p of pending) {
    const key = resolveTarget(p.target, p.storage, p.file);
    if (key == null) {
      warnings.push(`跳转目标未找到：${p.target || '(空)'}`);
      p.obj[p.prop] = -1;
    } else {
      p.obj[p.prop] = labelIndex.get(key) ?? -1;
    }
  }

  // ONS 移植脚本里大量「按钮等待/子程序」循环不是阅读器能线性执行的：
  // 对 ONS 采用线性阅读模式（保留对白/选项/章节，去掉跳转类指令并重映射选项目标）
  const linearOns = parsed.engine === 'ons';
  if (linearOns) {
    const keep = [];
    const oldToNew = new Map();
    for (let i = 0; i < program.length; i++) {
      const b = program[i];
      if (b.t === 'say' || b.t === 'choice' || b.t === 'chapter') oldToNew.set(i, keep.length), keep.push(b);
    }
    for (const b of keep) {
      if (b.t === 'choice' && Array.isArray(b.options)) {
        for (const o of b.options) o.to = o.to >= 0 ? (oldToNew.get(o.to) ?? 0) : -1;
      }
    }
    program.length = 0;
    program.push(...keep);
  }

  const sayCount = program.filter((b) => b.t === 'say').length;
  const choiceCount = program.filter((b) => b.t === 'choice').length;
  const RENPY_NON_CHAPTER = /^(_|start$|after_load|quit|splashscreen|before_main_menu|main_menu|before_load)/;
  const labels = linearOns ? [{
    key: startKey || 'start', name: labelName(startKey || 'start'), title: null, index: 0, chapter: false,
  }] : compileOrder.map((key) => {
    const label = parsed.labels.get(key);
    const name = labelName(key);
    const title = label?.title || null;
    const isChapter = !!title || (parsed.engine === 'renpy' && !RENPY_NON_CHAPTER.test(name) && label?.cmds?.some((c) => c.op === 'say'));
    return { key, name, title, index: labelIndex.get(key) ?? 0, chapter: isChapter };
  });
  const chapterCount = labels.filter((l) => l.chapter).length;

  return {
    engine: parsed.engine,
    engineLabel: ENGINE_LABEL[parsed.engine] || parsed.engine,
    title: opts.title || parsed.meta?.title || '',
    program,
    labels,
    chapterCount,
    labelIndex: linearOns ? { [startKey || 'start']: 0 } : Object.fromEntries(labelIndex),
    startIndex: linearOns ? 0 : (startKey ? (labelIndex.get(startKey) ?? 0) : 0),
    chars: Object.fromEntries(Object.entries(chars).map(([k, v]) => [k, { name: v.name || k }])),
    assets: parsed.meta?.assets || { bg: [], sprite: [], bgm: [], se: [] },
    totalBeats: sayCount + choiceCount,
    sayCount,
    choiceCount,
    warnings,
  };
}

/** 给 UI 用：当前进度百分比 */
export function beatProgress(story, seenCount) {
  if (!story || !story.totalBeats) return 0;
  return Math.min(100, Math.round((seenCount / story.totalBeats) * 100));
}
