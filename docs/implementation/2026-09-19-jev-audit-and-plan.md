# JEV-00: audit and implementation plan

- **Date:** 2026-09-19
- **Branch:** `feature/jev-evaluation-20260919`
- **Status:** built and gated. Nothing published, released, deployed or spent.
- **Acceptance record:** `docs/product/evaluation/ACCEPTANCE_COVERAGE.md` (30 covered, 44 gaps, 5 gated, 1 out of scope)
- **Build record:** `docs/implementation/2026-09-19-jev-evaluation.md`

This consolidates the separate reads into one document. It states what was found, what was built,
what each claim rests on, and what is still someone else's decision.

## What the proof actually is

The package asks that declared compatibility not be confused with a working system. These are
different rungs and only some are climbed.

| Rung | State | What establishes it |
|---|---|---|
| Declared dependency compatibility | Established | `ai@7.0.107` exports `evaluate as experimental_evaluate`; `@ai-sdk/provider@4.0.17` carries the typed contract; `@ai-sdk/gateway@4.0.87` types `GatewayEvaluationModelId` as `'typesafe-ai/jev' \| (string & {})`; peer `zod ^3.25.76 \|\| ^4.1.8` is met by this repo's `^4.5.4`; `engines: node >=22` is met. Read from the published tarballs. |
| Clean install | **Not done** | `ai` is not in `package.json`. Nothing was installed, so no lockfile resolution was exercised. |
| Typecheck | Established | `npx tsc --noEmit`, clean. |
| Test suite | Established | 131 files, 2400 passed, 1 skipped. Every evaluation test runs against an injected port. |
| Client build | Established | `npx vite build`, succeeds. **This does not exercise the adapter:** vite bundles the client, and the adapter is server code run through tsx. |
| Missing-dependency runtime path | Established | The adapter loads the SDK dynamically and reports `transport_unavailable`. Asserted by "reports honestly when the SDK is not installed, rather than pretending to be offline". |
| Packaged desktop runtime | **Not done** | `postbuild` was not run. No packaged artifact exists for this branch. |
| Real provider conformance | **Not done, and gated** | No budget authorizes a call. Every figure in this work is a fixture. |

The honest summary: the contract compiles, holds under test and bundles. Nothing has spoken to a
provider, and no packaged binary contains it.

## What already existed, and is reused rather than rebuilt

The package describes six responsibilities as if they needed building. Five are already in the
repository, and duplicating any of them would have created a second path to money or authority.

| Responsibility | Existing component | How this work uses it |
|---|---|---|
| Admission, record, idempotent commit | `RunService.step()`, keyed by `intentHash` | An evaluation is an ordinary step. No new execution path. |
| Egress authorization | `authorize()` in `policy.ts`, `destination: 'external'` → `checkEgress()` | The step declares external, so the host's own authorizer admits or refuses it. |
| Uncertain-outcome handling | `needsReconciliation` for `kind: 'model'` + `destination: 'external'` | Satisfied by construction. An unknown outcome parks; it is never retried. |
| Money | Integer micro-USD, `ChargeKind`, `RateCard`, `Reservation`, `AllowancePeriod`, `payerForRoute` | Reused unchanged. `ChargeKind` reuses `'advisor'` rather than adding a kind, because `chargeKindEligibility` throws on an unclassified kind and a new one forces a new rate-card version. |
| Attribution | `applicationOrigin()` / `directOrigin()`, the `isScriptedAdapter` rule | A fixture is an application action; a real port is attributed to the model the provider reported. |
| Typed evaluation contract | **Did not exist** | Built: `shared/evaluation.ts` and the modules beside it. |

Only the last row is new. That is the whole of the genuine gap the package identified.

## The corrections, and what each changed

### Trust

Trust machinery is reusable; Jev integration is **not** complete. Nothing in this branch is wired to
the live host seam - `authorizeEgress` has two arms (`server/harness/host.ts:332-337`) and neither is
the evaluation capability.

Two things changed here. The outgoing payload is asserted to contain only approved data: the step
pins project state by digest and a test plants a secret and asserts it never reaches the intent,
while the adapter asserts the provider receives one shared state and the questions and nothing else.

The second is the correction that mattered most. **A result rejected after dispatch may still have
incurred provider cost** - and it did. Validation ran after the call, so a malformed answer threw and
carried the provider's usage report away with it. The refusal was right and the accounting was not.
The failure now carries the reported usage under a code, `answer_rejected`, that exists to separate
"money may already be gone" from the four refusals made before anything is sent.

Settling that cost needs a channel the run service does not have: a handler may report provenance
but not usage, and a failed step records none. That is a contract change and is listed below rather
than invented here.

Checking the shape of an identity generation is not proof of current authority, and the acceptance
ledger was corrected on exactly this point: **J43 was demoted from covered to gap**, because the
egress assertion behind it counts phases on a first run and nothing inspects authority on the replay
path.

### Acceptance mapping

The mapping is measured against the matrix, not inferred from SDK declarations. J34 is covered by
tests for missing, wrong-primitive, non-finite and oversized responses. **J38 is a gap** and says so:
it concerns image-only evidence, and refusing an unsupported question type is a different axis.
Optional usage and distributions are preserved without inventing anything - no field named
`confidence` exists anywhere, an absent distribution stays null rather than becoming uniform, and an
unreported model stays null rather than echoing what was asked for.

### Budgets

A distinct evaluation counter is deferred to the integrator's contract review, not taken
unilaterally. `readableRun`'s `StepKind` enum is closed and validated on read, so adding a kind would
make every existing run `invalid_run_record`; the work uses `parentEnvelopeMicroUsd` with
`kind: 'model'` instead, which keeps one common ceiling across helpers, workers, retries and
corrections. Primary-task capacity is protected by refusing a helper that cannot cover its own
reservation ceiling. Historical rate cards are preserved: an amount now carries the tokens and the
rounding rule that produced it, and `priceCardVersion()` keeps a retired card retrievable so a past
settlement stays re-derivable. Internal evaluation calls do not count as extra customer requests, and
that sentence is pinned by test - though nothing counts requests yet, so it is a promise the copy
makes rather than an invariant the code enforces.

### Thread preparation

A preparation decision runs at the first substantive request of an eligible thread. Empty-thread
creation, refresh and idle polling do not trigger one, and a replayed command cannot buy a second
evaluation. Exact lookups and already-defined operations bypass deterministically. Mandatory
instructions cannot be ranked away, explicitly requested sources survive a low score, conflicting
sources are admitted together or not at all, and coverage is `complete`, `partial` or `unknown` -
never rounded up. Authorized discovery beyond an incomplete shortlist is **not built**; it is in the
change set below.

### Transport

The network call is outside the pure hooks, which is the centrepiece of the work. SDK retries are set
explicitly to zero and attempts are the run service's to count. Missing credentials are rejected
before SDK construction, and a test asserts an ambient environment variable cannot select a payer.

Two limits are stated rather than claimed away. Gateway retry and fallback behaviour beyond
`maxRetries` is **unverified** - it cannot be verified without a live call. And not every 429 is
billable, so nothing here assumes one is; there is no 429 path at all, which is why J39 is a gap.

Company-funded credentials and spending enforcement belong on an authorized company service, not in a
distributed desktop binary. This branch contains no company credential and cannot spend. A BYO or
mocked local proof is not proof of the managed route, and no row in the ledger claims otherwise.

### Money

Sub-micro-dollar charges are now tested. At this route's rate anything under 24 input tokens costs
less than one micro-USD, rounds up to one because the ledger has no smaller unit, and is never
reported as zero. The floor over-states by less than one micro-USD per call and a test bounds it.
Raw tokens and the exact rate inputs survive the rounding. Provider cost, allowance debit and
customer request count remain three separate things.

### Scope

Current public pricing policy is unchanged. No internal inference budget is published: the
per-request ceiling lives only on a plan that tests assert is unsellable, and the customer-facing
sentence names no money at all.

## The minimal change set

Ordered. Each line says who must decide it, and what it waits on.

| # | Change | Owner | Waits on |
|---|---|---|---|
| 1 | Add `ai@7.0.107` to `package.json` | Integrator | Hot-file serialization (`scripts/coordination.ts:51-68`). Until then the adapter loads it dynamically and degrades honestly. |
| 2 | A usage channel on a failed step, so `answer_rejected` can settle | Integrator | `StepContext` contract review. Today a rejected answer's cost is preserved on the error and settled nowhere. |
| 3 | An `authorizeEgress` arm for the evaluation capability | Host owner | Nothing. This is the wiring that makes the step reachable. |
| 4 | A `RouteMode` that fits an HTTP evaluation | Contract owner | A decision: the four modes in `shared/adapter-contract.ts:301` assume a process or a session, and conformance wants a `testedWith` equal to an engine version. An HTTP route has no binary version. |
| 5 | A guarantee row for the route | Contract owner | #4. A route without one has no publishable guarantee. |
| 6 | The call site at the first substantive request | Native-work owner | #3. `server/native-work.ts:378`, where a thread's context is assembled. |
| 7 | Authority revalidation on the replay path | Harness owner | Closes J43. A saved observation is returned today without rechecking the principal. |
| 8 | Authorized discovery beyond an incomplete shortlist | Native-work owner | #6. Closes J19. |
| 9 | Console surfaces: preparation state, selected sources, skip reason | Client owner | #6. |
| 10 | Server-side entitlement and payer authorization | **Does not exist in either repository** | An owner decision. Until it does, every managed route is a route to nothing. |

Items 1 and 2 are the two that touch shared contracts and must go through the integrator. Items 3-9
are ordinary work behind them. Item 10 is a different project.

## Ownership and hot files

`package.json` and `package-lock.json` are charter hot files serialized through the integrator, and
this worktree's `node_modules` is a junction to the main checkout that another worktree was reading
throughout. That is why nothing was installed: verifying the SDK by unpacking tarballs gave the same
answer without disturbing a live tree. `shared/managed-usage.ts` and `server/managed-usage.ts` were
confirmed cold before being touched, and every path in this work was claimed through
`scripts/coordination.ts`.

## Acceptance to test

The full mapping is `docs/product/evaluation/ACCEPTANCE_COVERAGE.md`, pinned by
`tests/evaluation-acceptance.test.ts`: every covered row must cite a line that really is a `test(`
declaration, every gap must name where its test belongs and what it must show, every gate must be
named, and the header's split must be the table's split.

Thirty of eighty are covered. The covered rows are the ones about money, authority and honest
unknowns. The gaps are mostly things that were not built - there is no advisor, no routing, no
retrieval and no grant model - and the ledger says so per row rather than in a preamble.

## Unresolved decisions

These are Andrew's, not mine. None is blocking the branch; each would change something already
written.

1. **Published quantity.** "Do not explicitly state how much api is included" was read as *no dollar
   figure*, which matches the 2026-09-19 decision that the literal request count is public and the
   per-request dollar figure is internal. The instruction to not "turn the tentative Managed
   allowance into a commitment" may mean the stricter reading: *no quantity either*. The
   customer-facing sentence already names no number; the count lives only on an unsellable plan
   definition. If the stricter reading was meant, the revert is small and touches two repositories.
2. **The model catalogue edit.** `PRICING_STRATEGY_2026-09-15.md` gained GPT-5.6 Luna and the
   escalation ladder, because the first instruction asked for it. The later instruction not to expand
   this slice into unrelated model-catalogue edits may retract that. It is one commit to undo.
3. **A distinct evaluation charge kind.** `'advisor'` was reused deliberately. A `'preparation'` kind
   would read better on a bill and forces a new rate-card version.
4. **$300/$100 and $750/$250.** Recorded as working direction and tentative respectively. Neither is
   configured anywhere, and no checkout, renewal or migration is authorized.

## Authorization retained

Unchanged by this document and not granted by it: paid provider calls, publication, release and
deployment each need their own authorization. The review gate before implementation lands is the pull
request. No live spending has occurred, no production has been modified, and no comparative claim
against Claude Code, Codex, OMP or Pi is made anywhere in this work - there is no comparable evidence
to make one from.
