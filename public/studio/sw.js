// Enhance Studio service worker (scope /studio/). The app shell and the Standard tier work offline.
const VERSION = 'enhance-studio-v1.0.0';
const FILES = [
  './',
  'css/studio.css',
  'fonts/inter-latin-400-normal.woff2',
  'fonts/inter-latin-500-normal.woff2',
  'fonts/inter-latin-600-normal.woff2',
  'fonts/space-grotesk-latin-500-normal.woff2',
  'fonts/space-grotesk-latin-700-normal.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/icon.svg',
  'index.html',
  'js/app.js',
  'js/engine/analyze.js',
  'js/engine/chain.js',
  'js/engine/fft.js',
  'js/engine/presets.js',
  'js/engine/stages.js',
  'js/io/encoders-core.js',
  'js/io/io.js',
  'js/vendor/lame.mjs',
  'js/vendor/rnnoise.js',
  'js/vendor/rnnoise.wasm',
  'js/workers/job-worker.js',
  'js/workers/mic-worklet.js',
  'manifest.webmanifest',
];
self.addEventListener('install', (e) => e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('enhance-studio') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return; const url = new URL(req.url); if (url.origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then((r) => { if (r.ok && url.pathname.startsWith(new URL('./', location).pathname)) c.put(req, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || (req.mode === 'navigate' ? c.match('./') : Response.error());
  }));
});
