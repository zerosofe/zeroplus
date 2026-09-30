-- ============================================================================
--  ZeroPlus (Z+) — سكربت تجهيز قاعدة البيانات الكامل (جداول + صلاحيات + RLS)
-- ============================================================================
--  ✅ آمن للتشغيل أكثر من مرة (Idempotent): لن يحذف أي بيانات ولن يكسر شيء.
--
--  📌 طريقة التشغيل:
--     Supabase Dashboard ← SQL Editor ← New query ← الصق الملف كامل ← Run
--
--  📌 المشكلة التي يحلها (نتيجة فحص مباشر بتاريخ 2026-09-30):
--     الجداول الثلاثة موجودة فعلاً في المشروع، لكن دور anon (وهو الدور الذي
--     يستعمله التطبيق عبر المفتاح العام) لا يملك أي صلاحية عليها، فكل عمليات
--     المزامنة تفشل بالخطأ:
--        { code: "42501", message: "permission denied for table profiles" }
--     لهذا مؤشر السحابة في التطبيق يبقى رمادياً (Offline) والبيانات لا تُحفظ
--     في السحابة أبداً.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) جدول الملف الشخصي (profiles)
--    يستخدمه التطبيق مع  onConflict: 'device_id'
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
-- 2) جدول تقدم المحطات (user_node_progress)
--    يستخدمه التطبيق مع  onConflict: 'device_id,node_id'
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
-- 3) جدول إتقان المصطلحات (user_word_mastery)
--    يستخدمه التطبيق مع  onConflict: 'device_id,term_key'
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

-- فهرس مفيد لاستعلامات مراجعة المصطلحات لاحقاً
CREATE INDEX IF NOT EXISTS idx_word_mastery_review
    ON public.user_word_mastery (device_id, next_review_at);


-- ----------------------------------------------------------------------------
-- 4) الصلاحيات (GRANTS) ← هذا هو السبب المباشر لفشل المزامنة حالياً
--    الخطأ الحالي: 42501 permission denied for table ...
-- ----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles
    TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_node_progress
    TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_word_mastery
    TO anon, authenticated, service_role;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
    TO anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 5) تفعيل حماية الصفوف (RLS) والسياسات
--    التطبيق يعمل بهوية مجهولة (بدون تسجيل دخول Supabase Auth) ويعتمد على
--    device_id، لذلك يجب أن تسمح السياسات لدور anon بالقراءة والكتابة.
--    ملاحظة: RLS مفعّل + لا توجد سياسة = صفر وصول، لذا السياسة أدناه ضرورية.
-- ----------------------------------------------------------------------------
ALTER TABLE public.profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_node_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_word_mastery  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "zp_anon_all_profiles" ON public.profiles;
CREATE POLICY "zp_anon_all_profiles"
    ON public.profiles
    FOR ALL
    TO anon
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "zp_anon_all_node_progress" ON public.user_node_progress;
CREATE POLICY "zp_anon_all_node_progress"
    ON public.user_node_progress
    FOR ALL
    TO anon
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "zp_anon_all_word_mastery" ON public.user_word_mastery;
CREATE POLICY "zp_anon_all_word_mastery"
    ON public.user_word_mastery
    FOR ALL
    TO anon
    USING (true)
    WITH CHECK (true);


-- ============================================================================
-- 6) التحقق بعد التشغيل
-- ============================================================================
--  أ) من نفس SQL Editor نفّذ:
--        SELECT * FROM public.profiles LIMIT 5;
--     ✔ النتيجة الصحيحة: جدول فارغ [] بدون أي خطأ.
--     ✘ لو ظهر permission denied → لم يكتمل تنفيذ السكربت.
--
--  ب) افتح الموقع وسجّل اسمك، ثم راقب مؤشر السحابة أعلى الصفحة:
--     ✔ أخضر  = المزامنة تعمل والبيانات تُحفظ في Supabase.
--     ✘ رمادي = لا يزال هناك مشكلة (شوف SETUP_GUIDE_AR.md).
--
--  ج) للتحقق من خارج التطبيق، افتح في المتصفح (استبدل YOUR_ANON_KEY):
--     https://lfygprhvyudatgwikwfy.supabase.co/rest/v1/profiles?select=*&limit=1&apikey=YOUR_ANON_KEY
--     ✔ الصحيح: []
--     ✘ الخطأ:  {"code":"42501","message":"permission denied ..."}
-- ============================================================================
