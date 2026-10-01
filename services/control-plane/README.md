# Diomedes account control plane

An independently packaged Fetch service for verified accounts, organization
membership, feature grants, staff operations and the managed inference gateway.
The packaged Nectovia desktop signs customers in through WorkOS and uses this
service for account access. OAuth login and refresh belong to the native client;
Tasks, Runs and History remain with their existing owners. The marketing site
does not depend on this package. Payments and production onboarding are not
established by the presence of these routes.

From the full repository checkout, enter services/control-plane and run:

```
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

The build is a Wrangler **dry-run**, with no upload or deployment. The package
imports only existing pure PB-01 workspace/B00/micro-USD contracts outside its
directory. Keep the repository checkout; do not copy this folder in isolation.
Normal tests block HTTP and use a clearly labeled test-only in-memory adapter.
The PostgreSQL integration suite is opt-in and its skipped count is explicit.

## Customer access, staff operations and the faux cloud

Added 2026-09-25. Access is separate from inference payment: a feature grant
(`src/commercial.ts`, migration 005) says what a business may use, including the
Nectovia Agent; funding stays in `src/funding.ts`. New routes, all behind the
same bearer, origin and query rules:

- Customer: GET /account/organizations/:id/roster, POST
  /account/organizations/:id/invitation-codes (and .../:codeId/revoke), POST
  /account/invitation-codes/redeem, GET /account/organizations/:id/access, POST
  /account/organizations/:id/agent-admissions, GET /account/routing-policy.
- Staff (the Operations app): GET /ops/me, GET /ops/customers(?q), GET
  /ops/customers/:id, POST .../grants, POST .../grants/:id/revoke, POST
  .../funding, GET /ops/routing, POST /ops/routes, POST
  /ops/routing/preview|publish|rollback, GET|POST /ops/staff, PATCH
  /ops/staff/:id, GET /ops/people(?q), GET /ops/audit(?organizationId&limit).

The **faux cloud** (`src/faux/`) runs this handler over a JSON store and local
passwords in place of Neon and WorkOS. `npm run faux-cloud` serves it on
127.0.0.1:8795 with demo accounts (password `nectovia-demo`). A source/development
desktop with no account-service override hosts it when nothing answers there;
explicit test mode uses a separate in-process store. Packaged builds use the
deployed account service and refuse sign-in when it is unavailable. Faux data
only: none of its people, businesses or grants exist in the deployed service.

`npm run faux-cloud -- --identity workos-standin` swaps the passwords for a
local WorkOS stand-in (`src/faux/workos-standin.ts`, under /workos): the AuthKit
authorize (PKCE, loopback redirect, no login page; the person is the
`login_hint` email), authenticate (code and rotating refresh), JWKS, user and
session endpoints. The faux cloud then verifies with `WorkOSIdentityVerifier`
to exercise the legacy WorkOS staff flow locally. This does not exercise the
current Operations app's registered-device-key sign-in. Its store is a separate
file, and `POST /faux/bootstrap-admin {subject}` mirrors the legacy
`npm run bootstrap-admin` command against that faux store.

The faux cloud serves the managed inference gateway (`/managed/v1/*`, contract
`nectovia-managed/1`) with the Worker's own handler. A scripted provider answers
it offline with exact usage; the placeholder key it holds stands in for the
Worker secret `BEDROCK_API_KEY`. Bedrock is called for real only when
`NECTOVIA_FAUX_BEDROCK_API_KEY` is set, which needs Andrew's spend approval
first; with that key set and no readable `MANAGED_SPEND_CEILING_MICRO_USD`,
the faux cloud refuses to start. Typed evaluations (`/managed/v1/evaluations`)
work the same way: a scripted provider answers them offline, its placeholder
key stands in for the Worker secret `OPENROUTER_API_KEY`, and OpenRouter is
called for real only when `NECTOVIA_FAUX_OPENROUTER_API_KEY` is set, under the
same approval and the same ceiling rule. Two optional spend settings are read from the environment under the
Worker's own names (or `managed.settings` in code), whole numbers, blank meaning
unset, anything unreadable refusing every managed call with 503
`route_unavailable`:

- `MANAGED_SPEND_CEILING_MICRO_USD`: the most the provider account may owe
  across every business, for all time: settled provider cost plus every
  pending, uncertain or written-off hold in full plus the new call's hold. A
  call that would pass it is refused before any hold with 503
  `route_unavailable`, "Nothing was charged." Here it counts this store's
  ledger only, never the Worker's database, so the two do not share a total.
- `MANAGED_MAX_OUTPUT_TOKENS`: lowers the registry's output cap (16,000),
  never raises it. A larger request is clamped silently, and the response
  names the clamp in `X-Nectovia-Max-Output`.

## Entry and configuration

`src/worker.ts` is the actual Fetch entry. Existing route shapes are retained:
GET /account/session, POST /account/organizations, POST
/account/organizations/:id/invitations, POST
/account/organizations/:id/invitations/accept, PATCH
/account/organizations/:id/members/:personId, and POST /account/session/revoke.

Every page of GET /account/session also carries `staff`: `{ role }` when the
signed-in person has an active staff row, otherwise null. It is read from the
staff table alone, never from an email domain, a plan or the request, and a read
that fails answers null. The desktop uses it to let staff, and only staff,
reserve and settle allowance directly; an older service that omits it reads as
not staff.

The cloud GET /account/session returns at most 25 active workspaces plus
nextCursor (an organization ID or null). Continue with ?after=<nextCursor> until
null; every page re-verifies the session and current membership. The cursor is
not an authority token. Pages reflect current state rather than a cross-request
snapshot; a membership revoked before a later page is excluded. Other query
parameters are rejected. Each cloud page joins its membership and organization
records in one bounded database read. Browser preflight for the same GET page
accepts the validated continuation under the configured origin/header rules.
The local Store listWorkspaces method keeps its
existing complete response and shape using the same portable page traversal.

Every route requires an already issued bearer token. The verifier checks RS256,
pinned WorkOS JWKS, exact issuer/client/resource audience, bounded token times,
verified user and fresh active provider session. Provider organization, email,
role or entitlement claims never create Diomedes membership or authority.
This is not an AuthKit PKCE client. Revocation here is a durable local control
plane tombstone, not provider-wide logout.

Configuration must supply ENVIRONMENT (local/staging/production), comma-separated
exact ALLOWED_ORIGINS, WORKOS_CLIENT_ID, WORKOS_ISSUER,
WORKOS_TOKEN_AUDIENCE, and server-only WORKOS_API_KEY/DATABASE_URL. Since
2026-09-26, deployed staff routes (/ops/*) use `StaffKeyVerifier`: an individually
registered device key, checked on every request against `control_plane.staff_keys`,
followed by the existing operator-role check. Customer WorkOS tokens do not grant
staff access. The optional STAFF_WORKOS_* settings remain in the configuration
contract for the earlier flow; the deployed staff verifier does not consume them.
Origins have
no path/trailing slash/wildcard; HTTP loopback is allowed only in local mode.
The WorkOS resource audience needs its separately configured JWT template.
DATABASE_URL must use a Neon hostname, sslmode=require and a non-owner
cp_runtime login (or cp_runtime_ suffix). Only sslmode/channel_binding query
parameters are allowed. Credentials never enter public assets, responses or
logs. Missing/invalid config and unavailable storage return 503 without fallback.

`npm run dev` listens only on 127.0.0.1:8791. An authorized operator may place
local secrets in ignored .dev.vars; none is supplied here. With no configuration,
the local server correctly refuses requests. There is no fake-success dev flag.
workers.dev and preview URLs stay disabled. The one route is the company
account service, accounts.diomedes.net (a custom domain). Incomplete server
configuration answers 503; a configured service still refuses unsigned requests.

## Company staging: accounts.diomedes.net

The Worker serves staging data at accounts.diomedes.net for the Diomedes
Operations app and Nectovia. `wrangler.jsonc` already names the host,
the issuer (`https://api.workos.com`) and the audience
(`https://accounts.diomedes.net`). What needs the owner's accounts:

1. **WorkOS, customers (Nectovia)** (the staging environment, AuthKit on). WorkOS
   brands the sign-in page per environment, so this one carries the Nectovia
   logo and colors (Branding). Register `diomedes-auth://callback`, the exact
   callback in `desktop/native-auth.ts`, on the application whose client ID the
   packaged desktop uses. The old loopback URI `http://127.0.0.1:47319/callback`
   alone does not admit the desktop callback; keep existing entries while adding
   this one. Set the default logout URI to `https://nectovia.diomedes.net`.
   See [WorkOS's Electron integration](https://workos.com/blog/add-authentication-to-your-electron-app-in-three-calls).
   In the access-token JWT template
   (workos.com/docs/authkit/jwt-templates), add
   `"aud": "https://accounts.diomedes.net"`. `aud` is not one of the reserved
   keys; if WorkOS refuses it anyway, stop. Do not remove the audience check. Put
   the client ID (`client_...`, public) in `WORKOS_CLIENT_ID` in both `wrangler.jsonc` files (step 3), and run
   `npx wrangler secret put WORKOS_API_KEY` with the `sk_test_...` key. The
   people who sign in need verified emails.

   **Staff (Diomedes Systems).** The current Operations app creates a device key
   and protects it with the operating system. An authorized database operator
   registers its SHA-256 and staff identity in `control_plane.staff_keys`; the
   raw key stays on the staff member's computer. Registration and operator-role
   admission are separate. Withdrawing the key or revoking its account session
   ends access. Do not create a customer account or configure another WorkOS
   environment as a substitute for this registration. The deployed behavior is
   in `src/identity-staff-key.ts` and `tests/staff-keys.test.ts`.
2. **Neon** (project small-wave-81999606). Make a database `accounts_staging`,
   then migrate it with the owner's direct (non-pooler) URL:
   `CP_MIGRATION_TARGET=staging CP_STAGING_EXPECTED_HOST=<ep-....neon.tech>
   CP_APPROVED_STAGING=yes CP_MIGRATION_DATABASE_URL=<owner URL> npm run
   migrate`. Create the login `cp_runtime`, run `scripts/runtime-permissions.sql`
   as the owner, and run `npx wrangler secret put DATABASE_URL` with
   `postgresql://cp_runtime:<password>@<host>/accounts_staging?sslmode=require`.
   Then create the login `cp_funding` (its own password; `NOSUPERUSER NOCREATEDB
   NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`, no role memberships), run
   `scripts/funding-permissions.sql` as the owner, and run
   `npx wrangler secret put FUNDING_DATABASE_URL --name diomedes` with
   `postgresql://cp_funding:<password>@<host>/accounts_staging?sslmode=require`,
   on the same host and database as `DATABASE_URL`. Only the managed gateway
   uses it, for its credit periods, jobs, holds and settlements. Until it is set,
   every `/managed/v1/*` call answers 503 `route_unavailable` and nothing is held
   or sent; the account routes do not need it.
3. **Deploy.** Merging to main deploys through Workers Builds, which reads the
   **repository root's** `wrangler.jsonc`, not this package's. The two files must
   carry the same routes and vars, and `tests/deploy-config.test.ts` fails the
   build when they differ. The vars ride with the deploy, which is why the client
   ID lives in these files and not in the dashboard.
4. **Staff administration.** Use an existing verified Operations admin to add
   staff after device-key registration. `scripts/bootstrap-admin.ts` is a legacy
   WorkOS-subject bootstrap; it is not a bootstrap for the current device-key
   identity. A fresh deployment with no admin still needs a deliberately scoped
   database-operator bootstrap. Do not make the first customer an admin or
   overwrite existing operator rows to work around this distinction.

## Account readiness before a release

From the repository root, run `node_modules/.bin/tsx scripts/account-readiness.ts`
(`.\node_modules\.bin\tsx.cmd scripts/account-readiness.ts` in PowerShell).
This reads the build's deployment and native callback, then makes four public GET
requests: the service's unauthenticated refusal, the WorkOS signing keys, admission
of the desktop PKCE callback, and refusal of a random unregistered callback. It
uses no secrets, opens no browser, creates no account, follows no redirects, and
returns a nonzero exit code when any check fails. A WorkOS HTTP 302 alone is not
success: an invalid callback also redirects, to `/redirect-uri-invalid`.

This check deliberately leaves real sign-in, email verification, OS callback
delivery, authenticated database writes, organization isolation, refresh,
restart, recovery and sign-out unverified. Complete those with an owned account
and the actual installed app. It does not inspect or migrate Neon. A custom
AuthKit domain requires updating the explicit destination check before this
script will accept it.

Funding writes never run as the Worker login. The managed gateway's run as
`cp_funding`, the separately reviewed role `scripts/funding-permissions.sql`
grants: exactly the statements the gateway's paths execute, which
`tests/funding-permissions.test.ts` checks against the code. The staff routes
still run on the Worker login, so on staging a grant is issued but its month's
included credits are allocated only by the gateway's first call that month, and
a staff funding correction is refused.

## Transaction and schema boundary

AccountService is the portable foundation policy implementation. The PostgreSQL
adapter uses one request-owned @neondatabase/serverless Client WebSocket session
for BEGIN, all parameterized reads/writes and COMMIT/ROLLBACK. Subject and
session transaction locks serialize identity mapping. An organization row lock
serializes invitation redemption, generation changes and last-owner edits.
Identity HTTP completes before SQL begins; expired queued proofs are refused.
No provider/model calls may run inside a transaction. No uncertain COMMIT is
automatically retried. Admission is limited to 100 active workspaces per person
and 1000 active members per organization; retained revoked rows do not count.
Checks run under the existing subject/organization locks before writes commit.
Point membership and last-owner reads allow over-limit accounts to recover;
listing is explicitly paginated rather than silently truncated. Client error
events remain owned through closure. Errors before confirmed closure fail the
transaction; late duplicate notifications after end() resolves cannot escape
as uncaught errors or be reused by another request.

Migrations 001 and 002 create only cloud account and commercial-domain tables.
Cross-tenant commercial references use composite foreign keys. Later funding
amounts are integer micro-USD with JavaScript-safe bounds and reference existing
run/task IDs; there are no operational Task/Run/History replicas. Existing B00
entitlement still resolves to none. The inbox method is an internal future B04
seam requiring prior raw-body signature verification; no webhook HTTP receiver
or Stripe request exists here.

Migration history is versioned/checksummed; the migration folder pins SQL to LF
so Windows and Linux checkouts produce the same hashes. A transaction advisory lock protects
the entire migration batch. DDL and version rows commit together; interruption
rolls back to the prior version. Unknown/changed/gapped history refuses. The CLI
accepts an explicitly approved disposable b01_validation_* database and direct
endpoint, or the pinned `accounts_staging` target described above. It is not a
production migration command.

For the operator-approved real suite set CP_TEST_DATABASE_URL through a secret
channel, CP_TEST_ALLOW_SCHEMA_RESET=yes, and for Neon pin CP_TEST_BRANCH_ID and
CP_TEST_EXPECTED_HOST. Production branch br-old-star-aepf7zk6 is rejected. Then
run `npm run test:postgres`. The test suite drops/recreates only control_plane
inside that explicitly disposable database. It tests empty/prior/interrupted
migrations, concurrency, rollback, tenant foreign keys, duplicate events and
revocation across clients. scripts/runtime-permissions.sql is a review template
for a separate non-owner cp_runtime role; it grants no deletion or DDL rights.
scripts/funding-permissions.sql is the same for cp_funding, the managed
gateway's funding login: SELECT, INSERT and column-level UPDATE on the funding
tables only, each grant cited to the statement that needs it.

## Funded parent-job accounting (NC-2026-09-22.1, code and tests only)

`src/funding.ts` sequences credit funding over migration 003: a month's grant
(from a verified entitlement grant and a published plan grant only), purchased
top-ups (from a verified billing event), root jobs with a finite cap, and one
reservation per paid attempt bound to its tenant, root job, reserving period
and rate snapshot. Money rules, the reservation state table, the reserve
decision and the usage projection live in `shared/managed-usage.ts`. The
protocol is reserve, mark dispatched, provider call with no transaction open,
then settle, mark uncertain or cancel. Unsent holds release; sent holds settle
only from a complete provider usage report or stay uncertain; nothing is
retried by the service. Children and retries spend inside the root cap; a
higher cap needs a request and an owner decision. There is no built-in default
cap: the 20-credit figure is a proposal and must be configured once approved.

The Worker exposes `GET /account/organizations/:id/usage`, which verifies
membership and then reads the projection, and the purchased-usage holds below.
No other funding write is reachable over HTTP. The memory adapter in `tests/support/funding-memory.ts` is TEST ONLY; the
SQL adapter has been checked against a recording client, and its real-database
cases are in the opt-in PostgreSQL suite. Nothing here activates billing, a
plan, a checkout or a funded model call.

## Purchased-usage holds (migration 013, 2026-10-01)

Owner rule: Diomedes staff may reserve allowance; a subscriber may reserve only
against usage the business bought outright (top-ups), never against included
monthly usage. The account service keeps the only purchased balance. A top-up
is recorded from a verified Stripe billing event (`recordTopUp`) and nothing
else; a request never names a balance.

An active member of the business, with their own session, can:

- `GET /account/organizations/:id/purchased-usage`: purchased, held, settled
  and available, in micro-USD.
- `POST .../purchased-usage/holds` `{ holdId, amountMicroUsd, requestDigest }`:
  hold credits. Refused 402 `no_purchased_usage` or
  `insufficient_purchased_usage`, with a plain reason ending "Nothing was
  held." Idempotent by `holdId`: the same terms find the hold, different terms
  are 409 `hold_conflict`, a closed hold is 409 `hold_closed`.
- `POST .../purchased-usage/settlements` `{ holdId, debitMicroUsd }`: debit the
  top-up balance by at most the hold; the rest is free again. A replay returns
  the recorded settlement; a different debit is 409 `settlement_conflict`.
- `POST .../purchased-usage/releases` `{ holdId }`: give an unused hold back.

A hold is a row in `credit_topup_holds`, not a funded attempt: no job, month,
rate or provider call, and it never reads or draws the monthly grant. `topUpTotals`
counts open holds and settled debits, so a funded attempt's reserve sees them
too and the same bought credit cannot be spent twice. Only the person who made
a hold can settle or release it; anyone else's, another business's and an
unknown hold all read as 404 `unknown_hold`. These writes run as the funding
login (FUNDING_DATABASE_URL); without it they answer 503. The desktop calls
them for a person who is not staff (see `server/managed-usage-routes.ts`).

Migration 013 is additive. The runner takes each version from the file name's
number, so it refuses 013 until 011 and 012 are in its list before it.

## Members' monthly credit limits (migration 014, 2026-10-01)

Owner rule: one shared pool per business, included usage first and then bought
credits. Every member also has a monthly limit on how much of it they may use,
always on, reset with the plan period. A limit comes from the member's role
with a per-person override. Owners and admins are unlimited within the pool
unless an owner sets a limit for them. The default for a member is the whole
plan allowance, read in one place (`PLAN_MEMBER_LIMIT_CREDITS` in
`shared/credit-allotments.ts`, empty until tier numbers are decided).

Where it is enforced: `FundingService.reserve`, in the same transaction and
under the same organization lock as the pool and job-cap checks, after the
idempotent replay. The gateway names the verified person and role; a request
never does. Usage is what the person's attempts and purchased-usage holds hold
or have settled in the period (`credit_attempt_people` records whose attempt
it was). A refusal is 402 `member_limit_reached` with a plain reason ending
"Nothing was sent." and nothing is held.

Routes under `/account/organizations/:id/`, each as the signed-in member:

- `GET credit-limits`, `POST credit-limits`, `POST credit-limits/settings`:
  owners and admins read and set limits and who sees what. An admin limits only
  members; only an owner changes who sees what.
- `GET credit-usage/mine`: a person's own usage against their own limit,
  never the pool or anyone else.
- `GET credit-usage/members`: who used what, by member, in micro-USD.
- `POST credit-limit-requests` `{ requestId, kind: 'job'|'month', jobId }`: a
  member asks to go past the limit. The ask names no amount.
- `GET credit-limit-requests`, `POST credit-limit-requests/:id/decision`: an
  owner or admin approves or denies. One job raises that job by its own cap; a
  month needs the approver's `extraMicroUsd`. `allowPurchased` lets the
  approval draw on bought credits and is refused when none are free.

These run as the funding login (FUNDING_DATABASE_URL) and answer 503 without
it. `scripts/funding-permissions.sql` carries the grants for the four new
tables; `cp_runtime` is unchanged. Migration 014 is additive and applies after
011, 012 and 013.

## Runtime evidence and release

`npm run test:runtime` requires CP_EVIDENCE_DIRECTORY and uses local workerd.
It tests the production entry's refusal paths plus real RS256 verification with
offline provider HTTP. It saves a V8 CPU profile and wall timings. Local sampled
V8 time does not certify native crypto CPU, hosted quota enforcement or the
Workers Free 10 ms per-request budget. Real hosted capacity remains a separate
gate, with no automatic paid upgrade.

The parent owns root Wrangler/workflow changes, the desktop foundation extraction,
independent review, live database qualification and publication. No deploy,
secret upload, DNS/account change or spending is part of this package build.
Full B01 and H21 completion are not claimed by this bounded candidate.
