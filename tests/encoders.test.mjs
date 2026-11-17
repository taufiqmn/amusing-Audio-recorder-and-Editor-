import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import vm from 'node:vm';
import { synthSpeech, ffmpegDecodeF32, check } from './helpers.mjs';
import { execFileSync } from 'node:child_process';
import { resample } from '../public/js/dsp.js';

console.log('Encoders');
const ctx = { console, TextEncoder, Math, Uint8Array, Int32Array, Float32Array, Uint16Array, Uint32Array, Int16Array, Int8Array, ArrayBuffer, DataView, Array, Object };
ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../public/js/encoders.js', import.meta.url), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(new URL('../public/js/vendor/lame.min.js', import.meta.url), 'utf8') + ';globalThis.lamejs=lamejs;', ctx);
const { TFEnc, lamejs } = ctx;
const tmp = (n) => path.join(os.tmpdir(), n);

const sr = 48000;
const { x } = synthSpeech(sr, 6.37, { noise: 0.01 }); // odd length to exercise last-frame handling
const maxErr = (a, b) => { let e = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) e = Math.max(e, Math.abs(a[i] - b[i])); return e; };

// WAV
for (const bits of [16, 24, 32]) {
  const bytes = TFEnc.encodeWav([x], sr, bits); fs.writeFileSync(tmp(`t${bits}.wav`), bytes);
  const y = ffmpegDecodeF32(tmp(`t${bits}.wav`), sr);
  const lim = bits === 16 ? 2 / 32768 : bits === 24 ? 2 / 8388608 : 1e-7;
  check(y.length === x.length && maxErr(x, y) <= lim, `WAV ${bits}-bit decodes exactly (err ${maxErr(x, y).toExponential(1)})`);
}

// FLAC — must be bit-exact vs the same quantized PCM
for (const [bits, nCh] of [[16, 1], [24, 1], [16, 2], [24, 2]]) {
  const chans = nCh === 1 ? [x] : [x, x.map((v, i) => v * 0.5 * Math.sin(i / 3000))];
  const t0 = Date.now();
  const bytes = TFEnc.encodeFlac(chans, sr, bits);
  const ms = Date.now() - t0;
  const f = tmp(`t${bits}-${nCh}.flac`); fs.writeFileSync(f, bytes);
  // decode as integer PCM for exact comparison
  const fmt = bits === 16 ? 's16le' : 's32le';
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-f', fmt, '-'], { maxBuffer: 1 << 30 });
  const dec = bits === 16 ? new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2) : new Int32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const q = chans.map((c, ci) => TFEnc.quantize(c, bits, true, 999 + ci * 31));
  let ok = dec.length === x.length * nCh;
  for (let i = 0; ok && i < x.length; i++) for (let c = 0; c < nCh; c++) {
    const d = bits === 16 ? dec[i * nCh + c] : dec[i * nCh + c] >> 8;
    if (d !== q[c][i]) { ok = false; console.log('    mismatch at', i, c, d, q[c][i]); break; }
  }
  const ratio = bytes.length / (x.length * nCh * bits / 8);
  check(ok, `FLAC ${bits}-bit ${nCh === 1 ? 'mono' : 'stereo'} is lossless (size ${(ratio * 100).toFixed(0)}% of WAV, ${ms} ms)`);
  // ffmpeg strict validation
  const r = execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-err_detect', 'crccheck+bitstream+buffer', '-i', f, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  check(true, `FLAC ${bits}-bit ${nCh}ch passes ffmpeg CRC check`);
}
// tiny file edge case
{
  const tiny = x.subarray(0, 100);
  const bytes = TFEnc.encodeFlac([tiny], sr, 16); fs.writeFileSync(tmp('tiny.flac'), bytes);
  const y = ffmpegDecodeF32(tmp('tiny.flac'), sr);
  check(y.length === 100, 'FLAC handles very short clips');
}

// MP3 via lamejs
for (const kbps of [128, 320]) {
  for (const rate of [44100, 48000]) {
    const pcm = TFEnc.quantize(rate === sr ? x : resample(x, sr, rate), 16, true);
    const i16 = Int16Array.from(pcm);
    const enc = new lamejs.Mp3Encoder(1, rate, kbps);
    const parts = []; const B = 1152 * 10;
    for (let i = 0; i < i16.length; i += B) { const b = enc.encodeBuffer(i16.subarray(i, i + B)); if (b.length) parts.push(Buffer.from(b)); }
    const end = enc.flush(); if (end.length) parts.push(Buffer.from(end));
    const f = tmp(`t-${kbps}-${rate}.mp3`); fs.writeFileSync(f, Buffer.concat(parts));
    const info = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate,bit_rate,codec_name', '-of', 'csv=p=0', f]).toString().trim();
    const y = ffmpegDecodeF32(f, rate);
    const dur = y.length / rate;
    check(info.startsWith('mp3') && Math.abs(dur - x.length / sr) < 0.12, `MP3 ${kbps} kbps @${rate}: valid (${info}, ${dur.toFixed(2)} s)`);
  }
}

// Ogg container round trip with real Opus packets produced by ffmpeg
{
  const src = tmp('opus-src.wav'); fs.writeFileSync(src, TFEnc.encodeWav([x], sr, 16));
  // extract raw opus packets: ffmpeg to ogg, then parse its packets
  const ref = tmp('ref.opus'); execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-c:a', 'libopus', '-b:a', '96k', ref]);
  const data = fs.readFileSync(ref);
  // naive Ogg parser to pull out packets
  const packets = []; let o = 0, cur = [];
  while (o < data.length) {
    const nseg = data[o + 26]; const lac = data.subarray(o + 27, o + 27 + nseg); let p = o + 27 + nseg;
    for (const l of lac) { cur.push(data.subarray(p, p + l)); p += l; if (l < 255) { packets.push(Buffer.concat(cur)); cur = []; } }
    o = p;
  }
  const audio = packets.slice(2);
  const w = new TFEnc.OggOpusWriter({ channels: 1, inputSampleRate: sr, preSkip: 312, title: 'Test' });
  for (const p of audio) w.addPacket(new Uint8Array(p), 960);
  const out = w.finish(x.length);
  const f = tmp('ours.opus'); fs.writeFileSync(f, out);
  const y = ffmpegDecodeF32(f, 48000);
  check(y.length === x.length, `Ogg Opus writer: valid stream, ${y.length} samples (source ${x.length})`);
}
