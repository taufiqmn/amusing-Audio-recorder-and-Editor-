// Deterministic test fixtures. The clean reference is always known, so every
// measurement compares the result against the true signal.
import { fft } from '../public/studio/js/engine/fft.js';
import { resample } from '../public/js/dsp.js';

export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** Resonator (2-pole) filter in place for formants. */
function resonate(x, fs, fArr, bw) {
  const y = new Float32Array(x.length); let y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const f = typeof fArr === 'number' ? fArr : fArr[i];
    const r = Math.exp((-Math.PI * bw) / fs), a1 = 2 * r * Math.cos((2 * Math.PI * f) / fs), a2 = -r * r, g = 1 - r;
    const v = g * x[i] + a1 * y1 + a2 * y2; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

const VOWELS = [[730, 1090, 2440], [270, 2290, 3010], [530, 1840, 2480], [570, 840, 2410], [440, 1020, 2240], [300, 870, 2240]];

/**
 * Clean speech-like reference: Rosenberg glottal pulses at a moving pitch, through three
 * formant resonators that change per syllable, syllable-rate envelope, fricative "s" bursts,
 * word gaps and longer phrase pauses. Returns { x, speechMask }.
 */
export function cleanSpeech(fs = 48000, seconds = 24, seed = 3, f0base = 125) {
  const R = rng(seed), n = Math.round(fs * seconds);
  const src = new Float32Array(n), fric = new Float32Array(n), env = new Float32Array(n), mask = new Uint8Array(n);
  const F = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  // build a syllable plan
  let t = 0.3; const syl = [];
  while (t < seconds - 0.5) {
    const words = 2 + Math.floor(R() * 4);
    for (let w = 0; w < words && t < seconds - 0.5; w++) {
      const nsyl = 1 + Math.floor(R() * 3);
      for (let k = 0; k < nsyl; k++) { const d = 0.14 + R() * 0.14; syl.push({ t, d, v: Math.floor(R() * VOWELS.length), s: R() < 0.25 }); t += d; }
      t += 0.06 + R() * 0.12;
    }
    t += 0.45 + R() * 0.6; // phrase pause
  }
  let phase = 0;
  for (const s of syl) {
    const a = Math.round(s.t * fs), b = Math.min(n, Math.round((s.t + s.d) * fs));
    for (let i = a; i < b; i++) {
      const u = (i - a) / (b - a); env[i] = Math.pow(Math.sin(Math.PI * u), 0.7) * (0.7 + 0.3 * Math.sin(s.t * 3)); mask[i] = 1;
      for (let f = 0; f < 3; f++) F[f][i] = VOWELS[s.v][f] * (1 + 0.05 * Math.sin(u * 3));
    }
    if (s.s) { const fa = b, fb = Math.min(n, b + Math.round(0.09 * fs)); for (let i = fa; i < fb; i++) { fric[i] = Math.sin((Math.PI * (i - fa)) / (fb - fa)); mask[i] = 1; } }
  }
  for (let f = 0; f < 3; f++) { let last = VOWELS[0][f]; for (let i = 0; i < n; i++) { if (F[f][i] === 0) F[f][i] = last; else last = F[f][i]; } }
  for (let i = 0; i < n; i++) {
    const tt = i / fs, f0 = f0base * (1 + 0.12 * Math.sin(2 * Math.PI * 0.35 * tt) + 0.04 * Math.sin(2 * Math.PI * 2.3 * tt));
    phase += f0 / fs; if (phase >= 1) phase -= 1;
    const op = 0.6; // Rosenberg pulse derivative: open phase rise/fall, closed phase zero
    src[i] = phase < op * 0.65 ? Math.sin((Math.PI * phase) / (op * 0.65)) * 0.5 : phase < op ? Math.cos((Math.PI * (phase - op * 0.65)) / (2 * op * 0.35)) - 1.3 : 0;
  }
  // differentiate (lip radiation) then formants
  const d = new Float32Array(n); for (let i = 1; i < n; i++) d[i] = (src[i] - src[i - 1]) * env[i];
  let v = resonate(d, fs, F[0], 90); const v2 = resonate(d, fs, F[1], 110), v3 = resonate(d, fs, F[2], 160);
  for (let i = 0; i < n; i++) v[i] = v[i] + 0.6 * v2[i] + 0.35 * v3[i];
  // fricatives: high-passed noise
  const nz = new Float32Array(n); for (let i = 0; i < n; i++) nz[i] = (R() * 2 - 1) * fric[i];
  const s1 = resonate(nz, fs, Math.min(6500, fs * 0.4), 2500);
  for (let i = 0; i < n; i++) v[i] += 0.5 * s1[i];
  v = highpass70(v, fs); // real voices carry almost nothing below ~70 Hz
  normalizeRms(v, mask, -20);
  return { x: v, mask };
}

function highpass70(x, fs) {
  const run = (x2, q) => { const w = (2 * Math.PI * 70) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al; const b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0; const y = new Float32Array(x2.length); let z1 = 0, z2 = 0; for (let i = 0; i < x2.length; i++) { const v = b0 * x2[i] + z1; z1 = b1 * x2[i] - a1 * v + z2; z2 = b0 * x2[i] - a2 * v; y[i] = v; } return y; };
  return run(run(x, 0.5412), 1.3066);
}
export function rmsDb(x, mask = null, want = 1) { let s = 0, c = 0; for (let i = 0; i < x.length; i++) if (!mask || mask[i] === want) { s += x[i] * x[i]; c++; } return 10 * Math.log10(s / Math.max(1, c) + 1e-20); }
function normalizeRms(x, mask, db) { const g = Math.pow(10, (db - rmsDb(x, mask)) / 20); for (let i = 0; i < x.length; i++) x[i] *= g; }

/* ---------------- noises ---------------- */
export function white(n, seed = 9) { const R = rng(seed); return Float32Array.from({ length: n }, () => R() * 2 - 1); }
export function pink(n, seed = 11) { const R = rng(seed); let b0 = 0, b1 = 0, b2 = 0; return Float32Array.from({ length: n }, () => { const w = R() * 2 - 1; b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; return (b0 + b1 + b2 + w * 0.1848) * 0.2; }); }
export function hum(n, fs, f0) { return Float32Array.from({ length: n }, (_, i) => { const t = i / fs; return Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(2 * Math.PI * 2 * f0 * t + 1) + 0.35 * Math.sin(2 * Math.PI * 3 * f0 * t + 2) + 0.2 * Math.sin(2 * Math.PI * 5 * f0 * t); }); }
export function fan(n, fs, seed = 13) {
  const p = pink(n, seed); const lp = resonate(p, fs, 180, 400);
  return Float32Array.from({ length: n }, (_, i) => 0.6 * lp[i] * 6 + 0.25 * p[i] + 0.15 * Math.sin(2 * Math.PI * 29 * i / fs) + 0.05 * Math.sin(2 * Math.PI * 87 * i / fs));
}
export function babble(n, fs) {
  const out = new Float32Array(n);
  for (let k = 0; k < 5; k++) { const v = cleanSpeech(fs, n / fs, 100 + k * 7, 100 + k * 23).x; const sh = Math.round((k * 0.37 * fs)) % n; for (let i = 0; i < n; i++) out[i] += v[(i + sh) % n]; }
  return out;
}

/** Mix speech with noise at an SNR (speech RMS on voiced parts vs noise RMS). */
export function addNoise(x, mask, noise, snrDb) {
  const g = Math.pow(10, (rmsDb(x, mask) - snrDb - rmsDb(noise)) / 20);
  return Float32Array.from(x, (v, i) => v + g * noise[i]);
}

/** Exponentially decaying noise impulse response with a given RT60, applied by FFT convolution. */
export function reverb(x, fs, rt60, wet = 0.7, seed = 21) {
  const len = Math.round(rt60 * fs * 1.2), R = rng(seed), h = new Float32Array(len);
  for (let i = 0; i < len; i++) h[i] = (R() * 2 - 1) * Math.exp((-6.9 * i) / (rt60 * fs));
  for (let i = 0; i < Math.round(0.004 * fs); i++) h[i] *= i / (0.004 * fs);
  const y = convolve(x, h).subarray(0, x.length);
  // dry + scaled wet; normalise wet energy relative to dry
  let ed = 0, ew = 0; for (let i = 0; i < x.length; i++) { ed += x[i] * x[i]; ew += y[i] * y[i]; }
  const g = Math.sqrt(ed / ew) * wet;
  return Float32Array.from(x, (v, i) => v + g * y[i]);
}

export function convolve(a, b) {
  let N = 1; while (N < a.length + b.length) N <<= 1;
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  ar.set(a); br.set(b); fft(ar, ai); fft(br, bi);
  for (let k = 0; k < N; k++) { const r = ar[k] * br[k] - ai[k] * bi[k], i = ar[k] * bi[k] + ai[k] * br[k]; ar[k] = r; ai[k] = i; }
  fft(ar, ai, true); return Float32Array.from(ar.subarray(0, a.length + b.length - 1));
}

export function phoneBand(x, fs) {
  // a real narrowband call: 300 Hz high-pass, then sampled at 8 kHz (nothing above 4 kHz)
  return resample(resample(resonateBand(x, fs), fs, 8000), 8000, fs);
}
function resonateBand(x, fs) {
  const hp = (f) => { const w = (2 * Math.PI * f) / fs, c = Math.cos(w), al = Math.sin(w) / 1.414, a0 = 1 + al; return [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0]; };
  const lp = (f) => { const w = (2 * Math.PI * f) / fs, c = Math.cos(w), al = Math.sin(w) / 1.414, a0 = 1 + al; return [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - al) / a0]; };
  const run = (x2, [b0, b1, b2, a1, a2]) => { const y = new Float32Array(x2.length); let z1 = 0, z2 = 0; for (let i = 0; i < x2.length; i++) { const v = b0 * x2[i] + z1; z1 = b1 * x2[i] - a1 * v + z2; z2 = b2 * x2[i] - a2 * v; y[i] = v; } return y; };
  return run(run(x, hp(300)), lp(3400));
}

export const clip = (x, level) => Float32Array.from(x, (v) => Math.max(-level, Math.min(level, v)));
export const gainDb = (x, db) => Float32Array.from(x, (v) => v * Math.pow(10, db / 20));
export const addDC = (x, dc) => Float32Array.from(x, (v) => v + dc);

/* ---------------- measures ---------------- */
export function siSdr(ref, est) {
  let dot = 0, rr = 0; const n = Math.min(ref.length, est.length);
  for (let i = 0; i < n; i++) { dot += ref[i] * est[i]; rr += ref[i] * ref[i]; }
  const a = dot / (rr || 1); let s = 0, e = 0;
  for (let i = 0; i < n; i++) { const t = a * ref[i], d = est[i] - t; s += t * t; e += d * d; }
  return 10 * Math.log10(s / (e || 1e-20));
}

/** Speech-to-gap ratio: level on speech vs level in pauses (pauses more than 60 ms away from speech). */
export function gapLevels(x, mask, fs) {
  const guard = Math.round(0.06 * fs); const gm = new Uint8Array(mask.length); let last = -1e9;
  for (let i = 0; i < mask.length; i++) { if (mask[i]) last = i; gm[i] = i - last > guard ? 1 : 0; }
  let next = 1e12; for (let i = mask.length - 1; i >= 0; i--) { if (mask[i]) next = i; if (next - i <= guard) gm[i] = 0; }
  return { speech: rmsDb(x, mask, 1), gap: rmsDb(x, gm, 1) };
}

/** WAV writer (16-bit or float) for fixtures saved to disk. */
export function wav(chs, fs, bits = 16) {
  const nc = chs.length, n = chs[0].length, bps = bits / 8, data = n * nc * bps, b = Buffer.alloc(44 + data);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(bits === 32 ? 3 : 1, 20); b.writeUInt16LE(nc, 22); b.writeUInt32LE(fs, 24); b.writeUInt32LE(fs * nc * bps, 28); b.writeUInt16LE(nc * bps, 32); b.writeUInt16LE(bits, 34);
  b.write('data', 36); b.writeUInt32LE(data, 40); let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { const v = chs[c][i]; if (bits === 32) b.writeFloatLE(v, o); else b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), o); o += bps; }
  return b;
}
