# DIOMEDES PROJECT MEMORY — CANONICAL

Version: 2026-09-10.6
Last reconciled: September 10, 2026
Cloud canonical: 13wYjK1BhEsGzc_yhpRtBz62pGmLxwdwq8pVqe1i4eKw
Repository mirror: docs/DIOMEDES_PROJECT_MEMORY.md

## How this memory is organized

This is the current definition and decision index. The complete previous standing-memory body is retained unchanged at docs/reference/DIOMEDES_PROJECT_MEMORY_BASE_2026-09-10.2.md, with a cloud snapshot at https://docs.google.com/document/d/1VEqHFWvKNVGLcLP88GNnQmWqcddWTj940Aw15U7WEN8/edit. Its detailed product requirements remain incorporated where not explicitly superseded here. They have not been discarded or relabeled as implemented. Use this current index first; retrieve the detailed base sections relevant to the task rather than injecting every past discussion indiscriminately.

Authority: Andrew's newest explicit decision governs intent; the current roadmap governs sequencing; this memory governs definitions; actual source and verification govern implementation facts. Pricing approval and research conclusions are separately labeled. No pasted assistant report, Mem0 banner or successful model response proves a running integration or persisted memory update.

## Personal / Business and Agent contracts — 2026-09-10.4

Personal is the strong free self-managed local/BYO harness. Business is a configured organization workspace and managed service on the same Core/Console, not a separate fork or deliberately less-safe Personal runtime. Core Agents, Teams foundations, guidance/correction/policy, permissions, evidence and recovery remain shared. Business differentiates through maintained organization configuration, managed Diomedes Agent inference, supported connections, organization governance and operational services. Published Apache-2.0 code is not restricted to noncommercial use by an edition label; no relicensing is authorized here.

Person, Personal workspace, Organization, Membership, organization-owned Business profile, member preferences, Entitlement, Usage account and execution principal remain separate. One person can retain Personal and join several businesses; a sole proprietor can use Business. A business registration does not claim legal incorporation verification. An old onboarding work=business answer is a preference only. Company data/configuration do not silently become personal property on cancellation or account deletion.

The Business questionnaire never runs in Personal. Authorized organization owners/admins start or resume the company intake; ordinary invitees join the existing configuration and may supply optional role preferences. Gate this at the host/API as well as the UI. Answers describe goals, sources, roles, processing limits, host availability and budgets; they are not permission grants, secret fields or billing approval.

Mode → Agent → Model → Effort is the conceptual control model, not a rigid execution pipeline. Agent definitions are stable/versioned worker contracts composing existing instruction/rule, capability, context, model, Trust, evidence and collaboration policies. Teams compose Agent identities with explicit scoped handoffs. Branded Diomedes Agent is the native supervisor using those workers; direct engine work retains actual model/runtime attribution. Changing Agent/model/Team cannot grant authority or evade budgets.

Self-configuration means structured facts → reviewable candidate → deterministic validation → rehearsal and approval → versioned activation → observed operation → reviewed improvements. Use deterministic templates with optional model assistance, existing mutation/admission services and expected-base checks. Missing connections stay unsupported; rollback never restores revoked grants or old credit. Corrections change an attempt, not silently the Agent or organization's governing rules.

The illustrative $300/month with $100 inference allowance is a commercial candidate; existing approved price anchors remain until explicitly superseded. Entitlement, Trust permission and budget admission are different checks. Managed inference uses company-held server credentials and tenant-bound reserve/settle accounting including Team/reviewer/correction calls. Local/BYO is not silently charged against that allowance. No unlimited usage, automatic overage, invisible payer fallback or assumption that online inference provides an always-on execution host.

Standing Opus 5 prompting preference: complete context, explicit scope/end state, short milestone prompts and repository references. Avoid giant phase-by-phase instructions, repeated warnings, exhaustive checks in every prompt and redundant self-verification/subagent review. Mandatory repository checks still apply. GLM implementation prompts may use Goal / Context / Constraints / Done when. See docs/product/personal-business/08_SOURCES_AND_LICENSING.md for checked first-party guidance.

Execute PB-01 through PB-04 after the current Opus Trust/Agent checkpoint and before the planned GLM correction run, without expanding into unready production services. Package: docs/product/personal-business/README.md; Drive https://drive.google.com/drive/folders/1-U8m3jRRbVs28vsVw5zgtj-t0Tlxl62_. These are current product decisions and implementation contracts, not evidence that the requested features have landed.

### What PB-01 actually implemented — 2026-09-10.5

A workspace is `{ kind: 'personal' }` or `{ kind: 'business', organizationId }`, held as a personal preference in `Settings.activeWorkspace` and writable only by the membership-checking switch route: `validateSettings` preserves whatever is stored, so echoing settings back cannot move anyone into a business. Organizations, memberships and single-use invitations live in `<data>/workspaces/`; each organization owns a `tenantId`, and revoking a membership bumps that tenant's Trust identity generation so references minted under it stop resolving. A stored Business reference is honoured only while the membership behind it is active, so a stale settings file reads as Personal.

The Business intake is gated by one host predicate requiring an active Business workspace, an active membership, owner-or-admin authority and a setup that is new or explicitly resumed. Personal has no route into it at all. Answers are typed facts with origin, timestamp, tenant and schema revision; unresolved answers stay unresolved; credential-shaped and card-shaped free text is refused rather than stored; a concurrent administrator gets a conflict rather than last-write-wins. Reaching a complete draft produces a proposal, and the host says plainly that compiling, validating, rehearsing and activating are not implemented.

Production identity is still absent. `trustBackendInstalled()` is the single source for whether hosted Business is available, and it is false, so every organization created here is a `development-fixture` labelled as one in the interface. Entitlement is computed, never stored, and always `none` with a reason: nothing local can grant a plan. `onboarding.work === 'business'` yields a sentence of explanation and nothing else.

### What PB-03 and the brief wiring settled — 2026-09-10.6

**Managed usage is a debited allowance, and it is not for sale here.** An amount of money is an
integer count of micro-USD; nothing constructs one except `micro()` or `dollars()`, and a figure
finer than a micro-USD is refused rather than rounded, because rounding is a silent write-off.
Provider cost, allowance debit and invoice are three fields that stay apart. Whether a charge kind
debits the allowance belongs to a versioned rate card, so a charge settled last month keeps the
classification it settled under. Anything without a knowable pre-call ceiling — a provider-run tool
— is not admitted under a managed payer at all, because a route with no reliable bound cannot
promise a hard cap.

A reservation holds a conservative maximum against both the organization balance and the parent
task's envelope, settles the difference once, and a lost response goes `uncertain` rather than being
released: releasing it would let a call that may already have cost money be retried for free.
Delegation and retries reserve inside the same parent envelope; nothing mints credit.

A payer is resolved, never defaulted: `managed`, `byo`, `local`, or refused. A personal
subscription is refused for company work rather than resold. The plan definition is a candidate
with `sellable` typed as `false`, every unapproved limit `null` with a reason, and entitlement
resolves to `none` — so every managed admission in this build refuses, and that is the honest state
rather than a defect. The Console shows no figures where there is no allowance, because a drawn
zero reads as a spent allowance.

Admission runs identity, membership, entitlement, data route, charge kind, payer, then budget, in
that order. The order is load-bearing: a purely local call needs no plan, so entitlement cannot come
first, and money comes last because a reservation is not permission to execute. A billing platform
is not the spend gate; its events are treated as at-least-once and out-of-order, a period grants
once however many events name it, and payment cannot lift a security suspension.

**Where a business writes is an explicit, per-organization choice.** A business job needs a
destination, and every implicit answer is wrong somewhere: the open project would let switching
workspace mid-run redirect a company's output, and a project created on demand puts a company's
work where nobody chose. An owner or admin binds one project per organization; the target resolves
once when a run starts and is bound to that tenant for the run's lifetime. It is deliberately not
attached to a configuration revision, so rolling a setup back cannot silently redirect where work
lands. A bound project that has since gone is named, never replaced. This is what made the weekly
brief reachable.

## Stable meanings

Diomedes is a general-purpose agent/harness and human workspace, not a restaurant-only product, chatbot, external-agent launcher or workflow builder alone. Company direction is Diomedes Systems. Historical Achilles paths may remain; do not mass-rename live data or namespaces without a migration.

Desktop is the human workspace. Core owns model/agent routing, context, profiles, skills, rules, memory, advisors and supervisory behavior. Runtime owns durable admission, runs/steps/events, workflows, budgets, waits, cancellation, recovery and external effects. Trust owns identity, capabilities, scoped grants, approvals, credentials, revocation, client boundaries and information-flow policy. Observatory owns observed evidence, usage/cost provenance and evaluations. Interop covers supported APIs, MCP/MCP Apps, webhooks, and ACP/A2A where useful. These are responsibility boundaries, not instructions to create six separate services.

Diomedes Agent is the native supervisory operation: understand the goal, plan, assemble context, choose routes/tools/workers, monitor, correct, request authority where needed, verify and preserve progress. It can use external API cognition initially and later a tuned local or hosted supervisor model. The model weights are not the entire agent or the authority to execute effects.

An Agent (2026-09-10) is a versioned, capability-aware, policy-governed worker identity that can operate through interchangeable compatible models and participate in durable work and Teams under Diomedes Trust, Rules, Permissions, Evidence and Approval. The control model is Mode -> Agent -> Model -> Effort, and the four stay distinct: a Model is interchangeable intelligence, an Agent is a durable Diomedes-owned worker contract, a Mode is the person's current relationship to the work, and a Team is a composition of Agents. The Agent belongs to Diomedes and the model remains replaceable: `Code Reviewer` is the same Agent whichever compatible runtime executes it. An Agent references the existing mode, capability, tool, rule, permission, model and evidence systems rather than duplicating them, and owns only its bounded `role` sentence. Changing Agent or model never grants authority; a handoff cannot launder permission. Auto records whether the final Agent and model were chosen automatically or by hand.

Direct-agent mode lets an explicitly chosen external engine be primary executor/reasoner while Diomedes keeps surrounding project state and the control guarantees its adapter actually provides. Engine, model, provider/account route and worker are distinct. Preserve actual runtime-reported attribution per turn/proposal/event; do not rename history when the picker changes. Unknown model identity remains unknown. Reserve Diomedes reasoning attribution for Diomedes-led work; application infrastructure actions may still truthfully use the Diomedes name.

Memory/preferences, retrieved business knowledge, reusable skills, behavioral rules, enforced policy, pending runtime state, evaluations and governed training data remain distinct. A remembered preference is not permission, and a prose summary is not the record of pending work.

## Experience and autonomy

One primary Console surface; retire Workbook functionality into it without breaking existing work. The latest Settings > Engines screenshot is the reference for typography, readability, spacing and controls. Preserve selected appearance rather than forcing an older cyan palette. Flat restrained surfaces, thin separators, crisp sans-serif app prose, code-appropriate monospace, optional intentional document reading typography. Avoid decorative noise and generic chat-bubble UI. Guided/Standard/Technical control information density, never authority.

No routine babysitting is the goal. Scoped grants, standing guidance, triggered correction, pre-effect policy, drift detection, retry/resource limits, verification, evidence and restart/reconciliation are immediate foundations. An uncertain result or an authority crossing should escalate intelligently. Do not claim an untested model can safely run everything unattended.

Permission choices remain Review changes; Work in this project; Approve for me through a separate bounded reviewer; and explicit Full access for a clearly identified environment. Distinguish access scope from escalation reviewer. A grant can cover routine work without repeated clicks, but automatic allowance must not be recorded as an exact human review. Effort, repeated approvals and self-improvement cannot enlarge authority. Worktrees are edit isolation, not OS containment; inherited shell/network tools can invalidate a narrow enforcement claim.

Preserve Thread/Board/Team as views of the same work, Auto To Do ordinary-user language, compact route/permission/effort controls, honest Steer/Queue/Stop, a Needs you inbox, review feedback as a correction task, artifact/result panes, explicit context inclusion and fresh-thread handoffs, clear worker assignments, budgeted advisors and predictable scheduling/host lifecycle. The detailed base retains these requirements.

## Setup, local AI and improvement

First-run setup should discover existing supported engines after disclosure, then install only selected missing tools through trusted distribution, use supported authentication and distinguish found/compatible/signed-in/enabled/capable/ready. Discovery must not secretly send a paid prompt, copy credentials or change billing. Permissions are separate from onboarding expertise answers.

Local models are first-class: hardware/acceleration/RAM/VRAM/unified-memory/disk discovery; reuse existing models/endpoints; ask quality/speed/privacy/context/coexistence priorities; explain a short model shortlist; trusted model/runtime download with license/provenance; sensible context/offload/KV/concurrency defaults; local benchmark and capability check; named profiles; safe load/unload, eviction and process ownership. Runtime-specific flags and advanced controls remain available. No fixed model or runtime lock-in.

Business deployment can be local, hosted or hybrid based on workload, privacy, concurrency, uptime, maintenance and total cost. Cloud inference alone is not a persistent execution host. Later Diomedes-tuned supervisor weights should specialize in orchestration/tool use/verification and delegate hard reasoning appropriately. Customer facts preferably stay in governed retrieval/configuration; customer-specific adapters require explicit data governance.

Recursive improvement remains observed failure/correction -> candidate rule/skill/prompt/routing/workflow change -> replay/eval -> versioned promotion -> monitor/rollback. Weight tuning follows sufficient legitimate data and measured gains; it is not the first implementation milestone. Candidates cannot self-promote, rewrite permissions or change data access/billing/tenant scope. Keep provenance, held-out evaluations, independent checks where warranted and rollback. Never train on private customer material merely because it was processed during a job.

## Current business correction — variety is the thesis

One configurable product should serve multiple kinds of small business. Hospitality and remodeling/construction administration are initial validation contexts, not competing company identities. Generic primitives include intake, classification, retrieval, comparisons, drafts/quotes, follow-ups, weekly briefs, invoice capture and scheduling coordination. Industry packs should reuse the core through configurations, mappings, tools, skills and rules; new vendor semantics still need real integration work and tests. Two examples do not prove universal compatibility.

Services-assisted software adoption is an intended route. Locally delivered SaaS is a sales/setup/support model, not a requirement that all inference be local. Do not assume software must earn zero for 18 months, and do not claim recurring revenue before actual paid access and renewal evidence. Consultation, implementations, software and managed support have distinct costs but may reinforce one product business.

Andrew's current hospitality relationships are in North Carolina's Triangle. Employer/prospect relationships do not establish ownership, signed pilot status, lawful data access, purchasing approval, references or endorsement. A remodeling contact is also a prospect/example unless separately authorized. Keep names/logos and internal revenue projections off public marketing without permission. Do not infer willingness to buy from a named establishment's size or presumed software sophistication.

Andrew is willing to hire. A support/implementation hire is an option after measured workload and cash contribution justify it, not an immediate commitment or proof of unlimited capacity. Preserve affordable entry and scope larger work honestly instead of simply multiplying every price.

## Commercial decisions and research status

Approved public anchors remain first hour free; $100/hour agreed continuation; $299 Quick Start; $350 audit; $249 local plan; from $749 single-machine local deployment; from $1,250 shared local or bounded pilot; from $2,500 broader/custom implementation; planned Business from $99/month per organization; optional Managed from $249/month. Consult docs/business/PRICING_STRATEGY_2026-09-10.md for scopes and credits. Free discovery is distinct from private pilot waivers and from saying the product is free for now.

A $39-$49 starter, blanket $175-$225 hourly rate, and high minimum replacement prices from the outside assessment remain proposals, not approved prices. Larger scope-based implementation quotes are possible under the existing custom line. Monthly managed support is not unlimited labor or a 24/7 staffed guarantee.

Company-funded hosted Diomedes inference is paid-account-only through a server-controlled, commercially permitted API route with identity, entitlements, metering, budgets and revocation. Do not embed company keys or trust a client-side paid flag. Model selection is provider-agnostic and evidence-driven. Cheap inference does not remove support, acquisition, maintenance or liability costs. Local/BYO routes retain separate authority and economics. Billing changes must not erase local records or reasonable export.

No measured average savings, sales conversion rate, signed design partner, customer count or probability-weighted income forecast was established in the supplied material. Use scenarios and collect actual evidence. Time returned is net of new review/correction/maintenance, and salary capacity is not automatically cash savings.

Marketability/income analysis: docs/business/MARKETABILITY_AND_INCOME_2026-09-10.md; cloud https://docs.google.com/document/d/17-_I4q-h95yVQiY-G8mrySVM6V92BRnYcg8XnQsJNV4/edit. Scenario inputs: docs/business/income_model_2026-09-10.json. These are planning assumptions, not customer-facing promises.

## Website and execution handoff

Plain outcomes before architecture; authentic app captures with build identity; honest released/development/planned status; a few cross-industry examples; simple price scopes; what is managed versus customer-owned; net-time value with explicit assumptions; free fit-call CTA. Preserve personal/power-user product access, technical depth on secondary pages, responsive readability, valid forms and actual release downloads. No fake customer logos, capabilities, ROI, supported model catalogue or checkout.

Opus 5 is explicitly requested for the current bounded website handoff; this supersedes the earlier Astra-only website assignment for this task, not a global change of application ownership. Use docs/business/OPUS_5_WEBSITE_PROMPT_2026-09-10.md; cloud https://docs.google.com/document/d/1S4892244vJ-zyMkbf15VO055J4qPFGiGiu8O6BuhmtQ/edit. Default to one thread/high effort, bounded independent helpers and concrete acceptance rather than repeated assurance rituals.

The four reported Muse research runs were not located in published sources during this reconciliation. Their local paths are leads, not completed evidence. Read local results if they exist; do not recreate claims of dispatch/completion or block unrelated work merely because reports are missing.

Full prior detailed requirements remain in the incorporated base. This index supersedes stale pricing approval wording, restaurant-only positioning and older status/assignment assumptions where stated. Application builds, tests, deploys and paid account readiness remain separate from these documentation updates.
