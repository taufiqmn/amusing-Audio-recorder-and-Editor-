// Non-destructive timeline. Recorded audio ("sources") is never modified; the
// timeline is a list of clips that point into sources. Every edit replaces the
// clip list, which makes undo/redo cheap and cuts instant even on long files.

let nextId = 1;
export const newId = (prefix = 's') => `${prefix}${Date.now().toString(36)}${(nextId++).toString(36)}`;

export class Timeline {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.sources = new Map(); // id -> Float32Array
    this.clips = [];          // [{ src, s, e }] sample ranges [s, e) in source
    this.undoStack = [];
    this.redoStack = [];
    this.crossfadeMs = 6;
    this._cache = null;
  }

  get length() { let n = 0; for (const c of this.clips) n += c.e - c.s; return n; }
  get duration() { return this.length / this.sampleRate; }

  addSource(data, id = newId()) { this.sources.set(id, data); return id; }

  /* ---------- core list operations (pure) ---------- */

  static splitAt(clips, pos) {
    // returns [left, right] clip lists split at timeline sample `pos`
    const left = [], right = []; let t = 0;
    for (const c of clips) {
      const len = c.e - c.s;
      if (t + len <= pos) left.push(c);
      else if (t >= pos) right.push(c);
      else {
        const cut = c.s + (pos - t);
        left.push({ src: c.src, s: c.s, e: cut });
        right.push({ src: c.src, s: cut, e: c.e });
      }
      t += len;
    }
    return [left, right];
  }

  static merge(clips) {
    // join adjacent pieces that are contiguous in the same source; drop empties
    const out = [];
    for (const c of clips) {
      if (c.e <= c.s) continue;
      const p = out[out.length - 1];
      if (p && p.src === c.src && p.e === c.s) out[out.length - 1] = { src: p.src, s: p.s, e: c.e };
      else out.push({ ...c });
    }
    return out;
  }

  /* ---------- history ---------- */

  commit(clips, label) {
    this.undoStack.push({ clips: this.clips, label });
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
    this.clips = Timeline.merge(clips);
    this._cache = null;
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  undo() {
    const st = this.undoStack.pop(); if (!st) return null;
    this.redoStack.push({ clips: this.clips, label: st.label });
    this.clips = st.clips; this._cache = null; return st.label;
  }
  redo() {
    const st = this.redoStack.pop(); if (!st) return null;
    this.undoStack.push({ clips: this.clips, label: st.label });
    this.clips = st.clips; this._cache = null; return st.label;
  }

  /* ---------- edits (positions are timeline samples) ---------- */

  clamp(pos) { return Math.max(0, Math.min(this.length, Math.round(pos))); }

  deleteRange(a, b, label = 'Delete') {
    a = this.clamp(a); b = this.clamp(b); if (b <= a) return false;
    const [left, rest] = Timeline.splitAt(this.clips, a);
    const [, right] = Timeline.splitAt(rest, b - a);
    this.commit([...left, ...right], label); return true;
  }

  keepRange(a, b) {
    a = this.clamp(a); b = this.clamp(b); if (b <= a) return false;
    const [, rest] = Timeline.splitAt(this.clips, a);
    const [mid] = Timeline.splitAt(rest, b - a);
    this.commit(mid, 'Keep selection'); return true;
  }

  /** Place a new take. mode: 'replace-end' | 'overwrite' | 'insert' | 'replace-range' */
  placeTake(srcId, pos, mode, rangeEnd) {
    const data = this.sources.get(srcId);
    const take = { src: srcId, s: 0, e: data.length };
    pos = this.clamp(pos);
    const [left, rest] = Timeline.splitAt(this.clips, pos);
    let clips;
    if (mode === 'replace-end') clips = [...left, take];
    else if (mode === 'insert') clips = [...left, take, ...rest];
    else if (mode === 'overwrite') {
      const [, after] = Timeline.splitAt(rest, data.length);
      clips = [...left, take, ...after];
    } else if (mode === 'replace-range') {
      const [, after] = Timeline.splitAt(rest, this.clamp(rangeEnd) - pos);
      clips = [...left, take, ...after];
    } else throw new Error('Unknown mode ' + mode);
    this.commit(clips, 'Record'); return pos + data.length;
  }

  /** Replace whole timeline with one source (used after Enhance). */
  replaceAll(srcId, label = 'Enhance') {
    const data = this.sources.get(srcId);
    this.commit([{ src: srcId, s: 0, e: data.length }], label);
  }

  /** Delete many ranges at once (one undo step). ranges: [[a,b],...] in timeline samples. */
  deleteRanges(ranges, label) {
    const sorted = ranges.filter(([a, b]) => b > a).sort((p, q) => q[0] - p[0]);
    if (!sorted.length) return false;
    let clips = this.clips;
    for (const [a, b] of sorted) {
      const [left, rest] = Timeline.splitAt(clips, a);
      const [, right] = Timeline.splitAt(rest, b - a);
      clips = [...left, ...right];
    }
    this.commit(clips, label); return true;
  }

  /** Timeline sample positions where two non-contiguous clips meet (edit points). */
  editPoints() {
    const pts = []; let t = 0;
    for (let i = 0; i < this.clips.length; i++) { if (i > 0) pts.push(t); t += this.clips[i].e - this.clips[i].s; }
    return pts;
  }

  /* ---------- rendering ---------- */

  /**
   * Render the timeline (or a range) into one Float32Array. At every edit point
   * an equal-power crossfade is applied using the audio just beyond each cut
   * (the "handles"), so splices are click-free and timing is unchanged.
   */
  render(a = 0, b = this.length) {
    if (a === 0 && b === this.length && this._cache) return this._cache;
    const full = this._renderFull();
    if (a === 0 && b === this.length) return full;
    return full.slice(this.clamp(a), this.clamp(b));
  }

  _renderFull() {
    const n = this.length; const out = new Float32Array(n);
    let t = 0;
    for (const c of this.clips) { out.set(this.sources.get(c.src).subarray(c.s, c.e), t); t += c.e - c.s; }
    const H = Math.round((this.crossfadeMs / 1000) * this.sampleRate / 2);
    t = 0;
    for (let i = 0; i < this.clips.length; i++) {
      const c = this.clips[i];
      if (i > 0 && H > 0) {
        const p = this.clips[i - 1];
        const pl = p.e - p.s, cl = c.e - c.s;
        const h = Math.min(H, Math.floor(pl / 2), Math.floor(cl / 2));
        if (h > 1) {
          const A = this.sources.get(p.src), B = this.sources.get(c.src);
          for (let k = -h; k < h; k++) {
            const ph = ((k + h) / (2 * h)) * (Math.PI / 2);
            const gOut = Math.cos(ph), gIn = Math.sin(ph);
            const ai = p.e + k, bi = c.s + k;
            const av = ai >= 0 && ai < A.length ? A[ai] : 0;
            const bv = bi >= 0 && bi < B.length ? B[bi] : 0;
            out[t + k] = av * gOut + bv * gIn;
          }
        }
      }
      t += c.e - c.s;
    }
    this._cache = out;
    return out;
  }

  /* ---------- analysis tools ---------- */

  /**
   * Find long pauses. Returns [[a,b],...] timeline ranges to delete so that every
   * pause longer than maxPauseSec is shortened to keepSec.
   */
  findLongPauses({ thresholdDb = -45, maxPauseSec = 1.0, keepSec = 0.5, relative = true } = {}) {
    const x = this.render(); const sr = this.sampleRate;
    const w = Math.round(0.01 * sr); const nW = Math.floor(x.length / w);
    const lv = new Float32Array(nW);
    for (let k = 0; k < nW; k++) {
      let s = 0; for (let i = k * w; i < (k + 1) * w; i++) s += x[i] * x[i];
      lv[k] = 10 * Math.log10(s / w + 1e-20);
    }
    let thr = thresholdDb;
    if (relative) { // relative to loud speech (90th percentile)
      const sorted = Array.from(lv).sort((p, q) => p - q);
      const loud = sorted[Math.floor(sorted.length * 0.9)] ?? -20;
      thr = Math.max(thresholdDb, loud - 35);
    }
    const ranges = []; let runStart = -1;
    for (let k = 0; k <= nW; k++) {
      const quiet = k < nW && lv[k] < thr;
      if (quiet && runStart < 0) runStart = k;
      if (!quiet && runStart >= 0) {
        const len = (k - runStart) * w;
        if (len > maxPauseSec * sr) {
          const remove = len - Math.round(keepSec * sr);
          const a = runStart * w + Math.round((len - remove) / 2);
          ranges.push([a, a + remove]);
        }
        runStart = -1;
      }
    }
    return ranges;
  }

  /* ---------- persistence ---------- */

  toJSON() { return { sampleRate: this.sampleRate, clips: this.clips }; }
  referencedSources() { return new Set(this.clips.map((c) => c.src)); }
}

/** Min/max peaks for waveform drawing: one [min,max] pair per `bucket` samples. */
export function computePeaks(x, bucket = 256) {
  const n = Math.ceil(x.length / bucket);
  const peaks = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) {
    let mn = 0, mx = 0; const st = k * bucket, en = Math.min(x.length, st + bucket);
    for (let i = st; i < en; i++) { const v = x[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    peaks[2 * k] = mn; peaks[2 * k + 1] = mx;
  }
  return peaks;
}
