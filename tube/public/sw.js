// Service worker: makes the app open instantly (and offline) from the home
// screen. The app shell and network map are cached; live data never is.
// Paths are relative so the app works from any folder (e.g. yoursite.com/tube/).
const VERSION = 'tube-v4';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'model.js', 'data.js', 'data-worker.js', 'shared/lines.mjs', 'shared/reconstruct.mjs',
  'data/network.json', 'manifest.webmanifest', 'icons/apple-touch-icon.png', 'icons/icon-192.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Live TfL data is cross-origin and never cached (handled by the check above).

  // App shell: network first so updates land immediately, cache as fallback.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./'))),
  );
});
