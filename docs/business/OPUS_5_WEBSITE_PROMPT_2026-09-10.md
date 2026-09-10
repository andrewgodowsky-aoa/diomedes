# Opus 5 — Diomedes website consolidation

Suggested session configuration: thinking enabled; high effort if the interface supports it. No automatic max-effort mode. Work in one primary thread; use at most two genuinely independent helpers only if necessary. No research swarm or repeated reviewer loops. Read the sources before the final task below.

<context>
Product: Diomedes. Company direction: Diomedes Systems. Historical F:\Achilles paths may remain; never rename live folders solely to match branding.

Andrew approved accessible entry pricing and wants a genuine native Diomedes agent/harness, not just a GUI launcher. The long-term product takes responsibility for ordinary authorized work without routine babysitting. Rules, scopes, drift detection, correction, verification, recovery and evidence are the mechanisms, not optional safety upsells.

The commercial thesis is one configurable product across different small businesses. Restaurants, remodelers/construction businesses, field service and office operations are examples, NOT separate products or a restaurant-only strategy. Services help customers adopt the software; recurring software and optional managed service can coexist. Do not replace this with either "consulting only" or "an AI that runs any business today."

The main desktop app remains useful to personal and technical users too. The website must not become solely a restaurant consultancy site.
</context>

<sources>
Read current instructions and source before edits:

IMPORTANT CONCURRENT WORK: Read docs/business/COORDINATION_2026-09-10.md and
APPROVED_LAUNCH_REVIEW_2026-09-10.md. A Business-page candidate already exists on
site branch astra/business-approved-launch-20260910. Its business.astro was
inspected at blob bfe3768737f0b5f620a1324bcf6abc858096a05a. Compare that branch with
current main, preserve the author's work, and continue/consolidate it rather than
blindly rewriting the same page. Full Astro/browser verification was not reported
complete. A branch is not a deployed site.

The Fable consolidation in Drive (1AtyVgIA7W3V7Zkr9_Y07lRNgFxDvyqvPfgWEndvEAhg)
was subsequently read. Its higher-price/per-location/lifetime-discount proposal
is NOT approved. This handoff's .3 is a reconciliation retaining the approved
price anchors, not adoption of Fable's separately titled pricing v3.

App repository: andrewgodowsky-aoa/diomedes
- AGENTS.md
- docs/DIOMEDES_LIVE_ROADMAP.md
- docs/DIOMEDES_PROJECT_MEMORY.md
- docs/business/PRICING_STRATEGY_2026-09-10.md
- docs/business/MARKETABILITY_AND_INCOME_2026-09-10.md
- Current release/capability evidence, not stale "unpublished" text in an old handoff.

Roadmap/memory/pricing reconciliation checkpoint: 2026-09-10.3. Use newer owner-approved decisions when present. Research checkpoint: published app main ca2b46ed886c4597f2c7ac8229548d7c9fadb7cd; public unsigned release v0.1.1-experimental.2. Resolve current refs; never reset newer work to these hashes.

Canonical Drive IDs:
Roadmap: 1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE
Project memory: 13wYjK1BhEsGzc_yhpRtBz62pGmLxwdwq8pVqe1i4eKw
Pricing: 11EjZfmFpx0pKpISeS0s63aHr9pQLdb8d8r5UhoOaiZQ

Website repository: andrewgodowsky-aoa/diomedes-site
Inspect its current instructions, git status/worktrees, README, package scripts, src/pages/business.astro, index.astro, contact/local-ai/security/download pages, shared navigation/layout/styles, src/data/status.ts, src/data/releases.ts, examples, forms and responsive tests.

If planning/2026-09-10-v7-business-implementation/research exists locally, read the completed reports and follow their concrete evidence. They were not found in published GitHub/Drive during this handoff. A missing report is not a reason to invent its findings or stop unrelated website work. A launched worker is not a completed report.

Follow the general RESEARCH_AND_PROMPTING_GUIDE.md principles if available: clear complete scope, source roles, concrete acceptance, concise progress and no redundant over-verification. Do not bring its Minecraft-specific workflow into this task.
</sources>

<approved_prices>
First Workflow Fit Call: 60 minutes free; additional focused consulting $100/hour only after explicit acceptance.
Cloud AI Quick Start: $299 fixed.
Workflow Audit / Weak Point Map: $350 fixed.
Local Hardware & Model Plan: $249 fixed; eligible credit toward deployment.
Single-machine local deployment: from $749 plus hardware.
Shared/team local deployment: from $1,250, subject to scope.
Bounded workflow pilot: from $1,250.
Broader/custom implementation: from $2,500.
Diomedes Business: PLANNED from $99/month per organization until actually available.
Managed Diomedes: optional add-on from $249/month.

Show the starting scopes and separate setup, recurring software, support, hardware and third-party/usage costs. Business plus Managed is $348/month before exclusions. Do not imply unlimited accounts, locations, usage or support. Credit terms belong in concise details or accepted quotes, not giant marketing banners.

The outside assessment's $175-$225 consulting rate, $750-$1,500 audit and automatic $3,500+ pilot are NOT approved replacements. Higher custom quotes may arise from real scope. A $39-$49 starter and older Personal/Pro amounts remain unapproved exploration; do not add them as live offers.

The first hour may be called free. Do NOT market the product as "free for now," publish private pilot waivers or pretend a waived fee was paid. No checkout for an unfinished plan.
</approved_prices>

<product_and_claims>
Explain Diomedes in ordinary language: software that helps handle repetitive work across supported business tools, plus practical help configuring it. Keep the existing "Find the weak point. Fix the workflow" business theme if it remains the clearest choice.

Use a recognizable request -> result before architecture. Three illustrative examples:
- Hospitality: approved sales/labor/manager notes become a useful brief and follow-up list.
- Remodeling/construction administration: meeting notes, emails and project records become an open-items list, missing-information requests and a project update draft.
- General service/office work: incoming requests are organized, required information gathered, drafts prepared and follow-ups tracked.

These examples are candidate workflows, not evidence that specific production integrations ship. Prefer categories over vendor logos. Never use the founder's employer/prospective businesses as named customers or testimonials without explicit permission. Do not imply architectural or engineering sign-off, payroll/payment authority, autonomous employment decisions, or external publishing without supported authorization.

Native Diomedes Agent owns planning, routing, delegation, context, correction and verification. Initial reasoning may come from cheap commercially permitted APIs paid through Diomedes Systems' account. The company-funded route is paid-account-only, metered and bounded. Do not expose provider secrets or add billing/gateway implementation in this website task. Do not promise specific model names, unlimited usage, a proprietary foundation model, or the ability to train on private client data.

Keep native-agent versus direct-engine attribution clear. A model chosen inside Codex/OpenCode/Claude Code is not automatically the native Diomedes Agent. Existing application actions can still be called Diomedes actions. Use current release evidence for what is present.

Local setup direction includes hardware discovery, an explained shortlist, install/configure/benchmark and load/unload/resource management. Show local/cloud/hybrid tradeoffs: data handling, device requirements, running costs, availability, supported capability and upkeep. Online inference does not keep tasks executing while their only host is off. Claim always-on execution only if the verified deployed host provides it.

Trust language: "You choose the boundaries. Diomedes works inside them." Routine authorized actions should not need repetitive approval; scope changes or uncertain effects require appropriate review. Avoid the old blanket "nothing leaves the building" claim and unsupported "fully autonomous" claims. Keep rules, scopes, drift checks, recovery and evidence visible without a security jargon wall.
</product_and_claims>

<website_scope>
Implement a focused consolidation, not a new framework or desktop rewrite.

Business page flow:
1. Plain hero, concrete benefit and free fit-call action.
2. Three recognizable cross-industry workflow examples.
3. Clear setup/services prices; concise planned software and optional management prices.
4. What Diomedes Systems manages and what the customer owns/authorizes.
5. One transparent worked example of returned time.
6. Short local/cloud/hybrid and scope/trust explanation.
7. Existing inquiry form with "Start with an hour, free."

Aim for roughly 900-1,200 words of primary business-page copy; use details/FAQ for supporting material rather than a long unstructured page. Reuse a single data source for repeated prices/availability labels. Make the difference between software, setup and managed support immediately clear. Do not make clients learn Core/Runtime/Trust naming to understand the offer.

Services: discovery, supported installation/connections, agreed rules/scopes, testing, local-model tuning where selected, documentation and training. Ongoing reviews/updates/troubleshooting only as agreed in Managed. Customers retain their business decisions, accounts/data, approved users, hardware purchases and vendor obligations. Do not promise 24/7 staff, unlimited support or a made-up response SLA. A written quote specifies the exact deliverables and support.

Returned-time example: explicitly assume $40/hour, 52 weeks and NET time removed after review/rework. Two/five/ten hours each week represent $4,160/$10,400/$20,800 annually. These are arithmetic scenarios, not average Diomedes results or cash savings. A salaried manager still receives salary. Show setup and excluded costs when discussing payback; keep business revenue forecasts from the internal analysis OFF the public site.

An interactive calculator is optional only if small, accessible and tested; a static worked example is sufficient. No new analytics capturing entered business data. Do not reproduce old labor statistics or vendor price tables without current primary verification. The website is not a competitor-cost encyclopedia.

Update homepage introduction/links and shared navigation plus contact/local-ai/security/download copy only where needed for consistency. Keep the personal/power-user route visible. Move technical explanations to secondary pages instead of deleting all depth. Preserve valid routes, forms, release data and useful existing content.

The current Settings > Engines desktop screen establishes readability and visual character: crisp sans-serif text, flat restrained surfaces, coherent spacing and controls. Use web-appropriate readable sizing and responsive layout, not literal desktop scaling. Preserve user/theme decisions; no arbitrary forced cyan redesign, glass, excessive cards, ambient glow or chat-bubble mockups.

Prefer a real current built-app capture with synthetic data, recorded version/theme/viewport and appropriate development-preview label. Do not fabricate a polished product screenshot. Replace misleading constructed/cropped demos as primary product proof. Existing hero CSS intentionally bleeds/crops a fixed-width ConsoleFrame; do not hide overflow failures with blanket clipping. On mobile use a clear purposeful detail and access to a full view.
</website_scope>

<execution_and_acceptance>
Use an owned branch/worktree and preserve concurrent changes. Source research and bounded local website edits/tests are authorized by this handoff. Do not touch application Runtime/Trust, billing schema, paid provider accounts, credentials, production data, DNS or live forms infrastructure. Capture infrastructure gaps as a separate handoff instead of solving them inside marketing work.

Before editing, report the resolved versions and a short plan. Continue through implementation and tests without asking for permission at every ordinary edit. Give another brief update at first preview and one at completion. Stop only for a genuine missing decision, destructive action or access limit affecting that step.

Run the site's existing build/copy/type checks and relevant Playwright tests. Add targeted checks for approved price consistency, planned labels, contact path, keyboard/focus behavior, 200% zoom and page overflow at representative 360/768/1280/1920 widths. Reuse current scripts; do not install a new testing framework for this pass. Fix relevant failures and document unrelated existing ones.

Produce before/after page captures, a short claim/source ledger, changed-file list, actual commands/results and build/commit identity. Claims about plans, integrations, signing, paid accounts and client results must match evidence. The current D1 submissions table does not prove entitlements, and EV signing does not bypass SmartScreen.

Prepare the commit/PR for the specific website patch. Respect current repository publication rules and obtain explicit authorization before production deployment if not already granted for this exact patch. No automatic paid subscription, signing purchase or app release. After any authorized deployment, inspect the live domain and distinguish it from local preview.

Final report at most 700 words plus artifact links: what changed, what remains planned, test outcomes, actual Git state, ROADMAP IMPACT, and separate BUILD / PUBLICATION / DEPLOYMENT STATUS. Do not equate a screenshot or a passing copy check with comprehension by actual users. Record human feedback only when observed.
</execution_and_acceptance>

<task>
Now inspect the current sources, reconcile them with this approved direction, and implement the bounded website update end to end. The result should let an ordinary owner quickly understand the job Diomedes could help with, what is ready versus planned, what it costs to start, who manages it, and how to begin without a large commitment.
</task>
