# Model artifacts v1: implementation record

Version 2026-09-22.1, written 2026-09-23 by the model-artifacts lane (Opus 5.5).

- **Worktree:** `F:/Diomedes/diomedes-wt/model-artifacts`
- **Branch:** `feature/model-artifacts`
- **Base:** `c10b7b2` ("Record 0.1.7 publication and verified website deployment")
- **State:** uncommitted, unpushed, unmerged, unreleased.
- **Decisions and security model:** `docs/product/2026-09-22-model-artifacts.md`.
- **Superseded in part, 2026-09-23:** the ` ```chart ` fence, `chart-spec.ts`, `Chart.tsx`, their
  CSS and their tests are retired. Charts are ` ```visual ` blocks drawn by `InlineVisual.tsx`,
  which open in the panel as the kind Visual. Record: `docs/product/2026-09-23-visual-convergence.md`.

## Release blocker

**`licenses/DEPENDENCIES.txt` must be regenerated before packaging.** This change adds Mermaid
as a runtime dependency, with 112 packages in the lockfile. The notices generator
(`scripts/collect-package-notices.mjs`) needs the network and the pinned `.data/native-runtime`
binaries, so it could not be run here. It walks only the lock root's `dependencies`, and Mermaid is
one of them, so it will find the new packages. Two need a look when it runs:
- `khroma` 2.1.0 declares no `license` field, though its license file is MIT.
- `dompurify` is dual-licensed `(MPL-2.0 OR Apache-2.0)`.

## What shipped

| Step | What | Where |
| --- | --- | --- |
| P1 | Turn parser; turn renderer with real code blocks and tables | `turn-blocks.ts`, `TurnBody.tsx`; used by `ThreadView.tsx` and `Diomedes.tsx` |
| P2 | Artifact index, identity and versions; chart spec, SVG charts, SegmentBar charts; the panel and its host; chips | `artifacts.ts`, `chart-spec.ts`, `Chart.tsx`, `ArtifactPane.tsx`, `artifact-panel.tsx`, `artifact-width.ts`, `artifacts.css`; `Shell.tsx` host |
| P3 | Mermaid (lazy, fenced); srcdoc frames for diagrams, images and designs; desktop frame guard | `mermaid-render.ts`, `artifact-frame.ts`, `artifact-frames.tsx`; `desktop/main.mjs` |
| P4 | Save to Files; Files "Open in panel"; Save on a project conversation on the Diomedes page; both records | `artifact-save.ts`, `FilesPane.tsx`, `DiomedesHome.tsx`, `docs/` |

All client paths are under `client/console/`.

## Files

**New, this lane** (line counts):
- `turn-blocks.ts` (510): pure parser. Paragraphs, headings, lists, fenced code with info
  strings, GFM tables, inline code and bold, CRLF, unclosed fences. It also holds the artifact
  kinds and the live-text preview gate.
- `TurnBody.tsx` (270): React text nodes only. Code blocks with Copy, tables, artifact chips,
  and the "Drawing a diagram…" placeholder while text streams.
- `artifacts.ts` (498): identity digest, declarations, versions, titles, file indexing, and what
  Save writes.
- `chart-spec.ts` (234): the frozen chart spec and its refusals.
- `Chart.tsx` (368): bar, line, area and donut as SVG; segments and progress through SegmentBar;
  a summary name and a data table for every chart.
- `artifact-frame.ts` (215): the one srcdoc builder, the two policies, the sandbox values, and
  frame and design sizing.
- `artifact-frames.tsx` (227): still frames, design frames with a stop on navigation, the
  source view and error cards.
- `mermaid-render.ts` (217): lazy Mermaid, fenced (evidence below).
- `ArtifactPane.tsx` (332): the panel, its head, the stepper, the Rendered/Source toggle, Copy,
  Save and Close, the grip, and nested Document artifacts.
- `artifact-panel.tsx` (233): the selection (open, arrive, close, focus return) and the host
  that shares the third column with Files.
- `artifact-width.ts` (46): the width clamp and remembered width.
- `artifact-save.ts` (75): Save to Files.
- `artifacts.css` (925): every style this lane adds.

**New tests, this lane:**
- Vitest: `tests/turn-blocks.test.ts` (29), `tests/artifacts.test.ts` (16),
  `tests/chart-spec.test.ts` (10, every refusal), `tests/chart.test.ts` (12),
  `tests/artifact-frame.test.ts` (12), `tests/artifact-pane.test.ts` (9) and
  `tests/artifact-save.test.ts` (7). That is 95 tests.
- Browser: `tests/artifacts-ui.spec.ts` (12 tests) with its fixture
  `tests/fixtures/scripted-artifacts.ts`.

**Modified, not hot:**
- `ThreadView.tsx`: assistant turns and live text go through `TurnBody`. It takes three new
  props: `artifacts`, `onOpenArtifact` and `openArtifactKey`. You-turns and team mail are
  unchanged.
- `Diomedes.tsx`: assistant turns go through `TurnBody`. The page hosts its own panel. On the
  All projects conversation Save explains itself (`SAVE_NEEDS_PROJECT`), and the stage makes
  room for the panel above 860 px.
- `DiomedesHome.tsx` (+5): passes the thread as the artifact scope, and Save when the
  conversation is scoped to a project.
- `FilesPane.tsx` (+19/-1): the view can be hidden behind the panel, carries the Files | Artifact
  switch, and offers "Open in panel".
- `types.ts` (+8/-1): the three optional `FilesPaneProps` for those.
- `playwright.config.ts` (shared, not hot): one `testMatch` line for `artifacts-ui.spec.ts`.

**Provided by the integrator, used unchanged:** `SegmentBar.tsx`, `segment-bar-model.ts`,
`segment-bar.css` and `tests/segment-bar.test.ts` (9, green). All four are untouched since the
integrator placed them (22:50:48). The skin lane's copies have changed since then:
- `SegmentBar.tsx` gained a `decorative` prop;
- `segment-bar.css` gained a rule that keeps each segment's own box against the Console's `.seg`
  radio-control rule, and a still reduced-motion scan.

Without that rule, a segments or progress chart in the panel drew each segment as a 2 px
border. `artifacts.css` therefore carries the same rule, scoped to charts
(`.console .art-chart .seg-bar > .seg-track > span.seg`). It is redundant once the skin lane's
`segment-bar.css` lands. A browser test measures every drawn segment against its share of the
track, and fails without the rule (mutation check below).

`PROGRESS.md` at the worktree root is a scratch file for the integrator to delete.

## Hot files: every hunk

**`client/console/Shell.tsx`** (+27/-4, nine hunks):
1. The `react` import drops `type CSSProperties`, which the stage no longer uses.
2. Imports `useArtifactHost` from `./artifact-panel` and `saveArtifact` from `./artifact-save`.
3. Imports `./artifacts.css` after `./console.css`.
4. After `selected`, calls `useArtifactHost({ reset: projectId, scope: selected?.id ?? null,
   turns: selected?.turns, filesOpen, setFilesOpen, filesWidth, onSave, onShowFile })`, with a
   two-line comment.
5. `openDocument` also calls `artifactHost.showFiles()`, bringing Files to the front.
6. `goTo('files')` calls `artifactHost.toggleFiles()` instead of `setFilesOpen(!filesOpen)`.
7. The stage's `className` and `style` come from `artifactHost.stageClass` and
   `artifactHost.stageStyle`. It is the same `files-open` track and `--files-w` variable.
8. `ThreadView` gets `artifacts`, `onOpenArtifact` and `openArtifactKey`.
9. `FilesPane` gets `hidden`, `switcher` and `onOpenInPanel`, and `{artifactHost.pane}` follows
   it in the stage.

**`desktop/main.mjs`** (+8, one hunk, after the existing `will-navigate` guard): a
`will-frame-navigate` handler. It returns for the main frame, for same-document navigation, and
for `about:srcdoc` or `about:blank`. It calls `preventDefault()` for everything else. The
existing `will-navigate`, `setWindowOpenHandler` and permission handler are unchanged.

**`package.json`** (+1): `"mermaid": "^11.17.2"` in `dependencies`.

**`package-lock.json`** (+1192/-87 lines in git's line diff): compared by package path, 112
packages were added, none removed, and no version changed. The deleted lines are the line diff
re-aligning around the inserted blocks. Two existing entries changed:
- the root's `dependencies`, which gained `mermaid`;
- `undici`, which went from optional to required. npm 12 recomputed that flag; `undici` is
  reached through `@ai-sdk/provider-utils` and `@electron/get`.

## Dependency delta

The install ran on 2026-09-22 at 23:39. The `node_modules` junction was removed with
`cmd /c rmdir` (the other install was checked intact afterwards). Then `npm ci`, then
`npm install mermaid@11.17.2 --save`. That is the latest 11.x; 12.0.0 exists, but the work
order pins 11.x.

`node_modules` is now a real directory. `services/control-plane/node_modules` is still a
junction and was not touched. npm 12's `allowScripts` blocked esbuild's postinstall, but
`@esbuild/win32-x64` is present and the transform works. `node_modules/electron/dist` is absent,
because Electron 44 declares no install script. No gate launches Electron, so the desktop smoke
scripts cannot run here.

Licenses of the 112 added packages:

| License | Count | Notes |
| --- | --- | --- |
| MIT | 68 | |
| ISC | 33 | |
| BSD-3-Clause | 6 | |
| Apache-2.0 | 1 | `@chevrotain/types` |
| (MPL-2.0 OR Apache-2.0) | 1 | `dompurify` 3.4.15 |
| Unlicense | 1 | `robust-predicates` |
| MIT by license file | 1 | `khroma` 2.1.0, which declares no license field |
| MIT, optional | 1 | `@types/trusted-types` |

**Bundle** (`npx vite build` in the gate run: 2369 modules, 63 JS chunks, built in 13.67 s):
- The app entry is 603.67 kB (gzip 184.47 kB), and its CSS is 180.68 kB (gzip 31.87 kB).
- `dist/index.html` loads only the app entry and the shared `ErrorBoundary` chunk (281.09 kB,
  preloaded).
- Mermaid is reached only through the dynamic `import('mermaid')`, so none of it loads until a
  diagram is first drawn. Its chunks: `mermaid.core` 683.05 kB (gzip 169.08), `cytoscape.esm`
  443.04 kB, `katex` 261.31 kB, the `cynefin` diagram 687.91 kB, and one chunk per other diagram
  type.
- Vite's generic warning that some chunks exceed 500 kB covers the app entry and the lazy
  `mermaid.core` and `cynefin` chunks.

## Evidence for the Mermaid fencing

`client/console/mermaid-render.ts` points here. The references are to the installed Mermaid
11.17.2 `dist`, under `node_modules/mermaid/dist/chunks/mermaid.core/`.

- `mermaid.render` lays the diagram out in the app's document whatever the security level. It
  measures text there, then serialises the SVG.
- **Image shapes** load a URL during layout. At `chunk-4HAMMTFA.mjs:2742` Mermaid runs
  `new Image(); img.src = node.img; await img.decode()`; this covers flowchart
  `A@{ img: "https://…" }` and kanban images. The fencing refuses them before Mermaid sees
  them, including shape data that uses an escape.
- **Math** (`$$…$$`) forces HTML labels (`chunk-4HAMMTFA.mjs:5004`), and
  `calculateMathMLDimensions` (`chunk-DU6HZSFF.mjs:5214`) puts the sanitised HTML in the app's
  body, where DOMPurify keeps `<img src>`. The fencing refuses it.
- **HTML labels** in architecture diagrams (`:813`) and event modelling
  (`diagram-VSXAHHWV.mjs:607`), and `style`/`classDef` CSS `url()`, are closed three ways:
  - `htmlLabels: false`. The top-level value wins: `htmlLabels ?? flowchart.htmlLabels ?? true`
    (`chunk-DU6HZSFF.mjs:5005`).
  - An allowlist `dompurifyConfig` that keeps no `src`, `href` or `style` attributes.
  - A scan of `style`, `classDef` and `linkStyle` lines for `url(`, `image-set(`, `image(`,
    `cross-fade(`, `element(`, `@import` and CSS escapes.
- **Configuration from inside a diagram.** Mermaid's default `secure` list is `secure`,
  `securityLevel`, `startOnLoad`, `maxTextSize`, `suppressErrorRendering` and `maxEdges`. A
  directive could therefore set `htmlLabels`, `themeCSS` or `dompurifyConfig`. Frontmatter and
  `%%{…}%%` directives are stripped with Mermaid's own grammar (its `src/diagram-api/regexes.ts`),
  and `secure` is extended to the keys in `SECURE_KEYS`.
- The resulting SVG is shown only in a `sandbox=""` frame under the picture policy, so anything
  that got through is inert and can load nothing.
- Each render mounts an off-screen host that is hidden from assistive technology, and removes it
  afterwards. Renders run one at a time, because Mermaid's configuration is global.

## How the browser spec sees the network

- **Sandboxed frames can slip past `page.route`.** In this Edge (153.0.4234.48, driven by
  Playwright 1.63.0), a sandboxed srcdoc frame runs out of process. Its requests can pass
  `page.route`, `context.route` and the request events unreported. Probe:
  `scratchpad/probe-frame-requests.cjs`. In an early run, a policy-free control frame's `fetch`
  reached example.com while `page.route` reported nothing.
- **A recording proxy is the reliable observer.** The spec routes every browser context through
  a proxy (loopback bypassed) that records and refuses every tunnel and absolute-URL request.
  It keeps `page.route` as a second observer.
- **Edge's own service tunnels are excluded.** `www.bing.com` and `edge.microsoft.com` appear in
  every context. Only vendor domains (`bing.com`, `microsoft.com`, `msn.com`) on port 443 are
  attributed to the browser, and those are refused like the rest.
- **The first test is the control.** Frames with no policy are seen asking for
  `control-fetch.example.com`, `control-img.example.com` and `still.example.com`. So every
  "nothing" that follows is measured by an observer that demonstrably sees frames.
- **Frame contents are read through CDP.** No script can run in a `sandbox=""` frame, including
  Playwright's, so the spec reads the frame's DOM with `DOM.getDocument({ depth: -1, pierce:
  true })`.
- After every test: no external request, no tunnel since the test began, no dialog, no page
  error.

**Mutation checks** (a policy or rule loosened on purpose, then restored and checked by hash):
- Picture policy loosened to `default-src *`: the hostile-picture test fails, naming
  `https://example.com/x.png` and `https://example.com/mask.png`
  (`scratchpad/logs/artifacts-mutation-2.log`). `artifact-frame.ts` was restored; its sha256
  `d940641e…` matches the original.
- The chart `.seg` rule removed from `artifacts.css`: the segments test fails on the first
  segment's width, "Expected: > 85.2, Received: 2", so each segment was only its 1 px border on
  either side (`scratchpad/logs/artifacts-segments-mutation-2.log`; screenshot
  `mutation-segments-without-rule.png`). `artifacts.css` was restored; its sha256 `89fd2604…`
  matches the original.

## Gates

All counts come from this worktree's own runs. The logs are under
`F:/Temp/andre/claude/F--Diomedes/93688541-df31-40fc-b4a9-a50c06acda85/scratchpad/logs/`.

| Gate | Command | Result | Log |
| --- | --- | --- | --- |
| Types | `npx tsc --noEmit` | exit 0 (56.8 s); run again after the last TypeScript edit: exit 0 | `tsc-final.log`, `tsc-final-2.log` |
| Unit, full run 1 | `npx vitest run` | files 258 passed, 1 failed (259); tests 4778 passed, 1 failed, 4 skipped (4783); 134.6 s | `vitest-full-1.log` |
| Run 1's failure, alone | `npx vitest run tests/scoped-work.test.ts` | 30 of 30 passed (14.35 s) | `vitest-scoped-work-alone.log` |
| Unit, full run 2 | `npx vitest run` (adds `artifact-save.test.ts`) | files 259 passed, 1 failed (260); tests 4785 passed, 1 failed, 4 skipped (4790); 212.4 s. This lane's 7 files: 95 of 95; `segment-bar.test.ts`: 9 of 9 | `vitest-full-2.log` |
| Run 2's failure, alone | `npx vitest run tests/backend.test.ts` | 48 of 48 passed (38.68 s) | `vitest-backend-alone.log` |
| Build | `npx vite build` (the gate command's first half) | 2369 modules, 13.67 s | `playwright-full-1.log` |
| Browser, full suite | `python …/with_heavy_slot.py ARTIFACTS playwright F:/Diomedes/diomedes-wt/model-artifacts -- cmd /c "npx vite build && npx playwright test"`, with the two port variables below | **188 passed (5.7 min), exit 0**; slot granted 01:32:00 and released | `playwright-full-1.log` |
| Browser, this lane's spec | within the full suite | 12 of 12 passed | `playwright-full-1.log` |
| Evidence files | `git restore -- evidence/`, plus `git restore -- docs/verification/2026-09-17-design-center/` | The suite had rewritten 31 PNGs under `evidence/` and 9 under the design-center folder (`design-studio-ui.spec.ts` writes there). Both sets were restored; the tree holds only this patch. | |

After run 2 began, the browser spec, its fixture and `artifacts.css` changed. No Vitest test reads
any of them (checked), and the type check ran again after the last TypeScript edit.

**Vitest flakes under contention.** Other lanes were running on this machine throughout; the
skin lane's own browser suite held the heavy slot just before this one's. Each full run had one
timeout, in a different server-side file each time, and each file passed alone:
- Run 1: `tests/scoped-work.test.ts` timed out at 30 s ("one confirmation permits twenty
  journaled edits…"). Alone: 30/30 in 14.35 s, with that test taking 3.6 s.
- Run 2: `tests/backend.test.ts` timed out at 120 s ("(a) projectState returns quickly with a
  large folder"). Alone: 48/48 in 38.68 s, with that test taking 17.7 s.

Neither file touches client code.

**Ports.** At 01:24, the suite's default ports 5174 and 47632 were held by the
`nectovia-routing` worktree's Vite and service processes. The dev-server guard refused to start,
as designed. Browser runs from then on set `DIOMEDES_UI_CLIENT_PORT=5184` and
`DIOMEDES_UI_SERVICE_PORT=47642`, which `playwright.config.ts` reads. The webServer passes both
ports to Vite's proxy, so no request reached the other lane's service, and nothing of that lane
was touched.

## Known gaps

1. **History merges close saves.** A save over a file joins the latest History entry when that
   entry is the same person's edit of the same file and less than ten minutes old
   (`server/store.ts:1197-1213`; `/documents/write` passes no `merge` option,
   `server/app.ts:1500-1515`). The first save's creation entry qualifies, so a version saved
   within ten minutes of the previous save shares its entry. Every version stays in the
   conversation. v2: `merge: false` for artifact saves.
2. **A design can navigate its own frame in a browser.** In a browser (development server,
   Playwright), nothing stops that navigation, and its request is made. The panel takes the
   frame down when the second document loads. In the desktop shell, `will-frame-navigate`
   refuses the navigation before any request. The spec's wandering design navigates to
   `about:blank`, so it proves the take-down, not the refusal.
3. **The desktop guard has no automated test.** `node_modules/electron/dist` is absent, and
   `desktop/main.mjs` itself is not unit-tested in this repository (its helpers are). A pure
   `frameNavigationAllowed(details)` helper beside the others in `desktop/` would make the
   guard testable. That would be a second hot-file change, so it is left to the integrator.
4. **Mermaid frontmatter titles are dropped.** A `title:` in frontmatter is stripped with the
   rest of the frontmatter. The panel's title comes from the declaration or the nearby heading.
5. **The thread list preview shows raw Markdown.** Its preview line shows an answer's Markdown,
   fences included (`Shell.tsx:1163-1168`, hot, not changed).
6. **The thread column is narrow with everything open.** At 1440 px, with the ledger and a
   480 px panel, the Console's thread column is about 390 px. The ledger is kept, as it is when
   Files is open.
7. **The Diomedes page does not stream.** Artifacts appear there only whole, when the answer
   lands. The preview gate is proved in the Console.
8. **Save is not offered on the All projects conversation.** By design: there is no folder. The
   button stays reachable (`aria-disabled`) and says why.

## Deviations from the work order, and why

1. **The Diomedes page panel sits beside the conversation.** The work order asked for an
   overlay column. As an overlay, the panel covered the composer's Send button. Above 860 px the
   page now makes room: the stage gets right padding equal to the panel width, the ledger moves
   under the conversation, and a browser test checks that the composer and Send end before the
   panel begins. At 860 px and below, the panel covers the page as Files does.
2. **The picture policy names no `script-src`.** Diagrams and images get
   `default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;
   media-src data: blob:`. Designs get the work order's policy exactly.
3. **Mermaid refuses math, image shapes and fetching style lines** with a sentence, because
   Mermaid lays them out in the app's own document (evidence above). Drawing them waits for an
   off-origin render frame (v2).
4. **The browser spec adds a recording proxy** to `page.route`, because sandboxed frames run out
   of process here.
5. **The browser spec uses its own scripted engine.** It is `tests/fixtures/scripted-artifacts.ts`
   on the Claude Code route, because the Console's `/ask` refuses model-API routes (409), so the
   Luna transport cannot drive a Console thread. The Diomedes page test does use the Luna
   transport, at its provider boundary, with no network.
6. **The chart `.seg` rule lives in `artifacts.css`,** not in the integrator's
   `segment-bar.css`, as described above.

## Evidence (screenshots)

The screenshots are in
`F:/Temp/andre/claude/F--Diomedes/93688541-df31-40fc-b4a9-a50c06acda85/scratchpad/evidence/artifacts/`.
The `final-` files come from the green gate run, at 1440 × 900:
- `final-diagram-in-panel.png`: a Mermaid diagram in the Console panel, drawn in its frame.
- `final-version-stepper.png`: the second version of a declared diagram, "v2 of 2".
- `final-saved-in-files.png`: the saved file in Files, with the Files | Artifact switch.
- `final-chart-with-data.png`: a two-series bar chart with its data table open.
- `final-segments-chart.png`: a segments chart, "2 of 5 steps done". The thread list's raw
  Markdown preview (known gap 5) is visible here too.
- `final-table-charted.png`: a table in the turn, and "Chart this" in the panel.
- `final-hostile-design.png`: the hostile design, contained, at the Desktop width.
- `final-hostile-picture.png`: the hostile SVG, drawn inert.
- `final-hostile-labels.png`: hostile Mermaid labels, drawn as text.
- `final-live-preview-held.png`: "Drawing a diagram…" while the answer streams.
- `final-home-panel.png`: the Diomedes page with the panel beside the conversation, and Save
  explaining why it cannot save there.

Two more:
- `mutation-segments-without-rule.png` is the failing mutation run: 2 px segments.
- The `run1-`, `run8-`, `run9-` and `run10-` files are earlier runs, superseded by the `final-`
  set. `run8-home-overlay.png` shows the overlay that covered Send.
