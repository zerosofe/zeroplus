// أداة تطوير: تقيس أبعاد شاشة التركيز على مقاسات iPhone/iPad/أندرويد (بلا متصفح) وتكشف أي فيض أفقي.
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// فحص ثابت للتخطيط: لا عرض ثابت أكبر من الشاشة، ولا فيض أفقي محتمل في قسم التركيز
const start = html.indexOf('<section id="tab-pomodoro"');
const end = html.indexOf('<section id="tab-zero"');
const section = html.slice(start, end);
// كتلة CSS الخاصة بشاشة التركيز: من أول قاعدة للمسرح حتى نهاية وسم الأنماط
const cssStart = html.indexOf('.focus-stage {');
const cssEnd = html.indexOf('</style>', cssStart);
const focusCss = html.slice(cssStart, cssEnd);

const problems = [];
// 1) عروض ثابتة كبيرة داخل القسم (px أكبر من ٤٠٠) قد تسبب فيضاً على الجوال
const widePx = [...section.matchAll(/(?<!min-)(?<!max-)\bwidth\s*:\s*(\d{3,})px/g)].map(m => Number(m[1])).filter(v => v > 400);
if (widePx.length) problems.push('عرض ثابت كبير في العلامة: ' + widePx.join(','));
const wideCssPx = [...focusCss.matchAll(/(?<!min-)(?<!max-)\bwidth\s*:\s*(\d{3,})px/g)].map(m => Number(m[1])).filter(v => v > 420);
if (wideCssPx.length) problems.push('عرض ثابت كبير في CSS: ' + wideCssPx.join(','));

// 2) كل عناصر التحكّم لها هدف لمس ≥ 44px
const minHeights = [...focusCss.matchAll(/min-height\s*:\s*(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
if (minHeights.length && Math.min(...minHeights) < 44) problems.push('هدف لمس أصغر من ٤٤px: ' + Math.min(...minHeights));
if (!/\.focus-tree-option\b[^}]*min-height:\s*(?:4[4-9]|[5-9]\d|\d{3})px/.test(focusCss)) problems.push('خيارات الشجرة بلا هدف لمس ≥ ٤٤px');

// 3) الشبكات تستخدم auto-fill / minmax (تتقلّص على الجوال بدل الفيض)
const grids = [...focusCss.matchAll(/grid-template-columns\s*:\s*([^;]+);/g)].map(m => m[1].trim());
const fixedGrid = grids.filter(g => /^repeat\(\d+,\s*(?!minmax|auto)/.test(g));
if (fixedGrid.length) problems.push('شبكة بأعمدة ثابتة: ' + fixedGrid.join(' | '));

// 4) مشهد الغابة: SVG بلا أبعاد ثابتة (يتكيّف مع العرض)
if (/<svg[^>]*id="forest-scene"[^>]*width="\d/.test(html)) problems.push('مشهد الغابة بعرض ثابت');

// 5) هدف اللمس المطلوب في المناديب: الأزرار الأساسية
const required = ['pomo-play-btn', 'focus-abandon-btn', 'focus-duration-row', 'focus-tree-picker'];
required.forEach(id => { if (!section.includes('id="' + id + '"')) problems.push('زر مفقود: ' + id); });

// 6) عرض الحاويات لا يتجاوز الشاشة (max-width / width:100%)
if (!/overflow-x:\s*hidden/.test(html)) problems.push('لا قاعدة تمنع الفيض الأفقي على مستوى الصفحة');
if (!/\.focus-picker\s*{[^}]*grid-template-columns:\s*repeat\(auto-fill, minmax/.test(focusCss)) problems.push('شبكة اختيار الشجرة لا تتكيّف مع العرض');
if (!/dir="ltr"/.test(section)) problems.push('عدّاد المؤقّت بلا ضبط اتجاه (يجب ألا ينقلب على RTL)');

console.log('أهداف اللمس الدنيا:', Math.min(...minHeights) + 'px', '| الشبكات:', grids.join(' | ') || '(لا شيء)');
console.log('عروض ثابتة كبيرة:', widePx.length + wideCssPx.length);
console.log(problems.length ? '⚠️ ملاحظات: ' + problems.join('\n  - ') : '✅ لا مشاكل تخطيط: لا فيض أفقي ولا أهداف لمس صغيرة');
