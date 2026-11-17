// Takeflow DSP library — pure JavaScript, no DOM. Runs in workers and in Node tests.
// All signals are mono Float32Array in the range [-1, 1].

export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-12));

/* ------------------------------------------------------------------ */
/* Biquad filters (RBJ Audio EQ Cookbook), transposed direct form II   */
/* ------------------------------------------------------------------ */

export function biquadCoeffs(type, fs, f0, q = Math.SQRT1_2, gainDb = 0) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * Math.min(f0, fs * 0.49)) / fs;
  const cos = Math.cos(w0), sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'highpass':
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'lowpass':
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'bandpass': // constant 0 dB peak gain
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cos + s);
      b1 = 2 * A * ((A - 1) - (A + 1) * cos);
      b2 = A * ((A + 1) - (A - 1) * cos - s);
      a0 = (A + 1) + (A - 1) * cos + s;
      a1 = -2 * ((A - 1) + (A + 1) * cos);
      a2 = (A + 1) + (A - 1) * cos - s; break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cos + s);
      b1 = -2 * A * ((A - 1) + (A + 1) * cos);
      b2 = A * ((A + 1) + (A - 1) * cos - s);
      a0 = (A + 1) - (A - 1) * cos + s;
      a1 = 2 * ((A - 1) - (A + 1) * cos);
      a2 = (A + 1) - (A - 1) * cos - s; break;
    }
    default: throw new Error('Unknown filter type ' + type);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Filter `x` with coefficient set `c`. Returns a new array unless `out` is given. */
export function biquad(x, c, out) {
  const y = out || new Float32Array(x.length);
  const { b0, b1, b2, a1, a2 } = c;
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + z1;
    z1 = b1 * xi - a1 * yi + z2;
    z2 = b2 * xi - a2 * yi;
    y[i] = yi;
  }
  return y;
}

export function filter(x, type, fs, f0, q, gainDb) {
  return biquad(x, biquadCoeffs(type, fs, f0, q, gainDb));
}

/* ------------------------------------------------------------------ */
/* Loudness (ITU-R BS.1770-4 / EBU R128), mono                         */
/* ------------------------------------------------------------------ */

function kWeightingCoeffs(fs) {
  // Coefficients derived for arbitrary sample rate (as in libebur128).
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  let Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const pre = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const rlb = {
    b0: 1, b1: -2, b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // RLB numerator is unnormalised (1,-2,1) by design; denominator normalised.
  return { pre, rlb };
}

/** Integrated loudness in LUFS of a mono signal. Returns -Infinity for silence. */
export function integratedLoudness(x, fs) {
  const { pre, rlb } = kWeightingCoeffs(fs);
  const k = biquad(biquad(x, pre), rlb);
  const block = Math.round(0.4 * fs), hop = Math.round(0.1 * fs);
  if (k.length < block) {
    let s = 0; for (let i = 0; i < k.length; i++) s += k[i] * k[i];
    const z = s / Math.max(1, k.length);
    return z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity;
  }
  // prefix sums of squares for fast block energy
  const nHops = Math.floor(k.length / hop);
  const hopE = new Float64Array(nHops);
  for (let h = 0; h < nHops; h++) {
    let s = 0; const st = h * hop;
    for (let i = st; i < st + hop; i++) s += k[i] * k[i];
    hopE[h] = s;
  }
  const per = block / hop; // 4
  const zs = [];
  for (let h = 0; h + per <= nHops; h++) {
    let s = 0; for (let j = 0; j < per; j++) s += hopE[h + j];
    zs.push(s / block);
  }
  const L = (z) => -0.691 + 10 * Math.log10(z);
  const abs = zs.filter((z) => z > 0 && L(z) > -70);
  if (!abs.length) return -Infinity;
  const meanAbs = abs.reduce((a, b) => a + b, 0) / abs.length;
  const relGate = L(meanAbs) - 10;
  const rel = abs.filter((z) => L(z) > relGate);
  if (!rel.length) return -Infinity;
  return L(rel.reduce((a, b) => a + b, 0) / rel.length);
}

export function samplePeak(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; }
  return p;
}

/** 4x oversampled peak estimate (approximate true peak). */
export function truePeak(x) {
  // 4-phase polyphase interpolation with a short windowed-sinc kernel.
  const taps = 12, phases = 4;
  const kernels = [];
  for (let p = 0; p < phases; p++) {
    const frac = p / phases, k = new Float32Array(taps * 2);
    for (let j = -taps + 1; j <= taps; j++) {
      const t = j - frac;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / (taps + 1));
      k[j + taps - 1] = sinc * w;
    }
    kernels.push(k);
  }
  let peak = samplePeak(x);
  for (let i = taps; i < x.length - taps; i++) {
    for (let p = 1; p < phases; p++) {
      const k = kernels[p]; let s = 0;
      for (let j = 0; j < k.length; j++) s += x[i - taps + 1 + j] * k[j];
      const a = Math.abs(s); if (a > peak) peak = a;
    }
  }
  return peak;
}

/* ------------------------------------------------------------------ */
/* Dynamics                                                            */
/* ------------------------------------------------------------------ */

function coef(ms, fs) { return Math.exp(-1 / Math.max(1, (ms / 1000) * fs)); }

/**
 * Feed-forward compressor with soft knee. Works on a level envelope in dB.
 * opts: thresholdDb, ratio, kneeDb, attackMs, releaseMs, makeupDb
 */
export function compress(x, fs, opts) {
  const { thresholdDb = -20, ratio = 3, kneeDb = 6, attackMs = 8, releaseMs = 120, makeupDb = 0 } = opts;
  const y = new Float32Array(x.length);
  const aA = coef(attackMs, fs), aR = coef(releaseMs, fs);
  const makeup = dbToGain(makeupDb);
  let env = 0; // smoothed gain reduction in dB (<= 0)
  for (let i = 0; i < x.length; i++) {
    const lvl = gainToDb(Math.abs(x[i]));
    const over = lvl - thresholdDb;
    let gr;
    if (2 * over < -kneeDb) gr = 0;
    else if (2 * Math.abs(over) <= kneeDb) gr = ((1 / ratio - 1) * Math.pow(over + kneeDb / 2, 2)) / (2 * kneeDb);
    else gr = (1 / ratio - 1) * over;
    env = gr < env ? aA * env + (1 - aA) * gr : aR * env + (1 - aR) * gr;
    y[i] = x[i] * dbToGain(env) * makeup;
  }
  return y;
}

/** RMS envelope in dB over windows of `winMs`, one value per window. */
export function rmsWindowsDb(x, fs, winMs = 10) {
  const w = Math.max(1, Math.round((winMs / 1000) * fs));
  const n = Math.ceil(x.length / w);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0; const st = k * w, en = Math.min(x.length, st + w);
    for (let i = st; i < en; i++) s += x[i] * x[i];
    out[k] = 10 * Math.log10(s / Math.max(1, en - st) + 1e-20);
  }
  return { db: out, win: w };
}

/** Percentile (0..1) of short-term (50 ms) RMS levels in dBFS. */
export function levelPercentileDb(x, fs, percentile = 0.1) {
  const { db } = rmsWindowsDb(x, fs, 50);
  const vals = Array.from(db).filter((v) => v > -140).sort((a, b) => a - b);
  if (!vals.length) return -120;
  return vals[Math.floor(percentile * (vals.length - 1))];
}

/** Estimate the noise floor (dBFS RMS) as a low percentile of short-term RMS. */
export const noiseFloorDb = (x, fs, percentile = 0.1) => levelPercentileDb(x, fs, percentile);

/**
 * Downward expander / soft gate. Attenuates parts below threshold by up to rangeDb.
 * opts: thresholdDb, ratio, rangeDb, attackMs, holdMs, releaseMs
 */
export function expand(x, fs, opts) {
  const { thresholdDb = -50, ratio = 2, rangeDb = 12, attackMs = 2, holdMs = 60, releaseMs = 150 } = opts;
  const y = new Float32Array(x.length);
  const aA = coef(attackMs, fs), aR = coef(releaseMs, fs);
  const aDet = coef(10, fs);
  const holdN = Math.round((holdMs / 1000) * fs);
  let det = 0, g = 0, hold = 0; // g in dB (<= 0)
  for (let i = 0; i < x.length; i++) {
    const s = x[i] * x[i];
    det = aDet * det + (1 - aDet) * s;
    const lvl = 10 * Math.log10(det + 1e-20);
    let target = 0;
    if (lvl < thresholdDb) target = Math.max(-rangeDb, (lvl - thresholdDb) * (ratio - 1));
    if (target >= g) { // opening (less attenuation)
      g = aA * g + (1 - aA) * target; hold = holdN;
    } else if (hold > 0) { hold--; }
    else { g = aR * g + (1 - aR) * target; }
    y[i] = x[i] * dbToGain(g);
  }
  return y;
}

/**
 * De-esser: dynamically notches the sibilance band when it is loud relative to
 * the full-band signal. amount 0..1 sets the maximum cut (up to 12 dB).
 */
export function deEss(x, fs, { freq = 6500, amount = 0.5, thresholdDb = -6 } = {}) {
  if (amount <= 0) return Float32Array.from(x);
  const bp = filter(x, 'bandpass', fs, freq, 1.4);
  const y = new Float32Array(x.length);
  const aA = coef(1, fs), aR = coef(60, fs);
  const aEnv = coef(5, fs);
  let eb = 0, ef = 0, cut = 0;
  const maxCut = amount; // fraction of band removed at most
  for (let i = 0; i < x.length; i++) {
    eb = aEnv * eb + (1 - aEnv) * bp[i] * bp[i];
    ef = aEnv * ef + (1 - aEnv) * x[i] * x[i];
    // ratio of sibilant band to full band energy, in dB
    const rel = 10 * Math.log10((eb + 1e-20) / (ef + 1e-20));
    const absBand = 10 * Math.log10(eb + 1e-20);
    let target = 0;
    if (rel > thresholdDb && absBand > -60) target = Math.min(1, (rel - thresholdDb) / 6) * maxCut;
    cut = target > cut ? aA * cut + (1 - aA) * target : aR * cut + (1 - aR) * target;
    y[i] = x[i] - cut * bp[i];
  }
  return y;
}

/**
 * Look-ahead brickwall limiter (offline, zero-latency output alignment).
 * ceilingDb is a sample-peak ceiling. Gain never exceeds what is needed.
 */
export function limit(x, fs, { ceilingDb = -1.5, lookaheadMs = 5, releaseMs = 80 } = {}) {
  const n = x.length;
  const ceil = dbToGain(ceilingDb);
  const L = Math.max(2, Math.round((lookaheadMs / 1000) * fs));
  const half = Math.floor(L / 2);
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) { const a = Math.abs(x[i]); req[i] = a > ceil ? ceil / a : 1; }
  const m = slidingMin(req, half);
  // moving average of m over [i-half, i+half] -> always <= req[i]
  const gs = new Float32Array(n);
  const w = 2 * half + 1;
  const P = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) P[i + 1] = P[i] + m[i];
  for (let i = 0; i < n; i++) {
    const lo = i - half, hi = i + half; // inclusive
    const cLo = Math.max(0, lo), cHi = Math.min(n - 1, hi);
    const outside = (cLo - lo) + (hi - cHi); // samples beyond the edges count as gain 1
    gs[i] = (P[cHi + 1] - P[cLo] + outside) / w;
  }
  const rel = 1 - coef(releaseMs, fs);
  const y = new Float32Array(n);
  let g = 1;
  for (let i = 0; i < n; i++) {
    const t = Math.min(gs[i], req[i]);
    g = t < g ? t : g + (t - g) * rel;
    let v = x[i] * g;
    if (v > ceil) v = ceil; else if (v < -ceil) v = -ceil;
    y[i] = v;
  }
  return y;
}

/** Sliding window minimum over [i-r, i+r] (monotonic deque, O(n)). */
export function slidingMin(a, r) {
  const n = a.length, out = new Float32Array(n);
  const dq = new Int32Array(n + 2 * r + 2);
  let head = 0, tail = 0;
  for (let j = 0; j < n + r; j++) {
    if (j < n) {
      while (tail > head && a[dq[tail - 1]] >= a[j]) tail--;
      dq[tail++] = j;
    }
    const i = j - r;
    if (i >= 0) {
      while (dq[head] < i - r) head++;
      out[i] = a[dq[head]];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

export function gain(x, g) {
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * g;
  return y;
}

export function mix(a, b, wa, wb) {
  const y = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) y[i] = a[i] * wa + b[i] * wb;
  return y;
}

/**
 * Windowed-sinc resampler (Blackman-Harris window). Good quality for speech
 * and music; used for 44.1k <-> 48k conversion.
 */
export function resample(x, fromRate, toRate, halfTaps = 16, onProgress) {
  if (fromRate === toRate) return Float32Array.from(x);
  const ratio = toRate / fromRate;
  const outLen = Math.round(x.length * ratio);
  const y = new Float32Array(outLen);
  const cutoff = Math.min(1, ratio) * 0.94;
  const step = 1 / ratio;
  const win = (t) => { // Blackman-Harris over [-halfTaps, halfTaps]
    const p = (t / halfTaps + 1) * Math.PI; // 0..2π
    return 0.35875 - 0.48829 * Math.cos(p) + 0.14128 * Math.cos(2 * p) - 0.01168 * Math.cos(3 * p);
  };
  // Pre-tabulate the kernel at fine resolution for speed.
  const RES = 512;
  const tableLen = halfTaps * RES + 1;
  const table = new Float32Array(tableLen);
  for (let k = 0; k < tableLen; k++) {
    const t = k / RES;
    const s = t === 0 ? 1 : Math.sin(Math.PI * cutoff * t) / (Math.PI * cutoff * t);
    table[k] = cutoff * s * win(t);
  }
  const kernel = (t) => {
    const a = Math.abs(t) * RES; const i = a | 0;
    if (i >= tableLen - 1) return 0;
    const f = a - i; return table[i] + (table[i + 1] - table[i]) * f;
  };
  const tick = Math.max(1, Math.floor(outLen / 50));
  for (let n = 0; n < outLen; n++) {
    const pos = n * step;
    const c = Math.floor(pos), frac = pos - c;
    let s = 0;
    const lo = Math.max(0, c - halfTaps + 1), hi = Math.min(x.length - 1, c + halfTaps);
    for (let j = lo; j <= hi; j++) s += x[j] * kernel(j - c - frac);
    y[n] = s;
    if (onProgress && n % tick === 0) onProgress(n / outLen);
  }
  return y;
}

/** Float -> integer PCM with TPDF dither. bits: 16 or 24. Returns Int32Array. */
export function quantize(x, bits, dither = true, seed = 12345) {
  const max = Math.pow(2, bits - 1);
  const out = new Int32Array(x.length);
  let s = seed >>> 0;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = 0; i < x.length; i++) {
    let v = x[i] * max;
    if (dither) v += rnd() - rnd(); // TPDF, ±1 LSB
    v = Math.round(v);
    if (v > max - 1) v = max - 1; else if (v < -max) v = -max;
    out[i] = v;
  }
  return out;
}
