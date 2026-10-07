// Optional real-browser checks for the tile-based Achievement Forest.
// See docs/achievement-forest.md for prerequisites.
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
  // The forest is inline SVG: no image downloads, ever.
  assert.equal(await page.evaluate(() => document.querySelectorAll('#forest-scene img, #home-forest-preview img').length), 0);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#forest-art-defs symbol').length), 12);
  for (const [name, width, height] of sizes) {
    await page.setViewportSize({ width, height });
    for (const count of [0, 1, 5, 15, 16, 17, 32, 33, 96]) {
      const time = await page.evaluate(n => {
        userForest = [];
        userTrees = Array.from({ length: n }, (_, i) => ({ id: n - i, tree_type: TREE_SPECIES[i % TREE_SPECIES.length].id, duration: 25, sync: 'synced' }));
        showTab('pomodoro');
        const start = performance.now(); renderForest(); return performance.now() - start;
      }, count);
      timings.push(time);
      const scene = page.locator('#forest-scene');
      await scene.scrollIntoViewIfNeeded();
      const result = await page.evaluate(() => {
        const scene = document.querySelector('#forest-scene');
        const tiles = [...scene.querySelectorAll('.forest-tile')];
        const slots = [...scene.querySelectorAll('.tile-slot')];
        return {
          count: document.querySelector('#forest-count-chip').innerText,
          tiles: tiles.length,
          filled: scene.querySelectorAll('.tile-slot.is-filled').length,
          empty: scene.querySelectorAll('.tile-slot.is-empty').length,
          complete: scene.querySelectorAll('.forest-tile.is-complete').length,
          progress: document.querySelector('#forest-progress-title').innerText,
          overflow: document.documentElement.scrollWidth > innerWidth,
          escaped: slots.some(slot => {
            const tile = slot.closest('.forest-tile').getBoundingClientRect();
            const r = slot.getBoundingClientRect();
            return r.left < tile.left - 1 || r.right > tile.right + 1 || r.top < tile.top - 1 || r.bottom > tile.bottom + 1;
          }),
          treeOverflow: [...scene.querySelectorAll('.tile-slot.is-filled svg')].some(svg => {
            const slot = svg.closest('.tile-slot').getBoundingClientRect();
            const r = svg.getBoundingClientRect();
            return r.left < slot.left - 1 || r.right > slot.right + 1 || r.top < slot.top - 1 || r.bottom > slot.bottom + 1;
          }),
          animations: scene.getAnimations({ subtree: true }).filter(a => a.effect.getTiming().iterations === Infinity).length,
          usesResolve: [...scene.querySelectorAll('use')].every(use => document.getElementById(use.getAttribute('href').slice(1))),
        };
      });
      const tiles = Math.max(1, Math.ceil(count / 16));
      const cur = count === 0 ? 0 : (count % 16 === 0 ? 16 : count % 16);
      assert.equal(result.count, `${count} شجرة`, name);
      assert.equal(result.tiles, tiles, name + ' tile count');
      assert.equal(result.filled, count, name + ' filled slots');
      assert.equal(result.empty, tiles * 16 - count, name + ' empty slots');
      assert.equal(result.complete, Math.floor(count / 16), name + ' complete tiles');
      assert.equal(result.progress, `المربع الحالي: ${cur} / 16`, name + ' progress');
      assert.equal(result.overflow, false, name + ' horizontal overflow');
      assert.equal(result.escaped, false, name + ' slot outside tile');
      assert.equal(result.treeOverflow, false, name + ' tree outside slot');
      assert.equal(result.animations, 0, name + ' continuous animation');
      assert.equal(result.usesResolve, true, name + ' unresolved tree art');
      if (artifacts && ['iphone', 'desktop'].includes(name) && [0, 1, 17].includes(count)) {
        await fs.mkdir(artifacts, { recursive: true });
        await scene.screenshot({ path: path.join(artifacts, `${name}-${count}.png`) });
      }
      scenes++;
    }
  }
  // Identical state must retain nodes, not rebuild the tiles on every update.
  assert.equal(await page.evaluate(() => {
    const before = document.querySelector('#forest-scene .forest-tile'); renderForest();
    return before === document.querySelector('#forest-scene .forest-tile');
  }), true);
  // Sequential placement survives the real DOM: oldest first, tile 2 opens at 17.
  await page.evaluate(() => {
    userForest = [];
    userTrees = Array.from({ length: 17 }, (_, i) => ({ id: 17 - i, tree_type: 'oak', duration: 25, sync: 'synced' }));
    renderForest();
  });
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#forest-scene .tile-slot.is-filled')].map(s => s.getAttribute('data-tree'))),
    Array.from({ length: 17 }, (_, i) => String(i + 1)));
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
  await page.evaluate(() => {
    closeTreeSetupModal(); treesTableMissing = false;
    userTrees = Array.from({ length: 33 }, (_, i) => ({ id: 33 - i, tree_type: 'pine', duration: 25, sync: 'synced' }));
    renderForest(); showTab('home');
  });
  assert.equal(await page.locator('#home-forest-preview .forest-tile-wrap').count(), 1);
  assert.equal(await page.locator('#home-forest-preview .tile-slot.is-filled').count(), 1);
  assert.match(await page.locator('#home-forest-preview').innerText(), /غابتك تضم 33 شجرة/);
  await page.evaluate(() => showTab('pomodoro'));
  await page.locator('#forest-scene').scrollIntoViewIfNeeded();
  assert.deepEqual(errors, [], 'Uncaught browser errors');
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ scenes, viewports: sizes.length, uncaughtErrors: errors.length, renderP95Ms: timings[Math.floor(timings.length * .95)], renderMaxMs: timings.at(-1), checks: 'tile/slot counts, sequential placement, progress, no page overflow, slots and trees inside bounds, no image requests, shared svg defs, dark/reduced motion, no continuous animation, stable nodes, loading/retry/help, home preview, safe UI wording' }, null, 2));
} finally { await context.close(); await browser.close(); }

// The existing service worker (unchanged apart from the version bump) serves the app shell offline.
// Check the real fetch/cache path rather than claiming PWA support from a mock alone.
const offlineBrowser = await chromium.launch(launch);
const offlineContext = await offlineBrowser.newContext({ serviceWorkers: 'allow' });
try {
  await offlineContext.route('**/*', route => route.request().url().startsWith(base)
    ? route.continue() : route.fulfill({ status: 200, body: '' }));
  const offlinePage = await offlineContext.newPage();
  await offlinePage.goto(base, { waitUntil: 'load' });
  await offlinePage.waitForFunction(() => !!navigator.serviceWorker.controller);
  await offlinePage.evaluate(async () => {
    const response = await fetch('/index.html');
    if (!response.ok) throw new Error('Online shell failed');
    await response.text();
  });
  await offlinePage.waitForFunction(async () => !!(await caches.match('/index.html')));
  await offlineContext.setOffline(true);
  const cached = await offlinePage.evaluate(async () => {
    const response = await fetch('/index.html');
    return response.ok && (await response.text()).length > 0;
  });
  assert.ok(cached, 'App shell unavailable offline');
  console.log('PWA: app shell (including the inline-SVG forest) served successfully offline through the existing service worker.');
} finally { await offlineContext.close(); await offlineBrowser.close(); }
