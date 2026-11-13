const CACHE_NAME = 'fawry-app-cache-v30';
const urlsToCache = [
  './',
  './index.html',
  './styles.css?v=3.0.3',
  './app.js?v=2.5.5',
  './ui-chrome.js?v=1.0.0',
  './rules.js',
  './csv-processor.js',
  './settlement.js?v=2.5.0',
  './foreign-transactions.js',
  './fx-rates.js',
  './supabase.js',
  './nu-logo.png',
  './fawry-logo-dark.png',
  './fawry-logo-light.png',
  './banque-misr-logo-dark.png',
  './banque-misr-logo-light.png',
  './banque-misr-emblem.png',
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
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  // Only cache GET requests
  if (event.request.method !== 'GET') return;
  const reqUrl = event.request.url;
  // Never cache Supabase API or live FX API responses
  if (
    reqUrl.includes('supabase.co') ||
    reqUrl.includes('open.er-api.com') ||
    reqUrl.includes('currency-api.pages.dev')
  ) {
    return;
  }

  const isHtmlNav = event.request.mode === 'navigate' ||
    (event.request.headers.get('accept') || '').includes('text/html');

  // Network-first for HTML documents so app structure/CSP updates immediately
  if (isHtmlNav) {
    event.respondWith(
      fetch(event.request)
        .then(fetchRes => {
          if (fetchRes && fetchRes.ok) {
            const clone = fetchRes.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return fetchRes;
        })
        .catch(() => caches.match(event.request).then(res => res || caches.match(event.request, { ignoreSearch: true })))
    );
    return;
  }

  // Stale-while-revalidate for static assets (CSS, JS, images, fonts) for instant repeat loads
  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request)
        .then(fetchRes => {
          if (fetchRes && fetchRes.ok) {
            const clone = fetchRes.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return fetchRes;
        })
        .catch(() => cached);

      return cached || networkFetch;
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
