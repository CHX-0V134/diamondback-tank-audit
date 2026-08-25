// Service worker — offline app shell. Caches static assets so the app boots
// with no network. Supabase API traffic (cross-origin) is never touched here;
// offline data durability is handled by IndexedDB in the app.
const CACHE = 'wca-v8';
const ASSETS = [
  './', './index.html',
  './css/styles.css',
  './js/config.js', './js/supabase.js', './js/db.js', './js/sync.js', './js/app.js',
  './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Only handle same-origin GETs. Let Supabase / auth traffic pass through.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
