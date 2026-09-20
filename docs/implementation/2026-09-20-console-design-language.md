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

## Second pass, 2026-09-20: less clean, more Diomedes

Andrew on the first pass: "a little too clean, and near harness designs we see online. We are
supposed to have a more unique looking product… a little busier in terms of our mythic synthwave
feel, and easy access to everything is explicitly needed too."

He was right about the cause. The first Projects page was a centred column with a box and a list:
the pattern every assistant product opens on. It used the Console's tokens and none of the Console's
own devices.

**The tension, stated.** Standing decision 3 says the website is not a design source for the app,
and decision 2 asks for restrained accent. Andrew's instruction outranks both. They are reconciled
the way decision 3 itself allows: *share tokens and semantics, never implementations.* Nothing from
diomedes.net was copied, and no synthwave furniture (grid horizons, banded suns) was added, because
that would make the app look more like things seen online, not less.

8. **The Projects page is the Console's three regions**, not a page of its own kind. The rail is
   the thread rail (`Rail.tsx`, now taking a `title`): projects on the spine, the spine's point on
   the project the ask box will send to, the same foot of pinned destinations and the same
   Everything flyout. The work column carries an instrument line (`.instr`: projects, need you,
   running, changes today) and a **register**: one row a project, one mono column a readout
   (tasks done over total, waiting, running, changed today, opened). The ledger reads *across*
   projects the way a project's ledger reads across its threads: Needs you, Working, Engines with
   their usage. Every figure is `project.status`, `project.counts`, the integrations list or a
   usage snapshot; the page keeps no state of its own about any of them.
9. **Everything is one step away from anywhere.** The Projects page and Settings had no rail, so
   the destinations foot and the Everything flyout existed only inside a project, and so did
   `Ctrl K`. The Projects page now has both (pins under `home.rail.pins`, in localStorage for the
   reason Shell's are), its Everything lists every Settings section by name and opens it directly
   (`sectionRequest` on `SettingsPage`), and `TopStrip` carries `Ctrl K`, which outside a project
   opens the project search.
10. **The charge.** `--dm-charge-lead / -trail / -body` on `:root`: the run of colour the Diomedes
    signal carries. It is the semantic diomedes.net draws its signal with (cyan, violet, coral
    there) and the one the `mythic-synthwave` theme pack already encodes. Here it is *derived from
    the scheme in use* (`--light`, `--attn`, and `--attn` mixed toward `--fail`), so all eleven
    schemes, Paper and any custom theme have one without a colour being named in a stylesheet:
    Field runs cyan to amber to ember, the Mythic Synthwave pack runs cyan to violet to coral. A
    theme may set the three directly.
11. **The signal.** The mark is a spear-line with a guiding point ahead of it. The strip's rule
    and the rail's spine are that same line, so they carry the charge where they begin and settle
    into the plain hairline as they run on. One pixel, drawn once, never animated. The composer a
    person is writing in takes the lead colour on its edge and a little of the trail beneath it.
    This is app-wide: it is on the thread screen too.

**Found and not fixed:** `.console` and `.page-frame` paint an opaque ground over `.app`'s
`.dm-texture-layer`, so a theme's texture cannot be seen anywhere inside the Console. The channel
the theme system built for exactly this kind of richness is dead on the main surface. The
`mythic-synthwave` fixture also ships a 16x16 placeholder for its artwork. Making the app carry real
Mythic Synthwave art is a theme-pack and asset job, and it needs the real art.

**Not verified:** the Mythic Synthwave pack applied. The theme API refused the save in the design
preview (`Customization requires an active plan`), so the charge under that pack is reasoned from
its tokens, not seen.

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
Second pass also changed `client/console/Rail.tsx`.
Changed: `client/App.tsx`, `client/Settings.tsx`, `client/components.tsx`, `client/styles.css`,
`client/console/{Shell,Composer,ThreadView}.tsx`, `client/console/{console,motion,everything}.css`,
`server/store.ts`, `server/integrations.ts`, `tests/ui.spec.ts`, `tests/surface.test.ts`,
`tests/backend.test.ts`.

## Third pass: the mode on the Projects page, one dropdown, a texture a person can see

Andrew, same day: the Projects page gave no way to choose Ask, Plan, Build or Fix; "make an in
theme dropdown list of options", "fix other dropdown boxes too", keep every surface consistent,
and "ensure our customizability options are real".

### 12. The mode is chosen where the ask is written

The Projects page's ask bar carries **Mode** beside **In project**, both the same control. The
line under the box says what the chosen mode promises, in the words the thread's composer uses
(`CAPS`, exported from `Composer.tsx`, not copied). The mode travels in a key of its own
(`askModeKey`), because `Workspace.tsx` still reads the draft key as plain text. `Shell` applies it
to the thread the draft opens in, in an effect declared after the one that restores a thread's
stored mode, and compares against the thread's stored mode rather than the render's state.

A defect found on the way: sending from the Projects page into a project with no thread landed on
"No threads yet" over a draft nobody could see. `Shell` now opens a thread for a carried ask, once
per project.

Fix is offered. The failing document is picked in the project, where the documents are; the
caption says so, and the composer's own gate holds Send until it is given.

### 13. One dropdown, and it is still a native select

Every `<select>` in the app is drawn by one block at the end of `client/styles.css`.
`appearance: base-select` hands both the closed control and its open list to the stylesheet, so
the list is the Console's menu (`--raised`, `--hair-2`, `--r`, rows at `--rb`, the chosen row
marked with the point in `--dm-charge-lead`) in all eleven schemes, in the Console, Settings, AI
setup and the Design Center alike. The element stays a `<select>`: keyboard, screen reader and
the eleven `selectOption` calls in the specs keep what they had. No component was written and no
call site changed.

Electron 44 and the Edge the suite runs on both support it. Where it is not supported the closed
control still takes `appearance: none` and a chevron drawn from two gradients in `--t3`, since a
token cannot be written into a data URI. `.ws-select`'s data-URI chevron, which carried a literal
colour, is gone. Select rules that used the `background` shorthand now set `background-color`, so
they cannot erase a drawn chevron. The menu's shadow uses `light-dark()` so Paper does not get a
dark smudge.

### 14. A theme's texture is the chrome's ground

`.dm-texture-layer` sits at the bottom of `.app`, and `.console` and `.page-frame` painted opaque
over it: a texture was a setting that changed nothing in the Console. With a texture on, `.app`
holds `--chrome` (the layer's blend mode needs a ground beneath it) and the strip, the rail and
the ledger are transparent. The work column keeps its opaque `--surface`, so a texture never runs
under reading text. Opacity is still `--dm-texture-opacity`; the person's preference and the
accessibility layer still switch it off.

Verified end to end through the Design Center on the paid fixture profile: upload, Apply, layer
present in `.app`, rail/ledger/root computed transparent, work column opaque.

**Found and not changed.** The Design Center's contrast ceiling allowed this scheme's texture 4%
opacity ("These theme colours allow the texture up to 4%"). At 4% a dark texture on a dark ground
is close to invisible. That ceiling is a safety rule about labels over a texture and it is the
owner's to move; the reach picture in the session's captures forces 50% by injected style for the
picture only. The Mythic Synthwave fixture still has no texture entry and a 16x16 placeholder for
its bust and hero. In the Design Center at 1440x900 the "Your themes" block overlaps the end of
the left list.

### Not done in this pass

Settings is still the `.reading` page grammar inside `.page-frame`, not a Console screen. The
dropdown and shape rules reach it through CSS; rebuilding it as a Console screen is its own patch.
