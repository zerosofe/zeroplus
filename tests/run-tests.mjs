// اختبارات منطق المزامنة: تشغيل سكربت index.html داخل DOM وهمي + Supabase وهمي
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHarness, ROOT } from './harness.mjs';
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
process.exit(fail ? 1 : 0);
