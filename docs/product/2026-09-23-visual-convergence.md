# Visual convergence: one renderer for charts, progress and inline visuals

Date: 2026-09-23. Lane VISUALS, branch `feature/visual-convergence`, worktree
`F:/Diomedes/diomedes-wt/visual-convergence`, based on integration/nectovia at `fb00419`.
**State: uncommitted, unpushed, unmerged, unreleased.** Running status: `PROGRESS.md` in the
worktree root.

## Why

Two lanes built overlapping renderers for a model's visuals:

- model-artifacts (merged as `f569d69`) drew a ` ```chart ` fence (`chart-spec.ts`, `Chart.tsx`)
  in the side panel;
- nectovia-inline-visuals (routing `475fb11`) draws a ` ```visual ` fence (`shared/visual-spec.ts`)
  in the turn (`InlineVisual.tsx`), and `VISUAL_INSTRUCTIONS` in `server/modes.ts` teaches it to
  the model.

No model was ever taught the ` ```chart ` fence. Both lanes agreed that `TurnBody` is the one body
renderer and that ` ```chart ` retires. The panel keeps mermaid, svg, html, markdown and tables,
and gains "Open in panel" for visuals. Progress is drawn by the skin's `SegmentBar`, which gains a
`fraction` mode.

## What a person gets

- **A visual is drawn where the reply put it.** Under each valid visual in a saved turn there is
  a quiet "Open in panel" control. It never appears on a live preview. While the panel shows the
  visual, the control reads "In panel" and is marked current, as a chip is. In the panel, a
  visual is the kind **Visual**. It is drawn at the panel's own width, so an 11 px label stays
  11 px, and it has the same Rendered or Source, Copy source and Save to Files as the other kinds.
  Save writes the reply's JSON to `Saved artifacts/<title>.json`, and Files offers "Open in panel"
  for that file.
- **"Chart this" on a table uses the same renderer.** It draws a bar chart, or a line chart when
  the first column reads as ordered periods. It is offered only when a number column can be
  charted, and the column list names only those columns. A row with no number in the chosen
  column is left out, and the chart says how many rows were.
- **A reply's own progress looks like what it is.** The `progress` visual is a share in the
  reply's words:
  - one outlined track, marked `data-source="reply"`;
  - no segments, no travelling highlight, nothing that moves;
  - never a "k of n" the reply did not write.

  The segmented bar stays reserved for counts a record holds (contract A15, A9).
- **The update card and Settings, App updates follow one rule** (`client/update-progress.ts`):
  - steps, when the updater lists them (it lists none);
  - otherwise the bytes a running download has received, over the size its server declared, as
    a fraction ("12.3 of 80.0 MB");
  - otherwise an indeterminate bar while a phase moves;
  - otherwise a sentence.

  Nothing draws a share the updater did not report.
- **Under scheme Nectovia**, charts take the palette, the segment bar meets 3:1, and the panel's
  plate is drawn on a layer behind its content. Every other scheme keeps today's look.

## What changed, item by item

1. **` ```chart ` retired.**
   - `chart` is gone from the artifact kinds (`artifacts.ts`), from `turn-blocks.ts`
     (`fenceKind`, `DRAWING`, `KIND_LABEL`) and from the panel.
   - A saved ` ```chart ` fence now reads as an ordinary code block.
   - `chart-spec.ts`, `Chart.tsx`, their CSS and their tests are deleted (see Deleted).
2. **"Chart this" through the visual spec.**
   - `tableVisual(table, column)` in `artifacts.ts` builds a `bar` or `line` spec from
     `chartColumns(table)`, within the spec's limits: labels and series name at most 60
     characters, a title at most 120, at most 200 points. A longer table is refused, with the
     reason given.
   - The spec is validated with `parseVisualSpec`. The panel draws it with `InlineVisual` at its
     own width (`PanelVisual`, measured with `useElementSize` from `artifact-frames.tsx`, which is
     imported, not edited).
3. **"Open in panel" on inline visuals.**
   - `indexArtifacts` indexes every closed ` ```visual ` block that parses as a record of kind
     `visual`. Its key follows the same lineage as every other kind (scope, turn, block), and its
     title is `spec.title`, or else the kind's label ("Bar chart", "Key figures", "Progress",
     "App update"). The ordinal counts every visual block, open or invalid, the way `TurnBody` and
     `readBlock` count them, so the eight-per-reply limit agrees in both places.
   - `TurnBody` renders `VisualOpen` under a saved turn's visual. It is not rendered on a preview,
     or where there is no panel to open.
   - `ArtifactPane` draws kind `visual` with `InlineVisual` and passes `session`, so an `app`
     run-status card stays live. The session is the thread's own running session
     (`threadRun` in `artifact-panel.tsx`, wired in `Shell.tsx`).
   - `savedExtension` is `.json`. `indexFile` reads a `.json` file that holds a valid spec as a
     visual, titled with `spec.title` or else the file name.
4. **SegmentBar `fraction` mode** (`segment-bar-model.ts`, `SegmentBar.tsx`, `segment-bar.css`).
   - Precedence: steps, then a whole done/total count, then a share, then indeterminate.
   - The share is clamped to [0, 1]. NaN, an infinity, null or no value is indeterminate.
   - The bar is one track with a `scaleX` fill. It has `role="progressbar"`, `aria-valuemin` 0,
     `aria-valuemax` 100, `aria-valuenow` set to the rounded percent, and `aria-valuetext` set
     to the percent and then the source's words.
   - Its caption is the label, then the detail when there is one. It is never an invented
     "k of n".
   - The segmented form is unchanged. A test compares the markup with and without a share
     given.
5. **Inline progress through SegmentBar.**
   - `InlineVisual`'s `progress` renders `SegmentBar` in fraction mode with `source="reply"`.
     `value` null or absent is indeterminate.
   - The superseded `.iv-progress*`, `.iv-track`, `.iv-fillbar` and `iv-busy` CSS is removed.
6. **The update card and the Settings update UI.**
   - `updateBar(status, pending)` in `client/update-progress.ts` is the one rule, and both
     surfaces draw it.
   - The host reports a running download's bytes (see "The updater change" below).
   - The card re-reads the host's record at its existing 3 s interval while a download runs.
     Settings does the same while a download it did not start is running.
7. **Names.**
   - `PRODUCT_NAME` is `AGENT_NAME`.
   - The agent's name in these places now reads `AGENT_NAME`: headings, aria-labels, the
     composer's caption and placeholder, the Home destination and its hint, History's actor and
     filter, and the palette owner (`Diomedes.tsx`, `Composer.tsx`, `Home.tsx`, `ThreadView.tsx`,
     `HistoryView.tsx`, `paletteEntries.ts`).
   - `tests/name-contract.test.ts` gains a scan: no bare "Nectovia" literal in `client/console`
     outside the product-name places it lists, and no "Message/Ask/What/Talk to Nectovia"
     literal.
8. **Skin under scheme `nectovia`** (`client/console/nectovia.css`, every rule anchored on the
   scheme).
   - Series colours are lead cyan, violet trail and bone, then muted tints of the three toward
     t3, then t3. Contrast is in the tables below.
   - The segment bar's pending and active colours are raised to at least 3:1.
   - The artifact panel's plate is cut top left (A1) on a `::before` layer behind the content,
     so nothing inside the panel is clipped.
   - Reduced motion: `html[data-motion='reduced']`, `html[data-motion-preset='none']`, motion
     intensity 0 and the media query each stop every animation and transition of the segment
     bar and of an inline visual.

### The hostile-review items (coordinator, 2026-09-23)

1. **Segment bar motion.**
   - `--seg-on`, which is 0 at motion intensity 0, multiplies every duration.
   - `html[data-motion-preset='none']` and `html[data-motion='reduced']` are named outright,
     mirroring `artifacts.css`.
   - Tested in `tests/segment-bar.test.ts`.
2. **Segment bar contrast.** See the table below. Done stays distinct from pending (3.03:1).
3. **A reply's progress never looks record-backed.**
   - It uses fraction mode only, with an outlined track and `data-source="reply"`.
   - It has no scan and no transition.
   - Steps, a count and failed or blocked states given to a reply's bar are dropped.
4. **A throwing visual never blanks the Console.**
   - `VisualBoundary` (an error boundary) wraps each inline visual in `TurnBody` and
     `ReplyBody`, the panel's body, and "Chart this".
   - InlineVisual's axis math is bounded:
     - finite values only;
     - the step is taken from a quarter of each end, so two values near the largest double
       cannot overflow;
     - a degenerate or non-finite domain falls back to its two ends;
     - at most 12 ticks;
     - tick values are rounded with `toPrecision(12)` and labels are written by
       `Intl.NumberFormat`; the only `toFixed` calls take a fixed 1 or 2 digits, for
       coordinates.
   - Shares are taken from halved values, and a pie whose total overflows shows no total.
   - `{"kind":"bar","labels":["a"],"series":[{"name":"s","values":[1e-120]}]}` draws as a chart.
5. **Title sanitising.** `declarationTitle` turns `"`, CR and LF into `'`, and any run of two or
   more hyphens into one. So neither `-->` nor `<!--` can survive in a declared title, and
   "Plan --> next" is saved as "Plan -> next".

## Deleted

- `client/console/chart-spec.ts` (234 lines) and `client/console/Chart.tsx` (368 lines).
- `tests/chart-spec.test.ts` (168 lines) and `tests/chart.test.ts` (154 lines).
- 170 lines of chart rules in `client/console/artifacts.css`:
  - the `.art-chart*` rules and the `.art-s1` to `.art-s8` series;
  - bars, slices, lines, areas, dots, grid, axes, ticks, units and totals;
  - the legend, swatch, caption, heading and data table;
  - the `--art-trail` and `--art-tab` tokens, and the Paper series block.

  `.art-chartable` (the "Chart this" row) stays.
- In `client/console/inline-visual.css`, the superseded progress CSS: `.iv-progress*`,
  `.iv-track`, `.iv-fillbar` and the `iv-busy` keyframes.
- In `tests/fixtures/scripted-artifacts.ts`, the fixture's `LAUNCH_STEPS` and `PACKING` charts,
  and the spec test that drew them. A model may no longer draw a segmented bar (A15).

## Files touched outside the visual set, with the reason for each

Server and shared files:

- `server/app-updates.ts`: the download reports how far it has got. This is observation only.
  - The transport's `downloadAsset` takes an optional `onProgress(transferred, total)`.
  - The production download calls it with the bytes received and the declared Content-Length
    (null when none was declared).
  - The service keeps a report through `progressGate`, and the snapshot carries it only while
    the download runs.
- `shared/app-updates.ts`: `UpdateStatusSnapshot.download` gains an optional
  `progress?: { transferred: number; total: number | null }`. Being optional, it lets older
  snapshots and fixtures still validate.

Shared files imported but not edited: `shared/visual-spec.ts`, `shared/agent-name.ts`.

Hot file (AGENTS.md, owned by the integrator):

- `client/console/Shell.tsx`: one input, `session: threadRun(state?.sessions, selected)`, to
  `useArtifactHost`, so a run-status card opened in the panel stays live.
  - The lane `security-hardening-cloud-sharing` has claimed `Shell.tsx` (2026-09-23T05:16Z).
    This line is a patch for the integrator to merge.
  - No coordination claims were taken for this lane's paths.

Other client files outside the visual renderers:

- `client/AppUpdates.tsx`, `client/app-updates.css` and `client/use-update-status.ts`: Settings
  and the card draw `updateBar`, and both re-read the record while a download runs.
- `client/update-progress.ts` (new): the one rule.
- `client/attribution-display.ts`, `client/console/Composer.tsx`, `Diomedes.tsx`, `Home.tsx`,
  `ThreadView.tsx`, `HistoryView.tsx` and `paletteEntries.ts`: the names (item 7).

Docs: `docs/product/2026-09-22-model-artifacts.md` and
`docs/implementation/2026-09-22-model-artifacts.md` gain a "superseded in part" note.

Not touched: `artifact-frame.ts`, `artifact-frames.tsx`, `mermaid-render.ts`, `progress-bars.ts`,
`Mark.tsx`, `index.html`, the vite config, `server/index.ts` and `desktop/`. No shipped
identifier changed.

## The updater change: observation only

- **The download path is unchanged.** The URL and channel checks, the bytes written, the size and
  digest checks, the staging, the timeout and the abort and failure handling are as they were.
  The only additions are `observe()` calls after each chunk (and once for a body read whole)
  and the callback the service passes.
- **The observer never throws into the download.** Both the production download and the
  service wrap it in `try`/`catch`. A test gives an observer that throws on every call, and the
  download still completes and verifies.
- **Throttle.** A report is kept once at least 250 ms have passed since the last kept one and it
  is at least 1% of the declared size further on, whichever comes later. The last byte of a
  declared size is always kept. With no declared size, time alone decides, and the total stays
  null.
- **Clearing.** On success, failure or abort, `download()`'s `finally` drops the progress and
  moves a run counter on, so a report that arrives late is ignored.
- **Nothing gets busier.**
  - The host emits no event for progress.
  - The card re-reads the snapshot at the 3 s interval it already used for a moving phase.
    Settings uses the same interval, and only while a download runs.

  Showing a download's bytes at all needs the client to read the snapshot while the download
  runs. Before this change nothing did, so that one read every 3 s is new.
- **Tests** (`tests/app-updates.test.ts`, 6 new; the 38 existing tests pass unchanged):
  - the throttle;
  - the throttled bytes while running and none after success;
  - a real response's declared size, and no size when none was declared (so the bar stays
    indeterminate);
  - clearing after a failure and after an abort;
  - a failing observer.

## Contrast (WCAG 2.x, computed in sRGB)

Segment bar under Nectovia. The pending colour was `--hair-2`, 1.35:1 on ink, and active was the
lead at 45%, 2.88 to 2.92:1.

| Part | Colour | ink #08080c | surface #0d0d12 | raised #14141a | plate #1b1b23 |
| --- | --- | --- | --- | --- | --- |
| pending | `#616872` | 3.55 | 3.44 | 3.26 | 3.04 |
| active | `#317c79` | 4.08 | 3.96 | 3.75 | 3.49 |
| done | `#44d2c9` (the lead) | 10.77 | 10.44 | 9.88 | |

- Done against pending is 3.03:1.
- Active against done is 2.64:1, and active against pending is 1.15:1. The active segment
  differs from pending in hue, and its caption says which step is running.
- `tests/segment-bar.test.ts` recomputes pending and active from the stylesheet's values against
  styles.css's grounds.

Chart series under Nectovia:

| Series | Colour | ink | surface | raised |
| --- | --- | --- | --- | --- |
| s0 lead | `#44d2c9` | 10.77 | 10.44 | 9.88 |
| s1 trail | `#b569fb` | 6.07 | 5.89 | 5.57 |
| s2 bone (t1) | `#e6e9ed` | 16.42 | 15.92 | 15.06 |
| s3 lead 55% to t3 | `#6db3b3` | 8.32 | 8.07 | 7.64 |
| s4 trail 55% to t3 | `#9f7ed0` | 6.04 | 5.86 | 5.54 |
| s5 bone 55% to t3 | `#b8bfc6` | 10.74 | 10.41 | 9.85 |
| s6 lead 25% to t3 | `#7b9ea5` | 6.95 | 6.73 | 6.37 |
| s7 t3 | `#838d99` | 5.94 | 5.75 | 5.45 |

## Decisions taken in this lane

- **The update card has no step list.** The updater declares none. Checking, downloading and
  installing are phases of one record, not counted steps.
- **"Chart this" leaves out a row with no number** in the chosen column and says so, rather
  than drawing a 0 the table never held.
- **A visual has one version.** The spec is strict and has no `id`, so a visual cannot declare
  one, and each visual is the only version of itself, like a table. Versions for visuals would
  need an `id` in `shared/visual-spec.ts` and in what `VISUAL_INSTRUCTIONS` teaches.
- **"Open in panel" is a quiet text control, not a chip.** The visual is already drawn above
  it. It keeps a chip's current state.
- **A progress visual in the panel is titled "Progress".** The spec has a `label`, not a
  `title`, and the kind's label is the fallback the brief names.
- **The panel is the one plate here.** The contract names the artifact side panel as a plate
  cut top left (§3), and it is now drawn on a layer (A1). A visual inside a reply stays flat
  with thin rules, as `inline-visual.css` draws it in every scheme. Plating its stat row or
  table frame would be a design change, not a convergence.

## Tests

- `tests/segment-bar.test.ts` (22):
  - fraction mode: clamping, NaN and infinities, precedence, the aria values, and the
    segmented form unchanged;
  - a reply's bar;
  - the stylesheet's motion kill, reduced and preset-none selectors, and the reply gauge;
  - Nectovia contrast.
- `tests/inline-visuals.test.ts` (38):
  - progress through SegmentBar;
  - the 1e-120 spec;
  - overflowing and vanishing ranges, and an overflowing pie;
  - the error boundary's contract;
  - drawing at a given width;
  - the update card by `updateBar`.
- `tests/artifacts.test.ts` (25):
  - visuals as artifacts: ordinals, the eight-per-reply limit, and invalid and open blocks;
  - visual titles and `.json` files;
  - saving as `.json`;
  - declaration title sanitising;
  - `tableVisual`: bar or line, the blank-row caption, label limits, and the 201-row refusal.
- `tests/artifact-pane.test.ts` (16):
  - a visual in the panel;
  - the live app card;
  - a broken visual;
  - the body's boundary;
  - "Chart this" offered only when it can draw;
  - "Open in panel": markup, current state, never on a preview, and each inline visual inside
    a boundary.
- `tests/turn-blocks.test.ts`: a retired ` ```chart ` fence is a code block, and a live one is
  not held back as an artifact.
- `tests/name-contract.test.ts` (15): the agent's name comes from one place.
- `tests/app-updates.test.ts` (44): the 6 progress tests above.
- `tests/artifacts-ui.spec.ts` (browser, real host and built bundle):
  - a visual drawn in its turn, opened in the panel at the panel's width, saved as `.json` and
    opened again from Files;
  - a retired ` ```chart ` fence reads as code;
  - a bar chart, key figures and a reply's progress in one turn, with the Nectovia series
    colours and the reply gauge's outline and stillness;
  - "Chart this" through the visual renderer;
  - the Nectovia page opening a visual with "Open in panel";
  - the update card and Settings drawing a held download's 12.3 of 80.0 MB, and no share once
    it drops.

**Proved able to fail** (the code broken briefly, then restored; logs in
`F:/Temp/andre/claude/F--Diomedes/93688541-df31-40fc-b4a9-a50c06acda85/scratchpad/logs/visuals/`):

| Mutation | Failed |
| --- | --- |
| `shareOf` clamp removed (`mutation-1-clamp-removed.log`) | the clamping test, 1 of 16 |
| a share read before a whole count (`mutation-2-share-before-count.log`) | precedence, and the segmented form unchanged: 2 of 16 |
| progress not cleared when a download ends (`mutation-3-progress-not-cleared.log`) | 5 of the 44 app-updates tests |
| `declarationTitle` keeps runs of hyphens (`mutation-4-title-dashes-kept.log`) | "keeps a declaration line whole, whatever the title says": 1 of 25 |
| `niceDomain`'s finite-domain guard removed (`mutation-5-domain-guard-removed.log`) | "ranges that overflow or vanish stay finite and bounded": 1 of 38 |
| "Open in panel" offered on a streaming preview (`mutation-6-open-on-preview.log`) | "is never offered on a streaming preview": 1 of 16 |

Mutations 4 to 6 ran through `visuals-mutations.mjs` in the scratchpad, which restores each file
and checks its hash; all three were restored byte for byte.

## Gates

Run 2026-09-23 under the heavy slot (`slot_mudvztyd_1ce315cc`, granted 05:14:40 and released),
in one pass: `scratchpad/visuals-gates.cmd`, wrapper log `scratchpad/logs/visuals/gates-1.log`.
Logs are in `F:/Temp/andre/claude/F--Diomedes/93688541-df31-40fc-b4a9-a50c06acda85/scratchpad/logs/visuals/`.

| Gate | Result | Log |
| --- | --- | --- |
| `npx tsc --noEmit -p .` | exit 0, no diagnostics | `gate-tsc.log` |
| `npx vitest run` (full) | 282 files passed; 5252 tests passed, 4 skipped (5256); `tests/scoped-work.test.ts` passed in the run (30 tests), no re-run needed | `gate-vitest.log` |
| `npx vite build` | exit 0, built in 20.5 s | `gate-build.log` |
| `npx playwright test` (full, ports 5204 and 47662) | 195 passed in 5.7 min, none failed, flaky or skipped; `tests/artifacts-ui.spec.ts` 14 of 14 | `gate-playwright.log` |
| `git restore -- evidence/ docs/verification/2026-09-17-design-center/` | exit 0; neither folder shows a change afterwards | `gates-1.log` |

## Evidence

Under scheme Nectovia (the spec asserts `data-package="nectovia"`), at 1440 wide, from the full
browser run, in
`F:/Temp/andre/claude/F--Diomedes/93688541-df31-40fc-b4a9-a50c06acda85/scratchpad/evidence/visuals/`:

- `visuals-in-turn.png`: an inline bar chart, a stat row and a reply's progress in one turn
  (1440 by 1300, so the whole turn is on screen).
- `bar-chart-in-panel.png`: the same bar chart opened in the panel, with the turn's control
  reading "In panel".
- `table-charted.png`: "Chart this" on a table, charting its Replies column.
- `update-card-mid-download.png`: the update card at 12.3 of 80.0 MB.

Also from the same run:

- `settings-update-mid-download.png`: Settings, App updates drawing the same download by the
  same rule.
- `visual-from-files.png`: the saved `.json` opened in the panel from Files.
- `home-panel.png`: a visual opened from the Nectovia page.

## Open, and what needs Andrew

- **`ReplyBody.tsx` is dead code.** It is used only by tests; the app renders turns with
  `TurnBody`. It now wraps visuals in `VisualBoundary` like `TurnBody`, and could be removed.
- **The artifact chip is still clipped on the element that holds its content**
  (`.art-chip` in `artifacts.css`, all schemes). Contract A1 asks for a background layer. It
  is model-artifacts code outside this brief and is left as it was.
- **`tests/artifacts-ui.spec.ts` is shared with the lane hardening the artifact frames.** A14
  changes its hostile-design test, and this lane changes its chart, table and Nectovia-page
  tests and adds four. The integrator merges both.
- **Name literals left as they are:**
  - Pinned by the name contract, and the product or brand rather than the agent: Wake's
    "Nectovia is waking" and TopStrip's "Nectovia projects".
  - Product names: the Shell and Home group headings, the scheme's name in `schemes.ts`, and
    the `NectoviaMark` wordmark.
  - The Workbook files (`App.tsx`, `components.tsx`).
  - About 60 prose sentences that name the product in the middle of a sentence, in AISetup,
    ai-setup-state, AppUpdates, DocumentEditor, HistoryView, diomedes-view, AgentPicker,
    Allowance, TeamView, InventoryReceipts, ErrorBoundary, conversation-send and others. Moving
    those to `AGENT_NAME` is a copy decision.
- **Visual versions** need an `id` in the visual spec (see Decisions). That is Andrew's call,
  because the spec is what the model is taught.
- **An inline chart in a narrow column shrinks its labels.** This was already so before this
  lane, and `bar-chart-in-panel.png` shows it.
  - In a turn, a chart is still drawn on a fixed 640-wide canvas and scaled to its column. With
    the panel open at 1440 wide, the turn's column is about 330 px, so the 11 px axis labels
    draw at about 6 px.
  - The panel no longer does this: it measures its body.
  - The fix is the same pattern in `TurnBody`: measure the visual's column and pass `width`.
    It is left for a follow-up, because it changes the turn renderer outside this brief.
- **A stat row that wraps leaves an empty tinted cell** (the same screenshot, "Reply rate" on a
  second row). This is `inline-visual.css`'s grid-on-hairline drawing, also from before this
  lane.

## Working notes

- Files are CRLF in this checkout (`core.autocrlf=true`, so the index holds LF whatever the
  working file has).
  - One `sed -i` pass left `tests/artifacts-ui.spec.ts` with LF endings, and it was converted
    back. Its diff stat (195 insertions, 55 deletions) shows no whole-file churn.
  - `client/console/SegmentBar.tsx` was still LF when the gates ran, and was converted to CRLF
    after them. Its diff stat (84 insertions, 16 deletions) is unchanged.
  - The three files this lane created are CRLF (`git ls-files --eol`).
  - Because `SegmentBar.tsx` is newer than `dist/`, the browser specs' freshness check needs
    `npx vite build` before any rerun. The gate script builds first.
- The 4 skipped tests in the full vitest run are in `sign-in-recheck-wiring`, `paths` and
  `dev-server-guard-platform`, none of them this lane's.
- The iteration runs (`iterate-*.log` and `iter*-*.log` in the logs folder) were for working on
  the browser spec. The gate counts above come only from the `gate-*.log` files.
