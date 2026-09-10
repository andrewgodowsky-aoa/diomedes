# Diomedes Pricing & Services — Working Draft

**Version:** 2026-09-10.1  
**Status:** Provisional strategy for validation; not yet approved public pricing  
**Cloud companion:** Google Doc `11EjZfmFpx0pKpISeS0s63aHr9pQLdb8d8r5UhoOaiZQ`

## Pricing principles

1. Sell outcomes and operational responsibility, not token access.
2. Prefer fixed-scope prices for audits, setups, pilots and implementations. Keep hourly consulting for focused advice and out-of-scope work.
3. Do not bundle unlimited hosted model usage until real unit economics exist.
4. Local/BYO inference and hosted inference have different cost structures. A customer using its own hardware still pays for Diomedes software/harness/agent behavior; a hosted route also has compute cost.
5. Hardware, third-party subscriptions/API usage, travel and unusual integration/licensing costs are separate and disclosed before work.
6. Core trust/safety behavior is foundational, not a premium add-on. Higher business tiers may add organization administration, support, managed operations, stronger isolation and SLAs rather than paywalling basic permissions/rules/auditability.
7. Early design partners may receive private discounts or fee waivers while the public site shows intended standard value. Where practical, proposals/invoices should show the standard price and explicit pilot discount.

## Market anchors — September 2026

- Devin self-serve: $20/month Pro, $200/month Max, Teams $80/month minimum and $40/month per full seat; usage can extend through on-demand credits. <https://docs.devin.ai/admin/billing/self-serve>
- Lindy: $29.99/$99.99/$199.99 per user per month for Plus/Pro/Max. <https://www.lindy.ai/pricing>
- ChatGPT Business: $20/$100 per seat per month annually for Standard/Premium, or $25/$125 monthly, with a two-seat minimum. <https://openai.com/business/pricing/>
- Raleigh-focused Pivot180 guidance places entry AI assessments around $500–$2,500 and SMB implementations commonly $3,000–$15,000. <https://pivot180.ai/resources/best-ai-consulting-firms-raleigh-nc>
- Clutch's U.S. AI-consulting guide lists senior AI strategists/architects around $200–$350/hour; SMB-oriented independent providers often publish lower starting rates. <https://clutch.co/us/consulting/ai>
- Local-AI examples range from $650 for a one-person setup to $1,250 for a private workbench and $2,500–$4,500 for a small-team kit at PuenteWorks; DataNorth lists a 20-hour U.S. local-LLM consultancy around $3,200. <https://puenteworks.com/local-ai-setup> <https://datanorth.ai/service/consultancy/local-llm>
- LocalLLM.com publishes $2,500 strategy/assessment, $15,000 full implementation, $500/month Starter and $1,500/month Growth, plus a $2,500 fine-tuning sprint. <https://localllm.com/pricing>

These are reference points, not claims that all providers deliver equivalent scope or quality.

## Recommended initial standard service pricing

### Focused consultation — $150/hour

Use for a defined question, second opinion, troubleshooting, model/provider comparison or follow-up advice. This deliberately starts at the lower end of experienced U.S. independent-consultant pricing while Diomedes builds case studies. Revisit toward $175–$200/hour after repeatable proof and demand.

### Workflow Audit / Weak Point Map — $750 fixed

Discovery and review of one important workflow and current tools, risk/data-readiness notes, ranked opportunities, and a short written action plan. This should be the normal paid entry point rather than an open-ended strategy engagement.

### Cloud AI Setup — from $750

Basic scope: configure Diomedes plus one supported cloud/subscription engine/account route, baseline permission/rule policy, one or two ordinary connectors where supported, one useful working example, and handoff/training. Multi-user, custom MCP/OAuth, unusual identity/security requirements or multiple systems move to a quoted implementation, commonly $1,500+.

### Local AI Assessment + Hardware/Model Plan — $500 fixed

Evaluate current hardware, workload, privacy/latency needs, expected concurrency and whether local/cloud/hybrid is appropriate. Deliver a written hardware-tier recommendation, model/runtime shortlist, expected tradeoffs, storage/power considerations and procurement list. Hardware is normally purchased directly by the client.

### Local AI Deployment — from $1,500 + hardware

For one existing or newly purchased business machine: install/configure the supported local runtime, select/download suitable models, tune context/offload/memory/concurrency, integrate with Diomedes, benchmark the actual system, configure lifecycle/updates, document the setup and train the owner/admin. A shared/team/networked deployment with stronger access controls should start around $2,500–$4,500+ depending on scope.

### Workflow Pilot — from $2,500

One bounded, measurable workflow using agreed data and human-control boundaries. Includes baseline measurement, configuration/build, test/shadow period, training and keep/revise/kill review. Typical early small-business target after scope is roughly $3,500–$7,500, but publish only `from $2,500` until case studies justify a tighter band.

### Implementation — from $5,000

For businesses that already know the desired outcome and need multiple integrations, reusable capabilities, business workspace configuration, permissions/rules, deployment, documentation and training. Complex multi-system or production-sensitive work is custom quoted.

### Training — $350 remote session / from $750 half-day

Useful as a standalone team handoff or add-on. Keep custom/on-site travel separate.

### Managed Diomedes — from $500/month

Basic managed relationship after a working deployment: health/reliability checks where supported, model/provider updates, monthly review, a small defined support allowance and bounded optimization. A more active build/optimization relationship should be about $1,000–$2,000+/month depending on included hours and responsibility. Do not sell unlimited support at $500.

### On-site/local day rate — about $1,200/day + travel

Use only where on-site setup/training is genuinely useful. Fixed project pricing remains preferable for implementations.

## Recommended software / agent target pricing

These are product targets to validate, not final checkout prices.

### Personal — target $19/month

Diomedes Desktop/Core for an individual using local, subscription-backed or BYO provider routes. Exact entitlement scope remains a future product decision.

### Pro — target $49/month

Advanced harness/agent features, richer routing/delegation, local-model management, automation/evaluation controls and power-user capabilities. Third-party provider costs remain separate.

### Diomedes Business — target from $199/month per organization

Initial business anchor for the harness/workspace, rules/permissions, audit/history, connectors, business configuration, local/BYO inference routes and organization-level administration as those features become production-ready. A small included-user allowance (for example five users) is preferable to immediately turning every manager into a separate expensive seat; additional-seat pricing can be validated later.

### Local Diomedes Agent — included in applicable Business/Pro software when production-ready

When the customer supplies compatible hardware, local inference does not create Diomedes per-token cost, but the customer is still paying for Diomedes software, supervisory behavior, updates, rules, evaluation, routing and lifecycle management. Hardware/electricity and optional managed support remain separate.

### Hosted Diomedes Agent — target from about $299/month for small business, with explicit hosted-usage limits or metering

Business software plus Diomedes-hosted supervisor inference/remote availability. Third-party specialist-model usage should remain customer-supplied or separately metered unless a commercial provider arrangement explicitly permits bundling. Do not promise unlimited hosted inference before workload data exists.

### Hybrid Diomedes Agent — likely default for many businesses

Use local/smaller supervisor inference for routine monitoring, routing, retrieval and stable workflows when appropriate; escalate selected work to stronger cloud specialists under explicit rules and budget. Hybrid is a deployment mode, never a hidden billing fallback.

A plausible small-business managed bundle is roughly **$699/month before third-party inference**: $199/month Diomedes Business + $500/month Managed Diomedes. A comparable hosted-supervisor starting point would be roughly $799/month before separately billed specialist usage. These are unit-economics examples, not promises.

## Autonomy / trust value proposition

The commercial destination is not "AI that asks permission every five minutes." It is bounded autonomous operation that can be trusted not to wander outside the business's rules.

A mature Diomedes deployment should run ordinary authorized work without user babysitting using durable scoped grants, rule/context injection, drift detection, deterministic policy, bounded retries/corrections, verification, evidence and clear escalation only when an operation crosses authority or becomes uncertain. The more autonomous Diomedes becomes, the more important these controls become; autonomy and governance are complements, not opposites.

Do not market `fully autonomous` before production evidence supports it. Near-term wording should be about reducing coordination/babysitting while keeping consequential boundaries explicit.

## Local vs hosted vs hybrid tradeoffs

### Local

- Customer hardware and upfront capital.
- Lower marginal inference cost after purchase.
- Stronger data locality/offline possibilities.
- Predictable capacity.
- Performance/model quality limited by hardware.
- Host must be available and maintained.

### Hosted

- No local GPU purchase required.
- Easier updates, remote availability and elastic capacity.
- Recurring compute/usage cost.
- Depends on internet/service availability.
- Data-handling/provider terms must be understood.
- Cost varies with workload.

### Hybrid

- Local supervisor/routine work plus cloud specialists when policy/quality requires.
- Often the best balance of cost, privacy, resilience and capability.
- Requires explicit routing/budget policy so `hybrid` never means silent cloud fallback.

## Website recommendation

Do not add a giant SaaS matrix to the current business page. Add one plain `What it costs` section close to the existing Workflow audit → Bounded pilot → Implementation → Managed Diomedes flow.

Recommended public copy/anchors:

- **Workflow Audit — $750** — A written look at one workflow and where AI or automation could actually save time.
- **Cloud AI Setup — from $750** — Diomedes plus a supported cloud AI route, permissions/rules, basic connections and handoff.
- **Local AI Deployment — from $1,500 + hardware** — Hardware/model guidance, local model setup, Diomedes integration, tuning, benchmark and training.
- **Workflow Pilot — from $2,500** — One measurable workflow, built and tested before a larger rollout.
- **Diomedes Business — from $199/month** — The Diomedes workspace/harness for a business. Model/provider usage is separate; local, hosted and hybrid deployment modes have different cost structures.
- **Managed Diomedes — from $500/month** — Ongoing support, maintenance and measured optimization after deployment.

FAQ/detail may additionally state: focused consulting $150/hour; hardware, travel and third-party subscriptions/API usage are separate and agreed before work; hosted Diomedes Agent pricing is expected to start above the local/BYO Business plan and will be finalized from real usage data.

Do not advertise "free for now." Early-access/design-partner discounts can be handled privately. Do not create checkout for unfinished tiers; use `from` pricing and a scope/contact action until the offer is standardized.

## Next validation

1. Ask 5–10 local business owners/managers whether the six public price anchors are understandable and whether any feels implausibly cheap or expensive before pitching value.
2. Run the first design-partner engagement with an internal time log even if discounted or waived.
3. Record hours spent on audit, setup, support, model maintenance, integration work, travel and rework.
4. Record the client's actual value metric: hours saved, turnaround, errors, etc.
5. Re-price after 2–3 real deployments; do not preserve introductory prices merely because they were published first.
6. Measure hosted-agent inference/remote infrastructure cost before committing to included hosted usage.
7. Treat local/hybrid deployment support burden as part of margin, not as zero because inference is local.
