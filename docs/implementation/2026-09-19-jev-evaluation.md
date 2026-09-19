# Jev-backed evaluation: the contract, the price and the rules that bound it

Date: 2026-09-19. Author: Opus 5 session, from Andrew's request of the same day and the
`JEV-2026-09-19.1` handoff package.
Worktree: `diomedes-wt/jev-evaluation-20260919`, branch `feature/jev-evaluation-20260919`.
Base: `80263205133c410d590549efd1c8f40cedf33b1c` (main, "Bring the pricing contract, Pillar 07 and
the living documents up to the 2026-09-19 decisions").
Canonical versions read at that commit: Core Pillars 2026-09-19.1, Live Roadmap 2026-09-19.2,
Project Memory 2026-09-19.2, pricing authority 2026-09-19.1 (raised to .2 here).

This is an implementation candidate. Nothing here was released, deployed or published, no provider
was contacted, and no money was spent. Every test named below was run in this worktree and its
counts are the counts from that run.

## What the package asked for, and what was actually missing

The handoff proposes an optional, funded evaluation capability — a Jev-backed helper that picks
relevant project evidence, tools and routes before the main model starts. An audit of the real
repository found that most of the machinery it proposes to build already exists, and that the
genuinely absent pieces are different from the ones it names.

| Package proposal | State in this repository |
|---|---|
| A reserve/settle accounting boundary for helper calls | Exists. `AllowanceLedger.reserve` (`server/managed-usage.ts:308`), `.settle` (`:389`), `.release`, `.markUncertain`, `.reconcile`, `.writeOff` |
| A charge kind for an advisor | Exists. `ChargeKind` already includes `advisor` and `reviewer` (`shared/managed-usage.ts:139-141`) |
| A nested helper budget under a parent task budget | Exists. `parentTaskId` + `parentEnvelopeMicroUsd` (`shared/managed-usage.ts:509`) |
| A bounded grant with provenance | Exists in two halves: `AllowanceAdjustment` carries the money, `CustomizationBenefitLedger` the status |
| Payer resolution including BYO and local | Exists. `payerForRoute` (`shared/managed-usage.ts:393-418`) |
| "One admitted external model operation as a durable run" | Exists. `TextRouteRuntime` (`server/harness/text-route.ts`) is exactly that shape |
| A guard so a recommendation cannot widen tool authority | Exists. `validatePrepared` (`server/harness/native-agent.ts:61-77`) permits removal only |
| Parking an uncertain external call instead of retrying it | Exists. `needsReconciliation` (`server/harness/run-service.ts:171-173`) |

What was actually absent:

1. **No token-to-money table anywhere.** Every figure the allowance ledger has ever seen came from
   its caller. `HarnessBudget` says so outright: "Tokens, spend and GPU memory are not accounted
   here" (`shared/harness.ts:52-56`).
2. **No provider-direct route of any kind.** All eight routes drive a binary the user already
   installed and signed into (`shared/engines.ts:3-4`). The `host-credential` authentication mode
   exists in the contract enum with zero users. A funded evaluation would be the first metered API
   transport this product has ever shipped.
3. **Nothing on a dispatch path calls the accounting boundary.** `gateway.admit` and `ledger.settle`
   are reachable only over HTTP (`server/managed-usage-routes.ts:121,149`). `ModelResult.usage` is
   persisted at `native-agent.ts:258` and read by nothing. The money plane and the execution plane
   are both built and not connected to each other.
4. **`validatePrepared` guards tools but says nothing about messages.** A ranking there could drop
   any instruction it liked. The protection the package assumes exists does not.
5. **No typed contract for a decision as distinct from a completion.**

## What was built

Five modules and six test files, all in cold paths under two recorded coordination claims
(`claim_mu82yiev_cdc7a421`, `claim_mu83c6gn_441bf319`, `claim_mu83gk1t_91d117a0`).

| File | What it is |
|---|---|
| `shared/evaluation.ts` | The typed contract: what may be asked, what may come back, and a validator that refuses whole rather than consuming in part |
| `shared/evaluation-eligibility.ts` | The deterministic predicate that decides whether a preparation may run at all |
| `shared/evaluation-selection.ts` | Pure selection: protected context, required coverage, conflicting sources |
| `server/harness/evaluation-price.ts` | The first token-to-money table in the repository |
| `server/harness/evaluation-adapter.ts` | The injected transport: a scripted port and a dynamically-loaded gateway port |

Three rules in the contract carry the weight, and each has tests:

- **A returned name is never authority.** Options are ids the caller already resolved and was
  already permitted to use. A name that was not offered is refused before anything consumes it, so
  a source or a tool cannot come into being by being spelled.
- **Unknown stays unknown.** A provider that reported no token count has not reported zero, and one
  that did not name itself has not confirmed the model that was asked for. Both stay `null`. A zero
  on a usage screen has to mean "this was free" or it means nothing.
- **A probability is not a confidence and not a permission.** The provider documents its boolean
  field as the model's estimated P(true) and explicitly "not confidence in either outcome". No field
  in this contract is called confidence, and a test asserts the string never appears.

## Pillar impact

**Pillar 01** ("Do not add model latency/cost to trivial operations merely to make a feature appear
intelligent") and **Pillar 08** ("Do not force ... model reasoning where a deterministic,
already-authorized operation is sufficient") are the binding constraints. A preflight that fires on
every thread is exactly the pattern both forbid.

The exemption is `preflightDecision` in `shared/evaluation-eligibility.ts`: a pure predicate,
evaluated before anything is admitted, that refuses in ten named cases and records which one. The
load-bearing case is `single-candidate` — an evaluation chooses between candidates the product
already authorized, so where there are none or one there is nothing to choose and no model is asked.
A one-document thread, an exact status lookup and an empty project all skip for free with a reason.

**Pillar 07** ("models and engines are interchangeable resources ... customer subscription-backed
routes, local models, BYO APIs, Diomedes-hosted inference") already permits a hosted route, so a
company-funded evaluation is not a pillar conflict. It would, however, be the first one.

**Pillar 09** governs the Contributor correction below: a data-contributing route needs an explicit
organization choice.

## Two owner decisions applied

**Included usage is published as a count, never as money.** The rule is recorded in the pricing
authority, the roadmap and the project memory, and the Console contradicted all three:
`ALLOWANCE_MEANING` opened "a USD allowance for managed model usage". That is what the ledger meters
internally, not what anybody buys. It and the Console's fallback wording now lead with the count,
and every negative survives. `PlanDefinition` gained `includedRequests` and
`perRequestCeilingMicroUsd`, and a test holds the identity the pricing authority states outright:
the published count times the internal ceiling is exactly the internal monthly bound.

**The primary agents are GPT-5.6 Luna, Gemini 3.8 Flash and Muse Spark 1.3**, with stronger models
where a task needs them and a note that they cost more. Recorded in the pricing authority
(2026-09-19.2), with two corrections research forced:

- *A named model is not a usable route.* Luna through the OpenAI API is $0.20 per million input
  tokens; Luna through the Codex CLI bills a ChatGPT subscription and cannot serve a customer.
  Muse through OpenCode Zen is metered; Muse through OpenCode Go is one seat per workspace. Only
  metered routes can carry customer work, which is the rule `payerForRoute` already enforces.
- *Contributor is a data decision, not a usage tier.* The effect described is real — contributor
  tokens are about an order of magnitude cheaper — but the mechanism is permission to train on
  prompts and completions, geo-limited by the model owner's policy. Under Pillar 09 that needs an
  explicit organization choice. It stays an opt-in that is not offered.

## What was deliberately not built

- **No new `StepKind`.** `readableRun`'s enum is closed (`server/harness/host.ts:109`); an unknown
  kind turns every existing run into `invalid_run_record`. An evaluation declares `kind:'model'`
  with `destination:'external'`, which also inherits `needsReconciliation` for free.
- **No new `ChargeKind`.** `chargeKindEligibility` throws on an unclassified kind — "An unclassified
  charge is never admitted" (`shared/managed-usage.ts:272-278`) — so adding one makes the frozen
  2026-09-10 card throw for it, correctly, and forces a new card version. `advisor` already reads as
  "an advisor asked during a task". A `preparation` kind with a v2 card is a separate patch.
- **No second budget envelope.** `parentEnvelopeMicroUsd` already is one.
- **No Auto routing.** It does not exist in this product; selection is manual only. A recommendation
  may be offered and never applied.
- **No skills registry.** Diomedes has no skills concept; the word appears only where it disables an
  external engine's skills. The package's "skill selection" reduces to tool and pack selection.
- **No `ai` dependency added.** See below.

## Sequencing, not blocking

`diomedes-wt/prompt-package-integration-20260919` holds uncommitted edits to `run-service.ts`,
`host.ts`, `text-route.ts`, `route-contract.ts`, `adapters.ts`, `instruction-delivery.ts`,
`native-work.ts`, `shared/harness.ts` and `shared/adapter-contract.ts`, and was running its suite
during this work. Its diff contains no reference to evaluation or Jev: it is the field-readiness
lane, a different purpose in the same files.

Every wiring point this feature needs is in that list, so the remaining work is sequenced behind it
rather than blocked by it. Each item is a small change against a finished interface:

| Item | File | Why it waits |
|---|---|---|
| An `authorizeEgress` arm for the evaluation capability | `server/harness/host.ts:332-337` | Two arms today; anything else external is refused |
| A guarantee row for the route | `server/harness/adapters.ts:14-187` | A route without one has no publishable guarantee |
| The call site at the first substantive request | `server/native-work.ts:378` | `assembleInstructions` is where a thread's context is built |
| A route-contract entry | `server/harness/route-contract.ts` | Also needs a `RouteMode` decision: none of the four fits an HTTP evaluation |
| Console surfaces | `client/console/` | Preparation state, selected sources, skip reason |

The `ai` dependency was deliberately not installed. The worktree's `node_modules` is a junction to
the main checkout's, which the other worktree was reading at the time, and `package.json` and
`package-lock.json` are charter hot files serialized through the integrator
(`scripts/coordination.ts:51-68`). The adapter therefore loads the SDK dynamically: a build without
the dependency still compiles, runs and passes every test, and the one operation that needs it
reports `transport_unavailable` rather than looking like an outage. The dependency is a one-line
addition when it is serialized.

Verified against the published packages without installing them: `ai@7.0.107` exports
`evaluate as experimental_evaluate`; `@ai-sdk/provider@4.0.17` carries the typed contract;
`@ai-sdk/gateway@4.0.87` types `GatewayEvaluationModelId` as `'typesafe-ai/jev' | (string & {})`;
peer `zod ^3.25.76 || ^4.1.8` is satisfied by this repo's `^4.5.4`; `engines: node >=22` is
satisfied. Two traps handled in code: `maxRetries` defaults to 2, and `apiKey` defaults to the
`AI_GATEWAY_API_KEY` environment variable.

## Blocking gates

None of these is granted by this work, and none may be worked around.

1. **No live-test budget.** Blocks every provider call, and therefore any latency, token-saving or
   comparative number. Stage A (fixtures) only.
2. **The managed payer cannot run.** `EntitlementView.managedInference` is the literal type `false`
   (`shared/workspaces.ts:116`) and all eight `paid-managed-inference` release-gate requirements are
   `met: false`. This is a type-level interlock, the same device as `sellable: false`. Flipping it is
   an owner decision with those gates attached.
3. **No implementation-grant amount, period, renewal or offboarding terms.** Company-funded Jev
   stays disabled; synthetic entitlements only.
4. **No provider account proof.** No account, key or billing route was verified.
5. **No `RouteMode` fits an evaluation.** The four modes in `shared/adapter-contract.ts:301` assume a
   process or a session, and conformance requires a `testedWith` equal to an engine version. An HTTP
   evaluation route has no binary version. This is a contract decision, not an implementation detail.
6. **Commercial terms unread.** Technical API availability is not permission to serve end customers
   on any of the named routes.
7. **An ambiguity in the owner's instruction.** "Do not explicitly state how much api is included"
   was read as "no dollar figure", which is already the rule in three canonical documents and is
   what this work enforces. The other reading — no quantity at all — would withdraw the same-day
   approved "up to 1,000 requests a month" and require edits in five places plus the site repository.
   The conservative reading was taken and the contract sentence names no number; the number lives
   only in the unsellable plan definition. If the other reading was meant, the revert is small.

## Verification

Run in this worktree, on this branch:

    npx tsc --noEmit                            clean
    npx vitest run tests/evaluation-contract.test.ts tests/evaluation-price.test.ts \
      tests/evaluation-adapter.test.ts tests/evaluation-eligibility.test.ts \
      tests/evaluation-selection.test.ts tests/included-usage.test.ts
                                                6 files, 119 passed
    npx vitest run tests/managed-usage.test.ts tests/managed-usage-routes.test.ts \
      tests/managed-gateway.test.ts tests/managed-usage-ledger.test.ts
                                                4 files, all passed

No provider is contacted by any test in this work. The gateway port is exercised through an injected
fake; the scripted port is a fixed script and declares itself `scripted`, so the loop attributes its
work to the application rather than to a model.

## ROADMAP IMPACT

A focused amendment is proposed and **not applied**: Diomedes owns a recorded evaluation capability,
initially Jev-backed, for authorized thread-start selection of evidence, tools and permitted routes.
It introduces no second run owner, scheduler or agent loop. It maps to H09/H18–H20 for
context and evaluation, H12 for typed effects and pre-effect Trust, and the existing managed-usage
boundary for accounting. Only H01 has landed; H09/H12 exist only off-main; H13/H14/H18–H20 and SDKR
are `not-started`. Nothing here changes those states.

## BUILD STATUS

Built and green in the worktree. Not merged. Not packaged: `npm run build` triggers desktop
packaging through `postbuild` and was not run.

## PUBLICATION STATUS

The pricing authority was amended in the repository to 2026-09-19.2. Its canonical Drive document is
**not** updated — a session cannot write it. The roadmap, project memory and Core Pillars are
unchanged. Nothing was published to the website.

## DEPLOYMENT STATUS

Nothing deployed. No release, no tag, no installer, no site change.
