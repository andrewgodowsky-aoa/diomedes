# Diomedes Pricing & Services — Working Draft

**Version:** 2026-09-10.2  
**Status:** Approved launch-price hypothesis for public framing; services and unshipped software capabilities remain subject to availability/scope  
**Cloud companion:** Google Doc `11EjZfmFpx0pKpISeS0s63aHr9pQLdb8d8r5UhoOaiZQ`

## Pricing thesis

Diomedes sells saved coordination, configured capability, and eventually trusted autonomous operation — not token resale.

The entry point should be easy for a business that does not know Diomedes or its founder yet. Discovery is free; the first paid yes is deliberately small; implementation work is priced high enough to respect the time/support burden; recurring software is inexpensive compared with the management capacity it should eventually return.

Core permissions, rules, attribution, drift checks, recovery, evidence, and auditability are trust foundations, not premium safety add-ons.

Hardware, third-party subscriptions, API usage outside an included Diomedes allowance, travel, unusual licensing, and major custom integration work are disclosed separately before work begins.

Early design partners may receive private credits/waivers. Do not advertise that Diomedes is currently free. When practical, show the standard price and a separate founding/design-partner credit so the work retains a stated value.

## Approved launch service anchors

### Workflow Fit Call — first 60 minutes free

A no-obligation conversation to understand the business, the recurring work that consumes time, existing systems, and whether there is a sensible first problem to solve. The goal is diagnosis, not a one-hour product demo.

After the included hour, focused consulting is **$100/hour** when the client wants continued strategy, troubleshooting, model/tool comparison, or work outside a fixed project.

### Quick Start — Cloud AI — $299 fixed

One supported cloud/subscription route configured with Diomedes, baseline permission/rule settings, a small number of ordinary connections where supported, one useful working example, and handoff. This is not a promise of arbitrary custom OAuth/MCP work or multi-user production deployment.

### Workflow Audit / Weak Point Map — $350 fixed

A written review of one meaningful workflow: where time is spent, current tools/data, automation fit, risk boundaries, candidate improvements, and a recommended next step. If a client proceeds quickly into a larger pilot, a portion may be credited toward that work; current recommended credit is **$200 toward a $1,250+ pilot within 30 days**.

### Local AI Hardware & Model Plan — $249 fixed

Assess current hardware, workload, privacy/latency needs, expected concurrency, and local/cloud/hybrid fit. Deliver a hardware tier recommendation, model/runtime shortlist, expected tradeoffs, storage/power considerations, and purchasing specification. Recommended policy: **credit the $249 toward a qualifying local deployment** when the client proceeds.

The client normally purchases hardware directly; Diomedes Systems should not initially make money by recommending a more expensive GPU.

### Local AI Deployment — from $749 + hardware

For one existing or newly purchased machine: install/configure a supported local runtime and model, tune context/offload/memory/concurrency, integrate it with Diomedes where supported, benchmark the actual machine, configure lifecycle/updates, document the setup, and train the owner/admin.

Shared/team/networked local deployments start around **$1,250+** and increase with access-control, networking, uptime, multi-user, and support requirements.

### Workflow Pilot — from $1,250

One bounded, measurable workflow using agreed data and authority boundaries. Includes baseline measurement, configuration/build, testing or shadow period where appropriate, handoff/training, and a keep/revise/kill review.

### Broader Implementation — from $2,500

Multiple connected workflows, integrations/capabilities, business workspace configuration, permission/rule design, deployment, documentation, and training. Production-sensitive or multi-system work is quoted after discovery.

### Managed Diomedes — from $249/month

Ongoing maintenance/support after a working deployment: defined health/reliability checks where supported, model/provider/runtime updates, periodic review, a small support allowance, and measured optimization. This is not unlimited consulting or unlimited emergency support.

More active build/optimization/support relationships should be quoted above the entry tier rather than squeezed into $249/month.

## Initial software / agent pricing direction

### Diomedes Business — target from $99/month per organization

The business workspace/harness and paid-account access to the Diomedes Agent as those capabilities become production-ready. Expected value includes rules/permissions, durable work/history, routing, integrations, local/BYO routes, audit/evidence, and organization controls as shipped.

Do not advertise unshipped capabilities as present. Until a paid plan is generally available, the site may show the intended `from $99/month` price as a pricing guide or planned business price without saying that current access is free.

### Hosted Diomedes Agent — included only on paid accounts, within explicit plan limits

Initial Diomedes-Agent cognition may be supplied by a low-cost API model paid through Diomedes Systems' provider account. Candidate routes include models such as DeepSeek V4 Flash, GLM-5.3-Flash, Muse Spark 1.3, or another provider that wins Diomedes-specific quality/cost/privacy evaluations.

The public product contract is provider-agnostic. Do not promise one foundation model permanently. Diomedes owns the supervisory behavior, Runtime/Trust semantics, routing, rules, evidence, and user experience; the inference route may change within the plan's disclosed quality/privacy/billing policy.

Hosted Diomedes inference is **not available to unpaid accounts** under the current commercial direction. Paid plans should include a bounded reasonable allowance rather than promise unlimited inference. Heavy/continuous hosted usage can later receive a higher allowance, metering, or a negotiated plan once actual workload economics are measured.

Do not use a provider's training/data-contribution discount for private business data merely because it is cheaper. A route that permits provider training on prompts/completions requires an explicit, lawful data policy and customer authorization; the safe default for business data is a provider route whose commercial/privacy terms fit the deployment.

Before charging customers for included inference, verify that the selected provider's current API/commercial terms permit the intended embedded/resold service. Technical API access alone is not sufficient authorization.

### Local Diomedes Agent

A compatible local supervisor can be included with the applicable paid software when production-ready. The customer supplies the hardware and local inference, while the subscription pays for the Diomedes harness/agent semantics, rules, routing, updates, evaluations, lifecycle management, integrations, and business workspace.

### Hybrid Diomedes Agent

Likely the strongest long-term default for many businesses: routine supervisory work local or on an inexpensive hosted route, with stronger specialists called selectively under explicit rules and budgets. `Hybrid` must never mean silent paid-cloud fallback.

## Rough hosted-inference economics

These examples exist for internal pricing discipline, not public promises. Provider pricing changes and must be rechecked before launch.

As of September 10, 2026:

- DeepSeek V4 Flash official API pricing uses peak/off-peak rates. Current list: cache-miss input $0.22/M off-peak or $0.44/M peak; output $0.66/M off-peak or $1.32/M peak. <https://api-docs.deepseek.com/quick_start/pricing/>
- GLM-5.3-Flash list pricing after its launch promotion is approximately $0.15/M input and $0.50/M output; recheck Z.ai's live rate card before budgeting. <https://docs.z.ai/guides/overview/pricing>
- Meta Muse Spark 1.3 Standard is reported at $1.25/M input and $4.25/M output; its much cheaper Contributor tier trades price for provider training rights and is not a default route for client-private data. Recheck first-party terms/rates before use.

Illustrative 20M input + 4M output supervisor usage per month:

- GLM-5.3-Flash at list rates: about $5.
- DeepSeek V4 Flash: about $7 off-peak to $14 peak.
- Muse Spark 1.3 Standard: about $42.

Illustrative 50M input + 10M output per month:

- GLM-5.3-Flash: about $12.50.
- DeepSeek V4 Flash: about $17.60 off-peak to $35.20 peak.
- Muse Spark 1.3 Standard: about $105.

These numbers support a $99/month entry plan only if Diomedes meters usage, routes efficiently, caches/reuses context where appropriate, limits pathological retries, and chooses provider routes based on success-adjusted cost rather than headline token price.

## What the business is paying for

The commercial target is not another chat subscription. Diomedes is intended to become the operational brain across the business's existing tools: assemble the right context, route work, enforce scopes/rules, watch for drift, recover from routine failures, coordinate deterministic automation and models, request human judgment only when needed, verify outcomes, and retain evidence/history.

Diomedes should usually sit above/between existing systems rather than replace every system of record. A restaurant may keep its POS, scheduling, reservations, inventory/back-office and accounting platforms. A construction company may keep its project-management, estimating, accounting, email/document and field systems. The value is reducing the manual coordination between them.

## What I/Diomedes Systems manage in a typical engagement

- Discovery and selection of one useful workflow.
- Cloud/local/hybrid model and engine recommendation.
- Diomedes installation/configuration and supported integrations.
- Permission scopes, standing rules, approval boundaries, and drift/correction behavior.
- Local hardware/model selection and tuning when local AI is chosen.
- Testing/benchmarking and a clear handoff.
- Documentation and user/admin training.
- Ongoing updates/health review only when Managed Diomedes is purchased.

The client remains responsible for business decisions, purchasing hardware/third-party services, designating authorized users/data/actions, and maintaining vendor accounts/terms unless a written engagement says otherwise.

## Market anchors — software businesses already buy

These are context, not direct feature-for-feature competitors.

### Restaurants / hospitality

- **Toast:** core Point of Sale currently starts at **$69/month** for a single location; broader configurations are custom, and hardware, payment processing and add-ons can add cost. <https://pos.toasttab.com/pricing>
- **Square:** restaurant software currently lists **$0 / $49 / $149 per location per month** for Free / Plus / Premium, plus payment processing. Square Restaurant Inventory by MarketMan is listed at **$99/location/month** on Plus/Premium. <https://squareup.com/us/en/point-of-sale/restaurants/pricing>
- **7shifts:** monthly scheduling/operations tiers are approximately **$34.99 / $76.99 / $150 per location** for Entrée / The Works / Gourmet, with lower annual rates. <https://www.7shifts.com/pricing-3yrqxy5fot96nknbq6y20z98oo77832o/>
- **Resy:** current restaurant plans list **$289/month** for Platform/Essential and **$459/month** for Platform 360/Premium. Resy says it does not charge reservation cover fees; prepaid experiences can carry separate fees. <https://resy.com/join/plans-pricing/>
- **OpenTable:** current US plans list **$149 / $299 / $499 per month** for Basic / Core / Pro, plus network cover fees ($1.50 on Basic; $1 on Core/Pro) and some Basic website-reservation charges. <https://www.opentable.com/restaurant-solutions/plans/>
- **MarginEdge:** **$350/location/month**. It is not a POS or reservation system; it is restaurant back-office/management software for invoice processing, inventory, food-cost/price tracking, daily P&L, bill pay, ordering, menu/recipe costing, and POS/accounting/labor integrations. <https://www.marginedge.com/pricing/> <https://www.marginedge.com/how-it-works>

For three locations, software subscription math alone can quickly reach hundreds or thousands per month before card processing, hardware and add-ons. That does not prove Diomedes ROI, but it establishes that $99/month is not an unusual category of business-software spend if the product returns useful management capacity.

### Field service / construction-adjacent businesses

- **Jobber:** current no-commitment pricing spans roughly **$49/month** for Core, **$139/month** Connect for one user, **$199/month** Grow for one user, and **$499/month** Plus for five users, with larger team configurations higher. <https://www.getjobber.com/pricing/>
- **Buildertrend:** currently uses customized pricing based on builder type, revenue and needs rather than posting a single public rate. <https://buildertrend.com/pricing/>

Diomedes should not pitch itself as a replacement for either category. The stronger thesis is coordination across systems and workflows.

## Rough value of returned time

Do not call recovered capacity guaranteed cash savings. A salaried manager still receives the same salary when a workflow saves five hours. The value may appear as capacity, less overtime/rework, faster turnaround, fewer errors, better follow-up, delayed hiring, more field/floor/client time, or actual avoided labor depending on the workflow.

The U.S. Bureau of Labor Statistics reported average **full-time private-industry total employer compensation of $54.00/hour** in June 2026. At that broad benchmark:

- 2 hours/week returned = 104 hours/year ≈ **$5,616/year of employer capacity**.
- 5 hours/week returned = 260 hours/year ≈ **$14,040/year**.
- 10 hours/week returned = 520 hours/year ≈ **$28,080/year**.

Source: <https://www.bls.gov/news.release/ecec.nr0.htm>

Occupation-specific salary examples, before benefits:

- Food service managers: 2025 median $69,390/year (about $33.36/hour on a 2,080-hour convention); 5 hours/week is roughly **$8,700/year of salary-time capacity**. <https://www.bls.gov/ooh/management/food-service-managers.htm>
- General and operations managers: 2025 median $105,770/year (about $50.85/hour); 5 hours/week is roughly **$13,200/year**. <https://www.bls.gov/ooh/management/top-executives.htm>
- Construction managers: 2025 median $114,990/year (about $55.28/hour); 5 hours/week is roughly **$14,400/year** before benefits. <https://www.bls.gov/ooh/management/construction-managers.htm>
- Project management specialists: 2025 median $102,320/year; the construction-industry median listed by BLS is $98,730. <https://www.bls.gov/ooh/business-and-financial/project-management-specialists.htm>

A mature website may show the broad 2/5/10-hour examples with the explicit `capacity, not guaranteed savings` caveat. Do not publish a claim that Diomedes itself saves any particular number of hours until measured deployments support it.

Vendor case studies can be useful context but not Diomedes promises. For example, 7shifts reports a restaurant case saving at least five hours/week on scheduling, while Square reports a customer saving three to four hours/week by automating third-party order entry. <https://www.7shifts.com/blog/case-study-beechwood-doughnuts/> <https://squareup.com/us/en/the-bottom-line/case-studies/how-torch-pressed-sushi-saves-staff-time-with-automated-ordering>

## Public website pricing structure

Keep the page simple and confidence-building rather than turning it into a SaaS matrix.

**Start with a conversation — first 60 minutes free**  
Show me where time goes. If there is not a useful problem to solve, say so. Continued focused consulting after the included hour is $100/hour.

**Quick Start — $299**  
Configure one supported cloud AI route with sensible Diomedes rules/permissions and one useful working example.

**Workflow Audit — $350**  
Map one recurring process and provide a written recommendation for what should be automated, assisted, or left alone.

**Local AI — plan $249; deployment from $749 + hardware**  
Recommend the hardware/model/runtime and, if requested, install, tune, benchmark and connect it to Diomedes. Credit the planning fee toward a qualifying deployment.

**Workflow Pilot — from $1,250**  
Build and measure one bounded workflow before a broader rollout.

**Broader implementation — from $2,500**  
For multi-workflow or multi-system deployments.

**Diomedes Business — planned from $99/month**  
Business workspace/harness and paid-account Diomedes-Agent access as shipped. Hosted inference is included within plan limits; local and hybrid configurations remain first-class.

**Managed Diomedes — from $249/month**  
Ongoing maintenance, support and measured optimization after deployment.

Hardware, travel, third-party subscriptions and out-of-plan provider/API usage are separate and agreed before work.

Do not say the product is currently free. Do not create checkout for unshipped paid tiers. Use a contact/audit CTA and honest availability wording until billing and entitlements exist.

## Website business story

A good business page should explain five things in this order:

1. **What problem Diomedes solves:** disconnected software and repetitive coordination consume expensive human attention.
2. **What Diomedes does:** acts as the operational layer across existing systems, models and workflows rather than demanding wholesale replacement.
3. **What an engagement costs:** the public anchors above.
4. **What the client should expect:** what Diomedes Systems manages vs what remains the client's responsibility.
5. **What the economics can look like:** rough time-capacity examples with strong caveats, not invented ROI claims.

Use examples beyond restaurants: construction/project operations, field service, professional services, retail/hospitality and general office/operations work. Any named integration must be labeled according to actual shipped connector capability.

## Validation and repricing

1. Track actual time spent on every early engagement, even if discounted/waived.
2. Measure the client's real before/after metric: hours, turnaround, errors, missed follow-ups, rework, etc.
3. Re-price after 2–3 meaningful deployments rather than preserving introductory prices forever.
4. Meter hosted-agent tokens, cache hits, retries, model route, latency, acceptance/verification rate and support burden by customer.
5. Compare models by successful task cost, not token price alone.
6. Keep provider/commercial/privacy terms in the route-selection gate.
7. Treat local/hybrid support burden as a real cost even when inference itself is local.
