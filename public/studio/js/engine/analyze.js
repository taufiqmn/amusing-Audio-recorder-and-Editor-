// Streaming measurements: loudness (BS.1770-4), analysis for Auto mode, naturalness guard.
import { fft, hann, sqrtHann } from './fft.js';
import { FilterChain, truePeak } from './stages.js';

/* ---------------- K-weighted loudness with exact blending ---------------- */

function kCoeffs(fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196, K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416); let a0 = 1 + K / Q + K * K;
  const pre = { b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan((Math.PI * f0) / fs); a0 = 1 + K / Q + K * K;
  return [pre, { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 }];
}

/**
 * Feeds K-weighted signals A (and optionally B) and stores per-100 ms energies of A², B², A·B.
 * Loudness of any blend a·A + b·B is then exact: energies combine linearly.
 */
export class BlendMeter {
  constructor(nCh, fs) {
    this.fs = fs; this.hop = Math.round(0.1 * fs); this.kA = new FilterChain(kCoeffs(fs), nCh); this.kB = new FilterChain(kCoeffs(fs), nCh);
    this.EA = []; this.EB = []; this.EAB = []; this.a = 0; this.b = 0; this.ab = 0; this.cnt = 0;
  }
  process(A, B = null) {
    const ka = A.map((x, c) => this.kA.processChannel(x, c)), kb = B ? B.map((x, c) => this.kB.processChannel(x, c)) : null;
    const n = A[0].length;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ka.length; c++) { const x = ka[c][i]; this.a += x * x; if (kb) { const y = kb[c][i]; this.b += y * y; this.ab += x * y; } }
      if (++this.cnt === this.hop) { this.EA.push(this.a); this.EB.push(this.b); this.EAB.push(this.ab); this.a = this.b = this.ab = 0; this.cnt = 0; }
    }
  }
  loudness(wa = 1, wb = 0) { return gatedLoudness((h) => wa * wa * this.EA[h] + wb * wb * this.EB[h] + 2 * wa * wb * this.EAB[h], this.EA.length, this.hop); }
}

export function gatedLoudness(E, nHops, hop) {
  const L = (z) => -0.691 + 10 * Math.log10(z);
  const zs = [];
  for (let h = 0; h + 4 <= nHops; h++) zs.push((E(h) + E(h + 1) + E(h + 2) + E(h + 3)) / (4 * hop));
  if (!zs.length) { let s = 0; for (let h = 0; h < nHops; h++) s += E(h); return nHops ? (s > 0 ? L(s / (nHops * hop)) : -Infinity) : -Infinity; }
  const abs = zs.filter((z) => z > 0 && L(z) > -70); if (!abs.length) return -Infinity;
  const rg = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const rel = abs.filter((z) => L(z) > rg); if (!rel.length) return -Infinity;
  return L(rel.reduce((a, b) => a + b, 0) / rel.length);
}

/** One-shot loudness of channel arrays (for tests and short buffers). */
export function loudnessOf(chs, fs) { const m = new BlendMeter(chs.length, fs); m.process(chs.map((c) => Float32Array.from(c))); return m.loudness(); }

/* ---------------- Analysis (Auto mode) ---------------- */

export class Analyzer {
  constructor(nCh, fs) {
    this.nCh = nCh; this.fs = fs; this.meter = new BlendMeter(nCh, fs);
    this.f50 = Math.round(0.05 * fs); this.acc50 = 0; this.c50 = 0; this.frames = [];
    this.f10 = Math.round(0.01 * fs); this.acc10 = 0; this.c10 = 0; this.env = [];
    this.N = 4096; this.win = hann(this.N); this.buf = new Float32Array(this.N); this.bn = 0; this.skip = 0;
    this.buckets = new Map(); // level bucket -> summed spectrum
    this.HN = 16384; this.hwin = hann(this.HN); this.hbuf = new Float32Array(this.HN); this.hn = 0; this.humSpec = new Float64Array(1500); this.humCount = 0;
    this.peak = 0; this.tp = 0; this.clips = 0; this.prevAbs = -1; this.run = 0; this.clipLevel = 0; this.dc = new Float64Array(nCh); this.n = 0;
    this.sLL = 0; this.sRR = 0; this.sLR = 0; this.sD = 0;
  }
  process(chs) {
    const n = chs[0].length, nc = chs.length; this.meter.process(chs);
    for (const x of chs) { const t = truePeak(x); if (t > this.tp) this.tp = t; }
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let c = 0; c < nc; c++) { const v = chs[c][i]; m += v; this.dc[c] += v; const a = Math.abs(v); if (a > this.peak) this.peak = a;
        // clipping leaves runs of identical sample values at the clip level
        if (c === 0) { if (a > 0.05 && a === this.prevAbs) { this.run++; if (this.run === 2) { this.clips++; this.clipLevel = Math.max(this.clipLevel, a); } } else this.run = 0; this.prevAbs = a; } }
      if (nc === 2) { const l = chs[0][i], r = chs[1][i]; this.sLL += l * l; this.sRR += r * r; this.sLR += l * r; this.sD += (l - r) * (l - r); }
      m /= nc;
      this.acc50 += m * m; if (++this.c50 === this.f50) { this.frames.push(10 * Math.log10(this.acc50 / this.f50 + 1e-20)); this.acc50 = 0; this.c50 = 0; }
      this.acc10 += m * m; if (++this.c10 === this.f10) { this.env.push(10 * Math.log10(this.acc10 / this.f10 + 1e-20)); this.acc10 = 0; this.c10 = 0; }
      this.buf[this.bn++] = m;
      if (this.bn === this.N) { this._spec(); this.bn = 0; }
      this.hbuf[this.hn++] = m;
      if (this.hn === this.HN) { this._hum(); this.hn = 0; }
    }
    this.n += n;
  }
  _spec() {
    let e = 0; for (let i = 0; i < this.N; i++) e += this.buf[i] * this.buf[i];
    const lvl = 10 * Math.log10(e / this.N + 1e-20); const b = Math.max(-120, Math.round(lvl / 2) * 2);
    const re = new Float64Array(this.N), im = new Float64Array(this.N);
    for (let i = 0; i < this.N; i++) re[i] = this.buf[i] * this.win[i];
    fft(re, im);
    let s = this.buckets.get(b); if (!s) { s = { n: 0, p: new Float64Array(this.N / 2 + 1) }; this.buckets.set(b, s); }
    for (let k = 0; k <= this.N / 2; k++) s.p[k] += re[k] * re[k] + im[k] * im[k];
    s.n++;
  }
  _hum() {
    const re = new Float64Array(this.HN), im = new Float64Array(this.HN);
    for (let i = 0; i < this.HN; i++) re[i] = this.hbuf[i] * this.hwin[i];
    fft(re, im);
    for (let k = 0; k < this.humSpec.length; k++) this.humSpec[k] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    this.humCount++;
  }
  result() {
    const fs = this.fs, sorted = Float32Array.from(this.frames).sort();
    const pct = (p) => (sorted.length ? sorted[Math.floor(p * (sorted.length - 1))] : -120);
    const floor = pct(0.1), loud90 = pct(0.9);
    const speechFrames = this.frames.filter((v) => v > floor + 15);
    // speech level: energy average of frames well above the floor; with steady loud noise (hum, fan)
    // few frames clear that bar, so fall back to the 90th-percentile level
    const speechDb = speechFrames.length >= 0.05 * this.frames.length ? 10 * Math.log10(speechFrames.reduce((a, v) => a + Math.pow(10, v / 10), 0) / speechFrames.length) : loud90;
    // spectra of loud vs quiet frames
    const sp = new Float64Array(this.N / 2 + 1), qu = new Float64Array(this.N / 2 + 1); let ns = 0, nq = 0;
    for (const [b, s] of this.buckets) {
      if (b >= floor + 12) { for (let k = 0; k < sp.length; k++) sp[k] += s.p[k]; ns += s.n; }
      else if (b <= floor + 4) { for (let k = 0; k < qu.length; k++) qu[k] += s.p[k]; nq += s.n; }
    }
    const binHz = fs / this.N; let bandwidth = 0;
    if (ns) {
      // highest frequency where speech frames carry real content above the quiet frames
      const smooth = (a, k) => { let s = 0, c = 0; for (let j = Math.max(1, k - 4); j <= Math.min(a.length - 1, k + 4); j++) { s += a[j]; c++; } return s / c; };
      const maxSp = Math.max(...Array.from(sp).slice(5, Math.floor(4000 / binHz)).map((v) => v / ns));
      for (let k = sp.length - 5; k > 5; k--) {
        const s = smooth(sp, k) / ns, q = nq ? smooth(qu, k) / nq : 0;
        if (s > q * 4 && s > maxSp * 1e-7) { bandwidth = k * binHz; break; }
      }
    }
    const db = (k) => 10 * Math.log10(sp[k] / Math.max(ns, 1) + 1e-30);
    const tilt = ns ? (db(Math.round(4000 / binHz)) - db(Math.round(500 / binHz))) / 3 : 0; // dB per octave
    // hum: strong narrow peaks at 50 or 60 Hz and harmonics
    let hum = 0, humDb = 0;
    if (this.humCount) {
      const hb = fs / this.HN; const H = this.humSpec;
      const score = (f0) => { let s = 0, c = 0; for (let h = 1; h <= 4; h++) { const k = Math.round((f0 * h) / hb); if (k + 8 >= H.length) break; let pk = 0; for (let j = k - 1; j <= k + 1; j++) pk = Math.max(pk, H[j]); const nb = (H[k - 6] + H[k - 5] + H[k + 5] + H[k + 6]) / 4; s += 20 * Math.log10((pk + 1e-12) / (nb + 1e-12)); c++; } return s / c; };
      const s50 = score(50), s60 = score(60);
      if (Math.max(s50, s60) > 9) { hum = s50 > s60 ? 50 : 60; humDb = Math.max(s50, s60); }
    }
    const dualMono = this.nCh === 2 && this.sD <= 1e-6 * (this.sLL + this.sRR + 1e-20);
    const balanceDb = this.nCh === 2 ? 10 * Math.log10((this.sLL + 1e-20) / (this.sRR + 1e-20)) : 0;
    return {
      duration: this.n / fs, loudness: this.meter.loudness(), truePeakDb: 20 * Math.log10(this.tp + 1e-12), peakDb: 20 * Math.log10(this.peak + 1e-12),
      noiseFloorDb: floor, speechDb, loud90Db: loud90, snrDb: speechDb - floor, speechFraction: speechFrames.length / Math.max(1, this.frames.length),
      bandwidthHz: Math.round(bandwidth), tiltDbPerOct: tilt, clipping: this.clips, clipLevel: this.clipLevel, dc: Array.from(this.dc, (v) => v / Math.max(1, this.n)),
      humHz: hum, humDb, rt60: estimateRT60(this.env, floor), dualMono, balanceDb, channels: this.nCh,
    };
  }
}

/** Blind reverberation-time estimate from the decay slopes of a 10 ms energy envelope. */
export function estimateRT60(env, floorDb) {
  const slopes = [];
  for (let i = 5; i < env.length - 5; i++) {
    const v = env[i]; if (v < floorDb + 25) continue;
    let isMax = true; for (let j = i - 5; j <= i + 5; j++) if (env[j] > v) { isMax = false; break; }
    if (!isMax) continue;
    // follow the decay (allow 1 dB ripples) for up to 1.5 s
    let j = i, low = v; while (j + 1 < env.length && j - i < 150 && env[j + 1] < low + 1) { j++; low = Math.min(low, env[j]); }
    if (v - low < 20) continue;
    // T20-style fit between -5 and -25 dB below the peak
    const xs = [], ys = [];
    for (let k = i; k <= j; k++) { const d = v - env[k]; if (d >= 5 && d <= 25) { xs.push((k - i) * 0.01); ys.push(env[k]); } }
    if (xs.length < 3) continue;
    const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    let num = 0, den = 0; for (let k = 0; k < xs.length; k++) { num += (xs[k] - mx) * (ys[k] - my); den += (xs[k] - mx) ** 2; }
    const slope = num / (den || 1); if (slope < -1) slopes.push(-60 / slope);
    i = j;
  }
  if (!slopes.length) return 0.2;
  slopes.sort((a, b) => a - b); return slopes[Math.floor(slopes.length * 0.5)];
}

/* ---------------- Naturalness guard ---------------- */

/**
 * Compares the (aligned) original and processed signals in the voice band.
 * corr: mean Pearson correlation of voice-band magnitude spectra on speech frames (1 = same voice).
 * musical: isolated short tonal blips per second in pauses (musical noise).
 */
export class Naturalness {
  constructor(fs) {
    this.fs = fs; this.N = 1024; this.win = hann(this.N); this.a = new Float32Array(this.N); this.b = new Float32Array(this.N); this.n = 0;
    this.lo = Math.round((100 * this.N) / fs); this.hi = Math.round((4000 * this.N) / fs); this.mlo = Math.round((300 * this.N) / fs); this.mhi = Math.round((8000 * this.N) / fs);
    this.floor = 0; this.floorInit = false; this.corrSum = 0; this.corrN = 0; this.blips = 0; this.quietFrames = 0; this.hist = [];
  }
  process(ref, out) {
    const r = mono(ref), o = mono(out);
    for (let i = 0; i < r.length; i++) { this.a[this.n] = r[i]; this.b[this.n] = o[i]; if (++this.n === this.N) { this._frame(); this.n = 0; } }
  }
  _mag(x) { const re = new Float64Array(this.N), im = new Float64Array(this.N); for (let i = 0; i < this.N; i++) re[i] = x[i] * this.win[i]; fft(re, im); const m = new Float64Array(this.N / 2 + 1); for (let k = 0; k <= this.N / 2; k++) m[k] = Math.hypot(re[k], im[k]); return m; }
  _frame() {
    let e = 0; for (let i = 0; i < this.N; i++) e += this.a[i] * this.a[i];
    const lvl = 10 * Math.log10(e / this.N + 1e-20);
    if (!this.floorInit) { this.floor = lvl; this.floorInit = true; }
    this.floor = lvl < this.floor ? lvl : this.floor + 0.02;
    const A = this._mag(this.a), B = this._mag(this.b);
    if (lvl > this.floor + 15 && lvl > -60) {
      let ma = 0, mb = 0; const K = this.hi - this.lo; for (let k = this.lo; k < this.hi; k++) { ma += A[k]; mb += B[k]; } ma /= K; mb /= K;
      let num = 0, da = 0, db = 0; for (let k = this.lo; k < this.hi; k++) { const x = A[k] - ma, y = B[k] - mb; num += x * y; da += x * x; db += y * y; }
      if (da > 0 && db > 0) { this.corrSum += num / Math.sqrt(da * db); this.corrN++; }
      this.hist = [];
    } else {
      this.quietFrames++; this.hist.push(B); if (this.hist.length > 3) this.hist.shift();
      if (this.hist.length === 3) {
        const [p, c, q] = this.hist; const med = Float64Array.from(c.subarray(this.mlo, this.mhi)).sort()[Math.floor((this.mhi - this.mlo) / 2)];
        for (let k = this.mlo + 1; k < this.mhi - 1; k++) {
          const v = c[k];
          if (v > med * 8 && v > 4 * c[k - 1] && v > 4 * c[k + 1] && v > 4 * p[k] && v > 4 * q[k] && v > 1e-4) this.blips++;
        }
      }
    }
  }
  result() {
    const quietSec = (this.quietFrames * this.N) / this.fs;
    return { corr: this.corrN ? this.corrSum / this.corrN : 1, musical: quietSec > 0.5 ? this.blips / quietSec : 0, speechFrames: this.corrN };
  }
}

export function mono(chs) {
  if (chs.length === 1) return chs[0];
  const n = chs[0].length, m = new Float32Array(n); for (const c of chs) for (let i = 0; i < n; i++) m[i] += c[i] / chs.length; return m;
}

/** Offline: voice-band correlation + musical noise between two whole buffers (used by tests). */
export function naturalness(ref, out, fs) { const nm = new Naturalness(fs); nm.process([ref], [out]); return nm.result(); }

/** Spectrogram data (dB) for display: frames x bins, downsampled. */
export function spectrogram(x, fs, { cols = 600, rows = 160, N = 1024 } = {}) {
  const win = sqrtHann(N), hop = Math.max(1, Math.floor((x.length - N) / cols)); const out = new Float32Array(cols * rows);
  const re = new Float64Array(N), im = new Float64Array(N); const maxBin = Math.floor((Math.min(fs / 2, 16000) * N) / fs);
  for (let c = 0; c < cols; c++) {
    const s = c * hop; re.fill(0); im.fill(0); for (let i = 0; i < N && s + i < x.length; i++) re[i] = x[s + i] * win[i];
    fft(re, im);
    for (let r = 0; r < rows; r++) {
      const k0 = Math.floor(Math.pow(r / rows, 1.6) * maxBin), k1 = Math.max(k0 + 1, Math.floor(Math.pow((r + 1) / rows, 1.6) * maxBin)); let p = 0;
      for (let k = k0; k < k1; k++) p = Math.max(p, re[k] * re[k] + im[k] * im[k]);
      out[c * rows + r] = 10 * Math.log10(p + 1e-20);
    }
  }
  return { data: out, cols, rows };
}
