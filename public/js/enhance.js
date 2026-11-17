// Enhancement pipeline. Pure functions; the RNNoise module is injected so the
// same code runs in a Web Worker and in Node tests.
import * as D from './dsp.js';

const RN_RATE = 48000;
const RN_FRAME = 480;
const RN_DELAY = 480; // RNNoise output lags input by exactly one frame (verified in tests)

/** Run RNNoise over a mono signal at any sample rate. Output is time-aligned. */
export function rnnoise(Module, x, fs, onProgress = () => {}) {
  const x48 = fs === RN_RATE ? x : D.resample(x, fs, RN_RATE, 16, (p) => onProgress(p * 0.2));
  const n = x48.length;
  const padded = new Float32Array(n + RN_DELAY + RN_FRAME);
  padded.set(x48);
  const out = new Float32Array(padded.length);
  const st = Module._rnnoise_create();
  const ptr = Module._malloc(RN_FRAME * 4);
  const frames = Math.floor(padded.length / RN_FRAME);
  const tick = Math.max(1, Math.floor(frames / 40));
  try {
    for (let f = 0; f < frames; f++) {
      const off = f * RN_FRAME;
      let heap = Module.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + RN_FRAME);
      for (let i = 0; i < RN_FRAME; i++) heap[i] = padded[off + i] * 32768;
      Module._rnnoise_process_frame(st, ptr, ptr);
      heap = Module.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + RN_FRAME); // heap may have grown
      for (let i = 0; i < RN_FRAME; i++) out[off + i] = heap[i] / 32768;
      if (f % tick === 0) onProgress(0.2 + 0.6 * (f / frames));
    }
  } finally {
    Module._free(ptr);
    Module._rnnoise_destroy(st);
  }
  const aligned = out.subarray(RN_DELAY, RN_DELAY + n);
  const back = fs === RN_RATE ? Float32Array.from(aligned)
    : D.resample(aligned, RN_RATE, fs, 16, (p) => onProgress(0.8 + p * 0.2));
  // guarantee exact original length after round-trip resampling
  if (back.length === x.length) return back;
  const fixed = new Float32Array(x.length);
  fixed.set(back.subarray(0, Math.min(back.length, x.length)));
  return fixed;
}

function levelTo(x, fs, lufs) {
  const L = D.integratedLoudness(x, fs);
  if (!isFinite(L)) return { y: Float32Array.from(x), gainDb: 0 };
  const g = lufs - L;
  return { y: D.gain(x, D.dbToGain(g)), gainDb: g };
}

/**
 * Full enhancement chain.
 * @param x        mono Float32Array
 * @param fs       sample rate
 * @param p        preset-style parameters (see presets.js) + intensity (0..1)
 * @param Module   RNNoise emscripten module (or null to skip AI denoise)
 * @param progress callback(fraction, label)
 */
export function enhance(x, fs, p, Module, progress = () => {}) {
  const intensity = p.intensity ?? 1;
  const stage = (from, to) => (f) => progress(from + (to - from) * f);
  if (D.samplePeak(x) < 1e-6) return { audio: Float32Array.from(x), report: { silent: true } };

  // 1. Rumble removal
  progress(0.02, 'Removing rumble');
  let w = p.hp > 0 ? D.biquad(D.biquad(x, D.biquadCoeffs('highpass', fs, p.hp, 0.54)), D.biquadCoeffs('highpass', fs, p.hp, 1.31)) : Float32Array.from(x);

  // 2. AI noise removal
  if (p.denoise > 0 && Module) {
    progress(0.05, 'Removing background noise');
    const dn = rnnoise(Module, w, fs, stage(0.05, 0.6));
    w = p.denoise >= 1 ? dn : D.mix(dn, w, p.denoise, 1 - p.denoise);
  }

  // 3. Pre-level so the following stages see a known level
  progress(0.62, 'Balancing levels');
  w = levelTo(w, fs, -20).y;

  // 4. Soften pauses (gate relative to measured noise floor)
  if (p.gate > 0) {
    // Threshold sits well below loud speech but above the residual noise floor.
    const floor = D.levelPercentileDb(w, fs, 0.1);
    const loud = D.levelPercentileDb(w, fs, 0.9);
    const thr = Math.min(-38, Math.max(floor + 8, loud - 30, -65));
    w = D.expand(w, fs, { thresholdDb: thr, ratio: 2.5, rangeDb: p.gate, attackMs: 2, holdMs: 80, releaseMs: 180 });
  }

  // 5. De-ess
  progress(0.7, 'Taming harsh S sounds');
  if (p.deess > 0) w = D.deEss(w, fs, { freq: fs > 20000 ? 6500 : fs * 0.3, amount: p.deess, thresholdDb: -8 });

  // 6. Tone (EQ)
  progress(0.76, 'Shaping tone');
  if (p.warmth) w = D.filter(w, 'lowshelf', fs, 160, 0.7, p.warmth);
  if (p.mud) w = D.filter(w, 'peaking', fs, 320, 1.0, p.mud);
  if (p.presence) w = D.filter(w, 'peaking', fs, 4200, 0.9, p.presence);
  if (p.air && fs > 24000) w = D.filter(w, 'highshelf', fs, 11000, 0.7, p.air);

  // 7. Compression
  progress(0.82, 'Evening out volume');
  if (p.compRatio > 1) w = D.compress(w, fs, { thresholdDb: p.compThr, ratio: p.compRatio, kneeDb: 6, attackMs: 6, releaseMs: 140 });

  // 8. Intensity blend (loudness-matched so the slider changes character, not volume)
  let y = w;
  if (intensity < 1) {
    const dry = levelTo(x, fs, -20).y;
    const wet = levelTo(w, fs, -20).y;
    y = D.mix(wet, dry, intensity, 1 - intensity);
  }

  // 9. Loudness normalisation + limiter (two passes so the limiter doesn't drag loudness down)
  progress(0.9, 'Setting loudness');
  // Search for the pre-limiter gain that lands exactly on target after limiting.
  const base = y;
  const L0 = D.integratedLoudness(base, fs);
  if (isFinite(L0)) {
    let gDb = p.target - L0;
    const maxDb = gDb + 18;
    for (let pass = 0; pass < 10; pass++) {
      y = D.limit(D.gain(base, D.dbToGain(gDb)), fs, { ceilingDb: p.ceiling, lookaheadMs: 5, releaseMs: 80 });
      const now = D.integratedLoudness(y, fs);
      if (!isFinite(now) || Math.abs(now - p.target) < 0.1) break;
      gDb = Math.min(maxDb, gDb + (p.target - now) * 1.4);
    }
  }
  progress(1, 'Done');
  return {
    audio: y,
    report: {
      inputLufs: D.integratedLoudness(x, fs),
      outputLufs: D.integratedLoudness(y, fs),
      peakDb: D.gainToDb(D.samplePeak(y)),
    },
  };
}
