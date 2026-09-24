# CI timing-flake hardening on main (2026-09-24)

Status: **implemented on `bugfix/ci-timing-flakes`; not merged.** One product fix (change-review
ledger labelling, item I); every other fix is test-only. Every failure below was root-caused and reproduced on Linux by injecting a delay at the
point a slow runner is slow. Each failed on the original test and passed after the fix.

## What was red

GitHub Actions `Build and test` on `main`, the last ~20 runs (35931806530 … 35963550264), plus the
PR run named in the work order. Every failing job and test:

| # | Run / job (commit) | Test | Kind |
|---|---|---|---|
| A | 35963550264 / macos-arm64 107517063931 (559a1ab) | `aws-conversation-seam` › stop AWS Work with the Console's Stop; after a restart nothing was written and the call stays uncertain | test race |
| B | 35962328566 (430d567), 35941675487 (e95e8d8), 35938494042 attempt 1 (c6856cb), all Windows `local-gates` | `hostile-adapters-defects` › reports a caller-imposed timeout after dispatch as a timeout, not a cancellation | test race (fake fetch) |
| C | 35967266971 / Windows 107528577747 (PR on 559a1ab) | `hostile-adapters-defects` › still reports a person pressing stop as the request being stopped | test race (fake fetch), same as B |
| D | 35941675487 / Windows (e95e8d8) | `ai-setup-api` › keeps cursor Plan read-only and Work proposals behind exact approval and History | wall-clock poll |
| E | 35941675487 / Windows (e95e8d8) | `conversation-interrupt` › a connection dropped while preparation is held aborts the admitted input and dispatches nothing (plus its `afterEach` hook timeout) | wall-clock poll + stranded hold |
| F | 35937650723 / Windows (6f3759a) | `connection-test-wiring` › parks a host run interrupted after dispatch instead of sending it again (plus its `afterEach` hook timeout) | wall-clock poll + stranded hold |
| G | 35935928956 / Windows (cc91455) | none: all 5988 tests passed; Vitest reported `[vitest-worker]: Timeout calling "onTaskUpdate"` | runner starvation, not a test |
| H | 35939869804 attempt 1 / Windows (3fe0f40) | `harness-host` › abrupt exit at after-write recovers the Store first and commits the harness observation once | wall-clock poll in the child fixture |

| I | 35970393023 / Windows (this branch at 7a92d6d, dispatched to check the fixes) | `change-review` › keep and undo on an earlier run still reach the task review after every run ended | **product race (fixed)** |

A through H exposed no product bug. In each, the test waited on the wrong event or on a fixed
polling budget that a loaded Windows or macOS runner outlasts. I is a real, if small, product race
in evidence labelling.

## Root causes and fixes

**A — AWS Work Stop, hold read as `pending`.** `NativeWork.stop()` (`server/native-work.ts`) aborts
the run's controller and marks the session `stopped` right away, in the same locked write. The
aborted model call then unwinds on its own. `callModelApi`'s `fail()`
(`server/engines/model-api-core.ts`) marks the spend hold `uncertain` a moment later. The test
waited for the session to leave `working`, which Stop wrote itself, and treated that as the call
having ended. It then read the hold. On a slow runner the hold was still `pending`.
*This is not a durability race.* `SpendExposureLedger.init()` (`server/spend-exposure.ts`) sweeps
every `pending` hold to `uncertain` before anything else runs at start. A graceful `close()` also
awaits in-flight Work jobs. So neither a restart nor a crash can observe `pending`, and the test's
after-restart assertions still prove it. **Fix (test):** wait until the newest hold leaves
`pending`, then assert it is `uncertain`, which is the unchanged assertion. A hold left pending
forever still fails the test (the `until` deadline), and a released or settled hold still fails.
Repro: delaying the fake transport's abort rejection by 300 ms makes the original fail with
exactly the CI diff (`"pending"` for `"uncertain"`). The fixed test passes at 0, 300 and 1500 ms.

**B, C — OpenCode abort tests timing out at 30 s.** These tests aborted on a 120 ms timer and
assumed the prompt had been dispatched by then. When adapter startup outlasts 120 ms, the abort
lands before `/event` is requested. The test's fake fetch ignored an already-aborted signal and
attached an `abort` listener that never fires, so the read hung. The product is correct here: a
real `fetch` rejects an aborted signal, and every `request()` in `server/engines/opencode.ts`
passes the merged signal. **Fix (test):** PR #74, merged into this branch, now makes the fake call
`signal?.throwIfAborted()`. This branch's own equivalent line was dropped in favour of #74's. That
alone ends the hang, but on a slow runner these tests would then check a launch-stage abort, not
the after-dispatch abort their titles name. This branch therefore also anchors each abort to the
dispatch: the fake's `prompt_async` handler calls a per-test `onDispatch`. The timeout test aborts
with the genuine reason of an expired `AbortSignal.timeout()`. Each test now also asserts
`stage: 'stream'`, which only adds a check. Repro: delaying `reservePort` by 300 ms or 1.5 s made
all three original tests hang to the test timeout. All four fixed tests pass at 0, 300 and 1500 ms.

**D — Work proposal read before its Need opened.** The test polled 100 × 10 ms (~1 s) for an open
Need. **Fix:** poll until the Work leaves `queued`/`working`, meaning it opened its Need or ended.
A 20 s hang guard sits inside the 30 s test budget. Repro: a 2.5 s provider delay failed all three
engines on the original (`expected undefined to be 'Reviewed text'`), and all three pass fixed.

**E — dropped connection while preparation is held.** The test polled for the fake session open
with a 4 s budget and never released the held open on failure, so `afterEach`'s `close()` hung for
30 s. **Fix:** the fake open signals when it is entered, and the test awaits that signal, racing it
against the request settling so an early answer fails clearly. `afterEach` always releases the
hold. Repro: a 5 s delay before the open failed the original with exactly CI's two errors, and
the fixed test passes.

**F — parked host run.** `vi.waitFor`'s default 1 s budget covered the whole route from
`POST /ai/test` to the provider call, and a failure stranded the held provider under `shutdown`.
**Fix:** the fake provider signals at dispatch, and the test awaits that signal, raced against the
response. Teardown releases a held provider before shutdown. Repro: a 2.5 s version-probe delay
failed the original (`expected "generate" to be called 1 times, but got 0 times`), and the fixed
test passes.

**H — crash fixture found no Need.** `tests/harness-host-child.ts` runs in a freshly spawned tsx
process. It gave its run 200 × 10 ms to open a Need, then 2 s more to reach the crash phase.
**Fix:** wait until the run's session leaves `queued`/`working`, then wait for the run to end
before saying the phase was not reached. A 20 s hang guard applies to each wait. Repro: a 700 ms
delay on the child's `store.persist` produced CI's exact `The fixture produced no Need.` / exit 1
instead of 17, and the fixed child passes.

**I — change-review ledger records a keep as a state rebuild (product).**
`ChangeReviewService.observe()` (`server/change-review/service.ts`) labels a rebuild when it
enqueues it, but `build()` reads the state current when it runs, and a ledger row is pushed only
when the digest moves. When a person keeps a change as a run is ending, that run's end build is
queued as `rebuilt-state`, and it may run after the keep, so it already includes the keep. The
keep's own `rebuilt-kept` build then finds the digest unchanged and records nothing. The ledger
names the keep a state rebuild and never records the keep, which weakens History as evidence
(decision 10). The test pressed Keep as soon as `/state` showed the run `done`, and the state is
visible before the persist that triggers the end build. **Fix (product, ~25 lines):** a
`rebuilt-state` build records `rebuilt-undone` or `rebuilt-kept` when a change id already present
in the manifest it replaces moved to that settle state (`decisionShown`). Explicit
`rebuilt-kept`, `rebuilt-undone` and `rebuilt-restored` labels are unchanged. A change id seen for
the first time is still a new write, not a decision. **Regression test:** "a state rebuild that
lands after a keep records the keep, not a state rebuild" holds the run's state rebuilds behind a
gate until the keep has landed. It fails without the fix (`expected 'rebuilt-state' to be
'rebuilt-kept'`) and passed 10 of 10 times with it. The original test, unchanged, also failed on a
400 ms delay of state builds before the fix and passes after it. *Known limit:* a session whose
every rebuild lags behind a keep, so that the manifest it replaces predates the change's own
write, still records `rebuilt-state`. Reading a first-seen id as a decision would mislabel task
changes kept before a later run began. This needed a 1.5 s delay on every state build to produce
and was not seen in CI.

**G — not fixed here.** `Timeout calling "onTaskUpdate"` is Vitest's worker-to-main RPC timing
out. All tests passed in that run, and the log does not name a test, so there is nothing to fix at
a test's own level. It is consistent with a starved Windows runner (`--maxWorkers=2`, ~9 minute
suite). Follow-up if it recurs: capture which file was running, or raise Vitest's
`teardownTimeout`/RPC budget in CI only, with evidence.

## Stress counts (this container, 4 shared CPUs, load average 9–13)

- Natural stress, 30 runs each, 3 in parallel: `hostile-adapters-defects` (abort block) original
  30/30 pass, fixed 30/30 pass. `aws-conversation-seam` (Work Stop) original 30/30 pass, fixed
  30/30 pass. This machine is not slow enough to hit the races naturally, which is why the
  delay injections above are the reproduction.
- Delay-injected, original → fixed: A fail → pass (3 delays). B/C 3 of 3 fail → 4 of 4 pass
  (3 delays). D 3 fail → 3 pass. E fail → pass. F fail → pass. H fail → pass.

The delay-injected copies were scratch files and are not committed.

## Pattern left in place (follow-up, not done)

Other tests still use short fixed polling budgets (the local `until()` helpers of 400 × 10 ms in
`aws-conversation-seam` and `conversation-interrupt`, and `vi.waitFor` defaults elsewhere). They
have not failed on main in the runs examined. Converting them wholesale would widen this patch
past the failures in evidence.

## Scope and coordination

- Test files: `tests/hostile-adapters-defects.test.ts`, `tests/aws-conversation-seam.test.ts`,
  `tests/conversation-interrupt.test.ts`, `tests/connection-test-wiring.test.ts`,
  `tests/ai-setup-api.test.ts`, `tests/harness-host-child.ts`, and this record.
- Also `server/change-review/service.ts` (product fix I) and `tests/change-review.test.ts`
  (one new regression test; existing tests unchanged).
- `server/native-work.ts` and the Codex warm-process code were not touched.
- No assertion was loosened, removed or skipped. No timeout was raised. No retry was added.

## Proposed canonical-doc patch

None needed. No product definition, status or decision changed (item I makes the existing ledger
labels truthful rather than defining new ones). If the roadmap tracks CI health,
add one line: "2026-09-24: main's recurring Windows/macOS unit failures (OpenCode abort tests,
AWS Work Stop hold, interrupt/wiring/ai-setup/harness-host polls) were timing-dependent tests,
made deterministic on `bugfix/ci-timing-flakes`. No product race was found."

## PILLAR IMPACT

History is evidence (decision 10): item I stops the change-review ledger from dropping a person's
keep or undo and naming it a state rebuild. Otherwise none. The fixes keep every truth the tests check: Stop is not a timeout, a withdrawn run
is not a person's stop, an uncertain hold is never released, and nothing is written after Stop.

## ROADMAP IMPACT

No status change. This only makes CI able to judge tonight's merges.

## BUILD STATUS

Gates run on this branch at the product fix (item I), with `origin/main` at `de86916` (which
includes PR #74) merged in, in this Linux container:

- `npx tsc --noEmit`: clean.
- `node node_modules/vitest/vitest.mjs run --maxWorkers=2`: 347 files passed, 1 skipped; 6125 tests
  passed, 16 skipped, 0 failed.
- `npx vite build`: built.
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts`: 36 passed.

Not merged, not released. CI on Windows and macOS: a `workflow_dispatch` run of this branch before
item I (35970393023, at 7a92d6d) passed macOS and failed Windows only on item I. That run is how I
was found. A second dispatch after the fix is named in the final report.
