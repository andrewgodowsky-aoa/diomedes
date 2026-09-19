# DIOMEDES LIVE ROADMAP

Roadmap version: 2026-09-19.1
Last reconciled: September 19, 2026
Product: Diomedes
Company direction: Diomedes Systems
Cloud canonical: 1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE
Repository mirror: docs/DIOMEDES_LIVE_ROADMAP.md

## 1. Authority, current entry point and preservation

Andrew's newest explicit decision governs intent; docs/DIOMEDES_CORE_PILLARS.md governs durable constraints; this roadmap governs strategy and sequencing; docs/DIOMEDES_PROJECT_MEMORY.md governs definitions; current source and fresh verification govern implemented reality. An assistant narrative, documentation approval or roadmap checkbox is not execution evidence.

This checkpoint records Andrew's September 19 instruction to publish the Automations plan in GitHub and Drive and remove stale active guidance. It consolidates BUS-10 and OPS-08–OPS-10, preserves the September 17 model-aware harness amendment (MH-1), and separates current requirements from older release, test and worker-assignment statements. The Core Pillars are not amended. No application implementation or deployment is authorized or certified by this documentation publication.

Read this entry point first. Detailed non-conflicting requirements remain incorporated from the previous bodies, preserved without alteration at docs/reference/DIOMEDES_ROADMAP_PRE_AUTOMATIONS_2026-09-19.md and docs/reference/DIOMEDES_PROJECT_MEMORY_PRE_AUTOMATIONS_2026-09-19.md. Their historical statuses, test counts, release pointers, 'next' instructions and named worker assignments are not current instructions. Earlier requirements also remain in docs/reference/DIOMEDES_ROADMAP_BASE_2026-09-09.7.md and docs/reference/DIOMEDES_PROJECT_MEMORY_BASE_2026-09-10.2.md where not superseded by current decisions. Retrieve relevant detail rather than injecting every historical document.

Pre-reconciliation cloud snapshots: roadmap https://docs.google.com/document/d/18I5Y384mPcbT70AuH-N3wZA8cFodLq7xxczfAcC96bk/edit ; memory https://docs.google.com/document/d/1rDyz3L4RqBEiZM39-nuk-8AZjs3UYkAfjQnSMqDRAfo/edit . These preserve the distinct cloud and repository histories; neither older copy replaces the other.

Refresh cloud revisions before authorized writes, use requiredRevisionId, preserve concurrent edits and keep cloud/repository decisions materially equivalent. F:\Achilles and F:\Diomedes planning caches are not additional authorities. Existing coordination claims, prerequisite reviews and active work orders govern execution; a historical handoff never reassigns a worker.

## 2. Automations — approved plan, implementation pending

Canonical focused specification: docs/product/2026-09-19-automations.md, version 2026-09-19.1. Cloud counterpart: https://docs.google.com/document/d/1iOf_-0c1ft5w-KhJpp1eOXLMGzo8QVYHWQKJg9YYp5o/edit . Delivery/review mapping: docs/implementation/2026-09-19-automations-work-items.md. This is the current planning authority for BUS-10 (owner workflow visibility), OPS-08 (recurring execution), OPS-09 (host availability) and OPS-10 (notifications); do not start a duplicate initiative from their older short descriptions.

Automations is a first-class destination inside the existing Console for Personal and Business. It shows what is configured, what remains manual, purpose and limits, accountable owner, authorized project/location scope, execution host, trigger and next occurrence, source freshness, live stage progress, last verified result, missing coverage, attributable usage and actionable Needs. Use plain descriptive labels and the current readable Console visual system. Technical details remain inspectable, not mandatory.

An automation is an ongoing recurring/event-driven responsibility, not an Agent or individual run. Versioned definitions and durable trigger occurrences feed existing task admission and Harness RunService. They do not introduce another executor, run-state owner, permission system, artifact store, approval inbox or scheduler per pack. Thread, Auto To Do, Team, Files and Automations reference the same durable work. Installing a pack does not enable a schedule or grant authority.

Keep configuration, present eligibility, authoritative execution state, verified result and human attention distinct. Enabled does not mean able to run. Finished does not mean verified. Saved does not mean delivered. Pause future runs does not stop an existing run. A lost response after an external effect requires reconciliation, not a blind retry. Unknown health, missing sources, uncertain usage and unsupported control guarantees must be visible. Core safety and truthful visibility are shared, not premium safety features.

The source audit is pinned to app main 448448683458c2ef813035f344baa79a4c6817bd. At that snapshot, client/console/types.ts has no Automations ShellView, shared/packs.ts keeps schedules inactive and supports manual starts, and server/harness/run-service.ts explicitly is not a scheduler. The existing weekly brief produces a source-linked saved draft, not outbound delivery. These are bounded source findings, not a test of unseen worktrees or proof of current production readiness.

Delivery is dependency-ordered, not a new worker assignment:

- Milestone A / BUS-10 foundation: an inspectable catalogue and detail over supported authorized jobs, records and controls. Label the weekly brief **Manual — not scheduled**. Show empty, failed, stale and partial states honestly. Production organization aggregation still requires verified tenant controls.
- Milestone B / OPS-08 + OPS-09: one shared Runtime scheduling capability feeding existing admission, one assigned host and one daily/weekly draft-only workflow. Prove timezone/DST semantics, stable occurrence identity, next-run preview, skip/bounded catch-up, overlap/queue limits, pause/stop, current grants/budgets, sleep/restart recovery and no duplicate effects.
- Milestone C / supported events + OPS-10: named authenticated connector/event paths, ordering/deduplication/reconciliation, scoped notifications and production multi-location authorization after their identity, credentials and Trust prerequisites are proved.
- Milestone D: governed pack templates, reviewed plain-language configuration, supported remote operation and baseline-backed value reporting. Multi-host takeover requires separate ownership and destination-effect proofs.

The 36-case matrix A01–A36 is required acceptance coverage, not a passed test suite. Detailed schedule defaults remain explicitly proposed for implementation review. Cloud inference alone never establishes an always-on execution host; reliable offline alerts need an independent authorized observer. No generic canvas, arbitrary connector support, unrestricted remote shell, automatic payer/cloud fallback or invented ROI is implied. Existing Field Readiness milestones and optional SDKO status remain unchanged.

## 3. North star and shared product

A genuine general-purpose, Diomedes-led agent with its own harness/runtime and one human Console: objective → plan → context/routes/tools → bounded delegation → monitoring/correction → authority where needed → verification → durable result. No routine babysitting is the destination, not a claim that every model or workflow is already safe unattended.

One configurable product serves business, software, learning, personal and technical work. Industry differences use capability packs, workflows, schemas, mappings, rules and connectors, not product forks. Restaurants and construction/remodeling are validation contexts, not the product's limits. Prefer deterministic mechanisms where reasoning adds no value; coordinate existing systems before claiming to replace them.

Personal remains a strong free self-managed local/BYO harness. Business adds organization identity/configuration, maintained Agents/Teams/rules, supported connections, managed inference, governance and operational services on the same Core/Console. Basic safety is shared. Person, workspace, organization, membership, configuration, entitlement, usage account and execution authority remain separate. Business intake is authorized-owner/admin-only in a selected Business workspace; ordinary invitees do not restart company setup and Personal never receives it.

Agent is a versioned Diomedes-owned worker contract; Teams compose Agents. Mode → Agent → Model → Effort is a conceptual control model, not a rigid execution pipeline. Direct external-engine work stays first-class and truthfully attributed. Native supervision does not require proprietary weights. Configuration follows facts → candidate → validation → review/rehearsal → versioned activation; it never grants authority or revives revoked access or spent credit.

## 4. Model-aware harness and task execution styles — MH-1 preserved

Approved direction, amendment MH-1. Diomedes owns a true harness: model-facing tool design, context assembly, typed action validation, execution policy, observations, bounded correction and outcome verification. Adapters provide model or external-agent access beneath that ownership. This amendment records requirements; it does not certify their implementation.

Personal technical work, software engineering, learning and non-business projects are first-class uses of the same harness as business operations. Execution quality, benchmark performance, token and cost efficiency, latency and recovery reliability are product requirements for both Personal and Business. Evaluate quality and safety alongside efficiency; a shorter answer or skipped verification is not an improvement. Earlier rationale declining a coding-loop competition does not limit this approved performance work or prohibit reuse of suitable components.

Select and record an execution style per task: a Diomedes-owned model/tool loop for full control of the tool interaction, or a bounded external-harness task using only the controls that route demonstrably exposes. Record exact model/provider/route/payer, capability revision, tool behavior profile and profile digest. A change occurs at an explicit admitted checkpoint; it never silently changes authority, payer or data policy. Direct external-engine use remains first-class and truthfully attributed.

Projects support a lead Agent backed by a selected model that plans, distributes bounded tasks, reviews worker results and integrates a verified outcome. Project-only single-agent work, Team view on its own, temporary workers and Project-plus-Team work are all supported product requirements. Projects retain durable context/files/tasks/history; Teams organize workers. Both views share the existing task/run/artifact records, and all effects still need an explicit authorized work target. H13/H14 own orchestration/delegation; H09/H18/H19/H20 own profiles, scoped context, views and comparative evidence. Measure single-agent versus lead/worker quality, total tokens/cost and latency including coordination; delegation is not automatically more efficient. This coordination experience is planned, not certified by the documentation amendment.

SDKR remains the Vercel AI SDK direct-model operation bridge under the existing ModelAdapter. H01 owns external route contracts; ACP remains the preferred supported external transport. Optional HarnessAgent experiments stay in SDKO and do not replace either contract or introduce a second runtime.

Close the explicit tool-behavior gap in H09, H12 and H13: version and test the model-facing schema or grammar, instructions/examples, parser, result feedback and recovery policy together. Translate responses into the same canonical typed actions, validate them, then authorize before effects through H12 and the existing recorded writer. Software edit formats belong in the Software Engineering Capability Pack; non-coding typed operations use the same Core boundary. Compare model/profile combinations on verified completion, malformed calls, stale edits, no-progress loops, corrections, latency and usage/cost before adopting a default. No universal performance gain is claimed.

A sandbox bridge is transport into an execution boundary, not the boundary itself. Verify filesystem, network, credentials and process containment; host-side tools still require Trust checks. Model inference location, control protocol and tool execution location are independent choices. A local app-server can serve a cloud model and is not rejected solely for being local. Prefer the mediated sandbox execution path for effectful work; refuse or narrow work when the necessary containment or external controls are absent.

Reuse suitable proven mechanisms, including evaluating oh-my-pi tool formats, subject to compatibility, licensing and measured benefit. Diomedes retains Runtime, Trust, Store and History ownership. The implementation and acceptance details are in docs/product/2026-09-17-model-aware-harness.md and shared/MODEL_AWARE_HARNESS.md in the unified execution package. Existing prerequisite reviews, Field Readiness milestones and optional SDKO status remain unchanged. Those references describe the existing MH-1 package; their presence on a local branch must be checked rather than inferred from this index.

## 5. Runtime, Projects, Files and packs — retained integration constraints

Diomedes contract first; ACP is the preferred supported external transport. H01 remains the common external-route seam and server/harness/RunService the durable execution spine. Text adapters and native app-server paths must conform rather than become parallel runtimes. Text-only is a narrow single-turn support mode, not the universal agent interface. Supported session lifecycle, streaming, tools, approvals, steering, cancellation, resume/fork, artifacts and evidence must be declared honestly. Codex, Claude Code and OpenCode stay native unless a pinned ACP route proves equal or better capabilities; the shared ACP client supports configuration-driven external routes. Preserve the Cursor/Devin conformance requirements without treating a past proof sequence as a current worker assignment. Compatibility questions remain in QUESTIONS.md O8.

The AI SDK direct-model plane does not absorb external-agent sessions. H12 and the recorded writer mediate effects; observed route capabilities become diomedes-enforced only after native bypass/containment is proved. ACP-reported model identity is observed, not enforced. Team handoffs reuse the existing team MCP host through supported transport or a Diomedes-side proxy, never laundering authority.

A Project is a durable, general-purpose container for context, Threads, Tasks, files/artifacts, rules, permissions and evidence; it is not a repository synonym. The native Agent may work across the Project. One Core Files surface serves business documents and software; the Software Engineering pack adds IDE-grade affordances in that same Console, not another application or file authority. Reuse Project, DocumentInfo, DocumentContent and History. See docs/product/2026-09-10-project-files-and-agent-overview.md and docs/product/2026-09-10-capability-packs.md.

Packs compose tools, Agents, rules, context, workflows and relevant UI, not merely prompts. They do not introduce parallel Runtime/Trust/storage or grant authority when activated. Load only relevant toolsets. Discovered instruction files remain source/version/scope-tracked, inspectable standing guidance through the existing context/rule path. The historical HAR-01 wording disagreement is not resolved by this automation amendment; use its focused implementation record and QUESTIONS.md rather than claiming instructions were never delivered.

Human statuses are pure projections over authoritative tasks, runs, Needs, reviews and evidence. 'Recently' is a display window, not retention. History/receipts/attribution may not be pruned by a blunt setting; deliberate archival/deletion policies remain required. Resolved paths, including Windows short-name aliases, are checked through the existing path guard.

## 6. Connected proof sequence and current evidence discipline

Continue the active coordination program and prerequisite reviews. The following requirements remain, with status determined by current source and fresh verification rather than the older PB/GLM/website handoff wording:

A. Finish the shared readable Console and retire Workbook functionality without breaking existing work. Guided/Standard/Technical changes density, not authority; selected appearance remains intact.
B. Preserve scoped grants, exact consequential approvals, separate reviewer routing, truthful attribution, policy-before-effects, bounded correction, evidence and recovery. An automatic reviewer can withhold, never widen authority; Full access requires a proved eligible environment.
C. Prove supported engine discovery/authentication, real route capabilities and first-run setup without hidden paid prompts, copied credentials or billing changes.
D. Extend local setup through trusted model/runtime installation, compatibility checks, profiles, benchmarking, lifecycle/resource ownership and honest health.
E. Prove a real Diomedes-led workflow with typed actions, useful correction, scoped authority, interruption/restart and postcondition verification; prove a second route/context without replacing durable semantics.
F. Before shared hosted access, prove production identity/membership, server-checked entitlement, company-held keys, tenant-bound reserve/settle metering, protected distribution, support/data handling and offboarding.
G. Deliver Automations A then B with the existing prerequisites; measure non-coding usefulness, review/correction costs and repeatability. More complex connectors, remote and multi-location execution follow their own gates.

The preserved repository body contains distinct implementation evidence for PB-01/PB-03, permissions/Agents, Files/instruction delivery, release journeys and Automatic Change Review/H22. It is not discarded and must not be relabeled 'not started' because the older cloud text omitted it. Focused records include docs/implementation/2026-09-10-reviewer-and-agents.md, docs/implementation/2026-09-12-integration.md, docs/implementation/2026-09-12-har01-delivery.md, docs/implementation/2026-09-13-fil02-export-import.md and docs/implementation/2026-09-15-automatic-change-review.md.

For release/build status, read current repository/release metadata, docs/harness/RUNTIME_VERIFICATION.md, docs/harness/CHANGES.md and the exact candidate record under evidence/release-candidates. The September 18 source snapshot includes evidence/release-candidates/diomedes-0.1.3-windows-experimental-20260918-0ecb53df46d6.json. Historical v0.1.1 pointers and copied green counts are no longer presented here as the current release or fresh tests. No application tests, Windows journey or production availability checks were performed for this documentation update.

## 7. Business and commercial constraints — unchanged

Services-assisted software adoption remains the strategy: internal/personal use → consultant operating layer → narrow approved design-partner workflow → measured case study → repeatable hospitality offering → broader reusable business workflows. Sell one recognizable job; retain the universal configurable core. Consulting does not require pretending production SaaS billing is ready.

Pricing authority is docs/business/PRICING_STRATEGY_2026-09-15.md, including its 2026-09-15.3 Private AI distinctions; no new price or entitlement is approved here. The 90-Day Workflow Starter remains $299/month for three months ($897 total), no separate Business subscription during the program, one workflow/location, up to two supported inputs, 60–90 minutes remote onboarding, bounded usage and human review. Custom engineering, substantial cleanup, on-site work, unlimited support and an SLA are excluded. No automatic continuation. Planned Business starts at $199/org/month once operational; Managed starts at $750/month by agreed scope. The exact included managed-inference allowance remains unresolved, not the old illustrative $300/$100 candidate.

Existing advisory/audit/pilot/implementation/local-service anchors and founding-pilot exceptions remain in the pricing authority and incorporated detailed bodies. Do not substitute old income scenarios for current quotes. Provider cost, allowance debit and invoice are distinct. Count child/reviewer/correction costs. No automatic overage, hidden payer change, embedded company keys, fake checkout or resale of personal subscriptions. Published Apache-2.0 rights are unchanged.

Use synthetic/approved data initially; prospects are not signed customers or permission. No unapproved names, logos, private projections, fabricated ROI, compliance claims or 24/7 support promise. Measure net time after review/rework/maintenance; salary capacity is not cash savings. Preserve tenant-scoped data/credentials/events/search, backups, restore tests, revocation/offboarding and incident responsibilities. Capital efficiency remains required; no day-one server or uncapped subsidized inference requirement.

Website copy stays plain-language first with optional deeper scope, real build-proven captures, accurate availability and working release links. Service scope disclosures do not prove product automation exists. Preserve the Inspectable Service Scope decision and docs/business/SERVICE_SCOPE_PROGRESSIVE_DISCLOSURE_2026-09-15.md. Website components are not application implementations or operational authority. Historical named website-agent assignments do not supersede current work claims.

## 8. Local Infrastructure and longer-term capabilities

Retain docs/product/2026-09-15-local-infrastructure.md, docs/implementation/2026-09-15-local-infrastructure-work-items.md (LI-01–LI-12) and docs/business/2026-09-15-private-ai.md. Capability/workload → existing routing/admission → provider/runtime adapter → interchangeable hardware. Extend discovery, artifacts/profiles/storage, compatibility, lifecycle, capacity, health, operating windows and scoped remote management without another Runtime, Trust, file authority, scheduler or remote shell. Automations B supplies the shared scheduling boundary; LI operating windows reuse it.

Cloud/local/hybrid are policy-controlled deployment choices. Local failure never authorizes cloud disclosure or payer change. Shared hosts require proved client/location isolation. Always-on, service startup, business-hours and wake/reconnect policies require platform evidence and imply neither HA nor staffed support. Hardware is customer-owned or passed through at cost, without markup; ending Managed support must not intentionally disable purchased infrastructure. Provide a functional self-managed handover where technology/licensing permits. Future TCO assessments may recommend cloud; future Verified Local claims need reproducible exact-configuration evidence.

Durable deterministic-plus-agent workflows, waits/queues and remote device identity/pairing/revocation remain requirements under the shared Runtime. Broader orchestration, secure phone status/approval/stop, replay/forks, execution portability/isolation, artifacts without forced GitHub, teach-by-demonstration, MCP Apps/A2A, governed memory/skills and evidence-based improvement remain longer-term extensions. Basic Automations visibility and the bounded recurring slice are no longer buried only in a generic long-term list.

Learning proceeds through observed evidence → candidate rules/skills/prompts/routes → replay/evaluation → reviewed versioned promotion → monitoring/rollback. Customer facts prefer governed retrieval/configuration; weight tuning requires legitimate data, provenance, held-out evaluation and measurable benefit. Learning cannot expand permissions, secrets, payer/data policy or tenant scope.

## 9. Open decisions and publication boundary

Existing open decisions remain: production identity/recovery and device keys; billing/offline entitlement; signed distribution; isolation eligibility; supported model/runtime matrix; cost-qualified hosted allowance; client data isolation; detailed workflow representation and scheduling defaults; first authorized external effect; named connectors; plan/host/location limits; support coverage; hiring triggers; native supervisor specialization. The Automations section and shared-runtime direction are now planned explicitly; detailed contracts, implementation reviews and evidence still gate construction and availability.

PILLAR IMPACT: advances P01, P02 and P04–P12; no intentional pillar supersession. Prevent duplicate lifecycle owners, false success/always-on claims, tenant leakage and unbounded costs.
ROADMAP IMPACT: publishes the existing-plan consolidation, its A01–A36 acceptance matrix and A–D milestones; preserves MH-1, H01/H12/SDKR boundaries, local infrastructure dependencies and prior implementation evidence.
BUILD STATUS: unchanged by this documentation work; no application tests run.
PUBLICATION STATUS: this version is the authorized documentation checkpoint; see docs/implementation/2026-09-19-automations-work-items.md for scope and verification boundaries.
DEPLOYMENT STATUS: no app release, website deployment or live customer automation performed.
