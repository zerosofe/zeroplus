# Achievement Forest upgrade — implementation & verification report

Date: 2026-10-07

## COMPLETED

- Replaced the geometric SVG forest with layered, photorealistic tree cutouts and textured meadow terrain.
- Applied the same visual language to the main forest, home preview, tree record thumbnails, species catalog, and newly planted tree confirmation.
- Preserved the single-page HTML/JavaScript PWA, Arabic content, section colors, typography, navigation, card structure, and existing account / focus / achievement integration.
- Removed the tree wobble and bouncing growth animation. The scene is deliberately still rather than running a continuous rendering loop.
- Added image-failure feedback and a scene-only retry control. Image failures never change achievements.
- Converted the consumer-facing SQL setup dialog to Arabic save-recovery help, retaining retry, support navigation, and the existing save verification operation. Maintainer setup instructions are below instead of in the application.

## FOREST IMPLEMENTATION

The forest uses a lightweight **2.5D image composition, not a real-time WebGL scene**:

- Nine distinct photorealistic tree cutouts have textured bark, irregular branching, and detailed foliage.
- Transparent WebP cutouts are placed over a treeless terrain plate. The environment itself therefore never adds unearned trees.
- Far-to-near paint order, perspective scale, varied positions, slight width / tone variation, and soft contact shadows provide spatial depth.
- Responsive scene proportions: 4:3 on small screens, 16:9 on larger screens; the smaller home preview uses its own proportions.
- The scene has an accessible Arabic description with the actual total, and a visible caption discloses when only part of a large collection is shown.
- Deterministic placement avoids random reshuffling on rerender. Positions remain stable when adding a new tree until the bounded rendering window rolls over.
- Image errors hide the broken-image icon and expose an Arabic retry control while retaining the count and records.

### Asset provenance

The new artwork was AI-generated specifically for this implementation, then white-matted, cropped, resized, and compressed locally. These are **photorealistic generated assets**, not photographs or scanned 3D models. No game or commercial stock artwork was copied. The large source renders are not Git assets; the app ships only the optimized WebPs. The optimization tool accepts a separately retained source-render directory.

The generation budget provided nine tree forms. Three existing catalog entries currently use a shared visual form: `blossom → oak`, `ginkgo → maple`, and `baobab → olive`. Their stored species, Arabic names, rarity, and eligibility rules are unchanged. These three images are not botanically accurate representations of their labels; dedicated artwork remains an art follow-up.

## TREE PROGRESSION

`displayForest()` remains the source of truth. It merges `userTrees` with legacy `userForest` focus sessions and deduplicates by ID. Its implementation was not changed.

The existing flow remains:

1. A completed focus session is recorded by `finishPomoSession()`.
2. `plantTreeForSession()` chooses a species using the existing duration / rarity logic.
3. The existing local storage, cloud-write, and retry-queue paths persist the record.
4. The visual layer consumes `displayForest()` without writing or inventing records.

Zero achievements show only terrain. One achievement renders one tree. Several achievements create a grove. Larger collections produce denser, depth-layered scenes. The main scene renders up to **96 actual records**, and the home preview up to **24**, with explicit “shown / total” wording beyond those bounds. All totals remain uncapped. The existing 60-item recent-record grid and persistence limits are unchanged.

There was no stored seed-to-mature growth-stage system to preserve; the old grow effect was an entrance animation. No new growth or achievement rules were introduced.

## FILES MODIFIED

| File | Changes |
| --- | --- |
| `index.html` | Forest styles and image renderer, responsive composition, previews and thumbnails, loading accessibility, image recovery, consumer-facing wording and safe error messages, recovery dialog. |
| `package.json` | Added forest test commands and included forest logic tests in `npm test`; no new production or mandatory development dependency. |
| `tests/run-tests.mjs` | Updated six existing wording expectations for plain-language recovery messages; retained persistence, authentication, queue, and runtime-log assertions. |

## FILES ADDED

| File | Purpose |
| --- | --- |
| `docs/achievement-forest.md` | This report, asset provenance, limitations, test instructions, and maintainer recovery guidance. |
| `tools/optimize-forest-assets.mjs` | Reproducible white-background matting, transparent cutout sizing, thumbnail generation, and WebP compression. |
| `tests/forest-rendering.mjs` | Count, deduplication, stable placement, catalog asset, wording audit, and asset-budget regression tests. |
| `tests/forest-browser.mjs` | Optional browser viewport, bounds, decoding, state, recovery, and real service-worker offline tests. |
| `assets/forest/meadow-640.webp` | 640×427 mobile terrain plate. |
| `assets/forest/meadow-1280.webp` | 1280×853 larger-screen terrain plate. |
| `assets/forest/oak.webp` | Full-resolution oak-form transparent tree. |
| `assets/forest/oak-thumb.webp` | Oak-form thumbnail. |
| `assets/forest/pine.webp` | Full-resolution pine-form transparent tree. |
| `assets/forest/pine-thumb.webp` | Pine-form thumbnail. |
| `assets/forest/palm.webp` | Full-resolution palm-form transparent tree. |
| `assets/forest/palm-thumb.webp` | Palm-form thumbnail. |
| `assets/forest/cypress.webp` | Full-resolution cypress-form transparent tree. |
| `assets/forest/cypress-thumb.webp` | Cypress-form thumbnail. |
| `assets/forest/olive.webp` | Full-resolution olive-form transparent tree. |
| `assets/forest/olive-thumb.webp` | Olive-form thumbnail. |
| `assets/forest/willow.webp` | Full-resolution willow-form transparent tree. |
| `assets/forest/willow-thumb.webp` | Willow-form thumbnail. |
| `assets/forest/maple.webp` | Full-resolution maple-form transparent tree. |
| `assets/forest/maple-thumb.webp` | Maple-form thumbnail. |
| `assets/forest/euca.webp` | Full-resolution eucalyptus-form transparent tree. |
| `assets/forest/euca-thumb.webp` | Eucalyptus-form thumbnail. |
| `assets/forest/cedar.webp` | Full-resolution cedar-form transparent tree. |
| `assets/forest/cedar-thumb.webp` | Cedar-form thumbnail. |

## SUPABASE UI CLEANUP

Searched the repository for `Supabase`, `supa`, `database`, `table`, `Storage`, `Auth`, and `backend`, distinguishing implementation references from visible text. The app no longer displays Supabase in its authored user-facing copy, accessibility labels, tree tooltips, account/help copy, status messages, or error feedback.

- Tree messages use account-centered wording such as **«كل شجرة محفوظة في حسابك»**.
- Offline and pending states explicitly distinguish device-local storage from successful account synchronization.
- `describeCloudError()` converts backend errors to Arabic recovery guidance instead of exposing raw service names, SQL, table names, or server text.
- Cloud-indicator tooltips, support status, copied diagnostics, authentication failures, and forest errors use safe messages.
- Detailed internal errors still exist in internal logs; technical imports, configuration, backend clients, queries, schema, and service-worker backend exclusions remain intact.
- Administrator SQL instructions were removed from the consumer dialog, not from the repository or backend setup capability.

### Maintainer-only recovery guidance

For an uninitialized deployment, an authorized maintainer should inspect the existing `supabase/schema.sql`, verify the target project and its access-policy requirements, and apply the existing schema using the Supabase SQL Editor. This change does not modify or automatically execute the schema. Do not instruct ordinary students to administer the backend.

After restoring the service, use the application's existing retry control to load the forest and flush locally pending trees. The existing save-check control still performs its temporary write/read/delete verification; it is not a new achievement rule or a source of visual demo data.

## PERFORMANCE

- No rendering library, WebGL context, animation frame loop, particles, or continuous tree animation was added.
- Native `loading="lazy"`, asynchronous image decoding, shared asset URLs, and separate 96×128 thumbnails reduce loading and decoding work.
- Full tree cutouts are only 384×512; terrain is 640 or 1280 pixels wide. No 4K/8K imagery is shipped.
- All 20 images together: **906,274 bytes**. The mobile set including every tree, every thumbnail, and the smaller terrain: **703,560 bytes**. A single-tree view needs much less.
- The mobile terrain is 55,958 bytes; all nine thumbnails together are 53,890 bytes.
- The main scene has at most 96 tree image nodes and the preview at most 24. No achievement counts are truncated.
- A state signature preserves scene DOM nodes when the achievement IDs/types have not changed.
- The existing service worker already runtime-caches same-origin images; it was left unchanged. Viewed forest assets were verified available offline.
- A desktop sandbox Chromium run measured scene render/update calls at **3.5 ms p95 / 7.2 ms maximum** across the viewport/count matrix. These are JavaScript update measurements, **not** mobile frame-rate, full paint, GPU-memory, or battery benchmarks.

## TESTING

### Results

| Check | Result |
| --- | --- |
| Existing regression suite | **66 / 66 passed**. Includes account flows, cloud mocks, offline queueing, session completion, tree writes/loading/deduplication, missing-service recovery, deletion, navigation, achievements, and service-worker behavior. |
| New forest logic suite | **14 scenario groups passed**. Counts 0, 1, 6, 10, 30, 96, 300, and 1000; no fake production data; correct caps/disclosures; stable placement; asset existence; safe text; budget. |
| DOM smoke suite with jsdom installed | **124 button interactions, 48 state checks, zero console errors**. |
| Chromium viewport matrix | **56 combinations passed**: seven counts across eight viewport sizes. No page horizontal overflow, clipped tree-image bounds, undecodable scene images, or uncaught JavaScript errors. |
| Responsive asset loading | Smaller terrain below 768px, larger terrain at/above 768px; hidden focus-tree assets were not loaded at initial empty-home boot. |
| State / accessibility checks | Loading `aria-busy`, error retry, recovery dialog, home subset caption, dark-mode state, reduced-motion setting, and no infinite scene animations passed. |
| Image-failure recovery | Broken scene asset feedback and retry passed; achievement total stayed unchanged. |
| Actual PWA image cache | Terrain, a full tree, and a thumbnail fetched successfully offline through the existing service worker after online loading. |
| Visual inspection | Single-tree and multi-tree scene screenshots inspected at mobile and desktop sizes. |
| Patch hygiene | `git diff --check` passed. No database/schema changes. |

Viewport sizes: **320×568, 390×844, 430×932, 360×800, 768×1024, 1024×768, 800×1280, 1440×960**. These approximate small/large iPhones, Android phones/tablets, iPad orientations, and desktop. They are Chromium viewport simulations, not actual Safari/iOS/Android hardware tests.

Browser tests use locally compiled Tailwind CSS and stub external CDN scripts because of sandbox network restrictions. Existing inline app code and local image files are tested as shipped. Production authentication and database behavior are covered by the repository's mock-backed regressions, not a live-account test. No production account or achievement data was altered.

### Run the tests

```sh
npm install
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

Browser settings: `FOREST_TEST_URL` overrides the default local server; `CHROMIUM_PATH` selects a system browser; `FOREST_TEST_ARTIFACTS` writes optional screenshots outside Git. The restricted sandbox used `FOREST_TEST_CHROMIUM=sparticuz` with the optional `@sparticuz/chromium` package and its bundled shared libraries.

Asset preparation, when the original renders are available:

```sh
node tools/optimize-forest-assets.mjs /path/to/source-renders
```

## REMAINING LIMITATIONS

1. This is photorealistic **layered 2.5D imagery**, not an orbitable 3D world or a physically simulated AAA environment. Shadows are composited approximations; no live wind or leaf simulation is included.
2. Blossom, ginkgo, and baobab currently share other tree-form artwork. Dedicated, botanically appropriate cutouts remain to be produced.
3. Large collections show a bounded visual sample (96 main / 24 preview), explicitly labeled. The actual total remains correct; the pre-existing record grid shows the most recent 60 entries.
4. Physical iOS/Safari, Android hardware, mobile battery/GPU-memory measurements, and live production authentication/persistence were not tested here.
5. Offline imagery is available after it has been loaded and cached. A first visit without connectivity cannot download uncached assets and instead uses the image-recovery state.
