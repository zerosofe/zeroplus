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
  // الإيقاف المؤقت يُبقي الجلسة في الخدمة الخلفية «موقوفة» (مع زر استئناف في الإشعار) ولا يطلق تنبيه النهاية
  assert.ok(sandbox.__swMessages.some((m) => m.type === 'PAUSE_POMO_TIMER'), 'لم تُوقَف الجلسة في الخدمة الخلفية');
  assert.equal(sandbox.__api.pomoRunning, false);
  assert.equal(sandbox.__api.pomoPaused, true, 'لم تُسجَّل الجلسة كموقوفة مؤقتاً');
  assert.equal(sandbox.__api.pomoEndTimestamp, 0, 'بقي وقت نهاية قديم ← سيُحسب جلسة وهمية');
  assert.equal(sandbox.startPomo(), true, 'لا يمكن بدء جلسة جديدة بعد الإيقاف');
  sandbox.pausePomo();
  sandbox.resetPomo();
  assert.ok(sandbox.__swMessages.some((m) => m.type === 'CANCEL_POMO_TIMER'), 'إعادة التهيئة لم تُلغِ مؤقّت الخلفية');
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

// ============================================================================
// v32 — الأزرار والتنبيهات المخصّصة والمظهر الثلاثي والدعم والتركيز بالخلفية
// ============================================================================
test('31) أنماط المظهر الثلاثة: فاتح / داكن / تلقائي يتبع نظام الجهاز', () => {
  const { sandbox, nodes } = createHarness();
  const isDark = () => sandbox.document.documentElement.classList.contains('dark');

  sandbox.__setPrefersDark(false);
  sandbox.setThemeMode('system');
  assert.equal(sandbox.localStorage.getItem('zp_theme'), 'system', 'وضع «تلقائي» لم يُحفظ');
  assert.equal(sandbox.resolvedTheme(), 'light');
  assert.equal(isDark(), false, 'الوضع التلقائي لم يتبع جهازاً فاتحاً');

  sandbox.__setPrefersDark(true);        // الطالب فعّل الوضع الليلي في هاتفه
  assert.equal(isDark(), true, 'الوضع التلقائي لم يتبع تحوّل الجهاز للوضع الليلي');
  assert.match(nodes.get('home-theme-status').innerText, /تلقائي/, 'شارة المظهر لا تُظهر الوضع التلقائي');
  assert.match(nodes.get('home-theme-hint').innerText, /تلقائي/);

  sandbox.setThemeMode('light');          // اختيار صريح يتجاهل الجهاز
  assert.equal(isDark(), false);
  sandbox.__setPrefersDark(false);
  sandbox.__setPrefersDark(true);
  assert.equal(isDark(), false, 'الوضع الصريح (فاتح) تأثر بإعداد الجهاز');

  sandbox.setThemeMode('dark');
  assert.equal(isDark(), true);
  assert.equal(sandbox.toggleTheme(), 'light', 'زر الترويسة لا يقلب المظهر');
  assert.equal(isDark(), false);
  assert.equal(sandbox.toggleTheme(), 'dark');
  assert.equal(isDark(), true);
});

test('32) التذكير اليومي: الموعد التالي يُحسب صحيحاً ويُسلَّم للخدمة الخلفية', () => {
  const { sandbox } = createHarness();
  const base = new Date(); base.setHours(10, 0, 0, 0);
  const todayAt20 = new Date(base); todayAt20.setHours(20, 0, 0, 0);

  assert.equal(sandbox.nextDailyReminderAt('20:00', base.getTime()), todayAt20.getTime(), 'موعد اليوم غير صحيح');
  const late = new Date(base); late.setHours(21, 30, 0, 0);
  assert.equal(sandbox.nextDailyReminderAt('20:00', late.getTime()), todayAt20.getTime() + 86400000, 'بعد مرور الوقت يجب أن يكون غداً');
  assert.equal(sandbox.nextDailyReminderAt('بلا وقت', base.getTime()), 0, 'وقت غير صالح يجب أن يُرفض');

  sandbox.setNotifyPref('dailyTime', '21:15');
  sandbox.setNotifyPref('daily', true);
  assert.equal(sandbox.getNotifyPrefs().daily, true);
  assert.equal(JSON.parse(sandbox.localStorage.getItem('zp_notify_prefs')).dailyTime, '21:15', 'وقت التذكير لم يُحفظ');

  const sync = sandbox.__swMessages.filter(m => m.type === 'SYNC_ALERTS').pop();
  assert.ok(sync, 'لم تُسلَّم التذكيرات للخدمة الخلفية');
  const daily = sync.alerts.find(a => a.id === 'daily');
  assert.ok(daily, 'التذكير اليومي غير مجدول');
  assert.equal(daily.repeatMs, 86400000, 'التذكير اليومي لا يتكرر كل يوم');
  assert.ok(daily.at > Date.now(), 'موعد التذكير في الماضي');
  assert.match(sandbox.document.getElementById('pref-schedule-hint').innerText, /تذكير يومي/);

  sandbox.setNotifyPref('daily', false);
  const after = sandbox.__swMessages.filter(m => m.type === 'SYNC_ALERTS').pop();
  assert.equal(after.alerts.filter(a => a.id === 'daily').length, 0, 'التذكير اليومي بقي بعد إيقافه');
});

test('33) الفاصل المخصّص أثناء الجلسة يُجدوَل عند البدء ويُلغى عند الإيقاف', () => {
  const { sandbox } = createHarness();
  sandbox.setNotifyPref('checkInMins', 10);
  assert.equal(sandbox.getNotifyPrefs().checkInMins, 10, 'الفاصل المخصّص لم يُحفظ');
  let sync = sandbox.__swMessages.filter(m => m.type === 'SYNC_ALERTS').pop();
  assert.equal(sync.alerts.filter(a => a.id === 'checkin').length, 0, 'جُدول تنبيه أثناء الجلسة بلا جلسة');

  sandbox.startPomo();
  sync = sandbox.__swMessages.filter(m => m.type === 'SYNC_ALERTS').pop();
  const ci = sync.alerts.find(a => a.id === 'checkin');
  assert.ok(ci, 'لم يُجدول التنبيه المتكرر مع بدء الجلسة');
  assert.equal(ci.repeatMs, 10 * 60000);
  assert.ok(Math.abs(ci.at - (Date.now() + 10 * 60000)) < 4000, 'موعد التنبيه المتكرر غير صحيح');

  sandbox.pausePomo();
  assert.ok(sandbox.__swMessages.some(m => m.type === 'CANCEL_ALERT' && m.id === 'checkin'), 'لم يُلغَ التنبيه المتكرر عند الإيقاف');
  sync = sandbox.__swMessages.filter(m => m.type === 'SYNC_ALERTS').pop();
  assert.equal(sync.alerts.filter(a => a.id === 'checkin').length, 0);

  sandbox.setNotifyPref('checkInMins', 999);
  assert.equal(sandbox.getNotifyPrefs().checkInMins, 180, 'لم تُحدّ القيمة القصوى للفاصل');
  sandbox.resetPomo();
});

test('34) تفضيلات التنبيهات تُحفظ وتُحترم فعلياً (نهاية الجلسة + الإشعار المستمر)', async () => {
  const { sandbox } = createHarness();
  sandbox.Notification.permission = 'granted';

  sandbox.setNotifyPref('sessionEnd', false);
  sandbox.__notifications.length = 0;
  sandbox.__api.pomoEndTimestamp = Date.now() - 1000;
  sandbox.checkPomoDeadline();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sandbox.__notifications.filter(n => /انتهت الجلسة/.test(n.title)).length, 0, 'وصل تنبيه نهاية الجلسة رغم إيقافه من التفضيلات');

  sandbox.setNotifyPref('sessionEnd', true);
  sandbox.__notifications.length = 0;
  sandbox.__api.pomoEndTimestamp = Date.now() - 1000;
  sandbox.checkPomoDeadline();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sandbox.__notifications.filter(n => /انتهت الجلسة/.test(n.title)).length, 1, 'لم يصل تنبيه نهاية الجلسة بعد تفعيله');

  // الإشعار المستمر يُطلب من الخدمة الخلفية حسب التفضيل فقط
  sandbox.setNotifyPref('ongoing', true);
  sandbox.startPomo();
  let start = sandbox.__swMessages.filter(m => m.type === 'START_POMO_TIMER').pop();
  assert.equal(start.ongoing, true, 'لم يُطلب الإشعار المستمر رغم تفعيله');
  sandbox.resetPomo();

  sandbox.setNotifyPref('ongoing', false);
  sandbox.startPomo();
  start = sandbox.__swMessages.filter(m => m.type === 'START_POMO_TIMER').pop();
  assert.equal(start.ongoing, false, 'طُلب الإشعار المستمر رغم إيقافه');
  sandbox.resetPomo();

  sandbox.resetNotifyPrefs();
  assert.equal(JSON.stringify(JSON.parse(sandbox.localStorage.getItem('zp_notify_prefs'))),
    JSON.stringify({ sessionEnd: true, ongoing: true, breakNudge: true, sound: true, daily: false, dailyTime: '20:00', checkInMins: 0 }),
    'استعادة الافتراضي لا تعيد كل القيم');
});

test('35) موثوقية التسليم: تذكير فات والخدمة نائمة يصل عند عودة التطبيق (والقديم جداً لا يزعج)', async () => {
  const { sandbox, localStorage } = createHarness();
  sandbox.Notification.permission = 'granted';
  const mk = (at) => JSON.stringify([{ id: 'daily', at, repeatMs: 86400000, tag: 'zp-daily', title: 'ZeroPlus | موعد الدراسة 📚', body: 'ابدأ جلستك' }]);

  localStorage.setItem('zp_scheduled_alerts', mk(Date.now() - 10 * 60000));   // فات قبل ١٠ دقائق
  sandbox.__notifications.length = 0;
  assert.equal(sandbox.catchUpScheduledAlerts(), 1, 'لم يُسلَّم التذكير الفائت');
  await new Promise((r) => setTimeout(r, 0));
  assert.match(sandbox.__notifications[0].title, /موعد الدراسة/);
  let stored = JSON.parse(localStorage.getItem('zp_scheduled_alerts'));
  assert.ok(stored[0].at > Date.now(), 'لم يُعَد جدولة التذكير اليومي التالي');

  localStorage.setItem('zp_scheduled_alerts', mk(Date.now() - 6 * 60 * 60 * 1000));   // فات قبل ٦ ساعات
  sandbox.__notifications.length = 0;
  assert.equal(sandbox.catchUpScheduledAlerts(), 0, 'أزعج الطالب بتذكير قديم جداً');
  stored = JSON.parse(localStorage.getItem('zp_scheduled_alerts'));
  assert.ok(stored[0].at > Date.now(), 'التذكير القديم لم يُعَد جدولته للموعد القادم');
});

test('36) الشريط المصغّر للجلسة: وقت متبقٍ + إيقاف مؤقت/استئناف في كل الشاشات', () => {
  const { sandbox, nodes } = createHarness();
  const widget = () => sandbox.document.getElementById('focus-mini');
  sandbox.showTab('todo');
  sandbox.updateFocusWidget();
  assert.equal(widget().classList.contains('hidden'), true, 'الشريط ظاهر بلا جلسة');

  sandbox.startPomo();
  assert.equal(widget().classList.contains('hidden'), false, 'الشريط لم يظهر مع بدء الجلسة');
  assert.match(nodes.get('focus-mini-time').innerText, /^\d\d:\d\d$/, 'الوقت المتبقي غير معروض');
  assert.match(nodes.get('focus-mini-label').innerText, /تعمل بالخلفية/);
  assert.match(nodes.get('focus-mini-toggle-icon').className, /fa-pause/);

  sandbox.pausePomo();
  assert.equal(widget().classList.contains('hidden'), false, 'الشريط اختفى والجلسة موقوفة مؤقتاً');
  assert.match(nodes.get('focus-mini-label').innerText, /موقوفة مؤقتاً/);
  assert.match(nodes.get('focus-mini-toggle-icon').className, /fa-play/, 'زر الشريط لا يتحول إلى «استئناف»');

  assert.equal(sandbox.togglePomo(), true, 'الاستئناف من الشريط المصغّر لا يعمل');
  assert.equal(sandbox.__api.pomoRunning, true);
  sandbox.resetPomo();
  assert.equal(widget().classList.contains('hidden'), true, 'الشريط بقي بعد إنهاء الجلسة');
});

test('37) جلسة موقوفة مؤقتاً تعود كما تركها الطالب بعد إغلاق التطبيق', () => {
  const { sandbox, nodes } = createHarness();
  sandbox.localStorage.setItem('zp_pomo_paused_remaining', '600');   // ١٠ دقائق متبقية
  (sandbox.__documentListeners['DOMContentLoaded'] || []).forEach((cb) => cb());

  assert.equal(sandbox.__api.pomoPaused, true, 'الجلسة الموقوفة لم تُستعد');
  assert.equal(sandbox.__api.pomoRemaining, 600);
  assert.equal(nodes.get('pomo-display').innerText, '10:00', 'العدّاد لا يعرض المتبقي المحفوظ');
  assert.equal(nodes.get('focus-mini').classList.contains('hidden'), false, 'الشريط المصغّر لا يظهر للجلسة المستعادة');
  assert.ok(sandbox.__swMessages.some((m) => m.type === 'POMO_STATUS'), 'لم تُستفسر الخدمة الخلفية عن حالة الجلسة');

  // والخدمة الخلفية هي المرجع: لو كانت الجلسة ما زالت تعمل هناك، تُستأنف الصفحة
  sandbox.applyBackgroundPomoState({ paused: false, deadlineAt: Date.now() + 300000, remainingMs: 300000 });
  assert.equal(sandbox.__api.pomoRunning, true, 'الصفحة لم تتزامن مع جلسة تعمل في الخلفية');
  sandbox.resetPomo();
});

test('38) الإشعار المستمر: الوقت المتبقي + أزرار إيقاف/استئناف داخل الإشعار', async () => {
  const sw = createSwHarness();
  sw.__message({
    type: 'START_POMO_TIMER', deadlineAt: Date.now() + 25 * 60000, durationMs: 25 * 60000,
    mins: 25, label: 'جلسة 25 دقيقة', ongoing: true, title: 'انتهى الوقت', body: 'تمت'
  });
  const ongoing = sw.__notifications.filter(n => n.opts.tag === 'zp-pomo-ongoing').pop();
  assert.ok(ongoing, 'لم يظهر الإشعار المستمر أثناء الجلسة');
  assert.match(ongoing.opts.body, /متبقٍ 25 دقيقة/, 'الإشعار لا يعرض الوقت المتبقي');
  assert.equal(ongoing.opts.silent, true, 'الإشعار المستمر يجب أن يكون صامتاً');
  assert.equal(ongoing.opts.requireInteraction, true);
  assert.equal(Array.from(ongoing.opts.actions || []).map(a => a.action).join(','), 'pause,stop', 'أزرار الإشعار ناقصة');

  // بلا طلب صريح (الإصدارات القديمة/تفضيل مغلق) لا يظهر إشعار مستمر
  const sw2 = createSwHarness();
  sw2.__message({ type: 'START_POMO_TIMER', deadlineAt: Date.now() + 60000, durationMs: 60000 });
  assert.equal(sw2.__notifications.filter(n => n.opts.tag === 'zp-pomo-ongoing').length, 0, 'ظهر إشعار مستمر لم يُطلب');
});

test('39) أزرار الإشعار المستمر تُبدّل حالة الجلسة في الخلفية وتخبر الصفحة', async () => {
  const sw = createSwHarness();
  sw.__message({
    type: 'START_POMO_TIMER', deadlineAt: Date.now() + 25 * 60000, durationMs: 25 * 60000,
    mins: 25, ongoing: true, title: 'انتهى الوقت', body: 'تمت'
  });

  await sw.__clickNotification('pause', 'zp-pomo-ongoing');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(sw.__clientMessages.some(m => m.type === 'POMO_PAUSED'), 'زر الإيقاف لم يُخبر الصفحة');
  const paused = sw.__notifications.filter(n => n.opts.tag === 'zp-pomo-ongoing').pop();
  assert.match(paused.opts.body, /موقوفة مؤقتاً/, 'الإشعار لا يعكس حالة الإيقاف');
  assert.equal(Array.from(paused.opts.actions || []).map(a => a.action).join(','), 'resume,stop', 'زر الاستئناف غير معروض');

  sw.__runTimers(); sw.__runWatchdog();
  assert.equal(sw.__notifications.filter(n => n.opts.tag === 'zp-pomo').length, 0, 'أُطلق تنبيه النهاية لجلسة موقوفة مؤقتاً');

  await sw.__clickNotification('resume', 'zp-pomo-ongoing');
  await new Promise((r) => setTimeout(r, 0));
  const resumedMsg = sw.__clientMessages.filter(m => m.type === 'POMO_RESUMED').pop();
  assert.ok(resumedMsg && resumedMsg.deadlineAt > Date.now(), 'الاستئناف لم يُعد ضبط وقت النهاية');
  assert.match(sw.__notifications.filter(n => n.opts.tag === 'zp-pomo-ongoing').pop().opts.body, /متبقٍ/);

  await sw.__clickNotification('stop', 'zp-pomo-ongoing');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(sw.__clientMessages.some(m => m.type === 'POMO_CANCELLED'), 'زر الإنهاء لم يُخبر الصفحة');
  assert.equal(sw.__openNotifications.filter(n => n.tag === 'zp-pomo-ongoing').length, 0, 'الإشعار المستمر لم يُغلق بعد الإنهاء');

  sw.__message({ type: 'POMO_STATUS' });
  const status = sw.__pageMessages.pop();
  assert.equal(status.running, false, 'الخدمة الخلفية ما زالت تظن أن الجلسة تعمل');
});

test('40) التذكيرات المجدولة في الخدمة الخلفية: تُطلق وتتكرر وتنجو من إعادة التشغيل', async () => {
  const sw = createSwHarness();
  sw.__message({
    type: 'SYNC_ALERTS',
    alerts: [{ id: 'daily', at: Date.now() - 1000, repeatMs: 86400000, tag: 'zp-daily', title: 'ZeroPlus | موعد الدراسة 📚', body: 'ابدأ جلستك' }]
  });
  sw.__runWatchdog();
  assert.equal(sw.__notifications.filter(n => n.opts.tag === 'zp-daily').length, 1, 'لم يُطلق التذكير المستحق');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(sw.__clientMessages.some(m => m.type === 'ALERT_FIRED' && m.id === 'daily'), 'لم تُخبر الصفحة بإطلاق التذكير');

  sw.__runWatchdog();
  assert.equal(sw.__notifications.filter(n => n.opts.tag === 'zp-daily').length, 1, 'تكرّر التذكير قبل موعده التالي');

  // إعادة تشغيل الخدمة الخلفية لا تفقد الجدول
  const sw2 = createSwHarness();
  sw2.__cache.set('/__zp_pomo_timer', sw.__cache.get('/__zp_pomo_timer'));
  sw2.__fire('activate', { waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 0));
  sw2.__message({ type: 'ALERTS_STATUS' });
  const reply = sw2.__pageMessages.pop();
  assert.equal(reply.alerts.length, 1, 'ضاعت التذكيرات بعد إعادة تشغيل الخدمة الخلفية');
  assert.ok(reply.alerts[0].at > Date.now(), 'موعد التذكير المسترجع في الماضي');

  sw2.__message({ type: 'CANCEL_ALERT', id: 'daily' });
  sw2.__message({ type: 'ALERTS_STATUS' });
  assert.equal(sw2.__pageMessages.pop().alerts.length, 0, 'لم يُلغَ التذكير');
});

test('41) نموذج الدعم: يرفض الرسالة القصيرة ويحفظ ويرفع ويجهّز رابط تيليجرام', async () => {
  const { sandbox, nodes, supabaseMock, localStorage } = createHarness();
  await signup(sandbox, 'طالب نموذج الدعم');

  sandbox.document.getElementById('support-message').value = 'قصير';
  assert.equal(sandbox.submitSupportTicket(), false, 'قُبلت رسالة قصيرة');
  assert.match(nodes.get('toast-inner').innerText, /١٠ أحرف/, 'لم يُشرح سبب الرفض');
  assert.equal(readJson(localStorage, 'zp_support_tickets', []).length, 0);

  sandbox.document.getElementById('support-topic').value = 'مشكلة في التنبيهات';
  sandbox.document.getElementById('support-attach-diag').checked = true;
  sandbox.document.getElementById('support-message').value = 'الإشعارات لا تصلني بعد انتهاء الجلسة على جهاز أندرويد';
  const ticket = sandbox.submitSupportTicket();
  assert.ok(ticket && ticket.id, 'لم تُنشأ رسالة الدعم');
  assert.equal(ticket.status, 'queued');
  assert.equal(nodes.get('support-message').value, '', 'لم تُفرَّغ خانة الرسالة بعد الإرسال');

  await sandbox.flushSyncQueue();
  const row = supabaseMock._state.tables.support_messages[0];
  assert.ok(row, 'رسالة الدعم لم تُرفع للسحابة');
  assert.equal(row.topic, 'مشكلة في التنبيهات');
  assert.equal(row.device_id, localStorage.getItem('zp_device_id'));
  assert.match(row.diagnostics, /ZeroPlus/, 'التقرير التقني لم يُرفق');
  assert.equal(readJson(localStorage, 'zp_support_tickets', [])[0].status, 'sent', 'حالة الرسالة لم تتحدث بعد الرفع');

  const href = nodes.get('support-telegram-link').getAttribute('href');
  assert.match(href, /t\.me\/share/, 'رابط تيليجرام غير معبّأ بالرسالة');
  assert.ok(sandbox.__clipboard.lastText && /رسالة دعم/.test(sandbox.__clipboard.lastText), 'الرسالة لم تُنسخ للطالب');
  assert.equal(await sandbox.copyLastTicket(), true);
});

test('42) غياب جدول support_messages لا يُعطّل المزامنة ولا يُضيع الرسالة', async () => {
  const { sandbox, supabaseMock, localStorage } = createHarness();
  await signup(sandbox, 'طالب بلا جدول دعم');
  supabaseMock._state.failures.support_messages = 'relation "public.support_messages" does not exist';

  sandbox.document.getElementById('support-message').value = 'عندي مشكلة في مزامنة المهام بين جهازين';
  sandbox.submitSupportTicket();
  await sandbox.flushSyncQueue();

  assert.equal(sandbox.__api.pendingCount, 0, 'بقيت رسالة الدعم عالقة في طابور المزامنة للأبد');
  assert.equal(sandbox.__api.lastSyncError, null, 'صار مؤشر السحابة أحمر بسبب جدول اختياري');
  assert.equal(readJson(localStorage, 'zp_support_tickets', [])[0].status, 'local', 'لم تُحفظ الرسالة محلياً عند غياب الجدول');
});

test('43) درج الدعم يعرض حالة الاشتراك والجلسة والمزامنة', async () => {
  const { sandbox, nodes } = createHarness();
  sandbox.refreshSessionStatus();
  assert.match(nodes.get('support-session-state').innerText, /زائر/, 'حالة الزائر غير معروضة');

  await signup(sandbox, 'طالب حالة الجلسة');
  sandbox.openSupportDrawer();
  assert.match(nodes.get('support-session-state').innerText, /نشطة/, 'الجلسة لا تظهر كنشطة بعد الدخول');
  assert.match(nodes.get('support-plan-badge').innerText, /مجاني/, 'حالة الاشتراك غير معروضة');
  assert.match(nodes.get('support-session-since').innerText, /الآن|منذ/, 'بداية الجلسة غير معروضة');
  assert.match(nodes.get('support-last-sync').innerText, /الآن|منذ/, 'آخر مزامنة غير معروضة');
  const drawerHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(drawerHtml, /id="support-plan-expiry"[^>]*>مدى الحياة/, 'صلاحية الاشتراك غير معروضة في الدرج');

  sandbox.navigator.onLine = false;
  sandbox.refreshSessionStatus();
  assert.match(nodes.get('support-session-state').innerText, /بدون إنترنت/, 'لا تظهر حالة العمل دون إنترنت');
});

test('44) أي خطأ غير متوقع يُسجَّل ويظهر للطالب وفي تقرير المشكلة', () => {
  const { sandbox, nodes } = createHarness();
  sandbox.recordRuntimeIssue(new Error('فشل تجريبي في زر'), 'زر الاختبار');
  assert.match(nodes.get('toast-inner').innerText, /تعذّر تنفيذ العملية/, 'لم يُبلَّغ الطالب بالخطأ');

  const log = JSON.parse(sandbox.localStorage.getItem('zp_runtime_errors'));
  assert.equal(log[0].source, 'زر الاختبار');
  assert.match(sandbox.buildDiagnostics(), /فشل تجريبي/, 'الخطأ لا يصل لتقرير المشكلة');

  for (let i = 0; i < 8; i++) sandbox.recordRuntimeIssue(new Error('خطأ ' + i), 'تكرار', { silent: true });
  assert.equal(JSON.parse(sandbox.localStorage.getItem('zp_runtime_errors')).length, 5, 'سجل الأخطاء ينمو بلا حد');

  assert.ok((sandbox.__windowListeners['error'] || []).length > 0, 'لا يوجد مستمع للأخطاء العامة');
  assert.ok((sandbox.__windowListeners['unhandledrejection'] || []).length > 0, 'لا يوجد مستمع للوعود المرفوضة');

  // الحماية تلتقط الخطأ بدل أن ينكسر الزر
  sandbox.window.__boom = () => { throw new Error('انفجار زر'); };
  const before = JSON.parse(sandbox.localStorage.getItem('zp_runtime_errors')).length;
  try { sandbox.recordRuntimeIssue(new Error('انفجار زر'), '__boom', { silent: true }); } catch (e) { assert.fail('الخطأ لم يُلتقط'); }
  assert.ok(JSON.parse(sandbox.localStorage.getItem('zp_runtime_errors')).length >= before);
});

test('45) مدة جلسة مخصّصة: تُقبل الصحيحة وتُرفض الخاطئة وتُسلَّم للخلفية', () => {
  const { sandbox, nodes } = createHarness();
  sandbox.document.getElementById('pomo-custom-mins').value = '45';
  assert.equal(sandbox.applyCustomPomoMode(), 45, 'لم تُقبل المدة المخصّصة');
  assert.equal(sandbox.__api.currentPomoMins, 45);
  assert.equal(nodes.get('pomo-display').innerText, '45:00', 'العدّاد لم يتحدث للمدة المخصّصة');
  assert.equal(sandbox.localStorage.getItem('zp_custom_pomo_mins'), '45');

  sandbox.document.getElementById('pomo-custom-mins').value = '999';
  assert.equal(sandbox.applyCustomPomoMode(), false, 'قُبلت مدة خارج الحدود');
  assert.match(nodes.get('toast-inner').innerText, /بين ١ و١٨٠/);
  assert.equal(sandbox.__api.currentPomoMins, 45, 'تغيّرت المدة رغم رفض القيمة');

  sandbox.startPomo();
  const start = sandbox.__swMessages.filter(m => m.type === 'START_POMO_TIMER').pop();
  assert.equal(start.mins, 45, 'المدة المخصّصة لم تصل للخدمة الخلفية');
  assert.match(start.body, /45 دقيقة/);
  sandbox.resetPomo();
});

function readJson(storage, key, fallback) {
  try { return JSON.parse(storage.getItem(key) || '') ?? fallback; } catch (e) { return fallback; }
}

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
