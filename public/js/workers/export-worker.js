// Encodes the final mix to WAV, FLAC, MP3 or Opus off the main thread.
import '../encoders.js';
import { resample } from '../dsp.js';
const { encodeWav, encodeFlac, OggOpusWriter, quantize } = self.TFEnc;

let lameP = null;
function lame() {
  if (!lameP) {
    lameP = fetch(new URL('../vendor/lame.min.js', import.meta.url))
      .then((r) => r.text())
      .then((src) => new Function(src + '\n;return lamejs;')());
  }
  return lameP;
}

async function encodeMp3(chs, rate, kbps, progress) {
  const lamejs = await lame();
  const enc = new lamejs.Mp3Encoder(chs.length, rate, kbps);
  const q = chs.map((c, i) => Int16Array.from(quantize(c, 16, true, 77 + i)));
  const parts = []; const B = 1152 * 20; const n = q[0].length;
  for (let i = 0; i < n; i += B) {
    const buf = chs.length === 2 ? enc.encodeBuffer(q[0].subarray(i, i + B), q[1].subarray(i, i + B)) : enc.encodeBuffer(q[0].subarray(i, i + B));
    if (buf.length) parts.push(new Uint8Array(buf));
    if ((i / B) % 20 === 0) progress(i / n);
  }
  const end = enc.flush(); if (end.length) parts.push(new Uint8Array(end));
  return new Blob(parts, { type: 'audio/mpeg' });
}

async function encodeOpus(chs, kbps, title, progress) {
  if (typeof AudioEncoder === 'undefined') throw new Error('Opus export needs a browser with WebCodecs (Chrome, Edge, or Safari 26+). Choose FLAC or MP3 instead.');
  const nCh = chs.length;
  const config = { codec: 'opus', sampleRate: 48000, numberOfChannels: nCh, bitrate: kbps * 1000 };
  const sup = await AudioEncoder.isConfigSupported(config);
  if (!sup.supported) throw new Error('This browser cannot encode Opus. Choose FLAC or MP3 instead.');
  let preSkip = 312; let writer = null; const queue = [];
  let failure = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const d = meta?.decoderConfig?.description;
      if (!writer) {
        if (d && d.byteLength >= 12) {
          const v = new DataView(d instanceof ArrayBuffer ? d : d.buffer, d.byteOffset || 0);
          const magic = String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset, 8));
          if (magic === 'OpusHead') preSkip = v.getUint16(10, true);
        }
        writer = new OggOpusWriter({ channels: nCh, inputSampleRate: 48000, preSkip, title });
        for (const q of queue) writer.addPacket(q.data, q.samples);
      }
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
      const samples = Math.round((chunk.duration || 20000) * 48000 / 1e6);
      writer.addPacket(data, samples);
    },
    error: (e) => { failure = e; },
  });
  enc.configure(config);
  const n = chs[0].length, F = 4800;
  for (let i = 0; i < n; i += F) {
    const len = Math.min(F, n - i);
    const planar = new Float32Array(len * nCh);
    for (let c = 0; c < nCh; c++) planar.set(chs[c].subarray(i, i + len), c * len);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: len, numberOfChannels: nCh, timestamp: Math.round(i * 1e6 / 48000), data: planar });
    enc.encode(ad); ad.close();
    if (enc.encodeQueueSize > 50) await new Promise((r) => setTimeout(r, 0));
    if ((i / F) % 50 === 0) progress(i / n);
  }
  await enc.flush(); enc.close();
  if (failure) throw failure;
  return new Blob([writer.finish(n)], { type: 'audio/ogg' });
}

self.onmessage = async (e) => {
  const { id, channels, sampleRate, format, bits, kbps, outRate, title } = e.data;
  const progress = (v) => self.postMessage({ id, type: 'progress', value: v });
  try {
    let rate = outRate || sampleRate;
    if (format === 'opus') rate = 48000;
    if (format === 'mp3' && ![32000, 44100, 48000].includes(rate)) rate = 48000;
    let chs = channels;
    if (rate !== sampleRate) chs = chs.map((c, i) => resample(c, sampleRate, rate, 16, (p) => progress(p * 0.4 / chs.length + i * 0.4 / chs.length)));
    const p2 = (v) => progress((rate !== sampleRate ? 0.4 : 0) + v * (rate !== sampleRate ? 0.6 : 1));
    let blob;
    if (format === 'wav') blob = new Blob([encodeWav(chs, rate, bits)], { type: 'audio/wav' });
    else if (format === 'flac') blob = new Blob([encodeFlac(chs, rate, bits, p2)], { type: 'audio/flac' });
    else if (format === 'mp3') blob = await encodeMp3(chs, rate, kbps, p2);
    else if (format === 'opus') blob = await encodeOpus(chs, kbps, title, p2);
    else throw new Error('Unknown format ' + format);
    self.postMessage({ id, type: 'done', blob, rate });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err) });
  }
};
