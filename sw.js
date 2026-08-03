// sw.js — minimal service worker, required by browsers before they'll offer
// the install prompt at all. Deliberately network-first: since you deploy
// frequently via git push -> Netlify, a cache-first strategy would risk
// serving stale HTML/JS after every update. This only falls back to cache
// when the network is genuinely unavailable (offline).
//
// Bump CACHE_VERSION any time you want to force old cached entries to drop.
const CACHE_VERSION = 'v1';
const CACHE_NAME = `primeconnect-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  // Never intercept cross-origin requests (Supabase API calls, fonts, CDN
  // scripts) — only cache same-origin pages/assets.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});