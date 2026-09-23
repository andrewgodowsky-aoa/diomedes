# Mermaid fetch hardening

Status: built and committed locally in `feature/mermaid-fetch-hardening` (worktree
`F:/Diomedes/diomedes-wt/mermaid-fetch-hardening`, from main 8f73322). Not pushed, merged or
released. Target: 0.1.9.

## Why

The lane 4 security review (P2-1) found a model-authored sequence diagram can make the Console
request a same-origin URL while Mermaid lays the diagram out: `properties Alice: {"icon": "/api/..."}`
becomes an SVG `<image>` whose `xlink:href` Mermaid's `sanitizeUrl` allows, and the desktop shell
attaches the session header to requests for the local service. `details Alice: <id>` reads an
element of the app's own document by id and applies its JSON the same way.

The app's policy (`img-src 'self' data:`) keeps every such request on the local service, no
response is readable by the diagram, and no GET route the app mounts has a side effect, so the
exposure is a blind request. It shipped in 0.1.8 with model artifacts v1.

## What changes

All of it is in `client/console/mermaid-render.ts` unless named. Line numbers below are Mermaid
11.17.2's, the version installed, under `node_modules/mermaid/dist/`.

### A sequence diagram's properties and details are refused before Mermaid sees them

`refusal()` refuses a sequence diagram that has a `properties` or `details` statement, with a new
message, `REFUSED_PARTICIPANT_DETAILS`: "This sequence diagram gives a participant properties or
details, which can show a picture from a link or take content from the page by id, so it is not
drawn here." It is checked after math and before shape data and styles. The check reads the text
`draw()` hands Mermaid (`preparedSource`) as Mermaid will read it, with Mermaid's own regexes, in
Mermaid's order.

**Which diagrams.** Mermaid's sequence detector, `/^\s*sequenceDiagram/` (`mermaid.core.mjs:277`,
from `src/diagrams/sequence/sequenceDetector.ts`), run on the text Mermaid's detection sees:
`preprocessDiagram` (`mermaid.core.mjs:1036`) normalises newlines, takes one frontmatter block
off, removes directives and comment lines (`cleanupComments`, `:967`) and trims leading space, and
`detectType` removes frontmatter, directives and comments once more (its regexes are at
`chunks/mermaid.core/chunk-DU6HZSFF.mjs:5009-5011`) before it tries its detectors. So comments,
directives, blank lines and even two frontmatter blocks may come before the keyword. The detector
is case-sensitive: to Mermaid `SEQUENCEDIAGRAM` is no diagram at all, and the check agrees. A
detector Mermaid tries first can only take a text for another kind, so where the two could differ
the check refuses a diagram Mermaid would have drawn as something else, never the reverse.

**Where a statement starts (beyond the brief).** The brief refuses a statement whose first word is
`properties` or `details`, with statements split at newlines and semicolons. Mermaid's sequence
lexer (`chunks/mermaid.core/sequenceDiagram-WJ2MYXX4.mjs`) ignores case, and its grammar has
`properties` and `details` only as the first token of a statement, but a statement can also start
on the same line as something else. Mermaid's own parser applied `properties` in each of these, so
the brief's rule alone would have let them through:

- right after the `sequenceDiagram` keyword: `sequenceDiagram properties A: {...}`;
- after `end`, which closes a block without a newline: `end properties A: {...}`;
- after the `}` that closes an `accDescr { ... }` block; a `;` inside the block ends nothing;
- after any of `/ \ ( ) < >`: where the lexer cannot start another token with one of these, it
  reads it as an INVALID line of its own (lexer rule 93), and the next statement starts after it.

The check splits at newlines, semicolons and the `}` of an `accDescr` block, and refuses a piece
that is `properties` or `details` after any run of whitespace, those six characters, `end` and
`sequenceDiagram`, in any case. Nothing else opens a statement mid-line: `=`, `@` and a `%` before
`{` are actor characters (`=properties` is a parse error); `+ - , :`, `()`, the arrows and numbers
are tokens no statement starts with; and any other `%`, including a `%%` left over from Mermaid's
directive pass, starts a comment to the end of the line. The check also splits where Mermaid does
not end a statement (in a `#` or `%%` comment, an `accTitle` or `accDescr` value or block, or a
participant's `@{ ... }` data), which can only refuse more. Mermaid's entity encoding, which runs
between detection and parsing, only takes `;` and `#` away and adds actor characters (`#amp;`
becomes `ﬂ°amp¶ß`), so it adds no place a statement starts.

**Read as Mermaid will read it.** `preparedSource` strips frontmatter and directives once, and
Mermaid strips each once more before it parses. The check reads that second view exactly, so a
second frontmatter block, or a directive that re-forms once the one inside it is taken out
(`end %%{%%{wrap}%%wrap}%%properties ...`), is read as Mermaid reads it. It does not strip a third
time: what Mermaid's single pass leaves of a directive, its lexer reads as a comment to the end of
the line, and a further pass, whose grammar runs across lines, could remove a statement Mermaid
parses on the next line.

A flowchart, graph, class or state diagram with nodes called `details` or `properties` is drawn,
and so is a sequence diagram that only uses the words: in a message, a participant's name or
alias, a note, a loop label, a title or a comment.

### Links are drawn

`links` and `link` are not refused: they load nothing and read nothing. Mermaid parses
`links A: {"Orders": "https://..."}` as JSON and `link A: Orders @ https://...` as a label and a
URL (`addLinks` and `addALink`, sequence chunk `:1513` and `:1525`) and keeps them on the
participant. Drawing the participant writes them as a hidden menu (`drawPopup`, `:1920`): a
`<g display="none">` of SVG `<a>` entries whose `xlink:href` is the URL after `sanitizeUrl`, with
`target="_blank"`, and an `onclick` string on the participant that would show it (`:2141`). No
`<image>`, no `<use>`, no request and no read of the document. Mermaid's own sanitising of the
finished drawing in strict mode drops the `onclick`, and `withoutNavigation`
(`client/console/artifact-links.ts`) takes every `href` and `target` off the `<a>` entries before
the frame is built, so they lead nowhere. `details` is the one that reads:
`document.getElementById(id).innerHTML` from the app's own document (`:1572`), parsed as JSON and
applied as properties and links. It is refused.

### What Mermaid returns keeps only pictures written into it

`withoutFetchingSvg` now also takes out, before the CSS scan, every `<image>` and `<feImage>`
whose `href` or `xlink:href` is not a `data:image/(png|jpeg|gif|webp);base64,` URL (the same
`DATA_IMAGE` test the picture-shape check uses) or that has no href at all, and every `<use>` whose
href is not a `#fragment` of the drawing (`keepsReference`). An element with both hrefs must pass
on both. It also walks into `<template>` contents, which `querySelectorAll` does not reach and a
frame draws when the template declares a shadow root. A picture written into a flowchart as a
data:image URL stays. The frame's own policy (`img-src data:`) already refused every other
picture, so this is a second wall, as the style scan is.

### Math is drawn only under exactly the app's policy

`carriesPolicy()` counts a `<meta http-equiv="Content-Security-Policy">` only when its content is
exactly `APP_CSP`, the policy the build writes. A weaker or a different policy, the app's with a
directive added, dropped or changed, and the app's as `Content-Security-Policy-Report-Only` do not
count. A second policy beside the app's does not stop it counting: another policy can only narrow
what the page may load.

`APP_CSP_DIRECTIVES` and `APP_CSP` moved, unchanged, to `shared/app-csp.ts`, which imports neither
Node nor Vite, so the Console can read the policy. `scripts/app-csp.ts` re-exports both and still
builds the tag, so `tests/app-csp.test.ts` and the browser spec import them from where they did.

### The file's comment says what the policy does

"The app document's policy means a fetch that got past all of this still goes nowhere" is now: in
the built app the page's own policy lets a fetch that got past all of this reach only the local
service, and nothing it returns is readable by the diagram.

## Tests

Every new test was seen failing: first against the renderer before the change (with only the new
message added, so the browser spec could import it), then against the finished code broken on
purpose, one way at a time, with each file restored byte for byte afterwards. Logs are in the
lane's scratchpad, `scratchpad/mermaid-fetch/logs/`: `red-vitest.log` and `red-pw.log` for the
first, `mut-<name>.log` and `proof-template-pw.log` for the second.

`tests/artifact-frame.test.ts`:

| Test | Seen failing |
| --- | --- |
| Refuses `properties` with an http, a relative `/api/...` and an `@` icon, and with no icon; in upper and mixed case; unindented and tab-indented; after `;`; after comment lines, a directive and blank lines | Before the change: `expected null to be 'This sequence diagram…'`. Broken: detection on the raw text. |
| Refuses `details` | Before the change. |
| Finds a statement started on the same line: after the keyword, `end`, `END` and a tab, each of `/ \ ( ) < >`, and an `accDescr` block | Before the change. Broken: the brief's first-word rule; without `end`; without the keyword; without the six characters; without the `accDescr` split. |
| Reads the prepared text as Mermaid will: a second frontmatter block, and nested directives | Before the change. Broken: the first-word rule; without `end`; without Mermaid's directive pass; detection on the raw text. |
| A sequence diagram only where Mermaid's detector says so | Before the change (no such function). Broken: detector always true; detector ignoring case; detection on the raw text. |
| A flowchart, graph, class or state diagram with nodes called `details` and `properties` is drawn | Broken: detector always true. |
| A sequence diagram that only says the words is drawn | Broken: the word anywhere in a statement. |
| `links` and `link` are drawn | Broken: refusing `links?` too. |
| `keepsReference`: a written GIF kept for `<image>` and `<feImage>`; links, relative paths, `#logo`, SVG and non-base64 data, a trailing space and an empty href not; both hrefs must pass; `<use>` only of `#…` | Before the change (no such function). Broken: keep everything; `<use>` of any href with a `#`; a picture when some href is written in; an element with no href. |
| `carriesPolicy`: the app's policy counts, also beside another; a weaker, a different or a changed one, the report-only one, the development server's head, an empty one, a `<link>` and no head do not | Before the change: `default-src 'self': expected true to be false`. Broken: the app's never counts; report-only counts. |

`tests/mermaid-sequence-check.test.ts` tries the check against Mermaid itself.
`mermaidAPI.getDiagramFromText` does to a text what `render` does before it draws (preprocessing,
detection, entity encoding) and parses it, while the test watches the sequence lexer. Its
grammar has `properties` and `details` only where a statement starts and its parser has no error
recovery, so Mermaid took one exactly when the lexer is asked for another token after handing it
over. The handlers for those statements are replaced for the run, and nothing is drawn. 6000
seeded diagrams are built from frontmatter, comments, directives, the keyword and near misses
(`SequenceDiagram`, `sequencediagram`, `sequenceDiagrams`), statements with and without the words,
and what can come before a statement on its line, including every token listed above and
directives nested three deep. Each must be detected exactly as Mermaid detects it, and refused
wherever Mermaid takes the statement: 987 of them. With the brief's first-word rule, or without any
one part of the check (`end`, the keyword, the six characters, the `accDescr` split, Mermaid's
directive pass, the detector's case), it fails on its own. Sanity checks pin the oracle: a word
after an arrow is lexed but not taken, and a statement after a title or an `accDescr` block is
taken. They were seen failing when any lexed token counted as taken, and without the pass-through
sanitiser below.

Node has no DOM, so DOMPurify cannot sanitise there, and Mermaid's parser throws at the first
title, `accTitle` or `accDescr` it reads, where a browser reads on. Until the test allowed for
this, it never saw a statement taken after one of those, and a check without the `accDescr` split
passed it; only the unit test caught that. The test now gives Mermaid a pass-through sanitiser,
from the same module Mermaid imports, and with it the differential test catches that break too.
Sanitising changes text, not which statement is taken. Nothing else under `tests/` imports Mermaid
or DOMPurify, and vitest isolates test files.

`tests/artifacts-ui.spec.ts`:

| Test | Seen failing |
| --- | --- |
| On the built Console, a sequence diagram whose participant's `properties` icon is a local document read (`ICON`, `ACTOR_PICTURE` in `tests/fixtures/scripted-artifacts.ts`) is refused with the new message, is not drawn, and the page makes no request for the document (`page.on('request')`) | Before the change, on a build of it: the page asked the local service for `/api/projects/…/documents/read?path=Notes.md` while Mermaid laid the diagram out, which is P2-1 itself. |
| On the development server, `withoutFetchingSvg` on hand-written drawings keeps only written pictures, filter pictures and `<use>` of the drawing, including in a shadow root declared in markup | Before the change: every remote, relative and SVG picture, filter picture and `<use>` was kept. Broken: without the template walk, only the shadow-root drawing kept its picture. |

The existing browser tests of a picture written into a flowchart and of a diagram's arrowheads
(`url(#…)`) pass, so what the new scan keeps is still drawn.

## Gates

All in one heavy-slot hold, on the code as committed, with Playwright on ports 5284/47742. Logs in
`scratchpad/mermaid-fetch/logs/`.

| Gate | Result | Log |
| --- | --- | --- |
| `npx tsc --noEmit -p .` | exit 0 | `final-tsc.log` |
| `npx vitest run` | 329 files, 5822 passed, 4 skipped | `final-vitest.log` |
| `npx vite build` | built; `dist/index.html` carries the policy `<meta>` | `final-vite.log` |
| `npx playwright test` | 209 passed (5.2 min) | `final-playwright.log` |

Afterwards `git restore -- evidence/ docs/verification/2026-09-17-design-center/` put the evidence
pictures back. The `field.spec.ts` C07 cascade into `ui.spec.ts` did not occur.

An earlier hold gave the same results (`gate-*.log`) before three comments in
`mermaid-render.ts` were corrected; the gates were run again so that what passed is what is
committed. That hold's template proof stopped before the test ran: the spec refuses a bundle older
than the sources (`expectFreshBundle`), and the broken file was newer than the last build. It was
run again in a hold of its own, with the broken code built first; then the real code was rebuilt
and the two new browser tests passed on it again (`proof-template-*.log`).

## Known gaps

- The check is fitted to Mermaid 11.17.2: its detector, its preprocessing and where its sequence
  grammar starts a statement. `package.json` allows any later 11.x (`^11.17.2`). The differential
  test reads the installed Mermaid (its sequence chunk, its parser's symbols, its lexer,
  `SequenceDB`) and fails loudly if an upgrade moves them; rerunning it is how an upgrade should be
  checked. It cannot catch a new statement, in a sequence diagram or another kind, that fetches or
  reads the page.
- Splitting where Mermaid does not end a statement refuses more than it must: a sequence diagram
  where `properties` or `details` is the first word after a `;` in a comment or an `accTitle` or
  `accDescr` value, or starts a line inside an `accDescr { ... }` block, is refused.
- Mermaid still lays every other diagram out in the app's own document. For a fetch while it does,
  the checks before Mermaid are the only guard in the page; the output scan and the frame's policy
  act afterwards. In the built app the page's policy keeps such a fetch on the local service.
- `preparedSource` strips directives once, as before (the artifact hardening record, section 10);
  this check reads Mermaid's own view of what it is given, so it does not depend on that.
- The desktop shell, which adds the session header, was not run in this lane.
- The browser spec and its fixture file are shared with the other artifacts lanes. This lane adds
  one fixture constant and answer (`ACTOR_PICTURE`, `ICON`) and two tests next to the other diagram
  tests; a merge may need to put them side by side.
