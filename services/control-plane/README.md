# Diomedes account control plane

An independently packaged Fetch service for verified accounts and organization
membership. This B01 subset does not implement payments, entitlement grants,
funded model calls, OAuth login/refresh, remote execution or a cloud task store.
Personal desktop and the separate marketing site do not depend on this package.

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

The **faux cloud** (`src/faux/`) runs this same handler over a JSON store and
local passwords in place of Neon and WorkOS; nothing else differs. `npm run
faux-cloud` serves it on 127.0.0.1:8795 with demo accounts (password
`nectovia-demo`), and the desktop app hosts it itself when nothing answers
there. Faux data only: none of its people, businesses or grants exist.

`npm run faux-cloud -- --identity workos-standin` swaps the passwords for a
local WorkOS stand-in (`src/faux/workos-standin.ts`, under /workos): the AuthKit
authorize (PKCE, loopback redirect, no login page; the person is the
`login_hint` email), authenticate (code and rotating refresh), JWKS, user and
session endpoints. The faux cloud then verifies with the Worker's own
`WorkOSIdentityVerifier`, so the Operations app's company sign-in runs end to
end on this computer. Its store is a separate file, and `POST
/faux/bootstrap-admin {subject}` does what `npm run bootstrap-admin` does
against Postgres.

The faux cloud serves the managed inference gateway (`/managed/v1/*`, contract
`nectovia-managed/1`) with the Worker's own handler. A scripted provider answers
it offline with exact usage; the placeholder key it holds stands in for the
Worker secret `BEDROCK_API_KEY`. Bedrock is called for real only when
`NECTOVIA_FAUX_BEDROCK_API_KEY` is set, which needs Andrew's spend approval
first; with that key set and no readable `MANAGED_SPEND_CEILING_MICRO_USD`,
the faux cloud refuses to start. Two optional spend settings are read from the environment under the
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
WORKOS_TOKEN_AUDIENCE, and server-only WORKOS_API_KEY/DATABASE_URL. Origins have
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
account service, accounts.diomedes.net (a custom domain), which answers 503
until the steps below are done.

## Company staging: accounts.diomedes.net

The Worker serves staging data at accounts.diomedes.net for the Diomedes
Operations app and, later, Nectovia. `wrangler.jsonc` already names the host,
the issuer (`https://api.workos.com`) and the audience
(`https://accounts.diomedes.net`). What needs the owner's accounts:

1. **WorkOS** (staging environment, AuthKit on). Add the redirect URI
   `http://127.0.0.1:47319/callback`; WorkOS allows `http://127.0.0.1` for
   native clients
   (workos.com/docs/reference/authkit/authentication/get-authorization-url/pkce).
   In the access-token JWT template
   (workos.com/docs/authkit/jwt-templates), add
   `"aud": "https://accounts.diomedes.net"`. `aud` is not one of the reserved
   keys; if WorkOS refuses it anyway, stop. Do not remove the audience check. Put
   the client ID (`client_...`, public) in `WORKOS_CLIENT_ID` above, and run
   `npx wrangler secret put WORKOS_API_KEY` with the `sk_test_...` key. The
   people who sign in need verified emails.
2. **Neon** (project small-wave-81999606). Make a database `accounts_staging`,
   then migrate it with the owner's direct (non-pooler) URL:
   `CP_MIGRATION_TARGET=staging CP_STAGING_EXPECTED_HOST=<ep-....neon.tech>
   CP_APPROVED_STAGING=yes CP_MIGRATION_DATABASE_URL=<owner URL> npm run
   migrate`. Create the login `cp_runtime`, run `scripts/runtime-permissions.sql`
   as the owner, and run `npx wrangler secret put DATABASE_URL` with
   `postgresql://cp_runtime:<password>@<host>/accounts_staging?sslmode=require`.
3. **Deploy.** Merging to main deploys through Workers Builds, and the vars ride
   with the deploy. That is why the client ID lives in this file and not in the
   dashboard.
4. **First admin.** Build the company Operations app (`OPS_WORKOS_CLIENT_ID=client_...
   npm run package:company` in diomedes-ops) and sign in once. It refuses you
   and shows your WorkOS user id. Then, with the same pins as the migration,
   run `npm run bootstrap-admin -- --subject user_...`. Sign in again as Admin
   and add everyone else from the Staff tab; each person signs in once first.

Funding writes stay with a separately reviewed role. On staging, a grant is
issued but its month's included credits are not allocated, and a staff funding
correction is refused, until that role exists.

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
accepts only an explicitly approved disposable b01_validation_* database and
direct endpoint; it is not a production migration command.

For the operator-approved real suite set CP_TEST_DATABASE_URL through a secret
channel, CP_TEST_ALLOW_SCHEMA_RESET=yes, and for Neon pin CP_TEST_BRANCH_ID and
CP_TEST_EXPECTED_HOST. Production branch br-old-star-aepf7zk6 is rejected. Then
run `npm run test:postgres`. The test suite drops/recreates only control_plane
inside that explicitly disposable database. It tests empty/prior/interrupted
migrations, concurrency, rollback, tenant foreign keys, duplicate events and
revocation across clients. scripts/runtime-permissions.sql is a review template
for a separate non-owner cp_runtime role; it grants no deletion or DDL rights.

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

The Worker exposes only `GET /account/organizations/:id/usage`, which verifies
membership and then reads the projection. No funding write is reachable over
HTTP. The memory adapter in `tests/support/funding-memory.ts` is TEST ONLY; the
SQL adapter has been checked against a recording client, and its real-database
cases are in the opt-in PostgreSQL suite. Nothing here activates billing, a
plan, a checkout or a funded model call.

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
