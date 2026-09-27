const CACHE_NAME = 'zeroplus-cache-v10';

const ASSETS = [
  '/',
  '/index.html?v=10',
  '/manifest.json',
  '/icon.svg?v=10'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k))) // مسح كل الكاش القديم بالكامل
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' ||
      event.request.url.includes('groq.com') ||
      event.request.url.includes('pollinations.ai') ||
      event.request.url.includes('supabase.co')) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const resClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
