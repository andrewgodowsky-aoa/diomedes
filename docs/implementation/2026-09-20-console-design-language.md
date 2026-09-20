# One design language: the Console's, everywhere a person can be

**Asked for by Andrew on 2026-09-20.** His words: the thread screen "looks pretty solid… slightly
rounded corners, very good", the Projects page "looks messy… lines everywhere, sharp corners, it's
inconsistent", the Workbook "was supposed to be retired", and "Codex with ChatGPT is on… reads
awkwardly". He asked for clean, modern design, minor transitions between pages, a better page to
open to, good flow and no loss of performance.

Branch `feature/console-design-language`, worktree
`F:/Diomedes/diomedes-wt/console-design-language`, stacked on
`feature/workbook-removal-everything-bubble-20260919` @ `bd5e829` (which is not on `main`, and
which this branch cannot land before).

## What was actually wrong

The two screens Andrew compared were drawn by two different stylesheets. The thread screen is the
Console (`client/console/*.css`: radii 6/5 px, hairlines between regions only). The Projects page
was still the Workbook's page grammar in `client/App.tsx`: `.workbook-layout` / `.reading` /
`.intents`, square `.button`s and inputs (`styles.css` reset every control to `border-radius: 0`),
a margin rule down the reading column, a dotted leader and a ruled separator per row, and a second,
different top bar (`.top-bar`) over it. Settings wore the same second bar. So moving
Projects → project → Settings changed the frame around the work twice.

This is the structural mismatch `2026-09-09-one-surface.md` describes. The answer there is the
answer here: do not re-skin the Workbook page, rebuild it as a Console screen.

## The decisions

These extend standing decision 2 (the Console visual system). They are written to be checked.

1. **One language.** Every screen a person can reach is drawn from the Console system. A new screen
   is `.console`-prefixed, tokens only, and reuses the Console's boxes by class (`.composer`,
   `.bar`, `.send`, `.pmenu`, `.col`) before it draws a new one.
2. **Shape: two radii, no others.** `--r` (6 px) for containers: the composer, a menu, a dialog, a
   notice, an option row. `--rb` (5 px) for controls and rows: a button, an input, a select, a
   hover fill. Nothing square, nothing pill. The 8 px point is the only circle.
3. **Lines: between regions, never inside one.** A hairline divides rail from stage, stage from
   ledger, strip from page. Inside a region, a group is made by space and a row lights on hover.
   No dotted leaders, no rule per row, no margin rule, no accent stripe on a box: state is carried
   by the point (`Mark`), which the notice and the row already have.
4. **One strip.** The Projects page and Settings wear the strip the Shell draws: the mark,
   `Projects / name` crumbs, a quiet right cluster. `TopStrip.tsx` reuses Shell's markup and
   console.css's rules rather than restating them; Shell keeps its own copy because its right
   cluster carries the thread's pickers. The strip says something only when there is news
   (offline, something waiting, work running). "Ready when you are." is gone (decision 4: do not
   narrate a state the screen already shows).
5. **The Projects page is a Console screen** (`client/console/Home.tsx`, `home.css`). The ask box
   is the thread composer's box, with the target project in its bar where the thread composer
   keeps its modes. The list is hover rows: name, state, date; the folder path (Technical detail)
   is one line cut at the end, whole in its title (decision 5). Everything a row says is read from
   `project.status`; the page keeps no state of its own about a project. With no projects yet, the
   three ways to start are the page, and the header does not repeat two of them.
6. **Motion: one entrance.** A view that arrives rises 6 px as it fades in (`dm-view-in`,
   `--dm-t-extend` 200 ms, `cubic-bezier(0.16, 1, 0.3, 1)`): a Console screen opened from the
   rail, the Projects page, a Settings section. A menu opens from its control (`dm-menu-in`,
   `--dm-t-quick`), a dialog and a notice rise 8 px. A control answering the pointer takes
   `--dm-t-quick` on colour, background and border. Nothing is animated *out*, so nothing waits on
   an animation. Opacity and transform only, no `transform` left behind (a lingering transform
   would make a screen the containing block of every fixed popover in it), and no library.
   `prefers-reduced-motion` removes all of it (the existing global rule); the app's own Reduced
   motion setting keeps a 120 ms fade and drops the movement, as `motion.css` already does.
7. **A service is called what people call it.** The ChatGPT connection is `ChatGPT`, not
   `Codex with ChatGPT`. The sentence that introduced its disclosure ("… is on.") is gone; the
   disclosure itself stays, because it is the statement of where a person's text is sent.

### What this does not change, on purpose

- **Run attribution** (`gpt-6-astra via Codex`, `shared/attribution.ts`) still names the engine
  that ran the work. That is standing decision 8, it is under test, and "ChatGPT" is an account,
  not an engine. If Andrew wants the transcript to say ChatGPT too, that is a decision about
  attribution and it is his.
- **`Claude Code`, `OpenCode`, `Cursor`, `Devin`** keep their product names. They are what a person
  installs and signs in to, and the setup flow says "Installing Claude Code…".
- **Diomedes still reopens the last project** at launch. The Projects page is where it opens when
  no project is open, and one click from anywhere. Opening there every time is a behaviour change
  the browser suite's helpers depend on ("The Console reopens the last project"), and resuming is
  what a returning person wants from a work tool. Open question for Andrew, not decided here.
- **The 20 px page frame stays.** It is part of the screen Andrew called solid.

## The Workbook

`bd5e829` removed every route *into* the Workbook. It kept the Workbook, the `surface` key and
three explicit switches. This branch removes the switches (Settings › Interface detail, the
Projects-page menu, the Console's `···` menu) and makes `migrateSettings` open every stored value
on the Console, so a person who had chosen the Workbook is not stranded in a surface with no way
out. **From a person's side the Workbook is gone.**

The migration applies **at launch only** (`migrateSettings(settings, { atLaunch })`). The store
re-reads `settings.json` when it recovers an interrupted write in the middle of a session
(`recoverAndReload`), and the first version of this change forced the Console there too: a restore
in one browser scenario moved the surface under the scenarios after it. A recovered transaction is
not a launch, so there only a missing value is filled. `tests/surface.test.ts` and
`tests/backend.test.ts` hold both rules.

What is left, and why: `client/Workspace.tsx`, its half of `styles.css`, the legacy `.top-bar`, and
the `surface` key in the API. `tests/ui.spec.ts` F01–F22 are the product's acceptance scenarios for
plans, approvals, restore, Undo and draft recovery, and they run *inside Workbook pages*. Deleting
the Workbook deletes that coverage unless each scenario is first ported to its Console screen. That
is a work order of its own, not a side effect of a design pass. Until then the specs reach the
Workbook the only way left, a settings PUT (`switchSurface` in `tests/ui.spec.ts`), and the legacy
bar is drawn only when `surface === 'workbook'`.

Remaining to delete, in order: port F04–F22 to Console screens → delete `Workspace.tsx`, the
`legacyChrome` branch in `App.tsx`, `surfaceOf`, `surfaceDescriptions` → drop `surface` from
`defaults()` with accept-and-drop in `validateSettings` for one release → prune `styles.css` by
class usage.

## On `styles.css`

`2026-09-09-one-surface.md` rules out further re-skin passes on the Workbook's half of
`styles.css`. The block appended to it here is not one: it changes the shared controls (`.button`,
`input`, `select`, `textarea`, `.dialog`, `.radio-row`, the notice bar) that Settings, every
dialog and first-run setup still draw for a person, plus `.settings-layout` and `.page-frame`. No
Workbook page rule was edited.

## Two defects found on the way

- **The Everything menu rendered one letter per line.** `.console .rail .foot button`
  (specificity 0,3,1) matched the menu's own buttons, because the panel is a DOM descendant of the
  rail foot even though it is `position: fixed`, and it outranked `.console .pmenu .m` (0,3,0).
  Decision 5's warning exactly. Fixed with a child combinator (`.foot > button`).
- **Text typed on the Projects page was dropped on the way into a project.** The draft is carried
  in `localStorage` under `askDraftKey`, and only the Workbook read it. The Console's `Composer`
  now takes it, and its "clear on thread change" effect no longer fires on mount, which is what
  would have emptied it again.

## Files

New: `client/console/TopStrip.tsx`, `client/console/Home.tsx`, `client/console/home.css`.
Changed: `client/App.tsx`, `client/Settings.tsx`, `client/components.tsx`, `client/styles.css`,
`client/console/{Shell,Composer,ThreadView}.tsx`, `client/console/{console,motion,everything}.css`,
`server/store.ts`, `server/integrations.ts`, `tests/ui.spec.ts`, `tests/surface.test.ts`,
`tests/backend.test.ts`.
