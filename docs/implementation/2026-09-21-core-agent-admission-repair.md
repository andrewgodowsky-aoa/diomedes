# CD-01: the interaction admission seam, repaired

Date: September 21, 2026. Status: repaired and mutation tested on
`feature/core-agent-admission-repair`. Not merged, not released.

The bounded independent review of CD-01 is in
[`cd01-bounded-review-20260921/`](cd01-bounded-review-20260921/): `OWNER-HANDOFF.md`
carries the nine numbered repair boundaries, `REVIEW-RESULT.md` the executed result,
`INDEPENDENT-REVIEW-ADJUDICATION.md` the parent's findings on the two delegated
reviews, and `verdict.json` the machine record. The review rejected the seam with
eight of its twenty six oracle cases red at `26b33ff`.

The reviewer's two oracle files are frozen and were not edited by the repair:

- `tests/interaction-authority.matrix-20260921.test.ts`
- `tests/interaction-seam.review-20260921.test.ts`

`git diff --stat 25122e0..HEAD -- tests/` shows added files and nothing else.

## The repair commits, and the boundary each closes

| Commit | Boundary | What it changed |
| --- | --- | --- |
| `31c10e942ea1a0c98607d4c8af165147d419b409` | 8 | A turn that succeeded carrying no response is an acknowledged interruption, not an answer. The outcome reads the durable turn result instead of hard-coding `interrupted: false`. |
| `338d0a182e62819b8c1e7b4b506a8cd49b30b9a8` | 6, task half | A child receipt is trusted only where its command holds this message's own intent. `receipts` asserts the family and the payload digest before returning a task. |
| `9319246c6aa9c2e6892fd7e4c73c4750757942ab` | 7 | Receipt-only replay is split from new admission, so an identical selection retry returns its committed receipt after authority is withdrawn. |
| `ee9e45cf541dcf6bb26ccef248212f87a74f4656` | 1 to 5, and 6's Work half | Each child admission re-reads the thread, the lineage, the Mode as it stands and the saved selection, then commits inside a narrow guard on the source run's queue. The Work route is resolved once and saved in the `work-input` phase. |
| `a6a110aed64a976a8aa2761ec645d7f30c562701` | 9 | Two identical concurrent selections converge on one record instead of one receipt and one conflict. |
| `eec433fb95941cde56b81c40344645b6e95cb166` | 6, correction | A Work command bound to different work is not this message's receipt, but the read no longer throws for it: the Work admission refuses it in its own words and that refusal stays readable. |
| `7b063b6bc5e77d4292688b1cd87cf09dc4d608f8` | composability | No behaviour change. The guard and the convergence moved into `RunService` keyed by the source run id, so a second driver does not copy them. |
| `4b0e68f334ccbcd25be5a0715ea0a3b617e7e7ce` | evidence | Seven executed schedules for the guards the matrix leaves standing. Tests only, no production change. |

## Lock order

`Store.locked`, then the source run's writer queue, then the child's durable commit.

- **Store.** `interactionHost.createTask` and `.startWork` (`server/app.ts` 2956 and
  2973) take it. So do the run-cancel route, the message route's `resolve` and
  `project`, and the thread Mode PUT. This is the lock that orders every Mode write
  against every child admission.
- **The source run's queue.** `RunService.fence` (`server/harness/run-service.ts:507`)
  enters `serialize(runId, ...)`. `ClaudeSessionRuns.fenced`
  (`server/harness/claude-session-run.ts:492`) is the thin caller. It is entered from
  `createTask` directly and from `WorkService.start` (`server/work.ts:96`) and
  `NativeWork.start` (`server/native-work.ts:431`) through the `commit` guard that
  `startWork` hands to `admitWork`. Every Runtime-only transition takes that same
  queue: `cancel`, the start, success and failure commits of `step`, `decide`,
  `complete`, `fail`, `recover` and `claim`.
- **The child's commit.** `createTaskFrom` calls `store.persist`; the two Work paths
  call `recordWorkAdmission` and `persist`. For Work this creates a new run, which is
  a different queue.

There is no Runtime queue to Store acquisition. `run-service.ts` imports only
`./run-store.js`; neither it, `claude-session-run.ts` nor `run-store.ts` imports
`../store`. The one hook that needs Store, `HostRunService.afterStep` calling
`bridge.flush()`, runs in a `finally` after `super.step` returns
(`server/harness/host.ts` 327 to 331), outside `serialize`. Nothing inside a `fence`
callback touches the source run.

## What enters the guard, and what stays outside

Boundary 5 is explicit that preparation must not be held inside the guard.

**`server/work.ts`.** Outside: the in-progress check, the task lookup,
`listDocuments`, `project.missing`, the target sha read, session and run
construction, `this.runs.set`, `store.snapshot` and `changeReview.runStarted`.
Inside: the re-read of project state, revalidation of the task and of "no other
active session", `sessions.push`, `recordWorkAdmission`, the task mutations, and
either `need(run, 'start')` or the working transition with `persist` and `schedule`.

**`server/native-work.ts`.** Outside: the engine, consent, in-progress and task
checks, the source checks, `agents.resolve`, `checkFolder`, the per-source
`readDocument`, `assembleInstructions`, the team lookup, `readTeamSecrets` and the
token lease; and after the guard, `changeReview.runStarted` and the unawaited
`prepare(run)`. Inside: revalidation, session construction, `sessions.push`, the
task mutations and `moveTask`, the log and history entries, `NativeRun`
construction, `this.runs.set`, `recordWorkAdmission`, `TeamService.acceptRun` and
`persist`.

**The Mode, lineage and selection recheck** runs under `Store.locked` immediately
before the fence, not inside it. Store is the lock that orders every Mode write, so
a check anywhere in that critical section is inside the protected commit for Mode
purposes. `admissionContext()` awaits `store.projects()`, which does folder checks,
and boundary 5 wants that outside the guard. The split is: Store protects the Mode,
the source run's queue protects Runtime terminal transitions.

## How a second driver enters the guard

Hand this to the AWS owner. It is the previous worker's section, reproduced here
with its dashes rewritten as ordinary punctuation, its escaped generics restored and
its ellipsis spelled out. Nothing else is changed.

- **`RunService.fence<T>(runId: string, principal: HarnessPrincipal, action: (run: HarnessRun) => Promise<T>): Promise<T>`**,
  `server/harness/run-service.ts:507`. Pass the *source* run id,
  `localHarnessPrincipal(projectId)`, and a callback. Fence serializes on that run's
  writer queue, loads the run, scope-checks the principal, refuses
  `completed | cancelled | failed | reconcile_required` with
  `HarnessError('run_settled', ...)`, then calls the callback with a copy of the run
  as it stands inside the queue. `HostRunService extends RunService`, so the instance
  a driver already holds has it.
- **The callback must never**: `claim`, `record`, `step`, `cancel`, `recover`,
  `fence` or `serialize` on the same run id (it would wait on the queue it holds);
  await a provider, a person or background work; acquire `Store.locked`, which must
  already be held by the caller, because Store is taken before the queue and never
  under it.
- **The driver's own wrapper** adds its capability and project check inside the
  callback and translates `run_settled` into its own words.
  `ClaudeSessionRuns.fenced(projectId, runId, commit)`
  (`claude-session-run.ts:492`) is the model; copy its shape, not its logic.
- **`assertLive` stays the driver's pre-check, outside the fence.** Keep it:
  `tests/interaction-authority.matrix-20260921.test.ts:584` pins `checks === 2` per
  selection, so the fence must not call it and the two existing calls must not be
  removed.
- **`RunService.join<T>(key: string, action: () => Promise<T>): Promise<T>`**,
  `run-service.ts:526`, for identical immutable writes. Key shape used today:
  `` `phases:${projectId}:${runId}:${digest(phases)}` ``.
- **`ConversationDriver`**, `server/interaction-service.ts:128`. Four members:
  `locate`, `phases`, `record`, and
  `turnResult(projectId, runId, commandId)` returning `{ answered, interrupted }` or
  `null`. Satisfy these structurally and `InteractionTurns` composes with no change.
  The Mode re-read, the child-intent digests, the receipt-only replay and the
  outcome projection all live above this and assume no driver.

## The `work-input` phase body now carries the route

Boundary 6's Work half required boundary 1's route pin. Without a saved route, the
expected Work digest would be recomputed from the target project's engine setting as
it stands, so changing that setting would make a pure read report a conflict for work
that started correctly. `InteractionHost.workRoute` resolves the route once and the
`work-input` phase carries it, alongside the project, the Work command id and the
task id.

**The consequence, for an integrator.** This changes the `work-input` phase body, and
`append` refuses a phase already saved with a different body
(`HarnessError('intent_mismatch', ...)`, answered as HTTP 409). A message whose
`work-input` was written by an earlier build and retried on this one conflicts. The
seam is unreleased, so no legacy fallback was added: a fallback would reintroduce
exactly the volatility the pin removes. The mutation of this pin, M12 below, is
killed by precisely that conflict.

## Mutation results

Each mutation removes one guard, the targeted test is run and confirmed red, the file
is restored byte for byte and the test is confirmed green again. The oracle is the
three files: the reviewer's two frozen files plus
`tests/interaction-authority.repair-20260921.test.ts`, and now
`tests/interaction-authority.schedules-20260921.test.ts` as well.

| # | Guard removed | Verdict | Killed by |
| --- | --- | --- | --- |
| M1 | b8, report the saved interruption | KILLED | `polling preserves a durably acknowledged interruption` |
| M2 | b6, the task command digest | KILLED | `a child command already bound to different task intent must conflict` |
| M3 | b6, trust a Work receipt only on its digest | KILLED | `a Work command already bound to different work is never this message's start` |
| M4 | b7, receipt-only replay at all | KILLED | `an identical selection retry returns its committed receipt after authority is withdrawn` |
| M5 | b7, replay only a committed or refused child | KILLED | `an identical selection with nothing committed is refused once the conversation moved on` |
| M6 | b2, intersect the Mode as it stands | KILLED | the ask, plan and independent narrowing cases, three of them |
| M7 | b2, refuse a retired lineage | KILLED | `a lineage retired between the selection pre-check and the commit refuses the child` |
| M8 | b2, the pinned target, digest and derived command identity check | SURVIVED | see below |
| M9 | b3, refuse a settled run inside the fence | KILLED | `a concurrent provider failure after liveness check must prevent new Work` |
| M10 | b5, `work.ts` revalidates prepared scope | KILLED | `a competing session admitted after the sample Work path prepared refuses the start` |
| M11 | b5, `native-work.ts` revalidates prepared scope | KILLED | `a task removed after the native Work path prepared refuses the start` and `a competing session admitted after the native Work path prepared refuses the start` |
| M12 | b1, the saved Work route | KILLED | `a retry after the target project engine changed starts the route this message pinned` |
| M13 | b9, join an identical phase save | KILLED | `concurrent identical selections converge on one receipt` |
| M14 | b4, thread the fence into the Work start path | KILLED | `a concurrent provider failure after liveness check must prevent new Work` |
| M15 | b3, hold the queue across the child commit | KILLED | `a terminal transition asked for inside the child commit lands after it, never during` |
| M16 | b2, the pair: the block message and the identity check together | KILLED | the ask, plan and independent narrowing cases, three of them |
| M17 | b2, the block message alone | SURVIVED | see below |

### The five mutations run for this record

| # | File and place | The edit |
| --- | --- | --- |
| M7 | `server/app.ts`, `admitChild` | `if (!lineage \|\| lineage.retired)` becomes `if (!lineage)` |
| M10 | `server/work.ts`, the commit callback | delete the task refusal and the in-progress refusal, keep the lookup |
| M11 | `server/native-work.ts`, the commit callback | delete the same two refusals |
| M12 | `server/interaction-service.ts`, `settle` | the pinned route becomes `await this.host.workRoute(verdict.projectId)` unconditionally |
| M15 | `server/harness/run-service.ts`, `fence` | drop the `serialize` wrapper, keep the load, the scope check and the settled check |

Restoration evidence, SHA-256 of each file before the mutation and after the restore,
with `git diff --quiet` clean on each:

```
9d99131dead9d6df69e86b36400f3064e68ff8079dfa1c96958db75d76dd9531  server/harness/run-service.ts
3f735c2cb0c6dd66ba29f549eb9a4eb977d1cd1e911df2dd82f41012e1035d62  server/work.ts
fbd8dc8b1d74c914598fc077a4686ec5b2b53522a1129f1b1f4743a397d04531  server/native-work.ts
6dadca599c5656b14e3becf2c7fe53e7d0f884cee1d059cfe3b5eb14aff51e1f  server/app.ts
d9da7956f5f4268788e170fbaa9a198664d37ccc8986d21758647b90daaf178a  server/interaction-service.ts
```

### What the queue-hold schedule shows

The matrix's provider-failure case waits for the Runtime's terminal state to become
durable *before* the fence is entered, so the fence's own terminal check alone
answers it. Nothing there distinguishes holding the queue from checking the state.

The new schedule asks for the transition while the commit is open. It holds the child
commit at a barrier inside the fence callback, on the one `persist` that carries this
message's own admitted session, then calls `RunService.cancel` on the source run
directly. Cancel is the Runtime primitive that the failed step commit, `decide`,
`fail` and startup `recover` all share: it enters the same writer queue and never
acquires Store. The HTTP cancel route cannot be used here, because it reaches that
queue only after `Store.locked`, which the admission is holding.

The proof is that after 300 milliseconds the cancellation has not landed, and the
source run read back is deep-equal to the run as it stood when the commit began.
With the hold removed it lands during the commit and the test is red.

The honest outcome is boundary 4's second half, in the handoff's own words:
"Cancellation/narrowing first means no new prohibited child; child commit first
preserves that child's identity." The commit was first here. The child keeps its
identity, and the conversation settles after it. The receipt phase cannot then be
written on a settled run, so the selection's own HTTP response is 409 while the
durable record reads as started, and a later read of the message reports the session
that was admitted. This is what the code is designed to guarantee. It does not
guarantee that a selection whose source run settles mid-commit answers 200.

## Survivors, with the honest reason

- **M8 and M17 are each other's second guard.** Removing the `blocked` throw alone
  leaves the identity check, which refuses on `verdict.outcome !== 'escalate'`.
  Removing the identity check alone leaves the `blocked` throw. M16 removes both and
  kills all three narrowing cases. This is a disclosed redundant pair, not an
  unguarded path: the boundary is proved by M16, and either half alone is covered by
  the other.

No other mutation survives.

## Other findings the repair rests on

1. **Boundary 3 asks to "replace the liveness-only read". It could not be replaced.**
   `tests/interaction-authority.matrix-20260921.test.ts:584` asserts `checks === 2` by
   counting `assertLive` calls during one selection. Removing it fails that case. The
   adjudication anticipated this tension. `assertLive` is kept exactly where it was
   and the fence was added beside it.
2. **`receipts()` throws for a task-command conflict but only declines to trust for a
   Work-command conflict.** The task side must throw: returning null routes the
   conflict through `createTaskFrom`'s own `assertReplay` into `settle`'s refusal
   path, which records `task-refused` and answers HTTP 200, while the matrix requires
   409. The Work side must not throw: `admitWork` already refuses with its own 409 and
   `settle` records `work-refused`; throwing from the read as well made that honest
   refusal unreadable. `eec433f` corrects this.
3. **Boundary 6's wording is loose against source.** It says `receipts` "uses only
   `findCommand` and family checks". At `25122e0` it used `findCommand` with no family
   assertion: it pattern-matched `task?.type === 'task.create'`, so a `work.start`
   record bound under the task command id read as null rather than conflicting. The
   repair adds the assertion.
4. **Boundary 9's summary misattributes the 409.** It comes from the
   `action-selected` phase record, not from admission: two concurrent `append` calls
   reach `RunService.step` for the same step id and the second gets
   `blocked: 'step already in flight'`. The review's own citation
   (`claude-session-run.ts:379`) is right; the sentence is not.
5. **Concurrent-selection convergence lives in `RunService.join`, not above the
   driver.** The coordinator asked for it above any driver. It cannot go there:
   `tests/interaction-authority.matrix-20260921.test.ts` 339 to 346 wraps
   `runtime.record` and releases only at `arrivals === 2`, so a join above the driver
   method starves the oracle's own barrier and deadlocks. The mechanism lives once,
   driver-agnostic and keyed by the caller; `ClaudeSessionRuns.record` is a three-line
   caller. The stated requirement, one implementation with no per-driver copy, is met.
6. **A saved Work route can be pinned and a retry can reach it.** The previous
   worker recorded M12 as unreachable, on the ground that the `work-input` body
   carries a task id that only exists after admission, so the phase cannot be
   pre-recorded by a separate request. That is true of pre-recording and not of the
   schedule that kills it: a first attempt that saves `work-input` and stops before
   the Work is admitted leaves exactly that phase, and the retry after the project's
   engine changed then exercises the pin. This is the one place where this record
   contradicts the previous one.

## What remains unproved

- **Crash recovery.** The guard is process-local ordering. It is not atomic
  multi-file crash recovery, and nothing here says otherwise. An abrupt multi-file
  crash mid-commit is not executed anywhere.
- **Authority generation schedules.** The handoff's full authority-generation cases
  are not executed. What is executed is Mode narrowing, lineage retirement, source
  settlement and target change.
- **Stop and reconciliation semantics.** Only the cancel and the failed model step
  are driven. `decide`, `complete`, `fail` and startup `recover` take the same queue
  by inspection, not by an executed schedule.
- **Native child Work beyond admission.** The native path's guarded commit is now
  driven and refused, and a control case admits a session through it. What happens to
  a native child after admission, including its own run's interleavings, is not.
- **A soft-deleted task between preparation and the commit.** Both revalidations use
  `tasks.find(id)`, which is exactly the predicate each path's own earlier check used.
  The `deletedAt` refinement exists only in `admitWork`'s pre-check
  (`server/app.ts:1889`) and is not re-read under the guard. A task soft-deleted by
  the team board (`server/team/service.ts:553`) in that window would pass. No
  executed schedule covers it, and it was not changed here: widening the guard's
  predicate past the check it re-runs is a separate decision.
- **The snapshot and baseline of a refused session.** `work.ts` takes its snapshot
  and change-review baseline before the guard, so a refusal inside the guard leaves a
  snapshot and a baseline for a session that never existed. The provider-failure case
  and the new M10 schedule both do this. It is a pre-existing class, any failure after
  those two awaits did the same, and boundary 5 explicitly requires them outside the
  guard. Not fixed, not in scope.
- **The three native schedules depend on a call order.** They place their change
  inside the native path's preparation by counting the folder check that follows
  `store.projects()` inside the child admission. That is a property of the current
  call order, not a contract. If `admissionContext` stops listing projects, those
  tests must be re-anchored.
- **Gates.** No full suite, no Playwright and no `vite build` were run for this
  record. The heavy-test slot was not held.

## The run behind this record

`node node_modules/typescript/bin/tsc --noEmit` exits 0. One `vitest run` over these
eleven files: 11 files passed, 233 tests passed, 0 failed.

| File | Tests |
| --- | --- |
| `tests/interaction-authority.matrix-20260921.test.ts` | 13 |
| `tests/interaction-seam.review-20260921.test.ts` | 13 |
| `tests/interaction-authority.repair-20260921.test.ts` | 2 |
| `tests/interaction-authority.schedules-20260921.test.ts` | 7 |
| `tests/interaction-seam.test.ts` | 19 |
| `tests/interaction-driver.test.ts` | 13 |
| `tests/interaction-turn.test.ts` | 21 |
| `tests/interaction-admission.test.ts` | 12 |
| `tests/home-conversation.test.ts` | 21 |
| `tests/native-work.test.ts` | 63 |
| `tests/work-admission.test.ts` | 49 |

No full suite, no Playwright and no `vite build`: this worker did not hold the
heavy-test slot.
