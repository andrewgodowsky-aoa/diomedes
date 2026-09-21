Independent static review of the release-preparation records and common release copy correction.

# Release-preparation checkpoint review

**Verdict: ACCEPT** the preparation records and the bounded copy correction as truthful. This accepts the records and copy scope only; it is not release acceptance and not program acceptance.

Scope performed: read-only static review in `F:/Diomedes/diomedes-wt/core-agent-release` at `e05833b`, plus the named deliverable evidence files and the named package prompts. No commands, tests, builds, writes or hash recomputation were run. Everything below is source/evidence reading.

## Checked and confirmed

**Merge facts.** `pr29-pre-merge.json` shows head `dbaec43...` checks: local-gates SUCCESS, macos-arm64 SUCCESS, Workers Builds SUCCESS, base `58bdc65`. `pr29-merged.json` shows head `dbaea43`, merge commit `70645764ef061d8ff40a78c0c48e4385e1795098` at `2026-09-21T16:01:52Z`. All three records report these identically, including the "not a fast-forward" characterization.

**Fresh preparation counts.** `release-preparation-results.json`: root `npm ci` added 288 packages, service `npm ci --ignore-scripts` added 108, `prepare-native` exit 0, manifest written. `release-preparation-root-install.log` independently shows "added 288 packages" and preserves the esbuild blocked-postinstall warning; `release-preparation-service-install.log` shows "added 108 packages"; `release-preparation-native-runtime.log` verifies codex-cli `0.153.4` with all three binary SHA-256 lines passing, source path matching `nr03-final-package-20260909`. `release-preparation-typecheck-result.json` records `tsc --noEmit` exit 0 in 13,165 ms under a separate slot `slot_mubg6xpa_af60e299` (preparation slot `slot_mubfta61_6675e44f` in results.json; distinct, consistent with the docs' "own exclusive slot" claim). `release-copy-focused.log` shows 15 passed / 0 failed across the two existing pure release-copy test files (13 + 2), exactly as reported.

**Copy correction.** `scripts/write-release-assets.mjs:183` reads `The installed-tool routes this build carries are ...`; FIRST RUN at lines 253-260 retains the discovery-consent sentence verbatim (`looks only if you say yes`), drops the blanket `Diomedes holds no credential of its own:` claim, scopes sign-in to installed-tool routes, and adds the Settings-plus-setup-notes pointer. The capability record at `docs/reference/capability-record.json:30-116` confirms the routes are installed-tool adapters with their own sign-in flows, so the scoped sentence is accurate. All refusal branches (tag mismatch, named-tag check, capability mismatch, installer name/hash, exe/asar hashes at lines 314-322, out-dir ownership, notes-heading, manifest local-path guard) and record-derived logic (VERIFIED_CLAIMS, testedOn, signingFact, unproven) are intact and untouched. Existing tests still constrain the route list's semantics (`release-assets.test.ts:102`). The separate author's `release-readme-copy-output.txt` records the same two edits under `claim_mubfru14_e0926055`. Consistent with the claimed scope; no new tests needed.

**Reconciliation.** All four pairs correctly kept OPEN with evidence-based reasons:
- CD-01: marker conflict verified in source (`shared/contract-revision.ts:39` still `status: 'proposed'` while `evidence/unified-20260913/C00.R-rollout-20260917.json:14,18` records `verdict: accepted`, `approved_contract_revision 2026-09-13.1`); C24 requires a cross-tenant boundary the single-owner local path cannot execute (`ACCEPTANCE_CASES.md` C24; `06n` prompt requires C24-C30).
- CD-05: `10b` required acceptance names C01, C13, C21, C38 and C46-C50; the audit records no executed C47 200%-zoom leg or C49 reduced-motion evidence. OPEN is correct.
- CD-02's guarded-divergence matrix + second-runtime check and CD-04's configured-internal-route requirement are not contradicted by any fresh evidence; keeping them OPEN is conservative and correct.
- No DONE inference: the doc states explicitly that completing the pairs "requires evidence, not bookkeeping," and records that no prompt, index, checksum or completion record changed.

**Ledger.** Round 21's merge record matches the JSONs exactly. Round 22's counts (288 + 108 + 3 binaries, 15 release-copy tests, typecheck) match evidence; copy summary matches source; the pre-merge audit snapshot is correctly framed as historical; `package.json:3` version `0.1.6` is consistent with "latest published release remains v0.1.6."

**Boundaries honored.** AWS claim `claim_mub06qvl_0d898805` ownership stated consistently; pending three-path transfer recorded without implying completion; prior transfer recorded as `model-session-run.ts` only. No version bump, packaging, publication, deploy or live call is claimed anywhere. The 4,682-unit/176-browser counts are explicitly labeled merged-source evidence, not relabeled as fresh release results. Failed/skipped/warning history is preserved (esbuild warning, disclosed mutation survivors, first-composed-run failure, the audit's pre-merge snapshot).

## Minor observations (non-blocking)

- `2026-09-21-core-agent-release-review.md` line ~62: "its two runtime paths stay reserved" is terse; the referent is the AWS claim's remaining two paths (the native-runtime hash files). Ambiguous phrasing, not a false claim.
- The audit's self-reported SHA-256 values for its own return output (`c7cbb7...` / `149c4fcb...`) could not be re-derived under read-only review; treated as the parent's computed values, internally consistent.
- Merge-tree-identical-to-head and both slot releases are recorded facts of the parent's verified operations; the JSONs corroborate head/merge commits but not the tree-identity operation itself.
- Manifest "changes only timestamp and destination paths": the current manifest (`evidence/native-runtime-manifest.json`) is consistent with that claim (only `preparedAt` and `destination` fields are worktree-volatile); I did not diff the prior committed manifest.
- "Both new dependency directories are ordinary directories" is consistent with the fresh-install record (worktree started without them) but file-attribute checks are outside static review.

## Evidence limits

I performed a static independent review only. I did not rerun installs, tests, typecheck or prepare-native; did not recompute any SHA-256; did not diff the manifest or the e05833b commit; and did not verify junction attributes or the remote `origin/main` state. Claims resting on those are accepted on the strength of the retained JSONs/logs and internal consistency, not my own execution.

## Recommendation

Accept these three records and the copy correction scope. The four numbered pairs remain OPEN pending the evidence the reconciliation enumerates; nothing reviewed here advances them.