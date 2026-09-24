# H11 — nested project rules, precedence and an inspectable delivery record

Date: 2026-09-24 · Lane `h11-nested-rules-delivery` · Branch `feature/h11-nested-rules-delivery` · Linear DIO-16

## What this closes

The 2026-09-23 audit found rule authority and instruction delivery in place
(`server/rules.ts`, `server/harness/instruction-delivery.ts`,
`client/console/ProjectInstructions.tsx`, discovery in
`server/capability-packs.ts`) but only for `AGENTS.md` and `CLAUDE.md` at the
project root, with no defined precedence among files and no way for a person to
see what one run actually used. This slice extends those same modules; it adds
no second authority, store, runtime or surface (decision 14).

## What shipped

### 1. Nested discovery (`server/capability-packs.ts`)

- `findNestedInstructionFiles` walks the project folder breadth-first for the
  pack's file names (`AGENTS.md`, `CLAUDE.md`) below the root.
- Bounds (`shared/capability-packs.ts`): at most
  `NESTED_INSTRUCTION_MAX_DEPTH` = 6 folders deep, `NESTED_INSTRUCTION_MAX_FOLDERS`
  = 2000 folders visited, `NESTED_INSTRUCTION_MAX_FILES` = 32 nested files. The
  existing per-file ceilings still apply (256 KB read ceiling, 16 KB view budget).
- It never follows a link: a linked folder is not a directory to `readdir`, so
  it is never entered. A file of the right name that is itself a link is passed
  to `recordInstructionFile`, where the path guard refuses it and the refusal is
  the record (`state: 'unreadable'`). A folder the guard refuses
  (`server/paths.ts`, decision 11) is not listed at all. Hidden folders and the
  documents walk's `SKIPPED_FOLDERS` (`node_modules`, `dist`, …) are not walked.
  Nothing outside the project folder is read — including a person's
  home-folder `CLAUDE.md`.
- Each loaded nested file becomes the same host-authored, project-authority
  rule a root file does, with its folder in the text:
  `Project instructions from pkg/api/AGENTS.md apply to work in pkg/api.` Root
  rule ids are unchanged; a nested file's id carries a short digest of its exact
  path so `pkg/api/AGENTS.md` and `pkg-api/AGENTS.md` never share a rule.
- Discovery still only runs while the pack is active, on activation and when the
  packs list is read, exactly as before.

### 2. Precedence (`shared/capability-packs.ts` → `INSTRUCTION_PRECEDENCE`, `compareInstructionPrecedence`)

Strongest first:

0. **Authority** — decided by the existing `resolveRules`, not here. Every
   instruction file enters at `project` authority, so an `organization` rule is
   always above all of them, a `task` or `personal` rule below, and an
   organization restriction can never be loosened by a file. Activating a pack
   adds no authority; a pack's rules are these project rules.
1. A file in a nearer folder governs over a file in a folder that contains it.
2. In the same folder, the pack's file order: `AGENTS.md`, then `CLAUDE.md`.
3. Otherwise, the path in plain character order (only to make the order total;
   sibling folders never govern each other's work).

### 3. Scope and delivery (`server/harness/instruction-delivery.ts`)

- `assembleInstructions` takes `workPaths` — the documents selected for the run
  (`server/native-work.ts` passes the sources). A nested file governs only work
  on a path inside its folder, compared a whole folder name at a time
  (`pkg/api` never covers `pkg/apiary`). Work that names no path is scoped to
  the root.
- Scope selection runs before the rule path, the way `selectRules` does; the
  rule path (`assembleContext`) still resolves what survives. Applied files are
  then read, budgeted and rendered **in precedence order**, so when room runs
  out it is the most general file that is left out, never the one written for
  the folder the work is in. Bodies still go whole or not at all (HAR-05).
- With more than one body, one sentence above them says they are listed
  highest precedence first and the earlier one governs where two disagree. A
  nested body's delimiter names the folder it governs.

### 4. Delivery record (`Session.instructions`, `InstructionDelivery`)

Additive, optional fields, so records written before H11 still read:

- per delivered file: `scope`, `precedence` (1 governs), and `exclusion` when it
  was not sent — `over-file-limit` / `no-room` (the byte budget; `truncated` on
  the delivery is now true only for these), `refused` (the path guard at run
  time), `missing`;
- `workPaths`: what the run was scoped to;
- `excluded`: every discovered file that did not take part, with its folder,
  discovery sha, size and reason — `out-of-scope`, `not-shared` (cloud sharing
  does not list it; only recorded locally) or `not-loaded` (discovery made no
  rule, e.g. over the view budget or refused).

The record lives on the session, which is persisted with the project state, so
it survives a restart with the run's other evidence. A run whose shared, loaded
files are all out of scope still gets a record (with no files) but no prompt
section and no History sentence; a project with nothing shared and loaded still
gets no record, as before.

### 5. Console inspector (`client/console/ProjectInstructions.tsx`)

The thread head keeps the one line — `Project instructions loaded · AGENTS.md`
(decision 14) — now naming loaded files in precedence order. Expanding it shows
the thread's newest delivery record: each file with its rank, folder
(`project root` for the root), status, size and sha; the recorded reason for any
file left out or excluded; the body on click (the existing instruction read
route, which serves only recorded paths); and **Open in Files**, which opens the
file in the Files pane. Files discovered since that run follow under `found
since`. Machine strings truncate where they are written (decision 5); a sent
file's detail is not repeated under its status (decision 4). Visual language is
the existing graphite instruction panel.

## Tests

- `tests/nested-instructions.test.ts` (25): the precedence table (both input
  orders), a total order over a monorepo, authority ordering through
  `resolveRules`, whole-folder scope matching, rule-id uniqueness; bounded
  nested discovery (depth, skipped and hidden folders, idempotence); a linked
  folder never walked and a linked nested file refused and recorded; scoped runs
  (nearest first, root-only work, prefix trap, not-loaded and not-shared
  exclusions); byte budget spent strongest-first with the root file left out
  whole, a file grown past the per-file limit, a deleted file, a folder swapped
  for a link after discovery refused at run time; restart persistence of a
  nested delivery record.
- `tests/native-work.test.ts` (+1): a real run through the Codex path — root
  work excludes `kitchen/AGENTS.md` as out of scope; kitchen work sends it first
  with its rule named in the prompt; the session's record reads back identically
  from a fresh `Store` on the same data directory.
- `tests/instructions-inspector.spec.ts` (3, added to `playwright.config.ts`):
  precedence order, scope, sha, reasons and body; Open in Files; no horizontal
  overflow at 900 px. Discovery and the read route are real; the one injected
  thing is the session's delivery record (only an engine run writes one and the
  suite has no engine), built from the real discovered shas. Shown red against
  the previous component before going green.

## Known gaps

- Discovery refreshes on activation and when the packs list is read, not at the
  start of every run; a nested file added since then is picked up the next time
  either happens. The inspector shows it under `found since` once discovered.
- Files past the depth, folder or file-count bounds are not discovered and are
  not listed anywhere; there is no record that a bound was hit.
- Scope comes from the run's selected documents. Work that selects nothing
  (for example a conversation turn with no sources) is scoped to the root, so a
  nested file does not reach it even when the person means that folder.
- The sample route delivers no instructions, as before; only engine runs write a
  delivery record.
- A conflict *inside* two guidance bodies is ordered and labelled, not
  resolved: the model is told which governs, and nothing enforces it.
- Filenames are matched exactly (`AGENTS.md`, `CLAUDE.md`); `agents.md` is not
  discovered on a case-sensitive file system.

## Proposed default recorded (not Andrew's decision yet)

- Precedence among file kinds in one folder follows the pack manifest's order
  (`AGENTS.md` before `CLAUDE.md`), matching `AGENTS.md` as the canonical
  instruction file. Conservative and reversible: it changes ordering only,
  never authority.
- The bounds (6 deep, 2000 folders, 32 nested files) are conservative defaults.

## Proposed canonical-doc patch

For the integrator to reconcile; this lane edited none of these files.

**`docs/DIOMEDES_LIVE_ROADMAP.md`** — in the capability-pack paragraph that
ends "…rather than claiming instructions were never delivered." append:

> H11 (2026-09-24, `docs/implementation/2026-09-24-h11-nested-rules-delivery.md`):
> instruction files in nested folders are discovered under depth, folder and
> file bounds through the path guard, and govern only work on documents inside
> their folder. Precedence is authority first (via the existing rule
> resolution; files are project rules), then nearest folder, then AGENTS.md
> before CLAUDE.md. Each run's session records every file's scope, precedence,
> sha, bytes, whether it was sent, and why any discovered file was left out or
> excluded; the Console inspector under `Project instructions loaded` shows that
> record and opens each file in Files. Gaps: discovery is not re-run at every
> run start, bound hits are not recorded, and scope comes from selected
> documents only.

and set H11's status to **implemented, pending review** (not "done") until the
PR is merged and its CI is green on main.

**`docs/DIOMEDES_PROJECT_MEMORY.md`** — next to the AGENTS.md/CLAUDE.md
definition ("Discovered AGENTS.md/CLAUDE.md guidance must retain
source/scope/version…") add:

> **Instruction scope.** A discovered instruction file governs work on paths
> inside its own folder; a root file governs the whole project. **Instruction
> precedence:** authority first (files are project rules), then the nearer
> folder, then AGENTS.md before CLAUDE.md in one folder. **Delivery record:**
> the per-run record on the session of which instruction files were sent, in
> precedence order, and why each other discovered file was not (`no-room`,
> `over-file-limit`, `refused`, `missing`, `out-of-scope`, `not-shared`,
> `not-loaded`). "Truncated" means a file was left out whole for the byte
> budget; a body is never cut.

**`docs/DIOMEDES_CORE_PILLARS.md`** — no change. **`QUESTIONS.md`** — no
question answered; the kind-order and bounds defaults above could be listed for
Andrew's confirmation if the integrator prefers.
