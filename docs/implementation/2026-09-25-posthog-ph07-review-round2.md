# PostHog PH-07 round 2: review of the repaired PH-01 and PH-02

| | |
|---|---|
| Work order | PH-07 round 2, handoff NC-PH-2026-09-25.3 |
| Candidate | `d18f64c` "Repair PostHog PH-07 findings F-1 to F-7", on 8d730d4 (PH-02), 678dba6 (PH-01) and dc397c1 (PH-00 contract) |
| Round 1 | `docs/implementation/2026-09-25-posthog-ph07-review.md` and `tests/ph07-review.test.ts`, at a3f7a3c |
| Review branch | `review/posthog-ph07-round2` in `F:/Diomedes/diomedes-wt/posthog-review` |
| Reproducers | `tests/ph07-round2-review.test.ts` (13 tests), committed with this document |
| Owner | Andrew |
| Date | 2026-09-25 |

The round 2 reviewer did not write the candidate, did not write or review round 1, and did not
see either author's conversation. Every result below was produced in this worktree. No request
reached PostHog, AWS or any other host: the account service is the faux service in process, and
the new tests use the memory sink or a scripted sink. No credentials were used. The candidate's
source files were not modified.

**Round 1's reviewer file is unchanged.** `git diff a3f7a3c d18f64c -- tests/ph07-review.test.ts`
printed nothing (0 bytes). The same command for the round 1 document also printed nothing.

## Verdicts

| Slice | Verdict |
|---|---|
| **PH-01**, metadata observation, offline (678dba6 + d18f64c) | **Accepted with named conditions.** F-1, F-6 and F-7 are fixed at their cause. F-2 is fixed at its cause for the case round 1 reproduced. But the repair decides which business was refused *after* the round trip to the account service, not before it (N-1, P2). Under a workspace switch during that round trip, a revoked business's events still leave: this is F-2's own effect by another path. Conditions: **N-1 fixed before any activation beyond `memory` mode on an internal host.** N-2 and N-3 decided or fixed before PH-04 relies on trace completeness. |
| **PH-02**, the `/batch/` transport, off by default (8d730d4 + d18f64c) | **Accepted.** Round 1 rejected it on F-1 alone, and F-1 is fixed at its cause: the registered tool leaves as a `tool` span under its allowlisted name through the real runtime (`H1`, `T2`). F-3, F-4 and F-5 are fixed at their cause and hold at their exact boundaries. The failure-isolation, default-off, spoofing and outgoing-byte invariants of round 1 pass again. Live `posthog` mode stays behind round 1's activation preconditions (a verified funded pilot, company credentials in operator configuration only) and PH-01's conditions above. |

## Round 1 findings

| # | Round 1 | Repair status | Evidence |
|---|---|---|---|
| F-1 | P1 | **Fixed at cause** | The span decision now requires `step.intent.kind === 'model'` before anything can be scripted (`server/observability/projector.ts:360-361`). A tool step is always a `tool` span under `toolName(...)`, the allowlist. `H1` (round 1) and `T2` pass through `createApp`: one span, `tool` / `read_project_file`. `T1` runs 14 adversarial steps: a tool named `fixture`, `native-fixture`, `scripted-step`, `READ_PROJECT_FILE`, `read_project_file ` (trailing space), `__proto__`, a canary, `delegate` with a supervisor origin, and a failed registered tool. Every tool stays `tool`, and only allowlisted names leave; the rest are `other`. No model step becomes a tool span, and a failed model step with no origin stays a generation. Only a scripted-adapter model step is `scripted-step`. No raw name appears in the encoded events. The allowlist's team entries are fixed constants (`shared/team-routes.ts:36`, `shared/team-delegation.ts:36`, `:38`), so no customer-chosen name can enter it. |
| F-2 | P2 | **Fixed at cause for round 1's case; the fix adds N-1 (P2) and N-2 (P3)** | `admitModelApi` now calls `ObservationScopes.refused` when the gate throws (`server/engines/service.ts:1970-1977`). A per-business refusal counter makes the end sticky (`server/observability/scopes.ts:143-150`, `:186-190`). Passing: `A4` (round 1); `R3` (a refusal during an in-flight batch: the failed batch's retry drops the refused business's event and resends the other business's); `R4` (the person's 403, its body bytes and the lineage run are identical with observation off, on, and on with a `refused` that throws); `R5` (after a new grant, the next admission binds a fresh scope that exports, and the dropped turn never comes back); `R6` (a refusal after admission, here a zero spend limit, ends nothing). Failing: `R2` (N-1) and `R1` (N-2). |
| F-3 | P3 | **Fixed at cause** | `expire()` now ages the waiting batch as well as the queue, and runs before every send in `drain` (`server/observability/exporter.ts:385`, `:493-507`). `F1` passes. `U1` pins the boundary: a retry at exactly one hour is sent, and one millisecond later it is dropped `expired`. A waiting batch retried when its events are 60:01 and 30:01 old resends only the younger. The comparison is `>` for both the queue and the waiting batch, so they agree. |
| F-4 | P3 | **Fixed at cause** | Both caps count the waiting batch (`exporter.ts:254-260`, `:510-513`), the same figure `health()` reports. `F2` passes. `U2`: with 50 events waiting and 49 queued, the 100th is accepted and the 101st refused (`queue-full`). A byte cap of exactly 4 events holds 4, and one byte less holds 3. Round 1's `F3` still passes, including its bound of under 2 ms per `enqueue`. |
| F-5 | P3 | **Fixed at cause** | `isCalendarDay` (`server/observability/eligibility.ts:69-73`) is used by the environment parser (`:91`) and the exporter's gate (`exporter.ts:356`). `G2` passes. `V1`, run with the host zone set to UTC+14, UTC−12 and UTC (three distinct offsets confirmed): 2028-02-29, 2024-02-29 and 2000-02-29 are valid. 2027-02-29, 1900-02-29, 2100-02-29, 2099-02-30, 2027-04-31, 2027-13-01, 2027-00-10 and 2027-3-31 are refused. So are time and offset suffixes, compact, slashed, full-width, signed-year and prose forms, a leading space and a trailing newline. Funding through 2028-02-29 is `exporting` at 23:59:59.999Z and `disabled:funding` at 2028-03-01T00:00Z, in every zone. The environment value is trimmed first (`eligibility.ts:86`), so padding in the variable is accepted, while the gate refuses a padded value passed to it directly. |
| F-6 | P3 | **Fixed at cause** | The tallies now count only declared checks, not the verifier's own `outputs-intact` (`projector.ts:230-233`). A declared id cannot be `outputs-intact` (`shared/verification.ts:29`), so the filter by kind drops nothing a person declared. Round 1's soft check in `H1` passes, and `T2` gives `declared 2, passed 2, failed 0, incomplete 0` through the real verifier. `W1`: one passed, one failed and one incomplete give 1/1/1 of 3. A declared check with no result gives a sum below `declared`, which is honest. Zero declared checks give 0/0/0/0. Recorded, not a finding: when `outputs-intact` is incomplete and every declared check passed, the span is `uncertain` / `check-incomplete` with `incomplete: 0`. PH-04 should read the rule, not the tallies, to count that case. |
| F-7 | P3 | **Fixed at cause** | `model:plan` leaves as `model-plan` (`projector.ts:413`). `T1` and `T2` pass: through `createApp`, exactly one generation is `model-plan` and the rest are `model`. |

## New findings

| # | Severity | Reproducer (failing line) | Cause | Summary |
|---|---|---|---|---|
| N-1 | **P2** | `R2`, `tests/ph07-round2-review.test.ts:431`, `:432`, `:437-440` | `server/observability/scopes.ts:145`; `server/observability/runtime.ts:80`; called after the await at `server/engines/service.ts:1970-1972`, while the gate chose the business at `server/accounts/agent-gate.ts:84` before its own await at `:87` | A refusal is charged to whichever business is active when it *returns*. A workspace switch during the round trip ends the wrong business's scopes, and the refused business's events still leave |
| N-2 | P3 | `R1`, `tests/ph07-round2-review.test.ts:381` | `server/engines/service.ts:1970-1977` calls `refused` for every rejection. `server/accounts/session.ts:490-496` turns an unreachable service or a 5xx into `entitlement_unknown`, which `server/accounts/agent-gate.ts:105` throws as `AGENT_NOT_INCLUDED` | A network error, 503 or 500 on one admission is treated as a revocation. The business's earlier, admitted work is never exported, and the drop is counted as `admission-refused` |
| N-3 | P3, predates the repair | `S1`, `tests/ph07-round2-review.test.ts:614` | `server/observability/eligibility.ts:280-282` (in 678dba6) | Sign-out and a workspace switch end a scope only while they last. Going back before the next flush makes the scope live again, and its queued events leave |

### N-1 (P2): a refusal is charged to the business active when it returns

**What was run.** `R2`:

1. One person is admin of two entitled businesses, and both are on the internal list.
2. In Harbor, one conversation turn is admitted and queued.
3. In Juniper, one turn is admitted and queued. Nothing is flushed.
4. Juniper's grant is revoked through the faux Billing API.
5. The next Juniper message is sent. The faux account service holds that admission. While it is held, the person opens Harbor (`POST /api/workspace/switch`, 200). Then the admission is released.
6. The service refuses Juniper. The person sees 403.

**What came back.** The switch landed while the admission was in flight (the test's precondition
passed).

- (a) Harbor, never refused, lost its scope: `scopes.resolve(harborTurn)` is `null`.
- (a) Juniper, the refused business, kept its scope: `resolve(juniperTurn)` is still the scope bound
  to Juniper's admission `agent_admission_d5f1…`.
- (b) The person switches back to Juniper, and the next flush exports Juniper's queued
  `$ai_generation` and `$ai_trace`. These are events of a business the service had just refused.
  Because the scope is still bound, later events of Juniper's already-admitted runs would be
  projected and exported the same way. That follows from (a) and was not run separately.

**Cause.** The gate picks the business before it asks the service (`agent-gate.ts:84`, awaited at
`:87`). The repair's `.catch` runs after that await and asks `refused` to pick the business again
(`scopes.ts:145`, via `runtime.ts:80`). For a project no business owns, both picks read the active
workspace, and `switchTo` takes no lock and does no reload (`server/workspaces.ts:633-656`). So the
two picks can differ. Projects created with `POST /api/projects` are not owned: `projectOwner` is set
only when a project is bound as a business's work target (`server/workspaces.ts:1126-1135`).

**Effect.** This is F-2's effect again, a revoked business's events leaving, through a narrower
trigger: a workspace switch during the admission round trip. The wrong business's queued telemetry
is also dropped. Nothing leaks across businesses: each event still carries its own bound scope.

**Fix direction.** Decide the business once, before the await, and pass it to `refused`. For
example, compute the gate's `organizationFor(input.projectId)` in `admitModelApi` before
`await this.admitAgent(...)`, or have the gate's refusal carry the organization it asked about.
`R2` is the gate.

### N-2 (P3): an outage on one admission ends the business's telemetry

**What was run.** `R1`, for three kinds of failure: a network error, 503 and 500.

1. An internal Juniper turn is admitted and queued (2 events).
2. The next admission alone meets the failure. The grant stays active throughout.
3. The turn is refused with 403.
4. The service recovers, and the queue is flushed.

**What came back.** In all three modes: `exported: 0`, `dropped: {"scope-ended": 2}` and
`denied: {"admission-refused": 2}`. The next turn after recovery is observed, under a fresh scope.

**Cause.** The `.catch` at `service.ts:1970-1977` calls `refused` for every rejection from
`admitAgent`. The session maps an unreachable service or a 5xx to `entitlement_unknown`
(`session.ts:490-496`). The three modes tested are network error, 503 and 500. A timeout takes the
same path: the client turns any fetch failure into an unreachable error (`server/accounts/client.ts:83-92`).
That was read, not tested. The gate throws every non-sign-in refusal as `AGENT_NOT_INCLUDED`
(`agent-gate.ts:105`). So `service.ts` cannot tell an outage from a revocation.

**Against the contract.** Section 3 ends export on a *revocation* at the next admission. Section
4.6 lists the transitions that end a scope, and an unreachable account service is not one of them.
This fails closed, so nothing private leaves. But it is telemetry loss that the contract does not
call for:

- One blip on any admission ends every scope of the business, including a running loop's. A loop
  delegate admits on its own (`server/engines/service.ts:2317`), so one failed delegate admission
  should end the whole loop's trace. That follows from the code and was not run.
- Health reports it as a refusal (observed in `R1`).

**Fix direction.** Carry the admission's code on the gate's error. `agent-gate.ts` is outside the
builder's claim, so this needs a claim. Then end scopes only for definitive refusals:
`entitlement_revoked`, `entitlement_expired`, `agent_not_included` and `not_a_member`. Count an
outage as `account-service-unavailable` without ending scopes. Or record in the contract that
failing closed on an outage is intended. That is Andrew's call.

### N-3 (P3, predates the repair): sign-out and workspace ends are not sticky

**What was run.** `S1`:

1. An internal Juniper turn is admitted and queued.
2. (a) The person switches to Harbor and back to Juniper. (b) Separately: the person signs out and
   signs in again as the same person.
3. Nothing is flushed in between. Then the queue is flushed.

**What came back.** Both queued events leave in each case: `{"workspace A→B→A": 2, "sign-out,
sign-in": 2}`.

**Cause.** `recheckScope` compares the present with the bind time (`eligibility.ts:280-282`). An
end lasts only while its condition does. The repair made a *refusal* sticky, with a per-business
counter, but not these transitions.

**Contract.** The two sections disagree:

- Section 3 describes the recheck as "same person, same active workspace as at bind", which the
  code implements.
- Section 4.6 says sign-out and "an active-workspace change since bind" end the scope, and open
  question 4 recommends that a switch "end optional export".

**Effect.** It is bounded by the flush interval: 10 s, or sooner at 50 queued events. It
re-exposes only the same person's own admitted work, and nothing is relabelled. It is also what
lets N-1's refused business come back live.

**Decide.** Either make the first failed recheck final, as the refusal counter already is, or
record in the contract that these ends are point in time.

## Also verified in this round

- **Invariants from round 1, re-run unchanged** (`tests/ph07-review.test.ts`, 17 of 17 passed):
  - No export with the setting off: `G1` covers 20 environment variants.
  - Free, Personal, no-plan, direct-engine and host-test work send nothing: `A1`, and the
    candidate's runtime tests.
  - The actual POST bytes carry no planted value, in any of six encodings: `C1`, `H1`.
  - A throwing, hanging, 429 or 500 PostHog leaves the answer, approval, Need, file, History, run
    events, ledger holds and provider calls identical to export off: `D1`.
  - Spoofed headers and body fields grant no eligibility: `B1`.
  - Restart, workspace switch and revocation: `A2`, `A3`, `A4`.
  - Accounting honesty: `E1`, `E2`.
  - Bounds: `F1` to `F4`.
  - The durable `errorCode`: `I1`.
- **The candidate's own six observability files:** 82 of 82 passed.
- **Refusals that must not end anything:**
  - A refusal after admission (a zero spend limit) leaves the earlier turn exported and records no
    `admission-refused` (`R6`).
  - Personal work, where no business is resolved, ends nothing. The candidate's eligibility test
    shows this, and it passed here. A project no business owns does end scopes: it falls back to the
    active business, as the gate does, and N-1 is the case where the two picks differ.
- **What the person sees:** the `.catch` rethrows the same error object. `R4` shows the HTTP status,
  the exact body bytes, the lineage run's events, step states and attempts, and the provider call
  count equal with observation off, on, and on with a throwing `refused`. The throwing `refused` was
  reached.

## Read, not tested

- **A batch already sent when the refusal arrives.** If the send succeeds, the batch counts as
  exported (`exporter.ts:423-428`). It was on the wire before the refusal, so this is accepted.
  `R3` covers the retry path, which drops the refused business's events.
- **Concurrent admissions.** Two concurrent admissions for the same business are ordered by when each
  answer reaches the host, not by when the service decided. An admission granted just before a
  revocation and answered just after a refusal binds a live scope. This is inherent to the pull model
  and was not tested.
- **`cap_request_required`.** It exists only in the managed funding path
  (`services/control-plane/src/funding.ts:356`). The gate at this candidate cannot raise it, so it
  cannot reach `refused`.

## What may merge, be used internally, or be activated

- **Merge disabled:** no new objection. With observation off, no scope, projector or exporter is
  constructed. Merging is Andrew's call under the existing approvals. PH-01 and PH-02 are not DONE
  under AGENTS.md until the accepted code is on main.
- **Internal `memory` mode on a declared company host:** safe to use.
- **Internal `posthog` mode:** needs N-1 fixed, plus round 1's preconditions:
  - the funded pilot verified;
  - the vendor record moved from `accountState: 'unverified'`;
  - credentials in operator configuration only.
- **Customer activation:** nothing, as in round 1. D1 and D5 do not exist. N-1 must be fixed, and
  N-2 and N-3 decided.

## Commands and counts

Every tsc and vitest run held the heavy slot, one at a time, and released it after the run. Three
requests were refused while the bot-mode lane held the slot, and they waited for a later grant.

```
git diff a3f7a3c d18f64c -- tests/ph07-review.test.ts                          (no output, 0 bytes)
git diff a3f7a3c d18f64c -- docs/implementation/2026-09-25-posthog-ph07-review.md  (no output, 0 bytes)

npx tsc --noEmit -p .                                          (slot slot_muhm5i86_fe46e163)
  exit 0

npx vitest run tests/ph07-round2-review.test.ts --maxWorkers=2 (slot slot_muhm6ctr_23db6335)
  1 file, 13 tests: 9 passed, 4 failed
  R1, R2, S1 failed as reproducers. R4 failed from a defect in the test, not the candidate:
  its three runs shared one faux account service, so the second revocation found no active
  grant. Each run now gets its own service.

npx vitest run tests/ph07-round2-review.test.ts tests/ph07-review.test.ts \
  tests/observability-eligibility.test.ts tests/observability-record.test.ts \
  tests/observability-exporter.test.ts tests/observability-posthog-transport.test.ts \
  tests/observability-runtime.test.ts tests/observability-first-trace.test.ts --maxWorkers=2
                                                               (slot slot_muhm7d5u_eb2befda)
  8 files, 112 tests: 109 passed, 3 failed
  ph07-round2-review 13 (10 passed; R1, R2, S1 failed), ph07-review 17, eligibility 15,
  record 24, exporter 11, posthog-transport 12, runtime 11, first-trace 9

npx vitest run tests/harness.test.ts tests/harness-host.test.ts tests/harness-negative.test.ts \
  tests/harness-provider-outcomes.test.ts tests/aws-model-adapter.test.ts tests/aws-conversation-seam.test.ts \
  tests/h01-runtime-seam.test.ts tests/verification-service.test.ts tests/customer-accounts-app.test.ts \
  tests/native-loop-host.test.ts tests/model-session-activity.test.ts tests/h16-external-model-api.test.ts \
  tests/spend-exposure.test.ts tests/b00-control-plane-contract.test.ts tests/b00-h01-repair.test.ts --maxWorkers=2
                                                               (slot slot_muhmbfgp_a398e0df)
  15 files, 274 tests passed

npx tsc --noEmit -p .                                          (slot slot_muhmcg2k_ac686ab4)
  exit 0

  R4 then gained two assertions: the refused message leaves a lineage run with its admission step,
  so R4's run comparison is not vacuous. The file was run and type-checked again:

npx vitest run tests/ph07-round2-review.test.ts --maxWorkers=2 (slot slot_muhmrf5y_f8dafc7a)
  1 file, 13 tests: 10 passed, 3 failed (R1 at :381, R2 at :431, :432, :440, S1 at :614)

npx tsc --noEmit -p .                                          (slot slot_muhms296_94062896)
  exit 0, on the committed test file
```

The full suite, Playwright, `vite build`, a dev server and Electron were not run.
