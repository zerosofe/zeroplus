#!/usr/bin/env node
/**
 * tools/generate-pwa-assets.mjs — ZeroPlus
 * ---------------------------------------------------------------------------
 * يولّد أصول PWA الناقصة من الهوية البصرية الموجودة أصلاً (assets-src/*.svg،
 * وهي نسخ حرفية من icon.svg في جذر المشروع). لا شعار جديد ولا لون جديد:
 * نفس التدرّج الكحلي #0E2F76→#123d8f، نفس حرف Z، نفس علامة +.
 *
 * ما يولّده:
 *   1) أيقونات maskable (192/384/512) — مطلوبة لأيقونات أندرويد المتكيّفة
 *      ولباقة TWA في Google Play. الشعار مصغّر 62% ليبقى داخل المنطقة الآمنة.
 *   2) apple-touch-icon (180/167/152) بخلفية معتمة كاملة — iOS يطبّق قناعه
 *      الخاص، والزوايا الشفافة تظهر كزوايا داكنة على الشاشة الرئيسية.
 *   3) شاشات الإقلاع (apple-touch-startup-image) لكل مقاسات iPhone/iPad
 *      المعروفة: خلفية background_color من manifest + الأيقونة في المنتصف.
 *
 * الاستخدام:
 *   npm i --no-save sharp && node tools/generate-pwa-assets.mjs
 *
 * ملاحظة: الأصول المولّدة محفوظة في Git — لا حاجة لتشغيل هذا السكربت للنشر.
 * ---------------------------------------------------------------------------
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('يتطلّب مكتبة sharp (أداة تطوير فقط، ليست تابعة للتطبيق):\n  npm i --no-save sharp\nثم أعد التشغيل.');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const BACKGROUND_COLOR = manifest.background_color || '#070d18';

const SRC_BRAND = path.join(ROOT, 'icon.svg');                        // الشعار الأصلي (زوايا مستديرة)
const SRC_ANY = path.join(ROOT, 'assets-src', 'icon-any.svg');        // ملء الإطار (لـ iOS)
const SRC_MASKABLE = path.join(ROOT, 'assets-src', 'icon-maskable.svg'); // ملء الإطار + شعار مصغّر

const SPLASH_DIR = path.join(ROOT, 'splash');
fs.mkdirSync(SPLASH_DIR, { recursive: true });

async function png(svgPath, size, dest, bg) {
  await sharp(fs.readFileSync(svgPath), { density: Math.max(72, Math.round((size / 512) * 300)) })
    .resize(size, size, { fit: 'cover', background: bg })
    .flatten({ background: bg })
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(dest);
}

/** شاشة إقلاع: خلفية صلبة بلون manifest + الأيقونة في المنتصف */
async function splash(width, height, dest) {
  const iconSize = Math.round(Math.min(width, height) * 0.28);
  const icon = await sharp(fs.readFileSync(SRC_BRAND), { density: Math.max(72, Math.round((iconSize / 512) * 300)) })
    .resize(iconSize, iconSize)
    .png()
    .toBuffer();

  await sharp({ create: { width, height, channels: 4, background: BACKGROUND_COLOR } })
    .composite([{ input: icon, gravity: 'center' }])
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(dest);
}

const MASKABLE = [
  { size: 192, file: 'icon-maskable-192.png' },
  { size: 384, file: 'icon-maskable-384.png' },
  { size: 512, file: 'icon-maskable-512.png' },
];

// iOS يقصّ الأيقونة بنفسه ← نقدّم مربعاً معتماً كاملاً
const APPLE_TOUCH = [
  { size: 180, file: 'apple-touch-icon.png' },     // iPhone (كل الموديلات الحديثة)
  { size: 167, file: 'apple-touch-icon-167.png' }, // iPad Pro 10.5 / 11 / 12.9
  { size: 152, file: 'apple-touch-icon-152.png' }, // iPad / iPad mini
];

// [العرض بالبكسل الفعلي، الارتفاع، device-pixel-ratio]
const SPLASH_DEVICES = [
  [1320, 2868, 3], // iPhone 16 Pro Max
  [1206, 2622, 3], // iPhone 16 Pro
  [1290, 2796, 3], // iPhone 15 Pro Max / 14 Pro Max / 16 Plus / 15 Plus
  [1179, 2556, 3], // iPhone 15 / 15 Pro / 14 Pro / 16
  [1284, 2778, 3], // iPhone 14 Plus / 13 Pro Max / 12 Pro Max
  [1170, 2532, 3], // iPhone 14 / 13 / 12 / 12 Pro
  [1242, 2688, 3], // iPhone 11 Pro Max / XS Max
  [1125, 2436, 3], // iPhone X / XS / 11 Pro
  [828, 1792, 2],  // iPhone XR / 11
  [1242, 2208, 3], // iPhone 8 Plus / 7 Plus
  [750, 1334, 2],  // iPhone 8 / SE (2020/2022)
  [2048, 2732, 2], // iPad Pro 12.9
  [1668, 2388, 2], // iPad Pro 11
  [1668, 2224, 2], // iPad Pro 10.5
  [1536, 2048, 2], // iPad 9.7 / Air / mini
];

const report = [];

for (const { size, file } of MASKABLE) {
  await png(SRC_MASKABLE, size, path.join(ROOT, file), BACKGROUND_COLOR);
  report.push(file);
}

for (const { size, file } of APPLE_TOUCH) {
  await png(SRC_ANY, size, path.join(ROOT, file), BACKGROUND_COLOR);
  report.push(file);
}

const splashLinks = [];
for (const [w, h, dpr] of SPLASH_DEVICES) {
  for (const orientation of ['portrait', 'landscape']) {
    const W = orientation === 'portrait' ? w : h;
    const H = orientation === 'portrait' ? h : w;
    const file = `splash/apple-splash-${W}x${H}.png`;
    await splash(W, H, path.join(ROOT, file));
    report.push(file);
    splashLinks.push({
      href: '/' + file,
      media:
        `(device-width: ${Math.round(w / dpr)}px) and (device-height: ${Math.round(h / dpr)}px)` +
        ` and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: ${orientation})`,
    });
  }
}

// يُقرأه tools/inject-head-snippets.mjs لإدراج روابط الشاشات في index.html
fs.writeFileSync(path.join(ROOT, 'tools', 'splash-links.json'), JSON.stringify(splashLinks, null, 2) + '\n');

console.log('تم توليد ' + report.length + ' ملف PWA:');
for (const f of report) console.log('  ✅ ' + f);
console.log('\nروابط شاشات الإقلاع → tools/splash-links.json (' + splashLinks.length + ' رابط)');
