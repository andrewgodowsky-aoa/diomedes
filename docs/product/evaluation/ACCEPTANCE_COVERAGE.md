# Acceptance coverage: the Jev evaluation capability

JEV-2026-09-19.1 | Coverage as measured, not as intended.

- **Date:** 2026-09-19
- **Branch:** `feature/jev-evaluation-20260919`
- **Commit:** `1bd3efa4ccca06546f19d0c13f54b20220341803`
- **Source table:** the 80 scenarios J01-J80 in `08_FAILURE_MATRIX.md` of the handoff package
- **Split: 30 COVERED, 44 GAP, 5 GATED, 1 OUT-OF-SCOPE.**

This file records what was verified by reading the tests named below, not what the suite
names suggest. The standard is the one the personal-business ledger already holds to: a row
is COVERED only where the cited test asserts the required result; sounding related is not
coverage. The matrix says the same thing in its own words — "Covered by general safeguards"
is not a test result.

The rule applied to every row, stated so a reviewer can check the verdicts and not only the
citations:

- **COVERED** means one named test, at the line given, exercises the row's scenario and
  asserts its required observable behavior. Where a second line in the same file carries a
  complementary half, the clause names it too. Every cited line was opened and read in this
  worktree at the commit above.
- **GAP** means nothing asserts it yet. Where an existing harness invariant protects the case
  without a test that asserts this row's behavior, the invariant is named in the evidence so
  it is not mistaken for coverage and not rediscovered later.
- **GATED** means it cannot be shown offline. Three gates account for all five: no live-test
  budget is granted, so no real-provider call may be made; `EntitlementView.managedInference`
  is the literal type `false`, so company-funded spending cannot run at all; and no owner
  decision exists on a bounded sponsored grant or on benchmark publication terms.
- **OUT-OF-SCOPE** means the machinery has no referent in this product.

Two facts shape many rows and are stated once here. First, an evaluation is now a recorded
`RunService.step` (`server/harness/evaluation.ts`), so it is budgeted, attributed and
replayable — but the host's own egress authorizer has only two arms
(`server/harness/host.ts:332-337`), so an evaluation step is not yet wired to the live host
seam. Second, no reservation is taken for an evaluation: the allowance ledger is not on this
path, so every row whose required behavior is about holding, releasing or reconciling money
for an evaluation is a GAP, however well the ledger's own contract is tested elsewhere.

## Thread lifecycle

| Case id | Case (short) | Verdict | Evidence |
|---|---|---|---|
| J01 | Empty thread opens or UI remounts | GAP | `tests/evaluation-step.test.ts` — must show that opening or remounting a thread with no substantive request records no step, makes no provider call and writes no preparation-success event. `tests/evaluation-eligibility.test.ts:61` asserts only the predicate half, that zero candidates skip as `single-candidate` |
| J02 | First eligible substantive request arrives | GAP | `tests/evaluation-step.test.ts` — must show exactly one admitted evaluation step recorded, and recorded before the main-model step. `tests/evaluation-eligibility.test.ts:50` asserts only that the predicate fires; nothing asserts admission identity or ordering |
| J03 | Same request retried after refresh | COVERED | `tests/evaluation-step.test.ts:202` — a second identical evaluation calls the provider once and returns the saved observation unchanged |
| J04 | Long thread changes to a different objective | GAP | `tests/evaluation-step.test.ts` — must show a changed objective opens a new intent generation whose recommendations supersede the old ones without rewriting the earlier steps. Nothing in the contract models an intent generation today |
| J05 | A completed thread is reopened | COVERED | `tests/evaluation-eligibility.test.ts:70` — a turn after the first skips with the recorded reason `not-first-substantive`, so reopening a thread buys no preparation |
| J06 | User forks a thread with pending effects | GAP | `tests/evaluation-step.test.ts` — must show a fork cannot replay an evaluation whose outcome is still pending, and that reused context is revalidated. The existing invariant is `tests/harness.test.ts:597`, where a fork over a prefix holding an external effect is refused, but its effect is completed rather than pending and no evaluation is involved |
| J07 | Request is an exact authorized status lookup | COVERED | `tests/evaluation-eligibility.test.ts:61` — a thread with nothing to choose between skips with the recorded reason `single-candidate` rather than buying a preparation |
| J08 | Jev unavailable or local-only policy applies | GAP | `tests/evaluation-eligibility.test.ts` — must show the approved baseline continues after the skip. Line 85 asserts the visible refusal, that local-only processing skips with reason `local-only-policy`, but nothing asserts the main route then runs unchanged |

## Context selection

| Case id | Case (short) | Verdict | Evidence |
|---|---|---|---|
| J09 | Required amendment has an unhelpful name | COVERED | `tests/evaluation-supplier-journey.test.ts:135` — the rebate amendment whose filename says nothing is the chosen candidate and survives selection |
| J10 | A new upload is an old copied policy | GAP | `tests/evaluation-selection.test.ts` — must show a newer copy of a superseded policy cannot displace the current one on modified time. `SelectableSource` carries `revision` and `authority` but no effective version or timestamp, so the case cannot even be expressed yet |
| J11 | High-relevance source conflicts with another | COVERED | `tests/evaluation-selection.test.ts:99` — two sources declared in conflict are both selected and neither is omitted, so keeping the higher-scoring one alone cannot present agreement |
| J12 | User explicitly requests all locations or invoices | COVERED | `tests/evaluation-selection.test.ts:168` — a required sweep that drops anything is labelled `partial`, never complete; the proved-complete case is at line 160 |
| J13 | Prior invoices are missing | COVERED | `tests/evaluation-supplier-journey.test.ts:211` — with the prior period absent the movement is returned as not known, with the exact reason, rather than guessed |
| J14 | Protected instruction scores as irrelevant | COVERED | `tests/evaluation-selection.test.ts:82` — a protected instruction that the ranking scored at nothing is still selected and reported as retained |
| J15 | Source changes after ranking but before effect | COVERED | `tests/reviewer-authority.test.ts:459` — a selected source edited during the review refuses the write, so an approve decision made against the old bytes does not execute |
| J16 | Excerpts omit units, warnings or exceptions | GAP | `tests/evaluation-selection.test.ts` — must show a truncated excerpt is labelled as such and cannot satisfy required coverage. Selection works at whole-source granularity, so no excerpt exists to truncate |

## Tools and routing

| Case id | Case (short) | Verdict | Evidence |
|---|---|---|---|
| J17 | Jev returns an unknown tool or option id | COVERED | `tests/evaluation-contract.test.ts:201` — a choice naming an option the caller never offered is refused as `unknown_option` before anything can consume it, and line 209 refuses it even when it appears only in the distribution |
| J18 | A tool is relevant but not activated or authorized | GAP | `tests/evaluation-step.test.ts` — must show a recommendation naming an unauthorized tool activates no pack, acquires no credential and grants no permission. The existing invariant is `tests/harness.test.ts:801`, where a registered tool outside the capability is neither offered nor callable, but it asserts nothing about activation or about showing the limitation |
| J19 | Main model needs a legitimate omitted tool | GAP | `tests/evaluation-step.test.ts` — must show bounded authorized expansion that re-reads the current schema at a new checkpoint. No discovery or expansion path exists |
| J20 | Tool schema changes during the run | GAP | `tests/rule-hooks.test.ts` — must show a tool whose schema changed between preparation and dispatch is refused for the digest mismatch. The guard exists at `server/harness/native-agent.ts:335-348` and compares digests, but `tests/rule-hooks.test.ts:206` exercises only its removed-from-context arm, not the mismatch arm |
| J21 | Valid enum chooses the wrong target or recipient | GAP | `tests/evaluation-step.test.ts` — must show a syntactically valid choice bound to the wrong target is caught by intent validation. `tests/evaluation-contract.test.ts:189` resolves a choice back to an authorized candidate id but cannot tell a right target from a wrong one |
| J22 | Required amount, date or path is missing | GAP | `tests/evaluation-step.test.ts` — must show a missing consequential parameter is retrieved or asked for rather than defaulted. Nothing evaluates action parameters |
| J23 | Manual model selection conflicts with a Jev suggestion | GAP | `tests/evaluation-step.test.ts` — must show an evaluation result cannot change the selected route, payer or processing policy, and is recorded as a recommendation only. Route selection is manual and the observation carries no authority field (`tests/evaluation-contract.test.ts:347`), but that is a shape check and no test drives a suggestion against a selected route |
| J24 | Auto routing oscillates or escalates repeatedly | OUT-OF-SCOPE | Auto routing does not exist in this product; route selection is manual only, so there is no oscillation, hysteresis or escalation loop to bound. The Auto in the Agent catalog resolves an Agent, not a model route |

## Trust and data boundaries

| Case id | Case (short) | Verdict | Evidence |
|---|---|---|---|
| J25 | Unauthorized source appears in the project index | GAP | `tests/evaluation-selection.test.ts` — must show an unauthorized source is filtered out of the candidate set before it can reach cloud input or a visible count. `SelectableSource` has no authorization field, only `authority` as a retention rank |
| J26 | A retrieved document contains malicious instructions | GAP | `tests/evaluation-step.test.ts` — must show instruction-shaped text inside a selected source cannot alter grants, routing, the tool registry or the model policy. The step fixture labels its state `untrusted`, but no test drives hostile content through it |
| J27 | A document includes secrets in metadata or filenames | GAP | `tests/evaluation-step.test.ts` — must show filenames and metadata are held to the same data policy as bodies before disclosure. Line 165 keeps document content out of the run record by pinning a digest, which is a telemetry protection and not a disclosure filter |
| J28 | Membership revoked after cache creation | COVERED | `tests/execution.test.ts:244` — a membership revoked after the run started stops the effect at the live recheck, and the revocation is named in what changed |
| J29 | Identical requests exist across two customers | COVERED | `tests/managed-usage-ledger.test.ts:391` — the same reservation id is simply absent in another company and the refusal does not confirm the other company's id exists |
| J30 | Requester can see output but peers cannot | GAP | `tests/business-output.test.ts` — must show a result is delivered by an access-controlled reference rather than broadcast. Lines 131 and 143 gate the output target on membership, which is the access check, but nothing asserts the result reference itself is access-controlled |
| J31 | Advisor recommends approving its own generated action | COVERED | `tests/evaluation-contract.test.ts:347` — the validated observation carries no permission, capability, approved, authority or grant field anywhere in its JSON, so a recommendation cannot become an approval receipt |
| J32 | User changes workspace while a task is running | COVERED | `tests/harness.test.ts:410` — a run admitted in one tenant cannot be executed under another, and line 417 refuses a different project |

## Provider and SDK conformance

| Case id | Case (short) | Verdict | Evidence |
|---|---|---|---|
| J33 | Gateway lacks a direct confidence field | COVERED | `tests/evaluation-contract.test.ts:335` — no answer carries a field called confidence and the whole serialized observation is asserted free of the word, so none is fabricated where the gateway publishes none |
| J34 | Missing question, unknown primitive, NaN or huge result | COVERED | `tests/evaluation-contract.test.ts:222` — a result missing an answer is refused as `missing_answer` rather than consumed in part; the same describe refuses a wrong primitive at 234, NaN and infinity at 243 and an oversized payload at 283 |
| J35 | Parallel questions disagree logically | GAP | `tests/evaluation-contract.test.ts` — must show a deterministic contradiction between two answers in one result is detected rather than merged. The validator checks each answer against its own question and never compares answers |
| J36 | Alias resolves to a different model revision | GAP | `tests/evaluation-step.test.ts` — must show a version-specific promotion or calibration is suspended when the reported revision differs from the requested alias. `tests/evaluation-contract.test.ts:183` records the actual model apart from the requested one, which is the recording half only |
| J37 | Provider exposes 32K but native docs discuss 64K | COVERED | `tests/evaluation-adapter.test.ts:114` — state above the route limit is refused as `state_too_large` with zero port calls, and line 123 pins the limit to the route's tested bound rather than the largest number in the provider docs |
| J38 | Input includes image-only evidence | GAP | `tests/evaluation-adapter.test.ts` — must show image-only input is sent to an authorized extraction route or reported unsupported, never described from nothing. Line 106 refuses an unsupported question type, which is a different unsupported-input axis |
| J39 | A 429 arrives while the SDK also retries | GAP | `tests/evaluation-adapter.test.ts` — must show Retry-After is honoured under one bounded attempt policy and that every actual attempt is accounted for. Line 197 asserts only that the SDK retry budget is set to zero |
| J40 | OpenRouter lists it but the evaluation API is incompatible | GAP | `tests/evaluation-adapter.test.ts` — must show a listed but non-conforming route stays unsupported and is never emulated by parsing chat text. Line 232 reports an absent SDK honestly, which is a different failure |

## Durability and costs

| Case id | Case (short) | Verdict | Evidence |
|---|---|---|---|
| J41 | Crash after reservation before dispatch | GAP | `tests/evaluation-step.test.ts` — must show the same step is recovered and an unused reservation reconciled against the dispatch record. No reservation is taken on this path at all; line 153 asserts only that the step's `maxAttempts` is one |
| J42 | Crash after provider response before local persistence | GAP | `tests/evaluation-step.test.ts` — must show the outcome parks as uncertain, the hold is not released and the call is not repeated. The invariants exist elsewhere, in `tests/managed-usage.test.ts:194` for the hold and `tests/harness-provider-outcomes.test.ts:41` for the redispatch, but no evaluation step runs on either |
| J43 | A saved successful evaluation is replayed | GAP | `tests/evaluation-step.test.ts` — must show current authority is revalidated before a saved observation is consumed. Two of the three halves are asserted, at line 202 where the saved answer is returned without a second provider call and at line 211 where a changed project asks again, but line 145 counts egress phases on a first run only and no test inspects authority on the replay path |
| J44 | Task cancellation races with a late response | GAP | `tests/evaluation-step.test.ts` — must show a cancelled evaluation records its real usage and that a late answer creates no effect. `tests/evaluation-adapter.test.ts:175` covers only cancellation before dispatch, where nothing was sent |
| J45 | Two hosts claim the same preparation step | COVERED | `tests/harness.test.ts:514` — two services over the same run folder cannot dispatch the same step under one lease generation, and line 269 refuses a steal of a live lease |
| J46 | Network timeout after an external business action | COVERED | `tests/harness.test.ts:126` — a non-idempotent step whose acknowledgement is lost parks for reconciliation, its retry is refused, and the handler is proved to have run exactly once |
| J47 | A cloud call is hidden in pure prepare or inspect | COVERED | `tests/evaluation-step.test.ts:136` — an evaluation is recorded as a model step with a nonzero cost rather than a pure transform, and line 145 asserts it declares destination external and passes through the egress authorizer at dispatch and again at result |
| J48 | Provider usage is absent or price is unconfigured | COVERED | `tests/evaluation-price.test.ts:89` — unreported input tokens cost an unknown amount rather than zero, and line 111 returns unknown when the model has no published price at all |

## Advisor operation

| Case id | Case (short) | Verdict | Evidence |
|---|---|---|---|
| J49 | No event occurs while a task is waiting | GAP | `tests/evaluation-step.test.ts` — must show that a task waiting with nothing changed makes no periodic call and holds no resident model or process. `tests/evaluation-eligibility.test.ts:75` refuses a team wake because it submits no request, which is the nearest assertion, but a wake is an event: nothing there asserts the quiet case, and there is no observer to be quiet |
| J50 | A hundred equivalent error events arrive | GAP | `tests/evaluation-step.test.ts` — must show equivalent events coalesce by causal step identity into one recommendation under a bounded queue. The nearest existing assertion is `tests/reviewer-authority.test.ts:344`, where one change set buys one reviewer call however often admission is retried, but it coalesces retries rather than an error storm |
| J51 | Advice arrives for an earlier source or intent revision | GAP | `tests/evaluation-step.test.ts` — must show an observation answering an earlier revision is marked stale and not injected into current work. Line 211 re-asks when the state changed, which prevents the reuse but records no staleness and preserves no attribution |
| J52 | Optional advice times out | GAP | `tests/evaluation-step.test.ts` — must show the baseline continues after an optional evaluation times out and that no successful check is recorded. Nothing asserts what happens after a failed optional preparation |
| J53 | Required verification times out | COVERED | `tests/reviewer-authority.test.ts:316` — a reviewer that never answers is recorded as an error with reason `cancelled`, the authorization is absent, the proposal is preserved and the file is never written |
| J54 | Repeated advice produces no improvement | COVERED | `tests/rule-hooks.test.ts:278` — output that stays wrong stops at the correction budget with `correction_limit` after exactly two model calls, and the earlier observations are not rewritten |
| J55 | Advice asks for cloud fallback on local-only data | GAP | `tests/evaluation-step.test.ts` — must show an evaluation result asking for a cloud route on local-only data is denied by the data policy. The policy denial itself is asserted at `tests/execution.test.ts:178` and `tests/managed-gateway.test.ts:125`, but neither takes adviser output as an input |
| J56 | Final output is streamed before material verification | GAP | `tests/evaluation-step.test.ts` — must show an unverified draft is either gated or shown as a draft, and never labelled verified. No streaming or draft-state assertion exists |

## Evidence and uncertainty

| Case id | Case (short) | Verdict | Evidence |
|---|---|---|---|
| J57 | A claim cites an unrelated passage | GAP | `tests/rule-hooks.test.ts` — must show a citation that does not support its claim fails support checking. The native loop's inspect hook checks a claim against a rule, not a claim against its cited passage |
| J58 | A source supports a claim but is stale | GAP | `tests/evaluation-selection.test.ts` — must show a supported claim carries the date or scope of its source, or current evidence is fetched. Selection pins a revision number, which cannot express staleness |
| J59 | Only one subquestion is unanswerable | GAP | `tests/evaluation-supplier-journey.test.ts` — must show the supported parts are answered while the exact gap is named. Line 211 names the gap precisely but returns nothing for the parts that were supported |
| J60 | Authorized search can resolve the missing fact | GAP | `tests/evaluation-step.test.ts` — must show a proportionate authorized retrieval happens before the user is asked or ignorance is claimed. No retrieval step exists |
| J61 | Source read fails and returns no items | GAP | `tests/task-document-select.test.ts` — must show a listing failure and a valid empty listing render as different states. Line 38 renders a failure as a disabled alert, but the empty-and-valid case is never rendered without a failure beside it |
| J62 | A material claim survives bounded correction unsupported | GAP | `tests/rule-hooks.test.ts` — must show the outcome is delivered qualified, or as a Need, rather than thrown away. Line 278 stops at the correction budget by rejecting the run, which prevents the confident assertion but delivers no qualified outcome |
| J63 | A simple verified calculation is fully supported | COVERED | `tests/evaluation-supplier-journey.test.ts:198` — with the invoices and the amendment in context the movement is answered directly, with its before, after and direction, rather than declined |
| J64 | Main model claims success with no artifact or receipt | GAP | `tests/evaluation-step.test.ts` — must show postcondition verification refuses completion when no artifact or receipt exists. `tests/harness.test.ts:765` parks a run whose effect failed and `tests/rule-hooks.test.ts:278` refuses an unsupported claim, but neither checks a success claim against a missing receipt |

## Entitlements and measurement

| Case id | Case (short) | Verdict | Evidence |
|---|---|---|---|
| J65 | Ordinary Free uses a company-funded endpoint | COVERED | `tests/managed-gateway.test.ts:117` — every managed admission is refused as `no_entitlement` in this build, while line 163 admits a business's own key and debits nothing, so the separately authorized option survives the denial |
| J66 | Implementation purchaser has no defined grant amount or period | GATED | Gate: no owner decision exists on a bounded sponsored grant, and `EntitlementView.managedInference` is the literal type `false`, so no sponsored spending can start and nothing can wait on a grant that has no definition |
| J67 | Grant exists but the request uses a large main model | GATED | Gate: the same missing owner decision. No purpose-scoped grant exists, so there is no purpose restriction to enforce and no unrelated hosted inference to refuse |
| J68 | Duplicate or reordered billing events arrive | COVERED | `tests/managed-usage-ledger.test.ts:109` — a second event with a different id and a different amount leaves the allocated period and its balance exactly as the first left them |
| J69 | Paid plan cancels while an implementation benefit stays valid | GAP | `tests/customization-benefit.test.ts` — must show a cancelled plan leaves a separately earned benefit intact and discloses nothing. `tests/customization-entitlement.test.ts:85` holds the separate-terms invariant, that an active plan which is not the customization plan grants nothing, but no test cancels a plan and checks the benefit |
| J70 | Many new threads or forks bypass per-thread caps | COVERED | `tests/managed-usage-ledger.test.ts:275` — children of one task share a single envelope, their pending holds count at their ceiling while in flight, and the child that would exceed it is refused |
| J71 | Helper usage would consume the primary task's budget | COVERED | `tests/evaluation-eligibility.test.ts:101` — a helper whose own remaining budget cannot cover its reservation ceiling does not fire, and line 107 fires only when that budget covers the ceiling exactly |
| J72 | Startup credits expire or are ineligible for this route | GATED | Gate: no sponsored spending can run while `EntitlementView.managedInference` is the literal `false`, so no credit balance, expiry or eligibility is ever consulted; it needs the same owner grant decision as J66 |
| J73 | User attempts to set local paid-plan flags | COVERED | `tests/managed-gateway.test.ts:205` — a request body asserting paid access, a managed entitlement and another company's id is refused as `no_entitlement`, because the gateway takes the organization from the host's own resolution |
| J74 | A proposed candidate price is deployed as live pricing | GAP | `tests/release-gates.test.ts` — must show a candidate price cannot reach published copy without a recorded commercial approval. `tests/managed-usage.test.ts:124` asserts the candidate plan is not sellable and says why, which is a flag on the definition and not a publication gate. The row's own figures are retired pricing and no longer appear in the repository |
| J75 | Token savings disappear after cache misses and retries | GAP | `tests/evaluation-price.test.ts` — must show the reported outcome is the actual full token, cost and latency result and that a savings claim built on a cache hit is refused when the cache missed. Nothing computes or publishes a savings figure |
| J76 | Providers report incomparable reasoning or cache totals | GAP | `tests/evaluation-price.test.ts` — must show documented semantics are normalized, the native fields are kept beside them and unknown coverage is marked. `tests/evaluation-contract.test.ts:302` keeps absent usage unknown, which is one provider's shape and not a normalization |
| J77 | A rollback restores an old cached permission or credit | COVERED | `tests/execution.test.ts:238` — an old snapshot rechecked at the effect boundary cannot revive a revoked grant, and the refusal names it as withdrawn |
| J78 | Evaluation dataset favours long easy tasks | GATED | Gate: no live-test budget is granted, so the stratified accuracy run this requires cannot be made. The matrix itself rules out the offline substitute, saying a scripted probability table is not a live-model accuracy benchmark |
| J79 | External harness hides internal context or usage | GAP | `tests/capabilities.test.ts` — must show no route may report a context or usage efficiency figure Diomedes cannot observe at its own seam. Line 53 holds the same discipline for containment facts, keeping shell and filesystem answers unknown, but says nothing about usage or context |
| J80 | Public benchmark prepared without terms clearance | GATED | Gate: publication needs a rights, terms and methodology review that has not been done, and no owner decision authorizes it. Offline contract testing proceeds meanwhile, which is what every COVERED row above is |
