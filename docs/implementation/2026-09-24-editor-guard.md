# Editor exit guard and settled file kind (DIO-85, DIO-87)

- **Lane / branch:** `editor-guard` / `bugfix/editor-unsaved-guard`, from `main` `559a1ab`.
- **Canonical documents read:** Core Pillars 2026-09-22.1, Live Roadmap 2026-09-23.1, Project Memory
  2026-09-23.1, `AGENTS.md` standing decisions 1–14.
- **Scope:** the Console document editor (`client/console/DocumentEditor.tsx`), the exits around it
  in `client/console/Shell.tsx` and `client/App.tsx`, one focus rule in `client/console/Palette.tsx`
  and the desktop window's unload question in `desktop/main.mjs`. No server, route, type or
  settings change.

## 1. Repro on main

Both issues were reproduced in a browser against `main` `559a1ab` with the new spec
`tests/editor-guard-ui.spec.ts` (built `dist/`, own in-process service, Chromium):

| Test | Result on main |
|---|---|
| DIO-85: with no backup to keep the writing, every exit from the editor asks first | **Fails** at the first exit: with the draft backup refusing writes (`Storage.prototype.setItem` throws `QuotaExceededError`) and file A dirty, "Write in this file" on file B replaces the editor at once; the "You have writing that is not saved" question never appears and A's writing is gone. |
| DIO-87: a file whose kind the listing has not settled cannot be typed in yet | **Fails**: after a conflict's "Save my writing as a separate file", the copy (not yet in the listing) opens under the synthetic `kind: 'markdown'`, is read at once and reads "All saved" with an editable text box while every listing is still held. |
| DIO-87: writing already in the box is never stranded by a later kind | **Fails**: once a listing reports the open file as `unsupported`, the dirty editor stops reading "Not saved yet" and Save disappears, stranding the writing. |
| DIO-85: closing the window with unkept writing asks the browser to stop first | Passes on main (behaviour kept). |
| DIO-85: with the backup working, leaving keeps the writing and brings it back | Passes on main (behaviour kept). |

`tests/editor-guard.test.ts` fails on main because `client/console/editor-guard.ts` does not exist.

The audit's DIO-87 route ("open from History before the file list resolves") belonged to the retired
Workbook: no Console History control opens the editor today. The synthetic fallback was still live,
and reachable from the Console through the rescue-copy hand-off above and through any listing that
did not (yet) carry the open path, which is what the second and third rows exercise.

## 2. Root cause

- **DIO-85.** The editor's own Close asked before discarding, but the Console had no single exit. The
  rail and a rail thread refused with a toast; opening another file from Files called `setEditing`
  unconditionally; the header's Settings, Projects and project tabs and the top strip called `App`
  directly, which unmounts `Shell` (keyed per project) and the editor with it; palette navigation
  changed the view underneath the editor. When the localStorage draft backup failed, every
  unguarded path lost the writing.
- **DIO-87.** `Shell` passed `documents.find(...) ?? { kind: 'markdown', ... }`. A path the listing
  did not have got a guessed writable kind, so the editor read the file and took typing; when the
  real kind arrived the editor recomputed `supported` from the prop and turned read only with no Save.

## 3. The fix

**One gate.** `client/console/editor-guard.ts` holds the Console's single exit gate:
`leaveEditor(then)` runs `then` at once when no editor is open and otherwise hands it to the editor.
`Shell` installs the gate while it is mounted (`guardEditorExits`), and `DocumentEditor` fills it
through its new `exits` prop. The editor's rule (`requestLeave`):

1. No unsaved writing: let the exit through.
2. Unsaved writing: write the draft backup **now**. If it holds, let the exit through; the writing
   comes back with "We brought back writing you had not saved." when the file opens again (the
   existing recovery, pinned by the per-project draft scenario in `tests/ui.spec.ts`).
3. The backup will not hold: ask, with the editor's existing "You have writing that is not saved"
   panel (Save and close / Keep writing / Throw my writing away). The exit runs only after Save
   lands or the person throws the writing away. Keep writing (or Escape) cancels it and returns
   the keyboard to the text box. The panel takes focus when it opens, as it already did for Close.

The existing in-editor panel was reused rather than a new dialog, because it is the Console's
established question for exactly this decision, with the same three answers.

**Settled kind.** `editorDocument(documents, path, failure)` returns the listing's record or an
unresolved `{ path }` (with the listing's failure as `problem` when it could not be read). It never
invents a kind. The editor latches the kind the first time one arrives: until then it reads
nothing, shows "Opening" with no text box and a disabled Save, and Ctrl+S does nothing. Once
settled, a later listing cannot change it, so edits can never exist in a box that then becomes
unsavable. The read route is not called for a file of unknown kind, so no first-read History record
is made for one either.

## 4. Every exit, and how it is guarded

Found by grepping every setter that changes the open document (`setEditing`), the view
(`setView`, `setSelectedId`) or the screen above the Console (`setSelected`, `setShowSettings`,
`setLanding`), and every palette handler.

| Exit | Where | Guard |
|---|---|---|
| Open another file ("Write in this file") | `Shell` → `FilesPane onEdit` | `leaveEditor(() => setEditing(path))`; the same file is a no-op |
| Rail destination (Thread, Board, Team, Discovery, Readiness, Files, Engines, Settings, Projects) | `Shell.goTo` | re-enters itself through `leaveEditor`; replaces the old toast refusal |
| Rail thread | `Shell` Rail `onSelect` | `leaveEditor` |
| Rail new thread | `Shell` Rail `onNew` | `leaveEditor` |
| Header "needs your OK" | `Shell.reviewElsewhere` button | `leaveEditor` |
| Palette: Review, Board, Team, Message, Thread, view entries, Use (playbook) | `paletteCtx.handlers` | wrapped with `leavingEditor` |
| Palette: Open project | `onOpenProject` | guarded in `App.openProject` |
| Header Settings, Rail Settings/Engines, usage chip, top-strip Settings | `App.openSettings` | `leaveEditor` |
| Header Projects, Rail Projects, top-strip Projects | `App.showProjects` | `leaveEditor` |
| Header/top-strip project tab, "Open a project" search result | `App.openProject` | `leaveEditor`, except for the project already open |
| Browser reload/close | `beforeunload` in `DocumentEditor` | asks only when the backup will not hold the writing |
| Desktop window close / quit / update restart | `will-prevent-unload` in `desktop/main.mjs` | native "Keep writing / Close and lose it" question; Electron otherwise refused the close silently |
| Editor Close | `DocumentEditor.close` | always asks when dirty (unchanged) |
| Rescue copy hand-off | `DocumentEditor onOpen` | leaves without the gate: the writing is on disk in the copy |
| History open | none in the Console | no Console History control opens the editor; if one is added it must call `leaveEditor` |

Not exits (the editor stays mounted): the palette's Open file and the artifact panel's file link
(both open the Files pane beside it), Stop/Start/Route/Reopen, the Design Center, Cloud sharing,
the workspace panel and the ··· menu. Background view changes (a wake finishing, a first-task
hand-off) change the view behind the editor and never unmount it.

The palette used to refocus the composer a tick after running any action, which took focus off the
question when an action was stopped by it; it now leaves focus where an action deliberately put it.

**Behaviour change to note:** with a working backup, the rail and a rail thread now leave a dirty
editor (the writing is kept and offered back), where they used to refuse with a toast. That makes
them match Settings and project switching, which already left and recovered, as
`tests/ui.spec.ts` pins. A browser reload with a working backup no longer shows the native
leave-page prompt; the writing is recovered on reopen, as before.

## 5. Tests

- `tests/editor-guard-ui.spec.ts` (new, added to `playwright.config.ts` `testMatch`): the five
  scenarios in section 1. The DIO-85 scenario drives each exit above that is reachable from the
  editor screen (Files, header Settings, header Projects, a project tab, a rail thread, a rail
  destination, palette view navigation), checks the question has focus, the editor and every word
  are still there, and Keep writing returns focus to the text box; then Throw away (goes to file B,
  file A unchanged on disk) and Save and close (writes the file, then Settings opens).
- `tests/editor-guard.test.ts` (new, vitest): the gate contract, `editorDocument` never guessing a
  kind, and source checks that `Shell` only changes the open file through the gate, Close and the
  rescue copy, that `App`'s Console-leaving controls use the guarded helpers, and that the desktop
  shell handles `will-prevent-unload`.
- The Electron dialog itself was not exercised (no packaged run in this lane).

## 6. Proposed canonical-doc patch

Live Roadmap, Console bug-fix record (append; no status or milestone changes):

> DIO-85 / DIO-87 (2026-09-24, `bugfix/editor-unsaved-guard`): every way out of the Console
> document editor passes one exit gate (`client/console/editor-guard.ts`); unsaved writing is kept
> in the draft backup or the person is asked first, including window close. The editor takes no
> typing until the listing has settled the file's kind, and a settled kind never changes under
> writing. Regression: `tests/editor-guard-ui.spec.ts`, `tests/editor-guard.test.ts`.

Project Memory: no definition changes.

## 7. PILLAR IMPACT

No pillar conflict. Advances the evidence and trust posture of the one surface (decisions 1, 13): no
path silently discards a person's words, and the editor no longer acts on a guessed file authority;
`DocumentInfo` from the listing stays the only kind authority.

## 8. ROADMAP IMPACT

None to status. Closes two audited Console bugs (DIO-85 S2, DIO-87 S3) pending merge.

## 9. BUILD STATUS

Branch only; not merged, not packaged, not released. Gate results are in the lane's final report.
