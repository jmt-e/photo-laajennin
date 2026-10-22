// Offline support. The app's own files are stored on install; the AI files
// (model + WebAssembly, ~19 MB) are stored by engine/worker.js the first
// time background removal is used, in the 'ai-v1' cache.
//
// Bump VERSION whenever any file in SHELL changes, or phones keep the old copy.
const VERSION = 'v5';
const SHELL_CACHE = `shell-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'engine/engine.js',
  'engine/worker.js',
  'engine/ops.js',
  'vendor/onnxruntime-web/ort.wasm.min.mjs',
  'vendor/onnxruntime-web/ort-wasm-simd-threaded.mjs',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'backgrounds/beach.jpg',
  'backgrounds/basketball-court.jpg',
  'backgrounds/soccer-stadium.jpg',
  'backgrounds/scenery.jpg',
  'backgrounds/beach-thumb.jpg',
  'backgrounds/basketball-court-thumb.jpg',
  'backgrounds/soccer-stadium-thumb.jpg',
  'backgrounds/scenery-thumb.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Cache first, network as fallback. Only our own site is ever contacted.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).catch(() => {
        if (req.mode === 'navigate') return caches.match('index.html');
        throw new Error('offline');
      });
    }),
  );
});
