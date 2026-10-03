# Limited Individual grants and automatic credits

Base: application main `a0d752e94a6a83ba9cd3b7277361dd2986d56014` (PR192 included).
Worktree: `F:/Diomedes/diomedes-wt/individual-grant-allowance`.
Branch: `feature/individual-grant-allowance`. Work order: `DIO128-LIMITED-PLAN-CREDITS`.
Pillars, live roadmap and project memory mirrors: `2026-09-27.2`.

## Problem and repair

The monthly-credit predicate accepted an Individual grant with just Agent and managed inference,
or the current feature set with a missing legacy feature. Staff issuance could give that limited
override a monthly term without an explicit end; the usage read and first managed use then treated
it as the full 1,000-credit offer. Staff `grants.write` was required. This work inspected no live
customer database and establishes no evidence of live misuse.

The repaired predicate requires all four original features in the same Individual grant:
`nectovia-agent`, `maintained-profiles`, `owner-rules` and `phone-relay`. It accepts the complete
legacy template and current five-feature superset. Existing issuer, usage and allocation callers
share this predicate. Limited overrides keep explicit end dates and cannot submit a billing cycle.
Features in separate limited grants never combine into a full-plan source.

Additive migration `014_individual_complete_plan_credits.sql` makes the same feature requirement in
`check_individual_period_source()`. It preserves 012's owner/ACL, security-definer/search-path
settings, source/account locks, person/tenant identity, active state, dates, exact amount, billing
term bounds and overlap checks. Applied migration files 011/012 remain unchanged. The migration
does not rewrite grants, terms, agreements, financial rows, purchases, reservations or settlements.

## Historical behavior retained

Existing recorded calendar balances can still be debited under current limited Agent-plus-managed
access; the repair prevents fresh automatic allocations and does not invalidate that historical
funding. Included credits still expire with their existing period. Explicit agreements retain their
own allocation. Already funded terms are reused under qualifying replacement grants without a
refill or source rewrite. Dispatched work retains its original payer/period for late settlement.
Purchased credit records and their separate carry-forward behavior remain intact.

Stored cycles, including historical misclassified cycles, remain in operator renewal suggestions,
overlap checks and replay protections. There is no automatic correction, debit or reclaim policy in
this patch. Any operator correction or change to historical debit eligibility needs its own review.

## Migration composition and rollout gate

PR191 reserves `013_purchased_usage_holds.sql`; no file or lock in its lane was changed. The exact
external qualification source is PR191 `c8f716cdc9466254f7c44ad11687b0c5004c5245`, Git blob
`3c422a3597264414ade89a39cff00c99f55c8374`, SHA256
`3ac7d82912e7bc20f0173fc807b8c3dad15968106028cb6623181c6439bc74fe`. It is excluded from this repair
patch and used only in an owned disposable local database.

The pinned013 SQL composition test does not qualify PR191’s revised runtime hold leases, late
settlement or negative purchased-balance behavior. Its complete final runtime candidate still
requires separate qualification and fresh source-aware composition review.

Current `scripts/migrate.ts` lists 001 through 012, and contains neither 013 nor 014. Migration 014
is not deployable through that manifest. The migration engine's contiguous-version and exact
history-hash checks remain unchanged; a regression refuses 001..012,014 before opening a database.
The historical Individual PostgreSQL suite stays pinned to its asserted 011/012 boundary; a separate
restricted-role suite qualifies actual contiguous 001..013..014 upgrade and replay.

After actual 013 integration, inspect the fresh manifest and source hashes, append 014 with its
filename version, and rerun composed local/isolated staging qualification. A separate source-aware
runner proposal is provided in the task deliverables, with an explicit assumed-013 preimage. It
must be regenerated if the real source differs. Apply the accepted SQL as the existing migration
owner before deploying application code; this request authorizes no hosted migration or deployment.

Rollback must not restore the permissive predicate. If rollout fails, retain history and stop new
affected allocation paths while preparing a reviewed forward repair. Never rewrite 011/012 or an
applied 014 hash, renumber another lane's migration, or reclaim balances automatically.

## Verification

Exact-base controlled RED reproduced the defect, then the same final regressions passed against
the repaired predicate. Source restoration is recorded in `baseline-proof.json`. Initial fixture,
setup and stream-cleanup failures are retained separately and excluded from qualification counts.

| Check | Actual result | Source from this run |
|---|---|---|
| predicate RED | 29 passed; 7 failed; 0 skipped | `C:/Users/andre/Documents/Codex/2026-10-01/task-8/evidence/focused-red-qualified-final/root.json` |
| API/routing RED | 55 passed; 26 failed; 0 skipped | `C:/Users/andre/Documents/Codex/2026-10-01/task-8/evidence/focused-red-qualified-final/control-plane.json` |
| restricted PostgreSQL RED | 15 passed; 9 failed; 0 skipped | `C:/Users/andre/Documents/Codex/2026-10-01/task-8/evidence/postgres-red-final/tests.json` |
| predicate GREEN | 36 passed; 0 failed; 0 skipped | `C:/Users/andre/Documents/Codex/2026-10-01/task-8/evidence/focused-green-final/root.json` |
| API/routing GREEN | 81 passed; 0 failed; 0 skipped | `C:/Users/andre/Documents/Codex/2026-10-01/task-8/evidence/focused-green-final/control-plane.json` |
| restricted PostgreSQL GREEN | 24 passed; 0 failed; 0 skipped | `C:/Users/andre/Documents/Codex/2026-10-01/task-8/evidence/postgres-green/tests.json` |
| historical PostgreSQL 011/012 | 12 passed; 0 failed; 0 skipped | `C:/Users/andre/Documents/Codex/2026-10-01/task-8/evidence/postgres-green/historical-tests.json` |
| root unit gate | 8778 passed; 0 failed; 5 skipped | `C:/Users/andre/Documents/Codex/2026-10-01/task-8/evidence/gates/root-unit.json` |
| control-plane unit gate | 804 passed; 0 failed; 75 skipped | `C:/Users/andre/Documents/Codex/2026-10-01/task-8/evidence/gates/control-plane-unit.json` |
| Browser ui/native-ui/field | 36 passed; 0 skipped; 0 unexpected; 0 flaky | `C:/Users/andre/Documents/Codex/2026-10-01/task-8/evidence/gates/browser.json` |

All seven gate commands exited 0: root TypeScript, root Vitest, Vite build, the three required
Playwright files, control-plane TypeScript, control-plane Vitest, and Wrangler deploy dry-run.
Gate timestamps and exits: `C:/Users/andre/Documents/Codex/2026-10-01/task-8/evidence/gates/results.json`. These counts come from
those final JSON reports; duplicate focused/integration runs are not combined into a gate total.

The PostgreSQL 18.6 clusters were newly created, owned, loopback-only and disposable. Runtime and
funding SQL logins had real restricted permissions. Authentication, provider transport and prior
purchase provenance were fixtures; this proves no live provider or payment behavior. Actual
001..012 source, pinned external 013 and additive 014 exercised the contiguous migration engine,
history hashes, replay, function ACL/settings, concurrent allocation, lost-COMMIT retry, source
identity refusals and preservation of historical rows and late settlement. A second new database
qualified the existing 011/012 regression suite without resetting any schema. Every owned
PostgreSQL process stopped cleanly; cleanup receipts are in `evidence/postgres-*/result.json`.

Static scope proof: `C:/Users/andre/Documents/Codex/2026-10-01/task-8/evidence/migration-scope.json`. Migration 014's validator is
exactly 012's body and revoke statement except the tightened feature predicate. Applied 011/012
Git blobs remain `abf2e7517abdc51308ce1b7b86adec43969c12f0` and
`536b5f4184b9294ad714df52ffebb4c64a98d9ba`.

Full evidence summary: `C:/Users/andre/Documents/Codex/2026-10-01/task-8/verification-summary.json`. Root dependencies were linked
to an existing complete local install with identical lockfile blob
`67452e90876647c6f8ba28809cc379cf59235531`; all direct pinned versions matched. Control-plane
direct dependency versions also matched. No installation or lockfile change was needed.


## Product and publication status

This implements the existing funding distinction under Pillars 09 and 12; no pricing, template,
permission or product definition changes. No roadmap status or DONE marker changed. Build status
will be reported from the local logs. Source remains uncommitted and unpublished; no push, PR,
merge, release, hosted Actions, provider call, live credential or production data change is authorized.
