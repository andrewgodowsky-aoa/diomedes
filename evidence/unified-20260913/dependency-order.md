# Dependency order · unified-20260913

Topological order from RUN_ORDER.json, ties broken by wave, priority, number. Base 212106e.

| # | node | role | wave | pri | depends on | prompt |
|---|---|---|---|---|---|---|
| 1 | C00.I | FABLE_5_1 | 1 | 0 | — | `FABLE_5_1/01_C00_IMPLEMENT_rebaseline-freeze-shared-contracts-and-establish-the-two-lea.md` |
| 2 | C00.R | ASTRA | 2 | 0 | C00.I | `ASTRA/02_C00_REVIEW_rebaseline-freeze-shared-contracts-and-establish-the-two-lea.md` |
| 3 | B00.I | FABLE_5_1 | 3 | 0 | C00.R | `FABLE_5_1/03a_B00_IMPLEMENT_zero-budget-vendor-decision-and-shared-commercial-contracts.md` |
| 4 | H01.I | FABLE_5_1 | 3 | 1 | C00.R | `FABLE_5_1/03b_H01_IMPLEMENT_one-versioned-adapter-contract-durable-event-stream-and-conf.md` |
| 5 | B00.R | ASTRA | 4 | 0 | B00.I | `ASTRA/04a_B00_REVIEW_zero-budget-vendor-decision-and-shared-commercial-contracts.md` |
| 6 | H01.R | ASTRA | 4 | 1 | H01.I | `ASTRA/04b_H01_REVIEW_one-versioned-adapter-contract-durable-event-stream-and-conf.md` |
| 7 | H02.I | FABLE_5_1 | 5 | 1 | H01.R | `FABLE_5_1/05a_H02_IMPLEMENT_codex-native-steering-interruption-resume-and-fork.md` |
| 8 | H03.I | FABLE_5_1 | 5 | 1 | H01.R | `FABLE_5_1/05b_H03_IMPLEMENT_claude-code-persistent-input-native-sessions-and-live-contro.md` |
| 9 | H04.I | FABLE_5_1 | 5 | 1 | H01.R | `FABLE_5_1/05c_H04_IMPLEMENT_opencode-persistent-sessions-steering-abort-and-recovery.md` |
| 10 | H05.I | FABLE_5_1 | 5 | 1 | H01.R | `FABLE_5_1/05d_H05_IMPLEMENT_cursor-acp-session-loading-cancellation-and-safe-control.md` |
| 11 | H06.I | FABLE_5_1 | 5 | 1 | H01.R | `FABLE_5_1/05e_H06_IMPLEMENT_oh-my-pi-parity-and-complete-advertised-route-inventory.md` |
| 12 | H07.I | FABLE_5_1 | 5 | 1 | H01.R | `FABLE_5_1/05f_H07_IMPLEMENT_durable-ready-admission-automatic-worker-claims-and-fair-sch.md` |
| 13 | H09.I | FABLE_5_1 | 5 | 1 | C00.R, H01.R | `FABLE_5_1/05g_H09_IMPLEMENT_exact-model-agent-profiles-routing-preferences-and-immutable.md` |
| 14 | H12.I | FABLE_5_1 | 5 | 1 | H01.R | `FABLE_5_1/05h_H12_IMPLEMENT_typed-tools-mediated-effects-and-real-execution-containment.md` |
| 15 | W01.I | FABLE_5_1 | 5 | 2 | B00.R | `FABLE_5_1/05i_W01_IMPLEMENT_early-website-clarity-and-truthful-business-positioning.md` |
| 16 | H02.R | ASTRA | 6 | 1 | H02.I | `ASTRA/06a_H02_REVIEW_codex-native-steering-interruption-resume-and-fork.md` |
| 17 | H03.R | ASTRA | 6 | 1 | H03.I | `ASTRA/06b_H03_REVIEW_claude-code-persistent-input-native-sessions-and-live-contro.md` |
| 18 | H04.R | ASTRA | 6 | 1 | H04.I | `ASTRA/06c_H04_REVIEW_opencode-persistent-sessions-steering-abort-and-recovery.md` |
| 19 | H05.R | ASTRA | 6 | 1 | H05.I | `ASTRA/06d_H05_REVIEW_cursor-acp-session-loading-cancellation-and-safe-control.md` |
| 20 | H06.R | ASTRA | 6 | 1 | H06.I | `ASTRA/06e_H06_REVIEW_oh-my-pi-parity-and-complete-advertised-route-inventory.md` |
| 21 | H07.R | ASTRA | 6 | 1 | H07.I | `ASTRA/06f_H07_REVIEW_durable-ready-admission-automatic-worker-claims-and-fair-sch.md` |
| 22 | H09.R | ASTRA | 6 | 1 | H09.I | `ASTRA/06g_H09_REVIEW_exact-model-agent-profiles-routing-preferences-and-immutable.md` |
| 23 | H12.R | ASTRA | 6 | 1 | H12.I | `ASTRA/06h_H12_REVIEW_typed-tools-mediated-effects-and-real-execution-containment.md` |
| 24 | W01.R | ASTRA | 6 | 2 | W01.I | `ASTRA/06i_W01_REVIEW_early-website-clarity-and-truthful-business-positioning.md` |
| 25 | H08.I | FABLE_5_1 | 7 | 1 | H01.R, H07.R | `FABLE_5_1/07a_H08_IMPLEMENT_steer-queue-stop-resume-retry-and-fork-as-distinct-durable-c.md` |
| 26 | H10.I | FABLE_5_1 | 7 | 1 | H09.R | `FABLE_5_1/07b_H10_IMPLEMENT_automatic-guidance-maintenance-with-signed-revisions-evaluat.md` |
| 27 | H11.I | FABLE_5_1 | 7 | 1 | H09.R, H01.R | `FABLE_5_1/07c_H11_IMPLEMENT_canonical-instructions-nested-project-rules-and-inspectable-.md` |
| 28 | H08.R | ASTRA | 8 | 1 | H08.I | `ASTRA/08a_H08_REVIEW_steer-queue-stop-resume-retry-and-fork-as-distinct-durable-c.md` |
| 29 | H10.R | ASTRA | 8 | 1 | H10.I | `ASTRA/08b_H10_REVIEW_automatic-guidance-maintenance-with-signed-revisions-evaluat.md` |
| 30 | H11.R | ASTRA | 8 | 1 | H11.I | `ASTRA/08c_H11_REVIEW_canonical-instructions-nested-project-rules-and-inspectable-.md` |
| 31 | SDKR.I | FABLE_5_1 | 9 | 1 | H01.R, H09.R, H11.R, H12.R | `FABLE_5_1/09_SDKR_IMPLEMENT_ai-sdk-core-model-operation-bridge.md` |
| 32 | SDKR.R | ASTRA | 10 | 1 | SDKR.I | `ASTRA/10_SDKR_REVIEW_ai-sdk-core-model-operation-bridge.md` |
| 33 | H13.I | FABLE_5_1 | 11 | 1 | H07.R, H09.R, H11.R, H12.R, H02.R, H04.R, SDKR.R | `FABLE_5_1/11a_H13_IMPLEMENT_real-diomedes-owned-plan-act-observe-and-finish-loop.md` |
| 34 | SDKO.I | FABLE_5_1 | 11 | 4 | SDKR.R, H04.R, H12.R | `FABLE_5_1/11b_SDKO_IMPLEMENT_optional-opencode-harnessagent-compatibility-proof.md` |
| 35 | H13.R | ASTRA | 12 | 1 | H13.I | `ASTRA/12a_H13_REVIEW_real-diomedes-owned-plan-act-observe-and-finish-loop.md` |
| 36 | SDKO.R | ASTRA | 12 | 4 | SDKO.I | `ASTRA/12b_SDKO_REVIEW_optional-opencode-harnessagent-compatibility-proof.md` |
| 37 | H14.I | FABLE_5_1 | 13 | 1 | H13.R, H08.R | `FABLE_5_1/13a_H14_IMPLEMENT_teams-bounded-subagents-advisors-and-durable-handoffs.md` |
| 38 | H17.I | FABLE_5_1 | 13 | 1 | H12.R, H13.R | `FABLE_5_1/13b_H17_IMPLEMENT_independent-verification-four-state-results-and-evidence-bou.md` |
| 39 | H18.I | FABLE_5_1 | 13 | 1 | H11.R, H13.R, H09.R | `FABLE_5_1/13c_H18_IMPLEMENT_context-accounting-selective-retrieval-cache-reuse-and-safe-.md` |
| 40 | H14.R | ASTRA | 14 | 1 | H14.I | `ASTRA/14a_H14_REVIEW_teams-bounded-subagents-advisors-and-durable-handoffs.md` |
| 41 | H17.R | ASTRA | 14 | 1 | H17.I | `ASTRA/14b_H17_REVIEW_independent-verification-four-state-results-and-evidence-bou.md` |
| 42 | H18.R | ASTRA | 14 | 1 | H18.I | `ASTRA/14c_H18_REVIEW_context-accounting-selective-retrieval-cache-reuse-and-safe-.md` |
| 43 | H15.I | FABLE_5_1 | 15 | 1 | H13.R, H17.R | `FABLE_5_1/15a_H15_IMPLEMENT_drift-detection-bounded-correction-and-escalation.md` |
| 44 | H19.I | FABLE_5_1 | 15 | 1 | H08.R, H09.R, H11.R, H17.R, SDKR.R | `FABLE_5_1/15b_H19_IMPLEMENT_one-console-for-setup-live-control-profiles-and-review.md` |
| 45 | H15.R | ASTRA | 16 | 1 | H15.I | `ASTRA/16a_H15_REVIEW_drift-detection-bounded-correction-and-escalation.md` |
| 46 | H19.R | ASTRA | 16 | 1 | H19.I | `ASTRA/16b_H19_REVIEW_one-console-for-setup-live-control-profiles-and-review.md` |
| 47 | H16.I | FABLE_5_1 | 17 | 1 | H15.R, H08.R, H12.R | `FABLE_5_1/17_H16_IMPLEMENT_stream-time-rule-triggers-and-safe-intervention-ttsr.md` |
| 48 | H16.R | ASTRA | 18 | 1 | H16.I | `ASTRA/18_H16_REVIEW_stream-time-rule-triggers-and-safe-intervention-ttsr.md` |
| 49 | H20.I | FABLE_5_1 | 19 | 1 | H02.R, H03.R, H04.R, H05.R, H06.R, H13.R, H14.R, H15.R, H16.R, H17.R, H18.R, H19.R, SDKR.R | `FABLE_5_1/19_H20_IMPLEMENT_headless-production-core-evaluation-and-all-route-acceptance.md` |
| 50 | H20.R | ASTRA | 20 | 1 | H20.I | `ASTRA/20_H20_REVIEW_headless-production-core-evaluation-and-all-route-acceptance.md` |
| 51 | H21.I | FABLE_5_1 | 21 | 1 | H20.R, SDKR.R | `FABLE_5_1/21_H21_IMPLEMENT_crash-recovery-migrations-performance-and-the-harness-comple.md` |
| 52 | H21.R | ASTRA | 22 | 1 | H21.I | `ASTRA/22_H21_REVIEW_crash-recovery-migrations-performance-and-the-harness-comple.md` |
| 53 | P01.I | FABLE_5_1 | 23 | 2 | H21.R | `FABLE_5_1/23a_P01_IMPLEMENT_versioned-pack-manifests-contribution-contracts-and-dependen.md` |
| 54 | B01.I | FABLE_5_1 | 23 | 3 | B00.R, H21.R | `FABLE_5_1/23b_B01_IMPLEMENT_small-control-plane-service-and-durable-cloud-store.md` |
| 55 | P01.R | ASTRA | 24 | 2 | P01.I | `ASTRA/24a_P01_REVIEW_versioned-pack-manifests-contribution-contracts-and-dependen.md` |
| 56 | B01.R | ASTRA | 24 | 3 | B01.I | `ASTRA/24b_B01_REVIEW_small-control-plane-service-and-durable-cloud-store.md` |
| 57 | P02.I | FABLE_5_1 | 25 | 2 | P01.R, H10.R | `FABLE_5_1/25a_P02_IMPLEMENT_private-registry-and-github-acquisition-with-verified-distri.md` |
| 58 | P05.I | FABLE_5_1 | 25 | 2 | H19.R, P01.R | `FABLE_5_1/25b_P05_IMPLEMENT_core-files-attachments-previews-and-durable-artifact-identit.md` |
| 59 | B02.I | FABLE_5_1 | 25 | 3 | B01.R | `FABLE_5_1/25c_B02_IMPLEMENT_workos-authkit-web-and-electron-sign-in.md` |
| 60 | P02.R | ASTRA | 26 | 2 | P02.I | `ASTRA/26a_P02_REVIEW_private-registry-and-github-acquisition-with-verified-distri.md` |
| 61 | P05.R | ASTRA | 26 | 2 | P05.I | `ASTRA/26b_P05_REVIEW_core-files-attachments-previews-and-durable-artifact-identit.md` |
| 62 | B02.R | ASTRA | 26 | 3 | B02.I | `ASTRA/26c_B02_REVIEW_workos-authkit-web-and-electron-sign-in.md` |
| 63 | P03.I | FABLE_5_1 | 27 | 2 | P02.R | `FABLE_5_1/27a_P03_IMPLEMENT_pack-install-activate-update-deactivate-rollback-and-uninsta.md` |
| 64 | P06.I | FABLE_5_1 | 27 | 2 | P05.R, H17.R | `FABLE_5_1/27b_P06_IMPLEMENT_existing-file-edits-diffs-review-comments-and-verified-revis.md` |
| 65 | B03.I | OPUS_5 | 27 | 3 | B02.R | `OPUS_5/27c_B03_IMPLEMENT_verified-tenancy-and-existing-workspace-bridge.md` |
| 66 | P03.R | ASTRA | 28 | 2 | P03.I | `ASTRA/28a_P03_REVIEW_pack-install-activate-update-deactivate-rollback-and-uninsta.md` |
| 67 | P06.R | ASTRA | 28 | 2 | P06.I | `ASTRA/28b_P06_REVIEW_existing-file-edits-diffs-review-comments-and-verified-revis.md` |
| 68 | B03.R | ASTRA | 28 | 3 | B03.I | `ASTRA/28c_B03_REVIEW_verified-tenancy-and-existing-workspace-bridge.md` |
| 69 | P04.I | FABLE_5_1 | 29 | 2 | P03.R, H12.R, H18.R, H09.R | `FABLE_5_1/29a_P04_IMPLEMENT_on-demand-contribution-loading-across-tools-agents-context-w.md` |
| 70 | B04.I | FABLE_5_1 | 29 | 3 | B03.R | `FABLE_5_1/29b_B04_IMPLEMENT_stripe-hosted-checkout-and-customer-portal-in-test-mode.md` |
| 71 | P04.R | ASTRA | 30 | 2 | P04.I | `ASTRA/30a_P04_REVIEW_on-demand-contribution-loading-across-tools-agents-context-w.md` |
| 72 | B04.R | ASTRA | 30 | 3 | B04.I | `ASTRA/30b_B04_REVIEW_stripe-hosted-checkout-and-customer-portal-in-test-mode.md` |
| 73 | P07.I | FABLE_5_1 | 31 | 2 | P04.R, P06.R, H12.R | `FABLE_5_1/31a_P07_IMPLEMENT_software-pack-repository-context-git-worktrees-and-mediated-.md` |
| 74 | P09.I | FABLE_5_1 | 31 | 2 | P02.R, P03.R, P04.R | `FABLE_5_1/31b_P09_IMPLEMENT_private-capability-skill-catalog-and-interoperable-import-ex.md` |
| 75 | P10.I | FABLE_5_1 | 31 | 2 | P04.R, P05.R, P06.R | `FABLE_5_1/31c_P10_IMPLEMENT_non-coding-approved-files-pack-on-the-same-harness.md` |
| 76 | B05.I | FABLE_5_1 | 31 | 3 | B04.R | `FABLE_5_1/31d_B05_IMPLEMENT_signed-billing-inbox-reconciliation-and-entitlement-projecti.md` |
| 77 | B08.I | FABLE_5_1 | 31 | 3 | B03.R, P04.R, H12.R | `FABLE_5_1/31e_B08_IMPLEMENT_credential-broker-and-one-read-only-github-capability.md` |
| 78 | P07.R | ASTRA | 32 | 2 | P07.I | `ASTRA/32a_P07_REVIEW_software-pack-repository-context-git-worktrees-and-mediated-.md` |
| 79 | P09.R | ASTRA | 32 | 2 | P09.I | `ASTRA/32b_P09_REVIEW_private-capability-skill-catalog-and-interoperable-import-ex.md` |
| 80 | P10.R | ASTRA | 32 | 2 | P10.I | `ASTRA/32c_P10_REVIEW_non-coding-approved-files-pack-on-the-same-harness.md` |
| 81 | B05.R | ASTRA | 32 | 3 | B05.I | `ASTRA/32d_B05_REVIEW_signed-billing-inbox-reconciliation-and-entitlement-projecti.md` |
| 82 | B08.R | ASTRA | 32 | 3 | B08.I | `ASTRA/32e_B08_REVIEW_credential-broker-and-one-read-only-github-capability.md` |
| 83 | P08.I | FABLE_5_1 | 33 | 2 | P07.R | `FABLE_5_1/33a_P08_IMPLEMENT_optional-syntax-symbols-diagnostics-and-language-server-capa.md` |
| 84 | B06.I | OPUS_5 | 33 | 3 | B05.R | `OPUS_5/33b_B06_IMPLEMENT_server-authoritative-funded-reserve-and-settle-accounting.md` |
| 85 | B12.I | FABLE_5_1 | 33 | 4 | B08.R | `FABLE_5_1/33c_B12_IMPLEMENT_optional-funded-vercel-connect-adapter.md` |
| 86 | P08.R | ASTRA | 34 | 2 | P08.I | `ASTRA/34a_P08_REVIEW_optional-syntax-symbols-diagnostics-and-language-server-capa.md` |
| 87 | B06.R | ASTRA | 34 | 3 | B06.I | `ASTRA/34b_B06_REVIEW_server-authoritative-funded-reserve-and-settle-accounting.md` |
| 88 | B12.R | ASTRA | 34 | 4 | B12.I | `ASTRA/34c_B12_REVIEW_optional-funded-vercel-connect-adapter.md` |
| 89 | Z01.I | FABLE_5_1 | 35 | 2 | H10.R, H21.R, P04.R, P06.R, P07.R, P08.R, P09.R, P10.R, SDKR.R | `FABLE_5_1/35a_Z01_IMPLEMENT_full-integrated-packaged-app-proof-and-completion-reconcilia.md` |
| 90 | B07.I | FABLE_5_1 | 35 | 3 | B06.R, SDKR.R, H21.R | `FABLE_5_1/35b_B07_IMPLEMENT_managed-model-transport-behind-the-funded-gate.md` |
| 91 | B09.I | FABLE_5_1 | 35 | 3 | B03.R, B05.R, B06.R, H19.R | `FABLE_5_1/35c_B09_IMPLEMENT_account-and-billing-ui-without-a-second-work-application.md` |
| 92 | Z01.R | ASTRA | 36 | 2 | Z01.I | `ASTRA/36a_Z01_REVIEW_full-integrated-packaged-app-proof-and-completion-reconcilia.md` |
| 93 | B07.R | ASTRA | 36 | 3 | B07.I | `ASTRA/36b_B07_REVIEW_managed-model-transport-behind-the-funded-gate.md` |
| 94 | B09.R | ASTRA | 36 | 3 | B09.I | `ASTRA/36c_B09_REVIEW_account-and-billing-ui-without-a-second-work-application.md` |
| 95 | B10.I | FABLE_5_1 | 37 | 3 | B07.R, B08.R, B09.R | `FABLE_5_1/37a_B10_IMPLEMENT_quota-revocation-recovery-and-operational-readiness.md` |
| 96 | W02.I | FABLE_5_1 | 37 | 3 | W01.R, Z01.R, B09.R | `FABLE_5_1/37b_W02_IMPLEMENT_evidence-gated-website-capabilities-and-billing-navigation.md` |
| 97 | B10.R | ASTRA | 38 | 3 | B10.I | `ASTRA/38a_B10_REVIEW_quota-revocation-recovery-and-operational-readiness.md` |
| 98 | W02.R | ASTRA | 38 | 3 | W02.I | `ASTRA/38b_W02_REVIEW_evidence-gated-website-capabilities-and-billing-navigation.md` |
| 99 | B11.I | FABLE_5_1 | 39 | 3 | B10.R, Z01.R | `FABLE_5_1/39_B11_IMPLEMENT_integrated-business-sandbox-and-real-desktop-journey.md` |
| 100 | B11.R | ASTRA | 40 | 3 | B11.I | `ASTRA/40_B11_REVIEW_integrated-business-sandbox-and-real-desktop-journey.md` |
| 101 | D01.I | FABLE_5_1 | 41 | 3 | B11.R, W02.R | `FABLE_5_1/41_D01_IMPLEMENT_canonical-reconciliation-and-final-handoff.md` |
| 102 | D01.R | ASTRA | 42 | 3 | D01.I | `ASTRA/42_D01_REVIEW_canonical-reconciliation-and-final-handoff.md` |
| 103 | G01.I | FABLE_5_1 | 43 | 4 | D01.R | `FABLE_5_1/43_G01_IMPLEMENT_production-activation-readiness-not-automatic-launch.md` |
| 104 | G01.R | ASTRA | 44 | 4 | G01.I | `ASTRA/44_G01_REVIEW_production-activation-readiness-not-automatic-launch.md` |

## Anchors missing on base 212106e (marked proposed-new in the work order unless the prompt already says so)

- B01.I: `services/control-plane/`
- B01.I: `services/control-plane/migrations/`
- B01.I: `services/control-plane/tests/`
- B02.I: `services/control-plane/auth/`
- B03.I: `services/control-plane/membership/`
- B04.I: `services/control-plane/billing/checkout.ts`
- B04.I: `services/control-plane/billing/portal.ts`
- B04.I: `services/control-plane/billing/catalog.ts`
- B04.I: `services/control-plane/tests/`
- B05.I: `services/control-plane/billing/webhooks.ts`
- B05.I: `services/control-plane/billing/reconcile.ts`
- B05.I: `services/control-plane/entitlements/`
- B05.I: `services/control-plane/migrations/`
- B06.I: `services/control-plane/usage/`
- B06.I: `services/control-plane/migrations/`
- B07.I: `services/control-plane/inference/`
- B08.I: `services/control-plane/connections/`
- B09.I: `services/control-plane/web/`
- B10.I: `services/control-plane/`
- B10.I: `docs/operations/`
- B11.I: `services/control-plane/tests/`
- B12.I: `services/control-plane/connections/vercel/`
- W01.I: `site: src/data/site.ts`
- W01.I: `site: src/data/releases.ts`
- W01.I: `site: src/data/engines.ts`
- W01.I: `site: src/pages/`
- W01.I: `site: src/content/`
- W01.I: `site: scripts/check-copy.mjs`
- W02.I: `site: src/data/releases.ts`
- W02.I: `site: actual capability registry discovered in W01`
- W02.I: `site: src/pages/`
- W02.I: `site: src/content/`
- W02.I: `site: tests/ and scripts/check-copy.mjs`
- D01.I: `site: release/capability documentation`
- D01.I: `Google Docs canonical mirrors`
- G01.I: `docs/operations/`
- G01.I: `services/control-plane/deployment/`
- G01.I: `site: approved release/offer manifests`
