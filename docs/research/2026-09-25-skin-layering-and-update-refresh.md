# Skin layering and update refresh

Date: 2026-09-25. Type: research, read-only. No product code was changed. Base: `main` at `559a1ab`
(package version `0.1.11`).

Andrew's report: *"One of our last updates did not actually rescan my installation as if I were a
consumer."* After an update the app did not show the visual and functional changes a fresh install
shows. He wants two things. Free and official skins, and product updates, should always refresh
after an update. A business's own look should survive every update. Nobody should have to reapply a
template by hand.

---

## 1. Root cause

### How an update reaches an installed app today

1. Settings > App updates finds a newer stable GitHub release. It is offered only when
   `compareVersions(release, current) > 0` (`server/app-updates.ts:511`). The service downloads it
   and checks its SHA-256.
2. `desktop/app-updates.mjs` hands off to `desktop/update-helper.mjs`. The helper waits for the app
   to exit, then launches the full NSIS installer interactively with no arguments
   (`update-helper.mjs:95-101`).
3. The installer writes every file over `INSTALLDIR\app` (`scripts/build-windows-installer.mjs:317-321`).
   The renderer is `dist/`, packed into `app.asar` (`scripts/package-desktop.mjs:140`, `:218`), so
   the new build's code replaces the old one as a single file.
4. On the next launch, `desktop/main.mjs` starts the service on the same `userData\data` folder
   (`main.mjs:56`). The only post-update step that has ever existed is the one-time 0.1.9 fresh
   start (`main.mjs:357-365`, `desktop/fresh-start.mjs`). It is keyed to a single marker,
   `fresh-start-0.1.9` (`fresh-start.mjs:15-16`, `:45`), and never runs again.

The code is replaced. The **state** is not re-derived: nothing compares the build that last ran
with the build running now. `desktop-startup.json` records `app.getVersion()` on every launch
(`main.mjs:418-432`), but nothing reads it back.

### Causes, ranked

| # | Mechanism | Status | Evidence |
|---|---|---|---|
| 1 | **Saved settings are carried forward verbatim, and new defaults reach only new installs.** | **Confirmed** | See 1a |
| 2 | **A custom theme (business or personal) is a full snapshot written as inline styles, so it hides every base change.** | **Confirmed** | See 1b |
| 3 | **Recent releases carried little or no client change, and the latest display work is on `main` under the same version number.** | **Confirmed** (contributing) | See 1c |
| 4 | A stale HTTP cache, service worker or asar | **Ruled out** from code | See 1d |
| 5 | The installer puts the update beside the old copy, or an old shortcut launches the old build | Hypothesis, not verified | See 1e |

#### 1a. Settings snapshot with no update reconciliation (confirmed)

- `Store.init` reads `settings.json` as it is. Defaults are used only when the file is **absent**:
  `readJson(path, defaults)` (`server/store.ts:417`, `readJson` at `:328-335`). An existing file is
  never deep-merged with the current build's defaults.
- `migrateSettings` (`server/store.ts:152-198`) is a hand-written list of fix-ups (workspace, retired
  Workbook keys, `view`, `home`). It has no settings schema version and does not know which build
  wrote the file.
- The default scheme changed from `field` (before `c0112c4`) to `nectovia` (`server/store.ts:240`,
  `index.html:2`). The Nectovia lane decided on purpose that **existing installs keep their saved
  scheme and nothing migrates them**. See `docs/implementation/2026-09-22-nectovia-skin.md:35-37`,
  and open decision 4 in `docs/product/2026-09-22-nectovia-skin.md`. Every Nectovia device is
  anchored on `html[data-package='nectovia']` (`client/console/nectovia.css` header,
  `client/styles.css:93`). So a profile that says `package: "field"` never sees the new look. The
  file cannot tell "chose Field" apart from "was defaulted to Field by an older build".
- Behaviour defaults work the same way. A new person lands in the Conversation view when setup
  finishes (`shared/onboarding.ts:113-119`), but only on the **first** finish. An upgraded profile
  already has `onboarding.completedAt` and keeps `view: 'architect'` (`server/store.ts:181`).
  `detail`, `onboarding` and `permissions` defaults all apply only to new installs.
- The 0.1.9 fresh start was the one time an upgraded install matched a fresh install. It worked by
  setting everything aside, not by reconciling it. From 0.1.9 onward, an update from 0.1.9 or later
  "keeps your settings" (`docs/releases/notes/v0.1.10.txt`, `v0.1.11.txt`), which includes the
  appearance.

#### 1b. Custom skins are full copies that pin every token (confirmed)

- A new Design Center pack is "exactly the built-in appearance, written out": all 11 colours, all
  typography, geometry and motion values are copied from the base at creation time
  (`client/console/design-center/pack.ts:126-173`, `packFromBaseTheme`). ThemePack v1 requires
  every token (`shared/theme-pack/README.md`, "The pack"). A pack cannot express "inherit this from
  the base".
- When a pack is active, `resolveAppearance` overwrites every colour, radius, font, scale and
  timing with the pack's value (`shared/theme-pack/resolve.ts:354-388`). It then emits all of them
  (`:478-486`).
- `applyResolvedAppearance` writes them with `root.style.setProperty` on `<html>`
  (`client/console/theme-runtime.ts:103-109`; called from `client/App.tsx:354-372`). Inline custom
  properties outrank every `html[data-package=…]` rule in `client/styles.css`. **Any base value an
  update changes is invisible while a custom pack is applied.**
- `dataset.package` is set to the pack's `baseTheme` (`resolve.ts:384`). A pack built on
  `graphite` or `field` therefore never gets Nectovia's devices, however the default changes. The
  resolver's own "defaults" layer is `field` (`shared/theme-pack/types.ts:63`), not the app's
  default `nectovia`.
- A business skin today is exactly this: a full ThemePack in the business scope folder,
  `<data>/themes/business-<hash>/<id>/pack.json` (`server/themes.ts:1-7`, `themeScopeKey` at
  `:68-73`). A global pointer, `settings.appearance.activeTheme`, points at it. The resolver's layer
  3, "authorized workspace branding" (`WorkspaceBranding`, which takes *partial* colours:
  `resolve.ts:52-63`, `:390-409`), is the only delta-shaped primitive in the tree. **No caller
  wires it up.** `App.tsx:356-367` passes no `workspace`, and no client or server code builds a
  `WorkspaceBranding`.
- If `pack.json` fails validation after an update, `themes.active()` silently serves
  `last-known-good.json` with a notice (`server/themes.ts:335-375`). An older revision can stay
  pinned. `migrate()` is a stub that refuses anything but v1 (`shared/theme-pack/validate.ts:316-321`).

#### 1c. Releases that carried no visual change (confirmed, contributing)

- `git diff v0.1.10 v0.1.11 -- client shared desktop` is **empty**. 0.1.11 changed only
  server-side behaviour: Files listing speed, conversation resilience and settings keys.
- `v0.1.9..v0.1.10` changed no stylesheet. It removed the History screen and the Sample project.
- The latest display work, `837a426` "Fix six display bugs and add a conversation text size"
  (2026-09-24), landed **after** the `v0.1.11` tag. No tag contains it, and `package.json` still
  says `0.1.11`. A build from `main` would say 0.1.11, so the updater would never offer it
  (`compareVersions <= 0`), and a person could not tell that build from the release.
- So if the change Andrew expected was the recent display work, no published update could have
  carried it. If it was Nectovia or the Conversation view, 1a and 1b explain it.

#### 1d. Caches (ruled out from code)

- There is no service worker. A grep for `serviceWorker` or workbox under `client/` and
  `index.html` finds nothing.
- `serveClient` is `express.static` plus an `index.html` fallback (`desktop/service.ts:8-11`). That
  means ETag revalidation, and Vite's hashed asset names (`dist/assets/app-<hash>.js`).
- The service listens on a **random loopback port on every launch** (`main.mjs:369-374`,
  `listen(0)`). The page origin, and with it the HTTP cache key, is new each launch.
- `app.asar` is one file that the installer replaces.
- Side finding, unverified on an installed copy: for the same reason, `localStorage` (rail pins,
  drafts and artifact widths in `client/App.tsx:110`, `client/console/Composer.tsx:76`) is keyed
  to an origin that changes every launch. It probably does not survive a restart. This is not the
  reported bug.

#### 1e. Installer placement (hypothesis)

The installer runs interactively with a directory page (`build-windows-installer.mjs`,
`MUI_PAGE_DIRECTORY`). It overwrites files and does not remove stale ones. If a different folder
is chosen, or a pinned or desktop shortcut points at an older copy, the old build keeps launching.
Every release note since 0.1.9 says the update "has not been run end to end on an installed copy".
`scripts/upgrade-desktop-smoke.mjs` sets `DIOMEDES_DESKTOP_PROFILE`/`DATA_DIR`, which is exactly
the case where the fresh start is skipped (`main.mjs:49-53`). It checks that data is preserved,
not that the app looks the same as a fresh install. This can be verified quickly by reading
`data\desktop-startup.json` (`version`, `executable`) on Andrew's machine.

**Bottom line.** No stale cache is involved. The code updates correctly, but the product has no
update-time step that re-derives the effective appearance and defaults from the new build. It also
stores skins as full copies that pin old values over anything the build ships. Separately, the
visual fixes Andrew may have been expecting have not shipped in any release.

---

## 2. Target design: base, skin, overlay, resolved on every launch

### Principle

The effective appearance is **never stored**. On every launch it is computed from:

```
L0 structural (not tokens)            shipped in code; nothing overrides it
L1 base token schema @ build          shipped in the build (versioned)
L2 official skin @ build              shipped in the build (Nectovia, Field, … as packs)
L3 business overlay (delta)           business scope; only what the business changed
L4 personal preferences               settings (scales, density, motion, texture)
L5 accessibility & safety             mandatory, last (already in resolve.ts)
```

This is the existing five-layer resolver (`shared/theme-pack/resolve.ts`) with one layer split out
(base versus official skin), and with layer 3 made real and delta-shaped. Only L3 and L4 are user
data. L1 and L2 come from the running build, so an update refreshes them simply by being
installed.

### 2.1 A versioned base token schema (L1)

- One `TOKEN_MANIFEST` per build, beside `shared/theme-pack/types.ts`. Each entry has a token id,
  a type, a default, a class (`cosmetic` or `structural`) and `since`/`renamedFrom`/`removedIn`.
  The manifest carries a `tokenSchemaVersion` integer that bumps when a token's meaning changes.
- The manifest becomes the single source that `client/styles.css :root`, `BASE_THEME_COLORS` and
  `APPEARANCE_OUTPUTS` are checked against. Today these are three copies held together by drift
  tests (`types.ts:87-89`, `README.md` "What the app reads today").
- **Structural (L0), never overridable.** Layout and measure (`.console .col`, decision 6),
  `min-width: 0` and truncation policy (decision 5), control hit sizes, focus visibility, z-order,
  which controls exist and what they do, and machine strings. These stay as CSS in code, not as
  tokens, so no pack can name them.
- **Cosmetic tokens, overridable.** The 11 colours, `lightScheme`, fonts from `FONT_CHOICES`,
  radius within bounds, separator strength, motion preset and intensity within bounds, and artwork
  slots. These are the tokens the ThemePack already bounds.

### 2.2 Official and free skins as versioned, build-shipped packs (L2)

- Each built-in scheme, Nectovia included, becomes a ThemePack shipped inside the build (for
  example `resources/skins/<id>.json`, or compiled in). Each has `version` equal to the app build
  and `hostTokenSchema: n`. Settings stores only the skin **id**, never a copy, so the next build's
  Nectovia is automatically the Nectovia shown.
- A skin's own *devices* (Nectovia's plates, seams and motion) stay in its anchored stylesheet under
  the proposed decision 15. Only official skins may carry devices. An overlay can recolour them
  through tokens but cannot add them.
- This is the capability-pack lifecycle applied to appearance, following the business-plugin
  phase 1 plan (`docs/research/2026-09-06-business-plugins/development-roadmap.md` P01-P04):
  - P01: validate the catalog and each descriptor (id, version, host token schema range) at build
    and at load. The catalog is "a reviewed static registry shipped with the app".
  - P02: list only skins the person is entitled to (`shared/customization-entitlement.ts`).
    Accessibility controls and built-in schemes stay free.
  - P03: readiness shows what an overlay is missing or had dropped.
  - P04: typed evidence, meaning the update record in 2.6.
  Decision 14 applies: a skin composes into the one Console, and activating it is not an
  authorization event.

### 2.3 Business skins as a delta overlay (L3)

- ThemePack **v2** adds `kind: 'overlay'`. An overlay has `extends: { skin: 'nectovia' }`,
  `authoredAgainst: { tokenSchemaVersion, appVersion }`, and **partial** `tokens`, `typography`,
  `geometry`, `motion` and `artwork`, holding only what the business changed. Assets work as in v1
  (hash-addressed, `server/theme-assets.ts`). v1 full packs stay readable through `migrate()`
  (`validate.ts:321`), which becomes the real conversion point.
- The resolver's `WorkspaceBranding` layer grows into this overlay and is finally wired up. It is
  still gated on `authorized` (the entitlement decision) and still re-checked per value at the door
  (`resolve.ts:390-409`).
- The overlay lives in the business scope folder that already exists
  (`<data>/themes/business-<hash>/`). It keeps immutable revisions and last-known-good exactly as
  `server/themes.ts` does today. Revisions are evidence (decision 10).
- **The in-house business template *is* the overlay.** The Design Center saves "business skin" as
  an overlay by diffing the editor state against the skin it extends. It stores the diff, not the
  whole pack. It can be exported or imported as a `.diomedes-theme` v2 file today, and pushed
  through the control plane later. Nothing is reapplied after an update, because the overlay is
  re-resolved against whatever base ships.

### 2.4 Migration on update

A pure function, `migrateOverlay(overlay, fromSchema, toManifest)`:

- **Renamed tokens** map forward through `renamedFrom`.
- **Removed or unknown tokens** are dropped. Each drop is recorded with its old value, not silently
  lost.
- **New tokens** are absent from the overlay, so they fall back to the skin and base.
- **Legacy v1 full packs** (every existing custom theme) become overlays by diffing against the
  base they name. A value equal to *any* shipped historical value of that token for that base is
  treated as inherited. This needs a small `BASE_THEME_HISTORY` table, so a later base change is
  not mistaken for a business choice. Everything else becomes an override.

### 2.5 Validation, with a safe fallback per token

The whole overlay is refused and the official skin shown only when the overlay fails schema
validation (as today). Otherwise the fallback is **per token**, never all or nothing:

- A token outside its bounds, of an unknown class, or structural is dropped and recorded.
- Contrast is re-checked on the *effective* result against the new base (`contrastRatio` and
  `liftToContrast`, `resolve.ts:199-235`, `:458-466`). A business colour that fails the floor on
  the new surfaces is lifted, and the lift is recorded.
- Texture ceiling and reduced motion are already enforced in layer 5.
- In CI, a Playwright visual pass renders each official skin plus sample overlays (including a
  hostile one) over the Engines reference screen, then checks for no overflow, visible focus, and
  hit targets that stay at their size.

### 2.6 The update-time rescan

1. **Detect.** The shell writes `userData/last-build.json` with `{ version, buildId }`
   (`server/build-identity.ts`). If the stored value differs from the running build, this is the
   first launch of a new build. The environment-profile skip rule is the same one as
   `main.mjs:49-53`.
2. **Cache hygiene.** Run `session.defaultSession.clearCache()` and clear the code caches once per
   build. This does **not** clear storage. Code shows it is not today's cause (1d), but it is the
   standard Electron guard for updates and costs nothing.
3. **Settings reconcile.** Add a `settingsVersion`. Deep-merge the new build's defaults for any key
   that is missing, then run ordered, versioned migrations in place of the flat `migrateSettings`.
   Record `appearance.skinSource: 'default' | 'chosen'`, so a person on "whatever the product
   ships" follows the new default and a person who chose a skin keeps it. The same pattern covers
   behaviour defaults such as `view`, where Andrew decides the migration policy.
4. **Rebuild the effective theme.** Migrate the overlay (2.4), validate it (2.5) and resolve all
   layers. The result is computed and not stored as authority.
5. **Record.** Write `data/appearance/updates/<from>-to-<to>.json`, typed evidence (P04): tokens
   now inherited from the new base, overrides kept, tokens renamed or dropped, contrast lifts, and
   whether a fallback happened. Settings > Appearance shows it **once**, in one sentence
   (decision 4). For example: "Updated to 0.1.12: your 7 brand colours were kept; 4 values now
   follow Nectovia."
6. **The titlebar.** `desktop/main.mjs:120-150` reads a pack's `chrome`/`t1` directly. It must read
   the same resolved result, or the effective skin, rather than a raw pack file.

### 2.7 Fit with the standing decisions

- **Decision 1 (one surface).** All of this lives in Settings > Appearance and the Design Center.
  It adds no new surface.
- **Decision 2.** Structure is L0 and follows the Engines reference. The user-selectable theme
  package is kept.
- **Decision 3.** The website consumes ThemePack. v2 changes the frozen v1 contract and must go
  through `npm run theme-pack:handoff` and the site's pinned-hash check. The site shares tokens,
  never implementations.
- **Decision 14.** Skins compose into the one Console. Activation is not authorization. Business
  branding stays entitlement-gated.
- **Trust.** "Configuration cannot revive spent authority": nothing in a skin carries authority.
  The update record is evidence and is not pruned (decision 10).

---

## 3. Outside patterns (only what informs the design)

- **VS Code.** A theme is a versioned extension that updates independently. User changes live
  separately as a *delta* in `workbench.colorCustomizations`, optionally scoped per theme
  (`"[Theme Name]": {…}`). Colour ids are a registry, and an unknown id is warned about, not fatal.
  This is the overlay model plus drop-and-record.
  ([Themes](https://code.visualstudio.com/docs/configure/themes),
  [Theme Color reference](https://code.visualstudio.com/api/references/theme-color),
  [scoping issue #39298](https://github.com/microsoft/vscode/issues/39298))
- **Shopify.** A theme update replaces the code wholesale. Merchant choices made in the editor live
  in `settings_data.json` and are migrated onto the new theme version. Hand edits to code files are
  lost. This is the lesson for the in-house template: a business's look must be *settings data*
  (the overlay), never edited copies of product files.
  ([settings_data.json](https://shopify.dev/docs/storefronts/themes/architecture/config/settings-data-json),
  [Updating themes](https://help.shopify.com/en/manual/online-store/themes/managing-themes/updating-themes))
- **Slack and Discord** (general knowledge, not re-verified here). Custom themes are a short list
  of colour overrides, or a server-defined preset id, on a client-owned structure. Users cannot
  restyle layout. This supports keeping structure out of reach (L0).
- **Electron caching.** Stale renderer caches after an update are a known pitfall. The standard fix
  is `session.clearCache()` once per new version, recorded with a marker.
  ([electron#6067](https://github.com/electron/electron/issues/6067),
  [electron#36646](https://github.com/electron/electron/issues/36646)) This is not today's cause
  here, because the random port and the replaced asar already avoid it. It is cheap insurance for
  step 2 in 2.6.

---

## 4. Phased plan

Each phase is one reviewable slice with its own tests, run through all four gates. Everything here
is proposed only, and nothing is approved or built.

**Phase 0: release hygiene (hours).** Bump the version whenever `client/`, `shared/` or `desktop/`
changes after a tag. Add a check to `scripts/packaged-release-check.mjs` that refuses to package
`main` under an already-tagged version when those paths differ from the tag. This alone gets
`837a426` to Andrew.

**Phase 1: update rescan for built-in schemes and settings (smallest slice for the reported bug).**
- `last-build.json` marker and a `reconcileAfterUpdate()` that runs once per build (2.6 steps 1-3
  and 5). Add `settingsVersion`, deep-merge of defaults, and `appearance.skinSource`. The inference
  for existing files needs an Andrew decision (see D1).
- Clear the cache once per build.
- An update record, and a one-line notice in Settings > Appearance.
- Tests:
  - A unit test with a 0.1.10 `settings.json` fixture: after reconcile, every new default key is
    present, a *chosen* scheme is kept, a *defaulted* scheme moves to `nectovia`, the record is
    written, and a second launch is a no-op.
  - Extend `upgrade-desktop-smoke.mjs`: prior build to current build, then `html[data-package]`
    equals the fresh-install value for a defaulted profile and is unchanged for a chosen one.
    Run it once *without* the environment-profile override, in an owned throwaway Windows profile.

**Phase 2: overlay model.** ThemePack v2 `kind: 'overlay'`, a real `migrate()` from v1 (diff
against base, with `BASE_THEME_HISTORY`), the workspace layer wired up, and the Design Center
saving overlays.
- Key test: install the old build with a business v1 pack that overrides `light` and `t1`. Update
  to a build whose base changes `surface` and `hair`. The effective theme contains the **new**
  `surface` and `hair` and the **business** `light` and `t1`. The record lists exactly two kept
  overrides.
- Also test that a v1 pack identical to its base becomes an empty overlay.

**Phase 3: token manifest, structural versus cosmetic, rename and drop.** The `TOKEN_MANIFEST`
becomes the one source for styles.css, `BASE_THEME_COLORS` and `APPEARANCE_OUTPUTS`, with drift
tests.
- Test that a rename moves the value and a removal is dropped and recorded.
- Test that a structural name in an overlay is refused.
- Test contrast: a business `t2` that passes on the old surface and fails on the new one is lifted
  and recorded.

**Phase 4: official skins as versioned packs.** Built-in schemes and Nectovia ship as validated
packs (P01 catalog check), and settings store ids only. The titlebar reads the resolved result.
- Test: bump a skin token in a fixture build, and an install on that skin shows it after update
  with no user action.
- Test: CI visual pass across skins and sample overlays.

**Phase 5: business distribution.** Export and import `.diomedes-theme` v2 overlays. The control
plane pushes them later, with an admin view of "what this update changed for your skin". Theme-pack
handoff to the site.

---

## 5. Decisions for Andrew

- **D1. Existing installs and the default skin.** Should an update move profiles that never chose
  a scheme onto the current default (Nectovia)? This reverses contract A5 and closes open decision
  4 in the Nectovia doc. Old files cannot say "chose" versus "defaulted". The proposed inference is
  that `field` counts as defaulted, because `field` was the default before `c0112c4`, and any other
  scheme counts as chosen. The alternative is a one-time "Try the new look" offer.
- **D2. Behaviour defaults.** Should updates also apply new-install behaviour defaults (for
  example the Conversation view), or only visuals?
- **D3. The structural/cosmetic line.** Which tokens a business may override: colours only, or
  also fonts, radius, density and motion? May a business ship artwork? Devices remain for official
  skins only.
- **D4. Conflicts.** When a new base changes a token a business overrode, should the business
  value win silently (proposed), or should the business admin be told?
- **D5. Legacy packs.** Auto-convert existing v1 custom themes to overlays (proposed), or keep them
  pinned and prompt?
- **D6. ThemePack v2.** Approve a new schema version of the frozen v1 contract, and the site
  handoff that goes with it.
- **D7. Canonical documents.** Record a standing decision along the lines of: "an update always
  re-resolves appearance from the running build; business customisation is a delta overlay; no
  skin reaches structure". This needs updates to the pillars, roadmap and project memory.
- **D8. Release hygiene.** Make it mandatory to bump the version for any post-tag client change
  (Phase 0).
