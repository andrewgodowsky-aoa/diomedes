# Test teardown: abandoned hooks, and native-work's accidental repository

Two runs of the same bytes on the Windows runner (35544501106 on PR 19's head,
35544545941 on main b4eb2c2) failed `tests/native-work.test.ts` the same way: the
afterEach at line 509 reported `Hook timed out in 30000ms`, and a later test in the
same block then failed with `fetch failed` and `Server is not running`. PR 19 fixed
that teardown shape in `tests/scoped-work.test.ts` only. This carries the fix to the
rest of the suite and removes the reason native-work's close overran on the runner.

## Why the next test fails

A Vitest hook that outlives `hookTimeout` is abandoned, not cancelled. It keeps
running, so anything it reads after an await belongs to whichever test is running by
then. Three shapes in this suite had that fault, in thirty-one files. Eleven hooks
awaited `app.locals.close()` and then read a module-level `server`, closing the next
test's listener. Eleven `close()`/`stop()` helpers called from a hook did the same, and
eight of those also cleared `server` afterwards, which makes the next test's own
teardown take its early return and leak the app it should have closed. Nine hooks
drained a shared cleanup array with `while (list.length) await list.pop()!()`,
re-reading the array after every await and so running cleanups the next test had
pushed.

Each now takes what it owns before its first await and closes it in a `finally`, the
way `scoped-work` does; the helpers clear the shared binding up front, as
`business-access-routes` already did; the loops take the array with `splice(0)` and run
it in reverse, which keeps the previous last-in-first-out order. No timeout was
raised. `tests/change-review.test.ts` is claimed by another worker and
`tests/independent-h01-20260917.test.ts` and
`tests/h01-event-recovery-independent.test.ts` are Astra's independent tests, so those
three are returned as a patch rather than edited here.

## Why close() overran thirty seconds

Not load, and not the change-review fan-out: these tests start one run each. The
fixture put the project folder under `test-results/` in this checkout, so when a test
turned on the Software Engineering pack, `prepareGit` resolved `--show-toplevel` to the
Diomedes repository itself and change review snapshotted the whole repository for a
two-file project: once for the baseline during the test, then twice more inside
`close()`, which drains the builds the session's own change events queued.

That snapshot is cheap only on a checkout whose index stat data Git can vouch for. On a
fresh checkout it cannot vouch for entries it has just written, and change review's
scrubbed environment sets `GIT_CONFIG_NOSYSTEM=1` and `core.autocrlf=false`, so the
CRLF working copies Git for Windows produced under the system default read as modified
against their LF blobs. `GIT_OPTIONAL_LOCKS=0` means the refresh is never written back,
so every snapshot pays again, one `git hash-object` process per row.

Measured on a freshly added worktree here: 246 rows, 8.5 s per snapshot, and
`app.locals.close()` at 8,619 ms of which `changeReview.close()` was 8,613 ms while
every other service closed in 6 ms or less. One ordinary `git status`, which does write
a refreshed index, took the same snapshot to 1 row and 200 ms. With every tracked
file's stat data stale the scrubbed read finds 1,036 of 1,278 files modified where
ordinary Git finds none. In that state the block reproduces the runner exactly: the
same test took 48,727 ms and timed its hook out at 30,000 ms (48,972 ms on CI), and the
same later test then failed with `fetch failed` and `Server is not running`.

The fixture now makes its folder under the OS temporary directory, outside any
repository, as `tests/capability-packs.test.ts` and 75 other files already do; it also
removes that folder, which the old fixture never did. native-work asserts nothing about
Git, baselines or manifests, so no intended coverage is lost. In the same stale state
the block went from 112,170 ms with three failures to 1,750 ms green, and the test that
fails on CI from 48,727 ms to 413 ms.

## Left open

The product behaviour behind the cost is not changed here. For a project that is a real
repository on Windows with Git for Windows' default `autocrlf=true`, change review still
reads every file whose stat data is stale as modified, and still spawns one Git process
per such file per snapshot, three snapshots per run, until something else refreshes the
index. Whether a baseline taken in that state and a build taken after an ordinary
`git status` can disagree about a file nobody edited is worth checking; it was not
established here.

One prediction for the first hosted run. On windows-latest the temporary directory is
`C:\Users\RUNNER~1\AppData\Local\Temp`, an 8.3 alias, which `server/paths.ts` treats
specially and which this machine cannot reproduce: 8.3 creation is disabled on the
volume these worktrees live on. native-work is the heaviest exerciser of that guard,
with junction rejection, a folder rename and an unselected-file refusal.
`tests/capability-packs.test.ts` builds junctions in the same temporary directory with
the same pack active and passes on the runner, as do the other fixtures that use it, so
this is expected to hold. If the first CI run fails in native-work's path-guard tests,
that alias is the reason and not the teardown, and the fixture root can move under
`runner.temp` the way `CODEX_HOME` already does in the workflow.

One contention flake was seen once and is not this bug: with backend's 3,000-file walk
running beside it, `does not recreate a project folder removed while its proposal was
waiting` failed, whose step is an `fs.rename` of a folder a reader can hold open on
Windows. It passes alone and CI has not hit it.

## Evidence

All four gates on this tree. TypeScript passes. Two consecutive full unit runs:
205 of 206 files, 4,000 tests passed, one failed, one skipped, both times; the failure
is `tests/hostile-truth-capability-record.test.ts`, an unrelated stale release pin that
fails the same way on main's own CI runs, and it is the only one. Vite builds. The
browser suite passes 126 of 126. The 28 touched test files also run 639 tests green on
their own. Hosted CI is required before merge and has not run yet.

Inserting comments moved lines that `docs/product/evaluation/ACCEPTANCE_COVERAGE.md`
cites, which `tests/evaluation-acceptance.test.ts` checks; eleven citations in that
ledger are re-pointed to the same test declarations. One citation in
`docs/product/personal-business/ACCEPTANCE_COVERAGE.md` moved too, and its old line
number named a blank line, so it now names the test its row describes. No verdict or
evidence text was changed in either ledger.
