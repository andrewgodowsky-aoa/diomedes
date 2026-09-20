# Multi-user access and worker-profile foundation

Date: 2026-09-20
Status: Implemented first host-side slice; not production multi-user readiness
Branch: `feature/multi-user-access`
Worktree: `F:/Diomedes/diomedes-wt/multi-user-access`
Base: `main` at `80263205133c410d590549efd1c8f40cedf33b1c`

## Authority check

This slice was reconciled against:

- Core Pillars `2026-09-19.1`
- Live Roadmap `2026-09-19.2`
- Project Memory `2026-09-19.2`
- current workspace, Trust, Agent and business-output source on the base commit

The implementation keeps membership, human access, worker ceilings and exact
effect approval separate. It extends the existing workspace registry rather
than creating another organization store or a second runtime/approval system.

## Implemented

- Added a fixed, typed business permission catalogue. Unknown permission text
  fails closed and cannot become executable authority.
- Added organization-owned protected resources for organization, location,
  business area, Project, data scope, connector and worker-profile boundaries.
- Materialized one protected Owner profile and organization-root assignment for
  each active owner. It includes the fixed access catalogue but no exact-effect
  approval permission; exact Trust decisions remain separate.
- Added immutable custom human profile revisions and pinned resource
  assignments. A newer profile revision changes no existing assignment until an
  owner explicitly replaces it.
- Added Owner-only routes to create resources, profiles, revisions,
  assignments, revocations and worker profiles. A member cannot self-assign or
  edit a stronger profile.
- Added server-side resource discovery. Members receive only resources covered
  by the requested fixed permission and their current pinned assignments.
- Added organization and principal authorization generations. Membership,
  assignment and access-ledger changes advance the relevant generation.
- Added versioned worker profiles that pin an Agent id/version/digest and set
  permission, resource, context, tool, rule and route ceilings. Worker profiles
  carry `grantsAuthority: false`.
- Added a pure interactive-worker decision contract. Allow requires the
  intersection of human access, worker profile, exact Agent reference, task
  grant, route capability, Agent ceiling and organization policy.
- Added exclusive Project ownership at the business-output binding boundary.
  A Project cannot be claimed by two organizations, and a stale binding cannot
  resolve a Project owned by another organization.
- Migrated existing single-owner workspace registries additively. Existing
  unambiguous output bindings receive a Project ownership resource; ambiguous
  legacy bindings remain unresolved and cannot run a brief.

Restaurant-shaped tests prove a Head Chef can discover assigned kitchen recipes
and counts without finance, and a GM-shaped assignment cannot cross into
Kitchen merely because of its name. These are synthetic fixtures, not hard-coded
restaurant roles or product templates.

## Deliberate boundary

This is the first enforcement slice, not completion of hosted multi-user access.
It does not add or claim:

- production identity, hosted membership or entitlement;
- a Console access-management screen;
- tenant filtering on every Project, file, search, export, SSE, context, Team or
  background-work route;
- an organization-worker principal or scheduled-worker activation;
- Runtime binding of worker profiles to Team members or runs;
- access-admin delegation, ownership transfer, profile retirement or resource
  moves;
- append-only authorization-event audit records;
- WorkOS FGA or another external authorization dependency.

The current local identity remains explicitly a development fixture. B02/B03
production identity and tenancy work remains separate. SEC-002 is narrowed at
the business-output binding boundary but is not closed across all Project
surfaces by this slice.

## Verification

Final verification in this exact worktree:

- `npx tsc --noEmit`: passed.
- `npx vitest run`: 124 files passed; 2,260 tests passed; 1 skipped; 0 failed.
  Windows registry/process tests ran outside the restricted sandbox. Git
  safe-directory values were supplied only to that test process.
- `npx vite build`: passed; 233 modules transformed.
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts`:
  35 passed; 0 failed.
- Focused access/output/workspace pass: 5 files passed; 63 tests passed.

No package, dependency, version, executable or release artifact changed.

## PILLAR IMPACT

- Advances P02 by expressing restaurant examples through generic resources and
  profiles rather than a restaurant-specific product fork.
- Advances P04 and P09 by making server-side resource discovery and tenant
  ownership explicit instead of relying on hidden UI state.
- Advances P06 and P08 by separating durable scoped access from exact-action
  approvals rather than turning every read into approval spam.
- Advances P12 by keeping Personal and Business on the same Core/Trust concepts
  while adding organization-specific configuration.
- No pillar is intentionally superseded. The principal remaining risk is that
  route coverage is partial until every protected surface consumes the same
  decision contract.

## ROADMAP IMPACT

This supplies an implementation foundation for the hosted-access prerequisites
in roadmap section 6F. It changes no roadmap item to DONE and makes no hosted or
production-readiness claim.

## BUILD / PUBLICATION / DEPLOYMENT STATUS

- Build status: source and required gates pass in the feature worktree.
- Publication status: uncommitted and unpushed pending owner review of this
  exact patch.
- Deployment status: not merged, released or deployed; no live customer data or
  account was touched.

No Astra advisor was invoked because implementation did not hit an architecture
or execution blocker.
