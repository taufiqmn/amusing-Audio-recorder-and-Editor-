// Memory and speed on long files (B4): streams synthetic audio through the full Standard
// chain (analysis + 2 passes + limiter) and records peak memory. Run: node tests/long.mjs [minutes...]
import fs from 'node:fs'; import os from 'node:os';
import { enhance, FS } from '../public/studio/js/engine/chain.js';
import createRN from '../public/studio/js/vendor/rnnoise.js';
import * as F from './fixtures.mjs';
const Module = await createRN({ wasmBinary: fs.readFileSync(new URL('../public/studio/js/vendor/rnnoise.wasm', import.meta.url)) });
const { x: clean, mask } = F.cleanSpeech(FS, 20, 3); const loop = F.addNoise(clean, mask, F.fan(clean.length, FS), 10);
const out = [];
for (const minutes of (process.argv.slice(2).length ? process.argv.slice(2) : ['10', '60']).map(Number)) {
  global.gc?.(); const total = minutes * 60 * FS; let peak = 0; const sample = () => { const r = process.memoryUsage().rss; if (r > peak) peak = r; };
  const open = async function* () { for (let i = 0; i < total; i += 24000) { const n = Math.min(24000, total - i), o = i % loop.length; const b = new Float32Array(n); for (let k = 0; k < n; k++) b[k] = loop[(o + k) % loop.length]; sample(); yield [b]; } };
  const t0 = Date.now(); let frames = 0;
  const rep = await enhance({ open, nCh: 1, Module, totalSamples: total, preset: 'podcast', sink: (b) => { frames += b.main[0].length; } });
  const sec = (Date.now() - t0) / 1000;
  const row = { minutes, peakRssMB: Math.round(peak / 1e6), seconds: Math.round(sec), speed: +(minutes * 60 / sec).toFixed(2), framesOut: frames, framesIn: total, loudness: +rep.after.loudness.toFixed(2), cpu: os.cpus()[0].model.trim() };
  out.push(row); console.log(JSON.stringify(row));
}
fs.mkdirSync(new URL('./report/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./report/long-results.json', import.meta.url), JSON.stringify(out, null, 1));
