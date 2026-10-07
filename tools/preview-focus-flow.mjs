// أداة تطوير: تشغيل تجربة غابة التركيز كاملةً في DOM حقيقي (jsdom) والتحقق من كل حالة.
//   npm i --no-save jsdom && node tools/preview-focus-flow.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const jsdom = await import('jsdom').catch(() => null);
if (!jsdom) { console.log('⚠️ تحتاج jsdom: npm i --no-save jsdom'); process.exit(0); }
const { JSDOM, VirtualConsole } = jsdom;

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✅ ' + label + (extra ? ' | ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? ' | ' + extra : '')); }
};

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// جسر اختبار: يُضاف داخل نفس سكربت التطبيق في نسخة مؤقّتة (لا يلمس index.html الأصلي)
// حتى نتحكّم بالوقت الفعلي ونشغّل مسار الاكتمال الحقيقي (checkPomoDeadline).
const BRIDGE = `
;window.__zpTest = {
  // محاكاة مرور الوقت فعلياً: الطابع الزمني هو مصدر الحقيقة (كما في المتصفح)
  setRemaining(sec) { pomoRemaining = Math.max(0, Math.round(sec)); pomoEndTimestamp = Date.now() + pomoRemaining * 1000; if (pomoRunning) safeSetItem('zp_pomo_end_time', String(pomoEndTimestamp)); updatePomoDisplay(); return pomoRemaining; },
  remaining() { return pomoRemaining; },
  completeNow() { pomoEndTimestamp = Date.now() - 1000; return checkPomoDeadline(); },
  isRunning() { return pomoRunning; },
  isPaused() { return pomoPaused; },
  remaining() { return pomoRemaining; },
  errs() { try { return JSON.parse(localStorage.getItem('zp_runtime_errors') || '[]').map(e => e.source + ': ' + e.message); } catch (e) { return ['?']; } },
  activeId() { const s = focusReadSession(); return s && s.id; },
  tileSlots: FOREST_TILE_SLOTS
};`;
const lastScript = html.lastIndexOf('</script>', html.lastIndexOf('</body>'));
const instrumented = html.slice(0, lastScript) + BRIDGE + html.slice(lastScript);

function boot(seedStorage) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.message || e)));
  vc.on('error', (...a) => errors.push(a.join(' ')));
  const dom = new JSDOM(instrumented, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://zeroplus.test/', virtualConsole: vc,
    beforeParse(window) {
      // jsdom لا يوفّر innerText، والتطبيق يعتمد عليه في كل النصوص الديناميكية ← نُحاكي المتصفح
      const elProto = window.HTMLElement.prototype;
      if (!Object.getOwnPropertyDescriptor(elProto, 'innerText')) {
        Object.defineProperty(elProto, 'innerText', {
          configurable: true,
          get() { return this.textContent; },
          set(v) { this.textContent = String(v); },
        });
      }
      window.Notification = Object.assign(function () {}, { permission: 'default', requestPermission: async () => 'default', addEventListener() {} });
      window.navigator.serviceWorker = { controller: { postMessage() {} }, ready: Promise.resolve({ showNotification() {} }), register: () => Promise.resolve({ update() {} }), getRegistrations: () => Promise.resolve([]), addEventListener() {} };
      window.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
      window.confirm = () => true;
      window.alert = () => {};
      window.scrollTo = () => {};
      window.navigator.wakeLock = undefined;
      if (!window.crypto || !window.crypto.subtle) {
        Object.defineProperty(window, 'crypto', { configurable: true, value: { subtle: { digest: async () => new Uint8Array(32).buffer }, getRandomValues: (a) => a } });
      }
      if (seedStorage) for (const [k, v] of Object.entries(seedStorage)) window.localStorage.setItem(k, v);
    },
  });
  return { dom, window: dom.window, errors };
}

console.log('\n=== ١) الإقلاع: تسجيل حساب ثم الدخول لقسم التركيز ===');
const { window: w, errors } = boot();
await new Promise((r) => w.addEventListener('load', r));
await new Promise((r) => setTimeout(r, 80));
const doc = w.document;
const txt = (id) => String(doc.getElementById(id)?.innerText ?? doc.getElementById(id)?.textContent ?? '').trim().replace(/\s+/g, ' ');
const click = (id) => { const el = doc.getElementById(id); if (!el) throw new Error('زر مفقود: ' + id); el.click(); };
const clickSel = (sel) => { const el = doc.querySelector(sel); if (!el) throw new Error('عنصر مفقود: ' + sel); el.click(); };

doc.getElementById('auth-username').value = 'طالب التحقق';
doc.getElementById('auth-password').value = '1234';
await w.handleUserAuthentication();
w.showTab('pomodoro');
await new Promise((r) => setTimeout(r, 30));

check('القسم يفتح على شاشة التركيز', !doc.getElementById('tab-pomodoro').classList.contains('hidden'));
check('مدد التركيز الستّ معروضة', doc.querySelectorAll('#focus-duration-row .focus-duration').length === 6,
  [...doc.querySelectorAll('#focus-duration-row .focus-duration')].map(b => b.textContent.trim()).join(' · '));
check('منتقي الشجرة يعرض ١٦ نوعاً', doc.querySelectorAll('#focus-tree-picker .focus-tree-option').length === 16);
check('المؤقّت يعرض المدة كاملة', txt('pomo-display') === '25:00', txt('pomo-display'));
check('شريط التقدّم يبدأ من صفر', txt('focus-progress-pct') === '0%' && txt('focus-progress-hint').includes('لم تبدأ'));
check('زر البدء واضح', txt('pomo-play-btn').includes('ابدأ جلسة التركيز'), txt('pomo-play-btn'));
check('زر الاستسلام مخفي قبل البدء', doc.getElementById('focus-abandon-btn').classList.contains('hidden'));
check('رسالة الحفظ لا تذكر أي تقنية', !/Supabase|supabase/.test(doc.getElementById('tab-pomodoro').textContent));

console.log('\n=== ٢) اختيار مدة وشجرة ثم بدء الجلسة ===');
clickSel('#focus-duration-row .focus-duration[data-mins="15"]');
check('المدة تغيّرت إلى ١٥ دقيقة', txt('pomo-display') === '15:00' && txt('pomo-status').includes('15'), txt('pomo-status'));
check('الزر المختار مُعلَن كحالة', doc.querySelector('#focus-duration-row .focus-duration[data-mins="15"]').getAttribute('aria-pressed') === 'true');
const pineOption = doc.querySelector('#focus-tree-picker .focus-tree-option[data-species="pine"]');
pineOption.click();
check('اختيار شجرة الصنوبر نجح', w.localStorage.getItem('zp_focus_species') === 'pine' && txt('focus-stage-label').includes('صنوبر'), txt('focus-stage-label'));
click('pomo-play-btn');
await new Promise((r) => setTimeout(r, 20));
check('الجلسة بدأت والواجهة تغيّرت', txt('pomo-play-btn').includes('إيقاف مؤقت'), txt('pomo-play-btn'));
check('إعدادات الجلسة مخفية أثناء التركيز', doc.getElementById('focus-setup').classList.contains('hidden'));
check('زر الاستسلام ظهر', !doc.getElementById('focus-abandon-btn').classList.contains('hidden'));
check('مسرح النموّ فيه خمس مراحل', doc.querySelectorAll('#focus-tree-art [data-tree-stage]').length === 5);
const shownStages = () => [...doc.querySelectorAll('#focus-tree-art [data-tree-stage]')].filter(g => g.style.opacity === '1').map(g => g.dataset.treeStage);
check('المرحلة الظاهرة عند البداية: البذرة', JSON.stringify(shownStages()) === JSON.stringify(['0']), shownStages().join(','));
check('الشجرة المختارة هي التي تنمو', doc.querySelector('#focus-tree-art svg')?.dataset.treeSpecies === 'pine');
check('الجلسة محفوظة للاستعادة بعد التحديث', !!JSON.parse(w.localStorage.getItem('zp_focus_active')),
  w.localStorage.getItem('zp_focus_active'));
check('شريط الجلسة المصغّر ظاهر', !doc.getElementById('focus-mini').classList.contains('hidden'));

console.log('\n=== ٣) النموّ يتبع الوقت الفعلي (طوابع زمنية لا عدّاد شكلي) ===');
const setRemaining = (secs) => { w.__zpTest.setRemaining(secs); };
const growthPoints = [
  [15 * 60, 0, '0', 'غُرست البذرة'],
  [11 * 60 + 15, 25, '1', 'ظهرت النبتة'],
  [7 * 60 + 30, 50, '2', 'صارت شتلة'],
  [3 * 60 + 45, 75, '3', 'كبرت شجرتك'],
  [1, 100, '4', 'نمت بالكامل'],
];
for (const [secs, pct, stage, name] of growthPoints) {
  setRemaining(secs);
  const okPct = txt('focus-progress-pct') === pct + '%';
  const okStage = JSON.stringify(shownStages()) === JSON.stringify([stage]);
  const okName = txt('focus-stage-label') === name;
  check('نسبة ' + pct + '% ← ' + name, okPct && okStage && okName,
    txt('focus-progress-pct') + ' · ' + txt('focus-stage-label') + ' · مراحل: ' + shownStages().join(','));
}
setRemaining(8 * 60);
check('نص المتبقي بالدقائق', /بقي/.test(txt('focus-progress-hint')), txt('focus-progress-hint'));

console.log('\n=== ٤) الإيقاف المؤقت ثم الاستئناف ===');
console.log('   [تشخيص] قبل الضغط: active=' + w.__zpTest.isRunning() + '/' + w.__zpTest.isPaused() + ' remaining=' + w.__zpTest.remaining() + ' label=' + txt('pomo-play-label'));
click('pomo-play-btn');
await new Promise((r) => setTimeout(r, 20));
console.log('   [تشخيص] بعد الضغط: active=' + w.__zpTest.isRunning() + '/' + w.__zpTest.isPaused() + ' remaining=' + w.__zpTest.remaining() + ' label=' + txt('pomo-play-label'));
check('الإيقاف المؤقت يعمل', txt('pomo-play-btn').includes('استئناف الجلسة'), txt('pomo-play-btn'));
check('التقدّم ثابت أثناء الإيقاف', txt('focus-progress-pct') === '46%' || txt('focus-progress-pct') === '47%', txt('focus-progress-pct'));
click('pomo-play-btn');
await new Promise((r) => setTimeout(r, 20));
check('الاستئناف يكمل من نفس النقطة', txt('pomo-play-btn').includes('إيقاف مؤقت') && txt('focus-timer-caption').includes('المتبقي'));
check('لا توجد نسخة ثانية من الجلسة', w.__zpTest.activeId() === JSON.parse(w.localStorage.getItem('zp_focus_active')).id);

console.log('\n=== ٥) الاكتمال: شجرة واحدة تُضاف إلى الغابة ===');
w.__zpTest.completeNow();     // يحاكي انتهاء الوقت فعلياً (نفس مسار checkPomoDeadline)
await new Promise((r) => setTimeout(r, 30));
check('بطاقة الإكمال ظهرت', !doc.getElementById('focus-complete-card').classList.contains('hidden'));
check('رسالة التهنئة صحيحة', txt('focus-complete-title').includes('نمت شجرتك بالكامل'), txt('focus-complete-title'));
check('المدة معروضة', txt('focus-complete-duration').includes('15'), txt('focus-complete-duration'));
check('عدد الأشجار في الغابة = 1', txt('focus-complete-count').includes('1 شجرة'), txt('focus-complete-count'));
check('عدّاد الأشجار يتحدّث', txt('stat-tree-count') === '1 شجرة', txt('stat-tree-count'));
check('الغابة تعرض قطعة أرض واحدة', txt('forest-tiles-chip').includes('قطعة أرض واحدة'), txt('forest-tiles-chip'));
check('الشجرة المزروعة هي الصنوبر', (doc.getElementById('forest-grid').textContent || '').includes('صنوبر'));
check('المسرح يعرض شجرة الجلسة مكتملة', txt('focus-stage-label').includes('نمت بالكامل') && txt('focus-stage-label').includes('صنوبر'), txt('focus-stage-label'));
check('المسرح يعرض رسم الشجرة المكتملة لا معاينة الشجرة القادمة', /<title>صنوبر<\/title>/.test(doc.getElementById('focus-tree-art').innerHTML));
check('زر البدء عاد لحالة الاستعداد', txt('pomo-play-btn').includes('ابدأ جلسة التركيز'), txt('pomo-play-btn'));
check('جلسة اليوم = 1', txt('pomo-count-stat') === '1 جلسات', txt('pomo-count-stat'));
check('إجمالي التركيز = 15 دقيقة', txt('stat-total-mins') === '15 دقيقة', txt('stat-total-mins'));
check('سلسلة اليوم ظهرت', /يوم تركيز واحد|أيام تركيز متتالية/.test(txt('focus-streak-chip')), txt('focus-streak-chip'));
check('أطول جلسة معروضة من بيانات حقيقية', txt('focus-longest-chip') === 'أطول جلسة: 15 دقيقة', txt('focus-longest-chip'));
check('لا إيموجي في بطاقة النتيجة', !/🌳|🌱/.test(doc.getElementById('focus-complete-card').textContent));

console.log('\n=== ٦) جلسة جديدة ← إلغاء (لا شجرة دائمة) ===');
doc.querySelector('#focus-complete-card button[onclick="focusStartAnother()"]').click();
await new Promise((r) => setTimeout(r, 20));
check('بطاقة الإكمال أُغلقت وبقيت الواجهة للجلسة القادمة', doc.getElementById('focus-complete-card').classList.contains('hidden') && txt('focus-stage-label').includes('الشجرة التي ستنمو'));
click('pomo-play-btn');
await new Promise((r) => setTimeout(r, 20));
w.__zpTest.setRemaining(10 * 60);
check('التقدّم ٣٣٪', txt('focus-progress-pct') === '33%', txt('focus-progress-pct'));
click('focus-abandon-btn');
check('نافذة التأكيد فُتحت', !doc.getElementById('focus-confirm-modal').classList.contains('hidden'));
check('النافذة تشرح النتيجة', /لن تُضاف شجرة/.test(doc.getElementById('focus-confirm-modal').textContent));
w.closeFocusConfirm();
check('زر «أكمل التركيز» يغلق النافذة بلا إلغاء', doc.getElementById('focus-confirm-modal').classList.contains('hidden') && txt('pomo-play-btn').includes('إيقاف مؤقت'));
click('focus-abandon-btn');
w.confirmAbandonFocus();
await new Promise((r) => setTimeout(r, 30));
check('بطاقة «لم تكتمل» ظهرت', !doc.getElementById('focus-abandoned-card').classList.contains('hidden'));
check('بطاقة الإكمال لم تظهر', doc.getElementById('focus-complete-card').classList.contains('hidden'));
check('عدد الأشجار لم يزد', txt('stat-tree-count') === '1 شجرة', txt('stat-tree-count'));
check('بطاقة التخلّي تشرح أثر الدقائق', /سُجّلت في إحصاءات اليوم/.test(txt('focus-abandoned-sub')), txt('focus-abandoned-sub'));
check('دقائق ما قبل التوقف تظهر في إحصاءات اليوم', /من جلسات لم تكتمل/.test(txt('focus-today-mins')), txt('focus-today-mins'));
check('شجرة الغابة لم تتغيّر', doc.querySelectorAll('#forest-grid .ds-tile').length === 1 && /صنوبر/.test(doc.getElementById('forest-grid').textContent), doc.getElementById('forest-grid').textContent.trim().slice(0, 40));
check('عدد جلسات اليوم لم يزد', txt('pomo-count-stat') === '1 جلسات', txt('pomo-count-stat'));
check('الحفظ التلقائي يطمئن الطالب', /محفوظ/.test(txt('forest-cloud-state')), txt('forest-cloud-state'));

console.log('\n=== ٧) تحديث الصفحة أثناء جلسة: لا تكرار ولا شجرة مجانية ===');
clickSel('#focus-abandoned-card button');    // جلسة جديدة
w.setPomoMode(15, 'جلسة تركيز (15 دقيقة)', null);
click('pomo-play-btn');
await new Promise((r) => setTimeout(r, 20));
const midSessionId = JSON.parse(w.localStorage.getItem('zp_focus_active')).id;
const storageSnapshot = {};
for (let i = 0; i < w.localStorage.length; i++) {
  const k = w.localStorage.key(i);
  storageSnapshot[k] = w.localStorage.getItem(k);
}
const reloaded = boot(storageSnapshot);          // صفحة جديدة بنفس بيانات الجهاز
await new Promise((r) => reloaded.window.addEventListener('load', r));
await new Promise((r) => setTimeout(r, 80));
const w2 = reloaded.window;
const txt2 = (id) => String(w2.document.getElementById(id)?.innerText ?? w2.document.getElementById(id)?.textContent ?? '').trim().replace(/\s+/g, ' ');
w2.showTab('pomodoro');
await new Promise((r) => setTimeout(r, 20));
check('الجلسة الجارية استُعيدت بعد التحديث', w2.__zpTest.isRunning() || w2.__zpTest.isPaused(),
  'running=' + w2.__zpTest.isRunning() + ' paused=' + w2.__zpTest.isPaused());
check('معرّف الجلسة نفسه (لا جلسة مكرّرة)', JSON.parse(w2.localStorage.getItem('zp_focus_active')).id === midSessionId);
check('الوقت المتبقي استُعيد من الطابع الزمني', /^(0[0-9]|1[0-5]):[0-5][0-9]$/.test(txt2('pomo-display')), txt2('pomo-display'));
check('مسرح النموّ معروض (لا معاينة مكتملة)', w2.document.querySelectorAll('#focus-tree-art [data-tree-stage]').length === 5);
check('الشجرة لم تُزرع أثناء الجلسة', w2.displayForest().length === 1, String(w2.displayForest().length));
w2.__zpTest.setRemaining(0);
await new Promise((r) => setTimeout(r, 700));
check('بعد الاكتمال: شجرتان فقط (واحدة لكل جلسة)', w2.displayForest().length === 2, String(w2.displayForest().length));
w2.checkPomoDeadline();               // محاولة تحصيل مكرّرة لنفس الجلسة
await new Promise((r) => setTimeout(r, 30));
check('إعادة التحصيل لا تزرع شجرة إضافية', w2.displayForest().length === 2, String(w2.displayForest().length));
check('فحص ثابت: معرّفات الأشجار فريدة', new Set(w2.displayForest().map(t => String(t.id))).size === 2);
check('أشجار الجلسة الأولى ما زالت في الغابة', txt2('stat-tree-count') === '2 شجرة', txt2('stat-tree-count'));

console.log('\n=== ٨) امتلاء قطعة الأرض ← قطعة جديدة ===');
for (let i = 0; i < 15; i++) {
  w2.setPomoMode(15, 'جلسة تركيز (15 دقيقة)', null);
  w2.startPomo();
  w2.__zpTest.setRemaining(0);
  await new Promise((r) => setTimeout(r, 620));
}
await new Promise((r) => setTimeout(r, 60));
const total = w2.displayForest().length;
check('المجموع 17 شجرة', total === 17, String(total));
check('عدّاد القطع يعرض قطعتين', txt2('forest-tiles-chip').includes('قطعتا أرض'), txt2('forest-tiles-chip'));
check('مواضع القطعة الحالية 1/16', txt2('forest-slot-chip') === '1 / 16 في القطعة الحالية', txt2('forest-slot-chip'));
check('المشهد يرسم قطعتَي أرض', (w2.document.getElementById('forest-scene').innerHTML.match(/forest-tile-shadow/g) || []).length === 2);
check('سجل الأشجار يعرض 17 شجرة', w2.document.querySelectorAll('#forest-grid .ds-tile').length === 17);
const expectMins = w2.displayForest().reduce((sum, t) => sum + (Number(t.duration) || 0), 0);   // الإجمالي = الجلسات المكتملة (كما في بقية التطبيق)
check('إجمالي التركيز تجمّع صحيحاً', txt2('stat-total-mins') === expectMins + ' دقيقة', txt2('stat-total-mins') + ' (متوقّع ' + expectMins + ')');
check('دقائق الجلسات المتوقّفة سُجّلت في إحصاءات اليوم', w2.focusTodayMins() > 0, String(w2.focusTodayMins()));
check('نصّ الساعات للطالب', /4 ساعة/.test(txt2('focus-total-long')), txt2('focus-total-long'));
check('لا أخطاء وقت التشغيل في الجلسة الثانية', reloaded.errors.filter(e => !/scrollTo|Not implemented/.test(e)).length === 0,
  reloaded.errors.slice(0, 2).join(' | '));
check('لا أخطاء في الجلسة الأولى', errors.filter(e => !/scrollTo|Not implemented/.test(e)).length === 0, errors.slice(0, 2).join(' | '));

w.close(); w2.close();
console.log('\nالنتيجة: ' + pass + ' فحصاً ناجحاً، ' + fail + ' فاشلاً');
process.exit(fail ? 1 : 0);
