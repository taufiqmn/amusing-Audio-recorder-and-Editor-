// One job at a time: decode/stream → enhance or convert → encode. The pool terminates this
// worker to cancel, which frees all its memory at once.
import '../io/encoders-core.js';
import { enhance, FS } from '../engine/chain.js';
import { Analyzer, BlendMeter, spectrogram } from '../engine/analyze.js';
import { TruePeakLimiter, dbToGain } from '../engine/stages.js';
import createRN from '../vendor/rnnoise.js';
import { readHeader, pcmBlocks, StreamResampler, WavWriter, Mp3Writer, FlacWriter, WebCodecsWriter } from '../io/io.js';

let rnP = null, lameP = null;
const rnnoise = () => (rnP ??= fetch(new URL('../vendor/rnnoise.wasm', import.meta.url)).then((r) => { if (!r.ok) throw new Error('The noise-removal model could not be loaded.'); return r.arrayBuffer(); }).then((b) => createRN({ wasmBinary: b })));
const lame = () => (lameP ??= import('../vendor/lame.mjs').then((m) => m.default));

const post = (m, t) => self.postMessage(m, t || []);

/** Streaming pause shortener (auto cut): pauses longer than maxSec become keepSec. */
class PauseTrimmer {
  constructor(nCh, fs, { maxSec = 0.8, keepSec = 0.4, thrDb = -60 } = {}) {
    this.nCh = nCh; this.win = Math.round(0.01 * fs); this.max = Math.round(maxSec * fs); this.half = Math.round((keepSec / 2) * fs); this.thr = Math.pow(10, thrDb / 10);
    this.q = []; this.qLen = 0; this.removed = 0; this.cuts = 0; this.floor = -60; this.loud = -30; this.carry = Array.from({ length: nCh }, () => new Float32Array(0));
  }
  process(chs) {
    const all = chs.map((c, i) => { const b = new Float32Array(this.carry[i].length + c.length); b.set(this.carry[i]); b.set(c, this.carry[i].length); return b; });
    const n = Math.floor(all[0].length / this.win) * this.win; this.carry = all.map((c) => c.slice(n)); const out = [];
    for (let s = 0; s < n; s += this.win) {
      const seg = all.map((c) => c.subarray(s, s + this.win)); let e = 0; for (const c of seg) for (const v of c) e += v * v;
      // silence is judged relative to this recording: near its noise floor and well below its speech
      const db = 10 * Math.log10(e / (this.win * this.nCh) + 1e-20);
      this.floor = db < this.floor ? db : this.floor + 0.02; this.loud = db > this.loud ? db : this.loud - 0.01;
      const silent = db < Math.min(this.loud - 22, Math.max(this.floor + 10, -70)) || e / (this.win * this.nCh) < this.thr;
      if (silent) { this.q.push(seg.map((c) => Float32Array.from(c))); this.qLen += this.win; }
      else { out.push(...this._flushPause()); out.push(seg); }
    }
    return join(out, this.nCh);
  }
  _flushPause() {
    if (!this.q.length) return [];
    let res = this.q;
    if (this.qLen > this.max) { const k = Math.ceil(this.half / this.win); res = [...this.q.slice(0, k), ...this.q.slice(-k)]; this.removed += this.qLen - res.length * this.win; this.cuts++; }
    this.q = []; this.qLen = 0; return res;
  }
  flush() { const r = this._flushPause(); r.push(this.carry); return join(r, this.nCh); }
}
function join(list, nCh) { const n = list.reduce((a, s) => a + s[0].length, 0); const o = Array.from({ length: nCh }, () => new Float32Array(n)); let p = 0; for (const s of list) { for (let c = 0; c < nCh; c++) o[c].set(s[c], p); p += s[0].length; } return o; }

function makeWriter(fmt, fs, nCh, o) {
  if (fmt === 'wav') return new WavWriter(fs, nCh, o.bits || 24);
  if (fmt === 'flac') return new FlacWriter(fs, nCh, Math.min(24, o.bits || 24));
  if (fmt === 'mp3') return lame().then((l) => new Mp3Writer(l, fs, nCh, o.kbps || 192));
  if (fmt === 'opus' || fmt === 'ogg') return new WebCodecsWriter('opus', 48000, nCh, o.kbps || 96, o.tags);
  if (fmt === 'm4a') return new WebCodecsWriter('aac', fs, nCh, o.kbps || 160, o.tags);
  throw new Error('Unknown format ' + fmt);
}
const outRate = (fmt, o, inRate) => (fmt === 'opus' || fmt === 'ogg' ? 48000 : fmt === 'mp3' && ![32000, 44100, 48000].includes(o.rate || inRate) ? 48000 : o.rate || inRate);

/** Output path: channel conversion → resample → (auto cut) → writer. */
class Output {
  constructor(fmt, o, nOut, inRate) { this.fmt = fmt; this.o = o; this.nOut = nOut; this.rate = outRate(fmt, o, inRate); this.rs = new StreamResampler(FS, this.rate, nOut); this.trim = o.autocut ? new PauseTrimmer(nOut, this.rate, { thrDb: o.autocutThr ?? -60 }) : null; this.frames = 0; }
  async init() { this.w = await makeWriter(this.fmt, this.rate, this.nOut, this.o); return this; }
  async write(chs, final = false) {
    let c = chs.length === this.nOut ? chs : this.nOut === 1 ? [chs.length === 1 ? chs[0] : chs[0].map((v, i) => (v + chs[1][i]) / 2)] : [chs[0], chs[0]];
    c = this.rs.process(c, final); if (this.trim) { c = this.trim.process(c); if (final) { const f = this.trim.flush(); c = join([c, f], this.nOut); } }
    if (c[0].length) { this.frames += c[0].length; await this.w.write(c); }
  }
  async finish() { await this.write(Array.from({ length: this.nOut }, () => new Float32Array(0)), true); return this.w.finish(this.o.tags || {}); }
}

async function source(src) {
  if (src.pcm) { const chs = src.pcm, n = chs[0].length; return { nCh: chs.length, total: n, rate: src.rate || FS, open: async function* () { for (let i = 0; i < n; i += 24000) yield chs.map((c) => c.subarray(i, Math.min(n, i + 24000))); } }; }
  const h = await readHeader(src.file); if (!h) throw new Error('This file type needs to be decoded first.');
  if (!h.frames) throw new Error('This file contains no audio.');
  return { nCh: h.ch, total: Math.round((h.frames * FS) / h.fs), rate: h.fs, open: () => pcmBlocks(src.file, h, FS) };
}

function peaks(list, buckets = 400) { // list: mono Float32 chunks
  const n = list.reduce((a, c) => a + c.length, 0); const per = Math.max(1, Math.ceil(n / buckets)); const out = new Float32Array(Math.ceil(n / per)); let i = 0;
  for (const c of list) for (const v of c) { const k = Math.floor(i++ / per); const a = Math.abs(v); if (a > out[k]) out[k] = a; }
  return out;
}

class Preview { // keeps waveform peaks for the whole file and up to 60 s of mono audio for spectrograms
  constructor(total) { this.per = Math.max(1, Math.ceil(total / 400)); this.pk = new Float32Array(401); this.i = 0; this.keep = []; this.kept = 0; }
  add(chs) { const m = chs[0]; for (let j = 0; j < m.length; j++) { const k = Math.floor(this.i++ / this.per); const a = Math.abs(chs.length > 1 ? (m[j] + chs[1][j]) / 2 : m[j]); if (k < 401 && a > this.pk[k]) this.pk[k] = a; }
    if (this.kept < 60 * FS) { const t = Math.min(m.length, 60 * FS - this.kept); this.keep.push(Float32Array.from(m.subarray(0, t))); this.kept += t; } }
  spec() { const a = new Float32Array(this.kept); let o = 0; for (const c of this.keep) { a.set(c, o); o += c.length; } return spectrogram(a, FS, { cols: 480, rows: 120 }); }
}

async function runEnhance(job, src) {
  const o = job.opts; const Module = o.controls?.tier === 'fast' || (o.controls?.noise ?? 100) > 0 ? await rnnoise() : null;
  const nOut = o.channels === 'mono' ? 1 : o.channels === 'stereo' ? 2 : src.nCh;
  const main = await new Output(o.format, o, nOut, src.rate).init();
  const stems = o.stems ? { speech: await new Output(o.format, { ...o, autocut: false }, nOut, src.rate).init(), background: await new Output(o.format, { ...o, autocut: false }, nOut, src.rate).init() } : null;
  const pin = new Preview(src.total), pout = new Preview(src.total); let last = 0;
  const open = async function* () { for await (const b of src.open()) { if (!pin.done) pin.add(b); yield b; } pin.done = true; };
  const rep = await enhance({ open, nCh: src.nCh, Module, totalSamples: src.total, preset: o.preset, controls: o.controls, noiseProfile: o.noiseProfile ? Float64Array.from(o.noiseProfile) : null, stems: !!o.stems, guard: true,
    onProgress: (stage, f) => { const now = performance.now(); if (now - last > 150) { last = now; post({ id: job.id, type: 'progress', stage, value: f }); } },
    sink: async (b) => { pout.add(b.main); await main.write(b.main); if (stems) { await stems.speech.write(b.speech); await stems.background.write(b.background); } } });
  post({ id: job.id, type: 'progress', stage: 'Encoding', value: 1 });
  const blob = await main.finish();
  const res = { id: job.id, type: 'done', blob, rate: main.rate, channels: nOut, frames: main.frames, report: rep, cuts: main.trim ? { cuts: main.trim.cuts, removedSec: main.trim.removed / main.rate } : null,
    peaksIn: pin.pk, peaksOut: pout.pk, specIn: pin.spec(), specOut: pout.spec() };
  if (stems) { res.speech = await stems.speech.finish(); res.background = await stems.background.finish(); }
  post(res);
}

async function runConvert(job, src) {
  const o = job.opts; const nOut = o.channels === 'mono' ? 1 : o.channels === 'stereo' ? 2 : src.nCh;
  let gain = 1, start = 0, end = src.total, lim = null; const meter = new BlendMeter(src.nCh, FS);
  const layout = (b) => (nOut === b.length ? b : nOut === 1 ? [b[0].map((v, i) => (v + b[1][i]) / 2)] : [b[0], b[0]]);
  const meterOut = new BlendMeter(nOut, FS);
  if (o.normalize || o.trim) {
    const W = Math.round(0.05 * FS); const frames = []; let acc = 0, cnt = 0, done = 0;
    for await (const b of src.open()) {
      meter.process(b); meterOut.process(layout(b));
      for (let i = 0; i < b[0].length; i++) { let v = 0; for (const c of b) v += c[i] * c[i]; acc += v / b.length; if (++cnt === W) { frames.push(10 * Math.log10(acc / W + 1e-20)); acc = 0; cnt = 0; } }
      done += b[0].length; post({ id: job.id, type: 'progress', stage: 'Measuring', value: done / src.total });
    }
    if (o.trim && frames.length) {
      // "silence" = within 12 dB of the measured noise floor, so noisy recordings trim too
      const floor = Float32Array.from(frames).sort()[Math.floor(frames.length * 0.1)]; const thr = Math.max(floor + 12, -70);
      const first = frames.findIndex((v) => v > thr); let last = frames.length - 1; while (last > 0 && frames[last] <= thr) last--;
      if (first >= 0) { start = Math.max(0, first * W - Math.round(0.05 * FS)); end = Math.min(done, (last + 1) * W + Math.round(0.15 * FS)); }
    }
    const L = meterOut.loudness(); if (o.normalize && isFinite(L)) { gain = dbToGain((o.target ?? -16) - L); lim = new TruePeakLimiter(src.nCh, FS, { ceilingDb: o.ceiling ?? -1 }); }
  }
  const out = await new Output(o.format, o, nOut, src.rate).init();
  const pin = new Preview(src.total); let pos = 0, skip = lim ? lim.latency : 0, written = 0; const want = end - start;
  const emit = async (chs) => { if (skip) { const k = Math.min(skip, chs[0].length); skip -= k; chs = chs.map((c) => c.subarray(k)); } const rem = want - written; if (rem <= 0 || !chs[0].length) return; if (chs[0].length > rem) chs = chs.map((c) => c.subarray(0, rem)); written += chs[0].length; await out.write(chs); };
  for await (const b of src.open()) {
    const a = Math.max(0, start - pos), z = Math.min(b[0].length, end - pos); pos += b[0].length; if (z <= a) continue;
    let chs = b.map((c) => c.slice(a, z)); pin.add(chs);
    if (gain !== 1) chs = chs.map((c) => c.map((v) => v * gain)); if (lim) chs = lim.process(chs);
    await emit(chs); post({ id: job.id, type: 'progress', stage: 'Converting', value: pos / src.total });
  }
  if (lim) { let pad = lim.latency; while (pad > 0) { const m = Math.min(4800, pad); pad -= m; await emit(lim.process(Array.from({ length: src.nCh }, () => new Float32Array(m)))); } }
  const blob = await out.finish();
  post({ id: job.id, type: 'done', blob, rate: out.rate, channels: nOut, frames: out.frames, peaksIn: pin.pk, report: { before: { loudness: meter.EA.length ? meter.loudness() : null }, gainDb: 20 * Math.log10(gain), trimmedSec: (src.total - want) / FS } });
}

async function runAnalyse(job, src) {
  const a = new Analyzer(src.nCh, FS); for await (const b of src.open()) a.process(b);
  post({ id: job.id, type: 'done', analysis: a.result() });
}

self.onmessage = async (e) => {
  const job = e.data;
  try {
    const src = await source(job.src);
    if (job.mode === 'convert') await runConvert(job, src);
    else if (job.mode === 'analyse') await runAnalyse(job, src);
    else await runEnhance(job, src);
  } catch (err) {
    console.warn(err);
    post({ id: job.id, type: 'error', message: friendly(err) });
  }
};
function friendly(err) {
  const m = String(err?.message || err);
  if (/memory|allocation|Array buffer/i.test(m)) return 'The device ran out of memory for this file. Close other tabs, lower "files at once" to 1, and try again.';
  if (/AudioEncoder|codec|configure/i.test(m)) return 'This browser cannot write that format. Choose WAV, FLAC or MP3.';
  return m;
}
