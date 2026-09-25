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
  - the same person;
  - the same active workspace as at bind;
  - the cached entitlement still `agent && active`;
  - for internal work, the organization still internal;
  - for customer work, the policy still `metadata` with export on.

  A failure drops the scope's queued events as `scope-ended`. Nothing is relabelled.

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
| `server/engines/service.ts` | The scope-bind lines only: the import, the `observation?` field, `const admitted =`, and a try-wrapped `bind` before `return` |
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
- **Surface is not route.** `admitModelApi` does not take a route kind today (its `agent`
  parameter is `Pick<AgentWork, 'surface' | 'rootJobId'>`), so every admission is `byo`. A
  `nectovia` bind is refused `route-kind-not-observable` until the managed lane passes
  `routeKind: 'managed'` at its call sites. That is a one-line change in `service.ts` outside the
  scope-bind lines, so it was not made here.
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
- A full loop through `createApp` on a model-API route. The existing loop host tests use the
  fixture route or replace `loopModelRoutes`, and neither reaches `admitModelApi`. The loop
  mapping (generations, tool spans, the delegate child, verification, restart and dedupe) is
  proven in `tests/observability-record.test.ts` over hand-built run records through the real
  projector.
