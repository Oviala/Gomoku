/* ONScripter / NScripter 脚本解析（nscript.dat / 0.txt / *.nsc）
   要点：文本行通常含中日文，指令行是 ASCII；据此区分，避免把指令当对白 */
const CJK_RE = /[\u2010-\u203f\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef\uac00-\ud7af]/;

const COMMANDS = new Set(`game bg ld lsp lsph lsp2 csp cl cs csl csr css clc cll cr select selectbtn
goto jump jumpf gosub gosubgoto return end click wait delay erase text br monocro dwave dwaveplay dwaveloop
dwavestop play playstop bgm bgmstop mp3 mp3loop mp3stop wave waveloop wavestop se stopse textclear caption
quake quakex quakey quakez mp3save hsp vsp isp rit rnd if notif endif btndef btn btnwait btnwait2
save load lookback trap resettrap automode skip defsub mov movie cd bgmfadeout bgmfadein sevol bgmvol
voicevol effect effectblank barclear bar prnum itoa atoi time date getversion print reset textspeed
defaultspeed savenumber savedir screenshot fileexist sysmenu systemcall gettitle resettimer gettimer
isskip textbox mesbox menuset menuwindow menusetwindow menusetsp menusetcolor menusetstyle menusetfont
menusetspeed menusetpos menusetbtn menusetnum titlebar windowtitle versionstr getreg setreg getcfg
setcfg getenv setenv exec system shell getstr getnum input inputnum csel selnum selgosub getparam
getparam2 getspmode ontrap getbtntimer btntime btntime2 trap2 texton textoff windowon windowoff
shadedistance shadeopacity setlayer getlayer autosave quicksave quickload history historystart historyend
bgmvol sevol mp3vol wavevol mp3fadein mp3fadeout dwavestop wavestop spriteset sprite clear nsa
ns2 nsaplay nsastop globalon savename savenum erasetextwindow textbtnwait texec setwindow exbtn repaint
defspeed english japanese nvl nvlclear indent endindent ruby rubyend autowc clickskip nextskip rclick
lsp2 lsph spbtn btnwait2 btrect btnsp gettext clickstr strsp windowbtn tablegoto trap2 jumpb
gosub goto end return select`.split(/\s+/).filter(Boolean));

const CMD_RE = new RegExp('^(' + [...COMMANDS].join('|') + ')(?![a-z0-9_])\\s*(.*)$', 'i');

function tokenizeArgs(rest) {
  const out = [];
  let i = 0;
  while (i < rest.length) {
    const c = rest[i];
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < rest.length && rest[j] !== '"') {
        if (rest[j] === '\\' && j + 1 < rest.length) { s += rest[j + 1]; j += 2; } else { s += rest[j]; j++; }
      }
      out.push(s);
      i = j + 1;
    } else if (c === ',' || c === ' ' || c === '\t') {
      i++;
    } else {
      let j = i;
      while (j < rest.length && !', \t'.includes(rest[j])) j++;
      out.push(rest.slice(i, j));
      i = j;
    }
  }
  return out;
}

function splitSpeaker(text) {
  let m = /^【([^】]{1,10})】\s*([\s\S]*)$/.exec(text);
  if (m) return { who: m[1], text: m[2].replace(/^[「『]|[」』]$/g, '') };
  m = /^\s*([^\s「」『』:：]{1,14})[「『]([\s\S]*?)[」』]\s*$/.exec(text);
  if (m) return { who: m[1], text: m[2] };
  m = /^\s*([^\s「」『』:：]{1,10})[:：]\s*([\s\S]+)$/.exec(text);
  if (m && CJK_RE.test(m[2]) && !/[「『]/.test(m[1])) return { who: m[1], text: m[2] };
  return { who: null, text };
}

export function parseNSC(files) {
  const labels = new Map();
  const order = [];
  const meta = { title: null, chars: {}, assets: { bg: [], sprite: [], bgm: [], se: [], voice: [] }, diagnostics: [] };
  const asset = (k, v) => { if (v && !meta.assets[k].includes(v)) meta.assets[k].push(v); };

  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    let cur = null;
    let started = false;
    let msg = '';
    let inDefine = false;
    let spriteIdx = 0;

    const ensure = () => {
      if (cur) return cur;
      const key = 'start';
      if (labels.has(key)) { cur = labels.get(key); return cur; }
      cur = { name: 'start', file: file.path, cmds: [] };
      labels.set(key, cur);
      order.push(key);
      return cur;
    };
    const flushSay = () => {
      const text = msg.replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '').trim();
      msg = '';
      if (!text) return;
      ensure();
      const { who, text: body } = splitSpeaker(text);
      cur.cmds.push({ op: 'say', who, text: body });
    };
    const flushMenu = (options) => {
      ensure();
      if (options.length) cur.cmds.push({ op: 'menu', options });
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith(';')) continue;

      const labelM = /^([*:])(\w+)\s*(?:\|(.*))?$/.exec(line);
      if (labelM) {
        flushSay();
        const name = labelM[2];
        if (name === 'define') { inDefine = true; cur = null; continue; }
        inDefine = false;
        const key = name;
        if (!labels.has(key)) {
          cur = { name, file: file.path, title: labelM[3] ? labelM[3].trim() : null, cmds: [] };
          labels.set(key, cur);
          order.push(key);
        } else {
          cur = labels.get(key);
          if (labelM[3] && !cur.title) cur.title = labelM[3].trim();
        }
        started = true;
        continue;
      }

      // 指令（ASCII 开头且命中指令表）
      const cmdM = CMD_RE.exec(line);
      if (cmdM) {
        const cmd = cmdM[1].toLowerCase();
        const rest = cmdM[2].trim();
        const args = tokenizeArgs(rest);
        switch (cmd) {
          case 'game': inDefine = false; break;
          case 'bg':
            if (args[0]) { flushSay(); ensure(); cur.cmds.push({ op: 'bg', name: args[0] }); asset('bg', args[0]); }
            break;
          case 'ld': case 'lsp': case 'lsph': case 'lsp2': {
            const slot = /^-?\d+$/.test(args[0] || '') ? parseInt(args[0], 10) : null;
            const from = slot != null ? 1 : 0;
            let fileArg = args.slice(from).find((a) => /\.(png|jpg|jpeg|webp|bmp|tga|gif)$/i.test(a));
            if (fileArg && (fileArg.includes(':') || fileArg.includes(';'))) fileArg = null; // ONS 复合文字/按钮精灵
            if (fileArg) {
              const x = parseFloat(args[from + 1]);
              const y = parseFloat(args[from + 2]);
              flushSay(); ensure();
              const pos = Number.isFinite(x) ? (x < 260 ? 'left' : x > 540 ? 'right' : 'center') : 'center';
              cur.cmds.push({ op: 'show', name: fileArg, pos, slot: slot != null ? slot : spriteIdx++, x: Number.isFinite(x) ? x : null, y: Number.isFinite(y) ? y : null });
              asset('sprite', fileArg);
            }
            break;
          }
          case 'csp': {
            const nums = args.filter((a) => /^-?\d+$/.test(a)).map(Number);
            flushSay(); ensure();
            if (!nums.length || nums.includes(-1)) cur.cmds.push({ op: 'hide', name: '*' });
            else cur.cmds.push({ op: 'hideSlots', slots: nums });
            break;
          }
          case 'cl': case 'cs': case 'csl': case 'csr': case 'css': case 'clc': case 'cll': case 'cr':
            flushSay(); ensure(); cur.cmds.push({ op: 'hide', name: '*' });
            break;
          case 'click': case 'wait': case 'delay': case 'textclear': case 'erase': case 'br': case 'monocro':
            flushSay(); break;
          case 'select': {
            flushSay();
            const opts = [];
            for (let i = 0; i + 1 < args.length; i += 2) {
              const text = args[i];
              let target = args[i + 1] || '';
              if (!text || !target) continue;
              opts.push({ text, target: target.replace(/^[*:]/, '') });
            }
            flushMenu(opts);
            break;
          }
          case 'goto': case 'jump': case 'jumpf': case 'gosub': case 'gosubgoto': {
            flushSay(); ensure();
            const target = (args[0] || '').replace(/^[*:]/, '');
            if (target) cur.cmds.push({ op: cmd.startsWith('gosub') ? 'call' : 'jump', target });
            break;
          }
          case 'return':
            flushSay(); ensure(); cur.cmds.push({ op: 'return' }); break;
          case 'end':
            flushSay(); ensure(); cur.cmds.push({ op: 'end' }); break;
          case 'dwave': case 'dwaveplay': case 'dwaveloop': {
            const slot = args.find((a) => /^-?\d+$/.test(a));
            const fileArg = args.find((a) => /\.(ogg|oga|opus|mp3|wav|flac|m4a|nwa)$/i.test(a));
            if (!fileArg) break;
            flushSay(); ensure();
            if (slot === '0' || slot == null) { cur.cmds.push({ op: 'voice', name: fileArg }); asset('voice', fileArg); }
            else { cur.cmds.push({ op: 'se', name: fileArg }); asset('se', fileArg); }
            break;
          }
          case 'dwavestop': case 'wavestop': case 'stopse':
            break;
          case 'bgm': case 'mp3': case 'mp3loop': case 'mp3play': {
            const fileArg = args.find((a) => /\.(ogg|oga|opus|mp3|wav|flac|m4a|nwa)$/i.test(a)) || args[0];
            if (fileArg) { ensure(); cur.cmds.push({ op: 'bgm', name: fileArg }); asset('bgm', fileArg); }
            break;
          }
          case 'bgmstop': case 'mp3stop': case 'bgmfadeout': case 'mp3fadeout': case 'stop':
            ensure(); cur.cmds.push({ op: 'stopbgm' }); break;
          case 'se': case 'playse': case 'wave': case 'waveloop': {
            const fileArg = args.find((a) => /\.(ogg|oga|opus|mp3|wav|flac|m4a|nwa)$/i.test(a));
            if (fileArg) { ensure(); cur.cmds.push({ op: 'se', name: fileArg }); asset('se', fileArg); }
            break;
          }
          case 'caption': case 'titlebar': case 'windowtitle':
            if (args[0] && !meta.title) meta.title = args[0];
            break;
          default:
            break;
        }
        continue;
      }

      // 不含中日文的 ASCII 行：当作指令/参数忽略
      if (!CJK_RE.test(line)) continue;
      if (inDefine) continue;
      msg += line.replace(/[\\]+\s*$/, '') + '\n';
    }
    flushSay();
  }
  return { engine: 'ons', labels, order, chars: {}, meta };
}
