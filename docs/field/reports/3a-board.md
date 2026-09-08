# 3a — Execution board (BoardView)

Worktree `field/density-20260908`. Files: `client/console/BoardView.tsx` (replaced),
`client/console/board.css` (new, imported by BoardView), `client/console/types.ts`
(one optional field on `BoardProps`). Shell, Team, Palette and all other files untouched.

## State mapping implemented

`columnOf(task)` in BoardView.tsx:

- Ready = `state === 'todo'`
- Working = `state === 'working'`
- Review = `state === 'waiting'` with `reason === 'needs-ok'` or `'changes-ready'`
- Blocked = `state === 'waiting'` with `reason === 'went-wrong'` or `null`
- Done = `state === 'done'`

Column captions (`.why`) verbatim: Ready "Start hands it to its worker",
Working "a worker holds it now", Review "waits on you", Blocked "needs an answer
or a route", Done "kept; Reopen to change it". Counts in mono; Review/Blocked counts
take the amber class only when above zero; Working shows `N of 1 slot` where N is the
number of Working tasks (one engine run at a time in this version).

Worker line: the running session's `engine.name` (model in the `title` attribute) when
a session in `queued`/`working`/`waiting` exists for the task, else the team member
whose `slotId === task.assignedTo`, else `You`/`Diomedes` from `task.owner`. Age is the
relative time from the last non-undone move (else `createdAt`): `now`, `N m`, `N h`,
`N d`, weekday name below for older than a week, tabular mono.

Second line (`.x`) renders only when non-empty: Blocked shows `something went wrong`
(amber) for `went-wrong`, else `waiting` (amber); Review shows `needs your OK` (amber)
for `needs-ok`, else `proposal, N files` where N counts `state.changes` with
`state === 'waiting'` whose id is in `task.changeIds`; the row with
`task.id === focusTaskId` shows `this thread` (light) and its point carries
`data-focus-point`. Every row point carries `data-task-point={task.id}` for the later
travelling-point pass (travel itself not implemented).

## Verbs

Title is a `<button>` calling `onOpenThread`. One verb per state, revealed on
hover/focus via the `.acts` wrapper: Ready Start, Working Pause, Review Review,
Blocked "Route to", Done Reopen. Working rows also show a quiet `Team` link
(`onOpenTeam`). Ready under `policy === 'first'` opens the inline confirm
(`Hand to {worker}? / Start / Not now`); under `'go'` it calls `onStart` at once.
Start is disabled with title "One run at a time in this version" while any other task
is Working. Blocked "Route to" opens the inline member list (name + engine mono,
`onRoute(task, slotId)`); with no members it shows `Retry` (`onStart`). Confirm and
route list close on Escape (row-level `onKeyDown`) and on second click (toggle).
All verbs are `<button>`s; action verbs are disabled while `busy`.

Head: `<h1>Board</h1>`, mono `{project.name} · N tasks`, `compact` mono toggle
(`aria-pressed`, default on) toggling `.columns.compact`, and the policy segmented
control (`role="radiogroup"`, `Show me first | Go ahead for tasks`).

## Deviations from the prototype and why

1. Added optional `onPolicyChange?(policy)` to `BoardProps` (the one allowed contract
   addition). The Shell does not pass it yet, so the control is local state seeded from
   the `policy` prop; when a parent passes `onPolicyChange`, the prop is the source of
   truth and the callback fires. The Shell derives `policy` from the selected thread's
   permission and never writes it back, so wiring it through is a follow-up.
2. Working thread: prototype's `.prog i` is a static progress bar. Per the brief it is a
   1 px hairline (`.prog::before`) with a low-contrast `--t2` point (no glow) travelling
   in a 1.6 s `boardrun` loop, transform + opacity only, fixed 420 px travel so it reads
   on any column width; hidden under `html[data-motion='reduced']` and
   `prefers-reduced-motion` (hairline stays).
3. Responsive: the brief asks for two columns at `max-width: 1100px` and one at `860px`.
   The prototype only collapses `.columns` to `1fr 1fr` at `860px`. Implemented
   `1fr 1fr` at 1100 px and `1fr` at 860 px (with the prototype's padding steps),
   so compact's `minmax(210px, 1fr)` five-column strip scrolls sideways before that.
4. Inline confirm may wrap to two lines in narrow compact rows (`.confirm` allows wrap);
   the prototype's single-line form assumes comfortable widths that compact rows don't
   have. Content and order are identical.
5. `arrived` fade: tracked per task id against the previous column across renders
   (cleared after 300 ms); prototype tags the moved row directly. Same 180 ms fade.
6. Review reason rows (`needs-ok`, `changes-ready`, proposal counts) and the focus
   `this thread` row are implemented but could not be screenshotted: the tasks API
   resets `reason` to null on manual moves and no team/need flow was running in the
   scratch project, so only the empty-Review state was seen live.

## Contract gaps

- `BoardProps.policy` is read-only from the board's side; there is no way to persist a
  board-level policy choice (the Shell derives it per selected thread). `onPolicyChange`
  is the seam; nobody calls it yet.
- "One run at a time" is enforced as UI disable only, keyed off other Working tasks;
  the service remains the real gatekeeper (it 409s concurrent sessions).
- The Working count uses Working-task count for `N of 1 slot`, not the running-session
  count; with the one-run gate the two agree in practice.

## Test summary

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run --configLoader runner` — 10 files, 227 tests, all passed.
- `npx vite build` — clean (required before the native spec).
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts` — 16 passed, 1 failed
  on the final test (`Enter sends from the Workbook composer`) with
  `browserContext.close: ENOENT ... .trace` / missing trace zip: a trace-packaging
  infrastructure flake on Windows, zero assertion failures. An earlier full run showed
  the same flake pattern once each on F17 and the Usage test; both pass on re-run
  (F17 passes in sequence; it fails in isolation only because the serial suite shares
  `projectId` state). No board-related test exists; every `afterEach` page-error guard
  passed, so the board mounts without uncaught errors.
- Manual check (`DIOMEDES_CLIENT_PORT=5181`, `DIOMEDES_PORT=47641`,
  `DIOMEDES_DATA_DIR=.data-3a`, `node scripts/dev.mjs`, http://127.0.0.1:5181,
  onboarding skipped, project "Reopening the patio" + 7 tasks seeded): Board at
  1440 px (5 compact columns, counts, amber Blocked count, hairline + travelling point
  under Working, hover reveals Start, inline confirm `Hand to You? / Start / Not now`
  opens and closes on Escape, inline route list shows `Retry` with no members,
  comfortable mode shows whys + second-line worker/age + amber `waiting` rows) and at
  1000 px (board scrolls sideways, columns keep `minmax(210px, 1fr)`). Working hover
  shows `Pause` + `Team`; Done hover shows `Reopen`. Server stopped after; Playwright
  tore its spawned servers down (only TIME_WAIT remnants).
