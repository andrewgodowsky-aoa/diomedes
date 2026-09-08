# 4b — Workbook Field re-skin

Worktree `field/density-20260908`, uncommitted on top of `cd43437` (Wave 3).
Re-skin only: every page, control, label and test id is unchanged; only how
they look changed. No text, roles, aria labels, data-testids or behaviour
were touched.

## Screens touched and what changed (all in `client/styles.css` unless noted)

- **Top bar (CSS only; markup lives in `client/App.tsx`, untouched).**
  40 px hairline-bottomed strip. Wordmark is tracked type
  (400, 14 px, 0.32em) with the underline bar hidden (`.brand i`).
  Project tabs lost the tab box and cyan top bar: `--t2` text, the open
  project is `--t1` at weight 500. Status is the point (`Mark` → circle,
  live/hollow/amber/fault) followed by the sentence. Settings is a quiet
  `--t2` button that lifts to `--t1` on hover, no background.
- **Left nav (Workbook + Settings rails).** Active page: `--t1` at weight
  500 with an 8 px `--light` point in the gutter, no cyan bar, no fill.
  Rest is `--t2`. A 1 px spine (`--hair-2`) runs down the nav gutter;
  both are suppressed in the ≤600 px row layout. Counts are tabular mono;
  rail descriptions are secondary 14 px.
- **Home.** Doors stay a 2×2 hairline-separated grid (one outer hairline
  frame, no per-door boxes). Each door title carries a point
  (`client/Workspace.tsx`: `square` → `pt`; hollow `--t3` ring).
  "New document" and every primary are now a 1 px `--light` border with
  `--light` text on transparent — never a filled cyan block. Recent-thread
  mode names are unboxed mono text (`.mode-chip` keeps its text and
  `data-mode`, loses the box; `fix` stays amber).
- **Ask.** Thread rows keep their classes (tests pin `.console-thread`):
  name with mono time at right, one-line ellipsis, current row `--t1`
  with a `--light` point in the gutter (`client/Workspace.tsx` wraps name
  + meta in `.console-thread-row`; meta becomes `.thread-meta`).
  The mode control is a mono strip (11 px uppercase, transparent ground,
  hairline base; current is `--t1` with a 1 px `--light` underline).
  The composer is a 6 px `--raised` panel. Send is quiet `--t3` while
  disabled and turns `--light` text only when the box is non-empty
  (pure `:not(:disabled)` CSS; `disabled` logic untouched).
- **Tasks.** Column headers are hairline-topped with mono uppercase labels
  and tabular mono counts. Points: To do hollow, Working live (with the
  live glow), Waiting amber, Done `--t3`-filled. Board/List toggle is a
  quiet segmented control (current is `--t1` on `--raised`). Card Start
  buttons keep their `primary` tone but render as light-outline now.
- **Settings.** Appearance swatches are 12 px points in each scheme's own
  light colour (`client/Settings.tsx`: `palette-swatch` → `palette-dot`;
  the old 32×22 preview rules are gone). Engines states are points plus
  text via the shared `.mark` change; usage bars and engine meters are
  byte-identical. Interface-detail radios, Setup and landing styles follow
  the button/quiet-link rules.
- **Everywhere.** No box-shadow anywhere in `styles.css` (the single
  exception is the live-point glow, which the system allows). No
  `border-radius` above 6 px except point circles. `h1` 20→18 px (500),
  `h2` 24→20 px, `h3` 16→14 px, Setup title 24→20 px, task titles 17→14 px,
  project names 16→14 px, door titles 17→15 px. Hover states that were
  cyan (document/reference/project rows, task titles) are `--t1`.
  `.page-frame` top is a 1 px hairline (amber/red kept for
  needs-attention/disconnected). Focus rings, `accent-color`, diff
  added/removed colours and signal/fault text are untouched.

## Deliberate deviations from the brief (test-pinned)

`tests/ui.spec.ts` (F17 block) fails any text-bearing element under 14 px
and any button under 35.5 px on Workbook Home, so the Console scale
(13.5 / 12 / 11 px) applies only where Home renders no direct text:
- Body stays 14 px (not 13.5); `.caption`, `.code`, counts, rail
  descriptions, door copy, mode names and thread meta held at the 14 px
  floor with hierarchy carried by colour/weight/mono instead.
- 11 px mono survives only in the composer mode strip, the Ask
  `THREADS` label and `key-hint` (none on the checked page), plus
  textless points/dots.
- Mode names keep source case ("Fix, try 1 of 3"): CSS lowercasing would
  risk the `toContainText('Fix, try 1 of 3')` assertion.

## Left for Fable (needs `client/App.tsx`, off-limits here)

1. Top-bar mark glyph: render `<Mark />` (or the console `dm-mark`) before
   the wordmark, e.g. in `App.tsx` inside `.brand-button` ahead of
   `<Brand />`; no CSS needed (`.top-bar` already reserves 16 px padding).
2. Landing doors (`App.tsx` projects-page `.intent .square` ×3 and the
   empty-state copy): rename `square` → `pt`. CSS already styles both
   identically, so this is cosmetics-only.
3. Remove the `<i aria-hidden>` bar from `Brand` in `client/components.tsx`
   (currently hidden by `.brand i { display: none; }`).
4. Optional hierarchy pass (not a re-skin blocker): several screens carry
   more than one `tone="primary"` button (e.g. each To-do card's Start
   plus the header's New task). Tones were left as authored; all render
   as quiet light-outline now.

## Nothing taken from `client/console/`

`client/console/Rail.tsx` renders `spine console-threads` /
`console-thread` rows inside `.console` (styled by
`client/console/console.css`), so the base `.console-threads`,
`.console-thread*` and `.console-side-header` rules in `styles.css` are
**kept** with a comment header; every Workbook restyle of that markup is
scoped under `.workspace` (higher specificity, zero effect on the rail).
`.choice-row` is kept for the Settings model/effort pickers.

## Rules removed from `client/styles.css` (2802 → 2625 lines, −177)

- Deleted `client/Console.tsx` (1365 lines; grep confirmed zero imports).
- Deleted block 1 (old `/* ---- The Console ---- */`): `.console`,
  `.console-loading`, `.console-side/.console-right`, `.console-project`,
  `.console-team/helper/engine/side-action`, `.console-pane*` (all),
  `.console-panes`, `.console-tabs`, `.console-right-body`,
  `.console-board/column/files/changes`, `.console.disconnected`,
  the 1280/1040 `.console` media queries.
- Deleted block 2 (`permission/member/team`): `.console-permission`,
  `.console-member*`, `.console-side-sub`, `.turn.team`, `.console-composer-modes`.
- Deleted `.console-pane-send select` (both), `.console-effort-note`,
  `.console-honest`, `.console-pane-meta .usage-bar`,
  `.console-member .usage-chip`, `.console-pane-header .helper-caption`,
  `.console-column` from the tabular-nums list, the `.palette-swatch` ×3
  rules, the `.brand i` bar + `draw-rule` keyframes, and the filled
  `.button.primary` (`#80eaf3` is gone — no hard-coded dark colours;
  ember/paper verified visually).
- Kept verbatim: `.choice-row`, `.open-console`, `.text-button`
  (restyled quiet), all `.usage-*`/`.engine-meter*` rules, `.filter-chips`,
  `.mode-chip` (restyled unboxed), `.turn .helper-caption`.

## Verification (exact summaries)

- `npx tsc --noEmit` — clean.
- `npx vitest run --configLoader runner` —
  `Test Files  10 passed (10)` / `Tests  227 passed (227)`.
- `npx vite build` then
  `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts` —
  `17 passed (26.9s)`.
- Visual: dev server on 5184/47644 with `.data-4b`, onboarding skipped,
  project "Reopening the patio" + 3 tasks (one moved to done). Walked
  Home, Ask, Tasks, Settings > Appearance at 1440 and 1000 px, ember and
  paper schemes: no hard-coded dark colours (Ink dot on paper is the
  scheme's own white point, by design). Server stopped and `.data-4b`
  removed after.

Note: one full-suite run mid-task showed the Usage chip test timing out
because the local Codex runtime was `available:false` with empty usage
windows in that fresh data dir (chip renders only when
`tightestWindow()` is non-null — App logic and `.usage-chip` CSS are
untouched by this diff). The final run is fully green, so no action taken.
