# Change review: a later run of a task stops rebuilding the runs before it

Base `b4eb2c2f46bc43840de31622509a82addd4bc746`. Branch
`feature/change-review-ended-sessions`, worktree
`F:/Diomedes/diomedes-wt/change-review-ended-sessions`. Claims
`claim_muagiet4_3c0e6dff` (service and the two test files) and
`claim_muahenwu_5a295d31` (this note). Canon read: Core Pillars `2026-09-19.1`,
roadmap `2026-09-19.2`, project memory `2026-09-19.2`.

## What was wrong

`ChangeReviewService.noteChange` decided which reviews a persist could have
moved. Two of its conditions were scoped to the task rather than the session, so
every persist under a task reached every session that task had ever run —
including sessions that had already ended:

- `ownHistory` was true when `touchedTasks.has(session.taskId)`, so any History
  entry carrying the task id counted as the session's own evidence. A later
  run's admission, decision, write and task-move entries all carry it.
- the settle check compared `prior.changes.get(id) !== nowState` over a
  task-scoped map. A change record seen for the first time has no prior state,
  and `undefined !== 'waiting'`, so a later run's brand-new write registered as
  a review decision on every earlier run.

Each affected session got a full `build()`, and every build calls
`captureFolder()` — a walk of the whole project folder — and, where the Software
Engineering pack is active, a Git probe as well (`build()` :627-644). The cost is
quadratic in the number of runs a task has had, and it multiplies the walk cost
already diagnosed behind the app's lag.

It also moved evidence that the file says is frozen. `noteChange`'s own
docstring, `build()` ("A terminal session never rebuilds") and `serve()`
("rebuilding it later would mislabel post-run writes as having changed during
the run") all say an ended run's manifest is evidence of its own window; item 6
of `2026-09-15-automatic-change-review.md` records the same intent. Because a
rebuild re-reads History and the folder up to the present, an ended run absorbed
the later runs' writes: measured over twenty runs of one task, the first run's
record was re-persisted 25 times and its ledger read `1 change`, `2 changes` …
`20 changes`, each with a new digest, for a run that wrote one file.

The existing guard test only covered a **different** task
(`tests/change-review.test.ts`, "a history append rebuilds only sessions whose
evidence can move"), which is why this survived.

## What changed

`server/change-review/service.ts`, `noteChange` (:423-428): the task-scoped
History clause now applies only while the session is live, and a change record
without a prior state is a write rather than a settle. The docstring says what
the code now does.

Deliberately unchanged: the settle map stays task-scoped, so a keep or undo on
any change in a task still rebuilds that task's ended runs. That path is what
keeps the Console honest — a task's review is its newest run's frozen manifest
(`manifestForTask` → `serve`), and that manifest lists every write the task has
made, because `captureBaseline` starts a session's scope at the task's first
History entry. Without it, keeping an earlier run's change would leave the task
review showing `waiting` for good. `build()` and the event ladder are untouched.

Owner decision, 2026-09-20: freeze ended runs; keep the keep/undo path.

## Measured

Same scenario as `tests/scoped-work.test.ts`'s twenty-edit test — N sequential
runs under one task, each applying one file — with `enqueue` and `build` wrapped
at runtime. Machine was busy for both passes (50-66 `node` processes, 52-90%
CPU), so the counts are the signal and the times carry that load.

| runs | jobs enqueued | builds | in flight at close | close() |
|---|---|---|---|---|
| 5 | 80 → 30 | 70 → 20 | 18 → 3 | 0.2 s → 0.3 s |
| 10 | 285 → 60 | 265 → 40 | 117 → 3 | 1.7 s → 0.1 s |
| 20 | 1070 → 120 | 1030 → 80 | 637 → 6 | 13.1 s → 3.6 s |

Jobs grew at about 2.5·N²; they are now 6 per run, flat. Of the 1070 jobs at
N=20, 950 were ended sessions reached by a sibling run: 760 through the History
clause and 190 through the change-record clause, so fixing either alone would
have left the growth quadratic. The first run received 101 jobs and the last 6;
now every run receives 6, and the first run's ledger ends at its own single
change.

In the suite itself, the twenty-edit test's body is 3.4 s and its teardown drain
0.2 s, against 44 s and 49 s recorded on a busy machine before. Its 300 s budget
and the hook's are removed; both run at the suite's 30 s default again.

## Tests

`tests/change-review.test.ts`, three added, each red on the base commit except
where noted:

- a later run of the same task leaves an ended run's record byte-identical;
- keep and undo on the first run's changes, after all three runs ended, still
  reach the task review, and the ended runs' ledgers record `rebuilt-kept` and
  `rebuilt-undone` (this one passes on the base commit: it pins the path the fix
  preserves);
- five runs under one task never rebuild a run once it has ended, and a run
  costs no more builds than the first did. Before: the first run took 20 further
  builds, 5 for each later run.

Both use the recorded outcome, not a state poll, as the barrier: `advance()`
mutates the live state object and `/state` reads it without the lock, so a run
reads `done` before the persist that announces it — a poll-based barrier would
have raced the end build. Each was confirmed red with the service reverted and
this barrier in place.

## Not fixed here

**An ended run's rebuild still has no end boundary.** When a keep or undo
legitimately rebuilds an ended run, `build()` re-reads History and the folder as
they are now, so that run's review still takes in writes from after it ended:
the first run's review grows from its own file to the task's whole set at the
moment someone keeps its change. Bounding it needs an end point recorded when a
run finishes — a change to what the record stores and to what counts as
evidence. The owner's decision on 2026-09-20 was to hold it as its own design
pass, not to fold it into this patch.

Two smaller findings, recorded rather than changed:

- `captureBaseline` (:323-326) starts the scope at the first History entry
  matching the session **or the task**, so every later run of a task scopes back
  to the task's first entry; the H22 note describes it as "the session's first
  own History entry". That is the mechanism behind per-task accumulation, and
  the Console's task review depends on it today.
- `rebuilt-restored` is effectively unreachable: `Store.restore` writes its
  restore entry with no session or task id, so `ownHistory` cannot see it, and
  an undo is recorded through the change record's move to `undone`
  (`rebuilt-undone`).

## Gates

Run through `scripts/gates.ts` while holding the heavy slot. Typecheck and unit
ran last, on the final tree `0034f6e0264de4e2871b91045f7c816519b13359`; build
and browser ran on the same source before a later edit to
`tests/change-review.test.ts`, which neither gate reads.

- typecheck: pass.
- unit: 206 files, 4,003 passed, 1 failed, 1 skipped. The failure is
  `tests/hostile-truth-capability-record.test.ts`, "records that the published
  build is not this source version". It reproduces identically (1 failed, 13
  passed) on a pristine checkout of `b4eb2c2` with none of this work present, so
  it is pre-existing and unrelated: it compares the published release's version
  with this source version.
- build: pass, `vite build` in 1.75 s.
- browser: 126 passed, including `tests/change-review-ui.spec.ts`.

The browser gate rewrote 41 tracked evidence PNGs under `evidence/` and
`docs/verification/`; they were restored, and the patch is the three source
files plus this note.

## Status

Implemented and verified in the worktree. Not committed, not pushed, not
released; no capability changed and nothing new is claimed as shipped.
