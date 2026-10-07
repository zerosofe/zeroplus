#!/usr/bin/env node
/**
 * tools/generate-assetlinks.mjs — ZeroPlus
 * ---------------------------------------------------------------------------
 * يولّد `.well-known/assetlinks.json` وقيمة البصمة في إعدادات أندرويد من
 * مفتاح التوقيع الفعلي (Upload Key) حتى يرتبط تطبيق Google Play بالموقع.
 *
 * لماذا هذا السكربت؟ بصمة SHA256 لا يمكن «اختراعها»: يجب أن تُشتق من شهادة
 * التوقيع الحقيقية التي سترفع بها الحزمة إلى Google Play. لذلك نولّدها هنا
 * من الـ keystore بدل كتابة قيمة وهمية تكسر الربط.
 *
 * طريقتا الاستخدام:
 *
 *   1) من keystore (يحتاج JDK/keytool):
 *      node tools/generate-assetlinks.mjs --keystore upload-keystore.jks \
 *           --alias upload --storepass <كلمة السر> --keypass <كلمة السر>
 *
 *   2) أو بلصق البصمة يدوياً (انسخها من Google Play Console → App integrity،
 *      أو من `keytool -list -v`):
 *      node tools/generate-assetlinks.mjs --fingerprint "AB:CD:..."
 *
 * الناتج: يحدّث `.well-known/assetlinks.json` و `android/twa-manifest.json`
 * بنفس البصمة وبنفس package_name حتى يتطابق الطرفان.
 * ---------------------------------------------------------------------------
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const PACKAGE_NAME = get('--package') || 'com.zeroplus.android';
let fingerprint = get('--fingerprint');

if (!fingerprint && get('--keystore')) {
  const out = execFileSync('keytool', [
    '-list', '-v',
    '-keystore', get('--keystore'),
    '-alias', get('--alias') || 'upload',
    '-storepass', get('--storepass') || '',
    '-keypass', get('--keypass') || '',
  ], { encoding: 'utf8' });
  const m = out.match(/SHA256:\s*([0-9A-F:]{64,95})/i);
  if (!m) { console.error('لم أعثر على بصمة SHA256 في خرج keytool'); process.exit(1); }
  fingerprint = m[1];
}

if (!fingerprint) {
  console.error('قدّم --fingerprint أو --keystore. راجع الترويسة للاستخدام.');
  process.exit(1);
}
fingerprint = fingerprint.trim().toUpperCase();

// ===== 1) assetlinks.json =====
const assetlinks = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: PACKAGE_NAME,
      sha256_cert_fingerprints: [fingerprint],
    },
  },
];
fs.mkdirSync(path.join(ROOT, '.well-known'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, '.well-known', 'assetlinks.json'),
  JSON.stringify(assetlinks, null, 2) + '\n'
);

// ===== 2) twa-manifest.json (نفس البصمة/الحزمة) =====
const twaPath = path.join(ROOT, 'android', 'twa-manifest.json');
if (fs.existsSync(twaPath)) {
  const twa = JSON.parse(fs.readFileSync(twaPath, 'utf8'));
  twa.packageId = PACKAGE_NAME;
  twa.appVersionName = twa.appVersionName || '1.0.0';
  twa.features = twa.features || [];
  twa.fingerprints = [{ name: 'upload', value: fingerprint }];
  fs.writeFileSync(twaPath, JSON.stringify(twa, null, 2) + '\n');
}

console.log('تم تحديث:');
console.log('  ✅ .well-known/assetlinks.json  (package: ' + PACKAGE_NAME + ')');
if (fs.existsSync(twaPath)) console.log('  ✅ android/twa-manifest.json');
console.log('  بصمة SHA256: ' + fingerprint);
console.log('\nتذكّر: بعد النشر تحقّق من https://<نطاقك>/.well-known/assetlinks.json');
console.log('واختبر الربط بأداة Digital Asset Links checker في Google Play Console.');
