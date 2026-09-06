# Diomedes validation notes

Date: 2026-09-05.

## Source integrity

The supplied `C:/Users/andre/Downloads/Achilles_Astra_Package_2026-09-05.zip` was read in memory with Python 3.12. Every listed file was hashed independently against `MANIFEST.sha256`. All 121 manifest entries matched. The archive contains 122 files including the manifest, with no duplicate or unlisted entries. No original documents were extracted or overwritten.

Archive SHA-256: `d571dfc6da7cb469e3ca045b2fc14359050a522aa868b7922f1839c65b519543`.

Full file-level evidence: `package-integrity.json` in this folder.

## Verification scope

The current local v5 design handoff `12-astra-handoff-diomedes-v1.md` and mechanism appendix `24-astra-handoff-implementation-appendix-v1.md` supplied acceptance tests F01-F22. Browser tests are defined in `tests/ui.spec.ts`. They run against a fresh, dedicated data directory under `test-results`, with a dedicated service on `127.0.0.1:47632` and interface on `127.0.0.1:5174`. The already installed Microsoft Edge executable is used; no browser is downloaded. Existing app data and user projects are not reused for the automated run.

Each run retains a Playwright HTML report, failure traces, and screenshots under `test-results`. Screenshots captured during tests demonstrate the rendered states; visual parity requires a person or root agent to inspect them against the v5 boards.

The browser tests exercise actual local file changes, persisted app state, project navigation, approval decisions, Review and History. Read-only API assertions verify that the UI actions reached persisted application state. They do not send prompts to paid or online services.

## Results

- ZIP integrity: PASS, 121/121 entries.
- Launcher JavaScript syntax: PASS with bundled Node.js v24.19.0 (`node --check scripts/dev.mjs`).
- Isolated live launcher smoke: PASS. The health endpoint returned HTTP 200 with the dedicated `test-results/launcher-smoke` data/project roots. Windows reported service PID 51976 bound to `127.0.0.1:47632` and Vite PID 41348 bound to `127.0.0.1:5174`. After Ctrl+C, both listening ports were absent and the service lock was released.
- Sample fixture CLI: PASS against that isolated service. It created a Harbor Street sample with `Reopening plan.md`, `Fall menu.md`, and `Opening notes.txt`; the original documents were not used as writable fixtures.
- Validation TypeScript and test discovery: PASS; the fixtures CLI, browser test file, and Playwright configuration typechecked and Playwright discovered the suite.
- Final browser run: PASS, all ten tests in 18.5 seconds against installed Edge, with 1440 x 900 desktop and 390 x 844 mobile viewports. The final sample run used `test-results/app-data-1788598409211-6488`; the native-controller UI scenario used its own `test-results/native-ui-*` folder and loopback port 47634. There were no uncaught browser errors. All three test listeners (47632, 47634, 5174) were gone after Playwright finished. `test-results/browser/.last-run.json` reports `passed` with no failed tests.
- Final full-project TypeScript check and Vite production build: PASS immediately before the final browser run. The native UI scenario served that freshly built production client.
- F20 output: zero banned-word matches on each of Home, Ask, Plan, Work, Review, Tasks, Documents, and History at both Guided and Standard (16 rendered page/profile combinations).
- Visual comparison: the validation agent inspected generated Home, Tasks, Review, Work Technical, native proposal preview, and mobile screenshots. Frame colors, typography, columns, and rail follow the supplied visual system. The final Review screenshot now has the task-specific title, framed change card, top actions, and contextual margin. The final Work screenshot has a current-task title and contextual technical details. Waiting task cards expose the four direct decision controls. Source fixtures and running/stopped state differ from the static reference boards, so these observations do not establish pixel-identical parity. Root-agent inspection is separate.
- User acceptance, real online-service responses, native Windows scaling at 150 percent, and assistive-technology testing: not verified here.

## Copy-test boundary

F20's banned-word test runs on the post-onboarding project pages. The supplied onboarding specification itself includes `models` in the Technical option description, which conflicts with a literal interpretation of banning that word anywhere visible to a Guided user. The original design documents remain unchanged.

## Acceptance coverage in the browser suite

This table describes what this agent actually ran. Service-only tests from the backend and integration agents are separate evidence.

| Requirement | Browser result | Evidence boundary |
| --- | --- | --- |
| F01 | Partial pass | Fresh welcome and Q2 reload/resume pass. Skip-middle choice not exercised. |
| F02 | Pass | Business, Guided, New to this persist the intended defaults. |
| F03 | Not run | Alternate complete Technical onboarding flow not exercised. |
| F04 | Pass | Explicit sample action creates exactly three documents and opens the project. |
| F05 | Not run | Opening a separate folder containing `.git` was not exercised. |
| F06 | Partial pass | A real edit has different before/after images and survives reload. Unsaved writing also survives reload and project switching, and a stale recovered draft cannot overwrite a newer file. Coalescing and the 11-minute boundary are service-test concerns. |
| F07 | Pass | Per-entry restore returns the before-image and the UI Undo returns the after-image; both are recorded. |
| F08 | Partial pass | A newer real edit triggers all three conflict choices; unchanged-only preserves that edit. Forced overwrite and copies are covered separately by service tests. |
| F09 | Not run in browser | Sample Plan generation is covered separately by service tests. |
| F10 | Pass | Five selected steps become tasks with plan provenance and a task-creation History entry. |
| F11 | Pass for work mechanism | Task start reaches a real approval; work continues and writes a real file change. Motion was checked separately as reduced-motion behavior. |
| F12 | Pass | Same open need appears on Home, Work, the project-tab mark, the Tasks rail count and the waiting task card. All four card controls are visible; declining directly on the card clears the need and tab mark and records History. |
| F13 | Pass | Declining creation leaves Sample work notes.md absent while the plan update completes. |
| F14 | Pass | Stop settles within the one-second assertion, expires open needs, and records the stop. |
| F15 | Pass | Review exposes the waiting change; Keep all clears review and completes its task. |
| F16 | Pass | History has recorded rows and View changes exposes Restore this file. |
| F17 | Pass for state | Technical and Guided switches preserve tasks, changes, History and do not reload. Technical Show log appears. Scroll restoration across every page was not exhaustively tested. |
| F18 | Not run | Missing-folder rename/recovery not exercised in the browser. |
| F19 | Not run in browser | Partial-fault behavior is covered separately by service tests. |
| F20 | Pass | Zero matches across 16 rendered page/profile combinations. |
| F21 | Partial pass | Visible Home text is at least 14 px and every Home button at least 36 px. Full keyboard, assistive-technology and contrast audit remains separate. |
| F22 | Partial pass | Reduced motion has zero running transitions/animations. Home, Tasks and History fit a 390 px viewport. WCAG text-spacing override and Windows 150 percent scaling not exercised. |

The full passing command was the bundled Node executable followed by `node_modules/@playwright/test/cli.js test` from `F:/Achilles/diomedes`. Playwright's report is `test-results/report/index.html`; state screenshots are in `test-results/browser`. Screenshot capture disables in-flight animations to provide stable frames for visual review.

## Native-controller UI scenario

`tests/native-ui.spec.ts` starts a separate `createApp` instance with an injected generator and the production frontend. It uses actual HTTP, server-sent events, approval records, project files, Review, and History. Only the generator is simulated. Assertions prove:

- Opening the online consent dialog invokes no generator and changes no file.
- Continuing invokes the injected generator once with exactly the selected plan's content.
- `Show me first` displays the exact proposed addition while the project file still matches its original bytes.
- `Go ahead` applies the proposed bytes through recorded storage.
- Review `Keep all` completes the task, and History contains different before/after images and the approval decision.

This browser scenario makes zero actual model calls and consumes no provider quota. The root agent's separate live native integration proof is separate evidence and is not claimed by this test. Native consent, proposal preview, and Review screenshots are retained under the native browser-test result folder.

## Unsaved draft recovery

The focused draft test passed independently in 4.9 seconds (one test; isolated data `test-results/app-data-1788598270803-51196`) and passed again in the final ten-test suite. It creates two synthetic projects with the same plan filename, then verifies that:

- Unsaved writing survives opening Settings, changing detail, switching projects, and reloading the page.
- Each project recovers only its own draft; saving both writes the exact expected text to their separate files.
- History records the original and saved text for the recovered edit.
- After a direct external edit to the isolated test file, reloading still recovers the unsaved writing. Saving opens `Newer changes are in the way`, preserves the external file bytes, and leaves the recovered draft available for editing.

The test establishes a named baseline version before editing so the creation entry does not coalesce with the save. Direct disk writes are limited by a path guard to the generated project folders inside `test-results`. Screenshots `recovered-draft.png` and `recovered-draft-conflict.png` capture recovery and conflict states. The production service on port 47631 and its project data were not modified by this test.

## Problems found and corrected during execution

- Font package v5.3 exports append `.css`: an import ending in `/800.css` resolved to `800.css.css`. The root agent changed the imports to extensionless paths and Vite then served the UI successfully.
- A browser-test `check()` expected synchronous radio state, while this app saves the choice through the local service. The test now clicks and waits for the persisted checked state, matching the working interface behavior.
- Composer mode buttons initially measured 34.046875 px. The root agent gave them a 36 px minimum; the complete browser run then passed.
- Independent backend review identified stale review conflict markers built before a write and mismatched appearance-package enum values. The backend agent corrected both before the passing browser run.

## Process ownership

`scripts/dev.mjs` starts only its own local service and Vite child processes using the current Node executable. It uses no global install, `.cmd` launcher, startup registration, tunnel, or public binding. Ctrl+C terminates those owned child process trees by PID on Windows; it never terminates processes by image name. Browser-test cleanup uses the same launcher.
