# Nectovia routing and commercial implementation handoff

NC-2026-09-22.1, reconciled 2026-09-23. Documentation-only integration handoff. Read `../business/PRICING_STRATEGY_2026-09-15.md` first; its "Status of terms" table is authoritative for what is approved, proposed, withdrawn or superseded; update both tables together. Andrew's decisions of 2026-09-23 supersede source package NC-2026-09-22.1 and PR #35 where they differ; replaced rules are kept under "Superseded 2026-09-23" at the end and are not operative. This file does not activate runtime entitlements or authorize spending/deployment. Nothing described here is live or funded, and no route has had a live call.

Nectovia is the product. Diomedes is the company.

## Status of terms

| Term | Status | Source and date |
|---|---|---|
| Tier-only pickers (Efficient / Focused / Thorough); owner maps tiers to routes in AI setup; owner-only override for testing | approved | Owner decision 2026-09-23 |
| Customer expert model picker, lead-only / all-call pins, no-substitution choice | withdrawn | Owner decision 2026-09-23 |
| Efficient GPT-6 Luna on AWS Bedrock; Focused Gemini 3.8 Flash on Google Cloud Vertex AI (sign-in pending: API key or local ADC); Thorough GPT-6 Sol on AWS Bedrock | approved (not live-qualified) | Owner decision 2026-09-23 |
| Sol-primary Focused, Muse Standard preference, Opus 5.5 Thorough | superseded | Replaced by owner decision 2026-09-23 |
| Parent-job caps Efficient 20 / Focused 50 / Thorough 100, with pre-send warning dialog | approved | Owner decision 2026-09-23 |
| Jev through OpenRouter | approved (not live-qualified) | Owner decision 2026-09-23 |
| Jev through TypeSafe direct as the pathway | superseded | Replaced by owner decision 2026-09-23 |
| Web search through the subscription engines (Claude Code / Codex); no paid search API | approved | Owner decision 2026-09-23 |
| Build and Fix in Threads on model-API routes | approved | Owner decision 2026-09-23 |
| Provider routes exist because of provider trial credits; private provider-credit dashboard never customer-facing | approved | Owner decision 2026-09-23 |
| Usage contract `nectovia-usage/1` | approved | Owner decision 2026-09-23 |
| Solo grant (null); $500 Business Plus; included everyday Luna chat and its debit class; Meta Contributor consent | proposed | NC-2026-09-22.1; still open 2026-09-23 |
| Plan-document parity question | open (proposed) | Owner list 2026-09-23 |
| Live-provider qualification of every route | open: no live call yet | Owner list 2026-09-23 |

## Reuse the current implementation

Observed app main: c10b7b2fa3ba12e9bba9373ac3ff82db8447b820. Website main: 8c1dcef76a166df40a6226377b5be2a471c7dbdc.

- `server/engines/aws-bedrock.ts`: pinned one-exchange AWS Responses route, GPT-5.6 Luna-only schema/catalog, conservative reservations and classified provider outcomes. Upgrade model/schema/rates/tests together; do not change a string and claim a new route is proven.
- `server/harness/aws-model-adapter.ts`: NativeAgent/RunService own execution, with private continuation bound to profile/account/model. Transfer allowed work through structured portable handoffs, not another provider's hidden response state.
- `shared/managed-usage.ts`: reuse micro-USD, explicit payer and distinct cost/debit/invoice primitives, extended to the `nectovia-usage/1` values. The candidate plan is not sellable.
- `server/spend-exposure.ts`: BYO connection exposure is not the managed organization allowance. Reuse primitives without confusing those ledgers.
- `services/control-plane/README.md`: existing WorkOS identity and Neon-only PostgreSQL account/membership service. Extend its real boundaries rather than provisioning a duplicate identity service or task store. The current subset does not implement customer-funded calls/payments.
- `shared/evaluation.ts`, `server/harness/evaluation-adapter.ts`, `server/harness/evaluation-price.ts`: existing Jev/evaluation seam. A dynamic cast to an imagined SDK interface is not proof of runtime exports. Capture the exact installed SDK and OpenRouter contract; do not fabricate `evaluate` support.

## Ordered work

1. Reconcile commercial inputs across app, website and Drive. Credits are cumulative usage; parent-job caps are the approved tier caps. Preserve current service prices, Managed total grants, separate Fractional scope, and the unapproved (null) Solo grant. Remove obsolete operative request quotas, not historical acceptance evidence. Rename leftover customer-facing "Diomedes" product text to Nectovia; keep Diomedes where it names the company. Do not change any website price or grant figure.
2. Introduce only missing model-profile/connection/resolved-binding fields. Include exact model/version, proven capabilities, effort/context, account/credential reference, processing policy, payer, rate snapshot and funding evidence. Keep old runs readable and correctly attributed. Qualify each approved route separately: GPT-6 Luna and GPT-6 Sol on AWS Bedrock, Gemini 3.8 Flash on Google Cloud Vertex AI (sign-in: API key or local ADC, pending), and Jev on OpenRouter. None has had a live call; each stays unqualified until a separately authorized live test records its evidence. Other hosts use the same registry, not an independent runtime.
3. Implement server-authoritative funded parent-job reservation and settlement using existing commercial/account primitives. Enforce the approved tier caps: Efficient 20, Focused 50, Thorough 100 credits per parent job. Before send, when the likely use exceeds the cap, show a warning dialog that offers moving the job up a tier or going over the cap for that one job; the override never carries to another job or changes the tier cap. Atomic organization/job limits; idempotent attempts; period binding; pending/uncertain states; explicit top-ups. Never hold a database transaction while waiting for a model. Unknown commit/usage is reconciled, not blindly resent. Record usage under `nectovia-usage/1`: `inputTokens` total input including cache reads and writes, `outputTokens` total output including reasoning, missing usage unknown and never zero; keep provider cost evidence, customer entitlement and debit, and the private provider-credit dashboard as separate domains, and keep estimated gross cost, expected promotions, confirmed credit application, customer debit and invoice as separate values.
4. Add the tier (WorkStyle) separately from Mode. Customers see only Efficient, Focused and Thorough and never choose a model or route. The owner maps each tier to a route in AI setup: Efficient GPT-6 Luna on AWS Bedrock, Focused Gemini 3.8 Flash on Google Cloud Vertex AI, Thorough GPT-6 Sol on AWS Bedrock. Provide an owner-only override for testing, never exposed to customers. Permit cheaper workers under the same parent envelope and source policy. No compulsory low-model rewrite of premium conclusions. Threads allow Build and Fix on the model-API routes, under the same Mode authority and Trust mediation. Web search runs through the subscription engines (Claude Code / Codex); do not add a paid search API. The company's provider-credit dashboard is a private company view and never reaches a customer surface.
5. PROPOSED, do not build as entitlements until the owner approves them: source-scoped Meta Contributor consent and included-chat eligibility. The approved tier map contains no Muse route, so Contributor has no approved position. If approved later, the NC-2026-09-22.1 design applies: Contributor off by default with dispatch-time revocation checks; derived content retains restrictions; included chat an explicit Managed entitlement for ordinary human Luna Ask interaction, never a free class inherited by jobs, automation or workers; metered escalation shown and approved; no unlimited-chat claim before eligibility/fair-use/cost gates pass.
6. Integrate TypeSafe Jev as an advisory typed decision port through OpenRouter, which lists `typesafe/jev-1.13`. Verify the exact OpenRouter endpoint, terms, rates, usage reporting, context bound (OpenRouter lists 32k; enforce the route's actual bound) and canonical question mapping, including `noul` versus the internal boolean. Request bounds include all questions, not state only. Use a bounded shortlist/new-intent/missing-evidence assessment, not tool execution or permission approval. Deterministic routing can continue when optional advice is unavailable.
7. Project usage into the authenticated UI: settled percentage, pending/uncertain holds, available monthly credits, separate top-ups, reset time and freshness. Mark missing data unknown. Never show the private provider-credit dashboard or expected promotions to a customer. Test Windows/Mac, packaged paths, provider conformance and eventual paid-service evidence before rollout.

## Acceptance counterexamples

- Four workers race for the last credit: reservations cannot all succeed.
- An uncertain call crosses reset: the hold is not refunded and final cost belongs to the original period.
- A Focused job's likely use is 70 credits against its 50-credit cap: the pre-send dialog offers Thorough or a one-job override; nothing is sent without that choice, and the next Focused job still has a 50-credit cap.
- A retry, fork, delegated worker or resumed message tries to start a fresh cap: it stays inside the parent job's cap.
- A customer request carries a model ID or route: it is ignored or refused; only the owner's tier map, or the owner-only test override, selects the route.
- A provider omits usage: the value is recorded as unknown, the hold stays, and neither the debit nor the display shows zero.
- A provider reports cache reads and reasoning: they are counted inside `inputTokens` and `outputTokens`, not added again.
- An expected promotion has not been confirmed: it does not appear as a confirmed credit application, and it changes neither the gross cost nor the customer debit.
- A customer surface requests provider-credit balances: the private dashboard data is not reachable.
- A web-search step runs: it goes through a subscription engine, never a paid search API.
- A background task sets mode=Ask, or a paid job delegates to Luna: neither becomes included human chat (which is itself still proposed).
- Contributor consent is revoked while queued (applies only if Contributor is approved): dispatch is refused or uses an already authorized noncontributing route; no silent payer change.
- A summary derived from restricted employee/customer content is sent to Contributor (applies only if approved): source restrictions still block it.
- GPT-6 Sol on AWS fails on a Thorough job: do not silently bill another account, disclose to another processing region, or reuse incompatible provider-private continuation.
- Jev on OpenRouter is unavailable, malformed, confident-but-wrong or stale: no fabricated judgment, authority expansion or silent zero cost.
- The catalog says a model exists but credentials/tool protocol are untested: show unqualified, not connected.
- Usage grant 1000, settled 300, pending 100, uncertain 50: 30% settled, 45% committed, 550 monthly available. A top-up is separate, not a larger monthly denominator.

## Role prompts

Opus, current authorized integrator: inspect current main and claims; read the amended unified package, the commercial contract and the 2026-09-23 decisions in the pricing document, which win where they differ. Plan and implement one independently testable slice at a time. Preserve accepted native/account/evaluation code. Resolve real interfaces before adding files. Do not take an occupied worktree or treat this task as permission for paid calls, migrations or deployment. Supply exact touched files, commands, evidence and remaining blockers.

SWE 2.0: claim one bounded interface/test unit from the integrator. Write the failing regression first, implement the minimum, run its focused suite and hand back the exact commit. Do not redesign pricing, own dependency upgrades or merge another worker's branch.

Fable: reconcile the tier-only customer UI, the pre-send cap dialog, the proposed consent and included-chat boundaries, $99 Solo fit and website wording against current evidence. Keep Efficient/Focused/Thorough independent of permissions. Customer surfaces never show a model picker. No generic AI slogans, unsupported completion claims, guaranteed 10x jobs or hidden usage conditions. Do not change unapproved grants into offers.

Astra: independently review the exact composed candidate with the counterexamples above. Separate static review, fixtures, real provider tests, account billing and packaged/deployed evidence. Preserve failing evidence and reject false passes; no live credential access or paid inference without explicit bounded authorization. Existing MI-DEMO ownership and other active claims are not reassigned.

## Sources and verification boundary

Primary research: OpenAI API pricing; Anthropic platform pricing; Meta Muse Spark model/standard-versus-contributor page; Google Gemini API pricing; DeepSeek API pricing; TypeSafe models and API docs; OpenRouter model/provider routing docs; Microsoft Foundry startup sponsorship coverage; Supabase pricing/backups and Mercury's Supabase offer. Rates are dated September 22 and route-specific qualification remains required. Google Cloud Vertex AI terms and rates for Gemini 3.8 Flash, AWS Bedrock terms and rates for GPT-6 Luna and GPT-6 Sol, and OpenRouter terms and rates for Jev still need dated verification.

The amended package preserves 66 work items, 132 numbered prompts, the 6 DONE /126 OPEN ledger and 24 hash-verified source attachments. It adds NC documents and cross-links 28 relevant work orders without marking runtime work complete. Package validators passed separately. This repository docs-only change does not claim app/service/site tests, provider calls, release packaging, deployment or a production migration.

## Superseded 2026-09-23

Kept as history. None of these rules is operative. Each is followed by what replaced it.

- **Ordered work item 2, qualification order.** Superseded: "Qualify AWS first, then Azure/OpenRouter separately." Replaced by: separate qualification of the approved routes, GPT-6 Luna and GPT-6 Sol on AWS Bedrock, Gemini 3.8 Flash on Google Cloud Vertex AI, Jev on OpenRouter. Azure is not in the approved map; it is not withdrawn, but no current rule depends on it.
- **Ordered work item 3, caps.** Superseded: "explicit top-ups and cap increases" with no approved default cap. Replaced by: approved tier caps 20 / 50 / 100 and the pre-send warning dialog offering a move up a tier or a one-job override.
- **Ordered work item 4, WorkStyle.** Superseded: "Luna-led Efficient, Sol-primary Focused with qualified Muse Standard preference, Opus 5.5 Thorough. ... Expert picker is optional; lead-only/all-call pins and no-substitution semantics are explicit." Replaced by: tier-only customer pickers, the owner's tier map (Efficient GPT-6 Luna on AWS Bedrock, Focused Gemini 3.8 Flash on Google Cloud Vertex AI, Thorough GPT-6 Sol on AWS Bedrock) and an owner-only test override.
- **Ordered work item 5, consent and included chat.** Superseded: presented as ordered implementation work. Replaced by: both marked proposed; not built as entitlements until the owner approves them.
- **Ordered work item 6, Jev transport.** Superseded: "Current direct model is `jev-1.13.0`; OpenRouter lists `typesafe/jev-1.13`." with the direct TypeSafe route (`POST /v1/systemone`, 64k total request and 32k state plus longest question) as a candidate transport, and the reuse note's "implement a bounded direct TypeSafe port if required". Replaced by: OpenRouter as the Jev pathway.
- **Counterexample, all-call pin.** Superseded: "A user pins all calls to a model: routing cannot substitute a cheaper worker without permission." Replaced by: customers cannot pin or choose models; a request carrying a model ID or route is ignored or refused.
- **Counterexample, Sol route.** Superseded: "Sol/AWS fails" as a Focused-route case. Replaced by: the same rule for GPT-6 Sol on AWS as the Thorough route.
- **Fable role.** Superseded: "reconcile normal versus expert UI". Replaced by: reconcile the tier-only customer UI; no customer model picker.
