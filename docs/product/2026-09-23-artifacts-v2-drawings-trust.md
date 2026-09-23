# Artifacts v2, lane 3: drawings in Files, and the Trust checks on them

**Decision record.** Version 2026-09-23.0. Artifacts panel v2 was approved by Andrew on 2026-09-23 and
targets 0.1.9. This lane carries frozen decision 7 (`.svg` and `.mmd` drawings) and the Trust checks
for it. The lane brief and `ARTIFACTS_V2_FROZEN.md` override the contract draft wherever they differ.

**Status: complete on `feature/artifacts-drawings-trust`.**
- Worktree `F:/Diomedes/diomedes-wt/artifacts-drawings-trust`, base `a298382` (lane 1's commit). The
  lane's work is commit `250f570`.
- `origin/main` at `8f73322` is merged in at `02d7c84`, with no conflicts. It carries lane 4 (#46) and
  the lineage lane (#45).
- Gates passed under the heavy slot, both before and after that merge. After it:
  - tsc;
  - the full vitest suite, 5900 passed;
  - the build;
  - the full Playwright suite, 210 passed.
- Not merged to main, not pushed, not released.

**Trust owner.** AGENTS.md says to coordinate Trust interfaces with their owner, and points to
`F:\Diomedes\planning\DIOMEDES-RUNTIME-OWNERSHIP-2026-09-09.md`. Its Trust response,
`DIOMEDES-TRUST-OWNERSHIP-2026-09-09.md`, names **Opus** as the owner of `server/trust/*`.
`shared/types.ts`, `server/native-work.ts` and `server/store.ts` are shared hot files that **Fable**
integrates (AGENTS.md). This lane both widens and narrows the boundary:
- proposals may now write `.svg` and `.mmd` (Andrew's frozen decision 7);
- every `.svg` must pass svg-check and the person's exact review;
- grants no longer cover `.html` or `.xml`.

The draft flagged the widening for the owner. Per the brief, the owner is named here and was not
blocked on. The owner is asked to review:
- the allowlist;
- the grant rule in `scope-grants.ts`;
- "Stricter than asked";
- the open items at the end.

## What changed

- **`'drawing'`, a new `DocumentInfo.kind`** (`shared/types.ts`) for `.svg` and `.mmd`
  (`server/paths.ts` `textKind`).
  - It stays out of `TEXT_EXTENSIONS`. So automatic task-source selection
    (`shared/task-sources.ts`, markdown and text only) never sends one to a model.
  - `mayNameDocument` never looks for one either.
- **Every site that tested a document's kind only against `'unsupported'`.** A grep of `server/`,
  `shared/` and `client/` at the base finds five on the server and three in the client.
  - Server:
    - `native-work.ts` `parseProposal` (`:245`): a drawing may be proposed. Its shape is checked
      there, as before.
    - `native-work.ts` proposal sources (`:467`): a drawing the person selects is a source.
      - This reverses the draft's refusal, and the comment there says so.
      - Cloud sharing still gates each selected document.
    - `scope-grants.ts` `check()` (`:448`): a drawing passes the kind test. An `.svg` is then
      stopped (see below).
    - `store.ts` snapshot (`:1626`) and whole-folder restore (`:1683`). This file is not this lane's
      and is unchanged.
      - Saved versions now keep drawings, and a whole-folder restore treats a later drawing as it
        treats a later text file.
      - Before, both skipped drawings as "Unsupported file type".
      - The saved-version half is pinned by a test.
  - Client:
    - `FilesPane.tsx` `readable` (`:307`): drawings are read, which replaces the read refusal.
    - `DocumentEditor.tsx` `supported` (`:164`), not this lane's file: the editor opens a drawing as
      source text in its textarea and renders nothing.
    - `paletteEntries.ts` (`:278`) needed no change. It prints the kind, so it now shows "drawing,
      project folder" instead of "not text". Pinned by a test.
- **Files previews drawings** (`client/console/FilesPane.tsx`), the way the artifact panel does:
  - An `.svg` goes into the image frame.
  - An `.mmd` goes through the Mermaid pipeline into the diagram frame.
  - Each is a `sandbox=""` iframe with the frame policy. FilesPane calls lane 4's `ArtifactFrame` with
    the record from `indexFile`. The drawing's markup never enters the app's document.
  - Rendered is the default; Raw shows the source.
  - One `files.css` rule sets the frame in the pane's gutter.
- **svg-check** (`shared/svg-check.ts`, new) provides:
  - `svgProblem(text): string | null`;
  - `svgCheckApplies(path, text)`;
  - the version and the verdict sentence.
- **Exact review for `.svg`, `.html` and `.xml` proposals**: `server/paths.ts` `exactReviewOnly` and
  `server/trust/scope-grants.ts`.
- **The verdict on the Need**: `Need.checks?: NeedCheck[]` (`shared/types.ts`), shown by
  `ApprovalStatus` (`client/components.tsx`).

## svg-check v1

svg-check has two parts:
- a strict tokenizer for a subset of XML that two parsers read the same way:
  - an XML parser, which reads the `.svg` when it is opened in a browser;
  - an HTML parser, which reads the same markup inlined into a page, as the frame shows it;
- an allowlist over what the tokenizer reads.

When it refuses, the reason names the element, attribute or CSS feature and the line, and never
repeats a value. It never rewrites anything.

It adds no dependency. The only XML parser in `node_modules` is transitive, so none is imported.

**The tokenizer refuses anything it cannot fully read, and every construct where the two parsers
differ:**
- Declarations and instructions:
  - any `<!DOCTYPE`, `<!ENTITY` or other `<!` declaration;
  - any CDATA section;
  - any processing instruction other than a leading XML declaration, which must be exactly
    version 1.0, UTF-8. A `>` inside a looser declaration ends it early for HTML.
- Comments:
  - whose body starts with `>` or `->` (HTML closes `<!-->` and `<!--->` at once);
  - that hold `--` (HTML also closes at `--!>`);
  - that end in `-`.
- Attributes:
  - unquoted or valueless attributes;
  - attributes with no space between them (`<svg/onload=`);
  - repeated attributes, compared without case;
  - a `<` in a value.
- `]]>` in text.
- Character references: any `&` that is not `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;` or a numeric
  reference ending in `;`. HTML decodes `&colon;`, `&lpar;` and `&#106` without its semicolon; XML
  refuses them.
- Control characters, lone surrogates and bidirectional overrides, whether raw or as references.
  Bidirectional overrides can make the reviewed hunk read differently from the file.
- Any child element or comment inside `title`, `desc` or `style`. `title` and `desc` are HTML
  integration points, where `<img onerror>` would be HTML.
- Structure:
  - a root other than `svg`;
  - markup or text outside the root;
  - end tags that do not match exactly;
  - nesting deeper than 128.
- A file over 1 MB. Proposals are already capped at 128 KB; this cap bounds any other caller.

**Names compare without case**, because an HTML parser lowercases them. So `<SCRIPT>`, `OnClick` and
`XLINK:HREF` are read as a browser would read them.

**Character references are decoded before any value is checked.**

**Elements.** Only these are allowed; anything else is refused:
- `svg`, `g`, `defs`, `symbol`, `title`, `desc`, `style`;
- `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text`, `tspan`;
- `linearGradient`, `radialGradient`, `stop`, `pattern`, `clipPath`, `mask`, `marker`;
- `filter`, `feDropShadow`.

That is the draft's list plus `style`, `filter` and `feDropShadow`, which the Console's own Mermaid
output needs.

Among the rest, these are refused by name:
- `script`, `foreignObject`, `a`, `image`, `use`, `iframe`, `embed`, `object`;
- every `animate*` and `set`, because they can rewrite `href`;
- `feImage` and every other filter primitive;
- `textPath`, `metadata`, `switch`.

**Attributes.** Only these are allowed; anything else is refused:
- identity and accessibility: `id`, `class`, `style`, `name`, `role`, `lang`, `xml:lang`,
  `xml:space`, `type`, and five `aria-*` names;
- Mermaid 11.17.2's eleven `data-*` names, allowed by name. Other `data-*` names are what page
  scripts read as code (`data-bind`, `data-hx-*`).
- `xmlns`, which must be the SVG namespace;
- `xmlns:xlink`, which must be the XLink namespace. Any other `xmlns:*` is refused, so no prefix can
  be rebound to XLink or XHTML.
- `href` and `xlink:href`, which must be a `#fragment` in the file. An `xlink:` attribute also needs
  its declaration in scope.
- the viewport, geometry, text-layout, paint-server, clip, mask, marker and filter attributes;
- the SVG presentation attributes, except `cursor` (it loads a file) and `color-profile`.

Refused with their own reasons:
- every `on*` attribute;
- `xml:base`, which would make a `#fragment` external;
- every other prefix.

**Values**:
- `javascript:` and `vbscript:` are refused anywhere: in attribute values, text, comments and CSS.
  The check runs after references are decoded and after removing the controls and spaces a URL
  parser drops.
- Any attribute that holds `url(` is refused, except the CSS-valued ones below.
- `data:` is not refused as text. Every place that can load a URL (`href`, `xlink:href`, `url()`)
  accepts only a `#fragment`, so a `data:` URL has nowhere to load.

**CSS**:
- **Where it is checked:** `<style>` text, and the values of `style`, `fill`, `stroke`, `clip-path`,
  `mask`, `filter` and `marker*`.
- **How:** a token scanner ported from `withoutFetchingUrls` in `mermaid-render.ts`, and made
  stricter. The two copies are deliberate: `shared/` cannot import `client/`, and this one refuses
  where that one rewrites.
- **Refused:**
  - any backslash, so no name can be spelled with an escape (`\75 rl(`) that the scanner would not
    see;
  - any `<`, after decoding.
- **`url()`** may name only a `#fragment`, quoted or not.
- **At-rules:** `@keyframes` only; the fixtures use it. `@import`, `@font-face`, `@media` and every
  other at-rule are refused.
- **Functions:**
  - allowed: `rgb`, `rgba` and `drop-shadow`, which the fixtures use, and `hsl` and `hsla`, the
    other plain colour notations (allowed in advance of any fixture);
  - refused by name: every other function, including `image-set`, `expression`, `var`, `calc`,
    `src` and the transform functions.
- **Not restricted:** properties and selectors. Without a fetching function or at-rule, none of
  them can reach outside the file.

**Which files it reads** (`svgCheckApplies`):
- every `.svg`;
- every `.xml` that is SVG, which see "Stricter than asked".

### Stricter than asked

Each of these is deliberate. The Trust owner should confirm or loosen them.

- **`.xml` detection goes past `svgRoot`.** The brief says to use `svgRoot`. `svgCheckApplies` also
  treats an `.xml` as SVG when a `<!DOCTYPE svg`, an `<svg` tag or the SVG namespace appears anywhere
  in it.
  - Why: `svgRoot` misses a root behind a doctype whose internal subset holds `>`, and it misses
    prefixed roots.
  - Consequence: a non-SVG `.xml` that merely cites the SVG namespace is checked, and refused.
- **`<use>` is refused outright, `#fragment` included.** The brief names external `<use>`; the draft
  refuses `use` entirely, and so does v1. The fixtures pin both forms.
  - Consequence: Mermaid C4 diagrams, which draw their icons with `<use>`, are refused as proposals.
- **`<image>` is refused, `data:` included.** The brief allows strict `data:image` only if the draft
  argues for it. The draft's SVG section refuses `<image>` and lists `<image href=data:…>` among the
  must-fail cases.
- **Every DOCTYPE and every CDATA section is refused.** The draft refused only a doctype with an
  internal subset, and CDATA outside `<style>`. Inside `<style>`, HTML reads `<![CDATA[` as CSS text
  while XML reads it as markup, so v1 refuses it there too.
- **`.htm` and `.xhtml` are exact-review-only too.** Neither can be proposed today. They are listed so
  that widening the text extensions later cannot quietly let a grant cover them.

### Measured against real output

The three benign Mermaid fixtures are `mermaid.render()` output, byte for byte:
- **Source:** Mermaid 11.17.2 with the Console's own configuration
  (`mermaidConfig(NECTOVIA_TOKENS)`: `htmlLabels` off, strict).
- **Capture:** in the suite's browser, with every request refused. None were made.
- **Diagrams:** a flowchart, a sequence diagram and a pie chart.

They needed:
- `style`, `filter` and `feDropShadow`;
- `@keyframes`;
- `rgb`, `rgba` and `drop-shadow`;
- `url(#…)` markers and gradients;
- `&gt;` inside `<style>`. Mermaid writes the child combinator that way; it is character data,
  decoded before the CSS check.
- eleven `data-*` names.

If a Mermaid upgrade writes something new, those fixtures fail first.

Some Mermaid exports are refused:
- one made elsewhere with the default `htmlLabels` on (`foreignObject`);
- one with C4 icons (`use`).

**Too narrow, knowingly.** These are refused, and the reason names what to remove:
- Inkscape and Illustrator exports (`metadata`, `sodipodi:*`, `inkscape:*`, CDATA in `<style>`);
- `<use>` and `textPath`;
- CSS animations that use transforms;
- `@media`.

Two ways remain to keep such a drawing:
- a Markdown file with an svg fence;
- the person's own writes, which are never checked.

### Hostile fixtures, one file per trick, each refused

Every refusal is at line 1 except `xml-stylesheet.svg` (line 2). The test pins each reason and that the
table and the directory list the same 51 files.

| Fixture | The trick | Refused with |
|---|---|---|
| `anchor-link.svg` | an `<a>` link to an outside page | `the element <a> is not allowed` |
| `animate-href.svg` | `<animate>` rewriting a gradient's `href` to an outside file | `the element <animate> is not allowed` |
| `bidi-control.svg` | a right-to-left override in a comment, so the reviewed hunk reads differently | `it holds a bidirectional control character, which can hide text from review` |
| `comment-bang-close.svg` | a comment HTML closes early at `--!>`, uncovering a `<script>` | `a comment holding "--"` |
| `comment-html-early-close.svg` | `<!-->`, which HTML closes at once, uncovering a `<script>` | `a comment that HTML and XML end in different places` |
| `cursor-attribute.svg` | `cursor="url(https://…)"`, which loads a file | `the attribute cursor on <rect> is not allowed` |
| `doctype-entity.svg` | an internal entity expanded into text | `<!DOCTYPE> is not allowed` |
| `doctype-system-entity.svg` | an external entity naming a local file | `<!DOCTYPE> is not allowed` |
| `fe-image.svg` | `<feImage>` loading an outside image | `the element <feImage> is not allowed` |
| `foreign-object.svg` | `<foreignObject>` holding XHTML | `the element <foreignObject> is not allowed` |
| `foreign-object-lowercase.svg` | `<foreignobject>`, the spelling HTML reads | `the element <foreignobject> is not allowed` |
| `href-charref-no-semicolon.svg` | `&#106avascript:`, which HTML decodes without the semicolon | `an "&" that is not &amp;, &lt;, &gt;, &quot;, &apos; or a numeric character reference ending in ";"` |
| `href-javascript-charref.svg` | `&#106;avascript:` in an `href` | `href on <linearGradient> holds javascript:` |
| `href-javascript-tab.svg` | `java&#9;script:`, whose tab a URL parser drops | `href on <linearGradient> holds javascript:` |
| `href-named-entity.svg` | `javascript&colon;`, an HTML-only named reference | `an "&" that is not &amp;, …` (as above) |
| `iframe-element.svg` | an `<iframe>` | `the element <iframe> is not allowed` |
| `image-data-uri.svg` | `<image>` with a `data:` URL | `the element <image> is not allowed` |
| `image-external.svg` | `<image>` loading an outside file | `the element <image> is not allowed` |
| `onclick-mixed-case.svg` | `OnClick` | `the event attribute OnClick on <rect> is not allowed` |
| `onload-attribute.svg` | `onload` on the root | `the event attribute onload on <svg> is not allowed` |
| `prefixed-script.svg` | `<s:script>`, with `s` bound to the SVG namespace | `the namespace declaration xmlns:s on <svg> is not allowed` |
| `presentation-url-quoted.svg` | `fill="url('https://…')"` | `fill on <rect>: url() may name only a #fragment in this file` |
| `root-html.svg` | an XHTML page named `.svg` | `the element <html> is not allowed` |
| `root-not-svg.svg` | a `<g>` root | `its root element must be <svg>` |
| `script-element.svg` | `<script>` | `the element <script> is not allowed` |
| `script-uppercase.svg` | `<SCRIPT>` | `the element <SCRIPT> is not allowed` |
| `set-href.svg` | `<set>` rewriting `href` | `the element <set> is not allowed` |
| `style-attribute-url.svg` | `style="fill:url(https://…)"` | `style on <rect>: url() may name only a #fragment in this file` |
| `style-cdata.svg` | CDATA inside `<style>`, text to HTML and data to XML | `CDATA sections are not allowed` |
| `style-charref-no-semicolon.svg` | `u&#114l(` in a `style` value | `an "&" that is not &amp;, …` (as above) |
| `style-charref-url.svg` | `url&#40;https://…&#41;` in `<style>` | `the <style> element: url() may name only a #fragment in this file` |
| `style-escape.svg` | the CSS escape `\75 rl(` for `url(` | `the <style> element: CSS escapes (a backslash) are not allowed` |
| `style-expression.svg` | `expression()` | `style on <rect>: the CSS function expression() is not allowed` |
| `style-font-face.svg` | `@font-face` loading an outside font | `the <style> element: the CSS at-rule @font-face is not allowed` |
| `style-image-set.svg` | `image-set()` | `the <style> element: the CSS function image-set() is not allowed` |
| `style-import.svg` | `@import` | `the <style> element: the CSS at-rule @import is not allowed` |
| `style-javascript.svg` | `url(javascript:…)` in `<style>` | `the <style> element holds javascript:` |
| `style-named-entity.svg` | `url&lpar;…&rpar;`, HTML-only named references | `an "&" that is not &amp;, …` (as above) |
| `svg-slash-onload.svg` | `<svg/onload=…>`, where HTML reads the slash as a space | `the tag <svg> is not written the way XML requires` |
| `text-javascript.svg` | `javascript:` in text | `text holds javascript:` |
| `title-html-breakout.svg` | `<img onerror>` in `<title>`, an HTML integration point | `<title> may hold only text` |
| `use-external.svg` | `<use href="other.svg#a">` | `the element <use> is not allowed` |
| `use-fragment.svg` | `<use href="#c">`, refused outright as the draft does | `the element <use> is not allowed` |
| `xhtml-namespace.svg` | a `<g>` rebound to the XHTML namespace | `xmlns on <g> must be the SVG namespace` |
| `xinclude.svg` | XInclude of a local file | `the namespace declaration xmlns:xi on <svg> is not allowed` |
| `xlink-href-external.svg` | `xlink:href` to an outside file | `xlink:href on <linearGradient> must name a #fragment in this file` |
| `xlink-href-uppercase.svg` | `XLINK:HREF` | `XLINK:HREF on <linearGradient> must name a #fragment in this file` |
| `xlink-rebound.svg` | XLink bound to another prefix, `x:href` | `the namespace declaration xmlns:x on <svg> is not allowed` |
| `xml-base.svg` | `xml:base`, which would make `#h` external | `the attribute xml:base on <svg> is not allowed` |
| `xml-declaration-breakout.svg` | a `>` inside the XML declaration, where HTML ends it and reads `<img onerror>` | `its XML declaration is not a plain version 1.0, UTF-8 one` |
| `xml-stylesheet.svg` | `<?xml-stylesheet?>` loading outside CSS | `the processing instruction <?xml-stylesheet?> is not allowed; only a leading XML declaration is` |

The benign set, each passing: `logo.svg` (hand-written: a gradient that `href`s another by
`#fragment`, a clip path, `url(#…)` in `<style>`, `&amp;` in text) and three `mermaid.render()`
captures, `mermaid-flowchart.svg`, `mermaid-sequence.svg` and `mermaid-pie.svg`.

## Where the check runs

The check is `contentCheck` in `server/native-work.ts`, called from `prepare()`:
- for every file a proposal writes;
- after the unchanged-echo skip;
- on the redacted text that is actually written.

The draft put it in `parseProposal` (`:232` at `dd895af`). It moved for two reasons:
- redaction rewrites a change after parsing;
- an unchanged echo of a selected source writes nothing, so it is not checked.

`prepare()` is the only place a model's proposal becomes file writes. Three other things parse
proposals or make Needs, and none of them writes a drawing:
- the harness engine parses proposals for one fixed report path;
- the harness bridge makes Needs with no file preview;
- sample work (`work.ts`) makes Needs for scripted Markdown writes only.

A failure:
- throws `The SVG check refused <file>: <reason>.` (422);
- keeps the raw reply and the reason on the session and its fault entry, as a parse refusal does;
- makes the session log read `Work stopped: The SVG check refused <file>: <reason>. No project files
  were changed.`

No Need is made and nothing is written.

## Exact review for `.svg`, `.html` and `.xml`

`exactReviewOnly(name)` (`server/paths.ts`) is true for `.svg`, `.html`, `.htm`, `.xhtml` and `.xml`.

Every grant path runs through `scope-grants.ts` `check()`: matching, mint and effect, including the
model-reviewer path. `check()` refuses such a write with:

> `<file> always needs your exact review: an SVG, HTML or XML file can run code when it is opened.`

That message becomes the Need's `authorizationBoundary`.

- `.mmd` stays ordinary text, so a grant covers it.
- Deletion keeps its own message.
- "Go ahead for this whole task" was already refused for these Needs: `native-work.ts` `resolve`
  throws when `allowForTask` is set.

The person's own writes are unchanged: `/documents/create`, `/documents/write`, the editor, and
Save to Files. Two tests show this:
- one drives the panel's real `saveArtifact` through the real routes, saving a design as `.html` with
  a script in it, twice;
- one writes a hostile `.svg` through the editor routes.

## The verdict in the review

`Need.checks` holds one `NeedCheck` for each file a check speaks for:
- **An SVG:** `{check: 'svg', version: 1, outcome: 'passed', sentence}`, with the draft's sentence
  "SVG check passed: no script, links or outside references (svg-check v1)".
- **Another `.html` or `.xml`:** `{check: 'none', outcome: 'unchecked', sentence}`, with "No content
  check: this file can run code when it is opened in a browser. Read it before you say go ahead."
  This is one of the draft's "gaps the review must see".
- **Markdown, Mermaid and other text:** no line.

It is not part of the approval digest:
- it is derived from the preview text, which the digests already bind;
- adding it would break `validateApprovalReceipts` on every stored Need.

`ApprovalStatus` renders the checks above the decision record, in the approval register's own style.
They show in:
- the Need block;
- the "Show me first" dialog, beside the hunks;
- History;
- thread receipts.

They show for an open Need too. `Need.tsx` and `Shell.tsx` were not touched.

## Tests

There are three new files with 92 tests, and every one has been seen failing. Each failed either:
- red, before the code existed; or
- under a mutation of the code it guards.

Mutations were applied one at a time, and each file was restored byte for byte afterwards. The
scripts and logs are in the lane's working notes.

### `tests/svg-check.test.ts`: 68 tests

- Each of the 51 hostile fixtures is refused with its reason. The table and the directory list the
  same files.
- The four benign fixtures pass, and the directory holds exactly those.
- Rule tests:
  - the verdict sentence and version;
  - the refusal names its line and never repeats the value;
  - the 1 MB cap;
  - depth 128 passes, and 129 is refused;
  - names compare without case;
  - the XML declaration and a BOM;
  - character references;
  - well-formedness;
  - namespaces;
  - CSS;
  - `svgCheckApplies`, including `svgRoot`'s blind spot and a doctype-only `.xml`.

Seen failing: 68 of 68.

| Mutation | Tests failed |
|---|---|
| M0 `svgProblem` always passes | 60 |
| M1 `svgProblem` always refuses | 64 |
| M2 references checked but not decoded | 4 |
| M3 attribute names compared with case | 8 |
| M4 no early-close comment rule | 1 |
| M5 no `--` comment rule | 1 |
| M6 CSS escapes allowed | 1 |
| M7 no squeeze before the `javascript:` scan | 1 |
| M8 markup allowed inside `title`, `desc` and `style` | 1 |
| M9 the `.xml` doctype clause dropped | 1 |
| M10 a loose XML declaration | 2 |
| M11 the verdict version bumped | 1 |
| F1 a hostile fixture with no reason in the table | 1 |
| F2 a benign file nobody captured | 1 |

M11, F1 and F2 each prove one of the three tests that M0 to M10 left unproven.

### `tests/drawings-trust.test.ts`: 21 tests

These run against an in-process app with an injected generator.

- **The kind:**
  - the listing;
  - saved versions;
  - automatic sources skip drawings;
  - the palette.
- **Sources:**
  - a selected drawing is sent, and its edit becomes a Need;
  - a `.png` is still refused (415).
- **svg-check on proposals:**
  - A hostile `.svg` is refused with its reason, its log line and its fault entry. No Need is made
    and no file is written.
  - Two `.xml` files are checked as SVG: one with an svg root, and one whose doctype hides the root
    from `svgRoot`.
  - A passing `.svg` carries its verdict.
  - An `.html` and an `.xml` say no check read them. `.md` and `.mmd` carry no line.
- **Grants:**
  - No grant covers an `.svg`, `.html` or `.xml`. The Need stays open with the boundary message.
  - A grant confirmed while an `.svg` Need waits leaves it waiting.
  - A grant still covers an `.mmd`.
- **The person's own writes:**
  - `saveArtifact` saves a design `.html` with a script in it, twice;
  - the editor routes write a hostile `.svg`.
- **The review:** `ApprovalStatus`:
  - shows each check beside the approval record;
  - shows checks before there is an approval record;
  - shows nothing when there are no checks.

Seen failing: 21 of 21.
- 16 failed red, before the code. They include the review test that none of the mutations below
  reaches.
- Mutations:

  | Mutation | Tests failed |
  |---|---|
  | G1 grants cover svg, html and xml | 4 |
  | G2 no content check | 5 |
  | G3 `.xml` never read as SVG | 2 |
  | G4 no drawing kind | 11 |
  | G5 the person's writes checked in `/documents/write` | 2 |
  | G6 an empty checks block rendered | 1 |
  | G7 checks hidden before approval | 1 |
  | G8 drawings refused as sources | 1 |
  | G9 any file accepted as a source | 1 |

  G5 edits lane 4's route. It was made locally only, and restored.

### `tests/drawings-ui.spec.ts`: 3 Playwright tests

These run against the built Console and the real routes. Any request that leaves the loopback host
fails the test.

1. Files previews `logo.svg` in the image frame:
   - the frame is `sandbox=""` with `default-src 'none'`;
   - the drawing is in the frame's document, never the app's.

   It then previews `flow.mmd` in the diagram frame, and Raw shows the source.
2. A hostile `.svg` proposal fails with its reason. No Need is made and no file is written. The
   thread's run record shows:

   > Work stopped: The SVG check refused badge.svg: the element `<script>` is not allowed (line 1).
   > No project files were changed.
3. A passing `.svg` proposal shows its verdict in the Need and in "Show me first", and writes nothing
   before go-ahead.

Seen failing: 3 of 3.
- S1, no content check: tests 2 and 3 fail.
- S2, the drawing drawn inline into the app's document instead of the frame, then rebuilt: test 1
  fails.

## Gates

All four ran under the heavy slot, with the Playwright ports 5244 and 47702. The logs are kept with
the lane's working notes.

**On this branch, before merging main** (base `a298382`):

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p .` | exit 0 |
| `npx vitest run` | 325 files: 5855 passed, 4 skipped (5859); exit 0 |
| `npx vite build` | exit 0, with the usual chunk-size warning |
| `npx playwright test` | 202 passed in 5.0 minutes, `drawings-ui.spec.ts` included; exit 0 |

**After merging `origin/main` `8f73322`** (merge `02d7c84`, with lane 4 and the lineage lane):

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p .` | exit 0 |
| `npx vitest run` | 330 files: 5900 passed, 4 skipped (5904); exit 0 |
| `npx vite build` | exit 0 |
| `npx playwright test` | 210 passed in 5.5 minutes, `drawings-ui.spec.ts` included; exit 0 |

In both runs:
- no failure needed a re-run;
- `field.spec.ts` C07 did not cascade;
- `evidence/` and `docs/verification/2026-09-17-design-center/` were restored afterwards.

## For lane 4 and the integrator

### Lane 4

- **Lane 4 landed first** (#46, `8f73322`) and is merged into this branch at `02d7c84`. The two lanes
  share no file, so there were no conflicts.
  - This lane never used `REFUSED_MATH_OR_IMAGE`.
  - It does not edit `tests/fixtures/scripted-artifacts.ts`.
  - The `saveArtifact` test passes with lane 4's `merge: false`.
- **`ArtifactFrame` and `indexFile`.** `FilesPane.tsx` renders drawings with lane 4's
  `ArtifactFrame({ record })` (`artifact-frames.tsx`) and `indexFile(path, text)` (`artifacts.ts`).
  The Playwright spec looks for `iframe.art-frame.still.image` and `.still.diagram`. If that signature
  or those classes change, FilesPane and the spec need the same change.
- **`saveArtifact`.** `tests/drawings-trust.test.ts` drives the real `saveArtifact`
  (`artifact-save.ts`) through the real `/documents/create` and `/documents/write` routes. That is how
  it proves the person's `.html` save is unchecked.
  - It follows lane 4's route changes.
  - If `saveArtifact`'s arguments change, the test needs the same edit.
- **`playwright.config.ts`.** This lane adds one line, `'drawings-ui.spec.ts'`, at the end of
  `testMatch`. If lane 4 appends a line too, the conflict is trivial.
- **The dist check.** `tests/drawings-ui.spec.ts` serves the built `dist`. It fails on a build older
  than `FilesPane.tsx`, `files.css`, `components.tsx` or `types.ts`. Build before running it alone.
- **Mermaid output.** svg-check's CSS scanner is a stricter copy of `withoutFetchingUrls` in
  `mermaid-render.ts`. If what Mermaid writes changes, re-capture the benign fixtures.

### Integrator

- **`shared/types.ts`: new types.** `DocumentInfo.kind` gains `'drawing'`, and `Need.checks?` and the
  `NeedCheck` type are new. The lineage lane edits conversation types in the same file; the hunks
  are apart.
- **`shared/types.ts`: `Session.parseError`.** Its comment says it is set only when the parser
  refused the reply. A content-check refusal now sets it too, and keeps the reason as a parse refusal
  does. `Session` is not this lane's part of the file. Suggested wording: "set when the parser or a
  content check refused the reply".
- **`server/native-work.ts`** is a hot file. This lane's hunks are:
  - the imports;
  - `UNCHECKED_SENTENCE` and `contentCheck`, after `parseProposal`;
  - a comment in the sources loop;
  - the check in `prepare()`, and `checks` on the Need.
- **`server/store.ts`** (not touched). Saved versions and whole-folder restore now include drawings,
  because they test only for `'unsupported'`.
- **`client/console/DocumentEditor.tsx`** (not touched). It opens drawings as source text.
- **`client/console/Need.tsx`** (not touched). "Allow creates and updates for this task" still shows
  on an `.svg`, `.html` or `.xml` Need.
  - The grant it mints covers the task's other files, but never that Need.
  - That Need keeps waiting, with "Approval needed: … always needs your exact review …".
  - Follow-up for the UI: hide the offer when every change is exact-review-only.

### Trust owner (open, not blocking)

- **Other code files.** Proposals for `.js`, `.bat`, `.ps1`, `.sh`, `.py` and `.css` are still text a
  grant can cover. None of them runs when opened in the app, but each is code. Whether they join
  `exactReviewOnly` is the owner's call.
- **"Stricter than asked"**, above.
