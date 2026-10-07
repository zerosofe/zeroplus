// Optional real-browser checks. See docs/achievement-forest.md for prerequisites.
// CDN dependencies are stubbed locally; this never contacts a production account.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
const root = path.resolve(import.meta.dirname, '..');
const base = process.env.FOREST_TEST_URL || 'http://localhost:8000';
const artifacts = process.env.FOREST_TEST_ARTIFACTS;
const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
const config = { window: { tailwind: {} }, tailwind: {} };
vm.runInNewContext(html.match(/<script>\s*\/\/ لو فشل تحميل CDN[\s\S]*?<\/script>/)[0].replace(/<\/?script>/g, ''), config);
const css = (await postcss([tailwind({ ...config.tailwind.config, content: [{ raw: html, extension: 'html' }] })])
  .process('@tailwind base;@tailwind components;@tailwind utilities;', { from: undefined })).css;
let launch = { headless: true };
if (process.env.FOREST_TEST_CHROMIUM === 'sparticuz') {
  const { default: bundled } = await import('@sparticuz/chromium');
  launch = { ...launch, executablePath: await bundled.executablePath(), args: bundled.args };
} else if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(launch);
const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', route => {
  const url = route.request().url();
  if (url.includes('cdn.tailwindcss.com')) return route.fulfill({ contentType: 'application/javascript', body: `const s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.append(s);` });
  if (!url.startsWith(base)) return route.fulfill({ status: 200, body: '' });
  return route.continue();
});
await page.addInitScript(() => {
  localStorage.setItem('zp_user_registered', 'true');
  localStorage.setItem('zp_device_id', 'forest-browser-test');
  localStorage.setItem('zp_theme', 'light');
});
const sizes = [
  ['small-phone', 320, 568], ['iphone', 390, 844], ['large-iphone', 430, 932],
  ['android', 360, 800], ['ipad-portrait', 768, 1024], ['ipad-landscape', 1024, 768],
  ['android-tablet', 800, 1280], ['desktop', 1440, 960],
];
const timings = [];
let scenes = 0;
try {
  await page.goto(base, { waitUntil: 'load' });
  // Unseen focus-tab assets must remain lazy. Home preview only needs its terrain.
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').filter(r => /assets\/forest\/(oak|pine)\.webp/.test(r.name)).length), 0);
  for (const [name, width, height] of sizes) {
    await page.setViewportSize({ width, height });
    for (const count of [0, 1, 6, 10, 30, 96, 300]) {
      const time = await page.evaluate(n => {
        userForest = [];
        userTrees = Array.from({ length: n }, (_, i) => ({ id: n - i, tree_type: TREE_SPECIES[i % TREE_SPECIES.length].id, duration: 25, sync: 'synced' }));
        showTab('pomodoro');
        const start = performance.now(); renderForest(); return performance.now() - start;
      }, count);
      timings.push(time);
      const scene = page.locator('#forest-scene');
      await scene.scrollIntoViewIfNeeded();
      await scene.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode().catch(() => {}))));
      const result = await page.evaluate(() => {
        const scene = document.querySelector('#forest-scene');
        const bounds = scene.querySelector('.forest-landscape').getBoundingClientRect();
        const images = [...scene.querySelectorAll('img')];
        return {
          count: document.querySelector('#forest-count-chip').innerText,
          plants: scene.querySelectorAll('.forest-plant').length,
          overflow: document.documentElement.scrollWidth > innerWidth,
          loaded: images.every(img => img.complete && img.naturalWidth > 0),
          cropped: [...scene.querySelectorAll('.forest-plant img')].some(img => {
            const r = img.getBoundingClientRect();
            return r.left < bounds.left - 1 || r.right > bounds.right + 1 || r.top < bounds.top - 1 || r.bottom > bounds.bottom + 1;
          }),
          animations: scene.getAnimations({ subtree: true }).filter(a => a.effect.getTiming().iterations === Infinity).length,
          terrain: scene.querySelector('.forest-terrain').currentSrc,
        };
      });
      assert.equal(result.count, `${count} شجرة`, name);
      assert.equal(result.plants, Math.min(count, 96), name);
      assert.equal(result.overflow, false, name + ' horizontal overflow');
      assert.equal(result.cropped, false, name + ' clipped canopy');
      assert.equal(result.loaded, true, name + ' broken assets');
      assert.equal(result.animations, 0, name + ' continuous animation');
      assert.match(result.terrain, width < 768 ? /meadow-640/ : /meadow-1280/);
      if (artifacts && ['iphone', 'desktop'].includes(name) && [0, 1, 30].includes(count)) {
        await fs.mkdir(artifacts, { recursive: true });
        await scene.screenshot({ path: path.join(artifacts, `${name}-${count}.png`) });
      }
      scenes++;
    }
  }
  // Identical state must retain nodes, not decode and rebuild imagery every update.
  assert.equal(await page.evaluate(() => {
    const before = document.querySelector('#forest-scene img'); renderForest();
    return before === document.querySelector('#forest-scene img');
  }), true);
  // Dark / reduced-motion presentation and loading, error, missing-service states.
  await page.evaluate(() => { document.documentElement.classList.add('dark'); forestState = 'loading'; renderForest(); });
  assert.equal(await page.locator('#forest-scene').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('#forest-scene-loading').isVisible(), true);
  await page.evaluate(() => { forestState = 'error'; forestError = describeCloudError(new Error('Supabase Auth table backend failure')); renderForest(); });
  assert.equal(await page.locator('#forest-retry-btn').isVisible(), true);
  await page.evaluate(() => { forestState = 'ready'; treesTableMissing = true; renderForest(); openTreeSetupModal(); });
  assert.equal(await page.locator('#tree-setup-modal').isVisible(), true);
  const visible = await page.locator('body').innerText();
  assert.doesNotMatch(visible, /supabase|\bbackend\b|\bdatabase\b|schema\.sql|SQL Editor/i);
  await page.evaluate(() => { closeTreeSetupModal(); treesTableMissing = false; showTab('home'); });
  assert.equal(await page.locator('#home-forest-preview .forest-plant').count(), 24);
  assert.match(await page.locator('#home-forest-preview').innerText(), /24 من 300/);
  await page.evaluate(() => showTab('pomodoro'));
  await page.locator('#forest-scene').scrollIntoViewIfNeeded();
  // A failed image never changes the count; the recovery control retries successfully.
  await page.evaluate(() => { document.querySelector('#forest-scene source').remove(); document.querySelector('#forest-scene .forest-terrain').src = 'assets/forest/missing-test.webp'; });
  await page.waitForFunction(() => document.querySelector('#forest-scene .forest-view').classList.contains('forest-image-error'));
  assert.equal(await page.locator('#forest-scene .forest-fallback').isVisible(), true);
  assert.equal(await page.locator('#forest-count-chip').innerText(), '300 شجرة');
  await page.evaluate(() => { const img = document.querySelector('#forest-scene .forest-terrain'); img.src = 'assets/forest/meadow-640.webp'; });
  await page.locator('#forest-scene .forest-fallback button').click();
  await page.waitForFunction(() => !document.querySelector('#forest-scene .forest-view').classList.contains('forest-image-error'));
  assert.deepEqual(errors, [], 'Uncaught browser errors');
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ scenes, viewports: sizes.length, uncaughtErrors: errors.length, renderP95Ms: timings[Math.floor(timings.length * .95)], renderMaxMs: timings.at(-1), checks: 'counts, full image bounds, no page overflow, asset decode, responsive source, dark/reduced motion, no continuous animation, stable nodes, loading/retry/help, home preview, safe UI wording, image recovery' }, null, 2));
} finally { await context.close(); await browser.close(); }

// The existing service worker (unchanged) caches newly viewed forest images.
// Check the real fetch/cache path rather than claiming PWA support from a mock alone.
const offlineBrowser = await chromium.launch(launch);
const offlineContext = await offlineBrowser.newContext({ serviceWorkers: 'allow' });
try {
  await offlineContext.route('**/*', route => route.request().url().startsWith(base)
    ? route.continue() : route.fulfill({ status: 200, body: '' }));
  const offlinePage = await offlineContext.newPage();
  await offlinePage.goto(base, { waitUntil: 'load' });
  await offlinePage.waitForFunction(() => !!navigator.serviceWorker.controller);
  const assets = ['/assets/forest/oak.webp', '/assets/forest/meadow-640.webp', '/assets/forest/pine-thumb.webp'];
  await offlinePage.evaluate(async paths => {
    for (const url of paths) { const response = await fetch(url); if (!response.ok) throw new Error('Online asset failed: ' + url); await response.arrayBuffer(); }
  }, assets);
  await offlinePage.waitForFunction(async paths => (await Promise.all(paths.map(url => caches.match(url)))).every(Boolean), assets);
  await offlineContext.setOffline(true);
  const cached = await offlinePage.evaluate(async paths => Promise.all(paths.map(async url => {
    const response = await fetch(url); return response.ok && (await response.arrayBuffer()).byteLength > 0;
  })), assets);
  assert.ok(cached.every(Boolean), 'Viewed forest assets unavailable offline');
  console.log('PWA: terrain, full tree, and thumbnail fetched successfully offline through the existing service worker.');
} finally { await offlineContext.close(); await offlineBrowser.close(); }
