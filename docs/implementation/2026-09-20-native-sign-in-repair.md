# Native sign-in repair: configured issuer and callback delivery

This candidate repairs NATIVE-R1 and NATIVE-R2 from the independent native sign-in
review. It is an uncommitted repair for review; full B02 remains OPEN. The original
producer and review reports, source snapshots and evidence remain unchanged.

Feature: `native-sign-in-repair`. Prompt: B02.I / 25c, bounded node
`B02.NATIVE.REPAIR`. Branch: `feature/native-sign-in-repair`. Worktree:
`F:/Diomedes/diomedes-wt/native-sign-in-repair`. Base:
`80263205133c410d590549efd1c8f40cedf33b1c` (`refs/heads/main` at reconstruction).
Producer: Codex GPT-6 Astra, max effort, under the parent's exact hot-path handoff
`handoff_mu9dytnk_808786b0`. No additional worker was used.

## Required trusted configuration

Electron main now supplies both public configuration values:

| Main-process launch value | Meaning |
| --- | --- |
| `DIOMEDES_WORKOS_CLIENT_ID` | The current application's public client ID. |
| `DIOMEDES_WORKOS_TOKEN_ISSUER` | One exact trusted HTTPS access-token issuer. |

The auth module captures the issuer when it is constructed. Missing or malformed
configuration leaves account sign-in unavailable and Personal usable. No provider,
browser or protocol action occurs for disabled sign-in. The module never infers
the issuer from the current client ID, API transport origin, callback, renderer,
or an unverified token. It never trims or adds a trailing slash for comparison.
The signed `iss` string must equal the configured value exactly; `client_id`
must independently equal the current application ID. SDK signature/JWKS and
temporal validation, RS256, subject/user binding and session checks remain in force.

WorkOS documents that all applications in an environment share an issuer referring
to its default application, while `client_id` names the current application.
See [AuthKit applications](https://workos.com/docs/authkit/applications#access-token-claims).
The documented AuthKit issuer has the base plus
`/user_management/<default-application-client-id>`; see
[issuer documentation](https://workos.com/docs/cli/emulate#stable-signing-key-and-issuer).
Custom domains and exact trailing-slash spelling require configuration; see
[WorkOS token verification guidance](https://workos.com/blog/verify-workos-access-tokens-in-your-own-api).

An authorized deployment owner must verify the environment's actual issuer through
the provider's trusted configuration/discovery and supply that exact value to main.
Do not assume that the desktop application's client ID is the default application's
ID. A decoded token can help an authorized owner inspect configuration, but token
contents do not establish trust or configure this implementation. This repair does
not select or verify a live issuer, change a provider template, or install launch
configuration. The following values are synthetic examples only:

```text
Current application: client_repair_current_application
Default-app issuer: https://api.workos.com/user_management/client_repair_default_application
Custom-domain issuer: https://login.fixture.invalid/user_management/client_repair_default_application/
```

The issuer is a comparison value. It does not redirect authorization, logout,
token exchange or JWKS requests. Those still use the existing SDK WorkOS API
routes and current client ID. There is no issuer allowlist, broad origin fallback,
or change to control-plane audience, tenancy, entitlements or workspace authority.
No token or issuer configuration is added to renderer IPC.

## Callback delivery

Cold argv, early events, warm second-instance events and warm open-url events now
enter the same serial queue. At most four URLs are outstanding, including the one
being handled. Identical outstanding URLs are coalesced; when full, new events are
dropped. Delivery resumes after a handled failure. An unexpected handler rejection
produces a generic native warning with no callback or error details and does not
stall later callbacks. Disposal removes event listeners and drops queued events.

The queue does not authorize a callback. The unchanged parser, SDK PKCE verifier,
state binding, ten-minute expiry, single-use consumption and storage generation
guards still make that decision. A foreign warm callback followed by a valid one
is delivered in order, and a completed callback's replay causes no extra exchange.

## Inputs and evidence

The original producer manifest is
`5307731d3bbc67b1a1c9992aa40ec419cf25472e30b3d99c2298efe764b083c9` (17 files).
The independent review manifest is
`aac8ee1cc7f8207b64ca1371b8597c2f6f2f7dce9f02e4c58de968c207d05e3e` (38 files).
All listed bytes were verified before reconstructing the 20 source inputs into
this clean worktree. Only `desktop/main.mjs` and `desktop/native-auth.ts` change
production behavior in this repair.

Existing test changes only supply explicit synthetic issuer values. The review's
two issuer cases configure their exact respective suffixes. Its hidden Electron
fixture uses a synthetic custom-domain/default-application issuer with a different
current client ID. Original assertion expressions and test identities are retained.
`tests/native-sign-in-repair.test.ts` adds 30 cases covering disabled configuration,
exact default-app/custom-domain issuance, cross-issuer rejection, refresh rejection,
bounded serial delivery, deduplication, handler rejection, disposal and replay.

The new worktree reproduced precisely the independent review's failures before
production edits: 115 passed, three failed, zero skipped out of 118 tests. The
first repair run passed all 118 retained cases and 29 of 30 new cases; the one new
test incorrectly expected an IPC failure instead of the SDK's unauthenticated
state after a rejected refresh. That test now asserts signed-out/null-account state
and that the original expired token remains unchanged. No retained assertion was
weakened. TypeScript passed in that run.

Final verification passed: 148 tests (85 original producer, 33 independent review,
30 new repair), zero failed and zero skipped; TypeScript and Vite exited zero.
Both hidden Electron smokes passed, with 15 and 28 assertions respectively. Static
provenance confirmed that all 118 original test identities passed and every retained
assertion expression is unchanged, all 17 producer and 38 review frozen files are
unchanged, and all 279 installed packages match the exact lock. No existing
dependency version changed. Evidence is in
`evidence/native-sign-in-repair/final-results.json`, `final-vitest.json`,
`final-smokes.json` and `provenance.json`. Installation used the unchanged exact
lock with scripts disabled. Hidden smoke drivers reused the
hash-verified Electron 44.2.0 distribution with separate owned profiles, synthetic
RSA/JWKS responses and actual IPC, sandbox, context isolation and OS safeStorage.
There is no network passthrough to an identity provider and no OS protocol change.
The shared heavy slot is admitted through the pinned coordination tool for every
install or verification batch and released afterward.

## Remaining boundary

Independent acceptance of this repair, real provider configuration/login, OS
protocol integration, an installed app run, full application gates and publishing
remain outside this result. These fixtures do not prove live WorkOS behavior.
Control-plane and workspace authorization work remains separate. No source is
committed, pushed or merged, no provider or installed configuration changes, and
no completion record is promoted to DONE. Pillars 09 and 12 retain their existing
trust and shared-Personal/Business meanings; roadmap and product definitions do
not change. Canonical versions inspected: pillars 2026-09-19.1, roadmap 2026-09-19.2,
project memory 2026-09-19.2.
