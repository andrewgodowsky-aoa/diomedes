## Independent Static Review - Release Metadata Candidate 6f5bb353

Reviewer: independent release review session complete-gooseberry.
Base: c58152225efcefe1d0ae5c61191ddb3539423272.
Method: read-only inspection of the bounded five-file diff plus the tests and scripts that enforce it. No commands, builds, writes, or agents. Source root: F:/Diomedes/diomedes-wt/core-agent-release only.

### Verdict

Not ready for full release verification. The five touched files are internally consistent, but the bump is incomplete: committed 0.1.6 pins outside the diff contradict package.json 0.1.7, and the enforcing tests now confirm this red on the unchanged candidate.

### What checks out

- package.json and package-lock.json (top-level and packages[""]) all read 0.1.7.
- DEPENDENCIES.txt header: Application version 0.1.7, lock SHA-256 2e8defe7...f4b5, 141 paths; THIRD_PARTY_NOTICES.md generation line carries the same SHA; the r2 collector log agrees (141 paths, 101 texts, 2 missing notices, pins verified). Cross-file hash equality verified; the hash itself was not recomputed. Evidence limit.
- capability-record.json: appVersion 0.1.7; generatedFrom.commit c5815... with the correct note that the carrying commit is its child; release still names the 0.1.6 candidate with appVersionMatchesSource false, computed as release.appVersion === appVersion, so the old-release/new-source split is truthful and write-release-assets.mjs turns it into an honest caveat.
- Corrected --check semantics: it reuses the committed generatedFrom.commit, fails only on definite absence from the object store, then re-derives every fact (package version, routes, newest named release) and requires the committed file to equal a fresh regeneration modulo CRLF. It is not existence-only.
- Scope: package.json/package-lock.json/licenses sit inside the pinned transfer; capability-record.json is covered by existing claim claim_mubk3g78_14816099. Reserved files untouched.

### Findings

1. README.md line 18 still reads "This source tree is Diomedes 0.1.6". engine-routes.test.ts requires the README to state packageVersion and no other. Red run confirms the failure ("expected ... to contain 'Diomedes 0.1.7'").

2. resources/product-knowledge/index.json and core.json pin buildVersion "0.1.6"; no script regenerates them. product-knowledge-checkout.test.ts loads the bundle against packageInfo.version and asserts zero conflicts. Red run confirms the failure (2 conflicts). Runtime impact: server/app.ts loads shipped knowledge against packageInfo.version, so a 0.1.7 build self-reports build-version conflicts.

3. inventory-receipt-ui.spec.ts has two stale literals: line 35 expects "Diomedes 0.1.6 development demonstration"; line 278 asserts the demo build endpoint returns version '0.1.6' (received '0.1.7'). Both desktop cases failed there. Non-gating: playwright.inventory.config.ts is outside gates.ts and the default testMatch, so it fails whenever that spec next runs.

4. Build-record sequencing (hosted run 35636976303 fails build-identity.test.ts:56): evidence/windows-release/build-info.json still describes the previous 0.1.6 package (version 0.1.6, baseCommit 4a06a45...). The test requires the committed record's version to equal package.json's. This file is stamped only by a real package run: package-desktop.mjs writes it with manifest version, git-HEAD baseCommit, tracked-input sourceStatus, and a source digest re-verified mid-build, deep-equal to the asar's embedded BUILD_INFO.json. It must never be hand-edited to claim a new build.

### Sequencing assessment

write-candidate-record.ts hard-requires buildInfo.baseCommit === git HEAD, embedded-asar deep-equality with the working-tree record, per-file source-hash re-verification, and named only when sourceStatus is 'committed'. A record can never name the commit that carries it, so the committed record on the release commit necessarily describes a preparatory build of its parent. The scripts support the parent's order, with one sharp condition: write-candidate-record run against the preparatory record (baseCommit=B while HEAD=R) would refuse outright, so final bytes must be regenerated on the accepted commit, re-stamping the working-tree record to baseCommit=HEAD, before the record write; and the child commit should carry that final re-stamped build-info.json so the committed record matches the released build, as 0.1.6's does. No assertion weakening is needed or authorized.

### Status

Named red runs on unchanged 6f5bb353: engine-routes plus product-knowledge-checkout, 7 passed / 2 failed; both desktop inventory cases failed at the stale assertions. The first full browser gate and hosted Windows/macOS jobs failed; their root causes are not certified by this static review. No gate, hosted result, or publication is certified here.

Recommendation: apply the version-pin repairs (README sentence, both buildVersion fields, both spec literals), then follow the stated package-record-gates-repackage-record sequence.