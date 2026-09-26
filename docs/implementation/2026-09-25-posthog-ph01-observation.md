# PostHog PH-01: the observation record, offline

Work order PH-01, built on the PH-00 contract
(`docs/implementation/2026-09-25-posthog-ph00-contract.md`) and the coordinator's adjustments of
2026-09-25. Branch `feature/posthog-observation`, worktree
`F:/Diomedes/diomedes-wt/posthog-observation`. Nothing here sends anything anywhere: the only
sink is in memory, and observation is off unless an operator turns it on.

## What it does

Admitted Nectovia Agent work on a model-API route can now be observed as metadata only. Each
observed run produces PostHog-shaped events (`$ai_trace`, `$ai_generation`, `$ai_span`,
`nectovia_run_parked`) in a bounded queue whose batches a memory sink records byte for byte.

- **Where it starts.** Only `EngineService.admitModelApi`, after every check has passed, calls
  `ObservationScopes.bind`. It passes the admitted decision the account service returned and the
  job id the caller already gives the Agent gate. A scope forms only when:
  - the admission exists;
  - the route is observable;
  - the route kind matches: managed ↔ `nectovia`, byo ↔ the four connection routes;
  - the account service is reachable;
  - a pseudonym key is configured;
  - and one of two holds:
    - the organization is on the operator's internal list, on a declared company host;
    - or it is a customer with a metadata telemetry policy and customer export on. Neither exists
      in production, so every customer is refused `telemetry-policy-absent`.
- **Where it ends on a refusal.** When the Agent gate refuses an admission because the business is
  not entitled, `admitModelApi` calls `ObservationScopes.refused` with the business the gate asked
  about (read before the round trip) and rethrows the same error. Every scope of that business
  ends. An outage ends nothing (PH-07 F-2, N-1, N-2; see the repair sections below).
- **What it reads.** The run record the RunService has just committed, received in `files.saved`
  and projected synchronously, plus the local spend ledger's in-memory holds. A projector failure
  is caught twice, inside the projector and in the host.
- **What leaves.** Only counts, digests, company-issued ids, and values from closed sets. The
  organization is `oorg_` plus a keyed HMAC, rate cards are `rc_` plus a keyed digest, and run,
  step and session ids are contract-scoped digests. The wire builder constructs each event from
  named fields. A final guard refuses any key outside the event's allowlist and any string that is
  not identifier-shaped.
- **Rechecks.** Every event's scope is checked again at enqueue and immediately before its batch
  is sent. The check is:
  - no refused admission for the business since the scope was bound;
  - the same person;
  - the same active workspace as at bind;
  - the cached entitlement still `agent && active`;
  - for internal work, the organization still internal;
  - for customer work, the policy still `metadata` with export on.

  A failure drops the scope's queued events as `scope-ended`. Nothing is relabelled. Since PH-07
  round 2 an end is final: a sign-out, another person or another business seen at any moment since
  bind ends the scope even if it is undone before the next flush (N-3).

## Files

New:

| File | Contents |
|---|---|
| `shared/observability.ts` | The record types |
| `server/observability/sanitize.ts` | Ids, pseudonyms, and the model, tool, code, plan and capability allowlists |
| `server/observability/eligibility.ts` | Operator config, the bind decision, the recheck |
| `server/observability/scopes.ts` | `bind` and `resolve` |
| `server/observability/projector.ts` | Run record to observations |
| `server/observability/wire.ts` | The PostHog shape and the guard |
| `server/observability/exporter.ts` | Port, Noop, the bounded queue, the memory sink |
| `server/observability/runtime.ts` | The one constructor the app calls |

Minimal edits:

| File | Edit |
|---|---|
| `server/engines/service.ts` | The scope-bind lines only: the import, the `observation?` field, `const admitted =` (since PH-07 with a `.catch` that calls `refused` and rethrows), and a try-wrapped `bind` before `return` |
| `server/harness/host.ts` | An optional `observation` hook, called from `files.saved` inside try/catch |
| `server/harness/model-api-adapter.ts` | `exposureStepId` extracted; `attemptFor` uses it; no behaviour change |
| `server/harness/run-service.ts` | An additive `errorCode` attribute on `step.<state>` events when the thrown error's `code` is an identifier |
| `server/verification/service.ts` | An optional `observe` callback, called after `persist` and outside the store lock |
| `server/app.ts` | The `observation` option. The runtime is constructed only when accounts are on and the mode is not off. It is passed to the engines, the harness and verification, the ledger is attached once loaded, the exporter is closed on shutdown, and it is exposed as `app.locals.observation` |

## Adjustments applied

- **Gate change.** Merged from `feature/bot-mode` (5aadddb). `agent-gate.ts` and `session.ts`
  are unedited.
- **Managed route.**
  - `ScopeFacts.route` admits `nectovia`, and `payer` is `managed | byo`.
  - A managed generation carries `costState: 'gateway-pending'` and cost
    `unknown('cost-pending')`, with no `$ai_total_cost_usd`. Usage may still come from a local
    settled hold.
  - The read of `GET /managed/v1/attempts/:id` is not built.
- **Surface is not route.** When PH-01 was built, `admitModelApi` took no route kind, so every
  admission was `byo` and a `nectovia` bind was refused `route-kind-not-observable`. Since the
  main merge (2026-09-26) bot mode admits the `nectovia` route as `routeKind: 'managed'`, and
  `admitNectovia` binds it. See "Main merge and the managed payer" below.
- **Open questions.** All eight take the contract's recommended answer provisionally:
  1. operator allowlist now;
  2. D1 telemetry policy port, absent in production;
  3. the `/batch/` HTTP API with no SDK;
  4. a workspace switch ends export;
  5. customer events only through a future company collector;
  6. the vendor record is PH-02;
  7. keyed HMAC pseudonyms;
  8. the durable `errorCode`.

## Deviations from the PH-00 contract

1. **Binding key.** Scopes bind by `(admitted surface, rootJobId)`, the pair every caller
   already passes. A run resolves to its scope from its own record:

   | Run | Resolves through |
   |---|---|
   | Conversation turn | `conversationRunId` |
   | Work run | its own id |
   | Team run | `commandId` (the admission's request id) |
   | Loop root | its own id |
   | Loop delegate, worker or advisor | its own admission, else its loop root's |

   This leaves the four callers untouched. The contract had proposed a per-caller `observe`
   parameter.
2. **Loop child parents.** A loop child's steps hang from the child's own `delegate` span, and
   that span hangs from its parent run's span, not from "the delegate step span of the attempt
   whose `step.started` precedes the child's `run.created`". The parent step id a child records
   is not always the delegating tool step's id: a second-level delegate records `delegate`, and a
   team child records `team:<turn>`. The run-level parent always resolves.
3. **Requested model and ledger for inherited scopes.** A child that inherited its root's scope
   claims no requested model. Its ledger join uses the root's connection, so it is usually
   `not-linked`.
4. **One observation per attempt.** An attempt is observed once, at its first ending. A parked
   attempt that a person later cancels by reconciliation is not sent a second time.
5. **Loop stop reason.** `loopStop` is `unknown('not-reported')`. The loop's stop reason (turn
   limit, budget, worker) is not in the run record: `turn_limit` is thrown outside any step.
6. **Posthog mode in PH-01.** `posthog` mode stays off in PH-01. `memory` mode uses a memory sink
   capped at 1,000 bodies.

## Tests

All runs below were under the heavy slot `slot_muhj4sq0_2380220c`, which has been released.
Control-plane `npm ci` also ran under it. One later re-run of the pure record file (22 tests,
about 2 s), made to add two canary assertions, ran without the slot.

```
npx vitest run tests/observability-eligibility.test.ts tests/observability-record.test.ts tests/observability-exporter.test.ts --maxWorkers=2
  3 files, 47 tests passed (14 + 22 + 11)
npx vitest run tests/observability-runtime.test.ts --maxWorkers=2
  1 file, 11 tests passed
npx vitest run tests/harness.test.ts tests/harness-host.test.ts tests/harness-negative.test.ts tests/harness-provider-outcomes.test.ts tests/aws-model-adapter.test.ts tests/aws-conversation-seam.test.ts tests/h01-runtime-seam.test.ts tests/verification-service.test.ts tests/customer-accounts-app.test.ts tests/native-loop-host.test.ts tests/model-session-activity.test.ts tests/h16-external-model-api.test.ts --maxWorkers=2
  12 files, 189 tests passed
npx tsc --noEmit
  clean once services/control-plane has its node_modules
```

The integrated file drives the real `createApp` with the faux account service, the scripted AWS
transport and the memory sink.

**Positive runs.**
- An internal owner's conversation turn gives a generation and a trace, linked by trace id and
  session. Usage comes from the ledger (100 in, 10 out) and cost is settled integer micro-USD.
- A model-API Work turn gives a `text-dispatch` generation and a trace.
- A provider 500 parks the run: `nectovia_run_parked`, and a generation with an identifier error
  code.
- The customer fixture (cloud backend, fixture metadata policy, `customerExport`) gives
  `customer-agent` and `client-reported`.

**Negative controls (zero events).**
- Free.
- Harbor, which has no plan.
- The owner in Personal.
- A spoofed body carrying `internal`, `plan`, `organizationId` and `class`.
- The admission's host-test branch, driven directly: every check passes and nothing binds.
- A faux business not internal (`faux-account-not-internal`).
- A cloud customer with no policy (`telemetry-policy-absent`).
- `accounts: null`, which constructs no runtime.
- Unset options with the environment unset, which is off.

**Transitions.**
- Sign-out drops the queued events.
- A new person's events carry only their own admission.
- A workspace switch drops the queued events.
- A revoked grant plus `/account/refresh` drops the queued events, and the next message is
  refused.

**Isolation.** A throwing projector, a throwing exporter and a throwing ledger each leave the
following equal to an observation-off baseline:
- the HTTP status and answer;
- the turn run's `(type, stepId, attempt)` event list;
- the step states;
- the ledger holds.

The ledger case gives `not-linked`.

**Canaries.** The following were planted, and none appears in any batch as raw, lower-case,
base64, hex, `encodeURIComponent` or JSON-escaped text:
- the prompt;
- the provider answer;
- the proposal path;
- the project name;
- the provider 500 body;
- the API key;
- the AWS account id;
- the email;
- the person's name and id;
- the organization's name and id;
- the project and thread ids.

The record file separately checks the rate-card version, the provider request id, tool input and
output, a sub-task and a verification sentence.

**Source guard.**
- Production entries pass no `observation` option.
- Nothing under `client/` or `desktop/` imports observation or names PostHog.
- No capture-key shape appears in `server`, `shared`, `client`, `desktop` or
  `services/control-plane/src`.

## Not done here

- Late cost (`nectovia_cost_reconciled`), retries, backoff, the circuit, the daily budget, funding
  and the HTTP transport. These are PH-02.
- A full loop through `createApp` on a model-API route was not in PH-01's own tests. The PH-07
  reviewer's `H1` (`tests/ph07-review.test.ts`) now runs one on `aws-bedrock` and is part of the
  acceptance set.

## PH-07 repairs

The independent review (`docs/implementation/2026-09-25-posthog-ph07-review.md`, reproducers in
`tests/ph07-review.test.ts`, cherry-picked unchanged onto this branch) found one P1, one P2 and five
P3s. Each is repaired here; the reviewer's assertions are unchanged.

| # | What was wrong | What changed | Proven by |
|---|---|---|---|
| F-1 (P1) | `projector.ts` treated any step with an application origin as a scripted adapter step. The host records an application origin on every registered tool dispatch (`native-loop.ts:1083`, `native-agent.ts:371`), so every real tool span left as `scripted-step` with its name lost. The record test's tool steps had no origin. | Only a `kind: 'model'` step is ever scripted: its reported application origin, or the scripted adapter's id when a failed attempt reported none. A tool step is always a `tool` span under its allowlisted name. The record test's tool steps now carry the origins the host records (`applicationOrigin()`, and `supervisorOrigin()` for `delegate`). | `H1`; record: "host shapes: a registered tool with an application origin is a tool span…" and the loop scenario |
| F-2 (P2) | The Agent gate throws before `bind`, so a refusal from the account service never ended the earlier scope, and the recheck read a cached entitlement. A revoked business's queued events still left. | `admitModelApi` wraps its `admitAgent` call: on a throw it calls `observation.refused({ projectId })` in its own try/catch and rethrows the same error. `ObservationScopes.refused` resolves the business by the gate's rule (the project's owner, else the active business), deletes its scopes, and records a per-business refusal count. The recheck ends any scope bound before its business's latest refusal (`admission-refused`), so queued events and a waiting retry are dropped at the next flush (contract 4.6), later events of its runs are not projected, and a later admitted bind is live. Personal work ends nothing. | `A4`; eligibility: "a refused admission ends every scope of that business…" |
| F-3 (P3) | A batch waiting for a retry was re-sent without an age check. | `expire()` ages the waiting batch with the queue, and runs before every send in `drain`. | `F1` |
| F-4 (P3) | The event and byte caps counted the queue only, not the waiting batch. | Both caps count the waiting batch, as `health()` already did. | `F2` |
| F-5 (P3) | `2099-02-30` passed the funded-until check (JavaScript rolls it to 2 March). | `isCalendarDay` (regex, then a round trip through `toISOString`) in both the environment parser and the exporter's gate. | `G2`; eligibility: the six impossible dates |
| F-6 (P3) | `passed`, `failed` and `incomplete` counted the verifier's own `outputs-intact` check; `declared` counted only the person's. | The tallies count declared checks only, so they add up to `declared` when every declared check ran. `outputs-intact` still decides the state and rule. | `H1`'s check that the tallies add up to `declared`; record: the late verification span |
| F-7 (P3) | A loop's plan call left as `nectovia_step: 'model'`. | `model:plan` leaves as `'model-plan'`, as contract 2.2 and `shared/observability.ts` name it. | record: "the plan call of a work loop is labelled model-plan…" |

Contract 4.4's line "a scripted adapter step (`origin.mode === 'application'`) is a `scripted-step`
span" is read as applying to model steps only, as the reviewer found it was meant.

In round 1 the `service.ts` change stayed inside `admitModelApi`'s `const admitted =` line, which is
the scope-bind area; `agent-gate.ts` and `session.ts` were unedited. Round 2 changes both of the first
two (below); `session.ts` is still unedited.

**Tests after the round 1 repairs.** tsc and the first vitest run shared one heavy slot,
`slot_muhl7kbu_36d7615f`, one after the other; the second vitest run had its own,
`slot_muhl8r1e_44a69a84`. Both were released after use.

```
npx tsc --noEmit
  exit 0
npx vitest run tests/ph07-review.test.ts tests/observability-eligibility.test.ts tests/observability-record.test.ts \
  tests/observability-exporter.test.ts tests/observability-posthog-transport.test.ts \
  tests/observability-runtime.test.ts tests/observability-first-trace.test.ts --maxWorkers=2
  7 files, 99 tests passed: ph07-review 17, eligibility 15, record 24, exporter 11,
  posthog-transport 12, runtime 11, first-trace 9
npx vitest run tests/harness.test.ts tests/harness-host.test.ts tests/harness-negative.test.ts \
  tests/harness-provider-outcomes.test.ts tests/aws-model-adapter.test.ts tests/aws-conversation-seam.test.ts \
  tests/h01-runtime-seam.test.ts tests/verification-service.test.ts tests/customer-accounts-app.test.ts \
  tests/native-loop-host.test.ts tests/model-session-activity.test.ts tests/h16-external-model-api.test.ts \
  tests/spend-exposure.test.ts tests/b00-control-plane-contract.test.ts tests/b00-h01-repair.test.ts --maxWorkers=2
  15 files, 274 tests passed
```

## PH-07 round 2 repairs

The round 2 review (`docs/implementation/2026-09-25-posthog-ph07-review-round2.md`, reproducers in
`tests/ph07-round2-review.test.ts`, both cherry-picked unchanged from 7e4f0c9 and b17f5bf) accepted
PH-02 and accepted PH-01 with conditions N-1, N-2 and N-3. Each follows an **architect ruling of
2026-09-25, provisional and going to Andrew**. Contract section 3 carries the same rulings, marked
as provisional.

| # | Ruling (provisional) | What changed | Proven by |
|---|---|---|---|
| N-1 (P2) | Decide the refused business once, before the await, by the gate's own rule, and pass it to `refused`; never re-derive it afterwards. | `admitModelApi` reads `observation.businessFor(projectId)` on the line before `this.admitAgent(...)`. Nothing is awaited between them, and the gate picks its business synchronously before its own await, so both picks are made on the same turn. The `.catch` passes that business to `refused({ projectId, organizationId })`, which uses it as given (an explicit null, Personal, ends nothing). Only a direct caller that omits `organizationId`, such as the reviewer's `R3`, has it resolved at the call. | `R2`; eligibility: "a refusal ends the business passed to it, even when the active business has since changed" |
| N-2 (P3) | Export ends only on a definitive refusal; an outage (network, timeout, 5xx, `entitlement_unknown`) ends nothing. The gate's error carries the refusal code, strictly additively. | `agent-gate.ts`: the error thrown for the service's refusal gets a read-only, non-enumerable `refusalCode` (the service's code). Its class, `code`, message, `ambiguous`, HTTP status and every caller's behaviour are unchanged, and it serializes byte for byte as before. `scopes.ts` exports `ENTITLEMENT_REFUSALS` (`entitlement_revoked`, `entitlement_expired`, `agent_not_included`, `not_a_member`) and `refusalEndsObservation(error)`. `service.ts` calls `refused` only when that is true. | `R1`; `R4` (status, body bytes and runs equal with observation off, on, and on with a throwing `refused`); eligibility: the refusal-code predicate, and "the gate's refusal carries the service's code and is otherwise the same error it always threw" (same constructor, `name`, `code`, `message`, `status`, `ambiguous`, `Object.keys`, `JSON.stringify` and spread) |
| N-3 (P3) | Contract 4.6 governs: sign-out, a different person or an active-workspace change ends the scope for good, and its unsent events are dropped. Coming back, or signing in again as the same person, starts a fresh scope and never revives the old queue. | `ObservationScopes.observeContext()` samples (person, active business). Any change, even one later undone, counts. Each scope records the count at bind, and the recheck ends every scope bound before a later change, with the reason of the first change after its bind. It is called on every settings save (the store's `settings` event, through which every write of the active workspace goes), on every account projection (sign-in, sign-out, reload: `app.ts` wraps its `onProjection` handler), at bind and at every recheck. Any failed recheck is also final for its scope, except `account-service-unavailable`. Ended scopes stay in the resolve map; only a refusal deletes. So a run still resolves, and its events drop at enqueue. `app.ts` now builds observation before the account session starts, so a resumed sign-in is seen and its handler never reads an uninitialized binding. | `S1`; eligibility: "sign-out, another person or another business ends a scope for good, even once undone; the next bind is fresh" |

Naming deviation for N-2: the ruling names the new field `code`, but `EngineError` already has a
read-only `code` (`AGENT_NOT_INCLUDED` or `SIGN_IN_REQUIRED`). `app.ts:5784` and
`engines/interaction-routes.ts:81` branch on it, and it becomes the response body's `code`. Replacing
it would change the person's response, so the service's code is carried as `refusalCode`.

Round 2 edits, besides tests and docs:

| File | Edit |
|---|---|
| `server/accounts/agent-gate.ts` | The one refusal throw: build the same `EngineError`, define `refusalCode` on it, throw it |
| `server/engines/service.ts` | `admitModelApi` only: `businessFor` read before the admission, and the `.catch` calls `refused` only for `refusalEndsObservation` |
| `server/app.ts` | Observation is built before the account session starts and given the store's settings events; the projection handler calls `observeContext()` after `workspaces.project` |
| `server/observability/scopes.ts` | `businessFor`, the explicit business in `refused`, `ENTITLEMENT_REFUSALS`, `refusalEndsObservation`, the context count, and final ends in `recheck` |
| `server/observability/runtime.ts` | Subscribes `observeContext` to the settings events |

**Tests after the round 2 repairs.** Each command below had its own heavy slot, taken and released
one at a time. My eligibility file first failed one of its own new assertions: it used the literal
`'SIGN_IN_REQUIRED'` where the service's constant is `'sign_in_required'`. After that fix, the eight
files were run again.

```
npx tsc --noEmit                                                   (slot_muhun1a0_3b52dcbd)
  exit 0
npx vitest run tests/ph07-round2-review.test.ts tests/ph07-review.test.ts \
  tests/observability-eligibility.test.ts tests/observability-record.test.ts \
  tests/observability-exporter.test.ts tests/observability-posthog-transport.test.ts \
  tests/observability-runtime.test.ts tests/observability-first-trace.test.ts --maxWorkers=2
                                                                   (slot_muhuoq7y_0c78740c)
  8 files, 116 tests passed: ph07-round2-review 13, ph07-review 17, eligibility 19, record 24,
  exporter 11, posthog-transport 12, runtime 11, first-trace 9
npx vitest run tests/harness.test.ts tests/harness-host.test.ts tests/harness-negative.test.ts \
  tests/harness-provider-outcomes.test.ts tests/aws-model-adapter.test.ts tests/aws-conversation-seam.test.ts \
  tests/h01-runtime-seam.test.ts tests/verification-service.test.ts tests/customer-accounts-app.test.ts \
  tests/native-loop-host.test.ts tests/model-session-activity.test.ts tests/h16-external-model-api.test.ts \
  tests/spend-exposure.test.ts tests/b00-control-plane-contract.test.ts tests/b00-h01-repair.test.ts --maxWorkers=2
                                                                   (slot_muhupi5u_95d63000)
  15 files, 274 tests passed
npx tsc --noEmit                                                   (slot_muhuq9rv_2e92a5a1)
  exit 0, on the final tree
```

## Main merge and the managed payer (2026-09-26)

The coordinator accepted 7e3765c as the round 2 repair. It then asked for main (bot mode #153,
merge 538800f; the account service #152, d96321c) to be merged into this branch, and for the payer
to be wired from the admitted route. Everything below is a code fact at the merge, not a ruling.

**Merge, 62a2198.** Conflicts and their resolutions:

| File | Conflict | Resolution |
|---|---|---|
| `server/engines/service.ts` imports | Bot mode added `NECTOVIA_ROUTE`, `WORK_STYLE_LABELS` and gate constants; this branch added the observation imports | Kept both |
| `server/engines/service.ts` `admitModelApi` | Bot mode's `nectovia` branch (`admitNectovia(... await this.admitAgent(input, { ...agent, routeKind: 'managed' }))`) against this branch's N-1/N-2 `businessFor` and `refused` | Bot mode's gate contract and admission are unchanged. Both gate calls take the same `.catch(refused)`, the business is still read before either await, and the `byo` path keeps `const admitted` for its bind |
| `server/app.ts` options | `observation` against bot mode's `ownerRoutes` | Kept both. The keep-both left `ownerRoutes`' doc comment without its opener, which root tsc caught (TS1005), so the opener was restored |
| `server/app.ts` after the account block | The observation binding against bot mode's `agentGate`, `ownerRoutes` and `nectoviaAccount` | Kept both, observation first |
| `server/app.ts` harness options, `server/harness/host.ts` | `observation` against `nectoviaAccount` | `createHarnessHost` takes both |

The expected conflicts in `server/accounts/agent-gate.ts` and
`services/control-plane/contract/vendors.ts` did not happen: `git log 5aadddb..origin/main` is
empty for both paths, so main had not touched them since the bot-mode commit this branch already
had. `session.ts` and `spend-exposure.ts` took main's additions (`refreshPolicy`, `attemptIdFor`)
cleanly.

**Semantic conflicts, found after the textual merge.**

- **Per-message jobs, 2acb30a.** Bot mode admits each conversation message under its own job,
  `turnRunId(lineage, requestId)`, which is also the turn run's id. A turn's scope is therefore
  bound per turn, and the `model-api-turn` resolver now keys by `conversation:<run.id>`. The
  session is still the lineage (`input.conversationRunId`), and a turn without one resolves to
  nothing. The record, transport and eligibility tests bind turn ids. The eligibility test also
  proves that a second turn of the same lineage does not inherit the first turn's scope. The scope
  map is still bounded, by its existing 2,000-entry limit. Per-message binding adds churn, not
  growth.
- **GPT-6 Luna, 81612fd.** Main's ecdd072 moved the owner's AWS route to GPT-6 Luna and retired
  5.6. The observation catalog mirrors `AWS_LUNA_MODEL`, so the real model was classified
  `customer-named` and `nectovia_requested_model` was dropped from every AWS generation. Five
  tests caught it:
  - the record file's catalog-equality test;
  - the record file's catalog-pick test;
  - the record file's loop test;
  - the runtime test;
  - the PH-07 review's H1, which was not edited.

  The catalog now names GPT-6 Luna. A retired model is not listed, because nothing is sent on a
  connection saved for one.

**The payer, c69394e.** `admitNectovia` binds its scope after every admission check, with the
gate's `AdmittedAgentWork`. The payer comes only from `decideObservationEligibility`:

- `managed` when `admission.routeKind === 'managed'`, and `byo` when it is `byo`;
- a scope whose route and route kind disagree is denied `route-kind-not-observable`;
- nothing reads a header, a body field or the route name.

A managed generation keeps cost `unknown('cost-pending')`. On the wire that is
`nectovia_cost_state: 'gateway-pending'`, with no `nectovia_cost_micro_usd` and no
`$ai_total_cost_usd`.

`tests/observability-managed-payer.test.ts` drives a real Home send through `createApp`, the Agent
gate and the faux account service's own managed gateway. The only seam is the gateway's provider
transport, as in `tests/fixtures/nectovia-home.ts`. It proves:

- the `nectovia` generations and the trace carry `payer: managed` with cost pending, even though
  the request's headers claim `byo`;
- a body claiming a payer is refused 400 by the strict message schema, before anything is admitted,
  sent or observed;
- an owner AWS send in the same business, with headers claiming `managed`, stays `byo`, with its
  cost settled and no managed-gateway call;
- every event's payer matches its route.

Negative control: with the bind disabled, the file fails ("expected 0 to be greater than 0"), and
it passes again once the bind is restored.

**Gates after the merge.** Each command had its own heavy slot, taken and released one at a time.

```
npx tsc --noEmit -p .                           root              (slot_muhxq7bs_5f835c84) exit 0
npx tsc --noEmit -p .                           control plane     (slot_muhxqs1f_49202d15) exit 0
npx vitest run <2 review files + 7 observability files> --maxWorkers=2
                                                                  (slot_muhxr1ux_6aba71c3)
  5 failed | 112 passed (117): the GPT-6 Luna catalog, fixed in 81612fd
npx vitest run <the same 9 files> --maxWorkers=2                  (slot_muhxska1_6c2663ba)
  9 files, 117 tests passed: ph07-round2-review 13, ph07-review 17, eligibility 19, record 24,
  exporter 11, posthog-transport 12, runtime 11, first-trace 9, managed-payer 1
npx vitest run <the 15 touched suites + nectovia-route + nectovia-bot-app> --maxWorkers=2
                                                                  (slot_muhxtdz9_fde700db)
  17 files (customer-accounts-app is in both lists), 303 tests passed
npx vitest run --maxWorkers=4                   full root         (slot_muhxubpj_d243f87e)
  453 files passed; 7840 tests passed, 4 skipped
npx vitest run                                  full control plane (slot_muhy44zz_97e044c9)
  26 files passed, 3 skipped; 375 tests passed, 29 skipped (the Postgres integration files,
  which need a database)
npx tsc --noEmit -p .                           root              (slot_muhy6r79_8557885c) exit 0,
  on the final code tree (after 81612fd)
```
