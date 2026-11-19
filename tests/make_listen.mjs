// Builds tests/report/listen.html: loudness-matched before/after pairs + spectrograms + checklist.
import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
import { enhance, FS } from '../public/studio/js/engine/chain.js';
import { loudnessOf } from '../public/studio/js/engine/analyze.js';
import createRN from '../public/studio/js/vendor/rnnoise.js';
import * as F from './fixtures.mjs';
const Module = await createRN({ wasmBinary: fs.readFileSync(new URL('../public/studio/js/vendor/rnnoise.wasm', import.meta.url)) });
const dir = new URL('./report/listen/', import.meta.url); fs.mkdirSync(dir, { recursive: true });
const { x: clean, mask } = F.cleanSpeech(FS, 12, 21); const N = clean.length;
const cases = { 'Hiss, 5 dB': F.addNoise(clean, mask, F.white(N, 4), 5), 'Fan, 10 dB': F.addNoise(clean, mask, F.fan(N, FS), 10), 'Mains hum 50 Hz': F.addNoise(clean, mask, F.hum(N, FS, 50), 8),
  'Echoey room, RT60 0.8 s': F.reverb(clean, FS, 0.8, 0.8), 'Phone call': F.addNoise(F.phoneBand(clean, FS), mask, F.white(N, 6), 25), 'Clipped and quiet': F.gainDb(F.clip(F.gainDb(clean, 14), 0.5), -12) };
const rows = [];
for (const [name, x] of Object.entries(cases)) {
  const out = new Float32Array(N); let o = 0;
  const rep = await enhance({ open: async function* () { for (let i = 0; i < N; i += 24000) yield [x.slice(i, i + 24000)]; }, nCh: 1, Module, preset: 'auto', sink: (b) => { out.set(b.main[0], o); o += b.main[0].length; } });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  fs.writeFileSync(new URL(`${slug}-before.wav`, dir), F.wav([x], FS)); fs.writeFileSync(new URL(`${slug}-after.wav`, dir), F.wav([out], FS));
  for (const s of ['before', 'after']) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', new URL(`${slug}-${s}.wav`, dir).pathname, '-lavfi', 'showspectrumpic=s=640x240:legend=0:color=magma:scale=log', new URL(`${slug}-${s}.png`, dir).pathname]);
  rows.push({ name, slug, before: loudnessOf([x], FS), after: rep.after.loudness, reasons: rep.reasons, guard: rep.guard });
}
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Listen: before and after</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#0d0b1a;color:#f4f1ff;max-width:1100px;margin:0 auto;padding:24px}h1{font-size:26px}section{border:1px solid #333;border-radius:14px;padding:16px;margin:16px 0;background:#161227}img{width:100%;border-radius:8px}.g{display:grid;grid-template-columns:1fr 1fr;gap:12px}button{font:inherit;padding:8px 14px;border-radius:10px;border:1px solid #555;background:#241d3d;color:inherit;cursor:pointer}button[aria-pressed=true]{background:linear-gradient(120deg,#8b5cf6,#ec4899,#f59e0b);border-color:transparent}small{color:#aaa}li{margin:4px 0}</style>
<h1>Before and after, judged by ear</h1><p>Each pair plays at matched loudness, so you hear quality rather than volume. Switching keeps the playback position. All recordings are synthetic test fixtures (no real recordings were supplied).</p>
<h2>Listening checklist</h2><ul>${['Hiss is gone', 'Room echo is gone', 'S sounds are not harsh', 'Breaths are kept, only softened', 'No underwater or robotic tone', 'No pumping between phrases', 'No chopped word endings', 'Volume is even'].map((c) => `<li><label><input type="checkbox"> ${c}</label></li>`).join('')}</ul>
${rows.map((r) => `<section data-before="${r.before}" data-after="${r.after}"><h2>${r.name}</h2><p><small>Before ${r.before.toFixed(1)} LUFS → after ${r.after.toFixed(1)} LUFS. Auto: ${r.reasons.join('; ')}.${r.guard.length ? ' ' + r.guard.join(' ') : ''}</small></p>
<p><button data-v="before">Before</button> <button data-v="after" aria-pressed="true">After</button> <button data-play>Play / pause</button></p>
<audio preload="auto" src="listen/${r.slug}-before.wav"></audio><audio preload="auto" src="listen/${r.slug}-after.wav"></audio>
<div class="g"><figure><img src="listen/${r.slug}-before.png" alt="Spectrogram before"><figcaption><small>Before</small></figcaption></figure><figure><img src="listen/${r.slug}-after.png" alt="Spectrogram after"><figcaption><small>After</small></figcaption></figure></div></section>`).join('')}
<script>
for (const s of document.querySelectorAll('section[data-before]')) {
  const [b, a] = s.querySelectorAll('audio'); const d = +s.dataset.after - +s.dataset.before;
  a.volume = d > 0 ? Math.pow(10, -d / 20) : 1; b.volume = d < 0 ? Math.pow(10, d / 20) : 1; let cur = a;
  s.querySelectorAll('[data-v]').forEach((btn) => btn.onclick = () => { const next = btn.dataset.v === 'after' ? a : b; if (next === cur) return; const t = cur.currentTime, p = !cur.paused; cur.pause(); next.currentTime = t; if (p) next.play(); cur = next; s.querySelectorAll('[data-v]').forEach((x) => x.setAttribute('aria-pressed', x === btn)); });
  s.querySelector('[data-play]').onclick = () => (cur.paused ? cur.play() : cur.pause());
}
</script></html>`;
fs.writeFileSync(new URL('./report/listen.html', import.meta.url), html); console.log('listen.html with', rows.length, 'pairs');
