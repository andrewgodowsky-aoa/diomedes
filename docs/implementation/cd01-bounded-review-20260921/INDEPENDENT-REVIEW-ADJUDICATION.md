# Independent SWE Max review: parent reconciliation

Both delegated sessions exported `agent.model_name = SWE-2 Max`, with zero
tool calls. The first proposed a patch; the second independently reviewed the
frozen candidate and proposal. Neither edited the repository or ran tests.
Their raw outputs remain unchanged. The parent owns the findings below.

- Accept the Runtime check/use window as P1, not the reviewer's P0. Its reachability
  follows from a real concurrent model-step failure entering reconciliation in
  `RunService.step` independently of Store.locked. Actual regression results,
  rather than the worker's prediction, determine reproduction status.
- Reject the speculative Store accessor deadlock. Live source inspection shows
  `Store.homeBinding` is synchronous and `Store.projects` does not acquire
  Store.locked. `projects` does await folder checks and refresh in-memory counts;
  it is not a pure immutable accessor. No self-locking accessor defect was found.
- Accept the proposal's misleading Mode-refusal wording as P2. Throw the existing
  `blockedMessage(verdict.reason)` for an admission block, and retain the mismatch
  message only for mismatched bindings. `refusal()` persists status/message;
  `outcomeOf` returns reason `refused`, not the ApiError's structured code.
- The after-assertLive counterexample deliberately instruments the current
  candidate's check/use gap. It is a valid counterexample for d11c468, not a
  portable acceptance test for a future implementation that removes that method.
  Moving the barrier before `startWork` would miss this gap (the current candidate
  already refuses a source that was terminal before its liveness read). Keep the
  original evidence and adapt a new mid-admission barrier to the owner's future
  commit boundary; test both orderings. Do not weaken the regression into a
  before-check test and describe that as closing this race.
- The first execution exposed a test-barrier error that the independent worker
  missed: awaiting the failing HTTP response under the admission's Store lock
  blocks `HostRunService.afterStep -> bridge.flush`, which needs Store. The
  Runtime reconciliation had already persisted. The corrected barrier subscribes
  to the existing RunStore save notification and waits for that durable terminal
  state; the HTTP response is awaited only after releasing admission. The original
  timed-out run and test copy are preserved. A timeout is not reproduction proof.
- Reject the reviewer's HTTP 500 claim for `EngineError RUN_SETTLED` on the message
  routes. `mountInteractionRoutes` maps EngineError/HarnessError to HTTP 409
  (unknown_run maps to 404). An unrelated injected Error can still yield 500.
- The suggested `ifLive` snippet checks only terminal state. It is incomplete as
  an authority primitive without existing principal/scope/generation validation.
  A wrapper must preserve existing owners and enforce those invariants.
- Do not accept the claim that all Work preparation is sufficiently bounded to
  hold the source-run queue throughout it. `NativeWork.start` awaits baseline
  capture; `WorkService.start` awaits `Store.snapshot` and baseline capture.
  `captureFolder` keeps traversing subdirectories after the file-content cap.
  This is local filesystem work, not provider inference, but no bounded duration
  was established. A narrow final admission boundary avoids making cancellation
  wait for that preparation. `NativeWork.prepare()` is invoked before start
  returns, though its promise is deliberately not awaited; the raw review's
  assertion that it launches after return is inaccurate.
- Missing decision evidence remaining unresolved is supported by source and the
  existing tests. This does not prove all P2 semantics: GET currently hard-codes
  `interrupted: false`. The added acknowledged-interruption regression is outside
  the independent worker's frozen source bundle and is separately root-reviewed.
- The new child-intent collision and selection-receipt replay regressions were
  also added after the independent worker's brief was frozen. No claim is made
  that the worker executed or reviewed those added cases.

The independently reviewed two-file patch is not accepted as the complete repair.
The exact owner-addressed work is in `OWNER-HANDOFF.md`; executed results and
remaining gates are in `REVIEW-RESULT.md`.
