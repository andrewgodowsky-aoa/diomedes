# CD-01 source map: CD-1 requirement to existing source

Work order CD-01. Base `dadb72d4ce16f11c0f31c9fa52158a1e5e6f9a19`. Every file and
line below was read in the worktree `F:/Diomedes/diomedes-wt/core-agent-contract`
at that base. Line numbers are from that base and will move.

This is a map, not a plan. A row that names existing source is saying only that
the source exists and does what the row says. It is not saying the CD-1
requirement is met.

## How to read the Gap column

- **None** means the existing source satisfies the requirement as written.
- **Wiring** means the mechanism exists and works but nothing calls it on the
  conversational path.
- **Absent** means no source implements it.
- **Conflict** means existing source actively refuses what CD-1 asks for. A
  conflict is not a defect. It is a guard, and CD-01 does not weaken one.

---

## 1. A durable conversational runtime

| CD-1 requirement | Existing source | Gap |
|---|---|---|
| Persistent conversation that survives restart (01 §9, 02 §1) | `ClaudeSessionRuns`, `server/harness/claude-session-run.ts:105-639`; capability `claude-native-session` at `:21-31` | None. Start, follow-up, resume, fork, interrupt, close and status all exist. |
| Conversation is a run, not a second runtime (01 §13) | `ClaudeSessionRuns` drives `RunService` only: `runs.start` `:287`, `runs.step` `:416`, `:438`, `runs.fork` `:311`, `runs.claim` `:328` | None. It holds live transport handles and nothing else (`:104` comment). |
| Durable turn identity | `claudeSessionRunId(projectId, commandId)` `:79-80`; turn step `stepKey('turn', input.requestId)` `:329` | None. |
| A retried turn does not re-run | Succeeded turn replays at `:348-358`; in-flight identical command returns the same promise at `:199-206` | None, within the `claude-sessions` command family. |
| Conversation projected into the ordinary thread | `recordResult` in `server/app.ts:2403-2471`; two `Turn` records pushed at `:2437` | None. |
| A divergent replay is refused, not silently overwritten | Projection identity `hash(JSON.stringify([result.runId, input.requestId]))` `server/app.ts:2416`; 409 at `:2425` | None. |
| HTTP surface | `mountClaudeSessionRoutes`, `server/engines/claude-session-routes.ts:42-123`; mounted `server/app.ts:2317`; runtime wired `server/app.ts:630` | None. |

## 2. The primary page and the client

| CD-1 requirement | Existing source | Gap |
|---|---|---|
| Diomedes is the page the app opens to (01 §1, 01 §4) | App-level landing gate `client/App.tsx:848-862`: `<Home>` renders when no project is selected. `loadInitial` `client/App.tsx:187-210` restores the last project from `settings.openProjects.at(-1)` `:197` | Absent. The landing is a project chooser with an ask box, not a conversation. |
| A client that calls the conversational runtime | No caller exists. `grep -rn "claude-sessions" client/ desktop/` returns nothing | **Wiring.** The runtime in row 1 has no consumer. |
| The composer the Console actually uses | `client/console/Shell.tsx:1003-1017` posts `${base}/ask`; handler `server/app.ts:2640` | None for `/ask` itself. It carries no `commandId`, so a retry is a new request. |
| Workspace-level ask with no project target (01 §7 last paragraph, C13/C15) | `sendLandingAsk` `client/App.tsx:496-508` requires a `Project` argument; it stores a draft, opens that project and navigates to `ask`. Target resolution `client/console/Home.tsx:142`: `byRecency.find(p => p.id === targetId) ?? byRecency[0]` | **Conflict with C14/C15.** `?? byRecency[0]` answers C15's missing-scope question silently, and is the mechanism C14 names as a forbidden outcome ("last-opened repository fallback"). No workspace-level conversation exists. |
| Workspace vocabulary to hang a workspace conversation on | `WorkspaceRef` `shared/workspaces.ts:42`: `{kind:'personal'} \| {kind:'business', organizationId}`; `WORKSPACE_CONTRACT_VERSION` `:20` | None for the vocabulary. Absent for any conversation bound to it. |
| An execution home for an unbound landing message | None. Routes require a project and thread (`server/engines/claude-session-routes.ts:14`, `:47`) and generation runs under a project principal (`server/harness/claude-session-run.ts:278`, `:287`) | **Absent.** There is nowhere for a landing turn to generate or record. The contract uses a reserved workspace home Project, which is an ordinary Project and needs no new store. It is explicitly not `HOST_TEST_PROJECT`, which `server/harness/host.ts:424-426` refuses by name. |
| A settings slot to bind the home to | None. `Settings` `shared/types.ts:33-109` has no binding field and no object-valued extension slot; `validateSettings` rejects any key absent from `defaults()` (`server/app.ts:216`, factory at `server/store.ts:186-210`) | **Absent.** Returned patches add `Settings.home` and the matching `defaults()` entry. They must land together or a client echoing settings is refused with "Unknown setting: home". |
| Retry-safe project provisioning | `Store.createProject` `server/store.ts:720-769` writes project state, then the registry, then `openProjects` as separate awaits, refuses an already registered folder at `:728-729`, and creates no `Conversation` | **Absent.** A crash between those writes leaves a registered project with no binding, and the naive retry then conflicts. The contract's lookup-or-adopt order treats that 409 as "already exists, adopt it" and writes the binding last. |
| Internal enumeration that filtering must not break | Startup recovery iterates `store.projects()` and recovers conversation runs `server/harness/host.ts:545-554` | None, and load-bearing. Public filtering belongs in the `/projects` response and the client, never in the store-level enumeration, or home conversations stop being recovered. |
| Normal launch landing on the conversation | `loadInitial` `client/App.tsx:187-210` restores `settings.openProjects.at(-1)` at `:197` and sets both selection and page at `:199-203` | **Conflict with the settled primary page.** Returned `client/App.tsx` patch keeps the remembered project as navigation context and stops it being the launch destination. A recovery reload is separate and unchanged (`tests/surface.test.ts:43-50`). |

## 3. Mode and explicit limits

| CD-1 requirement | Existing source | Gap |
|---|---|---|
| Ask, Plan, Build, Fix have distinct instructions and write limits (02 §2 [P05]) | `MODES` `server/modes.ts:32-103`; `writes` field `:16`; Ask `writes: 'none'` `:45`, Plan `writes: 'plan'` `:59` | None. |
| Build stays proposal-only | `ModeWrites` includes `'proposal'` `server/modes.ts:5`; `BUILD_INSTRUCTIONS` `:27` says "Only the person applies what you propose" | None. |
| Explicit Answer-only / Plan-only always win (01 §5) | Mode instructions are pinned into the run scope: `scope(input)` includes `instructions` `server/harness/claude-session-run.ts:83-90`; set from `MODES[command.mode].instructions` `server/app.ts:2361` | None for enforcement. See the conflict in the next row. |
| Automatic behavior selection (01 §5, 02 §4) | Body schema admits `z.enum(['ask','plan'])` only, `server/engines/claude-session-routes.ts:16`; `Mode` is `'ask'\|'plan'\|'build'\|'fix'` `shared/types.ts:28` | **Absent.** The contract adds `auto` as a real mode: returned `shared/types.ts` patch, a `MODES.auto` entry in `server/modes.ts`, and the route enum. Ask and Plan instruction text is unchanged. |
| A ceiling that binds an action rather than a label | None. `admitWork` forwards no mode `server/app.ts:1842-1863`, and native work defaults to Build `server/native-work.ts:350`. Plan's own result is the plan `server/modes.ts:24-25` | **Absent.** A label cannot be a ceiling here, so the contract states ceilings as actual actions: Ask and Plan never call `admitWork` at all, and only `auto` can. |
| A mode change inside one conversation | `drive` refuses a scope-digest change: `EngineError('SESSION_MISMATCH')` `server/harness/claude-session-run.ts:326-327`. Fork refuses a differing scope at `:298-302`. Pinned by `tests/claude-session-runtime.test.ts:517` | **Conflict.** Because `instructions` is inside `scope`, a `plan` follow-up on an `ask` conversation is refused today, and a fork cannot change it either. |

## 4. Admission and authority

| CD-1 requirement | Existing source | Gap |
|---|---|---|
| Deterministic admission decides, the model proposes (02 §1) | `admitWork` `server/app.ts:1768-1872`; `NativeWorkService.start` `server/native-work.ts:298` | None. |
| Only one thing mints write authority (01 §5, AGENTS.md Trust) | `ScopeGrants.matching` `server/trust/scope-grants.ts:478`, `ScopeGrants.record` `:501`; reached via `NativeWorkService.applyMatchingScope` `server/native-work.ts:830`, called at `:811` and `server/permission-routes.ts:77` | None. |
| Command identity and digest-safe additive fields | `parseWorkCommand` canonical payload `server/work-admission.ts:64-85`; the `agentId` precedent at `:77-80` with its comment: a field present only when actually named keeps an older receipt's digest replayable | None. This is the pattern an additive linkage field must follow. |
| Strict fail-closed command schemas | `server/work-admission.ts` `receiptSchema` / `validateWorkReceipts`; `server/task-admission.ts:12-19` `requestSchema` (`z.strictObject`); `server/agents.ts:254` `resolutionSchema`, parsed at `:294` | None. Additive fields must extend the schema in the same patch or saved state stops loading. |
| Capability gap is not a permission gap (01 §6, C12) | `agents.resolve` compatibility check `server/native-work.ts:347-361`; refusal message at `:358-361` | Absent on the conversational path. See row 6. |
| An unused authority layer | `resolveExecution` `server/execution.ts:225` and the `server/harness/lifecycle.ts` governance surface (`governanceHook` `:81`, `installGovernance` `:111`, `validateEffect` `:165`) | **Wiring.** Both are referenced only from `tests/`. This is a fact about those helpers and is **not** the reason no revocation recheck exists. See the next row. |
| A revocation recheck before an effect | Real, for recorded writes: the writer calls `ScopeGrants.assertCurrent` before preparation and before each file (`server/store.ts:949`, `:1054`, `:1063-1081`), and the assertion compares the live grant and generation (`server/trust/scope-grants.ts:573-585`) | None for recorded local file writes. **Absent** for generalized supplier and connector effects and for tenant membership. Round 1 wrongly cited unused `validateEffect` as proof no recheck existed. |
| Configuration rollback | `ConfigurationService.rollback` `server/configuration.ts:486-561`, route `server/configuration-routes.ts:202-209`, test `tests/configuration-service.test.ts:405` | None for the mechanism. Round 1 said no restore feature existed and was wrong. The conversational C29 path is still unproved. |
| A participant-to-tenant authorization boundary | `localHarnessPrincipal` is hardcoded `id: 'local-client'`, `tenantId: 'local'`, `identityGeneration: 1` (`server/harness/bridge.ts:22-28`). Conversation-route authorization calls `store.state(projectId)` only (`server/app.ts:2318-2319`), which checks existence (`server/store.ts:494-497`) | **Absent.** This is a local project-address check, not tenant authorization. C24 is unclaimed on it. |

## 5. Concurrency, locking and control

| CD-1 requirement | Existing source | Gap |
|---|---|---|
| One active run per project is the whole scheduler (01 §13: no new scheduler) | `server/native-work.ts:329-330`; `server/app.ts:2514-2517`; `server/app.ts:2923-2929`; delivery defers at `server/work-control.ts:345` | None. |
| A conversation does not occupy that slot | `ClaudeSessionRuns` writes no `Session` record. `recordResult` `server/app.ts:2403-2471` touches `thread.turns` only | None, and this is load-bearing: a live conversation does not trip `native-work.ts:329-330`. |
| The store lock is a non-reentrant queue | `Store.locked` `server/store.ts:453-468`: chains on `this.queue`, so a nested call cannot resolve | None. It is a reason not to nest, and not a reason to admit work unlocked. See the next two rows. |
| Work admission is expected to hold the lock | `Store.recordWorkAdmission` `server/store.ts:588` is documented "Called under locked()". The existing `/work/start` route `server/app.ts:1957-1959` goes through the wrapper at `:895-899`, whose `locked` parameter defaults to true | None. Round 1 of this contract claimed the opposite and was corrected. |
| `start` does not await the provider under the lock | `NativeWorkService.start` launches `const job = this.prepare(run)` without awaiting it `server/native-work.ts:541`, behind the comment at `:540`, and returns at `:552`. The lock at `:613` belongs to `prepare` | None. The cited deadlock does not exist on this path, so locked admission is safe. |
| The provider call is not made under the lock | `prepare` takes `store.locked` `server/app.ts:2323`, returns before dispatch; route comment `server/engines/claude-session-routes.ts:78` | None. |
| Control is a deterministic path, not a model call (02 §4) | `ClaudeSessionRuns.control` `server/harness/claude-session-run.ts:557-622`; control receipts replay at `:583-594` | None for the native conversation. |
| Per-conversation busy guard | `SESSION_BUSY` `server/harness/claude-session-run.ts:204`, `:208`, `:216` | None. Scoped to one `runId`, not to the project. |

## 6. Agent identity and attribution

| CD-1 requirement | Existing source | Gap |
|---|---|---|
| A resolved worker identity on work | `agents.resolve` called once, `server/native-work.ts:347-357`, with `mode: input.mode ?? 'build'` | None on the work path. |
| An agent on the conversational path | No call site. `agents.resolve` has exactly one caller (above) | **Absent.** No agent is resolved for a conversation. |
| An automatic fallback identity | `AUTO_BY_MODE` `shared/agents.ts:297`, used `server/agents.ts:196`; `diomedes.general` fallback `server/agents.ts:200`, catalogue entry `shared/agents.ts:174` | None for the mechanism. It selects by mode and does not read request text. |
| Truthful attribution (AGENTS.md Trust) | `context.reportOrigin` `server/harness/claude-session-run.ts:523-533`; `source: 'runtime'` only when the runtime reported a model, otherwise `'not-recorded'` `:530` | None. |

## 7. Contract and revision hygiene

| CD-1 requirement | Existing source | Gap |
|---|---|---|
| An additive amendment to build on | `CONTRACT_REVISION` `shared/contract-revision.ts:37-41` says `status: 'proposed'`. `evidence/unified-20260913/C00.R-rollout-20260917.json:14-22` records a later dated `accepted` verdict with `approved_contract_revision: '2026-09-13.1'`, stating it is a new verdict rather than a rewrite of C00.R-3 | **Conflict between records**, not a settled blocker. Round 1 called it blocked on the old rejection alone and was wrong. CD-01 reports it, edits nothing and consumes nothing. |
| A pattern for a new additive shared contract | `shared/contract-revision.ts` header `:1-32` and `CONTRACT_EXAMPLES` `:291` | None. `shared/interaction.ts` follows it. |
| Native checkpoint validation | `validateClaudeNativeCheckpoint` `server/harness/claude-session-run.ts:32-39` | None. |
| Step vocabulary for a zero-cost record | `StepKind` `shared/harness.ts:77` includes `'transform'`; `Effect` `shared/harness.ts:30` includes `'pure'`; `StepIntent.cost` `:98`; `KINDS` `server/harness/run-service.ts:128` gives `'transform'` no special handling | None. Existing precedent at `server/harness/native-agent.ts:198-202` and `:301-304`. |
| A place to record the decision on the conversation run | `RunService.step` `server/harness/run-service.ts:568` guards ownership at `:597` via `guard` `:307-313`; `ClaudeSessionRuns` owns the lease under a private `randomUUID` `server/harness/claude-session-run.ts:107`, claimed `:328` | **Absent.** App code holds no lease, so a hook inside `ClaudeSessionRuns` is required. The optional `preview?` at `:68-72` is the shape precedent. |
| A way to find an existing conversation run for a thread | An HTTP query exists: `server/harness/routes.ts:46-57` lists a project's runs and `:58-61` reads one, mounted `server/app.ts:725`, served from `server/harness/host.ts:428-454` | **Not usable as the mechanism.** The listing returns `{id, state, capabilityId, capabilityVersion, taskId, sessionId}` and no `input.threadId`, so discovery costs one read per run; and scope pins `model` and `accountRoute` (`claude-session-run.ts:83-90`), so scope-matching fails exactly when a model changes. The contract stores the binding instead. |
| A durable thread-to-lineage binding | None. `Conversation` `shared/types.ts:413-431` has no run reference | **Absent.** Returned `shared/types.ts` patch adds `ConversationLineage` and `Conversation.lineages`. Its `:418` comment already establishes optional later fields filled on load. |
| A continuation path past a scope change, termination or budget | The guards that end a lineage all exist: `SESSION_MISMATCH` `:326-327`, terminal refusal `:320-324`, budget 128 units and model calls `:294` with enforcement at `server/harness/run-service.ts:654-663` | **Absent.** Nothing admits a replacement lineage. The contract retires the old generation with the guard's reason and admits the next, so no guard is weakened. |
| One run identity across preparation, progress, execution and projection | `server/app.ts:2366-2369` derives a run id from the transport command and captures it in every progress event `:2370-2375` and the preview closure `:2400`, independently of the route's own derivation at `server/engines/claude-session-routes.ts:88-91` | **Conflict.** Two derivations that agree only by accident. Returned `server/app.ts` patch resolves the lineage once and uses that id everywhere. |
| A guard against a lost client mapping | `SESSION_EXISTS` `server/harness/claude-session-run.ts:400-401` refuses a second `start` on a run that already has a model step | None as a guard. It is not a recovery mechanism: the contract's reconciliation runs before generation instead. |
| A task before work can start | `server/native-work.ts:331-332` throws 404 without one; `task.create` carries its own `commandId` `server/task-admission.ts:14` | None. Relevant to C21: an escalation mints two commands, not one. |
| A predictable task id to freeze in a work payload before task creation | None, and it must not be invented. `work.start` requires `taskId` `server/work-admission.ts:16`; task admission accepts no caller id `server/task-admission.ts:12-20`; `Store.createTask` computes `T${Math.max(0, ...ids) + 1}` from current state `server/store.ts:1504-1505`. The authoritative id is in the creation receipt `server/app.ts:1623-1631` | **Absent by design.** The contract records the work payload only after the task receipt exists. |
| An amendable evidence record | None. A step's intent is hashed on first write and a differing rewrite throws `intent_mismatch` `server/harness/run-service.ts:381-387`; a succeeded step returns its cached output `:606` | **Absent by design.** This is why evidence is ordered append-only phases and not one envelope with fields filled in later. |
| A pre-generation reconciliation entry | None. The succeeded-turn early return `server/harness/claude-session-run.ts:348-358` returns directly and bypasses everything after it; startup recovery `:623-625` does not run an unfinished HTTP handler | **Absent.** Returned patch gives both paths a common tail and adds a `reconcile` hook before the turn step. |
| A retry-stable turn identity | `prepare` sets `requestId` from the transport command `server/app.ts:2358`, and the turn cache keys on it `server/harness/claude-session-run.ts:329` | **Conflict.** The same source message resent under a new transport id misses the cache and would generate again. The contract keys phases on an issued source identity instead. |

## 8. Runtime reach

| CD-1 requirement | Existing source | Gap |
|---|---|---|
| The conversational runtime works for any provider | `prepare` refuses unless the thread's engine is `claude-code`: `server/app.ts:2327-2331`, and refuses unless the service is on at `:2332-2333` | **Absent for other providers.** The durable conversation is Claude-only. |
| Per-project conversation addressing | Route base `/api/projects/:id/claude-sessions` `server/engines/claude-session-routes.ts:47`; `threadId` required by the body schema `:14` | **Conflict with a workspace-level page.** Every conversation needs a project and a thread. |

## 9. Tests that pin current behaviour

Named so a consumer lane knows what it would be changing. These are current
pins, not a required run for CD-01. The contract's lane section states the
intended preserved or changed outcome for each landing pin.

| Pin | Test |
|---|---|
| Scope digest change is refused | `tests/claude-session-runtime.test.ts:517` |
| Per-conversation busy | `tests/claude-session-runtime.test.ts:313`, `tests/claude-session.test.ts:295` |
| The landing card exists before a project is open | `tests/ui.spec.ts:59-73` (the `openProject` helper branches on landing card or project nav) |
| The landing offers the sample project | `tests/ui.spec.ts:158`, `tests/ui.spec.ts:205`; relied on by `tests/change-review-ui.spec.ts:53` |
| A fresh `/projects` is empty | `tests/backend.test.ts:100-105`. Under unreleased claim `claim_muah3ub1_5561db3d`: handoff, not edit. |
| Exact Projects headings | `tests/ui.spec.ts:105`, `:130`, `:1028` |
| Rail entries and the default visible `#scrThread` | `tests/field.spec.ts:102-134` |
| First-run route handover, composer placement, zero dispatch, cancelled project search | `tests/first-task-handoff.spec.ts:229`, `:288-305`, `:343-379` |
| Console launch migration and in-progress surface preserved on recovery | `tests/surface.test.ts:18-58` |
| Specs that load `/` before selecting a project | `tests/a6-acceptance.spec.ts`, `tests/change-review-ui.spec.ts`, `tests/connections-ui.spec.ts`, `tests/design-studio-ui.spec.ts`, `tests/field.spec.ts`, `tests/readability.spec.ts`, `tests/responsive.spec.ts`, `tests/ui.spec.ts` |
| Agent automatic selection by mode | `tests/agents.test.ts:260` |
| Configuration rollback | `tests/configuration-service.test.ts:405` |
| Unused authority layer is test-only | `tests/execution-resolver.test.ts`, `tests/governance-integration.test.ts`, `tests/c00-independent.test.ts:171-190` |

## 9a. Ownership constraints on integration surfaces

| Surface | Constraint |
|---|---|
| `server/engines/service.ts:1595-1659` (`EngineService.claudeSession`) | Constructs the object passed to `nativeSessions.request` and takes no decision dependency, so the `decide` hook needs threading through it. Listed in `external-claims/devin-acp-adapter-20260913.json`, still marked discovered rather than integrated. Needs coordination and a handoff; age is not a release. |
| `tests/backend.test.ts` | Covered by unreleased claim `claim_muah3ub1_5561db3d`. |
| `server/work-admission.ts`, `server/harness/claude-session-run.ts`, `client/App.tsx`, `client/console/Home.tsx` | Not `AGENTS.md` hot files, and no overlapping unreleased claim was found in the reviewed snapshot. Recheck immediately before editing; this is not a reservation. |

## 10. Summary of gaps

Four are wiring, and the mechanism already exists:

1. No client calls `claude-sessions` (§2).
2. `resolveExecution` and the lifecycle governance surface have no production
   caller (§4). This is a fact about those helpers only, and is not evidence
   that no revocation recheck exists.
3. No agent is resolved for a conversation (§6).
4. The harness run listing and single-run read exist but nothing on the
   conversational path calls them (§7).

Eleven are absent:

5. No execution home for the landing conversation (§2, §8).
6. No settings slot to bind that home to, and no retry-safe provisioning (§2).
7. No Automatic mode (§3), and no ceiling that binds an action rather than a
   label (§3).
8. No interaction decision or admission evidence is recorded anywhere (§4).
9. No durable thread-to-lineage binding, and no continuation path past a scope
   change, termination or budget exhaustion (§7).
10. No pre-generation reconciliation entry (§7).
11. No durable conversation for a non-Claude provider (§8).
12. No hook by which anything outside `ClaudeSessionRuns` can record a step on a
    conversation run, because the run is owner-exclusive (§7).
13. No participant-to-tenant authorization boundary (§4). C24 rests on this.

Five are conflicts, and CD-01 weakens no guard to resolve any of them:

14. `instructions` inside the run scope makes a conversation mode-pinned (§3).
15. `Home.tsx:142` falls back to the most recent project, which C14 names as a
    forbidden outcome and which blocks C15's missing-scope question (§2).
16. Two independent run-id derivations that agree only by accident (§7).
17. The turn cache keys on the transport command, so the same source message
    resent under a new id would generate again (§7).
18. `loadInitial` makes the remembered project the launch destination, which
    contradicts the settled primary page (§2).

Three things exist that cannot be used as designed, and the contract works with
them rather than around them:

19. A task id cannot be predicted before task creation (§7).
20. A step's intent cannot be amended after it is written (§7).
21. The harness run listing carries no thread id, so it cannot be the lineage
    lookup (§7).

One is a conflict between records, not a settled blocker:

13. `shared/contract-revision.ts:37-41` says `2026-09-13.1` is `proposed`, while
    `evidence/unified-20260913/C00.R-rollout-20260917.json:14-22` records a
    later dated `accepted` verdict approving that same revision. The two
    disagree. CD-01 reports the conflict, does not edit the marker, and does not
    consume the revision as accepted. Reconciliation is the integrator's.
