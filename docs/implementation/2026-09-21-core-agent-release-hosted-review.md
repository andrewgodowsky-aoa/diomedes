# Hosted Windows unit-gate diagnosis, release v0.1.7 round 3

Scope: hosted Windows `local-gates` job on exact commit `79d5b361259f8add1b8e4bb5ebe74afcc3662247`, GitHub run `35644771576`. Sources read: `tests/h01-event-recovery.test.ts`, `tests/step-origin.test.ts`, `server/harness/host.ts`, `server/harness/bridge.ts`, `server/harness/codex-engine.ts`, `server/store.ts`, `.github/workflows/build-test.yml`, and the preserved artifacts `release-v017-final-r3-hosted-failed.log`, `release-v017-final-r3-hosted-unit/unit.xml`, `release-v017-hosted-files-local-execution.json`, `release-v017-hosted-files-local-results.json`, `release-v017-final-r3-hosted-rerun-unit/unit.xml`, `release-v017-final-r3-hosted-rerun-checks.json`.

## Original failures

Windows attempt 1: 4680 passed, 3 failed, 3 skipped across 252 files. All three failures are the same `vi.waitFor` deadline of 5000 ms on an `open` Need becoming visible:

- `tests/h01-event-recovery.test.ts` "revoked subscription" and "slow-reader subscription", timing out at line 121 inside `codexRun()` on `store.state(projectId).needs.some(n => n.state === 'open')`.
- `tests/step-origin.test.ts` "Codex host origin keeps requested/reported/accountRoute", timing out at line 505 on `store.state(projectId).needs.find(n => n.state === 'open')`.

macOS and Workers checks passed on the same run. Product, tests and workflow were byte-identical to the prior all-green Windows gate `35639824674` on `cc04`.

## Confirmed wait and teardown chain

- An open Need is created by exactly one path: `HarnessBridge.mirror` (`server/harness/bridge.ts:252-289`) when the codex run parks at `waiting` on the approval-gated `codex:write` step, inside `store.locked`, followed by `persist`. `store.state()` returns the live cached object (`store.ts:529-533`), so the poll sees the Need the moment the mirror pushes it.
- Reaching that point runs a serialized chain: `startCodexReport` under `store.locked`, then `runs.start`, `runs.claim`, `drive`, `flush`, `codex.run` with its step saves, transcript save and authority calls (`codex-engine.ts:350-497`). Roughly 10-15 `durableWrite` operations (mkdir, temp write, fsync, rename; Windows EPERM/EACCES/EBUSY rename retry up to 5 attempts, `store.ts:274-294`, `304-325`), all funnelled through the single store lock. The 5000 ms budget covers the whole chain end to end.
- For h01 "revoked", stderr shows `The harness run stopped: HarnessError: This run was cancelled: The owned host is closing.` That line comes from `bridge.close()` (`bridge.ts:628-637`) cancelling a still in-flight run during `afterEach`. The run was alive and slow at the deadline, not failed.
- For step-origin, stderr shows `Could not mirror a harness run: ENOENT ... scandir '...\data\pending'` at 19:33:48.842, coincident with the file completion print. `data/pending` is created unconditionally in `Store.init()` (`store.ts:398`) and product code never removes the directory, only journal files inside it (`store.ts:1295`, `1503`). The only deleter of the test root is the spec's own `fs.rm(root)` in `afterEach` (`step-origin.test.ts:428` cleanup), which runs strictly after the waitFor threw. The rm deleted `pending` under the still-running drive job; a queued `store.locked` action then failed, `locked`'s catch ran `recoverAndReload` -> `recover()` -> `fs.readdir(pending)` (`store.ts:1354`), and the ENOENT surfaced via `bridge.ts:65` and `bridge.ts:330`. Teardown symptom, not cause.

## Same-commit observations

- Unchanged reproduction attempt, local Windows, exact `79d5b36`, the same two files with `--maxWorkers=2`: exit 0, 5 suites, 30 tests, 30 passed, 0 failed, about 19 s (`release-v017-hosted-files-local-execution.json`, `release-v017-hosted-files-local-results.json`).
- Full local suite on exact `79d5b36` with `--maxWorkers=1`: 4682 passed, 4 skipped.
- Same hosted job `35644771576` rerun once with no source, test, workflow, timeout or concurrency change: Windows attempt 2 passed. `release-v017-final-r3-hosted-rerun-unit/unit.xml` records `tests="4686" failures="0" errors="0"` with 3 skipped; `release-v017-final-r3-hosted-rerun-checks.json` records all three checks on head `79d5b36` green. The original failed log and JUnit are preserved at their separate paths; no failure was erased and no gate was weakened.

## Inference and residual uncertainty

- Inferred cause, not proven: intermittent hosted I/O latency inflating the serialized fsync-plus-lock pipeline past the fixed 5 s budget. Supporting observations: identical bytes green before and after on every lane; the failure signature is a pure deadline miss with no wrong state and no product error thrown to the test; both runs were still in flight at teardown; the h01 variant under test diverges only after `codexRun` returns (`h01-event-recovery.test.ts:366`), so `generation` passing while `revoked` and `slow-reader` timed out is consistent with scheduling luck; fs-heavy files were co-scheduled on the sibling worker during the failure window (fd01 packaging fixture, hostile-binding install probe of about 10 s).
- Not established: where exactly each run stood at the deadline. The durable run records (`state`, `failure`, `cancelReason` in `projects/<pid>/harness/runs/<id>.json`, `host.ts:76-105`) were deleted with the fixture roots, no per-operation timing exists, and no specific OS component can be named as the cause. A rare latent stall inside the chain that resolves late is not excluded by this evidence; intermittent timing is the supported reading, not immunity from latent bugs.

## Disposition

No product or test code change is justified by this evidence, and none is proposed. The 5000 ms budget is the fixture's asserted contract and nothing shows the product violated it. Do not silently reclassify this as flaky-and-forget: a serialized durable-write chain racing a fixed wall budget under hosted scheduling can recur. On concurrency, the workflow already documents worker starvation at 3 or more workers (`build-test.yml:36-40`); the vitest step already consumed about 9 minutes of a 15-minute job budget, so lowering the Windows unit step to `--maxWorkers=1` would risk the job-level timeout and is not recommended absent repeated recurrence. One latent observation for the record only: `recover()` assumes `data/pending` exists after init and throws ENOENT if it was removed, which is what the teardown race exposed. This review covers `79d5b36` only and does not certify candidate `6e2f033`, whose independent full gates are running separately after a runtime test-driver-only change.