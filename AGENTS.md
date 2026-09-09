# Working on Diomedes

Read this before you plan anything. Several agents work on this repository at once, in
separate worktrees under `F:\Achilles\diomedes-wt\`, and the rules below are what keep
their work from contradicting each other. They record decisions the owner has already
made; they are not open for re-litigation by an agent.

## Standing decisions

1. **One surface: the Console.** The Workbook is frozen and is being ported into the
   Console page by page, then deleted. **Every new feature is Console-only** — no new
   Workbook screens, and no further re-skin passes on the Workbook's half of
   `client/styles.css`. Full record and reasoning:
   [`docs/implementation/2026-09-09-one-surface.md`](docs/implementation/2026-09-09-one-surface.md).
2. **The design authority is the prototype**, not your taste and not the running app:
   `planning/2026-09-08-field-visual-system/05-instrumented-density-prototype.html`.
   Flat, cool, dark by default, sharp (radii 6/5 only), mono uppercase micro-labels for
   anything measured, one cyan accent with one job, yellow only on go-ahead and
   needs-you, no cards, no bubbles, no glass, no gradients. Ceremony only at boot,
   reconnect and handoff. **Every deviation is approved by name, never discovered in a
   diff.**
3. **Diomedes says a thing once.** Do not add a sentence that restates what a caption,
   a mode contract or an invariant already says; do not narrate the app's own state
   when a point or a record already shows it. Standing copy doctrine and a rewrite
   table: `planning/2026-09-09-advisor/00-fable-advisor-opinion.md` §3.
4. **A machine string never enters a fixed-width surface without a policy.** Any flex
   or grid child that can carry a path, URL, slug, model name or thread title gets
   `min-width: 0` and truncation or wrapping *where it is written*. Popups inherit
   typography from their ancestors even though they escape their layout box — reset
   `white-space` at the panel edge.
5. **The page column has exactly one rule.** `.console .col` owns the measure and
   centres it; nothing else sets a page column's inline margin. A `margin` shorthand on
   a `.col` element silently resets it.

## Not yours to decide

Take these to the owner rather than choosing: what "Guided" means as a Console density;
any change to a user-facing string's voice; which verbs an approval offers; the minimum
window width; whether a click runs an action or selects it; anything that deviates from
the prototype.

## Coordination rules

- Work in your own worktree, branched from `main`. Merge back with `git merge --ff-only`;
  if it refuses, someone landed first — rebase your branch, never the reverse.
- **Never** run `git clean`, `git stash` or `git checkout -- .` in the main checkout:
  every worktree shares one `.git`, and other agents' uncommitted work lives there.
- Never commit another agent's uncommitted worktree files for it.
- Never run `npm run package:desktop` in two checkouts at once, or Playwright while
  another pass is verifying. Packaging requires `Diomedes.exe` to be closed, runs from
  `main` only, and is followed by the desktop smoke.
- Do not bump the version or touch the native-runtime hashes unless that is your task.

## Gates before any merge to `main`

```
npx tsc --noEmit
npx vitest run
npx vite build
npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts
```

`tests/native-ui.spec.ts` asserts `dist/` is newer than `shared/types.ts` and fails with
"dist is older than …" if you skip the build — run `npx vite build` before Playwright,
every time.
