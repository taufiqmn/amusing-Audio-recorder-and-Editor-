// Objective checks for the Studio engine (feature IDs A1–A7 engine side, B4 seams).
// Every check records its measured value; results go to tests/report/engine-results.json.
import fs from 'node:fs';
import os from 'node:os';
import { enhance, FS, MUSICAL_MAX, noiseProfileFrom, Chain } from '../public/studio/js/engine/chain.js';
import { Analyzer, loudnessOf, naturalness, estimateRT60 } from '../public/studio/js/engine/analyze.js';
import { truePeak } from '../public/studio/js/engine/stages.js';
import createRN from '../public/studio/js/vendor/rnnoise.js';
import * as F from './fixtures.mjs';

const Module = await createRN({ wasmBinary: fs.readFileSync(new URL('../public/studio/js/vendor/rnnoise.wasm', import.meta.url)) });
const results = []; let fails = 0;
const check = (id, name, ok, measured, threshold) => { results.push({ id, name, pass: !!ok, measured, threshold }); if (!ok) fails++; console.log(`  ${ok ? '✓' : '✗'} [${id}] ${name}: ${measured} (need ${threshold})`); };

export async function run(chs, opts = {}, block = 9600) {
  const n = chs[0].length; const out = { main: chs.map(() => new Float32Array(n)), speech: chs.map(() => new Float32Array(n)), background: chs.map(() => new Float32Array(n)) }; let o = 0;
  const open = async function* () { for (let i = 0; i < n; i += block) yield chs.map((c) => c.slice(i, Math.min(n, i + block))); };
  const rep = await enhance({ open, nCh: chs.length, Module, totalSamples: n, ...opts, sink: (b) => { const m = b.main[0].length; b.main.forEach((c, k) => out.main[k].set(c, o)); if (b.speech) { b.speech.forEach((c, k) => out.speech[k].set(c, o)); b.background.forEach((c, k) => out.background[k].set(c, o)); } o += m; } });
  rep.written = o; return { out: out.main, speech: out.speech, background: out.background, rep };
}
// SI-SDR reference: the clean voice through the chain's own linear filters (DC, hum notch, tone EQ).
// Those filters are intentional and phase-shift the fundamental, which SI-SDR would otherwise punish.
const refFor = (rep, sig) => new Chain(null, 1, rep.params).linearRef([sig])[0];
// tone and dynamics neutral: measures noise removal itself
const NOISE_ONLY = { clarity: 0, warmth: 0, deess: 0, evening: 0, echo: 0, background: 0, hp: 60 };

console.log('Studio engine');
const { x: clean, mask } = F.cleanSpeech(FS, 20, 3);
const N = clean.length;

/* ---- Noise reduction (SI-SDR) and noise floor ---- */
const noises = { hiss: F.white(N, 5), hum: F.hum(N, FS, 50), fan: F.fan(N, FS) };
const sdrRows = [];
for (const [name, nz] of Object.entries(noises)) for (const snr of [0, 5, 10]) {
  const x = F.addNoise(clean, mask, nz, snr);
  const { out, rep } = await run([x], { preset: 'podcast', controls: NOISE_ONLY });
  const ref = refFor(rep, clean); const before = F.siSdr(ref, x), after = F.siSdr(ref, out[0]);
  sdrRows.push({ name, snr, before, after, gain: after - before, speed: rep.duration / rep.seconds });
  check('A1/NR', `SI-SDR gain, ${name} @${snr} dB`, after - before >= 6, `${before.toFixed(1)} → ${after.toFixed(1)} dB (+${(after - before).toFixed(1)})`, '≥ +6 dB');
}
for (const [name, nz, snr] of [['hiss', noises.hiss, 10], ['fan', noises.fan, 5], ['hum', noises.hum, 5]]) {
  const x = F.addNoise(clean, mask, nz, snr);
  const { out } = await run([x], { preset: 'podcast' });
  const b = F.gapLevels(x, mask, FS), a = F.gapLevels(out[0], mask, FS);
  const drop = (b.speech - b.gap) - (a.speech - a.gap) ; // negative = gap fell relative to speech
  check('A1/FLOOR', `noise floor in pauses (relative to speech), ${name} @${snr} dB, Podcast`, -drop >= 15, `${(-drop).toFixed(1)} dB lower`, '≥ 15 dB');
}

/* ---- Room echo ---- */
for (const rt of [0.4, 0.8, 1.2]) {
  const x = F.reverb(clean, FS, rt, 0.8);
  const { out } = await run([x], { preset: 'lecture' });
  const an = (s) => { const a = new Analyzer(1, FS); a.process([s]); return a.result().rt60; };
  const before = an(x), after = an(out[0]); const nat = naturalness(clean, out[0], FS);
  check('A3/ECHO', `estimated RT60 reduction, RT60 ${rt} s fixture`, (before - after) / before >= 0.3, `${before.toFixed(2)} → ${after.toFixed(2)} s (−${(100 * (before - after) / before).toFixed(0)}%)`, '≥ 30% lower');
  check('A3/ECHO', `voice-band correlation to dry reference, RT60 ${rt} s`, nat.corr >= 0.85, nat.corr.toFixed(3), '≥ 0.85');
}

/* ---- Naturalness in Auto ---- */
const autoFixtures = { 'hiss 10 dB': F.addNoise(clean, mask, noises.hiss, 10), 'fan 5 dB': F.addNoise(clean, mask, noises.fan, 5), 'pink 5 dB': F.addNoise(clean, mask, F.pink(N), 5), 'babble 10 dB': F.addNoise(clean, mask, F.babble(N, FS), 10), 'reverb 0.8 s': F.reverb(clean, FS, 0.8, 0.8), clean };
const autoReports = {};
for (const [name, x] of Object.entries(autoFixtures)) {
  const { out, rep } = await run([x], { preset: 'auto' });
  const nat = naturalness(clean, out[0], FS); autoReports[name] = { rep, nat };
  check('A2/NAT', `Auto naturalness vs clean, ${name}`, nat.corr >= 0.9 && nat.musical <= MUSICAL_MAX, `corr ${nat.corr.toFixed(3)}, musical ${nat.musical.toFixed(2)}/s${rep.guard.length ? ' (guard: ' + rep.guard.join(' ') + ')' : ''}`, `corr ≥ 0.9, musical ≤ ${MUSICAL_MAX}/s`);
  check('A4/LOUD', `Auto loudness on target, ${name}`, Math.abs(rep.after.loudness - -16) <= 0.5, `${rep.after.loudness.toFixed(2)} LUFS`, '−16 ± 0.5');
}

/* ---- Null test ---- */
{
  const x = F.addNoise(clean, mask, noises.hiss, 10);
  const { out } = await run([x], { preset: 'podcast', controls: { strength: 0 } });
  let e = 0, r = 0; for (let i = 0; i < N; i++) { e += (out[0][i] - x[i]) ** 2; r += x[i] ** 2; }
  const db = 10 * Math.log10(e / r + 1e-30);
  check('A3/NULL', 'strength 0 returns the input', db <= -90, `${db === -300 ? '−∞' : db.toFixed(1)} dB`, '≤ −90 dB');
}

/* ---- Loudness, true peak, safety, length for every preset ---- */
const presets = ['podcast', 'interview', 'youtube', 'lecture', 'audiobook', 'phone', 'singing', 'music'];
const loudX = F.gainDb(F.addNoise(clean, mask, noises.fan, 15), -8);
for (const p of presets) {
  const { out, rep } = await run([loudX], { preset: p });
  const tp = 20 * Math.log10(truePeak(out[0]));
  check('A3/LUFS', `loudness on target, ${p}`, Math.abs(rep.after.loudness - rep.params.target) <= 0.5, `${rep.after.loudness.toFixed(2)} (target ${rep.params.target})`, '± 0.5 LU');
  check('A3/TP', `true peak at or under ceiling, ${p}`, tp <= rep.params.ceiling + 0.1, `${tp.toFixed(2)} dBTP (ceiling ${rep.params.ceiling})`, '≤ ceiling + 0.1 dB');
  const dc = Math.abs(out[0].reduce((a, v) => a + v, 0) / N);
  check('SAFE', `finite output, DC, length, ${p}`, rep.nonFinite === 0 && dc < 0.001 && rep.written === N, `NaN/Inf ${rep.nonFinite}, DC ${dc.toExponential(1)}, length ${rep.written}/${N}`, 'no NaN, DC < 0.001, same length');
}

/* ---- Stereo: balance, dual mono ---- */
{
  const L = F.addNoise(clean, mask, noises.hiss, 10), Rr = F.gainDb(F.addNoise(clean, mask, F.white(N, 77), 10), -3);
  const { out, rep } = await run([L, Rr], { preset: 'podcast' });
  const bal = (c) => 10 * Math.log10(c[0].reduce((a, v) => a + v * v, 0) / c[1].reduce((a, v) => a + v * v, 0));
  check('SAFE', 'stereo balance preserved', Math.abs(bal(out) - bal([L, Rr])) <= 0.5, `${bal([L, Rr]).toFixed(2)} → ${bal(out).toFixed(2)} dB`, 'within 0.5 dB');
  const { rep: r2, out: o2 } = await run([L, Float32Array.from(L)], { preset: 'podcast' });
  let same = true; for (let i = 0; i < N; i++) if (o2[0][i] !== o2[1][i]) { same = false; break; }
  check('A1/STEREO', 'dual-mono detected and processed once', r2.analysis.dualMono && same, `detected ${r2.analysis.dualMono}, identical output ${same}`, 'detected, identical');
}

/* ---- Clipping repair, hum/DC/bandwidth analysis ---- */
{
  const x = F.clip(F.gainDb(clean, 14), 0.5);
  const a = new Analyzer(1, FS); a.process([x]); const A = a.result();
  const { out, rep } = await run([x], { preset: 'podcast' });
  const newClip = out[0].filter((v) => Math.abs(v) >= 0.999).length;
  check('REPAIR', 'clipped input: detected, repaired, no new clipping', A.clipping > 100 && rep.stats.repair.clipsFixed > 50 && newClip === 0, `clip runs fixed ${rep.stats.repair.clipsFixed}, output samples ≥ 0 dBFS ${newClip}`, 'repaired, 0 clipped');
  const sh = F.addNoise(clean, mask, noises.hum, 5); const b = new Analyzer(1, FS); b.process([sh]);
  const s6 = F.addNoise(clean, mask, F.hum(N, FS, 60), 5); const c = new Analyzer(1, FS); c.process([s6]);
  check('ANALYSE', 'hum frequency detected', b.result().humHz === 50 && c.result().humHz === 60, `${b.result().humHz} Hz / ${c.result().humHz} Hz`, '50 / 60');
  const ph = F.phoneBand(clean, FS); const d = new Analyzer(1, FS); d.process([F.addNoise(ph, mask, F.white(N, 3), 30)]);
  check('ANALYSE', 'phone bandwidth detected', d.result().bandwidthHz < 5500 && d.result().bandwidthHz > 3000, `${d.result().bandwidthHz} Hz`, '3–5.5 kHz');
  const dcx = F.addDC(clean, 0.05); const { out: od } = await run([dcx], { preset: 'podcast' });
  const dcOut = Math.abs(od[0].reduce((s, v) => s + v, 0) / N);
  check('REPAIR', 'DC offset removed', dcOut < 0.001, dcOut.toExponential(2), '< 0.001');
  const low = F.gainDb(F.addNoise(clean, mask, noises.hiss, 20), -40 - F.rmsDb(clean, mask) + -20 + 20);
  const { rep: rl } = await run([low], { preset: 'auto' });
  check('A2/LOW', 'very low level (−40 dBFS) brought to target', Math.abs(rl.after.loudness + 16) <= 0.5, `${rl.before.loudness.toFixed(1)} → ${rl.after.loudness.toFixed(2)} LUFS`, '−16 ± 0.5');
}

/* ---- Repeat damage ---- */
{
  const x = F.addNoise(clean, mask, noises.hiss, 5);
  const { out: o1, rep: r1 } = await run([x], { preset: 'podcast', controls: NOISE_ONLY });
  const { out: o2 } = await run(o1, { preset: 'podcast', controls: NOISE_ONLY });
  const ref1 = refFor(r1, clean), ref2 = refFor(r1, ref1);
  const s1 = F.siSdr(ref1, o1[0]), s2 = F.siSdr(ref2, o2[0]);
  check('REPEAT', 'enhancing twice costs at most 1 dB SI-SDR', s1 - s2 <= 1, `${s1.toFixed(2)} → ${s2.toFixed(2)} dB`, '≤ 1 dB loss');
}

/* ---- Chunk seams: block size must not matter ---- */
{
  const x = F.addNoise(clean, mask, noises.fan, 5);
  const big = await run([x], { preset: 'podcast' }, N);
  const small = await run([x], { preset: 'podcast' }, 1234);
  const win = await run([x], { preset: 'podcast' }, 48000 * 7 + 13);
  const diff = (a, b) => { let e = 0, r = 0; for (let i = 0; i < N; i++) { e += (a[i] - b[i]) ** 2; r += a[i] ** 2; } return 10 * Math.log10(e / r + 1e-30); };
  const d1 = diff(big.out[0], small.out[0]), d2 = diff(big.out[0], win.out[0]);
  check('B4/SEAM', 'chunked (1234 / 7 s blocks) vs one-shot', d1 <= -50 && d2 <= -50, `${d1.toFixed(1)} / ${d2.toFixed(1)} dB`, '≤ −50 dB');
  // compare the sample jumps at each 7 s block boundary with the one-shot render at the same place
  const B = 48000 * 7 + 13; let worst = 0;
  for (let k = 1; k * B < N; k++) for (let i = k * B - 2; i <= k * B + 2; i++) {
    const jc = Math.abs(win.out[0][i] - win.out[0][i - 1]), j1 = Math.abs(big.out[0][i] - big.out[0][i - 1]);
    worst = Math.max(worst, jc / Math.max(j1, 1e-9));
  }
  check('B4/SEAM', 'sample jump at chunk boundaries vs the same place rendered in one piece', worst <= 1.5, `${worst.toFixed(3)}×`, '≤ 1.5×');
}

/* ---- Stems ---- */
{
  const x = F.addNoise(clean, mask, noises.fan, 5);
  const { speech, background, rep } = await run([x], { preset: 'podcast', controls: NOISE_ONLY, stems: true });
  const ref = refFor(rep, clean); const sp = F.siSdr(ref, speech[0]); const bgCorr = F.siSdr(noises.fan, background[0]);
  check('A5/STEMS', 'speech stem is clean speech; background stem is the noise', sp > F.siSdr(ref, x) + 6 && bgCorr > 0, `speech SI-SDR ${sp.toFixed(1)} dB, background vs true noise SI-SDR ${bgCorr.toFixed(1)} dB`, 'speech +6 dB over input, background > 0 dB');
}

/* ---- Noise sample (A6) ---- */
{
  const x = F.addNoise(clean, mask, F.pink(N, 41), 0);
  const quiet = []; for (let i = 0; i < N && quiet.length < FS * 0.8; i++) if (!mask[i]) quiet.push(x[i]);
  const prof = noiseProfileFrom(Module, [Float32Array.from(quiet)]);
  const a = await run([x], { preset: 'podcast', controls: NOISE_ONLY });
  const b = await run([x], { preset: 'podcast', controls: NOISE_ONLY, noiseProfile: prof });
  const ga = F.gapLevels(a.out[0], mask, FS), gb = F.gapLevels(b.out[0], mask, FS);
  check('A6/PROFILE', 'learned noise sample lowers remaining noise further', (gb.speech - gb.gap) > (ga.speech - ga.gap) + 3, `pause level ${(ga.gap - ga.speech).toFixed(1)} → ${(gb.gap - gb.speech).toFixed(1)} dB rel. speech`, '≥ 3 dB extra');
}

/* ---- Speed ---- */
const sp = sdrRows.map((r) => r.speed); const speed = sp.reduce((a, b) => a + b) / sp.length;
check('SPEED', 'Standard tier speed (analysis + 2 passes, 1 thread)', speed >= 2, `${speed.toFixed(1)}× real time on ${os.cpus()[0].model.trim()}`, '≥ 2×');

fs.mkdirSync(new URL('./report/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./report/engine-results.json', import.meta.url), JSON.stringify({ results, sdrRows, auto: Object.fromEntries(Object.entries(autoReports).map(([k, v]) => [k, { reasons: v.rep.reasons, guard: v.rep.guard, strength: v.rep.strengthUsed, analysis: v.rep.analysis, nat: v.nat }])) }, null, 1));
console.log(fails ? `\n${fails} engine check(s) failed` : '\nAll engine checks passed');
process.exitCode = fails ? 1 : 0;
