# GPT-6 runtime packet: first host integration of the harness boundary

For Astra, after `codex/approval-receipts-20260908` is finished. Base your work on `fable/harness-boundary` (worktree `F:\Achilles\diomedes-wt\fable-harness`, commit `1490768` or later) merged with your own branches, in a fresh worktree of your own. Read `docs/harness/CURRENT_STATE.md` and `docs/harness/HARNESS_INTEGRATION_MAP.md` first, then `shared/harness.ts` and `server/harness/*.ts`, then `tests/harness.test.ts`.

The boundary exists and is tested in isolation. This packet connects it to the host in the smallest way that makes a native run reachable from the desktop and from a non-GUI client, with no second scheduler, no second document writer and no second approval record.

## Files and interfaces you consume (do not change their contracts)

| File | Interface | Version |
|---|---|---|
| `shared/harness.ts` | `HarnessRun`, `StepIntent`, `StepRecord`, `HarnessApproval`, `HarnessEvent`, `CapabilityManifest`, `ModelRequest`/`ModelResult`, `AdapterCapabilities`, `RunPresentation` | contract v1 (`HARNESS_CONTRACT_VERSION`) |
| `server/harness/run-service.ts` | `RunService` (`start`, `get`, `events`, `claim`, `step`, `decide`, `cancel`, `complete`, `fail`, `recordTranscript`, `fork`, `use`), `Suspended`, `StepDefinition` | v1 |
| `server/harness/run-store.ts` | `RunStore`, `FileRunStore` | v1 |
| `server/harness/tools.ts` | `ToolRegistry`, `ToolDefinition` | v1 |
| `server/harness/native-agent.ts` | `NativeAgent`, `ModelAdapter` | v1 |
| `server/harness/present.ts` | `presentRun`, `needFromWaitingStep` | v1 |
| `server/harness/adapters.ts` | `ADAPTER_CAPABILITIES`, `guaranteeSentences` | v1 |
| `server/store.ts` | `Store.locked`, `Store.state`, `Store.persist`, `Store.writeRecorded`, `Store.addEntry`, and your own `recordApprovalDecision` | as merged |
| `shared/types.ts` | `Session`, `Need`, `Task`, `HistoryEntry`, your `ApprovalIdentity` / `ApprovalReceipt` | as merged |

If a contract in `shared/harness.ts` has to change, bump nothing silently: add the field as optional, note it in `docs/harness/CHANGES.md`, and keep the run-file reader refusing any `v` other than 1.

## Deliverable, in order

### 1. Host wiring: `server/harness/host.ts` (new)

- `createHarnessHost({ store, dataDir })` returns `{ runs: RunService, tools: ToolRegistry, adapters, close() }`.
- The store directory is `<dataDir>/projects/<projectId>/harness/runs/`; use one `FileRunStore` per project, created lazily, behind the `RunStore` interface.
- The `RunService` clock is `Date.now`; `policyVersion` is a constant string you bump when `authorize` changes.
- Register the fixture tools for slice A (below). No file tool that writes outside `Store.writeRecorded`.
- Nothing in this file starts a timer, a poller or a second lock.

### 2. Session bridge: `server/harness/bridge.ts` (new)

The `Session` is what the Workbook and Console show. A harness run gets one Session and one Task, created by the host inside `store.locked`, and the Session mirrors the run through `presentRun`:

- `startNativeRun(projectId, taskId, capabilityId, prompt, principal)`: creates the `Session` (`engine.name` from the adapter id, `sample: false`, `permission` from the thread), calls `runs.start` with `sessionId` and `taskId`, `claim`s it for the service, then launches the `NativeAgent` **without awaiting** (the pattern in `server/native-work.ts:331-341`).
- On every harness event, write `presentRun().sentence` as a `plain` log line and the event line as a `technical` log line; set `Session.state`, `Task.state` and `Task.reason` from the presentation; `persist` under `store.locked`. Use `RunService.use(hook)` for the before-step line and the return of `step` for the after-step line; do not add a polling loop.
- On `Suspended('approval')`: create a `Need` from `needFromWaitingStep` through the Store (`what`, `why`, `consequence`, `files`, `preview: []`), with your `ApprovalIdentity.actionDigest = intentHash` and `expiresAt` one hour out, and park the Session as `waiting`. Resolving that Need (`POST /needs/:needId/resolve`) must call `runs.decide` with `ttlMs` equal to the Need's remaining life and then resume the agent. A denied Need cancels the run.
- On `reconcile_required`: Session `waiting`, Task `reason: 'went-wrong'`, the reconcile sentence from `presentRun`, and no automatic restart. A person may cancel or, once you build it, reconcile with an explicit receipt.

### 3. Routes: `server/harness/routes.ts` (new) plus one mount line in `server/app.ts`

- `GET /api/projects/:id/harness/runs` (ids, states, capability, task, session), `GET .../runs/:runId` (the `HarnessRun` minus nothing; transcripts are references only), `GET .../runs/:runId/events?after=<seq>` (versioned events after the cursor; this is the reconnect path), `POST .../runs/:runId/cancel` (locked, `X-Diomedes-Client` required like every non-GET).
- Mount with `mountHarnessRoutes(app, store, host)` next to `mountTeamRoutes` (`server/app.ts:342`). That is the only line in `app.ts`. Coordinate the hunk with your approval-receipts changes to the same file.
- The `state` SSE event already pushes `sessions`; harness runs reach the client through the Session mirror, so no new SSE event is needed in this packet.

### 4. Slice A fixture capability: `server/harness/capabilities/format-report.ts` (new)

- Tools: `read_fixture` (pure; reads a file the capability ships under `fixtures/harness/`, never a project file), `format_lines` (pure; deterministic formatting), `propose_write` (`idempotent`, `approval: true`, `permission: 'write-project-file'`, `destination: 'local'`; handler calls `Store.writeRecorded` with the expected sha of the target and the exact text; the idempotency key from the step context is the write's `label`).
- Adapter: `ScriptedModelAdapter` in `server/harness/fixture-adapter.ts` that follows a fixed script for the test and demo; `capabilities()` returns `ADAPTER_CAPABILITIES['native-fixture']`.
- Manifest: `{ id: 'format-report', version: 'v1', tools: ['read_fixture', 'format_lines', 'propose_write'], requestedPermissions: ['write-project-file'], approvalPolicy: 'show-first', maxTurns: 6 }`.
- The synthetic restaurant brief is **not** in this packet; it is slice B in the map and a separate future packet.

### 5. Tests

- `tests/harness-host.test.ts`: `createApp` over a temp data folder (the `tests/native-work.test.ts` pattern), start a native run through the bridge, watch the Session mirror the run, see the Need appear with `approval.actionDigest === intentHash`, resolve it, see History gain the entry from `propose_write`, see the run `completed`; then reopen the app over the same folder and read `/runs/:runId/events?after=<seq>` from a saved cursor.
- Negative cases: resolving the Need after its expiry is refused and the run stays `waiting`; declining cancels the run and writes nothing; a second `POST /work/start`-style start while a run is active is 409 as today; the run file's `v` bumped to 2 makes `GET /runs/:runId` answer 409 with a plain sentence, not a crash; a crash between `writeRecorded`'s journal and the harness commit is replayed by `Store.recover` first and then reconciled by the harness (write the test with the child-process pattern from `tests/harness.test.ts`).
- Keep `npm run check` clean and `npx vitest run` green. Do not add Playwright coverage in this packet unless the Console shows a harness Session incorrectly.

## Migration and rollback

- No change to `state.json`'s shape beyond a Session and a Need created through existing functions. Harness runs are new files under `projects/<id>/harness/runs/`; deleting that folder removes every harness run and nothing else. No settings change.
- `Store.init` must not fail when the harness folder is missing or holds a run file it cannot read; log one sentence and skip the run.

## Invariants to keep (from the master document, checked by the existing tests)

Completed steps return their persisted observation. Changed intent means a new step or a fork. Unknown non-idempotent outcomes stop for reconciliation. Claim before dispatch; stale owners cannot commit. Approvals bind to intent hash, identity generation and expiry, and are never inherited by a fork. Budget is reserved before work and retained on failure. Completion and its event are one write. Provider transcripts stay opaque and apart from portable messages; a model change starts a new lineage rather than rewriting a prefix.

## Out of scope for this packet

Any real provider adapter (the Codex `EngineAdapter` is the packet after this one and needs the egress-grant rule from the map, section 3), the workflow graph, replay, the inbox, the broker, environments, MCP Apps, A2A, transfer, optimization, the desktop exe rebuild, any change to `F:\LocalAI`, Hermes, `~/.codex`, or the pinned Codex binaries.

## Report back

State what runs natively now and how it is invoked; changed files; commands and exit codes; failure cases covered; what is mocked; migration notes; and the next smallest step (the Codex `EngineAdapter` with its egress grant). Distinguish the verified runtime path (host test through `createApp`), the fixture adapter, pure helpers, and unimplemented contracts. Claim no Windows exe, security sandbox or real-model result without direct evidence.
