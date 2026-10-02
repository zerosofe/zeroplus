// sw.js
const CACHE_NAME = 'zeroplus-v30';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // تجاهل طلبات الـ API والملفات الخارجية تماماً لكي لا يتسبب في انهيار التطبيق
  if (
    event.request.url.includes('supabase.co') ||
    event.request.url.includes('cdn.jsdelivr.net') ||
    event.request.url.includes('cdnjs.cloudflare.com') ||
    event.request.url.includes('fonts.googleapis.com') ||
    event.request.url.includes('tailwindcss.com') ||
    event.request.method !== 'GET'
  ) {
    return; // اترك المتصفح يتعامل معها مباشرة
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});
