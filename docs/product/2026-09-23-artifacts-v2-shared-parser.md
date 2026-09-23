# Artifacts v2, lane 1: the shared artifact parser

**Decision record.** Version 2026-09-23.0 (opened). Artifacts panel v2 was approved by Andrew on 2026-09-23,
and it targets 0.1.9. This lane goes first. It moves the pure artifact parser into `shared/` so the server
can use it, and adds the indexing and preview helpers that the later lanes build on.

**Status: complete on `feature/artifacts-shared-parser` (worktree
`F:/Diomedes/diomedes-wt/artifacts-shared-parser`, base `8424710`). All four gates pass. Not merged,
not pushed, not released.**

## What moved

- `client/console/turn-blocks.ts` moved to `shared/turn-blocks.ts` byte-for-byte: it took no client
  import (it has none at all), so nothing about it changed. `svgRoot` is still exported from it, for
  lane 3's server-side `.xml`-with-an-svg-root check.
- `client/console/artifacts.ts` moved to `shared/artifacts.ts` with exactly two kinds of change:
  its import of `shared/visual-spec` changed from `'../../shared/visual-spec'` to `'./visual-spec'`
  (now a sibling instead of two levels up), and the `.svg`/`.mmd` branches below. Its only other
  import, `./turn-blocks`, already resolves correctly since both files now live in `shared/` together.
- **Nothing else needed to move or be passed in.** `turn-blocks.ts` imports nothing. `artifacts.ts`
  imports only `./turn-blocks` and `shared/visual-spec` (already shared, already pure). Neither file
  touches React, the DOM, the clock or the network; both keep the doc comments that say so.
- `client/console/turn-blocks.ts` and `client/console/artifacts.ts` are now four-line re-export shims
  (`export * from '../../shared/turn-blocks'` and `.../artifacts`). Every existing import at those two
  paths — `mermaid-render.ts`, `artifact-save.ts`, `artifact-panel.tsx`, `artifact-frames.tsx`,
  `TurnBody.tsx`, `ThreadView.tsx`, `FilesPane.tsx`, `Diomedes.tsx`, `ArtifactPane.tsx`, and the tests
  that exercise them as dependencies (`artifact-frame.test.ts`, `artifact-pane.test.ts`,
  `artifact-save.test.ts`) — keeps working unchanged. No caller was rewritten.

## Drawings in the index

`indexFile` (`shared/artifacts.ts`) gained two branches, in the same shape `fenceKind` gives their
fence: a `.svg` file indexes as one `kind: 'image', lang: 'svg'` artifact, and a `.mmd` file as one
`kind: 'diagram', lang: 'mermaid'` artifact. Both go through the same `wholeFile` + `declarationOf`
path the `.html` branch already used, so a `<!-- artifact: id=... title="..." -->` (svg) or
`%% artifact: id=... title="..."` (mmd) first line is read the same way a fence's declaration is, and
the file name is the fallback title. `fileHasArtifacts`'s extension gate grew to match. No
`DocumentInfo.kind` `'drawing'` was added — that stays lane 3's, through `shared/types.ts`, which this
lane never touched.

## The thread preview

New `shared/thread-preview.ts`, over the shared parser, with a pure `previewLine(text, max)`. It scans
the whole turn for the first block of each kind, in order — not just the first block positionally —
so a diagram that opens a turn never beats a real opening line that follows it:

1. the first heading or non-empty paragraph, as plain words (bold markers gone, a link's own text
   untouched — the parser never interprets link syntax, so there was nothing further to strip);
2. otherwise the first artifact fence or table, as `"<Kind>: <declared title>"` or the bare kind when
   nothing is declared;
3. otherwise the first ```` ```visual ```` block, by its own `title` field or the generic `"Chart"`;
4. otherwise the first fence of any other kind, as `"Code"`;
5. otherwise `''`.

The line is whitespace-collapsed and cut at `max` characters, the last one an ellipsis when it is cut.
`Shell.tsx:1446`'s own raw slice was not touched — that one-line patch is lane 4's.

**For lane 4:** a turn that is only a list (no heading, paragraph, artifact, visual or code fence)
previews as `''` under these rules; the Shell fallback should cover that the same way it already
covers no text at all.

## Tests

- `tests/turn-blocks.test.ts` and `tests/artifacts.test.ts` now import from `../shared/turn-blocks`
  and `../shared/artifacts` (they target those modules directly, so their import paths changed; every
  assertion is unchanged). Both suites pass exactly as before the move.
- `tests/artifacts.test.ts` gained one new case, `.svg`/`.mmd` in `indexFile`/`fileHasArtifacts`,
  covering the undeclared and declared-id/title shape for both extensions, plus the extension gate.
  **Seen fail:** run alone against the pre-move code, 25 passed / 1 failed — `expected [] to deeply
  equal [['image','svg','Logo']]`, since `.svg`/`.mmd` fell through to the file-as-a-turn branch and
  parsed as a plain paragraph with no artifact in it.
- New `tests/thread-preview.test.ts` (8 cases): the diagram-with-declared-title case E3 names, a
  fence-then-paragraph case (the paragraph must win — this is what rules out a "read only block 0"
  implementation), plain-word bold/link handling, an empty-heading skip, the visual title-or-"Chart"
  rule, the "Code" fallback, the ellipsis cut, and an empty turn. **Seen fail:** before the move,
  `shared/thread-preview.ts` did not exist, so every case failed on module resolution. After the move,
  strengthened with a break-and-restore: with `artifactLine` temporarily returning the raw fence
  source instead of `"<Kind>: <title>"`, the diagram case failed exactly as expected (`expected
  '%% artifact: id=delivery-flow title="…' to be 'Diagram: Delivery check'`), then the fix was
  restored and reverified green.
- New `tests/shared-parser-move.test.ts` (3 cases): the client shims re-export the exact same function
  objects as `shared/`, checked by name (`Object.keys` match) and by reference (`toBe`) for every
  export of both modules, plus one behavioural check that `indexArtifacts` reads the same list through
  either path. **Seen fail:** before the move, both `shared/` imports failed to resolve. Strengthened
  with a break-and-restore: with the `client/console/artifacts.ts` shim temporarily given a local
  `declarationOf` that shadowed the star-export (a real ES-module shim break, not just a missing
  file), the identity test failed and named the exact export that drifted
  (`declarationOf: expected [Function] to be [Function]`), then the shim was restored and reverified
  green.
- Existing tests that depend on the parser only as a caller (`artifact-frame.test.ts`,
  `artifact-pane.test.ts`, `artifact-save.test.ts`, and every client component that imports the old
  paths) pass unchanged, which is itself evidence the shims are transparent.

## Gates (heavy slot, worktree `F:/Diomedes/diomedes-wt/artifacts-shared-parser`)

A first attempt raced its own `vite build` step against edits still in flight (a `prettier --write`
run that over-reformatted two tracked test files was caught and reverted; see below), and 9 Playwright
specs correctly refused a stale `dist/` against the just-edited `shared/thread-preview.ts`. That run
was discarded rather than reported. The rerun below touched no file while it ran.

1. `npx tsc --noEmit -p .`: **exit 0.**
   Log: `.../scratchpad/v2-lane1/tsc.log`
2. `npx vitest run`: **323 test files passed (323), 5766 tests passed, 4 skipped (5770 total).** No
   failure occurred, so no isolated re-run was needed.
   Log: `.../scratchpad/v2-lane1/vitest.log`
3. `npx vite build`: **exit 0**, built in 7.04s.
   Log: `.../scratchpad/v2-lane1/vite-build.log`
4. `npx playwright test` (`DIOMEDES_UI_CLIENT_PORT=5234`, `DIOMEDES_UI_SERVICE_PORT=47692`):
   **199 passed, 0 failed, in 5.0 minutes.** No C07/F01-F02 race occurred, so no paired re-run was
   needed. `git restore -- evidence/ docs/verification/2026-09-17-design-center/` ran after
   (exit 0) and left the working tree clean of the run's own screenshot rewrites.
   Log: `.../scratchpad/v2-lane1/playwright.log`

Scratchpad root for all four logs and the summary:
`F:/Temp/andre/claude/F--Diomedes/93688541-df31-40fc-b4a9-a50c06acda85/scratchpad/v2-lane1/`.

## A caution for whoever runs `prettier --write` here next

The tracked files in this lane (and, it appears, more broadly) are not currently prettier-clean under
the repo's own `.prettierrc.json`: running `prettier --write` on already-tracked files reformats large
unrelated spans of them, not just new code. Format new code by hand to the same style instead of
running prettier across a file that has other people's unrelated lines in it.

## For lane 3

`svgRoot(source): 'svg' | 'other' | 'unknown'` is unchanged and still exported from
`shared/turn-blocks.ts` (also reachable, identically, through the `client/console/turn-blocks.ts`
shim). Nothing about its behaviour changed in this lane.

## For lane 4

- `previewLine(text: string, max: number): string` is in `shared/thread-preview.ts`. The one-line
  `Shell.tsx:1446` patch (replacing the raw `lastTurn.slice(0, 60)`) and the fallback for a turn that
  previews as `''` are both still open, and are yours.
- The moved `shared/artifacts.ts` and `shared/turn-blocks.ts` are otherwise identical to what shipped
  before this lane; nothing in their public surface changed except the two new `indexFile` branches.
