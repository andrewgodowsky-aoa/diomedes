# H13 slice 2 and H14: delegate and worker sandboxes, and the change sets they return

Lane `delegate-sandboxes`, branch `feature/h13-delegate-sandboxes`, Linear DIO-18 (H13 next slice)
and DIO-19 (H14). Base `origin/integration/overnight-batch-6` (`836ba3a`), merged with
`origin/main` (`a37e2f6`, which carries batch 6 and the canonical sync) before the final gates.
Date 2026-09-24/25.

- **Decision implemented:** Andrew, 2026-09-24 (`docs/reference/DECISIONS_2026-09-24.md`,
  source-of-truth rank 1; QUESTIONS.md R11, R12 item 5, R13).
- **Canonical documents read:** Core Pillars 2026-09-22.1, Live Roadmap 2026-09-25.1, Project
  Memory 2026-09-25.1. None of them was edited; the patch is at the end.

**What this is.** Every delegate an H13 loop hands work to, and every H14 worker, now works in its
own sandbox and hands back a recorded change set. Sandboxing replaces "read-only" as the safety
mechanism, so a child can do the work rather than refuse it, and nothing it does reaches the
project directly.

**What this is not.** It is not a second writer, a second review model or a second permission
model. Changes reach the project only through `Store.writeRecorded`. A change that waits for a
person is an ordinary Need, and an applied change is an ordinary waiting Change. No child runs a
project command, and nothing here is proven against a live provider (see "Known gaps").

## 1. The sandbox (`server/sandbox/sandbox.ts`, `shared/sandbox.ts`)

- **Where.** `<data>/projects/<id>/harness/sandboxes/<child run id>/`, beside the parent's run
  records: the parent run's own area, never the project folder.
- **What.** `manifest.json` (child, parent, root, depth, role, scope, and the snapshot: every file
  copied, with its sha-256 and size), `work/` (the copy the child works in), `snapshot/` (the bytes
  the change set is read against) and `proposed.json` (paths the child asked a person to decide).
- **Copy.** From the project through the Files pane's guarded reads (`listDocuments`,
  `currentBytes`), so links, junctions, private names and 8.3 aliases are never copied. A depth-2
  child's copy is taken from its parent delegate's copy instead.
- **Bounded.** At most 200 files, 8 MB in all, and 1 MB per file. A scope over any limit is refused
  whole, with the numbers ("This scope holds 201 files … at most 200 files and 8 MB. Name fewer files
  for it."). Writes are held to the same limits.
- **Contained.** Every read, write and spawn is judged by H12's funnel rooted at `work/`:
  `containedPath` for reads, `containedWrite` for writes, with folders made one at a time and each
  judged first, and `containedSpawn` through `SandboxStore.spawn` as the only process path. No tool
  offers a command, so nothing calls it. A test holds that `server/sandbox/` never imports
  `child_process`.
- **Durable.** The manifest is written as `creating` before the copy and as `open` once it is whole.
  Creation is idempotent by child id: an open sandbox is never copied again, because its snapshot is
  what the change set is measured against, and a copy interrupted while `creating` is taken again
  from the start. After a restart, the child's replay finds its sandbox and its work where it left
  them. A sandbox write interrupted by an exit is handed to its reconciler at startup
  (`recoverChild`), which compares the copy's bytes with what was written. No test covers that
  reconciliation yet.
- **Removed.** A copy is removed as soon as its change set is recorded (the manifest stays, marked
  `collected`). Everything left of a loop's tree is removed when the loop that the person started
  ends (`settled`, and `sweep` at startup for anything a crash left behind).

## 2. Tools rooted at the copy

`SandboxStore.registry` gives each child `list_project_files` and `read_project_file` (its copy,
inside its scope; on a cloud route, a snapshot file must be shared with every route its answer
reaches, as before), plus, when its grant holds `write-project-file`:

| Tool | Effect class | Approval | What it does |
|---|---|---|---|
| `write_file` | idempotent-write | none: it touches only the copy | Writes the whole text of one file in the copy |
| `propose_file` | idempotent-write | none | The same, and marks the path so the change always waits for a person |

Their effect records name `sandbox:<child>/<path>`, so no record reads as a project write. A refusal
(a path outside the scope or the copy, a link, an alias, a full copy) comes back to the model as
data with its containment code. An H14 worker whose Agent's ceiling is `review` holds no write
permission, so it gets no writers. The advisor keeps reading the project and stays read-only by
construction (`assertReadOnly`).

## 3. The change set (`server/sandbox/change-sets.ts`)

- **Recorded once.** When a child completes, its copy is compared with its snapshot: created,
  modified and deleted text files, with links and anything outside its scope dropped and named. The
  result is one line in `<data>/projects/<id>/change-sets.jsonl`, with both sides kept by sha under
  `change-sets/objects/`. Every decision about an entry is a further line. Nothing is rewritten or
  removed (decision 10).
- **Attributed.** The change set's origin is the first model the runtime reported for the child,
  or an application action on the fixture route (decision 8).
- **Settled into the project** (a delegate of the loop, or a worker):
  - An entry is applied by the parent when it is not proposed, is not a deletion, lies inside the
    loop's `applyScope`, and the root's grant holds `write-project-file`. It goes through
    `Store.writeRecorded` with `expected` set to the snapshot's sha, `actor: 'diomedes'`,
    `kind: 'delegate-change'`, the loop's Session and the child's origin. It lands as an ordinary
    waiting Change of that Session, so P06's readable diff, per-hunk keep and Undo apply to it.
  - An entry whose file changed in the project after the snapshot is a **conflict**. The recorded
    writer refuses it, nothing is written over it, and the record says who moved the file on.
  - Every other entry waits under **one ordinary Need** (`Need.changeSet`), which says why each one
    was not applied. The bridge no longer expires such a Need when its run ends, because it waits
    for its person, not for the run.
- **Decided by a person.** `POST /api/projects/:id/change-sets/:id/decide`
  (`{ protocolVersion, commandId, decisions: [{ index, decision: 'keep' | 'discard', hunks? }] }`)
  keeps or discards each waiting entry, or keeps chosen hunks through P06's `applyHunkSelection`.
  A kept entry is one `writeRecorded` call as the person's (`actor: 'you'`,
  `kind: 'delegate-change-kept'`, the child's origin kept), checked against the snapshot's sha. A
  replayed command id changes nothing. The generic Need answer (`/needs/:id/resolve`) keeps every
  waiting entry whole on go-ahead and discards them all on decline. The Need is answered once
  nothing under it waits. `GET …/change-sets/:id/entries/:index/diff` returns both sides and P06's
  `buildDiff`.
- **Settled into a parent's copy** (depth 2). A depth-2 child's entries are written into its
  parent delegate's copy through the funnel rooted there, a conflict with that copy is detected,
  and a proposal stays a proposal. The parent's own change set then carries them on.
- **What the parent's model is told.** Its observation lists what was applied, what waits for a
  person and what conflicted (`changes.applied`, `waitingForAPerson`, `conflicts`).

## 4. Limits

| Rule | H13 delegate | H14 worker | Where |
|---|---|---|---|
| Depth | 2: a delegate may hand one part on (`delegate` in its registry); a depth-2 delegate is offered none | 1: a worker is never offered delegation | `LOOP_LIMITS.delegationDepth`, `TEAM_LIMITS.depth` |
| Per run | 4 in all | 4 per lead (**was 6**) | `LOOP_LIMITS.delegationsPerRun`, `TEAM_LIMITS.workersPerRun` |
| Parallel | several in one `delegate` call (`tasks`), run together in one step | at most 3 at once, unchanged | `native-loop.ts` |
| Budget | carved from the parent's remaining units: an equal share, at most 8, the parent keeps 2; a depth-2 delegate costs its parent 4 | the person's admitted worker budget, refused unless the lead has it to spare; the advisor costs 6 | `carveBudget`, `assign`, `advise` |
| Stop | cancels the whole tree, at every depth, from the durable record | the same | `stopChildren` |

- **Carving.** The step that starts children spends their units (`delegate:<n>` costs the sum of
  its children's carves, `workers:<n>` its workers' units, `advise:<n>` the advisor's), so a tree
  never spends more units than its root was admitted with. A carve the parent cannot afford is
  refused as an observation, and nothing starts.
- **Admission budget.** A loop admitted with a delegate route also holds four delegate carves.
  A loop admitted with a team holds its workers' and advisor's admitted budgets. That is the whole
  tree's budget, fixed at admission, and every child is carved from what is left of it
  (`loopBudget`).
- **Recorded differences.** Model and tool call ceilings are carved per child as one call per two
  units. The parent's own call counters are not charged by a child's calls: units bound the tree,
  and each call costs at least one. Review D's patch B, charging a child's spend to its parent's
  *job cap*, is not done here (see "Known gaps"). H14 keeps depth 1 and 3 at once, both inside
  Andrew's limits.
- **Routes.** A delegate's route is the one the person named at start or, new here, the one an H09
  profile named (`delegate: { profileId }`), resolved by H09's own rules and pinned by revision in
  the run's admission. The model decides what each sub-task says and which files it needs, never
  the route or who pays.

## 5. Scope and authority

- A delegate's scope is the `files` its handoff declares (optional; absent means the parent's whole
  scope), held inside the parent's: the loop's team scope, or the whole project. For a depth-2
  child, the parent delegate's own scope applies (`intersectScope`). A declared entry the parent
  does not cover refuses the handoff, and nothing is widened (decision 7).
- A child's principal is its parent's, narrowed by its Agent's ceiling for a worker. Being handed
  work is still checked against its own authority (`acceptHandoff`).
- **What the parent may apply** is `LoopRunInput.applyScope`: the files and folders (`.` for the
  whole project) the person lets the loop apply its children's changes in, given at start
  (`POST /loop/start`, `applyScope`). Absent means every change waits for a person. That is the
  proposed default below.

## 6. H15 decision 5: a queued correction may start the next run without a person

Audited against `server/supervision/service.ts`, `server/work-control.ts` and `server/app.ts`.

| Property | Before | Now |
|---|---|---|
| Starts the next run on a route that cannot steer, without a person | yes (`deliverDue` on the turn's end, through `admitWork`) | unchanged |
| Shares the origin run's correction bound | yes (`lineage`, `tests/h15-ladder.test.ts`) | unchanged |
| Ordinary admission | yes | unchanged |
| **Permission never wider than the origin run's** | **no**: delivery used the thread's current permission, which the person may have widened to `task` since | the origin session's permission is a ceiling on the correction's admission (`admitWork(…, ceiling)`) |
| Labelled in the thread and History | yes: the instruction starts `[Diomedes supervision]`; History "Diomedes supervision queued a correction…", "Diomedes sent its supervision correction…" | unchanged |
| **Cancelled by a pause or a Stop** | a pause (task-scope Stop) did; **a Stop of the generation left it queued**, to start straight after the Stop | every Stop scope cancels a queued supervision correction; a person's own follow-ups keep their existing behaviour |

The two gaps were shown red first (`tests/h15-decision5.test.ts`) and are fixed.

## 7. Console

`client/console/ChangeSetReview.tsx` (+ `change-set.css`), inside each delegate row of the loop
inspector (`LoopInspector.tsx`) and each worker row of the Team view (`LeadWorkers.tsx`). It says
once what became of each entry ("applied, in Review", "waits for you", "kept by you", "discarded",
"not applied: changed since"), with the reason when there is one. A waiting entry opens P06's
`DiffView` in place and offers Keep, Discard, and Keep selected when some of its parts are ticked.
Machine strings wrap where they are written (decision 5), no `.col` rule is touched (decision 6),
and no new surface exists (decision 1).

## 8. Hot-file edits (appends or small branches)

- `shared/types.ts`: `Need.changeSet`.
- `shared/native-loop.ts`: limits, `LoopRunInput.applyScope`, `delegate.profile`, child
  `rootRunId`/`depth`/`scope`, handoff `scope`/`parallel`, result `changeSet`/`parallel`, and
  `loopView` rows for parallel handoffs.
- `shared/team-delegation.ts`: `workersPerRun` 4, `WorkerResult.changeSet`.
- `server/harness/native-loop.ts`: the delegate action (tasks, files, carve, parallel), H14
  carves.
- `server/harness/capabilities/native-loop.ts`, `team-loop.ts`: sandboxed children, depth 2,
  recursive Stop, sweep.
- `server/harness/bridge.ts`: a change-set Need does not expire with its run.
- `server/harness/host.ts`: startup sweep.
- `server/native-loop-routes.ts`: `applyScope`, delegate profile, change-set routes.
- `server/app.ts`: the Need answer branch and the `admitWork` permission ceiling.
- `server/work-control.ts`: decision 5.
- `client/console/LoopInspector.tsx`, `LeadWorkers.tsx`: render the change set.
- `playwright.config.ts`: the new spec.

## 9. Tests

| File | Proves |
|---|---|
| `tests/delegate-sandbox.test.ts` (new) | Scope, intersection and carve rules. A child writes only its copy and the project is untouched; the effect record names the sandbox. Escapes are refused with their codes: `..`, absolute, drive, UNC, private name, 8.3 file and folder aliases, an alternate data stream, a reserved name, a link planted in the copy, a Windows junction to the project (Windows CI), a link in the project never copied, and a spawn outside the copy. Size limits are refused with numbers. A restart finds the snapshot and the work, and a half-made copy is taken again. A depth-2 copy is taken from its parent's copy. Removal and sweep. No `child_process` in `server/sandbox/`. |
| `tests/delegate-change-sets.test.ts` (new) | An in-scope change applies with `actor: 'diomedes'` and the model's origin, as a waiting Change, and applies once. An out-of-scope change becomes a Need and is kept as the person's. No scope, a proposal or a deletion waits; decline discards. A conflict after the snapshot is never written over, now or when kept late. Per-hunk keep with P06's diff. Depth-2 settle into the parent's copy. |
| `tests/delegate-sandbox-host.test.ts` (new) | Through `createApp`: in-scope applied and out-of-scope waiting under a Need that outlives the run, kept through its route with the readable diff. No scope given: everything waits, and the generic Need answer declines it. A profile-named delegate route. Stop cancels a depth-2 tree and removes its sandboxes. An abrupt process exit mid-delegate: the sandbox and the child's work survive, the child resumes in the same copy, its write ran once, and the sandbox is removed at the end. A worker's change set. |
| `tests/h15-decision5.test.ts` (new) | Delivery without a person, labelled. Permission held to the origin run's (red before the fix). A generation Stop cancels the correction (red before the fix). A supervision pause cancels it. |
| `tests/native-loop.test.ts` (changed to the new rules) | Four delegates carved from the parent, a fifth refused; three at once in one step, a fourth and fifth over the limit refused; an unaffordable carve refused. |
| `tests/h14-team-host.test.ts`, `tests/h14-team-delegation.test.ts`, `tests/h14-team-ui.spec.ts` (changed) | `workersPerRun` 4; a worker holds its sandbox's tools. |
| `tests/delegate-sandbox-ui.spec.ts` (new) | Review and keep of a delegate's proposed change with its diff, the file written only then; discard leaves the project as it was; no horizontal overflow at 900 px. |

The sandbox and change-set tests were written alongside the code. The decision-5 tests were red
before the fix.

## Gate counts

In the lane's final report and the PR body, from the run on the merged head.

## Known gaps (stated plainly)

- **No live provider.** Every model-API child ran on a stub route. Nothing was sent anywhere.
- **Job cap.** A child's spend is still held to its own job's cap, not its parent's (review D
  patch B). Units are carved, spend caps are not.
- **Call counters.** A child's model and tool calls are not charged to the parent's own call
  counters. Units bound the tree.
- **A stopped or failed child returns nothing.** Only a completed child's copy becomes a change
  set, and a stopped tree's work is discarded with its sandboxes.
- **A mid-flight external call at a crash** still parks the child `reconcile_required`, as before,
  so it does not resume. A local-destination call is repeated safely, as the crash test shows.
- **An in-flight loop across this upgrade.** A loop that was mid-delegation when this build replaced
  the previous one meets a changed handoff step (`v2`) on replay, and fails with an intent mismatch
  rather than running on a guess.
- **No command tool.** `containedSpawn` rooted at the copy exists, but no child is offered a command.
- **Binary files** in a copy are copied and kept, but a changed binary file is dropped from the
  change set, because the recorded writer only takes text from anything but a person's import.
- **Console.** A change set is reviewed inside the loop inspector and the Team view only. There is
  no Needs-list shortcut into it beyond the ordinary Need, and a depth-2 change set is shown only
  through its parent's.

## Proposed defaults (Andrew's to confirm)

1. **No apply scope unless the person gives one at start.** Every change a sandbox returns waits
   for a person unless the loop was started with an `applyScope`. There is no Console control that
   sets one yet (it arrives with the loop's start control, O23).
2. **Deletions and proposals always wait for a person**, even inside the apply scope.
3. **A conflicted entry is settled as not applied.** It is shown with who changed the file, and it
   can be neither kept nor discarded afterwards. To use it, the sub-task is run again on the new
   file.
4. **H14 at most 4 workers per lead** (from 6), counting retries, to match "at most 4 delegates per
   run". Depth 1 and 3 at once are kept.
5. **The whole tree's budget is fixed at admission** (`loopBudget` adds four delegate carves, or the
   team's admitted budgets), and every child is carved from what is left.
6. **A depth-2 delegate costs its parent a fixed 4 units.**

## PILLAR IMPACT

- Advances the agent and Trust pillars together, as Andrew's decision asks: helpers do real work
  somewhere safe instead of being refused, and delegation never widens authority (decision 7). The
  proof is in the tests above.
- Attribution (decision 8): an applied change names the model that wrote it and the Diomedes action
  that applied it, and a kept one names the person.
- Evidence (decision 10): change sets and every decision on them are append-only, and applied
  changes are ordinary History entries and Changes.
- No new surface (decision 1), no second writer, and no second permission model.

## ROADMAP IMPACT

- H13 (DIO-18): **slice 2 implemented in source.** Sandboxed delegates return change sets; limits
  are depth 2 and 4 per run, run in parallel with carved budgets; Stop cancels the tree; delegate
  routes can come from H09 profiles. Not live-proven, and not independently reviewed.
- H14 (DIO-19): workers work in sandboxes and return change sets; 4 per lead. QUESTIONS.md O36
  items 1 and 2 are answered by the decision as implemented here (proposed defaults 4 and 5).
- H15: decision 5 (R12 item 5) now holds in source: the permission ceiling and cancellation by any
  Stop.

## BUILD STATUS

Branch `feature/h13-delegate-sandboxes`, pushed; draft PR against main. Not merged, not released,
not packaged, not deployed. No version or native-runtime hash changed.

## Proposed canonical-doc patch

Not applied: the integrator reconciles the canonical documents.

**`docs/DIOMEDES_LIVE_ROADMAP.md`**

- In the 2026-09-25 checkpoint paragraph, replace "The sandbox is H13's next slice, in progress on
  feature/h13-delegate-sandboxes and not landed; until it lands, delegates stay read-only as built."
  with:

  > The sandbox is implemented in source as H13 slice 2
  > (`docs/implementation/2026-09-24-delegate-sandboxes.md`, feature/h13-delegate-sandboxes): every
  > delegate and H14 worker works in a bounded copy of its scope in the parent run's area, under
  > H12 containment rooted at that copy, and returns a recorded change set. Changes inside the
  > scope the person gave the loop at start are applied through the recorded writer as the model's
  > and remain reviewable Changes. Everything else waits for a person under an ordinary Need, and a
  > conflict with a newer project file is never written over. Depth 2, 4 per run, parallel, carved
  > budgets and Stop over the whole tree are in source, and delegate routes may come from H09
  > profiles. It is not live-proven or independently reviewed yet.

- In the H14 paragraph, replace "Workers run one level deep, at most 3 at once and 6 per lead run."
  with "Workers run one level deep, at most 3 at once and 4 per lead run.", and replace "Workers
  only read, so every effect stays the lead's, through H12 and a Need." with "Workers work in
  sandboxes and return change sets (H13 slice 2); the advisor only reads." Also replace "workers
  will work in sandboxes once H13's sandbox lands. How H14's limits and budgets meet the H13 limits
  is QUESTIONS.md O36." with "workers work in sandboxes, and their budgets are carved from the
  lead's (QUESTIONS.md O36 items 1–2)."

- In the harness status paragraph, replace "that sandbox is the next slice, in progress and not
  landed." with "that sandbox is implemented in source as slice 2 and not live-proven."

- In the review D line, replace "charging a delegate's spend to its parent's job cap (which R11's
  carved budgets require)" with "charging a delegate's spend to its parent's job cap (units are
  carved in H13 slice 2; job caps are not yet)".

- In the H15 sentence, after "is cancelled by a pause or a Stop.", add "Verified in source
  2026-09-25: the correction's permission is held to the origin run's, and a Stop of any scope
  cancels it (`tests/h15-decision5.test.ts`)."

**`docs/DIOMEDES_PROJECT_MEMORY.md`**

- In "Delegate sandbox; change set", replace "Not built yet. Delegates and H14 workers are
  read-only in source today, and the sandbox is H13's next slice." with:

  > Implemented in source (H13 slice 2). A sandbox holds at most 200 files and 8 MB, and is removed
  > when its change set is recorded or its loop ends. *Apply scope* is what the person, at start,
  > lets the loop apply without asking again; absent, every change waits for them. Deletions and a
  > child's *proposed* files always wait. A *conflict* is an entry whose file changed after the
  > snapshot, and it is never written over.

- In "Lead, worker, advisor (H14)", replace "it is read-only in this build, until the sandbox
  lands." with "it works in its own sandbox and returns a change set."

- In the closing paragraph, replace "The delegate sandbox and change set are decided but not
  built." with "The delegate sandbox and change set are implemented in source, not live-proven."

**`QUESTIONS.md` O36:** items 1 and 2 are answered by R11/R13 as implemented. Workers run at most 4
per lead run (from 6), at depth 1 and 3 at once. Their admitted budgets are carved from the lead's,
and the lead's admission budget holds its team's. Items 3 to 5 stay open. Add, as new open
questions, proposed defaults 1, 3 and 6 above (the apply scope's Console control, keeping a
conflicted entry, and the fixed depth-2 carve).

**`docs/harness/RUNTIME_VERIFICATION.md`:** add "H13 slice 2 sandboxes: fixture and stub-route
evidence only; containment escapes, restart and Stop proven locally (Windows junction cases on
Windows CI)."
