// Service worker: keeps the app's own files ready so it opens fast and installs
// like an app. Account data is never cached: every /api/ request goes to the network.
const CACHE = 'creditflow-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'assets/app.css',
  'assets/js/main.js', 'assets/js/core.js', 'assets/js/auth.js', 'assets/js/personal.js', 'assets/js/business.js', 'assets/js/settings.js',
  'assets/fonts/figtree-latin.woff2', 'assets/icons/icon.svg', 'assets/icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  // Network first so updates show up straight away; the cache is the fallback when offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html')))
  );
});
