import * as D from '../public/js/dsp.js';
import { synthSpeech, writeWavFloat, ffmpegLufs, check } from './helpers.mjs';
import os from 'node:os'; import path from 'node:path';

console.log('DSP');
for (const sr of [48000, 44100]) {
  const { x } = synthSpeech(sr, 12);
  const mine = D.integratedLoudness(x, sr);
  const f = path.join(os.tmpdir(), `lufs-${sr}.wav`);
  writeWavFloat(f, x, sr);
  const ref = ffmpegLufs(f).I;
  check(Math.abs(mine - ref) < 0.2, `loudness @${sr}: ours ${mine.toFixed(2)} vs ffmpeg ${ref} LUFS`);
}

// limiter respects ceiling and does not touch quiet signal
{
  const sr = 48000; const { x } = synthSpeech(sr, 5, { noise: 0, hum: 0 });
  const loud = D.gain(x, 6);
  const y = D.limit(loud, sr, { ceilingDb: -1.5 });
  const pk = D.gainToDb(D.samplePeak(y));
  check(pk <= -1.49, `limiter ceiling: peak ${pk.toFixed(2)} dBFS <= -1.5`);
  const q = D.gain(x, 0.1); const yq = D.limit(q, sr, { ceilingDb: -1.5 });
  let diff = 0; for (let i = 0; i < q.length; i++) diff = Math.max(diff, Math.abs(q[i] - yq[i]));
  check(diff < 1e-7, 'limiter is transparent below the ceiling');
}

// resampler: length + tone preserved
{
  const sr = 44100, n = sr * 2; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / sr);
  const y = D.resample(x, 44100, 48000);
  check(y.length === Math.round(n * 48000 / 44100), 'resample length correct');
  let err = 0; for (let i = 2000; i < y.length - 2000; i++) err = Math.max(err, Math.abs(y[i] - 0.5 * Math.sin(2 * Math.PI * 1000 * i / 48000)));
  check(err < 0.002, `resample accuracy: max error ${err.toExponential(2)}`);
}

// highpass removes hum
{
  const sr = 48000, n = sr; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * 30 * i / sr);
  const c1 = D.biquadCoeffs('highpass', sr, 80, 0.54), c2 = D.biquadCoeffs('highpass', sr, 80, 1.31);
  const y = D.biquad(D.biquad(x, c1), c2);
  const r = D.samplePeak(y.subarray(sr / 2));
  check(r < 0.05, `80 Hz high-pass attenuates 30 Hz rumble to ${D.gainToDb(r).toFixed(1)} dB`);
}

// quantize with dither stays in range
{
  const x = new Float32Array([1, -1, 0.5, 0, -0.99999]);
  const q = D.quantize(x, 16);
  check(Math.max(...q) <= 32767 && Math.min(...q) >= -32768, '16-bit quantize clamps to range');
}

// true peak >= sample peak
{
  const sr = 48000, n = 4800; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.9 * Math.sin(2 * Math.PI * 11025 * i / sr + 0.7);
  check(D.truePeak(x) >= D.samplePeak(x), 'true-peak estimate is >= sample peak');
}
