# Owner Surface discovery

Prompt: OS-DISC-01. Report date: 2026-09-25. Author: Codex. Discovery only.

Task priority can be delivered first as a bounded change to the existing Task and Board. Person assignments come next, with a real actor and organization scope. The complete Owner Surface is not a small extension to the control plane: MI00 already assigns operational ownership to a governed business host, current Task admission identifies a local client, and phone access still needs the MI01/B03 boundary.

The revised request targets real main and all eleven decisions. Existing business access profiles, workforce constraints, verified completion, Files and inventory services must be reused. The important gaps are their authenticated integration, new human workflow records and safe migrations, not replacement subsystems.

Andrew's follow-ups add customer usability and product-boundary work: a curated AI-service list, tier/service choice on the Projects page and conversations, a drive-aware folder menu, separate internal/customer builds, company-only design creation and explicit AI-service entitlements. Sections 3.17-3.22 trace the causes and interactions; section 4 scopes OS15-OS20. The folder menu stays. Internal Claude access must not become free-customer access. These are proposed work orders, not implemented fixes or created editions.

## 1. Versions inspected

### Source and document baseline

The latest source cut is **d27230b15dc93aa13a764e1f4004d9aaf6fe34ab** (v0.2.0). Initial application analysis, Task/access consumer line references and compiler probes are pinned to **90f23fa1f97eb274ed08f926fb349a5d6886f724**; the initial report closed at **2a446874fc8285cbb2b6d9c50545c1721904d624**, whose application trees were identical. The three customer issues and pure routing probe were inspected on **bb43d0df27aeb64a6fc9d4c92ba7dba35f748b60**. The later #144 delta was checked for overlap and the discovery worktree fast-forwarded to d27230b; it does not change their settings, routing resolver or folder-list implementations. Earlier numbered source references remain pinned to their original cut where #144 shifts UI lines. Source references are repository-relative and one-based. This report makes no packaged-release, hosted-deployment, live-provider or device claim.

The requested checkout, `F:/Diomedes/diomedes`, is on `docs/fractional-ai-ops-agreement-20260919` at `c6db9d6e8e45f813a30c7b85242fbda9c5b778b8`, not main. At the initial audit local `main` was 914 commits behind; Andrew fast-forwarded that ref during discovery. A fresh fetch verified local `main` and `origin/main` at 90f23fa; the later #140 fast-forward is recorded below. The revised prompt authorized `F:/Diomedes/diomedes-wt/owner-surface-discovery` on `feature/owner-surface-discovery`; all subsequent source inspection uses that worktree. Earlier pinned-object and compiler observations were from the identical SHA. The docs checkout was not switched.

The requested checkout has unrelated work and untracked product documents. They were preserved; the latest tracked status reports `slot/history.jsonl`. Andrew's reported earlier 700 CRLF-dirty files are not a current measured count. This report was relocated from the docs checkout to the authorized discovery worktree, removing only the audit's own draft. Apart from the authorized discovery branch/worktree, this report is the only authored file. No source, test, package, claim or slot record was edited.

| Input | Inspected version or identity |
|---|---|
| Discovery prompt | OS-DISC-01 rev 2, 2026-09-25, in the docs checkout. Neither untracked input document exists in the new worktree; they were read at their actual source paths and not copied or edited. |
| Workspace instructions | `F:/Diomedes/AGENTS.md`; requested checkout `AGENTS.md` and `CLAUDE.md`; current-main contracts were checked against their source |
| ADR, initial audit | Requested checkout's untracked docs/product/ADR-owner-surface-2026-09-25.md was Proposed, rev 3, 257 lines, with an old v0.1.4 baseline. Initial SHA-256: 4F935294CBBDF41E438A91E118CF7F0967D4237B61036961F088C058C271A04A. Andrew's accompanying message supplied the main/access/workforce corrections used in the work orders. |
| ADR, follow-up re-read | The same external input was updated concurrently to rev 4, re-based on 90f23fa/v0.2.0, and re-read in full at the closing check. Current SHA-256: 8590D6E23505CCCECBB734B37A8BD654F57AD82783ABDB7B9DAD3B0905E55733. The new copy resolves the revision/Console/access/workforce/queue corrections identified against rev 3. It still needs the operational identity/API, editor, completion-evidence and disclosure qualifications below. This audit did not edit either input. |
| Current Core Pillars mirror | `docs/DIOMEDES_CORE_PILLARS.md`, 2026-09-22.1 |
| Current Roadmap mirror | `docs/DIOMEDES_LIVE_ROADMAP.md:3`, 2026-09-25.1 |
| Current Project Memory mirror | `docs/DIOMEDES_PROJECT_MEMORY.md`, 2026-09-25.1 |
| Control-plane package | `services/control-plane/package.json`, 0.0.1; B00 contract version 1 |
| Active execution package | `F:/Diomedes/planning/Roadmap and prompts/Diomedes_Unified_Execution_Package_2026-09-13/diomedes-unified-execution-2026-09-13/`; hereafter **PKG** |
| Package index | `RUN_ORDER.json`, version `1.1-mi-demo`, prepared 2026-09-13; 79 work items / 158 implementation and review nodes; SHA-256 `14838AD8759F22105DBAB29D04FDE64C61B06F3E17657A301D6B6A676AC45CCF` |
| Completion evidence | `coordination/completion-status.json`, snapshot audited 2026-09-23 against `cf40cd659ef6560e17d1fbc7ec5a384f4260c320`; SHA-256 `6CCA62CD0D77D7885376A014E542B54EF7CD2B0C1E6BD3C1DDBF9DC388BD9660` |
| Accepted MI00 | Merge `8d7d63b70809a3b8375a1594cc357f7f8f94e0ce`; independently checked as an ancestor of the inspected main |

The completion ledger records six DONE nodes: C00.I/R, B00.I/R and MI00.I/R. The other 152 are open in that ledger. This does **not** mean their code is absent: current main contains substantial H-, P-, account, funding and inventory work after that snapshot. It means full prompt completion must not be inferred from source presence or this audit. No completion state was changed.

The live Roadmap explicitly records Workbook removal and Conversation/Architect views (`docs/DIOMEDES_LIVE_ROADMAP.md:18`), newer harness/pack work with limited proof (line 20), and later completion/sandbox decisions (line 22). `client/Workspace.tsx` is absent on inspected main. No contents are assumed for it.

### Merged PRs after the package snapshot

Read-only GitHub PR metadata and the latest 60 main commits were inspected. The following merged PRs numbered 100 or higher all postdate the September 23 package snapshot. Merge metadata is historical acceptance context, not a fresh test result. Several topic PRs share an integration merge commit.

| PR | Exact title | Merged UTC | Main commit |
|---|---|---|---|
| [#100](https://github.com/andrewgodowsky-aoa/diomedes/pull/100) | H09: exact-model Agent profiles, routing preferences and immutable resolution (DIO-14) | 2026-09-24T23:26:29Z | 8d20fb9 |
| [#101](https://github.com/andrewgodowsky-aoa/diomedes/pull/101) | H21: migration framework, crash matrix, perf gate and completion journey | 2026-09-24T23:26:29Z | 8d20fb9 |
| [#102](https://github.com/andrewgodowsky-aoa/diomedes/pull/102) | H12: typed tool contract, recorded-effect admission, containment and attack matrix (DIO-17) | 2026-09-24T23:26:29Z | 8d20fb9 |
| [#103](https://github.com/andrewgodowsky-aoa/diomedes/pull/103) | P06: readable diffs, per-change keep, review comments and verified revisions (DIO-32) | 2026-09-24T23:26:29Z | 8d20fb9 |
| [#104](https://github.com/andrewgodowsky-aoa/diomedes/pull/104) | H13: Diomedes-owned plan, act, observe and finish loop with verified finish and bounded delegation (DIO-18) | 2026-09-24T23:26:29Z | 8d20fb9 |
| [#105](https://github.com/andrewgodowsky-aoa/diomedes/pull/105) | H15: drift detectors, bounded correction ladder and escalation through Needs (DIO-20) | 2026-09-24T23:26:29Z | 8d20fb9 |
| [#106](https://github.com/andrewgodowsky-aoa/diomedes/pull/106) | Overnight integration batch 4: H02, D5-codex, H09, H21, H12, H13, H15, P06, CD-05 | 2026-09-24T23:26:27Z | 8d20fb9 |
| [#107](https://github.com/andrewgodowsky-aoa/diomedes/pull/107) | Overnight integration batch 5: H03 Claude live controls, H05 kept ACP sessions | 2026-09-24T23:40:45Z | 4395331 |
| [#108](https://github.com/andrewgodowsky-aoa/diomedes/pull/108) | Record Andrew's 2026-09-24 decisions, and give the Windows gate job 30 minutes | 2026-09-25T00:26:09Z | 6104397 |
| [#109](https://github.com/andrewgodowsky-aoa/diomedes/pull/109) | Review C: independent review of H08, H02 and H18, with fixes | 2026-09-25T00:37:16Z | 9ce62ee |
| [#110](https://github.com/andrewgodowsky-aoa/diomedes/pull/110) | Review D: independent review of H12, H13, H15 and H17, with fixes | 2026-09-25T00:37:16Z | 9ce62ee |
| [#111](https://github.com/andrewgodowsky-aoa/diomedes/pull/111) | H10: guidance maintenance — proposals from evidence, signed revisions, evaluation and rollback | 2026-09-25T00:37:16Z | 9ce62ee |
| [#112](https://github.com/andrewgodowsky-aoa/diomedes/pull/112) | H14: bounded workers, a read-only advisor and durable handoffs for a lead loop | 2026-09-25T00:37:16Z | 9ce62ee |
| [#113](https://github.com/andrewgodowsky-aoa/diomedes/pull/113) | Review E: independent review of P05, P06, Automations B, D5 Codex, H09 and H21, with fixes | 2026-09-25T00:37:16Z | 9ce62ee |
| [#114](https://github.com/andrewgodowsky-aoa/diomedes/pull/114) | P04: load pack contributions on demand (index on activation, pinned digest-checked loads) | 2026-09-25T00:37:16Z | 9ce62ee |
| [#116](https://github.com/andrewgodowsky-aoa/diomedes/pull/116) | Review F follow-up: keep the H03 forced-stop test's grace above the acknowledgement timeout | 2026-09-25T03:04:22Z | 3db7c89 |
| [#117](https://github.com/andrewgodowsky-aoa/diomedes/pull/117) | H20: headless evaluation of the production Core and a derived all-route acceptance matrix | 2026-09-25T01:29:48Z | 67df53f |
| [#118](https://github.com/andrewgodowsky-aoa/diomedes/pull/118) | H16: stream-time rule triggers and safe intervention (DIO-21) | 2026-09-25T03:04:22Z | 3db7c89 |
| [#119](https://github.com/andrewgodowsky-aoa/diomedes/pull/119) | Overnight integration batch 6: H10, H14, P04, independent reviews C/D/E, H03 test fix | 2026-09-25T00:37:14Z | 9ce62ee |
| [#120](https://github.com/andrewgodowsky-aoa/diomedes/pull/120) | Reconcile the canonical docs with the overnight sprint and Andrew's 2026-09-24 decisions | 2026-09-25T00:56:54Z | a37e2f6 |
| [#121](https://github.com/andrewgodowsky-aoa/diomedes/pull/121) | DIO-107: read the pending claim from IndexedDB under the send lock (CD05-R-10 two-window flake) | 2026-09-25T02:44:45Z | 9507278 |
| [#122](https://github.com/andrewgodowsky-aoa/diomedes/pull/122) | Release pipeline on GitHub Actions, and version 0.2.0 | 2026-09-25T03:49:31Z | 1681115 |
| [#123](https://github.com/andrewgodowsky-aoa/diomedes/pull/123) | Overnight integration batch 7: H16 stream-time rule triggers, H20 evaluation matrix, review F, skin/update research | 2026-09-25T01:29:46Z | 67df53f |
| [#124](https://github.com/andrewgodowsky-aoa/diomedes/pull/124) | Show every release's notes in the app, from one file the site and pipeline share | 2026-09-25T02:44:45Z | 9507278 |
| [#125](https://github.com/andrewgodowsky-aoa/diomedes/pull/125) | H13 slice 2 / H14: delegates and workers work in sandboxes and return change sets | 2026-09-25T02:44:45Z | 9507278 |
| [#126](https://github.com/andrewgodowsky-aoa/diomedes/pull/126) | Review G fixes for H16 stream-time rule triggers | 2026-09-25T03:04:22Z | 3db7c89 |
| [#127](https://github.com/andrewgodowsky-aoa/diomedes/pull/127) | Update refresh: refuse a release that kept its version, and reconcile on the first launch of a new build | 2026-09-25T03:04:22Z | 3db7c89 |
| [#128](https://github.com/andrewgodowsky-aoa/diomedes/pull/128) | Overnight integration batch 8: sandboxed delegates, P07 Software pack, in-app release notes, DIO-107, review F and H16 follow-ups | 2026-09-25T02:44:43Z | 9507278 |
| [#129](https://github.com/andrewgodowsky-aoa/diomedes/pull/129) | Overnight integration batch 9: review G fixes for H16, first-launch update reconcile, review F follow-up | 2026-09-25T03:04:21Z | 3db7c89 |
| [#130](https://github.com/andrewgodowsky-aoa/diomedes/pull/130) | H16 Console: write trigger rules and start a work loop run from the Console | 2026-09-25T04:18:38Z | ef8b4d1 |
| [#131](https://github.com/andrewgodowsky-aoa/diomedes/pull/131) | Integration batch 10: rule triggers in the Console, and the 0.2.0 notes to match | 2026-09-25T04:18:37Z | ef8b4d1 |
| [#132](https://github.com/andrewgodowsky-aoa/diomedes/pull/132) | Fix the native connection's mid-turn lifetime close, and give Windows CI a bound its runner can meet | 2026-09-25T04:47:12Z | b2c03eb |
| [#133](https://github.com/andrewgodowsky-aoa/diomedes/pull/133) | Record the release proof runs and the 0.2.0 publishing steps | 2026-09-25T05:37:04Z | a36a98d |
| [#134](https://github.com/andrewgodowsky-aoa/diomedes/pull/134) | Wait for a new thread before typing in every ui.spec test that clicks New | 2026-09-25T05:14:34Z | 76fc1d4 |
| [#135](https://github.com/andrewgodowsky-aoa/diomedes/pull/135) | Replace Apache 2.0 with interim proprietary notice | 2026-09-25T05:11:12Z | 2b43ede |
| [#136](https://github.com/andrewgodowsky-aoa/diomedes/pull/136) | Bring the licensing docs in line with the interim proprietary notice | 2026-09-25T05:18:15Z | 82f09c6 |
| [#137](https://github.com/andrewgodowsky-aoa/diomedes/pull/137) | Tidy the SignPath row in the code-signing guide | 2026-09-25T05:18:55Z | a88d14e |
| [#138](https://github.com/andrewgodowsky-aoa/diomedes/pull/138) | 0.2.0 notes: the Updating section, the release proof record, and a macOS updater test fix | 2026-09-25T05:37:03Z | a36a98d |
| [#139](https://github.com/andrewgodowsky-aoa/diomedes/pull/139) | Bring the README's company, licence and Mac lines up to 0.2.0 | 2026-09-25T07:19:21Z | 90f23fa |
| [#140](https://github.com/andrewgodowsky-aoa/diomedes/pull/140) | Five fictional sample businesses with a reset command and a data check | 2026-09-25T08:07:08Z | 64e2323 |

PR #140 landed during discovery. The authorized discovery branch was fast-forwarded to **64e23238e10013b83dcdf0c879b8a5869c24733f**, matching local main and origin at that check. Its delta is 187 files / 4,999 added lines: fictional sample-business assets/helpers/tests, .gitattributes and two package scripts. The shared/, server/, client/ and services/ trees are byte-identical to 90f23fa; the source line references and Task/access consumer inventory below therefore remain valid at 64e2323 and the later 2a44687 final commit. The sample reset copies workspace files into an isolated folder with empty app data; it does not create Tasks, accounts or stock records. No sample reset or sample app was run.

The initial closing drift check found PR #142, merged 2026-09-25T08:09:45Z: [Name the product Nectovia and the company Diomedes Systems LLC in the README](https://github.com/andrewgodowsky-aoa/diomedes/pull/142). Its 2a44687 delta changes only README.md and tests/engine-routes.test.ts (39 additions, 36 deletions). Both diffs were inspected, and the discovery branch was fast-forwarded again. All application contracts at that cut were byte-identical to 90f23fa. The successful compiler baseline below remains specifically the earlier 90f23fa run, not a claimed rerun on newer commits.

The customer-issue follow-up found PR #141 merged at bb43d0d, 2026-09-25T08:18:33Z, and fast-forwarded only the discovery worktree and main ref. Its nine-file delta is 527 additions / 15 deletions: shared/stream-rules.ts, server/stream-rules/service.ts, client/console/TriggerRules.tsx, client/console/trigger-rules-model.ts, four tests and docs/implementation/2026-09-25-h16-followups.md. Settings, route selection, project folder browsing, Task and business-access contracts are unchanged. The new pure routing probe in section 3.18 passed on bb43d0d; no full compiler, unit suite, browser, packaged-app or live-provider rerun is claimed for this follow-up.

Read the newer sample README/scenarios before adding another remodeling dataset. Reuse its fictional source files as fixture inputs, then explicitly create synthetic operational records through the same tested services. Its CSV photo logs and Markdown messages are not upload/messaging implementation.

Recent product-document implications: the September 19 automations specification retains occurrence/definition/run separation; September 20 Core-agent decisions retain one actual conversational admission authority and explicit work targets; September 22 skin/name work makes Nectovia a shared display name; September 22/23 artifacts, shared parser, drawings trust, hardening, panel progress and Mermaid changes prohibit arbitrary pack/model markup execution and provide reusable renderer/Files identity; September 23 home-sharing and lineage continuity require explicit route-history consent and stable replay/scope. Visual convergence already retired a competing chart renderer. These findings are reflected in OS06-OS08; historical document test totals are not reported as newly rerun.

Named-file reconciliation: client/Workspace.tsx is removed on main. There is no server/team/wake.ts or client/console/Automations.tsx: wake logic is in server/team/service.ts and the screen is client/console/AutomationsPage.tsx. PB01-PB04 prompts are in the repository's personal-business package, not nodes in the unified RUN_ORDER. The untracked ADR/prompt are read-only external inputs to the new discovery worktree.

The final drift check also found PR #144, capture-polish, merged at d27230b on 2026-09-25T08:30:20Z: 36 files, 1,288 additions / 77 deletions, including captured evidence. The changes concern Board/Files/readiness presentation, charts, citations, weekly briefs and their tests. ThreadView's diff adds citation rendering and leaves route/style selection unchanged. The discovery worktree was fast-forwarded; the original detailed Task/UI reference inventory stays pinned to 90f23fa where those UI line numbers moved. The three new findings remain source-supported. Main will continue to move; this is a recorded source cut, not a claim about a later build.

### Registered worktrees

This is the initial worktree snapshot against 90f23fa, preserved as historical overlap evidence. Distances are relative to that commit, not the older local main. Behind/ahead describes ancestry, not acceptance; Dirty counts status records, not authored changes. During discovery capture-polish and sample-businesses moved, stream-rules-followups gained a separate external-engines lane, and audit-0-2-0-source plus this owner-surface-discovery worktree were registered. Do not use these distances or dirty counts as current scheduling authority; recheck exact claims/status before a builder starts.

| Absolute worktree | Branch | HEAD | Behind | Ahead | Dirty records |
|---|---|---|---:|---:|---:|
| `F:/Diomedes/diomedes` | `docs/fractional-ai-ops-agreement-20260919` | `c6db9d6e8e45f813a30c7b85242fbda9c5b778b8` | 1156 | 5 | 15 |
| `F:/Diomedes/diomedes-wt/aws-conversation-authority-review` | `review/aws-conversation-authority-20260921` | `b7e92a2bdd5e3dde84d10b4a71250fda6075a46b` | 911 | 1 | 0 |
| `F:/Diomedes/diomedes-wt/aws-luna-conversation` | `feature/aws-luna-conversation` | `a866d6eb5c90d882add5a02aa7d97932b6c1012c` | 911 | 2 | 0 |
| `F:/Diomedes/diomedes-wt/canonical-sync-2026-09-24` | `feature/canonical-sync-2026-09-24` | `269c651f16ddc7a6f4ae7c36d6dd58656cc6303f` | 444 | 0 | 0 |
| `F:/Diomedes/diomedes-wt/capture-polish` | `feature/capture-polish` | `a36a98d16e5330fb6678ed9164c51bd975214b6b` | 2 | 0 | 18 |
| `F:/Diomedes/diomedes-wt/claude-cleanup-race` | `feature/claude-cleanup-race` | `b2366abf658d79698eaee890546fc376fc38b19e` | 448 | 0 | 0 |
| `F:/Diomedes/diomedes-wt/core-agent-driver-review` | `review/core-agent-driver-20260921` | `b402e6170022227185048f7f321e68c273167b4e` | 920 | 1 | 0 |
| `F:/Diomedes/diomedes-wt/customer-upgrade-evidence` | `feature/customer-upgrade-evidence` | `3d411b3ed83f04eb543304892e16ff1aa9d47b37` | 744 | 1 | 0 |
| `F:/Diomedes/diomedes-wt/devin-agent-worker-20260917` | `feature/devin-agent-worker-20260917` | `93378a224de235d7f133b92a08de2474bdeafa43` | 1219 | 1 | 0 |
| `F:/Diomedes/diomedes-wt/display-fixes-and-text-size` | `feature/display-fixes-and-text-size` | `837a4264c94e3ae290578103c9b659747e65de62` | 448 | 0 | 0 |
| `F:/Diomedes/diomedes-wt/document-walk-speed-astra` | `feature/document-walk-speed-astra` | `1c6242780e15235c5b70c9e1902f4531e29bfcd7` | 540 | 0 | 3 |
| `F:/Diomedes/diomedes-wt/document-walk-speed-baseline` | `feature/document-walk-speed-baseline` | `1c6242780e15235c5b70c9e1902f4531e29bfcd7` | 540 | 0 | 1 |
| `F:/Diomedes/diomedes-wt/document-walk-speed-mimo` | `feature/document-walk-speed-mimo` | `4954f45d3e6d06bb9a0b785f640748a0ab82eb3e` | 540 | 1 | 1 |
| `F:/Diomedes/diomedes-wt/document-walk-speed-swe2` | `feature/document-walk-speed-swe2` | `1c6242780e15235c5b70c9e1902f4531e29bfcd7` | 540 | 0 | 7 |
| `F:/Diomedes/diomedes-wt/durable-write-retry-20260917` | `fix/durable-write-rename-retry-20260917` | `ff50331aeeebdd483790e3ff9cbca3d20fbad7e1` | 1210 | 1 | 0 |
| `F:/Diomedes/diomedes-wt/interaction-authority-review` | `review/interaction-authority-20260921` | `b0ec7a6f0544ea8378c4803511c53efbdd3f7b6f` | 912 | 1 | 0 |
| `F:/Diomedes/diomedes-wt/jev-live-decision-plane` | `feature/jev-live-decision-plane` | `ec3a4d2da1f81cffdea72027002fa1062c62c76a` | 1120 | 2 | 0 |
| `F:/Diomedes/diomedes-wt/license-and-version-notes` | `docs/license-and-version-notes` | `d31348766517c621a8b4e453dea1567f67224c4f` | 1 | 0 | 0 |
| `F:/Diomedes/diomedes-wt/license-docs-cleanup` | `feature/license-docs-cleanup-wording` | `1f1b6127b2b65cb6250bc4ea70c2cce7d9be0686` | 8 | 0 | 0 |
| `F:/Diomedes/diomedes-wt/mimo-opencode-evaluation` | `feature/mimo-opencode-evaluation` | `d3cfad4bb70927f069c66127a6220f55d2f36c15` | 602 | 0 | 1 |
| `F:/Diomedes/diomedes-wt/nectovia-integration` | `integration/nectovia` | `d3b013ecd4d6f036e976bf4a5c2bee85cc423be3` | 697 | 0 | 0 |
| `F:/Diomedes/diomedes-wt/nectovia-security-pass` | `feature/nectovia-security-pass` | `87b9cd8762c023081588e9c8d305bb7631375b14` | 676 | 0 | 1 |
| `F:/Diomedes/diomedes-wt/plain-writing` | `feature/plain-writing` | `90f23fa1f97eb274ed08f926fb349a5d6886f724` | 0 | 0 | 0 |
| `F:/Diomedes/diomedes-wt/proprietary-license-notice` | `feature/proprietary-license-notice` | `47480a2e0f4fa0dff8a281609393e52f9012419d` | 14 | 0 | 0 |
| `F:/Diomedes/diomedes-wt/release-0-1-10` | `` | `7f35f3ebbbfe8f00398de1123dc798f2b2de6f17` | 466 | 0 | 0 |
| `F:/Diomedes/diomedes-wt/release-0-1-11` | `feature/release-0-1-11` | `cc9575004b8c8010a31f6fc1091f1774d6ea0e00` | 454 | 0 | 0 |
| `F:/Diomedes/diomedes-wt/release-0-1-8` | `feature/release-0-1-8` | `70829678006d35d5977ffe804c04cf62a6a64268` | 569 | 2 | 1 |
| `F:/Diomedes/diomedes-wt/release-0-1-8-build` | `feature/release-0-1-8-build-2` | `110e5902a82fe26610798b4bc2e36ffda122ffec` | 517 | 0 | 0 |
| `F:/Diomedes/diomedes-wt/rule-delivery-coverage` | `feature/rule-delivery-coverage` | `90f23fa1f97eb274ed08f926fb349a5d6886f724` | 0 | 0 | 0 |
| `F:/Diomedes/diomedes-wt/sample-businesses` | `feature/sample-businesses` | `a36a98d16e5330fb6678ed9164c51bd975214b6b` | 2 | 0 | 5 |
| `F:/Diomedes/diomedes-wt/security-hardening` | `feature/security-hardening` | `75f69435b42b2488cbaeaac07bd254bde1355d92` | 683 | 1 | 0 |
| `F:/Diomedes/diomedes-wt/simple-advanced-view` | `feature/simple-advanced-view` | `353df366952f1446ee2a16ff39e8d1af6f241b58` | 502 | 0 | 0 |
| `F:/Diomedes/diomedes-wt/stream-rules-followups` | `feature/stream-rules-followups` | `90f23fa1f97eb274ed08f926fb349a5d6886f724` | 0 | 0 | 0 |
| `F:/Diomedes/diomedes-wt/vercel-model-bridge` | `feature/vercel-model-bridge` | `91eeefe856598a82530b8f0b77cd932cb692150d` | 908 | 1 | 0 |
| `F:/Diomedes/diomedes-wt/vertex-managed-inference` | `feature/vertex-managed-inference` | `45b9cf81b498da9e88f51455c303361a75cdd415` | 706 | 3 | 0 |

Committed divergent paths were inspected for overlapping surfaces. The old Devin branch overlaps `shared/types.ts`, Shell, Composer, Team, task controls and agents; the Jev branch overlaps RunService, Trust/evaluation and managed admission; AWS/Vercel/Vertex branches overlap conversation/harness and funding; security-hardening overlaps app/harness boundaries; the document-walk and durable-write branches overlap Store. Their ahead counts are not evidence that each change is absent from main: squash/reworked integrations can preserve behavior without ancestry. Compare exact current files before proposing a cherry-pick.

At the initial snapshot the near-main `capture-polish` and `sample-businesses` lanes had uncommitted work. Sample-businesses subsequently landed as PR #140; its original lane still must be checked before any reuse. Respect them when touching Shell, Files, tests and sample material. The existing `rule-delivery-coverage`, `plain-writing` and `stream-rules-followups` lanes also make current context/rule/UI integration a live coordination concern. None was edited for this audit.

### Inventory-worktree snapshot and preserved branches

There is no registered or on-disk `F:/Diomedes/diomedes-wt/mobile-inventory-milestone` worktree. There are no currently registered identity/auth/tenancy/inventory feature worktrees under that directory. Relevant local branches still exist:

| Preserved local branch | Commit | Behind/ahead | Source delta since merge base |
|---|---|---:|---|
| `feature/inventory-contract-review` | `9bd76cecf8671948fc27b6c37ab279ed536f67ef` | 1156/1 | 1 source paths differ on branch since merge base |
| `feature/inventory-device-scanning` | `a139bc5dbf9f739ed0e56b220e2ba5e971f49c80` | 1156/1 | 13 source paths differ on branch since merge base |
| `feature/inventory-durable-stock` | `965e99eef1dcda81ee6defa8a9947941bc951968` | 1156/1 | 7 source paths differ on branch since merge base |
| `feature/inventory-durable-stock-receipts` | `80071b235a0c4811e1f9312364e761a3fb8820d0` | 1131/1 | 2 source paths differ on branch since merge base |
| `feature/inventory-mobile-client` | `967842ef5b51c9c4101f2406528d20cf17142f5b` | 1156/1 | 10 source paths differ on branch since merge base |
| `feature/inventory-mobile-receipt-history` | `dadb72d4ce16f11c0f31c9fa52158a1e5e6f9a19` | 930/0 | No branch-only source paths |
| `feature/inventory-mobile-review` | `8184bb9d09040bf77f5a18368ba0b1fcc5323d4f` | 1156/1 | 10 source paths differ on branch since merge base |
| `feature/inventory-receipt-validation` | `a27e0188459f370b808a565956eca565ac126dcb` | 949/0 | No branch-only source paths |
| `feature/inventory-records` | `e337c1e2fb5764f7de44ebfac0c25bf560e7d34f` | 1156/1 | 3 source paths differ on branch since merge base |
| `feature/inventory-records-review` | `5be862de6a346be412a2d5aa06eee790f26774e9` | 1156/1 | 3 source paths differ on branch since merge base |
| `feature/inventory-scanning-review` | `652aa1edefd774d3b167578b46108a400fab8128` | 1156/1 | 13 source paths differ on branch since merge base |
| `feature/inventory-stock-operations` | `cb74eaaaa0216fcbc7c030ff283bb2ebed5ae544` | 1156/1 | 5 source paths differ on branch since merge base |
| `feature/inventory-stock-review` | `7bc7023879d8d6bdf76293e7dfbd95e63fe9e214` | 1156/1 | 5 source paths differ on branch since merge base |
| `feature/mobile-inventory-contracts` | `d962ba87ade226011d7bd8b5ff9aa59002d5b1fd` | 1156/1 | 1 source paths differ on branch since merge base |
| `feature/mobile-inventory-milestone` | `10e98e2e4608508f1e82bcaf23f4676ce817f817` | 1156/1 | No branch-only source paths |
| `feature/recorded-effect-authorization` | `1dce8224ab3add65026d3a771523d393438ef825` | 1156/1 | 2 source paths differ on branch since merge base |

The milestone branch's sole divergent commit is a WIP preservation of product/planning documentation, not a PWA. Preserved mobile-client branches contain `client/console/inventory/InventoryView.tsx`, `ItemDetails.tsx`, `StockAction.tsx`, `view-model.ts` and mobile CSS. Scanning adds `ScanItem.tsx` and `scan-adapter.ts`. Their scoped binding, exact decimal parsing, stale-response rejection and camera teardown are useful prior art, but those branch bytes are not main or accepted hosted/device proof. Do not transplant the old inventory schema or writer over current main.

The receipt-history branch `dadb72d...` and receipt-validation branch are ancestors of current main. The current implementation to extend is `client/console/InventoryReceipts.tsx`, `client/inventory/receipt-client.ts`, and `server/inventory/{stock-service,stock-repository,receipt-routes,local-access}.ts`. The full older InventoryView and scanner are not main.

Other directories without a Git marker are leftovers, not active worktrees: `console-design-language`, `nectovia-look-on-upgrade`, `new-claude-joiners` and `new-claude-joiners-access` are empty; `desktop-readability-20260911` contains test artifacts; `first-run-repair` contains a patch; `.upgrade-prior-experimental-3` contains an old packaged build. None is treated as merged source.

### Latest screenshot and product-boundary verification

The second screenshot follow-up was inspected on d27230b, which matched remote main at the start of the addition. Its source AST contained exactly Mode and In project selectors in client/console/Home.tsx; no tier/model selector is present. A no-write probe of the real CustomizationGate with a synthetic personal actor refused ordinary authoring, allowed it with DIOMEDES_DESIGN_AUTHORING=1 while entitlement stayed none, and confirmed that the current paid fixture grants editing. The real external-engine registry includes oh-my-pi. These are local source/function findings, not runtime proof on the screenshot's unidentified installed build.

For public-design-copy overlap, site origin/main was separately confirmed at 63d99422a8cb6932838b928f94bb9faad132f4df; git-object reads found the public design launcher and its documentation. The site's checked-out main was older, so its disk copy was not used as release truth. No website deployment, app launch, provider call, subscription change, customer data access or source change was performed.

### Verification performed for this discovery

Read-only source/type inventory, worktree and branch ancestry, package/ADR checksums, and an in-memory TypeScript compiler probe were performed. The probe substituted only the specified Task declaration in the compiler host, set noEmit, and refused writes. No source scratch file was created.

| Isolated declaration change | New diagnostic evidence |
|---|---|
| Required `Task.priority: 1\|2\|3\|4\|5` | 10 diagnostics: Store constructor and nine test fixtures |
| Replace `assignedTo?: Slot\|null` with person/AI discriminated union | 9 diagnostics in BoardView, paletteEntries, app wake selection, team Board and TeamService |
| Add `submitted` to TaskState | 1 diagnostic: Store's exhaustive state sentence table |

The initial baseline in that multi-pass probe reported six missing control-plane dependency declarations (`pg` / `@neondatabase/serverless`). A subsequent unmodified `node node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false` at the same clean source SHA exited **0**. The change-specific diagnostics above exclude those initial environment diagnostics. No dependencies were installed by this audit.

No unit, browser, gate, database, hosted or physical-device suite was run. Existing assertions were inspected; predicted behavioral regressions below are distinguished from the compiler failures actually observed. Running the normal browser configuration would create test artifacts and start services; it was unnecessary for this discovery.

## 2. Verdict per decision

| Decision | Status | Why |
|---|---|---|
| D1: two surfaces, one harness | stands with changes | Reuse operational Task/Need/History services through the MI01 boundary. The current local-client receipts and full project-state route are not a hosted user API. |
| D2: pack tiles | stands with changes | Both built-in and installable `ui` schemas name four existing Console affordances, not arbitrary views. Add a versioned, declarative Owner tile contract and preserve P01/P04 authority limits. |
| D3: read-through and one authority | stands | The current D3 matches MI00: native operational records plus either an identified external stock source or the bounded pilot ledger. Connector provenance does not create a second writable master. |
| D4: Home needs queue | stands with changes | `FollowUpQueue` queues future AI instructions for one task. Build Home from authorized Needs, human review requests and activity projections, reusing presentational primitives. |
| D5: contextual chat | stands with changes | Existing attachments also include task/review. Add scoped typed references and server-resolved authorized context; visible rows and manifest prose are not authority. |
| D6: customer Projects and people | stands with changes | Project requires a folder, but not Git. Use a governed business-host folder and organization resource binding. Human assignees need roster identity and must not enter AI auto-start. |
| D7: priority and automation queue | stands with changes | Priority is viable; universal sort, automatic-run exclusion and preemption conflict with current fair Ready scheduling, multiple run representations and provider-specific controls. Split delivery. |
| D8: hosted Owner Surface | blocked by MI01 | B01-B03 identity/tenancy and an MI01 operational transport are prerequisites. Current control plane has no Owner web app, operational replica or desktop dispatch channel. |
| D9: identities and configurable access | already exists — reuse | Reuse business-access profiles and pinned assignments; extend the permission contract to v2, seed Manager/Employee custom profiles, add an editor and B03 verified-principal bridge. These extensions and hosted enforcement remain work. |
| D10: human messages | stands with changes | Add private human threads under the operational owner. AI mailbox control messages cannot become human mail by widening IDs. Bot invitation needs explicit context disclosure, not ambient access. |
| D11: completion reports | stands with changes | Reuse H17 evidence/digest principles, but its current acceptance checks verify AI run outputs, not human submissions. Add a sibling human-completion contract and shared completion gate; FileRecord is not an attachment reference. |

### Task flow that constrains the changes

1. **Creation.** `client/task-create.ts:25` strictly normalizes name/description/sourceDocument, retains a command ID through uncertainty, and posts to the project route. `server/task-admission.ts:12` has a strict v1 schema; line 35 hashes normalized intent. `server/app.ts:2150` resolves replay before source validation, calls the central `Store.createTask`, writes a linked History receipt, then persists. `server/store.ts:1951` constructs the Task. IDs are T1, T2, etc. inside each project, not globally unique. All Owner API references must bind organization + project + task.
2. **Other creators.** Plan conversion (`server/app.ts:2298`), conversation action admission (`server/interaction-service.ts:733` through the app host callback), native/team wake (`server/app.ts:4743`), sample Build/Fix (line 5335), harness bridge (`server/harness/bridge.ts:187`), team tools (`server/team/service.ts:563`), connection-rule issues (`server/connections/service.ts:802`) and fork (`server/durable-controls.ts:957`) all matter. A constructor default covers missing fields; it does not expose priority/assignment commands, preserve fork intent or choose run class.
3. **Board and work admission.** `client/console/BoardView.tsx:550` projects task evidence and uses Ready queue positions. `server/ready-scheduler.ts:194` considers eligible Tasks and calls the normal Work admission path. `server/app.ts:2335` rechecks route, consent, cloud sharing and replay before native/sample work. Person assignment alone must not authorize AI execution.
4. **Run and approval.** `server/harness/bridge.ts:196` creates a Session, persists it, then starts a linked HarnessRun (line 237). Native direct work and TeamRun have their own linked records. Need and ApprovalReceipt are bound to a task/session/proposal and local-client authority, not generic human workflow forms (`shared/types.ts:221,303`).
5. **Finish and review.** Store moves feed Task state, History and undo. Sample/native completion, reviewed file changes, partial keep, team updates and verified native-loop completion can each mark done. Examples: `server/native-work.ts:1038`, `server/app.ts:2899`, `server/change-review/partial-keep.ts:160`, `server/harness/capabilities/native-loop.ts:1179`. A completion policy must cover every one; changing just PUT /tasks is bypassable.
6. **Projection.** `client/workbench/task-evidence.ts` can derive Done from a terminal Session while Task mirrors catch up. `server/team/board.ts:48` currently maps every state other than todo/working/waiting to completed. New human submitted/review states need explicit precedence and must not erase an unresolved AI effect or imply H17 verification.

### Ownership boundary to carry into every work order

| Record | Existing authority | Owner Surface treatment |
|---|---|---|
| Verified person, external subject, session, organization membership | B01 account service and control-plane account tables; B02 login; B03 bridge | Reuse stable verified person identity and current membership/revocation checks. A roster name is not a login or grant. |
| Fine-grained business access | `shared/business-access.ts` evaluator; `server/workspaces.ts` local resources/profile revisions/assignments | Extend named capabilities and bridge current hosted principals through B03. Settle one policy owner; do not copy independent mutable ACLs into both hosts. |
| Project, Task, Need, Session, run, operational History | Governed business host using existing Store/harness | Same records and receipts behind narrow authenticated projections/commands. No cloud Task/Run/History replica with its own lifecycle. |
| Inventory | MI00 selected recorded stock document and Store-backed receipt/history, or an explicitly selected external source | Keep one owner per installation. A hosted cache is derived, versioned and revocable; it cannot take stock commands as a second ledger. |
| Task assignments, priority changes, completion reports and their audit events | New operational records extending the selected host owner | Add to the MI00 boundary extension. Do not place them in account SQL merely because the UI is hosted. |
| Human roster/business hours | Existing pure workforce snapshot/constraints plus a new durable operational roster binding or identified HR source; account Person supplies identity | Bind a roster entry to a Person explicitly when applicable. Hours need provenance, units and privacy; do not compute them from AI Session duration. |
| Human message body/read cursor | New human communication aggregate under the selected operational owner | Separate from Team mail and AI Conversation; reference scoped projects/tasks and verified participants. Cross-project storage needs an explicit organization owner. |
| Photos | Existing recorded Files/object storage on that host | Upload through a new narrow authorized API; return project/path/hash/version identity. Completion reports reference those exact bytes. |
| Funding | Existing managed-usage/funding service and immutable reservations | Reference operational run/job IDs. Its funded job is a money/cap record, not the customer's Project or Task. |
| Hosted tiles/context | Derived projection of the above, filtered before retrieval and egress | Tenant/principal/generation/version/freshness scoped. No authoritative operational writes, credential sync or raw local-only data by default. |

Evidence: `docs/architecture/mobile-inventory-boundary.md:13-38,93-116`; PKG `milestones/mobile-inventory-demo/MILESTONE.md:17-38`; `services/control-plane/migrations/001_accounts.sql:1-84`; `services/control-plane/README.md:82-88`. MI00 is fixed and merged. Expanding it to more operational record families needs an additive contract decision; it is not a reason to reopen its accepted inventory schema or mark MI01 complete.

## 3. Edit / add / remove list

Paths are relative to the application repository; proposed additions do not exist yet unless a lane has landed after this baseline. Every lane also needs its own exact-source review evidence. Repeated hot files denote sequential changes, not permission for overlapping edits. No existing source file needs wholesale deletion for this design; removals below are named branches/assumptions within files.

### 3.1 task-priority (OS01) - first delivery

The bounded first release is durable priority/due edits, common work-list ordering and controls in the existing Console. Keep AI start consent and project fairness. Do not claim automation preemption or phone My Work as part of this subset. Decide due-date semantics before freezing its wire type. Missing legacy priority becomes 3; malformed stored values must not silently become 3. A required field on Task means every persisted Task, including AI-created ones, needs a valid value.

- `shared/types.ts` - edit - Add Priority, due representation, priorityMoves and task revision; extend TaskCreationInput and a versioned edit receipt. Preserve Owner as the existing execution/review mode.
- `shared/task-priority.ts` - add - One validated comparator and labels; order priority, normalized due with an explicit missing-date rule, createdAt, then scoped stable identity for deterministic ties.
- `shared/task-commands.ts` - add - Strict create/edit intent, expected revision, actor evidence and idempotent receipt contracts; reuse command IDs/digests.
- `server/task-admission.ts` - edit - Normalize priority defaults and due before digesting new commands; preserve original v1 replay digests/receipts.
- `server/task-commands.ts` - add - One locked, authorized priority/due mutation, immutable event and same-command recovery path shared by UI and bot.
- `server/command-admission.ts` - edit - Register task-edit command receipts in the existing project namespace; reject cross-family command reuse.
- `server/store.ts` - edit - Central default, persisted revision, historical normalization and recorded priority event; no fabricated old moves or rewritten original command evidence.
- `server/migrations/registry.ts` - edit - Register the Task/project schema transition and downgrade refusal.
- `server/migrations/task-records.ts` - add - Pure, versioned Task migration with backups through the existing framework.
- `server/app.ts` - edit - Wire create/PUT and conversational edit commands; route all priority writes through the same service; expose supported fields explicitly.
- `server/durable-controls.ts` - edit - Make priority/due inheritance for fork explicit; a fork still receives no inherited execution grant.
- `server/team/service.ts` - edit - Accept validated priority in allowed create/edit tool intents, include it in tool replies and sort before list limiting.
- `server/team/board.ts` - edit - Project priority/due into the team task DTO without changing its AI owner wire contract accidentally.
- `server/team/tools.ts` - edit - Describe priority/due task-tool input and output; do not let a tool-selected actor become authority.
- `server/interaction-service.ts` - edit - Extend the typed conversational task-edit seam, preserving durable admission/cancellation ordering.
- `shared/ready-queue.ts` - edit - Apply priority within each eligible project line while retaining project fairness, consent holds and deterministic ties; name that exception to global work-list ordering.
- `server/ready-scheduler.ts` - edit - Supply priority/due to the planner and recheck the chosen task before claim; never reissue a claimed command after reorder.
- `client/task-create.ts` - edit - Carry explicit priority/due through browser-persisted pending input and receipt validation.
- `client/task-edit.ts` - add - Versioned idempotent edits, expected revision, unresolved-request recovery and account/scope binding.
- `client/console/TaskPriority.tsx` - add - Reusable five-level control with text labels, keyboard operation, visible saving/conflict state and appropriate touch targets.
- `client/console/BoardView.tsx` - edit - Add create/row controls, use common list order and show actual scheduler eligibility separately.
- `client/console/paletteEntries.ts` - edit - Include priority labels/actions and sort task results by the shared work-list rule within relevant result groups.
- `client/console/Shell.tsx` - edit - Provide edit callbacks and canonical task sorting; reconcile received revisions without optimistic false success.
- `client/console/types.ts` - edit - Extend Board/Palette callback types.
- `client/console/Ledger.tsx` - edit - Add priority control and order the open-task list; preserve chronological recent History.
- `client/console/ThreadView.tsx` - edit - Show/change the focused task's priority; do not reorder conversation turns.
- `client/console/board-model.ts` - edit - Separate work-list order from plan-step/progress order; do not silently shuffle a plan.
- `client/console/progress-bars.ts` - edit - Use the same distinction; preserve semantic plan-step ordering unless Andrew chooses otherwise.
- `tests/task-priority.test.ts` - add - All five levels, default/missing/invalid migration, date normalization, ties, sorting without mutating input.
- `tests/task-priority-admission.test.ts` - add - Concurrent edits, stale versions, conflicting replay, restarted pending edits, actor forgery and no AI start on priority change.
- `tests/task-priority.spec.ts` - add - Board/palette/thread controls, touch and keyboard, conflict/retry and same result on refresh.
- `tests/task-admission.test.ts` - edit - Default normalization and changed-priority command conflicts; keep old v1 receipts readable.
- `tests/task-create-client.test.ts` - edit - Pending browser input/receipt protocol and uncertain-save recovery with new fields.
- `tests/ready-queue.test.ts` - edit - Replace oldest-task-only examples with priority examples; retain least-served-project and no-starvation tests.
- `tests/ready-scheduler.test.ts` - edit - Reorder before claim, between claim/start, and while waiting; replay still starts once.
- `tests/ready-queue-ui.spec.ts` - edit - Board order and scheduler position agree under the approved fairness rule.
- `tests/workbench-palette.test.ts` - edit - Task result order/control and required-priority fixture.
- `tests/migrations.test.ts` - edit - Current version chain, corrupt value, interrupted migration, backup and downgrade cases.
- `tests/attribution-shared-ui.test.ts` - edit - Supply required priority in its literal Task fixture (line 83).
- `tests/console-activity.test.ts` - edit - Supply required priority in its Task builder (line 17).
- `tests/guidance-maintenance.test.ts` - edit - Supply required priority in its Task fixture (line 83).
- `tests/review-diffs.test.ts` - edit - Supply required priority in its Task fixture (line 42).
- `tests/software-pack.test.ts` - edit - Supply required priority instead of the incompatible assertion at line 461.
- `tests/verification-service.test.ts` - edit - Supply required priority in its fixture (line 34).
- `tests/workbench-board.test.ts` - edit - Supply required priority in its fixture (line 13); assert list ordering.
- `tests/workbench-task-evidence.test.ts` - edit - Supply required priority in its fixture (line 6), without changing execution evidence semantics.
- `playwright.config.ts` - edit - Explicitly collect the new task-priority spec; adding a file alone does not join the allowlist.
- `docs/implementation/task-priority-contract.md` - add - Exact migration, ordering exceptions, versioned commands, consumers, exclusions and acceptance evidence.

Observed compiler failures for required priority are the Store constructor at line 1961 and the nine named fixture sites (including workbench-palette line 7). Other tests using casts/any or Store.createTask may compile unchanged; that is not evidence their behavior is correct. There is no justification to edit every test that happens to mention a task ID.

### 3.2 people-assignments (OS02) - second delivery

OS02 also consumes the workforce-binding additions in section 3.15. An assignee is a work recipient. An actor is the authenticated person or runtime that performed an action. Owner currently selects execution/review behavior. Keep these three concepts separate. Retain the AI slot model; do not turn TeamMember into an employee.

- `shared/types.ts` - edit - Discriminated person/AI assignee, assignment revision/events and explicit task action actor evidence; retain old Owner values for mode and history interpretation.
- `shared/people.ts` - add - Organization-scoped roster entry, optional verified Person binding, inactive state and provenance; keep hours as a separately sourced record, not a number inferred from Sessions.
- `shared/task-assignment.ts` - add - Validate/narrow assignees, display labels and distinguish human work from AI eligibility.
- `shared/task-commands.ts` - edit - Assignment command with expected task/roster versions and resolved actor.
- `server/people.ts` - add - Bounded roster queries and writes under the selected operational owner; explicit identity binding, never email/name-based linking.
- `server/task-commands.ts` - edit - Assignment authority and same-organization validation at mutation; revoked/inactive recipient handling.
- `server/store.ts` - edit - Persist assignment/actor evidence without making all HistoryEntry.actor consumers accept arbitrary objects.
- `server/migrations/task-records.ts` - edit - Migrate valid slot strings to AI references; preserve unresolved legacy `owner` sentinel explicitly until the owner supplies a binding.
- `server/migrations/registry.ts` - edit - Register roster and assignment schema versions/backups.
- `server/team/board.ts` - edit - Expose AI ownership only for kind=ai; describe human assignment explicitly without treating a person ID as a slot.
- `server/team/service.ts` - edit - Replace raw slot comparisons/assignments; constrain team tools so an AI cannot silently reassign another person's work.
- `server/team/tools.ts` - edit - Version the task tool assignee contract or retain an explicit AI-only adapter.
- `server/app.ts` - edit - Fix the current ignored `assignedTo` PUT field; route through the new mutation service; narrow team wake selection at line 1346 and select the highest eligible task.
- `server/ready-scheduler.ts` - edit - Exclude human-only assignments from automatic AI start until a separate authorized delegation exists.
- `shared/ready-queue.ts` - edit - Make person-assigned tasks ineligible for AI claims while they remain normal human work-list items.
- `client/console/BoardView.tsx` - edit - Replace slot equality at lines 630/638 with discriminated assignee UI.
- `client/console/paletteEntries.ts` - edit - Replace string-returning taskWorker at lines 139-141 and add authorized assignment actions.
- `client/console/Shell.tsx` - edit - Replace raw `assignedTo: slot` payloads at lines 1828/2337 and distinguish resolved people from AI slots.
- `client/console/types.ts` - edit - Use the shared assignee/callback contract.
- `client/console/TaskAssignee.tsx` - add - Person/AI picker with scope, inactive and unassigned states; use plain people/assistant wording.
- `client/console/Ledger.tsx` - edit - Resolve person names rather than treating `owner === you` as the assignee.
- `client/console/ThreadView.tsx` - edit - Distinguish assignee from the actual Session's model attribution.
- `client/workbench/task-evidence.ts` - edit - Recognize human moves and active human work without requiring a fake AI Session.
- `tests/task-assignment.test.ts` - add - Slot/person ID collision, roster binding, inactive person, legacy owner sentinel, cross-org rejection and no automatic AI run.
- `tests/task-assignment.spec.ts` - add - Person assignment on Board and palette survives refresh and appears with the same priority.
- `tests/team.test.ts` - edit - Preserve or explicitly version AI owner expectations at lines 283-284/336-353; test human recipients never entering mailbox/wake logic.
- `tests/team-any-route.test.ts` - edit - Assignee narrowing across all supported team routes.
- `tests/workbench-task-evidence.test.ts` - edit - Human starts/reopens do not become Blocked just because no model ran.
- `tests/business-access-routes.test.ts` - edit - Reassignment permission is checked separately from roster visibility and membership.
- `playwright.config.ts` - edit - Collect the assignment spec.
- `docs/implementation/people-assignment-contract.md` - add - Stable roster/account mapping, migration and attribution rules.

The nine observed assignee diagnostics are BoardView:630,638; paletteEntries:140,141; app:1346; team/board:77; team/service:569,617,618. TeamService's string filter at line 689 is another semantic failure even where TypeScript does not diagnose it. A clean compile alone is inadequate.

For the safe local subset, roster entries can be clearly labeled operational/fixture records and edits remain attributed to the actual local client. Do not display them as signed-in employees. Per-person remote edits wait for OS04/OS05 and B03. The updated D9 explicitly requires each employee to authenticate on a shared iPad. A station identity cannot substitute for that person.

### 3.3 organization-projects (OS03)

- `shared/workspaces.ts` - edit - Explicit organization/project ownership references; retain the single output-project binding for its existing automation purpose.
- `shared/organization-operations.ts` - add - Versioned organization aggregate for roster bindings, human-message references, completion defaults and receipts; no copied Task/Run/History lifecycle.
- `server/business/operational-records.ts` - add - Governed-host organization aggregate repository under the existing Store data root, with receipt/journal/recovery integration; do not use account SQL or duplicate it into every Project.
- `server/migrations/organization-operations.ts` - add - Strict aggregate version/migration, backup and unsupported-version refusal.
- `tests/organization-operations.test.ts` - add - Organization isolation, one-writer recovery, receipt replay and cross-project reference integrity.
- `shared/owner-api.ts` - add - Public Project/Task references and sanitized project summaries; exclude absolute folders, credentials and local settings.
- `server/workspaces.ts` - edit - Reuse project AuthorizationResource and projectOwner; reject multiple owners and bind new projects atomically.
- `server/workspace-routes.ts` - edit - Scoped project list/create/archive commands; no arbitrary filesystem path from a phone.
- `server/store.ts` - edit - Bind the organization aggregate's locking, receipt and recovery authority to the existing host; scoped organization records are not hidden per-project replicas.
- `server/store.ts` - edit - Host-selected folder provisioning with recoverable create/bind outcome; maintain personal/non-Git behavior.
- `server/owner-projects.ts` - add - Governed host root, safe project naming, idempotent creation and scoped cross-project work queries.
- `client/console/Workspaces.tsx` - edit - Distinguish a business's projects from its configured automation output project.
- `client/App.tsx` - edit - Retain local folder open/create; use scoped binding when acting in Business instead of implying the global projects list is an org list.
- `tests/owner-projects.test.ts` - add - Two organizations with T1, missing folder, non-Git project, duplicate create, traversal, failed bind and Personal isolation.
- `tests/business-access-routes.test.ts` - edit - Unique project resource ownership and filtered discovery.
- `tests/workspace-ui.spec.ts` - edit - Business project switching cannot display a different organization's tasks.
- `docs/architecture/owner-operational-boundary.md` - add - Extend MI00's one-host ownership to Projects, people, messages and completion, with export/backup/recovery ownership.

### 3.4 owner-access (OS04)

The permission-v2 migration, profile editor and full consumer inventory in section 3.15 are required parts of this lane. Current accessOwner (server/workspaces.ts:998-1005) gates profile administration by membership role; configurable Manager permissions need explicit operational-capability checks here while protected ownership and account recovery remain separate.

- `shared/business-access.ts` - edit - Add named capabilities for task read/reprioritize/assign/submit/approve, roster/hours and human messages/photos; use existing resource/profile/assignment evaluator.
- `shared/workspaces.ts` - edit - Add only necessary versioned access-policy reference/snapshot fields; keep MemberRole separate from custom operational profiles.
- `shared/task-commands.ts` - edit - Carry immutable actor/evidence references minted by the host, never caller-chosen authority.
- `server/workspaces.ts` - edit - Resolve authorization for a supplied verified principal under current membership and generations instead of only currentPerson().
- `server/business/account-service.ts` - edit - Integrate the accepted B03 hosted snapshot bridge; preserve local WeakMap capability boundary and current-member checks.
- `server/business/account-contract.ts` - edit - Version any explicit hosted-policy bridge contract without serializing a local in-process capability.
- `server/workspace-routes.ts` - edit - Enforce profile administration and scoped operational decisions server-side.
- `server/owner-access.ts` - add - Bind current verified membership, unique project resource, access profile and effect scope once; recheck at disclosure and effect.
- `server/task-commands.ts` - edit - Invoke current access at edit/assignment/submit/review, including replay reads.
- `services/control-plane/contract/contract.ts` - edit - Document single owner for policy reference/generation and the authenticated operational host assertion.
- `services/control-plane/src/account-service.ts` - edit - Only if the chosen B03 policy bridge needs additional reference/generation APIs; preserve last-owner and exact-member checks.
- `services/control-plane/src/domain.ts` - edit - Schema for that reference, not operational task/message bodies or an independent capability table.
- `tests/owner-access.test.ts` - add - Principal spoofing, member without profile, cross-project scope, manager versus employee, revocation between admission/effect, stale replay and name/count leakage.
- `tests/business-access.test.ts` - edit - New permission matrix and deny-by-default behavior.
- `tests/business-access-routes.test.ts` - edit - End-to-end policy enforcement over the existing profiles.
- `services/control-plane/tests/accounts.test.ts` - edit - Membership-role/policy separation and final-owner protections survive the extension.
- `services/control-plane/tests/worker.test.ts` - edit - New reference routes, if selected, validate origin/session/generation and return no operational records.
- `docs/architecture/owner-operational-boundary.md` - edit - Freeze the policy owner's location and the exact validation at each boundary.

No new Owner/Manager/Employee enum is presumed. Current MemberRole is owner/admin/member (`shared/workspaces.ts:26`; SQL `001_accounts.sql:60`). Current custom profiles already model kitchen-versus-finance access; `authorizeBusinessAccess` rejects absent/inactive/unknown scope at `shared/business-access.ts:375-407`. Andrew has selected Manager/Employee as default custom profiles. Implement D9's defaults through this substrate; expose its explicitly configurable cells without creating new membership-role values.

### 3.5 owner-device-api (OS05; extends MI01, B02 and B03)

- `shared/owner-api.ts` - edit - Versioned bounded queries, cursor/freshness, entity revisions, allowed commands, receipt/status and host-offline states.
- `server/owner-api.ts` - add - Narrow authenticated operational endpoint composition for the governed host; no mount of the full desktop Express app.
- `server/owner-projection.ts` - add - Filter before joins/counts/titles; authorize org/project/person and emit only public DTOs.
- `server/owner-access.ts` - edit - Device session/principal validation, current scopes and revocation at request and effect.
- `server/inventory/remote-access.ts` - add - MI01 adapter to InventoryStockService's existing authorizer; do not weaken local-access or its loopback guard.
- `server/inventory/receipt-routes.ts` - edit - Extract reusable validated handler logic only as needed; retain existing local composition and add a separately authenticated remote composition.
- `server/task-commands.ts` - edit - Reuse the same accepted task mutations through remote ingress with original receipt identity.
- `services/control-plane/contract/operational-host.ts` - add - Opaque host binding, allowed operation families and generation checks; no arbitrary URL/path/tool proxy.
- `services/control-plane/src/host-bindings.ts` - add - Account-side organization-to-host metadata only, subject to MI01's selected transport.
- `services/control-plane/src/worker.ts` - edit - Expose only the agreed binding/auth routes, not desktop filesystem/engine routes.
- `services/control-plane/src/identity-workos.ts` - edit - Only the necessary B02 web-session integration; retain exact issuer/audience and fresh provider-session checks.
- `services/control-plane/src/domain.ts` - edit - Host-binding records if stored here; their ownership is metadata, not an operational replica.
- `services/control-plane/src/postgres.ts` - edit - Transactional host-binding persistence and scoped reads if this is MI01's accepted design.
- `services/control-plane/migrations/005_operational_host_bindings.sql` - add - Proposed next migration name only; reserve actual sequence against current main before implementation. Metadata foreign keys/generations, no Tasks/Runs/History tables.
- `tests/owner-api.test.ts` - add - Cross-tenant IDs, cursor tamper, revocation, host unavailable, bounded payload, duplicate/lost responses and denied data never reaching a projection.
- `tests/inventory-remote-access.test.ts` - add - MI01 required remote identity/access tests using real service handlers and offline identity fixtures.
- `tests/inventory-command-authorization.test.ts` - edit - Local loopback boundary still rejects remote/forwarded requests; remote ingress uses its own verified claim.
- `services/control-plane/tests/host-bindings.test.ts` - add - Binding substitution, stale generations, unsupported operation, origin/session rejection and tenant-bound persistence.
- `docs/architecture/owner-operational-boundary.md` - edit - Exact host topology, online-only commands, transport/effect distinctions, uncertainty recovery and cache erasure.

These proposed binding paths must be reconciled with the accepted MI01 implementation before creating them. If MI01 chooses different paths, amend the work order to consume those paths; do not stand up a parallel transport. No real connector, arbitrary desktop tunnel, browser-held service secret or general remote file browser is in this lane.

### 3.6 pack-tiles (OS06)

- `shared/capability-packs.ts` - edit - Add a versioned declarative Owner tile descriptor; keep existing Console affordances compatible.
- `shared/pack-manifest.ts` - edit - Extend strict installable manifests as well as built-ins; account for compatibility, canonical digest and version changes.
- `shared/pack-contributions.ts` - edit - Carry tile metadata in the lazy index and its loaded body identity.
- `shared/owner-tiles.ts` - add - Allowlisted layouts and a source union for native project/task/people records, inventory authority or a connector projection; not connection-only.
- `server/pack-catalogue.ts` - edit - Register the bundled remodeling manifest and payload root explicitly; current catalogue only derives built-ins/weekly brief/industry variants (lines 69-107).
- `resources/packs/remodeling/manifest.json` - add - Versioned sealed manifest referencing the tile body; generate/verify its digest with the existing canonical manifest functions.
- `server/pack-contributions.ts` - edit - Build/pin/load validated tile declarations and record exact version/digest; no renderer code or arbitrary query execution.
- `server/pack-lifecycle.ts` - edit - Activation/deactivation/update/rollback behavior for tile consumers and pinned contexts.
- `server/pack-routes.ts` - edit - Authorized Owner tile catalog/load projection without unactivated contributions.
- `server/owner-projection.ts` - edit - Resolve native/source views with the same access filter and staleness semantics.
- `resources/packs/remodeling/owner-tiles.json` - add - Labeled synthetic remodeling example with Jobs, Timeline, Inventory, People and My Work mappings; no customer data or authority grants.
- `tests/owner-tiles.test.ts` - add - Unknown layout/query/action refusal, native sources, duplicate tile IDs, source freshness and scoped organization aggregation.
- `tests/pack-manifest.test.ts` - edit - Preserve rejection of arbitrary Console surfaces (existing test line 172); add the explicit Owner contract.
- `tests/pack-contributions.test.ts` - edit - Lazy body loads, pinned version/digest, deactivation and same tile ID in different projects/packs.
- `tests/pack-lifecycle.test.ts` - edit - Tile schema migration and update/rollback/revocation.
- `docs/product/owner-tile-contract.md` - add - Approved extension to P01/P04; identify project activation versus organization navigation policy.

Both present schemas explicitly reject arbitrary views: `shared/capability-packs.ts:47-52`, `shared/pack-manifest.ts:126-131`; the contribution index repeats the same four surfaces at `shared/pack-contributions.ts:62-63`. A pack cannot simply return React. The current ADR's core/connection union is a useful starting point; it still needs a bounded native inventory-authority source and scoped query/action schemas.

### 3.7 contextual-chat (OS07)

- `shared/types.ts` - edit - Add scoped typed tile/record attachment references without dropping existing document/plan/project/task/review kinds.
- `shared/owner-context.ts` - add - Authorized context envelope with source identity, revision/digest, freshness, selected scope and disclosure class.
- `server/app.ts` - edit - Extend strict attachment validation at thread creation and sends; reject stale/mismatched references.
- `server/owner-context.ts` - add - Resolve the reference server-side, reauthorize before retrieval and egress, bound rows and redact disallowed fields.
- `server/interaction-service.ts` - edit - Pin Owner context and actual target to the existing conversational admission/run record.
- `server/harness/context-assembly.ts` - edit - Account for the envelope as attributed data within the existing context budget.
- `server/harness/capabilities/conversation-sources.ts` - edit - Admit only allowed projection sources; do not elevate row text or askContext into trusted instructions.
- `server/harness/model-session-run.ts` - edit - Carry pinned references through the supported conversation route and recover them without fresh side effects.
- `client/console/Composer.tsx` - edit - Use a reusable context-chip/selection contract where appropriate; the server owns the actual context, not pasted visible DOM.
- `client/console/Shell.tsx` - edit - Typed navigation/attachment handling and context display for cross-surface links.
- `client/console/ThreadView.tsx` - edit - Show source/scope/freshness and a useful stale or inaccessible-reference state.
- `tests/owner-context.test.ts` - add - Cross-org record references, malicious askContext/row text, stale source, revoked grant, hidden counts and no duplicate task on replay.
- `tests/owner-context.spec.ts` - add - Navigate tile -> chat -> record without context bleed; visible selected scope before send.
- `tests/interaction-seam.test.ts` - edit - Existing conversation disposition/receipts remain authoritative with new context.
- `tests/project-conversation.test.ts` - edit - Current attachment kinds and task links stay compatible.
- `docs/implementation/owner-context-contract.md` - add - CD01/CD03 and H11/H18 context composition, exact consumer mapping and disclosure rules.

No runtime/provider payload should trust `{kind:'record', ref:'job:1042'}` without organization, project/source and current authorization. A client-side list filter is not an access check. Existing `shared/task-sources.ts` remains the selected-text-file contract; binary photos do not become model inputs just by appearing in Files.

### 3.8 owner-surface (OS08)

The shipped inventory entry point mounts InventoryReceipts inside ErrorBoundary (client/inventory/main.tsx:1-14). It has no sign-in flow, organization rail, employee home, service worker or general tile shell. Reuse its receipt component/protocol; a complete MI-DEMO PWA is not already shipped.

- `client/owner/main.tsx` - add - Device entry composing the MI01/B02 session and selected organization before operational queries.
- `client/owner/OwnerShell.tsx` - add - Home, Projects, Assignments, People, Messages, authorized pack tiles and Settings; manager AI activity projects existing runs.
- `client/owner/Home.tsx` - add - My assignments, authorized review/Need attention, participant-only unread counts and three scoped pinned tiles.
- `client/owner/Assignments.tsx` - add - Person work list, shared priority controls, detail, completion and accessible refresh/conflict states.
- `client/owner/People.tsx` - add - Verified member/roster bindings and authorized workforce facts with source/time; no inferred paid hours.
- `client/owner/Tile.tsx` - add - Allowlisted layouts using shared visuals where suitable; no arbitrary pack JavaScript/HTML.
- `client/owner/api.ts` - add - Validated DTOs, authenticated scope, status recovery, no-store reads and cancellation of stale account requests.
- `client/owner/owner.css` - add - Phone/tablet/desktop layouts using existing theme tokens, touch controls, large text and long names.
- `client/owner/manifest.webmanifest` - add - Device-install metadata once deployment origin and product labels are confirmed.
- `client/owner/service-worker.ts` - add - Static shell cache only initially; never cache private API responses or replay business writes.
- `owner.html` - add - Device entry and restrictive document security policy consistent with existing artifact isolation.
- `vite.config.ts` - edit - Build Owner entry without Electron-only or general desktop API composition.
- `client/console/InventoryReceipts.tsx` - edit - Accept an authenticated scoped receipt client and shell mount while retaining receive/status behavior.
- `client/inventory/receipt-client.ts` - edit - Bind pending operations to person/device/session generation as well as org/tenant/project; never retry as another person.
- `client/console/theme-runtime.ts` - edit - Expose portable token application if desktop settings assumptions prevent reuse.
- `client/console/InlineVisual.tsx` - edit - Only necessary tile DTO support; preserve recorded facts versus model-claimed progress.
- `server/owner-projection.ts` - edit - Compose Home from authorized records; filter before joins/counts/titles.
- `tests/owner-surface.spec.ts` - add - Employee sign-in to My assignments without AI setup, manager views, account switch/back/refresh privacy and responsive accessibility.
- `tests/owner-projection.test.ts` - add - Counts/titles cannot disclose others' tasks or private messages.
- `tests/inventory-receipt-ui.spec.ts` - edit - Same receipt flow under shell; navigation does not duplicate stock.
- `playwright.owner.config.ts` - add - Explicit Chromium/WebKit Owner collection; physical iOS remains separate.
- `docs/implementation/owner-device-surface.md` - add - Deployment composition, supported offline behavior and proof limits.

FollowUpQueue is a per-task queue for future AI instructions (client/console/FollowUpQueue.tsx:15), not Home's human inbox. Need currently requires task/session/engine-ask identity (shared/types.ts:221-284); add a discriminated human-review attention projection without fake sessions or approvals. Reuse the September 23 shared artifact/visual renderer and truthful progress conventions (docs/product/2026-09-23-visual-convergence.md:18-42).

### 3.9 task-completion (OS09)

D11 specifies note/photo/checklist/quantity/signature and optional manager sign-off. Use a sibling human-completion contract and one task-finish decision that consults applicable evidence. Preserve H17's existing wire contract.

AcceptanceDeclaration is a digest of strict file/command/reviewer checks, declaredBy='you' (shared/verification.ts:46-91). VerificationRecord requires session, producer and run outputs (121-145); verificationOf first requires a finished Session (305-343). A human job report has none of these. Human sign-off cannot certify model verification. Reuse immutable declarations, canonical digests, exact file identity and current-evidence projection. A common outer envelope could reference both later; merely adding kind to the current declaration does not implement this.

- `shared/task-completion.ts` - add - Strict rules, effective-rule provenance/digest, immutable submissions/reviews, attachments and completion eligibility.
- `shared/types.ts` - edit - Add submitted, completion references and typed move actor; preserve AI acceptance and legacy Owner.
- `shared/task-commands.ts` - edit - Submit/accept/bounce/reopen intents with expected task version and pinned rule/submission digest.
- `server/task-completion.ts` - add - Resolve pack < organization < project < task rules; validate report and perform one locked transition/receipt.
- `server/task-commands.ts` - edit - Ordinary done/undo/reopen must pass completion eligibility.
- `server/store.ts` - edit - Persist evidence and explicit submitted move label; retain old moves and undo audit.
- `server/migrations/task-records.ts` - edit - Additive absent-rule compatibility and downgrade refusal; never invent old reports.
- `server/app.ts` - edit - Submit/review routes and review-triggered done at line 2899 use shared gate.
- `server/work.ts` - edit - Sample termination uses shared task-finish decision.
- `server/native-work.ts` - edit - Direct-work terminal paths use same decision; run finished can coexist with human review pending.
- `server/harness/bridge.ts` - edit - Do not overwrite submitted when mirroring RunPresentation.
- `server/harness/capabilities/native-loop.ts` - edit - Retain verified-run finish guard and applicable human completion requirement.
- `server/team/board.ts` - edit - Exhaustive task-state handling replaces unknown-state-to-completed fall-through.
- `server/team/service.ts` - edit - task_update(done) cannot bypass report/review.
- `server/change-review/partial-keep.ts` - edit - Keeping a file change does not accept a human submission.
- `server/work-control.ts` - edit - Task-complete follow-ups do not advance on submitted.
- `client/workbench/task-evidence.ts` - edit - Explicit submitted precedence; terminal AI session cannot hide sign-off.
- `client/console/activity.ts` - edit - Human submission/review with actual actors and links.
- `client/console/BoardView.tsx` - edit - Submitted presentation, totals and permitted review actions.
- `client/console/board-model.ts` - edit - Preserve plan structure; report pending human completion accurately.
- `client/console/progress-bars.ts` - edit - Submitted is not accepted/done.
- `client/console/Ledger.tsx` - edit - Human review attention and completion activity.
- `client/console/Shell.tsx` - edit - Typed submit/review callbacks and task-detail links.
- `client/owner/CompletionForm.tsx` - add - Required fields, stable checklist IDs, quantity units, uploads, submission and bounce note.
- `client/owner/CompletionRules.tsx` - add - Authorized defaults/overrides editor with effective-rule preview and conflict handling.
- `client/owner/Assignments.tsx` - edit - Working/submitted/accepted/bounced journey without a model.
- `server/owner-projection.ts` - edit - Filtered employee submission and manager review projections.
- `tests/task-completion.test.ts` - add - Rule precedence, report validation, duplicate submit, double accept, stale policy/assignment, unauthorized review and restart.
- `tests/task-completion-bypasses.test.ts` - add - Exercise every old done path above with an unmet report.
- `tests/task-completion.spec.ts` - add - Report, bounce, resubmit, accept and response-loss recovery.
- `tests/workbench-task-evidence.test.ts` - edit - Submitted versus terminal sessions; human working without AI.
- `tests/board-model.test.ts` - edit - Mixed human/AI progress and pending sign-off.
- `tests/progress-bars.test.ts` - edit - Submitted counts and deterministic grouping.
- `tests/team.test.ts` - edit - Submitted is not completed; no team-tool manager approval.
- `tests/verification-projection.test.ts` - edit - H17 results remain independent of human sign-off.
- `tests/verification-service.test.ts` - edit - Preserve old digests, changed-evidence and independent-review semantics.
- `tests/verification-ui.spec.ts` - edit - Distinguish verified AI result from accepted assignment.
- `playwright.owner.config.ts` - edit - Collect completion cases.
- `docs/implementation/human-completion-contract.md` - add - State/evidence truth table and all finish/undo paths.

Remove direct state-write bypasses and implicit completed fall-through inside the listed files; delete no whole file. The ADR report shape lacks signature despite requiring it, rule revision, task/submission identity, quantity unit, checklist IDs, reviewer, bounce reason and receipt identity. FileRecord is a History path delta, not a scoped attachment reference.

### 3.10 project-photo-uploads (OS10)

FileDrops accepts PNG/JPEG/GIF/WebP through a local raw-body route, validates contents, chooses Imports paths and records via Store.writeRecorded (server/file-drops.ts:150-194; server/app.ts:1951). Versioned picture reads resolve recorded hashes (file-drops:201-235). This does not establish HEIC or remote employee support. The inventory client has no photo flow; old-branch barcode scanning is not completion photography.

- `shared/project-uploads.ts` - add - Bounded upload intent, status/receipt and org/project/path/sha/version identity.
- `server/project-uploads.ts` - add - Narrow authenticated capability reusing FileDrops/Store; bind person/org/project/task/command and expected state.
- `server/file-drops.ts` - edit - Reusable validation/preparation with verified human provenance; retain model/approval-byte refusal.
- `server/file-imports.ts` - edit - Reuse document-import validation for supported report documents; no remote URL/path fetching.
- `server/store.ts` - edit - Minimum actor/receipt support on the existing recorded binary path.
- `server/owner-api.ts` - edit - Upload/status and scoped versioned download; no general filesystem endpoint.
- `server/owner-access.ts` - edit - Upload/read checks including revocation at recorded effect.
- `server/task-completion.ts` - edit - Require finished upload receipts bound to this task; reject foreign or unrecorded bytes.
- `client/owner/PhotoUpload.tsx` - add - File/camera selection, format guidance, progress and failed/uncertain recovery.
- `client/owner/CompletionForm.tsx` - edit - Submit recorded references; no base64 binary in Task or chat.
- `tests/project-uploads.test.ts` - add - Cross-tenant theft, actor/MIME spoofing, size/pixel bounds, duplicate/lost response, interrupted write and revocation.
- `tests/file-drops.test.ts` - edit - Local import still works; model-produced binary still fails (line 173).
- `tests/project-photo-uploads.spec.ts` - add - Picker cancel, offline interruption, unsupported image, user switch and report binding.
- `playwright.owner.config.ts` - edit - Collect upload cases.
- `docs/architecture/owner-operational-boundary.md` - edit - Add named upload/download capabilities and metadata/disclosure policy.

A new authenticated ingress widens MI01's named capability contract while retaining one Files writer. Unreferenced uploads need designed recovery/retention, not automatic evidence deletion.

### 3.11 people-messages (OS11)

Team mail uses Slot, internal control kinds and a single read bit (shared/types.ts:750-763; server/team/mailbox.ts:1-63). Mail can wake and shut down AI seats. Reuse durable storage techniques, not this aggregate or its endpoints.

- `shared/people-messages.ts` - add - Org threads, verified participants/senders, immutable messages, scoped links, per-person read cursors and acceptance/delivery timestamps.
- `server/people-messages.ts` - add - Participant-only query/send/read/leave, versions and receipts under the operational owner.
- `server/owner-api.ts` - edit - Bounded private-thread routes with current membership/participant checks on read/write/status.
- `server/owner-projection.ts` - edit - Unread summaries without body/title leakage.
- `server/owner-access.ts` - edit - Employee-to-employee policy and named permissions; Manager does not grant inbox access.
- `server/owner-context.ts` - edit - Explicit bot invitation resolves allowed context; no automatic disclosure of all prior private history.
- `server/interaction-service.ts` - edit - Bot invocation uses existing conversation authority/payer/effect admission; ordinary human mail does not start AI.
- `client/owner/Messages.tsx` - add - People threads, contextual links, delivery uncertainty and explicit bot invite.
- `client/owner/Home.tsx` - edit - Participant-only unread count.
- `client/owner/api.ts` - edit - Account-bound pending send/status and stable command IDs.
- `tests/people-messages.test.ts` - add - Nonparticipant owner/manager denial, revocation, org setting, replay, forged sender, cursors and restart.
- `tests/people-message-context.test.ts` - add - Bot cannot disclose another person's private history or inaccessible task.
- `tests/people-messages.spec.ts` - add - Two signed-in contexts, read/delivery behavior, reconnect and no context bleed.
- `tests/team.test.ts` - edit - Human mail never enters slot mailbox/wake/shutdown.
- `playwright.owner.config.ts` - edit - Collect message cases.
- `docs/implementation/people-messages-contract.md` - add - Aggregate ownership, participants, bot disclosure, receipts and retention decision.

No email/SMS/push integration is implied. CD10's external-channel outbox is not this private inbox.

### 3.12 automation-admission (OS12; two separately accepted slices)

OS12a persists origin/class at admission; OS12b adds shared capacity and route-supported preemption only after its policy is settled. A display label must not stop a provider session.

- `shared/harness.ts` - edit - Versioned run admission origin/class and capacity claim reference.
- `shared/types.ts` - edit - Session/TeamRun linkage or projection; not three independently mutable class flags.
- `shared/automations.ts` - edit - Occurrence origin/class and capacity refusal evidence.
- `server/harness/run-service.ts` - edit - Validate/persist admission origin; caller-selected class is not authority.
- `server/harness/run-store.ts` - edit - Version handling; legacy class remains unknown unless origin is provable.
- `server/harness/host.ts` - edit - Carry admitted origin across routes without changing capabilities.
- `server/harness/bridge.ts` - edit - Carry occurrence/person origin into Session/Run.
- `server/work-admission.ts` - edit - Bind start/follow-up origin to immutable Work receipt.
- `server/app.ts` - edit - Classify native/team/conversation starts from the actual command, not createdBy or UI Wake.
- `server/native-work.ts` - edit - Origin for direct work outside HarnessRun.
- `server/team/service.ts` - edit - Preserve origin through TeamRun/delegation.
- `server/team/service.ts` - edit - Separate maybeWake/wakeMember timer/system work from continuation of a person's authorized request (lines 337-424).
- `server/automations.ts` - edit - Pin occurrence origin and preserve durable dedupe/busy policy unless amended.
- `server/automation-scheduler.ts` - edit - Feed agreed common capacity admission; no second executor.
- `shared/ready-queue.ts` - edit - Common capacity observation and approved fairness/class policy.
- `server/ready-scheduler.ts` - edit - Atomic capacity claim/recovery with other start paths.
- `server/run-capacity.ts` - add - OS12b only: common claims/limits/priority handoff/starvation policy over existing runs.
- `server/durable-controls.ts` - edit - OS12b only: supported pause/stop acknowledgment; never replay an uncertain effect.
- `client/console/AutomationsPage.tsx` - edit - Actual capacity wait/control capability, separate from paused schedule configuration.
- `client/console/BoardView.tsx` - edit - Auto-occurrences separate from assignment order; retain their failures/Needs.
- `tests/run-classification.test.ts` - add - Manual versus scheduled automation, follow-up, wake, retries, legacy and spoofed class.
- `tests/run-capacity.test.ts` - add - Concurrent admissions, limits, starvation, unsupported pause, uncertainty and restart.
- `tests/ready-scheduler.test.ts` - edit - Count sessions/claims once; recheck revocation.
- `tests/automation-scheduler.test.ts` - edit - Due/duplicate/missed/busy behavior and chosen capacity policy.
- `tests/automation-occurrences.test.ts` - edit - Interrupted admission retains exact occurrence/class linkage.
- `tests/automations.spec.ts` - edit - Schedule pause versus live-run stop/wait.
- `docs/implementation/automation-admission-contract.md` - add - Origin table, capacity owner, route-specific guarantees/exclusions.

Wake.tsx/useWake.ts animate the UI; no classification edit belongs there. Allowance/UsageSnapshot are views, not scheduling budget authorities. Reuse managed-funding reservations; the existing automation UsageClass is accounting metadata, not a queue.

### 3.13 source-priority-sync (OS13; awaits the customer's selected source)

- `shared/connections.ts` - edit - Selected connector's field mapping, revision, conflict and write capability.
- `shared/task-commands.ts` - edit - Source item/revision/authority binding without losing person attribution.
- `server/connections/service.ts` - edit - Normalize observations; permitted writes use existing effect/receipt path.
- `server/connections/priority-sync.ts` - add - Bounded chosen-source adapter, idempotency and recovery.
- `server/task-commands.ts` - edit - Reconcile confirmed source values without echoes or overwriting newer intent.
- `server/owner-projection.ts` - edit - Source/version/freshness/conflict; unconfirmed edits are not source truth.
- `tests/source-priority-sync.test.ts` - add - Non-bijective mapping, duplicates/out-of-order events, concurrent edits and lost replies.
- `docs/implementation/source-priority-sync.md` - add - Source owner, mapping and actual live-proof boundary.

Vendor path and API cannot be finalized before selection. Current shared/connections.ts is fixture-oriented. A synthetic mapping prerequisite can proceed; generic bidirectional live sync cannot.

### 3.14 owner-device-qualification (OS14)

- `tests/owner-journey.spec.ts` - add - Role-separated project -> assignment -> report -> decision -> private message, zero model calls.
- `tests/owner-boundary.test.ts` - add - Real-handler negative matrix with two orgs and phase revocation.
- `tests/owner-recovery.test.ts` - add - Lost replies/restarts for edits, assignment, upload, submit, review and mail.
- `tests/owner-projection-performance.test.ts` - add - Bounded cross-project pagination; no full-state phone broadcast.
- `playwright.owner.config.ts` - edit - Integrated multi-role/browser diagnostics.
- `scripts/gates.ts` - edit - Owner suite in existing exclusive-slot workflow.
- `docs/implementation/owner-device-qualification.md` - add - Exact build/host/iPhone/iPad, novice and rehearsal evidence; label synthetic rows.

MI08/MI09 retain stock conflicts, stale data, zero-model operations, device identities, shared iPad, Aaron and novice acceptance. Add Owner rows; do not substitute screenshots for these proofs.

### 3.15 Additional required OS02/OS04 files: workforce and permission v2

These belong to those work orders.

- `shared/people.ts` - add - Org/source/worker-ID to verified Person binding; never equate arbitrary staffing IDs with logins.
- `server/people.ts` - add - Validate binding against membership and source; unlinked roster data is not a signed-in assignee.
- `server/workforce/people-projection.ts` - add - Authorized snapshot adapter; staffing qualifications remain separate from permissions.
- `tests/workforce-people.test.ts` - add - Colliding IDs across sources/orgs, inactive/unknown links, private hours and no role-based auto-grants.
- `tests/workforce-constraints.test.ts` - edit - Only fixtures affected by the adapter; preserve pure constraints and acceptance-pending output.
- `shared/business-access.ts` - edit - Explicit v1-read/v2-write contracts, task/message/completion catalogue and human-only worker-ceiling exclusions.
- `server/workspaces.ts` - edit - Registry upgrade preserves immutable revisions/digests and revoked generations.
- `server/migrations/business-access.ts` - add - Pure upgrade/validation used by workspace-registry loading; project migration alone is insufficient.
- `client/owner/AccessProfiles.tsx` - add - Settings editor for capabilities/scopes, revision preview and explicit reassignment.
- `client/owner/OwnerShell.tsx` - edit - Authorized editor entry.
- `tests/business-access-migration.test.ts` - add - Owner/custom/worker records, unknown version/permission, bad digest, restart/downgrade and no silent grants.
- `tests/owner-access-profiles.spec.ts` - add - Manager/Employee defaults, customization, concurrent changes, revoke and no privilege from job-title changes.

Complete existing permission/profile consumer set:

| Existing file | OS04 action |
|---|---|
| shared/business-access.ts:9-103,123-217,375-449 | edit - Catalogue, validators, persisted versions, projections and worker ceilings. |
| server/workspaces.ts:48-60,294-431,971-988,1019-1033,1184-1380,1442-1515 | edit - Registry/bootstrap/digests/parsing/current access/revisions/assignments/workers. |
| server/workspace-routes.ts:148-218 | edit - Preserve strict admin routes; version/refusal handling. |
| server/inventory/local-access.ts:25,93-104,174 | edit - Compatible access decision versions; retain stock permission mapping and effect recheck. |
| tests/business-access.test.ts:105,178,282-289,359 | edit - Literal versions and unknown permission/worker-ceiling cases. |
| tests/business-access-routes.test.ts:207-217,287-336 | edit - Immutable revision and explicit reassignment behavior. |
| tests/inventory-command-authorization.test.ts:375 | edit - Profile fixture/version; stock access/revocation unchanged. |

Tracked-source search finds no client profile editor or direct control-plane import of this catalogue. ManagedGateway's membership/route policy is a different contract.

A constant-only bump is unsafe. Owner revision 1 is seeded only if absent and snapshots the then-current catalogue (server/workspaces.ts:314-347); existing installations would not gain new entries, while new ones would. Assignments are pinned to revision 1 (357-375). Create a reviewed new protected Owner revision and an explicit upgrade policy; do not rewrite old digests or revive revocations. Seed Manager/Employee custom profiles without silently assigning them to members. Existing custom profiles and worker ceilings keep their permissions until explicitly changed. New human-only permissions must not leak through WORKER_PERMISSIONS' exclusion-list default.

AccessAssignment.personId resolves to local-registry membership (server/workspaces.ts:444-447,1289-1292); currentPerson supplies acting authority. B01's verified control-plane Person is the intended production identity, not automatically that fixture. B03 must bind them through verified snapshots/generations. WorkforceWorker.id is a source snapshot ID; roles are staffing qualifications and priorWeekMinutes is source-supplied context. Drafts remain acceptance-pending (shared/workforce.ts:99-110,149-161,193-201). server/workforce/constraints.ts has no employee directory, payroll ledger or sign-in authority.

### 3.16 Task consumer inventory and test impact

This inventory combines the tracked TypeScript/TSX type-reference and property-access scan with createTask and HTTP-admission tracing. It covers direct Task references, assignedTo uses and task-collection readers in shared/client/server/scripts/tests at the pinned main. It intentionally identifies non-Task homonyms. A Task ID or a Pick<Task, 'id'> does not itself require a source edit. Paths already listed in the work orders inherit those edits; the retained rows below prevent unnecessary churn.

| Production/script path and representative lines | Required disposition |
|---|---|
| `client/connections/Connections.tsx:88,89` | Retain Task DTO projection; connection issue creation inherits constructor defaults. Test scoped Owner adapter separately. |
| `client/connections/fixture-main.tsx:24,243,245,246` | Fixture only; default new fields at creation and avoid claiming employee identity. |
| `client/console/BoardView.tsx:62,98,99,265,285,289,293` | OS01/OS02/OS09/OS12 edits listed above. |
| `client/console/ChangeDiffs.tsx:256,369` | Retain ID/acceptance display; completion authorization belongs in the shared server gate. |
| `client/console/FollowUpQueue.tsx:15` | Retain per-task AI follow-up semantics; do not reuse as human Home. |
| `client/console/Ledger.tsx:36,67,68,73` | OS01/OS02/OS09 edits listed above. |
| `client/console/LoopStart.tsx:29` | OS02/OS09 edit - Exclude unsupported person/submitted starts unless explicitly delegated. |
| `client/console/ProgressBoard.tsx:125` | Retain ID-only Task use; changed progress derives through board-model/task-evidence. |
| `client/console/Shell.tsx:29,255,263,765,773,840,927` | OS01/OS02/OS07/OS09 edits listed above. |
| `client/console/StopMenu.tsx:154` | OS02/OS09 edit - Human workflow controls must not claim an AI run to stop/resume. |
| `client/console/TeamView.tsx:216,217` | Retain AI Team projection; display versioned team Task DTO, never a human roster. |
| `client/console/ThreadView.tsx:82` | OS01/OS02/OS07 edits listed above. |
| `client/console/Verification.tsx:24,88,175` | Retain compatible projection; shared gate/evidence changes must preserve this caller. |
| `client/console/activity.ts:86,96,110,153` | OS09 edits listed above. |
| `client/console/board-model.ts:102,128,129,160` | OS01/OS09 edits listed above. |
| `client/console/paletteEntries.ts:34,35,36,37,38,39,40` | OS01/OS02 edits listed above. |
| `client/console/progress-bars.ts:68,69,71` | OS01/OS09 edits listed above. |
| `client/console/types.ts:32,34` | OS01/OS02 edits listed above. |
| `client/task-create.ts:96,118,120,122,150` | OS01 edits listed above. |
| `client/workbench/task-evidence.ts:10` | OS02/OS09 edits listed above. |
| `scripts/approval-desktop-smoke.mjs:255` | Retain smoke/proof driver; constructor defaults preserve input. Review state assertions after OS09; no unrelated live run. |
| `scripts/autonomy-desktop-smoke.mjs:208,210` | Retain smoke/proof driver; constructor defaults preserve input. Review state assertions after OS09; no unrelated live run. |
| `scripts/connections-demo.ts:84` | Retain smoke/proof driver; constructor defaults preserve input. Review state assertions after OS09; no unrelated live run. |
| `scripts/connections-desktop-smoke.mjs:105,108,109,137,191,192` | Retain smoke/proof driver; constructor defaults preserve input. Review state assertions after OS09; no unrelated live run. |
| `scripts/connections-process-proof.ts:44,53,59,66,84` | Retain smoke/proof driver; constructor defaults preserve input. Review state assertions after OS09; no unrelated live run. |
| `scripts/connections-ui-proof.ts:49,91,95` | Retain smoke/proof driver; constructor defaults preserve input. Review state assertions after OS09; no unrelated live run. |
| `scripts/demo-journey-a.mjs:497,619,625` | Retain smoke/proof driver; constructor defaults preserve input. Review state assertions after OS09; no unrelated live run. |
| `scripts/native-work-smoke.ts:76` | Retain smoke/proof driver; constructor defaults preserve input. Review state assertions after OS09; no unrelated live run. |
| `scripts/package-negative-smoke.mjs:280,291` | Retain smoke/proof driver; constructor defaults preserve input. Review state assertions after OS09; no unrelated live run. |
| `scripts/perf-gate-seed.ts:26,40,95,101,106,107,115` | Retain smoke/proof driver; constructor defaults preserve input. Review state assertions after OS09; no unrelated live run. |
| `scripts/perf-gate.ts:228,270,272,273,274,275` | Retain smoke/proof driver; constructor defaults preserve input. Review state assertions after OS09; no unrelated live run. |
| `scripts/reviewer-desktop-smoke.mjs:196,230` | Retain smoke/proof driver; constructor defaults preserve input. Review state assertions after OS09; no unrelated live run. |
| `scripts/route-probe.ts:83` | Retain smoke/proof driver; constructor defaults preserve input. Review state assertions after OS09; no unrelated live run. |
| `scripts/team-codex-smoke.mjs:73` | Retain smoke/proof driver; constructor defaults preserve input. Review state assertions after OS09; no unrelated live run. |
| `scripts/team-probe.ts:182` | Retain smoke/proof driver; constructor defaults preserve input. Review state assertions after OS09; no unrelated live run. |
| `server/agent-profiles.ts:269,310,321,520` | Retain Task-existence validation at 520. Earlier .tasks entries are routing-override maps, not stored Task objects. |
| `server/app.ts:1345,1346,2132,2221,2248,2409,2591` | OS01/OS02/OS07/OS09/OS12 edits listed above. |
| `server/automations.ts:647` | OS12 edits listed above. |
| `server/change-review/partial-keep.ts:158` | OS09 edits listed above. |
| `server/change-review/service.ts:594` | Retain task/session/acceptance lookup; completion and partial-keep gate changes are elsewhere. |
| `server/command-admission.ts:30,38` | OS01 edits listed above. |
| `server/connections/desktop.ts:182` | Retain internal desktop DTO; never expose it as the filtered Owner API. |
| `server/connections/service.ts:811` | OS13 edits listed above. |
| `server/durable-controls.ts:29,115,137,292,363,410,452` | OS01/OS12 edits listed above. |
| `server/harness/bridge.ts:192,296,746,778,853` | OS09/OS12 edits listed above. |
| `server/harness/capabilities/native-loop.ts:715,1169,1176` | OS09 edits listed above. |
| `server/harness/host.ts:646` | OS12 edits listed above. |
| `server/harness/native-loop.ts:219,713,917` | Homonym: .tasks are child/delegation proposal DTOs, not persisted Task collections. Preserve boundary. |
| `server/native-loop-routes.ts:334,536` | Retain ID/workflow lookup; regress against new finish gate and prevent direct human-review bypass. |
| `server/native-work.ts:468,585,890,1351,1437,1496` | OS09/OS12 edits listed above. |
| `server/ready-scheduler.ts:41,133,143,162,194,309,337` | OS01/OS02/OS12 edits listed above. |
| `server/review-comments.ts:208` | Retain comment-to-task/session lookup; comments cannot count as manager sign-off. |
| `server/sandbox/change-sets.ts:531` | Retain task/Need association; accepting a change set does not accept a human submission. |
| `server/software-pack/service.ts:211,559` | Retain verification command/worktree checks; human report is not a software command check. |
| `server/store.ts:30,110,476,505,535,692,853` | OS01/OS02/OS03/OS09/OS10 edits listed above. |
| `server/supervision/detectors.ts:460` | Retain H17 verification-regression detection; do not interpret human acceptance as verification. |
| `server/supervision/records.ts:62,222` | Retain task/acceptance projection; no independent human-completion state. |
| `server/supervision/service.ts:314,456` | Retain task binding; H17 and human-review states stay distinct. |
| `server/support-bundle.ts:415,488` | Retain aggregate counts and redaction; add no people/report/message bodies to support exports. |
| `server/task-admission.ts:74` | OS01 edits listed above. |
| `server/team/board.ts:48,68,77,85` | OS01/OS02/OS09 edits listed above. |
| `server/team/service.ts:543,554,560,562,569,600,617` | OS01/OS02/OS09/OS12 edits listed above. |
| `server/trust/reviewer.ts:450` | Retain task-context lookup; model review is not a manager's authenticated decision. |
| `server/trust/scope-grants.ts:294` | Retain task-existence/scope checks; assignment alone does not grant effect authority. |
| `server/verification/service.ts:42,121,122,137,153,429` | Retain AI declaration/verification semantics except the explicit OS09 regression integration. |
| `server/work-control.ts:24,100,103,338,384` | OS09 edits listed above. |
| `server/work.ts:50,103,159,217,336,359,398` | OS09 edits listed above. |
| `shared/connection-desktop.ts:29` | Retain desktop Task[] DTO; remote projections must be separately scoped. |
| `shared/harness.ts:293` | OS12 edits listed above. |
| `shared/ready-queue.ts:23,87` | OS01/OS02/OS12 edits listed above. |
| `shared/types.ts:192,654` | OS01/OS02/OS07/OS09/OS12 edits listed above. |
| `shared/verification.ts:297` | Retain current H17 contract and digest bytes; use sibling human completion. |

Indirect creation adapters also belong in the work order:

- `server/interaction-service.ts` - edit - At lines 240/733, Version its typed create/edit host seam with OS01/OS02; no second conversational writer.
- `scripts/codex-harness-smoke.ts` - edit - At line 69, Add focused explicit priority/assignment inputs only when exercising the new behavior; preserve existing smoke route.
- `scripts/connections-provider-smoke.ts` - edit - At line 95, Same constructor/proof boundary; do not require live credentials for the deterministic Task migration check.
- `scripts/h14-measure.ts` - edit - At line 155, Seed the new contract explicitly when measuring its impact.
- `client/console/LoopStart.tsx` - edit - At line 29, OS02/OS09 human/submitted guard described above.
- `client/console/StopMenu.tsx` - edit - At line 154, OS02/OS09 use actual session controls versus human workflow actions.

Task-ID-only Work/approval inputs in client/work-start.ts, client/ready-queue.ts, client/approval-decisions.ts, server/work-admission.ts and server/approval-admission.ts retain their existing versioned receipts unless a separately reviewed wire amendment is needed. Task priority/assignment must not silently change the historical digest of a admitted Work or Approval command.

Existing tests/fixtures that directly consume Task or a task collection:

| Path and representative lines | Impact |
|---|---|
| `tests/agent-authority.test.ts:305,306` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/agent-profiles-ui.spec.ts:115` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/agent-ui.spec.ts:109` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/ai-engines-ui.spec.ts:438` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/approval-admission.test.ts:145,367,374` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/artifacts-ui.spec.ts:1345` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/attribution-shared-ui.test.ts:82,293` | Observed required-priority compile failure; fixture edit in OS01. |
| `tests/auto-mode-migration.test.ts:289,303` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/automation-routes.test.ts:212,407` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/automation-scheduler.test.ts:212` | Behavior update/regression in OS12. |
| `tests/automation-weekly-brief.test.ts:191,272` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/automations.spec.ts:207,308,349,363` | Behavior update/regression in OS12. |
| `tests/autonomy-ui.spec.ts:218` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/aws-conversation-authority.review-20260921.test.ts:620` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/backend.test.ts:319,376,393,421,457` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/board-model.test.ts:34,36,158,299` | Behavior update/regression in OS09. |
| `tests/business-output-routes.test.ts:406` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/change-review-ui.spec.ts:67,234` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/completion-journey.spec.ts:502` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/connection-test-wiring.test.ts:267` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/connections-desktop.test.ts:110,114,118,134,149` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/connections.test.ts:115,118,119,130,145` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/console-activity.test.ts:126` | Observed required-priority compile failure; fixture edit in OS01. |
| `tests/crash-matrix.test.ts:25,201,203` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/delegate-sandbox-ui.spec.ts:68` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/diomedes-home.spec.ts:187,201,213,220,243` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/drawings-ui.spec.ts:85` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/field.spec.ts:246` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/file-imports-ui.spec.ts:232` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/guidance-maintenance-ui.spec.ts:47` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/guidance-maintenance.test.ts:40,83,112` | Observed required-priority compile failure; fixture edit in OS01. |
| `tests/h02-codex-controls.spec.ts:116` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/h02-codex-controls.test.ts:135,461,484,511,537` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/h08-durable-controls.spec.ts:93` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/h08-durable-controls.test.ts:310,514,530,539` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/h14-team-ui.spec.ts:69` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/h15-drift-detectors.test.ts:476` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/h15-supervision.spec.ts:120` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/h15-supervision.test.ts:164,241` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/h16-console.spec.ts:40` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/h16-stream-triggers.spec.ts:58` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/harness-host.test.ts:126,138,144,507,524` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/home-conversation.test.ts:457,474,475,488,499` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/home-luna-routing.test.ts:515` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/interaction-authority.matrix-20260921.test.ts:281,310,329,359,365` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/interaction-authority.repair-20260921.test.ts:227,237` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/interaction-authority.schedules-20260921.test.ts:237,408,409,410,471` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/interaction-seam.review-20260921.test.ts:267,334,336,343,457` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/interaction-seam.test.ts:268,341,343,350,485` | Behavior update/regression in OS07. |
| `tests/native-loop-host.test.ts:182,211,212,225` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/native-loop-ui.spec.ts:37` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/native-loop-vertex-host.test.ts:215` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/native-ui.spec.ts:143,223,314,316,392` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/native-work.test.ts:618,635,666,912,1055` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/pack-contributions.test.ts:118` | Behavior update/regression in OS06. |
| `tests/pack-lifecycle.test.ts:110` | Behavior update/regression in OS06. |
| `tests/perf-gate.test.ts:110` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/progress-bars.test.ts:26,42,189` | Behavior update/regression in OS09. |
| `tests/ready-queue-ui.spec.ts:84,85,86` | Behavior update/regression in OS01. |
| `tests/ready-queue.test.ts:35,300` | Behavior update/regression in OS01. |
| `tests/ready-scheduler.test.ts:84,96,242,246` | Behavior update/regression in OS01/OS12. |
| `tests/remembered-approvals.test.ts:1017` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/review-c-h02-codex.test.ts:132` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/review-diffs-ui.spec.ts:32,138` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/review-diffs.test.ts:42,71,88,148,225` | Observed required-priority compile failure; fixture edit in OS01. |
| `tests/reviewer-ui.spec.ts:178` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/software-pack.test.ts:428,460,478,484,547` | Observed required-priority compile failure; fixture edit in OS01. |
| `tests/support-bundle.test.ts:625` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/task-admission.test.ts:62,98,107,115,123` | Behavior update/regression in OS01. |
| `tests/team.test.ts:294,340,344,351,356` | Behavior update/regression in OS02/OS09/OS11. |
| `tests/ui.spec.ts:201,469,470,478,525` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/verification-service.test.ts:34,63,89,158,499` | Observed required-priority compile failure; fixture edit in OS01. |
| `tests/verification-ui.spec.ts:54` | Behavior update/regression in OS09. |
| `tests/work-admission.test.ts:112,206,237,394,514` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/work-control.test.ts:210,244,264,306,334` | Existing regression consumer; no observed compile failure. Keep assertions unless the approved contract changes the behavior. |
| `tests/workbench-board.test.ts:21` | Observed required-priority compile failure; fixture edit in OS01. |
| `tests/workbench-palette.test.ts:7` | Observed required-priority compile failure; fixture edit in OS01. |
| `tests/workbench-task-evidence.test.ts:59` | Observed required-priority compile failure; fixture edit in OS01. |

The scan is an inventory, not a claim that these tests all fail. The in-memory experiments changed only one type at a time; casts, loose JSON and indirect projections can hide a behavioral defect from TypeScript.

| Change | Observed or predicted impact | Required checks |
|---|---|---|
| Required priority | Observed: Store constructor plus nine fixtures, 10 new diagnostics. | OS01 migration, strict create/edit/replay, comparator, multi-project fairness and UI controls. |
| Discriminated assignee | Observed: nine diagnostics across Board, palette, app wake, team board/service. | OS02 membership binding, colliding IDs, no human auto-start, legacy slot/owner handling; API currently ignores Shell's assignment PUT. |
| submitted | Observed: Store's exhaustive label Record fails (store.ts:1992). Predicted: team status fall-through and terminal-session taskEvidence incorrectly show completion. | OS09 bypass matrix, projection, accepted/bounced reports and H17 independence. |
| moves.by person actor | Predicted: equality branches treat a person as automation, changing reopen/undo and words. | shared/ready-queue.ts:98; client/workbench/task-evidence.ts:47,56; server/app.ts:2251; server/store.ts:1989,2000. Test human reopen, undo authorization/window and historical Owner compatibility. |
| Permission v2 | Predicted: literal v:1 fixtures/types and stored records require compatibility; an enum append alone gives inconsistent Owner capabilities across installs. | Full consumer set in 3.15; profile immutable revisions, no automatic worker authority, explicit reassignment and stock regressions. |
| Completion photo | Current tests cover local FileDrops, not remote authenticated camera uploads. | OS10 real-handler authorization, no model binary, exact bytes, interrupted write and device picker. |
| Human messages | Team mail tests do not qualify private human communication. | OS11 two-person/third-person isolation, stale member, bot disclosure and restart. |
| Pack tile schema | tests/pack-manifest.test.ts:172 deliberately rejects unsupported UI surfaces. | Explicit versioned new contract; retain arbitrary-renderer refusal and P04 lazy/digest tests. |
| Context and new shell | Existing project/home conversation and sharing tests are regression constraints. | Preserve route sharing, scope/digest/lineage, artifact CSP, selected context and no visible-row authority. |

Examples of assertions requiring deliberate preservation or amendment: tests/ready-queue.test.ts:76,90,142 (oldest within project and fair interleaving), tests/ready-scheduler.test.ts:131,333,350,386 (order, pause and limits), tests/team.test.ts:283,336,352 (AI owner/status), tests/workbench-task-evidence.test.ts:18,38,47,56 (active/terminal/manual precedence), tests/business-access-routes.test.ts:246,276 (unknown permission and immutable profile), tests/inventory-command-authorization.test.ts:368,397 (phase revocation and loopback), tests/file-drops.test.ts:173,208 (model refusal and crash), and tests/migrations.test.ts:70,286,303 (chain, old state and newer-version refusal).

Validation configuration matters. Root Vitest does not substitute for services/control-plane's own suite/optional PostgreSQL integration. playwright.config.ts explicitly enumerates specs; a new file alone is not collected. playwright.inventory.config.ts currently uses Chromium iPhone/iPad emulation and desktop, not physical Safari. The journey and responsive configs are separate. The proposed Owner config must collect each new spec and keep fixture proof separate from MI08/MI09 device/rehearsal acceptance. No heavy/browser tests or live providers were run for this report.

### 3.17 customer-ai-connections (OS15) - irrelevant machine diagnostics in customer settings

**User evidence and scope.** Andrew supplied the screenshot at F:/Temp/andre/codex-clipboard-51b86119-494c-4c91-92ba-7127cacafe40.png and asked that these entries not appear as customer setup problems. It shows "LocalAI supervisor - Disconnected", an Ollama installation that "Diomedes does not use", and "AionCore - Not configured", followed by a loopback URL, executable path, missing version and internal capability names. The screenshot's installed build/commit is unknown; the matching source below was inspected on bb43d0d. The problem is a customer being asked to interpret implementation details and unsupported tools.

**Root cause traced through the boundaries.** server/integrations.ts:79 hardcodes http://127.0.0.1:8080/localai/status. Lines 844-898 construct and probe an observe-only LocalAI entry with no runnable adapter. getIntegrationStatuses, lines 901-1000, always includes LocalAI, Ollama and a fabricated AionCore placeholder in its roster, including when absent. Non-passive checks create the LocalAI status probe with the Codex check; discovery consent is checked at server/app.ts:1715-1728, so this is not evidence of an undisclosed startup scan. Consent to checking connections nevertheless does not make these tools customer features.

client/Settings.tsx:285-324 renders the same roster under both Helpers on this computer and Engines. Its only filters remove Sample work and entries handled by the external-engine cards. It does not require a supported action, an explicit configuration or a useful customer purpose. Lines 341-391 print detail, allowance commentary, version, location and raw capabilities directly. The introductory sentence says Nectovia can use these, even where the card itself says it cannot. Tests deliberately preserve this mistake: tests/ui.spec.ts:1020-1049 requires LocalAI and AionCore to be visible at Guided and Standard detail.

**Machine-specific does not establish a copied customer profile.** The LocalAI URL and AionCore concept are built into the product. The Ollama executable location is discovered on the running machine through PATH/known locations (server/discovery.ts:288-305,734-785); its username is not a constant in this flow. This establishes a shipped assumption about optional local tooling and inappropriate presentation of local paths. It does not establish that Andrew's executable path, configuration or credentials were bundled into a customer's installation. Verify a clean installed profile separately before making that claim.

**Required behavior.** Customer AI settings show supported services with an action the person can take: connect, enable, choose or repair a service they configured. A supported service that is currently unavailable must still have an honest repair path. LocalAI, Ollama, Hermes and proposed engine hosts must not look like required or broken customer dependencies merely because discovery knows their names. Unused observations belong only in deliberately opened diagnostics, if retained at all. AionCore's proposed implementation is not a customer connection. Raw paths, localhost URLs and adapter vocabulary stay in technical/support detail. Make unsupported local probes explicitly diagnostic opt-ins; filtering a card alone does not remove the founder-machine assumption in the host.

Edit / add / remove list:

- client/Settings.tsx - edit - Present actionable supported connections; remove the unconditional legacy diagnostic roster from ordinary Helpers/Engines. Keep connection failures actionable for services the person actually selected.
- client/integration-view.ts - add - Pure presentation policy distinguishing supported connection/setup actions from optional diagnostic observations. Do not equate currently available with supported.
- server/integrations.ts - edit - Remove the unconditional AionCore customer placeholder and gate optional LocalAI observation separately from supported connection checks. Preserve truthful internal diagnostics where needed.
- server/discovery.ts - edit - Separate unsupported local observations from the supported connection discovery request; preserve bounded, consented checks and current-machine provenance.
- server/app.ts - edit - Wire the customer/diagnostic projection and opt-in without weakening the existing local API boundary.
- server/usage.ts - edit - Keep observation-only allowance boilerplate out of customer connection cards; retain truthful unknown usage for real supported connections.
- tests/integration-view.test.ts - add - Clean machine, supported-but-offline connection, explicitly configured local diagnostic, and no-action placeholder cases.
- tests/ui.spec.ts - edit - Replace the assertions requiring LocalAI/AionCore at Guided/Standard with supported-service and absent-diagnostic assertions.
- tests/integrations.test.ts and tests/discovery.test.ts - edit - No optional supervisor/Ollama probe during normal customer checks; explicit diagnostics still bounded and truthful.
- Remove behavior, not engine adapters or provider support. No source-file deletion is required.

Acceptance: a fresh customer profile without these tools shows no "missing supervisor", unused Ollama, AionCore, founder path or internal capability warning; a supported disconnected Claude Code connection still offers repair. Check both Settings entry points and onboarding. Prove the optional probe does not run, not just that its card is hidden. A packaged clean-profile capture remains required; the supplied screenshot is evidence of the complaint, not proof of a repaired build.

#### Second screenshot: customer services versus internal runtimes

Andrew's second screenshot is F:/Temp/andre/codex-clipboard-57486d1e-04d1-4d0d-a372-bb1d4d176614.png. Its Projects sidebar lists oh-my-pi under Engines. In this source the little square is a status span, not an interactive checkbox (client/console/Home.tsx:522-548). Its presence still wrongly promotes that runtime to a customer service.

The root cause is wider than the earlier legacy Settings cards. shared/engines.ts:11 includes oh-my-pi in EXTERNAL_ENGINES; client/AISetup.tsx:596 creates a card for every member. Home.tsx:170 and client/components.tsx:602 use adapter=ready and non-sample as their product catalogue. Neither filter says this is a company-approved customer service. HelperLine at client/components.tsx:603-625 also prints the first available service's discovery disclosure; that explains the screenshot's "observed on win32 via path" jargon under the composer. It is not the selected request's route or readiness.

Treat Andrew's distinction as an explicit product catalogue, separate from implementation terminology:

| Customer-service category Andrew approves | Current source qualification |
|---|---|
| Codex / ChatGPT account | Internal route id codex; current UI calls it ChatGPT. Eligibility and surface support still apply. |
| Claude Code | Supported native conversation route; direct use is internal or explicitly entitled, with free-customer use denied by the new policy. |
| Cursor and Devin | Existing external adapters. Being listed does not mean they can answer the main conversation; keep per-surface capability checks. |
| OpenCode Go and Zen | Both are acceptable product categories to Andrew. Only Go is currently implemented here: shared/engine-routes.ts:60-77 explicitly excludes Zen and server/engines/opencode.ts:50,220,579 pins opencode-go. Do not advertise Zen as connected or silently use its account/balance; it needs separately qualified support. |
| Company-managed tiers | Existing provider routes behind Efficient/Focused/Thorough remain policy-controlled. A customer need not configure the underlying harness or provider. |
| Not customer-service choices: oh-my-pi, Hermes, LocalAI supervisor, Ollama, AionCore | Internal runtime, tooling, observation or proposed implementation. Keep out of customer menus, counts, onboarding, repair prompts and route selection, even when installed/connected or an adapter exists. |

Some allowed products also contain harnesses. The policy is which services Nectovia supports and sells to customers, not a claim that a CLI or runtime is itself a model provider. Keep service/account, model, runtime adapter and payer as distinct fields. An approved name does not mean a free customer may use it; OS20 supplies that decision, and OS18 decides whether internal-only surfaces can exist in the build at all.

Additional OS15 files:

- shared/ai-service-catalog.ts - add - Curated customer-service metadata, internal-runtime classification and per-surface support, separate from the full persisted Route/adapter union.
- shared/engines.ts and shared/engine-routes.ts - edit - Consume/associate that classification without invalidating historical oh-my-pi records. Preserve truthful Go account semantics and unsupported Zen status.
- client/console/Home.tsx - edit - Derive Engines/AI services rows and counts from the permitted catalogue; remove oh-my-pi and raw discovery status from customer presentation.
- client/components.tsx - edit - HelperLine reflects the intended host-resolved choice or an actionable connection state; never pick the first enabled adapter as an implied route.
- client/AISetup.tsx and client/console/Picker.tsx - edit - Apply the same service catalogue to cards/choices, not a second hardcoded list.
- tests/ai-service-catalog.test.ts - add - Allowed names, excluded runtimes even when ready, surface distinctions, Go versus unsupported Zen and counts without internal entries.
- tests/ui.spec.ts and tests/ai-engines-ui.spec.ts - edit - Assert the Projects sidebar, helper line, Settings and onboarding agree. Verify direct host access is denied by OS20 even if a hidden route ID is posted.

### 3.18 conversation-ai-switching (OS16) - AWS Luna to Claude Code

**Finding.** Claude Code is a supported conversation route, but the current conversation UI offers no direct "use Claude Code here" action. This is a control/precedence problem, not evidence that the adapter is absent. shared/engines.ts:33 makes AWS Bedrock the default conversation route. Store.provisionHome and provisionProjectConversation (server/store.ts:981-1099) create/re-pin conversations to that default unless engineChoice is person. They do not follow Settings' defaultEngine.

**Current interaction map, reconstructed from source.**

| Where Andrew acts | What actually happens | Why it does not clearly switch the current AWS conversation |
|---|---|---|
| Conversation or project thread: choose Efficient / Focused / Thorough | DiomedesHome.pickStyle writes workStyle; ThreadModelControls renders only WorkStylePicker. Efficient's default map is AWS Luna. | There is no route/model menu, including at technical detail. The normal tier map accepts company model-API routes, not Claude Code. |
| Settings -> Engines (or Helpers on this computer) -> Claude Code -> check/sign in -> select an offered model -> Use as default | POST /api/ai/select saves defaultEngine, enables Claude Code, and saves its model/account route. | It does not rewrite the conversation, its explicit model, its workStyle or the owner testing pin. Existing thread/project choices and tier routing can still win. |
| Settings -> Engines -> Tiers -> Advanced: owner testing -> Pin every tier to Claude Code -> Save owner testing pin | When an unpinned thread has a tier, resolveTier uses the saved Claude model or the entered model. | This is a computer-wide override for every applicable tier, buried after the provider setup cards. A thread with no effective tier is unaffected; an explicit thread model bypasses it. It is not a per-conversation switch. |
| Verified Claude Code card -> Start a first task | The card requires a matching host verification receipt and ready nextAction. App carries route/model into the project Console; with no open project it opens project search. | It is an onboarding handoff, not a home-conversation route control. It requires connection-test consent and a valid receipt, and has busy/stale-thread guards. |
| Change the stored thread engine through the API | PUT /api/projects/:id/threads/:threadId writes engine and marks engineChoice=person. | The server supports a person choice, but a tier can still override an engine-only update. This is not an acceptable path for a normal person to discover or perform manually. |

Evidence: client/console/DiomedesHome.tsx:173-178,658-683; client/console/Diomedes.tsx's route caption and tier control; client/console/WorkStylePicker.tsx:197-218; shared/tier-map.ts:66-70,114-125; client/AISetup.tsx:373-393,789-815,993-1012,1140-1145; client/TierSetup.tsx:128-176; client/ai-setup-state.ts:142-150; client/App.tsx:828-844; server/app.ts:1624-1643,3051-3105,3202-3237.

**The precedence the fix must make understandable.**

1. A thread with requested.model bypasses the tier resolver. Its selected engine/model governs through the existing thread selection path.
2. Otherwise the effective workStyle is the thread's style, then Settings' style, then no style. For a style, the owner testing pin wins over the tier map. Without a pin, Efficient defaults to AWS Luna. A refused tier stops; it does not fall back.
3. Without a tier, selectedEngine takes the thread engine, then the last non-user turn's route, then project.ai.engine, then Settings defaultEngine, then Sample work. Provisioned home/project conversations ordinarily already have the AWS thread engine, so the Settings default is never reached.

shared/ai-selection.ts:4-28 and server/app.ts:3145-3149,3208-3237 prove this ordering. A fresh, no-write Node probe on bb43d0d loaded the actual pure shared modules with TypeScript transpilation and synthetic inputs. Its assertions passed: the conversation default is AWS; a recorded AWS thread stays AWS after setting the global default to Claude; Efficient remains AWS despite that global default; normal tier validation rejects Claude Code; the owner testing pin resolves an applicable tier to Claude and its saved model. This is function-level evidence, not an authenticated Claude run or reproduction inside Andrew's installed app.

**Proposed interaction, amended by Andrew's latest direction.** Retain customer tiers. A discoverable optional AI-service action belongs to a verified internal/company operator and only those paid customer contexts whose product policy explicitly permits it. A customer organization owner, expert label or Technical detail setting is not sufficient. Free-customer direct Claude use is denied. OS18 and OS20 define the host-enforced build and account boundaries before this control is released; the steps below apply only after those checks. Do not force a provider questionnaire on employees or infer that all paid plans grant direct route choice.

1. Open AI service: show "This conversation uses AWS Bedrock (Luna)" from the host's next-message resolution, and say if a tier, explicit choice or owner override decides it.
2. Choose Claude Code from supported routes for this surface. A ready connection can be selected immediately. Otherwise offer a direct Claude Code setup/repair action, preserving the current thread, draft and intended choice.
3. Return from setup to the same conversation. Pick a listed Claude model or its already validated saved default without typing a model ID. Make "This conversation" the scope; changing defaults or every tier requires a separately labeled action.
4. Save one validated thread choice through the existing authority. An explicit Claude choice must actually beat the tier for this thread; merely saving defaultEngine or engine is insufficient. Reuse the existing engine plus requested.model representation where it meets the full contract, preserving Agent/permission/mode and avoiding an unnecessary parallel routing store.
5. Confirm the saved, host-resolved next-message choice beside the composer. Do not send a model request as a side effect of selecting it. Changing an active run is unavailable until its current operation has settled; a late setup response cannot route a different thread.
6. Before sending, preserve the destination route's data/history disclosure and scope. Earlier AWS turns remain in History; switching does not silently grant Claude the transcript or pretend its native session continued. Existing lineage retirement, replay protection and uncertain-delivery rules still apply.
7. Offer "Use the workspace's AI settings" to deliberately clear the explicit selection. Show the resulting next-message service, including any owner override; cancel and failed saves preserve the prior choice and draft.

The existing Picker in client/console/Picker.tsx can supply prior art for offered models, connection status and selection. It is not rendered by ThreadModelControls now. Reintroducing it verbatim is insufficient: its provider list is separately maintained, its project-thread assumptions differ from the home conversation, and the currently hidden precedence remains. Reuse its validated pieces with one route catalogue and one host resolution.

Edit / add / remove list:

- client/console/Diomedes.tsx - edit - Add the optional, plainly named AI-service action and resolved choice to the conversation controls.
- client/console/DiomedesHome.tsx - edit - Load/save the scoped choice, preserve drafts through setup, prevent late results after navigation, and refresh host resolution after changes.
- client/console/WorkStylePicker.tsx - edit - Make the relationship between tiers and explicit service choice visible; selecting a style must deliberately clear or retain a pin consistently.
- client/console/Picker.tsx - edit - Reuse offered-model/readiness behavior for the optional chooser, with supported routes derived from the shared catalogue rather than the partial provider list.
- client/console/Shell.tsx - edit - Reuse the guarded thread-selection path and refresh confirmation after the persisted response, not an optimistic route label.
- client/AISetup.tsx and client/App.tsx - edit - Add a return-to-this-conversation handoff; distinguish a saved default from switching the current thread and from Start a first task.
- client/TierSetup.tsx - edit - State the scope of the owner override and link back to per-conversation switching; it must not be the ordinary way to select Claude.
- shared/ai-selection.ts and shared/tier-map.ts - edit - Centralize/document explicit-choice precedence and preserve default/tier behavior unless the person selects an override. Any new persisted representation needs a migration and exact consumer audit.
- server/app.ts - edit - Validate and atomically save the intended engine/model/selection scope; enforce allowed home routes, current thread/run state and stale updates at the host. Return the actual next-message result and preserve the normal send admission.
- server/store.ts - edit - Preserve person-selected routes during provisioning/restart and test clearing a choice; retain one conversation identity and its history.
- tests/conversation-ai-switching.spec.ts - add - AWS -> Claude -> automatic choice on both home and a project, setup round-trip with draft, settings-default ambiguity, pending run, failed save and navigation race.
- tests/work-style-ui.test.ts - edit - Replace the blanket absence of optional expert controls at tests/work-style-ui.test.ts:104-122; retain the simple tier menu for ordinary use.
- tests/engine-selection.test.ts, tests/tier-map.test.ts, tests/work-style-home.test.ts and tests/home-luna-routing.test.ts - edit - Cover precedence, explicit choice surviving provision/restart, tier/pin interactions and default behavior.
- tests/first-task-handoff.test.ts and tests/first-task-handoff.spec.ts - edit - Preserve current verification/late-response guards and distinguish the new return-to-conversation handoff.
- tests/lineage-continuity-claude.test.ts, tests/lineage-continuity-aws.test.ts and tests/send-confirmation-read-access.test.ts - edit - Destination history grant, native lineage change, exact retry identity and no dispatch on selection.
- Remove the assumption that changing a global default switches a provisioned conversation. Do not remove or silently reroute AWS support.

Acceptance: with Claude connected and the internal/operator or explicit customer entitlement satisfied, Andrew can switch the current AWS conversation without editing JSON, entering a model ID, starting a new project, or changing every tier on the computer. A free customer cannot gain that action or dispatch by posting the same request directly. The visible choice must match the host's next dispatch; reload and another project's conversation must respect its scope. Scripted-provider tests prove routing/access only; installed-app interaction and a separately authorized live Claude request remain live-provider acceptance.

#### Second screenshot: Projects-page tier/model controls and draft handoff

The screenshot is the Projects page rendered by client/console/Home.tsx, not DiomedesHome.tsx's Nectovia conversation. Home.tsx:296-340 renders only Mode, In project and Send. HomeProps.onSend at line 94 and send() at lines 155-159 carry text, Project and Mode only. App.sendLandingAsk at client/App.tsx:542-553 stores only askDraftKey and askModeKey and opens the project. It does not send a provider request or carry a style/service/model choice. Shell later reads the carried Mode and text at client/console/Shell.tsx:815 and 943. The existing conversation controls therefore do not solve this surface's omission.

A no-write AST inspection of the real Home.tsx on d27230b found exactly two select controls: Mode and In project. This supports the screenshot's missing Efficient/Focused/Thorough control. It is source proof, not a clicked installed-app reproduction.

Required interaction:

1. Select a project and Mode as today. Add a Work style control with the host-permitted Efficient/Focused/Thorough choices before continuing; show which applies rather than leaving the choice implicit.
2. For an authorized internal operator, or a paid customer whose policy explicitly grants it, expose the optional service/model control. Free customer access to direct Claude remains denied. Tier choice, direct service selection and Mode must not be conflated.
3. Carry the draft plus its intended style/eligible service choice to the actual destination thread through one typed handoff. The host validates the choice against that thread, current entitlement and supported surface. A restored local draft cannot grant access.
4. Reflect the effective choice in the destination composer and its confirmation before the actual send. Changing the project clears or revalidates an incompatible choice. Preserve existing explicit thread choices unless the person deliberately replaces them; do not modify other threads or global defaults.
5. The current button says Send but only opens a project with a draft. Align its label with that handoff, for example "Continue in project", unless a separate approved change makes it send through normal admission. Never add an automatic provider call merely to match a misleading label.

Additional OS16 files:

- client/console/Home.tsx - edit - Add the permitted style selector and authorized service/model control to Start here; show the effective scope.
- client/App.tsx and client/console/Shell.tsx - edit - Carry and validate the complete draft choice and resolve the correct thread before displaying a sendable selection.
- client/project-draft-handoff.ts - add - Typed, versioned draft intent with expiry/target identity and no permission claims; reuse existing draft behavior rather than another conversation store.
- tests/project-draft-handoff.test.ts - add - Style/service round-trip, target change, old draft compatibility, revoked access, explicit thread choice and no dispatch on handoff.
- tests/projects-ai-choice.spec.ts - add - Customer tier choice and internal/entitled direct choice from Projects through the destination composer; no raw model ID entry or accidental send.
- tests/work-style-ui.test.ts - edit - Cover this Projects entry separately from the existing conversation/header controls.

### 3.19 project-folder-chooser (OS17) - drive selector and understandable navigation

**Latest user instruction controls the design.** Andrew initially asked for a native file/folder picker, then clarified that he likes the existing in-app folder menu. Retain that menu, add a drive selector, and replace "Up" with a named destination such as "Back to Documents". Breadcrumbs should show the current location. A native dialog is no longer the primary requested replacement. This is folder selection for a project, not selecting an individual file to upload.

**Root cause.** The Folder field's Choose... button calls browseFolder, which requests /api/fs/list and sets inline browse state (client/App.tsx:534-540,1035-1074). It never invokes a native dialog. The server lists the supplied directory or store.projectRoot, returns child directories plus one parent, and sets parent=null at a filesystem root (server/app.ts:1750-1778). It has no drive/root catalogue. A person can navigate children, press Up and then Use this folder, but once at a drive root there is no path to a different drive except typing it into the field. An empty/missing initial project root returns an empty list, increasing the impression that Choose did nothing. The generic placeholder about creating a new folder is also displayed for Open a folder as a project.

This does not prove why a click appeared unresponsive in Andrew's particular installed build: a request error, an empty listing or layout/scroll could contribute. The confirmed source defects are the lack of drive selection and unclear navigation/purpose. The shared Button defaults to type=button (client/components.tsx:85-92), so an accidental form submission is not the supported explanation. Existing file inputs in DesignCenter are upload inputs, not proof of a native project-directory picker. The desktop preload exposes authentication, and desktop/main.mjs supplies no folder-selection bridge.

**Current -> intended interaction.**

| Step | Current behavior | Required behavior |
|---|---|---|
| New project / Open a folder -> Folder -> Choose... | Opens an inline server directory list at the entered path or projects root. No native picker. | Open the existing in-app chooser with an obvious loading state and current location. Use "Choose folder..." for the trigger. |
| Choose a drive | No control; typing a path is the only cross-drive route. | A Drive dropdown lists drives actually available to the app, with useful labels where known, such as Local Disk (C:) and Data (F:). Never hardcode Andrew's drives. |
| Navigate | Child names, full path and an "Up" button. | Click child folders; use clickable breadcrumbs. Replace "Up" with "Back to [containing folder name]" and give the full destination as the accessible label/tooltip where names repeat. |
| Reach a drive root | No parent and no other root to choose. | Hide the containing-folder control at the root; the Drive selector remains available. |
| Choose the location | Use this folder copies the path into the form. | Keep this explicit confirmation and show the chosen folder. Selecting/browsing must not create/open a project before Create project or Open project. |
| Empty/inaccessible folder or removed drive | Empty lists and generic errors are easy to confuse with no action. | Distinct loading, empty, denied and disconnected states with retry/change-drive actions. Keep the prior valid selection and do not accept an outdated response. |
| Cancel | Close the chooser/project dialog. | Preserve the form draft when closing the chooser; restore focus to Choose folder. Closing the project dialog remains a separate action. |

New-project copy should explain the automatically created project folder when the field is empty; Open-project copy should say "Choose an existing folder". Browsing through the visible controls must be sufficient without typing paths. An optional path field can remain for people who prefer it. Support keyboard navigation and long/repeated folder names without hiding the destination.

Edit / add / remove list:

- client/App.tsx - edit - Keep project create/open authority and draft state; wire a drive-aware chooser, mode-appropriate copy and loading/error/cancel behavior.
- client/console/ProjectFolderChooser.tsx - add - Extract the existing inline browser with Drive, breadcrumbs, named containing-folder action and Use this folder; no parallel project creation logic.
- client/styles.css - edit - Preserve the existing menu appearance; size/scroll and focus treatment for drive labels, long paths and narrow windows.
- shared/folder-browser.ts - add - Typed root/drive and directory-list responses, stable selection identity and explicit read failures. These types confer no filesystem authority.
- server/folder-browser.ts - add - Bounded host-platform root enumeration and directory listing for this local chooser. Discover available roots from the running host, tolerate unavailable/removable drives, and avoid launching a drive probe from arbitrary user text.
- server/app.ts - edit - Reuse/refactor /api/fs/list through that helper and expose roots through the same guarded local boundary; keep final project creation/open validation.
- tests/folder-browser.test.ts - add - Multiple drives, root termination, empty/missing directory, permission refusal, detached drive, Unicode/spaces, symlinks/junctions and private path checks using controlled fixtures.
- tests/project-folder-chooser.spec.ts - add - Choose a different drive, navigate by breadcrumb/named button, select without typing, cancel, keyboard focus, slow/stale response and correct New versus Open copy.
- tests/paths.test.ts - edit only if needed for new root-list composition - Preserve safeAbsolute and junction/private-path refusals; selecting a folder must not bypass them.
- Remove the bare "Up" label and drive-navigation dead end. No Electron IPC, native-auth change, file upload redesign or source-file deletion is needed for this clarified scope.

Acceptance: from a blank Folder field, choose a directory on a second available drive, return to its containing folder by name, and populate the form entirely through visible controls. No project is created until the final form action. A clean installed Windows test must exercise actual local/mapped/removable drive availability; a deterministic mocked-drive UI test does not prove those OS behaviors. A browser talking to a desktop service is choosing that service's folders; this route must not be exposed as a remote phone filesystem browser through OS05.

### 3.20 internal-customer-builds (OS18) - company tools must not become customer features

**New owner direction.** The second screenshot and Andrew's message distinguish company development/testing from a customer installation. He wants to use Nectovia with Claude internally, test unfinished features, and keep developer design tools out of shipping customer builds. A customer organization's owner is not a Diomedes company operator. This supersedes the earlier OS16 suggestion that any "owner/expert" label was enough to expose provider switching. Internal access and paid-customer access are separate decisions.

**What exists.** There is build provenance, not a complete product-edition boundary. scripts/package-desktop.mjs:191-224 bundles desktop/service.ts with DIOMEDES_BUNDLED=true and stamps unsigned-experimental signing metadata. It stages the already-built client dist at line 168; it does not select a customer versus internal feature set there. server/build-identity.ts:65-100 derives development/experimental/unknown labels for support. Those are descriptive facts, not authorization. desktop/main.mjs:47-61 uses the same Diomedes application/profile identity unless explicit profile/data environment paths are supplied. desktop/app-updates.mjs:31-33 and shared/app-updates.ts define the existing official update source. An "experimental" filename alone does not separate customer capabilities, user data, native account bindings or update eligibility.

The current design gate is especially concrete: server/customization-gate.ts:83-94 reads DIOMEDES_DESIGN_AUTHORING=1 without checking a product edition. server/app.ts:779 constructs that gate from live workspace records and the launch environment. An in-memory probe on d27230b called the existing gate with a synthetic personal scope: ordinary launch gave granted=false; the authoring flag gave granted=true, via=authoring, with entitlementState=none. No app, network, provider or user configuration was touched. That confirms a launch switch, not a company-only shipping boundary.

**Recommendation for the proposed fork.** Start with two independently packaged editions from one source repository: an internal Nectovia build for company operators, and a customer build. Experimental changes can live in isolated feature branches and be included only in internal artifacts before acceptance. Shared Core, Trust, migrations and fixes remain one implementation. A permanent fork would add repeated merges and duplicate qualification work without itself deciding which account may use Claude. Use a long-lived fork only if Andrew deliberately wants different products or incompatible release architecture; none of these findings requires that yet. This is a recommendation in the investigation, not authorization to create a fork or publish an edition.

Keep three independent checks:

| Check | What it decides | What it does not grant |
|---|---|---|
| Built artifact capabilities | Which UI modules, diagnostic probes, developer routes and adapters this edition can contain/expose | Payment, organization membership, provider credentials or company staff identity |
| Current actor and product entitlement | Which supported features this signed-in person/organization may use now | A working provider connection or authority to disclose project data |
| Connection, task and data policy | Whether the selected route/account/model is ready and this particular action may run | A paid product entitlement or a different payer |

The effective feature set is the intersection, resolved on the host. A request body, saved profile, Technical detail mode, customer owner role, localStorage or environment flag cannot raise a customer artifact's maximum capabilities. Treat missing or unrecognized production build policy as customer-restricted, not implicitly internal. Build identity remains evidence and must not be promoted into an unsigned client-supplied grant.

Internal and customer editions need distinct application IDs, install destinations, profile/data/session stores, shortcuts, visible build labels and update eligibility. Do not let an internal login, owner testing pin, design-authoring setting or experimental adapter configuration migrate into the customer edition. A deliberate import can migrate compatible project records without copying account grants. Retain the existing customer profile location during upgrade; inventing a new customer path and losing their projects is not an acceptable split. Each release must bind its edition/capability manifest to the exact client and service artifacts and verify that an update cannot cross editions silently.

Edit / add / remove list:

- shared/build-profile.ts - add - Versioned internal/customer build capability contract with a restrictive unknown profile; no account entitlement data.
- server/build-profile.ts - add - Resolve the host's built profile and expose only a public capability projection. No client/environment upgrade from customer to internal.
- server/build-identity.ts - edit - Report edition and capability-contract identity alongside the existing source/build facts without confusing provenance with access.
- server/app.ts and desktop/service.ts - edit - Wire the immutable edition into feature mounting, diagnostics and authorization composition.
- scripts/package-desktop.mjs, scripts/build-windows-installer.mjs and vite.config.ts - edit - Explicit edition selection for client/service packaging, identity and capability manifest; prevent mismatched client/server payloads and internal-only code/resources in a customer artifact.
- desktop/main.mjs - edit - Isolate internal profile/data/native sessions and app identity by build; preserve the established customer upgrade path.
- desktop/app-updates.mjs, shared/app-updates.ts and server/app-updates.ts - edit - Bind accepted release/update metadata to the edition and reject cross-edition installation.
- tests/build-profile.test.ts - add - Unknown/missing profile is restricted; a request, setting, environment flag or customer owner cannot widen it.
- tests/build-identity.test.ts, tests/desktop-packaging.test.ts and tests/desktop-app-updates.test.ts - edit - Exact edition provenance, package contents, two installs running with isolated state, and update separation.
- Remove public reachability/bundling of internal-only tools in customer artifacts. Do not delete internal adapters or old run-history types simply to hide them.

Acceptance: build both editions from one exact source cut; inspect packaged contents and host capability responses; prove that internal configuration and test flags cannot enable a customer feature. Install side by side in owned test profiles and verify session/data/update separation. A developer dev server or a renamed executable is not that proof. No edition, fork, package or installed-app change was created by this investigation.

### 3.21 company-design-delivery (OS19) - design creation belongs to Diomedes

**Required product behavior.** Customer owners and employees do not author designs in shipping Nectovia. This is not a premium editor that a paid customer unlocks. Diomedes staff create, review and deliver the design through company tools/backend operations; customers receive the approved result. Preserve essential accessibility controls such as text size, contrast, reduced motion and safe reset. Whether customers may choose among already approved company themes is a separate presentation choice; it does not authorize authoring, asset import or publishing their own theme.

**Existing policy differs from this new direction.** client/Settings.tsx:222-234 lists Design Center and Developer without edition filtering; lines 468-506 invite the person to make their own theme. client/App.tsx:630,929-930 exposes the destination and mounts DesignCenter. client/console/Home.tsx includes Design Center in its navigation catalogue. The editor renders in a locked/preview mode even without authoring rights (client/console/DesignCenter.tsx:415-429).

The shared policy explicitly sells advanced customization with plan_business (shared/customization-entitlement.ts:34-78,194-224); its predicate permits an active qualifying plan or personal launch-time authoring. canActivateOrganizationRevision at lines 235-259 additionally accepts a customer owner/admin with the plan. The local production gate currently has no paid-entitlement service and normally resolves none, so a paid fixture passing does not prove a paying customer can activate it today. Nevertheless, both the policy and advertised editor conflict with company-only design creation. The pure follow-up probe confirmed the existing paid fixture grants editing, while the launch flag grants personal editing with no plan.

The company-delivered design benefit already has a separate owner: server/customization-benefit.ts and server/customization-benefit-routes.ts record the design engagement. Preserve that distinction instead of deleting a service promise when removing a customer editor.

**Website/release interaction.** The site repository was inspected at origin/main 63d99422a8cb6932838b928f94bb9faad132f4df, confirmed by its remote ref. public/tools/start-diomedes-design.cmd:74 sets DIOMEDES_DESIGN_AUTHORING=1. src/pages/docs/releases.astro:61-82 links the launcher and explains self-service design; src/content/docs/development.md:37 also directs people to it. src/data/serviceScope.ts:111-138 already describes company-performed design work. These sources need reconciliation with the new policy. No deployed-site state was checked or changed, and no release history should be silently rewritten as if old builds never behaved this way. The app checkout no longer contains the historical root launcher/design-start document named in old memory; the current site asset is the verified target.

**Company delivery flow.** A customer requests the included design work; an authorized Diomedes operator creates a versioned ThemePack in internal tools, reviews it against the customer's scope and accessibility limits, and publishes/assigns an approved revision. The customer host validates and applies that assigned revision through the existing theme authority. Preview, save, import, restore, activation and Website Studio probes must all be classified deliberately; leaving the editor route callable after hiding the navigation is incomplete. Existing customer-authored themes need a compatibility plan that preserves readable settings and the last working appearance while removing further authoring rights, not a blanket deletion.

Edit / add / remove list:

- client/Settings.tsx, client/App.tsx and client/console/Home.tsx - edit - Remove customer Design Center/Developer entry points and previews; retain permitted accessibility and approved-look controls.
- client/console/DesignCenter.tsx and client/console/design-center/entitlement-api.ts - edit - Internal/company authoring only; distinguish company operation from a customer plan or organization owner role.
- shared/customization-entitlement.ts and server/customization-gate.ts - edit - Replace paid-customer/launch-only authoring grants with edition plus company-operator authorization. Keep accessibility and safe reset outside the paid/authoring gate.
- server/theme-routes.ts - edit - Enforce company-only authoring and controlled delivery/activation server-side, including direct API calls and Website Studio access. Preserve a narrow approved-theme read/apply path.
- server/themes.ts and server/theme-assets.ts - edit - Reuse versioned scoped packages/assets for company-delivered revisions and migration; do not create a second theme store.
- server/customization-benefit.ts and server/customization-benefit-routes.ts - edit - Keep customer design-service requests/benefit records separate from internal editing permission.
- tests/customization-entitlement.test.ts and tests/design-studio-ui.spec.ts - edit - Customer owner/admin/member, free/paid/revoked plans, launch flags, direct calls, imports and legacy themes; retain accessibility tests.
- tests/company-design-delivery.test.ts - add - Authorized company assignment, exact theme revision/scope, revocation, safe rollback and customer inability to mint an approved theme.
- F:/Diomedes/diomedes-site/public/tools/start-diomedes-design.cmd - remove from future public distribution as a proposed site change; do not execute or delete it during discovery.
- F:/Diomedes/diomedes-site/src/pages/docs/releases.astro, F:/Diomedes/diomedes-site/src/content/docs/development.md and F:/Diomedes/diomedes-site/src/data/serviceScope.ts - edit in a separate site worktree - Replace current self-service instructions with company-delivered design scope; label historical behavior accurately and remove current launcher links.
- F:/Diomedes/diomedes-site/src/data/status.json - edit if it advertises self-service authoring - Align availability only after the corrected customer artifact is qualified; never claim deployment from source edits.

Acceptance: neither free nor paid customer owners can open/preview/save/import/publish custom designs or re-enable the editor through the old launcher/flag. Staff can deliver a scoped approved revision; every customer retains readable text, reduced motion and safe reset. Test an upgrade from an existing theme, plus the public download instructions and actual corrected artifact when publication is separately authorized.

### 3.22 ai-service-entitlements (OS20) - product access is separate from a provider account

**Settled versus open.** Andrew explicitly wants his internal Nectovia/Claude use and does not want a nonpaying customer to gain that same access. Record free-customer direct Claude use as denied. The exact paid plans, trial treatment, offline grace and other service entitlements remain policy inputs; do not invent prices or infer that every paid subscription enables every route. An allowed customer-service name is a candidate in the product catalogue, not a grant to use it.

Current EngineService.selection (server/engines/service.ts:1225-1263) checks binding, provider account, compatibility, freshness and listed model. The conversation path at server/app.ts:4091-4125 checks supported route, enabled setting and selected model/account. These are necessary connection checks, not a Nectovia subscription rule. The separate ManagedGateway distinguishes identity, policy, payer and managed allowance: server/managed-gateway.ts:163-172 admits local/BYO payer paths without a managed reservation, while its managed-entitlement requirement appears at line 196. Do not repurpose managedInference or possession of a Claude subscription as proof of the new product-access right. This inspection does not claim to have run a free account against a live provider; it identifies the new policy and its required common enforcement.

Proposed capability decisions should name purpose as well as service: customer tier inference, direct conversation service selection, task/work execution, delegates, automation, connection test and internal diagnostic operation. A company-internal build and verified operator may expose direct Claude testing; a shipping customer build consults the customer's current product grant and then the usual connection/data/mode/budget checks. Customer organization ownership, Technical detail, a model pin, an imported agent profile, an owner testing override or a provider's native sign-in cannot confer the grant.

The UI uses the host's projected allowed choices. A free customer sees allowed tiers and a plain unavailable/plan explanation where relevant, not a selectable direct Claude route. If a paid plan grants a direct service, offer only that plan's approved, surface-supported choices. Mode remains independent. On the host, check selection and check again at each new dispatch/resume/delegate/test admission so stale UI or an existing thread cannot retain revoked access. Do not reroute a refused call to another payer or silently erase its history. Finish/recovery behavior for an already admitted uncertain effect must preserve the existing transaction/replay contract; changing a plan must not replay it.

Company-funded requests also require verification at the company-controlled gateway; changing a local client cannot grant company-funded capacity. Keep native customer provider sign-in and payer identity separate from product licensing. This is enforcement of Nectovia's supported routes and company service, not ownership of the customer's standalone Claude/Codex tools.

Edit / add / remove list:

- shared/ai-service-access.ts - add - Versioned purpose/service product-access decisions and refusal reasons, separate from route readiness and build capability ceilings.
- server/ai-service-access.ts - add - Resolve current verified principal, plan/entitlement and company-operator context; compose build, product, organization and surface policy. Default unknown/revoked access to refusal for restricted features.
- services/control-plane/contract/contract.ts - edit - Add the named product capability/grant contract and expiry/revocation semantics; do not create another identity, membership or operational record store.
- server/app.ts - edit - Enforce at model/tier selection, conversation send, Build/Fix/work admission and connection-test entry points. Client-supplied engine/default/pin/profile choices remain requests only.
- server/harness/host.ts and server/engines/service.ts - edit - Carry admitted product access through dispatch and recheck before new external operations so non-HTTP workers cannot bypass the rule.
- server/team/service.ts and server/automation-scheduler.ts - edit - Bind delegates/automation to the same current access policy; inherit only permitted service scope.
- server/managed-gateway.ts - edit - Compose product access ahead of relevant managed/BYO admission while preserving existing payer, membership, disclosure, hold and recovery semantics.
- client/AISetup.tsx, client/TierSetup.tsx, client/console/Picker.tsx and client/console/WorkStylePicker.tsx - edit - Use host-authorized choices; remove customer owner-testing controls and stale blanket "Use as default" affordances.
- tests/ai-service-access.test.ts - add - Free, allowed-paid, disallowed-paid, internal operator, revoked/expired/unknown and wrong-organization cases across supported purposes.
- tests/ai-service-access-routes.test.ts - add - Raw selection/send/test calls, settings pins, imported profiles, delegates, automation and replay after revocation cannot bypass product policy; provider spy proves zero denied dispatches.
- tests/managed-gateway.test.ts, tests/ai-setup-api.test.ts and tests/work-style-home.test.ts - edit - Product grant does not replace connection readiness, managed funding or history consent.
- Remove implicit customer authority from an installed adapter, signed-in provider or local On setting. Do not delete the adapter or old route records.

Acceptance: internal Andrew/company use can select Claude; a synthetic free customer cannot select or dispatch it through any exposed entry point, even when the native Claude connection is ready. An explicitly granted paid customer works only within its plan and surface scope. Verify revocation, reconnect, work continuation, zero denied provider calls and unchanged mode/data authority. Existing native/managed tests alone do not establish this product entitlement.

## 4. Proposed worktrees and release sequence

Every path below is under F:/Diomedes/diomedes-wt/. Every branch is feature/<name>. These are proposed implementation lanes, not branches created by this audit. OS numbers are proposed package IDs. File counts include focused tests/docs, count repeated hot files in each lane, and are planning ranges; line counts are rough changed/new lines, not measured diffs.

| Order / lane | Branch and absolute worktree | Scope | Prerequisites | Size | Safe prerequisite subset |
|---|---|---|---|---|---|
| 1. OS01 task-priority | feature/task-priority; F:/Diomedes/diomedes-wt/task-priority | Durable priority/due, shared list ordering, Console controls | C00 contract ownership; H07/H21 accepted current interfaces; due/fairness decisions below | 35-50 files; 1,500-2,600 lines | Pure comparator, strict intent/receipt contract and migration fixtures; local Console delivery can exclude hosted authority, source sync and preemption explicitly. |
| 2. OS02 people-assignments | feature/people-assignments; F:/Diomedes/diomedes-wt/people-assignments | Assignee/actor distinction, roster binding, AI/person eligibility | OS01 contract; PB01/B03 identity seam; H14 team contract | 30-45 files; 1,800-3,000 lines | Discriminated assignee and legacy migration with clearly local fixture records; no claim of signed-in staff until B03/OS04/OS05. |
| 3. OS03 organization-projects | feature/organization-projects; F:/Diomedes/diomedes-wt/organization-projects | Host folder provisioning and organization project binding | MI00 additive boundary note; B03/PB01 | 10-16 files; 700-1,300 lines | Scoped DTO and pure binding validation; no remote filesystem command. |
| 4. OS04 owner-access | feature/owner-access; F:/Diomedes/diomedes-wt/owner-access | Permission v2, compatible revisions, Manager/Employee templates, verified principal, editor | B01-B03/PB01; OS02/OS03 contracts; D9 defaults | 22-35 files; 1,700-3,000 lines | Pure v2 evaluator/migration and offline negative matrix, preserving v1 authority exactly. Hosted enforcement waits for accepted B03. |
| 5. OS05 owner-device-api | feature/owner-device-api; F:/Diomedes/diomedes-wt/owner-device-api | MI01 transport extension and filtered operational DTOs | MI01 transport design, B02/B03, H12; OS03/OS04 | 18-30 files; 1,600-2,800 lines | DTO/authorizer handlers with explicit fixture principals; no assertion of production sign-in or reachable business host. |
| 6. OS09 task-completion | feature/task-completion; F:/Diomedes/diomedes-wt/task-completion | Rule/report/submitted/review and all completion gates | OS02/OS04 contracts; H17/H21; rule/signature decisions | 30-45 files; 2,000-3,600 lines | Pure human report validation and finish truth table; local service fixture can qualify note/checklist/quantity before photos. |
| 7. OS10 project-photo-uploads | feature/project-photo-uploads; F:/Diomedes/diomedes-wt/project-photo-uploads | Authenticated phone Files ingress and exact report attachments | OS05/OS09; P05/P06, H12; format/metadata decisions | 14-22 files; 1,100-2,000 lines | Byte validation, attachment identity and recorded-write recovery under synthetic principals. |
| 8. OS11 people-messages | feature/people-messages; F:/Diomedes/diomedes-wt/people-messages | Private human inbox and scoped bot invitation | OS02/OS04/OS05; org aggregate contract; OS07 for bot context | 16-25 files; 1,600-2,800 lines | Deterministic message/participant/cursor service without bot, external delivery or retention deletion. |
| 9. OS07 contextual-chat | feature/contextual-chat; F:/Diomedes/diomedes-wt/contextual-chat | Scoped tile/record context through existing conversation admission | OS04/OS05; CD01/CD03/CD05, H11/H18; OS06 descriptor for tile context | 14-24 files; 900-1,700 lines | Typed task/record context resolver and denial tests; tile navigation can wait for OS06. |
| 10. OS06 pack-tiles | feature/pack-tiles; F:/Diomedes/diomedes-wt/pack-tiles | Versioned Owner descriptors and native/connector views | P01/P03/P04 amendment; OS03/OS04 contracts | 14-22 files; 900-1,600 lines | Declarative schema/index and labeled synthetic source fixtures; no new runtime or grants. |
| 11. OS08 owner-surface | feature/owner-surface; F:/Diomedes/diomedes-wt/owner-surface | General device shell composed around real services | MI04 accepted client seam; OS05/OS06; OS02/OS04; OS07/OS09/OS11 for full release | 20-32 files; 2,000-3,800 lines | Responsive fixture shell and task-priority UI may proceed; disabled unavailable services cannot be labeled implemented. |
| Separate OS12a/b automation-admission | feature/automation-admission; F:/Diomedes/diomedes-wt/automation-admission | a: origin classification; b: shared capacity/preemption | H01/H07/H08/H12/H13/H14/H21 and Automations contracts; OS01; capacity decision before b | 25-40 files; 1,400-3,200 lines | a can land without b. b must freeze claim/effect/recovery protocols and supported routes first. |
| Conditional OS13 source-priority-sync | feature/source-priority-sync; F:/Diomedes/diomedes-wt/source-priority-sync | One named PM priority mapping/authority | Customer source selection; OS01/OS05; connector/Trust acceptance | 8-16 files; 800-1,800 lines plus vendor integration | Pure fixture mapping/reconciliation; no live connector claim. |
| Last OS14 owner-device-qualification | feature/owner-device-qualification; F:/Diomedes/diomedes-wt/owner-device-qualification | End-to-end boundary, recovery, actual devices and rehearsal | Full delivered Owner set; MI07/MI08/MI09 and H17 evidence | 8-14 files; 1,000-2,200 lines plus external evidence | Deterministic multi-principal/browser tests; actual device/host/Aaron/novice rows stay open until performed. |

Customer repair lanes added by Andrew's follow-up (owner: Andrew; implementation assignee to be recorded when claimed). These are proposed branches/paths, not additional created worktrees or reserved package IDs:

| Lane | Branch and absolute worktree | Scope | Prerequisites / overlap | Rough size | Safe prerequisite subset |
|---|---|---|---|---|---|
| OS15 customer-ai-connections | feature/customer-ai-connections; F:/Diomedes/diomedes-wt/customer-ai-connections | Curated customer services across Projects/Settings/onboarding; exclude internal runtimes, probe jargon and unsupported Zen claims | Current discovery; OS18 build policy and OS20 access projection for release; coordinate nectovia-desktop-setup/provider-routing-audit | 13-17 files; 400-900 lines | Catalogue/projection and deterministic tests; release still needs host policy, not just hidden rows. |
| OS16 conversation-ai-switching | feature/conversation-ai-switching; F:/Diomedes/diomedes-wt/conversation-ai-switching | Projects-page tier/draft handoff plus authorized per-conversation service choice and setup return | Current H03/CD01/CD05; OS18/OS20 before exposing direct choice; coordinate OS15/provider-routing-audit | 20-26 files; 900-1,900 lines | Customer tier handoff and policy-aware scripted tests; internal/live-provider acceptance separately recorded. |
| OS17 project-folder-chooser | feature/project-folder-chooser; F:/Diomedes/diomedes-wt/project-folder-chooser | Keep in-app chooser; add Drive and breadcrumbs; replace Up; correct empty/error/cancel behavior | Existing local path authority; coordinate client/App.tsx with OS16; keep OS05 remote ingress excluded | 8-10 files; 350-850 lines | Typed listing and controlled-drive UI tests; real Windows drive behavior remains an installed-app check. |

At the follow-up snapshot provider-routing-audit is registered at 90f23fa and clean; nectovia-desktop-setup is at 2a44687 with untracked evidence/codex-setup-schema/. These are overlap signals, not proof that either lane is idle or owns these fixes. Recheck their current claims before assigning a builder. No other worktree was edited, created or repurposed for the three findings. OS15-OS17 can ship as separate customer repairs without waiting for the entire Owner Surface; the existing OS01/OS02 product priority is unchanged. Sequence their shared-file edits, not simultaneous writers.

OS06's schema can be reviewed before OS07 despite the product presentation order. OS11's private human service can precede OS07, but bot invitation cannot. OS08's shell can be prepared against frozen DTO fixtures while APIs are implemented; its production release depends on accepted services. This is not a circular dependency.

Task priority and assignments stay first. Follow with access and completion, then messages/context/tiles/shell, as the revised ADR requests. Authentication/host work can proceed as a prerequisite lane without blocking the first bounded local priority improvement. Run-class provenance may be a separate early subset; cross-route preemption must not become an accidental prerequisite to a priority control.

The charter's safe-subset rule requires a written contract revision, exact input/output types, consumer paths, evidence and explicit exclusions, reviewed independently on the composed candidate. A fixture, current-main implementation or report is not acceptance of an open full prompt. No delegation or reviewer run was performed here.

Serialize shared/types.ts, shared/business-access.ts, shared/harness.ts, server/app.ts, server/store.ts, server/workspaces.ts and client/console/Shell.tsx. OS01 defines Task intent/version conventions; OS02 extends them; OS09 extends the same gate. OS04 owns permission migrations. OS05 owns the remote ingress composition. Do not let each lane invent receipts, person IDs, aggregate stores or an independent task writer.

The latest product-boundary additions extend the proposed list (owner: Andrew; implementation owners assigned only when claimed):

| Lane | Branch and absolute worktree | Scope | Prerequisites / sequencing | Rough size | Safe prerequisite subset |
|---|---|---|---|---|---|
| OS18 internal-customer-builds | feature/internal-customer-builds; F:/Diomedes/diomedes-wt/internal-customer-builds | Edition capability contract, packaging exclusion, isolated app/profile/session/update identities | Freeze C00 build/capability contract; reuse B02/B03 for company operator identity; shared gates for OS15/OS16/OS19/OS20 | 13-18 files; 600-1,400 lines | Build profile and separate artifacts/negative customer tests; no paid-access claim until OS20's authority exists. |
| OS19 company-design-delivery | feature/company-design-delivery; F:/Diomedes/diomedes-wt/company-design-delivery | Remove all customer design authoring; internal company tools and approved-theme delivery; preserve accessibility/legacy appearance | OS18; company operator identity and scoped assignment contract; retain customization-benefit ledger | 14-20 app files; 650-1,500 lines, plus 4-6 site files | Customer authoring restriction, retained approved look/accessibility; end-to-end company delivery separately accepted. |
| OS19 site companion | feature/company-design-delivery; F:/Diomedes/diomedes-site-wt/company-design-delivery | Current public design instructions/downloads and accurate company-delivered scope | Exact corrected customer artifact; coordinate site owner and release before publication | 4-6 files; 80-220 lines | Proposed source copy/asset changes; no live-site claim or historical release rewrite. |
| OS20 ai-service-entitlements | feature/ai-service-entitlements; F:/Diomedes/diomedes-wt/ai-service-entitlements | Principal/plan/purpose/service rights at every new provider admission; free Claude denial, explicit internal/paid grants | OS18 build ceiling; B00/B01/B02/B03/PB03 contracts and actual entitlement resolver; freeze paid-plan matrix | 14-20 files; 800-1,800 lines | Pure denial matrix and host-controlled fixture coverage; real account/provider proof stays unaccepted until performed. |

OS15 and OS16 own their presentation/handoff changes. OS18 owns build policy, OS19 owns design authoring/delivery, and OS20 owns AI product access. Serialize their shared client/App.tsx, client/Settings.tsx, server/app.ts and packaging edits. Restricted customer defaults and accessibility can be tested early; never ship unrestricted direct-service UI ahead of the host checks. A permanent fork is an evaluated alternative, not a fourth implementation to start during discovery.

## 5. Conflicts and escalations

### Company controls, customer rights and the proposed fork

Andrew's latest direction overrides prior self-service design guidance and the earlier OS16 blanket owner/expert exception. Local models may remain an internal/product capability without making every runtime a customer service. Keep core accessibility available. The old customization policy and website launcher are current implementation/copy to amend, not reasons to reject the new scope. The three canonical mirrors remain at Pillars 2026-09-22.1, Roadmap 2026-09-25.1 and Project Memory 2026-09-25.1; propose synchronized amendments for company-only authoring, curated services and edition/access distinctions. No cloud or mirror write was performed in this report-only task.

Open policy questions for the eventual contract: which paid plans/purposes permit direct Claude/Codex/OpenCode/Cursor/Devin use; whether trials receive any such grant; the offline expiry/grace policy; whether customers may select among company-approved looks or only receive an assigned revision; and whether a long-lived fork is desired despite the shared-source two-edition recommendation. These do not block documenting the settled constraints: no free-customer direct Claude access, no customer design authoring, and no internal-runtime entries in the customer service catalogue. Zen is approved as a category, not verified as an implemented route.

### Operational authority is fixed; the extension must name its owner

MI00 already selects a governed business host with existing operational Store/History and a recorded stock authority (docs/architecture/mobile-inventory-boundary.md:13-38). Account SQL owns verified identity, organizations, memberships, sessions/invitations, commercial and funding records. Its funded job/run references do not make it the operational Task store. Workspace registry currently owns local fixture identity and access profiles (server/workspaces.ts:158-206); project state is separate (server/store.ts:457-510,776).

Nearest workable design: extend the governed host's durable operational boundary to organization roster, private human threads and completion policy, with project-bound tasks/reports/Files. The account service continues to attest membership; a single selected policy owner serves current capability decisions through B03. A derived hosted read model can be rebuilt and revoked; it cannot originate authoritative task transitions.

The proposed organization aggregate lives beneath the governed host's existing Store data root (for example organizations/<opaque-org-id>/state.json), with a strict schema, journal/recovery and the same authenticated command authority. This is a new record family owned by that host, not a task replica or a second accounts store. References to project tasks must include project ID and expected revision; membership/assignment changes are rechecked under the effect lock. OS03 freezes the persistence interface before OS09/OS11 consume it.

Owner question: for the first business installation, who operates the governed host and its backup/availability, and which accepted MI01 host transport will OS05 consume? This asks for deployment selection within MI00, not permission to create a second cloud Task database.

### Access v2 is a migration and row-policy change, not only new strings

Evidence: immutable AccessProfile revisions and pinned AccessAssignment at shared/business-access.ts:143-173; Owner bootstrap server/workspaces.ts:314-383; authorization scopes cover resource ancestry, not "task.assignee equals this person" (shared/business-access.ts:324-336,375-407). Project-only scope cannot safely express D9's own-assignment access by itself. Messages additionally require participant checks even for an Owner.

Nearest workable design: use explicit own/all task permissions plus host-side assignee predicates, and participant-only message access. Reassignment must atomically affect discovery/read scope; adding a person to a Project must not automatically reveal everyone else's task/report. Seed Manager/Employee as custom profiles, retain owner/admin/member membership roles, and explicitly exclude human-only permissions from worker ceilings.

Owner question: does "projects they touch" give employees all ordinary project Files, only assignment-linked Files, or a selected project folder scope? D9 does not settle that data boundary. Existing Owner system permissions must not bypass private-message participation.

### Ready and automation capacity overlap asymmetrically

Ready planner caps its own admissions at global=2/perProject=1, including all active sessions supplied by ReadyScheduler (shared/ready-queue.ts:28,169-207; server/ready-scheduler.ts:192,227-238). Automation admission checks only the target project's active sessions before bridge.start (server/automations.ts:1097-1141). It does not call planReadyQueue or its global limiter. Thus an automation consumes the capacity Ready observes, but automation admission is not governed by that shared global claim protocol.

There is no preempt-at-safe-point contract in server/execution.ts: it resolves execution policy/routing, not a universal resumable checkpoint. Existing RunService/adapter controls, stops and uncertain effects have route-specific meanings. Task waiting may mean approval or a human response; it is not proof that an external process paused safely. An in-flight non-idempotent effect cannot be replayed merely to free a slot.

Nearest workable sequence: persist admitted origin; define one shared atomic capacity owner; implement only proven pause/resume routes; surface unsupported pause as waiting for current work to finish. Preserve unresolved effects and funding holds through recovery. Do not add an independent automation executor.

Owner questions: should manual, Ready and automation starts all share one capacity limit? If yes, is urgent work allowed to interrupt only routes with proven resumable checkpoints, with all others finishing their current run? What fairness/aging rule prevents continuous priority-1 work from starving automations?

### One sort does not describe every projection

Evidence: Ready uses least-recently-served project order then readyAt/createdAt/task ID; plan progress uses plan-step order (shared/ready-queue.ts:162-209; client/console/board-model.ts:125; client/console/progress-bars.ts:68). History and message order are chronological. Source priority could also have fewer/different levels.

Nearest workable design: one priority comparator for actionable work lists, with explicit scheduler fairness and plan/history exceptions. Recheck priority at admission; do not rewrite existing claims or receipt identities.

Owner questions: is priority first only within each fair project line, or should it override cross-project fairness? Is due a date in the organization's timezone or a precise instant? How should undated tasks compare? Are the words Today/This week labels only, even when an older task retains that level past the named period?

### Human completion and AI verification have different evidence

Evidence: H17's strict check kinds/digest/run/session evidence and projected verification (shared/verification.ts:46-145,305-399); current done paths in section 3.9; D11 requires signature but stores none. CompletionRule also lacks rule identity/version and precise quantity semantics.

Nearest workable design: sibling human rule/report with immutable versions; one task completion gate; separate displayed facts for run finished, result verified, employee submitted and manager accepted. Same Task may carry both AI acceptance and human completion without one satisfying the other. Default rules apply by explicit precedence; pin the effective rule at submission and record what acceptance judged.

Owner questions: do changes to a rule apply to work already assigned or only future work? If required photos change after acceptance, does the task reopen, show stale evidence, or retain acceptance of the old recorded version? What does signature mean here: an authenticated acknowledgement, drawn mark or a separately specified signing process? May a manager accept their own submission? What unit, scale and target define quantity?

### Human messages cannot be made private by hiding them

Evidence: MailboxMessage addresses Slot and has shutdown control kinds; its read flag is not per participant. TeamService wakes recipients at server/team/service.ts:366-424. Conversation owns model turns/lineages, not a private human group membership protocol. D10 permits context links but a task thread may be visible to more people than the message.

Nearest workable design: separate private human aggregate, scoped links that do not disclose the message on a public project thread, explicit participant queries, deterministic no-model sends. Bot invitation is a new retrieval/egress decision under the inviter's current authority and the permitted shared context, not a bypass of other participants' privacy.

Owner questions: when a message is attached to a project, is only its link visible there to its participants, or is the author explicitly publishing a copy? Does inviting the bot share earlier private messages, only newly selected messages, or just future messages? What retention policy applies without destroying protected operational evidence? The repository forbids a blunt History-pruning switch (AGENTS.md decision 10).

### Phone photos require a new named ingress, not a new file authority

Evidence: local file-drops raw-body route, MIME sniffing and recorded writer; MI inventory receipt routes are bounded JSON receive/status/view routes (server/inventory/receipt-routes.ts:1-99). No current inventory camera upload exists. FileRecord lacks org/project scope and is a before/after History entry (shared/types.ts:418-427).

Nearest workable design: a separate authenticated upload capability that uses the same writer and resolves exact versioned bytes. Pending upload and submission remain distinct receipts; an uncertain upload cannot be silently repeated as a new effect.

Owner questions: must the first release accept HEIC, and should location/EXIF metadata be retained or stripped before recording? Should a photo be visible to everyone who can see the Project, or only the task/report audience? These choices affect ingestion and access, not just preview UI.

### Project and workforce words do not settle identity

Project.folder is required; Git is optional (shared/types.ts:130-150). Store.createProject creates a folder (server/store.ts:880-930). A phone need not use the founder's desktop: a governed organization host can allocate that folder. A folderless new Project would require a larger storage abstraction than D6 proposes.

WorkforceWorker is a pure validated source record with qualifications, availability and prior minutes. It has no persisted directory/login linkage (shared/workforce.ts:1-12,99-110). Preserve its source ID and explicitly bind it to the member; do not equate job qualification with access role or planned hours with paid hours.

Owner question: which source provides authoritative paid hours for the first business, and is D6's People tile showing scheduled, reported, approved or paid time? Until answered, show only labeled source facts or omit that metric.

### Pack activation and shell policy need an additive amendment

Current pack schemas permit four Console affordance surfaces and project-scoped activation (shared/capability-packs.ts:47-52,145-162; shared/pack-manifest.ts:126-131). P01/P04 forbid a pack-defined second shell or runtime. D1 authorizes a Core-owned device surface; this discovery need not ask Andrew to approve that direction again. The implementation must amend those documents and standing Console-only wording to describe this scoped exception, while leaving the desktop Console as the only desktop shell.

Nearest workable design: core navigation/permissions; packs supply validated declarative tiles and labels, not executable UI or visibility authority. D2 roles is at most a UI hint; server permission/resource/participant checks decide disclosure.

Owner question: if an organization has Projects with different active pack revisions, should its navigation show their union with project selection, or require an explicit organization-level pack configuration? Today's code has no organization-wide activation record to answer this.

### Local-only includes metadata and history

A hosted tile, notification, photo or bot context is an egress even without model inference. Organization processing='local-only' does not authorize cloud copies of titles/counts by implication. Current route sharing and history grants are deliberate (docs/product/2026-09-23-home-history-sharing.md:31-48; server/cloud-sharing.ts).

Nearest workable design: disclose only policy-allowed DTOs through the selected transport, resolve visible references on the host and preserve route-specific history consent. Reusing a conversation must retain lineage scope/digest retirement and refuse duplicate dispatch after uncertain responses.

Owner question: for local-only organizations, which operational metadata may be relayed or cached outside the governed host, if any? A local model does not answer that deployment question.

## 6. Answers to the ADR's section 6

1. **Where records live.** MI00 already fixes the operational owner. Account SQL holds verified person/membership/session and commercial/funding state. Tasks/reports/project Files remain under the governed operational host. Put organization-level people bindings, completion defaults and private message aggregates under that same selected operational owner, with stable references rather than copies in every Project. Fine-grained access currently lives in the workspace registry; B03 must explicitly bridge its single policy owner to verified account membership. Do not sync a writable desktop Task mirror into account SQL.

2. **Can both message kinds share a store?** They can share low-level durable storage utilities, backups and a governed host. They should not share MailboxMessage records, endpoints, read flags or wake/shutdown dispatch. Human mail requires participant-private access and per-person cursors. AI mail is operational control data. A discriminated envelope alone does not supply those missing controls.

3. **Which open prompts already cover D9-D11?** B01 owns accounts, B02 sign-in, B03 tenancy/membership, MI01 authenticated operational ingress, MI04 shared device UI, MI05 device camera/scanning concerns, MI06 views, MI07 integration and MI08/09 qualification/rehearsal. H12 owns effect authorization, H17 AI evidence verification and H21 migration/recovery. P05/P06 own Files/recorded review; CD01/03/05 own conversation authority/context/UI; CD10 external communications is adjacent. PB01-04 cover identity/configuration/usage/integration foundations in their separate repository package; they are not four nodes among the 152 open unified nodes. None supplies private human messages or the human completion workflow in full.

4. **First remodeling connector.** Owner/customer decision. The code cannot identify Aaron's boss's PM/inventory source, site count or supported API. Existing fixtures and the newly landed fictional remodeling/cabinetry files are useful offline proof material, not customer integrations. What source and first read/write operation has the customer selected?

5. **Priority authority.** Owner/customer decision per linked task/source. If the source owns priority, Diomedes submits a conditional source change and projects the confirmed result; if Diomedes owns it, record that authority and treat the external field as an explicit export/mapping. Lossy mappings need conflict handling. Which system is authoritative, and what happens when both are edited before reconciliation? "Both ways" alone does not settle this.

6. **Product name.** The desktop display name is already Nectovia (docs/product/2026-09-22-nectovia-skin.md:10). The code's shared product/agent naming contract should be reused. The Owner client may use Nectovia without a separate brand; the distinguishing visible label for its Console remains Andrew's decision. What label should a user see when switching between operational and technical views?

## 7. Package impact - proposed edits only

Do not mark the 152 open nodes DONE from this report. Current main is materially newer than the 2026-09-23 status snapshot; reconcile exact merged implementation, required tests and accepted review before scheduling existing prompts. Do not restart H17, H21, pack loading, business profiles or inventory receipts from scratch simply because their full package nodes remain open.

| Existing prompt/package | Proposed impact |
|---|---|
| C00 / shared CHARTER | Freeze additive Task/actor/access-v2/Owner API revisions and exact consumers. Register ownership of hot files and one composed candidate per review. |
| MI00 (DONE) | Preserve accepted prompt/evidence and inventory contract. Add a successor architecture note for new operational record families; do not reopen DONE or silently expand old acceptance. |
| B01 | Consume existing account service/SQL; add only selected operational-host/policy references. No Task/report/message tables in account SQL. |
| B02 | Add actual Owner web sign-in/session integration and shared-device transitions alongside existing native identity requirements. A JWT verifier alone is not a login experience. |
| B03 | Establish verified-person-to-operational-policy bridge, current membership/generations and row/participant checks. Local fixture state never becomes hosted authority automatically. |
| PB01 | Cross-link existing Personal/Business membership and questionnaire semantics; Owner employees join existing setup and do not repeat business discovery. |
| PB02 | Reuse configuration activation, provenance and expected-base checks for default profiles/rules/tiles; activation never grants authority. |
| PB03 | Reuse funding/payer/cap boundaries for optional bot work; deterministic assignment/report/message actions do not consume model requests. No commercial price changes. |
| PB04 | Extend integration handoff with actual Owner identity/service/UI evidence and explicit unavailable hosted boundaries. |
| MI01 | Extend the named capability list only after transport acceptance; keep original inventory authorization matrices. OS05/OS10 reuse this ingress. |
| MI02/MI03 | Preserve inventory domain and deterministic receipt/effect semantics; Owner tiles read the selected authority, not a second stock ledger. |
| MI04 | Integrate inventory screens into one Owner device client, retaining its pending-operation recovery and original device requirements. |
| MI05 | Reuse barcode/scoped camera lifecycle work where accepted; photo upload is OS10 and does not count as inventory scanning completion. |
| MI06 | Add authorized inventory tile composition; keep source/freshness/version semantics. |
| MI07 | Compose accepted ingress/domain/client/scanning/view changes; add Owner integration only as explicit new acceptance rows, not an implicit milestone rewrite. |
| MI08/MI09 | Original qualification/rehearsal stays intact; OS14 adds roles/assignment/completion/private mail journeys and named device proof. |
| H01/H07/H08 | Amend ordering/classification/capacity/control contracts through OS01/OS12; no generic pause guarantee. |
| H09/H11/H18 | Preserve actual Agent identity, rules and bounded context when Owner/bot requests select a route. No employee-owned arbitrary prompt becomes policy. |
| H12/H13/H14 | Enforce person scope at dispatch/effect and through delegates; preserve team worker isolation, exact approvals and uncertainty recovery. |
| H17 | Preserve four-state run verification; add OS09 interoperability tests and shared finish gate, not a silent redefinition of Verified. |
| H19/H21 | Owner/core cross-links, versioned migration and performance/restart coverage; do not resurrect Workbook. |
| P01/P03/P04 | Explicitly version declarative Owner tile contribution schema, activation scope and lazy digest-pinned loads. Preserve no runtime/authority from packs. |
| P05/P06 | OS10 authenticated ingress and report-linked exact versions reuse Files/write/review; reports are not raw FileRecord arrays. |
| P10 / DEMO-03.PREP | Reuse labeled approved-file examples and pure workforce constraints; neither is a production staff directory/source connector. |
| CD01/CD03/CD05 | Reuse conversational admission, selected context, lineage/replay and disclosure; Owner chat is another client of these contracts. |
| CD08 | Reuse the existing automation occurrence/runtime ownership. OS12 does not add a scheduler per surface. |
| CD09 / B06-B07 | Use existing organization funding reservations and uncertainty handling for bot calls; priority cannot bypass budget. |
| CD10 | Preserve external-channel scope; reference OS11 as separate internal human communications, not completion of outbound-channel work. |

Add paired implementation/review nodes for OS01 through OS20, with OS12a/OS12b separate acceptance checkpoints or separate IDs if package conventions require. These labels are proposals, not reserved node IDs or filenames. Place OS01's bounded subset first, OS02 next. Wire the remaining dependency edges from section 4. Every implementation node depends on its required accepted contract/subset; every review node binds the exact composed commit and independent evidence. A UI fixture may run ahead of the hosted lane only with the charter's exclusions recorded. OS09 and OS11 may add service/fixture client components before OS08 assembles the final shell; creating those components is not a second shipping client.

OS15-OS20 need explicit repair/contract nodes and acceptance rows, not DONE claims for older prompts. Cross-link OS15 to discovery/setup and PB04/H19; OS16 to H03/CD01/CD05 and tier/home-sharing/lineage contracts; OS17 to Console project creation; OS18 to packaging/build identity/update isolation and B02/B03 operator identity; OS19 to existing customization/ThemePack/company design-benefit delivery and a separate site follow-up; OS20 to B00/B01/B02/B03/PB03 product entitlement and common dispatch policy. Reuse merged implementations. Amend both old extremes: mandatory tier-only internal use and a blanket owner/expert right to choose providers. The customer catalogue, effective product grant and connection readiness are separate. OS17 retains the existing folder menu with drives and named navigation.

Original MI sequence remains MI00 -> MI01(B03,H12), MI02 -> MI03(H12), MI04(MI01,MI03), MI05(MI04), MI06(MI01,MI03), MI07(MI04,MI05,MI06,FD02,FD03,FD04), MI08(MI07,H17), MI09(MI08). Owner scope adds nodes around it; it does not erase missing original dependencies.

When authorized to update the package, change RUN_ORDER.md, RUN_ORDER.json, MODEL_PROMPT_INDEX.md, node paths, relevant milestone/acceptance maps and checksums together. Preserve original books/verdicts/initial snapshots. Only after each exact implementation is merged and fully accepted should its own descriptive completed/ folder and coordination/completion-status.json move to DONE. PB prompt links remain under docs/product/personal-business/prompts unless deliberately brought into the unified package. No package file was changed here.

## 8. What the ADR got wrong - corrections for rev 5

The rev 4 input arrived during the follow-up and was re-read. Resolved earlier-draft criticisms are marked below; the remaining qualifications and new customer repairs still belong in the next revision.

1. **The revision/baseline mismatch was resolved during the audit.** Initially the prompt named rev 4/main 0.2.0 while the external ADR file said rev 3/v0.1.4. The closing re-read found rev 4 correctly pinned to 90f23fa/v0.2.0. Retain both hashes as provenance; do not ask a builder to fix that header again. D1-D11 exist in both inspected copies.

2. **Rev 4 corrects the Console description.** ShellView is Thread, Board, Team, Discovery, Readiness and Automations; Workbook was removed. Preserve that correction. Ledger remains work/Needs/recent evidence, not an AI-spend ledger (client/console/Ledger.tsx).

3. **Rev 4 correctly reuses access profiles.** D9 is a v2 catalogue/migration, default profiles, row predicates, editor and production-principal integration. Current client source still does not contain the claimed configurable profile editor; the existing service and immutable audit/revisions are not UI completion.

4. **Rev 4 correctly identifies workforce inputs, but they are not an employee authority.** WorkforceWorker is a validated preparatory scheduling record. Its qualification roles are not permission profiles; its minutes are not a paid-hours ledger; its ID is not automatically a Person.

5. **D3's one-authority wording is sound.** Rev 4 explicitly reuses the inventory rule. Keep it; do not restore the old connection-only rule or describe native inventory as an architectural violation. Local inventory authorization exists; the old rev 3 blanket absence-of-auth claim is superseded. The remote hosted boundary still needs acceptance.

6. **MI-DEMO is not wholly landed.** Receive/status UI and durable stock work exist; the ledger marks only MI00 fully DONE. client/inventory is a small local fixture entry, not the promised authenticated general PWA shell.

7. **A shared membership identity is not automatically wired into operational access.** Local WorkspaceService creates a development-fixture Person and resolves currentPerson. B03 must provide the verified binding. The client cannot supply a personId and thereby establish authority.

8. **Priority is more than a type and sort.** Strict command schemas, replay digests, defaults/migration, hidden string assumptions and actor-sensitive reopen/undo all change. Server PUT currently ignores Shell's assignedTo. Fix the actual mutation path.

9. **Rev 4 preserves fair project scheduling explicitly.** Its priority/due/readyAt ordering is within a project, while least-recently-served project fairness stays. Remaining work is to specify which other projections use priority/due and which retain plan-step or chronological order; do not reopen the settled queue scope by describing it as universal sorting.

10. **Automation's separate scheduler is real; a shared capacity/preemption system is not.** Ready counts automation sessions, while automation admission bypasses Ready's global limiter. There are HarnessRun, Session, TeamRun and direct-work paths, not one universal run object. Persist origin at admission and link projections.

11. **Keep run classification independent of Wake/useWake and createdBy.** This is an implementation guard retained from review of the earlier draft, not a new rev 4 claim. Wake/useWake animate the interface; AI-created tasks can require a person's work, and manually requested reusable jobs can enter automation. Origin and current assignee are different facts.

12. **Allowance is not queue or spend admission.** This guard is retained from earlier drafts; rev 4 does not require an allowance-based scheduler. Displayed quota/provider windows do not reserve money or enforce a daily burn limit. Reuse actual funding admission.

13. **H17 is relevant but not a drop-in report.** Its strict AI evidence contract should survive. Human submission/sign-off is a sibling contract connected through a common finish decision. A signature requirement with no signature field and a quantity without a unit are incomplete.

14. **FileRecord is not an upload reference.** Reports need scoped exact-version references and immutable evidence. Phone uploads require a named authenticated ingress, even though all writes still use Files.

15. **Private message attachment cannot mean publishing its body into a broader project thread.** Specify visibility and bot-history disclosure. Sharing one aggregate with AI mailbox would inherit inappropriate control/wake/read semantics.

16. **Pack ui affordances cannot already render these tiles.** Version both built-in/installable contracts and lazy indexes. Core owns the device shell and access enforcement; pack roles and askContext are untrusted presentation/data.

17. **The Console is unchanged in purpose, but its code is affected.** Task schema, assignment, submitted evidence, palette, Board, progress, undo and activity all require integration. Conversely, not every Task consumer needs editing: identity-only lookups and H17 readers can stay intact. Section 3 distinguishes these cases.

18. **Existing sample material should be reused.** PR #140 adds five unmistakably fictional businesses, including remodeling and cabinetry. Their text photo logs/messages are fixture files, not live upload/private-mail features. The reset starts with empty app data and does not seed authoritative Tasks.

19. **Hosted and local-only need an explicit disclosure policy.** Titles, counts, message bodies and photographs can leave the host without a model call. A local bot route alone does not settle hosted metadata storage.

20. **Customer setup is not a machine inventory.** LocalAI, unused Ollama and a proposed AionCore host currently appear as customer connection problems. OS15 removes that presentation and the ordinary dependency on optional diagnostic probes; a screenshot with a local username does not by itself prove a bundled founder profile.

21. **A default AI setting is not a conversation switch.** Provisioning, tier maps and explicit choices can keep a thread on AWS after Claude becomes the default. OS16 adds a discoverable scoped action only for authorized internal or explicitly entitled customer use, preserving consent/lineage; an owner-testing override is neither a normal switch nor a product-access grant.

22. **Choosing a project folder must work without typing its path.** The current menu has children and a parent but no drive catalogue. Andrew's latest instruction keeps that menu, adds Drive/breadcrumbs, and replaces Up with a named destination. OS17 does not need a new native dialog to satisfy that clarified request.

23. **The Projects page has its own missing choice.** Its landing composer carries text and Mode only. Adding a conversation picker does not add a Projects-page tier selector or preserve that choice during handoff. OS16 now covers both surfaces and honest handoff wording.

24. **An adapter registry is not a customer service catalogue.** oh-my-pi is currently in EXTERNAL_ENGINES and consequently appears beside customer services. The newer owner-approved list excludes it, Hermes, LocalAI supervisor, Ollama and proposed hosts. Go is implemented; Zen is acceptable in principle but not qualified by that Go adapter. Customer eligibility still requires a product grant.

25. **Customer ownership and a paid plan do not grant design-authoring rights under the new direction.** Existing paid customization/launch-flag rules and self-service site copy are superseded. Company staff deliver approved designs; accessibility remains available. OS19 must amend both the client and host gates, plus the current launcher instructions.

26. **A fork or development label is not a product boundary.** Prefer independently packaged internal/customer editions from shared source, with explicit feature ceilings, isolated identities/data and separate update eligibility. A persistent fork remains an owner choice, not work completed by this report.

27. **Provider sign-in, product access and funding are separate.** Internal Claude use must not enable a nonpaying customer. OS20 adds explicit product rights across all new admissions; the current managed allowance gate and an On checkbox do not answer that commercial question.

Report validation: all eight requested sections remain present. The expanded customer/build follow-up checked 66 distinct existing app edit targets, 21 proposed new app files and its numbered source references; no missing app target, pre-existing proposed-add path or out-of-range reference remained. Site targets were checked separately against the recorded origin/main. The input package hashes were unchanged at the previous closing check; the external ADR rev 3 -> rev 4 change and both hashes remain recorded above. The current discovery worktree contains only this untracked report and no tracked edits. The latest source/function probes used synthetic inputs only. No implementation, new feature worktree, fork, build, dependency install, commit, push, website/package mutation or customer contact occurred.

The report is complete as a discovery/work-order artifact. Proposed implementation, new tests, production identity/host availability, physical-device qualification and customer decisions remain unperformed. This audit does not mark a prompt DONE, implement a feature, publish a build or establish product acceptance.





