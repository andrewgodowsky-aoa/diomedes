# 2a — Field shell + Thread screen

## Files

New in `client/console/` (Console.tsx left untouched in the tree):

- `types.ts` — `ShellView`, `BoardProps`, `TeamProps`, `PalettePoint`,
  `PaletteAction`, `PaletteEntry`, `PaletteProps` exactly as specified.
- `console.css` — prototype CSS for `.app .top .crumb .top-right .stage
  .rail .rail-head .spine .views .foot .screen #scrThread .work .col .head
  .instr .transcript .exchange .turn .who .body .record .greeting .caret
  .proposal .compose .composer .aux .bar .modes .ind .cap .send .hint
  .ledger` (all rules), `.picker .pmenu .toast`, and both `@media` blocks,
  every selector prefixed with `.console` (`.app` became `.console`), plus
  `html[data-surface='console'] body { background: var(--chrome); }`.
- `Shell.tsx` — root `<div className="console">`, 40 px top strip over a
  `232 px + work` stage. Owns `load()` (`/projects/:id/state` plus
  `/projects/:id/team` with 404 tolerated on the team route), the SSE
  refresh on the same ten event names, `perform`, and every handler from
  Console (`newThread`, `rename`, `setRequested`, `setPermission`,
  `postMessage`/`messageMember`, `stopMember`, `wakeMember`, `resolveNeed`,
  `stopSession`, `moveTask`, `startTask`, `reviewChange`, `send`) with
  unchanged `api(...)` shapes. One selected thread (default newest),
  `view: Thread | Board | Team`, mode/route/toTeam for the selected thread,
  rename + need-preview modals, toast, and the Board/Team/Palette wiring.
- `Rail.tsx` — `h2` “Threads” (uppercase mono via CSS), New button, spine
  `<ul class="spine console-threads">` newest-first with sliding point,
  views with Board open-task count and `N workers`, foot with Workbook /
  History / Engines.
- `ThreadView.tsx` — head (`h1` rename, two-way permission segmented
  control), instrument line, transcript, run records, composer.
- `Composer.tsx` — autosizing box to 220 px, four `role="radio"` modes plus
  Team for member threads, point-and-line indicator, per-mode caption, Send
  with `aria-disabled`/`.ready`, Enter hint, Build `may touch` aux, Fix
  aux with the `What is failing` select and `Paste what went wrong` box.
- `Picker.tsx` — mono `ENGINE model-id effort` control with grouped engine
  menus, effort ladder, cap note, live lockout.
- `Ledger.tsx` — project aside with focus block, Work, Needs you, Activity,
  Recent, and per-mode dimming.
- `BoardView.tsx`, `TeamView.tsx`, `Palette.tsx` — placeholders with the
  verbs wired (Start/Stop/Go ahead/Look at changes/Reopen/Thread/Team;
  roster Thread/Start/Stop; palette renders nothing).

Edited: `client/App.tsx` only — imports `Shell` instead of `Console`,
renders it in the same branch with the same props plus
`projects`/`onOpenProject`/`onShowProjects`/`onOpenSettings`, and hides the
app top bar while the console surface is active so the shell strip is the
only one. Keyboard handling untouched.

## How the timeline merges turns, mail and sessions

ThreadView builds one ordered item list: turns are first grouped into
`.exchange` blocks (a you-turn opens one, following Diomedes turns join it,
a Diomedes turn with no preceding you-turn stands alone), then exchanges
(keyed by first-turn time), mailbox messages (by `createdAt`, rendered as
`.turn.you`/`.turn.dio` with “`A to B`” attribution in the who line), and
one `.record` per session of the thread's task (by `startedAt`) are merged
and sorted by time. Open needs render as `Notice` blocks above the
transcript with `need-<id>` anchors so the ledger Review buttons and board
Review can scroll to them. A live session's record stays open with
plain-level lines, a Stop button, and an All-details toggle; an ended
session folds to `N events Ns [show run]` and reopens on click. No spinner;
the open live record carries the `.live` gutter point.

## What the picker fetches

On mount, `GET /engines/:id/models` for each of
`codex`/`claude-code`/`opencode` whose integration passes the Console
availability rule (adapter ready/planned plus the Settings switch; plain
`available` for sample). Failures resolve to an empty catalogue, never an
error. The menu groups the available engines (header: engine name + the
integration's `location` or `status`), a Default row per group (clears
`requested`), each model row (name, mono slug, description small), the
chosen model's effort ladder, and the cap/default note. Codex choices set
the send route to codex, the Sample entry sets it to sample; other engines
keep the current route because `Route` is `sample | codex`. While a session
is live the menu shows only “Waiting for the current run to finish”.

## Deviations from the prototype (and why)

- Indicator/spring: `placeInd` moves with a 200 ms CSS transform transition
  instead of the stiffness-210 spring; screen travel has no flying point.
  The spring arrives in a later pass.
- Spine ticks: positioned per-row in CSS (`li { position: relative }`,
  tick at 15 px) instead of `placeSpine` setting each tick top; the sliding
  point still positions from the selected button's `offsetTop` with the same
  200 ms transition.
- Extra `···` surface menu in the top strip (The Workbook / The Console,
  mirroring the app account menu): hiding the app bar removes the only
  surface switch on the console surface, and the ui suite clicks
  `Interface detail menu` → `The Workbook` there (F01-F02, Draft recovery).
- Ctrl+K link shows a placeholder toast; the palette agent owns the handler.
- Fix aux uses Console's “Not a document” empty option (behaviour-coupled),
  and Plan has no aux row (caption only) per the brief.
- Greeting copy is generic (“A new thread…”) rather than project-specific.
- Activity “No runs yet” / quiet rows: added
  `.ledger .ev li.quiet { grid-template-columns: 1fr }` so the 40 px event
  grid does not crush them.
- Reset block at the top of console.css neutralises app-stylesheet leaks
  onto the shared class names (`.turn` padding/margin, `.turn.you`
  glacier border, `.rail` padding/scroll, `.composer` margin,
  `.composer > textarea` fixed height). Found by screenshot: a cyan bar
  beside every you-turn.
- `reviewChange` is kept (same `api` shape) but has no UI in this pass;
  ended run records show `hide run` as well as `show run`.
- Team `onMessage(to='diomedes')` resolves to the lead (else first) member,
  since the team message endpoint takes a member slot.

## Test summary (exact lines)

- `npx tsc --noEmit` — clean, no output.
- `npx vitest run --configLoader runner` — `Test Files 10 passed (10)`,
  `Tests 227 passed (227)`.
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts` —
  `17 passed (25.9s)` (1 native-ui + 16 ui), re-run after the final CSS
  reset with the same result.
- Notes: the native-ui spec guards on a fresh `dist`, so `npm run build`
  was run first (vite build OK; `postbuild` packaging fails in this env on
  a missing `.data/native-runtime/codex.exe`, unrelated). One full-suite
  run showed a Usage-chip failure caused by downstream pollution from the
  then-failing F01-F02; it passes in isolation and in every full run since
  the empty-state Ledger fix.
- Visual: `DIOMEDES_CLIENT_PORT=5176 DIOMEDES_PORT=47634
  DIOMEDES_DATA_DIR=.data-2a node scripts/dev.mjs`, surface set to Console,
  sample project opened with one ask exchange; Thread screen captured at
  1440×900 and 1000×800 and matches the prototype (strip, spine+point,
  instrument line, exchanges with gutter points, composer+indicator,
  ledger); server stopped afterwards, `.data-2a` removed.

Not committed, per instructions.
