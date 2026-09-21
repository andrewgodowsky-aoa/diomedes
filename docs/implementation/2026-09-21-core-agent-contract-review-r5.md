rejected

The replay body comparison, driver-owned phases, deterministic proposal selection and Mode migration are substantive repairs. The conservative selection mechanism needs no further owner decision. However, retrying a selected message can bypass a subsequently narrowed Mode, cancellation between an input phase and admission can still start work, and budget exhaustion does not replace the exhausted lineage. Replay also loses historical projection metadata, and the outcome endpoint reports an absent decision as answered. These are concrete defects in the candidate code, not objections to the unclaimed home, client, handoff or provider work. CD-02 and CD-05 cannot treat HEAD as an accepted frozen implementation.

## Scope and identity

Reviewed HEAD `ef5e366b2c0c27bfdc7ffa1f1b54a39916e14156`, branch `feature/core-agent-contract`, against base `dadb72d4ce16f11c0f31c9fa52158a1e5e6f9a19`, in the assigned worktree. Before reading files, `git status --short` was empty and both commit identities matched. The supplied eleven-entry commit list matched. The diff from `e1ebe88` to HEAD for the four earlier reviews and `tests/interaction-contract.astra.test.ts` was empty. The disclosed intermediate typecheck problem was not reviewed as a HEAD defect.

Repository mirrors: Pillars **2026-09-19.1**, Roadmap **2026-09-19.2**, Project Memory **2026-09-19.2**. The newest owner instructions govern this review. Source came only from this worktree's candidate. No main-checkout application source, delegation, cloud write, rebase or publication was used. The dependency junction was used for the permitted checks only.

All counterexamples below are deterministic source traces and proposed seam tests, not tests executed successfully in this review. Vitest failed before loading tests. No counterexample tests were appended; only this report was written. `contract` below means `docs/implementation/2026-09-20-core-agent-contract.md` at HEAD.

## The four carried findings

### CD01-R-03 | narrowed | P2 | Body binding closes; projection recovery loses original evidence

**Closed:** `commandBinding` hashes the parsed text, Mode, ordered source path/SHA pairs and action (`server/interaction-turn.ts:46`). The conversation action is deliberately the constant `message`, because this route's client does not choose start versus resume. The host computes the binding before current settings or source reads (`server/app.ts:2507`). The driver persists it on the immutable turn (`server/harness/claude-session-run.ts:556`) and compares it before splitting, phase repair, returning an answer or projection (`:327`). A saved binding compared with an absent retry binding fails. The legacy branch compares the actual prompt, documents, transport action, source run and pinned instructions; it cannot bypass a binding that exists. Model/account changes do not rebuild the command comparison.

This closes the round-4 same-ID/different-body defect before or after projection, after restart, on settled or retired lineages and across Mode switches. Historical lookup precedes current configuration (`server/app.ts:2524`), but output still passes through the comparison. A mismatched body cannot reach `host.project` or `settle`. An in-flight different intent is also refused by `request` (`server/harness/claude-session-run.ts:248`). The integrator's driver tests cover binding loss and legacy comparison; its HTTP tests cover changed text/Mode/sources and retired replay.

**Remaining:** the round-4 closure also required preserving original projection inputs and attribution. The replay host returns `documents: [], model: '', accountRoute: ''` (`server/app.ts:2540`). When projection is missing, `project` builds both Turns' sources from that empty list (`:2703`), substitutes the reported model for the original requested model (`:2732`), and substitutes the current account setting for the historical account route (`:2735`). The original documents and origin exist in the turn/run evidence (`server/harness/claude-session-run.ts:560`, `:735`). This is not permission to invent historical provenance from current settings.

**Reproducer against the seam helpers:** create `prices.md` in `project.folder` and send `message('m-source', 'Compare the prices', { sources: [{ path: 'prices.md', sha: hash(contents)! }] })`. Wrap `store().persist` to throw once, before its original implementation, when the supplied state first contains the projected Turns for this thread. Restore the method afterward. The POST fails after the model answer and decision have committed, with no transcript projection persisted. Change `store().settings.services['claude-codeAccountRoute']` to a different fixture route, save the settings, then `close(); open()` and resend the exact original command/body. Source trace result: HTTP 200 without another dispatch, but both recovered Turns have `sources: []` and the assistant origin names the new route. If the provider reported a different model slug from the requested slug, the recovered requested-model attribution also differs from the saved origin. Compare the repaired projection directly with the immutable model step's origin and input, not only its text.

**Smallest closure:** restore projection metadata from the original run/turn after validating the binding. Preserve original source identities and requested/reported model/account attribution; do not reread documents or settings to reconstruct history. Add the actual failed-projection/restart test with selected sources and changed settings. The HTTP test at `tests/interaction-seam.test.ts:391` is titled "before and after projection", but its first operation completes `send`; it does not exercise the missing-projection state. The former P1 payload mismatch is closed; the remaining evidence defect is P2.

### CD01-R-14 | narrowed | P2 | Terminal writes close; absent first-phase outcomes are not truthful on every route

**Closed:** `drive` reads an answered command first (`server/harness/claude-session-run.ts:494`). Replay returns the recorded result and performs no claim or phase append on an already settled run (`:351`). Missing live phases reacquire the lease through `append` (`:379`); missing settled phases are refused before claim (`:393`). Existing equal phases are an idempotent no-op. The service refuses a settled selection (`server/interaction-service.ts:231`) and exits settled reconciliation before admission (`:359`). Input phases precede task and Work admission (`:375`, `:397`), and derived receipt lookup prevents duplicate successful admissions. The original circular callback, private-owner and terminal-replay-write defects are closed. The driver suite contains real restart repair and missing-phase/cancelled-run tests (`tests/interaction-driver.test.ts:208`, `:250`).

**Remaining:** GET outcome passes no unsaved decision to `read` and ignores `located.answered` (`server/interaction-service.ts:278`). With no decision phase, `verdict` is null (`:311`); `outcomeOf` returns `answered` before considering settled state (`server/interaction-turn.ts:318`). Thus a settled run missing phase 1 is not always `unresolved`, contrary to I-9 and the requested closure. The same GET can report answered for a turn that never succeeded. A POST replay of an ordinary answer with no first phase similarly returns answered through the inert branch; a valid action proposal instead reaches unresolved. The outcome depends on the route/content rather than the missing evidence.

**Reproducer against the seam helpers:** wrap `driver().request` for one message so its `input.interaction.decide` throws after the real model step returns, as `dieAfterTheAnswer` already does in the driver fixture. POST `message('m-gap', 'ACT order the usual')`, restore the wrapper, find the run from the persisted thread lineage, and cancel it through `app.locals.harness.runs.cancel`. After `close(); open()`, GET `messages() + '/m-gap'`. Source trace result: HTTP 200, `answerText: null`, `outcome: { status: 'answered' }`, with no decision phase. POSTing the same original body returns `unresolved`. Both reads must instead preserve the defined unresolved evidence state and leave the terminal run byte-equivalent. A direct pure counterexample is `outcomeOf([], { projectId: null, taskId: null, sessionId: null }, null, { settled: true })`, which returns answered.

**Smallest closure:** make missing first-phase/unfinished-turn evidence explicit on the read path, consistently for GET and POST. Preserve authoritative existing receipts and refusals, but do not treat absence as a completed decision. Add cancelled and unfinished cases for the actual GET endpoint. Cancellation racing admission is the separate new finding R-15 below; the sequential terminal guards themselves are real repairs.

### CD01-R-05 | narrowed | P2 | Trusted selection closes model-only escalation; retry ignores the current Mode

**Closed:** the eight admission rules cannot return escalate without a matching selection (`server/interaction-admission.ts:119`). The digest binds source identity, disposition, operation class, target, summary and refs (`:34`); the service derives source identity from the route command, not a client/model echo (`server/interaction-service.ts:238`). Another existing message's digest, stale words, another target or an unknown command cannot select this proposal. Ask/Plan ceilings precede selection. Settled selections are refused and completed selections/re-sends find the same receipts. No task/Work admission is reachable from model output alone. The adversarial C06 case under Automatic therefore closes, and the pure admission tests cover adversarial valid proposals under both narrower modes.

**Ruling on the withdrawn interpretation:** the replacement mechanism is the conservative mechanism described in round 4. It weakens no settled guarantee and requires no owner decision. No owner reply to the status note is assumed. There is no reason to retain the earlier semantic objection.

**Remaining:** `/select` uses the current stored Mode through `host.locate` (`server/app.ts:2671`), but message retry uses the old command's Mode through `resolve` (`:2505`, `:2532`). `message` passes that old restriction to `settle` (`server/interaction-service.ts:197`); `settle` calls the driver's locate, which has no current Mode, and `read` narrows against the old restriction again (`:315`). A previously saved selection can therefore start work after the person has narrowed the control. This requires a saved selection, not model-only escalation.

**Reproducer, using the seam's existing crash-state technique:**

```ts
const p = await send('m-act', 'ACT order the usual');
if (p.outcome.status !== 'proposed') throw new Error('expected proposal');
await driver().record(project.id, p.runId, [{
  phase: 'action-selected',
  sourceMessageId: p.sourceMessageId,
  body: {
    sourceMessageId: p.sourceMessageId,
    proposalDigest: p.outcome.proposalDigest,
    projectId: project.id,
  },
}]); // Crash after selection persisted, before task-input/admission.
await close();
await open();
await send('m-narrow', 'Only answer now', { mode: 'ask' });
expect((await select('m-act', p.outcome.proposalDigest)).status).toBe(409);
const replay = await send('m-act', 'ACT order the usual');
// Required: no new task or Work receipt. Source trace at HEAD: started, one of each.
expect(workFor(p.sourceMessageId)).toEqual({ tasks: [], sessions: [] });
```

The setup is a reachable interruption point explicitly created by the selection-before-admission order, and follows the existing fixture at `tests/interaction-seam.test.ts:480`. Changing the Mode through PUT instead of sending `m-narrow` produces the same result. The old message already has a projection, so the host returns before updating the thread Mode (`server/app.ts:2694`); this is an actual bypass while the stored Mode remains Ask. Plan has the same defect.

**Smallest closure:** separate the immutable command restriction used for binding/decision replay from the fresh control restriction used for admission. Every resume path must consult the current control and apply the narrower ceiling before either new task or new Work admission. A replay repairing projection must also not overwrite a newer Mode choice at `server/app.ts:2743`. Test a crash after selection and after task admission, followed by Ask/Plan narrowing and an unchanged-body retry. Existing receipts remain readable; narrowing must stop only admissions that have not happened.

### CD01-R-13 | narrowed | P3 | O4 remains bounded integration work

The candidate expressly does not provision home (`contract:110`); the host really returns `homeProjectId: null` (`server/app.ts:2747`). The pure home guards exist (`server/interaction-admission.ts:128`), but no HTTP proof of a reserved home is claimed. The canonical oldest-thread rule and server ownership remain specified at `contract:331`; the designated-thread and numeric-revision validation gap remains at `contract:340`. This is still bounded integration work and is not a reason for rejection. O4 remains below.

**Earlier closures:** R-01, R-02, R-04, R-06, R-07, R-08, R-09, R-11, R-12 and F-2 remain closed for their original defects. R-10 regresses in budget-triggered replacement, detailed below. Closure of a specified launch/home/client design is not a claim that those deferred features are implemented.

## I-11, I-12 and the mutation evidence

**I-11 is an honest boundary.** The new conversation routes own Automatic and resolve the run themselves (`server/engines/interaction-routes.ts:11`, `:74`); the explicit session route is unchanged. Keeping its Ask/Plan enum is consistent with the marked supersession at `contract:504`. Plan-lineage hopping and portable handoff are not implemented. Conversational control, sends and capability building return blocked and have no execution branch (`server/interaction-admission.ts:88`). Home is absent; Mode migration is merged. The three presentation files changed for Mode compatibility, but there is no new conversation page/client integration. I found no effective Round-5 claim of a shipped home, handoff, client page, real-provider proof or installed-build proof. The older "Nothing here is implemented" header and old work-order footer are stale historical packaging, not reasons to reject the code or upgrade its claims.

**I-12 is faithful, not cap evasion.** `QUESTIONS.md:661` deliberately separates short plain-English Mode wording from the machine contract. The unchanged cap test is `tests/modes.test.ts:37`. Reading the pre-repair and current literals and comparing them in memory gives 694 characters for the current Mode text and 1,760 for Mode plus two newlines plus `DECISION_FORMAT`; the combined string is exactly equal to the pre-repair string. `instructionsFor` composes it only for Automatic (`server/interaction-turn.ts:97`), and the host actually calls it (`server/app.ts:2512`). Ask/Plan keep their original instructions. Schema validity and these byte comparisons do not prove model judgment.

**The M4 mutation is defence in depth, with a limited claim.** The service prevents an already settled run reaching append, so removing the driver's terminal guard need not fail a sequential HTTP test. The independent driver test must kill it, and the integrator's log says it does. This is not itself an HTTP seam defect. It also does not prove cancellation during the gap between phase recording and admission; R-15 exercises that different gap. The ten HTTP tests do not implement the full requested crash matrix: the named before-projection test starts after projection, the receipt test seeds a task receipt, and the cancelled replay test begins with phase 1 present. `close(); open()` reloads persisted data, but only seeded/intercepted boundaries demonstrate the particular crash window claimed.

The disclosed Mode-lane expansions are acceptable: excluding Automatic from worker definitions and adding a runtime refusal reinforce the stated worker boundary; exporting an unchanged picker array is mechanical. O1 through O3's migration changes are present, typecheck, and have the integrator's focused evidence. The new page's actual presentation remains CD-05 work.

## New finding

### CD01-R-15 | open | P2 | Cancellation between a recorded input and admission still starts work

**Evidence:** `settle` reads settled state once (`server/interaction-service.ts:353`), then records each input before calling the host (`:397`, `:403`). Recording is not atomic with admission. `InteractionHost.startWork` receives only target project and work payload (`:111`); the implementation checks neither the source conversation nor its current state (`server/app.ts:2774`). A cancellation after `work-input` commits but before that host call is therefore invisible to admission. The subsequent receipt-phase write fails because the source run is now settled, after the new Work has already started.

**Reproducer against the HTTP seam:**

```ts
const p = await send('m-cancel-gap', 'ACT order the usual');
if (p.outcome.status !== 'proposed') throw new Error('expected proposal');
const d = driver();
const record = d.record.bind(d);
d.record = async (...args: Parameters<typeof record>) => {
  await record(...args);
  if (args[2].some((phase) => phase.phase === 'work-input')) {
    await app.locals.harness.runs.cancel(
      p.runId, 'cancel before Work admission', localHarnessPrincipal(project.id),
    );
  }
};
try {
  const response = await select('m-cancel-gap', p.outcome.proposalDigest);
  // Source trace: 409 RUN_SETTLED from writing work-receipt, AFTER Work starts.
  expect(response.status).toBe(409);
  expect(workFor(p.sourceMessageId).sessions).toHaveLength(0);
} finally {
  d.record = record;
}
```

The required zero-sessions assertion fails by the source sequence: one session/receipt exists. This interposes cancellation at an actual awaited boundary, without fabricating a receipt or changing the decision. Interposing after `task-input` likewise permits task creation after cancellation. Previously admitted work need not be undone; this case cancels before the new admission.

There is also a narrower claim race: the driver's settled checks precede separately awaited `RunService.claim` calls (`server/harness/claude-session-run.ts:393`, `:535`, `:786`). `RunService.claim` serializes its own write but does not recheck terminal state (`server/harness/run-service.ts:534`). Cancellation can win between check and claim, after which claim renews the settled run's lease/evidence. The sequential answered-first path does not have that problem; the claim must be described with that qualification.

**Smallest closure:** carry the source run/message into admission and make cancellation eligibility effective at the new-admission boundary, coordinated with the existing Runtime cancellation ordering. Recording an input phase alone is insufficient. Preserve current task/Work admission and receipt replay; add no parallel permission or run-state store. Put any required terminal-claim guard inside the Runtime's serialized claim operation or an equivalently serialized conditional operation. Prove cancellation before task admission, before Work admission, and between driver inspection and claim. This is a server seam repair, not a client confirmation obligation.

## Regressed earlier closure

### CD01-R-10 | narrowed again | P2 | Budget refusal leaves a pending turn that prevents lineage replacement

Historical lookup, terminal replacement and generation persistence are implemented (`server/app.ts:2524`, `:2574`). Budget replacement is not. `RunService.step` creates the pending turn via `ensure` before checking budget (`server/harness/run-service.ts:599`); the budget-refused new step is committed (`:661`). `InteractionTurns.message` catches the budget refusal and resolves with `replace: 'budget'` (`server/interaction-service.ts:170`). That resolution now finds the pending turn, so `if (current && options.replace && !located)` is false (`server/app.ts:2578`). It reuses the exhausted run and the second call fails again. Subsequent new messages repeat this pattern.

**Reproducer against the seam helpers:** send 128 distinct ordinary Automatic messages with `send('m-budget-' + i, 'Hello ' + i)`, for `i` from 0 through 127. Each uses one model call. POST `message('m-budget-128', 'One more')` through `request`. Source trace result: 409 `blocked` with budget exceeded, dispatch count still 128, and only generation 1 with no budget retirement. The run has a pending model step for `m-budget-128` with attempt 0. A fresh command `m-budget-129` still does not produce generation 2. Expect the 129th message to admit a replacement once, then replay that same command without another dispatch. An equivalent fixture can lower the admitted budget to avoid 128 setup messages, but it must reproduce the real pending-step write before refusal.

**Smallest closure:** distinguish a never-dispatched budget-refused turn from an uncertain/dispatched turn when admitting replacement. Record which generation owns the replacement attempt so restart/retry finds that attempt unambiguously. Preserve the old pending evidence and all budget/scope guards. Do not merely drop `!located` and silently regenerate possibly dispatched work. Test budget exhaustion at the real RunService boundary, replacement, restart and replay. This reopens the lifetime/continuation portion of R-10, not its repaired historical lookup.

## Retained integrator obligation

This is a rejection, not acceptance with obligations. No defect above is downgraded to an obligation. The pre-existing nonblocking obligation remains:

1. **O4, CD-02h:** `shared/types.ts`, `server/store.ts`, `server/app.ts`. Implement server-owned `Settings.home` with numeric revision 1, validate the reserved Project and designated oldest Conversation after records are available and on use, and repair invalid bindings by adopt-before-create with binding last. Wire its identity into interaction admission and public-only filtering. Later review must see wrong revision/shape, missing/foreign/non-oldest thread, client rebinding and crash-boundary tests, no duplicate home records, preserved internal recovery enumeration, and HTTP proof that home is never a Work target. Its absence alone still does not reject CD-01.

## Verification and command record

**Executed here:**

```text
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run tests/interaction-seam.test.ts tests/interaction-driver.test.ts tests/interaction-admission.test.ts tests/interaction-turn.test.ts tests/auto-mode-migration.test.ts tests/interaction-contract.astra.test.ts
```

TypeScript exited 0 with no diagnostics. Vitest exited 1 before loading any test, failing to write `node_modules/.vite-temp/vitest.config.ts.timestamp-1789972385235-020c244de7ecd.mjs` with EPERM. Zero tests executed here; none counted as passing. It was attempted once, with no workaround or junction modification. The running TypeScript command was polled to its exit through the tool's existing session.

Identity/diff commands run, all successful; status was repeated before and after writing this report:

```text
git status --short
git log -1 --format="%H %D"
git log -1 --format="%H" dadb72d4ce16f11c0f31c9fa52158a1e5e6f9a19
git log --oneline --reverse dadb72d..HEAD
git diff e1ebe88 HEAD -- docs/implementation/2026-09-20-core-agent-contract-review.md docs/implementation/2026-09-20-core-agent-contract-review-r2.md docs/implementation/2026-09-20-core-agent-contract-review-r3.md docs/implementation/2026-09-20-core-agent-contract-review-r4.md tests/interaction-contract.astra.test.ts
git diff --stat dadb72d HEAD
git diff dadb72d HEAD -- server/app.ts
git diff dadb72d HEAD -- shared/types.ts shared/agents.ts server/agents.ts server/store.ts server/modes.ts client/Workspace.tsx client/console/Composer.tsx client/console/AgentPicker.tsx server/engines/contract.ts shared/conversation.ts
git diff ef5e366^ ef5e366 -- server/modes.ts server/interaction-turn.ts
git diff dadb72d HEAD -- server/engines/service.ts tests/modes.test.ts server/engines/claude-session-routes.ts
```

The protected-artifact diff and the final three-file diff were empty. The candidate diff covered 31 files, 6,492 insertions and 80 deletions. Initial/pre-report status was empty; final status contains only this new report.

The report itself was read back with `git diff --no-index -- /dev/null docs/implementation/2026-09-21-core-agent-contract-review-r5.md` (exit 1 for the expected nonempty diff). An in-memory check found no non-ASCII characters or em dashes.

Exact source-read commands, all exited 0 except the explicitly noted nonexistent-path lookup. Repeated reads of the same command are listed once; excerpts and line numbers were derived in memory from these outputs:

```text
git show HEAD:AGENTS.md
git show HEAD:docs/DIOMEDES_CORE_PILLARS.md
git show HEAD:docs/DIOMEDES_LIVE_ROADMAP.md
git show HEAD:docs/DIOMEDES_PROJECT_MEMORY.md
git show HEAD:docs/implementation/2026-09-20-core-agent-contract.md
git show HEAD:docs/implementation/2026-09-20-core-agent-source-map.md
git show HEAD:docs/implementation/2026-09-20-core-agent-contract-review.md
git show HEAD:docs/implementation/2026-09-20-core-agent-contract-review-r2.md
git show HEAD:docs/implementation/2026-09-20-core-agent-contract-review-r3.md
git show HEAD:docs/implementation/2026-09-20-core-agent-contract-review-r4.md
git show HEAD:server/harness/claude-session-run.ts
git show HEAD:server/harness/run-service.ts
git show HEAD:server/interaction-admission.ts
git show HEAD:server/interaction-turn.ts
git show HEAD:server/interaction-service.ts
git show HEAD:server/engines/interaction-routes.ts
git show HEAD:server/engines/contract.ts
git show HEAD:server/engines/service.ts
git show HEAD:server/app.ts
git show HEAD:server/store.ts
git show HEAD:server/modes.ts
git show HEAD:server/native-work.ts
git show HEAD:server/work-admission.ts
git show HEAD:server/task-admission.ts
git show HEAD:server/command-admission.ts
git show HEAD:shared/types.ts
git show HEAD:shared/conversation.ts
git show HEAD:shared/interaction.ts
git show HEAD:shared/attribution.ts
git show HEAD:tests/interaction-seam.test.ts
git show HEAD:tests/interaction-driver.test.ts
git show HEAD:tests/interaction-admission.test.ts
git show HEAD:tests/interaction-turn.test.ts
git show HEAD:tests/auto-mode-migration.test.ts
git show HEAD:tests/interaction-contract.astra.test.ts
git show HEAD:tests/modes.test.ts
git show HEAD:QUESTIONS.md
git show ef5e366^:server/modes.ts
git show HEAD:server/attribution.ts
```

The last command exited 1 because the path does not exist; the import identifies `shared/attribution.ts`, which was then read successfully. No finding relies on the missing path. The I-12 literal-length/equality check used in-memory JavaScript over the two successful source reads, not another test process.

**Integrator's evidence, not execution here:** read with this authorized read-only diff command:

```text
git diff --no-index -- /dev/null F:/Temp/andre/claude/F--Diomedes/e96b0c5b-6ccf-4f64-a907-b99ad1a4ae8d/scratchpad/cd01-r5-integrator-run.txt
```

The nonempty no-index diff displayed the supplied file; its difference exit is not a test failure. The file identifies this HEAD/base and is dated `2026-09-21T06:28:18Z`. It records TypeScript exit 0; **11 focused files, 181 tests passed**; and the full run **218 files passed, 4,198 tests passed, 1 skipped, 4,199 total**. Its heading says ten suites but its actual summary says eleven. The skipped test is not a pass. Eight guard-removal mutations are recorded killed by their named suites; M4 needed driver coverage. Those counts and mutations are the integrator's results. No full suite, build, browser, packaging, live-provider or installed-build check was run here.

## What the consumer lanes may use

**CD-02 server:** may retain the fixture-compatible decision schema, issued source identity, canonical message binding, deterministic selection digest, three existing wire routes/types, driver-owned pure phases and existing task/Work receipt authorities as the working candidate. Keep `server/engines/service.ts` unchanged if the request transport remains sufficient. Repair R-03, R-05, R-10, R-14 and R-15 before claiming the server seam accepted. In particular, do not freeze the current `InteractionHost` admission arguments as sufficient for live source-run/Mode checks. O4 remains separately bounded. Build continues through existing proposal/review admission, never a new writer.

**CD-05 client:** may build against the settled product decisions and `shared/conversation.ts`'s current candidate shapes: Automatic/Ask/Plan, one persisted command/body per message retry, server-issued source identity, a shown proposal with its digest and target, a separate consent-bearing select event, and outcome rendering from authoritative reads. The client must not mint a different command to recover a lost response, infer a successful decision from `answerText: null`, work around budget exhaustion with a new thread, or compensate for stale Mode enforcement itself. These are server defects. This verdict grants no acceptance freeze for production send/select/recovery behavior. Home identity comes from O4, never a guessed or last-opened Project.

**Both lanes must still treat as unclaimed:** home provisioning/integration; first/returning-user conversation landing and deletion of the last-opened fallback in the client; the Automatic plan-lineage hop; portable/context/audience handoff across lineage changes; conversational control, external sends and capability building; non-Claude conversation support; production tenant/shared-audience safety; model intent quality; real-provider and installed-build proof. Mode compatibility edits do not constitute delivery of the conversation UI. A started Work receipt proves admission, not successful delivery or file application.

**Pillar impact:** existing Runtime/Trust/Project reuse and proposal-before-action advance P02/P08. R-05 and R-15 still endanger scoped authority under P06/P09; R-03 endangers historical attribution under P07. No semantic pillar change is requested.

**Roadmap impact:** no status was changed. CD-01 acceptance remains blocked by the listed executable defects; deferred CD-03/CD-05/O4 work has not been relabelled implemented.

**Build/publication/deployment:** local typecheck only; independent test execution blocked as recorded. No build, commit, push, merge, release, deployment or cloud synchronization. This report is the sole uncommitted file; candidate source and the five protected review artifacts remain untouched.
