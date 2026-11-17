import * as D from '../public/js/dsp.js';
import { enhance, rnnoise } from '../public/js/enhance.js';
import { PRESETS } from '../public/js/presets.js';
import createRN from '../public/js/vendor/rnnoise.js';
import { synthSpeech, check } from './helpers.mjs';

console.log('Enhancement');
import fsx from 'node:fs';
const Module = await createRN({ wasmBinary: fsx.readFileSync(new URL('../public/js/vendor/rnnoise.wasm', import.meta.url)) });
check(typeof Module._rnnoise_create === 'function', 'RNNoise WASM loads');

function gapRms(y, voiced, sr) {
  // RMS in pauses (skip 60 ms after speech ends to avoid tails)
  let s = 0, c = 0, since = 1e9; const guard = Math.round(0.06 * sr);
  for (let i = 0; i < y.length; i++) {
    if (voiced[i]) { since = 0; continue; }
    since++; if (since < guard) continue;
    s += y[i] * y[i]; c++;
  }
  return Math.sqrt(s / Math.max(1, c));
}
function speechRms(y, voiced) { let s = 0, c = 0; for (let i = 0; i < y.length; i++) if (voiced[i]) { s += y[i] * y[i]; c++; } return Math.sqrt(s / c); }

for (const sr of [48000, 44100]) {
  const { x, voiced } = synthSpeech(sr, 12, { noise: 0.03, hum: 0.006 });
  const t0 = Date.now();
  const { audio: y, report } = enhance(x, sr, { ...PRESETS.podcast, intensity: 1 }, Module, () => {});
  const ms = Date.now() - t0;
  const snrIn = D.gainToDb(speechRms(x, voiced) / gapRms(x, voiced, sr));
  const snrOut = D.gainToDb(speechRms(y, voiced) / gapRms(y, voiced, sr));
  check(y.length === x.length, `@${sr}: output length unchanged`);
  check(snrOut - snrIn > 12, `@${sr}: speech-to-noise improved ${snrIn.toFixed(1)} → ${snrOut.toFixed(1)} dB`);
  check(Math.abs(report.outputLufs - (-16)) < 0.3, `@${sr}: hits −16 LUFS target (${report.outputLufs.toFixed(2)})`);
  check(report.peakDb <= -1.49, `@${sr}: peak ${report.peakDb.toFixed(2)} dBFS under −1.5 ceiling`);
  console.log(`    (${(12 / (ms / 1000)).toFixed(0)}× real-time)`);
}

// alignment: AI denoise output must not be delayed relative to input (non-periodic chirp)
for (const sr of [48000, 44100]) {
  const n = sr * 4; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / sr; const env = Math.sin(2 * Math.PI * 1.3 * t) > 0.2 ? 1 : 0; x[i] = 0.3 * env * (Math.sin(2 * Math.PI * (150 * t + 40 * t * t)) + 0.5 * Math.sin(2 * Math.PI * (450 * t + 120 * t * t))); }
  const y = rnnoise(Module, x, sr);
  let best = -Infinity, lag = 0;
  for (let L = -300; L <= 300; L++) { let s = 0; for (let i = 8000; i < n - 8000; i++) s += x[i] * y[i + L]; if (s > best) { best = s; lag = L; } }
  check(Math.abs(lag) <= 3, `@${sr}: AI-denoised audio stays in sync (lag ${lag} samples)`);
}

// every preset produces finite output at its target
for (const [key, p] of Object.entries(PRESETS)) {
  const sr = 48000; const { x } = synthSpeech(sr, 8, { noise: 0.02 });
  const { audio: y, report } = enhance(x, sr, { ...p, intensity: 0.8 }, Module);
  const finite = y.every(Number.isFinite);
  check(finite && Math.abs(report.outputLufs - p.target) < 0.6 && report.peakDb <= p.ceiling + 0.01,
    `preset ${key}: ${report.outputLufs.toFixed(1)} LUFS (target ${p.target}), peak ${report.peakDb.toFixed(1)}`);
}

// silence is handled
{
  const r = enhance(new Float32Array(48000), 48000, PRESETS.podcast, Module);
  check(r.audio.every((v) => v === 0), 'silent input returns silence without errors');
}
