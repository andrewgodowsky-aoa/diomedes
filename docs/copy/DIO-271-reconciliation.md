# DIO-271 reconciliation with PR #253

Date: 2026-10-07
State: REQUIRED_LOCAL_GATES_PASSED, PROTECTED_BROWSER_TESTS_FAILED, NOT_PUBLISHED. Local review candidate only; not merge-ready. No independent acceptance, merge to main or deployment.

## Candidate

- Original PR #254: `9f4943cc07006d0b05e9e29a3abce7aba4bcd7bd`, `feature/voice-audit-copy`.
- Current main / merged PR #253: `24fe1e5c04ccb325d0b894dbc3589ed27f6ada69`.
- Common base: `bae249b60ffafa3934d775c6d59fbac80990a83e`.
- Integration branch: `feature/voice-audit-copy-reconcile`.
- Worktree: `F:/Diomedes/diomedes-wt/voice-audit-copy-reconcile`.
- [Work order](work-orders/DIO-271-reconciliation.md) and [bounded review ledger](ledger/DIO-271-reconciliation.md).

The original feature and validation worktrees were preserved. Main combined cleanly with the PR head. The sole changed-file overlap is `tests/phone-relay-desktop.test.ts`. Its Need and result assertions retain `source: { deviceId }`, and its History assertion retains `You approved from your phone`. Phone origin, exact decision, `decidedFrom: 'phone'`, `allowForTask: false`, deduplication and the already-answered refusal remain checked.

All six other files introduced by PR #253 match main's Git blobs: frame builders, relay protocol, hub, phone regression suite, surrogate regression suite and protocol documentation. No production code from either PR was changed during this reconciliation.

The composition check also confirms that 320 of PR #254's 321 changed files retain their original Git blobs. The shared test is exactly main's file with the single reviewed phone sentence substituted. The combined index tree before reconciliation-document edits is `2099845e7a8210c9bfe64dbebe7831b3e244d832`.

## Fresh validation

Only runs in this worktree count below. Historical 10,285 / 36 / 187 results remain in the original implementation report and are not reused as combined-tree evidence.

| Gate | Passed | Failed | Skipped | Unrun test cases in command |
|---|---:|---:|---:|---:|
| Focused root Vitest, 19 files | 358 | 0 | 0 | 0 |
| Full root Vitest, 608 files | 10286 | 0 | 5 | 0 |
| Focused control-plane Vitest, 12 files | 276 | 0 | 0 | 0 |
| Required ui/native-ui/field Playwright | 36 | 0 | 0 | 0 |
| Protected extended browser suites, unchanged | 22 | 4 | 0 | 0 |

App TypeScript, control-plane TypeScript and the fresh Vite build: PASS, exit 0. Vite emitted its asset chunk-size advisory. The browser invocation ran all five files together after the build and exited 1: 58 passed and 4 failed, with no skipped, unrun or flaky test cases and no runner errors. The table separates its required and protected files; it does not add historical runs. Steps after a failing assertion within a test were not exercised.

The control-plane run includes the six original copy suites (187 tests) plus all six relay suites (89 tests). Its relay SQL suite uses a recording client, not a real database. The focused root run includes 64 phone-relay tests. The extra root test compared with the original 10,285 count is PR #253's surrogate regression.

The five root skips remain explicit: one conversation-engine case, two process-table cases, the guarded 8.3 alias case, and the unsupported-console sign-in case. Their exact names are in `summary.json`; none is counted as passing.

Result sources: [root focused](../../test-results/reconciliation/root-focused.json), [root full](../../test-results/reconciliation/root-full.json), [control-plane focused](../../test-results/reconciliation/control-plane-focused.json), [browser](../../test-results/reconciliation/browser.json), [gate commands and exit codes](../../test-results/reconciliation/remaining-gates.json), and [summary with all failure details](../../test-results/reconciliation/summary.json). Corresponding `.log` files and browser traces are beside them.

Evidence directory: `test-results/reconciliation/` in the integration worktree. Logs and structured results remain local. Existing dependency installations are referenced through new junctions; no packages were installed. `RELEASE_SYNC=off` prevents unrelated release-record changes. All heavy commands are serialized under the pinned coordination tool's exclusive slot.

## Source identity and review

Before validation completed, 3,008 tracked files were hashed. Ordered source/test manifest SHA-256: `b1aaf30f0cc29d3459d04ce89f4e2a006873147d2cf17333ae1e982d86243b5f`. Full tracked manifest SHA-256 before documentation updates: `e114c0a89de88008378384cb371990c17ea670331e91a12e8e0d2b5410dd6391`. The source/test hash is identical after all gates. The two generated tracked browser screenshots were copied into `test-results/reconciliation/generated-screenshots/`, hashed separately, then restored to their original bytes. They are not part of the patch.

All 188 production files changed by DIO-271 are referenced by its existing ledgers. Source review found no additional overlap or new approval, billing or actor-attribution defect in the inspected paths. Display-masked structural checks and their limits are in the review ledger. This is the implementing session's bounded review, not an independent review of every path.

## Protected tests and remaining findings

The original [console test handoff](handoffs/console-tests.patch) has three unapplied wording hunks. Fresh execution found a fourth required hunk. The complete [reconciliation handoff](handoffs/DIO-271-reconciliation-protected-tests.patch) contains all four:

- Two diagram-error selectors in `tests/artifacts-ui.spec.ts`, owned by DIO-252 under `claim_mux69zuq_67519943`.
- The PDF-preview selector at line 161 and image-file alert selector at line 211 in `tests/files-attachments-ui.spec.ts`, owned by DIO-247-STACK under `claim_muxbtxwm_99270f88`.

Both claims were read live. They were not released, assumed stale or overridden. The protected tests ran unchanged. The four-hunk patch passes `git apply --check --unidiff-zero` on the combined tree but was not applied or tested as a repaired candidate. The original three-hunk handoff remains as historical evidence.

| Finding | Evidence | Required owner action |
|---|---|---|
| R1, P2: diagram selectors use the old error heading | `tests/artifacts-ui.spec.ts:1166` is shared by the failed cases starting at lines 1201, 1225 and 1256. Browser contexts show `Couldn't draw this diagram.` while the helper searches for `This diagram could not be drawn.`. The separate alternate-refusal selector at line 1125 also retains the old heading; that test passed through the drawing branch. Artifact suite: 22 passed, 3 failed. | Apply both diagram-selector hunks and rerun the suite. Keep all refusal, isolation and network assertions intact. |
| R2, P2: PDF preview assertion was omitted from the earlier handoff | `tests/files-attachments-ui.spec.ts:161` searches for `no in-app PDF viewer`; the captured page says `PDF preview is unavailable.` as recorded in the existing FilePreview ledger. This failure occurs before the known image-alert assertion at line 211. Attachment suite: 0 passed, 1 failed. | Apply the new PDF selector and existing image-alert hunk, then rerun the complete test. The later workbook, clipboard, attachment and historical-version steps remain unverified by this run. |

Protected source SHA-256 values remained unchanged: artifacts `17d912b6837b12213086fea20ae04d508b772895d1ba1fc1ec214b4969e7df30`; attachments `135e6f14fccf698f0ebd864cd8c902130a5b6efcd93ac9a673eb0052c5cff193`.

Fresh process checks found neither recorded owner PID nor a helper referring to either worktree. Both worktrees still contain other work: 43 changed paths in Design Center removal, including the protected artifact test, and one changed path in the long-context stack. Process absence was not treated as permission to release these evidence-bearing owners' claims.

The original protected/deferred source findings and other-workspace findings remain outside this bounded pass. DIO-271 is not DONE. No pillar, roadmap, completion or product-definition status was advanced. Canonical mirror versions read: 2026-10-06.1.

Unrun acceptance: the rest of the control-plane package, other app browser suites, real databases/providers, installed desktop/phone behavior, hosted CI and deployment. No independent reviewer verdict exists for this combined candidate.

## Publication and acceptance

No merge to main, deployment, desktop packaging, installation, live provider/database request or installed-phone acceptance is authorized by this task. GitHub Actions remains stopped. GitHub reported a successful Cloudflare Workers deployment for the original PR head; that external report is not acceptance of this candidate. A source push must not trigger deployment without the appropriate approval.

[Cloudflare Workers Builds documentation](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) describes the build and deploy commands run after a push. This session did not establish a safe branch-specific skip or change the integration configuration. A GitHub Actions skip marker alone is not verified protection against this Worker's deployment trigger.

Final remote drift readback still names main `24fe1e5c04ccb325d0b894dbc3589ed27f6ada69` and PR head `9f4943cc07006d0b05e9e29a3abce7aba4bcd7bd`. The local review candidate is committed under the owner's passing-checkpoint instruction; the known protected failures stay open. No code was pushed because the branch's deployment trigger has not been cleared or approved. PR #254 remains draft. The validation slot was released after all commands completed; protected claims remain held.

Commit message: `fix(copy): reconcile DIO-271 with relay attribution`

## Changed files relative to the original PR head

- `docs/implementation/2026-09-26-phone-relay-protocol.md`
- `server/relay/frames.ts`
- `services/control-plane/src/relay/hub-core.ts`
- `services/control-plane/src/relay/protocol.ts`
- `services/control-plane/tests/relay-phone.test.ts`
- `tests/phone-relay-desktop.test.ts`
- `tests/phone-relay-messages.test.ts`
- `docs/copy/DIO-271-implementation.md`
- `docs/copy/DIO-271-reconciliation.md`
- `docs/copy/ledger/DIO-271-reconciliation.md`
- `docs/copy/work-orders/DIO-271-reconciliation.md`
- `docs/copy/handoffs/DIO-271-reconciliation-protected-tests.patch`
