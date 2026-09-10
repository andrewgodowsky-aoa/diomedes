# Diomedes project instructions

Read this before substantial work. Several agents work on this repository at once, in separate
worktrees that share one `.git`, and the rules below are what keep their work from contradicting
each other. They record decisions the owner has already made; they are not an agent's to
re-litigate.

## The plan of record

Before substantial work, read the **Core Pillars**, the canonical live roadmap and the canonical
project-memory companion, or the latest documented local snapshots, and report their versions.

Core Pillars canonical document:
`https://docs.google.com/document/d/1O0bWr5HEryEQmtOsUput0sgzLhk2c_Ze6MaXoMfKta4/edit`
Repository mirror: `docs/DIOMEDES_CORE_PILLARS.md`.

The Core Pillars are the compact binding drift-check layer for product, business, agent, harness,
UX, support, sales and website work. A substantial proposal that materially conflicts with a pillar
must identify the conflict before proceeding; only Andrew's newer explicit decision may supersede a
pillar. For material work where drift is plausible, include a concise **PILLAR IMPACT** in planning
or reporting: pillars advanced, risks/conflicts, and observable proof. Do not mechanically enumerate
all pillars on trivial patches.

Live roadmap canonical document:
`https://docs.google.com/document/d/1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE/edit`
Repository mirror: `docs/DIOMEDES_LIVE_ROADMAP.md`. Planning cache:
`F:\Achilles\planning\DIOMEDES-LIVE-ROADMAP.md`.

Project-memory canonical document:
`https://docs.google.com/document/d/13wYjK1BhEsGzc_yhpRtBz62pGmLxwdwq8pVqe1i4eKw/edit`
Repository mirror: `docs/DIOMEDES_PROJECT_MEMORY.md`.

The Core Pillars govern durable product/business constraints. The live roadmap governs strategy and
sequencing. `DIOMEDES_PROJECT_MEMORY.md` is the standing product-definition/terminology/UX companion:
it records meanings such as Desktop/Core/Runtime/Trust, Diomedes Agent versus direct-agent mode,
engine/model/provider distinctions, permission semantics, actor attribution, local-model onboarding,
the long-term local supervisor model, recursive self-improvement guardrails, workbench ideas,
website communication, and current business direction. Do not invent a conflicting definition in an
implementation thread when these canonical documents already answer it.

The cloud roadmap and repository roadmap mirror should carry the same explicit version and materially
equivalent decisions. The planning cache is not a third authority. The project-memory cloud document
and its repository mirror likewise should remain materially equivalent. Reconcile concurrent edits
after their writer is idle; never force-overwrite live work.

Reconcile planned direction with current code and evidence. Read `docs/harness/RUNTIME_VERIFICATION.md`
and `docs/harness/CHANGES.md` before the historical `CURRENT_STATE.md` inspection. Preserve active
worker boundaries in `F:\Achilles\planning\DIOMEDES-RUNTIME-OWNERSHIP-2026-09-09.md` and current
coordination notes. Coordinate Trust interfaces before widening them.

## Standing decisions

1. **One surface: the Console.** The Workbook is frozen and is being ported into the Console page by
   page, then deleted. **Every new feature is Console-only** — no new Workbook screens, and no
   further re-skin passes on the Workbook's half of `client/styles.css`. Full record and reasoning:
   [`docs/implementation/2026-09-09-one-surface.md`](docs/implementation/2026-09-09-one-surface.md).
2. **The current visual reference is the Settings > Engines screen**, interpreted through the shared
   Console visual system and the current owner's explicit September 10 direction. Preserve its crisp
   readable typography, disciplined spacing, flat graphite/dark surfaces, thin separators, restrained
   accent use and compact controls across the Console migration. The active appearance/theme package
   remains user-selectable. Do not resurrect a second Workbook design language. The historical
   prototype remains useful rationale, but where it conflicts with the owner's newer screenshot-based
   decision, the newer decision wins. See `docs/DIOMEDES_PROJECT_MEMORY.md`.
3. **The website is not a design source for the app.** `F:\Achilles\diomedes-site` (diomedes.net) is
   a separate Astro repository with its own marketing rendition of this app's language. Those are
   marketing artifacts built to look like Diomedes; they are not Diomedes. Never port them into the
   app, never treat the site's sample catalogue as an operational authority, and never let a site
   component decide an app control's behaviour. Shared tokens and semantics are fine; shared
   implementations are not. Current website direction is plain-language outcomes plus honest captures
   or state sequences produced by the real Diomedes harness/product using reproducible synthetic or
   explicitly approved data. Public pillar copy uses human language first with optional technical
   depth; a fabricated marketing mock must never be presented as a shipped product capture. See
   `docs/DIOMEDES_CORE_PILLARS.md` and the project-memory document.
4. **Diomedes says a thing once.** Do not add a sentence that restates what a caption, a mode
   contract or an invariant already says, and do not narrate the app's own state when a point or a
   record already shows it. Standing copy doctrine and rewrite table:
   `planning/2026-09-09-advisor/00-fable-advisor-opinion.md` §3.
5. **A machine string never enters a fixed-width surface without a policy.** Any flex or grid child
   that can carry a path, URL, slug, model name or thread title gets `min-width: 0` and truncation
   or wrapping where it is written. Popups inherit typography from their ancestors even though
   they escape their layout box — reset `white-space` at the panel edge.
6. **The page column has exactly one rule.** `.console .col` owns the measure and centres it;
   nothing else sets a page column's inline margin. A `margin` shorthand on a `.col` element
   silently resets it.
7. **Permissions are scoped authority, not approval spam.** Exact approvals remain available and
   evidenced, but user-approved task/project grants may cover routine work inside an explicit scope.
   Keep access scope separate from who reviews escalation. Never let automatic review, repeated
   approvals, learned preferences or interface-detail settings silently increase authority. See
   `docs/DIOMEDES_PROJECT_MEMORY.md` before changing approval semantics.
8. **Actor attribution must be truthful.** Direct-agent work is attributed to its runtime-reported
   model/engine rather than casually described as Diomedes reasoning. Use Diomedes as reasoning actor
   only when the native Diomedes Agent owns the supervisory operation; infrastructure actions may
   still truthfully be Diomedes application actions. Preserve attribution historically.
9. **Local models are first-class.** Setup direction includes hardware/runtime discovery, a small
   explained model shortlist, managed configuration, benchmark/health verification, saved profiles,
   and lifecycle/resource ownership. Long term a smaller tuned local supervisor may back Diomedes
   Agent, but Runtime/Trust remain authority and model evolution is evidence-driven, versioned,
   reversible, and never permission-expanding. See the project-memory document for the full contract.

## Not yours to decide

Take these to Andrew rather than choosing: any semantic change to a Core Pillar; any material new
meaning for Guided density; changes to core permission preset meanings; the minimum window width;
whether a click runs an action or selects it; any claim that a development capability is shipped; or
any architectural definition that conflicts with the pillars/roadmap/project-memory documents.
**Commits, pushes and releases require Andrew's explicit approval for the current patch** — "build"
alone is not permission to publish.

## Coordination rules

- Work in your own worktree, branched from `main`. Merge back with `git merge --ff-only`; if it
  refuses, someone landed first — rebase your branch, never the reverse.
- **Never** run `git clean`, `git stash` or `git checkout -- .` in the main checkout: every worktree
  shares one `.git`, and other agents' uncommitted work lives there.
- Never commit another agent's uncommitted worktree files for it.
- **Build in an isolated checkout:** `npm run build` also packages and overwrites that checkout's
  release directory. Never run `npm run package:desktop` in two checkouts at once, and never run
  Playwright while another pass is verifying. Packaging requires `Diomedes.exe` to be closed and —
  for anything Andrew will click — runs from `main` only, so every exe is a commit you can name.
- Test only with owned profiles, data and processes. Never replace the running installation, copy
  account credentials, or silently change provider or billing routes.
- Do not bump the version or touch the native-runtime hashes unless that is your task.

## Reporting

After a meaningful slice, include **PILLAR IMPACT** when material drift is plausible, then
**ROADMAP IMPACT** with exact status changes and evidence, and separate **BUILD / PUBLICATION /
DEPLOYMENT STATUS**. Refresh the cloud roadmap before an authorised write and use
`requiredRevisionId`; otherwise leave an exact proposed patch and state that cloud synchronisation is
pending. If a product-definition decision changes, update the Core Pillars when applicable, the
roadmap impact and `DIOMEDES_PROJECT_MEMORY.md` rather than leaving the new definition buried only in
a handoff conversation.

## Gates before any merge to `main`

With ports 5174 and 47632 free and no other agent verifying at the same time:

```
npx tsc --noEmit
npx vitest run
npx vite build
npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts
```

`tests/native-ui.spec.ts` asserts `dist/` is newer than `shared/types.ts` and fails with
"dist is older than …" if you skip the build — run `npx vite build` before Playwright, every time.
Report actual final counts and source identity, never a sum of historical suite totals.
