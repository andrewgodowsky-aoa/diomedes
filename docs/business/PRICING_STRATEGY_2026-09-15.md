# Diomedes / Nectovia pricing and service scope

Version: NC-2026-09-22.1. Date: September 22, 2026.
Status: commercial reconciliation and implementation direction, not proof of a deployed paid service.

This replaces obsolete operative request-count and service-price language in the preceding version. Basis: Andrew's September 22 directions and `diomedes-site/src/data/pricing.ts` at `8c1dcef76a166df40a6226377b5be2a471c7dbdc`. Historical decisions remain in Git history; do not restore them as current offers. New allowance values identified as proposals are not approved. Nectovia is the customer-facing experience in this work; repository/company identifiers are not globally renamed here.

## Commercial principle

Software, professional implementation and ongoing operational service are different products. Sell useful business outcomes without inventing ROI. Keep consequential actions subject to the existing human-approval boundary. A price decision does not implement billing, entitlements, provider access, a connector or an SLA.

## Recurring offers

| Offer | Price | Monthly credits | Scope |
|---|---:|---:|---|
| 90-Day Workflow Starter | $250/month for three months, $750 total | 500 | One supported workflow/location, up to two supported sources/file inputs, approximately 60–90 minutes remote onboarding and handoff; no additional Business charge |
| Business | $300/month per organization | 1,000 | Self-managed workspace/workflows, funded AI, bounded basic support and the existing included design scope |
| Managed Small | From $750/month | 3,000 | Business included; one location and up to one maintained live connection, agreed checks, routine repairs and bounded support |
| Managed Standard | From $1,250/month | 5,000 | Business included; multiple locations or up to two live connections, agreed maintenance and support |
| Managed Plus | From $2,000/month | 8,000 | Business included; three or more live connections or a vendor-gated connection, within agreed maintenance/review scope |

Managed grants are totals, not additions to a second Business grant. A live connection is an independently authenticated business account or maintained feed; locations sharing an account may share a connection. A location is any separate place the work happens, across trades, not only a restaurant.

Starter excludes custom connectors/API development, bespoke integrations, substantial data cleanup, on-site implementation, unlimited workflows/support, priority incident response, an SLA and major engineering. Discovery outside its scope produces a separate quote. After 90 days there is no automatic continuation: stop, move to self-managed Business when operational, or separately agree Managed. This is not a free trial, automatic refund or unconditional mid-term cancellation promise.

Fractional AI Ops starts at $2,000/month for contracted professional time and a prioritized improvement backlog. It does not automatically bundle Business or AI credits. Work already covered by Managed is not billed twice.

### Solo: owner direction versus proposal

Andrew directs a $99/month offering for one person with light personal or solo-business work. Its credit grant is not approved. The working economics proposal is 250 credits/month, not an active entitlement. Keep the production grant unset and sellable false until allowance, user/host limits and billing are approved.

Draft positioning: For one person: everyday questions, writing, research and light business administration. For shared operations, maintained connections or recurring operational workflows, choose Business or Managed.

Solo does not include team operations, maintained POS/scheduling/inventory integrations, unattended operational responsibility, custom connectors, on-site work or human design services. Suitability follows actual workload and responsibility, not merely whether a customer has a street address. Free self-managed local/BYO use remains; Solo is an optional managed-inference purchase. The previously suggested $500 Business Plus / 2,000-credit offer remains an assistant proposal, not an approved plan.

## Professional service anchors

| Engagement | Current starting price | Boundary |
|---|---:|---|
| Fit call | First hour free | One discovery discussion; no automatic paid continuation |
| Focused consultation | $150/hour, quoted directly | Scope and price accepted first; travel separate; not a public unlimited-advisory offer |
| Local Hardware and Model Plan | $500 | One workload/equipment review and written procurement/running plan |
| Cloud AI Quick Start | $750 | One supported route, useful example, configuration, training and handover; no custom production connector |
| Workflow Audit | $2,000 | A written assessment of one recurring process; customer can use it without further purchase |
| Bounded Pilot | $4,000 | One measurable custom workflow with agreed inputs, testing, review and stopping point |
| Implementation | $9,000 plus $2,500 per additional location | Scoped build, testing, onboarding and handover; greater complexity quoted above the anchor |
| Documented-interface connector build | $3,000–$5,000 | Vendor-gated work scoped separately; vendor-program fees pass through at cost |
| Customer-owned Private AI | $15,000 plus hardware and agreed travel | Assessment, sizing, installation, workflow/model setup, benchmarks, recovery tests, documentation and handover |
| Voice add-on / Security Review | Quoted | Voice is a separately scoped Managed add-on; security work requires written system-specific authorization |

Connector maintenance after the build belongs to the applicable Managed scope, not a second maintenance bill. Private AI equipment is normally bought by the customer or passed through at cost. Cancellation of support should leave the functional self-managed local deployment where technology/licensing permits. A complete Private AI build is never quoted below the existing $10,000 floor without a newly authorized scope change; smaller hardware planning and setup services are not a full deployment.

Scope work to the existing $100–$150/hour delivery floor, including preparation, travel, review, rework and follow-up. A starting fee is not unlimited hours: at $150/hour the current pilot implies about 26.7 hours, implementation 60 hours and an additional location 16.7 hours. Requote scope rather than absorb uncontrolled work. Private AI's normal $15,000 engagement is scoped around 100 hours at that planning rate; complexity can require a larger quote. Product-development overruns benefiting Diomedes generally are not automatically customer charges.

The existing first three-location restaurant design-partner exception is preserved: reference value approximately $4,500, discounted bounded pilot $1,500–$2,500 depending on scope, one approved workflow, discovery/implementation/handoff/measurement and approximately 30 days monitored operation as agreed. It is an exception for learning value, not the standard list price. Public case studies, names, logos and testimonials need separate permission; positive feedback is never required.

A $500 hardware/model assessment may be credited toward qualifying Private AI work started within 30 days. Up to $500 of a paid audit may be credited toward a qualifying pilot within 30 days where stated in the accepted quote. Credits do not stack unless approved and do not charge the same fee twice. Other internal strategic Private AI ranges are scope guidance, not new public constants.

## Credits and flat job caps

Credits measure cumulative eligible AI usage, not a task or model-call count. A job can consume fractional credits or many credits. Include authorized planner, worker, reviewer, advisor, billed reasoning, cache and eligible correction usage. The current website conversion is internally $0.10 of eligible inference per credit; do not render the internal dollar allowance as public plan copy.

Preserve three distinct quantities: provider cost, customer allowance debit and customer invoice. Production accounting uses integer micro-USD and a versioned rate card. Cloud promotional credits lower company cash expenditure, not the customer's published grant or the gross provider cost record. Do not discount the funded-usage portion under the existing 30% founding discount; only its eligible non-usage component is discounted.

Retain a finite flat spending cap per parent request/job. This is an approval/safety limit, not a flat fee or monthly request quota. Exact default caps remain unapproved. A suggested 20-credit default is only an internal proposal; larger jobs can receive another explicitly approved finite cap. Reserve conservatively before each paid child operation against both job budget and organization funds. Delegation, retries, forks, resumed messages and billing reset cannot reset the cap or refund uncertain spend.

Settle from validated actual usage; release only proved unused holds. Missing usage is unknown, not zero. Record product-fault corrections as company expense without disguising the real upstream cost. No automatic overage, silent downgrade, unapproved payer switch or automatic top-up. Customer BYO/local work does not debit company-funded credits; personal subscriptions are terms-bound individual access, not pooled company inventory. Unpriced third-party tool charges require a separate bounded, authorized arrangement before admission.

The old literal 1,000-request promise and universal tiny per-request monetary ceiling are withdrawn. Human support, hosting and third-party non-inference services remain separately scoped rather than silently reclassified as inference.

## Working preferences and advanced controls

Efficient is Luna-led for everyday conversation, brainstorming and deciding when delegation is needed. Focused remains Sol-primary; qualified Muse Standard is an explicit lower-cost preference or policy-approved backup. Thorough uses Opus 5.5 for demanding reasoning and checks. These are initial policies, not permanent vendor entitlements. Task-specific quality and accepted-result cost determine qualified alternatives.

Every preference may delegate suitable bounded steps to cheaper qualified models, including Luna, under the same parent budget and source/permission restrictions. An expensive lead need not write every token. Luna need not rewrite a careful premium conclusion. Working preference is separate from Ask/Plan/Build authority, model ID, payer and persona; changing it cannot grant new permissions.

Managed inference is the recommended default. Users requesting expert controls may expose the model picker, including eligible BYO users. Clearly distinguish lead-only pinning from all-call pinning; honor a no-substitution choice. Details show actual model, route, payer and usage. Supporting expert control is not permission to obstruct BYO or silently charge the company when a personal route fails.

## Meta Contributor consent

Default off. Contributor and Standard are separate data-policy routes even when the model is otherwise similar. Ask an authorized owner/admin to permit Meta's use of prompts, responses and permitted source content submitted through Contributor to improve/train models. Record exact route, terms revision, data/project scope and effective date. An owner cannot donate material without rights; employee/customer and third-party restrictions still apply. Derived summaries, memories, excerpts and tool results retain source restrictions.

Check consent again at dispatch, including queued work. Revocation blocks future sending; do not promise retroactive untraining or recovery of already disclosed data. No silent fallback into Contributor. Offer the standard-processing alternative without coercion.

Lower component rates do not mean ten times the monthly grant or ten times every completed job. Publish a numeric savings claim only with its qualified route, explicit comparison baseline and measured workload scope. Unchanged workers, reviews, tools and failures dilute whole-job savings. Provider terms and regional eligibility need review before this route is offered.

## Included everyday chat on eligible Managed plans

Owner direction: normal human Luna conversation in Ask on eligible Managed Small/Standard/Plus plans should have zero credit debit. Use an explicit entitlement, not a test that an invoice happens to exceed $750; Fractional AI Ops and one-time services do not qualify on their own.

Ordinary questions, brainstorming and bounded use of existing context can qualify. Delegated workers, automation, batch processing, larger document jobs, paid research/tools and premium-model calls remain metered even when read-only or named Ask. A Luna worker inherits the paid job's accounting class, not conversational eligibility. Explain and obtain approval at the boundary before paid work.

Provider cost remains real and is recorded separately. Define and disclose reasonable context/output/rate/concurrency and abuse rules. Do not advertise unlimited conversation while hiding a monthly message quota or introducing unapproved overage. Included chat is a proposed product entitlement until its server-side eligibility, cost exposure and user-visible boundary are tested and released.

## Nectovia usage display

Show settled monthly debit divided by the month's included grant as the monthly used percentage. Display pending and uncertain reservations separately, along with remaining monthly funds, reset date and data freshness. Top-ups have a separate balance and do not change the monthly percentage denominator. BYO cost and zero-debit included chat do not consume the monthly bar. Unknown/stale balance is not zero. Reservations retain their original billing period across reset; final settlement cannot debit the wrong month.

## Existing service responsibilities and design scope

Business retains its design consultation and first look, plus up to two revisions each subscription year for the agreed initial design or major updates, and customer-operated Design Center. Internal planning target: roughly two initial hours and one hour per revision, not a customer hour promise. Managed adds a session every two months inside its stated support allowance. New brand creation, print, signage, photography and design for other software remain separate. Solo does not inherit these human services.

Managed covers named systems, agreed checks, compatibility triage, routine repairs and limited support. Third-party outages, major redesigns, new integrations, credential-policy changes and material rebuilds can require a new scope. No unstaffed 24/7 response, automatic SLA, security certification or guarantee that vendors never change. Travel/site time and direct expenses are quoted; no assumed free geographic radius. Customers supply lawful data/access, approve authority and provide a responsible owner.

Initial workflows continue to avoid autonomous payroll, payments, hiring/firing/discipline, unapproved orders and unapproved public posting. Export-based workflows remain valid where live API access is unnecessary. Tenant isolation, least privilege, retention/offboarding and evidence are still required.

## Architecture and implementation status

Extend the existing Vercel AI SDK ModelAdapter for explicit AWS Bedrock, Azure and OpenRouter connections, plus other qualified hosts. The SDK does not pool balances, supply credentials or verify credit eligibility. Select a qualified model first, then an authorized account/payer/processing route. Preserve NativeAgent/RunService/Trust, provider-bound private continuation and no implicit fallback.

TypeSafe Jev is a bounded advisory/evaluation model. Reuse `shared/evaluation.ts`, `server/harness/evaluation-adapter.ts` and price/usage seams; verify the real installed SDK/provider contract. Jev does not approve effects, change permissions, execute tools or make confidence equal correctness.

The account-control-plane subset already uses WorkOS and a Neon-specific PostgreSQL adapter. Keep it in this rollout. The reported $300 Supabase offer is a reason to evaluate an appropriate later storage need, not permission to migrate identity, data or the ledger. No second task/run source of truth or automatic cloud upload of customer documents.

At inspected app main `c10b7b2fa3ba12e9bba9373ac3ff82db8447b820`, the bounded AWS route still identifies GPT-5.6 Luna. New model versions, multi-provider customer funding, Contributor consent, included chat, Solo and paid metering need independent acceptance. Existing `sellable: false` safeguards remain until the relevant gates pass. This documentation change does not run application tests or prove deployment.

Implementation handoff: `../implementation/2026-09-22-nectovia-routing-handoff.md`. The September 22 amended unified execution package carries detailed Opus/SWE 2.0/Fable/Astra prompts and source evidence. Preserve active claims and original completion records.
