# Account service and desktop policy integration

The account policy is shared by the desktop Store adapter and the independently
deployable control-plane package. Desktop wrappers preserve ApiError responses
and the in-process membership snapshot boundary. Identity verification happens
before the Store transaction; portable state operations are awaited under its
existing lock. The WorkOS verifier uses Web Crypto on both runtimes.

The repository root now points Cloudflare's existing Git build to the actual
account Worker. The build installs the separate pinned package and checks its
types and offline tests. GitHub installs and checks that same package before
the root compiler, tests and client build. The Worker has no published route
and refuses missing configuration. This change does not establish a configured
production sign-in flow or activate subscriptions.

## Integration evidence

The original 40 service files were copied only after checking every frozen
SHA256. The accepted local account files and independent tests were also
verified before applying the portable extraction. Package and root TypeScript
passed. All 66 directly affected account/identity cases passed after extraction;
68 service offline cases passed. Broader composition gates and independent
service acceptance are recorded in the final PR evidence.

Real Neon qualification used a new schema-only branch on the existing Free
plan: br-spring-rice-aewy6iui, fixed 0.25 CU, default auto-suspend, expiry
2026-09-21T03:50:00Z. The disposable database was b01_validation_accounts.
Migration and test processes pinned its endpoint and refused the production
branch. Credentials remained process-local and were excluded from evidence.

All seven original real-PostgreSQL cases passed: empty/prior/idempotent
migration, interrupted DDL rollback, concurrent subject creation, atomic
authorization rollback, single-use invitations and last-owner races, webhook
deduplication and tenant foreign keys, and persisted session revocation.

Nine independent restricted-role cases passed. A fresh non-owner runtime login
performed account creation, invitations, membership changes, an actual Fetch
route and session revocation. PostgreSQL refused schema/table creation,
deletion, truncation, migration mutation, and commercial reads/writes with
insufficient_privilege. The login held no elevated flags or role memberships.
No production data or schema was changed; test resources expire with the branch.

Evidence: F:/Diomedes/deliverables/continuation-20260920/account-control-plane/integration-1/.
The first branch request explicitly setting the suspension interval was
refused by the Free plan. The successful request used the account default.

## Capacity and connection-lifetime repair acceptance

Independent review first reproduced a capacity lockout: accepting more active
memberships than bounded readers could return prevented later management.
Admission now enforces the active 100-workspace/1000-member limits under the
existing transaction locks. Revoked history does not consume capacity, rejected
rejoins remain reusable, and point queries preserve member/last-owner recovery.
The cloud session response uses bounded 25-row joined pages; the desktop wrapper
retains its full legacy response. Authority freshness remains five seconds.

An actual local Worker connected to Neon also exposed duplicate errors emitted
after an explicitly closed connection. The transaction owns its error listener
for the client's lifetime, rejects active/closing errors, and contains only late
notifications after successful close. It never retries uncertain commits.

The accepted repair tree is 843d5cd78b2a7af02a9a170bee945402a1d0b024 over
b52e9dd248e806831aec5f03f2702a9a9d221243. Its independent ACCEPT_SCOPED review
passed the unchanged original 30 cases, 28 new offline cases and three new
real-Neon cases, plus package TypeScript. The original rejected report and tests
remain preserved. The twelve repair files and added independent test were
imported only after exact frozen SHA256 verification.

Producer runtime checks returned 100 distinct workspaces in four pages taking
1.02-1.06 seconds each, with one joined query and no per-organization lookup.
Four preflights issued no SQL. Terminating its own backend during an uncommitted
insert produced 503 and rollback; subsequent traffic succeeded without uncaught
connection errors. These are local observations, not hosted CPU qualification.

Evidence: F:/Diomedes/deliverables/continuation-20260920/account-service-review-v2/
and account-control-plane/repaired-integration-gates-1/. The integrated service
suite passes 144 offline cases; 25 live-only cases are deliberately skipped in
that offline command. Separate real-database executions are recorded above and
in the repair review rather than counted as offline passes.

Final repaired desktop composition passes root TypeScript, 2306 unit cases,
Vite build and all 35 browser cases. One existing 8.3 platform-dependent unit
case is explicitly skipped locally. The separate service type check and dry-run
Worker build also pass. Hosted checks must bind the resulting published commit.

## Remaining acceptance boundaries

Local workerd verified real RS256 validation and signature refusal against
provider fixtures. Its sampled active V8 estimate was 13.02 ms per request;
that is not Cloudflare billed CPU and does not prove the Free 10 ms budget.
Hosted capacity, real AuthKit login/refresh, provider configuration, Stripe,
entitlements, funded usage, final Store authorization and physical-device
journeys require their separate acceptance. No full B01, H12 or mobile prompt
is DONE merely because this prerequisite is merged.
