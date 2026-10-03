# Funding verification after the usage center (2026-10-01)

Repository: `andrewgodowsky-aoa/diomedes`. Base: main `f72c6ace14c89201425e33f90fb096bdbdda8f4d` (PR #197).
Worktree branch: `claude/funding-implementation-verify-89df76`. Nothing here is committed, pushed, packaged,
migrated or deployed.

The three repository canonical mirrors report version **2026-09-27.2**. Nothing here changes a pillar,
a plan, a price or a commercial rule. One approved rule that a route skipped is now enforced, and one
display mapping follows it.

## What was checked, and against what

The approved implementation was read from source and from its records:
`2026-09-29-individual-funding.md`, `2026-10-01-individual-reset-boundary.md`, PRs #190 (staff
reserve), #191 (bought-usage holds and leases), #194 (out-of-credits stop), #195 (member limits) and
#197 (usage center and credit purchases), `QUESTIONS.md` O45 and
`docs/business/PRICING_STRATEGY_2026-09-15.md`.

Active ownership at this base, by open pull request, since this Mac has no coordination root: #187
(Individual access lapse: `managed-inference.ts`, `shared/individual-plan.ts`), #182 (staff credits:
`commercial.ts`, `worker.ts`, `faux/cloud.ts`, `faux/store.ts`, the permission scripts), #193 (webhook
race: `postgres.ts`) and #196 (limited Individual grants, a new migration). This patch touches none of
their files. The engine files the Agent route owns (`server/engines/`, `server/app.ts`) are not changed.

| Question | Finding | Evidence |
|---|---|---|
| Agent and Team work use the right payer | Holds. The payer is the project's recorded owner (a Business), else the person's own Individual account; the admission pins that scope, every call carries it, and the gateway checks the admission against it. Agent turns, Work runs, loops and Team member turns all admit this way. | `server/accounts/routing-session.ts` `scopeFor`, `server/engines/nectovia.ts` `nectoviaBinding`, `services/control-plane/src/managed-inference.ts` `checkAdmission`; `tests/agent-project-attribution.test.ts`, `tests/individual-plan.test.ts` |
| Team work stays inside its allowance | Pool and member limits hold. Job caps: see finding 3. | below |
| Included subscription credits expire, no rollover | Holds. Individual terms fund only themselves, and an unsent hold from an ended term is released; Business months fund only the current UTC month. | `individual-funding.test.ts`, `funding.test.ts` "monthly reset" |
| Bought credits carry forward | Holds. Bought credits are one all-time balance, never tied to a month; the included allowance is spent first. New test pins it across two month ends. | `funding.test.ts` "carries bought credits into the next months" |
| Limits, cancellation, retries, late settlement | One gap, repaired (finding 1). Retries replay by attempt id, cancellation after dispatch parks the hold as uncertain, late settlement lands on the original payer and period, and a late bought-credit settle never overdraws. | `member-limits.test.ts`, `purchased-usage.test.ts`, `funding.test.ts`, `individual-funding.test.ts` |

## Findings

### 1. A member could hold bought credits past their own monthly limit (repaired)

Andrew's 2026-10-01 rule (PR #195): every member's monthly limit is always on, and drawing bought
credits past it needs an approval that allows bought credits. `FundingService.reserve` enforced it;
`FundingService.holdPurchased`, which any active member reaches directly
(`POST /account/organizations/:id/purchased-usage/holds`, and the desktop's allowance admit route), did
not. A member at their limit could hold, then settle, the business's bought credits with no approval.

Failing first (`evidence/funding-verification/2026-10-01/red-*.log`): three control-plane cases, and
the desktop route case, where a member limited to 10 credits was admitted a 40-credit hold (200).

Repair:

- `holdPurchased` takes the verified role from the membership the service just checked and runs the
  same `enforceMemberLimit` as `reserve`, in the same transaction, under the same organization lock,
  after the replay check and the balance checks. A retry of a landed hold is never refused by it.
- A hold can come before anything has recorded the month's grant, because the gateway records it on the
  month's first funded call. A limit set for the person or their role still applies then. The plan
  default (the month's whole grant) is not known then and is not applied; see "Decisions for Andrew".
- `approvedAllowances` accepts no job, since a hold has none; `memberUsage` takes only a month's
  bounds. Both are type changes; the SQL is unchanged, and `cp_funding` already reads every table
  involved (`scripts/funding-permissions.sql`). No migration and no grant change.
- The desktop shows the refusal as a limit (409 `member_limit_reached`, the service's own sentence)
  instead of "Bought usage can't be held right now."

### 2. This computer's guard stops Personal work early after a mid-month renewal (recorded, not repaired)

Individual credits follow anniversary terms, but the engine keys its local Nectovia guard by billing
account and UTC calendar month (`nectoviaConnectionId`, used in `modelApiRoute` and `admitNectovia`).
A September 15 subscriber who used 900 credits on October 10 has 100 left on this computer's guard
after the October 15 renewal, while the account service funds 1,000. Nothing is overspent; the guard
refuses too early, and its sentence speaks of "this business's month".

`tests/individual-term-local-guard.test.ts` records it as `test.fails`, so the gates stay green and the
case flips when the guard follows the term. The repair needs the term at admission (the admission
answer does not carry it, and a grant's `validUntil` may end before its term), so it touches the Agent
route's engine files and the account service's admission answer. That belongs to the Agent owner and
is not applied here.

### 3. A Team member's automatic wake opens a new job with a fresh cap (decision)

A member woken by team mail runs a new Work request (`teamService.setRunStarter` in `server/app.ts`),
and a model-API team turn admits under that request's id (`generateModelApiTools`), so each wake is a
new root job with its tier's whole cap. Automatic wakes are limited to five per member every ten
minutes (`server/team/service.ts`). The business pool, the person's monthly limit and the company
ceiling still bound the spend. Pricing says delegation cannot reset a job's cap; whether a team wake is
a delegation or a new job is Andrew's to say.

### 4. Open lanes that bear on funding

- On main, an Individual grant holding only the Agent and managed inference qualifies for the
  automatic 1,000 credits (`individualIncludesMonthlyCredits`). PR #196 owns that repair.
- PR #196 adds `014_individual_complete_plan_credits.sql`. Main's runner takes the version from the
  file number, and 014 (`014_member_credit_limits.sql`) and 015 are already applied to
  `accounts_staging`, so #196's migration needs a new number before it can be listed.

## Decisions for Andrew

1. **A member's bought-credit hold before the month's grant is recorded.** With a limit set for the
   person or their role, it applies. With only the plan default, nothing is enforced until the month's
   first funded call records the grant. Failing closed would refuse members' holds at the start of a
   month; leaving it is what this patch does.
2. **Team wakes and job caps** (finding 3).
3. Still open from PR #191: whether employees may hold bought credits at all, and that a settle trusts
   the stated debit up to the hold.

## Verification

Run on this Mac (Node 22, real `TMPDIR`, Vitest at two workers, the root type check at a 4 GB heap) in
a detached checkout of the base outside `.claude/` with this patch applied, because the desktop path
guard refuses `.claude`. The nine changed files there are byte-identical to the worktree's. Logs and
the source manifest (each file's SHA-256, and patch SHA-256 `c5cffdf3a0146527562012db568dab209223271ef454557f938de21fe7befe0b`
over the base): `evidence/funding-verification/2026-10-01/`.

| Check | Result |
|---|---|
| Control plane `tsc --noEmit` | pass |
| Control plane `npm test` (full) | 52 files passed, 5 skipped; 952 tests passed, 55 skipped |
| Root `tsc --noEmit` | pass |
| Root Vitest, 21 funding, payer and route files | 21 files, 415 tests passed; one is the `test.fails` case of finding 2 |

Not run: the full root Vitest, `vite build` and Playwright (no client change), and the PostgreSQL
suites, which are skipped, not passed. No disposable PostgreSQL is on this Mac, and getting one is a
download that needs approval. No staging or production database was read or changed.

## Required status report

**Pillar impact:** bounded authorized spending holds on one more path (Pillar 09), through the same
funding authority and lock, with no second ledger, limit model or surface (Pillar 12).

**Roadmap impact:** none marked. DIO-160's member limits now cover bought-credit holds in source; DIO-128
stays In Progress, now with finding 2 recorded.

**Build / publication / deployment:** source and offline tests only. Nothing committed, pushed,
migrated, packaged or deployed.
