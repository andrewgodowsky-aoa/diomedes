rejected

CD-01 does not yet freeze an implementable primary conversation and admission contract. The landing has no execution home, the admission lock rule contradicts the existing caller contract, and recovery stops short of reconciling a recorded action with its work receipts. The claimed tenant boundary is also only a local project-address check. These are acceptance blockers supported by the exact candidate and current source, independently of test execution. TypeScript passed; the permitted Vitest command failed at configuration startup with EPERM and executed no tests. This verdict does not reject the one-runtime approach or require a parallel rewrite.

## Reviewed scope

Review date: 2026-09-21. Work order: CD-01.R, package CD-1 version 2026-09-20.3.
Worktree: `F:/Diomedes/diomedes-wt/core-agent-contract`.
Branch: `feature/core-agent-contract`.
HEAD: `dadb72d4ce16f11c0f31c9fa52158a1e5e6f9a19`.

The candidate is the four untracked files named in the assignment:

- `docs/implementation/2026-09-20-core-agent-contract.md`
- `docs/implementation/2026-09-20-core-agent-source-map.md`
- `shared/interaction.ts`
- `tests/interaction-contract.test.ts`

Below, `contract` means the first file and `source map` means the second. Package references are relative to the supplied `diomedes-core-agent-CD1` folder. Application source references are exclusively to this worktree. Shared coordination metadata was read to check claims; no application source was read from the main checkout.

Repository canonical mirrors read: Pillars **2026-09-19.1**, Roadmap **2026-09-19.2**, Project Memory **2026-09-19.2**. The newer owner decisions in this assignment govern the primary conversation, preserved runtime boundaries and retry behavior. Cloud synchronization was neither attempted nor certified.

## Findings, most severe first

### CD01-R-01 | P1 | The primary landing cannot generate or record its answer

**Claim and evidence.** Contract lines 202-206 give the workspace landing no project, run or durable record. Lines 59-62 and 328-334 require its interaction decision to be a step on a leased conversation run. Existing routes require a project and thread (`server/engines/claude-session-routes.ts:14`, `:47`); generation starts that run under a project principal (`server/harness/claude-session-run.ts:278`, `:287`). Package 02 section 1 requires route, scope and usage records even for conversation; package 01 section 5 explicitly distinguishes those records from visible tasks.

**Reproducer and observed result.** Trace C01, "Morning.", from a fresh authorized landing without a target project. Decision 3 prohibits creating the only kind of run on which the model call and decision can occur. There is no alternative execution path in the frozen contract. This is a design contradiction, not a live-model failure observed in this review.

**Consequence.** C01 cannot be claimed on the required primary page. Lines 243-245 and 503-507 incorrectly defer the already-settled persistent landing to another owner decision or permit a project chooser instead.

**Smallest closure.** Give the home conversation an explicit existing-record execution home, with durable thread/run identity and normal route/usage evidence but no visible task for a greeting. The reserved ordinary Project described under R2 is a viable bounded option. Remove the reopened landing decision and specify the actual first-launch and restored-project behavior.

### CD01-R-02 | P1 | Decision 4 removes the lock that work admission relies on

**Claim and evidence.** Contract lines 254-262 require `admitWork` outside `store.locked` and assert that calling it while locked deadlocks at `native-work.ts:613`. That cited lock belongs to background `prepare`, not an awaited part of `start`. `NativeWorkService.start` launches `this.prepare(run)` without awaiting it and returns the session (`server/native-work.ts:540-552`). Existing `/work/start` deliberately calls `admitWork` through the default locked route (`server/app.ts:895-899`, `:1957-1959`). `Store.recordWorkAdmission` explicitly requires its caller to hold the lock (`server/store.ts:588`).

**Reproducer and observed result.** Follow the candidate's unlocked call with two different work commands for the same idle project. Both can pass `native-work.ts:329` before either finishes the awaited validation at `:347`, `:364` and `:382`. The second active check at `:407` applies only to the team branch. Both ordinary starts can reach session insertion at `:449` and replace the project entry at `:520`. The source exposes this interleaving; no concurrent runtime experiment was authorized or run.

**Consequence.** The proposed rule abandons the serialization behind the single-active-work guarantee and receipt/state persistence. Its deadlock rationale is false for the cited native path. The store itself is non-reentrant, but that does not justify unlocked admission.

**Smallest closure.** Keep generation and decision recording outside the Store lock. After projection returns, take a fresh Store lock around the existing task/work admission transaction and receipt checks. Do not nest a new lock inside `recordResult` and do not await the background provider result under it. Correct the source map's lock explanation too.

### CD01-R-03 | P1 | No durable recovery contract connects a decision to admission

**Claim and evidence.** Contract lines 251-255 order decision recording, transcript projection and then task/work admission, but freeze no replay/recovery obligation for that sequence. The decision shape has no canonical task/work request or resolved-target receipt. Existing startup only recovers the conversation run (`server/harness/host.ts:542-554`; `server/harness/claude-session-run.ts:623-625`), not an unfinished route handler. A succeeded model turn immediately returns its cached result at `claude-session-run.ts:348-358`, so a newly added decision hook also needs an explicit replay placement.

**Reproducer and observed result.** Interrupt the specified sequence after the decision and `recordResult` persist but before `task.create` or `admitWork`. Startup has the completed conversation evidence but no code or contract obligation to resume admission. Interrupt after `task.create` and before `work.start`: a task can exist without its work. After work admission but before the HTTP response, the existing receipt can safely replay only with the same target and canonical payload. These are explicit gaps in the proposed sequence, not executed crash tests.

**Consequence.** The person can see an action proposal in the transcript with no corresponding admitted job and no specified pending/refused explanation. Derived IDs prevent a repeated admission within one project; they do not guarantee completion of missing admission or recovery of its original inputs.

**Smallest closure.** Freeze a recoverable admission envelope on existing run/step evidence: trusted source identity, original run/turn, resolved target, exact task/work payloads, both command IDs, and references to the authoritative receipts. Define replay after each crash boundary, live authority revalidation, and a visible unresolved/blocked result. Reuse existing recovery machinery and command receipts, without a new scheduler or status store.

The client mapping problem is part of this closure. If a follow-up command B originally belongs to a run derived from start command A, losing the mapping and posting B as a new start derives a different run (`claude-session-routes.ts:87-95`). That bypasses the old run's turn cache and generates/projects the message again. The same source ID, target and payload still deduplicate task/work receipts; duplicate model generation alone is not proof of a second objective. However, project-scoped command lookup (`server/command-admission.ts:35-47`) cannot protect against a newly inferred target. Persist the binding and replay the original proposal instead of reconstructing it from a new model answer.

The asserted lack of a recovery query is also incomplete: `server/harness/routes.ts:46-61` already lists project runs and reads an individual run, mounted at `server/app.ts:725`; `server/harness/host.ts:428-454` supplies those records. They can support discovery of thread/scope evidence without adding `RunService.list`. Ambiguous multiple lineages still require an explicit selection rule.

### CD01-R-04 | P1 | C24 is claimed without a participant-to-tenant authorization boundary

**Claim and evidence.** Contract line 397 calls C24 enforceable through `localHarnessPrincipal` and the run's project check. The principal is hardcoded to `id: 'local-client'`, `tenantId: 'local'`, and generation 1 (`server/harness/bridge.ts:26-31`). The conversation route's authorization only calls `store.state(routeProject)` (`server/app.ts:2318-2319`), which checks existence (`server/store.ts:494-497`). Source retrieval then reads that project (`server/app.ts:2340-2348`). The global localhost/origin/client-header guards at `app.ts:676-703` do not establish organization membership.

**Reproducer and observed result.** Compare the C24 precondition, an authenticated member of A requesting B's data, with the cited call path. Naming a matching existing B project/thread passes the cited existence and project-consistency checks; none receives the participant's A-only membership. Merely putting B's tenant ID in message text does not itself trigger retrieval, but that narrower fact is not tenant authorization. No live tenant exploit was attempted.

**Consequence.** A local project-consistency mechanism is presented as a multi-tenant enforcement boundary. It cannot justify workspace-wide reads, shared home conversations or C24 acceptance.

**Smallest closure.** Restrict the first integration to the existing single-owner local scope, explicitly block unsupported business/audience reads, and mark C24 unclaimed until the accepted context/identity path binds participant, tenant, audience, project and current access before read and egress. Name that prerequisite in CD-02/CD-05. Do not invent another permissions engine.

### CD01-R-05 | P2 | Automatic's first-turn default does not freeze the full selection contract

**Claim and evidence.** Contract lines 121-128 do provide an initial deterministic `ask` choice followed by a model proposal. Thus an unrecorded classifier call is not inevitable. But lines 110-119 promise per-message selection, while the first-turn rule does not define later transitions, distinguish Automatic from an explicit Ask ceiling at admission, or show how an action proposal crosses into work. Current Ask instructions say "Propose no changes and describe no edits" (`server/modes.ts:21`); the candidate relies on that same run producing a proposal for another mode. `MODES.*.writes` is not consulted by `admitWork` (`server/app.ts:1768-1872`).

**Reproducer and observed result.** Compare an Automatic "Make a checklist" message and an explicit Answer-only message producing the same model `act` object. Both travel over `mode: 'ask'`; `InteractionDecision` contains no trusted restriction, and the contract does not freeze the separate admission context that must distinguish them. After a plan run, it also does not settle where an ordinary follow-up answer executes. This is an underspecified interface, not evidence that today's source executes an Ask mutation.

**Consequence.** CD-02 and CD-05 can implement different meanings of Automatic or mistakenly rely on instructions to stop the separate work path.

**Smallest closure.** Specify the trusted per-message restriction input, resolver owner, decision-output/prompt contract and transition table for initial and subsequent messages. Enforce explicit Ask/Plan ceilings again at action admission. Keep any interpreting model call inside the recorded run and preserve the current explicit mode semantics. Defaults can be evaluated later; the enforcement input cannot remain implicit.

### CD01-R-06 | P2 | The parser is not equivalent to the supplied schema fixture

**Evidence and observed result.** After the documented field-name mapping:

1. `shared/interaction.ts:166-170` forbids every non-control target run. The fixture's `allOf` only requires null for respond/clarify/blocked; retrieve, plan, act and build_capability may have a bounded non-null target. Four independent cases cover this extra restriction.
2. `.trim()` at `interaction.ts:118` and `:147` changes the accepted language and the returned values. A one-space source ID or clarify question satisfies the fixture's minLength but is rejected here. An ID consisting of a space, 159 `x` characters and another space exceeds the fixture's 160-character limit but is accepted after trimming. A padded valid ID changes identity. `['document', ' document ']` satisfies the fixture's uniqueItems but becomes a duplicate after normalization.
3. Zod's string length limits use UTF-16 code units; JSON Schema string lengths count Unicode characters. A source ID with 160 supplementary characters or summary with 2000 such characters is within the fixture's bound but exceeds these `.max()` checks.

**Reproducer.** `tests/interaction-contract.astra.test.ts` contains 11 independent counterexamples asserting the package behavior. Source inspection establishes the divergent rules. The tests were not executed because Vitest failed before loading tests, so there is no claim of 11 observed test failures.

**Consequence.** Producer and consumer can disagree about valid proposals and stable source identities. The existing operation-map test compares the implementation with its own map and cannot establish fixture parity.

**Smallest closure.** Match the fixture, or explicitly amend/version the fixture and document intentional tightening before freezing consumers. Keep identity normalization separate from validation and define its timing. Use code-point length semantics if fixture equivalence remains the promise.

The eight required fields, disposition/operation enums, maxItems 32, top-level additionalProperties refusal, nullable fields, operation-class conditionals, non-null control target and non-null clarify question otherwise agree by inspection. The fixture does not require `question: null` outside clarify, and neither does this parser, despite the "for clarify only" comment.

### CD01-R-07 | P2 | sourceCommandId is hashed but not stored as the promised linkage field

**Claim and evidence.** Contract lines 68-71 and 147-150 describe a stored source-to-work link. The exact patch at lines 174-188 only adds request validation and a property to the transient canonical digest input. `parseWorkCommand` returns an admission containing only commandId and payloadDigest (`server/work-admission.ts:86-90`). `admitWork` passes only that admission onward (`server/app.ts:1862`); `Store.recordWorkAdmission` persists it in the existing receipt (`server/store.ts:600-609`).

**Reproducer and observed result.** Follow the exact proposed patch for a supplied sourceCommandId. It changes the digest, but neither the source ID nor the canonical payload is retained in the work receipt. Given the source and target, the forward derived-ID lookup remains possible; recovering the source from the receipt's hashes does not.

**Consequence.** The field does not provide the durable inspectable linkage claimed, and cannot alone supply R2's link back from target work to the home conversation.

**Smallest closure.** Specify the durable link in the existing decision/admission step with receipt references, or extend the work admission/receipt shape, writer and strict validator together through the integrator. Preserve omission for old receipts and distinguish the transport command ID from the trusted source message ID.

The proposed conditional spread is digest-safe for old requests. The strict receipt schema does not invalidate an old receipt because a new request property is optional. It would reject a new receipt carrying an undeclared sourceCommandId, so adding the field to persisted receipts requires the coordinated extension above.

### CD01-R-08 | P2 | Consumer lane and regression inventories omit relevant integration surfaces

**Claim and evidence.** Contract lines 430-454 offer a `ClaudeSessionTurn.decide` hook and an app patch, but the object supplied to `nativeSessions.request` is constructed inside `EngineService.claudeSession` (`server/engines/service.ts:1595-1659`). The method has no decision dependency argument. The hook's transport through that file is absent from the lane contract. The landing inventory at contract lines 486-494 and source-map lines 109-117 also omits concrete launch constraints:

- `tests/field.spec.ts:102-134`: rail entries and the default visible `#scrThread`, not just a generic visit to `/`.
- `tests/first-task-handoff.spec.ts:229`, `:288-305`, `:343-379`: verified route handover, composer placement, zero dispatch and cancelled project-search behavior.
- `tests/surface.test.ts:18-58`: Console launch migration and preservation of an in-progress surface on recovery. These protect surface selection rather than dictating the new home screen.
- `tests/backend.test.ts:100-105`: fresh `/projects` is empty. Eager provisioning of an ordinary home Project needs an explicit API/visibility decision.
- `tests/ui.spec.ts:105`, `:130`, `:1028`: exact Projects-heading assertions.

**Observed ownership.** None of the four directly owned existing production paths listed for CD-02/CD-05 (`server/work-admission.ts`, `server/harness/claude-session-run.ts`, `client/App.tsx`, `client/console/Home.tsx`) is explicitly an AGENTS.md hot file. No unreleased exact/directory claim covering those four was found in the shared claims snapshot. This is not a reservation for future work. `tests/backend.test.ts` is already covered by unreleased `claim_muah3ub1_5561db3d.json`. The external claim record `external-claims/devin-acp-adapter-20260913.json` lists `server/engines/service.ts` and remains marked discovered, not integrated; its age is not a release. The omitted bridge therefore needs coordination, not a claim of availability.

**Consequence.** Consumers lack an exact implementation path for the hook and can miss or collide with existing regression work.

**Smallest closure.** Add the EngineService dependency threading and owner/handoff to the frozen lane map, and list these pins with their intended preserved or changed behavior. Recheck claims before edits and arrange handoff for claimed tests. Keep all listed hot-file changes as returned patches.

### CD01-R-09 | P2 | Several prerequisite and unclaimed reasons contradict current evidence

**Claim, evidence and observed result.** Three specific source-map conclusions need correction:

- Contract line 398 treats the absence of a production `validateEffect` caller as the reason no per-effect revocation check exists. That helper is unused, but the actual recorded writer calls `ScopeGrants.assertCurrent` before each file and supplies it to `applyWrite` (`server/store.ts:1063-1081`), as well as before preparation (`:949`, `:1054`). The assertion checks the live generation and grant (`server/trust/scope-grants.ts:573-585`). This is a real local write boundary, not proof of all future supplier/connector effects.
- Contract line 402 says there is no configuration restore feature. `ConfigurationService.rollback` exists at `server/configuration.ts:486-561`, with a route at `server/configuration-routes.ts:202-209` and a rollback test at `tests/configuration-service.test.ts:405`. The full conversational C29 remains unproved, but absence of all rollback is not its prerequisite.
- Source-map section 7 declares the revision blocked because the historical C00.R-3 rejection remains controlling. The same worktree contains `evidence/unified-20260913/C00.R-rollout-20260917.json:14-22`, recording a later accepted local rollout and approved revision. `shared/contract-revision.ts:37-41` still says proposed. Those records conflict; the old rejection alone does not establish today's prerequisite status.

**Consequence.** Consumers can defer already available mechanisms, build duplicates or treat an unresolved status discrepancy as a settled blocker.

**Smallest closure.** Correct the local write and rollback mappings, retain the narrower unproved integrated cases, and reconcile the accepted review record with the proposed source marker through the integrator. Do not silently edit or consume the marker as accepted in this patch.

## R1 through R7

| Risk | Answer | Evidence and limit |
|---|---|---|
| R1 | **Confirmed** | CD01-R-01. No model generation/evidence home exists for the unbound landing. A visible task is unnecessary, but a recorded conversation execution is necessary. UNCLAIMED does not close this P1 or reopen owner decision 1. |
| R2 | **Narrowed: acceptable under the conditions below** | An ordinary Project/thread fits the current routes and project principal, with no work-slot collision. It does not supply organization membership or cross-project read authority. |
| R3 | **Narrowed** | The candidate does specify an initial deterministic Ask default, so no outside-run classifier is logically required. The remaining mode transitions and authority input are incomplete (CD01-R-05). Lost follow-up mapping causes new model execution, but stable target/payload/derived IDs still protect one objective; CD01-R-03 covers recovery and existing query surfaces. |
| R4 | **Narrowed** | `conv.` plus 40 hexadecimal characters is 45 characters and matches the actual regex in `server/command-admission.ts:9`, used by both parsers. Family in the digest separates the two derived IDs; it does not reserve the namespace. `findCommand`/`assertReplay` at `:35-63` still reject reuse for another family/payload. `validateWorkReceipts` unions grants/approvals/work; `validateTaskReceipts` also checks tasks against those records. No special bypass exists for the prefix. Optional request payload hashing preserves old digests; durable linkage remains missing (CD01-R-07). These are source checks, not executed parser tests. |
| R5 | **Confirmed as a recovery gap** | The persisted decision-to-admission crash window has no specified reconciler or user-visible unresolved state (CD01-R-03). A completed work receipt can replay once when exact inputs survive; no unconditional twice-admitted result is asserted. The deadlock justification is separately refuted in CD01-R-02. |
| R6 | **Confirmed by source comparison; runtime tests blocked** | CD01-R-06 identifies target-run, whitespace/identity, uniqueness and Unicode-length divergences. Eleven independent tests were added, but none ran. |
| R7 | **Narrowed** | The explicitly offered production paths are not hot files and had no overlapping unreleased claim in the inspected snapshot. The regression list and hook integration map are incomplete; an omitted test and bridge file have ownership constraints (CD01-R-08). |

## Position on the reserved workspace home Project

**Acceptable under stated conditions.** A real Project with a real home thread can satisfy the existing `projectId`, `threadId`, Store and RunService contracts. It is not the special `HOST_TEST_PROJECT`: that host-test identity is deliberately excluded from customer run reads (`server/harness/host.ts:418-426`). Do not repurpose it. A home conversation also creates no native-work `Session`; the work guard checks active Sessions and `NativeWorkService.runs`, not all HarnessRuns (`server/native-work.ts:329`). It therefore does not occupy the target project's work slot. C23 can retain an independent answer while work runs.

Required conditions:

1. Provision/bind the container deterministically through existing Project/Settings mutation and revision paths. Explain it as the home conversation's storage scope, retain durable evidence, and define its visibility in `/projects`, navigation and Files. A retry must find the same home/thread instead of making another one. No new store is needed.
2. Keep the conversation's container distinct from the requested work destination. Home is never the fallback work target. Package 01 section 7 prohibits silently inventing a project *for a new job*; a disclosed system conversation container is not that substitution. Using it to sidestep a missing job target would violate the rule.
3. C14 resolves the named authorized target. C15, with no target/default, asks the missing question or proposes a target without admitting effectful work. Never use the last-opened repository. C13 keeps each admitted job's original target even when visible workspace changes.
4. Admit task/work in the target through the existing locked admission and Trust path, then link the target receipts to the originating home message/run. Use a target-project thread or no target thread as allowed by admission; passing the home thread ID into a different target fails the lookup at `server/app.ts:1795-1798`. Preserve current authority and receipt conflicts on retry.
5. Before CD-03, the unchanged local principal supports only the bounded single-owner local context already enforced. It does not make one home Project safe to share among organizations or people. Business/audience use must be explicitly blocked until existing identity controls are integrated, not advertised as C24-ready.
6. A home turn may use its permitted home transcript and explicitly selected home sources. The unchanged prepare path reads only the route project's sources (`server/app.ts:2345`). Naming another project's ID is neither read permission nor consent to send it to the provider. Before a proved context adapter exists, do not assemble other projects' documents, task details, names, counts, citations or notifications into the home prompt. Enter the selected project's existing authorized flow or report the unsupported read. Returning a target result to home likewise needs an eligible audience check; work admission alone is not egress authority.

It is unacceptable if home is an invisible last-used-project alias, a catch-all job destination, an unscoped shared memory store, a way to bypass project read checks, or a second run/status/file authority. Removing those conditions merely to make `/claude-sessions` work unchanged would not close R1 safely.

## Case-table and UNCLAIMED audit

The C01-C12 disposition choices are broadly consistent with the package. They are expected behavior, not passed evaluations. C01-C04 and C08 still need R1 resolved on the landing. C05/C06 selected project sources fit current preparation but have no integrated decision/read-receipt proof here. C07 can return Plan text; `prepare_artifact` must not be interpreted as a separate business-write grant. C09/C10 honestly leave actual artifact delivery to later work, subject to the unresolved admission contract. C11 honestly leaves bounded capability development to CD-07; the package expects a real development task under its stated preconditions, not merely a refusal. C12's refusal is the correct boundary, still unproved as model behavior.

For C21-C30:

- C21 is correctly unclaimed before implementation, but Decision 2 alone is not enough for the promised recovered linkage. C22's supersession dependency is honest. C23's no-work-slot mechanism is supported by source; concurrent UI/model behavior was not run.
- C24 must be downgraded as described in CD01-R-04. C25 must distinguish the real recorded-file-write rechecks from unbuilt generalized effects and tenant membership integration.
- C26's empty tool list constrains direct tools. It does not prove that injected instructions cannot affect generated text, leak already supplied material to an ineligible audience, or propose a new `act` that the future route dispatches. Retain the no-tools fact; leave end-to-end injection/egress acceptance unclaimed until admission and context provenance are tested.
- C27 truthfully leaves promotion candidates unbuilt and C28 truthfully claims only a refusal. No capability-activation path is evidence of non-activation, not proof of a future reviewed activation flow.
- C29 remains unproved on this conversational path, but existing configuration rollback and separated authority must be mapped accurately. C30's missing conversation audience is honestly unclaimed and must constrain the home design.

The claimed C13 proof covers target pinning only; workspace-scoped UI and suppression of stale previews/notifications still need proof. The absence of non-Claude durable conversation on this mounted path is honestly disclosed. The workspace conversation's UNCLAIMED mark is an acceptance gap, not a permissible deferral of settled intent. The exact count of unclaimed cases must be recomputed after correcting C24/C26 and these partial boundaries; the candidate's count is not an acceptance metric.

## Commands and verification results

The following are the exact validation commands run from the assigned worktree:

| Command | Exit code | Fresh result |
|---|---:|---|
| `./node_modules/.bin/tsc --noEmit` | 0 | Passed, no diagnostics. Includes the added independent test file. |
| `./node_modules/.bin/vitest run tests/interaction-contract.test.ts tests/interaction-contract.astra.test.ts` | 1 | Startup failure loading `vitest.config.ts`: EPERM opening the generated config module under the shared `node_modules/.vite-temp/` junction. Zero tests executed; no passing, failing or skipped test count was produced. |

The Vitest error was an environment write restriction, not an assertion failure. No alternate config, extra flag, new dependency, junction change or elevated rerun was attempted because this assignment permits exactly the named commands and two authored files. The candidate's historical 40-test result is not a result of this review. The new file contains 11 counterexamples awaiting execution in an environment that permits the exact test command.

Read-only identity checks were `git status --short`, `git rev-parse HEAD` and `git branch --show-current`; they established the supplied four-file candidate and named branch/base before edits. Source and coordination checks used read-only file reads and searches. An attempted read-only `Get-FileHash` was unavailable in this shell, so no file-hash attestation is claimed.

No full suite, browser test, Vite build, packaging, live provider request or publication was run. The heavy slot was not taken.

## What is verified, and what still needs implementation

**Schema checks:** source comparison identifies the specific fixture divergences; TypeScript checks the candidate and independent test types. Test execution is blocked at startup. No model judgment, tool behavior or semantic intent correctness follows from schema validity.

**Design claims checked against source:** route/project prerequisites, local principal, instruction-pinned scope, run-local replay, command namespace and digest construction, Store locking, background dispatch, receipt storage, existing run queries, local revocation rechecks, configuration rollback, landing pins and ownership records. These are line-backed control/data-flow checks, not new runtime acceptance tests.

**Not verifiable until code exists:** Automatic's decision production and deterministic restriction enforcement, primary home persistence, the decision hook and its replay placement, cross-project linkage, crash reconciliation, duplicate-message recovery across client loss, authorized workspace context/egress, real artifacts, provider generalization and UI accessibility. The source contains building blocks, not this integrated feature.

## Safe next work for CD-02 and CD-05

CD-01 is not accepted as a consumer contract. The integrator should first return a revised exact contract closing the P1 findings and settling the listed interfaces.

- CD-02 can prepare independent request/decision fixtures, the explicit-limit refusal matrix, same-source replay/crash scenarios and an inventory of existing admission calls on separately claimed paths. It may return proposed hook/locking patches for review, but should not wire dispatch against the current recovery or Automatic contract. Schema-dependent assertions need the fixture divergence settled first.
- CD-05 can map navigation, scope display, existing work projections, first-run handoff and keyboard/empty/blocked states against the required conversational landing. It can prepare the exact regression changes and UI component proposal using current Console conventions. It should not implement an unbound model call, infer a target from recency, or use a disposable run after losing client state. App/Shell integration waits for the home and durable lookup contracts; claimed tests require handoff.

The existing coordination claim `claim_muaptqnf_bffca3eb.json` covers this review and the independent test file. No coordination records were changed under the two-file write restriction; the integrator can release that claim when taking the returned patch.

PILLAR IMPACT: preserve P06's durable outcome/recovery requirement, P07's recorded route and attribution boundaries, and P09's actual authorization and evidence boundaries. The identified failures are contract gaps, not a proposal to relax those pillars.

ROADMAP IMPACT: CD-01 acceptance is rejected; no roadmap file or downstream completion status was changed. The primary conversational intent stays settled.

BUILD / PUBLICATION / DEPLOYMENT STATUS: typecheck passed; focused tests could not start; no build, release, commit, push or deployment occurred. Only this review and the independent test file were authored. The four candidate files remain unmodified and uncommitted; the two review outputs are also uncommitted and unpushed.
