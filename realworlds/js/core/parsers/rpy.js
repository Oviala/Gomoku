/* Ren'Py .rpy 脚本解析：label / 对白 / menu / scene / show / play music / jump / call */

const indentOf = (line) => {
  let n = 0;
  for (const ch of line) { if (ch === ' ') n++; else if (ch === '\t') n += 4; else break; }
  return n;
};

function stripComment(line) {
  let inStr = false, esc = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function unescapeText(s) {
  return s.replace(/\\(["\\nrt])/g, (m, c) => (c === 'n' ? '\n' : c === 'r' ? '' : c === 't' ? '\t' : c));
}

export function findBlockEnd(lines, i, end, indent) {
  let j = i + 1;
  let childIndent = null;
  for (; j < end; j++) {
    const raw = lines[j];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const ind = indentOf(raw);
    if (ind <= indent) break;
    if (childIndent == null) childIndent = ind;
  }
  return { start: i + 1, end: j, indent: childIndent ?? indent + 4 };
}

const SKIP_BLOCK = /^(python|init|screen|style|transform|image|translate|layeredimage|testcase|define\s+.*\b(screen|transform)\b)\s*:/;

function parseSay(text) {
  const m = /^(?:([A-Za-z_]\w*|narrator)\s+)?"((?:[^"\\]|\\.)*)"\s*(?:with\s+[\w.]+)?\s*(?:nointeract)?\s*$/.exec(text);
  if (!m) return null;
  if (m[1] === 'narrator') return { who: null, text: unescapeText(m[2]) };
  return { who: m[1] || null, text: unescapeText(m[2]) };
}

function parseSceneArgs(rest) {
  let s = rest.trim();
  s = s.replace(/\s+with\s+[\w.]+.*$/, '').replace(/\s+behind\s+.*$/, '');
  const parts = s.split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] === 'expression') return null;
  let name = parts[0];
  if (/^(bg|black|white)$/i.test(parts[0]) && parts[1]) name = parts.slice(0, 2).join(' ');
  else name = parts.join(' ');
  return name;
}

function parseShowArgs(rest) {
  let s = rest.trim().replace(/\s+with\s+[\w.]+.*$/, '');
  const parts = s.split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] === 'expression') return null;
  let pos = 'center';
  const at = parts.indexOf('at');
  if (at >= 0) {
    const where = parts.slice(at + 1).join(' ');
    if (/left/.test(where)) pos = 'left';
    else if (/right/.test(where)) pos = 'right';
    else if (/center|middle/.test(where)) pos = 'center';
    parts.length = at;
  }
  const cut = parts.findIndex((p) => ['as', 'behind', 'zorder', 'onlayer'].includes(p));
  if (cut > 0) parts.length = cut;
  const name = parts.filter((p) => p !== 'screen' && p !== 'with').join(' ');
  if (!name) return null;
  return { name, pos };
}

function parsePlayArgs(kind, rest) {
  const m = /"((?:[^"\\]|\\.)*)"/.exec(rest);
  const file = m ? unescapeText(m[1]) : rest.trim().split(/\s+/)[0];
  return file || null;
}

export function parseRenpy(files) {
  const labels = new Map();
  const order = [];
  const chars = {};
  const meta = { assets: { bg: [], sprite: [], bgm: [], se: [], voice: [] }, diagnostics: [] };
  const asset = (kind, name) => { if (name && !meta.assets[kind].includes(name)) meta.assets[kind].push(name); };

  const parseBlock = (lines, start, end, ctx) => {
    const out = [];
    let i = start;
    while (i < end) {
      const raw = lines[i];
      if (!raw.trim() || /^\s*#/.test(raw)) { i++; continue; }
      const indent = indentOf(raw);
      const text = stripComment(raw).trim();
      if (!text) { i++; continue; }

      // menu
      const menuM = /^menu\s*(?:[A-Za-z_]\w*)?\s*:\s*$/.exec(text);
      if (menuM) {
        const block = findBlockEnd(lines, i, end, indent);
        const options = [];
        let j = block.start;
        while (j < block.end) {
          const l = lines[j];
          if (!l.trim() || /^\s*#/.test(l)) { j++; continue; }
          const t = stripComment(l).trim();
          const om = /^"((?:[^"\\]|\\.)*)"\s*(?:if\s+.*)?:\s*$/.exec(t);
          if (om) {
            const ob = findBlockEnd(lines, j, block.end, indentOf(l));
            const body = parseBlock(lines, ob.start, ob.end, ctx);
            options.push({ text: unescapeText(om[1]), cmds: body });
            j = ob.end;
            continue;
          }
          const cm = /^choice\s*\(/.test(t);
          j = cm ? findBlockEnd(lines, j, block.end, indentOf(l)).end : j + 1;
        }
        if (options.length) out.push({ op: 'menu', options });
        i = block.end;
        continue;
      }

      // 条件分支：内容顺序内联（阅读模式不执行 Python 条件）
      if (/^(if|elif|else)\b[^:]*:\s*$/.test(text)) {
        const block = findBlockEnd(lines, i, end, indent);
        out.push(...parseBlock(lines, block.start, block.end, ctx));
        i = block.end;
        continue;
      }

      // 未知块 → 跳过
      if (SKIP_BLOCK.test(text)) { i = findBlockEnd(lines, i, end, indent).end; continue; }

      // 标签（局部 label）
      if (/^label\s+\./.test(text)) { i++; continue; }

      // 顶层的 define Character / config.name 可能在 label 之外
      let dm;
      if ((dm = /^define\s+(\w+)\s*=\s*Character\s*\(\s*(?:_\()?\s*"((?:[^"\\]|\\.)*)"/.exec(text))) {
        chars[dm[1]] = { name: unescapeText(dm[2]) };
        i++; continue;
      }
      if ((dm = /^define\s+config\.name\s*=\s*(?:_\()?\s*"((?:[^"\\]|\\.)*)"/.exec(text))) {
        meta.title = unescapeText(dm[1]);
        i++; continue;
      }

      // jump / call / return
      let m;
      if ((m = /^jump\s+([A-Za-z_][\w.]*)\s*$/.exec(text))) { out.push({ op: 'jump', target: m[1] }); i++; continue; }
      if ((m = /^call\s+([A-Za-z_][\w.]*)(?:\s*\([^)]*\))?\s*(?:from\s+\w+)?\s*$/.exec(text))) { out.push({ op: 'call', target: m[1] }); i++; continue; }
      if (/^return\b/.test(text)) { out.push({ op: 'return' }); i++; continue; }

      // scene / show / hide
      if ((m = /^scene\b(.*)$/.exec(text))) {
        const name = parseSceneArgs(m[1]);
        if (name) { out.push({ op: 'bg', name }); asset('bg', name); }
        i++; continue;
      }
      if ((m = /^show\s+(?!screen\b)(.*)$/.exec(text))) {
        const s = parseShowArgs(m[1]);
        if (s) { out.push({ op: 'show', name: s.name, pos: s.pos }); asset('sprite', s.name); }
        i++; continue;
      }
      if ((m = /^hide\s+(.*)$/.exec(text))) {
        const name = m[1].trim().split(/\s+/).filter((p) => !['with', 'at', 'as'].includes(p))[0];
        if (name) out.push({ op: 'hide', name });
        i++; continue;
      }

      // 音频
      if ((m = /^(play|queue|stop)\s+(music|sound|audio|voice)\b(.*)$/.exec(text))) {
        const [, verb, kind, rest] = m;
        const file = kind === 'voice' ? null : parsePlayArgs(kind, rest);
        if (verb === 'stop' || /^\s*$/.test(rest)) {
          if (kind === 'music') out.push({ op: 'stopbgm' });
        } else if (kind === 'music') {
          out.push({ op: 'bgm', name: file, loop: true });
          asset('bgm', file);
        } else if (kind === 'sound') {
          out.push({ op: 'se', name: file });
          asset('se', file);
        }
        if (kind === 'voice') {
          const v = parsePlayArgs('voice', rest);
          if (v) {
            const last = out[out.length - 1];
            if (last && last.op === 'say') last.voice = v;
            else out.push({ op: 'voice', name: v });
            asset('voice', v);
          }
        }
        i++; continue;
      }

      // define Character / config.name
      if ((m = /^define\s+(\w+)\s*=\s*Character\s*\(\s*(?:_\()?\s*"((?:[^"\\]|\\.)*)"/.exec(text))) {
        chars[m[1]] = { name: unescapeText(m[2]) };
        i++; continue;
      }
      if ((m = /^define\s+config\.name\s*=\s*(?:_\()?\s*"((?:[^"\\]|\\.)*)"/.exec(text))) {
        meta.title = unescapeText(m[1]);
        i++; continue;
      }
      if (/^(define|default|\$|init\s+python|python|screen|style|transform|image|window|nvl|centered|extend|voice|pause|with|play|queue|stop|renpy\.|charset|translate)\b/.test(text)) {
        i++; continue;
      }

      // 对白
      const say = parseSay(text);
      if (say) {
        if (say.who && chars[say.who] == null) chars[say.who] = { name: say.who };
        out.push({ op: 'say', who: say.who, text: say.text });
        i++; continue;
      }

      // 其它（含 `with dissolve`、`$` 之类）忽略
      i++;
    }
    return out;
  };

  for (const file of files) {
    if (/(\/|^)(screens|options|gui|common|00console|00keymap|00layout)\.rpy$/i.test(file.path)) continue;
    if (/\/tl\//.test(file.path)) continue;
    const lines = file.text.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      if (!raw.trim() || indentOf(raw) !== 0) { i++; continue; }
      const topText = stripComment(raw).trim();
      const topM = /^label\s+([A-Za-z_][\w.]*)\s*(?:\([^)]*\))?\s*:\s*$/.exec(topText);
      if (!topM) {
        let dm;
        if ((dm = /^define\s+(\w+)\s*=\s*Character\s*\(\s*(?:_\()?\s*"((?:[^"\\]|\\.)*)"/.exec(topText))) chars[dm[1]] = { name: unescapeText(dm[2]) };
        else if ((dm = /^define\s+config\.name\s*=\s*(?:_\()?\s*"((?:[^"\\]|\\.)*)"/.exec(topText))) meta.title = unescapeText(dm[1]);
        i++;
        continue;
      }
      let labelTitle = null;
      for (let k = i - 1; k >= 0; k--) {
        const prev = lines[k];
        if (!prev.trim()) continue;
        const cm = /^\s*#+\s*(.+)$/.exec(prev);
        if (!cm) break;
        const t = cm[1].trim();
        if (t && t.length <= 40) labelTitle = t;
        break;
      }
      const m = topM;
      const name = m[1];
      if (name.startsWith('.')) { i++; continue; }
      // 找 label 块结束（下一次 indent 0 的非空行）
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || indentOf(lines[j]) > 0 || /^\s*#/.test(lines[j]))) j++;
      const cmds = parseBlock(lines, i + 1, j, {});
      if (!labels.has(name)) {
        labels.set(name, { name, file: file.path, title: labelTitle, cmds });
        order.push(name);
      }
      i = j;
    }
  }
  return { engine: 'renpy', labels, order, chars, meta };
}
