# Diomedes harness integration map, 2026-09-08

Maps the handoff package's fifteen workstreams (H01 to H15) onto the actual repository. Read `CURRENT_STATE.md` first. Paths are the flat layout (`server/`, `shared/`, `client/`, `tests/`); the package's `packages/*` names are translated, never created. A workstream is "present" only where a file and a test exist; "carried forward" means an existing capability is reused rather than duplicated; "specified" means this map names the owner and the acceptance test but no code exists yet.

Status words: **present** (code and test on this branch or on main), **carried forward** (existing host capability reused), **partial**, **specified** (no code), **not in scope** (P3 or later; named so nobody creates an empty folder for it).

## 0. The authority, and where things appear

| Concern | Single owner | Route for a non-GUI client |
|---|---|---|
| Harness run state, step dispatch, harness approvals, durable events | `server/harness/run-service.ts` `RunService` | P2: `server/harness/routes.ts` (`GET /api/projects/:id/harness/runs`, `/runs/:runId`, `/runs/:runId/events?after=<seq>`), mounted from `server/app.ts` in one line, the way `mountTeamRoutes` is |
| Document edits and History | `server/store.ts` `Store.writeRecorded` (unchanged) | existing routes |
| The approval a person answers | `Need` via `NativeWorkService.resolve` and `POST /needs/:needId/resolve` (Astra's B adds digests) | existing route; a harness step's Need carries `intentHash` as its action digest and resolving it calls `RunService.decide` |
| Engine dispatch | `server/integrations.ts` `askCodex` (unchanged); P2 wraps it as an `EngineAdapter` step | existing |
| Team mailbox and board | `server/team/service.ts` (unchanged) | existing |

### Existing surfaces that display harness state (no new visual system)

| State | Where it already shows | What feeds it |
|---|---|---|
| Progress | `Session.log` sentences (Workbook Work page, Console pane), `Task.state` on the Board | `presentRun().sentence` written as a `plain` log line; step events as `technical` log lines (the log already has `level: 'plain' | 'technical'`, `shared/types.ts:132`; Guided hides technical) |
| Waiting for approval | `Need` (Workbook Review and "needs you" count, Console Changes column, Board `waiting`) | `needFromWaitingStep()` (`server/harness/present.ts`) creates the Need through the Store; `Task.reason = 'needs-ok'` |
| Uncertain outcome | `Task.reason = 'went-wrong'` with the run's sentence; Console pane header state | `presentRun()` for `reconcile_required`: "Something may have happened outside Diomedes that it could not confirm. Check before starting again." |
| Evidence | History page (`HistoryEntry`), Console Changes, the Session log | Harness events are the operational stream (hashes, attempts, fences); document evidence stays `HistoryEntry.files` |
| Fork lineage | History's `restoreOf` / `replaced` caption pattern; Console pane caption | `presentRun().lineage` (`parentRunId`, `forkPoint`); shown in P4 only |
| Guarantee labels | Console engine details (the `location` slot of `IntegrationStatus`), Settings > Engines disclosure lines | `guaranteeSentences(ADAPTER_CAPABILITIES[id])`; Workbook copy rules ban technical words, so labels stay on the Console |

Technical presentation (the Console) changes what is visible. Authority comes only from the principal's capabilities and the approval record.

## 1. Workstreams

### H01 Durable execution engine — present (bounded)

- **Files:** `server/harness/run-store.ts` (`FileRunStore`, one JSON file per run, temp+fsync+rename like `Store`), `server/harness/run-service.ts` (`step`, `claim`, `complete`, `fail`, `cancel`), `shared/harness.ts` (`StepIntent`, `StepRecord`, `HarnessRun`, `HarnessEvent`).
- **Carried forward:** the `Store`'s durable-write pattern; Astra's `WorkReceipt` (worktree A) is the same idea at the Session level and stays where it is.
- **Behaviour:** intent hashing, checkpoint reuse, changed-intent refusal, bounded attempts, stable idempotency key for `idempotent` steps, `reconcile_required` on an unknown non-idempotent outcome, lease claim with fence and TTL, stale-owner refusal on commit and on failure, completion event in the same write as the result, versioned events with a cursor.
- **Tests:** `tests/harness.test.ts` "durable step boundary" (30 cases) and "crash after an external effect" (a real child process exits with status 17 after writing a receipt; the reopened service refuses to repeat).
- **Depends on:** nothing in the host.
- **Not built:** heartbeat renewal, a background timer, artifact references, schema migration beyond refusing a newer `v`, disk-full and interrupted-write tests, an outbox. Wall time is recorded in the budget contract but not enforced.

### H02 Workflow runtime — partial (native loop present, graph specified)

- **Files:** `server/harness/native-agent.ts` (`NativeAgent`: model step, then final or one registered tool step, at most `maxTurns`), `server/harness/tools.ts` (`ToolRegistry`, zod schemas, `describe()` for the model), `shared/harness.ts` (`CapabilityManifest`, `ModelAdapter` shapes).
- **Carried forward:** `server/modes.ts` `MODES` are the instruction layers; `shared/effort.ts` the reasoning ladder. A capability's `approvalPolicy` is the existing `ThreadPermission`.
- **Tests:** `tests/harness.test.ts` "native loop over an injected model adapter" (7 cases: trajectory reuse, unknown tool, schema rejection, turn limit, missing permission, transcript separation, registry description).
- **Depends on:** H01, H05.
- **Specified, owner `server/harness/workflow.ts`:** `WorkflowDefinition` with typed nodes, cycle/missing-dependency/duplicate-id validation, committed branch decisions, explicit fan-in reducer, bounded loops with persisted iteration counts. Acceptance: reject cycles, a recorded branch does not change after restart, fan-in consumes each child once, a join cannot exceed the parent budget. No visual builder.

### H03 Trace, replay, evaluation — partial

- **Present:** the run's event stream is the operational trace (types, step ids, attempts, fences, output hashes; never outputs or secrets in attributes). `outputHash` per step. `presentRun().evidence` counts.
- **Carried forward:** History (`HistoryEntry`, `Change`) remains the user-visible evidence of document changes; `Session.log` technical lines.
- **Specified, owners `server/harness/replay.ts`, `server/harness/evidence.ts`:** fixture replay that supplies a recorded tool outcome only when tool, version, canonical arguments and order match, and stops on divergence; an authorized, encrypted, retention-controlled evidence store separate from the trace; a `dryRun` default that makes any `destination: 'external'` step unreachable. Acceptance: replay cannot reach an external tool; changed arguments are reported as divergence; cache hits are distinguished from new inference.
- **Depends on:** H01, H02.

### H04 Demonstration compiler — not in scope (P3)

- Owner when it starts: `server/harness/automation/` with a browser-first recorder. Consumes `CapabilityManifest`. Windows accessibility capture is a separate adapter. Nothing to carry forward.

### H05 Middleware and hooks — present (bounded)

- **Files:** `server/harness/policy.ts` (`authorize`: capability, tenant, project, egress, integrity, destination), `RunService.use(hook)` (ordered, deep-copied context, after policy, before the claim).
- **Tests:** "policy denial happens before optional hooks", "hooks run in registration order and cannot override a denial", "caller mutation during a hook cannot alter the captured intent", "a tool the principal may not use is refused by the boundary, not the model".
- **Not built:** hook phases (before-run, before-model, after-result, after-failure, after-run), hook deadlines, fail-open versus fail-closed policy per hook class, an isolated extension runner. In-process hooks are trusted code and are documented as such.

### H06 Information flow — partial (baseline)

- **Files:** `shared/harness.ts` `HarnessLabel`; `server/harness/policy.ts` `joinLabels` (least integrity, most restrictive confidentiality, union of provenance), default label untrusted/restricted, egress denied for non-public data to `external`, `trustedInputRequired`.
- **Tests:** "restricted data cannot leave for an external destination", "a step with no label is treated as untrusted and restricted", tenant and project crossing tests.
- **Carried forward:** every mode instruction already says documents are untrusted material (`server/modes.ts`); `server/paths.ts` blocks private files at the filesystem edge.
- **Specified, owner `server/harness/flow.ts`:** label propagation through tool outputs and model outputs (derive the output label from inputs), an authorized declassification transform with a recorded reason (the existing consent gate is the person's authorization to send selected documents to Codex; it must become a run-scoped egress grant, not a global toggle), coverage map of mediated versus unmediated paths. Acceptance: contaminated document, cross-project retrieval, summary laundering, alternate outbound path.

### H07 Execution teleportation — not in scope (P4)

- `TransferManifest` is not reconciled. When it starts: `server/harness/transfer.ts`, a two-host simulator first. The fence and `executionGeneration` recorded on approvals are the fields it will need.

### H08 Execution isolation — carried forward, not native

- **Existing:** Codex runs in the engine's own Windows read-only sandbox, proven per run by a write-denial probe (`server/integrations.ts:341-430`); the workspace is `.data/native-readonly`. The native fixture has no file or network tool at all.
- **Specified, owner `server/harness/environments.ts`:** `EnvironmentProvider` with a `trusted-local` class for pure tools and `unsupported` for everything else until a containment backend exists. A git worktree is a workspace, not a sandbox, and the provider must say so. Acceptance: outside-mount canary, sibling write, junction escape (`server/paths.ts` already rejects junctions for project files), blocked outbound request. Never install virtualization silently.

### H09 Identity and credential broker — partial (baseline)

- **Files:** `shared/harness.ts` `HarnessPrincipal` (id, tenant, project, capabilities, `identityGeneration`); `RunService.start` refuses a capability requesting a permission the principal lacks; approvals bind to `identityGeneration` and stop counting after rotation.
- **Tests:** "a capability asking for a permission the principal lacks cannot start", "an approval granted under an older identity generation is not honoured", "a different tenant cannot execute a run".
- **Carried forward:** the team service's bearer tokens (`team-secrets.json`, leased per run into one environment variable, redacted after) are the only brokered secret today and stay where they are.
- **Specified, owner `server/harness/broker.ts`:** `CredentialBroker` with a fake vault fixture, audience and scope narrowing, revocation bumping `identityGeneration`. A caller-supplied principal is not authentication; the host is the only caller in P1 and P2. No OS vault adapter without separate authorization.

### H10 Events and inbox — specified

- **Owner:** `server/harness/inbox.ts`: tenant-scoped, deduplicated by (tenant, source, event id), conflicting payload under a reused id refused, `waiting_event` step state (already in `StepState`), persisted wait before acknowledgement, event-before-wait accepted under a correlation rule. The package's reference implements this in twenty lines; it was left out of P1 because no host source emits events yet.
- **Carried forward:** the SSE stream is a push channel for clients, not an inbox; the team mailbox (`server/team/mailbox.ts`) is a candidate first source.
- **Acceptance:** duplicate id, changed payload under the same id, wrong tenant, pre-arrival, reconnect from a cursor.

### H11 A2A — not in scope (P4)

- Owner when it starts: `server/harness/interop/a2a-client.ts` against a local mock peer with pinned conformance fixtures. Nothing to carry forward.

### H12 MCP Apps host — not in scope (P3)

- Carried forward when it starts: the loopback MCP host pattern in `server/team/routes.ts` (loopback only, bearer per slot) and the desktop's renderer boundary in `desktop/main.mjs`. Owner: `desktop/mcp-apps/` with the untrusted renderer isolated from Node.

### H13 Queues and budgets — partial (baseline)

- **Files:** `shared/harness.ts` `HarnessBudget` / `HarnessUsage`; `RunService.step` reserves `cost` units and counts model and tool calls before the handler, retains the charge on failure; forks inherit the prefix's usage.
- **Tests:** "budget is reserved before the handler, including failed attempts", "budget and cost reject negative and fractional units", model and tool call counts in the loop test.
- **Carried forward:** one active run per project (`server/native-work.ts:187`), Fix's three tries, the team wake budget, `UsageSnapshot` from Codex rate limits (`server/usage.ts`) as an observation, never as accounting.
- **Specified, owner `server/harness/scheduler.ts`:** a single admission point with priority class, age and fairness; parent/child reservations shared atomically; slot release during `waiting`; wall-time enforcement; observed provider usage settled against the reservation. Capacity for local models is requested from the LocalAI supervisor's status route only (`server/integrations.ts:558-560`), never by loading a model.

### H14 Forks — present (pure prefix only)

- **Files:** `RunService.fork` (completed pure prefix, no approvals, no lease, new lineage with `parentRunId` and `forkPoint`), `presentRun().lineage`.
- **Tests:** "a fork reuses only a completed pure prefix and no approvals", "a fork refuses a prefix containing external side effects", lineage in `tests/harness-present.test.ts`.
- **Specified:** snapshot-based forks for coding experiments, the comparison view, capped experiment budgets, per-fork cancellation (P4).

### H15 Optimization — not in scope (P5)

- Nothing to carry forward. Owner when it starts: `server/harness/optimization/` with train/validation/holdout kept apart and shadow-mode candidates.

## 2. The two vertical slices

**Slice A, native coding fixture (P2, GPT-6):** a `format-report` capability with two pure tools (`read_fixture`, `format_lines`) and one `idempotent` tool `propose_write` whose handler calls `Store.writeRecorded` with an expected sha, behind `approval: true`. The Need is created through the Store from `needFromWaitingStep`; resolving it calls `decide`; the write lands in History like any other. Disconnect and reconnect through the events route with a cursor. No git worktree is described as a sandbox.

**Slice B, synthetic restaurant brief (P3):** three synthetic location exports, a deterministic parser and exact money arithmetic as pure tools, one bounded model interpretation step, a draft document through `propose_write`, manager approval as a Need, archive to a test folder. No live restaurant data, no notifications. Kept as a separate future packet.

## 3. Engine adapters under the same authority (P2)

The Codex route becomes an `EngineAdapter` whose whole run is one `model` step with `effect: 'read'`, `destination: 'external'`, `name: 'codex'` and the label of its input documents. The existing consent gate (`consent: true`, `settings.permissions.sending`) is the person's authorization to send those documents; it must be recorded as a run-scoped egress grant on the principal (a capability named for the destination) so `authorize` allows the step for that run only. `askCodex`'s `threadId` is the `ProviderTranscriptRef.opaqueRef`. Applying the proposal stays a separate step through `Store.writeRecorded`. The adapter's labels are `ADAPTER_CAPABILITIES.codex` and are shown, not implied.

## 4. Dependencies between packets

```
H00 (this map) -> H01 present -> H02 loop present -> H02 graph, H03 replay -> H14 snapshot forks
                -> H05 present -> H06 flow propagation
                -> H09 baseline -> H09 broker -> H10 inbox -> H11, H07
                -> H13 baseline -> H13 scheduler
H08 provider, H12 apps host, H04 recorder, H15 optimizer: after P2 slice A
```

## 5. What this branch changes in the host

Nothing. `server/app.ts`, `server/store.ts`, `server/native-work.ts` and `shared/types.ts` are untouched so that Astra's two worktrees merge without conflict. The route mount and the Session bridge are the first lines of `GPT6_RUNTIME_PACKET.md`, to be applied after Astra's approval-receipts slice lands or in coordination with it.
