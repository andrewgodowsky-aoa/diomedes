# Brief 7b — Workbook: the verifiers' findings (Field polish pass)

Scope: items 9–12 of `F:\Achilles\planning\2026-09-08-field-visual-system\08-verify-ui.md` §2.
Branch `main`, checkout `F:\Achilles\diomedes`. No commit, no stash; working tree left dirty for owner review.

**Files changed (and nothing else):** `client/styles.css`, `client/Workspace.tsx`, `client/Settings.tsx`.
`client/components.tsx` needed no change (the consent action already renders through the shared
`Notice`, and `Mark` already existed). `client/console/**`, `tests/*` never opened for writing.
No role, accessible name, `data-*`/test id, button label or heading text changed anywhere.
No shadow added, no radius above 6 px, no filled `--light`/`--dm-glacier` block added.

**Verification method.** Background dev server per the brief
(`DIOMEDES_CLIENT_PORT=5202`, `DIOMEDES_PORT=47662`, `DIOMEDES_DATA_DIR=.data-7b`,
started with `Start-Process`, reached at `http://127.0.0.1:5202`, stopped afterwards).
Sample project "Harbor Street restaurants" opened in the UI, 4 plan tasks created
(`Make tasks from this plan`), two of them moved over the API to `done` / `working`,
sample work started on a third so a real open need exists (the only way a true
`Needs your OK` block renders). Driven with Playwright (Edge binary, 1440×900) in
Field and Paper. Raw dumps: `F:\Temp\andre\opencode\7b\measures.json`;
script: `F:\Temp\andre\opencode\7b\verify.cjs`.

---

## 1. "Go ahead" is no longer a filled amber block

**Changed** `client/styles.css:436-452`: `.button.signal` is now a quiet control —
`background: transparent`, amber (`var(--dm-signal)`) text, 1 px amber border,
`font-weight: 600` kept. Hover is a faint amber tint only
(`color-mix(in srgb, var(--dm-signal) 12%, transparent)`), never a fill.
Every `tone="signal"` call site is untouched (`client/components.tsx:244`,
`client/Workspace.tsx:948`, `:2223`), as is the `.button.signal` class name.
`.usage-fill.signal` and `.signal-text` untouched (meters and text, not buttons).

**Paper fallback (measured, then applied).** Amber label text on Paper's light ground
measured **3.31:1** — below the 4.5:1 floor — so per the brief Paper uses the 1 px
border form with a `--dm-text-1` label (`html[data-package='paper'] .button.signal`,
styles.css:450-453). All other schemes keep the amber label.

**Measured evidence (computed styles out of the running app):**

| Scheme | bg | label | border | contrast vs page |
|---|---|---|---|---|
| Field | `rgba(0, 0, 0, 0)` transparent | `rgb(224, 169, 74)` amber | `rgb(224, 169, 74)` | **8.74:1** |
| Paper | `rgba(0, 0, 0, 0)` transparent | `rgb(26, 29, 33)` (`--dm-text-1`) | `rgb(183, 121, 31)` amber | **15.37:1** |
| Paper hover | 12 % amber tint, no fill | `rgb(26, 29, 33)` | amber | — |

**Screenshots (all three places, Field + Paper):**

- Need block (Work page notice): `F:\Temp\andre\opencode\7b\field-work-needblock.png`
- Workbook Home Needs-you section: `F:\Temp\andre\opencode\7b\field-home-needs.png`
- Workbook Tasks waiting card: `F:\Temp\andre\opencode\7b\field-tasks-board.png`
- Workbook Tasks, Paper: `F:\Temp\andre\opencode\7b\paper-tasks-board.png`
  (the waiting row shows the `--raised` hover wash because the probe hovered the
  button before capture — that is the Console's own `:hover` register, not a fill at rest;
  at rest the row computes `background: rgba(0,0,0,0)`).

---

## 2. Tasks rows read as lists over hairlines, not cards

**Changed** `client/styles.css:1450-1479`: `.task-card` (and `.working` / `.waiting` /
`.done` variants) now match the Console board register in Workbook tokens —
`display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 0 10px;
align-items: baseline; padding: 6px 6px 6px 2px; border-bottom: 1px solid
var(--dm-rule-2)`; no background fill at rest, no box border, no coloured left bar
(all three state variants only zero the old `border-left`), no shadow,
`border-radius: 0`, `min-height: 0`, `margin: 0`. `:hover` lifts to
`var(--dm-raised)` exactly like `.console .crow:hover`.
Non-mark children are pinned to column 2 (`.task-card > :not(.mark)`), the point to
column 1 with the board's 5 px top offset.
**One JSX change, as allowed:** `client/Workspace.tsx:879` adds
`<Mark state={task.state} />` as the row's first child (`aria-hidden`, no name change).
`.task-title` text and click-target semantics untouched.

**List view / responsive.** `.list-view .task-card` (styles.css:1538) keeps its flex
row shape — it inherits the hairline/no-fill base, verified below. The 1350 px block
only touches `.task-card .actions` gap (still sensible). The 600 px block set
`min-height: 120px` — changed to `0` (styles.css:2276) so narrow rows stay rows.

**Measured evidence** (Workbook → Tasks, 1440×900, all four columns populated —
`TO DO 1 / WORKING 1 / WAITING FOR YOU 1 / DONE 1`): every `.task-card` computes
`background: rgba(0,0,0,0)`, `borderBottom: 1px solid` hairline,
`borderLeft/Top/Right: 0px`, `boxShadow: none`, `padding: 6px 6px 6px 2px`,
`min-height: 0px`, `marginBottom: 0px`, and carries `:scope > .mark` with the right
class (`mark todo` hollow / `mark working` live / `mark waiting` amber / `mark done`
`--t3`). No column shows a per-row box, fill or shadow.
List view: all four rows compute `display: flex`, transparent bg, bottom hairline
only, shadow none, each with its state mark.

**Screenshots:**

- Board, Field: `F:\Temp\andre\opencode\7b\field-tasks-board.png`
- List view (Paper persisted from the scheme switch, so this doubles as Paper list
  coverage): `F:\Temp\andre\opencode\7b\field-tasks-list.png`
- Board, Paper: `F:\Temp\andre\opencode\7b\paper-tasks-board.png`

---

## 3. Engines states are a point plus text

**Changed** `client/Settings.tsx:600-602`: the margin row keeps `caption push-right`
and the exact strings, with `<Mark state={s.available ? 'working' : 'todo'} />`
immediately before the text. (`working` is the `.mark` class for the healthy/live
state; bare `todo` is the quiet hollow one.) `engine-meter` / `UsageBar` untouched.
The service-list `s.status` line (Settings.tsx:244) is a different row and was left alone.

**Changed** `client/styles.css:957-965` (`.engine-state`): point before text on the
same baseline (`inline-flex`, baseline alignment, Console's 8 px gap). Colour follows
state through the existing `.mark` classes — no new token.

**Measured evidence** (Settings margin, Field): `Available` → `mark working`,
fill `rgb(63, 214, 223)` (`--dm-glacier`); two `Unavailable` rows → `mark todo`,
transparent fill, `rgb(128, 139, 151)` (`--dm-text-3`) border. All three compute
`gap: 8px`, `display: flex`, and keep `caption` + `push-right`.

**Screenshot:** `F:\Temp\andre\opencode\7b\field-settings-engines.png`
(margin visible from the Helpers section; in guided detail the section reads
"Helpers on this computer" — same margin rows the brief cites).

---

## 4. The native square checkbox gets the app's control styling

**Changed** `client/styles.css:285-308` only — no JSX change. `input[type='checkbox']`
gets `appearance: none`, the 1 px rule border, `border-radius: var(--rb)` (5 px —
the radius the Workbook's other controls use via `.segmented`, read not invented,
≤ 6 px), `--dm-well` ground, and a `:checked` state with a glacier border, a 14 %
glacier tint, and a drawn check (`::before`, 10×10, `var(--dm-glacier)` clip-path).
`:focus-visible` is already covered by the app's global focus ring
(`outline: 2px solid var(--dm-glacier)`, styles.css:245-253), unchanged.
Radios: 10 native `input[type='radio']` in the tree already render as circles —
left alone per the brief (their computed `border-radius: 0` is the native control,
not a square marker). The input stays a real `<input type=checkbox>` with its
label association intact.

**Measured evidence** (Settings → Appearance, `input[type='checkbox']`):

| State | borderRadius | border | ground | check |
|---|---|---|---|---|
| Field unchecked | `5px` (was `0px`) | 1 px `--hair-2` | `rgb(18, 20, 23)` | `::before: none` |
| Field checked | `5px` | 1 px `rgb(63, 214, 223)` | glacier-tinted | 10×10 `rgb(63, 214, 223)` check |
| Paper checked | `5px` | 1 px `rgb(14, 124, 134)` | light glacier tint | 10×10 `rgb(14, 124, 134)` check |

Toggled through the real control (click → saved setting polled over the API →
reload → re-read), so the checked state is the app's actual persisted state, legible
in both schemes. `appearance: none` confirmed in the computed style.

**Screenshots:**

- Field (checked): `F:\Temp\andre\opencode\7b\field-settings-appearance.png`
- Paper (checked): `F:\Temp\andre\opencode\7b\paper-settings-appearance.png`

---

## Gates (from `F:\Achilles\diomedes`, in order; Playwright last, dev server stopped)

```
npx tsc --noEmit
```
Clean — no output apart from the npm notice lines.

```
npx vitest run --configLoader runner
```
`Test Files  14 passed (14)` / `Tests  361 passed (361)` (26.51 s).
Note: the first full run after the final CSS edit showed 360/361 with one
`tests/work-admission.test.ts` timing failure; the file passes in isolation and the
full suite re-ran green (361/361), so that was load flake while two other passes
run dev servers and suites on the same machine — not a regression from this
CSS/JSX-only pass.

```
npx vite build
```
`✓ built in 804ms` (dist `index-*.css 92.01 kB`, `index-*.js 364.81 kB`).

```
npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts
```
Port 5174 checked free first (`Get-NetTCPConnection -LocalPort 5174` empty).
`19 passed (28.4s)` — all ui.spec.ts + native-ui.spec.ts tests, unedited.

---

## Not done / notes

- The 600 px narrow layout was verified by code inspection (`min-height: 0`,
  hairline base inherited) but not screenshotted at 600 px — conservative call to
  keep the verify run inside budget; nothing in the narrow rules reintroduces a box.
- `tests/ui.spec.ts`, `tests/field.spec.ts`, `client/console/**` and
  `evidence/screenshots/*` show concurrent-pass modifications in the working tree;
  none are mine and none were touched here (`git status` on my files:
  `client/Settings.tsx`, `client/Workspace.tsx`, `client/styles.css` only, plus this report).
- The `.notice` amber left bar (Work/Home need block container) is unchanged: items
  9–12 don't cover the notice container, and restyling it would risk `tests/ui.spec.ts`
  layout assertions owned by another pass.
- `docs/field/reports/7-tests.md` (untracked, another pass's) is unrelated to this report.
