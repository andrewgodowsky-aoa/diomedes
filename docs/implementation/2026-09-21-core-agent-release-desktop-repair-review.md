## Independent Review - Desktop Smoke Driver Repair, Candidate 79d5b361

Reviewer: independent release review session complete-gooseberry. Method: native read-only inspection of the listed diff, driver, product source, ledger, failure report, and retained run artifacts. I executed nothing; every pass/fail below is the parent's recorded run, not mine.

### Verdict

Accept the bounded driver repair and the failure report/Round24 ledger. No blocking findings.

### What the repair does and why it is sound

- New helper `enterLastOpenProject` (scripts/desktop-smoke.mjs:35-49) mirrors tests/fixtures/landing.ts verbatim in semantics: the Open projects bar, a hard failure when only the "Projects" button exists, click by position, and an on/active class assertion. The comment correctly names it a port of the TS fixture.
- First window (diff +scripts/desktop-smoke.mjs:89-99): after the settings PUT and reload it now asserts the Diomedes landing, enters the project through its real bar button, then reaches Tasks via the Project pages rail. This matches App.tsx: openProjects/lastPage are navigation context (App.tsx:232-236), a fresh window has no keptPlace so it lands on Diomedes, and openProject lands on Home (App.tsx:432), so the rail click is required.
- Restart (current file :278-300): waitForURL precedes the origin reassignment, fixing a latent read-before-navigation hazard; url is updated before any API use, so no stale-port reads. It then asserts the Console surface and Diomedes landing, re-opts into Workbook through the real settings API, reloads, asserts the workbook surface, and only then repeats the original task-card and receipt oracles.
- The migration claim checks out: store.ts:179 forces surface to console at launch and only at launch; surface.test.ts documents the API still accepting the key for one more release so legacy specs stay runnable. The R2 opt-in is the documented contract, not a workaround.

### Attack-surface results

- Weakened assertions: none. The diff removes only the bare restarted task-card line and re-adds it after real navigation; every original oracle (task counts, 1.24 font scaling, both lost-response legs, team, renderer isolation, packaged startup, empty pageErrors, shutdown/lock polls, receipt equality plus state stopped) survives verbatim.
- New bypasses: none. No session-storage injection, no timeout change (15s default intact), no new fake responses; the workbook selection uses the same API a person could.
- Persistence hidden by fixture recreation: no. Both launches share one env (DIOMEDES_DATA_DIR/PROJECTS_DIR/profile under one root); restart reads the receipts window one wrote.
- Proof binding: corrected. The desktop gate's proof-to-build tie is exe-only: desktopSmokeOutcome (scripts/write-candidate-record.ts:191-217) checks startup.version against package.json and the proof's executableSha256 against the hash of Diomedes.exe. A same-version repackage can yield byte-identical Diomedes.exe while app.asar differs, so that schema alone does not prove the smoke drove the final package's asar. The writer's separate checks (asarSha256, embedded BUILD_INFO deep-equal to the committed build-info, per-source hash re-verification) bind the record to the package bytes, not the smoke run to the asar. The r2 proof therefore stands as driver-validity evidence, not release proof. Fresh execution on the final frozen package remains required - which is exactly what the parent's stated sequence plans - and provenance (fresh run on the final bytes) is what closes the gap the schema leaves open. The tracked evidence/desktop-proof.json is the restored 0.1.1 artifact; the r2 proof lives outside the tree, and the writer has no default proof path to silently consume it.

### Parent report and Round24

Both keep the original failures: the committed report (223818f) names the unchanged driver hash 4fea48f4..., the failing line, and forbids session injection, timeout increases, fake responses and reduced assertions. The diagnostic result JSON (exit 1, same hash) and close-1-page-0.txt (Diomedes landing, project in the bar, no cards) corroborate. R1's validation result (exit 1) and close-2-page-0.txt (restarted Console inside the project, Board showing the four items) match the ledger's "passed every first-window check, then failed at restart". R2's result (exit 0) and proof (passed, version 0.1.7, taskCount 4, all flags true, both admission runs, empty pageErrors) match "complete smoke against the preserved cc04e42 package". Round24 distinguishes preliminary from final, keeps the owed list, and claims no regenerated final bytes.

### Limitations

The r2 pass is the parent's independent execution, not mine; I inspected its artifacts only. Exact-79d5 gates and hosted checks are running separately and are not certified here. The desktop proof must still run fresh against the final 79d5 package before it can enter a candidate record. No final package, installer/runtime proof, publication, live AWS, or customer upgrade is claimed or reviewed.