const CACHE_NAME = 'zeroplus-cache-v25';

// الأصول الأساسية المسبقة لضمان عمل الواجهة والأقسام دون إنترنت
const PRECACHE_ASSETS = [
  '/',
  '/index.html?v=25',
  '/manifest.json?v=25',
  '/icon.svg?v=25',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png?v=25',
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // cache.add() يفشل مع الطلبات الخارجية (opaque)، لذا نستخدم fetch + put مع no-cors للمكتبات الخارجية
      return Promise.allSettled(
        PRECACHE_ASSETS.map(async (url) => {
          const isExternal = new URL(url, self.location.origin).origin !== self.location.origin;
          const res = await fetch(new Request(url, isExternal ? { mode: 'no-cors' } : {}));
          if (res && (res.ok || res.type === 'opaque')) await cache.put(url, res);
        })
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // استثناء الـ API وقواعد البيانات والذكاء الاصطناعي من الكاش لضمان وصول التحديثات الحية واستجابة الـ AI
  if (
    req.method !== 'GET' ||
    url.hostname.includes('groq.com') ||
    url.hostname.includes('pollinations.ai') ||
    url.hostname.includes('supabase.co')
  ) {
    return;
  }

  // 1. للمكتبات الخارجية والخطوط والأيقونات: Cache-First
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
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, responseClone));
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // 2. لصفحات الموقع والملاحة: Network-First
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
          // caches.match يعيد Promise دائماً، لذا يجب انتظار كل محاولة قبل الانتقال للتي تليها
          return (await caches.match('/')) ||
                 (await caches.match('/index.html?v=25')) ||
                 (await caches.match('/index.html')) ||
                 Response.error();
        }
        return Response.error();
      })
  );
});
