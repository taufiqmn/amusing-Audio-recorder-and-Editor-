import { Timeline, computePeaks } from '../public/js/engine.js';
import { check } from './helpers.mjs';

console.log('Timeline engine');
const sr = 1000;
const ramp = (n, off = 0) => Float32Array.from({ length: n }, (_, i) => (i + off) / 10000);
const tl = new Timeline(sr); tl.crossfadeMs = 0;
const a = tl.addSource(ramp(1000));
tl.placeTake(a, 0, 'replace-end');
check(tl.length === 1000, 'first take placed');

// cut a middle section
tl.deleteRange(200, 300);
check(tl.length === 900 && tl.clips.length === 2, 'delete range splits into two clips');
let r = tl.render();
check(Math.abs(r[199] - 0.0199) < 1e-6 && Math.abs(r[200] - 0.03) < 1e-6, 'audio after the cut joins correctly');

// punch-in: replace from 500 to end
const b = tl.addSource(new Float32Array(300).fill(0.5));
const end = tl.placeTake(b, 500, 'replace-end');
check(tl.length === 800 && end === 800, 'replace-to-end drops old audio after punch point');
r = tl.render(); check(r[499] !== 0.5 && r[500] === 0.5 && r[799] === 0.5, 'new take starts exactly at punch point');

// insert
const c = tl.addSource(new Float32Array(50).fill(-0.5));
tl.placeTake(c, 100, 'insert');
check(tl.length === 850 && tl.render()[100] === -0.5 && tl.render()[150] === r[100], 'insert pushes later audio right');

// overwrite
const beforeOw = Float32Array.from(tl.render());
const d = tl.addSource(new Float32Array(20).fill(0.25));
tl.placeTake(d, 0, 'overwrite');
const ow = tl.render();
check(tl.length === 850 && ow[19] === 0.25 && ow[20] === beforeOw[20] && ow[849] === beforeOw[849], 'overwrite replaces only the take length');

// replace selection with shorter take
const e = tl.addSource(new Float32Array(10).fill(0.9));
tl.placeTake(e, 200, 'replace-range', 400);
check(tl.length === 850 - 200 + 10, 'replace selection: selection swapped for new take');

// undo / redo chain
const lenBefore = tl.length;
tl.undo(); check(tl.length === 850, 'undo restores previous edit');
tl.redo(); check(tl.length === lenBefore, 'redo re-applies edit');
let n = 0; while (tl.undo()) n++;
check(tl.length === 0 && n === 6, `undo all ${n} steps back to empty`);
while (tl.redo()); check(tl.length === lenBefore, 'redo all steps');
tl.deleteRange(0, 10); check(!tl.canRedo, 'new edit clears redo history');

// keep range
tl.keepRange(100, 200); check(tl.length === 100, 'keep selection crops timeline');

// contiguous merge
{
  const t2 = new Timeline(sr); t2.crossfadeMs = 0; const s = t2.addSource(ramp(100));
  t2.placeTake(s, 0, 'replace-end'); t2.deleteRange(10, 20); t2.undo();
  check(t2.clips.length === 1, 'undo returns to a single merged clip');
}

// crossfades are click-free and length-preserving
{
  const t3 = new Timeline(48000); t3.crossfadeMs = 6;
  const s1 = t3.addSource(Float32Array.from({ length: 48000 }, (_, i) => Math.sin(2 * Math.PI * 440 * i / 48000)));
  const s2 = t3.addSource(Float32Array.from({ length: 48000 }, (_, i) => Math.sin(2 * Math.PI * 440 * i / 48000 + Math.PI)));
  t3.placeTake(s1, 0, 'replace-end'); t3.placeTake(s2, 24000, 'replace-end');
  const y = t3.render(); let maxJump = 0;
  for (let i = 1; i < y.length; i++) maxJump = Math.max(maxJump, Math.abs(y[i] - y[i - 1]));
  check(y.length === 72000, 'crossfade does not change length');
  check(maxJump < 0.07, `splice has no click (max sample jump ${maxJump.toFixed(3)}, tone step 0.058)`);
}

// long pause finder
{
  const t4 = new Timeline(1000); t4.crossfadeMs = 0;
  const x = new Float32Array(10000);
  for (let i = 0; i < 10000; i++) { const t = i / 1000; const talk = t < 2 || (t > 5 && t < 6) || t > 6.5; x[i] = talk ? 0.3 * Math.sin(i) : 0.0001 * Math.sin(i * 7); }
  const s = t4.addSource(x); t4.placeTake(s, 0, 'replace-end');
  const ranges = t4.findLongPauses({ maxPauseSec: 1, keepSec: 0.5 });
  check(ranges.length === 1, `finds only the long pause (${ranges.length} found)`);
  t4.deleteRanges(ranges, 'Shorten pauses');
  check(Math.abs(t4.length - (10000 - 2500)) < 30, `3 s pause shortened to 0.5 s (new length ${t4.length})`);
}

// peaks
{
  const p = computePeaks(Float32Array.from([0.1, -0.2, 0.3, -0.4, 0.5]), 2);
  check(p.length === 6 && p[1] === Math.fround(0.1) && p[2] === Math.fround(-0.4), 'waveform peaks computed per bucket');
}
