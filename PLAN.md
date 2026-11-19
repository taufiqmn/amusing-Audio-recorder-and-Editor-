# Plan (as built)

**Starting point.** The repository is Takeflow (single-waveform editor, `public/index.html`, shared engine in `public/js/`). Its tests were run first and stayed green (unit suite, 28/28 browser checks). The new Studio lives in `public/studio/` with its own service worker (scope `/studio/`), so it cannot break the editor; the editor links to it from its header.

**File layout**
- `public/studio/js/engine/` streaming DSP: `stages.js` (repair, log-MMSE + echo + noise-profile spectral stage, RNNoise wrapper with residual, tone, de-esser, leveler, compressor, gap expander, 4× true-peak limiter), `analyze.js` (BS.1770 loudness with exact blending, Auto analysis, naturalness guard, spectrograms), `chain.js` (stage graph, two-pass pipeline), `presets.js`.
- `public/studio/js/io/io.js` streaming resampler, WAV/AIFF streaming reader, WAV/MP3/FLAC/Opus/AAC-M4A writers with tags, M4A muxer, store-only ZIP.
- `public/studio/js/workers/job-worker.js` one job per worker (pool on the main thread), `mic-worklet.js`.
- `public/studio/js/app.js` interface. `tests/` fixtures, unit, objective, browser and long-file tests.

**Model decisions.** RNNoise (BSD-style licence, 112 KB WASM) kept as the neural stage. A heavier "Studio" tier (DeepFilterNet via ONNX Runtime Web) was not shipped: its pre/post-processing would have to be re-implemented in JavaScript and verified, which did not fit; the tier is hidden rather than half-built. Instead a log-MMSE estimator with a bias-corrected quantile noise tracker was added; it measured far better on the fixtures than RNNoise alone (see TUNING).

**Milestones** 1 engine + fixtures → 2 Enhance single file → 3 bulk queue + ZIP → 4 long files → 5 Convert → 6 Mic Check + record-then-enhance → 7 polish + accessibility. E-features (transcription, text editing, PDF report, chapters) are not included.

**Test per feature ID**: see the rows of `TEST_REPORT.md`; each row names its test file.
