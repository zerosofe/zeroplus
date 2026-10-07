// Tile-based Achievement Forest: counts, sequential placement, tile math, safe wording.
// Deterministic fixtures exist only in tests. No production or account data is written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, clearHarnessTimers, ROOT } from './harness.mjs';
const { sandbox: app, nodes } = createHarness();
const forbidden = /supabase|\bsupa\b|\bdatabase\b|\btable\b|\bstorage\b|\bauth\b|\bbackend\b|schema\.sql|SQL Editor|\bRLS\b/i;
const speciesCycle = ['oak', 'pine', 'olive', 'palm', 'blossom', 'maple', 'cedar', 'willow', 'cypress', 'euca', 'ginkgo', 'baobab'];
const fixture = n => Array.from({ length: n }, (_, i) => ({ id: n - i, tree_type: speciesCycle[i % speciesCycle.length], duration: 25, sync: 'synced' }));
const currentFilledFor = n => (n === 0 ? 0 : (n % 16 === 0 ? 16 : n % 16));
let checks = 0;
try {
  // 1) Tile math: one tile per 16 sessions, sequential oldest-first placement.
  const cases = [
    [0, 1, 0, 0, 16], [1, 1, 1, 1, 15], [5, 1, 5, 5, 11], [15, 1, 15, 15, 1],
    [16, 1, 16, 16, 0], [17, 2, 17, 1, 15], [31, 2, 31, 15, 1], [32, 2, 32, 16, 0],
    [33, 3, 33, 1, 15], [96, 6, 96, 16, 0], [100, 7, 100, 4, 12], [1000, 63, 1000, 8, 8],
  ];
  for (const [n, tiles, total, cur, rem] of cases) {
    const plan = app.forestTilePlan(fixture(n));
    assert.equal(plan.total, total, `total for ${n}`);
    assert.equal(plan.tileCount, tiles, `tileCount for ${n}`);
    assert.equal(plan.currentFilled, cur, `currentFilled for ${n}`);
    assert.equal(plan.remaining, rem, `remaining for ${n}`);
    assert.equal(plan.tiles.length, tiles);
    assert.equal(plan.current.number, tiles);
    assert.equal(plan.tiles.filter(t => t.isFull).length, Math.floor(n / 16), `full tiles for ${n}`);
    const ordered = fixture(n).map(t => t.id).sort((a, b) => a - b);
    plan.tiles.forEach((tile, ti) => tile.slots.forEach((tree, si) => {
      const expect = ordered[ti * 16 + si];
      assert.equal(tree ? tree.id : null, expect === undefined ? null : expect, `tile ${ti + 1} slot ${si + 1} for ${n}`);
    }));
    checks++;
  }

  // 2) Rendered scene: exact slot counts, progress UI, stability, no image dependencies.
  for (const n of [0, 1, 5, 15, 16, 17, 32, 33]) {
    app.__api.userTrees = fixture(n); app.__api.userForest = [];
    app.renderForest();
    const main = nodes.get('forest-scene').innerHTML;
    const tiles = Math.max(1, Math.ceil(n / 16));
    assert.equal((main.match(/class="forest-tile-wrap/g) || []).length, tiles, `tiles for ${n}`);
    assert.equal((main.match(/tile-slot is-filled/g) || []).length, n, `filled for ${n}`);
    assert.equal((main.match(/tile-slot is-empty/g) || []).length, tiles * 16 - n, `empty for ${n}`);
    assert.equal((main.match(/<svg/g) || []).length, n, `svg count for ${n}`);
    assert.equal((main.match(/class="forest-tile is-complete/g) || []).length, Math.floor(n / 16), `complete for ${n}`);
    assert.equal(nodes.get('forest-count-chip').innerText, `${n} شجرة`);
    assert.equal(app.displayForest().length, n);
    assert.match(main, new RegExp('غابة إنجازك: ' + n + ' شجرة'));
    assert.doesNotMatch(main, /\.webp|assets\/forest|<img|<canvas|<picture/);
    assert.doesNotMatch(main, /forest-plant|forest-landscape|forest-terrain/);
    if (!n) assert.match(main, /هنا تبدأ غابتك/);
    if (n === 16) assert.match(main, /✓ مكتمل/);
    // Progress block mirrors the same plan.
    const cur = currentFilledFor(n);
    assert.equal(nodes.get('forest-progress-title').innerText, `المربع الحالي: ${cur} / 16`);
    assert.equal(nodes.get('forest-progress-bar').getAttribute('aria-valuenow'), String(cur));
    assert.equal(nodes.get('forest-progress-fill').style.width, Math.round((cur / 16) * 100) + '%');
    if (!n) assert.match(nodes.get('forest-progress-hint').innerText, /شجرتك الأولى/);
    if (n === 15) assert.match(nodes.get('forest-progress-hint').innerText, /جلسة واحدة متبقية/);
    if (n === 16) assert.match(nodes.get('forest-progress-hint').innerText, /مربع مكتمل/);
    if (n === 5) assert.match(nodes.get('forest-progress-hint').innerText, /11 جلسة متبقية/);
    // Identical state keeps the exact DOM (no random reshuffling, no rebuild).
    const firstMarkup = nodes.get('forest-scene').innerHTML;
    app.renderForest();
    assert.equal(nodes.get('forest-scene').innerHTML, firstMarkup, 'No random repositioning');
    checks++;
  }

  // 3) Rendered placement: oldest tree in tile 1 slot 1, tree 17 opens tile 2.
  app.__api.userTrees = fixture(17); app.__api.userForest = [];
  app.renderForest();
  const placed17 = nodes.get('forest-scene').innerHTML;
  assert.deepEqual([...placed17.matchAll(/data-tree="(\d+)"/g)].map(m => Number(m[1])),
    Array.from({ length: 17 }, (_, i) => i + 1));
  assert.match(placed17, /data-tile="1" data-slot="1" data-tree="1"/);
  assert.match(placed17, /data-tile="1" data-slot="16" data-tree="16"/);
  assert.match(placed17, /data-tile="2" data-slot="1" data-tree="17"/);
  checks++;

  // 4) Home preview shows the current tile only and stays tiny.
  for (const n of [0, 1, 17, 33, 300]) {
    app.__api.userTrees = fixture(n); app.__api.userForest = [];
    app.renderForest();
    const home = nodes.get('home-forest-preview').innerHTML;
    assert.equal((home.match(/class="forest-tile-wrap/g) || []).length, 1, `preview tiles for ${n}`);
    assert.equal((home.match(/tile-slot is-filled/g) || []).length, currentFilledFor(n), `preview filled for ${n}`);
    assert.equal((home.match(/<svg/g) || []).length, currentFilledFor(n), `preview svg for ${n}`);
    assert.doesNotMatch(home, /\.webp|assets\/forest|<img/);
    if (n) assert.match(home, new RegExp('غابتك تضم ' + n + ' شجرة'));
    checks++;
  }

  // 5) Same achievement as legacy session + tree stays one tree.
  app.__api.userTrees = fixture(1);
  app.__api.userForest = [{ id: 1, mins: 25 }, { id: 2, mins: 15 }];
  app.renderForest();
  assert.equal(app.displayForest().length, 2);
  assert.equal(nodes.get('forest-count-chip').innerText, '2 شجرة');
  assert.equal((nodes.get('forest-scene').innerHTML.match(/tile-slot is-filled/g) || []).length, 2);
  checks++;

  // 6) Planting celebrates exactly the new tree (and the new tile when one opens).
  app.__api.userTrees = []; app.__api.userForest = [];
  app.renderForest();
  assert.doesNotMatch(nodes.get('forest-scene').innerHTML, /is-new/);
  const first = app.plantTreeForSession({ id: 9001, mins: 25 });
  assert.ok(first && first.tree_type, 'planting must return the new tree');
  const planted = nodes.get('forest-scene').innerHTML;
  assert.equal((planted.match(/tile-slot is-filled is-new/g) || []).length, 1);
  assert.match(planted, /data-tree="9001"/);
  assert.doesNotMatch(planted, /forest-tile-wrap is-new/, 'first tree must not claim a new tile');
  app.__api.userTrees = fixture(16); app.__api.userForest = [];
  app.plantTreeForSession({ id: 9017, mins: 25 });
  const opened = nodes.get('forest-scene').innerHTML;
  assert.equal((opened.match(/forest-tile-wrap is-new/g) || []).length, 1);
  assert.match(opened, /data-tile="2" data-slot="1" data-tree="9017"/);
  checks++;

  // 7) Every species has original SVG art; titles are escaped; defs stay small and offline-safe.
  const artIds = ['oak', 'pine', 'palm', 'cypress', 'olive', 'willow', 'maple', 'euca', 'cedar', 'blossom', 'ginkgo', 'baobab'];
  const defs = app.forestArtDefs();
  assert.equal(artIds.length, 12);
  for (const id of artIds) assert.match(defs, new RegExp('id="zp-tree-' + id + '"'));
  assert.ok(defs.length < 60000, `Art defs too large: ${defs.length}`);
  assert.doesNotMatch(defs, forbidden);
  for (const name of [...artIds, 'nope', '<bad>']) {
    const image = app.treeImage(name, { title: '"><script>unsafe</script>' });
    assert.doesNotMatch(image, /<script>/);
    assert.match(image, /<svg[^>]*><title>[^<]*<\/title><use href="#zp-tree-[a-z]+"/);
    assert.doesNotMatch(image, /\.webp|assets\/forest|<img/);
  }
  assert.match(app.treeImage('blossom', {}), /#zp-tree-blossom/);
  assert.match(app.treeImage('baobab', {}), /#zp-tree-baobab/);
  assert.match(nodes.get('forest-art-defs').innerHTML, /id="zp-tree-oak"/, 'defs must be injected for <use>');
  // Slot variation is deterministic and never leaves the slot.
  const v1 = app.treeSlotVariation({ id: 42 }, 3);
  assert.equal(v1, app.treeSlotVariation({ id: 42 }, 3));
  assert.match(v1, /scale\(0\.9[3-9]|scale\(1\.00\)/);
  checks++;

  // 8) Safe consumer wording across errors, badges, and sync states.
  for (const error of [
    { message: 'Supabase Auth backend unavailable' },
    { message: 'permission denied for table trees', code: '42501' },
    { message: 'relation public.trees does not exist', code: '42P01' },
    { message: 'Storage database schema cache', code: 'PGRST204' },
    new Error('Supabase failed to fetch'),
  ]) {
    assert.doesNotMatch(app.describeCloudError(error), forbidden);
    assert.match(app.describeCloudError(error), /المحاولة|الدعم/);
    app.recordRuntimeIssue(error, 'Supabase Auth', { silent: true });
    assert.doesNotMatch(app.buildDiagnostics(), forbidden);
  }
  for (const status of ['synced', 'pending', 'failed', 'local', 'legacy']) {
    assert.doesNotMatch(app.treeSyncBadge(status).replace(/class="[^"]*"/g, ''), forbidden);
  }
  app.__api.userTrees = fixture(20); app.__api.userForest = [];
  app.renderForest();
  assert.doesNotMatch(nodes.get('forest-scene').innerHTML.replace(/class="[^"]*"/g, ''), forbidden);
  app.navigator.onLine = false; app.updateForestSyncUI();
  assert.match(nodes.get('forest-sync-text').innerText, /على جهازك/);
  assert.doesNotMatch(nodes.get('forest-sync-text').innerText, forbidden);
  checks++;

  // 9) Static text and accessible attributes across every shipped HTML page.
  for (const file of fs.readdirSync(ROOT).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
    const text = html.replace(/<[^>]*>/g, ' ');
    assert.doesNotMatch(text, forbidden, file);
    for (const m of html.matchAll(/(?:title|aria-label|placeholder)="([^"]*)"/g)) assert.doesNotMatch(m[1], forbidden, file);
  }
  checks++;

  // 10) No photorealistic asset pipeline remains; the forest is code, not downloads.
  const inline = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.doesNotMatch(inline, /assets\/forest\//);
  assert.doesNotMatch(inline, /meadow-|forest-plant|retryForestImages|forestLayout|renderNaturalForest|treeAssetName/);
  const forestDir = path.join(ROOT, 'assets', 'forest');
  const leftovers = fs.existsSync(forestDir) ? fs.readdirSync(forestDir).filter(f => f.endsWith('.webp')) : [];
  assert.equal(leftovers.length, 0, 'Old photorealistic webp assets must be removed');
  checks++;

  console.log(`Forest tiles: ${checks} scenario groups passed; 12 SVG species, ${defs.length.toLocaleString()} bytes of inline art, 0 image requests.`);
} finally { clearHarnessTimers(); }
