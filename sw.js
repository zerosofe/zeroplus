const CACHE_NAME = 'zeroplus-cache-v27';

// الأصول الأساسية المسبقة لضمان عمل الواجهة والأقسام دون إنترنت
const PRECACHE_ASSETS = [
  '/',
  '/index.html?v=27',
  '/manifest.json?v=27',
  '/icon.svg?v=27',
  '/icon-192.png?v=27',
  '/icon-512.png?v=27',
  '/apple-touch-icon.png?v=27',

  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'
];


// ============================================================
// INSTALL
// ============================================================

self.addEventListener('install', (event) => {

  // تفعيل النسخة الجديدة مباشرة
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {

      await Promise.allSettled(
        PRECACHE_ASSETS.map(async (url) => {

          try {

            const isExternal =
              new URL(url, self.location.origin).origin !== self.location.origin;

            const request = new Request(
              url,
              isExternal ? { mode: 'no-cors' } : {}
            );

            const response = await fetch(request);

            if (
              response &&
              (response.ok || response.type === 'opaque')
            ) {
              await cache.put(url, response);
            }

          } catch (error) {
            console.warn('Precache failed:', url, error);
          }

        })
      );

    })
  );
});


// ============================================================
// ACTIVATE
// ============================================================

self.addEventListener('activate', (event) => {

  event.waitUntil(

    caches.keys()
      .then((keys) => {

        return Promise.all(

          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => {

              console.log('Deleting old cache:', key);

              return caches.delete(key);

            })

        );

      })
      .then(() => {

        // السيطرة على جميع الصفحات المفتوحة مباشرة
        return self.clients.claim();

      })
      .then(() => {

        console.log('ZeroPlus Service Worker activated:', CACHE_NAME);

      })

  );

});


// ============================================================
// POMODORO BACKGROUND TIMER
// ============================================================

let activePomoTimer = null;


self.addEventListener('message', (event) => {

  const data = event.data;

  if (!data || !data.type) return;


  // بدء إشعار نهاية جلسة التركيز
  if (data.type === 'SCHEDULE_POMO_NOTIFICATION') {

    if (activePomoTimer) {
      clearTimeout(activePomoTimer);
    }

    const delayMs = Math.max(
      0,
      Number(data.delayMs) || 0
    );


    activePomoTimer = setTimeout(async () => {

      activePomoTimer = null;

      try {

        await self.registration.showNotification(
          data.title || 'ZeroPlus | انتهت جلسة التركيز!',
          {
            body:
              data.body ||
              'عاشت إيدك! اكتملت فترة المذاكرة المحددة بنجاح. حان وقت الاستراحة.',

            icon: '/icon-192.png?v=27',

            badge: '/icon.svg?v=27',

            vibrate: [200, 100, 200, 100, 200],

            tag: 'pomo-finish-alert',

            renotify: true,

            requireInteraction: true,

            data: {
              url: '/?tab=pomodoro'
            }
          }
        );

      } catch (err) {

        console.warn(
          'Failed to display background notification:',
          err
        );

      }

    }, delayMs);

  }


  // إلغاء الإشعار
  else if (data.type === 'CANCEL_POMO_NOTIFICATION') {

    if (activePomoTimer) {

      clearTimeout(activePomoTimer);

      activePomoTimer = null;

    }

  }

});


// ============================================================
// NOTIFICATION CLICK
// ============================================================

self.addEventListener('notificationclick', (event) => {

  event.notification.close();

  event.waitUntil(

    clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    })

    .then((clientList) => {

      for (const client of clientList) {

        if (
          client.url &&
          'focus' in client
        ) {

          return client.focus();

        }

      }


      if (clients.openWindow) {

        return clients.openWindow('/');

      }

    })

  );

});


// ============================================================
// FETCH / CACHE STRATEGY
// ============================================================

self.addEventListener('fetch', (event) => {

  const req = event.request;

  const url = new URL(req.url);


  // ----------------------------------------------------------
  // تجاهل الطلبات غير GET
  // ----------------------------------------------------------

  if (req.method !== 'GET') {
    return;
  }


  // ----------------------------------------------------------
  // استثناء API وقواعد البيانات
  // ----------------------------------------------------------

  if (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('groq.com') ||
    url.hostname.includes('supabase.co')
  ) {

    return;

  }


  // ----------------------------------------------------------
  // الملفات الثابتة الخارجية
  // ----------------------------------------------------------

  const isExternalStaticAsset =
    url.hostname.includes('cdn') ||
    url.hostname.includes('cdnjs') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com');


  const isLocalImage =
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.jpeg') ||
    url.pathname.endsWith('.webp');


  if (
    isExternalStaticAsset ||
    isLocalImage
  ) {

    event.respondWith(

      caches.match(req)

        .then((cachedResponse) => {

          if (cachedResponse) {
            return cachedResponse;
          }


          return fetch(req)

            .then((networkResponse) => {

              if (
                networkResponse &&
                (
                  networkResponse.status === 200 ||
                  networkResponse.type === 'opaque'
                )
              ) {

                const responseClone =
                  networkResponse.clone();

                caches.open(CACHE_NAME)
                  .then((cache) => {

                    cache.put(
                      req,
                      responseClone
                    );

                  });

              }


              return networkResponse;

            });

        })

    );

    return;

  }


  // ==========================================================
  // HTML / صفحات الموقع
  // NETWORK FIRST
  // ==========================================================

  if (
    req.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname.endsWith('.html')
  ) {

    event.respondWith(

      fetch(
        new Request(req, {
          cache: 'no-store'
        })
      )

      .then((networkResponse) => {

        if (
          networkResponse &&
          networkResponse.status === 200
        ) {

          const responseClone =
            networkResponse.clone();


          caches.open(CACHE_NAME)
            .then((cache) => {

              // نخزن آخر نسخة حقيقية تم جلبها
              cache.put(
                req,
                responseClone
              );

              // نخزن نسخة index.html أيضًا
              if (
                url.pathname === '/' ||
                url.pathname === '/index.html'
              ) {

                cache.put(
                  '/index.html?v=27',
                  responseClone.clone()
                );

              }

            });

        }


        return networkResponse;

      })

      .catch(async () => {

        console.warn(
          'Network unavailable. Loading cached ZeroPlus.'
        );


        // محاولة النسخة المطلوبة
        const cached =
          await caches.match(req);

        if (cached) {
          return cached;
        }


        // النسخة المحدثة
        const updatedIndex =
          await caches.match('/index.html?v=27');

        if (updatedIndex) {
          return updatedIndex;
        }


        // الصفحة الرئيسية
        const root =
          await caches.match('/');

        if (root) {
          return root;
        }


        return Response.error();

      })

    );

    return;

  }


  // ==========================================================
  // باقي الملفات
  // NETWORK FIRST
  // ==========================================================

  event.respondWith(

    fetch(req)

      .then((networkResponse) => {

        if (
          networkResponse &&
          networkResponse.status === 200
        ) {

          const responseClone =
            networkResponse.clone();


          caches.open(CACHE_NAME)
            .then((cache) => {

              cache.put(
                req,
                responseClone
              );

            });

        }


        return networkResponse;

      })

      .catch(async () => {

        const cached =
          await caches.match(req);

        if (cached) {
          return cached;
        }

        return Response.error();

      })

  );

});
