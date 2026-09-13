# Coverage audit: 41 ENG/HAR/FIL/PAK rows on base 212106e

Classification vocabulary (C00): present-and-verified (code exists and a named test in tests/ exercises it, at the deterministic level), present-but-unverified, partial, absent, externally-blocked (needs a live account or binary). Live-provider, browser, packaged and installed-app evidence stay separate: none of these rows is claimed at those levels by this audit.

Inputs: the verdicts in docs/implementation/2026-09-12-brief-review.md (base for unchanged rows), a GLM 5.3 Flash read-only re-check of the ENG and HAR rows and a Muse 1.3 read-only re-check of the FIL and PAK rows against 212106e (scratchpad inventory/audit-*.md), and Fable verifying every path cited in this table.

| row | classification | basis | evidence | package work items |
|---|---|---|---|---|
| ENG-01 | partial | bounded Codex path present and tested; native turn/thread control absent | server/integrations.ts:734 askCodex; server/native-work.ts interrupt is generation-only; shared/engines.ts:76 native resume unsupported; tests/integrations.test.ts:691 | H02, H20 |
| ENG-02 | present-and-verified | Claude Code adapter with fixtures | server/engines/claude.ts:185,295; tests/claude-adapter.test.ts:71,87,99; live account proof not run | H03, H20 |
| ENG-03 | present-and-verified | OpenCode adapter with fixtures; startup budget widened to 45s | server/engines/opencode.ts:29; tests/opencode-adapter.test.ts:78-180; live proof not run | H04, H20 |
| ENG-04 | externally-blocked | Cursor ACP code present; live readiness, cancellation, containment and billing unproven; adapter test covers launcher resolution only | server/engines/cursor.ts:545,255-272,396,597; tests/cursor-adapter.test.ts:548; docs/implementation/2026-09-11-cursor-route.md:53 | H05, H20 |
| ENG-05 | partial | route facts with basis exist; harness AdapterCapabilities cover native-fixture/sample/codex/codex-team only | shared/capabilities.ts:26,53,80-395; server/harness/adapters.ts:14-89; server/engines/service.ts:22,168,221,251 | H01, H02, H03, H04, H05, H06, H12, H20 |
| ENG-06 | partial | versioned harness events and run-to-task/session mapping; native sessions still count log lines, no shared durable presentation across the four text routes | shared/harness.ts:146; server/harness/present.ts:14-22; server/native-work.ts:232; tests/harness-present.test.ts:78 | H01, H19 |
| ENG-07 | partial | admission replay, dispatch guard, lease claim, busy guard, re-admission test; no queue-pause control | tests/work-admission.test.ts:139,487; server/engines/service.ts:313; server/harness/bridge.ts:174; server/work-control.ts:345 | H07, H14 |
| ENG-08 | absent | note() appends a log line only; no steering channel, no Pending/Delivered/Rejected state | server/native-work.ts:1132; shared/work-control.ts header; shared/contract-revision.ts steeringAckSchema defines the future shape only | H02, H03, H04, H05, H06, H08 |
| ENG-09 | present-and-verified | follow-up queue with command identity, snapshot, ordering, delivery through admission | shared/work-control.ts:65-155; server/work-control.ts:125-345; tests/work-control.test.ts:144,239 | H08 |
| ENG-10 | present-and-verified | three stop scopes with receipts | shared/work-control.ts:31-49; server/work-control.ts:249; tests/work-control.test.ts:166,205,226 | H08, H21 |
| ENG-11 | partial | harness lineage/resume map, revocation and unknown-completion parking tested; native routes declare resume unsupported; no native retry/fork distinction | shared/harness.ts:200-201; server/harness/bridge.ts:306; tests/codex-engine.test.ts:140,152; shared/engines.ts:76 | H02, H03, H04, H05, H06, H08, H21 |
| ENG-12 | partial | usage-limit errors surfaced without substitution; no route-specific offline recovery path | server/engines/claude.ts:61; server/engines/opencode.ts:162; server/engines/cursor.ts:124; tests/claude-adapter.test.ts:87 | H01, H19, H21 |
| ENG-13 | partial | picker: thread-local vs saved default, effort ladder and ceiling, stale-pair refusal, picker-setup test; no search or favorites | client/console/Picker.tsx:178-312; shared/effort.ts; tests/picker-setup.test.ts:12,348; tests/models.test.ts:106 | H09, H19 |
| HAR-01 | partial | instruction delivery is real on the native proposal route (rules plus hashed files, whole-or-omit); the harness codex-engine route still sends fixed INSTRUCTIONS | server/harness/instruction-delivery.ts:135-259; server/native-work.ts:374-382,466,508,582; server/harness/codex-engine.ts:234-236; tests/native-work.test.ts:1216-1290 | H09, H11 |
| HAR-02 | present-and-verified | RuleResolution / InstructionView / GoverningRecord / admissibleAsRule | shared/rule-authority.ts:339-441; shared/instruction-view.ts:74-149; tests/rules-assembly.test.ts:123-130; tests/rule-authority.test.ts:247-259 | H11 |
| HAR-03 | present-and-verified | authority rank, precedence, no-dump host sentence path@sha | shared/rule-authority.ts:51-61,350-424; server/capability-packs.ts:88-118; tests/capability-packs.test.ts:255-298 | H11 |
| HAR-04 | partial | pack-gated discovery with change detection and visibility; refreshDocuments not wired; no nested or linked scope | server/capability-packs.ts:161,236,254; shared/capability-packs.ts:216; tests/capability-packs.test.ts:179-237,542-562 | H11 |
| HAR-05 | present-and-verified | bounded instruction view; whole-or-omit also applied at delivery | shared/instruction-view.ts:40-43,86-89,141-149; server/harness/instruction-delivery.ts:137-154; tests/instruction-view.test.ts:83-123; tests/native-work.test.ts:1264 | H11, H18 |
| HAR-06 | present-and-verified | authorize, hooks, authorize, lease/budget/approval, handler, authorize result; capabilityTools gate; Codex pin and re-authorize | server/harness/run-service.ts:531-551,664-674; server/harness/policy.ts:109-140; server/harness/lifecycle.ts:46-52,81-98,165-217; tests/rule-hooks.test.ts:204-236 | H12, H13 |
| HAR-07 | absent | no TTSR/matcher/stream interception; after-output verdicts only; modelStreaming unsupported | server/harness/native-agent.ts:275-312; server/rules.ts:200-213 | H16 |
| HAR-08 | absent | no unified drift detector; only invalid_arguments/stale/ignored fragments | server/connections/service.ts:375,495-518; server/harness/lifecycle.ts:165-217 | H15 |
| HAR-09 | partial | correction caps and parent-budget enforcement; fixture-only, no live supervisor | server/harness/native-agent.ts:113-128,303-311; server/harness/lifecycle.ts:293-360; tests/harness-lifecycle.test.ts:234-304 | H13, H15 |
| HAR-10 | partial | no four-state evidence enum in production; the verification evidence schema is now frozen in contract revision 2026-09-13.1 for consumers | server/harness/lifecycle.ts:221; shared/execution.ts:47,390-399; shared/contract-revision.ts verificationEvidenceSchema | H17 |
| HAR-11 | partial | budget baseline, bounded handoff depth and children, live-authority check; scheduler specified not built | shared/harness.ts:57-67; shared/handoff.ts:44-201,264-300; tests/handoff.test.ts:127-169; docs/harness/HARNESS_INTEGRATION_MAP.md:103-108 | H07, H14 |
| HAR-12 | absent | no context ledger or output reserve | shared/execution.ts:259-262; shared/harness.ts:166-174,269-273 | H18 |
| HAR-13 | absent | eager full tool descriptors; prefixHash without a stable-prefix protocol; no hash cache or bounded output | server/harness/tools.ts:77-90; shared/harness.ts:163,215-227; server/harness/host.ts:91,139 | H18, P04 |
| HAR-14 | absent | compaction disabled; envelope lacks goals, decisions and constraints | server/harness/run-store.ts:6; shared/handoff.ts:61-82 | H18, H21 |
| HAR-15 | absent | no headless production-Core entry or replay harness; adapters are fixture/sample/codex/codex-team | server/harness/adapters.ts:14-89; server/harness/fixture-adapter.ts:13-62 | H20 |
| HAR-16 | absent | no benchmark, eval, ablation or taxonomy code | server/harness/run-service.ts:116,616-641 | H10, H20 |
| FIL-01 | present-and-verified | read-only Files pane with tree, viewer, metadata and palette group | client/console/FilesPane.tsx:46,234,403; client/console/paletteEntries.ts:264; tests/workbench-palette.test.ts:38; tests/backend.test.ts:100 | P05 |
| FIL-02 | partial | on base 212106e only the recorded-document chooser exists; the live FIL-02 import slice Astra is finishing in the main checkout is pending integration and is not counted here | client/Workspace.tsx:2188,668; external claim astra-main-fil-02 | P05, P10 |
| FIL-03 | partial | DocumentInfo/DocumentContent carry path, kind, size and sha only; no producer, version, source-refs or review-state identity | shared/types.ts:111,119; server/store.ts:60; tests/backend.test.ts:66 | H17, P05, P06 |
| FIL-04 | partial | Markdown, text and plan rendered; unsupported kinds metadata-only | client/console/FilesPane.tsx:234,252; server/paths.ts:183; server/store.ts:1269 | P05 |
| FIL-05 | partial | Need.reviews evidence and baseDigest approval tested; no anchored comments, submit-once correction, compare, export or restore | shared/types.ts:181,187; server/trust/reviewer.ts:273; tests/reviewer.test.ts:309; tests/reviewer-authority.test.ts:255 | H17, P06 |
| FIL-06 | present-and-verified | activity projection from task evidence, Needs and History | client/console/activity.ts:131; client/console/ActivityOverview.tsx:31; tests/console-activity.test.ts:37 | H19 |
| PAK-01 | present-and-verified | manifest, local registry, activation records, routes, settings UI and thread wiring | shared/capability-packs.ts:124,147; server/capability-packs.ts:318,325; server/app.ts:1108-1144; client/console/Shell.tsx:1024; tests/capability-packs.test.ts:103,137,387 | P01, P04 |
| PAK-02 | absent | frozen local map; no registry fetch, authentication, digests, compatibility check or cache | shared/capability-packs.ts:147; shared/contract-revision.ts packLockSchema defines the lock shape only | P02, P09 |
| PAK-03 | partial | preview and provenance pin; activate/deactivate only; no dependency, conflict, update, rollback or unload | client/console/PackSettings.tsx:70-81; server/capability-packs.ts:98,318,325; tests/capability-packs.test.ts:116,137 | P01, P03 |
| PAK-04 | partial | discovery, indicator and rule hand-off; contributes rules/context/ui only; the pane is not an editor | server/capability-packs.ts:91,118,250; client/console/ProjectInstructions.tsx:71; client/console/FilesPane.tsx:7; tests/capability-packs.test.ts:104,255 | H11, P04, P07 |
| PAK-05 | absent | no Git status or history, branches or worktrees, diagnostics or LSP | client/console/FilesPane.tsx:7-15 | P06, P07, P08 |
| PAK-06 | absent | the weekly-brief compiler is deliberately separate; no business or export template manifest on the pack contract | shared/packs.ts:52,160; shared/capability-packs.ts:13 | P01, P10 |

## Counts

- absent: 11
- externally-blocked: 1
- partial: 18
- present-and-verified: 11

## Supporting release rows (not among the 41; tracked separately)

| row | status | evidence |
|---|---|---|
| Windows packaging / experimental installer | present-and-verified for v0.1.1-experimental.3 (built from 4fb8656, published 2026-09-12) | scripts/package-desktop.mjs; evidence/windows-release; docs/releases |
| Code signing | externally-blocked | nothing signed; Andrew owns the Azure Artifact Signing identity (docs/releases/CODE_SIGNING.md) |
| App updates / rollback platform | partial | scripts/app-updates-desktop-smoke.mjs; update-platform expansion is not activated by this package |
| Site release / capability registry | present-and-verified for the published .3 | diomedes-site src/data/releases.ts and status.ts (site main cf784de) |
| Antivirus false positive (Norton) | externally-blocked | quarantine history unread; submission follows publication (docs/implementation/2026-09-12-integration.md 12.9) |

These rows gate delivery of a release, not the capability rows above; they are never turned green by a capability row passing.
