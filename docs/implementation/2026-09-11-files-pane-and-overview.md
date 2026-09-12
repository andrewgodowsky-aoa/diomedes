# The Console Files pane and the project activity overview

**Date:** 2026-09-11
**Worktree / branch:** `F:\Diomedes\diomedes-wt\opus-files`, `opus/files-overview-20260911` (from `main`)
**Slice:** FIL-01, FIL-03 (minimum), FIL-04 (basic), FIL-06
**Uncommitted:** everything below. Nothing committed, nothing pushed, no version bump, nothing packaged.

Canonical documents read for this slice: `docs/DIOMEDES_CORE_PILLARS.md` **2026-09-10.1**,
`docs/product/2026-09-10-project-files-and-agent-overview.md` (approved direction, §1.1, §2, §4),
`AGENTS.md` decisions 1, 2, 4, 5, 6, 12, 13.

---

## Implemented and proven

### A. The Files pane — `client/console/FilesPane.tsx`, `client/console/files.css`

A collapsible, resizable pane bound to the current Project.

- **Off by default, remembered per person.** `localStorage` keys `console.files.open` and
  `console.files.width`, read through a `try`/`catch` so a browser that refuses storage still gets
  the pane — it simply does not remember it. With storage empty the pane does not render at all, so
  the DOM is today's plus one Rail-foot button.
- **A third page column on `.stage`, not a margin trick** (decision 6). `.console .stage.files-open`
  adds `var(--files-w)` as a third grid track; `.console .col` still owns the measure and nothing
  else sets a page column's inline margin. The pane element is last in the stage on purpose, so it
  is column 3 behind whichever screen is showing.
- **Responsive.** The 1100 px rule keeps the pane at the narrower rail width; at 860 px, where the
  stage collapses to one column, the pane switches to `position: absolute` and **overlays** the
  screen instead of squeezing the reading measure or becoming a third row.
- **Resizable** by a `col-resize` grip using pointer capture, clamped 240–640 px, with
  Left/Right arrow keys when the grip has focus.
- **The listing** is `DocumentInfo[]` from the existing `GET /api/projects/:id/documents`, built into
  a tree **in the client** from the flat `/`-joined paths (product doc §2.3 Gap 1, option 1 — no
  tree endpoint, no server change). Folders are collapsed by prefix and expand on click
  (`aria-expanded`); folders sort before files, then alphabetically. Opening a document from the
  palette reveals its ancestor folders so closing it lands on the row.
- **Indicators.** `hasChangesWaiting` shows the `attn` point and the words `changes waiting`;
  `recorded` shows the `done` point and the word `recorded` — the repository's own vocabulary, in
  the same `.pt` grammar the Board and the palette already use.
- **Reading.** `plan` and `markdown` open with a **Rendered / Raw** toggle; `text` opens
  preformatted with no toggle, because a toggle with one meaningful state would be a control that
  says nothing (decision 4). Rendering is a small local component at the grammar the app already
  reads — fenced code, three heading levels, list lines, bold spans — and **no new dependency**.
  There was no Markdown renderer in `client/console/` to reuse; the only one in the tree is private
  to the frozen `client/Workspace.tsx`, which this slice may not touch or import from.
  `DocumentContent.outsideChange` is surfaced as its own sentence when the read reports one.
- **`unsupported` kinds are never read.** `readDocument` refuses binary at `readTextOrNull` and
  answers `404 This document no longer exists.`, which would be a lie about a file that is right
  there. The pane shows kind, size, changed time and path from the listing instead, then the single
  line: *"Open in the app that owns it — this window has no hand-off to the desktop shell, so
  Diomedes cannot start it for you."* There is no external-open path today: `desktop/main.mjs` has
  no preload and no IPC (`// No IPC or preload: this stays in the shell.`), so nothing was invented
  to pretend otherwise. See **Needs the integrator**.
- **No writes to your files, no new routes, no new storage.** `DocumentInfo` and `DocumentContent`
  are the file authority (decision 13). Every byte still arrives through `server/paths.ts`.
- **Reading a file for the first time is recorded, because the existing route records it.**
  `readDocument` in `server/store.ts` writes an `observed` History entry and sets `recorded` on the
  first read of any document — that is the authority path decision 13 names, so this slice uses it
  unchanged rather than adding a quiet read. Two consequences worth stating rather than discovering:
  browsing the pane grows History, and the `recorded` mark on a row can now mean *you opened it* as
  well as *a worker recorded it*. The Workbook does not hit this path, because it gates its rows on
  `disabled={!d.recorded}` (`client/Workspace.tsx` near line 1588) and so only re-reads what is
  already recorded. That divergence is deliberate here and flagged in **Needs the integrator**.
- **Closing returns to the same thread.** Opening, closing and resizing the pane never call
  `setSelectedId` or `setView`; a document opened from Ctrl+K opens the pane over the thread the
  person was already in.

`ProjectState.documents` is never read: `statePayload` strips it from the SSE fan-out
(`server/app.ts` near line 126). The Shell fetches the listing when the pane **or** the palette
wants it, and again on each `state` event while one of them is open. The palette is included
because FIL-01 puts file search in Ctrl+K, and a search over an unfetched listing finds nothing.

### B. File search in Ctrl+K — `client/console/paletteEntries.ts`, `client/console/types.ts`

A `Files` group between `Tasks` and `Workers`. Each row is one document: the file name, then
`kind, folder` plus `changes waiting` / `recorded` where they apply, and one action, `Open`, which
opens the document in the pane (opening the pane if it is shut). `unsupported` reads as `not text`.

Two supporting changes:

- `PaletteEntry.search` — optional text the verb search matches but the row does not print. A
  document's full path goes there, so typing a folder name finds a file whose row shows only its
  name, while the printed row stays inside the palette's fixed width.
- The displayed folder is shortened to its last two segments where it is written (decision 5), so a
  deep path cannot overflow the row.

The pane therefore has **no search box of its own**; the palette is the search surface.

### C. The activity overview — `client/console/activity.ts`, `client/console/ActivityOverview.tsx`

`projectActivity(state: ProjectState, now = Date.now())` returns
`{ working, needsYou, readyForReview, finishedRecently }`, each an array of
`{ id, label, detail, taskId?, threadId?, sessionId?, at }`.

- **A projection, not a state machine.** Every column comes from `taskEvidence` — the existing
  precedent named in product doc §4.2 — plus open `Need`s and History. Nothing is stored; no
  parallel lifecycle is added.
- **Working** is `Queued` or `Working` evidence, which requires an actual session. A task record
  that says `working` with no run behind it is a stale mirror; evidence calls it `Blocked` and the
  overview lists it under **Needs you** with `No active run recorded`, rather than inventing work.
- **Needs you** is one row per open `Need`, plus every `Blocked` task. That is where
  `Task.reason === 'went-wrong'` lands, which §4.2 flags as open for Andrew — a task that went wrong
  is precisely a thing that needs a person, and this follows the document's recommendation rather
  than adding a fifth status.
- **Ready for review** is `Review` evidence **without** an open Need, so one decision never produces
  two rows.
- **Finished recently** is `Done` evidence dated by the latest of the task's last non-undone move to
  `done`, the session's `endedAt`, and the last History entry naming the task — inside a 24-hour
  window, capped at 10 rows, newest first. An undated finish is not claimed as recent. The window is
  a display parameter: it bounds what is listed and prunes nothing (decision 10), and the test
  asserts the records survive.
- Rendered as the empty-Thread screen's content, inside `.col`, under **Working**, **Needs you**,
  **Ready for review**, **Finished recently**. **Empty sections are omitted, not shown as "none"**
  (decision 4), and when all four are empty the screen keeps today's exact sentence, *"Start one and
  it is listed in the rail."* A row click opens its thread, or the Board when the row has none; a
  row never starts, stops or approves anything.
- **The Rail was left alone** apart from the pane toggle. The brief allows a count strip on the Rail
  head "only if the Rail already has a place for counts"; the head is `Threads` plus `New` and has
  no such place, so none was added. The counts that exist stay on the view switch.

### D. Typed callers — `client/api.ts`

`listDocuments(projectId, signal?)` and `readDocument(projectId, path, signal?)` for the two
existing GET routes, both `encodeURIComponent`-safe. No route was added, changed or called that did
not already exist.

---

## Verification

Run in `F:\Diomedes\diomedes-wt\opus-files` on 2026-09-11, from this working tree.

```
$ ./node_modules/.bin/tsc --noEmit
(no output; exit 0)

$ ./node_modules/.bin/vitest run tests/console-activity.test.ts tests/workbench-palette.test.ts \
    tests/workbench-task-evidence.test.ts tests/workbench-board.test.ts
 RUN  v3.2.7 F:/Diomedes/diomedes-wt/opus-files
 ✓ tests/console-activity.test.ts (9 tests) 7ms
 ✓ tests/workbench-palette.test.ts (5 tests) 8ms
 ✓ tests/workbench-task-evidence.test.ts (8 tests) 12ms
 ✓ tests/workbench-board.test.ts (7 tests) 20ms
 Test Files  4 passed (4)
      Tests  29 passed (29)
   Duration  2.70s

$ ./node_modules/.bin/vite build
vite v7.3.6 building client environment for production...
✓ 98 modules transformed.
dist/index.html                       0.46 kB │ gzip:   0.31 kB
dist/assets/index-CBhnjUqb.css      114.58 kB │ gzip:  20.71 kB
dist/assets/index-Zyss-VwP.js       483.24 kB │ gzip: 145.33 kB
✓ built in 868ms
```

Also run, because they import the code this slice touched, and all passing:
`tests/approval-decisions-client.test.ts`, `tests/attribution-shared-ui.test.ts`,
`tests/attribution-ui.test.ts`, `tests/work-start-client.test.ts` — 4 files, 74 tests.

New coverage in `tests/console-activity.test.ts` (9 tests): a queued session is Working and nothing
else; an open Need is one Needs-you row carrying its task and does not also appear under review; a
waiting session with a waiting change is Ready for review; a task finished inside the window is
Finished recently with the move's time; one finished outside it is not, and the records are still
there; a `working` task record with no session does not invent Working; `went-wrong` surfaces as
Needs you; the section caps at ten rows newest first; an empty project yields four empty sections.

New coverage in `tests/workbench-palette.test.ts` (4 added, 5 total): the Files row's name, folder
and marks; `Open` calling `openDocument` for a file Diomedes cannot read as text; a file found by a
folder its row does not print; and file rows staying out of the task verbs.

**Browser proof is pending the integrator's Playwright run.** This slice did not run Playwright and
makes no claim about it.

### Selector check against the three specs

`tests/ui.spec.ts`, `tests/native-ui.spec.ts` and `tests/field.spec.ts` were re-read and every
`getByRole` / `getByText` / `locator` checked against the new markup.

- The pane is off with `localStorage` empty, so the only DOM change on a first load is one button
  labelled `Files` in the Rail foot.
- `field.spec` C01 asks the rail for `New` (exact), `Thread` (exact), `/^Board/`, `/^Team/` and the
  thread names. `Files` matches none of them, and none of them became ambiguous.
- `field.spec` C02 and `native-ui.spec` rely on `#scrThread` appearing and disappearing with the
  view. The pane is a sibling of the screens and does not touch that id or the `.screen.on` rule.
- `field.spec` C04 opens the palette, so the palette now triggers one documents fetch. `POST
  /api/projects` creates an empty folder (`store.createProject`; project state lives in the data
  directory, not the project folder), so the Files group is empty in that spec and the
  `getByText(READY_TASK)` assertions stay unambiguous. `Palette.tsx` was **not** edited: the input's
  `aria-label`, its placeholder and the group heading markup are untouched.
- `field.spec` C04's afterEach forbids uncaught browser errors; both new fetches carry a `catch`
  that renders a caption instead of throwing.
- `field.spec` C07 injects a Need whose `sessionId` does not exist. `projectActivity` runs on every
  Shell render and tolerates that (the session lookup is optional).
- `ui.spec.ts` line 587's `heading "Threads"` is the Rail's `h2`; the pane's `h2` is `Files` and the
  overview's are the four section names, so nothing became ambiguous.
- No existing text, role or `aria-label` was renamed, moved or removed.

---

## Partial or blocked

- **No non-text preview** (product doc item 1.1c). `readTextOrNull` refuses binary by design, so an
  image, PDF or spreadsheet preview needs new server work and a deliberate decision about which
  types are worth rendering. Metadata plus the open-externally line is the honest interim.
- **No open-externally hand-off** (item 1.1j). There is no shell bridge to call. It is a Trust
  question before it is a Files question.
- **No attachments or references into Threads** (item 1.1h, FIL-02). Nothing today lets a Thread
  cite a file, and `ThreadView.tsx` is another worker's file this pass.
- **No History or version inspection in the pane** (item 1.1g) and **no diff**: History carries both
  sides, but no diff component exists (product doc §2.3, Gap 4).
- **Dotfiles and `SKIPPED_FOLDERS` stay invisible**, because `walkDocuments` skips them. That is
  §2.3 Gap 2 and it is Andrew's decision, not this slice's.
- **Project-wide text search** (§2.3, Gap 3) does not exist. Ctrl+K searches the listing's paths and
  names, not file contents, and nothing in the interface claims otherwise.
- The overview reads History only to date and bound `Finished recently`; it does not yet raise a row
  for recorded work that no task owns.

Nothing in this slice is IDE behaviour. There is no code editing, no syntax highlighting, no Git,
no diffs and no repository awareness — that is the Software Engineering Capability Pack tier
(decisions 13 and 14), it is not in this slice, and nothing here may be described as shipping it.

## Exact next action

1. **FIL-02 — references into the Thread.** Select a file (later a passage) in the pane and send the
   reference into the current Thread as context. This is the feature that earns the pane
   (product doc §2.4 step 3). It needs the message-level reference shape and a one-line prop into
   `ThreadView.tsx`.
2. **FIL-04 — broader previews.** Decide which non-text business types Diomedes renders itself
   versus hands to the operating system, then add the server capability for the first of them.

## PILLAR IMPACT

- **Pillar 02 — one configurable Diomedes.** Advanced. The pane is built on `DocumentInfo` and
  `DocumentContent` with no software vocabulary anywhere in it: a restaurant's invoices folder and a
  repository get the identical surface, and the overview's four headings are as true of a supplier
  approval as of a run. Proof: the projection and palette tests use ordinary business documents and
  task names, and no rule, string or code path branches on a project being a repository.
- **Pillar 04 — information and action where the worker needs it.** Advanced, modestly. Files stop
  requiring a trip to the Workbook's Documents page, and the empty Thread now answers "what is
  happening in this Project" instead of stating that nothing is. Both are inside the one Console
  (decision 1), and both survive the narrow width by overlaying rather than crowding.
- **Pillar 08 — human judgment is for judgment.** Held. Every overview row is a way back into a
  record; none of them starts, stops or approves work, and the pane writes nothing. No new place
  exists where a person can be asked to click through something the records already settle.
- **Pillar 12 — one strong core, no artificial crippling.** Held, with a risk named. The Core tier
  really reads the person's files rather than teasing the pack; the pack tier adds capability to
  this same surface and does not replace it (decision 13). The risk to watch is the pane drifting
  into an editor by increments — editing is deliberately last in the product doc's build order, and
  this slice has no mutation path at all.

**Conflicts with a pillar:** none identified.

## ROADMAP IMPACT

Proposed, for the integrator to record after the Playwright gate passes: FIL-01 (file search in
Ctrl+K), FIL-03 (pane shell, tree, read-only viewing) and FIL-06 (the derived human status
projection) implemented in the Console; FIL-04 partially — text and Markdown viewing with a
rendered/raw toggle and metadata for unsupported kinds, but no non-text preview. Until Playwright
runs, none of this is browser-proven and no roadmap row should be flipped on this report alone.

## BUILD / PUBLICATION / DEPLOYMENT STATUS

Nothing packaged, nothing published, nothing deployed, nothing released. `vite build` was run to
produce `dist/` for the type and bundle check; `npm run build` and `npm run package:desktop` were
not run, no version was bumped, no native-runtime hash was touched, and no commit or push was made.

## Needs the integrator

Edits and decisions outside this slice's file list. None of them is required for the slice to
build, pass its gates or be usable.

1. **`client/console/palette.css`** — the palette row's `sub` is `min-width: 0` through its grid
   track but has no wrapping policy of its own. This slice shortens the folder text in JS so nothing
   overflows today; the durable fix belongs in the stylesheet:

   ```css
   .console .palette li .sub { overflow-wrap: anywhere; }
   ```

   Add it inside the existing `.console .palette li .sub` rule.

2. **`client/console/ThreadView.tsx`** — if the thread indicator that worker is adding wants to open
   a document in the pane, the Shell already has the handler. Pass it as one prop on the
   `<ThreadView …>` call in `Shell.tsx` (this slice's file) and accept it there:

   ```tsx
   onOpenDocument={(path: string) => openDocument(path)}
   ```

   Nothing in this slice needs it; it is only the seam if FIL-02 lands next.

3. **Open externally (item 1.1j)** is a Trust decision before it is a Files change. `desktop/main.mjs`
   has no preload and no IPC, so the pane states plainly that it cannot hand a file to the shell.
   When a bridge exists, the single line to change is the `!readable` branch of `Viewer` in
   `client/console/FilesPane.tsx`.

4. **Decide whether browsing should write History** (`server/store.ts` `readDocument`, near line
   782). Opening a text file in the pane writes an `observed` entry and flips `recorded`, because
   that is what the existing read route does for every caller. The Workbook avoids it only by
   refusing to open unrecorded documents. If Andrew wants browsing to stay silent, the change is a
   read that does not record — a route or flag decision above this slice, and a History decision
   (decision 10) besides. Nothing here should be changed unilaterally; it is named so the growth in
   History is a known choice.

5. **Run the full gate set on the merge commit.** This slice ran `tsc --noEmit`, four vitest files
   plus four adjacent client ones, and `vite build`. It did not run the whole vitest suite (other
   agents were verifying concurrently and many suites bind ports) and did not run Playwright.
   `tests/native-ui.spec.ts` asserts `dist/` is newer than `shared/types.ts`, so run `vite build`
   again immediately before Playwright.
