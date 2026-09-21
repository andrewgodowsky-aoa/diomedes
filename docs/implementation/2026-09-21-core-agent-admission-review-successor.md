# CD-01 admission repair: executing successor review

Date: 2026-09-21. Candidate: `7f1b9b3b6ff46536782ee763d6d4e27c86a21df7`.
Verdict: **accept the bounded admission repair**. This is an independent execution
and source review of the nine boundaries in
[`cd01-bounded-review-20260921/OWNER-HANDOFF.md`](cd01-bounded-review-20260921/OWNER-HANDOFF.md).
It is not a green full-suite verdict, acceptance of the later AWS composition,
CD-05, Home routing, a live provider, a package or a release.

The reviewer did not author the repair. The review checkout is
`F:/Diomedes/diomedes-wt/core-agent-admission-review`, branch
`feature/core-agent-admission-review`. HEAD was exactly the candidate above, with
a clean index and working tree, throughout execution. Coordination identity:
role `astra`, PID `43452`, process start `2026-09-21T04:32:24.4162630Z`.
The executing runner acquired `slot_mub61xbq_ca97f016` and released it in `finally`.

## Executed evidence

Logs, the runner and its result JSON are retained at
`F:/Diomedes/deliverables/cd01-bounded-repair-20260921/successor-7f1b9b3/`.
The prior rejection and original red evidence remain unchanged in the parent
folder and in the committed review directory.

| Check on the exact candidate | Result |
| --- | --- |
| Original matrix, `--maxWorkers=1` | 13 passed, 0 failed |
| Original unfiltered regression command from `run-review.ps1`, `--maxWorkers=2` | 6 collected files, 99 passed, 0 failed, including all 13 independent seam cases |
| Repair cases and seven added schedules, `--maxWorkers=1` | 2 files, 9 passed, 0 failed |
| Initial typecheck | Exit 2: absent control-plane dependency junction, six missing-module errors |
| Typecheck after linking the existing control-plane install | Exit 0, no source or dependency installation change |
| Unfiltered full Vitest, `--maxWorkers=2` | 222 files passed, 1 failed; 4,266 tests passed, 1 failed, 1 skipped; exit 1 |

The original regression command names `tests/run-service-claim-settled.test.ts`,
which does not exist at this commit. Vitest collected the six existing named
files. This is disclosed rather than reported as seven passing files. The full
unit run was unfiltered and included the native Work and Work-admission tests.

The sole full-suite failure is
`tests/capability-record.test.ts:266`, the packed-commit presence assertion.
The candidate predates the pack-index search repair `d3a5eb7`, which is already
merged into `origin/main` at `58bdc65` and into integration `2b3f933`.
Source comparison confirms that repair swaps the inverted binary-search
branches in `scripts/write-capability-record.ts`; no admission code is involved.
This review does not patch the frozen candidate or relabel its failed run green.
The composed candidate must independently pass this test and its pack-index
regression cases before merge.

The first typecheck ran without
`services/control-plane/node_modules`. That path is now a junction to the same
existing install used by the integration checkout. The second log is
`typecheck-with-control-plane-deps.log`; the original failed log is retained.
No browser or build ran concurrently with these checks.

## Frozen oracle identity

Both oracle files were copied byte-for-byte from the original corrected review
archive. Their SHA-256 values match `corrected-test-identities.json`:

| File | SHA-256 |
| --- | --- |
| `tests/interaction-authority.matrix-20260921.test.ts` | `7c82917641561760d02d5805ca9fe4153d415492c36123607022f338e37dd9d6` |
| `tests/interaction-seam.review-20260921.test.ts` | `9af1f563c3ba12c356cd7b997a29ca47f11a51dd5ceb13b642720e3473d7a8f3` |

The checkout initially materialized CRLF. The archived LF bytes equal the
candidate's Git blobs. Refreshing their index entries with per-command
`core.autocrlf=false` left no staged or working diff and preserved the exact
archived hashes. No assertion, helper or fixture was edited.

## Source review and ruling on soft deletion

The reported missing `!deletedAt` predicate in the two final Work checks is
real, but the proposed team-board interleaving is not reachable through the
shipped interaction path at this commit. It is **not a new blocking finding**.

1. `interactionHost.startWork` in `server/app.ts:2973` holds `Store.locked`
   across `admitChild`, the initial `admitWork` check, all awaited Work
   preparation and the final guarded commit. `Store.locked` in
   `server/store.ts:482` awaits the complete callback before releasing its queue.
2. `admitWork` checks `task.id === taskId && !task.deletedAt` at
   `server/app.ts:1889`, inside that Store critical section.
3. The normal team-board delete reaches `taskUpdateAsMember` only through
   `team_task_update`. Its callback in `server/team/mcp.ts:135` also acquires
   `Store.locked` before the service sets `deletedAt` at
   `server/team/service.ts:553`.
4. A delete which wins Store first is seen by the admission pre-check and
   prevents Work. A delete requested during preparation waits until admission
   releases Store. If admission wins first, a later deletion does not erase the
   identity of the already committed child. The source Runtime queue is an
   additional ordering boundary for Runtime terminal transitions, not the
   ordering boundary for this team-board write.

Calling the service method directly without its caller's Store lock, mutating
the task from a test hook, or editing a state file would not demonstrate the
reported shipped-path race. No new team-delete schedule was executed here;
this ruling rests on the complete caller and lock trace, not on an invented
passing test. If a future caller can delete without Store, or preparation is
moved outside Store, the final predicates must be revisited.

The source review also confirms the intended Store -> source RunService queue
-> child durable commit order. File, registry and snapshot preparation stays
outside the source queue. The callback does not re-enter that source queue.
The original matrix and new schedules exercise current Mode narrowing, source
settlement, lineage retirement, child identity, receipt replay, pinned Work
route and concurrent identical selection convergence. Runtime-only cancellation
in the queue-hold schedule waits behind the open child commit; this differs
from an HTTP cancellation that would first wait on Store.

## Compatibility and limits

The saved `work-input` phase now includes the resolved Work route. Reconstructing
a retry from changed project settings would change its command digest, so the
pin is necessary. A phase written by the earlier development shape conflicts
on retry with HTTP 409. The seam is unreleased; accepting that explicit conflict
does not authorize a legacy fallback, a new route or a replayed provider call.

The repair record's 17 mutation results remain **producer evidence**, not a
fresh independent mutation campaign. M8 and M17 are disclosed survivors because
either guard still refuses the narrowing; combined removal M16 is reported
killed. The reviewer executed the original matrix and all seven added schedules
unchanged, and inspected those guard relationships. No additional mutation
result is claimed here.

The fence orders one process; it does not make multiple files crash-atomic.
The restart case is graceful teardown after an injected missing parent phase,
not a process kill or torn write. Authority-generation schedules, every terminal
primitive, native child interleavings after admission and cleanup of pre-guard
snapshots are not newly proved. A child committed before source settlement can
remain readable even when its selection response is 409. These limits do not
become broader guarantees through this bounded acceptance.

PR #29 remains draft pending the client closure finding, composed acceptance,
and the separately authorized Home Luna default and Stop amendment and review.
