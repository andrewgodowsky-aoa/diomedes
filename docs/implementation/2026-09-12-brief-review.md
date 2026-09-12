# Brief-by-brief implementation check, 2026-09-12

Eight read-only reviews of the eight execution briefs of 2026-09-10 (`Diomedes_Eight_Execution_Briefs_2026-09-10.zip`), one Muse Spark 1.3 reviewer per brief in OpenCode's read-only plan agent, each given the brief verbatim and told that documents are claims and code and tests are evidence. Reviewed against `main` at `3658d33` (2026-09-12, before the console-tasks, picker-setup and HAR-01 slices landed). Verdicts are the reviewer's; file:line citations were spot-checked where the integrator's own knowledge disagreed, and the corrections are noted under each table. Prompts and raw output: session scratchpad `dispatch/review-*.ps1`, `reviews/*.log`.

Verdict words: **implemented** (the row's remaining work exists in code with a test), **partial**, **not implemented**, **cannot tell**.


## Brief 01: Release and demonstration

| ID | brief status | what the code shows (file:line) | verdict |
|---|---|---|---|
| REL-01 | PARTIAL / DEMO | `scripts/write-candidate-record.ts:200` enforces version/commit/digest/test agreement; `scripts/package-desktop.mjs:93` embeds BUILD_INFO with commit/digest, but no in-repo CI reconciliation record | partial |
| REL-02 | UNPROVEN / DEMO | `scripts/write-candidate-record.ts:200` writes candidate only on agreement; `scripts/package-desktop.mjs:97` embeds BUILD_INFO.json; `docs/implementation/2026-09-12-release-candidate.md:12` names `da84689` EXE+installer hashes tested via desktop/installer smokes | implemented |
| REL-03 | PARTIAL / DEMO | `client/AISetup.tsx:11` discloses checks/installs; `client/AISetup.tsx:113` never auto-discovers; `shared/onboarding.ts:50` supports skip/`aiSkipped` but no explicit connect-local/explore three-way first-run choice | partial |
| REL-04 | PARTIAL / DEMO | `client/AISetup.tsx:34` shows Found/Supported/Signed-in states; `client/AISetup.tsx:279` reports Installation cancelled; `server/engines/login.ts:50` requires native sign-in consent, with no expired-account recovery path | partial |
| REL-05 | UNPROVEN / DEMO | `server/work-admission.ts:86` binds commandId+payloadDigest; `server/store.ts:419` enforces `assertReplay` on `work.start`; `server/work.ts:84` records admission with saved permission | implemented |
| REL-06 | PARTIAL / DEMO | `server/support-bundle.ts:36` builds scrubbed bundle with `EXCLUDED`; `client/Settings.tsx:677` provides Copy support information; `tests/support-bundle.test.ts:53` proves secret exclusion, with no build-info copy button | partial |
| REL-07 | PARTIAL / DEMO | `client/Workspace.tsx:99` preserves ask draft in localStorage; `desktop/main.mjs:69` persists appearance via settings.json; `server/work-admission.ts:101` never evicts receipts, without pending-review restore proof | partial |
| REL-08 | UNPROVEN / NEXT | `desktop/app-updates.mjs:202` implements close-and-install handoff; `server/app-updates.ts:682` gates on busy, but no post-relaunch installed-version verification — only staged/helper smoke | not implemented |
| REL-09 | PROPOSED / NEXT | `server/app-updates.ts:49` defers via `isBusy`; `shared/app-updates.ts:14` fixes single stable channel; `desktop/app-updates.mjs:32` links release notes, with no opt-in background/update-on-exit/preview channel | partial |
| REL-10 | PLANNED / before broad distribution | `scripts/package-desktop.mjs:96` stamps `signing: unsigned-experimental`; `scripts/build-windows-installer.mjs:511` requires Authenticode NotSigned | not implemented |
| REL-11 | PARTIAL / NEXT | `server/store.ts:129` migrates settings/conversations/team additively; `server/work-admission.ts:121` fails closed on incompatible receipts; `server/store.ts:1308` restores files only, with no transactional migration/backup/rollback or downgrade guard | partial |
| REL-12 | PROPOSED / NEXT | `scripts/build-windows-installer.mjs:296` guards install dir ownership; `scripts/build-windows-installer.mjs:336` verifies ownership before uninstall and deletes only payload, with `NoRepair:1` and no export path | partial |

**Demo blockers (reviewer's list)**
- REL-08 lacks a proven downloaded-version upgrade with installed-version verification after relaunch.
- REL-03 lacks an explicit first-run choice between existing account, local model, and exploration without inference.
- REL-04 lacks expired-account recovery and complete cancelled-login recovery across guided sign-in.
- REL-06 lacks a build-information copy button alongside the existing support-bundle copy.
- REL-05 lacks end-to-end proof that Ready admission auto-starts the worker with saved route/permission without duplication.

## Brief 02: Four adapters and work control

| ID | brief status | what the code shows (file:line) | verdict |
|---|---|---|---|
| ENG-01 | PARTIAL / DEMO→NEXT | Bounded Codex text path exists (`server/integrations.ts:734` `askCodex`, `server/integrations.ts:395` `verifyWindowsSandbox`, `server/integrations.ts:941` MCP inventory, `server/native-work.ts:218` generation-only `interrupt`); native resume is explicitly unsupported (`shared/engines.ts:76`); no `turn/steer` or `turn/interrupt` call exists | partial |
| ENG-02 | PARTIAL / DEMO→NEXT | Subscription-only login (`server/engines/claude.ts:117`), safe args without `--bare` (`server/engines/claude.ts:25`, `tests/claude-adapter.test.ts:53`), empty tools plus strict MCP and hooks disabled (`server/engines/claude.ts:35`), streaming deltas (`server/engines/claude.ts:294`), native session tracking (`server/engines/claude.ts:259,292,315`), cancellation fixture (`tests/claude-adapter.test.ts:96`) | implemented |
| ENG-03 | PARTIAL / DEMO→NEXT | Go-only route (`server/engines/opencode.ts:25`), session create (`server/engines/opencode.ts:473`), exact provider/model parse and recheck (`server/engines/opencode.ts:203,466`), deny-all agent config (`server/engines/opencode.ts:73`), SSE text/tool/permission guards (`server/engines/opencode.ts:492,558,564`), idle plus terminal completion (`server/engines/opencode.ts:630`), abort cleanup (`server/engines/opencode.ts:662`) | implemented |
| ENG-04 | UNPROVEN / DEMO→NEXT | ACP initialize plus ask mode (`server/engines/cursor.ts:545,562`), native deny rules (`server/engines/cursor.ts:517`), permission/question/plan denial then fail (`server/engines/cursor.ts:229`), tool/plan update rejection (`server/engines/cursor.ts:583`), `session/cancel` before kill (`server/engines/cursor.ts:393`); live readiness, cancellation, containment and billing remain unproven (`docs/implementation/2026-09-11-cursor-route.md:53`) | partial |
| ENG-05 | PARTIAL / DEMO | Pinned versions and compatibility gate (`server/engines/service.ts:22,168,221`), stale-status and withdrawn-model refusal (`server/engines/service.ts:251`), route facts with basis (`shared/capabilities.ts:80`); harness capabilities cover only fixture/sample/codex (`server/harness/adapters.ts:14,50`) with no Claude/OpenCode/Cursor entries and no steering/resume/vision/streaming facts | partial |
| ENG-06 | PARTIAL / DEMO | Versioned run events (`shared/harness.ts:145`, `server/harness/run-service.ts:460`) and run-to-task/session mapping for queued/running/waiting/reconcile/completed/failed/cancelled (`server/harness/present.ts:14`); native sessions only count log lines (`server/native-work.ts:232`) with no durable accepted/queued/started/text/tool/needs-you/corrected/result/verification/terminal presentation shared by all four routes | partial |
| ENG-07 | UNPROVEN / DEMO | Durable admission replay (`tests/work-admission.test.ts:139`), per-thread dispatch guard (`server/engines/service.ts:313`), two-request Codex cap (`server/integrations.ts:763`), harness lease claim (`server/harness/bridge.ts:174`), busy-project delivery guard (`server/work-control.ts:345`); no queue-pause control and no Ready-as-intent worker-claim ownership separate from grants | partial |
| ENG-08 | PARTIAL / NEXT; DEMO on a supported route | `note` only appends a log line stating it changes nothing (`server/native-work.ts:1024`); work-control slice explicitly records steering as not implemented (`docs/implementation/2026-09-11-work-control.md:172`); no Pending/Delivered/Rejected steering channel exists | not implemented |
| ENG-09 | PLANNED / DEMO minimum | Follow-up identity, snapshot, turn/task wait and ordering (`shared/work-control.ts:58,123,139`), queue/edit/remove/reorder (`server/work-control.ts:125,191,206,219`), consent/route/model revalidation plus admission-path delivery (`server/work-control.ts:335`), idempotent command and turn/task delivery tests (`tests/work-control.test.ts:144,239`) | implemented |
| ENG-10 | PARTIAL / DEMO | Three scopes and receipt shape (`shared/work-control.ts:31,38`), generation/task/queued semantics plus uncertain-effects sentence (`server/work-control.ts:249,42`), generation interrupt versus session stop (`server/native-work.ts:218,985`), scope tests (`tests/work-control.test.ts:166,193,220`) | implemented |
| ENG-11 | PARTIAL / NEXT | Run lineage fields (`shared/harness.ts:200`), saved-run resume map (`server/harness/bridge.ts:306`), unknown completion parks without redispatch (`tests/codex-engine.test.ts:152`), revocation blocks dispatch (`tests/codex-engine.test.ts:140`); native text routes declare resume unsupported (`shared/engines.ts:76`) with no native retry/fork distinction | partial |
| ENG-12 | PARTIAL / DEMO→NEXT | Usage-limit errors without substitution (`server/engines/claude.ts:61`, `server/engines/opencode.ts:162`, `server/engines/cursor.ts:124`), rate-limit and token-usage recording (`server/integrations.ts:1024`), version-change recheck (`server/engines/service.ts:221`, `server/engines/cursor.ts:497`); no route-specific offline recovery or explicit permission-aware fallback path | partial |
| ENG-13 | PARTIAL / NEXT | Thread-local versus saved-default versus model default (`client/console/Picker.tsx:96`), per-model effort ladder and ceiling (`client/console/Picker.tsx:192,117`, `shared/effort.ts:32`), stale-pair refusal (`tests/models.test.ts:106`), worker picker that does not change authority (`client/console/AgentPicker.tsx:34`); no search or favorites control | partial |

**Demo blockers (reviewer's list)**
- ENG-08: steering at a safe point does not exist; `note` is log-only.
- ENG-05: imported routes lack versioned facts for streaming, cancellation, steering, resume, vision and usage.
- ENG-06: no durable common event presentation spans all four routes.
- ENG-07: no pause-the-queue plus durable Ready and worker-claim ownership exists.
- ENG-04: Cursor has fixtures only; live readiness, cancellation and containment are unproven.

## Brief 03: Rules, context and evaluation

| ID | brief status | what the code shows (file:line) | verdict |
|---|---|---|---|
| HAR-01 | PARTIAL / DEMO | Canonical `assembleContext` (`server/rules.ts:314-343`) with route-adapted `enforcementFor` (`shared/rule-authority.ts:142-199`) and persisted revision/governing (`shared/execution.ts:258-262`, `server/harness/lifecycle.ts:81-98`); but `instructionRules` has no caller and `native-work.ts:498-512` sends strict-JSON without instruction files (`server/capability-packs.ts:114-119`, `docs/implementation/2026-09-11-capability-packs.md:151-163`) | partial |
| HAR-02 | PARTIAL / DEMO | `RuleResolution{applied,decisions,blocking,revision}` (`shared/rule-authority.ts:339-345,371-441`), `InstructionView{lines,facts,omitted}` (`shared/instruction-view.ts:74-84,119-149`), `GoverningRecord` without text (`shared/rule-authority.ts:465-479`), `admissibleAsRule` origin-only vs report-only `screenForInstructionText` (`shared/rule-authority.ts:230-316`); proven by `tests/rules-assembly.test.ts:123-130`, `tests/rule-authority.test.ts:247-259` | implemented |
| HAR-03 | PARTIAL / DEMO | Authority rank + `byPrecedence` + `blocking`/`weakens` (`shared/rule-authority.ts:51-61,350-357,383-424`), caller-supplied authority `toScopedRule` (`server/rules.ts:283-298`), no-dump host sentence `path@sha` (`server/capability-packs.ts:88-105`, `tests/capability-packs.test.ts:255-298`), facts with `origin/suspect` last (`shared/instruction-view.ts:164-168,196-218`) | implemented |
| HAR-04 | PLANNED / DEMO minimum | `discoverInstructionFiles` gated by pack activation via `projectFile` guard (`server/capability-packs.ts:154-167,250-280`), `sameFinding` change detection + `path@sha` provenance (`server/capability-packs.ts:83-86,232-240`), visibility `activeInstructionFiles` + `loaded` vs `found` (`shared/capability-packs.ts:206-211`, `tests/capability-packs.test.ts:542-562`); no nested scope or linked-doc following by design (`tests/capability-packs.test.ts:179-237`), `refreshDocuments` trigger unwired (`docs/implementation/2026-09-11-capability-packs.md:142-157`) | partial |
| HAR-05 | PARTIAL / NEXT | Bounds `VIEW_MAX_RULES=12, VIEW_MAX_RULE_CHARS=240, VIEW_MAX_FACTS=12, VIEW_MAX_TOTAL_CHARS=4000` (`shared/instruction-view.ts:40-43`), `shorten()+shortened` (`shared/instruction-view.ts:86-89`), over-budget file yields no rule to avoid midway cut (`shared/capability-packs.ts:88-93`), overflow keeps higher authority first with explicit `omitted` (`shared/instruction-view.ts:141-149`, `tests/instruction-view.test.ts:83-123`) | implemented |
| HAR-06 | PARTIAL / DEMO→NEXT | `RunService.step` authorize→hooks(copy)→authorize→lease/budget/approval→handler→authorize result (`server/harness/run-service.ts:531-551,664-674`), `authorize` policy (`server/harness/policy.ts:109-140`), live recheck `governanceHook`/`validateEffect` with route/base/grant checks (`server/harness/lifecycle.ts:46-52,81-98,165-217`), pre-tool `capabilityTools`+digest gate (`server/harness/native-agent.ts:317-331`, `tests/rule-hooks.test.ts:204-236`), Codex pin/re-authorize (`server/harness/codex-engine.ts:282-344,383-397,457-483`) | implemented |
| HAR-07 | PLANNED / NEXT; bounded DEMO stretch | No TTSR/matcher/stream code (grep `TTSR\|dormant` zero hits); instead after-output-only `inspect_model_output→verified\|correct\|refuse` (`server/harness/native-agent.ts:37-38,275-312`), `interceptionGuarantees` declares `modelStreaming:unsupported` (`server/rules.ts:200-213`); generic `cancel()` only (`server/harness/run-service.ts:808-841`) | not implemented |
| HAR-08 | PARTIAL / DEMO one real case | No unified drift detector (grep `drift` only comments/unrelated, e.g. `server/managed-usage.ts:20`); only fragments: `invalid_arguments`/`stale`/`ignored`/`revision_stale` (`server/connections/service.ts:375,495-503,518,908`), `validateEffect` without repeat/ignored counters (`server/harness/lifecycle.ts:165-217`) | not implemented |
| HAR-09 | PARTIAL / DEMO | `maxCorrections` default 1 cap 3 + `correction_limit` (`server/harness/native-agent.ts:113-128,303-311`, `tests/rule-hooks.test.ts:276-291`), `CORRECTION_LIMITS/correctionWithinBounds/correctionCandidate` (`server/harness/lifecycle.ts:293-360`, `tests/harness-lifecycle.test.ts:234-304`), parent budget `sharesParentBudget`+`coversChildren` enforced as run `units/modelCalls/toolCalls` (`shared/configuration.ts:220-229`, `shared/execution.ts:101-111`, `server/harness/run-service.ts:616-630`); noted as fixture-only not live supervisor (`server/harness/lifecycle.ts:25-31`) | partial |
| HAR-10 | PARTIAL / DEMO | No 4-state `not-run/passed/failed/inconclusive` enum; closest are `ObservationOutcome succeeded\|refused\|failed` (`server/harness/lifecycle.ts:221`), `GateVerdict passed\|refused\|not-required` (`shared/execution.ts:47`), `EvidenceObserved{verifier,verification}` unknown-by-default (`shared/execution.ts:390-399,437,544-545`), inspectors present read-only (`client/workbench/RunInspector.tsx:89`, `server/harness/present.ts:14-113`) | partial |
| HAR-11 | PARTIAL / NEXT | Budget baseline `HarnessBudget/HarnessUsage` wall recorded-not-enforced (`shared/harness.ts:52-67`), bounded `MAX_DELEGATION_DEPTH=3`/`MAX_CHILDREN_PER_HANDOFF=4` + `HandoffEnvelope` + `acceptHandoff` live-authority check (`shared/handoff.ts:44-45,61-82,96-201`), `modelPin`/`admissionOrder` (`shared/handoff.ts:264-300`), `Payer.coversChildren` (`shared/execution.ts:99-112`); scheduler specified not built (`docs/harness/HARNESS_INTEGRATION_MAP.md:103-108`) | partial |
| HAR-12 | PARTIAL / NEXT | No context-ledger/output-reserve file; only `context{scopeIds,instructionRevision}` (`shared/execution.ts:259-262`), portable text+observations (`shared/harness.ts:166-174`), optional `ModelResult.usage` observation (`shared/harness.ts:269-273`, `server/usage.ts:147-149`), assembly scope guard only (`server/harness/native-agent.ts:60-67`) | not implemented |
| HAR-13 | PLANNED / NEXT | Eager full `describe():ToolDescriptor[]` with `z.toJSONSchema` (`server/harness/tools.ts:77-90`, `shared/harness.ts:215-227`); `prefixHash` exists without stable-prefix/incremental protocol (`shared/harness.ts:163`, `server/harness/host.ts:91`); no hash-cache/bounded-output, only per-step `outputHash` (`server/harness/host.ts:139`); artifact refs explicitly not built (`docs/harness/HARNESS_INTEGRATION_MAP.md:39`) | not implemented |
| HAR-14 | PARTIAL / NEXT | Compaction future/disabled (`server/harness/run-store.ts:6`, `server/engines/opencode.ts:84`, `tests/omp-adapter.test.ts:62,116`); envelope carries only `artifact/evidence/unresolved/parentWork` without goals/decisions/constraints (`shared/handoff.ts:61-82`); no-permissions-in-prose structural (`shared/handoff.ts:11-16,172-201`) | not implemented |
| HAR-15 | PROPOSED / start baseline now | Adapters only `native-fixture,sample,codex,codex-team` (`server/harness/adapters.ts:14-89`, `server/harness/host.ts:343`); `ScriptedModelAdapter` fixed 4-step script not headless prod-Core entry (`server/harness/fixture-adapter.ts:13-62`); H15 marked out-of-scope P5 with no replay/evidence code (`docs/harness/HARNESS_INTEGRATION_MAP.md:116-118,49-53`); no headless/Harbor script in `scripts/*` | not implemented |
| HAR-16 | PROPOSED / start baseline now | No benchmark/eval/ablation/regression/taxonomy code in `server/harness/*` (only `HarnessBudget` units and queue-latency comment at `server/harness/run-service.ts:116,616-641`); harness tests cover steps/refusals/presentation only (`tests/harness*.ts`); quality/cost/latency comparison only aspirational (`docs/reference/DIOMEDES_PROJECT_MEMORY_BASE_2026-09-10.2.md:158`); brief asked benchmarks stay out of tree (`docs/implementation/2026-09-12-code-audit.md:387`) | not implemented |

**Demo blockers (reviewer's list)**
- HAR-01: canonical assembly exists but the external-route instruction wiring is unwired, so no persisted sent-instruction proof on real routes.
- HAR-04: project-instruction discovery lacks nested/linked scope and has unwired refresh triggers, so the DEMO-minimum discovery path is incomplete.
- HAR-08: no drift detector for repeated errors, ignored requirements, or stale sources exists, so the one-real-case DEMO bar is unmet.
- HAR-10: result verification lacks the not-run/passed/failed/inconclusive distinction, so model claims of done are not verification.
- HAR-07: no controllable TTSR stream matchers, cancellation, or recorded correction/retry exist, so even the bounded DEMO stretch is absent.

## Brief 04: Automatic local-model setup

| ID | brief status | what the code shows (file:line) | verdict |
|---|---|---|---|
| LOC-01 | PLANNED / DEMO | `server/local/hardware.ts:244` exports `detectHardware` reporting OS/CPU/RAM/VRAM/disk/runtimes with `disclosure` (`server/local/hardware.ts:312-322`); no importer besides `tests/hardware.test.ts:47`, `/api/ai/discover` covers external engines only (`server/app.ts:740-755`, `client/AISetup.tsx:148-153`) | partial |
| LOC-02 | PLANNED / DEMO | `client/AISetup.tsx:346-350` offers only engine discovery with no priorities questionnaire; `shared/configuration.ts:200` defines `local-only` policy but no ask-priorities flow | not implemented |
| LOC-03 | PLANNED / DEMO | `server/local/hardware.ts:6-8` states detection exists "so a later screen can recommend" with no estimator; no weights/context-cache/buffer/headroom logic exists | not implemented |
| LOC-04 | PLANNED / DEMO one backend | `server/engines/install.ts:12-54` pins only `claude-code`/`opencode`/`oh-my-pi` with SHA-256 and no llama.cpp runtime; `server/engines/service.ts:22-27` lists only those external tested versions | not implemented |
| LOC-05 | PLANNED / DEMO minimum | `server/engines/install.ts:203-251` is a single-shot engine download with staging/link and no pause/resume/storage-choice/parts verification; disks are reported but unused (`server/local/hardware.ts:291-292`) | not implemented |
| LOC-06 | PLANNED / DEMO | `server/local/hardware.ts:295-310` detects `ollama`/`llama-server`/`lm-studio` presence/version only; `server/integrations.ts:598-599` states Diomedes does not load, pin, or change any local model | not implemented |
| LOC-07 | PLANNED / DEMO | `server/models.ts:117-125` passes through only the Codex catalogue with no launch settings, chat/tool template, or text/tool/modality gate before route registration | not implemented |
| LOC-08 | PLANNED / DEMO→NEXT | `server/integrations.ts:598-608` only observes an external supervisor via `GET /localai/status` with no start/stop/health/recover, instance, port, or idle-release management | not implemented |
| LOC-09 | PLANNED / NEXT | `server/local/hardware.ts:315-316` reports total vs. available memory (`tests/hardware.test.ts:136-143`) with no profiles, headroom policy, residency, OOM recovery, or CPU fallback | not implemented |
| LOC-10 | PLANNED / NEXT | Existing update/rollback cover the app installer (`server/app-updates.ts:285`) and configuration (`server/configuration.ts:374`) with no runtime/model update, migration, regression check, or rollback path | not implemented |
| LOC-11 | PLANNED / NEXT→LATER | `server/local/hardware.ts:285-288` marks AMD/Intel acceleration unverified and GPU detection Windows-only, with no vision projectors, custom catalogs, or context-growth policy | not implemented |

**Demo blockers (reviewer's list)**
- LOC-01: the hardware detector is unusable in the app because no route or screen wires `detectHardware` to the setup flow.
- LOC-03: no compatible-model shortlist can be shown because no estimator combines weights, cache, buffers, concurrency, and headroom.
- LOC-04: no owned local inference runtime can be installed because no pinned, verified llama.cpp download path exists.
- LOC-05: no model can be fetched reliably because storage choice, progress, pause/resume, and atomic part verification are missing.
- LOC-07: no local route can go Ready because launch settings, template handling, and real text/tool/modality checks are missing.

## Brief 05: Files, artifacts and capability packs

| ID | brief status | what the code shows (file:line) | verdict |
|---|---|---|---|
| FIL-01 | PLANNED / DEMO | Read-only pane `client/console/FilesPane.tsx:314` with client tree `client/console/FilesPane.tsx:46`, text/Markdown viewer `client/console/FilesPane.tsx:222`, metadata bar `client/console/FilesPane.tsx:263`, Files search group in Ctrl+K `client/console/paletteEntries.ts:268`, Back returns via `onOpen(null)` `client/console/FilesPane.tsx:402` | implemented |
| FIL-02 | PARTIAL / DEMO→NEXT | Only recorded-document chooser `client/Workspace.tsx:2188`, attach removal `client/Workspace.tsx:668`, no drop/paste upload, image, type/size limits or upload status in `client/console/Composer.tsx`, `client/console/Shell.tsx` | partial |
| FIL-03 | PARTIAL / DEMO | `DocumentInfo` carries only path/kind/size/changedAt/marks `shared/types.ts:107`, `DocumentContent` only path/text/sha `shared/types.ts:115`, `artifacts` is a skipped folder `server/store.ts:60`, no durable producer/version/source-refs/review-state identity | partial |
| FIL-04 | PLANNED / DEMO basic; NEXT broader | Only Markdown/text rendered `client/console/FilesPane.tsx:113`, `client/console/FilesPane.tsx:305`; `unsupported` never read `client/console/FilesPane.tsx:234`, `client/console/FilesPane.tsx:292`; kinds are plan/markdown/text/unsupported `shared/types.ts:109`, `server/paths.ts:183`; oversized/unsupported only metadata `server/store.ts:1269` | partial |
| FIL-05 | PARTIAL / NEXT | Only `Need.reviews` evidence `shared/types.ts:173` and approval `baseDigest` `shared/types.ts:179`, reviewer checks `server/trust/reviewer.ts:273`; no artifact/base/range-anchored comments, submit-once correction, revision compare, export or Store restore | not implemented |
| FIL-06 | PARTIAL / DEMO | Projection `client/console/activity.ts:131` deriving Working/Needs-you/Ready-for-review/Finished-recently from taskEvidence/Needs/History, rendered `client/console/ActivityOverview.tsx:22`, tested `tests/console-activity.test.ts` | implemented |
| PAK-01 | PLANNED / DEMO first pack | Manifest `shared/capability-packs.ts:114`, local registry `shared/capability-packs.ts:136`, activation records `shared/capability-packs.ts:79`, `server/capability-packs.ts:282`, routes `server/app.ts:1062`, UI `client/console/PackSettings.tsx:25`, mounted thread wiring `client/console/Shell.tsx:984` | implemented |
| PAK-02 | PLANNED / NEXT | Packs are a frozen local map `shared/capability-packs.ts:136`; no registry fetch, authentication, pinned digests, compatibility check or local caching for packs | not implemented |
| PAK-03 | PLANNED / DEMO minimum→NEXT | Preview shows needs/summary/contributes `client/console/PackSettings.tsx:70`, provenance pin `server/capability-packs.ts:95`, load guard `shared/capability-packs.ts:161`, activate/deactivate only `server/capability-packs.ts:314`, `server/capability-packs.ts:321`; no dependency/conflict checks, updates, rollback or unload | partial |
| PAK-04 | PLANNED / DEMO bounded subset | Instruction discovery only `server/capability-packs.ts:250`, read-only indicator `client/console/ProjectInstructions.tsx:26`, rule hand-off `server/capability-packs.ts:114`; manifest contributes only rules/context/ui `shared/capability-packs.ts:121`, pane explicitly not editor/Git/diffs `client/console/FilesPane.tsx:7` | partial |
| PAK-05 | PLANNED / NEXT; LSP LATER | Pane states it is not an editor and pack tier owns editing/Git/diffs `client/console/FilesPane.tsx:7`; no Git status/history, branch/worktree, diagnostics or LSP/symbol code in `server/`, `client/`, `shared/capability-packs.ts` | not implemented |
| PAK-06 | PARTIAL / NEXT | Weekly-brief compiler is separate approved-files template `shared/packs.ts:52`, `shared/packs.ts:160`, deliberately separate from pack contract `shared/capability-packs.ts:13`; no business/export template manifest on the pack contract | not implemented |

**Demo blockers (reviewer's list)**
- FIL-02: no attach/drop/paste file or image upload with limits and removal before send exists.
- FIL-03: no durable artifact identity with producer, version, source references and review state exists.
- FIL-04: no CSV/table/image/PDF preview and no guarded external-open hand-off exists.
- PAK-04: no guarded repo search, changed-file review, or mediated test/build commands exist beyond instruction discovery.
- PAK-03: no dependency/conflict checks, updates, rollback or unload exist beyond activate/deactivate preview.

## Brief 06: Business and managed Diomedes Agent

| ID | brief status | what the code shows (file:line) | verdict |
|---|---|---|---|
| BUS-01 | PARTIAL / DEMO | Personal/Business switcher with fixture label and role-gated setup exists but hosted is refused (`client/console/Workspaces.tsx:25`, `server/workspaces.ts:780`, `client/console/Allowance.tsx:154`) | partial |
| BUS-02 | PLANNED / before hosted service | Production backend is a null pluggable stub and hosted orgs are refused as local fixtures (`server/trust/authority.ts:95`, `shared/workspaces.ts:128`) | not implemented |
| BUS-03 | PARTIAL / DEMO→NEXT | Questionnaire→proposal→activation exists but rehearsal is explicitly absent (`server/configuration.ts:93`, `shared/business-setup.ts:70`) | partial |
| BUS-04 | PARTIAL / DEMO→NEXT | Bounded native loop keeps attribution/origins but only a scripted fixture adapter is verified, no real provider adapter (`server/harness/native-agent.ts:1`, `shared/attribution.ts:13`) | partial |
| BUS-05 | PARTIAL contracts / NEXT | Gateway admits and never hands out keys but performs no real upstream dispatch/transport (`server/managed-gateway.ts:109`, `server/managed-usage-routes.ts:16`) | partial |
| BUS-06 | PARTIAL / before paid inference | Gateway reserve-last gate with parent-envelope budgets and ledger settle exists with tests (`server/managed-gateway.ts:167`, `server/managed-usage.ts:250`, `tests/managed-gateway.test.ts:1`) | implemented |
| BUS-07 | PARTIAL / NEXT | Allowance panel plus three-quantity settled charges exist but no estimated/observed/uncertain/invoice breakdown (`shared/managed-usage.ts:15`, `client/console/Allowance.tsx:21`) | partial |
| BUS-08 | PARTIAL / before hosted service | Local-only data-route refusal plus secret scrubbing exist; no approved-destination list, rotation, or contribution opt-in (`server/managed-gateway.ts:141`, `server/secrets.ts:4`) | partial |
| BUS-09 | PARTIAL contracts / before sales | Idempotent period-once billing events exist but plan is `sellable:false` with no checkout, trials, or dunning (`server/billing-events.ts:105`, `shared/managed-usage.ts:33`) | partial |
| BUS-10 | PARTIAL / DEMO minimum→NEXT | Proposal readiness and brief/integration status exist; no company workflow dashboard with owners, freshness, or time-return (`shared/configuration.ts:318`, `server/weekly-brief.ts:1`) | partial |
| BUS-11 | PARTIAL / before production | Last-owner guard plus tenant revocation exist; no governed company export/archive/offboarding or ownership-transfer flow (`server/workspaces.ts:389`, `server/trust/revocation.ts:57`) | partial |
| BUS-12 | PLANNED / NEXT | Support bundle redacts secrets but no defined support scope, consented diagnostics, incident ownership, or remote maintenance (`server/support-bundle.ts:20`, `server/connections/desktop.ts:2`) | not implemented |

**Demo blockers (reviewer's list)**
- BUS-02: hosted identity/membership cannot be demoed as real because only unverified local fixtures exist.
- BUS-03: company setup has no rehearsal step, so the first job is the real one.
- BUS-05: no real managed model transport exists behind the gateway admission contracts.
- BUS-07: usage view lacks the estimated/observed/uncertain/settled and invoice separation the brief requires.
- BUS-10: no company workflow dashboard with owners, freshness, and results/time-return exists.

## Brief 07: Connections, browser, recurring and remote

| ID | brief status | what the code shows (file:line) | verdict |
|---|---|---|---|
| OPS-01 | PARTIAL / NEXT | `server/connections/desktop.ts:1-2` no transport/vault/identity; `server/connections/desktop.ts:177` `mode:'fixture-only'`; `server/connections/toast.ts:164` no real vendor access; `client/connections/Connections.tsx:43` live Toast unavailable | partial |
| OPS-02 | PARTIAL / NEXT | `server/connections/openapi-candidate.ts:79` `generateCandidate`; `server/connections/openapi-candidate.ts:106-107` webhooks rejected; `server/connections/compiled-fixture.ts:231` fixture compile; `server/connections/compiler-demo.ts:249` demo-only activation; `server/connections/openapi-candidate.ts:279` candidate-only no reconciliation | partial |
| OPS-03 | PARTIAL / NEXT | `server/connections/service.ts:105-117` read-only fixture registration; `server/connections/mcp-projection.ts:70-98` authorized discovery; `server/connections/mcp-projection.ts:102` no pagination; `server/connections/mcp-projection.ts:109-112` read-only hints | partial |
| OPS-04 | PLANNED / NEXT | `server/connections/compiled-fixture.ts:254` no continuation cursor; `server/connections/compiled-fixture.ts:262` webhook unavailable; `server/connections/toast.ts:151-154` rate-limit text only, no network; `server/connections/service.ts:235` `reconciliation-required` flag only | not implemented |
| OPS-05 | PARTIAL / NEXT | `server/connections/credentials.ts:16` ephemeral synthetic key only; `server/connections/service.ts:492-504` health/stale status; `server/connections/desktop.ts:158-165` resume only; no rotation/reconnect/diagnostics | partial |
| OPS-06 | PROPOSED / NEXT | `server/integrations.ts:170-171` `browser_use:false`; `server/integrations.ts:78-79` browser tools disabled; `desktop/main.mjs:1` no viewer/webview, only app window | not implemented |
| OPS-07 | PROPOSED / LATER | `server/integrations.ts:169-171` computer/browser use false; no domain scope, takeover, download handling in `server/` or `client/` | not implemented |
| OPS-08 | PLANNED / NEXT | `shared/packs.ts:600-605` manual-only start, schedule stays off; no scheduler in `server/app.ts`, `server/harness/host.ts` | not implemented |
| OPS-09 | PARTIAL / NEXT | `desktop/main.mjs:1` imports window/dialog/Menu/shell, no Tray/autostart; `server/connections/service.ts:504` monitoring while host is online | not implemented |
| OPS-10 | PARTIAL / NEXT | `client/console/ActivityOverview.tsx:25-27` Needs you/review/recent headings; `client/console/Ledger.tsx:144` open-needs count; no quiet-hours/severity/dedup/deep-link code | partial |
| OPS-11 | PLANNED / NEXT→LATER | `server/trust/types.ts:33-34` `deviceId:null` until pairing; `server/trust/types.ts:59` `device-key` rank defined; no pairing, remote views, or revoke-device flow | not implemented |
| OPS-12 | PLANNED / LATER | No channel/route code in `server/`; only `shared/business-setup.ts:145` draft-replies label | not implemented |
| OPS-13 | PLANNED / LATER | `server/connections/toast.ts:110` not ingredient inventory; `server/connections/toast.ts:162` menu stock only; no scan/photo/lookup path | not implemented |
| OPS-14 | PLANNED / before managed operations promises | `server/store.ts:1308` file-restore only; `server/support-bundle.ts:68` diagnostics bundle only; no deployment/monitoring/backup/availability code | not implemented |

**Demo blockers (reviewer's list)**
- OPS-01: live authorized connector is missing because only the synthetic Toast fixture exists.
- OPS-04: incremental sync with paging, backoff, deduplication, and deleted-record handling is missing.
- OPS-05: credential expiration, rotation, reconnect, and model-independent diagnostics are missing.
- OPS-08: recurring scheduling with timezone, host, budget, and missed-run policy is missing.
- OPS-10: consolidated notifications with quiet hours, severity, deduplication, and deep links are missing.

## Brief 08: Learning and skill catalog

| ID | brief status | what the code shows (file:line) | verdict |
|---|---|---|---|
| LEA-01 | PARTIAL / start after DEMO path | Narrow correction capture only: durable `inspect_model_output`→`correct` sourceSteps in `server/connections/service.ts:1090-1094`, candidate provenance `server/connections/service.ts:1106`, before/after replay `server/connections/service.ts:1126-1128`, generic match replay `server/rules.ts:191-198`; no general correction/failure/success store with task/source/artifact provenance | partial |
| LEA-02 | PLANNED / NEXT | No user-memory store or scope/source/freshness/contradiction/opt-out API; closest is rules active/proposals/revisions `shared/connections.ts:123-127` gated to `host-reviewed` by `server/rules.ts:67-79`, with no memory routes in `server/app.ts` | not implemented |
| LEA-03 | PLANNED / NEXT | `proposeRule` supports only two templates with delta preview in `server/rules.ts:127-188`, admissibility gate `shared/rule-authority.ts:230-248`, served via `server/connections/service.ts:871-880`; no general skill/rule proposal and no narrowest-scope selection beyond caller scope | partial |
| LEA-04 | PLANNED / NEXT | Read-only replay exists: `server/rules.ts:191-198`, 3-case before/after replay `server/connections/service.ts:1112-1128` tested in `tests/connections.test.ts:770-806`; outcome is only matches/guidance `server/connections/service.ts:1118-1124` with no approved/negative/held-out suites and no regression/cost/false-intervention report | partial |
| LEA-05 | PLANNED / NEXT | Versioned manual promotion exists: configuration stage/activate/rollback `server/configuration.ts:249-304`, `server/configuration.ts:306-372`, `server/configuration.ts:374-445` with `ActivationRecord` `server/configuration.ts:59-65`, plus rule activate `server/connections/service.ts:882-919` and `rollbackVersion` `server/connections/service.ts:1088-1103` re-validated at `server/configuration.ts:397-406`; no shadow/canary evaluation and no deprecation lifecycle | partial |
| LEA-06 | PROPOSED / LATER | No automatic promotion path; activation requires explicit authority plus exact digest `server/connections/service.ts:888-898` and `expectedActiveRevision` plus readiness `server/configuration.ts:320-338`; no preapproved low-risk policy, thresholds, cost limits, or auto-rollback triggers | not implemented |
| LEA-07 | PLANNED / NEXT | Only a one-pack first-party catalog: `shared/capability-packs.ts:25-27` and `shared/capability-packs.ts:114-138`, toggled in `client/console/PackSettings.tsx:59-93` showing only needs/contributes `client/console/PackSettings.tsx:71-81`; no skill search, compatibility, provenance, permissions, install/update/uninstall, or examples | partial |
| LEA-08 | PROPOSED / NEXT | No skill import/export path; only local manifest validation `shared/capability-packs.ts:161-177` and exact-digest candidate checks `server/connections/compiler-demo.ts:255-256`; no interoperable format handling and no unsupported-field preview | not implemented |
| LEA-09 | PLANNED / NEXT | No organization-private skill library, approval workflow, version pins, revocation, or distribution; per-org manifests in `server/configuration.ts:47-53` cover setup not skills, and pack activation is per-project `shared/capability-packs.ts:79-86` | not implemented |
| LEA-10 | PROPOSED / LATER | No marketplace code for publishing, provenance/signatures, license checks, automated evaluation, moderation, abuse reports, or dependency security; only fixture candidate digest binding `server/connections/compiled-fixture.ts:161-175` | not implemented |
| LEA-11 | PROPOSED / LATER | No discovery/recommendation, task-fit evidence, permission-diff review, or ratings; closest is static pack needs/contributes display `client/console/PackSettings.tsx:71-81` | not implemented |
| LEA-12 | PLANNED / LATER | No consented training-data pipeline or model specialization/evaluation code in `server/`/`shared/`; loop described as future direction only in `docs/DIOMEDES_PROJECT_MEMORY.md:122` | not implemented |

**Demo blockers (reviewer's list)**
- LEA-02 blocks demo use because no user-memory inspect/edit/delete with scope, freshness, contradiction handling, or opt-out exists.
- LEA-03 blocks governed learning because evidence-to-candidate proposal is limited to two hardcoded rule templates with no skill path.
- LEA-04 blocks quality proof because replay covers only three local cases with no held-out tasks, regression, cost, or false-intervention reporting.
- LEA-05 blocks safe promotion because versioned activate/rollback exists but shadow/canary evaluation and deprecation are missing.
- LEA-07 blocks a useful ecosystem because only one first-party pack exists with no searchable skill catalog, compatibility, or install/update/uninstall flow.

## Totals across the eight briefs

| verdict | rows |
|---|---|
| partial | 46 |
| not implemented | 42 |
| implemented | 14 |

## Integrator notes (Fable, 2026-09-12 03:10 EDT)

**What moved on `main` after the reviewers read it (3658d33 → 2c9a548).**

- REL-05 / journey step "make a task and find it in Ready": the Console now has a control that creates a task through the existing `POST /projects/:id/tasks`, and a Board row whose last run faulted offers Start again through the same admission path (33fbda9 and its three siblings; `docs/implementation/2026-09-12-console-tasks.md`). Task creation is still not an admitted command (no `commandId`, no receipt); a double click is refused client-side, a reconnect mid-request is not deduplicated. The REL-05 row stays **partial** on that point.
- HAR-01: the project's recorded instruction files now reach the model through `instructionRules` → `assembleContext`, as a delimited "Project instructions" section of the same prompt on every route, with the delivered files and hashes recorded on the session and in History (2c9a548 and siblings; `server/harness/instruction-delivery.ts`, seven tests). The reviewer's **partial** becomes **implemented**, with two open items: no "sent" marker in the Console, and decision 14 plus three documents still say instruction text is "never pasted into a prompt", which is now false and is Andrew's to settle (`docs/implementation/2026-09-12-har01-delivery.md` names all four).
- ENG-03 / ENG-02 (the reviewer marked both implemented; the journeys had contradicted that on the packaged candidate): two live probes on main, one per route, each produced an approvable proposal with the model recorded (`evidence/route-probes/`, b7f9746). A refused reply is now kept scrubbed on the session and its fault entry (8d8ae4e), so the next such failure is diagnosable.
- REL-10 (signing): **not implemented** → **partial**. A keyless Azure Artifact Signing step, an opt-in `--signed` installer path and the route memo landed (aa59b4c). Nothing is signed; identity validation is Andrew's.
- REL-02: the candidate record script and a public asset writer exist (`scripts/write-candidate-record.ts`, `scripts/write-release-assets.mjs`); candidate 2 is being built from `main` as this document is written.

**Where the integrator disagrees with a verdict.**

- FIL-02 "partial": the recorded-document chooser exists, but attaching a file from the Console is not reachable by any control, which is what the journey measured. For demonstration purposes treat it as **not implemented**.
- REL-06 "partial" for want of a build-information copy button: the support bundle already carries version, commit and paths in its copied text. The remaining gap is a separate one-click build-info copy, which is cosmetic.
- ENG-07 "partial": the duplicate-start proof the reviewer asked for is in `tests/work-admission.test.ts` and was exercised by the Console slice's restart test; the missing pieces are queue pause and Ready-as-intent claims, which are roadmap items, not demo blockers.

**What this means for a demonstration.** Briefs 01, 02, 03 and 05 carry the demo path and are mostly present or partial in code; briefs 04, 06, 07 and 08 are largely not implemented and should be described as roadmap, not shown. The two journeys measured on the packaged candidate remain the honest statement of what a person can do; candidate 2 re-measures them.
