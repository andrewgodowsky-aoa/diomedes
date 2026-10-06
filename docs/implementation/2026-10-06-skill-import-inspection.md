# Portable SKILL.md inspection

Work item: DIO-244 / NC-TPP.SKILL-INSPECT
Branch: feature/portable-skill-inspection
Base: 9f14078eef3d864f4c2569ac61ce791577cf8b2c
Status: local implementation and scoped independent review passed; integration open.

## Behavior and scope

`inspectSkillDocument` accepts already-supplied text and returns an inspection
report. Supported descriptive fields and the exact Markdown body remain data.
Unknown fields and requested tools are explicit unsupported results, never hidden
authority. The function does not read a path, follow a resource link, install or
activate a pack, run code, choose a workflow mode or grant permissions.

`inspected` means only that the supported syntax and field checks passed.
`unsupported` identifies semantics or syntax that need explicit handling.
`refused` identifies invalid input. Unsupported syntax and invalid input return
no document; a structurally parsed unknown field is retained in the report for
inspection. Directory-name matching, provenance, references, license validity and
runtime compatibility remain unverified.

## Compatibility boundary

Format reference: https://agentskills.io/specification, checked 2026-10-06.
This is deliberately a bounded YAML subset, with no added dependency:

- Top-level one-line plain, single-quoted and JSON-compatible double-quoted strings.
- Required name and description; optional license and compatibility strings.
- Two-space metadata string entries with simple unquoted keys.
- Exact Markdown after the closing delimiter, including mixed LF/CRLF and spaces.
- Unknown fields and experimental allowed-tools retained as unsupported data.

Block/multiline scalars, flow collections, directives, anchors, aliases, tags,
merge keys, nested containers, unsupported escapes and implicit typed values are
unsupported. These limits do not claim complete YAML or ecosystem compatibility.
The inspector allows at most 64 KiB UTF-8 document text and 8 KiB frontmatter.
These are inspection limits, not runtime instruction-delivery budgets.

## Why this slice is separate

The existing skill-playbook-bodies worktree already changes body contracts,
contribution loading, lifecycle and instruction delivery. The Plugins interface
lane also exists. Neither contained this portable-content inspector at the base.
This additive pure helper avoids those live paths. It is not yet called by a
product import flow. Future mapping must supply any required Nectovia workflow
fields explicitly and use the existing pack/Runtime/Trust authorities.

## Verification record

- Initial missing-module RED: 1 failed suite, 0 executed tests.
- Initial implementation GREEN: 57 passed, 0 failed, 0 skipped.
- Initial strict focused TypeScript check: passed.
- Initial formatting check: failed for 2 files; both subsequently formatted.
- Independent Astra review found 3 parsing defects: YAML whitespace preservation,
  implicit metadata-key types, and forbidden literal header characters.
- Regression RED: 13 failed, 58 passed, 0 skipped, 71 total.
- Repaired GREEN: 71 passed, 0 failed, 0 skipped, 0 unrun in the targeted file.
- Final focused strict TypeScript check: exit 0.
- Final Prettier check: passed for both source/test files.
- Final independent Astra review: no remaining actionable findings; 10 inline
  assertions passed, 0 failed, 0 skipped. This count is separate from the suite.

The parent ran `vitest run tests/skill-import.test.ts --maxWorkers=1` through the
existing dependency junction. Focused TypeScript used strict ES2022/NodeNext,
skipLibCheck and the two changed TypeScript files. Formatting used Prettier check.
Source SHA-256: 8e7c00cd5264f6ced3081bc66a32d0c8869bff1bb3bd1c7b34bb661a5d3f1a65.
Test SHA-256: 25cef01070b32763bc5ed83189a6be3925626023a5de0eac1fc11d29be7fcd0f.
The reviewer verified these exact hashes before and after review.

No full application suite, Vite/browser gate, packaged/installed workflow or live
provider test was run. Broad gates are outside this initial content-only slice;
the shared heavy slot was held by other active work. No performance/cache-savings
claim follows from these parser tests. No new dependency or runtime authority was
introduced.

## Product, roadmap and publication

The slice advances governed portable-skill interoperability while retaining the
existing authority owners. Canonical versions remain 2026-10-05.1. P09 and all
broader work-item acceptance remain open; no numbered prompt is marked DONE.

The source documents, Notion Source library entries and detailed Linear map were
published and read back. Existing related issues retain their states, priorities
and assignees. See [the source reconciliation](../product/tools-prompts-plugins/SOURCE_RECONCILIATION.md)
and [work order](../product/tools-prompts-plugins/WORK_ORDER.md).

Andrew authorized this local commit on 2026-10-06. The containing Git commit
identifies this implementation and its evidence. Code remains on the separate
feature branch, unpushed. No merge, deployment, installed-app replacement or
release was performed. The reviewed source and test hashes were rechecked and
matched before committing; the recorded checks were not rerun.

## Changed files

- shared/skill-import.ts
- tests/skill-import.test.ts
- docs/implementation/2026-10-06-skill-import-inspection.md
- docs/product/tools-prompts-plugins/WORK_ORDER.md
- docs/product/tools-prompts-plugins/SOURCE_RECONCILIATION.md
- docs/product/tools-prompts-plugins/PUBLICATION.json
- docs/product/tools-prompts-plugins/VERIFICATION.json

Commit message: `feat: inspect portable SKILL.md compatibility`
