# Managed Nectovia Agent access and allowance

PB-2026-09-10.1 engineering contract, commercial terms reconciled to NC-2026-09-28.1.

## Offer and meaning

The current [pricing and service scope](../../business/PRICING_STRATEGY_2026-09-15.md) governs approved prices, grants and commercial limits. Nectovia-managed inference is the default and preferred path. Included allowance is consumed first, then authorized additional managed usage at Nectovia's current usage rate. A policy decision does not activate checkout or certify a deployed service.

Credits measure cumulative eligible usage under the recorded customer rate card. They are not withdrawable money, provider account credit, a fixed token count or a guaranteed number of jobs. Keep provider costs, internal pricing formulas and provider-to-credit derivations in private commercial records. Customers receive the applicable customer rate, authorized limit and an accurate usage statement and invoice.

Account for setup, generation, billed reasoning/caching, reviewers, advisors and corrections. Explicitly classify embeddings, tool services and other fees as included or excluded. Use integer micro-USD or decimal money. Provider cost, allowance consumption and invoices remain separate. Local calls do not debit managed API credit; BYO charges do not silently switch payer.

## Gateway and admission

Company keys remain server-side. Validate identity, membership, organization entitlement, data route and budget before dispatch. Bind short-lived authorization to tenant/audience/request; a client-supplied paid flag or organization ID is not authority. Do not create a generic unauthenticated API proxy.

Customer-owned commercial API/cloud credentials are optional Advanced or contract-specific routes, not the default. They do not grant entitlement or debit Nectovia-funded credits. Consumer, Pro, Max, Team, Business and similar subscriptions cannot fund pooled organization-wide Agent inference. A provider-permitted subscription-backed external engine remains limited to its licensed user/device. No credential extraction, sharing or implicit payer fallback. Verify actual provider terms before activation. The website's contact database is not an entitlement backend.

Use the approved backend where it exists after Opus. Otherwise build a working local/test ledger plus a narrow gateway interface and display hosted mode as unavailable. Missing credentials do not justify simulated paid readiness.

## Reserve, execute, settle

Atomically reserve a conservative maximum from both organization balance and parent-task envelope before a call. Bound context/output and permitted billed tools under the applicable rate card. A route without a reliable cost bound cannot promise a hard spending cap; disable it for strict-budget work or use a separately approved company risk envelope.

With $2 available, two concurrent $1.50 reservations cannot both proceed. If the admitted call costs $0.40, settle that once and release $1.10. Use durable idempotency and explicit state transitions. Team children and retries reserve within the same parent budget rather than multiplying credit.

Lost responses can still cost money. Keep uncertain reservations pending reconciliation instead of releasing them and retrying freely. Show estimated/pending/settled amounts. Cancellation stops future dispatch but does not erase incurred charges. Preserve the rate-card version and handle delayed provider accounting.

A billing platform is not the real-time spend gate. Stripe documents asynchronous meters and duplicate/out-of-order webhooks. If selected, verify signatures, deduplicate and reconcile authoritative subscription state; keep live admission/reservations in the Diomedes gateway. See 08_SOURCES_AND_LICENSING.md.

## Lifecycle

Use the included organization allowance first, then recorded authorized purchases. Additional managed usage requires an organization-authorized customer rate, billing period and finite monthly charge cap; default off. Alert at 75%, 90% and 100% of allowance and authorized cap, including pending/uncertain holds, and stop new calls at the limit. A higher job cap is not overage consent. No automatic overage, automatic top-up or silent payer/privacy change. Rollover/expiry terms remain separately scoped. Postpaid authorization, cap enforcement and notifications must exist together before postpaid usage is available; the current ledger spends only granted allowance and recorded purchases.

Allocate each period once, even after duplicate invoice events. Reinstalling, new profiles, locations, models or members cannot reset credit. Upgrades, refunds, proration, chargebacks and service grants use adjustment events, not rewritten history. Payment cannot override a security suspension.

Separate paid-through status, membership and active configuration. Cancellation follows its contract and paid-through date; security revocation stops new sensitive admissions at supported boundaries. A budget reservation is not permission to execute after revocation. No offline company-funded requests.

Offline Business features may eventually use bounded signed validity leases under a documented policy; instantaneous offline revocation is impossible. Initially forbid offline admin changes and managed requests while preserving explicitly permitted local reading/work. Billing lapse must not destroy records; former members do not thereby gain export rights. Exports already obtained cannot be recalled by cloud revocation.

## Economics and proof

Company economics and negotiated pricing exceptions belong in the private commercial authority. Promotional credits and discounts affect company expenditure, not the customer debit, invoice or published grant. Keep estimated gross provider cost, expected promotions, confirmed credit application, customer debit and invoice distinct. Measure cost per verified job, all calls/retries, setup usage, support and renewals privately.

Initial proof covers entitlement-versus-permission separation, concurrent reservations, idempotent settlement, uncertain responses, exhaustion, duplicate/out-of-order billing events, membership revocation and tenant-separated spend. Synthetic providers remain labeled. No live charges, company-key distribution or public checkout in the pre-GLM pass.
