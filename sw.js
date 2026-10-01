const CACHE_NAME = 'zeroplus-cache-v26';

// الأصول الأساسية المسبقة لضمان عمل الواجهة والأقسام دون إنترنت
const PRECACHE_ASSETS = [
  '/',
  '/index.html?v=26',
  '/manifest.json?v=26',
  '/icon.svg?v=26',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png?v=26',
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

// ------------------ إدارة ومزامنة مؤقت التركيز والإشعارات في الخلفية ------------------
let activePomoTimer = null;

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || !data.type) return;

  if (data.type === 'SCHEDULE_POMO_NOTIFICATION') {
    if (activePomoTimer) clearTimeout(activePomoTimer);
    const delayMs = Math.max(0, Number(data.delayMs) || 0);

    activePomoTimer = setTimeout(async () => {
      activePomoTimer = null;
      try {
        await self.registration.showNotification(data.title || 'ZeroPlus | انتهت جلسة التركيز!', {
          body: data.body || 'عاشت إيدك! اكتملت فترة المذاكرة المحددة بنجاح. حان وقت الاستراحة.',
          icon: '/icon-192.png',
          badge: '/icon.svg?v=26',
          vibrate: [200, 100, 200, 100, 200],
          tag: 'pomo-finish-alert',
          renotify: true,
          requireInteraction: true,
          data: { url: '/?tab=pomodoro' }
        });
      } catch (err) {
        console.warn('Failed to display background notification:', err);
      }
    }, delayMs);
  } else if (data.type === 'CANCEL_POMO_NOTIFICATION') {
    if (activePomoTimer) {
      clearTimeout(activePomoTimer);
      activePomoTimer = null;
    }
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});

// ------------------ استراتيجية الفيتش والكاش ------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // استثناء الدوال السحابية (/api/ai) وقواعد البيانات من الكاش لضمان الحداثة
  if (
    req.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('groq.com') ||
    url.hostname.includes('supabase.co')
  ) {
    return;
  }

  // 1. للمكتبات والخطوط والأيقونات الثابتة: Cache-First
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

  // 2. لصفحات الموقع والملاحة: Network-First مع دعم العمل دون إنترنت
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
          return (await caches.match('/')) ||
                 (await caches.match('/index.html?v=26')) ||
                 (await caches.match('/index.html?v=25')) ||
                 (await caches.match('/index.html')) ||
                 Response.error();
        }
        return Response.error();
      })
  );
});
