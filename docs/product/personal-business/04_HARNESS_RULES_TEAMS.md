# Harness adaptation: Agents, Teams, rules and Business scope

PB-2026-09-10.1 | Integration contract for the post-Opus application.

## One execution system

Keep existing Desktop/Core/Runtime/Trust/Observatory/Interop responsibilities. They are boundaries, not instructions for six services. Reuse Store mutations and current Need/approval/grant semantics.

The product model is Mode → Agent → Model → Effort; Teams compose Agents. Organization, workspace and payer surround it. Resolve each admitted unit from the authenticated principal, current membership, configuration and Agent/Team revisions, available route, policy, allowed context and budget. Preserve historical resolution while rechecking current authority at effect boundaries. An old snapshot cannot revive a revoked grant.

Entitlement permits a purchased service feature; Trust permits an action/data use; budget admission permits spending. All required checks must succeed. A Business badge does not authorize a write, and write approval does not authorize company-funded inference.

## Rule categories and precedence

Guidance shapes model behavior. Correction responds to observed failure with bounded attempts. Enforced policy deterministically blocks impermissible effects. Prompt/regex injection is not authorization. Reuse current policy results and the existing enforced/observed/instructional/unsupported capability vocabulary.

Organization policy belongs to authorized admins. Project/task guidance can specialize but cannot weaken it. Personal tone preferences apply only where allowed. Imported documents, connector output and questionnaire free text remain data; prompt injection must not promote them to administrative instructions.

At policy level, restrictions cannot be overridden by lower-trust guidance. Resolve allowed same-authority guidance overrides deterministically; incompatible unresolved requirements block work. Record the governing rule ID/revision and enforcement surface without secret content.

## Injection lifecycle

Use existing hooks/events rather than a new poller: configuration activation, task admission, context assembly, before model/tool/effect, after observation, verification and handoff where supported.

Context assembly selects only applicable role/task/organization guidance and authorized facts. Use concise bounded instruction views with stable revisions rather than injecting every company rule into every call. Hard checks remain in the host even when their meaning is explained to the model.

Before effects, validate canonical action fields, grants, route and expected base. After observations, pass structured evidence to the planned GLM correction loop. Corrections do not invisibly modify durable Agent definitions or business rules. Persistent failures can produce a reviewed configuration candidate.

User regex must have defined matching surfaces, bounded inputs and safe execution limits. No arbitrary JavaScript, shell hooks or unrestricted transcript scans. Prefer typed predicates for paths, capabilities, budgets and operations. Canonical path policy and the existing writer—not regex—govern filesystem effects.

## Team and model behavior

Teams reference versioned Agent identities. Handoffs carry parent work, scoped artifacts/evidence and unresolved constraints. Each child rechecks its own required authority; a Team member list is not an ACL. No cross-tenant context sharing by default.

Parent budgets cover children, advisors, reviews, summarization and corrections. Local/BYO routes have different payers. Bound recursive delegation and reconcile completed work after replay. Waiting Teams should not pin models unnecessarily; background work must not starve interactive work.

Workspace/model picker changes cannot rewrite old attribution or silently redirect active tasks. A fallback must satisfy capabilities, data-processing policy and budget. A local-only job must not become cloud-backed after a model outage.

## Evidence and interface

Inspect person/organization, Agent/revision, Team/handoff, actual model/runtime, automatic/manual choice, configuration/rules, authority, payer/reservation, effect and verification. Keep proposer, reviewer, writer and verifier distinct. Unknown stays unknown. Do not expose private reasoning, secrets or customer payloads in generic telemetry.

Ordinary UI shows business, job, current state, approval need and understandable allowance. Expand technical details in the existing Console inspector. Board and Team are projections of durable truth. Preserve current Settings > Engines readability, appearance and responsive controls; no Workbook features.

## GLM integration

Opus establishes identity, configuration, Agent/Team/rule and usage seams. GLM owns bounded correction on one supported route. Every attempt carries tenant/configuration/Agent/rule/payer provenance, rechecks revocation and budget, and follows exact approval semantics. Do not add another organization store, scheduler, writer or policy engine. Apply the short Business addendum to the previously prepared GLM prompt.
