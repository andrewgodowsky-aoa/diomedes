# DIO-128: recurring Individual funding candidate (2026-09-29)

Repository: `andrewgodowsky-aoa/diomedes`. Base: upstream/main
`5f97d97e61300c08002d7767bbbb179c1882a5fc` (PR #178). Branch:
`codex/dio-128-individual-funding`. This records the local verification checkpoint before
publication. Andrew approved committing the reviewed patch and opening a draft PR on 2026-09-29;
that approval does not authorize merging, release or deployment. No changes target the
`diomedes-mac` fork.

## Authority and preserved integration

DIO-128 and app PRs #176, #177 and #178 were re-read before implementation. Phase 2a merged at
`1af37e0`; #177 at `d017647`; #178 at the full base above. This candidate extends their existing
person access, billing scopes, routing preferences, admission pins, policy and native routing
behavior. Migrations 001–010 and existing runtime/funding permission scripts are unchanged.

The three repository canonical mirrors report version **2026-09-27.2**. The accepted rule is
Personal only, including for a person who owns a one-member Business. Every Business needs its
own Business plan. The approved Individual allowance is 1,000 monthly credits.

Andrew clarified during this implementation that unused monthly credits expire. The next period
starts at **0% used with 1,000 credits**, with **no unused-credit carryover**. Historical periods
and delayed settlements remain evidence; they never enlarge a later month's allowance.

## Implemented boundary

- Full Individual grants now include `managed-inference`. Existing phase-2a grants with the
  complete four-feature template receive the same derived entitlement without rewriting their
  historical records. Limited feature overrides retain their narrower scope. A managed-only
  person grant without Agent access is refused.
- Managed Personal dispatch uses the person's distinct Individual billing account, with
  `tenant_id = person_id`. It cannot adopt the selected Business, another person's account, or
  a Business grant. Scoped admission, current access, current policy and the pre-dispatch check
  remain required. Legacy unscoped managed admission still refuses spending.
- The first funded request of a period lazily allocates exactly 1,000 credits, using the existing
  account lock and unique period key. Concurrent requests and a committed write whose response
  was lost retry to the original row. Reissuing access or changing configuration cannot refill it.
- Existing explicit agreement periods retain their amount, payer and source. This candidate
  does not silently top them up to 1,000 or replace their evidence. A subsequent eligible period
  can receive the recurring Individual allowance.
- New work can spend only its current period. An unused previous allowance cannot fund it.
  A new period's projection starts at 0% used. Revocation, lapse and account disabling prevent
  new dispatch; a hold revoked before dispatch is released without sending. Work already sent
  still settles against the payer and period recorded when it was reserved, including when the
  response arrives after that period ends.
- Migration 011 adds the person-grant funding source and validates exact person/account identity,
  live grant authority, amount and period under a narrowly scoped database trigger. It locks the
  source against concurrent revocation. Account-grant sources must belong to the same billing
  account. A composite settlement foreign key binds every settlement to its reservation's
  original payer and period. It neither allocates credits nor rewrites pre-existing history.
- The existing restricted `cp_funding` writer can allocate; `cp_runtime` cannot. Neither receives
  new identity, consent, audit, adjustment or schema privileges. The trigger reads source grants
  under a fixed search path; its function is not public executable authority.
- Disabled Individual accounts remain inspectable in authorized Operations lists and details,
  including historical admissions, while projecting no active Agent or managed authority.

## Verification

Gate results and the source fingerprint are recorded in
`evidence/dio-128/2026-09-29/verification.json`, with complete logs beside it.

| Gate | Fresh result | Log |
| --- | --- | --- |
| Root TypeScript | Passed, zero diagnostics; 4 GB Node heap | `root-types.log` |
| Control-plane TypeScript | Passed, zero diagnostics | `control-plane-types.log` |
| Root Vitest, one full run | **8,619 passed, 32 skipped**, 517 files passed / 2 skipped (519 total) | `root-vitest.log` |
| Control-plane Vitest, one full run | **736 passed, 48 skipped**, 47 files passed / 5 skipped (52 total) | `control-plane-vitest.log` |
| Real local PostgreSQL, separate explicit run | **27 passed**, 3 files; Individual 8, routing 6, account/funding 13 | `postgres.log` |
| Vite production client build | Passed; existing chunk-size warnings | `vite.log` |
| Required browser gate | **36 passed**, zero failed/skipped | `playwright.log` |

Skipped tests are not passing evidence. The PostgreSQL checks are a separate explicitly enabled
run; their counts are not added to the full-suite total. The full root run uses four workers and a
4 GB Node heap. The control-plane full suite uses one worker.

The root test fixtures cannot run inside `.codex`, which the product deliberately protects, and
macOS's default temporary path includes a symlink that the path guard refuses. The first root run
there failed for those fixture paths. An identical source snapshot at
`/Users/andrewgodowsky/Diomedes-dio128-verification` and an owned non-symlink temporary directory
are used for the desktop gates. That snapshot initially borrowed Git objects; two capability-record
checks correctly refused to infer history through alternates. It now owns its Git objects, and the
fresh full run above passes. A default-heap type check exhausted Node's 2 GB heap; the final 4 GB
run passes. The first browser invocation could not launch because the matching browser was absent;
the tool-matched browser was installed in an owned test-tools directory before the final run.
No production path guard or test assertion was relaxed to resolve these fixture problems. All
2,234 tracked files outside docs matched before browser execution; that suite then generated its
recorded screenshots in the verification copy. All 1840 tracked files outside docs/evidence,
and all 14 changed source/test paths, still match. Changed-source fingerprint:
`6441ebb0000fda8086e71199cfba0f679fd33d58cb9a453bd96c9dabcd2f4f7c`.

PostgreSQL tests use an owned, disposable local PostgreSQL **17.10** cluster and actual separate
runtime and funding logins, with the repository's existing role grants. They do not connect to
staging or production. The dedicated Individual suite refuses an existing schema. Tests cover
001–010 to 011 upgrades with prior Business/person records preserved, migration idempotence,
concurrent allocation, a lost commit response, invalid amount/period/grant denial, revocation,
lapse, cross-person/cross-scope denial, restricted role privileges, and original settlement period.

Independent read-only review found one Operations regression for disabled accounts. A failing
staff-list test reproduced it; the non-authorizing projection fixes it and keeps dispatch denied.
The reviewer confirmed that fix. Review also caught a test fixture exceeding the normal job cap;
the expiry test now uses a permitted reservation without changing production caps.

## Remaining acceptance and policy gaps

- **Reset boundary:** this candidate uses the existing ledger's UTC calendar months. Andrew's
  no-carryover decision is implemented. Whether the billing month must instead be anchored to
  the person's plan start date remains a question raised in this session; this record does not
  claim calendar-month billing was newly approved. The existing 31-day access template is
  unchanged. Reconcile subscription/renewal dates and billing-month boundaries before rollout.
- **Live acceptance:** migration 011 is not applied to a shared environment. There is no signed-in
  packaged-app journey, funded real-provider receipt, Operations acceptance on this candidate,
  migration rollout/rollback rehearsal against the deployment, or release evidence here. Synthetic
  provider responses and local database tests do not establish those outcomes.
- **Usage surface:** allocation is lazy at the first eligible dispatch. The broader customer
  Personal usage display/reset-date experience and subscription renewal/payment lifecycle are
  not completed by this server funding slice.
- **Related open work:** DIO-132 staff credit adjustments/audit idempotency are not fixed by this
  migration; granting extra database privileges alone would not fix that workflow. DIO-136 site
  pricing/Personal-only reconciliation and DIO-125 automation entitlement policy remain separate.
- The historical phase-2b plan-catalog consolidation and faux seed subscriber remain open.
  `shared/access.ts`, seed fixtures and pricing are not changed. Canonical cloud/mirror commercial
  reconciliation remains pending; no new price, checkout, automation authority or plan meaning
  is silently introduced here.

## Required status report

**Pillar impact:** advances person/Business funding separation, bounded authorized spending and
durable evidence through the same ledger and account authority. The tests above are the observable
proof. No second runtime, account authority or Console surface is introduced.

**Roadmap impact:** DIO-128's recurring funding moves from recorded/unwired to locally implemented
and verified within the stated boundary. DIO-128 remains In Progress / Partly implemented pending
review and the live-product gaps. No canonical roadmap item is marked shipped.

**Build / publication / deployment:** source verification only; no package, release, merge or
deployment. At the verification checkpoint, all candidate changes were uncommitted and unpushed.
Andrew subsequently approved this exact source patch for commit, push and a draft PR; DIO-128
records the resulting publication identifiers. The source fingerprint and pre-publication review
patch remain the evidence for that approval. Merging and deployment remain unauthorized.
