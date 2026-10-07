# Achievement Forest redesign — tile-based productivity forest

Date: 2026-10-07 (v38)

## COMPLETED

- Replaced the photorealistic layered-image forest with a **tile-based productivity forest**:
  square land tiles, each a fixed **4×4 grid = 16 planting slots**.
- **One completed focus session = exactly one tree**, planted sequentially in the first
  available empty slot. When a tile fills up, a new tile opens automatically.
- Created an **original 12-species SVG tree art system** (oak, pine, palm, cypress, olive,
  willow, maple, eucalyptus, cedar, blossom, ginkgo, baobab) in one unified stylized
  direction: trunk + branches + foliage/flowers, colorful and charming, no photos,
  no emojis, no 3D engine.
- Tiles connect visually into one growing forest via a responsive grid; full tiles get a
  subtle completion state (richer grass + soft gold ring + «✓ مكتمل» badge).
- Empty slots are soil patches with a seed dot — part of the land, not white cards.
- New-tile and new-tree planting animations are short, one-shot, and disabled under
  `prefers-reduced-motion` by the existing global rule.
- Added natural progress UI: «المربع الحالي: س / 16» + remaining-sessions hint
  («4 جلسات متبقية لإكمال المربع») + progress bar + «غابتك تضم N شجرة».
- Deleted the 20 photorealistic WebP assets (~906 KB) and the obsolete WebP
  optimization tool. The forest is now **~8.5 KB of inline SVG, zero image requests**,
  and renders instantly offline.
- Preserved everything else: focus timer, Pomodoro/background sessions, tasks,
  achievements, auth, navigation, design system, database schema, and all
  local + Supabase persistence paths. No schema change was needed.
- Removed the last user-visible-adjacent backend reference (an HTML comment naming
  the backend) and the word «database» from rendered output (icon class swap).
  The UI only ever says things like «كل شجرة محفوظة في حسابك».

## FOREST SYSTEM

`forestTilePlan(trees)` is the single source of tile math (pure function, fully tested):

- Input: the existing `displayForest()` records (real `userTrees` + legacy `userForest`
  sessions, deduplicated by id — unchanged).
- Trees are ordered chronologically (oldest first), then dealt sequentially:
  tree *i* → tile `floor(i / 16)`, slot `(i % 16)`.
- `tileCount = max(1, ceil(total / 16))` — zero sessions still show one empty tile.
- Output: per-tile `{ number, slots[16], filled, isFull, isCurrent }` plus
  `total`, `currentFilled`, and `remaining` for the progress UI.

Rendering (`renderForestTiles`, same signature-skip optimization as before):

- Main scene renders **all tiles** (no truncated sample, no fake counts).
- Home preview renders the **current tile only** (≤ 16 slots — always tiny).
- Record grid (recent 60), species catalog, and the newly-planted card reuse the same
  SVG art via `treeImage()`, so every surface shows identical trees.

## TREE SYSTEM

The existing flow is untouched and remains the source of truth:

1. A completed focus session is recorded by `finishPomoSession()`.
2. `plantTreeForSession()` picks a species with the existing duration/rarity logic
   (no consecutive repeats) and stores one record (same id as the session).
3. The existing local-storage, cloud-write, and retry-queue paths persist it.
4. The tile layer consumes `displayForest()` without writing or inventing records.

Because tree records share the session id, refresh / re-login / multi-device flows
deduplicate to exactly one tree per session — verified by the existing regression
tests (46–50, 55–56) plus the new tile tests.

## TILE PROGRESSION

| Sessions | Tiles | Current tile |
| --- | --- | --- |
| 0 | 1 (empty) | 0 / 16 |
| 1 | 1 | 1 / 16 |
| 15 | 1 | 15 / 16 |
| 16 | 1 (complete) | 16 / 16 |
| 17 | 2 | 1 / 16 (tree 17 in tile 2, slot 1) |
| 32 | 2 (both complete) | 16 / 16 |
| 33 | 3 | 1 / 16 |

…and so on indefinitely. Tile *n* is full exactly when it holds 16 trees; the next
session always creates tile *n+1* automatically. Verified for 0–1000 sessions.

## TREE VISUAL STYLE

- 12 hand-authored vector symbols (`FOREST_TREE_ART`), each on a shared 64×80 grid:
  ground shadow, tapered two-tone trunk, visible branches, layered canopy blobs with
  highlights, plus species details (palm fronds + coconuts, blossom petals, golden
  ginkgo fan, baobab trunk, cedar tiers, willow strands, maple autumn tones…).
- Defined **once** in a hidden `<svg><defs>` block (`ensureForestArt()`), then
  instantiated with `<svg><use href="#zp-tree-…"/></svg>` — roughly one DOM element
  per tree, no downloads, no decoding, no canvas, no WebGL.
- Controlled per-tree variation via a deterministic id hash (`treeSlotVariation`):
  scale 0.93–1.00 and ±3% horizontal offset — always inside the slot, never
  overlapping, stable across re-renders.
- Dark-mode grass palette overrides keep tiles readable in both themes.

## FILES MODIFIED

| File | Changes |
| --- | --- |
| `index.html` | Forest CSS → tile system; progress block + art-defs host in the forest card; backend-wording comment cleanup; `treeImage()` → SVG `<use>`; new `FOREST_TREE_ART` / `forestArtDefs()` / `ensureForestArt()`; new `forestTilePlan()` / `renderForestTiles()` / `renderForestTile()` / `renderForestProgress()`; preview + scene + progress wiring; `fa-database` → `fa-history` badge icon; version v37 → v38. |
| `sw.js` | Cache version v37 → v38 (drops stale cached WebP, keeps CDN strategy). |
| `README.md` | Forest bullet now describes the 4×4 tile system. |
| `docs/achievement-forest.md` | This report (replaces the photorealistic-scene report). |
| `tests/forest-rendering.mjs` | Rewritten for tiles: math, sequential placement, slot counts, progress UI, celebration, art/escaping, safe wording, no-image assertions. |
| `tests/forest-browser.mjs` | Rewritten for tiles: viewport matrix, bounds checks (slots in tiles, trees in slots), shared defs, stable nodes, states, preview, safe wording, app-shell offline check. |

## FILES ADDED

None. The redesign reuses the existing single-file app structure.

## FILES DELETED

| File | Reason |
| --- | --- |
| `assets/forest/*.webp` (20 files) | Photorealistic system replaced by inline SVG; also removes ~906 KB. |
| `tools/optimize-forest-assets.mjs` | Obsolete WebP pipeline for the deleted assets. |

## SUPABASE UI CLEANUP

- Searched the repo for `Supabase`, `supa`, `database`, `table`, `Storage`, `Auth`,
  `backend` (plus `schema.sql`, `SQL Editor`, `RLS` in tests).
- User-facing surfaces (static copy, aria-labels, titles, placeholders, captions,
  progress hints, sync states, badges, error messages, diagnostics, support flow)
  contain none of these terms — enforced by automated tests on every HTML page and
  every rendered forest string.
- Backend code (client init, queries, schema, env, sync queue, service worker
  exclusions) is untouched; only visible wording was cleaned.
- Consumer wording examples: «كل شجرة محفوظة في حسابك»،
  «أشجارك محفوظة على جهازك — ستتم مزامنتها عند الاتصال بحسابك»،
  «نحمّل غابتك من حسابك...».

## PERFORMANCE

- Zero image requests for the forest (was: up to 96 full + terrain + thumbnails).
- ~8.5 KB of inline SVG art total, defined once and shared via `<use>`.
- Each tree ≈ 3 spans + 1 svg + 1 use; each empty slot = 1 span with CSS-only soil.
  A 300-tree forest is ~3,000 light nodes with no decode cost.
- Signature check (`data-forest-key`) skips DOM rebuilds when achievements are
  unchanged; one-shot animations only (no loops, no `requestAnimationFrame`).
- Realistic data is already bounded by existing storage limits (300 local trees,
  200 cloud rows per load + pending local + legacy sessions).

## TESTING

### Results

| Check | Result |
| --- | --- |
| Existing regression suite | **66 / 66 passed** (auth, sync, offline queue, sessions, tree writes/loading/dedup, recovery, deletion, navigation, achievements, SW, PWA, design system — all untouched behavior intact). |
| New forest tile suite | **32 scenario groups passed**: tile math for 0–1000 sessions; exact tile/slot/complete counts for 0,1,5,15,16,17,32,33; sequential placement incl. tree 17 → tile 2 slot 1; current-tile-only preview (0,1,17,33,300); legacy dedup; one-shot planting + new-tile celebration; 12 SVG arts + escaping + <8.5 KB defs; deterministic in-slot variation; safe-wording + static HTML audit; zero `assets/forest` references; old WebP gone. |
| Art inspection | All 12 species + full/partial tile compositions rendered to PNG and visually reviewed: unified stylized direction, no overlaps, soil patches read as planting areas. |
| Patch hygiene | `git diff --check` passed. No database/schema changes. |

Viewport coverage for the tile layout (browser matrix) is implemented in
`tests/forest-browser.mjs` for 8 sizes (320×568 → 1440×960); it requires a local
server + Playwright browser and was not executed in this sandbox (no browser
available). Layout rules are standard CSS grid with no viewport-dependent JS.

### Run the tests

```sh
npm test

# Optional DOM smoke test
npm install --no-save jsdom
npm run test:smoke

# Optional browser checks, using a locally installed Playwright browser
npm install --no-save playwright tailwindcss@3 postcss
npx playwright install chromium
# In another terminal, serve the existing application:
python -m http.server 8000 --bind 0.0.0.0
npm run test:forest:browser
```

## REMAINING LIMITATIONS

1. Very large forests (hundreds of tiles) render all tiles on one scrolling page;
   each tree is a few light SVG nodes, but no windowing/virtualization was added
   since real data is bounded by existing storage limits (~hundreds of trees).
2. No seed-to-mature growth stages: a planted tree appears at full charm immediately
   (with a one-shot pop). The spec allows this simplification.
3. Tree art is original flat-styled vector work — deliberately game-like, not
   botanical illustration; species differ in silhouette + palette, not in fine detail.
4. Physical iOS/Safari and Android hardware were not tested here; the layout uses
   standard responsive CSS grid plus the repo's existing safe-area/touch rules.
5. The optional Playwright browser matrix was updated but not executed in this
   sandbox (no browser installed); logic, rendering, and wording are covered by the
   executed suites above.
6. Offline imagery note no longer applies (there are no forest images); the app
   shell itself remains available offline via the existing service worker.
