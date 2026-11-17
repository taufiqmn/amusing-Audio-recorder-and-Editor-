// Playback of the rendered timeline. Optionally holds an alternate version
// (enhanced preview) that plays in sync, so A/B switching is instant and seamless.
export class Player {
  constructor(ctx) {
    this.ctx = ctx; this.buf = null; this.alt = null; this.useAlt = false;
    this.nodes = null; this.onEnd = () => {}; this.playing = false;
    this.out = new GainNode(ctx); this.out.connect(ctx.destination);
  }

  _toBuffer(x) {
    if (!x || !x.length) return null;
    const b = this.ctx.createBuffer(1, x.length, this.ctx.sampleRate);
    b.copyToChannel(x, 0); return b;
  }
  setAudio(x) { this.buf = this._toBuffer(x); }
  setAlt(x) { this.alt = x ? this._toBuffer(x) : null; if (!this.alt) this.useAlt = false; this._applyAB(0.01); }

  setUseAlt(v) { this.useAlt = !!v && !!this.alt; this._applyAB(0.03); }
  _applyAB(ramp) {
    if (!this.nodes) return;
    const t = this.ctx.currentTime;
    const { ga, gb } = this.nodes;
    ga.gain.setTargetAtTime(this.useAlt ? 0 : 1, t, ramp / 3);
    if (gb) gb.gain.setTargetAtTime(this.useAlt ? 1 : 0, t, ramp / 3);
  }

  /**
   * Play timeline samples [from, to). `when` lets callers schedule exactly
   * (used for pre-roll before recording). Returns the AudioContext start time.
   */
  play(from, to = null, when = null, onEnd = () => {}) {
    this.stop(true);
    if (!this.buf) return null;
    const sr = this.ctx.sampleRate;
    const end = Math.min(to ?? this.buf.length, this.buf.length);
    if (from >= end) return null;
    const start = when ?? this.ctx.currentTime + 0.02;
    const offset = from / sr, dur = (end - from) / sr;
    const sa = new AudioBufferSourceNode(this.ctx, { buffer: this.buf });
    const ga = new GainNode(this.ctx, { gain: this.useAlt && this.alt ? 0 : 1 });
    sa.connect(ga).connect(this.out);
    let sb = null, gb = null;
    if (this.alt) {
      sb = new AudioBufferSourceNode(this.ctx, { buffer: this.alt });
      gb = new GainNode(this.ctx, { gain: this.useAlt ? 1 : 0 });
      sb.connect(gb).connect(this.out);
      sb.start(start, Math.min(offset, this.alt.duration), dur);
    }
    sa.start(start, offset, dur);
    this.nodes = { sa, sb, ga, gb, start, from, end };
    this.playing = true;
    this.onEnd = onEnd;
    sa.onended = () => {
      if (this.nodes && this.nodes.sa === sa) { this.nodes = null; this.playing = false; const f = this.onEnd; this.onEnd = () => {}; f(); }
    };
    return start;
  }

  stop(silent = false) {
    if (!this.nodes) return;
    const { sa, sb } = this.nodes; this.nodes = null; this.playing = false;
    try { sa.onended = null; sa.stop(); } catch {}
    try { sb?.stop(); } catch {}
    if (!silent) { const f = this.onEnd; this.onEnd = () => {}; f(); }
  }

  /** Current play position in timeline samples (null when stopped). */
  get position() {
    if (!this.nodes) return null;
    const { start, from, end } = this.nodes;
    const t = this.ctx.currentTime - start;
    if (t < 0) return from;
    return Math.min(end, from + Math.round(t * this.ctx.sampleRate));
  }
}
