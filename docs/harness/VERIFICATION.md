# Verification record, branch `fable/harness-boundary`, 2026-09-08

What was run, what passed, what an independent verifier found, and what remains. Windows 11, Node 22.23.2, worktree `F:\Achilles\diomedes-wt\fable-harness`.

## Commands and results

| Command | Result |
|---|---|
| `npx vitest run tests/harness.test.ts tests/harness-present.test.ts` (before implementation) | 2 files failed to load: module missing (the red baseline) |
| `npx vitest run tests/harness.test.ts tests/harness-present.test.ts` (after) | 47 passed, exit 0 |
| `npx vitest run` (whole suite, after commit `1490768`) | 12 files, 274 passed (227 existing + 47), exit 0 |
| `npx tsc --noEmit` | exit 0 at every commit |
| `node --import tsx test-results/harness-walkthrough.mts` | one run, four steps, an approval suspension answered through `decide`, a replay with no new provider call (3 provider calls across 3 passes), transcript kept apart, 16 events with a cursor, 10.6 KB run file |
| Muse packet (`ask-opencode.ps1 -Mode agent -Variant high`, OpenCode Go) | wrote `tests/harness-negative.test.ts` only; 39 passed, 1 skipped (its brief predated a deliberate semantics change); full suite 318 passed; Fable rewrote the skipped test, 40 passed |
| Opus hostile verifier (`claude -p ... --model claude-opus-5`, Read/Glob/Grep only, brief in the session scratchpad) | 52 items: 37 confirmed, 4 partial, 8 refuted (5 of them candidate defects it disproved), 0 fabricated, 3 unverifiable; all 16 step-level invariants confirmed; 5 confirmed defects, see below |
| `npx vitest run tests/harness*.test.ts` (after the verifier fixes) | 3 files, 99 passed, exit 0 |
| `npx vitest run` (whole suite, final) | see the closing line of this file |

## Verifier findings and what was done

| Finding | Severity | Action |
|---|---|---|
| D1 `fail()` overwrote a run parked at `reconcile_required`; `NativeAgent` calls `fail` on every error | medium | `fail` now leaves a parked run untouched; test "a tool with an effect that fails inside the loop parks the run, and the loop does not overwrite that" |
| D2 `cancel()` relabelled an in-flight non-idempotent step as `cancelled` | medium | `cancel` parks such a step as `reconcile_required` and the presentation says one action could not be confirmed; test "cancelling while a step with an effect is in flight parks it for reconciliation" |
| D3 `complete()` accepted a run with an unreconciled step | medium | refused with "needs reconciliation"; test "a run parked for reconciliation cannot be completed or overwritten by a failure" |
| D4 `start` did not validate the shape of `capability.tools` | low | validated; test "a capability whose tool list is not a list of names cannot start" |
| D5 `cancel` took no principal | low-medium | optional principal with the scope check; the packet's route passes the person's principal; `claim` stays host-only by design (the owner is the service) |
| A9n `decide` recorded the run's original identity generation, so no decision after a rotation could ever be consumed | low | records the deciding principal's generation; test "a fresh decision after an identity rotation is consumable under the new generation" |
| E11 error messages persisted and rendered unredacted | medium | `RunService` takes a `redact` scrubber applied before persistence; `presentRun` no longer renders a raw failure message; the run route must scrub; test "error messages pass through the host redaction before they are persisted" |
| B3a "fourteen team tools" | low | thirteen (`server/team/mcp.ts` has thirteen `registerTool` calls) |
| B2d, B2e, B8, B9, B10 citation and count drift | low | corrected in `CURRENT_STATE.md` and `HARNESS_INTEGRATION_MAP.md` |
| C1 `executionGeneration` recorded on an approval but not enforced | low-medium | left as designed and documented in the contract; a replacement owner may execute a step approved under a previous owner. H07 will decide whether ownership binds approvals. |
| D-R2 note: per-run queues are never pruned | low | controllers are pruned at terminal states; the queue map holds one settled promise per run and is left for the host's lifetime |

## Not verified

No test ran the packaged exe or the desktop; the harness is not mounted in `server/app.ts` on this branch. No real provider adapter exists; the model adapter in every test is scripted. Step outputs are persisted as observations without redaction (a tool that returns a secret is a tool-design error; the scrubber covers error text only). Cross-process atomicity relies on the data-folder lock; two services over one folder are a fencing test arrangement, not a supported deployment. Windows `rename` over a file another process is reading can fail with EPERM; the existing `Store` has the same property.

**Final full suite after the verifier fixes:** `npx vitest run` at 08:15 EDT: 13 files, 326 passed, exit 0. `npx tsc --noEmit`: exit 0.
