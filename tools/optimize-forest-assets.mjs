// One-off asset preparation; source renders stay outside the repository.
// Usage: node tools/optimize-forest-assets.mjs /path/to/source-renders
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const source = process.argv[2];
if (!source) throw new Error('Pass the directory containing source PNGs.');
const dest = new URL('../assets/forest/', import.meta.url);
await fs.mkdir(dest, { recursive: true });
const species = ['oak', 'pine', 'palm', 'cypress', 'olive', 'willow', 'maple', 'euca', 'cedar'];
for (const name of species) {
  const { data, info } = await sharp(path.join(source, name + '.png')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = Buffer.alloc(info.width * info.height * 4);
  let left = info.width, top = info.height, right = 0, bottom = 0;
  for (let p = 0; p < info.width * info.height; p++) {
    const rgb = [data[p * 3], data[p * 3 + 1], data[p * 3 + 2]];
    // Matte against the neutral white studio background, including canopy gaps.
    const alpha = Math.max(0, Math.min(1, (245 - Math.min(...rgb)) / 60));
    for (let c = 0; c < 3; c++) rgba[p * 4 + c] = alpha ? Math.max(0, Math.min(255, (rgb[c] - 255 * (1 - alpha)) / alpha)) : 0;
    rgba[p * 4 + 3] = Math.round(alpha * 255);
    if (alpha > 0.15) {
      const x = p % info.width, y = Math.floor(p / info.width);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  const cutout = await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
    .resize(384, 512, { fit: 'contain', position: 'bottom', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  await sharp(cutout).webp({ quality: 78, alphaQuality: 85, effort: 6 }).toFile(fileURLToPath(new URL(name + '.webp', dest)));
  await sharp(cutout).resize(96, 128).webp({ quality: 75, alphaQuality: 80 }).toFile(fileURLToPath(new URL(name + '-thumb.webp', dest)));
}
for (const width of [640, 1280]) {
  await sharp(path.join(source, 'meadow.png')).resize(width).webp({ quality: 78, effort: 6 }).toFile(fileURLToPath(new URL('meadow-' + width + '.webp', dest)));
}
console.log('Optimized nine tree cutouts, thumbnails, and two responsive terrain plates.');
