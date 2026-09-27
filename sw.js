const CACHE_NAME = 'zeroplus-cache-v4';

// الأصول الأساسية والمكتبات الخارجية لضمان عمل الواجهة دون إنترنت
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'
];

// التثبيت وحفظ الأصول الأساسية
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        PRECACHE_ASSETS.map((url) => cache.add(url))
      );
    })
  );
  self.skipWaiting();
});

// تفعيل وتنظيف الكاش القديم
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// التعامل مع الطلبات بمرونة
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // استثناء طلبات الـ API والذكاء الاصطناعي وقاعدة البيانات من الكاش
  if (
    req.method !== 'GET' ||
    url.hostname.includes('groq.com') ||
    url.hostname.includes('pollinations.ai') ||
    url.hostname.includes('supabase.co')
  ) {
    return;
  }

  // 1. للمكتبات الثابتة والخطوط والأيقونات: Cache-First (سريع ويعمل دون إنترنت)
  const isStaticAsset = 
    url.hostname.includes('cdn') ||
    url.hostname.includes('cdnjs') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.png');

  if (isStaticAsset) {
    event.respondWith(
      caches.match(req).then((cachedResponse) => {
        if (cachedResponse) return cachedResponse;
        return fetch(req).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, responseClone));
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // 2. لصفحات الموقع والتنقل الداخلي: Network-First مع الرجوع للكاش عند انقطاع النت
  event.respondWith(
    fetch(req)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, responseClone));
        }
        return networkResponse;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === 'navigate') {
          return caches.match('/index.html') || caches.match('/');
        }
      })
  );
});
