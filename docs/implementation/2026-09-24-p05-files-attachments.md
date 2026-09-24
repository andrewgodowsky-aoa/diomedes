# P05 — Core Files: drop and paste, previews, Thread attachments and durable identity

**Date:** 2026-09-24
**Lane / branch:** `p05-files-attachments`, `feature/p05-files-attachments-previews` (from `main`)
**Linear:** DIO-31 (P05 — Core Files: attachments, previews and durable artifact identity)
**Canonical documents read:** Core Pillars 2026-09-22.1, Live Roadmap 2026-09-23.1, Project Memory
2026-09-23.1; `AGENTS.md` standing decisions 1–14 (12, 13 and 14 in full);
`docs/product/2026-09-10-project-files-and-agent-overview.md`,
`docs/implementation/2026-09-11-files-pane-and-overview.md`,
`docs/implementation/2026-09-13-fil02-export-import.md`.

No canonical document, `QUESTIONS.md`, version number or native-runtime hash was edited. The
exact proposed canonical-doc patch is at the end of this record for the integrator.

---

## What shipped

Everything below goes through the existing Project, `DocumentInfo`/`DocumentContent`, History and
recorded-write primitives. There is no new file authority, no second surface, no new dependency,
and no change to what any engine is permitted to read.

### 1. Drop and paste into Files

- **Drop** files from the operating system anywhere on the Files pane; **paste** a picture or
  plain text while focus is in the pane (a paste into a field inside the pane stays with the
  field). A pasted picture or text gets a dated name (`Pasted image 2026-09-24 101500.png`).
- **One recorded write.** `server/file-drops.ts` → `Store.writeRecorded`, under the store lock
  the route helper takes, `actor: 'you'`, `merge: false`, `expected: null` (never overwrites).
  One drop or paste is one History entry, labelled `Dropped into Files` / `Pasted into Files`,
  with the sentence `You dropped 3 files into Files.`
- **Destination and collisions.** Files land in `Imports/<name>` as Import files does; a taken
  name gets the next free `name (2).ext`, probed on disk and within the batch, compared without
  case. The result names every renamed file.
- **Path guards unchanged (decision 11).** The name is reduced to its last segment, then goes
  through `relativeName` and `projectFile`/`safeAbsolute`, so private names (`credentials.json`),
  hidden names (`.env.md`), reserved names and a linked/junctioned `Imports` folder are refused.
- **Limits.** 8 files per drop; text 1 MB each (the Import files limit); pictures, PDFs and
  workbooks 10 MB each; 24 MB per drop; a picture over 40 megapixels is refused before any
  window decodes it. One refused file refuses the whole batch before anything is written.
- **Types.** UTF-8 TXT/MD/Markdown/CSV/TSV/JSON (as Import files), PNG, JPEG, GIF, WebP, PDF,
  XLSX, and SVG drawings that pass svg-check (`shared/svg-check.ts`).
- **Bytes decide, not names (`shared/file-drops.ts`).** A name whose extension disagrees with its
  sniffed bytes is refused in words: a PNG named `.pdf`, a PDF named `.txt`, an executable named
  `.png`, an SVG named `.png` or `.txt`, a non-workbook ZIP named `.xlsx`.
- **Binary through the one writer.** `writeRecorded` now accepts `bytes` in place of `text` for a
  person's own write only; the journal, the content-addressed object store, History entry, crash
  recovery and path guards are the same code, with the before/after images named by the SHA-256
  of their bytes (for UTF-8 text this equals the existing text hash, so nothing already recorded
  changes). **A model, a task or an approval still writes text only.** A binary file's History
  record carries `binary: true`; History's changes view describes it rather than decoding it as
  text, and restoring it is refused in words (see gaps).
- The listing keeps every non-text kind `unsupported`, so no text gate (task-source selection,
  grants, proposals) starts admitting a picture.

### 2. Previews (read-only, content-sniffed, truthful "can't preview")

- **Pictures** (PNG/JPEG/GIF/WebP): `GET /api/projects/:id/documents/picture` serves bytes only
  when the bytes are one of those four and within the pixel limit — whatever the file is named —
  with `Content-Type` from the sniff, `nosniff`, `Content-Security-Policy: default-src 'none';
  sandbox` and `no-store`. The Console shows it in an `<img>` under the app's existing
  `img-src 'self'` policy (no CSP change). A file named as a picture whose bytes are not one, an
  oversized picture and an undecodable one each get their own sentence.
- **SVG** stays on the existing sanitised drawing path (the `drawing` kind, svg-check on the way
  in, the sandboxed artifact frame on the way out). It is never served as an `<img>`.
- **PDF:** described, never rendered — header version, size, whether it declares encryption, and
  its identity — plus: *"Files has no in-app PDF viewer in this build. This window has no hand-off
  to the desktop shell, so open it from the project folder in the app that owns it."* The app CSP
  is `frame-src 'none'; object-src 'none'` and the desktop shell has no file hand-off, so an
  in-app viewer would need a CSP change, a new dependency or a new desktop capability. Recorded as
  a gap, not worked around.
- **CSV/TSV:** a Table view (default) beside Raw. RFC 4180 quoting, 100 rows a page with
  Previous/Next, 50 columns, 500 characters a cell, and notes for clipped columns or an unclosed
  quote. Cells are exactly the text between delimiters; nothing is typed or computed.
- **XLSX:** the first sheet as the same bounded table, read by `server/xlsx-preview.ts` with
  Node's own `zlib` (no new dependency). Only four parts are inflated, each with an 8 MB output
  cap (a small file that would inflate past it is refused in words). Values are shown as the
  workbook saved them; the preview says formulas are not recalculated and dates are serial
  numbers. Other sheets are named, not shown.
- **Versions.** Every file lists the versions History holds (newest first, current disabled);
  each opens by identity.

### 3. Attachments into Threads

- **Attach** from the composer (`Attach` → a picker of project files) or from Files (`Attach to
  thread`, offered only while a Thread is open). Attached files show as chips in the composer;
  each opens the file in Files and can be removed.
- **Delivered through the existing context path.** An attachment is exactly one of the message's
  selected sources — the same `sources` list, the same host reads through `readDocument`, the same
  cloud-sharing check, the same 8-document and 128 KB limits — so the send confirmation lists it
  where it already lists documents, and no route, grant or read scope widens. Attachments lead the
  list; documents the message names are added after them as before.
- **If the route can't receive it, it says so.** Every route receives project files only as text
  documents, so a picture, PDF, workbook, drawing or a file over 128 KB is marked `not sent` on its
  chip, and pressing Send shows *"photo.png is not a text document, so a message cannot carry it to
  an engine. It stays in Files; remove it to send."* Nothing is sent silently without it.
- **The reference on the Thread.** Every sent message shows a chip per file it carried —
  `brief.md v0007 · 64333027` — which opens that exact version in Files.

### 4. Durable artifact identity

- **Identity = `{ sha256, project-relative path, History version }`** (`shared/file-identity.ts`).
  It is a projection of History, not a second record: History already keeps content-addressed
  before/after images for every recorded write, so an identity is looked up from entries a person
  can already read. A version is named by the entry that first recorded its bytes.
- **Thread references point at the exact version.** The direct request path now records
  `Turn.sourceVersions` (`{ path, sha }` per source) when it writes the person's turn. Older turns
  and conversation-route turns resolve by the version History recorded at or before the turn
  (every source is read through `Store.readDocument`, which records what it read before returning).
- **Opening an older reference** (`GET /api/projects/:id/documents/version`) serves the bytes only
  when History recorded exactly that `{ path, sha }` pair (a sha recorded for one path never opens
  another), from the object store; otherwise it says *"History has no record of this version"* or
  *"This version is no longer available. History records it, but its contents were not kept."*
  The view is labelled `older version from History` and offers `Open the current file`.
- **Generated artifacts** written to project files by a worker go through the same recorded
  writer, so they carry the same identity.

---

## Verification

Environment: Linux cloud container, Node from the repo, Chromium from `/opt/pw-browsers`
(`PLAYWRIGHT_EXECUTABLE_PATH`). Counts below are from this lane's own run after merging
`origin/main`; see the PR body for the final head's numbers.

New and changed tests:

- `tests/file-drops.test.ts` (31): every accepted kind in one attributed entry with exact bytes;
  paste label; collision renaming on disk and in batch without overwrite; ten byte-vs-name
  refusals (mismatches, executables, scripted SVG, pixel bomb, empty); whole-batch refusal;
  count/per-file/total limits; name reduction and guarded names; linked `Imports`; models cannot
  write bytes; binary restore refused in words; History changes describe binaries; restart and
  crash recovery of a binary write; pictures served by bytes only (renamed, disguised, oversized,
  traversal); PDF/picture facts; older text version by identity, unrecorded and mismatched pairs
  refused, pruned object "no longer available"; older picture version from History; raw body
  framing; production HTTP routes (client header, nosniff, sandbox CSP, Origin refusal); XLSX
  shared/inline/boolean/number cells, gaps, entities, paging, inflate cap, non-workbooks.
- `tests/file-identity.test.ts` (23): content sniffing (12 cases), name/bytes agreement, name
  cleaning and dated paste names, collision naming, preview kinds and PDF facts, CSV/TSV quoting,
  paging and clipping, unclosed quotes, versions/identity/`versionAt`, labels, `turnReference`.
- `tests/composer-attachments.test.ts` (1): what an attachment may carry.
- `tests/files-attachments-ui.spec.ts` (Playwright, 1 scenario, built Console + production
  routes): OS drop of a PNG that renders from its bytes with its identity; second drop renamed;
  mismatched PDF refused; real PDF described; XLSX first sheet as a table; pasted text and pasted
  picture; CSV table paging; attach from Files; a picture attachment refused before sending;
  sending carries the chip `brief.md vNNNN · xxxxxxxx`; after the file changes the chip opens the
  older version from History; `Open the current file`; the version list. Zero external requests
  and zero CSP violations asserted.
- `tests/file-imports-ui.spec.ts`: the import smoke now checks the CSV table *and* the exact raw
  bytes (`Raw` → `Tables,7`), because a CSV opens as a table by default. The assertion is kept,
  not removed.

---

## Known gaps (not shipped; nothing here claims them)

- **No in-app PDF viewer** and **no open-externally hand-off**: a PDF is described with a
  sentence saying where to open it. A viewer needs a CSP change, a dependency or a desktop IPC.
- **Restoring a picture, PDF or workbook from History** is refused in words; its versions stay
  kept and viewable.
- **Pictures, PDFs and workbooks cannot be sent to an engine** as message attachments: every
  route receives project files only as text. Provider attachment dispatch (vision/PDF input) is
  not built; the composer refuses rather than dropping the file silently.
- **XLSX:** first sheet only, saved values only (no recalculation, dates as serial numbers), no
  ZIP64, no styles/merged cells.
- **Identity does not follow a rename**: a moved file is a new path; old references still open
  the bytes History kept at the old path.
- **Conversation-route turns** resolve their version from History by time rather than a recorded
  sha (the direct path records the sha). A file changed and recorded during a long model call
  could resolve to the newer version; the direct path is exact.
- **Paste needs focus inside the Files pane** (by design, so a paste into the composer stays a
  paste of text into the composer).
- No IDE-grade editing, Git, diffs or LSP is claimed or added.

---

## Proposed canonical-doc patch

For the integrator to apply at reconciliation (this lane did not edit these files).

**`AGENTS.md`, decision 13** — replace the sentence beginning "FIL-02 (2026-09-13, …)" through
"…is still open." with:

> FIL-02 (2026-09-13, `docs/implementation/2026-09-13-fil02-export-import.md`) adds local export
> import through that same pane and the one recorded write path, plus per-run source selection for
> the weekly brief. P05 (2026-09-24, `docs/implementation/2026-09-24-p05-files-attachments.md`)
> adds drop and paste into Files through the same recorded write (pictures, PDFs and workbooks as
> exact bytes, a person's own writes only), byte-sniffed read-only previews (PNG/JPEG/GIF/WebP,
> CSV/TSV and an XLSX first sheet as bounded tables, PDF described but not rendered), Thread
> attachments carried as the message's selected text sources with a per-message version chip,
> and durable file identity (`sha256` + path + History version) that opens older versions from
> History. Still open: an in-app PDF viewer, open-externally, restoring binary versions, and
> sending pictures/PDFs to an engine.

and in the same decision replace "(attachments, broader previews, code editing, Git, diffs, LSP)"
with "(provider/vision attachments, a PDF viewer, code editing, Git, diffs, LSP)".

**`docs/DIOMEDES_LIVE_ROADMAP.md` §5** — append to the third paragraph:

> P05 (2026-09-24) shipped Core Files drop/paste, byte-sniffed previews (pictures, CSV/TSV, XLSX
> first sheet; PDF described only), Thread attachments through the existing source path, and
> History-projected durable identity; see the implementation record for gaps.

**`docs/DIOMEDES_PROJECT_MEMORY.md`** — add to the Files definitions:

> **File identity.** The SHA-256 of a file's exact bytes, its project-relative path and the
> History version that first recorded those bytes. A projection of History, not a second record;
> a Thread reference opens that exact version or says it is no longer available.
>
> **Attachment (Thread).** A project file carried by one message as one of its selected text
> sources. It widens no read scope; a file the route cannot receive as text is refused in words.

**`QUESTIONS.md`** — no question is answered. Proposed default recorded here for Andrew: binary
restore from History is refused rather than implemented, and no open-externally hand-off was added
to the desktop shell (the conservative choice; both are candidate follow-ups).

---

## PILLAR / ROADMAP / BUILD

- **PILLAR IMPACT:** advances the general-purpose Project and one-Files-surface direction
  (decisions 12–13) for business documents, pictures and spreadsheets without a coding surface;
  Trust unchanged (no grant, no widened engine read, models still text-only writers; decision 7);
  attribution truthful (person-attributed History entries; decision 8); evidence durable
  (identity is a projection of retained History; decision 10); path guards reused (decision 11).
- **ROADMAP IMPACT:** P05 / DIO-31 items 1–5 implemented on this branch with the gaps above;
  status change pending the integrator's reconciliation.
- **BUILD STATUS:** branch pushed, draft PR open; not merged, not packaged, not released; no
  version bump.
