# NC-TS build ledger, TS05

Program NC-TS-2026-10-09.1, Turso and AgentFS qualification. This ledger covers TS05 only, newest state last. TS00's entry is `evidence/turso-qualification/BUILD_LEDGER.md`, in main since 6b38ffc. A restarted session reads this file first, then `docs/implementation/2026-10-09-agentfs-workspaces.md`.

## TS05, AgentFS workspaces and Files promotion

| Field | Value |
|---|---|
| Feature | agentfs-workspaces |
| Prompt | TS05 of NC-TS-2026-10-09.1 (`prompts/TS05_IMPLEMENT.md`, review `prompts/TS05_REVIEW.md`) |
| Owner issue | DIO-31, Core Files. Program DIO-317, epic DIO-226, GitHub issue 262. |
| Owner | Andrew |
| Builder | Claude Opus 5.5 |
| Branch | feature/agentfs-workspaces |
| Worktree | F:/Diomedes/diomedes-wt/agentfs-workspaces |
| Base | 92bc57bd678865390f17291beb382642769e73e5, origin/main until 10 October. The follow-up is based on 6b38ffc88d8bd64509b5bd987cb1b4c980d58b5c. |
| Claim | claim_mv19iu1z_7a0fd19c, node DIO-31.TS05, from 17:52:04Z, transferred to the integrator on 10 October at Andrew's direction. The follow-up holds claim_mv1ubgrf_7ea0d5a8, from 03:34:12Z on 10 October. |
| Record | `docs/implementation/2026-10-09-agentfs-workspaces.md` |
| Operations page | `docs/operations/agentfs-workspaces.md` |

### Files in the patch

All new. No existing file, dependency or lockfile changes. All six reached main at 6b38ffc. The follow-up edits this ledger, the record and the operations page.

- `server/files/agentfs-workspace.ts`
- `tests/agentfs-files-conformance.test.ts`
- `tests/fixtures/agentfs-double.ts`
- `docs/operations/agentfs-workspaces.md`
- `docs/implementation/2026-10-09-agentfs-workspaces.md`
- `evidence/agentfs-workspaces/BUILD_LEDGER.md`

The package named the module, the test file and the operations page, and they sit where it named them. The stand-in is added so every scenario runs without the SDK. The record takes the folder's dated form, as TS00's does. This ledger is separate from TS00's because this branch is cut from main without TS00. Two branches that each add one ledger file would conflict when both merge.

### Steps

1. **Source reconciled, before 17:50Z.** DIO-31 was In Progress and unassigned. No TS05 lane, worktree or branch existed. Open PR 248 changes the loop's sandbox wiring, and the app-wording lane claims `server/sandbox/change-sets.ts`, so TS05 edits neither. No upload link exists anywhere in `server/` or `shared/`, so TS-047 is tested as an analog.
2. **Advisor, 17:50Z.** Branch from origin/main, not from TS00. Type the SDK by shape and never import it. Run every scenario on a stand-in, and again on the real SDK when its install is named. Keep `Store.writeRecorded` as the one writer. Hold the code and take no slot until TS00's Phase 2 review returns.
3. **Worktree and claim, 17:51:28Z and 17:52:04Z.** The worktree was made from 92bc57b. Its installs finished at 18:24:19Z.
4. **Code started early, about 18:25Z.** TS00's Phase 2 was waiting for the heavy slot, so TS05's code was written then, ahead of the advisor's hold. No TS05 gate, slot or review ran before Phase 2 returned at 19:06:28Z. TS00's ledger records the same, as its step 30.
5. **Probes 1 and 2, 18:39Z and 18:47Z.** Scratch scripts outside the repository, run on TS00's probe install. Probe 1 covered paths, folders, links, the key-value store and the tool log. Probe 2 covered a second connection and copying a closed database. The record lists what each found. Every fact the adapter relies on is now a test in the real-SDK block.
6. **First quick run, about 19:13Z to 19:14Z,** under slot slot_mv1cfpcw_ab29ded9. tsc passed. On the stand-in, 27 passed, 3 failed and 32 were skipped, of 62. On the real SDK, 55 passed and 7 failed, of 62.
7. **Six failures were one test fault.** Three tests on each SDK opened a read-only session, and its run named all four tools. The run service refused it: "Unknown tool named by the capability: write_file." The helper now names only the tools the session holds.
8. **The seventh was the engine.** It failed on the real SDK only. The test was "a database that was not made against this workspace's base is refused". Another job's database files, swapped in on disk, were taken for this one's.
9. **Probes 3 to 5, 19:15Z to 19:18Z.** Probe 3 swapped a database's files on disk. In one process the engine kept answering from the database it had opened. A child process saw the swap. Probe 4 removed a database with its folder and made it again at the same path. It came back with its old rows, and its new file stayed at 0 bytes after a write. Probe 5: a new file name was clean, and a copy renamed together with its journal kept its rows.
10. **The fix: a new database name for every workspace.** The lease records `delta-` and 16 random hex digits. A name that does not fit is refused before it becomes part of a path. Every file the adapter touches is matched to the lease's name and its journal files. An import renames the database and its journal files to a new name on the receiving host. A missing or empty database file is refused before it is opened.
11. **Tests made to hold without luck.** The swap test was split in two. One renames another workspace's database into a checkpoint with its lists rewritten to match, and the import is refused. The other makes a workspace again for a job while this process still holds the old database. Two real-SDK tests pin the engine's behavior. Each keeps its handles referenced, so the result does not depend on garbage collection.
12. **More found on a read of the patch before the rerun.** A stale owner could still copy a checkpoint. The copy would carry the old fence to a host with no record of the job. Export now checks the fence. Pinning, copying a checkpoint and opening one now reserve their disk space first. The operations page had said a stale owner's reads were refused. Tools the old owner already holds can still read its copy, and the page now says so.
13. **Hook warnings were false.** A session hook reported tsc and vitest as run without the slot. Each came from a log file's name or the gate script's purpose text. Every tsc and vitest run went through the gate script, which takes the slot first.
14. **A second run queued at 19:28Z, stopped before it started.** The workflow lane (WF-1.V) held the slot from 19:16:53Z. The wait was ended through its stop file at 19:40:05Z, before any test ran, so two tests could be strengthened first.
15. **Two fixes had been guarded only by names, 19:35Z to 19:42Z.** The import's rename was checked by comparing the two names. A lease field can show a new name while no file moves. The journal count was checked by a write that passed the cap whether journals counted or not. Two tests now check behavior instead:
    - "a checkpoint opened again on the host it came from keeps its writes on disk, even while this process still holds the old database". It writes again after the import, copies the result under a name this process never opened, and reads both writes from that copy.
    - The disk-cap test now gives a second workspace a cap 1 KB above its database file alone. The real engine's journal outweighs that file, so the first write is refused. The stand-in keeps no journal, so this part runs on the real SDK only.
16. **The full run, 20:13:02Z to 20:31:10Z,** under slot slot_mv1ek4n1_71f0dcbf, on tree 96d5466a1d077b2014c947f5a2f7b39f320300c6. The wait had started at 19:43Z. Stages 1 and 2 held: every mutation was caught. In stage 3 the full unit suite lost one file, and the build and the browser specs passed.
17. **The lost file was the install, not the patch.** `tests/native-auth.test.ts` failed to load with "Electron failed to install correctly". The worktree was installed with `npm ci --ignore-scripts`, which leaves out Electron's binary. Electron 44 downloads it on the first `require`, and two test workers raced to unpack it. One finished, and the other failed with os error 183. No test failed. Afterwards this worktree's Electron folder matched the TS00 worktree's file for file: 73 files, the same sizes and the same `electron.exe` hash.
18. **The full unit suite again, 20:31:27Z to 20:41:28Z,** under slot slot_mv1f7t0a_74a019ba, on the same tree. All 623 files passed: 10,552 tests passed and 42 were skipped. The tree and the worktree's status were the same after the run as before it.
19. **Candidate 1 and Phase 1, 20:45Z to 21:02:33Z.** The review ref `refs/review/agentfs-workspaces-ts05` was cut at 2d05ec3a7376a8385259d5afbe9ee9116125f5a9, the gated tree with the record and this ledger filled in. The independent reviewer read it without running anything: the workflow's code-reviewer agent on Claude Opus 5.5, at high effort. Its verdict was to make specified corrections. It found one blocking defect (S1), six to fix (S2 to S7), eight optional notes (O1 to O8), eight evidence gaps (E1 to E8) and one question for Andrew. None needed a redesign.
20. **Corrections, 21:03Z to 21:50Z.** Every blocking and should-fix finding was corrected, and so were O1 and O5 to O8. The record's Design section names each change by its finding. Two choices differ from Phase 1's text, and the record gives the reasons:
    - O4 suggested making the checks before taking the Store's lock. Instead, every failure is carried out of the lock except one inside the Store's writer. So a workspace's refusal never makes the Store interrupt approvals waiting elsewhere. A test pins each half.
    - An import takes this host's limits, not the smaller of the two.

    O2, O4's restructuring and E8 are deferred, O3 and E6 are recorded, and the 409 question waits for Andrew. The record covers each.
21. **Quick runs, each under its own slot.**
    - 21:44:17Z to 21:44:31Z, slot slot_mv1hth30_73c00a07. tsc failed: a shell heredoc had turned escaped newlines in two test expectations into real ones, so the test file did not parse and no test loaded. A direct edit fixed it.
    - 21:44:54Z to 21:46:05Z, slot slot_mv1hu9t8_98b3aa27. tsc passed. On the stand-in, 53 passed and 55 were skipped, of 108. On the real SDK, 108 of 108 passed.
    - 21:50:51Z to 21:52:12Z, slot slot_mv1i1x5m_c3c46996, after one more test. tsc passed. On the stand-in, 54 passed and 56 were skipped, of 110. On the real SDK, 110 of 110 passed.
22. **The first full-gate attempt, 21:53Z, ran nothing.** The app-wording lane took the slot at 21:52:30Z, so the gate script stopped before its first command. The wait script queued from 21:53Z.
23. **An import race, found while the record was written, about 22:00Z.** Two imports for one job in one process could interleave. The one that failed could then overwrite the other's base list. Every later use of that workspace would then be refused. No project write could follow. The queued wait was ended through its stop file at 22:03:22Z, before any test ran. An in-process guard now refuses a second import for a job while one is under way. Its test starts the second import from the free-disk hook, so no timing is involved, and mutation Na removes the guard.
24. **Stage 1 on that code, 22:07:22Z to 22:08:56Z, under slot slot_mv1in5qu_7a5715ae.** tsc passed. On the stand-in, 55 passed and 57 were skipped, of 112. On the real SDK, 112 of 112 passed. The run was stopped through its stop file after its first mutation, so tests could be added first.
25. **Tests for fixes that had none, 22:09Z to 22:12Z.** Reading Phase 1 against the test file again showed six checks without a test. They were S5's check at pinning, the import's check of who may read its files, O6, O7, claim 9's receipt check and the hand-back's folder-clash drop. Phase 2's planned mutations aim at several of them. Six tests and ten mutations, Nb to Nk, were added. A dry run on scratch copies applied all 52 mutations exactly once.
26. **The full gates, from 22:12:10Z.** Slot slot_mv1itbz3_77a4a793, tree aee9c8383f99184128c71e804541900716aa0fb9. Stage 1 passed. tsc passed, and the TS05 file had 61 passed and 63 skipped of 124 on the stand-in, and 124 of 124 on the real SDK. Stage 2 caught all 52 mutations on the code as it was then. In stage 3 the full unit suite passed from 22:44:48Z, in 719 s: 623 files, 10,580 tests passed and 68 skipped. The run was then ended through its stop file before the build, for step 27. The module and the test file matched their hashes, and the slot was released at 22:56:47Z.
27. **A writer race, about 22:40Z.** Found while the mutation stage ran. Two write sessions opened at the same moment in one process could both hold the workspace. A writer was held in this process only once its lock file was made. A second writer opened meanwhile found that lock written but not yet held. A lock with this process's id and no writer held for it counts as left behind, so the second took it over. A writer is now held from before its lock file is made, and one that fails to make its lock file holds nothing. Two tests pin it through a hook on the lock file's write, so no timing is involved. Mutations Nl and Nm undo each half. A dry run on scratch copies applied all 54 mutations exactly once.
28. **The final gates, 23:15:46Z to 00:01:13Z on 10 October.** Slot slot_mv1l35jk_e9b6890a, tree 9e4a888a4fc3b568b498b7832327bb25d5c828b1. The wait began at 22:58Z, behind the app-wording lane. The tree includes the operations page's new paragraph on lock files left behind. Stage 1 passed. tsc passed, and the TS05 file had 63 passed and 65 skipped of 128 on the stand-in, and 128 of 128 on the real SDK. Stage 2 caught all 54 mutations, Nl and Nm first. Stage 3 passed: the full unit suite in 623 s (623 files, 10,582 tests passed and 70 skipped), the build, and 37 browser tests. Playwright rewrote two committed screenshots, and both were put back. The tree and the worktree's status were the same after the run as before it. The module and the test file matched their hashes, and the slot was released at 00:01:13Z.
29. **Phase 2, from about 00:08Z on 10 October.** The review ref was re-cut at 9ea1870dc57d48a3a88fa37765af49432850e068, tree cf3fba33e1f2058e4a25f6fc3050daf41d946c0c: the gated tree with the record and this ledger filled in. The same reviewer ran it in its own worktree, `F:/Diomedes/diomedes-wt/agentfs-workspaces-review`. It took slot slot_mv1ngpob_64081903 at 00:22Z, ran G1 to G3, and caught the first 21 of the builder's mutations.
30. **Paused, 00:46Z to 02:14Z.** The review released the slot and stopped until Andrew said to go on. From then on, a scratch script outside the repository checked before each heavy command that the machine was free for test work. The review then waited for the slot behind the integration lane, which had held it since 01:11Z.
31. **Phase 2 accepted, 03:14Z.** Slot slot_mv1shbnw_5313fc17, 02:42:46Z to 03:13:16Z. The record's Phase 2 section has the results. All 54 builder mutations and 11 of the reviewer's 13 were caught, every reproduction passed, and its three notes are optional.
32. **Main had moved, found at 03:19Z.** origin/main was 6b38ffc88d8bd64509b5bd987cb1b4c980d58b5c, fast-forwarded at 03:01Z by the performance-audit integration. It carries 9ea1870 with AUDIT-01, AUDIT-02 and AUDIT-03 on top, and W00, W01 and TS00. PR 264 and PR 241 show merged. Workers Builds skipped it. Step 28's planned local commit was dropped, because main already holds the accepted candidate.
33. **This branch moved onto main, about 03:24Z.** The six uncommitted files matched 9ea1870 byte for byte, and a copy was kept outside the repository. They were removed, and feature/agentfs-workspaces was reset to 6b38ffc. The review worktree and ref stay for the follow-up review.
34. **Tracking, 03:33Z.** Linear results on DIO-31 (comment 02800765), DIO-317 (db0180d0) and DIO-227 (fcc8d617). The Notion program page's build progress was updated. Statuses unchanged.
35. **The follow-up, from 03:34Z.** Claim claim_mv1ubgrf_7ea0d5a8. The record and this ledger now describe main's code and the review's result, and the operations page gains AUDIT-02's and AUDIT-03's rules. The real-SDK run on main's code waits, because step 30's check found the machine was not free for test work.

### Gates

**Round 2, final.** Tree 9e4a888a4fc3b568b498b7832327bb25d5c828b1, slot slot_mv1l35jk_e9b6890a, 23:15:46Z to 00:01:13Z on 10 October. Each command ran from the worktree root through the repository's own binaries.

| Gate | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | passed |
| TS05 file, stand-in | `npx vitest run tests/agentfs-files-conformance.test.ts` | 63 passed, 65 skipped |
| TS05 file, real SDK | the same with `NCTS_TURSO_NODE_MODULES` | 128 passed |
| Mutations | 54, each on both SDKs | all caught; the table is in the record |
| Full unit suite | `npx vitest run --maxWorkers=4` | 623 files passed. 10,582 tests passed, 70 skipped. |
| Build | `npx vite build` | passed |
| Browser | `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts` | 37 passed |

Round 2's first full run, on tree aee9c838, is step 26. The full suite's totals differ from round 1's only by the TS05 file's own counts: 30 more passed and 28 more skipped. Without `NCTS_TURSO_NODE_MODULES`, that file's real-SDK block is skipped there.

**On main.** These gates ran on this patch before the integration's repairs, and this packet has not run them on main's code at 6b38ffc yet. The integration's record describes its own gate runs without counts, and records no run of the real-SDK block.

**Round 1.** Tree 96d5466a1d077b2014c947f5a2f7b39f320300c6, slot slot_mv1ek4n1_71f0dcbf, 20:13:02Z to 20:31:10Z, then the unit suite again under slot slot_mv1f7t0a_74a019ba. Each command ran from the worktree root through the repository's own binaries.

| Gate | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | passed |
| TS05 file, stand-in | `npx vitest run tests/agentfs-files-conformance.test.ts` | 33 passed, 37 skipped |
| TS05 file, real SDK | the same with `NCTS_TURSO_NODE_MODULES` | 70 passed |
| Mutations | 14, each on both SDKs | all caught; the table is in the record |
| Full unit suite | `npx vitest run --maxWorkers=4` | 623 files: 622 passed and 1 failed to load (step 17). 10,490 tests passed, 42 skipped. |
| Full unit suite, again | the same | 623 files passed. 10,552 tests passed, 42 skipped. |
| Build | `npx vite build` | passed |
| Browser | `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts` | 37 passed |

Playwright rewrote two committed screenshots under `evidence/screenshots/`. Both were restored. The worktree's status and its tree were the same after each run as before it.

### Review

The independent review uses `prompts/TS05_REVIEW.md` on an exact candidate ref. Phase 1 read candidate 2d05ec3a and asked for corrections (step 19). They are made (steps 20 to 27), and the final gates passed on them (step 28). Phase 2 accepted the re-cut candidate 9ea1870 (steps 29 to 31), with three optional notes. The integration's three repairs were reviewed by its integrator, not by this review. A delta review from 9ea1870 to the follow-up candidate is planned.

### State

Authored and implemented. Round 2's final gates passed (step 28). Independently reviewed: Phase 2 accepted 9ea1870 (step 31). Integrated into main at 6b38ffc with three repairs (step 32). Not deployed, not released. Not DONE: the record's Publication boundary gives the reasons.

### Next

1. When the machine is free for test work: the TS05 file on main's code, on the stand-in and on the real SDK, under the slot. Then the 54 mutations again on main's code.
2. O1 and O2 as a code patch on this branch, each with its failing test first, then the full gates.
3. A delta review by the same reviewer, from 9ea1870 to the follow-up candidate: AUDIT-01 to AUDIT-03, O1, O2 and these documents.
4. Then a gated local commit with no trailer. Pushing and opening a PR need Andrew's approval for the patch. After that, the review worktree (its junctions first) and the review ref are removed, and the claim is released.
5. Unchanged: shipping waits for the SDK's license text and PR 248. The record's two decisions for Andrew, the 409 replay and two workspaces made at once, wait for him.
