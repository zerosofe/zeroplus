// أداة تطوير: ترسم كل أنواع الأشجار في مراحل النموّ إلى صورة PNG للمعاينة البصرية.
// الاستخدام: node tools/preview-tree-art.mjs [out.png]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync('/tmp/focus/tree-art.js', 'utf8');
const ctx = { escapeHtml: (v) => String(v ?? ''), userTrees: [], Date, Math, console };
const api = vm.runInNewContext(src + '\n;({ TREE_SPECIES, treeSVG, treeGrowthSVG, treeStageArt, TREE_GROWTH_STAGES });', ctx);

const CELL = 120;
const PAD = 8;
const species = api.TREE_SPECIES;
const cols = species.length;
const rows = 5;
const W = cols * CELL;
const H = rows * CELL + 30;

const bg = (x, y, w, h, fill, opacity = 1, rx = 0) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" opacity="${opacity}"/>`;

let out = '';
for (let c = 0; c < cols; c++) {
  for (let r = 0; r < rows; r++) {
    const x = c * CELL, y = r * CELL;
    // خلفية تشبه قطعة الأرض
    out += bg(x, y, CELL, CELL, '#e8f6ec');
    out += bg(x, y + CELL - 22, CELL, 22, '#bfe0c8');
  }
}
// عناوين الأنواع
species.forEach((sp, c) => {
  out += `<text x="${c * CELL + CELL / 2}" y="${H - 8}" font-family="sans-serif" font-size="15" fill="#123" text-anchor="middle">${sp.en}</text>`;
});
// الأشجار: صفّ لكل مرحلة
for (let r = 0; r < rows; r++) {
  species.forEach((sp, c) => {
    const inner = api.treeSVG(sp.id, { className: '', stage: r }).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    const size = 104;
    const x = c * CELL + (CELL - size) / 2;
    const y = r * CELL + (CELL - size) + 4;
    out += `<g transform="translate(${x},${y})"><svg x="0" y="0" width="${size}" height="${size * 1.45}" viewBox="0 0 100 145">${inner}</svg></g>`;
  });
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${out}</svg>`;
fs.writeFileSync('/tmp/focus/tree-sheet.svg', svg);
const outPath = process.argv[2] || '/tmp/focus/tree-sheet.png';
await sharp(Buffer.from(svg)).png().toFile(outPath);
console.log('كُتبت المعاينة:', outPath, W + 'x' + H);
