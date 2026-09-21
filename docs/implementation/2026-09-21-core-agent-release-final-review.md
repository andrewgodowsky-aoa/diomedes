## Independent Review - Round27 Publication and Deployment Records

Reviewer: independent release review session complete-gooseberry. Scope: Round27 (work-items.md:957-1013) and `docs/verification/2026-09-21-core-agent-release.md` in the site worktree, cross-checked against the named deliverable artifacts. Method: native read-only inspection; I executed nothing, and every run result cited is the parent's recorded artifact.

### Verdict

Scoped acceptance. No blocking findings. Both records honestly describe actual observed effects and retain the earlier failures.

### Cross-check results

- Release: `release-v017-public-download-verification.json` shows release 393274078, tag v0.1.7, latestStable, publishedAt 2026-09-21T20:27:44Z; all six assets anonymousDownload+matchesLocal with SHA-256 values, including installer 266,655,455 bytes sha ae024d79... - matching both records byte-for-byte. The tag naming packaged source 6e2f033 (not evidence commit 2b0f60d) is stated correctly.
- Updater: the check JSON's own scope line says no installed copy, download or install was exercised; outcome available 0.1.7, download.ready false, install idle. The records call it metadata compatibility proof and explicitly disclaim a customer upgrade. Accurate.
- Committed record: `proofHashesMatchGitBlobs` true for all three gates (desktopSmoke, installer, installedRuntime), three reviews committed unedited, and changedPaths at 2b0f60d lists only docs/evidence paths - consistent with "only documentation and evidence follow the packaged source".
- Site gates: `site-final-results` retains build pass + browser exit 1, complete:false; the log excerpts (each with sourceLogSha256) show 399 passed, 1 failed, 2 skipped, the failure being the real anonymous installer fetch 404 at download.spec.ts:270 - a genuine prepublication failure, not a synthetic one. `site-published-results` shows the unchanged suite at the same c69e6e6 commit: build+browser exit 0, and its log tail shows 400 passed, 0 unexpected/flaky, 2 skipped. The red/green distinction is preserved exactly as claimed.
- Deployment: deploy log shows Wrangler 4.131.0, 4 changed HTML assets (download, roadmap, docs/releases, docs/getting-started), existing SITE_EMAIL/DB/ASSETS bindings preserved, Current Version ee618219. `deployments-after.json` confirms the newest entry by created_on is 6313cb9c at 20:31:53.878644Z serving ee618219 at 100%, with prior version 656c1600 - matching the records.
- Live verification: five anonymous 200s, redirects 0, every sha256 equal to builtSha256, apex canonicals; www effectiveUrl stays www - and both records correctly frame this as canonical-markup verification, not a redirect claim. Rendered checksum/link/content assertions described accurately.
- `verify-live-release-site.py`: read-only HTTP helper; the roadmap leg gets status/canonical/exact-hash checks and is deliberately excluded from the '0.1.7' version-content assertion, matching the parent's description. The releases leg asserts the three retired capability slugs are absent from data-cap attributes and 'Connections entry is unavailable' renders. No writes, forms, or provider calls.
- App r4 gates at 6e2f033 (5/5 exit 0) and hosted compacts at both 6e2f033 and 2b0f60d (all three checks success) corroborate "all hosted checks passed on both".
- Owed-list honesty: both records keep live AWS/provider, credentials/spend, clean customer setup, older-customer upgrade, signing and Mac desktop open; the site doc's closing lines disclaim a usable Connections screen explicitly.

### Limits

I inspected recorded artifacts, not the systems; I cannot independently recompute downloads, deployments or hosted runs. Nothing here certifies live AWS/provider behavior, real credential or spend exercise, a clean customer install, an actual customer upgrade, code signing, or a Mac desktop build - all remain open per the records themselves.