# Amusing Audio Studio (Takeflow engine)

The home page (`public/index.html`) is a **timeline editor**: audio lives on a timeline as clips.

- **C** cutter tool: click anywhere to cut. **K** cuts at the playhead.
- **S** select tool: click a clip or drag a range, then **Delete**. **Ctrl+Z / Ctrl+Y** undo and redo.
- **R** records at the playhead. New audio is inserted there; nothing is overwritten.
- **Fill gaps** on: deleting closes the gap and a new take pushes the rest right. Off: deleted parts stay empty, and a take fills the gap (later audio moves only if the take is longer).
- **New recording…** asks first, then clears the timeline (Ctrl+Z brings it back).
- **Shortcuts are customizable**: click *Shortcuts* in the header, pick an action, press the new keys. Saved in the browser; works on any keyboard layout (keys are matched by physical position).
- **Enhance** (AI noise removal, presets, loudness) with an original/enhanced switch (**B**), and **Export** to WAV, FLAC, MP3 or Opus.

The original single-waveform editor is still available at `/classic` (`public/classic.html`). Both share the code in `public/js/`.

---

# Takeflow

A voice recorder and editor that runs entirely in the browser. Record, stop at a mistake, and re-record from that exact point with a click-free join. Clean up the result with AI noise removal and one-click presets, then export studio-quality WAV, FLAC, MP3 or Opus. Nothing is uploaded: audio stays on the user's device.

## Features

**Recording**
- Captures raw 32-bit float audio through an AudioWorklet, with the browser's echo, noise and gain processing turned off for the cleanest sound (can be switched on).
- Saves takes in chunks every half second while recording, so a crash or closed tab never loses a take; it is restored on the next visit.
- Input meter with level advice, clipping warning, device picker, and a Bluetooth-headset quality warning.

**Punch-in editing: record, cut, record again from anywhere**
- Put the cursor anywhere (or stop playback where you hear a mistake) and press record. Choose whether the new take replaces everything after the cursor, overwrites only its own length, or inserts.
- Select a section and press record to replace just that section.
- Plays a 2-second run-up before the punch point, with latency compensation so the new take lines up with what you heard.
- Equal-power crossfades at every splice, so there are no clicks.
- Non-destructive: unlimited undo and redo, instant cuts even on long files.
- Delete, keep only the selection, select all, and automatically shorten long pauses.

**Enhance (Adobe Podcast–style)**
- AI noise removal (RNNoise, WebAssembly), pause cleanup, de-esser, tone shaping, compression, loudness normalisation (ITU-R BS.1770 / EBU R128) and a look-ahead peak limiter.
- Presets: Podcast (−16 LUFS), YouTube and video (−14), Audiobook (−20, ACX-friendly peaks), Warm radio, Phone and laptop mic fix, Light touch, Volume only.
- A strength slider and fine-tune controls, and a seamless A/B comparison while playing (press B).

**Export**
- WAV 16-bit, 24-bit or 32-bit float, with TPDF dither.
- FLAC 16-bit or 24-bit (lossless, about half the size of WAV).
- MP3 at 128 to 320 kbps.
- Opus in Ogg at 64 to 192 kbps (in browsers with WebCodecs).
- Mono or stereo, project rate, 44.1 kHz or 48 kHz, and whole file or selection only.

**Other**
- Opens WAV, MP3, M4A, FLAC, Ogg and WebM files (drag and drop works too).
- Installable app that works offline after the first visit.
- Light and dark themes, responsive down to phones, keyboard shortcuts (press ? in the app).

## Project layout

```
public/            the website (deploy this folder as-is; no build step)
  index.html
  css/app.css
  js/app.js          interface controller
  js/engine.js       non-destructive timeline, edits, undo, crossfaded rendering
  js/recorder.js     microphone capture (+ worklets/recorder-worklet.js)
  js/waveform.js     waveform, ruler, selection, overview
  js/player.js       playback with A/B switching
  js/dsp.js          filters, loudness meter, compressor, gate, de-esser, limiter, resampler
  js/enhance.js      enhancement chain   js/presets.js  preset values
  js/encoders.js     WAV, FLAC and Ogg Opus writers
  js/workers/        enhancement and export run off the main thread
  js/vendor/         RNNoise (WASM) and lamejs (MP3)
  sw.js, manifest.webmanifest, icons/
tests/             Node unit tests and a browser end-to-end test
vercel.json, netlify.toml, public/_headers, .github/workflows/pages.yml
```

## Run locally

Any static file server works. The microphone only works on `https://` or `http://localhost`.

```
npm run serve        # http://localhost:8080
# or: cd public && python3 -m http.server 8080
```

## Deploy

The site is static. Publish the `public/` folder on any host that serves HTTPS.

- **Vercel:** import the repository. `vercel.json` already sets the output directory to `public` with no build.
- **Netlify:** import the repository. `netlify.toml` already sets `publish = "public"`.
- **Cloudflare Pages:** build command empty, output directory `public`.
- **GitHub Pages:** push to `main`, then in Settings → Pages choose "GitHub Actions". The included workflow deploys `public/`.

## Tests

```
npm test                       # DSP, enhancement, encoders, timeline (needs ffmpeg)
python3 tests/e2e_browser.py   # full browser run with a simulated microphone (needs Playwright)
```

The unit tests check the loudness meter against ffmpeg's EBU R128 meter, verify that FLAC is bit-exact lossless, decode every export format with ffmpeg, and confirm noise removal stays sample-aligned. The browser test records, punches in, cuts, undoes, enhances, exports every format, reloads, and simulates a crash mid-recording.

## Browser support

Current Chrome, Edge, Firefox and Safari (desktop and mobile). Opus export needs WebCodecs (Chrome and Edge, recent Safari); the option is hidden where it isn't available.

## Licence

Takeflow's own code is MIT licensed (see LICENSE). Bundled libraries keep their own licences; see THIRD_PARTY_NOTICES.md.
