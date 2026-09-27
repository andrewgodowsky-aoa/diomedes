# Executable task board - 2026-09-27

## Work order

- Feature: executable-task-board. The Board's cards become work a person can move, inspect and
  run, following the 2026-09-26 research on Hermes' board ("borrow the executable-board model,
  not the look").
- Prompt ID: none. Andrew's request in chat: "implement this research".
- Owner: Claude (Opus 5.5), session be4b610d-db1b-417f-bef5-9da21fccb6d5, coordination seat
  opus, process 49316. One adversarial test lane was delegated (SWE-2 via Devin, edit-only) and
  its two files were reviewed and corrected here.
- Branch: feature/executable-task-board.
- Worktree: F:/Diomedes/diomedes-wt/executable-task-board.
- Base: 8daf0c1 (origin/main when the work began).
- Coordination: the non-hot paths were claimed late, after editing rather than before
  (`claim_mujguqrs_6c5cf12f`), and released with the commit. Four of the changed files are
  integrator hot files: `server/app.ts`, `server/store.ts`, `server/native-work.ts` and
  `client/console/Shell.tsx`. Andrew's request needed those hunks but did not name the files, so
  they are journaled (role opus) as an owner override for the integrator to read before merge.

## Direction

The research asks Nectovia to take Hermes' idea that a card is real work, not a picture of it,
and to build it from the pieces Nectovia already has instead of a second task system: the Board
and its evidence projection, the Ready queue (H07), agent profiles (H09), instruction delivery
(H11) and the native loop (H13). It orders the work in four steps: prove one full journey
including a restart with no duplicate run; make the task view authoritative so changing task A
leaves task B and the conversation alone; put drag and drop over the same commands, refusals
included; then phase handoffs and bounded decomposition. It keeps the single run slot.

This slice does steps 1 to 3. Step 4 is not started (QUESTIONS.md O44 items 2 and 3).

## What is implemented

### One move table (`shared/board-moves.ts`)

A move on the Board is a request, never a way to set a task's state. `boardMove(to, facts)` maps
a drop into a column to one of the four commands the Board already sends, or to a refusal in
plain words. It reads the column the task is projected into (`taskEvidence`) and six facts:
active run, slot busy, open decision, waiting changes, failed, automatic start on. It admits
nothing and moves nothing. The command still goes through its own route, which can still refuse,
and the card moves only when the records say it did.

| Move | What it asks for |
| --- | --- |
| Ready to Queued or Working | Start, through the Work start admission and the Board's own "Hand to …?" confirmation. The card says "Starting…" and shows Queued until a worker starts. |
| Blocked (failed) to Working | Start again, the same way. |
| Working or Queued to Ready | Stop and nothing more, after "Stop this run? The task goes back to Ready and waits for you. Nothing starts in its place." A stopped task is not started again on its own. |
| Done to Ready | Reopen. It asks first only when automatic start is on, because the queue may then take the task again; its earlier runs stay in its record. |
| Any settled card to Done | Mark done through the task route, after "This records that you finished it; it does not run any check." |
| Anything to Review or Blocked | Refused. A run lands there when it has something for the person; a card cannot claim it. |
| Review to Done or Ready | Refused while a decision or changes wait ("Answer the open decision first.", "Keep or undo the waiting changes first."). |
| A second start while another task runs | Refused: "One run at a time in this version. Another task is running." |

The drag, the card's new Move menu and the task view's buttons all read this one table, so no
gesture has a route the Start, Stop and Reopen buttons do not.

### Drag and drop and the Move menu (`client/console/BoardView.tsx`, `board.css`)

Native HTML drag and drop, no new dependency. While a card is dragged, each column is outlined as
a drop that would or would not go through, and the column under the pointer says it in words
("Drop to start", or the refusal). Every column takes the drop while a card is dragged, and a
refused move is shown on the card as an alert after it, with nothing sent. A column accepts the
card on entry as well as on each dragover: the browser decides a drop on the last of those
events, and opening the column's caption moves the list under a still pointer, so without that a
release just after the caption opened was lost (found with a real pointer, below). A move that
asks first is checked against the table again when the person confirms,
because the records may have moved meanwhile (the Ready queue may have started the task). A move
waiting for its command shows its pending word on the card, and the card cannot be dragged or
moved again until the command answers. Refusals from the table are said on the card; a route's
own refusal is reported by the Shell, as for the card's buttons. Behind that, the service admits
one Start at a time and keeps one run per project, so two Starts sent at once make one run and
leave it running (tested over HTTP). The Move menu on each card offers the same table from the
keyboard, with each entry named for its column and what it would do ("Ready: Reopen"). A move the
table refuses stays in the menu, marked unavailable, and choosing it shows the reason.

### The task in full (`client/console/TaskInspector.tsx`, `task-inspector.css`)

Clicking a card's title opens the task over the Board in two columns.

- The work: its objective, its default document, what "finished" means (its declared completion
  checks, or "No completion checks are declared, so a finished run reads Not verified."), the
  latest run's verification, anything waiting on the person with a Review button, and the latest
  run's own activity.
- How it runs: the worker, the route and where the route came from, the model and effort, what
  the run may do (the thread's permission, the worker's ceiling and the effective grant), its
  place in the Ready queue, every reason a Start would stop now, and its past runs with their
  commands, workers, profiles, models and instruction delivery counts.

While it is open it reads its execution view again whenever the project's records change, so it
never shows a stale answer; that is one read-only request per change, and none while it is
closed. Its actions are the Board's own moves from the same table, plus "Open thread". At
Technical detail it also offers the task's own H09 profile list, saved through the existing
per-task routing route. Below Technical detail it shows the task's profile, if it has one, and
offers no choice, because customers do not choose routes (Andrew, 2026-09-23).

### The execution view (`server/task-execution.ts`, `shared/task-execution.ts`)

`GET /api/projects/:id/tasks/:taskId/execution` answers "what would a Start do now?" through the
same services a Board Start uses, in the same order as `admitWork`: the route the task's thread
or project selects, the host's own refusals in its own words (the Home project, an app update
closing, the Nectovia route's refusal of Work, a route turned off in Settings, Cloud sharing not
allowing the route, another task already running), then H09 profile routing, then the Agent
resolution that sets the permission ceiling and grant. It reads and never writes: the tests
compare the project's `state.json` and `agent-profiles.json` byte for byte across reads.

To share that order rather than copy it, `NativeWorkService.start` now calls two methods the view
calls too, `routingFor` and `agentFor`, and `withProfile` applies a resolved profile. The order of
its refusals is unchanged.

### A person's reopen is recorded (`server/store.ts`, `server/app.ts`)

The adversarial lane found that a reopen could succeed and change nothing. `store.moveTask`
returns early when the task already reads the target state. A Stop, a declined proposal or an
undone automatic move can leave a task at To do by Diomedes' own move, and the Board and the Ready
queue count a reopen only when it is the person's (`taskEvidence`, `readyAt`). The task route now
records a person's move to To do even when the state is unchanged, unless a reopen of theirs
already counts (no run started or ended since), so a retried request after a lost response adds
nothing. Services still get the early return. With automatic start on, a stopped task the person
reopens through the task route may be started by the queue again: that is H07's rule ("not
restarted automatically unless the person reopens it"), which the early return had made
unreachable for stopped tasks. The Board itself offers no reopen on a stopped card, which is
already in Ready; the person starts it.

A suspected race was checked and ruled out. The sample worker checks for work in progress before
two awaits and claims the project's run after them, which looked as if two Starts at once could
both pass. They cannot: every caller of the Work start admission (the HTTP routes, the Ready
queue, follow-up delivery and the conversation seam) runs under the service's one lock
(`store.locked`), so a second Start waits for the first and is refused. A test that held both
Starts inside the worker deadlocked on that lock, which is the proof; the concurrent-Start test
stays as an acceptance test, and no production code changed for it.

## What is not implemented

- **Board work on the Nectovia route.** The Nectovia Agent refuses Work
  (`NECTOVIA_WORK_REFUSED`), so the one-journey proof runs on the sample route, and the task view
  lists the refusal as the reason a Start would stop. Starting a Diomedes work loop from the Board
  belongs with O23. QUESTIONS.md O44 item 7.
- **Tasks an agent makes as a normal part of work.** Tasks are made from a conversation proposal
  the person chose (CD-01), as before. Nothing new lets an agent put tasks on the Board, and no
  child tasks are made. O44 items 1 and 3.
- **An Inbox, a workflow phase, phase handoffs and bounded decomposition.** O44 items 1 to 3.
- **Which conversation a task came from.** The task view says "Made from a conversation proposal
  you chose" from the creation receipt; a link to the thread and message needs a Task field. O44
  item 6.
- **Per-task harness, skills, permissions and limits.** The task view shows the resolved worker
  and permission; the only per-task choice is the H09 profile list, at Technical detail.
- **Hermes' snapshot-plus-event-cursor subscription.** The Console still reloads project state
  after each command and on its event stream.
- **More than one run at a time.** Kept at one run per project, as the research asks.

## Tests

- `tests/task-board-journey.test.ts`, over the real app on HTTP: a conversation proposal the person
  chooses makes one task and one run under the conversation's command ids; the execution view and
  the Board read the same records, and reading changes nothing; a drag back to Ready asks for a
  Stop, never a second start; the service closes and reopens mid-run, and the task keeps its
  identity with one run, stopped as the service closed and saying so; replaying every
  conversation command dispatches nothing; the queue leaves the stopped task alone with automatic
  start on; the person's Board Start runs it again under a new command, and a retried Start with
  the same command is the same run; the run stops at a decision and Done is refused. Also: the
  view names the Nectovia refusal, and a Nectovia project never reads as switched off; a Start
  on a route that is off is named before it is sent and refused by the real route with the same
  words; two Starts sent at once make one run, and that run still answers its decision; a
  person's reopen of a stopped task is recorded and counted by the queue, and a retried reopen
  adds nothing; a missing task is 404.
- `tests/board-moves.adversarial.test.ts` (SWE-2 lane, corrected here): every column pair against
  all 64 combinations of the facts; every refusal is a sentence; the Move menu matches the table;
  and for each kind of card, every command the table offers lands in the column the move names
  once its route has applied it, with Stop never making a task startable by the queue.
- `tests/task-execution-isolation.test.ts` (SWE-2 lane, extended here): a per-task profile list
  shows on that task alone and clears cleanly; on a route where profiles resolve, task A's profile
  changes task A's route source, model and effort and leaves task B's view and every thread's own
  choices exactly as they were; the view writes nothing; a missing task is 404.
- `tests/task-board-ui.spec.ts`, added to `playwright.config.ts`'s spec list, the built Console
  against an owned host: the task opens in full with its work, how it runs, and its thread one
  click on. A real pointer drag into Review, released as the column opens its caption under the
  pointer, lands and is refused on the card; this test failed before the column accepted on entry
  and passes with it. Then, with the drag events dispatched over one DataTransfer as
  `files-attachments-ui.spec.ts` drops files (a pointer drag's timing over the sideways-scrolling
  Board is the browser's): each column under the drag says what a drop would ask for; a drag into
  Review is refused on the card with no command sent; two drags into Done ask once, and a double
  click on the confirmation sends one task move; the Move menu reopens it; two drags into Working
  ask once, and a double click on Start sends one `work/start` and makes one run, which stops at
  the sample worker's decision; a drag of that card into Done is refused with nothing sent. Below
  Technical detail the task offers no route choice. The Board is opened only once the skin's
  entrance has finished: it moves the Board sideways in steps and holds still between them, which
  Playwright's own stability check takes for settled.
- `tests/cd05-zoom-motion.spec.ts` now opens a task's thread through "Open thread".

## Verification

Run on this branch's working tree (base 8daf0c1 plus this slice) on 2026-09-27, under the
coordination heavy slot `slot_mujeohvl_3d2e8848`. Every count below is from that run.

- `npx tsc --noEmit`: exit 0.
- `npx vitest run`, full, on the final source: 475 files and 8,084 tests; 8,079 passed, 1
  failed, 4 skipped. The failure was `tests/automation-weekly-brief.test.ts` ("saves a
  source-linked draft for review through RunService, with no model call"): EPERM renaming its run
  file, the known Windows `durableWrite` contention. The file passed alone straight afterwards,
  8 of 8. An earlier full run on this branch failed another test in that file the same way, and
  `tests/native-loop-host.test.ts` once on its child's deadline; both files passed alone. None of
  them touches this slice.
- The new and nearest suites on their own: the three new files, 21 of 21; sixteen related files
  (Board, task evidence, profiles, agents, Ready queue and scheduler, conversation seam, backend,
  work control, durable controls, native work, approvals, supervision), 357 of 357.
- `npx vite build`: exit 0 (the existing chunk-size warnings only).
- Playwright, full suite (`playwright test`, every spec in the config), on the final build: 312
  tests; 261 passed, 4 failed, 47 did not run. The named gates passed: `ui`, `native-ui` and
  `field`, 36 of 36. `task-board-ui` passed 4 of 4, and 16 of 16 on its own with
  `--repeat-each=4`. The four failures are Home and Nectovia conversations that the base's
  account gate turns away ("The Nectovia Agent works for a business…"): `diomedes-home:185`,
  `home-luna:232`, `home-route-ownership.review-20260921:140` and `artifacts-ui:1434`. The 47 that
  did not run are the rest of the serial `diomedes-home` (31) and `home-luna` (16) groups after
  those failures. Base 8daf0c1 alone, in a separate worktree, ran the same four specs with the
  same result: the same 4 failed, the same 47 did not run, and 25 passed. So they come with the
  base, not with this slice; main has since moved on, and PR #168 reports them passing there.
  An earlier full run on this branch also failed `editor-guard-ui:487`, `files-attachments-ui:113`
  and `h03-claude-controls:261`; all three passed in the final run.
- The pointer drag test failed on the build without the column's dragenter acceptance, at the
  drop (the column had shown it was under the drag, and no refusal followed the release), and
  passed with it.

## PILLAR IMPACT

- **Advances 06 (control without constant clicks).** A drag is the same command as the button,
  and a move the Board cannot make is refused on the card in words, before anything is sent. The
  only confirmations are the ones the Board already asked for, plus Stop, Mark done, and a Reopen
  while automatic start is on. Evidence: the adversarial table test and the UI spec's refusals
  with no sessions created.
- **Advances 07 (the agent is Nectovia; models are resources).** The task view shows the route,
  the model, the worker and the grant a Start would use, where each came from, and what each past
  run actually used. Evidence: the isolation test and the journey's run list.
- **Advances 08 (deterministic work stays fast).** Every move is decided by a pure table; no model
  is asked what a drag means.
- **Advances 12 (one core, different detail).** The same task view at every detail level; the
  profile choice alone is Technical.
- **Risk to 09 and to the 2026-09-23 routing decision.** The per-task profile choice names routes
  and models. It is Technical only and lists only profiles the owner made; whether it belongs in
  the Console at all is O44 item 5.
- **Risk to 07 (native-first).** Board work cannot run on the Nectovia route yet; the proof runs on
  the sample route and the view says so rather than hiding it (O44 item 7).
- **Supersession:** none.

## ROADMAP IMPACT

No status change while the branch is unmerged. When it merges, the live roadmap's Board and
Console work should record: executable Board slice 1 (research steps 1 to 3) implemented in
source with the tests above, on the sample route only, no live-provider or packaged proof; step 4
and the O44 items open.

## Proposed project-memory patch

Add under the Console's Board: "A Board move is a request for one of the Board's own commands
(Start, Stop, Reopen, Mark done), decided by `shared/board-moves.ts` for drag, the Move menu and
the task view alike. Nothing is moved into Review or Blocked by hand; Working to Ready is a Stop
only; Done needs a settled task. Clicking a card's title opens the task in full; its thread is one
click on. The task's own profile choice is Technical detail only." Cloud synchronisation of this
record is pending.

## Build, publication and deployment status

Committed locally on `feature/executable-task-board`, in the commit that adds this record. Nothing
is pushed, merged, released or deployed, and no version changed.
