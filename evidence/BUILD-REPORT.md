# Diomedes working application

Built 2026-09-05 in `F:/Achilles/diomedes`. The application is running at **http://127.0.0.1:47631**. Its welcome screen was inspected in the Codex browser. Complete setup, then choose **Open sample project** to explore the Harbor Street workflow. The main user profile has not been prepopulated with test results or example projects.

## What works

- Projects backed by ordinary folders, with explicit sample creation and real File Explorer opening.
- Guided, Standard, and Technical presentation; three-question onboarding; appearance, typography, motion, permission, and service settings that persist.
- Home, Ask, Plan, Work, Review, Tasks, Documents, and History. Plan steps become editable tasks with provenance. Tasks can move between the four specified states.
- Text and Markdown editing with browser draft recovery, stale-file checks, before/after History, named versions, Review, Undo, and restore conflict choices. Host writes preserve supported UTF-8 bytes, including BOM and CRLF, and journal interrupted writes for startup recovery.
- A clearly labeled local sample worker exercises start, stop, approvals, file changes, Review, and History. One open decision is shared across Home, Work, the Tasks card, and project indicators.
- Native ChatGPT/Codex Ask and Plan text generation. Work generates fixed text-file proposals, displays the exact changes, waits for approval, applies the approved bytes through the local recorded-write service, and supports restore.
- LocalAI supervisor availability and readiness observation without inference or lifecycle operations.
- Windows start/stop scripts with recorded process identity, loopback-only hosting, a development launcher, isolated fixture creation, and repeatable tests.

## Design and source reconciliation

The user's request to execute governs this build. Attached document instructions remain source material; the ZIP's earlier foundation-only stopping point does not cancel the current request.

The current v5 Diomedes specifications, `MERGE-NOTE.md`, actual `.dc.html` artifacts, and the user's screenshots govern the interface. The root agent personally inspected the supplied images and rendered Home, Work, Review, Tasks, restore, and mobile results. The implementation uses the artifacts' exact Deep Field OKLCH tokens, four locally bundled font families, 52 px top strip, 232 px rail, 64 px page header, flat borders, split reading area/margin, and approval emphasis. Review and Work were revised after visual comparison to follow the reference framing and context panels more closely.

This is close visual correspondence, not a measured pixel-identical result. The supplied screenshot is cropped/scaled differently, real task names wrap differently, and live counts, times, filenames, status, and service disclosures replace static mockup values. The reference's spreadsheet/Word examples are represented by supported text documents instead of implying those binary formats work.

Original planning documents were preserved. The ZIP manifest was independently checked: **121/121 hashes match**, 122 files including the manifest, no duplicate or unlisted files. Its SHA-256 is `d571dfc6da7cb469e3ca045b2fc14359050a522aa868b7922f1839c65b519543`.

See [source decisions](SOURCE-DECISIONS.md) and [package integrity](package-integrity.json) for the individual conflicts and evidence.

## Verification actually performed

| Check | Result and boundary |
| --- | --- |
| TypeScript | Passed across client, service, shared contracts, scripts, and tests. |
| Production build | Passed; local fonts bundled. |
| Unit/service tests | 62/62 passed: 19 storage/API/worker, 26 native proposal behavior, 17 integration policy/lifecycle. See [unit output](unit-tests.json). |
| Edge browser workflows | 10/10 passed in 18.5 seconds, including same-name draft isolation across projects, Settings/reload recovery, exact saves with History, and stale recovered-draft conflict protection. Tests use actual isolated folders and recorded writes. See [validation notes](validation-notes.md). |
| Native UI controller | Injected generator proves consent, exact preview, approval, write, Review, and History without a provider call. |
| Live native integration | Two successful synthetic native turns. The earlier two attempts failed, including an API-route override error that was corrected by retaining the native authenticated ChatGPT route. No hidden fallback or additional successful turns are claimed. |
| Native Work end to end | One successful synthetic proposal left original bytes unchanged before approval, wrote exactly the preview after approval, recorded Review/History, and restored the original SHA-256. See [native Work proof](native-work-proof.json). |
| Windows write denial | Matching installed runtime/helper versions were isolated in this app; an actual read-only sandbox write probe returned WRITE_DENIED. Source and copied executable hashes matched. |
| Native tool isolation | Empty environments/roots/tools, network disabled for tools, inherited MCP entries disabled and verified before a model turn. Native ChatGPT sign-in was required; no API-key/provider fallback. |
| LocalAI | Live GET status succeeded with `idle_unloaded`. This proves supervisor observation, not generation. |
| Start/stop | Production start, HTTP health, built HTML, identity-checked stop, port closure, restart, and deliberate mismatched-start-time refusal passed. See [launcher proof](launcher-proof.json). |
| Visual inspection | Root inspected rendered screens against supplied references. Installed Edge tests also exercised reduced motion and 390 px layouts. |

The complete F01-F22 acceptance coverage table and unrun cases are in [validation notes](validation-notes.md). Passing the implemented automated checks does not imply every original acceptance clause is covered.

## Remaining scope and limitations

- This is a local browser application with a Node service. An Electron/Tauri desktop shell, packaged installer, remote access, account pairing, and multi-user authentication are not implemented.
- The current editor and history operate on valid UTF-8 text up to 8 MB. Word, Excel, PDF, images, binary diffs, and automatic history-retention cleanup are not implemented.
- Native Work supports selected text plus new-file proposals, at most eight files and 128 KB of output. It has no shell, browser, filesystem, or MCP tools. Diomedes applies the approved proposal; it cannot run arbitrary project builds or perform general autonomous tool work.
- AionCore remains unconfigured because its proposed host foundation was not established by the supplied material or the completed runtime proof. This build does not claim full foundation P1-P5 acceptance. Claude/OpenCode adapters, Hermes work execution, LocalAI generation, remote pairing, and business-service connections remain outside the proven integration surface.
- External edits are detected when files are read; unseen intermediate edits cannot be reconstructed. Automatic history coalescing/pruning and exhaustive recovery across every possible filesystem failure are not claimed.
- Keyboard/assistive-technology audits, native Windows 150 percent scaling, text-spacing overrides, all alternate onboarding branches, and user acceptance remain unverified. See the coverage table for narrower boundaries.
- The loopback API has Origin/Host and mutation-header checks, but no local bearer-token authentication. Other local processes can access it. It is not suitable for public exposure.

Existing production LocalAI/Hermes services and credentials were preserved. Package installation used a task-local cache and the system certificate store; TLS verification remained enabled. No startup registration, tunnel, global package, Git commit, push, or external message was created.

## Running and stopping

From `F:/Achilles/diomedes`:

```powershell
./Start-Diomedes.ps1
./Stop-Diomedes.ps1
```

The running production listener serves **http://127.0.0.1:47631**. For development, stop it and run `npm run dev`, then open **http://127.0.0.1:5173**. Build with `npm run build`. The full instructions and integration setup are in [README](../README.md).

## Proposed commit and changed-file scope

No commit was created. Proposed message: `feat: build Diomedes workspace from v5 designs with recorded edits and native Codex proposals`.

All additions are beneath `F:/Achilles/diomedes`; no original planning file belongs in this commit. The following is the reviewable source set, with exact individual files and hashes in [source manifest](source-manifest.json):

- Root: `.gitignore`, `.prettierrc.json`, `README.md`, `Start-Diomedes.ps1`, `Stop-Diomedes.ps1`, `index.html`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`.
- `client/`: `App.tsx`, `Workspace.tsx`, `Setup.tsx`, `Settings.tsx`, `components.tsx`, `api.ts`, `main.tsx`, `styles.css`.
- `shared/`: `types.ts`.
- `server/`: `app.ts`, `index.ts`, `paths.ts`, `store.ts`, `work.ts`, `native-work.ts`, `integrations.ts`.
- `scripts/`: `dev.mjs`, `fixtures.ts`, `prepare-native.ts`, `native-work-smoke.ts`.
- `tests/`: `backend.test.ts`, `native-work.test.ts`, `integrations.test.ts`, `ui.spec.ts`, `native-ui.spec.ts`.
- `licenses/`: the four bundled font licenses.
- `reference/`: selected read-only copies of package documents used in source reconciliation.
- `evidence/`: this report, source decisions, package integrity, unit output, integration/native Work/runtime proofs, launcher proof, validation notes, source manifest, and representative screenshots.

Do not include `.data`, credentials or user configuration, test project contents, dependency/cache folders, or generated build output. Those runtime locations are ignored.
