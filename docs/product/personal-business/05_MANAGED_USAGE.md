# Managed Diomedes Agent access and allowance

PB-2026-09-10.1 | Engineering proposal; candidate price, not public approval.

## Offer and meaning

Candidate: $300/month per organization with $100 of eligible managed inference. Preserve approved price anchors until explicitly replaced. Implement an inactive versioned plan definition, not a global constant or live checkout. Seat, host, location, support and storage limits need approved values before sale.

Recommended meaning: a USD allowance debited by documented eligible upstream inference charges under a recorded rate card. It is not withdrawable money, provider account credit, a fixed token count or a guaranteed number of jobs. If using marked-up internal credits later, say so; do not describe $100 of those as $100 upstream API spend.

Account for setup, generation, billed reasoning/caching, reviewers, advisors and corrections. Explicitly classify embeddings, tool services and other fees as included or excluded. Use integer micro-USD or decimal money. Provider cost, allowance consumption and invoices remain separate. Local calls do not debit managed API credit; BYO charges do not silently switch payer.

## Gateway and admission

Company keys remain server-side. Validate identity, membership, organization entitlement, data route and budget before dispatch. Bind short-lived authorization to tenant/audience/request; a client-supplied paid flag or organization ID is not authority. Do not create a generic unauthenticated API proxy.

Keep authorized subscription-native and BYO routes separate; personal subscriptions are not resale inventory. Verify actual provider service/data terms before activation. No provider is commercially selected by this document. The website's contact database is not an entitlement backend.

Use the approved backend where it exists after Opus. Otherwise build a working local/test ledger plus a narrow gateway interface and display hosted mode as unavailable. Missing credentials do not justify simulated paid readiness.

## Reserve, execute, settle

Atomically reserve a conservative maximum from both organization balance and parent-task envelope before a call. Bound context/output and permitted billed tools under the applicable rate card. A route without a reliable cost bound cannot promise a hard spending cap; disable it for strict-budget work or use a separately approved company risk envelope.

With $2 available, two concurrent $1.50 reservations cannot both proceed. If the admitted call costs $0.40, settle that once and release $1.10. Use durable idempotency and explicit state transitions. Team children and retries reserve within the same parent budget rather than multiplying credit.

Lost responses can still cost money. Keep uncertain reservations pending reconciliation instead of releasing them and retrying freely. Show estimated/pending/settled amounts. Cancellation stops future dispatch but does not erase incurred charges. Preserve the rate-card version and handle delayed provider accounting.

A billing platform is not the real-time spend gate. Stripe documents asynchronous meters and duplicate/out-of-order webhooks. If selected, verify signatures, deduplicate and reconcile authoritative subscription state; keep live admission/reservations in the Diomedes gateway. See 08_SOURCES_AND_LICENSING.md.

## Lifecycle

Recommended defaults, pending commercial approval: pooled organization allowance per billing period; no rollover or auto-overage unless explicitly sold; lower admin/member/task caps; warnings and stop-new-managed-calls at exhaustion. Waiting, an approved purchase or an organization-permitted local/BYO route are explicit choices. No silent payer/privacy change.

Allocate each period once, even after duplicate invoice events. Reinstalling, new profiles, locations, models or members cannot reset credit. Upgrades, refunds, proration, chargebacks and service grants use adjustment events, not rewritten history. Payment cannot override a security suspension.

Separate paid-through status, membership and active configuration. Cancellation follows its contract and paid-through date; security revocation stops new sensitive admissions at supported boundaries. A budget reservation is not permission to execute after revocation. No offline company-funded requests.

Offline Business features may eventually use bounded signed validity leases under a documented policy; instantaneous offline revocation is impossible. Initially forbid offline admin changes and managed requests while preserving explicitly permitted local reading/work. Billing lapse must not destroy records; former members do not thereby gain export rights. Exports already obtained cannot be recalled by cloud revocation.

## Economics and proof

$300 minus full $100 usage leaves $200, or 66.7%, before all other costs—not profit. Assumed servicing costs of $40/$100/$200 leave $160/$100/$0 before acquisition and other excluded costs. These are scenarios, not forecasts. Measure cost per verified job, all calls/retries, setup usage, support and renewals.

Initial proof covers entitlement-versus-permission separation, concurrent reservations, idempotent settlement, uncertain responses, exhaustion, duplicate/out-of-order billing events, membership revocation and tenant-separated spend. Synthetic providers remain labeled. No live charges, company-key distribution or public checkout in the pre-GLM pass.
