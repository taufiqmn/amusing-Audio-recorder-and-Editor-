import { Timeline, computePeaks } from './engine.js';
import { WaveformView, fmtTime, BUCKET } from './waveform.js';
import { Player } from './player.js';
import { Recorder, looksLikeBluetooth } from './recorder.js';
import { Storage } from './storage.js';
import { PRESETS, LOUDNESS_TARGETS } from './presets.js';
import { resample } from './dsp.js';

const $ = (id) => document.getElementById(id);
const body = document.body;

/* ------------------------------------------------------------------ */
/* Audio core                                                          */
/* ------------------------------------------------------------------ */

const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
const SR = ctx.sampleRate;
let tl = new Timeline(SR);
const player = new Player(ctx);
const recorder = new Recorder(ctx);
let version = 0; // increments on every timeline change
let rendered = new Float32Array(0);

const state = {
  sel: null, cursor: 0, recording: null, arming: false,
  preview: null, enhancing: null, exporting: null,
  settings: {
    punchMode: 'replace-end', preroll: true, latencyMs: null, browserDsp: false, deviceId: '',
    preset: 'podcast', params: { ...PRESETS.podcast, intensity: 1 },
    fmt: 'wav', bits: 24, kbps: { mp3: 192, opus: 96 }, rate: 0, channels: 1, follow: true,
  },
  name: 'Untitled recording',
};

const view = new WaveformView($('wave'), $('overview'), {
  onCursor: (s) => { state.cursor = s; updateClock(); },
  onSelect: (sel) => { state.sel = sel; updateSelectionUI(); },
  onViewChange: () => {},
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

let toastTimer = 0;
function toast(msg, ms = 4200) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function status(msg) { $('status').textContent = msg || ''; }
const secs = (n) => n / SR;
const fmtBytes = (b) => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const safeName = () => (state.name || 'recording').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'recording';

function confirmDialog(title, text, okLabel = 'OK') {
  return new Promise((resolve) => {
    const d = $('confirmDialog');
    $('confirmTitle').textContent = title; $('confirmText').textContent = text; $('confirmOk').textContent = okLabel;
    d.returnValue = ''; d.showModal();
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
  });
}

async function resumeAudio() { if (ctx.state !== 'running') { try { await ctx.resume(); } catch {} } }

/* ------------------------------------------------------------------ */
/* Timeline refresh & persistence                                      */
/* ------------------------------------------------------------------ */

function refresh({ keepView = false } = {}) {
  version++;
  rendered = tl.render();
  const peaks = computePeaks(rendered, BUCKET);
  const wasEmpty = view.length === 0;
  view.editPoints = tl.editPoints();
  view.setAudio(rendered, peaks, SR);
  if ((wasEmpty && rendered.length) || (!keepView && view.visibleSamples > rendered.length * 4 && rendered.length)) view.fit();
  player.setAudio(rendered);
  clearPreview(); // any change to the recording makes an enhanced preview out of date
  state.cursor = Math.min(state.cursor, rendered.length);
  view.setCursor(state.cursor);
  if (state.sel && state.sel.b > rendered.length) { state.sel = null; view.setSelection(null); }
  updateClock(); updateSelectionUI(); updateButtons(); updateEstimate();
  scheduleSave();
}

function updateButtons() {
  const has = tl.length > 0, busy = !!state.recording || !!state.enhancing;
  $('btnUndo').disabled = !tl.canUndo || busy; $('btnRedo').disabled = !tl.canRedo || busy;
  $('btnSelectAll').disabled = !has || busy; $('btnPauses').disabled = !has || busy;
  $('btnDelete').disabled = !state.sel || busy; $('btnKeep').disabled = !state.sel || busy;
  $('btnPreview').disabled = !has || busy;
  $('btnExport').disabled = !has || !!state.recording || !!state.exporting;
  $('exportSel').disabled = !state.sel;
  if (!state.sel) $('exportSel').checked = false;
  $('btnUndo').title = tl.canUndo ? `Undo ${tl.undoStack[tl.undoStack.length - 1].label.toLowerCase()} (Ctrl+Z)` : 'Nothing to undo';
  $('btnRedo').title = tl.canRedo ? `Redo ${tl.redoStack[tl.redoStack.length - 1].label.toLowerCase()} (Ctrl+Shift+Z)` : 'Nothing to redo';
}

function updateSelectionUI() {
  const s = state.sel;
  $('selInfo').textContent = s ? `Selected ${fmtTime(secs(s.a))} to ${fmtTime(secs(s.b))} (${fmtTime(secs(s.b - s.a))})` : 'No selection';
  updateButtons(); updateEstimate();
}

function updateClock(pos) {
  const p = pos ?? (player.playing ? player.position : state.cursor) ?? 0;
  $('clockNow').textContent = fmtTime(secs(p));
  $('clockTotal').textContent = fmtTime(secs(tl.length));
}

let saveTimer = 0; const savedSources = new Set();
function scheduleSave() {
  if (!Storage.available) return;
  $('saveState').textContent = 'Saving…';
  clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 700);
}
async function saveNow() {
  clearTimeout(saveTimer);
  try {
    const refs = tl.referencedSources();
    for (const id of refs) if (!savedSources.has(id)) { await Storage.saveSource(id, tl.sources.get(id)); savedSources.add(id); }
    await Storage.saveMeta({ sampleRate: SR, clips: tl.clips, name: state.name, settings: state.settings, saved: Date.now() });
    for (const id of await Storage.sourceIds()) if (!refs.has(id)) { await Storage.deleteSource(id); savedSources.delete(id); }
    $('saveState').textContent = 'Saved on this device';
  } catch (e) {
    console.error(e);
    $('saveState').textContent = 'Not saved: browser storage is full or blocked';
  }
  updateStorageInfo();
}

async function updateStorageInfo() {
  const est = await Storage.estimate();
  if (est && est.quota) $('storageInfo').textContent = `Using ${fmtBytes(est.usage || 0)} of ${fmtBytes(est.quota)} browser storage on this device.`;
}

async function restore() {
  if (!Storage.available) return;
  try {
    const meta = await Storage.loadMeta();
    if (meta) {
      if (meta.settings) Object.assign(state.settings, meta.settings, { params: { ...state.settings.params, ...(meta.settings.params || {}) } });
      state.name = meta.name || state.name;
      const t = new Timeline(meta.sampleRate || SR);
      for (const c of meta.clips || []) if (!t.sources.has(c.src)) {
        const data = await Storage.loadSource(c.src);
        if (data) { t.sources.set(c.src, data); savedSources.add(c.src); }
      }
      t.clips = (meta.clips || []).filter((c) => t.sources.has(c.src));
      if (t.sampleRate !== SR && t.length) {
        status('Converting saved audio to this device’s sample rate…');
        const conv = resample(t.render(), t.sampleRate, SR);
        tl = new Timeline(SR); const id = tl.addSource(conv); tl.clips = [{ src: id, s: 0, e: conv.length }];
      } else { tl = t; tl.sampleRate = SR; }
    }
    // recover a take that was being recorded when the page closed
    const pending = await Storage.loadPending();
    if (pending.length) {
      const info = pending[0].info || {};
      const parts = pending.map((p) => new Float32Array(p.data));
      const n = parts.reduce((a, p) => a + p.length, 0);
      let take = new Float32Array(n); let o = 0; for (const p of parts) { take.set(p, o); o += p.length; }
      take = take.subarray(Math.min(take.length, info.discard || 0));
      if (info.sampleRate && info.sampleRate !== SR) take = resample(take, info.sampleRate, SR);
      if (take.length > SR * 0.3) {
        const id = tl.addSource(Float32Array.from(take));
        const pos = Math.min(info.pos ?? tl.length, tl.length);
        tl.placeTake(id, pos, info.mode || 'insert', info.rangeEnd);
        toast(`Recovered an unfinished take (${fmtTime(secs(take.length), false)}) from your last session.`, 7000);
      }
      await Storage.clearPending();
    }
  } catch (e) { console.error('Restore failed', e); }
}

/* ------------------------------------------------------------------ */
/* Playback                                                            */
/* ------------------------------------------------------------------ */

let raf = 0;
function tick() {
  if (state.recording) {
    const r = state.recording;
    const recorded = Math.max(0, r.received - r.discard);
    const pos = r.pos + recorded;
    $('clockNow').textContent = fmtTime(secs(recorded));
    if (view.follow) view.ensureVisible(pos, 0.25);
    view.redraw();
    if (r.prerolling) view.setPlayhead(player.position);
    else if (view.playhead != null) view.setPlayhead(null);
  } else if (player.playing) {
    const p = player.position; view.setPlayhead(p); updateClock(p);
  }
  raf = requestAnimationFrame(tick);
}

async function play() {
  if (!tl.length || state.recording) return;
  await resumeAudio();
  let from = state.cursor, to = null;
  if (state.sel) { from = state.sel.a; to = state.sel.b; }
  else if (from >= tl.length - SR * 0.05) from = 0;
  player.play(from, to, null, () => { body.classList.remove('playing'); view.setPlayhead(null); updateClock(); });
  body.classList.add('playing');
}
function stopPlayback(moveCursor = true) {
  if (!player.playing) return;
  const p = player.position;
  player.stop(true); body.classList.remove('playing'); view.setPlayhead(null);
  // stopping where you hear a mistake puts the cursor there, ready to re-record
  if (moveCursor && !state.sel && p != null) { state.cursor = p; view.setCursor(p); view.ensureVisible(p); }
  updateClock();
}
function togglePlay() { player.playing ? stopPlayback() : play(); }

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

function latencySamples() {
  const ms = state.settings.latencyMs ?? autoLatencyMs();
  return Math.round((ms / 1000) * SR);
}
function autoLatencyMs() {
  const l = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
  return Math.round(Math.min(250, Math.max(10, l * 1000 + 10)));
}

async function startRecording() {
  if (state.recording || state.arming || state.enhancing) return;
  stopPlayback(false);
  state.arming = true; body.classList.add('arming');
  try {
    await resumeAudio();
    await recorder.open();
    refreshDevices();
  } catch (e) {
    state.arming = false; body.classList.remove('arming');
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    toast(denied ? 'Microphone access was blocked. Allow it in the address bar, then press record again.' : (e.name === 'NotFoundError' ? 'No microphone found. Connect one and try again.' : 'Could not start the microphone: ' + (e.message || e)), 7000);
    return;
  }
  clearPreview();
  await saveNow();
  let pos = state.cursor, mode = state.settings.punchMode, rangeEnd = null;
  if (state.sel) { pos = state.sel.a; rangeEnd = state.sel.b; mode = 'replace-range'; }
  if (pos >= tl.length) { pos = tl.length; mode = 'insert'; }
  const prerollSamples = state.settings.preroll && pos > 0 ? Math.min(pos, 2 * SR) : 0;
  const when = ctx.currentTime + 0.1;
  const discard = prerollSamples ? prerollSamples + latencySamples() : 0;
  if (prerollSamples) player.play(pos - prerollSamples, pos, when);
  recorder.start(when);
  state.recording = {
    pos, mode, rangeEnd, discard, received: 0, prerolling: !!prerollSamples,
    leftover: new Float32Array(0), pendingIdx: 0, pendingBuf: [], pendingLen: 0, lastSave: performance.now(), writes: Promise.resolve(),
  };
  state.arming = false; body.classList.remove('arming'); body.classList.add('recording');
  view.live = { pos, mode, rangeEnd, peaks: [] };
  view.setSelection(null);
  if (prerollSamples) setTimeout(() => { if (state.recording) state.recording.prerolling = false; }, (prerollSamples / SR) * 1000 + 120);
  status(prerollSamples ? 'Get ready… recording starts after the run-up.' : 'Recording. Press R or the button to stop, Esc to discard.');
  if (prerollSamples) setTimeout(() => { if (state.recording) status('Recording. Press R or the button to stop, Esc to discard.'); }, (prerollSamples / SR) * 1000);
  updateButtons();
  if (looksLikeBluetooth(recorder.label)) $('btWarn').hidden = false;
}

recorder.onChunk = (data) => {
  const r = state.recording; if (!r) return;
  const before = r.received; r.received += data.length;
  // crash-safety: queue raw chunks for IndexedDB
  r.pendingBuf.push(data); r.pendingLen += data.length;
  if (performance.now() - r.lastSave > 500) flushPending();
  // live waveform peaks (after the pre-roll part we will discard)
  let start = Math.max(0, r.discard - before);
  if (start >= data.length) return;
  let seg = data.subarray(start);
  if (r.leftover.length) { const m = new Float32Array(r.leftover.length + seg.length); m.set(r.leftover); m.set(seg, r.leftover.length); seg = m; }
  const full = Math.floor(seg.length / BUCKET) * BUCKET;
  const p = view.live.peaks;
  for (let i = 0; i < full; i += BUCKET) {
    let mn = 0, mx = 0;
    for (let j = i; j < i + BUCKET; j++) { const v = seg[j]; if (v < mn) mn = v; if (v > mx) mx = v; }
    p.push(mn, mx);
  }
  r.leftover = seg.slice(full);
};

function flushPending() {
  const r = state.recording; if (!r || !r.pendingLen || !Storage.available) return;
  const merged = new Float32Array(r.pendingLen); let o = 0;
  for (const c of r.pendingBuf) { merged.set(c, o); o += c.length; }
  r.pendingBuf = []; r.pendingLen = 0; r.lastSave = performance.now();
  const idx = r.pendingIdx++;
  const info = { pos: r.pos, mode: r.mode, rangeEnd: r.rangeEnd, discard: r.discard, sampleRate: SR };
  r.writes = r.writes.then(() => Storage.savePending('take', idx, merged, info)).catch(() => {});
}

async function stopRecording(discardTake = false) {
  const r = state.recording; if (!r) return;
  const data = await recorder.stop();
  player.stop(true);
  state.recording = null; view.live = null; view.setPlayhead(null);
  body.classList.remove('recording');
  // wait for in-flight crash-safety writes before clearing them, so nothing stale is left behind
  r.writes.then(() => Storage.clearPending()).catch(() => {});
  const take = data.subarray(Math.min(data.length, r.discard));
  if (discardTake) { status('Take discarded.'); refresh({ keepView: true }); return; }
  if (take.length < SR * 0.1) { status('That take was too short to keep.'); refresh({ keepView: true }); return; }
  const id = tl.addSource(Float32Array.from(take));
  const end = tl.placeTake(id, r.pos, r.mode, r.rangeEnd);
  state.cursor = end; state.sel = null; view.setSelection(null);
  refresh({ keepView: true });
  view.ensureVisible(end);
  const msg = r.mode === 'replace-range' ? 'Selection replaced with the new take.' : r.pos < tl.length - take.length ? 'New take placed. The cursor is at its end, ready for the next one.' : 'Take saved.';
  status(msg);
  if (recorder.clipped) toast('Some peaks were too loud and clipped. Move back from the mic a little or lower its input volume.', 7000);
}

function toggleRecord() { state.recording ? stopRecording() : startRecording(); }

/* ------------------------------------------------------------------ */
/* Editing                                                             */
/* ------------------------------------------------------------------ */

function edit(fn, msg) {
  stopPlayback(false);
  if (fn() !== false) { refresh({ keepView: true }); if (msg) status(msg); }
}
function deleteSelection() {
  const s = state.sel; if (!s) return;
  edit(() => tl.deleteRange(s.a, s.b), `Deleted ${fmtTime(secs(s.b - s.a))}.`);
  state.cursor = s.a; state.sel = null; view.setSelection(null); view.setCursor(s.a); updateSelectionUI();
}
function keepSelection() {
  const s = state.sel; if (!s) return;
  edit(() => tl.keepRange(s.a, s.b), 'Kept only the selection.');
  state.cursor = 0; state.sel = null; view.setSelection(null); view.setCursor(0); view.fit(); updateSelectionUI();
}
function selectAll() { if (!tl.length) return; state.sel = { a: 0, b: tl.length }; view.setSelection(state.sel); updateSelectionUI(); }
function undo() { if (state.recording) return; stopPlayback(false); const l = tl.undo(); if (l) { refresh({ keepView: true }); status(`Undid ${l.toLowerCase()}.`); } }
function redo() { if (state.recording) return; stopPlayback(false); const l = tl.redo(); if (l) { refresh({ keepView: true }); status(`Redid ${l.toLowerCase()}.`); } }

function shortenPauses() {
  const d = $('pauseDialog'); d.returnValue = ''; d.showModal();
  d.addEventListener('close', () => {
    if (d.returnValue !== 'ok') return;
    const ranges = tl.findLongPauses({ maxPauseSec: +$('pauseMax').value, keepSec: +$('pauseKeep').value });
    if (!ranges.length) { status('No pauses long enough to shorten.'); return; }
    const saved = ranges.reduce((a, [x, y]) => a + (y - x), 0);
    edit(() => tl.deleteRanges(ranges, 'Shorten pauses'), `Shortened ${ranges.length} pause${ranges.length > 1 ? 's' : ''}, saving ${fmtTime(secs(saved))}.`);
  }, { once: true });
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

async function importFile(file) {
  if (!file) return;
  if (state.recording) return;
  status(`Opening ${file.name}…`);
  try {
    const buf = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf);
    const n = audio.length, nc = audio.numberOfChannels;
    const mono = new Float32Array(n);
    for (let c = 0; c < nc; c++) { const ch = audio.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += ch[i] / nc; }
    const id = tl.addSource(mono);
    const empty = tl.length === 0;
    const at = empty ? 0 : state.cursor;
    stopPlayback(false);
    tl.placeTake(id, at, 'insert');
    if (empty && (state.name === 'Untitled recording' || !state.name)) { state.name = file.name.replace(/\.[^.]+$/, ''); $('projectName').value = state.name; }
    state.cursor = at; refresh(); if (empty) view.fit();
    status(empty ? `Opened ${file.name} (${fmtTime(audio.duration)}).` : `Inserted ${file.name} at the cursor.`);
  } catch (e) {
    console.error(e);
    status('');
    toast(`Could not open ${file.name}. Try WAV, MP3, M4A, FLAC or Ogg.`, 6000);
  }
}

/* ------------------------------------------------------------------ */
/* Enhance                                                             */
/* ------------------------------------------------------------------ */

const SLIDERS = [
  { key: 'denoise', label: 'Noise removal', min: 0, max: 1, step: 0.05, fmt: (v) => Math.round(v * 100) + '%' },
  { key: 'gate', label: 'Quiet the pauses', min: 0, max: 20, step: 1, fmt: (v) => (v ? `−${v} dB` : 'Off') },
  { key: 'deess', label: 'Soften S sounds', min: 0, max: 1, step: 0.05, fmt: (v) => Math.round(v * 100) + '%' },
  { key: 'hp', label: 'Rumble filter', min: 0, max: 150, step: 5, fmt: (v) => (v ? `${v} Hz` : 'Off') },
  { key: 'warmth', label: 'Warmth', min: -6, max: 6, step: 0.5, fmt: (v) => (v > 0 ? '+' : '') + v + ' dB' },
  { key: 'mud', label: 'Boxiness cut', min: -8, max: 2, step: 0.5, fmt: (v) => (v > 0 ? '+' : '') + v + ' dB' },
  { key: 'presence', label: 'Clarity', min: -4, max: 8, step: 0.5, fmt: (v) => (v > 0 ? '+' : '') + v + ' dB' },
  { key: 'air', label: 'Air', min: -4, max: 8, step: 0.5, fmt: (v) => (v > 0 ? '+' : '') + v + ' dB' },
  { key: 'compRatio', label: 'Evenness', min: 1, max: 8, step: 0.5, fmt: (v) => (v <= 1 ? 'Off' : v + ':1') },
];

function buildEnhanceUI() {
  const wrap = $('presets');
  for (const [key, p] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'preset'; b.textContent = p.name; b.dataset.key = key;
    b.setAttribute('role', 'radio'); b.title = p.hint;
    b.addEventListener('click', () => choosePreset(key));
    wrap.appendChild(b);
  }
  const hint = document.createElement('p'); hint.className = 'preset-hint'; hint.id = 'presetHint';
  wrap.after(hint);
  const tsel = $('target');
  for (const t of LOUDNESS_TARGETS) { const o = document.createElement('option'); o.value = t.value; o.textContent = t.label; tsel.appendChild(o); }
  tsel.addEventListener('change', () => { state.settings.params.target = +tsel.value; markCustom(); });
  const sl = $('sliders');
  for (const s of SLIDERS) {
    const lab = document.createElement('label'); lab.className = 'field';
    lab.innerHTML = `<span>${s.label} <output></output></span><input type="range" min="${s.min}" max="${s.max}" step="${s.step}" data-key="${s.key}">`;
    const inp = lab.querySelector('input'), out = lab.querySelector('output');
    inp.addEventListener('input', () => { state.settings.params[s.key] = +inp.value; out.textContent = s.fmt(+inp.value); markCustom(); });
    sl.appendChild(lab);
  }
  $('intensity').addEventListener('input', (e) => { state.settings.params.intensity = e.target.value / 100; $('intensityOut').textContent = e.target.value + '%'; scheduleSave(); });
}
function syncEnhanceUI() {
  const p = state.settings.params;
  document.querySelectorAll('.preset').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.key === state.settings.preset)));
  const pr = PRESETS[state.settings.preset];
  $('presetHint').textContent = pr ? pr.hint : 'Custom settings';
  $('target').value = String(p.target);
  if (![...$('target').options].some((o) => +o.value === p.target)) $('target').value = '-16';
  $('intensity').value = Math.round((p.intensity ?? 1) * 100); $('intensityOut').textContent = $('intensity').value + '%';
  document.querySelectorAll('#sliders input').forEach((inp) => {
    const s = SLIDERS.find((x) => x.key === inp.dataset.key); inp.value = p[s.key];
    inp.previousElementSibling.querySelector('output').textContent = s.fmt(+p[s.key]);
  });
}
function choosePreset(key) {
  state.settings.preset = key;
  state.settings.params = { ...PRESETS[key], intensity: state.settings.params.intensity ?? 1 };
  syncEnhanceUI(); scheduleSave();
}
function markCustom() {
  state.settings.preset = 'custom';
  document.querySelectorAll('.preset').forEach((b) => b.setAttribute('aria-checked', 'false'));
  $('presetHint').textContent = 'Custom settings'; scheduleSave();
}

let enhanceWorker = null;
function getEnhanceWorker() {
  if (!enhanceWorker) enhanceWorker = new Worker(new URL('./workers/enhance-worker.js', import.meta.url), { type: 'module' });
  return enhanceWorker;
}

function showProgress(id, frac, label) {
  const el = $(id); el.hidden = false;
  el.querySelector('.bar').style.width = Math.round(frac * 100) + '%';
  el.querySelector('.plabel').textContent = label;
}

async function previewEnhance() {
  if (!tl.length || state.enhancing) return;
  stopPlayback(false);
  const audio = Float32Array.from(rendered);
  const job = { id: Date.now(), v: version };
  state.enhancing = job; updateButtons();
  $('btnPreview').disabled = true; $('btnCancelEnhance').hidden = false;
  showProgress('enhanceProgress', 0, 'Starting…');
  const w = getEnhanceWorker();
  const params = { ...state.settings.params };
  const result = await new Promise((resolve) => {
    w.onmessage = (e) => {
      const m = e.data; if (m.id !== job.id) return;
      if (m.type === 'progress') showProgress('enhanceProgress', m.value, (m.label || 'Working') + '…');
      else resolve(m);
    };
    w.onerror = (e) => resolve({ type: 'error', message: e.message || 'The enhancer stopped unexpectedly.' });
    job.cancel = () => resolve({ type: 'cancelled' });
    w.postMessage({ id: job.id, audio, sampleRate: SR, params }, [audio.buffer]);
  });
  $('enhanceProgress').hidden = true; $('btnCancelEnhance').hidden = true;
  state.enhancing = null; updateButtons();
  if (result.type === 'cancelled') { enhanceWorker?.terminate(); enhanceWorker = null; status('Enhancement cancelled.'); return; }
  if (result.type === 'error') { toast('Enhancement failed: ' + result.message, 7000); return; }
  if (job.v !== version) { status('The recording changed while enhancing. Preview again to hear the latest version.'); return; }
  state.preview = { audio: result.audio, report: result.report, version };
  player.setAlt(result.audio); setAB(true);
  $('abBox').hidden = false; $('useEnhancedRow').hidden = false;
  const r = result.report;
  $('enhanceReport').textContent = r && isFinite(r.inputLufs)
    ? `Loudness ${r.inputLufs.toFixed(1)} → ${r.outputLufs.toFixed(1)} LUFS, peaks at ${r.peakDb.toFixed(1)} dBFS.`
    : 'Enhanced version ready.';
  status('Preview ready. Play to listen; press B to compare.');
  updateEstimate();
}
function setAB(enhanced) {
  player.setUseAlt(enhanced);
  $('abEnhanced').setAttribute('aria-checked', String(enhanced));
  $('abOriginal').setAttribute('aria-checked', String(!enhanced));
  $('useEnhanced').checked = enhanced;
}
function clearPreview() {
  if (!state.preview) return;
  state.preview = null; player.setAlt(null);
  $('abBox').hidden = true; $('useEnhancedRow').hidden = true;
}
function applyEnhance() {
  if (!state.preview) return;
  stopPlayback(false);
  const id = tl.addSource(state.preview.audio);
  clearPreview();
  tl.replaceAll(id, 'Enhance');
  refresh({ keepView: true });
  status('Enhancement applied. Undo brings back the original.');
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

const KBPS = { mp3: [[128, '128 kbps (small)'], [192, '192 kbps (good)'], [256, '256 kbps (very good)'], [320, '320 kbps (best)']], opus: [[64, '64 kbps (small)'], [96, '96 kbps (excellent for voice)'], [128, '128 kbps'], [192, '192 kbps (transparent)']] };

function buildExportUI() {
  const opusOk = typeof window.AudioEncoder !== 'undefined';
  if (!opusOk) $('opusOption').hidden = true;
  document.querySelectorAll('input[name=fmt]').forEach((r) => r.addEventListener('change', () => { state.settings.fmt = r.value; syncExportUI(); scheduleSave(); }));
  $('bits').addEventListener('change', (e) => { state.settings.bits = +e.target.value; updateEstimate(); scheduleSave(); });
  $('kbps').addEventListener('change', (e) => { state.settings.kbps[state.settings.fmt] = +e.target.value; updateEstimate(); scheduleSave(); });
  $('rate').addEventListener('change', (e) => { state.settings.rate = +e.target.value; updateEstimate(); scheduleSave(); });
  $('channels').addEventListener('change', (e) => { state.settings.channels = +e.target.value; updateEstimate(); scheduleSave(); });
  $('exportSel').addEventListener('change', updateEstimate);
  $('useEnhanced').addEventListener('change', (e) => setAB(e.target.checked));
}
function syncExportUI() {
  const s = state.settings;
  if (s.fmt === 'opus' && $('opusOption').hidden) s.fmt = 'flac';
  document.querySelector(`input[name=fmt][value=${s.fmt}]`).checked = true;
  const lossy = s.fmt === 'mp3' || s.fmt === 'opus';
  $('optBits').hidden = lossy; $('optKbps').hidden = !lossy; $('optRate').hidden = s.fmt === 'opus';
  const bitsSel = $('bits'); bitsSel.querySelector('option[value="32"]').disabled = s.fmt === 'flac';
  if (s.fmt === 'flac' && s.bits === 32) s.bits = 24;
  bitsSel.value = String(s.bits);
  if (lossy) {
    const k = $('kbps'); k.innerHTML = '';
    for (const [v, l] of KBPS[s.fmt]) { const o = document.createElement('option'); o.value = v; o.textContent = l; k.appendChild(o); }
    k.value = String(s.kbps[s.fmt]);
  }
  $('rate').value = String(s.rate); $('channels').value = String(s.channels);
  $('btnExport').textContent = `Export ${s.fmt === 'opus' ? 'Opus' : s.fmt.toUpperCase()}`;
  updateEstimate();
}
function exportLength() { return $('exportSel').checked && state.sel ? state.sel.b - state.sel.a : tl.length; }
function updateEstimate() {
  const s = state.settings; const n = exportLength();
  if (!n) { $('estimate').textContent = ''; return; }
  const dur = n / SR; const rate = s.fmt === 'opus' ? 48000 : (s.rate || SR); const ch = s.channels;
  let bytes;
  if (s.fmt === 'wav') bytes = dur * rate * ch * (s.bits / 8);
  else if (s.fmt === 'flac') bytes = dur * rate * ch * (s.bits / 8) * (ch === 2 ? 0.3 : 0.6);
  else bytes = (dur * s.kbps[s.fmt] * 1000) / 8;
  $('estimate').textContent = `${fmtTime(dur, false)} long, about ${fmtBytes(bytes)}.`;
}

let exportWorker = null;
async function doExport() {
  if (!tl.length || state.exporting) return;
  const s = state.settings;
  let src = state.preview && $('useEnhanced').checked ? state.preview.audio : rendered;
  if ($('exportSel').checked && state.sel) src = src.subarray(state.sel.a, state.sel.b);
  const mono = Float32Array.from(src);
  const channels = s.channels === 2 ? [mono, Float32Array.from(mono)] : [mono];
  if (!exportWorker) exportWorker = new Worker(new URL('./workers/export-worker.js', import.meta.url), { type: 'module' });
  const id = Date.now(); state.exporting = id; updateButtons();
  $('exportDone').hidden = true;
  showProgress('exportProgress', 0, 'Encoding…');
  const ext = { wav: 'wav', flac: 'flac', mp3: 'mp3', opus: 'opus' }[s.fmt];
  const res = await new Promise((resolve) => {
    exportWorker.onmessage = (e) => { const m = e.data; if (m.id !== id) return; if (m.type === 'progress') showProgress('exportProgress', m.value, 'Encoding…'); else resolve(m); };
    exportWorker.onerror = (e) => resolve({ type: 'error', message: e.message || 'Export failed.' });
    exportWorker.postMessage({ id, channels, sampleRate: SR, format: s.fmt, bits: s.bits, kbps: s.kbps[s.fmt], outRate: s.rate || SR, title: state.name }, channels.map((c) => c.buffer));
  });
  $('exportProgress').hidden = true; state.exporting = null; updateButtons();
  if (res.type === 'error') { toast(res.message, 7000); return; }
  const filename = `${safeName()}.${ext}`;
  const url = URL.createObjectURL(res.blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  const done = $('exportDone'); done.hidden = false;
  done.textContent = `Exported ${filename} (${fmtBytes(res.blob.size)}).`;
  window.__lastExport = { name: filename, size: res.blob.size, type: res.blob.type, blob: res.blob, rate: res.rate };
  // offer the share sheet on phones
  try {
    const file = new File([res.blob], filename, { type: res.blob.type });
    if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
      const b = document.createElement('button'); b.className = 'btn'; b.type = 'button'; b.textContent = 'Share file';
      b.style.marginLeft = '8px'; b.onclick = () => navigator.share({ files: [file], title: state.name }).catch(() => {});
      done.appendChild(b);
    }
  } catch {}
}

/* ------------------------------------------------------------------ */
/* Microphone panel                                                    */
/* ------------------------------------------------------------------ */

let meterPeak = 0, meterHold = 0, meterHoldT = 0, levelHist = [];
recorder.onMeter = (peak) => {
  const db = 20 * Math.log10(Math.max(peak, 1e-5));
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  meterPeak = pct;
  const now = performance.now();
  if (pct >= meterHold || now - meterHoldT > 1200) { meterHold = pct; meterHoldT = now; }
  const fill = $('meterFill'); fill.style.width = pct + '%';
  fill.parentElement.style.setProperty('--meter-w', fill.parentElement.clientWidth + 'px');
  $('meterPeak').style.left = `calc(${meterHold}% - 2px)`;
  levelHist.push(db); if (levelHist.length > 90) levelHist.shift();
  if (levelHist.length % 15 === 0) {
    const loud = [...levelHist].sort((a, b) => a - b)[Math.floor(levelHist.length * 0.9)];
    const t = $('meterText');
    if (peak >= 0.999) { t.textContent = 'Too loud: clipping. Lower the input volume or move back.'; t.className = 'meter-text bad'; }
    else if (loud < -40) { t.textContent = 'Speak to check your level.'; t.className = 'meter-text'; }
    else if (loud < -26) { t.textContent = 'A bit quiet. Move closer or raise the input volume.'; t.className = 'meter-text bad'; }
    else if (loud > -4) { t.textContent = 'Very loud. Back off slightly to avoid clipping.'; t.className = 'meter-text bad'; }
    else { t.textContent = 'Good level.'; t.className = 'meter-text good'; }
  }
};

async function refreshDevices() {
  const list = await Recorder.listInputs();
  const sel = $('device'); const cur = state.settings.deviceId;
  sel.innerHTML = '<option value="">Default microphone</option>';
  list.forEach((d, i) => {
    if (!d.deviceId || d.deviceId === 'default') return;
    const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `Microphone ${i + 1}`; sel.appendChild(o);
  });
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  $('btWarn').hidden = !looksLikeBluetooth(recorder.label || (sel.selectedOptions[0]?.textContent ?? ''));
}

function buildMicUI() {
  $('btnMicTest').addEventListener('click', async () => {
    try { await resumeAudio(); await recorder.open(); refreshDevices(); $('btnMicTest').textContent = 'Microphone is on'; $('btnMicTest').disabled = true; }
    catch (e) { toast('Microphone access was blocked. Allow it in the address bar and try again.', 6000); }
  });
  $('device').addEventListener('change', async (e) => {
    state.settings.deviceId = e.target.value; recorder.deviceId = e.target.value; scheduleSave();
    if (recorder.isOpen && !state.recording) { try { await recorder.reopen(); } catch {} }
    $('btWarn').hidden = !looksLikeBluetooth(e.target.selectedOptions[0]?.textContent);
  });
  $('browserDsp').addEventListener('change', async (e) => {
    state.settings.browserDsp = e.target.checked; recorder.processing = e.target.checked; scheduleSave();
    if (recorder.isOpen && !state.recording) { try { await recorder.reopen(); } catch {} }
  });
  const lat = $('latency');
  const showLat = () => { const v = state.settings.latencyMs ?? autoLatencyMs(); lat.value = v; $('latOut').textContent = `${v} ms${state.settings.latencyMs == null ? ' (auto)' : ''}`; };
  lat.addEventListener('input', () => { state.settings.latencyMs = +lat.value; showLat(); scheduleSave(); });
  showLat();
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function bindUI() {
  $('btnRecord').addEventListener('click', toggleRecord);
  $('btnPlay').addEventListener('click', () => (state.recording ? stopRecording() : togglePlay()));
  $('btnStop').addEventListener('click', () => (state.recording ? stopRecording() : stopPlayback()));
  $('btnHome').addEventListener('click', () => { stopPlayback(false); state.cursor = 0; view.setCursor(0); view.ensureVisible(0); updateClock(); });
  $('btnEnd').addEventListener('click', () => { stopPlayback(false); state.cursor = tl.length; view.setCursor(tl.length); view.ensureVisible(tl.length, 0.8); updateClock(); });
  $('btnUndo').addEventListener('click', undo); $('btnRedo').addEventListener('click', redo);
  $('btnDelete').addEventListener('click', deleteSelection); $('btnKeep').addEventListener('click', keepSelection);
  $('btnSelectAll').addEventListener('click', selectAll); $('btnPauses').addEventListener('click', shortenPauses);
  $('zoomIn').addEventListener('click', () => view.zoomBy(2)); $('zoomOut').addEventListener('click', () => view.zoomBy(0.5));
  $('zoomFit').addEventListener('click', () => view.fit());
  $('follow').addEventListener('change', (e) => { view.follow = e.target.checked; state.settings.follow = e.target.checked; scheduleSave(); });
  $('punchMode').addEventListener('change', (e) => { state.settings.punchMode = e.target.value; scheduleSave(); });
  $('preroll').addEventListener('change', (e) => { state.settings.preroll = e.target.checked; scheduleSave(); });
  $('projectName').addEventListener('input', (e) => { state.name = e.target.value; scheduleSave(); });
  $('btnHelp').addEventListener('click', () => $('helpDialog').showModal());
  $('btnOpen').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { importFile(e.target.files[0]); e.target.value = ''; });
  $('btnNew').addEventListener('click', async () => {
    if (state.recording) return;
    if (tl.length && !(await confirmDialog('Start a new recording?', 'This erases the current recording from this device. Export it first if you want to keep it.', 'Erase and start new'))) return;
    stopPlayback(false); clearPreview();
    tl = new Timeline(SR); savedSources.clear(); await Storage.clearProject().catch(() => {});
    state.cursor = 0; state.sel = null; view.setSelection(null); state.name = 'Untitled recording'; $('projectName').value = state.name;
    refresh(); status('Ready for a new recording.');
  });
  $('btnPreview').addEventListener('click', previewEnhance);
  $('btnCancelEnhance').addEventListener('click', () => state.enhancing?.cancel?.());
  $('btnApply').addEventListener('click', applyEnhance);
  $('btnDiscard').addEventListener('click', () => { clearPreview(); status('Enhancement discarded.'); updateEstimate(); });
  $('abOriginal').addEventListener('click', () => setAB(false));
  $('abEnhanced').addEventListener('click', () => setAB(true));
  $('btnExport').addEventListener('click', doExport);

  // drag & drop
  const wrap = document.documentElement; let dragDepth = 0;
  wrap.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; $('dropHint').hidden = false; e.preventDefault(); } });
  wrap.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  wrap.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropHint').hidden = true; });
  wrap.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('dropHint').hidden = true; importFile(e.dataTransfer.files[0]); });

  // keyboard
  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName; const typing = tag === 'INPUT' && !['checkbox', 'radio', 'range'].includes(e.target.type) || tag === 'TEXTAREA' || tag === 'SELECT';
    if (document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (typing && e.key !== 'Escape') return;
    const k = e.key;
    if (k === ' ' || k === 'Spacebar') { e.preventDefault(); if (state.recording) stopRecording(); else togglePlay(); }
    else if ((k === 'r' || k === 'R') && !mod) { e.preventDefault(); toggleRecord(); }
    else if (k === 'Escape') {
      if (state.recording) stopRecording(true);
      else if (player.playing) stopPlayback();
      else if (state.sel) { state.sel = null; view.setSelection(null); updateSelectionUI(); }
      if (typing) e.target.blur();
    }
    else if ((k === 'Delete' || k === 'Backspace') && !mod) { if (state.sel && !state.recording) { e.preventDefault(); deleteSelection(); } }
    else if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); }
    else if (mod && (k === 'a' || k === 'A')) { e.preventDefault(); selectAll(); }
    else if (k === 'Home') { e.preventDefault(); $('btnHome').click(); }
    else if (k === 'End') { e.preventDefault(); $('btnEnd').click(); }
    else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      if (state.recording) return; e.preventDefault(); stopPlayback(false);
      const d = (e.shiftKey ? 5 : 1) * SR * (k === 'ArrowLeft' ? -1 : 1);
      state.cursor = Math.max(0, Math.min(tl.length, state.cursor + d)); state.sel = null; view.setSelection(null);
      view.setCursor(state.cursor); view.ensureVisible(state.cursor); updateClock(); updateSelectionUI();
    }
    else if (k === '+' || k === '=') view.zoomBy(2);
    else if (k === '-' || k === '_') view.zoomBy(0.5);
    else if (k === '0' && !mod) view.fit();
    else if ((k === 'b' || k === 'B') && state.preview) setAB(!player.useAlt);
    else if (k === '?') $('helpDialog').showModal();
  });

  window.addEventListener('pagehide', () => { if (state.recording) flushPending(); });
  window.addEventListener('beforeunload', (e) => { if (state.recording) { flushPending(); e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && recorder.isOpen && !state.recording && !state.arming) {
      recorder.close(); $('btnMicTest').disabled = false; $('btnMicTest').textContent = 'Check mic level';
    }
    if (document.hidden) saveNow();
  });
}

function applySettingsToUI() {
  const s = state.settings;
  $('punchMode').value = s.punchMode; $('preroll').checked = s.preroll; $('follow').checked = s.follow; view.follow = s.follow;
  $('browserDsp').checked = s.browserDsp; recorder.processing = s.browserDsp; recorder.deviceId = s.deviceId;
  $('projectName').value = state.name;
  syncEnhanceUI(); syncExportUI();
}

async function init() {
  buildEnhanceUI(); buildExportUI(); buildMicUI(); bindUI();
  await restore();
  applySettingsToUI();
  refresh(); if (tl.length) view.fit();
  $('saveState').textContent = Storage.available ? 'Saved on this device' : 'Saving is unavailable in this browser';
  Storage.persist();
  updateStorageInfo();
  raf = requestAnimationFrame(tick);
  if (!window.isSecureContext) toast('Recording needs a secure (https) connection. Open this page over https.', 9000);
  if ('serviceWorker' in navigator && window.isSecureContext && !location.hostname.match(/^(localhost|127\.)/)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__takeflow = { tl: () => tl, state, view, player, ctx, refresh }; // for automated tests
}

init();
