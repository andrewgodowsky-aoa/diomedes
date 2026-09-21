rejected

The repair closes the returning-user launch defect, the competing progress/run identities, and the source-ID spelling disagreement. Five append-only phases also resolve F-2's immutable-envelope problem and the predicted task ID. The contract still cannot be frozen for consumers: source identity is not recoverably bound before generation, the proposed hooks cannot perform their specified evidence operations, Automatic lacks a complete model-input and explicit-limit contract, and home-thread adoption remains undefined. These are changes to what CD-02 and CD-05 must build, not compiler chores. F-3 itself is a bounded integration obligation and is not a reason for this rejection. There is no request for another authoring round: the integrator must take the hot-file seams directly under the split specified in this work order.

## Scope and candidate identity

Work order CD-01.R-3, package CD-1 version 2026-09-20.3. Reviewed on 2026-09-21 in `F:/Diomedes/diomedes-wt/core-agent-contract`. Assigned branch: `feature/core-agent-contract`; assigned base and HEAD: `dadb72d4ce16f11c0f31c9fa52158a1e5e6f9a19`. No application source was read from the main checkout. The permitted check commands used the existing dependency junction.

All seven blob identities matched before review and again after this report was written:

| File | `git hash-object` |
|---|---|
| `docs/implementation/2026-09-20-core-agent-contract.md` | `2e3d9c470e324ef34d9b5d0fd566b627eeb7b479` |
| `docs/implementation/2026-09-20-core-agent-source-map.md` | `9bf9178b88ef763b7397a1ea34268a763b7af802` |
| `shared/interaction.ts` | `fabd162aa423d17b398ff292710bf023f1c47114` |
| `tests/interaction-contract.test.ts` | `bb07135179a498e3a672a13f66b8703805178fff` |
| `tests/interaction-contract.astra.test.ts` | `0590ac877137c0dc254d258b1338678f06cae757` |
| `docs/implementation/2026-09-20-core-agent-contract-review.md` | `80fa323ff7cb589d6010c18a4804ea0536dadb1e` |
| `docs/implementation/2026-09-20-core-agent-contract-review-r2.md` | `de82681ac74c87a87d3f8df2db504826ebe12651` |

The earlier reviews and all 11 existing counterexamples are unchanged. No tests were appended. Only this report was written. The initially untracked candidate and review artifacts were explicitly supplied for review; they were not treated as permission to edit them.

Read repository canonical mirrors: Pillars **2026-09-19.1**, Roadmap **2026-09-19.2**, Project Memory **2026-09-19.2**. The newer owner decisions in this assignment govern. Read the package acceptance prompt, product decision, architecture/runtime contract, CD-01 work order, schema and evaluation cases. No cloud documents were changed or synchronized.

Below, `contract` means `docs/implementation/2026-09-20-core-agent-contract.md`. File:line references are to the supplied candidate or the source in this worktree. Reproducers below are source traces of proposed integration, not claims that the unbuilt integration was executed.

## The seven carried findings

### CD01-R-01 | closed | Returning-user launch

Contract:381-415 now makes the home conversation the normal launch destination for returning people, keeps the remembered project as navigation context, and explicitly preserves recovery reloads. The patch removes the destination-setting calls actually present at `client/App.tsx:197-203`; the unselected-project gate is at `client/App.tsx:848-862`. `tests/surface.test.ts:43-50` covers the separate mid-session migration behavior. This satisfies the previous smallest closure. The missing `setRecentProject` state declaration is ordinary implementation work, not a reopened product decision. Browser behavior remains unverified until CD-05 exists.

### CD01-R-03 | narrowed | P1 | Phase order repaired, original-source recovery still missing

**Closed:** contract:480-516 specifies immutable decision, task-input, task-receipt, work-input and work-receipt steps. Work input follows the authoritative task receipt. This agrees with `server/harness/run-service.ts:381-387` and :606, `server/task-admission.ts:12-20`, `server/store.ts:1504-1506`, and `server/app.ts:1623-1634`. F-2's immutable-envelope defect is closed. Contract:520-524 requires pre-generation reconciliation; :559-576 explicitly reaches `decide` on the cached-result path and before parking on the normal path. Contract:596-598 preserves live revalidation.

**Remaining, first reproducer:** accept message M under transport B. Contract:722-724 mints S in preparation but first persists S in phase 1, which contract:509 and :578-583 place after the model result commits. Crash after the model result and before phase 1. The existing persisted turn input contains transport request ID, prompt, documents and transport mode, but no trusted source identity (`server/harness/claude-session-run.ts:336-343`). Contract:541-544 deliberately puts S only on the transient `ClaudeSessionTurn`, not `TextRequest`, and adds no pre-generation persisted binding. Reconciliation therefore has no trusted original S against which to validate the cached model's echo. Recovering S from that echo would make generated output the identity authority.

**Remaining, second reproducer:** complete M, lose its HTTP response, and retry it as transport B2. Contract:709-724 says S is server-issued, not echoed by the client, and returned in the response. The response may never have arrived. The exact request-schema patch at contract:144-150 adds only `auto`; the strict ingress at `server/engines/claude-session-routes.ts:12-26` still has no source identity or replay handle. A new preparation has no specified way to distinguish this retry from a new identical message. Looking up `decision:<sm>` as contract:585-594 requires presupposes the very S that is missing. Deriving task/work IDs from a newly minted S cannot deduplicate the earlier commands. Even when S is known, no exact ingress-to-original-run/turn lookup is supplied, and projection still keys on `[result.runId, input.requestId]` at `server/app.ts:2416-2427`, so B2 would acquire new transcript identities unless original inputs are restored.

**Remaining partial outcomes:** the table at contract:602-606 covers highest phases 1, 3 and 5, but task admission can refuse after phase 2 and work admission can refuse after phase 4. A busy target is a concrete latter case (`server/native-work.ts:329-330`). Neither a durable refusal record nor the projection for those actual highest phases is specified. The reason cannot be appended to an already committed phase by mutation. A crash after a receipt commits but before its phase is written also requires explicit receipt lookup, not treating the highest phase as proof that no admission happened.

**Smallest closure:** persist a trusted ingress binding before generation, with an exact retry protocol that survives a lost response and distinguishes retries from new identical messages. Bind it to original run, turn, mode and request digest; restore those inputs before generation and projection. Cover committed-turn/no-decision, decision/no-task-input, each receipt-before-link gap, and refusals at phases 2 and 4 using authoritative receipts and append-only outcome evidence. Keep fresh authority checks. This changes the server admission contract and the client's send/retry contract, so it cannot be downgraded to a CD-02h implementation note. R-14 separately covers the hook interface needed to execute the phases.

### CD01-R-05 | narrowed | P2 | Concrete ceilings and transitions improve, model input and explicit narrowing are incomplete

**Closed:** contract:181-191 now prohibits `admitWork` for both Ask and Plan, independently of a proposed label. Plan's text is its result. The Automatic-first transition table at :195-207 resolves the ordinary-question-after-plan and repeated-plan ambiguity. The trailing wrapper and fail-closed invalid-output rule are defined at :157-173. A real `auto` mode correctly preserves truthful scope and Turn attribution.

**Remaining:** the exact `AUTO_INSTRUCTIONS` at contract:118-124 still starts with all of `ASK_INSTRUCTIONS`, including "Propose no changes and describe no edits" (`server/modes.ts:21-22`). Its addition asks for a JSON object but supplies neither the eight-field schema nor the issued source identity that must be echoed exactly. Preparation still supplies `MODES[command.mode].instructions` and the person's original text (`server/app.ts:2358-2363`); `EngineService.claudeSession` passes that input through at `server/engines/service.ts:1635-1639`; generation passes it to the provider at `server/harness/claude-session-run.ts:497-501`. The contract's separate transient `sourceMessageId` does not itself put that value into model-visible input. Under the stated patch, an otherwise reasonable action block cannot reliably satisfy the required random identity comparison. This is missing input, not the CD-12 question of whether a fully specified prompt works reliably.

The previous trusted-restriction resolution also disappears. Contract:181-207 gates only on selected mode, and C06 at :765 assumes explicit Ask. With the default `auto` selected, a person can still say "Just explain; don't change anything" or "Plan only." The owner explicitly requires those limits to win. The contract supplies no trusted effective-restriction field, resolver or admission recheck for that case. A syntactically valid `act` must not turn such a message into a visible Build job solely because the conversation is in Automatic. Existing write approval is not a substitute for honoring the interaction limit.

**Smallest closure:** freeze the model-visible input that contains the decision schema and exact trusted S without changing the pinned scope on every turn; give Automatic instructions that explicitly permit the proposal behavior and preserve untrusted-document treatment. Restore an effective-restriction ingress/resolution and second admission check for explicit limits inside Automatic. State how the parsed ordinary answer reaches projection and previews while the raw wrapper remains evidence. Keep Ask/Plan instructions and their no-work ceilings unchanged. These are CD-02/CD-05 contracts, not a prompt-quality deferral.

### CD01-R-10 | narrowed | P2 | Replacement generations exist, replay through retired lineages is not resolved

**Closed:** contract:638-679 adds durable `Conversation.lineages`, an incremented generation, distinct deterministic run IDs and replacement reasons for changed scope, termination and budget. It no longer permanently aliases every new admission to one run. No weakening of the current scope, terminal or budget guards is proposed.

**Remaining:** the only concrete resolver selects the current non-retired generation (contract:658-665). The array contains mode, generation, run ID and retirement reason, not source bindings. The assertion at :680-682 that a retry resolves its own run is not a lookup rule. After M1's run is retired for M2, retry M1's source: selecting the current run loses the original turn, while routing the old run through ordinary preparation/drive encounters the current M2 scope or terminal guard before the succeeded-turn lookup (`server/harness/claude-session-run.ts:320-348`). Cancelled runs also refuse `RunService.step` before cached output at `server/harness/run-service.ts:592-606`. Retaining a historical ID does not define authorized read-only replay or reconciliation of that historical result.

The no-current fallback of generation 1 at contract:659 also needs to distinguish a new thread from a thread with retired generations; otherwise recovering a persisted retirement without its replacement reuses an old ID. An atomic retirement-plus-replacement update or recovery from the maximum historical generation must be explicit.

**Smallest closure:** resolve original-source replay separately from new-lineage admission, before current model selection and new-work guards, with live read/egress checks and no resurrection of cancelled work. Freeze the atomic replacement/generation rule. This shares R-03's missing source binding and is not a separate claim that generation-based continuation is a bad design.

### CD01-R-11 | closed | One resolved run identity

Contract:684-705 assigns resolution inside locked preparation, replaces the independent `server/app.ts:2366-2369` derivation, and requires the route to consume that same ID for start, follow-up, resume and fork. It expressly requires equality tests including replay. This covers both the captured progress ID at `server/app.ts:2370-2400` and the route's separate derivation at `server/engines/claude-session-routes.ts:88-96`. The original mismatch is closed as a design claim. Which historical run a retry resolves remains R-03/R-10, not a second R-11.

### CD01-R-12 | closed | One identity spelling policy, separate from transport

Contract:707-752 explicitly separates server-issued `sm.` plus 32 lowercase hex characters from trimmed transport IDs, requires exact model echo, and uses the same validator for admission and the work-link field (:239). `shared/interaction.ts:136-155` implements the issued-form helper without constraining the fixture parser at :176-257. The padded, whitespace and supplementary-character disagreements are removed from the trusted identity domain without weakening fixture parity. The spelling policy is closed; persistence and retry issuance defects are assessed under R-03. The proposed `issuedSourceId` Zod field still needs to be constructed from the exported predicate/pattern during implementation; that is mechanical.

### CD01-R-13 | narrowed | P2 | Server owner and project adoption specified, home-thread recovery and validation incomplete

**Closed:** contract:315-340 names CD-02h, adds `Settings.home` and `defaults().home`, and :342-360 defines the reserved folder and registered-project adoption. Public filtering is expressly outside `Store.projects()` at :374-379, preserving the startup enumeration actually used at `server/harness/host.ts:545-554`. The owner-approved reserved-home choice is not in dispute.

**Remaining:** step 4 says "If the adopted or created project has no home thread, create one" (contract:358), but nothing defines a home thread's reserved identity or how to recognize it before `settings.home` is written. Existing creation uses a fresh `identifier('C')` and ordinary attachment/name fields (`server/app.ts:2221-2234`; `shared/types.ts:413-431`). Crash after persisting that thread and before writing the binding. Retrying can find the Project by folder, but the contract does not identify which Conversation to adopt, particularly if more than one ordinary conversation exists. The integrator must invent the identity rule to implement the stated recovery guarantee.

The defaults change addresses only the known-key test at `server/app.ts:217-218`. It does not define a binding validator, allowed revision, reserved-folder/thread consistency checks or load behavior. Settings are loaded directly then migrated (`server/store.ts:364-365`); `migrateSettings` at :133-168 has no home validation. Contract:354 trusts any binding whose two records resolve, which is weaker than proving that it identifies the reserved container and its designated thread. Client PUT should remain unable to select a different home, as the existing clone-and-whitelist pattern permits, but that ownership rule and the server-owned writer are not spelled out.

**Smallest closure:** provide a durable home-thread designation/adoption rule, locked provisioning and retry behavior at each write boundary, and exact CD-02h read-validation/server-writer patches in `server/store.ts` and `server/app.ts`. Validate that the binding denotes the reserved Project and its designated Conversation; preserve missing-field compatibility and ignore/refuse client attempts to rebind it. Update the claim at contract:822-824 that the defaults line is the only Store change needed if validation requires another seam. This is still part of R-13's previous smallest closure, not a new request for a different home design.

The six earlier closures **R-02, R-04, R-06, R-07, R-08 and R-09 remain closed for their original defects**. The safe fresh-lock rule remains at contract:417-440; local-only scope and egress limits at :298-313; fixture parity at :612-623; actual source links in evidence rather than digest claims at :254-258 and :507-513; EngineService transport and landing-pin inventory at :837-844 and :862-873; and narrowed prerequisite facts at :781-786 and :894-901. R-14 below is the new hook/sequencing defect, not a return to the old claim that locked work admission deadlocks. Per the owner's explicit update, the external EngineService claim is superseded by commit `2237787`; the carried-risk language at contract:841-844 and :948-949 is stale and is not a finding or blocker.

## F-3 ruling and bounded integration obligations

Agree with the integrator's disposition: representing Automatic as a real `Mode` is correct, and omission of its compile/validation migration is not by itself grounds for rejection. All listed sites exist: three exhaustive records at `client/console/Composer.tsx:14,20,27`, two at `client/Workspace.tsx:49,55`, `server/modes.ts:33`, `shared/agents.ts:297`, and the two explicit Zod enums at `server/agents.ts:52,263`.

The compiler does **not** enumerate every behavioral site. `server/modes.ts:97-102` still refuses `auto` at runtime without a type error; thread creation/update use it at `server/app.ts:2216` and :2261. `server/store.ts:100-104` also has an explicit list when recovering a missing conversation mode. These need a deliberate migration decision alongside the exhaustive records.

Adding metadata keys does not itself offer a new button: the Console and Workbook enumerate explicit four-mode arrays at `client/console/Composer.tsx:13` and `client/Workspace.tsx:48`. Keep those lists unchanged. The two Agent enums are not interchangeable with the conversation ingress enum. One admits worker definitions, the other persisted worker resolutions. The only current resolution caller uses native work's execution mode (`server/native-work.ts:347-350`); this contract keeps escalated work in Build and adds no conversational Agent resolution. Broadening every worker's `modes` or `ALL_MODES` would change eligibility in `client/console/AgentPicker.tsx:89-90`, not merely repair compilation. A refusal of `auto` at that worker boundary is valid for this slice.

These obligations are nonblocking F-3 migration work, not substitutes for the rejected design repairs above:

1. **F3-O1, CD-02h:** in `shared/types.ts`, `server/modes.ts`, `server/engines/claude-session-routes.ts`, `server/store.ts` and the thread-mode ingress in `server/app.ts`, make `auto` round-trip truthfully on the supported conversation path. Update `modeOf`/migration deliberately; retain existing Ask/Plan/Build/Fix behavior and keep legacy direct `/ask` execution from becoming an Automatic admission route. Verification: focused create/update/load/turn round trips retain `auto`, historical four-mode records are unchanged, and unsupported direct execution is refused rather than silently relabeled.
2. **F3-O2, CD-05b:** in `client/console/Composer.tsx` and `client/Workspace.tsx`, complete or explicitly narrow the five exhaustive presentation maps without changing their four-mode picker arrays. Expose Automatic through the new Diomedes page's supported controls only. Verification: typecheck passes, both existing project composers still offer precisely Ask/Plan/Build/Fix, and the home conversation renders its truthful Automatic state.
3. **F3-O3, CD-02h:** in `shared/agents.ts` and `server/agents.ts`, explicitly separate worker-mode eligibility from conversation-mode representability when repairing `AUTO_BY_MODE` and its types. Keep existing worker definitions' mode lists and the four-mode validation boundary at :52/:263 unless a separately implemented caller actually requires more; do not add `auto` to every catalog entry to silence errors. If narrowing these types requires guarding `client/console/AgentPicker.tsx`, return that guard to CD-05b. Verification: existing worker selection and persisted resolutions still round-trip, conversation Automatic cannot select an unsupported worker, and admitted conversational work still records its actual Build execution mode.

The stale EngineService ownership sentence should be corrected in the integration record, but it creates no additional approval gate. The landing pins at contract:867 also need literal reading: `tests/ui.spec.ts:105` and :130 assert Projects immediately after opening/reloading, whereas :1028 asserts it after navigating to Projects. Preserve the latter behavior; adapt the former assertions to the settled conversation launch. Filtering alone cannot preserve an old launch heading. This is a mechanical test expectation correction, not grounds to reopen R-01.

## New findings and regressions

The carried P1/P2 findings above precede this new P2 in severity. No new parser-language regression was found.

### CD01-R-14 | open | P2 | The returned hook cannot append the phases, and its placement conflicts with admission order

**Claim and source:** contract:532-538 freezes `reconcile(context: StepContext): Promise<boolean>` and `decide(context: StepContext, turnStepId): Promise<void>`. Contract:568 and :575 invoke `decide` after the model step has committed. But `StepContext` is an attempt-scoped handler context with input, idempotency key, fence, signal, preview publication, origin reporting and native-checkpoint saving (`server/harness/run-service.ts:77-96`). It has no sibling-step append or run-read operation. It is constructed inside a running handler at :762-767, not returned alongside a committed result. Its checkpoint writer explicitly rejects a settled attempt at :731-745. The caller's placeholder "step context for this run" does not correspond to an existing object with the required capability.

**Reproducer and observed source result:** implement the exact optional hook signature in the app, then try to append `decision:<sm>` or `task-input:<sm>` after the turn commits. There is no operation on its argument to do so. Calling `RunService.step` directly instead requires the private owner retained by `ClaudeSessionRuns` (`server/harness/claude-session-run.ts:107,328`; ownership enforcement at `server/harness/run-service.ts:597` and :307-313). The contract itself correctly identifies this boundary at :474-478, but its replacement seam does not cross it.

There is also an ordering cycle. Contract:421-425 requires projection to return and release its lock before fresh task/work admission. Projection is called by the route only after `engines.claudeSession` returns (`server/engines/claude-session-routes.ts:92-99`). The new `decide` hook must finish before that return, yet its stated job is to append missing phases including receipts that cannot exist until admission happens. It cannot both complete those phases in this hook and wait for the later projection. The safe lock rule remains correct; the proposed call sequence cannot satisfy it.

**Consequence:** CD-02 must change the callback contract or driver orchestration, and the integrator must change the app/EngineService seam. This is not filling in a typed argument or an exhaustive map.

**Smallest closure:** give the driver a concrete owner-bound read/append interface or have it execute returned immutable phase descriptions itself. Separate decision recording, transcript projection, fresh locked admission and receipt-phase recording into an executable sequence, including cached replay. Retain ownership/fencing and the no-provider-under-Store-lock rule. Supply the exact callback/result signatures through `server/harness/claude-session-run.ts`, `server/engines/service.ts`, `server/engines/claude-session-routes.ts` and `server/app.ts`. Acceptance needs a fake-provider integration test exercising both normal and cached paths plus crash gaps; no live model is needed to prove this seam.

## Verification and evidence limits

### Commands executed here

The following verification commands were run in the assigned worktree:

```text
git status --short
git hash-object tests/interaction-contract.astra.test.ts docs/implementation/2026-09-20-core-agent-contract-review.md docs/implementation/2026-09-20-core-agent-contract-review-r2.md docs/implementation/2026-09-20-core-agent-contract.md docs/implementation/2026-09-20-core-agent-source-map.md shared/interaction.ts tests/interaction-contract.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run tests/interaction-contract.test.ts tests/interaction-contract.astra.test.ts
```

The Git commands were repeated after writing this report. Both checks exited 0 and all hashes matched. Initial status showed exactly the seven supplied untracked files; final status adds only this report.

TypeScript exited **0**, with no diagnostics. Vitest exited **1** before loading tests: `EPERM`, errno `-4048`, opening `node_modules/.vite-temp/vitest.config.ts.timestamp-1789966089238-3f89998cc4fd8.mjs`. **Zero tests were collected or executed here.** There is no local test pass count. The command was attempted once; no alternate config loader, dependency repair or sandbox workaround was used.

Read-only `Get-Content`, `Select-Object`, `ForEach-Object` and `rg` calls inspected instructions, package documents, candidate files and source ranges. Some exploratory searches named absent files; the actual functions were then located in `server/store.ts`, `server/app.ts` and `client/console/AgentPicker.tsx`. No full suite, browser test, Vite build, packaging, live model, install or Git mutation was run. The single write used `apply_patch` for this report.

### Integrator's evidence, not this review's execution

Source: `F:/Temp/andre/claude/F--Diomedes/e96b0c5b-6ccf-4f64-a907-b99ad1a4ae8d/scratchpad/cd01-r3-integrator-run.txt`, timestamp `2026-09-21T04:44:20Z`, same assigned worktree/base.

| Command | Integrator's recorded result |
|---|---|
| `./node_modules/.bin/tsc --noEmit` | `TSC_EXIT=0` |
| `./node_modules/.bin/vitest run tests/interaction-contract.test.ts tests/interaction-contract.astra.test.ts` | `VITEST_EXIT=0`; 2 files passed; **59 tests passed**, comprising 48 candidate tests and 11 unchanged counterexamples |

The log reports no failed or skipped tests. Historical comparison only: round 1 had 51 total, 42 passed and 9 failed; round 2 had 56/56. None of those historical totals is added to this run. The three new candidate tests concern the issued-ID form, length semantics and separation from the proposal parser. They do not exercise issuance, retries, hooks or home provisioning.

### What was and was not verified

- **Implemented schema checks:** inspection confirms fixture parity after the documented field renaming, including code-point bounds, raw reference uniqueness, conditionals and required nullable fields. The separate issued-ID helper exists. Local typecheck passed and the integrator's focused schema tests passed. These do not authorize an action or prove interaction judgment.
- **Design claims checked against source:** immutable step behavior, task ID allocation and receipts, cache/guard ordering, step ownership and context capabilities, progress/projection identities, real mode instructions and validators, home-compatible storage, settings loading, project creation, startup recovery enumeration, public-launch seams and relevant regression pins. The findings are deterministic source mismatches in the proposed contract.
- **Not verifiable until implementation exists:** stable-source ingress and retry, crash reconciliation, replacement-lineage replay, Automatic instruction/output behavior, effective restrictions, home provisioning/adoption, public filtering, first/returning launch, preview filtering, actual admission/refusal projection, browser accessibility and real task/artifact links. No live-model behavior, installed build, production identity, paid readiness or release is certified.

## Consumer disposition and required split

**CD-02 is not released to implement against this candidate as a frozen accepted contract.** It can retain the fixture-compatible proposal schema, separate issued-ID spelling, actual Ask/Plan no-work ceilings, target-local admission, live authority checks, append-only receipt order and the one-runtime boundary. It must not freeze its ingress/retry API, source-to-turn binding, phase driver hooks, retired-run replay, home provisioner or Automatic model input from this candidate. Those interfaces change under R-03, R-05, R-10, R-13 and R-14.

**CD-05 is not released to implement against this candidate as a frozen accepted contract.** The owner's product decisions are settled: primary home conversation on normal first and returning launch, remembered project as navigation context, Automatic for a new home conversation, no last-opened job fallback, and unchanged in-progress surface recovery. Those meanings do not need another decision. The client still needs accepted source issuance/retry, home-thread binding, restricted-mode ingress and authoritative partial-outcome/projection interfaces before wiring send, retry and work links. It must not invent them in the page lane.

Under the requested rejection split, the integrator takes the hot-file seams directly: `shared/types.ts`, `server/app.ts`, `server/store.ts`, `server/engines/service.ts`, `client/api.ts` and `client/console/Shell.tsx`, coordinated with the disposition driver's non-hot files. The remaining design work is the bounded pure contracts identified by each smallest closure, not a parallel rewrite or a fourth return of the same work order.

Both lanes must continue to treat non-Claude persistent conversation, business/shared-audience isolation, workspace-wide retrieval and egress, C09/C10 artifact delivery, C11 capability development, C21 runtime duplicate suppression, C22 supersession, general supplier/connector effects, managed budgets/entitlement, promotion/activation, privacy sharing, wider orchestration and production readiness as unclaimed until their implementations and evidence exist. Existing local mechanisms are not proof of those larger behaviors.

PILLAR IMPACT: the home and truthful-mode decisions advance the persistent agent direction; unresolved retry, ownership and recovery seams still threaten continuity and durable evidence. No pillar amendment is proposed. ROADMAP IMPACT: no status change; CD-01 remains unaccepted and this report does not advance CD-02/CD-05. BUILD STATUS: local typecheck passed, local tests could not start, integrator's focused schema tests passed. PUBLICATION / DEPLOYMENT STATUS: none. Only this review was added; all supplied files and this report remain uncommitted and unpushed.
