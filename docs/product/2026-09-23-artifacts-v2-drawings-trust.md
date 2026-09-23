# Artifacts v2, lane 3: drawings in Files, and the Trust checks on them

**Decision record.** Version 2026-09-23.1. Artifacts panel v2 was approved by Andrew on 2026-09-23 and
targets 0.1.9. This lane carries frozen decision 7 (`.svg` and `.mmd` drawings) and the Trust checks
for it. The lane brief and `ARTIFACTS_V2_FROZEN.md` override the contract draft wherever they differ.

**Status: complete on `feature/artifacts-drawings-trust`.**
- Worktree `F:/Diomedes/diomedes-wt/artifacts-drawings-trust`, base `a298382` (lane 1's commit). The
  lane's work is commit `250f570`. The independent review's fixes are the commit on top of merge
  `cfe0e29`.
- `origin/main` is merged in twice, with no conflicts:
  - `8f73322` at `02d7c84`: lane 4 (#46) and the lineage lane (#45);
  - `2a8f843` at `cfe0e29`: the theme-pack README (#47) and the Mermaid fetch hardening (#48).
- Gates passed under the heavy slot three times: before the first merge, after it, and after the
  second merge with the review's fixes. The last run:
  - tsc;
  - the full vitest suite, 5927 passed;
  - the build;
  - the full Playwright suite, 213 passed.
- This lane lands before lane 2 (the coordinator's order, 2026-09-23). Not merged to main, not pushed,
  not released.

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
- **Exact review for `.svg`, `.html` and `.xml` proposals**: `exactReviewOnly` in
  `shared/exact-review.ts` (re-exported by `server/paths.ts`) and `server/trust/scope-grants.ts`.
- **The grant offer** (`client/console/Need.tsx`): "Allow creates and updates for this task" is not
  offered on a Need that writes an `.svg`, `.html` or `.xml`, because no grant could cover it.
- **The verdict on the Need**: `Need.checks?: NeedCheck[]` (`shared/types.ts`), shown by
  `ApprovalStatus` (`client/components.tsx`).
- **`Session.parseError`'s comment** (`shared/types.ts`) now says it is set when the parser or a
  content check refused the reply. A content-check refusal keeps its reason there, as a parse refusal
  does.

## The independent review, 2026-09-23

An independent security review of this branch tried 170 candidate files against `svgProblem` and
found no way past it. Its verdict was "merge after fixes". The report is kept with the lane's working
notes.

Fixed on this branch, each with a test seen failing first:
- **P2-A, `.xml` detection could be evaded.** Browsers run script from four `.xml` files that
  `svgCheckApplies` did not read as SVG:
  - a prefixed `<x:svg>` root, and a `<g>` root, each with the namespace spelled with a character
    reference;
  - an `<s:svg>` nested inside another root;
  - a namespace assembled from DOCTYPE entities.

  See "Which files it reads". The four are now hostile fixtures.
- **P3-1, files that pass but that no XML parser opens.** Text outside the root other than XML's own
  space characters, namespace names in another case, and a root without `xmlns`. Each is now refused.
- **P3-2, `url(#…)` where a browser fetches it.** Edge fetches the drawing's own URL again for a
  `#fragment` in `background-image`, `cursor` and `content`, and anywhere inside `@keyframes`. A
  `url()` is now allowed only in the paint and reference properties, and never in a nested block.
  - This grew past the property rule by one step: brackets must pair up.
  - Without it, `@keyframes a{to{fill:rgb(}});fill:url(#b)}}` would read to the scanner as a
    top-level `fill:url(#b)`. A browser reads it inside the keyframe, because a function runs to its
    matching `)`, so it is exactly the case the review found.
  - Mutations C1 and C2 under "Tests" prove both new lines are load-bearing.
- **P3-6, test gaps.** A hostile `.svg` already on disk, shown by Files, where the frame is the only
  defence. And a mixed `.md` and `.svg` batch under a grant, which is refused whole.
- The grant offer and the `parseError` comment, above.

Recorded, not changed: P2-B, P3-3 and P3-4, under "Open items".

## svg-check v1

svg-check has two parts:
- a strict tokenizer for a subset of XML that two parsers read the same way:
  - an XML parser, which reads the `.svg` when it is opened in a browser;
  - an HTML parser, which reads the same markup inlined into a page, as the frame shows it;
- an allowlist over what the tokenizer reads.

When it refuses, the reason names the element, attribute or CSS feature and the line, and never
repeats a value. It never rewrites anything.

It adds no dependency. The only XML parser in `node_modules` is transitive, so none is imported.

It is still v1 after the review's fixes (`SVG_CHECK_VERSION` is 1). Nothing has shipped with it, so
no stored verdict names an earlier rule set.

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
  - a root that does not declare the SVG namespace with `xmlns`. An `<svg>` inlined into a page
    needs none, but a file a browser opens is read by an XML parser, which puts the root in the SVG
    namespace only when the root says so;
  - markup outside the root;
  - text outside the root other than XML's own space characters (space, tab, carriage return and
    line feed), written out. So no reference, no no-break or ideographic space, and no second byte
    order mark: JavaScript's `trim()` takes those, but an XML parser refuses them;
  - end tags that do not match exactly;
  - nesting deeper than 128.
- A file over 1 MB. Proposals are already capped at 128 KB; this cap bounds any other caller.

**Names compare without case**, because an HTML parser lowercases them. So `<SCRIPT>` and `OnClick`
are read as a browser would read them.

The exception is the names an XML parser reads only in lower case: `xmlns`, `xmlns:xlink`,
`xlink:href`, `xml:lang` and `xml:space`. To it, `XMLNS:XLINK` is an attribute with a prefix nothing
declares, and the file does not open. Each must be written in lower case, and `XLINK:HREF` is refused
for its spelling.

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
- `xmlns`, which must be the SVG namespace, and which the root must have;
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
- **`url()`** may name only a `#fragment`, quoted or not. It may appear only:
  - in a `fill`, `stroke`, `clip-path`, `mask`, `filter`, `marker`, `marker-start`, `marker-mid` or
    `marker-end` declaration, or the presentation attribute of that name;
  - outside any nested block, so never in a rule inside `@keyframes`.

  Elsewhere a `#fragment` is still a URL: Edge fetches the drawing's own URL again for
  `background-image`, `cursor` and `content`, and anywhere inside `@keyframes`.
- **Brackets must pair up.** A browser reads a `}` or `;` inside parentheses as part of the value,
  because a function runs to its matching `)`. Without this rule, the scanner would read
  `@keyframes a{to{fill:rgb(}});fill:url(#b)}}` as a top-level `fill:url(#b)`, while a browser reads
  it inside the keyframe.
- **At-rules:** `@keyframes` only; the fixtures use it. `@import`, `@font-face`, `@media` and every
  other at-rule are refused.
- **Functions:**
  - allowed: `rgb`, `rgba` and `drop-shadow`, which the fixtures use, and `hsl` and `hsla`, the
    other plain colour notations (allowed in advance of any fixture);
  - refused by name: every other function, including `image-set`, `expression`, `var`, `calc`,
    `src` and the transform functions.
- **Not restricted:** selectors, and properties except where a `url()` may appear. Without a
  fetching function or at-rule, none of them can reach outside the file.

**Which files it reads** (`svgCheckApplies`):
- every `.svg`;
- every `.xml` a browser could open as SVG. Any one of these makes an `.xml` SVG here:
  - `svgRoot` reads its root as `svg`;
  - a doctype names `svg`;
  - an svg start tag appears anywhere, `<svg` or a prefixed `<p:svg`;
  - the SVG namespace appears once character references and the five predefined entities are
    decoded, as an XML parser decodes them. To it, `http://www.w3.org/2000/sv&#103;` is the SVG
    namespace;
  - a DOCTYPE has an internal subset. Its entities and default attributes can assemble the namespace
    from pieces no test here would find. svgProblem refuses every DOCTYPE, so such a file is refused.

Browsers load no external DTD, so a DOCTYPE without an internal subset cannot supply the namespace.

The svg start tag is looked for in the text as written, not decoded. This differs from the review's
wording, which asked for references to be decoded before both tests:
- a reference can never spell markup;
- decoding there would make a feed that quotes SVG as escaped text (`&lt;svg&gt;`) count as SVG, and
  then refuse it.

The namespace test decodes. A test pins the escaped feed as unchecked.

An `.xml` that is XHTML, or that names an XSLT stylesheet, can still run script without being SVG.
No check reads it, and its review says so (see "The verdict in the review").

### Stricter than asked

Each of these is deliberate. The Trust owner should confirm or loosen them.

- **`.xml` detection goes past `svgRoot`.** The brief says to use `svgRoot`. `svgCheckApplies` uses
  the five tests under "Which files it reads".
  - Why: `svgRoot` misses a root behind a doctype whose internal subset holds `>`, and prefixed roots.
    It also misses each of the four files the review found.
  - Consequence: a non-SVG `.xml` is checked, and refused, when it cites the SVG namespace or has
    any internal subset (DocBook with its own entities, say). The person can still write one, and a
    proposal can still write one without the subset.
- **The root must declare `xmlns`, and namespace names must be in lower case.** Both are what an XML
  parser needs to open the file as a drawing. The review asked for them (P3-1).
- **Nothing but XML space outside the root.** The same reason (P3-1).
- **`url()` only in the paint and reference properties, never nested, and brackets that pair up.**
  The review asked for the first two (P3-2). The third is this lane's, for the reason under "CSS".
  Mermaid's own output passes: the three captures use `url(#…)` only in `fill`, `stroke` and
  `marker-end`, and never inside `@keyframes`.
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
- `url(#…)` markers and gradients, in `fill`, `stroke` and `marker-end` only;
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

Every refusal is at line 1 except `xml-stylesheet.svg` (line 2). The test pins three things:
- each file's reason;
- that `svgCheckApplies` reads each file, the four `.xml` files only because they are SVG;
- that the table and the directory list the same 55 files.

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
| `xlink-href-uppercase.svg` | `XLINK:HREF`, a name an XML parser reads only in lower case | `the attribute XLINK:HREF on <linearGradient> must be written xlink:href` |
| `xlink-rebound.svg` | XLink bound to another prefix, `x:href` | `the namespace declaration xmlns:x on <svg> is not allowed` |
| `xml-base.svg` | `xml:base`, which would make `#h` external | `the attribute xml:base on <svg> is not allowed` |
| `xml-declaration-breakout.svg` | a `>` inside the XML declaration, where HTML ends it and reads `<img onerror>` | `its XML declaration is not a plain version 1.0, UTF-8 one` |
| `xml-entity-ns.xml` | the SVG namespace assembled from three DOCTYPE entities, on an `<x:g>` holding `<x:script>` | `<!DOCTYPE> is not allowed` |
| `xml-g-root-charref-ns.xml` | a `<g>` root holding `<script>`, its namespace ending `sv&#x67;` | `its root element must be <svg>` |
| `xml-nested-prefixed.xml` | an `<s:svg>` holding `<s:script>`, nested in a `<root>` that writes the namespace `http&#58;//…` | `the element <root> is not allowed` |
| `xml-prefixed-root-charref-ns.xml` | an `<x:svg>` root holding `<x:script>`, its namespace ending `sv&#103;` | `the prefixed element <x:svg> is not allowed` |
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

`exactReviewOnly(name)` (`shared/exact-review.ts`, re-exported by `server/paths.ts`) is true for
`.svg`, `.html`, `.htm`, `.xhtml` and `.xml`. It lives in `shared/` so that the Console can use the
same rule.

Every grant path runs through `scope-grants.ts` `check()`: matching, mint and effect, including the
model-reviewer path. `check()` refuses such a write with:

> `<file> always needs your exact review: an SVG, HTML or XML file can run code when it is opened.`

That message becomes the Need's `authorizationBoundary`.

- `.mmd` stays ordinary text, so a grant covers it.
- A batch that writes an `.svg` beside Markdown is refused whole. The grant covers none of it, and
  both files wait in one Need with the `.svg`'s message.
- The Console does not offer "Allow creates and updates for this task" on a Need that writes any of
  these files (`client/console/Need.tsx`). The grant it would mint could never cover that Need.
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

They show for an open Need too, with no change to `Need.tsx` or `Shell.tsx` for them. (`Need.tsx`
changed only to withhold the grant offer; see "Exact review".)

## Tests

There are three new files with 109 tests, and every one has been seen failing. Each failed either:
- red, before the code existed; or
- under a mutation of the code it guards.

Mutations were applied one at a time, and each file was restored byte for byte afterwards. The
scripts and logs are in the lane's working notes.

The review's fixes added 17 tests: 9 in `svg-check.test.ts`, 7 in `drawings-trust.test.ts` and 1
in `drawings-ui.spec.ts`. They were written first.
- 14 of them failed red. So did `xlink-href-uppercase.svg`'s test, with its new reason: 15 in all,
  10 in `svg-check.test.ts` and 5 in `drawings-trust.test.ts`.
- The other three failed under the mutations named below: G1, N2 and S3.

### `tests/svg-check.test.ts`: 77 tests

- Each of the 55 hostile fixtures is read by `svgCheckApplies` and refused with its reason. The table
  and the directory list the same files.
- The four benign fixtures pass, and the directory holds exactly those.
- Rule tests:
  - the verdict sentence and version;
  - the refusal names its line and never repeats the value;
  - the 1 MB cap;
  - depth 128 passes, and 129 is refused;
  - names compare without case, and the namespace names only in lower case;
  - the XML declaration and a BOM;
  - nothing but XML space outside the root;
  - the root declares `xmlns`;
  - character references;
  - well-formedness;
  - namespaces;
  - CSS, including where a `url()` may appear and brackets that pair up;
  - `svgCheckApplies`, including `svgRoot`'s blind spot, a doctype-only `.xml`, a namespace spelled
    with references, an internal subset, and an escaped feed that stays unchecked.

Seen failing: 77 of 77.

The first round, on the 68 tests before the review:

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

The review's fixes: 10 failed red (the four `.xml` fixtures, `xlink-href-uppercase.svg`, four rule
tests and one `svgCheckApplies` test). The bracket rule was added to the `url()` rule test after it
passed, so two mutations prove it:

| Mutation | Tests failed |
|---|---|
| C1 CSS brackets need not pair up | 1, the `url()` rule test |
| C2 a `;` inside parentheses ends the declaration | 1, the `url()` rule test |

### `tests/drawings-trust.test.ts`: 28 tests

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
  - Three `.xml` files are checked as SVG: one with an svg root, one whose doctype hides the root
    from `svgRoot`, and one whose namespace is spelled with a character reference.
  - A passing `.svg` carries its verdict.
  - An `.html` and an `.xml` say no check read them. `.md` and `.mmd` carry no line.
- **Grants:**
  - No grant covers an `.svg`, `.html` or `.xml`. The Need stays open with the boundary message.
  - A grant covers no part of a batch that writes an `.svg` beside Markdown. Both wait, and neither
    file is written.
  - A grant confirmed while an `.svg` Need waits leaves it waiting.
  - A grant still covers an `.mmd`.
- **The grant offer** (`NeedBlock`): made where a grant could cover every file, and not made for an
  `.svg`, `.html` or `.xml`, or for a batch with an `.svg` in it.
- **The person's own writes:**
  - `saveArtifact` saves a design `.html` with a script in it, twice;
  - the editor routes write a hostile `.svg`.
- **The review:** `ApprovalStatus`:
  - shows each check beside the approval record;
  - shows checks before there is an approval record;
  - shows nothing when there are no checks.

Seen failing: 28 of 28.
- In the first round, 16 of the 21 failed red, before the code. They include the review test that
  none of the mutations below reaches.
- The review's fixes: 5 failed red (the character-reference `.xml` and the four offers that must not
  be made).
- Mutations, G1 to G9 from the first round and re-run for G1:

  | Mutation | Tests failed |
  |---|---|
  | G1 grants cover svg, html and xml | 4; re-run after the review, 5 with the mixed batch |
  | G2 no content check | 5 |
  | G3 `.xml` never read as SVG | 2 |
  | G4 no drawing kind | 11 |
  | G5 the person's writes checked in `/documents/write` | 2 |
  | G6 an empty checks block rendered | 1 |
  | G7 checks hidden before approval | 1 |
  | G8 drawings refused as sources | 1 |
  | G9 any file accepted as a source | 1 |
  | N1 the offer ignores exact review | 4, the offers that must not be made |
  | N2 the offer is never made | 1, the offer that must be made |

  G5 edits lane 4's route. It was made locally only, and restored.

### `tests/drawings-ui.spec.ts`: 4 Playwright tests

These run against the built Console and the real routes. Any request that leaves the loopback host
fails the test.

1. Files previews `logo.svg` in the image frame:
   - the frame is `sandbox=""` with `default-src 'none'`;
   - the drawing is in the frame's document, never the app's.

   It then previews `flow.mmd` in the diagram frame, and Raw shows the source.
2. Files shows a hostile `.svg` already in the folder, where no check has read it and the frame is the
   only defence. The file has a root `onload`, a `<script>`, an `@import`, a `url()` fill, two
   images and a `foreignObject` `<img onerror>`. One image names an outside host; everything else
   that loads names a probe route on the test's own loopback server. Once the frame has loaded: no
   script has run, the probe has had no request, and the frame is `sandbox=""` with
   `default-src 'none'`.
3. A hostile `.svg` proposal fails with its reason. No Need is made and no file is written. The
   thread's run record shows:

   > Work stopped: The SVG check refused badge.svg: the element `<script>` is not allowed (line 1).
   > No project files were changed.
4. A passing `.svg` proposal shows its verdict in the Need and in "Show me first", and writes nothing
   before go-ahead.

Seen failing: 4 of 4.
- S1, no content check: tests 3 and 4 fail.
- S2, the drawing drawn inline into the app's document instead of the frame, then rebuilt: test 1
  fails. (Test 2 did not exist yet.)
- S3, Files' frame given `allow-scripts` and no policy of its own, then rebuilt: tests 1 and 2 fail.
  - Test 2 fails on three probe requests: `import.css`, `image.png` and `foreign.png`.
  - No script ran even then. The Console's own policy (`script-src 'self'`), which a `srcdoc` frame
    inherits, refuses inline script. The frame's own policy is still what stops the loads.

## Gates

Every run of the four gates was under the heavy slot, with the Playwright ports 5244 and 47702. The
logs are kept with the lane's working notes.

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

**After merging `origin/main` `2a8f843`** (merge `cfe0e29`, with #47 and #48), with the review's
fixes:

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p .` | exit 0 |
| `npx vitest run` | 331 files: 5927 passed, 4 skipped (5931); exit 0, on the second run |
| `npx vite build` | exit 0 |
| `npx playwright test` | 213 passed in 5.4 minutes, `drawings-ui.spec.ts` included; exit 0 |

The first vitest run had one failure:
- `scoped-work.test.ts` "one confirmation permits twenty journaled edits" hit its 30-second timeout.
  That run took 186 seconds, against 109 for the second.
- Alone it passed three times out of three, in about 3 seconds each.
- It makes 20 durable writes of Markdown. On that path this lane adds only file-name tests, in
  `contentCheck` and the grant check. So the failure was load on the machine, not the change.
- The whole vitest suite was then re-run under the slot, and passed.

`field.spec.ts` C07 did not cascade, and `evidence/` and
`docs/verification/2026-09-17-design-center/` were restored afterwards.

## For the other lanes and the integrator

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
  than `FilesPane.tsx`, `files.css`, `Need.tsx`, `components.tsx`, `exact-review.ts` or `types.ts`.
  Build before running it alone.
- **Mermaid output.** svg-check's CSS scanner is a stricter copy of `withoutFetchingUrls` in
  `mermaid-render.ts`. If what Mermaid writes changes, re-capture the benign fixtures.
- **The Mermaid fetch hardening (#48)** is merged in at `cfe0e29`. It changed `mermaid-render.ts`
  and moved the app's policy to `shared/app-csp.ts`. It left alone everything this lane relies on:
  - `withoutFetchingUrls` is still there;
  - `artifact-frames.tsx`, `artifact-frame.ts`, `FilesPane.tsx` and `files.css` are unchanged;
  - every frame is still `sandbox=""`, with the classes the spec looks for.

### Lane 2

Lane 2 lands after this lane and merges main then. This lane's hunks it may meet:
- `shared/types.ts`: `DocumentInfo.kind`, `Need.checks` with `NeedCheck`, and the `Session.rawReply`
  comment;
- `client/console/Need.tsx`: one import and the grant offer's condition.

### Integrator

- **`shared/types.ts`: new types.** `DocumentInfo.kind` gains `'drawing'`, and `Need.checks?` and the
  `NeedCheck` type are new. The lineage lane edits conversation types in the same file; the hunks
  are apart.
- **`shared/types.ts`: `Session.rawReply`'s comment.** It now says a content-check refusal keeps the
  reply and sets `parseError`, as a parse refusal does. `Session` is not this lane's part of the
  file; this was the suggested wording, applied at the review's request.
- **`server/paths.ts` and `shared/exact-review.ts`.** `exactReviewOnly` moved to `shared/` and
  `server/paths.ts` re-exports it, so no server import changed.
- **`client/console/Need.tsx`.** One import and one condition: the grant offer is withheld on a Need
  that writes an `.svg`, `.html` or `.xml`.
- **`server/native-work.ts`** is a hot file. This lane's hunks are:
  - the imports;
  - `UNCHECKED_SENTENCE` and `contentCheck`, after `parseProposal`;
  - a comment in the sources loop;
  - the check in `prepare()`, and `checks` on the Need.
- **`server/store.ts`** (not touched). Saved versions and whole-folder restore now include drawings,
  because they test only for `'unsupported'`.
- **`client/console/DocumentEditor.tsx`** (not touched). It opens drawings as source text.

## Open items (not blocking)

- **Other code files, for the Trust owner.** Proposals for `.js`, `.bat`, `.ps1`, `.sh`, `.py` and
  `.css` are still text a grant can cover. None of them runs when opened in the app, but each is
  code. Whether they join `exactReviewOnly` is the owner's call.
- **P2-B, for Andrew: markup-first text opened from `file://`.** Recorded; nothing changed.
  - Firefox sniffs a file opened from `file://` that starts with markup. So an `.mmd`, `.md` or other
    text file can run script there.
  - Plan mode writes `.md` without review. That predates this lane.
  - Whether exact review should key on content that starts with `<` is Andrew's call: decision 7
    says `.mmd` follows the text rules.
- **P3-3: "Go ahead" without the diff.** Recorded; nothing changed. "Go ahead" can approve an
  unchecked `.html` or `.xml` without opening the diff. Follow-up: for an unchecked Need, offer Go
  ahead only inside "Show me first".
- **P3-4: Save to Files writes a design `.html` byte for byte.** Recorded; nothing changed. It is
  the person's own write, which no check reads (see "Exact review").
- **"Stricter than asked"**, above, for the Trust owner to confirm or loosen.
