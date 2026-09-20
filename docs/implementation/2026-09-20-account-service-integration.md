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

## Remaining acceptance boundaries

Local workerd verified real RS256 validation and signature refusal against
provider fixtures. Its sampled active V8 estimate was 13.02 ms per request;
that is not Cloudflare billed CPU and does not prove the Free 10 ms budget.
Hosted capacity, real AuthKit login/refresh, provider configuration, Stripe,
entitlements, funded usage, final Store authorization and physical-device
journeys require their separate acceptance. No full B01, H12 or mobile prompt
is DONE merely because this prerequisite is merged.
