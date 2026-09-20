# Native workspace sign-in prerequisite

## Work order

- Feature: native-workspace-sign-in; prompt: 25c / B02.I, bounded prerequisite.
- Base: `80263205133c410d590549efd1c8f40cedf33b1c` (`refs/heads/main`).
- Branch: `feature/native-workspace-sign-in`.
- Worktree: `F:/Diomedes/diomedes-wt/native-workspace-sign-in`.
- Owner: Codex Astra, implementation seat; parent task
  `01a0bc8d-c690-75f0-b5d3-eb0d18abe261` owns integration and publication.
- Process: PID 15040, started `2026-09-20T01:59:06.6870338Z`.
- Canonical versions: Core Pillars 2026-09-19.1; roadmap and project memory
  2026-09-19.2.
- B02 remains OPEN. No account-policy, provider, installed-app or production
  configuration changes are authorized in this lane. No commit or publication.

## Implemented boundary

Use the official `@workos/authkit-electron` 0.1.2 SDK and its documented advanced
composition API for system-browser PKCE, token refresh, and encrypted persistence.
Diomedes supplies callback validation, renderer identity/origin checks, sanitized
display state, and cancellation of obsolete asynchronous session writes.

The native callback is exactly `diomedes-auth://callback`. Only the launch's
`http://127.0.0.1:<assigned-port>` main frame may call authentication IPC. Tokens
remain in the main process. SDK organization claims grant no local workspace
membership, permissions, entitlement or billing authority. Personal stays usable
without sign-in, network or secure storage.

Changed paths: `desktop/main.mjs`, `desktop/native-auth.ts`,
`desktop/native-auth-storage.ts`, `desktop/native-auth-preload.ts`,
`shared/native-auth.ts`, `client/console/NativeAccount.tsx`,
`client/console/Workspaces.tsx`, `scripts/build-desktop-auth.mjs`,
`scripts/package-desktop.mjs`, `package.json`, `package-lock.json`,
`tests/native-auth.test.ts`, `tests/native-auth-storage.test.ts`,
`tests/native-auth-packaging.test.ts`, `tests/fixtures/native-auth-smoke.mjs`,
`vitest.config.ts`, and this record. Integrator handoffs
`handoff_mu9bizke_23121425` and `handoff_mu9blg6k_fb3d100b` cover the shared hot
files. The test config inlines the real ESM Electron SDK so the native Electron
API can be replaced by unit fixtures; it does not replace the SDK itself.

The immutable account-service interface inspected at
`b52e9dd248e806831aec5f03f2702a9a9d221243` requires a verified issuer/subject,
client ID and resource audience. Its verifier intentionally rejects default
WorkOS tokens without an `aud` claim. Configuring the resource audience in the
provider's JWT template belongs to the parent; this lane does not relax or copy
the account policy. Full server-backed account binding is a later integration.

## SDK composition and activation

The exact direct dependencies are `@workos/authkit-electron` 0.1.2,
`@workos/authkit-session` 0.6.0, `@workos-inc/node` 10.13.0 and `electron-store`
11.0.2 (already the Electron SDK's backing dependency). Public exports compose
the SDK's Core, Operations, session manager, system-browser ceremony, storage,
deep-link capture and IPC handlers. The documented `/internals` export is used;
there are no unsupported package file imports or custom OAuth implementation.

SDK 0.1.2's stock IPC does not check senders, and its deep-link filter only checks
the scheme. The wrapper checks exact main-frame/WebContents identity and the
launch origin before and after each IPC operation, rejects caller options and
token/organization channels, and only publishes display state. The official
preload is bundled to CJS. Its SDK token methods return a refusal; it exposes no
generic invoke/send capability. AuthKit React bindings are deliberately not used
because their payload includes the access token.

Configure only `DIOMEDES_WORKOS_CLIENT_ID` in the trusted main-process launch
environment. No API key is read. Missing/invalid configuration and unavailable
secure storage leave Personal available. Each public client has a separate
`diomedes-native-auth-<client-id>` encrypted store under the app's profile. Linux
`basic_text` is refused. The SDK protects sessions, the sealing password and
pending state using OS safeStorage. The adapter permits one pending ceremony,
retains SDK single-use/ten-minute expiry behavior, and invalidates asynchronous
writes on logout/new sign-in. Storage failures refuse further use in that process.

Registration occurs only on an explicit configured sign-in. The production
default calls the SDK's protocol registration; all tests inject a refusal or
fixture registration. Browser destinations are confined to
`https://api.workos.com/user_management/authorize` and
`https://api.workos.com/user_management/sessions/logout`. The native callback
must have exact scheme/host/empty path, bounded fields, no credentials/fragment,
no duplicate or unknown parameters, and one state-bound code or denial.
The parent owns provider registration and logout destination configuration.
Main-process exchange needs no renderer CORS origin.

SDK JWT signature verification is additionally constrained by the app to RS256,
the WorkOS API issuer, the configured client, expiry and matching provider
subject. This is native display validation; it does not implement or replace
server resource-audience verification, fresh revocation checks, membership,
entitlement, account-service subject mapping or workspace activation. Local
logout clears the session; ending the hosted browser session remains the SDK's
best-effort action and is not a claim of confirmed remote revocation.

## Verification and delivery

Evidence directory:
`F:/Diomedes/deliverables/continuation-20260920/native-workspace-sign-in/`.

- Before implementation, the new focused test files failed collection because
  the native-auth modules were absent. The initial run also exposed the SDK ESM
  test-loader issue; after the narrow config fix, both failures were missing
  implementation modules. This was collection failure, not a behavioral test
  count. `red-baseline.json` records the observed boundary and commands.
- First implementation run: 36 focused tests passed; TypeScript and Vite passed.
- Final run: **85 passed, 0 failed, 0 skipped** across five files: 32 native auth,
  5 storage, 3 packaging, 24 unchanged workspace and 21 unchanged desktop update
  tests. Command: `vitest run tests/native-auth.test.ts
  tests/native-auth-storage.test.ts tests/native-auth-packaging.test.ts
  tests/workspaces.test.ts tests/desktop-app-updates.test.ts`.
- `tsc --noEmit` and `vite build` exited 0. Vite retains dependency annotation
  and bundle-size warnings. Packaging tests executed the actual shared bundler
  and evaluated the CJS preload with only Electron's permitted sandbox API.
- Actual hidden Electron smoke: **15 assertions passed** using an owned profile,
  the built ESM/CJS modules, real IPC, sandbox/context isolation and actual Windows
  safeStorage ciphertext persistence/reopen with synthetic tokens. The driver is
  `tests/fixtures/native-auth-smoke.mjs`; build with `buildDesktopAuth(root, stage)`
  and invoke the owned Electron binary with that driver and a
  `.desktop-stage-native-auth-*` folder. No provider call or real protocol
  registration occurred. Observed Electron 44.2.0, embedded Node 24.20.0; host
  build/test Node 22.23.2. The fixture does not test the full app or a real login.
- SDK PKCE generation, sealing, unsealing and lifecycle were real in unit tests;
  code exchange and signature/JWKS acceptance were explicit injected fixtures.
  Issuer/client/algorithm/expiry/subject refusal tests do not constitute live
  provider or JWKS-rotation proof. The original workspace/update tests are unchanged.
- Built renderer scan found no fixture secrets, PKCE verifier, API key or client
  secret markers. Synthetic native logs and IPC carried no session tokens.
  `candidate/manifest.json`, `candidate/delta.patch`, and `result.json` freeze
  exact paths, hashes, dependency versions and the reconstructable candidate.

Implementation and focused validation: passed for this prerequisite.
Independent review, real system-browser login, real OS cold/warm callback
delivery, full B02 server/live acceptance and full packaged application proof:
not run. No installer, release, deployment, provider/account mutation, commit or
push. Parent integration must preserve its other packaging additions when
combining this patch with newer candidates.

Pillar impact: advances 05 (self-setup) and 09 (separate identity/credentials and
authority) within the stated evidence boundary. No pillar definitions changed.
Roadmap impact: B02 remains OPEN; this record is neither independent acceptance
nor a safe-prerequisite release. The parent may release the exact subset after
independent review.

Sources: [WorkOS Electron SDK 0.1.2](https://github.com/workos/authkit-electron/tree/v0.1.2),
[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
