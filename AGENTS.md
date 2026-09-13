# Diomedes — agent operating contract

Diomedes is a general-purpose agent product. A person states an outcome; Diomedes plans it, gathers
the context, picks routes and tools, delegates bounded work, watches for drift, asks for authority
where it needs it, verifies the result and keeps a durable record of what happened. It is **one**
configurable product: a restaurant's scheduling and a developer's refactor run on the same Core,
Console, Trust and evidence primitives. It drives AI tools the user already has through adapters; it
does not ship an engine of its own.

Several agents work this repository at once, in separate worktrees that share one `.git`. The rules
below are what keep their work from contradicting each other. They record decisions Andrew has
already made, and they are not an agent's to re-litigate.

---

## START HERE — 60 seconds

1. **Read the three canonical documents** and report their versions: `docs/DIOMEDES_CORE_PILLARS.md`,
   `docs/DIOMEDES_LIVE_ROADMAP.md`, `docs/DIOMEDES_PROJECT_MEMORY.md`.
2. **Work in your own worktree**, branched from `main`.
3. **Scan the non-negotiable decisions below.** If your task conflicts with one, say so before
   writing code rather than after.
4. **Build Console-only.** The Workbook is frozen and takes no new screens.
5. **Run all four gates** before merging to `main`, and report the real counts from that run.
6. **Do not commit, push or release** without Andrew's explicit approval for the patch in front of
   you. "Build it" is not permission to publish it.
7. **Finish with the required report.**

---

## Source-of-truth order

When two sources disagree, the higher one wins.

| # | Source | Governs |
|---|--------|---------|
| 1 | Andrew's newest explicit decision | Intent. Supersedes everything below it, including a pillar. |
| 2 | `docs/DIOMEDES_CORE_PILLARS.md` | Durable product and business constraints. |
| 3 | `docs/DIOMEDES_LIVE_ROADMAP.md` | Strategy and sequencing. |
| 4 | `docs/DIOMEDES_PROJECT_MEMORY.md` | Definitions, terminology, UX meanings. |
| 5 | Current source plus fresh verification | What is actually true of the build. |

A narrative, a roadmap checkbox or an assistant's summary is never execution evidence.

**Cloud canonical documents.** Each of the three has a Google Doc that is canonical and a repository
mirror that must carry the same version and materially equivalent decisions:

- Pillars: `https://docs.google.com/document/d/1O0bWr5HEryEQmtOsUput0sgzLhk2c_Ze6MaXoMfKta4/edit`
- Roadmap: `https://docs.google.com/document/d/1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE/edit`
- Project memory: `https://docs.google.com/document/d/13wYjK1BhEsGzc_yhpRtBz62pGmLxwdwq8pVqe1i4eKw/edit`

`F:\Diomedes\planning\DIOMEDES-LIVE-ROADMAP.md` is a cache, not a third authority. Refresh a cloud
document before an authorised write and use its `requiredRevisionId`. Reconcile concurrent edits
after their writer is idle; never force-overwrite live work. If you cannot write, leave the exact
proposed patch and say that cloud synchronisation is pending.

The Core Pillars are the compact binding drift-check layer for product, business, agent, harness, UX,
support, sales and website work. A substantial proposal that materially conflicts with a pillar must
identify the conflict before proceeding.

If a decision changes a product definition, update the canonical documents. Do not leave a new
meaning buried in a handoff conversation, and do not invent a conflicting definition in an
implementation thread when these documents already answer it.

---

## Current non-negotiable product decisions

Numbering is stable; tests and comments cite these by number. Full text and reasoning:
[`docs/reference/STANDING_DECISIONS.md`](docs/reference/STANDING_DECISIONS.md).

1. **One surface: the Console.** The Workbook is frozen and is being ported page by page, then
   deleted. Every new feature is Console-only: no new Workbook screens, and no further re-skin
   passes on the Workbook's half of `client/styles.css`.
   → [`docs/implementation/2026-09-09-one-surface.md`](docs/implementation/2026-09-09-one-surface.md)
2. **The visual reference is the Settings > Engines screen**, read through the shared Console visual
   system: crisp readable typography, disciplined spacing, flat graphite/dark surfaces, thin
   separators, restrained accent use, compact controls. The appearance/theme package stays
   user-selectable. Do not resurrect a second Workbook design language.
3. **The website is not a design source for the app.** `F:\Diomedes\diomedes-site` (diomedes.net) is a
   separate Astro repository whose components are marketing artifacts built to look like Diomedes.
   Share tokens and semantics; never share implementations, never treat its sample catalogue as an
   operational authority, and never present a fabricated mock as a shipped capture.
4. **Diomedes says a thing once.** Do not add a sentence that restates what a caption, a mode contract
   or an invariant already says, and do not narrate the app's own state when a record already shows it.
5. **A machine string never enters a fixed-width surface without a policy.** Any flex or grid child
   that can carry a path, URL, slug, model name or thread title gets `min-width: 0` plus truncation or
   wrapping where it is written. Popups inherit typography from their ancestors even though they
   escape their layout box, so reset `white-space` at the panel edge.
6. **The page column has exactly one rule.** `.console .col` owns the measure and centres it; nothing
   else sets a page column's inline margin. A `margin` shorthand on a `.col` element silently resets it.
7. **Permissions are scoped authority, not approval spam.** See *Trust and permission boundaries*.
8. **Actor attribution must be truthful.** See *Trust and permission boundaries*.
9. **Local models are first-class.** Hardware and runtime discovery, a small explained model
   shortlist, managed configuration, benchmark and health verification, saved profiles, and lifecycle
   and resource ownership. A smaller tuned local supervisor may one day back the Diomedes Agent, but
   Runtime and Trust stay the authority, and model evolution stays evidence-driven, versioned,
   reversible and never permission-expanding.
10. **History is evidence; no blunt retention control may destroy it.** Settled 2026-09-10. Do not
    ship a user-facing setting that prunes History, receipts, authorization records, verification or
    evidence before a deliberate archival, deletion, organization-policy and legal data-lifecycle
    model exists. This is not "data can never be deleted"; it is "deletion is designed, not offered as
    a blunt switch." → `QUESTIONS.md` R7
11. **A path is judged by what it resolves to, not by how it is spelled.** Settled 2026-09-10. A
    Windows 8.3 alias is expanded at the `safeAbsolute` trust funnel and the forbidden and private
    checks re-run against the resolved path, so `C:\Users\RUNNER~1\...` opens when it names an
    ordinary profile and is refused when it names a guarded location. Never widen a path guard by
    deleting it. → `server/paths.ts`, `tests/paths.test.ts`
12. **Projects stay general-purpose.** Approved 2026-09-10. A Project is the durable container for an
    outcome and its working context. For software work it may hold source and repositories; for a
    restaurant or a remodel it holds documents, exported reports, spreadsheets, connector-backed
    information, procedures, approvals, generated artifacts, tasks and operating evidence. One Project
    contract serves both. Diomedes does not become a coding IDE.
13. **One Files surface, two tiers.** Approved 2026-09-10; first Core slice implemented 2026-09-11
    within a stated boundary (a read-only Files pane, an activity overview, pack activation and
    instruction-file discovery, each with tests: `docs/implementation/2026-09-11-*.md`). **Files are not inherently a software feature**, so Core carries the general file and
    artifact surface: the project folder and artifact model, ordinary preview, text and Markdown
    viewing, search, generated artifacts, history and version inspection, references into Threads, and
    open-externally behaviour. The IDE-grade version of that **same** surface is supplied by the
    Software Engineering Capability Pack on activation. It belongs inside the one Console, never as a
    second application surface, and it reuses the existing Project, `DocumentInfo`, `DocumentContent`
    and History primitives rather than creating a competing file authority. Anything beyond the
    recorded boundary (attachments, broader previews, code editing, Git, diffs, LSP) is still not
    shipped, and no site copy, release note, roadmap status or report may describe it as shipped
    until it exists with proof.
    → [`docs/product/2026-09-10-project-files-and-agent-overview.md`](docs/product/2026-09-10-project-files-and-agent-overview.md)
14. **A capability pack composes; it never parallels.** Approved 2026-09-10. A pack may affect the
    combination of tools, Agents, rules, context, workflows and relevant UI affordances — not merely
    prompt text — while using the same Core Runtime, Trust and Project contracts. It never introduces
    a second runtime, permission model, file authority or application surface, and **activating a pack
    is not an authorization event**: a pack declares what it needs and Trust still decides. Do not
    inject or load a pack's toolset for users or projects that do not need it. Repository instruction
    files such as `AGENTS.md` and `CLAUDE.md` are discovered by the Software Engineering pack and fed
    through the context and rule path, shown to the person as `Project instructions loaded · AGENTS.md`
    — never pasted into a prompt, and never applied where the person cannot inspect them.
    → [`docs/product/2026-09-10-capability-packs.md`](docs/product/2026-09-10-capability-packs.md)

---

## Before you change code

- Reconcile planned direction against current source and fresh verification. Read
  `docs/harness/RUNTIME_VERIFICATION.md` and `docs/harness/CHANGES.md` before the historical
  `docs/harness/CURRENT_STATE.md`.
- Preserve active worker boundaries in `F:\Diomedes\planning\DIOMEDES-RUNTIME-OWNERSHIP-2026-09-09.md`
  and the current coordination notes.
- Coordinate Trust interfaces with their owner before widening them.
- Derive what a screen shows from the authoritative task, run, Need, review and evidence records. Do
  not add a parallel lifecycle or state machine to serve a view.

---

## Trust and permission boundaries

- **Scoped authority, not approval spam.** Exact approvals stay available and evidenced, and a
  user-approved task or project grant may cover routine work inside an explicit scope. Keep access
  scope separate from who reviews an escalation. Never let automatic review, repeated approvals,
  learned preferences or an interface-detail setting silently increase authority.
- **Attribution is truthful.** Direct-agent work is attributed to the runtime-reported model and
  engine, never casually described as Diomedes reasoning. Use Diomedes as the reasoning actor only
  when the native Diomedes Agent owns the supervisory operation; infrastructure actions may still
  truthfully be Diomedes application actions. Preserve attribution historically.
- **Configuration cannot revive spent or revoked authority.** A configuration change, a rollback or a
  questionnaire answer never grants permission, restores revoked access or returns spent credit.
- **Evidence is durable.** See decision 10.
- **Test only with owned profiles, data and processes.** Never replace the running installation, copy
  account credentials, or silently change a provider or billing route.

### Not yours to decide

Take these to Andrew rather than choosing:

- any semantic change to a Core Pillar;
- any material new meaning for Guided density;
- any change to core permission preset meanings;
- the minimum window width;
- whether a click runs an action or selects it;
- any claim that a development capability is shipped;
- any architectural definition that conflicts with the pillars, roadmap or project memory.

---

## Multi-agent and worktree coordination

- Branch from `main` in your own worktree. Merge back with `git merge --ff-only`; if it refuses,
  someone landed first, so rebase your branch and never the reverse.
- **Never** run `git clean`, `git stash` or `git checkout -- .` in the main checkout. Every worktree
  shares one `.git`, and other agents' uncommitted work lives there.
- Never commit another agent's uncommitted worktree files for it.
- **Build in an isolated checkout.** `npm run build` also packages and overwrites that checkout's
  release directory. Never run `npm run package:desktop` in two checkouts at once, and never run
  Playwright while another pass is verifying.
- Packaging requires `Diomedes.exe` to be closed, and anything Andrew will click is packaged from
  `main` only, so every exe is a commit you can name.
- Do not bump the version or touch the native-runtime hashes unless that is your task.

### Unified execution program (from 2026-09-13)

- The coordination root is `<git common dir>/diomedes-coordination/unified-20260913/` (for this
  repository, `F:/Diomedes/diomedes/.git/diomedes-coordination/unified-20260913/`). Claims, the
  heavy-test slot and per-role journals live there; `scripts/coordination.ts` reads and writes
  them (`./node_modules/.bin/tsx scripts/coordination.ts status`). Only coordination files go
  there; never Git's own files.
- Claim exact paths before editing, atomically, and release them when the patch returns. A stale
  timestamp is not permission to steal a claim. If your partner's journal is absent, do read-only
  work; do not start a second implementation.
- Fable (Claude Code) integrates and owns the charter's shared hot files (`package.json` and
  lockfiles, `shared/types.ts`, the shared harness/Agent/pack contracts, `server/app.ts`,
  `server/store.ts`, `server/native-work.ts`, `client/api.ts`, `client/console/Shell.tsx`,
  `desktop/`). Others inspect them and return patches. Astra (Codex) reviews exact base+patch
  candidates and owns independent tests; Opus is a bounded worker under a written work order.
- The heavy-test / Playwright / packaging / live-call slot is one, shared by this repository and
  the site. Take it through the tool before running those; release it after.
- Contract revision `2026-09-13.1` (`shared/contract-revision.ts`) is the frozen additive
  amendment later items consume. Ledger: `docs/implementation/2026-09-13-rebaseline.md`.

---

## Before commit or push

**Commits, pushes and releases require Andrew's explicit approval for the current patch.** Approval of
one patch is not approval of the next.

Then, in order:

1. All four gates pass, on the commit you are about to push.
2. Canonical documents reconciled: the pillars if the decision is pillar-level, roadmap status,
   project-memory definitions, and `QUESTIONS.md` if a question was answered.
3. Nothing in the tree claims a capability is shipped that is not shipped.
4. The commit message says what changed and why, in this repository's voice.

---

## Required verification

With ports 5174 and 47632 free, and no other agent verifying at the same time:

```
npx tsc --noEmit
npx vitest run
npx vite build
npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts
```

`tests/native-ui.spec.ts` asserts `dist/` is newer than `shared/types.ts` and fails with
"dist is older than …" if you skip the build. Run `npx vite build` before Playwright, every time.

Report the actual final counts from your own run and name their source. Never report a sum of
historical suite totals, and never report a skipped test as a passing one.

---

## Required reporting

After a meaningful slice:

- **PILLAR IMPACT** when material drift is plausible: pillars advanced, risks or conflicts, and the
  observable proof. Do not mechanically enumerate all pillars on a trivial patch.
- **ROADMAP IMPACT**: exact status changes, with the evidence behind each.
- **BUILD / PUBLICATION / DEPLOYMENT STATUS**, kept separate from the above.
- **What is implemented versus what is only recorded or approved.**
- **Anything left uncommitted or unpushed.**

---

## Deeper contracts

| Document | What it holds |
|---|---|
| [`docs/reference/STANDING_DECISIONS.md`](docs/reference/STANDING_DECISIONS.md) | Full text and reasoning behind the numbered decisions |
| [`docs/DIOMEDES_CORE_PILLARS.md`](docs/DIOMEDES_CORE_PILLARS.md) | Binding product constitution and the website translation contract |
| [`docs/DIOMEDES_LIVE_ROADMAP.md`](docs/DIOMEDES_LIVE_ROADMAP.md) | Strategy, sequencing and current status |
| [`docs/DIOMEDES_PROJECT_MEMORY.md`](docs/DIOMEDES_PROJECT_MEMORY.md) | Definitions, terminology and UX meanings |
| [`QUESTIONS.md`](QUESTIONS.md) | What is still undecided, and how the earlier questions were answered |
| [`docs/implementation/`](docs/implementation/) | Per-slice implementation records |
| [`docs/product/`](docs/product/) | Product direction and design investigations |
| [`docs/harness/RUNTIME_VERIFICATION.md`](docs/harness/RUNTIME_VERIFICATION.md) | What the runtime has actually been proven to do |
