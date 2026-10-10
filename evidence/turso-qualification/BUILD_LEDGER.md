# NC-TS build ledger

Program NC-TS-2026-10-09.1, Turso and AgentFS qualification. One entry per packet, newest state last. A restarted session reads this file first, then the packet's record in `docs/implementation/`.

## TS00, source, versions and compatibility baseline

| Field | Value |
|---|---|
| Feature | turso-baseline |
| Prompt | TS00 of NC-TS-2026-10-09.1 (`prompts/TS00_IMPLEMENT.md`, review `prompts/TS00_REVIEW.md`) |
| Owner issue | DIO-227. Program DIO-317, epic DIO-226, GitHub issue 262. |
| Owner | Andrew |
| Builder | Claude Opus 5.5 |
| Branch | feature/turso-baseline |
| Worktree | F:/Diomedes/diomedes-wt/turso-baseline |
| Base | 92bc57bd678865390f17291beb382642769e73e5, origin/main at 2026-10-09T14:20:35Z |
| Record | `docs/implementation/2026-10-09-turso-baseline.md` |
| Evidence | `evidence/turso-qualification/ts00/`, described in its README |

### Files in the patch

All new. No production file, dependency or lockfile changes.

- `tests/turso-contract-baseline.test.ts`
- `tests/fixtures/turso-qualification/`: `probe-engine.ts`, `qualification.ts`, `offline.ts`, `retention.ts`, `run-engine-probes.ts`
- `evidence/turso-qualification/ts00/`: 12 JSON files, `probe-install/` and a README
- `evidence/turso-qualification/BUILD_LEDGER.md`
- `docs/implementation/2026-10-09-turso-baseline.md`

### Steps

1. **Source reconciled, 2026-10-09T13:58:07Z, re-checked 14:20:35Z.** origin/main 92bc57b is PR 249's Expert merge. v0.2.4 (2229bab) is the latest release and predates it. PR 241 (W00) is open at 144d892. W01 is on origin at d05a6b1, unmerged, with no PR, and its worktree stays locked. No open PR names Turso, AgentFS, libSQL or the memory ledger. PR 241 and this patch share no file.
2. **Upstream pinned.** turso v0.8.2 is commit 5c168be (annotated tag), v0.4.4 is dc7781a, agentfs v0.6.4 is 3a5ed2b. npm latest is 0.8.2 for database and sync and 0.6.4 for agentfs-sdk. COMPAT.md (git blob 7cd85a8) and MANUAL.md (git blob d98a634) matched upstream byte for byte.
3. **Probe install.** An npm project outside the repository with exact pins. Its package.json and lock are copied to `ts00/probe-install/`. 23 lock entries, all from registry.npmjs.org, none with an install script. 14 install on win32-x64.
4. **Evidence generated, 2026-10-09 about 14:15Z,** with the nine runner commands in the evidence README. All nine took 9.6 seconds. A scan for local paths found none.
5. **Notice paths qualified.** Upstream notice paths now carry their source key (`turso@v0.8.2/LICENSE.md`), so each reason names one pinned commit. The manifest was regenerated, and the artifact digests did not change.
6. **TS-002 test made content-based.** The old check dropped the first upstream file and expected a failure. That depends on position, and three Rust crate licenses (libm, pastey, serde) are byte-identical, as are sync's two LICENSE.md files. The test now drops each file in turn. A file whose text no other required file carries must reopen the verdict. A file with an identical copy must keep it ready.
7. **Hand records written:** `support-matrix.json` (18 cells, 21 claims) and `source-baseline.json`.
8. **Gates deferred under the owner's machine rule.** A bounded background watcher checked every minute. The gates could have started at 14:52:16Z, after 27 checks.
9. **Two hook warnings were false.** A session hook reported electron-builder and tsc as run without the heavy slot. Both came from `ls` listings of those files. Neither tool ran.
10. **Next checkpoint corrected, 2026-10-09T14:47:03Z.** The first draft named TS07 as next with no blocker. The bought-credit-regression candidate holds every production file TS07 names, and main still carries the pay-as-you-go rule that PR 259 records as superseded. TS07 now waits for both to reach main. `source-baseline.json` gained a `nextCheckpoint` block with the claims, PR heads and the heavy slot behind this. The record's checkpoint section and blocked proofs say the same.
11. **Gate wrapper started, 14:53Z.** The funding lane took the heavy slot at 14:40Z for its final gates. A bounded background wrapper waits for the slot and the owner's machine rule, then runs the gates. It checks once a minute, for up to 100 checks.
12. **Phase 1 review returned, 14:56:33Z.** The independent reviewer read candidate cf59fbc0 without running anything. It asked for four fixes (S1 to S4), six evidence changes (E1 to E6) and listed optional ones. The gate wrapper was stopped at 14:57Z, before it took the slot, so the gates run once, on the corrected patch.
13. **S1, pins see added files.** `verifyPin` now refuses any file or nested package an approved package does not list. It also resolves each dependency again the way Node would. The tests cover a dropped-in `.node` file, a nested copy and a shadowing folder beside the scope. Runs record `NAPI_RS_NATIVE_LIBRARY_PATH` and `NAPI_RS_FORCE_WASI` when set. On a copy of the probe install with 0.4.4's binary dropped beside 0.8.2's loader, verification names that file. On the real install all four components pass.
14. **S2 and S3, protections by behavior.** Each result now says whether it observed behavior or only read a setting back. Six behavior probes were added. They test trusted_schema refusing an application function in a view, busy_timeout's actual wait and the result code on a full database. They also test BEGIN IMMEDIATE keeping a second writer out, one snapshot for a whole read, and the transaction flag. The test reads W01's local-store.ts. It fails unless each PRAGMA, option, BEGIN kind, result code and connection property the store uses is probed or named with a reason. cache_size is the one named.
15. **New finding: 0.4.4's transaction flag.** A trial showed the snapshot probe failing on 0.4.4 only. The cause: 0.4.4's `inTransaction` answers false at every point. W01's three failure paths roll back only when that flag is true. No probe now reads the flag except the one that tests it, and every probe ends its transactions unconditionally. Two probes that built STRICT tables without testing STRICT no longer do, so 0.4.4 answers them.
16. **Mutation cases made exact.** Each case now runs the whole set. It expects its own probe to report violated, and only the named rows to stop being proven. The named rows were measured first: five cases name one to three rows, each with its reason in the test.
17. **S4 and E1 to E6.** The offline run names the variables it removed, read before removal, and any present during the run. The recording set one marker variable. Identity is read again on a file the engine wrote: both Turso versions answer 3.47.0 there, directly and through the SDK. The record now states the native-socket limit (E2) and adds W01's offline open to the blocked proofs (E4). It quotes sync's transform hook from the pinned package (E5). It records a separately downloaded copy of the NC-UM archive with the same size and hash (E6). The tests rerun the manifest exactly (E3). The record says which evidence files are hand-made.
18. **Evidence regenerated, 15:51Z, and again at 15:55Z** after the second STRICT change. Between the two runs only the 0.4.4 engine file changed. The manifest matched the earlier one byte for byte. A scan for local paths found none.
19. **Hygiene.** Steps 8 and 11 no longer name the owner's activity or machine figures.
20. **Gates restarted, 15:55:48Z.** The heavy slot was held by the funding lane, so the wrapper waits.
21. **Flag probe checks its premise, 16:08Z.** The flag probe judged an open transaction by COMMIT or ROLLBACK succeeding. A scratch check on all three engines showed that both fail with no transaction open. It also showed that a failed statement leaves its transaction open, since a later write commits with the first one. The probe now checks the first point on every run, and reports unverified when it does not hold. A new test pins that with a driver that answers both silently when nothing is open. The probe reports unverified there, and a scratch copy without the check reports proven. The probe also tries a second BEGIN IMMEDIATE inside the failed transaction, and 0.4.4 refuses it. The four mutation cases that touch this probe gave the same results. On regeneration only the 0.4.4 engine file changed, in that row's message. The gate wrapper was still waiting for the slot.
22. **Two comments corrected.** `offline.ts` said the probed engines reach the network only through fetch. It now says the one call seen, sync's bootstrap pull, went through fetch, which matches the native-socket limit. The runner's usage lines now pass `--node-modules` where the README does, since that option is what redacts the install path.
23. **The offline check proves its own restore.** TS-004's first test now also checks each network entry point it names. Each must be replaced during the check and be the original again after it. A scratch copy whose restore does nothing fails it on all 12 entry points.
24. **First full run, 16:55:53Z to 17:06:38Z, on tree 7e5ccf4e.** tsc passed. The full vitest run failed one test outside the patch: `tests/h14-external-worker.test.ts`, "a saved profile on Claude Code can run a team's worker, never a delegate". Its run was still running when the 15 s wait at line 388 ran out. The server had logged `Unknown run` for a run it tried to drive. The file took 19.4 s, its usual tests plus the timeout, so one run stalled. That script stopped at the first failure, so the build and Playwright did not run.
25. **Second run, every stage, 17:13:04Z to 17:27:59Z, on tree a0b03c12.** That tree differs from 7e5ccf4e only in the TS00 test file (step 23). The script now runs every stage and records each result. The h14 file passed alone, 25 of 25, and the test that failed took 456 ms of its 15 s. Every gate then passed (see Gates). The stall is filed as DIO-318, since nothing in the patch reaches that code.
26. **Evidence made again on the final tree, 17:28:50Z.** All nine runner-made files matched the committed files byte for byte. `offline.ts` and the runner changed after step 21's regeneration, in comments only, and this confirms it.
27. **Phase 2 blocked from 17:33Z.** The heavy slot was held by APP-WORDING-RECONCILIATION from 17:32:57Z, for a one-worker full suite that started at 17:56Z. The reviewer asked once a minute until 18:19:56Z and ran nothing. Without the slot, it confirmed the candidate's patch digest, the mutation line numbers and the archive's hash, and read each fix in the source. At 18:22Z it was sent one more round, bounded at 19:50Z.
28. **Phase 2 passed, 18:55:39Z to 19:06:28Z.** The reviewer took slot slot_mv1bsm7e_7962d98d on its 34th try and released it at 19:06:28Z. On candidate 6e83c85c, tsc passed. The TS00 file gave 71 passed and 10 skipped, and 81 passed with the three `NCTS_` variables. The nine runner commands made files identical to the committed ones. Each of the 17 mutation cases failed the tests named for it, and M2 and M3 each failed one more. Reproductions R1 to R7 all held. R1 showed Phase 1's dropped-in binary really loads without the new pin check, and that the check now names it. Verdict: accept, with no defect and two optional notes.
29. **The optional notes.** O1: the review traced 3.47.0 to a version number in the file header. Turso stamps it there when it writes: 3047000, at bytes 92 and 96. A Turso 0.4.4 file from TS05's probe holds the same two values. The record's TS-001 and TS-007 paragraphs now say so. O2: a real-engine run leaves one 4,096-byte `tursodb-ephemeral-` file in the temporary folder. It is recorded in the record, not fixed, because a fix would change the reviewed runner. The follow-up points the runner's child processes at the run's scratch folder.
30. **TS05 started early, at about 18:25Z.** While Phase 2 waited for the slot, TS05's code was written in its own worktree. That was ahead of the record's checkpoint line, which said TS05 would not start until this review passed. No TS05 gate, slot or review ran before Phase 2 returned. The checkpoint line now states the rule that held: TS05's gates and review wait for TS00's.
31. **Gated local commit after the review.** Code and evidence are the reviewed candidate's bytes. Only the record and this ledger differ from it, and the commit carries no trailer.

### Results

| Measure | Result |
|---|---|
| node:sqlite 3.51.3 | conformant, 31 of 31 required protections proven |
| Turso 0.8.2 | retain-sqlite, 7 not proven. Violated: foreign-key-check-detects-orphan, capacity-error-code, double-quoted-identifiers-only. Unverified: trusted-schema-off, trusted-schema-refuses-unsafe-function, journal-size-limit, wal-autocheckpoint. |
| Turso 0.4.4, inside agentfs-sdk 0.6.4 | retain-sqlite, 17 not proven. STRICT refused. The transaction flag never reports an open transaction. |
| Two connections | On both Turso versions a second writer is kept out and waits for busy_timeout, and a read keeps one snapshot. |
| Identity on a written file | Both Turso versions answer `turso_version()` with 3.47.0. The source id still names the pinned commit. |
| W01 schema on 0.8.2 | 48 of 48 objects built. 32 stored SQL texts differ from node:sqlite. |
| Offline start | Store, Turso local file and sync with no remote all worked with no network attempt. Sync's default bootstrap failed offline. |
| AgentFS SDK on win32-x64 | File and key-value operations work. |
| Redistribution | Turso components need their upstream notices bundled. agentfs-sdk 0.6.4 is blocked: MIT declared, no text anywhere. |
| NC-UM retention | 118 of 118 files match. A separately downloaded copy has the same size and hash. 180 prior cases unchanged. No id shared with the 80 new cases. |

### Gates

Tree a0b03c12, slot slot_mv184od2_b2280904, 17:13:04Z to 17:27:59Z. Each command ran from the worktree root through the repository's own binaries.

| Gate | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | passed |
| h14 file alone | `npx vitest run tests/h14-external-worker.test.ts` | 25 passed |
| TS00 file, recorded | `npx vitest run tests/turso-contract-baseline.test.ts --maxWorkers=4` | 71 passed, 10 skipped |
| TS00 file, real engines | the same with `NCTS_TURSO_NODE_MODULES`, `NCTS_PACKAGE_DIR` and `NCTS_NCUM_ARCHIVE` | 81 passed |
| Full unit suite | `npx vitest run --maxWorkers=4` | 623 files. 10,590 passed, 15 skipped. |
| Build | `npx vite build` | passed |
| Browser | `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts` | 37 passed |

Playwright rewrote two committed screenshots under `evidence/screenshots/`. Both were restored, and the tree after the run was a0b03c12 again. The evidence check in step 26 ran under slot slot_mv18oyw5_1e0ff606.

### Review

Phase 1 (static) returned at 14:56:33Z on candidate cf59fbc081376bc30723da3d27759d1d1891c4fa, with the corrections listed in steps 13 to 19. Phase 2 runs the gates, the mutations and the reproductions in a scratch worktree, under the slot. Its candidate is the gated tree with these records updated: `refs/review/turso-baseline-ts00` at 6e83c85c3d9c2d4e1d0bdc7a1448808514e4c15c, tree 93e684af6202b61315e9c40d3e610e6ac90a608a. The patch digest, `git diff --binary 92bc57b 6e83c85c | sha256sum`, is 390f14fd420db4cc7dfdb21da6359de1d30d0eb16c050dd2ca8a99d6a52a386c. Phase 2 ran from 18:55:39Z to 19:06:28Z and accepted it (steps 28 and 29). The reviewer did not build this patch.

### State

Authored, implemented, tested and independently reviewed: accepted. Committed locally on feature/turso-baseline, not pushed. Not integrated into main, not deployed, not released. Not DONE.

### Next

1. Pushing feature/turso-baseline and opening its PR need Andrew's approval for this patch.
2. Linear: DIO-317 has been In Progress since 14:38:05Z, with a start comment. Comment the TS00 results on DIO-227 and DIO-317. Owner statuses stay as they are. DIO-318 tracks the h14 stall.
3. Next packets: TS05 under DIO-31 is being written on feature/agentfs-workspaces, with its own ledger there. It can be written but not shipped. TS07 under DIO-128 waits for the funding candidate and PR 259 to reach main. PR 241 is the program blocker.
4. O2's follow-up, in a later patch that touches the runner.
