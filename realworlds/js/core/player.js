/* 剧情播放器 VM：执行 beats、处理跳转/调用/选项、记录已读与回滚 */

export class StoryPlayer {
  constructor(story, state = null) {
    this.story = story;
    this.program = story.program;
    this.pc = story.startIndex || 0;
    this.callStack = [];
    this.stage = { bg: null, sprites: [], bgm: null };
    this.seen = new Set();
    this.backStack = [];
    this.history = [];
    this.current = null;
    this.finished = false;
    this.lastChapter = null;
    this.startedAt = Date.now();
    if (state) this.restore(state);
  }

  get total() { return this.story.totalBeats || 0; }
  get progress() {
    if (!this.total) return 0;
    return Math.min(100, Math.round((this.seen.size / this.total) * 100));
  }

  currentLabel() {
    let best = null;
    for (const l of this.story.labels) {
      if (l.index <= Math.max(0, this.pc - 1) && (!best || l.index >= best.index)) best = l;
    }
    return best;
  }

  applyStage(stage) {
    if (!stage) return;
    this.stage = {
      bg: stage.bg ?? this.stage.bg,
      sprites: (stage.sprites || []).map((s) => ({ ...s })),
      bgm: stage.bgm ?? null,
    };
  }

  snapshot() {
    return {
      pc: this.current ? this.current.index : this.pc,
      callStack: this.callStack.slice(),
      stage: { bg: this.stage.bg, sprites: this.stage.sprites.map((s) => ({ ...s })), bgm: this.stage.bgm },
      historyLen: this.history.length,
    };
  }

  restore(state) {
    if (!state) return this;
    if (Array.isArray(state.seen)) this.seen = new Set(state.seen);
    if (state.pc != null) {
      this.pc = state.pc;
      this.finished = false;
      this.current = null;
      // 重新执行到目标 beat（不写历史）
      this._advanceSilent();
    }
    if (state.callStack) this.callStack = state.callStack.slice();
    if (state.stage) this.stage = { bg: state.stage.bg, sprites: (state.stage.sprites || []).map((s) => ({ ...s })), bgm: state.stage.bgm };
    return this;
  }

  _advanceSilent() {
    let guard = 0;
    while (guard++ < 50000) {
      if (this.pc < 0 || this.pc >= this.program.length) { this.finished = true; this.current = { t: 'end' }; return; }
      const beat = this.program[this.pc];
      const idx = this.pc;
      if (beat.t === 'jump') { this.pc = beat.to; continue; }
      if (beat.t === 'call') { this.callStack.push(this.pc + 1); this.pc = beat.to; continue; }
      if (beat.t === 'return') { this.pc = this.callStack.length ? this.callStack.pop() : -1; continue; }
      if (beat.t === 'chapter') { this.lastChapter = beat; this.pc++; continue; }
      if (beat.t === 'say' || beat.t === 'choice') {
        this.pc++;
        this.current = { ...beat, index: idx };
        this.applyStage(beat.stage);
        this.seen.add(idx);
        return;
      }
      this.pc++;
    }
    this.current = { t: 'end' };
    this.finished = true;
  }

  /** 前进到下一个可显示 beat；返回 beat（含 index） */
  next() {
    if (this.current) {
      const snap = {
        pc: this.current.index,
        callStack: this.callStack.slice(),
        stage: { bg: this.stage.bg, sprites: this.stage.sprites.map((s) => ({ ...s })), bgm: this.stage.bgm },
        historyLen: this.history.length,
      };
      this.backStack.push(snap);
      if (this.backStack.length > 120) this.backStack.shift();
    }
    let guard = 0;
    while (guard++ < 50000) {
      if (this.pc < 0 || this.pc >= this.program.length) {
        this.finished = true;
        this.current = { t: 'end' };
        return this.current;
      }
      const beat = this.program[this.pc];
      const idx = this.pc;
      if (beat.t === 'jump') { this.pc = beat.to; continue; }
      if (beat.t === 'call') { this.callStack.push(this.pc + 1); this.pc = beat.to; continue; }
      if (beat.t === 'return') { this.pc = this.callStack.length ? this.callStack.pop() : -1; continue; }
      if (beat.t === 'chapter') { this.lastChapter = beat; this.pc++; continue; }
      if (beat.t === 'say' || beat.t === 'choice') {
        this.pc++;
        this.current = { ...beat, index: idx };
        this.applyStage(beat.stage);
        this.seen.add(idx);
        if (beat.t === 'say') {
          this.history.push({ index: idx, name: beat.name, who: beat.who, text: beat.text });
          if (this.history.length > 400) this.history.shift();
        }
        return this.current;
      }
      this.pc++;
    }
    this.finished = true;
    this.current = { t: 'end' };
    return this.current;
  }

  /** 选择一个选项 */
  choose(i) {
    if (!this.current || this.current.t !== 'choice') return null;
    const opt = this.current.options[i];
    if (!opt) return null;
    const target = opt.to >= 0 ? opt.to : this.pc;
    this.backStack.push({
      pc: this.current.index,
      callStack: this.callStack.slice(),
      stage: { bg: this.stage.bg, sprites: this.stage.sprites.map((s) => ({ ...s })), bgm: this.stage.bgm },
    });
    this.pc = target;
    this.current = null;
    return this.next();
  }

  back() {
    const snap = this.backStack.pop();
    if (!snap) return null;
    this.pc = snap.pc;
    this.callStack = snap.callStack.slice();
    this.stage = snap.stage;
    this.finished = false;
    this.current = null;
    this._advanceSilent();
    return this.current;
  }

  /** 保存当前状态（恢复到该 beat 画面） */
  save() {
    return {
      pc: this.current ? this.current.index : this.pc,
      callStack: this.callStack.slice(),
      stage: { bg: this.stage.bg, sprites: this.stage.sprites.map((s) => ({ ...s })), bgm: this.stage.bgm },
      seen: [...this.seen],
      history: this.history.slice(-60),
    };
  }

  seenArray() { return [...this.seen]; }
}
