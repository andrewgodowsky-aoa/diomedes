# PostHog PH-07: independent review of PH-01 and PH-02

| | |
|---|---|
| Work order | PH-07, handoff NC-PH-2026-09-25.3 |
| Candidate | `feature/posthog-observation` at 8d730d4: dc397c1 (PH-00 contract), 678dba6 (PH-01), 8d730d4 (PH-02) |
| Base | origin/main 844cf0c, plus feature/bot-mode 67c98ce (gateway contract, context only) and 5aadddb (the Agent gate returns the admitted decision) |
| Review branch | `review/posthog-ph01-ph02` in `F:/Diomedes/diomedes-wt/posthog-review` |
| Reproducers | `tests/ph07-review.test.ts` (17 tests), committed with this document |
| Owner | Andrew |
| Date | 2026-09-25 |

The reviewer did not write the candidate and did not see its author's conversation. Every result
below was reproduced in this worktree. No request reached PostHog, AWS or any other host: the
PostHog origin used is `https://posthog.invalid`, and every request to it was answered in process. No
credentials were used. The candidate's source files were not modified.

## Verdicts

| Slice | Verdict |
|---|---|
| **PH-01**, metadata observation, offline (678dba6) | **Accepted with named conditions.** Its goal holds under test: one observation path that collects nothing from excluded work and does not change execution. Conditions: fix F-1 before PH-02 is re-reviewed, and F-2 before any activation. |
| **PH-02**, the `/batch/` transport, off by default (8d730d4) | **Rejected.** Its deliverable is the first complete internal trace through the real runtime: model, registered tool and verification. When that trace is run, the registered tool leaves mislabelled (F-1, P1). The transport, gates and failure isolation passed, so the re-review can be narrow: F-1 fixed and `H1` green. |

The P1 root cause (F-1) is in PH-01's projector. It is counted against PH-02 because PH-02 claims the
linked trace, and PH-01's own goal (exclusion, spoofing, privacy and isolation) passed. The fix is
one condition in `server/observability/projector.ts`.

## Findings

| # | Severity | Reproducer (failing line) | Candidate source | Summary |
|---|---|---|---|---|
| F-1 | **P1** | `H1 an internal loop on AWS through createApp…`, `tests/ph07-review.test.ts:1288` | `server/observability/projector.ts:350`, `:358-359` | Every registered tool step leaves as `scripted-step`, and its tool name is lost |
| F-2 | **P2** | `A4 a revocation the host learns only from a refused admission…`, `tests/ph07-review.test.ts:513` | `server/engines/service.ts:1970`; `server/observability/scopes.ts:114-115`; `server/observability/eligibility.ts:268-269`; `server/accounts/session.ts:498-501` | A revoked business's queued events still leave after the service refuses its next admission |
| F-3 | P3 | `F1 an event older than the one-hour queue age…`, `tests/ph07-review.test.ts:998` | `server/observability/exporter.ts:380-381`, `:485-493` | A batch waiting for a retry is sent after the one-hour age limit |
| F-4 | P3 | `F2 the queue never holds more than its event cap…`, `tests/ph07-review.test.ts:1017` | `server/observability/exporter.ts:254`, `:311` | The event cap ignores the batch waiting for a retry: 150 events held under a cap of 100 |
| F-5 | P3 | `G2 a funded-until date that is not a calendar date…`, `tests/ph07-review.test.ts:1167` | `server/observability/eligibility.ts:84`; `server/observability/exporter.ts:352` | `NECTOVIA_OBSERVATION_FUNDED_UNTIL=2099-02-30` counts as funded and exports |
| F-6 | P3 | `H1…`, the soft check at `tests/ph07-review.test.ts:1274` | `server/observability/projector.ts:249-252` | The verification span sends `declared: 2` with `passed: 3` |
| F-7 | P3 | none; read in the source | `server/observability/projector.ts:402` | `model:plan` leaves as `nectovia_step: 'model'`. The contract (2.2) and `shared/observability.ts` name `'model-plan'` |

### F-1 (P1): a registered tool is observed as a scripted step

**What was run.** `H1` runs a Diomedes loop on `aws-bedrock` through `createApp`, for the internal
owner, with a scripted AWS transport. The script is: plan text, then a `read_project_file` function
call, then a final answer. Two acceptance checks are declared. The loop completes, and its outcome
is `verified`.

**What came back.** The run record holds one tool step, `tool:0` `read_project_file`, `succeeded`.
Its span left as follows:

```
- "$ai_span_name": "read_project_file",
+ "$ai_span_name": "scripted-step",
- "nectovia_span_kind": "tool",
+ "nectovia_span_kind": "scripted-step",
```

**Cause.** `projector.ts:350` treats any step whose `origin.mode === 'application'` as a scripted
adapter step. But every host tool dispatch records `origin: applicationOrigin()`:
`server/harness/native-loop.ts:1083` for loop tools, and `server/harness/native-agent.ts:371` for
conversation and team tools.

The contract's rule (4.4) was meant for the model steps of scripted adapters (`native-agent.ts:257`).
The candidate's record test builds tool steps without an `origin`, so it never met this path.
`observability-first-trace.test.ts` proves one conversation turn with no tool.

**Effect.** No tool span in any real Agent flow names its tool or says it is a tool. Nothing leaks
and nothing in the run changes. But the milestone PH-02 claims, "one correctly observed internal
synthetic run", is not met.

**Fix direction.** Decide "scripted" for model steps only: `kind === 'model'` and either an
application origin or `isScriptedAdapter`. Keep host tool steps as `tool`. Then `H1` is the gate.

### F-2 (P2): a refused admission does not end the earlier scope

**Contract section 3** says a revocation ends optional export "at the next reload or the next
admission, whichever comes first."

**What was run.** `A4` queues an internal Juniper turn. It revokes the grant through the faux Billing
API, then sends the next message. The service refuses it with 403. There is no `/account/refresh`.

**What came back.** The first turn's `$ai_generation` and `$ai_trace` were both exported (the diff
is in the test output).

**Cause.** `AccountAgentGate.check` throws on the refusal, inside `admitAgent` at
`service.ts:1970`. So `ObservationScopes.bind` is never reached, and the "a later admission that is
refused ends the earlier scope" branch at `scopes.ts:114-115` never runs for a refusal from the
account service.

The recheck at `eligibility.ts:268-269` reads `AccountSessionService.entitlement()`, the cached
access. The refusal path at `session.ts:498-501` clears only the admission cache.

**Effect.** Every later event of an already admitted run is also exported until the next reload.
Internal-only operation limits this to the company's own business. It must be fixed before customer
activation.

**Fix direction.** Call `bind` or `scopes.end` from `admitModelApi`'s refusal path as well. Or have
the refused decision invalidate the cached entitlement for that business.

### F-3 to F-7 (P3)

- **F-3.** `expire()` walks only the head of the queue (`exporter.ts:485-493`). A failed batch held
  in `inflight` is re-sent without an age check (`:380-381`).
  - `F1` enqueues at 0 s and fails the send at 59:59. The retry at 60:01 is still sent.
  - The overrun is bounded: at most three sends, a backoff of 30 s at most, a `Retry-After` of 60 s
    at most, and one 5-minute pause.
- **F-4.** The cap at `exporter.ts:254` counts `this.queue` only, while `health().queued` adds the
  waiting batch (`:311`).
  - `F2` holds 150 events under `queueEvents: 100`.
  - The excess is at most one batch: 50 events and 256 KiB.
- **F-5.** `Date.parse('2099-02-30T00:00:00Z')` is finite in this Node, and rolls over to 2 March.
  So the parser at `eligibility.ts:84` accepts the date, contrary to its own rule at
  `eligibility.ts:89` ("Anything malformed reads as absent").
  - This is operator configuration only. A date typed in error still funds export for up to three
    days past the month's real end.
  - Round-tripping the date through `toISOString().slice(0, 10)` would refuse it.
- **F-6.** `declared` is `verification.declaredChecks`, but `passed`, `failed` and `incomplete` count
  every check the verifier ran, including its own.
  - In `H1` the tallies are `declared: 2`, `passed: 3`, and the History sentence says "3 of 3
    passed".
  - A PH-04 pass rate built on `passed / declared` would exceed 100 %.
  - Fix before PH-04.
- **F-7.** A plan call cannot be told from an act turn except by its order. Fix before PH-04.

## Verified as passing

Each item below was reproduced by a test that passed in this worktree.

**Exclusion and identity (priority 1)**

- `A1`: the same internal owner, in the same business workspace and thread, works on a direct engine
  (the scripted Claude Code adapter).
  - Before that, the owner's AWS turn is observed.
  - After it, a Claude Code conversation turn (200) and a Claude Code Work turn send nothing: the Work
    run is `engine-text-turn`, `completed`, with an open proposal Need. The uuid set is unchanged, and
    `enqueued` equals the AWS turn's events.
  - This control is listed in the contract (5.3) but was absent from the candidate's tests.
- `A2`: a restart on the same data folder sends nothing at startup and nothing at sign-in.
  - The next turn in the same conversation sends only itself: its uuids are disjoint from before the
    restart, it has a new admission id, no timestamp is before the restart, and the `$ai_session_id`
    is the same.
- `A3`: one person belongs to two entitled businesses, and only Juniper is internal.
  - Switching to Harbor drops Juniper's queued events (`scope-ended`).
  - Harbor's admitted turn sends nothing (`faux-account-not-internal`).
  - Switching back resurrects nothing: `exported` stays 0.
- The candidate's `observability-runtime.test.ts` also passed: Free, no plan, Personal, the host-test
  branch, `accounts: null`, sign-out, another person, and a withdrawn grant followed by a reload.

**Spoofing (priority 2)**

- `B1`: spoofed values do not make a turn eligible. They were sent as body fields (`internal`,
  `plan`, `planId`, `organizationId`, `tenantId`, `class`, `routeKind`, `payer`, `companyHost`) and
  as headers (`X-Nectovia-Internal`, `X-Organization-Id`, `X-Nectovia-Plan`, `X-Tenant-Id`).
  - A paying business that is not internal is admitted for the Agent (200) and sends nothing.
  - Free with the same spoofs gets 403 and sends nothing.
  - Setting `NECTOVIA_OBSERVATION_INTERNAL_ORGS` to Harbor after startup changes nothing. It is read
    once.
  - `enqueued` is 0 and no scope is bound.

**Outgoing bytes (priority 3)**

- `C1` reads the exact bytes of each POST body, `api_key` included, sent through the real
  `PostHogTransport`. It checks every canary in raw, lower-case, base64, hex, `encodeURIComponent`
  and JSON-escaped form. Canaries were planted in:
  - the prompt and the answer;
  - `read_source` arguments, including a nested object, a URL and a Windows path;
  - the failed tool's error;
  - an unregistered tool name and its arguments;
  - a provider 500 body, with both its `message` and its `code`;
  - the project name, the business name and id, and the person's name, id and email;
  - the thread and lineage ids, the connection id, rate-card versions, hold ids, provider request
    ids, the AWS account id and the API key.

  None appears. Every key is in `WIRE_KEYS` for its event, every value is a flat primitive, and every
  event has exactly `event`, `properties`, `timestamp` and `uuid`.
- `H1` makes the same check for the loop's goal, file body, project, task and run ids.

**Failure isolation (priority 4)**

- `D1` compares each failing mode against an observation-off baseline. The modes, all run with the
  real transport and its periodic flush on:
  - export that throws;
  - a socket that hangs and ignores its abort;
  - 429 with `Retry-After`;
  - 500;
  - a one-event queue;
  - a daily budget of one event.
- Each run makes a conversation turn and a model-API Work turn, and approves the Work proposal,
  which writes a file.
- These are equal to the baseline in every mode:
  - the HTTP status and answer text;
  - the turn run's and the Work run's state, event list and step states;
  - the approval's status and the Need's state;
  - the written file's bytes;
  - the History kinds;
  - the ledger holds (state, settled micro-USD, usage);
  - the number of provider calls.
- Each failing mode was really exercised: the transport was called, and `lastFailure` was `network`,
  `timeout`, `http-429` or `http-5xx`, with `exported` 0.
- Closing the app with a hung socket finished within the baseline time plus 3 s.

**Accounting honesty (priority 5)**

- `E1`: a completed AWS answer with no usage parks.
  - Its generation is `uncertain` and `unknown-outcome`, with no token, cost or reasoning property.
    Nothing is written as zero.
  - Reconciling the hold (4,321 micro-USD, owner entry) emits exactly one
    `nectovia_cost_reconciled`, joined on the generation's `$ai_span_id` and trace. There is still
    one `$ai_generation` for that span.
  - Resending a completed command adds no event.
- `E2`: a retried tool step gives two spans, with distinct span ids and uuids. Saving the same run
  twice sends nothing twice.

**Bounds (priority 6)**

- `F3`: 5,000 events arrive at a hung sink. `enqueue` never throws, and averages under 2 ms. The queue
  stays within 1,000 events plus one batch and within 8 MiB. At least 3,950 events drop as
  `queue-full`, and `flush` returns by its deadline. No body carries a health or drop word, and no
  event name outside the five allowed.
- `F4`: the daily budget counts a batch once, at its first send, and not again for its retry.
- The candidate's transport tests cover the backoff, the three-send cap, a 4xx and a long
  `Retry-After`, the circuit, the byte cap and batch split, and funding. They passed here.

**Default off (priority 7), through the environment path production uses**

- `G1`: the positive control has all nine variables set and exports.
- Each of these 20 variants sends nothing:
  - the mode unset, or in a different case;
  - no funding date, funding that ended yesterday, or funding that is not a date;
  - no daily budget, or a budget of 0, -5 or 2.5;
  - no internal business, or a different business internal;
  - no company host, or company host spelled `true`;
  - no pseudonym key, or a short one;
  - no host, an `http` host, or a host with a path;
  - no capture key, or a key of the wrong shape.
- The only gap is F-5.

**The normal internal trace (priority 8)**

- `H1`, apart from F-1 and F-6: one `$ai_trace` for the loop, `completed`, with a latency in seconds
  and `nectovia_model_steps: 3`.
- There are three `$ai_generation` events. Each has the trace's id as trace and parent, the provider
  and model, the requested model, `settled` cost, `$ai_total_cost_usd` equal to micro-USD / 10⁶,
  100 input and 10 output tokens, `$ai_cache_reporting_exclusive: false`, `byo`,
  `internal-synthetic`, and a latency in seconds. Their outcomes are two `answered-final` and one
  `answered-tool-call`.
- The verification span has the same trace and parent, `verified`, `declared: 2`, `failed: 0` and
  `diomedes-loop`.

**The durable `errorCode` (priority 9)**

- `I1`: the new attribute is written on `step.reconcile_required`.
- Every stored run is then rewritten without it, and the app is restarted. The run loads,
  `reconcile_required`, with no `errorCode`. Projecting it neither throws nor emits, and the
  conversation continues with an observed turn.
- The event schema is `attributes: z.record(z.string(), z.json())` at 844cf0c and at 8d730d4
  (`server/harness/host.ts:232`). A build from before the change also reads the new attribute.

**Also run:** the candidate's six observability files (79 tests), 15 touched existing suites (274
tests) and `npx tsc --noEmit`. All passed.

## Read, not tested

These are recorded, not findings:

- **OpenRouter models.** `reportedModel` for `openrouter` sends any `vendor/model`-shaped value the
  provider reports (`sanitize.ts:95`), which contract 4.3 permits.
  - AWS requested models are catalog-only (`aws-bedrock.ts:117`), and Azure is never sent.
  - Revisit before customer activation if OpenRouter can report a customer-chosen name.
- **Loop children.** A child whose own bind is refused falls back to its loop root's scope
  (`scopes.ts:149`).
  - Today the only refusal that can differ between a root and its child is route kind, and
    `nectovia` is not a `ModelApiRoute`. So this is latent.
  - It becomes a payer mislabel when the managed route is wired.
- **Team scopes.** Team scope keys (`team:<requestId>`) are not project-qualified. The request id is
  server-generated (`identifier('R')`), so no collision was found.
- **Per-process state.** The daily budget and the health counters live in one process. A restart
  resets the budget, which the contract acknowledges; the fleet-wide bound is the company collector
  (D5).
- **No trace for parked runs.** A run parked by a failed model call sends
  `nectovia_run_parked`, not `$ai_trace`, as contract 4.5 states. The missing-terminal metric must
  count parked runs.

## What may merge, be used internally, or be activated

- **Merge disabled: yes, on the review's evidence, once F-1 is fixed.** With observation off, no
  runtime is constructed. `G1` covers the environment path, and the source guard shows production
  entries pass no option.
  - `D1`'s baseline equality shows export has no effect on execution even when on and failing.
  - The durable change is additive and readable by older builds.
  - Merging is Andrew's call under the existing approvals. PH-01 and PH-02 are not DONE under
    AGENTS.md until the accepted code is on main.
- **Internal use:**
  - `memory` mode for internal synthetic runs on a declared company host is safe now, apart from the
    F-1 data defect.
  - `posthog` mode for the internal business waits for all of the following:
    - F-1 fixed and `H1` green;
    - the funded pilot verified: award dates, the exact product, the budget, and the vendor record
      moved from `accountState: 'unverified'`;
    - company credentials held in operator configuration only.

    F-2 should be fixed first as well.
- **Customer activation: nothing.** There is no customer telemetry policy (D1), no company collector
  (D5) and no customer export path in production: `customerExport` is never read from the
  environment. F-2 also has to be fixed.

## Rollback

Leave `NECTOVIA_OBSERVATION` unset (the default), or revert the three candidate commits. No
canonical run, audit or ledger record is deleted or rewritten. Runs written in the meantime keep
the additive `errorCode` attribute, which older builds read.

## Commands and counts

The heavy slot was taken for every vitest run and released after each. The first request was
refused while another lane held the slot, and a later request was granted.

```
npm ci --no-audit --no-fund                                   (root; slot slot_muhjzs39_bec1b4e9)
npm ci --no-audit --no-fund                                   (services/control-plane)
npx vitest run tests/observability-eligibility.test.ts tests/observability-record.test.ts \
  tests/observability-exporter.test.ts tests/observability-posthog-transport.test.ts \
  tests/observability-runtime.test.ts tests/observability-first-trace.test.ts --maxWorkers=2
  6 files, 79 tests passed
npx vitest run tests/harness.test.ts tests/harness-host.test.ts tests/harness-negative.test.ts \
  tests/harness-provider-outcomes.test.ts tests/aws-model-adapter.test.ts tests/aws-conversation-seam.test.ts \
  tests/h01-runtime-seam.test.ts tests/verification-service.test.ts tests/customer-accounts-app.test.ts \
  tests/native-loop-host.test.ts tests/model-session-activity.test.ts tests/h16-external-model-api.test.ts \
  tests/spend-exposure.test.ts tests/b00-control-plane-contract.test.ts tests/b00-h01-repair.test.ts --maxWorkers=2
  15 files, 274 tests passed
npx tsc --noEmit                                              (no slot) exit 0, before and after the reproducers
npx vitest run tests/ph07-review.test.ts tests/observability-eligibility.test.ts tests/observability-record.test.ts \
  tests/observability-exporter.test.ts tests/observability-posthog-transport.test.ts \
  tests/observability-runtime.test.ts tests/observability-first-trace.test.ts --maxWorkers=2
                                                              (slot slot_muhkgzsf_b72c8927)
  7 files, 96 tests: 91 passed, 5 failed
  the 5 failures are the reproducers A4 (F-2), F1 (F-3), F2 (F-4), G2 (F-5) and H1 (F-1, F-6)
  the candidate's 79 tests all passed
```

The full suite, Playwright, `vite build`, a dev server and Electron were not run, as the brief
directs.
