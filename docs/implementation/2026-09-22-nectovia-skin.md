# Nectovia skin: implementation record

Date: 2026-09-22 (browser verification 2026-09-23). Lane: APP SKIN. Branch `feature/nectovia-skin`,
worktree `F:/Diomedes/diomedes-wt/nectovia-skin`, base `c10b7b2`. Status: uncommitted. Nothing is
committed, pushed, merged or deployed. The product record, with the owner's words, the conflict with
Decision 2 and the decisions still open, is
[`docs/product/2026-09-22-nectovia-skin.md`](../product/2026-09-22-nectovia-skin.md).

## Release blocker

**The third-party notices must list Instrument Serif (SIL Open Font License 1.1) before any build
that contains this work ships.** The font is vendored, not an npm package (package.json is not
touched by this lane). Its licence travels with it at `client/fonts/instrument-serif/OFL.txt`, but
`scripts/collect-package-notices.mjs` finds fonts only through its `fontNotices` map, which is keyed
by `@fontsource` package names. So `licenses/THIRD_PARTY_NOTICES.md` and its "Bundled fonts" list do
not name it yet. The fix needs two things: a `licenses/instrument-serif.txt`, and a vendored-font
entry in the collector. Then regenerate the notices.

**Update 2026-09-23: half done.** PR #43 (`8424710`) added the vendored-font entry to
`scripts/collect-package-notices.mjs`. The collector has not been run since, so on main
`licenses/instrument-serif.txt` does not exist yet and `licenses/THIRD_PARTY_NOTICES.md` still omits
Instrument Serif. The blocker stands until the collector runs and its output is committed.

## What shipped

Every look below is drawn only under the Nectovia scheme. Every rule is in
`client/console/nectovia.css`, anchored on `:is(html, .dc-stage)[data-package='nectovia']`. Choosing
any other scheme removes all of it, and `tests/nectovia-scheme.test.ts` holds that. The name, the
segment bar and two fixes apply in every scheme; they are called out as such.

1. **Scheme (CP1).**
   - `nectovia` is first in `SCHEMES` and in `BASE_THEME_IDS`/`BASE_THEME_COLORS`.
   - `client/styles.css` gains one additive block of the eleven primitives.
   - Instrument Serif italic 400 is vendored under `client/fonts/`.
   - New installs default to Nectovia (server default, `index.html` pre-paint). Existing installs keep
     their saved scheme: settings.json is always written whole, so an old file names its scheme, and
     nothing migrates it.
   - The desktop title bar and the window's first paint follow the stored scheme.
2. **Segment bar, all schemes (CP2).**
   - It appears on the Projects list (it replaces "done / total"), in the agent home and Projects rails
     (a 40 px decorative bar), and on the Board as a "Plans on this board" strip. A Working card's
     looping dot became the indeterminate bar.
   - It is drawn only from counts the record keeps, and is indeterminate where nothing was counted.
   - Its model is `client/console/progress-bars.ts`.
3. **Name (CP3).**
   - Display strings across 30 client files say Nectovia. The wordmark and mark are
     `NectoviaMark.tsx`.
   - Settings > About reads "Nectovia by Diomedes Systems." and then the installed version.
   - `client/attribution-display.ts` renames the application only where an origin is formatted for
     display. Recorded History text and engine and model names are never renamed.
4. **Devices (CP4, CP7).** Only where they carry meaning:
   - The plate marks the person's input (composer, palette), live work (open run record, outcome
     card), and what needs the person (needs-you, document conflict, Workbook needs notice).
   - The rail seam, the status glyph, mono instrument labels, and the send and primary bevels.
5. **Agent home (CP5).** Built to Home.dc.html:
   - A date, a greeting with one serif accent phrase, and "Across your projects": rows with a glyph, a
     label, a sentence, an Open button and a real progressbar.
   - Bust A over the horizon with its registration mark.
   - Once a session, bust B arrives as the fractured signal and resolves to A.
6. **Transitions (CP6).**
   - Views shear in over 160 ms, with two tear lines.
   - The strip seam draws.
   - Plates settle, and their lit edge draws last.
   - The needs-you band slides in and holds off register for two frames.
   - A completed segment snaps.
   - Every duration is multiplied by `--nv-on`, which is 0 under the reduced setting, the media query,
     preset none and intensity 0.

**Fixes that apply to every scheme:**
- **Rail point.** Rail.tsx measured the selected button's `offsetTop` inside a positioned `li`, so
  the rail point always sat on the first row. It now measures the `li`.
- **`.seg` collision.** console.css's segmented control rule `.console .seg` reached the segment
  bar's spans, and its `margin-left: auto` collapsed a segment to zero width. segment-bar.css now
  resets the segment's box.
- **One task, singular.** The task count said "0 of 1 tasks done", and now says "task" for one
  task. The register caption and `aria-valuetext` come from `progress-bars.ts`; the rail sub lines
  come from `Home.tsx` and `diomedes-view.ts`, where the wording predates this lane.

## Hot-file hunks

| File | Hunks | What |
| --- | --- | --- |
| `server/app.ts` | 1 | `'nectovia'` added to the appearance package allowlist. |
| `server/store.ts` | 1 | Default `appearance.package` `'field'` to `'nectovia'`. |
| `desktop/main.mjs` | 3 | `FIELD_TITLEBAR` gains `nectovia: ['#08080c', '#e6e9ed']`. New `windowBackground()` returns the stored scheme's chrome: a custom theme's chrome, else the scheme's pair, else `#08080c` when no settings exist. `backgroundColor: '#16191d'` becomes `await windowBackground()`. It is more than a colour swap: before the window opens, it reads `settings.json`. For a custom theme it also reads the workspace identity and the theme's pack, through the existing `customTitleBar()` that the title bar already uses. Any failure falls back to ink. A fixed ink would make every Field install open on the wrong ground. For a Field install, the pre-paint colour moves from `#16191d` (Field's surface) to `#121417` (its chrome, which the Console's ground and title bar already are). The names (`title`, `setName`, `showErrorBox`) are untouched. |
| `shared/theme-pack/types.ts` | 2 | Additive: `'nectovia'` first in `BASE_THEME_IDS`, and its `BASE_THEME_COLORS` entry. |
| `client/console/Shell.tsx` | 7 | The attribution import now comes from `../attribution-display`; the `Mark` import becomes `NectoviaMark`; `import './nectovia.css'`; three copy strings (a notice, the Settings hint, the destination group heading); `<Mark />` becomes `<NectoviaMark />` in the header. |

Not touched: package.json, package-lock.json, shared/types.ts, client/api.ts, server/native-work.ts.
No `npm install` was run.

**Files shared with the artifacts lane:**
- `client/console/ThreadView.tsx`, 2 hunks: the attribution import path, and one aria-label.
- `client/console/Diomedes.tsx`, 8 hunks:
  - the `ReactNode` import, the `speakerName` import and the `nectovia.css` import
  - two optional props, `brief` and `art`, plus their destructuring
  - `{art}` as the screen's first child and `{brief}` before the turns
  - the `busy` class on the composer div
  - copy: CAPS, the `main` aria-label, the h1, the unconfirmed notice, and the textarea's label and
    placeholder
- The segment bar copies differ from the model-artifacts worktree's. Take this lane's
  `SegmentBar.tsx` (the `decorative` prop) and `segment-bar.css` (the `.seg` reset, and a still
  indeterminate track under reduced motion). `segment-bar-model.ts` and `tests/segment-bar.test.ts`
  are identical.

**Other small TSX edits:**
- `App.tsx`: `paintedScheme`, the glyph in the legacy bar, and copy.
- `DiomedesHome.tsx`: the `scheme` prop, and brief and art only under Nectovia.
- `Composer.tsx`: the `busy` class, and copy.
- `Rail.tsx`: the seam SVG in `.gp`, the `li` measurement fix, and the `progress` row.
- `Home.tsx` and `BoardView.tsx`: segment bars.
- `diomedes-view.ts`: rail progress.
- `TopStrip.tsx`: the mark.
- `motion.ts`: one import, and one `drawHeaderSeam()` call.
- `Mark.tsx`: one comment line.
- `console.css`: the `.gp .seam` hide for other schemes, and the rail progress grid.

The remaining edits are copy only.

## Tests

**Added (unit, vitest):**
- `tests/name-contract.test.ts` (13). A TypeScript-parser scan of every client string for the old
  product name, with an allowlist that has reasons and fails when stale, and a probe that proves the
  scan catches. It also checks the mark's geometry and its single `[data-mark-point]`, and that the
  trail drops at 18 px. It covers Brand and Wake, the three mark sites, and the attribution mapping,
  which never renames a model. Last, contract A3: the desktop names, the window title and
  `index.html`'s title still say Diomedes.
- `tests/progress-bars.test.ts` (15). No tasks, some done, one task in the singular, running,
  waiting, failed, more than 12 tasks, plan grouping and order, deleted tasks, and the decorative
  markup.
- `tests/home-brief.test.ts` (16). Count words, greeting hours, the date format, row order and
  sentences, the accent priority, the 5-row cap and closing line, no dashes or exclamation marks,
  the signature decision (once a session, under all stillness forms, and when storage fails), the
  signature's shape and clock in nectovia.css, and static renders of HomeBrief and HomeArt.
- `tests/nectovia-motion.test.ts` (8). The seam Web Animation, and that it never runs outside
  Nectovia or under stillness. The keyframes move only transform, opacity and clip-path. Every
  animated clip-path is an inset at both ends. Every animation carries `var(--nv-on)`. The
  view-change numbers stay inside the contract, and no shear, ghost or need animation fills forwards.
- `tests/nectovia-scheme.test.ts` (3). Every rule is anchored, except four remove-only rules whose
  body must be exactly `display: none`. Design Center stage-drawn selectors carry the exclusion. The
  plate host defaults are `:where`, so each host's own values win.

**Added (Playwright):** `tests/nectovia-skin.spec.ts` (5), in `playwright.config.ts` testMatch. It
chooses schemes through the Settings radio, and snapshots and restores the shared service's settings.
1. Nectovia's tokens, the mark, the composer plate's bevel (a polygon `::before`, a 16 px `::after`)
   and the strip seam. It takes screenshots of every screen, including at 1100 px.
2. The segment bars' ARIA values on the agent home, and the Projects list caption.
3. The signature plays once a session: the bands go, and a reload does not replay it.
4. Reduced motion: the home is still, with no bands and `document.getAnimations()` empty.
5. Field: `--chrome`, `--surface`, `--t1` and `--light` equal today's values, with no plate, brief,
   art or bust.

**Changed (pins moved, none loosened or deleted):**
- `backend.test.ts`: the scheme list gains `nectovia`.
- `design-center.test.ts`: the exemption list gains `nectovia`; the reason is in the comment.
- `desktop-shell-title-bar.test.ts`: keeps Field's overlay literal, which is app-updates.mjs's
  pre-settings overlay and unchanged. It adds a text check of main.mjs for Nectovia's pair and the
  stored-scheme first paint.
- `design-studio-ui.spec.ts` D01 to D03: expect the new default (`nectovia`, `--surface #0d0d12`).
- `ai-setup-states.test.ts` (8 strings), `diomedes-view.test.ts` (2) and
  `attribution-shared-ui.test.ts` (1 renamed, and its two negative checks now refuse "Nectovia" too).
  These moved because the displayed name changed. `diomedes-view.test.ts` also gains one test: the
  rail's task count, with one task in the singular.
- `ui.spec.ts` (6 lines), `home-luna.spec.ts` (2), `home-route-ownership.review-20260921.spec.ts`
  (2), `ai-engines-ui.spec.ts` (12 client strings; fixture data and served paths unchanged),
  `diomedes-home.spec.ts` (composer, headings, card titles) and `autonomy-ui.spec.ts` (1). The
  displayed name changed. Server-written names (the thread named "Diomedes", fixture details) are
  unchanged and still pinned.

## Gates

| Gate | Result | Source |
| --- | --- | --- |
| `npx tsc --noEmit` (final) | clean, exit 0 | scratchpad `tsc-final.log` |
| `npx vitest run` (full, final) | 258 files, 4748 passed, 4 skipped, exit 0 | scratchpad `vitest-final2.log` |
| `npx vite build` | built, inside every heavy-slot run. The chunk-size warning and the zod comment warnings (from the junctioned node_modules) are not from this lane. | heavy-slot logs |
| Playwright, the skin spec alone (run 2) | test 1 passed, then failed in `openHome`; 4 did not run | scratchpad `pw-inspect2.log` |
| Playwright, the skin spec alone (run 3) | 4 passed, 1 failed (`check()` on a radio that follows the save) | scratchpad `pw-inspect3.log` |
| Playwright, the named gate plus the touched specs (confirm run) | **132 passed, exit 0** (4.8 min, 1 worker) | scratchpad `pw-full.log` |

The confirm run covered ten spec files, all passing: ai-engines-ui 21, autonomy-ui 3,
design-studio-ui 17, diomedes-home 33, field 8, home-luna 15, home-route-ownership.review-20260921 2,
native-ui 11, nectovia-skin 5 and ui 17. It ran on ports 5194 and 47652, because foreign
`nectovia-routing` processes hold 5174 and 47632. The suite rewrote 12 PNGs under `evidence/` and 9
under `docs/verification/2026-09-17-design-center/`. Both paths were restored with `git restore`
afterwards.

**After the confirm run**, the Field shots showed "0 of 1 tasks done". This lane's register caption
and progressbar `aria-valuetext` used that wording, and it was already in the two rail sub lines
(`Home.tsx`, `diomedes-view.ts`). All three now say "task" for one task. New unit tests cover it:
`progress-bars.test.ts` and `diomedes-view.test.ts` each gain one. No Playwright spec pins a singular
count; the only pins are "2 of 4" and "3 of 3" in the skin spec. So this change is verified by tsc
and vitest (the two rows above), not by a new browser run.

Earlier vitest runs:
- After CP3: 255 files, 4719 passed (`vitest-cp3b.log`). The first CP3 run failed 9 tests, all pins
  of the old strings, which moved as listed above (`vitest-cp3.log`).
- After CP7: 258 files, 4746 passed (`vitest-cp7.log`).
- After the fix batch: 258 files, 4746 passed (`vitest-final.log`).

## Where the build differs from the canvases, and why

- **The report's rows are projects, not events.** This is the largest structural difference. Home.dc.html's
  "Since yesterday" rows are single pieces of work ("The 4 Sep receiving note is missing", "Comparing
  four delivery records"). Here each row is one project in its most pressing state (needs you, then
  working, then done), with that project's task bar. No record of what changed since yesterday
  exists to report from, and a project's status record is the one source that is always true. The
  report is titled "Across your projects" to say so. A per-event report would need a new record: a
  decision for Andrew, not a skin change.
- **Agent home layout.** The composer stays at the foot of the conversation, because the page is a
  conversation. There are no suggestion chips: nothing in the product supplies them, and they would be
  invented. The date follows the person's locale.
- **The horizon** spans the art column, not the whole page. The report and the conversation beside it
  change height, and a page-wide rule would cut through them.
- **The bust's size.** It fills its column (40% of the screen, as in the canvas) less the canvas's
  28 px, up to the canvas's 540 px. The canvas's bust is 540 px and overhangs the text column by
  88 px; here it never enters the conversation's column. Measured in the 1440 by 900 shot:
  - the art column is 467 px (the horizon runs from x 953 to 1419)
  - the bust's box is 439 px, and the plaster itself is 365 by 444 px
  - the registration mark's runs are 88, 4, 22, 4 and 6 px
- **The ledger** zero-pads each section's number rather than each section's count, so counts keep
  their words.
- **The thread title** does not draw the serif "with Nectovia" accent. A thread may be worked by a
  direct engine (Decision 8), and the title would then name the wrong worker.
- **View changes.** The contract's outgoing content "splits into 3 bands", but React unmounts the
  outgoing view, so the tear lines belong to the incoming screen.
- **Decision number.** The brief asked for "Decision 10", which is taken ("History is evidence"). The
  proposal takes 15.

## Browser verification

There were three inspection runs of the skin spec alone, then one fix batch, then the confirm run.
The gates table above lists every run and its log.
- Run 1 was refused by the dev-server guard, because foreign processes hold the default ports.
- Run 2 found that `openHome` must go through Projects, because inside a session the window keeps its
  place.
- Run 3 found the radio `check()`.

The fix batch changed:
- **`chooseScheme` in the spec.** It now clicks the radio and waits for it, as field.spec does.
  `check()` wanted the change at once, but the radio turns on only when the save returns.
- **The bust.** It now has the canvas's 40% column and the canvas's 28 px offset.

Screenshots from the confirm run are in the session scratchpad's `evidence/app-skin/`:
- Nectovia at 1440 by 900: thread, dialog-palette, board, history, files, settings, projects, home
  and home-every-row.
- Nectovia at 1100 by 800: home and thread. At this width the art column steps aside, and the top
  strip takes two rows, as it does in every scheme.
- Field at 1440 by 900: home, thread, dialog-palette, board, history, files, settings and projects.

The Field shots show today's Field. The strip keeps its charged rule, the rail its dot, and the
palette its rounded panel. Ledger sections are not numbered, and there is no brief, art or plate. The
segment bars appear there too, because they are a feature and not skin.

`nectovia-home-every-row` intercepts the projects request to give one project an open need and a
running task. A project appears in one row only, so the shot shows the Needs you and Done kinds; the
Working kind is covered by the unit tests. `nectovia-home` shows the service's real state.

## Known gaps

- The home and project thread names ("Diomedes") and recorded History sentences are server data.
  They are unchanged, and the product record lists them.
- The window title, taskbar name, native dialogs and app icon still say Diomedes (contract A3).
  These are Andrew's decisions.
- `desktop/app-updates.mjs`'s pre-settings title bar overlay stays Field's colour for the moment
  before settings are read.
- On the very first app load, the home renders one frame without the art before the painted scheme
  is known, so the view shear is cut short on that load.
- The Design Center case "app on Field, stage previewing a Nectovia-based theme" is covered by the
  selector tests, not by a browser test.
- The ThemePack contract gained `nectovia`. The site rejects Nectovia-based themes until
  `npm run theme-pack:handoff` runs.

## Not verified in a browser

- **Unrun specs.** Fourteen specs in testMatch were outside the brief's gate and did not run:
  first-task-handoff, change-review-ui, reviewer-ui, agent-ui, app-updates-ui, workspace-ui,
  configuration-ui, file-imports-ui, fd02-discovery, fd03-readiness, files-pane-ux-20260917,
  h01-preview-repair, independent-h01-final-20260917 and allowance-ui. A scan found no renamed
  string pinned in them, only fixture data and an installer asset name. They could still be affected
  by layout changes that apply in every scheme: the Projects register's Tasks column (92 to 136 px),
  the Board's plan strip, and the rail's `li` measurement fix.
- **`windowBackground()`.** Electron was not launched. The function is checked only by a text scan of
  `main.mjs`. Its try/catch falls back to ink.
- **CP7 screens.** The devices on Team, Change review, the Run inspector, Readiness and the document
  conflict panel were not on the brief's shot list. They are held by selector tests only.
- **Stillness settings.** The browser test covers reduced motion through the media query. The reduced
  setting, preset none and intensity 0 are unit-tested only.
