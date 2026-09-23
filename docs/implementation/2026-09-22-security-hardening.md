# Security hardening pass, 2026-09-22

Work order `SECURITY.HARDENING`: owner Codex, branch `feature/security-hardening`,
worktree `F:/Diomedes/diomedes-wt/security-hardening`. Based on product `main`
`cf40cd659ef6560e17d1fbc7ec5a384f4260c320`. The separate website change is
in `F:/Diomedes/diomedes-site-wt/security-hardening`, also on
`feature/security-hardening`. This is an ad hoc security pass, not completion of a
numbered execution-package prompt.

The repository mirrors consulted were Core Pillars `2026-09-19.1`, Live Roadmap
`2026-09-19.2`, and Project Memory `2026-09-19.2`. The unsigned warning was
excluded at the owner's request.

## Data and authority boundaries

| Boundary | Current fact | Impact if crossed |
| --- | --- | --- |
| Desktop renderer to local service | Packaged Electron loads a service bound to `127.0.0.1` on an ephemeral port. This patch adds a 256-bit per-launch token, injected into that window's local requests by Electron and checked before general routes and SSE. | Other local processes can otherwise read projects, account state and settings or invoke writes through the loopback API. |
| Team helper to local MCP | Each helper has a project/slot bearer token. The MCP route has its own loopback and bearer check; it does not use the desktop session token. This patch denies a stopped helper's bearer token. | A stopped helper previously retained all MCP tool access while appearing stopped. |
| Local project to AI provider | A cloud model route can receive a message, earlier conversation context and content read from selected source files. The route is explicit, but there is no complete per-field egress policy or real-provider evidence. | Sensitive owner information can be sent to the chosen provider. |
| Account and update services | Desktop account sign-in uses the configured WorkOS issuer and `api.workos.com`. A person-triggered update check contacts the GitHub release API; installer download follows a bounded, verified release path. | Account sign-in necessarily sends identity/session data to WorkOS; update checks expose network metadata and the app user agent. These routes do not need project document contents. |
| Local credentials and drafts | Model API credentials and account sessions use the Electron OS storage bridge and reject the `basic_text` backend. This patch seals team tokens through the same bridge in the packaged desktop and migrates their prior plaintext file on first read. Unsaved document and composer drafts still use renderer `localStorage`. | Legacy backup copies can retain old team tokens; a stolen profile can disclose draft content. |
| Website form to cloud | The website stores form data in Cloudflare D1 and sends a notification through Cloudflare Email or optional Resend. The site PR removes the hardcoded personal recipient and requires a configured destination. | Form data is not local-only. A wrong recipient or copied notification discloses PII. |
| Release link to executable | The site PR pins a download link to this repository, exact release tag and filename and refuses query/userinfo/object-host substitutions. Mac remains development with no artifact URL or download control. | A wrong link could direct a customer to an unrelated executable. |

## What this patch enforces

- The packaged desktop's local API rejects requests without its per-launch
  token, including the event stream. The token stays in Electron main-process
  memory and is not exposed to renderer JavaScript. A renderer-supplied copy is
  removed before Electron adds the real header only for its app window and
  local origin. Direct `npm run service`/`start` refuses to expose the
  unprotected browser service. `npm run dev` sets an explicit development-only
  override and should use test data.
- Built renderer pages receive a restrictive CSP: scripts and connections are
  same-origin; frames, objects, workers and forms are disabled. Vite development
  uses its normal HMR policy.
- Common credential files and directories are refused by the project-file
  boundary before they can become source context, including Diomedes' own
  team, connection and native account storage files. This is a defense in depth
  filter, not a content scanner: secrets in ordinary allowed files can still
  enter a selected cloud route.
- A stopped team's bearer token is refused before MCP tool dispatch, and
  credential comparison uses fixed-length constant-time comparison. MCP also
  applies the Host/Origin boundary, returns the same 401 for an unknown
  project and invalid bearer, rechecks a helper after token-file I/O and at
  each durable tool action, and keeps a stopped status terminal against late
  native run updates.
- In the packaged desktop, team bearer tokens are sealed at rest through the
  existing OS-backed storage bridge. Reading an old plaintext token file
  replaces it atomically with sealed bytes before returning its contents.
  Unavailable or mismatched OS storage refuses token use and token writes.

## Open security work and acceptance boundaries

1. **Cloud egress control (high).** Build a reviewable per-turn record of the
   exact route and source scope before model dispatch; add explicit owner
   controls for sensitive source classes and make the cloud/local distinction
   visible in the same authority flow. Test with a provider stub first, then
   verify with a real provider account. The current source guard catches common
   key filenames but cannot identify credentials embedded in normal documents.
2. **Existing team token copies and revocation (high).** The packaged desktop
   now seals the active token file, but backups, sync copies and old disk
   sectors can retain pre-migration plaintext. The standalone development
   service has no OS box and retains plaintext test tokens; it must not be used
   with owner data. Stopping a helper denies its credential at the MCP route,
   while the token remains in protected storage for possible recovery paths.
   Design explicit removal/rotation and backup handling before claiming full
   at-rest or revocation coverage. Hash-only storage would break helper launch.
3. **Drafts and local data at rest (high).** The editor and composer preserve
   full unsaved text in Chromium `localStorage`. Design an OS-protected draft
   store with crash recovery and migration. Project state and history remain
   local plaintext by product design; decide at-rest protection and backup
   policy before claiming security for a stolen disk or profile.
4. **Native engine boundary (high).** An installed external CLI/model or local
   model process can have its own network behavior and account cache outside
   Diomedes. The local service cannot guarantee that process stays offline.
   Engine routing, account inspection and filesystem scope need on-device
   verification with real installations and accounts.
5. **Desktop runtime proof (high).** The token middleware has real HTTP tests
   and CSP has a built-page browser probe. A synthetic Electron 44 helper
   exercised the same header hook: a direct local request got 401, and renderer
   navigation, fetch, a forged renderer header and EventSource succeeded only
   through Electron's injected token. This does not exercise the packaged
   application. Run the same cases against a fresh installed Windows build,
   including an untrusted same-user loopback client.
6. **Mac runtime and download (high).** The shared source has a macOS account
   storage path that rejects insecure storage, but Keychain persistence,
   account switching, helper process behavior and the packaged loopback/CSP
   flow have not been exercised on macOS. Mac packaging has source support but
   no release artifact or download. Electron documents that a consistent Mac
   code signature matters to Keychain continuity across app updates; this is
   an account-reliability constraint beyond the ordinary unsigned warning.
   The current packager deliberately blocks Mac packaging pending review of
   its automatic Framework signing and ASAR integrity behavior. Keep the site
   target in `development`
   until an installable artifact, checksum, exact-tree gates and real Mac smoke
   evidence exist. A future Mac link must be updated deliberately if its
   release repository differs from the product repository pinned by the site.
7. **Site deployment configuration (high).** The site change expects a verified
   Cloudflare Email Routing destination and a matching `NOTIFY_TO` Worker
   secret. Those settings and actual delivery are not verified here. A form
   still stores its D1 row when email fails, reporting the delivery failure.
   Do not deploy the site change until both routes and the privacy wording
   match the live configuration.

No live provider API, Cloudflare deployment, Windows installed-app smoke or
Mac device acceptance is asserted by this record. Passing source/unit/browser
checks establishes source behavior only for the tested tree.

Electron references for the desktop boundary:
[webRequest](https://www.electronjs.org/docs/latest/api/web-request),
[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage),
[security](https://www.electronjs.org/docs/latest/tutorial/security), and
[Mac code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing).
