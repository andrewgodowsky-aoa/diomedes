# DIOMEDES PROJECT MEMORY — CANONICAL

**Version:** 2026-09-10.1  
**Last reconciled:** September 10, 2026  
**Status:** Binding product-definition and current-direction companion to the live roadmap  
**Cloud canonical:** Google Doc `13wYjK1BhEsGzc_yhpRtBz62pGmLxwdwq8pVqe1i4eKw`

## Purpose

This document exists to prevent definition drift across ChatGPT, Astra, Codex, Claude Code, local models, planning threads, website work, and implementation worktrees. It records current product meanings and owner decisions. It does not replace implementation evidence: current source and verification reports remain authority for what is actually built.

Authority when sources disagree:

1. Andrew's newest explicit decision.
2. The newest live roadmap for strategy and sequencing.
3. This project-memory document for canonical names, UX/product meanings, and cross-thread decisions.
4. Current source and verification for implemented reality.
5. Older focused plans and historical Achilles documents only for rationale that has not been superseded.

## Canonical product definitions

**Diomedes Desktop** — the downloadable human workspace. One product, not a collection of unrelated front ends. It presents projects, conversations, plans, work, review, tasks / Auto To Do, documents and artifacts, history, settings, connections, permissions, and later business/team surfaces.

**Diomedes Core** — model/agent semantics: routing, context, layered rules, skills/capabilities, memory, profiles, delegation behavior, advisor behavior, native Diomedes-Agent semantics, and learning interfaces. Core does not own durable mutation authority merely because it decides what should happen.

**Diomedes Runtime** — durable execution authority: command admission, runs/steps, receipts, event state, waits, retries/timeouts, cancellation, queues, budgets, workflows, recovery/resume, external-effect reconciliation, replay/forks, and execution-state truth.

**Diomedes Trust** — identity, authorization, credentials, capabilities, scoped grants, exact approvals, revocation, client/tenant boundaries, information-flow policy, device/session authority, and package/update trust. Authentication and authorization remain separate.

**Diomedes Observatory** — observable traces, usage/cost provenance, outcomes, failures, corrections, evaluations, replay, and evidence used for measured improvement. It does not depend on hidden chain-of-thought.

**Diomedes Interop** — MCP, MCP Apps, APIs, webhooks, ACP/A2A where useful, external events, and integrations with business/personal software.

**Diomedes Agent** — the Diomedes-led supervisory agent. It owns the operational loop: understand the objective, plan, choose routes/workers, assemble context, delegate, monitor, react to failures/rule triggers, request authority, verify, synthesize, and preserve durable work state. At launch its reasoning may come from external subscription-backed models, APIs, or local models. Long term it may use a Diomedes-tuned local supervisor model; that model is an implementation beneath Diomedes Agent, not the definition of the product.

**Direct-agent mode** — the user intentionally chooses an external agent/runtime such as Codex, Claude Code, OpenCode, Hermes, or another supported engine as the primary reasoner/executor for a task or thread. Diomedes retains project state, permissions, rules, evidence, and whatever interception/control the adapter can truthfully enforce. Direct-agent mode must not be described as native Diomedes-agent work.

**Engine** — the execution harness/runtime or integration, e.g. Codex, Claude Code, OpenCode, Hermes. **Model** — the foundation/local model that actually generated a turn, e.g. GPT, Claude, Muse, Qwen. **Provider/account route** — the account or service through which the model is reached, including subscriptions, BYO API, local endpoint, or approved hosted route. These are separate fields even if the normal UI combines them cleanly.

**Worker** — a bounded participant assigned a job. A worker can use an engine/model, but is not itself the engine or model.

**Skill/capability** — reusable procedure/tooling available to a run. **Workflow** — durable multi-step execution semantics. **Rule** — standing guidance, triggered correction, or enforced policy. **Permission/grant** — authority already delegated to a scope. **Approval** — a decision about a particular consequential request or a defined bounded scope. These terms are not interchangeable.

## One desktop surface and visual language

The long-term desktop has one primary surface: the Console. The old Workbook is being retired into the Console rather than maintained as a second product. Guided / Standard / Technical are information-density/detail choices over the same product and must never silently change authority.

The visual reference approved on September 10, 2026 is the current **Settings > Engines** screen: crisp sans-serif UI typography, readable sizing, disciplined spacing, thin separators, flat graphite/dark surfaces, restrained accent use, compact but legible controls, and coherent hierarchy. Apply the same visual grammar across Home, Projects, Ask, Plan, Work, Review, Tasks, Documents, History, Team, Connections, onboarding, dialogs, and Settings. Appearance/theme remains user-selectable; consistency concerns typography, hierarchy, spacing, controls, and semantics rather than forcing one permanent accent color.

Monospace is reserved for code and genuinely technical values. A serif reading face can remain for intentional document/plan reading, but ordinary app prose must not accidentally look like a separate product. Avoid generic chat bubbles, ambient glow, glass, decorative cards, and visual noise. Preserve readability at common Windows scaling and split-screen sizes.

## Website communication

The public website must explain the outcome before the architecture. Several nontechnical viewers could not understand the current site even with explanation, so primary copy should use ordinary language and recognizable examples.

The first screen should answer: What is Diomedes? What can it help me do? What does the result look like? What do I click next? Do not lead with terms such as harness, adapter, runtime, orchestration, ledger, worker lanes, or rule classes.

Show the real current application where possible, with a reproducible sample task and honest capture provenance. Do not use a constructed marketing UI as though it were the downloadable app. A good first demonstration is a recognizable request becoming a reviewed result, such as notes becoming a clear checklist or a project task becoming an inspected set of proposed changes. Technical architecture belongs on secondary pages.

## Permissions — authorize useful work, not every click

Human control remains a product principle, but control does not mean interrupting the user for every file edit. Diomedes should support scoped authority that can cover a whole task or project when the user explicitly chooses it.

Recommended user-facing permission presets:

- **Review changes** — prepare related changes and ask before applying the relevant change set.
- **Work in this project** — recommended default for capable users. Allow supported reads, writes, and approved checks inside the project scope; ask only when the operation requires additional authority.
- **Approve for me** — eligible requests are evaluated by a separate bounded reviewer under existing rules. Deterministically already-allowed actions should not require a model call. The acting model must not simply approve its own escalation.
- **Full access…** — deliberate broad execution authority for the selected environment/scope, with a clear warning, persistent indicator, and revocation. Distinguish full access inside an isolated environment from full access to the user's actual OS account/machine.

Keep two dimensions separate internally: what the run is authorized to access/do, and who evaluates a request that exceeds current authority. "Auto" must not erase this distinction.

Task/project grants should be explicit capability/resource scopes, not vague authorization inferred solely from the English task title. A user can approve a practical scope once, then routine actions proceed. Crossing to another folder, publishing externally, installing software, changing credentials, changing billing routes, or performing another consequential class may require new authority.

Keep evidence even when clicks are reduced. Durable records should distinguish: the user approved this exact action; this action matched a prior grant; an authorized reviewer approved the escalation; or an organization policy allowed/denied it. Never record an automatic decision as though the person inspected exact resulting contents.

Do not allow learned preferences, repeated approvals, or model-generated rules to silently expand authority, tenant scope, billing class, credential access, or external-effect permissions.

## Actor and model attribution

Do not say "Diomedes wants to change this item" when the request actually came from a direct external engine/model. Attribution is part of correctness, not decoration.

For direct-agent work, show the actual runtime-reported model prominently when known, with the engine secondary where useful. Intended pattern: `GPT via Codex proposes updating six files`, `Claude via Claude Code needs permission to run a command`, `Muse via OpenCode finished the draft`. These are display-pattern examples, not hard-coded model assumptions.

Use **Diomedes** as the reasoning actor when the native Diomedes Agent actually owns the supervisory operation. Infrastructure actions can also truthfully be described as Diomedes application actions, e.g. Diomedes restored a saved version or detected an installed engine.

Preserve attribution per turn, proposal, approval request, history event, worker, and result. Changing a model picker later must never retroactively rename old work. If runtime metadata did not verify the model identity, show the known engine or an honest unknown; never trust self-identification inside generated prose as metadata.

## Harness / workbench refinements to preserve

These are desired direction, not claims that all are implemented:

1. Compact run control near the composer: who is doing the work, which engine/provider route, permission scope, and effort level. Example: `GPT via Codex · Work in this project · Balanced`. Deeper details may expose tools, sources, active rules, budgets, and adapter guarantees.
2. Clear **Steer / Queue / Stop** semantics. If an engine cannot truly steer an active run, do not pretend that queuing a new instruction changed it live.
3. One **Needs you** inbox for approvals, blocked work, unresolved questions, uncertain external outcomes, and genuinely actionable interruptions. Avoid duplicate alerts and routine-noise mixing.
4. Review feedback as a coherent next unit of work: keep accepted changes, mark corrections, send one bounded correction task, preserve history.
5. Artifact/result pane beside the thread where useful so users inspect the actual document, diff, report, table, image, or output rather than only a message describing it.
6. Context visibility: show what documents, prior threads, rules, skills, and sources are included. Support deliberate fresh-thread handoffs carrying goals, decisions, artifacts, unresolved questions, and evidence while permissions/pending operations remain in durable Runtime state.
7. Budget-aware routing/delegation: explicit allowed model/provider lanes, worker/retry limits, no silent separately billed fallback, and no automatic use of scarce premium models merely for routine review.
8. Team clarity: each worker gets a recognizable assignment, conversation, state, engine/model attribution, and result. Team / Board / Thread remain views of the same durable work object rather than separate project-management systems.
9. Advisor/reviewer roles at meaningful checkpoints, not automatically on every turn. Use deterministic policy first and model judgment only where it adds value.
10. Rules should intervene usefully: stop repeated bad retries, narrow tools/context, inject targeted corrections where supported, and record the intervention. Bound retry loops.
11. **Quick / Balanced / Thorough** user-facing effort choices may map to engine-specific reasoning controls, but effort never changes permissions.
12. Scheduling/background execution should state where it runs, what happens if the host is asleep/offline, budget and permission scope, retry/missed-run behavior, and evidence of completion.
13. **Auto To Do** remains ordinary-user language for task organization. Do not require ordinary users to learn formal Kanban or workflow-builder concepts.

## Engine setup / onboarding

Initial setup should discover supported existing engines and local inference services after clear disclosure, without sending a model prompt, reading credential stores, or starting long-running inference merely to discover them.

Separate these states: installed, protocol/version compatible, account/sign-in available, model available, enabled, capability-supported, and ready for the selected task. `Found` does not mean `ready`.

If an engine is missing, offer to install only the one the user chooses, using verified official distribution and explaining source/publisher, destination, dependencies, privilege needs, and account/usage requirements. Do not silently install every supported harness.

Reuse existing authorized installations. Do not scrape/copy credentials or silently switch from subscription use to API billing. Setup should guide discovery → install if selected → supported sign-in → capability verification → default route selection.

## Local-model onboarding — first-class product direction

Local models should be as easy to configure as cloud/subscription routes, not an expert-only text field.

Desired setup flow:

1. Detect local hardware and operating environment with consent: CPU/architecture, installed RAM, GPU(s), usable VRAM or unified memory, relevant acceleration support, free disk space, and existing local inference runtimes/endpoints.
2. Detect already installed/running local servers and models before downloading duplicates.
3. Ask what matters: fastest response, balanced, highest local quality, privacy/offline use, long context, coding/tool use, low RAM/VRAM impact, or ability to keep gaming/other applications responsive.
4. Recommend a small shortlist, not one unexplained "best model." Show why each fits the hardware and expected tradeoffs.
5. Offer managed installation/download from trusted sources with model identity, license, approximate disk/RAM/VRAM requirements, quantization, context target, and checksum/provenance where practical.
6. Configure memory fitting, GPU/CPU offload, KV-cache type/size, context length, concurrency, flash attention or equivalent supported acceleration, and safe defaults appropriate to the runtime/hardware.
7. Run a short local benchmark/health check after setup and record actual prompt-processing speed, generation speed, memory/VRAM usage, context configuration, startup time, and whether tool-calling/structured-output behavior is adequate for the selected role.
8. Let users save profiles such as **Quick / Balanced / High Quality / Low Impact** instead of requiring raw flags.
9. Own model lifecycle cleanly: load/unload, keep-warm policy, idle eviction, concurrency, RAM/VRAM budgets, crash cleanup, and coexistence with other applications. Avoid keeping every installed model resident.
10. Make local-server adapters model-agnostic. Initial support can include llama.cpp, Ollama, LM Studio, vLLM/SGLang, or OpenAI-compatible endpoints, but Diomedes should not permanently depend on one local runtime.

Hermes is a useful current reference for desktop local-model management, model downloads, memory fitting/context sizing, and endpoint/model detection. Hardware-aware automatic recommendation is a Diomedes requirement regardless of any one Hermes release's exact implementation.

## Business local-AI onboarding

During consulting or Business onboarding, local inference should be a first-class deployment option where privacy, ongoing inference cost, latency, offline operation, or predictable capacity makes it useful. Do not force every business to local AI; hybrid/cloud routes remain valid.

A business consultation should classify deployment by hardware capability and workload rather than model marketing names alone: current hardware; sensible upgrade; dedicated local workstation/server; or later managed remote compute. Recommendation should consider concurrent users, context size, workflow frequency, uptime, latency, privacy, and support burden.

The owner should be able to choose a recommended local Diomedes configuration without becoming a model-serving expert. Advanced users can inspect/edit lower-level runtime settings.

## Long-term Diomedes local supervisor model

Long term, Diomedes Agent may be backed by a smaller efficient model tuned specifically for supervisory/orchestration behavior and capable of running on decent through high-end local hardware. Exact parameter count, base model, quantization, and hardware floor remain evidence-driven; do not lock the architecture to Muse, Qwen, or another current candidate.

The model's specialty should be operational intelligence rather than replacing frontier specialists at every task: intent understanding, decomposition, route/worker selection, context selection, tool/capability use, approval recognition, budget/quality tradeoffs, monitoring, retry/correction decisions, workflow progress, verification, and synthesis. Difficult specialist work can be delegated to stronger cloud or local models.

For businesses, a future local Diomedes supervisor can become the normal primary Diomedes Agent for that deployment while still delegating selected work to other models/engines. This can reduce marginal inference cost at scale, improve privacy and predictable latency, and make a configured Diomedes system more economical. It does not eliminate Runtime/Trust boundaries; the local model never becomes the authority simply because it is called Diomedes.

## Recursive self-improvement — measured, versioned, reversible

The long-term goal includes recursive improvement, but it must be evidence-driven rather than an unconstrained model rewriting itself in production.

Preferred progression:

**A. Behavioral improvement before weight training.** Observed problem/human correction → candidate change to rule, prompt, skill, routing, workflow, or deterministic procedure → replay/evaluation on stored cases → compare quality/cost/latency/failure/corrections → approve where appropriate → versioned adoption → monitor → rollback if worse.

**B. Build privacy-appropriate training/evaluation data.** Use observable state/action/outcome traces, explicit corrections, tool results, verification outcomes, and successful procedures. Do not collect hidden chain-of-thought as training data. Do not train on client or personal data without explicit lawful permission and retention/provenance policy.

**C. Parameter-efficient adaptation/fine-tuning only after enough evidence exists.** Adapters/LoRA or another controlled method may target orchestration/tool-use/domain behavior. Training occurs in an isolated staged pipeline with reproducible datasets/evals and model/version provenance.

**D. Full/deeper training or distillation only when economics, data quality, licensing, and measured gains justify it.**

The recursive loop may propose better prompts, skills, workflows, rules, routing policies, evals, and future training examples. It may not silently expand credentials, external-data access, tenant scope, permissions, billing class, resource budgets, or deployment authority. It may not replace deployed weights merely because the current model generated a new checkpoint. Candidate model versions should pass offline evals, shadow/canary testing where appropriate, explicit promotion criteria, and retain rollback.

For business-specific adaptation, prefer a common Diomedes supervisor base plus customer/workspace-specific knowledge, retrieval, rules, skills, and potentially small adapters rather than opaque fully retrained models per customer by default. Customer data isolation and deletion/offboarding must remain possible.

A future training/eval system should track dataset/version provenance, base model/license, training recipe, adapter/checkpoint identity, eval suite, regression results, hardware target, quantization compatibility, deployment cohort, and rollback target.

## Self-improvement and memory definitions

Keep these concepts separate:

- **Memory/preferences:** facts and choices to help future reasoning.
- **Workspace/business knowledge:** source material and operational context.
- **Skills/capabilities:** reusable procedures/tools.
- **Rules/policies:** behavior constraints and authority boundaries.
- **Runtime state:** what work is actually pending/running/done.
- **Observatory evidence/evals:** what happened and whether approaches worked.
- **Model training data/checkpoints:** explicitly governed material used to adapt weights.

Never collapse all of these into one giant memory file. Remembered preference is not permission. Successful behavior is not proof that a new model version is safe. A summary is not the source of truth for a pending approval.

## Business / consulting direction

Company direction: **Diomedes Systems**. Product: **Diomedes**. Consulting remains an early revenue and product-discovery layer, especially while capital is limited.

Core principle: **Find the weak point. Fix the workflow.**

Lead with measurable outcomes: hours returned, repetitive steps removed, fewer errors, faster turnaround, cross-location consistency, easier knowledge access, and visible human control. Do not lead ordinary business conversations with model names, tokens, MCP, context windows, or benchmark scores.

The preferred first design-partner shape remains a locally owned three-restaurant group. First pilots should use high-frequency, measurable, reviewable, low-to-moderate-risk work and preferably exports/lower-risk data before broad production credentials. No autonomous payroll, payments, hiring/firing/discipline, unapproved public posting, or vendor ordering in the first pilot.

Consulting can include workflow audit, fixed-scope pilot, implementation, Diomedes configuration, selected agent/local-model setup, MCP/OAuth integrations, capabilities/skills, rules/approvals, training, managed support, and optional hardware/local-AI deployment advice.

## Product / implementation priority

Preserve the universal north star while proving narrow connected slices. Near-term priorities should not become ten parallel subsystem rewrites.

Current preferred sequence:

1. Unify the Console around the approved Settings-derived visual language and retire Workbook functionality into it deliberately.
2. Implement shared permission scopes and accurate actor/model attribution before each engine invents incompatible semantics.
3. Complete selected real engine adapters and first-run setup using the shared permission/attribution contract.
4. Add an easy local-model setup vertical slice: hardware discovery, existing-runtime detection, recommendation, managed install/configuration, benchmark, and lifecycle management for one or two well-supported backends before broadening.
5. Prove one genuine Diomedes-led workflow end to end: real model route, typed tools, useful rule/correction, scoped authority or exact approval, interruption/recovery, verification, evidence/history.
6. Prove the same durable semantics with a second model/engine route.
7. Expand workbench controls: Needs you, steer/queue/stop, review/correction, artifact pane, context visibility, and budget-aware delegation.
8. Simplify the website around plain-language outcomes and captures of the actual packaged product, without advertising unshipped development work.
9. Build Observatory/eval evidence sufficient to justify more advanced self-improvement and only later local supervisor fine-tuning/training.

## Guardrails

- Do not build a generic new agent loop solely for ownership; Diomedes-owned semantics must have measurable value.
- Do not stack whole competing orchestrators inside one another so state/policy/routing ownership becomes ambiguous.
- Do not equate model obedience with policy enforcement.
- Do not claim worktree isolation is an OS sandbox.
- Do not silently switch billing routes or providers after quota/error conditions.
- Do not use a premium model automatically as reviewer/fallback without an explicit budget policy.
- Do not make interface-detail/expertise settings change authority.
- Do not make Full access a cosmetic label; it must state what environment actually receives broad authority.
- Do not let automatic learning or fine-tuning change permissions, credentials, billing, tenant scope, or external-effect policy.
- Do not present roadmap intent, simulated tests, or development branches as shipped product capability.

## Reference systems to keep studying

- Hermes: personal-agent continuity, memory, skills, schedules, messaging, multiple backends, local-model UX.
- Codex: scoped sandbox/permission modes, auto-review, durable coding-agent flows.
- Claude Code/Desktop: permission modes, plan-to-execution flow, scheduling, desktop agent UX.
- OpenCode: allow/ask/deny permission semantics and model/provider routing.
- OMP / oh-my-pi: layered rules, hooks/intervention, advisor/worker patterns, checked editing.
- witt3rd/oh-my-hermes: planning discipline and verified execution/iterate composition.
- rlaope/oh-my-hermes: natural-language intent → explicit capability/workflow/evidence gates.
- Vibe Kanban: review comments and correction workflows.
- AionUI: agent discovery, organized conversations/teams, artifact preview.
- Omnigent: heterogeneous-agent execution with explicit policy/budget/host distinctions.
- Amp: specialist workers, context separation, effort modes, steer/queue/interruption semantics.

This file records direction. Verify current implementation before claiming any item is shipped.
