# Model artifacts: diagrams, charts, tables and designs in a conversation

**Decision record for v1, and the v2 decisions it needs.** Version 2026-09-22.1. Written by the
model-artifacts lane (Opus 5.5) from the ARTIFACTS work order and the read-only research report
("Model artifacts research report", 2026-09-22, mapped at `c10b7b2`). The report is the
integrator's working copy and is not in this repository. Its file:line references are to this
repository at that commit.

**Status: v1 is built in `feature/model-artifacts` (worktree
`F:/Diomedes/diomedes-wt/model-artifacts`, base `c10b7b2`). It is uncommitted, not merged and not
released.** What shipped, the gates and their counts:
`docs/implementation/2026-09-22-model-artifacts.md`.

**Superseded in part, 2026-09-23 (visual convergence).** The ` ```chart ` fence retires with its
spec (section 3a), `chart-spec.ts` and `Chart.tsx`. A saved ` ```chart ` fence now reads as an
ordinary code block. A chart is the ` ```visual ` fence the model is taught
(`shared/visual-spec.ts`). `InlineVisual.tsx` draws it in the turn, and "Open in panel" shows it in
this panel as the kind Visual. "Chart this" builds a visual spec from the table. The panel's
progress and segments charts are gone: a reply's own progress is a share in its own words, never
counted segments (contract A15). Files offers "Open in panel" for a saved visual's `.json` too.
Record: `docs/product/2026-09-23-visual-convergence.md`.

---

## 1. What a person gets

- **An answer reads as it was written.** Paragraphs, headings, lists, inline code, bold, fenced
  code with its own Copy, and GFM tables render in the Console thread and on the Diomedes page. A
  plain answer still renders as paragraphs, directly in the turn's body, as before.
- **What the panel can draw becomes a chip.** A `mermaid` fence is a Diagram, `chart` a Chart,
  `svg` (or `xml` whose root is `<svg>`) an Image, `html` a Design, `markdown` or `md` a Document. A
  GFM table with a header and two or more rows stays readable in the turn and gets a Table chip
  under it. The chip is a small plate with a lit cut edge. It shows the kind and title, the
  version once there is more than one, and "Open" (or "In panel" while it is showing).
- **The panel.** In the Console it is the stage's third column, the one Files uses. The one
  host has two views, and each keeps its place while the other is in front. Which view was in
  front is remembered (`console.pane.view`). The panel's head holds the kind, the title, a
  version stepper ("v2 of 3"), Rendered or Source, Copy source, Save to Files and Close. Esc closes
  the panel while focus is inside it. Opening it moves focus to the title, and closing it returns
  focus to the chip. It is 480 px unless moved, 320 px at least, and never wider than 960 px or
  60% of the window. Its width is remembered (`console.artifacts.width`, like `console.files.*`).
  Wider than 860 px, the Diomedes page places the panel beside the conversation. At 860 px and
  below it covers the page, as the Files pane does.
- **Versions.** A later answer that declares the same id is the next version of the same
  artifact. If the panel is showing this conversation's artifact when a later answer brings a new
  one, it switches to the newest and says so ("New diagram: Delivery check, version 2 of 2.").
- **Charts** are drawn by the app from a small frozen spec (section 3a). The app draws bar,
  line, area and donut charts as SVG. For progress and segments it uses the Console's own segment
  bar. Every chart has a plain-words summary as its name and its numbers one button away ("Show
  data"). "Chart this" draws any number column of a table.
- **Save to Files** happens only when a person presses it, and saves into `Saved artifacts/`. A
  later version is saved over the same file, based on the version it read, so there is never a file
  per version. History records these saves the way it records a person's own edits: saves to one
  file less than ten minutes apart share one entry (section 5). Every version stays in the
  conversation. Files offers "Open in panel" for a `.md` or `.html` file that holds artifact
  blocks.

## 2. What the research found, and what it decided

Numbers in brackets are the report's sections.

1. **The Console rendered no Markdown at all.** Assistant turns split on blank lines into plain
   `<p>` (`client/console/ThreadView.tsx:45-50`). No Markdown, sanitiser, highlighter, Mermaid or
   charting library was installed [headline, 1, 6]. v1 therefore brings its own small parser that
   emits React text nodes only. It adds one dependency, Mermaid, which loads on first use.
2. **Text is the only channel on every route.** Claude Code runs with no tools and Codex with no
   dynamic tools. Only the Bedrock turn has a live tool registry [4]. v1 detects artifacts in the
   durable answer text, on the client. Nothing on the server changes.
3. **Instruction text is bound by digest.** Claude native sessions refuse a mismatch with
   `SESSION_MISMATCH` (`server/engines/claude-session.ts:97,130-138,208-218`), and the Bedrock
   adapter binds the same digest (`server/harness/aws-model-adapter.ts:77-78,116`) [4]. v1 changes
   no instruction, so no model is told the format yet (decision (a) below). Artifacts appear when a
   model writes these fences on its own, which models already do for diagrams and tables.
4. **The precedent is the decision block.** It pairs a format constant with its parser, a pure
   splitter and a streaming gate that hides the fence while it arrives (`server/interaction-turn.ts`)
   [headline]. v1's parser is pure, and its preview gate follows the same rule.
5. **Live text exists on some routes and not others.** It streams on `/ask` for external engines,
   in Claude native sessions and in the Diomedes conversation when it runs on Claude. It does not
   stream on Codex or Bedrock, and the Diomedes page does not listen for live text at all [7]. The
   rule adopted: an artifact renders only from the durable turn. While text streams, an artifact
   fence is held back from its opening line behind a one-line placeholder.
6. **The Files model has two traps.** `.svg`, `.mmd` and `.mermaid` are "unsupported" text kinds
   (`server/paths.ts:183-190`), and the listing skips any folder named `artifacts`
   (`server/store.ts:1018-1019`) [5]. Saves therefore go to `Saved artifacts/`, which is listed.
   A save is a `.md` file holding the fence, or a Design's `.html`. Versions live in History rather
   than as one file per version.
7. **Nothing stopped a frame from reaching the app.** No CSP and no iframe existed anywhere. A
   frame's CORS-mode requests carry `Origin: null` and are refused (403,
   `server/app.ts:757-758`), but a plain GET such as an image carries no Origin. The first
   `GET /documents/read` of a file writes an "observed" History entry
   (`server/store.ts:1104-1120`) [3]. So everything a frame shows is inline in its srcdoc, its
   policy is `default-src 'none'`, and the desktop shell refuses any subframe navigation.
8. **The stage already has a third column,** the Files pane at 240-640 px [2]. v1 reuses it. The
   artifact view keeps its own width, up to 960 px or 60% of the window, because 640 px is narrow
   for a diagram.
9. **Every change sends the whole project state** over the event stream, so a larger `Turn.text`
   costs every broadcast [7]. v1 stores nothing new on the server: artifacts are derived from
   text a person already has.

## 3. The v1 decisions

1. **Detection is client-side and derived.** `client/console/turn-blocks.ts` parses a turn into
   blocks, and `client/console/artifacts.ts` indexes a conversation's artifacts. Nothing is stored.
2. **Identity is a digest** of the conversation, the turn and the block index (`artifactKey`:
   `art-` followed by 11 base-36 characters). A **declared id** makes versions:
   - `%% artifact: id=… title="…"` as a Mermaid fence's first line;
   - `<!-- artifact: id=… title="…" -->` as an SVG, HTML or Markdown fence's first line;
   - `id` and `title` in a chart's JSON.

   An id starts with a letter or digit, continues with letters, digits, `.`, `_` or `-`, and is 64
   characters at most. The same id later in the conversation is version n+1.
3. **The title** is the declared title. Failing that, it is the nearest heading or bold line above
   the block in its own turn (never across another artifact). Failing both, it is the kind and a
   count ("Diagram 2").
4. **Charts follow the frozen spec in section 3a.** A chart outside the spec is refused with a
   sentence naming the problem, shown in an error card beside the source. Series take the seam's
   cyan, then violet, then coral, then the scheme's greys. Lines from the fourth series on are
   dashed. Numerals are tabular. `segments` and `progress` are drawn with the Console's SegmentBar
   exactly as the record gives them. By the SegmentBar honesty rule, N and k come only from what
   the chart says.
5. **Pictures and designs are only ever shown in frames** (section 4).
6. **Saving is a person's act.** `Save to Files` creates `Saved artifacts/<title>.md` (a Design:
   `.html`) through `POST /documents/create`, which is a new History entry. The saved text
   carries the artifact's declaration line, so a later save can recognise its own file. A later
   version of the same declared artifact is written over that file through `POST /documents/write`
   with the hash it read. If a different file already has the name, the save moves to the next
   numbered name (`Delivery check 2.md`). Saving the same text again says "Already saved as …".
   The Diomedes page's All projects conversation has no folder to save into, and says so when Save
   is pressed.
7. **Out of v1, as the work order set:**
   - no change to any instruction, mode text, prompt, lineage or digest;
   - no new run event type;
   - no change to `shared/harness.ts`, the adapter contract or the `Turn` type;
   - no server-side artifact storage;
   - no CSP for the whole app (superseded 2026-09-23: the built app document now carries one,
     `docs/product/2026-09-23-artifact-hardening.md` section 4);
   - no automatic writes.

## 3a. The chart spec (frozen for v1)

A ` ```chart ` fence holds one JSON object. The v2 model instruction (decision (a)) would teach
exactly this. `client/console/chart-spec.ts` enforces it.

| Field | Types | Rule |
| --- | --- | --- |
| `type` | all | `bar`, `line`, `area`, `donut`, `progress` or `segments` |
| `id` | all, optional | the declared-id rule above; makes versions |
| `title` | all, optional | text, 120 characters at most |
| `unit` | all, optional | text, 16 at most; `$`, `€`, `£` or `¥` is written before the number |
| `caption` | all, optional | text, 280 at most |
| `x` | bar, line, area | 1 to 100 category labels, 60 characters each at most |
| `series` | bar, line, area | 1 to 6 of `{ "name", "values" }`, one finite number per label |
| `slices` | donut | 1 to 8 of `{ "label", "value" }`, no negative value, a total above 0 |
| `steps` | segments | 1 to 50 of `{ "label", "state" }`; state is `done`, `active`, `pending`, `failed` or `blocked` |
| `done`, `total`, `label` | progress | `total` a whole number from 1 to 1000, `done` from 0 to `total`; `label` names what is counted |

A field another chart type uses is refused by name ("`slices` is only used by donut charts, not by
a bar chart."), as are unknown fields, a wrong count of values, and any number that is not
finite.

## 4. Security model

> **Superseded in part on 2026-09-23** by the hostile review's findings
> (`docs/product/2026-09-23-artifact-hardening.md`): a design no longer runs script (every frame is
> `sandbox=""` under one policy that names no script source), links are taken out of design and
> picture sources before a frame is built, the Mermaid style check reads `;` as a statement end and
> what Mermaid draws is scanned for `url()`, and the built app document has a
> Content-Security-Policy. The table and paragraphs below are v1 as first built.

**The app's own document never parses model markup.** Turns render with React text nodes only
(no `dangerouslySetInnerHTML`), so a tag in an answer reads as the characters it is. Charts and
tables are React elements built from validated data.

**Diagrams, images and designs render only inside srcdoc frames** built by
`client/console/artifact-frame.ts`. Every srcdoc starts with its policy, before a single byte of
the artifact, so a later policy can only narrow it. Next come `x-dns-prefetch-control: off` and a
`no-referrer` referrer policy. Every frame also carries `referrerpolicy="no-referrer"`.

| Frame | sandbox | Policy |
| --- | --- | --- |
| Diagram, Image, Design | `""` (no script, opaque origin) | `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:` |

(Updated 2026-09-23. v1 gave designs `allow-scripts` and a policy with `script-src 'unsafe-inline'`,
and every frame's policy allowed `blob:`. The hardening pass removed both: a design with
`allow-scripts` could reach the network over WebRTC, which no CSP governs. The frame policy is
`FRAME_CSP` and `FRAME_SANDBOX` in `client/console/artifact-frame.ts`. A srcdoc frame also inherits
the app document's policy, `APP_CSP` in `shared/app-csp.ts`, which `scripts/app-csp.ts` writes into
the built page.)

No frame ever carries `allow-same-origin`, `allow-top-navigation`, `allow-popups`, `allow-forms`
or `allow-modals` (`FORBIDDEN_SANDBOX` lists all twelve refused tokens). The picture policy has no
`script-src` at all, because a frame that runs no script should name none. That is stricter than
the work order's single policy, on purpose.

**A sandbox does not stop a frame from navigating itself.** The desktop shell refuses every
subframe navigation except to `about:srcdoc`, `about:blank` or within the same document
(`will-frame-navigate`, `desktop/main.mjs:244`). In a browser (the development server), a design
frame that loads a second time is taken down with "This design tried to open another page, so it
was stopped." and a "Load it again" button.

**Mermaid lays diagrams out in the app's document** whatever its security level, because it
measures text there. What reaches it is fenced first (`client/console/mermaid-render.ts`):

- It loads on first use as a separate chunk, with `securityLevel: 'strict'`,
  `startOnLoad: false`, `htmlLabels: false` and `suppressErrorRendering: true`.
- Frontmatter and `%%{…}%%` directives are removed with Mermaid's own patterns. `secure` is
  extended so nothing in a diagram can change `htmlLabels`, `dompurifyConfig`, `themeCSS`, the
  security level or the theme.
- Labels pass DOMPurify with an allowlist of formatting tags only, and `class` is the only
  attribute kept.
- Mermaid would load files while laying out three things, so they are refused with a sentence
  rather than drawn:
  - `$$` math. It forces HTML labels (`chunk-4HAMMTFA.mjs:5004`) and puts the sanitised HTML in
    the page (`chunk-DU6HZSFF.mjs:5214`).
  - Image shapes. Mermaid calls `new Image()` with the diagram's URL (`chunk-4HAMMTFA.mjs:2742`).
  - `style`, `classDef` or `linkStyle` lines that carry `url()`, `image-set()`, `@import` or a CSS
    escape.

  The chunk references are to Mermaid 11.17.2's `dist`.
- The SVG Mermaid returns is shown only inside a `sandbox=""` frame with the picture policy.

**Saving changes no Trust rule.** It uses the same document routes as a person's own editor,
and only a press starts it.

**Proof.** Vitest pins:
- the parser, identity and versions;
- every chart-spec refusal and the chart renderer;
- the srcdoc builder: policy first for every kind, and no frame ever `allow-same-origin`;
- the Mermaid fencing.

The browser spec `tests/artifacts-ui.spec.ts` drives the built Console with a scripted model. In
this Chromium a sandboxed frame runs in its own process, and its requests can get past
`page.route` unseen. So the spec runs every browser context through a recording proxy that
refuses every tunnel. Its first test is the control: frames with no policy are seen asking for
files. After that, a hostile design, a hostile SVG and hostile Mermaid labels reach nothing and
run nothing where they must not, and the page keeps working. Loosening the picture policy makes
the hostile-picture test fail by name.

## 5. v2: the decisions it needs from Andrew

**(a) Tell the models the format.** Add an `ARTIFACT_FORMAT` instruction beside its parser (the
`DECISION_FORMAT` precedent, `server/interaction-turn.ts:75-99`). It would reach Ask, Plan and
Automatic on every route (not Build or Fix, whose strict JSON proposals conflict with fences).
Artifacts would then arrive on purpose, with ids and titles, instead of by habit. **This is
blocked on a lineage migration.** Instruction text is bound by digest. A running Claude session
refuses a changed one (`SESSION_MISMATCH`, `server/engines/claude-session.ts:97,130-138,208-218`),
and so does the Bedrock profile digest (`server/harness/aws-model-adapter.ts:77-78,116`). The
options:

1. *Version the instructions for new lineages only.* A lineage keeps the text it started with until
   it retires, and new conversations get the format. Nothing breaks, but existing threads never
   learn it. It needs two things. First, confirm whether a digest mismatch retires a lineage
   automatically (the research found this unknown; `shared/types.ts:436-438` has `scope-change`).
   Second, show a visible note when a thread moves on.
2. *Retire every open lineage once.* On the first turn after release, a thread starts a new lineage
   on the new text. The transcript (or a summary) carries over, and the reason is recorded. Every
   thread learns the format, but each pays one context rebuild and loses the provider's cache.
3. *Carry it per turn, not in the bound text.* Add a short note beside the
   `[[diomedes source_message_id=…]]` trailer. No lineage changes, but every turn's prompt and
   binding digest do. A user-turn instruction is also weaker than a system one. This option needs a
   Trust read.
4. *Stay detection-only.* v1 as built.

The lane recommends option 1, with option 2 offered per thread ("use the new answer format")
where a person wants it now. Accepting it is Andrew's call.

**(b) A `show_artifact` tool on the Bedrock turn.** It would be a pure local tool in the per-turn
registry. Bedrock is the only route with live tools (`server/harness/model-session-run.ts:49-61`,
registry `:525-548`), and it allows at most 16 tools and one call per step
(`server/engines/aws-bedrock.ts:496-516`). To decide:
- its schema: kind, id, title, source, and a chart as structured JSON;
- whether the tool call or the answer text is the source of truth when both exist;
- what one call costs of the step budget;
- how it shows in run evidence (a `tool:<i>` step, `server/harness/native-agent.ts:355-377`).

**(c) Artifacts as recorded steps.** Persist each artifact as a pure `transform` step on its run
instead of re-deriving it from text. This follows the conversation-phase pattern
(`server/harness/model-session-run.ts:106-116`, `server/harness/claude-session-run.ts:90-104`).
The artifact then becomes evidence with its run. It can be reviewed, History can point at it, and
it stays stable if the answer text is ever re-projected. To decide: is an artifact evidence or a
view? A new step or event kind would be a contract revision, because `RUN_EVENT_TYPES` is closed
(`shared/adapter-contract.ts:102-125`).

**(d) Live progress boards.** A segments board bound to a running run's steps, redrawn as they
settle. To decide:
- which records count as steps: plan steps, child runs or declared step lists (the SegmentBar
  honesty rule allows nothing else);
- whether the board lives in the panel or the ledger.

**(e) `.svg` and `.mmd` as readable kinds** in `server/paths.ts` `textKind`. This is a Trust and
owner call. Files would then read these files (it refuses today, `client/console/FilesPane.tsx:286,358-363`),
and proposals could write them (refused today, `server/native-work.ts:205-206`,
`server/trust/scope-grants.ts:441-442`). v1 saves a Markdown file holding the fence instead,
which Files already reads.

**Engineering items for v2 that need no decision:**

- Lay Mermaid out off the app's origin, in a render frame with no network, so math and image
  shapes can be drawn rather than refused.
- Give `/documents/write` a `merge: false` option for artifact saves. The store already has one
  (`merge?: boolean`, which `/documents/create` passes), but the write route passes nothing
  (`server/app.ts:1500-1515`). Today a write joins the latest History entry when that entry is the
  same person's edit of the same file and less than ten minutes old
  (`server/store.ts:1197-1213`). A save's creation entry qualifies, so a version saved within ten
  minutes of the previous save joins that save's entry. History then keeps only the newer text.
  The conversation still holds every version.
- Add a CSP for the whole app, `frame-src` included. It must differ between development and
  build, because `@vitejs/plugin-react` injects an inline module preamble in development [3].
- The thread list's preview line shows an answer's raw Markdown, fences included
  (`client/console/Shell.tsx:1163-1168`, an integrator file).
- Live text on the Diomedes page. The page shows "Working" and reads the answer once it lands
  [7], so artifacts appear there only whole. The preview gate is ready for the page when it
  listens. It is proved in the Console today.
