// Deterministic fixtures exist only in tests. No production or account data is written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, clearHarnessTimers, ROOT } from './harness.mjs';
const { sandbox: app, nodes } = createHarness();
const forbidden = /supabase|\bsupa\b|\bdatabase\b|\btable\b|\bstorage\b|\bauth\b|\bbackend\b|schema\.sql|SQL Editor|\bRLS\b/i;
const fixture = n => Array.from({ length: n }, (_, i) => ({ id: n - i, tree_type: ['oak', 'pine', 'olive', 'palm'][i % 4], duration: 25, sync: 'synced' }));
let checks = 0;
try {
  for (const n of [0, 1, 6, 10, 30, 96, 300, 1000]) {
    app.__api.userTrees = fixture(n); app.__api.userForest = [];
    app.renderForest();
    const main = nodes.get('forest-scene').innerHTML;
    const home = nodes.get('home-forest-preview').innerHTML;
    assert.equal((main.match(/class="forest-plant"/g) || []).length, Math.min(n, 96));
    assert.equal((home.match(/class="forest-plant"/g) || []).length, Math.min(n, 24));
    assert.equal(nodes.get('forest-count-chip').innerText, `${n} شجرة`);
    assert.equal(app.displayForest().length, n);
    assert.match(main, new RegExp('غابة إنجازك: ' + n + ' شجرة'));
    assert.doesNotMatch(main + home, /<svg|<canvas|tree-sway|tree-grow/);
    if (!n) assert.match(main, /هنا تبدأ غابتك/);
    if (n > 96) assert.match(main, new RegExp('يظهر 96 من ' + n));
    const positions = app.forestLayout(app.displayForest(), 96);
    for (const p of positions) {
      assert.ok(p.x >= 15 && p.x <= 85);
      assert.ok(p.bottom >= 10 && p.bottom + p.height < 96, 'Canopy must stay below scene top');
    }
    const firstMarkup = nodes.get('forest-scene').innerHTML;
    app.renderForest();
    assert.equal(nodes.get('forest-scene').innerHTML, firstMarkup, 'No random repositioning');
    checks++;
  }
  // Same achievement represented by a legacy session and tree remains one tree.
  app.__api.userTrees = fixture(1);
  app.__api.userForest = [{ id: 1, mins: 25 }, { id: 2, mins: 15 }];
  app.renderForest();
  assert.equal(app.displayForest().length, 2);
  assert.equal(nodes.get('forest-count-chip').innerText, '2 شجرة'); checks++;

  const before = app.forestLayout(fixture(6), 96);
  const after = app.forestLayout([{ id: 7, tree_type: 'oak' }, ...fixture(6)], 96);
  before.forEach(p => {
    const same = after.find(q => q.tree.id === p.tree.id);
    assert.equal(same.x, p.x); assert.equal(same.bottom, p.bottom);
  }); checks++;

  for (const name of ['oak', 'pine', 'palm', 'cypress', 'olive', 'willow', 'maple', 'euca', 'cedar', 'blossom', 'ginkgo', 'baobab', '<bad>']) {
    const image = app.treeImage(name, { title: '"><script>unsafe</script>' });
    assert.doesNotMatch(image, /<script>/);
    for (const src of image.matchAll(/src="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(ROOT, src[1])));
  } checks++;

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
  app.navigator.onLine = false; app.updateForestSyncUI();
  assert.match(nodes.get('forest-sync-text').innerText, /على جهازك/);
  assert.doesNotMatch(nodes.get('forest-sync-text').innerText, forbidden); checks++;

  // Static text and accessible attributes across every shipped HTML page.
  for (const file of fs.readdirSync(ROOT).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
    const text = html.replace(/<[^>]*>/g, ' ');
    assert.doesNotMatch(text, forbidden, file);
    for (const m of html.matchAll(/(?:title|aria-label|placeholder)="([^"]*)"/g)) assert.doesNotMatch(m[1], forbidden, file);
  } checks++;

  const files = fs.readdirSync(path.join(ROOT, 'assets/forest')).filter(f => f.endsWith('.webp'));
  const bytes = files.reduce((sum, file) => sum + fs.statSync(path.join(ROOT, 'assets/forest', file)).size, 0);
  assert.equal(files.length, 20); assert.ok(bytes < 1_000_000, `Asset budget exceeded: ${bytes}`); checks++;
  console.log(`Forest: ${checks} scenario groups passed; ${files.length} assets, ${bytes.toLocaleString()} bytes total.`);
} finally { clearHarnessTimers(); }
