// sw.js — ZeroPlus (Z+) v34
// الخدمة الخلفية: كاش التطبيق + مؤقّت التركيز الذي يعمل حتى لو أُغلقت الصفحة
// + إشعار مستمر بالوقت المتبقي وأزرار إيقاف/استئناف + تذكيرات مجدولة (يومية ودورية)
const CACHE_NAME = 'zeroplus-v34';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json'
];

// ===== مؤقّت التركيز بالخلفية =====
// الصفحة ترسل START_POMO_TIMER مع وقت النهاية (deadlineAt). نحن نحتفظ به ونطلق
// الإشعار عند انتهائه حتى لو كانت الصفحة مغلقة/مصغّرة/بالخلفية.
const POMO_STORE_KEY = '/__zp_pomo_timer';
const POMO_WATCHDOG_MS = 15000;
const ONGOING_TAG = 'zp-pomo-ongoing';

let pomoDeadline = 0;        // وقت نهاية الجلسة (0 = لا توجد جلسة تعمل)
let pomoPausedMs = 0;        // المتبقي عند الإيقاف المؤقت (> 0 يعني موقوفة مؤقتاً)
let pomoPayload = null;      // { title, body, mins, ongoing }
let pomoTimer = null;
let pomoWatchdog = null;
let scheduledAlerts = {};    // تذكيرات مجدولة: id -> { at, title, body, tag, repeatMs }
let lastOngoingText = '';

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
      // استرجاع مؤقّت جلسة ما زالت تعمل + التذكيرات (بعد إعادة تشغيل الخدمة الخلفية)
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

  // أي طلب يوقظ الخدمة الخلفية ← فرصة لفحص المؤقّتات المستحقة (موثوقية التسليم)
  checkDueWork();

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
  const reply = (msg) => { if (source && source.postMessage) source.postMessage(msg); };

  if (data.type === 'START_POMO_TIMER') {
    const durationMs = Number(data.durationMs) || 0;
    pomoDeadline = Number(data.deadlineAt) || (Date.now() + durationMs);
    pomoPausedMs = 0;
    pomoPayload = {
      title: data.title || 'ZeroPlus | انتهى الوقت! ⏰',
      body: data.body || 'انتهت جلسة التركيز بنجاح.',
      mins: Number(data.mins) || 0,
      label: data.label || 'جلسة تركيز',
      // الإشعار المستمر اختياري: الصفحة تطلبه صراحةً حسب تفضيلات الطالب
      ongoing: data.ongoing === true
    };
    armPomoTimer();
    refreshOngoingNotification(true);
    persistPomoTimer();
    reply({ type: 'POMO_TIMER_ARMED', deadlineAt: pomoDeadline });
    return;
  }

  if (data.type === 'CANCEL_POMO_TIMER') {
    cancelPomoTimer();
    reply({ type: 'POMO_TIMER_CANCELLED' });
    return;
  }

  if (data.type === 'PAUSE_POMO_TIMER') {
    const remaining = Number(data.remainingMs) || Math.max(0, pomoDeadline - Date.now());
    pausePomoTimer(remaining, false);
    reply({ type: 'POMO_STATUS_REPLY', deadlineAt: 0, paused: true, remainingMs: pomoPausedMs });
    return;
  }

  if (data.type === 'RESUME_POMO_TIMER') {
    const remaining = Number(data.remainingMs) || pomoPausedMs;
    resumePomoTimer(remaining, false);
    reply({ type: 'POMO_STATUS_REPLY', deadlineAt: pomoDeadline, paused: false, remainingMs: remaining });
    return;
  }

  if (data.type === 'POMO_STATUS') {
    reply({
      type: 'POMO_STATUS_REPLY',
      deadlineAt: pomoDeadline,
      paused: pomoPausedMs > 0,
      remainingMs: pomoPausedMs > 0 ? pomoPausedMs : Math.max(0, pomoDeadline - Date.now()),
      running: pomoDeadline > 0
    });
    return;
  }

  // ===== التذكيرات المجدولة (تذكير يومي + فواصل مخصّصة) =====
  if (data.type === 'SCHEDULE_ALERT') {
    scheduleAlert(data.alert || data);
    persistPomoTimer();
    reply({ type: 'ALERT_SCHEDULED', id: (data.alert && data.alert.id) || data.id });
    return;
  }

  if (data.type === 'CANCEL_ALERT') {
    delete scheduledAlerts[String(data.id)];
    persistPomoTimer();
    reply({ type: 'ALERT_CANCELLED', id: data.id });
    return;
  }

  if (data.type === 'SYNC_ALERTS') {
    scheduledAlerts = {};
    (data.alerts || []).forEach((a) => scheduleAlert(a));
    startPomoWatchdog();
    persistPomoTimer();
    reply({ type: 'ALERTS_SYNCED', count: Object.keys(scheduledAlerts).length });
    return;
  }

  if (data.type === 'ALERTS_STATUS') {
    reply({ type: 'ALERTS_STATUS_REPLY', alerts: Object.values(scheduledAlerts) });
    return;
  }

  if (data.type === 'SHOW_NOTIFICATION') {
    showNotificationSafe(data.title || 'ZeroPlus', {
      body: data.body || '',
      tag: data.tag || 'zeroplus',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      dir: 'rtl',
      lang: 'ar'
    });
    return;
  }
});

function scheduleAlert(a) {
  if (!a || !a.id) return false;
  const at = Number(a.at) || 0;
  if (!at) return false;
  scheduledAlerts[String(a.id)] = {
    id: String(a.id),
    at: at,
    title: a.title || 'ZeroPlus | تذكير',
    body: a.body || '',
    tag: a.tag || ('zp-alert-' + a.id),
    repeatMs: Number(a.repeatMs) || 0
  };
  startPomoWatchdog();
  return true;
}

function armPomoTimer() {
  if (pomoTimer) { clearTimeout(pomoTimer); pomoTimer = null; }
  const ms = Math.max(0, pomoDeadline - Date.now());
  pomoTimer = setTimeout(() => {
    pomoTimer = null;
    firePomoNotification();
  }, ms);
  startPomoWatchdog();
}

// حماية إضافية: لو أُعيد تشغيل الخدمة الخلفية وضاع المؤقّت، نفحص كل 15 ثانية
// ونحدّث الإشعار المستمر بالوقت المتبقي ونطلق التذكيرات المستحقة.
function startPomoWatchdog() {
  if (pomoWatchdog) return;
  pomoWatchdog = setInterval(checkDueWork, POMO_WATCHDOG_MS);
}

function stopPomoWatchdogIfIdle() {
  if (pomoDeadline || pomoPausedMs || Object.keys(scheduledAlerts).length) return;
  if (pomoWatchdog) { clearInterval(pomoWatchdog); pomoWatchdog = null; }
}

// نقطة الفحص الموحّدة: جلسة انتهت؟ تذكير استحق؟ إشعار مستمر يحتاج تحديثاً؟
function checkDueWork() {
  const now = Date.now();
  if (pomoDeadline && now >= pomoDeadline) firePomoNotification();
  else if (pomoDeadline || pomoPausedMs) refreshOngoingNotification(false);
  fireDueAlerts(now);
}

function fireDueAlerts(now) {
  const due = Object.values(scheduledAlerts).filter((a) => a.at && a.at <= (now || Date.now()));
  if (due.length === 0) return 0;
  due.forEach((a) => {
    showNotificationSafe(a.title, {
      body: a.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: a.tag,
      dir: 'rtl',
      lang: 'ar',
      vibrate: [160, 80, 160],
      data: { url: '/#tab-pomodoro', alertId: a.id }
    });
    if (a.repeatMs > 0) {
      let next = a.at;
      while (next <= (now || Date.now())) next += a.repeatMs;
      scheduledAlerts[a.id] = Object.assign({}, a, { at: next });
    } else {
      delete scheduledAlerts[a.id];
    }
    broadcast({ type: 'ALERT_FIRED', id: a.id, at: a.at });
  });
  persistPomoTimer();
  stopPomoWatchdogIfIdle();
  return due.length;
}

function firePomoNotification() {
  if (!pomoDeadline) return;
  const payload = pomoPayload || {};
  const deadlineAt = pomoDeadline;
  pomoDeadline = 0;
  pomoPausedMs = 0;
  pomoPayload = null;
  lastOngoingText = '';
  if (pomoTimer) { clearTimeout(pomoTimer); pomoTimer = null; }
  closeOngoingNotification();

  showNotificationSafe(payload.title || 'ZeroPlus | انتهى الوقت! ⏰', {
    body: payload.body || 'انتهت جلسة التركيز بنجاح.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'zp-pomo',
    requireInteraction: true,
    dir: 'rtl',
    lang: 'ar',
    vibrate: [200, 100, 200],
    data: { url: '/#tab-pomodoro', deadlineAt: deadlineAt }
  });

  persistPomoTimer();
  stopPomoWatchdogIfIdle();
  // نخبر الصفحة (لو كانت مفتوحة) لتحصيل الجلسة وتسجيلها فوراً
  broadcast({ type: 'POMO_FINISHED', deadlineAt: deadlineAt });
}

function cancelPomoTimer() {
  pomoDeadline = 0;
  pomoPausedMs = 0;
  pomoPayload = null;
  lastOngoingText = '';
  if (pomoTimer) { clearTimeout(pomoTimer); pomoTimer = null; }
  closeOngoingNotification();
  persistPomoTimer();
  stopPomoWatchdogIfIdle();
}

// إيقاف مؤقت: نحتفظ بالمتبقي ونحدّث الإشعار المستمر ليعرض زر «استئناف»
function pausePomoTimer(remainingMs, notifyPage) {
  if (!pomoDeadline && !pomoPausedMs) return false;
  pomoPausedMs = Math.max(0, Number(remainingMs) || Math.max(0, pomoDeadline - Date.now()));
  pomoDeadline = 0;
  if (pomoTimer) { clearTimeout(pomoTimer); pomoTimer = null; }
  lastOngoingText = '';
  refreshOngoingNotification(true);
  persistPomoTimer();
  if (notifyPage !== false) broadcast({ type: 'POMO_PAUSED', remainingMs: pomoPausedMs });
  return true;
}

function resumePomoTimer(remainingMs, notifyPage) {
  const remaining = Math.max(0, Number(remainingMs) || pomoPausedMs);
  if (!remaining) return false;
  pomoDeadline = Date.now() + remaining;
  pomoPausedMs = 0;
  lastOngoingText = '';
  armPomoTimer();
  refreshOngoingNotification(true);
  persistPomoTimer();
  if (notifyPage !== false) broadcast({ type: 'POMO_RESUMED', deadlineAt: pomoDeadline });
  return true;
}

// ===== الإشعار المستمر: الوقت المتبقي + إيقاف/استئناف =====
function formatRemaining(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return m + ':' + s;
}

function refreshOngoingNotification(force) {
  if (!pomoPayload || pomoPayload.ongoing === false) return false;
  const paused = pomoPausedMs > 0;
  const remaining = paused ? pomoPausedMs : Math.max(0, pomoDeadline - Date.now());
  if (!paused && !pomoDeadline) return false;
  // نعرض الدقائق فقط حتى لا يُعاد رسم الإشعار كل ١٥ ثانية بلا داعٍ
  const mm = Math.ceil(remaining / 60000);
  const text = (paused ? 'موقوفة مؤقتاً' : 'متبقٍ') + ' ' + (paused ? formatRemaining(remaining) : (mm + ' دقيقة'));
  if (!force && text === lastOngoingText) return false;
  lastOngoingText = text;

  showNotificationSafe('ZeroPlus | ' + (pomoPayload.label || 'جلسة تركيز'), {
    body: text + ' — ' + (paused ? 'اضغط «استئناف» لمواصلة الجلسة.' : 'الجلسة تعمل بالخلفية، استمر 💪'),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: ONGOING_TAG,
    renotify: false,
    silent: true,
    requireInteraction: true,
    dir: 'rtl',
    lang: 'ar',
    actions: paused
      ? [{ action: 'resume', title: '▶️ استئناف' }, { action: 'stop', title: '⏹ إنهاء' }]
      : [{ action: 'pause', title: '⏸ إيقاف مؤقت' }, { action: 'stop', title: '⏹ إنهاء' }],
    data: { url: '/#tab-pomodoro', ongoing: true, remainingMs: remaining, paused: paused }
  });
  return true;
}

function closeOngoingNotification() {
  lastOngoingText = '';
  try {
    if (!self.registration.getNotifications) return Promise.resolve();
    return self.registration.getNotifications({ tag: ONGOING_TAG })
      .then((list) => (list || []).forEach((n) => n && n.close && n.close()))
      .catch(() => {});
  } catch (e) { return Promise.resolve(); }
}

function showNotificationSafe(title, opts) {
  try {
    const p = self.registration.showNotification(title, opts);
    return (p && p.catch) ? p.catch(() => {}) : Promise.resolve();
  } catch (e) { return Promise.resolve(); }
}

function broadcast(msg) {
  return self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
    (clients || []).forEach((client) => {
      if (client && client.postMessage) client.postMessage(msg);
    });
  }).catch(() => {});
}

// نخزّن حالة المؤقّت والتذكيرات في الكاش لتعود بعد إعادة تشغيل الخدمة الخلفية
function persistPomoTimer() {
  const state = JSON.stringify({
    deadline: pomoDeadline || 0,
    pausedMs: pomoPausedMs || 0,
    payload: pomoPayload || null,
    alerts: Object.values(scheduledAlerts)
  });
  return caches.open(CACHE_NAME).then((cache) => {
    return cache.put(POMO_STORE_KEY, new Response(state));
  }).catch(() => {});
}

function parseStoredState(txt) {
  const raw = String(txt || '').trim();
  if (!raw) return null;
  // صيغة قديمة (v31): رقم فقط = وقت النهاية
  if (/^\d+$/.test(raw)) return { deadline: parseInt(raw) || 0, pausedMs: 0, payload: null, alerts: [] };
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    return {
      deadline: Number(obj.deadline) || 0,
      pausedMs: Number(obj.pausedMs) || 0,
      payload: obj.payload || null,
      alerts: Array.isArray(obj.alerts) ? obj.alerts : []
    };
  } catch (e) { return null; }
}

function restorePomoTimer() {
  return caches.open(CACHE_NAME).then((cache) => cache.match(POMO_STORE_KEY)).then((res) => {
    if (!res || !res.text) return null;
    return res.text().then((txt) => parseStoredState(txt));
  }).then((saved) => {
    if (!saved) return;
    pomoPayload = saved.payload || pomoPayload;
    scheduledAlerts = {};
    (saved.alerts || []).forEach((a) => scheduleAlert(a));

    if (saved.pausedMs > 0) {            // جلسة موقوفة مؤقتاً ← تبقى كما هي
      pomoPausedMs = saved.pausedMs;
      pomoDeadline = 0;
      refreshOngoingNotification(true);
      startPomoWatchdog();
    } else if (saved.deadline) {
      pomoDeadline = saved.deadline;
      if (Date.now() >= saved.deadline) {
        firePomoNotification();          // انتهت والتطبيق مغلق ← أطلق التنبيه الآن
      } else {
        armPomoTimer();
        refreshOngoingNotification(true);
      }
    }
    fireDueAlerts(Date.now());           // تذكيرات استحقّت والخدمة نائمة
    stopPomoWatchdogIfIdle();
  }).catch(() => {});
}

// الضغط على الإشعار: زر إيقاف/استئناف/إنهاء أو فتح التطبيق على تبويب التركيز
self.addEventListener('notificationclick', (event) => {
  const action = event.action || '';
  const notification = event.notification || {};
  const data = notification.data || {};

  if (action === 'pause') {
    if (notification.close) notification.close();
    event.waitUntil(Promise.resolve(pausePomoTimer(Math.max(0, pomoDeadline - Date.now()), true)));
    return;
  }
  if (action === 'resume') {
    if (notification.close) notification.close();
    event.waitUntil(Promise.resolve(resumePomoTimer(pomoPausedMs, true)));
    return;
  }
  if (action === 'stop') {
    if (notification.close) notification.close();
    cancelPomoTimer();
    event.waitUntil(broadcast({ type: 'POMO_CANCELLED' }));
    return;
  }

  if (notification.close) notification.close();
  const target = data.url || '/';
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

// إغلاق الإشعار المستمر يدوياً لا يوقف الجلسة — نعيد عرضه عند الفحص التالي
self.addEventListener('notificationclose', (event) => {
  const data = (event.notification && event.notification.data) || {};
  if (data.ongoing) lastOngoingText = '';
});
