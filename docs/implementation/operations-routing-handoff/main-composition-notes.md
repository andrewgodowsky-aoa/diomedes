# Main composition notes

Current local source is app `dae3a4b60feef2baec1ce15defcb3542c3c5a41c` and
Operations `fdd73a74b87bcbcf0ddec123cf78117efcf8fa8a`. The main adaptations
were committed as app `a9bbe8c` and Operations `e8366b4`. The later response
contract repair is `da04d6a`; the two-journey fixture and Home receipt mount
are `dae3a4b`. The final local browser run passed both journeys, root TypeScript
and both builds against the exact `dae3a4b` tree. See `finish.md` and
`source-candidate.json` for current identities. The later Operations test-only
repair `fdd73a7` passes 24/24 while retaining production bytes from `e8366b4`;
the chronological source reviews
below retain their original scope and acceptance limits.

The coordinator separately composed the security-owned session repair and
reported both browser journeys and builds passing on `6e9ebba`. That source
is not imported into this lane. Its combined checks and independent review
remain the coordinator's evidence; neither historical results nor this lane's
local run substitute for exact combined acceptance.

Andrew chose adaptation to new main on 2026-09-28. The earlier source review
below is preserved as the rationale; it is followed here by execution evidence.
The old-base source and docs are preserved in checkpoint
`e730317e89ddb49ccac7dcb54d3fa7e66f92896a`, with the original CF61 manifest and
test logs unchanged. The candidate manifest alongside this note describes that
old-base checkpoint; it is not a manifest for the later composition.

Exact app main `1af37e0` and Operations main `d0d04da` have been imported in
their existing isolated feature worktrees. Nine app conflicts were resolved;
Operations merged mechanically without conflicts. Routing SQL is now 010.
Individual 009 retains SHA256
`540f7bb22cc183175984fcdcf8e82718a7b093ec77d09329656ddd68196e5886`.
Security-owned `session.ts` remains the imported main blob
`6bada7aee2cf5758223c1a0bde6cccafb9441c6f`; no security repair is applied here.

The original authority regressions ran on staged tree
`ea7c0821c4926ed98ef65db010150b210f25e10a` before the source repair. Five failed
at their intended assertions; eighteen unrelated cases were filtered out.
Evidence: `test-results/operations-routing-main-red-20260928-112046/`.
All 1,473 source hashes remained unchanged. This is original-failure evidence,
not acceptance of the mechanical composition. Database, build, browser and
provider checks remain separately gated.

## Narrow repair after the original failures

The local repair provisions Individual billing identity under `tenantId = personId`
when staff issues a person grant, without issuing access or credits from the identity
helper. Person-first lock order is shared with explicit usage-agreement writes.
Migration 010 also creates identities for existing 009 grant holders so Operations
can find them before setup; it preserves their original grant and admission records.
The real PostgreSQL upgrade fixture now writes the pre-010 schema directly, preserves
record text/revisions and exercises a scoped Personal admission after the upgrade.
That database fixture is authored, not executed.

Scoped access, admission and gateway dispatch require current person-plan access.
Managed Personal work also needs a current managed-usage agreement on its billing
scope. New Personal admissions use the existing append-only Personal table, name
their billing account explicitly and return a null Business organization id. Legacy
Personal admission refuses managed requests with `scoped_admission_required`.
Business access/admission no longer reads a person's Individual grant at any member
count. Operations describes Personal access and usage funding separately.

The five original regression cases are unchanged. Additional focused checks cover
legacy managed refusal, immutable 009 history and the Personal host-to-provider
path with normalized response, scope headers and funding attribution. The focused
run passed 49 control-plane and 34 desktop tests. Both typechecks passed after
explicit string validation in the unrun PostgreSQL fixture. Exact failures,
repairs, frozen hashes and successful rerun are in `review-record.md`.
Security-owned session composition and broader/database/provider gates remain
separate. The later local browser result is recorded above and in the review record.

## Prior source review (before the repair above)

### Exact source boundary

- Routing candidate: `2b231c80cfd2dd9c6a7534e2ecf9e772f6db9c19` plus the owned
  working changes recorded in the integration and browser manifests.
- Previous main: `2e6c7850eb28491ea662fe2f36b68d5ac41ddbea`.
- New main: `1af37e085ef24fc6c92d6b2b8510fc52a504bd1b`, merging Individual
  source `a194ad8663c6d744c83d92ac09e0d91cafe0a653` in PR #176.
- Main `009_individual_plans.sql` Git blob:
  `a6da526ec52317a13f0a8b529b66508e9f39680b`.
  Coordinator-reported SQL SHA256:
  `540f7bb22cc183175984fcdcf8e82718a7b093ec77d09329656ddd68196e5886`.
- Main `shared/individual-plan.ts` Git blob:
  `283bd8fdd40c7e6ba4f017812bcda6550ef224f3`.
- Operations main: `d0d04da058e7e9fdaeb89f6b28da2ad933f678de`, PR #6,
  including Individual administration source `76d936c4f4354fc833ec711554043ba20a807e20`.
  Its seven changed files overlap routing's `electron/service.mjs`,
  `src/Customers.tsx` and `src/api.ts`. Operations remains frozen at `f97e0b5`;
  the new person-grant UI and billing-scope UI need the same composition review.

The coordinator reports staging migration and Worker deployment. Those reports
are not this lane's database inspection or deployed-byte verification. Source
alone is sufficient to show the migration-number and account-authority conflicts.

## Applied history and identity

The migration runner compares every recorded version, name and SHA256 to the
source sequence. It deliberately refuses any mismatch. If main's 009 was
applied, retaining that file byte-for-byte and appending routing as 010 is the
compatible forward path. Reverting application source would not make migration
number 009 reusable. Never edit migration-history rows to conceal a mismatch.

Main's 009 binds person grants, access revisions and Personal admissions to
`tenant_id = person_id`. Grant identities are immutable and Personal admissions
are append-only. Routing's candidate creates a distinct billing scope with an
Individual account ID and tenant ID, linked uniquely to the same person. These
are different authorities: the person owns access; the billing scope owns a
funded account. Historical person rows must not be rewritten merely to make the
two IDs equal.

Source review also supports the coordinator's narrower adapt option: initialize
the new Individual billing account with `tenantId = personId`, retaining its
distinct `individual_*` account ID. The current routing schema, PostgreSQL
adapter and funding relations accept that tenant value; account isolation is
keyed by the explicit billing account and scope, not by a `tenant_` prefix. The
scoped tests inspected here do not require those two IDs to differ. This option
matches applied 009 without updating any historical person record. Confirm the
new billing table's equality invariant and existing organization isolation in
real upgrade tests; no such change or test has run yet.

Routing's `ensureIndividualAccount` creates identity only, with no entitlement
or credits. Composition should reuse it during authorized grant provisioning,
before any routing/setup screen is opened, and retain one account per person
under concurrent provisioning. The exact lock order must be reconciled with
main's separate `lockPerson` operation before implementation. Prefer a single
person lock for creation, with consistent person-before-account ordering for
operations that acquire both; do not introduce opposing lock orders in grant
and funding paths. Creating or
finding the billing account cannot authorize a grant, allocate a balance or
establish customer privacy consent.

## Admission and funding reconciliation

Main introduces `person_feature_grants`, `/account/access` and Personal Agent
admissions. Routing's earlier minimal Individual agreement path grants Agent
and managed usage against its billing scope. They cannot remain competing
authorities after composition. Personal Agent eligibility must read the current
person grant; any managed allowance additionally needs the explicit billing
agreement and funded account. Revoking or expiring either applicable authority
must prevent the next managed dispatch without deleting history or refunding an
uncertain attempt.

Main deliberately rejects managed Individual inference until funding is added.
Replace that refusal only where the reconciled routing/funding contract proves
eligibility. Preserve its Personal BYO behavior and the organization's independent
admission path. A nullable Personal `organizationId` must not be filled with a
fabricated organization; a billing account ID remains an explicitly typed scope.
Existing person grant/admission storage can retain its historical tenant key.

Main's `individualCovers` currently admits a Business with members within a
configured threshold. The latest owner decision is Personal-only. Composition
must remove that Business coverage, including a one-member Business, and align
the corresponding access views, admission tests, O45 and implementation note.
The three canonical documents are a separately coordinated correction.

Operations main also needs the Personal-only wording in `src/Admin.tsx`:
`INDIVIDUAL_ELIGIBILITY` still makes a sole-proprietor exception immediately
beside its Business-separation sentence. Preserve its person-grant flow, customer
form error handling and person/organization plan filtering while combining the
three overlapping files. The routing account's agreement controls and People
screen must describe the same paid-access and managed-usage requirements.

## Guarded account-session composition

The coordinator relayed the security owner's read-only comparison of PR #176
with the verified session repair. Their base-relative edits are disjoint, but
that is not semantic integration proof. Preserve the complete guarded sign-in
and lifecycle repair in `server/accounts/session.ts`; await Personal
`/account/access` inside the guarded candidate-sign-in operation before adopting
its result. Carry the Personal access cache and nullable Personal admission
scope through the same identity/lifecycle checks. These source changes remain
owned by the security lane and are not applied here.

Two additional regressions are required and remain unexecuted:

- Delay a Personal access refresh, switch the signed-in account, then release
  the old response. The old person's entitlement must not populate the new
  person's cache or authorize their work.
- Return a Personal admission naming a different person. Refuse that response
  before adopting an admission or dispatching work. The security owner reports
  that main's current parser only requires a nonempty `personId`; composition
  must bind it to the currently authenticated person, including across awaits.

These are review findings and planned checks, not reproduced failures or new
passing results. Preserve the prior security repair's original evidence and
rerun its account-switch/lifecycle checks on the exact composed candidate.

## Required evidence after composition

- Migration sequence 001 through unchanged Individual 009 plus routing 010:
  fresh database and upgrade from 009, with repeat application returning no work.
  Seed real person grants/admissions before upgrade and verify unchanged bytes.
- Grant-first provisioning before any setup visit, concurrent identity creation,
  restart, restricted runtime privileges and no automatic entitlement or credits.
- One person with Personal and two Business workspaces: separate policies,
  privacy consent, admission, funding and receipts; one-member Business excluded.
- Personal BYO remains available under its person grant. Managed Personal work
  requires both current access and explicitly funded usage. Grant revocation,
  agreement revocation, expiry, forged scope and account switching fail closed.
- Retain the routing candidate's cancellation, source-restriction, price/cap and
  no-replay regressions. Re-run the required repository and UI checks against the
  exact composed source; the previous 132-test result remains historical evidence.

The existing real PostgreSQL suite has no approved runnable target. Read-only
inventory found only the production Neon branch. It must use a new disposable
database on an explicitly approved isolated branch or local PostgreSQL instance;
neither application/staging data nor production is a test fixture.
