// The enhancement chain and the two-pass streaming pipeline.
import { DCBlock, humNotch, Repair, Denoise, Spectral, toneEQ, DeEsser, Leveler, Compressor, Expander, TruePeakLimiter, Delay, FilterChain, bq, dbToGain, truePeak } from './stages.js';
import { Analyzer, BlendMeter, Naturalness } from './analyze.js';
import { autoControls, presetControls, stageParams, DEFAULTS } from './presets.js';
import { fft, sqrtHann } from './fft.js';

export const FS = 48000;
export const NATURAL_CORR_MIN = 0.9;   // voice-band correlation to the original
export const MUSICAL_MAX = 6;          // isolated tonal blips per second of pause (calibrated, docs/TUNING.md)

/** Builds the stage graph. process(chs) -> { D: dry aligned, W: processed speech, R: removed background (shaped) } */
export class Chain {
  constructor(Module, nCh, P, noiseProfile = null) {
    const fs = FS; this.P = P; this.stages = {};
    const full = P.tier !== 'fast';
    this.pre = [new DCBlock(nCh, fs)];
    if (P.humHz) this.pre.push(humNotch(nCh, fs, P.humHz));
    if (P.repair && full) { this.repair = new Repair(nCh, fs, { clipLevel: P.clipLevel }); this.pre.push(this.repair); }
    // Noise removal: log-MMSE spectral estimator (+ room echo + learned profile), then RNNoise for
    // non-stationary noise. Fast tier: RNNoise only.
    this.front = [];
    if (full && (P.denoise > 0 || P.echo > 0 || noiseProfile)) { this.spectral = new Spectral(nCh, fs, { rt60: P.rt60, echo: P.echo, noiseProfile, noise: noiseProfile ? 1 : 0, mmse: P.denoise, echoFloorDb: -12 }); this.front.push(this.spectral); }
    const rnAmt = full ? P.denoise * P.rnMix : P.denoise;
    if (Module && rnAmt > 0) { this.den = new Denoise(Module, nCh, rnAmt); this.front.push(this.den); }
    this.post = [];
    this.post.push(toneEQ(nCh, fs, { hp: P.hp, warmthDb: P.warmthDb, mudDb: P.mudDb, presenceDb: P.presenceDb, airDb: P.airDb }));
    if (P.deess > 0) this.post.push(new DeEsser(nCh, fs, { amount: P.deess }));
    const ref = Math.max(-40, Math.min(-16, P.speechDb)); // speech level the dynamics stages work around
    if (full && P.level > 0) this.post.push(new Leveler(nCh, fs, { refDb: ref, amount: P.level }));
    if (P.compRatio > 1.05) this.post.push(new Compressor(nCh, fs, { thresholdDb: ref + 4, ratio: P.compRatio, attackMs: 15, releaseMs: 100 }));
    if (P.gateDb > 0.5) this.post.push(new Expander(nCh, fs, { thresholdDb: ref - 26, rangeDb: P.gateDb, holdMs: 150, lookMs: 10 }));
    const preLat = this.pre.reduce((a, s) => a + s.latency, 0), denLat = this.front.reduce((a, s) => a + s.latency, 0), postLat = this.post.reduce((a, s) => a + s.latency, 0);
    this.frontDelay = new Delay(nCh, denLat);
    this.latency = preLat + denLat + postLat;
    this.dryDelay = new Delay(nCh, this.latency);
    this.resDelay = new Delay(nCh, postLat);
    this.resShape = new FilterChain([bq('highpass', fs, Math.max(40, P.hp), 0.7)], nCh);
    this.nCh = nCh;
  }
  process(chs) {
    const D = this.dryDelay.process(chs);
    let x = chs; for (const s of this.pre) x = s.process(x);
    // removed background = what went into noise removal minus what came out (time-aligned)
    const before = this.frontDelay.process(x);
    for (const s of this.front) { const r = s.process(x); x = r.speech || r; }
    const R = before.map((b, c) => { const o = new Float32Array(b.length), y = x[c]; for (let i = 0; i < b.length; i++) o[i] = b[i] - y[i]; return o; });
    for (const s of this.post) x = s.process(x);
    const Rraw = this.resDelay.process(R);
    const Rs = Rraw.map((c, i) => this.resShape.processChannel(c, i));
    return { D, W: x, R: Rs, Rraw };
  }
  free() { this.den?.free(); }
  /** The chain's purely linear filters (DC, hum notch, tone EQ) applied to x — the fair SI-SDR reference. */
  linearRef(chs) { let y = chs.map((c) => Float32Array.from(c)); for (const s of [...this.pre.filter((s) => !(s instanceof Repair)), ...this.post.filter((s) => s instanceof FilterChain)]) y = s.process(y); return y; }
}

/** Feed an async block source through fn (which has a fixed `latency`) and trim so output length == input length. */
async function* aligned(source, fn, latency, nCh, signal) {
  let skip = latency, total = 0, emitted = 0;
  function* emit(out, limit) {
    let o = out;
    if (skip > 0) { const k = Math.min(skip, o[0].length); skip -= k; o = o.map((c) => c.subarray(k)); }
    if (limit !== undefined) { const rem = limit - emitted; if (rem <= 0) return; if (o[0].length > rem) o = o.map((c) => c.subarray(0, rem)); }
    if (o[0].length) { emitted += o[0].length; yield o; }
  }
  for await (const blk of source) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    total += blk[0].length; yield* emit(fn(blk));
  }
  let padded = 0;
  while (emitted < total && padded <= latency + 4800) {
    const m = 4800; padded += m;
    yield* emit(fn(Array.from({ length: nCh }, () => new Float32Array(m))), total);
  }
}

/**
 * Two-pass enhancement.
 * opts: open() -> async iterable of Float32Array[] blocks at 48 kHz; nCh; preset; controls (overrides);
 *       Module (RNNoise); noiseProfile; analysis (optional); stems (bool); sink(blocks{main, speech?, background?}) ; onProgress(stage, frac); signal
 */
export async function enhance(opts) {
  const { open, Module, onProgress = () => {}, sink = () => {}, signal } = opts;
  let nCh = opts.nCh; const t0 = Date.now();
  // Pass 0: analysis
  let A = opts.analysis;
  if (!A) { const an = new Analyzer(nCh, FS); let done = 0; for await (const b of open()) { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); an.process(b); done += b[0].length; onProgress('Analysing', opts.totalSamples ? done / opts.totalSamples : 0); } A = an.result(); }
  const total = Math.round(A.duration * FS);
  const dual = nCh === 2 && A.dualMono; const work = dual ? 1 : nCh;
  const src = dual ? async function* () { for await (const b of open()) yield [b[0]]; } : open;
  let controls, reasons = [];
  if (opts.preset === 'auto') { const r = autoControls(A); controls = { ...r.controls, ...(opts.controls || {}), strength: opts.controls?.strength ?? 100 }; reasons = r.reasons; }
  else controls = { ...presetControls(opts.preset || 'podcast'), ...(opts.controls || {}) };
  const P = stageParams(controls, A);

  // Pass 1: measure loudness of every blend + naturalness
  const c1 = new Chain(Module, work, P, opts.noiseProfile || null);
  const meter = new BlendMeter(work, FS), meterW = new BlendMeter(work, FS), nat = new Naturalness(FS);
  let done = 0;
  for await (const blk of aligned(src(), (b) => mixY(c1.process(b), P.background), c1.latency, work, signal)) {
    const D = blk.slice(0, work), Y = blk.slice(work, 2 * work), W = blk.slice(2 * work, 3 * work);
    meter.process(D, Y); meterW.process(W); nat.process(D, Y); done += D[0].length; onProgress('Measuring', done / total);
  }
  const stats = { repair: c1.repair?.stats, echoRemovedDb: c1.spectral ? 10 * Math.log10(1 - c1.spectral.removedEnergy / (c1.spectral.totalEnergy || 1) + 1e-12) : 0 };
  c1.free();
  const N = nat.result(); let s = P.strength; const guard = [];
  if (opts.preset === 'auto' || opts.guard) {
    if (N.corr < NATURAL_CORR_MIN) { const ns = Math.max(0.5, s * (1 - (NATURAL_CORR_MIN - N.corr) * 4)); guard.push(`Reduced strength to ${Math.round(ns * 100)}% to keep the voice natural (voice match ${N.corr.toFixed(2)}).`); s = Math.min(s, ns); }
    if (N.musical > MUSICAL_MAX) { const ns = Math.max(0.5, s * 0.75); guard.push(`Reduced strength to ${Math.round(ns * 100)}% to avoid watery artifacts in pauses.`); s = Math.min(s, ns); }
  }
  const LD = meter.loudness(1, 0), LY = meter.loudness(0, 1), LW = meterW.loudness();
  const Ld = isFinite(LD) && isFinite(LY) ? Math.pow(dbToGain(LY - LD), s) : 1;
  const a = (1 - s) * Ld, b = s;
  const LM = meter.loudness(a, b);
  const G = s > 0 && isFinite(LM) ? dbToGain(s * (P.target - LM)) : 1;
  const Gs = isFinite(LW) ? dbToGain(P.target - LW) : 1;

  // Pass 2: render. Limiting lowers loudness a little on peaky material, so the final gain is
  // searched: on cached audio for shorter files, with one probe pass for long ones.
  const limOpts = { ceilingDb: P.ceiling }; const nPk = opts.stems ? 3 * work : work;
  const renderChain = async function* () {
    const c = new Chain(Module, work, P, opts.noiseProfile || null);
    try {
      yield* aligned(src(), (b2) => {
        const r = c.process(b2); const y = mixY(r, P.background); const n = b2[0].length;
        const m = y.D.map((d, ch) => { const o = new Float32Array(n), yy = y.Y[ch]; for (let i = 0; i < n; i++) o[i] = a * d[i] + b * yy[i]; return o; });
        return opts.stems ? [...m, ...r.W, ...r.Rraw] : m;
      }, c.latency, work, signal);
    } finally { c.free(); }
  };
  const scale = (chs, g) => chs.map((c) => { const o = new Float32Array(c.length); for (let i = 0; i < c.length; i++) o[i] = c[i] * g; return o; });
  const limitedLoudness = async (blocks, g) => {
    const l = new TruePeakLimiter(work, FS, limOpts), m = new BlendMeter(work, FS);
    for await (const blk of blocks) m.process(l.process(scale(blk.slice(0, work), g)));
    m.process(l.process(Array.from({ length: work }, () => new Float32Array(l.latency))));
    return m.loudness();
  };
  const CACHE_MAX = (opts.stems ? 4 : 10) * 60 * FS / work;
  let Gfinal = G, cache = null;
  if (s > 0 && isFinite(P.target)) {
    if (total <= CACHE_MAX) {
      cache = []; done = 0;
      for await (const blk of renderChain()) { cache.push(blk); done += blk[0].length; onProgress('Rendering', 0.5 * done / total); }
      const it = async function* () { for (const x of cache) yield x; };
      for (let k = 0; k < 4; k++) {
        const L = await limitedLoudness(it(), Gfinal);
        if (!isFinite(L) || Math.abs(L - P.target) < 0.12) break;
        Gfinal = Math.min(Gfinal * dbToGain(12), Gfinal * dbToGain((P.target - L) * 1.3));
      }
    } else {
      done = 0;
      const probe = async function* () { for await (const blk of renderChain()) { done += blk[0].length; onProgress('Checking loudness', done / total); yield blk; } };
      const L = await limitedLoudness(probe(), Gfinal);
      if (isFinite(L) && Math.abs(L - P.target) >= 0.12) Gfinal *= dbToGain(Math.min(6, (P.target - L) * 1.3));
    }
  }
  const lat0 = new TruePeakLimiter(work, FS, limOpts).latency;
  const Lo = s > 0 || opts.stems ? lat0 : 0;
  const lim = s > 0 ? new TruePeakLimiter(work, FS, limOpts) : (Lo ? new Delay(work, Lo) : null);
  const limS = opts.stems ? new TruePeakLimiter(work, FS, limOpts) : null, bgD = opts.stems ? new Delay(work, Lo) : null;
  const post = (blk) => {
    let m = scale(blk.slice(0, work), Gfinal); if (lim) m = lim.process(m);
    if (!opts.stems) return m;
    return [...m, ...limS.process(scale(blk.slice(work, 2 * work), Gs)), ...bgD.process(scale(blk.slice(2 * work, 3 * work), Gs))];
  };
  const source2 = cache ? (async function* () { for (const x of cache) yield x; })() : renderChain();
  const outMeter = new BlendMeter(work, FS); let tp = 0; let nonFinite = 0; done = 0;
  for await (const blk of aligned(source2, post, Lo, nPk, signal)) {
    const main = blk.slice(0, work);
    for (const ch of main) { for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) { ch[i] = 0; nonFinite++; } const t = truePeak(ch); if (t > tp) tp = t; }
    outMeter.process(main);
    const outBlk = { main: dual ? [main[0], main[0]] : main };
    if (opts.stems) { const sp = blk.slice(work, 2 * work), bg = blk.slice(2 * work, 3 * work); outBlk.speech = dual ? [sp[0], sp[0]] : sp; outBlk.background = dual ? [bg[0], bg[0]] : bg; }
    await sink(outBlk); done += main[0].length; onProgress('Rendering', cache ? 0.5 + 0.5 * done / total : done / total);
  }
  cache = null;
  const lat2 = Lo;
  const outL = outMeter.loudness();
  return {
    analysis: A, controls, params: P, reasons, guard, strengthUsed: s, naturalness: N, stats,
    before: { loudness: A.loudness, truePeakDb: A.truePeakDb }, after: { loudness: outL + (dual ? 10 * Math.log10(2) : 0), truePeakDb: 20 * Math.log10(tp + 1e-12) },
    outLoudnessPerChannelSet: outL, nonFinite, seconds: (Date.now() - t0) / 1000, duration: A.duration, latency: lat2,
  };
}

function mixY(r, bg) { const Y = r.W.map((w, c) => { const o = new Float32Array(w.length), rr = r.R[c]; for (let i = 0; i < w.length; i++) o[i] = w[i] + bg * rr[i]; return o; }); return packedObj(r.D, Y, r.W); }
// helpers so `aligned` (which trims arrays of channels) can carry several signals at once
function packedObj(D, Y, W) { const arr = [...D, ...Y, ...W]; arr.D = D; arr.Y = Y; return arr; }
function packed(res) { const arr = [...res.main]; if (res.speech) arr.push(...res.speech, ...res.background); return arr; }

/** Learn a noise profile from a stretch of "silence" (A6). chs at 48 kHz. Returns power per bin (N=1024). */
export function noiseProfileFrom(Module, chs, controls = DEFAULTS) {
  const P = stageParams(controls, {}); const nCh = chs.length;
  let x = chs.map((c) => Float32Array.from(c));
  // the spectral stage sits first in noise removal, so learn the profile from the raw (DC-free) noise
  x = new DCBlock(nCh, FS).process(x);
  const N = 1024, H = 512, win = sqrtHann(N), K = N / 2 + 1, prof = new Float64Array(K); let frames = 0;
  for (const c of x) for (let s = 0; s + N <= c.length; s += H) { const re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < N; i++) re[i] = c[s + i] * win[i]; fft(re, im); for (let k = 0; k < K; k++) prof[k] += re[k] * re[k] + im[k] * im[k]; frames++; }
  if (!frames) return null; for (let k = 0; k < K; k++) prof[k] /= frames; return prof;
}
