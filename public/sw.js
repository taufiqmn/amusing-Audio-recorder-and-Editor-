// Takeflow service worker: the app works offline after the first visit.
const VERSION = 'takeflow-v2.0.0';
const APP = [
  './', 'index.html', 'classic.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/engine.js', 'js/waveform.js', 'js/player.js', 'js/recorder.js', 'js/storage.js',
  'js/dsp.js', 'js/enhance.js', 'js/presets.js', 'js/encoders.js',
  'js/worklets/recorder-worklet.js', 'js/workers/enhance-worker.js', 'js/workers/export-worker.js',
  'js/vendor/rnnoise.js', 'js/vendor/rnnoise.wasm', 'js/vendor/lame.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k.startsWith('takeflow')).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Google Fonts: cache-first
  if (url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    e.respondWith(caches.open(VERSION + '-fonts').then(async (c) => {
      const hit = await c.match(req); if (hit) return hit;
      try { const res = await fetch(req); if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }
      catch { return hit || Response.error(); }
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  // App files: serve from cache immediately, refresh in the background
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net;
    if (res) return res;
    if (req.mode === 'navigate') return (await c.match('index.html')) || Response.error();
    return Response.error();
  }));
});
