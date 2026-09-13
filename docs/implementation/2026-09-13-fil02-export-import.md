# FIL-02: Console export import and selected weekly-brief sources

Implemented on the requested clean `main` checkout, based on
`212106e75a710242e74620c3c5947aef4bbeef23`. Uncommitted; no commit, push,
publication, deployment, installed-app replacement or release packaging.

Canonical mirrors read: Core Pillars 2026-09-10.1, Live Roadmap 2026-09-12.2,
Project Memory 2026-09-10.7. No product definition or permission preset changed.

## Use the flow

1. Open a project in Console, then Files > Import files.
2. Navigate to the folder containing exports, or enter its full folder path.
   Select exports and remove any unwanted selection before importing.
3. Import selected files copies them into `Imports/<original-name>` in the
   project. The source files remain unchanged. A filename collision refuses
   the batch; rename the source to import another copy.
4. Open Change workspace for the business with the activated weekly-operations
   setup and its bound output project. Check the project files to use, then
   choose Prepare the weekly brief. Import does not select anything implicitly.
5. The draft uses only the checked revisions. If a source changes, uncheck and
   reselect it. Refresh files clears the selection and reloads the listing.

Ordinary inputs need no API calls or files placed at configured fixture paths.
The operator can use arbitrary export names. The old no-selection HTTP request
continues to use the saved configuration's source list for compatibility.

## Implementation and authority

- Imports accept UTF-8 TXT, MD/Markdown, CSV, TSV and JSON, up to eight files,
  1 MiB each and 4 MiB total. BOM and CRLF bytes round-trip unchanged. CSV/JSON
  are preserved as text, without claiming schema validation or computed totals.
- The local browser retains full source paths so `safeAbsolute` can refuse
  private names, private directories, junctions and symlinks before reading.
  Browser uploads that hide the source directory are not used as a bypass.
  Invalid UTF-8, binary/control data, renamed executable/PDF signatures and
  unsupported types are refused. Deleted or changed selections are errors.
- Inspect returns metadata and a SHA-256, without exporting the file text to
  the renderer. Import rechecks the source hash and writes a snapshot through
  `Store.writeRecorded`, under `Store.locked`, with `expected: null`. Existing
  destinations cannot be overwritten. One batch produces one History entry
  attributed to the person, with the normal content hashes and journal recovery.
- Per-run brief references carry project-relative paths and selected hashes.
  The host checks active membership, owner/admin configuration authority for
  replacing the read selection, the bound project, active/ready configuration,
  file paths, count/bytes, source revisions and destination/source separation.
  It rechecks sources before calling the existing recorded writer. The output
  remains a reviewable draft, protected by its previous content hash.
- The saved brief includes source paths and SHA-256 values. The active manifest
  is unchanged; no grant, provider consent, pack activation or configuration is
  created by import or by selecting a source. The brief remains deterministic
  and local. Import does not attach files to unrelated Threads or providers.
- Files previews reuse `DocumentInfo`/`DocumentContent`; TSV and `.markdown`
  now receive the appropriate existing text/Markdown kind. Path guards are
  unchanged. The existing Markdown renderer displays active markup as text.

## Verified

Final focused run on September 13, 2026 at 01:24:32 America/New_York:

```powershell
.\node_modules\.bin\tsc.cmd --noEmit
.\node_modules\.bin\vitest.cmd run tests/file-imports.test.ts tests/weekly-brief.test.ts tests/paths.test.ts tests/business-output-routes.test.ts tests/configuration-routes.test.ts
```

TypeScript passed. Vitest: **59 passed, 1 skipped, five test files passed**.
The existing real Windows short-name generation case is skipped because this
volume does not generate the required alias. The new import suite has 19 cases,
including all six supported extensions through the existing document preview,
private names/folders and junctions, malformed/binary bytes, limits, collisions,
source changes/deletion, linked destinations, HTTP client/origin boundaries and
recorded byte/hash persistence after restart. Brief and route tests cover chosen
source isolation, stale revisions, source races, unchanged active configuration,
output-project mismatch, owner/admin authority and legacy compatibility.

The existing `tests/approval-admission.test.ts` also passed all 46 cases in the
01:20:43 regression run, including exact receipt replay, crash recovery and
external replacement preservation. This is a separate run, not an addition to
the final focused-run total.

Final production UI build and in-app smoke:

```powershell
.\node_modules\.bin\vite.cmd build --outDir test-results/fil02-dist
$env:DIOMEDES_IMPORT_UI_DIST = 'test-results/fil02-dist'
.\node_modules\.bin\playwright.cmd test tests/file-imports-ui.spec.ts
```

Build passed. **One browser smoke passed (7.0 seconds total)** against the built
Console and production `createApp` routes, with owned data and no generation
adapter or provider call. The smoke verifies freshness of the selected bundle;
without the override it uses the normal `dist` build.

The synthetic CSV and Markdown exports are created outside the project, like
downloaded reports. Only development identity/intake are prepared by API. The
test activates the setup in the UI, imports the exports through Files, removes
and re-adds an import candidate, previews the copied files, unchecks a source
before the brief, verifies exclusion and citations, rejects a stale selected
copy, reselects and revises the report, then restarts the host and verifies both
brief History entries and final bytes. Software Engineering is inactive.
Remote Markdown images and script text execute nothing; the browser records
zero external requests throughout the scenario. Screenshots were personally
inspected, including after correcting checkbox width.

Local evidence (ignored build/test artifacts):

- `test-results/fil02-build.log`
- `test-results/fil02-import-selection.png`
- `test-results/fil02-selected-brief.png`
- `test-results/fil02-restarted.png`
- `test-results/report/index.html`

## Scope and roadmap impact

The requested FIL-02 export-import/weekly-brief slice is implemented and proven
locally. This advances Pillars 01, 03, 05 and 09 through deterministic work,
ordinary export input, user-operated setup and unchanged trust/evidence rules.

The broader P05/FIL-02 direction remains larger than this patch: native file
drop/paste, image/PDF/XLSX import or extraction, provider attachment dispatch,
passage references, and FIL-03 durable identity across rename are not included.
No new PDF/vision/spreadsheet capability, hosted Business identity, live-provider
inference or installed/packaged application proof is claimed. The full repository
test suite and general three-spec browser gate were not rerun; no merge is being
performed. The focused production UI smoke fulfills this task's in-app proof.

No canonical cloud document or website was edited. At the next authorized
canonical status reconciliation, replace the blanket "no Console import" status
with this bounded, locally verified capability and retain the remaining work.

## Changed files

- `client/console/BriefFiles.tsx`
- `client/console/FilesPane.tsx`
- `client/console/ImportFiles.tsx`
- `client/console/Workspaces.tsx`
- `client/console/file-imports.css`
- `playwright.config.ts`
- `server/app.ts`
- `server/file-imports.ts`
- `server/paths.ts`
- `server/weekly-brief.ts`
- `server/workspace-routes.ts`
- `shared/file-imports.ts`
- `tests/business-output-routes.test.ts`
- `tests/file-imports-ui.spec.ts`
- `tests/file-imports.test.ts`
- `tests/weekly-brief.test.ts`
- `docs/implementation/2026-09-13-fil02-export-import.md`

Proposed commit: `feat(files): import project exports and select weekly brief sources`
