# Wide windows and multitask mode: design

Date: 2026-10-03. Owner: Andrew Godowsky. Written with Claude from a brainstorming session.
Code read at origin/main 4dbbd88. Design boards: round 2 of the Agent and Work canvas,
https://claude.ai/artifact/RkinDiymHU8i5BmSeGdJ5b (version 17).

## Summary

The round 2 reskin (Nectovia | Work, boards N1 to N4 and BD1 to BD3) must not grow with the
window. Type and controls keep today's sizes at every width. Extra width becomes quiet margin.

A wide window can also hold a side panel: multitask mode. It hosts any tool the person
picks, in tabs, as one panel, two stacked halves or two side by side columns. Files, artifacts,
the board and Routines are the first tools. A built-in browser follows, and it brings Google
Drive, Calendar and Gmail with it as ready-made pages.

The work runs in two phases. Phase 1, the size and space rules, is a hard requirement of the
reskin build. Phase 2, multitask mode, starts after the reskin merges.

## Decisions

Andrew, 2026-10-03, in order:

1. Purpose of the side area: reference (read beside the conversation) and intake (drag into the
   ask box) first. Nectovia working inside the panel comes later.
2. Baseline sizes are today's app sizes. The boards' 18px was a presentation size.
3. The panel remembers what you did: it starts closed, and once opened on a wide window it
   reopens there until you close it. Small windows always start closed.
4. The panel holds whatever tool the person wants. It is a built-in multitask mode with modular
   tools.
5. Tabs are permanent. The person chooses between one panel, stacked and side by side. The
   conversation column may give up width so two columns fit a 1920 by 1080 monitor.
6. The reskin is built first. Multitask mode follows it.
7. Architecture: the app's layout owns the side slots and every tool is a module (approach 1 of
   3). Drive comes through a real built-in browser, the way Claude desktop and Codex do it.
   Pop-out windows (approach 3) are mapped for later, for power users and multi-monitor setups.
8. Sections 1 to 4 of this design were approved in chat before this file was written.

## Phase 1: size and space rules

These rules bind the reskin build. A reskin change that breaks one is not done.

### Sizes are fixed

- The reskin uses today's semantic type tokens in `client/styles.css` and keeps their values:
  `--dm-type-conversation` 15px (scaled by Conversation text size), `--dm-type-body` 16px,
  `--dm-type-input` 15px, `--dm-type-ui` 14px, `--dm-type-caption` 13px, `--dm-type-meta` 12px,
  `--dm-type-section` 18px, `--dm-type-title` 20px. The comment already there holds: width and
  information density never size type.
- Board sizes map onto these tokens by role. A board's 18px message text becomes
  `--dm-type-conversation`. A board's 16px control label becomes `--dm-type-ui`. Control heights
  follow today's controls.
- No font size, padding, margin or gap in the reskin may use `vw`, `vh`, `vmin`, `vmax` or a
  `clamp()` with a viewport term. The one rule doing this today,
  `client/console/nectovia.css:760` (`clamp(2.125rem, 1rem + 2.6vw, 3.5rem)`), becomes a fixed
  size from the token scale.
- Interface size (Ctrl plus and minus, `--dm-ui-scale` on `html`) stays the only zoom, and only
  the person sets it.

### The column holds and the margins grow

- The work column keeps `--dm-measure` (920px), prose keeps `--dm-measure-prose` (68ch), and wide
  content such as code and tables keeps `--dm-measure-wide` (75rem).
- Width past the column becomes equal margin on both sides. Nothing else grows.
- The container queries at 1100, 860 and 700 keep working as they do today.

### Visible but quiet

- A bigger window never adds anything by itself: no extra badges, counters, panels or longer
  lines of text.
- Secondary text keeps its secondary color at every width.
- Charts such as the N1 and N2 cover chart keep their designed width inside the column. They do
  not stretch into the margins.

### Room for the side panel

- The reskin keeps the stage's third column that the Files pane uses today
  (`.console .stage.files-open` in `client/console/console.css`). Decision 6 holds: side content
  is a stage column, never a margin on `.col`.

### Phase 1 tests

- Extend `tests/readability.spec.ts`: at viewport widths 1280, 1920 and 2560, conversation text,
  body text and the work column measure the same.
- A unit test fails if any reskin stylesheet sets a font size, padding, margin or gap with a
  viewport unit. The one exception is the title bar padding that reads `env(titlebar-area-x)`
  and `env(titlebar-area-width)` (`client/console/console.css:173` and `client/styles.css:661`
  today), which places controls clear of the window buttons and sizes nothing.

## Phase 2: multitask mode

### Opening and closing

- A panel button at the right end of the top bar, and Ctrl+\ (Cmd+\ on a Mac). Today only
  Ctrl+K and Ctrl+. are taken in `client/App.tsx`.
- The panel belongs to the person's workspace, not to one conversation. It stays as it is when
  the person switches between Nectovia and Work or between conversations.

### Arrangements and tabs

- Three arrangements: One panel (default), Stacked (two halves, top and bottom) and Side by side
  (two columns). The person picks one in the panel's menu. Settings, Appearance shows the same
  control.
- At most two slots. Each slot has its own tab strip, always visible.
- The add button in a tab strip lists every tool. A tool the person's plan does not include is
  shown disabled with its reason (see Tool contract), the same pattern as Nectovia in Work's
  engine menu on the free plan.
- A tool that allows one instance (Files) moves to the slot where it is added if it is open
  elsewhere. A tool that allows many (the browser, later) opens a new tab each time.

### Fit rules

One pure function decides placement. It lives in `client/console/multitask/fit.ts` and has no
DOM access, so the whole table of cases is a unit test.

```ts
type Arrangement = 'single' | 'stacked' | 'columns';

interface FitInput {
  viewport: number;        // layout width in CSS px: innerWidth / --dm-ui-scale
  rail: number;            // measured rail width (232 today, the reskin sets its own)
  arrangement: Arrangement;
  widths: [number, number]; // the person's remembered panel widths
  open: boolean;
}

interface FitResult {
  placement: 'closed' | 'beside' | 'over';
  shape: Arrangement;      // what is actually shown, after any fallback
  column: number;          // work column width in CSS px
  panels: number[];        // one width per visible panel column
}
```

Constants: column maximum 920 (`--dm-measure`), column minimum 640, gutter 24 each side, panel
minimum 320, panel maximum 960, panel default 400, and no panel wider than 60% of the viewport
(the cap `artifactMaxWidth` in `client/console/artifact-width.ts` already applies).

Steps:

1. Closed: column is the smaller of 920 and the viewport minus the rail minus 48.
2. Open: try the chosen arrangement. Side by side needs two panel columns. One panel and
   Stacked need one.
3. Room left for the column is the viewport minus the rail, 48 and the panel widths. If it is 640 or more, the
   panel sits beside and the column is the smaller of 920 and that room.
4. If not, shrink the panels evenly toward 320 until the column reaches 640.
5. If the panels are at 320 and the column is still under 640, fall back one shape: Side by
   side becomes Stacked, then repeat from step 3.
6. If Stacked or One panel still does not fit, the panel slides over the right edge of the
   conversation (`over`). The column then uses the closed width, and the panel keeps its width
   capped at 60% of the viewport.

Worked cases with today's 232px rail and two 400px panels, Side by side chosen:

| Viewport | Result | Column | Panels |
|---|---|---|---|
| 2560 | beside, side by side | 920 | 400, 400 |
| 1920 | beside, side by side | 840 | 400, 400 |
| 1440 | beside, stacked | 760 | 400 |
| 1280 | beside, stacked | 640 | 360 |
| 1100 | over, stacked | 820 | 400 |

With the boards' 272px rail, 1920 gives a 800px column and still fits side by side.

A wide window is one where the stored layout, computed as if open, lands `beside` at the
current viewport.

### Memory

- Stored in `localStorage`, like the Files pane width and the rail pins in
  `client/console/Shell.tsx`. The reason recorded there applies: `validateSettings` rejects keys
  not in `defaults()`, so a Settings key would be a server change and a migration for every
  settings file. A browser that refuses storage gets the defaults and everything still works.
- One key, `console.multitask.layout`, holds: open on wide windows, arrangement, both widths, and
  per slot its tabs (tool id plus that tool's saved state) and the active tab.
- The Side panel layout row in Settings, Appearance reads and writes this same local key. It is
  a preference for this computer, and it adds no server Settings key.
- On a wide window the panel restores exactly that layout.
- On a small window the panel always starts closed. Opening it there slides it over and does not
  change the stored open state for wide windows. Tab changes made there are still stored.
- First run after the update: if `console.files.open` is `true`, the stored layout starts open
  with one Files tab, and the width from `console.files.width` raised to at least 320. The old
  keys are then removed.

### What becomes of today's panels

- The Files pane becomes the Files tool. Its width range moves from 240 to 640 onto the panel's
  320 to 960. Its default moves from 320 to 400 so two panels fit a 1920 monitor.
- The artifacts panel's "Open in panel" opens an Artifacts tab in the first slot. Its own width
  range (320 to 960, default 480) is replaced by the panel's.
- The board becomes the Board tool. At panel width it shows a compact list grouped by column.
  The full board stays in Work.
- The Routines view (today `client/console/AutomationsPage.tsx`) becomes the Routines tool, with
  the same access rule the view applies.
- On a viewport where the panel does not fit beside, Files now slides over instead of squeezing
  the column. This is a visible change from today and is intended.

### Keyboard and focus

- Each tab strip is a `tablist`: arrow keys move between tabs, Enter or Space opens one, Delete
  closes it.
- Esc closes the panel when it is sliding over the conversation.
- Focus order runs rail, conversation, panel. Ctrl+\ moves focus into the panel when it opens and
  back to where it was when it closes.

### Plans

- Multitask mode is on every plan.
- Each tool keeps its own plan rule through `access()`. Routines stays paid-only inside the
  panel.

## Tool contract

Every tool is a module in one registry, `client/console/multitask/tools.ts`. This is a sketch;
names may change in the plan, the shape may not.

```ts
interface PanelTool {
  id: string;                      // 'files' | 'artifacts' | 'board' | 'routines' | later 'browser'
  title: string;                   // default tab title
  icon: IconName;
  access(plan: PlanInfo): { ok: true } | { ok: false; reason: string };
  multiInstance: boolean;
  render(slot: SlotContext): ReactNode;
  native?: true;                   // reserved for the browser
}

interface SlotContext {
  width: number;
  height: number;
  state: unknown;                  // this tab's saved state, parsed; undefined when fresh
  setState(next: unknown): void;   // must be JSON serializable
  setTitle(title: string): void;
  openTool(id: string, state?: unknown): void;
}
```

- Tools added by capability packs fit this contract later. The registry is static in this
  build.

## Dragging into the ask box

The ask box has no drop target today (`client/console/Composer.tsx` has no `onDrop`), so it
gains one. What it receives goes through two inputs the composer already has:

- A file: a project document becomes an attachment chip through `onAttachments`. The existing
  rules hold: at most eight documents per message, and `attachmentProblem` flags a file that
  cannot be sent before sending.
- Text: a link with its title, or a selection, is inserted at the cursor through the composer's
  `insert` input. The person sees exactly what will be sent.

What each first tool gives when dragged:

| Tool | Payload |
|---|---|
| Files | file |
| Artifacts | file, when the artifact is saved in the project; otherwise not draggable |
| Board | text: the task's title |
| Routines | not draggable |

Dropping something into the ask box is the person choosing to share it. No other path sends
panel content to a model.

A third kind, saving a web page into the project and attaching it, belongs to the browser spec.

## Native web views (reserved for the browser)

- A slot with a native tool reports its rectangle in device pixels to the desktop main process
  over the preload bridge. Main places an Electron `WebContentsView` over it with `setBounds`.
  `BrowserView` is deprecated and is not used. The app is on Electron 44.
- A native view always draws above the page, so anything the app draws over the panel would be
  hidden: menus, dialogs, the add list, the slide-over on small windows. The shell exposes one
  signal, something is on top of the panel. While it is set, the slot shows a still image of the
  page (`webContents.capturePage`) and the live view is hidden.
- Phase 2 builds the signal and the rectangle reporting only if the browser spec is approved by
  then. Otherwise both wait for the browser build.

## When something goes wrong

- Each tab renders inside its own error boundary. A tool that throws shows a short message and a
  Reload button inside that tab. The rest of the app keeps working.
- A restored tab whose tool the plan no longer includes shows disabled with the tool's reason.
- Stored layout that cannot be parsed, or a tab state a tool rejects, starts that part fresh. It
  never stops the panel from opening.

## Testing

Phase 1 tests are listed in Phase 1. Phase 2:

- `tests/multitask-fit.test.ts`: the fit function over a table of viewports (2560, 1920, 1680,
  1440, 1280, 1100, 900), each arrangement, rail widths 232 and 272, Interface size 100% and
  125%, and remembered widths at the limits.
- `tests/multitask-layout.test.ts`: reading and writing `console.multitask.layout`, including bad
  JSON, unknown tool ids and the first-run move from the Files keys.
- `tests/multitask-ui.spec.ts` (browser suite):
  - Ctrl+\ and the panel button open and close the panel.
  - Switching arrangements.
  - The fallbacks at 1920, 1440, 1280 and 1100.
  - Restore after reload on a wide window and on a small window.
  - Tab keyboard behavior.
  - Dragging a Files item into the ask box makes a chip.
  - Dragging text inserts it.
  - A tool that throws stays inside its tab.
  - A tool outside the plan shows disabled.
- The existing Files pane and artifact panel browser tests move to the new host and keep their
  assertions.

## Later map

Each item gets its own spec when its turn comes.

1. Built-in browser, next after Phase 2.
   - Each browser tab is its own `WebContentsView`.
   - It runs in its own session partition, apart from the app's storage, and cannot reach the
     app's local service address.
   - It has no preload or Node access and is sandboxed.
   - Downloads and camera, microphone and location requests ask first.
   - Pop-ups open as new tabs in the same slot.
   - Google Drive, Google Calendar and Gmail are ready-made entries in the add list: browser
     tabs opened on those sites.
   - The spec starts with a feasibility test: Google sign-in inside the view, editing in Google
     Docs, and memory use with two to four tabs open on Andrew's PC. If Google refuses sign-in,
     the fallback is a Google connection through Google's API, which is its own spec.
2. Pop-out windows, for power users and multi-monitor setups. Any tab can open in its own
   window and returns to the panel when that window closes.
3. Nectovia working in the panel: Nectovia drives a browser tab while the person watches. It
   needs a consent step and the live-frame redaction rules, so it follows the browser.
4. Tools added by capability packs.

## Build order and tracking

- Phase 1 goes into the reskin's build brief as a hard requirement, with this file as the
  reference.
- Phase 2 starts after the reskin merges to main, in this worktree's branch or a fresh one from
  the main of that day.
- Linear, after this spec is approved: a parent issue Multitask mode, with children for the size
  rules (blocking the reskin), the panel host, the browser feasibility test, pop-out windows and
  Nectovia in the panel. Search for duplicates first.

## Out of scope

- Any change to the reskin's own layouts beyond the size and space rules.
- New Settings keys on the server.
- Tools from capability packs, the browser, Google connections, pop-out windows and Nectovia
  working in the panel, each covered by the later map.

## Interface text (draft)

Checked against the voice guide of 2026-09-28 for the app surface. No app string audit exists,
so these are unverified against the app until the build.

| Where | Text |
|---|---|
| Panel button label and tooltip | Side panel |
| Shortcut hint in the tooltip | Ctrl+\ |
| Menu group | Layout |
| Arrangement choices | One panel, Stacked, Side by side |
| Add button label | Add a tool |
| Tab titles | Files, Artifacts, Board, Routines |
| Routines when the plan lacks it | Routines come with a paid plan. |
| A tab that stopped | This tab stopped working. |
| Its button | Reload |
| Settings, Appearance row | Side panel layout |
