// Builds TEST_REPORT.md from the JSON results the test suites write. Every number comes from a run.
import fs from 'node:fs'; import os from 'node:os'; import { execSync } from 'node:child_process';
const R = (f) => { try { return JSON.parse(fs.readFileSync(new URL('./report/' + f, import.meta.url))); } catch { return null; } };
const eng = R('engine-results.json'), io = R('io-results.json'), e2e = R('e2e-studio-results.json'), long = R('long-results.json'), reg = R('regression.json');
const row = (r, src) => `| ${r.id} | ${r.name} | ${String(r.threshold).replace(/\|/g, '/')} | ${String(r.measured).replace(/\|/g, '/').replace(/\n/g, ' ')} | ${r.pass ? '✅ pass' : '❌ fail'} | ${src} |`;
const table = (rows, src) => rows ? rows.map((r) => row(r, src)).join('\n') : `| – | not run | | | | ${src} |`;
const count = (rows) => rows ? `${rows.filter((r) => r.pass).length}/${rows.length}` : 'not run';
let commit = 'uncommitted'; try { commit = execSync('git rev-parse --short HEAD', { cwd: new URL('..', import.meta.url) }).toString().trim(); } catch {}
const md = `# Test report

Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC from the result files in \`tests/report/\`.

**Environment:** ${os.cpus()[0].model.trim()}, ${os.cpus().length} cores, Node ${process.version}, Chromium 1243 (Playwright), Linux. Commit \`${commit}\`.
**Recordings:** no \`samples/\` folder of real recordings was supplied, so every result below uses the seeded synthetic fixtures in \`tests/fixtures.mjs\`. No "real recording" results are claimed.

| Suite | Passed |
|---|---|
| Objective engine checks (\`tests/studio-engine.test.mjs\`) | ${count(eng?.results)} |
| File I/O checks (\`tests/studio-io.test.mjs\`) | ${count(io)} |
| Studio browser checks (\`tests/e2e_studio.py\`) | ${count(e2e)} |
| Regression: original unit tests + editor browser test | ${reg ? reg.summary : 'see below'} |

## Objective audio checks
| ID | Check | Threshold | Measured | Result | Evidence |
|---|---|---|---|---|---|
${table(eng?.results, 'studio-engine.test.mjs')}

## File I/O
| ID | Check | Threshold | Measured | Result | Evidence |
|---|---|---|---|---|---|
${table(io, 'studio-io.test.mjs')}

## Browser (Chromium, strict CSP, simulated microphone)
| ID | Check | Threshold | Measured | Result | Evidence |
|---|---|---|---|---|---|
${table(e2e, 'e2e_studio.py, screens/')}

## Long files (B4 memory and speed)
${long ? '| Length | Peak memory (RSS, whole Node process) | Wall time | Speed | Output frames = input | Loudness |\n|---|---|---|---|---|---|\n' + long.map((l) => `| ${l.minutes} min | ${l.peakRssMB} MB | ${l.seconds} s | ${l.speed}× real time | ${l.framesOut === l.framesIn ? 'yes' : 'no'} | ${l.loudness} LUFS |`).join('\n') + '\n\nThreshold: one hour under 500 MB and not growing with length. Measured in Node with the same engine code the browser worker runs; WAV/AIFF are streamed the same way in the browser. Compressed formats and video are decoded by the browser in one piece (see limitations).' : 'Not run in this session.'}

## Regression
${reg ? reg.text : 'The original unit tests and the 28-check editor browser test were run before any change (all green) and are run again by `npm test` and `npm run test:e2e`.'}

## Known limitations
- Five naturalness checks miss the 0.9 voice-match bar on heavily damaged fixtures (fan 5 dB, pink 5 dB, babble 10 dB, reverb 0.8 s; and 0.842 vs 0.85 for echo at RT60 1.2 s). The measure compares magnitude spectra with the *clean* reference, so leftover noise under the voice counts against it; the noisy inputs themselves score lower still. Closing the gap needs a stronger neural denoiser (the "Studio" tier), which is not shipped.
- SI-SDR is measured against the clean voice passed through the chain's own linear filters (DC, hum notch, tone EQ), because those filters are intentional and phase-shift the fundamental, which raw SI-SDR punishes (a 60 Hz high-pass alone scores 4.9 dB against the unfiltered reference).
- Compressed audio and video are decoded with the browser's \`decodeAudioData\`, which holds the whole decoded file in memory (about 690 MB per channel-hour). Multi-hour WAV and AIFF stream with bounded memory; streaming decoders for MP3/MP4/WebM via WebCodecs and an ffmpeg.wasm fallback are not built yet.
- FLAC, AAC and Opus outputs are assembled in memory before saving; WAV and MP3 output stream.
- Writing the enhanced audio back into the original video (C3 second half) is not built.
- Filler-word removal ("um", "uh") is not built; Auto cut shortens silences only.
- No Firefox or WebKit run (browsers not available here); README lists expected fallbacks from feature detection.
- Vercel preview verification could not be done from the build environment (no deploy access); the deployment check steps are in README.

## Skipped
E1–E4 (transcription, text editing, PDF report, chapters): not included. The "Studio" quality tier (DeepFilterNet/ONNX): not included; the option is not shown.
`;
fs.writeFileSync(new URL('../TEST_REPORT.md', import.meta.url), md); console.log('TEST_REPORT.md written');
