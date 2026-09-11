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

## 13. The optional Files pane is approved direction, not a shipped capability

**Approved 2026-09-10 by Andrew.**

Diomedes should offer an optional IDE-like file experience for users who want one, particularly
programmers and power users, without forcing development-tool complexity onto ordinary Personal or
Business users. It belongs inside the one Console; it is never a second application surface.

It reuses the existing Project, `DocumentInfo`, `DocumentContent` and History primitives rather than
creating competing storage or a second file authority.

Until it exists with proof, no site copy, release note, roadmap status or report may describe it as
shipped. Approved direction and a shipped capability are different claims, and the second one is
`docs/DIOMEDES_CORE_PILLARS.md`'s to protect.

Design investigation and architecture:
[`docs/product/2026-09-10-project-files-and-agent-overview.md`](../product/2026-09-10-project-files-and-agent-overview.md).
