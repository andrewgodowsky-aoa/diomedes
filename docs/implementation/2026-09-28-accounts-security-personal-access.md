# Account security with Personal access

Status: composed security audit passed all 52 cases. Covering checks then found three stale positive admission fixtures (37/40 passed); root TypeScript is UNRUN. Acceptance remains pending.

Base: `1af37e085ef24fc6c92d6b2b8510fc52a504bd1b` (PR176, Individual plans).
Branch: `feature/accounts-security-personal-access`.
Worktree: `F:/Diomedes/diomedes-wt/accounts-security-personal-access`.
Owner: account-security author chat `01a0e576-9c35-75f3-bc22-692c7f3b093d`, under the architect's queue.
Claim: `claim_mul5ovgr_bfcae244`, limited to this report, its evidence directory and the new test file.

The three canonical documents remain version `2026-09-27.1`; their blobs and the runtime verification/changes documents match the preserved security branch. This candidate changes no product definition or roadmap completion status. It is not merged, published, deployed or accepted.

## Why this candidate exists

The earlier security branch has the complete guarded session lifecycle through `8adcb9d`, with its latest original N2 evidence saved at clean `609305de3e6b3ee4e13eec29b13adccfd6ec311b`. Those changes are not on this new main base. PR176 adds person-scoped access and nullable Personal admissions, which must survive later composition. Copying only the final seven-line N2 repair would omit the earlier lifecycle protections.

The architect authorized test-only Personal regressions first, with no production repair before an original failing run is reviewed. All production files here still equal the exact main base. Old security source/test claims remain in the preserved worktree; the production handoff to this new lane has not happened.

## Prepared cases

`tests/accounts-security-personal-access.test.ts` has seven statically enumerated rows. This is a source inventory, not an executed test count.

| Rows | Boundary and observable contract |
| --- | --- |
| 2 | Hold a genuine Personal access response during refresh, sign out, and sign in again as the same or another person. Both replacements have a real new stand-in SID. The old refresh must refuse with 401/sign_in_required, preserve the replacement bearer/access, and emit no replacement projection. |
| 1 | With no replacement, the delayed reply updates the person's access and projects that refresh exactly once. |
| 1 | Change only the person pin in an otherwise genuine Personal admission. Refuse it, do not cache it, re-ask on dispatch, and accept a later correctly pinned response. |
| 1 | A genuine matching Personal admission is accepted and reused for a fresh same-work dispatch. |
| 2 | Business pins cannot satisfy Personal work, and null Personal pins cannot satisfy business work. Both refusals must remain uncached; a subsequent correctly scoped answer succeeds. |

These fixtures use the real in-process account handler, commercial service, client and session, with the WorkOS stand-in for genuine signed identities. No real provider, database, installed app or customer account is involved. A global fetch refusal prevents accidental external requests. Owned temporary directories are removed after each case.

The delayed access barrier captures a real response and records its status, person and original bearer before holding delivery. The test verifies the barrier was reached and releases it in `finally`. Revoking the old grant before replacement gives the new sign-in different access, including for a same-person replacement. The identity port clears its local kept token on sign-out; this fixture makes no claim about live WorkOS revocation.

Admission fixtures record the original service response and assert its validity outside the intercepted call, where the session cannot swallow a fixture assertion as an ordinary service refusal. They mutate only the intended person or organization pin. Existing Individual eligibility, free/unknown/legacy-response, managed-route and sole-proprietor tests remain unchanged for subsequent covering verification.

## Frozen inputs and requested execution

`accounts-security-personal-access/original-red-freeze.json` records all 15 source/test/configuration hashes. Session working-byte SHA256 is `2c1c4faa68968fcd93eaa179200dedb7051d063555306b71f1dec974d782d806`; new test SHA256 is `3fa9cb5cf0cb2928d62b77ff4ee981162db63a54e7b0bb5a1e436c8172b98471`.

The architect directed separate lockfile-matched installs in this worktree, after the connector window, instead of sharing another checkout's dependencies. The three requested commands are:

1. Root `npm ci --ignore-scripts --no-audit --no-fund`.
2. Control-plane `npm ci --ignore-scripts --no-audit --no-fund`, needed for the imported Neon dependency.
3. Root `vitest run tests/accounts-security-personal-access.test.ts --maxWorkers=1 --minWorkers=1`.

The prepared `verify.ps1` runner requires an exact candidate and own slot, checks all frozen inputs before and after each command, clears the live test database target, and records original output, exit, times and hashes. It is not invoked merely by this document. No dependency installation, collection, test, typecheck or production change has run in this new worktree yet. Expected source-derived failures are hypotheses until original output is read; setup errors and timeouts are not reproductions.

## Remaining work

After the architect reviews original RED/control evidence, formally hand off the owned production scope and compose the complete earlier session lifecycle delta with PR176. Preserve Personal access, nullable admissions and all 45 earlier audit cases. Repair only reproduced remaining failures, then run the new cases and selected existing Individual/admission controls under a separate grant. Broader coverage, independent hostile review, the other 16 old v6 mutation proposals, exact composed-head gates and any later merge/publication remain separate open work.

## Runner preflight correction

The architect granted the three-command window on clean `41b1a02ead34c4848aa4210bd7df73e37ac5d9c3`. Own slot `slot_mul6b7ie_ed1b31c0` was acquired at 11:37:50.534Z, but the runner refused its slot guard before starting npm or opening the command log. The outer controller released the slot successfully at 11:38:15.953Z. No dependency directory, install log, test execution or production change resulted.

PowerShell's `ConvertFrom-Json` materialized `owner.processStart` as a `System.DateTime`. Passing that value to `DateTimeOffset.Parse(string)` first formatted it as a string and lost fractional precision. Reading the actual released slot record reproduced a false comparison through Parse and a true comparison through a direct DateTimeOffset cast. The one-line runner correction preserves the typed timestamp; slot ID, role, host, PID, worktree and exact instant checks remain required. This is verification setup correction, not RED evidence or a product repair. `preflight-original-red-runner.json` records the attempt; no command log is claimed for a command that never started. The 15 frozen source/test/configuration hashes remain unchanged. A separate retry grant is requested.

The architect requested explicit raw-string handling and an off-slot ownership check before retry. PowerShell 7.6.5 supports `ConvertFrom-Json -DateKind String`, so the final runner uses that option and compares parsed UTC ticks. A read-only check of the released own-slot sample accepted its exact timestamp and its equivalent trailing-zero spelling; changing PID, role, host, worktree, process-start instant or slot ID was refused in each of six controls. These eight predicate checks passed without acquiring a slot or running npm, application code or tests. All 15 frozen hashes still match.

## Original Personal RED/control, 2026-09-28

The architect reviewed the corrected runner and granted the same three-command window on clean `5c5d3e61d1f8e50896f5bbd7465606603ecd3e25`. Production still equals base `1af37e0`; the test file still has the original `3fa9cb5c...` working hash. Own slot `slot_mul6gmw6_52c63bc0` was acquired at 11:42:03.750Z and released successfully at 11:43:36.133Z. The pinned journal records acquisition/release at lines 1301 and 1303; slot history line 961 records the complete ownership window.

| Original record and log | UTC start to finish | Result |
| --- | --- | --- |
| install-root-original-red | 11:42:16.7814829-11:42:28.0044056 | Locked install succeeded, 427 packages, exit 0. |
| install-control-plane-original-red | 11:43:04.7355931-11:43:07.8565396 | Locked install succeeded, 108 packages, exit 0. |
| red-personal-original-main | 11:43:32.3818648-11:43:35.4565844 | Three intended assertion failures, four passed, no skipped cases, seven total; original exit 1. |

All 15 frozen input hashes matched before and after each command. Every command ran separately and its originals were read before advancing. The two dependency installs used the existing lockfiles without lifecycle scripts, audit or funding requests; no package declaration or lockfile changed.

Both replacement rows reached test line 173 and returned a refresh projection instead of the required 401/sign_in_required refusal. Their real held response, original bearer, included old grant, actual new native SID and token, same/different person, and replacement access-not-included preconditions all passed. The later current-person, bearer, access and projection assertions were not reached in these red rows, so this run does not establish those downstream preservation claims.

The wrong-person admission row reached line 223: the session returned `admitted: true` instead of `entitlement_unknown`. Before that assertion, the test confirmed a real 200 admitted service answer pinned to the signed-in person's null Personal scope, then changed only its person pin. The later request count, uncached dispatch and correct-answer recovery assertions were not reached for this row.

The four controls passed: unchanged delayed refresh with one projection, correctly pinned Personal admission with cache reuse, business pins refused for Personal work, and null Personal pins refused for business work. Both scope controls confirmed fresh service requests on dispatch and success after restoring correct pins. There were no setup errors, hangs, timeouts or parse errors counted as RED.

Only the three granted commands ran; no production repair, lifecycle composition, typecheck, existing Individual covering suite, mutation or broader gate followed. The originals were sent to the architect and independent reviewer for reconciliation. The old security branch remains clean at `609305d`; source/test handoff and composed-candidate acceptance remain pending.

## Complete session composition and reproduced repairs

The architect independently reconciled the original three failures/four controls and authorized transfer and repair. The old clean `609305d` worktree remains locked and unchanged. Old source claim `claim_mukvkpr2_a99794d0` and grouped test/docs claim `claim_mukvkkfd_a33f5ff0` were released with explicit transfer notes. New-main claims are `claim_mul6m9n7_80550d8a` for session.ts and `claim_mul6nf6i_8d4a47ae` for the historical root audit test; the Personal test/docs claim remains held. The pinned journal records this handoff at 11:47:41.123Z. No verification slot was held during the edits.

The complete `66334d5..8adcb9d` session delta applied without conflicts: 180 added/62 removed lines. It retains Current ownership, serialized remembered writes, pending sign-in cancellation, SID-bound native renewal, scoped Forget, per-cleanup closing markers and N2 stable native re-reads. Before adding new guards, the composed session blob was `ace30f28da22eec5746a920844c4bf71e96aca6d`. A read-only comparison found the exact ordered added/removed-line payload of main's Personal delta retained: the same 55 added/14 removed lines as `66334d5..1af37e0`, with no extra difference versus the old security source. This is source composition evidence, not runtime proof.

Only the two reproduced Personal boundaries were then changed:

- After `reload()` awaits access loading, assert that its captured Current is still installed before constructing or publishing a refresh projection.
- Capture the initiating Current in `admitAgent()` and require the returned admission's person pin to match its person ID, in addition to the existing nullable organization-scope check. An unreadable answer follows the existing refusal/uncached path.

Final source delta versus new main is 188 added/68 removed lines in session.ts only. Personal access reads, Individual plan behavior and nullable Personal routes remain present. Individual migration 009, staff/commercial implementations and all other owners' account/routing files are unchanged. The exact historical 45-case audit was imported through apply_patch: Git blob `09559956881960bb32f49166a3c2f43dbdc8a9ae`, matching old `609305d`, and working SHA256 `bad22282cbf598ec5226587786ec214c5a151c25ebc608018a61efa4152335ce`. The seven new test cases remain unchanged at `3fa9cb5c...`.

Prepared source SHA256: `2307ed7db08887e04926c595db5722beefa3629e8b1d3fcc239fa640e6881b19`. `composed-green-freeze.json` binds the 16 source/test/configuration inputs. The runner now accepts an explicit freeze filename so original RED inputs remain immutable. Proposed next commands, each serial and separately inspected under a future architect grant:

1. `vitest run tests/accounts-security-personal-access.test.ts tests/accounts-security-audit.test.ts --maxWorkers=1 --minWorkers=1` (52 statically enumerated cases).
2. `vitest run tests/individual-plan.test.ts tests/agent-admission-answer.test.ts --maxWorkers=1 --minWorkers=1` (existing Individual and admission controls).
3. `tsc --noEmit` at the root.

All three are UNRUN on the composed source. Source inspection found that some legacy positive admission fixtures use synthetic `person_1`; any resulting covering failure must be reproduced and corrected in the fixture under its own claim, never by weakening the person guard. The independent reviewer agreed with the two proposed boundaries; applied-source review and fresh verification remain required. This candidate is not merged, pushed, deployed or DONE.

## Composed audit GREEN and covering stop

The architect reviewed the applied diff and all 16 hashes on clean `38fd5648e1b5c630f0b045f72d5b4bda10ce9785`, found no concrete blocker to the bounded gate, and granted the three serial commands. Own slot `slot_mul6vagk_137f56a0` was acquired at 11:53:27.477Z and released successfully at 11:54:19.659Z after the second command failed. Journal lines 1317-1318 and slot-history line 964 bind the window. All 16 source/test/configuration hashes matched before and after each command.

| Original record and log | UTC start to finish | Actual result |
| --- | --- | --- |
| green-personal-and-audit-v1 | 11:53:42.1328208-11:53:49.8316752 | All 52 passed (45 historical audit, seven Personal), no skips/failures; exit 0. |
| covering-individual-admissions-v1 | 11:54:14.3941796-11:54:18.9880911 | 37 passed, three failed, 40 total, no skips; exit 1. |

The seven Personal cases now reach the assertions that original RED stopped before: replacement current identity/bearer/access and projection preservation, wrong-person refusal followed by uncached re-asking and correct-answer recovery. The unchanged historical 45-case audit also passed on these composed bytes. This is author-executed offline verification, not independent execution or full application acceptance.

The covering run passed all 16 existing Individual cases and 21 of 24 admission-answer cases. Three synthetic positive admissions were refused: cache replacement at line 127, the 60-second cap at 177, and the shorter expiry at 188 (the latter read no validUntil from a refusal, producing NaN). All use the helper whose pins name `person_1`, not the actual signed-in person. The real-service cache control passed. These originals reproduce the stale fixture issue anticipated during source inspection; the production guard is not weakened.

Execution stopped immediately and released the slot. Root TypeScript did not run. The proposed separate fixture correction captures the actual signed-in person ID for the base admission and its malformed-policy/wrong-organization variants, preserving each negative case's intended fault and all existing expectations. That file requires its own ownership claim before editing. Source remains frozen at `2307ed7d...`; fixture repair, covering rerun, TypeScript, independent final review and broader/composed gates remain pending.
