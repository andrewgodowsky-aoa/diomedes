# B02.NATIVE.REPAIR independent acceptance, v2

Verdict: **ACCEPT_SCOPED**. The repaired candidate resolves NATIVE-R1 and
NATIVE-R2 within this native sign-in prerequisite. No new blocking finding was
reproduced. Full B02 remains OPEN. This accepts the exact candidate below; it
does not establish live provider compatibility or authorize publication.

## Exact candidate and ownership

- Base and review HEAD: `80263205133c410d590549efd1c8f40cedf33b1c`.
- Repaired source tree: `e2d2fd3b3083504cd8f2999368e3f6f7693c5c87`.
- Candidate manifest SHA256:
  `87f14512a3158bbb0ec962ffe3e5838818408027996849521afd6c7ca5049f93`.
- Complete delta SHA256:
  `90cf71e205b0c04c94547916ef1a97d40a2c7807931e5ffcbd8501831254f7e4`.
- Eight-leaf repair SHA256:
  `5496486bdf52264e14e7cd50dc75b36a5578c3be67a86a0f2a8159ff6cb4b3a6`.
- All 22 repaired files match their frozen lengths, SHA256 hashes and Git blobs.
  Applying either patch to its declared base and reconstructing the 22 source
  files independently produce the same repaired tree.
- Review branch: `feature/native-sign-in-repair-review`; worktree:
  `F:/Diomedes/diomedes-wt/native-sign-in-repair-review`.
- Reviewer task: `01a0bd31-99fe-7bb0-b39c-d6cab5687037`, GPT-6 Astra, requested
  max effort; no other worker. Parent: `01a0bc8d-c690-75f0-b5d3-eb0d18abe261`.
- Process: PID 15040, start `2026-09-20T01:59:06.6870338Z`,
  `Andrews-Desktop`. Review claim: `claim_mu9ezpm9_be361d2a`.
- Canon: Core Pillars `2026-09-19.1`; roadmap/project memory `2026-09-19.2`.

The original 17-file producer snapshot and original 38-file REJECT_SCOPED review
packet remain unchanged, including their manifests. This separate v2 verdict
does not rewrite the original findings or their failed test evidence. Only the
new independent test, this note and review evidence were authored here.

## Findings resolved

**NATIVE-R1, P1: resolved.** Main supplies the required
`DIOMEDES_WORKOS_TOKEN_ISSUER` at `desktop/main.mjs:245`.
`desktop/native-auth.ts:36` validates its configuration, line 180 captures the
value, and line 282 compares the verified token's `iss` to that exact string.
The separate current-application `client_id` check remains. Signature/JWKS,
RS256, expiry, subject/user and session checks remain in force for exchange and
refresh. The issuer does not redirect API/JWKS traffic or enter renderer IPC.

The two original documented-issuer reproductions now pass. Retained and added
tests cover default-application and custom-domain issuers distinct from the
current application ID; missing/malformed configuration; wrong issuer and
wrong client during refresh; and refusal to infer configuration from renderer,
callback or token input. The new review also confirms that later changes to the
caller options or environment cannot replace captured trust. Four differently
spelled but URL-equivalent signed issuers pass raw SDK RSA/JWKS verification and
are then rejected by production's exact comparison.

The owner must still obtain the actual environment issuer from trusted provider
configuration and supply it to main. No live issuer was chosen or observed.
WorkOS describes the issuer's default-application identity separately from the
current application's client ID in its
[application claims documentation](https://workos.com/docs/authkit/applications#access-token-claims),
and documents the scoped issuer shape in its
[issuer documentation](https://workos.com/docs/cli/emulate#stable-signing-key-and-issuer).
[Its verification guidance](https://workos.com/blog/verify-workos-access-tokens-in-your-own-api)
also calls for exact configured issuer matching. These sources establish the
configuration contract, not the owner's live provider state.

**NATIVE-R2, P2: resolved.** `desktop/native-auth.ts:97` now routes cold argv,
early events and both warm event forms into one serial queue. Its bound includes
the active callback: at most four URLs are outstanding. Identical outstanding
URLs are coalesced, and excess arrivals are dropped. Within that declared bound,
the original foreign-then-valid warm reproduction now returns `[false, true]`.

The new review checks mixed cold/warm arrivals at capacity, malformed events not
consuming capacity, retry of a previously dropped arrival, reentrant arrivals
during a thrown handler, disposal and ignored second connection. Real auth
lifecycle tests also prove that a delayed exchange A cannot overwrite a new
login B, canceled queued A cannot prevent following B from completing, queued
state still expires at ten minutes, and different URL spellings for the same
state cause only one code exchange. Generic failure logging contains no callback
or provider error details. Serialization waits for the active handler to settle;
it does not bypass state expiry or cancellation to force queued work to succeed.

## Retained coverage and independently executed checks

Fixture migration was inspected separately from test outcomes. Its only changes
to retained tests supply explicit synthetic issuer configuration. The two issuer
reproductions configure their respective exact issuer, and the retained hidden
fixture uses a custom-domain/default-application issuer distinct from the current
client. This is the new trusted configuration contract, not a signature or claim
validation bypass. All 118 original test identities remain and pass. All 413
collected assertion-call AST expressions across six retained test/fixture files
are unchanged; nested calls are included in that static expression count.

| Check | Result | Evidence under `evidence/native-sign-in-repair-review/` |
| --- | --- | --- |
| Exact-lock scripts-disabled install | PASS; 279 installed packages match lock | `npm-ci.log`, `provenance.json` |
| Original producer and workspace/update cases | 85 passed | `final-vitest.json` |
| Retained first-review cases | 33 passed | `final-vitest.json` |
| Producer repair cases | 30 passed | `final-vitest.json` |
| New independent v2 cases | 15 passed: 7 issuer, 8 queue/lifecycle | `final-vitest.json` |
| Combined named run | **163 passed, 0 failed, 0 skipped; 8 files** | `final-vitest.log`, `final-vitest.json` |
| TypeScript | PASS, exit 0 | `final-results.json`, `final-typescript.log` |
| Vite renderer | PASS, exit 0; existing annotation/chunk warnings | `final-results.json`, `final-vite.log` |
| Retained original hidden Electron fixture | PASS, 15 assertions | `final-smokes.json`, `producer-smoke.log` |
| Retained independent hidden Electron fixture | PASS, 28 assertions | `final-smokes.json`, `retained-review-smoke.log` |
| Source, patches, old packets, assertions and build hashes | PASS | `provenance.json` |

All counts are from this review's final run; no historical runs are added. No
retained test or production input was edited, and no new dependency version was
introduced. The single executable batch acquired heavy slot
`slot_mu9f7x4c_9e303e3a` with `ok: true` and released it in `finally`.

Rebuilt artifacts exactly match the repaired candidate:

- Main `native-auth.mjs`, 984843 bytes:
  `a18bd8a89d5ca35b418afdd6b6525cddb2ffa28be006767d7c3d01f996d27516`.
- Sandbox preload `native-auth-preload.cjs`, 2685 bytes:
  `acfde46a0108382228891c3189aa24c3215ec77102a032fe693a6343bd7d542a`.
- Renderer `dist/assets/index-N6jAXMZz.js`, 709822 bytes:
  `0dc44af915b6ccf7eacb4a8434470f42a34ff7dc9f4c7477216f7f01fb5eebb9`.

Hidden smoke execution reused the hash-verified Electron 44.2.0 binary
`07b043bf9b0a0ac14a82fac0b612b7b7ed13cde727d706d74e41a45278ab51f1`,
with embedded Node 24.20.0 and isolated owned profiles. It exercises the actual
production bundles, SDK, IPC, sender/frame denial, sandbox/context isolation and
Windows safeStorage with synthetic credentials. Unit fixtures use synthetic
AES-GCM storage and app events; their RSA signing, SDK HTTP serialization, PKCE,
session sealing and verification are real. All provider/JWKS responses are local
synthetic fixtures with no network passthrough. No actual provider call, protocol
registration or installed-app mutation occurred.

## Acceptance boundary

This is acceptance of the repaired native prerequisite at the exact frozen tree.
The public-client native flow and display-only account state do not establish
workspace membership, Business activation, entitlements or control-plane trust.
Missing trusted configuration deliberately leaves sign-in unavailable and
Personal usable. Capacity overflow deliberately discards new callback events.

Still OPEN: trusted live issuer/redirect/logout/JWKS configuration; actual
provider sign-in, audience and revocation behavior; system-browser and OS
cold/warm callback delivery; account-service binding, membership and Business
activation; full application gates, packaging/installer acceptance and full B02.
Synthetic runtime evidence must not be described as any of those proofs.

Pillar impact: no definition or authority changes; existing trust boundaries and
shared Personal/Business meanings are preserved. Roadmap impact: no completion
status changes and no prompt marked DONE. Build status: focused checks and
isolated bundles passed. Publication/deployment status: none. All review work
remains uncommitted; no source, provider, registry, installed configuration or
release was changed. The separate frozen result records the review claim release.
