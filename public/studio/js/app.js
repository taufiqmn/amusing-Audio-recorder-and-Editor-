import { PRESETS, DEFAULTS, presetControls } from './engine/presets.js';
import { zipBlobs, codecSupport, readHeader, StreamResampler, WavWriter } from './io/io.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDur = (s) => { if (!isFinite(s)) return '–'; s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
const fmtBytes = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
const AUDIO_EXT = /\.(wav|wave|mp3|m4a|aac|flac|ogg|oga|opus|webm|aif|aiff|aifc|mp4|mov|mkv|3gp|m4v)$/i;
const EXT = { wav: 'wav', flac: 'flac', mp3: 'mp3', m4a: 'm4a', opus: 'opus', ogg: 'ogg' };
const FORMAT_LABEL = { wav: 'WAV', flac: 'FLAC (lossless)', mp3: 'MP3', m4a: 'AAC in M4A', opus: 'Opus', ogg: 'OGG (Opus codec)' };

/* ---------------- tiny IndexedDB key-value + item store ---------------- */
const db = (() => { let p; return () => (p ??= new Promise((res, rej) => { const r = indexedDB.open('enhance-studio', 1); r.onupgradeneeded = () => { r.result.createObjectStore('items'); r.result.createObjectStore('kv'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })); })();
const idb = async (store, mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(store, mode); const r = fn(t.objectStore(store)); t.oncomplete = () => res(r?.result); t.onerror = () => rej(t.error); }); };
const kv = { get: (k) => idb('kv', 'readonly', (s) => s.get(k)).catch(() => undefined), set: (k, v) => idb('kv', 'readwrite', (s) => s.put(v, k)).catch(() => {}) };

/* ---------------- state ---------------- */
const S = {
  preset: 'auto', controls: { ...DEFAULTS }, out: { format: 'wav', bits: 24, kbps: 192, rate: 0, channels: 'auto', stems: false, autocut: false, naming: '{name}_enhanced.{ext}', workers: 0, keep: false },
  user: {}, items: [], codecs: { opus: false, aac: false }, speed: {}, keys: null,
};
const defaultWorkers = () => Math.max(1, Math.min(Math.floor((navigator.hardwareConcurrency || 4) / 2), navigator.deviceMemory ? Math.max(1, Math.floor(navigator.deviceMemory / 2)) : 4));

let toastT = 0;
function toast(m, ms = 4500) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }
const announce = (m) => { $('#sr').textContent = m; };

/* ---------------- routing ---------------- */
function route() {
  const tab = (location.hash || '#enhance').slice(1); const t = ['enhance', 'convert', 'mic'].includes(tab) ? tab : 'enhance';
  for (const p of ['enhance', 'convert', 'mic']) $('#page-' + p).hidden = p !== t;
  $$('.tab[data-tab]').forEach((a) => { if (a.dataset.tab === t) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
}
addEventListener('hashchange', route);

/* ---------------- presets & controls ---------------- */
const SLIDERS = [
  ['noise', 'Noise removal', 'Removes hiss, hum, fans and street noise. Lower it if the voice starts to sound thin.'],
  ['echo', 'Echo and room removal', 'Reduces the hollow sound of a big or empty room.'],
  ['background', 'Background level', 'How much of the original room sound stays, for a natural feel. 0 = silent pauses.'],
  ['clarity', 'Clarity', 'Adds presence and air so words are easy to understand. Never boosts hiss on dull recordings.'],
  ['warmth', 'Warmth', 'Adds body like a large studio microphone and removes boxiness.'],
  ['deess', 'De-esser', 'Softens sharp S and SH sounds.'],
  ['evening', 'Volume evening', 'Brings quiet and loud phrases closer together and quiets the gaps between them.'],
];
function buildControls() {
  const box = $('#presets'); box.innerHTML = '';
  const all = { ...PRESETS, ...Object.fromEntries(Object.entries(S.user).map(([k, v]) => ['user:' + k, { name: k, icon: '★', hint: 'Your saved preset' }])) };
  for (const [k, p] of Object.entries(all)) {
    if (k === 'custom' && S.preset !== 'custom') continue;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'preset'; b.setAttribute('role', 'radio'); b.dataset.key = k; b.title = p.hint;
    b.innerHTML = `<span class="pi" aria-hidden="true">${esc(p.icon)}</span><span>${esc(p.name)}</span>`; box.appendChild(b);
  }
  const sl = $('#sliders'); if (!sl.children.length) for (const [k, label, tip] of SLIDERS) {
    const d = document.createElement('div'); d.className = 'field';
    d.innerHTML = `<label for="c-${k}" title="${esc(tip)}">${esc(label)} <output id="o-${k}"></output></label><input type="range" id="c-${k}" min="0" max="100" data-ctl="${k}" aria-describedby="t-${k}"><small id="t-${k}">${esc(tip)}</small>`;
    sl.appendChild(d);
  }
  syncControls();
}
function syncControls() {
  $$('.preset').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.key === S.preset)));
  const p = S.preset.startsWith('user:') ? { hint: 'Your saved preset' } : PRESETS[S.preset];
  $('#presetHint').textContent = S.preset === 'auto' ? 'Auto analyses each file (noise, echo, bandwidth) and chooses the settings. It backs off if the voice would stop sounding natural.' : p?.hint || '';
  for (const el of $$('[data-ctl]')) { const k = el.dataset.ctl; el.value = S.controls[k]; const o = $('#o-' + k); if (o) o.textContent = k === 'strength' || k !== 'target' ? S.controls[k] + '%' : ''; }
  for (const el of $$('[data-out]')) { const k = el.dataset.out; if (el.type === 'checkbox') el.checked = !!S.out[k]; else el.value = String(S.out[k]); }
  const lossy = ['mp3', 'm4a', 'opus', 'ogg'].includes(S.out.format);
  $('#bits').closest('.field').hidden = lossy; $('#kbps').closest('.field').hidden = !lossy;
  $('#bits').querySelector('option[value="32"]').disabled = S.out.format === 'flac';
}
function choosePreset(k) {
  S.preset = k;
  if (k.startsWith('user:')) S.controls = { ...DEFAULTS, ...S.user[k.slice(5)] };
  else if (k !== 'custom' && k !== 'auto') S.controls = { ...presetControls(k), strength: S.controls.strength, tier: S.controls.tier };
  else if (k === 'auto') S.controls = { ...DEFAULTS, strength: S.controls.strength, tier: S.controls.tier, target: S.controls.target };
  buildControls(); saveSettings();
}
function formatOptions(sel, withLabels = true) {
  sel.innerHTML = '';
  for (const f of ['wav', 'flac', 'mp3', 'm4a', 'opus', 'ogg']) {
    if ((f === 'm4a' && !S.codecs.aac) || ((f === 'opus' || f === 'ogg') && !S.codecs.opus)) continue;
    const o = document.createElement('option'); o.value = f; o.textContent = FORMAT_LABEL[f]; sel.appendChild(o);
  }
}
const hiddenFormatNote = () => { const miss = []; if (!S.codecs.aac) miss.push('AAC (M4A)'); if (!S.codecs.opus) miss.push('Opus and OGG'); return (miss.length ? `${miss.join(' and ')} need WebCodecs encoding, which this browser lacks, so they are hidden. ` : '') + 'OGG uses the Opus codec (no browser can encode Vorbis). MP3 is constant bitrate.'; };

let saveT = 0;
function saveSettings() { clearTimeout(saveT); saveT = setTimeout(() => kv.set('settings', { preset: S.preset, controls: S.controls, out: S.out, user: S.user, advOpen: $('#adv').open }), 300); }

/* ---------------- worker pool ---------------- */
const pool = { workers: [], size: 1 };
function poolSize() { return S.out.workers || defaultWorkers(); }
function getWorker() {
  let w = pool.workers.find((x) => !x.busy);
  if (!w && pool.workers.length < poolSize()) { w = { worker: new Worker(new URL('./workers/job-worker.js', import.meta.url), { type: 'module' }), busy: false }; pool.workers.push(w); }
  return w;
}
function killWorker(w) { try { w.worker.terminate(); } catch {} pool.workers = pool.workers.filter((x) => x !== w); }

let seq = 1;
function newItem(file, kind, extra = {}) {
  const it = { id: `${Date.now().toString(36)}-${seq++}`, kind, file, name: file.name, size: file.size, status: 'queued', progress: 0, stage: '', preset: kind === 'enhance' ? S.preset : null, msg: '', ...extra };
  S.items.push(it); render(it); persist(it); pump(); return it;
}
function pump() {
  for (const it of S.items) {
    if (it.status !== 'queued' || !it.file) continue;
    const w = getWorker(); if (!w) break;
    start(it, w);
  }
  updateOverall();
}

async function start(it, w) {
  w.busy = true; it.worker = w; it.status = 'decoding'; it.progress = 0; it.msg = ''; it.t0 = performance.now(); it.result = null; render(it);
  try {
    if (!it.file.size) throw new Error('The file is empty (0 bytes).');
    let src, transfer = [];
    const h = await readHeader(it.file).catch(() => null);
    if (h && h.frames > 0) { src = { file: it.file }; it.duration = h.frames / h.fs; }
    else {
      if (it.file.size > 600e6) toast(`${it.name} is a very large compressed file. It is decoded in memory, which can fail on devices with little memory.`, 7000);
      const ab = await decode(it.file); it.duration = ab.duration;
      const pcm = Array.from({ length: Math.min(2, ab.numberOfChannels) }, (_, c) => ab.getChannelData(c).slice());
      src = { pcm, rate: 48000 }; transfer = pcm.map((c) => c.buffer);
    }
    if (it.cancelled) return;
    it.status = 'processing'; render(it); persist(it);
    const opts = jobOptions(it);
    const res = await new Promise((resolve) => {
      w.worker.onmessage = (e) => { const m = e.data; if (m.id !== it.id) return; if (m.type === 'progress') { it.stage = m.stage; it.progress = m.value; tick(it); } else resolve(m); };
      w.worker.onerror = (e) => resolve({ type: 'error', message: e.message || 'The processing worker stopped unexpectedly.' });
      it.abort = () => resolve({ type: 'cancelled' });
      w.worker.postMessage({ id: it.id, mode: it.kind, src, opts }, transfer);
    });
    if (res.type === 'cancelled') return;
    if (res.type === 'error') throw new Error(res.message);
    res.format = opts.format; it.status = 'encoding'; render(it);
    const check = await verify(res.blob, opts.format, res);
    it.result = res; it.verify = check; it.status = 'done'; it.wall = (performance.now() - it.t0) / 1000;
    if (it.kind === 'enhance' && it.duration) { const k = opts.controls?.tier || 'standard'; S.speed[k] = it.duration / it.wall; kv.set('speed', S.speed); showSpeed(); }
    announce(`${it.name} is ready.`);
  } catch (err) {
    if (it.cancelled) return;
    it.status = 'failed'; it.msg = humanError(err, it);
  } finally {
    if (!it.cancelled) { w.busy = false; it.worker = null; }
    render(it); persist(it); pump(); updateOverall();
  }
}
function jobOptions(it) {
  const o = it.kind === 'convert' ? convertOptions() : { ...S.out, preset: it.preset === 'custom' || it.preset?.startsWith('user:') ? 'custom' : it.preset, controls: it.preset?.startsWith('user:') ? { ...DEFAULTS, ...S.user[it.preset.slice(5)] } : it.preset === S.preset ? { ...S.controls } : (it.preset === 'auto' ? { strength: S.controls.strength, tier: S.controls.tier, target: S.controls.target } : { ...presetControls(it.preset) }), noiseProfile: it.noiseProfile || null };
  if (o.controls) { o.controls.target = +o.controls.target; o.controls.ceiling = +o.controls.ceiling; }
  o.rate = +o.rate || 0; o.bits = +o.bits; o.kbps = +o.kbps;
  o.tags = o.tags || {}; return o;
}
function humanError(err, it) {
  const m = String(err?.message || err);
  if (/decod|EncodingError|Unable to decode|unsupported/i.test(m) || err?.name === 'EncodingError') return `This file could not be read. It may be damaged, or its format isn't supported by this browser. Try converting it to WAV or MP3 first.`;
  return m;
}
async function decode(file) {
  const buf = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 48000);
  return await ctx.decodeAudioData(buf);
}
async function verify(blob, format, res) {
  // decode the result again and check duration, channels and sample rate
  const out = { ok: true, notes: [] };
  if (blob.size > 250e6) { out.notes.push('Large file: skipped the re-decode check.'); return out; }
  try {
    const ab = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await blob.arrayBuffer());
    const want = res.frames / res.rate; const tol = format === 'wav' || format === 'flac' ? 0.002 : 0.06;
    if (Math.abs(ab.duration - want) > tol) { out.ok = false; out.notes.push(`Length check failed (${ab.duration.toFixed(3)} s, expected ${want.toFixed(3)} s).`); }
    if (ab.numberOfChannels !== res.channels) { out.ok = false; out.notes.push(`Channel check failed (${ab.numberOfChannels}, expected ${res.channels}).`); }
    if (format === 'wav' || format === 'flac') { const r = await headerRate(blob, format); if (r && r !== res.rate) { out.ok = false; out.notes.push(`Sample-rate check failed (${r}).`); } }
  } catch (e) { out.ok = false; out.notes.push('The saved file could not be decoded again by this browser.'); }
  return out;
}
async function headerRate(blob, fmt) {
  const v = new DataView(await blob.slice(0, 64).arrayBuffer());
  if (fmt === 'wav') return v.getUint32(24, true);
  if (fmt === 'flac') return (v.getUint8(18) << 12) | (v.getUint8(19) << 4) | (v.getUint8(20) >> 4);
  return 0;
}
function cancel(it) {
  it.cancelled = true; it.abort?.();
  if (it.worker) killWorker(it.worker); it.worker = null;
  it.status = 'cancelled'; it.msg = 'Cancelled.'; render(it); persist(it); pump();
}
function retry(it) { it.cancelled = false; it.status = 'queued'; it.msg = ''; render(it); pump(); }
function remove(it) { if (['decoding', 'processing', 'encoding'].includes(it.status)) cancel(it); S.items = S.items.filter((x) => x !== it); $(`[data-id="${it.id}"]`)?.remove(); idb('items', 'readwrite', (s) => s.delete(it.id)).catch(() => {}); updateOverall(); }

/* ---------------- persistence of the queue ---------------- */
function persist(it) {
  const rec = { id: it.id, kind: it.kind, name: it.name, size: it.size, status: it.status, preset: it.preset, msg: it.msg, duration: it.duration,
    summary: it.result?.report ? { before: it.result.report.before?.loudness, after: it.result.report.after?.loudness } : null };
  if (S.out.keep) { rec.file = it.file || null; if (it.result) rec.blob = it.result.blob; }
  idb('items', 'readwrite', (s) => s.put(rec, it.id)).catch(() => {});
}
async function restoreQueue() {
  const recs = (await idb('items', 'readonly', (s) => s.getAll()).catch(() => [])) || [];
  for (const r of recs) {
    const it = { ...r, progress: 0 };
    if (r.file) { it.file = r.file; if (r.status !== 'done' || !r.blob) it.status = 'queued'; }
    if (it.status === 'queued') { /* resumes below */ }
    else if (r.status === 'done' && r.blob) it.result = { blob: r.blob, report: { before: { loudness: r.summary?.before }, after: { loudness: r.summary?.after } }, restored: true };
    else if (r.status === 'done') { it.status = 'restored'; it.msg = 'Finished in an earlier visit. Add the file again to re-create the download.'; }
    else if (!r.file) { it.status = 'needs-file'; it.msg = `Add “${r.name}” again to continue. Turn on “Keep files” in Advanced settings to resume automatically next time.`; }
    S.items.push(it); render(it);
  }
  if (recs.length) announce(`Restored ${recs.length} file${recs.length > 1 ? 's' : ''} from your last visit.`);
  pump();
}

/* ---------------- rendering ---------------- */
const STATUS = { queued: 'Waiting', decoding: 'Reading', processing: 'Processing', encoding: 'Checking', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', 'needs-file': 'Needs file', restored: 'Done earlier' };
function render(it) {
  const list = $('#queue-' + it.kind); let li = $(`[data-id="${it.id}"]`, list);
  if (!li) { li = document.createElement('li'); li.className = 'card glass'; li.dataset.id = it.id; list.appendChild(li); }
  $('#empty-' + it.kind).hidden = S.items.some((x) => x.kind === it.kind);
  const running = ['decoding', 'processing', 'encoding'].includes(it.status);
  li.classList.toggle('processing', running);
  const pct = Math.round((it.progress || 0) * 100); const C = 2 * Math.PI * 23;
  const presetSel = it.kind === 'enhance' && ['queued', 'failed', 'cancelled', 'done'].includes(it.status)
    ? `<label class="sr-only" for="ps-${it.id}">Preset for ${esc(it.name)}</label><select id="ps-${it.id}" data-act="preset">${Object.entries({ ...PRESETS, ...Object.fromEntries(Object.keys(S.user).map((k) => ['user:' + k, { name: k }])) }).filter(([k]) => k !== 'custom' || it.preset === 'custom').map(([k, p]) => `<option value="${k}" ${k === it.preset ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : '';
  li.innerHTML = `
    <div class="ring" role="img" aria-label="${pct}% done"><svg viewBox="0 0 56 56"><circle class="bgc" cx="28" cy="28" r="23"/><circle class="fg" cx="28" cy="28" r="23" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - (it.status === 'done' || it.status === 'restored' ? 1 : it.progress || 0))}"/></svg><span>${it.status === 'done' ? '✓' : it.status === 'failed' ? '!' : pct + '%'}</span></div>
    <div class="c-main">
      <div class="c-title"><span class="c-name" title="${esc(it.name)}">${esc(it.name)}</span><span class="pill ${it.status === 'done' ? 'done' : it.status === 'failed' ? 'failed' : running ? 'processing' : ''}">${STATUS[it.status] || it.status}</span></div>
      <div class="c-meta"><span>${it.duration ? fmtDur(it.duration) + ' · ' : ''}${fmtBytes(it.size)}</span> <span class="eta" data-eta>${running ? esc(stageText(it)) : ''}</span></div>
      <canvas class="mini" aria-hidden="true"></canvas>
      ${it.msg ? `<div class="c-msg ${it.status === 'failed' ? 'err' : ''}">${esc(it.msg)}</div>` : ''}
    </div>
    <div class="c-actions">
      ${presetSel}
      ${running || it.status === 'queued' ? `<button class="btn small" type="button" data-act="cancel">Cancel</button>` : ''}
      ${['failed', 'cancelled'].includes(it.status) && it.file ? `<button class="btn small" type="button" data-act="retry">Retry</button>` : ''}
      ${it.kind === 'enhance' && it.file && !running ? `<button class="btn small" type="button" data-act="noise">Noise sample</button>` : ''}
      ${!running ? `<button class="btn small ghost" type="button" data-act="remove" aria-label="Remove ${esc(it.name)}">Remove</button>` : ''}
    </div>
    ${it.status === 'done' && it.result ? doneHtml(it) : ''}`;
  drawMini($('canvas.mini', li), it);
  if (it.status === 'done' && it.result) wireDone(li, it);
  updateOverall();
}
function stageText(it) {
  const f = it.progress || 0; let eta = '';
  if (f > 0.04 && it.t0) { const el = (performance.now() - it.t0) / 1000; eta = `, about ${fmtDur((el / f) * (1 - f))} left`; }
  return `${it.stage || STATUS[it.status]}${eta}`;
}
function tick(it) { // light update without re-rendering the whole card
  const li = $(`[data-id="${it.id}"]`); if (!li) return;
  const C = 2 * Math.PI * 23, pct = Math.round(it.progress * 100);
  $('.fg', li).setAttribute('stroke-dashoffset', C * (1 - it.progress)); $('.ring span', li).textContent = pct + '%'; $('.ring', li).setAttribute('aria-label', pct + '% done');
  $('[data-eta]', li).textContent = stageText(it);
  if (pct % 25 === 0 && it.lastAnn !== pct) { it.lastAnn = pct; announce(`${it.name}: ${pct}%`); }
  updateOverall();
}
function outName(it, suffix = '') {
  const base = it.name.replace(/\.[^.]+$/, ''); const fmt = it.result?.format || (it.kind === 'convert' ? convertOptions().format : S.out.format);
  const tpl = it.kind === 'convert' ? '{name}.{ext}' : S.out.naming || '{name}_enhanced.{ext}';
  let n = tpl.replace(/\{name\}/g, base + suffix).replace(/\{ext\}/g, EXT[fmt] || fmt);
  if (!n.includes('.')) n += '.' + (EXT[fmt] || fmt);
  if (it.kind === 'convert' && n === it.name) n = `${base}_converted.${EXT[fmt]}`;
  return n.replace(/[\\/:*?"<>|]+/g, '-');
}
function doneHtml(it) {
  const r = it.result.report || {}; const b = r.before?.loudness, a = r.after?.loudness;
  const lines = [];
  if (r.reasons?.length) lines.push(`Auto chose these settings because ${r.reasons.join('; ')}.`);
  for (const g of r.guard || []) lines.push(g);
  if (it.result.cuts) lines.push(`Shortened ${it.result.cuts.cuts} long pauses (${it.result.cuts.removedSec.toFixed(1)} s removed).`);
  if (it.verify && !it.verify.ok) lines.push('⚠ ' + it.verify.notes.join(' '));
  if (it.kind === 'convert' && r.gainDb) lines.push(`Loudness changed by ${r.gainDb > 0 ? '+' : ''}${r.gainDb.toFixed(1)} dB.`);
  if (it.result.restored) lines.push('Restored from your last visit.');
  return `<div class="c-done">
    ${it.kind === 'enhance' && !it.result.restored ? `<div class="ab"><button class="btn small" type="button" data-act="play" aria-label="Play">▶ Play</button>
      <div class="seg" role="radiogroup" aria-label="Compare"><button type="button" role="radio" data-ab="0" aria-checked="false">Original</button><button type="button" role="radio" data-ab="1" aria-checked="true">Enhanced</button></div>
      <span class="loud">${isFinite(b) ? `Before ${b.toFixed(1)} LUFS → after ${a.toFixed(1)} LUFS. Playback is level-matched so you hear quality, not volume.` : ''}</span>
      <button class="btn small ghost" type="button" data-act="spec" aria-expanded="false">Spectrogram</button></div>
      <div class="spec" hidden><figure><canvas data-spec="in"></canvas><figcaption>Before</figcaption></figure><figure><canvas data-spec="out"></canvas><figcaption>After</figcaption></figure></div>` : ''}
    ${lines.length ? `<ul class="notes">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
    <div class="downloads"><button class="btn primary small" type="button" data-act="dl">Download ${esc(outName(it))}</button>
      ${it.result.speech ? `<button class="btn small" type="button" data-act="dl-speech">Voice only</button><button class="btn small" type="button" data-act="dl-bg">Removed background</button>` : ''}
      ${it.reverted ? '<span class="loud">Using the original take.</span>' : ''}${it.isTake ? `<button class="btn small ghost" type="button" data-act="revert">${it.reverted ? 'Use enhanced take' : 'Undo: keep original take'}</button>` : ''}</div></div>`;
}
function drawMini(cv, it) {
  const pk = it.result?.peaksOut || it.result?.peaksIn || it.peaks; const dpr = devicePixelRatio || 1; const W = cv.clientWidth || 300, H = 40;
  cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  if (!pk) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, H / 2 - 1, W, 2); return; }
  const grad = g.createLinearGradient(0, 0, W, 0); grad.addColorStop(0, '#8b5cf6'); grad.addColorStop(0.55, '#ec4899'); grad.addColorStop(1, '#f59e0b'); g.fillStyle = grad;
  const inP = it.result?.peaksIn; let max = 0; for (const v of pk) max = Math.max(max, v); max = max || 1;
  for (let x = 0; x < W; x++) { const v = pk[Math.floor((x / W) * pk.length)] / max; const h = Math.max(1, v * (H - 4)); g.fillRect(x, (H - h) / 2, 1, h); }
  if (inP && it.result.peaksOut) { g.fillStyle = 'rgba(255,255,255,0.18)'; let m2 = 0; for (const v of inP) m2 = Math.max(m2, v); for (let x = 0; x < W; x += 2) { const v = inP[Math.floor((x / W) * inP.length)] / (m2 || 1); g.fillRect(x, H - 2, 1, -Math.max(0, v * 6)); } }
}
const urls = new Map(); const urlFor = (key, blob) => { if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob)); return urls.get(key); };
function wireDone(li, it) {
  const r = it.result; if (it.kind !== 'enhance' || r.restored) return;
  const before = r.report?.before?.loudness, after = r.report?.after?.loudness;
  const orig = new Audio(), enh = new Audio(); orig.src = urlFor(it.id + ':in', it.file); enh.src = urlFor(it.id + ':out', r.blob); orig.preload = enh.preload = 'metadata';
  // level matching: turn the louder version down to the quieter one
  const diff = isFinite(before) && isFinite(after) ? after - before : 0;
  enh.volume = diff > 0 ? Math.pow(10, -diff / 20) : 1; orig.volume = diff < 0 ? Math.pow(10, diff / 20) : 1;
  let useEnh = true; const play = $('[data-act=play]', li);
  const cur = () => (useEnh ? enh : orig), other = () => (useEnh ? orig : enh);
  it.player = {
    toggle() { const t = cur().currentTime, playing = !cur().paused; cur().pause(); useEnh = !useEnh; cur().currentTime = Math.min(t, cur().duration || t); if (playing) cur().play().catch(() => {}); $$('[data-ab]', li).forEach((b) => b.setAttribute('aria-checked', String((b.dataset.ab === '1') === useEnh))); },
    playPause() { if (cur().paused) { other().pause(); cur().play().catch(() => {}); play.textContent = '❚❚ Pause'; } else { cur().pause(); play.textContent = '▶ Play'; } },
  };
  enh.onended = orig.onended = () => (play.textContent = '▶ Play');
  S.lastDone = it;
}

function updateOverall() {
  for (const kind of ['enhance', 'convert']) {
    const its = S.items.filter((x) => x.kind === kind); const el = $(kind === 'enhance' ? '#overall' : '#overall-convert');
    const zip = $(kind === 'enhance' ? '#zipAll' : '#zipConv'); zip.disabled = !its.some((x) => x.status === 'done' && x.result);
    if (!its.length) { el.textContent = 'No files yet.'; continue; }
    const done = its.filter((x) => x.status === 'done').length, run = its.filter((x) => ['decoding', 'processing', 'encoding'].includes(x.status)), wait = its.filter((x) => x.status === 'queued' && x.file).length, fail = its.filter((x) => x.status === 'failed').length;
    // time left from measured speed: running jobs' own estimates + waiting audio at the measured rate
    let left = 0; for (const x of run) { const f = x.progress || 0; if (f > 0.04) left += ((performance.now() - x.t0) / 1000 / f) * (1 - f); }
    const sp = S.speed[S.controls.tier || 'standard']; const waitDur = its.filter((x) => x.status === 'queued' && x.duration).reduce((a, x) => a + x.duration, 0);
    if (sp && waitDur) left += waitDur / sp / Math.max(1, poolSize());
    el.textContent = `${done} of ${its.length} done${run.length ? `, ${run.length} processing` : ''}${wait ? `, ${wait} waiting` : ''}${fail ? `, ${fail} failed` : ''}${left > 1 ? `. About ${fmtDur(left)} left` : ''}.`;
  }
}

/* ---------------- queue events ---------------- */
for (const kind of ['enhance', 'convert']) $('#queue-' + kind).addEventListener('click', onCardAction);
for (const kind of ['enhance', 'convert']) $('#queue-' + kind).addEventListener('change', (e) => { const li = e.target.closest('[data-id]'); const it = S.items.find((x) => x.id === li?.dataset.id); if (it && e.target.dataset.act === 'preset') { it.preset = e.target.value; persist(it); if (it.status === 'done') toast('Press Retry or re-add to apply the new preset.'); if (it.status === 'done') { it.status = 'cancelled'; render(it); } } });
function onCardAction(e) {
  const btn = e.target.closest('[data-act],[data-ab]'); if (!btn) return; const li = btn.closest('[data-id]'); const it = S.items.find((x) => x.id === li.dataset.id); if (!it) return;
  const a = btn.dataset.act;
  if (btn.dataset.ab !== undefined) { if (btn.getAttribute('aria-checked') !== 'true') it.player?.toggle(); return; }
  if (a === 'cancel') cancel(it); else if (a === 'retry') retry(it); else if (a === 'remove') remove(it);
  else if (a === 'play') it.player?.playPause();
  else if (a === 'dl') download(it.reverted ? it.file : it.result.blob, it.reverted ? it.name : outName(it));
  else if (a === 'dl-speech') download(it.result.speech, outName(it, '_voice'));
  else if (a === 'dl-bg') download(it.result.background, outName(it, '_background'));
  else if (a === 'spec') { const box = $('.spec', li); box.hidden = !box.hidden; btn.setAttribute('aria-expanded', String(!box.hidden)); if (!box.hidden) { drawSpec($('[data-spec=in]', li), it.result.specIn); drawSpec($('[data-spec=out]', li), it.result.specOut); } }
  else if (a === 'noise') openNoise(it);
  else if (a === 'revert') { it.reverted = !it.reverted; render(it); toast(it.reverted ? 'Keeping the original take. You can switch back any time.' : 'Using the enhanced take.'); }
}
function download(blob, name) { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000); }
function drawSpec(cv, sp) {
  if (!sp) return; const { data, cols, rows } = sp; cv.width = cols; cv.height = rows; const g = cv.getContext('2d'); const img = g.createImageData(cols, rows);
  let mx = -200; for (const v of data) if (v > mx) mx = v;
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    const v = Math.max(0, Math.min(1, (data[c * rows + r] - (mx - 90)) / 90)); const i = ((rows - 1 - r) * cols + c) * 4;
    img.data[i] = Math.round(255 * Math.min(1, v * 1.6)); img.data[i + 1] = Math.round(255 * Math.max(0, v * 1.4 - 0.5)); img.data[i + 2] = Math.round(255 * Math.min(1, 0.35 + v * 0.8) * (1 - v * 0.6)); img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

/* ---------------- noise sample (A6) ---------------- */
async function openNoise(it) {
  const d = $('#noiseDialog'), cv = $('#noiseCanvas'); d.showModal(); $('#noiseOk').disabled = true; $('#noiseSel').textContent = 'Reading the file…';
  let ab; try { ab = await decode(it.file); } catch { $('#noiseSel').textContent = 'This file could not be read for a noise sample.'; return; }
  const x = ab.getChannelData(0); const W = cv.clientWidth, H = cv.clientHeight, dpr = devicePixelRatio || 1; cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
  let sel = null; const draw = () => { g.clearRect(0, 0, W, H); g.fillStyle = '#ec4899'; const per = Math.ceil(x.length / W); for (let i = 0; i < W; i++) { let m = 0; for (let j = i * per; j < Math.min(x.length, (i + 1) * per); j++) m = Math.max(m, Math.abs(x[j])); g.fillRect(i, H / 2 - m * H / 2, 1, Math.max(1, m * H)); } if (sel) { g.fillStyle = 'rgba(245,158,11,0.3)'; g.fillRect(Math.min(sel[0], sel[1]), 0, Math.abs(sel[1] - sel[0]), H); } };
  draw(); $('#noiseSel').textContent = 'Drag across a quiet part.';
  const px = (e) => Math.max(0, Math.min(W, e.clientX - cv.getBoundingClientRect().left));
  cv.onpointerdown = (e) => { cv.setPointerCapture(e.pointerId); sel = [px(e), px(e)]; draw(); };
  cv.onpointermove = (e) => { if (sel && e.buttons) { sel[1] = px(e); draw(); } };
  cv.onpointerup = () => { if (!sel) return; const a = Math.min(...sel) / W * ab.duration, b = Math.max(...sel) / W * ab.duration; $('#noiseSel').textContent = `Selected ${a.toFixed(2)} s to ${b.toFixed(2)} s (${(b - a).toFixed(2)} s).`; $('#noiseOk').disabled = b - a < 0.25; };
  d.addEventListener('close', async () => {
    if (d.returnValue !== 'ok' || !sel) return;
    const a = Math.floor(Math.min(...sel) / W * x.length), b = Math.floor(Math.max(...sel) / W * x.length);
    const { noiseProfileFrom } = await import('./engine/chain.js');
    it.noiseProfile = Array.from(noiseProfileFrom(null, [x.slice(a, b)]) || []);
    toast('Noise sample learned. Enhancing again…'); retry(it);
  }, { once: true });
}

/* ---------------- adding files (picker, drop, folders) ---------------- */
let pickKind = 'enhance';
$$('[data-pick]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); pickKind = b.dataset.pick; $('#pickFiles').click(); }));
$$('[data-pickdir]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); pickKind = b.dataset.pickdir; $('#pickDir').click(); }));
// files go to the queue of the page you are on (Convert page → convert, otherwise enhance)
const pageKind = () => ((location.hash || '#enhance') === '#convert' ? 'convert' : 'enhance');
$('#pickFiles').addEventListener('change', (e) => { addFiles([...e.target.files], pageKind()); e.target.value = ''; });
$('#pickDir').addEventListener('change', (e) => { addFiles([...e.target.files], pageKind()); e.target.value = ''; });
for (const [id, kind] of [['#dropEnh', 'enhance'], ['#dropConv', 'convert']]) {
  const z = $(id);
  z.addEventListener('click', (e) => { if (e.target.closest('button')) return; pickKind = kind; $('#pickFiles').click(); });
  z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('over'); });
  z.addEventListener('dragleave', () => z.classList.remove('over'));
  z.addEventListener('drop', async (e) => { e.preventDefault(); z.classList.remove('over'); addFiles(await filesFromDrop(e.dataTransfer), kind); });
}
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => { if (e.target.closest('.drop')) return; e.preventDefault(); const t = (location.hash || '#enhance').slice(1); if (t === 'mic') return; addFiles(await filesFromDrop(e.dataTransfer), t); });
async function filesFromDrop(dt) {
  const items = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!items.length) return [...(dt.files || [])];
  const out = [];
  const walk = async (entry, path = '') => {
    if (entry.isFile) out.push(await new Promise((res) => entry.file((f) => { try { Object.defineProperty(f, 'relPath', { value: path + f.name }); } catch {} res(f); }, () => res(null))));
    else if (entry.isDirectory) { const r = entry.createReader(); let batch; do { batch = await new Promise((res) => r.readEntries(res, () => res([]))); for (const e of batch) await walk(e, path + entry.name + '/'); } while (batch.length); }
  };
  for (const e of items) await walk(e);
  return out.filter(Boolean);
}
function addFiles(files, kind) {
  const ok = files.filter((f) => AUDIO_EXT.test(f.name) || /^(audio|video)\//.test(f.type)); const skipped = files.length - ok.length;
  if (skipped) toast(`Skipped ${skipped} file${skipped > 1 ? 's' : ''} that ${skipped > 1 ? "aren't" : "isn't"} audio or video.`);
  for (const f of ok) {
    // re-attach to an item waiting for its file after a reload
    const wait = S.items.find((x) => x.kind === kind && ['needs-file', 'restored'].includes(x.status) && x.name === f.name && x.size === f.size);
    if (wait) { wait.file = f; wait.status = 'queued'; wait.msg = ''; render(wait); persist(wait); continue; }
    newItem(f, kind);
  }
  if (ok.length) announce(`Added ${ok.length} file${ok.length > 1 ? 's' : ''}.`);
  pump();
}

/* ---------------- batch bar ---------------- */
$('#applyAll').addEventListener('click', () => { for (const it of S.items) if (it.kind === 'enhance' && ['queued', 'failed', 'cancelled'].includes(it.status)) { it.preset = S.preset; render(it); } toast('Current preset applied to all waiting files.'); });
$('#clearDone').addEventListener('click', () => { for (const it of S.items.filter((x) => x.kind === 'enhance' && ['done', 'restored', 'cancelled'].includes(x.status))) remove(it); });
async function zipKind(kind) {
  const files = []; for (const it of S.items.filter((x) => x.kind === kind && x.status === 'done' && x.result)) {
    files.push({ name: outName(it), blob: it.reverted ? it.file : it.result.blob });
    if (it.result.speech) { files.push({ name: outName(it, '_voice'), blob: it.result.speech }); files.push({ name: outName(it, '_background'), blob: it.result.background }); }
  }
  if (!files.length) return; toast('Building the ZIP…');
  const zip = await zipBlobs(files); download(zip, kind === 'enhance' ? 'enhanced-files.zip' : 'converted-files.zip'); window.__lastZip = zip;
}
$('#zipAll').addEventListener('click', () => zipKind('enhance')); $('#zipConv').addEventListener('click', () => zipKind('convert'));

/* ---------------- controls events ---------------- */
$('#presets').addEventListener('click', (e) => { const b = e.target.closest('.preset'); if (b) choosePreset(b.dataset.key); });
$('#presets').addEventListener('keydown', (e) => { if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return; const bs = $$('.preset'); const i = bs.indexOf(document.activeElement); if (i < 0) return; e.preventDefault(); const n = bs[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length]; n.focus(); choosePreset(n.dataset.key); $(`.preset[data-key="${n.dataset.key}"]`)?.focus(); });
document.addEventListener('input', (e) => {
  const c = e.target.dataset.ctl, o = e.target.dataset.out;
  if (c) { S.controls[c] = e.target.type === 'range' ? +e.target.value : isNaN(+e.target.value) ? e.target.value : +e.target.value; if (!['strength', 'target', 'ceiling', 'tier'].includes(c) && S.preset !== 'custom') { S.preset = 'custom'; buildControls(); } else syncControls(); saveSettings(); }
  if (o) { S.out[o] = e.target.type === 'checkbox' ? e.target.checked : ['bits', 'kbps', 'rate', 'workers'].includes(o) ? +e.target.value : e.target.value; syncControls(); saveSettings(); if (o === 'workers') pump(); }
});
document.addEventListener('change', (e) => { if (e.target.dataset.ctl || e.target.dataset.out) e.target.dispatchEvent(new Event('input', { bubbles: true })); });
$('#savePreset').addEventListener('click', () => { const n = prompt('Name for this preset:', 'My preset'); if (!n) return; S.user[n.trim()] = { ...S.controls }; S.preset = 'user:' + n.trim(); buildControls(); saveSettings(); toast(`Saved “${n.trim()}”.`); });
$('#exportPresets').addEventListener('click', () => download(new Blob([JSON.stringify({ app: 'enhance-studio', version: 1, presets: S.user }, null, 2)], { type: 'application/json' }), 'enhance-presets.json'));
$('#importPresets').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => { try { const j = JSON.parse(await e.target.files[0].text()); const p = j.presets || j; let n = 0; for (const [k, v] of Object.entries(p)) if (v && typeof v === 'object') { S.user[k] = { ...DEFAULTS, ...v }; n++; } buildControls(); saveSettings(); toast(`Imported ${n} preset${n === 1 ? '' : 's'}.`); } catch { toast('That file is not a presets file.'); } e.target.value = ''; });
$('#guideClose').addEventListener('click', () => { $('#guide').hidden = true; kv.set('guideDone', true); });

/* ---------------- convert ---------------- */
let coverBytes = null, coverType = '';
$('#cv-cover').addEventListener('change', async (e) => { const f = e.target.files[0]; coverBytes = f ? new Uint8Array(await f.arrayBuffer()) : null; coverType = f?.type || ''; });
function convertOptions() {
  return { format: $('#cv-fmt').value, bits: +$('#cv-bits').value, kbps: +$('#cv-kbps').value, rate: +$('#cv-rate').value, channels: $('#cv-ch').value, normalize: $('#cv-norm').checked, target: +$('#cv-target').value, trim: $('#cv-trim').checked,
    tags: { title: $('#cv-title').value.trim(), artist: $('#cv-artist').value.trim(), cover: coverBytes, coverType } };
}

/* ---------------- Mic Check (D1) and record → enhance (D2) ---------------- */
let mic = null;
async function openMic() {
  if (mic) return mic;
  const ctx = new AudioContext({ latencyHint: 'interactive' }); await ctx.resume();
  const dev = $('#micDevice').value;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(dev ? { deviceId: { exact: dev } } : {}) } });
  await ctx.audioWorklet.addModule(new URL('./workers/mic-worklet.js', import.meta.url));
  const src = new MediaStreamAudioSourceNode(ctx, { mediaStream: stream }); const node = new AudioWorkletNode(ctx, 'studio-mic', { numberOfOutputs: 1, outputChannelCount: [1] });
  const sink = new GainNode(ctx, { gain: 0 }); src.connect(node).connect(sink).connect(ctx.destination);
  mic = { ctx, stream, node, chunks: [], rec: false };
  node.port.onmessage = (e) => { const m = e.data; if (m.peak !== undefined) $('#micMeter').style.width = Math.max(0, Math.min(100, (20 * Math.log10(m.peak + 1e-5) + 60) / 60 * 100)) + '%'; if (m.data && mic.rec) mic.chunks.push(m.data); };
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default');
  const sel = $('#micDevice'); const cur = sel.value; sel.innerHTML = '<option value="">Default microphone</option>' + devs.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Microphone ' + (i + 1))}</option>`).join(''); sel.value = cur;
  return mic;
}
function closeMic() { if (!mic) return; mic.stream.getTracks().forEach((t) => t.stop()); mic.ctx.close(); mic = null; $('#micMeter').style.width = '0'; }
$('#micDevice').addEventListener('change', () => { closeMic(); });
function takePcm() { const n = mic.chunks.reduce((a, c) => a + c.length, 0); const x = new Float32Array(n); let o = 0; for (const c of mic.chunks) { x.set(c, o); o += c.length; } mic.chunks = []; const rs = new StreamResampler(mic.ctx.sampleRate, 48000, 1); return rs.process([x], true)[0]; }
$('#micStart').addEventListener('click', async () => {
  const btn = $('#micStart'); btn.disabled = true; $('#micReport').innerHTML = '';
  try { await openMic(); } catch (e) { btn.disabled = false; $('#micReport').innerHTML = `<p class="c-msg err">The microphone could not be opened: ${esc(e.name === 'NotAllowedError' ? 'permission was denied. Allow microphone access in the address bar and try again.' : e.message)}</p>`; return; }
  mic.chunks = []; mic.rec = true; let left = 15; $('#micCount').textContent = `Speak now… ${left} s`;
  await new Promise((res) => { const t = setInterval(() => { left--; $('#micCount').textContent = left > 0 ? `Speak now… ${left} s` : 'Analysing…'; if (left <= 0) { clearInterval(t); res(); } }, 1000); });
  mic.rec = false; const x = takePcm();
  const w = new Worker(new URL('./workers/job-worker.js', import.meta.url), { type: 'module' });
  const A = await new Promise((res) => { w.onmessage = (e) => res(e.data); w.postMessage({ id: 'mic', mode: 'analyse', src: { pcm: [x], rate: 48000 } }, [x.buffer]); });
  w.terminate(); btn.disabled = false; $('#micCount').textContent = '';
  if (A.type === 'error') { $('#micReport').innerHTML = `<p class="c-msg err">${esc(A.message)}</p>`; return; }
  showMicReport(A.analysis);
});
export function micAdvice(a) {
  const items = []; const add = (good, title, text) => items.push({ good, title, text });
  const lvl = a.speechDb, peak = a.peakDb;
  if (a.speechFraction < 0.1) add(false, 'No speech heard', 'We could not hear you speaking. Check the microphone choice and that it is not muted.');
  else if (lvl < -38) add(false, `Too quiet (${lvl.toFixed(0)} dBFS)`, 'Move closer to the microphone or raise its input volume in your system settings.');
  else if (peak > -0.5 || a.clipping > 0) add(false, 'Too loud: peaks are clipping', 'Lower the input volume or move back a little. Clipped audio cannot be fully repaired.');
  else if (lvl > -14) add(false, `Very loud (${lvl.toFixed(0)} dBFS)`, 'Back off slightly to leave room for loud words.');
  else add(true, `Good level (${lvl.toFixed(0)} dBFS)`, 'Your speaking level is in the ideal range.');
  if (a.noiseFloorDb > -48) add(false, `Noisy room (background ${a.noiseFloorDb.toFixed(0)} dBFS)`, 'Turn off fans or air conditioning, close windows, or move away from computers. Enhance will remove what is left.');
  else if (a.noiseFloorDb > -60) add(true, `Some background noise (${a.noiseFloorDb.toFixed(0)} dBFS)`, 'Fine for Enhance, which will clean it up.');
  else add(true, `Quiet background (${a.noiseFloorDb.toFixed(0)} dBFS)`, 'Very little background noise.');
  if (a.humHz) add(false, `Electrical hum at ${a.humHz} Hz`, 'Unplug chargers or move the microphone cable away from power cables. Enhance removes hum automatically.');
  if (a.rt60 > 0.55) add(false, `Echoey room (about ${a.rt60.toFixed(1)} s of echo)`, 'Record in a smaller room with soft furnishings (curtains, a bed, a sofa), or hang a blanket behind the microphone.');
  else add(true, 'Room echo is low', 'Your room sounds fairly dry.');
  const far = a.rt60 > 0.4 && lvl < -30; if (far) add(false, 'You may be too far from the microphone', 'Sit about a hand-span (15–20 cm) from the microphone for a close, warm sound.');
  else if (a.speechFraction >= 0.1) add(true, 'Distance looks right', 'You sound close enough to the microphone.');
  if (a.bandwidthHz && a.bandwidthHz < 5500) add(false, 'Narrow, phone-like sound', 'This microphone or connection cuts the treble. A USB or wired headset microphone will sound much fuller.');
  const preset = a.bandwidthHz && a.bandwidthHz < 5500 ? 'phone' : a.rt60 > 0.6 ? 'lecture' : 'podcast';
  return { items, preset };
}
function showMicReport(a) {
  const { items, preset } = micAdvice(a);
  $('#micReport').innerHTML = items.map((i) => `<div class="mic-item ${i.good ? 'good' : 'bad'}"><span class="mi" aria-hidden="true">${i.good ? '✓' : '!'}</span><div><b>${esc(i.title)}</b>${esc(i.text)}</div></div>`).join('') +
    `<div class="row"><span>Recommended preset: <b>${esc(PRESETS[preset].name)}</b></span><button class="btn small" type="button" id="useRec">Use this preset</button></div>`;
  $('#useRec').addEventListener('click', () => { choosePreset(preset); location.hash = '#enhance'; toast(`${PRESETS[preset].name} preset selected.`); });
  window.__micAnalysis = a;
}
let recTimer = 0, recN = 1;
$('#recBtn').addEventListener('click', async () => {
  const b = $('#recBtn');
  if (!mic?.rec) {
    try { await openMic(); } catch (e) { toast('The microphone could not be opened. Allow access and try again.'); return; }
    mic.chunks = []; mic.rec = true; b.classList.add('on'); b.lastChild.textContent = 'Stop and enhance'; const t0 = Date.now();
    recTimer = setInterval(() => ($('#recTime').textContent = fmtDur((Date.now() - t0) / 1000)), 250);
  } else {
    mic.rec = false; clearInterval(recTimer); $('#recTime').textContent = ''; b.classList.remove('on'); b.lastChild.textContent = 'Record';
    const x = takePcm(); if (x.length < 48000 * 0.5) { toast('That take was too short.'); return; }
    const w = new WavWriter(48000, 1, 24); w.write([x]); const blob = w.finish();
    const file = new File([blob], `Recording ${recN++}.wav`, { type: 'audio/wav' });
    location.hash = '#enhance'; const it = newItem(file, 'enhance', { preset: 'auto', isTake: true }); toast('Enhancing your take with Auto…'); announce('Recording added and enhancing.');
  }
});

/* ---------------- keyboard shortcuts (customisable) ---------------- */
const ACTIONS = {
  open: ['Add files', 'o', () => { pickKind = (location.hash || '#enhance').slice(1) === 'convert' ? 'convert' : 'enhance'; $('#pickFiles').click(); }],
  folder: ['Add a folder', 'f', () => { pickKind = (location.hash || '#enhance').slice(1) === 'convert' ? 'convert' : 'enhance'; $('#pickDir').click(); }],
  play: ['Play or pause the latest result', 'p', () => S.lastDone?.player?.playPause()],
  ab: ['Switch original / enhanced', 'b', () => S.lastDone?.player?.toggle()],
  zip: ['Download all as ZIP', 'z', () => zipKind((location.hash || '#enhance').slice(1) === 'convert' ? 'convert' : 'enhance')],
  clear: ['Clear finished files', 'c', () => $('#clearDone').click()],
  enhance: ['Go to Enhance', '1', () => (location.hash = '#enhance')], convert: ['Go to Convert', '2', () => (location.hash = '#convert')], mic: ['Go to Mic Check', '3', () => (location.hash = '#mic')],
  help: ['Show shortcuts', '?', () => openKeys()],
};
const keyOf = (a) => S.keys?.[a] ?? ACTIONS[a][1];
function openKeys() {
  const t = $('#keysTable'); t.innerHTML = Object.entries(ACTIONS).map(([k, [label]]) => `<tr><td>${esc(label)}</td><td><button type="button" data-key="${k}" aria-label="Change shortcut for ${esc(label)}, currently ${esc(keyOf(k))}">${esc(keyOf(k))}</button></td></tr>`).join('');
  $('#keysDialog').showModal();
}
$('#btnKeys').addEventListener('click', openKeys);
$('#keysTable').addEventListener('click', (e) => { const b = e.target.closest('[data-key]'); if (!b) return; b.classList.add('listening'); b.textContent = 'Press a key'; const h = (ev) => { ev.preventDefault(); ev.stopPropagation(); if (ev.key !== 'Escape' && ev.key.length === 1) { S.keys = { ...(S.keys || {}), [b.dataset.key]: ev.key.toLowerCase() }; kv.set('keys', S.keys); } document.removeEventListener('keydown', h, true); openKeys(); }; document.addEventListener('keydown', h, true); });
$('#keysReset').addEventListener('click', () => { S.keys = null; kv.set('keys', null); openKeys(); });
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  const tag = e.target.tagName; if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  for (const a of Object.keys(ACTIONS)) if (e.key.toLowerCase() === keyOf(a)) { e.preventDefault(); ACTIONS[a][2](); return; }
});

/* ---------------- misc ---------------- */
function showSpeed() { const t = []; if (S.speed.standard) t.push(`Standard runs about ${S.speed.standard.toFixed(1)}× faster than real time on this device`); if (S.speed.fast) t.push(`Fast about ${S.speed.fast.toFixed(1)}×`); if (t.length) $('#tierSpeed').textContent = t.join('; ') + ' (measured on your files).'; }
function net() { $('#netState').textContent = navigator.onLine ? 'Works offline' : 'Offline: everything still works'; }
addEventListener('online', net); addEventListener('offline', net);
addEventListener('beforeunload', (e) => { if (S.items.some((x) => ['decoding', 'processing', 'encoding'].includes(x.status))) { e.preventDefault(); e.returnValue = ''; } });
function sheet() { // phone bottom sheet for the settings panel
  for (const c of $$('.controls')) { if (c.querySelector('.sheet-handle')) continue; const h = document.createElement('button'); h.type = 'button'; h.className = 'sheet-handle'; h.setAttribute('aria-expanded', 'false'); h.innerHTML = '<span>Settings</span><span aria-hidden="true">▴</span>'; const s = document.createElement('p'); s.className = 'sheet-summary'; c.prepend(s); c.prepend(h); h.addEventListener('click', () => { c.classList.toggle('open'); h.setAttribute('aria-expanded', String(c.classList.contains('open'))); }); }
  const s = $('#controls .sheet-summary'); if (s) s.textContent = `${S.preset.startsWith('user:') ? S.preset.slice(5) : PRESETS[S.preset]?.name || 'Custom'} · ${S.controls.strength}% · ${FORMAT_LABEL[S.out.format]}`;
}

async function init() {
  S.codecs = await codecSupport();
  const st = await kv.get('settings'); if (st) { S.preset = st.preset || 'auto'; Object.assign(S.controls, st.controls || {}); Object.assign(S.out, st.out || {}); S.user = st.user || {}; $('#adv').open = !!st.advOpen; }
  $('#adv').addEventListener('toggle', saveSettings);
  S.speed = (await kv.get('speed')) || {}; S.keys = (await kv.get('keys')) || null;
  formatOptions($('#fmt')); formatOptions($('#cv-fmt'));
  if (![...$('#fmt').options].some((o) => o.value === S.out.format)) S.out.format = 'wav';
  const ws = $('#workers'); const max = Math.max(4, navigator.hardwareConcurrency || 4); ws.innerHTML = `<option value="0">Automatic (${defaultWorkers()})</option>` + Array.from({ length: max }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
  $('#cv-note').textContent = hiddenFormatNote();
  buildControls(); route(); net(); showSpeed(); sheet();
  document.addEventListener('input', sheet);
  if (!(await kv.get('guideDone'))) $('#guide').hidden = false;
  await restoreQueue();
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
  window.__studio = { S, pool, zipKind };
}
init();
