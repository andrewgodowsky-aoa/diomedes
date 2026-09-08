# Brief 7a — Console field polish pass (verifiers' findings 1–8, 13, 14, report-09 G1)

Working tree at finish: only `client/console/**`, `tests/field.spec.ts` and this report touched by this pass.
The tree also carries other passes' dirty files (`client/Workspace.tsx`, `client/components.tsx`,
`client/Settings.tsx`, `client/styles.css`, `tests/ui.spec.ts`, other `7-*.md` reports) — not opened for
writing here. No commit, no stash. Dev server on 5201/47661 stopped at the end (port 47661 free).

Measurement setup: background `scripts/dev.mjs` (`DIOMEDES_CLIENT_PORT=5201`, `DIOMEDES_PORT=47661`,
`DIOMEDES_DATA_DIR=.data-7a`), Edge via Playwright at 1440×900 and 1000×760, project with 7 tasks,
3 team lanes, `document.fonts.ready` awaited before every number. Screenshots in
`F:\Temp\andre\opencode\shots-7a\` (kept outside the repo).

Key discovery, read first: the Console renders under a product-designed UI zoom —
`App.tsx` sets `--dm-ui-scale: 0.95` on the console surface (`html { zoom: var(--dm-ui-scale); }`,
"the Console fits more at 0.95"). Every `getBoundingClientRect` number therefore reads 0.95× the
layout px the prototype's rules produce. Evidence: a synthetic 100 px box measures 95 px;
`document.documentElement` computed `zoom` is `0.95`. Where a target below is compared against the
prototype I report **layout px** (`offsetHeight`, zoom-independent); screen rects are 0.95× by design.
The verifier's old height failures were dominated by the 36 px global hit-target leak
(36 × 0.95 = 34.2 ≈ the reported 34 px), now removed — not by the console rules, which were already 1:1.

## 1. Team lanes stack below 1100 px

- Change: `client/console/TeamView.tsx:383` inline
  `style={{ gridTemplateColumns: ... }}` replaced with
  `style={{ ['--lane-count' as string]: String(ordered.length) } as CSSProperties`
  (added `type CSSProperties` to the react import, line 1); `client/console/team.css:38-45`
  `.console .lanes` gained `grid-template-columns: repeat(var(--lane-count, 1), minmax(0, 1fr));`.
  The existing `@media (max-width: 1100px)` rule (`grid-template-columns: 1fr`) now wins below 1100 px.
- Measured: at 1000×760 `getComputedStyle(.lanes).gridTemplateColumns` is a single `764.671px` column
  (screenshot `team-1000.png` shows three lanes stacked vertically); at 1440×900 it is
  `385.263px 385.28px 385.263px` side by side (`team-1440.png`, `walk-team.png`).
  `--lane-count` reads `3`; stream cap `maxHeight` reads `240px`.

## 2. Board head mono back to 11 px

- Change: `client/console/BoardView.tsx:198` `<span className="mono ctx">` → `<span className="mono">`
  (the `.bhead .ctx` 12.5 px rule stays for the non-mono context span it was written for);
  `client/console/board.css:18-22` `.console .bhead h1` gained `letter-spacing: normal`
  (the measured −0.18 px came from the global Workbook `h1 { letter-spacing: -0.01em }` leaking in,
  since the `font` shorthand does not reset tracking).
- Measured: `.bhead .mono` computes `font-size 11px`, `letter-spacing 0.88px`, class is now exactly
  `mono`; `.bhead h1` computes `letter-spacing normal` (`walk-board.png`: `WALK SEVEN A … · 1 TASKS`
  renders in 11 px uppercase mono next to the 18 px title).

## 3. Board row second lines keep the mono uppercase

- Change: deleted the `client/console/board.css:134-137` block
  `.console .crow .x .mono { text-transform: none; letter-spacing: 0; }`. The `.crow .m .mono` override
  (worker/age line) is kept, as is the prototype's single override.
- Measured: `.crow .x .mono` computes `text-transform uppercase` (letter-spacing `0.92px`);
  screenshots show `THIS THREAD` in uppercase mono on the focus row and `PROPOSAL, …`-style lines
  uppercase (`board-ready-hover.png`, `walk-board.png`). (Source strings are lowercase, so this was
  verified via computed style, not `textContent`.) Nothing else in `.crow .x` depended on lowercase —
  `.why`/`.here` colour rules untouched.

## 4. Mode strip spring settles in 267 ms

- Change: `client/console/motion.ts:136-158` `spring()` keeps `k 210, c 22, m 1, dt 1/120` and the
  explicit-Euler integrator, but the exit test is now relative to the trip
  (`nearX = max(0.15, span*0.01)`, `nearV = max(2, span*8)`), the loop is capped at `0.29 s`, and the
  doc comment (plus the `Composer.tsx:83-87` comment) now says "relative exit test, 267 ms budget".
  Max 32 frames → 267 ms; worst-case residual 0.8 px closed by the final exact frame.
- Measured in the running app: switch ASK→PLAN→BUILD, then
  `document.querySelector('.console .modes .ind').getAnimations()[0].effect.getTiming().duration`
  is `267`, and the `.ind b` scaleX animation is `142` — both ≤ 300.

## 5. No fifth TEAM mode in the composer strip

- Change: `client/console/Composer.tsx` — deleted the `{member && (…Team…)}` button block, the
  `toTeam`/`onTeam` props, and every `toTeam` reference (`ready`, the `active` lookup, the
  `[width, dashed]` ternary, `aria-checked`/`className`, the `onTeam(false)` in mode clicks,
  the placeholder ternary, the `mode === 'build'/'fix'` guards, the `submit()` guard, the `.cap`
  ternary, and the `useLayoutEffect` dep). The now-unused `member` prop and `TeamMember` import were
  removed from `Composer` as well. `client/console/ThreadView.tsx` — dropped `toTeam`/`onTeam` and
  the dead `if (toTeam && member)` branch; `onMessage` removed from `ThreadView` only (nothing else
  there used it). `client/console/Shell.tsx` — removed the `toTeam` state and the two `ThreadView`
  props plus the two `setToTeam(false)` calls it required (`changeMode`, thread-select effect);
  `messageMember` and the Team view's `onMessage` wiring untouched, as are the two unrelated
  `onTeam={() => setView('Team')}` Ledger props.
- Measured: `.modes` innerText is `ASK PLAN BUILD FIX` (was 5 buttons; strip no longer widens to the
  254 px fifth-button layout). `grep` before/after: no test references the Team mode button
  (`field.spec`/`ui.spec` hits are rail view buttons and `.team` locators only).

## 6. Chrome controls match the prototype (scoped reset, layout px)

- Change: `client/console/console.css:23-33` `.console button` gained `min-height: 0` plus the
  prescribed comment (the `padding: 0` reset was already there — the remaining leak was only the
  Workbook `button, input, select { min-height: 36px }`); `client/console/console.css:103-108`
  `.console .composer` gained `padding: 0` — the composer was still taking the Workbook
  `.composer { padding: 4px 14px 12px }` (measured `90.36px` tall before, `75.17px` rect after).
  No other console rule needed touching: picker/seg/toggle rules were already 1:1.
- Measured (layout px via `offsetHeight`, i.e. what the 1:1 rules produce; screen rects read 0.95×
  by the console-zoom design above): picker button `24` (target 25), `.seg` `26` (target 26),
  `.seg button` `24` (target 24), compact toggle `16` (target 17), composer `79` (target 79) — every
  target hit within ±1 px. A first attempt that padded these rules up by 1–2 px was reverted once the
  zoom was found: it overshot in layout px (e.g. picker 26.5, seg 28.1).
- Unclickable-height walk at 1440×900: 22 visible console buttons, smallest `18px`, none under 12 px;
  Thread, Board, Team, palette (`walk-palette.png`), picker menu (`walk-picker-menu.png`) and rail
  screenshotted — nothing collapsed, picker menu and palette open and usable.
- Note: the fix-mode aux `select` keeps the global 36 px min-height (the prescribed reset covers
  `button` only, and widening it was out of scope) — recorded, not changed.

## 7. Start confirm stays on one line

- Change: `client/console/board.css:184-193` `.console .crow .confirm` — removed `flex-wrap: wrap`
  (kept `align-items: baseline`) and added `white-space: nowrap`. The wrap removal alone was not
  enough: in narrow compact columns the span text and the "Not now" label wrapped *internally*
  (screenshot showed `Hand to / You?` + `Not / now` on two lines); the nowrap keeps all three children
  on one flex line.
- Measured: `.confirm` children tops are `[0, 0, 0]` with heights `17.11px` each in compact
  (`confirmKids`) and `tops [0,0,0]`, height `17.11px` in comfortable (`confirmComfy`,
  `board-confirm-comfy.png`). One line inside the board row in both densities. (The brief's "36 px"
  does not match any rule in the prototype — its `.confirm` rule yields the same ~17–18 px content
  height; the number was recorded as-is and the single-line requirement is what was verified.)

## 8. Hover verbs no longer paint over worker/age

- Change: `client/console/board.css` — added
  `.console .columns.compact .crow .m { transition: opacity var(--quick); }` plus
  `:hover`/`:focus-within` → `opacity: 0`. Backdrop left as the prototype's own
  `background: var(--raised)` on `.acts` (`--raised` is the opaque `#1c2025`; on hover the row itself
  is `--raised`, exactly the prototype's construction).
- Measured/proved: magnified crops `crop-ready-verbs.png` (Ready: `Reseal the pergola …  Start` —
  ellipsis then verb, no worker glyphs) and `crop-working-verbs.png` (Working: `Pause  Team` where
  the worker/age line was — that line is `opacity: 0` while verbs show). Comfortable geometry:
  `.acts` box (l462–r491, t165–b183) sits on the title line while `.m` (t199–b215) is on the next line,
  and the title carries `padding-right: 60px` so single-verb rows clear the text. Honest qualification:
  on compact Working rows the two verbs (~80 px) still cover the *title's* truncated tail
  (`Hang the string lig[hts]` → `Hang the string ligPause Team`, no ellipsis visible because the
  truncation point sits under the verbs) — the same mechanics as the prototype's single verb, and
  outside this item's stated requirement (worker/age glyphs), which is fully met at both viewports in
  both densities.

## 13. Transcript prose colour

- Change: `client/console/console.css:552-554` `.console .turn.you .body`
  `color-mix(in srgb, var(--t1) 80%, var(--t2))` → `73%`. Other schemes keep deriving their own value.
- Measured: `getComputedStyle` on `.turn.you .body p` in Field is
  `color(srgb 0.832078 0.849137 0.871176)` = `rgb(212, 217, 222)` against the prototype's
  `rgb(211, 217, 224)`. No percentage lands it exactly (R wants 71.2%, G 73.8%, B 76.4%; least-squares
  optimum 73.5% rounds worse), so per the brief 73% was taken as the nearest — off by (+1, 0, −2),
  down from (+6, +4, +2) at 80%.

## 14. Turn attribution reads "You"

- No change, per the brief: spec drift, not a defect; the product's voice uses "You" everywhere else.
  (`ThreadView.tsx:161` `t.role === 'you' ? 'You' : 'Diomedes'` untouched.)

## 10. Permission-explainer sentences (report 09, gap G1)

- Change: `client/console/ThreadView.tsx:299-306` — restored Astra's three-way caption verbatim as
  `<p className="col permission-note">` immediately after the instrument line, conditioned on
  `route === 'codex' || needs.some((n) => n.approval)` → `Each proposed file change needs its own
  exact OK.` / `permission === 'task'` → `The first OK in a task covers the rest of it. Nothing runs
  without that first OK.` / else → `Every change waits for your OK.` Styled in
  `client/console/console.css` (`12px`, `var(--t2)`, `margin: 0`, `padding: 8px 0 0`, reuses `.col`
  measure; no fill, no border). Measured: `12px`, `rgb(164, 172, 182)` (= `--t2`), text
  `Every change waits for your OK.` by default (`walk-thread.png`).
- Workbook note for the report: the sentences are absent from `client/Workspace.tsx` and
  `client/components.tsx` too (grep for `exact OK` finds only the new line); restoring them in the
  Workbook is outside this pass's allow-list — not done.
- Test: `tests/field.spec.ts` `C07: the thread head states the exact-OK rule while an approval is
  open` (appended last, runs last). Neither trigger is reachable through the public API in the
  Playwright environment — Codex needs a live native account (`codexStatus().available` requires the
  RPC handshake, so the picker never offers it and `route` can never become `codex`; sample-work
  needs carry no `approval` payload and no route creates one) — so the test stands in an open
  approval need on the `GET …/state` payload via `page.route` (same `needs.some((n) => n.approval)`
  branch, owned by the project thread through `threadOwnsNeed`) and asserts the exact string
  `Each proposed file change needs its own exact OK.` is visible, unconditionally. Passes (see gate 4).

## Gates (from F:\Achilles\diomedes, verbatim outputs)

1. `npx tsc --noEmit` → exit 0, no output (clean).
2. `npx vitest run --configLoader runner` → `Test Files 14 passed (14)`, `Tests 361 passed (361)`
   in 23.91 s.
3. `npx vite build` → `✓ built in 693ms`, exit 0
   (`index-m1_PNqTt.css 92.04 kB`, `index-Ci4o9cOl.js 364.81 kB`).
4. `npx playwright test tests/field.spec.ts` (port 5174 confirmed free — no listener — before running;
   background dev server on 5201/47661 stopped first) → `7 passed (8.6s)`, including the new C07.

## Not done / deviations

- Item 6 aux `select`: global 36 px min-height retained (see §6 note).
- Item 8 title tail under two compact verbs: reported honestly, prototype-identical mechanics, out of
  the item's worker/age requirement (see §8).
- Item 13: exact `rgb(211,217,224)` unreachable by percentage; nearest taken (see §13).
- Item 10 Workbook restoration: out of allow-list, recorded only (see §10).
- Nothing else outstanding; no questions asked, no blockers.
