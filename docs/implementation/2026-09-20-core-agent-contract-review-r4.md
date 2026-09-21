rejected

The integrator closes the source-ID recovery gap, defines a workable persisted client retry protocol, closes historical lineage discovery and generation recovery, and removes the normal-path callback cycle. Three substantive seams still prevent freezing the contract: read-only replay bypasses the body-mismatch check on which I-1 relies; terminal replay cannot perform the phase writes I-3 requires; and I-4 narrows explicit limits contrary to the package's actual text. These affect server admission and client send behavior. Home validation and the retained mode migration are bounded integration work, not reasons for rejection. The next acceptance candidate should contain the driver/route patches and the fake-provider integration test, not another prose-only authoring round.

## Scope and identity

Work order CD-01.R-4, package CD-1 version 2026-09-20.3. Reviewed on 2026-09-21 in `F:/Diomedes/diomedes-wt/core-agent-contract`. Assigned branch: `feature/core-agent-contract`; assigned base and HEAD: `dadb72d4ce16f11c0f31c9fa52158a1e5e6f9a19`. Those Git references are supplied context; the permitted Git commands verify status and blobs, not branch ancestry. No application source was read from the main checkout. The existing dependency junction was used only for the permitted checks.

Repository mirrors read: Pillars **2026-09-19.1**, Roadmap **2026-09-19.2**, Project Memory **2026-09-19.2**. The assignment's settled owner decisions govern. The independent evidence-checking method was used locally, without delegation or additional artifacts. No cloud write or publication occurred.

All eight supplied identities match:

| File | Blob |
|---|---|
| `docs/implementation/2026-09-20-core-agent-contract.md` | `fe20971eeec99192d4951c991bf028110f8a12bd` |
| `docs/implementation/2026-09-20-core-agent-source-map.md` | `9bf9178b88ef763b7397a1ea34268a763b7af802` |
| `shared/interaction.ts` | `fabd162aa423d17b398ff292710bf023f1c47114` |
| `tests/interaction-contract.test.ts` | `bb07135179a498e3a672a13f66b8703805178fff` |
| `tests/interaction-contract.astra.test.ts` | `0590ac877137c0dc254d258b1338678f06cae757` |
| `docs/implementation/2026-09-20-core-agent-contract-review.md` | `80fa323ff7cb589d6010c18a4804ea0536dadb1e` |
| `docs/implementation/2026-09-20-core-agent-contract-review-r2.md` | `de82681ac74c87a87d3f8df2db504826ebe12651` |
| `docs/implementation/2026-09-20-core-agent-contract-review-r3.md` | `63ee039ef4e5ba0170f8472581b9f4986cd23299` |

The three non-contract candidates equal their round-3 blobs. The four earlier review/test artifacts are unchanged. No counterexample tests were appended: the outstanding cases require the unimplemented route/driver seam, not more proposal-parser tests. Only this report was written.

Below, `contract` means `docs/implementation/2026-09-20-core-agent-contract.md`. Package paths are relative to the supplied `diomedes-core-agent-CD1` folder. Counterexamples are source traces of the proposed integration, not executed integration tests.

## The five carried findings

### CD01-R-03 | narrowed | P1 | Stable source identity closes; replay payload binding does not

**Closed:** contract:35-48 persists one pending client command before dispatch and derives S from project, thread and that command. `client/work-start.ts` really persists the original input in sessionStorage, rejects a changed pending input and retries the same command. The run scope retains project/thread (`server/harness/claude-session-run.ts:83-90`); the turn input retains requestId (`:336-343`). `server/harness/policy.ts:39-40` hashes canonical JSON to lowercase hex. Thus S can be recomputed after a committed model turn with no decision phase, without trusting a model echo. Losing the first HTTP response no longer loses the replay key.

Computing S does **not** reopen R-12: the server hashes the already parsed transport command, emits exactly 35 ASCII characters, and checks the model echo exactly. Padded transport IDs remain subject to the existing trimming policy at `server/engines/claude-session-routes.ts:11`; they do not become raw trusted-source IDs. S is a correlation identity, not a secret or authorization token. The fixture parser and separate issued-ID validator remain unchanged.

The cleared-client-store cost at contract:39-40 is honest and acceptable for this bounded protocol: a subsequent deliberate send is a new message, just as Work start mints a new command when its pending record is absent. It is not recovery of a lost command, and must not be advertised as deduplication after client storage loss. Equal text with distinct new command IDs can intentionally represent two messages.

I-3 also closes the missing *specified* outcomes for refusal and receipt-before-link gaps (contract:130-142): lookup authoritative receipts before interpreting absence, preserve immutable refusal evidence, and do not retry a durably refused source. Whether these records can be appended on terminal replay remains R-14.

**Still unsound:** contract:49-52 says the existing intent-hash guard refuses a changed body, but contract:63-71 explicitly reads succeeded output without calling `RunService.step`. The cited guard is `RunService.ensure` at `server/harness/run-service.ts:380-388`, reached from `step` at :599. A run read does not call it. The driver's in-flight comparison at `server/harness/claude-session-run.ts:190-206` protects only a currently active request, not this historical read path.

**Counterexample:** finish command B, then resend B with the same text but a different selected mode or source list. I-2 finds the succeeded step before restriction/model selection and returns it without comparing the body. Even the existing projection guard compares only user text and response text (`server/app.ts:2419-2427`), so it is not an equivalent body check. After a crash before projection, there is not even a prior Turn to compare. Restoring original inputs instead would preserve evidence but still silently accept the divergent request rather than refuse it. Reconciliation must not proceed under either interpretation without checking the original request binding.

**Smallest remaining closure:** make the replay read compare a canonical admitted request identity before returning output, projecting or admitting any missing work. Bind the original text, selected mode/restriction, source identities/versions and applicable transport action to the persisted turn input/scope; preserve original projection input and attribution. Do not rebuild historical sources or scope from current settings merely to compare them. The existing immutable turn can carry this data; no second store is necessary. Test a same-ID changed-text, changed-mode and changed-source retry both before and after projection, on current and retired lineages, alongside a byte-equivalent retry after restart. The rejected retries must produce no generation, projection mutation or admission. This is a server replay contract defect, not a hash-algorithm defect.

### CD01-R-05 | narrowed | P2 | Model input repaired; in-message limits are redefined

**Closed:** contract:153-167 gives Automatic independent static instructions, the eight-field schema, a model-visible per-turn S outside the pinned instructions, and an admission recheck of the control-derived restriction. Contract:177-179 separates answer text and raw evidence and specifies preview suppression. These close the previous missing-input and output-projection design issues. Ask and Plan retain their no-work ceilings at contract:396-400.

**Remaining:** contract:168-176 treats an explicit in-message limitation as untrusted advice to the proposing model, protected only by existing grants and send consent. That does not satisfy the round-3 smallest closure or package `01_PRODUCT_DECISION.md:57`, which expressly names natural-language limits and selected modes separately. My ruling and a deterministic alternative are below. This changes what CD-02 must enforce and what CD-05 must submit or confirm; it is not only a CD-12 prompt-quality measurement.

### CD01-R-10 | closed | Original-run lookup and generation recovery are now defined

Contract:61-81 searches persisted lineages including retired ones before current configuration and new-admission guards, reads succeeded output, refuses silent regeneration of unfinished retired turns, counts every historical generation, and makes retirement plus replacement one Store mutation. Those rules close the round-3 discovery/generation remainder. `server/harness/host.ts:428-433` supplies the project-bound read, and the cancelled-run refusal at `server/harness/run-service.ts:592-606` explains why historical replay cannot use the normal step path. The driver's broader terminal refusal is at `server/harness/claude-session-run.ts:320-324`; the RunService citation itself specifically proves cancellation, not every terminal state.

This closure covers choosing and reading the original lineage. R-03 owns validation of the replay body; R-14 owns the conflicting later writes to that lineage. They are not a second rejection of the now-specified generation rule.

### CD01-R-13 | narrowed | P3 | Home identity and ownership close; validator details remain mechanical

Contract:186-194 supplies the missing canonical thread identity, `(createdAt, id)` minimum, and locked adopt-before-create with binding last. Contract:198-205 assigns server-only writing, defaults, migration, provisioner and public filtering. The clone-and-whitelist behavior cited at `server/app.ts:214-223` is real; startup recovery really enumerates Store projects at `server/harness/host.ts:545-554`. These close the consumer-facing identity and owner omissions.

The remaining validator text at contract:195-197 checks only that a thread exists in the reserved Project, not that it is the designated oldest thread. A saved binding to a second thread therefore passes the listed checks but disagrees with the canonical identity on adoption. It also leaves the allowed revision unchecked, with numeric `revision: 1` at :192 and a superseded-looking but still present `revision: string` shape at :547. The round-3 bar explicitly required a designated-thread and revision validator.

This is bounded CD-02h work, not an architectural blocker: validate the canonical thread and numeric revision 1, and separate shape normalization from record validation. `migrateSettings` currently runs before registry/state loading (`server/store.ts:364-380`), so relational validation cannot simply be inserted there without a later validation point. Re-establish an invalid binding by the specified adoption rule on use; never provision at startup. Obligation O4 below defines the proof. The server's canonical selection is settled and the client need not invent another identity.

### CD01-R-14 | narrowed | P2 | Normal sequence closes; terminal phase recovery is not executable

**Closed:** contract:88-108 gives the actual driver owner a pure phase append/read interface; `StepContext` no longer pretends to expose sibling append. Its source definition is indeed attempt-scoped (`server/harness/run-service.ts:77-96`), and the owner is private at `server/harness/claude-session-run.ts:107`. The parsing callback is pure, not an asynchronous callback into app admission. Contract:119-129 orders generation, projection, fresh locked admission and receipt recording without the old cycle. No provider is awaited under the Store lock in that sequence. This agrees with the route at `server/engines/claude-session-routes.ts:78-99`, projection at `server/app.ts:2403-2406`, and the deliberately unawaited work preparation at `server/native-work.ts:540-552`.

**Remaining counterexample:** command B's model turn succeeds, then the process dies before phase 1. Before B is retried, the original run is cancelled and a later message gets a replacement lineage. On retry, I-2 reads B's succeeded output and directs execution to I-3 step 4 (contract:66-71). But phase 1 is written only in the driver's request tail (contract:111-115), which this read path bypasses. Routing the replay through the old driver instead hits its terminal refusal before the cached-turn branch (`claude-session-run.ts:320-348`). Appending the missing phase through `record` as an ordinary step hits `run_cancelled` (`run-service.ts:592-599`). A private owner does not override cancellation.

The same contradiction occurs when a task/work receipt exists but its linking phase is missing when the conversation run is cancelled. I-3 requires linking it (contract:130-133), while I-2 prohibits steps on terminal replay. All-phases-present historical replay can be read-only; missing-phase recovery cannot be both the stated read and the stated append. Moreover, step 4 must not start previously unadmitted work merely because a cancelled historical proposal is retried. Fresh grants alone do not decide that cancellation boundary.

**Smallest remaining closure:** implement a distinct historical replay/reconciliation result through `ClaudeSessionRuns`, `EngineService.claudeSession`, the route dependencies and app. Specify and prove how a terminal source exposes authoritative existing receipts without appending executable steps or reviving admission. Missing phase 1 must be handled explicitly. Either supply a Runtime-owned, non-executing reconciliation evidence operation with its exact boundary, or return a defined read-only unresolved/blocked projection from existing evidence; do not silently claim a phase was recorded. Live-run repair must reacquire the driver lease after restart and reach the common tail without another model call.

The original request/result interfaces still need the integrator's concrete patch: `prepare` currently returns only `TextRequest` (`claude-session-routes.ts:32`), `EngineService.claudeSession` currently takes no decision callback (`service.ts:1595-1600`), and `ClaudeSessionTurnResult` has no answerText (`claude-session-run.ts:73-78`). The route also compares `input.prompt` directly to client text at :85, so I-4's server trailer requires validating the original text separately, preserving the identity check. Those are ordinary wiring changes once replay versus repair is resolved; their mere absence is not another rejection reason.

Contract:144-147 chooses the right acceptance instrument. Add cancellation/retirement at each incomplete phase, a missing phase 1, and a receipt-before-link crash to the fake-provider matrix. Assert no extra provider call, no duplicate task/work, no step appended to a cancelled run, truthful unresolved/refused output, correct lease recovery, and no Store lock held during generation. Return that code and test. This rejection identifies a concrete contradictory path; it is not a demand that prose somehow prove runtime behavior.

**Earlier closures:** R-01, R-02, R-04, R-06, R-07, R-08, R-09, R-11, R-12 and F-2 remain closed for their original defects; none is reopened by the findings above.

## Ruling on I-4 item 4

**Disagree.** Package `01_PRODUCT_DECISION.md:55` says a keyword rule is not sufficient, not that natural-language limits may be discarded. Line 57 separately lists "Just explain," "don't edit anything," "plan only," and a selected Ask/Plan mode. C06's input and explicit answer-only precondition appear in `evaluation/evaluation_cases.jsonl:6`. Nothing in the newest owner brief narrows those limits to the control. The proposed interpretation is a semantic change, not a faithful reading.

I agree that a phrase list or an infallibility claim about a model resolver would be wrong. A deterministic alternative is to keep free-text interpretation as a proposal and require a trusted, message-bound action selection before escalating an Automatic turn that lacks a trusted action request. The model can answer, retrieve within scope or show the proposed work; an explicit user event selects/changes the effective ceiling for that exact source/proposal before task/work admission. Bind that event to the command, request/proposal digest and target; Ask/Plan cannot be broadened by the model, and a stale event cannot apply to another message. This uses structured interaction intent, not a second permissions engine or keyword classifier. It does not require confirmation for ordinary answers or every already-admitted work step.

That is a sufficient conservative mechanism, not approval here to redesign the whole interaction. The integrator must supply the concrete trusted restriction/action ingress and test an adversarial valid `act` proposal for C06 under Automatic. If the product instead intends model-only enforcement of in-message limits, that explicitly weakens the settled guarantee and needs an owner decision, not reinterpretation by a reviewer. The current send confirmation at `server/native-work.ts:322-326` consents to sending instruction/documents to an engine; the per-file grant recheck at `server/store.ts:1063-1081` checks authority to write. Neither establishes that this message asked to create a Build task. An existing grant cannot erase a newer narrower instruction.

## New findings

None. The remaining defects are within R-03, R-05, R-13 and R-14's existing closure bars. No new CD01-R-15 is assigned. Mechanical wiring and source-line offsets are not promoted into independent blockers.

## I-6, I-7 and retained nonblocking obligations

I-6 faithfully adopts all three F-3 obligations, including the behavior sites the compiler misses. The four-mode arrays and worker enums cited at contract:211-215 exist and must stay four-mode. I-7 correctly changes the launch/reload assertions at `tests/ui.spec.ts:105,130` and preserves the explicitly navigated Projects assertion at :1028. The superseded external claim is accepted from the owner's explicit commit-2237787 ruling; no historical claim file or main-checkout source was used to reopen it. Current `server/engines/service.ts:1595-1659` is the real seam that the integrator must patch.

These obligations remain nonblocking in themselves. This is not an accepted-with-obligations verdict, and they do not replace the substantive repairs above.

1. **O1 / F3-O1, CD-02h:** `shared/types.ts`, `server/modes.ts`, `server/engines/claude-session-routes.ts`, `server/store.ts`, and thread ingress in `server/app.ts`: make `auto` round-trip on the supported conversation path, deliberately update `modeOf`/migration, retain all four historical modes, and keep direct `/ask` from becoming Automatic admission. Proof: create/update/load/turn round trips preserve `auto`; historical records retain behavior; unsupported direct execution refuses rather than relabels.
2. **O2 / F3-O2, CD-05b:** `client/console/Composer.tsx`, `client/Workspace.tsx`: complete or narrow the five presentation maps without changing either four-mode picker array; expose Automatic through the Diomedes page only. Proof: typecheck and focused UI checks show the unchanged project pickers and truthful Automatic state on the new page.
3. **O3 / F3-O3, CD-02h with CD-05b if needed:** `shared/agents.ts`, `server/agents.ts`, and any necessary guard in `client/console/AgentPicker.tsx`: separate worker eligibility from conversation modes when repairing `AUTO_BY_MODE`; preserve worker definitions and both four-mode enums. Proof: existing worker definitions/resolutions round-trip, Automatic cannot select an unsupported worker, and escalated work records actual Build mode.
4. **O4, CD-02h:** `shared/types.ts`, `server/store.ts`, `server/app.ts`: align `Settings.home` with revision 1, validate the reserved Project and designated oldest Conversation after records are available and on use, and preserve server-only rebinding. Proof: wrong revision, malformed binding, foreign or non-oldest thread, missing records and client rebinding attempts fail validation; adoption repairs the binding; crashes around project registration, thread persistence and binding save do not create a second visible home; startup creates no home and still enumerates existing home runs. This closes the P3 remainder of R-13 without a new client identity contract.

## Verification

### Commands and results from this review

The exact validation and identity commands were:

```text
git status --short
git hash-object docs/implementation/2026-09-20-core-agent-contract.md docs/implementation/2026-09-20-core-agent-source-map.md shared/interaction.ts tests/interaction-contract.test.ts tests/interaction-contract.astra.test.ts docs/implementation/2026-09-20-core-agent-contract-review.md docs/implementation/2026-09-20-core-agent-contract-review-r2.md docs/implementation/2026-09-20-core-agent-contract-review-r3.md
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run tests/interaction-contract.test.ts tests/interaction-contract.astra.test.ts
```

TypeScript exited **0**, with no diagnostics. Vitest was attempted exactly once and exited **1** before loading tests: `EPERM`, errno `-4048`, opening `node_modules/.vite-temp/vitest.config.ts.timestamp-1789967243499-2a5404b976f9f.mjs`. **Zero tests were collected or executed here.** No alternative loader, install, junction repair or sandbox workaround was attempted.

The Git checks exited 0. Initial status contained exactly the eight supplied untracked files. The same status/hash commands were repeated after writing this report: all eight hashes still matched and only this review was added to status. No supplied file was changed.

Read-only inspection used `Get-Content -Encoding utf8`, line-numbering through `ForEach-Object`, and `rg`/`rg --files` on the instructions, canonical mirrors, earlier reviews, contract markers, candidate source/schema/tests, package and cited worktree source. One `rg` call used a Windows path ending in `evaluation/*` and failed with filename syntax error 123; a subsequent directory search read the actual evaluation files. Earlier oversized read outputs were narrowed to relevant ranges. The single file creation used `apply_patch`. No full suite, browser test, Vite build, package, live model, Git mutation or publication command ran.

### Integrator evidence, not this review's execution

Read `F:/Temp/andre/claude/F--Diomedes/e96b0c5b-6ccf-4f64-a907-b99ad1a4ae8d/scratchpad/cd01-r3-integrator-run.txt`, recorded at `2026-09-21T04:44:20Z` for the assigned worktree/base. It records the same two validation commands: `TSC_EXIT=0`; `VITEST_EXIT=0`; **2 files passed, 59 of 59 tests passed**, consisting of 48 candidate tests and 11 unchanged counterexamples. No skipped tests are reported. The code/test blobs are unchanged in round 4, so this evidence remains applicable to those blobs. It proves no route, recovery, home provisioning or live-model behavior. No historical totals were added to it.

## Consumer disposition

**CD-02 server:** may retain and implement the uncontested proposal schema and issued-ID domain, deterministic S and same-command client protocol, H1-H6 local home scope, canonical home-thread adoption, Ask/Plan no-work ceilings, actual Build proposal boundary, lineage generation/read lookup, single resolved run identity, target-local fresh-lock admission, and immutable task-before-work receipt order. This is permission to carry those settled pieces into the integrator's bounded repair, not acceptance of this candidate as a frozen server contract. Do not freeze historical request validation, terminal phase repair/admission or in-message restriction enforcement from this text. The integrator owns the driver and the hot-file integration; do not invent alternative seams independently.

**CD-05 client:** may build the settled Console landing and navigation composition: normal first/returning launch on Diomedes, remembered project as navigation context, no last-opened work target, Automatic default, explicit mode controls and unchanged mid-session surface recovery. It may use persisted same-command retries with the stated storage-loss boundary and consume the server-selected home identity. Send/retry completion, action confirmation/restriction ingress and partial-outcome rendering are not released as a frozen wire contract; finish them against the reviewed server result shapes, not assumptions about terminal recovery. No client-side lifecycle/status store should compensate for the missing server seam.

**Both lanes must still treat as unclaimed:** implemented C21 duplicate suppression and crash recovery; model reliability for C06/C12 and Automatic generally; non-Claude persistent conversation; tenant/business/shared-audience authorization; workspace-wide retrieval and result egress; C09/C10 artifact delivery; C11 capability development; C22 supersession; general supplier/connector effects; managed usage/entitlement; promotion/activation; private sharing; wider orchestration and production readiness. Parser tests and accepted design fragments certify none of those behaviors.

The next review should inspect code plus a fake-provider test covering the I-3 matrix and the R-03/R-14 counterexamples, and a concrete trusted limit path for R-05. No live model is needed to prove these boundaries. No fifth prose-only authoring round is requested.

PILLAR IMPACT: continuity and durable evidence improve through the identity and lineage rulings; unresolved replay and restriction enforcement still risk P06/P09. No pillar amendment is made. ROADMAP IMPACT: no status change; CD-01 remains unaccepted. BUILD STATUS: local typecheck passed, local Vitest did not start, integrator's unchanged schema/test blobs have 59 passing tests. PUBLICATION / DEPLOYMENT STATUS: none. Implemented candidate scope remains the parser/issued-ID helper and schema tests; runtime integration remains proposed. The eight supplied files and this report remain uncommitted and unpushed.
