/* KiriKiri KAG3 .ks 脚本解析：标签 / 对白 / [link] 选项 / 背景立绘 / BGM / 跳转 */

const TAG_RE = /\[([a-zA-Z_][\w]*)((?:\s+[^\]]*)?)\]/g;
const ATTR_RE = /([a-zA-Z_][\w]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s\]]+))/g;

function parseAttrs(s = '') {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s))) out[m[1].toLowerCase()] = m[2] != null ? m[2] : m[3];
  return out;
}
const unescape = (s) => s.replace(/\\"/g, '"');

/** 从文本里拆出「名字「台词」」/「台词」 */
function splitSpeaker(text) {
  const m = /^\s*([^\s「」『』:：]{1,14})[「『]([\s\S]*?)[」』]\s*$/.exec(text);
  if (m) return { who: m[1], text: m[2] };
  return { who: null, text };
}

export function parseKS(files) {
  const labels = new Map();
  const order = [];
  const meta = { title: null, chars: {}, assets: { bg: [], sprite: [], bgm: [], se: [], voice: [] }, diagnostics: [] };
  const asset = (k, v) => { if (v && !meta.assets[k].includes(v)) meta.assets[k].push(v); };

  for (const file of files) {
    const fileKey = file.path;
    const lines = file.text.split(/\r?\n/);
    let cur = null;
    let msg = '';
    let inMacro = false;
    let inScript = false;
    let inIgnore = false;
    let pending = null;
    let linkBuf = null;

    const ensure = () => {
      if (cur) return cur;
      const key = fileKey + '::start';
      if (labels.has(key)) { cur = labels.get(key); return cur; }
      cur = { name: 'start', file: fileKey, title: null, cmds: [] };
      labels.set(key, cur);
      order.push(key);
      return cur;
    };
    const flushSay = () => {
      const text = msg.replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
      msg = '';
      if (!text.trim()) return;
      ensure();
      const { who, text: body } = splitSpeaker(text.trim());
      cur.cmds.push({ op: 'say', who, text: body });
    };
    const flushMenu = () => {
      if (pending && pending.options.length) {
        ensure();
        cur.cmds.push({ op: 'menu', options: pending.options.map((o) => ({ text: o.text.trim(), target: o.target, storage: o.storage })) });
      }
      pending = null;
      linkBuf = null;
    };
    const processText = (t) => {
      if (!t) return;
      if (pending) return; // 选项文字由 linkBuf 收集
      msg += t;
    };

    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) continue;
      if (/^\s*;/.test(line)) continue;
      if (inMacro) { if (/\[endmacro\]/i.test(line)) inMacro = false; continue; }
      if (inScript) { if (/\[endscript\]/i.test(line)) inScript = false; continue; }
      if (inIgnore) { if (/\[endignore\]/i.test(line)) inIgnore = false; continue; }

      const labelM = /^\s*\*([^\s|]+)\s*(?:\|(.*))?$/.exec(line);
      if (labelM) {
        flushSay();
        flushMenu();
        const key = fileKey + '::' + labelM[1];
        if (!labels.has(key)) {
          cur = { name: labelM[1], file: fileKey, title: labelM[2] ? labelM[2].trim() : null, cmds: [] };
          labels.set(key, cur);
          order.push(key);
        } else {
          cur = labels.get(key);
        }
        continue;
      }

      let tagSrc = line;
      if (/^\s*@/.test(line)) tagSrc = '[' + line.replace(/^\s*@/, '').trim() + ']';

      TAG_RE.lastIndex = 0;
      let last = 0, m, hadTag = false;
      while ((m = TAG_RE.exec(tagSrc))) {
        hadTag = true;
        processText(tagSrc.slice(last, m.index));
        last = TAG_RE.lastIndex;
        const tag = m[1].toLowerCase();
        const attrs = parseAttrs(m[2]);
        switch (tag) {
          case 'macro': inMacro = true; break;
          case 'endmacro': inMacro = false; break;
          case 'iscript': inScript = true; break;
          case 'endscript': inScript = false; break;
          case 'ignore': inIgnore = true; break;
          case 'endignore': inIgnore = false; break;
          case 'link':
          case 'button': {
            flushSay();
            if (!pending) pending = { options: [] };
            linkBuf = { text: '', target: attrs.target || '', storage: attrs.storage || '' };
            break;
          }
          case 'endlink':
            if (linkBuf && pending) { pending.options.push(linkBuf); linkBuf = null; }
            break;
          case 'r':
            if (linkBuf) linkBuf.text += '\n';
            else if (pending) { /* 选项区换行忽略 */ }
            else msg += '\n';
            break;
          case 'l': case 'p': case 's': case 'er': case 'ct': case 'cm': case 'click': case 'waitclick': {
            if (linkBuf) linkBuf.text += ' ';
            else if (!pending) {
              flushSay();
              if (tag === 'ct' || tag === 'cm') flushMenu();
            }
            break;
          }
          case 'bg': {
            const storage = attrs.storage || attrs.file;
            if (storage) { flushSay(); ensure(); cur.cmds.push({ op: 'bg', name: storage }); asset('bg', storage); }
            break;
          }
          case 'image':
          case 'pimage': {
            const storage = attrs.storage || attrs.file;
            if (!storage) break;
            flushSay(); ensure();
            const layer = attrs.layer;
            if (layer === 'base' || layer === '0' || layer == null) {
              cur.cmds.push({ op: 'bg', name: storage }); asset('bg', storage);
            } else {
              const pos = attrs.pos || '';
              cur.cmds.push({ op: 'show', name: storage, pos: /left/.test(pos) ? 'left' : /right/.test(pos) ? 'right' : 'center' });
              asset('sprite', storage);
            }
            break;
          }
          case 'bgm':
          case 'playbgm': case 'fadeinbgm': case 'xchgbgm': {
            const storage = attrs.storage || attrs.file;
            if (storage) { ensure(); cur.cmds.push({ op: 'bgm', name: storage }); asset('bgm', storage); }
            break;
          }
          case 'stopbgm': case 'fadeoutbgm':
            ensure(); cur.cmds.push({ op: 'stopbgm' }); break;
          case 'voice': {
            const storage = attrs.storage || attrs.file;
            if (storage) { ensure(); cur.cmds.push({ op: 'voice', name: storage }); asset('voice', storage); }
            break;
          }
          case 'playse': case 'fadeinse': {
            const storage = attrs.storage || attrs.file;
            if (storage) { ensure(); cur.cmds.push({ op: 'se', name: storage }); asset('se', storage); }
            break;
          }
          case 'jump': case 'call': {
            flushSay(); flushMenu(); ensure();
            cur.cmds.push({ op: tag, target: (attrs.target || '').replace(/^\*/, ''), storage: attrs.storage || '' });
            break;
          }
          case 'return':
            flushSay(); flushMenu(); ensure();
            cur.cmds.push({ op: 'return' });
            break;
          case 'title':
            if (attrs.name) meta.title = attrs.name;
            break;
          default:
            break; // 其它标签忽略
        }
      }
      if (!hadTag) {
        msg += line.replace(/\s+$/, '') + '\n';
      } else if (last < tagSrc.length) {
        processText(tagSrc.slice(last));
      }
    }
    flushSay();
    flushMenu();
    if (!cur) {
      const hasContent = [...labels.values()].some((l) => l.file === fileKey);
      if (!hasContent) ensure();
    }
  }
  return { engine: 'kirikiri', labels, order, chars: {}, meta };
}
