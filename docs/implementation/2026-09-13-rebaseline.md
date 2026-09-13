# Rebaseline, frozen contracts and the two-lead workflow (C00.I)

Date: 2026-09-13. Node `C00.I` of the unified execution package
(`Diomedes_Unified_Execution_Package_2026-09-13`). Implementation lead: Fable 5.1
(Claude Code, model `claude-fable-5-1`). Independent review: Astra (node `C00.R`,
Codex `gpt-6-astra`). This is the one current implementation ledger the package asks
for. It records what exists; it does not claim that any capability is shipped.

Canonical versions read: Core Pillars `2026-09-10.1`, Live Roadmap `2026-09-12.2`,
Project Memory `2026-09-10.7` (repository copies). The Google Drive mirrors read
pillars `2026-09-10.1`, roadmap `2026-09-10.4`, memory `2026-09-10.4`: the cloud
copies of the roadmap and memory are behind the repository. The repository is the
current canonical text; D01 reconciles the mirrors.

## 1. Identity

| what | value |
|---|---|
| app repository | `F:/Diomedes/diomedes`, `main` = `212106e75a710242e74620c3c5947aef4bbeef23` = `origin/main` |
| site repository | `F:/Diomedes/diomedes-site`, `main` = `cf784de56a5102ffb9948878eaeee31af51f7e10`, clean |
| this candidate | branch `fable/c00-rebaseline-20260913`, worktree `F:/Diomedes/diomedes-wt/c00-rebaseline-20260913`, base `212106e` |
| package checkpoint | app `212106e`, site `cf784de` (`shared/BASELINE.md`) — current source was not reset to it; nothing needed resetting |
| coordination root | `F:/Diomedes/diomedes/.git/diomedes-coordination/unified-20260913/` (derived from `git rev-parse --git-common-dir`) |
| contract revision produced | `2026-09-13.1` (`shared/contract-revision.ts`), status `proposed` until C00.R accepts it |

## 2. Installed runtime and compatibility

| component | installed | note |
|---|---|---|
| Node | 22.23.2 | `ai` 7.x on the registry requires `node >= 22`: compatible |
| npm | 12.0.2 | |
| Electron | 44.2.0 | `package.json` `^44.2.0` |
| Vite / Vitest | 7.3.6 / 3.2.7 | |
| TypeScript | 5.9.3 | |
| zod | 4.5.4 | the new schemas use zod 4 (`strictObject`, `discriminatedUnion`) |
| Express | 5.2.1 | |
| Playwright | 1.63.0 | |
| Vercel AI SDK (`ai`) | **not installed** | registry: `ai` 7.0.99, `@ai-sdk/openai` 4.0.66, `@ai-sdk/anthropic` 4.0.53. This is input to SDKR (the SDK decision), not an install. No dependency was added by C00. |
| Codex CLI | 0.153.4 | matches the pinned app-server in `server/harness/adapters.ts` |

## 3. Provider-qualified routes, model IDs and accounts

Model display names are not executable IDs. The IDs below are what the tooling
accepts today; every account is an already-paid subscription or a free tier with no
incremental charge. Live availability was checked at 01:24 EDT (`opencode models`,
`codex --version`).

| role | route (harness) | provider-qualified ID | account | incremental charge |
|---|---|---|---|---|
| Fable (integrator) | Claude Code desktop | `claude-fable-5-1` | Claude subscription | none |
| Astra (reviewer) | Codex desktop app-server (`ask-codex.ps1` ValidateSet) | `gpt-6-astra` (also `gpt-5.5`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.6-sol`) | ChatGPT subscription | none |
| Opus (bounded worker) | Claude Code `Agent` tool, `model: "opus"` | the tool exposes the alias `opus` only; the provider-qualified ID is not surfaced to the caller | Claude subscription | none |
| GLM (bounded tasks) | OpenCode (`ask-opencode.ps1`) | `opencode-go/glm-5.3-flash` (also `opencode-go/glm-5.3`) | OpenCode Go subscription | none |
| Muse (bounded tasks) | OpenCode | `opencode/muse-spark-1.3-contributor-free`; `opencode-go/muse-spark-1.3-contributor` | free tier / OpenCode Go | none |
| local models | OpenCode (`ollama/*`, `hermes-localai/*`) | present in the catalog; **out of scope for this program** | local | none |

Spend recorded for this program: approved incremental fixed infrastructure spend
**USD 0**; unapproved variable spend **USD 0**. C00 made no live provider call. The
`opencode-go/deepseek-*`, `qwen`, `kimi`, `minimax`, `grok`, `gpt-5.6-luna` entries in
the OpenCode catalog are not selected routes under the standing policy.

## 4. Live workers, dirty worktrees and claims discovered

No prior coordination root exists (`harness-packs-20260912` was never created; the
SDK packet has no lock root). There was nothing to bridge. Every live or complete
piece of work found is recorded in `external-claims/` under the coordination root:

| where | state at 01:32 EDT | owner | plan |
|---|---|---|---|
| `F:/Diomedes/diomedes` (main checkout, `212106e`) | dirty: FIL-02 export import (`server/file-imports.ts`, `shared/file-imports.ts`, `client/console/ImportFiles.tsx`, `BriefFiles.tsx`, `file-imports.css`, edits to `server/app.ts`, `server/paths.ts`, `weekly-brief.ts`, `workspace-routes.ts`, `FilesPane.tsx`, `Workspaces.tsx`, `playwright.config.ts`, two tests, two new tests). Reported complete by Astra (`docs/implementation/2026-09-13-fil02-export-import.md`, final focused run 01:24:32 EDT) | Astra, launched by Andrew at 01:04:56 | recorded as an external claim; integrated after an Opus read-only review; never `git clean`/`stash`/`checkout` there |
| `diomedes-wt/console-composer-revision-20260913` | complete, reported 01:27 EDT, uncommitted | Astra | Opus review, then apply to `integration/unified-20260913` |
| `diomedes-wt/console-task-admission-20260912` | complete (2026-09-12), uncommitted | Astra | same |
| `diomedes-wt/console-task-document` | complete (2026-09-12), uncommitted | Astra | same |
| `diomedes-wt/fil-02-local-exports` | complete but superseded by the live FIL-02 above | Astra | not integrated; left untouched |
| `diomedes-wt/release-20260912*` (three) | release candidates on `c5f09c6`, `4fb8656`, `dbf727f` | build tooling | untouched |
| `diomedes-wt/desktop-readability-20260911` | orphan directory, not a worktree | — | untouched |
| site `F:/Achilles/diomedes-site-wt/*` (two) | prunable worktree records pointing at a path that no longer exists | — | recorded; pruning is a site-repo action for W01 |
| heavy slot (ports 5174/47632) | held at 01:07 by Astra's composer browser run; free at 01:24 | — | the tool's `slot/heavy.json` is the record from now on |

Fable's own claim for this node (`claim_mtzduvno_9b5dcf0d`): `AGENTS.md`,
`docs/implementation/2026-09-13-rebaseline.md`, `evidence/unified-20260913/`,
`scripts/coordination.ts`, `shared/contract-revision.ts`, `tests/contract-revision.test.ts`,
`tests/coordination.test.ts`.

## 5. Coordination root and tool

Layout: `claims/` (atomic `wx` claim files plus per-path locks under `claims/paths/`),
`external-claims/`, `journals/<role>.jsonl`, `slot/heavy.json`, `work-orders/<node>.json`,
`results/`, `handoffs/`. `scripts/coordination.ts` implements it; `tests/coordination.test.ts`
proves the required acceptance cases:

- two workers claiming the same path: exactly one wins, the loser is told the holder;
- a stale timestamp alone does not permit a steal;
- a released claim can be taken again and the release names who ended it;
- a charter hot file can only be claimed by the integrator;
- two heavy verifiers requesting the slot: one holds it, the other waits with the holder named;
- releasing the slot as someone else is refused;
- journals are separate per role and append-only;
- a missing partner journal yields read-only work, not a second implementation;
- a non-integrator wanting a hot file is read-only even with the partner present.

## 6. Contract revision 2026-09-13.1

Additive. `HARNESS_CONTRACT_VERSION`, `WORK_CONTROL_CONTRACT_VERSION`,
`CAPABILITY_PACK_CONTRACT_VERSION` and `AgentResolution.protocolVersion` all stay 1.
`shared/harness.ts`, `shared/agents.ts`, `shared/engines.ts` and
`shared/capability-packs.ts` were inspected and not changed.

| frozen thing | schema | built from |
|---|---|---|
| command identity and expected revision | `commandIdentitySchema` | `commandIdSchema` regex and `payloadDigest` shape from `server/command-admission.ts`, plus `expectedRevision` |
| authoritative run/turn/event IDs | `authoritativeIdsSchema` | `HarnessEvent{v,seq,runId}`, `Session.id`, turn id; authority is always `host` |
| native session reference | `nativeSessionRefSchema` | `ProviderTranscriptRef{providerId,lineageId,opaqueRef}` |
| steering acknowledgment | `steeringAckSchema` | `StopReceipt.acknowledged` semantics as an enum: `pending`, `delivered` (must name the native session), `logged-only` (today's `note`), `rejected`, `cancelled` |
| resume / retry / fork | `continuationModeSchema` | `HarnessRun.parentRunId/forkPoint`, `StepIntent.maxAttempts`; native resume needs a native ref and a route that declares resumability |
| exact-model profile snapshot | `profileSnapshotSchema` | `OriginSnapshot.model{requested,reported,source}`, `AgentResolution.agentSelection/modelSelection`, effort |
| pack identity and dependency lock | `packLockSchema` | `CapabilityPackManifest{id,version}`, optional manifest digest, dependencies, `activatedAt` (activation is not authorization) |
| tool capability/effect reference | `toolRefSchema` | `ToolDescriptor` minus description, schema and handler, plus `inputSchemaDigest` |
| verification evidence | `verificationEvidenceSchema` | `capability` (implemented/partial/absent), `level` (deterministic/live-provider/browser/packaged/installed-app), `enforcement` (`Enforcement`), `outcome` (not-run/passed/failed/inconclusive/not-applicable with reason) as four separate fields |

Backward handling (`compatibilityForSavedRun`, `receiptRevision`): a v:1 saved run
reopens with exactly its saved `capabilityTools`, steering `unsupported`, continuation
`resume: host`, no packs, the last runtime-reported model or `not-recorded`, recorded
transcripts as references only, and lineage only when `parentRunId` was saved. Unknown
extra fields are ignored. Any other `v` is still refused by `FileRunStore.read`
(`unsupported_run_version`, the existing test at `tests/harness-host.test.ts:242`).
Receipts without `contractRevision` read as `pre-2026-09-13.1` and are never re-issued.

Astra's four named challenges map to: a steer racing terminal completion (steering ack
is an enum plus authoritative host ids, so a late `delivered` cannot be inferred from a
boolean); a resumed session with revoked tools (compatibility reports the saved tool
list, and tool refs carry effect and permission for the live re-authorize path in
`server/harness/lifecycle.ts`); a model alias changing identity (`requested` and
`reported` stay apart and `source` says whether the runtime reported at all); an
activated-but-unauthorized pack (`activatedAt` is a date, not a grant; Trust decides).
No consumer was written in this patch. Test: `tests/contract-revision.test.ts` (23 cases).

## 7. Inventory

Source inventory was dispatched read-only to GLM 5.3 Flash (routes, transports, grants,
runtime entries, resolvers, packs, Console; scratchpad `inventory/routes.md`) and the
rows below were verified by Fable against `212106e`.

- **Routes** (`shared/capabilities.ts` `ROUTE_CAPABILITIES`): `codex` (app-server JSON-RPC over stdio, `server/integrations.ts`), `claude-code` (CLI `stream-json`, `server/engines/claude.ts`), `opencode` (local HTTP/SSE service, `server/engines/opencode.ts`), `oh-my-pi` (RPC frames over stdio, `server/engines/omp.ts`), `cursor` (ACP over stdio, `server/engines/cursor.ts`), `harness-runtime` (in-process bridge, `server/harness/bridge.ts`, `host.ts`), `sample` (in-process, `server/work.ts`). Harness `ADAPTER_CAPABILITIES` cover `native-fixture`, `sample`, `codex`, `codex-team` only.
- **Native session/transport handles**: `Session.id` (server), Codex `threadId` (`server/native-work.ts:35-49`), `ProviderTranscriptRef` with `lineageId` (`shared/harness.ts:158-164`, written by `server/harness/codex-engine.ts:428`), approval receipts bound to `sessionId` (`server/approval-admission.ts`). No transcript persistence exists outside the harness run store.
- **Grant paths**: `ScopeGrantRecord` (`shared/permissions.ts:89`), `ScopeGrants.issue` (`server/trust/scope-grants.ts:210`), trust backend (`server/trust/authority.ts:91-390`), approval admission (`server/approval-admission.ts`), harness approvals (`server/harness/approval.ts`), review routes (`server/app.ts:1720-1739`). No HTTP route issues or revokes a grant directly; issuance is in-process.
- **Core runtime entries**: `server/native-work.ts:290 start`, `server/work.ts:28 start`, `server/harness/bridge.ts:84 start`, `server/harness/host.ts:395-440`, `server/harness/run-service.ts`; `server/harness/index.ts` is a barrel.
- **Model-profile resolvers**: `server/execution.ts:225 resolveExecution` (with the entitlement, trust and budget gates at `:66,:111,:147`), `shared/agents.ts:309 agentCompatibility` (there is no `resolveAgent`), `shared/effort.ts`, `server/models.ts` catalog.
- **Pack manifests**: one capability pack, `diomedes.software-engineering` 0.1.0 (`shared/capability-packs.ts:124-147`); `shared/packs.ts` is the weekly-brief template compiler, deliberately not a capability pack.
- **Console surfaces**: 24 files under `client/console/` (ActivityOverview, AgentPicker, Allowance, BoardView, BusinessSetup, Composer, Configuration, FilesPane, FollowUpQueue, Ledger, Mark, Need, PackSettings, Palette, PermissionPanel, Picker, ProjectInstructions, Rail, Shell, StopMenu, TeamView, ThreadView, Wake, Workspaces).
- **Anchors the package names that do not exist on `212106e`**: 38, all `services/control-plane/**`, `docs/operations/`, and site paths; each is marked `proposed-new` in its work order (`evidence/unified-20260913/dependency-order.md`).

## 8. Coverage audit

`evidence/unified-20260913/coverage-audit.md` classifies all 41 rows with evidence and
the package work items each maps to. Counts on `212106e`:

| classification | rows |
|---|---|
| present-and-verified | 11 (ENG-02, ENG-03, ENG-09, ENG-10, HAR-02, HAR-03, HAR-05, HAR-06, FIL-01, FIL-06, PAK-01) |
| partial | 18 |
| absent | 11 (ENG-08, HAR-07, HAR-08, HAR-12, HAR-13, HAR-14, HAR-15, HAR-16, PAK-02, PAK-05, PAK-06) |
| externally-blocked | 1 (ENG-04, Cursor live proof) |

The later task-creation (admission slice), picker/setup (`tests/picker-setup.test.ts`),
proposal-parser and instruction-delivery (HAR-01 on the native route) fixes are
preserved as current state; nothing was rebuilt from the old audit. Supporting release
rows (packaging, signing, updates, site registry, antivirus) are listed separately in the
same file and are not part of the 41.

## 9. Work orders and dependency order

`evidence/unified-20260913/work-orders.json` (52 implementation nodes, mirrored one file
per node under the coordination root's `work-orders/`) and
`evidence/unified-20260913/dependency-order.md` (all 104 nodes, topological, ties by wave,
priority, number). After `C00.R`, the ready Fable nodes are `03a B00.I` and `03b H01.I`.
Every work order names its inspected anchors, marks charter hot files as
integrator-owned, and requires a claim before an edit.

## 10. Proposed amendments (explicit; Andrew decides)

**A1. Owner priorities.** Fable owns production implementation, integration, shared
contracts and work orders; Astra owns independent tests and verdicts on exact base+patch
candidates; Opus is a bounded worker for B03 and B06 and for small disjoint units under a
written work order. Default concurrency: two delegated production workers plus one
independent test worker. Commit/push/release/deploy remain per-patch approvals by Andrew.

**A2. Automatic-profile requirement.** Every run resolves to an exact profile snapshot
(`profileSnapshotSchema`: Agent id/version/digest, route, requested and reported model,
selection source, effort) before dispatch, whether a person chose or Auto did. A run whose
runtime did not report a model records `not-recorded`; nothing fills it in. This is the
existing attribution rule made a precondition, not a new authority.

**A3. Instruction-delivery wording (flag only).** Standing decision 14 says repository
instruction files are "fed through the correct context and rule path rather than pasted
into a prompt". The HAR-01 implementation on the native route
(`server/harness/instruction-delivery.ts`) places hashed instruction-file bytes into a
bounded "Project instructions" prompt section (`InstructionDelivery.bytes`, "Instruction
bytes actually placed in the prompt"), whole-or-omit, visible and recorded in History.
`docs/implementation/2026-09-12-integration.md` 12.9 already notes that decision 14
describes the pre-HAR-01 state. The two texts need one reconciled sentence; no historical
evidence is deleted by this flag.

## 11. Out of scope for this patch

Local-model install/lifecycle, production Business (B lane), any consumer of the new
schemas, any change to `shared/harness.ts` or the other frozen contract files, the SDK
install, site changes.

## 12. Verification on this candidate

Recorded in `evidence/unified-20260913/C00.I.json` with actual output. Focused suites
were written first and failed for the missing modules (`Cannot find module
'../shared/contract-revision.js'` and `'../scripts/coordination.js'`), then passed after
the smallest implementation. The combined full gates run on the integration branch, not
on this leaf, under the heavy slot.

## 13. Status

- implementation: candidate complete on `fable/c00-rebaseline-20260913` (uncommitted until Andrew's per-patch approval is applied; Andrew pre-authorized commit and push to main for this run on 2026-09-13).
- independent review (`C00.R`): not run.
- live provider: not applicable (no live call in scope).
- packaged / publication / deployment: not run.
- blockers: local `main` cannot be fast-forwarded while Astra's FIL-02 is uncommitted in the main checkout; Playwright needs the heavy slot; `C00.R` is Astra's.
