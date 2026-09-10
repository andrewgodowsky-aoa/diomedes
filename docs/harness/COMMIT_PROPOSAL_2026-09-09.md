# Proposed runtime commit (not made)

Message: `Prove the packaged Codex harness and preserve engine settings during navigation`

Branch: `codex/runtime-proof-20260909`; current base `11829e1962b448360d3fc7aaba7c38fda6833a84`.
The owned branch was fast-forwarded to existing remote documentation/license commits;
no new commit, amend or push was made. Local main remains `86ee91d`.

Trust source and tests match Opus commit `5f1c69c`; they were copied verbatim,
not cherry-picked. Preserve that attribution/history when approving integration.

Validated: 534 source tests across 21 files, 27 browser tests, type/client/Windows
build, a relocated package passing 11 checks with source unavailable, one prior
real native ChatGPT synthetic run, exact recorded application, and fresh-process
authority denial without redispatch. The Usage/settings race and a concurrency
test scheduling assumption were reproduced and corrected. Failed attempts remain
in the evidence. CI is prepared locally; no GitHub run is claimed.

The canonical roadmap and repository mirror are reconciled at 2026-09-09.5.
Package binaries, profiles and synthetic data under deliverables are excluded.
Planning cache/coordination notes are outside this repository. The evidence list
includes historical failed attempts, final manifests, logs and screenshots.

## Changed files

- `.github/workflows/build-test.yml`
- `AGENTS.md`
- `CLAUDE.md`
- `client/App.tsx`
- `client/Workspace.tsx`
- `client/components.tsx`
- `client/console/Shell.tsx`
- `docs/DIOMEDES_LIVE_ROADMAP.md`
- `docs/harness/CHANGES.md`
- `docs/harness/COMMIT_PROPOSAL_2026-09-09.md`
- `docs/harness/NR02_NR03_VERIFICATION_2026-09-09.md`
- `docs/harness/RUNTIME_VERIFICATION.md`
- `evidence/m1/ci-local-gates.log`
- `evidence/m1/console-exact-proposal.png`
- `evidence/m1/final-check.json`
- `evidence/m1/manifest.json`
- `evidence/m1/proof.json`
- `evidence/m1/regression-artifacts/approval-console-record.png`
- `evidence/m1/regression-artifacts/approval-workbook-preview.png`
- `evidence/m1/regression-artifacts/work-admission-workbook.png`
- `evidence/m1/roadmap-sync.json`
- `evidence/m1/unit.xml`
- `evidence/m1/usage-concurrent-green.log`
- `evidence/m1/usage-concurrent-red.log`
- `evidence/m1/usage-final-browser.log`
- `evidence/m1/usage-final-build.log`
- `evidence/m1/usage-final-tests.log`
- `evidence/m1/usage-package-smoke.log`
- `evidence/m1/usage-package-verified.log`
- `evidence/m1/usage-verified-tests.log`
- `evidence/m1/workbook-exact-proposal.png`
- `evidence/nr02/authority-recovery-check.log`
- `evidence/nr02/authority-recovery-green-final.log`
- `evidence/nr02/authority-recovery-green.log`
- `evidence/nr02/authority-recovery-red.log`
- `evidence/nr02/backend-recheck.log`
- `evidence/nr02/baseline-build.log`
- `evidence/nr02/baseline-check.log`
- `evidence/nr02/baseline-serial-tests.log`
- `evidence/nr02/baseline-tests.log`
- `evidence/nr02/ci-local-gates.log`
- `evidence/nr02/desktop-regression.log`
- `evidence/nr02/final-build.log`
- `evidence/nr02/final-integrated-build.log`
- `evidence/nr02/final-integrated-tests.log`
- `evidence/nr02/final-package-proof.log`
- `evidence/nr02/final-source-tests.log`
- `evidence/nr02/final-tests.log`
- `evidence/nr02/full-desktop.log`
- `evidence/nr02/manifest.json`
- `evidence/nr02/nr03-build.log`
- `evidence/nr02/nr03-check.log`
- `evidence/nr02/nr03-current-authority.log`
- `evidence/nr02/nr03-driver-check.log`
- `evidence/nr02/nr03-engine.log`
- `evidence/nr02/nr03-final-tests.log`
- `evidence/nr02/nr03-live-codex.log`
- `evidence/nr02/nr03-package-fixture.log`
- `evidence/nr02/nr03-postprocess-reference.json`
- `evidence/nr02/nr03-recheck.log`
- `evidence/nr02/nr03-targeted.log`
- `evidence/nr02/packaged/console-exact-proposal.png`
- `evidence/nr02/packaged/history.png`
- `evidence/nr02/packaged/proof.json`
- `evidence/nr02/packaged/workbook-exact-proposal.png`
- `evidence/nr02/preview-build.log`
- `evidence/nr02/preview-repro.log`
- `evidence/nr02/provider-outcomes-green.log`
- `evidence/nr02/provider-outcomes-red.log`
- `evidence/nr02/recovery-close-tests.log`
- `evidence/nr02/recovery-final-build.log`
- `evidence/nr02/recovery-final-tests.log`
- `evidence/nr02/regression-artifacts/desktop-proof.json`
- `evidence/nr02/regression-artifacts/native-runtime-manifest.json`
- `evidence/nr02/regression-artifacts/screenshots/approval-console-record.png`
- `evidence/nr02/regression-artifacts/screenshots/approval-workbook-preview.png`
- `evidence/nr02/regression-artifacts/screenshots/work-admission-workbook.png`
- `evidence/nr02/resource-build.log`
- `evidence/nr02/resource-desktop.log`
- `evidence/nr02/source-unavailable-desktop.log`
- `evidence/nr02/trust-consumer-tests.log`
- `evidence/nr02/trust-corrected-check.log`
- `evidence/nr02/trust-corrected-tests.log`
- `evidence/nr02/trust-source.json`
- `evidence/nr02/trust-stored-reference-repro.json`
- `evidence/nr02/ui-final.log`
- `evidence/nr02/ui-recheck.log`
- `evidence/nr02/ui-regression.log`
- `evidence/nr02/ui-remaining.log`
- `evidence/nr02/ui-settled.log`
- `evidence/nr02/usage-concurrent-green.log`
- `evidence/nr02/usage-concurrent-red.log`
- `evidence/nr02/usage-diagnostic-run.log`
- `evidence/nr02/usage-final-browser.log`
- `evidence/nr02/usage-final-build.log`
- `evidence/nr02/usage-final-tests.log`
- `evidence/nr02/usage-package-smoke.log`
- `evidence/nr02/usage-package-verified.log`
- `evidence/nr02/usage-repro-current.log`
- `evidence/nr02/usage-repro-full-current.log`
- `evidence/nr02/usage-verified-tests.log`
- `evidence/nr02/verified-final-build.log`
- `evidence/nr02/verified-final-tests.log`
- `evidence/nr02/verified-package-proof.log`
- `evidence/nr03/exact-proposal.md`
- `evidence/nr03/fresh-process-recovery.json`
- `evidence/nr03/live-proof.json`
- `evidence/nr03/manifest.json`
- `evidence/nr03/packaged-exact-proposal.png`
- `evidence/nr03/packaged-proof.json`
- `evidence/nr03/process-cleanup.json`
- `evidence/nr03/roadmap-sync.json`
- `scripts/codex-harness-smoke.ts`
- `scripts/harness-desktop-smoke.mjs`
- `scripts/package-desktop.mjs`
- `server/app.ts`
- `server/approval-admission.ts`
- `server/harness/adapters.ts`
- `server/harness/approval.ts`
- `server/harness/bridge.ts`
- `server/harness/capabilities/format-report.ts`
- `server/harness/codex-engine.ts`
- `server/harness/host.ts`
- `server/harness/policy.ts`
- `server/harness/routes.ts`
- `server/harness/run-service.ts`
- `server/harness/trust-port.ts`
- `server/integrations.ts`
- `server/native-work.ts`
- `server/store.ts`
- `server/trust/authority.ts`
- `server/trust/index.ts`
- `server/trust/revocation.ts`
- `server/trust/types.ts`
- `server/work-admission.ts`
- `shared/harness.ts`
- `tests/codex-engine.test.ts`
- `tests/harness-provider-outcomes.test.ts`
- `tests/harness.test.ts`
- `tests/integrations.test.ts`
- `tests/trust.test.ts`
- `tests/ui.spec.ts`
- `tests/work-admission.test.ts`
