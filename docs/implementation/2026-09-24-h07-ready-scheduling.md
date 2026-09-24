# H07 — Ready queue: automatic start, fair scheduling and queue pause

Date: 2026-09-24. Lane `h07-ready-scheduling`, branch `feature/h07-ready-scheduling`.
Linear: DIO-12 (H07 — Durable Ready admission, automatic worker claims and fair scheduling).

## What shipped

Before this slice, leases, fencing and admission idempotency existed, but Ready work only ever
started from a person's Start click. This slice adds, inside the one local service:

1. **A durable Ready scheduler** (`server/ready-scheduler.ts`). For a project that opted in, it
   claims Ready tasks and admits each claim through `admitWork`, the Work start route's own
   admission path in `server/app.ts` — the same function the Board's Start reaches through
   `POST /work/start`, and the same one the follow-up queue already uses. There is no second
   execution path and no new lifecycle: a started task is an ordinary session with an ordinary v1
   Work receipt.
2. **Opt-in per project, default off.** `state.readyQueue.autoStart` is absent on every existing
   project, which reads as off; with it off the Board and the service behave exactly as before
   (a test proves no session is created); with every queue off, a store change costs one look
   per project and takes no lock.
3. **Queue pause and resume**, per project (saved on the project) and for every project at once
   (saved in `<dataDir>/ready-queue.json`). Both survive a restart. A paused queue claims nothing;
   pausing never stops running work (Stop does that). Each pause carries a reason and a time.
4. **Board** (`client/console/BoardView.tsx`, `client/ready-queue.ts`). One row under the Board
   heading: the switch *Start ready work automatically*, the queue's state in one line
   (*You start Ready work* · *Starts automatically · 1 of 2 running across projects* ·
   *Queue paused · reason* · *All queues paused · reason*), *Pause queue* / *Resume queue* and
   *Pause all* / *Resume all*, with an optional reason and the one sentence that running work keeps
   running. With automatic start on, Ready reads in queue order and each row carries its place
   (`#1`, `#2`, or `held`) and the one reason it is not starting.

### Fair scheduling

`shared/ready-queue.ts` holds the pure planner, shared by the server and the Board.

- **Limits** (proposed defaults): one run per project — the Work start path already refuses a
  second run in a project — and two across every project. Manual runs count toward both, so
  automatic start never pushes the machine past what the person already has running.
- **Across projects:** round-robin by least recently served. Every open project (on, not paused,
  under its limit, with a Ready task) is offered one claim per round in order of its latest
  claim's time, oldest first, ties by id, until the global limit is reached. The order is derived
  from the claim records, so a restart rebuilds it rather than resetting it.
- **Within a project:** FIFO by Ready time — creation for a task never run, or the moment the
  person moved it back to Ready — then creation time, then id.
- **Starvation-free:** a project served becomes the most recently served, so as slots free every
  waiting project reaches the front before any is served twice (table test replays 12 slots over
  four projects and gets A B C D A B C D A B C D even when A always holds the oldest work).

### What "Ready" means to the scheduler

`readyAt()` answers for a task that is `todo`, not deleted, has no active run, no open Need and no
change waiting for review, and either was never run or was moved back to Ready by the person after
its last run. A task whose run was stopped, failed or finished is **not** started again unless the
person reopens it: Stop means stop. A unit test proves that everything the scheduler would start is
in the Board's Ready column (`taskEvidence`).

### Trust invariants

- **Same admission.** The command is exactly the Board's: task, route (`selectedEngine`, the
  function the Board's Start uses), the task's own default document when one is set on a service
  route, and the task's thread. Service enabled, consent, cloud sharing, scope, receipt capacity
  and approval gates are all `admitWork`'s own, unchanged.
- **Approvals still stop work.** A sample-route start asks *start working on …* under the default
  permission, and the automatically started session stops at that Need exactly as a manual one
  does; the next task waits with *Next · waits on a decision in this project*. Proven with no change
  record and no file on disk.
- **Consent is never invented.** A service route starts on its own only for a task that already has
  an admitted start on that same route — the confirmation a person gives names the engine, the same
  rule the follow-up queue uses. A Ready task never confirmed for its engine is *held*:
  *Start it yourself: sending to ChatGPT needs your confirmation*. A route switched off in Settings
  is held the same way. Proven: the provider generator is never called.
- **Refusals are visible.** When `admitWork` refuses, the claim is saved `refused` with the start
  path's own words, a History entry says so, and the task is held for the person's own Start until
  it returns to Ready at a new moment. No retry loop.
- **Attribution.** History records *Diomedes started X from the Ready queue.* as a Diomedes
  application action (decision 8: infrastructure actions may truthfully be Diomedes actions); the
  session itself keeps its runtime-reported engine and model.
- The home project is excluded and refuses the setting (`HOME_REFUSES_WORK`).

### Crash safety

A claim (`ReadyClaim`) is persisted **before** admission and carries a fresh Work `commandId`
(`ready:<claim id>`). Admission persists the session with that command on its receipt. On restart,
`init()` settles every claim still `claimed`: if a session holds its command it is marked `started`
with that session and nothing is admitted; otherwise the same command is replayed once. Proven by
`tests/ready-scheduler-child.ts`, which exits the process abruptly (a) right after the claim is
durable and (b) right after admission persisted the session: after restart there is exactly one
session for the task, bearing the claim's command, in both cases.

## Internal API (for Automations milestone B)

The queue **is** the project's Ready tasks. A feeder enqueues by creating a task through the task
route's own path (`POST /api/projects/:id/tasks`, or `createTask` under the store lock); it never
admits work itself.

`ReadyScheduler` (`app.locals.readyScheduler`):

| Member | Meaning |
|---|---|
| `kick()` | Ask for a pass. Cheap when nothing is due; takes the store lock only when a claim is pending or the plan has one to make. Called on every store `change` and `settings` event. |
| `view(projectId)` | The derived `ReadyQueueView` for a project: switch, pauses, limits, running count and each Ready item's position, `why` and detail. Never stored. |
| `configure(projectId, {autoStart?, paused?, reason?})` | Opt in/out and pause/resume, with History entries. Called with the store lock held. |
| `configureAll({paused, reason?})` | Global pause/resume. Called with the store lock held. |
| `settled()` | Resolves when no pass is running or due (tests, shutdown). |

HTTP: `GET/PUT /api/projects/:id/ready-queue`, `GET/PUT /api/ready-queue`.

Claims are the scheduler's only records: `state.readyQueue.claims[]` with `claimed | started |
refused`, the command id, the route, the Ready moment answered and the settled session or reason.
They are evidence and are never pruned (decision 10).

## Tests

- `tests/ready-queue.test.ts` (24): limits and fairness table, starvation replay, round-by-round
  filling at higher limits, pause and global pause, held tasks holding no place, each row's reason,
  eligibility (stop means stop, reopen counts, undone reopen does not), agreement with the Board's
  Ready column, hold reasons.
- `tests/ready-scheduler.test.ts` (16): default off; turning on admits the oldest through the Work
  start path with a v1 receipt; turning off restores today; malformed requests refused; approval
  Need stops work and nothing is written; service route never starts unconfirmed; route off holds;
  a stopped task is not restarted and the next one starts; a start-path refusal is recorded and
  holds; pause never claims and resume starts the oldest; pause never stops running work; project
  and global pauses survive restart; two runs at most across three projects and the third starts
  when a slot frees; manual work counts toward the limit; restart after the claim write and after
  the admission write each start the task exactly once.
- `tests/ready-queue-ui.spec.ts` (Playwright, own host): off by default; pause with a reason; turn
  on while paused and nothing starts, positions shown; resume and the oldest starts and stops at its
  Need while the next says why it waits; pause all leaves the running work running; resume all.

## Proposed defaults recorded here (Andrew's to confirm)

These are the most conservative choices that still deliver the capability. None widens authority.

1. Automatic start is **off** for every project until the person turns it on.
2. Limits: **1 per project, 2 across projects**, manual runs included. Not user-configurable yet.
3. A service route (anything but the sample worker) starts automatically **only for a task that
   already has an admitted start on that route**. A standing, per-project, per-engine consent to
   send never-confirmed Ready tasks automatically would change what a confirmation means, which is
   a Trust/permission-preset question (AGENTS.md "Not yours to decide"), so it is not built. In
   practice this means automatic start today runs sample-route work and re-runs of work the person
   already confirmed for an engine.
4. A stopped, failed or finished task is not restarted automatically unless the person reopens it.
5. A refused claim holds the task for the person's own Start until it re-enters Ready.
6. Source documents on an automatic start are the task's own default document only (or none).

## Known gaps

- No per-engine standing consent (see default 3), so a brand-new Codex/Claude task still needs a
  person's Start once.
- Limits are constants, not settings; per-project above 1 would first need the Work start path to
  allow concurrent runs in a project.
- Global pause/resume writes no project History entry (it is not a project event); the pause and
  its reason are shown on every Board.
- The scheduler admits under the store lock, like follow-up delivery; a slow document listing in
  one project's admission delays the next claim.
- No Automations feeder is wired yet (milestone B consumes the API above).
- `docs/harness/HARNESS_INTEGRATION_MAP.md` uses "H07" for *Execution teleportation*; Linear DIO-12
  uses H07 for this work. The canonical docs should settle one name.

## Proposed canonical-doc patch

Not applied here: the integrator reconciles the canonical documents.

**`docs/DIOMEDES_LIVE_ROADMAP.md`** — in the Automations section, after the Milestone B bullet
(line beginning `- Milestone B / OPS-08 + OPS-09:`), add:

> - H07 Ready queue (DIO-12, 2026-09-24, `docs/implementation/2026-09-24-h07-ready-scheduling.md`):
>   implemented on branch `feature/h07-ready-scheduling`, pending merge. Per-project opt-in
>   automatic start of Ready tasks (default off) through the existing Work admission path, fair
>   least-recently-served order across projects with FIFO by Ready time, limits 1 per project and
>   2 overall (manual work included), durable project and global pause, crash-safe claims proven
>   with abrupt-exit tests, and Board visibility of place and reason. Automatic start of a
>   never-confirmed task on a service route is not built (open decision below). Milestone B feeds
>   this queue by creating Ready tasks; it adds no second admission path.

and in the open-decisions paragraph (line beginning `Existing open decisions remain:`), append:

> whether a per-project, per-engine standing consent may let the Ready queue send never-confirmed
> tasks to a service route; whether the Ready queue limits (1 per project, 2 overall) become
> settings.

**`docs/DIOMEDES_PROJECT_MEMORY.md`** — add to the definitions:

> **Ready queue.** A project's Ready tasks, in the order Diomedes would start them when the
> project's *Start ready work automatically* switch is on (off by default). A start from the queue
> is a Work command admitted by the same path as a person's Start and carries no authority that
> Start would not; work that asks for approval stops at its Need. *Pause* stops the queue from
> starting anything and never stops running work. A task is *held* when it waits for the person's
> own Start — its engine needs their confirmation, the engine is off, or the start path refused it.

**`QUESTIONS.md`** — add an open question: *Ready queue consent for service routes* — may a person
give a standing, per-project, per-engine consent so the Ready queue can send never-confirmed Ready
tasks to that engine? Proposed default until answered: no; such tasks are held for the person's
Start.
