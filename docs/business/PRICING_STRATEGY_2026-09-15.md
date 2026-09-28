# Nectovia pricing and service scope

Version: NC-2026-09-28.1. Commercial inference policy reconciled with current GitHub main and the canonical Drive pricing/service-scope document. First issued September 15, 2026.
Status: approved commercial direction, not proof of deployed billing or provider qualification.
Canonical commercial authority: [Nectovia pricing and service scope](https://docs.google.com/document/d/1OrjI7NCBf4YRt2TGgBvPS52GW8LM3hgXCnN6lp7sxIQ/edit). This public repository omits private company economics.

Nectovia is the product. Diomedes is the company. Customer-facing product text says Nectovia; company, legal and repository identifiers keep Diomedes.

Andrew's current managed-inference decision and the canonical Drive Individual amendment replace the stale funding and Solo terms here. Other existing offer/service anchors are preserved. The September 23 routing decisions continue to supersede source package NC-2026-09-22.1 and PR #35 where they differ. Nothing under "Superseded 2026-09-23" is operative. Historical source and qualification observations below are dated evidence, not current release certification.

Every term here is **approved** (an owner decision, with its date), **proposed** (not approved; never build or sell it as an entitlement), **withdrawn** (the owner rejected it) or **superseded** (replaced by a newer approved rule, named beside it). An approved commercial term is not an implemented or qualified one.

## Status of terms

| Term | Status | Source and date |
|---|---|---|
| Recurring offers, published prices and monthly grants (Starter 500, Business 1,000, Managed 3,000 / 5,000 / 8,000; Managed grants are totals) | approved | Owner direction 2026-09-22; website registry `8c1dcef` |
| Professional service anchors and the $100–$150/hour delivery floor | approved | Owner direction 2026-09-22; website registry `8c1dcef` |
| Credits measure cumulative eligible usage under the recorded rate card | approved | Owner direction 2026-09-22; public wording reconciled 2026-09-28 |
| Managed inference preferred; included allowance first; authorized additional usage at Nectovia's current usage rate | approved | Owner direction 2026-09-28 |
| Organization-authorized monthly extra-usage cap; alerts at 75%, 90% and 100%; no silent overage | approved policy; postpaid enforcement not implemented | Owner direction 2026-09-28 |
| Customer-owned commercial API/cloud credentials only through Advanced or a specific contract; no pooled subscription-funded Agent work | approved | Owner direction 2026-09-28 |
| Literal 1,000-request quota and universal tiny per-request ceiling | withdrawn | Owner direction 2026-09-22 |
| Customers see only the tiers Efficient / Focused / Thorough; the owner maps each tier to a route in AI setup | approved | Owner decision 2026-09-23 |
| Owner-only model override for testing | approved | Owner decision 2026-09-23 |
| Customer expert model picker (including for BYO users), lead-only / all-call pinning and no-substitution choices | withdrawn | Owner decision 2026-09-23 |
| Efficient: GPT-6 Luna on AWS Bedrock | approved (route not live-qualified) | Owner decision 2026-09-23 |
| Focused: Gemini 3.8 Flash on Google Cloud Vertex AI (sign-in: a Vertex API key; local ADC is the alternative) | approved (route not live-qualified) | Owner decision 2026-09-23 |
| Thorough: GPT-6 Sol on AWS Bedrock | approved (route not live-qualified) | Owner decision 2026-09-23 |
| Sol-primary Focused, optional Muse Standard, Opus 5.5-led Thorough | superseded | Replaced by owner decision 2026-09-23 |
| Parent-job credit caps: Efficient 20, Focused 50, Thorough 100 | approved | Owner decision 2026-09-23 |
| Pre-send warning when likely use exceeds the cap: move up a tier, or go over for that one job | approved | Owner decision 2026-09-23 |
| Single suggested 20-credit default job cap | superseded | Replaced by owner decision 2026-09-23 |
| Jev pathway is OpenRouter | approved (route not live-qualified) | Owner decision 2026-09-23 |
| Subscription-backed external engines may supply search only for their licensed user/device where the provider permits it; no pooled organizational subscription use | approved | Owner decisions 2026-09-23 and 2026-09-28 |
| Threads allow Build and Fix on the model-API routes | approved | Owner decision 2026-09-23 |
| Product name Nectovia; company name Diomedes | approved | Owner decision 2026-09-23 |
| Provider routes exist because each provider gave trial credits; the company's provider-credit dashboard is private and never customer-facing | approved | Owner decision 2026-09-23 |
| Usage contract `nectovia-usage/1` (token totals, unknown usage, three domains, five separate values) | approved | Owner decision 2026-09-23 |
| Three-quantity accounting (provider cost / allowance debit / invoice) | superseded (the three stay distinct inside the five values) | Extended by `nectovia-usage/1`, owner decision 2026-09-23 |
| Individual at $200/month with 1,000 monthly credits for one named person; launch eligibility and availability require verification | approved direction | Canonical Drive NC-IF-2026-09-27.1; replaces Solo proposal |
| $500 Business Plus / 2,000 credits | proposed | Assistant proposal; still open 2026-09-23 |
| Included everyday Luna chat on eligible Managed plans, and its debit class | proposed | Owner direction 2026-09-22; still open 2026-09-23 |
| Meta Contributor consent route | proposed | NC-2026-09-22.1; still open 2026-09-23 |
| Plan-document parity question | open (proposed) | Owner list 2026-09-23 |
| Live-provider qualification of every route | open: no route has had a live call | Owner list 2026-09-23 |
| Context, concurrency and seat limits; rollover/expiry terms; included-chat safeguards | proposed | Unresolved terms retained; managed extra-usage policy is settled below |
| Supabase migration | not authorized | NC-2026-09-22.1 |

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

### Individual: current commercial direction

The canonical Drive amendment NC-IF-2026-09-27.1 approves Individual at $200/month with 1,000 monthly credits for one named human. It replaces the former Solo proposal. Preserve current launch safeguards until checkout, contractual eligibility and runtime entitlement are verified; a document does not activate a plan.

Individual covers personal work and qualifying solo sole-proprietor work. Staffed-business or employer operations and persistent client-organizational deployments require Business even when one person signs in. Product entitlement, inference payer and computer permissions remain separate.

Individual does not add team operations, maintained integrations, on-site work or human design services. Free direct-engine/local use remains separate. Customer-owned commercial API/cloud routes are Advanced or contract-specific; subscription-backed external engines remain personal and terms-bound. The previously suggested Business Plus offer remains unapproved.

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

## Managed inference and additional usage

Nectovia-managed inference is the default and preferred funding path for paid Nectovia Agent work. Diomedes Systems manages qualified commercial API/cloud routes. Use the included monthly allowance first, then previously purchased managed usage. Additional eligible managed usage is billed at **Nectovia's current usage rate** under the applicable, recorded customer rate card.

Extra usage is opt-in. An active organization owner or an explicitly authorized billing administrator must accept the applicable rate, currency, billing period and a finite monthly charge cap before it can run. Default authorization is off. Record the actor, organization, rate revision, cap, effective period and revocation. A task approval, plan purchase, higher job cap or exhausted allowance is not overage consent. No automatic top-up, silent renewal of a one-time authorization, retroactive rate change or implicit payer switch.

Warn at 75%, 90% and 100% of the included allowance and, when enabled, the authorized extra-usage cap. Count settled usage plus pending and uncertain reservations. Before each call, enforce the job limit, available funds and applicable organization charge cap atomically. At the cap, stop new managed calls; an alert is not permission to exceed it. Preserve reservations across retries, workers, restarts and period changes.

Private company economics, provider costs, promotional balances, markup formulas and credit-to-provider-cost derivations are not public plan copy, customer API fields or invoice explanations. The private commercial rate card records standard pricing and any approved negotiated contract exception. Customers still receive an understandable usage statement, the applicable customer rate, their authorized limit and an accurate invoice. Existing charges keep their recorded customer rate.

Provider promotional credits and discounts belong to company economics. They do not create a customer discount, lower the customer's debit or invoice, increase the published allowance or erase gross provider cost evidence. Expected promotions and confirmed applications remain distinct.

Implementation boundary: current funding admission consumes the monthly allowance before verified purchased top-ups and refuses unfunded calls. It does not implement postpaid organization overage authorization, charge-cap enforcement or cap notifications. Keep postpaid overage unavailable until all of those are enforced by the server. Account/AI Setup may explain the policy and direct an authorized customer to arrange additional usage; it must not offer an unenforced activation switch. The usage panel's allowance warnings are advisory and do not grant funds.

## Advanced accounts and external engines

Customer-owned commercial API or cloud credentials remain supported only as an optional **Advanced / contract-specific** route. Do not recommend that customers buy inference elsewhere during normal setup or make a provider-key form the primary action. Preserve supported configurations and explicit payer selection; neither a key nor a cloud account grants Nectovia entitlement. This usage is billed by the customer's provider and does not debit Nectovia-funded credits. A failure never silently falls back to another payer.

Consumer, Pro, Max, Team, Business and similar subscription accounts must not fund pooled or shared organization-wide Nectovia Agent inference, including workers, background jobs and search. A provider-permitted subscription-backed external engine may serve only its licensed user on that user's device. The engine owns authentication; no extraction, proxying or sharing of its subscription credentials. This is a Nectovia product boundary, not a claim that providers prohibit all business use of their products.

Entitlement, payer, processing policy, provider cost, customer debit and invoice remain separate decisions and records. Advanced visibility does not authorize routing changes, spending, broader data access or subscription pooling. Ordinary customers still select work tiers rather than provider models.

## Credits and parent-job caps

Credits measure cumulative eligible AI usage, not a task or model-call count. A job can consume fractional credits or many credits. Include authorized planner, worker, reviewer, advisor, billed reasoning, cache and eligible correction usage under the applicable rate card. Do not publish the internal provider-cost conversion as plan copy.

Accounting follows the usage contract `nectovia-usage/1` below. Production accounting uses integer micro-USD and a versioned rate card. Cloud promotional credits lower company cash expenditure, not the customer's published grant or the gross provider cost record. Do not discount the funded-usage portion under the existing 30% founding discount; only its eligible non-usage component is discounted.

**Approved 2026-09-23: each parent job has a finite credit cap set by its tier.**

| Tier | Parent-job cap |
|---|---:|
| Efficient | 20 credits |
| Focused | 50 credits |
| Thorough | 100 credits |

The cap is an approval/safety limit, not a flat fee or monthly request quota. Before sending, when likely use exceeds it, offer a higher tier or an explicitly approved finite cap for that one job. The change does not alter the next job's cap, authorize organization overage or increase remaining funds. Nothing overruns a cap without that pre-send choice.

Reserve conservatively before each paid child operation against both the job budget and organization funds. Delegation, retries, forks, resumed messages and billing reset cannot reset the cap or refund uncertain spend.

Settle from validated actual usage; release only proved unused holds. Missing usage is unknown, not zero. Record product-fault corrections as company expense without disguising the real upstream cost. No automatic overage, silent downgrade, unapproved payer switch or automatic top-up. Customer BYO/local work does not debit company-funded credits; personal subscriptions are terms-bound individual access, not pooled company inventory. Unpriced third-party tool charges require a separate bounded, authorized arrangement before admission.

The old literal 1,000-request promise and universal tiny per-request monetary ceiling are withdrawn. Human support, hosting and third-party non-inference services remain separately scoped rather than silently reclassified as inference.

## Usage contract `nectovia-usage/1`

Approved 2026-09-23.

- `inputTokens` is total input, including cache. Cache reads and cache writes are parts of `inputTokens`, reported within it, never added on top of it.
- `outputTokens` is total output, including reasoning. Reasoning is reported within it, never added on top of it.
- Missing usage is unknown, never zero. An unknown value is displayed and settled as unknown, and its hold stays in place until reconciled.
- Three domains stay separate, with separate records and access:
  1. provider cost evidence (what a provider reported or billed for a call);
  2. customer entitlement and debit (what the customer's plan allows and what was debited against it);
  3. the company's private provider-credit dashboard.
- Five values stay separate and are never merged into one number: estimated gross cost, expected promotions, confirmed credit application, customer debit and invoice.

An expected promotion is not a confirmed credit application, and neither changes the customer debit or the gross cost record.

## Tiers and routing

Approved 2026-09-23. Customers never choose routing or models. Every picker shows only three tiers: **Efficient**, **Focused** and **Thorough**. The owner maps each tier to a route in AI setup. An owner-only override exists for testing; it is never exposed to customers.

| Tier | Owner's current route |
|---|---|
| Efficient | GPT-6 Luna on AWS Bedrock |
| Focused | Gemini 3.8 Flash on Google Cloud Vertex AI (sign-in: a Vertex API key; local ADC is the alternative) |
| Thorough | GPT-6 Sol on AWS Bedrock |

None of these routes has had a live call. Each needs live-provider qualification before any customer use, and the app at `c10b7b2` still binds the older GPT-5.6 Luna AWS route (see "Architecture and implementation status").

Every tier may delegate suitable bounded steps to cheaper qualified models, including Luna, under the same parent budget and source/permission restrictions. An expensive lead need not write every token. Luna need not rewrite a careful premium conclusion. A tier is separate from Ask/Plan/Build authority, model ID, payer and persona; changing it cannot grant new permissions. Details show the actual model, route, payer and usage.

Threads allow Build and Fix on the model-API routes (approved 2026-09-23), within the same Mode authority and Trust mediation as every other route.

Subscription-backed external engines may supply web search only for their licensed user/device where the provider permits it. They cannot fund shared organizational Agent search. If no qualified, authorized search route exists, refuse it; this policy does not authorize a new paid search API.

The provider routes exist because each provider gave trial credits (approved 2026-09-23). Which provider credits the company holds, and how much remains, lives only in the company's private provider-credit dashboard, which is never customer-facing. Credits from one provider never pay for another provider's route.

Managed inference is the default and preferred path. Supported customer-owned API/cloud configuration belongs under Advanced or a specific contract; never switch its payer implicitly.

## Meta Contributor consent (PROPOSED)

Proposed, not approved; still open 2026-09-23. The approved 2026-09-23 tier map contains no Muse route, so this consent route has no approved tier position. Do not build it as an entitlement or present it to customers until the owner approves it.

Default off. Contributor and Standard are separate data-policy routes even when the model is otherwise similar. Ask an authorized owner/admin to permit Meta's use of prompts, responses and permitted source content submitted through Contributor to improve/train models. Record exact route, terms revision, data/project scope and effective date. An owner cannot donate material without rights; employee/customer and third-party restrictions still apply. Derived summaries, memories, excerpts and tool results retain source restrictions.

Check consent again at dispatch, including queued work. Revocation blocks future sending; do not promise retroactive untraining or recovery of already disclosed data. No silent fallback into Contributor. Offer the standard-processing alternative without coercion.

Lower component rates do not mean ten times the monthly grant or ten times every completed job. Publish a numeric savings claim only with its qualified route, explicit comparison baseline and measured workload scope. Unchanged workers, reviews, tools and failures dilute whole-job savings. Provider terms and regional eligibility need review before this route is offered.

## Included everyday chat on eligible Managed plans (PROPOSED)

Proposed, not approved; still open 2026-09-23. Both the entitlement and its debit class are proposals.

Owner direction of 2026-09-22: normal human Luna conversation in Ask on eligible Managed Small/Standard/Plus plans should have zero credit debit. Use an explicit entitlement, not a test that an invoice happens to exceed $750; Fractional AI Ops and one-time services do not qualify on their own.

Ordinary questions, brainstorming and bounded use of existing context can qualify. Delegated workers, automation, batch processing, larger document jobs, paid research/tools and premium-model calls remain metered even when read-only or named Ask. A Luna worker inherits the paid job's accounting class, not conversational eligibility. Explain and obtain approval at the boundary before paid work.

Provider cost remains real and is recorded separately. Define and disclose reasonable context/output/rate/concurrency and abuse rules. Do not advertise unlimited conversation while hiding a monthly message quota or introducing unapproved overage. Included chat stays a proposed product entitlement until the owner approves it and its server-side eligibility, cost exposure and user-visible boundary are tested and released.

## Nectovia usage display

Show settled monthly debit divided by the month's included grant as the monthly used percentage. Display pending and uncertain reservations separately, along with remaining monthly funds, reset date and data freshness. Top-ups have a separate balance and do not change the monthly percentage denominator. BYO cost does not consume the monthly bar, nor would zero-debit included chat if that proposal is approved. Unknown/stale balance is not zero. Reservations retain their original billing period across reset; final settlement cannot debit the wrong month. The customer display never shows the company's private provider-credit dashboard, its provider-credit balances or its expected promotions.

## Existing service responsibilities and design scope

Business retains its design consultation and first look, plus up to two revisions each subscription year for the agreed initial design or major updates, and customer-operated Design Center. Internal planning target: roughly two initial hours and one hour per revision, not a customer hour promise. Managed adds a session every two months inside its stated support allowance. New brand creation, print, signage, photography and design for other software remain separate. Individual does not inherit these human services.

Managed covers named systems, agreed checks, compatibility triage, routine repairs and limited support. Third-party outages, major redesigns, new integrations, credential-policy changes and material rebuilds can require a new scope. No unstaffed 24/7 response, automatic SLA, security certification or guarantee that vendors never change. Travel/site time and direct expenses are quoted; no assumed free geographic radius. Customers supply lawful data/access, approve authority and provide a responsible owner.

Initial workflows continue to avoid autonomous payroll, payments, hiring/firing/discipline, unapproved orders and unapproved public posting. Export-based workflows remain valid where live API access is unnecessary. Tenant isolation, least privilege, retention/offboarding and evidence are still required.

## Architecture and implementation status

Extend the existing Vercel AI SDK ModelAdapter with explicit connections for the approved routes: AWS Bedrock (GPT-6 Luna, GPT-6 Sol), Google Cloud Vertex AI (Gemini 3.8 Flash; sign-in by a Vertex API key, with local ADC as the alternative) and OpenRouter (Jev). Azure is not in the approved 2026-09-23 map; no current rule depends on an Azure route. Other qualified hosts use the same registry. The SDK does not pool balances, supply credentials or verify credit eligibility. The owner's tier map selects the model and route; then an authorized account/payer/processing route is bound. Preserve NativeAgent/RunService/Trust, provider-bound private continuation and no implicit fallback.

TypeSafe Jev is a bounded advisory/evaluation model, reached through OpenRouter (approved 2026-09-23). Reuse `shared/evaluation.ts`, `server/harness/evaluation-adapter.ts` and price/usage seams; verify the real installed SDK/provider contract. Jev does not approve effects, change permissions, execute tools or make confidence equal correctness.

The account-control-plane subset already uses WorkOS and a Neon-specific PostgreSQL adapter. Keep it in this rollout. The reported $300 Supabase offer is a reason to evaluate an appropriate later storage need, not permission to migrate identity, data or the ledger. No second task/run source of truth or automatic cloud upload of customer documents.

The earlier routing observation at `c10b7b2fa3ba12e9bba9373ac3ff82db8447b820` is historical and does not establish today's provider qualification. This reconciliation inspected main `66334d512ef51c808d460b6e177690d87ecfaaa0`: funded reservation/settlement and purchased top-ups exist; postpaid organization overage does not. Preserve launch safeguards and require separate acceptance for billing activation, Individual eligibility, live routes and any proposed Contributor or included-chat benefit. Source verification is recorded in `../implementation/2026-09-28-managed-inference-policy.md`; it is not deployment evidence.

Implementation handoff: `../implementation/2026-09-22-nectovia-routing-handoff.md`. The September 22 amended unified execution package carries detailed role prompts and source evidence; where it differs from the 2026-09-23 decisions recorded here, this document wins. Preserve active claims and original completion records.

## Superseded 2026-09-23

Kept as history. None of these rules is operative. Each is followed by what replaced it.

- **Job caps.** Superseded: "Exact default caps remain unapproved. A suggested 20-credit default is only an internal proposal; larger jobs can receive another explicitly approved finite cap." Replaced by: approved tier caps (Efficient 20, Focused 50, Thorough 100) and the pre-send warning dialog offering a move up a tier or going over for that one job.
- **Three accounting quantities.** Superseded: "Preserve three distinct quantities: provider cost, customer allowance debit and customer invoice." Replaced by: `nectovia-usage/1`, which keeps three domains (provider cost evidence; customer entitlement and debit; the private provider-credit dashboard) and five separate values (estimated gross cost, expected promotions, confirmed credit application, customer debit, invoice).
- **Working preferences.** Superseded: "Efficient is Luna-led for everyday conversation, brainstorming and deciding when delegation is needed. Focused remains Sol-primary; qualified Muse Standard is an explicit lower-cost preference or policy-approved backup. Thorough uses Opus 5.5 for demanding reasoning and checks." Replaced by: the owner's tier map, Efficient GPT-6 Luna on AWS Bedrock, Focused Gemini 3.8 Flash on Google Cloud Vertex AI, Thorough GPT-6 Sol on AWS Bedrock.
- **Customer expert controls.** Superseded: "Users requesting expert controls may expose the model picker, including eligible BYO users. Clearly distinguish lead-only pinning from all-call pinning; honor a no-substitution choice." Replaced by: customers never choose routing or models; pickers show only the three tiers; the owner maps tiers in AI setup; an owner-only override remains for testing.
- **Provider set.** Superseded: "Extend the existing Vercel AI SDK ModelAdapter for explicit AWS Bedrock, Azure and OpenRouter connections, plus other qualified hosts." and "Select a qualified model first, then an authorized account/payer/processing route." Replaced by: the approved routes on AWS Bedrock, Google Cloud Vertex AI and OpenRouter (Jev), selected by the owner's tier map. Azure is not withdrawn, but no current rule depends on it.
- **Product name.** Superseded: title "Diomedes / Nectovia pricing and service scope" and "Nectovia is the customer-facing experience in this work; repository/company identifiers are not globally renamed here." Replaced by: Nectovia is the product, Diomedes is the company.
