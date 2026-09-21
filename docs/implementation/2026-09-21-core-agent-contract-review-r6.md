rejected

The five round-5 code defects are closed. The home identity, numeric revision, adoption and public-listing changes are also substantive repairs. The merged home lane nevertheless leaves a concrete Work entrypoint unguarded: POST /api/projects/:id/ask with Build or Fix bypasses both new home checks and can create a task and Work session in the reserved home Project. CD01-R-16 below reproduces this without a provider. That violates H2 and the retained O4 proof requirement, so this candidate is not an accepted frozen implementation for CD-02/CD-05.

## Candidate and scope

Reviewed feature/core-agent-contract at 976b68827454e6f625a2c7adf88717d8543bc1c0, base dadb72d4ce16f11c0f31c9fa52158a1e5e6f9a19. Before reading files, git status --short was empty and HEAD/branch matched. The six commits since ef5e366 matched the supplied list. The round-5 report is unchanged from f93681b; the four earlier reports and tests/interaction-contract.astra.test.ts are unchanged from e1ebe88.

This is a delta review of ef5e366..HEAD: 13 files, 1,462 insertions and 84 deletions. Source was read only from this worktree. The broader read of 148 server TypeScript files was an inventory of cancellation callers, not a new implementation audit. Repository mirror versions: Pillars 2026-09-19.1; Roadmap 2026-09-19.2; Project Memory 2026-09-19.2. No owner decision is reopened.

No source or test was edited. Only this report was created. The new counterexample below is a deterministic source trace and a proposed test against the existing seam helpers, not an independently executed test. Vitest could not load its configuration in this sandbox.

## Findings carried into this round

| Finding | Verdict | Closing evidence or remaining failure |
|---|---|---|
| CD01-R-05, P2 | closed | Replay resolution reads the thread's current control at server/app.ts:2557; message passes it into settle at server/interaction-service.ts:220. Both selection and reconciliation intersect it with the saved decision restriction at :260 and :325. Projection repair no longer writes Mode at server/app.ts:2795. |
| CD01-R-15, P2 | closed | Both task and Work admissions check the source run inside the Store lock at server/app.ts:2823 and :2835. Phase append uses the conditional claim at server/harness/claude-session-run.ts:401 and :464; RunService checks terminal state inside its serialized claim at server/harness/run-service.ts:547. See the ordering and remaining generic-claim behavior below. |
| CD01-R-14, P2 | closed | outcomeOf checks for a recorded decision before reporting answered at server/interaction-turn.ts:320, after authoritative receipts and refusals at :296 and :303. The service reads decisionOf(phases), with no in-memory substitute, at server/interaction-service.ts:321. |
| CD01-R-03, P2 | closed | server/harness/claude-session-run.ts:491 reads immutable turn documents and the step origin. server/app.ts:2738 uses that evidence during repair, including the original origin at :2773. Current account/model settings and source-file contents do not reconstruct history. |
| CD01-R-10, P2 | closed | The matcher handles the actual wrapped Runtime error at server/interaction-service.ts:147. locate reports attempt-based dispatched state at server/harness/claude-session-run.ts:457; server/app.ts:2571 distinguishes unsent turns, :2610 permits their replacement, and :2547 searches newest lineages first. |
| CD01-R-13 / O4 | narrowed, P2 | The original validator and identity gap closes at shared/types.ts:114, server/store.ts:179, :803, :809 and :825. Provisioning adopts and saves the binding last at :844 and :882. O4's home-is-never-a-Work-target remainder fails at server/app.ts:3351 and :3007, detailed as the new CD01-R-16. This is one remaining defect, not two separate failures. |

Earlier closures R-01, R-02, R-04, R-06, R-07, R-08, R-09, R-11, R-12 and F-2 remain closed for their original defects; body binding, the settled replay guard, deterministic selection, I-11's deferred-feature boundary and I-12 remain accepted within their recorded scopes.

### R-05: retry and restriction intersection

The two admission-producing entrypoints are message and select. A message retry of an answered command obtains control from the current thread, while its immutable body binding and saved decision retain the original Mode. Select obtains the same current control through host.locate at server/app.ts:2690. Both reach settle/read, which uses the narrower restriction. GET only reads. A wider current control cannot widen an Ask or Plan command: the saved restriction wins, and server/interaction-admission.ts:119 refuses work under either narrower Mode before selection can authorize it.

This closes the specified current-at-retry consultation gap, including a saved selection and a task already admitted before restart. It does not reinterpret a wider Mode as permission to rewrite an old command. The integrator's tests at tests/interaction-seam.test.ts:531 cover Ask and Plan after saved selection; :563 covers the task-admitted/Work-not-admitted boundary. Existing receipts remain readable. The projection test at :653 also asserts that repair leaves the newly narrowed Mode alone.

### R-14 and R-03: evidence survives incomplete persistence

The direct missing-decision counterexample is covered at tests/interaction-turn.test.ts:236. The HTTP case at tests/interaction-seam.test.ts:617 omits the decision after the real answer, reads while live, cancels, restarts, reads and resends the same body, and compares the settled run with its pre-read value. Missing evidence consistently reads as unresolved; a real receipt still takes precedence.

The failed-projection case at tests/interaction-seam.test.ts:653 now actually fails the projection persist, verifies no Turns were saved, changes both the selected file and account setting, restarts, narrows Mode, and repairs the projection. It checks source paths and deep equality with the original step's origin. The repaired origin is no longer synthesized from the present. The returned source paths match the existing Turn.sources representation; this is not a new file-version storage contract.

### R-13: what the home tests establish

Shape normalization precedes record loading; homeBinding validates the reserved Project and designated oldest thread on use. A forged settings PUT cannot write home because validateSettings deliberately never copies that supplied field (server/app.ts:232). GET provisions nothing; POST invokes the locked provisioner (server/app.ts:2861). The public listing filter is at server/app.ts:1282, while Store.projects remains inclusive at server/store.ts:727 and startup recovery still enumerates it at server/harness/host.ts:545.

The 14 cases in tests/home-conversation.test.ts cover wrong numeric revision (:258), malformed and string revision (:267), foreign Project (:284), non-oldest thread (:300), missing records (:324), client rebinding (:330), adoption (:345), the three persistence boundaries (:359, :370, :396), inclusive recovery and replay (:406), direct task/Work routes (:426), and conversation target resolution (:444). The first two crash cases seed the corresponding persisted prefix and then adopt without restarting; the binding and recovery cases do restart. Those are useful boundary fixtures, not evidence of killing a process at every write.

Removing home from openProjects during the final provisioning write is consistent with public-only hiding and compensates for createProject's automatic insertion. The historical revision: string snippet is explicitly superseded at contract:793; shared/types.ts:114 is numeric 1. Neither point is a defect. However, the two HTTP refusal cases cover /tasks and /work/start only. They do not prove the universal Work-target claim because /ask bypasses both guarded functions.

## R-15: cancellation inventory, ordering and claims

The complete production runs.cancel inventory in server is:

| Caller | Reach and lock |
|---|---|
| server/harness/routes.ts:184 | The generic run-cancel route. It can reach a claude-session run and explicitly holds store.locked at :183. The Codex branch separately calls bridge.stop under the same lock at :179. |
| server/harness/bridge.ts:189 | Cleanup of a run created by bridge.start. The capability is constrained to FORMAT_REPORT or CODEX_REPORT at :102; its run has a Work session. This is not a conversation run. |
| server/harness/bridge.ts:473 | bridge.stop resolves through its session-to-run map at :495. Conversation runs have no Work session, and host recovery excludes CLAUDE_SESSION_CAPABILITY from bridge.recover at server/harness/host.ts:549. This cannot target a conversation run through the current production paths. |
| server/harness/bridge.ts:633 | Host close cancels only CODEX_REPORT jobs. It has no Store lock here, but cannot target a conversation run. |
| server/harness/text-route.ts:216 | Abort callback for an ENGINE_TEXT_TURN run. No Store lock; the capability check at :176 rejects a conversation run before the callback is installed. |
| server/harness/text-route.ts:230 | Already-aborted check in that same text-request path, under the same capability restriction. No conversation-run reach. |
| server/connections/service.ts:858 | Explicit connection reauthorization cancels a prior connection inbox run. The run IDs come from ce- event identities (:678, :867), and connection admission creates a connection capability (:580), not CLAUDE_SESSION_CAPABILITY. It does not provide a caller-selected conversation run. |

Thus no current production cancellation caller can target a conversation run outside the Store lock. The test's direct app.locals call deliberately interposes a completed cancellation before admission; it is not a second exposed cancellation route.

The lock order is genuinely Store first, run queue second. assertLive is a read, not an atomic run-queue transaction. Nevertheless, while a task or Work admission holds the Store lock, the reachable conversation cancellation route cannot pass it. If cancellation acquires the Store lock first, assertLive sees the settled run; if admission acquires it first, cancellation comes after that admission. Keeping this order avoids the proposed run-queue-to-Store inversion.

There remains the ordinary distinction between admission winning the lock and work later executing: cancellation does not undo an already admitted task or session. There is also no new guarantee against an internal caller invoking runs.cancel directly without the Store lock after assertLive. No such production caller reaches this capability today. Future callers must preserve this ordering. These are the existing Runtime/admission boundaries, not the round-5 gap in which a completed cancellation was ignored before a new admission.

The opt-in does leave drive and control on unconditional claims (server/harness/claude-session-run.ts:590 and :835). A cancel that wins between their preliminary read and claim can still be followed by a lease renewal and journal event; RunService.claim at server/harness/run-service.ts:559 permits that by default. I do not claim global byte-immutability for those attempted operations. They cannot perform task/Work admission, and the subsequent Runtime step checks cancellation inside the queue before calling its handler at :605. An answered replay takes the earlier read branch at server/harness/claude-session-run.ts:546 and its missing-phase repair uses conditional append. Therefore this retained generic-claim behavior does not reopen the reviewed admission or settled-replay defect. Making all Runtime claims conditional would be broader than the required closure.

Tests/interaction-seam.test.ts:586 exercise both admission gaps. Tests/interaction-driver.test.ts:396 interposes cancellation before the serialized claim; :419 separately pins the opt-in's compatibility with other callers.

### M4 and N7

Keeping both guards is sound. For a run already settled when inspected, either the early check at server/harness/claude-session-run.ts:393 or the conditional claim at :464 refuses the append. For a cancellation after inspection, only the serialized conditional claim closes the race. M4 alone surviving is consequently expected and is not evidence of an unguarded append. The supplied log records N7 killed by the race test and M4+N7 killed by two tests. There is no requirement to delete the early fast path merely to force a one-guard/one-test correspondence.

## R-10: actual error shape and fixture

The round-5 trace was wrong about the catch: EngineService.seamError maps an otherwise unnamed HarnessError to RUNTIME_UNAVAILABLE at server/engines/service.ts:1755. It does not preserve the HarnessError class. The replacement matcher now recognizes both that wrapper and the direct blocked error, with the anchored budget exceeded wording.

This matcher is acceptable at this existing boundary. RunService emits that exact prefix for its three budget checks at server/harness/run-service.ts:668. Matching is limited to the two relevant error shapes and replacement is attempted once; importantly, a turn with an attempt still cannot be discarded as unsent. I do not require a new typed EngineService signal for this patch. If that boundary is redesigned later, the Runtime budget refusal should receive a typed translation in EngineService.seamError, consumed here, rather than adding a second exception hierarchy in the interaction driver.

The reduced-budget fixture meets the earlier closure bar. Tests/interaction-seam.test.ts:711 changes only the admitted budget through the Runtime store. It does not inject a fabricated budget exception or fake pending step. The next request reaches ensure, the real budget check and the real commit at server/harness/run-service.ts:614 and :676, and the test asserts pending/attempt 0 at :728. It also asserts one replacement, restart/replay ownership and historical replay. Sending another 126 setup messages would add runtime without exercising a different refusal path.

## New finding

### CD01-R-16 | open | P2 | The home Work prohibition is bypassed by /ask

The new refuseHomeWork helper protects createTaskFrom and admitWork (server/app.ts:1623 and :1812). The older /ask handler calls neither for its Build/Fix paths:

- For route sample, server/app.ts:3337 creates a task directly at :3344, persists it at :3350 and calls work.start at :3351. WorkService.start has no home check (server/work.ts:30). It records a real sample Work session at :86 and then either waits for review or starts its scheduled worker.
- For non-sample routes, server/app.ts:3139 calls startCodexWork, which creates a task directly at :2932 and calls nativeWork.start at :3007. NativeWorkService.start checks engine, consent, task and folder, but not reserved-home identity (server/native-work.ts:298).

This is a newly reachable integration defect when the reserved home is provisioned. The code is old, but applying a new home invariant only to two of its entrypoints does not enforce H2 (contract:750).

**Inputs and state:** a freshly provisioned home with no tasks or sessions, default settings, and its returned thread ID. POST /api/projects/<home.projectId>/ask with route sample, mode build, text Order plates, sources [], threadId home.threadId and consent true. No provider, forged run, changed settings or fabricated receipt is needed.

**Source-traced result:** HTTP 200, one home task, one home Work session, and the designated home thread changed from auto to build. The sample label and its permission Need do not make it cease to be a Work session or remove the task. The invariant is violated before any file change is approved. The non-sample branch has the same missing exclusion, although the deterministic reproducer uses sample and makes no claim of a live-provider run.

**Reproducer against tests/interaction-seam.test.ts helpers:**

```ts
test('R-16: the direct Build route cannot admit Work in the reserved home', async () => {
  const home = await api<{ projectId: string; threadId: string }>(
    '/home/conversation', 'POST', {},
  );
  const response = await request('/projects/' + home.projectId + '/ask', 'POST', {
    threadId: home.threadId,
    route: 'sample',
    mode: 'build',
    text: 'Order plates',
    sources: [],
    consent: true,
  });
  const state = store().state(home.projectId);
  expect({
    status: response.status,
    tasks: state.tasks.length,
    sessions: state.sessions.length,
    mode: state.conversations.find((item) => item.id === home.threadId)!.mode,
  }).toEqual({ status: 409, tasks: 0, sessions: 0, mode: 'auto' });
});
```

At HEAD the traced actual object is { status: 200, tasks: 1, sessions: 1, mode: 'build' }. This test was not appended or executed here.

**Smallest closure:** enforce reserved-home exclusion before any task, session or thread mutation in the direct Build/Fix admissions, including startCodexWork and the sample branch, or in a genuinely shared admission boundary that both reach. Use the reserved Project identity, not the validity of settings.home. Keep ordinary conversation reads available. Add HTTP regressions for sample Build/Fix and a fake-native path, asserting refusal before task/session creation or dispatch and no home-thread mutation. An ordinary Project must retain its existing behavior. Do not implement a second permission system or disable all conversation routes as a workaround.

## Obligations

This is a rejection, not acceptance with integrator obligations. No new nonblocking obligation substitutes for CD01-R-16.

Retained O4 belongs to the integrator in server/app.ts and the home/seam tests: its remaining home Work-target requirement is complete only when CD01-R-16's direct-route regressions pass alongside the existing home tests. The validator, binding, adoption and recovery work need not be rewritten. R-13 and O4 remain narrowed to that single blocking defect.

## Independent verification

Exact validation commands:

```text
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run tests/interaction-seam.test.ts tests/interaction-driver.test.ts tests/interaction-turn.test.ts tests/home-conversation.test.ts tests/interaction-contract.astra.test.ts
```

TypeScript exited 0 with no diagnostics. Its running tool session was polled to completion. Vitest was attempted once and exited 1 before loading tests: EPERM opening node_modules/.vite-temp/vitest.config.ts.timestamp-1789974763630-eb28e9eaed38d.mjs. Zero tests ran independently and zero are reported as passing. There was no retry, junction change, install, full suite, browser, build, package or live model call.

Exact identity and diff commands, with repeated identical invocations listed once:

```text
git status --short
git log -1 --format="%H %D"
git show -s --format="%H" dadb72d4ce16f11c0f31c9fa52158a1e5e6f9a19
git log --oneline --reverse ef5e366..HEAD
git diff f93681b HEAD -- docs/implementation/2026-09-21-core-agent-contract-review-r5.md
git diff e1ebe88 HEAD -- docs/implementation/2026-09-20-core-agent-contract-review.md docs/implementation/2026-09-20-core-agent-contract-review-r2.md docs/implementation/2026-09-20-core-agent-contract-review-r3.md docs/implementation/2026-09-20-core-agent-contract-review-r4.md tests/interaction-contract.astra.test.ts
git diff ef5e366..HEAD
git diff ef5e366..HEAD --stat
git diff ef5e366..HEAD -- server/app.ts server/store.ts shared/types.ts
git diff ef5e366..HEAD -- server/interaction-service.ts server/interaction-turn.ts server/harness/claude-session-run.ts server/harness/run-service.ts
git diff ef5e366..HEAD -- server/store.ts
git diff ef5e366..HEAD -- tests/interaction-driver.test.ts tests/interaction-turn.test.ts
git diff ef5e366..HEAD -- tests/interaction-seam.test.ts
```

All exited 0. The protected-artifact diffs printed nothing. Status was empty initially and immediately before this report. The initial broad diff was too large for one displayed response; the focused deltas and stored full source reads supplied the review anchors.

The completed report was read back with git diff --no-index -- /dev/null docs/implementation/2026-09-21-core-agent-contract-review-r6.md (exit 1 for the expected nonempty diff). An in-memory check verified ASCII text and the written report against the prepared content. Final git status --short contained only this new report.

The read-only source commands are expanded in the appendix. Every git show read exited 0. Excerpting, line numbering and cancellation matching were performed in memory over those results. The initial reads also used these exact read-only commands, each exiting 0:

```text
Get-Content docs/implementation/2026-09-21-core-agent-contract-review-r5.md
Get-Content docs/implementation/2026-09-20-core-agent-contract.md -TotalCount 180
Get-Content C:/Users/andre/.agents/skills/hostile-verifier/SKILL.md
```

The skill's separate delegated workflow was not invoked; this task's exact scope controlled. No subagent or external verifier was used.

### Integrator evidence, not execution here

Read with:

```text
git diff --no-index -- /dev/null F:/Temp/andre/claude/F--Diomedes/e96b0c5b-6ccf-4f64-a907-b99ad1a4ae8d/scratchpad/cd01-r6-integrator-run.txt
```

The no-index diff exited 1 because the file differs from /dev/null; that is not a failed test. The file identifies HEAD 976b688 and the exact base, dated 2026-09-21T07:05:57Z. It records TypeScript exit 0; 12 focused files and 207 tests passed; full suite 219 files passed, 4,224 tests passed, 1 skipped, 4,225 total. The focused heading says ten suites, but the actual summary says twelve. The skipped test is not a pass.

The same file records N1 through N9 killed; M4 survives by itself, and M4+N7 is killed by the claim-race and settled-run tests. Its verbose home output contains the 14 cases inspected above. The worker's separate claim that three home-guard removals failed tests is not accompanied by those mutation runs in this file, so I do not upgrade that disclosure to independently inspected mutation evidence. None of the provided tests contains the /ask home counterexample.

## Consumer boundary

**CD-02 server:** may retain and extend the repaired message/select/outcome wire contract, canonical command binding, server-issued source identity, deterministic selection digest, saved phases, receipt lookup, conditional phase claims and AdmissionSource run check. Home GET returns a validated { projectId, threadId } or null without provisioning; POST provisions/adopts that identity under the Store lock. Settings.home has server-owned numeric revision 1. Keep recovery's Store.projects enumeration inclusive. These shapes need no rewrite for CD01-R-16, but the server must close that defect before claiming the code frozen or home excluded from every Work route.

**CD-05 client:** may build against shared/conversation.ts and the home GET/POST shapes: Automatic/Ask/Plan, one persisted command/body per message retry, server-issued source identity, proposed work with digest and target, a separate consent-bearing selection, and authoritative outcome reads. Discover home through the server; do not infer it from openProjects or the last-opened Project. The new conversation page must use /messages and /select rather than the older /ask Build/Fix route. Hiding that route in the client does not close CD01-R-16, and this verdict does not grant an accepted production freeze.

**Both lanes must still treat as unclaimed:** universal home Work exclusion pending R-16; the new client page and first/returning-user launch integration in this candidate; removal of the client's last-opened fallback; Automatic plan-lineage hopping; portable/context/audience handoff and target-result egress; conversational control, external sends and capability building; non-Claude conversation support; production tenant/shared-audience safety; model intent quality; real-provider and installed-build verification. A Work receipt proves admission, not successful artifact delivery or file application. The implemented home identity should no longer be described as absent, but the full O4 invariant is not complete.

**Pillar impact:** the repairs preserve Runtime/Trust reuse, historical attribution and Mode ceilings. R-16 violates the approved separation between the home conversation and authorized Work destinations. No pillar meaning changes.

**Roadmap impact:** no document status was changed. CD-01 acceptance is blocked by R-16 alone, with R-13/O4 narrowed to that same remainder.

**Build/publication/deployment:** local typecheck passed; independent tests were blocked before collection. No build, commit, push, merge, release, deployment or cloud write. Candidate code and tests remain untouched. This report is the sole uncommitted addition; nothing was published.

## Source-read command appendix

Repeated commands are listed once. The server directory reads below enumerated all 148 server TypeScript files for the cancellation inventory. Full outputs were retained in memory; only relevant matches and excerpts were displayed.

```text
git show HEAD:server
git show HEAD:server/business
git show HEAD:server/change-review
git show HEAD:server/connections
git show HEAD:server/discovery
git show HEAD:server/engines
git show HEAD:server/harness
git show HEAD:server/harness/capabilities
git show HEAD:server/inventory
git show HEAD:server/local
git show HEAD:server/outcome-evidence
git show HEAD:server/readiness
git show HEAD:server/rehearsal
git show HEAD:server/team
git show HEAD:server/trust
git show HEAD:server/workforce
git show HEAD:docs/DIOMEDES_CORE_PILLARS.md
git show HEAD:docs/DIOMEDES_LIVE_ROADMAP.md
git show HEAD:docs/DIOMEDES_PROJECT_MEMORY.md
git show HEAD:docs/implementation/2026-09-20-core-agent-contract-review-r4.md
git show HEAD:docs/implementation/2026-09-20-core-agent-contract.md
git show HEAD:docs/implementation/2026-09-21-core-agent-contract-review-r5.md
git show HEAD:server/agents.ts
git show HEAD:server/app-updates.ts
git show HEAD:server/app.ts
git show HEAD:server/approval-admission.ts
git show HEAD:server/billing-events.ts
git show HEAD:server/build-identity.ts
git show HEAD:server/business/account-contract.ts
git show HEAD:server/business/account-routes.ts
git show HEAD:server/business/account-service.ts
git show HEAD:server/business/account-store.ts
git show HEAD:server/business/identity-host.ts
git show HEAD:server/business/identity-workos.ts
git show HEAD:server/capability-packs.ts
git show HEAD:server/change-review/checks.ts
git show HEAD:server/change-review/fixtures.ts
git show HEAD:server/change-review/git.ts
git show HEAD:server/change-review/recorded.ts
git show HEAD:server/change-review/render.ts
git show HEAD:server/change-review/rules.ts
git show HEAD:server/change-review/service.ts
git show HEAD:server/change-review/snapshot.ts
git show HEAD:server/change-review/structured.ts
git show HEAD:server/change-review/text-evidence.ts
git show HEAD:server/command-admission.ts
git show HEAD:server/configuration-routes.ts
git show HEAD:server/configuration.ts
git show HEAD:server/connections/compiled-fixture.ts
git show HEAD:server/connections/compiler-demo.ts
git show HEAD:server/connections/credentials.ts
git show HEAD:server/connections/desktop.ts
git show HEAD:server/connections/fixture-model.ts
git show HEAD:server/connections/fixture.ts
git show HEAD:server/connections/mcp-projection.ts
git show HEAD:server/connections/openapi-candidate.ts
git show HEAD:server/connections/service.ts
git show HEAD:server/connections/toast.ts
git show HEAD:server/customization-benefit-routes.ts
git show HEAD:server/customization-benefit.ts
git show HEAD:server/customization-gate.ts
git show HEAD:server/discovery.ts
git show HEAD:server/discovery/routes.ts
git show HEAD:server/discovery/service.ts
git show HEAD:server/engines/acp-client.ts
git show HEAD:server/engines/binding-store.ts
git show HEAD:server/engines/claude-session-routes.ts
git show HEAD:server/engines/claude-session.ts
git show HEAD:server/engines/claude.ts
git show HEAD:server/engines/contract.ts
git show HEAD:server/engines/cursor.ts
git show HEAD:server/engines/devin.ts
git show HEAD:server/engines/install.ts
git show HEAD:server/engines/interaction-routes.ts
git show HEAD:server/engines/login.ts
git show HEAD:server/engines/omp.ts
git show HEAD:server/engines/opencode.ts
git show HEAD:server/engines/process.ts
git show HEAD:server/engines/service.ts
git show HEAD:server/engines/sse.ts
git show HEAD:server/engines/verification.ts
git show HEAD:server/execution.ts
git show HEAD:server/file-imports.ts
git show HEAD:server/harness/adapters.ts
git show HEAD:server/harness/approval.ts
git show HEAD:server/harness/bridge.ts
git show HEAD:server/harness/capabilities/format-report.ts
git show HEAD:server/harness/claude-session-run.ts
git show HEAD:server/harness/codex-engine.ts
git show HEAD:server/harness/conformance.ts
git show HEAD:server/harness/evaluation-adapter.ts
git show HEAD:server/harness/evaluation-price.ts
git show HEAD:server/harness/evaluation.ts
git show HEAD:server/harness/fixture-adapter.ts
git show HEAD:server/harness/host.ts
git show HEAD:server/harness/index.ts
git show HEAD:server/harness/instruction-delivery.ts
git show HEAD:server/harness/lifecycle.ts
git show HEAD:server/harness/native-agent.ts
git show HEAD:server/harness/policy.ts
git show HEAD:server/harness/present.ts
git show HEAD:server/harness/route-contract.ts
git show HEAD:server/harness/routes.ts
git show HEAD:server/harness/run-service.ts
git show HEAD:server/harness/run-store.ts
git show HEAD:server/harness/text-route.ts
git show HEAD:server/harness/tools.ts
git show HEAD:server/harness/trust-port.ts
git show HEAD:server/index.ts
git show HEAD:server/integrations.ts
git show HEAD:server/interaction-admission.ts
git show HEAD:server/interaction-service.ts
git show HEAD:server/interaction-turn.ts
git show HEAD:server/inventory/catalog.ts
git show HEAD:server/inventory/commands.ts
git show HEAD:server/inventory/import.ts
git show HEAD:server/inventory/ledger.ts
git show HEAD:server/inventory/receipt-routes.ts
git show HEAD:server/inventory/stock-repository.ts
git show HEAD:server/inventory/stock-service.ts
git show HEAD:server/local/hardware.ts
git show HEAD:server/lock.ts
git show HEAD:server/managed-gateway.ts
git show HEAD:server/managed-usage-routes.ts
git show HEAD:server/managed-usage.ts
git show HEAD:server/models.ts
git show HEAD:server/modes.ts
git show HEAD:server/native-work.ts
git show HEAD:server/outcome-evidence/projection.ts
git show HEAD:server/paths.ts
git show HEAD:server/permission-routes.ts
git show HEAD:server/readiness/instructions.ts
git show HEAD:server/readiness/product-knowledge.ts
git show HEAD:server/readiness/projection.ts
git show HEAD:server/readiness/routes.ts
git show HEAD:server/rehearsal/fixture-template.ts
git show HEAD:server/rehearsal/industry-registry.ts
git show HEAD:server/rehearsal/prospect-configuration.ts
git show HEAD:server/rehearsal/service.ts
git show HEAD:server/rules.ts
git show HEAD:server/secrets.ts
git show HEAD:server/store.ts
git show HEAD:server/support-bundle.ts
git show HEAD:server/task-admission.ts
git show HEAD:server/team/board.ts
git show HEAD:server/team/mailbox.ts
git show HEAD:server/team/mcp.ts
git show HEAD:server/team/prompts.ts
git show HEAD:server/team/routes.ts
git show HEAD:server/team/service.ts
git show HEAD:server/theme-assets.ts
git show HEAD:server/theme-routes.ts
git show HEAD:server/themes.ts
git show HEAD:server/trust/authority.ts
git show HEAD:server/trust/codex-reviewer.ts
git show HEAD:server/trust/environments.ts
git show HEAD:server/trust/index.ts
git show HEAD:server/trust/reviewer.ts
git show HEAD:server/trust/revocation.ts
git show HEAD:server/trust/scope-grants.ts
git show HEAD:server/trust/types.ts
git show HEAD:server/usage.ts
git show HEAD:server/website-studio.ts
git show HEAD:server/weekly-brief.ts
git show HEAD:server/work-admission.ts
git show HEAD:server/work-control.ts
git show HEAD:server/work.ts
git show HEAD:server/workforce/constraints.ts
git show HEAD:server/workspace-routes.ts
git show HEAD:server/workspaces.ts
git show HEAD:shared/conversation.ts
git show HEAD:shared/types.ts
git show HEAD:tests/home-conversation.test.ts
git show HEAD:tests/interaction-driver.test.ts
git show HEAD:tests/interaction-seam.test.ts
git show HEAD:tests/interaction-turn.test.ts
```
