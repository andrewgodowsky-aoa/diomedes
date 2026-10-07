# Individual funding and Personal access validation

The reviewed 24-file source/test candidate fixes complete-grant credit eligibility, paid-term desktop guard alignment and Personal lapse/re-grant refresh. This record qualifies source and local fixtures; it does not mark the Individual product released or accepted end to end.

## Candidate and review

- Base: f885d50e235cd900312976d0f36618d180f2b54a.
- Feature branch: feature/individual-funding-renewal.
- Worktree: F:/Diomedes/diomedes-wt/individual-funding-renewal.
- Raw source fingerprint: 2a5d5e3d96ce0ac1e999d58679540c94a7ab0f17658e317785ce1a495ee73ba2.
- Exact paths, raw file hashes and fingerprint serialization: source-manifest.json.
- Recorded author handoff and independent review: AUTHOR_HANDOFF.md.
- Native Sol max review: 0 Critical, 0 Important, 0 Minor after resolving two Important findings.
- Parent and reviewer each independently matched 24/24 source/test hashes, with 0 mismatches, extra files or missing files. Parent repeated parity after the full gates. Main remained at the named base at final pre-commit drift check.

The browser suite regenerated two tracked screenshots, evidence/screenshots/approval-console-record.png and evidence/screenshots/work-admission-console.png. Those generated artifacts are retained locally and excluded from this source commit. The first generic changed-file check included them; the subsequent source/test check excluded evidence and confirmed exact 24-file parity. There was no candidate source drift.

## Fresh mandatory parent gates

All four gates ran sequentially under exclusive slot slot_muxibcpl_3c16ff46. Ports 5174 and 47632 were free before browser startup and after shutdown. Build preceded browser validation.

| Gate | Command | Exit | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- | --- |
| TypeScript | tsc --noEmit | 0 | check passed | 0 | 0 |
| Full root unit suite | vitest run --maxWorkers=4 --minWorkers=1 | 0 | 10,285 | 0 | 5 |
| Production build | vite build | 0 | check passed | 0 | 0 |
| Required browser suite | playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts | 0 | 36 | 0 | 0 |

The final full root suite passed all 608 test files, 10,290 total cases, in 614.22 seconds. Browser validation passed all 36 cases in 1.5 minutes. The build completed in 9.87 seconds and emitted its existing chunk-size advisory. GitHub Actions remains stopped and is not claimed as passing.

The first full root run on the original 23-file candidate recorded 10,279 passed, 6 failed and 5 skipped. All six failures were missing methods in the pay-as-you-go desktop session mock. Production implements both methods. Only two async mock stubs were added; all assertions and the original 23 source hashes remained unchanged. The targeted repair passed 15, with 0 failed and 0 skipped. This fresh full result supersedes that RED result for the accepted candidate; the original log and snapshot remain preserved locally.

The next full run passed all four gates, but a subsequent staged whitespace check identified two trailing blank EOF lines in new tests. Only one LF was removed from each file. Parent and reviewer independently proved that appending one LF reconstructs each exact prior hash; all internal bytes and assertions, and the other 22 file hashes, are unchanged. An intermediate internal blank removal was caught and restored before freeze. The prior fully passing 24-file snapshot (fingerprint 4012b3634257e85c1f42eb454d512500aece27128346ada1fc5c1b03c3080aee) is preserved locally. All four mandatory gates were then freshly repeated on the final fingerprint above, producing this record's results. Cached whitespace check passes. All 24 staged source blobs match the tested working files under Git's filters.

## Author checks on the unchanged control-plane subtree

- Control-plane TypeScript: exit 0.
- Complete control-plane suite: 1,252 passed, 0 failed, 82 configured database skips, 1,334 total cases. Files: 65 passed and 5 wholly skipped, 70 total. No selection skips. Duration 83.01 seconds.
- The 82 database skips include all 23 new restricted-role PostgreSQL cases. A disposable PostgreSQL target was unavailable. Those SQL execution cases remain unrun.
- Actual faux HTTP/session/bot group: 71 passed, 0 failed, 0 skipped. It uses scripted providers, synthetic qualification and an in-memory funding ledger; it is not a real funded-provider call.
- Pure routing, guard and predicate group: 82 passed, 0 failed, 0 skipped.
- Synthesized standalone session probes: 6 passed, 0 failed, 0 skipped. Synthesized composition with the separate DIO-245 source: 10 passed, 0 failed, 0 skipped. DIO-245 is not included in this candidate.

The final root mock correction did not change control-plane source/tests, so the complete control-plane suite was not repeated merely for the root fixture change. Parent independently read its final counts and retained the exact log hash.

## Retained local log hashes

Raw logs are preserved in this worktree separately from this concise committed record.

| Local log | SHA-256 |
| --- | --- |
| Parent root-typescript-publish.log | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| Parent root-vitest-publish.log | 9643d77c8b93e2a4bf72bd43994828fa5f1bfd46e46699b70837ef2bdcfdac9c |
| Parent root-vite-publish.log | 827499a3ba75ff8eb38a205519de50bd4fca9d690ab53a1acbe7bec5ba89c34a |
| Parent root-playwright-publish.log | d881db31750c2117bb40a17e868e5dd5bfa7d1ad2b98cbb12ea9d83d4af12e27 |
| Author control-plane-full.log | 7b52c1f10d7117ff11c217d51e14ff48f1e8d4f0e7bff402e36d99009bfd7642 |
| Author integrated-http-session-v4.log | 56ff29b38290a54357d496ab25acbbad4f7d34681ec67a25a0ed95d680c9a59d |

## Migration and release boundary

Migration 020 replaces the source-grant trigger function additively, tightening only the complete-feature predicate relative to 012. Applied migration files 001-019 are unchanged. Owner, ACL, identity, state/date/amount, term, overlap and locking checks remain. Existing grants, balances, purchases, holds and settlements are not rewritten or reclaimed.

The parent performed a read-only audit of accounts_staging on Neon project small-wave-81999606, branch br-old-star-aepf7zk6 (named production): 19 matching migration names/hashes and 0 mismatches. Migrations 011 and 012 record application at 2026-10-01T11:56:39.456Z. Catalog checks confirm the distinct runtime/funding INSERT privileges. Exact ledger rows are in shared-migration-ledger.json. A branch name does not establish production acceptance.

Migration 020 is unapplied. Its real upgrade and restricted-role execution, the deployed Worker's current database binding, signed-in Personal usage/renewal/payment journeys, funded-provider reservation/receipt/settlement, packaged-app/device and release acceptance remain open. No live migration, manual deployment, provider spend, package build or installed-app replacement was performed.

The canonical document mirrors remain version 2026-10-06.1. This repair enforces the existing Personal/Business and paid-term contracts; it introduces no new product decision or shipped-capability claim. DIO-128 and DIO-136 retain their broader acceptance and workflow metadata. Site copy qualification merged separately in site PR #58 as f823f49688672156aa8c1161255e958ecce0e520.
