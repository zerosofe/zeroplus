// sw.js — ZeroPlus (Z+) v31
// الخدمة الخلفية: كاش التطبيق + مؤقّت التركيز الذي يعمل حتى لو أُغلقت الصفحة
const CACHE_NAME = 'zeroplus-v31';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json'
];

// ===== مؤقّت التركيز بالخلفية =====
// الصفحة ترسل START_POMO_TIMER مع وقت النهاية (deadlineAt). نحن نحتفظ به ونطلق
// الإشعار عند انتهائه حتى لو كانت الصفحة مغلقة/مصغّرة/بالخلفية.
const POMO_STORE_KEY = '/__zp_pomo_timer';
const POMO_WATCHDOG_MS = 20000;

let pomoDeadline = 0;
let pomoPayload = null;
let pomoTimer = null;
let pomoWatchdog = null;

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
      // استرجاع مؤقّت جلسة ما زالت تعمل (بعد إعادة تشغيل الخدمة الخلفية)
      .then(() => restorePomoTimer())
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
    event.request.url.includes(POMO_STORE_KEY) ||   // تخزين داخلي للمؤقّت — لا يُطلب من الشبكة
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

// ===== رسائل الصفحة =====
self.addEventListener('message', (event) => {
  const data = event.data || {};
  const source = event.source;

  if (data.type === 'START_POMO_TIMER') {
    const durationMs = Number(data.durationMs) || 0;
    pomoDeadline = Number(data.deadlineAt) || (Date.now() + durationMs);
    pomoPayload = {
      title: data.title || 'ZeroPlus | انتهى الوقت! ⏰',
      body: data.body || 'انتهت جلسة التركيز بنجاح.'
    };
    armPomoTimer();
    persistPomoTimer();
    if (source && source.postMessage) {
      source.postMessage({ type: 'POMO_TIMER_ARMED', deadlineAt: pomoDeadline });
    }
    return;
  }

  if (data.type === 'CANCEL_POMO_TIMER') {
    cancelPomoTimer();
    if (source && source.postMessage) source.postMessage({ type: 'POMO_TIMER_CANCELLED' });
    return;
  }

  if (data.type === 'POMO_STATUS') {
    if (source && source.postMessage) {
      source.postMessage({ type: 'POMO_STATUS_REPLY', deadlineAt: pomoDeadline });
    }
    return;
  }
});

function armPomoTimer() {
  if (pomoTimer) { clearTimeout(pomoTimer); pomoTimer = null; }
  const ms = Math.max(0, pomoDeadline - Date.now());
  pomoTimer = setTimeout(() => {
    pomoTimer = null;
    firePomoNotification();
  }, ms);
  startPomoWatchdog();
}

// حماية إضافية: لو أُعيد تشغيل الخدمة الخلفية وضاع المؤقّت، نفحص كل 20 ثانية
function startPomoWatchdog() {
  if (pomoWatchdog) return;
  pomoWatchdog = setInterval(() => {
    if (!pomoDeadline) return;
    if (Date.now() >= pomoDeadline) firePomoNotification();
  }, POMO_WATCHDOG_MS);
}

function firePomoNotification() {
  if (!pomoDeadline) return;
  const payload = pomoPayload || {};
  const deadlineAt = pomoDeadline;
  pomoDeadline = 0;
  pomoPayload = null;
  if (pomoTimer) { clearTimeout(pomoTimer); pomoTimer = null; }
  if (pomoWatchdog) { clearInterval(pomoWatchdog); pomoWatchdog = null; }

  self.registration.showNotification(payload.title || 'ZeroPlus | انتهى الوقت! ⏰', {
    body: payload.body || 'انتهت جلسة التركيز بنجاح.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'zp-pomo',
    requireInteraction: true,
    dir: 'rtl',
    lang: 'ar',
    vibrate: [200, 100, 200],
    data: { url: '/#tab-pomodoro', deadlineAt: deadlineAt }
  }).catch(() => {});

  persistPomoTimer();
  // نخبر الصفحة (لو كانت مفتوحة) لتحصيل الجلسة وتسجيلها فوراً
  self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
    (clients || []).forEach((client) => {
      if (client && client.postMessage) client.postMessage({ type: 'POMO_FINISHED', deadlineAt: deadlineAt });
    });
  }).catch(() => {});
}

function cancelPomoTimer() {
  pomoDeadline = 0;
  pomoPayload = null;
  if (pomoTimer) { clearTimeout(pomoTimer); pomoTimer = null; }
  if (pomoWatchdog) { clearInterval(pomoWatchdog); pomoWatchdog = null; }
  persistPomoTimer();
}

// نخزّن وقت النهاية في الكاش ليعود المؤقّت بعد إعادة تشغيل الخدمة الخلفية
function persistPomoTimer() {
  return caches.open(CACHE_NAME).then((cache) => {
    return cache.put(POMO_STORE_KEY, new Response(String(pomoDeadline || 0)));
  }).catch(() => {});
}
function restorePomoTimer() {
  return caches.open(CACHE_NAME).then((cache) => cache.match(POMO_STORE_KEY)).then((res) => {
    if (!res || !res.text) return 0;
    return res.text().then((txt) => parseInt(txt || '0') || 0);
  }).then((saved) => {
    if (!saved) return;
    pomoDeadline = saved;
    if (Date.now() >= saved) {
      firePomoNotification();     // انتهت والتطبيق مغلق ← أطلق التنبيه الآن
    } else {
      armPomoTimer();
    }
  }).catch(() => {});
}

// الضغط على الإشعار يفتح التطبيق على تبويب التركيز
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client && client.focus) {
          if (client.navigate) { try { client.navigate(target); } catch (e) {} }
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
