// File input/output for the Studio: streaming resampler, streaming WAV/AIFF reader,
// encoders (WAV, FLAC, MP3, Opus/Ogg, AAC/M4A) and a store-only streaming ZIP writer.
// Works in workers and on the main thread; no DOM use.

/* ---------------- streaming resampler ---------------- */

export class StreamResampler {
  constructor(from, to, nCh, halfTaps = 24) {
    this.from = from; this.to = to; this.nCh = nCh; this.same = from === to;
    if (this.same) return;
    this.step = from / to; this.H = halfTaps; const cut = Math.min(1, to / from) * 0.94;
    const RES = 512; this.RES = RES; this.tab = new Float32Array(halfTaps * RES + 2);
    for (let k = 0; k < this.tab.length; k++) {
      const t = k / RES; const s = t === 0 ? 1 : Math.sin(Math.PI * cut * t) / (Math.PI * cut * t);
      const p = (t / halfTaps + 1) * Math.PI; const w = t > halfTaps ? 0 : 0.35875 - 0.48829 * Math.cos(p) + 0.14128 * Math.cos(2 * p) - 0.01168 * Math.cos(3 * p);
      this.tab[k] = cut * s * w;
    }
    this.buf = Array.from({ length: nCh }, () => new Float32Array(0)); this.pos = 0; // pos: next output position in input samples, relative to buf[0]
    for (let c = 0; c < nCh; c++) this.buf[c] = new Float32Array(halfTaps); // leading zeros = history
    this.pos = halfTaps; this.done = false; this.inCount = 0; this.outCount = 0;
  }
  _k(t) { const a = Math.abs(t) * this.RES, i = a | 0; if (i >= this.tab.length - 1) return 0; const f = a - i; return this.tab[i] + (this.tab[i + 1] - this.tab[i]) * f; }
  process(chs, final = false) {
    if (this.same) return chs;
    for (let c = 0; c < this.nCh; c++) { const b = new Float32Array(this.buf[c].length + chs[c].length); b.set(this.buf[c]); b.set(chs[c], this.buf[c].length); this.buf[c] = b; }
    const len = this.buf[0].length, H = this.H; this.inCount += chs[0].length;
    // the total output length is exactly round(input * to / from), whatever the block sizes
    let n = final ? Math.round((this.inCount * this.to) / this.from) - this.outCount : Math.ceil((len - H - this.pos) / this.step);
    n = Math.max(0, n); this.outCount += n;
    const out = Array.from({ length: this.nCh }, () => new Float32Array(n));
    for (let j = 0; j < n; j++) {
      const p = this.pos + j * this.step, c0 = Math.floor(p), fr = p - c0;
      const lo = Math.max(0, c0 - H + 1), hi = Math.min(len - 1, c0 + H);
      for (let c = 0; c < this.nCh; c++) { const b = this.buf[c]; let s = 0; for (let i = lo; i <= hi; i++) s += b[i] * this._k(i - c0 - fr); out[c][j] = s; }
    }
    this.pos += n * this.step;
    const drop = Math.max(0, Math.floor(this.pos) - H);
    if (drop > 0) { for (let c = 0; c < this.nCh; c++) this.buf[c] = this.buf[c].slice(drop); this.pos -= drop; }
    return out;
  }
}

/* ---------------- WAV / AIFF streaming reader ---------------- */

export async function readHeader(file) {
  const head = new DataView(await file.slice(0, Math.min(file.size, 1 << 16)).arrayBuffer());
  const tag = (o) => String.fromCharCode(head.getUint8(o), head.getUint8(o + 1), head.getUint8(o + 2), head.getUint8(o + 3));
  if (head.byteLength < 12) return null;
  if ((tag(0) === 'RIFF' || tag(0) === 'RF64') && tag(8) === 'WAVE') {
    let o = 12, fmt = null;
    while (o + 8 <= head.byteLength) {
      const id = tag(o), size = head.getUint32(o + 4, true);
      if (id === 'fmt ') { let format = head.getUint16(o + 8, true); if (format === 0xfffe) format = head.getUint16(o + 32, true); fmt = { format, ch: head.getUint16(o + 10, true), fs: head.getUint32(o + 12, true), bits: head.getUint16(o + 22, true) }; }
      if (id === 'data') { if (!fmt) return null; const bps = fmt.bits / 8; const dataSize = size === 0xffffffff || o + 8 + size > file.size ? file.size - o - 8 : size; return { kind: 'wav', ...fmt, offset: o + 8, frames: Math.floor(dataSize / (bps * fmt.ch)), le: true, float: fmt.format === 3 }; }
      o += 8 + size + (size & 1);
    }
    return null;
  }
  if (tag(0) === 'FORM' && (tag(8) === 'AIFF' || tag(8) === 'AIFC')) {
    let o = 12, comm = null;
    while (o + 8 <= head.byteLength) {
      const id = tag(o), size = head.getUint32(o + 4);
      if (id === 'COMM') {
        const ch = head.getUint16(o + 8), frames = head.getUint32(o + 10), bits = head.getUint16(o + 14);
        const e = head.getUint16(o + 16) & 0x7fff, m = head.getUint32(o + 18); const fs = Math.round(m * Math.pow(2, e - 16383 - 31));
        let le = false, float = false; if (tag(8) === 'AIFC') { const ct = tag(o + 26); if (ct === 'sowt') le = true; else if (ct === 'fl32') float = true; else if (ct !== 'NONE') return null; }
        comm = { ch, frames, bits, fs, le, float };
      }
      if (id === 'SSND' && comm) return { kind: 'aiff', ...comm, offset: o + 16 + head.getUint32(o + 8) };
      o += 8 + size + (size & 1);
    }
  }
  return null;
}

/** Async generator of Float32 channel blocks resampled to `toRate`. */
export async function* pcmBlocks(file, h, toRate = 48000, framesPerRead = 96000) {
  const bps = h.bits / 8, fb = bps * h.ch; const rs = new StreamResampler(h.fs, toRate, h.ch);
  for (let f = 0; f < h.frames; f += framesPerRead) {
    const n = Math.min(framesPerRead, h.frames - f);
    const dv = new DataView(await file.slice(h.offset + f * fb, h.offset + (f + n) * fb).arrayBuffer());
    const chs = Array.from({ length: h.ch }, () => new Float32Array(n));
    for (let i = 0; i < n; i++) for (let c = 0; c < h.ch; c++) {
      const o = i * fb + c * bps; let v;
      if (h.float) v = bps === 8 ? dv.getFloat64(o, h.le) : dv.getFloat32(o, h.le);
      else if (bps === 1) v = (dv.getUint8(o) - 128) / 128;
      else if (bps === 2) v = dv.getInt16(o, h.le) / 32768;
      else if (bps === 3) { const b0 = dv.getUint8(o), b1 = dv.getUint8(o + 1), b2 = dv.getUint8(o + 2); let x = h.le ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16); if (x & 0x800000) x -= 0x1000000; v = x / 8388608; }
      else v = dv.getInt32(o, h.le) / 2147483648;
      chs[c][i] = v;
    }
    const out = rs.process(chs, f + n >= h.frames); if (out[0].length) yield out;
  }
}

/* ---------------- encoders ---------------- */

function tpdf(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

export class WavWriter {
  constructor(fs, nCh, bits = 24, dither = true) { Object.assign(this, { fs, nCh, bits, dither }); this.parts = []; this.frames = 0; this.rnd = tpdf(77); }
  write(chs) {
    const n = chs[0].length, bps = this.bits / 8, buf = new ArrayBuffer(n * this.nCh * bps), v = new DataView(buf); let o = 0;
    const max = Math.pow(2, this.bits - 1);
    for (let i = 0; i < n; i++) for (let c = 0; c < this.nCh; c++) {
      const x = chs[Math.min(c, chs.length - 1)][i];
      if (this.bits === 32) { v.setFloat32(o, x, true); o += 4; continue; }
      let q = Math.round(x * max + (this.dither ? this.rnd() - this.rnd() : 0)); q = Math.max(-max, Math.min(max - 1, q));
      if (bps === 2) v.setInt16(o, q, true); else { v.setUint8(o, q & 255); v.setUint8(o + 1, (q >> 8) & 255); v.setUint8(o + 2, (q >> 16) & 255); }
      o += bps;
    }
    this.parts.push(new Uint8Array(buf)); this.frames += n;
  }
  finish(tags = {}) {
    const bps = this.bits / 8, data = this.frames * this.nCh * bps;
    const info = infoChunk(tags); const h = new DataView(new ArrayBuffer(44));
    const w = (o, s) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); h.setUint32(4, 36 + data + (data & 1) + info.length, true); w(8, 'WAVE'); w(12, 'fmt '); h.setUint32(16, 16, true);
    h.setUint16(20, this.bits === 32 ? 3 : 1, true); h.setUint16(22, this.nCh, true); h.setUint32(24, this.fs, true); h.setUint32(28, this.fs * this.nCh * bps, true);
    h.setUint16(32, this.nCh * bps, true); h.setUint16(34, this.bits, true); w(36, 'data'); h.setUint32(40, data, true);
    return new Blob([h.buffer, ...this.parts, data & 1 ? new Uint8Array(1) : new Uint8Array(0), info], { type: 'audio/wav' });
  }
}
function infoChunk(tags) {
  const enc = new TextEncoder(); const items = [];
  if (tags.title) items.push(['INAM', tags.title]); if (tags.artist) items.push(['IART', tags.artist]);
  if (!items.length) return new Uint8Array(0);
  const subs = items.map(([id, t]) => { const b = enc.encode(t + '\0'); const len = b.length + (b.length & 1); const u = new Uint8Array(8 + len); u.set([...id].map((c) => c.charCodeAt(0)), 0); new DataView(u.buffer).setUint32(4, b.length, true); u.set(b, 8); return u; });
  const size = 4 + subs.reduce((a, s) => a + s.length, 0); const out = new Uint8Array(8 + size); const v = new DataView(out.buffer);
  out.set([76, 73, 83, 84], 0); v.setUint32(4, size, true); out.set([73, 78, 70, 79], 8); let o = 12; for (const s of subs) { out.set(s, o); o += s.length; }
  return out;
}

/** ID3v2.3 tag with title, artist and optional cover (Uint8Array JPEG/PNG). */
export function id3(tags = {}) {
  const enc = new TextEncoder(); const frames = [];
  const frame = (id, body) => { const f = new Uint8Array(10 + body.length); f.set([...id].map((c) => c.charCodeAt(0))); new DataView(f.buffer).setUint32(4, body.length); f.set(body, 10); frames.push(f); };
  const text = (id, t) => { const b = new Uint8Array(1 + t.length * 2 + 2 + 2); b[0] = 1; b[1] = 0xff; b[2] = 0xfe; for (let i = 0; i < t.length; i++) { b[3 + 2 * i] = t.charCodeAt(i) & 255; b[4 + 2 * i] = t.charCodeAt(i) >> 8; } frame(id, b.subarray(0, 3 + t.length * 2)); };
  if (tags.title) text('TIT2', tags.title); if (tags.artist) text('TPE1', tags.artist);
  if (tags.cover) { const mime = enc.encode((tags.coverType || 'image/jpeg') + '\0'); const b = new Uint8Array(1 + mime.length + 2 + tags.cover.length); b[0] = 0; b.set(mime, 1); b[1 + mime.length] = 3; b[2 + mime.length] = 0; b.set(tags.cover, 3 + mime.length); frame('APIC', b); }
  if (!frames.length) return new Uint8Array(0);
  const size = frames.reduce((a, f) => a + f.length, 0); const out = new Uint8Array(10 + size);
  out.set([73, 68, 51, 3, 0, 0]); out[6] = (size >> 21) & 127; out[7] = (size >> 14) & 127; out[8] = (size >> 7) & 127; out[9] = size & 127;
  let o = 10; for (const f of frames) { out.set(f, o); o += f.length; } return out;
}

export class Mp3Writer {
  constructor(lamejs, fs, nCh, kbps) { this.enc = new lamejs.Mp3Encoder(nCh, fs, kbps); this.nCh = nCh; this.parts = []; this.rnd = tpdf(5); }
  write(chs) {
    const q = chs.map((c) => { const o = new Int16Array(c.length); for (let i = 0; i < c.length; i++) o[i] = Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767 + this.rnd() - this.rnd()))); return o; });
    for (let i = 0; i < q[0].length; i += 1152 * 8) {
      const b = this.nCh === 2 ? this.enc.encodeBuffer(q[0].subarray(i, i + 9216), (q[1] || q[0]).subarray(i, i + 9216)) : this.enc.encodeBuffer(q[0].subarray(i, i + 9216));
      if (b.length) this.parts.push(new Uint8Array(b));
    }
  }
  finish(tags = {}) { const e = this.enc.flush(); if (e.length) this.parts.push(new Uint8Array(e)); return new Blob([id3(tags), ...this.parts], { type: 'audio/mpeg' }); }
}

/** Collects audio, then encodes FLAC with the existing pure-JS encoder (globalThis.TFEnc). */
export class FlacWriter {
  constructor(fs, nCh, bits = 24) { Object.assign(this, { fs, nCh, bits }); this.chunks = []; }
  write(chs) { this.chunks.push(chs.map((c) => Float32Array.from(c))); }
  finish(tags = {}) {
    const n = this.chunks.reduce((a, c) => a + c[0].length, 0); const chs = Array.from({ length: this.nCh }, () => new Float32Array(n)); let o = 0;
    for (const ck of this.chunks) { for (let c = 0; c < this.nCh; c++) chs[c].set(ck[Math.min(c, ck.length - 1)], o); o += ck[0].length; }
    this.chunks = []; let bytes = globalThis.TFEnc.encodeFlac(chs, this.fs, this.bits);
    if (tags.title || tags.artist || tags.cover) bytes = flacAddTags(bytes, tags);
    return new Blob([bytes], { type: 'audio/flac' });
  }
}
function flacAddTags(bytes, tags) {
  // insert VORBIS_COMMENT (and PICTURE) after STREAMINFO; STREAMINFO loses its "last" flag
  const enc = new TextEncoder(); const vendor = enc.encode('Takeflow Studio'); const cm = [];
  if (tags.title) cm.push(enc.encode('TITLE=' + tags.title)); if (tags.artist) cm.push(enc.encode('ARTIST=' + tags.artist));
  const len = 4 + vendor.length + 4 + cm.reduce((a, c) => a + 4 + c.length, 0); const vc = new Uint8Array(4 + len); const v = new DataView(vc.buffer);
  const blocks = []; let o = 4; v.setUint32(o, vendor.length, true); o += 4; vc.set(vendor, o); o += vendor.length; v.setUint32(o, cm.length, true); o += 4;
  for (const c of cm) { v.setUint32(o, c.length, true); o += 4; vc.set(c, o); o += c.length; }
  vc[0] = 4; vc[1] = (len >> 16) & 255; vc[2] = (len >> 8) & 255; vc[3] = len & 255; blocks.push(vc);
  if (tags.cover) { const mime = enc.encode(tags.coverType || 'image/jpeg'); const plen = 32 + mime.length + tags.cover.length; const pb = new Uint8Array(4 + plen); const pv = new DataView(pb.buffer); pb[0] = 6; pb[1] = (plen >> 16) & 255; pb[2] = (plen >> 8) & 255; pb[3] = plen & 255; let q = 4; pv.setUint32(q, 3); q += 4; pv.setUint32(q, mime.length); q += 4; pb.set(mime, q); q += mime.length; pv.setUint32(q, 0); q += 4; q += 16; pv.setUint32(q, tags.cover.length); q += 4; pb.set(tags.cover, q); blocks.push(pb); }
  blocks[blocks.length - 1][0] |= 0x80;
  const out = new Uint8Array(bytes.length + blocks.reduce((a, b) => a + b.length, 0)); out.set(bytes.subarray(0, 42)); out[4] &= 0x7f; let p = 42;
  for (const b of blocks) { out.set(b, p); p += b.length; } out.set(bytes.subarray(42), p); return out;
}

/** WebCodecs-based encoders (Opus in Ogg, AAC in M4A). Only where AudioEncoder supports the codec. */
export async function codecSupport() {
  const res = { opus: false, aac: false };
  if (typeof AudioEncoder === 'undefined') return res;
  try { res.opus = (await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 96000 })).supported; } catch {}
  try { res.aac = (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported; } catch {}
  return res;
}

export class WebCodecsWriter {
  constructor(codec, fs, nCh, kbps, tags = {}) {
    this.codec = codec; this.fs = fs; this.nCh = nCh; this.tags = tags; this.packets = []; this.desc = null; this.err = null; this.frames = 0; this.ts = 0;
    this.enc = new AudioEncoder({ output: (chunk, meta) => { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); this.packets.push({ d, dur: Math.round(((chunk.duration || 0) * fs) / 1e6) }); if (meta?.decoderConfig?.description && !this.desc) this.desc = new Uint8Array(meta.decoderConfig.description.buffer ? meta.decoderConfig.description.buffer.slice(meta.decoderConfig.description.byteOffset || 0) : meta.decoderConfig.description); }, error: (e) => (this.err = e) });
    this.enc.configure({ codec: codec === 'opus' ? 'opus' : 'mp4a.40.2', sampleRate: fs, numberOfChannels: nCh, bitrate: kbps * 1000 });
  }
  async write(chs) {
    const n = chs[0].length; const planar = new Float32Array(n * this.nCh);
    for (let c = 0; c < this.nCh; c++) planar.set(chs[Math.min(c, chs.length - 1)], c * n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: this.fs, numberOfFrames: n, numberOfChannels: this.nCh, timestamp: Math.round((this.ts * 1e6) / this.fs), data: planar });
    this.enc.encode(ad); ad.close(); this.ts += n; this.frames += n;
    if (this.enc.encodeQueueSize > 40) await new Promise((r) => setTimeout(r, 0));
  }
  async finish() {
    await this.enc.flush(); this.enc.close(); if (this.err) throw this.err;
    if (this.codec === 'opus') {
      let preSkip = 312; if (this.desc && this.desc.length >= 12 && String.fromCharCode(...this.desc.subarray(0, 8)) === 'OpusHead') preSkip = this.desc[10] | (this.desc[11] << 8);
      const w = new globalThis.TFEnc.OggOpusWriter({ channels: this.nCh, inputSampleRate: this.fs, preSkip, title: this.tags.title || '' });
      for (const p of this.packets) w.addPacket(p.d, p.dur || 960);
      return new Blob([w.finish(this.frames)], { type: 'audio/ogg' });
    }
    return new Blob([muxM4A(this.packets, this.desc, this.fs, this.nCh, this.frames, this.tags)], { type: 'audio/mp4' });
  }
}

/* ---------------- minimal MP4 (M4A) muxer for AAC ---------------- */

function box(type, ...parts) {
  const len = 8 + parts.reduce((a, p) => a + p.length, 0); const b = new Uint8Array(len); const v = new DataView(b.buffer);
  v.setUint32(0, len); for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i); let o = 8; for (const p of parts) { b.set(p, o); o += p.length; } return b;
}
const u32 = (...xs) => { const b = new Uint8Array(4 * xs.length); const v = new DataView(b.buffer); xs.forEach((x, i) => v.setUint32(4 * i, x)); return b; };
const u16 = (...xs) => { const b = new Uint8Array(2 * xs.length); const v = new DataView(b.buffer); xs.forEach((x, i) => v.setUint16(2 * i, x)); return b; };
const bytes = (...xs) => Uint8Array.from(xs);
const full = (type, ver, flags, ...parts) => box(type, bytes(ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);
function descr(tag, body) { const len = body.length; return bytes(tag, 0x80 | ((len >> 21) & 127), 0x80 | ((len >> 14) & 127), 0x80 | ((len >> 7) & 127), len & 127, ...body); }

export function muxM4A(packets, asc, fs, nCh, frames, tags = {}) {
  if (!asc || !asc.length) { // AudioSpecificConfig for AAC-LC
    const idx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(fs);
    asc = bytes((2 << 3) | (idx >> 1), ((idx & 1) << 7) | (nCh << 3));
  }
  const sizes = packets.map((p) => p.d.length); const mdatLen = 8 + sizes.reduce((a, b) => a + b, 0);
  const esds = full('esds', 0, 0, descr(3, [0, 1, 0, ...descr(4, [0x40, 0x15, 0, 0, 0, ...u32(0), ...u32(0), ...descr(5, [...asc])]), ...descr(6, [2])]));
  const mp4a = box('mp4a', new Uint8Array(6), u16(1), new Uint8Array(8), u16(nCh, 16, 0, 0), u32(fs << 16), esds);
  const stsd = full('stsd', 0, 0, u32(1), mp4a);
  const stts = full('stts', 0, 0, u32(1, packets.length, 1024));
  const stsc = full('stsc', 0, 0, u32(1, 1, packets.length, 1));
  const stsz = full('stsz', 0, 0, u32(0, packets.length), u32(...sizes));
  const dur = frames;
  const udta = metaBox(tags);
  const build = (chunkOffset) => {
    const stco = full('stco', 0, 0, u32(1, chunkOffset));
    const stbl = box('stbl', stsd, stts, stsc, stsz, stco);
    const minf = box('minf', full('smhd', 0, 0, u32(0)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
    const mdia = box('mdia', full('mdhd', 0, 0, u32(0, 0, fs, dur), u16(0x55c4, 0)), full('hdlr', 0, 0, u32(0), bytes(115, 111, 117, 110), u32(0, 0, 0), bytes(0)), minf);
    const matrix = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
    const tkhd = full('tkhd', 0, 3, u32(0, 0, 1, 0, Math.round((dur * 1000) / fs), 0, 0), u16(0, 0, 0x0100, 0), matrix, u32(0, 0));
    const trak = box('trak', tkhd, mdia);
    const mvhd = full('mvhd', 0, 0, u32(0, 0, 1000, Math.round((dur * 1000) / fs), 0x10000), u16(0x0100, 0), new Uint8Array(8), matrix, new Uint8Array(24), u32(2));
    return box('moov', mvhd, trak, udta);
  };
  const ftyp = box('ftyp', bytes(77, 52, 65, 32), u32(0), bytes(77, 52, 65, 32, 105, 115, 111, 109, 109, 112, 52, 50));
  const moovLen = build(0).length; const off = ftyp.length + moovLen + 8;
  const moov = build(off);
  const mdatHead = new Uint8Array(8); new DataView(mdatHead.buffer).setUint32(0, mdatLen); mdatHead.set([109, 100, 97, 116], 4);
  return new Blob([ftyp, moov, mdatHead, ...packets.map((p) => p.d)]);
}
function metaBox(tags) {
  const enc = new TextEncoder(); const items = [];
  const item = (code, body, type) => box(code, box('data', u32(type, 0), body));
  if (tags.title) items.push(item('\u00a9nam', enc.encode(tags.title), 1));
  if (tags.artist) items.push(item('\u00a9ART', enc.encode(tags.artist), 1));
  if (tags.cover) items.push(item('covr', tags.cover, tags.coverType === 'image/png' ? 14 : 13));
  if (!items.length) return new Uint8Array(0);
  const hdlr = full('hdlr', 0, 0, u32(0), bytes(109, 100, 105, 114), bytes(97, 112, 112, 108), u32(0, 0), bytes(0));
  return box('udta', full('meta', 0, 0, hdlr, box('ilst', ...items)));
}

/* ---------------- store-only ZIP ---------------- */

const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
export function crc32(u8, crc = 0) { let c = ~crc >>> 0; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return ~c >>> 0; }

/**
 * Build a ZIP (no compression) from [{ name, blob }]. File contents are referenced, not copied:
 * the result is a Blob made of small headers plus the original Blobs. CRCs are computed in 4 MB slices.
 */
export async function zipBlobs(files, onProgress = () => {}) {
  const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0; const used = new Set();
  const total = files.reduce((a, f) => a + f.blob.size, 0); let done = 0;
  for (const f of files) {
    let name = f.name; let k = 2; while (used.has(name.toLowerCase())) { name = f.name.replace(/(\.[^.]*)?$/, (m) => ` (${k})${m || ''}`); k++; } used.add(name.toLowerCase());
    let crc = 0; for (let o = 0; o < f.blob.size; o += 4 << 20) { crc = crc32(new Uint8Array(await f.blob.slice(o, o + (4 << 20)).arrayBuffer()), crc); done += Math.min(4 << 20, f.blob.size - o); onProgress(done / total); }
    const nb = enc.encode(name); const size = f.blob.size;
    const d = new Date(); const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, nb.length, true);
    parts.push(lh.buffer, nb, f.blob);
    const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, nb.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, nb); offset += 30 + nb.length + size;
  }
  const cdSize = central.reduce((a, p) => a + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
