# CD-05.R-6: executing acceptance of the R-13 closure repair

Date: 2026-09-21. Candidate: `924066bb9162e66c8ce168ffb5eac6f9b954c0c7`.
Review worktree: `F:/Diomedes/diomedes-wt/core-agent-client-closure`.
The repair and diagnostic fixture were authored in a separate Devin SWE 2.0 Max
session. The reviewer inspected the complete diff and independently executed
the checks below. The reviewer authored no permanent repair or test change.

**Accepted: CD05-R-13 closes, and the previously reviewed CD-05b scope is
accepted.** R-5 remains unchanged. This verdict does not accept the later Home
Luna/Stop scope or make CD-05b DONE before its exact implementation is merged.

## Failure diagnosis and repair boundary

The original closure was committed before the repair and failed unchanged in
R-5: 3 of 16 repetitions, then 1 of 5 protocol-diagnostic repetitions. Its final
answer assertion timed out after B's POST returned 200 and the browser issued
a state GET. The assertion that B retained one pending delivery had passed.

A separate diagnostic sibling preserves that scenario and its assertions.
The default interception lifecycle produced 15 passes and 1 failure of 16.
Keeping interception registered produced 16 passes of 16. In the failed default
run, the browser issued B's state GET at 11:43:58.030Z, immediately after route
fulfillment at 11:43:58.029Z. The Node request/finish/close observations contained
no corresponding GET before the assertion deadline. The earlier B state GET
completed normally. There was no obsolete A read, stale notice, held Web Lock
or saved pending claim in the failure snapshot.

This localizes the observed stall before Node's request handler. It supports
repairing the test's interception lifecycle. It does not establish the exact
browser or interception mechanism, an upstream defect, a socket failure, or
the cause of the outgoing integrator's unlogged historical failure. No CPU,
memory or driver diagnosis is claimed.

The candidate changes only the first R-12 closure and its Route type import.
It keeps the same URL pattern, request fetch, response gate and release order.
The handler remains registered through all assertions and is removed in
finally. It counts every POST and asserts exactly one. The original pending,
answer, scope, strip, notice and exactly-one-record assertions and their timeout
remain. There are no retries, sleeps, timeout increases or application changes.

The separate frozen R-4 reproducer still occurs once, byte-for-byte, in
`924066b:tests/diomedes-home.spec.ts`, as it does in `0e7602f` and `1f6f93c`:
3,034 bytes, SHA-256
`d08f4a0b70aa34af0c70a6046c51c86b3aaa8a7fe23e65224d9f340776a00abe`.
Its original intended red run and earlier invalid baseline attempts remain
recorded in R-5. The author record's pending verification statements describe
the submission, and are superseded only by this executing review.

## Independent execution

The first uncommitted submission had two TypeScript errors: handler bindings
declared inside try were unavailable to finally. That failure is retained in
`r13-initial-candidate-tsc.log`. The author corrected it before candidate
`924066b`; the corrected type check exited 0. It is not hidden as a first-pass
success.

| Check | Result |
| --- | --- |
| Corrected candidate `tsc --noEmit` | Exit 0 |
| Candidate `vite build` | Exit 0 |
| Repaired closure, 32 repetitions, one worker, zero retries | 32 passed, 0 failed |
| Complete `tests/diomedes-home.spec.ts`, one worker, zero retries | 33 passed, 0 failed |
| B17 success guard removed, repaired closure | Intended red: pending expected 1, received 0 at line 1201 |
| B17 restored, rebuilt, all R-12 cases | 4 passed, 0 failed |
| B18 rejection guard removed, error closure | Intended red: stale notice expected 0, received 1 at line 1303 |
| B18 restored, rebuilt, all R-12 cases | 4 passed, 0 failed |

The repaired closure therefore still kills removal of the guard whose
cross-project delivery behavior it protects. The error closure separately
kills B18. Neither removal survived. After each mutation, the named source
file was restored from HEAD, its diff was empty, and its original working-byte
SHA-256 was verified:
`291ad4c48df14b76c8b2d12dbb583f829dd654204fb8d0afdad94750b6bb8435`.
The worktree was clean again before this report was added.

The B17 red log also contains `route.fulfill: Route is already handled!` during
failed-test cleanup. The pending-count assertion independently failed before
the intended B response release; the cleanup error is retained and is not the
sole basis for crediting the mutation kill.

The pinned coordination tool granted each heavy slot to this reviewer's own
identity: role astra, PID 43452, process start
`2026-09-21T04:32:24.4162630Z`. Slots:
`slot_mub6ffe3_f135472b` (diagnosis), `slot_mub6yj7y_a0430109` (candidate),
`slot_mub74pci_95a6a2e6` (B17), `slot_mub78fnc_1d90621c` (B18).
All were released. Browser checks were serialized, without concurrent type
checks or full suites. This review does not claim a fresh full Vitest run.

## Retained evidence and remaining program gates

Evidence root: `F:/Diomedes/deliverables/core-agent-continuation-20260921/`.
The diagnostic siblings were archived there as `r13-diagnostic.spec.ts` and
`r13-diagnostic.config.ts`; they are not acceptance-suite replacements.
Original and corrected author outputs and session exports are retained.
Relevant logs are `r13-default-browser.log`, `r13-keep-browser.log`,
`r13-corrected-candidate-tsc.log`, `r13-candidate-build.log`,
`r13-candidate-repeat32.log`, `r13-candidate-whole-page.log`,
`r13-B17-red.log`, `r13-B17-restored-green.log`, `r13-B18-red.log`, and
`r13-B18-restored-green.log`. Their result JSON files record the candidate and
slots. Both mutation traces and diagnostic failure traces remain available.

The R-5 limits on unreadable pending storage, streaming preview, live-provider
proof and installed-build proof remain. Andrew's Home Luna default and Stop
addition still needs an accepted contract, implementation, separate executing
review and final composed gates. PR #29 remains draft until those gates pass.
No release, site deployment or completion-package status is advanced here.
