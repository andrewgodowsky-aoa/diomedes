# Approval continuation: changed files

Base: `218f325` plus the 26-file frozen Work foundation snapshot.

Proposed commit: `Add exact approval receipts and journal-linked recovery`. No commit, amend, push or main-checkout merge has been made.

35 files were authored or refreshed in this continuation; 11 additional files remain byte-identical inherited foundation changes. The combined review/commit would contain 46 files relative to `218f325`.

## Code and verification scripts authored in this continuation

- `client/Console.tsx` (extends the inherited foundation change)
- `client/Workspace.tsx` (extends the inherited foundation change)
- `client/approval-decisions.ts`
- `client/components.tsx`
- `scripts/approval-desktop-smoke.mjs`
- `scripts/native-work-smoke.ts` (extends the inherited foundation change)
- `scripts/team-codex-smoke.mjs`
- `server/app.ts` (extends the inherited foundation change)
- `server/approval-admission.ts`
- `server/command-admission.ts`
- `server/native-work.ts` (extends the inherited foundation change)
- `server/store.ts` (extends the inherited foundation change)
- `server/work-admission.ts` (extends the inherited foundation change)
- `shared/types.ts` (extends the inherited foundation change)
- `tests/approval-admission.test.ts`
- `tests/approval-crash-child.ts`
- `tests/approval-decisions-client.test.ts`
- `tests/native-ui.spec.ts` (extends the inherited foundation change)
- `tests/native-work.test.ts`
- `tests/work-admission.test.ts` (extends the inherited foundation change)

## Documentation and evidence authored or refreshed

- `README.md`
- `docs/implementation/2026-09-08-approval-files.md`
- `docs/implementation/2026-09-08-approval-receipts.md`
- `evidence/approval-changes.json`
- `evidence/approval-desktop-proof.json`
- `evidence/approval-performance.json`
- `evidence/approval-verification.json`
- `evidence/desktop-proof.json`
- `evidence/native-runtime-manifest.json`
- `evidence/screenshots/approval-console-record.png`
- `evidence/screenshots/approval-desktop-console.png`
- `evidence/screenshots/approval-desktop-workbook.png`
- `evidence/screenshots/approval-workbook-preview.png`
- `evidence/screenshots/work-admission-console.png`
- `evidence/screenshots/work-admission-workbook.png`

## Inherited foundation files unchanged in this continuation

- `client/work-start.ts`
- `docs/implementation/2026-09-08-work-admission.md`
- `evidence/native-work-proof.json`
- `evidence/screenshots/desktop-tasks-large.png`
- `evidence/screenshots/desktop-tasks.png`
- `evidence/work-admission-performance.json`
- `evidence/work-admission-verification.json`
- `scripts/desktop-smoke.mjs`
- `server/work.ts`
- `tests/work-admission-child.ts`
- `tests/work-start-client.test.ts`

The authored/unchanged distinction is against the frozen foundation file hashes, not merely Git tracked/untracked status. Fable performance work is already in the base commit and is not listed as authored here. The main checkout still has its separate user edit to `scripts/package-desktop.mjs`; neither patch includes it. Historical proof files retain their original timestamps and limitations.

The continuation patch targets the frozen foundation working tree. The combined patch targets `218f325`. Both were checked with `git apply --check` against their intended existing checkouts, without applying them. Binary screenshots are included. Logs, synthetic profiles, packaged binaries and the early archived plan stay in ignored output.
