# First-run AI setup and native text routes

Implementation candidate on `codex/ai-setup-20260910`, based on `2e230c89020d1ddb4fd51720a201ad0b562fbef8`. This is uncommitted implementation evidence, not a published release or an installed replacement.

## Behavior

- First run exposes Connect an AI service with an explicit local-discovery action. Passive status reads do not discover, install, log in, or send prompts. Installation, exact-version compatibility, account route, model availability, user enablement, and unknown usage are separate. Diagnostics expand within the shared Settings layout.
- Purpose, detail preference, and file-change approval are independent. Migration preserves explicit values, completed setup, existing surface, service choices, projects and History. Familiarity never increases permissions. AI setup can be skipped without claiming connected AI.
- Installed tools are reused. The selected missing tool has a pinned official install preview, checksum verification, owned staging, cancellation, atomic activation and deliberate retry. Existing managed executables are hashed before reuse and before metadata execution. Windows x64 native assets include their runtime; no global PATH, execution-policy or security-setting changes are made.
- Native authentication is explicit. Claude uses Claude subscription authentication; OpenCode uses the separate native OpenCode Go route. OMP uses a separate native profile and a user-edited `models.yml` for literal OpenAI API credentials. The app creates an empty template only if absent, never reads credentials, and explains separate API billing. Native OMP `/login` is OAuth-only and is deliberately not presented as OpenAI API setup.
- Thread/project choices precede global defaults. Switching engines cannot carry another engine's model selection. Board Start resolves the task's route and confirms external inference separately from file approval. Native Work records its thread identity so successive proposals remain on the correct thread.
- Ask and Plan return text, with scoped streaming and Stop. Build/Fix use the existing NativeWork, exact approval, journaled Store writes and History. Console Show me first now renders native proposal contents as well as Runtime proposals. Engine output never writes files directly through these adapters.

## Capability and verification matrix

| Capability | Claude Code 2.1.252 | OpenCode 1.18.4 | oh-my-pi 18.0.6 |
| --- | --- | --- | --- |
| Native transport | CLI stream-json and control initialize | Owned loopback HTTP server and SSE | Native RPC ready v1, negotiate v2 |
| Supported account route | `claude-code:claude.ai` | `opencode:opencode-go` | Separate native `openai` API profile |
| Actual installed executable/version | Verified | Verified | Verified |
| Native metadata | Signed in; Sonnet and Haiku reported | Final package: signed in, 15 Go models; earlier checks returned 27 or timed out | Unknown; native profile has no configured usable model |
| Model request/response identity | Protocol fixtures | Protocol fixtures | Protocol fixtures |
| Streaming and cancellation | Protocol and Console fixtures | Protocol and Console fixtures | Protocol and Console fixtures |
| File proposals and exact recorded writes | Shared API and Console fixtures | Shared Console fixture | Shared Console Fix fixture |
| Engine tools | Observed: safe-mode, tools empty, strict empty MCP and hooks off; reject unexpected events | Observed: pure mode, isolated configuration, deny permissions, tools disabled, explicit single-step agent; reject tool/permission/retry events | Observed: isolated config, tools/extensions/skills/rules/LSP/PTY off; reject tool/host events |
| Retry/model fallback | Configured zero API retries; no fallback argument; validate returned model | Stop on retry events; no Diomedes redispatch or alternate provider/model | Exact retry, fallback and compaction settings disabled; validate terminal model |
| Exact file authorization | Enforced by existing approval/Store transaction | Same | Same |
| Instruction following | Instructional | Instructional | Instructional |
| Native OS sandbox parity | Unsupported | Unsupported | Unsupported |
| Native resume after interruption | Unsupported; fresh native session | Unsupported; fresh native session | Unsupported; fresh native session |
| Remaining quota percentage | Unknown, never inferred | Unknown, never inferred | Unknown, never inferred |
| Live model inference | **Not run** | **Not run** | **Not run** |

Metadata availability is not provider inference success. The application does not claim that a configured credential has been accepted remotely until an actual request succeeds. Short-lived inspection processes may contact a provider for metadata; they do not submit a model prompt.

## Evidence and checks

Final counts and packaged source identity are recorded in `evidence/ai-setup/final-verification.json`, `unit-results.json`, and `desktop-proof.json`. The package embeds the matching BUILD_INFO source digest; the executable hash alone does not identify its ASAR application payload.

Final source verification: TypeScript passed; all 697 unit tests across 35 files passed with zero failures or pending tests; all 28 browser tests across four files passed; production client build passed. The final package is verified with owned clean and upgrade profiles after the last source change.

Final candidate source digest: `5150ad62e28c4399f78829be542df6066baf523c87bf11ee3b625cd1814ff42f`. Final native metadata: Claude signed in with two models; OpenCode signed in with 15 Go models; OMP unknown with zero configured models. The final OpenCode catalogue again lacked Muse, so the earlier 27-model result must not be treated as the current selection authority.

Commands used, from this worktree:

```text
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run --maxWorkers=4 --reporter=json --outputFile=evidence/ai-setup/unit-results.json
node node_modules/vite/bin/vite.js build --logLevel warn
node node_modules/@playwright/test/cli.js test tests/ai-engines-ui.spec.ts tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts
node --use-system-ca scripts/package-desktop.mjs
node scripts/ai-setup-desktop-smoke.mjs
node --import tsx scripts/engine-install-probe.ts F:/Achilles/deliverables/ai-setup-research/opencode-windows-x64-baseline-1.18.4.zip
```

The new browser fixture uses injected adapters and no provider network/inference. It checks each route's scoped text, explicit model/account identity, visible streaming, cancellation, proposal preview and recorded files. Native protocol fixtures separately test malformed responses, wrong identities, tool attempts, provider/usage errors, cancellation, deadlines and cleanup. Real Windows tests run a shim under a spaced/non-ASCII path, prove owned-child termination, and cancel an injected native sign-in process. Existing discovery coverage includes PATH precedence, multiple candidates, known-folder fallback when PATH is stale, missing dependencies and offline probes. Removed installations and withdrawn models are rechecked before sending. WSL is not an advertised route.

Packaged clean and upgrade profiles are synthetic and owned by this test. No real account profile is copied. Native metadata is projected to noncredential fields only. The upgrade test preserves explicit approval/detail/engine choices and project History, and verifies that migration does not consent to discovery. The packaged official-reference-link test intercepts the desktop browser opener; it proves the allowlist without opening the user's browser.

An intermediate packaged OpenCode metadata check and a direct recheck hit the bounded startup timeout. The UI correctly kept authentication unknown and the route unready. `desktop-metadata-timeout.json` retains that outcome. A later instrumented metadata check returned HTTP 200, the signed-in Go route and 15 models in 1.3 seconds. The diagnostic allowed 45 seconds but did not need the extra time; the production deadline remains 15 seconds. A subsequent packaged check returned 27 Go models, including Muse Spark 1.3. Catalogue membership is supplied by the native service and is rechecked before sending. No cause for the intermittent timeout is established and no retry, model fallback or inference was introduced. The final packaged outcome is recorded separately in `desktop-proof.json`.

The official OpenCode ZIP was downloaded into the research folder, checked against its published archive digest, and used for a disposable fresh installation. Fresh activation, reuse without another download, and changed-binary rejection passed. This is not a global OpenCode install. Claude/OMP use the same native-binary activation path; their fresh download/install flows remain fixture-tested, not exercised against a clean machine.

Screenshots, personally inspected:

- `evidence/ai-setup/desktop-clean-setup.png`
- `evidence/ai-setup/desktop-checked-setup.png`
- `evidence/ai-setup/desktop-skip-ready.png`
- `evidence/ai-setup/desktop-upgrade.png`
- `evidence/ai-setup/desktop-settings.png`
- `evidence/ai-setup/desktop-settings-800.png`
- `evidence/ai-setup/console-exact-proposal.png`

Retained failures are diagnostic history, not final passes: obsolete no-adapter/model-selection expectations, fixture selector errors, and a cleanup-fixture timing assumption. Expanded browser coverage found and fixed two product issues: missing native preview contents and successive Work proposals remaining linked to the first task. A concurrent heavily loaded full-unit run exceeded an existing harness-host polling deadline; final verification runs the complete unit suite with four workers and no concurrent browser/package pass. `unit-failure-cleanup-race.json` preserves the initial cleanup-fixture failure.

Personal screenshot inspection also found that the stacked Settings summary overlapped the longer AI connection list at 800px. A Console-only narrow-width flow rule fixes the layout. Packaged verification now checks that the summary starts after the full reading section, in addition to checking horizontal overflow.

A final lifecycle regression reproduced OpenCode suppressing a cleanup failure behind a protocol error. It now preserves the original error code and adds a safe warning that the native process could not be confirmed stopped, using the shared engine cleanup error contract. The test terminates its owned fixture before simulating the cleanup failure and exposes no native diagnostic text.

## Exact limitations

- No live model smoke was approved during implementation. No application smoke used Opus, Haiku or another paid model. Native inference is **not end-to-end verified**; fixtures and actual metadata have different proof boundaries.
- Early OpenCode catalogues reported 15 models without Muse; a later packaged check reported 27 and included Muse Spark 1.3. Live inference still requires the explicit smoke approval that has not been received. No other model/provider/billing route was substituted.
- OpenCode metadata startup was intermittent on this host. Successful catalogue checks do not erase the retained timeout evidence or prove inference reliability.
- OMP's separate profile is unconfigured. Version 18.0.6 can exit before RPC ready when no model is available; the same early exit can also represent invalid native configuration. This is reported as unknown with setup guidance, not falsely as signed out or ready.
- Claude managed policies and native credential helpers remain provider/native authority. Configuration-based tool disablement is observed, not OS containment. OMP native API configuration must use a literal key; native credential helper commands are not part of this route's approval.
- Interactive successful login and fresh Claude/OMP installation on a clean Windows machine are not live-verified. Login command shape, cancellation, template preservation, install preview/failure/cancellation/retry and binary verification are tested.
- Stronger tools, WSL, native continuation/resume, production account brokerage, cross-device replay, tenant isolation and subscription quota measurement are outside this text/proposal slice.

## Official protocol and authentication references

- [Claude headless interface](https://code.claude.com/docs/en/headless), [authentication](https://code.claude.com/docs/en/authentication), [retry environment variables](https://code.claude.com/docs/en/env-vars), [current Claude-plan SDK policy](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
- [OpenCode server](https://opencode.ai/docs/server/), [exact v1.18.4 source](https://github.com/anomalyco/opencode/tree/v1.18.4), [official pinned release](https://github.com/anomalyco/opencode/releases/tag/v1.18.4).
- [OMP v18.0.6 RPC](https://github.com/can1357/oh-my-pi/blob/v18.0.6/docs/rpc.md), [native model configuration](https://github.com/can1357/oh-my-pi/blob/v18.0.6/docs/models.md), [official pinned release](https://github.com/can1357/oh-my-pi/releases/tag/v18.0.6).

Source excerpts and noncredential probes are in `F:/Achilles/deliverables/ai-setup-research`. Installed flags and RPC shapes were checked against these exact versions; unknown versions do not gain compatibility by assumption.

## ROADMAP IMPACT

Repository roadmap `.7` and canonical Drive `.6` were read. Both contain stale publication prose. The observed baseline was remote/main `2e230c8` and published release `v0.1.1-experimental.2`; this candidate is a later, uncommitted worktree. No publication state is inferred from the old roadmap text.

Exact proposed patch to section 7:

1. Preserve the previous release checkpoint as historical evidence. Replace the current-status sentence claiming the NR-02/NR-03 changes are unpublished with: “The previously reconciled source is published on main at 2e230c89020d1ddb4fd51720a201ad0b562fbef8 and release v0.1.1-experimental.2. The first-run AI setup/text-adapter candidate is local and uncommitted; see AI_SETUP_VERIFICATION_2026-09-10.md and its final source digest.”
2. Replace “Claude/OpenCode are planned” with: “Claude Code 2.1.252, OpenCode 1.18.4 and oh-my-pi 18.0.6 have implemented bounded text/proposal adapters in the AI setup candidate. Protocol/Console fixtures and packaged setup/migration checks pass. Native Claude metadata succeeds; OpenCode metadata has successful catalogue results and retained intermittent timeouts; OMP's isolated profile is unconfigured. No new route has approved live inference proof; these are not additional validated Runtime EngineAdapters or stronger containment guarantees.”
3. Add to VERIFIED / present: “AI setup separates discovery, compatibility, account route, models, enablement and unknown usage; preserves explicit onboarding preferences; offers selected pinned installation/native authentication; and routes exact file proposals through existing approval, Store and History.”
4. Retain as PARTIAL: approved bounded live-provider proof, successful native OMP API configuration, clean-machine Claude/OMP install/login verification, stronger native tools/containment/resume and known quota data.

Cloud synchronization is pending. No canonical document was overwritten; an authorized update must reread its revision and use `requiredRevisionId`.

## BUILD / PUBLICATION / DEPLOYMENT STATUS

Internal test candidate: `F:/Achilles/diomedes-wt/ai-setup/release/Diomedes-win32-x64/Diomedes.exe`. It is unsigned, experimental and embeds `sourceStatus: local-uncommitted`. It is not the main-checkout artifact for the user to install. See final-verification.json for the executable and ASAR hashes plus source digest.

No commit, push, merge, publication, deployment or replacement of the running installation occurred. Proposed commit: `feat: add first-run AI setup and native text adapters`. The exact changed-file list is `evidence/ai-setup/changed-files.txt`.
