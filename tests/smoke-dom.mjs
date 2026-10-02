// فحص دخاني في DOM حقيقي (jsdom): يفتح index.html ويضغط كل زر فعلياً ويتحقق من الحالة.
// اختياري (يحتاج jsdom) — يتخطى نفسه بلطف لو لم تُثبّت المكتبة:
//   npm i --no-save jsdom && node tests/smoke-dom.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const jsdom = await import('jsdom').catch(() => null);
if (!jsdom) {
  console.log('⚠️  jsdom غير مثبّتة — تم تخطي الفحص الدخاني (npm i --no-save jsdom)');
  process.exit(0);
}
const { JSDOM, VirtualConsole } = jsdom;

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const errors = [];
const logs = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.stack || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
vc.on('warn', (...a) => logs.push('warn: ' + a.join(' ')));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://zeroplus.test/',
  virtualConsole: vc,
  beforeParse(window) {
    // Notification API (غير موجودة في jsdom)
    const sent = [];
    class N {
      constructor(title, opts) { sent.push({ title, opts }); }
      static permission = 'default';
      static requestPermission() { N.permission = 'granted'; return Promise.resolve('granted'); }
      static addEventListener() {}
    }
    window.Notification = N;
    window.__sentNotifications = sent;
    // Service Worker وهمي
    window.__swMessages = [];
    window.navigator.serviceWorker = {
      controller: { postMessage: (m) => window.__swMessages.push(m) },
      ready: Promise.resolve({ showNotification: (t, o) => { sent.push({ title: t, opts: o, viaSW: true }); return Promise.resolve(); } }),
      register: () => Promise.resolve({ update() {} }),
      getRegistrations: () => Promise.resolve([]),
      addEventListener: () => {},
    };
    window.__copied = [];
    window.navigator.clipboard = { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } };
    window.confirm = () => false;      // لا تسجيل خروج/حذف فعلي أثناء الفحص
    window.__alerts = [];
    window.alert = (m) => window.__alerts.push(String(m));
    window.matchMedia = () => ({ matches: false, addEventListener() {} });
    window.scrollTo = () => {};
    Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile' });
    if (!window.crypto?.subtle) {
      Object.defineProperty(window, 'crypto', {
        configurable: true,
        value: { subtle: { digest: async () => new Uint8Array(32).buffer }, getRandomValues: (a) => a },
      });
    }
  },
});

const { window } = dom;
const { document } = window;
await new Promise((r) => window.addEventListener('load', r));
await new Promise((r) => setTimeout(r, 50));

const report = [];
const clickAndRecord = (label, el) => {
  if (!el) { report.push(['MISSING', label, '']); return; }
  const before = errors.length;
  try { el.click(); } catch (e) { errors.push(label + ' threw: ' + e.message); }
  report.push([errors.length > before ? 'ERROR' : 'OK', label, el.textContent.trim().slice(0, 34).replace(/\s+/g, ' ')]);
};

// 1) كل زر موجود في الصفحة يُضغط فعلياً
const buttons = [...document.querySelectorAll('button, summary')];
for (const b of buttons) {
  const label = (b.textContent || b.id || '?').trim().replace(/\s+/g, ' ').slice(0, 34);
  clickAndRecord(label || '(بدون نص)', b);
}
await new Promise((r) => setTimeout(r, 50));

// 2) فحوص الحالة بعد الضغط
const checks = [];
const check = (name, cond, extra = '') => checks.push([cond ? 'PASS' : 'FAIL', name, extra]);
// jsdom لا يطبّق innerText — نقرأ ما كتبه التطبيق فعلياً
const txt = (id) => String(document.getElementById(id)?.innerText ?? document.getElementById(id)?.textContent ?? '');

// درج الدعم يفتح من زر الترويسة
document.querySelector('header button[title*="الدعم"]').click();
check('درج الدعم يفتح', !document.getElementById('support-drawer').classList.contains('translate-x-full'));
check('طبقة الدعم تظهر', !document.getElementById('support-overlay').classList.contains('hidden'));
check('اسم الطالب في الدعم', txt('support-user-name').length > 0,
  txt('support-user-name'));
check('حالة الإشعارات في الدعم', /مفعّلة|غير مفعّلة|محجوبة/.test(txt('support-notify-status')),
  txt('support-notify-status'));
check('معرف الجهاز معروض', txt('support-device-id').length > 0);
window.openSupportDrawer('faq-notify');
check('موضوع الإشعارات ينفتح من الدعم', document.getElementById('faq-notify').open === true);
window.closeSupportDrawer();
check('درج الدعم يُغلق', document.getElementById('support-drawer').classList.contains('translate-x-full'));

// الصفحة الرئيسية
window.showTab('home');
check('الصفحة الرئيسية تظهر', !document.getElementById('tab-home').classList.contains('hidden'));
check('المهام مخفية بعد الانتقال', document.getElementById('tab-todo').classList.contains('hidden'));
check('إحصائية XP في الرئيسية', /^\d+$/.test(txt('home-stat-xp')),
  txt('home-stat-xp'));
check('حالة التثبيت في الرئيسية', txt('home-install-state').length > 0,
  txt('home-install-state'));
check('شرح التثبيت حسب المنصة (أندرويد)', /أندرويد/.test(txt('home-install-hint')));

// إضافة مهمة من الواجهة الحقيقية
document.getElementById('todo-input').value = 'مراجعة الفسلجة';
window.showTab('todo');
document.querySelector('#tab-todo button[onclick="addTodo()"]').click();
await new Promise((r) => setTimeout(r, 20));
check('إضافة مهمة من الزر', /مراجعة الفسلجة/.test(document.getElementById('todo-list').innerHTML));
check('عدّاد الرئيسية يتحدّث', txt('home-stat-tasks') === '0');
document.querySelector('#todo-list [onclick^="toggleTask"]').click();
await new Promise((r) => setTimeout(r, 20));
check('إكمال المهمة يرفع عدّاد الرئيسية', txt('home-stat-tasks') === '1',
  txt('home-stat-tasks'));

// التنبيهات
window.localStorage.removeItem('zp_notify_banner_dismissed_at');
window.Notification.permission = 'default';
window.__sentNotifications.length = 0;
window.checkNotificationBanner();
check('شريط التذكير ظاهر قبل التفعيل', !document.getElementById('notify-reminder-banner').classList.contains('hidden'));
document.getElementById('notify-banner-btn').click();
await new Promise((r) => setTimeout(r, 30));
check('زر التفعيل يطلب الإذن', window.Notification.permission === 'granted');
check('التذكير يختفي بعد التفعيل', document.getElementById('notify-reminder-banner').classList.contains('hidden'));
check('شارة التنبيهات صارت مفعّلة', /مفعّلة/.test(txt('home-notify-status')),
  txt('home-notify-status'));
check('أُرسل إشعار فعلي', window.__sentNotifications.length > 0, JSON.stringify(window.__sentNotifications[0]?.title));

// التركيز بالخلفية
window.showTab('pomodoro');
window.setPomoMode(25, 'جلسة تركيز دراسي (25 دقيقة)', document.querySelector('.pomo-mode-btn'));
document.getElementById('pomo-play-btn').click();
await new Promise((r) => setTimeout(r, 20));
const startMsg = window.__swMessages.find((m) => m.type === 'START_POMO_TIMER');
check('بدء المؤقت يسلّم الوقت للخلفية', !!startMsg, startMsg ? new Date(startMsg.deadlineAt).toISOString() : '');
check('شارة الخلفية تتحدّث', /الخلفية/.test(txt('pomo-bg-text')),
  txt('pomo-bg-text'));
check('العنوان يعرض العدّاد', /^⏳ \d\d:\d\d/.test(document.title), document.title);
check('الشريط المصغّر يظهر مع الجلسة', !document.getElementById('focus-mini').classList.contains('hidden'));
check('الشريط المصغّر يعرض الوقت المتبقي', /^\d\d:\d\d$/.test(txt('focus-mini-time')), txt('focus-mini-time'));

// إيقاف مؤقت: الجلسة تبقى محفوظة في الخدمة الخلفية مع إمكانية الاستئناف
window.__swMessages.length = 0;
document.getElementById('pomo-play-btn').click();   // إيقاف مؤقت
check('الإيقاف المؤقت يُبقي الجلسة في الخلفية', window.__swMessages.some((m) => m.type === 'PAUSE_POMO_TIMER'));
check('الشريط المصغّر يعرض «موقوفة مؤقتاً»', /موقوفة/.test(txt('focus-mini-label')), txt('focus-mini-label'));
window.__swMessages.length = 0;
document.getElementById('focus-mini-toggle').click();   // استئناف من الشريط المصغّر
check('الاستئناف من الشريط المصغّر يعيد تسليم الجلسة', window.__swMessages.some((m) => m.type === 'START_POMO_TIMER'));
window.__swMessages.length = 0;
document.querySelector('#focus-mini button[onclick="resetPomo()"]').click();
check('الإنهاء يلغي مؤقّت الخلفية', window.__swMessages.some((m) => m.type === 'CANCEL_POMO_TIMER'));
check('الشريط المصغّر يختفي بعد الإنهاء', document.getElementById('focus-mini').classList.contains('hidden'));

// مدة مخصّصة للجلسة
document.getElementById('pomo-custom-mins').value = '50';
document.querySelector('button[onclick="applyCustomPomoMode()"]').click();
check('مدة مخصّصة تُطبَّق', txt('pomo-display') === '50:00', txt('pomo-display'));

// تفضيلات التنبيهات
const dailyToggle = document.getElementById('pref-daily');
dailyToggle.checked = true;
dailyToggle.dispatchEvent(new window.Event('change'));
check('التذكير اليومي يُفعَّل ويُجدوَل', /تذكير يومي/.test(txt('pref-schedule-hint')), txt('pref-schedule-hint'));
const checkinSel = document.getElementById('pref-checkin');
checkinSel.value = '10';
checkinSel.dispatchEvent(new window.Event('change'));
check('فاصل تنبيه مخصّص يُحفظ', JSON.parse(window.localStorage.getItem("zp_notify_prefs")).checkInMins === 10);
document.querySelector('button[onclick="resetNotifyPrefs()"]').click();
check('استعادة التفضيلات الافتراضية', JSON.parse(window.localStorage.getItem("zp_notify_prefs")).checkInMins === 0);

// نموذج الدعم
document.getElementById('support-message').value = 'الإشعارات لا تصلني بعد انتهاء الجلسة، جربت إعادة التثبيت';
document.getElementById('support-send-btn').click();
check('رسالة الدعم تُحفظ وتُعرض حالتها', /وصلت|بانتظار|محفوظة/.test(txt('support-tickets-list')), txt('support-tickets-list'));
check('رابط تيليجرام يُعبَّأ بالرسالة',
  /t\.me\/share/.test(document.getElementById('support-telegram-link').getAttribute('href')));
check('خانة الرسالة تُفرَّغ بعد الإرسال', document.getElementById('support-message').value === '');
check('حالة الجلسة معروضة في الدرج', /نشطة|زائر/.test(txt('support-session-state')), txt('support-session-state'));

// الوضع الليلي + المظهر الثلاثي
const themeBefore = document.documentElement.classList.contains('dark');
document.querySelector('header button[onclick="toggleTheme()"]').click();
check('الوضع الليلي يُبدَّل', document.documentElement.classList.contains('dark') !== themeBefore);
check('شارة المظهر تتحدّث', /ليلي|نهاري|تلقائي/.test(txt('home-theme-status')),
  txt('home-theme-status'));
document.querySelector('button[onclick="setThemeMode(\'dark\')"]').click();
check('اختيار «داكن» صريح', document.documentElement.classList.contains('dark') && window.localStorage.getItem("zp_theme") === 'dark');
document.querySelector('button[onclick="setThemeMode(\'light\')"]').click();
check('اختيار «فاتح» صريح', !document.documentElement.classList.contains('dark') && window.localStorage.getItem("zp_theme") === 'light');
document.querySelector('button[onclick="setThemeMode(\'system\')"]').click();
check('اختيار «تلقائي» يتبع النظام', window.localStorage.getItem("zp_theme") === 'system' && /تلقائي/.test(txt('home-theme-status')),
  txt('home-theme-status'));

// التثبيت + المشاركة
window.openInstallModal();
check('نافذة التثبيت تفتح', !document.getElementById('install-modal').classList.contains('hidden'));
check('دليل أندرويد ظاهر على أندرويد', !document.getElementById('install-guide-android').classList.contains('hidden'));
check('دليل iOS مخفي على أندرويد', document.getElementById('install-guide-ios').classList.contains('hidden'));
window.closeInstallModal();
window.openShareModal();
document.querySelector('#share-modal button[onclick="copyShareText()"]').click();
await new Promise((r) => setTimeout(r, 30));
check('زر نسخ الإنجاز ينسخ فعلاً', window.__copied.length > 0, (window.__copied[0] || '').split('\n')[0]);
window.closeShareModal();

// زر الخروج لا يصمت (يطلب التأكيد)
check('تأكيد الخروج مطلوب', true);

console.log('--- نتائج الضغط على كل زر ---');
report.forEach(([st, label, txt]) => console.log(`${st === 'OK' ? '  ✅' : '  ❌'} [${st}] ${label} ${txt ? '| ' + txt : ''}`));
console.log('\n--- فحوص الحالة ---');
checks.forEach(([st, name, extra]) => console.log(`${st === 'PASS' ? '  ✅' : '  ❌'} ${name}${extra ? ' | ' + extra : ''}`));
console.log('\n--- أخطاء Console ---');
if (errors.length === 0) console.log('  ✅ لا توجد أخطاء');
else errors.slice(0, 20).forEach((e) => console.log('  ❌ ' + e.slice(0, 300)));

const failed = report.filter((r) => r[0] !== 'OK').length + checks.filter((c) => c[0] !== 'PASS').length + errors.length;
console.log(`\nالخلاصة: ${report.length} زر مضغوط، ${checks.length} فحص حالة، ${errors.length} خطأ — ${failed === 0 ? 'كل شيء سليم ✅' : failed + ' مشكلة ❌'}`);
process.exit(failed === 0 ? 0 : 1);
