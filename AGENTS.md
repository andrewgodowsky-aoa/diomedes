# Diomedes project instructions

Read this before substantial work. Several agents work on this repository at once, in separate
worktrees that share one `.git`, and the rules below are what keep their work from contradicting
each other. They record decisions the owner has already made; they are not an agent's to
re-litigate.

## The plan of record

Before substantial work, read the canonical live roadmap or the latest documented local snapshot and
report its version. Canonical document:
`https://docs.google.com/document/d/1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE/edit`
Repository mirror: `docs/DIOMEDES_LIVE_ROADMAP.md`. Planning cache:
`F:\Achilles\planning\DIOMEDES-LIVE-ROADMAP.md`.

The cloud document and the repository mirror must carry the same explicit version and materially
equivalent decisions. The planning cache is not a third authority. Reconcile concurrent edits after
their writer is idle; never force-overwrite live work.

Reconcile planned direction with current code and evidence. Read `docs/harness/RUNTIME_VERIFICATION.md`
and `docs/harness/CHANGES.md` before the historical `CURRENT_STATE.md` inspection. Preserve active
worker boundaries in `F:\Achilles\planning\DIOMEDES-RUNTIME-OWNERSHIP-2026-09-09.md` and current
coordination notes. Coordinate Trust interfaces before widening them.

## Standing decisions

1. **One surface: the Console.** The Workbook is frozen and is being ported into the Console page by
   page, then deleted. **Every new feature is Console-only** — no new Workbook screens, and no
   further re-skin passes on the Workbook's half of `client/styles.css`. Full record and reasoning:
   [`docs/implementation/2026-09-09-one-surface.md`](docs/implementation/2026-09-09-one-surface.md).
2. **The design authority is the app's prototype**, not your taste, not the running app, and **not
   the website**:
   `planning/2026-09-08-field-visual-system/05-instrumented-density-prototype.html`.
   Flat, cool, dark by default, sharp (radii 6/5 only), mono uppercase micro-labels for anything
   measured, one cyan accent with one job, yellow only on go-ahead and needs-you, no cards, no
   bubbles, no glass, no gradients. Ceremony only at boot, reconnect and handoff. **Every deviation
   is approved by name, never discovered in a diff.**
3. **The website is not a design source for the app.** `F:\Achilles\diomedes-site` (diomedes.net) is
   a separate Astro repository with its own marketing rendition of this app's language — including
   "living chrome" (`src/components/chrome/Spine.astro`, `Wake.astro`, `CommandPalette.astro`,
   branch `muse/living-chrome`) and demo scripts `model-picker.ts`, `menu.ts`, `mode-rail.ts`,
   `console-frame.ts` over a hardcoded `src/data/engines.ts`. **Those are marketing artifacts built
   to look like Diomedes; they are not Diomedes.** Never port them into the app, never treat the
   site's sample catalogue as an operational authority, and never let a site component decide an app
   control's behaviour. The app's controls live in `client/console/` and answer to the prototype.
   Shared *tokens* and *semantics* are fine; shared implementations are not.
4. **Diomedes says a thing once.** Do not add a sentence that restates what a caption, a mode
   contract or an invariant already says, and do not narrate the app's own state when a point or a
   record already shows it. Standing copy doctrine and rewrite table:
   `planning/2026-09-09-advisor/00-fable-advisor-opinion.md` §3.
5. **A machine string never enters a fixed-width surface without a policy.** Any flex or grid child
   that can carry a path, URL, slug, model name or thread title gets `min-width: 0` and truncation
   or wrapping *where it is written*. Popups inherit typography from their ancestors even though
   they escape their layout box — reset `white-space` at the panel edge.
6. **The page column has exactly one rule.** `.console .col` owns the measure and centres it;
   nothing else sets a page column's inline margin. A `margin` shorthand on a `.col` element
   silently resets it.

## Not yours to decide

Take these to Andrew rather than choosing: what "Guided" means as a Console density; any change to a
user-facing string's voice; which verbs an approval offers; the minimum window width; whether a
click runs an action or selects it; anything that deviates from the prototype. **Commits, pushes and
releases require Andrew's explicit approval for the current patch** — "build" alone is not
permission to publish.

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

After a meaningful slice, include **ROADMAP IMPACT** with exact status changes and evidence, and
separate **BUILD / PUBLICATION / DEPLOYMENT STATUS**. Refresh the cloud document before an
authorised write and use `requiredRevisionId`; otherwise leave an exact proposed patch and state
that cloud synchronisation is pending.

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
