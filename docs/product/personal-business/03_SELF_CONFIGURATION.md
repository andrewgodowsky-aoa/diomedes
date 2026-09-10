# Governed self-configuration

PB-2026-09-10.1 | Design, not a claim of shipped automation.

## Recommended approach

Business should prepare a usable job, not merely generate a company-branded system prompt. Use a hybrid: deterministic templates and validation establish structure; a model maps the owner's words into a proposed configuration. A deterministic wizard remains the offline/no-credit fallback. Reject unrestricted model-generated executable setup and do not build a second workflow engine.

The flow is answers plus consented discovery and the supported catalogue → typed facts → configuration proposal → validation → owner review → rehearsal → versioned activation → health evidence.

## Proposal contract

Reference organization, questionnaire revision, previous configuration digest, template versions, Agent definitions/revisions, Team and handoffs, rules, required connections, context scopes, model policy, budget, approvers, expected outputs and unresolved issues. Explain what is new, inherited, changed or unsupported. Store field provenance and concise explanations, not hidden chain-of-thought.

Treat model output as an untrusted candidate. Permit only registered tool/capability identifiers and known configuration actions. Reject arbitrary scripts, URLs, installers, secret values and model-authored grants. Validate schema, references, tenant ownership, source scope, route capability, loops and budgets. Missing required capabilities block readiness; optional gaps can produce an explained degraded plan. A catalogue entry is not a working connection.

Reuse the existing Agent registry, Trust, Runtime and Store. A configurator can coordinate them; it must not replace them.

## Activation and recovery

Stage inactive versioned definitions, then activate one manifest by compare-and-set against the expected active revision. Recheck membership, entitlement requirements, data routes and capability readiness. Failed preparation leaves the previous active setup intact. Replaying activation returns its durable result rather than duplicating Agents or schedules.

OAuth, invitations, installations and external writes are separately authorized resumable operations. A local configuration rollback does not undo them. Rollback also cannot revive revoked grants, departed members, old credentials or spent credit. In-flight work remains attributed to its original configuration; current revocations still apply. New configurations govern new work unless an explicit safe re-admission occurs.

## First reusable pack

Implement one approved-files weekly-brief workflow: read selected approved exports, identify relevant changes, produce a source-referenced draft, save through the existing writer, then request human review. No automatic sending or publishing.

Use two entirely synthetic variants: restaurant operations and professional-services project status. Their labels and input mappings differ; authority, evidence, model and recovery semantics do not. No real workplace names or customer financial data belong in public fixtures. Restaurant outputs do not change payroll or orders; professional-services outputs do not provide licensed or safety-critical sign-off.

A small Analyst → Reviewer Team is appropriate only where real Team execution exists. Otherwise configure it as not yet runnable rather than simulate collaboration. Selecting Toast produces a supported connection request or an approved-export fallback, not fictional API access.

## Agents, Teams and updates

Use the first-class Diomedes Agent abstraction from Opus: Agent is distinct from Mode, model, runtime and Team. Organization specialists reference maintained base definitions and versioned overrides, not uncontrolled prompt copies. Each member retains its own tools, context and verification requirements.

Children, advisors, reviewers and correction attempts share parent budgets; delegation cannot mint authority or credit. A separate persona name is not proof of independent review. Respect the current reviewer contract.

Detect specific configuration drift: source schema changes, expired tokens, departed approvers, retired rules or unavailable routes. Choose a permitted existing fallback, Needs you, or a new reviewed proposal. Never replace local-only processing with silent cloud use. Pack updates show a diff, preserve organization overrides and cannot silently overwrite customer policy.

## Road to autonomy

Level 0: guided deterministic preview. Level 1: model-assisted candidate, validation and activation. Level 2: supported authorization, rehearsal and observed first job. Level 3: propose changes based on measured failure or changed business facts. Level 4: narrowly preauthorized low-risk changes with evaluation, versioning and rollback. New authority and spending retain independent gates.

Initial work targets Levels 0–1 and an export-based Level 2 rehearsal, not universal connector generation, remote hosting or weight training. Improvement uses governed evidence; private business data is not training material by default.

## Initial proof

Synthetic answers → inactive proposal → validation → reviewed activation → first source-referenced draft → restart with identical active configuration and no duplicated setup. Exercise missing connector, stale proposal, revoked owner and partial setup failure. This is synthetic implementation proof, not broad real-model reliability evidence.
