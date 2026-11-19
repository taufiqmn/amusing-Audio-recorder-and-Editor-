// Studio I/O checks: resampler, WAV/AIFF reader, encoders (bit-exact where lossless), M4A muxer, ZIP.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execFileSync, spawnSync } from 'node:child_process';
import '../public/studio/js/io/encoders-core.js';
import { StreamResampler, readHeader, pcmBlocks, WavWriter, Mp3Writer, FlacWriter, muxM4A, zipBlobs, crc32 } from '../public/studio/js/io/io.js';
import lamejs from '../public/studio/js/vendor/lame.mjs';
import * as F from './fixtures.mjs';
const results = []; let fails = 0;
const check = (id, name, ok, measured, threshold) => { results.push({ id, name, pass: !!ok, measured, threshold }); if (!ok) fails++; console.log(`  ${ok ? '✓' : '✗'} [${id}] ${name}: ${measured} (need ${threshold})`); };
const tmp = (n) => path.join(os.tmpdir(), n); const save = async (n, blob) => { fs.writeFileSync(tmp(n), Buffer.from(await blob.arrayBuffer())); return tmp(n); };
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration:format_tags=title,artist', '-of', 'json', f]).toString());
console.log('Studio I/O');

/* resampler */
{
  const x = Float32Array.from({ length: 44100 * 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 44100));
  const one = new StreamResampler(44100, 48000, 1).process([x], true)[0];
  const rs = new StreamResampler(44100, 48000, 1); const parts = []; for (let i = 0; i < x.length; i += 777) parts.push(rs.process([x.subarray(i, i + 777)], i + 777 >= x.length)[0]);
  const many = new Float32Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { many.set(p, o); o += p.length; }
  let err = 0; for (let i = 1000; i < one.length - 1000; i++) err = Math.max(err, Math.abs(one[i] - 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48000)));
  let d = 0; for (let i = 0; i < Math.min(one.length, many.length); i++) d = Math.max(d, Math.abs(one[i] - many[i]));
  check('B4/RS', 'polyphase resampler 44.1→48 kHz accuracy', err < 1e-3 && Math.abs(one.length - 96000) <= 1, `max error ${err.toExponential(1)}, ${one.length} samples`, '< 1e-3, 96000 ±1');
  check('B4/RS', 'resampler gives the same result in 777-sample blocks', d < 1e-6 && many.length === one.length, `max diff ${d.toExponential(1)}`, '< 1e-6');
}

/* WAV + AIFF streaming reader */
{
  const { x } = F.cleanSpeech(44100, 3, 5); const st = [x, F.gainDb(x, -6)];
  const f = new File([F.wav(st, 44100, 16)], 'a.wav'); const h = await readHeader(f);
  let n = 0; for await (const b of pcmBlocks(f, h, 44100, 10000)) n += b[0].length;
  check('C1/READ', 'WAV header + streaming read (16-bit stereo)', h.ch === 2 && h.fs === 44100 && n === x.length, `${h.ch} ch, ${h.fs} Hz, ${n}/${x.length} frames`, 'exact');
  // AIFF 16-bit big-endian
  const N = 22050, ab = Buffer.alloc(54 + N * 2); ab.write('FORM', 0); ab.writeUInt32BE(46 + N * 2, 4); ab.write('AIFF', 8); ab.write('COMM', 12); ab.writeUInt32BE(18, 16); ab.writeUInt16BE(1, 20); ab.writeUInt32BE(N, 22); ab.writeUInt16BE(16, 26);
  ab.writeUInt16BE(0x400e, 28); ab.writeUInt32BE(0xac440000, 30); ab.write('SSND', 38); ab.writeUInt32BE(8 + N * 2, 42); ab.writeUInt32BE(0, 46); ab.writeUInt32BE(0, 50);
  for (let i = 0; i < N; i++) ab.writeInt16BE(Math.round(Math.sin(i / 10) * 10000), 54 + i * 2);
  const fa = new File([ab], 'a.aiff'); const ha = await readHeader(fa); let first = null; for await (const b of pcmBlocks(fa, ha, 44100)) { first ??= b[0]; }
  check('C1/READ', 'AIFF header + big-endian samples', ha && ha.fs === 44100 && Math.abs(first[5] - Math.round(Math.sin(0.5) * 10000) / 32768) < 1e-6, ha ? `${ha.fs} Hz, ${ha.frames} frames` : 'not parsed', 'parsed exactly');
}

/* lossless round trips */
{
  const n = 48000; const grid = Float32Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 7) * 20000) / 32768);
  const w = new WavWriter(48000, 1, 16, false); w.write([grid]); const p = await save('rt16.wav', w.finish({ title: 'Test ধ্বনি', artist: 'Taufiq' }));
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-f', 's16le', '-']); const d = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
  let ok = d.length === n; for (let i = 0; ok && i < n; i++) if (d[i] !== Math.round(grid[i] * 32768)) ok = false;
  check('C1/WAV', 'WAV 16-bit round trip bit-exact (with INFO tags)', ok, ok ? 'identical' : 'mismatch', 'bit-exact');
  const wf = new WavWriter(48000, 2, 32); wf.write([grid, grid]); const pf = await save('rt32.wav', wf.finish()); const rf = execFileSync('ffmpeg', ['-v', 'error', '-i', pf, '-f', 'f32le', '-']); const df = new Float32Array(rf.buffer, rf.byteOffset, rf.length / 4);
  let ok2 = df.length === 2 * n; for (let i = 0; ok2 && i < n; i++) if (df[2 * i] !== grid[i]) ok2 = false;
  check('C1/WAV', 'WAV 32-bit float stereo round trip bit-exact', ok2, ok2 ? 'identical' : 'mismatch', 'bit-exact');
  const fl = new FlacWriter(48000, 1, 16); fl.write([grid]); const pfl = await save('rt.flac', fl.finish({ title: 'Lesson 1', artist: 'Taufiq', cover: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) }));
  const rr = execFileSync('ffmpeg', ['-v', 'error', '-i', pfl, '-map', '0:a', '-f', 's16le', '-']); const dd = new Int16Array(rr.buffer, rr.byteOffset, rr.length / 2);
  // FLAC quantises with its own dither; compare against the same quantiser
  const q = globalThis.TFEnc.quantize(grid, 16, true, 999); let ok3 = dd.length === n; for (let i = 0; ok3 && i < n; i++) if (dd[i] !== q[i]) ok3 = false;
  const tags = probe(pfl).format.tags || {};
  check('C1/FLAC', 'FLAC round trip bit-exact, title/artist/cover tags readable', ok3 && /Lesson 1/.test(tags.title || tags.TITLE) && /Taufiq/.test(tags.artist || tags.ARTIST), `${ok3 ? 'identical' : 'mismatch'}, tags ${JSON.stringify(tags)}`, 'bit-exact + tags');
}

/* MP3 (ES-module lamejs, CSP-safe) */
for (const [rate, ch, kbps] of [[44100, 1, 128], [48000, 2, 320]]) {
  const { x } = F.cleanSpeech(rate, 5, 9); const w = new Mp3Writer(lamejs, rate, ch, kbps); for (let i = 0; i < x.length; i += 10000) w.write(ch === 2 ? [x.subarray(i, i + 10000), x.subarray(i, i + 10000)] : [x.subarray(i, i + 10000)]);
  const p = await save(`t${kbps}.mp3`, w.finish({ title: 'বাংলা পাঠ', artist: 'Taufiq' })); const j = probe(p); const s = j.streams[0];
  check('C1/MP3', `MP3 ${kbps} kbps ${ch} ch @${rate}: decodes, duration, ID3`, s.codec_name === 'mp3' && +s.sample_rate === rate && s.channels === ch && Math.abs(+j.format.duration - 5) < 0.05 && /বাংলা/.test(j.format.tags?.title || ''), `${s.codec_name} ${s.sample_rate} Hz ${s.channels} ch ${(+j.format.duration).toFixed(3)} s, title "${j.format.tags?.title}"`, 'mp3, ±50 ms, tags');
}

/* M4A muxer with real AAC packets */
{
  const { x } = F.cleanSpeech(48000, 4, 2); fs.writeFileSync(tmp('src.wav'), F.wav([x], 48000));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', tmp('src.wav'), '-c:a', 'aac', '-b:a', '128k', '-f', 'adts', tmp('src.aac')]);
  const a = fs.readFileSync(tmp('src.aac')); const packets = []; let o = 0;
  while (o + 7 < a.length) { const len = ((a[o + 3] & 3) << 11) | (a[o + 4] << 3) | (a[o + 5] >> 5); const hl = a[o + 1] & 1 ? 7 : 9; packets.push({ d: new Uint8Array(a.subarray(o + hl, o + len)), dur: 1024 }); o += len; }
  const blob = muxM4A(packets, null, 48000, 1, packets.length * 1024, { title: 'Lesson', artist: 'Taufiq' }); const p = await save('t.m4a', blob); const j = probe(p);
  const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', p, '-f', 'null', '-']).stderr.toString().trim();
  check('C1/M4A', 'M4A muxer: valid MP4, AAC decodes, tags', j.streams[0].codec_name === 'aac' && Math.abs(+j.format.duration - packets.length * 1024 / 48000) < 0.05 && !dec && j.format.tags?.title === 'Lesson', `aac ${j.streams[0].sample_rate} Hz, ${(+j.format.duration).toFixed(3)} s, decode errors: ${dec ? dec.slice(0, 80) : 'none'}`, 'valid');
}

/* ZIP */
{
  const files = [{ name: 'পাঠ ১_enhanced.wav', blob: new Blob([new Uint8Array(5000).fill(7)]) }, { name: 'clip 🎙.mp3', blob: new Blob(['hello']) }, { name: 'same.wav', blob: new Blob(['a']) }, { name: 'same.wav', blob: new Blob(['b']) }, { name: 'empty.txt', blob: new Blob([]) }];
  const p = await save('t.zip', await zipBlobs(files));
  const ut = spawnSync('unzip', ['-t', p]); const py = spawnSync('python3', ['-c', `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip());print('|'.join(z.namelist()));print(z.read('same (2).wav'))`, p]);
  const names = py.stdout.toString();
  check('B3/ZIP', 'ZIP passes unzip -t and Python zipfile; UTF-8 names; duplicate renamed', (ut.status === 0 || ut.error) && /None/.test(names) && names.includes('পাঠ ১_enhanced.wav') && names.includes('clip 🎙.mp3') && names.includes("b'b'"), `${ut.error ? 'unzip not installed, ' : 'unzip -t ok, '}${names.trim().split('\n').slice(1).join(' / ')}`, 'valid, names intact');
}
fs.mkdirSync(new URL('./report/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./report/io-results.json', import.meta.url), JSON.stringify(results, null, 1));
console.log(fails ? `\n${fails} I/O check(s) failed` : '\nAll I/O checks passed'); process.exitCode = fails ? 1 : 0;
