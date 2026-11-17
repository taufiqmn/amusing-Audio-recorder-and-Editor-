// Waveform view: ruler, waveform, selection, cursor, playhead, edit points,
// live recording overlay, and a whole-file overview strip.
export const BUCKET = 256;

export function fmtTime(sec, precise = true) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = precise ? s.toFixed(2).padStart(5, '0') : String(Math.floor(s)).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export class WaveformView {
  constructor(canvas, overview, { onCursor, onSelect, onViewChange } = {}) {
    this.c = canvas; this.o = overview;
    this.g = canvas.getContext('2d'); this.og = overview.getContext('2d');
    this.onCursor = onCursor || (() => {}); this.onSelect = onSelect || (() => {});
    this.onViewChange = onViewChange || (() => {});
    this.sr = 48000; this.raw = new Float32Array(0); this.peaks = new Float32Array(0);
    this.start = 0; this.spp = 400; // view: first visible sample, samples per CSS pixel
    this.cursor = 0; this.sel = null; this.playhead = null; this.editPoints = [];
    this.live = null; // { pos, peaks: number[], replaceFrom: sample|null, rangeEnd }
    this.ruler = 26; this.dirty = true; this.follow = true;
    this._readColors();
    this._bind();
    new ResizeObserver(() => this._resize()).observe(canvas);
    new ResizeObserver(() => this._resize()).observe(overview);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this._readColors(); this.redraw(); });
    const loop = () => { if (this.dirty) { this.dirty = false; this._draw(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  _readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    this.col = {
      bg: v('--wave-bg'), wave: v('--wave'), waveSel: v('--wave-sel'), sel: v('--sel'), grid: v('--line'),
      text: v('--muted'), cursor: v('--accent'), play: v('--text'), rec: v('--rec'), edit: v('--edit-mark'),
      dim: v('--wave-dim'), ov: v('--surface-2'), view: v('--accent'),
    };
  }

  /* ---------- data ---------- */

  setAudio(raw, peaks, sr) {
    this.raw = raw; this.peaks = peaks; this.sr = sr;
    if (this.cursor > raw.length) this.cursor = raw.length;
    this._clampView(); this.redraw();
  }
  get length() { return this.raw.length; }
  get width() { return this.c.clientWidth || 1; }
  get visibleSamples() { return this.width * this.spp; }

  redraw() { this.dirty = true; }

  /* ---------- view ---------- */

  _clampView() {
    const total = Math.max(this.length, this.live ? this.live.pos + this.live.peaks.length / 2 * BUCKET : 0);
    const minSpp = 0.05, maxSpp = Math.max(400, (total * 1.05) / this.width);
    this.spp = Math.min(maxSpp, Math.max(minSpp, this.spp));
    const maxStart = Math.max(0, total - this.visibleSamples * 0.9);
    this.start = Math.min(maxStart, Math.max(0, this.start));
  }
  fit() {
    const total = Math.max(this.length, 1);
    this.spp = Math.max(1, total / this.width * 1.02); this.start = 0; this._clampView(); this.redraw(); this.onViewChange();
  }
  zoomBy(f, anchorPx = this.width / 2) {
    const anchor = this.start + anchorPx * this.spp;
    this.spp /= f; this._clampView();
    this.start = anchor - anchorPx * this.spp; this._clampView(); this.redraw(); this.onViewChange();
  }
  scrollBy(px) { this.start += px * this.spp; this._clampView(); this.redraw(); this.onViewChange(); }
  ensureVisible(sample, margin = 0.15) {
    const vis = this.visibleSamples;
    if (sample < this.start || sample > this.start + vis * (1 - margin)) {
      this.start = sample - vis * margin; this._clampView(); this.redraw();
    }
  }
  xToSample(x) { return Math.round(this.start + x * this.spp); }
  sampleToX(s) { return (s - this.start) / this.spp; }

  /* ---------- state setters ---------- */

  setCursor(s) { this.cursor = Math.max(0, Math.min(this.length, Math.round(s))); this.redraw(); }
  setSelection(sel) { this.sel = sel && sel.b - sel.a > 0 ? sel : null; this.redraw(); }
  setPlayhead(s) { this.playhead = s; if (s != null && this.follow) this.ensureVisible(s, 0.1); this.redraw(); }

  /* ---------- interaction ---------- */

  _bind() {
    const c = this.c;
    let drag = null;
    const px = (e) => { const r = c.getBoundingClientRect(); return e.clientX - r.left; };
    c.addEventListener('pointerdown', (e) => {
      if (this.live) return;
      c.setPointerCapture(e.pointerId);
      const x = px(e); const s = Math.max(0, Math.min(this.length, this.xToSample(x)));
      // grab a selection edge?
      if (this.sel) {
        const xa = this.sampleToX(this.sel.a), xb = this.sampleToX(this.sel.b);
        if (Math.abs(x - xa) < 7) { drag = { anchor: this.sel.b, moved: true, x0: x }; return; }
        if (Math.abs(x - xb) < 7) { drag = { anchor: this.sel.a, moved: true, x0: x }; return; }
      }
      if (e.shiftKey) {
        const anchor = this.sel ? (Math.abs(s - this.sel.a) < Math.abs(s - this.sel.b) ? this.sel.b : this.sel.a) : this.cursor;
        drag = { anchor, moved: true, x0: x }; this._dragTo(anchor, s); return;
      }
      drag = { anchor: s, moved: false, x0: x };
    });
    c.addEventListener('pointermove', (e) => {
      const x = px(e);
      if (!drag) {
        let cur = 'text';
        if (this.sel && (Math.abs(x - this.sampleToX(this.sel.a)) < 7 || Math.abs(x - this.sampleToX(this.sel.b)) < 7)) cur = 'ew-resize';
        c.style.cursor = this.live ? 'default' : cur; return;
      }
      if (!drag.moved && Math.abs(x - drag.x0) < 4) return;
      drag.moved = true;
      // auto-scroll at edges
      if (x > this.width - 20) this.scrollBy(12); else if (x < 20) this.scrollBy(-12);
      this._dragTo(drag.anchor, Math.max(0, Math.min(this.length, this.xToSample(x))));
    });
    const end = (e) => {
      if (!drag) return;
      if (!drag.moved) { this.setSelection(null); this.onSelect(null); this.setCursor(drag.anchor); this.onCursor(this.cursor); }
      drag = null;
    };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoomBy(Math.exp(-e.deltaY * 0.01), px(e));
      else this.scrollBy((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * 0.8);
    }, { passive: false });
    // overview: click/drag to move the visible window
    let odrag = false;
    const ojump = (e) => {
      const r = this.o.getBoundingClientRect(); const total = Math.max(this.length, 1);
      const s = ((e.clientX - r.left) / r.width) * total;
      this.start = s - this.visibleSamples / 2; this._clampView(); this.redraw(); this.onViewChange();
    };
    this.o.addEventListener('pointerdown', (e) => { odrag = true; this.o.setPointerCapture(e.pointerId); ojump(e); });
    this.o.addEventListener('pointermove', (e) => { if (odrag) ojump(e); });
    this.o.addEventListener('pointerup', () => (odrag = false));
  }
  _dragTo(anchor, s) {
    const a = Math.min(anchor, s), b = Math.max(anchor, s);
    this.sel = b > a ? { a, b } : null; this.cursor = a; this.redraw();
    this.onSelect(this.sel); this.onCursor(this.cursor);
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    for (const cv of [this.c, this.o]) {
      const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    }
    this._clampView(); this.redraw();
  }

  /* ---------- drawing ---------- */

  _colMinMax(s0, s1) {
    // min/max of samples [s0, s1) using raw data or peak buckets
    let mn = 0, mx = 0;
    if (s1 - s0 >= BUCKET * 2) {
      const b0 = Math.floor(s0 / BUCKET), b1 = Math.min(this.peaks.length / 2, Math.ceil(s1 / BUCKET));
      for (let b = b0; b < b1; b++) { const lo = this.peaks[2 * b], hi = this.peaks[2 * b + 1]; if (lo < mn) mn = lo; if (hi > mx) mx = hi; }
    } else {
      const a = Math.max(0, Math.floor(s0)), z = Math.min(this.raw.length, Math.ceil(s1));
      for (let i = a; i < z; i++) { const v = this.raw[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    }
    return [mn, mx];
  }

  _draw() {
    const g = this.g, dpr = window.devicePixelRatio || 1;
    const W = this.c.width / dpr, H = this.c.height / dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = this.col.bg; g.fillRect(0, 0, W, H);
    const top = this.ruler, wh = H - top, mid = top + wh / 2, amp = (wh / 2) * 0.92;

    // ruler
    this._drawRuler(g, W, top);

    // selection background
    if (this.sel) {
      const xa = Math.max(0, this.sampleToX(this.sel.a)), xb = Math.min(W, this.sampleToX(this.sel.b));
      if (xb > xa) { g.fillStyle = this.col.sel; g.fillRect(xa, top, xb - xa, wh); }
    }

    // centre line
    g.fillStyle = this.col.grid; g.fillRect(0, Math.round(mid), W, 1);

    // waveform
    const live = this.live;
    const dimFrom = live ? (live.mode === 'replace-end' ? live.pos : live.mode === 'replace-range' ? live.pos : null) : null;
    const dimTo = live ? (live.mode === 'replace-end' ? Infinity : live.mode === 'replace-range' ? live.rangeEnd : null) : null;
    if (this.spp >= 1) {
      for (let x = 0; x < W; x++) {
        let s0 = this.start + x * this.spp, s1 = s0 + this.spp;
        if (s0 >= this.length) break;
        const [mn, mx] = this._colMinMax(s0, Math.min(s1, this.length));
        const inSel = this.sel && s0 < this.sel.b && s1 > this.sel.a;
        const dim = dimFrom != null && s0 >= dimFrom && s0 < dimTo;
        g.fillStyle = dim ? this.col.dim : inSel ? this.col.waveSel : this.col.wave;
        const y0 = mid - mx * amp, y1 = mid - mn * amp;
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    } else {
      // zoomed in past one sample per pixel: draw the actual sample line
      g.strokeStyle = this.col.wave; g.lineWidth = 1.5; g.beginPath();
      const a = Math.max(0, Math.floor(this.start)), z = Math.min(this.length, Math.ceil(this.start + W * this.spp) + 1);
      for (let i = a; i < z; i++) { const x = this.sampleToX(i), y = mid - this.raw[i] * amp; if (i === a) g.moveTo(x, y); else g.lineTo(x, y); }
      g.stroke();
      if (1 / this.spp > 8) { g.fillStyle = this.col.wave; for (let i = a; i < z; i++) g.fillRect(this.sampleToX(i) - 1.5, mid - this.raw[i] * amp - 1.5, 3, 3); }
    }

    // live take being recorded
    if (live) {
      g.fillStyle = this.col.rec;
      const n = live.peaks.length / 2;
      for (let k = 0; k < n; k++) {
        const s0 = live.pos + k * BUCKET; const x = this.sampleToX(s0);
        if (x < -1) continue; if (x > W) break;
        const w = Math.max(1, BUCKET / this.spp);
        const y0 = mid - live.peaks[2 * k + 1] * amp, y1 = mid - live.peaks[2 * k] * amp;
        g.fillRect(x, y0, w, Math.max(1, y1 - y0));
      }
      const xs = this.sampleToX(live.pos);
      g.fillStyle = this.col.rec; g.fillRect(Math.round(xs), top, 2, wh);
    }

    // edit points
    g.fillStyle = this.col.edit;
    for (const p of this.editPoints) {
      const x = this.sampleToX(p); if (x < 0 || x > W) continue;
      g.fillRect(Math.round(x), top, 1, wh);
      g.beginPath(); g.moveTo(x - 4, top); g.lineTo(x + 4, top); g.lineTo(x, top + 5); g.fill();
    }

    // cursor
    const cx = this.sampleToX(this.cursor);
    if (cx >= -2 && cx <= W + 2) {
      g.fillStyle = this.col.cursor; g.fillRect(Math.round(cx) - 1, top, 2, wh);
      g.beginPath(); g.moveTo(cx - 6, top - 7); g.lineTo(cx + 6, top - 7); g.lineTo(cx, top); g.fill();
    }
    // playhead
    if (this.playhead != null) {
      const px = this.sampleToX(this.playhead);
      if (px >= 0 && px <= W) { g.fillStyle = this.col.play; g.fillRect(Math.round(px), top, 2, wh); }
    }

    // empty state hint
    if (!this.length && !live) {
      g.fillStyle = this.col.text; g.font = '15px Figtree, system-ui, sans-serif'; g.textAlign = 'center';
      const touch = matchMedia('(pointer: coarse)').matches;
      const lines = W < 560
        ? [touch ? 'Tap the red button to start recording,' : 'Press the red button or R to record,', 'or open an audio file.']
        : [touch ? 'Tap the red button to start recording, or open an audio file.' : 'Press the red button or R to start recording. Or drop an audio file here.'];
      lines.forEach((t, i) => g.fillText(t, W / 2, mid + 5 + (i - (lines.length - 1) / 2) * 22));
      g.textAlign = 'start';
    }
    this._drawOverview();
  }

  _drawRuler(g, W, top) {
    g.fillStyle = this.col.bg; g.fillRect(0, 0, W, top);
    g.fillStyle = this.col.grid; g.fillRect(0, top - 1, W, 1);
    const secPerPx = this.spp / this.sr;
    const steps = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = steps.find((s) => s / secPerPx >= 80) || 3600;
    const t0 = this.start / this.sr, t1 = t0 + W * secPerPx;
    g.font = '11px Figtree, system-ui, sans-serif'; g.fillStyle = this.col.text;
    const decimals = step < 0.01 ? 3 : step < 1 ? 2 : 0;
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const x = Math.round((t - t0) / secPerPx);
      g.fillRect(x, top - 8, 1, 7);
      let label;
      if (decimals) { const m = Math.floor(t / 60); label = `${m}:${(t % 60).toFixed(decimals).padStart(3 + decimals, '0')}`; }
      else label = fmtTime(t, false);
      g.fillText(label, x + 4, 13);
      // minor ticks
      for (let k = 1; k < 4; k++) { const mx = Math.round(x + (k * step) / 4 / secPerPx); g.fillRect(mx, top - 4, 1, 3); }
    }
  }

  _drawOverview() {
    const g = this.og, dpr = window.devicePixelRatio || 1;
    const W = this.o.width / dpr, H = this.o.height / dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = this.col.ov; g.fillRect(0, 0, W, H);
    const total = this.length; if (!total) return;
    const nb = this.peaks.length / 2, mid = H / 2;
    g.fillStyle = this.col.wave; g.globalAlpha = 0.7;
    for (let x = 0; x < W; x++) {
      const b0 = Math.floor((x / W) * nb), b1 = Math.max(b0 + 1, Math.floor(((x + 1) / W) * nb));
      let mn = 0, mx = 0;
      for (let b = b0; b < b1 && b < nb; b++) { if (this.peaks[2 * b] < mn) mn = this.peaks[2 * b]; if (this.peaks[2 * b + 1] > mx) mx = this.peaks[2 * b + 1]; }
      g.fillRect(x, mid - mx * mid * 0.9, 1, Math.max(1, (mx - mn) * mid * 0.9));
    }
    g.globalAlpha = 1;
    const vx = (this.start / total) * W, vw = Math.max(4, (this.visibleSamples / total) * W);
    g.strokeStyle = this.col.view; g.lineWidth = 1.5; g.strokeRect(vx + 0.75, 0.75, Math.min(vw, W - vx) - 1.5, H - 1.5);
    const cx = (this.cursor / total) * W; g.fillStyle = this.col.cursor; g.fillRect(cx, 0, 1.5, H);
  }
}
