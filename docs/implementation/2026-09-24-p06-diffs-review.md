# P06 — Existing-file edits: readable diffs, per-change keep, review comments and verified revisions

**Date:** 2026-09-24
**Lane / branch:** `p06-diffs-review`, `feature/p06-diffs-review` (from `origin/integration/overnight-batch-2`)
**Linear:** DIO-32 (P06 — Existing-file edits, diffs, review comments and verified revisions)
**Read first:** `AGENTS.md` decisions 1–14 (8, 10, 12, 13 and 14 in full);
`docs/reference/STANDING_DECISIONS.md`; `docs/implementation/2026-09-24-p05-files-attachments.md`
(identity = `{ sha256, path, History version }`); `docs/implementation/2026-09-24-h17-verified-completion.md`;
`docs/product/2026-09-10-project-files-and-agent-overview.md` (Gap 4).

No canonical document, `QUESTIONS.md`, version number or native-runtime hash was edited. The exact
proposed canonical-doc patch is at the end, including one boundary question for Andrew.

---

## What this is, and what it is not

It is the general Files surface for reading and settling changes to **any text**: a restaurant's
price list or procedure, a weekly report, a CSV export, or source code all read the same way. It
reuses the existing primitives only — `Change` (waiting / kept / undone), History entries and their
content-addressed before/after images, `Store.writeRecorded` with its `expected` base hash, P05's
`versionBytes` identity lookup, H17's projection and the follow-up queue. There is no second review
model, no second writer, no new file authority and no new dependency (the `diff` package was
already a dependency of the store).

It is **not** a code editor, not Git and not an IDE. Nothing here reads or writes a repository,
runs a command, highlights syntax or offers language intelligence, and no copy says otherwise.

---

## What shipped

### 1. Readable diffs (`shared/text-diff.ts`, `client/console/DiffView.tsx`)

- **One pure model** for every comparison: line diff with **word-level marks** inside a changed
  line when a removed and an added line pair up (unrelated replacements are left whole rather than
  shown as confetti). A **hunk** is one place the file changed: a maximal run of removed/added lines
  between unchanged ones.
- **Unified and side-by-side** views over the same computation (Gap 4: "should not be a second code
  path"); the choice is a per-viewer convenience in `localStorage`, wrapped in try/catch.
- **Context folding:** three unchanged lines around each change; the rest folds to
  "Show N unchanged lines". A fold that holds a commented line opens by itself.
- **Plain headers:** "3 lines added, 1 removed in Menu/Prices.md"; "12 lines added in X, a new
  file"; "3 lines removed from X, which was deleted"; "No differences in X". Each hunk is labelled
  "Change 2 of 3 · lines 5–6".
- **Bounded and truthful:** more than 1 MB across both versions → *"X is too large to compare
  here: 1.1 MB across both versions, over the 1 MB limit."*; more than 5,000 line edits →
  *"More than 5,000 lines differ in X, too many to compare here."* (the `diff` package's
  `maxEditLength`, so the comparison gives up instead of freezing the window); a NUL byte or a
  binary History record → *"X is not text, so no line differences are shown."*; a version whose
  contents were not kept → says so. A view renders at most 2,000 changed lines and states how many
  it left out.
- **Where it appears:**
  - **A task's thread** — new *Review changes* section (`ChangeDiffs.tsx`) under the existing
    Automatic Change Review, one card per Change the task's runs wrote.
  - **The Change review panel** — a recorded write's row now shows the readable diff between the
    two versions History holds (`GET /documents/diff`), falling back to the existing bounded patch
    text for an example review or a pruned object.
  - **A file's version list in Files** — an older version (P05's `VersionView`) offers *Changes from
    the version before* and *Compare with the current file* (`VersionCompare.tsx`).
- `GET /api/projects/:id/documents/diff?path=&from=&to=` compares two recorded versions by identity;
  each sha must be one History recorded for that path (P05's `versionBytes`, the same lookup Files
  uses to open an older version), `to` absent is the current file. No new read scope.

### 2. Per-change (per-hunk) keep (`server/change-review/partial-keep.ts`)

- `POST /api/projects/:id/review/:changeId/partial` with `{ after, keep: number[], undo: number[] }`.
- **Hunks are recomputed on the server** from the two versions History recorded for the change —
  never taken from the request — so the text written is the text the person was shown.
  `applyHunkSelection` takes the later side of each kept hunk and the earlier side of each undone
  one (keeping all gives `after`, keeping none gives `before`; tested for every table row).
- **One recorded write** through `Store.writeRecorded`: `actor: 'you'`, `kind: 'partial-keep'`,
  `sessionId: null` (a person's act, not the run's — decision 8), the change's `taskId`,
  `merge: false`, `expected` = the sha of the version the run wrote.
- **Base-hash checked.** If the file moved on after the run wrote it, nothing is written and the
  409 says who: *"Menu/Prices.md was changed by you / Diomedes / someone outside Diomedes after this
  change was made, so nothing was written. Review it again against the current file."* with
  `{ code: 'change_conflict', path, expectedSha, currentSha }`. The card then offers **Review again**,
  which reads the file through the Files read path (so an outside edit is recorded in History, as
  every read already does) and shows *Since this change was made:* as a diff. A stale review (the
  run rewrote the file after the person opened it) is refused with `change_moved`.
- **Evidence on the same History entry** (`HistoryEntry.hunkReview`, written by `addEntry` inside the
  same journalled write): the change id, the source entry, `beforeSha`/`afterSha`/`resultSha`,
  `by: 'you'`, and every hunk with its decision (`kept` / `undone`), its position and a SHA-256 of
  its exact lines. The sentence reads *"You kept 2 of 3 changes to Menu/Prices.md and undid 1"*.
- The Change becomes `kept` with `partial: { entryId, kept, undone }`; the card reads
  *"Kept 2 of 3 changes; undid 1"* and marks each hunk *kept* / *undone*. The task moves to Done
  when nothing of it is still waiting, exactly as whole-change Keep does.
- **Refused in words:** a one-hunk change (*"…so keep or undo it whole."*), a created/deleted/binary
  or unrecorded change, a change too large to keep piece by piece, a run still working, an
  undecided or duplicated hunk, or a choice that keeps everything or nothing (use Keep / Undo).
- **Whole-change Keep and Undo are unchanged** (`POST /review/:changeId`) and the thread card now
  offers them directly (the Console had no Keep/Undo control for waiting changes before this).

### 3. Review comments (`shared/review-comments.ts`, `server/review-comments.ts`)

- A comment is anchored to **one line** of either a waiting/settled **Change** (`{ changeId, path,
  sha }` — the version the run wrote) or a **recorded file version** (`{ path, sha }`, P05 identity).
  The anchor carries the side (`old` = a removed line, `new` = the later text), the 1-based line, the
  hunk it belongs to (derived by the server) and a **quote the server takes from the recorded
  text** (never from the request).
- Durable on the project state (`ProjectState.reviewComments`, beside the follow-up queue),
  capped at 5,000 per project. **Resolvable and reopenable; nothing deletes one** (decision 10).
  Shown inline under the line they are about, in every diff view.
- Routes: `GET/POST /api/projects/:id/review-comments`, `POST …/review-comments/:cid/resolve`.

### 4. "Revise with these comments" — never silently

- The thread's *Review changes* section offers *Revise with these comments (N)* for open, unsent
  comments on the task's changes (and version comments on the same files). It lists each with a
  checkbox, takes an optional note, and **shows the exact message** before anything is queued.
- `POST /api/projects/:id/review-comments/revise` composes that same message with the shared
  `revisionRequest` (deterministic; the preview is byte for byte what is queued) and hands it to
  **`WorkControl.queue`** — the existing follow-up queue. Delivery goes through the Work start
  route's own admission path with the route's recorded consent, so nothing is granted or widened;
  a refusal is shown on the follow-up. The run's route is used (the one whose consent the person
  gave), the commented files are the follow-up's sources, and a done task's follow-up waits for
  "the task".
- Comments are marked `sent: { followUpId, at }` only after the queue accepted the request; a
  sent comment is not sent again.

### 5. Verified revisions (H17)

No new state. A partial keep is a recorded write with `sessionId: null`, so H17's projection sees a
new newest digest for a file the verification bound, and the result turns **Verification uncertain
(`outputs-changed`)** — even when the kept text still passes the check, because it is not the bytes
that were verified. A revision run is a new run with its own outputs and its own (initially
*Not verified*) result. Proven in `tests/review-diffs.test.ts` ("a partial keep flips a Verified
result to uncertain against the new digest").

---

## Verification

New tests:

| File | Count | Proves |
| --- | --- | --- |
| `tests/text-diff.test.ts` | 23 | Diff correctness table (one change, two/three places, only added, only removed, new file, deleted file, identical, missing final newline, CRLF): headers, hunk positions, counts, every line once in order on its side; keep-all = after / keep-none = before for every row; partial selection; word pairing; side-by-side pairing; plain places; folding; binary, not-kept, byte bound, edit bound, render bound; selectability |
| `tests/review-diffs.test.ts` | 13 | Partial keep writes the exact text with the History evidence (decisions, positions, hunk shas, actor, origin) and survives a restart; conflict with a person's edit and with an outside edit refuses with nothing written; stale review / undecided / duplicated / one-sided / unknown hunks refused; one-hunk and still-working refused; **the H17 flip**; comments anchor, quote and persist across restart; bad anchors refused with nothing saved; version comment, resolve and reopen; revise queues exactly the shown words, marks only what was sent, never re-sends, refuses resolved and other-task comments, marks nothing when the queue refuses; version-to-version diff by identity and a picture described as not text; the real HTTP routes end to end into the follow-up queue |
| `tests/review-diffs-ui.spec.ts` (Playwright) | 1 | Built Console, real host with an injected generator: approve a run's proposal; read the diff (header, three hunks, word mark, side by side); uncheck change 2; an outside edit makes the partial keep refuse with the conflict sentence and nothing written; *Review again* shows the newer text; after the edit is taken back the partial keep lands (disk bytes, History evidence, per-hunk marks); comment on line 3, resolve, reopen; *Revise with these comments* previews the exact message, queues it, and the second run's prompt contains the comment; the follow-up is delivered; Files → version list → *Changes from the version before* → comment on line 9 of that version; zero page errors and zero non-loopback requests |

`playwright.config.ts` lists the new spec. Gate results are in the final report of this lane (and
the PR body).

---

## Known gaps (not shipped; nothing claims them)

- **No three-way merge.** When the file moved on, a partial keep refuses and shows what changed
  since; it does not merge the person's choice onto the newer text.
- **Crash window after a partial keep:** the write and its History evidence are journalled together;
  marking the Change `kept` is a second persist. A crash between the two leaves the Change `waiting`
  with *changed since* showing the recorded result — nothing is lost or misattributed.
- **Whole-change Keep still records no History entry of its own** (unchanged behaviour; Undo is a
  recorded restore).
- **Version comments are not carried to a revision** unless their file is one the task changed, and
  comments on a *Compare with the current file* view are not offered (that view's lines belong to
  the current file, not the version).
- **No syntax highlighting, no Git-backed diffs (commits, branches), no editing inside the diff.**
- Pictures, PDFs and workbooks are described, not compared (P05's binary kinds).

---

## Proposed canonical-doc patch

For the integrator to apply at reconciliation (this lane did not edit these files). It composes
with P05's proposed patch to decision 13; apply P05's first.

**`AGENTS.md`, decision 13** — after the P05 sentence (or, if P05's patch is not applied, after the
FIL-02 sentence ending "…is still open."), add:

> P06 (2026-09-24, `docs/implementation/2026-09-24-p06-diffs-review.md`) adds readable text diffs
> — line and word, unified and side by side, bounded, with truthful not-text, too-large and
> not-kept states — for a run's waiting Change, a recorded write in the Change review panel and any
> two History versions of a file; keeping a change hunk by hunk as one person-attributed,
> base-hash-checked recorded write whose History entry names each hunk kept or undone; and durable,
> resolvable review comments on a line of a change or a file version, which reach a run only as a
> previewed follow-up. These serve any text — a procedure, a report, an export or source — as the
> general Files surface; they are not IDE-grade editing and use no Git.

and in the same decision replace "(provider/vision attachments, a PDF viewer, code editing, Git,
diffs, LSP)" (P05's wording; today's text reads "(attachments, broader previews, code editing, Git,
diffs, LSP)") with "(provider/vision attachments, a PDF viewer, code editing, Git and Git-backed
diffs, syntax highlighting, LSP)".

**`docs/reference/STANDING_DECISIONS.md`, decision 13 (the Software Engineering pack list)** —
replace "Git status and history, unified or split diffs, changed-file review," with "Git status and
history, Git-backed and syntax-highlighted diffs (commits, branches, working tree), repository-wide
changed-file review," — the same edit in `docs/product/2026-09-10-capability-packs.md` (the pack
list) and `docs/product/2026-09-10-project-files-and-agent-overview.md` build-order item 8
("unified and split diffs" → "syntax-highlighted and Git-backed diffs"), with Gap 4 marked
"closed by P06 in Core for recorded versions".

**Boundary question for Andrew (not decided here).** The 2026-09-10 product note placed "unified
and split diffs" in the Software Engineering pack, while this work order (DIO-32) asked for diffs
as the general Files surface. This lane took the reading that serves a restaurant as well as a
developer: **readable diffs of recorded text versions are Core** ("history and version inspection",
decision 13's Core list), and the pack keeps the code-shaped half (Git-backed comparisons, syntax
highlighting, repository-wide review). Nothing is gated on a pack. If Andrew prefers the
2026-09-10 split, the Core views can be reduced to the header sentence and the patch text with no
data or evidence change. Proposed default: keep it in Core.

**`docs/DIOMEDES_LIVE_ROADMAP.md` §5** — append to the Files paragraph:

> P06 (2026-09-24) shipped readable diffs of recorded text versions and run changes, per-hunk keep
> as one base-hash-checked recorded write with hunk-level History evidence, and durable review
> comments sent to a run only as a previewed follow-up; H17 results turn uncertain when a partial
> keep changes verified bytes. See the implementation record for gaps (no three-way merge, no
> Git-backed or highlighted diffs).

**`docs/DIOMEDES_PROJECT_MEMORY.md`** — add to the Files / review definitions:

> **Hunk (change).** One place a change touched a file: a run of removed and added lines between
> unchanged ones, computed from the two recorded versions. A person may keep or undo each hunk;
> the result is one recorded write whose History entry names every hunk's decision.
>
> **Review comment.** A person's note anchored to one line of a change or of a recorded file
> version, quoting that recorded line. Durable and resolvable, never deleted; it reaches a run only
> inside a follow-up the person previewed and queued.

**`QUESTIONS.md`** — proposed open question: *Are readable diffs of recorded versions Core, or part
of the Software Engineering pack?* (see the boundary question above; conservative default taken:
Core, with no Git and no highlighting).

---

## PILLAR / ROADMAP / BUILD

- **PILLAR IMPACT:** advances the one general-purpose Files surface (decisions 12–13) with review
  that works for business documents and code alike; no second surface, file authority or runtime
  (14). Trust unchanged: the partial keep is the person's own recorded write under the existing base
  hash, and a revision is an ordinary follow-up through existing admission — no grant, no widened
  read, no new authority (7). Attribution truthful: the partial keep is `actor: 'you'`, application
  origin, `sessionId: null`, never the run's (8). Evidence durable: hunk decisions live on the
  History entry, comments are never deleted, H17 re-projects from History (10). Path guards reused
  through `projectFile`/`versionBytes` (11). Machine strings wrap or truncate in their own column (5);
  no `.col` margin set (6). **Risk:** the Core-versus-pack placement of diffs (question above).
- **ROADMAP IMPACT:** DIO-32 items 1–5 implemented on this branch with the gaps above; status change
  pending the integrator's reconciliation and Andrew's answer on the boundary question.
- **BUILD STATUS:** branch `feature/p06-diffs-review` pushed; not merged, not packaged, not released;
  no version bump; no native-runtime hash touched.
