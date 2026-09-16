# Diomedes — Inspectable Service Scope / Progressive Disclosure Requirement

**Status:** Owner-approved design and commercial requirement  
**Date:** 2026-09-15  
**Applies to:** Diomedes Systems public website, business/service positioning, proposals, and future service-detail surfaces  
**Primary principle:** Keep the first layer simple. Make the real scope inspectable underneath.

## Decision

Every major paid Diomedes service should expose enough concrete detail that a prospective customer can understand what they are actually paying for.

The public website must remain readable to a nontechnical owner or general manager, but it must not hide substantial implementation work behind vague labels such as “AI setup,” “automation,” “integration,” or “managed support.” A visitor who wants more detail should be able to open an in-page disclosure and inspect the scope without leaving the commercial page.

This is a deliberate credibility and pricing-justification strategy. It is not a request to dump giant feature lists onto every page.

## Progressive-disclosure pattern

Use this hierarchy where it fits:

1. **What you get** — plain-English summary and outcome.
2. **Everything included** — expandable grouped scope with concrete deliverables/checks.
3. **How we do it** — process, evidence, testing, handoff, and operating philosophy without exposing proprietary implementation details.
4. **What we do not do** — explicit exclusions/boundaries where they improve trust.

A simple visitor may stop after the first layer. A technically curious buyer, operator, IT contact, or enthusiast should be able to keep opening detail until the engagement feels tangible rather than abstract.

The detailed layer should use the approved Field design language: restrained native-style disclosures, hairlines, readable typography, no feature-card wall, no hype animation, no giant icon grid, and no accordion nesting for its own sake.

## Supersession of the prior audience split

The existing website direction said the owner/general-manager audience and the technical evaluator should not share a page, with technical depth pushed only to Docs/Roadmap.

This requirement **supersedes that rule for paid-service and scope pages only**.

The new rule is:

> Paid-service pages are owner-first, but optionally deep.

The first visible layer remains plain English. Detailed implementation scope may appear inside expandable disclosures on the same page. Highly implementation-specific product documentation can still live in Docs/Roadmap.

Do not force a business owner to read runtime or model terminology. Do not force an informed buyer to accept vague marketing copy when evaluating a five-figure engagement.

## Why this exists

For substantial professional-service engagements, specificity helps a buyer evaluate whether the price corresponds to real work.

Compare:

- “Private AI setup”

with:

- workload assessment;
- hardware sizing;
- runtime setup;
- model lifecycle;
- benchmarking;
- integrations;
- permissions;
- monitoring;
- failure recovery;
- documentation;
- training;
- handoff;
- optional ongoing support.

The goal is not to pad the list. The goal is to make real engineering, implementation, risk control, and support visible.

## Required service areas

The pattern should be applied to multiple major service areas, not only Private AI.

### Workflow / AI Opportunity Audit

Public first layer: identify the weak point, measure the current process, rank practical opportunities, and recommend what is worth changing.

“Everything we evaluate” may include, where in scope:

- current workflow and handoffs;
- frequency and recurring labor/time;
- delays and rework;
- duplicated work and manual copy/paste;
- existing software and systems;
- files, exports, APIs, and data readiness;
- deterministic automation opportunities;
- AI-assisted opportunities;
- human-review requirements;
- error/risk cost;
- privacy/security considerations;
- integration difficulty;
- expected implementation effort;
- reuse across teams/locations;
- measurable success criteria;
- likely operating cost;
- keep/revise/kill recommendation;
- prioritized implementation sequence / 30-60-90 day plan where appropriate.

The audit is not a generic slide deck. The detailed scope should make that visible.

### Implementation

Public first layer: configure and install the agreed Diomedes workflow in the customer’s actual environment, test it, train the team, and hand it over.

Detailed scope may include, where contracted:

- workflow configuration;
- workspace setup;
- supported connector/integration setup;
- custom connector engineering;
- capability-pack configuration;
- organization context and knowledge setup;
- model/provider routing;
- local/cloud/hybrid configuration;
- roles and permissions;
- approval policies;
- evidence/audit configuration;
- scheduled jobs and triggers;
- failure handling;
- workflow rehearsal/shadow mode;
- acceptance testing;
- staff/admin onboarding;
- documentation;
- measurement baseline and post-implementation review;
- handoff and rollback/recovery information.

Only claim items actually supported or included in the quoted scope.

### Custom Capability Packs

Public first layer: adapt Diomedes to the customer’s business, systems, and recurring jobs without making the customer assemble the AI stack themselves.

Detailed scope may include:

- supported software connectors;
- custom MCP/API/adapter work where scoped;
- workflow-specific tools and skills;
- organization knowledge;
- business rules;
- approval requirements;
- location/team-specific context;
- model/runtime preferences;
- scheduled jobs;
- reporting;
- templates;
- evidence/verification requirements;
- operator-facing capabilities rather than raw skill filenames.

### Managed Diomedes

Public first layer: ongoing human/operational responsibility for keeping an agreed deployment healthy within a written scope.

Detailed scope may include, where contracted:

- workflow health monitoring;
- model/provider changes;
- runtime updates;
- connector maintenance;
- configuration-drift checks;
- smoke tests;
- failure investigation;
- bounded repair/reconfiguration;
- performance tuning;
- cost/usage review;
- security/runtime maintenance;
- backup/recovery checks;
- support;
- periodic optimization review;
- documented escalation/change-order boundaries.

Never imply an unstaffed 24/7 SLA or unlimited rebuild obligation.

### Trust & Security

Public first layer: Diomedes is designed around bounded authority, human control, evidence, and least privilege.

Detailed scope may expose concepts such as:

- least-privilege credentials;
- local-versus-cloud data boundaries;
- permissions;
- approvals;
- audit history;
- evidence;
- retention;
- tenant/client isolation;
- revocation;
- offboarding;
- backups;
- restore strategy;
- reversible actions where practical;
- explicit restrictions around consequential automation;
- credential handling boundaries;
- remote-management boundaries.

Do not turn this into unsupported compliance marketing.

## Private AI / Local Infrastructure — required deep scope

Private AI is an especially important example because the customer must be able to see that Diomedes is selling a complete private-AI infrastructure engagement, not charging a large fee to install one model.

Public first layer should stay simple, for example:

> We design, install, test, connect, and support AI infrastructure your business owns.

A “See everything included” disclosure should group, not flatten, the deeper scope.

### Hardware & capacity

- hardware discovery;
- CPU/GPU/RAM/VRAM/unified-memory detection;
- workload sizing;
- hardware compatibility;
- resource utilization;
- temperature/resource telemetry where accessible;
- concurrency planning;
- capacity/growth considerations.

### Models

- model installation;
- model storage;
- model/version metadata;
- model compatibility checks;
- model profiles;
- quantization awareness;
- context-window configuration;
- model lifecycle management;
- multiple-model/specialist strategy where useful.

This must remain model-agnostic. Do not define the offering around Qwen or any current model family. Dense models, MoE models, multimodal models, embeddings/rerankers, vision/speech components, and future models must fit under the same abstraction.

### Inference infrastructure

- inference runtime discovery;
- runtime installation/setup;
- inference endpoint discovery;
- runtime launch/shutdown/restart;
- service auto-start;
- scheduled operating windows;
- wake/reconnect behavior where supported;
- safe service restart;
- local runtime adapters;
- backend compatibility.

Do not define the product around one runtime.

### Performance & routing

- benchmarking;
- workload-specific evaluation;
- concurrency management;
- workload/model routing;
- local/cloud fallback;
- hybrid routing policy;
- cost/capacity measurement where available.

### Reliability & operations

- health monitoring;
- failure detection;
- logs;
- backup/recovery information;
- remote health visibility;
- safe recovery/restart procedures;
- scheduled/always-on operating policy;
- maintenance-window planning where relevant.

### Control & trust

- permissions;
- approvals;
- audit history;
- local/cloud data boundaries;
- remote-management limits;
- evidence of what ran and what data/systems it touched where supported.

## Presentation rules

1. **Group related work.** Do not show thirty-five equally weighted bullets in one undifferentiated block.
2. **Use plain-English category headings.** Technical terms are allowed underneath when they convey real scope.
3. **No feature padding.** Only include real deliverables, checks, or responsibilities.
4. **No unsupported availability claims.** Planned product capabilities must remain distinguishable from services Diomedes can presently perform manually or through supported tooling.
5. **No model-name marketing dependency.** Model examples belong in technical docs/verified benchmark material, not durable service identity.
6. **No fake enterprise assurances.** Do not imply HA, compliance certification, 24/7 staffing, guaranteed vendor compatibility, or unlimited support unless actually contracted and operational.
7. **Preserve the simple first read.** The page should still make sense without opening a disclosure.
8. **Keep disclosures accessible.** Keyboard operable, semantic, readable on mobile, reduced-motion compliant.
9. **Use the same interaction pattern across services.** A visitor should quickly learn how to inspect scope.
10. **Make exclusions visible where trust benefits.** “What we do not automate,” “When you do not need local AI,” and explicit service boundaries are positive credibility assets.

## Recommended reusable website component

Build one reusable scope-disclosure primitive rather than hand-rolling different accordion systems on each page.

Conceptual content model:

- service title;
- short outcome summary;
- grouped scope sections;
- optional status/availability annotation;
- optional exclusions;
- optional link to technical Docs/Roadmap;
- optional CTA.

It should visually belong to the Field system and use the same disclosure behavior already established on the pricing FAQ.

## Website information architecture

The public site should support a simple surface with progressively deeper layers.

Suggested pattern:

**Overview → Everything included → How we do it → Boundaries / what we do not do → Docs/Roadmap for implementation-level depth**

This can appear on:

- pricing/services;
- Private AI;
- Workflow Audit;
- Implementation;
- Managed Diomedes;
- capability-pack/business setup pages;
- Trust/Security where relevant.

Not every page needs all four layers.

## Commercial principle

The site should help a prospect justify the cost to themselves through scope clarity, not through pressure tactics or inflated ROI claims.

A five-figure engagement should not look like a mysterious “AI setup” fee. The buyer should be able to inspect the work and understand where engineering, configuration, validation, security, training, handoff, and responsibility enter the price.

## Acceptance criteria for the website implementation

- At least the major paid services expose an in-page “everything included” or equivalent detail surface.
- Private AI exposes the grouped local-infrastructure scope above.
- Audit exposes “everything we evaluate” rather than only a one-line summary.
- Implementation and Managed Diomedes expose meaningful concrete scope.
- The first visible layer remains nontechnical and concise.
- The detail layer is not a card wall or giant ungrouped feature dump.
- Mobile and keyboard behavior are verified.
- Existing Field/Living Thread rules are preserved.
- Build-time marketing-claim/status rules continue to pass.
- No current/planned capability is accidentally promoted to Available by copy alone.
- The site continues to distinguish software, professional implementation, and managed service.
- Technical readers can go deeper without forcing nontechnical readers through the same detail.

## Publishing requirement

This is not intended to remain an internal planning note. After the website implementation is complete and verified, the new scope-detail pattern and appropriate customer-facing service detail should be published to diomedes.net.

Publication must follow the existing website verification/deployment process, including build/copy checks, responsive/browser checks, commit/push, Cloudflare deployment, and live verification. Do not claim publication until the live site is inspected.

## Owner intent in one sentence

**Diomedes should be easy to understand in thirty seconds and deep enough to inspect for thirty minutes.**
