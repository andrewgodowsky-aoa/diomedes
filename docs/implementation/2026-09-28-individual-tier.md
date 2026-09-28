# The Individual plan, phase 2a: access (2026-09-28)

Feature: individual-tier. Branch `feature/individual-tier`, worktree
`F:/Diomedes/diomedes-wt/individual-tier`, owner Andrew Godowsky. Base: origin/main 66334d5.
Frozen contract: `CONTRACT-individual-tier.md` (orchestrator scratchpad). Nothing here is committed,
pushed or migrated in production.

## Andrew's decisions (2026-09-28, owner-decision record)

- The Individual plan is **$200 a month**, a person's own subscription. This supersedes the $250
  figure of 2026-09-27. The app carries no dollar figure for it anywhere; the public site's pricing
  registry is the pricing authority.
- **500 credits a month**, unchanged from 2026-09-27, and not wired in this phase.
- The plan is **issued to a person, never to an organization**. The eligibility sentence, shown
  wherever the plan is offered or issued, is exact: "Businesses beyond a sole proprietorship aren't
  eligible for this plan."

## The coverage rule

An active Individual grant covers:

1. the person's Personal work and projects not linked to a business, and
2. a business workspace only while the grant holder is one of at most `INDIVIDUAL_MAX_ACTIVE_MEMBERS`
   active members of it (blank means 1: the sole proprietor).

A business with more active members than the threshold is not covered, whatever its plan. A
business whose own plan includes the Agent reads exactly what it did before: the Individual grant
is read only when the business's own grants do not include the Agent. The threshold is a
control-plane setting, read like the MANAGED_* settings: blank is the default, anything that is not
a whole number of at least 1 refuses the configuration.

What the Individual grant carries in this phase: `nectovia-agent`, `maintained-profiles`,
`owner-rules`, `phone-relay`. Included AI usage (`managed-inference`) is not part of it, because
funding is organization-keyed. The company route refuses covered work with a personal sentence, and
staff are refused if they try to add included usage to a person's grant.

## What was built

- `shared/individual-plan.ts`: the plan, `planCatalog()` (business templates with scope
  `organization`, then Individual with scope `person`), `readIndividualCoverage`, `individualCovers`,
  `PersonAccessView` and the sentences. `shared/access.ts` is untouched.
- Control plane: migration `009_individual_plans.sql` (`person_feature_grants`, `person_access`,
  `personal_agent_admissions`; `agent_admissions` is unchanged). A person has no tenant of their
  own, so their rows use the person id as the tenant id (a CHECK holds them equal). `cp_runtime`
  gets read and write on the grants and revision tables and read and append on personal admissions.
  `CommercialService` gains `personAccess`, `admitPersonalAgent`, `person`, `issuePersonGrant` and
  `revokePersonGrant`; `access` and `admitAgent` fall back to a covering Individual grant (the view
  says `coveredBy: 'individual'`, the admission record `coverage: 'individual'`, and the revision is
  the business's plus the person's); `issueGrant` refuses a person plan; `me()` returns the catalog
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

## What phase 2b must add

- Person funding: a person-keyed funding account and credit periods, then the Individual credits row
  in `MONTHLY_CREDIT_GRANTS` (`shared/managed-usage.ts`) and `managed-inference` in the template.
- Fold `INDIVIDUAL_PLAN` into `PLAN_TEMPLATES` once `shared/access.ts` is free, and retire
  `planCatalog()`'s concatenation.
- A faux seed subscriber (`services/control-plane/src/faux/seed.ts` was not edited here).
- The Operations app's person page (a separate lane) and the pillar amendment below.

## Proposed patch for docs/DIOMEDES_CORE_PILLARS.md (not applied)

Add to the amendment list:

> - **2026-09-28.1 (minor, Andrew's explicit decision):** the Individual plan is $200 a month, a
>   person's own subscription; a sole proprietor may hold it; businesses beyond a sole
>   proprietorship aren't eligible. Cloud synchronisation pending.

## Gates (this worktree, 2026-09-28; source: the command output in the implementer's session)

- `npx tsc --noEmit` (root): no errors.
- `npm run typecheck` (services/control-plane): no errors.
- `npx vitest run` (services/control-plane): 43 files passed, 3 skipped; 632 tests passed, 34 skipped.
- Root `npx vitest run` over the account, gate and access suites and every root test importing a
  changed file, in three runs: 17 files and 283 tests, 24 files and 257 tests, 1 file and 9 tests;
  all passed, none failed or skipped.
- The owner's export (OPS-05) passes the access view through, so its strict schema and
  `shared/organization-export.ts` now accept the optional `coveredBy` and grant `scope` fields. The full root suite, Playwright, vite build and packaging were
  not run here (the heavy slot belonged to another lane); the orchestrator runs them.
