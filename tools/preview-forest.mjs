// أداة تطوير: تبني غابة بعدد أشجار محدّد وتُرسم كمشهد SVG ثم صورة PNG للمعاينة.
// الاستخدام: node tools/preview-forest.mjs [عدد الأشجار] [out.png]
// تحتاج jsdom + sharp (اختياريتان للتطوير فقط): npm i --no-save jsdom sharp
import fs from 'node:fs';
import path from 'node:path';

const count = Number(process.argv[2] || 23);
const outPath = process.argv[3] || `/tmp/focus/forest-${count}.png`;
const jsdom = await import('jsdom').catch(() => null);
const sharpMod = await import('sharp').catch(() => null);
const sharp = sharpMod ? (sharpMod.default || sharpMod) : null;
if (!jsdom || !sharp) { console.log('⚠️ تحتاج jsdom و sharp: npm i --no-save jsdom sharp'); process.exit(0); }

const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const { JSDOM, VirtualConsole } = jsdom;
const vc = new VirtualConsole();
const errors = [];
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.message || e)));
vc.on('error', (...a) => errors.push('error: ' + a.join(' ')));

const trees = [];
const types = ['oak', 'pine', 'palm', 'cypress', 'myrtle', 'blossom', 'jacaranda', 'paulownia', 'maple', 'ginkgo', 'holly', 'cedar', 'baobab', 'euca', 'olive', 'willow'];
for (let i = 0; i < count; i++) {
  trees.push({
    id: 1700000000000 + i, user_id: 'u_demo', tree_type: types[i % types.length],
    duration: 15 + (i % 4) * 10, planted_at: new Date(Date.now() - (count - i) * 86400000).toISOString(),
    created_at: new Date(Date.now() - (count - i) * 86400000).toISOString(), sync: 'synced',
  });
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://zeroplus.test/', virtualConsole: vc,
  beforeParse(window) {
    window.localStorage.setItem('zp_trees', JSON.stringify(trees));
    window.localStorage.setItem('zp_username', 'طالب الغابة');
    window.Notification = Object.assign(function () {}, { permission: 'default', requestPermission: async () => 'default', addEventListener() {} });
    window.navigator.serviceWorker = { controller: { postMessage() {} }, ready: Promise.resolve({ showNotification() {} }), register: () => Promise.resolve({ update() {} }), getRegistrations: () => Promise.resolve([]), addEventListener() {} };
    window.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
    window.confirm = () => false;
  },
});
const { window } = dom;
await new Promise((r) => window.addEventListener('load', r));
await new Promise((r) => setTimeout(r, 120));

const scene = window.document.getElementById('forest-scene');
const inner = scene ? scene.innerHTML : '';
const m = inner.match(/<svg class="w-full"[^>]*>[\s\S]*<\/svg>/);
if (!m) { console.log('لم يُعثر على مشهد الغابة'); console.log(inner.slice(0, 400)); process.exit(1); }
let svg = m[0].replace('<svg class="w-full"', '<svg xmlns="http://www.w3.org/2000/svg" style="background:linear-gradient(180deg,#f0faf4,#e2f4ea)"');

// ألوان لوحة التركيز (تُستخدم عبر var في الرسم) → قيم ثابتة للمعاينة
svg = svg.replace(/var\(--ds-card\)/g, '#ffffff').replace(/var\(--ds-muted\)/g, '#3f6f59').replace(/var\(--ds-primary\)/g, '#0f6b4a');
fs.writeFileSync('/tmp/focus/forest.svg', svg);
const png = await sharp(Buffer.from(svg)).resize({ width: 1100 }).png().toFile(outPath);
const meta = await sharp(outPath).metadata();
console.log('كُتبت المعاينة:', outPath, meta.width + 'x' + meta.height, '| أشجار:', trees.length);
const stats = window.document.getElementById('focus-tiles-hint');
console.log('عدد القطع:', stats && stats.textContent, '| مواضع القطعة الحالية:', window.document.getElementById('forest-slot-chip')?.textContent);
console.log('أخطاء وقت التشغيل:', errors.length ? errors.slice(0, 3) : 'لا شيء');
dom.window.close();
process.exit(0);
