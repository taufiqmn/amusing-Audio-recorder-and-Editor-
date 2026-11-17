// Takeflow encoders — classic script (works with importScripts in workers and in Node via vm).
// Exposes globalThis.TFEnc = { quantize, encodeWav, encodeFlac, OggOpusWriter }.
(function (root) {
  'use strict';

  /* ---------------- PCM helpers ---------------- */

  function quantize(x, bits, dither, seed) {
    const max = Math.pow(2, bits - 1);
    const out = new Int32Array(x.length);
    let s = (seed || 12345) >>> 0;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    for (let i = 0; i < x.length; i++) {
      let v = x[i] * max;
      if (dither) v += rnd() - rnd(); // TPDF dither, ±1 LSB
      v = Math.round(v);
      if (v > max - 1) v = max - 1; else if (v < -max) v = -max;
      out[i] = v;
    }
    return out;
  }

  /* ---------------- WAV ---------------- */

  /**
   * channels: array of Float32Array (1 or 2). bits: 16 | 24 | 32 (32 = IEEE float).
   */
  function encodeWav(channels, sampleRate, bits) {
    const nCh = channels.length, n = channels[0].length;
    const isFloat = bits === 32;
    const bps = bits / 8;
    const dataBytes = n * nCh * bps;
    const buf = new ArrayBuffer(44 + dataBytes);
    const v = new DataView(buf);
    const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, isFloat ? 3 : 1, true);
    v.setUint16(22, nCh, true); v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * nCh * bps, true); v.setUint16(32, nCh * bps, true); v.setUint16(34, bits, true);
    w(36, 'data'); v.setUint32(40, dataBytes, true);
    let o = 44;
    if (isFloat) {
      for (let i = 0; i < n; i++) for (let c = 0; c < nCh; c++) { v.setFloat32(o, channels[c][i], true); o += 4; }
    } else {
      const q = channels.map((ch, c) => quantize(ch, bits, true, 1234 + c * 77));
      for (let i = 0; i < n; i++) for (let c = 0; c < nCh; c++) {
        const s = q[c][i];
        if (bits === 16) { v.setInt16(o, s, true); o += 2; }
        else { v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255); o += 3; }
      }
    }
    return new Uint8Array(buf);
  }

  /* ---------------- FLAC ---------------- */

  class BitWriter {
    constructor(size) { this.buf = new Uint8Array(size || 1 << 16); this.pos = 0; this.acc = 0; this.nacc = 0; }
    ensure(bytes) {
      if (this.pos + bytes + 8 > this.buf.length) {
        let len = this.buf.length * 2; while (len < this.pos + bytes + 8) len *= 2;
        const nb = new Uint8Array(len); nb.set(this.buf.subarray(0, this.pos)); this.buf = nb;
      }
    }
    // write up to 24 bits at a time (acc holds < 8 pending bits, so it never exceeds 31 bits)
    _w(value, n) {
      this.acc = ((this.acc << n) | (value & ((1 << n) - 1))) >>> 0;
      this.nacc += n;
      while (this.nacc >= 8) {
        this.nacc -= 8;
        this.buf[this.pos++] = (this.acc >>> this.nacc) & 255;
      }
      this.acc &= (1 << this.nacc) - 1;
    }
    write(value, n) { // value is non-negative integer < 2^n, n <= 48
      this.ensure(8);
      while (n > 24) { const hi = Math.floor(value / Math.pow(2, n - 24)); this._w(hi, 24); value = value % Math.pow(2, n - 24); n -= 24; }
      if (n > 0) this._w(value, n);
    }
    writeSigned(value, n) { this.write(value < 0 ? value + Math.pow(2, n) : value, n); }
    writeUnary(q) { // q zeros followed by a one
      this.ensure((q >> 3) + 8);
      while (q >= 24) { this._w(0, 24); q -= 24; }
      this._w(1, q + 1);
    }
    alignZero() { if (this.nacc > 0) this._w(0, 8 - this.nacc); }
    bytes() { return this.buf.subarray(0, this.pos); }
  }

  const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i; for (let j = 0; j < 8; j++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; CRC8[i] = c;
    let d = i << 8; for (let j = 0; j < 8; j++) d = (d & 0x8000) ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff; CRC16[i] = d;
  }
  const crc8 = (b, s, e) => { let c = 0; for (let i = s; i < e; i++) c = CRC8[c ^ b[i]]; return c; };
  const crc16 = (b, s, e) => { let c = 0; for (let i = s; i < e; i++) c = ((c << 8) & 0xffff) ^ CRC16[((c >> 8) ^ b[i]) & 0xff]; return c; };

  function fixedResidual(x, order) {
    const n = x.length, r = new Int32Array(Math.max(0, n - order));
    for (let i = order; i < n; i++) {
      let p;
      switch (order) {
        case 0: p = 0; break;
        case 1: p = x[i - 1]; break;
        case 2: p = 2 * x[i - 1] - x[i - 2]; break;
        case 3: p = 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3]; break;
        default: p = 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4];
      }
      r[i - order] = x[i] - p;
    }
    return r;
  }

  // Choose partition order and Rice parameters. Scans the residual once: for the
  // finest usable partitioning it accumulates sum(u >> k) for k = 0..14, then merges
  // partitions upward, so every coarser layout is costed exactly without rescanning.
  const KMAX = 14;
  function planResidual(r, n, order) {
    let P = 0;
    while (P < 8 && n % (1 << (P + 1)) === 0 && (n >> (P + 1)) >= order && (n >> (P + 1)) >= 16) P++;
    if ((n >> P) < order) return null;
    const parts = 1 << P, partLen = n >> P;
    let S = new Float64Array(parts * (KMAX + 1));
    let lens = new Int32Array(parts);
    let idx = 0;
    for (let j = 0; j < parts; j++) {
      const len = j === 0 ? partLen - order : partLen; lens[j] = len;
      const base = j * (KMAX + 1);
      for (let i = idx; i < idx + len; i++) {
        const v = r[i]; const u = v >= 0 ? 2 * v : -2 * v - 1;
        for (let k = 0; k <= KMAX; k++) S[base + k] += u >>> k;
      }
      idx += len;
    }
    let best = null;
    for (let p = P; p >= 0; p--) {
      const np = 1 << p; let bits = 6; const params = new Array(np);
      for (let j = 0; j < np; j++) {
        let bk = 0, bb = Infinity; const base = j * (KMAX + 1);
        for (let k = 0; k <= KMAX; k++) { const b = 4 + lens[j] * (1 + k) + S[base + k]; if (b < bb) { bb = b; bk = k; } }
        params[j] = bk; bits += bb;
      }
      if (!best || bits < best.bits) best = { p, params, bits };
      if (p > 0) { // merge pairs
        const S2 = new Float64Array((np >> 1) * (KMAX + 1)); const L2 = new Int32Array(np >> 1);
        for (let j = 0; j < np >> 1; j++) {
          L2[j] = lens[2 * j] + lens[2 * j + 1];
          for (let k = 0; k <= KMAX; k++) S2[j * (KMAX + 1) + k] = S[2 * j * (KMAX + 1) + k] + S[(2 * j + 1) * (KMAX + 1) + k];
        }
        S = S2; lens = L2;
      }
    }
    return best;
  }

  function encodeSubframe(bw, x, bps) {
    const n = x.length;
    // constant?
    let constant = true; for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
    if (constant) { bw.write(0, 1); bw.write(0, 6); bw.write(0, 1); bw.writeSigned(x[0], bps); return; }
    let best = { type: 'verbatim', bits: n * bps };
    for (let order = 0; order <= 4 && order < n; order++) {
      const r = fixedResidual(x, order);
      const plan = planResidual(r, n, order);
      if (!plan) continue;
      const bits = order * bps + plan.bits;
      if (bits < best.bits) best = { type: 'fixed', order, r, plan, bits };
    }
    if (best.type === 'verbatim') {
      bw.write(0, 1); bw.write(1, 6); bw.write(0, 1);
      for (let i = 0; i < n; i++) bw.writeSigned(x[i], bps);
      return;
    }
    const { order, r, plan } = best;
    bw.write(0, 1); bw.write(8 | order, 6); bw.write(0, 1);
    for (let i = 0; i < order; i++) bw.writeSigned(x[i], bps);
    bw.write(0, 2); bw.write(plan.p, 4);
    const part = n >> plan.p; let idx = 0;
    for (let k = 0; k < (1 << plan.p); k++) {
      const len = k === 0 ? part - order : part; const rk = plan.params[k];
      bw.write(rk, 4);
      const div = 1 << rk;
      for (let i = idx; i < idx + len; i++) {
        const v = r[i]; const u = v >= 0 ? 2 * v : -2 * v - 1;
        bw.writeUnary(u >>> rk);
        if (rk) bw._w(u & (div - 1), rk);
      }
      idx += len;
    }
  }

  function utf8Num(bw, v) {
    if (v < 0x80) { bw.write(v, 8); return; }
    const bytes = [];
    // UTF-8 style encoding of frame numbers (FLAC spec), up to 2^31
    const len = v < 0x800 ? 2 : v < 0x10000 ? 3 : v < 0x200000 ? 4 : v < 0x4000000 ? 5 : 6;
    for (let i = len - 1; i > 0; i--) { bytes[i] = 0x80 | (v & 0x3f); v = Math.floor(v / 64); }
    bytes[0] = ((0xff00 >> len) & 0xff) | v;
    for (const b of bytes) bw.write(b, 8);
  }

  /**
   * channels: array of Float32Array (1 or 2); bits: 16 | 24.
   * Stereo uses left/side decorrelation (dual-mono compresses to almost nothing extra).
   */
  function encodeFlac(channels, sampleRate, bits, onProgress) {
    const nCh = channels.length, total = channels[0].length;
    const q = channels.map((ch, c) => quantize(ch, bits, true, 999 + c * 31));
    const BS = 4096;
    const bw = new BitWriter(Math.max(1 << 16, total * nCh * (bits / 8) / 2));
    // fLaC + STREAMINFO
    for (const ch of 'fLaC') bw.write(ch.charCodeAt(0), 8);
    bw.write(1, 1); bw.write(0, 7); bw.write(34, 24);
    const blk = total < BS ? Math.max(16, total) : BS;
    bw.write(blk, 16); bw.write(blk, 16);
    bw.write(0, 24); bw.write(0, 24);
    bw.write(sampleRate, 20); bw.write(nCh - 1, 3); bw.write(bits - 1, 5);
    bw.write(total, 36);
    for (let i = 0; i < 16; i++) bw.write(0, 8); // MD5 unknown (allowed)
    const frames = Math.ceil(total / BS);
    for (let f = 0; f < frames; f++) {
      const start = f * BS, n = Math.min(BS, total - start);
      const frameStart = bw.pos; // byte aligned here
      bw.write(0x3ffe, 14); bw.write(0, 1); bw.write(0, 1);
      const bsCode = n === 4096 ? 12 : 7;
      bw.write(bsCode, 4); bw.write(0, 4);
      bw.write(nCh === 2 ? 8 : 0, 4); // 8 = left/side
      bw.write(bits === 16 ? 4 : 6, 3); bw.write(0, 1);
      utf8Num(bw, f);
      if (bsCode === 7) bw.write(n - 1, 16);
      bw.write(crc8(bw.buf, frameStart, bw.pos), 8);
      if (nCh === 1) {
        encodeSubframe(bw, q[0].subarray(start, start + n), bits);
      } else {
        const L = q[0].subarray(start, start + n), R = q[1].subarray(start, start + n);
        const S = new Int32Array(n); for (let i = 0; i < n; i++) S[i] = L[i] - R[i];
        encodeSubframe(bw, L, bits);
        encodeSubframe(bw, S, bits + 1);
      }
      bw.alignZero();
      const c16 = crc16(bw.buf, frameStart, bw.pos);
      bw.write(c16, 16);
      if (onProgress && f % 32 === 0) onProgress(f / frames);
    }
    return bw.bytes().slice();
  }

  /* ---------------- Ogg Opus container ---------------- */

  const OGG_CRC = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    OGG_CRC[i] = r >>> 0;
  }
  function oggCrc(b) { let c = 0; for (let i = 0; i < b.length; i++) c = ((c << 8) ^ OGG_CRC[((c >>> 24) ^ b[i]) & 0xff]) >>> 0; return c >>> 0; }

  class OggOpusWriter {
    constructor({ channels = 1, inputSampleRate = 48000, preSkip = 312, vendor = 'Takeflow', title = '' } = {}) {
      this.serial = (Math.random() * 0x7fffffff) | 0;
      this.seq = 0; this.pages = []; this.preSkip = preSkip;
      this.pending = []; this.pendingSamples = 0; this.granule = 0;
      const head = new Uint8Array(19); const hv = new DataView(head.buffer);
      'OpusHead'.split('').forEach((ch, i) => (head[i] = ch.charCodeAt(0)));
      head[8] = 1; head[9] = channels; hv.setUint16(10, preSkip, true); hv.setUint32(12, inputSampleRate, true);
      hv.setInt16(16, 0, true); head[18] = 0;
      this._page([head], 0, 0x02);
      const enc = new TextEncoder(); const vend = enc.encode(vendor);
      const comments = title ? [enc.encode('TITLE=' + title)] : [];
      let len = 8 + 4 + vend.length + 4; comments.forEach((c) => (len += 4 + c.length));
      const tags = new Uint8Array(len); const tv = new DataView(tags.buffer);
      'OpusTags'.split('').forEach((ch, i) => (tags[i] = ch.charCodeAt(0)));
      tv.setUint32(8, vend.length, true); tags.set(vend, 12);
      let o = 12 + vend.length; tv.setUint32(o, comments.length, true); o += 4;
      comments.forEach((c) => { tv.setUint32(o, c.length, true); tags.set(c, o + 4); o += 4 + c.length; });
      this._page([tags], 0, 0);
    }
    _page(packets, granule, flags) {
      const lacing = [];
      packets.forEach((p) => { let l = p.length; while (l >= 255) { lacing.push(255); l -= 255; } lacing.push(l); });
      const bodyLen = packets.reduce((a, p) => a + p.length, 0);
      const page = new Uint8Array(27 + lacing.length + bodyLen); const v = new DataView(page.buffer);
      page.set([0x4f, 0x67, 0x67, 0x53], 0); page[4] = 0; page[5] = flags;
      v.setUint32(6, granule % 4294967296, true); v.setUint32(10, Math.floor(granule / 4294967296), true);
      v.setUint32(14, this.serial, true); v.setUint32(18, this.seq++, true); v.setUint32(22, 0, true);
      page[26] = lacing.length; page.set(lacing, 27);
      let o = 27 + lacing.length; packets.forEach((p) => { page.set(p, o); o += p.length; });
      v.setUint32(22, oggCrc(page), true);
      this.pages.push(page);
    }
    addPacket(data, samples48k) {
      this.pending.push(data); this.pendingSamples += samples48k;
      let segs = 0; this.pending.forEach((p) => (segs += Math.floor(p.length / 255) + 1));
      if (segs > 200 || this.pendingSamples >= 48000) this._flush(false);
    }
    _flush(last, finalGranule) {
      if (!this.pending.length && !last) return;
      this.granule += this.pendingSamples;
      // Granule = total decoded samples so far (these already include the pre-skip);
      // the last page's granule marks where real audio ends so players trim padding.
      const g = last && finalGranule != null ? Math.min(finalGranule, this.granule) : this.granule;
      this._page(this.pending, g, last ? 0x04 : 0);
      this.pending = []; this.pendingSamples = 0;
    }
    finish(totalSamples48k) {
      this._flush(true, totalSamples48k + this.preSkip);
      const len = this.pages.reduce((a, p) => a + p.length, 0);
      const out = new Uint8Array(len); let o = 0; this.pages.forEach((p) => { out.set(p, o); o += p.length; });
      return out;
    }
  }

  root.TFEnc = { quantize, encodeWav, encodeFlac, OggOpusWriter, BitWriter };
})(typeof self !== 'undefined' ? self : globalThis);
