# The Individual plan, phase 2a: access (2026-09-28)

Feature: individual-tier. Branch `feature/individual-tier`, worktree
`F:/Diomedes/diomedes-wt/individual-tier`, owner Andrew Godowsky. Base: origin/main 66334d5.
Original contract: `CONTRACT-individual-tier.md` (orchestrator scratchpad). The phase-2a source was
merged in PR #176 at main `1af37e0`. The Operations routing composition described below is local
and unverified until its own recorded gates pass; this note makes no deployment claim.

**2026-09-29 checkpoint:** PRs #177 (`d017647`) and #178 (`5f97d97e`) subsequently merged the
integration work. The remaining automatic funding path is now a verified candidate on
`codex/dio-128-individual-funding`, based on #178 in `andrewgodowsky-aoa/diomedes`.
See [the phase-2b funding record](2026-09-29-individual-funding.md) for its exact behavior, fresh
verification and remaining acceptance gaps. Andrew approved publishing the reviewed candidate as
a draft PR on 2026-09-29; merging and deployment remain unauthorized. The phase-2a descriptions and counts below are
historical; they do not establish publication or deployment of the funding candidate.

## Andrew's decisions (2026-09-28, owner-decision record)

- The Individual plan is **$200 a month**, a person's own subscription. This supersedes the $250
  figure of 2026-09-27. The app carries no dollar figure for it anywhere; the public site's pricing
  registry is the pricing authority.
- **1,000 credits a month** (Andrew, 2026-09-28 04:01 EDT; it was 500 on 2026-09-27), not wired in this
  phase. The plan and a business are kept apart: a member of a business never uses their own Individual
  plan for that business's work, even one they pay for themselves. The coverage rule enforces it, and
  INDIVIDUAL_SEPARATION_SENTENCE says it wherever the plan is offered or issued.
- The latest decision is **Personal only**, issued to a person. Every Business workspace needs
  its own Business plan, including a sole proprietorship or a one-member Business. This supersedes
  the phase-2a member-threshold exception.

## The coverage rule

An active Individual grant covers the person's Personal work and projects not linked to a
Business. Business admission reads only that Business's own grants. The existing
`INDIVIDUAL_MAX_ACTIVE_MEMBERS` configuration remains parseable for compatibility but cannot
enable Business coverage at any value.

What the Individual grant carries in this phase: `nectovia-agent`, `maintained-profiles`,
`owner-rules`, `phone-relay`. Included AI usage (`managed-inference`) is not part of the person
grant. Managed Personal work additionally needs the separate, explicit funded usage agreement
introduced by routing 010. Neither authority can replace the other. The legacy Personal admission
path retains its managed-route refusal; compatible clients use scoped admission with an explicit
Individual billing account and a null Business organization id.

## What was built

- `shared/individual-plan.ts`: the plan, `planCatalog()` (business templates with scope
  `organization`, then Individual with scope `person`), `readIndividualCoverage`, `individualCovers`,
  `PersonAccessView` and the sentences. `shared/access.ts` is untouched.
- Control plane: migration `009_individual_plans.sql` (`person_feature_grants`, `person_access`,
  `personal_agent_admissions`; `agent_admissions` is unchanged). A person has no tenant of their
  own, so their rows use the person id as the tenant id (a CHECK holds them equal). `cp_runtime`
  gets read and write on the grants and revision tables and read and append on personal admissions.
  `CommercialService` gains `personAccess`, `admitPersonalAgent`, `person`, `issuePersonGrant` and
  `revokePersonGrant`; `access` and `admitAgent` now read only Business grants. Historical
  `coveredBy` and `coverage` fields remain readable but grant no new authority. `issueGrant` refuses a person plan; `me()` returns the catalog
  with scopes; `people()` adds each membership's business name and the person's Individual state.
  `decideAgentAdmission` takes an optional `individual` snapshot for Personal work; a business's
  snapshot still never admits Personal work.
- Routes: `GET /account/access`, `POST /account/agent-admissions`, `GET /ops/people/:id`,
  `POST /ops/people/:id/grants`, `POST /ops/people/:id/grants/:id/revoke`.
- Desktop host: the session reads the person's own access beside the businesses'; `agentPlan()` is
  paid under an Individual plan, and an unread person access makes it unknown unless a business
  already answers paid. A service from before this change (its own "action not found") reads as
  none, so the free-version notice still shows there. The gate admits Personal and unlinked work
  under an Individual plan through `POST /account/agent-admissions`, and refuses the company route
  with `MANAGED_USAGE_NOT_INCLUDED_PERSONAL`.
- Routing 010 retains the applied 009 bytes. It creates a distinct billing identity under
  `tenant_id = person_id` for existing grant holders; new grant issuance provisions the same
  identity before setup. It grants no access or credits. New Personal admissions record that
  billing identity alongside their existing person/tenant identity, without rewriting old records.
  Scoped admission and every managed dispatch read current person access plus the current usage
  agreement. Operations shows Personal access and managed usage separately.

## What phase 2b must add

- Automatic recurring Individual credit allocation remains separate from routing's explicit
  usage-agreement path. The local phase-2b candidate implements it; publication, deployment and
  live-product acceptance remain open. Do not infer deployed credits from the approved amount.
- Fold `INDIVIDUAL_PLAN` into `PLAN_TEMPLATES` once `shared/access.ts` is free, and retire
  `planCatalog()`'s concatenation.
- A faux seed subscriber (`services/control-plane/src/faux/seed.ts` was not edited here).
- The Operations person page arrived in PR #6 and is retained in the routing composition.
  Canonical product-document reconciliation is owned by the coordinator.

## Proposed patch for docs/DIOMEDES_CORE_PILLARS.md (not applied)

Add to the amendment list:

> - **2026-09-28.1 (minor, Andrew's explicit decision):** the Individual plan is $200 a month, a
>   person's own subscription for Personal work only. Every Business workspace needs its own
>   Business plan, including a sole proprietorship. Cloud synchronisation is separately coordinated.

## Historical phase-2a gates (not routing-composition acceptance)

- `npx tsc --noEmit` (root): no errors.
- `npm run typecheck` (services/control-plane): no errors.
- `npx vitest run` (services/control-plane): 43 files passed, 3 skipped; 632 tests passed, 34 skipped.
- Root `npx vitest run` over the account, gate and access suites and every root test importing a
  changed file, in three runs: 17 files and 283 tests, 24 files and 257 tests, 1 file and 9 tests;
  all passed, none failed or skipped.
- The owner's export (OPS-05) passes the access view through, so its strict schema and
  `shared/organization-export.ts` now accept the optional `coveredBy` and grant `scope` fields. The full root suite, Playwright, vite build and packaging were
  not run here (the heavy slot belonged to another lane); the orchestrator runs them.

## Later change to the term (2026-10-01)

The 31-day `termDays` recorded here is superseded for the complete Individual plan: each term now
runs to the subscription's next monthly anniversary in UTC (`2026-10-01-individual-reset-boundary.md`).
Grants issued under the 31-day template keep their dates; limited overrides keep explicit dates.

