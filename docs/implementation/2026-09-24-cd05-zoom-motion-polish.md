# CD-05: 200 percent zoom (C47), reduced motion (C49) and an accessibility sweep

Date: 2026-09-24 · Lane: `cd05-zoom-motion-polish` · Branch: `feature/cd05-zoom-motion-polish`
Linear: DIO-76 (CD-05 — Primary Diomedes conversation and work inspector)

The 2026-09-21 package-scope audit kept CD-05 open because "the C47 200-percent-zoom leg and C49
reduced-motion have no executed evidence in the reviewed record"
(`2026-09-21-core-agent-package-scope-review.md`, `2026-09-21-core-agent-package-scope-reconciliation.md`).
This slice executes both legs in a real browser, fixes what they found, and sweeps the same screens
for accessibility defects. It does not claim the rest of CD-05's open evidence (a populated results
ledger, the packaged AWS journey, a live Luna call and spend).

## How zoom is exercised

Chromium's page zoom is a CSS viewport of half the window at twice the device pixel ratio. The spec
runs two windows at 200 percent:

| Window | At 200 percent |
|---|---|
| 1440 x 900 | 720 x 450 CSS px, deviceScaleFactor 2 |
| 800 x 600, the desktop's minimum (`desktop/main.mjs`) | 400 x 300 CSS px, deviceScaleFactor 2 |

The minimum window width is unchanged (it is Andrew's decision).

## What was found and fixed

**C47, the work column and the inspector.** Under 860 px the stage stacks the rail over the screen,
and the stage never scrolled. At 720 x 450 the rail alone was 325 px of a 370 px stage: the work
screen got 45 px, the composer sat below the fold of a box nothing could scroll, and the thread's
inspector (the ledger) was `display: none`. The same inspector was also hidden for any app narrower
than 1100 px, which is 200 percent of a 1920 px window.

- The narrow stage scrolls (`overflow-y: auto`, `overflow-x: hidden`) and is a size container. The
  rail keeps its height; a screen's work column is never shorter than the visible stage (up to 24rem)
  or than its heading, instruments and composer need (`minmax(min-content, 1fr)`), so the composer
  never spills over what sits under it.
- From 1100 px down the thread's inspector stands under the conversation with its own scroll, as the
  Diomedes page's ledger already did (`diomedes.css`), instead of going away.
- The Files pane overlays the screen's own grid area rather than the stage's first screenful.
- Compact Board columns wrap (`auto-fill, minmax(min(100%, 210px), 1fr)`) instead of scrolling the
  board sideways with "Working 0 of 1 slot" cut at the edge.

All of it is additive CSS in `console.css`, `files.css` and `board.css`. Decision 6's single `.col`
rule is untouched.

**C47 at the minimum window.** At 400 x 300 three more things failed:

- The app container's own `@container app (max-width: 700px)` rules come after the window rule and
  put the stage back to `auto minmax(0, 1fr)`. The same stage rows are restated there.
- `styles.css` pins the Workbook-era `.top-right` to `height: 40px` under 600 px, and that rule
  reached the Console strip. When its controls wrapped, Cloud sharing and the Interface detail menu
  painted over the rail. The Console strip's row now grows with its controls.
- The sideways rail and the Settings section tabs left focused buttons half past their edge. Chrome
  does not scroll a partly visible focused element in, so the rail's foot and the Settings sections
  now wrap.

**Accessibility sweep.**

- Dismissing the Ctrl K palette (Escape or the veil) returned focus to the composer, not to whatever
  opened it (WCAG 2.4.3). It now restores the opener when that is still on the page; running an
  action from the palette still lands in the composer, as before.
- The Console header's Interface detail menu had no Escape or outside-click close at all (the
  pre-entry strip's copy did). It now closes on either, and Escape returns focus to its button.
- The spine's guiding point is decoration and is now `aria-hidden`.

**C49.** No product change was needed. The global rule in `styles.css` already stops every CSS
animation and transition under both `prefers-reduced-motion: reduce` and `html[data-motion='reduced']`,
and every Web Animation call site (`nectovia-motion.ts`, `motion.ts`, `Composer.tsx`, `TeamView.tsx`)
checks the setting first. This slice adds the evidence: the browser checks and the source contract
below.

## Evidence

`tests/cd05-zoom-motion.spec.ts` (13 cases, added to `playwright.config.ts`):

- **C47**, at both windows: the Diomedes page; a project thread opened on its task, so the ledger is
  that work's inspector; the Board; Settings > Engines; and the screens that landed on main alongside
  this lane (Automations, Settings > Permissions and Rules). On each: no sideways page scroll and no
  box painting past its width. Every visible control, once scrolled to, is inside the viewport and is
  the element under its own centre, and it does not clip its text without an ellipsis. The long project
  name is truncated or wrapped wherever it is written (decision 5). A Tab walk shows a visible ring
  at every stop and reaches each screen's primary actions, including a stop inside the inspector.
- **C49**: a control case proves the checks can fail (with normal motion something transitions). The
  whole Console is then driven (the Diomedes page, the thread, a composer mode change, Board, Team
  and Thread, the style menu, the palette, Settings > Engines) under the OS query, and again under
  the app's own Reduced setting with the OS asking for motion. On every element and pseudo-element,
  computed animation and transition are none or zero, and no Web Animation is running.
- **Sweep**: focus returns to the opener of the palette, the style menu, the worker menu and the
  Interface detail menu; no control on those screens is unnamed; body text meets 4.5:1 (large text
  3:1) in the dark Nectovia scheme and the light Paper scheme. Colours are resolved by painting them,
  so `color-mix()` and `oklab()` values compare like any other.

`tests/nectovia-motion.test.ts` gains a whole-Console section:

- the global stillness rule exists under both the query and the setting;
- no other stylesheet outranks it with an `!important` animation or transition;
- every `.animate(` call site in `client/` carries a stillness guard.

Screenshots: the repository's acceptance convention writes run screenshots under `test-results/`
(ignored), and this lane adds no binary evidence files.

## Gate results (this branch after merging `origin/main` at `9bd5147`)

- `npx tsc --noEmit`: exit 0.
- `CODEX_HOME=$(mktemp -d) node node_modules/vitest/vitest.mjs run --maxWorkers=3`: 361 files passed,
  1 skipped; 6402 tests passed, 16 skipped.
- `npx vite build`: built.
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts tests/cd05-zoom-motion.spec.ts`:
  49 passed.
- The specs nearest these CSS changes (`files-pane-ux-20260917`, `nectovia-skin`, `console-view-ui`,
  `instructions-inspector`, `ready-queue-ui`, `diomedes-home`, `home-luna`, `automations`,
  `first-task-handoff`): 78 passed.

`playwright.responsive.config.ts` (`responsive.spec.ts`, `readability.spec.ts`, which are not in the
gates) fails 19 of 20 on this branch and fails the same 19 on a clean `origin/main` worktree at
`9bd5147`. The failures are pre-existing and not this lane's.

## Known gaps and deferred

- Nectovia has no built-in light variant; a light Nectovia exists only as a custom theme pack. The
  light contrast leg runs on Paper, the built-in light scheme.
- The contrast check reads text over background colours. Text over a background image (the Nectovia
  plates and the art) is not measured.
- Focus-indicator contrast (WCAG 2.4.11) is not measured, only that a ring is drawn. The composer's
  textarea relies on its box's focus-within border rather than an outline of its own.
- Board status points carry colour, but each row sits under a text column heading that names its
  state, so colour is never the only signal. Nothing was changed there.
- The Team view and the Design Center were not in this sweep.
- `responsive.spec.ts` and `readability.spec.ts` are red on main (above) and need their own lane.

## Proposed canonical-doc patch

Not applied: the canonical documents are outside this lane.

- **Roadmap, CD-05 row**: C47 (200 percent zoom, both the 1440 x 900 and the minimum 800 x 600
  window) and C49 (reduced motion under the OS query and the app setting) now have executed browser
  evidence in `tests/cd05-zoom-motion.spec.ts`. CD-05 remains open for the populated results ledger,
  the packaged AWS journey and the live Luna call and spend.
- **Project memory, Console UX meanings**: add "Below 1100 px the work inspector stands under the
  conversation; it is never hidden by width alone. Below 860 px the stage scrolls, and a screen's
  work column keeps at least the visible stage's height."
