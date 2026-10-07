// اختبارات منطق المزامنة: تشغيل سكربت index.html داخل DOM وهمي + Supabase وهمي
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHarness, clearHarnessTimers, ROOT } from './harness.mjs';
import { TABLE_COLUMNS } from './mock-supabase.mjs';
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
  assert.match(nodes.get('notify-icon').className, /ds-tone-success/, 'أيقونة التنبيهات لا تلبس لون النجاح من لوحة القسم');
  assert.ok(!nodes.get('notify-reminder-banner').classList.contains('ds-state-danger'), 'شريط التذكير ما زال بحالة الخطر بعد التفعيل');

  sandbox.Notification.permission = 'denied';
  sandbox.checkNotificationBanner();
  assert.equal(bannerHidden(), false, 'لا يوجد تنبيه عند حجب الإشعارات');
  assert.equal(nodes.get('notify-reminder-banner').classList.contains('ds-state-danger'), true, 'شريط الحجب لا يلبس حالة الخطر من لوحة القسم');
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
  ['home', 'todo', 'pomodoro', 'zero'].forEach((t) => sandbox.showTab(t));
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
  assert.equal(sandbox.tabFromHash(), null, 'قسم البناء اللغوي أُلغي — اختصاره يجب ألا يفتح تبويباً');
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

// ============================================================================
// v34: غابة الإنجاز (Supabase) + نظام التصميم الموحّد (v36: أُلغي احتفال اليوم الوطني وقسم البناء اللغوي)
// ============================================================================
test('46) إنهاء جلسة يزرع شجرة مختلفة ويحفظها فعلاً في جدول trees في Supabase', async () => {
  const { sandbox, supabaseMock, localStorage } = createHarness();
  await signup(sandbox, 'طالب الغابة');
  const deviceId = localStorage.getItem('zp_device_id');
  sandbox.__api.totalFocusMins = 0;

  sandbox.finishPomoSession();          // جلسة 25 دقيقة → شجرة
  await sandbox.flushSyncQueue();

  const trees = rowsOf(supabaseMock, 'trees');
  assert.equal(trees.length, 1, 'لم تُكتب الشجرة في جدول trees');
  const tree = trees[0];
  assert.equal(tree.user_id, deviceId, 'user_id غير مربوط بجهاز الطالب');
  assert.equal(tree.duration, 25, 'مدة الشجرة غير صحيحة');
  assert.ok(tree.tree_type, 'نوع الشجرة مفقود');
  assert.ok(tree.planted_at, 'وقت الزراعة مفقود');
  assert.ok(tree.created_at, 'تاريخ الإنشاء مفقود');
  assert.equal(sandbox.__api.userTrees.length, 1, 'الشجرة غير مسجّلة محلياً');
  assert.equal(sandbox.__api.userTrees[0].sync, 'synced', 'الشجرة لم تُعلَّم كمحفوظة سحابياً');
});

test('47) الأشجار المختلفة: كل جلسة تزرع نوعاً مختلفاً + النُدرة ترتفع مع طول الجلسة', async () => {
  const { sandbox, supabaseMock } = createHarness();
  await signup(sandbox, 'طالب أنواع');
  const types = [];
  for (let i = 0; i < 6; i++) {
    sandbox.__api.pomoRemaining = 0;
    sandbox.finishPomoSession();
    await sandbox.flushSyncQueue();
    types.push(sandbox.__api.userTrees[0].tree_type);
  }
  assert.equal(types.length, 6);
  assert.ok(new Set(types).size >= 3, 'الأنواع متكرّرة جداً — يجب أن تختلف الأشجار: ' + types.join(', '));
  for (let i = 1; i < types.length; i++) {
    assert.notEqual(types[i], types[i - 1], 'زرعت شجرتان متتاليتان من نفس النوع: ' + types[i]);
  }
  const rows = rowsOf(supabaseMock, 'trees');
  assert.equal(rows.length, 6, 'عدد الأشجار المحفوظة في Supabase غير مطابق');
});

test('48) تسجيل الدخول يجلب الغابة من Supabase (جدول trees) ويعرضها بالعدد الصحيح', async () => {
  const { sandbox, supabaseMock, localStorage, nodes } = createHarness();
  const name = 'طالب الجلب';
  const deviceId = 'u_' + sandbox.simpleHash(name.toLowerCase().trim());
  // غابة محفوظة مسبقاً في "السحابة"
  supabaseMock._state.tables.profiles.push({
    id: 'p9', device_id: deviceId, user_name: name, department: 'general', xp: 300, total_focus_mins: 90,
    password_hash: await sandbox.hashPassword('1234'), auth_provider: 'local'
  });
  supabaseMock._state.tables.trees = supabaseMock._state.tables.trees || [];
  supabaseMock._state.tables.trees.push(
    { id: 111, user_id: deviceId, tree_type: 'pine', duration: 25, planted_at: '2026-09-30T10:00:00.000Z', created_at: '2026-09-30T10:00:00.000Z' },
    { id: 112, user_id: deviceId, tree_type: 'palm', duration: 50, planted_at: '2026-10-01T11:30:00.000Z', created_at: '2026-10-01T11:30:00.000Z' }
  );
  localStorage.clear();

  sandbox.toggleAuthMode();
  sandbox.document.getElementById('auth-username').value = name;
  sandbox.document.getElementById('auth-password').value = '1234';
  await sandbox.handleUserAuthentication();
  await sandbox.loadForestFromCloud(true);

  assert.equal(localStorage.getItem('zp_device_id'), deviceId);
  assert.equal(sandbox.__api.userTrees.length, 2, 'لم تُجلب الأشجار من Supabase');
  assert.deepEqual(sandbox.__api.userTrees.map(t => t.tree_type).sort(), ['palm', 'pine']);
  assert.equal(sandbox.__api.forestState, 'ready');
  assert.equal(nodes.get('forest-count-chip').innerText, '2 شجرة', 'عدّاد الغابة لا يعرض عدد الأشجار المجلوبة');
  assert.match(nodes.get('forest-grid').innerHTML, /نخلة|صنوبر/, 'سجل الأشجار لا يعرض الأنواع المجلوبة');
  assert.equal(nodes.get('home-stat-sessions').innerText, '2');
});

test('49) غياب جدول trees لا يُعطّل التطبيق: حفظ محلي + رسالة واضحة + رفع تلقائي بعد التهيئة', async () => {
  const { sandbox, supabaseMock, localStorage, nodes } = createHarness();
  await signup(sandbox, 'طالب بلا جدول');
  const deviceId = localStorage.getItem('zp_device_id');
  // نحاكي مشروع Supabase بلا جدول trees (كما هو الحال قبل تشغيل schema.sql)
  supabaseMock._state.failures.trees = 'relation "public.trees" does not exist';

  sandbox.finishPomoSession();
  await sandbox.flushSyncQueue();

  assert.equal(sandbox.__api.treesTableMissing, true, 'لم يُكتشف غياب جدول trees');
  assert.equal(sandbox.__api.userTrees.length, 1, 'ضاعت الشجرة عند غياب الجدول');
  assert.equal(sandbox.__api.userTrees[0].sync, 'local', 'حالة الحفظ المحلي غير صحيحة');
  assert.match(nodes.get('forest-sync-text').innerText, /غير مُهيّأ/, 'لا توجد رسالة واضحة عن تهيئة الجدول');
  const setupBtn = nodes.get('forest-setup-btn');
  assert.equal(setupBtn.classList.contains('hidden'), false, 'زر التهيئة لا يظهر عند غياب الجدول');

  // بعد التهيئة (إنشاء الجدول) يُعاد رفع الأشجار المعلّقة تلقائياً
  delete supabaseMock._state.failures.trees;
  supabaseMock._state.tables.trees = [];
  await sandbox.loadForestFromCloud(true);
  await sandbox.flushSyncQueue();
  assert.equal(rowsOf(supabaseMock, 'trees').length, 1, 'لم تُرفع الأشجار المحلية بعد تهيئة الجدول');
});

test('50) مسح السجل يحذف الأشجار من الجهاز ومن Supabase (trees)', async () => {
  const { sandbox, supabaseMock, localStorage } = createHarness();
  await signup(sandbox, 'طالب المسح');
  sandbox.finishPomoSession();
  await sandbox.flushSyncQueue();
  assert.equal(rowsOf(supabaseMock, 'trees').length, 1);

  sandbox.__setConfirm(true);
  sandbox.clearForestConfirmation();
  await sandbox.flushSyncQueue();

  assert.equal(sandbox.__api.userTrees.length, 0, 'لم تُمسح الأشجار محلياً');
  assert.equal(rowsOf(supabaseMock, 'trees').length, 0, 'لم تُحذف الأشجار من Supabase');
});

test('51) إلغاء قسم البناء اللغوي واحتفال اليوم الوطني: لا أثر لهما في الواجهة أو المنطق أو الاختصارات', () => {
  const { sandbox, nodes } = createHarness();
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const manifest = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
  // 1) قسم البناء اللغوي محذوف بالكامل: لا تبويب ولا زر تنقّل ولا بطاقة ولا اختصار
  assert.ok(!/tab-english|nav-english|'english'/.test(html), 'بقي أثر لقسم البناء اللغوي في index.html');
  assert.ok(!/البناء اللغوي/.test(html), 'بقي نص «البناء اللغوي» في الواجهة');
  assert.ok(!/tab-english|البناء اللغوي/.test(manifest), 'بقي اختصار البناء اللغوي في manifest.json');
  sandbox.showTab('english');
  assert.equal(sandbox.__api.activeTabId, 'home', 'تبويب english الملغى يجب أن يرجع للرئيسية');
  assert.equal(nodes.get('tab-home').classList.contains('hidden'), false);
  // 2) احتفال اليوم الوطني محذوف: لا بطاقة ولا علم ولا دوال
  assert.ok(!/national-day-card|iq-flag|iqFlagArt|National Day|اليوم الوطني/.test(html), 'بقي أثر لاحتفال اليوم الوطني');
  assert.equal(typeof sandbox.celebrateNationalDay, 'undefined', 'دالة الاحتفال ما زالت موجودة');
  assert.equal(typeof sandbox.initNationalFlag, 'undefined', 'دالة العلم ما زالت موجودة');
  // 3) شريط التنقّل السفلي بأربعة تبويبات
  const nav = html.slice(html.indexOf('id="app-bottom-nav"'), html.indexOf('</nav>', html.indexOf('id="app-bottom-nav"')));
  assert.equal((nav.match(/onclick="navigateToTab\(/g) || []).length, 4, 'شريط التنقّل يجب أن يحوي أربعة تبويبات');
});

test('52) نظام التصميم: قسم التركيز بنطاق أخضر وحده، وبقية الشاشات كحلية موحّدة', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // قسم التركيز يحمل نطاق اللون الأخضر
  const pomoTag = html.slice(html.indexOf('<section id="tab-pomodoro"'), html.indexOf('<section id="tab-pomodoro"') + 120);
  assert.match(pomoTag, /data-ds="focus"/, 'قسم التركيز لا يحمل data-ds="focus"');
  // نطاق أخضر معرّف مرة واحدة في الـ CSS
  assert.match(html, /\[data-ds="focus"\]\s*\{/, 'نطاق focus غير معرّف في نظام التصميم');
  // ولا يوجد نطاق أخضر على أي قسم آخر
  const otherTabs = ['home', 'todo', 'achievements', 'zero'];
  otherTabs.forEach(t => {
    const i = html.indexOf('<section id="tab-' + t + '"');
    assert.ok(i > 0, 'قسم مفقود: ' + t);
    assert.ok(!/data-ds="focus"/.test(html.slice(i, i + 140)), 'قسم ' + t + ' يحمل نطاق التركيز الأخضر');
  });
  // ألوان النظام القديمة أُزيلت من الواجهة
  assert.ok(!/theme-sky|theme-mint\b/.test(html.replace(/--ds-[a-z-]+/g, '')), 'بقيت ألوان قديمة في الواجهة');
  // المكوّنات الموحّدة معرّفة في نظام التصميم
  ['ds-card', 'ds-tile', 'ds-btn-primary', 'ds-chip', 'ds-icon-tile', 'ds-fab'].forEach(c => {
    assert.ok(html.includes('.' + c), 'المكوّن ' + c + ' غير معرّف في نظام التصميم');
  });
  // التبويبات الأربعة في الشريط السفلي (أُلغي قسم البناء اللغوي)
  assert.equal((html.match(/id="nav-/g) || []).length, 4, 'عدد تبويبات الشريط السفلي ليس ٤');
  // الخطوط: خط حديث
  assert.match(html, /Cairo/, 'الخط الحديث (Cairo) مفقود');
});

test('53) الإنجازات تُحسب من بيانات حقيقية (XP + الأشجار + المهام)', async () => {
  const { sandbox, nodes } = createHarness();
  await signup(sandbox, 'طالب الإنجازات');
  sandbox.__api.tasks = [
    { id: 1, title: 'أ', done: true, tag: '', prio: 'normal' },
    { id: 2, title: 'ب', done: false, tag: '', prio: 'normal' }
  ];
  sandbox.finishPomoSession();
  await sandbox.flushSyncQueue();
  sandbox.__api.userXP = 520;          // بعد مكافأة الجلسة (+30 XP)
  const data = sandbox.renderAchievements();

  assert.equal(data.level, Math.floor(520 / 250) + 1, 'حساب المستوى غير صحيح');
  assert.equal(nodes.get('ach-level').innerText, String(data.level));
  assert.equal(nodes.get('ach-stat-xp').innerText, '520');
  assert.equal(nodes.get('ach-stat-trees').innerText, '1');
  assert.equal(nodes.get('ach-stat-tasks').innerText, '1');
  assert.match(nodes.get('ach-badges-count').innerText, /\/ \d+/, 'عدّاد الأوسمة لا يظهر');
  assert.match(nodes.get('ach-week-chart').innerHTML, /bg-\[var\(--ds-primary\)\]/, 'مخطط الأسبوع لا يُرسم');
});

test('55) اختبار الحفظ الفعلي: الكتابة في trees ثم القراءة ثم الحذف (إثبات أن الحفظ حقيقي)', async () => {
  const { sandbox, supabaseMock, nodes, localStorage } = createHarness();
  await signup(sandbox, 'طالب الاختبار');
  const deviceId = localStorage.getItem('zp_device_id');
  supabaseMock._state.tables.trees = [];

  const ok = await sandbox.testTreesStorage();
  assert.equal(ok, true, 'اختبار الحفظ رجع بالفشل');
  assert.equal(rowsOf(supabaseMock, 'trees').length, 0, 'الصف التجريبي لم يُحذف بعد الاختبار');
  const calls = supabaseMock._state.calls.filter(c => c.table === 'trees').map(c => c.op);
  assert.deepEqual(calls.slice(0, 3), ['upsert', 'select', 'delete'], 'مسار الاختبار غير مطابق: ' + calls.join(','));
  assert.match(nodes.get('tree-test-result').innerText, /نجح الاختبار/, 'لا تظهر نتيجة نجاح واضحة للطالب');
});

test('56) فشل جدول trees أثناء اختبار الحفظ يعرض خطأً واضحاً ولا يكسر التطبيق', async () => {
  const { sandbox, supabaseMock, nodes } = createHarness();
  await signup(sandbox, 'طالب خطأ');
  supabaseMock._state.failures.trees = 'relation "public.trees" does not exist';

  const ok = await sandbox.testTreesStorage();
  assert.equal(ok, false);
  assert.equal(sandbox.__api.treesTableMissing, true, 'لم تُسجَّل حالة غياب الجدول');
  assert.match(nodes.get('tree-test-result').innerText, /schema\.sql|غير/, 'رسالة الخطأ غير مفيدة للطالب');
});

test('54) فحص ثابت: جدول trees مكتمل في schema.sql (أعمدة + صلاحيات + سياسات + فهرس)', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.trees/i, 'جدول trees غير معرّف في schema.sql');
  const section = sql.slice(sql.indexOf('public.trees'), sql.indexOf('6) الفهارس'));
  for (const col of ['id', 'user_id', 'tree_type', 'duration', 'planted_at', 'created_at']) {
    assert.match(section, new RegExp('\\b' + col + '\\b'), 'العمود ' + col + ' مفقود من جدول trees');
  }
  assert.match(section, /PRIMARY KEY \(user_id, id\)/, 'المفتاح المركّب (user_id,id) مفقود');
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON TABLE public\.trees\s+TO anon, authenticated, service_role;/, 'صلاحيات trees مفقودة');
  assert.match(sql, /ALTER TABLE public\.trees\s+ENABLE ROW LEVEL SECURITY;/, 'RLS غير مفعّل على trees');
  assert.match(sql, /CREATE POLICY "zp_anon_all_trees"/, 'سياسة anon لجدول trees مفقودة');
  assert.match(sql, /CREATE POLICY "zp_auth_all_trees"/, 'سياسة authenticated لجدول trees مفقودة');
  assert.match(sql, /idx_trees_user_planted/, 'فهرس trees مفقود');
  // ويجب أن يطابق أعمدة النسخة الوهمية المستخدمة في الاختبارات
  const mockCols = ['id', 'user_id', 'tree_type', 'duration', 'planted_at', 'created_at'];
  for (const col of mockCols) assert.ok(TABLE_COLUMNS.trees.includes(col), 'عمود مفقود من mock-supabase: ' + col);
});

// ============================================================================
// v35 — لوحة الألوان لكل قسم + الرجوع الموحّد + الاستجابة للأجهزة
// ============================================================================

test('57) لوحة الألوان: التركيز أخضر/أبيض فقط على مستوى التطبيق كله، وبقية الأقسام بالنطاق الافتراضي', () => {
  const { sandbox } = createHarness();
  // نطاق التركيز يُطبَّق على <body> فترثه الترويسة وشريط التنقّل والزر العائم وشريط الجلسة
  sandbox.showTab('pomodoro');
  assert.equal(sandbox.document.body.getAttribute('data-ds'), 'focus', 'قسم التركيز لا يضع النطاق الأخضر على body');
  assert.equal(sandbox.currentSectionScope(), 'focus', 'النطاق الحالي ليس التركيز');
  // وكل قسم آخر يرجع للنطاق الافتراضي (الأساسي الكحلي) فوراً
  for (const tab of ['home', 'todo', 'achievements', 'zero']) {
    sandbox.showTab(tab);
    assert.equal(sandbox.document.body.getAttribute('data-ds'), 'default', 'قسم ' + tab + ' لم يرجع للنطاق الافتراضي');
  }
  sandbox.showTab('pomodoro');
  sandbox.showTab('home');
  assert.equal(sandbox.document.body.getAttribute('data-ds'), 'default', 'الرئيسية يجب أن تبقى على النطاق الافتراضي');
  // لون شريط النظام يتبع القسم: أخضر في التركيز، والأساسي في غيره
  assert.equal(sandbox.themeColorFor('focus', false), '#0f6b4a');
  assert.equal(sandbox.themeColorFor('default', false), '#16305c');
  assert.notEqual(sandbox.themeColorFor('focus', false), sandbox.themeColorFor('default', false), 'لون التركيز لا يختلف عن الافتراضي');

  // فحص ثابت للـ CSS: نطاقان معرّفان، والنطاق الأخضر محدود، ولا لون أساسي افتراضي داخله
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /:root, \[data-ds="default"\]\s*\{/, 'نطاق الألوان الافتراضي غير معرّف بـ [data-ds="default"]');
  assert.match(html, /\.dark, \.dark \[data-ds="default"\]\s*\{/, 'النطاق الافتراضي لا يعرّف الوضع الداكن');
  assert.match(html, /\[data-ds="focus"\]\s*\{/, 'نطاق التركيز غير معرّف');
  assert.match(html, /\.dark \[data-ds="focus"\]\s*\{/, 'وضع داكن أخضر غير معرّف');
  const focusBlocks = html.match(/\[data-ds="focus"\]\s*\{[\s\S]*?\n        \}/g) || [];
  assert.ok(focusBlocks.length >= 1, 'لم يُعثر على كتلة نطاق التركيز');
  assert.ok(!/#16305c|#0284c7|#3f6fb5/.test(focusBlocks.join('\n')), 'لون أساسي افتراضي داخل نطاق التركيز الأخضر');
  // النوافذ والأدراج العامة تبقى على النطاق الافتراضي حتى لو فُتحت من قسم التركيز
  ['profile-modal', 'install-modal', 'share-modal', 'support-drawer', 'landing-view'].forEach((id) => {
    const i = html.indexOf('id="' + id + '"');
    assert.ok(i > 0, 'عنصر مفقود: ' + id);
    assert.match(html.slice(i, i + 400), /data-ds="default"/, 'العنصر ' + id + ' لا يحمل النطاق الافتراضي');
  });
  // ولا شيء داخل قسم التركيز يستعمل لوناً خارج الأخضر/الأبيض
  const pomo = html.slice(html.indexOf('<section id="tab-pomodoro"'), html.indexOf('<section id="tab-zero"'));
  assert.ok(!/(rose|sky|amber|violet|slate)-[0-9]/.test(pomo), 'لون خارج لوحة القسم داخل قسم التركيز');
});

test('58) زر الرجوع: موجود في الترويسة وفي كل نافذة/درج، ويظهر في كل الأقسام ويختفي في الرئيسية', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const buttons = html.match(/class="ds-back-btn[^"]*"/g) || [];
  assert.ok(buttons.length >= 6, 'عدد أزرار الرجوع قليل: ' + buttons.length);
  // كل زر رجوع له تسمية لقارئ الشاشة وليس مخفياً عن المفاتيح
  const tags = html.match(/<button[^>]*ds-back-btn[^>]*>/g) || [];
  tags.forEach((tag) => {
    assert.match(tag, /aria-label="/, 'زر رجوع بلا aria-label: ' + tag.slice(0, 80));
    assert.ok(!/tabindex="-1"/.test(tag), 'زر رجوع غير قابل للوصول بلوحة المفاتيح');
  });
  // الترويسة العامّة + ترويسات النوافذ
  assert.match(html, /id="app-back-btn"[^>]*onclick="navigateBack\(\)"/, 'زر الرجوع العام غير مربوط بـ navigateBack');
  ['profile-modal', 'install-modal', 'share-modal', 'tree-setup-modal', 'support-drawer'].forEach((id) => {
    const i = html.indexOf('id="' + id + '"');
    const block = html.slice(i, i + 1400);
    assert.match(block, /onclick="navigateBack\(\)"/, 'نافذة/درج بلا زر رجوع: ' + id);
  });

  const { sandbox, nodes } = createHarness();
  const backHidden = () => nodes.get('app-back-btn').classList.contains('hidden');
  sandbox.showTab('home');
  assert.equal(backHidden(), true, 'زر الرجوع ظاهر في الشاشة الرئيسية');
  for (const tab of ['todo', 'pomodoro', 'achievements', 'zero']) {
    sandbox.showTab(tab);
    assert.equal(backHidden(), false, 'زر الرجوع مخفي في قسم ' + tab);
  }
  sandbox.showTab('home');
  assert.equal(backHidden(), true, 'زر الرجوع لم يختفِ بعد الرجوع للرئيسية');
});

test('59) الرجوع بلا سجل متصفح: يغلق الطبقة المفتوحة أولاً ثم يعود للشاشة الرئيسية', () => {
  const { sandbox, nodes } = createHarness();
  sandbox.showTab('pomodoro');
  sandbox.openProfileModal();
  assert.equal(nodes.get('profile-modal').classList.contains('hidden'), false, 'نافذة الملف لم تُفتح');
  sandbox.navigateBack();
  assert.equal(nodes.get('profile-modal').classList.contains('hidden'), true, 'الرجوع لم يُغلق نافذة الملف الشخصي');
  assert.equal(sandbox.__api.activeTabId, 'pomodoro', 'الرجوع أغلق النافذة وغيّر القسم أيضاً');
  sandbox.navigateBack();
  assert.equal(sandbox.__api.activeTabId, 'home', 'الرجوع من قسم لم يعد للشاشة الرئيسية');

  // درج الدعم يُغلق بنفس الزر
  sandbox.showTab('achievements');
  sandbox.openSupportDrawer();
  assert.equal(nodes.get('support-drawer').classList.contains('translate-x-full'), false, 'درج الدعم لم يُفتح');
  sandbox.navigateBack();
  assert.equal(nodes.get('support-drawer').classList.contains('translate-x-full'), true, 'الرجوع لم يُغلق درج الدعم');
  assert.equal(sandbox.__api.activeTabId, 'achievements', 'الرجوع أغلق الدرج وغيّر القسم أيضاً');
});

test('60) الرجوع الأصلي (سجل المتصفح): كل تنقّل يدفع حالة، ورجع النظام/الإيماءة يُطبّقها', async () => {
  const tick = () => new Promise((r) => setTimeout(r, 10));
  const { sandbox, nodes, historyMock } = createHarness({ withHistory: true, boot: true });
  const scope = () => sandbox.document.body.getAttribute('data-ds');
  // عند الإقلاع تُثبَّت حالة البداية في السجل
  assert.equal(sandbox.__api.activeTabId, 'home', 'التطبيق لم يبدأ من الشاشة الرئيسية');
  assert.equal(historyMock.length, 1, 'حالة البداية لم تُثبَّت في سجل المتصفح');

  // تنقّل للأمام يدفع حالة، والنطاق الأخضر يُطبَّق على التطبيق كله
  sandbox.navigateToTab('pomodoro');
  assert.equal(historyMock.length, 2, 'التنقل لم يدفع حالة في السجل');
  assert.equal(sandbox.__api.activeTabId, 'pomodoro');
  assert.equal(scope(), 'focus', 'قسم التركيز لم يفعّل النطاق الأخضر');

  // رجوع أصلي (زر أندرويد / إيماءة iOS): يُطبَّق بدون أي تدخّل من واجهتنا
  historyMock.back();
  await tick();
  assert.equal(sandbox.__api.activeTabId, 'home', 'الرجوع الأصلي لم يُعد للشاشة الرئيسية');
  assert.equal(scope(), 'default', 'نطاق اللون لم يتزامن مع الرجوع');

  // نافذة مفتوحة: الرجوع الأصلي يغلقها ويعود لنفس القسم
  sandbox.navigateToTab('achievements');
  sandbox.openShareModal();
  assert.equal(nodes.get('share-modal').classList.contains('hidden'), false, 'نافذة المشاركة لم تُفتح');
  historyMock.back();
  await tick();
  assert.equal(nodes.get('share-modal').classList.contains('hidden'), true, 'الرجوع الأصلي لم يُغلق النافذة');
  assert.equal(sandbox.__api.activeTabId, 'achievements', 'الرجوع الأصلي غيّر القسم بدل إغلاق النافذة');

  // الإغلاق اليدوي يزامن السجل حتى لا تبقى مدخلة رجوع ميّتة
  sandbox.openShareModal();
  sandbox.closeShareModal();
  await tick();
  assert.equal(JSON.stringify(historyMock.state), JSON.stringify({ zp: { tab: 'achievements' } }), 'الإغلاق اليدوي لم يزامن السجل');
  historyMock.back();
  await tick();
  assert.equal(sandbox.__api.activeTabId, 'home', 'بعد الإغلاق اليدوي صار الرجوع يقفز فوق قسم كامل');

  // زر الرجوع في الواجهة يستخدم السجل نفسه
  sandbox.navigateToTab('todo');
  sandbox.navigateBack();
  await tick();
  assert.equal(sandbox.__api.activeTabId, 'home', 'زر الرجوع لم يستخدم سجل المتصفح');
});

test('61) الاستجابة للأجهزة: الحواف الآمنة + منع تكبير iOS + حاويات مقيّدة + أهداف لمس 44px', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  // 1) الحواف الآمنة: أعلى/أسفل/يمين/يسار (Notch + شريط الإيماءات) مع value بديل للمتصفحات القديمة
  ['top', 'bottom', 'left', 'right'].forEach((side) => {
    assert.ok(css.includes('env(safe-area-inset-' + side + ')'), 'الحافة الآمنة ' + side + ' غير مدعومة');
  });
  assert.match(html, /viewport-fit=cover/, 'viewport-fit=cover مفقود — بدونه لا تعمل الحواف الآمنة على iOS');
  assert.match(css, /#app-header\s*\{[^}]*env\(safe-area-inset-top\)/, 'الترويسة لا تحترم الحافة العليا');
  assert.match(css, /#app-bottom-nav\s*\{[^}]*env\(safe-area-inset-(left|right)/, 'شريط التنقّل لا يحترم الحواف الجانبية');
  assert.match(css, /\.ios-nav-safe\s*\{[^}]*env\(safe-area-inset-bottom\)/, 'شريط التنقّل لا يحترم شريط الإيماءات');
  assert.match(css, /#support-drawer\s*\{[^}]*100dvh/, 'درج الدعم لا يحترم ارتفاع الشاشة المرئي (dvh)');
  // 2) منع تكبير iOS عند الكتابة: حقول الإدخال ≥ 16px على الأجهزة اللمسية
  assert.match(css, /@media[^{]*\(pointer: coarse\)[^{]*\{[\s\S]{0,240}font-size: 16px/, 'قاعدة منع التكبير على الأجهزة اللمسية مفقودة');
  assert.match(css, /input:not\(\[type="checkbox"\]\)/, 'قاعدة حقول الإدخال غير محدّدة بدقة');
  // 3) حاويات مقيّدة ومتوسّطة بدل التمدّد على الأجهزة اللوحية
  assert.match(css, /\.ds-shell\s*\{[^}]*max-width:\s*var\(--app-max-w\)[^}]*margin-left:\s*auto/, 'حاوية التخطيط المقيّدة مفقودة');
  assert.match(css, /@media \(min-width: 1024px\)\s*\{\s*:root\s*\{\s*--app-max-w/, 'لا يوجد حدّ عرض للأجهزة اللوحية بالعرض الأفقي');
  assert.ok((html.match(/ds-shell/g) || []).length >= 4, 'الحاوية المقيّدة غير مطبَّقة على الترويسة/المحتوى/الشريط');
  // 4) أهداف اللمس: 44×44 لزر الرجوع، و44 ارتفاعاً لأزرار الترويسة وشريط التنقّل
  assert.match(css, /\.ds-back-btn\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s, 'زر الرجوع أصغر من 44×44');
  assert.match(css, /#app-header button[^{]*\{[^}]*min-height:\s*44px/, 'أزرار الترويسة أصغر من 44px');
  assert.match(css, /#app-bottom-nav button[^{]*\{[^}]*min-height:\s*44px/, 'أزرار شريط التنقّل أصغر من 44px');
  assert.match(css, /touch-action:\s*manipulation/, 'لم تُضبط استجابة اللمس (touch-action)');
  // 5) الأجهزة اللوحية: الوضع الأفقي مسموح في manifest
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.orientation, 'any', 'manifest يمنع الوضع الأفقي على الأجهزة اللوحية');
});

// ---------- v37: جاهزية PWA / iOS / أندرويد ----------
function pngDims(file) {
  const d = fs.readFileSync(file);
  assert.ok(d.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), file + ' ليس PNG صالحاً');
  return [d.readUInt32BE(16), d.readUInt32BE(20)];
}

test('62) manifest إنتاجي كامل: id + أيقونات maskable وأيْ + حقول إلزامية', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  for (const f of ['id', 'name', 'short_name', 'description', 'start_url', 'scope', 'display', 'theme_color', 'background_color']) {
    assert.ok(manifest[f], 'حقل ناقص في manifest: ' + f);
  }
  assert.equal(manifest.display, 'standalone', 'display يجب أن يكون standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 4, 'أيقونات غير كافية');
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'لا توجد أيقونة maskable (مطلوبة لأندرويد/TWA)');
  assert.ok(manifest.icons.some((i) => i.purpose === 'any'), 'لا توجد أيقونة any');
  // كل ملف أيقونة مُشار إليه موجود على القرص وبأبعاده الصحيحة
  for (const icon of manifest.icons) {
    if (icon.type === 'image/svg+xml') continue;
    const file = path.join(ROOT, icon.src.split('?')[0].replace(/^\//, ''));
    assert.ok(fs.existsSync(file), 'أيقونة غير موجودة: ' + icon.src);
    const [w, h] = pngDims(file);
    const [aw, ah] = icon.sizes.split('x').map(Number);
    assert.equal(w, aw, 'عرض غير مطابق لـ ' + icon.src);
    assert.equal(h, ah, 'ارتفاع غير مطابق لـ ' + icon.src);
  }
});

test('63) أيقونات maskable معتمة تماماً (بلا زوايا شفافة تُقصّ في أندرويد)', () => {
  for (const f of ['icon-maskable-512.png', 'icon-maskable-192.png']) {
    const [w, h] = pngDims(path.join(ROOT, f));
    assert.ok(w >= 192, f + ' أصغر من المطلوب');
  }
});

test('64) رؤوس iOS: apple-touch-icon متعدد المقاسات + شاشات إقلاع + وصف SEO', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /apple-touch-icon[^>]*sizes="180x180"/, 'رابط apple-touch-icon 180 مفقود');
  assert.match(html, /apple-touch-icon[^>]*sizes="152x152"/, 'رابط apple-touch-icon 152 (iPad) مفقود');
  assert.match(html, /rel="apple-touch-startup-image"/, 'شاشات إقلاع iOS مفقودة');
  assert.match(html, /meta name="description"/, 'وصف SEO مفقود');
  assert.match(html, /rel="canonical"/, 'canonical مفقود');
  assert.match(html, /property="og:title"/, 'Open Graph مفقود');
  // كل ملف شاشة إقلاع مُشار إليه موجود فعلياً
  const splashRefs = [...html.matchAll(/href="(\/splash\/[^"?]+\.png)/g)].map((m) => m[1]);
  assert.ok(splashRefs.length >= 20, 'عدد شاشات الإقلاع غير كافٍ: ' + splashRefs.length);
  for (const s of splashRefs) assert.ok(fs.existsSync(path.join(ROOT, s)), 'شاشة إقلاع مفقودة: ' + s);
});

test('65) Digital Asset Links + إعدادات أندرويد متطابقة الحزمة', () => {
  const al = JSON.parse(fs.readFileSync(path.join(ROOT, '.well-known', 'assetlinks.json'), 'utf8'));
  assert.ok(Array.isArray(al) && al[0].target.package_name, 'assetlinks.json غير صالح');
  const twa = JSON.parse(fs.readFileSync(path.join(ROOT, 'android', 'twa-manifest.json'), 'utf8'));
  assert.equal(al[0].target.package_name, twa.packageId, 'package_name في assetlinks لا يطابق android');
  assert.match(al[0].relation[0], /handle_all_urls/, 'relation غير صحيحة في assetlinks');
});

test('66) الخدمة الخلفية v37: كاش CDN يبدأ بنفس البادئة ويعترض ملفات CDN', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const cacheName = (sw.match(/CACHE_NAME = '(zeroplus-v\d+)'/) || [])[1];
  const cdnCache = (sw.match(/CDN_CACHE = '([^']+)'/) || [])[1];
  assert.ok(cacheName && cdnCache, 'أسماء الكاش غير موجودة');
  assert.ok(cdnCache.startsWith(cacheName), 'كاش CDN يجب أن يبدأ بنفس بادئة الإصدار حتى لا يحذفه killOldSW');
  assert.ok(sw.includes('staleWhileRevalidate'), 'استراتيجية القديم-أثناء-التحديث مفقودة');
  // تحقق سلوكي: ملفات CDN تُعترض (تُقدَّم من الكاش) وSupabase يُترك للمتصفح
  const harness = createSwHarness();
  assert.equal(harness.__fetchHandled('https://cdn.jsdelivr.net/npm/x@1/a.js'), true, 'ملفات CDN لا تُعترض للعمل دون اتصال');
  assert.equal(harness.__fetchHandled('https://lfygprhvyudatgwikwfy.supabase.co/rest/v1/x'), false, 'Supabase يجب ألا يُعترض');
  assert.equal(harness.__fetchHandled('https://zeroplus.test/index.html'), true, 'صفحات التطبيق لا تُقدَّم من الكاش');
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
