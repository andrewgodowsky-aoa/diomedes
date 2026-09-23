# P2-B: Markdown and Mermaid opened from disk

Work order: P2-B, drawing-content-sniffing. Owner: Codex (integrator seat for
this owner-requested repair; no delegated work).
Branch: `feature/drawing-content-sniffing`.
Worktree: `F:/Diomedes/diomedes-wt/drawing-content-sniffing`.
Base: `1c6242780e15235c5b70c9e1902f4531e29bfcd7` (merged Artifacts v2 drawings).

This addresses the P2-B follow-up in
[the drawings trust record](../product/2026-09-23-artifacts-v2-drawings-trust.md#open-items-not-blocking).
The original checkout and its unrelated changes are preserved.

## Cause and boundary

The proposal content check recognized SVG/HTML/XML by extension. A model could
put HTML in an `.mmd` or `.md`, which a text grant could then write. Plan also
writes model-generated Markdown through `Store.writeRecorded` without a Need.
Firefox can interpret those files as HTML when opened through `file://`.
The app's iframe sandbox and HTTP `nosniff` header do not govern opening a file
from disk. Mozilla's [unknown-content decoder](https://searchfox.org/firefox-main/source/netwerk/streamconv/converters/nsUnknownDecoder.cpp)
checks leading markup before falling back to the file extension.

`rejectMarkupText` refuses model-written `.md`, `.markdown`, and `.mmd` when
the first non-whitespace character is `<`, including a leading BOM. This is a
conservative content boundary, not an HTML sanitizer or a browser tag list.
It refuses even a leading HTML comment or autolink. The error asks for a
Markdown heading/plain text or a Mermaid declaration. No bytes are rewritten.

The proposal check runs on the final redacted text before a Need exists. A
mixed batch is refused as a whole, with the reason retained as fault evidence.
The recorded writer repeats the check for non-human actors, so Plan and other
model writes cannot bypass it. Its existing transaction recovery restores the
plan listing on refusal. A person's editor and Save to Files remain explicit,
byte-for-byte writes. Deletions remain possible.

Ordinary Markdown, fenced HTML examples, and Mermaid diagrams keep their text
authorization. SVG checks, exact review for SVG/HTML/XML, automatic source
selection, drawing previews, and sandbox policies retain their contracts.
This patch does not sanitize existing files or change policies for other code
extensions. P3-3 and P3-4 remain outside this repair.

## Regression evidence

- Before the source change: 28 failures and 33 passes in the two regression
  suites. Failures showed accepted markup, actual grant writes, and a Plan file
  written without review.
- After the change: 206 tests passed across `markup-text`, `drawings-trust`,
  `svg-check`, `artifact-frame`, and `turn-blocks`.
- Native-work and exact approval admission: 111 tests passed, including crash
  recovery and conflicting outside changes. TypeScript passed after linking the
  existing control-plane dependencies into the isolated worktree; no manifest
  or lockfile changes were needed.
- Adversarial cases include script/doctype/comment prefixes, XML with XHTML
  or SVG, BOM/whitespace, long whitespace, and uppercase extensions. Tests also
  cover mixed-batch atomicity, existing file/history preservation, grant and
  exact-review paths, Plan rollback, user writes, and byte-for-byte safe output.
- `drawings-ui.spec.ts` adds a headless Firefox test with an owned profile and
  real `file://` navigation. The raw fixture must execute its harmless title
  marker; the same proposal must be refused, and accepted model-written files
  must open as literal text. The test refuses network requests.
  It requires Playwright's Firefox binary (`npx playwright install firefox`);
  a missing binary is a failure, not a skipped security check.

## Final local gates

All commands exited zero on 2026-09-23. Logs are under this worktree's ignored
`test-results/p2-b/` directory.

| Command | Result | Log |
| --- | --- | --- |
| `tsc --noEmit` | Passed | `types-final.log` |
| `vitest run --maxWorkers=2` | 332 files passed; 5,960 tests passed, 4 skipped, 0 failed | `unit.log` |
| `vite build` | Passed; existing large-chunk warning | `build.log` |
| `playwright test tests/drawings-ui.spec.ts tests/artifacts-ui.spec.ts tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts` | 67 passed, including the real Firefox regression | `browser-final.log` |

The first browser run passed 66 tests and failed to launch Firefox because it
inherited the suite's Edge executable. The new test now explicitly selects
`firefox.executablePath()`; the full combined rerun passed. No application change
was needed for that test setup correction.

The only upstream drift during verification was `50ffc86`, a documentation-only
handoff and AGENTS.md link. It changes none of the tested application or test
files. This record covers the source repair and local verification, not a new
installer, release, or deployment.

## Product impact

Canonical versions read: Pillars `2026-09-22.1`, Roadmap `2026-09-23.1`, Project
Memory `2026-09-23.1`. This tightens model file admission without adding authority,
a permission mode, a document writer, or a preview surface. No roadmap delivery
status, release version, installer, or deployment changes are part of this patch.
