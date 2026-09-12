# Work control: three Stops that mean what they say, and a durable follow-up queue

Date: 2026-09-11
Worktree: `F:\Diomedes\diomedes-wt\opus-work-control`, branch `opus/work-control-20260911`
Slice: ENG-09, ENG-10, REL-05 idempotency. ENG-08 (steering at a safe point) is **not** in this
slice; see *Partial or blocked*.

Nothing here is committed, pushed, packaged or released.

---

## What is implemented and proven

### The frozen contract is honoured, not reshaped

`shared/work-control.ts` was not changed. Two optional fields were added to `shared/types.ts` and
nothing else in that file: `Task.stopReceipts?: StopReceipt[]` (append-only) and
`ProjectState.followUps?: FollowUpCommand[]` (absent in older projects). Both flow to the client
through the existing `statePayload` spread, so no fan-out change was needed.

### `server/work-control.ts` (new)

A `WorkControl` class wired by the app with the `Store`, the `NativeWorkService`, the Work start
route's own admission callable, the existing per-session stop callable, and two injected predicates
(which routes exist, and which model a thread would resolve now).

- `queue` validates with `queueFollowUpSchema`, refuses an unknown route, refuses at
  `MAX_FOLLOW_UPS_PER_TASK`, assigns `order = last queued + 1`, appends to `ProjectState.followUps`,
  writes a `follow-up` History entry reading
  `You queued a follow-up for <task>, <wait label>.`, and persists. The `commandId` is the client's,
  minted the same way `client/work-start.ts` mints a Work start's. A second `queue` with the same
  `commandId` returns the record already saved; a same-id request naming a different task or text is
  a 409 conflict, and an id already spent on a Work start, an approval decision or a scope grant is
  refused at queue time rather than at delivery.
- `edit` and `remove` touch queued items only. A delivered, cancelled or rejected item is 400.
  `remove` cancels rather than deletes: what was asked for and then withdrawn is part of the account
  of the task (standing decision 10).
- `reorder` requires exactly the task's queued ids, each once. Anything else is 400.
- `stop` returns a `StopReceipt` and appends it to `Task.stopReceipts`.
  - `generation` aborts the live run's controller through the new `NativeWorkService.interrupt`,
    logs `Interrupted the current request.` to the session, and changes nothing else: the session
    state is untouched, open Needs stay open, and the queue stays queued. With no live request the
    receipt is `acknowledged: false` with `uncertainEffects: []`.
  - `task` calls the existing per-session stop (unchanged, and through `serviceFor`, so a sample or
    harness session keeps its own behaviour), then cancels every queued follow-up for that task with
    `cancelledBy: 'stop:task'` and lists them on the receipt.
  - `queued` cancels queued follow-ups only, with `cancelledBy: 'stop:queued'`, and touches no
    session.
  - Every receipt carries
    `['Provider work already sent can complete and be charged after Stop.']` when a run was live for
    that task at the moment of the call, and `[]` otherwise.
- `deliverDue(projectId, moment)` picks `nextDeliverable(...)`, then, in this order: leaves the item
  **queued** when any session in the project is active (a busy project is not a reason to reject
  what the person asked for, and the ordinary start path would refuse it anyway); rejects when the
  task is gone; rejects when the route is no longer in `ROUTES`; rejects a `turn` item whose task is
  already `done`; rejects when the task has no recorded consent for that route; rejects when the
  saved model snapshot is not what the thread would use now. Then it admits an ordinary Work command
  through `admitWork` with the follow-up's own `commandId`, its `text` as `instruction`, its
  `sources`, its `route`, its `agentId`, and `threadId` = the task's thread. On success it marks
  `delivered` with `deliveredSessionId` and writes a `follow-up` History entry; on any refusal it
  marks `rejected` with the refusal's own message.

### Delivery cannot widen authority

`admitWork` is the Work start route's body, extracted verbatim — the `isUpdateClosing` check, the
capability branch, `parseWorkCommand`, the thread lookup, the route choice, the team refusal, the
service-enabled check, the consent check, the source-list check, the receipt replay, the receipt
capacity check, `nativeChoice`, and the hand-off to `nativeWork.start` or `work.start`. The route is
now one line that calls it. There is no second start path and no duplicated validation, so a
delivery cannot reach the runtime by a door a person's Start does not use. It mints nothing: if the
task's scope grant has expired, the ordinary start path refuses and that refusal becomes the visible
rejected reason.

### The delivery trigger

The brief allowed a hook in `native-work.ts` or a subscription to the Store event. I subscribed,
because the authoritative "this session is done" transition for a native run with writes is
`Store.settleApproval`, not `native-work.ts`, and `server/store.ts` is outside this slice's files.
`Store.persist` announces every durable write, so `app.ts` listens for `change`, and for each task
with queued follow-ups queues one `deliverDue` behind the store lock (never inside it — the lock is
a queue, not reentrant). It is a level check rather than an edge: a turn has ended when the task has
run at least once and none of its sessions is active. That is idempotent, so a burst of writes
cannot deliver twice; a per-project in-flight flag collapses a burst into one pass plus at most one
follow-on. `app.locals.close` removes the listener and drains the deliveries **before** anything is
stopped, so shutting a run down cannot schedule a delivery on the way out.

### Routes

`POST /api/projects/:id/follow-ups`, `PUT /api/projects/:id/follow-ups/:fid`,
`DELETE /api/projects/:id/follow-ups/:fid`, `POST /api/projects/:id/follow-ups/reorder`,
`POST /api/projects/:id/stop`, plus a `GET /api/projects/:id/follow-ups` listing. The existing
`POST /api/projects/:id/work/:sessionId/stop` stays where it was and now runs through
`stop` with `scope: 'task'`, and still answers with the session, so old clients and
`tests/harness-host.test.ts` see exactly today's behaviour.

### Client

`client/console/FollowUpQueue.tsx` (new) sits under the composer when the thread has a task: a text
area, an `after this turn` / `after the task is done` choice using `followUpWaitLabel`, and one line
per item (decision 4) with edit, remove and up/down reorder for queued items and the outcome plus
reason for delivered, cancelled and rejected ones. `client/console/StopMenu.tsx` (new) keeps a
button labelled exactly `Stop` with today's meaning and puts `Stop this request` and
`Cancel queued follow-ups` behind an adjacent `Stop options` menu, each disabled when it would do
nothing and rendered only while the menu is open, so `tests/ui.spec.ts`'s
`getByRole('button', { name: 'Stop', exact: true })` still resolves — by inspection of that
`exact: true` locator, not by running it; Playwright was not run here. `StopReceiptLine` shows the last
receipt under its run record: scope, whether it was acknowledged, how many follow-ups it cancelled,
and the uncertain-effects sentence when present. `client/api.ts` has typed callers for the five
routes; `client/work-start.ts` now exports `mintCommandId` and uses it itself, so a follow-up's
command identity is minted in the same place as a Work start's. The follow-up text and the wait
label truncate where they are written, with `min-width: 0` (decision 5); the new CSS is a fenced
block appended to `client/console/console.css`.

### Verification actually run

```
F:\Diomedes\diomedes-wt\opus-work-control> ./node_modules/.bin/tsc --noEmit
(no output; exit 0)
```

```
F:\Diomedes\diomedes-wt\opus-work-control> ./node_modules/.bin/vitest run tests/work-control.test.ts \
    tests/native-work.test.ts tests/work-admission.test.ts tests/scoped-work.test.ts tests/harness-host.test.ts

 Test Files  5 passed (5)
      Tests  139 passed (139)
   Start at  22:02:35
   Duration  17.48s
```

The whole suite was then run twice, because the first run was not clean:

```
F:\Diomedes\diomedes-wt\opus-work-control> ./node_modules/.bin/vitest run

 Test Files  2 failed | 81 passed (83)
      Tests  9 failed | 1402 passed | 1 skipped (1412)
   Start at  21:54:00
   Duration  66.53s
```

```
F:\Diomedes\diomedes-wt\opus-work-control> ./node_modules/.bin/vitest run

 Test Files  83 passed (83)
      Tests  1411 passed | 1 skipped (1412)
   Start at  21:57:57
   Duration  38.85s
```

The nine failures in the first run were load flakes, and the second run of the identical tree with
no edits between them is the evidence: eight were in `tests/harness-host.test.ts`, all of them in
that file's shared `ready()` helper, whose `vi.waitFor` uses the 1 s default while the run was
executing 246 s of tests in 39 s of wall clock; the ninth was `tests/harness-negative.test.ts`
losing a 20 ms timer race (`expected /stale attempt/ but got 'This run was cancelled: stop'`).
Both files were also run alone and passed 62/62, and `tests/harness-host.test.ts` passed 22/22 in
each of the five-file runs above. This slice cannot plausibly reach them: the only always-on
addition is the `change` listener, and for a project with no `followUps` it is one `?? []` filter
and a return.

`tests/work-control.test.ts` is new and holds the brief's ten numbered tests, written failing first
(10 failed before the routes existed, then 10 passed). No existing test file was edited: every
shared fixture the brief pointed at was already local to its own file, so there was nowhere to add.

`vite build` and Playwright were not run: the brief forbids the packaging and Playwright paths in
this worktree. The four-gate run belongs to the integrator on the merge commit.

---

## Partial or blocked

**ENG-08, steering at a safe point, is not implemented, and `note` cannot honestly claim it.**
`NativeWorkService.note` appends a sentence to the session log and persists. It is not read by
`prepare`, it is not part of the prompt, and the prompt for a run is composed once before
`this.generate(...)` is called; the adapter is given a completed prompt and an `AbortSignal` and
nothing else. There is no supported route with a proven mid-turn input channel, so nothing in the
current runtime could carry a note into a turn already in flight even if `note` tried. Its own
sentence — "This note does not alter a proposal already being prepared." — is therefore true, and
was left exactly as it is. Calling the follow-up queue "steering" would be the drift this slice
exists to avoid: a follow-up is a *new* admitted command with its own identity that runs after the
current turn, not a way to change the current one.

**Two decisions worth naming, because they are visible.**

1. A `turn` follow-up whose ending session also completed the task is **rejected**, not delivered,
   with `This task finished before the follow-up could be sent, so it was not started.` That is the
   brief's literal re-validation ("the task still exists and is not `done` for a `turn` item"). The
   consequence is real: on the no-files-changed path `native-work.ts` sets both the session and the
   task to `done` in one step, so a follow-up queued "after this turn" against a run that turns out
   to need no changes is refused rather than reopening a finished task. The alternative reading
   (deliver anyway) is defensible; if Andrew prefers it, the change is one condition in
   `deliverDue`.
2. `generation` leaves the run in `NativeWorkService.runs` and the session in `working`, because the
   contract says the session must not become `stopped`. `prepare` sees the aborted signal and writes
   no proposal, so the session waits for a proposal that will not now arrive, the project stays
   busy, and `releaseToken`/`finishTeam` do not fire until a task Stop ends it. That is the frozen
   contract's own description ("`waiting` for a proposal that will not now arrive"), not an
   oversight — but it does mean `generation` is a way to stop spending, not a way to free the
   project.

**Not carried by the queue yet.** The composer control sends `sources: []` and `model: null`. The
contract, the server and the delivery path all carry both, and a non-null model snapshot is
re-validated against what the thread would use now and rejected on mismatch rather than substituted;
there is simply no source picker or model picker in the follow-up control. A delivered follow-up
therefore proposes new files rather than editing selected ones. This is a UI gap, not a contract
gap.

**Consent, precisely.** "The original start recorded consent" is read as: this task has a session
whose Work receipt names the same route. A non-sample start is refused unless the person confirmed
sending to that engine, so the receipt *is* the consent record; matching the route matters because
the confirmation names the engine, and consent for Codex is not consent for Claude Code. A task
whose only start came from a client that predates the Work command protocol has no receipt and is
refused with `This route needs your confirmation before sending; open the task to start it.`

---

## Exact next action

Land the one-line Shell edit below, then run the four gates on the merge commit
(`npx tsc --noEmit`, `npx vitest run`, `npx vite build`, then the three Playwright specs) in an
isolated checkout with ports 5174 and 47632 free and no other agent verifying, and report the real
counts from that run.

---

## Needs the integrator

Exactly one edit outside this slice's files is required. `client/console/Shell.tsx` owns the
ThreadView mount; without this line the queue control still queues, but no rows appear, because
`ThreadView` defaults `followUps` to an empty list.

- **`client/console/Shell.tsx`**, in the `<ThreadView …>` props (currently around line 889,
  immediately after `changes={state.changes}`), add:

```tsx
              followUps={state.followUps ?? []}
```

Nothing else outside the list is needed. `client/types.ts`, `Rail.tsx`, `paletteEntries.ts` and the
Files panes were not touched, and `server/store.ts` needed no change: the delivery trigger uses the
`change` event `Store.persist` already emits.

One optional second edit, in the same file. A scoped Stop from `StopMenu` is fired as
`void stopWork(...)` from `ThreadView`, so a 404 or a 400 on it fails silently; `FollowUpQueue`
surfaces its own errors, `StopMenu` has no channel to. If `Shell.tsx` passes its existing error
reporter down as an `onError` prop, the refusal becomes visible. Nothing is wrong without it: the
scoped Stops are guarded server-side and the receipt line tells the truth about what happened.

Three things for the integrator to be aware of rather than to edit:

- `client/console/console.css` gained a fenced block at the end of the file. If another worker also
  appended there, that is the likely merge point.
- `server/app.ts`'s `teamForThread` now takes `(projectId, threadId, port)` instead of
  `(req, projectId, threadId)`, so the Work start body could be extracted without a `Request`. Both
  call sites in `app.ts` were updated; there are no others.
- The whole suite is load-sensitive in this tree: one full run failed nine tests in
  `tests/harness-host.test.ts` and `tests/harness-negative.test.ts` on 1 s `vi.waitFor` and 20 ms
  timer deadlines, and an immediately following run of the identical tree passed 83/83. Run the
  gates with nothing else competing for the machine.

---

## PILLAR IMPACT

**Pillar 06 — no routine babysitting; control without constant clicks. Advanced.** A person can now
say what should happen next without sitting on the run: the follow-up is durable, ordered, visible,
and it starts itself when the turn or the task ends. Observable proof: `tests/work-control.test.ts`
test 5 — a `turn` follow-up delivers when its session ends and a `task` follow-up waits for the task
to be done, each as one admitted Work command. The three Stops are the other half of the same
pillar: control that is exact about what it reaches, rather than one button that means three things.

**Pillar 08 — human judgment is for judgment; deterministic work stays fast. Advanced.** Delivery is
deterministic and already authorized: no new approval, no model, no reasoning step. It re-checks the
route, the task, the consent record and the model snapshot, and it refuses in words rather than
asking again. Nothing about a delivery makes the model its own approver — the proposal it produces
still meets the same exact-approval or scope path the ordinary path meets. Observable proof: test 7
(withdrawn route rejects and admits nothing) and test 8 (no recorded consent rejects before any
provider call — `generator` is still called exactly once, for the original start).

**Pillar 09 — trust, data choice and billing are part of the architecture. Advanced, with the risk
named.** The risk the brief flagged is real: a delivery that widened authority would be a pillar-09
violation, not a bug. Three things hold it closed. Delivery has no start path of its own — it calls
`admitWork`, the same callable the route calls, so an expired grant, a service turned off or a
missing consent refuses there and the refusal is what the person reads. Consent is route-matched, so
a confirmation naming one engine cannot send to another. And the command identity is the follow-up's
own, recorded as a Work receipt in the one project-scoped command namespace, so a restart, a double
click or a reconnect replays the same command rather than starting a second charged run (test 1 and
test 10). Billing honesty is on the receipt too: every Stop that reached a dispatched request says
`Provider work already sent can complete and be charged after Stop.`, because no scope can make that
untrue.

No pillar conflict was found, and nothing here required a decision from the *Not yours to decide*
list.

---

## ROADMAP IMPACT

- **ENG-09 (distinct stop scopes):** implemented and proven in this worktree, unmerged. Evidence:
  tests 2, 3 and 4 in `tests/work-control.test.ts`, plus `Task.stopReceipts` persisted append-only.
- **ENG-10 (durable follow-up queue):** implemented and proven in this worktree, unmerged. Evidence:
  tests 1, 5, 6, 7, 8, 9 and 10.
- **REL-05 (idempotency):** extended to follow-ups. A follow-up's `commandId` is minted once by the
  client and is the identity the delivery admits with. Evidence: test 1 (one record however often it
  is sent) and test 10 (a delivered follow-up is not sent again after a restart).
- **ENG-08 (steering at a safe point):** unchanged, still not implemented. Do not mark it moved.

---

## BUILD / PUBLICATION / DEPLOYMENT STATUS

Nothing was built, packaged, published or deployed. `npm run build`, `npm run package:desktop`,
`npx vite build` and Playwright were not run in this worktree, and no version was bumped and no
native-runtime hash was touched. No commit and no push: every file listed below is uncommitted in
`F:\Diomedes\diomedes-wt\opus-work-control` on `opus/work-control-20260911`, awaiting Andrew's
approval for this patch.

## Files

Created: `server/work-control.ts`, `client/console/FollowUpQueue.tsx`,
`client/console/StopMenu.tsx`, `tests/work-control.test.ts`,
`docs/implementation/2026-09-11-work-control.md`.

Modified: `shared/types.ts` (two optional fields), `server/native-work.ts` (`liveRun`, `interrupt`),
`server/app.ts` (extracted `admitWork`, `teamForThread` signature, `WorkControl` wiring, the change
subscription, five routes, the legacy stop route, close ordering), `client/api.ts`,
`client/work-start.ts`, `client/console/ThreadView.tsx`, `client/console/console.css`.
