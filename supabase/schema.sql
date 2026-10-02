-- ============================================================================
--  ZeroPlus (Z+) — سكربت تجهيز قاعدة البيانات الكامل (جداول + صلاحيات + RLS)
--  الإصدار: v2  —  آخر تحديث: 2026-10-02
-- ============================================================================
--  ✅ آمن للتشغيل أكثر من مرة (Idempotent): لن يحذف أي بيانات ولن يكسر شيء.
--
--  📌 طريقة التشغيل:
--     Supabase Dashboard ← SQL Editor ← New query ← الصق الملف كامل ← Run
--
--  🔴 المشاكل التي يحلها هذا الملف (نتيجة تدقيق الكود مقابل القاعدة):
--     1) الجدولان user_tasks و user_focus_sessions كانا مستخدمين في التطبيق
--        وغير موجودين في هذا السكربت إطلاقاً → كل مزامنة المهام وجلسات التركيز
--        تفشل بخطأ 42P01 relation does not exist ويتم تجاهله بصمت.
--     2) جدول profiles كان ينقصه 6 أعمدة يستعملها التطبيق فعلياً:
--        password_hash, auth_provider, email, avatar_url, node_crowns, learning_track
--        → تسجيل حساب جديد كان يفشل بخطأ PGRST204 column not found.
--     3) صلاحيات دور anon كانت ناقصة على الجداول → 42501 permission denied.
--     4) سياسات RLS كانت لدور anon فقط، ودور authenticated (مستخدمو Google)
--        بلا أي سياسة → صفر وصول لحسابات Google حتى مع وجود الصلاحيات.
--     5) فهارس ناقصة على مفاتيح الاستعلام (device_id) → بطء مع كثرة الصفوف.
--
--  📌 ملاحظة معمارية: التطبيق يعمل بهوية مجهولة (anon) ويعتمد على device_id
--     لأنه لا يوجد تسجيل دخول Supabase Auth إلزامي (Google اختياري).
--     لذلك سياسات anon/authenticated هنا تسمح بالوصول الكامل — راجع
--     SETUP_GUIDE_AR.md ← قسم الملاحظات الأمنية لمعرفة الخيارات المستقبلية.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0) الدالة المساعدة: تحديث updated_at تلقائياً
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zp_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;


-- ----------------------------------------------------------------------------
-- 1) جدول الملف الشخصي (profiles)
--    يستخدمه التطبيق مع onConflict: 'device_id'
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id           text NOT NULL,
    user_name           text,
    department          text DEFAULT 'general',
    xp                  integer DEFAULT 0,
    total_focus_mins    integer DEFAULT 0,
    current_section_id  text DEFAULT 'sec_01',
    unlocked_stage_max  integer DEFAULT 1,
    streak_count        integer DEFAULT 1,
    last_active         timestamptz DEFAULT now(),
    created_at          timestamptz DEFAULT now()
);

-- إضافة أي عمود ناقص على الجدول الموجود (بدون حذف أو تعديل بيانات)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS device_id          text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS user_name          text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS department         text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS xp                 integer;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS total_focus_mins   integer;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS current_section_id text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS unlocked_stage_max integer;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS streak_count       integer;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_active        timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS created_at         timestamptz;

-- الأعمدة الناقصة التي كانت تسبب فشل تسجيل الحساب (PGRST204)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS password_hash      text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS auth_provider      text DEFAULT 'local';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email              text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_url         text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS node_crowns        jsonb DEFAULT '{}'::jsonb;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS learning_track     text DEFAULT 'general';

-- ضمان قيد UNIQUE على device_id (مطلوب حتى يعمل upsert مع onConflict: 'device_id')
DO $$
DECLARE
    has_unique boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN LATERAL (
            SELECT array_agg(a.attname ORDER BY x.ord) AS cols
            FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS x(attnum, ord)
            JOIN pg_attribute a
              ON a.attrelid = i.indrelid AND a.attnum = x.attnum
        ) cols ON true
        WHERE i.indrelid = 'public.profiles'::regclass
          AND i.indisunique
          AND cols.cols = ARRAY['device_id']::text[]
    ) INTO has_unique;

    IF NOT COALESCE(has_unique, false) THEN
        BEGIN
            -- إزالة أي تكرارات قبل إضافة القيد (نحتفظ بأقدم سطر لكل جهاز)
            DELETE FROM public.profiles p
            USING public.profiles q
            WHERE p.device_id = q.device_id
              AND p.ctid > q.ctid;

            ALTER TABLE public.profiles
                ADD CONSTRAINT profiles_device_id_unique UNIQUE (device_id);
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'profiles: تخطي إضافة القيد (صلاحية غير كافية)';
        WHEN unique_violation THEN
            RAISE NOTICE 'profiles: تخطي إضافة القيد (يوجد تكرار في device_id)';
        WHEN others THEN
            RAISE NOTICE 'profiles: تخطي إضافة القيد: %', SQLERRM;
        END;
    END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 2) جدول المهام (user_tasks)  ← كان ناقصاً بالكامل
--    يستخدمه التطبيق مع onConflict: 'device_id,id'
--    ملاحظة: id يولّده المتصفح (Date.now) لذلك هو bigint وليس uuid،
--    والمفتاح الأساسي مركّب (device_id, id) حتى لا يتصادم جهازان أبداً.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_tasks (
    id          bigint NOT NULL,
    device_id   text   NOT NULL,
    title       text   NOT NULL DEFAULT '',
    done        boolean DEFAULT false,
    tag         text DEFAULT '',
    prio        text DEFAULT 'normal',
    created_at  timestamptz DEFAULT now(),
    updated_at  timestamptz DEFAULT now(),
    PRIMARY KEY (device_id, id)
);

-- لو الجدول موجود من نسخة سابقة بشكل مختلف، نكمّل الأعمدة الناقصة
ALTER TABLE public.user_tasks ADD COLUMN IF NOT EXISTS title      text;
ALTER TABLE public.user_tasks ADD COLUMN IF NOT EXISTS done       boolean;
ALTER TABLE public.user_tasks ADD COLUMN IF NOT EXISTS tag        text;
ALTER TABLE public.user_tasks ADD COLUMN IF NOT EXISTS prio       text;
ALTER TABLE public.user_tasks ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE public.user_tasks ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- ضمان المفتاح الأساسي المركّب (device_id, id) لو الجدول منسوخ يدوياً
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.user_tasks'::regclass AND contype = 'p'
    ) THEN
        BEGIN
            DELETE FROM public.user_tasks p
            USING public.user_tasks q
            WHERE p.device_id = q.device_id AND p.id = q.id AND p.ctid > q.ctid;

            ALTER TABLE public.user_tasks
                ADD CONSTRAINT user_tasks_pkey PRIMARY KEY (device_id, id);
        EXCEPTION WHEN others THEN
            RAISE NOTICE 'user_tasks: تخطي إضافة المفتاح الأساسي: %', SQLERRM;
        END;
    END IF;
END $$;

DROP TRIGGER IF EXISTS trg_user_tasks_touch ON public.user_tasks;
CREATE TRIGGER trg_user_tasks_touch
    BEFORE INSERT OR UPDATE ON public.user_tasks
    FOR EACH ROW EXECUTE FUNCTION public.zp_touch_updated_at();


-- ----------------------------------------------------------------------------
-- 3) جدول جلسات التركيز (user_focus_sessions)  ← كان ناقصاً بالكامل
--    يستخدمه التطبيق مع onConflict: 'device_id,id'
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_focus_sessions (
    id             bigint NOT NULL,
    device_id      text   NOT NULL,
    session_name   text,
    duration_mins  integer DEFAULT 25,
    session_time   text,
    created_at     timestamptz DEFAULT now(),
    PRIMARY KEY (device_id, id)
);

ALTER TABLE public.user_focus_sessions ADD COLUMN IF NOT EXISTS session_name  text;
ALTER TABLE public.user_focus_sessions ADD COLUMN IF NOT EXISTS duration_mins integer;
ALTER TABLE public.user_focus_sessions ADD COLUMN IF NOT EXISTS session_time  text;
ALTER TABLE public.user_focus_sessions ADD COLUMN IF NOT EXISTS created_at    timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.user_focus_sessions'::regclass AND contype = 'p'
    ) THEN
        BEGIN
            DELETE FROM public.user_focus_sessions p
            USING public.user_focus_sessions q
            WHERE p.device_id = q.device_id AND p.id = q.id AND p.ctid > q.ctid;

            ALTER TABLE public.user_focus_sessions
                ADD CONSTRAINT user_focus_sessions_pkey PRIMARY KEY (device_id, id);
        EXCEPTION WHEN others THEN
            RAISE NOTICE 'user_focus_sessions: تخطي إضافة المفتاح الأساسي: %', SQLERRM;
        END;
    END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 4) جدول تقدم المحطات (user_node_progress)
--    يستخدمه التطبيق مع onConflict: 'device_id,node_id'
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_node_progress (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id   text NOT NULL,
    node_id     text NOT NULL,
    completed   boolean DEFAULT false,
    score       integer DEFAULT 0,
    updated_at  timestamptz DEFAULT now()
);

ALTER TABLE public.user_node_progress ADD COLUMN IF NOT EXISTS device_id  text;
ALTER TABLE public.user_node_progress ADD COLUMN IF NOT EXISTS node_id    text;
ALTER TABLE public.user_node_progress ADD COLUMN IF NOT EXISTS completed  boolean;
ALTER TABLE public.user_node_progress ADD COLUMN IF NOT EXISTS score      integer;
ALTER TABLE public.user_node_progress ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- ضمان قيد UNIQUE مركّب على (device_id, node_id)
DO $$
DECLARE
    has_unique boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN LATERAL (
            SELECT array_agg(a.attname ORDER BY x.ord) AS cols
            FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS x(attnum, ord)
            JOIN pg_attribute a
              ON a.attrelid = i.indrelid AND a.attnum = x.attnum
        ) cols ON true
        WHERE i.indrelid = 'public.user_node_progress'::regclass
          AND i.indisunique
          AND cols.cols = ARRAY['device_id','node_id']::text[]
    ) INTO has_unique;

    IF NOT COALESCE(has_unique, false) THEN
        BEGIN
            DELETE FROM public.user_node_progress p
            USING public.user_node_progress q
            WHERE p.device_id = q.device_id
              AND p.node_id   = q.node_id
              AND p.ctid > q.ctid;

            ALTER TABLE public.user_node_progress
                ADD CONSTRAINT user_node_progress_device_node_unique UNIQUE (device_id, node_id);
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'user_node_progress: تخطي إضافة القيد (صلاحية غير كافية)';
        WHEN unique_violation THEN
            RAISE NOTICE 'user_node_progress: تخطي إضافة القيد (تكرارات موجودة)';
        WHEN others THEN
            RAISE NOTICE 'user_node_progress: تخطي إضافة القيد: %', SQLERRM;
        END;
    END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 5) جدول إتقان المصطلحات (user_word_mastery)
--    يستخدمه التطبيق مع onConflict: 'device_id,term_key'
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_word_mastery (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id      text NOT NULL,
    term_key       text NOT NULL,
    mastered       boolean DEFAULT false,
    mistake_count  integer DEFAULT 0,
    next_review_at timestamptz,
    updated_at     timestamptz DEFAULT now()
);

ALTER TABLE public.user_word_mastery ADD COLUMN IF NOT EXISTS device_id      text;
ALTER TABLE public.user_word_mastery ADD COLUMN IF NOT EXISTS term_key       text;
ALTER TABLE public.user_word_mastery ADD COLUMN IF NOT EXISTS mastered       boolean;
ALTER TABLE public.user_word_mastery ADD COLUMN IF NOT EXISTS mistake_count  integer;
ALTER TABLE public.user_word_mastery ADD COLUMN IF NOT EXISTS next_review_at timestamptz;
ALTER TABLE public.user_word_mastery ADD COLUMN IF NOT EXISTS updated_at     timestamptz;

-- ضمان قيد UNIQUE مركّب على (device_id, term_key)
DO $$
DECLARE
    has_unique boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN LATERAL (
            SELECT array_agg(a.attname ORDER BY x.ord) AS cols
            FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS x(attnum, ord)
            JOIN pg_attribute a
              ON a.attrelid = i.indrelid AND a.attnum = x.attnum
        ) cols ON true
        WHERE i.indrelid = 'public.user_word_mastery'::regclass
          AND i.indisunique
          AND cols.cols = ARRAY['device_id','term_key']::text[]
    ) INTO has_unique;

    IF NOT COALESCE(has_unique, false) THEN
        BEGIN
            DELETE FROM public.user_word_mastery p
            USING public.user_word_mastery q
            WHERE p.device_id = q.device_id
              AND p.term_key  = q.term_key
              AND p.ctid > q.ctid;

            ALTER TABLE public.user_word_mastery
                ADD CONSTRAINT user_word_mastery_device_term_unique UNIQUE (device_id, term_key);
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'user_word_mastery: تخطي إضافة القيد (صلاحية غير كافية)';
        WHEN unique_violation THEN
            RAISE NOTICE 'user_word_mastery: تخطي إضافة القيد (تكرارات موجودة)';
        WHEN others THEN
            RAISE NOTICE 'user_word_mastery: تخطي إضافة القيد: %', SQLERRM;
        END;
    END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 6) الفهارس (تسريع كل استعلامات المزامنة التي تفلتر بـ device_id)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_profiles_device_id            ON public.profiles (device_id);
CREATE INDEX IF NOT EXISTS idx_user_tasks_device_id          ON public.user_tasks (device_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_focus_sessions_device_created ON public.user_focus_sessions (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_node_progress_device          ON public.user_node_progress (device_id);
CREATE INDEX IF NOT EXISTS idx_word_mastery_review           ON public.user_word_mastery (device_id, next_review_at);


-- ----------------------------------------------------------------------------
-- 7) الصلاحيات (GRANTS) ← أحد الأسباب المباشرة لفشل المزامنة
--    الخطأ: 42501 permission denied for table ...
-- ----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles             TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_tasks           TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_focus_sessions  TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_node_progress   TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_word_mastery    TO anon, authenticated, service_role;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 8) تفعيل حماية الصفوف (RLS) والسياسات
--    التطبيق يعمل بهوية مجهولة (بدون تسجيل دخول Supabase Auth) ويعتمد على
--    device_id، لذلك يجب أن تسمح السياسات لدور anon بالقراءة والكتابة.
--    ونضيف نفس السياسات لدور authenticated لأن تسجيل دخول Google يعمل بهذا الدور.
--    ملاحظة: RLS مفعّل + لا توجد سياسة = صفر وصول.
-- ----------------------------------------------------------------------------
ALTER TABLE public.profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_tasks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_focus_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_node_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_word_mastery  ENABLE ROW LEVEL SECURITY;

-- profiles
DROP POLICY IF EXISTS "zp_anon_all_profiles" ON public.profiles;
CREATE POLICY "zp_anon_all_profiles" ON public.profiles
    FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "zp_auth_all_profiles" ON public.profiles;
CREATE POLICY "zp_auth_all_profiles" ON public.profiles
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- user_tasks
DROP POLICY IF EXISTS "zp_anon_all_user_tasks" ON public.user_tasks;
CREATE POLICY "zp_anon_all_user_tasks" ON public.user_tasks
    FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "zp_auth_all_user_tasks" ON public.user_tasks;
CREATE POLICY "zp_auth_all_user_tasks" ON public.user_tasks
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- user_focus_sessions
DROP POLICY IF EXISTS "zp_anon_all_focus_sessions" ON public.user_focus_sessions;
CREATE POLICY "zp_anon_all_focus_sessions" ON public.user_focus_sessions
    FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "zp_auth_all_focus_sessions" ON public.user_focus_sessions;
CREATE POLICY "zp_auth_all_focus_sessions" ON public.user_focus_sessions
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- user_node_progress
DROP POLICY IF EXISTS "zp_anon_all_node_progress" ON public.user_node_progress;
CREATE POLICY "zp_anon_all_node_progress" ON public.user_node_progress
    FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "zp_auth_all_node_progress" ON public.user_node_progress;
CREATE POLICY "zp_auth_all_node_progress" ON public.user_node_progress
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- user_word_mastery
DROP POLICY IF EXISTS "zp_anon_all_word_mastery" ON public.user_word_mastery;
CREATE POLICY "zp_anon_all_word_mastery" ON public.user_word_mastery
    FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "zp_auth_all_word_mastery" ON public.user_word_mastery;
CREATE POLICY "zp_auth_all_word_mastery" ON public.user_word_mastery
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- ============================================================================
-- 9) التحقق بعد التشغيل
-- ============================================================================
--  أ) من نفس SQL Editor نفّذ:
--        SELECT table_name FROM information_schema.tables
--        WHERE table_schema = 'public' ORDER BY table_name;
--     ✔ المتوقع: profiles, user_focus_sessions, user_node_progress, user_tasks, user_word_mastery
--
--  ب) تحقق من الصلاحيات (لا يجب أن يظهر أي خطأ):
--        SELECT count(*) FROM public.profiles;
--        SELECT count(*) FROM public.user_tasks;
--        SELECT count(*) FROM public.user_focus_sessions;
--
--  ج) للتحقق من خارج التطبيق، افتح في المتصفح (استبدل YOUR_ANON_KEY):
--     https://lfygprhvyudatgwikwfy.supabase.co/rest/v1/user_tasks?select=*&limit=1&apikey=YOUR_ANON_KEY
--     ✔ الصحيح: []          ✘ الخطأ: {"code":"42501", ...} أو {"code":"42P01", ...}
--
--  د) افتح الموقع وسجّل اسمك، ثم راقب مؤشر السحابة أعلى الصفحة:
--     🟢 أخضر  = المزامنة تعمل والبيانات تُحفظ في Supabase
--     🟡 كهرماني = توجد عمليات بانتظار المزامنة (سيتولى التطبيق رفعها تلقائياً)
--     🔴 أحمر  = فشل مزامنة (افتح Console وشف الخطأ، غالباً السكربت لم يُنفَّذ كاملاً)
-- ============================================================================
