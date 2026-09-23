# Artifact hardening: what the hostile review found, and what changed

**Decision record.** Version 2026-09-23.1. Written by the HARDEN lane from the artifact hardening
brief, which restates the findings of an independent hostile review of the Nectovia program (app
`1da6917..2220134`). The review's full report is the integrator's working copy and is not in this
repository.

**Status: built in `feature/artifact-hardening` (worktree
`F:/Diomedes/diomedes-wt/artifact-hardening`, base `fb00419`). It is uncommitted, not merged and
not released.** It supersedes the parts of `docs/product/2026-09-22-model-artifacts.md` section 4
that it names below.

---

## 1. H1 (P0): designs run no script

**What the reviewer verified.** A design frame (`sandbox="allow-scripts"`, with `DESIGN_CSP` and
its `script-src 'unsafe-inline'`) created an `RTCPeerConnection`. STUN binding requests left the
machine, to 127.0.0.1 and to the LAN address, while fetch, images, WebSocket, beacons, popups and
top navigation were all refused. A Content-Security-Policy does not govern ICE, and nothing in
`desktop/main.mjs` limited WebRTC. Deleting `RTCPeerConnection` inside the frame would not hold,
because a child `about:blank` frame hands it back.

**What changed.**

- Every artifact frame is `sandbox=""`: `FRAME_SANDBOX.design` is `''`, like a diagram's and an
  image's. No script runs in any frame: no inline `<script>`, no `on…` handler, no `javascript:`
  URL, so no peer connection can be made.
- There is one frame policy for every kind, `FRAME_CSP`, and it names no script source:
  `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:`.
  `blob:` is gone from it too, because only a script could make a `blob:` URL. `DESIGN_CSP`,
  `STATIC_CSP` and `cspFor` are gone. The `design` kind stays, because the panel labels and sizes
  a design differently (widths, scaling).
- The comments in `artifact-frame.ts` and `artifact-frames.tsx` say what is true now. The panel
  had no copy saying a design runs its own script.
- Defence in depth: the desktop window calls
  `win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`. The app uses no WebRTC
  anywhere (no `RTCPeerConnection`, `getUserMedia` or `mediaDevices` outside the tests). Under this
  policy WebRTC may use UDP only through a proxy, so it sends no STUN request and exposes no
  address; it may still use TCP. It narrows WebRTC, and the sandbox is what stops a frame.

**Decision: interactive designs are deferred to v2**, until a design can be isolated from the
network at the process or operating-system level. A frame that runs script can reach the network
by a route no policy in the page governs (ICE), and removing the API from inside the frame is not
robust. v2 needs a boundary outside the renderer: for example a separate process with no network
access, or an operating-system firewall rule for the process that draws designs.

## 2. H2 (P1): a link in a design goes nowhere

With no script, a frame can still follow a link: a click on `<a href="http://host/?secret">`
navigates the frame, and the request, query and all, leaves. The desktop shell refuses that
navigation (`will-frame-navigate`), but the Console also runs in a browser (`Start-Diomedes.ps1`,
and every Playwright spec).

`client/console/artifact-links.ts` (new) reads a design's or a picture's source with `DOMParser`
before its srcdoc is built. That document runs nothing and loads nothing. It takes out:

- `href` and `xlink:href` on `<a>` and `<area>`, in HTML and SVG (the link's text stays);
- `action`, `formaction`, `ping` and `target`, on any element;
- `<base>`, and `<meta http-equiv="refresh">`;
- beyond the brief: SVG `<set>` and `<animate>` that would write one of those attributes back,
  and all of the above inside every `<template>`, because a template with `shadowrootmode`
  becomes a live shadow root when the frame parses it.

The result is read again until a reading changes nothing (at most four more readings), so markup
that parses into something new the second time cannot bring a link back. Markup that never
settles is not shown, and nor is anything when no `DOMParser` exists: the panel shows "This
design was not shown." (or diagram, or image) with the source as written. It fails closed.

## 3. H3 (P1): the Mermaid style guard

- Statements are split on `;` as well as on newlines before the style check, so
  `graph TD; A-->B; classDef foo background-image:url(...)` is refused like its multi-line form.
- What Mermaid returns is scanned before it is used. In every attribute that holds CSS (`style`,
  `fill`, `stroke`, `marker`, `marker-start`, `marker-mid`, `marker-end`, `clip-path`, `mask`,
  `filter`, `cursor`) and in every `<style>` element, a small CSS tokenizer (names, escapes,
  strings, comments, url tokens) turns every fetching function into `none`: `url()` unless it
  names a same-document `#fragment` (Mermaid's markers), and `image()`, `image-set()`,
  `-webkit-image-set()`, `cross-fade()`, `-webkit-cross-fade()`, `element()`, `-moz-element()`
  and `src()`. `@import` is dropped.

## 4. H4 (P1): a Content-Security-Policy on the app document

The built `index.html` carries the app's policy as the first element of its `<head>`, written by a
Vite plugin at build only (`scripts/app-csp.ts`, `vite.config.ts`). The development server is
unchanged.

The policy (each directive's reason is in `APP_CSP_DIRECTIVES`):

| Directive | Sources | Why |
| --- | --- | --- |
| `default-src` | `'self'` | Anything not named below comes only from the local service. |
| `script-src` | `'self'` | The bundle and its lazily loaded chunks (Mermaid is one). No inline script, no eval. |
| `style-src` | `'self' 'unsafe-inline'` | The bundle's stylesheets, and the `<style>` element and style attributes in the SVG Mermaid lays out in the document. |
| `img-src` | `'self' data:` | Bundled art and theme pictures from the local service; the Nectovia status glyph is a `data:` SVG mask; an artifact frame carries its images as `data:` URLs. |
| `font-src` | `'self' data:` | The bundled fonts, served with the bundle; `data:` because a design may carry its own font that way. |
| `connect-src` | `'self'` | `fetch` to `/api` and the `/api/events` stream. |
| `media-src` | `data:` | The app plays no audio or video itself; a design may carry its own as a `data:` URL. |
| `worker-src` | `'none'` | The app starts no workers. |
| `frame-src` | `'none'` | Artifact frames are srcdoc documents, which `frame-src` does not govern; every navigation of a frame away from its srcdoc is refused. |
| `object-src` | `'none'` | No plugins. |
| `base-uri` | `'none'` | Nothing may re-point the document's relative URLs. |
| `form-action` | `'self'` | The Console's forms are handled in script. |

**Artifact frames inherit it.** A srcdoc document takes its parent's policy with it and adds its
own, so what a frame may load is what both allow. The `data:` sources in `font-src` and
`media-src` are there for that reason alone (`img-src` also needs `data:` for the app's own glyph):
every source `FRAME_CSP` allows is allowed here too
(`tests/app-csp.test.ts` checks it), so a design keeps its embedded pictures, fonts and media. A
`data:` URL reaches no network. The inheritance is also a second wall: under this policy a frame
cannot run inline script even if its own sandbox and policy allowed it (section 8).

It is tighter than the brief's starting policy, which allowed `blob:` images, media, workers and
frames, `'self'` media and workers, and `data:` frames. What the app was checked for:

- workers, `eval`, `new Function`: none in the client source, and none in the built bundle
  (`dist/assets/*.js`: no `new Worker`, `SharedWorker`, `importScripts`, `eval(`, `new Function`,
  `WebSocket(` or `RTCPeerConnection`). Mermaid's, Cytoscape's and a diagram chunk's copies of
  lodash hold `Function("return this")()`, but only after `self` has already been found, so it is
  never called in a browser;
- `blob:` URLs: two, both theme-file downloads through `<a download>`, which no directive governs;
- EventSource and WebSocket: three `EventSource('/api/events')`, same origin; no WebSocket;
- Design Center textures and pictures: `/api/themes/<id>/assets/<hash>`, same origin;
- file previews: the Files pane previews text and Markdown only (no images, PDF, video or
  frames); anything else is "open in the app that owns it";
- external links: none opened by the document;
- fonts: 34 font files, emitted as files and served with the bundle; no stylesheet carries a
  `data:` font. The one `data:` URL in the stylesheets is the Nectovia status glyph (an SVG mask).

The policy `<meta>` is the first element of the built `<head>`; the `<meta charset>` after it
still sits at byte 495, inside the 1024 bytes a browser reads for it (and the local service sends
`charset=UTF-8` anyway).

**What the policy tripped, found by the no-violation assertion, and what changed for it:**

- **Zod's eval probe.** The first time Zod 4 builds an object schema it tries `new Function('')`
  to see whether it may compile parsers. The policy refuses it and reports
  `script-src refused eval` (from the chunk the app and the stock-receipt page share), although
  Zod catches the refusal and parses without eval. `client/zod-config.ts` turns on Zod's
  `jitless` mode, which skips the probe; both entries (`client/main.tsx`,
  `client/inventory/main.tsx`) import it first, so it runs before any schema is built. Parsing is
  unchanged: under the policy Zod could not compile anyway.
- **A design's `<base>`.** Taking a design's links out means reading its markup in the Console's
  own document with `DOMParser`, which runs and loads nothing, but a `<base>` in that markup is
  still checked against the document's policy: `base-uri 'none'` refuses it and reports it
  (Chromium reports it twice, once without an address). That is the policy refusing the model's
  markup, not the Console breaking it, so it stays; the link test expects exactly those reports
  and fails on any other.

**Where the policy is exercised.** The brief expected the whole browser suite to run on the
built bundle. Twenty of its 25 specs do (each serves `dist/` itself); `ui`, `field`,
`design-studio-ui`, `change-review-ui` and `nectovia-skin` run on the Vite development server,
which has no policy. The Design Center is therefore exercised under the policy only by the
surfaces test in `tests/artifacts-ui.spec.ts`.

**Two things a `<meta>` policy cannot do.** It cannot carry `frame-ancestors` (nor `report-uri`,
`report-to` or `sandbox`); browsers ignore those there. Keeping the Console out of another page's
frame needs a response header from the local service. And a srcdoc frame inherits the document's
policy, so every artifact frame is now under both its own policy and the app's.

## 5. H5 (P2): the segment bar in every scheme

The integrator decided the segment bar is a product feature in every scheme, styled by each
scheme's tokens. `tests/nectovia-skin.spec.ts` now says what Field shows on the Projects register:
the bar is there with its counts, a finished task is lit in Field's lead (`#3fd6df`, not Nectovia's
`#44d2c9`), the Nectovia tokens (`--seam-lead`, `--plate`) are undefined, and there is no plate,
brief, art or bust. The bar's CSS is unchanged.

## 6. H6 (P3): `Mark.tsx`

The added comment line is gone; `git diff 1da6917 -- client/console/Mark.tsx` is empty.

## 7. H7 (P3): amber means a person is needed

`stepState` (`client/console/progress-bars.ts`) gives the needs-you colour only to the Review
column, which holds every state that waits on a person: an open Need, changes to review, and a
task record to review. A Board `Blocked` task is `pending` (the engine is waiting, no run is
recorded, or the run was stopped), except a failed run, which stays `failed`. The unit test reads
every `Blocked` reason from `client/console/task-evidence.ts` and fails if one is added without a
case.

## 8. Tests, and proof that they can fail

`tests/artifacts-ui.spec.ts` gained three observers besides its recording proxy: a UDP socket on
127.0.0.1 that records any STUN request, a `/leak` path on the spec's server that records any
request, and a listener that reports every policy violation in the Console's own document. The
control test shows each observer seeing what an unprotected frame does (fetches, a STUN request, a
navigation to `/leak`, a violation). The H1, H2 and wander tests run first with the app policy
taken out of the served document (as on the development server), so the frame's own sandbox,
policy and markup are tested with nothing behind them, then with the policy in force.

Each proof broke the code on purpose, rebuilt, ran the tests, and copied the file back; all five
files were then byte-identical to before (`fc /b`). Logs are in the lane's scratchpad,
`scratchpad/harden/logs/`.

| Broken | What failed |
| --- | --- |
| H1: `design: 'allow-scripts'` and `script-src 'unsafe-inline'` in `FRAME_CSP` | Vitest 2 of 20 (`proof-h1-vitest.log`). Browser (`proof-h1-pw.log`): the hostile design left `ran`, `onload`, `img`, `pixel`, `rtc` and six way-out marks, and sent six STUN requests to the listener; the wander design moved its frame and was taken down. |
| H1: `allow-scripts` alone | Only the sandbox attribute check (`proof-h1-sandbox-only-pw.log`): the frame's own policy still refused every script. |
| H2: links left as written | Both tests (`proof-h2-pw.log`): eleven ways out listed in the markup, the clicked frame left `about:srcdoc` and was taken down, and with the policy in force `frame-src` refused `…/leak?secret=from-design` and reported it. |
| H3: split on newlines only | Vitest 1 of 20 (`proof-h3-split.log`). |
| H3: every `url()` kept | Vitest 3 of 20 (`proof-h3-scan.log`). |
| H4: no `'unsafe-inline'` in `style-src` | The surfaces test: dozens of `style-src-attr`/`style-src-elem` reports from the app and Mermaid (`proof-h4-style-pw.log`). |
| H4: no build plugin | Vitest 1 of 6 (`proof-h4-plugin-vitest.log`); the surfaces test found no policy `<meta>` (`proof-h4-plugin-pw.log`). |

Three things the proofs showed that a reader should know:

- The inherited app policy is a second wall. With the design's sandbox and policy both broken, the
  policy phase of the hostile design test still saw nothing run: the app policy refuses inline
  script in the frame by itself.
- The `js` mark (a nested frame's `javascript:` URL) never flipped, even with scripts allowed: the
  nested frame's opaque origin cannot reach its parent's document. The mark stays in the test,
  but the inline script and handler marks are what prove script ran.
- Under the broken H2 build, in the phase without a policy, the clicked frame loaded a second
  time (it left `about:srcdoc` and the panel took it down), yet `/leak` recorded neither the
  click's request nor its ping. Why is not explained; it was not investigated. So the server
  observer is shown to work only in the control (a script-driven navigation), not for a link
  clicked inside a design: the test's demonstrated checks for H2 are the markup scan (eleven ways
  out), the frame leaving `about:srcdoc`, the take-down, and the policy's `frame-src` report. Its
  "no request reached the server" check stands, but its sensitivity on this path is unproven.

H5 and H7 were not required to be proved; H7's new tests failed three times on the old
`stepState` before the change.

## 9. Gates

All in one heavy-slot hold, on the real code after the proofs, with Playwright on ports
5214/47672. Logs in `scratchpad/harden/logs/`.

| Gate | Result | Log |
| --- | --- | --- |
| `npx tsc --noEmit -p .` | exit 0 | `gate-tsc.log` |
| `npx vitest run` | 285 files, 5247 passed, 4 skipped | `gate-vitest.log` |
| `npx vite build` | built; `dist/index.html` carries the policy `<meta>` | `gate-vite.log` |
| `npx playwright test` | 196 passed (5.7 min) | `gate-playwright.log` |

Afterwards `git restore -- evidence/ docs/verification/2026-09-17-design-center/` put the
evidence pictures back.

## 10. Open

- `frame-ancestors` needs a response header from the local service (section 4).
- `inventory.html` is built without the policy: the brief names `index.html` only. Its entry
  imports the Zod setting too, so adding the policy there later needs no other change.
- Five browser specs run on the development server, which has no policy (section 4).
- The Mermaid SVG scan's removal path is unit-tested on the CSS reader; in the browser only its
  keep path is seen (diagram arrowheads survive), because no diagram can reach it past the
  refusal. Vitest here has no DOM, so the DOM half is not unit-tested.
- The desktop shell was not run in this lane. It is the first time the document Electron loads
  carries a policy; the brief's gates do not include the desktop smoke.
- Mermaid directives can still be reassembled around the prepared-source strip in ways that pass
  non-secure keys (for example a look or theme key); nothing found reaches the network, but it is
  outside this brief and worth a separate look.
