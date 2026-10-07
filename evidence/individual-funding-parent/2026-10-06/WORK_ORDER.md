# Individual funding parent integration and verification

- Scope: DIO-128 implementation and DIO-136 source/status reconciliation.
- Feature: individual-funding-renewal.
- Branch: feature/individual-funding-renewal.
- Worktree: F:/Diomedes/diomedes-wt/individual-funding-renewal.
- Owner: parent native Codex agent; two requested native GPT-6.1 Sol max workers own disjoint app and site lanes.
- Initial app base: f885d50e235cd900312976d0f36618d180f2b54a.
- Initial site base: c6a4146cbdd5c3a932028a146408183f19f6456d.
- Canonical app mirror versions: 2026-10-06.1.
- Parent integration claims: claim_muxgu2z1_1bf8dbb4 (server/app.ts), claim_muxh5xd7_0ce7e154 (this evidence directory).
- The coordination fable role denotes the integration seat, not the runtime model.

## Boundaries

Preserve unrelated dirty checkouts and active claims. The DIO-245 lane's session claim and heavy-test slot were released before the parent claimed and integrated the Personal refresh patch. Final app verification follows integration and candidate freeze. GitHub Actions remain stopped. No live migration, deployment, provider spending, package build or installed-app replacement is authorized here.

The parent applied the three reviewed server/app.ts route-refresh hunks from the app author's evidence patch. The app worker owns its remaining source and regression tests. The site worker reviews the frozen app candidate read-only; the parent independently verifies and integrates it.

## Read-only shared migration evidence

On October 6, the parent queried control_plane.schema_migrations in accounts_staging, Neon project small-wave-81999606, branch br-old-star-aepf7zk6 (name production). All 19 migration names and SHA-256 hashes match Git blob bytes at the app base: 19 matching, 0 mismatched. Migrations 011 and 012 both record applied_at 2026-10-01T11:56:39.456Z.

- 011 SHA-256: 042849f4249f229d5e5478ee47e0109cdddc0912000b25e00e64a3e0a705d453.
- 012 SHA-256: 8ab3f0fe8e331f5297e696a5afd6ba35f41704ba3617382786df22c37c6fbcb8.
- cp_runtime has SELECT on credit_periods but lacks INSERT on credit_periods, funding_reservations and funding_settlements.
- cp_funding has INSERT on those three tables.

This proves the ledger/catalog state only. The deployed Worker's database binding, actual restricted-role execution, a signed-in funded-provider transaction, packaged-app behavior and release acceptance remain unverified. The new repair migration remains unapplied.

## Site result

Site PR #58 merged as f823f49688672156aa8c1161255e958ecce0e520. The accepted six-file patch came from 138c4b0f697138ac3b2833fb29e4cde4c722132c and has SHA-256 1eee5f5b749b3599227a99b38b19fd079fa2f747e7a28bc5dad65f32afdde946. Build passed; browser 22 passed, 0 failed, 0 skipped; parent rendered-build assertions 7 passed, 0 failed, 0 skipped. The first parent assertion harness overlooked the chip's SVG and was corrected; that was a harness failure, not a product defect. Sol max read-only cross-review found no Critical, Important or Minor findings in the exact candidate. Publication and product acceptance remain open in DIO-136.

## App review findings before final verification

The parent confirmed that migration 020's normalized trigger function equals migration 012 except for tightening the complete-feature predicate. The public EXECUTE revocation is retained; no applied migration file is changed.

Review identified two additional cases for regression coverage: an expired or absent unpaid access cache must still allow a remote re-grant to be discovered before route selection, and a valid complete replacement grant may start later within its verified paid term. The author is reproducing/fixing these before freeze. Final test results and candidate hashes are pending.

The subsequent bounded reproductions confirmed three client/helper failures, one service narrowed-grant failure and five awaited-sync account/scope failures. After their corrections the pure app batch passed 76 cases with 0 failures and 0 skips; the selected service group passed 14 with 0 failures and 15 selection-skipped. These are focused author results, not the final mandatory root run. Personal session composition remains pending ownership-safe integration and its own RED/GREEN checks.

## Synthesized session patch qualification

The first proposed Personal session patch reproduced five stale bought-state/revision failures, then a sixth through concurrent general loadAccess. The ordered replacement patch (SHA-256 fcc57399f776d751e0c0a2c0698399ef4ea1e006dd16c660b96cd24082775c6b) passed the same six probes with 0 failures and 0 skips. These probes transpile the exact base AccountSessionService plus the proposed patch in memory and use a fake transport. They are not actual integrated session, HTTP, database or provider acceptance. The actual source remains unchanged until the DIO-245 owner releases its claim.

## Independent source review

The second requested Sol max worker completed a read-only review of the 22-file pre-session candidate, finding 0 Critical, 2 Important and 0 Minor issues. The first concerns composition with DIO-245's ordered bought-balance refresh; the combined deferred probe reproduced 3 failures, plus one inverse paid-transition failure. The shared-generation overlay (SHA-256 ee298b6f5de1e51784e68c77dc282d1a3b59f447d14af9eb555bffee288e2525) passed all 10 composed probes with 0 failures and 0 skips, and the original 6 standalone probes remain passing. This remains synthesized source evidence.

The second concerns swallowed account/scope/sign-in errors during confirmedPersonalRefusal's initial refresh. Six focused failures were reported before correction, with 31 selection-skipped. The test change supersedes the earlier 22-file fingerprint. Final review acceptance requires the integrated manifest, narrow rereview of both repairs and fresh mandatory gates. The reviewer performed no writes or runtime tests.

## Integrated qualification checkpoint

The DIO-245 owner released its session path and then its heavy-test slot. Parent claimed session.ts as claim_muxial6d_0a56029e and acquired slot_muxibcpl_3c16ff46. Current origin/main remains f885d50. The shared-generation standalone session overlay was applied by the parent; its LF-normalized source SHA-256 is a870a98107c12904794f557d61d00d80aa95ac03f3d9d89b9980ba961f21677b and actual CRLF file SHA-256 is 1e510ef6ef3765860a77ae10d21d0e006d5b0e42b1d0407763d9057a793a5d3c. The DIO-245 implementation remains separate local work and was not copied or merged into this lane.

The catch-path fix passed the complete pure group: 82 passed, 0 failed, 0 skipped. Independent rereview resolved both Important source findings, with 0 Critical, 0 Important and 0 Minor outstanding, conditional on integrated checks and the final manifest. The first actual HTTP/session group recorded 69 passed, 2 failed, 0 skipped. Both failures were diagnosed as new fixture errors: a paid purchase requested 100 rather than the required 110-credit step, and the faux service retained an old real clock while the new expiry test advanced the app clock. The parent reported both failures before authorizing fixture corrections. Control-plane typecheck exited 0. The full integrated qualification is pending the corrected fixtures and frozen candidate.

The first fixture correction rerun recorded 70 passed, 1 failed, 0 skipped. The remaining case exposed missing Individual routing setup: the fixture published only legacy Business policy, while current Personal routing requires accepted privacy consent and versioned policy. An actual faux-handler probe confirmed null tiers with routing_setup_required. The parent authorized explicit synthetic Individual route/binding qualification, strict-profile acceptance and a scope-only published override; production setup requirements and successful-dispatch assertions remain intact. The separate DIO-245 composition source was subsequently committed locally as 5863a96b92999f6346d28c321bfb29da6a3e22c0 and remains outside main.

## Parent full-suite RED and fixture repair boundary

The parent froze and independently matched all 23 source/test hashes, with no extra or missing changed files. Parent TypeScript exited 0. The full root suite then recorded 10,279 passed, 6 failed and 5 skipped (10,290 total), with 607 files passing and one failing. All six failures were TypeErrors in tests/pay-as-you-go-desktop.test.ts: its hand-built session mock omitted the newly required confirmPersonalAdmitted/confirmPersonalDowngrade methods. The candidate's 23 hashes remained unchanged through the failed run. Build and browser gates did not run after the unit failure.

The parent reported the failures before authorizing any correction. A read-only constructor sweep confirmed the real production AccountSessionService implements both methods and identified only that exercised fixture as incomplete. The bounded correction adds two async mock methods, keeps all existing assertions and adds the test file as the 24th candidate path. This is not a product fallback or optional-method change. A new targeted result, final manifest review and all four parent gates are required after this root-test change. The original failed root log is retained as root-vitest.log; final rerun logs use distinct names.

## Existing dependency qualification

Both dependency junctions reuse F:/Diomedes/diomedes-wt/nectovia-reskin-home-thread installations. The control-plane package-lock bytes match (SHA-256 ac0e6e79bc6909be5eb86e69ec2245c1a5ae3744f77970e878ff0b2b15e4f40e). Root lock hashes differ because the qualified tree's project version is 0.2.3 and this base is 0.2.4; all non-root package entries and all dependency declarations are identical. Installed package version/integrity comparison found 0 mismatches among present entries. No dependency was installed or package/lockfile edited.

## First passing source checkpoint

The bounded desktop mock correction passed 15 tests with 0 failures and 0 skips. The final 24-file freeze has fingerprint 4012b3634257e85c1f42eb454d512500aece27128346ada1fc5c1b03c3080aee. Parent and second Sol max reviewer independently matched all 24 hashes and exact source/test path set. Final review has 0 Critical, 0 Important and 0 Minor findings. AUTHOR_HANDOFF.md records the handoff.

The parent then freshly passed all four mandatory gates: TypeScript exit 0; full root unit 10,285 passed, 0 failed, 5 skipped across all 608 files; Vite build exit 0; required browser 36 passed, 0 failed, 0 skipped. Source hashes still match 24/24 after the run; main remains f885d50 at final pre-commit drift check. Two test-generated screenshots and raw evidence remain local. VALIDATION.md records commands, exact counts, log hashes and the SQL/deployment/provider/package/release limits. This checkpoint supersedes the earlier pending and RED checkpoints for source acceptance only.

## Final publication checkpoint

The staged whitespace check subsequently caught two trailing blank lines in new test files. The author removed only one final LF from each. Parent and reviewer reconstructed both prior hashes by appending one LF; the other 22 source hashes and every assertion/internal byte are unchanged. Parent caught and the author restored an intermediate internal blank removal before final freeze. Cached whitespace check passes.

The final 24-file fingerprint is 2a5d5e3d96ce0ac1e999d58679540c94a7ab0f17658e317785ce1a495ee73ba2. Author manifest SHA-256 is 536e6d3df425760773ffc43ccb381e2aadcc5d3e9efaa4dd31d35db4a26bb0a5; full patch SHA-256 is 8f2834ba95ab48989d67a2bd40e166fd91837fa65835d904eb0424e36cc58137. Independent rereview has 0 findings and matches all 24 hashes. The parent freshly repeated all four mandatory gates on these bytes: TypeScript 0; full root 10,285 passed, 0 failed, 5 skipped across 608 files in 614.22 seconds; Vite build 0; browser 36 passed, 0 failed, 0 skipped in 1.5 minutes. Source hashes remain unchanged through the run. New logs use the publish suffix; prior RED/GREEN logs are retained. All 24 staged source blobs match their tested working files under Git's filters. The parent released the heavy-test slot after browser shutdown. No live migration, manual deployment, provider, package or release acceptance is inferred.
