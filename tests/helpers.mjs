// Shared helpers for Node tests
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

export function synthSpeech(fs_, seconds, { noise = 0.01, hum = 0.004, seed = 7 } = {}) {
  let s = seed >>> 0;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const n = Math.round(fs_ * seconds);
  const x = new Float32Array(n);
  const voiced = new Uint8Array(n);
  let phase = 0, b0 = 0, b1 = 0, b2 = 0;
  // natural voices have dispersed harmonic phases (not sawtooth-aligned)
  const hp = Array.from({ length: 31 }, () => rnd() * 2 * Math.PI);
  for (let i = 0; i < n; i++) {
    const t = i / fs_;
    // syllables of ~0.25s, words separated by pauses; a long pause every 4s
    const inPause = (t % 4) > 3.2 || (t % 1.0) > 0.78;
    const syl = Math.max(0, Math.sin(Math.PI * ((t % 0.25) / 0.25)));
    const env = inPause ? 0 : Math.pow(syl, 0.6);
    const f0 = 120 + 25 * Math.sin(2 * Math.PI * 0.7 * t) + 10 * Math.sin(2 * Math.PI * 3.1 * t);
    phase += f0 / fs_; if (phase > 1) phase -= 1;
    let v = 0;
    for (let h = 1; h <= 30; h++) {
      const fh = f0 * h; if (fh > fs_ / 2.2) break;
      // crude formant weighting
      const fw = 1 / (1 + Math.pow((fh - 600) / 300, 2)) + 0.6 / (1 + Math.pow((fh - 1700) / 400, 2)) + 0.3 / (1 + Math.pow((fh - 2800) / 500, 2));
      v += (Math.sin(2 * Math.PI * h * phase + hp[h]) / h) * fw;
    }
    x[i] = 0.35 * env * v;
    voiced[i] = env > 0.05 ? 1 : 0;
    // pink-ish noise (Paul Kellet economy) + hum
    const wn = rnd() * 2 - 1;
    b0 = 0.99765 * b0 + wn * 0.099046; b1 = 0.963 * b1 + wn * 0.2965164; b2 = 0.57 * b2 + wn * 1.0526913;
    const pink = (b0 + b1 + b2 + wn * 0.1848) * 0.25;
    x[i] += noise * pink + hum * Math.sin(2 * Math.PI * 60 * t);
  }
  return { x, voiced };
}

export function writeWavFloat(path, x, sr) {
  const b = Buffer.alloc(44 + x.length * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 4, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34);
  b.write('data', 36); b.writeUInt32LE(x.length * 4, 40);
  for (let i = 0; i < x.length; i++) b.writeFloatLE(x[i], 44 + i * 4);
  fs.writeFileSync(path, b);
}

export function ffmpegLufs(path) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const txt = r.stderr.toString();
  const tail = txt.slice(txt.lastIndexOf('Summary'));
  const I = parseFloat((tail.match(/I:\s+(-?[\d.]+) LUFS/) || [])[1]);
  const TP = parseFloat((tail.match(/Peak:\s+(-?[\d.]+) dBFS/) || [])[1]);
  return { I, TP };
}

export function ffmpegDecodeF32(path, sr, ch = 1) {
  const buf = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path, '-f', 'f32le', '-ac', String(ch), '-ar', String(sr), '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

let failures = 0;
export function check(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { console.log('  ✗ ' + msg); failures++; }
}
export function done() { return failures; }
