# September 11 integration: six slices, one green main

September 11, 2026. This is the integrator's record for the work dispatched from the eight
execution briefs prepared September 10 (`Diomedes_Eight_Execution_Briefs_2026-09-10.zip`).
Each slice has its own record; this one says how they were combined, what proved the
combination, and what the briefs still hold open.

## 1. Method

The briefs were written against `e69d4a2`, which was current `main` at the start, so they
were an accurate baseline. The demonstration subset across briefs 01–06 was cut into six
slices. Two shared contracts were frozen on `main` first (`shared/capability-packs.ts`,
`shared/work-control.ts`, commits `2862fa9` and `b6d26ec`) so no two workers invented the
same shape. Each slice ran in its own git worktree branched from that commit, with a
written brief that named the files it owned and the tests it had to run, and could not
commit, push, build a package or run Playwright.

| Slice | Brief IDs | Worker | Record |
|---|---|---|---|
| CI root cause and lock probe | REL-01 | integrator | `2026-09-11-release-baseline.md` |
| Hardware detection module | LOC-01 | GLM 5.3 Flash | `2026-09-11-release-baseline.md` §3 |
| Support bundle module, route, button | REL-06 | Muse Spark 1.3, integrator | `2026-09-11-release-baseline.md` §4 |
| Pack activation, instruction files | PAK-01, PAK-03 min, HAR-02, HAR-04 | Opus 5 | `2026-09-11-capability-packs.md` |
| Files pane, activity overview | FIL-01, FIL-04 basic, FIL-06 | Opus 5 | `2026-09-11-files-pane-and-overview.md` |
| Stop scopes, follow-up queue | ENG-09, ENG-10, REL-05 | Opus 5 | `2026-09-11-work-control.md` |
| Cursor route over ACP | ENG-04, ENG-05 | Astra | `2026-09-11-cursor-route.md` |

Slices merged into `main` by rebase and fast-forward in the order they returned. One rebase
conflicted (work control onto the tree that already held packs, Files and Cursor): four
both-sides-added hunks in `shared/types.ts`, `client/api.ts`, `client/console/ThreadView.tsx`
and `client/console/console.css`, resolved by keeping both sides. The three edits the
worker reports asked of the integrator were applied in `09a7bf7` and `de32ec6`.

## 2. Verification of the combined tree

Run serially on `03f879d` with nothing else competing for the machine:

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 1498 passed, 1 skipped, 0 failed; 88 files |
| `npx vite build` | clean |
| `npx playwright test` (full configured set) | 52 passed, 0 failed |

The one unit skip is the 8.3-alias case in `tests/paths.test.ts`, which this volume cannot
exercise; CI on `windows-latest` covers it. The browser run first reported 51 passed and one
failure in `tests/ai-engines-ui.spec.ts`, whose assertion that the last default engine was
`oh-my-pi` was hard-coded; the spec iterates its engine map, so with Cursor present the
last row is Cursor. The assertion was made generic and the spec re-run green; the 52 is the
51 plus that re-run on a tree that differs only by the spec file.

Two worker reports observed whole-suite flakes under load in `tests/harness-host.test.ts`
and `tests/harness-negative.test.ts` (1-second `vi.waitFor` and 20 ms timer deadlines) that
passed on an immediate re-run of the identical tree. They did not recur in the serial run
above. The CI worker cap in `282baf3` is the mitigation on the runner; the deadlines
themselves are unchanged and are worth a look if the flake returns.

Astra's own run reported 17 failures in the Claude and OpenCode adapter tests, all in the
owned-process termination path. Run outside the Codex sandbox the same seven files pass
114/114; the failures were the sandbox refusing process termination. A live `inspect()`
against the installed Cursor CLI outside the sandbox returned signed-in, 37 models, in
5.4 s, with no process left behind, so the `CLEANUP_FAILED` Astra saw was the sandbox too.

## 3. What the briefs still hold open

Priority order is the briefs' own.

- **01 Release and demo.** REL-01 and REL-06 done. Not done: REL-02 the named EXE candidate
  whose commit, version, hash and test results agree; REL-03/04 first-run choice and guided
  sign-in recovery; REL-05 automatic worker start on Ready (the follow-up delivery path now
  proves the admission shape); REL-07 quit/reopen preservation proof; the two demonstration
  journeys (A ordinary user, B technical user) were not traversed.
- **02 Adapters and work control.** ENG-04, ENG-05, ENG-09, ENG-10 landed within their
  boundaries. Not done: ENG-01/02/03 full conformance of Codex, Claude `-p` and OpenCode
  (live cancellation, resume, tools); ENG-06 common durable event presentation; ENG-07
  durable Ready admission with a worker claim; ENG-08 steering (explicitly not claimed);
  ENG-11/12/13.
- **03 Harness.** HAR-02 and HAR-04 landed (instruction files as inspectable project
  rules). Not done: HAR-01 the canonical delivery of that context to each route; HAR-05
  onward; TTSR (HAR-07) untouched, and nothing after-output is labelled as it.
- **04 Local models.** LOC-01 landed as a module. Not done: LOC-02 onward, including the
  setup screen that would show it.
- **05 Files and packs.** FIL-01, FIL-04 basic, FIL-06, PAK-01 and PAK-03 minimum landed.
  Not done: FIL-02 attachments, FIL-03 artifact identity, FIL-05 review comments, PAK-02
  registry fetch, PAK-04 beyond instruction discovery, PAK-05/06.
- **06 Business and managed agent.** Not started this session; the existing PB-01 to PB-03
  foundations stand as recorded 2026-09-10.
- **07 Connections, browser, recurring, remote** and **08 Learning and skill catalog.** Not
  started.

## 4. Pillar impact

Advances 05 (self-setup: disclosed hardware detection, a fourth route the person already
pays for), 06 (control without babysitting: Stop scopes that mean what they say, a queue
that waits its turn), 07 (Diomedes is the agent: Cursor joins as an interchangeable route
with truthful attribution), 09 (trust: activation grants nothing, delivery cannot widen
authority, the bundle excludes secrets), 11 (a support bundle a person can send without the
founder), 12 (one Console: Files and overview are Core, the IDE tier is still the pack's).
Risk: 12, if the pack ever loads for a project that did not activate it; the test for that
case is the guard. No pillar was amended.

## 5. Build, publication and deployment

Source and CI only. No package was built, no release published, no installed app replaced,
no live provider called except the one Cursor `inspect()` probe on the build machine, no
cloud document written (`docs/reference/CLOUD_SYNC_PENDING_2026-09-11.md`). Version stays
0.1.1. The website repository received only Andrew's own waiting commit, pushed as it was;
`src/data/status.ts` was not changed, because none of this has a real capture yet.
