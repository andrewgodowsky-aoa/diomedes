# Account security with Personal access

Status: test-only checkpoint; every new test and dependency command is UNRUN.

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
