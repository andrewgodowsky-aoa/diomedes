# A Console control that makes a task, and a faulted row that can start again

Date: 2026-09-12
Worktree: `F:\Diomedes\diomedes-wt\opus-console`, branch `slice/opus-console-20260912`, cut from
`main` at `baa7c77`.
Slice: the two Console gaps the demonstration journeys measured —
`docs/implementation/2026-09-12-demo-journey-a.md` step 15 and §3, and
`docs/implementation/2026-09-12-demo-journey-b.md` steps 4 and 17 and §"What is not reachable".

Nothing here is pushed, packaged or released.

---

## What the journeys measured

1. No Console control created a task. Both journeys made theirs over
   `POST /api/projects/:id/tasks` and recorded it as backend fixture preparation. A person could not
   start work from the app at all.
2. A faulted run told the person "Start again to request a new proposal" and then offered no Start.
   `client/console/BoardView.tsx` gated Start on the `Ready` column, so the row read
   "Run failed · this thread · Route to", and with no team the Route to panel's only content was a
   hidden "Retry".

## What changed

### `client/console/BoardView.tsx`

- **New task** sits in the board head beside the project name and task count, with
  `aria-expanded`. It opens one form (`form.newtask`, `aria-label="New task"`) carrying a required
  **Task name** (200 characters) and an optional **What should happen (optional)** (10,000
  characters), then **Create** and **Not now**. Escape closes it; a failed create keeps the typed
  words and the form open.
- A `sending` ref refuses a second submit in the same tick, because `busy` only turns true after the
  Shell's state settles and a fast double click can otherwise arrive before the re-render.
- The empty Ready column said "Make tasks from a plan." It now says
  "Nothing is ready. New task adds one.", which is the path that exists.
- `canStart` replaces the `column === 'Ready'` gate: a `Blocked` row with no active run whose last
  session is `failed` offers **Start again**, through `onStart` — the same handler, the same
  confirmation policy (`Confirm each start` / `Start on click`), the same inline `.confirm` panel,
  the same one-run-at-a-time disabling. A `stopped` run is untouched: `taskEvidence` already returns
  it to Ready, where Start begins new work.
- **Route to** now renders only when there is somebody to route to (`members.length > 0`), and the
  zero-member "Retry" inside that panel is gone. On the exact row journey B measured, Start again is
  the one next action; with a team, Route to remains beside it as the different action it is.

### `client/console/types.ts`, `client/console/Shell.tsx`, `client/console/board.css`

`BoardProps` gains `onCreateTask({ name, description })`. `Shell.createTask` is the wire-up entry
point: it posts `POST /projects/:id/tasks` with `owner: 'you'`, reloads project state, reports and
rethrows on failure. `board.css` styles the control and the form from existing tokens only.

**No task moves.** A created task has no run, so `taskEvidence` projects it into Ready. There is no
new lifecycle, no new state machine and no second admission route.

## Wire-up entry point

`client/console/Shell.tsx` → `createTask` → `POST /api/projects/:id/tasks` (existing route,
`server/app.ts:1180`) → `load()`.
Start and Start again both go through the existing path: `BoardView.onStart` →
`Shell.startTask`/`dispatchTask` → `client/work-start.ts` `startWork` (minted `commandId`,
sessionStorage pending record, in-flight dedupe) → `POST /api/projects/:id/work/start` →
`server/work-admission.ts` `parseWorkCommand` → `work.start` or `nativeWork.start`.

**No server code was changed.** `server/app.ts`, `server/store.ts`, `server/work.ts`,
`server/work-admission.ts` and `server/workspace-routes.ts` are untouched. Both start paths already
accept a task in `waiting`/`went-wrong` whose last session is `failed`; the gap was only the board's
gate.

## Tests

- `tests/work-admission.test.ts` (+2, server): a codex run that faults leaves the task `waiting`
  with `reason: 'went-wrong'` and a `fault` entry; a new command admits a second run against the
  same task with its own receipt and a second `work-admitted` entry; replaying that command returns
  the same session and calls the generator no further times; replaying the spent first command still
  returns its own failed session. A second test covers the create route the new control uses — one
  task and one `tasks-made` entry per request, a trimmed name, a 400 and no task for a blank one.
- `tests/workbench-board.test.ts` (+4, and the new prop): the empty Ready sentence and the New task
  control, Start again on a faulted row, no Route to and no hidden Retry without a team, and a
  stopped run still reading Start.
- `tests/native-ui.spec.ts` (+2, browser, against the built bundle): New task → a row in Ready →
  Start → the inline confirmation → one session with a receipt, one `tasks-made` and one
  `work-admitted`; and a faulted task whose row shows "Run failed", offers no Route to, offers Start
  again, and after confirming holds two sessions, two receipts with different command ids, two
  `work-admitted` entries, one task and no leftover pending record.

`tests/workbench-board.test.ts` is outside the slice's stated file list. It renders
`client/console/BoardView`, so it had to take the new prop to compile; the four added assertions are
in the same file because that is where board rendering is asserted.

## Known limits

- **Creating a task is not an admitted command.** It carries no `commandId`, no receipt and no
  replay. A double click is refused in the browser by the in-flight ref, but a reconnect or a
  restart in the middle of the POST is not deduplicated. Making creation idempotent means a third
  command family in `server/command-admission.ts` and a durable command field on the task or its
  History entry — a contract decision beyond this slice.
- **Start again covers a faulted run only.** A `Blocked` row that reads "No active run recorded" or
  "Check the task record" still offers no start; those states were not measured by the journeys and
  their right next action is not settled.
- **The route is still not chosen on the row.** Start again reuses `routeForTask`, which reads
  Settings and the thread. Journey B's finding that `client/console/Picker.tsx` never offers an
  external engine is untouched; that file belongs to another slice tonight.
- **"Hand to You?" is still wrong on a task owned by `you`.** Journey A §2 names it; `workerOf` is
  the cause and the fix belongs with that defect, not here. On a faulted row the confirmation does
  name the engine, because the failed session supplies the origin.
- The Console's Review and History routes still leave for the frozen Workbook (journey B). Not this
  slice.

## PILLAR IMPACT

Advanced:

- **Pillar 04 — put information and action where the worker needs it.** The board could describe
  work it could not start and could not be filled from the surface a person was told to use. It now
  carries both actions on the row and column that state them.
- **Pillar 06 — control without constant clicks.** The fault sentence and the row now agree: the
  next action named in words is the button beside it, once, with the confirmation policy the person
  already chose.
- **Pillar 08 — human judgment is for judgment.** Start again is explicit. Nothing retries by itself
  and no substitute route runs.

Risks and conflicts: none identified against a pillar. Standing decision 1 holds — the control is
Console-only and adds no Workbook screen. Standing decision 4 holds — the empty-column sentence and
the fault sentence each say their thing once, and the duplicate hidden Retry was removed rather than
joined by a second start. Standing decision 10 holds — every start is admitted and receipted, and
nothing here deletes evidence.

Observable proof: the two `tests/native-ui.spec.ts` cases above, run against the built bundle, with
`console-new-task.png` and `console-start-again.png` in the run's output directory.

## ROADMAP IMPACT

No roadmap status is claimed here. The two journey rows this slice addresses — journey A step 15 and
journey B steps 4 and 17 — are reachable in the source on this branch; they remain unproven against
a packaged candidate until one is built from a commit that contains it.

## BUILD / PUBLICATION / DEPLOYMENT STATUS

Not packaged, not published, not deployed. Committed on `slice/opus-console-20260912` only; not
pushed and not merged.
