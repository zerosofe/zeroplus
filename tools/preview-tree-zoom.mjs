// أداة تطوير: معاينة مكبّرة لعدد محدّد من الأنواع والمراحل.
// node tools/preview-tree-zoom.mjs [out.png] [ids] [stages]
import fs from 'node:fs';
import vm from 'node:vm';
import sharp from 'sharp';

const src = fs.readFileSync('/tmp/focus/tree-art.js', 'utf8');
const ctx = { escapeHtml: (v) => String(v ?? ''), userTrees: [], Date, Math, console };
const api = vm.runInNewContext(src + '\n;({ TREE_SPECIES, treeSVG });', ctx);

const ids = (process.argv[3] || 'oak,maple,ginkgo,euca,willow,cedar,baobab,palm,jacaranda,conical').split(',');
const stages = (process.argv[4] || '2,3,4').split(',').map(Number);
const CELL = 260;
const W = ids.length * CELL;
const H = stages.length * CELL;

let out = '';
for (let c = 0; c < ids.length; c++) {
  for (let r = 0; r < stages.length; r++) {
    out += `<rect x="${c * CELL}" y="${r * CELL}" width="${CELL}" height="${CELL}" fill="${r % 2 ? '#eef7f0' : '#e3f2e8'}"/>`;
    out += `<rect x="${c * CELL}" y="${r * CELL + CELL - 40}" width="${CELL}" height="40" fill="#bfe0c8"/>`;
  }
}
ids.forEach((id, c) => stages.forEach((st, r) => {
  const inner = api.treeSVG(id, { className: '', stage: st }).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  const size = CELL - 26;
  const x = c * CELL + 13, y = r * CELL + (CELL - 40) - size * 1.45 + 40;
  out += `<g transform="translate(${x},${y})"><svg x="0" y="0" width="${size}" height="${size * 1.45}" viewBox="0 0 100 145">${inner}</svg></g>`;
  out += `<text x="${c * CELL + 8}" y="${r * CELL + 20}" font-family="sans-serif" font-size="13" fill="#456">${id} s${st}</text>`;
}));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${out}</svg>`;
const outPath = process.argv[2] || '/tmp/focus/zoom.png';
await sharp(Buffer.from(svg)).png().toFile(outPath);
console.log('كُتبت:', outPath, W + 'x' + H);
