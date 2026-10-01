// ============================================================
// ZeroPlus Service Worker - v27
// استراتيجية: Network-First للـ HTML، Cache-First للأصول
// ============================================================

const CACHE_VERSION = 'zeroplus-v27';
const CACHE_NAME = `${CACHE_VERSION}`;

// الأصول الثابتة اللي نحتفظ بها offline
const PRECACHE_URLS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/icon.svg'
];

// ===== INSTALL =====
self.addEventListener('install', (event) => {
    self.skipWaiting(); // فعّل SW الجديد فوراً
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(PRECACHE_URLS.map(url => new Request(url, { cache: 'reload' })))
                .catch(() => {}); // تجاهل فشل بعض الأصول
        })
    );
});

// ===== ACTIVATE =====
self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            // احذف كل الكاش القديم
            const keys = await caches.keys();
            await Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) return caches.delete(key);
                })
            );
            // استولِ على كل التبويبات فوراً
            await self.clients.claim();
        })()
    );
});

// ===== FETCH =====
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // تجاهل الطلبات غير GET
    if (request.method !== 'GET') return;

    // تجاهل طلبات Supabase / APIs خارجية
    if (url.hostname.includes('supabase') || url.pathname.startsWith('/api/')) return;

    // تجاهل الطلبات لمصادر خارجية (Google Fonts, CDN, إلخ) — خليها من الشبكة مباشرة
    if (url.origin !== self.location.origin) return;

    // 🎯 HTML: Network-First (يجيب أحدث نسخة دائماً)
    const isHTML = request.mode === 'navigate' ||
                   (request.headers.get('accept') || '').includes('text/html');

    if (isHTML) {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
                    return response;
                })
                .catch(() => caches.match(request).then((r) => r || caches.match('/index.html')))
        );
        return;
    }

    // 🎯 باقي الأصول: Cache-First مع تحديث بالخلفية (Stale-While-Revalidate)
    event.respondWith(
        caches.match(request).then((cached) => {
            const fetchPromise = fetch(request)
                .then((response) => {
                    if (response && response.status === 200) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
                    }
                    return response;
                })
                .catch(() => cached);

            return cached || fetchPromise;
        })
    );
});

// ===== POMODORO TIMER (Notification) =====
let pomoTimers = new Map();

self.addEventListener('message', (event) => {
    const data = event.data || {};

    if (data.type === 'START_POMO_TIMER') {
        const { durationMs, title, body } = data;
        const timerId = 'pomo_' + Date.now();

        // امسح أي timer سابق
        pomoTimers.forEach((tid) => clearTimeout(tid));
        pomoTimers.clear();

        const tid = setTimeout(() => {
            self.registration.showNotification(title || 'ZeroPlus | انتهى الوقت ⏳', {
                body: body || 'انتهت الجلسة! ارجع لتسجيل إنجازك.',
                icon: '/icon.svg',
                badge: '/icon.svg',
                vibrate: [200, 100, 200, 100, 200],
                tag: 'pomo-finish',
                renotify: true,
                requireInteraction: true,
                data: { url: '/' }
            });
            pomoTimers.delete(timerId);
        }, durationMs);

        pomoTimers.set(timerId, tid);
    }

    if (data.type === 'CANCEL_POMO_TIMER') {
        pomoTimers.forEach((tid) => clearTimeout(tid));
        pomoTimers.clear();
    }
});

// ===== NOTIFICATION CLICK =====
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = event.notification.data?.url || '/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            for (const client of clients) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    return client.focus();
                }
            }
            if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
        })
    );
});

// ===== MESSAGE: SKIP WAITING =====
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
