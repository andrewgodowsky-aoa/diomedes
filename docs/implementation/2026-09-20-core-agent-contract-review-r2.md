rejected

The repair closes six of the nine round-1 findings, including the lock error, schema divergence, tenant overclaim and incorrect prerequisite claims. Three findings remain narrowed: returning users still do not open on the primary conversation, the recovery envelope cannot yet be executed in the specified order, and Automatic lacks a consistent prompt/output and admission contract. The new fixed lineage derivation also introduces continuity and progress-identity defects. The reserved home Project is a viable default and is plainly pending the owner; that pending decision is not the reason for rejection. TypeScript passed locally. Local Vitest failed before test collection with EPERM; the integrator's supplied run passed all 56 tests, including the unchanged 11 counterexamples.

## Exact scope and identity

Work order CD-01.R-2, package CD-1 version 2026-09-20.3. Reviewed on 2026-09-21 in `F:/Diomedes/diomedes-wt/core-agent-contract`. The worktree's Git metadata identifies branch `feature/core-agent-contract` and HEAD `dadb72d4ce16f11c0f31c9fa52158a1e5e6f9a19`, matching the assigned base. No application source was read from the main checkout. The junction's installed dependencies were used only by the permitted checks.

All six supplied blob identities matched before review and were checked again after writing this report:

| File | Blob |
|---|---|
| `docs/implementation/2026-09-20-core-agent-contract.md` | `72a2602bd0557fee737f00f59d84650760bec6e6` |
| `docs/implementation/2026-09-20-core-agent-source-map.md` | `76ec4277bbcbae76a363e0accac3bf038a0c7605` |
| `shared/interaction.ts` | `d40541b0ec51d1e97bf25c5b32a139eaf55ebb69` |
| `tests/interaction-contract.test.ts` | `8e874208e73bd023e42ae0a72b30d15c0f231381` |
| `tests/interaction-contract.astra.test.ts` | `0590ac877137c0dc254d258b1338678f06cae757` |
| `docs/implementation/2026-09-20-core-agent-contract-review.md` | `80fa323ff7cb589d6010c18a4804ea0536dadb1e` |

The reviewer files were not weakened or otherwise changed. No counterexamples were appended. Only this report was written.

Below, `contract` means `docs/implementation/2026-09-20-core-agent-contract.md`; `source map` means `docs/implementation/2026-09-20-core-agent-source-map.md`. All application references are relative to this worktree. Package references are relative to the supplied `diomedes-core-agent-CD1` directory.

Read repository canonical mirrors: Pillars **2026-09-19.1**, Roadmap **2026-09-19.2**, Project Memory **2026-09-19.2**. Andrew's newer explicit decisions in this assignment govern. No cloud synchronization or canonical amendment was attempted. Read the package acceptance prompt, product decision, architecture/runtime contract, work orders, schema and evaluation cases. Source conclusions below come from inspecting the cited code, not accepting the candidate's descriptions of it.

## Round-1 findings

### CD01-R-01 | narrowed | P1 | Execution home specified, primary launch still contradicted

**Closed portion.** Contract `:73-75`, `:261-342`, `:365-369` and `:600` now provide a home Project and real Conversation, provisioned on first send. Under that default, C01 has a viable existing-record trace: the home thread satisfies `server/engines/claude-session-routes.ts:14`; preparation resolves its model/account route at `server/app.ts:2324-2364`; `ClaudeSessionRuns` starts the project-scoped run at `server/harness/claude-session-run.ts:287-295`, pins scope at `:83-90`, records admission at `:416-432` and generates through the model step at `:438-548`. Route origin is recorded at `:523-533`; RunService records charged units and model-call counts at `server/harness/run-service.ts:665-666`. Those are runtime usage counters, not a claim of measured provider tokens or billing. The answer projects into the same thread at `server/app.ts:2403-2470`. The proposed decision is a pure step, and C01 invokes neither task creation nor work admission. A run does not require a visible Task. The chooser alternative is now expressly rejected at contract `:275-277`.

**Remaining claim and reproducer.** Contract `:373-379` explicitly preserves returning users landing inside their last project and makes home reachable from the rail. Set `settings.openProjects` to an existing project, then launch: the cited `client/App.tsx:197-203` restores that project and page. This is consistent with today's code, but contradicts contract `:37-46` and the owner's settled instruction that the primary conversation is the page the app opens to. A reachable page is not the launch page.

**Consequence and smallest closure.** Freeze the primary conversation as the normal launch destination for returning users too. Preserve the remembered project as context/navigation without making it override the launch destination. Distinguish normal launch from recovery of an already-running UI session; `tests/surface.test.ts:41-50` protects the latter. Home provisioning's separate ownership gap is CD01-R-13 below.

### CD01-R-02 | closed | Fresh admission lock restored

Contract `:381-409` now keeps generation/decision recording outside the Store lock, waits for projection to return, then takes a fresh lock around task/work admission and receipt checks. It forbids both a nested projection lock and awaiting the provider result under that lock. Source map `:75-78` corrects the false deadlock explanation. Verified against `server/app.ts:895-899`, `:1957-1959`, `:2406-2470`, `server/store.ts:453-468`, `:588-610`, and `server/native-work.ts:540-552`, `:613`. The background prepare lock is not an awaited nested admission lock. This is closure of the design rule, not a concurrency test of future integration.

### CD01-R-03 | narrowed | P1 | Recovery obligations exist, but their ordering and replay entry are incomplete

**Closed portion.** Contract `:486-523` names the trusted source, transport identity, restriction, original run/turn, resolved target, exact task/work inputs, both derived IDs and receipt references. It specifies the requested crash boundaries, live authority revalidation, a visible unresolved/blocked result and no second scheduler/store. Contract `:527-529` and source map `:100` correctly acknowledge the existing list/read routes, verified at `server/harness/routes.ts:46-61` and `server/harness/host.ts:428-454`.

**Remaining claim, reproducer and observed source result.** There are three connected gaps:

1. The envelope must already exist before `task.create` and hold an exact `workPayload` (`contract:498`, `:510`). That payload requires `taskId` (`server/work-admission.ts:16`). Existing task admission does not accept a caller-chosen task ID (`server/task-admission.ts:12-20`); `Store.createTask` computes the next `T<n>` from current target state at `server/store.ts:1504-1506`. Predicting it while recording the envelope outside the Store lock is unsafe: another task admitted before the fresh lock changes the next ID. The contract neither records a receipt-bound task reference to resolve later nor permits a staged work envelope. After task creation, the receipt is authoritative at `server/app.ts:1623-1634`; that is the point from which the actual task ID can safely be obtained.
2. Contract `:221-223` permits a new transport command ID for the same source message. The new derivation at `:535-559` recovers a run, not the original turn. Current `prepare` sets `input.requestId` from the transport command (`server/app.ts:2358`), and turn cache lookup uses that request ID (`server/harness/claude-session-run.ts:329-358`). After a lost response to source S / command B, retrying S as command B2 on the derived run misses B's cache. Follow-up can generate again on a connected process; after restart it first requires resume (`:405-413`). Neither the exact route patch nor the hook contract freezes a pre-generation lookup of S's original envelope. The instruction to replay the recorded proposal is correct, but the claimed self-correction does not implement that instruction. Project-local receipts cannot deduplicate a second newly inferred target (`server/command-admission.ts:35-47`). This is a missing replay obligation in the concrete entry path, not a claim that a duplicate job was observed running.
3. Contract `:509` assumes a completed turn cache covers a persisted decision. The optional hook at `:679-688` has no specified placement relative to committing the model result, committing the separate decision/envelope, the succeeded-turn early return, or parking the run. A crash after decision persistence but before envelope persistence is not covered by the table's assertion that the envelope exists. The existing early return at `claude-session-run.ts:349-358` bypasses later processing; startup recovery at `:623-625` does not execute the unfinished HTTP handler. This needs a defined reconciliation entry, including cached results, rather than an assumed side effect of recovery.

**Consequence.** Implementers must invent the missing transaction phases and retry binding. An interruption can strand an accepted proposal, regenerate it, or send work against a task ID not obtained from its creation receipt.

**Smallest closure.** Specify ordered, append-only evidence phases on the existing run: committed result/decision and trusted source binding, task input and command, authoritative task receipt, then exact work input containing that receipt's task ID before work admission. Alternatively specify an equally concrete receipt-reference resolution rule without predicting IDs. Place reconciliation before any new generation and on cached-result replay; recover the original mode/request inputs and proposal by stable source identity using the existing list/read evidence. Define the decision-to-envelope crash case, receipt-link recording and visible refusal for both zero-receipt and task-only outcomes. Preserve live revalidation and the fresh Store lock; do not add a scheduler or mutable status authority.

### CD01-R-04 | closed | Tenant claim withdrawn and prerequisites named

Contract H5 `:321-331` restricts integration to single-owner local scope and explicitly blocks business/shared-audience use. H6 `:333-342` excludes other projects' documents, names, counts and notifications from home before CD-03 and treats returning a target result as egress. C24 is unclaimed at `:624`; the participant/tenant/audience/project/current-access prerequisite is carried into CD-02 at `:711-714` and CD-05 at `:736-737`. Source map `:67` agrees. Verified the hardcoded principal at `server/harness/bridge.ts:22-28`, project-existence authorization at `server/app.ts:2318-2319` and `server/store.ts:494-497`, and project-local source reads at `server/app.ts:2340-2348`. These are honest bounds on the proposed slice, not multi-tenant proof.

### CD01-R-05 | narrowed | P2 | Resolver and ceilings named, prompt/output and transitions still not frozen

**Closed portion.** Contract `:137-167` names a trusted restriction distinct from model output, assigns resolution to server preparation, and requires a second deterministic admission check. The transition table at `:175-181` adds first/later-message behavior. Explicit Ask/Plan are no longer represented only by prompt instructions.

**Remaining claim and reproducer.** Contract `:171-173` says an Ask run can legitimately emit an action proposal, while `:121-123` preserves the instruction forbidding proposed changes. Current preparation supplies exactly `MODES[command.mode].instructions` (`server/app.ts:2361`); Ask says "Propose no changes and describe no edits" and returns text (`server/modes.ts:21-22`). The contract never freezes the Automatic-specific prompt/output wrapper or how the ordinary answer and parsed decision are separated. In the table, an Automatic plan proposal moves to a new Plan run, but a later ordinary question moves back to Ask without specifying which recorded turn first identifies that question. Repeated Automatic plan messages and reusing an existing Plan lineage have no settled transition rule.

Admission is specified only as a highest model-declared operation class. `prepare_artifact` covers both the C07 plan and C09/C10 business artifact jobs (`contract:606-609`). There is no concrete rule binding that class to a plan-only result versus an ordinary work payload. Current `admitWork` forwards native work without an Ask/Plan mode (`server/app.ts:1842-1863`), and native work defaults to Build (`server/native-work.ts:350`). A parsed `act/prepare_artifact` must not become an arbitrary business-artifact job merely because Plan's table ceiling admits the same label. Current Plan's result is the plan itself (`server/modes.ts:24-25`).

**Consequence and smallest closure.** CD-02 and CD-05 still have to invent interoperating behavior. Freeze trusted ingress and explicit-limit precedence, the Automatic prompt and structured output/answer contract, invalid-output handling, and the dispatcher for every first/later message. Preserve current explicit Ask/Plan instructions. Specify admission in terms of the actual supported action and output destination, so Ask has no write path and Plan can produce only its allowed plan result, independent of the model's label. No live violation was tested or claimed here.

### CD01-R-06 | closed | Parser now agrees with the fixture

`shared/interaction.ts:153-159`, `:185-205` and `:215-235` remove trimming, count code points, compare raw reference strings and implement the fixture's target-run conditionals. Contract `:570-592` makes future divergence explicit. The integrator's log passes all 11 unchanged counterexamples. Inspection also confirms preservation of all eight required fields, enums, maxItems 32, top-level additionalProperties refusal, nullable fields, allowed operation pairs, required control target and required clarify question. No intentional fixture amendment is needed. No new parser-language regression was found. The integration's separate identity-domain issue is CD01-R-12, not a failure of this parser.

### CD01-R-07 | closed | Durable link moved to run evidence

Contract `:194-198`, `:246-257` and `:492-499` correctly distinguish digest participation from persistence and place the inspectable source-to-work link, original run/turn and receipt references in existing step evidence. Verified the existing admission/receipt pipeline at `server/work-admission.ts:64-90`, `server/app.ts:1862`, `server/store.ts:600-609` and the strict receipt schema at `server/work-admission.ts:105-119`. Old requests omit the optional digest field; no uncoordinated receipt-shape change is proposed. R03 remains responsible for when those records are written and recovered; the original claim that hashing alone stores the source is closed.

### CD01-R-08 | closed | Requested bridge and regression inventory supplied

Contract `:690-700` now assigns CD-02 the dependency threading through `EngineService.claudeSession`, subject to coordination and handoff; source map `:137` records the same constraint. Verified the actual object construction and dependency gap at `server/engines/service.ts:1595-1659`. Contract `:744-753` lists every requested landing pin with preserved/changed/review intent; source map `:123-127` includes them too. Read the cited field, handoff, surface, backend and UI test ranges. Current availability of external claims was not recertified; the contract properly requires a fresh check before edits. The old omission is closed. The new run-ID change and new home binding introduce separate omissions below.

### CD01-R-09 | closed | Prerequisites corrected without consuming the disputed marker

Contract `:625`, `:629`, `:781-797` and source map `:65-66`, `:95` correctly narrow the existing local write recheck, acknowledge rollback and record the revision conflict for integration. Verified `server/store.ts:949`, `:1054`, `:1063-1081`, `server/trust/scope-grants.ts:573-585`, `server/configuration.ts:486-561`, its route at `server/configuration-routes.ts:202-212`, and the rollback test at `tests/configuration-service.test.ts:405-429`. The proposed marker at `shared/contract-revision.ts:37-40` and accepted rollout record at `evidence/unified-20260913/C00.R-rollout-20260917.json:14-22` do disagree. Neither was edited or consumed as an accepted amendment. C13's target-pinning-only and C26's no-direct-tools-only qualifications also correct the round-1 case overclaims (`contract:632-637`, `:626`).

## New findings and regressions

All findings below are open. Reproducers describe the exact proposal applied to the inspected source; they are not claims of executed integration or live-model tests.

### CD01-R-10 | P2 | One permanent run ID per mode has no continuation path after scope change or termination

**Claim and evidence.** Contract `:535-549` replaces command-based start identity with a fixed function of project/thread/mode; `:552-559` leaves fork unchanged and calls recovery self-correcting. It does not include a configuration generation or a separately admitted replacement-lineage identity. Existing scope also pins model, account route and instructions (`server/harness/claude-session-run.ts:83-90`).

**Reproducer and observed result.** Start Ask in home thread H with model M1. Select an eligible M2 and start a fresh provider lineage with a portable handoff as package 02 section 9 requires. The proposed start formula produces the old run ID; `drive` rejects its changed scope at `:326-327`. Fork rejects a changed scope at `:298-302`. Likewise, after cancellation/terminal failure, the same formula reaches the terminal refusal at `:320-324`; it cannot create a replacement run on H. Ordinary repeated messages also eventually encounter the fixed 128-call budget (`:294`, `server/harness/run-service.ts:654-663`). A deliberate blocked result is appropriate until a new admission; permanently aliasing every new admission to the old run is not that admission contract.

**Consequence.** Preserving thread continuity requires violating the frozen one-run rule, changing thread identity, or weakening a guard. None is an authorized closure.

**Smallest closure.** Define an explicit admitted lineage generation/replacement identity and durable thread-to-lineage binding in existing evidence. Retries resolve their original run; genuinely new lineages can coexist historically without copying opaque provider history or reusing authority/budget. Preserve all scope, terminal and budget guards and define unambiguous discovery.

### CD01-R-11 | P2 | The exact start-ID patch leaves progress events naming a different run

**Claim and evidence.** Contract `:539-550` changes start derivation only in `server/engines/claude-session-routes.ts`. The app patch inventory at `:704-709` omits the matching derivation in preparation.

**Reproducer and observed result.** Start with transport command A and lineage key L. The repaired route selects `claudeSessionRunId(projectId, L)`. `server/app.ts:2366-2375` still derives `claudeSessionRunId(projectId, A)` and captures it in every started/delta/ended progress event; `:2400` uses that closure for previews. Except for accidental equal inputs, the emitted run ID differs from the actual response/evidence run ID. Fork and explicit follow-up do not fix the first start's events.

**Consequence.** The primary page cannot safely join live progress to the authoritative run it receives, and Technical details can name a nonexistent run.

**Smallest closure.** Freeze a single resolved run identity before preparation/progress publication and thread it through both paths, or return the matching `server/app.ts` patch to the integrator. Include start, replay, follow-up, resume and fork identity checks in CD-02's integration tests.

### CD01-R-12 | P2 | The proposed source-ID bridge reintroduces a different length and normalization policy

**Claim and evidence.** Contract `:217-223` says source and transport identities are equal on first send. `:232` proposes `sourceCommandId: z.string().min(1).max(160).optional()`. Contract `:575-584` and `shared/interaction.ts:153-175` instead preserve raw identities and count code points. Existing conversation ingress trims `commandId` and applies a UTF-16 limit of 200 (`server/engines/claude-session-routes.ts:11-13`); preparation adopts that parsed ID (`server/app.ts:2358`). No explicit separate trusted-source ingress contract is provided.

**Reproducer and observed result.** A source ID containing 81 supplementary characters fits the decision fixture and the current transport's 200-unit bound but is 162 UTF-16 units, so the exact proposed work-link field rejects it. A first-send ID `" message-1 "` is preserved by the repaired decision parser but becomes `"message-1"` at existing ingress. A whitespace-only source accepted by the fixture is refused at that ingress. These are source-visible disagreements across the bridge; the repaired parser itself behaves correctly.

**Consequence.** Consumers lack one defined trusted identity domain and can reject an otherwise valid linked proposal or compare/hash a different source identity after hidden normalization.

**Smallest closure.** Freeze issuance and validation of the trusted source identity separately from transport identity, bind model output to that exact stored identity, and use consistent code-point bounds for the raw linkage field if it carries that source. An explicitly narrower issued-ID policy can be valid, but it must be stated at trusted ingress and must not silently merge padded identities. Preserve fixture parity in the proposal parser.

### CD01-R-13 | P2 | The home binding and provisioning have no complete integration owner or patch seam

**Claim and evidence.** Contract `:61-64` adds an object-valued Settings binding; H1 `:288-295` requires retry-safe home Project/thread provisioning; `:352-369` requires filtering. Yet the server lane says no `server/store.ts` or `shared/types.ts` patch is required (`:708-709`), and neither lane assigns the binding/provisioning writer. CD-05's listed edits cover client filtering/navigation, not the server record creation.

**Reproducer and observed result.** `Settings` has no binding field or suitable object-valued extension slot (`shared/types.ts:33-109`); `validateSettings` rejects keys absent from defaults (`server/app.ts:214-218`). Current `Store.createProject` uses a new ID, rejects a previously registered folder, writes project state and registry separately, then pushes the project into `openProjects` (`server/store.ts:720-769`). It creates no Conversation. Thus calling the existing create route followed by thread/binding writes is not, by itself, retry-safe provisioning: a crash after project registration but before binding leaves the next create attempt conflicting unless a specified lookup/adoption rule finds the same reserved home. The contract supplies the invariant but no identity/lookup rule, authoritative home-thread binding, or owner for implementing it. Filtering the public listing must also preserve internal enumeration used by startup recovery (`server/harness/host.ts:545-554`).

**Consequence.** Even accepting the proposed home default, CD-02/CD-05 cannot fulfill H1 and expose the binding through the stated patch map without adding an unassigned hot-file contract change or inventing persistence conventions.

**Smallest closure.** Assign one server owner and exact integrator-returned patches for the Settings shape/default/read-validation path, reserved project/thread lookup and creation, partial-provisioning recovery, and public-only filtering. Define the reserved identity and collision rule. Preserve ordinary Project/Conversation storage, internal recovery visibility and the no-home-work rule. This does not require a second store or an owner decision on a different home design.

## Reserved home Project assessment

The default is honestly marked pending Andrew at contract `:261-263` and `:766-767`. All six required conditions are present at `:288-342`: deterministic provisioning, no work destination, no last-project alias, target-local locked admission with links back, single-owner local scope, and no cross-project prompt assembly before CD-03. H4 correctly matches the target-local thread lookup at `server/app.ts:1795-1798`.

The contract is **not yet correct and complete under that default**. The ordinary home conversation is feasible, but returning-user launch contradicts the settled primary page, H1 lacks the concrete provisioning seam, and the required retry behavior still depends on unspecified reconciliation. These defects remain even if Andrew confirms the default exactly as recommended. Confirmation is not an acceptance prerequisite for this review and would not close them. Filtering is also presented as proposed; its implementation must not hide home runs from internal recovery.

## Verification, separated by evidence source

### Commands run in this review

Executed in the assigned worktree:

```text
git status --short
git hash-object tests/interaction-contract.astra.test.ts docs/implementation/2026-09-20-core-agent-contract-review.md docs/implementation/2026-09-20-core-agent-contract.md docs/implementation/2026-09-20-core-agent-source-map.md shared/interaction.ts tests/interaction-contract.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run tests/interaction-contract.test.ts tests/interaction-contract.astra.test.ts
```

The two Git commands were repeated for the final integrity check. Both exited 0. Initial status showed exactly the six assigned untracked files; final status adds only this untracked review. Hash output matched the table on both checks.

TypeScript exited **0**, with no diagnostics. Vitest exited **1** at configuration startup with `EPERM`, errno `-4048`, while opening `node_modules/.vite-temp/vitest.config.ts.timestamp-1789964573859-74abe7996f061.mjs`. **Zero tests were collected or executed in this review.** There is no local pass count and no assertion-failure count to infer from that startup failure. No alternate Vitest command, dependency repair or sandbox workaround was attempted.

Read-only `Get-Content`, `Select-Object` and `rg` calls inspected instructions, documents, source ranges, package fixtures and Git metadata. One search named nonexistent `server/settings.ts`; settings validation was then located and inspected in `server/app.ts`. No full suite, browser test, build, packaging or live model command was run.

### Integrator's supplied results, not this review's execution

Source: `F:/Temp/andre/claude/F--Diomedes/e96b0c5b-6ccf-4f64-a907-b99ad1a4ae8d/scratchpad/cd01-r2-integrator-run.txt`, timestamp `2026-09-21T04:20:36Z`, same worktree and base.

| Command | Recorded result |
|---|---|
| `./node_modules/.bin/tsc --noEmit` | `TSC_EXIT=0` |
| `./node_modules/.bin/vitest run tests/interaction-contract.test.ts tests/interaction-contract.astra.test.ts` | `VITEST_EXIT=0`; 2 files passed; 56 tests passed: 45 candidate tests and 11 unchanged counterexamples |

That log reports no failed or skipped tests. The supplied round-1 comparison was 51 total, 42 passed and 9 failed. Those historical numbers are not added to the round-2 count. The passing repaired run closes the original counterexamples; it cannot test prose-only integration contracts.

### What the evidence establishes

- **Schema checks:** the implemented parser typechecks, its rules agree with the supplied fixture by inspection, and the integrator's focused run passes its 56 tests. Parsing is not action authority.
- **Design claims checked against source:** existing home-compatible Project/Conversation/run records, route/scope/call-count evidence, projection, locks, receipt shapes, task-ID allocation, replay guards, local principal, source reads, EngineService threading, landing pins, per-file revocation, rollback and the revision-record conflict. Reproductions above are deterministic source traces of the proposed changes, not observed execution of unbuilt routes.
- **Unbuilt and unverified:** actual home provisioning and first/restored launch, Automatic output quality, action admission and refusal, crash reconciliation, duplicate suppression across retries/lineages, scoped result return, browser behavior, artifact delivery, provider usage/cost detail, multi-tenant authorization and non-Claude persistent conversation. No package installation, production release or deployment was verified.

## Smallest remaining repair and handoff

Keep the repaired parser, lock rule, receipt-link location, local-scope boundary and corrected source facts. This is a bounded contract repair, not a parallel rewrite:

1. Make normal launch agree with the settled primary conversation and assign the home binding/provisioning patches, including deterministic partial-creation recovery.
2. Replace the impossible pre-task exact work payload with explicit receipt-bound phases; bind retries to original source/run/turn evidence before generation and cover every persistence gap.
3. Freeze Automatic's prompt/output, complete message transitions and actual action ceilings while preserving explicit Ask/Plan semantics.
4. Allow admitted lineage replacement without losing original replay bindings; use the same resolved run ID in progress, execution and projection.
5. Define one trusted source-identity policy across ingress, decision, envelope and work linkage.

CD-02 and CD-05 are **not released to build against this candidate as an accepted frozen contract**. The closed findings stay closed. The next review should inspect the small revised contract and its exact source patches, preserving the original counterexamples. C24/tenant sharing, cross-project prompt context, non-Claude continuity, artifact delivery and the wider program remain unclaimed until their named prerequisites and implementations are independently proved.

PILLAR IMPACT: the repairs improve the P06 recovery direction and P09 authority/evidence boundary; the remaining recovery and lineage issues still threaten P06/P07 continuity. No pillar amendment is proposed. ROADMAP IMPACT: no status change; CD-01 remains unaccepted and this review does not advance CD-02/CD-05. BUILD STATUS: local typecheck passed, local test startup blocked, integrator's focused schema tests passed. PUBLICATION / DEPLOYMENT STATUS: none. The candidate, unchanged round-1 artifacts and this new report remain uncommitted and unpushed.
