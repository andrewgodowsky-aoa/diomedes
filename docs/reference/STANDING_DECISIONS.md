# Standing decisions — full text and reasoning

`AGENTS.md` carries each decision compressed to the rule an agent has to obey. This file carries the
same decisions unabridged, with the reasoning behind them and the history that produced them. Nothing
here is optional reading once a decision is actually in your way: the short form tells you what to
do, and this form tells you why, which is what you need before you propose changing one.

Numbering is stable. `tests/connections-ui.spec.ts` and `scripts/connections-desktop-smoke.mjs` cite
decisions by number in their comments, so a renumbering silently rewrites what those comments claim.
New decisions are appended.

---

## 1. One surface: the Console

The Workbook is frozen and is being ported into the Console page by page, then deleted. **Every new
feature is Console-only** — no new Workbook screens, and no further re-skin passes on the Workbook's
half of `client/styles.css`.

Two surfaces cost twice to build and more than twice to keep honest, because every invariant has to
hold in both and every test has to prove it twice. The port is one-directional so the cost stops
growing while it finishes.

Full record and reasoning: [`docs/implementation/2026-09-09-one-surface.md`](../implementation/2026-09-09-one-surface.md).

---

## 2. The visual reference is the Settings > Engines screen

Interpreted through the shared Console visual system and Andrew's explicit September 10 direction.
Preserve its crisp readable typography, disciplined spacing, flat graphite/dark surfaces, thin
separators, restrained accent use and compact controls across the Console migration.

The active appearance/theme package remains user-selectable; this decision governs the structure the
themes render, not the palette a person picks. Do not resurrect a second Workbook design language.

The historical prototype remains useful rationale, but where it conflicts with Andrew's newer
screenshot-based decision, the newer decision wins. See `docs/DIOMEDES_PROJECT_MEMORY.md`.

---

## 3. The website is not a design source for the app

`F:\Diomedes\diomedes-site` (diomedes.net) is a separate Astro repository with its own marketing
rendition of this app's language. Those are marketing artifacts built to look like Diomedes; they are
not Diomedes.

Never port them into the app, never treat the site's sample catalogue as an operational authority, and
never let a site component decide an app control's behaviour. Shared tokens and semantics are fine;
shared implementations are not.

Current website direction is plain-language outcomes plus honest captures or state sequences produced
by the real Diomedes harness and product, using reproducible synthetic or explicitly approved data.
Public pillar copy uses human language first with optional technical depth. A fabricated marketing
mock must never be presented as a shipped product capture.

See `docs/DIOMEDES_CORE_PILLARS.md` and the project-memory document.

---

## 4. Diomedes says a thing once

Do not add a sentence that restates what a caption, a mode contract or an invariant already says, and
do not narrate the app's own state when a point or a record already shows it.

Standing copy doctrine and rewrite table:
`planning/2026-09-09-advisor/00-fable-advisor-opinion.md` §3.

---

## 5. A machine string never enters a fixed-width surface without a policy

Any flex or grid child that can carry a path, URL, slug, model name or thread title gets
`min-width: 0` and truncation or wrapping where it is written.

Popups inherit typography from their ancestors even though they escape their layout box — reset
`white-space` at the panel edge.

The failure this prevents is a single long path silently widening a column past the window, which
reads as a layout bug in a screen that had nothing to do with the string.

---

## 6. The page column has exactly one rule

`.console .col` owns the measure and centres it; nothing else sets a page column's inline margin. A
`margin` shorthand on a `.col` element silently resets it, which is why the rule is "exactly one"
rather than "prefer".

---

## 7. Permissions are scoped authority, not approval spam

Exact approvals remain available and evidenced, but user-approved task/project grants may cover
routine work inside an explicit scope. Keep access scope separate from who reviews escalation.

Never let automatic review, repeated approvals, learned preferences or interface-detail settings
silently increase authority. The failure mode this guards against is authority accumulating through
convenience features that were never argued as permission changes.

See `docs/DIOMEDES_PROJECT_MEMORY.md` before changing approval semantics.

---

## 8. Actor attribution must be truthful

Direct-agent work is attributed to its runtime-reported model/engine rather than casually described
as Diomedes reasoning. Use Diomedes as reasoning actor only when the native Diomedes Agent owns the
supervisory operation; infrastructure actions may still truthfully be Diomedes application actions.

Preserve attribution historically: a later rename or re-route does not get to rewrite who did the
work at the time.

---

## 9. Local models are first-class

Setup direction includes hardware/runtime discovery, a small explained model shortlist, managed
configuration, benchmark/health verification, saved profiles, and lifecycle/resource ownership.

Long term a smaller tuned local supervisor may back the Diomedes Agent, but Runtime and Trust remain
the authority and model evolution is evidence-driven, versioned, reversible, and never
permission-expanding.

See the project-memory document for the full contract.

---

## 10. History is evidence; no blunt retention control may destroy it

**Settled 2026-09-10 by Andrew.**

`Settings.history.keepDays` (30) and `maxBytesPerProject` (2 GB) were stored, validated and read by
nothing. The choice was to implement pruning or to stop offering the settings, and pruning was the
wrong half to reach for first: History is evidence, and Pillars 06 and 09 both name evidence and
audit as enforced concepts, so what may be aged out is a policy question before it is an
implementation one.

Diomedes relies on durable attribution, receipts, authorization history, verification and evidence as
part of its trust model. A retention setting that silently prunes them destroys the audit trail that
makes the rest of the product credible.

This is **not** "data can never be deleted." It means Diomedes will not expose a blunt setting that
destroys evidence before the proper archival, deletion, organization-policy and legal data-lifecycle
model exists. That model is deliberate future work.

Both keys are gone from `Settings`, from the defaults and from the settings validator.
`migrateSettings` deletes a stored block, because settings load with no merge against the defaults
and a retired key would otherwise be read back and rewritten forever.

Still open, when someone wants it: what a real retention and archive policy allows. It has to answer
whether ageing out may remove the record of an authorized effect, and if not, what an archive keeps
instead. Recorded as `QUESTIONS.md` R7 (raised as O5).

---

## 11. A path is judged by what it resolves to, not by how it is spelled

**Settled 2026-09-10 by Andrew.**

Windows 8.3 aliases (`NODEMO~1`, `CREDEN~1.JSO`) can name a guarded entry while evading a
literal-component check, so the guard refuses any component shaped like a short name. The shape it
refuses is also the shape Windows generates for an ordinary profile: on a machine whose account name
runs past eight characters, `C:\Users\RUNNER~1\AppData\Local\Temp` is where `%TEMP%` lives. That is
not an evasion, and refusing it broke CI on the runner that has exactly that profile.

The fix is not to remove the guard. At the `safeAbsolute` trust funnel, a path carrying a
short-name-shaped component has its existing prefix expanded through `fs.realpath`, and the forbidden
and private checks re-run against the resolved path. `NODEMO~1` becomes `node_modules` and is
refused; `RUNNER~1` becomes the ordinary profile it is and is allowed.

Three properties keep this honest:

- A path with no alias-shaped component does no filesystem work at all, so the ordinary read path
  pays nothing.
- Only the deepest **existing** prefix is expanded. A component past it aliases nothing, so it stays
  in the tail and is judged on its shape.
- An alias that cannot be expanded is refused. An unresolvable alias cannot be cleared.

`rejectForbidden` stays shape-based by design: it does no IO, and its only non-test caller is
`relativeName`, which builds a synthetic path out of a user-supplied relative name rather than
receiving one from the operating system.

Implementation: `server/paths.ts`. Regression tests: `tests/paths.test.ts`, `tests/path-alias.test.ts`.
The alias tests report themselves as skipped rather than passing on a volume that generates no short
names, so a green run on such a volume cannot be mistaken for proof.

**Acceptance proof.** A local pass is not the evidence for this decision, because the local volume
generates no short names and the alias case skips. The proof is the `windows-latest` runner, which
has exactly the profile that broke:

| Run | Commit | `tests/paths.test.ts` | Result |
|---|---|---|---|
| 34532148878 | `2112ea1`, before the fix | — | **failed**: 32 of 40 `connections.test.ts` tests refused with *This folder or file is private and cannot be opened by Diomedes*, because their fixtures live under `os.tmpdir()` = `C:\Users\RUNNER~1\AppData\Local\Temp` |
| 34551480601 | `a4158e6`, after the fix | `(6 tests)` | **success** |

The same file reports `(6 tests | 1 skipped)` on a developer volume and `(6 tests)` on the runner.
That delta *is* the evidence: the alias case was exercised against a real `RUNNER~1` profile and
allowed it, while `NODEMO~1` and the credential names stayed refused. Do not cite a local green run
as proof of this decision.

The blast radius is worth remembering. The guard is defined in `server/paths.ts`, but the pre-fix
failure appeared in `connections.test.ts` — a shape-based refusal fails wherever a path merely passes
through, which is the argument for resolving once at the funnel instead of adding exceptions at call
sites.

---

## 12. Projects stay general-purpose

**Approved 2026-09-10 by Andrew.**

A Project is the durable container for an outcome and its working context. For software work it may
prominently contain source files and repositories. For restaurant or business work the same Project
abstraction contains documents, exported reports, spreadsheets, connector-backed information,
procedures, approvals, generated artifacts, tasks and operating evidence.

The same underlying Diomedes Agent and Project contract serves both. Research into developer tooling
must not collapse Diomedes into a coding IDE: a restaurant manager should never need to understand a
source tree to use Diomedes.

---

## 13. One Files surface, two tiers

**Approved 2026-09-10 by Andrew.**

Diomedes should offer an IDE-like file experience for users who want one, particularly programmers
and power users, without forcing development-tool complexity onto ordinary Personal or Business
users. A restaurant manager should never need to understand a source tree to use Diomedes. A software
developer should be able to work inside Diomedes without switching to another editor merely to
inspect what the agent is doing.

Both sentences stay true through a split. **Files are not inherently a software feature**, so the file
and artifact surface belongs in Core and is generally useful: the project folder and artifact model,
ordinary file preview, text and Markdown viewing, search, generated artifacts, history and version
inspection, attachments and references into Threads, and preview or open-externally behaviour for
common business files. SOPs, reports, exports, documents, spreadsheets, invoices and images are
ordinary business objects.

The IDE-grade version of that **same** surface is supplied by the Software Engineering Capability Pack
and appears only when a person activates it. There is one Files surface; the pack does not add a
second one, it changes what the existing one can do. See decision 14 and
[`docs/product/2026-09-10-capability-packs.md`](../product/2026-09-10-capability-packs.md).

It belongs inside the one Console and reuses the existing Project, `DocumentInfo`, `DocumentContent`
and History primitives rather than creating competing storage or a second file authority. Every byte
a person sees still arrives through `server/paths.ts`.

Binary and unsupported files show useful metadata and open externally. Diomedes does not become a
universal editor.

Until it exists with proof, no site copy, release note, roadmap status or report may describe it as
shipped. Approved direction and a shipped capability are different claims, and the second one is
`docs/DIOMEDES_CORE_PILLARS.md`'s to protect.

Design investigation and architecture:
[`docs/product/2026-09-10-project-files-and-agent-overview.md`](../product/2026-09-10-project-files-and-agent-overview.md).

---

## 14. A capability pack composes; it never parallels

**Approved 2026-09-10 by Andrew.**

A capability pack is how Diomedes becomes good at a kind of work without becoming a product for that
kind of work. A pack may affect the combination of tools, Agents, rules, context, workflows and
relevant UI affordances — **not merely prompt text** — while using the same Core Runtime, Trust and
Project contracts.

Both halves are load-bearing. A pack that could only add prompt text would be too weak: "be good at
code review" in a system prompt is not a capability, whereas a repo-aware tree, a diff view, a test
command and a reviewer Agent are. A pack that could add its own runtime, permission model or file
authority would be a second product.

**Activating a pack is not an authorization event.** A pack declares the capabilities it would use;
Trust still decides whether the person or organization granted them. This is the existing Agent rule
applied to packs: changing Agent, model or Team never grants authority, and a handoff cannot launder
permission.

**Do not inject or load a pack's toolset for users or projects that do not need it.** A Personal
Project tracking invoices must not pay for a symbol index, and its Console must not grow a Git status
column. Activation is the line, and the default side of that line is off.

The Software Engineering pack supplies, on the Core Files surface: repository-aware tree, syntax
highlighting, code editing, project-wide code and text search, symbol/function/class navigation, line
references into Threads, Git status and history, unified or split diffs, changed-file review,
diagnostics, test and build commands, worktrees and branches, repo-aware context construction,
software-specific Agents and subagents, coding tools and workflows, discovery of repository
instruction files, and later LSP where justified.

Repository instruction files (`AGENTS.md`, `CLAUDE.md`, relevant project documentation) are
discovered and fed through the correct context and rule path rather than pasted into a prompt: an
instruction file is standing guidance, and Diomedes already distinguishes standing guidance,
triggered correction and enforced policy. The person sees `Project instructions loaded · AGENTS.md`,
and clicking it opens a readable rendered version. Discovery is not obedience-in-secret: a rule the
user cannot inspect is a hidden behaviour change, not standing guidance.

Full contract, including what a pack may never do and the open questions:
[`docs/product/2026-09-10-capability-packs.md`](../product/2026-09-10-capability-packs.md).
