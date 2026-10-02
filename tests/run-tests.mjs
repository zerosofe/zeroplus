// اختبارات منطق المزامنة: تشغيل سكربت index.html داخل DOM وهمي + Supabase وهمي
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHarness, clearHarnessTimers, ROOT } from './harness.mjs';
import { createSwHarness } from './sw-harness.mjs';
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function rowsOf(mock, table) { return mock._state.tables[table]; }

// ============================================================================
test('1) إنشاء حساب جديد يرسل فقط الأعمدة الموجودة في schema.sql', async () => {
  const { sandbox, supabaseMock, localStorage } = createHarness();
  sandbox.document.getElementById('auth-username').value = 'طالب تجريبي';
  sandbox.document.getElementById('auth-password').value = '1234';
  sandbox.document.getElementById('auth-dept').value = 'labs';

  await sandbox.handleUserAuthentication();

  const profile = rowsOf(supabaseMock, 'profiles')[0];
  assert.ok(profile, 'لم يُنشأ صف الحساب');
  assert.ok(profile.password_hash, 'password_hash مفقود');
  assert.equal(profile.auth_provider, 'local');
  assert.equal(profile.device_id, localStorage.getItem('zp_device_id'));
  assert.equal(localStorage.getItem('zp_owner_device_id'), profile.device_id, 'مفتاح المالك لم يُحفظ');
  assert.equal(supabaseMock._state.calls.filter(c => c.op === 'insert' && c.table === 'profiles').length, 1);
  assert.equal(sandbox.__alerts.length, 0, 'ظهر تنبيه خطأ غير متوقع: ' + sandbox.__alerts.join(' | '));
});

test('2) تسجيل الدخول على جهاز جديد يحفظ device_id محلياً (كان مفقوداً = تعطّل كل المزامنة)', async () => {
  const { sandbox, supabaseMock, localStorage } = createHarness();
  // نجهّز حساباً موجوداً في "السحابة"
  supabaseMock._state.tables.profiles.push({
    id: 'p1', device_id: 'u_' + sandbox.simpleHash('مصطفى'), user_name: 'مصطفى',
    department: 'medicine', xp: 500, total_focus_mins: 120, password_hash: await sandbox.hashPassword('abcd'),
  });
  // متصفح نظيف تماماً (لا device_id ولا owner)
  localStorage.clear();

  sandbox.toggleAuthMode(); // تحويل إلى وضع تسجيل الدخول
  sandbox.document.getElementById('auth-username').value = 'مصطفى';
  sandbox.document.getElementById('auth-password').value = 'abcd';
  await sandbox.handleUserAuthentication();

  assert.equal(localStorage.getItem('zp_device_id'), 'u_' + sandbox.simpleHash('مصطفى'), 'device_id لم يُحفظ بعد تسجيل الدخول');
  assert.equal(localStorage.getItem('zp_owner_device_id'), localStorage.getItem('zp_device_id'));
  assert.equal(sandbox.__api.userXP, 500, 'XP لم يُقرأ من السحابة');
  assert.equal(sandbox.__api.totalFocusMins, 120);
});

test('3) المزامنة offline: تُحفظ في الطابور ثم تُرفع تلقائياً عند عودة الاتصال', async () => {
  const { sandbox, supabaseMock, localStorage } = createHarness();
  await signup(sandbox, 'طالب أوفلاين');
  const deviceId = localStorage.getItem('zp_device_id');

  sandbox.navigator.onLine = false;
  sandbox.document.getElementById('todo-input').value = 'مراجعة التشريح';
  sandbox.document.getElementById('todo-tag').value = 'مقرر تخصصي';
  sandbox.document.getElementById('todo-prio').value = 'high';
  sandbox.addTodo();

  assert.equal(rowsOf(supabaseMock, 'user_tasks').length, 0, 'لا يجب الرفع أثناء انقطاع الاتصال');
  const queued = JSON.parse(localStorage.getItem('zp_sync_queue'));
  assert.ok(queued['tasks:' + deviceId], 'المهمة لم تُسجَّل في طابور المزامنة');

  // عودة الاتصال
  sandbox.navigator.onLine = true;
  await sandbox.flushSyncQueue();

  const task = rowsOf(supabaseMock, 'user_tasks')[0];
  assert.ok(task, 'لم تُرفع المهمة بعد عودة الاتصال');
  assert.equal(task.title, 'مراجعة التشريح');
  assert.equal(task.device_id, deviceId);
  assert.equal(localStorage.getItem('zp_sync_queue'), '{}', 'الطابور لم يُفرَّغ');
});

test('4) دمج السحابة مع المحلي: لا تُفقد مهمة محلية غير مرفوعة', async () => {
  const { sandbox, supabaseMock, localStorage } = createHarness();
  await signup(sandbox, 'طالب دمج');
  const deviceId = localStorage.getItem('zp_device_id');
  supabaseMock._state.tables.user_tasks.push(
    { id: 1000, device_id: deviceId, title: 'مهمة قديمة من السحابة', done: false, tag: '', prio: 'normal' },
  );
  sandbox.__api.tasks = [{ id: 2000, title: 'مهمة محلية جديدة', done: false, tag: '', prio: 'normal' }];

  await sandbox.loadUserDataFromSupabase(deviceId);

  const titles = sandbox.__api.tasks.map(t => t.title).sort();
  assert.deepEqual(titles, ['مهمة قديمة من السحابة', 'مهمة محلية جديدة'], 'الدمج فقد إحدى المهمتين');
  assert.equal(JSON.parse(localStorage.getItem('zp_tasks')).length, 2, 'الحفظ المحلي لم يُحدَّث');
});

test('5) تغيير المستخدم على نفس المتصفح لا يسرّب بيانات الطالب السابق', async () => {
  const { sandbox, supabaseMock, localStorage } = createHarness();
  await signup(sandbox, 'الطالب الأول');
  sandbox.__api.tasks = [{ id: 1, title: 'مهمة خاصة بالأول', done: false, tag: '', prio: 'normal' }];
  sandbox.safeSetItem('zp_tasks', JSON.stringify(sandbox.__api.tasks));

  supabaseMock._state.tables.profiles.push({
    id: 'p2', device_id: 'u_' + sandbox.simpleHash('الطالب الثاني'), user_name: 'الطالب الثاني',
    department: 'general', xp: 0, total_focus_mins: 0, password_hash: await sandbox.hashPassword('pass2'),
  });

  sandbox.toggleAuthMode();
  sandbox.document.getElementById('auth-username').value = 'الطالب الثاني';
  sandbox.document.getElementById('auth-password').value = 'pass2';
  await sandbox.handleUserAuthentication();

  assert.deepEqual(sandbox.__api.tasks, [], 'بيانات الطالب الأول تسرّبت للطالب الثاني');
  assert.equal(localStorage.getItem('zp_avatar_url'), null);
});

test('6) حذف مهمة يحذف صف الطالب نفسه فقط (نفس id على جهازين)', async () => {
  const { sandbox, supabaseMock, localStorage } = createHarness();
  await signup(sandbox, 'طالب الحذف');
  const deviceId = localStorage.getItem('zp_device_id');
  supabaseMock._state.tables.user_tasks.push(
    { id: 777, device_id: deviceId, title: 'لي', done: false, tag: '', prio: 'normal' },
    { id: 777, device_id: 'u_جهاز_آخر', title: 'ليس لي', done: false, tag: '', prio: 'normal' },
  );
  sandbox.__api.tasks = [{ id: 777, title: 'لي', done: false, tag: '', prio: 'normal' }];

  sandbox.deleteTask(777);
  await sandbox.flushSyncQueue();

  const remaining = rowsOf(supabaseMock, 'user_tasks');
  assert.equal(remaining.length, 1, 'عدد الصفوف المتبقية غير صحيح');
  assert.equal(remaining[0].device_id, 'u_جهاز_آخر', 'تم حذف صف طالب آخر!');
});

test('7) خطأ الصلاحيات (42501) يظهر كمؤشر أحمر ويُبقي العملية في الطابور', async () => {
  const { sandbox, supabaseMock, localStorage } = createHarness();
  await signup(sandbox, 'طالب خطأ');
  supabaseMock._state.failures.user_tasks = 'permission denied for table user_tasks';

  sandbox.document.getElementById('todo-input').value = 'مهمة ستفشل';
  sandbox.addTodo();
  await sandbox.flushSyncQueue();

  assert.ok(sandbox.__api.lastSyncError && /permission denied/.test(sandbox.__api.lastSyncError), 'لم يُسجَّل الخطأ');
  const queued = JSON.parse(localStorage.getItem('zp_sync_queue'));
  assert.ok(Object.keys(queued).some(k => k.startsWith('tasks:')), 'فُقدت العملية بعد الفشل');
  assert.match(sandbox.describeCloudError({ message: sandbox.__api.lastSyncError }), /schema\.sql/, 'رسالة التوضيح لا تذكر الحل');
});

test('8) فشل localStorage (امتلاء) لا يكسر التطبيق ويُظهر تنبيهاً واضحاً', async () => {
  const { sandbox, localStorage, alerts } = createHarness();
  localStorage.failKeys = ['zp_avatar_url'];
  const input = {};
  sandbox.document.getElementById('profile-avatar-preview');
  // محاكاة ملف صورة صالح
  const file = { type: 'image/png' };
  const event = { target: { files: [file] } };
  await sandbox.uploadProfileAvatar(event);
  assert.ok(alerts.some(a => /ممتلئة/.test(a)), 'لم يظهر تنبيه امتلاء المساحة: ' + alerts.join(' | '));
});

test('9) إنهاء جلسة تركيز يسجّل الجلسة في Supabase مع المدة الصحيحة', async () => {
  const { sandbox, supabaseMock, localStorage } = createHarness();
  await signup(sandbox, 'طالب الجلسات');
  const deviceId = localStorage.getItem('zp_device_id');
  sandbox.__api.totalFocusMins = 0;

  sandbox.finishPomoSession();
  await sandbox.flushSyncQueue();

  const session = rowsOf(supabaseMock, 'user_focus_sessions')[0];
  assert.ok(session, 'لم تُسجَّل جلسة التركيز');
  assert.equal(session.device_id, deviceId);
  assert.equal(session.duration_mins, 25);
  assert.equal(sandbox.__api.totalFocusMins, 25, 'إجمالي الدقائق لم يُحدَّث محلياً');
});

test('10) تحديث الملف الشخصي لا يرسل avatar_url فارغاً (لا يمسح الصورة السحابية)', async () => {
  const { sandbox, supabaseMock, localStorage } = createHarness();
  await signup(sandbox, 'طالب الصورة');
  const deviceId = localStorage.getItem('zp_device_id');
  rowsOf(supabaseMock, 'profiles')[0].avatar_url = 'data:image/jpeg;base64,OLDPIC';
  supabaseMock._state.calls.length = 0;

  sandbox.__api.userXP = 200;
  await sandbox.syncProfileWithCloud();

  const upsert = supabaseMock._state.calls.find(c => c.op === 'upsert' && c.table === 'profiles');
  assert.ok(upsert, 'لم يحدث upsert للملف');
  assert.ok(!('avatar_url' in upsert.payload), 'أُرسل avatar_url فارغ مما يمسح الصورة');
  assert.equal(rowsOf(supabaseMock, 'profiles')[0].avatar_url, 'data:image/jpeg;base64,OLDPIC', 'الصورة السحابية مُسحت');
  assert.equal(rowsOf(supabaseMock, 'profiles')[0].xp, 200);
});

test('11) كل الأعمدة التي يرسلها التطبيق موجودة في schema.sql (فحص ثابت)', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');
  const needed = {
    profiles: ['password_hash', 'auth_provider', 'email', 'avatar_url', 'node_crowns', 'learning_track'],
    user_tasks: ['id', 'device_id', 'title', 'done', 'tag', 'prio', 'updated_at'],
    user_focus_sessions: ['id', 'device_id', 'session_name', 'duration_mins', 'session_time'],
  };
  for (const [table, cols] of Object.entries(needed)) {
    assert.match(sql, new RegExp('CREATE TABLE IF NOT EXISTS public\\.' + table, 'i'), `جدول ${table} غير معرّف في schema.sql`);
  }
  const profilesSection = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS public.profiles'), sql.indexOf('2) جدول المهام'));
  for (const col of needed.profiles) {
    assert.match(profilesSection, new RegExp(col), `العمود ${col} مفقود من profiles`);
  }
  const taskSection = sql.slice(sql.indexOf('public.user_tasks'), sql.indexOf('3) جدول جلسات'));
  for (const col of needed.user_tasks) assert.match(taskSection, new RegExp(col), `العمود ${col} مفقود من user_tasks`);
  const sessSection = sql.slice(sql.indexOf('public.user_focus_sessions'), sql.indexOf('4) جدول تقدم'));
  for (const col of needed.user_focus_sessions) assert.match(sessSection, new RegExp(col), `العمود ${col} مفقود من user_focus_sessions`);
  // السياسات للأدوار الثلاثة/الاثنين
  assert.match(sql, /TO authenticated/, 'لا توجد سياسات للدور authenticated');
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.user_tasks/, 'صلاحيات user_tasks مفقودة');
});

test('12) فشل حفظ حساب Google يُظهر خطأً واضحاً ولا يدخل التطبيق', async () => {
  const { sandbox, supabaseMock, localStorage, alerts } = createHarness();
  supabaseMock._state.failures.profiles = 'permission denied for table profiles';
  sandbox.document.getElementById('google-name-input').value = 'طالب جوجل';
  sandbox.document.getElementById('google-dept-input').value = 'general';

  await sandbox.completeGoogleSignup('g_test', 'student@example.com');

  assert.ok(alerts.some(a => /تعذر حفظ بيانات الحساب/.test(a)), 'لم يظهر تنبيه الفشل: ' + alerts.join(' | '));
  assert.ok(alerts.some(a => /schema\.sql/.test(a)), 'التنبيه لا يشرح الحل');
  assert.equal(localStorage.getItem('zp_user_registered'), null, 'دخل التطبيق رغم فشل الحفظ');
});

test('13) الخروج مع وجود تغييرات غير مزامنة لا يمحو الطابور', async () => {
  const { sandbox, supabaseMock, localStorage } = createHarness();
  await signup(sandbox, 'طالب الخروج');
  const deviceId = localStorage.getItem('zp_device_id');
  sandbox.navigator.onLine = false;
  sandbox.document.getElementById('todo-input').value = 'مهمة قبل الخروج';
  sandbox.addTodo();
  assert.ok(sandbox.__api.pendingCount > 0, 'لم يتكوّن طابور معلّق');

  await sandbox.handleUserLogout();

  assert.equal(localStorage.getItem('zp_device_id'), null, 'device_id لم يُمسح عند الخروج');
  assert.equal(localStorage.getItem('zp_owner_device_id'), deviceId, 'مفتاح المالك يجب أن يبقى لكشف تغيّر المستخدم');
  const queued = JSON.parse(localStorage.getItem('zp_sync_queue'));
  assert.ok(queued['tasks:' + deviceId], 'ضاعت المهمة غير المزامنة عند الخروج');
  assert.ok(sandbox.__confirmations.some(c => /لم تُزامن/.test(c)), 'لم يُحذَّر المستخدم من التغييرات غير المزامنة');
});

test('14) حذف مهمة من جهاز آخر لا تُحييها نسخة ثانية (نفس الحساب على جهازين)', async () => {
  const { sandbox, supabaseMock, localStorage } = createHarness();
  await signup(sandbox, 'طالب جهازين');
  const deviceId = localStorage.getItem('zp_device_id');

  // الجهاز (أ) رأى مهمتين في السحابة سابقاً
  supabaseMock._state.tables.user_tasks.push(
    { id: 11, device_id: deviceId, title: 'مهمة ١١', done: false, tag: '', prio: 'normal' },
    { id: 22, device_id: deviceId, title: 'مهمة ٢٢', done: false, tag: '', prio: 'normal' },
  );
  await sandbox.loadUserDataFromSupabase(deviceId);
  assert.equal(sandbox.__api.tasks.length, 2, 'لم تُقرأ المهام الأولى');

  // الجهاز (ب) يحذف المهمة 22 من السحابة
  supabaseMock._state.tables.user_tasks = supabaseMock._state.tables.user_tasks.filter(t => t.id !== 22);

  await sandbox.loadUserDataFromSupabase(deviceId);
  await sandbox.flushSyncQueue();

  assert.deepEqual(sandbox.__api.tasks.map(t => t.id), [11], 'أُحييت المهمة المحذوفة من جهاز آخر');
});

test('15) مهمة محلية جديدة (لم تُرفع بعد) لا تُحذف عند الدمج حتى لو ليست في السحابة', async () => {
  const { sandbox, supabaseMock, localStorage } = createHarness();
  await signup(sandbox, 'طالب مهمة جديدة');
  const deviceId = localStorage.getItem('zp_device_id');
  // مهاجرة من نسخة قديمة: مهمة محلية موجودة بلا أي عملية في الطابور
  sandbox.__api.tasks = [{ id: 999, title: 'مهمة قديمة محلية', done: false, tag: '', prio: 'normal' }];
  sandbox.safeSetItem('zp_tasks', JSON.stringify(sandbox.__api.tasks));
  await sandbox.loadUserDataFromSupabase(deviceId);
  await sandbox.flushSyncQueue();
  assert.ok(sandbox.__api.tasks.some(t => t.id === 999), 'فُقدت مهمة محلية غير مرفوعة');
  assert.ok(supabaseMock._state.tables.user_tasks.some(t => t.id === 999), 'لم تُرفع المهمة المحلية للسحابة');
});


// ============================================================================
// اختبارات التحديث الحالي: الأزرار، الإشعارات، الصفحة الرئيسية، الدعم، التركيز بالخلفية
// ============================================================================

test('16) كل الأزرار في الواجهة مربوطة بدوال موجودة فعلاً', () => {
  const { sandbox } = createHarness();
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const builtin = new Set(['if', 'else', 'return', 'parseInt', 'parseFloat', 'Number', 'String', 'Boolean',
    'event', 'alert', 'confirm', 'prompt', 'setTimeout', 'JSON', 'Math', 'Array', 'Object', 'escapeHtml',
    'window', 'document', 'navigator', 'location', 'this', 'new', 'typeof', 'function', 'true', 'false',
    'null', 'undefined', 'void', 'delete', 'in', 'of']);
  const handlers = new Set();
  const attrRe = /\son(?:click|change|input|keydown|keypress|submit)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(html))) {
    const callRe = /([A-Za-z_$][\w$]*)\s*\(/g;
    let c;
    while ((c = callRe.exec(m[1]))) if (!builtin.has(c[1])) handlers.add(c[1]);
  }
  assert.ok(handlers.size >= 30, `عدد الدوال المكتشفة قليل بشكل مريب: ${handlers.size}`);
  const missing = [...handlers].filter((fn) => typeof sandbox[fn] !== 'function');
  assert.deepEqual(missing, [], 'أزرار تستدعي دوالاً غير معرّفة: ' + missing.join(', '));
});

test('17) تذكير الإشعارات يتفاعل مع حالة الإذن (غير مفعّلة / مفعّلة / محجوبة)', async () => {
  const { sandbox, nodes } = createHarness();
  const bannerHidden = () => nodes.get('notify-reminder-banner').classList.contains('hidden');

  const landingVisible = () => nodes.get('landing-notify-card').classList.contains('flex');
  sandbox.Notification.permission = 'default';
  sandbox.checkNotificationBanner();
  assert.equal(bannerHidden(), false, 'التذكير مخفي مع أن الإشعارات غير مفعّلة');
  assert.equal(landingVisible(), true, 'تذكير شاشة الدخول غير ظاهر');
  assert.match(nodes.get('notify-banner-btn').innerText, /تفعيل الآن/);
  assert.match(nodes.get('home-notify-status').innerText, /غير مفعّلة/);

  sandbox.Notification.permission = 'granted';
  sandbox.checkNotificationBanner();
  assert.equal(bannerHidden(), true, 'التذكير ما زال ظاهراً بعد التفعيل');
  assert.equal(landingVisible(), false, 'تذكير شاشة الدخول ما زال ظاهراً بعد التفعيل');
  assert.match(nodes.get('home-notify-status').innerText, /مفعّلة/);
  assert.match(nodes.get('notify-icon').className, /emerald/);

  sandbox.Notification.permission = 'denied';
  sandbox.checkNotificationBanner();
  assert.equal(bannerHidden(), false, 'لا يوجد تنبيه عند حجب الإشعارات');
  assert.match(nodes.get('notify-banner-btn').innerText, /خطوات التفعيل/);
  assert.match(nodes.get('home-notify-status').innerText, /محجوبة/);
  assert.match(nodes.get('landing-notify-text').innerText, /محجوبة/, 'شاشة الدخول لا تشرح أن الإشعارات محجوبة');
  assert.equal(landingVisible(), true, 'تذكير شاشة الدخول اختفى رغم الحجب');
  await sandbox.requestNotificationPermission();
  assert.equal(nodes.get('support-drawer').classList.contains('translate-x-full'), false, 'لم تُفتح خطوات التفعيل عند الحجب');
});

test('18) تفعيل التنبيهات يرسل إشعاراً حقيقياً عبر الخدمة الخلفية', async () => {
  const { sandbox } = createHarness();
  // الحالة (أ): الإذن ممنوح مسبقاً ← إشعار تجريبي
  sandbox.Notification.permission = 'granted';
  assert.equal(await sandbox.requestNotificationPermission(), 'granted');
  assert.equal(sandbox.__notifications.length, 1, 'لم يُرسل أي إشعار');
  assert.equal(sandbox.__notifications[0].viaSW, true, 'الإشعار لم يمر عبر الخدمة الخلفية');
  assert.equal(sandbox.__notifications[0].opts.dir, 'rtl');

  // الحالة (ب): المستخدم يوافق على الطلب الآن
  const { sandbox: sb2 } = createHarness();
  sb2.Notification.permission = 'default';
  sb2.Notification.requestPermission = async () => { sb2.Notification.permission = 'granted'; return 'granted'; };
  assert.equal(await sb2.requestNotificationPermission(), 'granted');
  assert.equal(sb2.__notifications.length, 1, 'لم يُرسل إشعار الترحيب بعد الموافقة');
  assert.match(sb2.__notifications[0].title, /تم تفعيل التنبيهات/);

  // الحالة (ج): إشعار تجريبي من مركز الدعم
  const { sandbox: sb3 } = createHarness();
  sb3.Notification.permission = 'granted';
  assert.equal(await sb3.sendTestNotification(), true);
  assert.equal(sb3.__notifications.length, 1);
});

test('19) بدء المؤقت يسلّم وقت النهاية للخدمة الخلفية والإيقاف يلغيه', () => {
  const { sandbox } = createHarness();
  sandbox.Notification.permission = 'granted';
  const startedAt = Date.now();
  assert.equal(sandbox.startPomo(), true);
  assert.equal(sandbox.__api.pomoRunning, true);
  const start = sandbox.__swMessages.find((m) => m.type === 'START_POMO_TIMER');
  assert.ok(start, 'لم تُرسل رسالة بدء المؤقت للخدمة الخلفية (لا تركيز بالخلفية)');
  assert.ok(Math.abs(start.deadlineAt - (startedAt + 25 * 60 * 1000)) < 5000, 'وقت النهاية المرسل غير صحيح');
  assert.match(start.body, /25 دقيقة/);
  assert.match(sandbox.document.getElementById('pomo-bg-text').innerText, /الخلفية/, 'شارة الخلفية لا توضح أن التنبيه من الخدمة الخلفية');

  assert.equal(sandbox.pausePomo(), true);
  assert.ok(sandbox.__swMessages.some((m) => m.type === 'CANCEL_POMO_TIMER'), 'لم تُلغَ الجلسة في الخدمة الخلفية');
  assert.equal(sandbox.__api.pomoRunning, false);
  assert.equal(sandbox.__api.pomoEndTimestamp, 0, 'بقي وقت نهاية قديم ← سيُحسب جلسة وهمية');
  assert.equal(sandbox.startPomo(), true, 'لا يمكن بدء جلسة جديدة بعد الإيقاف');
  sandbox.pausePomo();
});

test('20) جلسة انتهت والتطبيق بالخلفية تُحسب مرة واحدة فقط', async () => {
  const { sandbox, supabaseMock } = createHarness();
  await signup(sandbox, 'طالب الخلفية');
  sandbox.__api.pomoEndTimestamp = Date.now() - 2000;   // انتهت والصفحة مخفية
  assert.equal(sandbox.checkPomoDeadline(), true, 'لم تُحصّل الجلسة المنتهية بالخلفية');
  assert.equal(sandbox.checkPomoDeadline(), false, 'أُنهِيت الجلسة مرتين!');
  sandbox.checkPomoDeadline();
  await sandbox.flushSyncQueue();
  assert.equal(sandbox.__api.userForest.length, 1, 'تكرّر تسجيل الجلسة محلياً');
  assert.equal(rowsOf(supabaseMock, 'user_focus_sessions').length, 1, 'تكرّر تسجيل الجلسة في السحابة');
});

test('21) الخدمة الخلفية (sw.js) تطلق إشعار انتهاء الجلسة وتخبر الصفحة', async () => {
  const sw = createSwHarness();
  sw.__message({ type: 'START_POMO_TIMER', deadlineAt: Date.now() + 1000, durationMs: 1000, title: 'انتهى الوقت', body: 'جلسة 25 دقيقة' });
  assert.equal(sw.__notifications.length, 0, 'أُطلق الإشعار قبل انتهاء الوقت');
  sw.__runTimers();
  assert.equal(sw.__notifications.length, 1, 'لم يُطلق إشعار انتهاء الجلسة من الخلفية');
  assert.equal(sw.__notifications[0].opts.tag, 'zp-pomo');
  assert.equal(sw.__notifications[0].opts.requireInteraction, true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sw.__clientMessages.length, 1, 'لم تُخبر الصفحة بانتهاء الجلسة');
  assert.equal(sw.__clientMessages[0].type, 'POMO_FINISHED');

  sw.__message({ type: 'START_POMO_TIMER', deadlineAt: Date.now() + 5000, durationMs: 5000 });
  sw.__message({ type: 'CANCEL_POMO_TIMER' });
  sw.__runTimers();
  sw.__runWatchdog();
  assert.equal(sw.__notifications.length, 1, 'أُطلق إشعار لجلسة أُلغيت');
});

test('22) الخدمة الخلفية تسترجع الجلسة بعد إعادة تشغيلها (انتهت أو ما زالت تعمل)', async () => {
  // جلسة ما زالت تعمل ← إعادة تشغيل الخدمة تعيد تسليح المؤقّت
  const sw1 = createSwHarness();
  sw1.__message({ type: 'START_POMO_TIMER', deadlineAt: Date.now() + 60000, durationMs: 60000 });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(sw1.__cache.get('/__zp_pomo_timer'), 'لم يُحفظ وقت الجلسة في الكاش');

  const sw2 = createSwHarness();
  sw2.__cache.set('/__zp_pomo_timer', sw1.__cache.get('/__zp_pomo_timer'));
  sw2.__fire('activate', { waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(sw2.__timers.some((t) => !t.cancelled), 'لم يُسترجع مؤقّت الجلسة بعد إعادة التشغيل');

  // جلسة انتهت والتطبيق مغلق ← التنبيه يُطلق فور الإقلاع
  const sw3 = createSwHarness();
  sw3.__cache.set('/__zp_pomo_timer', { text: () => Promise.resolve(String(Date.now() - 5000)) });
  sw3.__fire('activate', { waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sw3.__notifications.length, 1, 'لم يُطلق تنبيه الجلسة التي انتهت والتطبيق مغلق');

  // تخزين المؤقّت داخلي — لو اعترضته الخدمة الخلفية لمسحته استجابة 404 من الشبكة
  assert.equal(createSwHarness().__fetchHandled('https://zeroplus.test/__zp_pomo_timer'), false, 'الخدمة تعترض تخزين المؤقّت');
  assert.equal(createSwHarness().__fetchHandled('https://zeroplus.test/index.html'), true, 'الخدمة لا تقدّم صفحات التطبيق من الكاش');
});

test('23) الصفحة الرئيسية: تبويب افتراضي + إحصائيات حيّة + تبويب غير معروف يرجع للرئيسية', async () => {
  const { sandbox, nodes } = createHarness();
  await signup(sandbox, 'طالب الرئيسية');
  sandbox.__api.tasks = [{ id: 1, title: 'مهمة منجزة', done: true, tag: '', prio: 'normal' }];
  ['home', 'todo', 'pomodoro', 'english', 'zero'].forEach((t) => sandbox.showTab(t));
  assert.equal(nodes.get('tab-home').classList.contains('hidden'), true, 'لم يُخفَ تبويب الرئيسية عند الانتقال');
  sandbox.showTab('home');
  assert.equal(nodes.get('tab-home').classList.contains('hidden'), false, 'لم تظهر الصفحة الرئيسية');
  assert.equal(sandbox.__api.activeTabId, 'home');
  sandbox.showTab('تبويب-غير-موجود');
  assert.equal(sandbox.__api.activeTabId, 'home', 'تبويب غير معروف يجب أن يرجع للرئيسية');
  assert.equal(nodes.get('home-stat-xp').innerText, String(sandbox.__api.userXP));
  assert.equal(nodes.get('home-stat-tasks').innerText, '1', 'عدد المهام المكتملة في الرئيسية غير صحيح');
  assert.equal(nodes.get('home-stat-sessions').innerText, '0');
  assert.match(nodes.get('home-hero-title').innerText, /طالب الرئيسية/, 'ترحيب الرئيسية لا يحمل اسم الطالب');
});

test('24) مركز الدعم: نفس بيانات الحساب والإشعارات، يفتح ويغلق', async () => {
  const { sandbox, nodes } = createHarness();
  await signup(sandbox, 'طالب الدعم');
  sandbox.openSupportDrawer('faq-notify');
  assert.equal(nodes.get('support-drawer').classList.contains('translate-x-full'), false, 'درج الدعم لم يُفتح');
  assert.equal(nodes.get('support-overlay').classList.contains('hidden'), false, 'الطبقة الخلفية لم تظهر');
  assert.equal(nodes.get('support-user-name').innerText, 'طالب الدعم');
  assert.ok(nodes.get('support-user-dept').innerText.length > 0, 'قسم الطالب غير معروض في الدعم');
  assert.equal(nodes.get('support-stat-xp').innerText, String(sandbox.__api.userXP));
  assert.match(nodes.get('support-notify-status').innerText, /غير مفعّلة/);
  assert.match(nodes.get('support-device-id').innerText, /^u_/, 'معرف الجهاز غير معروض في الدعم');
  assert.equal(nodes.get('faq-notify').open, true, 'لم يُفتح موضوع الإشعارات المطلوب');
  assert.match(nodes.get('support-version').innerText, /v\d+/);
  sandbox.closeSupportDrawer();
  assert.equal(nodes.get('support-drawer').classList.contains('translate-x-full'), true, 'درج الدعم لم يُغلق');
  assert.equal(nodes.get('support-overlay').classList.contains('hidden'), true);
});

test('25) زر نسخ الإنجاز يعمل وله بديل عند رفض الحافظة', async () => {
  const { sandbox, alerts } = createHarness();
  await signup(sandbox, 'طالب النسخ');
  assert.equal(await sandbox.copyShareText(), true, 'النسخ فشل مع حافظة سليمة');
  assert.match(sandbox.__clipboard.lastText, /XP/);
  sandbox.__clipboard.fail = true;
  alerts.length = 0;
  assert.equal(await sandbox.copyShareText(), false);
  assert.ok(alerts.some((a) => /انسخ النص يدوياً/.test(a)), 'لم يظهر بديل النسخ اليدوي: ' + alerts.join(' | '));
  assert.equal(await sandbox.copyDiagnostics(), false, 'تقرير المشكلة بلا بديل نسخ');
});

test('26) اختصارات التطبيق (#tab-...) تُترجم لتبويب و(#support) لدرج الدعم', () => {
  const { sandbox } = createHarness();
  sandbox.location.hash = '#tab-pomodoro';
  assert.equal(sandbox.tabFromHash(), 'pomodoro');
  sandbox.location.hash = '#tab-english';
  assert.equal(sandbox.tabFromHash(), 'english');
  sandbox.location.hash = '#support';
  assert.equal(sandbox.tabFromHash(), 'support');
  sandbox.location.hash = '#tab-مجهول';
  assert.equal(sandbox.tabFromHash(), null);
  sandbox.location.hash = '';
  assert.equal(sandbox.tabFromHash(), null);
});

test('27) زر التثبيت لا يصمت: يشرح خطوات المنصة عند غياب زر التثبيت التلقائي', () => {
  const { sandbox, alerts, nodes } = createHarness();
  sandbox.navigator.userAgent = 'Mozilla/5.0 (Linux; Android 13) Chrome/120';
  sandbox.triggerAndroidPwaInstall();
  assert.ok(alerts.some((a) => /أندرويد/.test(a)), 'لم تظهر خطوات أندرويد: ' + alerts.join(' | '));

  alerts.length = 0;
  sandbox.navigator.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605';
  sandbox.triggerAndroidPwaInstall();
  assert.ok(alerts.some((a) => /Safari/.test(a)), 'لم تظهر خطوات آيفون');

  sandbox.openInstallModal();
  assert.equal(nodes.get('install-modal').classList.contains('hidden'), false, 'نافذة التثبيت لم تُفتح');
  assert.equal(nodes.get('install-guide-ios').classList.contains('hidden'), false, 'دليل iOS مخفي على آيفون');
  assert.equal(nodes.get('install-guide-android').classList.contains('hidden'), true, 'دليل أندرويد ظهر على آيفون');
  sandbox.closeInstallModal();
  assert.equal(nodes.get('install-modal').classList.contains('hidden'), true, 'نافذة التثبيت لم تُغلق');
});

test('28) الوضع الليلي يُبدَّل ويُحفظ ويُعرض في الرئيسية والدعم', () => {
  const { sandbox, nodes } = createHarness();
  const first = sandbox.localStorage.getItem('zp_theme');
  sandbox.toggleTheme();
  const second = sandbox.localStorage.getItem('zp_theme');
  assert.notEqual(second, first, 'الوضع الليلي لم يُحفظ');
  assert.match(nodes.get('home-theme-status').innerText, /(ليلي|نهاري)/);
  sandbox.toggleTheme();
  assert.notEqual(sandbox.localStorage.getItem('zp_theme'), second, 'لا يمكن الرجوع للمظهر السابق');
});

test('29) إصدار الكاش موحّد بين index.html و sw.js حتى يصل التحديث للطلاب', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const cacheName = (sw.match(/CACHE_NAME = '(zeroplus-v\d+)'/) || [])[1];
  assert.ok(cacheName, 'CACHE_NAME غير موجود في sw.js');
  const ver = cacheName.replace('zeroplus-', '');   // مثال: v31
  assert.ok(html.includes(`startsWith('${cacheName}')`), 'killOldSW في index.html لا يطابق إصدار sw.js');
  const versions = [...new Set([...html.matchAll(/\?v=(\d+)/g)].map((m) => m[1]))];
  assert.deepEqual(versions, [ver.replace('v', '')], 'أرقام الإصدار في index.html غير موحّدة');
  assert.ok(html.includes(`APP_VERSION = '${ver}'`), 'APP_VERSION المعروض للطلاب لا يطابق إصدار الكاش');
  assert.ok(sw.includes(`self.addEventListener('message'`), 'sw.js لا يعالج رسائل الصفحة');
  assert.ok(sw.includes('START_POMO_TIMER') && sw.includes('CANCEL_POMO_TIMER'), 'sw.js لا يعرف رسائل مؤقّت التركيز');
});

test('30) تذكير لطيف بتفعيل التنبيهات عند بدء جلسة بلا تنبيهات (مرتين كحد أقصى)', () => {
  const { sandbox, nodes } = createHarness();
  sandbox.Notification.permission = 'default';
  sandbox.startPomo();
  assert.match(nodes.get('toast-inner').innerText, /فعّل التنبيهات/, 'لم يظهر تذكير التنبيهات');
  assert.equal(sandbox.localStorage.getItem('zp_notify_pomo_nudges'), '1');
  sandbox.pausePomo();
  sandbox.startPomo();
  sandbox.pausePomo();
  sandbox.startPomo();
  sandbox.pausePomo();
  assert.equal(sandbox.localStorage.getItem('zp_notify_pomo_nudges'), '2', 'التذكير تكرر أكثر من الحد');
});

// مساعد: إنشاء حساب جاهز عبر المسار الحقيقي
async function signup(sandbox, name) {
  sandbox.document.getElementById('auth-username').value = name;
  sandbox.document.getElementById('auth-password').value = '1234';
  sandbox.document.getElementById('auth-dept').value = 'general';
  await sandbox.handleUserAuthentication();
  await sandbox.flushSyncQueue();
}

// ---------- تشغيل ----------
let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log('  ✅ ' + name);
    pass++;
  } catch (e) {
    console.log('  ❌ ' + name);
    console.log('     ' + (e && e.message ? e.message.split('\n')[0] : e));
    if (process.env.VERBOSE) console.log(e);
    fail++;
  }
}
console.log(`\nالنتيجة: ${pass} ناجح، ${fail} فاشل من ${tests.length}`);
clearHarnessTimers();   // إغلاق أي مؤقّت مفتوح حتى لا يبقى الاختبار معلّقاً
process.exit(fail ? 1 : 0);
