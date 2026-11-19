# Amusing Audio Studio (Takeflow engine)

The home page (`public/index.html`) is a **timeline editor**: audio lives on a timeline as clips.

- **C** cutter tool: click anywhere to cut. **K** cuts at the playhead.
- **S** select tool: click a clip or drag a range, then **Delete**. **Ctrl+Z / Ctrl+Y** undo and redo.
- **R** records at the playhead. New audio is inserted there; nothing is overwritten.
- **Fill gaps** on: deleting closes the gap and a new take pushes the rest right. Off: deleted parts stay empty, and a take fills the gap (later audio moves only if the take is longer).
- **New recording…** asks first, then clears the timeline (Ctrl+Z brings it back).
- **Shortcuts are customizable**: click *Shortcuts* in the header, pick an action, press the new keys. Saved in the browser; works on any keyboard layout (keys are matched by physical position).
- **Enhance** (AI noise removal, presets, loudness) with an original/enhanced switch (**B**), and **Export** to WAV, FLAC, MP3 or Opus.

- **Enhance Studio** at `/studio/`: bulk enhance (folders, presets, Auto, A/B, spectrograms, stems, ZIP), Convert (WAV, FLAC, MP3, M4A, Opus, OGG, video audio extraction) and Mic Check. It has its own engine in `public/studio/` and a strict Content-Security-Policy.

The original single-waveform editor is still available at `/classic` (`public/classic.html`). It shares `public/js/` with the timeline editor.


---

# Takeflow + Enhance Studio

A free, private audio workshop that runs entirely in the browser. Nothing is uploaded: every recording is processed on your own device, and the app keeps working offline after the first visit. It deploys as a static site with no build step.

## The four modes

**Record and Edit** (`/`, the Takeflow editor). Record, stop at a mistake, put the cursor just before it and record again: the new take replaces the rest with a click-free join. Select a section to delete it or re-record only that part. Includes undo, pause shortening, a one-click Enhance panel and export to WAV, FLAC, MP3 or Opus.

**Enhance** (`/studio/#enhance`). Drop one file, many files or a whole folder of audio or video. Pick a preset (or Auto, which listens first) and get cleaned, loudness-correct files back. Every file shows live progress with time left, a before-and-after player whose volume is matched so you judge quality rather than loudness, and before/after spectrograms. Download files one by one or all as one ZIP. Optional: separate "voice only" and "removed background" files, a noise sample you mark by dragging over a quiet part, and shortening of long silences.

**Convert** (`/studio/#convert`). Change format, sample rate or channels without enhancing; extract audio from video; optionally normalize loudness, trim silence and add title, artist and cover art.

**Mic Check** (`/studio/#mic`). Speak for 15 seconds and get plain advice on level, background noise, hum, room echo and distance, plus the best preset for your setup. The same page records a take and enhances it in one step (with undo back to the original).

### Presets
Auto · Podcast · Interview · YouTube narration · Lecture or classroom · Audiobook · Phone or Zoom call · Singing or vocal · Music-friendly · Custom. Save your own, rename by saving under a new name, and export or import them as JSON.

### Controls (all free)
Overall strength (0 % = untouched), noise removal, echo and room removal, background level, clarity, warmth, de-esser, volume evening, loudness target (LUFS), true-peak ceiling, quality tier (Standard or Fast), output format, bit depth, bitrate, sample rate, channels, file-name template (`{name}_enhanced.{ext}`), files processed at once, and "keep files" so the queue resumes after a reload.

### Formats
| | Formats |
|---|---|
| In | WAV, AIFF (streamed, any length), MP3, M4A, AAC, FLAC, OGG/OGA, Opus, WebM, MP4, MOV, MKV, 3GP (decoded by the browser) |
| Out | WAV 16/24/32-bit float, FLAC 16/24-bit, MP3 128–320 kbps, AAC in M4A, Opus, OGG (Opus codec) |

## Keyboard shortcuts (Studio; change them with the ⌨ button)
`O` add files · `F` add a folder · `P` play/pause the latest result · `B` original/enhanced · `Z` download all as ZIP · `C` clear finished · `1` `2` `3` switch mode · `?` show shortcuts. The editor's own shortcuts are listed under `?` on its page.

## Browser support
Tested automatically in Chromium (Chrome, Edge). Behaviour elsewhere follows from the features each browser exposes:

| Feature | Chrome / Edge | Safari 16.4+ | Firefox |
|---|---|---|---|
| Enhance, Convert, Mic Check, WAV/FLAC/MP3 output | yes | yes | yes |
| AAC (M4A), Opus, OGG output | yes | needs WebCodecs AudioEncoder; hidden if missing | hidden (no AAC/Opus WebCodecs encoder) |
| MKV input | yes | usually not decodable; shows a clear error | WebM yes, MKV varies |
| Folder drop | yes | yes | yes |

Firefox and WebKit were not available in the build environment, so the table above is derived from their published feature support, not from a test run. Formats a browser can't write are hidden with an explanation; they never fail at the end.

## Run locally
```
npm run serve            # http://localhost:8080 (the microphone needs localhost or https)
```

## Tests
```
npm test                 # unit + objective audio checks (needs ffmpeg; about 6 minutes)
npm run test:e2e         # browser tests, editor + Studio (needs Python Playwright + Chromium)
npm run test:long        # 10-minute and 1-hour memory and speed test
```
Results are written to `tests/report/`. `TEST_REPORT.md` summarises them; `tests/report/listen.html` lets you compare before and after by ear.

## Deploy
Push to GitHub and import into Vercel with default settings: `vercel.json` sets the output folder (`public`), no build, and the security headers (a strict Content-Security-Policy for `/studio/`). Netlify (`netlify.toml`) and Cloudflare Pages (`public/_headers`) are configured the same way.

## Honest limits
Adobe Podcast uses a large cloud neural network; this app uses a classic log-MMSE spectral denoiser, RNNoise (a small neural network) and signal processing, all in the browser. Measured results are in `TEST_REPORT.md`; known gaps are listed there.
