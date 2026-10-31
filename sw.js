const CACHE_NAME = 'fawry-app-cache-v13';
const urlsToCache = [
  './',
  './index.html',
  './styles.css?v=2.1.0',
  './app.js?v=2.1.0',
  './rules.js',
  './csv-processor.js',
  './settlement.js?v=2.1.0',
  './supabase.js',
  './nu-logo.png',
  './favicon.svg',
  './favicon.png',
  './favicon.ico',
  './icon-192.png',
  './icon-512.png',
  './manifest.json'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
  );
});

self.addEventListener('fetch', event => {
  // Only cache GET requests
  if (event.request.method !== 'GET') return;
  // Ignore Supabase API requests (we want those fresh)
  if (event.request.url.includes('supabase.co')) return;

  // Network-first strategy: always try network first so code/rule updates apply immediately,
  // falling back to cache only when offline.
  event.respondWith(
    fetch(event.request)
      .then(fetchRes => {
        if (fetchRes && fetchRes.ok) {
          const clone = fetchRes.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return fetchRes;
      })
      .catch(() => {
        return caches.match(event.request).then(res => res || caches.match(event.request, { ignoreSearch: true }));
      })
  );
});

self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});
