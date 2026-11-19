// Streaming processing stages. Every stage:
//   process(chs: Float32Array[]) -> Float32Array[] of the same length
//   .latency  — fixed delay in samples between input and output
// Stages keep their state between calls, so feeding a file in blocks of any size
// gives the same result as feeding it at once (no seams at chunk boundaries).
import { fft, sqrtHann } from './fft.js';

export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-12));
const coef = (ms, fs) => Math.exp(-1 / Math.max(1, (ms / 1000) * fs));

/* ---------------- biquads ---------------- */

export function bq(type, fs, f0, q = Math.SQRT1_2, gainDb = 0) {
  const A = Math.pow(10, gainDb / 40), w0 = (2 * Math.PI * Math.min(f0, fs * 0.49)) / fs;
  const c = Math.cos(w0), s = Math.sin(w0), al = s / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'highpass') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'lowpass') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'bandpass') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'notch') { b0 = 1; b1 = -2 * c; b2 = 1; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'peaking') { b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
  else if (type === 'lowshelf' || type === 'highshelf') {
    const sq = 2 * Math.sqrt(A) * al, sg = type === 'lowshelf' ? 1 : -1;
    b0 = A * ((A + 1) - sg * (A - 1) * c + sq); b1 = sg * 2 * A * ((A - 1) - sg * (A + 1) * c); b2 = A * ((A + 1) - sg * (A - 1) * c - sq);
    a0 = (A + 1) + sg * (A - 1) * c + sq; a1 = -sg * 2 * ((A - 1) + sg * (A + 1) * c); a2 = (A + 1) + sg * (A - 1) * c - sq;
  } else throw new Error('filter ' + type);
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Multi-channel cascade of biquads, state kept between calls. */
export class FilterChain {
  constructor(coeffs, nCh) { this.c = coeffs; this.z = Array.from({ length: nCh }, () => new Float64Array(coeffs.length * 2)); this.latency = 0; }
  processChannel(x, ch, out = new Float32Array(x.length)) {
    const z = this.z[ch]; if (x !== out) out.set(x);
    for (let k = 0; k < this.c.length; k++) {
      const { b0, b1, b2, a1, a2 } = this.c[k]; let z1 = z[2 * k], z2 = z[2 * k + 1];
      for (let i = 0; i < out.length; i++) { const xi = out[i], yi = b0 * xi + z1; z1 = b1 * xi - a1 * yi + z2; z2 = b2 * xi - a2 * yi; out[i] = yi; }
      z[2 * k] = z1; z[2 * k + 1] = z2;
    }
    return out;
  }
  process(chs) { return chs.map((x, c) => this.processChannel(x, c)); }
}

/* ---------------- delay ---------------- */

export class Delay {
  constructor(nCh, d) { this.d = d; this.latency = d; this.buf = Array.from({ length: nCh }, () => new Float32Array(Math.max(1, d))); this.pos = 0; }
  process(chs) {
    if (!this.d) return chs.map((x) => Float32Array.from(x));
    const n = chs[0].length, d = this.d; const out = chs.map(() => new Float32Array(n)); let p = this.pos;
    for (let i = 0; i < n; i++) { for (let c = 0; c < chs.length; c++) { out[c][i] = this.buf[c][p]; this.buf[c][p] = chs[c][i]; } p = p + 1 === d ? 0 : p + 1; }
    this.pos = p; return out;
  }
}

/* ---------------- FIFO helper for frame-based stages ---------------- */

class Fifo {
  constructor(prefill = 0) { this.a = new Float32Array(Math.max(1024, prefill * 2)); this.n = prefill; }
  push(x) { if (this.n + x.length > this.a.length) { const b = new Float32Array(Math.max(this.a.length * 2, this.n + x.length)); b.set(this.a.subarray(0, this.n)); this.a = b; } this.a.set(x, this.n); this.n += x.length; }
  pop(m) { const o = this.a.slice(0, m); this.a.copyWithin(0, m, this.n); this.n -= m; return o; }
  peek(m) { return this.a.subarray(0, m); }
  drop(m) { this.a.copyWithin(0, m, this.n); this.n -= m; }
}

/* ---------------- 1. DC + hum ---------------- */

export class DCBlock {
  constructor(nCh, fs) { this.R = 1 - (2 * Math.PI * 5) / fs; this.s = Array.from({ length: nCh }, () => [0, 0]); this.latency = 0; }
  process(chs) {
    return chs.map((x, c) => { const s = this.s[c]; const y = new Float32Array(x.length); let x1 = s[0], y1 = s[1];
      for (let i = 0; i < x.length; i++) { const v = x[i] - x1 + this.R * y1; x1 = x[i]; y1 = v; y[i] = v; } s[0] = x1; s[1] = y1; return y; });
  }
}

export function humNotch(nCh, fs, f0, harmonics = 6) {
  const cs = []; for (let h = 1; h <= harmonics && f0 * h < 1200; h++) cs.push(bq('notch', fs, f0 * h, 18 + h * 4));
  return new FilterChain(cs, nCh);
}

/* ---------------- 2. Repair: declip, clicks, plosives (look-ahead) ---------------- */

export class Repair {
  constructor(nCh, fs, { declip = true, clipLevel = 0.99, clicks = true, plosives = true } = {}) {
    this.fs = fs; this.S = 2048; this.C = 256; this.opt = { declip, clipLevel, clicks, plosives };
    this.in = Array.from({ length: nCh }, () => { const f = new Fifo(0); f.push(new Float32Array(this.C)); return f; });
    this.out = Array.from({ length: nCh }, () => new Fifo(this.C + this.S));
    this.latency = this.C + this.S;
    this.lpz = Array.from({ length: nCh }, () => new Float64Array(4));
    this.plosLevel = new Float64Array(nCh).fill(-120);
    this.stats = { clipsFixed: 0, clicksFixed: 0, plosivesTamed: 0 };
  }
  process(chs) {
    const n = chs[0].length;
    chs.forEach((x, c) => this.in[c].push(x));
    const W = this.S + 2 * this.C;
    while (this.in[0].n >= W) {
      chs.forEach((_, c) => {
        const w = Float32Array.from(this.in[c].peek(W));
        if (this.opt.declip) this._declip(w);
        if (this.opt.clicks) this._clicks(w);
        let seg = w.slice(this.C, this.C + this.S);
        if (this.opt.plosives) seg = this._plosive(seg, c);
        this.out[c].push(seg); this.in[c].drop(this.S);
      });
    }
    return chs.map((_, c) => this.out[c].pop(n));
  }
  _declip(w) {
    const L = this.opt.clipLevel, maxRun = Math.round(0.004 * this.fs);
    for (let i = 2; i < w.length - 2; i++) {
      if (Math.abs(w[i]) < L) continue;
      let j = i; const sg = Math.sign(w[i]);
      while (j + 1 < w.length - 2 && Math.abs(w[j + 1]) >= L && Math.sign(w[j + 1]) === sg) j++;
      const run = j - i + 1;
      if (run >= 2 && run <= maxRun && i >= 2) {
        // cubic Hermite through the samples either side, using their slopes
        const p0 = w[i - 1], p1 = w[j + 1], m0 = (w[i - 1] - w[i - 2]) * (run + 1), m1 = (w[j + 2] - w[j + 1]) * (run + 1);
        for (let k = i; k <= j; k++) {
          const t = (k - i + 1) / (run + 1), t2 = t * t, t3 = t2 * t;
          const v = (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
          w[k] = sg > 0 ? Math.max(w[k], Math.min(v, 1.6)) : Math.min(w[k], Math.max(v, -1.6));
        }
        this.stats.clipsFixed++;
      }
      i = j;
    }
  }
  _clicks(w) {
    // A click is an isolated spike in the second difference. Voice pulses repeat every
    // pitch period, so a spike only counts if nothing comparable sits within ±12 ms.
    const e = new Float32Array(w.length);
    for (let i = 2; i < w.length; i++) e[i] = Math.abs(w[i] - 2 * w[i - 1] + w[i - 2]);
    const sorted = Float32Array.from(e).sort(); const med = sorted[Math.floor(sorted.length * 0.5)] + 1e-6;
    const R = Math.round(0.012 * this.fs), g = Math.round(0.0015 * this.fs);
    for (let i = this.C; i < this.C + this.S; i++) {
      if (e[i] < med * 30 || e[i] < 0.01) continue;
      let near = 0;
      for (let k = Math.max(2, i - R); k <= Math.min(w.length - 1, i + R); k++) if (Math.abs(k - i) > g && e[k] > near) near = e[k];
      if (e[i] < near * 6) continue;
      let j = i; while (j + 1 < w.length - 3 && e[j + 1] > e[i] * 0.2 && j - i < 48) j++;
      const a = Math.max(0, i - 3), b = Math.min(w.length - 1, j + 3); const va = w[a], vb = w[b];
      for (let k = a + 1; k < b; k++) w[k] = va + ((vb - va) * (k - a)) / (b - a);
      this.stats.clicksFixed++; i = j + 3;
    }
  }
  _plosive(seg, c) {
    // dynamic low-cut: attenuate sudden bursts below ~100 Hz (pops on P and B)
    const lp = new FilterChain([bq('lowpass', this.fs, 100, 0.7)], 1); lp.z[0] = this.lpz[c];
    const low = lp.processChannel(seg, 0);
    const F = Math.round(0.005 * this.fs); const out = Float32Array.from(seg);
    for (let s = 0; s < seg.length; s += F) {
      let el = 0, ea = 0; const e = Math.min(seg.length, s + F);
      for (let i = s; i < e; i++) { el += low[i] * low[i]; ea += seg[i] * seg[i]; }
      const ldb = 10 * Math.log10(el / (e - s) + 1e-20), rest = 10 * Math.log10(Math.max(ea - el, 1e-20) / (e - s));
      const jump = ldb - this.plosLevel[c];
      this.plosLevel[c] = Math.max(ldb, this.plosLevel[c] - 1.5);
      if (ldb > -35 && ldb - rest > 8 && jump > 10) {
        for (let i = s; i < e; i++) out[i] = seg[i] - 0.75 * low[i];
        this.stats.plosivesTamed++;
      }
    }
    return out;
  }
}

/* ---------------- 3. RNNoise denoise with residual ---------------- */

export class Denoise {
  /** amount 0..1. Returns { speech, residual }; residual = input (aligned) - speech. */
  constructor(Module, nCh, amount = 1) {
    this.M = Module; this.amount = amount; this.F = 480;
    this.st = Array.from({ length: nCh }, () => Module._rnnoise_create());
    this.ptr = Module._malloc(this.F * 4);
    this.in = Array.from({ length: nCh }, () => new Fifo(0));
    this.out = Array.from({ length: nCh }, () => new Fifo(this.F));
    this.dl = new Delay(nCh, 2 * this.F);
    this.latency = 2 * this.F; // 480 inside RNNoise + 480 frame buffering
  }
  process(chs) {
    const n = chs[0].length, M = this.M, F = this.F;
    chs.forEach((x, c) => this.in[c].push(x));
    while (this.in[0].n >= F) {
      for (let c = 0; c < chs.length; c++) {
        const fr = this.in[c].pop(F);
        let h = M.HEAPF32.subarray(this.ptr >> 2, (this.ptr >> 2) + F);
        for (let i = 0; i < F; i++) h[i] = fr[i] * 32768;
        M._rnnoise_process_frame(this.st[c], this.ptr, this.ptr);
        h = M.HEAPF32.subarray(this.ptr >> 2, (this.ptr >> 2) + F);
        const o = new Float32Array(F); for (let i = 0; i < F; i++) o[i] = h[i] / 32768;
        this.out[c].push(o);
      }
    }
    const den = chs.map((_, c) => this.out[c].pop(n));
    const dry = this.dl.process(chs);
    const a = this.amount;
    const speech = den.map((d, c) => { const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = a * d[i] + (1 - a) * dry[c][i]; return y; });
    const residual = speech.map((s, c) => { const r = new Float32Array(n); for (let i = 0; i < n; i++) r[i] = dry[c][i] - s[i]; return r; });
    return { speech, residual };
  }
  free() { this.st.forEach((s) => this.M._rnnoise_destroy(s)); this.M._free(this.ptr); }
}

/* ---------------- 4. Spectral: log-MMSE noise removal + late-reverb suppression + noise profile ---------------- */

function expint(x) { // exponential integral E1(x)
  if (x <= 0) return 30;
  if (x < 1) return -0.5772156649 - Math.log(x) + x - (x * x) / 4 + (x * x * x) / 18 - (x ** 4) / 96 + (x ** 5) / 600;
  return (Math.exp(-x) / x) * ((x * x + 2.334733 * x + 0.250621) / (x * x + 3.330657 * x + 1.681534));
}

export class Spectral {
  /**
   * opts: rt60 (s), echo (0..1.5 over-subtraction), echoFloorDb, noiseProfile (Float64Array power per bin | null),
   *       noise (0..1, learned profile weight), floorDb, mmse (0..1 strength of the log-MMSE estimator)
   */
  constructor(nCh, fs, opts) {
    this.N = 1024; this.H = 256; this.fs = fs; this.o = opts;
    this.win = sqrtHann(this.N);
    this.in = Array.from({ length: nCh }, () => { const f = new Fifo(0); f.push(new Float32Array(this.N - this.H)); return f; });
    this.acc = Array.from({ length: nCh }, () => new Float32Array(this.N));
    this.out = Array.from({ length: nCh }, () => new Fifo(this.H));
    this.latency = this.N;
    const K = this.N / 2 + 1; this.K = K;
    this.Nd = Math.max(2, Math.round((0.05 * fs) / this.H)); // ~50 ms early/late boundary
    this.hist = Array.from({ length: this.Nd + 1 }, () => new Float64Array(K)); this.hp = 0;
    this.Psm = new Float64Array(K); this.Gprev = new Float64Array(K).fill(1);
    const rt = Math.max(0.15, opts.rt60 || 0.4);
    // short rooms leave little late energy at 50 ms, so they need a stronger subtraction; long rooms gentler
    this.echoScale = rt < 0.6 ? 1.6 : rt > 1 ? 0.7 : 1;
    this.decay = Math.exp((-2 * (3 * Math.log(10)) / rt) * ((this.Nd * this.H) / fs));
    this.gminEcho = dbToGain(opts.echoFloorDb ?? -14); this.gminNoise = dbToGain(opts.floorDb ?? -18);
    this.re = new Float64Array(this.N); this.im = new Float64Array(this.N);
    this.removedEnergy = 0; this.totalEnergy = 0;
    this.mmse = opts.mmse || 0; this.Pn = null; this.frames = 0; this.Pprev = new Float64Array(K); this.Gm = new Float64Array(K).fill(1);
    this.rise = Math.pow(10, (3 * this.H) / fs / 10); // noise estimate may rise 3 dB/s
    this.riseFast = Math.pow(10, (40 * this.H) / fs / 10);
    this.gminMmse = dbToGain(-12 - 14 * this.mmse - (opts.noiseProfile ? 6 : 0));
    this.olaScale = (2 * this.H) / this.N; // sqrt-Hann analysis+synthesis at 75 % overlap sums to N/(2H)
  }
  process(chs) {
    const n = chs[0].length, N = this.N, H = this.H, K = this.K, nCh = chs.length;
    chs.forEach((x, c) => this.in[c].push(x));
    while (this.in[0].n >= N) {
      const specs = [];
      const P = new Float64Array(K);
      for (let c = 0; c < nCh; c++) {
        const fr = this.in[c].peek(N); const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = fr[i] * this.win[i];
        fft(re, im); specs.push([re, im]);
        for (let k = 0; k < K; k++) P[k] += (re[k] * re[k] + im[k] * im[k]) / nCh;
        this.in[c].drop(H);
      }
      // smoothed power, history ring for the late-reverb model
      for (let k = 0; k < K; k++) this.Psm[k] = 0.6 * this.Psm[k] + 0.4 * P[k];
      this.hist[this.hp].set(this.Psm);
      const old = this.hist[(this.hp + 1) % (this.Nd + 1)]; this.hp = (this.hp + 1) % (this.Nd + 1);
      // noise tracking: follows the minimum quickly, rises slowly (speech never pulls it up fast)
      this.frames++;
      // noise tracking: 20th-percentile tracker per bin in dB (rises 9 dB/s, falls 37 dB/s), bias-corrected
      let e = 0; for (let k = 0; k < K; k++) e += P[k];
      if (e > 1e-12) {
        this.live = (this.live || 0) + 1; const c = this.live < 190 ? 1.0 : 0.25;
        if (!this.PnDb) this.PnDb = Float64Array.from(P, (v) => 10 * Math.log10(v + 1e-20));
        else for (let k = 0; k < K; k++) { const d = 10 * Math.log10(P[k] + 1e-20); this.PnDb[k] += d > this.PnDb[k] ? 0.2 * c : -0.8 * c; }
      }
      if (!this.Pn) this.Pn = new Float64Array(K).fill(1e-14);
      if (this.PnDb) for (let k = 0; k < K; k++) this.Pn[k] = 4.48 * Math.pow(10, this.PnDb[k] / 10);
      const G = new Float64Array(K); const echo = this.o.echo || 0, nAmt = this.o.noise || 0, prof = this.o.noiseProfile;
      for (let k = 0; k < K; k++) {
        let g = 1; const p = Math.max(this.Psm[k], 1e-20);
        if (this.mmse > 0) {
          // log-MMSE spectral amplitude estimator with decision-directed a-priori SNR
          const pn = Math.max(1e-14, 1.25 * Math.max(this.Pn[k], prof ? prof[k] * (1 + 2 * nAmt) : 0));
          const gam = P[k] / pn; const xi = Math.max(0.98 * (this.Gm[k] * this.Gm[k] * this.Pprev[k]) / pn + 0.02 * Math.max(gam - 1, 0), 0.003);
          const v = (xi / (1 + xi)) * gam; let gm = (xi / (1 + xi)) * Math.exp(0.5 * expint(Math.max(v, 1e-6)));
          gm = Math.min(1, Math.max(gm, this.gminMmse)); this.Gm[k] = gm; this.Pprev[k] = P[k];
          g *= 1 - this.mmse + this.mmse * gm;
        }
        if (echo > 0) g *= Math.max(1 - (echo * this.echoScale * this.decay * old[k]) / p, this.gminEcho);
        if (prof && nAmt > 0 && !this.mmse) g *= Math.max(1 - (nAmt * 1.5 * prof[k]) / p, this.gminNoise);
        G[k] = g;
      }
      // smooth across frequency and time (fast attack, slower release) to avoid musical noise
      const Gs = new Float64Array(K);
      for (let k = 0; k < K; k++) { const a = G[Math.max(0, k - 1)], b = G[k], d = G[Math.min(K - 1, k + 1)]; Gs[k] = 0.25 * a + 0.5 * b + 0.25 * d; }
      for (let k = 0; k < K; k++) { const prev = this.Gprev[k]; Gs[k] = Gs[k] < prev ? 0.5 * prev + 0.5 * Gs[k] : 0.3 * prev + 0.7 * Gs[k]; this.Gprev[k] = Gs[k]; }
      for (let c = 0; c < nCh; c++) {
        const [re, im] = specs[c];
        for (let k = 0; k < K; k++) {
          const e = re[k] * re[k] + im[k] * im[k]; this.totalEnergy += e; this.removedEnergy += e * (1 - Gs[k] * Gs[k]);
          re[k] *= Gs[k]; im[k] *= Gs[k]; if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
        }
        fft(re, im, true);
        const acc = this.acc[c];
        for (let i = 0; i < N; i++) acc[i] += re[i] * this.win[i] * this.olaScale;
        this.out[c].push(acc.slice(0, H)); acc.copyWithin(0, H); acc.fill(0, N - H);
      }
    }
    return chs.map((_, c) => this.out[c].pop(n));
  }
}

/* ---------------- 5. Tone ---------------- */

export function toneEQ(nCh, fs, { hp = 80, warmthDb = 0, mudDb = 0, presenceDb = 0, airDb = 0 }) {
  const cs = [];
  if (hp > 0) { cs.push(bq('highpass', fs, hp, 0.5412)); cs.push(bq('highpass', fs, hp, 1.3066)); }
  if (warmthDb) cs.push(bq('lowshelf', fs, 160, 0.7, warmthDb));
  if (mudDb) cs.push(bq('peaking', fs, 320, 1.0, mudDb));
  if (presenceDb) cs.push(bq('peaking', fs, 4000, 0.9, presenceDb));
  if (airDb && fs > 24000) cs.push(bq('highshelf', fs, 11000, 0.7, airDb));
  return new FilterChain(cs, nCh);
}

/* ---------------- 6. De-esser (linked) ---------------- */

export class DeEsser {
  constructor(nCh, fs, { amount = 0.5, freq = 6500, thresholdDb = -8 } = {}) {
    this.a = amount; this.thr = thresholdDb; this.bp = new FilterChain([bq('bandpass', fs, freq, 1.4)], nCh);
    this.aA = coef(1, fs); this.aR = coef(60, fs); this.aE = coef(5, fs); this.eb = 0; this.ef = 0; this.cut = 0; this.latency = 0;
  }
  process(chs) {
    if (this.a <= 0) return chs;
    const n = chs[0].length, nc = chs.length; const bps = chs.map((x, c) => this.bp.processChannel(x, c));
    const out = chs.map((x) => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      let sb = 0, sf = 0; for (let c = 0; c < nc; c++) { sb += bps[c][i] * bps[c][i]; sf += chs[c][i] * chs[c][i]; }
      this.eb = this.aE * this.eb + (1 - this.aE) * sb / nc; this.ef = this.aE * this.ef + (1 - this.aE) * sf / nc;
      const rel = 10 * Math.log10((this.eb + 1e-20) / (this.ef + 1e-20)), abs = 10 * Math.log10(this.eb + 1e-20);
      const t = rel > this.thr && abs > -60 ? Math.min(1, (rel - this.thr) / 6) * this.a : 0;
      this.cut = t > this.cut ? this.aA * this.cut + (1 - this.aA) * t : this.aR * this.cut + (1 - this.aR) * t;
      for (let c = 0; c < nc; c++) out[c][i] = chs[c][i] - this.cut * bps[c][i];
    }
    return out;
  }
}

/* ---------------- 7. Leveler (phrase gain rider, look-ahead) + compressor ---------------- */

export class Leveler {
  /** refDb: target speech RMS (dBFS); amount 0..1; maxDb: max boost/cut */
  constructor(nCh, fs, { refDb = -26, amount = 1, maxDb = 9 } = {}) {
    this.fs = fs; this.ref = refDb; this.amount = amount; this.max = maxDb;
    this.look = Math.round(0.2 * fs); this.latency = this.look; this.dl = new Delay(nCh, this.look);
    this.win = Math.round(0.4 * fs); this.ring = new Float64Array(this.win); this.rp = 0; this.sum = 0;
    this.det = new FilterChain([bq('highpass', fs, 100, 0.7)], nCh);
    this.floor = -70; this.g = 0; this.target = 0; this.step = Math.round(0.01 * fs); this.cnt = 0;
    this.smooth = 1 - coef(350, fs);
  }
  process(chs) {
    const n = chs[0].length, nc = chs.length; const d = chs.map((x, c) => this.det.processChannel(x, c));
    const del = this.dl.process(chs); const out = del.map(() => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      let s = 0; for (let c = 0; c < nc; c++) s += d[c][i] * d[c][i]; s /= nc;
      this.sum += s - this.ring[this.rp]; this.ring[this.rp] = s; this.rp = (this.rp + 1) % this.win;
      if (++this.cnt >= this.step) {
        this.cnt = 0; const lvl = 10 * Math.log10(Math.max(this.sum, 0) / this.win + 1e-20);
        this.floor = lvl < this.floor ? lvl : this.floor + 0.005; // min-statistics noise floor
        if (lvl > this.floor + 12 && lvl > -60) this.target = Math.max(-this.max, Math.min(this.max, this.ref - lvl)) * this.amount;
      }
      this.g += (this.target - this.g) * this.smooth;
      const gl = dbToGain(this.g); for (let c = 0; c < nc; c++) out[c][i] = del[c][i] * gl;
    }
    return out;
  }
}

export class Compressor {
  constructor(nCh, fs, { thresholdDb = -22, ratio = 2.5, kneeDb = 6, attackMs = 15, releaseMs = 100 } = {}) {
    Object.assign(this, { thr: thresholdDb, ratio, knee: kneeDb }); this.aA = coef(attackMs, fs); this.aR = coef(releaseMs, fs);
    this.aD = coef(5, fs); this.det = 0; this.env = 0; this.latency = 0;
  }
  process(chs) {
    if (this.ratio <= 1) return chs;
    const n = chs[0].length, nc = chs.length; const out = chs.map(() => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      let s = 0; for (let c = 0; c < nc; c++) s = Math.max(s, chs[c][i] * chs[c][i]);
      this.det = this.aD * this.det + (1 - this.aD) * s;
      const over = 10 * Math.log10(this.det + 1e-20) - this.thr;
      let gr = 0;
      if (2 * over >= -this.knee) gr = 2 * Math.abs(over) <= this.knee ? ((1 / this.ratio - 1) * (over + this.knee / 2) ** 2) / (2 * this.knee) : (1 / this.ratio - 1) * over;
      this.env = gr < this.env ? this.aA * this.env + (1 - this.aA) * gr : this.aR * this.env + (1 - this.aR) * gr;
      const g = dbToGain(this.env); for (let c = 0; c < nc; c++) out[c][i] = chs[c][i] * g;
    }
    return out;
  }
}

/* ---------------- 8. Gap expander (look-ahead + hold) ---------------- */

export class Expander {
  constructor(nCh, fs, { thresholdDb = -55, rangeDb = 10, ratio = 2, holdMs = 150, lookMs = 10, attackMs = 3, releaseMs = 120 } = {}) {
    Object.assign(this, { thr: thresholdDb, range: rangeDb, ratio });
    this.look = Math.round((lookMs / 1000) * fs); this.dl = new Delay(nCh, this.look); this.latency = this.look;
    this.hold = Math.round((holdMs / 1000) * fs); this.h = 0; this.aD = coef(8, fs); this.aA = coef(attackMs, fs); this.aR = coef(releaseMs, fs);
    this.det = 0; this.g = 0;
  }
  process(chs) {
    if (this.range <= 0) return this.dl.process(chs);
    const n = chs[0].length, nc = chs.length; const del = this.dl.process(chs); const out = del.map(() => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      let s = 0; for (let c = 0; c < nc; c++) s += chs[c][i] * chs[c][i]; // detector sees the future (undelayed) signal
      this.det = this.aD * this.det + (1 - this.aD) * s / nc;
      const lvl = 10 * Math.log10(this.det + 1e-20);
      const t = lvl < this.thr ? Math.max(-this.range, (lvl - this.thr) * (this.ratio - 1)) : 0;
      if (t >= this.g) { this.g = this.aA * this.g + (1 - this.aA) * t; this.h = this.hold; }
      else if (this.h > 0) this.h--;
      else this.g = this.aR * this.g + (1 - this.aR) * t;
      const gl = dbToGain(this.g); for (let c = 0; c < nc; c++) out[c][i] = del[c][i] * gl;
    }
    return out;
  }
}

/* ---------------- 10. True-peak limiter (4x oversampled detector, look-ahead) ---------------- */

const OS = 4, TAPS = 12;
const PHASES = (() => {
  const ph = [];
  for (let p = 1; p < OS; p++) {
    const frac = p / OS, k = new Float64Array(2 * TAPS); let sum = 0;
    for (let j = -TAPS + 1; j <= TAPS; j++) { const t = j - frac; const s = Math.sin(Math.PI * t) / (Math.PI * t); const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / (TAPS + 0.5)); k[j + TAPS - 1] = s * w; sum += s * w; }
    for (let j = 0; j < k.length; j++) k[j] /= sum; ph.push(k);
  }
  return ph;
})();

/** Peak of a buffer including inter-sample peaks (4x oversampled), as linear gain. */
export function truePeak(x) {
  let pk = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]); if (a > pk) pk = a;
    if (i >= TAPS - 1 && i + TAPS < x.length) for (const k of PHASES) { let s = 0; for (let j = 0; j < k.length; j++) s += x[i - TAPS + 1 + j] * k[j]; const b = Math.abs(s); if (b > pk) pk = b; }
  }
  return pk;
}

export class TruePeakLimiter {
  constructor(nCh, fs, { ceilingDb = -1, lookMs = 2.5, releaseMs = 60 } = {}) {
    this.ceil = dbToGain(ceilingDb) * 0.995; this.h = Math.max(2, Math.round((lookMs / 1000) * fs)); const w = 2 * this.h + 1; this.w = w;
    this.latency = TAPS + 2 * this.h;
    this.hist = Array.from({ length: nCh }, () => new Float32Array(2 * TAPS)); // past samples for interpolation
    this.dl = new Delay(nCh, this.latency);
    this.minQ = new Int32Array(1 << 16); this.minV = new Float64Array(1 << 16); this.qh = 0; this.qt = 0; this.t = 0;
    this.avgRing = new Float64Array(w).fill(1); this.ap = 0; this.asum = w; this.g = 1; this.rel = 1 - coef(releaseMs, fs);
    this.grMax = 0;
  }
  process(chs) {
    const n = chs[0].length, nc = chs.length, mask = this.minQ.length - 1;
    const del = this.dl.process(chs); const out = del.map(() => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      // peak (incl. inter-sample) of the sample entering, evaluated TAPS samples late using history
      let pk = 0;
      for (let c = 0; c < nc; c++) {
        const hst = this.hist[c]; hst.copyWithin(0, 1); hst[hst.length - 1] = chs[c][i];
        const a = Math.abs(hst[TAPS - 1]); if (a > pk) pk = a;
        for (const k of PHASES) { let s = 0; for (let j = 0; j < k.length; j++) s += hst[j] * k[j]; const b = Math.abs(s); if (b > pk) pk = b; }
      }
      const req = pk > this.ceil ? this.ceil / pk : 1;
      // sliding min over last w values (monotonic deque)
      const t = this.t++;
      while (this.qt > this.qh && this.minV[(this.qt - 1) & mask] >= req) this.qt--;
      this.minQ[this.qt & mask] = t; this.minV[this.qt & mask] = req; this.qt++;
      while (this.minQ[this.qh & mask] <= t - this.w) this.qh++;
      const m = this.minV[this.qh & mask];
      this.asum += m - this.avgRing[this.ap]; this.avgRing[this.ap] = m; this.ap = (this.ap + 1) % this.w;
      const gs = Math.min(this.asum / this.w, 1);
      this.g = gs < this.g ? gs : this.g + (gs - this.g) * this.rel;
      if (1 - this.g > this.grMax) this.grMax = 1 - this.g;
      for (let c = 0; c < nc; c++) out[c][i] = del[c][i] * this.g;
    }
    return out;
  }
}
