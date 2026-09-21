# CD-01 bounded independent review

**Verdict: rejected.** Candidate `d11c468e69e279ab0c2581bbdeb6cf113e166d7a`
repairs two original counterexamples, but does not close atomic admission or
the required replay/completion contract. No production patch was applied and
no new candidate commit, merge or publication was made in this pass.

## Findings, ordered by severity

**[P1] Revalidate current Mode at each child admission** -
`server/app.ts:2823` and `server/interaction-service.ts:363`.
An actual Ask or Plan message can finish after the selected proposal's phase
was saved but before Work admission. The host checks only source liveness;
the saved pre-await restriction remains effective. Each schedule creates one
prohibited Work session. Re-read current Mode and intersect it with the saved
message restriction inside each protected commit. Preserve a task admitted
before the narrowing.

**[P1] Order Runtime terminal transitions with child admission** -
`server/harness/claude-session-run.ts:479`, `server/app.ts:2835`,
`server/harness/run-service.ts:827`.
The existing Store lock orders the HTTP cancel route, but not asynchronous
Runtime mutations. The corrected test makes a second real message's fake
provider fail after the Work liveness check; RunService durably records
`reconcile_required` before Work admission continues. Result: HTTP 409,
one earlier task, and one newly admitted Work session. The error response does
not undo it. Protect validation and child commit using the existing source-run
queue with Store -> source queue ordering and bounded commit callbacks.

**[P1] Validate child command intent before trusting its receipt** -
`server/app.ts:2813` and `server/interaction-service.ts:390`.
A real task POST pre-binds the derived child command ID to a different payload.
Selection then trusts the ID-only receipt, skips task admission's digest check,
and creates Work on that different task, returning 200. Use existing command
parsers/digests and replay validation for receipt lookup and crash recovery.

**[P2] Converge identical concurrent selections on the same receipt** -
`server/harness/claude-session-run.ts:379` and
`server/interaction-service.ts:269`.
Two identical selections return 200 and 409 (`step already in flight`) instead
of both returning the same receipt. This schedule creates one task/session,
so it demonstrates failed convergence, not duplicate execution. Join or reread
the same immutable phase/command through the existing Runtime owner.

**[P2] Preserve receipt-only selection replay after cancellation** -
`server/interaction-service.ts:246`.
After a Work commit, source cancellation and Mode narrowing, GET and message
replay correctly retain the receipt. An identical `/select` retry instead
returns 409 because lifecycle is checked before receipt lookup. Validate the
old bound intent and return its receipt under current read authorization;
apply execution authority only to new effects.

**[P2] Preserve acknowledged interruption when polling** -
`server/interaction-service.ts:307`.
A real native interrupt control produces a durable turn result with
`interrupted: true`, no answer and unresolved outcome. Polling that same
command returns `interrupted: false`. Read the saved result consistently with
completion/decision evidence; pending and partial messages must remain
non-interrupted unless interruption actually occurred.

## Executed evidence

All interleavings use real Express routes, Store, RunService, the native session
driver, task admission and sample Work admission. The conversation provider is
faked. Phase/liveness hooks place deterministic barriers; they do not fabricate
Runtime state. No live bot-provider/API/packaged acceptance was attempted.

| Run | Passed | Failed | Skipped | Result |
| --- | ---: | ---: | ---: | --- |
| Preserved original three-case run on 265a33c | 0 | 3 | 10 | Rejected; original filter skipped fixture cases |
| Fresh d11c468 unfiltered original fixture plus owner focused suites | 90 | 1 | 0 | Original cancellation and pending cases pass; Mode fails |
| Expanded corrected matrix on d11c468 | 6 | 7 | 0 | Rejected; no timeouts |
| Corrected full unit suite on d11c468 | 4242 | 8 | 1 | Rejected; 219 files passed, 2 failed; no timeouts |
| Required browser suite | 36 | 0 | 0 | Passed |

Typecheck and Vite build passed. The first matrix/full-unit attempt is retained
as diagnostic evidence: 6/7/0 for the matrix and 4242/8/1 for unit tests, but one
matrix case timed out due to its test barrier awaiting an HTTP response that
needed Store projection. That timeout is not a product-defect proof. The
corrected test waits for the existing durable RunStore notification; it
reproduces the actual post-terminal Work admission in 414 ms. Its unfiltered
rerun replaces the first unit result above. It completed in 254.55 seconds,
with all eight failures belonging to the independent regressions above.

The six passing matrix cases cover HTTP cancellation preserving an earlier
task; admission-first historical GET/message replay; cross-project and changed
selection-target/digest refusal; observational partial-output polling; restart
with a committed child but no parent receipt phase; and late cancelled output
not overwriting a later conversation generation. The seven failures are Ask,
Plan, concurrent selection, selection receipt replay, different child intent,
acknowledged interruption polling, and asynchronous Runtime failure.

## Reproduction commands and identities

Working directory: `F:/Diomedes/diomedes-wt/interaction-authority-review`.
The exact commands are in `run-review.ps1`, `run-matrix-gates.ps1` and
`run-corrected-matrix.ps1`. All heavy runs acquired the pinned coordination
tool's exclusive slot only after `ok: true`, and release in `finally`.

```text
node node_modules/vitest/vitest.mjs run tests/interaction-seam.review-20260921.test.ts tests/interaction-seam.test.ts tests/interaction-driver.test.ts tests/interaction-turn.test.ts tests/interaction-admission.test.ts tests/home-conversation.test.ts tests/run-service-claim-settled.test.ts --maxWorkers=2
node node_modules/vitest/vitest.mjs run tests/interaction-authority.matrix-20260921.test.ts --maxWorkers=1
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run --maxWorkers=2
node node_modules/vite/bin/vite.js build
node node_modules/@playwright/test/cli.js test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts
```

The first command collected six files. `run-service-claim-settled.test.ts` was
not present in the frozen candidate and is not claimed as an executed file.

The original independent test remains unchanged in the old review checkout
and the original deliverables directory, SHA256
`18F1D29F0670A5792E6BAF5E5CC660F41A116797CC81DF04153069D53C1AFB15`.
The executed copy adds only an explicit type import/cast, SHA256
`9AF1F563C3BA12C356CD7B997A29CA47F11A51DD5CEB13B642720E3473D7A8F3`.
`corrected-test-identities.json` identifies the final matrix and executed test.
The matrix version with the HTTP-wait error is preserved separately as
`interaction-authority.matrix-v1-with-http-wait.ts` (SHA256
`C187B7911DBEF0BB43032A301371C1E09159AF9E0A1442C356ED7CFFB1C40405`).
The first full suite had already executed that file before the corrected test
was written, so its final code-frame excerpts may display shifted source lines;
use its preserved v1 source for those frames. The corrected full run uses the
final frozen test identity throughout.

## Owner handoff and acceptance limits

`OWNER-HANDOFF.md` gives the exact active owner, claims, files, ordering and
repair steps. Andrew explicitly kept those lanes read-only. The separate
`SWE-MAX-mode-bindings-PARTIAL-UNAPPLIED.patch` passes `git apply --check` against
d11c468, but has not been applied or accepted and leaves multiple defects open.
`swe-max-independent-review-output.txt` is a fresh independent SWE-2 Max review;
`INDEPENDENT-REVIEW-ADJUDICATION.md` records which claims survived source checks.
Both worker exports verify SWE-2 Max and zero tool calls.

The source-level audit also traces denial, Runtime fail/complete/recovery,
scope revocation, Mode PUT/message projection and lineage replacement. It is
not execution proof for every path. Additional retired-lineage/target-change
and full authority-generation schedules, native child Work interleavings,
full stop/reconciliation semantics, and an abrupt multi-file crash remain
required for closing acceptance. The restart test deliberately omits a parent
phase and gracefully reopens the application; it is not an OS-crash guarantee.
Read authorization here is the existing local-client/project surface; this is
not multi-tenant authorization proof.

Owner HEAD advanced through reserved-home repair `4e2c93c` to
`26b33ff3fec77786d88b1dd3b1cf1a79bff82696` (home engine guard) during this review.
Commit `e1fe233` preserves another review's acceptance with an O5 obligation.
That verdict does not close the counterexamples here. A fresh source diff from
d11c468 to 26b33ff has no changes to interaction-service, Claude session driver,
RunService, or the task/Work interaction-host admissions; its app changes are
reserved-home guards. No executed result here silently transfers to the later
commit or a future combined PR. The SDK integration task received this conflict
and has no acceptance clearance from this review. Full CD-01, bot live-route,
package, GitHub release and website-download acceptance remain pending.
