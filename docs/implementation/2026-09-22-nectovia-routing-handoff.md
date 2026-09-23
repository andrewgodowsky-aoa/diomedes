# Nectovia routing and commercial implementation handoff

NC-2026-09-22.1. Documentation-only integration handoff. Read `../business/PRICING_STRATEGY_2026-09-15.md` first. Andrew requested these commercial and prompt updates; this file does not activate runtime entitlements or authorize spending/deployment.

## Reuse the current implementation

Observed app main: c10b7b2fa3ba12e9bba9373ac3ff82db8447b820. Website main: 8c1dcef76a166df40a6226377b5be2a471c7dbdc.

- `server/engines/aws-bedrock.ts`: pinned one-exchange AWS Responses route, GPT-5.6 Luna-only schema/catalog, conservative reservations and classified provider outcomes. Upgrade model/schema/rates/tests together; do not change a string and claim a new route is proven.
- `server/harness/aws-model-adapter.ts`: NativeAgent/RunService own execution, with private continuation bound to profile/account/model. Transfer allowed work through structured portable handoffs, not another provider's hidden response state.
- `shared/managed-usage.ts`: reuse micro-USD, explicit payer and distinct provider cost/debit/invoice primitives. The candidate plan is not sellable.
- `server/spend-exposure.ts`: BYO connection exposure is not the managed organization allowance. Reuse primitives without confusing those ledgers.
- `services/control-plane/README.md`: existing WorkOS identity and Neon-only PostgreSQL account/membership service. Extend its real boundaries rather than provisioning a duplicate identity service or task store. The current subset does not implement customer-funded calls/payments.
- `shared/evaluation.ts`, `server/harness/evaluation-adapter.ts`, `server/harness/evaluation-price.ts`: existing Jev/evaluation seam. A dynamic cast to an imagined SDK interface is not proof of runtime exports. Capture the exact installed SDK or implement a bounded direct TypeSafe port if required; do not fabricate `evaluate` support.

## Ordered work

1. Reconcile commercial inputs across app, website and Drive. Credits are cumulative usage; finite parent-job caps remain. Preserve current service prices, Managed total grants, separate Fractional scope, and unapproved Solo allowance. Remove obsolete operative request quotas, not historical acceptance evidence.
2. Introduce only missing model-profile/connection/resolved-binding fields. Include exact model/version, proven capabilities, effort/context, account/credential reference, processing policy, payer, rate snapshot and funding evidence. Keep old runs readable and correctly attributed. Qualify AWS first, then Azure/OpenRouter separately. Other hosts use the same registry, not an independent runtime.
3. Implement server-authoritative funded parent-job reservation and settlement using existing commercial/account primitives. Atomic organization/job limits; idempotent attempts; period binding; pending/uncertain states; explicit top-ups and cap increases. Never hold a database transaction while waiting for a model. Unknown commit/usage is reconciled, not blindly resent.
4. Add WorkStyle separately from Mode. Luna-led Efficient, Sol-primary Focused with qualified Muse Standard preference, Opus 5.5 Thorough. Permit cheaper workers under the same parent envelope and source policy. Expert picker is optional; lead-only/all-call pins and no-substitution semantics are explicit. No compulsory low-model rewrite of premium conclusions.
5. Add source-scoped Meta Contributor consent and included-chat eligibility. Contributor is off by default with dispatch-time revocation checks. Derived content retains restrictions. Included chat is an explicit Managed entitlement for ordinary human Luna Ask interaction, never a free class inherited by jobs, automation or workers. Show/approve metered escalation. Publish no unlimited-chat claim before eligibility/fair-use/cost gates pass.
6. Integrate TypeSafe Jev as an advisory typed decision port. Current direct model is `jev-1.13.0`; OpenRouter lists `typesafe/jev-1.13`. Verify exact endpoint/terms/rates/usage and canonical question mapping, including direct `noul` versus internal boolean. Direct request bounds include all questions, not state only. Use a bounded shortlist/new-intent/missing-evidence assessment, not tool execution or permission approval. Deterministic routing can continue when optional advice is unavailable.
7. Project usage into the authenticated UI: settled percentage, pending/uncertain holds, available monthly credits, separate top-ups, reset time and freshness. Mark missing data unknown. Test Windows/Mac, packaged paths, provider conformance and eventual paid-service evidence before rollout.

## Acceptance counterexamples

- Four workers race for the last credit: reservations cannot all succeed.
- An uncertain call crosses reset: the hold is not refunded and final cost belongs to the original period.
- Contributor consent is revoked while queued: dispatch is refused or uses an already authorized noncontributing route; no silent payer change.
- A summary derived from restricted employee/customer content is sent to Contributor: source restrictions still block it.
- A background task sets mode=Ask, or a paid job delegates to Luna: neither becomes included human chat.
- A user pins all calls to a model: routing cannot substitute a cheaper worker without permission.
- Sol/AWS fails: do not silently bill another account, disclose to another processing region, or reuse incompatible provider-private continuation.
- Jev is unavailable, malformed, confident-but-wrong or stale: no fabricated judgment, authority expansion or silent zero cost.
- The catalog says a model exists but credentials/tool protocol are untested: show unqualified, not connected.
- Usage grant1000, settled300, pending100, uncertain50: 30% settled, 45% committed, 550 monthly available. A top-up is separate, not a larger monthly denominator.

## Role prompts

Opus, current authorized integrator: inspect current main and claims; read the amended unified package and commercial contract; plan and implement one independently testable slice at a time. Preserve accepted native/account/evaluation code. Resolve real interfaces before adding files. Do not take an occupied worktree or treat this task as permission for paid calls, migrations or deployment. Supply exact touched files, commands, evidence and remaining blockers.

SWE 2.0: claim one bounded interface/test unit from the integrator. Write the failing regression first, implement the minimum, run its focused suite and hand back the exact commit. Do not redesign pricing, own dependency upgrades or merge another worker's branch.

Fable: reconcile normal versus expert UI, consent, included-chat boundary, $99 Solo fit and website wording against current evidence. Keep Efficient/Focused/Thorough independent of permissions. No generic AI slogans, unsupported completion claims, guaranteed10x jobs or hidden usage conditions. Do not change unapproved grants into offers.

Astra: independently review the exact composed candidate with the counterexamples above. Separate static review, fixtures, real provider tests, account billing and packaged/deployed evidence. Preserve failing evidence and reject false passes; no live credential access or paid inference without explicit bounded authorization. Existing MI-DEMO ownership and other active claims are not reassigned.

## Sources and verification boundary

Primary research: OpenAI API pricing; Anthropic platform pricing; Meta Muse Spark model/standard-versus-contributor page; Google Gemini API pricing; DeepSeek API pricing; TypeSafe models and API docs; OpenRouter model/provider routing docs; Microsoft Foundry startup sponsorship coverage; Supabase pricing/backups and Mercury's Supabase offer. Rates are dated September 22 and route-specific qualification remains required.

The amended package preserves 66 work items, 132 numbered prompts, the 6 DONE /126 OPEN ledger and 24 hash-verified source attachments. It adds NC documents and cross-links 28 relevant work orders without marking runtime work complete. Package validators passed separately. This repository docs-only change does not claim app/service/site tests, provider calls, release packaging, deployment or a production migration.
