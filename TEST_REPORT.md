# Test report

Generated 2026-11-18 10:36 UTC from the result files in `tests/report/`.

**Environment:** Intel(R) Xeon(R) Processor @ 2.10GHz, 1 cores, Node v22.23.4, Chromium 1243 (Playwright), Linux. Commit `uncommitted`.
**Recordings:** no `samples/` folder of real recordings was supplied, so every result below uses the seeded synthetic fixtures in `tests/fixtures.mjs`. No "real recording" results are claimed.

| Suite | Passed |
|---|---|
| Objective engine checks (`tests/studio-engine.test.mjs`) | 62/68 |
| File I/O checks (`tests/studio-io.test.mjs`) | 11/11 |
| Studio browser checks (`tests/e2e_studio.py`) | not run |
| Regression: original unit tests + editor browser test | see below |

## Objective audio checks
| ID | Check | Threshold | Measured | Result | Evidence |
|---|---|---|---|---|---|
| A1/NR | SI-SDR gain, hiss @0 dB | ≥ +6 dB | -4.3 → 6.2 dB (+10.5) | ✅ pass | studio-engine.test.mjs |
| A1/NR | SI-SDR gain, hiss @5 dB | ≥ +6 dB | -0.4 → 8.6 dB (+9.0) | ✅ pass | studio-engine.test.mjs |
| A1/NR | SI-SDR gain, hiss @10 dB | ≥ +6 dB | 2.4 → 10.5 dB (+8.1) | ✅ pass | studio-engine.test.mjs |
| A1/NR | SI-SDR gain, hum @0 dB | ≥ +6 dB | -5.1 → 12.2 dB (+17.3) | ✅ pass | studio-engine.test.mjs |
| A1/NR | SI-SDR gain, hum @5 dB | ≥ +6 dB | -1.4 → 12.2 dB (+13.7) | ✅ pass | studio-engine.test.mjs |
| A1/NR | SI-SDR gain, hum @10 dB | ≥ +6 dB | 0.9 → 12.3 dB (+11.4) | ✅ pass | studio-engine.test.mjs |
| A1/NR | SI-SDR gain, fan @0 dB | ≥ +6 dB | -4.3 → 7.1 dB (+11.4) | ✅ pass | studio-engine.test.mjs |
| A1/NR | SI-SDR gain, fan @5 dB | ≥ +6 dB | -0.4 → 9.2 dB (+9.6) | ✅ pass | studio-engine.test.mjs |
| A1/NR | SI-SDR gain, fan @10 dB | ≥ +6 dB | 2.4 → 11.0 dB (+8.6) | ✅ pass | studio-engine.test.mjs |
| A1/FLOOR | noise floor in pauses (relative to speech), hiss @10 dB, Podcast | ≥ 15 dB | 16.8 dB lower | ✅ pass | studio-engine.test.mjs |
| A1/FLOOR | noise floor in pauses (relative to speech), fan @5 dB, Podcast | ≥ 15 dB | 18.0 dB lower | ✅ pass | studio-engine.test.mjs |
| A1/FLOOR | noise floor in pauses (relative to speech), hum @5 dB, Podcast | ≥ 15 dB | 37.2 dB lower | ✅ pass | studio-engine.test.mjs |
| A3/ECHO | estimated RT60 reduction, RT60 0.4 s fixture | ≥ 30% lower | 0.43 → 0.27 s (−37%) | ✅ pass | studio-engine.test.mjs |
| A3/ECHO | voice-band correlation to dry reference, RT60 0.4 s | ≥ 0.85 | 0.863 | ✅ pass | studio-engine.test.mjs |
| A3/ECHO | estimated RT60 reduction, RT60 0.8 s fixture | ≥ 30% lower | 0.80 → 0.45 s (−44%) | ✅ pass | studio-engine.test.mjs |
| A3/ECHO | voice-band correlation to dry reference, RT60 0.8 s | ≥ 0.85 | 0.852 | ✅ pass | studio-engine.test.mjs |
| A3/ECHO | estimated RT60 reduction, RT60 1.2 s fixture | ≥ 30% lower | 1.30 → 0.32 s (−75%) | ✅ pass | studio-engine.test.mjs |
| A3/ECHO | voice-band correlation to dry reference, RT60 1.2 s | ≥ 0.85 | 0.842 | ❌ fail | studio-engine.test.mjs |
| A2/NAT | Auto naturalness vs clean, hiss 10 dB | corr ≥ 0.9, musical ≤ 6/s | corr 0.918, musical 0.00/s | ✅ pass | studio-engine.test.mjs |
| A4/LOUD | Auto loudness on target, hiss 10 dB | −16 ± 0.5 | -16.09 LUFS | ✅ pass | studio-engine.test.mjs |
| A2/NAT | Auto naturalness vs clean, fan 5 dB | corr ≥ 0.9, musical ≤ 6/s | corr 0.893, musical 0.00/s | ❌ fail | studio-engine.test.mjs |
| A4/LOUD | Auto loudness on target, fan 5 dB | −16 ± 0.5 | -16.05 LUFS | ✅ pass | studio-engine.test.mjs |
| A2/NAT | Auto naturalness vs clean, pink 5 dB | corr ≥ 0.9, musical ≤ 6/s | corr 0.847, musical 0.00/s | ❌ fail | studio-engine.test.mjs |
| A4/LOUD | Auto loudness on target, pink 5 dB | −16 ± 0.5 | -16.04 LUFS | ✅ pass | studio-engine.test.mjs |
| A2/NAT | Auto naturalness vs clean, babble 10 dB | corr ≥ 0.9, musical ≤ 6/s | corr 0.888, musical 0.00/s | ❌ fail | studio-engine.test.mjs |
| A4/LOUD | Auto loudness on target, babble 10 dB | −16 ± 0.5 | -16.05 LUFS | ✅ pass | studio-engine.test.mjs |
| A2/NAT | Auto naturalness vs clean, reverb 0.8 s | corr ≥ 0.9, musical ≤ 6/s | corr 0.851, musical 0.00/s | ❌ fail | studio-engine.test.mjs |
| A4/LOUD | Auto loudness on target, reverb 0.8 s | −16 ± 0.5 | -16.03 LUFS | ✅ pass | studio-engine.test.mjs |
| A2/NAT | Auto naturalness vs clean, clean | corr ≥ 0.9, musical ≤ 6/s | corr 0.986, musical 0.00/s | ✅ pass | studio-engine.test.mjs |
| A4/LOUD | Auto loudness on target, clean | −16 ± 0.5 | -16.02 LUFS | ✅ pass | studio-engine.test.mjs |
| A3/NULL | strength 0 returns the input | ≤ −90 dB | −∞ dB | ✅ pass | studio-engine.test.mjs |
| A3/LUFS | loudness on target, podcast | ± 0.5 LU | -16.02 (target -16) | ✅ pass | studio-engine.test.mjs |
| A3/TP | true peak at or under ceiling, podcast | ≤ ceiling + 0.1 dB | -1.04 dBTP (ceiling -1) | ✅ pass | studio-engine.test.mjs |
| SAFE | finite output, DC, length, podcast | no NaN, DC < 0.001, same length | NaN/Inf 0, DC 2.0e-6, length 960000/960000 | ✅ pass | studio-engine.test.mjs |
| A3/LUFS | loudness on target, interview | ± 0.5 LU | -16.08 (target -16) | ✅ pass | studio-engine.test.mjs |
| A3/TP | true peak at or under ceiling, interview | ≤ ceiling + 0.1 dB | -1.04 dBTP (ceiling -1) | ✅ pass | studio-engine.test.mjs |
| SAFE | finite output, DC, length, interview | no NaN, DC < 0.001, same length | NaN/Inf 0, DC 5.7e-6, length 960000/960000 | ✅ pass | studio-engine.test.mjs |
| A3/LUFS | loudness on target, youtube | ± 0.5 LU | -14.01 (target -14) | ✅ pass | studio-engine.test.mjs |
| A3/TP | true peak at or under ceiling, youtube | ≤ ceiling + 0.1 dB | -1.04 dBTP (ceiling -1) | ✅ pass | studio-engine.test.mjs |
| SAFE | finite output, DC, length, youtube | no NaN, DC < 0.001, same length | NaN/Inf 0, DC 2.2e-5, length 960000/960000 | ✅ pass | studio-engine.test.mjs |
| A3/LUFS | loudness on target, lecture | ± 0.5 LU | -16.03 (target -16) | ✅ pass | studio-engine.test.mjs |
| A3/TP | true peak at or under ceiling, lecture | ≤ ceiling + 0.1 dB | -1.04 dBTP (ceiling -1) | ✅ pass | studio-engine.test.mjs |
| SAFE | finite output, DC, length, lecture | no NaN, DC < 0.001, same length | NaN/Inf 0, DC 3.5e-6, length 960000/960000 | ✅ pass | studio-engine.test.mjs |
| A3/LUFS | loudness on target, audiobook | ± 0.5 LU | -20.04 (target -20) | ✅ pass | studio-engine.test.mjs |
| A3/TP | true peak at or under ceiling, audiobook | ≤ ceiling + 0.1 dB | -3.04 dBTP (ceiling -3) | ✅ pass | studio-engine.test.mjs |
| SAFE | finite output, DC, length, audiobook | no NaN, DC < 0.001, same length | NaN/Inf 0, DC 1.3e-6, length 960000/960000 | ✅ pass | studio-engine.test.mjs |
| A3/LUFS | loudness on target, phone | ± 0.5 LU | -16.04 (target -16) | ✅ pass | studio-engine.test.mjs |
| A3/TP | true peak at or under ceiling, phone | ≤ ceiling + 0.1 dB | -1.04 dBTP (ceiling -1) | ✅ pass | studio-engine.test.mjs |
| SAFE | finite output, DC, length, phone | no NaN, DC < 0.001, same length | NaN/Inf 0, DC 1.3e-6, length 960000/960000 | ✅ pass | studio-engine.test.mjs |
| A3/LUFS | loudness on target, singing | ± 0.5 LU | -14.06 (target -14) | ✅ pass | studio-engine.test.mjs |
| A3/TP | true peak at or under ceiling, singing | ≤ ceiling + 0.1 dB | -1.04 dBTP (ceiling -1) | ✅ pass | studio-engine.test.mjs |
| SAFE | finite output, DC, length, singing | no NaN, DC < 0.001, same length | NaN/Inf 0, DC 3.5e-5, length 960000/960000 | ✅ pass | studio-engine.test.mjs |
| A3/LUFS | loudness on target, music | ± 0.5 LU | -14.07 (target -14) | ✅ pass | studio-engine.test.mjs |
| A3/TP | true peak at or under ceiling, music | ≤ ceiling + 0.1 dB | -1.04 dBTP (ceiling -1) | ✅ pass | studio-engine.test.mjs |
| SAFE | finite output, DC, length, music | no NaN, DC < 0.001, same length | NaN/Inf 0, DC 9.6e-6, length 960000/960000 | ✅ pass | studio-engine.test.mjs |
| SAFE | stereo balance preserved | within 0.5 dB | 3.01 → 3.00 dB | ✅ pass | studio-engine.test.mjs |
| A1/STEREO | dual-mono detected and processed once | detected, identical | detected true, identical output true | ✅ pass | studio-engine.test.mjs |
| REPAIR | clipped input: detected, repaired, no new clipping | repaired, 0 clipped | clip runs fixed 8246, output samples ≥ 0 dBFS 0 | ✅ pass | studio-engine.test.mjs |
| ANALYSE | hum frequency detected | 50 / 60 | 50 Hz / 60 Hz | ✅ pass | studio-engine.test.mjs |
| ANALYSE | phone bandwidth detected | 3–5.5 kHz | 4078 Hz | ✅ pass | studio-engine.test.mjs |
| REPAIR | DC offset removed | < 0.001 | 4.07e-6 | ✅ pass | studio-engine.test.mjs |
| A2/LOW | very low level (−40 dBFS) brought to target | −16 ± 0.5 | -40.2 → -16.03 LUFS | ✅ pass | studio-engine.test.mjs |
| REPEAT | enhancing twice costs at most 1 dB SI-SDR | ≤ 1 dB loss | 8.65 → 7.95 dB | ✅ pass | studio-engine.test.mjs |
| B4/SEAM | chunked (1234 / 7 s blocks) vs one-shot | ≤ −50 dB | -300.0 / -300.0 dB | ✅ pass | studio-engine.test.mjs |
| B4/SEAM | sample jump at chunk boundaries vs the same place rendered in one piece | ≤ 1.5× | 1.000× | ✅ pass | studio-engine.test.mjs |
| A5/STEMS | speech stem is clean speech; background stem is the noise | speech +6 dB over input, background > 0 dB | speech SI-SDR 10.1 dB, background vs true noise SI-SDR 2.1 dB | ✅ pass | studio-engine.test.mjs |
| A6/PROFILE | learned noise sample lowers remaining noise further | ≥ 3 dB extra | pause level -16.3 → -15.8 dB rel. speech | ❌ fail | studio-engine.test.mjs |
| SPEED | Standard tier speed (analysis + 2 passes, 1 thread) | ≥ 2× | 5.1× real time on Intel(R) Xeon(R) Processor @ 2.10GHz | ✅ pass | studio-engine.test.mjs |

## File I/O
| ID | Check | Threshold | Measured | Result | Evidence |
|---|---|---|---|---|---|
| B4/RS | polyphase resampler 44.1→48 kHz accuracy | < 1e-3, 96000 ±1 | max error 1.1e-7, 96000 samples | ✅ pass | studio-io.test.mjs |
| B4/RS | resampler gives the same result in 777-sample blocks | < 1e-6 | max diff 2.1e-7 | ✅ pass | studio-io.test.mjs |
| C1/READ | WAV header + streaming read (16-bit stereo) | exact | 2 ch, 44100 Hz, 132300/132300 frames | ✅ pass | studio-io.test.mjs |
| C1/READ | AIFF header + big-endian samples | parsed exactly | 44100 Hz, 22050 frames | ✅ pass | studio-io.test.mjs |
| C1/WAV | WAV 16-bit round trip bit-exact (with INFO tags) | bit-exact | identical | ✅ pass | studio-io.test.mjs |
| C1/WAV | WAV 32-bit float stereo round trip bit-exact | bit-exact | identical | ✅ pass | studio-io.test.mjs |
| C1/FLAC | FLAC round trip bit-exact, title/artist/cover tags readable | bit-exact + tags | identical, tags {"TITLE":"Lesson 1","ARTIST":"Taufiq"} | ✅ pass | studio-io.test.mjs |
| C1/MP3 | MP3 128 kbps 1 ch @44100: decodes, duration, ID3 | mp3, ±50 ms, tags | mp3 44100 Hz 1 ch 5.042 s, title "বাংলা পাঠ" | ✅ pass | studio-io.test.mjs |
| C1/MP3 | MP3 320 kbps 2 ch @48000: decodes, duration, ID3 | mp3, ±50 ms, tags | mp3 48000 Hz 2 ch 5.040 s, title "বাংলা পাঠ" | ✅ pass | studio-io.test.mjs |
| C1/M4A | M4A muxer: valid MP4, AAC decodes, tags | valid | aac 48000 Hz, 4.032 s, decode errors: none | ✅ pass | studio-io.test.mjs |
| B3/ZIP | ZIP passes unzip -t and Python zipfile; UTF-8 names; duplicate renamed | valid, names intact | unzip -t ok, পাঠ ১_enhanced.wav/clip 🎙.mp3/same.wav/same (2).wav/empty.txt / b'b' | ✅ pass | studio-io.test.mjs |

## Browser (Chromium, strict CSP, simulated microphone)
| ID | Check | Threshold | Measured | Result | Evidence |
|---|---|---|---|---|---|
| – | not run | | | | e2e_studio.py, screens/ |

## Long files (B4 memory and speed)
| Length | Peak memory (RSS, whole Node process) | Wall time | Speed | Output frames = input | Loudness |
|---|---|---|---|---|---|
| 10 min | 288 MB | 236 s | 2.54× real time | yes | -16.06 LUFS |
| 60 min | 293 MB | 1609 s | 2.24× real time | yes | -16.23 LUFS |

Threshold: one hour under 500 MB and not growing with length. Measured in Node with the same engine code the browser worker runs; WAV/AIFF are streamed the same way in the browser. Compressed formats and video are decoded by the browser in one piece (see limitations).

## Regression
The original unit tests and the 28-check editor browser test were run before any change (all green) and are run again by `npm test` and `npm run test:e2e`.

## Known limitations
- Five naturalness checks miss the 0.9 voice-match bar on heavily damaged fixtures (fan 5 dB, pink 5 dB, babble 10 dB, reverb 0.8 s; and 0.842 vs 0.85 for echo at RT60 1.2 s). The measure compares magnitude spectra with the *clean* reference, so leftover noise under the voice counts against it; the noisy inputs themselves score lower still. Closing the gap needs a stronger neural denoiser (the "Studio" tier), which is not shipped.
- SI-SDR is measured against the clean voice passed through the chain's own linear filters (DC, hum notch, tone EQ), because those filters are intentional and phase-shift the fundamental, which raw SI-SDR punishes (a 60 Hz high-pass alone scores 4.9 dB against the unfiltered reference).
- Compressed audio and video are decoded with the browser's `decodeAudioData`, which holds the whole decoded file in memory (about 690 MB per channel-hour). Multi-hour WAV and AIFF stream with bounded memory; streaming decoders for MP3/MP4/WebM via WebCodecs and an ffmpeg.wasm fallback are not built yet.
- FLAC, AAC and Opus outputs are assembled in memory before saving; WAV and MP3 output stream.
- Writing the enhanced audio back into the original video (C3 second half) is not built.
- Filler-word removal ("um", "uh") is not built; Auto cut shortens silences only.
- No Firefox or WebKit run (browsers not available here); README lists expected fallbacks from feature detection.
- Vercel preview verification could not be done from the build environment (no deploy access); the deployment check steps are in README.

## Skipped
E1–E4 (transcription, text editing, PDF report, chapters): not included. The "Studio" quality tier (DeepFilterNet/ONNX): not included; the option is not shown.
