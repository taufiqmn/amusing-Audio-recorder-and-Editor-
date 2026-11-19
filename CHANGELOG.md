# Changelog

## 2.0.0: Timeline home page + Enhance Studio
- Home page is now a clip-based timeline editor: cutter (C), select (S), undo, record at the playhead, Fill gaps switch, customizable keyboard shortcuts.
- The earlier Takeflow editor moved to `/classic`.
- `/studio/` added: Enhance (bulk), Convert, Mic Check (see 1.1.0 below).

## 1.1.0 — Enhance Studio
- New `/studio/` with Enhance (bulk queue, folders, presets incl. Auto, A/B, spectrograms, stems, noise sample, ZIP), Convert (WAV/FLAC/MP3/M4A/Opus/OGG, tags, normalize, trim, video audio extraction) and Mic Check (with record-then-enhance).
- New streaming engine: repair, log-MMSE + RNNoise noise removal, room-echo removal, tone, de-esser, leveler, compressor, gap expander, true-peak limiter, exact two-pass loudness, naturalness guard.
- Strict Content-Security-Policy for the Studio; self-hosted fonts; no runtime network calls.
- Editor: link to the Studio; service-worker cache version bumped.

## 1.0.0 — Takeflow
- Voice recorder and editor with punch-in recording, enhancement presets and WAV/FLAC/MP3/Opus export.
