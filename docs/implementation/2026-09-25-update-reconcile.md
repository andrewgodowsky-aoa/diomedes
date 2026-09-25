# Update reconcile: implementation record

Date: 2026-09-25. Lane `update-reconcile`, branch `feature/update-first-launch-reconcile`, based
on `integration/overnight-batch-7`. It blocks the 0.2.0 release. Research behind it:
`docs/research/2026-09-25-skin-layering-and-update-refresh.md`. This slice delivers that report's
Phase 0 and Phase 1, plus the structural part of custom skins. Canonical documents read: Core
Pillars 2026-09-22.1, Live Roadmap 2026-09-24.1, Project Memory 2026-09-24.1. None of them was edited.

Andrew installed an update, and it did not refresh his install the way a fresh install does. The
report confirmed three causes:

1. `settings.json` is loaded as it is, so new defaults reach only new installs.
2. A custom skin is a full token snapshot written inline, so it hides base changes.
3. Changes shipped after a tag without a version bump.

This record says what now handles each cause. It does not bump the version: the release-pipeline
lane bumps to 0.2.0.

---

## What shipped

### Phase 0: the version-bump guard (cause 3)

- `checkReleaseVersion` in `scripts/packaged-release-check.mjs`, the file the report names. It
  refuses a release in two cases:
  - Its version is already tagged, and HEAD's app files (`client`, `server`, `shared`, `desktop`,
    `resources`, `index.html`, `vite.config.ts`, `package-lock.json`) differ from that tag. The
    refusal names the changed files.
  - Its version is not tagged yet and is not ahead of the latest release tag.

  A rebuild of the tagged commit passes. So does a change outside the app, such as docs.
- **How it is invoked.** Only a release runs it. Ordinary pull-request CI never does, because
  between releases `main` is expected to differ from the last tag.
  - `npm run release:check` (`scripts/release-check.mjs`) exits 1 with the reason.
  - `node scripts/package-desktop.mjs --release` refuses to package. Plain `package:*` runs for a
    smoke are not releases and are not checked.
  - `.github/workflows/release-check.yml` runs on a pushed `v*` tag and on `workflow_dispatch`.
    It uses `fetch-depth: 0`, because the guard diffs against a tag. It has no `pull_request`
    trigger.
- A shallow clone has no tags. The guard then says `git fetch --tags --unshallow` and refuses.
  It never passes by default.
- Proof on this branch: `npm run release:check` refuses today's `main` state and names 228
  changed app files since `v0.1.11`. That is exactly the `837a426` situation. It will pass once
  the release lane bumps to 0.2.0.

### Phase 1: first-launch reconcile (cause 1)

`server/update-reconcile.ts` runs inside `createApp`, straight after `store.init()` and before
any route is mounted. On every other launch it does nothing. On the first launch of a build whose
build id (`<version>+<commit12>`, from `server/build-identity.ts`) differs from the recorded one,
it does these steps:

| Step | What it does |
|---|---|
| Record the build | `<data>/last-build.json` (`{ version: 1, app: { version, buildId }, recordedAt }`). Written **last**, so an interrupted run is simply run again. |
| Clear the renderer cache | `desktop/main.mjs` passes `clearRendererCache`, which calls `session.defaultSession.clearCache()` and `clearCodeCaches({})`. Storage is not touched. Outside Electron the record says there was no renderer cache. |
| Settings schema steps | `SETTINGS_STEPS[n]` carries the install from settings schema *n* to *n + 1*. `SETTINGS_SCHEMA_VERSION` is 2. Step 1→2 starts provenance: a fresh install holds only defaults; a value in an older file is `unknown` (kept) unless the policy names it an older default (D1); a key the file lacks is a default. |
| Provenance per setting | `<data>/settings-provenance.json` records, for every tracked setting, `default` (with the value it was given), `chosen`, or `unknown`. `Store.saveSettings` marks a tracked setting `chosen` whenever a save changes it. A value that left its recorded default without a tracked save (a crash between two writes, an older build) is treated as chosen too. |
| Move never-chosen values | A `default` that still holds its recorded value and differs from the new build's default moves to it. A `chosen` or `unknown` value is kept. |
| Rebuild the theme | A built-in scheme is stored as an id and is never snapshotted. The new build's scheme is therefore what shows as soon as the id moves. A custom skin is read as data, re-validated and resolved. Its structural outputs come from the new base (below), and each superseded value is recorded. |
| Append-only record | `<data>/update-reconcile/records/<date>-<from>-to-<to>.json`, never rewritten (decision 10). It holds what moved, what was held, what was kept and why, the theme facts, the cache result and the policy in force. When a stored value moved, the pre-reconcile `settings.json` is kept byte for byte under `update-reconcile/backups/`. |
| One quiet line | `GET /api/update-notice` returns the latest update's line until the person dismisses it (`POST /api/update-notice/seen`, which writes `notices-seen.json` and never touches the record). The client shows it in the existing notice slot: "Updated to X — N settings moved to new defaults.", or "Updated to X." when nothing moved. |

**Tracked settings.**

- Visual: `appearance.package` and `appearance.motion`.
- Behaviour: `view`, `detail` and `explanations`.

**Never tracked, so never moved.**

- **Permissions.** They are authority, and a configuration change never grants one.
- Server-owned pointers: `activeWorkspace` and `home`.
- State rather than preference: onboarding progress, `seen` and `openProjects`.
- `services` (switches). An absent switch is off; filling one in would be a claim nobody made.
- `streamTriggerRules`.
- The custom-theme pointer.

**Crash safety.** The full plan is computed first, from the files as they are, and written to
`update-reconcile/pending.json`. Applying it is a fixed sequence of whole-file writes that
repeat safely: cache, backup, settings, provenance, record, build marker, then the journal is
removed. On the next launch a leftover journal is finished before anything else. It is finished
only while `settings.json` still holds the planned-from or planned-to bytes. Otherwise the plan is
stale (for example, an older build ran in between and the person changed something), so it is
kept as `<id>.abandoned.json` evidence and is never applied.

**Why provenance is a sidecar, not a `settings.json` key.** An older build's `validateSettings`
refuses unknown keys, and the client echoes the whole settings object back. A key in
`settings.json` would break settings saves after a downgrade. Beside the file, it costs an older
build nothing.

**When it counts as an update.** An update means a build replaced a build this install is known to
have run: one in `last-build.json`, or one the desktop shell reported in `desktop-startup.json`.
That file has been written on every launch since 0.1.x, after the service starts, so here it
still names the old build. A settings folder with neither (a fixture, a hand-made folder) gains
its provenance with a `schema` record and no notice. A fresh install records its build and says
nothing.

**What's new.** The in-app release-notes lane is PR #124 (`feature/in-app-release-notes`). It is
an open draft that has not landed on this base or on `main`, so there is nothing yet to integrate
with. This lane adds only its own line.

PR #124 also puts a post-update bar in the same notice slot: "Updated to X." with the release
headline, **What's new** and **Dismiss**. It records the dismissal in `settings.seen.releaseNotes`.
If both lanes land as they stand, the person sees two "Updated to X" lines, which decision 4
forbids.

Whichever lane lands second merges them into **one** bar:

1. The text is `noticeText(record)`, which gives "Updated to X — N settings moved to new
   defaults." When nothing moved, #124's headline follows "Updated to X.".
2. The actions are #124's **What's new** and one **Dismiss**.
3. A dismissal writes both `seen.releaseNotes` and `POST /api/update-notice/seen`.
4. The trigger is this lane's update record, not the setup-date heuristic. The record knows the
   install was updated, rather than inferring it from dates.

The notice text lives in one function, `noticeText`, so that merge touches one place.

### Custom full-snapshot skins (cause 2, structural part only)

`shared/appearance-structure.ts` lists the outputs the base owns outright:

- `--dm-line-body`
- `--dm-ui-scale`, `--dm-read-scale` and `--dm-code-scale`
- `data-density`

These set the reading measure, the type rhythm and control size (decisions 5 and 6).
`withBaseStructure` removes them from a resolved appearance before `applyResolvedAppearance`
writes it (`client/App.tsx`). The running build's `client/styles.css` then decides them, even under
a custom skin. It also returns every skin value it took back (`skinValue` against `baseValue`),
and the reconcile record lists those. A person's own text sizes are still re-asserted after this,
as before.

Skins are **not** converted. Colours, fonts, radius, separators, motion, artwork and `data-package`
still come from the pack. ThemePack v1 is unchanged, and the new file sits outside
`shared/theme-pack/` so the frozen handoff bundle is untouched. Conversion to overlays is the
report's Phase 2 / ThemePack v2, and Andrew's decisions on it are still open.

---

## Decisions for Andrew

Each of these is open. The conservative default taken here is the one that never overrides
something a person may have chosen. Every default is one constant, `RECONCILE_POLICY` in
`server/update-reconcile.ts` or `STRUCTURAL_APPEARANCE_OUTPUTS` in
`shared/appearance-structure.ts`, and tests prove both settings of it.

| # | Question | Default taken | To change it |
|---|---|---|---|
| D1 | Should profiles that never chose a scheme move to Nectovia? | **No, for installs from before this build.** A pre-provenance `settings.json` cannot tell "chose Field" from "was given Field", so every stored value is kept as `unknown`. The Nectovia lane's A5 contract (existing installs keep their saved scheme) stands. From this build on, provenance is exact: a profile that never chooses follows every future default. | Set `legacyDefaults: { 'appearance.package': ['field'] }`. The next update then moves every pre-provenance Field profile, and only those. The test "moves a legacy default when the policy names it as one" proves it. |
| D2 | Should behaviour defaults apply on update, or only visual ones? | **Only visual ones.** A never-chosen `view`, `detail` or `explanations` is held at its old value, and the hold is recorded (`held`, `behaviour-default-held`), so it can still move later. Permissions are never tracked and never move under any answer. | `behaviourFollowsDefaults: true`. |
| D3 | What may a business override? | **Colours, fonts, radius, separators, motion and artwork: everything ThemePack v1 carries except the structural outputs.** Line height, the three type scales and density come from the base. The Design Center still offers line-height and density controls. They now affect only its preview, not the live Console. That is a visible consequence of this default. | Edit `STRUCTURAL_APPEARANCE_OUTPUTS`. Removing `--dm-line-body` and `data:density` restores the old behaviour exactly. |
| D4 | Who wins when base and business conflict? | **The business, silently, for cosmetic tokens.** The skin's value is kept, and nobody is told. **The base, recorded, for structural outputs.** The record lists every superseded value. No admin notification exists yet. | Phase 2. |
| D5 | Should old skins convert to overlays automatically? | **No.** Nothing is converted. Every v1 pack is applied as before, less the structural outputs. | Phase 2 / ThemePack v2 (report D6). |

Two more are raised by this slice:

- **D6-bis. The "What's new" line.** When the release-notes lane lands, should it replace this
  lane's line or append to it? The proposal is one line, whichever lane owns the notice slot. The
  text comes from `noticeText`.
- **D8 (release hygiene).** The report asks whether a post-tag client change must always bump the
  version. This slice makes a *release* refuse it. It does not stop a PR from landing app changes
  under an already-released version, because that is normal between releases.

---

## Hot-file hunks (for the integrator)

This lane touched files the charter assigns to Fable. Every hunk is small and additive.

- `server/store.ts`:
  - `saveSettings` calls `recordChosenSettings(previous, next)`, which never throws.
  - A new `reloadSettings()`.
  - One import.
- `server/app.ts`:
  - An `AppOptions.updateReconcile` option (`build`, `clearRendererCache`, `policy`).
  - A reconcile call right after `store.init()`.
  - The two `/api/update-notice` routes.
  - Imports.
- `server/migrations/registry.ts`:
  - Three families read through `assertReadable`: `last-build`, `settings-provenance` and
    `update-record`.
  - Two own-reader families: `update-journal` and `update-notices-seen`.
- `client/App.tsx`:
  - `withBaseStructure(...)` around the custom-theme resolve.
  - The update-notice state, its fetch in `loadInitial`, and one notice bar.
- `desktop/main.mjs`: `updateReconcile.clearRendererCache` passed to `createApp`.
- `package.json`: the `release:check` script.
- `scripts/package-desktop.mjs`: `--release` runs the guard. `targetFromArgs` accepts the flag.
- `tests/design-studio-ui.spec.ts`: an applied skin no longer writes `data-density` onto the root.
  The assertion now checks the attribute is absent, with the reason.

---

## Tests

- `tests/update-reconcile.test.ts` (21 tests):
  - **The upgrade test.** It installs the older build (its first launch recorded, the `detail`
    choice saved through `Store.saveSettings`, and a Graphite-based skin with a business accent,
    line height 1.8 and density `guided` applied), then launches the new build. It checks all of
    these:
    - the never-chosen scheme moves Field → Nectovia, stored as an id;
    - the chosen detail is kept;
    - the skin pointer is untouched;
    - the behaviour default is held;
    - the effective theme keeps the business accent, and every structural output is absent from
      the inline set, so the new base's stylesheet decides it;
    - the record lists the move, the hold, the kept choice and the two superseded skin values;
    - the backup holds the old bytes;
    - `last-build.json` names the new build;
    - the notice is shown once, then dismissed.
  - A restart of the same build is a byte-for-byte no-op, and there is still one record.
  - A stop after each of the seven apply steps is finished by the next launch, exactly once.
    Afterwards the half-applied state is not mistaken for a choice, there is one record, the
    journal is gone, and the launch after that does nothing.
  - A stale plan is kept as evidence and never applied.
  - The cache clear runs and is recorded.
  - D1 and D2 are each proven both ways.
  - A fresh install stays quiet.
  - A newer settings file is refused, with its bytes untouched.
  - A choice made after the update survives the next update, even when it equals the default it
    replaced.
  - `createApp` reconciles before the first request.
  - `BASE_STRUCTURE` is drift-checked against `client/styles.css`.
- `tests/release-version-guard.test.ts` (5 tests), each against a real temporary git repository:
  - a post-tag app change under the same version is refused, with the changed file named;
  - a bump passes;
  - a rebuild of the tag passes, and so does a docs-only change;
  - a version that is not ahead of the latest release is refused;
  - with no tags, the refusal says how to fetch them.
- `tests/update-notice.spec.ts` (Playwright, added to `playwright.config.ts`). It seeds the data
  folder an older build leaves (`last-build.json` at 0.1.10, Field recorded as a default, detail
  chosen) and starts the real service at this checkout's build. It checks:
  - the one line reads "Updated to <version> — 1 setting moved to new defaults.";
  - `html[data-package]` is `nectovia`;
  - `data-detail` is still `technical`;
  - Dismiss removes the line, and a reload neither re-runs the reconcile nor shows the line again.

## Gates

See the final report on the pull request for the counts from the run on the pushed head.

## Known gaps

- **Not run on an installed copy.** The cache clear runs only inside Electron and has not been
  exercised by a packaged smoke. `scripts/upgrade-desktop-smoke.mjs` was not extended. The report
  asks for that in an owned throwaway Windows profile, which this Linux container cannot provide.
- The desktop titlebar still reads a pack's `chrome`/`t1` directly (report 2.6 step 6). No
  structural output reaches it, so nothing here changes it.
- The Design Center preview still applies a pack's line height and density, which the live Console
  now ignores (D3).
- The notice is not repeated on later launches once dismissed. If the person never dismisses it,
  it stays until the next update replaces it.
- If a later lane changes `defaults()`, only visual settings follow automatically until D2 is
  decided.
- Setup's own move to the Conversation view on first finish is a settings save, so it counts as a
  choice and is kept. That matches what setup intends, but no person pressed a control for it.

---

## Proposed canonical-doc patch

This is not applied. Canonical documents and `QUESTIONS.md` are not this lane's to edit.

**Live Roadmap.** Under release hygiene or updates, add:

> **Update refresh, Phase 0 and 1 (2026-09-25, implemented, not yet released).** A release whose
> app files changed since its version was tagged is refused (`npm run release:check`, the
> `v*`-tag workflow, `package-desktop --release`). The first launch of a new build reconciles:
> renderer caches cleared once, settings carried through versioned schema steps with per-setting
> provenance, never-chosen visual settings moved to the new defaults, chosen ones kept,
> structural appearance outputs taken from the running build even under a custom skin, and an
> append-only record plus one quiet line. Phase 2 (overlay skins, ThemePack v2) is open on D1–D6
> of `docs/implementation/2026-09-25-update-reconcile.md`.

**Project Memory.** Add these definitions:

> **Chosen setting.** A setting the person changed through a settings save. It is kept by every
> update. A setting only ever given by a build is a *default* and follows the next build's
> default (visual settings now; behaviour settings once D2 is decided). A value from before
> provenance existed (0.1.11 and earlier) is *unknown* and is kept.
>
> **Structural appearance output.** Line height, the three type scales and density. The running
> build decides them; no skin can pin them. The list is `STRUCTURAL_APPEARANCE_OUTPUTS`.

**Standing decisions** (the report's D7, for Andrew to approve), a proposed 15th:

> An update re-derives what was never chosen from the running build and keeps what was chosen;
> no skin reaches structure; what an update changed is recorded and never pruned.

**`QUESTIONS.md`.** Add D1–D5 above as open questions, with the defaults taken.

---

## Required reporting

- **Pillar impact.** History is evidence (decision 10): records, backups and abandoned plans are
  never removed. Say it once (decision 4): one line, one function for its text. Trust: permissions
  are excluded from the reconcile, so a configuration change still cannot grant authority. No
  conflict with a pillar was found.
- **Roadmap impact.** Phase 0 and Phase 1 of the update-refresh research are implemented on this
  branch. No roadmap status was changed; the patch above proposes the change.
- **Build, publication and deployment.** The branch is pushed and a draft PR is open. Nothing is
  merged, nothing is released, and the version is still 0.1.11.
- **Implemented versus recorded.** Implemented: Phase 0, Phase 1 and structural supersession.
  Only recorded: D1–D5, D6-bis, the canonical patch and Phase 2.
