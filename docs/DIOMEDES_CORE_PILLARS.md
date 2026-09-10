# DIOMEDES CORE PILLARS — BINDING PRODUCT CONSTITUTION

**Version:** 2026-09-10.1  
**Status:** Owner-approved product/business/agent/design authority  
**Product:** Diomedes  
**Company direction:** Diomedes Systems  
**Cloud canonical:** https://docs.google.com/document/d/1O0bWr5HEryEQmtOsUput0sgzLhk2c_Ze6MaXoMfKta4/edit

## Purpose

This document is the compact drift-check layer above the detailed roadmap and project memory. It exists so product, business, agent, harness, UX, support, sales, website and implementation work continue to describe the same Diomedes even as many agents and worktrees move quickly.

Authority order when sources disagree:
1. Andrew's newest explicit decision.
2. These Core Pillars for durable product/business constraints.
3. The current live roadmap for sequencing and implementation priorities.
4. The current project-memory document for definitions and detailed standing decisions.
5. Current source and fresh verification for what is actually implemented.
6. Older plans and research as rationale only when not superseded.

A pillar is not silently overridden by a local implementation choice, model recommendation, website copy, competitor pattern, or old plan. If proposed work materially conflicts with a pillar, the agent must call out the conflict before proceeding. Only Andrew's newer explicit decision may amend a pillar. Amendments should update this document, the roadmap impact, and project memory together.

Each pillar has three representations:
- **Technical contract:** precise internal meaning for agents/engineers.
- **Human version:** plain-language meaning suitable for a person who has never used AI.
- **Real proof / website capture:** a reproducible scenario inside the actual Diomedes harness/product that can demonstrate the pillar without abstract marketing art.

## Pillar 01 — Solve the work, not “add AI”

**Technical contract:** Diomedes selects the simplest reliable mechanism that completes the user's real objective. Deterministic code, database queries, rules, integrations, search, structured workflows, or normal UI operations should remain deterministic when reasoning is unnecessary. Models are used where interpretation, planning, synthesis, ambiguity resolution, delegation, or judgment adds value. Do not add model latency/cost to trivial operations merely to make a feature appear intelligent.

**Human version:** Diomedes is there to save work, not to put AI into everything. If a fast normal lookup solves the problem, it should just do the lookup. AI steps in when the job actually needs reasoning.

**Real proof / website capture:** Warehouse inventory on an iPad. A worker scans or searches an item and gets the recorded location/count immediately from the inventory source; no model waits. A second panel shows Diomedes reasoning over shortages, suspicious counts, or job requirements only when analysis is useful.

## Pillar 02 — One configurable Diomedes, many kinds of work

**Technical contract:** Restaurants, warehouses, construction/remodeling, professional services, technical/personal work and later larger organizations use the same Core/Runtime/Trust/Observatory/Interop foundations. Industry differences are expressed through capability packs, workflows, schemas, mappings, rules, connectors, UI configuration and organization facts rather than product forks. A new business type may require new integration semantics, but should not create a second Diomedes architecture.

**Human version:** Diomedes is not restaurant software or construction software. It adapts the same system to the work a business actually does.

**Real proof / website capture:** Show the same Diomedes work object handling two reproducible scenarios side by side: a restaurant scheduling workflow and a warehouse inventory workflow. The visible differences come from the connected capabilities/rules/data, while the core task/review/history experience remains recognizably the same product.

## Pillar 03 — Meet work where it already lives

**Technical contract:** Prefer coordinating the systems a customer already uses before replacing systems of record. Connect supported POS, scheduling, inventory, accounting, email, files, project management, reservations, field-service and other tools through truthful adapters/capabilities. Email, calendar, exports, PDFs, shared folders and photos are first-class inputs when a direct API is unavailable. Never represent an export/read path as write authority. Recommend removing another product only after measured evidence shows its actually used functions are safely redundant and hidden obligations have been evaluated.

**Human version:** You should not have to throw away the software your business already knows. Diomedes should connect the useful pieces and remove the busywork between them. If another subscription truly becomes unnecessary later, that should be proven rather than promised.

**Real proof / website capture:** A business owner asks for an operations update. The Diomedes result cites information gathered from two or three existing sources, such as email plus a schedule/export plus accounting/project records, then clearly shows which next step is only a draft or needs authorization.

## Pillar 04 — Put information and action where the worker needs it

**Technical contract:** Diomedes is not limited to a desktop chat surface. The correct interaction may be Console, tablet/iPad PWA, phone/remote view, notification, scheduled brief, embedded tool surface, or later another authorized device. Device interfaces must use the same organization identity, permissions, source truth and evidence semantics. Fast operational lookups/actions remain direct; agent reasoning should not block simple point-of-work tasks.

**Human version:** The useful answer should be where the work happens. A warehouse worker should not cross a building just to check a number that can safely be shown on the tablet in front of them.

**Real proof / website capture:** A real Diomedes tablet view on an iPad-sized viewport showing item search/scan, aisle/rack/bin, recorded quantity, last check and a permitted count update, with a desktop supervisor view showing the same event/history.

## Pillar 05 — Self-setup and self-maintenance are primary product requirements

**Technical contract:** The normal customer path must increasingly install, configure and maintain itself. Diomedes should discover supported engines/hardware after disclosure, guide provider-supported authentication, connect authorized business tools, recommend relevant capability packs, configure local models when chosen, rehearse/validate workflows, monitor health, update safely, diagnose common failures and recover known problems without Andrew. Paid setup/deployment services mean “have us do it with/for you,” not “the software only works if the founder manually configures it.”

**Human version:** You should be able to get Diomedes working without becoming an AI expert or waiting for the founder to come fix every computer.

**Real proof / website capture:** A clean first-run sequence inside the real app: hardware/engine discovery → connect ChatGPT through Codex or another supported route → select a relevant capability pack → connect a business source → run a rehearsal → show “ready” only after verification. Capture both the normal path and a self-diagnosed recoverable error.

## Pillar 06 — No routine babysitting; control without constant clicks

**Technical contract:** The target is durable outcome ownership: objective → plan → authorized work → monitoring → correction/retry/recovery → verification → result. Scoped grants, standing guidance, triggered correction, pre-effect policy, budgets, drift detection, evidence and reconciliation absorb routine supervision. Exact approvals remain available for consequential or ungranted effects. “Autonomous” never means authority expansion, hidden billing changes, self-approval, or guessing through an uncertain external effect.

**Human version:** Tell Diomedes what you want done and the boundaries it must respect. It should handle ordinary work inside those boundaries and come back to you only when a real decision or exception needs you.

**Real proof / website capture:** Restaurant scheduling: Diomedes builds the week from availability/rules/forecast inputs, resolves routine constraints, flags only genuine conflicts, and presents a near-complete schedule plus one or two “Needs you” decisions instead of asking for approval at every step.

## Pillar 07 — Diomedes is the agent; models and engines are interchangeable resources

**Technical contract:** Native Diomedes Agent owns the supervisory loop and can use customer subscription-backed routes, local models, BYO APIs, Diomedes-hosted inference, or specialist external engines. Prefer appropriately capable intelligence the customer already pays for when policy and availability allow. Preserve actual model/engine/provider/payer attribution and never silently change payer, provider, data policy, or authority. Direct-agent mode remains distinct from native Diomedes-led work.

**Human version:** If you already pay for ChatGPT or Claude, Diomedes should be able to use that supported connection. If you have a capable local computer, it can use that too. You are paying for Diomedes to organize the work, not for a mystery model name.

**Real proof / website capture:** A real run shows “Diomedes Agent” as the supervisor while Technical details reveal one worker used GPT through the customer's Codex subscription, another used a local model, and a cheap Diomedes-hosted route handled a small task. The history preserves which route actually did each step.

## Pillar 08 — Human judgment is for judgment; deterministic work stays fast

**Technical contract:** Do not force human review or model reasoning where a deterministic, already-authorized operation is sufficient. Human attention is reserved for ambiguity, consequence, policy boundary crossings and subjective business judgment. A deterministic action must remain traceable and authorized even when it does not require a model. A model may propose a consequential action but does not become its approver merely because it generated the proposal.

**Human version:** People should spend time deciding the things only people should decide, not clicking through routine steps or waiting for AI to perform simple database work.

**Real proof / website capture:** Scheduling or inventory workflow where routine constraints/count retrieval happen automatically, but an unusual staffing conflict or consequential stock adjustment is surfaced as a clearly explained decision for the authorized person.

## Pillar 09 — Trust, data choice and billing are part of the architecture

**Technical contract:** Identity, tenant boundaries, permissions, credentials, provider/data routing, entitlement, spend admission, revocation, audit/evidence and recovery are separate enforced concepts. Basic safety is not a premium add-on. Private processing is the default. Any provider route that may use eligible content for model improvement/training requires an explicit organization choice and must still exclude data the organization lacks authority to contribute. An opt-in never silently changes unrelated data classes, provider routes, or permissions.

**Human version:** A business should know what Diomedes can access, what it can do, where information is processed, and who is paying for the AI it uses. Choosing a lower-cost data-sharing option should be a real choice, not something hidden in fine print.

**Real proof / website capture:** A Business settings screen showing Private processing as the default, connected customer subscription/local/Diomedes-hosted routes with payer labels, and an optional data-contribution setting that clearly states eligible data only. A run inspector shows the actual selected route and policy decision.

## Pillar 10 — Measure value; do not invent ROI

**Technical contract:** Every business workflow should have a defined before/after measure appropriate to the problem: net human time, turnaround, errors, rework, missed follow-ups, software expense, inventory travel/check time, scheduling effort, revenue leakage or another observable result. Net time includes review/correction/maintenance introduced by Diomedes. Recovered salaried capacity is not automatically cash savings. Public examples must distinguish arithmetic illustrations from measured customer outcomes.

**Human version:** If Diomedes is supposed to save time or money, measure it. Do not ask a business to trust a made-up percentage.

**Real proof / website capture:** A pilot result card generated inside Diomedes: “Before: schedule preparation 4h 20m. After: Diomedes preparation 8m + manager review 42m. Net time returned: 3h 30m.” Use synthetic/rehearsal data until a real customer explicitly permits publication.

## Pillar 11 — Diomedes must scale without scaling the founder

**Technical contract:** Repeated setup/support work becomes product automation, diagnostics, self-repair, documentation, capability packs or a support playbook. Support follows prevention → automatic recovery → Diomedes support agent → human support → engineering escalation → founder only for genuinely novel/product-level decisions. Human support roles are deliberately scoped; no employee becomes an overloaded universal fixer. Customer #50 should require materially less founder intervention than customer #1.

**Human version:** The company should not need one Andrew for every customer. Diomedes should handle normal setup and problems itself, with real people available when something actually needs them.

**Real proof / website capture:** A support case inside Diomedes: connector health check detects expired authentication, tells the authorized user exactly what is needed, resolves the connection after reauthentication, verifies the workflow, and closes the incident without founder intervention. A second example shows a genuine unknown issue escalated with a diagnostic bundle already attached.

## Pillar 12 — One strong core; different experiences without artificial crippling

**Technical contract:** Personal and Business use the same strong Core/Runtime/Trust foundations. Personal remains a capable self-managed local/BYO harness. Business adds organization membership/configuration, maintained Agents/Teams/rules, managed inference, business connectors/governance, support and operational services. Guided/Standard/Technical presentation changes information density, not safety or authority. Technical depth remains available; ordinary users are not required to understand internal vocabulary.

**Human version:** The simple version should not be fake or weak, and the technical version should not be a different product. Diomedes should explain itself differently depending on how much detail you want.

**Real proof / website capture:** Show the same completed work in two real UI views: a plain-language owner view (“Schedule ready. One conflict needs you.”) and Technical detail expanded underneath with agent/model/engine, rules, evidence, route and verification. Both refer to the same durable work object.

## Website translation contract

The Core Pillars are internal authority. The public website should translate them rather than paste technical doctrine onto a marketing page.

1. Every public pillar/theme must have a concrete visual example captured from the actual Diomedes product/harness, not an abstract stock diagram or fabricated marketing UI presented as product reality.
2. Captures may use synthetic/reproducible business data. They must never expose real customer, employee, vendor, credential or confidential information without explicit permission.
3. Every capture must have provenance recorded internally: Diomedes build/commit or release, date, scenario fixture, workspace type, viewport/device, theme, relevant model/engine route, and whether the data is synthetic, demo, or an approved real customer example.
4. Prefer a short state sequence over a decorative screenshot when the pillar is about behavior: request → work → exception → verified result. Motion/video is optional; provide an accessible static equivalent and useful alt/caption text.
5. Public copy has two layers:
   - **Plain language first:** written for someone who has never used AI and does not need to learn “agent,” “runtime,” “MCP,” “orchestration,” or model taxonomy to understand the benefit.
   - **Technical detail second:** expandable or secondary copy for people who want the actual mechanisms, limitations, routes, permissions, evidence and architecture.
6. The two layers must describe the same behavior. The human version cannot overclaim what the technical version qualifies, and the technical version cannot redefine the product behind the marketing language.
7. If the current product cannot produce an honest capture for a pillar, label that pillar/capability as in development/planned or omit the capture until it can. Do not fabricate future UI as though it shipped.
8. Website examples should cover different kinds of work so Diomedes does not collapse into a single-industry identity. Initial reusable capture set should include at least: restaurant scheduling, warehouse distributed inventory, a cross-system business admin workflow, self-setup/subscription routing, and a no-babysitting/correction/verification run.
9. Real-world context should be recognizable without becoming a claim about a real customer. “Restaurant schedule,” “warehouse inventory,” or “remodel project update” can use synthetic fixtures. Named customer logos/results require explicit permission and separate evidence.
10. Website layout may group related technical pillars for readability, but every pillar must remain traceable to at least one real product proof/capture and to its human-language translation.

## Drift check required for major work

Every substantial design, roadmap change, implementation slice, website rewrite, business package or agent prompt should include a short **PILLAR IMPACT** section:
- **Advances:** pillar IDs materially strengthened by this work.
- **Risks/conflicts:** pillar IDs this proposal may weaken or contradict.
- **Evidence:** what observable behavior/test/capture would prove alignment.
- **Supersession:** if a conflict is intentional, cite Andrew's newer explicit decision before changing the pillar.

Agents should not mechanically mention every pillar on every tiny patch. The check exists for material work where drift is plausible.

## Tonight's end-to-end proof target

The first full-system run should be designed as both a product verification and the seed for future website captures. Minimum proof sequence:
1. Start from a fresh/known test profile and launch the actual Diomedes build.
2. Complete first-run/setup far enough to prove engine discovery and at least one real supported authenticated route, preferably the existing Codex subscription route.
3. Create/select the correct Personal or Business workspace without authority leaking between them.
4. Start a new task from the normal user surface.
5. Choose or auto-select a real Agent/model/engine route with truthful payer/attribution.
6. Move/admit the task to Ready and verify the expected automatic worker behavior.
7. Exercise scoped permission/rule handling without approval spam; intentionally create one case that genuinely needs the user.
8. Let the worker produce a real result; inspect its output in Diomedes rather than trusting the worker's terminal prose.
9. Exercise one correction/drift/retry path and verify the bound is respected.
10. Verify the result/postcondition and inspect History/evidence/attribution.
11. Restart Diomedes and confirm durable work state/history remains coherent and revoked/expired authority would not silently revive.
12. Run at least one non-coding synthetic business scenario so the proof does not accidentally validate only a programming harness. Preferred scenarios: restaurant scheduling or warehouse inventory.
13. Capture reproducible screenshots/state sequences from the actual harness with synthetic data and provenance for any pillar that the current build can honestly demonstrate.

Passing the test does not mean all twelve pillars are fully implemented. The result should explicitly identify: **proven now, partially proven, blocked, and planned**. Missing proof becomes roadmap work rather than marketing copy.

## Change control

This document should remain short enough to read at the start of meaningful work. Add or split a pillar only when a durable concept cannot fit an existing one without ambiguity. Implementation details belong in focused specs/roadmap; examples/captures may evolve while the underlying pillar stays stable.

Version changes:
- **Patch:** wording/examples/proof clarifications with no semantic pillar change.
- **Minor:** new pillar or material expansion approved by Andrew.
- **Major:** a deliberate change to the Diomedes product/business constitution.
