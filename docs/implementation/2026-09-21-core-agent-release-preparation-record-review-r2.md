# Release-preparation checkpoint review (corrected, supersedes R1)

**Verdict: ACCEPT** the unchanged preparation records and the bounded common-copy correction as truthful within static-review limits. This accepts the records and copy scope only; it is not release acceptance and not program acceptance.

This report supersedes my R1 report. The three parent records and the copy correction are unchanged; only my reporting of them is corrected.

## Corrections to R1

1. The pre-merge head is `dbaea43b9c1fcd49b37fbb4ad0c85a4f1910b557`; R1 mistyped it as `dbaec43`. The records do not characterize the merge as "not a fast-forward"; that phrase is removed.
2. `release-preparation-typecheck-result.json` contains exactly `endedAt 2026-09-21T16:16:55.0089659Z`, head `e05833b4d91bb4e63731d41564378f2254ca00dc`, slot `slot_mubg6xpa_af60e299`, exitCode 0, and no elapsed duration. The 13,165 ms figure is withdrawn.
3. The four audited pairs are CD-00 (03d/04d), CD-01 (05n/06n), CD-02 (07e/08e) and CD-05 (09b/10b). R1's CD-04 bullet is withdrawn as outside this audit and failed to describe CD-00. The reconciliation's CD-00 row requires an independent CD-00.R verdict and applied canonical amendments reconciled with the cloud owners and repository mirrors. Its CD-02 row requires a dedicated independent verdict covering the whole named intent/proposal acceptance set; overlap in the admission seam review does not establish it.
4. R1 quoted "requires evidence, not bookkeeping," which does not appear in the reconciliation; the quotation is withdrawn. The document states all four pairs remain OPEN and declines treating conditional slice acceptance as whole-prompt completion.
5. The two paths remaining in AWS-owner claim `claim_mub06qvl_0d898805` are `server/harness/host.ts` and `server/harness/native-agent.ts`, not native-runtime hash files. The pending transfer covers `package.json`, `package-lock.json` and `licenses` only; the original one-file transfer covered `server/harness/model-session-run.ts` only.
6. R1 read current proof/refusal branches as present in source. Without an original-versus-current diff, that cannot establish the branches were untouched; the parent inspected that exact diff and ran the focused tests. This limit is retained below.

## Evidence mapping (static review)

- Merge: `pr29-merged.json` records head `dbaea43...` merged at `70645764ef061d8ff40a78c0c48e4385e1795098`, `2026-09-21T16:01:52Z`; `e05833b` is the following ledger-only main commit. `pr29-pre-merge.json` records three green checks on that head.
- Fresh preparation: `release-preparation-results.json` and install logs record locked installs adding 288 and 108 packages, the blocked esbuild postinstall warning retained, no dependency-policy change. `release-preparation-native-runtime.log` records exit 0 with unchanged source paths, codex-cli version and hashes; the manifest's changed fields are destination paths and preparation time. Typecheck exit 0 per the corrected fields above. `release-copy-focused.log` records 15 passed / 0 failed across the two existing release-copy test files (13 + 2). No fresh build or full release result is recorded or claimed.
- Copy correction: `scripts/write-release-assets.mjs` line 183 names the list installed-tool routes; the FIRST RUN paragraph (lines 253-260) keeps discovery consent verbatim, drops the blanket no-credential claim, scopes sign-in to installed-tool routes, and points to Settings plus this release's setup notes. `docs/reference/capability-record.json` confirms the routes are installed-tool adapters with their own sign-ins. The separate author's output records the same two passages.
- Reconciliation: all four pairs remain OPEN. CD-01's marker conflict is confirmed in source (`shared/contract-revision.ts` still `proposed`; the rollout record says accepted). CD-05's required acceptance includes C46-C50; the audit records no executed C47 zoom or C49 reduced-motion evidence. CD-00 and CD-02 requirements per item 3 are unmet by anything reviewed.
- Boundaries: AWS claim ownership unchanged, pending three-path transfer recorded as pending, prior transfer `server/harness/model-session-run.ts` only. No version bump, packaging, publication, deploy or live call claimed; package version `0.1.6` consistent with v0.1.6 remaining the latest published release.

## Evidence limits

Static independent review only. I did not rerun installs, tests, typecheck or prepare-native; did not recompute hashes (the parent separately re-hashed all three copied binaries and inspected directory attributes; I did not); did not diff the manifest, the copy script against its original, or commit `e05833b`; and did not verify remote `origin/main`. Claims resting on those operations are accepted on retained logs/JSONs and internal consistency, not my execution.