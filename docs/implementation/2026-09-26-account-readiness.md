# Nectovia account readiness - 2026-09-26

## Work order

- Feature and work item: NECTOVIA-ACCOUNT-READINESS; customer account setup.
- Request/chat: 01a0dfca-bb45-70d0-85fc-0ebec78527dc.
- Owner: Codex; coordination seat astra, process 18712.
- Branch: feature/nectovia-accounts.
- Worktree: F:/Diomedes/diomedes-wt/nectovia-accounts.
- Base: 5d5a581c464a431e2591fa6d704f952bac3cf541, fetched main.
- Claim: claim_muiylvfz_cc2630fc, limited to this record, the readiness script,
  its regression tests and the control-plane README.
- Verification checkout: F:/Diomedes/diomedes-wt/nectovia-accounts-verification.
  Same base and byte-identical owned files; dependencies match both lockfiles.

The owner authorized advancing Neon, WorkOS and account setup, then authorized
coordination with the existing Neon staging and Nectovia security chats. Their
account-boundary and security implementation stays in those lanes. ORG-01's
organization setup implementation is separately claimed and was not edited.

## Direction

Finish the first usable customer account: browser sign-in, return to the app,
organization setup, and an account menu that can refresh and end the session.
Next, demonstrate one organization-owned project with the correct access grant.
WorkOS identity, organization membership, paid feature access and inference
payment remain separate decisions. Local Tasks, Runs and History retain their
existing authority. This follows Pillars 5, 9 and 11; no product definition changed.

Canonical mirrors inspected: Core Pillars header 2026-09-22.1 with its explicit
2026-09-25.1 amendment; Live Roadmap and Project Memory 2026-09-25.2. The cloud
canonical documents now carry SC-2026-09-26.1; repository mirror PR #161 remains
open. That approved direction does not establish shipped implementation. B01 and B02
remain partially merged in the execution package; this work does not mark them
DONE or establish release acceptance.

## Live configuration repair

The customer WorkOS staging application's allowlist contained only
`http://127.0.0.1:47319/callback`. The desktop actually requests
`diomedes-auth://callback`. Added that exact URI while retaining the existing
default loopback entry. Also set the default hosted logout URI to
`https://nectovia.diomedes.net`, whose public page returned HTTP 200.

The changes were dry-run first and read back after mutation. They affect only
customer staging application `app_01M2CX1J7T00QYWDNSZ0QQBADM`, client
`client_01M2CX1HZ8RDE8EYGG2YCDX39H`, environment
`environment_01M2CX1HNEWYWDQWEE7Z2NXQ0B`. Production and the legacy staff WorkOS
environment were not changed. No API keys or installed credentials were read,
copied, rotated or committed. Email verification remains required, and the
existing JWT template supplies audience `https://accounts.diomedes.net`.

Public requests then proved:

- GET `/account/session` without a bearer returns the expected 401 and no-store.
- WorkOS publishes valid RSA public signing keys for the configured client.
- A fresh PKCE authorize request with the desktop callback reaches the AuthKit
  bootstrap redirect.
- The same request with a random unregistered callback reaches the invalid
  redirect URI page. Both outcomes can be HTTP 302, so status alone is inadequate.

The new read-only script repeats these four checks without following redirects,
retaining login state, creating users or using secrets. It bounds response sizes,
uses request timeouts and keeps provider bodies, redirect queries and raw errors
out of the report. Passing is explicitly `configuration-checks-passed`, not
authenticated or production readiness. A custom AuthKit domain currently fails
closed and requires a deliberate destination-policy update.

## Neon and staff evidence

Read-only inspection of project `small-wave-81999606`, branch
`br-old-star-aepf7zk6`, database `accounts_staging` found migrations 001 through
007 with SHA-256 values matching the checked-out SQL files. The branch's name
is production; that does not change this database's staging purpose.

Both runtime roles lack superuser, create-database, create-role, replication and
bypass-RLS privileges. They have no role memberships, no control-plane table
ownership, and schema usage without schema creation. Their table grants retain
the runtime/funding separation. They currently have INHERIT set, contrary to the
NOINHERIT setup recommendation; no role memberships are available to inherit.
No role or grant mutation was made. Column-level grants were not exhaustively
certified. A role-impersonation query was refused by the Neon connector; no
runtime-login database write is claimed from administrator inspection.

Aggregate counts at inspection: one person, zero organizations, zero memberships,
one active staff key and one active staff admin. The current Operations verifier
checks registered device keys and operator roles; customer WorkOS sign-in does
not create staff access. Corrected the README's obsolete staff WorkOS instructions
and identified its legacy bootstrap command honestly.

## Installed app finding

At the owner's request, opened the existing installed Nectovia through Windows
UI automation. Its About screen reports 0.2.0, and Settings has no Account section
or account initials menu. Current source contains both. This is an installed-build
mismatch, not proof that the current Sign out action is broken. No existing
projects, credentials, Operations session or installation were replaced.

## Validation and remaining proof

- TypeScript: passed against the matching dependency installation.
- Focused tests: 99 passed across six files, including 19 readiness regressions,
  native authentication/storage/packaging, deployment and WorkOS verification.
- Live public preflight: four checks passed again at 2026-09-27T00:03:54.510Z.
- Four gates on base 5d5a581 plus this patch: TypeScript passed; 8,059 unit tests
  passed across 472 files, with four skipped; Vite build passed; all 36 required
  browser tests passed headlessly. Logs are in the verification checkout's
  ignored test-results/readiness-* files.
- An earlier full-suite run was interrupted and is not a pass. The first run
  on 5d5a581 had one unrelated weekly-brief failure: Windows refused an atomic
  run-record rename with EPERM. Its focused eight-test rerun and the complete
  suite then passed without a source or test change. That failure is retained
  in readiness-unit-5d5a581.log; the passing suite is in its -recheck log.
- Isolated faux-account browser lifecycle: passed. A new local test customer
  completed signup and the actual onboarding screens, signed out through the
  account menu, was refused by `/api/settings`, signed in again, and signed out
  through Settings > Account. No uncaught browser errors. The first smoke
  incorrectly expected the account menu before onboarding; correcting that
  smoke sequence required no product change. This is current-source browser
  evidence, not live WorkOS or installed-desktop authentication evidence. It
  passed again headlessly on the 5d5a581 source after the release was installed.
- Real customer signup/email verification, actual token issuer/audience, native
  OS callback, authenticated Neon writes, session restart/refresh, password
  recovery and hosted logout: not yet proven.
- Independent read-only review found no credential exposure or high-severity
  false pass. Its documentation finding was corrected: the legacy faux WorkOS
  staff flow does not prove current Operations device-key sign-in. The README
  also now limits automatic faux-cloud startup to source/development use and
  names the separate explicit test mode.

No provider inference or paid request was made. The readiness checks do not
establish authenticated customer operation or completed-prompt acceptance.

## Authorized release testing

The owner subsequently explicitly requested publishing 0.2.1 and updating the
installed app to test sign-in, accepting that real customer sign-in had not yet
been proved and reporting that no other customers use this release. This removes
the live-sign-in prerequisite for this publication; it does not turn stand-in
tests into real sign-in proof.

The superseded release run 36244385829 at c5eca16 was cancelled: its source did
not include the owner's requested PR #164. Fresh release run 36278800377 built
5d5a581c464a431e2591fa6d704f952bac3cf541, which includes PR #164's recorded business
owner enforcement and PR #165's unavailable-provider wording. All four release
gates passed, with 8,041 unit tests across 471 files and 36 browser tests.
Windows packaged smoke, installer install/repair/uninstall, installed-runtime
smoke and hosted Apple-silicon disk-image launch passed. The draft was published
at 2026-09-26T23:43:58Z after its source, manifest, checksum list and GitHub asset
digests were reconciled. It is the latest stable-channel update, still labeled
experimental and unsigned. No verification gate was disabled. These release results
cover the named source commit. The readiness utility was added after this release.

The owner subsequently requested headless work only. Desktop control remained
stopped. With no installed app process running, the verified installer completed
a silent in-place upgrade at 2026-09-26T23:50:50Z (exit 0). The installed registry
and embedded package report 0.2.1; BUILD_INFO identifies 5d5a581 and the release
source digest. The installer retired the owned Diomedes.exe and installed
nectovia.exe. Installed hashes match the published manifest:

- Installer: aae489c60a34f9fa23586be77f48b6473022c0854f8d2814c98d1c841c4bf038.
- Executable: 7e57734de2704f5ec4a7249299cb58c263608d1a5ff48094bc215873afc8d766.
- app.asar: 75f983af272a02fea3331878d1258be078081ec15e4d311a516865d241d22b94.

The upgraded installed app was not launched. A normal launch and real customer
sign-in remain open; headless source tests do not establish that result.
