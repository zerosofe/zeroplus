# ZeroPlus — التحضير لـ Google Play عبر Trusted Web Activity (TWA)

هذا **ليس** تطبيق WebView مضمّن. ZeroPlus تطبيق ويب تقدمي (PWA) كامل، ونغلفه
لـ Google Play بالطريقة الحديثة الموصى بها من Google: **Bubblewrap → Trusted Web
Activity (TWA)**، فيُعرض الموقع الإنتاجي نفسه داخل Chrome/Custom Tabs مع
إمكانية التثبيت الكامل، مع الحفاظ على المصادقة وService Worker والـ PWA manifest
كما هي تماماً.

> لا تُحوِّل المشروع إلى إطار عمل أصلي (لا Flutter/React Native/WebView يدوي).
> كل شيء يبقى PWA؛ أندرويد مجرد غلاف TWA.

---

## المتطلبات

- Node.js 18+
- JDK 17+ (لأداة `keytool` ولبناء أندرويد)
- Android Studio (اختياري للفحص) + Android SDK
- حساب Google Play Console (خطوة يدوية خارجية)
- نطاق إنتاجي تعمل عليه PWA (حالياً `https://zeroplus-8jz.pages.dev`،
  ويُفضّل ربط نطاق مخصص لاحقاً).

## ١) تثبيت Bubblewrap

```bash
npm install -g @bubblewrap/cli
```

## ٢) توليد مشروع أندرويد من الـ manifest

من داخل مجلد `android/`:

```bash
cd android
bubblewrap init --manifest https://zeroplus-8jz.pages.dev/manifest.json
```

سيقرأ Bubblewrap القيم من `manifest.json` (الاسم، الألوان، الأيقونات بما فيها
`maskable`) ويكتب مشروع أندرويد + `twa-manifest.json`. راجع الملف
`twa-manifest.json` المرفق كمرجع للقيم المتوقعة (packageId = `com.zeroplus.android`).

> إن غيّر Bubblewrap اسم الحزمة، حدِّث `android/twa-manifest.json` ثم شغّل
> `tools/generate-assetlinks.mjs` بنفس `--package` ليطابق الطرفان.

## ٣) إنشاء مفتاح التوقيع (Upload Key)

```bash
keytool -genkeypair -v -keystore android/upload-keystore.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

سيُسألك عن كلمات السر — احتفظ بها في مكان آمن (تُستخدم للتوقيع وللـ Play App
Signing). **لا تضع الـ keystore أو كلمات السر في Git** (مُدرجة في `.gitignore`).

## ٤) توليد Digital Asset Links من المفتاح

```bash
node tools/generate-assetlinks.mjs \
  --keystore android/upload-keystore.jks \
  --alias upload \
  --storepass <كلمة السر> --keypass <كلمة السر> \
  --package com.zeroplus.android
```

يحدّث `.well-known/assetlinks.json` ببصمة SHA256 الحقيقية. بعد النشر تأكد من:

```
https://<نطاقك>/.well-known/assetlinks.json   ← يُرجع JSON بالبصمة الصحيحة
```

## ٥) بناء الحزمة الموقّعة (.aab / .apk)

```bash
cd android
bubblewrap build
```

الناتج: `app-release-signed.aab` جاهز للرفع إلى Google Play Console.

## ٦) النشر على Play Console (يدوي)

1. أنشئ تطبيقاً جديداً باسم **ZeroPlus** وحدد package `com.zeroplus.android`.
2. فعّل **Play App Signing** (توصية Google) — عندها ستحتاج أيضاً بصمة
   «مفتاح توقيع Play» في `assetlinks.json` (انسخها من Play Console → Setup →
   App integrity وأضفها كبصمة ثانية عبر `tools/generate-assetlinks.mjs`).
3. ارفع `app-release-signed.aab`.
4. أكمل بطاقة المتجر (وصف، لقطات، أيقونة 512، صورة مميزة).
5. انتظر المراجعة.

## التحقق من الربط (Digital Asset Links)

- أداة Google الرسمية: [Statement List Web Tool](https://developers.google.com/digital-asset-links/v1/statements)
  أو `bubblewrap validate`.
- على جهاز أندرويد بعد التثبيت: إن فُتح التطبيق دون شريط عناوين المتصفح، فالربط
  ناجح. إن ظهر شريط عناوين، فالبصمة أو `package_name` غير متطابقين.

## ملاحظات أمان

- لا تضع أي مفتاح Supabase `service_role` في أندرويد أو الويب (غير موجود أصلاً).
- مفتاح `anon` الموجود في الويب آمن لأنه مقيد بـ RLS في Supabase.
- الـ keystore وكلمات السر خارج Git (`.gitignore` يشمل `*.pem`، وأضف `*.jks`).
