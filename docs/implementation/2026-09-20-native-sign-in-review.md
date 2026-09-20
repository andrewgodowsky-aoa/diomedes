# B02.NATIVE independent review

Verdict: **REJECT_SCOPED**. Two reproducible defects prevent accepting this native
sign-in prerequisite. No production fix was made. Full B02 remains OPEN.

## Exact candidate and ownership

- Base and review HEAD: `80263205133c410d590549efd1c8f40cedf33b1c`.
- Frozen manifest: `5307731d3bbc67b1a1c9992aa40ec419cf25472e30b3d99c2298efe764b083c9`.
- Frozen delta: `51243a3d55b39871665897e05d8488ca403442465ac9da9839cf02c55f2735fc`.
- All 17 frozen files matched exact length/SHA256 before and after execution.
  Existing-file base hashes matched Git blobs; delta check passed in an isolated
  index. All four producer build artifacts also matched their manifest hashes.
- Review branch: `feature/native-sign-in-review`; worktree:
  `F:/Diomedes/diomedes-wt/native-sign-in-review`.
- Reviewer task: `01a0bd31-99fe-7bb0-b39c-d6cab5687037`, GPT-6 Astra, independent
  review seat. Parent: `01a0bc8d-c690-75f0-b5d3-eb0d18abe261`.
- Actual process: PID 15040, start `2026-09-20T01:59:06.6870338Z`,
  `Andrews-Desktop`. Claims: `claim_mu9cqnmn_ec02a0c8` (independent test/report
  leaves) and `claim_mu9cu85s_754c8a83` (review evidence).
- Canon: Core Pillars `2026-09-19.1`; roadmap/project memory `2026-09-19.2`.
  The frozen source and producer tests were immutable inputs. No other task's
  review or production work was performed.

## Findings

### P1: The issuer check rejects the documented AuthKit token shape

`desktop/native-auth.ts:240` accepts only `https://api.workos.com` and its
trailing-slash form. That is the API transport origin. WorkOS documents AuthKit
access-token issuers as the base plus `/user_management/<client_id>`; its
Applications documentation says this claim refers to the environment's default
application, while `client_id` refers to the current application.

Reproduction: the two `accepts the documented client-scoped AuthKit issuer`
cases in `tests/native-sign-in-review-independent.test.ts:174` generate RS256
tokens with valid subject, client, session and expiry. The real unmodified
`AuthKitCore.verifyToken` accepts each token against the synthetic RSA JWKS.
The real SDK then serializes the PKCE public-client exchange, receives the same
token, and the production callback returns **false** instead of **true** at line
184. Both trailing-slash variants fail. Other signed-fixture login cases using
the producer's bare-origin assumption pass, isolating the incompatible check.

Impact: a normal documented AuthKit response cannot complete this sign-in
prerequisite. Refresh uses the same wrapped verifier and is also subject to the
check. Configure/validate the intended exact trusted issuer, accounting for the
default-application/custom-domain contract; do not indiscriminately accept
issuers. This is a documentation-backed synthetic compatibility reproduction,
not evidence of the owner's actual live token claims or live provider behavior.
The parent supplied the source lead; the reviewer fetched the sources and
independently executed both reproductions.

Sources: [WorkOS issuer semantics](https://workos.com/docs/cli/emulate#stable-signing-key-and-issuer),
[application claims](https://workos.com/docs/authkit/applications#access-token-claims),
[exact configured issuer guidance](https://workos.com/blog/verify-workos-access-tokens-in-your-own-api).

### P2: Warm callback delivery drops a valid event behind an unrelated one

`desktop/native-auth.ts:88` invokes warm callback handlers without serializing
them. `handleCallback` at line 423 refuses any callback while `handling` is set.
There is no retry or queue for that refused warm event.

Reproduction: start a real SDK ceremony; connect the production capture helper;
emit an unrelated `second-instance` callback followed immediately by the valid
callback. The independently owned test at
`tests/native-sign-in-review-independent.test.ts:435` observes **[false, false]**.
The first callback holds `handling` through its asynchronous state check, so the
valid one is discarded. The same foreign-then-valid sequence before `connect`
passes through the cold-start queue and returns **[false, true]**. This is a
deterministic synthetic app-event burst against production capture/lifecycle
code, not a claim that real OS dispatch timing was exercised.

Impact: overlapping warm callback delivery can leave a legitimate browser
sign-in unfinished. Preserve bounded serialized delivery after connection too,
while retaining the SDK's state binding, expiry and single-use protections.

## Executed evidence

Canonical evidence: `evidence/native-sign-in-review/` in the review worktree;
the final delivery freeze copies the report, independent tests and evidence.

| Check | Result | Evidence |
| --- | --- | --- |
| Exact-lock `npm ci --ignore-scripts --no-audit --no-fund` | PASS; 279 installed packages, all versions match lock; no existing dependency version changes | `npm-ci.log`, `provenance.json` |
| Independent behavior suite | 30 passed, 3 failed, 0 skipped (33 total) | `batch-2-vitest.json`, `batch-2-vitest.log` |
| Unchanged producer native/storage/package tests | 40 passed, 0 failed, 0 skipped | Same run |
| Unchanged workspace/update regressions | 45 passed, 0 failed, 0 skipped | Same run, normalized Git-blob identity in `provenance.json` |
| Combined final focused run | **115 passed, 3 failed, 0 skipped (118 total)** | Same run |
| TypeScript | PASS, exit 0 | `batch-2-typescript.log`, `batch-2-results.json` |
| Vite renderer | PASS, exit 0; existing annotation/chunk warnings | `batch-1-vite.log`, `batch-1-results.json` |
| Original hidden Electron fixture, unchanged | PASS, 15 assertions | `batch-2-producer-smoke.log`, `batch-2-smokes.json` |
| Added hidden Electron fixture | PASS, 28 assertions, including real secondary-window/subframe refusal and encrypted login/reopen/logout | `batch-3-independent-smoke-result.json`, `batch-3-results.json` |
| Actual packaging source fingerprint function | PASS; each native auth input/bundler mutation changes its fingerprint in owned source copies | Independent suite |
| Rebuilt ESM main/CJS sandbox preload | Exact producer artifact hashes | `batch-2-smokes.json` |

Rebuilt `native-auth.mjs`: 984156 bytes,
`bfebfcdb0db8b25ce8250513a2d4d577318937e468862bee9878ea5a9f2cf6e0`.
Rebuilt `native-auth-preload.cjs`: 2685 bytes,
`acfde46a0108382228891c3189aa24c3215ec77102a032fe693a6343bd7d542a`.
Electron binary: 44.2.0, SHA256
`07b043bf9b0a0ac14a82fac0b612b7b7ed13cde727d706d74e41a45278ab51f1`;
embedded Node 24.20.0. Producer binary reused read-only after verification.

The initial run's native suites failed collection because Electron's package
attempted concurrent binary initialization after scripts-disabled installation.
Its 53 collected passes are not added to final totals. Selecting the existing
binary with `ELECTRON_OVERRIDE_DIST_PATH` resolved collection. The first added
independent Electron driver timed out before assertions because it awaited
`app.whenReady()` at module top level; only that new driver was corrected to
register the ready continuation. Historical logs remain preserved. The
corrected driver passed all 28 assertions; its durable JSON is authoritative
because Electron's immediate exit did not flush stdout. Its subframe probe
explicitly enables preload-in-subframes in the test window; shipping main does
not enable that option. The unchanged smoke separately retains production-style
sandbox/context-isolation settings. The
producer's reported red baseline was a collection failure, not a behavioral
failure baseline; its saved record accurately labels that limitation.

## Claims and limits

CONFIRMED within controlled fixtures: encrypted storage/reopen, no plaintext
fallback, strict callback fields, state denial and ten-minute expiry, replay
refusal, main-owned tokens/display-only IPC, exact sender/frame/origin checks,
stale exchange/refresh/sealing cancellation, refresh coalescing, retry after a
transient provider failure, durable-write refusal, offline unconfigured Personal,
unchanged workspace regressions, source fingerprint and bundling.

REFUTED: compatibility of the hardcoded issuer rule with the documented AuthKit
shape, and reliable serialization of overlapping warm callback delivery.
PARTIAL: producer lifecycle coverage proves its fixtures but does not cover these
two missing cases. UNVERIFIABLE here: actual WorkOS/JWKS/audience/revocation,
real system-browser login and cold/warm OS delivery, full packaged app/installer,
account-service binding, membership and Business activation.

All provider responses, JWTs and JWKS keys were synthetic; unit tests execute
real SDK HTTP serialization, PKCE sealing/unsealing and RSA verification with
network fully intercepted. They prove no production identity, audience policy,
key rotation or revocation. Hidden Electron uses owned profiles and synthetic
data; no provider call, protocol registration, installed-app mutation, registry
write, installer, account change, new dependency version or other agent was used.
The package's scripts-disabled install initialized an exact-version Electron
binary inside this isolated worktree; no installed Diomedes binary was touched.

Pillar impact: P05/P09 compatibility and reliability defects remain; identity is
still separate from workspace/billing/execution authority. No definitions changed.
Roadmap: B02 and its live/server gates remain OPEN; no safe prerequisite release.
Build: scoped bundles/renderer built, full application package not run.
Publication/deployment: none. Review tests, report and copied candidate remain
uncommitted; no commit, push or merge was performed.
