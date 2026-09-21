accepted with integrator obligations

CD01-R-16 is closed, and so are the R-13/O4 remainders narrowed to it. The Store exclusion and the direct-route exclusion are complementary, sufficient repairs for newly provisioned home state. Refusing Ask and Plan on the direct route is within bounds: the supported conversation routes remain available. CD-02 and CD-05 may build against the frozen conversation seam. One bounded defect remains in the ordinary thread-update endpoint, CD01-R-17 below; its integrator-owned repair does not change either consumer lane's wire shapes or required behavior. This is acceptance of that development seam, not release or production certification.

## Candidate and scope

Reviewed feature/core-agent-contract at 4e2c93c68242596b00a34e7e3582111402a0d2d0, base dadb72d4ce16f11c0f31c9fa52158a1e5e6f9a19. Before any file read, git status --short was empty and HEAD matched. The two commits after 976b68827454e6f625a2c7adf88717d8543bc1c0 were d11c468 and 4e2c93c, in the supplied order. The delta is six files, 604 insertions and nine deletions. Source was read only from this worktree.

The round-6 report is unchanged from d11c468, round 5 from f93681b, and rounds 1 through 4 plus tests/interaction-contract.astra.test.ts from e1ebe88. Each requested preservation diff was empty, including the repeated checks immediately before writing this report. Canonical repository mirrors: Pillars 2026-09-19.1; Roadmap 2026-09-19.2; Project Memory 2026-09-19.2. No owner decision is reopened.

Only this report was added. No counterexample was appended to a test file. The reproducer below is a source trace and a proposed regression against the existing home-test helpers, not an independently executed test.

## Carried findings

| Finding | Disposition | Evidence at this HEAD |
|---|---|---|
| CD01-R-16 | closed | server/app.ts:3071 refuses home before the direct route mutates a thread, creates a task, writes a plan or dispatches. server/store.ts:1632 independently refuses task creation. tests/interaction-seam.test.ts:739 retains the exact round-6 reproducer. tests/home-conversation.test.ts:500, :524, :541 and :566 cover sample modes, native Build/Fix, shared task admission and ordinary-project behavior. |
| CD01-R-13 / retained obligation O4 | closed | The prior identity/validation/adoption closure stands. Reserved identity is read at server/store.ts:809 and :820, independent of settings.home. The remaining Work-target failure is closed by :1632 and server/app.ts:3071, with the existing task and Work guards retained at :1629 and :1818. |

Earlier closures remain closed within their recorded scopes: R-01 through R-12, R-14, R-15 and F-2; the accepted body binding, settled replay, selection mechanism, I-11 and I-12 boundaries are unchanged. This delta does not justify reopening them or claiming their deferred features implemented.

## Shared admission boundary

The integrator's creation inventory is correct for production creation in this candidate. The server-wide searches found one task-array insertion, server/store.ts:1651, preceded by the new guard at :1632. Its callers are:

| Path | Task boundary |
|---|---|
| Ordinary task route and conversation task admission | server/app.ts:1651 through createTaskFrom |
| Tasks extracted from a plan | server/app.ts:1776, before plan annotation |
| Native direct execution and team wake | server/app.ts:2938 in startCodexWork |
| Sample direct execution | server/app.ts:3358 |
| Harness start without a supplied task | server/harness/bridge.ts:122 |
| Connection inbox issue creation | server/connections/service.ts:795 |
| Team task creation | server/team/service.ts:482 |

All three Work-session insertions require a task found in that same project's state: server/work.ts:40 refuses before :86; server/native-work.ts:331 refuses before :449; server/harness/bridge.ts:120 either creates through the Store or finds the supplied task, and :128 refuses before :152. A task ID from another project does not satisfy those lookups. A conversation HarnessRun is not a Work Session; conversation remains possible without a task.

I also checked the paths that a push-only inventory would miss:

- New Project state starts with empty tasks and sessions at server/store.ts:781. Provisioning adopts the reserved registry entry or creates that state at :855, then creates only a conversation at :871. Reservation is based on the registry folder, so opening that reserved folder before binding settings does not evade the guard. Renaming home or invalidating settings.home does not change its identity.
- Conversation migration reads tasks to recover labels but creates none (server/store.ts:91); team migration initializes team arrays, not tasks or Work sessions (:197).
- File import writes exports under Imports/ through writeRecorded (server/file-imports.ts:137 and :146). History restore restores recorded file contents, not a task/session snapshot (server/store.ts:1520 and :1610).
- Follow-up delivery requires an existing task (server/app.ts:1977) and uses admitWork through the control-service dependency at :1928. That admission retains its explicit home refusal at :1818.
- A team wake chooses an existing project task or reaches startCodexWork and its guarded task creation (server/app.ts:897, :900 and :2934). The team's idempotent task lookup only returns an existing task (server/team/service.ts:462). Connection issue updates likewise only update an existing task (:804); creation still reaches the Store.
- Harness recovery requires both the recorded session and its task in the project (server/harness/bridge.ts:514). It does not reconstruct a missing task or insert a missing Work session.

There is a necessary limit to the claim. Disk load and journal recovery do bypass createTask when restoring already persisted state: server/store.ts:405, :462 and :1418. The writer clones existing project state at :1071, and recovery checks journal project identity/folder at :1286. These are not new task constructors, but neither are they home-state sanitizers. An old development snapshot or journal containing a home task can retain it. Thus the proved invariant is preservation of task-free home state under the current creation paths, not rejection of every historically contaminated or externally edited state file. It also does not prove that every kind of file write or HarnessRun is forbidden in home.

## Direct-route scope

Refusing every direct mode in home is within the round-6 closure. POST /ask is the legacy direct-execution endpoint, already rejecting Automatic at server/app.ts:3078. Its Plan branch writes an artifact and a plans entry (:3338); its Ask path assigns the requested engine and Mode (:3190). Neither is needed to preserve ordinary home conversation or reads. Ask and Plan conversation messages remain supported by server/engines/interaction-routes.ts:18, with message, selection and outcome routes at :73, :91 and :103. The home regression at tests/home-conversation.test.ts:500 ends with a successful ordinary message through those routes. No alternative Ask/Plan exception on /ask is required.

The precise ordering is body parsing, route selection, then the home guard. When route selection is implicit, server/app.ts:3062 reads state twice through selectedEngine; shared/ai-selection.ts:4 performs only in-memory selection. The guard is before mutations, source-file reads and dispatch, not before all reads. The comment at app.ts:3070 and contract's round-7 wording overstate that read half. This is a mechanical wording note, not a finding or an acceptance obligation. Invalid route syntax can also be refused during the preceding parsing; the substantive promise is no execution or mutation through this endpoint in home.

## Mutation evidence

The supplied results are sound evidence of overlapping guards. They are the integrator's runs, not mine. Mutation labels O1 through O4 below are distinct from the retained review obligation O4, which is closed above.

| Removal | Integrator result | Interpretation |
|---|---|---|
| O1, Store guard | killed, 1 failed / 36 passed | Direct Store/task-from-plan coverage exercises the shared boundary independently of /ask. |
| O2, /ask guard | killed, 2 failed / 35 passed | Store refusal alone does not preserve the thread and other records touched before task creation. |
| O3, task-route guard | survived, 37 passed | The Store refuses the tested request one call later with the same sentence. This is expected redundancy. |
| O4, Work-route guard | killed, 1 failed / 36 passed | The explicit route refusal remains covered. The reported kill does not itself establish that removing it admitted Work. |
| O1 + O3 | killed, 2 failed / 35 passed | Removing both protections exposes task creation. |
| O1 + O2 | killed, 4 failed / 33 passed | Includes the native Build/Fix case; either retained guard otherwise prevents reaching native Work. |

There is no requirement that every redundant guard have an independently killing test. The O3/O1 combination has the same sound redundancy interpretation as M4/N7 in round 6. Likewise, the native case needing O1+O2 is expected. Its passing execution checks zero generator calls at tests/home-conversation.test.ts:538. The mutation summary does not prove that this particular assertion failed: earlier status/state assertions can kill the case first. I do not convert a mutation kill into a claim of observed provider dispatch.

## Residual rulings and new finding

The nativeGenerator fixture is **not a defect**. tests/home-conversation.test.ts:53 counts and throws; server/app.ts:623 supplies it instead of the real native generator, which is called at server/native-work.ts:568. This prevents the native Work path under test from calling a real worker even when both guards are removed. The conversational transport is separately faked. It is useful isolation, not evidence of live-provider compatibility.

Retaining an old home task is **not a defect in this acceptance scope**. The lack of a released home build is the supplied release-history premise, not something independently established here. Under that premise, a migration is not required. Existing contaminated development state is outside the task-free-home guarantee and must not be represented as sanitized. In particular, an old task can satisfy the unguarded lower-level constructors or wake path discussed above. This acceptance does not certify upgrading such state.

The ordinary thread-update residual is an **integrator obligation**, detailed next. Changing Mode alone is not equivalent to changing the engine: Ask and Plan are legitimate conversation restrictions, and changing to them must remain possible. The concrete failure here needs only engine: sample.

### CD01-R-17 | open | P3 | Ordinary thread update can disable home messaging

Inputs: a freshly provisioned home with the normal fake Claude conversation fixture, no tasks or sessions. PUT /api/projects/<home.projectId>/threads/<home.threadId> with {"engine":"sample"}. Then POST a fresh Automatic message through that thread's /messages endpoint with sources [] and consent true.

Source-traced result: PUT returns 200 and persists engine sample at server/app.ts:2316. The fresh message then returns 409, "Select Claude Code for this conversation before sending.", at :2583. The binding still validates, and provisionHome returns it immediately at server/store.ts:853 rather than repairing the engine. Tasks and sessions remain empty. A raw PUT back to claude-code repairs it, but the disclosed current UI has no home engine selector with which to do that.

This is a real availability defect, not another Work bypass. It is nonblocking for the frozen consumer seam because its closure is validation on a pre-existing administrative endpoint. Neither consumer needs a different message, selection, outcome, home binding or recovery protocol, and the supported home flow does not select a different engine. Hiding home is not the fix and is not treated as an authorization boundary.

Proposed regression against tests/home-conversation.test.ts helpers, not appended or run:

```ts
test('R-17: the ordinary thread update cannot reroute home away from its conversation engine', async () => {
  const home = await provision();
  const threadPath = `/projects/${home.projectId}/threads/${home.threadId}`;
  const updated = await request(threadPath, 'PUT', { engine: 'sample' });
  const message = await request(`${threadPath}/messages`, 'POST', {
    commandId: 'm-r17',
    text: 'Good morning',
    mode: 'auto',
    sources: [],
    consent: true,
  });
  const state = store().state(home.projectId);
  expect({
    updateStatus: updated.status,
    messageStatus: message.status,
    engine: state.conversations.find((item) => item.id === home.threadId)!.engine,
    tasks: state.tasks.length,
    sessions: state.sessions.length,
  }).toEqual({
    updateStatus: 409,
    messageStatus: 200,
    engine: 'claude-code',
    tasks: 0,
    sessions: 0,
  });
  expect((await message.json()).outcome).toEqual({ status: 'answered' });
});
```

The traced actual tuple at this HEAD is { updateStatus: 200, messageStatus: 409, engine: 'sample', tasks: 0, sessions: 0 }. No new blocking finding was established.

## Integrator obligations

1. **O5, close CD01-R-17.** In server/app.ts, validate a requested home-thread engine before any field of the thread is changed. Use reserved Project identity and refuse an engine other than claude-code with 409; do not silently rewrite the choice, alter GET/provisioning semantics, or disable valid Ask/Plan/Automatic controls. In tests/home-conversation.test.ts, add the regression above, a mixed name/engine update proving atomic refusal with no partial rename, an allowed home Mode-narrowing case, and an ordinary-project engine-change control. Update the recorded residual in docs/implementation/2026-09-20-core-agent-contract.md. A later reviewer can close O5 when those cases pass, the home answer remains available after rejection and restart, and the diff leaves the message/select/outcome shapes unchanged. This is one obligation and one finding, not two defects.

## Independent verification

Exact validation commands executed here:

```text
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run tests/home-conversation.test.ts tests/interaction-seam.test.ts tests/interaction-contract.astra.test.ts
```

TypeScript exited 0 with no diagnostics; its tool session was polled to completion. Vitest was attempted once and exited 1 before loading tests: EPERM opening node_modules/.vite-temp/vitest.config.ts.timestamp-1789976689693-0442ca3a099bf.mjs. Zero tests ran independently and zero are claimed as passing. There was no retry, install, junction change, full suite, browser run, build, packaging or live model call.

Exact Git inspection commands, repeated identical invocations listed once:

```text
git status --short
git log -1 --format="%H %D"
git log --oneline --reverse 976b688..HEAD
git show -s --format="%H" dadb72d4ce16f11c0f31c9fa52158a1e5e6f9a19
git diff 976b688..HEAD --stat
git diff 976b688..HEAD --numstat
git diff 976b688..HEAD -- server/app.ts server/store.ts tests/home-conversation.test.ts tests/interaction-seam.test.ts
git diff 976b688..HEAD -- docs/implementation/2026-09-20-core-agent-contract.md
git diff d11c468 HEAD -- docs/implementation/2026-09-21-core-agent-contract-review-r6.md
git diff f93681b HEAD -- docs/implementation/2026-09-21-core-agent-contract-review-r5.md
git diff e1ebe88 HEAD -- docs/implementation/2026-09-20-core-agent-contract-review.md docs/implementation/2026-09-20-core-agent-contract-review-r2.md docs/implementation/2026-09-20-core-agent-contract-review-r3.md docs/implementation/2026-09-20-core-agent-contract-review-r4.md tests/interaction-contract.astra.test.ts
git diff --check
```

All these Git inspections succeeded. Final status contained only this untracked report; the in-memory ASCII check returned true. git diff --check printed nothing for tracked changes; it does not validate an untracked report. The source appendix lists the files actually relied on. Read-only exploration used rg, Get-Content and Select-Object, with PowerShell in-memory line numbering. One attempted Get-Content server/interaction-routes.ts reported that the path did not exist; the actual server/engines/interaction-routes.ts was subsequently read. Some large combined outputs were truncated; the relevant source spans were read in smaller excerpts. The hostile-verifier skill's evidence discipline was applied locally; its separate dispatch workflow was not invoked under this task's exact command and write scope.

### Integrator evidence, not execution here

Read using Get-Content F:/Temp/andre/claude/F--Diomedes/e96b0c5b-6ccf-4f64-a907-b99ad1a4ae8d/scratchpad/cd01-r7-integrator-run.txt, with rg searches of the same file. The log identifies this exact HEAD and base, timestamp 2026-09-21T07:34:17Z, and clean status before and after mutations. It reports:

- TypeScript exit 0.
- Twelve focused suites: 212 tests passed. The verbose entries include all five added R-16 cases and the existing fourteen home cases.
- Full suite: 219 files passed; 4,229 tests passed, one skipped, 4,230 total. The skipped test is not a pass.
- The six round-7 mutation results tabulated above; round-5 mutations including M4 surviving alone; N1 through N9 killed; M4+N7 killed by two tests.

The supplied log supports the repaired candidate's executions. The pre-repair R-16, Ask and Plan observations are integrator disclosures in the brief/contract, not additional independent runs here. Source agrees with the described pre-guard paths.

## What the consumer lanes may build

**CD-02, server:** may build against the implemented message/select/outcome routes and shared/conversation.ts; canonical command/body binding, issued source identities, deterministic proposal digests, saved phases and receipt reconciliation; conditional phase claims and the source-run admission check. May rely on home GET returning a validated binding or null without provisioning, home POST provisioning/adopting under the Store lock, numeric server-owned settings.home revision 1, public-listing exclusion with inclusive internal recovery, and task-free home admission enforced by the current creation paths. Keep direct /ask unavailable in home. O5 is integrator validation on the ordinary update route, not a redesign for this lane.

**CD-05, client:** may build the Console home conversation using server-discovered project/thread IDs and Automatic/Ask/Plan messages. Persist one command and body per message, retry them unchanged, render authoritative outcomes, and use a separate consent-bearing selection bound to the shown proposal digest and target. Use /messages and /select, never home /ask. Do not infer a home or Work target from openProjects or the last-opened Project. Valid restriction controls remain available; home engine switching is not part of this accepted consumer contract. No client workaround for O5 is required.

**CD-02 must still treat as unclaimed:** sanitization or migration of contaminated development home state; non-Claude conversation support; Automatic plan-lineage hopping; portable context/audience handoff and target-result egress; conversational control, external sends and capability building; production tenant or shared-audience safety; model intent quality and real-provider verification. Preserve H5's single-owner local scope and H6's home-only context boundary.

**CD-05 must still treat as unclaimed:** a completed new page, first/returning-user launch integration, removal of the last-opened fallback, workspace-change preview/notification isolation and browser/installed-build validation. It must not present the server's deferred capabilities above as available. For both lanes, a Work receipt proves admission, not successful delivery or file application. The home identity and this repaired admission seam are implemented; wider product readiness is not established by this acceptance.

## Status

Pillar impact: the closure preserves the distinction between conversation and authorized Work destinations without a second Runtime or permission system. No pillar definition changes. Roadmap impact: no canonical document status was edited; CD-01's development seam is accepted with O5, and CD-02/CD-05 may proceed within the boundaries above.

Build/publication/deployment: local typecheck passed; independent tests were blocked before collection. No commit, push, merge, release, deployment or cloud write occurred. This report is the sole intended uncommitted addition; candidate source and tests were not changed.

## Source-read appendix

Files relied on, beyond the preservation diffs listed above:

- AGENTS.md; docs/DIOMEDES_CORE_PILLARS.md; docs/DIOMEDES_LIVE_ROADMAP.md; docs/DIOMEDES_PROJECT_MEMORY.md.
- docs/implementation/2026-09-21-core-agent-contract-review-r6.md; docs/implementation/2026-09-20-core-agent-contract.md.
- server/app.ts; server/store.ts; server/work.ts; server/native-work.ts; server/harness/bridge.ts; server/team/service.ts; server/connections/service.ts; server/file-imports.ts.
- server/engines/interaction-routes.ts; shared/ai-selection.ts; shared/conversation.ts.
- tests/home-conversation.test.ts; tests/interaction-seam.test.ts.
- The integrator log at the exact path above and C:/Users/andre/.agents/skills/hostile-verifier/SKILL.md.

Server-wide searches inventoried task/session insertions, assignments, creation calls and recovery/follow-up entrypoints. They are inventory evidence, not a claim of a fresh whole-server audit.
