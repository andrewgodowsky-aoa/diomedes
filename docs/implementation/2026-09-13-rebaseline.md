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

Layout after the C00 repair (section 14): `claims/` (winning claims and `.released.json`
records; `claims/attempts/`, the dense `claims/order/` sequence and one `claims/decisions/`
record per attempt; `claims/paths/` lock files kept only for the earlier tool),
`handoffs/issued/` (integrator handoffs and their single use), `external-claims/`,
`journals/<role>.jsonl`, `slot/heavy.json`, `work-orders/<node>.json`, `results/`.
`scripts/coordination.ts` implements it; `tests/coordination.test.ts` proves the acceptance
cases the original candidate had, and section 14 lists what the repair added:

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

| proposed shape | schema | built from |
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
No consumer was written in this patch. Test: `tests/contract-revision.test.ts` (23 cases on the
original candidate; 31 after the C00 repair, which makes the model source agree with the reported
model and binds every run reference to the run store's identifier pattern, section 14).

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
- **Anchors the package names that are not in the app on `212106e`**: the original candidate recorded 38 `missing-on-base` entries and one `proposed-new` (B00.I's `services/control-plane/contract/`); this line wrongly called all 38 `proposed-new`. The C00 repair binds the 14 site entries (W02's combined `tests/` and `scripts/check-copy.mjs` entry is now two) to `diomedes-site` at `cf784de`, where 11 name paths that exist and 3 are descriptive, and marks the Google Docs mirrors external. The remaining 24 `missing-on-base` entries are all `services/control-plane/**` or `docs/operations/` (`evidence/unified-20260913/dependency-order.md`).

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
the smallest implementation (32 cases). The combined full gates run on the integration
branch, not on this leaf, under the heavy slot. Section 14 records the repair pass's own
verification.

## 13. Status

- implementation: the original candidate `a034163` was committed and integrated into `origin/main` `03a1b80` on 2026-09-13. The C00 repair (section 14) is committed locally on `fable/c00-rebaseline-20260913` and is not pushed.
- independent review (`C00.R`): **failed** on `a034163` (Astra, findings C00-R1 to C00-R5); a renewed review is requested on the repair candidate.
- live provider: not applicable (no live call in scope).
- packaged / publication / deployment: not run.
- blockers: `B00.I` (03a) and `H01.I` (03b) wait for a renewed `C00.R` acceptance; contract revision `2026-09-13.1` stays proposed until then.

## 14. C00 repair pass

Astra's `C00.R` failed candidate `a034163` with five findings
(`evidence/unified-20260913/C00.R.md`). On 2026-09-13 Andrew asked for Astra's counterexamples
to be committed and C00 repaired before 03a and 03b. Claude Opus 5 did the repair in the fable
seat (session pid 48352) under the coordination root handoffs
`astra-c00-r-regression-files.json` and `fable-seat-c00-repair.json`. Astra's
`tests/c00-independent.test.ts` and review evidence were committed unchanged first, failing as
reported (13 of 27).

| finding | repair | tests |
|---|---|---|
| C00-R1: aliases and directories defeat exclusive paths | `canonicalPath` gives one repository-relative identity. Separators, `.`/`..` segments and case do not make a second path, and escaping, absolute, drive, stream, reserved-device and short-name spellings are refused. Two claims overlap when one identity equals or contains the other. Exclusion is ordered: each attempt is hard-linked under the next free dense sequence number in `claims/order/` and yields to every earlier overlapping attempt that won or has not decided, so overlapping attempts cannot both win. An attempt that never decides blocks until its holder or the integrator releases it. Hot-file checks use the same identity and fail closed. Claims written by the earlier tool still exclude, and won claims leave the lock files that tool checks. | canonical path identity (26), overlap exclusion under concurrency (5) |
| C00-R2: an arbitrary handoff string bypasses integrator ownership | `issueHandoff`: only the integrator issues a handoff, with a note, to one exact process identity, node, base and canonical scope. A claim that names it must match exactly. An id nobody issued, a record the integrator did not issue, any mismatch or a second use is refused as `handoff-invalid`. A valid handoff does not displace a live claim and is used only by a winning claim. Work mode lets the recipient edit only the hot path its own handed-off claim covers. | recorded handoffs (12) |
| C00-R3: owner checks omit process identity | An owner is role, host, pid, process start instant and worktree, compared after respelling (host and worktree case, separators, time zone). Claim release, slot release and work mode use it. The integrator ends another holder's claim only with a recorded reason (`authority: integrator`). A malformed identity cannot claim, take the slot or write a journal. The CLI requires `--pid` for the long-lived process and reads its start time from the operating system (`Win32_Process.CreationDate`; `/proc` on Linux) unless `--start` is given. | complete owner identity (17), command-line identity (3) |
| C00-R4: the proposed schemas admit contradictions | `profileSnapshotSchema.model` says `runtime` exactly when it names a reported model, as `directOrigin` records it, and `compatibilityForSavedRun` skips contradictory step records. `RUN_ID_PATTERN` is copied byte-identically from the run store and parity-tested; `authoritativeIds.runId`, `event.runId` and every continuation `ofRunId` use it. The first round left `forkPoint` a bounded id, wrongly saying no step-id pattern existed; the second round (below) gives it the run service's pattern. | 8 new contract cases (31 in all) |
| C00-R5: the manifest does not reconstruct its candidate | `C00.I.json` no longer hashes itself or its patch. The outer manifest, outside the tree, records the candidate commits, Git blob ids, sha256 over blob bytes (Git stores these files LF-normalized; working copies may be CRLF), patch digests and test results. The status text, the anchor labels (section 7), the HAR-10 and `AGENTS.md` wording and the `dependency-order.md` encoding are corrected, and the site anchors are bound to `diomedes-site` at `cf784de`. | none needed |

Verification of the repair, in the order it ran:

- RED: the new producer cases against the unrepaired code, 103 cases: 34 passed and 69 failed, each on a missing function or the reported defect (five winners in the alias race, impostor releases accepted, malformed identities accepted, `run/other` accepted).
- GREEN: `tests/coordination.test.ts` 72, `tests/contract-revision.test.ts` 31 and `tests/c00-independent.test.ts` 27, so 130 passed. The affected runtime suites (`harness-provider-outcomes`, `harness-lifecycle`, `harness`, `harness-negative`) passed 118.
- Repeats: the coordination and independent suites five times in a row, 99 of 99 each time, while the runtime suites ran alongside.
- Mutation: treating an undecided earlier attempt as settled is caught by the stuck-attempt test. Skipping the order scan (check-then-write) is caught by 11 tests, including the race (8 winners) and C01, C02, C04 and C05.
- CLI smoke against a scratch root: identity from the operating system, `--pid` required, an absent pid refused, an alias claim held, a claim under a handoff, a non-holder release refused and a holder release recorded.
- Type check: `tsc --noEmit` over the changed files and their imports with the project's compiler options, exit 0. The full-project run under the heavy slot is recorded in the outer manifest.

### Second round, after a hostile pre-check

Before `74939ae` went to Astra, a Claude Opus 5 hostile review (read-only, scratch roots only)
attacked it. Every finding below was reproduced before it was repaired, and each repair has a test
that failed first. The coordination root journal (`journals/fable.jsonl`, 2026-09-13T09:50Z)
records why the candidate was held back.

| finding | repair | tests |
|---|---|---|
| F1: the earlier tool on the shared root defeats exclusion (a directory claim then a child claim, an alias spelling, a role-only release of a repaired claim followed by a third claimant, an exact-path race) | Two parts are defects of the repaired tool and are fixed. An ordered claim now ends only by a release from its holder or from the integrator with a reason; a release record without that authority is ignored, the holder or integrator can still release, and that release is then recorded as `claims/releases/<id>.json`. A claim the earlier tool writes while an attempt waits is read again just before the attempt can win. The rest is the earlier tool's blindness to aliases, directories and ordered attempts, which the repaired tool cannot prevent: see the rollout requirement below. | release records (2); attempts still deciding (1) |
| F2: a retried `unslot` removes the next holder's slot | A slot is released once: `slot/releases/<slotId>.json` is published exclusively before `heavy.json` is removed, and a release that finds the record removes nothing. A slot id is checked before it names a file. If a process dies between the record and the removal, `heavy.json` stays, and the integrator removes it by hand after confirming that `slot/releases/<slotId>.json` names it; an automatic recovery would reopen the same race. | the slot (1) |
| F3: `forkPoint` accepts ids the runtime refuses (`step/2`, `../step`, `-x`, 150 characters) and rewrites `" step_2 "` | `STEP_ID_PATTERN` copies `STEP_ID` from `server/harness/run-service.ts` byte-identically, and `forkPoint` uses it without trimming. The test compares the schema with `RunService.step` on the same samples, because a fork point can only name a step the service recorded. | fork point (1) |
| E1: a path whose lock file name exceeds 255 characters throws after the claim won and leaves it held | Refused as `invalid` before anything is published. | lock files (1) |
| E2: an undecided attempt is invisible to work mode | Work mode is read-only while another process has an overlapping attempt that has not decided. | attempts still deciding (1) |
| E3: the handoff is used before the decision, so an attempt the integrator ends while it waits uses it up | Only a winning claim uses its handoff. A claim that wins after another claim of the same process used that handoff gives its paths back. | attempts still deciding (2) |

The review also asked for contention between separate processes: four processes race for
spellings of one path, and exactly one wins (exclusion across processes, 1).

Rollout requirement: the coordination tool on `origin/main` is still the earlier one. While any
session claims with it, exclusion between it and the repaired tool is not guaranteed. The earlier
tool checks only exact-path lock files, so it misses the repaired tool's directory claims, alias
spellings and undecided attempts, and its release checks only the releasing role. The repaired
tool writes those lock files and honors the earlier tool's claims, which narrows the gap but cannot
close it. Retiring the earlier tool takes three steps: land the repaired tool on `main` (Andrew's
push approval), switch every session to it, and have the integrator release, with notes, the
claims the earlier tool left in the coordination root.

Verification of the second round, in the order it ran:

- RED: the new cases against `74939ae`. Coordination: 81 cases, 74 passed and 7 failed. Contract: 32 cases, 31 passed and 1 failed. Each failure was the reported defect: a release without authority ended a claim (two cases), a retried slot release went through, an abandoned attempt used up its handoff, work mode ignored an undecided attempt, a claim the earlier tool wrote during a wait was missed, a 256-character lock name threw `ENOENT` after the claim won, and the schema accepted a 129-character fork point that the run service refuses. The cross-process race and the late-winner handoff case passed before the repair and stay as guards.
- GREEN, one finding at a time with a run after each, then again after formatting: `tests/coordination.test.ts` 81, `tests/contract-revision.test.ts` 32 and `tests/c00-independent.test.ts` 27, so 140 passed. The affected runtime suites passed 118.
- Mutation: eleven mutants, each killed. Each second-round mutant is killed by its own new test: an unrecorded slot release, any release record ending a claim, the handoff used before the decision, a late winner keeping its paths, work mode ignoring undecided attempts, no lock-name limit, no second look for the earlier tool's claims, a decision overwriting the first, and a trimmed fork point. The first-round mutants still fail 5 and 13 tests. Sources were restored and compared by sha256 after each.
- The pre-check's own scripts, rerun on the repaired code: a second slot release is refused and removes nothing; the long path is refused with nothing held; work mode is read-only; the later claim under the same handoff succeeds; fork points agree with `STEP_ID`. In the mixed-tool cases the third claimant after a role-only release is refused, while a directory claim, an alias and an exact-path race still let both tools hold, as the rollout requirement says.
- Type check: full-project `tsc --noEmit` under the heavy slot, exit 0 with no diagnostics.

### Third round, after the independent review rejected the second

`C00.R-2` rejected candidate `b750406` on 2026-09-16 at 01:40 (`commit_authorized: false`) on two
P1 findings, both reproduced by the reviewer against the earlier tool loaded from Git bytes at
`a0341639`. This round repairs the one that is repairable here, and the environment defect that had
blocked the review twice before it could start. Full evidence:
`evidence/unified-20260913/C00.R-2-repair.md`.

| finding | repair | tests |
|---|---|---|
| C00-R2-1: an unauthorized release still ends a **legacy** claim. `legacyActiveClaims` treated the presence of a `<id>.released.json` file as the release itself and never read it, so a release by a non-holder of the holder's role, or by the integrator with an empty reason, ended the claim and let a third owner take the path. The second round's authority check reached ordered claims only, because `releaseOf` and `releaseClaim` applied it behind a `!ordered` short-circuit. | The exemption is removed rather than narrowed: `releaseOf` no longer takes an `ordered` parameter, so no call site can reintroduce it, and `legacyActiveClaims` is expressed in terms of that single judgment instead of duplicating release-reading with a name set. Every claim now ends the same way, whichever tool wrote it — by its holder, or by the integrator with a recorded reason. An ambiguous legacy claim is retained until such a release exists. `releaseClaim` drops the same short-circuit, so a legacy claim whose `<id>.released.json` name is held by a record without authority is still releasable by its holder or the integrator, recorded at `claims/releases/<id>.json`; an unauthorized record can no longer make a claim unreleasable. | legacy release records (4) |
| The producer's OS lookup fails in a sandbox. `processStartOf` fell through to `powershell.exe` only on `ENOENT` and rethrew everything else, so a sandbox that forbids the spawn raised a raw `spawn EPERM` and killed the run before any review work began — twice. | Any failure to *run* the shell is a reason to try the next one; when both refuse, the caller gets the actionable "pass `--start`" guidance naming each shell and why it refused, instead of the raw error. Output that did arrive is still judged, so an unreadable value remains an integrity error and still throws. Reading a start time is one way to learn an identity, never the only one. | existing command-line identity case; A/B proof against `b750406` in the evidence |

**C00-R2-2 is not repaired and remains the rollout prerequisite.** The earlier tool checks only
exact-path lock files, so no change inside this tool can make it see a directory claim: the
reviewer's `R02` still fails by design, and the rollout requirement above is unchanged. Closing it
is a documented, verified transition of every writer to an agreed repaired tool, which the reviewer
states explicitly need not be a push.

Blast radius was measured on the live coordination root before any edit, by judging every release
record with the same `authoritative()` predicate: of 20 claims (15 legacy, 5 ordered), **none**
stops being suppressed under the stricter rule, because every release already on disk is
authoritative. The defect was real and reproducible but had never been exercised here, so the
repair creates no reconciliation backlog.

The candidate carries its own cases for this round in `tests/coordination.test.ts`, under
`C00.R repair round 3: legacy release records`: an unauthorized record leaves a legacy claim held
and a third claimant refused, the holder and the integrator-with-a-reason each still end it and
recover at `claims/releases/<id>.json`, and an authoritative legacy release still ends the claim,
so ambiguous claims are retained without retaining every claim. The reviewer's own suite
(`C00.R-2-tests.patch`) is **not** carried in the candidate: it is applied at review time, as the
reviewer applied it before, and it targets an external review worktree.

Mutation, restoring and comparing the source by sha256 after each: re-opening the exemption for
every claim is killed by five cases (two from round 2, three from round 3); re-opening it only for
legacy claims, by trusting the `<id>.released.json` name again — the exact C00-R2-1 defect — is
killed by the three round-3 cases and by no round-2 case, which is the review gap itself.

Verification of the third round: `tests/coordination.test.ts` 85 and `tests/c00-independent.test.ts`
27, so 112 passed; full `vitest run` green; `tsc --noEmit` exit 0; `vite build` exit 0. Run
separately against the reviewer's suite, 20 of its 21 cases pass, the exception being `R02`, which
is C00-R2-2 and fails by design.

The work ran under `claim_mu3ovgkg_29143976`, taken through `handoff_mu3ouwwr_8516a66b` after the
integrator released, with recorded reasons, the two claims left by `fable/pid 48352` — verified not
running at 2026-09-16T01:48:40 and again at 01:56:03. `AGENTS.md`, `shared/contract-revision.ts`
and `tests/contract-revision.test.ts` were released and not re-claimed: the six-family H01
amendment is not part of this round.
