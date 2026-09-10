# Scoped work and attributable execution candidate

Status: implemented and verified as a local integration candidate. No commit, push, installation replacement, website deployment or cloud synchronization is included.

## Source and scope

Branch: `codex/autonomy-workbench-20260910`. Worktree: `F:/Achilles/diomedes-wt/autonomy-workbench`. Base: `0299f5154e5ed2b1fa07789cfc6c3728cc068a0a`. Read definitions: roadmap `2026-09-09.7`, project memory `2026-09-10.2`. The two supplied implementation briefs are applied within their supported adapter and verification boundaries; their old model-routing and plan-writing instructions do not override the user's later instructions.

The isolated candidate incorporates the necessary idle `ai-setup` and `settings-visual-consistency` worktree changes. Their original checkouts remain intact. `evidence/autonomy-workbench/dependency-source.json` records original source hashes and the integration result. No other worktree's files were committed. The new permission and workbench controls are Console-only. Existing Workbook attribution consumers receive the shared semantic correction, without new Workbook screens.

The selected workbench capabilities are an expandable run inspector and a Board derived from recorded task/session/approval/result state. The comparison and deferred capabilities are in `docs/workbench/FEATURE_GAP_LEDGER_2026-09-10.md`.

## Permission contract and migration

Protocol 1 exact approvals retain their proposal/action/base hashes, command IDs and execution receipts. Old `allowForTask` flags, presentation detail, familiarity, model choices and prose do not become new grants. Protocol 2 adds a separate task scope and scoped-authorization record; it never fabricates an exact human receipt.

A local client confirms one task, roots, supported text create/modify operations, Codex/ChatGPT route, maximum file writes/output bytes and expiry. Scope and reviewer routing are separate fields. The current bound is eight files per proposal, at most 200 file writes and 25,165,824 bytes over at most eight hours. Native proposal generation retains its smaller per-proposal output limit. Provider sending remains separately authorized.

Store remains the single journaled file writer. It reserves authorization durably, checks source identity and current authority, and checks again at the final effect boundary. Scope/work/exact commands share one project namespace. Strict saved-record validation rejects corruption; no silent migration broadens rights. Restart requires a fresh live grant, while historical decisions remain readable. Revocation stops owned work and prevents later scoped writes. Already dispatched effects may finish. Recovery distinguishes an intended but unapplied write from an actual outside edit; ordinary external changes are preserved.

The permission panel shows Review changes and Work in this project. Approve for me and Full access are explicitly unavailable. No reviewer route or arbitrary-command containment is claimed. Session-wide and project-wide remembered defaults are deferred. Local-client assurance means a loopback service boundary, not authenticated human/device identity.

## Attribution and workbench

Runtime-reported model identity is primary; engine is secondary. Requested identity remains distinct. Turns, pending proposals, run records, Team, Board, History and approval details reuse the shared formatter. Missing metadata stays explicit. Scripted/application actions may say Diomedes; that does not claim a live supervisor. Model prose cannot set actor labels. The new assistant role is included in route recovery and the existing Fix retry cap.

Per-step origin snapshots persist through replay and forks without changing intent hashes. Model generation and application/tool execution remain separate recorded actors; the bridge preserves the actual proposing model. The sidebar uses the same task-state projection as the Board, and the inspector names a scope-resolved request without inventing human approval. The permission confirmation displays project, task, folders, write/byte bounds and expiry before consent.

The inspector reuses scrubbed project/run endpoints and retained source hashes, authorization records and budgets. It rejects mismatched returned ownership and aborts stale loads. It does not show raw prompts, results or secrets. Unknown rule/skill/environment/token/spend evidence remains unknown. Counts of model/tool calls are not provider charges. Board Start is explicit and idempotent; Stop is cancellation, not pause/resume. Manual completion and a run ending are separate from verification. Start confirmation wording does not grant file access.

## Adapter guarantee matrix

| Route | Interception and file effects | Commands, review, containment | Cancellation / quota / proof |
| --- | --- | --- | --- |
| Codex direct text proposals | Host receives a bounded proposal; exact review or the new task scope applies through Store. Source/base and final-effect checks are enforced by the host. | Engine generation uses the existing no-file/no-shell request. Arbitrary commands, installs, external effects and deletion are outside task grants. No automatic reviewer or general filesystem/network sandbox claim. | Owned cancellation and restart/revocation have deterministic coverage. Actual in-flight provider effects can be uncertain. New scope workflow uses synthetic generation in browser/package proof; no new live inference result is claimed. |
| Claude Code 2.1.252 | Imported text/proposal adapter and exact Store approval path. Scoped automatic writes are unsupported. | Native text protocol/flag fixtures are tested. Adapter compatibility and metadata are distinct from live inference and OS containment. | Owned stop and protocol behavior covered by fixtures; provider quota is unknown. No fresh live model proof in this task. |
| OpenCode 1.18.4 | Imported text/proposal adapter and exact Store approval path. Go is a provider route, not an executor. Task grants are unsupported on this adapter. | Native service protocol fixtures; no equivalence with Codex reviewer/full-access modes is asserted. No billing fallback is introduced. | Metadata can time out; unknown remains unready. Owned process/protocol tests do not prove general containment or live inference. |
| oh-my-pi 18.0.6 | Imported RPC text/proposal adapter; exact Store review remains required. Task grants unsupported. | Separate profile and configuration ownership; no arbitrary tool/command containment guarantee. | Protocol cancellation fixtures; an unconfigured profile is not a working account. Quota and fresh live inference unverified. |
| Existing Runtime harness | Existing Trust/egress/tool admission and journaled bridge remain authoritative. New direct-task grants are not transferred to children or harness principals. | Declared tools and current policy remain distinct from observed provider-internal actions. Existing scripted/registered adapters do not establish unrestricted local execution. | Existing lease, cursor, cancellation, reconciliation and budget tests apply; new UI adds no scheduler, live-steer queue or second writer. |

Version facts for imported adapters are inherited from the exact source candidate and its focused report, not a new live metadata probe. Supportedness is enforced by the imported adapter compatibility checks. The source report is `F:/Achilles/diomedes-wt/ai-setup/docs/AI_SETUP_VERIFICATION_2026-09-10.md`.

## Verification

The final source suite passes 869 unit tests across 49 files, using four workers on this Windows host. TypeScript and Vite build pass. The full browser suite passes 32 tests, with nine responsive checks and a fresh focused updater check recorded separately. `evidence/autonomy-workbench/verification-summary.json` indexes the final logs, source digest and EXE/ASAR hashes. `candidate-build-info.json` records every packaged source hash and the unchanged pinned native runtime.

The actual packaged EXE passed `scripts/autonomy-desktop-smoke.mjs`: exact review and write, one confirmed folder scope for two further writes, an out-of-scope proposal left absent on disk awaiting approval, revocation, retained attributed History hashes, and honest inspector evidence. This exercises the compiled server and UI through real application routes with an explicitly synthetic generator. The parent inspected the rendered permission panel, inspector and update UI. The detailed proof is `autonomy-desktop-proof.json`.

One initial parallel browser run failed before its onboarding save reached the server with Chromium `net::ERR_NO_BUFFER_SPACE`. The trace was preserved outside the repository; an isolated full rerun passed all 32 tests without changing onboarding code. That transient failure is not presented as an application fix.

One unrestricted-concurrency unit run also missed the existing harness fixture's short wait for an open approval. That unchanged test passed in isolation; the final full suite limits worker contention instead of relaxing the assertion or changing production behavior. The failed run log is retained with the external implementation deliverables.

Deterministic cases include one grant for twenty independent writes, exact review, task/root/tenant/account/operation boundaries, stale sources, budget expiry, restart, revocation during generation and at the write boundary, replay, corrupt state and Windows path shapes. Browser acceptance uses real application routes and Store writes with a synthetic generator. No route stub stands in for grant/approval execution. Owned profiles and ephemeral ports prevent interference with the user's installation.

Live application inference on two routes remains unverified: no small application model-call budget was approved. OpenCode delegation for development and Luna research is separate from testing the application's model adapters. Actual NTFS short-name creation is not exercised; the conservative name guard and junction checks have their stated deterministic coverage.

## Roadmap impact

Candidate status advances bounded direct-task scope grants, shared historical attribution, the run inspector and honest Board projection. Automatic review, unrestricted execution, wider remembered scopes, live steer/queue, general supervisor parity and recurring/remote work remain deferred or require their named prerequisite. No core product definition changes. Cloud synchronization is pending a refreshed, revision-guarded reconciliation.

## Build, publication and proposed commit

The package is an internal verification candidate built from the dirty isolated worktree, not a shipped or installed application. Version and pinned native-runtime hashes are unchanged. The compiled package records base commit, source digest, dirty status and artifact hashes. A user-facing main build still requires approved integration.

The user's additional quick-update request is implemented and bounded separately in `2026-09-10-app-updates.md`. Installed copies can check, verify and explicitly close for their installer; release publication and a real downloaded upgrade are not claimed.

Development delegation now follows the user's correction: GLM 5.3 Flash for demanding reasoning/review, Muse Spark 1.3 for routine work, and DeepSeek V4.1 Flash as an alternative. These routes used OpenCode Go. Luna's research report was corrected to remove its earlier conflicting default ordering. No global model configuration or saved memory changed.

Proposed commit: `Add scoped work, recorded attribution, and app updates`.
The final changed-file list is `evidence/autonomy-workbench/changed-files.txt`. No commit, amendment or push has been performed.
