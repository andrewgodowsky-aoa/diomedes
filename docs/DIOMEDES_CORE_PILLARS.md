# DIOMEDES CORE PILLARS — BINDING PRODUCT CONSTITUTION

**Version:** NC-PICKER-2026-10-08.1 (mirror reconciled 2026-10-09; the 2026-10-09 paragraph below awaits cloud synchronization)
**Status:** Owner-approved product/business/agent/design authority  
**Product:** Nectovia (named Diomedes until 2026-09-22)  
**Company direction:** Diomedes Systems  
**Cloud canonical:** https://docs.google.com/document/d/1O0bWr5HEryEQmtOsUput0sgzLhk2c_Ze6MaXoMfKta4/edit

## Subscriber-only Agent and the unified picker

Decision recorded: Oct 8, 2026

This explicit owner decision supersedes the earlier no-plan purchased-credit exception for Nectovia Agent access. Agent requires a current paid Nectovia subscription in the work's own scope. Free Work and eligible direct engines remain available. Existing credit balances and ledger history are preserved.

Paid subscribers may optionally choose an eligible lead model for each available care tier, with Automatic as the default. Expert retains its separate plan eligibility. Agent profile, care tier, model choice, provider speed and permissions remain distinct. Provider models and supported options refresh from the selected connection and adapter; refresh never silently replaces a saved choice or activates a premium option. Unknown capability semantics require adapter support.

Combined design: [Nectovia — Subscription-aware orchestration — Owner decisions — 2026-10-03](https://docs.google.com/document/d/1Mf5bpahUDIX2l2CP0sUFScwbEqLEuQjnYuCCWIZcxdI/edit)

Hybrid picker and own providers, recorded 2026-10-09 (cloud synchronization pending). Andrew decided that the model picker is a hybrid. One popup from the existing model picker holds two parts: Nectovia (managed routing, the care tiers and Automatic) and the person's own providers (OpenAI with ChatGPT sign-in or API key, and others). On a paid plan both parts are open in Work and in the Agent, and a paid Agent may run on the person's own providers as well as on Nectovia routing. On a free plan, Work keeps the picker with the person's own providers; the Nectovia part shows blurred with an upgrade line, and the Agent panel is closed the same way. The upgrade leads to a plan, never to buying credits. In Settings the Engines section becomes Providers, with one section per provider holding its sign-in fields; engine stays the internal term for an adapter. This applies Pillar 12's rule that customer-owned subscriptions, APIs and local inference may power paid Agent work without granting access. Provider terms still govern a subscription sign-in used for paid Agent work (DIO-175), a personal subscription still never pays for Business work, and Expert keeps its own eligibility. Refined the same morning: the tiers stay on top. The Nectovia part shows Efficient, Focused, Thorough and Expert, and inside a tier a paid person keeps Automatic or chooses the model, which may be one of their own connections as the lead. The Agent needs a paid plan (Individual, Business or above). Credits pay for Nectovia-routed calls; when they run out, the person buys more or moves the lead to their own providers, and nobody is forced onto Nectovia routing. Mixed-family runs: a person's own connection may lead while Jev and a checker from a different model family run through Nectovia. That needs a model-family field on the capability record (DIO-215), a checker-family rule (DIO-145), receipts that name each step's model and payer, and evaluation evidence (DIO-149) before any public claim about quality. Still open: the customer-facing name for mixed-family runs, and whether an own-lead run continues without Nectovia's checks when credits are at zero. Tracked in DIO-309, DIO-312, DIO-313, DIO-272 and DIO-245. This records direction; nothing here is implemented.

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

**Technical contract:** Restaurants, warehouses, construction/remodeling, professional services, technical/personal work and later larger organizations use the same Core/Runtime/Trust/Observatory/Interop foundations. Industry differences are expressed through capability packs, workflows, schemas, mappings, rules, connectors, UI configuration and organization facts rather than product forks. A new business type may require new integration semantics, but should not create a second Diomedes architecture. Departments may specialize that same product through scoped packs and private configuration. Restaurants are an initial learning/design-partner context, not a required hospitality-first growth path; select customer segments by workflow fit and measured delivery economics.

**Human version:** Diomedes is not restaurant software or construction software. It adapts the same system to the work a business actually does.

**Real proof / website capture:** Show the same Diomedes work object handling two reproducible scenarios side by side: a restaurant scheduling workflow and a warehouse inventory workflow. The visible differences come from the connected capabilities/rules/data, while the core task/review/history experience remains recognizably the same product.

## Pillar 03 — Meet work where it already lives

**Technical contract:** Prefer coordinating the systems a customer already uses before replacing systems of record. Connect supported POS, scheduling, inventory, accounting, email, files, project management, reservations, field-service and other tools through truthful adapters/capabilities. Email, calendar, exports, PDFs, shared folders and photos are first-class inputs when a direct API is unavailable. Never represent an export/read path as write authority. Recommend removing another product only after measured evidence shows its actually used functions are safely redundant and hidden obligations have been evaluated. Evaluate legitimate alternative access paths before declaring a workflow unsupported, and report partial coverage and freshness. Customer-authorized database views, exports, report feeds and permitted browser-assisted work may be useful where available, but no wrapper bypasses vendor or security requirements. Replacing a bounded software function is an eligible paid implementation only after migration, total-cost, reliability, security and exit obligations are explicitly assessed.

**Human version:** You should not have to throw away the software your business already knows. Diomedes should connect the useful pieces and remove the busywork between them. If another subscription truly becomes unnecessary later, that should be proven rather than promised.

**Real proof / website capture:** A business owner asks for an operations update. The Diomedes result cites information gathered from two or three existing sources, such as email plus a schedule/export plus accounting/project records, then clearly shows which next step is only a draft or needs authorization.

## Pillar 04 — Put information and action where the worker needs it

**Technical contract:** Diomedes is not limited to a desktop chat surface. The correct interaction may be Console, tablet/iPad PWA, phone/remote view, notification, scheduled brief, embedded tool surface, or later another authorized device. Device interfaces must use the same organization identity, permissions, source truth and evidence semantics. Fast operational lookups/actions remain direct; agent reasoning should not block simple point-of-work tasks.

**Human version:** The useful answer should be where the work happens. A warehouse worker should not cross a building just to check a number that can safely be shown on the tablet in front of them.

**Real proof / website capture:** A real Diomedes tablet view on an iPad-sized viewport showing item search/scan, aisle/rack/bin, recorded quantity, last check and a permitted count update, with a desktop supervisor view showing the same event/history.

## Pillar 05 — Self-setup and self-maintenance are primary product requirements

**Technical contract:** The normal customer path must increasingly install, configure and maintain itself. Diomedes should discover supported engines/hardware after disclosure, guide provider-supported authentication, connect authorized business tools, recommend relevant capability packs, configure local models when chosen, rehearse/validate workflows, monitor health, update safely, diagnose common failures and recover known problems without Andrew. Paid setup/deployment services mean “have us do it with/for you,” not “the software only works if the founder manually configures it.” Persist the versioned questions, original answers, interpreted facts, unresolved items, active configuration, package bindings and rehearsal evidence to the organization under authorized account access, with protected local caching where appropriate. Reopening, signing in, switching devices or transferring ownership loads or resumes that state instead of repeating the quiz. Ask only justified incremental questions. Configuration completion, current health, authentication, permissions and paid entitlement are separate states.

Connected subscription, ACP and other native engines follow their own updates. Nectovia must discover the current selected installation, protocol capabilities, account models and reasoning options without a vendor-version allowlist or an app release for each new model. Recheck changed installations and refresh model choices before dispatch; fail explicitly when a required capability or chosen model is unavailable. Preserve account, conversation, sandbox, data, payer and entitlement boundaries across updates. Installation receipts identify downloaded bytes and historical tests identify what was verified; neither freezes future supported engine versions.

**Human version:** You should be able to get Diomedes working without becoming an AI expert or waiting for the founder to come fix every computer.

**Real proof / website capture:** A new business completes a short intake, reviews the suggested capabilities, authorizes a supported source and gets a verified useful result. Close and reopen the app, sign in on a second device and transfer an owner role: the same configuration returns without a repeated quiz. An expired connector requests only reauthentication; a changed requirement requests only relevant new answers.

## Pillar 06 — No routine babysitting; control without constant clicks

**Technical contract:** The target is durable outcome ownership: objective → plan → authorized work → monitoring → correction/retry/recovery → verification → result. Scoped grants, standing guidance, triggered correction, pre-effect policy, budgets, drift detection, evidence and reconciliation absorb routine supervision. Exact approvals remain available for consequential or ungranted effects. “Autonomous” never means authority expansion, hidden billing changes, self-approval, or guessing through an uncertain external effect.

**Human version:** Tell Diomedes what you want done and the boundaries it must respect. It should handle ordinary work inside those boundaries and come back to you only when a real decision or exception needs you.

**Real proof / website capture:** Restaurant scheduling: Diomedes builds the week from availability/rules/forecast inputs, resolves routine constraints, flags only genuine conflicts, and presents a near-complete schedule plus one or two “Needs you” decisions instead of asking for approval at every step.

## Pillar 07 — Diomedes is the agent; models and engines are interchangeable resources

**Technical contract:** Native Diomedes Agent owns the supervisory loop and can use customer subscription-backed routes, local models, BYO APIs, Diomedes-hosted inference, or specialist external engines. Preserve actual model/engine/provider/payer attribution and never silently change payer, provider, data policy, or authority. Direct-agent mode remains distinct from native Diomedes-led work.

When a person chooses to prefer an eligible connected subscription, Nectovia may use it for supported work within that person's own authorized scope, on that person's computer, and only through that engine's own coding tool (its installed command-line or app-server program, signed in through the provider's own flow). It never uses a consumer chat product, its sessions or its credentials. Product entitlement, provider eligibility, account ownership, data permissions and spending authority stay separately enforced. Managed inference stays ready to use without any subscription, and connecting one never turns the preference on by itself. A subscription never funds pooled or shared organization work. A worker's subscription usage does not debit Nectovia credits; any managed supervisor, tool or verification usage in the same job stays attributable.

**Human version:** You do not need to bring, buy or share an AI subscription to use Diomedes. It can run on the AI an Individual or Business plan includes, on a supported customer-owned provider or subscription route, or on a capable local computer. You are paying for Diomedes to organize the work, not for a mystery model name.

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

**Technical contract:** Repeated setup/support work becomes product automation, diagnostics, self-repair, documentation, capability packs or a support playbook. Support follows prevention → automatic recovery → Diomedes support agent → human support → engineering escalation → founder only for genuinely novel/product-level decisions. Human support roles are deliberately scoped; no employee becomes an overloaded universal fixer. Customer #50 should require materially less founder intervention than customer #1. The long-term objective is more active retained business accounts per delivery/support employee without worse service. Track human setup time, support and intervention minutes per account, service mix, incidents, retention and accepted-result cost alongside accounts per full-time equivalent. Use those observations to productize repeated work, not to assume unlimited employee capacity.

**Human version:** The company should not need one Andrew for every customer. Diomedes should handle normal setup and problems itself, with real people available when something actually needs them.

**Real proof / website capture:** A support case inside Diomedes: connector health check detects expired authentication, tells the authorized user exactly what is needed, resolves the connection after reauthentication, verifies the workflow, and closes the incident without founder intervention. A second example shows a genuine unknown issue escalated with a diagnostic bundle already attached.

## Pillar 12 — One strong core; different experiences without artificial crippling

**Technical contract:** Free, paid Individual and Business use the same strong Core/Runtime/Trust foundations. Free retains the capable self-managed workspace and eligible customer-owned direct engines. Nectovia Agent requires a current paid Nectovia Individual or Business subscription entitlement for the selected Personal or Business work scope; it is no longer Business-only. Purchased credits, a connected provider subscription, an API key or local inference do not grant Agent access. People without a paid Nectovia subscription retain Work threads, manual boards and eligible direct-engine work. Individual is $200/month with 1,000 monthly credits for one named human's Personal work. Every Business workspace needs its own Business plan, including a one-member business or sole proprietorship. Supported customer-owned subscriptions, APIs and local inference may power paid Agent work without themselves granting access. Business remains $300 per organization/month with 1,000 credits and adds organizational ownership, human membership/roles, shared operational connections/workflows, administration and the existing explicitly bounded design/service scope. Multiple AI workers, personal rules, boards and eligible personal automations do not by themselves require Business. Local computer permissions and basic safety are not Business-only. Guided/Standard/Technical presentation changes information density, not authority. Exact legal and launch policy wording requires review; product direction is not proof of shipped functionality.

Free accounts can use Work threads, update boards manually and use eligible direct engines with their supported work profiles. Selecting Auto, Researcher or Builder there never unlocks paid Nectovia Agent, its care-tier model preferences or hosted model advice. Preserve existing purchased-credit ownership, balances, expiry, holds, settlement and history. A provider connection or credit balance is not subscription entitlement.

**Human version:** The simple version should not be fake or weak, and the technical version should not be a different product. Diomedes should explain itself differently depending on how much detail you want.

**Real proof / website capture:** Show the same completed work in two real UI views: a plain-language owner view (“Schedule ready. One conflict needs you.”) and Technical detail expanded underneath with agent/model/engine, rules, evidence, route and verification. Both refer to the same durable work object.

## Pillar 13 — Governed learning is part of the core

**Technical contract:** Nectovia improves through an evidence-backed learning loop: observed work and corrections → candidate memory, mapping, rule or skill → replay and held-out evaluation → authorized versioned promotion → monitoring and rollback. This Hermes-inspired loop is a core product requirement, not an optional final-stage enhancement. Distinguish sourced business facts, user preferences, procedural skills, pending work and enforced policy. Keep customer learning private to its permitted organization and department unless separately authorized for broader reuse. Prefer retrieval and configuration over model-weight changes for changing business knowledge. Learning may propose improvements and reduce repeated work; it may never grant authority, alter payer/data-processing policy, expose restricted information, or promote its own unsupported conclusions as truth. Any automated promotion must use a separately approved bounded policy with independent checks, never the proposing model's self-approval.

**Human version:** Nectovia should remember how your business works and get better from checked results, without quietly changing the rules or sharing your information.

**Real proof / website capture:** A corrected invoice mapping becomes a private candidate procedure, passes held-out examples, is approved by an authorized reviewer, and is reused on a later job. Show its source, version and improvement evidence, then a regression-triggered rollback that does not revive revoked access.

## Pillar 14 — One organizational brain, scoped departmental capabilities

**Technical contract:** One organization can use different capability packs, workflows and interfaces for IT, HR, finance, management and other departments on the same Core/Runtime/Trust and durable records. Shared organizational facts and definitions form a logical knowledge layer, not an unrestricted global prompt or physically mandatory single database. Department/project overlays specialize capabilities without weakening organization policy. Preserve source permissions through retrieval, caches, summaries, embeddings, agents, artifacts, search results and notifications; a supervisor or administrator role does not by itself authorize every source. Cross-department work uses explicitly permitted inputs and handoff outputs. Govern external databases, files and indexes with source identity, freshness, versions, lineage, access revocation and conflict/drift detection. Configuration, executable permissions and knowledge remain separate authorities.

**Human version:** Each department gets the tools and knowledge it needs, while the business stays coordinated and private information stays private.

**Real proof / website capture:** HR, IT and a manager coordinate onboarding through the same task record. IT receives the approved equipment request but cannot retrieve salary or disciplinary records. A source policy changes; dependent work detects the drift and requests review without restarting company setup.

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

Passing the test does not mean all pillars are fully implemented. The result should explicitly identify: **proven now, partially proven, blocked, and planned**. Missing proof becomes roadmap work rather than marketing copy.

## SC-2026-09-26.1 — Amendment scope

Andrew approved persistent business self-configuration, governed core learning, departmental capabilities, cross-industry positioning and measured scaling of accounts per employee. P02, P03, P05 and P11 are expanded; P13 and P14 are added. Existing safety, paid-Agent entitlement and source-evidence requirements remain. The detailed decision record is docs/product/2026-09-26-self-configuring-business-platform.md. Documentation approval does not certify implementation.

## Change control

This document should remain short enough to read at the start of meaningful work. Add or split a pillar only when a durable concept cannot fit an existing one without ambiguity. Implementation details belong in focused specs/roadmap; examples/captures may evolve while the underlying pillar stays stable.

Version changes:
- **Patch:** wording/examples/proof clarifications with no semantic pillar change.
- **Minor:** new pillar or material expansion approved by Andrew.
- **Major:** a deliberate change to the Diomedes product/business constitution.

Amendments:
- **2026-09-19.1 (minor, Andrew's explicit decision):** Pillar 07 no longer says to prefer intelligence the customer already pays for, and its human version no longer opens with the customer's own ChatGPT or Claude subscription. Customers are not expected to bring, buy or share an AI subscription; a customer organization's own provider account and a local model remain valid routes, and a personal subscription is still never company inventory. No other pillar changed. The canonical cloud document could not be written from the session that made this change; a current cloud mirror of this version is recorded in docs/reference/CLOUD_SYNC_2026-09-19.md.
- **2026-09-22.1 (patch, Andrew's explicit decision):** the product, app and agent are named Nectovia; Diomedes Systems (LLC) remains the company. No pillar's meaning changed. Until a wording pass, "Diomedes" in pillar text means the product now named Nectovia, except where it names the company. Shipped identifiers (app id, installer and update channel, userData, environment variables, repositories, diomedes.net) are unchanged by the rename. Andrew named the product on 2026-09-22 and approved this amendment on 2026-09-23. This text was written into this cloud canonical on 2026-09-24 from the repository mirror (docs/DIOMEDES_CORE_PILLARS.md, origin/main 559a1ab); docs/reference/CLOUD_SYNC_2026-09-24.md records it.


- **2026-09-25.1 (minor, Andrew's explicit decision; synchronized 2026-09-26):** Personal retains the workspace and direct customer-owned engines. The native Nectovia Agent requires a business plan or scoped grant independently of the inference payer. This preserves the newer repository Pillar 12 rather than reverting it from the older cloud snapshot.
- **2026-09-26.1 (minor, Andrew's explicit decision):** Expanded P02/P03/P05/P11 and added P13/P14 under SC-2026-09-26.1. Persistent self-configuration, governed learning, scoped departmental knowledge and measured accounts-per-employee scaling are core direction. No runtime release, pricing change or production-access permission is implied.
- **2026-09-27.2 (Andrew's explicit decision):** Connected engines follow their own updates and report current account models and capabilities. Remove vendor-version allowlists; preserve artifact integrity and account, route, data, payer and paid-Agent boundaries. Free users retain manual boards and direct engines, with no Nectovia Agent access. The current NC-IF Individual offer supersedes the earlier 500-credit proposal; documentation direction does not certify implementation.
- **2026-10-05.1 (minor, Andrew's explicit decision; synchronized 2026-10-05):** A person without a plan may buy credits at the no-plan price ($130 for 1,000) and, while they hold them, use Nectovia Agent for their own Personal work: conversations and tasks they start. Plans buy extra credits at $100 for 1,100 and keep Routines, phone access, business rules, the team lead and Business workspaces; every Business workspace still needs its own Business plan. Credits are priced per tier from a private, versioned price table, so what a credit buys can be retuned from real usage without changing what customers pay for credits. Credits a customer buys expire 12 months after purchase, oldest first. This supersedes the free-user wording of 2026-09-25.1 and 2026-09-27.2. Documentation direction does not certify implementation.
- **2026-10-06.1 (minor, Andrew's explicit decision; synchronized 2026-10-06):** Pillar 07 adds the connected-subscription preference as an opt-in. A person may choose to prefer an eligible connected subscription for supported work in their own authorized scope, on their own computer, and only through that engine's own coding tool; it never uses a consumer chat product, and a subscription never funds pooled or shared organization work. This narrows 2026-09-19.1 without reversing it: customers are still not expected to bring, buy or share a subscription, managed inference stays ready without one, and connecting one never turns the preference on by itself. A worker's subscription usage does not debit Nectovia credits. Drafted 2026-10-03 and approved 2026-10-06. Documentation direction does not certify implementation.

## NC-IF-2026-09-27.1 — Owner-approved Individual and computer-access amendment

P12 now distinguishes Free, paid Individual and Business. The current personal offer is $200/month with 1,000 credits, not the earlier Solo proposal. Entitlement, inference payer, resource permission and organizational use remain separate.

P06/P08/P09 clarification: an authorized owner may deliberately grant broad local computer scope, including sensitive files and supported unsandboxed execution, and choose no repeated local confirmations. Settings must make this a real usable choice rather than a project-only mode with a different label. A trusted human standing grant is authorization, not model self-approval. Preserve narrow defaults and exact task-mode choices, but do not impose immutable Nectovia folder/secret restrictions after the owner explicitly chose the broader supported mode.

Full access means what the chosen OS identity and actual engine can do. It does not grant administrator/root power, bypass provider rules, unlock paid Agent access, change payer or expose another tenant through company services. Data sharing/indexing and remote/unattended authority are separate choices. Unrestricted same-user shell cannot honestly promise complete local isolation, tamper-proof logs, universal undo or protection of all same-user secrets; dedicated execution identities are needed for strong multi-tenant isolation. Keep renderer/IPC security and server authorization intact.

Documentation direction is approved; exact implementation design, tests, platform proofs and release remain separate. Older pilot/customer limits remain in force for those engagements. Repository mirrors require source-aware synchronization; do not overwrite newer repository decisions from this cloud document.
