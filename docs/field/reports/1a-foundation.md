# 1a — Field foundation pass

Re-values the app theme to the Field visual system: ten colour schemes with a
stable table, Settings swatches driven by that table, the Electron titlebar
overlay following the saved scheme, Big Shoulders Display retired. No component
restyling.

## What changed per file

- **client/field/schemes.ts (new)** — `SCHEMES` ordered array
  (field, deep-field, graphite, verdigris, harbor, ember, moss, dusk, ink,
  paper) with exactly the table values; `DEFAULT_SCHEME = 'field'`;
  `schemeId(id)` maps `cobalt` → `harbor` and any unknown id → `field`.
  Dependency free.
  - Naming note: the brief asks for both a `light` colour and a
    `light?: boolean` on the same object, which cannot coexist on one key.
    `light` stays the accent colour string (Settings swatches and the
    titlebar table consume it as a colour); the paper-is-a-light-scheme flag
    is `lightScheme: true` on the paper entry only.
- **client/styles.css (tokens only)** — `:root` is now the `field` scheme.
  New first-class Field variables (`--chrome --surface --raised --hair
  --hair-2 --t1 --t2 --t3 --light --attn --fail`, plus `--ui/--mono`,
  `--r/--rb`, `--quick/--move/--ease`). Every existing `--dm-*` name is kept
  and re-valued from the scheme (`--dm-frame: var(--chrome)`,
  `--dm-page: var(--surface)`, `--dm-raised: var(--raised)`,
  `--dm-well: var(--chrome)`, `--dm-rule: var(--hair-2)`,
  `--dm-rule-2: var(--hair)`, text 1/2/3 from t1/t2/t3, text-4 as
  `color-mix(in srgb, var(--t3) 80%, transparent)`, glacier from light with
  glacier-ink chrome, signal/signal-edge from attn with signal-ink chrome,
  fault from fail, done/second from t2). `--dm-t-*`, `--dm-ease`, scale vars
  and font vars kept; `--dm-font-brand` is now the Schibsted Grotesk UI stack
  (no display face); `--dm-font-read` still IBM Plex Serif. One
  `html[data-package='<id>']` block per scheme (ten, plus `cobalt`
  duplicating `harbor`) setting only the eleven scheme variables; paper also
  sets `color-scheme: light` and `--dm-glacier-ink/--dm-signal-ink: #ffffff`.
  Old cobalt/graphite/verdigris/paper value blocks removed. `body` untouched
  (still `var(--dm-frame)`). `.palette-swatch` is one rule set (32×22,
  5px radius, 1px `var(--hair-2)` border, chrome background, centred 20×12
  surface block via `::before`, 5px light point at right via `::after`)
  fed by per-row `--sw-chrome/--sw-surface/--sw-light` inline properties;
  old per-scheme `.palette-swatch.<name>` rules removed. No component rules
  touched.
- **client/main.tsx (font imports only)** — removed
  `@fontsource/big-shoulders-display/800`. Added
  `@fontsource/ibm-plex-mono/500`: `node_modules/@fontsource/ibm-plex-mono/500.css`
  exists (verified), so the import was added. Schibsted 400/500/600, IBM Plex
  Serif 400/400-italic/600/600-italic, IBM Plex Mono 400 kept.
- **client/Settings.tsx (Appearance section only)** — the radio list now maps
  `SCHEMES`; row selected when `schemeId(settings.appearance.package) ===
  s.id`, saving `package: s.id`. Same classes (`radio-list`, `radio-row`,
  `palette-swatch`), same accessible structure (radio input named
  `appearance` + visible `<strong>{s.name}</strong>`); swatch colours via
  `style={{ '--sw-chrome', '--sw-surface', '--sw-light' }}`. Only addition
  outside the section body is the `SCHEMES`/`schemeId` import plus a
  `CSSProperties` type import for the custom-property style cast. Other
  sections untouched.
- **index.html** — `data-package="field"`,
  `<meta name="theme-color" content="#121417">`.
- **desktop/main.mjs** — keeps `titleBarStyle: 'hidden'` and
  `autoHideMenuBar: true`. Defaults now `titleBarOverlay: { color:
  '#121417', symbolColor: '#e6e9ed', height: 46 }` and `backgroundColor:
  '#16191d'`. New `FIELD_TITLEBAR` table of `{ id: [chrome, t1] }` for the
  ten schemes plus `cobalt` → harbor values; `titleBarFor()` maps
  cobalt→harbor, falls back to field, and validates both colours against
  `/^#[0-9a-f]{6}$/i`. After `window.loadURL`: read the settings file once
  and `setTitleBarOverlay`, then `fs.watch` the data dir filtered to
  `settings.json`, debounced 150 ms, ignoring parse errors and unknown ids.
  No IPC, no preload.
- **tests/ui.spec.ts, tests/native-ui.spec.ts** — no changes. Grep confirms
  neither file asserts a package list or appearance labels, so per the brief
  they were left alone.
- **docs/field/reports/1a-foundation.md (new)** — this report.

## Settings file found for the titlebar watcher

`settings.json` in the data dir — `server/store.ts` reads
`path.join(this.dataDir, 'settings.json')` (lines ~246/315) and writes it
back (~line 513). The watcher watches `dataDir` (already resolved in
`desktop/main.mjs` from `DIOMEDES_DATA_DIR` or the Electron userData path)
and reacts only to `settings.json` changes.

## Could not do / left for Fable (out of scope for this pass)

- `tests/backend.test.ts:487-488` still asserts the old five-name appearance
  list (`deep-field, cobalt, graphite, verdigris, paper`) — that file is not
  in the editable list, so it was left untouched. The server accepts any
  string package, so nothing breaks, but the list is stale.
- `server/store.ts:158` default is still `appearance: { package:
  'deep-field', ... }` — server files are off-limits; consider flipping the
  default to `'field'` in a later pass.
- `client/App.tsx` arrived in this worktree with pre-existing uncommitted
  Wake changes (`./field/Wake`, `useWake`, load refactor) — not mine, not
  touched. Note `client/field/` already held `Wake.tsx`, `useWake.ts`,
  `wake.css`, `Mark.tsx` before this pass; `schemes.ts` joins them.
- Vitest has one failure unrelated to this pass (see below): server-side
  document-cache behaviour, no server/shared files modified here, and the
  failing test file is not editable under this brief. Left as found.
- Dev-server noise (environmental, pre-existing): with `node_modules` as a
  junction, Vite dev logs "outside of Vite serving allow list" for
  @fontsource woff/woff2 files. Fonts 404 in dev but bundle correctly
  (`vite build` emits them, Playwright is green). Fix would be a
  `server.fs.allow` config change — not an editable file in this pass.

## Verification (exact summary lines)

- `npx tsc --noEmit` — clean, no errors (only the `npm notice run`
  wrapper lines, no diagnostics).
- `npx vitest run --configLoader runner`
  - `Test Files  1 failed | 9 passed (10)`
  - `Tests  1 failed | 226 passed (227)`
  - `Duration  21.62s (transform 1.01s, setup 8ms, collect 7.97s, tests 37.36s, environment 2ms, prepare 3.03s)`
  - The single failure is `tests/backend.test.ts > state reads stay fast
    with a cached documents listing > (b) SKIPPED_FOLDERS are never listed`:
    `expected false to be true` at line 1220
    (`notes/z.md` not listed). It reproduces deterministically in isolation
    (`npx vitest run --configLoader runner tests/backend.test.ts -t
    "SKIPPED_FOLDERS are never listed"` → `Tests 1 failed | 47 skipped
    (48)`), concerns server document-listing cache behaviour this pass does
    not touch (git diff shows no `server/*` or `shared/*` modifications),
    and neither the server nor that spec file is editable under this brief.
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts` — Playwright
  launched fine: `17 passed (36.2s)` (1 native-ui + 16 ui).
- `npx vite build` — `✓ built in 694ms`; IBM Plex Mono 500 + Schibsted + IBM
  Plex Serif assets emitted, no Big Shoulders Display, fonts resolve.

Not committed, as instructed — ready for Fable review.
