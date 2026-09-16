# Select a project document for a bounded Console task

Date: 2026-09-12
Worktree: `F:\Diomedes\diomedes-wt\console-task-document`
Branch: `slice/console-task-document-20260912`, based on main `212106e`.

## Implemented

The Console Board's New task form can select an existing project document.
The task stores that exact project-relative path as its optional `sourceDocument`
default and displays it on the Board. A task without this field remains compatible.
Text-route starts, including Codex, present the document selection in the existing
Send this task dialog. The person can keep the saved default, replace it for this
run, or send no existing document. Changing a run's choice does not rewrite the
task default or any previous run.

The picker uses the same guarded document listing as Files. It offers supported
text, Markdown and plan files up to the existing 128 KB source limit and shows
full relative paths to distinguish matching file names in different folders.
The creation endpoint validates the selected path against a fresh listing before
creating a task. Path normalization preserves significant spaces and normalizes
Windows separators without guessing another file.

When there is no saved default, the existing task-name/description matching still
provides the initial start selection. An explicit choice replaces those inferred
sources. Multiple named sources remain visible and can be retained. Listing
failures never become an empty-source fallback. A missing saved file stays visible
as unavailable, and Send is disabled until the selection changes. Dispatch checks
a fresh listing again, so a file moved or hidden after opening the picker blocks
the request.

The UI submits the selected paths through the existing versioned `startWork`
command. `NativeWorkService`, Need approval identities and receipts, source hashes,
`Store.writeRecorded`, History versions and runtime-reported actor attribution
remain the authorities. Selecting a document grants no write permission. There
are no new Workbook controls, document writers, approval paths or provider routes.

## Verification

- Baseline targeted suite: 52 tests passed before implementation.
- Final full Vitest suite: 1,564 passed, one skipped, 92 files. The skip is in
  `tests/paths.test.ts`; it is not counted as passing.
- TypeScript check and Vite client build passed. Vite retains the existing
  dependency annotation and bundle-size notices.
- Browser regression suite: all 32 tests passed across `tests/ui.spec.ts`,
  `tests/native-ui.spec.ts` and `tests/field.spec.ts`. All three focused document
  selection browser cases also passed on the final bundle. The dialog preserves
  the distinction between exact approval and existing task grants.
- The new browser cases exercise creation/reload and per-run selection, capture
  the actual Work command and generator inputs, verify unchanged file bytes
  before approval, approve the exact proposal entirely in the Console, and check
  the attributed History entry and untouched unselected files. The negative case
  covers stale saved paths, disappearance after selection, and listing failure.
- API and shared-helper tests cover persistence, exact relative paths, duplicate
  basenames, explicit-selection precedence, plans, size limits, invalid paths,
  hidden/excluded files and unsupported content types.
- The 1024 px creation form and consent dialog were visually inspected from
  browser captures, including a long nested path.

Owned test profiles and an injected generator only. No real-provider inference
or installed/packaged application verification was performed for this patch.
Logs are in `test-results/console-task-unit.log`, `console-task-build.log` and
`console-task-browser.log` plus `console-task-browser-focused.log`; browser
captures are under `test-results/browser/`.

## Pillar and roadmap impact

Supports the existing Project/Files contract and Pillars 03, 04 and 09 by making
existing project text usable from the Console while preserving selection,
approval and evidence boundaries. No new product definition or roadmap status
is claimed; canonical document versions remain Pillars 2026-09-10.1, Roadmap
2026-09-12.2 and Project Memory 2026-09-10.7.

## Build / publication / deployment status

Client bundle built in this isolated worktree. No desktop package, installation,
commit, merge, push, publication or deployment. All patch files remain uncommitted.
The main checkout was clean at entry and remains untouched by this work.

## Changed files

- `client/console/BoardView.tsx`
- `client/console/Shell.tsx`
- `client/console/TaskDocumentSelect.tsx`
- `client/console/task-document.css`
- `client/console/types.ts`
- `server/app.ts`
- `server/store.ts`
- `shared/task-sources.ts`
- `shared/types.ts`
- `tests/native-ui.spec.ts`
- `tests/task-document-select.test.ts`
- `tests/task-sources.test.ts`
- `tests/work-admission.test.ts`
- `tests/workbench-board.test.ts`
- `docs/implementation/2026-09-12-console-task-document.md`

Proposed commit message: `Add explicit document selection for Console tasks`
