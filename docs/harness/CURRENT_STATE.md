# Diomedes harness: current state, 2026-09-08

Written by Fable from source inspection of `F:\Achilles\diomedes` at `218f325` and its worktrees, 07:20 to 07:45 EDT. Plans and diagrams in the handoff package are not treated as shipped code; every claim below names the file it came from.

## 1. The checkout

| Fact | Value |
|---|---|
| Product tree | `F:\Achilles\diomedes`, branch `main`, HEAD `218f325` ("The documents cache stays fresh for ninety seconds, not twenty") |
| Dirty in main | `scripts/package-desktop.mjs` (a Codex desktop session's uncommitted packaging edit; not Fable's), `tmp/field-canon.html` (untracked design scratch) |
| Fable's isolated workspace | `F:\Achilles\diomedes-wt\fable-harness`, branch `fable/harness-boundary`, from `218f325`, `node_modules` junction to main |
| Stack | TypeScript 5.9, Express 5, React 19, Vite 7, Electron 44, vitest 3, Playwright 1.55, zod 4 (on main used only by `server/team/mcp.ts`; this branch also uses it for tool schemas in `server/harness/tools.ts`), `@modelcontextprotocol/sdk`. No database dependency; every durable record is JSON written with temp-file, fsync and rename (`server/store.ts:167-180`). |
| Runtime | Node 22.23.2 on this machine for `tsx` and tests. The packaged app runs the server inside Electron's main process from a bundled `server/app.mjs` (`desktop/main.mjs:55-74`), so `node:sqlite` availability is not established for the exe. |
| Layout | Flat: `server/`, `client/`, `shared/`, `desktop/`, `scripts/`, `tests/`. The package's proposed `packages/runtime`, `packages/core`, `packages/trust` monorepo does not exist and is not adopted. |

### Concurrent work that must not be overwritten

Two Codex (GPT-6 Astra) worktrees hold **uncommitted** work. Both are Astra's to commit; Fable merges only on Andrew's word (`F:\Achilles\planning\DIOMEDES-CODEX-COORDINATION-2026-09-08.md`).

- **A: `F:\Achilles\diomedes-wt\codex-foundation`** (`codex/foundation-20260908`, HEAD `bd33d40`, changes imported through `218f325`). Slice: durable Work-start admission. `server/work-admission.ts` (`parseWorkCommand`, `validateWorkReceipts`, `MAX_WORK_RECEIPTS = 1024`), a `WorkReceipt` on `Session.receipt` (`shared/types.ts`, fields `protocolVersion: 1`, `commandId`, `payloadDigest`, `eventId`, `admittedAt`, `route`, `scope: 'local-prototype'`), `Store.workCommand` / `recordWorkAdmission`, a new `GET /api/projects/:id/work/commands/:commandId`, `client/work-start.ts` (sessionStorage pending record, in-flight dedupe, no timers), 13 admission tests plus 17 client tests and a child-process exit harness. Write-up: `docs/implementation/2026-09-08-work-admission.md` in that worktree.
- **B: `F:\Achilles\diomedes-wt\codex-approvals`** (`codex/approval-receipts-20260908`, HEAD `218f325`, files last written 07:33 EDT, still being edited). Slice: exact, expiring approval receipts for a native proposal. Adds `ApprovalIdentity { proposalDigest, actionDigest, baseDigest, expiresAt, sources }`, `ApprovalCommand`, `ApprovalReceipt`, `ApprovalExecution` to `shared/types.ts`, `Need.approval` / `approvalReceipt` / `execution`, `HistoryEntry.approvalId`; `server/approval-admission.ts` (`APPROVAL_TTL_MS` one hour, `identifyApproval`, `assertApprovalMatches`); `Store.approvalCommand` / `recordApprovalDecision` / `settleApproval` / `interruptUnpreparedApprovals`; `GET /api/projects/:id/needs/:needId`. Its plan intends a shared `server/command-admission.ts`. No tests yet.

Neither worktree adds a scheduler, timer, retry loop or second document writer; recovery runs once at `Store.init`. Both co-edit `server/app.ts`, `server/store.ts`, `server/native-work.ts` and `shared/types.ts`. This packet therefore adds no lines to those four files and takes no name that either worktree uses.

## 2. Implemented components (what runs today)

| Concern | Files | Notes |
|---|---|---|
| Two surfaces, modes, threads | `client/Workspace.tsx` (Workbook), `client/Console.tsx`, `client/Settings.tsx`, `server/modes.ts`, `shared/effort.ts` | `Mode = ask | plan | build | fix`; a thread (`Conversation`) carries `permission`, `requested` (the person's model/effort choice) and `helper` (what the runtime reported). Fix has a three-try ceiling counted in `server/app.ts:1228-1242`. |
| Project state and persistence | `server/store.ts` | One `StoredState` per project in `<dataDir>/projects/<id>/state.json` (`statePath`, line 326), written whole with fsync by `persist` (364). `Store.locked` (298) is the single serialized write queue. History blobs in `history/objects/<sha>`, write-ahead journals in `<dataDir>/pending/*.json` replayed by `recover` (792). |
| Document mutation and history | `server/store.ts` `writeRecorded` (661) | The single funnel: expected-sha check, before/after blobs, journal first, then the writes, then `persist`. `HistoryEntry` and `Change` rows come from here; `restore` (919) is the only other project-file writer. |
| Approvals | `Need` (`shared/types.ts:107-121`), `NativeWorkService.resolve` (`server/native-work.ts:527`), `POST /api/projects/:id/needs/:needId/resolve` (`server/app.ts:920`) | A Need binds `what/why/consequence/files`, a `preview: Change[]` and `allowForTask`. Approval is a person's act; the engine never writes. Astra's worktree B is adding digest binding and expiry to this record. |
| Runs | `Session` (`shared/types.ts:123-147`) | The run-shaped record: `state: queued | working | waiting | done | stopped | failed`, a sentence log, `needId`, `engine { name, model, verified }`. Two producers: the deterministic sample worker (`server/work.ts`, timer-driven stages) and the Codex proposal run (`server/native-work.ts`, `start` 164 → `prepare` 344 → `resolve` 527). One active run per project (409 at `native-work.ts:187`). |
| Engine dispatch | `server/integrations.ts` `askCodex` (677) | Pinned Codex app-server 0.153.4 (`.data/native-runtime/codex.exe`, hashes in `evidence/native-runtime-manifest.json`), JSON-RPC over stdio: sandbox write-denial proof (`verifyWindowsSandbox`, 359-435, run at the top of every `askCodex` call, 721), `thread/start` with `sandbox: 'read-only'`, `approvalPolicy: 'never'`, every tool feature off (`integrations.ts:118-150`), policy echo check (833-846), `turn/start` (1017). Team runs add `features.code_mode_host` and one MCP server (164, 745). Ask/Plan call it directly from `app.ts:1479`; Build/Fix through `NativeWorkService`. |
| Proposal contract | `server/native-work.ts:63-128, 364-374` | STRICT JSON `{ summary, changes[{ path, text, summary }] }`, at most eight files, 128 KB, selected documents only. Applied only by `Store.writeRecorded` after the Need is resolved `go-ahead`. |
| Team service | `server/team/service.ts`, `mcp.ts`, `routes.ts`, `board.ts`, `mailbox.ts` | Loopback MCP host with per-slot bearer tokens in `team-secrets.json`, leased into `DIOMEDES_TEAM_<SLOT>` for a run and redacted after. Board = the `Task` list. Auto-wake budget 5 per slot per 10 minutes (`service.ts:71-72`). Ported semantics from AionCore v0.2.1 `aionui-team` (Apache-2.0), no Aion process. |
| Engine discovery, catalogue, usage | `server/discovery.ts`, `server/models.ts`, `server/usage.ts` | Roster of ten engines with `found/available/enabled/adapter/signIn` and plain-language `disclosure` lines (`IntegrationStatus`, `shared/types.ts:263-286`). Codex model ladder read from `CODEX_HOME/models_cache.json`. Usage from `account/rateLimits/*` and `thread/tokenUsage/updated`. |
| Live updates | `server/app.ts:1589-1645` | SSE with a 15 s keep-alive; events `state, project, tasks, needs, history, review, session, status, conversations, team, projects, settings, usage, ready`. Whole-object pushes, no cursor; a reconnecting client refetches `/state`. |
| Single-instance lock | `server/lock.ts` | `service.lock` in the data folder with start-time and port checks, claimed once at startup. |
| Path safety | `server/paths.ts` | Blocked folders and private names (`auth.json`, `.env`, `id_rsa`, `F:\LocalAI`), symlink and junction rejection. |

## 3. Not present (planned in the package, absent in source)

- No run, step, attempt or checkpoint records. A `Session` is task-level; a failed Codex run restarts from nothing.
- No tool registry, no host-owned effect classes, no capability manifests. Codex runs have no tools at all (team runs have the thirteen team tools through the MCP host, `server/team/mcp.ts`).
- No native model loop without an engine product: every model call goes through the Codex app-server. No `ModelAdapter` interface; `NativeGenerator` (`server/native-work.ts:11-23`) is the injection point tests use.
- No durable event journal or cursor; no reconnectable history beyond refetching state.
- No budgets other than the Fix try ceiling, the one-run-per-project gate and the team wake budget. No token or spend reservation.
- No leases or fences. One process holds the data folder; nothing guards a stale in-process job from committing (the sample worker's timer is the closest thing).
- No labels, tenancy or provenance. Everything is one local tenant; project scoping is by route parameter.
- No workflow definitions, traces, replay, forks, event inbox, credential broker (team tokens are the only brokered secret) or environment provider (the read-only sandbox is Codex's own, verified by a probe).
- Enforcement labels do not exist as a type; `IntegrationStatus.disclosure` carries the equivalent sentences.

## 4. State owners today

| Concern | Owner |
|---|---|
| Run/turn state | `NativeWorkService.prepare/resolve` (`server/native-work.ts`); sample runs `WorkService.advance` (`server/work.ts`) |
| Dispatch to an engine | `askCodex` (`server/integrations.ts:677`) |
| Approvals | `NativeWorkService.resolve` writing `Need.state` (Astra's B adds digest binding here) |
| Document edits | `Store.writeRecorded` (`server/store.ts:661`) |
| History | `Store.addEntry` + `Store.persist` |
| Team mailbox and board | `TeamService` (`server/team/service.ts`) |
| Settings | `Store.saveSettings` (`server/store.ts:511`) |
| Usage | `createUsageService().record` (`server/usage.ts:197`) |

## 5. Protected locations (never touched by this packet)

`F:\LocalAI` and any Hermes home or profile; `~/.codex` account files (`auth.json` is a blocked name in `server/paths.ts:27-35`; only `models_cache.json` and `config.toml` are read, by `server/models.ts` and `server/integrations.ts`); `.data/native-runtime/*.exe` (pinned binaries, not started by tests); `<dataDir>/projects/<id>/team-secrets.json`; `release/Diomedes-win32-x64/Diomedes.exe` (not rebuilt); the two Codex worktrees above; Andrew's real project folders (the CurseForge instance measured on 2026-09-08 morning).

## 6. Decision: adapt the host, or add the narrow missing module?

**Add the narrow module, `server/harness/` with `shared/harness.ts`, and leave the host as the authority it already is.** Reasons from inspection:

1. The host already has one document-mutation owner (`Store.writeRecorded`), one approval record (`Need`) and one write queue (`Store.locked`). The package's design requirement is that these stay singular. A harness that wrote documents itself, or kept its own approval UI record, would be the second authority the package forbids.
2. What is missing is below the `Session`: step intents, attempts, fences, approval binding to an intent hash, budgets, a versioned event cursor, a tool registry and a model adapter seam. None of that exists in `server/app.ts` (1,679 lines) or `server/store.ts` (1,134 lines), and both files are being edited in two Astra worktrees right now. Adding it in place would be neither small nor reversible.
3. Harness run records are event-heavy and bounded per run. `state.json` is rewritten whole with fsync on every change and pushed whole over SSE; the 2.9 MB state file was this morning's performance bug. Harness runs therefore live in their own files, `<dataDir>/projects/<id>/harness/runs/<runId>.json`, behind a `RunStore` interface so the driver can change later without touching the boundary.
4. Astra's admission slices bind the *existing* Work-start and Need records to digests. The harness step's `intentHash` is the same idea one level down. The bridge, stated in the integration map, is that a harness step waiting for approval will surface as a Need whose `approval.actionDigest` equals the step's `intentHash`, and that resolving the Need calls `RunService.decide`. That is P2 wiring; P1 keeps the binding rule and tests it in isolation.

What "adapting" still means: the host's existing vocabulary is the presentation contract. `server/harness/present.ts` maps a harness run onto `TaskState`, `Task.reason`, `Session.state` and Need-shaped fields, so the Workbook and Console show harness runs with the words they already use, and nothing new is invented for the visual system.

## 7. Evidence gaps carried forward

- The Codex tool inventory under `code_mode_host` is the model's own report, not a protocol-level proof (`evidence/codex-team-real-binary-2026-09-06.md`, D8). The adapter matrix labels tool calls **observed**, not enforced.
- `sandbox.networkAccess === false` is what the runtime echoes (`server/integrations.ts:837`); no outbound probe was run. Labelled **observed**.
- Whether `turn/completed` carries `model`, and the real `account/rateLimits/read` shape, are unverified against a live run (memory of 2026-09-06).
- Windows only. No test has run the packaged exe against this branch; the exe is not rebuilt.
- Astra's worktree B is unfinished; its final type names may differ from the ones listed above.
- `Settings.permissions.deleting`, `workingOutside` and `spending` have no server enforcement (`server/app.ts:127-136` validates them only).

## 8. Conflicts with the handoff package, by file

- `contracts/domain.ts` names `Task`, `Run`, `Approval`, `Event`, `Budget`. `Task` already exists in `shared/types.ts:83` with a different shape and `Event` is a DOM global under the project's `lib: ["DOM"]`. The reconciled contracts use the `Harness` prefix (`HarnessRun`, `HarnessEvent`, `HarnessApproval`) and refer to the existing `Task` by id.
- `contracts/domain.ts` `Budget` counts microunits, tokens, GPU bytes and workers. The host can account today for whole units per step, model calls and tool calls; the P1 budget carries only those and records wall time without enforcing it.
- `contracts/domain.ts` `Label.tenantId`. Diomedes is single-tenant local; the tenant id is the data folder identity (`'local'`) and is still checked on every operation so a crossing is a tested failure, not an unreachable branch.
- The package's reference uses `node:sqlite`. Not adopted: the exe runs the server inside Electron's main process and the project has a proven durable-JSON pattern. Recorded as a P2 driver decision, not a P1 change.
- `specs/WORK_PACKETS.md` proposes `packages/*` paths. Mapped to the flat layout in `HARNESS_INTEGRATION_MAP.md`.
- `prompts/GPT6_RUNTIME_IMPLEMENTER.md` asks GPT-6 to "persist run/step/attempt state through the existing or newly bounded local store". The bounded store now exists (`server/harness/run-store.ts`); the packet in `GPT6_RUNTIME_PACKET.md` names it.
