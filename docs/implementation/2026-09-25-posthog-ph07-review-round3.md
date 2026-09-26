# PostHog PH-07 round 3: review of the integrated PH-01 and PH-02

| | |
|---|---|
| Work order | PH-07 round 3, handoff NC-PH-2026-09-25.3 |
| Candidate | `f35f06e`: 7e3765c (N-1 to N-3 repairs), 62a2198 (main merge: bot mode #153, account service #152), 2acb30a (per-turn binding), c69394e (managed payer), 81612fd (GPT-6 Luna catalog) |
| Round 1 | `docs/implementation/2026-09-25-posthog-ph07-review.md`, `tests/ph07-review.test.ts` (a3f7a3c) |
| Round 2 | `docs/implementation/2026-09-25-posthog-ph07-review-round2.md`, `tests/ph07-round2-review.test.ts` (7e4f0c9) |
| Review branch | `review/posthog-ph07-round3` in `F:/Diomedes/diomedes-wt/posthog-review` |
| Reproducers | `tests/ph07-round3-review.test.ts` (15 tests), committed with this document |
| Owner | Andrew |
| Date | 2026-09-26 |

The round 3 reviewer did not write the candidate or either earlier review, and did not see any
author's conversation. Every result below was produced in this worktree at `f35f06e`. No request
reached PostHog, AWS or any other host. The account service is the faux service in process, with its
own managed gateway, and a scripted provider stands behind both that gateway and the owner's AWS
route. The PostHog origin is `https://posthog.invalid`, answered in process. No credentials were
used. The candidate's source files were not modified. Every `file:line` is at `f35f06e`.

**The earlier reproducers are unchanged.** Both commands below printed nothing:

- `git diff 7e4f0c9 f35f06e -- tests/ph07-round2-review.test.ts`
- `git diff a3f7a3c f35f06e -- tests/ph07-review.test.ts`

The blob hashes match at the review commits and at `f35f06e`: `44bf6150…` (round 2) and `82a07c93…`
(round 1).

## Verdicts

| Slice | Verdict |
|---|---|
| **PH-01**, metadata observation (678dba6 + d18f64c + 7e3765c + the merge commits) | **Accepted with named conditions.** N-1, N-2 and N-3 are fixed at their cause for what round 2 reproduced: R2, R1 and S1 pass unchanged. There are four new P3 findings and no P1 or P2. The widening in 7e3765c does not detect "unreachable" where an outage actually shows up, so an outage during a refresh now ends a running turn's export for good (R3-1). The definitive refusal set contains a code the host infers from any HTTP 403 or 404 (R3-2). A scope is compared against the workspace active at bind, not the one the gate asked about (R3-3). The 2,000-entry scope map forgets a running loop silently once 2,000 later messages have been admitted (R3-4). **Conditions:** R3-1 and R3-4 fixed or ruled before PH-04 relies on trace completeness. R3-1, R3-2 and R3-3 fixed or ruled before customer activation. None blocks internal `memory` mode. None blocks internal `posthog` mode, which still waits on round 1's preconditions. |
| **PH-02**, the `/batch/` transport, off by default | **Accepted.** Round 1's invariants pass unchanged on the merged tree (17 of 17), and hold for the `nectovia` route as well (I1 to I4). Export off constructs nothing. Personal, Free, no-plan and non-internal work send nothing, even with spoofed headers. No planted value is in the POST bytes. A PostHog that throws, answers 500 or hangs leaves the Nectovia turn, the local hold and the gateway's attempts and settlements identical to export off. |

## Round 2 conditions

| # | Status | Evidence |
|---|---|---|
| N-1 | **Fixed at cause** for refusals. The same rule is not applied to binds (R3-3). | `admitModelApi` reads `businessFor` at `server/engines/service.ts:1996-2001`, before either admission. Nothing is awaited between that read and the gate's own pick. `admitAgent` calls `gate.check` synchronously (`service.ts:2155-2170`), and the gate picks the business at `server/accounts/agent-gate.ts:84`, before its await at `:87`. The refused business is passed explicitly and used as given (`server/observability/scopes.ts:199`). Both routes share the one `.catch(refused)` (`service.ts:2015`, `:2016`). **R2 passes.** Not run separately: a switch during a *refused* Nectovia admission. That branch is the same closure. |
| N-2 | **Fixed at cause** on the admission path. Two boundaries fail: the refresh path (R3-1) and the host-inferred `not_a_member` (R3-2). | `refusalEndsObservation` (`scopes.ts:82-85`) reads the gate's `refusalCode` against `ENTITLEMENT_REFUSALS` (`:74-79`). **R1 passes**: network error, 503 and 500 end nothing. **M3 passes** and extends this to 429, a body cut off mid-read, a 200 of `{}`, a 200 that is not JSON, and a 422. In each case the earlier turn's generation and trace were exported, and `admission-refused` was 0. |
| N-3 | **Fixed at cause.** The builder's widening beyond the ruling produces R3-1. | `observeContext` runs on every settings save (`server/observability/runtime.ts:87`) and on every account projection (`server/app.ts:805-807`), at bind (`scopes.ts:154`) and at each recheck (`:242`). A change since bind ends the scope with its first reason (`:251-252`). **S1 passes.** B1 shows the other half: a switch back after bind ends the scope (`workspace-changed`, both queued events dropped). |

## New findings

| # | Severity | Reproducer (failing line) | Cause | Summary |
|---|---|---|---|---|
| R3-1 | P3 | `K1`, `tests/ph07-round3-review.test.ts:558`; `K2`, `:635` | `server/observability/scopes.ts:254-255` treats only a thrown read as unreachable. `:260` makes every other failure final. `server/accounts/session.ts:394-395` stores a failed access read as `null`. `:441-446` reports that as `state: 'unknown'`. `server/observability/eligibility.ts:284` reads `unknown` as `entitlement-inactive`. | An access read that fails during a refresh (503, 429, network error, a body cut off mid-read, or a 200 that is not JSON) ends a running turn's export for good. It is labelled `entitlement-inactive`, not `account-service-unavailable`, and the turn's events after the service recovers are dropped. A malformed `{}` makes the read throw, is classified unreachable, and survives. |
| R3-2 | P3 | `M1`, `:672` | `session.ts:502-503` maps any HTTP 403 or 404 to `not_a_member`. `scopes.ts:78` counts `not_a_member` as definitive. | A 404 from a Worker that lacks the route, or a 403 edge page, ends the business's observation. The membership and grant were intact throughout. |
| R3-3 | P3 | `B1`, `:776` | `eligibility.ts:244` sets `activeOrganizationAtBind` from the active workspace at bind (`scopes.ts:160`). Bind runs after the gate's round trip and the route checks (`service.ts:2016-2035`; Nectovia `:2133`). | A workspace switch that lands during a *successful* admission is taken as the scope's baseline. The admitted business's events then leave while the person is in the other business, and are dropped if the person comes back. |
| R3-4 | P3 | `E1`, `:1042` | `scopes.ts:176` evicts the oldest bind. Since bot mode each message binds its own scope (`service.ts:2198`). `server/observability/projector.ts:276-277` returns without counting when a run has no scope. | Once 2,000 messages have been admitted after it, a running work loop has no scope. Its later steps and its `$ai_trace` are never projected, and no denial, drop or projector stat records the loss. |

### R3-1 (P3): an outage during a refresh is final, and is not seen as one

**The brief's question.** Could "every failed recheck is final, except when the account service is
unreachable" drop a paying business's telemetry on a transient failure it misclassifies? It can, and
does.

**How "unreachable" is detected.** Only by a throw. `ObservationScopes.recheck` catches an exception
from the authority reads and calls it `account-service-unavailable` (`scopes.ts:254-255`). Any other
failure becomes final (`:260`). The authority reads are synchronous cache reads
(`runtime.ts:77-83`). A real outage does not throw. `loadAccess` catches each business's failed
read and stores `null` (`session.ts:394-395`). `entitlement()` then answers
`{ agent: false, state: 'unknown' }` (`:441-446`), and `recheckScope` reads that as
`entitlement-inactive` (`eligibility.ts:284`). That answer is made final.

**K1** (pure). One scope sees an authority that reports `unknown`. Another sees an authority that
throws. Then the service answers `active` again.

- The throwing case recovers: `account-service-unavailable`, then `{ live: true }`.
- The `unknown` case fails as `entitlement-inactive` and stays `{ live: false }`.

**K2** (integrated, `createApp`). For each failure mode:

1. An internal Juniper turn calls `list_sources`. Its second model call is held at the provider.
   Two events are queued.
2. The person presses Refresh (`POST /account/refresh`). The access read fails. The refresh itself
   answers 200.
3. The exporter flushes, as its 10 s timer would.
4. Refresh again. The service answers, and the entitlement reads `active`.
5. The held call is released. The turn completes with 200.

Observed, per mode:

| Mode | Entitlement during | Denial recorded | Exported after recovery | Dropped |
|---|---|---|---|---|
| 503 | `unknown` | `entitlement-inactive` | nothing | 4 `scope-ended` |
| 429 (`Retry-After: 1`) | `unknown` | `entitlement-inactive` | nothing | 4 |
| network error | `unknown` | `entitlement-inactive` | nothing | 4 |
| body cut off mid-read (`TimeoutError`) | `unknown` | `entitlement-inactive` | nothing | 4 |
| 200, not JSON | `unknown` | `entitlement-inactive` | nothing | 4 |
| 200, `{}` | the read throws | `account-service-unavailable` | `$ai_generation`, `$ai_trace` | 2 |

The two queued events are dropped at the flush during the outage in every mode. That follows from
the recheck rule in contract section 3, and it predates 7e3765c. The widening's own effect is the
difference between the rows: the generation and trace enqueued *after* the service recovered. They
leave only when the malformed answer happens to make the read throw.

The recheck at d18f64c (round 2's candidate) had no `ended` map, so the same scope went live again
once the refresh succeeded. That was read, not run.

**Against the contract and the ruling.**

- Contract 4.6 does not list an unreachable account service among the transitions that end a scope.
- The N-2 ruling in section 3 says an outage ends nothing.
- The builder's own N-3 sentence, which the builder added to section 3 in 7e3765c, says "only an
  inability to ask (`account-service-unavailable`) is not [final]". An unanswered access read is an
  inability to ask, but it is not classified as one.

That sentence was written into the contract by the builder in the same commit as the code. It is
the builder's rendering, not independent evidence that the architect ruled the widening.

**Privacy.** Safe. The widening only ends scopes and never makes one live, and nothing is
relabelled.

**Effect.**

- Before the widening, the loss was bounded by the next good refresh. Now every scope rechecked
  during the window stays dead for its whole life.
- A refresh happens only on sign-in, on setting a member, on redeeming a code, on creating a
  business, or when the person presses Refresh in Account settings (`client/AccountSettings.tsx:40-47`).
  Between refreshes a single failed read stands.
- Every scope bound during that window is also dropped at its first enqueue, because bind does not
  read the entitlement. That part predates the widening.
- Of the widened reasons, only `entitlement-inactive` is reachable today.
  - `no-longer-internal` and `observation-off` come from operator configuration, which is read once.
  - The telemetry-policy reasons wait on D1.
  - A future network-backed `TelemetryPolicyPort` that answers `null` on an outage would repeat this
    finding for customers.

**Fix direction.** Make `entitlement()`'s `unknown` a distinct recheck result that is not final and
counts as `account-service-unavailable`, or keep the last good answer when a read fails. Or rule
that failing closed on an unanswered read is intended. That is Andrew's call.

### R3-2 (P3): `not_a_member` is inferred from any 403 or 404

**What was run.** `M1`. An internal Juniper turn is admitted and queued. The next admission alone is
answered by one of two responses:

- a 404 with the Worker's own body for an action it does not have (`services/control-plane/src/worker.ts:225`), as during version skew;
- a 403 HTML page, as from an edge block.

**What came back.** The person sees 403, "You are not a member of this business…", in both cases.
Nothing of the earlier turn is exported, and `denied` is `{"admission-refused": 2}` in both.

**Positive control, `M2`, passes.** When the Harbor owner really withdraws the person's Harbor
membership, the next admission is refused and Harbor's observation ends.

**Cause.**

- `session.ts:502-503` turns every `ApiError` with status 403 or 404 into `not_a_member`.
- `scopes.ts:78` lists `not_a_member` as definitive.
- The service never sends that code in a decision. `commercial.ts:430` always calls
  `decideAgentAdmission` with `member: true`, and the membership refusal is a bare
  `AccountError(403)` with no code (`services/control-plane/src/account-service.ts:358`).

So the code is only ever inferred from an HTTP status.

**Against the ruling.** The ruling names `not_a_member` as definitive. It meant the service's refusal
of the business. A status the host cannot attribute is not that.

**Effect.** Fail closed. The effect is N-2's (telemetry loss on a failure that is not a refusal),
through a narrower trigger.

**Fix direction.** Have the service's membership refusal carry a code, and count only that coded
answer as definitive. Or rule that any 403 or 404 on an admission ends export.

### R3-3 (P3): the scope's workspace baseline is taken at bind, after the round trip

**What was run.** `B1`, twice.

1. One person is admin of two entitled, internal businesses.
2. The person is in Juniper, on a project no business owns, so the gate asks about the active
   business.
3. Juniper's admission is held at the account service. The person opens Harbor (200) while it is on
   the wire. The precondition passed.
4. The service admits Juniper, and the turn completes with 200.

**What came back.**

- The scope is Juniper's, with `activeOrganizationAtBind` = Harbor.
- Flushed while the person is in Harbor, Juniper's `$ai_generation` and `$ai_trace` leave.
- Flushed after the person switches back to Juniper, both are dropped as `scope-ended`, with
  `workspace-changed`.

**Cause.** The scope stores the workspace active at bind (`eligibility.ts:244`, read at
`scopes.ts:160`). Bind runs after the gate's round trip and after the route checks: on the BYO path
`modelApiRoute` and `credential.check()` (`service.ts:2017-2035`), and on the Nectovia path
`managedTier`, `refreshPolicy` and `setCap` (`:2061-2133`). A switch in that window is already
counted before bind (`scopes.ts:154`). So it becomes the baseline, not a change since bind.

**Against the contract.** The literal text is met: section 3 and 4.6 end a scope on "an
active-workspace change since bind". Its intent is not. Open question 4, accepted provisionally, says
a switch ends optional export for already-admitted work in the other business. N-1's ruling decides
the business once, before the round trip. Here the baseline is a business the gate never asked
about, and the end condition is inverted.

**Effect.** It is bounded by the admission window. The events are the same person's own admitted
work, labelled with its own business, and nothing is relabelled.

**Fix direction.** Take the baseline where `businessFor` is read, before the admission, and pass it
to `bind`. Or, for a project no business owns, deny a bind whose active business is not the
admitted one. Or rule that "since bind" is meant literally.

### R3-4 (P3): per-message scopes let the 2,000-entry map forget a running loop, silently

**What was run.** `E1`, with the production limit (no `limit` option):

1. A work loop is bound.
2. 2,000 conversation messages are bound after it. Since bot mode each message is its own scope,
   `conversation:<turnRunId>`.
3. The loop's completed run is projected.

**What came back.**

- `resolve(loop)` was a scope before the messages and `null` after them. `size` is 2,000.
- The projector emitted nothing.
- `denials()` is `{}`, and `stats()` is `{ projected: 0, failures: 0, unlinkedVerifications: 0 }`.

**Cause.**

- Eviction is by insertion order (`scopes.ts:176`). A re-bind moves the key to the end (`:170-171`),
  but a loop binds once at start and again only on resume.
- `project()` returns at `projector.ts:277` when there is no scope, and counts nothing.
- The builder's record says per-message binding "adds churn, not growth". That is true of memory.
  Churn is what evicts a long-running loop: 2,000 *messages* now evict it, where before it took
  2,000 *conversations*.

**Effect.** Telemetry completeness only. PH-04's missing-terminal metric cannot tell this loss from a
lost trace.

**What still holds after eviction** (`E2`, passes):

- A later refusal still drops the evicted scope's queued event. Its bind generation lives in a
  `WeakMap` kept alive by the queue.
- It drops only that business's event.

**Fix direction.** Keep a scope while its run is live. Or evict scopes of finished runs first. Or at
least count evictions and uncounted projections in `health()`.

## The brief's other questions

### The gate's `refusalCode` is invisible to the person, on both routes

**Static.**

- Only `server/accounts/agent-gate.ts:109` sets `refusalCode`, and only `scopes.ts:83` reads it.
- `server/automations.ts:699` and `shared/automations.ts:291` are an unrelated field of the
  automation record, filled from the automation's own `admission.code`.
- No `getOwnPropertyNames`, `Reflect.ownKeys`, `getOwnPropertyDescriptors`, `showHidden` or error
  serializer appears in `server`, `shared`, `desktop` or `services/control-plane/src`.
- Both error mappers read only `code` and `message`: `server/app.ts:5928-5932` and
  `server/engines/interaction-routes.ts:81-85`.

**Dynamic, `C1`, passes.** The live gate was wrapped. For each refusal, one send had the gate's error
as thrown, and the next had a fresh `EngineError(code, message, ambiguous)` without the field, as
before 7e3765c. The two sends were compared on the AWS thread and on the Nectovia Home thread.

| Refusal | Status | `code` in the body | Sentence |
|---|---|---|---|
| `entitlement_revoked` | 403 | `AGENT_NOT_INCLUDED` | "This business's Nectovia Agent access was withdrawn…" |
| `entitlement_expired` | 403 | `AGENT_NOT_INCLUDED` | "This business's plan has ended…" |
| `agent_not_included` | 403 | `AGENT_NOT_INCLUDED` | "The Nectovia Agent is part of a Business plan…" |
| `personal_workspace` (from the service) | 403 | `AGENT_NOT_INCLUDED` | the service's reason |
| `not_a_member` (a 403) | 403 | `AGENT_NOT_INCLUDED` | "You are not a member of this business…" |
| `entitlement_unknown` (a 503) | 403 | `AGENT_NOT_INCLUDED` | "The account service could not be reached…" |
| `sign_in_required` (a 401 twice) | 401 | `sign_in_required` | the service's message |
| Personal (the gate refuses before asking) | 403 | `AGENT_NOT_INCLUDED` | `AGENT_PERSONAL_REASON` |

- **Identical.** All 16 pairs matched in status and in body bytes.
- **Not vacuous.** The live gate attached the service's code on every service refusal, at least four
  times per code.
- **No service code reaches a body.** No body contains a service code or the field.

**Read, not tested.** The gateway's refusal at dispatch becomes a new `EngineError` with no
`refusalCode` (`service.ts:2945-2946`). A revocation first seen by the gateway therefore ends no
scope. The contract does not require it to.

### The payer

- **Where it comes from.**
  - It comes from `admission.routeKind` (`eligibility.ts:202-204`). The gate echoes the kind it was
    asked for (`agent-gate.ts:86`, `:101`), and `EngineService` asks `managed` only for
    `route === NECTOVIA_ROUTE` (`service.ts:2014-2015`).
  - A route and kind that disagree are denied (`eligibility.ts:204`).
  - The control plane records the kind on the admission (`services/control-plane/src/commercial.ts:439`).
- **Headers and body.** The candidate's `observability-managed-payer.test.ts` passes, and so do P1
  and I2.
  - Headers claiming `byo` on a Nectovia send, or `managed` on an AWS send, change nothing.
  - A body claiming a payer is refused 400 by the strict message schema.
- **A thread switched mid-turn, `P1`, passes.**
  - A Nectovia turn is held at the gateway's provider, and the thread's engine is switched to
    `aws-bedrock` (200; the switch starts a new lineage). Then the held call is released.
  - That turn's generation and trace are all `nectovia` / `managed`, under one trace. The next turn
    is all `aws-bedrock` / `byo`, under another.
  - No trace mixes routes or payers.
- **A stale admission.** Read, not tested separately. The gate always asks with `phase: 'admit'`
  (`service.ts:2163`), and the session reuses a cached decision only for `dispatch`
  (`session.ts:488`). Each message binds under its own turn run.
- **No settled cost on the managed route.**
  - `costOf` returns `unknown('cost-pending')` for managed work (`projector.ts:596`).
  - A late cost is remembered only when `!managed` (`:407`).
  - The wire writes cost keys only when the cost is known (`wire.ts:212-216`, `:270-273`).
  - `P2` passes. A managed hold that settles later emits no `nectovia_cost_reconciled`, and the
    managed generation has no `nectovia_cost_micro_usd`, `$ai_total_cost_usd` or
    `nectovia_rate_card_key`. The byo control does emit its late cost (4,321 micro-USD), so the path
    was reachable.
  - P1, I3 and the managed-payer test find no cost key on any `nectovia` event.
- **Read, not tested.**
  - A loop child with no scope of its own takes its root's (`scopes.ts:233`). Round 1 said that
    would become a payer mislabel once the managed route was wired. It is not reachable: the loop's
    pre-admission passes `rootJobId: null` (`server/app.ts:1177`), and `admitNectovia` refuses
    without a job (`service.ts:2079-2081`).
  - `vertex.funding` (`service.ts:2509-2518`) would make Vertex calls company-funded while they are
    observed as `byo` with a settled local cost. It is not wired in `app.ts`.

### Per-message scopes

- **Eviction.** R3-4.
- **Memory**, read, no leak seen:
  - refusals are kept per business;
  - `contextEnds` holds at most 256 (`scopes.ts:286`);
  - `generation` and `ended` are `WeakMap`s;
  - the projector's maps hold 2,000 each (`projector.ts:94`), and its uuid set 10,000 (`:157`).
- **A refusal ends only its own business's scopes.** R2 (round 2) and E2 pass. E2 has two businesses
  and scopes across several conversations. Only the refused business's queued event is dropped, and
  the other's leaves and stays live.

### Round 1's invariants on the merged tree

`tests/ph07-review.test.ts` passes 17 of 17, and `tests/ph07-round2-review.test.ts` 13 of 13. For
the `nectovia` route, which neither covers:

- **I1: export off.** With `observation: null`, or unset with `NECTOVIA_OBSERVATION` unset, nothing
  is constructed. `app.locals.observation` is null and `engines.observation` is unset. The Nectovia
  send answers 200 through the gateway.
- **I2: excluded work.** Nectovia sends in Personal, from the Free account, and from Harbor (entitled,
  not internal) carried spoofed `X-Nectovia-Internal`, `X-Organization-Id`, `X-Nectovia-Payer`,
  `X-Nectovia-Route-Kind` and `X-Nectovia-Plan` headers. None enqueued anything, and no scope was
  bound. Harbor was denied `faux-account-not-internal`.
- **I3: POST bytes.** The exact POST bodies of a Nectovia turn, through the real `PostHogTransport`,
  were searched in six encodings. None of these appears:
  - the prompt, the answer, the provider's response id and the command id, all planted;
  - the person's id, name and email;
  - the business's id and name;
  - the project, thread, lineage and turn-run ids;
  - the local guard's connection id;
  - the gateway's attempt ids and root job ids.

  Every key is in `WIRE_KEYS`, and every event is `managed`.
- **I4: failure isolation.** A PostHog that throws, answers 500 or hangs was compared with export off.
  Each failing transport was called, and the app closed within 5 s. Identical to export off:
  - the status and text;
  - the turn run's state, event list and step states;
  - the local hold (state, settled micro-USD, usage);
  - the gateway's funded attempts and settlements (every number and state);
  - the number of provider calls.

### Also observed, outside this review's claim

A 200 admission answer of `{}`, or one that is not JSON, gives the person a 500. `M3` recorded this.
`session.ts:510` reads `answer.decision` outside the `try` at `:490-508`, so the `TypeError` escapes.
It predates this work. For observation it is not a refusal and ends nothing. It belongs to the
account-session owner.

## What may merge, be used internally, or be activated

- **Merge disabled:** no new objection. With observation off nothing is constructed (I1, round 1's
  G1). Merging is Andrew's call. PH-01 and PH-02 are not DONE under AGENTS.md until the accepted
  code is on main.
- **Internal `memory` mode on a declared company host:** safe to use.
- **Internal `posthog` mode:** round 2's blocking condition, N-1, is met. The mode still waits on
  round 1's preconditions:
  - the funded pilot verified;
  - the vendor record moved from `accountState: 'unverified'`;
  - credentials held in operator configuration only.
- **Before PH-04 relies on completeness:** R3-1 and R3-4.
- **Customer activation:** nothing, as before. D1 and D5 do not exist, and R3-1, R3-2 and R3-3 must be
  fixed or ruled first.

## Commands and counts

Every tsc and vitest run held the heavy slot, one at a time, and released it straight after. Every
request for the slot was granted on the first try.

```
git diff 7e4f0c9 f35f06e -- tests/ph07-round2-review.test.ts    (no output)
git diff a3f7a3c f35f06e -- tests/ph07-review.test.ts           (no output)
git rev-parse <commit>:<file>   round 2 44bf6150… at 7e4f0c9, 0759d65, f35f06e
                                round 1 82a07c93… at a3f7a3c, a94b83b, f35f06e

npx tsc --noEmit -p .                                           (slot slot_muhyyzj3_3c258d7b)
  exit 2: two type errors in the new test file (a literal-typed model variable; the faux
  service's method is setMembership, not setMember). Fixed.

npx vitest run tests/ph07-round3-review.test.ts --maxWorkers=2 (slot slot_muhz02c9_771551b2)
  1 file, 15 tests: 9 passed, 6 failed. Five were the reproducers. P1 failed from a defect in the
  test: switching the thread's engine starts a new lineage, so the turn was looked up in the wrong
  one. P1 now searches every lineage. B1 was then made to run both halves (flush in Harbor, flush
  back in Juniper), and M3, C1 and P1 print what they observed.

npx vitest run tests/ph07-round3-review.test.ts --maxWorkers=2 (slot slot_muhz254k_28d403e3)
  1 file, 15 tests: 10 passed, 5 failed
  K1 :558, K2 :635, M1 :672, B1 :776, E1 :1042

npx tsc --noEmit -p .                                           (slot slot_muhz3gp6_63e05da3)
  exit 0, on the committed test file

npx vitest run tests/ph07-review.test.ts tests/ph07-round2-review.test.ts \
  tests/ph07-round3-review.test.ts tests/observability-eligibility.test.ts \
  tests/observability-record.test.ts tests/observability-exporter.test.ts \
  tests/observability-posthog-transport.test.ts tests/observability-runtime.test.ts \
  tests/observability-first-trace.test.ts tests/observability-managed-payer.test.ts --maxWorkers=2
                                                                (slot slot_muhz45b8_05cb6a46)
  10 files, 132 tests: 127 passed, 5 failed (the same five reproducers)
  ph07-review 17, ph07-round2-review 13, ph07-round3-review 15 (10 passed), eligibility 19,
  record 24, exporter 11, posthog-transport 12, runtime 11, first-trace 9, managed-payer 1

npx vitest run tests/harness.test.ts tests/harness-host.test.ts tests/harness-negative.test.ts \
  tests/harness-provider-outcomes.test.ts tests/aws-model-adapter.test.ts tests/aws-conversation-seam.test.ts \
  tests/h01-runtime-seam.test.ts tests/verification-service.test.ts tests/customer-accounts-app.test.ts \
  tests/native-loop-host.test.ts tests/model-session-activity.test.ts tests/h16-external-model-api.test.ts \
  tests/spend-exposure.test.ts tests/b00-control-plane-contract.test.ts tests/b00-h01-repair.test.ts \
  tests/nectovia-route.test.ts tests/nectovia-bot-app.test.ts --maxWorkers=2
                                                                (slot slot_muhz52yl_43e6c2b0)
  17 files, 303 tests passed
```

Did not run: the full root suite, the control-plane suite, Playwright, `vite build`, a dev server
or Electron.
