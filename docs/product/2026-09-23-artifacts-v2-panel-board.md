# Artifacts v2, lane 4: Mermaid math, the progress board, safe saves and the thread preview

**Decision record.** Version 2026-09-23.0. Artifacts panel v2 was approved by Andrew on 2026-09-23 and
targets 0.1.9. This lane carries frozen decisions 6 (the progress board) and 8 (Mermaid math and
pictures), and engineering items E2 (`merge: false`) and E3 (the thread-list preview).

**Status: complete on `feature/artifacts-panel-board` (worktree
`F:/Diomedes/diomedes-wt/artifacts-panel-board`, base `a298382`, lane 1's commit). All four gates
pass. Committed locally; not merged, not pushed, not released.** The merge order is lineage, then #44,
then lane 3, then this lane, then lane 2; this lane rebases onto main after #44 merges.

Not in this lane: the "Update this conversation" menu item and the recorded-artifact view
(`artifact-evidence.ts`) are lane 2's. Neither is built here, not even as a stub.

## E1: math and pictures in Mermaid diagrams

### What turns math on

Math is drawn only on a page that carries the app's Content-Security-Policy. The signal is read from
the page itself: whether its `<head>` holds a Content-Security-Policy `<meta>`.

- The build writes that `<meta>` into the built `index.html`, first in its head, and nowhere else:
  - `scripts/app-csp.ts:63-67`: `APP_CSP_TAG`, with `injectTo: 'head-prepend'`;
  - `scripts/app-csp.ts:70-80`: the plugin, with `apply: 'build'` at `:75` and the `index.html`-only
    filter at `:77`;
  - `vite.config.ts:17`: where it is registered.
- The development server serves `index.html` without it, because the plugin applies at build only.
- `carriesPolicy` (`client/console/mermaid-render.ts:127`) looks for a `<meta>` child of `<head>`
  whose `http-equiv` is `Content-Security-Policy` (any case, trimmed) and whose content is not empty.
  A report-only policy refuses nothing, so it does not count. Where there is no document (Node), math
  is off.
- `diagramPolicy()` (`:138`) reads it at every draw (`draw`, `:584-587`).

The signal is the page, not a build-time define. A define would say what the bundle was built for,
while the policy in the page is what actually refuses a load. That policy includes
`img-src 'self' data:` and `script-src 'self'`, so a load that got past everything below could reach
only the local service, never anywhere outside. The pre-check below keeps even a load from the local
service out: the browser test for it points a linked picture at one of the project's own documents,
and nothing reads it.

Two browser tests pin it:
- **The development server**, the suite's own Vite server, imports the real renderer and gets
  `REFUSED_MATH_HERE`.
- **The built bundle, with the `<meta>` taken out** by a route, refuses math the same way.

### Before Mermaid draws: the pre-check

`refusal(source, policy)` (`:181`) is pure. It reads the prepared source: frontmatter and directives
are stripped, as in v1. It checks, in this order:

1. **Math.** `hasMath` (`:149`) looks for `$$...$$` within one line, which is Mermaid's own
   `katexRegex`. Every spelling of `$` that Mermaid may turn back into one is read as a dollar
   (`DOLLAR`, `:52`):
   - character references (`&dollar;`, `&#36`, `&#x24`);
   - Mermaid's own `#36;` and `#dollar;`;
   - a markdown string's `\$`.

   Not every spelling reaches Mermaid as a dollar, so this errs towards finding math. When it finds
   math:
   - on a page without the policy, the diagram is refused with `REFUSED_MATH_HERE`;
   - beside markup of the diagram's own, it is refused with `REFUSED_MATH_MARKUP`.

   Markup means:
   - `<` or `~` anywhere in the diagram. `<` counts anywhere because a raw span can pair its dollars
     differently from the label it sits in, and `~` because a class diagram turns `~T~` into `<T>`.
   - `&` or `\` outside the math, since they start a character reference or an escape. TeX's own `&`
     and `\` inside `$$...$$` stay.

   Inside math, write `<` as `\lt`.
2. **Pictures.** Each `@{ ... }` shape-data block is refused with `REFUSED_SHAPE_ESCAPE` if it holds
   any `\`, since a YAML key could spell `img` as `\x69mg`. It is refused with `REFUSED_IMAGE` unless
   its picture, if it has one, is exactly one double-quoted
   `img: "data:image/(png|jpeg|gif|webp);base64,..."`, with `img` appearing nowhere else in the block.
3. **Styles.** v1's rule, `REFUSED_STYLE`, is unchanged.

v1's single `REFUSED_MATH_OR_IMAGE` sentence is gone. In its place:

| Sentence | Says |
|---|---|
| `REFUSED_MATH_HERE` | Math is drawn only in the app itself, whose page refuses every outside load, and this page does not. |
| `REFUSED_MATH_MARKUP` | The diagram has math and also `<`, `~`, or `&` or `\` outside the math. In math, write `<` as `\lt`. |
| `REFUSED_IMAGE` | Only a picture written into the diagram, as a quoted `data:image` URL (PNG, JPEG, GIF or WebP), is drawn. |
| `REFUSED_SHAPE_ESCAPE` | Shape data with an escape (`\`) could name a picture from a link. |

### How Mermaid is configured

`mermaidConfig(tokens, drawing)` (`:481`):
- **MathML only.** `legacyMathML` and `forceLegacyMathML` are both `false`, and both are fixed through
  `secure`. KaTeX's HTML output would need its stylesheet and fonts.
- **`htmlLabels` is `true` only for a diagram with math** that passed the pre-check on a page with the
  policy. Every other diagram keeps v1's SVG-text labels. The reason is that Mermaid 11.17.2 draws a
  flowchart's math only inside an HTML label:
  - `labelHelper` calls `createText` (`node_modules/mermaid/dist/chunks/mermaid.core/chunk-4HAMMTFA.mjs:153-171`,
    `chunk-GMAD6QVW.mjs:620-631`);
  - sequence and class diagrams draw math either way; a class diagram switches to HTML for a label
    with math (`chunk-4HAMMTFA.mjs:5003`).
- **The label allowlist** (`dompurifyConfig`) for a diagram with math:
  - tags: v1's label tags plus `MATH_TAGS` (`:451`);
  - attributes: `class` plus `MATH_ATTRIBUTES` (`:461`);
  - no data attributes.

  Every other diagram gets v1's allowlist.
  - **`MATH_TAGS`** are presentation MathML only: `math mrow mi mn mo mtext mspace msup msub msubsup
    mover munder munderover mfrac mroot msqrt mtable mtr mtd mlabeledtr menclose mstyle mpadded
    mphantom`.
    - Left out: `mglyph` (it names a picture), `maction`, `annotation` and `annotation-xml`.
    - DOMPurify drops `semantics` and keeps what it holds.
  - **`MATH_ATTRIBUTES`** are the presentation attributes KaTeX writes, none of which names a file.
    There is no `href`, `src`, `style`, `xmlns` or `id`.
- **Where the allowlist comes from.** A test renders a 24-expression KaTeX corpus exactly as Mermaid
  calls KaTeX: no `trust`, MathML output, and the annotation taken out. It requires every tag and
  attribute in the output to be allowed, or known to be dropped (`semantics`, `xmlns`, and the `style`
  of a `\fcolorbox` border). Commands that need `trust` (`\href`, `\url`, `\includegraphics`,
  `\html*`) come out as red text, with no `href` or `src`.
- **Mermaid sanitises KaTeX's output with this allowlist** before it goes anywhere
  (`renderKatexSanitized`, `chunk-DU6HZSFF.mjs:5253-5255`). That includes the copy it measures in
  `document.body` (`calculateMathMLDimensions`, `:5214-5226`).

### KaTeX stays local

KaTeX 0.16.47 comes with Mermaid 11.17.2, as its dependency, hoisted to `node_modules/katex`. The
build emits it as a chunk of its own, `dist/assets/katex-*.js`, which Mermaid loads through its own
dynamic import, from the local service like every other chunk (`script-src 'self'`). It draws MathML
only, so it needs no stylesheet and no font.

The built-Console math test checks three things: the drawing holds no `href` or `src`, holds no KaTeX
HTML, and reads no document while it is drawn. The page's own policy keeps every other load on the
local service.

### Pictures

- **What is allowed.** Only a `data:image` URL, base64, of type PNG, JPEG, GIF or WebP, written into
  the diagram. SVG pictures are left out. A picture from a link stays refused.
- **Size.** Mermaid's `maxTextSize` (50,000 characters, fixed through `secure`) bounds how large one
  can be.
- **Not tied to the policy.** A data URL loads nothing. Mermaid decodes it in the app document
  (`imageSquare`), which the policy's `img-src 'self' data:` allows.

### Where the pre-check can be wrong, and why that stays safe

`entity-probe.mjs`, a browser probe in the lane notes, showed where Mermaid finds math the source
does not spell plainly:
- In a label, Mermaid reads `&dollar;`, `#36;`, `#dollar;` and `&#36` (without a semicolon) as
  dollars only when the label also holds markup, because DOMPurify returns text with no `<` untouched.
- In a markdown string, Mermaid reads `\$\$...\$\$` as math.
- It never reads `&#36;` as a dollar, because its own entity handling rewrites it to `&&#36;`, and it
  never reads `&#x24;` as one either.

The pre-check now reads all of these as dollars.

If a crafted diagram still gets math past it, what Mermaid draws still passes the label allowlist:
- **Without the policy**, that is v1's allowlist, which keeps no MathML at all. In the probe, a class
  diagram's KaTeX output came back as an empty span.
- **With the policy**, it is the MathML allowlist above.

The pre-check pairs dollars along each line of the diagram, across labels, while Mermaid pairs them
within each label. That is why `<` is refused anywhere. An `&` or `\` hidden inside a span that
crosses labels can only reach a label that Mermaid draws through the same allowlist.

### For lane 2's `ARTIFACT_FORMAT`

The format text needs updating, and so does its digest in `KNOWN_INSTRUCTION_DIGESTS`:
- Math, written `$$...$$` within one line, is drawn in flowcharts, sequence diagrams and class
  diagrams. Other diagram types were not tested.
- In a diagram with math:
  - no `<` anywhere (write `\lt` in the math);
  - no `~` (so no class generics);
  - no `&` or `\` outside the math (no entity escapes and no markdown escapes).
- In a flowchart label, Mermaid collapses `\\` to `\` before KaTeX sees it (`chunk-GMAD6QVW.mjs:626`),
  so a TeX row break is written `\\\\`.
- A picture is written into the diagram: `A@{ img: "data:image/png;base64,...", label: "Logo", w: 48,
  h: 48 }`. The whole diagram must stay under 50,000 characters.

## (d) The progress board

### Where it is

- **The artifact column.** With no artifact open, the column holds the board as its own view,
  `BoardPane` (`client/console/ProgressBoard.tsx:59`).
  - It opens by itself, without taking focus, while the thread's work is still moving.
  - It opens only where the stage has room for the column (861 px or wider, as in `artifacts.css`).
    On a narrower stage the panel would cover the thread.
  - With Files open, the switch reads Files | Progress.
- **Under an open artifact,** the board sits compactly beneath the artifact's head, so the count stays
  in sight.
- **Closing it.** Close, or Esc inside it, puts the board away until it counts different tasks. The
  board's key is the thread plus the ids of the tasks it counts, and it is remembered per person under
  `console.board.closed` (localStorage, like `console.pane.view`).

### What it counts

It uses no new server event and no new endpoint. `boardFor`
(`client/console/board-model.ts:125`) is pure: no React, DOM, clock or request.

1. **Plan tasks.** These are tasks whose `from.plan` is the plan the thread is attached to
   (`attachedTo {kind: 'plan', ref}`), as `plans/add-tasks` makes them.
   - They are ordered and counted exactly as the Board's plan groups are (`progress-bars.ts`
     `planGroups`): two tasks at least, deleted ones left out, and ordered by step, then by creation,
     then by id.
   - A backslash in either path is read as a slash.
2. **Work the conversation started.** `startedWorkOf` (`:38`) reads the receipt phases the host
   records as pure `transform` steps in the conversation's Automatic lineage runs
   (`server/interaction-service.ts:615-656`), as the host reads them back: succeeded steps only.
   - `phase.task-input` gives the task's project.
   - `phase.task-receipt` gives the task.
   - `phase.work-receipt` gives its run.

   `useStartedWork` (`ProgressBoard.tsx:122`) reads those runs with the existing
   `GET /api/projects/:id/harness/runs/:runId`. It reads only `mode: 'auto'` lineages, since only those
   start work. It reads them again when a lineage comes, a message settles, a task appears or a run
   starts, and never on a timer. The task receipt is saved before the task's work starts, so the read a
   new run brings is sure to find it.
3. **Each step's state.** This comes from the task record, the sessions, the needs and the changes,
   through `taskEvidence` and then `stepState`. That is exactly what the Board's columns show, so the
   two never disagree. The server's `tasks`, `session` and `needs` events reload the Console's state
   (`Shell.tsx`), and the board follows it.

### The honesty rule

- **Nothing counts unless it is a task record.** No turn is read, so a model-written progress visual,
  step or percentage is never counted. A model's own steps inside one reply have no honest total, so
  they are not counted at all.
- **A group needs real records.**
  - The plan group needs at least two task records.
  - The started group has one step per receipt whose task this project holds.
  - A receipt with no task input (its project unknown), a task in another project, and a deleted task
    each get no step.
  - With no records there is no board, so no denominator is ever shown.
- **It shows only while work is open.** The board is shown only while some step is active, pending or
  blocked.

### How it looks

It follows the Console design language:
- **The panel's own plate:** the cut-corner plate and the resize grip, now shared as `PaneEdge` in
  `ArtifactPane.tsx`. The head has the kind label "Progress", the thread's name as its title, and
  Close, then one status line: "Counted from task records as they change."
- **Each group reads like the Board's plan row:** its name in caption type (`--t2`), then the Board's
  own segment bar at panel size. The bar has one segment per task, and its value text reads
  "N of M tasks done".
- **The full view** lists the tasks under hairline rules. Each task has:
  - the Console's own point (`console.css` `.pt`; under Nectovia, the cut-corner glyph from
    `nectovia.css`). It is filled in the lead colour while its run works, filled amber while it waits
    on the person, and filled red when failed. Otherwise it is an outline, which is brighter once the
    task is done;
  - its name in body type (`--t1`, then `--t2` once done);
  - under the name, the task record's own words in caption type (`--t3`, amber when blocked, red when
    failed).
- **The compact form** under an artifact's head has a hairline above it and puts each group on one row:
  the name in a 10rem cell, then the bar.

## E2: `merge: false` on `/documents/write`

- `/documents/write` (`server/app.ts:1783-1792`) now takes `merge`, which is either absent (as before)
  or exactly `false`. Any other value is a 400, and nothing is written.
- With `false`, the write is its own History entry.
- Without it, `Store.writeRecorded` still folds a single-file edit into your last edit of the same file
  while that edit is under ten minutes old (`server/store.ts:1263-1278`).
- Save to Files sends `merge: false` with every later version of an artifact
  (`client/console/artifact-save.ts`). A first save goes through `documents/create`, which already
  keeps its own entry.
- Nothing else in `server/app.ts` changed, and `server/store.ts` did not change.

## E3: the thread-list preview

The Shell's thread list (`client/console/Shell.tsx:1470`) shows `previewLine(lastTurnText, 60)` from
`shared/thread-preview.ts`, never raw Markdown or a fence. A task thread still shows its task's name.
An empty turn says "Nothing said yet", and so does a list-only turn, which previews as `''`.

## Tests

Every new test was seen to fail before the change it covers.

**Unit tests (vitest):**
- **`tests/artifact-frame.test.ts`.** v1's refusal test was updated to the new sentences. Added:
  - the math configuration test;
  - the KaTeX-corpus allowlist test;
  - `mermaid math`: the policy, how dollars are spelt, drawn against refused, and markup;
  - `mermaid pictures`: the data URLs allowed, the variants refused, and escapes.
- **`tests/board-model.test.ts`** (new, 10 tests). It covers:
  - the honesty rule: a thread whose reply is a `progress` visual claiming 90% is counted only by its
    tasks;
  - no board without records;
  - showing only while work is open;
  - states matching `taskEvidence` and `stepState`;
  - order and count matching `planGroups`;
  - a plan path with backslashes;
  - started work read back from receipt phases alone;
  - the started group and its cross-project and deleted cases;
  - not counting a task twice;
  - the key.
- **`tests/documents-write-merge.test.ts`** (new, 3 tests):
  - a second version saved within ten minutes keeps the first version's own History entry, and
    restoring it gives the first text back;
  - `merge` values `true`, `'false'`, `0`, `null` and `{}` each get a 400 and write nothing;
  - without the flag, an edit still folds, as a control.
- **`tests/artifact-save.test.ts`.** The later-version write carries `merge: false`.

**Browser tests (`tests/artifacts-ui.spec.ts`, 7 new):**
- math drawn as MathML on the built Console, fetching nothing;
- math beside markup, and a picture from a link, refused before Mermaid draws them;
- a `data:image` picture drawn;
- a page without the app policy drawing no math;
- the development server keeping math off;
- the board for a running plan, following the tasks event, surviving a reload, and staying closed once
  closed;
- the thread list reading a fence-only reply by its title.

**How each was seen to fail:**
- All 7 browser tests failed before the change.
- The new unit cases failed before their code existed.
- Two mutations were run against the finished code:
  - **The board read visual replies as steps:** the honesty test failed.
  - **`diagramPolicy` forced on and the markup rule switched off:** 2 unit tests failed, and on a
    build, 3 of 3 browser tests failed: the development-server test, the no-policy test and the
    markup-and-link test. The development-server test received a drawn MathML `<msup>`.
- The Mermaid-spelling cases (`#36;`, `#dollar;`, `\$`) failed (3 tests) before `DOLLAR` learned
  them.

The logs and the notes are in the lane's scratchpad (see the report).

## Gates

The gates ran under the heavy slot from 09:47 to 09:55 on 2026-09-23, in worktree
`F:/Diomedes/diomedes-wt/artifacts-panel-board`. No file was touched while they ran.

1. `npx tsc --noEmit -p .`: **exit 0.**
   Log: `.../scratchpad/logs/v2l4-gate-tsc.log`
2. `npx vitest run`: **325 test files passed (325); 5788 tests passed and 4 were skipped (5792).**
   Nothing failed, so nothing needed a re-run on its own.
   Log: `.../scratchpad/logs/v2l4-gate-vitest.log`
3. `npx vite build`: **exit 0**, built in 6.64s.
   Log: `.../scratchpad/logs/v2l4-gate-build.log`
4. `npx playwright test` (`DIOMEDES_UI_CLIENT_PORT=5254`, `DIOMEDES_UI_SERVICE_PORT=47712`):
   **206 passed and 0 failed, in 5.4 minutes.** That is lane 1's 199 plus this lane's 7.
   - No C07 / F01-F02 race occurred.
   - No other spec saw the board open by itself.
   - Afterwards, `git restore -- evidence/ docs/verification/2026-09-17-design-center/` exited 0.

   Log: `.../scratchpad/logs/v2l4-gate-pw.log`

`.../scratchpad` is this session's scratchpad (the full path is in the lane report). The lane's notes
are in `.../scratchpad/v2-lane4/`:
- the seen-fail logs, the mutation notes and the probes;
- `shots/progress-board.png` and `shots/math-in-panel.png`.

## Known gaps

- Automatic can make a task in another project (`verdict.projectId`). The board counts only the tasks
  of the project it shows, so such a task has no step, and no step is guessed.
- Started work is proven in unit tests only. `startedWorkOf` is tested against recorded receipt phases,
  including a read back after a reload. No browser test drives an Automatic run to a started task, so
  `useStartedWork` (its reads, and the re-read a new run brings) is not exercised end to end. The
  board's browser test starts its task through `work/start` directly, on a plan thread.
- Between the moment a new lineage is saved and the moment its run starts (`server/app.ts:3558`), a
  read of that run is answered 404. It counts nothing, and the next change reads it again.
- A board that was closed stays closed per person (localStorage), not per thread for everyone.
- On a stage narrower than 861 px, the board does not open by itself. It still appears compactly under
  an open artifact.
- Math in diagram types other than flowchart, sequence and class diagrams was not tested.

## For lane 2 and the integrator

- **`ARTIFACT_FORMAT`** needs the text above, and a new digest.
- **`REFUSED_MATH_OR_IMAGE` no longer exists.** A test elsewhere that expects a `.mmd` with `$$` to be
  refused with v1's sentence will need the new ones: `REFUSED_MATH_HERE` off a built page, or a drawing
  with the policy.
- **New surface:**
  - `ArtifactPane` has a `board` prop, and `PaneEdge` is now exported from it.
  - `useArtifactHost` takes `board` and `boardTitle`.
  - The panel switch's second button reads "Progress" when the column holds the board.
  - Lane 2's recorded-artifact view should keep the compact board under the head.
- **On a wide stage, a thread with open plan tasks, or with started work, now opens the third column
  by itself.** No current spec is affected (206 of 206 pass). A later spec that expects that column
  closed for such a thread will see the board.
- **Nothing in the Console attaches a thread to a plan today.** Only the older Workspace's plan page
  does (`client/Workspace.tsx:592-595`), and so does a direct `POST /threads` with `attachedTo`. On the
  Console, the plan group appears for such threads, and the started group for Automatic threads.
